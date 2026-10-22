use crate::domain::player::model::PlaybackTrack;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const TEMPORAL_MEMORY_FSRS_DECAY: f32 = 0.5;
const TEMPORAL_MEMORY_TRACK_STABILITY_MS: u64 = 20 * 60 * 60 * 1_000;
const TEMPORAL_MEMORY_STABILITY_REPEAT_GAIN: f32 = 0.35;
const TEMPORAL_MEMORY_STABILITY_CAP_MS: u64 = 120 * 60 * 60 * 1_000;
const TEMPORAL_MEMORY_PRUNE_RETRIEVABILITY: f32 = 0.05;
// Metadata association is softer than exact recording familiarity. Even a
// just-heard work leaves another recording at least a quarter of its cold rate.
const TEMPORAL_MEMORY_WORK_TRANSFER: f32 = 0.75;
// FSRS's default target retention; this is a memory semantic, not a model knob.
const TEMPORAL_MEMORY_TARGET_RETENTION: f32 = 0.9;

/// Listener-owned temporal state. It is keyed by stable music identity so
/// model-generation-local basin identifiers never leak across promotions.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct PlaylistPlaybackTemporalMemory {
    exposures: HashMap<String, PlaylistPlaybackTemporalExposure>,
    #[serde(default)]
    work_exposures: HashMap<String, PlaylistPlaybackTemporalExposure>,
    // Cumulative coverage has a different lifetime from decaying familiarity.
    // Keep stable recording identities; never persist generation-local classes.
    #[serde(default)]
    play_counts: HashMap<String, u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct PlaylistPlaybackTemporalExposure {
    pub(crate) last_played_at_ms: u64,
    pub(crate) stability_ms: u64,
}

impl PlaylistPlaybackTemporalMemory {
    pub(crate) fn observe_track(&mut self, track: &PlaybackTrack, now_ms: u64) {
        let music_id = if track.canonical_music_id.is_empty() {
            track.music_url.as_str()
        } else {
            track.canonical_music_id.as_str()
        };
        if music_id.is_empty() {
            return;
        }
        self.observe(music_id, now_ms);
        if let Some(work_key) = track_work_association(track) {
            let exposure = PlaylistPlaybackTemporalExposure::after_observation(
                self.work_exposures.get(&work_key).copied(),
                now_ms,
            );
            self.work_exposures.insert(work_key, exposure);
        }
    }

    pub(crate) fn observe(&mut self, canonical_music_id: &str, now_ms: u64) {
        if canonical_music_id.is_empty() {
            return;
        }

        let exposure = PlaylistPlaybackTemporalExposure::after_observation(
            self.exposures.get(canonical_music_id).copied(),
            now_ms,
        );
        self.exposures
            .insert(canonical_music_id.to_string(), exposure);
        let count = self
            .play_counts
            .entry(canonical_music_id.to_string())
            .or_default();
        *count = count.saturating_add(1);
    }

    /// Project listener coverage through the current, already scoped acoustic
    /// classes. Aliases of one recording count once. Likes retain their existing
    /// preference; only non-Like classes receive cumulative soft attenuation.
    pub(crate) fn coverage_weights<'a, G, T>(&self, groups: G) -> Vec<f32>
    where
        G: IntoIterator<Item = T>,
        T: IntoIterator<Item = &'a PlaybackTrack>,
    {
        let progress = groups
            .into_iter()
            .map(|tracks| {
                let mut seen = HashSet::new();
                let mut count = 0_u64;
                let mut liked = false;
                for track in tracks {
                    liked |= track.liked;
                    let id = if track.canonical_music_id.is_empty() {
                        track.music_url.as_str()
                    } else {
                        track.canonical_music_id.as_str()
                    };
                    if seen.insert(id) {
                        count =
                            count.saturating_add(self.play_counts.get(id).copied().unwrap_or(0));
                    }
                }
                (liked, count)
            })
            .collect::<Vec<_>>();
        let baseline = progress
            .iter()
            .filter(|(liked, _)| !liked)
            .map(|(_, count)| *count)
            .min()
            .unwrap_or(0);
        let mut weights = progress
            .iter()
            .map(|(liked, count)| {
                if *liked {
                    1.0_f32
                } else {
                    // Each play ahead of the least exposed class divides weight by
                    // four. Normalize completed rounds away; keep at least 1/64
                    // of the cold weight so progress remains a soft preference.
                    0.25_f32.powi(count.saturating_sub(baseline).min(3) as i32)
                }
            })
            .collect::<Vec<_>>();
        let (count, total) = progress
            .iter()
            .zip(&weights)
            .filter(|((liked, _), _)| !liked)
            .fold((0_usize, 0.0_f64), |(count, total), (_, weight)| {
                (count + 1, total + f64::from(*weight))
            });
        if count > 0 {
            // Redistribute only the non-Like budget. Otherwise cumulative
            // attenuation would silently increase the total Like preference.
            let scale = count as f64 / total;
            for ((liked, _), weight) in progress.iter().zip(&mut weights) {
                if !liked {
                    *weight = (f64::from(*weight) * scale) as f32;
                }
            }
        }
        weights
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
        let recording = self.retrievability_for_aliases(aliases, now_ms);
        let work = track_work_association(track)
            .and_then(|key| self.work_exposures.get(&key))
            .map(|exposure| {
                TEMPORAL_MEMORY_WORK_TRANSFER * temporal_memory_retrievability(now_ms, *exposure)
            })
            .unwrap_or(0.0);
        recording.max(work)
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
        self.work_exposures.retain(|_, exposure| {
            TEMPORAL_MEMORY_WORK_TRANSFER * temporal_memory_retrievability(now_ms, *exposure)
                >= TEMPORAL_MEMORY_PRUNE_RETRIEVABILITY
        });
    }
}

impl PlaylistPlaybackTemporalExposure {
    fn after_observation(previous: Option<Self>, now_ms: u64) -> Self {
        let stability_ms = previous
            .map(|previous| {
                ((previous.stability_ms as f32 * (1.0 + TEMPORAL_MEMORY_STABILITY_REPEAT_GAIN))
                    .round() as u64)
                    .clamp(
                        TEMPORAL_MEMORY_TRACK_STABILITY_MS,
                        TEMPORAL_MEMORY_STABILITY_CAP_MS,
                    )
            })
            .unwrap_or(TEMPORAL_MEMORY_TRACK_STABILITY_MS);
        Self {
            last_played_at_ms: now_ms,
            stability_ms,
        }
    }
}

/// Existing normalized source names are association evidence, never recording
/// identity. Scope them to their collection authority to avoid linking unrelated
/// works merely because their titles match. Group/album, display aliases and
/// playlist placement must not change the relation between versions.
fn track_work_association(track: &PlaybackTrack) -> Option<String> {
    let source = track.source_music.as_deref()?;
    let collection_url = source.group.collection.url.trim();
    let name = source
        .name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if collection_url.is_empty() || name.is_empty() {
        return None;
    }
    serde_json::to_string(&(collection_url, name)).ok()
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
