use crate::domain::player::model::PlaybackTrack;
#[cfg(not(test))]
use crate::domain::{downloads::service as download_service, meta::service as meta_service};
#[cfg(not(test))]
use anyhow::{Context, Result, anyhow};
use rand::RngExt;
use rustfft::{FftPlanner, num_complex::Complex};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{BufReader, Read};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
#[cfg(not(test))]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(not(test))]
use std::sync::{Mutex, OnceLock, RwLock};
#[cfg(not(test))]
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(not(test))]
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const AUDIO_STYLE_EMBEDDING_VERSION: &str = "audio-style-watermark-transition-v2";
#[cfg(test)]
pub(crate) const AUDIO_STYLE_EMBEDDING_VERSION_FOR_TEST: &str = AUDIO_STYLE_EMBEDDING_VERSION;
const AUDIO_STYLE_SAMPLE_RATE: u32 = 16_000;
const AUDIO_STYLE_INTERVAL_SECONDS: f64 = 8.0;
const AUDIO_STYLE_INTERVAL_COUNT: usize = 1;
const AUDIO_STYLE_TERMINAL_BINS: usize = 64;
const AUDIO_STYLE_TERMINAL_LATENT_WIDTH: usize = AUDIO_STYLE_TERMINAL_BINS * 2;
const AUDIO_STYLE_TRANSITION_WIDTH: usize = AUDIO_STYLE_TERMINAL_BINS * AUDIO_STYLE_TERMINAL_BINS;
const AUDIO_STYLE_EMBEDDING_WIDTH: usize = AUDIO_STYLE_TERMINAL_LATENT_WIDTH
    + AUDIO_STYLE_TERMINAL_BINS * 2
    + AUDIO_STYLE_TRANSITION_WIDTH;
const AUDIO_STYLE_FRAME_SIZE: usize = 1024;
const AUDIO_STYLE_HOP_SIZE: usize = 256;
const AUDIO_STYLE_SMOOTHNESS: f32 = 5.0;
const AUDIO_STYLE_EXPLORATION_FLOOR: f32 = 0.04;
const AUDIO_STYLE_LOCAL_DENSITY_TOP_K: usize = 10;

#[cfg(not(test))]
static AUDIO_STYLE_RECOMMENDATION_RUNTIME: OnceLock<Arc<AudioStyleRecommendationRuntime>> =
    OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PlaybackTrackKey {
    music_url: String,
    file_path: PathBuf,
    start_ms: u32,
    end_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleEmbedding {
    version: String,
    values: Vec<f32>,
}

#[derive(Debug, Clone)]
pub(crate) struct AudioStyleEmbedding {
    values: Vec<f32>,
}

pub(crate) struct AudioStyleEmbeddingCache {
    cache_root: PathBuf,
    ffmpeg_path: PathBuf,
}

pub(crate) struct AudioStylePlaylistPlaybackRecommender {
    embeddings: HashMap<PlaybackTrackKey, AudioStyleEmbedding>,
    sampling_geometry: Option<AudioStyleSamplingGeometry>,
    trained: bool,
}

struct AudioStyleSamplingGeometry {
    centered_embeddings: HashMap<PlaybackTrackKey, AudioStyleSamplingEmbedding>,
    local_density: HashMap<PlaybackTrackKey, f32>,
    similarity_low: f32,
    similarity_high: f32,
}

#[derive(Debug, Clone)]
struct AudioStyleSamplingEmbedding {
    values: Vec<f32>,
}

#[derive(Clone)]
pub(crate) struct AudioStyleModelSnapshot {
    generation: u64,
    recommender: Arc<AudioStylePlaylistPlaybackRecommender>,
}

pub(crate) struct AudioStylePlaylistPlaybackProposal {
    pub(crate) tracks: Vec<PlaybackTrack>,
    pub(crate) selection: Option<AudioStyleCandidateSelection>,
}

struct AudioStyleNextTrackProposal {
    track: PlaybackTrack,
    selection: AudioStyleCandidateSelection,
}

#[derive(Debug, Clone)]
pub(crate) struct AudioStyleCandidateSelection {
    pub(crate) index: usize,
    pub(crate) probability: f32,
    pub(crate) uniform_probability: f32,
    pub(crate) similarity: Option<f32>,
    pub(crate) best_similarity: Option<f32>,
    pub(crate) local_rank_fraction: Option<f32>,
    pub(crate) draw_unit: f32,
    pub(crate) candidate_count: usize,
    pub(crate) source: AudioStyleCandidateSelectionSource,
    pub(crate) reason: Option<&'static str>,
    pub(crate) model_generation: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioStyleCandidateSelectionSource {
    AudioStyle,
    RandomFallback,
}

impl AudioStyleCandidateSelectionSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::AudioStyle => "audio_style",
            Self::RandomFallback => "random_fallback",
        }
    }
}

impl PlaybackTrackKey {
    fn from_track(track: &PlaybackTrack) -> Self {
        Self {
            music_url: track.music_url.clone(),
            file_path: track.file_path.clone(),
            start_ms: track.start_ms,
            end_ms: track.end_ms,
        }
    }

    fn matches_track(&self, track: &PlaybackTrack) -> bool {
        self.music_url == track.music_url
            && self.file_path == track.file_path
            && self.start_ms == track.start_ms
            && self.end_ms == track.end_ms
    }
}

#[cfg(not(test))]
struct AudioStyleRecommendationRuntime {
    app: AppHandle,
    published_snapshot: RwLock<Option<Arc<AudioStyleModelSnapshot>>>,
    training: Mutex<AudioStyleTrainingState>,
    next_generation: AtomicU64,
}

#[cfg(not(test))]
#[derive(Debug, Default)]
struct AudioStyleTrainingState {
    running: bool,
    rerun_requested: bool,
}

