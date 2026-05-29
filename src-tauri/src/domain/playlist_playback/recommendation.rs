#[cfg(not(test))]
use crate::domain::meta::service as meta_service;
use crate::domain::player::model::PlaybackTrack;
#[cfg(not(test))]
use crate::domain::playlist_playback::playable_index;
#[cfg(test)]
use crate::domain::playlists::model::{CollectionGroupOwner, Group, Music};
use crate::domain::playlists::repo::PlaylistPlaybackTrackSource;
#[cfg(not(test))]
use anyhow::{Context, Result, anyhow};
use appdb::{VectorDistance, VectorIndexType, impl_hnsw_index};
use burn_ndarray::{NdArray, NdArrayDevice};
use burn_tensor::{Tensor, TensorData, backend::Backend};
use burn_wgpu::{Wgpu, WgpuDevice};
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
use std::panic::{AssertUnwindSafe, catch_unwind};
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
const AUDIO_STYLE_DISTANCE_SOFTMIN_BETA: f32 = 6.0;
const AUDIO_STYLE_LIKED_WEIGHT_MULTIPLIER: f32 = 1.35;
const AUDIO_STYLE_LOCAL_DENSITY_TOP_K: usize = 10;
const AUDIO_STYLE_BASIN_FATIGUE_DECAY: f32 = 0.86;
const AUDIO_STYLE_BASIN_FATIGUE_IMPULSE: f32 = 1.0;
const AUDIO_STYLE_BASIN_FATIGUE_STRENGTH: f32 = 1.0;
const AUDIO_STYLE_BASIN_HOMEOSTATIC_DECAY: f32 = 0.93;
const AUDIO_STYLE_BASIN_HOMEOSTATIC_IMPULSE: f32 = 1.0;
const AUDIO_STYLE_BASIN_HOMEOSTATIC_STRENGTH: f32 = 3.40;
const AUDIO_STYLE_BASIN_RUN_HAZARD_STRENGTH: f32 = 0.95;
// Basin pressure breaks near-distance ties, but the current track distance stays the primary axis.
const AUDIO_STYLE_BASIN_PENALTY_CAP: f32 = 2.0;
const AUDIO_STYLE_ROUTE_RECENT_WINDOW: usize = 48;
const AUDIO_STYLE_ROUTE_STYLE_SIMILARITY_FLOOR: f32 = 0.18;
const AUDIO_STYLE_ROUTE_STYLE_PRESSURE_DECAY: f32 = 0.92;
const AUDIO_STYLE_ROUTE_STYLE_PRESSURE_STRENGTH: f32 = 1.15;
const AUDIO_STYLE_ROUTE_STYLE_PRESSURE_CAP: f32 = 1.25;
const AUDIO_STYLE_LIKED_ROUTE_PRESSURE_SCALE: f32 = 0.30;
#[cfg(not(test))]
const AUDIO_STYLE_COMPLETED_SNAPSHOT_FALLBACK_LIMIT: usize = 8;
#[cfg(not(test))]
const AUDIO_STYLE_INPUT_CHANGE_DEBOUNCE_MS: u64 = 500;
const AUDIO_STYLE_LOG_TARGET: &str = "playlist_audio_style";

#[allow(dead_code)]
struct AudioStyleEmbeddingVectorIndex;

impl_hnsw_index!(
    AudioStyleEmbeddingVectorIndex,
    name: "audio_style_embedding_vector_hnsw",
    table: "audio_style_embedding",
    field: "embedding",
    dimension: AUDIO_STYLE_EMBEDDING_WIDTH,
    vector_type: VectorIndexType::F32,
    distance: VectorDistance::Cosine,
    ef_construction: 150,
    m: 12,
    concurrently: true,
);

#[cfg(not(test))]
static AUDIO_STYLE_RECOMMENDATION_RUNTIME: OnceLock<Arc<AudioStyleRecommendationRuntime>> =
    OnceLock::new();

#[cfg(not(test))]
static AUDIO_STYLE_PENDING_INPUT_CHANGES: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PlaybackTrackKey {
    music_url: String,
    file_path: PathBuf,
    start_ms: u32,
    end_ms: u32,
}

impl PlaybackTrackKey {
    fn empty_anchor() -> Self {
        Self {
            music_url: String::new(),
            file_path: PathBuf::new(),
            start_ms: 0,
            end_ms: 0,
        }
    }
}

#[derive(Debug, Clone)]
struct AudioStyleIndexedTrack {
    track: PlaybackTrack,
    source: PlaylistPlaybackTrackSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PlaybackAttractorBasinKey {
    value: String,
}

#[derive(Debug, Clone)]
struct PlaybackAttractorBasinPressure {
    current_basin: Option<PlaybackAttractorBasinKey>,
    current_basin_run: usize,
    fatigue: HashMap<PlaybackAttractorBasinKey, f32>,
    usage: HashMap<PlaybackAttractorBasinKey, f32>,
    target_share: HashMap<PlaybackAttractorBasinKey, f32>,
}

#[derive(Debug, Clone)]
struct AudioStyleReadOnlyRoutePressure {
    candidate_penalties: Vec<f32>,
}

struct AudioStyleRoutePressureCandidate<'a> {
    embedding: &'a AudioStyleEmbedding,
    anchor_similarity: f32,
    liked: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct AudioStyleCandidateDiagnostics {
    pub(crate) anchor_embedded: bool,
    pub(crate) embedded_candidate_count: usize,
    pub(crate) valid_similarity_count: usize,
    pub(crate) selected_basin: Option<String>,
    pub(crate) top_candidate_basins: Vec<AudioStyleCandidateBasinDiagnostics>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AudioStyleCandidateBasinDiagnostics {
    pub(crate) basin: String,
    pub(crate) candidate_count: usize,
    pub(crate) embedded_candidate_count: usize,
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

type AudioStyleEmbeddingMap = HashMap<PlaybackTrackKey, Arc<AudioStyleEmbedding>>;
type AudioStyleCpuTensorBackend = NdArray<f32, i64>;
type AudioStyleHardwareTensorBackend = Wgpu<f32, i64>;

pub(crate) struct AudioStyleEmbeddingCache {
    cache_root: PathBuf,
    ffmpeg_path: PathBuf,
}

pub(crate) struct AudioStylePlaylistPlaybackRecommender {
    embeddings: AudioStyleEmbeddingMap,
    indexed_tracks: HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
    sampling_geometry: Option<AudioStyleSamplingGeometry>,
    trained: bool,
}

#[derive(Clone)]
struct AudioStyleModelState {
    embeddings: AudioStyleEmbeddingMap,
    indexed_tracks: HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
    stats: AudioStyleStats,
    neighbor_index: AudioStyleNeighborIndex,
}

struct AudioStyleModelUpdateFailure {
    #[allow(dead_code)]
    state: AudioStyleModelState,
    message: String,
}

impl AudioStyleModelUpdateFailure {
    fn into_message(self) -> String {
        self.message
    }
}

#[derive(Clone)]
struct AudioStyleStats {
    count: usize,
    sum: Vec<f32>,
}

#[derive(Clone)]
struct AudioStyleNeighborIndex {
    neighbors: HashMap<PlaybackTrackKey, Vec<PlaybackTrackKey>>,
    similarity_low: f32,
    similarity_high: f32,
}

#[derive(Clone)]
struct AudioStyleSamplingGeometry {
    mean: Vec<f32>,
    local_density: HashMap<PlaybackTrackKey, f32>,
    similarity_low: f32,
    similarity_high: f32,
}

enum AudioStyleTensorRuntime {
    Hardware(WgpuDevice),
    Cpu(NdArrayDevice),
}

struct AudioStyleTensorMatrix {
    keys: Vec<PlaybackTrackKey>,
    flat_values: Vec<f32>,
}

#[derive(Clone)]
pub(crate) struct AudioStyleModelSnapshot {
    generation: u64,
    state: Arc<AudioStyleModelState>,
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
    pub(crate) diagnostics: AudioStyleCandidateDiagnostics,
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
    stable_snapshot: RwLock<Option<Arc<AudioStyleModelSnapshot>>>,
    nightly_snapshot: RwLock<Option<Arc<AudioStyleModelSnapshot>>>,
    completed_snapshots: RwLock<Vec<Arc<AudioStyleModelSnapshot>>>,
    training: Mutex<AudioStyleTrainingState>,
    next_generation: AtomicU64,
    next_training_run_id: AtomicU64,
}

#[cfg(not(test))]
#[derive(Debug, Default)]
struct AudioStyleTrainingState {
    running: bool,
    rerun_requested: bool,
    debounce_pending: bool,
}

#[cfg(not(test))]
impl AudioStyleRecommendationRuntime {
    fn request_training(self: &Arc<Self>, reason: &'static str) {
        let should_spawn = match self.training.lock() {
            Ok(mut training) => {
                if training.running {
                    training.rerun_requested = true;
                    log::info!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_training_request_coalesced reason={reason} running=true rerun_requested=true"
                    );
                    false
                } else {
                    training.running = true;
                    log::info!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_training_request_accepted reason={reason}"
                    );
                    true
                }
            }
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_training_state_error reason={reason} error=\"lock_poisoned\""
                );
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
            let run_id = self.next_training_run_id.fetch_add(1, Ordering::SeqCst) + 1;
            let started = Instant::now();
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_started run_id={run_id} reason={reason}"
            );
            if let Err(error) = self.train_and_publish(reason).await {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_training_failed run_id={run_id} reason={reason} elapsed_ms={} error=\"{}\"",
                    started.elapsed().as_millis(),
                    escape_log_value(&error.to_string())
                );
            } else {
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_training_finished run_id={run_id} reason={reason} elapsed_ms={}",
                    started.elapsed().as_millis()
                );
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
                    log::error!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_training_state_error run_id={run_id} reason={reason} error=\"lock_poisoned\""
                    );
                    false
                }
            };

            if !should_continue {
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_training_idle run_id={run_id} reason={reason}"
                );
                return;
            }
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_rerun run_id={run_id} previous_reason={reason} next_reason=coalesced_update"
            );
            reason = "coalesced_update";
        }
    }

    async fn train_and_publish(self: &Arc<Self>, reason: &'static str) -> Result<()> {
        let started = Instant::now();
        let ffmpeg_path = crate::utils::binaries::ensure_managed_binary(
            &self.app,
            crate::utils::binaries::ManagedBinary::Ffmpeg,
        )
        .map_err(|error| anyhow!(error))?;
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_dependency_ready reason={reason} binary=ffmpeg path=\"{}\"",
            escape_log_value(&ffmpeg_path.display().to_string())
        );
        let cache_started = Instant::now();
        let cache = AudioStyleEmbeddingCache::new(
            ffmpeg_path,
            audio_style_embedding_cache_root(&self.app)?,
        )
        .map_err(|error| anyhow!(error))?;
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_cache_ready reason={reason} elapsed_ms={}",
            cache_started.elapsed().as_millis()
        );
        let save_root_started = Instant::now();
        let save_root = meta_service::resolve_save_root(&self.app).await?;
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_save_root_ready reason={reason} elapsed_ms={} path=\"{}\"",
            save_root_started.elapsed().as_millis(),
            escape_log_value(&save_root.display().to_string())
        );
        let sources_started = Instant::now();
        let sources =
            crate::domain::playlists::repo::load_audio_style_training_track_sources().await?;
        let source_count = sources.len();
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_sources_loaded reason={reason} sources={source_count} elapsed_ms={}",
            sources_started.elapsed().as_millis()
        );
        let resolve_started = Instant::now();
        let resolved = resolve_audio_style_training_tracks(&save_root, sources);
        let indexed_tracks = resolved.indexed_tracks;
        let indexed_track_count = indexed_tracks.len();
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_inputs_ready reason={reason} indexed_tracks={indexed_track_count} elapsed_ms={}",
            resolve_started.elapsed().as_millis()
        );

        let previous_snapshot = self.stable_snapshot();
        let generation_runtime = Arc::clone(self);
        let publish_runtime = Arc::clone(self);
        let build_started = Instant::now();
        let final_snapshot = tauri::async_runtime::spawn_blocking(move || {
            AudioStyleModelSnapshot::refresh_from_indexed_tracks_progressively(
                previous_snapshot.as_deref(),
                &cache,
                indexed_tracks,
                || {
                    generation_runtime
                        .next_generation
                        .fetch_add(1, Ordering::SeqCst)
                        + 1
                },
                |snapshot| publish_runtime.publish_nightly_snapshot(snapshot),
            )
        })
        .await
        .context("audio style model update task panicked")?
        .map_err(|error| anyhow!(error.into_message()))?;
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_snapshot_built reason={reason} generation={} elapsed_ms={}",
            final_snapshot.generation(),
            build_started.elapsed().as_millis()
        );
        self.publish_stable_snapshot(final_snapshot);
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_publish_complete reason={reason} elapsed_ms={}",
            started.elapsed().as_millis()
        );

        Ok(())
    }

    fn publish_nightly_snapshot(&self, snapshot: AudioStyleModelSnapshot) {
        let generation = snapshot.generation();
        match self.nightly_snapshot.write() {
            Ok(mut nightly) => {
                *nightly = Some(Arc::new(snapshot));
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_snapshot_published stage=nightly generation={generation}"
                );
            }
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_snapshot_publish_failed stage=nightly generation={generation} error=\"lock_poisoned\""
                );
            }
        }
    }

    fn stable_snapshot(&self) -> Option<Arc<AudioStyleModelSnapshot>> {
        self.stable_snapshot
            .read()
            .ok()
            .and_then(|snapshot| snapshot.clone())
    }

    fn publish_stable_snapshot(&self, snapshot: AudioStyleModelSnapshot) {
        let snapshot = Arc::new(snapshot);
        let generation = snapshot.generation();
        match self.stable_snapshot.write() {
            Ok(mut stable) => {
                *stable = Some(Arc::clone(&snapshot));
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_snapshot_published stage=stable generation={generation}"
                );
                playable_index::request_ready_refresh();
            }
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_snapshot_publish_failed stage=completed generation={generation} error=\"lock_poisoned\""
                );
            }
        }

        match self.nightly_snapshot.write() {
            Ok(mut nightly) => {
                if nightly
                    .as_ref()
                    .is_some_and(|candidate| candidate.generation <= generation)
                {
                    *nightly = None;
                }
            }
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_nightly_snapshot_clear_failed stable_generation={generation} error=\"lock_poisoned\""
                );
            }
        }

        match self.completed_snapshots.write() {
            Ok(mut completed) => {
                if completed
                    .last()
                    .is_none_or(|existing| existing.generation != snapshot.generation)
                {
                    completed.push(snapshot);
                }
                if completed.len() > AUDIO_STYLE_COMPLETED_SNAPSHOT_FALLBACK_LIMIT {
                    let excess = completed.len() - AUDIO_STYLE_COMPLETED_SNAPSHOT_FALLBACK_LIMIT;
                    completed.drain(0..excess);
                }
            }
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_completed_snapshot_store_failed generation={generation} error=\"lock_poisoned\""
                );
            }
        }
    }

    fn snapshots_for_anchor(&self, track: &PlaybackTrack) -> Vec<Arc<AudioStyleModelSnapshot>> {
        let mut snapshots = Vec::new();
        if let Some(snapshot) = self.stable_snapshot() {
            snapshots.push(snapshot);
        }
        if let Ok(completed) = self.completed_snapshots.read() {
            for snapshot in completed.iter().rev() {
                if snapshots
                    .iter()
                    .any(|candidate| candidate.generation == snapshot.generation)
                {
                    continue;
                }
                snapshots.push(Arc::clone(snapshot));
            }
        }

        choose_audio_style_model_snapshots_for_anchor(track, snapshots)
    }
}

