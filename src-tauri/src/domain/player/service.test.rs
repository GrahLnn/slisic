use super::model::{
    ActivePlaybackRange, PlaybackTrack, PlaybackTrackPayload, PlaybackTrackProjectionError,
};
use super::service::{
    BACKEND_PLAYBACK_TARGET_LUFS, PlaybackRangeCompletion, PlaybackRangeCompletionPlaybackAction,
    PlaybackStartRequestRegistry, PlaybackTrackLikedUpdate, SpectrumPlaybackScope,
    are_playback_tracks_equal, backend_playback_normalization, playback_loudness_plan_for_profile,
    playback_normalization_for_track_loudness_profile, playback_request_for_track_range,
    playback_tracks_match, resolve_active_request_track_liked_update,
    resolve_identity_update_active_playback_range, resolve_plain_playback_status_completion,
    resolve_playback_absolute_position_ms, resolve_playback_clock_position_ms,
    resolve_playback_completion_playback_action, resolve_playback_range_completion,
    resolve_playback_range_deadline_ms, resolve_playback_request_position,
    resolve_playback_seek_pause_after_request, resolve_playback_seek_range,
    resolve_playback_status_track_identity, resolve_repeated_playback_range_override,
    resolve_session_track_liked_update, resolve_spectrum_loop_playback_range,
    resolve_spectrum_loop_signal_active_range, resolve_spectrum_loop_signal_seek_position,
    resolve_spectrum_music_playback_range, resolve_spectrum_playback_loop_signal,
    should_accept_spectrum_playback_signal, should_commit_spectrum_playback_scope_exit,
    should_resume_playback_seek_cancel,
};
use super::track_identity_substitution::{
    PlaybackTrackIdentityUpdate, resolve_active_request_track_identity_update,
    resolve_session_track_identity_update,
};
use crate::domain::playlists::model::{CollectionGroupOwner, Group, LoudnessProfile, Music};
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
        loudness_profile: None,
    }
}