#[cfg(not(test))]
impl AudioStyleRecommendationRuntime {
    fn request_training(self: &Arc<Self>, reason: &'static str) {
        let should_spawn = match self.training.lock() {
            Ok(mut training) => {
                if training.running {
                    training.rerun_requested = true;
                    println!(
                        "[playlist_playback] audio style model training queued reason={reason}"
                    );
                    false
                } else {
                    training.running = true;
                    true
                }
            }
            Err(_) => {
                eprintln!("[playlist_playback] audio style training state is poisoned");
                false
            }
        };

        if !should_spawn {
            return;
        }

        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            runtime.run_training_loop(reason).await;
        });
    }

    async fn run_training_loop(self: Arc<Self>, initial_reason: &'static str) {
        let mut reason = initial_reason;
        loop {
            if let Err(error) = self.train_and_publish(reason).await {
                eprintln!("[playlist_playback] audio style model training failed: {error}");
            }

            let should_continue = match self.training.lock() {
                Ok(mut training) => {
                    if training.rerun_requested {
                        training.rerun_requested = false;
                        true
                    } else {
                        training.running = false;
                        false
                    }
                }
                Err(_) => {
                    eprintln!("[playlist_playback] audio style training state is poisoned");
                    false
                }
            };

            if !should_continue {
                return;
            }
            reason = "coalesced_update";
        }
    }

    async fn train_and_publish(&self, reason: &'static str) -> Result<()> {
        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let has_published_snapshot = self
            .published_snapshot
            .read()
            .ok()
            .is_some_and(|snapshot| snapshot.is_some());
        println!(
            "[playlist_playback] audio style model training started generation={generation} reason={reason} has_published_snapshot={has_published_snapshot}"
        );
        let started_at = Instant::now();
        let ffmpeg_path = crate::utils::binaries::resolve_installed_managed_binary(
            &self.app,
            crate::utils::binaries::ManagedBinary::Ffmpeg,
        )
        .map_err(|error| anyhow!(error))?
        .ok_or_else(|| anyhow!("ffmpeg is not installed yet"))?;
        let cache = AudioStyleEmbeddingCache::new(
            ffmpeg_path,
            audio_style_embedding_cache_root(&self.app)?,
        )
        .map_err(|error| anyhow!(error))?;
        let save_root = meta_service::resolve_save_root(&self.app).await?;
        let sources =
            crate::domain::playlists::repo::load_audio_style_training_track_sources().await?;
        let tracks = resolve_audio_style_training_tracks(&save_root, sources);
        let requested_track_count = tracks.len();

        let snapshot = tauri::async_runtime::spawn_blocking(move || {
            AudioStyleModelSnapshot::train(generation, &cache, tracks)
        })
        .await
        .context("audio style model training task panicked")?
        .map_err(|error| anyhow!(error))?;

        let track_count = snapshot.track_count();
        match self.published_snapshot.write() {
            Ok(mut published) => {
                *published = Some(Arc::new(snapshot));
            }
            Err(_) => {
                eprintln!("[playlist_playback] audio style model snapshot lock is poisoned");
                return Ok(());
            }
        }

        let elapsed_ms = started_at.elapsed().as_millis();
        println!(
            "[playlist_playback] audio style model training finished generation={generation} trained_tracks={track_count} requested_tracks={requested_track_count} elapsed_ms={elapsed_ms} reason={reason}"
        );
        Ok(())
    }

    fn snapshot(&self) -> Option<Arc<AudioStyleModelSnapshot>> {
        self.published_snapshot
            .read()
            .ok()
            .and_then(|snapshot| snapshot.clone())
    }
}

#[cfg(not(test))]
pub(crate) fn initialize_audio_style_recommendation_runtime(app: AppHandle) {
    let runtime = AUDIO_STYLE_RECOMMENDATION_RUNTIME.get_or_init(|| {
        Arc::new(AudioStyleRecommendationRuntime {
            app,
            published_snapshot: RwLock::new(None),
            training: Mutex::new(AudioStyleTrainingState::default()),
            next_generation: AtomicU64::new(0),
        })
    });

    runtime.request_training("startup");
    spawn_audio_style_download_training_listener(Arc::clone(runtime));
}

#[cfg(not(test))]
pub(crate) fn published_audio_style_model_snapshot() -> Option<Arc<AudioStyleModelSnapshot>> {
    AUDIO_STYLE_RECOMMENDATION_RUNTIME
        .get()
        .and_then(|runtime| runtime.snapshot())
}

#[cfg(not(test))]
fn spawn_audio_style_download_training_listener(runtime: Arc<AudioStyleRecommendationRuntime>) {
    let mut changes = download_service::subscribe_download_task_changes();
    tauri::async_runtime::spawn(async move {
        loop {
            match changes.recv().await {
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    runtime.request_training("download_update");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    eprintln!("[playlist_playback] audio style training download channel closed");
                    return;
                }
            }
        }
    });
}

impl AudioStyleEmbedding {
    fn normalize(mut values: Vec<f32>) -> Option<Self> {
        if values.len() != AUDIO_STYLE_EMBEDDING_WIDTH {
            return None;
        }
        let norm = values
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt()
            .max(1.0e-6);
        for value in &mut values {
            *value = (*value / norm).clamp(-1.0, 1.0);
        }
        Some(Self { values })
    }
}

impl AudioStyleSamplingEmbedding {
    fn normalize(mut values: Vec<f32>) -> Option<Self> {
        if values.len() != AUDIO_STYLE_EMBEDDING_WIDTH {
            return None;
        }
        let norm = values
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt()
            .max(1.0e-6);
        for value in &mut values {
            *value = (*value / norm).clamp(-1.0, 1.0);
        }
        Some(Self { values })
    }

    fn cosine(&self, other: &Self) -> f32 {
        self.values
            .iter()
            .zip(other.values.iter())
            .map(|(left, right)| left * right)
            .sum::<f32>()
            .clamp(-1.0, 1.0)
    }
}

impl AudioStyleSamplingGeometry {
    fn from_embeddings(
        embeddings: &HashMap<PlaybackTrackKey, AudioStyleEmbedding>,
    ) -> Option<Self> {
        if embeddings.len() < 2 {
            return None;
        }

        let mean = audio_style_embedding_mean(embeddings.values());
        let mut centered_embeddings = HashMap::with_capacity(embeddings.len());
        for (key, embedding) in embeddings {
            let centered = embedding
                .values
                .iter()
                .zip(mean.iter())
                .map(|(value, mean)| value - mean)
                .collect::<Vec<_>>();
            let sampling_embedding = AudioStyleSamplingEmbedding::normalize(centered)?;
            centered_embeddings.insert(key.clone(), sampling_embedding);
        }
        let local_density = audio_style_local_density(&centered_embeddings);
        let (similarity_low, similarity_high) =
            audio_style_corrected_similarity_scale(&centered_embeddings, &local_density);
        Some(Self {
            centered_embeddings,
            local_density,
            similarity_low,
            similarity_high,
        })
    }

    fn corrected_similarity(
        &self,
        left: &PlaybackTrackKey,
        right: &PlaybackTrackKey,
    ) -> Option<f32> {
        let left_embedding = self.centered_embeddings.get(left)?;
        let right_embedding = self.centered_embeddings.get(right)?;
        let left_density = self.local_density.get(left).copied().unwrap_or(0.0);
        let right_density = self.local_density.get(right).copied().unwrap_or(0.0);
        let similarity = left_embedding.cosine(right_embedding);
        let corrected = 2.0 * similarity - left_density - right_density;
        Some(
            minmax_unit_similarity(corrected, self.similarity_low, self.similarity_high)
                .clamp(-1.0, 1.0),
        )
    }
}

