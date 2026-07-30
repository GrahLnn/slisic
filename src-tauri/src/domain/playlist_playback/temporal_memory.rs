use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const TEMPORAL_MEMORY_FSRS_DECAY: f32 = 0.5;
const TEMPORAL_MEMORY_TRACK_STABILITY_MS: u64 = 20 * 60 * 60 * 1_000;
const TEMPORAL_MEMORY_STABILITY_REPEAT_GAIN: f32 = 0.35;
const TEMPORAL_MEMORY_STABILITY_CAP_MS: u64 = 120 * 60 * 60 * 1_000;
const TEMPORAL_MEMORY_PRUNE_RETRIEVABILITY: f32 = 0.05;

/// Listener-owned temporal state.  It is intentionally keyed by the stable
/// music identity only: audio basin identifiers are model-generation-local and
/// must be reconstructed from the current embedding geometry during ranking.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct PlaylistPlaybackTemporalMemory {
    exposures: HashMap<String, PlaylistPlaybackTemporalExposure>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct PlaylistPlaybackTemporalExposure {
    pub(crate) last_played_at_ms: u64,
    pub(crate) stability_ms: u64,
}

impl PlaylistPlaybackTemporalMemory {
    pub(crate) fn observe(&mut self, canonical_music_id: &str, now_ms: u64) {
        if canonical_music_id.is_empty() {
            return;
        }

        let stability_ms = self
            .exposures
            .get(canonical_music_id)
            .map(|previous| {
                ((previous.stability_ms as f32 * (1.0 + TEMPORAL_MEMORY_STABILITY_REPEAT_GAIN))
                    .round() as u64)
                    .clamp(TEMPORAL_MEMORY_TRACK_STABILITY_MS, TEMPORAL_MEMORY_STABILITY_CAP_MS)
            })
            .unwrap_or(TEMPORAL_MEMORY_TRACK_STABILITY_MS);
        self.exposures.insert(
            canonical_music_id.to_string(),
            PlaylistPlaybackTemporalExposure {
                last_played_at_ms: now_ms,
                stability_ms,
            },
        );
    }

    pub(crate) fn retrievability_for(&self, canonical_music_id: &str, now_ms: u64) -> f32 {
        self.exposures
            .get(canonical_music_id)
            .map(|exposure| temporal_memory_retrievability(now_ms, *exposure))
            .unwrap_or(0.0)
    }

    pub(crate) fn active_exposures(
        &self,
        now_ms: u64,
    ) -> impl Iterator<Item = (&str, PlaylistPlaybackTemporalExposure)> {
        self.exposures.iter().filter_map(move |(music_id, exposure)| {
            (temporal_memory_retrievability(now_ms, *exposure)
                >= TEMPORAL_MEMORY_PRUNE_RETRIEVABILITY)
                .then_some((music_id.as_str(), *exposure))
        })
    }

    /// The caller supplies the current model's `music_id -> basin` projection.
    /// This deliberately prevents a persisted exposure from carrying a stale
    /// basin identifier across an audio-style model promotion.
    pub(crate) fn basin_retrievability<'a>(
        &self,
        candidate_basin: &str,
        now_ms: u64,
        current_basin_by_music_id: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> f32 {
        current_basin_by_music_id
            .into_iter()
            .filter_map(|(music_id, basin)| {
                (basin == candidate_basin).then(|| self.retrievability_for(music_id, now_ms))
            })
            .fold(0.0_f32, f32::max)
    }

    pub(crate) fn prune_expired(&mut self, now_ms: u64) {
        self.exposures.retain(|_, exposure| {
            temporal_memory_retrievability(now_ms, *exposure) >= TEMPORAL_MEMORY_PRUNE_RETRIEVABILITY
        });
    }
}

/// FSRS-6 forgetting curve in milliseconds.  Ranking uses this as a soft
/// anti-repetition signal: R=1 is maximally familiar, R=0 is fully released.
pub(crate) fn temporal_memory_retrievability(
    now_ms: u64,
    exposure: PlaylistPlaybackTemporalExposure,
) -> f32 {
    let elapsed_ms = now_ms.saturating_sub(exposure.last_played_at_ms) as f32;
    let stability_ms = exposure.stability_ms.max(1) as f32;
    let factor = 0.9_f32.powf(-1.0 / TEMPORAL_MEMORY_FSRS_DECAY) - 1.0;
    (1.0 + factor * elapsed_ms / stability_ms).powf(-TEMPORAL_MEMORY_FSRS_DECAY)
}
