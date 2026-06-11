#[cfg(not(test))]
use crate::domain::meta::service as meta_service;
use crate::domain::player::model::PlaybackTrack;
#[cfg(not(test))]
use crate::domain::playlist_playback::playable_index;
#[cfg(not(test))]
use crate::domain::playlists::model::{
    AudioStyleTrainingTrackInput, CollectionGroupOwner, Group, Music,
};
#[cfg(test)]
use crate::domain::playlists::model::{CollectionGroupOwner, Group, Music};
use crate::domain::playlists::model::LoudnessProfile;
use crate::domain::playlists::repo::PlaylistPlaybackTrackSource;
#[cfg(not(test))]
use crate::utils::binaries::{ManagedBinary, acquire_managed_binary_usage};
#[cfg(not(test))]
use anyhow::{Context, Result, anyhow};
use appdb::{VectorDistance, VectorIndexType, impl_hnsw_index};
use burn_ndarray::{NdArray, NdArrayDevice};
use burn_tensor::{Tensor, TensorData, backend::Backend};
use burn_wgpu::{
    Wgpu, WgpuDevice, WgpuRuntime,
    graphics::{AutoGraphicsApi, GraphicsApi},
};
use cubecl::{Runtime as CubeRuntime, device::Device as CubeDevice};
use rand::RngExt;
use rustfft::{FftPlanner, num_complex::Complex};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::sync::RwLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(not(test))]
use tauri::{AppHandle, Manager};

const AUDIO_STYLE_EMBEDDING_VERSION: &str = "audio-style-watermark-transition-v3-measured-flow";
#[cfg(test)]
pub(crate) const AUDIO_STYLE_EMBEDDING_VERSION_FOR_TEST: &str = AUDIO_STYLE_EMBEDDING_VERSION;
const AUDIO_STYLE_MODEL_EVIDENCE_VERSION: &str = "audio-style-model-evidence-v2-measured-flow";
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
const AUDIO_STYLE_AUDITORY_STATE_WIDTH: usize = 4;
const AUDIO_STYLE_AUDITORY_PRESSURE_STRENGTHS: [f32; AUDIO_STYLE_AUDITORY_STATE_WIDTH] =
    [3.90, 1.35, 0.70, 0.90];
const AUDIO_STYLE_AUDITORY_PRESSURE_TARGETS: [f32; AUDIO_STYLE_AUDITORY_STATE_WIDTH] =
    [0.44, 0.50, 0.50, 0.54];
const AUDIO_STYLE_AUDITORY_PRESSURE_DECAY: f32 = 0.90;
const AUDIO_STYLE_AUDITORY_RECENT_STATE_STRENGTH: f32 = 0.45;
const AUDIO_STYLE_AUDITORY_EXTREME_STATE_STRENGTH: f32 = 1.15;
#[cfg(not(test))]
const AUDIO_STYLE_COMPLETED_SNAPSHOT_FALLBACK_LIMIT: usize = 2;
#[cfg(not(test))]
const AUDIO_STYLE_INPUT_CHANGE_DEBOUNCE_MS: u64 = 500;
#[cfg(not(test))]
const AUDIO_STYLE_TRAINING_BASE_WORKERS: usize = 6;
#[cfg(test)]
const AUDIO_STYLE_TRAINING_BASE_WORKERS: usize = 1;
const AUDIO_STYLE_TRAINING_HARDWARE_DECODE_WORKER_CAP: usize = 12;
#[cfg(not(test))]
const AUDIO_STYLE_TRAINING_PROGRESS_BATCH: usize = 16;
#[cfg(test)]
const AUDIO_STYLE_TRAINING_PROGRESS_BATCH: usize = 1;
const AUDIO_STYLE_TRAINING_HEARTBEAT_MS: u64 = 750;
const AUDIO_STYLE_LOG_TARGET: &str = "playlist_audio_style";
const AUDIO_STYLE_TENSOR_BACKEND_ENV: &str = "SLISIC_AUDIO_STYLE_TENSOR_BACKEND";
const CUBECL_WGPU_DEFAULT_DEVICE_ENV: &str = "CUBECL_WGPU_DEFAULT_DEVICE";
const AUDIO_STYLE_TENSOR_HARDWARE_PROBE_ATTEMPTS: usize = 30;
const AUDIO_STYLE_TENSOR_HARDWARE_PROBE_RETRY_MS: u64 = 500;
const AUDIO_STYLE_TENSOR_HARDWARE_DECODE_PREFETCH_PER_DEVICE: usize = 1;
const AUDIO_STYLE_TENSOR_HARDWARE_DECODE_PREFETCH_MAX: usize = 2;
const AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_MIN_BYTES: usize = 64 * 1024 * 1024;
const AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_BASE_BYTES: usize = 192 * 1024 * 1024;
const AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_DISCRETE_BYTES: usize = 512 * 1024 * 1024;
const AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_INTEGRATED_BYTES: usize = 192 * 1024 * 1024;
const AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_VIRTUAL_BYTES: usize = 256 * 1024 * 1024;
const AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_DEFAULT_BYTES: usize = 256 * 1024 * 1024;
const AUDIO_STYLE_TENSOR_F32_BYTES: usize = std::mem::size_of::<f32>();
const AUDIO_STYLE_TENSOR_HARDWARE_OP_COOLDOWN_MS: u64 = 15_000;
const AUDIO_STYLE_TENSOR_HARDWARE_CLEANUP_SLOW_MS: u128 = 50;

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
static AUDIO_STYLE_HARDWARE_OP_ACTIVE: AtomicBool = AtomicBool::new(false);
static AUDIO_STYLE_HARDWARE_OP_COOLDOWN_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleModelEvidence {
    version: String,
    embedding_version: String,
    generation: u64,
    embeddings: Vec<CachedAudioStyleModelEmbedding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleModelEmbedding {
    key: CachedPlaybackTrackKey,
    values: Vec<f32>,
    loudness_profile: Option<LoudnessProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedPlaybackTrackKey {
    music_url: String,
    file_path: String,
    start_ms: u32,
    end_ms: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct AudioStyleEmbedding {
    values: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioStyleEmbeddingTrainingSource {
    CacheHit,
    Decoded,
}

impl AudioStyleEmbeddingTrainingSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::CacheHit => "cache_hit",
            Self::Decoded => "decoded",
        }
    }
}

struct AudioStyleEmbeddingTrainingResult {
    embedding: AudioStyleEmbedding,
    source: AudioStyleEmbeddingTrainingSource,
}

type AudioStyleEmbeddingMap = HashMap<PlaybackTrackKey, Arc<AudioStyleEmbedding>>;
type AudioStyleCpuTensorBackend = NdArray<f32, i64>;
type AudioStyleHardwareTensorBackend = Wgpu<f32, i64>;

#[derive(Clone)]
pub(crate) struct AudioStyleEmbeddingCache {
    cache_root: PathBuf,
    ffmpeg_path: PathBuf,
}

pub(crate) struct AudioStylePlaylistPlaybackRecommender {
    embeddings: AudioStyleEmbeddingMap,
    #[cfg_attr(not(test), allow(dead_code))]
    loudness_profiles: AudioStyleLoudnessProfileMap,
    #[cfg_attr(not(test), allow(dead_code))]
    indexed_tracks: HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
    sampling_geometry: Option<AudioStyleSamplingGeometry>,
    auditory_geometry: Option<AudioStyleAuditoryGeometry>,
    trained: bool,
}

#[derive(Clone)]
struct AudioStyleModelState {
    embeddings: AudioStyleEmbeddingMap,
    loudness_profiles: AudioStyleLoudnessProfileMap,
    auditory_geometry: Option<AudioStyleAuditoryGeometry>,
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

type AudioStyleLoudnessProfileMap = HashMap<PlaybackTrackKey, LoudnessProfile>;

#[derive(Clone)]
struct AudioStyleAuditoryGeometry {
    states: HashMap<PlaybackTrackKey, AudioStyleAuditoryState>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct AudioStyleAuditoryState {
    values: [f32; AUDIO_STYLE_AUDITORY_STATE_WIDTH],
}

#[derive(Clone)]
enum AudioStyleTensorRuntime {
    Hardware(AudioStyleTensorDevicePool),
    Cpu(AudioStyleCpuTensorRuntime),
}

#[derive(Clone)]
struct AudioStyleTensorDevicePool {
    devices: Arc<Mutex<Vec<WgpuDevice>>>,
    memory_budget_bytes: Arc<Mutex<usize>>,
    device_source: &'static str,
}

#[derive(Clone)]
struct AudioStyleCpuTensorRuntime {
    device: NdArrayDevice,
    device_source: &'static str,
}

#[derive(Clone, Copy, Debug)]
struct AudioStyleTensorBackendProfile {
    backend: AudioStyleTrainingTensorBackend,
    tensor_device_count: usize,
    hardware_memory_budget_bytes: usize,
    device_source: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AudioStyleTensorRuntimePreference {
    Hardware { device_source: &'static str },
    Cpu { device_source: &'static str },
}

#[derive(Clone)]
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

impl From<&PlaybackTrackKey> for CachedPlaybackTrackKey {
    fn from(value: &PlaybackTrackKey) -> Self {
        Self {
            music_url: value.music_url.clone(),
            file_path: value.file_path.to_string_lossy().to_string(),
            start_ms: value.start_ms,
            end_ms: value.end_ms,
        }
    }
}

impl From<CachedPlaybackTrackKey> for PlaybackTrackKey {
    fn from(value: CachedPlaybackTrackKey) -> Self {
        Self {
            music_url: value.music_url,
            file_path: PathBuf::from(value.file_path),
            start_ms: value.start_ms,
            end_ms: value.end_ms,
        }
    }
}

#[cfg(not(test))]
struct AudioStyleRecommendationRuntime {
    app: AppHandle,
    stable_snapshot: RwLock<Option<Arc<AudioStyleModelSnapshot>>>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioStyleStartupTrainingDecision {
    SkipRestoredEvidence,
    TrainInitialModel,
    TrainPendingInputChanges,
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
        let musics_started = Instant::now();
        let musics =
            crate::domain::playlists::repo::load_audio_style_training_musics(&save_root).await?;
        let music_count = musics.len();
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_music_inputs_loaded reason={reason} trainable_music={music_count} elapsed_ms={}",
            musics_started.elapsed().as_millis()
        );
        let resolve_started = Instant::now();
        let resolved = resolve_audio_style_training_tracks(musics);
        let indexed_tracks = resolved.indexed_tracks;
        let indexed_track_count = indexed_tracks.len();
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_inputs_ready reason={reason} indexed_tracks={indexed_track_count} skipped_transient_tracks={} skipped_unavailable_tracks={} elapsed_ms={}",
            resolved.skipped_transient_tracks,
            resolved.skipped_unavailable_tracks,
            resolve_started.elapsed().as_millis()
        );

        let previous_snapshot = self.stable_snapshot();
        let generation_runtime = Arc::clone(self);
        let build_started = Instant::now();
        let final_snapshot = tauri::async_runtime::spawn_blocking(move || {
            AudioStyleModelSnapshot::refresh_from_indexed_tracks(
                previous_snapshot.as_deref(),
                &cache,
                indexed_tracks,
                || {
                    generation_runtime
                        .next_generation
                        .fetch_add(1, Ordering::SeqCst)
                        + 1
                },
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
                let stable_existed = stable.is_some();
                if !should_replace_stable_snapshot(stable.as_deref(), snapshot.as_ref()) {
                    return;
                }
                *stable = Some(Arc::clone(&snapshot));
                let reason = StableSnapshotPublicationReason::TrainingComplete;
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_snapshot_published stage=stable reason={} generation={generation}",
                    reason.as_str()
                );
                if stable_snapshot_publication_requests_first_slot_refresh(reason, stable_existed) {
                    playable_index::request_audio_style_model_available_refresh();
                }
                if let Ok(cache_path) = audio_style_model_evidence_cache_path(&self.app)
                    && let Err(error) =
                        write_cached_audio_style_model_evidence(&cache_path, snapshot.as_ref())
                {
                    log::warn!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_model_evidence_write_failed generation={generation} error=\"{}\"",
                        escape_log_value(&error)
                    );
                }
            }
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_snapshot_publish_failed stage=stable reason=training_complete generation={generation} error=\"lock_poisoned\""
                );
                return;
            }
        }

        self.remember_completed_snapshot(snapshot);
    }

    fn remember_completed_snapshot(&self, snapshot: Arc<AudioStyleModelSnapshot>) {
        let generation = snapshot.generation();
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
            app: app.clone(),
            stable_snapshot: RwLock::new(None),
            completed_snapshots: RwLock::new(Vec::new()),
            training: Mutex::new(AudioStyleTrainingState::default()),
            next_generation: AtomicU64::new(0),
            next_training_run_id: AtomicU64::new(0),
        })
    });

    let pending_input_changes = AUDIO_STYLE_PENDING_INPUT_CHANGES.swap(0, Ordering::SeqCst);
    runtime.spawn_startup_lifecycle(pending_input_changes);
}

#[cfg(not(test))]
fn apply_audio_style_startup_training_decision(
    runtime: &Arc<AudioStyleRecommendationRuntime>,
    restored_evidence: bool,
    pending_input_changes: u64,
) {
    match audio_style_startup_training_decision(restored_evidence, pending_input_changes) {
        AudioStyleStartupTrainingDecision::SkipRestoredEvidence => {
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_startup_skipped reason=restored_evidence"
            );
        }
        AudioStyleStartupTrainingDecision::TrainInitialModel => runtime.request_training("startup"),
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges => {
            runtime.request_training("startup_pending_input_changes")
        }
    }
}