impl AudioStyleEmbeddingCache {
    pub(crate) fn new(ffmpeg_path: PathBuf, cache_root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&cache_root).map_err(|error| {
            format!(
                "failed to create audio style embedding cache `{}`: {error}",
                cache_root.display()
            )
        })?;
        cleanup_stale_audio_style_embedding_cache(&cache_root)?;
        Ok(Self {
            cache_root,
            ffmpeg_path,
        })
    }

    pub(crate) fn embedding_for_track(
        &self,
        track: &PlaybackTrack,
    ) -> Result<AudioStyleEmbedding, String> {
        let cache_key = build_audio_style_embedding_cache_key(track)?;
        let cache_path = self.cache_root.join(format!("{cache_key}.json"));
        if let Ok(embedding) = read_cached_audio_style_embedding(&cache_path) {
            return Ok(embedding);
        }

        let embedding = decode_audio_style_embedding(&self.ffmpeg_path, track)?;
        write_cached_audio_style_embedding(&cache_path, &embedding)?;
        Ok(embedding)
    }

    pub(crate) fn cached_embedding_for_track(
        &self,
        track: &PlaybackTrack,
    ) -> Result<Option<AudioStyleEmbedding>, String> {
        let cache_key = build_audio_style_embedding_cache_key(track)?;
        let cache_path = self.cache_root.join(format!("{cache_key}.json"));
        match read_cached_audio_style_embedding_with_kind(&cache_path) {
            Ok(embedding) => Ok(Some(embedding)),
            Err(error) if error.kind == AudioStyleEmbeddingCacheReadErrorKind::Missing => Ok(None),
            Err(error) => Err(error.message),
        }
    }
}

impl AudioStylePlaylistPlaybackRecommender {
    pub(crate) fn from_cached_tracks(
        cache: &AudioStyleEmbeddingCache,
        tracks: &[PlaybackTrack],
    ) -> (Self, Vec<PlaybackTrack>, Vec<String>) {
        let mut embeddings = HashMap::new();
        let mut missing_tracks = Vec::new();
        let mut failures = Vec::new();
        let mut seen = HashSet::new();
        for track in tracks {
            let key = PlaybackTrackKey::from_track(track);
            if !seen.insert(key.clone()) {
                continue;
            }
            match cache.cached_embedding_for_track(track) {
                Ok(Some(embedding)) => {
                    embeddings.insert(key, embedding);
                }
                Ok(None) => {
                    missing_tracks.push(track.clone());
                }
                Err(error) => {
                    failures.push(format!("{}: {error}", track.file_path.display()));
                    missing_tracks.push(track.clone());
                }
            }
        }
        (
            Self {
                embeddings,
                sampling_geometry: None,
                trained: false,
            },
            missing_tracks,
            failures,
        )
    }

    #[cfg(test)]
    pub(crate) fn from_test_embeddings(
        values: impl IntoIterator<Item = (PlaybackTrack, Vec<f32>)>,
    ) -> Self {
        let embeddings = values
            .into_iter()
            .filter_map(|(track, values)| {
                AudioStyleEmbedding::normalize(values)
                    .map(|embedding| (PlaybackTrackKey::from_track(&track), embedding))
            })
            .collect::<HashMap<_, _>>();
        Self::from_trained_embeddings(embeddings)
    }

    #[cfg(test)]
    pub(crate) fn from_untrained_test_embeddings(
        values: impl IntoIterator<Item = (PlaybackTrack, Vec<f32>)>,
    ) -> Self {
        let embeddings = values
            .into_iter()
            .filter_map(|(track, values)| {
                AudioStyleEmbedding::normalize(values)
                    .map(|embedding| (PlaybackTrackKey::from_track(&track), embedding))
            })
            .collect();
        Self {
            embeddings,
            sampling_geometry: None,
            trained: false,
        }
    }

    pub(crate) fn has_embedding_for(&self, track: &PlaybackTrack) -> bool {
        self.embeddings
            .contains_key(&PlaybackTrackKey::from_track(track))
    }

    pub(crate) fn propose_queue(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
    ) -> Vec<PlaybackTrack> {
        self.propose_queue_with_trace(current_track, candidates)
            .tracks
    }

    pub(crate) fn propose_queue_with_trace(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
    ) -> AudioStylePlaylistPlaybackProposal {
        let remaining = dedupe_tracks_excluding(candidates, Some(&current_track));
        let mut queue = Vec::with_capacity(2);
        queue.push(current_track.clone());
        let selection = self
            .propose_next_with_trace(&current_track, remaining)
            .map(|proposal| {
                queue.push(proposal.track);
                proposal.selection
            });
        AudioStylePlaylistPlaybackProposal {
            tracks: queue,
            selection,
        }
    }

    pub(crate) fn propose_queue_after_exclude(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
    ) -> Vec<PlaybackTrack> {
        self.propose_queue_after_exclude_with_trace(current_track, candidates)
            .tracks
    }

    pub(crate) fn propose_queue_after_exclude_with_trace(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
    ) -> AudioStylePlaylistPlaybackProposal {
        let remaining = dedupe_tracks_excluding(candidates, Some(&current_track));
        let mut selection = None;
        let tracks = self
            .propose_next_with_trace(&current_track, remaining)
            .map(|proposal| {
                selection = Some(proposal.selection);
                proposal.track
            })
            .into_iter()
            .collect();
        AudioStylePlaylistPlaybackProposal { tracks, selection }
    }

    fn propose_next_with_trace(
        &self,
        current_track: &PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
    ) -> Option<AudioStyleNextTrackProposal> {
        if candidates.is_empty() {
            return None;
        }

        let mut rng = rand::rng();
        let draw = rng.random_range(0.0..1.0);
        let selection = select_next_audio_style_candidate(
            &candidates,
            &PlaybackTrackKey::from_track(current_track),
            &self.embeddings,
            self.sampling_geometry.as_ref(),
            self.trained,
            draw,
        );
        candidates
            .into_iter()
            .nth(selection.index)
            .map(|track| AudioStyleNextTrackProposal { track, selection })
    }

    fn from_trained_embeddings(embeddings: HashMap<PlaybackTrackKey, AudioStyleEmbedding>) -> Self {
        let sampling_geometry = AudioStyleSamplingGeometry::from_embeddings(&embeddings);
        Self {
            embeddings,
            sampling_geometry,
            trained: true,
        }
    }
}

