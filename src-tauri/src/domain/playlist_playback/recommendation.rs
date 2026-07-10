use crate::domain::player::model::PlaybackTrack;
#[cfg(not(test))]
use crate::domain::playlist_playback::playable_index;
use crate::domain::playlists::model::AudioStyleTrainingTrackInput;
#[cfg(not(test))]
use crate::domain::playlists::model::{CollectionGroupOwner, Group, Music};
#[cfg(test)]
use crate::domain::playlists::model::{CollectionGroupOwner, Group, Music};
use crate::domain::playlists::repo::PlaylistPlaybackTrackSource;
#[cfg(not(test))]
use crate::utils::binaries::{
    ManagedBinary, acquire_managed_binary_usage, wait_for_managed_binary_foreground_release,
};
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
const AUDIO_STYLE_STABLE_MODEL_VERSION: &str = "audio-style-stable-model-v1";
pub(crate) const AUDIO_STYLE_STABLE_MODEL_DIR_NAME: &str = "audio-style-stable-model";
pub(crate) const AUDIO_STYLE_LEGACY_MODEL_EVIDENCE_DIR_NAME: &str = "audio-style-model-evidence";
const AUDIO_STYLE_TRAINING_INVALIDATION_FILE_VERSION: &str = "audio-style-training-invalidation-v1";
const AUDIO_STYLE_TRAINING_INVALIDATION_FILE_NAME: &str = "audio-style-training-invalidations.json";
const AUDIO_STYLE_PENDING_TRAINING_INPUT_FILE_VERSION: &str =
    "audio-style-pending-training-inputs-v1";
const AUDIO_STYLE_PENDING_TRAINING_INPUT_FILE_NAME: &str =
    "audio-style-pending-training-inputs.json";
pub(crate) const AUDIO_STYLE_TRAINING_INVALIDATION_ARTIFACT_FILE_NAME: &str =
    AUDIO_STYLE_TRAINING_INVALIDATION_FILE_NAME;
pub(crate) const AUDIO_STYLE_PENDING_TRAINING_INPUT_ARTIFACT_FILE_NAME: &str =
    AUDIO_STYLE_PENDING_TRAINING_INPUT_FILE_NAME;
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
const AUDIO_STYLE_BIO_ROUTE_FUTURE_WINDOW: f32 = 12.0;
const AUDIO_STYLE_BIO_ROUTE_DAMPING_STRENGTH: f32 = 0.80;
const AUDIO_STYLE_LIKED_RETAIN_WEIGHT_FLOOR: f32 = 1.0e-6;
const AUDIO_STYLE_BIO_ROUTE_TOPOLOGY_TOP_FATIGUE_STRENGTH: f32 = 0.75;
const AUDIO_STYLE_BIO_ROUTE_TOPOLOGY_TOP_FATIGUE_CAP: f32 = 1.75;
const AUDIO_STYLE_BIO_ROUTE_SOURCE_FATIGUE_STRENGTH: f32 = 1.35;
const AUDIO_STYLE_BIO_ROUTE_SOURCE_FATIGUE_FLOOR: f32 = 0.34;
const AUDIO_STYLE_SEMANTIC_CONTINUITY_FLOOR: f32 = -0.60;
const AUDIO_STYLE_SEMANTIC_CONTINUITY_STRENGTH: f32 = 2.20;
const AUDIO_STYLE_SEMANTIC_CONTINUITY_ESCAPE_RUN: usize = 3;
const AUDIO_STYLE_SEMANTIC_CONTINUITY_HISTORY_GATE: usize = 1;
const AUDIO_STYLE_SEMANTIC_CONTINUITY_FAMILIARITY_THRESHOLD: f32 = 0.55;
const AUDIO_STYLE_SEMANTIC_CONTINUITY_DISAGREEMENT_STRENGTH: f32 = 1.40;
const AUDIO_STYLE_LISTENER_ADAPTATION_DECAY: f32 = 0.82;
const AUDIO_STYLE_LISTENER_ADAPTATION_STRENGTH: f32 = 0.55;
const AUDIO_STYLE_LISTENER_OVERLOAD_STRENGTH: f32 = 2.0;
const AUDIO_STYLE_LISTENER_RECOVERY_STRENGTH: f32 = 0.75;
const AUDIO_STYLE_LISTENER_UNDERLOAD_STRENGTH: f32 = 0.35;
const AUDIO_STYLE_LISTENER_COMFORT_STRENGTH: f32 = 0.35;
const AUDIO_STYLE_LISTENER_SHOCK_STRENGTH: f32 = 0.40;
const AUDIO_STYLE_LISTENER_SHOCK_DISTANCE: f32 = 1.15;
const AUDIO_STYLE_LOCAL_DENSITY_TOP_K: usize = 10;
const AUDIO_STYLE_SELF_SUPERVISED_BASIN_GAP_WEIGHT: f32 = 0.35;
const AUDIO_STYLE_SELF_SUPERVISED_BASIN_SEPARATION_MIN: f32 = 0.55;
const AUDIO_STYLE_SELF_SUPERVISED_BASIN_SEPARATION_MAX: f32 = 0.92;
const AUDIO_STYLE_SELF_SUPERVISED_BASIN_SEPARATION_OFFSET: f32 = 0.08;
const AUDIO_STYLE_SELF_SUPERVISED_BASIN_NEAR_DUPLICATE_FLOOR: f32 = 0.985;
const AUDIO_STYLE_BASIN_FATIGUE_DECAY: f32 = 0.86;
const AUDIO_STYLE_BASIN_FATIGUE_IMPULSE: f32 = 1.0;
const AUDIO_STYLE_BASIN_FATIGUE_STRENGTH: f32 = 0.24;
const AUDIO_STYLE_BASIN_HOMEOSTATIC_DECAY: f32 = 0.93;
const AUDIO_STYLE_BASIN_HOMEOSTATIC_IMPULSE: f32 = 1.0;
const AUDIO_STYLE_BASIN_HOMEOSTATIC_STRENGTH: f32 = 1.45;
const AUDIO_STYLE_ROUTE_EVIDENCE_WARMUP_OFFSET: f32 = 3.0;
const AUDIO_STYLE_ROUTE_EVIDENCE_WARMUP_WIDTH: f32 = 18.0;
const AUDIO_STYLE_ROUTE_STREAM_MATURITY_START: f32 = 2.0;
const AUDIO_STYLE_ROUTE_STREAM_MATURITY_WIDTH: f32 = 3.0;
const AUDIO_STYLE_ROUTE_EARLY_CONTINUITY_STRENGTH: f32 = 0.58;
const AUDIO_STYLE_STREAM_CONTINUATION_STRENGTH: f32 = 1.90;
const AUDIO_STYLE_STREAM_CONTINUATION_MARGIN: f32 = 0.10;
const AUDIO_STYLE_STREAM_CONTINUATION_QUALITY_STRENGTH: f32 = 1.65;
const AUDIO_STYLE_STREAM_CONTINUATION_SUPPORT_STRENGTH: f32 = 0.75;
const AUDIO_STYLE_STREAM_CONTINUATION_SUPPORT_NEUTRAL: f32 = 0.08;
const AUDIO_STYLE_STREAM_CONTINUATION_QUALITY_FLOOR: f32 = 0.32;
const AUDIO_STYLE_STREAM_CONTINUATION_LOW_QUALITY_STRENGTH: f32 = 1.55;
const AUDIO_STYLE_STREAM_CONTINUATION_RELATIVE_LOSS_STRENGTH: f32 = 3.0;
const AUDIO_STYLE_STREAM_CONTINUATION_FATIGUE_STRENGTH: f32 = 0.52;
const AUDIO_STYLE_STREAM_CONTINUATION_OVERUSE_STRENGTH: f32 = 1.35;
const AUDIO_STYLE_STREAM_CONTINUATION_RUN_STRENGTH: f32 = 0.08;
const AUDIO_STYLE_ROUTE_ALTERNATIVE_UNDERUSE_STRENGTH: f32 = 1.25;
const AUDIO_STYLE_ROUTE_ALTERNATIVE_FATIGUE_STRENGTH: f32 = 0.24;
const AUDIO_STYLE_ROUTE_ALTERNATIVE_SWITCH_INERTIA: f32 = 0.36;
const AUDIO_STYLE_ROUTE_TRAJECTORY_STRENGTH: f32 = 0.42;
const AUDIO_STYLE_MANIFOLD_NEIGHBOR_TOP_K: usize = 24;
const AUDIO_STYLE_MANIFOLD_ESCAPE_STRENGTH: f32 = 0.92;
const AUDIO_STYLE_MANIFOLD_CONTINUITY_STRENGTH: f32 = 0.44;
const AUDIO_STYLE_MANIFOLD_RESIDENCE_RANK_SCALE: f32 = 0.55;
const AUDIO_STYLE_FUTURE_OCCUPANCY_NEIGHBOR_TOP_K: usize = 48;
const AUDIO_STYLE_FUTURE_OCCUPANCY_REACHABILITY_STRENGTH: f32 = 1.05;
const AUDIO_STYLE_FUTURE_OCCUPANCY_ENTROPY_STRENGTH: f32 = 0.48;
const AUDIO_STYLE_FUTURE_OCCUPANCY_CONTINUITY_BAND_STRENGTH: f32 = 0.34;
const AUDIO_STYLE_FUTURE_OCCUPANCY_MANIFOLD_LOAD_STRENGTH: f32 = 0.30;
const AUDIO_STYLE_FUTURE_OCCUPANCY_SAME_BASIN_RUN_STRENGTH: f32 = 0.22;
const AUDIO_STYLE_PROGRAMMATIC_DISTANCE_LOW_QUANTILE: f32 = 0.35;
const AUDIO_STYLE_PROGRAMMATIC_DISTANCE_TARGET_QUANTILE: f32 = 0.50;
const AUDIO_STYLE_PROGRAMMATIC_DISTANCE_HIGH_QUANTILE: f32 = 0.65;
const AUDIO_STYLE_PROGRAMMATIC_DISTANCE_MIN_WIDTH: f32 = 0.030;
const AUDIO_STYLE_PROGRAMMATIC_EPISODE_SHIFT_RUN: usize = 5;
const AUDIO_STYLE_PROGRAMMATIC_EPISODE_FATIGUE_SHIFT: f32 = 2.35;
const AUDIO_STYLE_PROGRAMMATIC_CONTINUE_SAME_BASIN_BONUS: f32 = 0.55;
const AUDIO_STYLE_PROGRAMMATIC_SHIFT_SAME_BASIN_PENALTY: f32 = 0.35;
const AUDIO_STYLE_PROGRAMMATIC_CONTINUE_NOVELTY_STRENGTH: f32 = 0.40;
const AUDIO_STYLE_PROGRAMMATIC_SHIFT_NOVELTY_STRENGTH: f32 = 0.75;
const AUDIO_STYLE_PROGRAMMATIC_NOVELTY_STRENGTH: f32 = 2.16;
const AUDIO_STYLE_PROGRAMMATIC_HIGH_NOVELTY_OVERLOAD_STRENGTH: f32 = 2.20;
const AUDIO_STYLE_PROGRAMMATIC_LOW_NOVELTY_STICKINESS_STRENGTH: f32 = 1.15;
const AUDIO_STYLE_PROGRAMMATIC_COVERAGE_BONUS: f32 = 0.58;
const AUDIO_STYLE_PROGRAMMATIC_MASS_DEFICIT_STRENGTH: f32 = 2.10;
const AUDIO_STYLE_PROGRAMMATIC_MASS_OVERUSE_STRENGTH: f32 = 1.70;
const AUDIO_STYLE_PROGRAMMATIC_SOURCE_MASS_DEFICIT_STRENGTH: f32 = 0.74;
const AUDIO_STYLE_PROGRAMMATIC_ROUTE_CAPACITY_WINDOW: usize = 24;
const AUDIO_STYLE_PROGRAMMATIC_ROUTE_CAPACITY_WARMUP: usize = 6;
const AUDIO_STYLE_PROGRAMMATIC_WINDOW_CAPACITY_STRENGTH: f32 = 8.0;
const AUDIO_STYLE_PROGRAMMATIC_FUTURE_REBALANCE_STRENGTH: f32 = 1.05;
const AUDIO_STYLE_PROGRAMMATIC_REMAINING_COLLAPSE_STRENGTH: f32 = 2.0;
const AUDIO_STYLE_MODEL_BASIN_SUPPORT_SINGLETON_GATE: f32 = 0.52;
const AUDIO_STYLE_MODEL_BASIN_SUPPORT_PAIR_GATE: f32 = 0.88;
const AUDIO_STYLE_BASIN_RUN_HAZARD_STRENGTH: f32 = 0.10;
// Basin pressure breaks near-distance ties, but the current track distance stays the primary axis.
const AUDIO_STYLE_BASIN_PENALTY_CAP: f32 = 2.0;
const AUDIO_STYLE_BASIN_TARGET_COUNT_SHARE_WEIGHT: f32 = 0.72;
const AUDIO_STYLE_BASIN_TARGET_ROOT_SHARE_WEIGHT: f32 = 0.28;
const AUDIO_STYLE_ROUTE_RECENT_WINDOW: usize = 48;
const AUDIO_STYLE_TYPED_CHANNEL_TERMINAL_RANGE: std::ops::Range<usize> =
    0..AUDIO_STYLE_TERMINAL_LATENT_WIDTH;
const AUDIO_STYLE_TYPED_CHANNEL_FLOW_RANGE: std::ops::Range<usize> =
    AUDIO_STYLE_TERMINAL_LATENT_WIDTH
        ..AUDIO_STYLE_TERMINAL_LATENT_WIDTH + AUDIO_STYLE_TERMINAL_BINS * 2;
const AUDIO_STYLE_TYPED_CHANNEL_TRANSITION_RANGE: std::ops::Range<usize> =
    AUDIO_STYLE_TERMINAL_LATENT_WIDTH + AUDIO_STYLE_TERMINAL_BINS * 2..AUDIO_STYLE_EMBEDDING_WIDTH;
const AUDIO_STYLE_TYPED_CHANNEL_CONSENSUS_STRENGTH: f32 = 0.34;
const AUDIO_STYLE_TYPED_CHANNEL_DISAGREEMENT_STRENGTH: f32 = 0.20;
const AUDIO_STYLE_TYPED_CHANNEL_TOPOLOGY_FLOOR: f32 = 0.18;
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
const AUDIO_STYLE_TENSOR_HARDWARE_SKIP_LOG_WINDOW_MS: u64 = 1_000;
const AUDIO_STYLE_CANDIDATE_FIELD_MIN_ACTIVE_BASINS: usize = 28;
const AUDIO_STYLE_CANDIDATE_FIELD_MIN_BASIN_CAPACITY: usize = 5;
const AUDIO_STYLE_CANDIDATE_FIELD_MAX_BASIN_CAPACITY: usize = 8;
const AUDIO_STYLE_CANDIDATE_FIELD_CAPACITY_MULTIPLIER: f32 = 2.7;
const AUDIO_STYLE_CANDIDATE_FIELD_RESERVE_FRACTION: f32 = 0.08;

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
#[cfg(not(test))]
static AUDIO_STYLE_PENDING_TRAINING_INPUTS: OnceLock<Mutex<Vec<AudioStyleTrainingTrackInput>>> =
    OnceLock::new();
static AUDIO_STYLE_HARDWARE_OP_ACTIVE: AtomicBool = AtomicBool::new(false);
static AUDIO_STYLE_HARDWARE_OP_COOLDOWN_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
static AUDIO_STYLE_HARDWARE_BUSY_SKIP_LOG_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
static AUDIO_STYLE_HARDWARE_BUSY_SKIP_SUPPRESSED: AtomicU64 = AtomicU64::new(0);
static AUDIO_STYLE_HARDWARE_COOLDOWN_SKIP_LOG_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
static AUDIO_STYLE_HARDWARE_COOLDOWN_SKIP_SUPPRESSED: AtomicU64 = AtomicU64::new(0);

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
    recent_evidence_count: usize,
    fatigue: HashMap<PlaybackAttractorBasinKey, f32>,
    usage: HashMap<PlaybackAttractorBasinKey, f32>,
    candidate_top_pressure: HashMap<PlaybackAttractorBasinKey, f32>,
    target_share: HashMap<PlaybackAttractorBasinKey, f32>,
}

#[derive(Debug, Clone)]
struct AudioStyleCandidateSupport {
    weights: Vec<f32>,
    similarities: Vec<Option<f32>>,
    diagnostics: Vec<Option<AudioStylePerceptualChannelDiagnostics>>,
}

struct AudioStyleControlGateDecision {
    gates: Vec<f32>,
    semantic_gates: Vec<f32>,
}

struct AudioStyleListeningAdaptationDecision {
    gates: Vec<f32>,
    diagnostics: Vec<Option<AudioStyleBioRouteDiagnostics>>,
    topology_health: Option<AudioStyleTopologyHealthDiagnostics>,
}

struct AudioStyleRouteFieldDecision {
    gates: Vec<f32>,
}

struct AudioStyleManifoldFieldDecision {
    stream_gates: Vec<f32>,
    route_caps: Vec<f32>,
}

struct AudioStyleFutureOccupancyReachabilityDecision {
    gates: Vec<f32>,
}

