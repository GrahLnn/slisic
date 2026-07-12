use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};

#[test]
fn hls_timeline_update_frame_preserves_revisioned_metadata() {
    let frame = encode_hls_timeline_update(&serde_json::json!({
        "epoch": 7,
        "revision": 3,
        "entries": [{ "id": "next", "track": { "title": "Second" } }]
    }))
    .expect("timeline frame");
    let decoded: serde_json::Value = serde_json::from_str(&frame).expect("valid timeline JSON");

    assert_eq!(decoded["type"], "hls_timeline_updated");
    assert_eq!(decoded["hls"]["revision"], 3);
    assert_eq!(decoded["hls"]["entries"][0]["track"]["title"], "Second");
}
use std::time::Duration;

#[test]
fn hls_asset_chunks_carry_stable_request_coordinates() {
    assert_eq!(HLS_ASSET_CHUNK_SIZE, 16 * 1024 - 12);
    assert_eq!(
        HLS_ASSET_CHUNK_SIZE + HLS_ASSET_CHUNK_HEADER_SIZE,
        HLS_ASSET_MAX_MESSAGE_SIZE
    );
    let packet = encode_hls_asset_chunk(0x0102_0304, 7, b"media");
    assert_eq!(&packet[..4], HLS_ASSET_CHUNK_MAGIC);
    assert_eq!(&packet[4..8], &[1, 2, 3, 4]);
    assert_eq!(&packet[8..12], &[0, 0, 0, 7]);
    assert_eq!(&packet[12..], b"media");
}

#[test]
fn hls_asset_chunk_frame_fits_the_data_channel_message_limit() {
    let packet = encode_hls_asset_chunk(1, 0, &vec![0; HLS_ASSET_CHUNK_SIZE]);
    assert_eq!(packet.len(), HLS_ASSET_MAX_MESSAGE_SIZE);
}

#[test]
fn empty_asset_opening_contains_only_its_header_and_releases_the_request() {
    let mut scheduler = RemoteP2pOutboundScheduler::default();
    scheduler.push(RemoteP2pOutboundResponse::Register { request_id: 3 });
    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 3,
        content_type: "application/vnd.apple.mpegurl".to_owned(),
        body: Bytes::new(),
        priority: RemoteP2pAssetPriority::Foreground,
    });

    assert!(matches!(
        scheduler.next_transmission().as_deref(),
        Some([RemoteP2pOutboundFrame::Text(header)]) if header.contains("\"chunks\":0")
    ));
    assert!(!scheduler.requested.contains(&3));
    assert!(scheduler.next_transmission().is_none());
}

#[test]
fn cancellation_discards_queued_frames_and_late_asset_completion() {
    let mut scheduler = RemoteP2pOutboundScheduler::default();
    scheduler.push(RemoteP2pOutboundResponse::Register { request_id: 9 });
    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 9,
        content_type: "video/mp2t".to_owned(),
        body: Bytes::from(vec![9; HLS_ASSET_CHUNK_SIZE + 1]),
        priority: RemoteP2pAssetPriority::Reserve,
    });
    scheduler.push(RemoteP2pOutboundResponse::CancelThrough { request_id: 9 });
    assert!(scheduler.next_transmission().is_none());

    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 9,
        content_type: "video/mp2t".to_owned(),
        body: Bytes::from_static(b"late"),
        priority: RemoteP2pAssetPriority::Reserve,
    });
    assert!(scheduler.next_transmission().is_none());

    scheduler.push(RemoteP2pOutboundResponse::CancelThrough { request_id: 10 });
    scheduler.push(RemoteP2pOutboundResponse::Register { request_id: 10 });
    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 10,
        content_type: "video/mp2t".to_owned(),
        body: Bytes::from_static(b"reordered-late"),
        priority: RemoteP2pAssetPriority::Reserve,
    });
    assert!(scheduler.next_transmission().is_none());
}