#[cfg(not(test))]
pub(crate) fn initialize_audio_style_recommendation_runtime(app: AppHandle) {
    let runtime = AUDIO_STYLE_RECOMMENDATION_RUNTIME.get_or_init(|| {
        Arc::new(AudioStyleRecommendationRuntime {
            app,
            stable_snapshot: RwLock::new(None),
            nightly_snapshot: RwLock::new(None),
            completed_snapshots: RwLock::new(Vec::new()),
            training: Mutex::new(AudioStyleTrainingState::default()),
            next_generation: AtomicU64::new(0),
            next_training_run_id: AtomicU64::new(0),
        })
    });

    AUDIO_STYLE_PENDING_INPUT_CHANGES.store(0, Ordering::SeqCst);
    runtime.request_training("startup");
}

#[cfg(not(test))]
pub(crate) fn notify_audio_style_training_inputs_changed(reason: &'static str) {
    let Some(runtime) = AUDIO_STYLE_RECOMMENDATION_RUNTIME.get() else {
        let pending_changes = AUDIO_STYLE_PENDING_INPUT_CHANGES.fetch_add(1, Ordering::SeqCst) + 1;
        log::warn!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_request_queued_before_runtime reason={reason} pending={pending_changes}"
        );
        return;
    };

    runtime.request_training_after_input_change_debounce(reason);
}

#[cfg(not(test))]
pub(crate) fn published_audio_style_model_snapshot() -> Option<Arc<AudioStyleModelSnapshot>> {
    AUDIO_STYLE_RECOMMENDATION_RUNTIME
        .get()
        .and_then(|runtime| runtime.stable_snapshot())
}

#[cfg(not(test))]
#[derive(Debug)]
pub(crate) enum AudioStyleCenterlessSourceStatus {
    Ready(PlaylistPlaybackTrackSource, AudioStyleCandidateSelection),
    ModelUnavailable,
    NoScopedCandidate,
}

#[cfg(not(test))]
pub(crate) fn published_audio_style_centerless_source(
    belongs_to_scope: impl Fn(&PlaylistPlaybackTrackSource) -> bool,
) -> AudioStyleCenterlessSourceStatus {
    let Some(snapshot) = AUDIO_STYLE_RECOMMENDATION_RUNTIME
        .get()
        .and_then(|runtime| runtime.stable_snapshot())
    else {
        return AudioStyleCenterlessSourceStatus::ModelUnavailable;
    };

    snapshot
        .recommender()
        .propose_centerless_source(belongs_to_scope)
        .map(|(source, mut selection)| {
            selection.model_generation = Some(snapshot.generation());
            AudioStyleCenterlessSourceStatus::Ready(source, selection)
        })
        .unwrap_or(AudioStyleCenterlessSourceStatus::NoScopedCandidate)
}

#[cfg(not(test))]
pub(crate) fn published_audio_style_model_snapshots_for_anchor(
    track: &PlaybackTrack,
) -> Vec<Arc<AudioStyleModelSnapshot>> {
    AUDIO_STYLE_RECOMMENDATION_RUNTIME
        .get()
        .map(|runtime| runtime.snapshots_for_anchor(track))
        .unwrap_or_default()
}

#[cfg(not(test))]
impl AudioStyleRecommendationRuntime {
    fn request_training_after_input_change_debounce(self: &Arc<Self>, reason: &'static str) {
        let should_spawn = match self.training.lock() {
            Ok(mut training) => {
                if training.debounce_pending {
                    false
                } else {
                    training.debounce_pending = true;
                    true
                }
            }
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_training_debounce_error reason={reason} error=\"lock_poisoned\""
                );
                false
            }
        };
        if !should_spawn {
            return;
        }

        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(
                AUDIO_STYLE_INPUT_CHANGE_DEBOUNCE_MS,
            ))
            .await;

            let debounce_released = match runtime.training.lock() {
                Ok(mut training) => {
                    training.debounce_pending = false;
                    true
                }
                Err(_) => {
                    log::error!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_training_debounce_release_error reason={reason} error=\"lock_poisoned\""
                    );
                    false
                }
            };
            if !debounce_released {
                return;
            }

            runtime.request_training(reason);
        });
    }
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

impl AudioStyleTensorRuntime {
    fn new() -> Self {
        let hardware = Self::Hardware(WgpuDevice::DefaultDevice);
        if hardware.backend_is_available() {
            hardware
        } else {
            Self::Cpu(NdArrayDevice::Cpu)
        }
    }

    fn backend_is_available(&self) -> bool {
        match self {
            Self::Hardware(device) => run_audio_style_tensor_op(|| {
                let probe = Tensor::<AudioStyleHardwareTensorBackend, 1>::from_data(
                    TensorData::new(vec![1.0_f32], [1]),
                    device,
                );
                AudioStyleHardwareTensorBackend::sync(device).ok()?;
                let values = probe.into_data().into_vec::<f32>().ok()?;
                (values == [1.0]).then_some(())
            })
            .is_some(),
            Self::Cpu(_) => true,
        }
    }

    fn matrix_from_embeddings(
        &self,
        embeddings: &AudioStyleEmbeddingMap,
    ) -> AudioStyleTensorMatrix {
        let mut keys = Vec::with_capacity(embeddings.len());
        let mut flat_values = Vec::with_capacity(embeddings.len() * AUDIO_STYLE_EMBEDDING_WIDTH);
        for (key, embedding) in embeddings {
            if embedding.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH {
                continue;
            }
            keys.push(key.clone());
            flat_values.extend_from_slice(&embedding.values);
        }
        AudioStyleTensorMatrix { keys, flat_values }
    }

    fn mean_from_matrix(&self, matrix: &AudioStyleTensorMatrix) -> Vec<f32> {
        if matrix.keys.is_empty() {
            return vec![0.0; AUDIO_STYLE_EMBEDDING_WIDTH];
        }
        match self {
            Self::Hardware(device) => {
                Self::mean_from_matrix_on::<AudioStyleHardwareTensorBackend>(matrix, device)
                    .or_else(|| {
                        Self::mean_from_matrix_on::<AudioStyleCpuTensorBackend>(
                            matrix,
                            &NdArrayDevice::Cpu,
                        )
                    })
            }
            Self::Cpu(device) => {
                Self::mean_from_matrix_on::<AudioStyleCpuTensorBackend>(matrix, device)
            }
        }
        .unwrap_or_else(|| vec![0.0; AUDIO_STYLE_EMBEDDING_WIDTH])
    }

    fn centered_similarity_matrix(
        &self,
        matrix: &AudioStyleTensorMatrix,
        mean: &[f32],
    ) -> Option<Vec<f32>> {
        match self {
            Self::Hardware(device) => Self::centered_similarity_matrix_on::<
                AudioStyleHardwareTensorBackend,
            >(matrix, mean, device)
            .or_else(|| {
                Self::centered_similarity_matrix_on::<AudioStyleCpuTensorBackend>(
                    matrix,
                    mean,
                    &NdArrayDevice::Cpu,
                )
            }),
            Self::Cpu(device) => Self::centered_similarity_matrix_on::<AudioStyleCpuTensorBackend>(
                matrix, mean, device,
            ),
        }
    }

