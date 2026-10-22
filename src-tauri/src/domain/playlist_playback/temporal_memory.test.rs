use super::temporal_memory::{
    PlaylistPlaybackTemporalExposure, PlaylistPlaybackTemporalMemory,
    temporal_memory_retrievability,
};

const HOUR_MS: u64 = 60 * 60 * 1_000;

#[test]
fn coverage_is_soft_persistent_and_independent_of_expiring_familiarity() {
    let a = work_version_track("collection", "a", "source:a", 60_000);
    let b = work_version_track("collection", "b", "source:b", 60_000);
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe_track(&a, 0);
    assert_eq!(memory.coverage_weights([vec![&a], vec![&b]]), [0.25, 1.0]);
    memory.prune_expired(1_000_000 * HOUR_MS);
    let restored: PlaylistPlaybackTemporalMemory =
        serde_json::from_slice(&serde_json::to_vec(&memory).unwrap()).unwrap();
    assert_eq!(
        restored.retrievability_for_track(&a, 1_000_000 * HOUR_MS),
        0.0
    );
    assert_eq!(restored.coverage_weights([vec![&a], vec![&b]]), [0.25, 1.0]);
    memory.observe_track(&b, 1);
    assert_eq!(memory.coverage_weights([vec![&a], vec![&b]]), [1.0, 1.0]);
    for _ in 0..100 {
        memory.observe_track(&a, 1);
    }
    let weights = memory.coverage_weights([vec![&a], vec![&b]]);
    assert!(
        weights[0] > 0.0 && weights[0] < weights[1],
        "heard tracks remain eligible"
    );
}