#[test]
fn asset_opening_is_atomic_before_foreground_overtakes_remaining_reserve_chunks() {
    let mut scheduler = RemoteP2pOutboundScheduler::default();
    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 1,
        content_type: "video/mp2t".to_owned(),
        body: Bytes::from(vec![1; HLS_ASSET_CHUNK_SIZE + 1]),
        priority: RemoteP2pAssetPriority::Reserve,
    });
    let reserve_opening = scheduler.next_transmission().expect("reserve opening");
    assert!(matches!(
        reserve_opening.as_slice(),
        [RemoteP2pOutboundFrame::Text(header), RemoteP2pOutboundFrame::Binary(chunk)]
            if header.contains("\"id\":1")
                && &chunk[4..8] == 1_u32.to_be_bytes().as_slice()
                && &chunk[8..12] == 0_u32.to_be_bytes().as_slice()
    ));

    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 2,
        content_type: "application/vnd.apple.mpegurl".to_owned(),
        body: Bytes::from_static(b"#EXTM3U"),
        priority: RemoteP2pAssetPriority::Foreground,
    });
    let foreground_opening = scheduler.next_transmission().expect("foreground opening");
    assert!(matches!(
        foreground_opening.as_slice(),
        [RemoteP2pOutboundFrame::Text(header), RemoteP2pOutboundFrame::Binary(chunk)]
            if header.contains("\"id\":2")
                && &chunk[4..8] == 2_u32.to_be_bytes().as_slice()
    ));
    let reserve_tail = scheduler.next_transmission().expect("reserve tail");
    assert!(matches!(
        reserve_tail.as_slice(),
        [RemoteP2pOutboundFrame::Binary(chunk)]
            if &chunk[4..8] == 1_u32.to_be_bytes().as_slice()
    ));
}

#[test]
fn causal_control_preempts_foreground_media_tails() {
    let mut scheduler = RemoteP2pOutboundScheduler::default();
    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 1,
        content_type: "video/mp2t".to_owned(),
        body: Bytes::from(vec![1; HLS_ASSET_CHUNK_SIZE * 3]),
        priority: RemoteP2pAssetPriority::Foreground,
    });
    let opening = scheduler.next_transmission().expect("media opening");
    assert!(matches!(
        opening.as_slice(),
        [
            RemoteP2pOutboundFrame::Text(_),
            RemoteP2pOutboundFrame::Binary(_)
        ]
    ));

    scheduler.push(RemoteP2pOutboundResponse::Text {
        body: "timeline".to_owned(),
        priority: RemoteP2pOutboundPriority::Control,
        request_id: None,
    });
    assert!(matches!(
        scheduler.next_transmission().as_deref(),
        Some([RemoteP2pOutboundFrame::Text(body)]) if body == "timeline"
    ));

    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 2,
        content_type: "application/vnd.apple.mpegurl".to_owned(),
        body: Bytes::from_static(b"#EXTM3U"),
        priority: RemoteP2pAssetPriority::Foreground,
    });
    assert!(matches!(
        scheduler.next_transmission().as_deref(),
        Some([RemoteP2pOutboundFrame::Binary(chunk)])
            if &chunk[4..8] == 1_u32.to_be_bytes().as_slice()
    ));
    assert!(matches!(
        scheduler.next_transmission().as_deref(),
        Some([RemoteP2pOutboundFrame::Text(header), RemoteP2pOutboundFrame::Binary(chunk)])
            if header.contains("\"id\":2")
                && &chunk[4..8] == 2_u32.to_be_bytes().as_slice()
    ));
}

#[test]
fn causal_control_has_a_bounded_burst_before_media_progress() {
    let mut scheduler = RemoteP2pOutboundScheduler::default();
    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 1,
        content_type: "video/mp2t".to_owned(),
        body: Bytes::from(vec![1; HLS_ASSET_CHUNK_SIZE * 3]),
        priority: RemoteP2pAssetPriority::Foreground,
    });
    scheduler.next_transmission().expect("media opening");
    for body in ["timeline-1", "timeline-2"] {
        scheduler.push(RemoteP2pOutboundResponse::Text {
            body: body.to_owned(),
            priority: RemoteP2pOutboundPriority::Control,
            request_id: None,
        });
    }

    assert!(matches!(
        scheduler.next_transmission().as_deref(),
        Some([RemoteP2pOutboundFrame::Text(body)]) if body == "timeline-1"
    ));
    assert!(matches!(
        scheduler.next_transmission().as_deref(),
        Some([RemoteP2pOutboundFrame::Binary(chunk)])
            if &chunk[4..8] == 1_u32.to_be_bytes().as_slice()
    ));
    assert!(matches!(
        scheduler.next_transmission().as_deref(),
        Some([RemoteP2pOutboundFrame::Text(body)]) if body == "timeline-2"
    ));
}

#[test]
fn cancellation_discards_correlated_text_responses() {
    let mut scheduler = RemoteP2pOutboundScheduler::default();
    scheduler.push(RemoteP2pOutboundResponse::Register { request_id: 7 });
    scheduler.push(RemoteP2pOutboundResponse::Text {
        body: "manifest-error".to_owned(),
        priority: RemoteP2pOutboundPriority::Control,
        request_id: Some(7),
    });
    scheduler.push(RemoteP2pOutboundResponse::CancelThrough { request_id: 7 });

    assert!(scheduler.next_transmission().is_none());

    scheduler.push(RemoteP2pOutboundResponse::Text {
        body: "late-manifest-error".to_owned(),
        priority: RemoteP2pOutboundPriority::Control,
        request_id: Some(7),
    });
    assert!(scheduler.next_transmission().is_none());
}