    fn centered_similarity_to_many(
        &self,
        anchor: &AudioStyleEmbedding,
        candidates: &[&AudioStyleEmbedding],
        mean: &[f32],
    ) -> Vec<Option<f32>> {
        if candidates.is_empty()
            || anchor.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH
            || mean.len() != AUDIO_STYLE_EMBEDDING_WIDTH
            || candidates
                .iter()
                .any(|candidate| candidate.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH)
        {
            return vec![None; candidates.len()];
        }

        let values =
            match self {
                Self::Hardware(device) => Self::centered_similarity_to_many_on::<
                    AudioStyleHardwareTensorBackend,
                >(anchor, candidates, mean, device)
                .or_else(|| {
                    Self::centered_similarity_to_many_on::<AudioStyleCpuTensorBackend>(
                        anchor,
                        candidates,
                        mean,
                        &NdArrayDevice::Cpu,
                    )
                }),
                Self::Cpu(device) => Self::centered_similarity_to_many_on::<
                    AudioStyleCpuTensorBackend,
                >(anchor, candidates, mean, device),
            }
            .unwrap_or_default();
        if values.len() != candidates.len() {
            return vec![None; candidates.len()];
        }
        values.into_iter().map(Some).collect()
    }

    fn softmin_weights(
        &self,
        liked_flags: &[bool],
        similarities: &[Option<f32>],
        basin_penalties: &[f32],
    ) -> Vec<f32> {
        if similarities.is_empty() {
            return Vec::new();
        }
        let mut similarity_values = Vec::with_capacity(similarities.len());
        let mut liked_values = Vec::with_capacity(similarities.len());
        let mut penalty_values = Vec::with_capacity(similarities.len());
        let mut valid_values = Vec::with_capacity(similarities.len());
        for index in 0..similarities.len() {
            match similarities[index] {
                Some(similarity) if similarity.is_finite() => {
                    similarity_values.push(similarity);
                    valid_values.push(1.0);
                }
                _ => {
                    similarity_values.push(0.0);
                    valid_values.push(0.0);
                }
            }
            liked_values.push(if liked_flags.get(index).copied().unwrap_or(false) {
                AUDIO_STYLE_LIKED_WEIGHT_MULTIPLIER.ln()
            } else {
                0.0
            });
            penalty_values.push(basin_penalties.get(index).copied().unwrap_or(0.0).max(0.0));
        }

        let len = similarities.len();
        match self {
            Self::Hardware(device) => Self::softmin_weights_on::<AudioStyleHardwareTensorBackend>(
                similarity_values.clone(),
                liked_values.clone(),
                penalty_values.clone(),
                valid_values.clone(),
                device,
            )
            .or_else(|| {
                Self::softmin_weights_on::<AudioStyleCpuTensorBackend>(
                    similarity_values,
                    liked_values,
                    penalty_values,
                    valid_values,
                    &NdArrayDevice::Cpu,
                )
            }),
            Self::Cpu(device) => Self::softmin_weights_on::<AudioStyleCpuTensorBackend>(
                similarity_values,
                liked_values,
                penalty_values,
                valid_values,
                device,
            ),
        }
        .unwrap_or_else(|| vec![0.0; len])
    }

    fn route_pressure_penalties(
        &self,
        candidates: &[AudioStyleRoutePressureCandidate<'_>],
        recent: &[&AudioStyleEmbedding],
        mean: &[f32],
    ) -> Vec<f32> {
        if candidates.is_empty() || recent.is_empty() {
            return vec![0.0; candidates.len()];
        }

        let Some(similarities) = self.centered_similarity_grid(
            &candidates
                .iter()
                .map(|candidate| candidate.embedding)
                .collect::<Vec<_>>(),
            recent,
            mean,
        ) else {
            return vec![0.0; candidates.len()];
        };

        let mut penalties = vec![0.0; candidates.len()];
        for (candidate_index, candidate) in candidates.iter().enumerate() {
            let mut pressure = 0.0_f32;
            let mut decay = 1.0_f32;
            for recent_index in 0..recent.len() {
                let style_similarity = similarities[candidate_index * recent.len() + recent_index];
                let excess = (style_similarity - AUDIO_STYLE_ROUTE_STYLE_SIMILARITY_FLOOR).max(0.0);
                pressure += decay * excess;
                decay *= AUDIO_STYLE_ROUTE_STYLE_PRESSURE_DECAY;
            }

            let anchor_distance = (1.0 - candidate.anchor_similarity.clamp(-1.0, 1.0)) * 0.5;
            let continuity_gate = (1.0 - anchor_distance).clamp(0.0, 1.0);
            let liked_scale = if candidate.liked {
                AUDIO_STYLE_LIKED_ROUTE_PRESSURE_SCALE
            } else {
                1.0
            };
            penalties[candidate_index] = (pressure
                * continuity_gate
                * AUDIO_STYLE_ROUTE_STYLE_PRESSURE_STRENGTH
                * liked_scale)
                .clamp(0.0, AUDIO_STYLE_ROUTE_STYLE_PRESSURE_CAP);
        }
        penalties
    }

    fn centered_similarity_grid(
        &self,
        anchors: &[&AudioStyleEmbedding],
        candidates: &[&AudioStyleEmbedding],
        mean: &[f32],
    ) -> Option<Vec<f32>> {
        if anchors.is_empty()
            || candidates.is_empty()
            || mean.len() != AUDIO_STYLE_EMBEDDING_WIDTH
            || anchors
                .iter()
                .chain(candidates.iter())
                .any(|embedding| embedding.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH)
        {
            return None;
        }

        match self {
            Self::Hardware(device) => Self::centered_similarity_grid_on::<
                AudioStyleHardwareTensorBackend,
            >(anchors, candidates, mean, device)
            .or_else(|| {
                Self::centered_similarity_grid_on::<AudioStyleCpuTensorBackend>(
                    anchors,
                    candidates,
                    mean,
                    &NdArrayDevice::Cpu,
                )
            }),
            Self::Cpu(device) => Self::centered_similarity_grid_on::<AudioStyleCpuTensorBackend>(
                anchors, candidates, mean, device,
            ),
        }
    }

    fn mean_from_matrix_on<B: Backend>(
        matrix: &AudioStyleTensorMatrix,
        device: &B::Device,
    ) -> Option<Vec<f32>> {
        run_audio_style_tensor_op(|| {
            Self::matrix_tensor::<B>(matrix, device)
                .mean_dim(0)
                .into_data()
                .into_vec::<f32>()
                .ok()
        })
        .flatten()
    }

    fn centered_similarity_matrix_on<B: Backend>(
        matrix: &AudioStyleTensorMatrix,
        mean: &[f32],
        device: &B::Device,
    ) -> Option<Vec<f32>> {
        if matrix.keys.is_empty() || mean.len() != AUDIO_STYLE_EMBEDDING_WIDTH {
            return None;
        }
        run_audio_style_tensor_op(|| {
            let rows = matrix.keys.len();
            let embeddings = Self::matrix_tensor::<B>(matrix, device);
            let mean = Self::vector_tensor::<B>(mean, device)?
                .unsqueeze_dim::<2>(0)
                .expand([rows, AUDIO_STYLE_EMBEDDING_WIDTH]);
            let centered = embeddings - mean;
            let norms = centered
                .clone()
                .square()
                .sum_dim(1)
                .sqrt()
                .clamp_min(1.0e-6);
            let denom = norms.clone().matmul(norms.transpose()).clamp_min(1.0e-6);
            let similarities = (centered.clone().matmul(centered.transpose()) / denom)
                .clamp(-1.0, 1.0)
                .into_data()
                .into_vec::<f32>()
                .ok()?;
            if similarities.len() == rows * rows {
                Some(similarities)
            } else {
                None
            }
        })
        .flatten()
    }

    fn centered_similarity_to_many_on<B: Backend>(
        anchor: &AudioStyleEmbedding,
        candidates: &[&AudioStyleEmbedding],
        mean: &[f32],
        device: &B::Device,
    ) -> Option<Vec<f32>> {
        run_audio_style_tensor_op(|| {
            let candidate_matrix = Self::embedding_refs_tensor::<B>(candidates, device);
            let mean_row = Self::vector_tensor::<B>(mean, device)?.unsqueeze_dim::<2>(0);
            let centered_candidates = candidate_matrix
                - mean_row
                    .clone()
                    .expand([candidates.len(), AUDIO_STYLE_EMBEDDING_WIDTH]);
            let centered_anchor =
                Self::vector_tensor::<B>(&anchor.values, device)? - mean_row.squeeze_dim::<1>(0);

            let candidate_norms = centered_candidates
                .clone()
                .square()
                .sum_dim(1)
                .sqrt()
                .clamp_min(1.0e-6);
            let anchor_norm = centered_anchor
                .clone()
                .square()
                .sum()
                .sqrt()
                .clamp_min(1.0e-6);
            let dots = centered_candidates
                .matmul(centered_anchor.reshape([AUDIO_STYLE_EMBEDDING_WIDTH, 1]));
            let anchor_norm = anchor_norm.reshape([1, 1]).expand([candidates.len(), 1]);
            (dots / (candidate_norms * anchor_norm).clamp_min(1.0e-6))
                .clamp(-1.0, 1.0)
                .into_data()
                .into_vec::<f32>()
                .ok()
        })
        .flatten()
    }

    fn softmin_weights_on<B: Backend>(
        similarity_values: Vec<f32>,
        liked_values: Vec<f32>,
        penalty_values: Vec<f32>,
        valid_values: Vec<f32>,
        device: &B::Device,
    ) -> Option<Vec<f32>> {
        run_audio_style_tensor_op(|| {
            let len = similarity_values.len();
            let similarity =
                Tensor::<B, 1>::from_data(TensorData::new(similarity_values, [len]), device);
            let liked_bonus =
                Tensor::<B, 1>::from_data(TensorData::new(liked_values, [len]), device);
            let penalties =
                Tensor::<B, 1>::from_data(TensorData::new(penalty_values, [len]), device);
            let valid = Tensor::<B, 1>::from_data(TensorData::new(valid_values, [len]), device);
            let distance = (1.0 - similarity.clamp(-1.0, 1.0)) * 0.5;
            let logits: Tensor<B, 1> =
                distance * -AUDIO_STYLE_DISTANCE_SOFTMIN_BETA - penalties + liked_bonus;
            (logits.clamp(-30.0, 30.0).exp() * valid)
                .into_data()
                .into_vec::<f32>()
                .ok()
        })
        .flatten()
    }

    fn centered_similarity_grid_on<B: Backend>(
        anchors: &[&AudioStyleEmbedding],
        candidates: &[&AudioStyleEmbedding],
        mean: &[f32],
        device: &B::Device,
    ) -> Option<Vec<f32>> {
        run_audio_style_tensor_op(|| {
            let anchor_matrix = Self::embedding_refs_tensor::<B>(anchors, device);
            let candidate_matrix = Self::embedding_refs_tensor::<B>(candidates, device);
            let anchor_count = anchors.len();
            let candidate_count = candidates.len();
            let mean_row = Self::vector_tensor::<B>(mean, device)?.unsqueeze_dim::<2>(0);
            let centered_anchors = anchor_matrix
                - mean_row
                    .clone()
                    .expand([anchor_count, AUDIO_STYLE_EMBEDDING_WIDTH]);
            let centered_candidates =
                candidate_matrix - mean_row.expand([candidate_count, AUDIO_STYLE_EMBEDDING_WIDTH]);
            let anchor_norms = centered_anchors
                .clone()
                .square()
                .sum_dim(1)
                .sqrt()
                .clamp_min(1.0e-6);
            let candidate_norms = centered_candidates
                .clone()
                .square()
                .sum_dim(1)
                .sqrt()
                .clamp_min(1.0e-6);
            let denom = anchor_norms
                .matmul(candidate_norms.transpose())
                .clamp_min(1.0e-6);
            let values = (centered_anchors.matmul(centered_candidates.transpose()) / denom)
                .clamp(-1.0, 1.0)
                .into_data()
                .into_vec::<f32>()
                .ok()?;
            if values.len() == anchor_count * candidate_count {
                Some(values)
            } else {
                None
            }
        })
        .flatten()
    }

    fn matrix_tensor<B: Backend>(
        matrix: &AudioStyleTensorMatrix,
        device: &B::Device,
    ) -> Tensor<B, 2> {
        Tensor::<B, 2>::from_data(
            TensorData::new(
                matrix.flat_values.clone(),
                [matrix.keys.len(), AUDIO_STYLE_EMBEDDING_WIDTH],
            ),
            device,
        )
    }

    fn vector_tensor<B: Backend>(values: &[f32], device: &B::Device) -> Option<Tensor<B, 1>> {
        if values.len() != AUDIO_STYLE_EMBEDDING_WIDTH {
            return None;
        }
        Some(Tensor::<B, 1>::from_data(
            TensorData::new(values.to_vec(), [AUDIO_STYLE_EMBEDDING_WIDTH]),
            device,
        ))
    }

    fn embedding_refs_tensor<B: Backend>(
        embeddings: &[&AudioStyleEmbedding],
        device: &B::Device,
    ) -> Tensor<B, 2> {
        let mut flat_values = Vec::with_capacity(embeddings.len() * AUDIO_STYLE_EMBEDDING_WIDTH);
        for embedding in embeddings {
            flat_values.extend_from_slice(&embedding.values);
        }
        Tensor::<B, 2>::from_data(
            TensorData::new(flat_values, [embeddings.len(), AUDIO_STYLE_EMBEDDING_WIDTH]),
            device,
        )
    }
}

fn run_audio_style_tensor_op<T>(op: impl FnOnce() -> T) -> Option<T> {
    catch_unwind(AssertUnwindSafe(op)).ok()
}

impl AudioStyleSamplingGeometry {
    fn from_state(state: &AudioStyleModelState) -> Option<Self> {
        if state.embeddings.len() < 2 {
            return None;
        }

        let mean = state.stats.mean();
        let local_density = state
            .neighbor_index
            .local_density_map(&state.embeddings, &mean);
        Some(Self {
            mean,
            local_density,
            similarity_low: state.neighbor_index.similarity_low,
            similarity_high: state.neighbor_index.similarity_high,
        })
    }