impl AudioStyleModelSnapshot {
    fn train(
        generation: u64,
        cache: &AudioStyleEmbeddingCache,
        tracks: Vec<PlaybackTrack>,
    ) -> Result<Self, String> {
        let mut embeddings = HashMap::new();
        let mut seen = HashSet::new();
        for track in tracks {
            let key = PlaybackTrackKey::from_track(&track);
            if !seen.insert(key.clone()) {
                continue;
            }

            match cache.embedding_for_track(&track) {
                Ok(embedding) => {
                    embeddings.insert(key, embedding);
                }
                Err(error) => {
                    eprintln!(
                        "[playlist_playback] failed to train audio style embedding for `{}`: {error}",
                        track.file_path.display()
                    );
                }
            }
        }

        if embeddings.is_empty() {
            return Err("audio style model has no trainable tracks".to_string());
        }

        Ok(Self {
            generation,
            recommender: Arc::new(
                AudioStylePlaylistPlaybackRecommender::from_trained_embeddings(embeddings),
            ),
        })
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn recommender(&self) -> &AudioStylePlaylistPlaybackRecommender {
        &self.recommender
    }

    fn track_count(&self) -> usize {
        self.recommender.embeddings.len()
    }

    #[cfg(test)]
    pub(crate) fn from_test_embeddings(
        generation: u64,
        values: impl IntoIterator<Item = (PlaybackTrack, Vec<f32>)>,
    ) -> Self {
        Self {
            generation,
            recommender: Arc::new(AudioStylePlaylistPlaybackRecommender::from_test_embeddings(
                values,
            )),
        }
    }
}

fn dedupe_tracks_excluding(
    tracks: Vec<PlaybackTrack>,
    excluded: Option<&PlaybackTrack>,
) -> Vec<PlaybackTrack> {
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(tracks.len());
    for track in tracks {
        if excluded
            .is_some_and(|excluded| PlaybackTrackKey::from_track(excluded).matches_track(&track))
        {
            continue;
        }
        let key = PlaybackTrackKey::from_track(&track);
        if seen.insert(key) {
            result.push(track);
        }
    }
    result
}

fn select_next_audio_style_candidate(
    candidates: &[PlaybackTrack],
    anchor_key: &PlaybackTrackKey,
    embeddings: &HashMap<PlaybackTrackKey, AudioStyleEmbedding>,
    sampling_geometry: Option<&AudioStyleSamplingGeometry>,
    model_trained: bool,
    draw_unit: f32,
) -> AudioStyleCandidateSelection {
    if candidates.is_empty() {
        return AudioStyleCandidateSelection {
            index: 0,
            probability: 0.0,
            uniform_probability: 0.0,
            similarity: None,
            best_similarity: None,
            local_rank_fraction: None,
            draw_unit,
            candidate_count: 0,
            source: AudioStyleCandidateSelectionSource::RandomFallback,
            reason: Some("no_candidates"),
            model_generation: None,
        };
    }
    if !embeddings.contains_key(anchor_key) {
        return random_fallback_selection(
            candidates.len(),
            draw_unit,
            Some("missing_anchor_embedding"),
        );
    };
    if !model_trained {
        return random_fallback_selection(candidates.len(), draw_unit, Some("untrained_model"));
    };
    let Some(geometry) = sampling_geometry else {
        return random_fallback_selection(
            candidates.len(),
            draw_unit,
            Some("missing_sampling_geometry"),
        );
    };
    if !geometry.centered_embeddings.contains_key(anchor_key) {
        return random_fallback_selection(
            candidates.len(),
            draw_unit,
            Some("missing_anchor_embedding"),
        );
    };

    let mut candidate_likes = Vec::with_capacity(candidates.len());
    let mut similarities = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let key = PlaybackTrackKey::from_track(candidate);
        let similarity = geometry
            .corrected_similarity(anchor_key, &key)
            .filter(|similarity| similarity.is_finite());
        candidate_likes.push(candidate.liked);
        similarities.push(similarity);
    }

    let style_weights = audio_style_candidate_weights(&similarities);
    let non_liked_weights = candidate_likes
        .iter()
        .zip(style_weights.iter())
        .filter_map(|(liked, weight)| if *liked { None } else { Some(*weight) })
        .collect::<Vec<_>>();
    let liked_weight = liked_candidate_weight(&non_liked_weights);
    let mut weights = Vec::with_capacity(style_weights.len());
    let mut total = 0.0_f32;
    for (liked, style_weight) in candidate_likes.iter().zip(style_weights.iter()) {
        let safe_weight = if *liked { liked_weight } else { *style_weight };
        weights.push(safe_weight);
        total += safe_weight;
    }

    if total <= 0.0 || !total.is_finite() {
        return random_fallback_selection(candidates.len(), draw_unit, Some("invalid_weights"));
    }

    let mut cursor = draw_unit.clamp(0.0, 0.999_999) * total;
    for (index, weight) in weights.iter().copied().enumerate() {
        if cursor <= weight {
            let diagnostics = audio_style_selection_similarity_diagnostics(index, &similarities);
            return AudioStyleCandidateSelection {
                index,
                probability: weight / total,
                uniform_probability: random_selection_probability(candidates.len()),
                similarity: diagnostics.similarity,
                best_similarity: diagnostics.best_similarity,
                local_rank_fraction: diagnostics.local_rank_fraction,
                draw_unit,
                candidate_count: candidates.len(),
                source: AudioStyleCandidateSelectionSource::AudioStyle,
                reason: None,
                model_generation: None,
            };
        }
        cursor -= weight;
    }
    let index = candidates.len() - 1;
    let diagnostics = audio_style_selection_similarity_diagnostics(index, &similarities);
    AudioStyleCandidateSelection {
        index,
        probability: weights[index] / total,
        uniform_probability: random_selection_probability(candidates.len()),
        similarity: diagnostics.similarity,
        best_similarity: diagnostics.best_similarity,
        local_rank_fraction: diagnostics.local_rank_fraction,
        draw_unit,
        candidate_count: candidates.len(),
        source: AudioStyleCandidateSelectionSource::AudioStyle,
        reason: None,
        model_generation: None,
    }
}

fn audio_style_candidate_weights(similarities: &[Option<f32>]) -> Vec<f32> {
    let valid = similarities
        .iter()
        .enumerate()
        .filter_map(|(index, similarity)| similarity.map(|similarity| (index, similarity)))
        .collect::<Vec<_>>();
    if valid.is_empty() {
        return vec![AUDIO_STYLE_EXPLORATION_FLOOR; similarities.len()];
    }

    let mut weights = vec![AUDIO_STYLE_EXPLORATION_FLOOR; similarities.len()];

    for (index, similarity) in &valid {
        let weight = (AUDIO_STYLE_SMOOTHNESS * *similarity).exp() + AUDIO_STYLE_EXPLORATION_FLOOR;
        weights[*index] = weight.max(AUDIO_STYLE_EXPLORATION_FLOOR);
    }

    weights
}

struct AudioStyleSelectionSimilarityDiagnostics {
    similarity: Option<f32>,
    best_similarity: Option<f32>,
    local_rank_fraction: Option<f32>,
}

fn audio_style_selection_similarity_diagnostics(
    selected_index: usize,
    similarities: &[Option<f32>],
) -> AudioStyleSelectionSimilarityDiagnostics {
    let selected_similarity = similarities.get(selected_index).and_then(|value| *value);
    let valid = similarities
        .iter()
        .filter_map(|similarity| *similarity)
        .collect::<Vec<_>>();
    let best_similarity = valid
        .iter()
        .copied()
        .max_by(|left, right| left.total_cmp(right));
    let local_rank_fraction = selected_similarity.and_then(|selected| {
        if valid.len() <= 1 {
            return None;
        }
        let better_count = valid
            .iter()
            .filter(|similarity| **similarity > selected)
            .count();
        Some(better_count as f32 / (valid.len() - 1) as f32)
    });
    AudioStyleSelectionSimilarityDiagnostics {
        similarity: selected_similarity,
        best_similarity,
        local_rank_fraction,
    }
}

fn liked_candidate_weight(non_liked_weights: &[f32]) -> f32 {
    if non_liked_weights.is_empty() {
        return 1.0;
    }

    let mut weights = non_liked_weights
        .iter()
        .copied()
        .filter(|weight| weight.is_finite() && *weight > 0.0)
        .collect::<Vec<_>>();
    if weights.is_empty() {
        return 1.0;
    }

    weights.sort_by(|left, right| left.total_cmp(right));
    if weights.len() == 1 {
        return weights[0].max(AUDIO_STYLE_EXPLORATION_FLOOR);
    }

    let middle = weights.len() / 2;
    let median = if weights.len() % 2 == 0 {
        (weights[middle - 1] + weights[middle]) / 2.0
    } else {
        weights[middle]
    };
    median.max(AUDIO_STYLE_EXPLORATION_FLOOR)
}