#[test]
fn promoting_a_published_reserve_asset_moves_its_next_frame_to_foreground() {
    let mut scheduler = RemoteP2pOutboundScheduler::default();
    scheduler.push(RemoteP2pOutboundResponse::Register { request_id: 1 });
    scheduler.push(RemoteP2pOutboundResponse::Register { request_id: 2 });
    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 1,
        content_type: "video/mp2t".to_owned(),
        body: Bytes::from(vec![1; HLS_ASSET_CHUNK_SIZE + 1]),
        priority: RemoteP2pAssetPriority::Reserve,
    });
    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 2,
        content_type: "video/mp2t".to_owned(),
        body: Bytes::from(vec![2; HLS_ASSET_CHUNK_SIZE + 1]),
        priority: RemoteP2pAssetPriority::Reserve,
    });
    let opening = scheduler.next_transmission().expect("reserve opening");
    assert_eq!(opening.len(), 2);

    scheduler.promote(1);

    assert!(matches!(
        scheduler.next_transmission().as_deref(),
        Some([RemoteP2pOutboundFrame::Binary(frame)])
            if &frame[4..8] == 1_u32.to_be_bytes().as_slice()
    ));
}

#[test]
fn promotion_is_retained_when_it_arrives_before_the_asset_response() {
    let mut scheduler = RemoteP2pOutboundScheduler::default();
    scheduler.push(RemoteP2pOutboundResponse::Register { request_id: 7 });
    scheduler.promote(7);
    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 8,
        content_type: "video/mp2t".to_owned(),
        body: Bytes::from_static(b"reserve"),
        priority: RemoteP2pAssetPriority::Reserve,
    });
    scheduler.push(RemoteP2pOutboundResponse::Asset {
        request_id: 7,
        content_type: "video/mp2t".to_owned(),
        body: Bytes::from_static(b"playback"),
        priority: RemoteP2pAssetPriority::Reserve,
    });

    assert!(matches!(
        scheduler.next_transmission().as_deref(),
        Some([RemoteP2pOutboundFrame::Text(header), RemoteP2pOutboundFrame::Binary(chunk)])
            if header.contains("\"id\":7")
                && &chunk[4..8] == 7_u32.to_be_bytes().as_slice()
    ));
}

#[test]
fn writer_ingest_is_bounded_before_a_scheduled_frame_must_run() {
    let (responses, mut receiver) = mpsc_channel(16);
    for request_id in 1..=10 {
        responses
            .try_send(RemoteP2pOutboundResponse::Text {
                body: format!("frame-{request_id}"),
                priority: RemoteP2pOutboundPriority::Control,
                request_id: None,
            })
            .expect("queued response");
    }
    let mut scheduler = RemoteP2pOutboundScheduler::default();
    assert_eq!(ingest_hls_responses(&mut receiver, &mut scheduler, 3), 3);
    assert!(scheduler.next_transmission().is_some());
    assert!(receiver.try_recv().is_ok());
}

#[test]
fn response_queue_and_unmatched_promotions_have_fixed_capacity() {
    let (responses, _receiver) = mpsc_channel(HLS_RESPONSE_QUEUE_CAPACITY);
    for request_id in 0..HLS_RESPONSE_QUEUE_CAPACITY {
        responses
            .try_send(RemoteP2pOutboundResponse::Text {
                body: format!("frame-{request_id}"),
                priority: RemoteP2pOutboundPriority::Control,
                request_id: None,
            })
            .expect("within response capacity");
    }
    assert!(
        responses
            .try_send(RemoteP2pOutboundResponse::Text {
                body: "overflow".to_owned(),
                priority: RemoteP2pOutboundPriority::Control,
                request_id: None,
            })
            .is_err()
    );

    let mut scheduler = RemoteP2pOutboundScheduler::default();
    for request_id in 0..(HLS_PROMOTION_CAPACITY as u32 + 10) {
        scheduler.push(RemoteP2pOutboundResponse::Register { request_id });
        scheduler.promote(request_id);
    }
    assert_eq!(scheduler.promoted.len(), HLS_PROMOTION_CAPACITY);
}

