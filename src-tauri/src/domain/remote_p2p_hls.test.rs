use super::*;
use std::collections::HashMap;

fn segment_urls_by_sequence(manifest: &str) -> HashMap<u64, String> {
    let mut sequence = manifest
        .lines()
        .find_map(|line| line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:"))
        .and_then(|value| value.parse::<u64>().ok())
        .expect("manifest should declare its media sequence");
    let mut segments = HashMap::new();
    for line in manifest.lines().filter(|line| !line.starts_with('#')) {
        if line.is_empty() {
            continue;
        }
        segments.insert(sequence, line.to_owned());
        sequence += 1;
    }
    segments
}

fn track(id: &str, start_ms: u32, end_ms: u32) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: "test".to_owned(),
        canonical_music_id: id.to_owned(),
        music_name: id.to_owned(),
        music_url: format!("https://example.test/{id}"),
        file_path: PathBuf::from(format!("{id}.m4a")),
        source_music: None,
        start_ms,
        end_ms,
        liked: false,
        loudness_profile: None,
    }
}

fn published(id: &str, duration_seconds: f64) -> PublishedTrack {
    PublishedTrack {
        track: track(id, 0, (duration_seconds * 1_000.0) as u32),
        asset: HlsTrackAsset {
            target_duration: duration_seconds.ceil() as u32,
            segments: vec![HlsSegmentAsset {
                duration_seconds,
                path: PathBuf::from(format!("{id}.ts")),
            }],
        },
    }
}

fn published_segments(id: &str, segment_count: usize, duration_seconds: f64) -> PublishedTrack {
    PublishedTrack {
        track: track(
            id,
            0,
            (segment_count as f64 * duration_seconds * 1_000.0) as u32,
        ),
        asset: HlsTrackAsset {
            target_duration: duration_seconds.ceil() as u32,
            segments: (0..segment_count)
                .map(|index| HlsSegmentAsset {
                    duration_seconds,
                    path: PathBuf::from(format!("{id}-{index}.ts")),
                })
                .collect(),
        },
    }
}

#[test]
fn prepared_manifest_extends_the_live_priming_frontier() {
    let session = ClientHlsSession::prepared(7);
    let first = session.manifest_at(0);
    let later = session.manifest_at(20);
    assert_eq!(first.matches(LOCAL_PRIMING_SEGMENT_URL).count(), 7);
    assert!(first.contains("#EXT-X-MEDIA-SEQUENCE:0"));
    assert!(later.contains("#EXT-X-MEDIA-SEQUENCE:18"));
    assert_eq!(later.matches(LOCAL_PRIMING_SEGMENT_URL).count(), 9);
    assert_eq!(
        session.snapshot().stream_url,
        "p2p-hls://session/7/index.m3u8"
    );
    assert_eq!(
        session.snapshot().reserve_url,
        "p2p-hls://session/7/reserve.m3u8"
    );
    assert!(session.snapshot().entries.is_empty());
}

#[test]
fn prepared_track_is_reserve_only_until_handoff_is_committed() {
    let mut session = ClientHlsSession::prepared(9);
    session.prepare_start(published_segments("first", 40, 2.0));

    assert_eq!(session.manifest_at(21).matches("/segment/").count(), 0);
    assert_eq!(
        session.reserve_manifest_at(21).matches("/segment/").count(),
        30
    );
}

#[test]
fn remote_hls_representation_preserves_the_music_bitrate() {
    assert_eq!(HLS_AUDIO_BITRATE, "192k");
    assert_eq!(HLS_MATERIALIZATION_VERSION, "p2p-hls-v1");
}

