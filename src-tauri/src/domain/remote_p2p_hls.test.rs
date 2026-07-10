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
    assert!(session.snapshot().entries.is_empty());
}

#[test]
fn appending_tracks_preserves_existing_entry_offsets() {
    let mut session = ClientHlsSession::prepared(3);
    session.publish_start_at(published("first", 8.0), 12);
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
    session.publish_start_at(published("liked", 8.0), 12);
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
    session.publish_start_at(published("first", 8.0), 20);
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
fn stale_epoch_urls_have_no_asset_path() {
    assert!(parse_session_url("p2p-hls://session/8/index.m3u8", 9).is_err());
    assert!(matches!(
        parse_session_url("p2p-hls://session/9/track/2/segment/4.ts", 9),
        Ok(SessionAssetPath::Segment {
            track_index: 2,
            segment_index: 4
        })
    ));
}