#[tokio::test]
async fn a_full_response_queue_backpressures_instead_of_losing_the_asset() {
    let (responses, mut receiver) = mpsc_channel(1);
    responses
        .send(RemoteP2pOutboundResponse::Text {
            body: "occupied".to_owned(),
            priority: RemoteP2pOutboundPriority::Control,
            request_id: None,
        })
        .await
        .expect("fill response queue");
    let send = RemoteP2pTransport::send_hls_asset(
        &responses,
        7,
        "video/mp2t",
        Bytes::from_static(b"asset"),
        RemoteP2pAssetPriority::Foreground,
    );
    tokio::pin!(send);
    assert!(
        tokio::time::timeout(Duration::from_millis(5), &mut send)
            .await
            .is_err()
    );
    assert!(matches!(
        receiver.recv().await,
        Some(RemoteP2pOutboundResponse::Text { .. })
    ));
    send.await.expect("asset admitted after queue progress");
    assert!(matches!(
        receiver.recv().await,
        Some(RemoteP2pOutboundResponse::Asset { request_id: 7, .. })
    ));
}

#[tokio::test]
async fn an_asset_larger_than_the_protocol_bound_is_rejected_before_queueing() {
    let (responses, mut receiver) = mpsc_channel(1);
    let result = RemoteP2pTransport::send_hls_asset(
        &responses,
        7,
        "video/mp2t",
        Bytes::from(vec![0; HLS_ASSET_MAX_BYTES + 1]),
        RemoteP2pAssetPriority::Foreground,
    )
    .await;

    assert!(result.is_err());
    let Some(RemoteP2pOutboundResponse::Text { body, .. }) = receiver.recv().await else {
        panic!("oversized asset must produce a protocol error response");
    };
    assert!(body.contains("exceeds protocol capacity"));
}

#[tokio::test]
async fn manifest_failure_preserves_its_control_role() {
    let (responses, mut receiver) = mpsc_channel(1);
    RemoteP2pTransport::send_hls_asset_error(
        &responses,
        7,
        "p2p-hls://session/3/reserve.m3u8",
        "fixture failure",
        RemoteP2pAssetPriority::Foreground,
    )
    .await
    .expect("manifest error response");

    assert!(matches!(
        receiver.recv().await,
        Some(RemoteP2pOutboundResponse::Text {
            priority: RemoteP2pOutboundPriority::Control,
            request_id: Some(7),
            ..
        })
    ));
}

#[tokio::test]
async fn a_full_response_queue_backpressures_instead_of_losing_a_promotion() {
    let (responses, mut receiver) = mpsc_channel(1);
    responses
        .send(RemoteP2pOutboundResponse::Text {
            body: "occupied".to_owned(),
            priority: RemoteP2pOutboundPriority::Control,
            request_id: None,
        })
        .await
        .expect("fill response queue");
    let send = RemoteP2pTransport::send_hls_promotion(&responses, 11);
    tokio::pin!(send);
    assert!(
        tokio::time::timeout(Duration::from_millis(5), &mut send)
            .await
            .is_err()
    );
    receiver.recv().await.expect("release response capacity");
    send.await.expect("promotion admitted after queue progress");
    assert!(matches!(
        receiver.recv().await,
        Some(RemoteP2pOutboundResponse::Promote { request_id: 11 })
    ));
}

#[test]
fn invalid_promotions_cannot_evict_a_registered_promotion() {
    let mut scheduler = RemoteP2pOutboundScheduler::default();
    scheduler.push(RemoteP2pOutboundResponse::Register { request_id: 1 });
    scheduler.promote(1);
    for request_id in 2..=(HLS_PROMOTION_CAPACITY as u32 + 1) {
        scheduler.promote(request_id);
    }

    assert_eq!(scheduler.promoted, VecDeque::from([1]));
}