fn audio_style_embedding_mean<'a>(
    embeddings: impl IntoIterator<Item = &'a AudioStyleEmbedding>,
) -> Vec<f32> {
    let mut mean = vec![0.0_f32; AUDIO_STYLE_EMBEDDING_WIDTH];
    let mut count = 0usize;
    for embedding in embeddings {
        for (mean_value, value) in mean.iter_mut().zip(embedding.values.iter()) {
            *mean_value += *value;
        }
        count += 1;
    }
    if count > 0 {
        let scale = 1.0 / count as f32;
        for value in &mut mean {
            *value *= scale;
        }
    }
    mean
}

fn audio_style_local_density(
    embeddings: &HashMap<PlaybackTrackKey, AudioStyleSamplingEmbedding>,
) -> HashMap<PlaybackTrackKey, f32> {
    let keys = embeddings.keys().cloned().collect::<Vec<_>>();
    let mut result = HashMap::with_capacity(keys.len());
    for key in &keys {
        let Some(embedding) = embeddings.get(key) else {
            continue;
        };
        let mut similarities = keys
            .iter()
            .filter(|other_key| *other_key != key)
            .filter_map(|other_key| {
                embeddings
                    .get(other_key)
                    .map(|other_embedding| embedding.cosine(other_embedding))
            })
            .filter(|similarity| similarity.is_finite())
            .collect::<Vec<_>>();
        if similarities.is_empty() {
            result.insert(key.clone(), 0.0);
            continue;
        }
        similarities.sort_by(|left, right| right.total_cmp(left));
        let runtime_top_k = AUDIO_STYLE_LOCAL_DENSITY_TOP_K
            .min(similarities.len())
            .max(1);
        let density = similarities
            .iter()
            .take(runtime_top_k)
            .copied()
            .sum::<f32>()
            / runtime_top_k as f32;
        result.insert(key.clone(), density);
    }
    result
}

fn audio_style_corrected_similarity_scale(
    embeddings: &HashMap<PlaybackTrackKey, AudioStyleSamplingEmbedding>,
    local_density: &HashMap<PlaybackTrackKey, f32>,
) -> (f32, f32) {
    let keys = embeddings.keys().collect::<Vec<_>>();
    let mut values = Vec::new();
    for left in &keys {
        let Some(left_embedding) = embeddings.get(left) else {
            continue;
        };
        let left_density = local_density.get(left).copied().unwrap_or(0.0);
        for right in &keys {
            if left == right {
                continue;
            }
            let Some(right_embedding) = embeddings.get(right) else {
                continue;
            };
            let right_density = local_density.get(right).copied().unwrap_or(0.0);
            let corrected =
                2.0 * left_embedding.cosine(right_embedding) - left_density - right_density;
            if corrected.is_finite() {
                values.push(corrected);
            }
        }
    }

    if values.is_empty() {
        return (-1.0, 1.0);
    }
    values.sort_by(|left, right| left.total_cmp(right));
    let low = sorted_quantile(&values, 0.01);
    let high = sorted_quantile(&values, 0.99);
    if (high - low).abs() <= 1.0e-6 {
        (low - 1.0, high + 1.0)
    } else {
        (low, high)
    }
}

fn sorted_quantile(sorted_values: &[f32], q: f32) -> f32 {
    if sorted_values.is_empty() {
        return 0.0;
    }
    if sorted_values.len() == 1 {
        return sorted_values[0];
    }

    let position = q.clamp(0.0, 1.0) * (sorted_values.len() - 1) as f32;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        return sorted_values[lower];
    }
    let fraction = position - lower as f32;
    sorted_values[lower] * (1.0 - fraction) + sorted_values[upper] * fraction
}

fn minmax_unit_similarity(value: f32, low: f32, high: f32) -> f32 {
    2.0 * (value - low) / (high - low).max(1.0e-6) - 1.0
}

fn random_fallback_index(len: usize, draw_unit: f32) -> usize {
    ((draw_unit.clamp(0.0, 0.999_999) * len as f32).floor() as usize).min(len.saturating_sub(1))
}

fn random_fallback_selection(
    len: usize,
    draw_unit: f32,
    reason: Option<&'static str>,
) -> AudioStyleCandidateSelection {
    AudioStyleCandidateSelection {
        index: random_fallback_index(len, draw_unit),
        probability: random_selection_probability(len),
        uniform_probability: random_selection_probability(len),
        similarity: None,
        best_similarity: None,
        local_rank_fraction: None,
        draw_unit,
        candidate_count: len,
        source: AudioStyleCandidateSelectionSource::RandomFallback,
        reason,
        model_generation: None,
    }
}

fn random_selection_probability(len: usize) -> f32 {
    if len == 0 { 0.0 } else { 1.0 / len as f32 }
}

fn decode_audio_style_embedding(
    ffmpeg_path: &Path,
    track: &PlaybackTrack,
) -> Result<AudioStyleEmbedding, String> {
    let starts = audio_style_interval_starts(track);
    let mut merged = vec![0.0_f32; AUDIO_STYLE_EMBEDDING_WIDTH];
    let mut decoded_count = 0usize;
    for start_seconds in starts {
        let samples = decode_audio_style_interval(ffmpeg_path, &track.file_path, start_seconds)?;
        let local = audio_style_embedding_fingerprint(&samples);
        for (merged_value, local_value) in merged.iter_mut().zip(local.into_iter()) {
            *merged_value += local_value;
        }
        decoded_count += 1;
    }

    if decoded_count == 0 {
        return Err("audio style embedding decoded no intervals".to_string());
    }
    let scale = 1.0 / decoded_count as f32;
    for value in &mut merged {
        *value *= scale;
    }
    AudioStyleEmbedding::normalize(merged)
        .ok_or_else(|| "audio style embedding has invalid width".to_string())
}

fn audio_style_interval_starts(track: &PlaybackTrack) -> Vec<f64> {
    let start_seconds = track.start_ms as f64 / 1000.0;
    let end_seconds = track.end_ms as f64 / 1000.0;
    let duration = (end_seconds - start_seconds).max(0.0);
    if duration <= AUDIO_STYLE_INTERVAL_SECONDS {
        return vec![start_seconds];
    }

    let max_start = start_seconds + duration - AUDIO_STYLE_INTERVAL_SECONDS;
    if AUDIO_STYLE_INTERVAL_COUNT <= 1 {
        return vec![audio_style_stable_crop_start(
            track,
            start_seconds,
            max_start,
        )];
    }

    (0..AUDIO_STYLE_INTERVAL_COUNT)
        .map(|index| {
            let ratio = index as f64 / (AUDIO_STYLE_INTERVAL_COUNT - 1) as f64;
            start_seconds + ratio * (max_start - start_seconds)
        })
        .collect()
}

