use super::*;
use std::time::Duration;

#[test]
fn hls_asset_chunks_carry_stable_request_coordinates() {
    let packet = encode_hls_asset_chunk(0x0102_0304, 7, b"media");
    assert_eq!(&packet[..4], HLS_ASSET_CHUNK_MAGIC);
    assert_eq!(&packet[4..8], &[1, 2, 3, 4]);
    assert_eq!(&packet[8..12], &[0, 0, 0, 7]);
    assert_eq!(&packet[12..], b"media");
}

#[tokio::test]
async fn negotiated_data_channel_delivers_hls_asset_coordinates() -> Result<()> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let (host, mut events) = RemoteP2pTransport::new();
    let (relay_tx, mut relay_rx) = unbounded_channel();
    host.set_relay_events(relay_tx);

    let browser = Arc::new(
        APIBuilder::new()
            .build()
            .new_peer_connection(RTCConfiguration::default())
            .await?,
    );
    let data = browser
        .create_data_channel(HLS_DATA_CHANNEL_LABEL, None)
        .await?;
    let (opened_tx, mut opened_rx) = unbounded_channel();
    data.on_open(Box::new(move || {
        let opened_tx = opened_tx.clone();
        Box::pin(async move {
            let _ = opened_tx.send(());
        })
    }));
    let (candidate_tx, mut candidate_rx) = unbounded_channel();
    browser.on_ice_candidate(Box::new(move |candidate| {
        let candidate_tx = candidate_tx.clone();
        Box::pin(async move {
            if let Some(candidate) = candidate.and_then(|candidate| candidate.to_json().ok()) {
                let _ = candidate_tx.send(candidate);
            }
        })
    }));

    let offer = browser.create_offer(None).await?;
    browser.set_local_description(offer.clone()).await?;
    host.handle_signal(
        "integration-client",
        RemoteP2pSignal::Offer { sdp: offer.sdp },
    )
    .await?;

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            tokio::select! {
                opened = opened_rx.recv() => {
                    if opened.is_some() {
                        break Ok::<(), anyhow::Error>(());
                    }
                }
                candidate = candidate_rx.recv() => {
                    if let Some(candidate) = candidate {
                        host.handle_signal(
                            "integration-client",
                            RemoteP2pSignal::Candidate { candidate },
                        ).await?;
                    }
                }
                frame = relay_rx.recv() => {
                    let Some(frame) = frame else {
                        return Err(anyhow!("host relay channel closed"));
                    };
                    let value: serde_json::Value = serde_json::from_str(&frame)?;
                    let signal: RemoteP2pSignal = serde_json::from_value(value["signal"].clone())?;
                    match signal {
                        RemoteP2pSignal::Answer { sdp } => {
                            browser
                                .set_remote_description(RTCSessionDescription::answer(sdp)?)
                                .await?;
                        }
                        RemoteP2pSignal::Candidate { candidate } => {
                            browser.add_ice_candidate(candidate).await?;
                        }
                        _ => {}
                    }
                }
            }
        }
    })
    .await
    .map_err(|_| anyhow!("P2P HLS data channel negotiation timed out"))??;

    data.send_text(
        serde_json::json!({
            "type": "hls_asset_request",
            "id": 17,
            "url": "p2p-hls://session/4/index.m3u8"
        })
        .to_string(),
    )
    .await?;
    let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .map_err(|_| anyhow!("HLS asset request was not delivered"))?
        .ok_or_else(|| anyhow!("P2P transport event channel closed"))?;
    let RemoteP2pTransportEvent::HlsAssetRequested {
        client_id,
        request_id,
        url,
        ..
    } = event;
    assert_eq!(client_id, "integration-client");
    assert_eq!(request_id, 17);
    assert_eq!(url, "p2p-hls://session/4/index.m3u8");

    browser.close().await?;
    host.close_all().await;
    Ok(())
}