#[cfg(not(test))]
pub(crate) fn notify_audio_style_library_inputs_changed(reason: &'static str) {
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
    Ready(
        PlaylistPlaybackTrackSource,
        PlaybackTrack,
        AudioStyleCandidateSelection,
    ),
    ModelUnavailable,
    NoScopedCandidate,
}

#[cfg(not(test))]
pub(crate) fn published_audio_style_centerless_source_from_candidates(
    candidates: Vec<(PlaylistPlaybackTrackSource, PlaybackTrack)>,
) -> AudioStyleCenterlessSourceStatus {
    let Some(snapshot) = AUDIO_STYLE_RECOMMENDATION_RUNTIME
        .get()
        .and_then(|runtime| runtime.stable_snapshot())
    else {
        return AudioStyleCenterlessSourceStatus::ModelUnavailable;
    };

    snapshot
        .recommender()
        .propose_centerless_source_from_tracks(candidates)
        .map(|(source, track, mut selection)| {
            selection.model_generation = Some(snapshot.generation());
            AudioStyleCenterlessSourceStatus::Ready(source, track, selection)
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
    fn spawn_startup_lifecycle(self: &Arc<Self>, pending_input_changes: u64) {
        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let restored_evidence = runtime.restore_model_evidence_on_startup().await;
            apply_audio_style_startup_training_decision(
                &runtime,
                restored_evidence,
                pending_input_changes,
            );
        });
    }

    async fn restore_model_evidence_on_startup(self: &Arc<Self>) -> bool {
        let started = Instant::now();
        let cache_path = match audio_style_model_evidence_cache_path(&self.app) {
            Ok(cache_path) => cache_path,
            Err(error) => {
                log::warn!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_model_evidence_restore_skipped reason=startup error=\"{}\"",
                    escape_log_value(&error.to_string())
                );
                return false;
            }
        };
        let restore_result = tauri::async_runtime::spawn_blocking(move || {
            read_cached_audio_style_model_evidence(&cache_path)
        })
        .await;
        let snapshot = match restore_result {
            Ok(Ok(snapshot)) => snapshot,
            Ok(Err(error)) => {
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_model_evidence_restore_miss reason=startup elapsed_ms={} error=\"{}\"",
                    started.elapsed().as_millis(),
                    escape_log_value(&error)
                );
                return false;
            }
            Err(error) => {
                log::warn!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_model_evidence_restore_task_failed reason=startup elapsed_ms={} error=\"{}\"",
                    started.elapsed().as_millis(),
                    escape_log_value(&error.to_string())
                );
                return false;
            }
        };
        let generation = snapshot.generation();
        self.next_generation.fetch_max(generation, Ordering::SeqCst);
        self.publish_restored_stable_snapshot(snapshot);
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_model_evidence_restored reason=startup generation={generation} elapsed_ms={}",
            started.elapsed().as_millis()
        );
        true
    }

    fn publish_restored_stable_snapshot(&self, snapshot: AudioStyleModelSnapshot) {
        let snapshot = Arc::new(snapshot);
        let generation = snapshot.generation();
        match self.stable_snapshot.write() {
            Ok(mut stable) => {
                let stable_existed = stable.is_some();
                if !should_replace_stable_snapshot(stable.as_deref(), snapshot.as_ref()) {
                    return;
                }
                *stable = Some(Arc::clone(&snapshot));
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_snapshot_published stage=stable reason=startup_evidence generation={generation}"
                );
                if stable_snapshot_publication_requests_first_slot_refresh(
                    StableSnapshotPublicationReason::StartupEvidence,
                    stable_existed,
                ) {
                    playable_index::request_audio_style_model_available_refresh();
                }
            }
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_snapshot_publish_failed stage=stable reason=startup_evidence generation={generation} error=\"lock_poisoned\""
                );
                return;
            }
        }

        self.remember_completed_snapshot(snapshot);
    }

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
        static RUNTIME: OnceLock<AudioStyleTensorRuntime> = OnceLock::new();
        if let Some(runtime) = RUNTIME.get() {
            return runtime.clone();
        }

        let (runtime, cacheable) = match audio_style_tensor_runtime_preference() {
            AudioStyleTensorRuntimePreference::Hardware { device_source } => {
                let hardware = AudioStyleTensorDevicePool::detect(device_source);
                if hardware.device_count() > 0 {
                    (Self::Hardware(hardware), true)
                } else {
                    (
                        Self::Cpu(AudioStyleCpuTensorRuntime {
                            device: NdArrayDevice::Cpu,
                            device_source: "wgpu_temporarily_unavailable_cpu_fallback",
                        }),
                        false,
                    )
                }
            }
            AudioStyleTensorRuntimePreference::Cpu { device_source } => (
                Self::Cpu(AudioStyleCpuTensorRuntime {
                    device: NdArrayDevice::Cpu,
                    device_source,
                }),
                true,
            ),
        };
        let profile = runtime.backend_profile();
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_tensor_runtime_selected tensor_backend={} tensor_device_count={} tensor_device_source={} hardware_memory_budget_bytes={} cacheable={cacheable}",
            profile.backend.as_str(),
            profile.tensor_device_count,
            profile.device_source,
            profile.hardware_memory_budget_bytes
        );
        if cacheable {
            let _ = RUNTIME.set(runtime.clone());
            return RUNTIME.get().cloned().unwrap_or(runtime);
        }
        runtime
    }

    #[cfg(test)]
    fn from_preference_for_test(preference: AudioStyleTensorRuntimePreference) -> Self {
        match preference {
            AudioStyleTensorRuntimePreference::Hardware { device_source } => {
                Self::for_test_hardware_device_count_with_source(1, device_source)
            }
            AudioStyleTensorRuntimePreference::Cpu { device_source } => {
                Self::Cpu(AudioStyleCpuTensorRuntime {
                    device: NdArrayDevice::Cpu,
                    device_source,
                })
            }
        }
    }

    #[cfg(test)]
    fn for_test_hardware_device_count(device_count: usize) -> Self {
        Self::for_test_hardware_device_count_with_source(device_count, "test_discrete_gpu")
    }

    #[cfg(test)]
    fn for_test_hardware_device_count_with_source(
        device_count: usize,
        device_source: &'static str,
    ) -> Self {
        if device_count == 0 {
            return Self::Cpu(AudioStyleCpuTensorRuntime {
                device: NdArrayDevice::Cpu,
                device_source: "test_cpu",
            });
        }
        Self::Hardware(AudioStyleTensorDevicePool {
            devices: Arc::new(Mutex::new(
                (0..device_count).map(WgpuDevice::DiscreteGpu).collect(),
            )),
            memory_budget_bytes: Arc::new(Mutex::new(
                audio_style_hardware_memory_budget_bytes_for_devices(
                    &(0..device_count)
                        .map(WgpuDevice::DiscreteGpu)
                        .collect::<Vec<_>>(),
                ),
            )),
            device_source,
        })
    }

    fn backend_profile(&self) -> AudioStyleTensorBackendProfile {
        match self {
            Self::Hardware(pool) => AudioStyleTensorBackendProfile {
                backend: AudioStyleTrainingTensorBackend::Hardware,
                tensor_device_count: pool.device_count(),
                hardware_memory_budget_bytes: pool.memory_budget_bytes(),
                device_source: pool.device_source,
            },
            Self::Cpu(runtime) => AudioStyleTensorBackendProfile {
                backend: AudioStyleTrainingTensorBackend::Cpu,
                tensor_device_count: 0,
                hardware_memory_budget_bytes: 0,
                device_source: runtime.device_source,
            },
        }
    }

    fn hardware_device_is_available(device: &WgpuDevice) -> bool {
        let mut touched_device = false;
        let available = run_audio_style_tensor_op(|| {
            let probe = Tensor::<AudioStyleHardwareTensorBackend, 1>::from_data(
                TensorData::new(vec![1.0_f32], [1]),
                device,
            );
            touched_device = true;
            AudioStyleHardwareTensorBackend::sync(device).ok()?;
            let values = probe.into_data().into_vec::<f32>().ok()?;
            (values == [1.0]).then_some(())
        })
        .flatten()
        .is_some();
        if touched_device {
            audio_style_cleanup_hardware_device_memory("hardware_device_probe", device);
        }
        available
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
            Self::Hardware(pool) => pool.mean_from_matrix(matrix).or_else(|| {
                Self::mean_from_matrix_on::<AudioStyleCpuTensorBackend>(matrix, &NdArrayDevice::Cpu)
            }),
            Self::Cpu(runtime) => {
                Self::mean_from_matrix_on::<AudioStyleCpuTensorBackend>(matrix, &runtime.device)
            }
        }
        .unwrap_or_else(|| vec![0.0; AUDIO_STYLE_EMBEDDING_WIDTH])
    }

    fn visit_centered_similarity_pairs(
        &self,
        embeddings: &AudioStyleEmbeddingMap,
        mean: &[f32],
        mut visit: impl FnMut(&PlaybackTrackKey, &PlaybackTrackKey, f32),
    ) -> bool {
        if embeddings.len() < 2 || mean.len() != AUDIO_STYLE_EMBEDDING_WIDTH {
            return false;
        }

        let matrix = self.matrix_from_embeddings(embeddings);
        if matrix.keys.len() < 2 {
            return false;
        }

        match self {
            Self::Hardware(pool) => {
                if pool.visit_centered_similarity_pairs(&matrix, mean, &mut visit) {
                    true
                } else {
                    Self::visit_centered_similarity_pairs_on_cpu(&matrix, mean, visit)
                }
            }
            Self::Cpu(_) => Self::visit_centered_similarity_pairs_on_cpu(&matrix, mean, visit),
        }
    }

    fn visit_centered_similarity_pairs_on_cpu(
        matrix: &AudioStyleTensorMatrix,
        mean: &[f32],
        mut visit: impl FnMut(&PlaybackTrackKey, &PlaybackTrackKey, f32),
    ) -> bool {
        let Some(embeddings) = audio_style_embeddings_from_matrix(matrix) else {
            return false;
        };
        for left_index in 0..embeddings.len() {
            for right_index in (left_index + 1)..embeddings.len() {
                let Some(similarity) =
                    centered_cosine_cpu(&embeddings[left_index], &embeddings[right_index], mean)
                else {
                    continue;
                };
                visit(
                    &matrix.keys[left_index],
                    &matrix.keys[right_index],
                    similarity,
                );
            }
        }
        true
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
                Self::Hardware(pool) => if audio_style_hardware_similarity_grid_budget_allows(
                    1,
                    candidates.len(),
                    pool.memory_budget_bytes(),
                ) {
                    pool.centered_similarity_to_many(anchor, candidates, mean)
                } else {
                    pool.centered_similarity_grid_tiled(&[anchor], candidates, mean)
                }
                .or_else(|| {
                    Self::centered_similarity_to_many_on::<AudioStyleCpuTensorBackend>(
                        anchor,
                        candidates,
                        mean,
                        &NdArrayDevice::Cpu,
                    )
                }),
                Self::Cpu(runtime) => Self::centered_similarity_to_many_on::<
                    AudioStyleCpuTensorBackend,
                >(anchor, candidates, mean, &runtime.device),
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
            Self::Hardware(pool) => {
                if audio_style_hardware_softmin_budget_allows(len, pool.memory_budget_bytes()) {
                    pool.softmin_weights(
                        similarity_values.clone(),
                        liked_values.clone(),
                        penalty_values.clone(),
                        valid_values.clone(),
                    )
                } else {
                    None
                }
                .or_else(|| {
                    Self::softmin_weights_on::<AudioStyleCpuTensorBackend>(
                        similarity_values,
                        liked_values,
                        penalty_values,
                        valid_values,
                        &NdArrayDevice::Cpu,
                    )
                })
            }
            Self::Cpu(runtime) => Self::softmin_weights_on::<AudioStyleCpuTensorBackend>(
                similarity_values,
                liked_values,
                penalty_values,
                valid_values,
                &runtime.device,
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
            Self::Hardware(pool) => if audio_style_hardware_similarity_grid_budget_allows(
                anchors.len(),
                candidates.len(),
                pool.memory_budget_bytes(),
            ) {
                pool.centered_similarity_grid(anchors, candidates, mean)
            } else {
                pool.centered_similarity_grid_tiled(anchors, candidates, mean)
            }
            .or_else(|| {
                Self::centered_similarity_grid_on::<AudioStyleCpuTensorBackend>(
                    anchors,
                    candidates,
                    mean,
                    &NdArrayDevice::Cpu,
                )
            }),
            Self::Cpu(runtime) => Self::centered_similarity_grid_on::<AudioStyleCpuTensorBackend>(
                anchors,
                candidates,
                mean,
                &runtime.device,
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

impl AudioStyleTensorDevicePool {
    fn detect(requested_source: &'static str) -> Self {
        let mut device_source = requested_source;
        let candidates = audio_style_wgpu_hardware_device_candidates();
        if candidates.is_empty() {
            log::warn!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_tensor_hardware_candidates_empty source={requested_source}"
            );
        }
        let mut devices =
            selected_audio_style_wgpu_hardware_device_from_candidates(&candidates)
                .into_iter()
                .collect::<Vec<_>>();
        if devices.is_empty() && !candidates.is_empty() {
            devices = wait_for_available_audio_style_wgpu_hardware_device(&candidates)
                .into_iter()
                .collect::<Vec<_>>();
            if !devices.is_empty() {
                device_source = "wgpu_runtime_recovered";
            }
        }
        let memory_budget_bytes = audio_style_hardware_memory_budget_bytes_for_devices(&devices);
        Self {
            devices: Arc::new(Mutex::new(devices)),
            memory_budget_bytes: Arc::new(Mutex::new(memory_budget_bytes)),
            device_source,
        }
    }

    fn device_count(&self) -> usize {
        self.devices
            .lock()
            .map(|devices| devices.len())
            .unwrap_or(0)
    }

    fn devices(&self) -> Vec<WgpuDevice> {
        self.devices
            .lock()
            .map(|devices| devices.clone())
            .unwrap_or_default()
    }

    fn replace_devices(&self, devices: Vec<WgpuDevice>) {
        let devices = audio_style_bound_hardware_device_pool(devices);
        let budget = audio_style_hardware_memory_budget_bytes_for_devices(&devices);
        if let Ok(mut current) = self.devices.lock() {
            *current = devices;
        }
        if let Ok(mut current_budget) = self.memory_budget_bytes.lock() {
            *current_budget = budget;
        }
    }

    fn memory_budget_bytes(&self) -> usize {
        self.memory_budget_bytes
            .lock()
            .map(|budget| *budget)
            .unwrap_or(AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_MIN_BYTES)
    }

    fn throttle_memory_budget(&self) -> usize {
        self.memory_budget_bytes
            .lock()
            .map(|mut budget| {
                *budget = (*budget / 2).max(AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_MIN_BYTES);
                *budget
            })
            .unwrap_or(AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_MIN_BYTES)
    }

    fn try_hardware_then_refresh<T>(
        &self,
        operation: &'static str,
        mut run: impl FnMut(&WgpuDevice) -> Option<T>,
    ) -> Option<T> {
        let Some(_permit) = AudioStyleHardwareOpPermit::try_acquire(operation) else {
            return None;
        };
        for device in self.devices() {
            let values = run(&device);
            audio_style_cleanup_hardware_device_memory(operation, &device);
            if let Some(values) = values {
                return Some(values);
            }
        }

        let budget_bytes = self.throttle_memory_budget();
        audio_style_hardware_op_enter_cooldown();
        log::warn!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_tensor_hardware_op_failed operation={operation} action=throttle_and_refresh budget_bytes={budget_bytes}"
        );
        let candidates = audio_style_wgpu_hardware_device_candidates();
        let refreshed = if candidates.is_empty() {
            None
        } else {
            wait_for_available_audio_style_wgpu_hardware_device(&candidates)
        };
        let Some(refreshed) = refreshed else {
            log::warn!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_tensor_hardware_op_unavailable operation={operation} action=cpu_fallback_for_this_call"
            );
            return None;
        };

        self.replace_devices(vec![refreshed.clone()]);
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_tensor_hardware_op_recovered operation={operation} devices=1 selected_device={refreshed:?} budget_bytes={}",
            self.memory_budget_bytes()
        );
        let values = run(&refreshed);
        audio_style_cleanup_hardware_device_memory(operation, &refreshed);
        if let Some(values) = values {
            return Some(values);
        }
        let budget_bytes = self.throttle_memory_budget();
        audio_style_hardware_op_enter_cooldown();
        log::warn!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_tensor_hardware_op_retry_failed operation={operation} action=cpu_fallback_for_this_call budget_bytes={budget_bytes}"
        );
        None
    }

    fn mean_from_matrix(&self, matrix: &AudioStyleTensorMatrix) -> Option<Vec<f32>> {
        self.try_hardware_then_refresh("mean_from_matrix", |device| {
            AudioStyleTensorRuntime::mean_from_matrix_on::<AudioStyleHardwareTensorBackend>(
                matrix, device,
            )
        })
    }

    fn visit_centered_similarity_pairs(
        &self,
        matrix: &AudioStyleTensorMatrix,
        mean: &[f32],
        visit: &mut impl FnMut(&PlaybackTrackKey, &PlaybackTrackKey, f32),
    ) -> bool {
        let Some(embeddings) = audio_style_embeddings_from_matrix(matrix) else {
            return false;
        };
        let refs = embeddings.iter().collect::<Vec<_>>();
        let (anchor_tile, candidate_tile) = match audio_style_hardware_similarity_grid_tile_shape(
            refs.len(),
            refs.len(),
            self.memory_budget_bytes(),
        ) {
            Some(tile_shape) => tile_shape,
            None => return false,
        };

        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_tensor_hardware_op_streamed operation=centered_similarity_pairs rows={} anchor_tile={} candidate_tile={} budget_bytes={}",
            refs.len(),
            anchor_tile,
            candidate_tile,
            self.memory_budget_bytes()
        );

        for anchor_start in (0..refs.len()).step_by(anchor_tile) {
            let anchor_end = (anchor_start + anchor_tile).min(refs.len());
            for candidate_start in (0..refs.len()).step_by(candidate_tile) {
                let candidate_end = (candidate_start + candidate_tile).min(refs.len());
                let Some(tile) = self.centered_similarity_grid(
                    &refs[anchor_start..anchor_end],
                    &refs[candidate_start..candidate_end],
                    mean,
                ) else {
                    return false;
                };
                let tile_candidate_count = candidate_end - candidate_start;
                for local_anchor in 0..(anchor_end - anchor_start) {
                    let left_index = anchor_start + local_anchor;
                    for local_candidate in 0..tile_candidate_count {
                        let right_index = candidate_start + local_candidate;
                        if right_index <= left_index {
                            continue;
                        }
                        let similarity =
                            tile[local_anchor * tile_candidate_count + local_candidate];
                        visit(
                            &matrix.keys[left_index],
                            &matrix.keys[right_index],
                            similarity,
                        );
                    }
                }
            }
        }
        true
    }

    fn centered_similarity_to_many(
        &self,
        anchor: &AudioStyleEmbedding,
        candidates: &[&AudioStyleEmbedding],
        mean: &[f32],
    ) -> Option<Vec<f32>> {
        self.try_hardware_then_refresh("centered_similarity_to_many", |device| {
            AudioStyleTensorRuntime::centered_similarity_to_many_on::<AudioStyleHardwareTensorBackend>(
                anchor, candidates, mean, device,
            )
        })
    }

    fn softmin_weights(
        &self,
        similarity_values: Vec<f32>,
        liked_values: Vec<f32>,
        penalty_values: Vec<f32>,
        valid_values: Vec<f32>,
    ) -> Option<Vec<f32>> {
        self.try_hardware_then_refresh("softmin_weights", |device| {
            AudioStyleTensorRuntime::softmin_weights_on::<AudioStyleHardwareTensorBackend>(
                similarity_values.clone(),
                liked_values.clone(),
                penalty_values.clone(),
                valid_values.clone(),
                device,
            )
        })
    }

    fn centered_similarity_grid(
        &self,
        anchors: &[&AudioStyleEmbedding],
        candidates: &[&AudioStyleEmbedding],
        mean: &[f32],
    ) -> Option<Vec<f32>> {
        self.try_hardware_then_refresh("centered_similarity_grid", |device| {
            AudioStyleTensorRuntime::centered_similarity_grid_on::<AudioStyleHardwareTensorBackend>(
                anchors, candidates, mean, device,
            )
        })
    }

    fn centered_similarity_grid_tiled(
        &self,
        anchors: &[&AudioStyleEmbedding],
        candidates: &[&AudioStyleEmbedding],
        mean: &[f32],
    ) -> Option<Vec<f32>> {
        let (anchor_tile, candidate_tile) = audio_style_hardware_similarity_grid_tile_shape(
            anchors.len(),
            candidates.len(),
            self.memory_budget_bytes(),
        )?;
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_tensor_hardware_op_tiled operation=centered_similarity_grid anchors={} candidates={} anchor_tile={} candidate_tile={} budget_bytes={}",
            anchors.len(),
            candidates.len(),
            anchor_tile,
            candidate_tile,
            self.memory_budget_bytes()
        );
        let mut values = vec![0.0; anchors.len() * candidates.len()];
        for anchor_start in (0..anchors.len()).step_by(anchor_tile) {
            let anchor_end = (anchor_start + anchor_tile).min(anchors.len());
            for candidate_start in (0..candidates.len()).step_by(candidate_tile) {
                let candidate_end = (candidate_start + candidate_tile).min(candidates.len());
                let tile = self.centered_similarity_grid(
                    &anchors[anchor_start..anchor_end],
                    &candidates[candidate_start..candidate_end],
                    mean,
                )?;
                let tile_candidate_count = candidate_end - candidate_start;
                for local_anchor in 0..(anchor_end - anchor_start) {
                    let target_start =
                        (anchor_start + local_anchor) * candidates.len() + candidate_start;
                    let source_start = local_anchor * tile_candidate_count;
                    values[target_start..target_start + tile_candidate_count]
                        .copy_from_slice(&tile[source_start..source_start + tile_candidate_count]);
                }
            }
        }
        Some(values)
    }
}