    fn corrected_similarity(
        &self,
        embeddings: &AudioStyleEmbeddingMap,
        left: &PlaybackTrackKey,
        right: &PlaybackTrackKey,
    ) -> Option<f32> {
        self.corrected_similarity_for_embeddings(
            left,
            right,
            embeddings.get(left)?,
            embeddings.get(right)?,
        )
    }

    fn corrected_similarity_for_embeddings(
        &self,
        left: &PlaybackTrackKey,
        right: &PlaybackTrackKey,
        left_embedding: &AudioStyleEmbedding,
        right_embedding: &AudioStyleEmbedding,
    ) -> Option<f32> {
        let left_density = self.local_density.get(left).copied().unwrap_or(0.0);
        let right_density = self.local_density.get(right).copied().unwrap_or(0.0);
        let similarity = centered_cosine(left_embedding, right_embedding, &self.mean)?;
        let corrected = 2.0 * similarity - left_density - right_density;
        Some(
            minmax_unit_similarity(corrected, self.similarity_low, self.similarity_high)
                .clamp(-1.0, 1.0),
        )
    }
}

impl AudioStyleModelState {
    fn refresh_from_with_progress(
        previous: Option<&Self>,
        cache: &AudioStyleEmbeddingCache,
        indexed_tracks: Vec<AudioStyleIndexedTrack>,
        mut on_progress: impl FnMut(Self),
    ) -> Result<Self, AudioStyleModelUpdateFailure> {
        let mut indexed_by_key = HashMap::new();
        let mut ordered_tracks = Vec::new();
        let mut seen = HashSet::new();

        for indexed in indexed_tracks {
            let track = indexed.track;
            let key = PlaybackTrackKey::from_track(&track);
            if !seen.insert(key.clone()) {
                continue;
            }
            indexed_by_key.insert(
                key.clone(),
                AudioStyleIndexedTrack {
                    track: track.clone(),
                    source: indexed.source,
                },
            );
            ordered_tracks.push((key, track));
        }

        let previous_state = previous.cloned();
        let mut embeddings = AudioStyleEmbeddingMap::new();
        let mut previous_reused = HashSet::new();
        let mut missing_tracks = Vec::new();
        let mut failed = Vec::new();
        let mut latest_state = None;

        for (key, track) in ordered_tracks {
            if let Some(embedding) = previous_state
                .as_ref()
                .and_then(|state| state.embeddings.get(&key))
            {
                embeddings.insert(key.clone(), Arc::clone(embedding));
                previous_reused.insert(key);
                continue;
            }

            missing_tracks.push((key, track));
        }

        for (key, track) in missing_tracks {
            let reused_before_insert = embeddings.keys().cloned().collect::<HashSet<_>>();

            match cache.embedding_for_track(&track) {
                Ok(embedding) => {
                    embeddings.insert(key.clone(), Arc::new(embedding));
                    let state = Self::from_embeddings(
                        latest_state.as_ref().or(previous_state.as_ref()),
                        embeddings.clone(),
                        indexed_by_key.clone(),
                        &reused_before_insert,
                    );
                    on_progress(state.clone());
                    latest_state = Some(state);
                }
                Err(error) => {
                    log::error!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_embedding_index_failed path=\"{}\" error=\"{}\"",
                        escape_log_value(&track.file_path.display().to_string()),
                        escape_log_value(&error)
                    );
                    failed.push(format!("{}: {error}", track.file_path.display()));
                }
            }
        }

        let state = latest_state.unwrap_or_else(|| {
            Self::from_embeddings(
                previous_state.as_ref(),
                embeddings,
                indexed_by_key,
                &previous_reused,
            )
        });
        if state.embeddings.is_empty() {
            return Err(AudioStyleModelUpdateFailure {
                state,
                message: if failed.is_empty() {
                    "audio style model has no indexable tracks".to_string()
                } else {
                    format!(
                        "audio style model has no indexable tracks; {} failures",
                        failed.len()
                    )
                },
            });
        }
        Ok(state)
    }

    fn from_embeddings(
        previous: Option<&Self>,
        embeddings: AudioStyleEmbeddingMap,
        indexed_tracks: HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
        previous_reused: &HashSet<PlaybackTrackKey>,
    ) -> Self {
        let stats = AudioStyleStats::from_embeddings(&embeddings);
        let neighbor_index =
            AudioStyleNeighborIndex::refresh_from(previous, &embeddings, &stats, previous_reused);
        Self {
            embeddings,
            indexed_tracks,
            stats,
            neighbor_index,
        }
    }
}

impl AudioStyleStats {
    fn from_embeddings(embeddings: &AudioStyleEmbeddingMap) -> Self {
        let runtime = AudioStyleTensorRuntime::new();
        let matrix = runtime.matrix_from_embeddings(embeddings);
        let count = matrix.keys.len();
        let mean = runtime.mean_from_matrix(&matrix);
        let scale = count as f32;
        let sum = mean.into_iter().map(|value| value * scale).collect();
        Self { count, sum }
    }

    fn mean(&self) -> Vec<f32> {
        if self.count == 0 {
            return vec![0.0; AUDIO_STYLE_EMBEDDING_WIDTH];
        }
        let scale = 1.0 / self.count as f32;
        self.sum.iter().map(|value| value * scale).collect()
    }
}

impl AudioStyleNeighborIndex {
    fn refresh_from(
        previous: Option<&AudioStyleModelState>,
        embeddings: &AudioStyleEmbeddingMap,
        stats: &AudioStyleStats,
        previous_reused: &HashSet<PlaybackTrackKey>,
    ) -> Self {
        if embeddings.len() < 2 {
            return Self {
                neighbors: HashMap::new(),
                similarity_low: -1.0,
                similarity_high: 1.0,
            };
        }

        let Some(previous) = previous else {
            return Self::from_embeddings(embeddings, stats);
        };

        let mean = stats.mean();
        let mut neighbors =
            HashMap::<PlaybackTrackKey, Vec<PlaybackTrackKey>>::with_capacity(embeddings.len());
        let deleted_keys = previous
            .embeddings
            .keys()
            .filter(|key| !embeddings.contains_key(*key))
            .collect::<HashSet<_>>();
        let added_keys = embeddings
            .keys()
            .filter(|key| !previous_reused.contains(*key))
            .cloned()
            .collect::<Vec<_>>();

        for key in embeddings.keys() {
            let should_repair = !previous_reused.contains(key)
                || previous
                    .neighbor_index
                    .neighbors
                    .get(key)
                    .is_none_or(|old_neighbors| {
                        old_neighbors
                            .iter()
                            .any(|neighbor| deleted_keys.contains(neighbor))
                    });
            if should_repair {
                neighbors.insert(
                    key.clone(),
                    Self::top_neighbors_for(key, embeddings, &mean)
                        .into_iter()
                        .map(|(neighbor, _)| neighbor)
                        .collect(),
                );
                continue;
            }

            neighbors.insert(
                key.clone(),
                previous
                    .neighbor_index
                    .neighbors
                    .get(key)
                    .into_iter()
                    .flatten()
                    .filter(|neighbor| embeddings.contains_key(*neighbor))
                    .cloned()
                    .collect(),
            );
        }

        for added_key in &added_keys {
            let Some(added_embedding) = embeddings.get(added_key) else {
                continue;
            };
            for key in embeddings.keys() {
                if key == added_key {
                    continue;
                }
                let Some(embedding) = embeddings.get(key) else {
                    continue;
                };
                let Some(similarity) = centered_cosine(embedding, added_embedding, &mean) else {
                    continue;
                };
                let mut indexed = neighbors
                    .remove(key)
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|neighbor| {
                        let neighbor_embedding = embeddings.get(&neighbor)?;
                        centered_cosine(embedding, neighbor_embedding, &mean)
                            .map(|value| (neighbor, value))
                    })
                    .collect::<Vec<_>>();
                push_audio_style_neighbor(Some(&mut indexed), added_key.clone(), similarity);
                neighbors.insert(
                    key.clone(),
                    indexed
                        .into_iter()
                        .map(|(neighbor, _)| neighbor)
                        .collect::<Vec<_>>(),
                );
            }
        }