#[tokio::test]
async fn negotiation_phases_share_one_total_lease() {
    let result = await_hls_negotiation(
        async {
            sleep(Duration::from_millis(20)).await;
            sleep(Duration::from_millis(20)).await;
            Ok::<(), anyhow::Error>(())
        },
        Duration::from_millis(5),
        "test negotiation",
    )
    .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn a_writer_capacity_wait_does_not_turn_slow_drain_into_supply_failure() {
    let buffered = Arc::new(AtomicUsize::new(HLS_ASSET_MAX_MESSAGE_SIZE));
    let wait = await_hls_data_channel_capacity(
        {
            let buffered = Arc::clone(&buffered);
            move || {
                let buffered = Arc::clone(&buffered);
                async move { buffered.load(AtomicOrdering::SeqCst) }
            }
        },
        || true,
        || false,
        HLS_ASSET_MAX_MESSAGE_SIZE - 1,
        0,
        Duration::from_millis(2),
    );
    tokio::pin!(wait);

    assert!(
        tokio::time::timeout(Duration::from_millis(15), &mut wait)
            .await
            .is_err()
    );
    buffered.store(0, AtomicOrdering::SeqCst);
    assert!(wait.await);
}

#[tokio::test]
async fn a_writer_capacity_read_that_never_finishes_exits_when_the_channel_closes() {
    let open = Arc::new(AtomicBool::new(true));
    let close = Arc::clone(&open);
    tokio::spawn(async move {
        sleep(Duration::from_millis(8)).await;
        close.store(false, AtomicOrdering::SeqCst);
    });

    assert!(
        !await_hls_data_channel_capacity(
            || std::future::pending::<usize>(),
            move || open.load(AtomicOrdering::SeqCst),
            || false,
            HLS_DATA_CHANNEL_HIGH_WATERMARK,
            HLS_DATA_CHANNEL_LOW_WATERMARK,
            Duration::from_millis(5),
        )
        .await
    );
}

#[tokio::test]
async fn capacity_at_the_high_watermark_does_not_wait_for_remote_delivery_evidence() {
    let buffered = Arc::new(AtomicUsize::new(HLS_DATA_CHANNEL_HIGH_WATERMARK));
    let reads = Arc::new(AtomicUsize::new(0));

    assert!(
        await_hls_data_channel_capacity(
            {
                let buffered = Arc::clone(&buffered);
                let reads = Arc::clone(&reads);
                move || {
                    let buffered = Arc::clone(&buffered);
                    let reads = Arc::clone(&reads);
                    async move {
                        reads.fetch_add(1, AtomicOrdering::SeqCst);
                        buffered.load(AtomicOrdering::SeqCst)
                    }
                }
            },
            || true,
            || false,
            HLS_DATA_CHANNEL_HIGH_WATERMARK,
            HLS_DATA_CHANNEL_LOW_WATERMARK,
            Duration::from_millis(5),
        )
        .await
    );
    assert_eq!(reads.load(AtomicOrdering::SeqCst), 1);
}

#[tokio::test]
async fn a_writer_capacity_wait_stops_at_the_low_watermark_instead_of_zero() {
    let buffered = Arc::new(AtomicUsize::new(HLS_DATA_CHANNEL_HIGH_WATERMARK + 1));
    let drain = Arc::clone(&buffered);
    tokio::spawn(async move {
        sleep(Duration::from_millis(2)).await;
        drain.store(HLS_DATA_CHANNEL_LOW_WATERMARK, AtomicOrdering::SeqCst);
    });

    assert!(
        await_hls_data_channel_capacity(
            move || {
                let buffered = Arc::clone(&buffered);
                async move { buffered.load(AtomicOrdering::SeqCst) }
            },
            || true,
            || false,
            HLS_DATA_CHANNEL_HIGH_WATERMARK,
            HLS_DATA_CHANNEL_LOW_WATERMARK,
            Duration::from_millis(20),
        )
        .await
    );
}

#[tokio::test]
async fn a_writer_capacity_wait_that_keeps_progressing_reaches_the_low_watermark() {
    let buffered = Arc::new(AtomicUsize::new(HLS_DATA_CHANNEL_HIGH_WATERMARK + 3));
    let drain = Arc::clone(&buffered);
    tokio::spawn(async move {
        for remaining in [
            HLS_DATA_CHANNEL_HIGH_WATERMARK + 2,
            HLS_DATA_CHANNEL_HIGH_WATERMARK + 1,
            HLS_DATA_CHANNEL_LOW_WATERMARK,
        ] {
            sleep(Duration::from_millis(60)).await;
            drain.store(remaining, AtomicOrdering::SeqCst);
        }
    });

    assert!(
        await_hls_data_channel_capacity(
            move || {
                let buffered = Arc::clone(&buffered);
                async move { buffered.load(AtomicOrdering::SeqCst) }
            },
            || true,
            || false,
            HLS_DATA_CHANNEL_HIGH_WATERMARK,
            HLS_DATA_CHANNEL_LOW_WATERMARK,
            Duration::from_millis(100),
        )
        .await
    );
}

#[tokio::test]
async fn a_slow_writer_send_is_not_misclassified_as_transport_death() {
    let (_lifetime, mut lifetime) = watch::channel(false);
    let delayed = async {
        sleep(Duration::from_millis(10)).await;
        "sent"
    };

    assert_eq!(
        await_hls_data_channel_send(delayed, &mut lifetime).await,
        Some("sent")
    );
}

#[tokio::test]
async fn explicit_peer_lifetime_cancels_a_stale_open_capacity_wait() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel = Arc::clone(&cancelled);
    tokio::spawn(async move {
        sleep(Duration::from_millis(8)).await;
        cancel.store(true, AtomicOrdering::SeqCst);
    });

    assert!(
        !await_hls_data_channel_capacity(
            || std::future::pending::<usize>(),
            || true,
            move || cancelled.load(AtomicOrdering::SeqCst),
            HLS_DATA_CHANNEL_HIGH_WATERMARK,
            HLS_DATA_CHANNEL_LOW_WATERMARK,
            Duration::from_millis(5),
        )
        .await
    );
}

