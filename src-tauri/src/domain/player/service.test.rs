use super::model::{
    PlaybackContinuationMode, PlaybackTrack, PlaybackTrackPayload, PlaybackTrackProjectionError,
};
use super::service::{
    ActivePlaybackRange, PlaybackTrackIdentityUpdate, playback_tracks_match,
    resolve_active_playback_range_identity_update, resolve_active_request_track_identity_update,
    resolve_playback_seek_pause_after_request, resolve_playback_seek_range,
    resolve_playback_status_track_identity, resolve_session_continuation_mode,
    resolve_session_track_identity_update, resolve_spectrum_music_playback_range,
    should_resume_playback_seek_cancel,
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

fn track_payload(name: &str) -> PlaybackTrackPayload {
    PlaybackTrackPayload {
        playlist_name: "Focus".to_string(),
        music_name: name.to_string(),
        music_url: format!("https://example.com/{name}"),
        file_path: format!("{name}.m4a"),
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
fn session_continuation_uses_global_mode_only_when_no_local_policy_exists() {
    assert_eq!(
        resolve_session_continuation_mode(None, PlaybackContinuationMode::Random),
        PlaybackContinuationMode::Random,
    );
    assert_eq!(
        resolve_session_continuation_mode(
            Some(PlaybackContinuationMode::RepeatCurrent),
            PlaybackContinuationMode::Random,
        ),
        PlaybackContinuationMode::RepeatCurrent,
    );
}

#[test]
fn playback_track_payload_projection_accepts_valid_millisecond_bounds() {
    let projected =
        PlaybackTrack::try_from_payload(track_payload("a")).expect("valid payload should project");

    assert_eq!(projected.start_ms, 0);
    assert_eq!(projected.end_ms, 60_000);
}

#[test]
fn playback_track_payload_projection_rejects_empty_and_inverted_raw_identity() {
    let mut empty_path = track_payload("a");
    empty_path.file_path = String::new();
    assert_eq!(
        PlaybackTrack::try_from_payload(empty_path).unwrap_err(),
        PlaybackTrackProjectionError::EmptyFilePath,
    );

    let mut invalid_range = track_payload("a");
    invalid_range.start_ms = 60_000;
    invalid_range.end_ms = 60_000;
    assert_eq!(
        PlaybackTrack::try_from_payload(invalid_range).unwrap_err(),
        PlaybackTrackProjectionError::InvalidRange,
    );
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

#[test]
fn resolve_playback_seek_range_keeps_the_requested_position_and_region_end() {
    assert_eq!(
        resolve_playback_seek_range(25_250, 40_000),
        Some(ActivePlaybackRange {
            start_ms: 25_250,
            end_ms: 40_000,
        }),
    );
}

#[test]
fn resolve_playback_seek_range_never_starts_at_or_after_the_region_end() {
    assert_eq!(
        resolve_playback_seek_range(50_000, 40_000),
        Some(ActivePlaybackRange {
            start_ms: 39_999,
            end_ms: 40_000,
        }),
    );
    assert_eq!(resolve_playback_seek_range(0, 0), None);
}

#[test]
fn resolve_active_playback_range_identity_update_preserves_seek_position_inside_new_region() {
    assert_eq!(
        resolve_active_playback_range_identity_update(
            Some(ActivePlaybackRange {
                start_ms: 25_000,
                end_ms: 112_000,
            }),
            &PlaybackTrackIdentityUpdate {
                music_name: "A edited".to_string(),
                music_url: "https://example.com/a".to_string(),
                start_ms: 8_000,
                end_ms: 112_000,
                next_start_ms: 9_250,
                next_end_ms: 110_750,
            },
        ),
        Some(ActivePlaybackRange {
            start_ms: 25_000,
            end_ms: 110_750,
        }),
    );
}

#[test]
fn resolve_playback_seek_pause_after_request_keeps_temporary_pause_playing() {
    assert_eq!(
        resolve_playback_seek_pause_after_request(true, true, true),
        false
    );
}

#[test]
fn resolve_playback_seek_pause_after_request_preserves_paused_state_without_temporary_pause() {
    assert_eq!(
        resolve_playback_seek_pause_after_request(true, true, false),
        true
    );
    assert_eq!(
        resolve_playback_seek_pause_after_request(false, false, false),
        true
    );
    assert_eq!(
        resolve_playback_seek_pause_after_request(true, false, false),
        false
    );
}

#[test]
fn should_resume_playback_seek_cancel_only_restores_temporary_pause_on_current_track() {
    assert_eq!(
        should_resume_playback_seek_cancel(true, true, true, true),
        true
    );
    assert_eq!(
        should_resume_playback_seek_cancel(false, true, true, true),
        false
    );
    assert_eq!(
        should_resume_playback_seek_cancel(true, true, false, true),
        false
    );
    assert_eq!(
        should_resume_playback_seek_cancel(true, true, true, false),
        false
    );
}

#[test]
fn playback_status_identity_exposes_track_bounds_separately_from_seek_range() {
    let mut current = track("a");
    current.start_ms = 20_000;
    current.end_ms = 80_000;

    assert_eq!(current.start_ms, 20_000);
    assert_eq!(current.end_ms, 80_000);
}

#[test]
fn spectrum_music_playback_range_starts_from_requested_position_inside_track_bounds() {
    let mut current = track("a");
    current.start_ms = 20_000;
    current.end_ms = 80_000;

    assert_eq!(
        resolve_spectrum_music_playback_range(&current, Some(45_000)),
        Some(ActivePlaybackRange {
            start_ms: 45_000,
            end_ms: 80_000,
        }),
    );
}

#[test]
fn spectrum_music_playback_range_clamps_to_track_bounds() {
    let mut current = track("a");
    current.start_ms = 20_000;
    current.end_ms = 80_000;

    assert_eq!(
        resolve_spectrum_music_playback_range(&current, Some(90_000)),
        Some(ActivePlaybackRange {
            start_ms: 79_999,
            end_ms: 80_000,
        }),
    );
    assert_eq!(
        resolve_spectrum_music_playback_range(&current, None),
        Some(ActivePlaybackRange {
            start_ms: 20_000,
            end_ms: 80_000,
        }),
    );
}

#[test]
fn spectrum_music_playback_range_rejects_invalid_track_bounds() {
    let mut current = track("a");
    current.start_ms = 80_000;
    current.end_ms = 80_000;

    assert_eq!(resolve_spectrum_music_playback_range(&current, None), None);
}