        let local_density = audio_style_local_density_from_neighbors(embeddings, &mean, &neighbors);
        let (similarity_low, similarity_high) =
            audio_style_corrected_similarity_scale_from_neighbors(
                embeddings,
                &mean,
                &neighbors,
                &local_density,
            );
        Self {
            neighbors,
            similarity_low,
            similarity_high,
        }
    }

    fn from_embeddings(embeddings: &AudioStyleEmbeddingMap, stats: &AudioStyleStats) -> Self {
        if embeddings.len() < 2 {
            return Self {
                neighbors: HashMap::new(),
                similarity_low: -1.0,
                similarity_high: 1.0,
            };
        }

        let mean = stats.mean();
        let runtime = AudioStyleTensorRuntime::new();
        let matrix = runtime.matrix_from_embeddings(embeddings);
        let Some(similarities) = runtime.centered_similarity_matrix(&matrix, &mean) else {
            return Self::from_embeddings_pairwise(embeddings, &mean);
        };
        let mut neighbor_lists = matrix
            .keys
            .iter()
            .cloned()
            .map(|key| (key, Vec::<(PlaybackTrackKey, f32)>::new()))
            .collect::<HashMap<_, _>>();
        let row_count = matrix.keys.len();
        for left_index in 0..row_count {
            for right_index in (left_index + 1)..row_count {
                let similarity = similarities[left_index * row_count + right_index];
                push_audio_style_neighbor(
                    neighbor_lists.get_mut(&matrix.keys[left_index]),
                    matrix.keys[right_index].clone(),
                    similarity,
                );
                push_audio_style_neighbor(
                    neighbor_lists.get_mut(&matrix.keys[right_index]),
                    matrix.keys[left_index].clone(),
                    similarity,
                );
            }
        }

        let neighbors = neighbor_lists
            .into_iter()
            .map(|(key, values)| {
                (
                    key,
                    values
                        .into_iter()
                        .map(|(neighbor, _)| neighbor)
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<HashMap<_, _>>();
        let local_density = audio_style_local_density_from_neighbors(embeddings, &mean, &neighbors);
        let (similarity_low, similarity_high) =
            audio_style_corrected_similarity_scale_from_neighbors(
                embeddings,
                &mean,
                &neighbors,
                &local_density,
            );
        Self {
            neighbors,
            similarity_low,
            similarity_high,
        }
    }

    fn from_embeddings_pairwise(embeddings: &AudioStyleEmbeddingMap, mean: &[f32]) -> Self {
        let mut neighbor_lists =
            HashMap::<PlaybackTrackKey, Vec<(PlaybackTrackKey, f32)>>::with_capacity(
                embeddings.len(),
            );
        for key in embeddings.keys() {
            neighbor_lists.insert(key.clone(), Vec::new());
        }

        let keys = embeddings.keys().cloned().collect::<Vec<_>>();
        for left_index in 0..keys.len() {
            for right_index in (left_index + 1)..keys.len() {
                let left = &keys[left_index];
                let right = &keys[right_index];
                let Some(left_embedding) = embeddings.get(left) else {
                    continue;
                };
                let Some(right_embedding) = embeddings.get(right) else {
                    continue;
                };
                let Some(similarity) = centered_cosine(left_embedding, right_embedding, mean)
                else {
                    continue;
                };
                push_audio_style_neighbor(neighbor_lists.get_mut(left), right.clone(), similarity);
                push_audio_style_neighbor(neighbor_lists.get_mut(right), left.clone(), similarity);
            }
        }

        let neighbors = neighbor_lists
            .into_iter()
            .map(|(key, values)| {
                (
                    key,
                    values
                        .into_iter()
                        .map(|(neighbor, _)| neighbor)
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<HashMap<_, _>>();
        let local_density = audio_style_local_density_from_neighbors(embeddings, mean, &neighbors);
        let (similarity_low, similarity_high) =
            audio_style_corrected_similarity_scale_from_neighbors(
                embeddings,
                mean,
                &neighbors,
                &local_density,
            );
        Self {
            neighbors,
            similarity_low,
            similarity_high,
        }
    }

    fn top_neighbors_for(
        key: &PlaybackTrackKey,
        embeddings: &AudioStyleEmbeddingMap,
        mean: &[f32],
    ) -> Vec<(PlaybackTrackKey, f32)> {
        let Some(embedding) = embeddings.get(key) else {
            return Vec::new();
        };
        let mut neighbors = Vec::new();
        for (other_key, other_embedding) in embeddings {
            if other_key == key {
                continue;
            }
            let Some(similarity) = centered_cosine(embedding, other_embedding, mean) else {
                continue;
            };
            push_audio_style_neighbor(Some(&mut neighbors), other_key.clone(), similarity);
        }
        neighbors
    }

    fn local_density_map(
        &self,
        embeddings: &AudioStyleEmbeddingMap,
        mean: &[f32],
    ) -> HashMap<PlaybackTrackKey, f32> {
        audio_style_local_density_from_neighbors(embeddings, mean, &self.neighbors)
    }
}

fn push_audio_style_neighbor(
    neighbors: Option<&mut Vec<(PlaybackTrackKey, f32)>>,
    key: PlaybackTrackKey,
    similarity: f32,
) {
    let Some(neighbors) = neighbors else {
        return;
    };
    if !similarity.is_finite() {
        return;
    }
    neighbors.push((key, similarity));
    neighbors.sort_by(|left, right| right.1.total_cmp(&left.1));
    neighbors.truncate(AUDIO_STYLE_LOCAL_DENSITY_TOP_K);
}

fn centered_cosine(
    left: &AudioStyleEmbedding,
    right: &AudioStyleEmbedding,
    mean: &[f32],
) -> Option<f32> {
    AudioStyleTensorRuntime::new()
        .centered_similarity_to_many(left, &[right], mean)
        .into_iter()
        .next()
        .flatten()
}

fn centered_cosine_to_zero_mean(embedding: &AudioStyleEmbedding, mean: &[f32]) -> Option<f32> {
    if embedding.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH
        || mean.len() != AUDIO_STYLE_EMBEDDING_WIDTH
    {
        return None;
    }

    let mut dot = 0.0_f32;
    let mut norm = 0.0_f32;
    for (value, mean) in embedding.values.iter().zip(mean.iter()) {
        let centered = value - mean;
        dot += centered * -*mean;
        norm += centered * centered;
    }
    let denom = norm.sqrt();
    if denom <= 1.0e-6 {
        return None;
    }

    Some((dot / denom).clamp(-1.0, 1.0))
}

fn audio_style_local_density_from_neighbors(
    embeddings: &AudioStyleEmbeddingMap,
    mean: &[f32],
    neighbors: &HashMap<PlaybackTrackKey, Vec<PlaybackTrackKey>>,
) -> HashMap<PlaybackTrackKey, f32> {
    let mut result = HashMap::with_capacity(embeddings.len());
    for (key, embedding) in embeddings {
        let similarities = neighbors
            .get(key)
            .into_iter()
            .flatten()
            .filter_map(|neighbor| {
                embeddings
                    .get(neighbor)
                    .and_then(|other| centered_cosine(embedding, other, mean))
            })
            .filter(|similarity| similarity.is_finite())
            .collect::<Vec<_>>();
        if similarities.is_empty() {
            result.insert(key.clone(), 0.0);
            continue;
        }
        let density = similarities.iter().copied().sum::<f32>() / similarities.len() as f32;
        result.insert(key.clone(), density);
    }
    result
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

    #[cfg(test)]
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

    #[cfg(test)]
    pub(crate) fn write_test_embedding_for_track(
        &self,
        track: &PlaybackTrack,
        values: Vec<f32>,
    ) -> Result<(), String> {
        let embedding = AudioStyleEmbedding::normalize(values)
            .ok_or_else(|| "test audio style embedding has invalid width".to_string())?;
        let cache_key = build_audio_style_embedding_cache_key(track)?;
        let cache_path = self.cache_root.join(format!("{cache_key}.json"));
        write_cached_audio_style_embedding(&cache_path, &embedding)
    }
}

impl AudioStylePlaylistPlaybackRecommender {
    #[cfg(test)]
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
                    embeddings.insert(key, Arc::new(embedding));
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
                indexed_tracks: HashMap::new(),
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
                    .map(|embedding| (PlaybackTrackKey::from_track(&track), Arc::new(embedding)))
            })
            .collect::<HashMap<_, _>>();
        Self::from_trained_embeddings(embeddings, HashMap::new())
    }

    #[cfg(test)]
    pub(crate) fn from_untrained_test_embeddings(
        values: impl IntoIterator<Item = (PlaybackTrack, Vec<f32>)>,
    ) -> Self {
        let embeddings = values
            .into_iter()
            .filter_map(|(track, values)| {
                AudioStyleEmbedding::normalize(values)
                    .map(|embedding| (PlaybackTrackKey::from_track(&track), Arc::new(embedding)))
            })
            .collect();
        Self {
            embeddings,
            indexed_tracks: HashMap::new(),
            sampling_geometry: None,
            trained: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_test_indexed_embeddings(
        values: impl IntoIterator<Item = (PlaybackTrack, Vec<f32>, String)>,
    ) -> Self {
        let mut embeddings = HashMap::new();
        let mut indexed_tracks = HashMap::new();
        for (track, values, collection_folder) in values {
            let Some(embedding) = AudioStyleEmbedding::normalize(values) else {
                continue;
            };
            let key = PlaybackTrackKey::from_track(&track);
            embeddings.insert(key.clone(), Arc::new(embedding));
            indexed_tracks.insert(
                key,
                AudioStyleIndexedTrack {
                    source: PlaylistPlaybackTrackSource {
                        collection_folder,
                        music: playback_track_source_music_from_track(&track),
                    },
                    track,
                },
            );
        }
        Self::from_trained_embeddings(embeddings, indexed_tracks)
    }

    pub(crate) fn has_embedding_for(&self, track: &PlaybackTrack) -> bool {
        self.embeddings
            .contains_key(&PlaybackTrackKey::from_track(track))
    }

    pub(crate) fn propose_centerless_source(
        &self,
        belongs_to_scope: impl Fn(&PlaylistPlaybackTrackSource) -> bool,
    ) -> Option<(PlaylistPlaybackTrackSource, AudioStyleCandidateSelection)> {
        let scoped = self
            .indexed_tracks
            .values()
            .filter(|indexed| belongs_to_scope(&indexed.source))
            .collect::<Vec<_>>();
        let candidates = scoped
            .iter()
            .map(|indexed| indexed.track.clone())
            .collect::<Vec<_>>();
        let selection = select_centerless_audio_style_candidate(
            &candidates,
            &self.embeddings,
            self.sampling_geometry.as_ref(),
            self.trained,
            rand::rng().random_range(0.0..1.0),
        );
        scoped
            .get(selection.index)
            .map(|indexed| (indexed.source.clone(), selection))
    }

    #[cfg(test)]
    pub(crate) fn propose_queue(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
    ) -> Vec<PlaybackTrack> {
        self.propose_queue_with_trace(current_track, candidates)
            .tracks
    }

    #[cfg(test)]
    pub(crate) fn propose_queue_with_recent_history(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
        recently_played_tracks: &[PlaybackTrack],
    ) -> Vec<PlaybackTrack> {
        self.propose_queue_with_trace_and_recent_history(
            current_track,
            candidates,
            recently_played_tracks,
        )
        .tracks
    }

    #[cfg(test)]
    pub(crate) fn propose_queue_with_trace(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
    ) -> AudioStylePlaylistPlaybackProposal {
        self.propose_queue_with_trace_and_recent_history(current_track, candidates, &[])
    }

    pub(crate) fn propose_queue_with_trace_and_recent_history(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
        recently_played_tracks: &[PlaybackTrack],
    ) -> AudioStylePlaylistPlaybackProposal {
        let remaining = dedupe_tracks_excluding(candidates, Some(&current_track));
        let remaining =
            filter_recently_played_recommendation_candidates(remaining, recently_played_tracks);
        let mut queue = Vec::with_capacity(2);
        queue.push(current_track.clone());
        let selection = self
            .propose_next_with_trace(&current_track, remaining, recently_played_tracks)
            .map(|proposal| {
                queue.push(proposal.track);
                proposal.selection
            });
        AudioStylePlaylistPlaybackProposal {
            tracks: queue,
            selection,
        }
    }

    #[cfg(test)]
    pub(crate) fn propose_queue_after_exclude(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
    ) -> Vec<PlaybackTrack> {
        self.propose_queue_after_exclude_with_trace(current_track, candidates)
            .tracks
    }

    #[cfg(test)]
    pub(crate) fn propose_queue_after_exclude_with_trace(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
    ) -> AudioStylePlaylistPlaybackProposal {
        self.propose_queue_after_exclude_with_trace_and_recent_history(
            current_track,
            candidates,
            &[],
        )
    }

    pub(crate) fn propose_queue_after_exclude_with_trace_and_recent_history(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
        recently_played_tracks: &[PlaybackTrack],
    ) -> AudioStylePlaylistPlaybackProposal {
        let remaining = dedupe_tracks_excluding(candidates, Some(&current_track));
        let remaining =
            filter_recently_played_recommendation_candidates(remaining, recently_played_tracks);
        let mut selection = None;
        let tracks = self
            .propose_next_with_trace(&current_track, remaining, recently_played_tracks)
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
        recently_played_tracks: &[PlaybackTrack],
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
            recently_played_tracks,
            draw,
        );
        candidates
            .into_iter()
            .nth(selection.index)
            .map(|track| AudioStyleNextTrackProposal { track, selection })
    }

    #[cfg(test)]
    fn from_trained_embeddings(
        embeddings: AudioStyleEmbeddingMap,
        indexed_tracks: HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
    ) -> Self {
        let state = AudioStyleModelState::from_embeddings(
            None,
            embeddings,
            indexed_tracks,
            &HashSet::new(),
        );
        Self::from_state(&state, true)
    }

    fn from_state(state: &AudioStyleModelState, trained: bool) -> Self {
        let sampling_geometry = AudioStyleSamplingGeometry::from_state(state);
        Self {
            embeddings: state.embeddings.clone(),
            indexed_tracks: state.indexed_tracks.clone(),
            sampling_geometry,
            trained,
        }
    }

    #[cfg(test)]
    pub(crate) fn centered_similarity_for_test(
        &self,
        left: &PlaybackTrack,
        right: &PlaybackTrack,
    ) -> Option<f32> {
        let mean = &self.sampling_geometry.as_ref()?.mean;
        centered_cosine(
            self.embeddings.get(&PlaybackTrackKey::from_track(left))?,
            self.embeddings.get(&PlaybackTrackKey::from_track(right))?,
            mean,
        )
    }
}

impl AudioStyleModelSnapshot {
    #[cfg(test)]
    fn refresh(
        generation: u64,
        previous: Option<&Self>,
        cache: &AudioStyleEmbeddingCache,
        tracks: Vec<PlaybackTrack>,
    ) -> Result<Self, AudioStyleModelUpdateFailure> {
        let indexed_tracks = tracks
            .into_iter()
            .map(|track| AudioStyleIndexedTrack {
                source: PlaylistPlaybackTrackSource {
                    collection_folder: String::new(),
                    music: track
                        .source_music
                        .as_deref()
                        .cloned()
                        .unwrap_or_else(|| playback_track_source_music_from_track(&track)),
                },
                track,
            })
            .collect();
        let mut snapshots = Vec::new();
        Self::refresh_from_indexed_tracks_progressively(
            previous,
            cache,
            indexed_tracks,
            || generation,
            |snapshot| snapshots.push(snapshot),
        )?;
        Ok(snapshots
            .pop()
            .expect("audio style refresh publishes a snapshot on success"))
    }

    fn refresh_from_indexed_tracks_progressively(
        previous: Option<&Self>,
        cache: &AudioStyleEmbeddingCache,
        indexed_tracks: Vec<AudioStyleIndexedTrack>,
        mut next_generation: impl FnMut() -> u64,
        mut publish: impl FnMut(Self),
    ) -> Result<Self, AudioStyleModelUpdateFailure> {
        let mut published_progress = false;
        let mut last_published = None;
        let state = AudioStyleModelState::refresh_from_with_progress(
            previous.map(|snapshot| snapshot.state.as_ref()),
            cache,
            indexed_tracks,
            |state| {
                let snapshot = Self::from_state(next_generation(), Arc::new(state));
                published_progress = true;
                publish(snapshot.clone());
                last_published = Some(snapshot);
            },
        )?;

        if !published_progress {
            let snapshot = Self::from_state(next_generation(), Arc::new(state));
            publish(snapshot.clone());
            return Ok(snapshot);
        }

        Ok(last_published.expect("progressive refresh must publish when progress was reported"))
    }

    fn from_state(generation: u64, state: Arc<AudioStyleModelState>) -> Self {
        let recommender = Arc::new(AudioStylePlaylistPlaybackRecommender::from_state(
            state.as_ref(),
            true,
        ));
        Self {
            generation,
            state,
            recommender,
        }
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn recommender(&self) -> &AudioStylePlaylistPlaybackRecommender {
        &self.recommender
    }

    pub(crate) fn has_embedding_for(&self, track: &PlaybackTrack) -> bool {
        self.recommender.has_embedding_for(track)
    }

    #[cfg(test)]
    pub(crate) fn from_test_embeddings(
        generation: u64,
        values: impl IntoIterator<Item = (PlaybackTrack, Vec<f32>)>,
    ) -> Self {
        let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(values);
        let state = Arc::new(AudioStyleModelState::from_embeddings(
            None,
            recommender.embeddings.clone(),
            HashMap::new(),
            &HashSet::new(),
        ));
        Self::from_state(generation, state)
    }

    #[cfg(test)]
    pub(crate) fn refresh_for_test(
        generation: u64,
        previous: Option<&Self>,
        cache: &AudioStyleEmbeddingCache,
        tracks: Vec<PlaybackTrack>,
    ) -> Result<Self, String> {
        Self::refresh(generation, previous, cache, tracks).map_err(|error| error.into_message())
    }

    #[cfg(test)]
    pub(crate) fn refresh_progressively_for_test(
        first_generation: u64,
        previous: Option<&Self>,
        cache: &AudioStyleEmbeddingCache,
        tracks: Vec<PlaybackTrack>,
    ) -> Result<Vec<Self>, String> {
        let mut next_generation = first_generation;
        let mut snapshots = Vec::new();
        let indexed_tracks = tracks
            .into_iter()
            .map(|track| AudioStyleIndexedTrack {
                source: PlaylistPlaybackTrackSource {
                    collection_folder: String::new(),
                    music: track
                        .source_music
                        .as_deref()
                        .cloned()
                        .unwrap_or_else(|| playback_track_source_music_from_track(&track)),
                },
                track,
            })
            .collect();
        Self::refresh_from_indexed_tracks_progressively(
            previous,
            cache,
            indexed_tracks,
            || {
                let generation = next_generation;
                next_generation += 1;
                generation
            },
            |snapshot| snapshots.push(snapshot),
        )
        .map_err(|error| error.into_message())?;
        Ok(snapshots)
    }

    #[cfg(test)]
    pub(crate) fn embedding_arc_for_track(
        &self,
        track: &PlaybackTrack,
    ) -> Option<Arc<AudioStyleEmbedding>> {
        self.state
            .embeddings
            .get(&PlaybackTrackKey::from_track(track))
            .cloned()
    }
}

pub(crate) fn choose_audio_style_model_snapshots_for_anchor(
    track: &PlaybackTrack,
    snapshots: impl IntoIterator<Item = Arc<AudioStyleModelSnapshot>>,
) -> Vec<Arc<AudioStyleModelSnapshot>> {
    let mut snapshots = snapshots
        .into_iter()
        .filter(|snapshot| snapshot.has_embedding_for(track))
        .collect::<Vec<_>>();
    snapshots.sort_by_key(|snapshot| std::cmp::Reverse(snapshot.generation()));
    snapshots
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

pub(crate) fn filter_recently_played_recommendation_candidates(
    candidates: Vec<PlaybackTrack>,
    recently_played_tracks: &[PlaybackTrack],
) -> Vec<PlaybackTrack> {
    if recently_played_tracks.is_empty() {
        return candidates;
    }

    let played_music_ids = recently_played_tracks
        .iter()
        .map(|track| track.canonical_music_id.as_str())
        .collect::<HashSet<_>>();
    let history_filtered = candidates
        .iter()
        .filter(|candidate| {
            candidate.liked || !played_music_ids.contains(candidate.canonical_music_id.as_str())
        })
        .cloned()
        .collect::<Vec<_>>();

    if history_filtered.is_empty() {
        return candidates;
    }

    history_filtered
}

impl PlaybackAttractorBasinKey {
    fn from_track(track: &PlaybackTrack) -> Option<Self> {
        if let Some(value) = youtube_leaf_basin_from_path(&track.file_path) {
            return Some(Self { value });
        }

        if let Some(value) = parent_directory_basin_from_path(&track.file_path) {
            return Some(Self { value });
        }

        let source_music = track.source_music.as_deref()?;
        let group_url = source_music.group.url.trim();
        if group_url.is_empty() {
            return None;
        }

        Some(Self {
            value: format!("group:{}", group_url.to_ascii_lowercase()),
        })
    }
}

impl PlaybackAttractorBasinPressure {
    fn from_recent_history_and_candidates(
        recently_played_tracks: &[PlaybackTrack],
        candidates: &[PlaybackTrack],
    ) -> Self {
        let target_share = basin_target_share(candidates);
        let mut pressure = Self {
            current_basin: None,
            current_basin_run: 0,
            fatigue: HashMap::new(),
            usage: HashMap::new(),
            target_share,
        };

        for track in recently_played_tracks {
            let Some(basin) = PlaybackAttractorBasinKey::from_track(track) else {
                continue;
            };
            decay_attractor_basin_map(&mut pressure.fatigue, AUDIO_STYLE_BASIN_FATIGUE_DECAY);
            decay_attractor_basin_map(&mut pressure.usage, AUDIO_STYLE_BASIN_HOMEOSTATIC_DECAY);
            *pressure.fatigue.entry(basin.clone()).or_insert(0.0) +=
                AUDIO_STYLE_BASIN_FATIGUE_IMPULSE;
            *pressure.usage.entry(basin.clone()).or_insert(0.0) +=
                AUDIO_STYLE_BASIN_HOMEOSTATIC_IMPULSE;

            if pressure.current_basin.as_ref() == Some(&basin) {
                pressure.current_basin_run += 1;
            } else {
                pressure.current_basin = Some(basin);
                pressure.current_basin_run = 1;
            }
        }

        pressure
    }

    fn penalty_for_track(&self, track: &PlaybackTrack) -> f32 {
        let Some(basin) = PlaybackAttractorBasinKey::from_track(track) else {
            return 0.0;
        };

        let fatigue =
            self.fatigue.get(&basin).copied().unwrap_or(0.0) * AUDIO_STYLE_BASIN_FATIGUE_STRENGTH;
        let usage_share = self.usage_share(&basin);
        let target_share = self.target_share.get(&basin).copied().unwrap_or(0.0);
        let homeostatic =
            (usage_share - target_share).max(0.0) * AUDIO_STYLE_BASIN_HOMEOSTATIC_STRENGTH;
        let run_hazard = if self.current_basin.as_ref() == Some(&basin) {
            (self.current_basin_run as f32).max(1.0).ln() * AUDIO_STYLE_BASIN_RUN_HAZARD_STRENGTH
        } else {
            0.0
        };

        (fatigue + homeostatic + run_hazard)
            .max(0.0)
            .min(AUDIO_STYLE_BASIN_PENALTY_CAP)
    }

    fn usage_share(&self, basin: &PlaybackAttractorBasinKey) -> f32 {
        let total = self
            .usage
            .values()
            .copied()
            .filter(|value| value.is_finite() && *value > 0.0)
            .sum::<f32>();
        if total <= 0.0 || !total.is_finite() {
            return 0.0;
        }
        self.usage.get(basin).copied().unwrap_or(0.0).max(0.0) / total
    }
}

fn decay_attractor_basin_map(map: &mut HashMap<PlaybackAttractorBasinKey, f32>, decay: f32) {
    map.retain(|_, value| {
        *value *= decay;
        value.is_finite() && *value > 1.0e-6
    });
}

fn basin_target_share(candidates: &[PlaybackTrack]) -> HashMap<PlaybackAttractorBasinKey, f32> {
    let mut counts = HashMap::<PlaybackAttractorBasinKey, usize>::new();
    for candidate in candidates {
        let Some(basin) = PlaybackAttractorBasinKey::from_track(candidate) else {
            continue;
        };
        *counts.entry(basin).or_insert(0) += 1;
    }
    let total = counts
        .values()
        .map(|count| (*count as f32).sqrt())
        .sum::<f32>();
    if total <= 0.0 || !total.is_finite() {
        return HashMap::new();
    }
    counts
        .into_iter()
        .map(|(basin, count)| (basin, (count as f32).sqrt() / total))
        .collect()
}

fn audio_style_candidate_diagnostics(
    candidates: &[PlaybackTrack],
    embeddings: &AudioStyleEmbeddingMap,
    anchor_key: &PlaybackTrackKey,
    similarities: &[Option<f32>],
    selected_index: Option<usize>,
) -> AudioStyleCandidateDiagnostics {
    let mut basin_counts =
        HashMap::<PlaybackAttractorBasinKey, AudioStyleCandidateBasinDiagnostics>::new();
    let mut embedded_candidate_count = 0usize;

    for candidate in candidates {
        let candidate_key = PlaybackTrackKey::from_track(candidate);
        let embedded = embeddings.contains_key(&candidate_key);
        if embedded {
            embedded_candidate_count += 1;
        }

        let Some(basin) = PlaybackAttractorBasinKey::from_track(candidate) else {
            continue;
        };
        let entry = basin_counts.entry(basin.clone()).or_insert_with(|| {
            AudioStyleCandidateBasinDiagnostics {
                basin: basin.value.clone(),
                candidate_count: 0,
                embedded_candidate_count: 0,
            }
        });
        entry.candidate_count += 1;
        if embedded {
            entry.embedded_candidate_count += 1;
        }
    }

    let mut top_candidate_basins = basin_counts.into_values().collect::<Vec<_>>();
    top_candidate_basins.sort_by(|left, right| {
        right
            .candidate_count
            .cmp(&left.candidate_count)
            .then_with(|| {
                right
                    .embedded_candidate_count
                    .cmp(&left.embedded_candidate_count)
            })
            .then_with(|| left.basin.cmp(&right.basin))
    });
    top_candidate_basins.truncate(4);

    AudioStyleCandidateDiagnostics {
        anchor_embedded: embeddings.contains_key(anchor_key),
        embedded_candidate_count,
        valid_similarity_count: similarities
            .iter()
            .filter(|similarity| similarity.is_some_and(|value| value.is_finite()))
            .count(),
        selected_basin: selected_index
            .and_then(|index| candidates.get(index))
            .and_then(PlaybackAttractorBasinKey::from_track)
            .map(|basin| basin.value),
        top_candidate_basins,
    }
}

impl AudioStyleReadOnlyRoutePressure {
    fn from_decision(
        candidates: &[PlaybackTrack],
        similarities: &[Option<f32>],
        recent_tracks: &[PlaybackTrack],
        anchor_key: &PlaybackTrackKey,
        embeddings: &AudioStyleEmbeddingMap,
        geometry: &AudioStyleSamplingGeometry,
    ) -> Self {
        if candidates.is_empty() || recent_tracks.is_empty() {
            return Self {
                candidate_penalties: vec![0.0; candidates.len()],
            };
        }

        let recent = recent_tracks
            .iter()
            .rev()
            .take(AUDIO_STYLE_ROUTE_RECENT_WINDOW)
            .filter_map(|track| {
                let key = PlaybackTrackKey::from_track(track);
                if &key == anchor_key {
                    return None;
                }
                embeddings
                    .get(&key)
                    .map(|embedding| (key, embedding.as_ref()))
            })
            .collect::<Vec<_>>();
        if recent.is_empty() {
            return Self {
                candidate_penalties: vec![0.0; candidates.len()],
            };
        }
        let recent_embeddings = recent
            .iter()
            .map(|(_, embedding)| *embedding)
            .collect::<Vec<_>>();

        let pressure_candidates = candidates
            .iter()
            .enumerate()
            .filter_map(|(candidate_index, candidate)| {
                let anchor_similarity = similarities
                    .get(candidate_index)
                    .and_then(|value| *value)
                    .filter(|similarity| similarity.is_finite())?;
                let candidate_key = PlaybackTrackKey::from_track(candidate);
                let candidate_embedding = embeddings.get(&candidate_key)?;
                Some((
                    candidate_index,
                    AudioStyleRoutePressureCandidate {
                        embedding: candidate_embedding,
                        anchor_similarity,
                        liked: candidate.liked,
                    },
                ))
            })
            .collect::<Vec<_>>();
        let indexed = pressure_candidates
            .iter()
            .map(|(_, candidate)| AudioStyleRoutePressureCandidate {
                embedding: candidate.embedding,
                anchor_similarity: candidate.anchor_similarity,
                liked: candidate.liked,
            })
            .collect::<Vec<_>>();
        let values = AudioStyleTensorRuntime::new().route_pressure_penalties(
            &indexed,
            &recent_embeddings,
            &geometry.mean,
        );
        let mut raw_penalties = vec![0.0; candidates.len()];
        for ((candidate_index, _), value) in pressure_candidates.into_iter().zip(values) {
            raw_penalties[candidate_index] = value;
        }

        Self {
            candidate_penalties: raw_penalties,
        }
    }

    fn penalty_for_index(&self, index: usize) -> f32 {
        self.candidate_penalties.get(index).copied().unwrap_or(0.0)
    }
}

fn youtube_leaf_basin_from_path(path: &Path) -> Option<String> {
    let parts = normalized_path_components(path);
    let youtube_index = parts.iter().position(|part| part == "youtube")?;
    let tail = &parts[(youtube_index + 1)..];
    let basin = if tail.len() >= 3 {
        tail.get(1)
    } else {
        tail.first()
    }?;
    if basin.is_empty() {
        return None;
    }
    Some(format!("youtube:{basin}"))
}

fn parent_directory_basin_from_path(path: &Path) -> Option<String> {
    path.parent()
        .map(|parent| normalized_path_components(parent).join("/"))
        .filter(|value| !value.is_empty())
        .map(|value| format!("dir:{value}"))
}

fn normalized_path_components(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|component| {
            let text = component.as_os_str().to_string_lossy();
            let normalized = text.trim().replace('\\', "/").to_ascii_lowercase();
            if normalized.is_empty() {
                None
            } else {
                Some(normalized)
            }
        })
        .collect()
}

fn select_next_audio_style_candidate(
    candidates: &[PlaybackTrack],
    anchor_key: &PlaybackTrackKey,
    embeddings: &AudioStyleEmbeddingMap,
    sampling_geometry: Option<&AudioStyleSamplingGeometry>,
    model_trained: bool,
    recently_played_tracks: &[PlaybackTrack],
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
            diagnostics: audio_style_candidate_diagnostics(
                candidates,
                embeddings,
                anchor_key,
                &[],
                None,
            ),
        };
    }
    if !embeddings.contains_key(anchor_key) {
        return random_fallback_selection_with_diagnostics(
            candidates,
            embeddings,
            anchor_key,
            &[],
            candidates.len(),
            draw_unit,
            Some("missing_anchor_embedding"),
        );
    };
    if !model_trained {
        return random_fallback_selection_with_diagnostics(
            candidates,
            embeddings,
            anchor_key,
            &[],
            candidates.len(),
            draw_unit,
            Some("untrained_model"),
        );
    };
    let Some(geometry) = sampling_geometry else {
        return random_fallback_selection_with_diagnostics(
            candidates,
            embeddings,
            anchor_key,
            &[],
            candidates.len(),
            draw_unit,
            Some("missing_sampling_geometry"),
        );
    };

    let mut similarities = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let key = PlaybackTrackKey::from_track(candidate);
        let similarity = geometry
            .corrected_similarity(embeddings, anchor_key, &key)
            .filter(|similarity| similarity.is_finite());
        similarities.push(similarity);
    }

    let basin_pressure = PlaybackAttractorBasinPressure::from_recent_history_and_candidates(
        recently_played_tracks,
        candidates,
    );
    let route_pressure = AudioStyleReadOnlyRoutePressure::from_decision(
        candidates,
        &similarities,
        recently_played_tracks,
        anchor_key,
        embeddings,
        geometry,
    );
    let pressure_penalties = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            basin_pressure.penalty_for_track(candidate) + route_pressure.penalty_for_index(index)
        })
        .collect::<Vec<_>>();
    let weights =
        audio_style_distance_softmin_weights(candidates, &similarities, &pressure_penalties);
    let total = weights.iter().copied().sum::<f32>();

    if total <= 0.0 || !total.is_finite() {
        return random_fallback_selection_with_diagnostics(
            candidates,
            embeddings,
            anchor_key,
            &similarities,
            candidates.len(),
            draw_unit,
            Some("invalid_weights"),
        );
    }

    let mut cursor = draw_unit.clamp(0.0, 0.999_999) * total;
    let mut last_positive_index = None;
    for (index, weight) in weights.iter().copied().enumerate() {
        if weight <= 0.0 || !weight.is_finite() {
            continue;
        }
        last_positive_index = Some(index);
        if cursor <= weight {
            let similarity_diagnostics =
                audio_style_selection_similarity_diagnostics(index, &similarities);
            let candidate_diagnostics = audio_style_candidate_diagnostics(
                candidates,
                embeddings,
                anchor_key,
                &similarities,
                Some(index),
            );
            return AudioStyleCandidateSelection {
                index,
                probability: weight / total,
                uniform_probability: random_selection_probability(candidates.len()),
                similarity: similarity_diagnostics.similarity,
                best_similarity: similarity_diagnostics.best_similarity,
                local_rank_fraction: similarity_diagnostics.local_rank_fraction,
                draw_unit,
                candidate_count: candidates.len(),
                source: AudioStyleCandidateSelectionSource::AudioStyle,
                reason: None,
                model_generation: None,
                diagnostics: candidate_diagnostics,
            };
        }
        cursor -= weight;
    }
    let index = last_positive_index.unwrap_or(candidates.len() - 1);
    let similarity_diagnostics = audio_style_selection_similarity_diagnostics(index, &similarities);
    let candidate_diagnostics = audio_style_candidate_diagnostics(
        candidates,
        embeddings,
        anchor_key,
        &similarities,
        Some(index),
    );
    AudioStyleCandidateSelection {
        index,
        probability: weights[index] / total,
        uniform_probability: random_selection_probability(candidates.len()),
        similarity: similarity_diagnostics.similarity,
        best_similarity: similarity_diagnostics.best_similarity,
        local_rank_fraction: similarity_diagnostics.local_rank_fraction,
        draw_unit,
        candidate_count: candidates.len(),
        source: AudioStyleCandidateSelectionSource::AudioStyle,
        reason: None,
        model_generation: None,
        diagnostics: candidate_diagnostics,
    }
}