struct AudioStyleHardwareOpPermit;

impl AudioStyleHardwareOpPermit {
    fn try_acquire(operation: &'static str) -> Option<Self> {
        let now_ms = current_time_millis();
        let cooldown_until =
            AUDIO_STYLE_HARDWARE_OP_COOLDOWN_UNTIL_MS.load(Ordering::SeqCst);
        if now_ms < cooldown_until {
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_tensor_hardware_op_skipped operation={operation} reason=cooldown active=false cooldown_remaining_ms={} action=cpu_fallback_for_this_call",
                cooldown_until.saturating_sub(now_ms)
            );
            return None;
        }

        if AUDIO_STYLE_HARDWARE_OP_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_tensor_hardware_op_skipped operation={operation} reason=busy action=cpu_fallback_for_this_call"
            );
            return None;
        }

        Some(Self)
    }
}

impl Drop for AudioStyleHardwareOpPermit {
    fn drop(&mut self) {
        AUDIO_STYLE_HARDWARE_OP_ACTIVE.store(false, Ordering::SeqCst);
    }
}

fn audio_style_cleanup_hardware_device_memory(operation: &'static str, device: &WgpuDevice) {
    let started = Instant::now();
    let cleanup = catch_unwind(AssertUnwindSafe(|| {
        let sync_ok = AudioStyleHardwareTensorBackend::sync(device).is_ok();
        AudioStyleHardwareTensorBackend::memory_cleanup(device);
        let cleanup_sync_ok = AudioStyleHardwareTensorBackend::sync(device).is_ok();
        (sync_ok, cleanup_sync_ok)
    }));
    let elapsed_ms = started.elapsed().as_millis();
    match cleanup {
        Ok((sync_ok, cleanup_sync_ok))
            if audio_style_hardware_cleanup_should_log(sync_ok, cleanup_sync_ok, elapsed_ms) =>
        {
            log::warn!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_tensor_hardware_memory_cleanup operation={operation} device={device:?} sync_ok={sync_ok} cleanup_sync_ok={cleanup_sync_ok} elapsed_ms={elapsed_ms}"
            );
        }
        Ok(_) => {}
        Err(_) => {
            log::warn!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_tensor_hardware_memory_cleanup operation={operation} device={device:?} sync_ok=false cleanup_sync_ok=false panicked=true elapsed_ms={elapsed_ms}"
            );
        }
    }
}

fn audio_style_hardware_cleanup_should_log(
    sync_ok: bool,
    cleanup_sync_ok: bool,
    elapsed_ms: u128,
) -> bool {
    !sync_ok
        || !cleanup_sync_ok
        || elapsed_ms >= AUDIO_STYLE_TENSOR_HARDWARE_CLEANUP_SLOW_MS
}

#[cfg(test)]
pub(crate) fn audio_style_hardware_cleanup_should_log_for_test(
    sync_ok: bool,
    cleanup_sync_ok: bool,
    elapsed_ms: u128,
) -> bool {
    audio_style_hardware_cleanup_should_log(sync_ok, cleanup_sync_ok, elapsed_ms)
}