#[test]
fn handoff_accepts_the_hero_owned_startup_prefix_and_is_idempotent() {
    let mut session = ClientHlsSession::prepared(10);
    session.prepare_start(published_segments("first", 40, 2.0));
    assert_eq!(session.offer_handoff(f64::NAN, 24.0, 19), None);
    assert_eq!(session.offer_handoff(0.0, 24.0, 19), None);
    assert!(session.handoff_sequence.is_none());

    assert_eq!(session.offer_handoff(6.0, 24.0, 19), Some(19));
    assert!(session.handoff_sequence.is_none());
    assert!(session.commit_offered_handoff(19));
    assert!(session.commit_offered_handoff(19));
    assert_eq!(session.handoff_sequence, Some(19));
    assert_eq!(session.offer_handoff(6.0, 40.0, 26), Some(19));
    assert!(session.commit_offered_handoff(19));
    assert_eq!(session.handoff_sequence, Some(19));
}

#[test]
fn appending_tracks_preserves_existing_entry_offsets() {
    let mut session = ClientHlsSession::prepared(3);
    session.prepare_start(published("first", 8.0));
    assert!(session.commit_handoff_at(12));
    let first = session.snapshot().entries[0].clone();
    assert!(session.append_tracks(vec![published("second", 6.0)]));
    let snapshot = session.snapshot();
    assert_eq!(snapshot.entries[0].id, first.id);
    assert_eq!(snapshot.entries[0].start_seconds, first.start_seconds);
    assert_eq!(snapshot.entries[0].end_seconds, first.end_seconds);
    assert_eq!(snapshot.entries[1].start_seconds, first.end_seconds);
}

#[test]
fn appending_tracks_preserves_repeated_queue_entries() {
    let mut session = ClientHlsSession::prepared(4);
    session.prepare_start(published("liked", 8.0));
    assert!(session.commit_handoff_at(12));
    assert!(session.append_tracks(vec![published("liked", 8.0)]));
    let snapshot = session.snapshot();
    assert_eq!(snapshot.entries.len(), 2);
    assert_eq!(snapshot.entries[0].track.canonical_music_id, "liked");
    assert_eq!(snapshot.entries[1].track.canonical_music_id, "liked");
    assert_eq!(
        snapshot.entries[1].start_seconds,
        snapshot.entries[0].end_seconds
    );
}

#[test]
fn real_media_handoff_is_future_only_and_keeps_its_discontinuity_visible() {
    let mut session = ClientHlsSession::prepared(5);
    let prepared = session.manifest_at(20);
    session.prepare_start(published("first", 8.0));
    assert!(session.commit_handoff_at(20));
    let manifest = session.manifest_at(21);
    let prepared_segments = segment_urls_by_sequence(&prepared);
    let published_segments = segment_urls_by_sequence(&manifest);
    assert!(prepared.contains("#EXT-X-MEDIA-SEQUENCE:18"));
    assert_eq!(prepared.matches(LOCAL_PRIMING_SEGMENT_URL).count(), 9);
    assert!(manifest.contains("#EXT-X-MEDIA-SEQUENCE:24"));
    assert_eq!(manifest.matches(LOCAL_PRIMING_SEGMENT_URL).count(), 3);
    for sequence in 24..27 {
        assert_eq!(
            published_segments.get(&sequence),
            prepared_segments.get(&sequence)
        );
    }
    assert!(!prepared_segments.contains_key(&27));
    assert_eq!(
        published_segments.get(&27).map(String::as_str),
        Some("p2p-hls://session/5/track/0/segment/0.ts")
    );
    assert!(manifest.contains("#EXT-X-DISCONTINUITY\n#EXTINF:8.000000"));
    assert_eq!(
        session.snapshot().entries[0].start_seconds,
        27.0 * HLS_PRIMING_SEGMENT_SECONDS
    );
}

#[test]
fn legacy_manifest_stays_deep_until_reserve_projection_is_observed() {
    let mut session = ClientHlsSession::prepared(6);
    session.prepare_start(published_segments("long", 150, 2.0));
    assert!(session.commit_handoff_at(20));

    let legacy = session.manifest_at(21);
    assert_eq!(legacy.matches("/segment/").count(), 30);

    session.enable_projected_playback_manifest();
    let playback = session.manifest_at(21);
    assert_eq!(playback.matches("/segment/").count(), 3);

    let compact = session.reserve_manifest_at(21);
    assert_eq!(compact.matches("/segment/").count(), 30);

    session.set_reserve_buffer_seconds(180);
    let expanded = session.reserve_manifest_at(21);
    assert_eq!(expanded.matches("/segment/").count(), 90);

    session.set_reserve_buffer_seconds(60);
    let retained = session.reserve_manifest_at(21);
    assert_eq!(retained.matches("/segment/").count(), 90);
}