struct AudioStyleProgrammaticRouteDecision {
    gates: Vec<f32>,
    novelty_gates: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioStyleProgrammaticDistancePhase {
    Continue,
    Shift,
}

#[derive(Debug, Clone, Copy)]
struct AudioStyleProgrammaticDistanceBand {
    low: f32,
    target: f32,
    high: f32,
}

struct AudioStylePerceptualChannelDecision {
    similarities: Vec<Option<f32>>,
    diagnostics: Vec<Option<AudioStylePerceptualChannelDiagnostics>>,
}

struct AudioStyleSamplingDistribution {
    weights: Vec<f32>,
    total: f32,
}

#[derive(Debug, Clone)]
pub(crate) struct AudioStyleCandidateDiagnostics {
    pub(crate) anchor_embedded: bool,
    pub(crate) embedded_candidate_count: usize,
    pub(crate) valid_similarity_count: usize,
    pub(crate) selected_basin: Option<String>,
    pub(crate) top_candidate_basins: Vec<AudioStyleCandidateBasinDiagnostics>,
    pub(crate) bio_route: Option<AudioStyleBioRouteDiagnostics>,
    pub(crate) perceptual_channels: Option<AudioStylePerceptualChannelDiagnostics>,
    pub(crate) topology_health: Option<AudioStyleTopologyHealthDiagnostics>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AudioStyleCandidateBasinDiagnostics {
    pub(crate) basin: String,
    pub(crate) candidate_count: usize,
    pub(crate) embedded_candidate_count: usize,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct AudioStyleBioRouteDiagnostics {
    pub(crate) distance_base: f32,
    pub(crate) route_drive: f32,
    pub(crate) control_gate: f32,
    pub(crate) semantic_gate: f32,
    pub(crate) novelty: f32,
    pub(crate) novelty_gate: f32,
    pub(crate) stream_gate: f32,
    pub(crate) damping: f32,
    pub(crate) final_weight: f32,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct AudioStylePerceptualChannelDiagnostics {
    pub(crate) terminal_similarity: f32,
    pub(crate) flow_similarity: f32,
    pub(crate) transition_similarity: f32,
    pub(crate) consensus: f32,
    pub(crate) disagreement: f32,
    pub(crate) topology_gate: f32,
    pub(crate) active_challenger_axis_count: usize,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct AudioStyleTopologyHealthDiagnostics {
    pub(crate) support_width: f32,
    pub(crate) support_entropy: f32,
    pub(crate) control_entropy: f32,
    pub(crate) basin_fatigue_mass: f32,
    pub(crate) prediction_error: f32,
    pub(crate) novelty: f32,
    pub(crate) novelty_gate: f32,
    pub(crate) density_owner_best_vote_count: usize,
}

impl AudioStyleCandidateDiagnostics {
    fn with_bio_route(mut self, bio_route: Option<AudioStyleBioRouteDiagnostics>) -> Self {
        self.bio_route = bio_route;
        self
    }

    fn with_topology_health(
        mut self,
        topology_health: Option<AudioStyleTopologyHealthDiagnostics>,
    ) -> Self {
        self.topology_health = topology_health;
        self
    }

    fn with_perceptual_channels(
        mut self,
        perceptual_channels: Option<AudioStylePerceptualChannelDiagnostics>,
    ) -> Self {
        self.perceptual_channels = perceptual_channels;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleEmbedding {
    version: String,
    values: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleStableModel {
    version: String,
    embedding_version: String,
    generation: u64,
    state: CachedAudioStyleModelState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleModelState {
    embeddings: Vec<CachedAudioStyleEmbeddingEntry>,
    indexed_tracks: Vec<CachedAudioStyleIndexedTrack>,
    neighbor_index: CachedAudioStyleNeighborIndex,
    sampling_geometry: Option<CachedAudioStyleSamplingGeometry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleEmbeddingEntry {
    key: CachedPlaybackTrackKey,
    values: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleIndexedTrack {
    key: CachedPlaybackTrackKey,
    track: CachedPlaybackTrack,
    source: CachedPlaylistPlaybackTrackSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedPlaybackTrack {
    playlist_name: String,
    music_name: String,
    canonical_music_id: String,
    music_url: String,
    file_path: String,
    start_ms: u32,
    end_ms: u32,
    liked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedPlaylistPlaybackTrackSource {
    collection_folder: String,
    music: CachedMusic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedMusic {
    occurrence_id: String,
    name: String,
    alias: String,
    group: CachedGroup,
    canonical_music_id: String,
    url: String,
    path: Option<String>,
    start_ms: u32,
    end_ms: u32,
    liked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedGroup {
    name: String,
    url: String,
    collection: CachedCollectionGroupOwner,
    folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedCollectionGroupOwner {
    name: String,
    url: String,
    folder: String,
    last_updated: String,
    enable_updates: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedPlaybackTrackKey {
    music_url: String,
    file_path: String,
    start_ms: u32,
    end_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleNeighborIndex {
    neighbors: Vec<CachedAudioStyleNeighborList>,
    similarity_low: f32,
    similarity_high: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleNeighborList {
    key: CachedPlaybackTrackKey,
    neighbors: Vec<CachedPlaybackTrackKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleSamplingGeometry {
    mean: Vec<f32>,
    local_density: Vec<CachedAudioStyleLocalDensity>,
    manifold: Vec<CachedAudioStyleManifoldDescriptor>,
    self_supervised_basins: Vec<CachedAudioStyleBasinAssignment>,
    similarity_low: f32,
    similarity_high: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleLocalDensity {
    key: CachedPlaybackTrackKey,
    value: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleManifoldDescriptor {
    key: CachedPlaybackTrackKey,
    spectral_rank: f32,
    curvature: f32,
    boundary_pressure: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleBasinAssignment {
    key: CachedPlaybackTrackKey,
    basin: String,
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
    indexed_tracks: HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
    sampling_geometry: Option<AudioStyleSamplingGeometry>,
    trained: bool,
}

#[derive(Clone)]
struct AudioStyleModelState {
    embeddings: AudioStyleEmbeddingMap,
    indexed_tracks: HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
    neighbor_index: AudioStyleNeighborIndex,
    sampling_geometry: Option<AudioStyleSamplingGeometry>,
}

struct AudioStyleModelUpdateFailure {
    #[allow(dead_code)]
    state: AudioStyleModelState,
    message: String,
}

enum AudioStyleModelRefreshOutcome {
    Unchanged(AudioStyleModelSnapshot),
    Updated(AudioStyleModelSnapshot),
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
    manifold: HashMap<PlaybackTrackKey, AudioStyleManifoldDescriptor>,
    future_occupancy: HashMap<PlaybackTrackKey, AudioStyleFutureOccupancyDescriptor>,
    self_supervised_basins: HashMap<PlaybackTrackKey, PlaybackAttractorBasinKey>,
    similarity_low: f32,
    similarity_high: f32,
}

#[derive(Clone, Copy)]
struct AudioStyleManifoldDescriptor {
    spectral_rank: f32,
    curvature: f32,
    boundary_pressure: f32,
}

#[derive(Clone, Copy)]
struct AudioStyleFutureOccupancyDescriptor {
    reachability: f32,
    future_entropy: f32,
    same_basin_neighbor_share: f32,
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

impl From<&PlaybackAttractorBasinKey> for String {
    fn from(value: &PlaybackAttractorBasinKey) -> Self {
        value.value.clone()
    }
}

impl From<String> for PlaybackAttractorBasinKey {
    fn from(value: String) -> Self {
        Self { value }
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

impl From<&PlaybackTrack> for CachedPlaybackTrack {
    fn from(track: &PlaybackTrack) -> Self {
        Self {
            playlist_name: track.playlist_name.clone(),
            music_name: track.music_name.clone(),
            canonical_music_id: track.canonical_music_id.clone(),
            music_url: track.music_url.clone(),
            file_path: track.file_path.to_string_lossy().to_string(),
            start_ms: track.start_ms,
            end_ms: track.end_ms,
            liked: track.liked,
        }
    }
}

impl From<CachedPlaybackTrack> for PlaybackTrack {
    fn from(track: CachedPlaybackTrack) -> Self {
        Self {
            playlist_name: track.playlist_name,
            music_name: track.music_name,
            canonical_music_id: track.canonical_music_id,
            music_url: track.music_url,
            file_path: PathBuf::from(track.file_path),
            source_music: None,
            start_ms: track.start_ms,
            end_ms: track.end_ms,
            liked: track.liked,
            loudness_profile: None,
        }
    }
}

impl From<&PlaylistPlaybackTrackSource> for CachedPlaylistPlaybackTrackSource {
    fn from(source: &PlaylistPlaybackTrackSource) -> Self {
        Self {
            collection_folder: source.collection_folder.clone(),
            music: CachedMusic::from(&source.music),
        }
    }
}

impl From<CachedPlaylistPlaybackTrackSource> for PlaylistPlaybackTrackSource {
    fn from(source: CachedPlaylistPlaybackTrackSource) -> Self {
        Self {
            collection_folder: source.collection_folder,
            music: Music::from(source.music),
        }
    }
}

impl From<&Music> for CachedMusic {
    fn from(music: &Music) -> Self {
        Self {
            occurrence_id: music.occurrence_id.clone(),
            name: music.name.clone(),
            alias: music.alias.clone(),
            group: CachedGroup::from(&music.group),
            canonical_music_id: music.canonical_music_id.clone(),
            url: music.url.clone(),
            path: music.path.clone(),
            start_ms: music.start_ms,
            end_ms: music.end_ms,
            liked: music.liked,
        }
    }
}

impl From<CachedMusic> for Music {
    fn from(music: CachedMusic) -> Self {
        Self {
            occurrence_id: music.occurrence_id,
            name: music.name,
            alias: music.alias,
            group: Group::from(music.group),
            canonical_music_id: music.canonical_music_id,
            url: music.url,
            path: music.path,
            start_ms: music.start_ms,
            end_ms: music.end_ms,
            liked: music.liked,
            loudness_profile: None,
        }
    }
}

impl From<&Group> for CachedGroup {
    fn from(group: &Group) -> Self {
        Self {
            name: group.name.clone(),
            url: group.url.clone(),
            collection: CachedCollectionGroupOwner::from(&group.collection),
            folder: group.folder.clone(),
        }
    }
}

impl From<CachedGroup> for Group {
    fn from(group: CachedGroup) -> Self {
        Self {
            name: group.name,
            url: group.url,
            collection: CollectionGroupOwner::from(group.collection),
            folder: group.folder,
        }
    }
}

impl From<&CollectionGroupOwner> for CachedCollectionGroupOwner {
    fn from(owner: &CollectionGroupOwner) -> Self {
        Self {
            name: owner.name.clone(),
            url: owner.url.clone(),
            folder: owner.folder.clone(),
            last_updated: owner.last_updated.clone(),
            enable_updates: owner.enable_updates,
        }
    }
}

impl From<CachedCollectionGroupOwner> for CollectionGroupOwner {
    fn from(owner: CachedCollectionGroupOwner) -> Self {
        Self {
            name: owner.name,
            url: owner.url,
            folder: owner.folder,
            last_updated: owner.last_updated,
            enable_updates: owner.enable_updates,
        }
    }
}

impl From<&AudioStyleModelState> for CachedAudioStyleModelState {
    fn from(state: &AudioStyleModelState) -> Self {
        Self {
            embeddings: sorted_audio_style_embedding_keys(&state.embeddings)
                .into_iter()
                .filter_map(|key| {
                    state
                        .embeddings
                        .get(&key)
                        .map(|embedding| CachedAudioStyleEmbeddingEntry {
                            key: CachedPlaybackTrackKey::from(&key),
                            values: embedding.values.clone(),
                        })
                })
                .collect(),
            indexed_tracks: sorted_audio_style_indexed_track_keys(&state.indexed_tracks)
                .into_iter()
                .filter_map(|key| {
                    state
                        .indexed_tracks
                        .get(&key)
                        .map(|indexed| CachedAudioStyleIndexedTrack {
                            key: CachedPlaybackTrackKey::from(&key),
                            track: CachedPlaybackTrack::from(&indexed.track),
                            source: CachedPlaylistPlaybackTrackSource::from(&indexed.source),
                        })
                })
                .collect(),
            neighbor_index: CachedAudioStyleNeighborIndex::from(&state.neighbor_index),
            sampling_geometry: state
                .sampling_geometry
                .as_ref()
                .map(CachedAudioStyleSamplingGeometry::from),
        }
    }
}

impl TryFrom<CachedAudioStyleModelState> for AudioStyleModelState {
    type Error = String;

    fn try_from(cached: CachedAudioStyleModelState) -> Result<Self, Self::Error> {
        let mut embeddings = AudioStyleEmbeddingMap::new();
        for cached_embedding in cached.embeddings {
            let key = PlaybackTrackKey::from(cached_embedding.key);
            let embedding =
                AudioStyleEmbedding::normalize(cached_embedding.values).ok_or_else(|| {
                    "stable model contains an embedding with invalid width".to_string()
                })?;
            embeddings.insert(key, Arc::new(embedding));
        }
        if embeddings.is_empty() {
            return Err("stable model has no embeddings".to_string());
        }

        let mut indexed_tracks = HashMap::new();
        for cached_indexed in cached.indexed_tracks {
            let key = PlaybackTrackKey::from(cached_indexed.key);
            if !embeddings.contains_key(&key) {
                return Err("stable model indexed track is missing an embedding".to_string());
            }
            indexed_tracks.insert(
                key,
                AudioStyleIndexedTrack {
                    track: PlaybackTrack::from(cached_indexed.track),
                    source: PlaylistPlaybackTrackSource::from(cached_indexed.source),
                },
            );
        }
        if indexed_tracks.len() != embeddings.len() {
            return Err(
                "stable model does not cover every embedding with indexed track metadata"
                    .to_string(),
            );
        }

        let neighbor_index = AudioStyleNeighborIndex::try_from(cached.neighbor_index, &embeddings)?;
        let sampling_geometry = cached
            .sampling_geometry
            .map(|geometry| {
                AudioStyleSamplingGeometry::try_from(geometry, &embeddings, &neighbor_index)
            })
            .transpose()?;
        Ok(Self {
            embeddings,
            indexed_tracks,
            neighbor_index,
            sampling_geometry,
        })
    }
}

impl From<&AudioStyleNeighborIndex> for CachedAudioStyleNeighborIndex {
    fn from(index: &AudioStyleNeighborIndex) -> Self {
        Self {
            neighbors: sorted_audio_style_neighbor_keys(&index.neighbors)
                .into_iter()
                .filter_map(|key| {
                    index
                        .neighbors
                        .get(&key)
                        .map(|neighbors| CachedAudioStyleNeighborList {
                            key: CachedPlaybackTrackKey::from(&key),
                            neighbors: neighbors.iter().map(CachedPlaybackTrackKey::from).collect(),
                        })
                })
                .collect(),
            similarity_low: index.similarity_low,
            similarity_high: index.similarity_high,
        }
    }
}

impl AudioStyleNeighborIndex {
    fn try_from(
        cached: CachedAudioStyleNeighborIndex,
        embeddings: &AudioStyleEmbeddingMap,
    ) -> Result<Self, String> {
        let mut neighbors = HashMap::new();
        for cached_neighbors in cached.neighbors {
            let key = PlaybackTrackKey::from(cached_neighbors.key);
            if !embeddings.contains_key(&key) {
                return Err("stable model neighbor key is missing an embedding".to_string());
            }
            let mut neighbor_keys = Vec::new();
            for cached_neighbor in cached_neighbors.neighbors {
                let neighbor = PlaybackTrackKey::from(cached_neighbor);
                if !embeddings.contains_key(&neighbor) {
                    return Err("stable model neighbor points to a missing embedding".to_string());
                }
                neighbor_keys.push(neighbor);
            }
            neighbors.insert(key, neighbor_keys);
        }
        if neighbors.len() != embeddings.len() && embeddings.len() >= 2 {
            return Err("stable model neighbor index does not cover every embedding".to_string());
        }
        Ok(Self {
            neighbors,
            similarity_low: cached.similarity_low,
            similarity_high: cached.similarity_high,
        })
    }
}

impl From<&AudioStyleSamplingGeometry> for CachedAudioStyleSamplingGeometry {
    fn from(geometry: &AudioStyleSamplingGeometry) -> Self {
        Self {
            mean: geometry.mean.clone(),
            local_density: sorted_audio_style_local_density_keys(&geometry.local_density)
                .into_iter()
                .filter_map(|key| {
                    geometry
                        .local_density
                        .get(&key)
                        .map(|value| CachedAudioStyleLocalDensity {
                            key: CachedPlaybackTrackKey::from(&key),
                            value: *value,
                        })
                })
                .collect(),
            manifold: sorted_audio_style_manifold_keys(&geometry.manifold)
                .into_iter()
                .filter_map(|key| {
                    geometry
                        .manifold
                        .get(&key)
                        .map(|value| CachedAudioStyleManifoldDescriptor {
                            key: CachedPlaybackTrackKey::from(&key),
                            spectral_rank: value.spectral_rank,
                            curvature: value.curvature,
                            boundary_pressure: value.boundary_pressure,
                        })
                })
                .collect(),
            self_supervised_basins: sorted_audio_style_basin_assignment_keys(
                &geometry.self_supervised_basins,
            )
            .into_iter()
            .filter_map(|key| {
                geometry.self_supervised_basins.get(&key).map(|basin| {
                    CachedAudioStyleBasinAssignment {
                        key: CachedPlaybackTrackKey::from(&key),
                        basin: String::from(basin),
                    }
                })
            })
            .collect(),
            similarity_low: geometry.similarity_low,
            similarity_high: geometry.similarity_high,
        }
    }
}

impl AudioStyleSamplingGeometry {
    fn try_from(
        cached: CachedAudioStyleSamplingGeometry,
        embeddings: &AudioStyleEmbeddingMap,
        neighbor_index: &AudioStyleNeighborIndex,
    ) -> Result<Self, String> {
        if cached.mean.len() != AUDIO_STYLE_EMBEDDING_WIDTH {
            return Err("stable model sampling geometry has invalid mean width".to_string());
        }
        let mut local_density = HashMap::new();
        for cached_density in cached.local_density {
            let key = PlaybackTrackKey::from(cached_density.key);
            if !embeddings.contains_key(&key) {
                return Err("stable model local density key is missing an embedding".to_string());
            }
            local_density.insert(key, cached_density.value);
        }
        let mut manifold = HashMap::new();
        for cached_descriptor in cached.manifold {
            let key = PlaybackTrackKey::from(cached_descriptor.key);
            if !embeddings.contains_key(&key) {
                return Err("stable model manifold key is missing an embedding".to_string());
            }
            manifold.insert(
                key,
                AudioStyleManifoldDescriptor {
                    spectral_rank: cached_descriptor.spectral_rank,
                    curvature: cached_descriptor.curvature,
                    boundary_pressure: cached_descriptor.boundary_pressure,
                },
            );
        }
        let mut self_supervised_basins = HashMap::new();
        for cached_basin in cached.self_supervised_basins {
            let key = PlaybackTrackKey::from(cached_basin.key);
            if !embeddings.contains_key(&key) {
                return Err("stable model basin key is missing an embedding".to_string());
            }
            self_supervised_basins.insert(key, PlaybackAttractorBasinKey::from(cached_basin.basin));
        }
        if local_density.len() != embeddings.len() {
            return Err("stable model local density does not cover every embedding".to_string());
        }
        if manifold.len() != embeddings.len() {
            return Err(
                "stable model manifold descriptors do not cover every embedding".to_string(),
            );
        }
        if self_supervised_basins.len() != embeddings.len() {
            return Err("stable model basin assignments do not cover every embedding".to_string());
        }
        let future_occupancy = audio_style_future_occupancy_descriptors_from_neighbors(
            neighbor_index,
            &self_supervised_basins,
            &manifold,
        );
        if future_occupancy.len() != embeddings.len() && embeddings.len() >= 2 {
            return Err(
                "stable model future occupancy descriptors do not cover every embedding"
                    .to_string(),
            );
        }
        Ok(Self {
            mean: cached.mean,
            local_density,
            manifold,
            future_occupancy,
            self_supervised_basins,
            similarity_low: cached.similarity_low,
            similarity_high: cached.similarity_high,
        })
    }
}

#[cfg(not(test))]
struct AudioStyleRecommendationRuntime {
    app: AppHandle,
    stable_snapshot: RwLock<Option<Arc<AudioStyleModelSnapshot>>>,
    completed_snapshots: RwLock<Vec<Arc<AudioStyleModelSnapshot>>>,
    training: Mutex<AudioStyleTrainingState>,
    training_invalidation_path: Option<PathBuf>,
    pending_training_input_path: Option<PathBuf>,
    training_invalidation_file_lock: Mutex<()>,
    pending_training_input_file_lock: Mutex<()>,
    next_generation: AtomicU64,
    next_training_run_id: AtomicU64,
}

#[cfg(not(test))]
#[derive(Debug, Default)]
struct AudioStyleTrainingState {
    running: bool,
    rerun_requested: bool,
    rerun_request_count: u64,
    rerun_reason: Option<&'static str>,
    debounce_pending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioStyleStartupTrainingDecision {
    SkipRestoredStableModel,
    SkipNoTrainingInputs,
    TrainPendingInputChanges,
}

impl AudioStyleStartupTrainingDecision {
    fn as_str(self) -> &'static str {
        match self {
            Self::SkipRestoredStableModel => "skip_restored_stable_model",
            Self::SkipNoTrainingInputs => "skip_no_training_inputs",
            Self::TrainPendingInputChanges => "train_pending_input_changes",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioStyleStartupInputCoverage {
    Covered,
    Changed,
    Empty,
    Unavailable,
}

impl AudioStyleStartupInputCoverage {
    fn as_str(self) -> &'static str {
        match self {
            Self::Covered => "covered",
            Self::Changed => "changed",
            Self::Empty => "empty",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub(crate) struct AudioStyleMusicInputIdentity {
    pub(crate) canonical_music_id: String,
    pub(crate) music_url: String,
    pub(crate) path: Option<String>,
    pub(crate) start_ms: u32,
    pub(crate) end_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct AudioStyleTrainingInvalidationRecord {
    pub(crate) reason: String,
    pub(crate) created_at_ms: u64,
    pub(crate) music: Option<AudioStyleMusicInputIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AudioStyleTrainingInvalidationFile {
    version: String,
    records: Vec<AudioStyleTrainingInvalidationRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AudioStylePendingTrainingInputFile {
    version: String,
    inputs: Vec<AudioStyleTrainingTrackInput>,
}

#[derive(Debug, Clone)]
struct AudioStyleConsumedTrainingInputs {
    inputs: Vec<AudioStyleTrainingTrackInput>,
}

#[cfg(not(test))]
impl AudioStyleRecommendationRuntime {
    fn request_training(self: &Arc<Self>, reason: &'static str) {
        let should_spawn = match self.training.lock() {
            Ok(mut training) => {
                if training.running {
                    training.rerun_requested = true;
                    training.rerun_request_count = training.rerun_request_count.saturating_add(1);
                    training.rerun_reason = Some(reason);
                    log::info!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_training_request_coalesced reason={reason} running=true rerun_requested=true pending_rerun_requests={}",
                        training.rerun_request_count
                    );
                    false
                } else {
                    training.running = true;
                    training.rerun_requested = false;
                    training.rerun_request_count = 0;
                    training.rerun_reason = None;
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

            let rerun = match self.training.lock() {
                Ok(mut training) => {
                    if training.rerun_requested {
                        let pending_requests = training.rerun_request_count;
                        let next_reason = training.rerun_reason.unwrap_or("coalesced_update");
                        training.rerun_requested = false;
                        training.rerun_request_count = 0;
                        training.rerun_reason = None;
                        Some((next_reason, pending_requests))
                    } else {
                        training.running = false;
                        None
                    }
                }
                Err(_) => {
                    log::error!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_training_state_error run_id={run_id} reason={reason} error=\"lock_poisoned\""
                    );
                    None
                }
            };

            let Some((next_reason, pending_requests)) = rerun else {
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_training_idle run_id={run_id} reason={reason}"
                );
                return;
            };
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_rerun_coalescing run_id={run_id} previous_reason={reason} next_reason={next_reason} pending_requests={pending_requests} quiet_ms=0"
            );
            reason = next_reason;
        }
    }

    async fn train_and_publish(self: &Arc<Self>, reason: &'static str) -> Result<()> {
        let started = Instant::now();
        let musics_started = Instant::now();
        let consumed_inputs = self.take_pending_training_inputs(reason);
        let music_count = consumed_inputs.inputs.len();
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_music_inputs_loaded reason={reason} source=pending_records trainable_music={music_count} elapsed_ms={}",
            musics_started.elapsed().as_millis()
        );
        let resolve_started = Instant::now();
        let resolved = resolve_audio_style_training_tracks(consumed_inputs.inputs.clone());
        let indexed_tracks = merge_audio_style_indexed_tracks(
            self.stable_snapshot().as_deref(),
            resolved.indexed_tracks,
        );
        let indexed_track_count = indexed_tracks.len();
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_inputs_ready reason={reason} indexed_tracks={indexed_track_count} skipped_transient_tracks={} skipped_unavailable_tracks={} elapsed_ms={}",
            resolved.skipped_transient_tracks,
            resolved.skipped_unavailable_tracks,
            resolve_started.elapsed().as_millis()
        );
        if audio_style_training_input_readiness(indexed_track_count)
            == AudioStyleTrainingInputReadiness::NoIndexableTracks
        {
            self.clear_stable_snapshot_for_empty_inputs(reason);
            self.clear_training_invalidations_after_success(reason);
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_snapshot_skipped reason={reason} indexed_tracks=0 elapsed_ms={} reason_detail=\"no_indexable_tracks\"",
                started.elapsed().as_millis()
            );
            return Ok(());
        }

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

        let previous_snapshot = self.stable_snapshot();
        let generation_runtime = Arc::clone(self);
        let build_started = Instant::now();
        let refresh_outcome = tauri::async_runtime::spawn_blocking(move || {
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
        let final_snapshot = match refresh_outcome {
            AudioStyleModelRefreshOutcome::Unchanged(snapshot) => {
                let covered_inputs = audio_style_training_inputs_covered_by_snapshot(
                    &consumed_inputs.inputs,
                    &snapshot,
                );
                self.acknowledge_pending_training_inputs_after_success(reason, &covered_inputs);
                self.clear_training_invalidations_after_success(reason);
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_training_snapshot_skipped reason={reason} indexed_tracks={} elapsed_ms={} reason_detail=\"inputs_unchanged\"",
                    snapshot.state.indexed_tracks.len(),
                    build_started.elapsed().as_millis()
                );
                return Ok(());
            }
            AudioStyleModelRefreshOutcome::Updated(snapshot) => snapshot,
        };
        let covered_inputs = audio_style_training_inputs_covered_by_snapshot(
            &consumed_inputs.inputs,
            &final_snapshot,
        );
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_snapshot_built reason={reason} generation={} elapsed_ms={}",
            final_snapshot.generation(),
            build_started.elapsed().as_millis()
        );
        if self.publish_stable_snapshot(final_snapshot) {
            self.acknowledge_pending_training_inputs_after_success(reason, &covered_inputs);
            self.clear_training_invalidations_after_success(reason);
        }
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_publish_complete reason={reason} elapsed_ms={}",
            started.elapsed().as_millis()
        );

        Ok(())
    }

    fn take_pending_training_inputs(
        &self,
        reason: &'static str,
    ) -> AudioStyleConsumedTrainingInputs {
        let mut inputs = Vec::new();
        if let Some(pending) = AUDIO_STYLE_PENDING_TRAINING_INPUTS.get() {
            match pending.lock() {
                Ok(pending) => {
                    inputs.extend(pending.iter().cloned());
                }
                Err(_) => {
                    log::error!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_training_inputs_consume_failed reason={reason} source=memory error=\"lock_poisoned\""
                    );
                }
            }
        }
        inputs.extend(self.take_persisted_pending_training_inputs(reason));
        let inputs = deduplicate_audio_style_training_inputs(inputs);
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_inputs_consumed reason={reason} count={}",
            inputs.len()
        );
        AudioStyleConsumedTrainingInputs { inputs }
    }

    fn take_persisted_pending_training_inputs(
        &self,
        reason: &'static str,
    ) -> Vec<AudioStyleTrainingTrackInput> {
        let Some(path) = self.pending_training_input_path.as_ref() else {
            return Vec::new();
        };
        let Ok(_guard) = self.pending_training_input_file_lock.lock() else {
            log::error!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_pending_training_inputs_consume_failed reason={reason} error=\"lock_poisoned\""
            );
            return Vec::new();
        };
        match read_audio_style_pending_training_input_file(path) {
            Ok(inputs) => inputs,
            Err(error) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_pending_training_inputs_consume_failed reason={reason} error=\"{}\"",
                    escape_log_value(&error.to_string())
                );
                Vec::new()
            }
        }
    }

    fn acknowledge_pending_training_inputs_after_success(
        &self,
        reason: &'static str,
        consumed_inputs: &[AudioStyleTrainingTrackInput],
    ) {
        if consumed_inputs.is_empty() {
            return;
        }
        let consumed_records = audio_style_training_input_record_map(consumed_inputs);
        if let Some(pending) = AUDIO_STYLE_PENDING_TRAINING_INPUTS.get() {
            match pending.lock() {
                Ok(mut pending) => {
                    let before = pending.len();
                    pending.retain(|input| {
                        !audio_style_training_input_matches_consumed(input, &consumed_records)
                    });
                    let removed = before.saturating_sub(pending.len());
                    if removed > 0 {
                        log::info!(
                            target: AUDIO_STYLE_LOG_TARGET,
                            "audio_style_pending_training_inputs_memory_acknowledged reason={reason} count={removed} remaining={}",
                            pending.len()
                        );
                    }
                }
                Err(_) => {
                    log::error!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_pending_training_inputs_memory_ack_failed reason={reason} error=\"lock_poisoned\""
                    );
                }
            }
        }
        let Some(path) = self.pending_training_input_path.as_ref() else {
            return;
        };
        let Ok(_guard) = self.pending_training_input_file_lock.lock() else {
            log::error!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_pending_training_inputs_ack_failed reason={reason} error=\"lock_poisoned\""
            );
            return;
        };
        match acknowledge_audio_style_pending_training_input_file(path, &consumed_records) {
            Ok((removed, remaining)) => {
                if removed > 0 {
                    log::info!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_pending_training_inputs_acknowledged reason={reason} count={removed} remaining={remaining}"
                    );
                }
            }
            Err(error) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_pending_training_inputs_ack_failed reason={reason} error=\"{}\"",
                    escape_log_value(&error.to_string())
                );
            }
        }
    }

    fn persist_pending_training_inputs(
        &self,
        reason: &'static str,
        inputs: &[AudioStyleTrainingTrackInput],
    ) {
        let Some(path) = self.pending_training_input_path.as_ref() else {
            return;
        };
        let Ok(_guard) = self.pending_training_input_file_lock.lock() else {
            log::error!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_pending_training_inputs_record_failed reason={reason} error=\"lock_poisoned\""
            );
            return;
        };
        match upsert_audio_style_pending_training_input_file(path, inputs) {
            Ok(count) => {
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_pending_training_inputs_recorded reason={reason} added={} pending={count}",
                    inputs.len()
                );
            }
            Err(error) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_pending_training_inputs_record_failed reason={reason} error=\"{}\"",
                    escape_log_value(&error.to_string())
                );
            }
        }
    }

    fn snapshot_memory_pending_training_inputs(
        &self,
        reason: &'static str,
    ) -> Vec<AudioStyleTrainingTrackInput> {
        match AUDIO_STYLE_PENDING_TRAINING_INPUTS
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
        {
            Ok(pending) => deduplicate_audio_style_training_inputs(pending.clone()),
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_pending_training_inputs_memory_persist_failed reason={reason} error=\"memory_lock_poisoned\""
                );
                Vec::new()
            }
        }
    }

    fn persist_memory_pending_training_inputs(&self, reason: &'static str) {
        let inputs = self.snapshot_memory_pending_training_inputs(reason);
        if inputs.is_empty() {
            return;
        }
        self.persist_pending_training_inputs(reason, &inputs);
    }

    fn restore_persisted_pending_training_inputs_to_memory(&self) -> usize {
        self.persist_memory_pending_training_inputs("startup_restore_memory_pending");
        let Some(path) = self.pending_training_input_path.as_ref() else {
            return 0;
        };
        let Ok(_guard) = self.pending_training_input_file_lock.lock() else {
            log::error!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_pending_training_inputs_restore_failed error=\"lock_poisoned\""
            );
            return 0;
        };
        let inputs = match read_audio_style_pending_training_input_file(path) {
            Ok(inputs) => inputs,
            Err(error) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_pending_training_inputs_restore_failed error=\"{}\"",
                    escape_log_value(&error.to_string())
                );
                return 0;
            }
        };
        let count = inputs.len();
        if count == 0 {
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_pending_training_inputs_restored count=0"
            );
            return 0;
        }
        match AUDIO_STYLE_PENDING_TRAINING_INPUTS
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
        {
            Ok(mut pending) => {
                pending.extend(inputs);
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_pending_training_inputs_restored count={count} memory_pending={}",
                    pending.len()
                );
            }
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_pending_training_inputs_restore_failed error=\"memory_lock_poisoned\""
                );
                return 0;
            }
        }
        count
    }

    fn clear_training_invalidations_after_success(&self, reason: &'static str) {
        let Some(path) = self.training_invalidation_path.as_ref() else {
            return;
        };
        let Ok(_guard) = self.training_invalidation_file_lock.lock() else {
            log::error!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_invalidations_clear_failed reason={reason} error=\"lock_poisoned\""
            );
            return;
        };
        match clear_audio_style_training_invalidation_file(path) {
            Ok(removed_count) if removed_count > 0 => {
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_training_invalidations_cleared reason={reason} count={removed_count}"
                );
            }
            Ok(_) => {}
            Err(error) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_training_invalidations_clear_failed reason={reason} error=\"{}\"",
                    escape_log_value(&error.to_string())
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

    fn publish_stable_snapshot(&self, snapshot: AudioStyleModelSnapshot) -> bool {
        let snapshot = Arc::new(snapshot);
        let generation = snapshot.generation();
        match self.stable_snapshot.write() {
            Ok(mut stable) => {
                let stable_existed = stable.is_some();
                if !should_replace_stable_snapshot(stable.as_deref(), snapshot.as_ref()) {
                    return false;
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
                if let Ok(stable_model_path) = audio_style_stable_model_path(&self.app)
                    && let Err(error) =
                        write_audio_style_stable_model(&stable_model_path, snapshot.as_ref())
                {
                    log::warn!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_stable_model_write_failed generation={generation} error=\"{}\"",
                        escape_log_value(&error)
                    );
                }
            }
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_snapshot_publish_failed stage=stable reason=training_complete generation={generation} error=\"lock_poisoned\""
                );
                return false;
            }
        }

        self.remember_completed_snapshot(snapshot);
        true
    }

    fn clear_stable_snapshot_for_empty_inputs(&self, reason: &'static str) {
        let stable_existed = match self.stable_snapshot.write() {
            Ok(mut stable) => stable.take().is_some(),
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_snapshot_clear_failed reason={reason} error=\"lock_poisoned\""
                );
                false
            }
        };
        match self.completed_snapshots.write() {
            Ok(mut completed) => completed.clear(),
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_completed_snapshot_clear_failed reason={reason} error=\"lock_poisoned\""
                );
            }
        }
        if let Ok(stable_model_path) = audio_style_stable_model_path(&self.app)
            && let Err(error) = fs::remove_file(&stable_model_path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            log::warn!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_stable_model_clear_failed reason={reason} error=\"{}\"",
                escape_log_value(&error.to_string())
            );
        }
        if stable_existed {
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_snapshot_cleared reason={reason} cause=no_indexable_tracks"
            );
            playable_index::request_audio_style_model_available_refresh();
        }
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

    fn persist_training_invalidation(
        &self,
        reason: &'static str,
        music: Option<AudioStyleMusicInputIdentity>,
    ) {
        let Some(path) = self.training_invalidation_path.as_ref() else {
            return;
        };
        let Ok(_guard) = self.training_invalidation_file_lock.lock() else {
            log::error!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_invalidation_record_failed reason={reason} error=\"lock_poisoned\""
            );
            return;
        };
        let record = AudioStyleTrainingInvalidationRecord {
            reason: reason.to_owned(),
            created_at_ms: current_time_millis(),
            music,
        };
        match upsert_audio_style_training_invalidation_file(path, record) {
            Ok(count) => {
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_training_invalidation_recorded reason={reason} pending={count}"
                );
            }
            Err(error) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_training_invalidation_record_failed reason={reason} error=\"{}\"",
                    escape_log_value(&error.to_string())
                );
            }
        }
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
            training_invalidation_path: match audio_style_training_invalidation_path(&app) {
                Ok(path) => Some(path),
                Err(error) => {
                    log::warn!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_training_invalidation_store_unavailable error=\"{}\"",
                        escape_log_value(&error.to_string())
                    );
                    None
                }
            },
            pending_training_input_path: match audio_style_pending_training_input_path(&app) {
                Ok(path) => Some(path),
                Err(error) => {
                    log::warn!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_pending_training_input_store_unavailable error=\"{}\"",
                        escape_log_value(&error.to_string())
                    );
                    None
                }
            },
            training_invalidation_file_lock: Mutex::new(()),
            pending_training_input_file_lock: Mutex::new(()),
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
    restored_stable_model: bool,
    pending_input_changes: u64,
    restored_pending_training_inputs: usize,
    persisted_invalidations: u64,
    input_coverage: AudioStyleStartupInputCoverage,
) {
    let decision = audio_style_startup_training_decision(
        restored_stable_model,
        pending_input_changes,
        restored_pending_training_inputs,
        persisted_invalidations,
        input_coverage,
    );
    log::info!(
        target: AUDIO_STYLE_LOG_TARGET,
        "audio_style_training_startup_decision restored_stable_model={restored_stable_model} pending_input_changes={pending_input_changes} restored_pending_training_inputs={restored_pending_training_inputs} persisted_invalidations={persisted_invalidations} input_coverage={} decision={}",
        input_coverage.as_str(),
        decision.as_str()
    );
    match decision {
        AudioStyleStartupTrainingDecision::SkipRestoredStableModel => {
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_startup_skipped reason=restored_stable_model"
            );
        }
        AudioStyleStartupTrainingDecision::SkipNoTrainingInputs => {
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_startup_skipped reason=no_training_inputs"
            );
        }
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges => {
            runtime.request_training("startup_pending_input_changes")
        }
    }
}

#[cfg(not(test))]
pub(crate) fn notify_audio_style_library_inputs_changed(reason: &'static str) {
    notify_audio_style_library_inputs_invalidated(reason, None);
}

#[cfg(not(test))]
pub(crate) fn notify_audio_style_music_input_changed(reason: &'static str, music: &Music) {
    notify_audio_style_library_inputs_invalidated(
        reason,
        Some(AudioStyleMusicInputIdentity::from(music)),
    );
}

#[cfg(not(test))]
pub(crate) fn notify_audio_style_training_inputs_ready(
    reason: &'static str,
    inputs: Vec<AudioStyleTrainingTrackInput>,
) {
    if inputs.is_empty() {
        return;
    }
    let input_count = inputs.len();
    match AUDIO_STYLE_PENDING_TRAINING_INPUTS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
    {
        Ok(mut pending) => {
            pending.extend(inputs);
            log::info!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_inputs_recorded reason={reason} added={input_count} pending={}",
                pending.len()
            );
        }
        Err(_) => {
            log::error!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_inputs_record_failed reason={reason} added={input_count} error=\"lock_poisoned\""
            );
            return;
        }
    }
    if let Some(runtime) = AUDIO_STYLE_RECOMMENDATION_RUNTIME.get() {
        runtime.persist_pending_training_inputs(
            reason,
            &runtime.snapshot_memory_pending_training_inputs(reason),
        );
    }
    notify_audio_style_library_inputs_invalidated(reason, None);
}

#[cfg(not(test))]
fn notify_audio_style_library_inputs_invalidated(
    reason: &'static str,
    music: Option<AudioStyleMusicInputIdentity>,
) {
    let Some(runtime) = AUDIO_STYLE_RECOMMENDATION_RUNTIME.get() else {
        let pending_changes = AUDIO_STYLE_PENDING_INPUT_CHANGES.fetch_add(1, Ordering::SeqCst) + 1;
        log::warn!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_request_queued_before_runtime reason={reason} pending={pending_changes}"
        );
        return;
    };

    runtime.persist_training_invalidation(reason, music);
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
            let restored_stable_model = runtime.restore_stable_model_on_startup().await;
            let restored_pending_training_inputs =
                runtime.restore_persisted_pending_training_inputs_to_memory();
            let input_coverage =
                runtime.startup_pending_record_coverage(restored_stable_model.as_ref());
            let persisted_invalidations = runtime.restored_training_invalidation_count();
            apply_audio_style_startup_training_decision(
                &runtime,
                restored_stable_model.is_some(),
                pending_input_changes,
                restored_pending_training_inputs,
                persisted_invalidations,
                input_coverage,
            );
        });
    }

    fn restored_training_invalidation_count(&self) -> u64 {
        let Some(path) = self.training_invalidation_path.as_ref() else {
            return 0;
        };
        let Ok(_guard) = self.training_invalidation_file_lock.lock() else {
            log::error!(
                target: AUDIO_STYLE_LOG_TARGET,
                "audio_style_training_invalidations_restore_failed error=\"lock_poisoned\""
            );
            return 0;
        };
        match read_audio_style_training_invalidation_file(path) {
            Ok(records) => {
                let count = records.len() as u64;
                if count > 0 {
                    log::info!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_training_invalidations_restored count={count}"
                    );
                }
                count
            }
            Err(error) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_training_invalidations_restore_failed error=\"{}\"",
                    escape_log_value(&error.to_string())
                );
                0
            }
        }
    }

    async fn restore_stable_model_on_startup(
        self: &Arc<Self>,
    ) -> Option<Arc<AudioStyleModelSnapshot>> {
        let started = Instant::now();
        let stable_model_path = match audio_style_stable_model_path(&self.app) {
            Ok(stable_model_path) => stable_model_path,
            Err(error) => {
                log::warn!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_stable_model_restore_skipped reason=startup error=\"{}\"",
                    escape_log_value(&error.to_string())
                );
                return None;
            }
        };
        let restore_result = tauri::async_runtime::spawn_blocking(move || {
            read_audio_style_stable_model(&stable_model_path)
        })
        .await;
        let snapshot = match restore_result {
            Ok(Ok(snapshot)) => snapshot,
            Ok(Err(error)) => {
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_stable_model_restore_miss reason=startup elapsed_ms={} error=\"{}\"",
                    started.elapsed().as_millis(),
                    escape_log_value(&error)
                );
                return None;
            }
            Err(error) => {
                log::warn!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_stable_model_restore_task_failed reason=startup elapsed_ms={} error=\"{}\"",
                    started.elapsed().as_millis(),
                    escape_log_value(&error.to_string())
                );
                return None;
            }
        };
        let generation = snapshot.generation();
        self.next_generation.fetch_max(generation, Ordering::SeqCst);
        let snapshot = self.publish_restored_stable_model(snapshot);
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_stable_model_restored reason=startup generation={generation} elapsed_ms={}",
            started.elapsed().as_millis()
        );
        Some(snapshot)
    }

    fn startup_pending_record_coverage(
        &self,
        restored_stable_model: Option<&Arc<AudioStyleModelSnapshot>>,
    ) -> AudioStyleStartupInputCoverage {
        let pending_records = AUDIO_STYLE_PENDING_TRAINING_INPUTS
            .get()
            .and_then(|pending| pending.lock().ok().map(|pending| pending.len()))
            .unwrap_or(0);
        let coverage = if pending_records > 0 {
            AudioStyleStartupInputCoverage::Changed
        } else if restored_stable_model.is_some() {
            AudioStyleStartupInputCoverage::Covered
        } else {
            AudioStyleStartupInputCoverage::Unavailable
        };
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_training_startup_input_coverage status={} source=pending_records pending_records={pending_records}",
            coverage.as_str()
        );
        coverage
    }

    fn publish_restored_stable_model(
        &self,
        snapshot: AudioStyleModelSnapshot,
    ) -> Arc<AudioStyleModelSnapshot> {
        let snapshot = Arc::new(snapshot);
        let generation = snapshot.generation();
        match self.stable_snapshot.write() {
            Ok(mut stable) => {
                let stable_existed = stable.is_some();
                if !should_replace_stable_snapshot(stable.as_deref(), snapshot.as_ref()) {
                    return snapshot;
                }
                *stable = Some(Arc::clone(&snapshot));
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_snapshot_published stage=stable reason=startup_stable_model generation={generation}"
                );
                if stable_snapshot_publication_requests_first_slot_refresh(
                    StableSnapshotPublicationReason::StartupStableModel,
                    stable_existed,
                ) {
                    playable_index::request_audio_style_model_available_refresh();
                }
            }
            Err(_) => {
                log::error!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_snapshot_publish_failed stage=stable reason=startup_stable_model generation={generation} error=\"lock_poisoned\""
                );
                return snapshot;
            }
        }

        self.remember_completed_snapshot(Arc::clone(&snapshot));
        snapshot
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
        for key in sorted_audio_style_embedding_keys(embeddings) {
            let Some(embedding) = embeddings.get(&key) else {
                continue;
            };
            if embedding.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH {
                continue;
            }
            keys.push(key);
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

    fn softmin_weights(
        &self,
        _liked_flags: &[bool],
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
            liked_values.push(0.0);
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
        let mut devices = selected_audio_style_wgpu_hardware_device_from_candidates(&candidates)
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
        let cooldown_until = AUDIO_STYLE_HARDWARE_OP_COOLDOWN_UNTIL_MS.load(Ordering::SeqCst);
        if now_ms < cooldown_until {
            log_audio_style_hardware_op_skip_throttled(
                operation,
                "cooldown",
                Some(cooldown_until.saturating_sub(now_ms)),
            );
            return None;
        }

        if AUDIO_STYLE_HARDWARE_OP_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            log_audio_style_hardware_op_skip_throttled(operation, "busy", None);
            return None;
        }

        Some(Self)
    }
}

fn log_audio_style_hardware_op_skip_throttled(
    operation: &'static str,
    reason: &'static str,
    cooldown_remaining_ms: Option<u64>,
) -> bool {
    let now_ms = current_time_millis();
    let (window_until, suppressed) = match reason {
        "busy" => (
            &AUDIO_STYLE_HARDWARE_BUSY_SKIP_LOG_UNTIL_MS,
            &AUDIO_STYLE_HARDWARE_BUSY_SKIP_SUPPRESSED,
        ),
        "cooldown" => (
            &AUDIO_STYLE_HARDWARE_COOLDOWN_SKIP_LOG_UNTIL_MS,
            &AUDIO_STYLE_HARDWARE_COOLDOWN_SKIP_SUPPRESSED,
        ),
        _ => return false,
    };
    let current_until = window_until.load(Ordering::SeqCst);
    if now_ms < current_until {
        suppressed.fetch_add(1, Ordering::SeqCst);
        return false;
    }

    let next_until = now_ms.saturating_add(AUDIO_STYLE_TENSOR_HARDWARE_SKIP_LOG_WINDOW_MS);
    if window_until
        .compare_exchange(
            current_until,
            next_until,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_err()
    {
        suppressed.fetch_add(1, Ordering::SeqCst);
        return false;
    }

    let suppressed_count = suppressed.swap(0, Ordering::SeqCst);
    match cooldown_remaining_ms {
        Some(cooldown_remaining_ms) => log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_tensor_hardware_op_skipped operation={operation} reason={reason} active=false cooldown_remaining_ms={cooldown_remaining_ms} suppressed={suppressed_count} action=cpu_fallback_for_this_call",
        ),
        None => log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_tensor_hardware_op_skipped operation={operation} reason={reason} suppressed={suppressed_count} action=cpu_fallback_for_this_call",
        ),
    }
    true
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
    !sync_ok || !cleanup_sync_ok || elapsed_ms >= AUDIO_STYLE_TENSOR_HARDWARE_CLEANUP_SLOW_MS
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
    let cooldown_until =
        current_time_millis().saturating_add(AUDIO_STYLE_TENSOR_HARDWARE_OP_COOLDOWN_MS);
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
    AUDIO_STYLE_HARDWARE_BUSY_SKIP_LOG_UNTIL_MS.store(0, Ordering::SeqCst);
    AUDIO_STYLE_HARDWARE_BUSY_SKIP_SUPPRESSED.store(0, Ordering::SeqCst);
    AUDIO_STYLE_HARDWARE_COOLDOWN_SKIP_LOG_UNTIL_MS.store(0, Ordering::SeqCst);
    AUDIO_STYLE_HARDWARE_COOLDOWN_SKIP_SUPPRESSED.store(0, Ordering::SeqCst);
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