fn audio_style_stable_crop_start(track: &PlaybackTrack, start_seconds: f64, max_start: f64) -> f64 {
    let offset_span = (max_start - start_seconds).max(0.0);
    if offset_span <= f64::EPSILON {
        return start_seconds;
    }

    let sample_span = (offset_span * AUDIO_STYLE_SAMPLE_RATE as f64)
        .floor()
        .max(1.0) as u64;
    let mut hasher = Sha256::new();
    hasher.update(track.music_url.as_bytes());
    hasher.update(track.file_path.to_string_lossy().as_bytes());
    hasher.update(track.start_ms.to_le_bytes());
    hasher.update(track.end_ms.to_le_bytes());
    let digest = hasher.finalize();
    let hash = u64::from_le_bytes([
        digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
    ]);
    start_seconds + (hash % sample_span) as f64 / AUDIO_STYLE_SAMPLE_RATE as f64
}

fn decode_audio_style_interval(
    ffmpeg_path: &Path,
    input: &Path,
    start_seconds: f64,
) -> Result<Vec<f32>, String> {
    let mut command = Command::new(ffmpeg_path);
    for arg in build_audio_style_ffmpeg_args(input, start_seconds) {
        command.arg(arg);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg stdout pipe is missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "ffmpeg stderr pipe is missing".to_string())?;
    let stderr_reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut message = String::new();
        let _ = reader.read_to_string(&mut message);
        message
    });

    let mut samples = read_f32le_samples(stdout)?;
    let status = child.wait().map_err(|error| error.to_string())?;
    let stderr_message = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        return Err(format!(
            "ffmpeg audio style decode failed: {stderr_message}"
        ));
    }
    normalize_samples(&mut samples);
    if samples.is_empty() {
        return Err("ffmpeg audio style decode produced no samples".to_string());
    }
    Ok(samples)
}

fn build_audio_style_ffmpeg_args(input: &Path, start_seconds: f64) -> Vec<OsString> {
    vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-ss"),
        OsString::from(format!("{start_seconds:.3}")),
        OsString::from("-t"),
        OsString::from(format!("{AUDIO_STYLE_INTERVAL_SECONDS:.3}")),
        OsString::from("-i"),
        input.as_os_str().to_owned(),
        OsString::from("-vn"),
        OsString::from("-sn"),
        OsString::from("-dn"),
        OsString::from("-ac"),
        OsString::from("1"),
        OsString::from("-ar"),
        OsString::from(AUDIO_STYLE_SAMPLE_RATE.to_string()),
        OsString::from("-f"),
        OsString::from("f32le"),
        OsString::from("-c:a"),
        OsString::from("pcm_f32le"),
        OsString::from("pipe:1"),
    ]
}

fn read_f32le_samples(stdout: std::process::ChildStdout) -> Result<Vec<f32>, String> {
    let mut reader = BufReader::new(stdout);
    let mut buffer = [0_u8; 64 * 1024];
    let mut pending = Vec::<u8>::new();
    let mut samples = Vec::new();

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("failed to read ffmpeg audio style output: {error}"))?;
        if read == 0 {
            break;
        }
        pending.extend_from_slice(&buffer[..read]);
        let aligned_len = pending.len() / 4 * 4;
        for chunk in pending[..aligned_len].chunks_exact(4) {
            samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        pending.drain(..aligned_len);
    }

    if !pending.is_empty() {
        return Err("ffmpeg audio style output ended with an incomplete f32 sample".to_string());
    }
    Ok(samples)
}

fn normalize_samples(samples: &mut [f32]) {
    if samples.is_empty() {
        return;
    }
    let mean = samples.iter().sum::<f32>() / samples.len() as f32;
    let mut peak = 1.0e-6_f32;
    for sample in samples.iter_mut() {
        *sample = sanitize_sample(*sample - mean);
        peak = peak.max(sample.abs());
    }
    for sample in samples {
        *sample = (*sample / peak).clamp(-1.0, 1.0);
    }
}

fn sanitize_sample(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

fn audio_style_transition_fingerprint(samples: &[f32]) -> Vec<f32> {
    let terminals = audio_style_terminals(samples);
    let mut latent = audio_style_terminal_latent(&terminals);
    let mut transition = vec![0.0_f32; AUDIO_STYLE_TRANSITION_WIDTH];

    if terminals.len() >= 2 {
        for pair in terminals.windows(2) {
            let prev = pair[0] as usize;
            let next = pair[1] as usize;
            if prev == next {
                continue;
            }
            transition[prev * AUDIO_STYLE_TERMINAL_BINS + next] += 1.0;
        }
    }

    let mut outgoing = vec![0.0_f32; AUDIO_STYLE_TERMINAL_BINS];
    let mut incoming = vec![0.0_f32; AUDIO_STYLE_TERMINAL_BINS];
    for prev in 0..AUDIO_STYLE_TERMINAL_BINS {
        for next in 0..AUDIO_STYLE_TERMINAL_BINS {
            let value = transition[prev * AUDIO_STYLE_TERMINAL_BINS + next];
            outgoing[prev] += value;
            incoming[next] += value;
        }
    }
    normalize_sum(&mut outgoing);
    normalize_sum(&mut incoming);

    let mut row_norm = transition;
    for prev in 0..AUDIO_STYLE_TERMINAL_BINS {
        let start = prev * AUDIO_STYLE_TERMINAL_BINS;
        let end = start + AUDIO_STYLE_TERMINAL_BINS;
        normalize_sum(&mut row_norm[start..end]);
    }
    for value in &mut row_norm {
        *value *= 0.25;
    }

    latent.extend(outgoing);
    latent.extend(incoming);
    latent.extend(row_norm);
    normalize_vector(&mut latent);
    latent
}

fn audio_style_embedding_fingerprint(samples: &[f32]) -> Vec<f32> {
    let mut merged = vec![0.0_f32; AUDIO_STYLE_EMBEDDING_WIDTH];
    let mut view_count = 0usize;

    for view in audio_style_embedding_views(samples) {
        let local = audio_style_transition_fingerprint(&view);
        for (merged_value, local_value) in merged.iter_mut().zip(local.into_iter()) {
            *merged_value += local_value;
        }
        view_count += 1;
    }

    if view_count == 0 {
        return merged;
    }
    let scale = 1.0 / view_count as f32;
    for value in &mut merged {
        *value *= scale;
    }
    normalize_vector(&mut merged);
    merged
}

fn audio_style_embedding_views(samples: &[f32]) -> Vec<Vec<f32>> {
    let clean = normalized_audio_style_view(samples);
    let smooth = normalized_audio_style_view(&moving_average(&clean, 11));
    let low = moving_average(&clean, 17);
    let high_source = clean
        .iter()
        .zip(low.iter())
        .map(|(sample, low_sample)| sample - low_sample)
        .collect::<Vec<_>>();
    let high = normalized_audio_style_view(&high_source);
    let masked = normalized_audio_style_view(&stable_time_mask(&clean));
    vec![clean, smooth, high, masked]
}

fn normalized_audio_style_view(samples: &[f32]) -> Vec<f32> {
    let mut view = samples.to_vec();
    normalize_samples(&mut view);
    view
}

fn moving_average(samples: &[f32], kernel_size: usize) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let kernel_size = (kernel_size | 1).max(3);
    let radius = kernel_size / 2;
    let mut result = Vec::with_capacity(samples.len());
    for index in 0..samples.len() {
        let mut sum = 0.0_f32;
        for offset in 0..kernel_size {
            let raw_index = index as isize + offset as isize - radius as isize;
            let source_index = raw_index.clamp(0, samples.len() as isize - 1) as usize;
            sum += samples[source_index];
        }
        result.push(sum / kernel_size as f32);
    }
    result
}