fn select_centerless_audio_style_candidate(
    candidates: &[PlaybackTrack],
    embeddings: &AudioStyleEmbeddingMap,
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
            diagnostics: audio_style_candidate_diagnostics(
                candidates,
                embeddings,
                &PlaybackTrackKey::empty_anchor(),
                &[],
                None,
            ),
        };
    }
    if !model_trained {
        return random_fallback_selection_from_diagnostics(
            candidates.len(),
            draw_unit,
            Some("untrained_model"),
            audio_style_candidate_diagnostics(
                candidates,
                embeddings,
                &PlaybackTrackKey::empty_anchor(),
                &[],
                Some(random_fallback_index(candidates.len(), draw_unit)),
            ),
        );
    }
    let Some(geometry) = sampling_geometry else {
        return random_fallback_selection_from_diagnostics(
            candidates.len(),
            draw_unit,
            Some("missing_sampling_geometry"),
            audio_style_candidate_diagnostics(
                candidates,
                embeddings,
                &PlaybackTrackKey::empty_anchor(),
                &[],
                Some(random_fallback_index(candidates.len(), draw_unit)),
            ),
        );
    };

    let similarities = audio_style_centerless_candidate_scores(candidates, embeddings, geometry);
    let weights = audio_style_distance_softmin_weights(candidates, &similarities, &[]);
    let total = weights.iter().copied().sum::<f32>();
    if total <= 0.0 || !total.is_finite() {
        return random_fallback_selection_from_diagnostics(
            candidates.len(),
            draw_unit,
            Some("invalid_weights"),
            audio_style_candidate_diagnostics(
                candidates,
                embeddings,
                &PlaybackTrackKey::empty_anchor(),
                &similarities,
                Some(random_fallback_index(candidates.len(), draw_unit)),
            ),
        );
    }

    let mut cursor = draw_unit.clamp(0.0, 0.999_999) * total;
    let mut last_positive_index = None;
    for (index, weight) in weights.iter().copied().enumerate() {
        if weight <= 0.0 || !weight.is_finite() {
            continue;
        }
        last_positive_index = Some(index);
        if cursor <= weight {
            return audio_style_candidate_selection_from_centerless_weight(
                candidates,
                embeddings,
                &similarities,
                index,
                weight,
                total,
                draw_unit,
            );
        }
        cursor -= weight;
    }

    let index = last_positive_index.unwrap_or(candidates.len() - 1);
    audio_style_candidate_selection_from_centerless_weight(
        candidates,
        embeddings,
        &similarities,
        index,
        weights[index],
        total,
        draw_unit,
    )
}