#[tokio::test]
async fn explicit_peer_lifetime_cancels_a_pending_send() {
    let (lifetime, mut lifetime_rx) = watch::channel(false);
    tokio::spawn(async move {
        sleep(Duration::from_millis(5)).await;
        lifetime.send(true).expect("cancel writer");
    });

    assert!(
        await_hls_data_channel_send(std::future::pending::<()>(), &mut lifetime_rx)
            .await
            .is_none()
    );
}

#[tokio::test]
async fn a_writer_cancelled_before_its_idle_wait_exits_immediately() {
    let (_responses, mut receiver) = mpsc_channel(1);
    let (lifetime, initial_lifetime_rx) = watch::channel(false);
    drop(initial_lifetime_rx);
    lifetime.send_replace(true);
    let mut lifetime_rx = lifetime.subscribe();

    assert!(
        tokio::time::timeout(
            Duration::from_millis(5),
            await_hls_writer_response(&mut receiver, &mut lifetime_rx),
        )
        .await
        .expect("pre-cancelled idle wait must be bounded")
        .is_none()
    );
}

#[tokio::test]
async fn close_all_cancels_every_writer_before_waiting_for_transport_close() -> Result<()> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let (host, _events) = RemoteP2pTransport::new();
    let first = host.create_peer("first", 1).await?;
    let second = host.create_peer("second", 1).await?;

    host.close_all().await;

    let first_lifetime = first.writer_lifetime.subscribe();
    let second_lifetime = second.writer_lifetime.subscribe();
    assert!(*first_lifetime.borrow());
    assert!(*second_lifetime.borrow());
    Ok(())
}

#[tokio::test]
async fn duplicate_offer_replay_is_serialized_and_idempotent() -> Result<()> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let (host, _events) = RemoteP2pTransport::new();
    let (relay_tx, mut relay_rx) = unbounded_channel();
    host.set_relay_events(relay_tx);
    let browser = Arc::new(
        APIBuilder::new()
            .build()
            .new_peer_connection(RTCConfiguration::default())
            .await?,
    );
    let _data = browser
        .create_data_channel(HLS_DATA_CHANNEL_LABEL, None)
        .await?;
    let initial_offer = browser.create_offer(None).await?;
    browser.set_local_description(initial_offer.clone()).await?;
    host.handle_signal(
        "duplicate-offer-client",
        RemoteP2pSignal::Offer {
            sdp: initial_offer.sdp,
            generation: 1,
            revision: 1,
        },
    )
    .await?;
    loop {
        let frame = relay_rx
            .recv()
            .await
            .ok_or_else(|| anyhow!("host relay channel closed before initial answer"))?;
        let value: serde_json::Value = serde_json::from_str(&frame)?;
        let signal: RemoteP2pSignal = serde_json::from_value(value["signal"].clone())?;
        if let RemoteP2pSignal::Answer {
            sdp,
            generation,
            revision,
        } = signal
        {
            assert_eq!(generation, 1);
            assert_eq!(revision, 1);
            browser
                .set_remote_description(RTCSessionDescription::answer(sdp)?)
                .await?;
            break;
        }
    }
    let offer = browser
        .create_offer(Some(
            webrtc::peer_connection::offer_answer_options::RTCOfferOptions {
                ice_restart: true,
                ..Default::default()
            },
        ))
        .await?;
    browser.set_local_description(offer.clone()).await?;

    let first = host.handle_signal(
        "duplicate-offer-client",
        RemoteP2pSignal::Offer {
            sdp: offer.sdp.clone(),
            generation: 1,
            revision: 2,
        },
    );
    let replay = host.handle_signal(
        "duplicate-offer-client",
        RemoteP2pSignal::Offer {
            sdp: offer.sdp,
            generation: 1,
            revision: 2,
        },
    );
    let (first, replay) = tokio::join!(first, replay);
    first?;
    replay?;

    browser.close().await?;
    host.close_all().await;
    Ok(())
}