#[test]
fn coverage_keeps_likes_recording_identity_and_alias_multiplicity_separate() {
    let a = work_version_track("collection", "a", "source:a", 60_000);
    let b = work_version_track("collection", "a", "source:b", 60_001);
    let mut liked = work_version_track("collection", "liked", "source:liked", 60_000);
    liked.liked = true;
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe_track(&a, 0);
    for _ in 0..20 {
        memory.observe_track(&liked, 0);
    }
    let before = memory.clone();
    assert_eq!(
        memory.coverage_weights([vec![&a], vec![&b], vec![&liked]]),
        [0.25, 1.0, 1.0]
    );
    assert_eq!(
        memory.coverage_weights([vec![&a, &a], vec![&b]]),
        [0.25, 1.0]
    );
    assert_eq!(before, memory, "projection cannot observe playback");
    let legacy: PlaylistPlaybackTemporalMemory =
        serde_json::from_str(r#"{"exposures":{},"work_exposures":{}}"#).unwrap();
    assert_eq!(legacy.coverage_weights([vec![&a], vec![&b]]), [1.0, 1.0]);
}

pub(super) fn work_version_track(
    collection_url: &str,
    name: &str,
    url: &str,
    end_ms: u32,
) -> crate::domain::player::model::PlaybackTrack {
    use crate::domain::player::model::PlaybackTrack;
    use crate::domain::playlists::model::{CollectionGroupOwner, Group, Music};
    use std::path::PathBuf;

    let music_id = format!("source:{url}:0:{end_ms}");
    PlaybackTrack {
        playlist_name: "All Msic".to_string(),
        music_name: name.to_string(),
        canonical_music_id: music_id.clone(),
        music_url: url.to_string(),
        file_path: PathBuf::from(format!("recordings/{end_ms}.m4a")),
        source_music: Some(Box::new(Music {
            occurrence_id: format!("occurrence:{url}"),
            name: name.to_string(),
            alias: name.to_string(),
            group: Group {
                name: format!("album:{end_ms}"),
                url: format!("{collection_url}/album/{end_ms}"),
                folder: format!("album-{end_ms}"),
                collection: CollectionGroupOwner {
                    name: collection_url.to_string(),
                    url: collection_url.to_string(),
                    folder: "collection".to_string(),
                    last_updated: "2026-10-16".to_string(),
                    enable_updates: Some(true),
                },
            },
            canonical_music_id: music_id,
            url: url.to_string(),
            path: Some(format!("{end_ms}.m4a")),
            start_ms: 0,
            end_ms,
            liked: false,
            loudness_profile: None,
        })),
        start_ms: 0,
        end_ms,
        liked: false,
        loudness_profile: None,
    }
}

#[test]
fn shared_work_fatigue_reaches_other_recordings_without_merging_identity() {
    // The two source/range identities witnessed eight minutes apart in the log.
    let live = work_version_track(
        "collection:daichi-releases",
        "Black Hole",
        "https://www.youtube.com/watch?v=8wov6_7CGkQ",
        286_680,
    );
    let studio = work_version_track(
        "collection:daichi-releases",
        "Black Hole",
        "https://www.youtube.com/watch?v=OTboGJlju84",
        234_493,
    );
    let identity_before = (
        studio.canonical_music_id.clone(),
        studio.music_url.clone(),
        studio.file_path.clone(),
        studio.start_ms,
        studio.end_ms,
    );
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe_track(&live, 0);
    let memory_before_query = memory.clone();

    let pressure = memory.retrievability_for_track(&studio, 8 * 60 * 1_000);
    assert!(
        pressure > 0.0 && pressure < 0.9,
        "an unplayed version needs soft pressure, never full familiarity; got {pressure}"
    );
    assert_eq!(
        memory.retrievability_for(&studio.canonical_music_id, 0),
        0.0
    );
    assert!(
        !memory
            .familiar_music_ids(0)
            .any(|id| id == studio.canonical_music_id)
    );
    assert_ne!(live.canonical_music_id, studio.canonical_music_id);
    assert_eq!(
        identity_before,
        (
            studio.canonical_music_id.clone(),
            studio.music_url.clone(),
            studio.file_path.clone(),
            studio.start_ms,
            studio.end_ms,
        )
    );
    assert_eq!(
        memory, memory_before_query,
        "projection must not observe another play"
    );
}

#[test]
fn shared_work_fatigue_is_scoped_and_ignores_display_aliases() {
    let live = work_version_track("artist:a", "Black Hole", "recording:live", 286_680);
    let mut studio = work_version_track("artist:a", "black  hole", "recording:studio", 234_493);
    studio.music_name = "My favourite song".to_string();
    studio.source_music.as_mut().unwrap().alias = "Custom display alias".to_string();
    let other_artist = work_version_track("artist:b", "Black Hole", "recording:other", 220_000);
    let other_work = work_version_track("artist:a", "FEVER", "recording:fever", 255_930);
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe_track(&live, 0);

    assert!(memory.retrievability_for_track(&studio, 1_000) > 0.0);
    assert_eq!(memory.retrievability_for_track(&other_artist, 1_000), 0.0);
    assert_eq!(memory.retrievability_for_track(&other_work, 1_000), 0.0);
}

#[test]
fn shared_work_fatigue_never_guesses_from_incomplete_source_metadata() {
    let live = work_version_track("artist:a", "Black Hole", "recording:live", 286_680);
    let studio = work_version_track("artist:a", "Black Hole", "recording:studio", 234_493);
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe_track(&live, 0);
    let mut missing_source = studio.clone();
    missing_source.source_music = None;
    let mut missing_owner = studio.clone();
    missing_owner
        .source_music
        .as_mut()
        .unwrap()
        .group
        .collection
        .url
        .clear();
    let mut missing_name = studio.clone();
    missing_name.source_music.as_mut().unwrap().name.clear();
    for incomplete in [missing_source, missing_owner, missing_name] {
        assert_eq!(memory.retrievability_for_track(&incomplete, 0), 0.0);
    }
    let mut exact_without_metadata = live;
    exact_without_metadata.source_music = None;
    assert_eq!(
        memory.retrievability_for_track(&exact_without_metadata, 0),
        1.0
    );
}

#[test]
fn shared_work_fatigue_decays_and_keeps_alias_evidence_idempotent() {
    let live = work_version_track("artist:a", "Black Hole", "recording:live", 286_680);
    let mut studio = work_version_track("artist:a", "Black Hole", "recording:studio", 234_493);
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe_track(&live, 0);
    let fresh = memory.retrievability_for_track(&studio, 0);
    let later = memory.retrievability_for_track(&studio, 20 * HOUR_MS);
    assert!(fresh > later && later > 0.0);
    assert!(fresh < 0.9 && (1.0 - fresh) > 0.0);

    studio.source_music.as_mut().unwrap().canonical_music_id = live.canonical_music_id.clone();
    assert_eq!(
        memory.retrievability_for_track(&studio, 0),
        1.0,
        "a duplicate exact alias joins by max rather than adding work pressure"
    );
    studio.source_music.as_mut().unwrap().canonical_music_id = studio.canonical_music_id.clone();
    studio.liked = true;
    studio.source_music.as_mut().unwrap().liked = true;
    assert_eq!(memory.retrievability_for_track(&studio, 0), fresh);
    assert!(studio.liked && studio.source_music.as_ref().unwrap().liked);

    memory.prune_expired(100_000 * HOUR_MS);
    assert_eq!(
        memory.retrievability_for_track(&studio, 100_000 * HOUR_MS),
        0.0
    );
}

#[test]
fn shared_work_fatigue_for_independent_works_commutes_and_old_memory_still_decodes() {
    let first = work_version_track("artist:a", "Black Hole", "recording:first", 286_680);
    let second = work_version_track("artist:b", "FEVER", "recording:second", 255_930);
    let mut forward = PlaylistPlaybackTemporalMemory::default();
    forward.observe_track(&first, 1_000);
    forward.observe_track(&second, 1_000);
    let mut reverse = PlaylistPlaybackTemporalMemory::default();
    reverse.observe_track(&second, 1_000);
    reverse.observe_track(&first, 1_000);
    assert_eq!(forward, reverse);
    let old: PlaylistPlaybackTemporalMemory = serde_json::from_value(serde_json::json!({
        "exposures": {"recording:old": {"last_played_at_ms": 0, "stability_ms": 72_000_000}}
    }))
    .expect("recording-only memory should remain readable");
    assert_eq!(old.retrievability_for("recording:old", 0), 1.0);
    let round_trip: PlaylistPlaybackTemporalMemory =
        serde_json::from_str(&serde_json::to_string(&forward).unwrap()).unwrap();
    assert_eq!(forward, round_trip);
}

#[test]
fn shared_work_fatigue_accumulates_real_listening_across_versions() {
    let first = work_version_track("artist:a", "FEVER", "recording:2015", 255_930);
    let second = work_version_track("artist:a", "FEVER", "recording:2019", 289_667);
    let unplayed = work_version_track("artist:a", "FEVER", "recording:2020", 274_920);
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe_track(&first, 0);
    let once = memory.retrievability_for_track(&unplayed, 20 * HOUR_MS);
    memory.observe_track(&second, HOUR_MS);
    let twice = memory.retrievability_for_track(&unplayed, 21 * HOUR_MS);
    assert!(twice > once && twice < 0.9);
    assert_eq!(
        memory.retrievability_for(&unplayed.canonical_music_id, 0),
        0.0
    );
}

#[test]
fn temporal_memory_is_fully_familiar_at_playback_and_ninety_percent_at_stability() {
    let exposure = PlaylistPlaybackTemporalExposure {
        last_played_at_ms: 10,
        stability_ms: 20 * HOUR_MS,
    };

    assert!((temporal_memory_retrievability(10, exposure) - 1.0).abs() < 1.0e-6);
    assert!(
        (temporal_memory_retrievability(10 + exposure.stability_ms, exposure) - 0.9).abs() < 1.0e-6
    );
}

#[test]
fn repeated_track_exposure_extends_its_soft_cooldown() {
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe("source:one:0:60000", 0);
    let initial = memory.retrievability_for("source:one:0:60000", 20 * HOUR_MS);

    memory.observe("source:one:0:60000", HOUR_MS);
    let repeated = memory.retrievability_for("source:one:0:60000", 21 * HOUR_MS);

    assert!(repeated > initial);
}

#[test]
fn familiar_music_ids_follow_the_fsrs_target_retention() {
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe("source:familiar:0:60000", 0);

    let familiar = memory
        .familiar_music_ids(20 * HOUR_MS)
        .map(str::to_string)
        .collect::<Vec<_>>();

    assert!(familiar.iter().any(|id| id == "source:familiar:0:60000"));

    memory.observe("source:released:0:60000", 0);
    let released = memory
        .familiar_music_ids(100 * HOUR_MS)
        .map(str::to_string)
        .collect::<Vec<_>>();
    assert!(!released.iter().any(|id| id == "source:released:0:60000"));
}

#[test]
fn expired_exposure_is_pruned_without_affecting_recent_memory() {
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe("source:old:0:60000", 0);
    const MUCH_LATER_MS: u64 = 100_000 * HOUR_MS;
    memory.observe("source:recent:0:60000", MUCH_LATER_MS);

    memory.prune_expired(MUCH_LATER_MS);

    assert_eq!(
        memory.retrievability_for("source:old:0:60000", MUCH_LATER_MS),
        0.0
    );
    assert!(memory.retrievability_for("source:recent:0:60000", MUCH_LATER_MS) > 0.99);
}

#[test]
fn basin_pressure_is_rebuilt_from_the_current_model_projection() {
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe("source:one:0:60000", 0);
    let old_model = [
        ("source:one:0:60000", "old"),
        ("source:two:0:60000", "other"),
    ];
    let promoted_model = [
        ("source:one:0:60000", "new"),
        ("source:two:0:60000", "other"),
    ];

    assert!(memory.basin_retrievability("old", HOUR_MS, old_model) > 0.9);
    assert_eq!(
        memory.basin_retrievability("old", HOUR_MS, promoted_model),
        0.0
    );
    assert!(memory.basin_retrievability("new", HOUR_MS, promoted_model) > 0.9);
}