fn audio_style_hardware_op_enter_cooldown() {
    let cooldown_until = current_time_millis()
        .saturating_add(AUDIO_STYLE_TENSOR_HARDWARE_OP_COOLDOWN_MS);
    AUDIO_STYLE_HARDWARE_OP_COOLDOWN_UNTIL_MS.store(cooldown_until, Ordering::SeqCst);
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
pub(crate) fn reset_audio_style_hardware_op_gate_for_test() {
    AUDIO_STYLE_HARDWARE_OP_ACTIVE.store(false, Ordering::SeqCst);
    AUDIO_STYLE_HARDWARE_OP_COOLDOWN_UNTIL_MS.store(0, Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) fn acquire_audio_style_hardware_op_for_test() -> bool {
    AudioStyleHardwareOpPermit::try_acquire("test").is_some()
}

#[cfg(test)]
pub(crate) fn hold_audio_style_hardware_op_for_test() -> Option<Box<dyn Send>> {
    AudioStyleHardwareOpPermit::try_acquire("test").map(|permit| Box::new(permit) as Box<dyn Send>)
}

#[cfg(test)]
pub(crate) fn enter_audio_style_hardware_op_cooldown_for_test() {
    audio_style_hardware_op_enter_cooldown();
}

fn audio_style_wgpu_hardware_device_candidates() -> Vec<WgpuDevice> {
    if let Some(device) = audio_style_wgpu_default_device_override()
        && audio_style_wgpu_device_is_hardware(&device)
    {
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_tensor_hardware_candidates_selected source=wgpu_env devices=\"{}\"",
            audio_style_wgpu_device_list_label(&[device.clone()])
        );
        return vec![device];
    }

    let backend = AutoGraphicsApi::backend();
    let mut devices = audio_style_wgpu_hardware_device_enumeration_roots()
        .into_iter()
        .flat_map(|device| {
            <WgpuRuntime as CubeRuntime>::enumerate_devices(device.to_id().type_id, &backend)
        })
        .map(<WgpuDevice as CubeDevice>::from_id)
        .filter(audio_style_wgpu_device_is_hardware)
        .collect::<Vec<_>>();
    if devices.is_empty() {
        devices.push(WgpuDevice::DefaultDevice);
    }
    devices.sort_by_key(audio_style_wgpu_device_priority_key);
    devices.dedup_by_key(|device| device.to_id());
    log::info!(
        target: AUDIO_STYLE_LOG_TARGET,
        "audio_style_tensor_hardware_candidates_selected source=enumeration devices=\"{}\"",
        audio_style_wgpu_device_list_label(&devices)
    );
    devices
}

fn audio_style_wgpu_hardware_device_enumeration_roots() -> [WgpuDevice; 3] {
    [
        WgpuDevice::DiscreteGpu(0),
        WgpuDevice::IntegratedGpu(0),
        WgpuDevice::VirtualGpu(0),
    ]
}

fn selected_audio_style_wgpu_hardware_device_from_candidates(
    candidates: &[WgpuDevice],
) -> Option<WgpuDevice> {
    candidates
        .iter()
        .find(|device| AudioStyleTensorRuntime::hardware_device_is_available(device))
        .cloned()
}

fn wait_for_available_audio_style_wgpu_hardware_device(
    candidates: &[WgpuDevice],
) -> Option<WgpuDevice> {
    for attempt in 1..=AUDIO_STYLE_TENSOR_HARDWARE_PROBE_ATTEMPTS {
        log::warn!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_tensor_hardware_probe_waiting attempt={attempt} attempts={} retry_ms={} candidates={}",
            AUDIO_STYLE_TENSOR_HARDWARE_PROBE_ATTEMPTS,
            AUDIO_STYLE_TENSOR_HARDWARE_PROBE_RETRY_MS,
            candidates.len()
        );
        thread::sleep(Duration::from_millis(
            AUDIO_STYLE_TENSOR_HARDWARE_PROBE_RETRY_MS,
        ));
        if let Some(device) = selected_audio_style_wgpu_hardware_device_from_candidates(candidates)
        {
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_tensor_hardware_probe_recovered attempt={attempt} devices=1 selected_device={device:?}"
            );
            return Some(device);
        }
    }
    log::warn!(
        target: AUDIO_STYLE_LOG_TARGET,
        "audio_style_tensor_hardware_probe_exhausted attempts={} retry_ms={} candidates={}",
        AUDIO_STYLE_TENSOR_HARDWARE_PROBE_ATTEMPTS,
        AUDIO_STYLE_TENSOR_HARDWARE_PROBE_RETRY_MS,
        candidates.len()
    );
    None
}

fn audio_style_bound_hardware_device_pool(devices: Vec<WgpuDevice>) -> Vec<WgpuDevice> {
    devices.into_iter().take(1).collect()
}

fn audio_style_wgpu_device_priority_key(device: &WgpuDevice) -> (u8, usize) {
    match device {
        WgpuDevice::DiscreteGpu(index) => (0, *index),
        WgpuDevice::IntegratedGpu(index) => (1, *index),
        WgpuDevice::VirtualGpu(index) => (2, *index),
        WgpuDevice::DefaultDevice => (3, 0),
        #[allow(deprecated)]
        WgpuDevice::BestAvailable => (3, 0),
        WgpuDevice::Existing(index) => (4, *index as usize),
        WgpuDevice::Cpu => (5, 0),
    }
}

fn audio_style_wgpu_device_is_hardware(device: &WgpuDevice) -> bool {
    matches!(
        device,
        WgpuDevice::DiscreteGpu(_)
            | WgpuDevice::IntegratedGpu(_)
            | WgpuDevice::VirtualGpu(_)
            | WgpuDevice::DefaultDevice
    )
}

fn audio_style_wgpu_device_list_label(devices: &[WgpuDevice]) -> String {
    devices
        .iter()
        .map(|device| format!("{device:?}"))
        .collect::<Vec<_>>()
        .join(",")
}

fn audio_style_tensor_runtime_preference() -> AudioStyleTensorRuntimePreference {
    audio_style_tensor_runtime_preference_from_env(
        std::env::var(AUDIO_STYLE_TENSOR_BACKEND_ENV)
            .ok()
            .as_deref(),
        std::env::var(CUBECL_WGPU_DEFAULT_DEVICE_ENV)
            .ok()
            .as_deref(),
    )
}

fn audio_style_tensor_runtime_preference_from_env(
    tensor_backend: Option<&str>,
    wgpu_default_device: Option<&str>,
) -> AudioStyleTensorRuntimePreference {
    let backend = tensor_backend.map(|value| value.trim().to_ascii_lowercase());
    match backend.as_deref() {
        Some("wgpu" | "gpu" | "hardware") => {
            return AudioStyleTensorRuntimePreference::Hardware {
                device_source: "tensor_backend_env_hardware",
            };
        }
        Some("cpu" | "ndarray") => {
            return AudioStyleTensorRuntimePreference::Cpu {
                device_source: "tensor_backend_env_cpu",
            };
        }
        Some("") | None => {}
        Some(other) => {
            log::warn!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_tensor_backend_env_ignored env={} value=\"{}\" reason=unknown_backend",
                AUDIO_STYLE_TENSOR_BACKEND_ENV,
                escape_log_value(other)
            );
        }
    }

    match wgpu_default_device.and_then(parse_audio_style_wgpu_device) {
        Some(device) if audio_style_wgpu_device_is_hardware(&device) => {
            AudioStyleTensorRuntimePreference::Hardware {
                device_source: "wgpu_env_hardware",
            }
        }
        Some(WgpuDevice::Cpu) => AudioStyleTensorRuntimePreference::Cpu {
            device_source: "wgpu_env_cpu",
        },
        _ => AudioStyleTensorRuntimePreference::Hardware {
            device_source: "hardware_default",
        },
    }
}

fn audio_style_wgpu_default_device_override() -> Option<WgpuDevice> {
    let value = std::env::var(CUBECL_WGPU_DEFAULT_DEVICE_ENV).ok()?;
    parse_audio_style_wgpu_device(&value)
}

fn parse_audio_style_wgpu_device(value: &str) -> Option<WgpuDevice> {
    if value == "Cpu" {
        return Some(WgpuDevice::Cpu);
    }
    if value == "DefaultDevice" {
        return Some(WgpuDevice::DefaultDevice);
    }
    parse_audio_style_wgpu_indexed_device(value, "DiscreteGpu", WgpuDevice::DiscreteGpu)
        .or_else(|| {
            parse_audio_style_wgpu_indexed_device(value, "IntegratedGpu", WgpuDevice::IntegratedGpu)
        })
        .or_else(|| {
            parse_audio_style_wgpu_indexed_device(value, "VirtualGpu", WgpuDevice::VirtualGpu)
        })
}

fn parse_audio_style_wgpu_indexed_device(
    value: &str,
    prefix: &str,
    make_device: fn(usize) -> WgpuDevice,
) -> Option<WgpuDevice> {
    let inner = value
        .strip_prefix(prefix)?
        .strip_prefix('(')?
        .strip_suffix(')')?;
    inner.parse::<usize>().ok().map(make_device)
}

#[cfg(test)]
pub(crate) fn audio_style_tensor_runtime_profile_for_test(
    device_count: usize,
) -> (&'static str, usize, &'static str) {
    let profile =
        AudioStyleTensorRuntime::for_test_hardware_device_count(device_count).backend_profile();
    (
        profile.backend.as_str(),
        profile.tensor_device_count,
        profile.device_source,
    )
}

#[cfg(test)]
pub(crate) fn audio_style_tensor_runtime_preference_for_test(
    tensor_backend: Option<&str>,
    wgpu_default_device: Option<&str>,
) -> (&'static str, &'static str) {
    match audio_style_tensor_runtime_preference_from_env(tensor_backend, wgpu_default_device) {
        AudioStyleTensorRuntimePreference::Hardware { device_source } => {
            ("hardware", device_source)
        }
        AudioStyleTensorRuntimePreference::Cpu { device_source } => ("cpu", device_source),
    }
}

#[cfg(test)]
pub(crate) fn audio_style_tensor_runtime_profile_from_preference_for_test(
    tensor_backend: Option<&str>,
    wgpu_default_device: Option<&str>,
) -> (&'static str, usize, &'static str) {
    let preference =
        audio_style_tensor_runtime_preference_from_env(tensor_backend, wgpu_default_device);
    let profile = AudioStyleTensorRuntime::from_preference_for_test(preference).backend_profile();
    (
        profile.backend.as_str(),
        profile.tensor_device_count,
        profile.device_source,
    )
}

#[cfg(test)]
pub(crate) fn parse_audio_style_wgpu_device_for_test(value: &str) -> Option<String> {
    parse_audio_style_wgpu_device(value).map(|device| format!("{device:?}"))
}

#[cfg(test)]
pub(crate) fn sort_audio_style_wgpu_devices_for_test(values: &[&str]) -> Vec<String> {
    let mut devices = values
        .iter()
        .filter_map(|value| parse_audio_style_wgpu_device(value))
        .collect::<Vec<_>>();
    devices.sort_by_key(audio_style_wgpu_device_priority_key);
    devices
        .into_iter()
        .map(|device| format!("{device:?}"))
        .collect()
}

#[cfg(test)]
pub(crate) fn bound_audio_style_hardware_device_pool_for_test(values: &[&str]) -> Vec<String> {
    audio_style_bound_hardware_device_pool(
        values
            .iter()
            .filter_map(|value| parse_audio_style_wgpu_device(value))
            .collect(),
    )
    .into_iter()
    .map(|device| format!("{device:?}"))
    .collect()
}

