use super::*;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;

#[test]
fn realtime_queue_stays_bounded_and_keeps_the_newest_packets() {
    let mut queue = VecDeque::new();
    for value in 0..=PLAYOUT_QUEUE_CAPACITY {
        push_realtime_packet(&mut queue, Bytes::from(vec![value as u8]));
    }
    assert_eq!(queue.len(), PLAYOUT_QUEUE_CAPACITY);
    assert_eq!(queue.front().map(|payload| payload[0]), Some(1));
    assert_eq!(
        queue.back().map(|payload| payload[0]),
        Some(PLAYOUT_QUEUE_CAPACITY as u8)
    );
}

#[test]
fn ffmpeg_ranges_are_formatted_without_integer_truncation() {
    assert_eq!(format_seconds(0), "0.000");
    assert_eq!(format_seconds(1_234), "1.234");
}

#[tokio::test]
async fn negotiated_peer_receives_silence_on_the_persistent_audio_track() -> Result<()> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let (host, _events) = RemoteWebRtcAudio::new();
    let (relay_tx, mut relay_rx) = unbounded_channel();
    host.set_relay_events(relay_tx);

    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs()?;
    let registry = register_default_interceptors(Registry::new(), &mut media_engine)?;
    let api = APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build();
    let browser = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);
    browser
        .add_transceiver_from_kind(
            RTPCodecType::Audio,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Recvonly,
                send_encodings: Vec::new(),
            }),
        )
        .await?;
    let (track_tx, mut track_rx) = unbounded_channel();
    browser.on_track(Box::new(move |track, _, _| {
        let _ = track_tx.send(track);
        Box::pin(async {})
    }));
    let (browser_candidate_tx, mut browser_candidate_rx) = unbounded_channel();
    browser.on_ice_candidate(Box::new(move |candidate| {
        let browser_candidate_tx = browser_candidate_tx.clone();
        Box::pin(async move {
            if let Some(candidate) = candidate.and_then(|candidate| candidate.to_json().ok()) {
                let _ = browser_candidate_tx.send(candidate);
            }
        })
    }));

    let offer = browser.create_offer(None).await?;
    browser.set_local_description(offer).await?;
    let offer = browser
        .local_description()
        .await
        .ok_or_else(|| anyhow!("browser offer is missing"))?;
    tokio::time::timeout(
        Duration::from_secs(5),
        host.create_peer("integration-client"),
    )
    .await
    .map_err(|_| anyhow!("host peer creation timed out"))??;
    tokio::time::timeout(
        Duration::from_secs(5),
        host.handle_signal(
            "integration-client",
            RemoteP2pSignal::Offer { sdp: offer.sdp },
        ),
    )
    .await
    .map_err(|_| anyhow!("host offer handling timed out"))??;
    let candidate_host = Arc::clone(&host);
    let browser_candidate_task = tokio::spawn(async move {
        while let Some(candidate) = browser_candidate_rx.recv().await {
            let _ = candidate_host
                .handle_signal(
                    "integration-client",
                    RemoteP2pSignal::Candidate { candidate },
                )
                .await;
        }
    });

    let mut pending_candidates = Vec::new();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), relay_rx.recv())
            .await
            .map_err(|_| anyhow!("host answer signaling timed out"))?
            .ok_or_else(|| anyhow!("host signaling channel closed"))?;
        let value: serde_json::Value = serde_json::from_str(&frame)?;
        let signal: RemoteP2pSignal = serde_json::from_value(value["signal"].clone())?;
        match signal {
            RemoteP2pSignal::Answer { sdp } => {
                browser
                    .set_remote_description(RTCSessionDescription::answer(sdp)?)
                    .await?;
                for candidate in pending_candidates.drain(..) {
                    browser.add_ice_candidate(candidate).await?;
                }
                break;
            }
            RemoteP2pSignal::Candidate { candidate } => pending_candidates.push(candidate),
            _ => {}
        }
    }

    let signal_browser = Arc::clone(&browser);
    let candidate_task = tokio::spawn(async move {
        while let Some(frame) = relay_rx.recv().await {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&frame) else {
                continue;
            };
            let Ok(RemoteP2pSignal::Candidate { candidate }) =
                serde_json::from_value(value["signal"].clone())
            else {
                continue;
            };
            let _ = signal_browser.add_ice_candidate(candidate).await;
        }
    });
    let remote_track = tokio::time::timeout(Duration::from_secs(10), track_rx.recv())
        .await
        .map_err(|_| anyhow!("browser track event timed out"))?
        .ok_or_else(|| anyhow!("browser did not receive the audio track"))?;
    let (packet, _) = tokio::time::timeout(Duration::from_secs(5), remote_track.read_rtp())
        .await
        .map_err(|_| anyhow!("browser RTP read timed out"))??;
    assert_eq!(packet.payload.as_ref(), OPUS_SILENCE_PAYLOAD);

    candidate_task.abort();
    browser_candidate_task.abort();
    tokio::time::timeout(Duration::from_secs(5), browser.close())
        .await
        .map_err(|_| anyhow!("browser close timed out"))??;
    tokio::time::timeout(Duration::from_secs(5), host.close_all())
        .await
        .map_err(|_| anyhow!("host close timed out"))?;
    Ok(())
}