fn audio_style_centerless_candidate_scores(
    candidates: &[PlaybackTrack],
    embeddings: &AudioStyleEmbeddingMap,
    geometry: &AudioStyleSamplingGeometry,
) -> Vec<Option<f32>> {
    candidates
        .iter()
        .map(|candidate| {
            let key = PlaybackTrackKey::from_track(candidate);
            let embedding = embeddings.get(&key)?;
            let density = geometry.local_density.get(&key).copied().unwrap_or(0.0);
            let center_distance = centered_cosine_to_zero_mean(embedding, &geometry.mean)?;
            Some((center_distance - density).clamp(-1.0, 1.0))
        })
        .collect()
}

fn audio_style_candidate_selection_from_centerless_weight(
    candidates: &[PlaybackTrack],
    embeddings: &AudioStyleEmbeddingMap,
    similarities: &[Option<f32>],
    index: usize,
    weight: f32,
    total: f32,
    draw_unit: f32,
) -> AudioStyleCandidateSelection {
    let similarity_diagnostics = audio_style_selection_similarity_diagnostics(index, similarities);
    AudioStyleCandidateSelection {
        index,
        probability: weight / total,
        uniform_probability: random_selection_probability(candidates.len()),
        similarity: similarity_diagnostics.similarity,
        best_similarity: similarity_diagnostics.best_similarity,
        local_rank_fraction: similarity_diagnostics.local_rank_fraction,
        draw_unit,
        candidate_count: candidates.len(),
        source: AudioStyleCandidateSelectionSource::AudioStyle,
        reason: Some("centerless_initial"),
        model_generation: None,
        diagnostics: audio_style_candidate_diagnostics(
            candidates,
            embeddings,
            &PlaybackTrackKey::empty_anchor(),
            similarities,
            Some(index),
        ),
    }
}