#[cfg(test)]
pub(crate) fn log_audio_style_hardware_busy_skip_for_test() -> bool {
    log_audio_style_hardware_op_skip_throttled("test", "busy", None)
}

#[cfg(test)]
pub(crate) fn audio_style_hardware_busy_skip_suppressed_for_test() -> u64 {
    AUDIO_STYLE_HARDWARE_BUSY_SKIP_SUPPRESSED.load(Ordering::SeqCst)
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
    fn from_model_parts(
        embeddings: &AudioStyleEmbeddingMap,
        stats: &AudioStyleStats,
        neighbor_index: &AudioStyleNeighborIndex,
    ) -> Option<Self> {
        if embeddings.len() < 2 {
            return None;
        }

        let mean = stats.mean();
        let local_density = neighbor_index.local_density_map(embeddings, &mean);
        let self_supervised_basins =
            self_supervised_style_basins_from_neighbors(embeddings, neighbor_index, &local_density);
        let manifold = audio_style_manifold_descriptors_from_neighbors(
            embeddings,
            &mean,
            neighbor_index,
            &local_density,
            &self_supervised_basins,
        );
        let future_occupancy = audio_style_future_occupancy_descriptors_from_neighbors(
            neighbor_index,
            &self_supervised_basins,
            &manifold,
        );
        Some(Self {
            mean,
            local_density,
            manifold,
            future_occupancy,
            self_supervised_basins,
            similarity_low: neighbor_index.similarity_low,
            similarity_high: neighbor_index.similarity_high,
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

    fn self_supervised_basin_for_track(
        &self,
        track: &PlaybackTrack,
    ) -> Option<PlaybackAttractorBasinKey> {
        self.self_supervised_basins
            .get(&PlaybackTrackKey::from_track(track))
            .cloned()
    }

    fn manifold_for_key(&self, key: &PlaybackTrackKey) -> Option<AudioStyleManifoldDescriptor> {
        self.manifold.get(key).copied()
    }

    fn future_occupancy_for_key(
        &self,
        key: &PlaybackTrackKey,
    ) -> Option<AudioStyleFutureOccupancyDescriptor> {
        self.future_occupancy.get(key).copied()
    }
}

fn audio_style_model_inputs_match_snapshot(
    previous: &AudioStyleModelState,
    indexed_tracks: &[AudioStyleIndexedTrack],
) -> bool {
    let mut seen = HashSet::with_capacity(indexed_tracks.len());
    for indexed in indexed_tracks {
        let key = PlaybackTrackKey::from_track(&indexed.track);
        if !seen.insert(key.clone()) {
            continue;
        }
        if !previous.embeddings.contains_key(&key) || !previous.indexed_tracks.contains_key(&key) {
            return false;
        }
    }

    previous.indexed_tracks.len() == seen.len()
}

fn merge_audio_style_indexed_tracks(
    previous: Option<&AudioStyleModelSnapshot>,
    pending_tracks: Vec<AudioStyleIndexedTrack>,
) -> Vec<AudioStyleIndexedTrack> {
    let mut merged = previous
        .map(|snapshot| {
            snapshot
                .state
                .indexed_tracks
                .values()
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut index_by_key = merged
        .iter()
        .enumerate()
        .map(|(index, indexed)| (PlaybackTrackKey::from_track(&indexed.track), index))
        .collect::<HashMap<_, _>>();
    for indexed in pending_tracks {
        let key = PlaybackTrackKey::from_track(&indexed.track);
        match index_by_key.get(&key).copied() {
            Some(index) => merged[index] = indexed,
            None => {
                index_by_key.insert(key, merged.len());
                merged.push(indexed);
            }
        }
    }
    merged
}

impl AudioStyleModelState {
    fn refresh_metadata_from_indexed_tracks(
        previous: &Self,
        indexed_tracks: Vec<AudioStyleIndexedTrack>,
    ) -> Self {
        let mut indexed_by_key = HashMap::new();
        let mut seen = HashSet::new();
        for indexed in indexed_tracks {
            let key = PlaybackTrackKey::from_track(&indexed.track);
            if !seen.insert(key.clone()) {
                continue;
            }
            indexed_by_key.insert(key, indexed);
        }
        Self {
            embeddings: previous.embeddings.clone(),
            indexed_tracks: indexed_by_key,
            neighbor_index: previous.neighbor_index.clone(),
            sampling_geometry: previous.sampling_geometry.clone(),
        }
    }

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

        let state = Self::from_embeddings(previous, embeddings, indexed_by_key, &previous_reused);
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
        indexed_tracks: HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
        previous_reused: &HashSet<PlaybackTrackKey>,
    ) -> Self {
        let stats = AudioStyleStats::from_embeddings(&embeddings);
        let neighbor_index =
            AudioStyleNeighborIndex::refresh_from(previous, &embeddings, &stats, previous_reused);
        let sampling_geometry =
            AudioStyleSamplingGeometry::from_model_parts(&embeddings, &stats, &neighbor_index);
        Self {
            embeddings,
            indexed_tracks,
            neighbor_index,
            sampling_geometry,
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

        for key in sorted_audio_style_embedding_keys(embeddings) {
            let should_repair = !previous_reused.contains(&key)
                || previous
                    .neighbor_index
                    .neighbors
                    .get(&key)
                    .is_none_or(|old_neighbors| {
                        old_neighbors
                            .iter()
                            .any(|neighbor| deleted_keys.contains(neighbor))
                    });
            if should_repair {
                neighbors.insert(
                    key.clone(),
                    Self::top_neighbors_for(&key, embeddings, &mean)
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
                    .get(&key)
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
        for key in sorted_audio_style_embedding_keys(embeddings) {
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
        for key in sorted_audio_style_embedding_keys(embeddings) {
            neighbor_lists.insert(key.clone(), Vec::new());
        }

        let keys = sorted_audio_style_embedding_keys(embeddings);
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
        for other_key in sorted_audio_style_embedding_keys(embeddings) {
            if &other_key == key {
                continue;
            }
            let Some(other_embedding) = embeddings.get(&other_key) else {
                continue;
            };
            let Some(similarity) = centered_cosine(embedding, other_embedding, mean) else {
                continue;
            };
            push_audio_style_neighbor(Some(&mut neighbors), other_key, similarity);
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

fn sorted_audio_style_embedding_keys(embeddings: &AudioStyleEmbeddingMap) -> Vec<PlaybackTrackKey> {
    let mut keys = embeddings.keys().cloned().collect::<Vec<_>>();
    keys.sort_by_key(audio_style_track_key_sort_value);
    keys
}

fn sorted_audio_style_indexed_track_keys(
    indexed_tracks: &HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
) -> Vec<PlaybackTrackKey> {
    let mut keys = indexed_tracks.keys().cloned().collect::<Vec<_>>();
    keys.sort_by_key(audio_style_track_key_sort_value);
    keys
}

fn sorted_audio_style_neighbor_keys(
    neighbors: &HashMap<PlaybackTrackKey, Vec<PlaybackTrackKey>>,
) -> Vec<PlaybackTrackKey> {
    let mut keys = neighbors.keys().cloned().collect::<Vec<_>>();
    keys.sort_by_key(audio_style_track_key_sort_value);
    keys
}

fn sorted_audio_style_local_density_keys(
    local_density: &HashMap<PlaybackTrackKey, f32>,
) -> Vec<PlaybackTrackKey> {
    let mut keys = local_density.keys().cloned().collect::<Vec<_>>();
    keys.sort_by_key(audio_style_track_key_sort_value);
    keys
}

fn sorted_audio_style_manifold_keys(
    manifold: &HashMap<PlaybackTrackKey, AudioStyleManifoldDescriptor>,
) -> Vec<PlaybackTrackKey> {
    let mut keys = manifold.keys().cloned().collect::<Vec<_>>();
    keys.sort_by_key(audio_style_track_key_sort_value);
    keys
}

fn sorted_audio_style_basin_assignment_keys(
    basins: &HashMap<PlaybackTrackKey, PlaybackAttractorBasinKey>,
) -> Vec<PlaybackTrackKey> {
    let mut keys = basins.keys().cloned().collect::<Vec<_>>();
    keys.sort_by_key(audio_style_track_key_sort_value);
    keys
}

fn audio_style_track_key_sort_value(key: &PlaybackTrackKey) -> (String, String, u32, u32) {
    (
        key.music_url.clone(),
        key.file_path.to_string_lossy().to_string(),
        key.start_ms,
        key.end_ms,
    )
}

fn centered_cosine(
    left: &AudioStyleEmbedding,
    right: &AudioStyleEmbedding,
    mean: &[f32],
) -> Option<f32> {
    centered_cosine_cpu(left, right, mean)
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

fn audio_style_raw_embedding_cosine(
    left: &AudioStyleEmbedding,
    right: &AudioStyleEmbedding,
) -> Option<f32> {
    if left.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH
        || right.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH
    {
        return None;
    }

    let mut dot = 0.0_f32;
    let mut left_norm = 0.0_f32;
    let mut right_norm = 0.0_f32;
    for (left, right) in left.values.iter().zip(right.values.iter()) {
        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
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

fn audio_style_manifold_descriptors_from_neighbors(
    embeddings: &AudioStyleEmbeddingMap,
    mean: &[f32],
    neighbor_index: &AudioStyleNeighborIndex,
    local_density: &HashMap<PlaybackTrackKey, f32>,
    basins: &HashMap<PlaybackTrackKey, PlaybackAttractorBasinKey>,
) -> HashMap<PlaybackTrackKey, AudioStyleManifoldDescriptor> {
    let mut result = HashMap::with_capacity(embeddings.len());
    for (key, embedding) in embeddings {
        let neighbor_similarities = neighbor_index
            .neighbors
            .get(key)
            .into_iter()
            .flatten()
            .filter_map(|neighbor| {
                let neighbor_embedding = embeddings.get(neighbor)?;
                let similarity = centered_cosine(embedding, neighbor_embedding, mean)?;
                similarity.is_finite().then_some((neighbor, similarity))
            })
            .take(AUDIO_STYLE_MANIFOLD_NEIGHBOR_TOP_K)
            .collect::<Vec<_>>();

        if neighbor_similarities.is_empty() {
            result.insert(
                key.clone(),
                AudioStyleManifoldDescriptor {
                    spectral_rank: 1.0,
                    curvature: 0.0,
                    boundary_pressure: 0.0,
                },
            );
            continue;
        }

        let spectral_rank = audio_style_effective_rank_from_neighbor_similarities(
            neighbor_similarities
                .iter()
                .map(|(_, similarity)| *similarity),
        );
        let density = local_density.get(key).copied().unwrap_or(0.0);
        let curvature =
            audio_style_curvature_from_neighbor_similarities(&neighbor_similarities, density);
        let boundary_pressure =
            audio_style_boundary_pressure_from_neighbor_basins(key, &neighbor_similarities, basins);

        result.insert(
            key.clone(),
            AudioStyleManifoldDescriptor {
                spectral_rank,
                curvature,
                boundary_pressure,
            },
        );
    }
    result
}

fn audio_style_future_occupancy_descriptors_from_neighbors(
    neighbor_index: &AudioStyleNeighborIndex,
    basins: &HashMap<PlaybackTrackKey, PlaybackAttractorBasinKey>,
    _manifold: &HashMap<PlaybackTrackKey, AudioStyleManifoldDescriptor>,
) -> HashMap<PlaybackTrackKey, AudioStyleFutureOccupancyDescriptor> {
    let basin_count = basins
        .values()
        .cloned()
        .collect::<HashSet<_>>()
        .len()
        .max(1);
    let entropy_scale = (basin_count.max(2) as f32).ln().max(1.0e-6);
    let mut result = HashMap::with_capacity(basins.len());

    for (key, basin) in basins {
        let mut total = 0usize;
        let mut same_basin = 0usize;
        let mut basin_counts: HashMap<PlaybackAttractorBasinKey, usize> = HashMap::new();

        for neighbor in neighbor_index
            .neighbors
            .get(key)
            .into_iter()
            .flatten()
            .take(AUDIO_STYLE_FUTURE_OCCUPANCY_NEIGHBOR_TOP_K)
        {
            let Some(neighbor_basin) = basins.get(neighbor) else {
                continue;
            };
            total += 1;
            if neighbor_basin == basin {
                same_basin += 1;
            }
            *basin_counts.entry(neighbor_basin.clone()).or_insert(0) += 1;
        }

        if total == 0 {
            continue;
        }

        let entropy = basin_counts
            .values()
            .copied()
            .map(|count| {
                let probability = (count as f32 / total as f32).clamp(1.0e-8, 1.0);
                -probability * probability.ln()
            })
            .sum::<f32>()
            / entropy_scale;
        let largest_share = basin_counts
            .values()
            .copied()
            .max()
            .map(|count| count as f32 / total as f32)
            .unwrap_or(1.0);
        let same_basin_neighbor_share = same_basin as f32 / total as f32;
        let reachability = (0.58 * entropy.clamp(0.0, 1.0)
            + 0.28 * (1.0 - same_basin_neighbor_share)
            + 0.14 * (1.0 - largest_share))
            .clamp(0.0, 1.0);

        result.insert(
            key.clone(),
            AudioStyleFutureOccupancyDescriptor {
                reachability,
                future_entropy: entropy.clamp(0.0, 1.0),
                same_basin_neighbor_share: same_basin_neighbor_share.clamp(0.0, 1.0),
            },
        );
    }

    for key in basins.keys() {
        result
            .entry(key.clone())
            .or_insert(AudioStyleFutureOccupancyDescriptor {
                reachability: 0.0,
                future_entropy: 0.0,
                same_basin_neighbor_share: 1.0,
            });
    }

    result
}

fn audio_style_effective_rank_from_neighbor_similarities(
    similarities: impl IntoIterator<Item = f32>,
) -> f32 {
    let shifted = similarities
        .into_iter()
        .filter(|value| value.is_finite())
        .map(|value| (value + 1.0).max(0.0).powi(2))
        .collect::<Vec<_>>();
    let total = shifted.iter().copied().sum::<f32>();
    if total <= 1.0e-6 || !total.is_finite() {
        return 1.0;
    }

    let entropy = shifted
        .iter()
        .copied()
        .filter(|weight| *weight > 0.0)
        .map(|weight| {
            let probability = (weight / total).clamp(1.0e-8, 1.0);
            -probability * probability.ln()
        })
        .sum::<f32>();
    entropy
        .exp()
        .clamp(1.0, AUDIO_STYLE_MANIFOLD_NEIGHBOR_TOP_K as f32)
}

fn audio_style_curvature_from_neighbor_similarities(
    neighbor_similarities: &[(&PlaybackTrackKey, f32)],
    density: f32,
) -> f32 {
    let count = neighbor_similarities.len();
    if count <= 1 {
        return 0.0;
    }
    let mean = neighbor_similarities
        .iter()
        .map(|(_, similarity)| *similarity)
        .sum::<f32>()
        / count as f32;
    let variance = neighbor_similarities
        .iter()
        .map(|(_, similarity)| (*similarity - mean).powi(2))
        .sum::<f32>()
        / count as f32;
    let scale = (density.abs() + mean.abs() + 0.25).max(1.0e-6);
    (variance.sqrt() / scale).clamp(0.0, 1.0)
}

fn audio_style_boundary_pressure_from_neighbor_basins(
    key: &PlaybackTrackKey,
    neighbor_similarities: &[(&PlaybackTrackKey, f32)],
    basins: &HashMap<PlaybackTrackKey, PlaybackAttractorBasinKey>,
) -> f32 {
    let Some(anchor_basin) = basins.get(key) else {
        return 0.0;
    };
    let mut total = 0usize;
    let mut outside = 0usize;
    for (neighbor, _) in neighbor_similarities {
        let Some(neighbor_basin) = basins.get(*neighbor) else {
            continue;
        };
        total += 1;
        if neighbor_basin != anchor_basin {
            outside += 1;
        }
    }
    if total == 0 {
        return 0.0;
    }
    (outside as f32 / total as f32).clamp(0.0, 1.0)
}

fn self_supervised_style_basins_from_neighbors(
    embeddings: &AudioStyleEmbeddingMap,
    neighbor_index: &AudioStyleNeighborIndex,
    local_density: &HashMap<PlaybackTrackKey, f32>,
) -> HashMap<PlaybackTrackKey, PlaybackAttractorBasinKey> {
    let keys = sorted_audio_style_embedding_keys(embeddings);
    if keys.is_empty() {
        return HashMap::new();
    }
    if keys.len() == 1 {
        return keys
            .into_iter()
            .enumerate()
            .map(|(index, key)| {
                (
                    key,
                    PlaybackAttractorBasinKey {
                        value: format!("audio-basin:{index}"),
                    },
                )
            })
            .collect();
    }

    let similarity_between_keys = |left: &PlaybackTrackKey, right: &PlaybackTrackKey| {
        let left_embedding = embeddings.get(left)?;
        let right_embedding = embeddings.get(right)?;
        audio_style_raw_embedding_cosine(left_embedding, right_embedding)
    };
    let mut neighbor_tail_sum = 0.0_f32;
    let mut neighbor_tail_count = 0usize;
    let mut peak_scores = Vec::with_capacity(keys.len());
    for key in &keys {
        let neighbor_similarities = neighbor_index
            .neighbors
            .get(key)
            .into_iter()
            .flatten()
            .filter_map(|neighbor| similarity_between_keys(key, neighbor))
            .filter(|similarity| similarity.is_finite())
            .collect::<Vec<_>>();
        let local_gap = match (neighbor_similarities.first(), neighbor_similarities.last()) {
            (Some(first), Some(last)) => (first - last).max(0.0),
            _ => 0.0,
        };
        if let Some(tail) = neighbor_similarities.last() {
            neighbor_tail_sum += *tail;
            neighbor_tail_count += 1;
        }
        let density = local_density.get(key).copied().unwrap_or(0.0);
        peak_scores.push((
            key.clone(),
            density + AUDIO_STYLE_SELF_SUPERVISED_BASIN_GAP_WEIGHT * local_gap,
        ));
    }

    let tail_mean = if neighbor_tail_count == 0 {
        0.0
    } else {
        neighbor_tail_sum / neighbor_tail_count as f32
    };
    let separation_floor = (tail_mean + AUDIO_STYLE_SELF_SUPERVISED_BASIN_SEPARATION_OFFSET).clamp(
        AUDIO_STYLE_SELF_SUPERVISED_BASIN_SEPARATION_MIN,
        AUDIO_STYLE_SELF_SUPERVISED_BASIN_SEPARATION_MAX,
    );
    peak_scores.sort_by(|left, right| {
        right.1.total_cmp(&left.1).then_with(|| {
            audio_style_track_key_sort_value(&left.0)
                .cmp(&audio_style_track_key_sort_value(&right.0))
        })
    });

    let max_prototypes = ((keys.len() as f32).sqrt() as usize + 2)
        .max(1)
        .min(keys.len());
    let mut prototypes = Vec::<PlaybackTrackKey>::new();
    for (candidate, _) in peak_scores {
        let too_close = prototypes.iter().any(|prototype| {
            similarity_between_keys(&candidate, prototype).is_some_and(|similarity| {
                similarity >= separation_floor
                    || similarity >= AUDIO_STYLE_SELF_SUPERVISED_BASIN_NEAR_DUPLICATE_FLOOR
            })
        });
        if too_close {
            continue;
        }
        prototypes.push(candidate);
        if prototypes.len() >= max_prototypes {
            break;
        }
    }
    if prototypes.is_empty() {
        prototypes.push(keys[0].clone());
    }

    let prototype_order = prototypes
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, key)| (key, index))
        .collect::<HashMap<_, _>>();
    let mut result = HashMap::with_capacity(keys.len());
    for key in keys {
        let best_prototype = prototypes
            .iter()
            .max_by(|left, right| {
                let left_similarity = if *left == &key {
                    1.0
                } else {
                    similarity_between_keys(&key, left).unwrap_or(-1.0)
                };
                let right_similarity = if *right == &key {
                    1.0
                } else {
                    similarity_between_keys(&key, right).unwrap_or(-1.0)
                };
                left_similarity.total_cmp(&right_similarity).then_with(|| {
                    audio_style_track_key_sort_value(right)
                        .cmp(&audio_style_track_key_sort_value(left))
                })
            })
            .cloned()
            .unwrap_or_else(|| key.clone());
        let basin_index = prototype_order.get(&best_prototype).copied().unwrap_or(0);
        result.insert(
            key,
            PlaybackAttractorBasinKey {
                value: format!("audio-basin:{basin_index}"),
            },
        );
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

    pub(crate) fn balance_candidate_field_for_anchor(
        &self,
        anchor: &PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
        target_count: usize,
    ) -> Vec<PlaybackTrack> {
        balance_audio_style_candidate_field_for_anchor(
            anchor,
            candidates,
            target_count,
            &self.embeddings,
            self.sampling_geometry.as_ref(),
        )
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
        Self {
            embeddings: state.embeddings.clone(),
            indexed_tracks: state.indexed_tracks.clone(),
            sampling_geometry: state.sampling_geometry.clone(),
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
        Self::refresh_from_indexed_tracks_updated(previous, cache, indexed_tracks, || generation)
    }

    fn refresh_from_indexed_tracks(
        previous: Option<&Self>,
        cache: &AudioStyleEmbeddingCache,
        indexed_tracks: Vec<AudioStyleIndexedTrack>,
        mut next_generation: impl FnMut() -> u64,
    ) -> Result<AudioStyleModelRefreshOutcome, AudioStyleModelUpdateFailure> {
        if let Some(previous) = previous {
            let previous_state = previous.state.as_ref();
            if audio_style_model_inputs_match_snapshot(previous_state, &indexed_tracks) {
                let state = AudioStyleModelState::refresh_metadata_from_indexed_tracks(
                    previous_state,
                    indexed_tracks,
                );
                return Ok(AudioStyleModelRefreshOutcome::Unchanged(Self::from_state(
                    previous.generation(),
                    Arc::new(state),
                )));
            }
        }

        let state = AudioStyleModelState::refresh_from_with_progress(
            previous.map(|snapshot| snapshot.state.as_ref()),
            cache,
            indexed_tracks,
        )?;
        Ok(AudioStyleModelRefreshOutcome::Updated(Self::from_state(
            next_generation(),
            Arc::new(state),
        )))
    }

    #[cfg(test)]
    fn refresh_from_indexed_tracks_updated(
        previous: Option<&Self>,
        cache: &AudioStyleEmbeddingCache,
        indexed_tracks: Vec<AudioStyleIndexedTrack>,
        next_generation: impl FnMut() -> u64,
    ) -> Result<Self, AudioStyleModelUpdateFailure> {
        match Self::refresh_from_indexed_tracks(previous, cache, indexed_tracks, next_generation)? {
            AudioStyleModelRefreshOutcome::Updated(snapshot) => Ok(snapshot),
            AudioStyleModelRefreshOutcome::Unchanged(snapshot) => Ok(snapshot),
        }
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

    pub(crate) fn balance_candidate_field_for_anchor(
        &self,
        anchor: &PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
        target_count: usize,
    ) -> Vec<PlaybackTrack> {
        self.recommender
            .balance_candidate_field_for_anchor(anchor, candidates, target_count)
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
    pub(crate) fn from_test_indexed_embeddings(
        generation: u64,
        values: impl IntoIterator<Item = (PlaybackTrack, Vec<f32>, String)>,
    ) -> Self {
        let recommender =
            AudioStylePlaylistPlaybackRecommender::from_test_indexed_embeddings(values);
        let state = Arc::new(AudioStyleModelState::from_embeddings(
            None,
            recommender.embeddings.clone(),
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
        Self::refresh_from_indexed_tracks_updated(previous, cache, indexed_tracks, || generation)
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
    StartupStableModel,
}

impl StableSnapshotPublicationReason {
    #[cfg(not(test))]
    fn as_str(self) -> &'static str {
        match self {
            Self::TrainingComplete => "training_complete",
            Self::StartupStableModel => "startup_stable_model",
        }
    }
}

pub(crate) fn stable_snapshot_publication_requests_first_slot_refresh(
    reason: StableSnapshotPublicationReason,
    stable_existed: bool,
) -> bool {
    match reason {
        StableSnapshotPublicationReason::TrainingComplete => true,
        StableSnapshotPublicationReason::StartupStableModel => !stable_existed,
    }
}

pub(crate) fn audio_style_startup_training_decision(
    restored_stable_model: bool,
    pending_input_changes: u64,
    restored_pending_training_inputs: usize,
    persisted_invalidations: u64,
    input_coverage: AudioStyleStartupInputCoverage,
) -> AudioStyleStartupTrainingDecision {
    if pending_input_changes > 0 || restored_pending_training_inputs > 0 {
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges
    } else if persisted_invalidations > 0
        && !restored_stable_model
        && input_coverage != AudioStyleStartupInputCoverage::Covered
    {
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges
    } else if restored_stable_model && input_coverage == AudioStyleStartupInputCoverage::Covered {
        AudioStyleStartupTrainingDecision::SkipRestoredStableModel
    } else if !restored_stable_model {
        AudioStyleStartupTrainingDecision::SkipNoTrainingInputs
    } else if input_coverage == AudioStyleStartupInputCoverage::Empty {
        AudioStyleStartupTrainingDecision::SkipNoTrainingInputs
    } else {
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges
    }
}

impl From<&Music> for AudioStyleMusicInputIdentity {
    fn from(music: &Music) -> Self {
        Self {
            canonical_music_id: music.canonical_music_id.clone(),
            music_url: music.url.clone(),
            path: music.path.clone(),
            start_ms: music.start_ms,
            end_ms: music.end_ms,
        }
    }
}

pub(crate) fn read_audio_style_training_invalidation_file(
    path: &Path,
) -> Result<Vec<AudioStyleTrainingInvalidationRecord>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(anyhow!(
                "failed to read audio style training invalidation file `{}`: {error}",
                path.display()
            ));
        }
    };
    let file: AudioStyleTrainingInvalidationFile =
        serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "failed to parse audio style training invalidation file `{}`",
                path.display()
            )
        })?;
    if file.version != AUDIO_STYLE_TRAINING_INVALIDATION_FILE_VERSION {
        return Err(anyhow!(
            "unsupported audio style training invalidation file version `{}` in `{}`",
            file.version,
            path.display()
        ));
    }
    Ok(deduplicate_audio_style_training_invalidations(file.records))
}

pub(crate) fn upsert_audio_style_training_invalidation_file(
    path: &Path,
    record: AudioStyleTrainingInvalidationRecord,
) -> Result<usize> {
    let mut records = read_audio_style_training_invalidation_file(path)?;
    let key = audio_style_training_invalidation_key(&record);
    records.retain(|existing| audio_style_training_invalidation_key(existing) != key);
    records.push(record);
    let count = records.len();
    write_audio_style_training_invalidation_file(path, &records)?;
    Ok(count)
}

pub(crate) fn clear_audio_style_training_invalidation_file(path: &Path) -> Result<usize> {
    let records = read_audio_style_training_invalidation_file(path)?;
    let count = records.len();
    write_audio_style_training_invalidation_file(path, &[])?;
    Ok(count)
}

fn read_audio_style_pending_training_input_file(
    path: &Path,
) -> Result<Vec<AudioStyleTrainingTrackInput>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(anyhow!(
                "failed to read audio style pending training input file `{}`: {error}",
                path.display()
            ));
        }
    };
    let file: AudioStylePendingTrainingInputFile =
        serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "failed to parse audio style pending training input file `{}`",
                path.display()
            )
        })?;
    if file.version != AUDIO_STYLE_PENDING_TRAINING_INPUT_FILE_VERSION {
        return Err(anyhow!(
            "unsupported audio style pending training input file version `{}` in `{}`",
            file.version,
            path.display()
        ));
    }
    Ok(deduplicate_audio_style_training_inputs(file.inputs))
}

fn upsert_audio_style_pending_training_input_file(
    path: &Path,
    inputs: &[AudioStyleTrainingTrackInput],
) -> Result<usize> {
    let mut records = read_audio_style_pending_training_input_file(path)?;
    records.extend(inputs.iter().cloned());
    let records = deduplicate_audio_style_training_inputs(records);
    let count = records.len();
    write_audio_style_pending_training_input_file(path, &records)?;
    Ok(count)
}

fn acknowledge_audio_style_pending_training_input_file(
    path: &Path,
    consumed_records: &HashMap<AudioStyleTrainingInputKey, AudioStyleTrainingTrackInput>,
) -> Result<(usize, usize)> {
    if consumed_records.is_empty() {
        return Ok((0, read_audio_style_pending_training_input_file(path)?.len()));
    }
    let records = read_audio_style_pending_training_input_file(path)?;
    let before = records.len();
    let remaining = records
        .into_iter()
        .filter(|input| !audio_style_training_input_matches_consumed(input, consumed_records))
        .collect::<Vec<_>>();
    let removed = before.saturating_sub(remaining.len());
    write_audio_style_pending_training_input_file(path, &remaining)?;
    Ok((removed, remaining.len()))
}

#[cfg(test)]
pub(crate) fn read_audio_style_pending_training_input_file_for_test(
    path: &Path,
) -> Result<Vec<AudioStyleTrainingTrackInput>> {
    read_audio_style_pending_training_input_file(path)
}

#[cfg(test)]
pub(crate) fn upsert_audio_style_pending_training_input_file_for_test(
    path: &Path,
    inputs: &[AudioStyleTrainingTrackInput],
) -> Result<usize> {
    upsert_audio_style_pending_training_input_file(path, inputs)
}

#[cfg(test)]
pub(crate) fn acknowledge_audio_style_pending_training_input_file_for_test(
    path: &Path,
    inputs: &[AudioStyleTrainingTrackInput],
) -> Result<(usize, usize)> {
    let consumed_records = audio_style_training_input_record_map(inputs);
    acknowledge_audio_style_pending_training_input_file(path, &consumed_records)
}

fn write_audio_style_pending_training_input_file(
    path: &Path,
    inputs: &[AudioStyleTrainingTrackInput],
) -> Result<()> {
    if inputs.is_empty() {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(anyhow!(
                    "failed to remove audio style pending training input file `{}`: {error}",
                    path.display()
                ));
            }
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create audio style pending training input directory `{}`",
                parent.display()
            )
        })?;
    }
    let file = AudioStylePendingTrainingInputFile {
        version: AUDIO_STYLE_PENDING_TRAINING_INPUT_FILE_VERSION.to_string(),
        inputs: inputs.to_vec(),
    };
    let bytes = serde_json::to_vec(&file)
        .context("failed to encode audio style pending training input file")?;
    fs::write(path, bytes).with_context(|| {
        format!(
            "failed to write audio style pending training input file `{}`",
            path.display()
        )
    })
}

fn deduplicate_audio_style_training_inputs(
    inputs: Vec<AudioStyleTrainingTrackInput>,
) -> Vec<AudioStyleTrainingTrackInput> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for input in inputs.into_iter().rev() {
        let key = audio_style_training_input_key(&input);
        if seen.insert(key) {
            result.push(input);
        }
    }
    result.reverse();
    result
}

type AudioStyleTrainingInputKey = (String, String, String, u32, u32);

fn audio_style_training_input_key(
    input: &AudioStyleTrainingTrackInput,
) -> AudioStyleTrainingInputKey {
    (
        input.canonical_music_id.clone(),
        input.url.clone(),
        input.absolute_path.clone(),
        input.start_ms,
        input.end_ms,
    )
}

fn audio_style_training_input_key_from_track(track: &PlaybackTrack) -> AudioStyleTrainingInputKey {
    (
        track.canonical_music_id.clone(),
        track.music_url.clone(),
        track.file_path.to_string_lossy().to_string(),
        track.start_ms,
        track.end_ms,
    )
}

fn audio_style_training_inputs_covered_by_snapshot(
    inputs: &[AudioStyleTrainingTrackInput],
    snapshot: &AudioStyleModelSnapshot,
) -> Vec<AudioStyleTrainingTrackInput> {
    let covered_keys = snapshot
        .state
        .embeddings
        .keys()
        .filter_map(|key| {
            snapshot
                .state
                .indexed_tracks
                .get(key)
                .map(|indexed| audio_style_training_input_key_from_track(&indexed.track))
        })
        .collect::<HashSet<_>>();
    let covered_inputs = inputs
        .iter()
        .filter(|input| covered_keys.contains(&audio_style_training_input_key(input)))
        .cloned()
        .collect::<Vec<_>>();
    if covered_inputs.len() != inputs.len() {
        log::info!(
            target: AUDIO_STYLE_LOG_TARGET,
            "audio_style_pending_training_inputs_retained_uncovered consumed={} covered={} retained={}",
            inputs.len(),
            covered_inputs.len(),
            inputs.len().saturating_sub(covered_inputs.len())
        );
    }
    covered_inputs
}

#[cfg(test)]
pub(crate) fn audio_style_training_inputs_covered_by_snapshot_for_test(
    inputs: &[AudioStyleTrainingTrackInput],
    snapshot: &AudioStyleModelSnapshot,
) -> Vec<AudioStyleTrainingTrackInput> {
    audio_style_training_inputs_covered_by_snapshot(inputs, snapshot)
}

fn audio_style_training_input_record_map(
    inputs: &[AudioStyleTrainingTrackInput],
) -> HashMap<AudioStyleTrainingInputKey, AudioStyleTrainingTrackInput> {
    inputs
        .iter()
        .map(|input| (audio_style_training_input_key(input), input.clone()))
        .collect()
}

fn audio_style_training_input_matches_consumed(
    input: &AudioStyleTrainingTrackInput,
    consumed_records: &HashMap<AudioStyleTrainingInputKey, AudioStyleTrainingTrackInput>,
) -> bool {
    consumed_records
        .get(&audio_style_training_input_key(input))
        .is_some_and(|consumed| consumed == input)
}

fn write_audio_style_training_invalidation_file(
    path: &Path,
    records: &[AudioStyleTrainingInvalidationRecord],
) -> Result<()> {
    if records.is_empty() {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(anyhow!(
                    "failed to remove audio style training invalidation file `{}`: {error}",
                    path.display()
                ));
            }
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create audio style training invalidation directory `{}`",
                parent.display()
            )
        })?;
    }
    let file = AudioStyleTrainingInvalidationFile {
        version: AUDIO_STYLE_TRAINING_INVALIDATION_FILE_VERSION.to_owned(),
        records: records.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&file)
        .context("failed to encode audio style training invalidation file")?;
    fs::write(path, bytes).with_context(|| {
        format!(
            "failed to write audio style training invalidation file `{}`",
            path.display()
        )
    })
}