#[tokio::test]
async fn a_closed_peer_is_replaced_before_accepting_the_next_offer() -> Result<()> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let (host, _events) = RemoteP2pTransport::new();
    let (relay_tx, _relay_rx) = unbounded_channel();
    host.set_relay_events(relay_tx);
    let stale = host.create_peer("replacement-client", 1).await?;
    stale.connection.close().await?;

    let browser = Arc::new(
        APIBuilder::new()
            .build()
            .new_peer_connection(RTCConfiguration::default())
            .await?,
    );
    let _data = browser
        .create_data_channel(HLS_DATA_CHANNEL_LABEL, None)
        .await?;
    let offer = browser.create_offer(None).await?;
    browser.set_local_description(offer.clone()).await?;
    host.handle_signal(
        "replacement-client",
        RemoteP2pSignal::Offer {
            sdp: offer.sdp,
            generation: 2,
            revision: 1,
        },
    )
    .await?;

    let replacement = host.peer("replacement-client").await?;
    assert!(!Arc::ptr_eq(&stale, &replacement));
    assert_eq!(replacement.generation, 2);
    let stale_replay = host.create_peer("replacement-client", 1).await?;
    assert!(Arc::ptr_eq(&replacement, &stale_replay));
    replacement.connection.close().await?;
    let stale_after_failure = host.create_peer("replacement-client", 1).await?;
    assert!(Arc::ptr_eq(&replacement, &stale_after_failure));
    browser.close().await?;
    host.close_all().await;
    Ok(())
}

#[tokio::test]
async fn discarding_a_timed_out_negotiation_removes_its_exact_peer() -> Result<()> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let (host, _events) = RemoteP2pTransport::new();
    let peer = host.create_peer("timed-out-client", 1).await?;

    host.discard_peer("timed-out-client", &peer).await;

    assert!(host.peer("timed-out-client").await.is_err());
    assert_eq!(
        peer.connection.connection_state(),
        RTCPeerConnectionState::Closed
    );
    Ok(())
}