#[cfg(test)]
pub(crate) fn audio_style_wgpu_hardware_device_enumeration_roots_for_test() -> Vec<String> {
    audio_style_wgpu_hardware_device_enumeration_roots()
        .into_iter()
        .map(|device| format!("{device:?}"))
        .collect()
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

impl AudioStyleAuditoryGeometry {
    fn from_loudness_profiles(profiles: &AudioStyleLoudnessProfileMap) -> Option<Self> {
        let rows = profiles
            .iter()
            .filter_map(|(key, profile)| {
                AudioStyleRawAuditoryProfile::from_loudness_profile(*profile)
                    .map(|raw| (key.clone(), raw))
            })
            .collect::<Vec<_>>();
        if rows.len() < 2 {
            return None;
        }

        let arousal_values = rows.iter().map(|(_, raw)| raw.arousal).collect::<Vec<_>>();
        let brightness_values = rows
            .iter()
            .map(|(_, raw)| raw.brightness)
            .collect::<Vec<_>>();
        let density_values = rows.iter().map(|(_, raw)| raw.density).collect::<Vec<_>>();
        let complexity_values = rows
            .iter()
            .map(|(_, raw)| raw.complexity)
            .collect::<Vec<_>>();
        let arousal_scale = AudioStyleRobustUnitScale::from_values(arousal_values);
        let brightness_scale = AudioStyleRobustUnitScale::from_values(brightness_values);
        let density_scale = AudioStyleRobustUnitScale::from_values(density_values);
        let complexity_scale = AudioStyleRobustUnitScale::from_values(complexity_values);
        let states = rows
            .into_iter()
            .map(|(key, raw)| {
                (
                    key,
                    AudioStyleAuditoryState {
                        values: [
                            arousal_scale.project(raw.arousal),
                            brightness_scale.project(raw.brightness),
                            density_scale.project(raw.density),
                            complexity_scale.project(raw.complexity),
                        ],
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        (!states.is_empty()).then_some(Self { states })
    }

    fn state_for_track(&self, track: &PlaybackTrack) -> Option<AudioStyleAuditoryState> {
        self.states.get(&PlaybackTrackKey::from_track(track)).copied()
    }

    fn penalty_for_decision(
        &self,
        candidate: &PlaybackTrack,
        recent_tracks: &[PlaybackTrack],
    ) -> f32 {
        let Some(candidate_state) = self.state_for_track(candidate) else {
            return 0.0;
        };
        let recent_states = recent_tracks
            .iter()
            .rev()
            .take(AUDIO_STYLE_ROUTE_RECENT_WINDOW)
            .filter_map(|track| self.state_for_track(track))
            .collect::<Vec<_>>();
        if recent_states.is_empty() {
            return 0.0;
        }
        let ewma = audio_style_auditory_recent_ewma(&recent_states);
        let recent_center = audio_style_auditory_recent_center(&recent_states);
        audio_style_auditory_penalty(candidate_state, ewma, recent_center)
    }
}

#[derive(Debug, Clone, Copy)]
struct AudioStyleRawAuditoryProfile {
    arousal: f32,
    brightness: f32,
    density: f32,
    complexity: f32,
}

impl AudioStyleRawAuditoryProfile {
    fn from_loudness_profile(profile: LoudnessProfile) -> Option<Self> {
        if !profile.is_valid() {
            return None;
        }
        let integrated = finite_f32(profile.integrated_lufs)?;
        let true_peak = finite_f32(profile.true_peak_dbtp?)?;
        let lra = finite_f32(profile.lra?)?;
        let short_p50 = finite_f32(profile.short_lufs_p50?)?;
        let short_p80 = finite_f32(profile.short_lufs_p80?)?;
        let short_p95 = finite_f32(profile.short_lufs_p95?)?;
        let short_max = finite_f32(profile.short_lufs_max?)?;
        let presence = finite_f32(profile.presence_db?)?;
        let short_spread = (short_max - short_p50).max(0.0);
        let sustained_gap = (short_p50 - integrated).abs();
        Some(Self {
            arousal: 0.45 * short_p95 + 0.28 * short_p80 + 0.17 * integrated + 0.10 * true_peak,
            brightness: 0.78 * presence + 0.22 * true_peak,
            density: 0.36 * short_p50 + 0.28 * short_p80 + 0.20 * integrated
                - 0.11 * lra
                - 0.05 * short_spread,
            complexity: 0.54 * lra + 0.34 * short_spread + 0.12 * sustained_gap,
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct AudioStyleRobustUnitScale {
    low: f32,
    high: f32,
}

impl AudioStyleRobustUnitScale {
    fn from_values(mut values: Vec<f32>) -> Self {
        values.retain(|value| value.is_finite());
        if values.is_empty() {
            return Self {
                low: 0.0,
                high: 1.0,
            };
        }
        values.sort_by(|left, right| left.total_cmp(right));
        Self {
            low: sorted_quantile(&values, 0.05),
            high: sorted_quantile(&values, 0.95),
        }
    }

    fn project(self, value: f32) -> f32 {
        ((value - self.low) / (self.high - self.low).max(1.0e-6)).clamp(0.0, 1.0)
    }
}

fn finite_f32(value: f32) -> Option<f32> {
    value.is_finite().then_some(value)
}

fn audio_style_auditory_recent_ewma(
    states_newest_first: &[AudioStyleAuditoryState],
) -> AudioStyleAuditoryState {
    let mut values = states_newest_first
        .last()
        .map(|state| state.values)
        .unwrap_or(AUDIO_STYLE_AUDITORY_PRESSURE_TARGETS);
    for state in states_newest_first.iter().rev().skip(1) {
        for (value, next) in values.iter_mut().zip(state.values) {
            *value = AUDIO_STYLE_AUDITORY_PRESSURE_DECAY * *value
                + (1.0 - AUDIO_STYLE_AUDITORY_PRESSURE_DECAY) * next;
        }
    }
    AudioStyleAuditoryState { values }
}

fn audio_style_auditory_recent_center(
    states_newest_first: &[AudioStyleAuditoryState],
) -> AudioStyleAuditoryState {
    let count = states_newest_first.len().min(8);
    if count == 0 {
        return AudioStyleAuditoryState {
            values: AUDIO_STYLE_AUDITORY_PRESSURE_TARGETS,
        };
    }
    let mut values = [0.0_f32; AUDIO_STYLE_AUDITORY_STATE_WIDTH];
    for state in states_newest_first.iter().take(count) {
        for (value, component) in values.iter_mut().zip(state.values) {
            *value += component;
        }
    }
    for value in &mut values {
        *value /= count as f32;
    }
    AudioStyleAuditoryState { values }
}

fn audio_style_auditory_penalty(
    candidate: AudioStyleAuditoryState,
    ewma: AudioStyleAuditoryState,
    recent_center: AudioStyleAuditoryState,
) -> f32 {
    let mut directional = 0.0_f32;
    let mut distance_to_recent = 0.0_f32;
    let mut extreme = 0.0_f32;
    for index in 0..AUDIO_STYLE_AUDITORY_STATE_WIDTH {
        let target = AUDIO_STYLE_AUDITORY_PRESSURE_TARGETS[index];
        let candidate_delta = candidate.values[index] - target;
        let ewma_delta = ewma.values[index] - target;
        directional += candidate_delta * ewma_delta * AUDIO_STYLE_AUDITORY_PRESSURE_STRENGTHS[index];
        let recent_delta = candidate.values[index] - recent_center.values[index];
        distance_to_recent += recent_delta * recent_delta;
        extreme += (candidate_delta.abs() - 0.43).max(0.0);
    }
    let proximity = (-distance_to_recent / 0.08).exp();
    (directional
        + AUDIO_STYLE_AUDITORY_RECENT_STATE_STRENGTH * proximity
        + AUDIO_STYLE_AUDITORY_EXTREME_STATE_STRENGTH * extreme)
        .max(0.0)
}

fn audio_style_loudness_profiles_from_indexed_tracks(
    indexed_tracks: &HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
) -> AudioStyleLoudnessProfileMap {
    indexed_tracks
        .iter()
        .filter_map(|(key, indexed)| {
            indexed
                .track
                .loudness_profile
                .filter(|profile| profile.is_valid())
                .map(|profile| (key.clone(), profile))
        })
        .collect()
}

fn audio_style_loudness_profiles_for_embeddings(
    mut profiles: AudioStyleLoudnessProfileMap,
    indexed_tracks: &HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
    embeddings: &AudioStyleEmbeddingMap,
) -> AudioStyleLoudnessProfileMap {
    for (key, indexed) in indexed_tracks {
        if !embeddings.contains_key(key) || profiles.contains_key(key) {
            continue;
        }
        if let Some(profile) = indexed.track.loudness_profile.filter(|profile| profile.is_valid()) {
            profiles.insert(key.clone(), profile);
        }
    }
    profiles.retain(|key, profile| embeddings.contains_key(key) && profile.is_valid());
    profiles
}

impl AudioStyleModelState {
    fn refresh_from_with_progress(
        previous: Option<&Self>,
        cache: &AudioStyleEmbeddingCache,
        indexed_tracks: Vec<AudioStyleIndexedTrack>,
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

        let loudness_profiles = audio_style_loudness_profiles_from_indexed_tracks(&indexed_by_key);
        let mut embeddings = AudioStyleEmbeddingMap::new();
        let mut previous_reused = HashSet::new();
        let mut cache_reused = 0usize;
        let mut missing_tracks = Vec::new();
        let mut failed = Vec::new();

        for (key, track) in ordered_tracks {
            if let Some(embedding) = previous.and_then(|state| state.embeddings.get(&key)) {
                embeddings.insert(key.clone(), Arc::clone(embedding));
                previous_reused.insert(key);
                continue;
            }

            match cache.cached_embedding_for_track(&track) {
                Ok(Some(embedding)) => {
                    embeddings.insert(key, Arc::new(embedding));
                    cache_reused += 1;
                }
                Ok(None) => missing_tracks.push((key, track)),
                Err(error) => {
                    log::debug!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_embedding_cache_evidence_ignored music=\"{}\" url=\"{}\" range={}..{} path=\"{}\" error=\"{}\"",
                        escape_log_value(&track.music_name),
                        escape_log_value(&track.music_url),
                        track.start_ms,
                        track.end_ms,
                        escape_log_value(&track.file_path.display().to_string()),
                        escape_log_value(&error)
                    );
                    missing_tracks.push((key, track));
                }
            }
        }

        let worker_profile = AudioStyleTrainingWorkerProfile::detect(missing_tracks.len());
        let worker_count = worker_profile.worker_count();
        if worker_count > 0 {
            let embedding_started = Instant::now();
            let missing_count = missing_tracks.len();
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_embeddings_started total_tracks={} reused_embeddings={} cache_reused_embeddings={} pending_embeddings={} workers={worker_count} decode_workers={} decode_prefetch_workers={} cpu_parallelism={} tensor_backend={} tensor_device_count={} tensor_device_source={} policy=\"{}\"",
                indexed_by_key.len(),
                embeddings.len(),
                cache_reused,
                missing_count,
                worker_profile.decode_worker_count,
                worker_profile.decode_prefetch_worker_count,
                worker_profile.cpu_parallelism,
                worker_profile.tensor_backend.as_str(),
                worker_profile.tensor_device_count,
                worker_profile.tensor_device_source,
                worker_profile.policy
            );
            let (results, result_count) =
                build_audio_style_embeddings_concurrently(cache, missing_tracks, worker_count);
            let mut pending = Vec::new();
            let mut remaining = result_count;
            let mut completed = 0usize;
            let mut cache_hits = 0usize;
            let mut decoded = 0usize;

            while remaining > 0 {
                let mut heartbeat_timed_out = false;
                match results.recv_timeout(Duration::from_millis(AUDIO_STYLE_TRAINING_HEARTBEAT_MS))
                {
                    Ok(result) => {
                        remaining -= 1;
                        completed += 1;
                        record_audio_style_embedding_worker_result(
                            result,
                            completed,
                            remaining,
                            result_count,
                            &mut cache_hits,
                            &mut decoded,
                            &mut pending,
                            &mut failed,
                        );
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        heartbeat_timed_out = true;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }

                while pending.len() < AUDIO_STYLE_TRAINING_PROGRESS_BATCH {
                    match results.try_recv() {
                        Ok(result) => {
                            remaining = remaining.saturating_sub(1);
                            completed += 1;
                            record_audio_style_embedding_worker_result(
                                result,
                                completed,
                                remaining,
                                result_count,
                                &mut cache_hits,
                                &mut decoded,
                                &mut pending,
                                &mut failed,
                            );
                        }
                        Err(mpsc::TryRecvError::Empty) | Err(mpsc::TryRecvError::Disconnected) => {
                            break;
                        }
                    }
                }

                if !pending.is_empty()
                    && (pending.len() >= AUDIO_STYLE_TRAINING_PROGRESS_BATCH
                        || heartbeat_timed_out
                        || remaining == 0)
                {
                    Self::apply_embedding_progress(&mut embeddings, pending.drain(..));
                    log::info!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_training_embedding_progress total_tracks={} indexed_embeddings={} completed={} remaining={} cache_hits={} decoded={} failed={} policy=\"defer_snapshot_until_complete\"",
                        indexed_by_key.len(),
                        embeddings.len(),
                        completed,
                        remaining,
                        cache_hits,
                        decoded,
                        failed.len()
                    );
                }
            }

            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_embeddings_finished total={} ok={} failed={} cache_hits={} decoded={} workers={worker_count} elapsed_ms={} tracks_per_second={:.3}",
                result_count,
                result_count.saturating_sub(failed.len()),
                failed.len(),
                cache_hits,
                decoded,
                embedding_started.elapsed().as_millis(),
                tracks_per_second(result_count, embedding_started.elapsed())
            );

            if !pending.is_empty() {
                Self::apply_embedding_progress(&mut embeddings, pending.drain(..));
            }
        } else if !indexed_by_key.is_empty() {
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_embeddings_skipped total_tracks={} reused_embeddings={} cache_reused_embeddings={} pending_embeddings=0 reason=all_embeddings_reused",
                indexed_by_key.len(),
                embeddings.len(),
                cache_reused
            );
        }

        let state = Self::from_embeddings(
            previous,
            embeddings,
            loudness_profiles,
            indexed_by_key,
            &previous_reused,
        );
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

    fn apply_embedding_progress(
        embeddings: &mut AudioStyleEmbeddingMap,
        progress: impl IntoIterator<Item = (PlaybackTrackKey, AudioStyleEmbedding)>,
    ) {
        for (key, embedding) in progress {
            embeddings.insert(key, Arc::new(embedding));
        }
    }

    fn from_embeddings(
        previous: Option<&Self>,
        embeddings: AudioStyleEmbeddingMap,
        loudness_profiles: AudioStyleLoudnessProfileMap,
        indexed_tracks: HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
        previous_reused: &HashSet<PlaybackTrackKey>,
    ) -> Self {
        let stats = AudioStyleStats::from_embeddings(&embeddings);
        let neighbor_index =
            AudioStyleNeighborIndex::refresh_from(previous, &embeddings, &stats, previous_reused);
        let loudness_profiles = audio_style_loudness_profiles_for_embeddings(
            loudness_profiles,
            &indexed_tracks,
            &embeddings,
        );
        let auditory_geometry = AudioStyleAuditoryGeometry::from_loudness_profiles(&loudness_profiles);
        Self {
            embeddings,
            loudness_profiles,
            auditory_geometry,
            indexed_tracks,
            stats,
            neighbor_index,
        }
    }
}

struct AudioStyleEmbeddingWorkerResult {
    key: PlaybackTrackKey,
    file_path: PathBuf,
    music_name: String,
    music_url: String,
    start_ms: u32,
    end_ms: u32,
    worker_id: usize,
    elapsed_ms: u128,
    embedding: Result<AudioStyleEmbeddingTrainingResult, String>,
}

struct AudioStyleEmbeddingWorkerSummary {
    file_path: PathBuf,
    music_name: String,
    music_url: String,
    start_ms: u32,
    end_ms: u32,
    worker_id: usize,
    elapsed_ms: u128,
}

fn record_audio_style_embedding_worker_result(
    result: AudioStyleEmbeddingWorkerResult,
    completed: usize,
    remaining: usize,
    total: usize,
    cache_hits: &mut usize,
    decoded: &mut usize,
    pending: &mut Vec<(PlaybackTrackKey, AudioStyleEmbedding)>,
    failed: &mut Vec<String>,
) {
    let AudioStyleEmbeddingWorkerResult {
        key,
        file_path,
        music_name,
        music_url,
        start_ms,
        end_ms,
        worker_id,
        elapsed_ms,
        embedding,
    } = result;
    let summary = AudioStyleEmbeddingWorkerSummary {
        file_path,
        music_name,
        music_url,
        start_ms,
        end_ms,
        worker_id,
        elapsed_ms,
    };

    match embedding {
        Ok(training_result) => {
            let source = training_result.source;
            match source {
                AudioStyleEmbeddingTrainingSource::CacheHit => *cache_hits += 1,
                AudioStyleEmbeddingTrainingSource::Decoded => *decoded += 1,
            }
            log_audio_style_training_leaf_finished(
                &summary,
                "ok",
                Some(source),
                completed,
                remaining,
                total,
            );
            pending.push((key, training_result.embedding));
        }
        Err(error) => {
            log::error!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_embedding_index_failed worker={} music=\"{}\" url=\"{}\" range={}..{} path=\"{}\" elapsed_ms={} completed={} remaining={} total={} error=\"{}\"",
                summary.worker_id,
                escape_log_value(&summary.music_name),
                escape_log_value(&summary.music_url),
                summary.start_ms,
                summary.end_ms,
                escape_log_value(&summary.file_path.display().to_string()),
                summary.elapsed_ms,
                completed,
                remaining,
                total,
                escape_log_value(&error)
            );
            failed.push(format!("{}: {error}", summary.file_path.display()));
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AudioStyleTrainingTensorBackend {
    Hardware,
    Cpu,
}

impl AudioStyleTrainingTensorBackend {
    fn as_str(self) -> &'static str {
        match self {
            Self::Hardware => "hardware",
            Self::Cpu => "cpu",
        }
    }
}

#[derive(Clone, Debug)]
struct AudioStyleTrainingWorkerProfile {
    cpu_parallelism: usize,
    tensor_backend: AudioStyleTrainingTensorBackend,
    tensor_device_count: usize,
    tensor_device_source: &'static str,
    decode_worker_count: usize,
    decode_prefetch_worker_count: usize,
    policy: &'static str,
}

impl AudioStyleTrainingWorkerProfile {
    fn detect(track_count: usize) -> Self {
        let cpu_parallelism = thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(AUDIO_STYLE_TRAINING_BASE_WORKERS)
            .max(1);
        let tensor_profile = AudioStyleTensorRuntime::new().backend_profile();
        let decode_prefetch_worker_count = audio_style_decode_prefetch_worker_count(
            tensor_profile.backend,
            tensor_profile.tensor_device_count,
            tensor_profile.hardware_memory_budget_bytes,
        );
        let decode_worker_count = audio_style_training_worker_count_for_profile(
            track_count,
            cpu_parallelism,
            tensor_profile.backend,
            tensor_profile.tensor_device_count,
            tensor_profile.hardware_memory_budget_bytes,
        );
        Self {
            cpu_parallelism,
            tensor_backend: tensor_profile.backend,
            tensor_device_count: tensor_profile.tensor_device_count,
            tensor_device_source: tensor_profile.device_source,
            decode_worker_count,
            decode_prefetch_worker_count,
            policy: "bounded_cpu_decode_prefetch_from_tensor_device_pool",
        }
    }

    fn worker_count(&self) -> usize {
        self.decode_worker_count
    }
}

fn audio_style_training_worker_count_for_profile(
    track_count: usize,
    cpu_parallelism: usize,
    tensor_backend: AudioStyleTrainingTensorBackend,
    tensor_device_count: usize,
    hardware_memory_budget_bytes: usize,
) -> usize {
    if track_count == 0 {
        return 0;
    }

    let cpu_parallelism = cpu_parallelism.max(1);
    let decode_prefetch_workers = audio_style_decode_prefetch_worker_count(
        tensor_backend,
        tensor_device_count,
        hardware_memory_budget_bytes,
    );
    let decode_workers = match tensor_backend {
        AudioStyleTrainingTensorBackend::Hardware => {
            cpu_parallelism.min(AUDIO_STYLE_TRAINING_HARDWARE_DECODE_WORKER_CAP)
        }
        AudioStyleTrainingTensorBackend::Cpu => cpu_parallelism,
    };
    let limit = decode_workers
        .saturating_add(decode_prefetch_workers)
        .max(1);
    track_count.min(limit)
}

fn audio_style_decode_prefetch_worker_count(
    tensor_backend: AudioStyleTrainingTensorBackend,
    tensor_device_count: usize,
    hardware_memory_budget_bytes: usize,
) -> usize {
    match tensor_backend {
        AudioStyleTrainingTensorBackend::Hardware => {
            let budget_units = hardware_memory_budget_bytes
                .checked_div(AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_BASE_BYTES)
                .unwrap_or(0)
                .max(1);
            tensor_device_count
                .saturating_mul(AUDIO_STYLE_TENSOR_HARDWARE_DECODE_PREFETCH_PER_DEVICE)
                .min(budget_units.saturating_mul(2))
                .min(AUDIO_STYLE_TENSOR_HARDWARE_DECODE_PREFETCH_MAX)
        }
        AudioStyleTrainingTensorBackend::Cpu => 0,
    }
}

fn audio_style_hardware_similarity_grid_budget_allows(
    anchors: usize,
    candidates: usize,
    hardware_memory_budget_bytes: usize,
) -> bool {
    let bytes = anchors
        .checked_mul(candidates)
        .and_then(|values| values.checked_mul(AUDIO_STYLE_TENSOR_F32_BYTES))
        .and_then(|similarities| {
            anchors
                .checked_add(candidates)
                .and_then(|rows| rows.checked_mul(AUDIO_STYLE_EMBEDDING_WIDTH))
                .and_then(|values| values.checked_mul(AUDIO_STYLE_TENSOR_F32_BYTES))
                .and_then(|matrix| matrix.checked_mul(4))
                .and_then(|working| working.checked_add(similarities.checked_mul(2)?))
        });
    audio_style_hardware_tensor_budget_allows(
        "centered_similarity_grid",
        bytes,
        hardware_memory_budget_bytes,
    )
}

fn audio_style_hardware_softmin_budget_allows(
    len: usize,
    hardware_memory_budget_bytes: usize,
) -> bool {
    let bytes = len
        .checked_mul(8)
        .and_then(|values| values.checked_mul(AUDIO_STYLE_TENSOR_F32_BYTES));
    audio_style_hardware_tensor_budget_allows(
        "softmin_weights",
        bytes,
        hardware_memory_budget_bytes,
    )
}

fn audio_style_hardware_similarity_grid_tile_shape(
    anchors: usize,
    candidates: usize,
    hardware_memory_budget_bytes: usize,
) -> Option<(usize, usize)> {
    if anchors == 0 || candidates == 0 {
        return None;
    }
    if !audio_style_hardware_similarity_grid_budget_allows(1, 1, hardware_memory_budget_bytes) {
        return None;
    }
    let mut anchor_tile = anchors;
    let mut candidate_tile = candidates;
    while !audio_style_hardware_similarity_grid_budget_allows(
        anchor_tile,
        candidate_tile,
        hardware_memory_budget_bytes,
    ) {
        if anchor_tile >= candidate_tile && anchor_tile > 1 {
            anchor_tile = anchor_tile.div_ceil(2);
        } else if candidate_tile > 1 {
            candidate_tile = candidate_tile.div_ceil(2);
        } else if anchor_tile > 1 {
            anchor_tile = anchor_tile.div_ceil(2);
        } else {
            return None;
        }
    }
    Some((anchor_tile.max(1), candidate_tile.max(1)))
}

fn audio_style_hardware_tensor_budget_allows(
    operation: &'static str,
    bytes: Option<usize>,
    hardware_memory_budget_bytes: usize,
) -> bool {
    let Some(bytes) = bytes else {
        log::warn!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_tensor_hardware_op_skipped operation={operation} reason=budget_overflow action=try_tile_or_cpu_fallback"
        );
        return false;
    };
    if bytes <= hardware_memory_budget_bytes {
        return true;
    }
    log::info!(
        target: AUDIO_STYLE_LOG_TARGET,
        "audio_style_tensor_hardware_op_skipped operation={operation} reason=budget_exceeded bytes={bytes} budget_bytes={} action=try_tile_or_cpu_fallback",
        hardware_memory_budget_bytes
    );
    false
}

fn audio_style_hardware_memory_budget_bytes_for_devices(devices: &[WgpuDevice]) -> usize {
    devices
        .iter()
        .map(audio_style_hardware_memory_budget_bytes_for_device)
        .max()
        .unwrap_or(0)
        .max(AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_MIN_BYTES)
}

fn audio_style_hardware_memory_budget_bytes_for_device(device: &WgpuDevice) -> usize {
    match device {
        WgpuDevice::DiscreteGpu(_) => AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_DISCRETE_BYTES,
        WgpuDevice::IntegratedGpu(_) => AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_INTEGRATED_BYTES,
        WgpuDevice::VirtualGpu(_) => AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_VIRTUAL_BYTES,
        WgpuDevice::DefaultDevice => AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_DEFAULT_BYTES,
        #[allow(deprecated)]
        WgpuDevice::BestAvailable => AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_DEFAULT_BYTES,
        WgpuDevice::Existing(_) => AUDIO_STYLE_TENSOR_HARDWARE_MEMORY_BUDGET_DEFAULT_BYTES,
        WgpuDevice::Cpu => 0,
    }
}

fn audio_style_embeddings_from_matrix(
    matrix: &AudioStyleTensorMatrix,
) -> Option<Vec<AudioStyleEmbedding>> {
    if matrix.flat_values.len() != matrix.keys.len() * AUDIO_STYLE_EMBEDDING_WIDTH {
        return None;
    }
    matrix
        .flat_values
        .chunks_exact(AUDIO_STYLE_EMBEDDING_WIDTH)
        .map(|values| {
            Some(AudioStyleEmbedding {
                values: values.to_vec(),
            })
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn audio_style_training_worker_count_for_test(
    track_count: usize,
    cpu_parallelism: usize,
    hardware_backend: bool,
    tensor_device_count: usize,
) -> usize {
    audio_style_training_worker_count_for_profile(
        track_count,
        cpu_parallelism,
        if hardware_backend {
            AudioStyleTrainingTensorBackend::Hardware
        } else {
            AudioStyleTrainingTensorBackend::Cpu
        },
        tensor_device_count,
        audio_style_hardware_memory_budget_bytes_for_test(tensor_device_count),
    )
}

#[cfg(test)]
pub(crate) fn audio_style_hardware_similarity_grid_tile_shape_for_test(
    anchors: usize,
    candidates: usize,
    tensor_device_count: usize,
) -> Option<(usize, usize)> {
    audio_style_hardware_similarity_grid_tile_shape(
        anchors,
        candidates,
        audio_style_hardware_memory_budget_bytes_for_test(tensor_device_count),
    )
}

#[cfg(test)]
fn audio_style_hardware_memory_budget_bytes_for_test(tensor_device_count: usize) -> usize {
    audio_style_hardware_memory_budget_bytes_for_devices(
        &(0..tensor_device_count)
            .map(WgpuDevice::DiscreteGpu)
            .collect::<Vec<_>>(),
    )
}

fn build_audio_style_embeddings_concurrently(
    cache: &AudioStyleEmbeddingCache,
    missing_tracks: Vec<(PlaybackTrackKey, PlaybackTrack)>,
    worker_count: usize,
) -> (mpsc::Receiver<AudioStyleEmbeddingWorkerResult>, usize) {
    let (result_tx, result_rx) = mpsc::channel();
    let result_count = missing_tracks.len();
    if result_count == 0 || worker_count == 0 {
        return (result_rx, 0);
    }

    let queue = Arc::new(Mutex::new(VecDeque::from(missing_tracks)));
    for worker_index in 0..worker_count {
        let queue = Arc::clone(&queue);
        let result_tx = result_tx.clone();
        let cache = cache.clone();
        let worker_id = worker_index + 1;
        thread::spawn(move || {
            loop {
                let next = match queue.lock() {
                    Ok(mut queue) => queue.pop_front(),
                    Err(_) => {
                        let _ = result_tx.send(AudioStyleEmbeddingWorkerResult {
                            key: PlaybackTrackKey::empty_anchor(),
                            file_path: PathBuf::new(),
                            music_name: String::new(),
                            music_url: String::new(),
                            start_ms: 0,
                            end_ms: 0,
                            worker_id,
                            elapsed_ms: 0,
                            embedding: Err(
                                "audio style training work queue lock is poisoned".to_string()
                            ),
                        });
                        return;
                    }
                };
                let Some((key, track)) = next else {
                    return;
                };
                let started = Instant::now();
                let file_path = track.file_path.clone();
                let music_name = track.music_name.clone();
                let music_url = track.music_url.clone();
                let start_ms = track.start_ms;
                let end_ms = track.end_ms;
                let embedding = cache.embedding_result_for_track(&track);
                let elapsed_ms = started.elapsed().as_millis();
                if result_tx
                    .send(AudioStyleEmbeddingWorkerResult {
                        key,
                        file_path,
                        music_name,
                        music_url,
                        start_ms,
                        end_ms,
                        worker_id,
                        elapsed_ms,
                        embedding,
                    })
                    .is_err()
                {
                    return;
                }
            }
        });
    }
    drop(result_tx);

    (result_rx, result_count)
}

fn log_audio_style_training_leaf_finished(
    result: &AudioStyleEmbeddingWorkerSummary,
    status: &str,
    source: Option<AudioStyleEmbeddingTrainingSource>,
    completed: usize,
    remaining: usize,
    total: usize,
) {
    log::info!(
        target: AUDIO_STYLE_LOG_TARGET,
        "audio_style_embedding_index_finished worker={} status={status} source={} music=\"{}\" url=\"{}\" range={}..{} path=\"{}\" elapsed_ms={} completed={completed} remaining={remaining} total={total}",
        result.worker_id,
        source.map(AudioStyleEmbeddingTrainingSource::as_str).unwrap_or("none"),
        escape_log_value(&result.music_name),
        escape_log_value(&result.music_url),
        result.start_ms,
        result.end_ms,
        escape_log_value(&result.file_path.display().to_string()),
        result.elapsed_ms
    );
}

fn tracks_per_second(track_count: usize, elapsed: Duration) -> f64 {
    let seconds = elapsed.as_secs_f64();
    if seconds <= f64::EPSILON {
        return 0.0;
    }
    track_count as f64 / seconds
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

        Self::repair_neighbors_for_added_keys(&mut neighbors, embeddings, &mean, &added_keys);

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
        let mut neighbor_lists =
            HashMap::<PlaybackTrackKey, Vec<(PlaybackTrackKey, f32)>>::with_capacity(
                embeddings.len(),
            );
        for key in embeddings.keys() {
            neighbor_lists.insert(key.clone(), Vec::new());
        }

        if !runtime.visit_centered_similarity_pairs(embeddings, &mean, |left, right, similarity| {
            push_audio_style_neighbor(neighbor_lists.get_mut(left), right.clone(), similarity);
            push_audio_style_neighbor(neighbor_lists.get_mut(right), left.clone(), similarity);
        }) {
            return Self::from_embeddings_pairwise(embeddings, &mean);
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

    fn repair_neighbors_for_added_keys(
        neighbors: &mut HashMap<PlaybackTrackKey, Vec<PlaybackTrackKey>>,
        embeddings: &AudioStyleEmbeddingMap,
        mean: &[f32],
        added_keys: &[PlaybackTrackKey],
    ) {
        let existing_keys = embeddings.keys().cloned().collect::<Vec<_>>();
        let anchors = existing_keys
            .iter()
            .filter_map(|key| embeddings.get(key).map(|embedding| embedding.as_ref()))
            .collect::<Vec<_>>();
        let added_embeddings = added_keys
            .iter()
            .filter_map(|key| embeddings.get(key).map(|embedding| embedding.as_ref()))
            .collect::<Vec<_>>();
        if anchors.len() != existing_keys.len() || added_embeddings.len() != added_keys.len() {
            return Self::repair_neighbors_for_added_keys_pairwise(
                neighbors, embeddings, mean, added_keys,
            );
        }

        let Some(similarities) = AudioStyleTensorRuntime::new().centered_similarity_grid(
            &anchors,
            &added_embeddings,
            mean,
        ) else {
            return Self::repair_neighbors_for_added_keys_pairwise(
                neighbors, embeddings, mean, added_keys,
            );
        };

        for (anchor_index, key) in existing_keys.iter().enumerate() {
            let Some(anchor_embedding) = embeddings.get(key) else {
                continue;
            };
            let mut indexed = neighbors
                .remove(key)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|neighbor| {
                    let neighbor_embedding = embeddings.get(&neighbor)?;
                    centered_cosine(anchor_embedding, neighbor_embedding, mean)
                        .map(|value| (neighbor, value))
                })
                .collect::<Vec<_>>();

            for (added_index, added_key) in added_keys.iter().enumerate() {
                if key == added_key {
                    continue;
                }
                let similarity = similarities[anchor_index * added_keys.len() + added_index];
                push_audio_style_neighbor(Some(&mut indexed), added_key.clone(), similarity);
            }

            neighbors.insert(
                key.clone(),
                indexed
                    .into_iter()
                    .map(|(neighbor, _)| neighbor)
                    .collect::<Vec<_>>(),
            );
        }
    }

    fn repair_neighbors_for_added_keys_pairwise(
        neighbors: &mut HashMap<PlaybackTrackKey, Vec<PlaybackTrackKey>>,
        embeddings: &AudioStyleEmbeddingMap,
        mean: &[f32],
        added_keys: &[PlaybackTrackKey],
    ) {
        for added_key in added_keys {
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
                let Some(similarity) = centered_cosine(embedding, added_embedding, mean) else {
                    continue;
                };
                let mut indexed = neighbors
                    .remove(key)
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|neighbor| {
                        let neighbor_embedding = embeddings.get(&neighbor)?;
                        centered_cosine(embedding, neighbor_embedding, mean)
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

fn centered_cosine_cpu(
    left: &AudioStyleEmbedding,
    right: &AudioStyleEmbedding,
    mean: &[f32],
) -> Option<f32> {
    if left.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH
        || right.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH
        || mean.len() != AUDIO_STYLE_EMBEDDING_WIDTH
    {
        return None;
    }

    let mut dot = 0.0_f32;
    let mut left_norm = 0.0_f32;
    let mut right_norm = 0.0_f32;
    for ((left, right), mean) in left.values.iter().zip(right.values.iter()).zip(mean.iter()) {
        let centered_left = left - mean;
        let centered_right = right - mean;
        dot += centered_left * centered_right;
        left_norm += centered_left * centered_left;
        right_norm += centered_right * centered_right;
    }
    let denom = left_norm.sqrt() * right_norm.sqrt();
    if denom <= 1.0e-6 {
        return None;
    }
    Some((dot / denom).clamp(-1.0, 1.0))
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
        Ok(Self {
            cache_root,
            ffmpeg_path,
        })
    }

    fn embedding_result_for_track(
        &self,
        track: &PlaybackTrack,
    ) -> Result<AudioStyleEmbeddingTrainingResult, String> {
        let cache_key = build_audio_style_embedding_cache_key(track)?;
        let cache_path = self.cache_root.join(format!("{cache_key}.json"));
        match read_cached_audio_style_embedding_with_kind(&cache_path) {
            Ok(embedding) => {
                return Ok(AudioStyleEmbeddingTrainingResult {
                    embedding,
                    source: AudioStyleEmbeddingTrainingSource::CacheHit,
                });
            }
            Err(error) if error.kind == AudioStyleEmbeddingCacheReadErrorKind::Missing => {}
            Err(error) => {
                log::debug!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_embedding_cache_ignored path=\"{}\" error=\"{}\"",
                    escape_log_value(&cache_path.display().to_string()),
                    escape_log_value(&error.message)
                );
            }
        }

        let _usage = acquire_audio_style_ffmpeg_usage();
        let embedding = decode_audio_style_embedding(&self.ffmpeg_path, track)?;
        write_cached_audio_style_embedding(&cache_path, &embedding)?;
        Ok(AudioStyleEmbeddingTrainingResult {
            embedding,
            source: AudioStyleEmbeddingTrainingSource::Decoded,
        })
    }

    fn cached_embedding_for_track(
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
                loudness_profiles: HashMap::new(),
                indexed_tracks: HashMap::new(),
                sampling_geometry: None,
                auditory_geometry: None,
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
            loudness_profiles: HashMap::new(),
            indexed_tracks: HashMap::new(),
            sampling_geometry: None,
            auditory_geometry: None,
            trained: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_test_indexed_embeddings(
        values: impl IntoIterator<Item = (PlaybackTrack, Vec<f32>, String)>,
    ) -> Self {
        let mut embeddings = HashMap::new();
        let mut loudness_profiles = HashMap::new();
        let mut indexed_tracks = HashMap::new();
        for (track, values, collection_folder) in values {
            let Some(embedding) = AudioStyleEmbedding::normalize(values) else {
                continue;
            };
            let key = PlaybackTrackKey::from_track(&track);
            if let Some(profile) = track.loudness_profile.filter(|profile| profile.is_valid()) {
                loudness_profiles.insert(key.clone(), profile);
            }
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
        Self::from_trained_embeddings_with_loudness(embeddings, loudness_profiles, indexed_tracks)
    }

    pub(crate) fn has_embedding_for(&self, track: &PlaybackTrack) -> bool {
        self.embeddings
            .contains_key(&PlaybackTrackKey::from_track(track))
    }

    #[cfg(test)]
    pub(crate) fn propose_centerless_source(
        &self,
        belongs_to_scope: impl Fn(&PlaylistPlaybackTrackSource) -> bool,
    ) -> Option<(PlaylistPlaybackTrackSource, AudioStyleCandidateSelection)> {
        let scoped = self
            .indexed_tracks
            .values()
            .filter(|indexed| {
                belongs_to_scope(&indexed.source)
                    && self
                        .embeddings
                        .contains_key(&PlaybackTrackKey::from_track(&indexed.track))
            })
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

    pub(crate) fn propose_centerless_source_from_tracks(
        &self,
        candidates: Vec<(PlaylistPlaybackTrackSource, PlaybackTrack)>,
    ) -> Option<(
        PlaylistPlaybackTrackSource,
        PlaybackTrack,
        AudioStyleCandidateSelection,
    )> {
        let scoped = candidates
            .into_iter()
            .filter(|(_, track)| {
                self.embeddings
                    .contains_key(&PlaybackTrackKey::from_track(track))
            })
            .collect::<Vec<_>>();
        let tracks = scoped
            .iter()
            .map(|(_, track)| track.clone())
            .collect::<Vec<_>>();
        let selection = select_centerless_audio_style_candidate(
            &tracks,
            &self.embeddings,
            self.sampling_geometry.as_ref(),
            self.trained,
            rand::rng().random_range(0.0..1.0),
        );
        scoped
            .get(selection.index)
            .cloned()
            .map(|(source, track)| (source, track, selection))
    }

    pub(crate) fn propose_centerless_queue_with_trace_and_recent_history(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
        recently_played_tracks: &[PlaybackTrack],
    ) -> AudioStylePlaylistPlaybackProposal {
        let candidates =
            filter_recently_played_recommendation_candidates(candidates, recently_played_tracks);
        let candidates = dedupe_tracks_excluding(candidates, Some(&current_track))
            .into_iter()
            .filter(|candidate| {
                self.embeddings
                    .contains_key(&PlaybackTrackKey::from_track(candidate))
            })
            .collect::<Vec<_>>();
        let mut queue = vec![current_track];
        let selection = if candidates.is_empty() {
            None
        } else {
            let selection = select_centerless_audio_style_candidate(
                &candidates,
                &self.embeddings,
                self.sampling_geometry.as_ref(),
                self.trained,
                rand::rng().random_range(0.0..1.0),
            );
            candidates.get(selection.index).cloned().map(|track| {
                queue.push(track);
                selection
            })
        };

        AudioStylePlaylistPlaybackProposal {
            tracks: queue,
            selection,
        }
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
            self.auditory_geometry.as_ref(),
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
        Self::from_trained_embeddings_with_loudness(embeddings, HashMap::new(), indexed_tracks)
    }

    #[cfg(test)]
    fn from_trained_embeddings_with_loudness(
        embeddings: AudioStyleEmbeddingMap,
        loudness_profiles: AudioStyleLoudnessProfileMap,
        indexed_tracks: HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
    ) -> Self {
        let state = AudioStyleModelState::from_embeddings(
            None,
            embeddings,
            loudness_profiles,
            indexed_tracks,
            &HashSet::new(),
        );
        Self::from_state(&state, true)
    }

    fn from_state(state: &AudioStyleModelState, trained: bool) -> Self {
        let sampling_geometry = AudioStyleSamplingGeometry::from_state(state);
        Self {
            embeddings: state.embeddings.clone(),
            loudness_profiles: state.loudness_profiles.clone(),
            indexed_tracks: state.indexed_tracks.clone(),
            sampling_geometry,
            auditory_geometry: state.auditory_geometry.clone(),
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
        Self::refresh_from_indexed_tracks(previous, cache, indexed_tracks, || generation)
    }

    fn refresh_from_indexed_tracks(
        previous: Option<&Self>,
        cache: &AudioStyleEmbeddingCache,
        indexed_tracks: Vec<AudioStyleIndexedTrack>,
        mut next_generation: impl FnMut() -> u64,
    ) -> Result<Self, AudioStyleModelUpdateFailure> {
        let state = AudioStyleModelState::refresh_from_with_progress(
            previous.map(|snapshot| snapshot.state.as_ref()),
            cache,
            indexed_tracks,
        )?;
        Ok(Self::from_state(next_generation(), Arc::new(state)))
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

    fn from_model_evidence(
        generation: u64,
        embeddings: AudioStyleEmbeddingMap,
        loudness_profiles: AudioStyleLoudnessProfileMap,
    ) -> Result<Self, String> {
        if embeddings.is_empty() {
            return Err("audio style model evidence has no embeddings".to_string());
        }
        let state = Arc::new(AudioStyleModelState::from_embeddings(
            None,
            embeddings,
            loudness_profiles,
            HashMap::new(),
            &HashSet::new(),
        ));
        Ok(Self::from_state(generation, state))
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
            recommender.loudness_profiles.clone(),
            HashMap::new(),
            &HashSet::new(),
        ));
        Self::from_state(generation, state)
    }

    #[cfg(test)]
    pub(crate) fn from_test_indexed_embeddings(
        generation: u64,
        values: impl IntoIterator<Item = (PlaybackTrack, Vec<f32>, String)>,
    ) -> Self {
        let recommender =
            AudioStylePlaylistPlaybackRecommender::from_test_indexed_embeddings(values);
        let state = Arc::new(AudioStyleModelState::from_embeddings(
            None,
            recommender.embeddings.clone(),
            recommender.loudness_profiles.clone(),
            recommender.indexed_tracks.clone(),
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
    pub(crate) fn refresh_from_indexed_tracks_for_test(
        generation: u64,
        previous: Option<&Self>,
        cache: &AudioStyleEmbeddingCache,
        tracks: Vec<PlaybackTrack>,
    ) -> Result<Self, String> {
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
        Self::refresh_from_indexed_tracks(previous, cache, indexed_tracks, || generation)
            .map_err(|error| error.into_message())
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

pub(crate) fn should_replace_stable_snapshot(
    current: Option<&AudioStyleModelSnapshot>,
    candidate: &AudioStyleModelSnapshot,
) -> bool {
    current.is_none_or(|current| candidate.generation() > current.generation())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StableSnapshotPublicationReason {
    TrainingComplete,
    StartupEvidence,
}

impl StableSnapshotPublicationReason {
    #[cfg(not(test))]
    fn as_str(self) -> &'static str {
        match self {
            Self::TrainingComplete => "training_complete",
            Self::StartupEvidence => "startup_evidence",
        }
    }
}

pub(crate) fn stable_snapshot_publication_requests_first_slot_refresh(
    reason: StableSnapshotPublicationReason,
    stable_existed: bool,
) -> bool {
    match reason {
        StableSnapshotPublicationReason::TrainingComplete => true,
        StableSnapshotPublicationReason::StartupEvidence => !stable_existed,
    }
}

pub(crate) fn audio_style_startup_training_decision(
    restored_model_evidence: bool,
    pending_input_changes: u64,
) -> AudioStyleStartupTrainingDecision {
    if pending_input_changes > 0 {
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges
    } else if restored_model_evidence {
        AudioStyleStartupTrainingDecision::SkipRestoredEvidence
    } else {
        AudioStyleStartupTrainingDecision::TrainInitialModel
    }
}

pub(crate) fn choose_audio_style_model_snapshots_for_anchor(
    track: &PlaybackTrack,
    snapshots: impl IntoIterator<Item = Arc<AudioStyleModelSnapshot>>,
) -> Vec<Arc<AudioStyleModelSnapshot>> {
    let mut snapshots = snapshots.into_iter().collect::<Vec<_>>();
    let anchor_matches = snapshots
        .iter()
        .filter(|snapshot| snapshot.has_embedding_for(track))
        .cloned()
        .collect::<Vec<_>>();
    if !anchor_matches.is_empty() {
        snapshots = anchor_matches;
    }
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
    auditory_geometry: Option<&AudioStyleAuditoryGeometry>,
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
                + auditory_geometry
                    .map(|geometry| {
                        geometry.penalty_for_decision(candidate, recently_played_tracks)
                    })
                    .unwrap_or(0.0)
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
    if similarities.iter().all(Option::is_none) {
        return random_fallback_selection_from_diagnostics(
            candidates.len(),
            draw_unit,
            Some("no_embedded_candidates"),
            audio_style_candidate_diagnostics(
                candidates,
                embeddings,
                &PlaybackTrackKey::empty_anchor(),
                &similarities,
                Some(random_fallback_index(candidates.len(), draw_unit)),
            ),
        );
    }
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

#[cfg(not(test))]
fn acquire_audio_style_ffmpeg_usage() -> crate::utils::binaries::ManagedBinaryUsageGuard {
    acquire_managed_binary_usage(ManagedBinary::Ffmpeg, "audio_style")
}

#[cfg(test)]
fn acquire_audio_style_ffmpeg_usage() {}

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
    let mut samples = ffplayr::decode_audio_pcm_f32_with_binary(
        ffmpeg_path,
        ffplayr::AudioPcmDecodeRequest::new(input.to_path_buf(), AUDIO_STYLE_SAMPLE_RATE)
            .with_time_range(ffplayr::PlaybackTimeRange {
                start_ms: seconds_to_millis_f64(start_seconds),
                duration_ms: Some(seconds_to_millis_f64(AUDIO_STYLE_INTERVAL_SECONDS)),
            }),
    )?;
    normalize_samples(&mut samples);
    if samples.is_empty() {
        return Err("audio style decode produced no samples".to_string());
    }
    Ok(samples)
}

fn seconds_to_millis_f64(seconds: f64) -> u32 {
    ((seconds.max(0.0) * 1_000.0).round()).min(u32::MAX as f64) as u32
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

#[cfg(test)]
pub(crate) fn cleanup_stale_audio_style_embedding_cache(cache_root: &Path) -> Result<(), String> {
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

#[cfg(test)]
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

fn cached_audio_style_model_evidence_from_snapshot(
    snapshot: &AudioStyleModelSnapshot,
) -> CachedAudioStyleModelEvidence {
    CachedAudioStyleModelEvidence {
        version: AUDIO_STYLE_MODEL_EVIDENCE_VERSION.to_string(),
        embedding_version: AUDIO_STYLE_EMBEDDING_VERSION.to_string(),
        generation: snapshot.generation(),
        embeddings: snapshot
            .state
            .embeddings
            .iter()
            .map(|(key, embedding)| CachedAudioStyleModelEmbedding {
                key: CachedPlaybackTrackKey::from(key),
                values: embedding.values.clone(),
                loudness_profile: snapshot.state.loudness_profiles.get(key).copied(),
            })
            .collect(),
    }
}

fn snapshot_from_cached_audio_style_model_evidence(
    cached: CachedAudioStyleModelEvidence,
    path: &Path,
) -> Result<AudioStyleModelSnapshot, String> {
    if cached.version != AUDIO_STYLE_MODEL_EVIDENCE_VERSION {
        return Err(format!(
            "audio style model evidence `{}` has unsupported version `{}`",
            path.display(),
            cached.version
        ));
    }
    if cached.embedding_version != AUDIO_STYLE_EMBEDDING_VERSION {
        return Err(format!(
            "audio style model evidence `{}` has unsupported embedding version `{}`",
            path.display(),
            cached.embedding_version
        ));
    }

    let mut embeddings = AudioStyleEmbeddingMap::new();
    let mut loudness_profiles = AudioStyleLoudnessProfileMap::new();
    for cached_embedding in cached.embeddings {
        let key = PlaybackTrackKey::from(cached_embedding.key);
        let embedding =
            AudioStyleEmbedding::normalize(cached_embedding.values).ok_or_else(|| {
                format!(
                    "audio style model evidence `{}` has an invalid embedding width",
                    path.display()
                )
            })?;
        if let Some(profile) = cached_embedding
            .loudness_profile
            .filter(|profile| profile.is_valid())
        {
            loudness_profiles.insert(key.clone(), profile);
        }
        embeddings.insert(key, Arc::new(embedding));
    }

    AudioStyleModelSnapshot::from_model_evidence(cached.generation, embeddings, loudness_profiles)
}

fn read_cached_audio_style_model_evidence(path: &Path) -> Result<AudioStyleModelSnapshot, String> {
    let bytes = fs::read(path).map_err(|error| {
        format!(
            "failed to read audio style model evidence `{}`: {error}",
            path.display()
        )
    })?;
    let cached =
        serde_json::from_slice::<CachedAudioStyleModelEvidence>(&bytes).map_err(|error| {
            format!(
                "failed to parse audio style model evidence `{}`: {error}",
                path.display()
            )
        })?;
    snapshot_from_cached_audio_style_model_evidence(cached, path)
}

#[cfg(test)]
pub(crate) fn read_cached_audio_style_model_evidence_for_test(
    path: &Path,
) -> Result<AudioStyleModelSnapshot, String> {
    read_cached_audio_style_model_evidence(path)
}

fn write_cached_audio_style_model_evidence(
    path: &Path,
    snapshot: &AudioStyleModelSnapshot,
) -> Result<(), String> {
    let cached = cached_audio_style_model_evidence_from_snapshot(snapshot);
    let bytes = serde_json::to_vec(&cached)
        .map_err(|error| format!("failed to encode audio style model evidence: {error}"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create audio style model evidence directory `{}`: {error}",
                parent.display()
            )
        })?;
    }
    let temp_path = unique_audio_style_embedding_temp_path(path);
    fs::write(&temp_path, bytes).map_err(|error| {
        format!(
            "failed to write audio style model evidence `{}`: {error}",
            temp_path.display()
        )
    })?;
    if let Err(error) = fs::remove_file(path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "failed to replace audio style model evidence `{}`: {error}",
            path.display()
        ));
    }
    fs::rename(&temp_path, path).map_err(|error| {
        format!(
            "failed to finalize audio style model evidence `{}`: {error}",
            path.display()
        )
    })
}

#[cfg(test)]
pub(crate) fn write_cached_audio_style_model_evidence_for_test(
    path: &Path,
    snapshot: &AudioStyleModelSnapshot,
) -> Result<(), String> {
    write_cached_audio_style_model_evidence(path, snapshot)
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
pub(crate) fn audio_style_model_artifact_paths(app: &AppHandle) -> Result<Vec<PathBuf>> {
    Ok(vec![
        audio_style_embedding_cache_root(app)?,
        audio_style_model_evidence_cache_path(app)?
            .parent()
            .ok_or_else(|| anyhow!("audio style model evidence path has no parent directory"))?
            .to_path_buf(),
    ])
}

#[cfg(not(test))]
fn audio_style_model_evidence_cache_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_cache_dir()
        .context("failed to resolve app cache directory")?
        .join("audio-style-model-evidence")
        .join("stable.json"))
}

#[cfg(not(test))]
struct AudioStyleTrainingTrackResolution {
    indexed_tracks: Vec<AudioStyleIndexedTrack>,
    skipped_transient_tracks: usize,
    skipped_unavailable_tracks: usize,
}

#[cfg(not(test))]
fn resolve_audio_style_training_tracks(
    musics: Vec<AudioStyleTrainingTrackInput>,
) -> AudioStyleTrainingTrackResolution {
    let mut indexed_tracks = Vec::new();
    let mut skipped_transient_tracks = 0usize;
    let mut skipped_unavailable_tracks = 0usize;
    for music in musics {
        match resolve_audio_style_training_track(music) {
            AudioStyleTrainingTrackProjection::Indexed(indexed) => indexed_tracks.push(indexed),
            AudioStyleTrainingTrackProjection::SkippedTransient => {
                skipped_transient_tracks += 1;
            }
            AudioStyleTrainingTrackProjection::SkippedUnavailable => {
                skipped_unavailable_tracks += 1;
            }
        }
    }

    AudioStyleTrainingTrackResolution {
        indexed_tracks,
        skipped_transient_tracks,
        skipped_unavailable_tracks,
    }
}

#[cfg(not(test))]
fn resolve_audio_style_training_track(
    music: AudioStyleTrainingTrackInput,
) -> AudioStyleTrainingTrackProjection {
    let file_path = PathBuf::from(music.absolute_path.trim());
    if file_path.as_os_str().is_empty() {
        return AudioStyleTrainingTrackProjection::SkippedUnavailable;
    }
    if !file_path.is_absolute() {
        return AudioStyleTrainingTrackProjection::SkippedUnavailable;
    }
    if audio_style_training_path_is_transient(&file_path) {
        return AudioStyleTrainingTrackProjection::SkippedTransient;
    }
    if !file_path.is_file() {
        return AudioStyleTrainingTrackProjection::SkippedUnavailable;
    }
    if audio_style_training_path_is_transient(&file_path) {
        return AudioStyleTrainingTrackProjection::SkippedTransient;
    }

    let track = PlaybackTrack {
        playlist_name: "__audio_style_model__".to_string(),
        music_name: music.alias.clone(),
        canonical_music_id: music.canonical_music_id.clone(),
        music_url: music.url.clone(),
        file_path: file_path.clone(),
        source_music: None,
        start_ms: music.start_ms,
        end_ms: music.end_ms,
        liked: music.liked,
        loudness_profile: music.loudness_profile,
    };
    let source = PlaylistPlaybackTrackSource {
        collection_folder: String::new(),
        music: playback_track_source_music_from_track(&track),
    };
    AudioStyleTrainingTrackProjection::Indexed(AudioStyleIndexedTrack { track, source })
}

#[cfg(not(test))]
enum AudioStyleTrainingTrackProjection {
    Indexed(AudioStyleIndexedTrack),
    SkippedTransient,
    SkippedUnavailable,
}

fn audio_style_training_path_is_transient(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| {
            name.ends_with(".part") || name.contains(".__slisic_tmp__") || name.ends_with(".tmp")
        })
}

fn playback_track_source_music_from_track(track: &PlaybackTrack) -> Music {
    Music {
        occurrence_id: String::new(),
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
        loudness_profile: track.loudness_profile,
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
        embeddings.auditory_geometry.as_ref(),
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
        embeddings.auditory_geometry.as_ref(),
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
pub(crate) fn audio_style_training_path_is_transient_for_test(path: &Path) -> bool {
    audio_style_training_path_is_transient(path)
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
        embeddings.auditory_geometry.as_ref(),
        embeddings.trained,
        recently_played_tracks,
        draw_unit,
    )
}