#[test]
fn real_media_handoff_is_anchored_to_observed_client_playout() {
    let mut session = ClientHlsSession::prepared(8);
    session.observe_playout_seconds(Some(10.5));
    session.prepare_start(published("first", 8.0));
    assert!(session.commit_handoff_at(session.current_prime_sequence()));

    assert_eq!(
        session.snapshot().entries[0].start_seconds,
        12.0 * HLS_PRIMING_SEGMENT_SECONDS
    );
}

#[tokio::test]
async fn reserve_manifest_request_negotiates_projected_playback_without_a_protocol_flag() {
    let cache_root = std::env::temp_dir().join(format!(
        "slisic-p2p-hls-projection-test-{}",
        std::process::id()
    ));
    let hls = RemoteP2pHls::new(cache_root.clone()).expect("test HLS cache should initialize");
    let snapshot = hls
        .prepare("client")
        .expect("test HLS session should prepare");
    {
        let mut sessions = hls
            .sessions
            .lock()
            .expect("test HLS session lock should remain healthy");
        sessions
            .get_mut("client")
            .expect("prepared test session should exist")
            .prepare_start(published_segments("long", 150, 2.0));
        assert!(
            sessions
                .get_mut("client")
                .expect("prepared test session should exist")
                .commit_handoff_at(20)
        );
    }

    let legacy = hls
        .resolve_asset("client", &snapshot.stream_url, Some(42.0))
        .await
        .expect("legacy playback manifest should resolve");
    assert_eq!(
        String::from_utf8_lossy(&legacy.body)
            .matches("/segment/")
            .count(),
        30
    );

    let reserve = hls
        .resolve_asset("client", &snapshot.reserve_url, Some(42.0))
        .await
        .expect("reserve manifest should resolve");
    assert_eq!(
        String::from_utf8_lossy(&reserve.body)
            .matches("/segment/")
            .count(),
        30
    );

    let projected = hls
        .resolve_asset("client", &snapshot.stream_url, Some(42.0))
        .await
        .expect("projected playback manifest should resolve");
    assert_eq!(
        String::from_utf8_lossy(&projected.body)
            .matches("/segment/")
            .count(),
        3
    );

    drop(hls);
    let _ = std::fs::remove_dir_all(cache_root);
}

#[test]
fn prepared_sessions_never_reuse_a_persistent_cache_epoch() {
    let cache_root =
        std::env::temp_dir().join(format!("slisic-p2p-hls-epoch-test-{}", std::process::id()));
    let hls = RemoteP2pHls::new(cache_root.clone()).expect("test HLS cache should initialize");
    let first = hls.prepare("client").expect("first session should prepare");
    hls.remove("client");
    let second = hls
        .prepare("client")
        .expect("second session should prepare");

    assert!(second.epoch > first.epoch);
    assert!(second.epoch <= 9_007_199_254_740_991);
    drop(hls);
    let _ = std::fs::remove_dir_all(cache_root);
}

#[test]
fn stale_epoch_urls_have_no_asset_path() {
    assert!(parse_session_url("p2p-hls://session/8/index.m3u8", 9).is_err());
    assert!(matches!(
        parse_session_url("p2p-hls://session/9/reserve.m3u8", 9),
        Ok(SessionAssetPath::ReserveManifest)
    ));
    assert!(matches!(
        parse_session_url("p2p-hls://session/9/track/2/segment/4.ts", 9),
        Ok(SessionAssetPath::Segment {
            track_index: 2,
            segment_index: 4
        })
    ));
}