fn stable_time_mask(samples: &[f32]) -> Vec<f32> {
    let mut masked = samples.to_vec();
    if masked.len() <= 8 {
        return masked;
    }

    let width = (masked.len() / 8).max(1);
    let max_start = masked.len().saturating_sub(masked.len() / 5).max(1);
    let start = masked.len() / 3 % max_start;
    let end = (start + width).min(masked.len());
    for sample in &mut masked[start..end] {
        *sample = 0.0;
    }
    masked
}

#[cfg(test)]
pub(crate) fn audio_style_transition_fingerprint_for_test(samples: &[f32]) -> Vec<f32> {
    audio_style_embedding_fingerprint(samples)
}

fn audio_style_terminal_latent(terminals: &[u8]) -> Vec<f32> {
    let mut hist = vec![0.0_f32; AUDIO_STYLE_TERMINAL_BINS];
    let mut delta_hist = vec![0.0_f32; AUDIO_STYLE_TERMINAL_BINS];

    for terminal in terminals {
        hist[*terminal as usize % AUDIO_STYLE_TERMINAL_BINS] += 1.0;
    }
    for pair in terminals.windows(2) {
        let delta = (pair[1] as i16 - pair[0] as i16).unsigned_abs() as usize;
        delta_hist[delta.min(AUDIO_STYLE_TERMINAL_BINS - 1)] += 1.0;
    }

    normalize_sum(&mut hist);
    normalize_sum(&mut delta_hist);
    hist.extend(delta_hist);
    hist
}

fn normalize_sum(values: &mut [f32]) {
    let total = values.iter().sum::<f32>().max(1.0);
    for value in values {
        *value /= total;
    }
}

fn normalize_vector(values: &mut [f32]) {
    let norm = values
        .iter()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt()
        .max(1.0e-6);
    for value in values {
        *value /= norm;
    }
}

fn audio_style_terminals(samples: &[f32]) -> Vec<u8> {
    let frames = audio_style_spectral_frames(samples);
    if frames.is_empty() {
        return vec![0];
    }
    let min_energy = frames
        .iter()
        .map(|frame| frame.energy)
        .fold(f32::INFINITY, f32::min);
    let max_energy = frames
        .iter()
        .map(|frame| frame.energy)
        .fold(f32::NEG_INFINITY, f32::max);
    let energy_span = (max_energy - min_energy).max(1.0e-6);
    let mut terminals = Vec::with_capacity(frames.len());
    let mut previous_bucket = frames[0].pitch_bucket;
    for frame in frames {
        let motion = if frame.pitch_bucket > previous_bucket {
            1
        } else if frame.pitch_bucket < previous_bucket {
            2
        } else {
            0
        };
        let energy_bucket = (((frame.energy - min_energy) / energy_span) * 3.0)
            .floor()
            .clamp(0.0, 3.0) as u8;
        let terminal = (frame.pitch_bucket as usize * 4 + motion as usize + energy_bucket as usize)
            % AUDIO_STYLE_TERMINAL_BINS;
        terminals.push(terminal as u8);
        previous_bucket = frame.pitch_bucket;
    }
    terminals
}

#[derive(Debug, Clone, Copy)]
struct AudioStyleFrameFeatures {
    pitch_bucket: u8,
    energy: f32,
}

fn audio_style_spectral_frames(samples: &[f32]) -> Vec<AudioStyleFrameFeatures> {
    if samples.is_empty() {
        return Vec::new();
    }

    let frame_size = AUDIO_STYLE_FRAME_SIZE.max(2);
    let hop_size = AUDIO_STYLE_HOP_SIZE.max(1);
    let frame_count = if samples.len() <= frame_size {
        1
    } else {
        1 + (samples.len() - frame_size) / hop_size
    };
    let window = hann_window(frame_size);
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(frame_size);
    let mut result = Vec::with_capacity(frame_count);

    for frame_index in 0..frame_count {
        let start = if samples.len() <= frame_size {
            0
        } else {
            frame_index * hop_size
        };
        let mut buffer = vec![Complex::new(0.0_f32, 0.0_f32); frame_size];
        for index in 0..frame_size {
            let sample = samples.get(start + index).copied().unwrap_or(0.0);
            buffer[index].re = sample * window[index];
        }
        fft.process(&mut buffer);
        result.push(audio_style_frame_features_from_spectrum(&buffer));
    }

    result
}

fn audio_style_frame_features_from_spectrum(spectrum: &[Complex<f32>]) -> AudioStyleFrameFeatures {
    let half = (spectrum.len() / 2).max(2);
    let mut peak_bin = 1usize;
    let mut peak_magnitude = 0.0_f32;
    let mut energy = 0.0_f32;

    for (bin, value) in spectrum.iter().take(half).enumerate().skip(1) {
        let magnitude = value.norm().ln_1p();
        energy += magnitude;
        if magnitude > peak_magnitude {
            peak_magnitude = magnitude;
            peak_bin = bin;
        }
    }

    let peak_hz = peak_bin as f32 * AUDIO_STYLE_SAMPLE_RATE as f32 / spectrum.len().max(1) as f32;
    let pitch_bucket =
        ((12.0 * (peak_hz.max(1.0e-4) / 55.0).log2()).round() as i32).rem_euclid(16) as u8;
    AudioStyleFrameFeatures {
        pitch_bucket,
        energy: energy / (half - 1).max(1) as f32,
    }
}

fn hann_window(size: usize) -> Vec<f32> {
    if size <= 1 {
        return vec![1.0; size];
    }

    (0..size)
        .map(|index| {
            0.5 - 0.5 * (2.0 * std::f32::consts::PI * index as f32 / (size - 1) as f32).cos()
        })
        .collect()
}

fn build_audio_style_embedding_cache_key(track: &PlaybackTrack) -> Result<String, String> {
    let metadata = track
        .file_path
        .metadata()
        .map_err(|error| format!("failed to read audio file metadata: {error}"))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let canonical_input = track
        .file_path
        .canonicalize()
        .unwrap_or_else(|_| track.file_path.clone());
    let mut hasher = Sha256::new();
    hasher.update(AUDIO_STYLE_EMBEDDING_VERSION.as_bytes());
    hasher.update(canonical_input.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified_ms.to_le_bytes());
    hasher.update(track.start_ms.to_le_bytes());
    hasher.update(track.end_ms.to_le_bytes());
    hasher.update(AUDIO_STYLE_SAMPLE_RATE.to_le_bytes());
    hasher.update(AUDIO_STYLE_INTERVAL_SECONDS.to_bits().to_le_bytes());
    hasher.update((AUDIO_STYLE_INTERVAL_COUNT as u64).to_le_bytes());
    Ok(hex::encode(hasher.finalize()))
}