fn audio_style_distance_softmin_weights(
    candidates: &[PlaybackTrack],
    similarities: &[Option<f32>],
    basin_penalties: &[f32],
) -> Vec<f32> {
    let liked_flags = candidates
        .iter()
        .map(|candidate| candidate.liked)
        .collect::<Vec<_>>();
    AudioStyleTensorRuntime::new().softmin_weights(&liked_flags, similarities, basin_penalties)
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

fn audio_style_corrected_similarity_scale_from_neighbors(
    embeddings: &AudioStyleEmbeddingMap,
    mean: &[f32],
    neighbors: &HashMap<PlaybackTrackKey, Vec<PlaybackTrackKey>>,
    local_density: &HashMap<PlaybackTrackKey, f32>,
) -> (f32, f32) {
    let mut values = Vec::new();
    for (left, linked) in neighbors {
        let Some(left_embedding) = embeddings.get(left) else {
            continue;
        };
        let left_density = local_density.get(left).copied().unwrap_or(0.0);
        for right in linked {
            let Some(right_embedding) = embeddings.get(right) else {
                continue;
            };
            let right_density = local_density.get(right).copied().unwrap_or(0.0);
            let Some(similarity) = centered_cosine(left_embedding, right_embedding, mean) else {
                continue;
            };
            let corrected = 2.0 * similarity - left_density - right_density;
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

fn random_fallback_selection_with_diagnostics(
    candidates: &[PlaybackTrack],
    embeddings: &AudioStyleEmbeddingMap,
    anchor_key: &PlaybackTrackKey,
    similarities: &[Option<f32>],
    len: usize,
    draw_unit: f32,
    reason: Option<&'static str>,
) -> AudioStyleCandidateSelection {
    let index = random_fallback_index(len, draw_unit);
    random_fallback_selection_from_diagnostics(
        len,
        draw_unit,
        reason,
        audio_style_candidate_diagnostics(
            candidates,
            embeddings,
            anchor_key,
            similarities,
            Some(index),
        ),
    )
}

fn random_fallback_selection_from_diagnostics(
    len: usize,
    draw_unit: f32,
    reason: Option<&'static str>,
    diagnostics: AudioStyleCandidateDiagnostics,
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
        diagnostics,
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

fn escape_log_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
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
    #[cfg_attr(not(test), allow(dead_code))]
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
struct AudioStyleTrainingTrackResolution {
    indexed_tracks: Vec<AudioStyleIndexedTrack>,
}

#[cfg(not(test))]
fn resolve_audio_style_training_tracks(
    save_root: &Path,
    sources: Vec<crate::domain::playlists::repo::PlaylistPlaybackTrackSource>,
) -> AudioStyleTrainingTrackResolution {
    let mut indexed_tracks = Vec::new();
    for source in sources {
        if let Some(indexed) = resolve_audio_style_training_track(save_root, source) {
            indexed_tracks.push(indexed);
        }
    }

    AudioStyleTrainingTrackResolution { indexed_tracks }
}

#[cfg(not(test))]
fn resolve_audio_style_training_track(
    save_root: &Path,
    source: crate::domain::playlists::repo::PlaylistPlaybackTrackSource,
) -> Option<AudioStyleIndexedTrack> {
    let Some(path) = source.music.path.as_deref() else {
        return None;
    };
    let path = PathBuf::from(path);
    let file_path = if path.is_absolute() {
        path
    } else {
        save_root.join(&source.collection_folder).join(path)
    };
    if !file_path.is_file() {
        return None;
    }

    let track = PlaybackTrack {
        playlist_name: "__audio_style_model__".to_string(),
        music_name: source.music.alias.clone(),
        canonical_music_id: source.music.canonical_music_id.clone(),
        music_url: source.music.url.clone(),
        file_path,
        source_music: Some(Box::new(source.music.clone())),
        start_ms: source.music.start_ms,
        end_ms: source.music.end_ms,
        liked: source.music.liked,
    };
    Some(AudioStyleIndexedTrack { track, source })
}

#[cfg(test)]
fn playback_track_source_music_from_track(track: &PlaybackTrack) -> Music {
    Music {
        name: track.music_name.clone(),
        alias: track.music_name.clone(),
        group: Group {
            name: String::new(),
            url: String::new(),
            collection: CollectionGroupOwner {
                name: String::new(),
                url: String::new(),
                folder: String::new(),
                last_updated: String::new(),
                enable_updates: None,
            },
            folder: String::new(),
        },
        canonical_music_id: track.canonical_music_id.clone(),
        url: track.music_url.clone(),
        path: Some(track.file_path.to_string_lossy().to_string()),
        start_ms: track.start_ms,
        end_ms: track.end_ms,
        liked: track.liked,
    }
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
        &[],
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
        &[],
        draw_unit,
    );
    selection.model_generation = model_generation;
    selection
}

#[cfg(test)]
pub(crate) fn choose_centerless_audio_style_candidate_for_test(
    candidates: &[PlaybackTrack],
    embeddings: &AudioStylePlaylistPlaybackRecommender,
    draw_unit: f32,
) -> AudioStyleCandidateSelection {
    select_centerless_audio_style_candidate(
        candidates,
        &embeddings.embeddings,
        embeddings.sampling_geometry.as_ref(),
        embeddings.trained,
        draw_unit,
    )
}

#[cfg(test)]
pub(crate) fn choose_next_audio_style_candidate_with_recent_history_for_test(
    current_track: &PlaybackTrack,
    candidates: &[PlaybackTrack],
    embeddings: &AudioStylePlaylistPlaybackRecommender,
    recently_played_tracks: &[PlaybackTrack],
    draw_unit: f32,
) -> AudioStyleCandidateSelection {
    select_next_audio_style_candidate(
        candidates,
        &PlaybackTrackKey::from_track(current_track),
        &embeddings.embeddings,
        embeddings.sampling_geometry.as_ref(),
        embeddings.trained,
        recently_played_tracks,
        draw_unit,
    )
}