fn deduplicate_audio_style_training_invalidations(
    records: Vec<AudioStyleTrainingInvalidationRecord>,
) -> Vec<AudioStyleTrainingInvalidationRecord> {
    let mut seen = HashSet::new();
    let mut deduplicated = Vec::new();
    for record in records.into_iter().rev() {
        if seen.insert(audio_style_training_invalidation_key(&record)) {
            deduplicated.push(record);
        }
    }
    deduplicated.reverse();
    deduplicated
}

fn audio_style_training_invalidation_key(record: &AudioStyleTrainingInvalidationRecord) -> String {
    match record.music.as_ref() {
        Some(music) => format!(
            "music\0{}\0{}\0{}\0{}\0{}",
            music.canonical_music_id,
            music.music_url,
            music.path.as_deref().unwrap_or_default(),
            music.start_ms,
            music.end_ms
        ),
        None => format!("library\0{}", record.reason),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioStyleTrainingInputReadiness {
    ReadyToBuildModel,
    NoIndexableTracks,
}

pub(crate) fn audio_style_training_input_readiness(
    indexed_track_count: usize,
) -> AudioStyleTrainingInputReadiness {
    if indexed_track_count == 0 {
        AudioStyleTrainingInputReadiness::NoIndexableTracks
    } else {
        AudioStyleTrainingInputReadiness::ReadyToBuildModel
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

pub(crate) fn recommendation_candidate_allowed_by_recent_history(
    candidate: &PlaybackTrack,
    recently_played_tracks: &[PlaybackTrack],
) -> bool {
    candidate.liked
        || !recently_played_tracks
            .iter()
            .any(|track| track.canonical_music_id == candidate.canonical_music_id)
}

impl PlaybackAttractorBasinKey {
    fn fallback_from_track(track: &PlaybackTrack) -> Option<Self> {
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

#[derive(Clone, Copy)]
struct AudioStyleBasinResolver<'a> {
    sampling_geometry: Option<&'a AudioStyleSamplingGeometry>,
}

impl<'a> AudioStyleBasinResolver<'a> {
    fn new(sampling_geometry: Option<&'a AudioStyleSamplingGeometry>) -> Self {
        Self { sampling_geometry }
    }

    fn basin_for_key(&self, key: &PlaybackTrackKey) -> Option<PlaybackAttractorBasinKey> {
        self.sampling_geometry
            .and_then(|geometry| geometry.self_supervised_basins.get(key).cloned())
    }

    fn basin_for_track(&self, track: &PlaybackTrack) -> Option<PlaybackAttractorBasinKey> {
        match self.sampling_geometry {
            Some(geometry) => geometry.self_supervised_basin_for_track(track),
            None => PlaybackAttractorBasinKey::fallback_from_track(track),
        }
    }
}

#[derive(Clone, Copy)]
struct PlaybackSourceBasinResolver;

impl PlaybackSourceBasinResolver {
    fn basin_for_track(&self, track: &PlaybackTrack) -> Option<PlaybackAttractorBasinKey> {
        PlaybackAttractorBasinKey::fallback_from_track(track)
    }
}

trait PlaybackBasinResolver {
    fn basin_for_track(&self, track: &PlaybackTrack) -> Option<PlaybackAttractorBasinKey>;
}

impl PlaybackBasinResolver for AudioStyleBasinResolver<'_> {
    fn basin_for_track(&self, track: &PlaybackTrack) -> Option<PlaybackAttractorBasinKey> {
        AudioStyleBasinResolver::basin_for_track(self, track)
    }
}

impl PlaybackBasinResolver for PlaybackSourceBasinResolver {
    fn basin_for_track(&self, track: &PlaybackTrack) -> Option<PlaybackAttractorBasinKey> {
        PlaybackSourceBasinResolver::basin_for_track(self, track)
    }
}

impl PlaybackAttractorBasinPressure {
    fn from_recent_history_and_candidates(
        recently_played_tracks: &[PlaybackTrack],
        candidates: &[PlaybackTrack],
        basin_resolver: AudioStyleBasinResolver<'_>,
    ) -> Self {
        let target_share = basin_target_share(candidates, basin_resolver);
        let mut pressure = Self {
            current_basin: None,
            current_basin_run: 0,
            recent_evidence_count: 0,
            fatigue: HashMap::new(),
            usage: HashMap::new(),
            candidate_top_pressure: candidate_topology_pressure(
                candidates,
                basin_resolver,
                &target_share,
            ),
            target_share,
        };

        for track in recently_played_tracks {
            let Some(basin) = basin_resolver.basin_for_track(track) else {
                continue;
            };
            pressure.recent_evidence_count += 1;
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

    fn from_recent_history_and_source_candidates(
        recently_played_tracks: &[PlaybackTrack],
        candidates: &[PlaybackTrack],
    ) -> Self {
        let source_resolver = PlaybackSourceBasinResolver;
        let target_share = basin_target_share(candidates, source_resolver);
        let mut pressure = Self {
            current_basin: None,
            current_basin_run: 0,
            recent_evidence_count: 0,
            fatigue: HashMap::new(),
            usage: HashMap::new(),
            candidate_top_pressure: candidate_topology_pressure(
                candidates,
                source_resolver,
                &target_share,
            ),
            target_share,
        };

        for track in recently_played_tracks {
            let Some(basin) = source_resolver.basin_for_track(track) else {
                continue;
            };
            pressure.recent_evidence_count += 1;
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

    fn penalty_for_track(
        &self,
        track: &PlaybackTrack,
        basin_resolver: AudioStyleBasinResolver<'_>,
    ) -> f32 {
        let Some(basin) = basin_resolver.basin_for_track(track) else {
            return 0.0;
        };

        let evidence = self.route_evidence_confidence();
        let fatigue = self.fatigue.get(&basin).copied().unwrap_or(0.0)
            * AUDIO_STYLE_BASIN_FATIGUE_STRENGTH
            * evidence;
        let usage_share = self.usage_share(&basin);
        let target_share = self.target_share.get(&basin).copied().unwrap_or(0.0);
        let homeostatic = (usage_share - target_share).max(0.0)
            * AUDIO_STYLE_BASIN_HOMEOSTATIC_STRENGTH
            * evidence;
        let run_hazard = if self.current_basin.as_ref() == Some(&basin) {
            (self.current_basin_run as f32).max(1.0).ln() * AUDIO_STYLE_BASIN_RUN_HAZARD_STRENGTH
        } else {
            0.0
        };
        let topology_top_fatigue = self
            .candidate_top_pressure
            .get(&basin)
            .copied()
            .unwrap_or(0.0)
            * AUDIO_STYLE_BIO_ROUTE_TOPOLOGY_TOP_FATIGUE_STRENGTH;

        (fatigue + homeostatic + run_hazard + topology_top_fatigue)
            .max(0.0)
            .min(AUDIO_STYLE_BASIN_PENALTY_CAP)
    }

    fn penalty_for_basin(&self, basin: &PlaybackAttractorBasinKey) -> f32 {
        let evidence = self.route_evidence_confidence();
        let fatigue = self.fatigue.get(basin).copied().unwrap_or(0.0)
            * AUDIO_STYLE_BASIN_FATIGUE_STRENGTH
            * evidence;
        let usage_share = self.usage_share(basin);
        let target_share = self.target_share.get(basin).copied().unwrap_or(0.0);
        let homeostatic = (usage_share - target_share).max(0.0)
            * AUDIO_STYLE_BASIN_HOMEOSTATIC_STRENGTH
            * evidence;
        let run_hazard = if self.current_basin.as_ref() == Some(basin) {
            (self.current_basin_run as f32).max(1.0).ln() * AUDIO_STYLE_BASIN_RUN_HAZARD_STRENGTH
        } else {
            0.0
        };
        let topology_top_fatigue = self
            .candidate_top_pressure
            .get(basin)
            .copied()
            .unwrap_or(0.0)
            * AUDIO_STYLE_BIO_ROUTE_TOPOLOGY_TOP_FATIGUE_STRENGTH;

        (fatigue + homeostatic + run_hazard + topology_top_fatigue)
            .max(0.0)
            .min(AUDIO_STYLE_BASIN_PENALTY_CAP)
    }

    fn source_penalty_for_track(
        &self,
        track: &PlaybackTrack,
        source_resolver: PlaybackSourceBasinResolver,
    ) -> f32 {
        let Some(basin) = source_resolver.basin_for_track(track) else {
            return 0.0;
        };

        self.penalty_for_basin(&basin)
    }

    fn future_deficit_for_track(
        &self,
        track: &PlaybackTrack,
        basin_resolver: AudioStyleBasinResolver<'_>,
    ) -> f32 {
        let Some(basin) = basin_resolver.basin_for_track(track) else {
            return 0.0;
        };
        let target_share = self.target_share.get(&basin).copied().unwrap_or(0.0);
        (target_share - self.usage_share(&basin)).max(0.0)
            * AUDIO_STYLE_BIO_ROUTE_FUTURE_WINDOW.sqrt()
    }

    fn route_field_gate(
        &self,
        anchor_basin: Option<&PlaybackAttractorBasinKey>,
        track: &PlaybackTrack,
        candidate_basins: &[Option<PlaybackAttractorBasinKey>],
        candidate_similarities: &[f32],
        candidate_index: usize,
        basin_resolver: AudioStyleBasinResolver<'_>,
    ) -> f32 {
        let Some(current_basin) = self.current_basin.as_ref().or(anchor_basin) else {
            return 1.0;
        };
        let Some(candidate_basin) = basin_resolver.basin_for_track(track) else {
            return 1.0;
        };
        let Some(same_quality) = candidate_similarities
            .get(candidate_index)
            .copied()
            .filter(|value| value.is_finite())
        else {
            return 1.0;
        };
        if &candidate_basin == current_basin {
            return self.stream_continuation_gate_for_basin(
                current_basin,
                candidate_basins,
                candidate_similarities,
                same_quality,
            );
        }

        self.alternative_route_gate_for_basin(
            current_basin,
            &candidate_basin,
            candidate_basins,
            candidate_similarities,
            same_quality,
        )
    }

    fn stream_continuation_gate_for_basin(
        &self,
        current_basin: &PlaybackAttractorBasinKey,
        candidate_basins: &[Option<PlaybackAttractorBasinKey>],
        candidate_similarities: &[f32],
        same_quality: f32,
    ) -> f32 {
        let same_support = candidate_basins
            .iter()
            .filter(|basin| basin.as_ref() == Some(current_basin))
            .count() as f32
            / candidate_basins.len().max(1) as f32;
        let other_quality = candidate_basins
            .iter()
            .zip(candidate_similarities.iter().copied())
            .filter(|(basin, similarity)| {
                basin.as_ref().is_some_and(|basin| basin != current_basin) && similarity.is_finite()
            })
            .map(|(_, similarity)| similarity)
            .fold(-1.0_f32, f32::max);
        let quality_margin = (same_quality - other_quality
            + AUDIO_STYLE_STREAM_CONTINUATION_MARGIN)
            .clamp(-1.0, 1.0);
        let quality_floor = ((same_quality - AUDIO_STYLE_STREAM_CONTINUATION_QUALITY_FLOOR)
            / (1.0 - AUDIO_STYLE_STREAM_CONTINUATION_QUALITY_FLOOR).max(1.0e-6))
        .clamp(-1.0, 1.0);
        let field_support = ((same_support - AUDIO_STYLE_STREAM_CONTINUATION_SUPPORT_NEUTRAL)
            / (1.0 - AUDIO_STYLE_STREAM_CONTINUATION_SUPPORT_NEUTRAL).max(1.0e-6))
        .clamp(-1.0, 1.0);
        let fatigue = (self.fatigue.get(current_basin).copied().unwrap_or(0.0) - 1.0).max(0.0);
        let overuse = (self.usage_share(current_basin)
            - self.target_share.get(current_basin).copied().unwrap_or(0.0))
        .max(0.0);
        let evidence = self.route_evidence_confidence();
        let maturity = self.route_stream_maturity();
        let early_continuity = self.route_early_continuity();
        let run_pressure = self.current_basin_run.saturating_sub(1) as f32;
        let continuation = AUDIO_STYLE_STREAM_CONTINUATION_STRENGTH
            * (AUDIO_STYLE_STREAM_CONTINUATION_QUALITY_STRENGTH * quality_margin
                + AUDIO_STYLE_STREAM_CONTINUATION_LOW_QUALITY_STRENGTH
                    * quality_floor
                    * early_continuity.max(1.0 - maturity)
                + AUDIO_STYLE_STREAM_CONTINUATION_SUPPORT_STRENGTH * field_support
                + AUDIO_STYLE_ROUTE_EARLY_CONTINUITY_STRENGTH * early_continuity
                - AUDIO_STYLE_STREAM_CONTINUATION_FATIGUE_STRENGTH * evidence * maturity * fatigue
                - AUDIO_STYLE_STREAM_CONTINUATION_OVERUSE_STRENGTH * evidence * maturity * overuse
                - AUDIO_STYLE_STREAM_CONTINUATION_RUN_STRENGTH * maturity * run_pressure.ln_1p());

        let gate = continuation.clamp(-3.2, 3.2).exp().clamp(0.04, 12.0);
        if quality_margin < 0.0 {
            let relative_loss_gate = (AUDIO_STYLE_STREAM_CONTINUATION_RELATIVE_LOSS_STRENGTH
                * quality_margin)
                .exp()
                .clamp(0.06, 1.0);
            return gate.min(relative_loss_gate);
        }
        if quality_floor < 0.0 {
            let low_quality_gate = (AUDIO_STYLE_STREAM_CONTINUATION_LOW_QUALITY_STRENGTH
                * quality_floor)
                .exp()
                .clamp(0.12, 1.0);
            return gate.min(low_quality_gate);
        }
        gate
    }

    fn alternative_route_gate_for_basin(
        &self,
        current_basin: &PlaybackAttractorBasinKey,
        candidate_basin: &PlaybackAttractorBasinKey,
        candidate_basins: &[Option<PlaybackAttractorBasinKey>],
        candidate_similarities: &[f32],
        candidate_quality: f32,
    ) -> f32 {
        let current_quality =
            best_quality_for_basin(current_basin, candidate_basins, candidate_similarities);
        let candidate_support = candidate_basins
            .iter()
            .filter(|basin| basin.as_ref() == Some(candidate_basin))
            .count() as f32
            / candidate_basins.len().max(1) as f32;
        let quality_margin = (candidate_quality - current_quality
            + AUDIO_STYLE_STREAM_CONTINUATION_MARGIN)
            .clamp(-1.0, 1.0);
        let field_support = ((candidate_support - AUDIO_STYLE_STREAM_CONTINUATION_SUPPORT_NEUTRAL)
            / (1.0 - AUDIO_STYLE_STREAM_CONTINUATION_SUPPORT_NEUTRAL).max(1.0e-6))
        .clamp(-1.0, 1.0);
        let current_fatigue =
            (self.fatigue.get(current_basin).copied().unwrap_or(0.0) - 1.0).max(0.0);
        let current_overuse = (self.usage_share(current_basin)
            - self.target_share.get(current_basin).copied().unwrap_or(0.0))
        .max(0.0);
        let candidate_underuse = (self
            .target_share
            .get(candidate_basin)
            .copied()
            .unwrap_or(0.0)
            - self.usage_share(candidate_basin))
        .max(0.0);
        let candidate_fatigue =
            (self.fatigue.get(candidate_basin).copied().unwrap_or(0.0) - 0.5).max(0.0);
        let evidence = self.route_evidence_confidence();
        let maturity = self.route_stream_maturity();
        let run_pressure = self.current_basin_run.saturating_sub(1) as f32;
        let escape_readiness = (maturity
            * evidence
            * (0.28 * current_fatigue
                + 2.40 * current_overuse
                + 0.42 * run_pressure.ln_1p()
                + 0.50 * candidate_underuse))
            .clamp(0.0, 1.25);
        let quality_drive = if quality_margin > 0.0 {
            quality_margin * escape_readiness.min(1.0)
        } else {
            quality_margin
        };
        let route = AUDIO_STYLE_STREAM_CONTINUATION_STRENGTH
            * (AUDIO_STYLE_STREAM_CONTINUATION_QUALITY_STRENGTH * quality_drive
                + AUDIO_STYLE_STREAM_CONTINUATION_SUPPORT_STRENGTH
                    * field_support
                    * escape_readiness
                + AUDIO_STYLE_STREAM_CONTINUATION_FATIGUE_STRENGTH
                    * evidence
                    * maturity
                    * current_fatigue
                + AUDIO_STYLE_STREAM_CONTINUATION_OVERUSE_STRENGTH
                    * evidence
                    * maturity
                    * current_overuse
                + AUDIO_STYLE_STREAM_CONTINUATION_RUN_STRENGTH * maturity * run_pressure.ln_1p()
                + AUDIO_STYLE_ROUTE_ALTERNATIVE_UNDERUSE_STRENGTH * candidate_underuse
                - AUDIO_STYLE_ROUTE_ALTERNATIVE_FATIGUE_STRENGTH * candidate_fatigue
                - AUDIO_STYLE_ROUTE_ALTERNATIVE_SWITCH_INERTIA * (1.0 - escape_readiness.min(1.0)));

        route.clamp(-2.6, 2.8).exp().clamp(0.06, 16.0)
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

    fn route_evidence_confidence(&self) -> f32 {
        let history_evidence = ((self.recent_evidence_count as f32
            - AUDIO_STYLE_ROUTE_EVIDENCE_WARMUP_OFFSET)
            / AUDIO_STYLE_ROUTE_EVIDENCE_WARMUP_WIDTH.max(1.0e-6))
        .clamp(0.0, 1.0);
        history_evidence.max(self.route_stream_maturity())
    }

    fn route_stream_maturity(&self) -> f32 {
        ((self.current_basin_run as f32 - AUDIO_STYLE_ROUTE_STREAM_MATURITY_START)
            / AUDIO_STYLE_ROUTE_STREAM_MATURITY_WIDTH.max(1.0e-6))
        .clamp(0.0, 1.0)
    }

    fn route_early_continuity(&self) -> f32 {
        if self.current_basin_run < 2 {
            return 0.0;
        }
        ((3.0 - self.current_basin_run as f32) / 2.0).clamp(0.0, 1.0)
    }
}

fn best_quality_for_basin(
    target_basin: &PlaybackAttractorBasinKey,
    candidate_basins: &[Option<PlaybackAttractorBasinKey>],
    candidate_similarities: &[f32],
) -> f32 {
    candidate_basins
        .iter()
        .zip(candidate_similarities.iter().copied())
        .filter(|(basin, similarity)| {
            basin.as_ref() == Some(target_basin) && similarity.is_finite()
        })
        .map(|(_, similarity)| similarity)
        .fold(-1.0_f32, f32::max)
}

fn candidate_topology_pressure<R: PlaybackBasinResolver + Copy>(
    candidates: &[PlaybackTrack],
    basin_resolver: R,
    target_share: &HashMap<PlaybackAttractorBasinKey, f32>,
) -> HashMap<PlaybackAttractorBasinKey, f32> {
    let mut counts = HashMap::<PlaybackAttractorBasinKey, usize>::new();
    for candidate in candidates {
        let Some(basin) = basin_resolver.basin_for_track(candidate) else {
            continue;
        };
        *counts.entry(basin).or_insert(0) += 1;
    }
    let total = counts.values().map(|count| *count as f32).sum::<f32>();
    if total <= 0.0 || !total.is_finite() {
        return HashMap::new();
    }

    counts
        .into_iter()
        .filter_map(|(basin, count)| {
            let share = count as f32 / total;
            let target = target_share.get(&basin).copied().unwrap_or(0.0);
            let excess = (share - target).max(0.0);
            if excess <= 0.0 || !excess.is_finite() {
                return None;
            }
            Some((
                basin,
                (excess * AUDIO_STYLE_BIO_ROUTE_TOPOLOGY_TOP_FATIGUE_CAP * 3.0)
                    .min(AUDIO_STYLE_BIO_ROUTE_TOPOLOGY_TOP_FATIGUE_CAP),
            ))
        })
        .collect()
}

fn decay_attractor_basin_map(map: &mut HashMap<PlaybackAttractorBasinKey, f32>, decay: f32) {
    map.retain(|_, value| {
        *value *= decay;
        value.is_finite() && *value > 1.0e-6
    });
}

fn basin_target_share<R: PlaybackBasinResolver + Copy>(
    candidates: &[PlaybackTrack],
    basin_resolver: R,
) -> HashMap<PlaybackAttractorBasinKey, f32> {
    let mut counts = HashMap::<PlaybackAttractorBasinKey, usize>::new();
    for candidate in candidates {
        let Some(basin) = basin_resolver.basin_for_track(candidate) else {
            continue;
        };
        *counts.entry(basin).or_insert(0) += 1;
    }
    let count_total = counts.values().map(|count| *count as f32).sum::<f32>();
    let root_total = counts
        .values()
        .map(|count| (*count as f32).sqrt())
        .sum::<f32>();
    if count_total <= 0.0
        || !count_total.is_finite()
        || root_total <= 0.0
        || !root_total.is_finite()
    {
        return HashMap::new();
    }
    counts
        .into_iter()
        .map(|(basin, count)| {
            let count_share = count as f32 / count_total;
            let root_share = (count as f32).sqrt() / root_total;
            (
                basin,
                AUDIO_STYLE_BASIN_TARGET_COUNT_SHARE_WEIGHT * count_share
                    + AUDIO_STYLE_BASIN_TARGET_ROOT_SHARE_WEIGHT * root_share,
            )
        })
        .collect()
}

fn audio_style_candidate_diagnostics(
    candidates: &[PlaybackTrack],
    embeddings: &AudioStyleEmbeddingMap,
    anchor_key: &PlaybackTrackKey,
    similarities: &[Option<f32>],
    selected_index: Option<usize>,
    basin_resolver: AudioStyleBasinResolver<'_>,
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

        let Some(basin) = basin_resolver.basin_for_track(candidate) else {
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
            .and_then(|candidate| basin_resolver.basin_for_track(candidate))
            .map(|basin| basin.value),
        top_candidate_basins,
        bio_route: None,
        perceptual_channels: None,
        topology_health: None,
    }
}

fn balance_audio_style_candidate_field_for_anchor(
    anchor: &PlaybackTrack,
    candidates: Vec<PlaybackTrack>,
    target_count: usize,
    embeddings: &AudioStyleEmbeddingMap,
    sampling_geometry: Option<&AudioStyleSamplingGeometry>,
) -> Vec<PlaybackTrack> {
    if target_count == 0 || candidates.len() <= target_count {
        return candidates;
    }
    let Some(geometry) = sampling_geometry else {
        return candidates.into_iter().take(target_count).collect();
    };
    let anchor_key = PlaybackTrackKey::from_track(anchor);
    let Some(anchor_embedding) = embeddings.get(&anchor_key) else {
        return balance_centerless_audio_style_candidate_field(candidates, target_count, geometry);
    };

    let scored = candidates
        .into_iter()
        .enumerate()
        .filter_map(|(index, track)| {
            let key = PlaybackTrackKey::from_track(&track);
            let embedding = embeddings.get(&key)?;
            let basin = geometry.self_supervised_basin_for_track(&track)?;
            let similarity = geometry
                .corrected_similarity_for_embeddings(&anchor_key, &key, anchor_embedding, embedding)
                .unwrap_or(-1.0);
            Some(AudioStyleCandidateFieldItem {
                index,
                track,
                basin,
                score: similarity,
            })
        })
        .collect::<Vec<_>>();
    if scored.len() <= target_count {
        return scored.into_iter().map(|item| item.track).collect();
    }

    balance_audio_style_candidate_field_items(scored, target_count)
}

fn balance_centerless_audio_style_candidate_field(
    candidates: Vec<PlaybackTrack>,
    target_count: usize,
    geometry: &AudioStyleSamplingGeometry,
) -> Vec<PlaybackTrack> {
    let scored = candidates
        .into_iter()
        .enumerate()
        .filter_map(|(index, track)| {
            let basin = geometry.self_supervised_basin_for_track(&track)?;
            Some(AudioStyleCandidateFieldItem {
                index,
                track,
                basin,
                score: 0.0,
            })
        })
        .collect::<Vec<_>>();
    if scored.len() <= target_count {
        return scored.into_iter().map(|item| item.track).collect();
    }
    balance_audio_style_candidate_field_items(scored, target_count)
}

#[derive(Clone)]
struct AudioStyleCandidateFieldItem {
    index: usize,
    track: PlaybackTrack,
    basin: PlaybackAttractorBasinKey,
    score: f32,
}

fn balance_audio_style_candidate_field_items(
    mut items: Vec<AudioStyleCandidateFieldItem>,
    target_count: usize,
) -> Vec<PlaybackTrack> {
    if target_count == 0 {
        return vec![];
    }
    if items.len() <= target_count {
        return items.into_iter().map(|item| item.track).collect();
    }

    items.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.index.cmp(&right.index))
    });

    let mut basin_sizes = HashMap::<PlaybackAttractorBasinKey, usize>::new();
    let mut basin_quality = HashMap::<PlaybackAttractorBasinKey, f32>::new();
    for item in &items {
        *basin_sizes.entry(item.basin.clone()).or_insert(0) += 1;
        basin_quality
            .entry(item.basin.clone())
            .or_insert(item.score);
    }

    let active_basin_count = basin_sizes
        .len()
        .max(AUDIO_STYLE_CANDIDATE_FIELD_MIN_ACTIVE_BASINS);
    let basin_capacity = (((target_count as f32 / active_basin_count.max(1) as f32)
        * AUDIO_STYLE_CANDIDATE_FIELD_CAPACITY_MULTIPLIER)
        .ceil() as usize)
        .clamp(
            AUDIO_STYLE_CANDIDATE_FIELD_MIN_BASIN_CAPACITY,
            AUDIO_STYLE_CANDIDATE_FIELD_MAX_BASIN_CAPACITY,
        );
    let reserve_count = ((target_count as f32 * AUDIO_STYLE_CANDIDATE_FIELD_RESERVE_FRACTION)
        .round() as usize)
        .min(target_count / 4);
    let quota_target = target_count.saturating_sub(reserve_count).max(1);

    let mut basins = basin_sizes.keys().cloned().collect::<Vec<_>>();
    basins.sort_by(|left, right| {
        let left_quality = basin_quality.get(left).copied().unwrap_or(-1.0);
        let right_quality = basin_quality.get(right).copied().unwrap_or(-1.0);
        right_quality
            .partial_cmp(&left_quality)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                basin_sizes
                    .get(right)
                    .copied()
                    .unwrap_or(0)
                    .cmp(&basin_sizes.get(left).copied().unwrap_or(0))
            })
            .then_with(|| left.value.cmp(&right.value))
    });

    let mut quotas = HashMap::<PlaybackAttractorBasinKey, usize>::new();
    for basin in &basins {
        quotas.insert(
            basin.clone(),
            1.min(basin_sizes.get(basin).copied().unwrap_or(0)),
        );
    }
    let mut allocated = quotas.values().copied().sum::<usize>();
    while allocated < quota_target {
        let mut changed = false;
        for basin in &basins {
            if allocated >= quota_target {
                break;
            }
            let available = basin_sizes.get(basin).copied().unwrap_or(0);
            let current = quotas.get(basin).copied().unwrap_or(0);
            if current >= available || current >= basin_capacity {
                continue;
            }
            quotas.insert(basin.clone(), current + 1);
            allocated += 1;
            changed = true;
        }
        if !changed {
            break;
        }
    }

    let mut selected = Vec::with_capacity(target_count);
    let mut used = HashSet::<usize>::new();
    let mut selected_per_basin = HashMap::<PlaybackAttractorBasinKey, usize>::new();
    for item in &items {
        let quota = quotas.get(&item.basin).copied().unwrap_or(0);
        let used_for_basin = selected_per_basin.get(&item.basin).copied().unwrap_or(0);
        if used_for_basin >= quota {
            continue;
        }
        selected.push(item.clone());
        used.insert(item.index);
        selected_per_basin.insert(item.basin.clone(), used_for_basin + 1);
        if selected.len() >= quota_target {
            break;
        }
    }

    for item in &items {
        if selected.len() >= target_count {
            break;
        }
        if used.insert(item.index) {
            selected.push(item.clone());
        }
    }

    selected.sort_by_key(|item| item.index);
    selected.into_iter().map(|item| item.track).collect()
}

#[cfg(test)]
pub(crate) fn balance_audio_style_candidate_field_basins_for_test(
    basins: impl IntoIterator<Item = (&'static str, f32)>,
    target_count: usize,
) -> Vec<String> {
    let items = basins
        .into_iter()
        .enumerate()
        .map(|(index, (basin, score))| AudioStyleCandidateFieldItem {
            index,
            track: track_for_test_candidate_field_basin(basin, index),
            basin: PlaybackAttractorBasinKey {
                value: basin.to_string(),
            },
            score,
        })
        .collect::<Vec<_>>();
    balance_audio_style_candidate_field_items(items, target_count)
        .into_iter()
        .filter_map(|track| PlaybackAttractorBasinKey::fallback_from_track(&track))
        .map(|basin| basin.value)
        .collect()
}

#[cfg(test)]
fn track_for_test_candidate_field_basin(basin: &str, index: usize) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: format!("candidate_{index}"),
        canonical_music_id: format!("source:https://example.com/{basin}/{index}:0:60000"),
        music_url: format!("https://example.com/{basin}/{index}"),
        file_path: PathBuf::from(format!("youtube/{basin}/candidate_{index}.m4a")),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    }
}

impl AudioStylePerceptualChannelDecision {
    fn from_candidates(
        candidates: &[PlaybackTrack],
        anchor_key: &PlaybackTrackKey,
        embeddings: &AudioStyleEmbeddingMap,
        geometry: &AudioStyleSamplingGeometry,
        basin_resolver: AudioStyleBasinResolver<'_>,
    ) -> Self {
        let Some(anchor_embedding) = embeddings.get(anchor_key) else {
            return Self {
                similarities: vec![None; candidates.len()],
                diagnostics: vec![None; candidates.len()],
            };
        };
        let candidate_basin_target_share =
            audio_style_candidate_basin_target_share(candidates, basin_resolver);
        let mut similarities = Vec::with_capacity(candidates.len());
        let mut diagnostics = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let key = PlaybackTrackKey::from_track(candidate);
            let Some(candidate_embedding) = embeddings.get(&key) else {
                similarities.push(None);
                diagnostics.push(None);
                continue;
            };
            let terminal_similarity = audio_style_channel_cosine(
                anchor_embedding,
                candidate_embedding,
                &geometry.mean,
                AUDIO_STYLE_TYPED_CHANNEL_TERMINAL_RANGE,
            )
            .unwrap_or(-1.0);
            let flow_similarity = audio_style_channel_cosine(
                anchor_embedding,
                candidate_embedding,
                &geometry.mean,
                AUDIO_STYLE_TYPED_CHANNEL_FLOW_RANGE,
            )
            .unwrap_or(-1.0);
            let transition_similarity = audio_style_channel_cosine(
                anchor_embedding,
                candidate_embedding,
                &geometry.mean,
                AUDIO_STYLE_TYPED_CHANNEL_TRANSITION_RANGE,
            )
            .unwrap_or(-1.0);
            let values = [terminal_similarity, flow_similarity, transition_similarity];
            let consensus = values
                .iter()
                .copied()
                .fold(f32::INFINITY, f32::min)
                .clamp(-1.0, 1.0);
            let mean = values.iter().copied().sum::<f32>() / values.len() as f32;
            let disagreement =
                values.iter().map(|value| (value - mean).abs()).sum::<f32>() / values.len() as f32;
            let active_challenger_axis_count = values
                .iter()
                .filter(|value| value.is_finite() && **value >= mean + 0.05)
                .count();
            let candidate_similarity = geometry
                .corrected_similarity(embeddings, anchor_key, &key)
                .filter(|similarity| similarity.is_finite())
                .unwrap_or(-1.0);
            let topology_support = basin_resolver
                .basin_for_track(candidate)
                .and_then(|basin| candidate_basin_target_share.get(&basin).copied())
                .map(|share| (share * candidates.len() as f32).sqrt().clamp(0.0, 1.0))
                .unwrap_or(0.5);
            let topology_gate = (1.0
                + AUDIO_STYLE_TYPED_CHANNEL_CONSENSUS_STRENGTH * consensus.max(0.0)
                + 0.18 * topology_support
                - AUDIO_STYLE_TYPED_CHANNEL_DISAGREEMENT_STRENGTH * disagreement.max(0.0))
            .clamp(AUDIO_STYLE_TYPED_CHANNEL_TOPOLOGY_FLOOR, 1.85);
            let similarity = candidate_similarity.clamp(-1.0, 1.0);
            similarities.push(Some(similarity));
            diagnostics.push(Some(AudioStylePerceptualChannelDiagnostics {
                terminal_similarity,
                flow_similarity,
                transition_similarity,
                consensus,
                disagreement,
                topology_gate,
                active_challenger_axis_count,
            }));
        }

        Self {
            similarities,
            diagnostics,
        }
    }
}

impl AudioStyleCandidateSupport {
    fn from_anchored_candidates(
        candidates: &[PlaybackTrack],
        anchor_key: &PlaybackTrackKey,
        embeddings: &AudioStyleEmbeddingMap,
        geometry: &AudioStyleSamplingGeometry,
        basin_resolver: AudioStyleBasinResolver<'_>,
    ) -> Self {
        let perceptual_channels = AudioStylePerceptualChannelDecision::from_candidates(
            candidates,
            anchor_key,
            embeddings,
            geometry,
            basin_resolver,
        );
        let similarities = perceptual_channels.similarities;
        let weights = audio_style_distance_softmin_weights(candidates, &similarities, &[]);
        Self {
            weights: normalize_positive_weights(weights),
            similarities,
            diagnostics: perceptual_channels.diagnostics,
        }
    }

    fn from_centerless_candidates(
        candidates: &[PlaybackTrack],
        embeddings: &AudioStyleEmbeddingMap,
        geometry: &AudioStyleSamplingGeometry,
    ) -> Self {
        let similarities =
            audio_style_centerless_candidate_scores(candidates, embeddings, geometry);
        let diagnostics = candidates
            .iter()
            .map(|candidate| {
                let key = PlaybackTrackKey::from_track(candidate);
                let embedding = embeddings.get(&key)?;
                let load = audio_style_listener_load_from_embedding(embedding.as_ref());
                Some(AudioStylePerceptualChannelDiagnostics {
                    terminal_similarity: 1.0 - (load[0] - 0.5).abs() * 2.0,
                    flow_similarity: 1.0 - (load[2] - 0.5).abs() * 2.0,
                    transition_similarity: 1.0 - (load[5] - 0.5).abs() * 2.0,
                    consensus: 0.0,
                    disagreement: 0.0,
                    topology_gate: 1.0,
                    active_challenger_axis_count: 0,
                })
            })
            .collect::<Vec<_>>();
        let weights = audio_style_distance_softmin_weights(candidates, &similarities, &[]);
        Self {
            weights: normalize_positive_weights(weights),
            similarities,
            diagnostics,
        }
    }

    fn has_support(&self) -> bool {
        self.weights
            .iter()
            .any(|weight| weight.is_finite() && *weight > 0.0)
    }
}

impl AudioStyleControlGateDecision {
    fn from_support(
        support: &AudioStyleCandidateSupport,
        basin_pressure: &PlaybackAttractorBasinPressure,
        source_basin_pressure: &PlaybackAttractorBasinPressure,
    ) -> Self {
        let scalar_similarities = support
            .similarities
            .iter()
            .map(|similarity| {
                similarity
                    .filter(|value| value.is_finite())
                    .unwrap_or(-1.0)
                    .clamp(-1.0, 1.0)
            })
            .collect::<Vec<_>>();
        let typed_continuity_scores =
            audio_style_typed_continuity_scores(&scalar_similarities, &support.diagnostics);
        let semantic_gate = audio_style_semantic_continuity_gate(
            &typed_continuity_scores,
            basin_pressure,
            source_basin_pressure,
        );
        let gates = support
            .diagnostics
            .iter()
            .enumerate()
            .map(|(index, diagnostic)| {
                let topology_gate = diagnostic
                    .map(|value| value.topology_gate)
                    .unwrap_or(1.0)
                    .clamp(AUDIO_STYLE_TYPED_CHANNEL_TOPOLOGY_FLOOR, 1.85);
                let semantic = semantic_gate.get(index).copied().unwrap_or(1.0);
                (topology_gate * semantic).clamp(0.05, 2.25)
            })
            .collect();
        Self {
            gates,
            semantic_gates: semantic_gate,
        }
    }
}

impl AudioStyleRouteFieldDecision {
    fn from_recent_history(
        candidates: &[PlaybackTrack],
        anchor_key: &PlaybackTrackKey,
        basin_pressure: &PlaybackAttractorBasinPressure,
        embeddings: &AudioStyleEmbeddingMap,
        geometry: &AudioStyleSamplingGeometry,
        recently_played_tracks: &[PlaybackTrack],
        basin_resolver: AudioStyleBasinResolver<'_>,
    ) -> Self {
        let Some(anchor_embedding) = embeddings.get(anchor_key) else {
            return Self {
                gates: vec![1.0; candidates.len()],
            };
        };
        let Some(previous_embedding) = recently_played_tracks
            .iter()
            .rev()
            .filter_map(|track| embeddings.get(&PlaybackTrackKey::from_track(track)))
            .find(|embedding| !Arc::ptr_eq(embedding, anchor_embedding))
        else {
            return Self {
                gates: vec![1.0; candidates.len()],
            };
        };
        let Some(route_axis) = audio_style_route_velocity_axis(
            previous_embedding.as_ref(),
            anchor_embedding.as_ref(),
            &geometry.mean,
        ) else {
            return Self {
                gates: vec![1.0; candidates.len()],
            };
        };

        let gates = candidates
            .iter()
            .map(|candidate| {
                let Some(current_basin) = basin_pressure.current_basin.as_ref() else {
                    return 1.0;
                };
                if basin_resolver.basin_for_track(candidate).as_ref() != Some(current_basin) {
                    return 1.0;
                }
                let key = PlaybackTrackKey::from_track(candidate);
                let Some(candidate_embedding) = embeddings.get(&key) else {
                    return 1.0;
                };
                let alignment = audio_style_route_candidate_alignment(
                    anchor_embedding.as_ref(),
                    candidate_embedding.as_ref(),
                    &geometry.mean,
                    &route_axis,
                )
                .unwrap_or(0.0);
                (AUDIO_STYLE_ROUTE_TRAJECTORY_STRENGTH * alignment)
                    .clamp(-0.90, 0.90)
                    .exp()
                    .clamp(0.40, 2.45)
            })
            .collect();

        Self { gates }
    }
}

impl AudioStyleManifoldFieldDecision {
    fn from_support(
        candidates: &[PlaybackTrack],
        anchor_key: &PlaybackTrackKey,
        support: &AudioStyleCandidateSupport,
        geometry: &AudioStyleSamplingGeometry,
        basin_pressure: &PlaybackAttractorBasinPressure,
        basin_resolver: AudioStyleBasinResolver<'_>,
    ) -> Self {
        let Some(anchor_manifold) = geometry.manifold_for_key(anchor_key) else {
            return Self {
                stream_gates: vec![1.0; candidates.len()],
                route_caps: vec![1.0; candidates.len()],
            };
        };
        let Some(current_basin) = basin_pressure.current_basin.as_ref() else {
            return Self {
                stream_gates: vec![1.0; candidates.len()],
                route_caps: vec![1.0; candidates.len()],
            };
        };

        let capacity = audio_style_manifold_residence_capacity(anchor_manifold);
        let maturity = ((basin_pressure.current_basin_run.saturating_sub(1) as f32) / capacity)
            .clamp(0.0, 1.0);
        let current_overuse = basin_pressure.usage_share(current_basin);
        let escape_pressure = (maturity
            * (0.42 * (anchor_manifold.boundary_pressure * 1.35).clamp(0.0, 1.0)
                + 0.34 * anchor_manifold.curvature.clamp(0.0, 1.0)
                + 0.24 * (current_overuse * 5.0).clamp(0.0, 1.0)))
        .clamp(0.0, 1.0);

        let decisions: Vec<(f32, f32)> = candidates
            .iter()
            .enumerate()
            .map(|(index, candidate)| {
                let key = PlaybackTrackKey::from_track(candidate);
                let candidate_manifold = geometry.manifold_for_key(&key).unwrap_or(anchor_manifold);
                let Some(candidate_basin) = basin_resolver.basin_for_track(candidate) else {
                    return (1.0, 1.0);
                };
                let same_basin = &candidate_basin == current_basin;
                let rank_support = (candidate_manifold.spectral_rank.max(1.0).sqrt()
                    * AUDIO_STYLE_MANIFOLD_RESIDENCE_RANK_SCALE)
                    .clamp(0.0, 1.0);
                let density_delta = (geometry.local_density.get(&key).copied().unwrap_or(0.0)
                    - geometry
                        .local_density
                        .get(anchor_key)
                        .copied()
                        .unwrap_or(0.0))
                .max(0.0);
                let curvature_penalty =
                    (candidate_manifold.curvature - anchor_manifold.curvature).max(0.0);
                let continuity = support
                    .similarities
                    .get(index)
                    .and_then(|value| *value)
                    .unwrap_or(-1.0)
                    .clamp(-1.0, 1.0);
                let capture_quality = ((continuity - AUDIO_STYLE_SEMANTIC_CONTINUITY_FLOOR)
                    / (1.0 - AUDIO_STYLE_SEMANTIC_CONTINUITY_FLOOR).max(1.0e-6))
                .clamp(0.0, 1.0);

                if same_basin {
                    let stream_drive = AUDIO_STYLE_MANIFOLD_CONTINUITY_STRENGTH
                        * (1.0 - escape_pressure)
                        * rank_support
                        - AUDIO_STYLE_MANIFOLD_ESCAPE_STRENGTH * escape_pressure
                        - 0.34 * density_delta
                        - 0.22 * curvature_penalty;
                    (stream_drive.clamp(-2.20, 1.10).exp().clamp(0.08, 3.00), 1.0)
                } else {
                    let low_quality_cap = if capture_quality < 0.20 {
                        (0.12 + 2.20 * capture_quality.powi(2)).clamp(0.08, 0.52)
                    } else {
                        1.0
                    };
                    (1.0, low_quality_cap)
                }
            })
            .collect();

        let (stream_gates, route_caps) = decisions.into_iter().unzip();
        Self {
            stream_gates,
            route_caps,
        }
    }
}

impl AudioStyleFutureOccupancyReachabilityDecision {
    fn from_support(
        candidates: &[PlaybackTrack],
        support: &AudioStyleCandidateSupport,
        geometry: &AudioStyleSamplingGeometry,
        basin_pressure: &PlaybackAttractorBasinPressure,
        basin_resolver: AudioStyleBasinResolver<'_>,
    ) -> Self {
        if candidates.is_empty() {
            return Self { gates: Vec::new() };
        }

        let denom = candidates.len().saturating_sub(1).max(1) as f32;
        let mut raw_scores = candidates
            .iter()
            .enumerate()
            .map(|(index, candidate)| {
                let key = PlaybackTrackKey::from_track(candidate);
                let descriptor = geometry.future_occupancy_for_key(&key).unwrap_or(
                    AudioStyleFutureOccupancyDescriptor {
                        reachability: 0.0,
                        future_entropy: 0.0,
                        same_basin_neighbor_share: 1.0,
                    },
                );
                let manifold_load = geometry
                    .manifold_for_key(&key)
                    .map(|manifold| {
                        0.38 * manifold.boundary_pressure.clamp(0.0, 1.0)
                            + 0.32 * manifold.curvature.clamp(0.0, 1.0)
                            + 0.30 / manifold.spectral_rank.max(1.0).sqrt()
                    })
                    .unwrap_or(0.30);
                let rank_position = index as f32 / denom;
                let continuity_band =
                    (1.0 - ((rank_position - 0.64) / 0.42).powi(2)).clamp(-1.0, 1.0);
                let semantic_continuity = support
                    .similarities
                    .get(index)
                    .and_then(|value| *value)
                    .unwrap_or(0.0)
                    .clamp(-1.0, 1.0);
                let semantic_viability = ((semantic_continuity
                    - AUDIO_STYLE_SEMANTIC_CONTINUITY_FLOOR)
                    / (1.0 - AUDIO_STYLE_SEMANTIC_CONTINUITY_FLOOR).max(1.0e-6))
                .clamp(0.0, 1.0);
                let same_basin_run_penalty = basin_resolver
                    .basin_for_track(candidate)
                    .and_then(|candidate_basin| {
                        basin_pressure
                            .current_basin
                            .as_ref()
                            .filter(|current_basin| **current_basin == candidate_basin)
                    })
                    .map(|_| {
                        AUDIO_STYLE_FUTURE_OCCUPANCY_SAME_BASIN_RUN_STRENGTH
                            * (basin_pressure.current_basin_run.max(1) as f32).ln_1p()
                            * descriptor.same_basin_neighbor_share
                    })
                    .unwrap_or(0.0);

                AUDIO_STYLE_FUTURE_OCCUPANCY_REACHABILITY_STRENGTH
                    * (descriptor.reachability - 0.60)
                    + AUDIO_STYLE_FUTURE_OCCUPANCY_ENTROPY_STRENGTH
                        * (descriptor.future_entropy - 0.50)
                    + AUDIO_STYLE_FUTURE_OCCUPANCY_CONTINUITY_BAND_STRENGTH
                        * continuity_band
                        * semantic_viability
                    - AUDIO_STYLE_FUTURE_OCCUPANCY_MANIFOLD_LOAD_STRENGTH * manifold_load
                    - same_basin_run_penalty
            })
            .collect::<Vec<_>>();

        let center = if raw_scores.is_empty() {
            0.0
        } else {
            raw_scores.iter().copied().sum::<f32>() / raw_scores.len() as f32
        };
        let gates = raw_scores
            .drain(..)
            .map(|score| (score - center).clamp(-1.20, 1.10).exp().clamp(0.22, 3.00))
            .collect();

        Self { gates }
    }
}

impl AudioStyleProgrammaticRouteDecision {
    fn from_support(
        candidates: &[PlaybackTrack],
        support: &AudioStyleCandidateSupport,
        basin_pressure: &PlaybackAttractorBasinPressure,
        source_basin_pressure: &PlaybackAttractorBasinPressure,
        recently_played_tracks: &[PlaybackTrack],
        basin_resolver: AudioStyleBasinResolver<'_>,
    ) -> Self {
        if candidates.is_empty() {
            return Self {
                gates: Vec::new(),
                novelty_gates: Vec::new(),
            };
        }

        let novelty_values = support
            .similarities
            .iter()
            .filter_map(|similarity| similarity.filter(|value| value.is_finite()))
            .map(|continuity| ((1.0 - continuity.clamp(-1.0, 1.0)) * 0.5).clamp(0.0, 1.0))
            .collect::<Vec<_>>();
        let distance_band = audio_style_programmatic_adaptive_distance_band(&novelty_values);
        let distance_phase =
            audio_style_programmatic_distance_phase(basin_pressure, source_basin_pressure);
        let recent_keys = recently_played_tracks
            .iter()
            .rev()
            .take(AUDIO_STYLE_ROUTE_RECENT_WINDOW)
            .map(PlaybackTrackKey::from_track)
            .collect::<HashSet<_>>();
        let has_unvisited_candidate = candidates
            .iter()
            .any(|candidate| !recent_keys.contains(&PlaybackTrackKey::from_track(candidate)));
        let recent_window_basins = recently_played_tracks
            .iter()
            .rev()
            .take(AUDIO_STYLE_PROGRAMMATIC_ROUTE_CAPACITY_WINDOW)
            .filter_map(|track| basin_resolver.basin_for_track(track))
            .collect::<Vec<_>>();
        let recent_window_counts = basin_counts_from_keys(recent_window_basins.iter().cloned());
        let route_support_share =
            route_epoch_support_share(candidates, recently_played_tracks, basin_resolver);
        let remaining_share =
            remaining_candidate_basin_share(candidates, &recent_keys, basin_resolver);
        let dominant_remaining = dominant_remaining_basin(&remaining_share, &route_support_share);
        let source_resolver = PlaybackSourceBasinResolver;
        let mut novelty_gates = Vec::with_capacity(candidates.len());
        let scores = candidates
            .iter()
            .enumerate()
            .map(|(index, candidate)| {
                let continuity = support
                    .similarities
                    .get(index)
                    .and_then(|value| *value)
                    .unwrap_or(-1.0)
                    .clamp(-1.0, 1.0);
                let novelty = ((1.0 - continuity) * 0.5).clamp(0.0, 1.0);
                let novelty_score = distance_band
                    .map(|band| audio_style_programmatic_inverted_u_score(novelty, band))
                    .unwrap_or(0.0);
                let novelty_gate = distance_band
                    .map(|_| audio_style_programmatic_novelty_gate(novelty_score))
                    .unwrap_or(1.0);
                novelty_gates.push(novelty_gate);
                let mut score = match distance_phase {
                    AudioStyleProgrammaticDistancePhase::Continue => {
                        AUDIO_STYLE_PROGRAMMATIC_CONTINUE_NOVELTY_STRENGTH * novelty_score
                    }
                    AudioStyleProgrammaticDistancePhase::Shift => {
                        AUDIO_STYLE_PROGRAMMATIC_SHIFT_NOVELTY_STRENGTH * novelty_score
                    }
                };

                if has_unvisited_candidate
                    && !recent_keys.contains(&PlaybackTrackKey::from_track(candidate))
                {
                    score += AUDIO_STYLE_PROGRAMMATIC_COVERAGE_BONUS;
                }

                if let Some(basin) = basin_resolver.basin_for_track(candidate) {
                    let same_basin = basin_pressure.current_basin.as_ref() == Some(&basin);
                    match distance_phase {
                        AudioStyleProgrammaticDistancePhase::Continue if same_basin => {
                            score += AUDIO_STYLE_PROGRAMMATIC_CONTINUE_SAME_BASIN_BONUS;
                        }
                        AudioStyleProgrammaticDistancePhase::Shift if same_basin => {
                            score -= AUDIO_STYLE_PROGRAMMATIC_SHIFT_SAME_BASIN_PENALTY;
                        }
                        _ => {}
                    }
                    let target = basin_pressure
                        .target_share
                        .get(&basin)
                        .copied()
                        .unwrap_or(0.0);
                    let usage = basin_pressure.usage_share(&basin);
                    score +=
                        AUDIO_STYLE_PROGRAMMATIC_MASS_DEFICIT_STRENGTH * (target - usage).max(0.0);
                    score -=
                        AUDIO_STYLE_PROGRAMMATIC_MASS_OVERUSE_STRENGTH * (usage - target).max(0.0);

                    let support = route_support_share
                        .get(&basin)
                        .copied()
                        .unwrap_or(target)
                        .clamp(0.0, 1.0);
                    score -= AUDIO_STYLE_PROGRAMMATIC_WINDOW_CAPACITY_STRENGTH
                        * projected_route_capacity_violation(
                            &recent_window_counts,
                            recent_window_basins.len(),
                            &basin,
                            support,
                        );
                    if let Some((dominant_basin, pressure)) = dominant_remaining.as_ref() {
                        let current_basin = basin_pressure.current_basin.as_ref();
                        if &basin == dominant_basin && current_basin != Some(dominant_basin) {
                            score += AUDIO_STYLE_PROGRAMMATIC_FUTURE_REBALANCE_STRENGTH
                                * (0.75 + *pressure);
                        } else if &basin != dominant_basin {
                            score -=
                                AUDIO_STYLE_PROGRAMMATIC_REMAINING_COLLAPSE_STRENGTH * *pressure;
                        }
                    }
                }

                if let Some(source_basin) = source_resolver.basin_for_track(candidate) {
                    let source_target = source_basin_pressure
                        .target_share
                        .get(&source_basin)
                        .copied()
                        .unwrap_or(0.0);
                    let source_usage = source_basin_pressure.usage_share(&source_basin);
                    score += AUDIO_STYLE_PROGRAMMATIC_SOURCE_MASS_DEFICIT_STRENGTH
                        * (source_target - source_usage).max(0.0);
                }

                score
            })
            .collect::<Vec<_>>();
        let gates = scores
            .into_iter()
            .map(|score| score.clamp(-3.20, 1.90).exp().clamp(0.04, 6.70))
            .collect();
        Self {
            gates,
            novelty_gates,
        }
    }
}

fn basin_counts_from_keys(
    basins: impl IntoIterator<Item = PlaybackAttractorBasinKey>,
) -> HashMap<PlaybackAttractorBasinKey, usize> {
    let mut counts = HashMap::new();
    for basin in basins {
        *counts.entry(basin).or_insert(0) += 1;
    }
    counts
}

fn basin_share_from_counts(
    counts: HashMap<PlaybackAttractorBasinKey, usize>,
) -> HashMap<PlaybackAttractorBasinKey, f32> {
    let total = counts.values().sum::<usize>().max(1) as f32;
    counts
        .into_iter()
        .map(|(basin, count)| (basin, count as f32 / total))
        .collect()
}

fn route_epoch_support_share(
    candidates: &[PlaybackTrack],
    recently_played_tracks: &[PlaybackTrack],
    basin_resolver: AudioStyleBasinResolver<'_>,
) -> HashMap<PlaybackAttractorBasinKey, f32> {
    basin_share_from_counts(basin_counts_from_keys(
        candidates
            .iter()
            .filter_map(|candidate| basin_resolver.basin_for_track(candidate))
            .chain(
                recently_played_tracks
                    .iter()
                    .rev()
                    .take(AUDIO_STYLE_ROUTE_RECENT_WINDOW)
                    .filter_map(|track| basin_resolver.basin_for_track(track)),
            ),
    ))
}

fn remaining_candidate_basin_share(
    candidates: &[PlaybackTrack],
    recent_keys: &HashSet<PlaybackTrackKey>,
    basin_resolver: AudioStyleBasinResolver<'_>,
) -> HashMap<PlaybackAttractorBasinKey, f32> {
    basin_share_from_counts(basin_counts_from_keys(candidates.iter().filter_map(
        |candidate| {
            if recent_keys.contains(&PlaybackTrackKey::from_track(candidate)) {
                return None;
            }
            basin_resolver.basin_for_track(candidate)
        },
    )))
}

fn dominant_remaining_basin(
    remaining_share: &HashMap<PlaybackAttractorBasinKey, f32>,
    support_share: &HashMap<PlaybackAttractorBasinKey, f32>,
) -> Option<(PlaybackAttractorBasinKey, f32)> {
    remaining_share
        .iter()
        .filter_map(|(basin, share)| {
            let support = support_share.get(basin).copied().unwrap_or(0.0);
            let slack = support.max(1.0e-6).sqrt() * 0.35;
            let pressure = (*share - support - slack).max(0.0);
            (pressure > 0.0).then_some((basin.clone(), pressure))
        })
        .max_by(|left, right| left.1.total_cmp(&right.1))
}

fn route_window_capacity_share(support_share: f32, window_len: usize) -> f32 {
    if window_len == 0 {
        return 1.0;
    }
    let expected = window_len as f32 * support_share.clamp(0.0, 1.0);
    let capacity = (expected + expected.max(1.0).sqrt() + 1.0) / window_len as f32;
    capacity.clamp(2.0 / window_len as f32, 0.62)
}

fn projected_route_capacity_violation(
    recent_window_counts: &HashMap<PlaybackAttractorBasinKey, usize>,
    recent_window_len: usize,
    candidate_basin: &PlaybackAttractorBasinKey,
    support_share: f32,
) -> f32 {
    if recent_window_len < AUDIO_STYLE_PROGRAMMATIC_ROUTE_CAPACITY_WARMUP {
        return 0.0;
    }
    let projected_len = (recent_window_len + 1).min(AUDIO_STYLE_PROGRAMMATIC_ROUTE_CAPACITY_WINDOW);
    let projected_count = recent_window_counts
        .get(candidate_basin)
        .copied()
        .unwrap_or(0)
        + 1;
    let projected_share = projected_count as f32 / projected_len.max(1) as f32;
    (projected_share - route_window_capacity_share(support_share, projected_len)).max(0.0)
}

fn audio_style_programmatic_distance_phase(
    basin_pressure: &PlaybackAttractorBasinPressure,
    source_basin_pressure: &PlaybackAttractorBasinPressure,
) -> AudioStyleProgrammaticDistancePhase {
    let basin_fatigue = basin_pressure
        .current_basin
        .as_ref()
        .and_then(|basin| basin_pressure.fatigue.get(basin).copied())
        .unwrap_or(0.0);
    let source_fatigue = source_basin_pressure
        .current_basin
        .as_ref()
        .and_then(|basin| source_basin_pressure.fatigue.get(basin).copied())
        .unwrap_or(0.0);
    if basin_pressure.current_basin_run >= AUDIO_STYLE_PROGRAMMATIC_EPISODE_SHIFT_RUN
        || source_basin_pressure.current_basin_run >= AUDIO_STYLE_PROGRAMMATIC_EPISODE_SHIFT_RUN
        || basin_fatigue.max(source_fatigue) >= AUDIO_STYLE_PROGRAMMATIC_EPISODE_FATIGUE_SHIFT
    {
        AudioStyleProgrammaticDistancePhase::Shift
    } else {
        AudioStyleProgrammaticDistancePhase::Continue
    }
}

fn audio_style_programmatic_adaptive_distance_band(
    novelty_values: &[f32],
) -> Option<AudioStyleProgrammaticDistanceBand> {
    let mut values = novelty_values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return None;
    }
    values.sort_by(|left, right| left.total_cmp(right));
    let mut band = AudioStyleProgrammaticDistanceBand {
        low: sorted_quantile(&values, AUDIO_STYLE_PROGRAMMATIC_DISTANCE_LOW_QUANTILE),
        target: sorted_quantile(&values, AUDIO_STYLE_PROGRAMMATIC_DISTANCE_TARGET_QUANTILE),
        high: sorted_quantile(&values, AUDIO_STYLE_PROGRAMMATIC_DISTANCE_HIGH_QUANTILE),
    };
    if band.high - band.low < AUDIO_STYLE_PROGRAMMATIC_DISTANCE_MIN_WIDTH {
        let half_width = AUDIO_STYLE_PROGRAMMATIC_DISTANCE_MIN_WIDTH * 0.5;
        band.low = (band.target - half_width).clamp(0.0, 1.0);
        band.high = (band.target + half_width).clamp(0.0, 1.0);
    }
    Some(band)
}

fn audio_style_programmatic_inverted_u_score(
    novelty: f32,
    band: AudioStyleProgrammaticDistanceBand,
) -> f32 {
    let novelty = novelty.clamp(0.0, 1.0);
    let half_width = ((band.high - band.low) * 0.5).max(1.0e-6);
    let target_affinity =
        (1.0 - ((novelty - band.target).abs() / half_width).powi(2)).clamp(-1.0, 1.0);
    let high_penalty = -AUDIO_STYLE_PROGRAMMATIC_HIGH_NOVELTY_OVERLOAD_STRENGTH
        * ((novelty - band.high).max(0.0) / half_width).powi(2);
    let low_penalty = -AUDIO_STYLE_PROGRAMMATIC_LOW_NOVELTY_STICKINESS_STRENGTH
        * ((band.low - novelty).max(0.0) / half_width).powi(2);
    AUDIO_STYLE_PROGRAMMATIC_NOVELTY_STRENGTH * target_affinity + high_penalty + low_penalty
}

fn audio_style_programmatic_novelty_gate(score: f32) -> f32 {
    score.clamp(-3.20, 1.90).exp().clamp(0.04, 6.70)
}

fn audio_style_manifold_residence_capacity(manifold: AudioStyleManifoldDescriptor) -> f32 {
    let spectral = manifold.spectral_rank.max(1.0);
    let boundary = manifold.boundary_pressure.clamp(0.0, 1.0);
    (spectral.sqrt() * (1.25 - 0.55 * boundary)).max(1.0)
}

impl AudioStyleListeningAdaptationDecision {
    fn from_support(
        candidates: &[PlaybackTrack],
        support: &AudioStyleCandidateSupport,
        control_gate: &AudioStyleControlGateDecision,
        anchor_key: &PlaybackTrackKey,
        basin_pressure: &PlaybackAttractorBasinPressure,
        source_basin_pressure: &PlaybackAttractorBasinPressure,
        embeddings: &AudioStyleEmbeddingMap,
        geometry: &AudioStyleSamplingGeometry,
        recently_played_tracks: &[PlaybackTrack],
        basin_resolver: AudioStyleBasinResolver<'_>,
    ) -> Self {
        let listener_recovery = audio_style_listener_recovery_gate(
            candidates,
            embeddings,
            recently_played_tracks,
            basin_pressure,
        );
        let source_gate = audio_style_source_repetition_gate(candidates, source_basin_pressure);
        let anchor_basin = basin_resolver.basin_for_key(anchor_key);
        let route_field = AudioStyleRouteFieldDecision::from_recent_history(
            candidates,
            anchor_key,
            basin_pressure,
            embeddings,
            geometry,
            recently_played_tracks,
            basin_resolver,
        );
        let manifold_field = AudioStyleManifoldFieldDecision::from_support(
            candidates,
            anchor_key,
            support,
            geometry,
            basin_pressure,
            basin_resolver,
        );
        let future_occupancy = AudioStyleFutureOccupancyReachabilityDecision::from_support(
            candidates,
            support,
            geometry,
            basin_pressure,
            basin_resolver,
        );
        let programmatic_route = AudioStyleProgrammaticRouteDecision::from_support(
            candidates,
            support,
            basin_pressure,
            source_basin_pressure,
            recently_played_tracks,
            basin_resolver,
        );
        let model_basin_support =
            audio_style_model_basin_support_gate(candidates, geometry, basin_resolver);
        let candidate_basins = candidates
            .iter()
            .map(|candidate| basin_resolver.basin_for_track(candidate))
            .collect::<Vec<_>>();
        let candidate_similarities = support
            .similarities
            .iter()
            .map(|value| value.unwrap_or(-1.0).clamp(-1.0, 1.0))
            .collect::<Vec<_>>();
        let mut pre_homeostatic = Vec::with_capacity(candidates.len());
        let mut diagnostics = Vec::with_capacity(candidates.len());

        for index in 0..candidates.len() {
            let base = support.weights.get(index).copied().unwrap_or(0.0);
            let control = control_gate.gates.get(index).copied().unwrap_or(1.0);
            let semantic_gate = control_gate
                .semantic_gates
                .get(index)
                .copied()
                .unwrap_or(1.0);
            let basin_penalty =
                basin_pressure.penalty_for_track(&candidates[index], basin_resolver);
            let mut source_penalty = source_basin_pressure
                .source_penalty_for_track(&candidates[index], PlaybackSourceBasinResolver);
            if candidates[index].liked {
                source_penalty *= 0.25;
            }
            let damping = basin_penalty + source_penalty;
            let fatigue_gate = audio_style_listening_fatigue_gate(&candidates[index], damping);
            let continuity = support
                .similarities
                .get(index)
                .and_then(|value| *value)
                .unwrap_or(-1.0)
                .clamp(-1.0, 1.0);
            let novelty = ((1.0 - continuity) * 0.5).clamp(0.0, 1.0);
            let route_drive =
                basin_pressure.future_deficit_for_track(&candidates[index], basin_resolver);
            let model_support = model_basin_support.get(index).copied().unwrap_or(1.0);
            let route_capture_support = if candidates.len() <= 2 {
                1.0
            } else {
                audio_style_route_capture_support_gate(model_support)
            };
            let manifold_stream_gate = manifold_field
                .stream_gates
                .get(index)
                .copied()
                .unwrap_or(1.0);
            let manifold_route_cap = manifold_field.route_caps.get(index).copied().unwrap_or(1.0);
            let future_occupancy_gate = future_occupancy.gates.get(index).copied().unwrap_or(1.0);
            let stream_continuation = audio_style_route_bonus_gate(
                basin_pressure.route_field_gate(
                    anchor_basin.as_ref(),
                    &candidates[index],
                    &candidate_basins,
                    &candidate_similarities,
                    index,
                    basin_resolver,
                ),
                route_capture_support,
            );
            let stream_continuation =
                (stream_continuation * manifold_stream_gate).clamp(0.02, 18.0);
            let weight = base
                * control
                * stream_continuation
                * route_field.gates.get(index).copied().unwrap_or(1.0)
                * manifold_route_cap
                * future_occupancy_gate
                * programmatic_route.gates.get(index).copied().unwrap_or(1.0)
                * model_support
                * listener_recovery.get(index).copied().unwrap_or(1.0)
                * source_gate.get(index).copied().unwrap_or(1.0)
                * fatigue_gate;
            let weight = if weight.is_finite() {
                weight.max(0.0)
            } else {
                0.0
            };
            pre_homeostatic.push(weight);
            diagnostics.push(Some(AudioStyleBioRouteDiagnostics {
                distance_base: base,
                route_drive,
                control_gate: control,
                semantic_gate,
                novelty,
                novelty_gate: programmatic_route
                    .novelty_gates
                    .get(index)
                    .copied()
                    .unwrap_or(1.0),
                stream_gate: stream_continuation,
                damping,
                final_weight: weight,
            }));
        }

        let gates = pre_homeostatic
            .into_iter()
            .map(|weight| {
                if weight.is_finite() {
                    weight.max(0.0)
                } else {
                    0.0
                }
            })
            .collect::<Vec<_>>();
        for (index, weight) in gates.iter().copied().enumerate() {
            if let Some(Some(diagnostic)) = diagnostics.get_mut(index) {
                diagnostic.final_weight = weight;
            }
        }
        let topology_health = audio_style_support_topology_health(
            candidates,
            &support.weights,
            &control_gate.gates,
            &gates,
            basin_pressure,
            embeddings,
            geometry,
            basin_resolver,
        );
        Self {
            gates,
            diagnostics,
            topology_health,
        }
    }
}

impl AudioStyleSamplingDistribution {
    fn from_candidate_weights(candidates: &[PlaybackTrack], weights: Vec<f32>) -> Option<Self> {
        let weights = audio_style_retain_liked_sampling_floor(candidates, weights);
        let total = weights.iter().copied().sum::<f32>();
        (total > 0.0 && total.is_finite()).then_some(Self { weights, total })
    }

    fn select_index(&self, candidate_count: usize, draw_unit: f32) -> usize {
        let mut cursor = draw_unit.clamp(0.0, 0.999_999) * self.total;
        let mut last_positive_index = None;
        for (index, weight) in self.weights.iter().copied().enumerate() {
            if weight <= 0.0 || !weight.is_finite() {
                continue;
            }
            last_positive_index = Some(index);
            if cursor <= weight {
                return index;
            }
            cursor -= weight;
        }
        last_positive_index.unwrap_or(candidate_count.saturating_sub(1))
    }

    fn probability(&self, index: usize) -> f32 {
        self.weights.get(index).copied().unwrap_or(0.0) / self.total
    }
}

fn audio_style_retain_liked_sampling_floor(
    candidates: &[PlaybackTrack],
    weights: Vec<f32>,
) -> Vec<f32> {
    let mut weights = weights
        .into_iter()
        .map(|weight| {
            if weight.is_finite() && weight > 0.0 {
                weight
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();
    if weights.is_empty()
        || candidates.len() != weights.len()
        || !candidates.iter().any(|candidate| candidate.liked)
    {
        return weights;
    }
    for (index, weight) in weights.iter_mut().enumerate() {
        if candidates[index].liked && *weight <= 0.0 {
            *weight = AUDIO_STYLE_LIKED_RETAIN_WEIGHT_FLOOR;
        }
    }
    weights
}

fn audio_style_channel_cosine(
    left: &AudioStyleEmbedding,
    right: &AudioStyleEmbedding,
    mean: &[f32],
    range: std::ops::Range<usize>,
) -> Option<f32> {
    if left.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH
        || right.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH
        || mean.len() != AUDIO_STYLE_EMBEDDING_WIDTH
        || range.end > AUDIO_STYLE_EMBEDDING_WIDTH
        || range.start >= range.end
    {
        return None;
    }

    let mut dot = 0.0_f32;
    let mut left_norm = 0.0_f32;
    let mut right_norm = 0.0_f32;
    for index in range {
        let centered_left = left.values[index] - mean[index];
        let centered_right = right.values[index] - mean[index];
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

fn audio_style_density_owner_best_vote_count(
    candidates: &[PlaybackTrack],
    embeddings: &AudioStyleEmbeddingMap,
    geometry: &AudioStyleSamplingGeometry,
) -> usize {
    let mut best_density = f32::NEG_INFINITY;
    let mut best_count = 0usize;
    for candidate in candidates {
        let key = PlaybackTrackKey::from_track(candidate);
        if !embeddings.contains_key(&key) {
            continue;
        }
        let density = geometry.local_density.get(&key).copied().unwrap_or(0.0);
        match density.total_cmp(&best_density) {
            std::cmp::Ordering::Greater => {
                best_density = density;
                best_count = 1;
            }
            std::cmp::Ordering::Equal => {
                best_count += 1;
            }
            std::cmp::Ordering::Less => {}
        }
    }
    best_count
}

fn audio_style_support_topology_health(
    candidates: &[PlaybackTrack],
    base_support: &[f32],
    control_gate: &[f32],
    final_support: &[f32],
    basin_pressure: &PlaybackAttractorBasinPressure,
    embeddings: &AudioStyleEmbeddingMap,
    geometry: &AudioStyleSamplingGeometry,
    basin_resolver: AudioStyleBasinResolver<'_>,
) -> Option<AudioStyleTopologyHealthDiagnostics> {
    if candidates.is_empty() || final_support.is_empty() {
        return None;
    }
    let normalized = normalize_positive_weights(final_support.to_vec());
    if normalized.iter().all(|weight| *weight <= 0.0) {
        return None;
    }
    let support_width = audio_style_support_effective_width(&normalized);
    let support_entropy = audio_style_weight_entropy(&normalized);
    let control_weights = normalize_positive_weights(
        control_gate
            .iter()
            .copied()
            .map(|value| value.max(0.0))
            .collect(),
    );
    let control_entropy = audio_style_weight_entropy(&control_weights);
    let mut basin_fatigue_mass = 0.0_f32;
    for (candidate, weight) in candidates.iter().zip(normalized.iter().copied()) {
        let Some(basin) = basin_resolver.basin_for_track(candidate) else {
            continue;
        };
        basin_fatigue_mass += weight * basin_pressure.penalty_for_basin(&basin);
    }
    let base = normalize_positive_weights(base_support.to_vec());
    let prediction_error = if base.len() == normalized.len() {
        base.iter()
            .zip(normalized.iter())
            .map(|(left, right)| (left - right).abs())
            .sum::<f32>()
            * 0.5
    } else {
        0.0
    };
    let novelty = normalized
        .iter()
        .zip(base.iter())
        .map(|(final_weight, base_weight)| final_weight * (1.0 - base_weight).clamp(0.0, 1.0))
        .sum::<f32>();
    let novelty_gate = if base.len() == normalized.len() {
        base.iter()
            .zip(normalized.iter())
            .filter_map(|(base_weight, final_weight)| {
                (*base_weight > 0.0).then_some(final_weight / base_weight)
            })
            .sum::<f32>()
            / base.iter().filter(|value| **value > 0.0).count().max(1) as f32
    } else {
        1.0
    };

    Some(AudioStyleTopologyHealthDiagnostics {
        support_width,
        support_entropy,
        control_entropy,
        basin_fatigue_mass,
        prediction_error,
        novelty,
        novelty_gate: novelty_gate.clamp(0.0, 4.0),
        density_owner_best_vote_count: audio_style_density_owner_best_vote_count(
            candidates, embeddings, geometry,
        ),
    })
}

fn audio_style_route_velocity_axis(
    previous: &AudioStyleEmbedding,
    anchor: &AudioStyleEmbedding,
    mean: &[f32],
) -> Option<Vec<f32>> {
    if previous.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH
        || anchor.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH
        || mean.len() != AUDIO_STYLE_EMBEDDING_WIDTH
    {
        return None;
    }
    let mut axis = Vec::with_capacity(AUDIO_STYLE_EMBEDDING_WIDTH);
    let mut norm = 0.0_f32;
    for ((previous_value, anchor_value), mean_value) in previous
        .values
        .iter()
        .zip(anchor.values.iter())
        .zip(mean.iter())
    {
        let value = (anchor_value - mean_value) - (previous_value - mean_value);
        axis.push(value);
        norm += value * value;
    }
    let norm = norm.sqrt();
    if norm <= 1.0e-6 || !norm.is_finite() {
        return None;
    }
    for value in &mut axis {
        *value /= norm;
    }
    Some(axis)
}

fn audio_style_route_candidate_alignment(
    anchor: &AudioStyleEmbedding,
    candidate: &AudioStyleEmbedding,
    mean: &[f32],
    route_axis: &[f32],
) -> Option<f32> {
    if anchor.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH
        || candidate.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH
        || mean.len() != AUDIO_STYLE_EMBEDDING_WIDTH
        || route_axis.len() != AUDIO_STYLE_EMBEDDING_WIDTH
    {
        return None;
    }
    let mut dot = 0.0_f32;
    let mut norm = 0.0_f32;
    for (((candidate_value, anchor_value), mean_value), axis_value) in candidate
        .values
        .iter()
        .zip(anchor.values.iter())
        .zip(mean.iter())
        .zip(route_axis.iter())
    {
        let value = (candidate_value - mean_value) - (anchor_value - mean_value);
        dot += value * axis_value;
        norm += value * value;
    }
    let norm = norm.sqrt();
    if norm <= 1.0e-6 || !norm.is_finite() {
        return None;
    }
    Some((dot / norm).clamp(-1.0, 1.0))
}

fn audio_style_support_effective_width(weights: &[f32]) -> f32 {
    let squared = weights.iter().map(|weight| weight * weight).sum::<f32>();
    if squared <= 1.0e-6 || !squared.is_finite() {
        0.0
    } else {
        (1.0 / squared).max(1.0)
    }
}

fn audio_style_weight_entropy(weights: &[f32]) -> f32 {
    if weights.len() <= 1 {
        return 0.0;
    }
    let entropy = weights
        .iter()
        .copied()
        .filter(|weight| weight.is_finite() && *weight > 0.0)
        .map(|weight| -weight * weight.ln())
        .sum::<f32>();
    (entropy / (weights.len() as f32).ln()).clamp(0.0, 1.0)
}

fn audio_style_candidate_basin_target_share(
    candidates: &[PlaybackTrack],
    basin_resolver: AudioStyleBasinResolver<'_>,
) -> HashMap<PlaybackAttractorBasinKey, f32> {
    let mut counts = HashMap::<PlaybackAttractorBasinKey, usize>::new();
    for candidate in candidates {
        let Some(basin) = basin_resolver.basin_for_track(candidate) else {
            continue;
        };
        *counts.entry(basin).or_insert(0) += 1;
    }
    let total = counts.values().map(|count| *count as f32).sum::<f32>();
    if total <= 0.0 || !total.is_finite() {
        return HashMap::new();
    }
    counts
        .into_iter()
        .map(|(basin, count)| (basin, count as f32 / total))
        .collect()
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
    let basin_resolver = AudioStyleBasinResolver::new(sampling_geometry);
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
                basin_resolver,
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
            basin_resolver,
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
            basin_resolver,
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
            basin_resolver,
        );
    };

    let support = AudioStyleCandidateSupport::from_anchored_candidates(
        candidates,
        anchor_key,
        embeddings,
        geometry,
        basin_resolver,
    );
    if !support.has_support() {
        return random_fallback_selection_with_diagnostics(
            candidates,
            embeddings,
            anchor_key,
            &support.similarities,
            candidates.len(),
            draw_unit,
            Some("no_embedded_candidates"),
            basin_resolver,
        );
    }

    let basin_pressure = PlaybackAttractorBasinPressure::from_recent_history_and_candidates(
        recently_played_tracks,
        candidates,
        basin_resolver,
    );
    let source_basin_pressure =
        PlaybackAttractorBasinPressure::from_recent_history_and_source_candidates(
            recently_played_tracks,
            candidates,
        );
    let control_gate = AudioStyleControlGateDecision::from_support(
        &support,
        &basin_pressure,
        &source_basin_pressure,
    );
    let adaptation = AudioStyleListeningAdaptationDecision::from_support(
        candidates,
        &support,
        &control_gate,
        anchor_key,
        &basin_pressure,
        &source_basin_pressure,
        embeddings,
        geometry,
        recently_played_tracks,
        basin_resolver,
    );
    let Some(distribution) =
        AudioStyleSamplingDistribution::from_candidate_weights(candidates, adaptation.gates)
    else {
        return random_fallback_selection_with_diagnostics(
            candidates,
            embeddings,
            anchor_key,
            &support.similarities,
            candidates.len(),
            draw_unit,
            Some("invalid_weights"),
            basin_resolver,
        );
    };

    let index = distribution.select_index(candidates.len(), draw_unit);
    let similarity_diagnostics =
        audio_style_selection_similarity_diagnostics(index, &support.similarities);
    let candidate_diagnostics = audio_style_candidate_diagnostics(
        candidates,
        embeddings,
        anchor_key,
        &support.similarities,
        Some(index),
        basin_resolver,
    );
    let mut candidate_diagnostics =
        candidate_diagnostics.with_bio_route(adaptation.diagnostics.get(index).copied().flatten());
    candidate_diagnostics.perceptual_channels = support.diagnostics.get(index).copied().flatten();
    candidate_diagnostics = candidate_diagnostics.with_topology_health(adaptation.topology_health);
    AudioStyleCandidateSelection {
        index,
        probability: distribution.probability(index),
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
    let basin_resolver = AudioStyleBasinResolver::new(sampling_geometry);
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
                basin_resolver,
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
                basin_resolver,
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
                basin_resolver,
            ),
        );
    };

    let support =
        AudioStyleCandidateSupport::from_centerless_candidates(candidates, embeddings, geometry);
    if support.similarities.iter().all(Option::is_none) {
        return random_fallback_selection_from_diagnostics(
            candidates.len(),
            draw_unit,
            Some("no_embedded_candidates"),
            audio_style_candidate_diagnostics(
                candidates,
                embeddings,
                &PlaybackTrackKey::empty_anchor(),
                &support.similarities,
                Some(random_fallback_index(candidates.len(), draw_unit)),
                basin_resolver,
            ),
        );
    }
    let basin_pressure = PlaybackAttractorBasinPressure::from_recent_history_and_candidates(
        &[],
        candidates,
        basin_resolver,
    );
    let source_basin_pressure =
        PlaybackAttractorBasinPressure::from_recent_history_and_source_candidates(&[], candidates);
    let control_gate = AudioStyleControlGateDecision::from_support(
        &support,
        &basin_pressure,
        &source_basin_pressure,
    );
    let adaptation = AudioStyleListeningAdaptationDecision::from_support(
        candidates,
        &support,
        &control_gate,
        &PlaybackTrackKey::empty_anchor(),
        &basin_pressure,
        &source_basin_pressure,
        embeddings,
        geometry,
        &[],
        basin_resolver,
    );
    let Some(distribution) =
        AudioStyleSamplingDistribution::from_candidate_weights(candidates, adaptation.gates)
    else {
        return random_fallback_selection_from_diagnostics(
            candidates.len(),
            draw_unit,
            Some("invalid_weights"),
            audio_style_candidate_diagnostics(
                candidates,
                embeddings,
                &PlaybackTrackKey::empty_anchor(),
                &support.similarities,
                Some(random_fallback_index(candidates.len(), draw_unit)),
                basin_resolver,
            ),
        );
    };

    let index = distribution.select_index(candidates.len(), draw_unit);
    audio_style_candidate_selection_from_centerless_weight(
        candidates,
        embeddings,
        sampling_geometry,
        adaptation.topology_health,
        &support.similarities,
        support.diagnostics.get(index).copied().flatten(),
        adaptation.diagnostics.get(index).copied().flatten(),
        index,
        distribution.weights.get(index).copied().unwrap_or(0.0),
        distribution.total,
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
    sampling_geometry: Option<&AudioStyleSamplingGeometry>,
    topology_health: Option<AudioStyleTopologyHealthDiagnostics>,
    similarities: &[Option<f32>],
    perceptual_channels: Option<AudioStylePerceptualChannelDiagnostics>,
    bio_route: Option<AudioStyleBioRouteDiagnostics>,
    index: usize,
    weight: f32,
    total: f32,
    draw_unit: f32,
) -> AudioStyleCandidateSelection {
    let similarity_diagnostics = audio_style_selection_similarity_diagnostics(index, similarities);
    let diagnostics = audio_style_candidate_diagnostics(
        candidates,
        embeddings,
        &PlaybackTrackKey::empty_anchor(),
        similarities,
        Some(index),
        AudioStyleBasinResolver::new(sampling_geometry),
    )
    .with_bio_route(bio_route)
    .with_topology_health(topology_health)
    .with_perceptual_channels(perceptual_channels);
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
        diagnostics,
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

fn audio_style_listening_fatigue_gate(_candidate: &PlaybackTrack, damping: f32) -> f32 {
    if damping <= 0.0 || !damping.is_finite() {
        return 1.0;
    }
    (1.0 / (1.0 + AUDIO_STYLE_BIO_ROUTE_DAMPING_STRENGTH * damping.max(0.0))).clamp(0.05, 1.0)
}

fn audio_style_model_basin_support_gate(
    candidates: &[PlaybackTrack],
    geometry: &AudioStyleSamplingGeometry,
    basin_resolver: AudioStyleBasinResolver<'_>,
) -> Vec<f32> {
    if candidates.len() <= 2 {
        return vec![1.0; candidates.len()];
    }
    let mut global_basin_counts = HashMap::<PlaybackAttractorBasinKey, usize>::new();
    for basin in geometry.self_supervised_basins.values() {
        *global_basin_counts.entry(basin.clone()).or_insert(0) += 1;
    }
    candidates
        .iter()
        .map(|candidate| {
            let Some(basin) = basin_resolver.basin_for_track(candidate) else {
                return 1.0;
            };
            match global_basin_counts.get(&basin).copied().unwrap_or(0) {
                0 => 1.0,
                1 => {
                    let key = PlaybackTrackKey::from_track(candidate);
                    let density = geometry.local_density.get(&key).copied().unwrap_or(0.0);
                    let density_gate = (1.0 + density.max(0.0)).recip().clamp(0.55, 1.0);
                    (AUDIO_STYLE_MODEL_BASIN_SUPPORT_SINGLETON_GATE * density_gate).clamp(0.32, 1.0)
                }
                2 => AUDIO_STYLE_MODEL_BASIN_SUPPORT_PAIR_GATE,
                _ => 1.0,
            }
        })
        .collect()
}

fn audio_style_route_capture_support_gate(model_basin_support: f32) -> f32 {
    if !model_basin_support.is_finite() {
        return 1.0;
    }
    ((model_basin_support - AUDIO_STYLE_MODEL_BASIN_SUPPORT_SINGLETON_GATE)
        / (1.0 - AUDIO_STYLE_MODEL_BASIN_SUPPORT_SINGLETON_GATE).max(1.0e-6))
    .clamp(0.0, 1.0)
}

fn audio_style_route_bonus_gate(gate: f32, capture_support: f32) -> f32 {
    if !gate.is_finite() {
        return 1.0;
    }
    if gate <= 1.0 {
        return gate;
    }
    1.0 + (gate - 1.0) * capture_support.clamp(0.0, 1.0)
}

fn audio_style_typed_continuity_scores(
    scalar_similarities: &[f32],
    diagnostics: &[Option<AudioStylePerceptualChannelDiagnostics>],
) -> Vec<f32> {
    scalar_similarities
        .iter()
        .copied()
        .enumerate()
        .map(|(index, scalar)| {
            diagnostics
                .get(index)
                .copied()
                .flatten()
                .map(|channels| {
                    audio_style_agreement_aware_continuity([
                        scalar,
                        channels.terminal_similarity,
                        channels.flow_similarity,
                        channels.transition_similarity,
                    ])
                })
                .unwrap_or(scalar)
                .clamp(-1.0, 1.0)
        })
        .collect()
}

fn audio_style_agreement_aware_continuity(mut channels: [f32; 4]) -> f32 {
    for value in &mut channels {
        if !value.is_finite() {
            *value = -1.0;
        }
    }
    let strongest = channels.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    if strongest <= AUDIO_STYLE_SEMANTIC_CONTINUITY_FAMILIARITY_THRESHOLD {
        return strongest.clamp(-1.0, 1.0);
    }

    let mean = channels.iter().copied().sum::<f32>() / channels.len() as f32;
    let disagreement = channels
        .iter()
        .map(|value| (value - mean).abs())
        .sum::<f32>()
        / channels.len() as f32;
    let familiarity_excess = strongest - AUDIO_STYLE_SEMANTIC_CONTINUITY_FAMILIARITY_THRESHOLD;
    (strongest
        - AUDIO_STYLE_SEMANTIC_CONTINUITY_DISAGREEMENT_STRENGTH
            * familiarity_excess.max(0.0)
            * disagreement.max(0.0))
    .clamp(-1.0, 1.0)
}

#[cfg(test)]
pub(crate) fn audio_style_agreement_aware_continuity_for_test(channels: [f32; 4]) -> f32 {
    audio_style_agreement_aware_continuity(channels)
}

fn audio_style_semantic_continuity_gate(
    continuity_scores: &[f32],
    basin_pressure: &PlaybackAttractorBasinPressure,
    source_basin_pressure: &PlaybackAttractorBasinPressure,
) -> Vec<f32> {
    let escape_ready = basin_pressure.current_basin_run
        >= AUDIO_STYLE_SEMANTIC_CONTINUITY_ESCAPE_RUN
        || source_basin_pressure.current_basin_run >= AUDIO_STYLE_SEMANTIC_CONTINUITY_ESCAPE_RUN;
    if basin_pressure.current_basin_run < AUDIO_STYLE_SEMANTIC_CONTINUITY_HISTORY_GATE
        && source_basin_pressure.current_basin_run < AUDIO_STYLE_SEMANTIC_CONTINUITY_HISTORY_GATE
    {
        return vec![1.0; continuity_scores.len()];
    }
    let strength = if escape_ready {
        AUDIO_STYLE_SEMANTIC_CONTINUITY_STRENGTH * 0.40
    } else {
        AUDIO_STYLE_SEMANTIC_CONTINUITY_STRENGTH
    };

    continuity_scores
        .iter()
        .copied()
        .map(|continuity| {
            let continuity = continuity.clamp(-1.0, 1.0);
            let deficit = (AUDIO_STYLE_SEMANTIC_CONTINUITY_FLOOR - continuity).max(0.0);
            let floor_gate = if deficit <= 0.0 {
                1.0
            } else {
                (-strength * deficit).exp().clamp(0.05, 1.0)
            };
            floor_gate
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn audio_style_semantic_continuity_gate_for_test(
    continuity_scores: &[f32],
    basin_run: usize,
    source_run: usize,
) -> Vec<f32> {
    let basin_pressure = PlaybackAttractorBasinPressure {
        current_basin: None,
        current_basin_run: basin_run,
        recent_evidence_count: basin_run,
        fatigue: HashMap::new(),
        usage: HashMap::new(),
        candidate_top_pressure: HashMap::new(),
        target_share: HashMap::new(),
    };
    let source_basin_pressure = PlaybackAttractorBasinPressure {
        current_basin: None,
        current_basin_run: source_run,
        recent_evidence_count: source_run,
        fatigue: HashMap::new(),
        usage: HashMap::new(),
        candidate_top_pressure: HashMap::new(),
        target_share: HashMap::new(),
    };
    audio_style_semantic_continuity_gate(continuity_scores, &basin_pressure, &source_basin_pressure)
}

#[cfg(test)]
pub(crate) fn audio_style_programmatic_route_gate_for_test(
    continuities: &[f32],
    current_run: usize,
    current_usage_share: f32,
    current_target_share: f32,
    alternative_target_share: f32,
    recently_played_current_count: usize,
) -> Vec<f32> {
    let current_basin = PlaybackAttractorBasinKey {
        value: "current".to_string(),
    };
    let alternative_basin = PlaybackAttractorBasinKey {
        value: "alternative".to_string(),
    };
    let mut candidates = (0..continuities.len().saturating_sub(1))
        .map(|index| track_for_programmatic_route_test("current", &format!("current_{index}")))
        .collect::<Vec<_>>();
    candidates.push(track_for_programmatic_route_test(
        "alternative",
        "alternative",
    ));
    let support = AudioStyleCandidateSupport {
        weights: vec![1.0; candidates.len()],
        similarities: continuities.iter().copied().map(Some).collect(),
        diagnostics: vec![None; candidates.len()],
    };
    let recently_played_tracks = (0..recently_played_current_count)
        .map(|index| track_for_programmatic_route_test("current", &format!("current_{index}")))
        .collect::<Vec<_>>();
    let mut basin_pressure = PlaybackAttractorBasinPressure {
        current_basin: Some(current_basin.clone()),
        current_basin_run: current_run,
        recent_evidence_count: current_run,
        fatigue: HashMap::new(),
        usage: HashMap::new(),
        candidate_top_pressure: HashMap::new(),
        target_share: HashMap::new(),
    };
    basin_pressure
        .usage
        .insert(current_basin.clone(), current_usage_share.max(0.0));
    basin_pressure.usage.insert(
        alternative_basin.clone(),
        (1.0 - current_usage_share).max(0.0),
    );
    basin_pressure
        .target_share
        .insert(current_basin.clone(), current_target_share.max(0.0));
    basin_pressure
        .target_share
        .insert(alternative_basin.clone(), alternative_target_share.max(0.0));
    let source_basin_pressure =
        PlaybackAttractorBasinPressure::from_recent_history_and_source_candidates(
            &recently_played_tracks,
            &candidates,
        );
    AudioStyleProgrammaticRouteDecision::from_support(
        &candidates,
        &support,
        &basin_pressure,
        &source_basin_pressure,
        &recently_played_tracks,
        AudioStyleBasinResolver::new(None),
    )
    .gates
}

#[cfg(test)]
pub(crate) fn audio_style_programmatic_route_gate_for_named_basins_for_test(
    candidate_basins: &[&str],
    continuities: &[f32],
    recent_basins: &[&str],
) -> Vec<f32> {
    let candidates = candidate_basins
        .iter()
        .enumerate()
        .map(|(index, basin)| {
            track_for_programmatic_route_test(basin, &format!("candidate_{index}"))
        })
        .collect::<Vec<_>>();
    let support = AudioStyleCandidateSupport {
        weights: vec![1.0; candidates.len()],
        similarities: continuities.iter().copied().map(Some).collect(),
        diagnostics: vec![None; candidates.len()],
    };
    let recently_played_tracks = recent_basins
        .iter()
        .enumerate()
        .map(|(index, basin)| track_for_programmatic_route_test(basin, &format!("recent_{index}")))
        .collect::<Vec<_>>();
    let basin_pressure = PlaybackAttractorBasinPressure::from_recent_history_and_candidates(
        &recently_played_tracks,
        &candidates,
        AudioStyleBasinResolver::new(None),
    );
    let source_basin_pressure =
        PlaybackAttractorBasinPressure::from_recent_history_and_source_candidates(
            &recently_played_tracks,
            &candidates,
        );
    AudioStyleProgrammaticRouteDecision::from_support(
        &candidates,
        &support,
        &basin_pressure,
        &source_basin_pressure,
        &recently_played_tracks,
        AudioStyleBasinResolver::new(None),
    )
    .gates
}

#[cfg(test)]
fn track_for_programmatic_route_test(basin: &str, name: &str) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: "Test".to_string(),
        music_name: name.to_string(),
        canonical_music_id: format!("source:https://example.com/{basin}/{name}:0:60000"),
        music_url: format!("https://example.com/{basin}/{name}"),
        file_path: PathBuf::from(format!("youtube/{basin}/{name}.m4a")),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    }
}

fn audio_style_source_repetition_gate(
    candidates: &[PlaybackTrack],
    source_basin_pressure: &PlaybackAttractorBasinPressure,
) -> Vec<f32> {
    if candidates.len() <= 1 || source_basin_pressure.usage.is_empty() {
        return vec![1.0; candidates.len()];
    }
    let source_resolver = PlaybackSourceBasinResolver;
    candidates
        .iter()
        .map(|candidate| {
            if candidate.liked {
                return 1.0;
            }
            let penalty =
                source_basin_pressure.source_penalty_for_track(candidate, source_resolver);
            (1.0 / (1.0 + AUDIO_STYLE_BIO_ROUTE_SOURCE_FATIGUE_STRENGTH * penalty.max(0.0)))
                .clamp(AUDIO_STYLE_BIO_ROUTE_SOURCE_FATIGUE_FLOOR, 1.0)
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn audio_style_source_repetition_gate_for_test(
    candidates: &[PlaybackTrack],
    recently_played_tracks: &[PlaybackTrack],
) -> Vec<f32> {
    let pressure = PlaybackAttractorBasinPressure::from_recent_history_and_source_candidates(
        recently_played_tracks,
        candidates,
    );
    audio_style_source_repetition_gate(candidates, &pressure)
}

fn audio_style_listener_recovery_gate(
    candidates: &[PlaybackTrack],
    embeddings: &AudioStyleEmbeddingMap,
    recently_played_tracks: &[PlaybackTrack],
    basin_pressure: &PlaybackAttractorBasinPressure,
) -> Vec<f32> {
    if candidates.len() <= 1 || recently_played_tracks.len() < 3 {
        return vec![1.0; candidates.len()];
    }
    let Some(listener_state) =
        audio_style_listener_state_from_recent_history(recently_played_tracks, embeddings)
    else {
        return vec![1.0; candidates.len()];
    };
    let run_drive = (basin_pressure.current_basin_run.saturating_sub(1) as f32)
        .ln_1p()
        .max(0.0);
    let activity_drive = (recently_played_tracks
        .len()
        .min(AUDIO_STYLE_ROUTE_RECENT_WINDOW) as f32)
        / AUDIO_STYLE_ROUTE_RECENT_WINDOW as f32;
    let gate_drive = run_drive.max(activity_drive);
    if gate_drive <= 0.0 {
        return vec![1.0; candidates.len()];
    }
    candidates
        .iter()
        .map(|candidate| {
            let key = PlaybackTrackKey::from_track(candidate);
            let Some(load) = embeddings
                .get(&key)
                .map(|embedding| audio_style_listener_load_from_embedding(embedding.as_ref()))
            else {
                return 1.0;
            };
            audio_style_listener_recovery_gate_for_load(&listener_state, &load, gate_drive)
        })
        .collect()
}

fn audio_style_listener_state_from_recent_history(
    recently_played_tracks: &[PlaybackTrack],
    embeddings: &AudioStyleEmbeddingMap,
) -> Option<[f32; 6]> {
    let mut state = [0.0_f32; 6];
    let mut initialized = false;
    for track in recently_played_tracks
        .iter()
        .rev()
        .take(AUDIO_STYLE_ROUTE_RECENT_WINDOW)
        .rev()
    {
        let key = PlaybackTrackKey::from_track(track);
        let Some(embedding) = embeddings.get(&key) else {
            continue;
        };
        let load = audio_style_listener_load_from_embedding(embedding);
        if !initialized {
            state = load;
            initialized = true;
            continue;
        }
        for (state_value, load_value) in state.iter_mut().zip(load.iter().copied()) {
            *state_value = AUDIO_STYLE_LISTENER_ADAPTATION_DECAY * *state_value
                + (1.0 - AUDIO_STYLE_LISTENER_ADAPTATION_DECAY) * load_value;
        }
    }
    initialized.then_some(state)
}

fn audio_style_listener_recovery_gate_for_load(
    listener_state: &[f32; 6],
    candidate_load: &[f32; 6],
    gate_drive: f32,
) -> f32 {
    const COMFORT_LOW: [f32; 6] = [0.18, 0.18, 0.16, 0.16, 0.14, 0.18];
    const COMFORT_HIGH: [f32; 6] = [0.72, 0.72, 0.68, 0.68, 0.62, 0.72];
    let mut adaptation_match = 0.0_f32;
    let mut overload_match = 0.0_f32;
    let mut recovery_match = 0.0_f32;
    let mut underload_match = 0.0_f32;
    let mut comfort_distance_sq = 0.0_f32;
    let mut load_distance_sq = 0.0_f32;
    for index in 0..candidate_load.len() {
        let state = listener_state[index].clamp(0.0, 1.0);
        let candidate = candidate_load[index].clamp(0.0, 1.0);
        let overload = (state - COMFORT_HIGH[index]).max(0.0);
        let underload = (COMFORT_LOW[index] - state).max(0.0);
        let comfort_target = (COMFORT_LOW[index] + COMFORT_HIGH[index]) * 0.5;
        adaptation_match += candidate * state;
        overload_match += candidate * overload;
        recovery_match += (1.0 - candidate) * overload;
        underload_match += candidate * underload;
        comfort_distance_sq += (candidate - comfort_target).powi(2);
        load_distance_sq += (candidate - state).powi(2);
    }
    let comfort_distance = comfort_distance_sq.sqrt();
    let load_distance = load_distance_sq.sqrt();
    let log_gate = gate_drive
        * (-AUDIO_STYLE_LISTENER_ADAPTATION_STRENGTH * adaptation_match
            - AUDIO_STYLE_LISTENER_OVERLOAD_STRENGTH * overload_match
            + AUDIO_STYLE_LISTENER_RECOVERY_STRENGTH * recovery_match
            + AUDIO_STYLE_LISTENER_UNDERLOAD_STRENGTH * underload_match
            - AUDIO_STYLE_LISTENER_COMFORT_STRENGTH * comfort_distance
            - AUDIO_STYLE_LISTENER_SHOCK_STRENGTH
                * (load_distance - AUDIO_STYLE_LISTENER_SHOCK_DISTANCE).max(0.0));
    log_gate.exp().clamp(0.35, 1.85)
}

fn audio_style_listener_load_from_embedding(embedding: &AudioStyleEmbedding) -> [f32; 6] {
    if embedding.values.len() != AUDIO_STYLE_EMBEDDING_WIDTH {
        return [0.0; 6];
    }
    let terminal = &embedding.values[..AUDIO_STYLE_TERMINAL_BINS];
    let delta = &embedding.values[AUDIO_STYLE_TERMINAL_BINS..AUDIO_STYLE_TERMINAL_LATENT_WIDTH];
    let flow = &embedding.values
        [AUDIO_STYLE_TYPED_CHANNEL_FLOW_RANGE.start..AUDIO_STYLE_TYPED_CHANNEL_FLOW_RANGE.end];
    let flow_outgoing = &flow[..AUDIO_STYLE_TERMINAL_BINS];
    let flow_incoming = &flow[AUDIO_STYLE_TERMINAL_BINS..AUDIO_STYLE_TERMINAL_BINS * 2];
    let transition = &embedding.values[AUDIO_STYLE_TYPED_CHANNEL_TRANSITION_RANGE.start
        ..AUDIO_STYLE_TYPED_CHANNEL_TRANSITION_RANGE.end];

    let terminal_total = terminal
        .iter()
        .map(|value| value.abs())
        .sum::<f32>()
        .max(1.0e-6);
    let delta_total = delta
        .iter()
        .map(|value| value.abs())
        .sum::<f32>()
        .max(1.0e-6);
    let outgoing_total = flow_outgoing
        .iter()
        .map(|value| value.abs())
        .sum::<f32>()
        .max(1.0e-6);
    let incoming_total = flow_incoming
        .iter()
        .map(|value| value.abs())
        .sum::<f32>()
        .max(1.0e-6);
    let transition_total = transition
        .iter()
        .map(|value| value.abs())
        .sum::<f32>()
        .max(1.0e-6);

    let mut brightness = 0.0_f32;
    let mut energy = 0.0_f32;
    let mut motion = 0.0_f32;
    for (index, value) in terminal.iter().enumerate() {
        let mass = value.abs() / terminal_total;
        let pitch = (index / 4) as f32 / 15.0;
        let motion_code = if index % 4 > 0 { 1.0 } else { 0.0 };
        let energy_code = (index % 4) as f32 / 3.0;
        brightness += mass * pitch;
        energy += mass * energy_code;
        motion += mass * motion_code;
    }

    let mut delta_motion = 0.0_f32;
    for (index, value) in delta.iter().enumerate() {
        delta_motion += value.abs() / delta_total * (index as f32 / 63.0);
    }

    let mut pulse = 0.0_f32;
    for index in 0..AUDIO_STYLE_TERMINAL_BINS {
        pulse += (flow_outgoing[index].abs() / outgoing_total)
            * (flow_incoming[index].abs() / incoming_total);
    }
    pulse = pulse.sqrt();

    let transition_mean = transition_total / AUDIO_STYLE_TRANSITION_WIDTH as f32;
    let active_transition_share = transition
        .iter()
        .filter(|value| value.abs() > transition_mean)
        .count() as f32
        / AUDIO_STYLE_TRANSITION_WIDTH as f32;
    let row_entropy = audio_style_transition_row_entropy(transition);
    let complexity = 0.5 * active_transition_share + 0.5 * row_entropy;

    [
        brightness.clamp(0.0, 1.0),
        energy.clamp(0.0, 1.0),
        motion.clamp(0.0, 1.0),
        delta_motion.clamp(0.0, 1.0),
        pulse.clamp(0.0, 1.0),
        complexity.clamp(0.0, 1.0),
    ]
}

fn audio_style_transition_row_entropy(transition: &[f32]) -> f32 {
    if transition.len() != AUDIO_STYLE_TRANSITION_WIDTH {
        return 0.0;
    }
    let mut entropy_sum = 0.0_f32;
    for row in 0..AUDIO_STYLE_TERMINAL_BINS {
        let start = row * AUDIO_STYLE_TERMINAL_BINS;
        let end = start + AUDIO_STYLE_TERMINAL_BINS;
        let row_values = &transition[start..end];
        let total = row_values
            .iter()
            .map(|value| value.abs())
            .sum::<f32>()
            .max(1.0e-6);
        let mut entropy = 0.0_f32;
        for value in row_values {
            let probability = (value.abs() / total).max(1.0e-9);
            entropy -= probability * probability.ln();
        }
        entropy_sum += entropy / (AUDIO_STYLE_TERMINAL_BINS as f32).ln();
    }
    entropy_sum / AUDIO_STYLE_TERMINAL_BINS as f32
}

#[cfg(test)]
pub(crate) fn audio_style_listener_recovery_gate_for_load_for_test(
    listener_state: &[f32; 6],
    candidate_load: &[f32; 6],
    gate_drive: f32,
) -> f32 {
    audio_style_listener_recovery_gate_for_load(listener_state, candidate_load, gate_drive)
}

fn normalize_positive_weights(mut values: Vec<f32>) -> Vec<f32> {
    for value in &mut values {
        if !value.is_finite() || *value < 0.0 {
            *value = 0.0;
        }
    }
    let total = values.iter().copied().sum::<f32>();
    if total <= 0.0 || !total.is_finite() {
        return vec![0.0; values.len()];
    }
    values.into_iter().map(|value| value / total).collect()
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
    basin_resolver: AudioStyleBasinResolver<'_>,
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
            basin_resolver,
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
    wait_for_managed_binary_foreground_release(ManagedBinary::Ffmpeg);
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

fn cached_audio_style_stable_model_from_snapshot(
    snapshot: &AudioStyleModelSnapshot,
) -> CachedAudioStyleStableModel {
    CachedAudioStyleStableModel {
        version: AUDIO_STYLE_STABLE_MODEL_VERSION.to_string(),
        embedding_version: AUDIO_STYLE_EMBEDDING_VERSION.to_string(),
        generation: snapshot.generation(),
        state: CachedAudioStyleModelState::from(snapshot.state.as_ref()),
    }
}

fn snapshot_from_cached_audio_style_stable_model(
    cached: CachedAudioStyleStableModel,
    path: &Path,
) -> Result<AudioStyleModelSnapshot, String> {
    if cached.version != AUDIO_STYLE_STABLE_MODEL_VERSION {
        return Err(format!(
            "audio style stable model `{}` has unsupported version `{}`",
            path.display(),
            cached.version
        ));
    }
    if cached.embedding_version != AUDIO_STYLE_EMBEDDING_VERSION {
        return Err(format!(
            "audio style stable model `{}` has unsupported embedding version `{}`",
            path.display(),
            cached.embedding_version
        ));
    }
    let state = AudioStyleModelState::try_from(cached.state).map_err(|error| {
        format!(
            "audio style stable model `{}` has invalid state: {error}",
            path.display()
        )
    })?;
    Ok(AudioStyleModelSnapshot::from_state(
        cached.generation,
        Arc::new(state),
    ))
}

fn read_audio_style_stable_model(path: &Path) -> Result<AudioStyleModelSnapshot, String> {
    let bytes = fs::read(path).map_err(|error| {
        format!(
            "failed to read audio style stable model `{}`: {error}",
            path.display()
        )
    })?;
    let cached =
        serde_json::from_slice::<CachedAudioStyleStableModel>(&bytes).map_err(|error| {
            format!(
                "failed to parse audio style stable model `{}`: {error}",
                path.display()
            )
        })?;
    snapshot_from_cached_audio_style_stable_model(cached, path)
}

#[cfg(test)]
pub(crate) fn read_audio_style_stable_model_for_test(
    path: &Path,
) -> Result<AudioStyleModelSnapshot, String> {
    read_audio_style_stable_model(path)
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct AudioStylePredictiveTopologyProbePolicyReport {
    pub(crate) policy: &'static str,
    pub(crate) tail_largest_basin_share: f32,
    pub(crate) tail_basin_entropy_norm: f32,
    pub(crate) basin_run_p95: f32,
    pub(crate) basin_run_p99: f32,
    pub(crate) same_basin_transition_rate: f32,
    pub(crate) revisit_basin_transition_rate: f32,
    pub(crate) mean_adjacent_cosine: f32,
    pub(crate) mean_selected_reachability: f32,
    pub(crate) mean_selected_future_entropy: f32,
    pub(crate) weak_attractor_pressure: f32,
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct AudioStylePredictiveTopologyProbeReport {
    pub(crate) record_count: usize,
    pub(crate) basin_count: usize,
    pub(crate) generation: u64,
    pub(crate) policy_reports: Vec<AudioStylePredictiveTopologyProbePolicyReport>,
    pub(crate) recommended_policy: &'static str,
    pub(crate) weak_attractor_pressure_delta_vs_support_only: f32,
    pub(crate) tail_largest_basin_share_delta_vs_support_only: f32,
    pub(crate) mean_adjacent_cosine_delta_vs_support_only: f32,
    pub(crate) verdict: &'static str,
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct AudioStyleAdaptiveDistanceUProbePolicyReport {
    pub(crate) policy: &'static str,
    pub(crate) unique_sample_rate: f32,
    pub(crate) sample_count_gini_proxy: f32,
    pub(crate) same_basin_transition_rate: f32,
    pub(crate) max_basin_run_length: f32,
    pub(crate) warm_window_largest_basin_share_p90: f32,
    pub(crate) warm_window_largest_basin_share_max: f32,
    pub(crate) global_middle_distance_rate: f32,
    pub(crate) window_middle_distance_rate: f32,
    pub(crate) window_nearest_edge_rate: f32,
    pub(crate) window_farthest_edge_rate: f32,
    pub(crate) shift_transition_rate: f32,
    pub(crate) continue_window_middle_distance_rate: f32,
    pub(crate) shift_global_middle_distance_rate: f32,
    pub(crate) episode_length_mean: f32,
    pub(crate) episode_length_p90: f32,
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct AudioStyleAdaptiveDistanceUProbeReport {
    pub(crate) record_count: usize,
    pub(crate) basin_count: usize,
    pub(crate) generation: u64,
    pub(crate) global_distance_band: (f32, f32, f32),
    pub(crate) policy_reports: Vec<AudioStyleAdaptiveDistanceUProbePolicyReport>,
    pub(crate) recommended_policy: &'static str,
    pub(crate) verdict: &'static str,
}

#[cfg(test)]
pub(crate) fn audio_style_current_stable_predictive_topology_probe_for_test(
    path: &Path,
    seed: u64,
) -> Result<AudioStylePredictiveTopologyProbeReport, String> {
    const POLICIES: [&str; 4] = [
        "support_only",
        "residency_penalty",
        "future_occupancy_reachability",
        "future_occupancy_reachability_with_residency",
    ];
    let snapshot = read_audio_style_stable_model(path)?;
    let state = snapshot.state.as_ref();
    let geometry = state
        .sampling_geometry
        .as_ref()
        .ok_or_else(|| "stable model has no sampling geometry".to_string())?;
    let keys = sorted_audio_style_embedding_keys(&state.embeddings);
    if keys.len() < 2 {
        return Err("stable model has too few embeddings for topology probe".to_string());
    }

    let key_to_index = keys
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, key)| (key, index))
        .collect::<HashMap<_, _>>();
    let embeddings = keys
        .iter()
        .map(|key| {
            state
                .embeddings
                .get(key)
                .ok_or_else(|| "stable model key is missing its embedding".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let embedding_norms = embeddings
        .iter()
        .map(|embedding| {
            embedding
                .values
                .iter()
                .map(|value| value * value)
                .sum::<f32>()
                .sqrt()
        })
        .collect::<Vec<_>>();

    let basin_ids = audio_style_probe_basin_ids(&keys, geometry);
    let basin_count = basin_ids.iter().copied().collect::<HashSet<_>>().len();
    let candidate_rows =
        audio_style_probe_candidate_rows(&keys, &key_to_index, &state.neighbor_index);
    let mut similarity_rows: HashMap<usize, Vec<(usize, f32)>> = HashMap::new();
    let reports = POLICIES
        .iter()
        .enumerate()
        .map(|(policy_index, policy)| {
            audio_style_simulate_predictive_topology_policy_for_test(
                policy,
                policy_index,
                seed,
                &keys,
                &embeddings,
                &embedding_norms,
                &candidate_rows,
                &mut similarity_rows,
                &basin_ids,
                basin_count,
                geometry,
            )
        })
        .collect::<Vec<_>>();

    let support_only = reports
        .iter()
        .find(|report| report.policy == "support_only")
        .ok_or_else(|| "probe did not produce support_only report".to_string())?;
    let recommended = reports
        .iter()
        .min_by(|left, right| {
            left.weak_attractor_pressure
                .total_cmp(&right.weak_attractor_pressure)
                .then_with(|| {
                    right
                        .tail_basin_entropy_norm
                        .total_cmp(&left.tail_basin_entropy_norm)
                })
                .then_with(|| {
                    right
                        .mean_selected_reachability
                        .total_cmp(&left.mean_selected_reachability)
                })
        })
        .ok_or_else(|| "probe did not produce policy reports".to_string())?;
    let weak_delta = recommended.weak_attractor_pressure - support_only.weak_attractor_pressure;
    let tail_delta = recommended.tail_largest_basin_share - support_only.tail_largest_basin_share;
    let cosine_delta = recommended.mean_adjacent_cosine - support_only.mean_adjacent_cosine;
    let recommended_policy = recommended.policy;
    let verdict = if recommended.policy == "future_occupancy_reachability_with_residency"
        && weak_delta <= -0.025
        && tail_delta <= 0.0
        && cosine_delta >= -0.025
    {
        "stable_topology_reachability_controls_log_like_weak_attractor"
    } else {
        "stable_topology_still_has_log_like_weak_attractor_risk"
    };

    Ok(AudioStylePredictiveTopologyProbeReport {
        record_count: keys.len(),
        basin_count,
        generation: snapshot.generation(),
        policy_reports: reports,
        recommended_policy,
        weak_attractor_pressure_delta_vs_support_only: weak_delta,
        tail_largest_basin_share_delta_vs_support_only: tail_delta,
        mean_adjacent_cosine_delta_vs_support_only: cosine_delta,
        verdict,
    })
}

#[cfg(test)]
pub(crate) fn audio_style_current_stable_adaptive_distance_u_probe_for_test(
    path: &Path,
    seed: u64,
    max_tracks: usize,
    run_count: usize,
) -> Result<AudioStyleAdaptiveDistanceUProbeReport, String> {
    const POLICIES: [&str; 3] = ["global_calibrated", "window_adaptive", "episodic_fatigue_u"];
    let snapshot = read_audio_style_stable_model(path)?;
    let state = snapshot.state.as_ref();
    let geometry = state
        .sampling_geometry
        .as_ref()
        .ok_or_else(|| "stable model has no sampling geometry".to_string())?;
    let mut keys = sorted_audio_style_embedding_keys(&state.embeddings);
    keys.truncate(max_tracks.max(2));
    if keys.len() < 2 {
        return Err("stable model has too few embeddings for adaptive distance probe".to_string());
    }

    let key_to_index = keys
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, key)| (key, index))
        .collect::<HashMap<_, _>>();
    let embeddings = keys
        .iter()
        .map(|key| {
            state
                .embeddings
                .get(key)
                .ok_or_else(|| "stable model key is missing its embedding".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let embedding_norms = embeddings
        .iter()
        .map(|embedding| {
            embedding
                .values
                .iter()
                .map(|value| value * value)
                .sum::<f32>()
                .sqrt()
        })
        .collect::<Vec<_>>();
    let basin_ids = audio_style_probe_basin_ids(&keys, geometry);
    let basin_count = basin_ids.iter().copied().collect::<HashSet<_>>().len();
    let candidate_rows =
        audio_style_probe_candidate_rows(&keys, &key_to_index, &state.neighbor_index);
    let mut similarity_rows = HashMap::new();
    let global_distribution = audio_style_adaptive_probe_global_distribution(
        &embeddings,
        &embedding_norms,
        &candidate_rows,
        &mut similarity_rows,
    );
    if global_distribution.is_empty() {
        return Err("stable model has no measurable adaptive distance distribution".to_string());
    }
    let global_band = audio_style_adaptive_probe_quantile_band(&global_distribution);

    let policy_reports = POLICIES
        .iter()
        .enumerate()
        .map(|(policy_index, policy)| {
            audio_style_adaptive_probe_policy_report(
                policy,
                policy_index,
                seed,
                run_count,
                &keys,
                &embeddings,
                &embedding_norms,
                &candidate_rows,
                &mut similarity_rows,
                &basin_ids,
                &global_distribution,
                global_band,
            )
        })
        .collect::<Vec<_>>();
    let episodic = policy_reports
        .iter()
        .find(|report| report.policy == "episodic_fatigue_u")
        .ok_or_else(|| "adaptive probe did not produce episodic report".to_string())?;
    let global = policy_reports
        .iter()
        .find(|report| report.policy == "global_calibrated")
        .ok_or_else(|| "adaptive probe did not produce global report".to_string())?;
    let window = policy_reports
        .iter()
        .find(|report| report.policy == "window_adaptive")
        .ok_or_else(|| "adaptive probe did not produce window report".to_string())?;
    let recommended_policy = episodic.policy;
    let verdict = if episodic.unique_sample_rate >= 1.0
        && episodic.sample_count_gini_proxy <= 0.0
        && episodic.continue_window_middle_distance_rate > episodic.global_middle_distance_rate
        && episodic.shift_global_middle_distance_rate > episodic.window_middle_distance_rate
        && episodic.shift_global_middle_distance_rate > global.window_middle_distance_rate
        && episodic.episode_length_p90 <= AUDIO_STYLE_PROGRAMMATIC_EPISODE_SHIFT_RUN as f32
        && episodic.warm_window_largest_basin_share_max
            <= global
                .warm_window_largest_basin_share_max
                .max(window.warm_window_largest_basin_share_max)
    {
        "stable_adaptive_distance_u_reproduces_programmatic_coverage_episode_shift"
    } else {
        "stable_adaptive_distance_u_did_not_reproduce_programmatic_coverage_episode_shift"
    };

    Ok(AudioStyleAdaptiveDistanceUProbeReport {
        record_count: keys.len(),
        basin_count,
        generation: snapshot.generation(),
        global_distance_band: (global_band.low, global_band.target, global_band.high),
        policy_reports,
        recommended_policy,
        verdict,
    })
}

#[cfg(test)]
fn audio_style_probe_basin_ids(
    keys: &[PlaybackTrackKey],
    geometry: &AudioStyleSamplingGeometry,
) -> Vec<usize> {
    let mut basin_to_id = HashMap::new();
    let mut next_id = 0usize;
    keys.iter()
        .map(|key| {
            let basin = geometry.self_supervised_basins.get(key).cloned().unwrap_or(
                PlaybackAttractorBasinKey {
                    value: "audio-basin:unknown".to_string(),
                },
            );
            *basin_to_id.entry(basin).or_insert_with(|| {
                let id = next_id;
                next_id += 1;
                id
            })
        })
        .collect()
}

#[cfg(test)]
#[derive(Clone, Copy)]
struct AudioStyleAdaptiveProbeRunMetrics {
    unique_sample_rate: f32,
    sample_count_gini_proxy: f32,
    same_basin_transition_rate: f32,
    max_basin_run_length: f32,
    warm_window_largest_basin_share_p90: f32,
    warm_window_largest_basin_share_max: f32,
    global_middle_distance_rate: f32,
    window_middle_distance_rate: f32,
    window_nearest_edge_rate: f32,
    window_farthest_edge_rate: f32,
    shift_transition_rate: f32,
    continue_window_middle_distance_rate: f32,
    shift_global_middle_distance_rate: f32,
    episode_length_mean: f32,
    episode_length_p90: f32,
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum AudioStyleAdaptiveProbePhase {
    Flat,
    Continue,
    Shift,
}

#[cfg(test)]
fn audio_style_adaptive_probe_global_distribution(
    embeddings: &[&Arc<AudioStyleEmbedding>],
    embedding_norms: &[f32],
    candidate_rows: &[Vec<usize>],
    similarity_rows: &mut HashMap<usize, Vec<(usize, f32)>>,
) -> Vec<f32> {
    let mut values = Vec::new();
    for current in 0..embeddings.len() {
        let row = audio_style_probe_similarity_row(
            current,
            embeddings,
            embedding_norms,
            candidate_rows,
            similarity_rows,
        );
        values.extend(
            row.into_iter()
                .map(|(_candidate, similarity)| ((1.0 - similarity) * 0.5).clamp(0.0, 1.0)),
        );
    }
    values.sort_by(|left, right| left.total_cmp(right));
    values
}

#[cfg(test)]
fn audio_style_adaptive_probe_quantile_band(
    sorted_values: &[f32],
) -> AudioStyleProgrammaticDistanceBand {
    let mut band = AudioStyleProgrammaticDistanceBand {
        low: sorted_quantile(
            sorted_values,
            AUDIO_STYLE_PROGRAMMATIC_DISTANCE_LOW_QUANTILE,
        ),
        target: sorted_quantile(
            sorted_values,
            AUDIO_STYLE_PROGRAMMATIC_DISTANCE_TARGET_QUANTILE,
        ),
        high: sorted_quantile(
            sorted_values,
            AUDIO_STYLE_PROGRAMMATIC_DISTANCE_HIGH_QUANTILE,
        ),
    };
    if band.high - band.low < AUDIO_STYLE_PROGRAMMATIC_DISTANCE_MIN_WIDTH {
        let half_width = AUDIO_STYLE_PROGRAMMATIC_DISTANCE_MIN_WIDTH * 0.5;
        band.low = (band.target - half_width).clamp(0.0, 1.0);
        band.high = (band.target + half_width).clamp(0.0, 1.0);
    }
    band
}

#[cfg(test)]
fn audio_style_adaptive_probe_policy_report(
    policy: &'static str,
    policy_index: usize,
    seed: u64,
    run_count: usize,
    keys: &[PlaybackTrackKey],
    embeddings: &[&Arc<AudioStyleEmbedding>],
    embedding_norms: &[f32],
    candidate_rows: &[Vec<usize>],
    similarity_rows: &mut HashMap<usize, Vec<(usize, f32)>>,
    basin_ids: &[usize],
    global_distribution: &[f32],
    global_band: AudioStyleProgrammaticDistanceBand,
) -> AudioStyleAdaptiveDistanceUProbePolicyReport {
    let metrics = (0..run_count.max(1))
        .map(|run_index| {
            audio_style_adaptive_probe_run(
                policy,
                seed.wrapping_add(1_000_003 * run_index as u64)
                    .wrapping_add(1019 * policy_index as u64),
                keys,
                embeddings,
                embedding_norms,
                candidate_rows,
                similarity_rows,
                basin_ids,
                global_distribution,
                global_band,
            )
        })
        .collect::<Vec<_>>();
    AudioStyleAdaptiveDistanceUProbePolicyReport {
        policy,
        unique_sample_rate: audio_style_adaptive_probe_mean_metric(&metrics, |m| {
            m.unique_sample_rate
        }),
        sample_count_gini_proxy: audio_style_adaptive_probe_mean_metric(&metrics, |m| {
            m.sample_count_gini_proxy
        }),
        same_basin_transition_rate: audio_style_adaptive_probe_mean_metric(&metrics, |m| {
            m.same_basin_transition_rate
        }),
        max_basin_run_length: audio_style_adaptive_probe_mean_metric(&metrics, |m| {
            m.max_basin_run_length
        }),
        warm_window_largest_basin_share_p90: audio_style_adaptive_probe_mean_metric(
            &metrics,
            |m| m.warm_window_largest_basin_share_p90,
        ),
        warm_window_largest_basin_share_max: audio_style_adaptive_probe_mean_metric(
            &metrics,
            |m| m.warm_window_largest_basin_share_max,
        ),
        global_middle_distance_rate: audio_style_adaptive_probe_mean_metric(&metrics, |m| {
            m.global_middle_distance_rate
        }),
        window_middle_distance_rate: audio_style_adaptive_probe_mean_metric(&metrics, |m| {
            m.window_middle_distance_rate
        }),
        window_nearest_edge_rate: audio_style_adaptive_probe_mean_metric(&metrics, |m| {
            m.window_nearest_edge_rate
        }),
        window_farthest_edge_rate: audio_style_adaptive_probe_mean_metric(&metrics, |m| {
            m.window_farthest_edge_rate
        }),
        shift_transition_rate: audio_style_adaptive_probe_mean_metric(&metrics, |m| {
            m.shift_transition_rate
        }),
        continue_window_middle_distance_rate: audio_style_adaptive_probe_mean_metric(
            &metrics,
            |m| m.continue_window_middle_distance_rate,
        ),
        shift_global_middle_distance_rate: audio_style_adaptive_probe_mean_metric(&metrics, |m| {
            m.shift_global_middle_distance_rate
        }),
        episode_length_mean: audio_style_adaptive_probe_mean_metric(&metrics, |m| {
            m.episode_length_mean
        }),
        episode_length_p90: audio_style_adaptive_probe_mean_metric(&metrics, |m| {
            m.episode_length_p90
        }),
    }
}

#[cfg(test)]
fn audio_style_adaptive_probe_run(
    policy: &str,
    seed: u64,
    keys: &[PlaybackTrackKey],
    embeddings: &[&Arc<AudioStyleEmbedding>],
    embedding_norms: &[f32],
    candidate_rows: &[Vec<usize>],
    similarity_rows: &mut HashMap<usize, Vec<(usize, f32)>>,
    basin_ids: &[usize],
    global_distribution: &[f32],
    global_band: AudioStyleProgrammaticDistanceBand,
) -> AudioStyleAdaptiveProbeRunMetrics {
    let mut rng = seed;
    let mut current = audio_style_probe_rng_index(&mut rng, keys.len());
    let mut remaining = vec![true; keys.len()];
    remaining[current] = false;
    let mut order = vec![current];
    let mut selected_novelties = Vec::with_capacity(keys.len().saturating_sub(1));
    let mut selected_global_percentiles = Vec::with_capacity(keys.len().saturating_sub(1));
    let mut selected_window_percentiles = Vec::with_capacity(keys.len().saturating_sub(1));
    let mut phases = Vec::with_capacity(keys.len().saturating_sub(1));
    let mut episode_age = 1usize;
    let mut fatigue = 0.0_f32;

    while remaining.iter().any(|value| *value) {
        let shift_phase = policy == "episodic_fatigue_u"
            && (episode_age >= AUDIO_STYLE_PROGRAMMATIC_EPISODE_SHIFT_RUN
                || fatigue >= AUDIO_STYLE_PROGRAMMATIC_EPISODE_FATIGUE_SHIFT);
        let pool = audio_style_adaptive_probe_candidate_pool(
            current,
            shift_phase,
            &remaining,
            embeddings,
            embedding_norms,
            candidate_rows,
            similarity_rows,
            global_band.target,
        );
        if pool.is_empty() {
            break;
        }
        let pool_novelties = pool
            .iter()
            .map(|candidate| {
                audio_style_probe_raw_cosine(
                    embeddings[current].as_ref(),
                    embeddings[*candidate].as_ref(),
                    embedding_norms[current],
                    embedding_norms[*candidate],
                )
                .map(|similarity| ((1.0 - similarity) * 0.5).clamp(0.0, 1.0))
                .unwrap_or(1.0)
            })
            .collect::<Vec<_>>();
        let mut sorted_pool_novelties = pool_novelties.clone();
        sorted_pool_novelties.sort_by(|left, right| left.total_cmp(right));
        let window_band = audio_style_adaptive_probe_quantile_band(&sorted_pool_novelties);
        let active_band = match policy {
            "global_calibrated" => global_band,
            "window_adaptive" => window_band,
            "episodic_fatigue_u" if shift_phase => global_band,
            "episodic_fatigue_u" => window_band,
            _ => window_band,
        };
        let scores = pool
            .iter()
            .zip(pool_novelties.iter())
            .map(|(candidate, novelty)| {
                let same_basin = basin_ids[*candidate] == basin_ids[current];
                let mut score = match policy {
                    "episodic_fatigue_u" if shift_phase => {
                        AUDIO_STYLE_PROGRAMMATIC_SHIFT_NOVELTY_STRENGTH
                            * audio_style_programmatic_inverted_u_score(*novelty, active_band)
                            - if same_basin {
                                AUDIO_STYLE_PROGRAMMATIC_SHIFT_SAME_BASIN_PENALTY
                            } else {
                                0.0
                            }
                    }
                    "episodic_fatigue_u" => {
                        AUDIO_STYLE_PROGRAMMATIC_CONTINUE_NOVELTY_STRENGTH
                            * audio_style_programmatic_inverted_u_score(*novelty, active_band)
                            + if same_basin {
                                AUDIO_STYLE_PROGRAMMATIC_CONTINUE_SAME_BASIN_BONUS
                            } else {
                                0.0
                            }
                    }
                    _ => {
                        AUDIO_STYLE_PROGRAMMATIC_CONTINUE_NOVELTY_STRENGTH
                            * audio_style_programmatic_inverted_u_score(*novelty, active_band)
                            + if same_basin { 0.20 } else { 0.0 }
                    }
                };
                score -= AUDIO_STYLE_PROGRAMMATIC_WINDOW_CAPACITY_STRENGTH
                    * audio_style_adaptive_probe_capacity_violation(basin_ids, &order, *candidate);
                score += AUDIO_STYLE_PROGRAMMATIC_FUTURE_REBALANCE_STRENGTH
                    * audio_style_adaptive_probe_remaining_collapse_pressure(
                        basin_ids, &remaining, *candidate,
                    );
                (*candidate, score)
            })
            .collect::<Vec<_>>();
        let selected = audio_style_adaptive_probe_weighted_choice(&scores, &mut rng);
        let selected_novelty = audio_style_probe_raw_cosine(
            embeddings[current].as_ref(),
            embeddings[selected].as_ref(),
            embedding_norms[current],
            embedding_norms[selected],
        )
        .map(|similarity| ((1.0 - similarity) * 0.5).clamp(0.0, 1.0))
        .unwrap_or(1.0);
        let same_selected_basin = basin_ids[selected] == basin_ids[current];
        selected_novelties.push(selected_novelty);
        selected_global_percentiles.push(audio_style_adaptive_probe_percentile(
            global_distribution,
            selected_novelty,
        ));
        selected_window_percentiles.push(audio_style_adaptive_probe_percentile(
            &sorted_pool_novelties,
            selected_novelty,
        ));
        phases.push(if policy == "episodic_fatigue_u" {
            if shift_phase {
                AudioStyleAdaptiveProbePhase::Shift
            } else {
                AudioStyleAdaptiveProbePhase::Continue
            }
        } else {
            AudioStyleAdaptiveProbePhase::Flat
        });
        if policy == "episodic_fatigue_u" {
            if shift_phase {
                episode_age = 1;
                fatigue = 0.0;
            } else {
                episode_age += 1;
                fatigue += (0.235 - selected_novelty).max(0.0) * 4.0
                    + if same_selected_basin { 0.24 } else { 0.05 };
            }
        }
        current = selected;
        remaining[selected] = false;
        order.push(selected);
    }

    audio_style_adaptive_probe_order_metrics(
        &order,
        basin_ids,
        &selected_global_percentiles,
        &selected_window_percentiles,
        &phases,
    )
}

#[cfg(test)]
fn audio_style_adaptive_probe_candidate_pool(
    current: usize,
    shift_phase: bool,
    remaining: &[bool],
    embeddings: &[&Arc<AudioStyleEmbedding>],
    embedding_norms: &[f32],
    candidate_rows: &[Vec<usize>],
    similarity_rows: &mut HashMap<usize, Vec<(usize, f32)>>,
    target_novelty: f32,
) -> Vec<usize> {
    const CANDIDATE_COUNT: usize = 96;
    let row = audio_style_probe_similarity_row(
        current,
        embeddings,
        embedding_norms,
        candidate_rows,
        similarity_rows,
    );
    let mut scored = row
        .into_iter()
        .filter(|(candidate, _)| remaining.get(*candidate).copied().unwrap_or(false))
        .map(|(candidate, similarity)| {
            let novelty = ((1.0 - similarity) * 0.5).clamp(0.0, 1.0);
            let score = if shift_phase {
                -((novelty - target_novelty).abs())
            } else {
                similarity
            };
            (score, candidate)
        })
        .collect::<Vec<_>>();
    if scored.len() < CANDIDATE_COUNT {
        for candidate in 0..remaining.len() {
            if !remaining[candidate] || scored.iter().any(|(_, existing)| *existing == candidate) {
                continue;
            }
            let Some(similarity) = audio_style_probe_raw_cosine(
                embeddings[current].as_ref(),
                embeddings[candidate].as_ref(),
                embedding_norms[current],
                embedding_norms[candidate],
            ) else {
                continue;
            };
            let novelty = ((1.0 - similarity) * 0.5).clamp(0.0, 1.0);
            let score = if shift_phase {
                -((novelty - target_novelty).abs())
            } else {
                similarity
            };
            scored.push((score, candidate));
            if scored.len() >= CANDIDATE_COUNT {
                break;
            }
        }
    }
    scored.sort_by(|left, right| {
        right
            .0
            .total_cmp(&left.0)
            .then_with(|| left.1.cmp(&right.1))
    });
    scored
        .into_iter()
        .take(CANDIDATE_COUNT)
        .map(|(_, candidate)| candidate)
        .collect()
}

#[cfg(test)]
fn audio_style_adaptive_probe_capacity_violation(
    basin_ids: &[usize],
    order: &[usize],
    candidate: usize,
) -> f32 {
    if order.len() < AUDIO_STYLE_PROGRAMMATIC_ROUTE_CAPACITY_WARMUP {
        return 0.0;
    }
    let candidate_basin = basin_ids[candidate];
    let recent_start = order
        .len()
        .saturating_sub(AUDIO_STYLE_PROGRAMMATIC_ROUTE_CAPACITY_WINDOW);
    let recent = &order[recent_start..];
    let projected_len = (recent.len() + 1).min(AUDIO_STYLE_PROGRAMMATIC_ROUTE_CAPACITY_WINDOW);
    let projected_count = recent
        .iter()
        .filter(|index| basin_ids[**index] == candidate_basin)
        .count()
        + 1;
    let support_share = basin_ids
        .iter()
        .filter(|basin| **basin == candidate_basin)
        .count() as f32
        / basin_ids.len().max(1) as f32;
    let projected_share = projected_count as f32 / projected_len.max(1) as f32;
    (projected_share - route_window_capacity_share(support_share, projected_len)).max(0.0)
}

#[cfg(test)]
fn audio_style_adaptive_probe_remaining_collapse_pressure(
    basin_ids: &[usize],
    remaining: &[bool],
    candidate: usize,
) -> f32 {
    let remaining_count = remaining.iter().filter(|value| **value).count();
    if remaining_count == 0 {
        return 0.0;
    }
    let mut counts = HashMap::<usize, usize>::new();
    for (index, is_remaining) in remaining.iter().copied().enumerate() {
        if is_remaining {
            *counts.entry(basin_ids[index]).or_insert(0) += 1;
        }
    }
    let Some((dominant_basin, dominant_count)) = counts
        .into_iter()
        .max_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)))
    else {
        return 0.0;
    };
    let remaining_share = dominant_count as f32 / remaining_count.max(1) as f32;
    let support_share = basin_ids
        .iter()
        .filter(|basin| **basin == dominant_basin)
        .count() as f32
        / basin_ids.len().max(1) as f32;
    let slack = (remaining_count as f32 * support_share).max(1.0).sqrt() / remaining_count as f32;
    let pressure = (remaining_share - support_share - slack).max(0.0);
    if pressure <= 0.0 {
        0.0
    } else if basin_ids[candidate] == dominant_basin {
        pressure
    } else {
        -pressure
    }
}

#[cfg(test)]
fn audio_style_adaptive_probe_weighted_choice(scored: &[(usize, f32)], rng: &mut u64) -> usize {
    let weights = scored
        .iter()
        .map(|(_, score)| score.clamp(-4.0, 3.0).exp())
        .collect::<Vec<_>>();
    let total = weights.iter().copied().sum::<f32>();
    if total <= 0.0 || !total.is_finite() {
        return scored.first().map(|(index, _)| *index).unwrap_or(0);
    }
    let mut cursor = audio_style_probe_rng_unit(rng) * total;
    for ((index, _), weight) in scored.iter().zip(weights.iter().copied()) {
        cursor -= weight;
        if cursor <= 0.0 {
            return *index;
        }
    }
    scored.last().map(|(index, _)| *index).unwrap_or(0)
}

#[cfg(test)]
fn audio_style_adaptive_probe_percentile(sorted_values: &[f32], value: f32) -> f32 {
    if sorted_values.is_empty() {
        return 0.0;
    }
    let mut lo = 0usize;
    let mut hi = sorted_values.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if sorted_values[mid] <= value {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo as f32 / sorted_values.len().max(1) as f32
}

#[cfg(test)]
fn audio_style_adaptive_probe_order_metrics(
    order: &[usize],
    basin_ids: &[usize],
    global_percentiles: &[f32],
    window_percentiles: &[f32],
    phases: &[AudioStyleAdaptiveProbePhase],
) -> AudioStyleAdaptiveProbeRunMetrics {
    let basin_order = order
        .iter()
        .map(|index| basin_ids[*index])
        .collect::<Vec<_>>();
    let mut runs = Vec::new();
    let mut start = 0usize;
    while start < basin_order.len() {
        let mut end = start + 1;
        while end < basin_order.len() && basin_order[end] == basin_order[start] {
            end += 1;
        }
        runs.push((end - start) as f32);
        start = end;
    }
    let mut window_shares = Vec::new();
    for index in 0..basin_order.len() {
        let start = (index + 1).saturating_sub(AUDIO_STYLE_PROGRAMMATIC_ROUTE_CAPACITY_WINDOW);
        let mut counts = HashMap::<usize, usize>::new();
        for basin in &basin_order[start..=index] {
            *counts.entry(*basin).or_insert(0) += 1;
        }
        window_shares
            .push(counts.values().copied().max().unwrap_or(0) as f32 / (index - start + 1) as f32);
    }
    let warm_window_shares = window_shares
        .iter()
        .copied()
        .skip(AUDIO_STYLE_PROGRAMMATIC_ROUTE_CAPACITY_WINDOW.saturating_sub(1))
        .collect::<Vec<_>>();
    let mut sample_counts = HashMap::<usize, usize>::new();
    for index in order {
        *sample_counts.entry(*index).or_insert(0) += 1;
    }
    let min_count = sample_counts.values().copied().min().unwrap_or(0);
    let max_count = sample_counts.values().copied().max().unwrap_or(0);
    let continue_positions = phases
        .iter()
        .enumerate()
        .filter_map(|(index, phase)| {
            (*phase == AudioStyleAdaptiveProbePhase::Continue).then_some(index)
        })
        .collect::<Vec<_>>();
    let shift_positions = phases
        .iter()
        .enumerate()
        .filter_map(|(index, phase)| {
            (*phase == AudioStyleAdaptiveProbePhase::Shift).then_some(index)
        })
        .collect::<Vec<_>>();
    let mut episode_lengths = Vec::new();
    let mut current_episode_len = 1usize;
    for phase in phases {
        if *phase == AudioStyleAdaptiveProbePhase::Shift {
            episode_lengths.push(current_episode_len as f32);
            current_episode_len = 1;
        } else {
            current_episode_len += 1;
        }
    }
    episode_lengths.push(current_episode_len as f32);

    AudioStyleAdaptiveProbeRunMetrics {
        unique_sample_rate: sample_counts.len() as f32 / basin_ids.len().max(1) as f32,
        sample_count_gini_proxy: max_count.saturating_sub(min_count) as f32,
        same_basin_transition_rate: basin_order
            .windows(2)
            .filter(|pair| pair[0] == pair[1])
            .count() as f32
            / basin_order.len().saturating_sub(1).max(1) as f32,
        max_basin_run_length: runs.iter().copied().fold(0.0, f32::max),
        warm_window_largest_basin_share_p90: audio_style_probe_percentile_f32(
            &warm_window_shares,
            0.90,
        ),
        warm_window_largest_basin_share_max: warm_window_shares.iter().copied().fold(0.0, f32::max),
        global_middle_distance_rate: audio_style_adaptive_probe_rate(global_percentiles, |value| {
            (0.35..=0.65).contains(&value)
        }),
        window_middle_distance_rate: audio_style_adaptive_probe_rate(window_percentiles, |value| {
            (0.35..=0.65).contains(&value)
        }),
        window_nearest_edge_rate: audio_style_adaptive_probe_rate(window_percentiles, |value| {
            value < 0.15
        }),
        window_farthest_edge_rate: audio_style_adaptive_probe_rate(window_percentiles, |value| {
            value > 0.85
        }),
        shift_transition_rate: shift_positions.len() as f32 / phases.len().max(1) as f32,
        continue_window_middle_distance_rate: audio_style_adaptive_probe_indexed_rate(
            window_percentiles,
            &continue_positions,
            |value| (0.35..=0.65).contains(&value),
        ),
        shift_global_middle_distance_rate: audio_style_adaptive_probe_indexed_rate(
            global_percentiles,
            &shift_positions,
            |value| (0.35..=0.65).contains(&value),
        ),
        episode_length_mean: audio_style_probe_mean(&episode_lengths),
        episode_length_p90: audio_style_probe_percentile_f32(&episode_lengths, 0.90),
    }
}

#[cfg(test)]
fn audio_style_adaptive_probe_rate(values: &[f32], predicate: impl Fn(f32) -> bool) -> f32 {
    values
        .iter()
        .copied()
        .filter(|value| predicate(*value))
        .count() as f32
        / values.len().max(1) as f32
}

#[cfg(test)]
fn audio_style_adaptive_probe_indexed_rate(
    values: &[f32],
    indices: &[usize],
    predicate: impl Fn(f32) -> bool,
) -> f32 {
    indices
        .iter()
        .filter(|index| values.get(**index).copied().is_some_and(&predicate))
        .count() as f32
        / indices.len().max(1) as f32
}

#[cfg(test)]
fn audio_style_adaptive_probe_mean_metric(
    metrics: &[AudioStyleAdaptiveProbeRunMetrics],
    selector: impl Fn(AudioStyleAdaptiveProbeRunMetrics) -> f32,
) -> f32 {
    metrics.iter().copied().map(selector).sum::<f32>() / metrics.len().max(1) as f32
}

#[cfg(test)]
fn audio_style_probe_percentile_f32(values: &[f32], q: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.total_cmp(right));
    sorted_quantile(&sorted, q)
}

#[cfg(test)]
fn audio_style_probe_candidate_rows(
    keys: &[PlaybackTrackKey],
    key_to_index: &HashMap<PlaybackTrackKey, usize>,
    neighbor_index: &AudioStyleNeighborIndex,
) -> Vec<Vec<usize>> {
    keys.iter()
        .enumerate()
        .map(|(index, key)| {
            let mut row = neighbor_index
                .neighbors
                .get(key)
                .into_iter()
                .flatten()
                .filter_map(|neighbor| key_to_index.get(neighbor).copied())
                .filter(|neighbor_index| *neighbor_index != index)
                .take(128)
                .collect::<Vec<_>>();
            if row.is_empty() {
                row = (0..keys.len())
                    .filter(|candidate_index| *candidate_index != index)
                    .take(128)
                    .collect();
            }
            row
        })
        .collect()
}

#[cfg(test)]
fn audio_style_simulate_predictive_topology_policy_for_test(
    policy: &'static str,
    policy_index: usize,
    seed: u64,
    keys: &[PlaybackTrackKey],
    embeddings: &[&Arc<AudioStyleEmbedding>],
    embedding_norms: &[f32],
    candidate_rows: &[Vec<usize>],
    similarity_rows: &mut HashMap<usize, Vec<(usize, f32)>>,
    basin_ids: &[usize],
    basin_count: usize,
    geometry: &AudioStyleSamplingGeometry,
) -> AudioStylePredictiveTopologyProbePolicyReport {
    let mut rng = seed.wrapping_add(1009 * policy_index as u64);
    let mut selected_basins = Vec::with_capacity(96 * 120);
    let mut adjacent_cosines = Vec::with_capacity(96 * 120);
    let mut selected_reachability = Vec::with_capacity(96 * 120);
    let mut selected_future_entropy = Vec::with_capacity(96 * 120);
    let mut run_lengths = Vec::with_capacity(96 * 121);
    let mut same_basin_transitions = 0usize;
    let mut revisit_transitions = 0usize;
    let mut transitions = 0usize;

    for _ in 0..96 {
        let mut current = audio_style_probe_rng_index(&mut rng, keys.len());
        let mut recent_basins = VecDeque::with_capacity(24);
        let mut basin_usage = vec![0.0_f32; basin_count.max(1)];
        let mut current_basin = basin_ids[current];
        let mut current_basin_run = 1usize;
        run_lengths.push(current_basin_run);

        for _ in 0..120 {
            let row = audio_style_probe_similarity_row(
                current,
                embeddings,
                embedding_norms,
                candidate_rows,
                similarity_rows,
            );
            if row.is_empty() {
                current = audio_style_probe_rng_index(&mut rng, keys.len());
                current_basin = basin_ids[current];
                current_basin_run = 1;
                continue;
            }
            let probabilities = audio_style_probe_candidate_probabilities(
                policy,
                current,
                &row,
                keys,
                basin_ids,
                &basin_usage,
                current_basin_run,
                geometry,
            );
            let choice_offset = audio_style_probe_select_weighted_index(
                &probabilities,
                audio_style_probe_rng_unit(&mut rng),
            );
            let (choice, adjacent_cosine) = row[choice_offset];
            let choice_basin = basin_ids[choice];
            let descriptor = geometry.future_occupancy_for_key(&keys[choice]).unwrap_or(
                AudioStyleFutureOccupancyDescriptor {
                    reachability: 0.0,
                    future_entropy: 0.0,
                    same_basin_neighbor_share: 1.0,
                },
            );

            adjacent_cosines.push(adjacent_cosine);
            selected_reachability.push(descriptor.reachability);
            selected_future_entropy.push(descriptor.future_entropy);
            if choice_basin == current_basin {
                same_basin_transitions += 1;
                current_basin_run += 1;
            } else {
                current_basin_run = 1;
            }
            if recent_basins.contains(&choice_basin) {
                revisit_transitions += 1;
            }
            transitions += 1;

            for usage in &mut basin_usage {
                *usage *= 0.90;
            }
            if let Some(usage) = basin_usage.get_mut(choice_basin) {
                *usage += 1.0;
            }
            if recent_basins.len() == 24 {
                recent_basins.pop_front();
            }
            recent_basins.push_back(choice_basin);
            selected_basins.push(choice_basin);
            run_lengths.push(current_basin_run);
            current = choice;
            current_basin = choice_basin;
        }
    }

    let _basin_counts = audio_style_probe_counts(&selected_basins);
    let tail_start = ((selected_basins.len() as f32) * 0.70) as usize;
    let tail_counts = audio_style_probe_counts(&selected_basins[tail_start..]);
    let tail_total = selected_basins.len().saturating_sub(tail_start).max(1);
    let tail_largest_basin_share =
        tail_counts.values().copied().max().unwrap_or(0) as f32 / tail_total as f32;
    let tail_basin_entropy_norm = audio_style_probe_entropy_norm(&tail_counts);
    let revisit_rate = revisit_transitions as f32 / transitions.max(1) as f32;
    let weak_attractor_pressure = 1.45 * (tail_largest_basin_share - 0.075).max(0.0)
        + 0.78 * (0.74 - tail_basin_entropy_norm).max(0.0)
        + 0.24 * (audio_style_probe_percentile_usize(&run_lengths, 0.95) - 3.0).max(0.0) / 6.0
        + 0.54 * (revisit_rate - 0.26).max(0.0);

    AudioStylePredictiveTopologyProbePolicyReport {
        policy,
        tail_largest_basin_share,
        tail_basin_entropy_norm,
        basin_run_p95: audio_style_probe_percentile_usize(&run_lengths, 0.95),
        basin_run_p99: audio_style_probe_percentile_usize(&run_lengths, 0.99),
        same_basin_transition_rate: same_basin_transitions as f32 / transitions.max(1) as f32,
        revisit_basin_transition_rate: revisit_rate,
        mean_adjacent_cosine: audio_style_probe_mean(&adjacent_cosines),
        mean_selected_reachability: audio_style_probe_mean(&selected_reachability),
        mean_selected_future_entropy: audio_style_probe_mean(&selected_future_entropy),
        weak_attractor_pressure,
    }
}

#[cfg(test)]
fn audio_style_probe_similarity_row(
    current: usize,
    embeddings: &[&Arc<AudioStyleEmbedding>],
    embedding_norms: &[f32],
    candidate_rows: &[Vec<usize>],
    similarity_rows: &mut HashMap<usize, Vec<(usize, f32)>>,
) -> Vec<(usize, f32)> {
    if let Some(row) = similarity_rows.get(&current) {
        return row.clone();
    }
    let row = candidate_rows
        .get(current)
        .into_iter()
        .flatten()
        .copied()
        .filter_map(|candidate| {
            let similarity = audio_style_probe_raw_cosine(
                embeddings[current].as_ref(),
                embeddings[candidate].as_ref(),
                embedding_norms[current],
                embedding_norms[candidate],
            )?;
            Some((candidate, similarity))
        })
        .collect::<Vec<_>>();
    similarity_rows.insert(current, row.clone());
    row
}

#[cfg(test)]
fn audio_style_probe_raw_cosine(
    left: &AudioStyleEmbedding,
    right: &AudioStyleEmbedding,
    left_norm: f32,
    right_norm: f32,
) -> Option<f32> {
    if left_norm <= 1.0e-6 || right_norm <= 1.0e-6 {
        return None;
    }
    let dot = left
        .values
        .iter()
        .zip(right.values.iter())
        .map(|(left, right)| left * right)
        .sum::<f32>();
    Some((dot / (left_norm * right_norm)).clamp(-1.0, 1.0))
}

#[cfg(test)]
fn audio_style_probe_candidate_probabilities(
    policy: &str,
    current: usize,
    candidates: &[(usize, f32)],
    keys: &[PlaybackTrackKey],
    basin_ids: &[usize],
    basin_usage: &[f32],
    current_basin_run: usize,
    geometry: &AudioStyleSamplingGeometry,
) -> Vec<f32> {
    let current_basin = basin_ids[current];
    let usage_total = basin_usage.iter().copied().sum::<f32>().max(1.0);
    let mut scores = candidates
        .iter()
        .map(|(candidate, similarity)| {
            let candidate_basin = basin_ids[*candidate];
            let mut score = 9.0 * *similarity;
            if matches!(
                policy,
                "residency_penalty" | "future_occupancy_reachability_with_residency"
            ) {
                let basin_pressure =
                    basin_usage.get(candidate_basin).copied().unwrap_or(0.0) / usage_total;
                let same_basin = if candidate_basin == current_basin {
                    1.0
                } else {
                    0.0
                };
                score -= 1.35 * basin_pressure;
                score -= 0.38 * same_basin * (current_basin_run as f32).ln_1p();
            }
            score
        })
        .collect::<Vec<_>>();

    if matches!(
        policy,
        "future_occupancy_reachability" | "future_occupancy_reachability_with_residency"
    ) {
        let denom = candidates.len().saturating_sub(1).max(1) as f32;
        let future_scores = candidates
            .iter()
            .enumerate()
            .map(|(rank, (candidate, _))| {
                let candidate_basin = basin_ids[*candidate];
                let descriptor = geometry
                    .future_occupancy_for_key(&keys[*candidate])
                    .unwrap_or(AudioStyleFutureOccupancyDescriptor {
                        reachability: 0.0,
                        future_entropy: 0.0,
                        same_basin_neighbor_share: 1.0,
                    });
                let rank_position = rank as f32 / denom;
                let continuity_band =
                    (1.0 - ((rank_position - 0.64) / 0.42).powi(2)).clamp(-1.0, 1.0);
                let manifold_load = geometry
                    .manifold_for_key(&keys[*candidate])
                    .map(|manifold| {
                        0.38 * manifold.boundary_pressure.clamp(0.0, 1.0)
                            + 0.32 * manifold.curvature.clamp(0.0, 1.0)
                            + 0.30 / manifold.spectral_rank.max(1.0).sqrt()
                    })
                    .unwrap_or(0.30);
                let same_basin_run_penalty = if candidate_basin == current_basin {
                    AUDIO_STYLE_FUTURE_OCCUPANCY_SAME_BASIN_RUN_STRENGTH
                        * (current_basin_run.max(1) as f32).ln_1p()
                        * descriptor.same_basin_neighbor_share
                } else {
                    0.0
                };

                AUDIO_STYLE_FUTURE_OCCUPANCY_REACHABILITY_STRENGTH
                    * (descriptor.reachability - 0.60)
                    + AUDIO_STYLE_FUTURE_OCCUPANCY_ENTROPY_STRENGTH
                        * (descriptor.future_entropy - 0.50)
                    + AUDIO_STYLE_FUTURE_OCCUPANCY_CONTINUITY_BAND_STRENGTH * continuity_band
                    - AUDIO_STYLE_FUTURE_OCCUPANCY_MANIFOLD_LOAD_STRENGTH * manifold_load
                    - same_basin_run_penalty
            })
            .collect::<Vec<_>>();
        let center = future_scores.iter().copied().sum::<f32>() / future_scores.len().max(1) as f32;
        for (score, future_score) in scores.iter_mut().zip(future_scores.into_iter()) {
            *score += (future_score - center).clamp(-1.20, 1.10);
        }
    }

    let max_score = scores.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut total = 0.0_f32;
    for score in &mut scores {
        *score = (*score - max_score).clamp(-80.0, 40.0).exp();
        total += *score;
    }
    if total <= 1.0e-8 || !total.is_finite() {
        return vec![1.0 / candidates.len().max(1) as f32; candidates.len()];
    }
    let floor = 0.006 / candidates.len().max(1) as f32;
    scores
        .into_iter()
        .map(|weight| (1.0 - 0.006) * (weight / total) + floor)
        .collect()
}

#[cfg(test)]
fn audio_style_probe_select_weighted_index(weights: &[f32], draw_unit: f32) -> usize {
    let total = weights.iter().copied().sum::<f32>();
    let mut cursor = draw_unit.clamp(0.0, 0.999_999) * total;
    for (index, weight) in weights.iter().copied().enumerate() {
        if cursor <= weight {
            return index;
        }
        cursor -= weight;
    }
    weights.len().saturating_sub(1)
}

#[cfg(test)]
fn audio_style_probe_rng_next(state: &mut u64) -> u64 {
    *state = state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    *state
}

#[cfg(test)]
fn audio_style_probe_rng_unit(state: &mut u64) -> f32 {
    ((audio_style_probe_rng_next(state) >> 40) as f32) / ((1u64 << 24) as f32)
}

#[cfg(test)]
fn audio_style_probe_rng_index(state: &mut u64, len: usize) -> usize {
    (audio_style_probe_rng_next(state) as usize) % len.max(1)
}

#[cfg(test)]
fn audio_style_probe_counts(values: &[usize]) -> HashMap<usize, usize> {
    let mut counts = HashMap::new();
    for value in values {
        *counts.entry(*value).or_insert(0) += 1;
    }
    counts
}

#[cfg(test)]
fn audio_style_probe_entropy_norm(counts: &HashMap<usize, usize>) -> f32 {
    let total = counts.values().copied().sum::<usize>();
    if total == 0 || counts.len() <= 1 {
        return 0.0;
    }
    let entropy = counts
        .values()
        .copied()
        .map(|count| {
            let probability = count as f32 / total as f32;
            -probability * probability.max(1.0e-12).ln()
        })
        .sum::<f32>();
    entropy / (counts.len() as f32).ln().max(1.0e-6)
}

#[cfg(test)]
fn audio_style_probe_percentile_usize(values: &[usize], q: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut ordered = values.to_vec();
    ordered.sort_unstable();
    let index = (((ordered.len() - 1) as f32) * q)
        .round()
        .clamp(0.0, (ordered.len() - 1) as f32) as usize;
    ordered[index] as f32
}

#[cfg(test)]
fn audio_style_probe_mean(values: &[f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().copied().sum::<f32>() / values.len() as f32
}

fn write_audio_style_stable_model(
    path: &Path,
    snapshot: &AudioStyleModelSnapshot,
) -> Result<(), String> {
    let cached = cached_audio_style_stable_model_from_snapshot(snapshot);
    let bytes = serde_json::to_vec(&cached)
        .map_err(|error| format!("failed to encode audio style stable model: {error}"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create audio style stable model directory `{}`: {error}",
                parent.display()
            )
        })?;
    }
    let temp_path = unique_audio_style_embedding_temp_path(path);
    fs::write(&temp_path, bytes).map_err(|error| {
        format!(
            "failed to write audio style stable model `{}`: {error}",
            temp_path.display()
        )
    })?;
    if let Err(error) = fs::remove_file(path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "failed to replace audio style stable model `{}`: {error}",
            path.display()
        ));
    }
    fs::rename(&temp_path, path).map_err(|error| {
        format!(
            "failed to finalize audio style stable model `{}`: {error}",
            path.display()
        )
    })
}

#[cfg(test)]
pub(crate) fn write_audio_style_stable_model_for_test(
    path: &Path,
    snapshot: &AudioStyleModelSnapshot,
) -> Result<(), String> {
    write_audio_style_stable_model(path, snapshot)
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
        audio_style_stable_model_path(app)?
            .parent()
            .ok_or_else(|| anyhow!("audio style stable model path has no parent directory"))?
            .to_path_buf(),
        audio_style_training_invalidation_path(app)?,
        audio_style_pending_training_input_path(app)?,
    ])
}

#[cfg(not(test))]
fn audio_style_stable_model_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_local_data_dir()
        .context("failed to resolve app local data directory")?
        .join(AUDIO_STYLE_STABLE_MODEL_DIR_NAME)
        .join("stable.json"))
}

#[cfg(not(test))]
fn audio_style_training_invalidation_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_local_data_dir()
        .context("failed to resolve app local data directory")?
        .join(AUDIO_STYLE_TRAINING_INVALIDATION_FILE_NAME))
}

#[cfg(not(test))]
fn audio_style_pending_training_input_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_local_data_dir()
        .context("failed to resolve app local data directory")?
        .join(AUDIO_STYLE_PENDING_TRAINING_INPUT_FILE_NAME))
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
pub(crate) fn audio_style_training_path_is_transient_for_test(path: &Path) -> bool {
    audio_style_training_path_is_transient(path)
}

#[cfg(test)]
pub(crate) fn audio_style_stream_continuation_gate_for_test(
    current_run: usize,
    fatigue: f32,
    usage_share: f32,
    target_share: f32,
    same_candidate_count: usize,
    other_candidate_count: usize,
    same_quality: f32,
    other_quality: f32,
) -> f32 {
    let current_basin = PlaybackAttractorBasinKey {
        value: "current".to_string(),
    };
    let other_basin = PlaybackAttractorBasinKey {
        value: "other".to_string(),
    };
    let mut candidate_basins = Vec::new();
    let mut candidate_similarities = Vec::new();
    for _ in 0..same_candidate_count {
        candidate_basins.push(Some(current_basin.clone()));
        candidate_similarities.push(same_quality);
    }
    for _ in 0..other_candidate_count {
        candidate_basins.push(Some(other_basin.clone()));
        candidate_similarities.push(other_quality);
    }
    let mut pressure = PlaybackAttractorBasinPressure {
        current_basin: Some(current_basin.clone()),
        current_basin_run: current_run,
        recent_evidence_count: current_run,
        fatigue: HashMap::new(),
        usage: HashMap::new(),
        candidate_top_pressure: HashMap::new(),
        target_share: HashMap::new(),
    };
    pressure.fatigue.insert(current_basin.clone(), fatigue);
    pressure
        .usage
        .insert(current_basin.clone(), usage_share.max(0.0));
    pressure
        .usage
        .insert(other_basin.clone(), (1.0 - usage_share).max(0.0));
    pressure
        .target_share
        .insert(current_basin.clone(), target_share.max(0.0));
    pressure
        .target_share
        .insert(other_basin, (1.0 - target_share).max(0.0));
    pressure.stream_continuation_gate_for_basin(
        &current_basin,
        &candidate_basins,
        &candidate_similarities,
        same_quality,
    )
}

#[cfg(test)]
pub(crate) fn audio_style_alternative_route_gate_for_test(
    current_run: usize,
    current_fatigue: f32,
    current_usage_share: f32,
    current_target_share: f32,
    alternative_target_share: f32,
    current_candidate_count: usize,
    alternative_candidate_count: usize,
    current_quality: f32,
    alternative_quality: f32,
) -> f32 {
    let current_basin = PlaybackAttractorBasinKey {
        value: "current".to_string(),
    };
    let alternative_basin = PlaybackAttractorBasinKey {
        value: "alternative".to_string(),
    };
    let mut candidate_basins = Vec::new();
    let mut candidate_similarities = Vec::new();
    for _ in 0..current_candidate_count {
        candidate_basins.push(Some(current_basin.clone()));
        candidate_similarities.push(current_quality);
    }
    for _ in 0..alternative_candidate_count {
        candidate_basins.push(Some(alternative_basin.clone()));
        candidate_similarities.push(alternative_quality);
    }
    let mut pressure = PlaybackAttractorBasinPressure {
        current_basin: Some(current_basin.clone()),
        current_basin_run: current_run,
        recent_evidence_count: current_run,
        fatigue: HashMap::new(),
        usage: HashMap::new(),
        candidate_top_pressure: HashMap::new(),
        target_share: HashMap::new(),
    };
    pressure
        .fatigue
        .insert(current_basin.clone(), current_fatigue);
    pressure
        .usage
        .insert(current_basin.clone(), current_usage_share.max(0.0));
    pressure.usage.insert(
        alternative_basin.clone(),
        (1.0 - current_usage_share).max(0.0),
    );
    pressure
        .target_share
        .insert(current_basin.clone(), current_target_share.max(0.0));
    pressure
        .target_share
        .insert(alternative_basin.clone(), alternative_target_share.max(0.0));
    pressure.alternative_route_gate_for_basin(
        &current_basin,
        &alternative_basin,
        &candidate_basins,
        &candidate_similarities,
        alternative_quality,
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
