use super::model::{ActivePlaybackRange, PlaybackTrack};
use super::track_identity_substitution::{
    PlaybackTrackIdentityUpdate, plan_track_identity_substitution,
    resolve_active_playback_range_identity_update, resolve_active_request_track_identity_update,
    resolve_identity_update_playback_restart_position, resolve_session_track_identity_update,
};
use std::path::PathBuf;

fn track(name: &str) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: name.to_string(),
        canonical_music_id: format!("source:https://example.com/{name}:0:60000"),
        music_url: format!("https://example.com/{name}"),
        file_path: PathBuf::from(format!("{name}.m4a")),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
    }
}

fn identity_update() -> PlaybackTrackIdentityUpdate {
    PlaybackTrackIdentityUpdate {
        music_name: "A edited".to_string(),
        music_url: "https://example.com/a".to_string(),
        start_ms: 8_000,
        end_ms: 112_000,
        next_start_ms: 9_250,
        next_end_ms: 110_750,
    }
}

#[test]
fn session_identity_substitution_rewrites_only_the_indexed_range() {
    let mut current = track("a");
    current.start_ms = 8_000;
    current.end_ms = 112_000;
    let mut sibling = track("a");
    sibling.music_name = "A sibling".to_string();
    sibling.start_ms = 387_872;
    sibling.end_ms = 458_000;

    let updated = resolve_session_track_identity_update(&[current, sibling], &identity_update())
        .expect("matching session track should be updated");

    assert_eq!(updated[0].music_name, "A edited");
    assert_eq!(updated[0].start_ms, 9_250);
    assert_eq!(updated[0].end_ms, 110_750);
    assert_eq!(updated[1].music_name, "A sibling");
    assert_eq!(updated[1].start_ms, 387_872);
    assert_eq!(updated[1].end_ms, 458_000);
}

#[test]
fn session_identity_substitution_rejects_missing_identity_coordinate() {
    assert!(resolve_session_track_identity_update(&[track("b")], &identity_update()).is_none());
}

#[test]
fn active_request_identity_substitution_requires_the_full_old_coordinate() {
    let mut current = track("a");
    current.start_ms = 8_000;
    current.end_ms = 112_000;
    let mut sibling_range = current.clone();
    sibling_range.start_ms = 9_000;

    assert!(
        resolve_active_request_track_identity_update(Some(&current), &identity_update()).is_some()
    );
    assert!(
        resolve_active_request_track_identity_update(Some(&sibling_range), &identity_update())
            .is_none()
    );
}

#[test]
fn substitution_plan_declares_active_side_effects_only_for_the_active_identity() {
    let mut active = track("a");
    active.start_ms = 8_000;
    active.end_ms = 112_000;
    let inactive = track("b");

    let plan = plan_track_identity_substitution(
        &[active.clone(), inactive],
        Some(&active),
        Some(ActivePlaybackRange {
            start_ms: 25_000,
            end_ms: 112_000,
        }),
        &identity_update(),
    )
    .expect("active session track should produce a substitution plan");

    assert_eq!(plan.previous_tracks[0].start_ms, 8_000);
    assert_eq!(plan.next_tracks[0].start_ms, 9_250);
    assert_eq!(
        plan.next_active_request_track
            .as_ref()
            .map(|track| track.start_ms),
        Some(9_250),
    );
    assert_eq!(
        plan.next_active_playback_range,
        Some(ActivePlaybackRange {
            start_ms: 25_000,
            end_ms: 110_750,
        }),
    );
    assert!(plan.should_sync_active_playback_range);
    assert!(plan.should_clear_spectrum_playback_loop_signal);
}

#[test]
fn substitution_plan_keeps_active_runtime_coordinate_when_updated_track_is_not_active() {
    let mut updated = track("a");
    updated.start_ms = 8_000;
    updated.end_ms = 112_000;
    let active = track("b");

    let plan = plan_track_identity_substitution(
        &[updated, active.clone()],
        Some(&active),
        Some(ActivePlaybackRange {
            start_ms: 25_000,
            end_ms: 112_000,
        }),
        &identity_update(),
    )
    .expect("session track update should still produce a substitution plan");

    assert!(plan.next_active_request_track.is_none());
    assert!(!plan.should_sync_active_playback_range);
    assert!(!plan.should_clear_spectrum_playback_loop_signal);
}

#[test]
fn active_playback_range_substitution_rejects_invalid_next_range() {
    let update = PlaybackTrackIdentityUpdate {
        music_name: "A edited".to_string(),
        music_url: "https://example.com/a".to_string(),
        start_ms: 8_000,
        end_ms: 112_000,
        next_start_ms: 110_750,
        next_end_ms: 110_750,
    };

    assert_eq!(
        resolve_active_playback_range_identity_update(
            Some(ActivePlaybackRange {
                start_ms: 25_000,
                end_ms: 112_000,
            }),
            &update,
        ),
        None,
    );
}

#[test]
fn playback_restart_position_projects_into_the_committed_identity_range() {
    let mut current = track("a");
    current.start_ms = 45_000;
    current.end_ms = 90_000;

    assert_eq!(
        resolve_identity_update_playback_restart_position(20_000, &current),
        Some(45_000),
    );
    assert_eq!(
        resolve_identity_update_playback_restart_position(60_000, &current),
        Some(60_000),
    );
    assert_eq!(
        resolve_identity_update_playback_restart_position(100_000, &current),
        Some(89_999),
    );
}
