use crate::domain::player::model::PlaybackTrack;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const TEMPORAL_MEMORY_FSRS_DECAY: f32 = 0.5;
const TEMPORAL_MEMORY_TRACK_STABILITY_MS: u64 = 20 * 60 * 60 * 1_000;
const TEMPORAL_MEMORY_STABILITY_REPEAT_GAIN: f32 = 0.35;
const TEMPORAL_MEMORY_STABILITY_CAP_MS: u64 = 120 * 60 * 60 * 1_000;
const TEMPORAL_MEMORY_PRUNE_RETRIEVABILITY: f32 = 0.05;
// FSRS's default target retention; this is a memory semantic, not a model knob.
const TEMPORAL_MEMORY_TARGET_RETENTION: f32 = 0.9;

/// Listener-owned temporal state. It is keyed by stable music identity so
/// model-generation-local basin identifiers never leak across promotions.
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
                    .clamp(
                        TEMPORAL_MEMORY_TRACK_STABILITY_MS,
                        TEMPORAL_MEMORY_STABILITY_CAP_MS,
                    )
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
        if canonical_music_id.is_empty() {
            return 0.0;
        }
        self.exposures
            .get(canonical_music_id)
            .map(|exposure| temporal_memory_retrievability(now_ms, *exposure))
            .unwrap_or(0.0)
    }

    /// Return the strongest existing memory trace for a stable identity and
    /// its aliases.  Playback observations are keyed by canonical id (or the
    /// source URL fallback), so proposal-time lookups must not create another
    /// persistent identity or sum duplicate aliases.
    pub(crate) fn retrievability_for_aliases<'a>(
        &self,
        aliases: impl IntoIterator<Item = &'a str>,
        now_ms: u64,
    ) -> f32 {
        aliases
            .into_iter()
            .filter(|alias| !alias.is_empty())
            .map(|alias| self.retrievability_for(alias, now_ms))
            .fold(0.0_f32, f32::max)
    }

    /// Resolve the current track's canonical identity and source URL aliases
    /// without allowing planning to observe a new playback event.
    pub(crate) fn retrievability_for_track(&self, track: &PlaybackTrack, now_ms: u64) -> f32 {
        let mut aliases = Vec::with_capacity(4);
        aliases.push(track.canonical_music_id.as_str());
        aliases.push(track.music_url.as_str());
        if let Some(source) = track.source_music.as_deref() {
            aliases.push(source.canonical_music_id.as_str());
            aliases.push(source.url.as_str());
        }
        self.retrievability_for_aliases(aliases, now_ms)
    }

    #[cfg(test)]
    pub(crate) fn active_exposures(
        &self,
        now_ms: u64,
    ) -> impl Iterator<Item = (&str, PlaylistPlaybackTemporalExposure)> {
        self.exposures
            .iter()
            .filter_map(move |(music_id, exposure)| {
                (temporal_memory_retrievability(now_ms, *exposure)
                    >= TEMPORAL_MEMORY_PRUNE_RETRIEVABILITY)
                    .then_some((music_id.as_str(), *exposure))
            })
    }

    pub(crate) fn familiar_music_ids(&self, now_ms: u64) -> impl Iterator<Item = &str> {
        self.exposures
            .iter()
            .filter_map(move |(music_id, exposure)| {
                (temporal_memory_retrievability(now_ms, *exposure)
                    >= TEMPORAL_MEMORY_TARGET_RETENTION)
                    .then_some(music_id.as_str())
            })
    }

    /// Rebuild basin pressure from the current model projection instead of
    /// persisting model-generation-local basin identifiers.
    #[cfg(test)]
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
            temporal_memory_retrievability(now_ms, *exposure)
                >= TEMPORAL_MEMORY_PRUNE_RETRIEVABILITY
        });
    }
}

/// FSRS-6 forgetting curve. Production callers use its inverse as a soft
/// anti-repetition signal: familiar items receive less selection pressure.
pub(crate) fn temporal_memory_retrievability(
    now_ms: u64,
    exposure: PlaylistPlaybackTemporalExposure,
) -> f32 {
    let elapsed_ms = now_ms.saturating_sub(exposure.last_played_at_ms) as f32;
    let stability_ms = exposure.stability_ms.max(1) as f32;
    let factor = 0.9_f32.powf(-1.0 / TEMPORAL_MEMORY_FSRS_DECAY) - 1.0;
    (1.0 + factor * elapsed_ms / stability_ms).powf(-TEMPORAL_MEMORY_FSRS_DECAY)
}