#[tokio::test]
async fn supply_invalidation_is_scoped_to_its_exact_generation() -> Result<()> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let (host, _events) = RemoteP2pTransport::new();
    let (relay_tx, mut relay_rx) = unbounded_channel();
    host.set_relay_events(relay_tx);
    let peer = host.create_peer("stalled-client", 2).await?;

    host.invalidate_supply("stalled-client", 1).await;
    assert!(Arc::ptr_eq(&peer, &host.peer("stalled-client").await?));
    assert!(relay_rx.try_recv().is_err());

    host.invalidate_supply("stalled-client", 2).await;
    assert!(host.peer("stalled-client").await.is_err());
    assert_eq!(
        peer.connection.connection_state(),
        RTCPeerConnectionState::Closed
    );
    let frame: serde_json::Value = serde_json::from_str(&relay_rx.recv().await.unwrap())?;
    assert_eq!(frame["clientId"], "stalled-client");
    assert_eq!(frame["signal"]["type"], "error");
    assert_eq!(frame["signal"]["reason"], "supply_stalled");
    assert_eq!(frame["signal"]["generation"], 2);
    assert_eq!(frame["signal"]["revision"], 0);
    Ok(())
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
        .create_data_channel(
            HLS_DATA_CHANNEL_LABEL,
            Some(
                webrtc::data_channel::data_channel_init::RTCDataChannelInit {
                    ordered: Some(false),
                    ..Default::default()
                },
            ),
        )
        .await?;
    let (opened_tx, mut opened_rx) = unbounded_channel();
    data.on_open(Box::new(move || {
        let opened_tx = opened_tx.clone();
        Box::pin(async move {
            let _ = opened_tx.send(());
        })
    }));
    let (asset_chunk_tx, mut asset_chunk_rx) = unbounded_channel();
    data.on_message(Box::new(move |message: DataChannelMessage| {
        let asset_chunk_tx = asset_chunk_tx.clone();
        Box::pin(async move {
            if message.is_string || message.data.len() < HLS_ASSET_CHUNK_HEADER_SIZE {
                return;
            }
            let bytes = message.data;
            if &bytes[..4] != HLS_ASSET_CHUNK_MAGIC {
                return;
            }
            let request_id = u32::from_be_bytes(bytes[4..8].try_into().unwrap());
            let chunk_index = u32::from_be_bytes(bytes[8..12].try_into().unwrap());
            let _ = asset_chunk_tx.send((request_id, chunk_index, bytes.len() - 12));
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
        RemoteP2pSignal::Offer {
            sdp: offer.sdp,
            generation: 1,
            revision: 1,
        },
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
                            RemoteP2pSignal::Candidate {
                                candidate,
                                generation: 1,
                            },
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
                        RemoteP2pSignal::Answer {
                            sdp,
                            generation,
                            revision,
                        } => {
                            assert_eq!(generation, 1);
                            assert_eq!(revision, 1);
                            browser
                                .set_remote_description(RTCSessionDescription::answer(sdp)?)
                                .await?;
                        }
                        RemoteP2pSignal::Candidate { candidate, generation } => {
                            assert_eq!(generation, 1);
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
            "url": "p2p-hls://session/4/index.m3u8",
            "playoutSeconds": 12.5
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
        playout_seconds,
        responses,
        ..
    } = event
    else {
        panic!("expected HLS asset request");
    };
    assert_eq!(client_id, "integration-client");
    assert_eq!(request_id, 17);
    assert_eq!(url, "p2p-hls://session/4/index.m3u8");
    assert_eq!(playout_seconds, Some(12.5));

    let asset = Bytes::from(vec![0x5a; HLS_DATA_CHANNEL_HIGH_WATERMARK * 2 + 123]);
    let expected_bytes = asset.len();
    let expected_chunks = expected_bytes.div_ceil(HLS_ASSET_CHUNK_SIZE);
    RemoteP2pTransport::send_hls_asset(
        &responses,
        request_id,
        "video/mp2t",
        asset,
        RemoteP2pAssetPriority::Foreground,
    )
    .await?;
    let received = tokio::time::timeout(Duration::from_secs(5), async {
        let mut chunks = Vec::new();
        while chunks.len() < expected_chunks {
            chunks.push(
                asset_chunk_rx
                    .recv()
                    .await
                    .ok_or_else(|| anyhow!("asset chunk channel closed"))?,
            );
        }
        Ok::<_, anyhow::Error>(chunks)
    })
    .await
    .map_err(|_| anyhow!("locally flow-controlled HLS asset delivery timed out"))??;
    assert_eq!(
        received.iter().map(|(_, _, bytes)| bytes).sum::<usize>(),
        expected_bytes
    );
    assert_eq!(
        received
            .iter()
            .map(|(request_id, chunk_index, _)| (*request_id, *chunk_index))
            .collect::<Vec<_>>(),
        (0..expected_chunks)
            .map(|chunk_index| (17, chunk_index as u32))
            .collect::<Vec<_>>()
    );

    data.send_text(
        serde_json::json!({
            "type": "prefetch_reserve",
            "revision": 7,
            "targetTracks": 3,
            "bufferSeconds": 180
        })
        .to_string(),
    )
    .await?;
    let reserve = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .map_err(|_| anyhow!("P2P reserve request was not delivered"))?
        .ok_or_else(|| anyhow!("P2P transport event channel closed"))?;
    let RemoteP2pTransportEvent::PrefetchReserveRequested {
        client_id,
        revision,
        target_tracks,
        buffer_seconds,
    } = reserve
    else {
        panic!("expected prefetch reserve request");
    };
    assert_eq!(client_id, "integration-client");
    assert_eq!(revision, 7);
    assert_eq!(target_tracks, 3);
    assert_eq!(buffer_seconds, 180);

    data.send_text(
        serde_json::json!({
            "type": "playback_ready",
            "epoch": 4,
            "readySeconds": 60.0,
            "playoutSeconds": 12.5,
            "protectedSequence": 19
        })
        .to_string(),
    )
    .await?;
    let ready = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .map_err(|_| anyhow!("P2P playback readiness was not delivered"))?
        .ok_or_else(|| anyhow!("P2P transport event channel closed"))?;
    let RemoteP2pTransportEvent::PlaybackReady {
        client_id,
        epoch,
        ready_seconds,
        playout_seconds,
        protected_sequence,
        responses: _,
    } = ready
    else {
        panic!("expected playback readiness");
    };
    assert_eq!(client_id, "integration-client");
    assert_eq!(epoch, 4);
    assert_eq!(ready_seconds, 60.0);
    assert_eq!(playout_seconds, 12.5);
    assert_eq!(protected_sequence, 19);

    data.send_text(
        serde_json::json!({
            "type": "playback_handoff_commit",
            "epoch": 4,
            "handoffSequence": 13
        })
        .to_string(),
    )
    .await?;
    let commit = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .map_err(|_| anyhow!("P2P handoff commit was not delivered"))?
        .ok_or_else(|| anyhow!("P2P transport event channel closed"))?;
    let RemoteP2pTransportEvent::PlaybackHandoffCommit {
        client_id,
        epoch,
        handoff_sequence,
    } = commit
    else {
        panic!("expected handoff commit");
    };
    assert_eq!(client_id, "integration-client");
    assert_eq!(epoch, 4);
    assert_eq!(handoff_sequence, 13);

    browser.close().await?;
    host.close_all().await;
    Ok(())
}