fn track_payload(name: &str) -> PlaybackTrackPayload {
    PlaybackTrackPayload {
        playlist_name: "Focus".to_string(),
        music_name: name.to_string(),
        canonical_music_id: format!("source:https://example.com/{name}:0:60000"),
        music_url: format!("https://example.com/{name}"),
        file_path: format!("{name}.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        liked: false,
        loudness_profile: None,
    }
}

fn scope(id: u64) -> SpectrumPlaybackScope {
    SpectrumPlaybackScope { id }
}

#[test]
fn backend_playback_normalization_targets_negative_eighteen_lufs() {
    let normalization = backend_playback_normalization();

    assert_eq!(BACKEND_PLAYBACK_TARGET_LUFS, -18.0);
    assert_eq!(normalization.target_lufs, -18.0);
    assert_eq!(normalization.integrated_lufs, None);
    assert_eq!(normalization.true_peak_dbtp, None);
}

#[test]
fn playback_normalization_requires_loudness_evidence() {
    assert_eq!(
        playback_normalization_for_track_loudness_profile(None),
        None
    );

    let normalization = playback_normalization_for_track_loudness_profile(
        LoudnessProfile::from_integrated_lufs(-24.0).as_ref(),
    )
    .expect("non-zero LUFS profile is evidence");

    assert_eq!(normalization.target_lufs, BACKEND_PLAYBACK_TARGET_LUFS);
    assert_eq!(normalization.integrated_lufs, Some(-24.0));
    assert_eq!(normalization.true_peak_dbtp, None);
}

#[test]
fn loudness_profile_correction_penalizes_dense_low_lra_tracks_without_punishing_dynamic_tracks() {
    let dark_shadows = LoudnessProfile {
        integrated_lufs: -7.580,
        true_peak_dbtp: Some(1.550),
        lra: Some(3.300),
        short_lufs_p50: Some(-7.800),
        short_lufs_p80: Some(-6.700),
        short_lufs_p95: Some(-5.900),
        short_lufs_max: Some(-5.600),
        presence_db: Some(-6.946),
        model_adjustment_db: None,
    };
    let parade = LoudnessProfile {
        integrated_lufs: -10.420,
        true_peak_dbtp: Some(0.570),
        lra: Some(19.100),
        short_lufs_p50: Some(-12.400),
        short_lufs_p80: Some(-8.800),
        short_lufs_p95: Some(-7.900),
        short_lufs_max: Some(-7.500),
        presence_db: Some(-9.543),
        model_adjustment_db: None,
    };

    let dark_plan =
        playback_loudness_plan_for_profile(&dark_shadows).expect("valid profile should plan");
    let parade_plan =
        playback_loudness_plan_for_profile(&parade).expect("valid profile should plan");

    assert!(dark_plan.lra_correction_db < parade_plan.lra_correction_db);
    assert_eq!(parade_plan.lra_correction_db, 0.0);
    assert!(
        parade_plan.final_gain_db > dark_plan.final_gain_db,
        "a quieter integrated dynamic track should still receive more gain than a dense low-LRA track"
    );
}

#[test]
fn loudness_profile_correction_uses_upper_body_loudness_not_integrated_loudness_only() {
    let underground = LoudnessProfile {
        integrated_lufs: -16.700,
        true_peak_dbtp: Some(-0.450),
        lra: Some(5.300),
        short_lufs_p50: Some(-17.000),
        short_lufs_p80: Some(-15.700),
        short_lufs_p95: Some(-14.600),
        short_lufs_max: Some(-13.900),
        presence_db: Some(-8.300),
        model_adjustment_db: None,
    };
    let caelestinum = LoudnessProfile {
        integrated_lufs: -12.630,
        true_peak_dbtp: Some(-0.170),
        lra: Some(11.000),
        short_lufs_p50: Some(-13.400),
        short_lufs_p80: Some(-11.000),
        short_lufs_p95: Some(-9.600),
        short_lufs_max: Some(-8.700),
        presence_db: Some(-8.404),
        model_adjustment_db: None,
    };

    let underground_plan =
        playback_loudness_plan_for_profile(&underground).expect("valid profile should plan");
    let caelestinum_plan =
        playback_loudness_plan_for_profile(&caelestinum).expect("valid profile should plan");

    assert!(
        caelestinum_plan.short_term_correction_db < underground_plan.short_term_correction_db,
        "a track with a hotter upper short-term body should receive less gain even when integrated LUFS is quieter"
    );
}

#[test]
fn loudness_profile_correction_unifies_kirisame_and_to_the_wilder_upper_body() {
    let kirisame = LoudnessProfile {
        integrated_lufs: -7.590,
        true_peak_dbtp: Some(2.540),
        lra: Some(5.000),
        short_lufs_p50: Some(-7.600),
        short_lufs_p80: Some(-6.700),
        short_lufs_p95: Some(-6.000),
        short_lufs_max: Some(-5.700),
        presence_db: Some(-6.651),
        model_adjustment_db: None,
    };
    let to_the_wilder = LoudnessProfile {
        integrated_lufs: -8.900,
        true_peak_dbtp: Some(0.980),
        lra: Some(11.200),
        short_lufs_p50: Some(-9.900),
        short_lufs_p80: Some(-6.900),
        short_lufs_p95: Some(-6.100),
        short_lufs_max: Some(-5.500),
        presence_db: Some(-9.056),
        model_adjustment_db: None,
    };

    let kirisame_plan =
        playback_loudness_plan_for_profile(&kirisame).expect("valid profile should plan");
    let wilder_plan =
        playback_loudness_plan_for_profile(&to_the_wilder).expect("valid profile should plan");

    let kirisame_post_p80 = kirisame
        .short_lufs_p80
        .expect("test profile should include p80")
        + kirisame_plan.final_gain_db;
    let wilder_post_p80 = to_the_wilder
        .short_lufs_p80
        .expect("test profile should include p80")
        + wilder_plan.final_gain_db;
    let kirisame_post_p95 = kirisame
        .short_lufs_p95
        .expect("test profile should include p95")
        + kirisame_plan.final_gain_db;
    let wilder_post_p95 = to_the_wilder
        .short_lufs_p95
        .expect("test profile should include p95")
        + wilder_plan.final_gain_db;

    assert!((kirisame_post_p80 - wilder_post_p80).abs() < 1.0);
    assert!((kirisame_post_p95 - wilder_post_p95).abs() < 1.0);
    assert!(
        wilder_plan.final_gain_db < -10.0,
        "the dynamic Woodkid track should be normalized from its upper body, not left near integrated-only gain"
    );
}

#[test]
fn loudness_profile_correction_does_not_boost_present_dynamic_chapter() {
    let hanachirusato = LoudnessProfile {
        integrated_lufs: -21.490,
        true_peak_dbtp: Some(-3.160),
        lra: Some(14.800),
        short_lufs_p50: Some(-23.200),
        short_lufs_p80: Some(-20.700),
        short_lufs_p95: Some(-17.600),
        short_lufs_max: Some(-15.700),
        presence_db: Some(-8.371),
        model_adjustment_db: None,
    };

    let plan =
        playback_loudness_plan_for_profile(&hanachirusato).expect("valid profile should plan");

    assert!(
        plan.presence_correction_db < 0.0,
        "present foreground energy should not be treated as a reason to boost playback gain"
    );
    assert!(
        plan.final_gain_db < plan.base_gain_db,
        "a dynamic chapter whose body and presence are already audible should not exceed integrated-only gain"
    );
}

#[test]
fn playback_start_request_registry_accepts_only_the_latest_claim() {
    let registry = PlaybackStartRequestRegistry::default();

    let first = registry.claim();
    assert!(registry.is_current(&first));

    let second = registry.claim();
    assert!(!registry.is_current(&first));
    assert!(registry.is_current(&second));

    registry.cancel_pending();
    assert!(!registry.is_current(&second));
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
fn resolve_session_track_liked_update_changes_only_liked_field() {
    let mut current = track("a");
    current.music_name = "Spectrum Accepted Title".to_string();
    current.start_ms = 9_250;
    current.end_ms = 110_750;
    current.source_music = Some(Box::new(Music {
        occurrence_id: "occurrence-a".to_string(),
        name: "Original Title".to_string(),
        alias: "Spectrum Accepted Title".to_string(),
        group: Group {
            name: "Disc 1".to_string(),
            url: "https://example.com/a#disc-1".to_string(),
            collection: CollectionGroupOwner {
                name: "Example".to_string(),
                url: "https://example.com/a".to_string(),
                folder: "youtube/example".to_string(),
                last_updated: "2026-06-08T00:00:00+00:00".to_string(),
                enable_updates: Some(false),
            },
            folder: "Disc 1".to_string(),
        },
        url: current.music_url.clone(),
        path: Some(current.file_path.to_string_lossy().to_string()),
        start_ms: current.start_ms,
        end_ms: current.end_ms,
        canonical_music_id: current.canonical_music_id.clone(),
        liked: false,
        loudness_profile: None,
    }));
    let other = track("b");

    let updated = resolve_session_track_liked_update(
        &[current.clone(), other.clone()],
        &PlaybackTrackLikedUpdate {
            canonical_music_id: current.canonical_music_id.clone(),
            liked: true,
        },
    )
    .expect("matching track liked field should update");

    assert_eq!(updated[0].music_name, "Spectrum Accepted Title");
    assert_eq!(updated[0].music_url, current.music_url);
    assert_eq!(updated[0].start_ms, 9_250);
    assert_eq!(updated[0].end_ms, 110_750);
    assert!(updated[0].liked);
    assert_eq!(
        updated[0]
            .source_music
            .as_ref()
            .map(|music| music.alias.as_str()),
        Some("Spectrum Accepted Title"),
    );
    assert_eq!(
        updated[0]
            .source_music
            .as_ref()
            .map(|music| music.name.as_str()),
        Some("Original Title"),
    );
    assert!(
        updated[0]
            .source_music
            .as_ref()
            .is_some_and(|music| music.liked)
    );
    assert_eq!(updated[1].canonical_music_id, other.canonical_music_id);
    assert_eq!(updated[1].music_name, other.music_name);
    assert_eq!(updated[1].liked, other.liked);
}

#[test]
fn resolve_active_request_track_liked_update_ignores_unrelated_identity() {
    let current = track("a");

    let updated = resolve_active_request_track_liked_update(
        Some(&current),
        &PlaybackTrackLikedUpdate {
            canonical_music_id: "source:https://example.com/b:0:60000".to_string(),
            liked: true,
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
fn spectrum_repeat_range_override_applies_only_to_the_same_original_music() {
    let mut current = track("a");
    current.start_ms = 20_000;
    current.end_ms = 80_000;
    let range_override = super::service::SpectrumPlaybackLoopSignal {
        scope: scope(1),
        file_path: PathBuf::from("a.m4a"),
        music_url: "https://example.com/a".to_string(),
        playlist_name: "Focus".to_string(),
        track_start_ms: 20_000,
        track_end_ms: 80_000,
        range: ActivePlaybackRange {
            start_ms: 25_000,
            end_ms: 45_000,
        },
    };

    assert_eq!(
        resolve_repeated_playback_range_override(&current, range_override.clone()),
        Some(ActivePlaybackRange {
            start_ms: 25_000,
            end_ms: 45_000,
        }),
    );

    let mut other_region = current.clone();
    other_region.start_ms = 30_000;
    other_region.end_ms = 90_000;
    assert_eq!(
        resolve_repeated_playback_range_override(&other_region, range_override.clone()),
        None,
    );

    let mut other_music = current.clone();
    other_music.music_url = "https://example.com/b".to_string();
    assert_eq!(
        resolve_repeated_playback_range_override(&other_music, range_override),
        None,
    );
}

#[test]
fn spectrum_playback_loop_signal_keeps_source_identity_separate_from_loop_points() {
    let mut current = track("a");
    current.start_ms = 20_000;
    current.end_ms = 80_000;

    let signal = resolve_spectrum_playback_loop_signal(scope(1), &current, 25_000, 45_000)
        .expect("valid loop points should project");

    assert_eq!(signal.track_start_ms, 20_000);
    assert_eq!(signal.track_end_ms, 80_000);
    assert_eq!(
        signal.range,
        ActivePlaybackRange {
            start_ms: 25_000,
            end_ms: 45_000,
        },
    );
    assert_eq!(
        resolve_repeated_playback_range_override(&current, signal),
        Some(ActivePlaybackRange {
            start_ms: 25_000,
            end_ms: 45_000,
        }),
    );
}

#[test]
fn spectrum_loop_signal_only_drives_looping_inside_its_active_scope() {
    let mut current = track("a");
    current.start_ms = 20_000;
    current.end_ms = 80_000;
    let signal = resolve_spectrum_playback_loop_signal(scope(1), &current, 25_000, 45_000)
        .expect("valid loop points should project");

    assert_eq!(
        resolve_spectrum_loop_playback_range(None, &current, Some(signal.clone())),
        None,
    );
    assert_eq!(
        resolve_spectrum_loop_playback_range(Some(scope(2)), &current, Some(signal)),
        None,
    );

    let signal = resolve_spectrum_playback_loop_signal(scope(1), &current, 25_000, 45_000)
        .expect("valid loop points should project");
    assert_eq!(
        resolve_spectrum_loop_playback_range(Some(scope(1)), &current, Some(signal),),
        Some(ActivePlaybackRange {
            start_ms: 25_000,
            end_ms: 45_000,
        }),
    );
}

#[test]
fn spectrum_loop_signal_updates_are_accepted_only_while_spectrum_mode_is_active() {
    assert!(!should_accept_spectrum_playback_signal(None, scope(1),));
    assert!(should_accept_spectrum_playback_signal(
        Some(scope(1)),
        scope(1),
    ));
    assert!(!should_accept_spectrum_playback_signal(
        Some(scope(2)),
        scope(1),
    ));
}

#[test]
fn spectrum_loop_signal_scope_is_independent_from_playback_continuation_policy() {
    let mut current = track("a");
    current.start_ms = 20_000;
    current.end_ms = 80_000;
    let signal = resolve_spectrum_playback_loop_signal(scope(1), &current, 25_000, 45_000)
        .expect("valid loop points should project");

    assert_eq!(
        resolve_spectrum_loop_playback_range(Some(scope(1)), &current, Some(signal)),
        Some(ActivePlaybackRange {
            start_ms: 25_000,
            end_ms: 45_000,
        }),
    );
}

#[test]
fn spectrum_scope_exit_only_commits_for_the_current_scope() {
    assert!(should_commit_spectrum_playback_scope_exit(
        Some(scope(1)),
        scope(1),
    ));
    assert!(!should_commit_spectrum_playback_scope_exit(
        Some(scope(2)),
        scope(1),
    ));
    assert!(!should_commit_spectrum_playback_scope_exit(None, scope(1)));
}

#[test]
fn playback_range_completion_finishes_random_playback_after_open_ended_spectrum_request() {
    let active_range = ActivePlaybackRange {
        start_ms: 20_000,
        end_ms: 80_000,
    };
    let loop_range = ActivePlaybackRange {
        start_ms: 25_000,
        end_ms: 45_000,
    };

    assert_eq!(
        resolve_playback_range_completion(44_999, active_range, Some(loop_range)),
        PlaybackRangeCompletion::Continue,
    );
    assert_eq!(
        resolve_playback_range_completion(45_000, active_range, Some(loop_range)),
        PlaybackRangeCompletion::Repeat(loop_range),
    );
    assert_eq!(
        resolve_playback_range_completion(79_999, active_range, None),
        PlaybackRangeCompletion::Continue,
    );
    assert_eq!(
        resolve_playback_range_completion(80_000, active_range, None),
        PlaybackRangeCompletion::Finish,
    );
}

#[test]
fn playback_range_completion_stops_finished_range_but_keeps_loop_running() {
    let loop_range = ActivePlaybackRange {
        start_ms: 25_000,
        end_ms: 45_000,
    };

    assert_eq!(
        resolve_playback_completion_playback_action(PlaybackRangeCompletion::Continue),
        PlaybackRangeCompletionPlaybackAction::KeepRunning,
    );
    assert_eq!(
        resolve_playback_completion_playback_action(PlaybackRangeCompletion::Repeat(loop_range)),
        PlaybackRangeCompletionPlaybackAction::KeepRunning,
    );
    assert_eq!(
        resolve_playback_completion_playback_action(PlaybackRangeCompletion::Finish),
        PlaybackRangeCompletionPlaybackAction::StopCompletedRange,
    );
}

#[test]
fn plain_playback_completion_uses_player_position_not_wall_clock() {
    let active_range = ActivePlaybackRange {
        start_ms: 156_000,
        end_ms: 241_000,
    };
    let status = ffplayr::AudioStatus {
        duration_ms: Some(5_000_000),
        path: Some("album.m4a".to_string()),
        paused: false,
        playing: true,
        position_ms: 7_000,
    };

    assert_eq!(
        resolve_plain_playback_status_completion(&status, active_range),
        (PlaybackRangeCompletion::Continue, 163_000),
    );

    let status = ffplayr::AudioStatus {
        position_ms: 85_000,
        ..status
    };

    assert_eq!(
        resolve_plain_playback_status_completion(&status, active_range),
        (PlaybackRangeCompletion::Finish, 241_000),
    );
}

#[test]
fn identity_update_active_range_uses_trimmed_end_as_the_player_deadline() {
    let mut next_track = track("a");
    next_track.start_ms = 0;
    next_track.end_ms = 240_000;
    let active_range = ActivePlaybackRange {
        start_ms: 0,
        end_ms: 300_000,
    };

    let updated = resolve_identity_update_active_playback_range(Some(active_range), &next_track);

    assert_eq!(
        updated,
        ActivePlaybackRange {
            start_ms: 0,
            end_ms: 240_000,
        },
        "tail trim must replace the active player deadline, not only the persisted track identity"
    );
    assert_eq!(
        resolve_playback_range_completion(239_999, updated, None),
        PlaybackRangeCompletion::Continue,
    );
    assert_eq!(
        resolve_playback_range_completion(240_000, updated, None),
        PlaybackRangeCompletion::Finish,
    );
}

#[test]
fn identity_update_active_range_finishes_when_trim_passed_the_current_position() {
    let mut next_track = track("a");
    next_track.start_ms = 0;
    next_track.end_ms = 240_000;
    let active_range = ActivePlaybackRange {
        start_ms: 0,
        end_ms: 300_000,
    };

    let updated = resolve_identity_update_active_playback_range(Some(active_range), &next_track);

    assert_eq!(
        resolve_playback_range_completion(250_000, updated, None),
        PlaybackRangeCompletion::Finish,
        "a late trim result must close the current range immediately once playback is already past the new end"
    );
}

#[test]
fn playback_clock_advances_between_player_status_samples() {
    assert_eq!(
        resolve_playback_clock_position_ms(156_000, 7_000, true),
        163_000
    );
    assert_eq!(
        resolve_playback_clock_position_ms(156_000, 30_000, false),
        156_000,
        "paused playback keeps the current request clock anchored"
    );
}

#[test]
fn playback_range_deadline_uses_the_current_request_boundary() {
    let active_range = ActivePlaybackRange {
        start_ms: 2_924_000,
        end_ms: 2_983_000,
    };

    assert_eq!(
        resolve_playback_range_deadline_ms(2_924_000, active_range, None, true, false),
        Some(59_000)
    );
    assert_eq!(
        resolve_playback_range_deadline_ms(2_983_000, active_range, None, true, false),
        Some(0)
    );
    assert_eq!(
        resolve_playback_range_deadline_ms(2_940_000, active_range, None, false, false),
        None,
        "stopped playback must wait for fresh status instead of consuming a wall-clock deadline"
    );
    assert_eq!(
        resolve_playback_range_deadline_ms(2_940_000, active_range, None, true, true),
        None,
        "paused playback must not consume the current track deadline"
    );
}

#[test]
fn playback_range_deadline_uses_spectrum_loop_boundary_when_present() {
    let active_range = ActivePlaybackRange {
        start_ms: 20_000,
        end_ms: 80_000,
    };
    let loop_range = ActivePlaybackRange {
        start_ms: 25_000,
        end_ms: 45_000,
    };

    assert_eq!(
        resolve_playback_range_deadline_ms(40_000, active_range, Some(loop_range), true, false),
        Some(5_000)
    );
}

#[test]
fn spectrum_loop_signal_seek_position_repairs_positions_outside_range() {
    let range = ActivePlaybackRange {
        start_ms: 25_000,
        end_ms: 45_000,
    };

    assert_eq!(
        resolve_spectrum_loop_signal_seek_position(24_999, range),
        Some(25_000),
    );
    assert_eq!(
        resolve_spectrum_loop_signal_seek_position(25_000, range),
        None
    );
    assert_eq!(
        resolve_spectrum_loop_signal_seek_position(44_999, range),
        None
    );
    assert_eq!(
        resolve_spectrum_loop_signal_seek_position(45_000, range),
        Some(44_999),
    );
    assert_eq!(
        resolve_spectrum_loop_signal_seek_position(50_000, range),
        Some(44_999),
    );
}

#[test]
fn spectrum_loop_signal_active_range_preserves_current_request_start() {
    assert_eq!(
        resolve_spectrum_loop_signal_active_range(
            Some(ActivePlaybackRange {
                start_ms: 36_000,
                end_ms: 45_000,
            }),
            ActivePlaybackRange {
                start_ms: 25_000,
                end_ms: 60_000,
            },
        ),
        ActivePlaybackRange {
            start_ms: 36_000,
            end_ms: 60_000,
        },
    );
}

#[test]
fn spectrum_loop_signal_rejects_invalid_range() {
    let current = track("a");

    assert_eq!(
        resolve_spectrum_playback_loop_signal(scope(1), &current, 45_000, 45_000),
        None,
    );
}

#[test]
fn playback_absolute_position_uses_active_range_origin() {
    let status = ffplayr::AudioStatus {
        duration_ms: Some(60_000),
        path: Some("a.m4a".to_string()),
        paused: false,
        playing: true,
        position_ms: 1_250,
    };

    assert_eq!(
        resolve_playback_absolute_position_ms(
            &status,
            Some(ActivePlaybackRange {
                start_ms: 20_000,
                end_ms: 45_000,
            }),
        ),
        21_250,
    );
    assert_eq!(resolve_playback_absolute_position_ms(&status, None), 1_250);
}

#[test]
fn playback_request_position_ignores_range_end_signal() {
    assert_eq!(
        resolve_playback_request_position(ActivePlaybackRange {
            start_ms: 25_000,
            end_ms: 45_000,
        }),
        25_000,
    );
    assert_eq!(
        resolve_playback_request_position(ActivePlaybackRange {
            start_ms: 25_000,
            end_ms: 120_000,
        }),
        25_000,
    );
}

#[test]
fn playback_track_identity_change_requires_an_explicit_active_range_substitution() {
    let mut old = track("a");
    old.start_ms = 20_000;
    old.end_ms = 80_000;
    let mut draft = old.clone();
    draft.start_ms = 25_000;
    draft.end_ms = 45_000;

    assert!(!are_playback_tracks_equal(&old, &draft));
    assert_eq!(
        resolve_identity_update_active_playback_range(
            Some(ActivePlaybackRange {
                start_ms: old.start_ms,
                end_ms: old.end_ms,
            }),
            &draft,
        ),
        ActivePlaybackRange {
            start_ms: 20_000,
            end_ms: 45_000,
        },
        "track identity substitution updates metadata; the player runtime must explicitly substitute its active finish boundary"
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

#[test]
fn playback_request_for_track_range_keeps_end_out_of_engine_time_range() {
    let mut current = track("a");
    current.start_ms = 1_863_000;
    current.end_ms = 1_898_000;

    let request = playback_request_for_track_range(
        &current,
        ActivePlaybackRange {
            start_ms: current.start_ms,
            end_ms: current.end_ms,
        },
    );

    assert_eq!(request.path, current.file_path);
    assert_eq!(
        request.time_range,
        Some(ffplayr::PlaybackTimeRange {
            start_ms: 1_863_000,
            duration_ms: None,
        }),
    );
}
