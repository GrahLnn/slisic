use super::temporal_memory::{
    PlaylistPlaybackTemporalExposure, PlaylistPlaybackTemporalMemory,
    temporal_memory_retrievability,
};

const HOUR_MS: u64 = 60 * 60 * 1_000;

#[test]
fn temporal_memory_is_fully_familiar_at_playback_and_ninety_percent_at_stability() {
    let exposure = PlaylistPlaybackTemporalExposure {
        last_played_at_ms: 10,
        stability_ms: 20 * HOUR_MS,
    };

    assert!((temporal_memory_retrievability(10, exposure) - 1.0).abs() < 1.0e-6);
    assert!(
        (temporal_memory_retrievability(10 + exposure.stability_ms, exposure) - 0.9).abs()
            < 1.0e-6
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
fn expired_exposure_is_pruned_without_affecting_recent_memory() {
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe("source:old:0:60000", 0);
    const MUCH_LATER_MS: u64 = 100_000 * HOUR_MS;
    memory.observe("source:recent:0:60000", MUCH_LATER_MS);

    memory.prune_expired(MUCH_LATER_MS);

    assert_eq!(memory.retrievability_for("source:old:0:60000", MUCH_LATER_MS), 0.0);
    assert!(memory.retrievability_for("source:recent:0:60000", MUCH_LATER_MS) > 0.99);
}

#[test]
fn basin_pressure_is_rebuilt_from_the_current_model_projection() {
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe("source:one:0:60000", 0);
    let old_model = [("source:one:0:60000", "old"), ("source:two:0:60000", "other")];
    let promoted_model = [("source:one:0:60000", "new"), ("source:two:0:60000", "other")];

    assert!(memory.basin_retrievability("old", HOUR_MS, old_model) > 0.9);
    assert_eq!(memory.basin_retrievability("old", HOUR_MS, promoted_model), 0.0);
    assert!(memory.basin_retrievability("new", HOUR_MS, promoted_model) > 0.9);
}