fn read_cached_audio_style_embedding(path: &Path) -> Result<AudioStyleEmbedding, String> {
    read_cached_audio_style_embedding_with_kind(path).map_err(|error| error.message)
}

fn cleanup_stale_audio_style_embedding_cache(cache_root: &Path) -> Result<(), String> {
    let entries = fs::read_dir(cache_root).map_err(|error| {
        format!(
            "failed to scan audio style embedding cache `{}`: {error}",
            cache_root.display()
        )
    })?;

    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "failed to inspect audio style embedding cache `{}`: {error}",
                cache_root.display()
            )
        })?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if audio_style_embedding_cache_file_is_current(&path)? {
            continue;
        }
        fs::remove_file(&path).map_err(|error| {
            format!(
                "failed to remove stale audio style embedding cache `{}`: {error}",
                path.display()
            )
        })?;
    }

    Ok(())
}

fn audio_style_embedding_cache_file_is_current(path: &Path) -> Result<bool, String> {
    let bytes = fs::read(path).map_err(|error| {
        format!(
            "failed to read audio style embedding cache `{}` during cleanup: {error}",
            path.display()
        )
    })?;
    let cached = serde_json::from_slice::<CachedAudioStyleEmbedding>(&bytes).map_err(|error| {
        format!(
            "failed to parse audio style embedding cache `{}` during cleanup: {error}",
            path.display()
        )
    })?;
    Ok(cached.version == AUDIO_STYLE_EMBEDDING_VERSION)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioStyleEmbeddingCacheReadErrorKind {
    Invalid,
    Missing,
}

#[derive(Debug)]
struct AudioStyleEmbeddingCacheReadError {
    kind: AudioStyleEmbeddingCacheReadErrorKind,
    message: String,
}

fn read_cached_audio_style_embedding_with_kind(
    path: &Path,
) -> Result<AudioStyleEmbedding, AudioStyleEmbeddingCacheReadError> {
    let bytes = fs::read(path).map_err(|error| AudioStyleEmbeddingCacheReadError {
        kind: if error.kind() == std::io::ErrorKind::NotFound {
            AudioStyleEmbeddingCacheReadErrorKind::Missing
        } else {
            AudioStyleEmbeddingCacheReadErrorKind::Invalid
        },
        message: format!(
            "failed to read audio style embedding cache `{}`: {error}",
            path.display()
        ),
    })?;
    let cached = serde_json::from_slice::<CachedAudioStyleEmbedding>(&bytes).map_err(|error| {
        AudioStyleEmbeddingCacheReadError {
            kind: AudioStyleEmbeddingCacheReadErrorKind::Invalid,
            message: format!(
                "failed to parse audio style embedding cache `{}`: {error}",
                path.display()
            ),
        }
    })?;
    if cached.version != AUDIO_STYLE_EMBEDDING_VERSION {
        return Err(AudioStyleEmbeddingCacheReadError {
            kind: AudioStyleEmbeddingCacheReadErrorKind::Invalid,
            message: format!(
                "audio style embedding cache `{}` has unsupported version `{}`",
                path.display(),
                cached.version
            ),
        });
    }
    AudioStyleEmbedding::normalize(cached.values).ok_or_else(|| AudioStyleEmbeddingCacheReadError {
        kind: AudioStyleEmbeddingCacheReadErrorKind::Invalid,
        message: format!(
            "audio style embedding cache `{}` has invalid width",
            path.display()
        ),
    })
}

fn write_cached_audio_style_embedding(
    path: &Path,
    embedding: &AudioStyleEmbedding,
) -> Result<(), String> {
    let cached = CachedAudioStyleEmbedding {
        version: AUDIO_STYLE_EMBEDDING_VERSION.to_string(),
        values: embedding.values.clone(),
    };
    let bytes = serde_json::to_vec(&cached)
        .map_err(|error| format!("failed to encode audio style embedding cache: {error}"))?;
    let temp_path = unique_audio_style_embedding_temp_path(path);
    fs::write(&temp_path, bytes).map_err(|error| {
        format!(
            "failed to write audio style embedding cache `{}`: {error}",
            temp_path.display()
        )
    })?;
    if let Err(error) = fs::remove_file(path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "failed to replace audio style embedding cache `{}`: {error}",
            path.display()
        ));
    }
    fs::rename(&temp_path, path).map_err(|error| {
        format!(
            "failed to finalize audio style embedding cache `{}`: {error}",
            path.display()
        )
    })
}

fn unique_audio_style_embedding_temp_path(path: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "audio-style-embedding.json".into());
    path.with_file_name(format!("{file_name}.{}.{}.tmp", std::process::id(), nanos))
}

#[cfg(not(test))]
fn audio_style_embedding_cache_root(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_cache_dir()
        .context("failed to resolve app cache directory")?
        .join("audio-style-embeddings"))
}

#[cfg(not(test))]
fn resolve_audio_style_training_tracks(
    save_root: &Path,
    sources: Vec<crate::domain::playlists::repo::PlaylistPlaybackTrackSource>,
) -> Vec<PlaybackTrack> {
    sources
        .into_iter()
        .filter_map(|source| resolve_audio_style_training_track(save_root, source))
        .collect()
}

#[cfg(not(test))]
fn resolve_audio_style_training_track(
    save_root: &Path,
    source: crate::domain::playlists::repo::PlaylistPlaybackTrackSource,
) -> Option<PlaybackTrack> {
    let path = PathBuf::from(source.music.path.as_deref()?);
    let file_path = if path.is_absolute() {
        path
    } else {
        save_root.join(&source.collection_folder).join(path)
    };
    if !file_path.is_file() {
        return None;
    }

    Some(PlaybackTrack {
        playlist_name: "__audio_style_model__".to_string(),
        music_name: source.music.alias,
        music_url: source.music.url,
        file_path,
        start_ms: source.music.start_ms,
        end_ms: source.music.end_ms,
        liked: source.music.liked,
    })
}

#[cfg(test)]
pub(crate) fn choose_next_audio_style_candidate_for_test(
    current_track: &PlaybackTrack,
    candidates: &[PlaybackTrack],
    embeddings: &AudioStylePlaylistPlaybackRecommender,
    draw_unit: f32,
) -> usize {
    select_next_audio_style_candidate(
        candidates,
        &PlaybackTrackKey::from_track(current_track),
        &embeddings.embeddings,
        embeddings.sampling_geometry.as_ref(),
        embeddings.trained,
        draw_unit,
    )
    .index
}

#[cfg(test)]
pub(crate) fn choose_next_audio_style_candidate_with_generation_for_test(
    current_track: &PlaybackTrack,
    candidates: &[PlaybackTrack],
    embeddings: &AudioStylePlaylistPlaybackRecommender,
    draw_unit: f32,
    model_generation: Option<u64>,
) -> AudioStyleCandidateSelection {
    let mut selection = select_next_audio_style_candidate(
        candidates,
        &PlaybackTrackKey::from_track(current_track),
        &embeddings.embeddings,
        embeddings.sampling_geometry.as_ref(),
        embeddings.trained,
        draw_unit,
    );
    selection.model_generation = model_generation;
    selection
}
