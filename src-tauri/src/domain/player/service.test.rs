use super::model::PlaybackTrack;
use super::service::{
    PlaybackTrackIdentityUpdate, playback_tracks_match,
    resolve_active_request_track_identity_update, resolve_playback_status_track_identity,
    resolve_session_track_identity_update,
};
use std::path::PathBuf;

fn track(name: &str) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: name.to_string(),
        music_url: format!("https://example.com/{name}"),
        file_path: PathBuf::from(format!("{name}.m4a")),
        start_ms: 0,
        end_ms: 60_000,
    }
}

#[test]
fn playback_tracks_match_detects_playlist_growth() {
    let current = vec![track("a")];
    let refreshed = vec![track("a"), track("b")];

    assert!(!playback_tracks_match(&current, &refreshed));
}

#[test]
fn playback_tracks_match_accepts_identical_track_snapshots() {
    let current = vec![track("a"), track("b")];
    let refreshed = vec![track("a"), track("b")];

    assert!(playback_tracks_match(&current, &refreshed));
}

#[test]
fn resolve_session_track_identity_update_rewrites_matching_music_identity() {
    let mut current = track("a");
    current.start_ms = 8_000;
    current.end_ms = 112_000;
    let other = track("b");

    let updated = resolve_session_track_identity_update(
        &[current, other.clone()],
        &PlaybackTrackIdentityUpdate {
            music_name: "A edited".to_string(),
            music_url: "https://example.com/a".to_string(),
            start_ms: 8_000,
            end_ms: 112_000,
            next_start_ms: 9_250,
            next_end_ms: 110_750,
        },
    )
    .expect("matching session track should be updated");

    assert_eq!(updated[0].music_name, "A edited");
    assert_eq!(updated[0].start_ms, 9_250);
    assert_eq!(updated[0].end_ms, 110_750);
    assert_eq!(updated[1].music_url, other.music_url);
}

#[test]
fn resolve_session_track_identity_update_is_idempotent_for_current_identity() {
    let mut current = track("a");
    current.music_name = "A edited".to_string();
    current.start_ms = 9_250;
    current.end_ms = 110_750;

    let updated = resolve_session_track_identity_update(
        &[current],
        &PlaybackTrackIdentityUpdate {
            music_name: "A edited".to_string(),
            music_url: "https://example.com/a".to_string(),
            start_ms: 9_250,
            end_ms: 110_750,
            next_start_ms: 9_250,
            next_end_ms: 110_750,
        },
    );

    assert!(updated.is_none());
}

#[test]
fn resolve_playback_status_track_identity_uses_only_the_actual_request_path() {
    let current = track("a");

    assert!(resolve_playback_status_track_identity(Some("a.m4a"), Some(&current)).is_some());
    assert!(resolve_playback_status_track_identity(Some("b.m4a"), Some(&current)).is_none());
    assert!(resolve_playback_status_track_identity(None, Some(&current)).is_none());
}

#[test]
fn resolve_active_request_track_identity_update_rewrites_the_actual_request_identity() {
    let mut current = track("a");
    current.start_ms = 1_255_050;
    current.end_ms = 1_355_000;

    let updated = resolve_active_request_track_identity_update(
        Some(&current),
        &PlaybackTrackIdentityUpdate {
            music_name: "A edited".to_string(),
            music_url: "https://example.com/a".to_string(),
            start_ms: 1_255_050,
            end_ms: 1_355_000,
            next_start_ms: 1_254_046,
            next_end_ms: 1_355_000,
        },
    )
    .expect("active request identity should update");

    assert_eq!(updated.music_name, "A edited");
    assert_eq!(updated.start_ms, 1_254_046);
    assert_eq!(updated.end_ms, 1_355_000);
}

#[test]
fn resolve_active_request_track_identity_update_ignores_unrelated_updates() {
    let mut current = track("a");
    current.start_ms = 1_255_050;
    current.end_ms = 1_355_000;

    let updated = resolve_active_request_track_identity_update(
        Some(&current),
        &PlaybackTrackIdentityUpdate {
            music_name: "B edited".to_string(),
            music_url: "https://example.com/b".to_string(),
            start_ms: 1_255_050,
            end_ms: 1_355_000,
            next_start_ms: 1_254_046,
            next_end_ms: 1_355_000,
        },
    );

    assert!(updated.is_none());
}
