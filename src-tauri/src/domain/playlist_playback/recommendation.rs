use crate::domain::player::model::PlaybackTrack;
#[cfg(not(test))]
use crate::domain::playlist_playback::playable_index;
use crate::domain::playlist_playback::symbolic_program::{
    NeuralProgramAtlas, ProgramOrbitIndex, ProgramOwnedTraversalState,
    candidate_relation_from_program_atlas, candidate_relation_signature,
    close_neural_program_atlas_cycles, compile_neural_program_atlas, compile_program_orbit_index,
    execute_program_list, ordered_track_key_signature, program_encoding_signature,
    restrict_neural_program_atlas_to_playlist, transport_traversal_state,
};
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
#[cfg(not(test))]
use rand::RngExt;
use rustfft::{FftPlanner, num_complex::Complex};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufReader, Read};
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
const AUDIO_STYLE_STABLE_MODEL_VERSION: &str = "audio-style-stable-model-v2";
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
#[cfg(test)]
const AUDIO_STYLE_BIO_ROUTE_FUTURE_WINDOW: f32 = 12.0;
#[cfg(test)]
const AUDIO_STYLE_BIO_ROUTE_DAMPING_STRENGTH: f32 = 0.80;
#[cfg(test)]
const AUDIO_STYLE_LIKED_RETAIN_WEIGHT_FLOOR: f32 = 1.0e-6;
#[cfg(test)]
const AUDIO_STYLE_BIO_ROUTE_TOPOLOGY_TOP_FATIGUE_STRENGTH: f32 = 0.75;
#[cfg(test)]
const AUDIO_STYLE_BIO_ROUTE_TOPOLOGY_TOP_FATIGUE_CAP: f32 = 1.75;
#[cfg(test)]
const AUDIO_STYLE_BIO_ROUTE_SOURCE_FATIGUE_STRENGTH: f32 = 1.35;
#[cfg(test)]
const AUDIO_STYLE_BIO_ROUTE_SOURCE_FATIGUE_FLOOR: f32 = 0.34;
#[cfg(test)]
const AUDIO_STYLE_SEMANTIC_CONTINUITY_FLOOR: f32 = -0.60;
#[cfg(test)]
const AUDIO_STYLE_SEMANTIC_CONTINUITY_STRENGTH: f32 = 2.20;
#[cfg(test)]
const AUDIO_STYLE_SEMANTIC_CONTINUITY_ESCAPE_RUN: usize = 3;
#[cfg(test)]
const AUDIO_STYLE_SEMANTIC_CONTINUITY_HISTORY_GATE: usize = 1;
#[cfg(test)]
const AUDIO_STYLE_SEMANTIC_CONTINUITY_FAMILIARITY_THRESHOLD: f32 = 0.55;
#[cfg(test)]
const AUDIO_STYLE_SEMANTIC_CONTINUITY_DISAGREEMENT_STRENGTH: f32 = 1.40;
#[cfg(test)]
const AUDIO_STYLE_LISTENER_ADAPTATION_DECAY: f32 = 0.82;
#[cfg(test)]
const AUDIO_STYLE_LISTENER_ADAPTATION_STRENGTH: f32 = 0.55;
#[cfg(test)]
const AUDIO_STYLE_LISTENER_OVERLOAD_STRENGTH: f32 = 2.0;
#[cfg(test)]
const AUDIO_STYLE_LISTENER_RECOVERY_STRENGTH: f32 = 0.75;
#[cfg(test)]
const AUDIO_STYLE_LISTENER_UNDERLOAD_STRENGTH: f32 = 0.35;
#[cfg(test)]
const AUDIO_STYLE_LISTENER_COMFORT_STRENGTH: f32 = 0.35;
#[cfg(test)]
const AUDIO_STYLE_LISTENER_SHOCK_STRENGTH: f32 = 0.40;
#[cfg(test)]
const AUDIO_STYLE_LISTENER_SHOCK_DISTANCE: f32 = 1.15;
const AUDIO_STYLE_LOCAL_DENSITY_TOP_K: usize = 10;
const AUDIO_STYLE_SYMBOLIC_PROGRAM_CANDIDATE_COUNT: usize = 96;
const AUDIO_STYLE_SYMBOLIC_PROGRAM_ENCODING_SCHEMA: &str =
    "slisic.symbolic-audio-program-encoding.v2";
const AUDIO_STYLE_TOPOLOGY_BLOCK_NEIGHBOR_COUNT: usize = 24;
const AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_CLASS_COUNT: usize = 3;
const AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_LIBRARY_CLASSES: usize = 48;
const AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_CENTERED_SIMILARITY: f32 = 0.985;
const AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_OUT_JACCARD: f32 = 0.30;
const AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_IN_JACCARD: f32 = 0.20;
const AUDIO_STYLE_TOPOLOGY_BLOCK_MAX_CLASSES: usize = 64;
const AUDIO_STYLE_SELF_SUPERVISED_BASIN_GAP_WEIGHT: f32 = 0.35;
const AUDIO_STYLE_SELF_SUPERVISED_BASIN_SEPARATION_MIN: f32 = 0.55;
const AUDIO_STYLE_SELF_SUPERVISED_BASIN_SEPARATION_MAX: f32 = 0.92;
const AUDIO_STYLE_SELF_SUPERVISED_BASIN_SEPARATION_OFFSET: f32 = 0.08;
const AUDIO_STYLE_SELF_SUPERVISED_BASIN_NEAR_DUPLICATE_FLOOR: f32 = 0.985;
#[cfg(test)]
const AUDIO_STYLE_BASIN_FATIGUE_DECAY: f32 = 0.86;
#[cfg(test)]
const AUDIO_STYLE_BASIN_FATIGUE_IMPULSE: f32 = 1.0;
#[cfg(test)]
const AUDIO_STYLE_BASIN_FATIGUE_STRENGTH: f32 = 0.24;
#[cfg(test)]
const AUDIO_STYLE_BASIN_HOMEOSTATIC_DECAY: f32 = 0.93;
#[cfg(test)]
const AUDIO_STYLE_BASIN_HOMEOSTATIC_IMPULSE: f32 = 1.0;
#[cfg(test)]
const AUDIO_STYLE_BASIN_HOMEOSTATIC_STRENGTH: f32 = 1.45;
#[cfg(test)]
const AUDIO_STYLE_ROUTE_EVIDENCE_WARMUP_OFFSET: f32 = 3.0;
#[cfg(test)]
const AUDIO_STYLE_ROUTE_EVIDENCE_WARMUP_WIDTH: f32 = 18.0;
#[cfg(test)]
const AUDIO_STYLE_ROUTE_STREAM_MATURITY_START: f32 = 2.0;
#[cfg(test)]
const AUDIO_STYLE_ROUTE_STREAM_MATURITY_WIDTH: f32 = 3.0;
#[cfg(test)]
const AUDIO_STYLE_ROUTE_EARLY_CONTINUITY_STRENGTH: f32 = 0.58;
#[cfg(test)]
const AUDIO_STYLE_STREAM_CONTINUATION_STRENGTH: f32 = 1.90;
#[cfg(test)]
const AUDIO_STYLE_STREAM_CONTINUATION_MARGIN: f32 = 0.10;
#[cfg(test)]
const AUDIO_STYLE_STREAM_CONTINUATION_QUALITY_STRENGTH: f32 = 1.65;
#[cfg(test)]
const AUDIO_STYLE_STREAM_CONTINUATION_SUPPORT_STRENGTH: f32 = 0.75;
#[cfg(test)]
const AUDIO_STYLE_STREAM_CONTINUATION_SUPPORT_NEUTRAL: f32 = 0.08;
#[cfg(test)]
const AUDIO_STYLE_STREAM_CONTINUATION_QUALITY_FLOOR: f32 = 0.32;
#[cfg(test)]
const AUDIO_STYLE_STREAM_CONTINUATION_LOW_QUALITY_STRENGTH: f32 = 1.55;
#[cfg(test)]
const AUDIO_STYLE_STREAM_CONTINUATION_RELATIVE_LOSS_STRENGTH: f32 = 3.0;
#[cfg(test)]
const AUDIO_STYLE_STREAM_CONTINUATION_FATIGUE_STRENGTH: f32 = 0.52;
#[cfg(test)]
const AUDIO_STYLE_STREAM_CONTINUATION_OVERUSE_STRENGTH: f32 = 1.35;
#[cfg(test)]
const AUDIO_STYLE_STREAM_CONTINUATION_RUN_STRENGTH: f32 = 0.08;
#[cfg(test)]
const AUDIO_STYLE_ROUTE_ALTERNATIVE_UNDERUSE_STRENGTH: f32 = 1.25;
#[cfg(test)]
const AUDIO_STYLE_ROUTE_ALTERNATIVE_FATIGUE_STRENGTH: f32 = 0.24;
#[cfg(test)]
const AUDIO_STYLE_ROUTE_ALTERNATIVE_SWITCH_INERTIA: f32 = 0.36;
#[cfg(test)]
const AUDIO_STYLE_ROUTE_TRAJECTORY_STRENGTH: f32 = 0.42;
const AUDIO_STYLE_MANIFOLD_NEIGHBOR_TOP_K: usize = 24;
#[cfg(test)]
const AUDIO_STYLE_MANIFOLD_ESCAPE_STRENGTH: f32 = 0.92;
#[cfg(test)]
const AUDIO_STYLE_MANIFOLD_CONTINUITY_STRENGTH: f32 = 0.44;
#[cfg(test)]
const AUDIO_STYLE_MANIFOLD_RESIDENCE_RANK_SCALE: f32 = 0.55;
#[cfg(test)]
const AUDIO_STYLE_FUTURE_OCCUPANCY_REACHABILITY_STRENGTH: f32 = 1.05;
#[cfg(test)]
const AUDIO_STYLE_FUTURE_OCCUPANCY_ENTROPY_STRENGTH: f32 = 0.48;
#[cfg(test)]
const AUDIO_STYLE_FUTURE_OCCUPANCY_CONTINUITY_BAND_STRENGTH: f32 = 0.34;
#[cfg(test)]
const AUDIO_STYLE_FUTURE_OCCUPANCY_MANIFOLD_LOAD_STRENGTH: f32 = 0.30;
#[cfg(test)]
const AUDIO_STYLE_FUTURE_OCCUPANCY_SAME_BASIN_RUN_STRENGTH: f32 = 0.22;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_DISTANCE_LOW_QUANTILE: f32 = 0.35;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_DISTANCE_TARGET_QUANTILE: f32 = 0.50;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_DISTANCE_HIGH_QUANTILE: f32 = 0.65;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_DISTANCE_MIN_WIDTH: f32 = 0.030;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_EPISODE_SHIFT_RUN: usize = 5;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_EPISODE_FATIGUE_SHIFT: f32 = 2.35;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_CONTINUE_SAME_BASIN_BONUS: f32 = 0.55;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_SHIFT_SAME_BASIN_PENALTY: f32 = 0.35;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_CONTINUE_NOVELTY_STRENGTH: f32 = 0.40;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_SHIFT_NOVELTY_STRENGTH: f32 = 0.75;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_NOVELTY_STRENGTH: f32 = 2.16;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_HIGH_NOVELTY_OVERLOAD_STRENGTH: f32 = 2.20;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_LOW_NOVELTY_STICKINESS_STRENGTH: f32 = 1.15;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_COVERAGE_BONUS: f32 = 0.58;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_MASS_DEFICIT_STRENGTH: f32 = 2.10;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_MASS_OVERUSE_STRENGTH: f32 = 1.70;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_SOURCE_MASS_DEFICIT_STRENGTH: f32 = 0.74;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_ROUTE_CAPACITY_WINDOW: usize = 24;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_ROUTE_CAPACITY_WARMUP: usize = 6;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_WINDOW_CAPACITY_STRENGTH: f32 = 8.0;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_FUTURE_REBALANCE_STRENGTH: f32 = 1.05;
#[cfg(test)]
const AUDIO_STYLE_PROGRAMMATIC_REMAINING_COLLAPSE_STRENGTH: f32 = 2.0;
#[cfg(test)]
const AUDIO_STYLE_MODEL_BASIN_SUPPORT_SINGLETON_GATE: f32 = 0.52;
#[cfg(test)]
const AUDIO_STYLE_MODEL_BASIN_SUPPORT_PAIR_GATE: f32 = 0.88;
#[cfg(test)]
const AUDIO_STYLE_BASIN_RUN_HAZARD_STRENGTH: f32 = 0.10;
// Basin pressure breaks near-distance ties, but the current track distance stays the primary axis.
#[cfg(test)]
const AUDIO_STYLE_BASIN_PENALTY_CAP: f32 = 2.0;
#[cfg(test)]
const AUDIO_STYLE_BASIN_TARGET_COUNT_SHARE_WEIGHT: f32 = 0.72;
#[cfg(test)]
const AUDIO_STYLE_BASIN_TARGET_ROOT_SHARE_WEIGHT: f32 = 0.28;
#[cfg(test)]
const AUDIO_STYLE_ROUTE_RECENT_WINDOW: usize = 48;
#[cfg(test)]
const AUDIO_STYLE_TYPED_CHANNEL_TERMINAL_RANGE: std::ops::Range<usize> =
    0..AUDIO_STYLE_TERMINAL_LATENT_WIDTH;
#[cfg(test)]
const AUDIO_STYLE_TYPED_CHANNEL_FLOW_RANGE: std::ops::Range<usize> =
    AUDIO_STYLE_TERMINAL_LATENT_WIDTH
        ..AUDIO_STYLE_TERMINAL_LATENT_WIDTH + AUDIO_STYLE_TERMINAL_BINS * 2;
#[cfg(test)]
const AUDIO_STYLE_TYPED_CHANNEL_TRANSITION_RANGE: std::ops::Range<usize> =
    AUDIO_STYLE_TERMINAL_LATENT_WIDTH + AUDIO_STYLE_TERMINAL_BINS * 2..AUDIO_STYLE_EMBEDDING_WIDTH;
#[cfg(test)]
const AUDIO_STYLE_TYPED_CHANNEL_CONSENSUS_STRENGTH: f32 = 0.34;
#[cfg(test)]
const AUDIO_STYLE_TYPED_CHANNEL_DISAGREEMENT_STRENGTH: f32 = 0.20;
#[cfg(test)]
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
#[cfg(test)]
const AUDIO_STYLE_CANDIDATE_FIELD_MIN_ACTIVE_BASINS: usize = 28;
#[cfg(test)]
const AUDIO_STYLE_CANDIDATE_FIELD_MIN_BASIN_CAPACITY: usize = 5;
#[cfg(test)]
const AUDIO_STYLE_CANDIDATE_FIELD_MAX_BASIN_CAPACITY: usize = 8;
#[cfg(test)]
const AUDIO_STYLE_CANDIDATE_FIELD_CAPACITY_MULTIPLIER: f32 = 2.7;
#[cfg(test)]
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
    #[serde(default)]
    content_classes: Vec<CachedAudioStyleContentClass>,
    neighbor_index: CachedAudioStyleNeighborIndex,
    sampling_geometry: Option<CachedAudioStyleSamplingGeometry>,
    #[serde(default)]
    symbolic_program_encoding: Option<CachedAudioStyleSymbolicProgramEncoding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleSymbolicProgramEncoding {
    schema: String,
    stable_generation: u64,
    track_count: usize,
    track_key_signature: String,
    #[serde(default)]
    partition_signature: String,
    candidate_width: usize,
    candidate_relation_signature: String,
    candidate_rows: Vec<Vec<usize>>,
    program_lineages: Vec<String>,
    program_encoding_signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleContentClass {
    key: String,
    members: Vec<CachedPlaybackTrackKey>,
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

#[derive(Clone)]
struct AudioStyleModelState {
    embeddings: AudioStyleEmbeddingMap,
    indexed_tracks: HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
    content_partition: Arc<AudioStyleContentPartition>,
    neighbor_index: AudioStyleNeighborIndex,
    sampling_geometry: Option<AudioStyleSamplingGeometry>,
    symbolic_program_encoding: Option<Arc<AudioStyleSymbolicProgramEncoding>>,
}

#[derive(Clone)]
struct AudioStyleSymbolicProgramEncoding {
    ordered_keys: Vec<PlaybackTrackKey>,
    ordinal_by_key: HashMap<PlaybackTrackKey, usize>,
    member_keys: Vec<Vec<PlaybackTrackKey>>,
    track_keys: Vec<String>,
    candidate_count: usize,
    candidate_neighbors: Vec<usize>,
    atlas: NeuralProgramAtlas,
    track_key_signature: String,
    partition_signature: String,
    candidate_relation_signature: String,
    program_encoding_signature: String,
}

#[derive(Clone)]
struct AudioStyleContentPartition {
    members_by_class: BTreeMap<String, Vec<PlaybackTrackKey>>,
}

struct AudioStyleSchedulePartition {
    ordered_keys: Vec<PlaybackTrackKey>,
    member_keys: Vec<Vec<PlaybackTrackKey>>,
    track_keys: Vec<String>,
    embeddings: AudioStyleEmbeddingMap,
    signature: String,
}

struct AudioStyleRankedCandidateRow {
    destinations: Vec<usize>,
    similarities: Vec<f32>,
}

struct AudioStyleHardContentClass {
    key: String,
    members: Vec<PlaybackTrackKey>,
    representative: PlaybackTrackKey,
    embedding: Arc<AudioStyleEmbedding>,
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
}

#[derive(Clone, Default)]
pub(crate) struct AudioStyleSymbolicPlaybackSession {
    execution: Option<AudioStyleSymbolicPlaylistExecution>,
    pending_checkpoint: Option<Box<AudioStyleSymbolicPendingCheckpoint>>,
    scope_revision: Option<u64>,
    scope_dirty: bool,
}

#[derive(Clone)]
struct AudioStyleSymbolicPendingCheckpoint {
    execution: Option<AudioStyleSymbolicPlaylistExecution>,
    scope_revision: Option<u64>,
    scope_dirty: bool,
}

#[derive(Clone)]
struct AudioStyleSymbolicPlaylistExecution {
    generation: u64,
    scope_signature: String,
    atlas: Arc<NeuralProgramAtlas>,
    orbit_index: Arc<ProgramOrbitIndex>,
    state: ProgramOwnedTraversalState,
    local_by_key: Arc<HashMap<PlaybackTrackKey, usize>>,
    tracks: Arc<Vec<PlaybackTrack>>,
    materializations: Arc<Vec<Vec<PlaybackTrack>>>,
}

pub(crate) struct AudioStyleSymbolicNextTrack {
    pub(crate) track: PlaybackTrack,
    pub(crate) style_sector_departure: bool,
    pub(crate) coverage_epoch_transition: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct AudioStyleCandidateSelection {
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
    SymbolicProgram,
}

impl AudioStyleCandidateSelectionSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::SymbolicProgram => "symbolic_program",
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

impl AudioStyleContentPartition {
    fn from_indexed_tracks(
        embeddings: &AudioStyleEmbeddingMap,
        indexed_tracks: &HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
    ) -> Self {
        Self::from_evidence(embeddings, indexed_tracks, &HashMap::new())
    }

    fn from_evidence(
        embeddings: &AudioStyleEmbeddingMap,
        indexed_tracks: &HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
        class_overrides: &HashMap<PlaybackTrackKey, String>,
    ) -> Self {
        let ordered_keys = sorted_audio_style_embedding_keys(embeddings);
        let mut class_key_by_track = HashMap::with_capacity(ordered_keys.len());
        let mut duplicate_size_buckets = HashMap::<(u64, u32, u32), Vec<PlaybackTrackKey>>::new();

        for key in &ordered_keys {
            if let Some(class_key) = class_overrides.get(key) {
                class_key_by_track.insert(key.clone(), format!("audio-content:{class_key}"));
                continue;
            }
            let Some(indexed) = indexed_tracks.get(key) else {
                class_key_by_track.insert(key.clone(), unique_audio_content_class_key(key));
                continue;
            };
            let Ok(metadata) = fs::metadata(&indexed.track.file_path) else {
                class_key_by_track.insert(key.clone(), unique_audio_content_class_key(key));
                continue;
            };
            duplicate_size_buckets
                .entry((metadata.len(), key.start_ms, key.end_ms))
                .or_default()
                .push(key.clone());
        }

        let mut digest_by_path = HashMap::<PathBuf, Result<String, String>>::new();
        for ((_, start_ms, end_ms), keys) in duplicate_size_buckets {
            if keys.len() < 2 {
                let key = &keys[0];
                class_key_by_track.insert(key.clone(), unique_audio_content_class_key(key));
                continue;
            }
            for key in keys {
                let digest = digest_by_path
                    .entry(key.file_path.clone())
                    .or_insert_with(|| sha256_file(&key.file_path))
                    .clone();
                let class_key = match digest {
                    Ok(digest) => {
                        format!("audio-content:sha256:{digest}:{start_ms}:{end_ms}")
                    }
                    Err(_) => unique_audio_content_class_key(&key),
                };
                class_key_by_track.insert(key, class_key);
            }
        }

        let mut members_by_class = BTreeMap::<String, Vec<PlaybackTrackKey>>::new();
        for key in ordered_keys {
            let class_key = class_key_by_track
                .entry(key.clone())
                .or_insert_with(|| unique_audio_content_class_key(&key))
                .clone();
            members_by_class.entry(class_key).or_default().push(key);
        }
        for members in members_by_class.values_mut() {
            members.sort_by_key(audio_style_track_key_sort_value);
        }
        Self { members_by_class }
    }

    fn from_cached(
        cached: Vec<CachedAudioStyleContentClass>,
        embeddings: &AudioStyleEmbeddingMap,
    ) -> Result<Self, String> {
        let mut class_key_by_track = HashMap::with_capacity(embeddings.len());
        let mut members_by_class = BTreeMap::new();
        for cached_class in cached {
            if cached_class.key.is_empty() || cached_class.members.is_empty() {
                return Err("stable content partition contains an empty class".to_string());
            }
            let mut members = cached_class
                .members
                .into_iter()
                .map(PlaybackTrackKey::from)
                .collect::<Vec<_>>();
            members.sort_by_key(audio_style_track_key_sort_value);
            members.dedup();
            for member in &members {
                if !embeddings.contains_key(member) {
                    return Err(
                        "stable content partition references a missing embedding".to_string()
                    );
                }
                if class_key_by_track
                    .insert(member.clone(), cached_class.key.clone())
                    .is_some()
                {
                    return Err(
                        "stable content partition assigns a track more than once".to_string()
                    );
                }
            }
            if members_by_class.insert(cached_class.key, members).is_some() {
                return Err("stable content partition repeats a class key".to_string());
            }
        }
        if class_key_by_track.len() != embeddings.len() {
            return Err("stable content partition does not cover every embedding".to_string());
        }
        Ok(Self { members_by_class })
    }

    fn to_cached(&self) -> Vec<CachedAudioStyleContentClass> {
        self.members_by_class
            .iter()
            .map(|(key, members)| CachedAudioStyleContentClass {
                key: key.clone(),
                members: members.iter().map(CachedPlaybackTrackKey::from).collect(),
            })
            .collect()
    }
}

fn unique_audio_content_class_key(key: &PlaybackTrackKey) -> String {
    format!(
        "audio-content:identity:{}",
        symbolic_audio_style_track_key(key).unwrap_or_else(|_| format!(
            "{}:{}:{}:{}",
            key.music_url,
            key.file_path.display(),
            key.start_ms,
            key.end_ms
        ))
    )
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| {
        format!(
            "failed to open content evidence `{}`: {error}",
            path.display()
        )
    })?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|error| {
            format!(
                "failed to read content evidence `{}`: {error}",
                path.display()
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

impl CachedAudioStyleModelState {
    fn from_state(state: &AudioStyleModelState, generation: u64) -> Self {
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
            content_classes: state.content_partition.to_cached(),
            neighbor_index: CachedAudioStyleNeighborIndex::from(&state.neighbor_index),
            sampling_geometry: state
                .sampling_geometry
                .as_ref()
                .map(CachedAudioStyleSamplingGeometry::from),
            symbolic_program_encoding: state
                .symbolic_program_encoding
                .as_deref()
                .map(|encoding| encoding.to_cached(generation)),
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

        let content_partition = if cached.content_classes.is_empty() {
            AudioStyleContentPartition::from_indexed_tracks(&embeddings, &indexed_tracks)
        } else {
            AudioStyleContentPartition::from_cached(cached.content_classes, &embeddings)?
        };
        let neighbor_index = AudioStyleNeighborIndex::try_from(cached.neighbor_index, &embeddings)?;
        let sampling_geometry = cached
            .sampling_geometry
            .map(|geometry| AudioStyleSamplingGeometry::try_from(geometry, &embeddings))
            .transpose()?;
        let symbolic_program_encoding = match cached.symbolic_program_encoding {
            Some(encoding) => match AudioStyleSymbolicProgramEncoding::from_cached(
                encoding,
                &embeddings,
                &content_partition,
            ) {
                Ok(encoding) => Some(Arc::new(encoding)),
                Err(error) => {
                    log::info!(
                        target: AUDIO_STYLE_LOG_TARGET,
                        "audio_style_symbolic_program_refresh source=stable_embeddings reason=\"{}\"",
                        escape_log_value(&error)
                    );
                    AudioStyleSymbolicProgramEncoding::from_embeddings(
                        &embeddings,
                        &content_partition,
                    )
                    .ok()
                    .map(Arc::new)
                }
            },
            None => {
                AudioStyleSymbolicProgramEncoding::from_embeddings(&embeddings, &content_partition)
                    .ok()
                    .map(Arc::new)
            }
        };
        Ok(Self {
            embeddings,
            indexed_tracks,
            content_partition: Arc::new(content_partition),
            neighbor_index,
            sampling_geometry,
            symbolic_program_encoding,
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
        Ok(Self {
            mean: cached.mean,
            local_density,
            manifold,
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

    let Some(encoding) = snapshot.state.symbolic_program_encoding.as_deref() else {
        return AudioStyleCenterlessSourceStatus::ModelUnavailable;
    };
    let scoped = candidates
        .into_iter()
        .filter(|(_, track)| {
            encoding
                .ordinal_by_key
                .contains_key(&PlaybackTrackKey::from_track(track))
        })
        .collect::<Vec<_>>();
    if scoped.is_empty() {
        return AudioStyleCenterlessSourceStatus::NoScopedCandidate;
    }
    let index = rand::rng().random_range(0..scoped.len());
    let diagnostics = AudioStyleCandidateDiagnostics {
        anchor_embedded: false,
        embedded_candidate_count: scoped.len(),
        valid_similarity_count: 0,
        selected_basin: None,
        top_candidate_basins: Vec::new(),
        bio_route: None,
        perceptual_channels: None,
        topology_health: None,
    };
    let selection = AudioStyleCandidateSelection {
        probability: 1.0 / scoped.len() as f32,
        uniform_probability: 1.0 / scoped.len() as f32,
        similarity: None,
        best_similarity: None,
        local_rank_fraction: None,
        draw_unit: index as f32 / scoped.len() as f32,
        candidate_count: scoped.len(),
        source: AudioStyleCandidateSelectionSource::SymbolicProgram,
        reason: Some("symbolic_program_centerless"),
        model_generation: Some(snapshot.generation()),
        diagnostics,
    };
    let (source, track) = scoped[index].clone();
    AudioStyleCenterlessSourceStatus::Ready(source, track, selection)
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
            read_and_refresh_audio_style_stable_model(&stable_model_path)
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
        Some(Self {
            mean,
            local_density,
            manifold,
            self_supervised_basins,
            similarity_low: neighbor_index.similarity_low,
            similarity_high: neighbor_index.similarity_high,
        })
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
            content_partition: Arc::clone(&previous.content_partition),
            neighbor_index: previous.neighbor_index.clone(),
            sampling_geometry: previous.sampling_geometry.clone(),
            symbolic_program_encoding: previous.symbolic_program_encoding.clone(),
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
        Self::from_embeddings_with_content_overrides(
            previous,
            embeddings,
            indexed_tracks,
            previous_reused,
            &HashMap::new(),
        )
    }

    fn from_embeddings_with_content_overrides(
        previous: Option<&Self>,
        embeddings: AudioStyleEmbeddingMap,
        indexed_tracks: HashMap<PlaybackTrackKey, AudioStyleIndexedTrack>,
        previous_reused: &HashSet<PlaybackTrackKey>,
        content_overrides: &HashMap<PlaybackTrackKey, String>,
    ) -> Self {
        let stats = AudioStyleStats::from_embeddings(&embeddings);
        let neighbor_index =
            AudioStyleNeighborIndex::refresh_from(previous, &embeddings, &stats, previous_reused);
        let sampling_geometry =
            AudioStyleSamplingGeometry::from_model_parts(&embeddings, &stats, &neighbor_index);
        let content_partition = AudioStyleContentPartition::from_evidence(
            &embeddings,
            &indexed_tracks,
            content_overrides,
        );
        let symbolic_program_encoding = match AudioStyleSymbolicProgramEncoding::from_embeddings(
            &embeddings,
            &content_partition,
        ) {
            Ok(encoding) => Some(Arc::new(encoding)),
            Err(error) => {
                log::warn!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_symbolic_program_unavailable reason=\"{}\"",
                    escape_log_value(&error)
                );
                None
            }
        };
        Self {
            embeddings,
            indexed_tracks,
            content_partition: Arc::new(content_partition),
            neighbor_index,
            sampling_geometry,
            symbolic_program_encoding,
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

impl AudioStyleSchedulePartition {
    fn from_content_partition(
        embeddings: &AudioStyleEmbeddingMap,
        content_partition: &AudioStyleContentPartition,
    ) -> Result<Self, String> {
        let mut hard_classes = Vec::with_capacity(content_partition.members_by_class.len());
        for (class_key, members) in &content_partition.members_by_class {
            let representative = members
                .first()
                .cloned()
                .ok_or_else(|| "audio content partition contains an empty class".to_string())?;
            let embedding = average_audio_style_embeddings(
                members
                    .iter()
                    .filter_map(|member| embeddings.get(member).map(Arc::as_ref)),
            )
            .ok_or_else(|| "audio content class has no valid embedding".to_string())?;
            hard_classes.push(AudioStyleHardContentClass {
                key: class_key.clone(),
                members: members.clone(),
                representative,
                embedding: Arc::new(embedding),
            });
        }
        if hard_classes.len() < 2 {
            return Err("symbolic program encoding needs at least two content classes".to_string());
        }

        let hard_ordered_keys = hard_classes
            .iter()
            .map(|class| class.representative.clone())
            .collect::<Vec<_>>();
        let hard_embeddings = hard_classes
            .iter()
            .map(|class| (class.representative.clone(), Arc::clone(&class.embedding)))
            .collect::<HashMap<_, _>>();
        let topology_blocks =
            if hard_classes.len() >= AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_LIBRARY_CLASSES {
                ranked_audio_style_candidate_rows(&hard_ordered_keys, &hard_embeddings)
                    .map(|rows| audio_style_topology_blocks(&rows))
                    .unwrap_or_default()
            } else {
                Vec::new()
            };

        let mut consumed = vec![false; hard_classes.len()];
        let mut entities = Vec::<(
            String,
            Vec<PlaybackTrackKey>,
            PlaybackTrackKey,
            Arc<AudioStyleEmbedding>,
        )>::new();
        for block in topology_blocks {
            let mut block = block
                .into_iter()
                .filter(|ordinal| !consumed[*ordinal])
                .collect::<Vec<_>>();
            block.sort_by(|left, right| hard_classes[*left].key.cmp(&hard_classes[*right].key));
            if block.len() < AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_CLASS_COUNT {
                continue;
            }
            for ordinal in &block {
                consumed[*ordinal] = true;
            }
            let capacity = (block.len() as f64).sqrt().ceil() as usize;
            let block_signature = audio_style_topology_block_signature(
                block
                    .iter()
                    .map(|ordinal| hard_classes[*ordinal].key.as_str()),
            );
            for slot in 0..capacity {
                let assigned = block
                    .iter()
                    .copied()
                    .skip(slot)
                    .step_by(capacity)
                    .collect::<Vec<_>>();
                if assigned.is_empty() {
                    continue;
                }
                let mut members = assigned
                    .iter()
                    .flat_map(|ordinal| hard_classes[*ordinal].members.iter().cloned())
                    .collect::<Vec<_>>();
                members.sort_by_key(audio_style_track_key_sort_value);
                let representative = members[0].clone();
                let embedding = average_audio_style_embeddings(
                    assigned
                        .iter()
                        .map(|ordinal| hard_classes[*ordinal].embedding.as_ref()),
                )
                .ok_or_else(|| "audio topology mass slot has no valid embedding".to_string())?;
                entities.push((
                    format!("audio-topology-mass:{block_signature}:slot-{slot}-of-{capacity}"),
                    members,
                    representative,
                    Arc::new(embedding),
                ));
            }
        }
        for (ordinal, class) in hard_classes.into_iter().enumerate() {
            if !consumed[ordinal] {
                entities.push((
                    class.key,
                    class.members,
                    class.representative,
                    class.embedding,
                ));
            }
        }
        entities.sort_by(|left, right| left.0.cmp(&right.0));

        let track_keys = entities
            .iter()
            .map(|(key, _, _, _)| key.clone())
            .collect::<Vec<_>>();
        let member_keys = entities
            .iter()
            .map(|(_, members, _, _)| members.clone())
            .collect::<Vec<_>>();
        let ordered_keys = entities
            .iter()
            .map(|(_, _, representative, _)| representative.clone())
            .collect::<Vec<_>>();
        let embeddings = entities
            .into_iter()
            .map(|(_, _, representative, embedding)| (representative, embedding))
            .collect::<HashMap<_, _>>();
        let signature = audio_style_schedule_partition_signature(&track_keys, &member_keys);
        Ok(Self {
            ordered_keys,
            member_keys,
            track_keys,
            embeddings,
            signature,
        })
    }
}

fn average_audio_style_embeddings<'a>(
    embeddings: impl IntoIterator<Item = &'a AudioStyleEmbedding>,
) -> Option<AudioStyleEmbedding> {
    let mut count = 0usize;
    let mut sum = vec![0.0_f32; AUDIO_STYLE_EMBEDDING_WIDTH];
    for embedding in embeddings {
        for (target, value) in sum.iter_mut().zip(&embedding.values) {
            *target += *value;
        }
        count += 1;
    }
    if count == 0 {
        return None;
    }
    let scale = 1.0 / count as f32;
    for value in &mut sum {
        *value *= scale;
    }
    AudioStyleEmbedding::normalize(sum)
}

fn ranked_audio_style_candidate_rows(
    ordered_keys: &[PlaybackTrackKey],
    embeddings: &AudioStyleEmbeddingMap,
) -> Result<Vec<AudioStyleRankedCandidateRow>, String> {
    if ordered_keys.len() < 2 {
        return Err("symbolic candidate relation needs at least two tracks".to_string());
    }
    let candidate_count = AUDIO_STYLE_SYMBOLIC_PROGRAM_CANDIDATE_COUNT.min(ordered_keys.len() - 1);
    let mean = AudioStyleStats::from_embeddings(embeddings).mean();
    let mut candidate_lists = ordered_keys
        .iter()
        .cloned()
        .map(|key| (key, Vec::<(PlaybackTrackKey, f32)>::new()))
        .collect::<HashMap<_, _>>();
    if !AudioStyleTensorRuntime::new().visit_centered_similarity_pairs(
        embeddings,
        &mean,
        |left, right, similarity| {
            push_audio_style_symbolic_candidate(
                candidate_lists.get_mut(left),
                right.clone(),
                similarity,
                candidate_count,
            );
            push_audio_style_symbolic_candidate(
                candidate_lists.get_mut(right),
                left.clone(),
                similarity,
                candidate_count,
            );
        },
    ) {
        for left_index in 0..ordered_keys.len() {
            for right_index in (left_index + 1)..ordered_keys.len() {
                let left = &ordered_keys[left_index];
                let right = &ordered_keys[right_index];
                let Some(left_embedding) = embeddings.get(left) else {
                    continue;
                };
                let Some(right_embedding) = embeddings.get(right) else {
                    continue;
                };
                let Some(similarity) = centered_cosine(left_embedding, right_embedding, &mean)
                else {
                    continue;
                };
                push_audio_style_symbolic_candidate(
                    candidate_lists.get_mut(left),
                    right.clone(),
                    similarity,
                    candidate_count,
                );
                push_audio_style_symbolic_candidate(
                    candidate_lists.get_mut(right),
                    left.clone(),
                    similarity,
                    candidate_count,
                );
            }
        }
    }
    let ordinal_by_key = ordered_keys
        .iter()
        .cloned()
        .enumerate()
        .map(|(ordinal, key)| (key, ordinal))
        .collect::<HashMap<_, _>>();
    ordered_keys
        .iter()
        .map(|key| {
            let candidates = candidate_lists
                .remove(key)
                .ok_or_else(|| "symbolic candidate row is missing".to_string())?;
            if candidates.len() != candidate_count {
                return Err("symbolic candidate relation has an incomplete row".to_string());
            }
            let mut destinations = Vec::with_capacity(candidate_count);
            let mut similarities = Vec::with_capacity(candidate_count);
            for (candidate, similarity) in candidates {
                destinations.push(
                    *ordinal_by_key
                        .get(&candidate)
                        .ok_or_else(|| "symbolic candidate is outside stable order".to_string())?,
                );
                similarities.push(similarity);
            }
            Ok(AudioStyleRankedCandidateRow {
                destinations,
                similarities,
            })
        })
        .collect()
}

fn audio_style_topology_blocks(rows: &[AudioStyleRankedCandidateRow]) -> Vec<Vec<usize>> {
    if rows.len() < AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_LIBRARY_CLASSES
        || rows
            .iter()
            .any(|row| row.destinations.len() < AUDIO_STYLE_TOPOLOGY_BLOCK_NEIGHBOR_COUNT)
    {
        return Vec::new();
    }
    let mut incoming = vec![HashSet::<usize>::new(); rows.len()];
    for (source, row) in rows.iter().enumerate() {
        for destination in &row.destinations {
            incoming[*destination].insert(source);
        }
    }
    let mut parents = (0..rows.len()).collect::<Vec<_>>();
    for source in 0..rows.len() {
        for (rank, destination) in rows[source].destinations.iter().copied().enumerate() {
            if source >= destination
                || rows[source].similarities[rank]
                    < AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_CENTERED_SIMILARITY
            {
                continue;
            }
            let Some(reverse_rank) = rows[destination]
                .destinations
                .iter()
                .position(|candidate| *candidate == source)
            else {
                continue;
            };
            if rows[destination].similarities[reverse_rank]
                < AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_CENTERED_SIMILARITY
                || ranked_prefix_jaccard(
                    &rows[source].destinations,
                    &rows[destination].destinations,
                    AUDIO_STYLE_TOPOLOGY_BLOCK_NEIGHBOR_COUNT,
                ) < AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_OUT_JACCARD
                || set_jaccard(&incoming[source], &incoming[destination])
                    < AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_IN_JACCARD
            {
                continue;
            }
            union_audio_style_topology_nodes(&mut parents, source, destination);
        }
    }
    let mut components = BTreeMap::<usize, Vec<usize>>::new();
    for node in 0..rows.len() {
        let root = find_audio_style_topology_root(&mut parents, node);
        components.entry(root).or_default().push(node);
    }
    components
        .into_values()
        .filter(|component| component.len() >= AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_CLASS_COUNT)
        .flat_map(|component| {
            component
                .chunks(AUDIO_STYLE_TOPOLOGY_BLOCK_MAX_CLASSES)
                .filter(|chunk| chunk.len() >= AUDIO_STYLE_TOPOLOGY_BLOCK_MIN_CLASS_COUNT)
                .map(<[usize]>::to_vec)
                .collect::<Vec<_>>()
        })
        .collect()
}

fn ranked_prefix_jaccard(left: &[usize], right: &[usize], width: usize) -> f32 {
    let left = left.iter().copied().take(width).collect::<HashSet<_>>();
    let right = right.iter().copied().take(width).collect::<HashSet<_>>();
    set_jaccard(&left, &right)
}

fn set_jaccard(left: &HashSet<usize>, right: &HashSet<usize>) -> f32 {
    let union = left.union(right).count();
    if union == 0 {
        0.0
    } else {
        left.intersection(right).count() as f32 / union as f32
    }
}

fn find_audio_style_topology_root(parents: &mut [usize], node: usize) -> usize {
    if parents[node] != node {
        parents[node] = find_audio_style_topology_root(parents, parents[node]);
    }
    parents[node]
}

fn union_audio_style_topology_nodes(parents: &mut [usize], left: usize, right: usize) {
    let left_root = find_audio_style_topology_root(parents, left);
    let right_root = find_audio_style_topology_root(parents, right);
    if left_root != right_root {
        parents[right_root] = left_root.min(right_root);
        parents[left_root] = left_root.min(right_root);
    }
}

fn audio_style_topology_block_signature<'a>(keys: impl IntoIterator<Item = &'a str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"slisic.audio-topology-mass-block.v1");
    for key in keys {
        hasher.update((key.len() as u64).to_le_bytes());
        hasher.update(key.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn audio_style_schedule_partition_signature(
    track_keys: &[String],
    member_keys: &[Vec<PlaybackTrackKey>],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"slisic.audio-schedule-partition.v1");
    for (track_key, members) in track_keys.iter().zip(member_keys) {
        hasher.update((track_key.len() as u64).to_le_bytes());
        hasher.update(track_key.as_bytes());
        hasher.update((members.len() as u64).to_le_bytes());
        for member in members {
            let stable = symbolic_audio_style_track_key(member).unwrap_or_default();
            hasher.update((stable.len() as u64).to_le_bytes());
            hasher.update(stable.as_bytes());
        }
    }
    hex::encode(hasher.finalize())
}

fn audio_style_symbolic_scope_signature(
    encoding: &AudioStyleSymbolicProgramEncoding,
    scope_globals: &[usize],
    tracks_by_global: &HashMap<usize, Vec<PlaybackTrack>>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"slisic.audio-symbolic-scope.v2");
    for global in scope_globals {
        let schedule_key = &encoding.track_keys[*global];
        hasher.update((schedule_key.len() as u64).to_le_bytes());
        hasher.update(schedule_key.as_bytes());
        let tracks = &tracks_by_global[global];
        hasher.update((tracks.len() as u64).to_le_bytes());
        for track in tracks {
            let stable = symbolic_audio_style_track_key(&PlaybackTrackKey::from_track(track))
                .unwrap_or_default();
            hasher.update((stable.len() as u64).to_le_bytes());
            hasher.update(stable.as_bytes());
        }
    }
    hex::encode(hasher.finalize())
}

impl AudioStyleSymbolicProgramEncoding {
    fn from_embeddings(
        embeddings: &AudioStyleEmbeddingMap,
        content_partition: &AudioStyleContentPartition,
    ) -> Result<Self, String> {
        let partition =
            AudioStyleSchedulePartition::from_content_partition(embeddings, content_partition)?;
        let rows =
            ranked_audio_style_candidate_rows(&partition.ordered_keys, &partition.embeddings)?;
        let candidate_count = rows[0].destinations.len();
        let candidate_neighbors = rows.into_iter().flat_map(|row| row.destinations).collect();
        Self::from_parts(partition, candidate_count, candidate_neighbors, None)
    }

    fn from_cached(
        cached: CachedAudioStyleSymbolicProgramEncoding,
        embeddings: &AudioStyleEmbeddingMap,
        content_partition: &AudioStyleContentPartition,
    ) -> Result<Self, String> {
        if cached.schema != AUDIO_STYLE_SYMBOLIC_PROGRAM_ENCODING_SCHEMA {
            return Err(format!(
                "unsupported symbolic program encoding schema `{}`",
                cached.schema
            ));
        }
        let partition =
            AudioStyleSchedulePartition::from_content_partition(embeddings, content_partition)?;
        if cached.track_count != partition.ordered_keys.len()
            || cached.candidate_width == 0
            || cached.candidate_rows.len() != cached.track_count
            || cached
                .candidate_rows
                .iter()
                .any(|row| row.len() != cached.candidate_width)
        {
            return Err("cached symbolic program encoding has a ragged relation".to_string());
        }
        if cached.track_key_signature != ordered_track_key_signature(&partition.track_keys)
            || cached.partition_signature != partition.signature
        {
            return Err(
                "cached symbolic program encoding and stable schedule partition differ".to_string(),
            );
        }
        let expected = (
            cached.candidate_relation_signature,
            cached.program_lineages,
            cached.program_encoding_signature,
        );
        Self::from_parts(
            partition,
            cached.candidate_width,
            cached.candidate_rows.into_iter().flatten().collect(),
            Some(expected),
        )
    }

    fn from_parts(
        partition: AudioStyleSchedulePartition,
        candidate_count: usize,
        candidate_neighbors: Vec<usize>,
        expected: Option<(String, Vec<String>, String)>,
    ) -> Result<Self, String> {
        let compilation = compile_neural_program_atlas(
            &partition.track_keys,
            candidate_count,
            &candidate_neighbors,
        )?;
        if !compilation.unclosed_presentations.is_empty() {
            return Err(format!(
                "symbolic candidate presentations are unclosed: {:?}",
                compilation.unclosed_presentations
            ));
        }
        let atlas = compilation
            .atlas
            .ok_or_else(|| "symbolic candidate relation has no executable program".to_string())?;
        let track_key_signature = ordered_track_key_signature(&partition.track_keys);
        let candidate_relation_signature = candidate_relation_signature(
            &partition.track_keys,
            candidate_count,
            &candidate_neighbors,
        )?;
        let program_encoding_signature = program_encoding_signature(&atlas.programs);
        if let Some((expected_candidate_signature, expected_lineages, expected_program_signature)) =
            expected
        {
            let lineages = atlas
                .programs
                .iter()
                .map(|program| program.lineage.clone())
                .collect::<Vec<_>>();
            if candidate_relation_signature != expected_candidate_signature
                || lineages != expected_lineages
                || program_encoding_signature != expected_program_signature
            {
                return Err(
                    "cached symbolic program signatures do not match their finite relation"
                        .to_string(),
                );
            }
        }
        let ordinal_by_key = partition
            .member_keys
            .iter()
            .enumerate()
            .flat_map(|(ordinal, members)| {
                members.iter().cloned().map(move |member| (member, ordinal))
            })
            .collect();
        Ok(Self {
            ordinal_by_key,
            ordered_keys: partition.ordered_keys,
            member_keys: partition.member_keys,
            track_keys: partition.track_keys,
            partition_signature: partition.signature,
            candidate_count,
            candidate_neighbors,
            atlas,
            track_key_signature,
            candidate_relation_signature,
            program_encoding_signature,
        })
    }

    fn to_cached(&self, generation: u64) -> CachedAudioStyleSymbolicProgramEncoding {
        CachedAudioStyleSymbolicProgramEncoding {
            schema: AUDIO_STYLE_SYMBOLIC_PROGRAM_ENCODING_SCHEMA.to_string(),
            stable_generation: generation,
            track_count: self.ordered_keys.len(),
            track_key_signature: self.track_key_signature.clone(),
            partition_signature: self.partition_signature.clone(),
            candidate_width: self.candidate_count,
            candidate_relation_signature: self.candidate_relation_signature.clone(),
            candidate_rows: self
                .candidate_neighbors
                .chunks_exact(self.candidate_count)
                .map(<[usize]>::to_vec)
                .collect(),
            program_lineages: self
                .atlas
                .programs
                .iter()
                .map(|program| program.lineage.clone())
                .collect(),
            program_encoding_signature: self.program_encoding_signature.clone(),
        }
    }
}

fn symbolic_audio_style_track_key(key: &PlaybackTrackKey) -> Result<String, String> {
    serde_json::to_string(&(
        &key.music_url,
        key.file_path.to_string_lossy(),
        key.start_ms,
        key.end_ms,
    ))
    .map_err(|error| format!("failed to encode symbolic audio track key: {error}"))
}

fn push_audio_style_symbolic_candidate(
    candidates: Option<&mut Vec<(PlaybackTrackKey, f32)>>,
    key: PlaybackTrackKey,
    similarity: f32,
    candidate_count: usize,
) {
    let Some(candidates) = candidates else {
        return;
    };
    if !similarity.is_finite() {
        return;
    }
    candidates.push((key, similarity));
    candidates.sort_by(|left, right| {
        right.1.total_cmp(&left.1).then_with(|| {
            audio_style_track_key_sort_value(&left.0)
                .cmp(&audio_style_track_key_sort_value(&right.0))
        })
    });
    candidates.truncate(candidate_count);
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
        Self { generation, state }
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn has_embedding_for(&self, track: &PlaybackTrack) -> bool {
        self.state
            .embeddings
            .contains_key(&PlaybackTrackKey::from_track(track))
    }

    pub(crate) fn symbolic_track_count(&self) -> Option<usize> {
        self.state
            .symbolic_program_encoding
            .as_ref()
            .map(|encoding| encoding.ordered_keys.len())
    }

    #[cfg(test)]
    pub(crate) fn symbolic_program_signatures_for_test(&self) -> Option<(&str, &str, &str)> {
        let encoding = self.state.symbolic_program_encoding.as_deref()?;
        Some((
            &encoding.track_key_signature,
            &encoding.candidate_relation_signature,
            &encoding.program_encoding_signature,
        ))
    }

    #[cfg(test)]
    pub(crate) fn from_test_embeddings(
        generation: u64,
        values: impl IntoIterator<Item = (PlaybackTrack, Vec<f32>)>,
    ) -> Self {
        let embeddings = values
            .into_iter()
            .filter_map(|(track, values)| {
                AudioStyleEmbedding::normalize(values)
                    .map(|embedding| (PlaybackTrackKey::from_track(&track), Arc::new(embedding)))
            })
            .collect::<HashMap<_, _>>();
        let state = Arc::new(AudioStyleModelState::from_embeddings(
            None,
            embeddings,
            HashMap::new(),
            &HashSet::new(),
        ));
        Self::from_state(generation, state)
    }

    #[cfg(test)]
    pub(crate) fn from_test_content_embeddings(
        generation: u64,
        values: impl IntoIterator<Item = (PlaybackTrack, Vec<f32>, String)>,
    ) -> Self {
        let mut embeddings = HashMap::new();
        let mut content_overrides = HashMap::new();
        for (track, values, content_key) in values {
            let Some(embedding) = AudioStyleEmbedding::normalize(values) else {
                continue;
            };
            let key = PlaybackTrackKey::from_track(&track);
            embeddings.insert(key.clone(), Arc::new(embedding));
            content_overrides.insert(key, content_key);
        }
        let state = Arc::new(
            AudioStyleModelState::from_embeddings_with_content_overrides(
                None,
                embeddings,
                HashMap::new(),
                &HashSet::new(),
                &content_overrides,
            ),
        );
        Self::from_state(generation, state)
    }

    #[cfg(test)]
    pub(crate) fn symbolic_partition_signature_for_test(&self) -> Option<&str> {
        self.state
            .symbolic_program_encoding
            .as_deref()
            .map(|encoding| encoding.partition_signature.as_str())
    }

    #[cfg(test)]
    pub(crate) fn from_test_indexed_embeddings(
        generation: u64,
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
        let state = Arc::new(AudioStyleModelState::from_embeddings(
            None,
            embeddings,
            indexed_tracks,
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

impl AudioStyleSymbolicPlaybackSession {
    pub(crate) fn committed_snapshot(&self) -> Self {
        let execution = self
            .pending_checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.execution.clone())
            .unwrap_or_else(|| self.execution.clone());
        Self {
            execution,
            pending_checkpoint: None,
            scope_revision: self.scope_revision,
            scope_dirty: self.scope_dirty,
        }
    }

    // @forma implements architecture Domain.PlaybackSessionProgramState as propose_next
    pub(crate) fn observe_scope_revision(&mut self, revision: u64) {
        if self.scope_revision != Some(revision) {
            if self.scope_revision.is_some() {
                self.scope_dirty = true;
            }
            self.scope_revision = Some(revision);
        }
    }

    fn cached_scope_matches(
        &self,
        snapshot: &AudioStyleModelSnapshot,
        current_track: &PlaybackTrack,
    ) -> bool {
        let current_key = PlaybackTrackKey::from_track(current_track);
        !self.scope_dirty
            && self.execution.as_ref().is_some_and(|execution| {
                let materialized_current = execution
                    .local_by_key
                    .get(&current_key)
                    .and_then(|local| execution.materializations.get(*local))
                    .is_some_and(|tracks| {
                        tracks
                            .iter()
                            .any(|track| PlaybackTrackKey::from_track(track) == current_key)
                    });
                execution.generation == snapshot.generation && materialized_current
            })
    }

    pub(crate) fn cached_scope_tracks_for(
        &self,
        snapshot: &AudioStyleModelSnapshot,
        current_track: &PlaybackTrack,
    ) -> Option<Vec<PlaybackTrack>> {
        self.cached_scope_matches(snapshot, current_track).then(|| {
            self.execution
                .as_ref()
                .expect("cached symbolic scope has an execution")
                .tracks
                .as_ref()
                .clone()
        })
    }

    pub(crate) fn propose_next(
        &mut self,
        snapshot: &AudioStyleModelSnapshot,
        current_track: &PlaybackTrack,
        candidates: &[PlaybackTrack],
        recently_played_tracks: &[PlaybackTrack],
    ) -> Result<AudioStyleSymbolicNextTrack, String> {
        if self.pending_checkpoint.is_some() {
            return Err("previous symbolic proposal is not committed".to_string());
        }
        let encoding = snapshot
            .state
            .symbolic_program_encoding
            .as_deref()
            .ok_or_else(|| {
                "stable generation has no executable symbolic program encoding".to_string()
            })?;
        let current_key = PlaybackTrackKey::from_track(current_track);
        if !encoding.ordinal_by_key.contains_key(&current_key) {
            return Err("current track is outside the stable symbolic encoding".to_string());
        }
        let mut execution = if self.cached_scope_matches(snapshot, current_track) {
            self.execution
                .as_ref()
                .expect("cached symbolic scope has an execution")
                .clone()
        } else {
            let mut tracks_by_global = HashMap::<usize, Vec<PlaybackTrack>>::new();
            for track in candidates.iter().chain(std::iter::once(current_track)) {
                let key = PlaybackTrackKey::from_track(track);
                if let Some(global) = encoding.ordinal_by_key.get(&key).copied() {
                    tracks_by_global
                        .entry(global)
                        .or_default()
                        .push(track.clone());
                }
            }
            for tracks in tracks_by_global.values_mut() {
                tracks.sort_by_key(|track| {
                    audio_style_track_key_sort_value(&PlaybackTrackKey::from_track(track))
                });
                tracks.dedup_by(|left, right| {
                    PlaybackTrackKey::from_track(left) == PlaybackTrackKey::from_track(right)
                });
            }
            if tracks_by_global.len() < 3 {
                return Err(
                    "playlist has fewer than three materialized stable symbolic tracks".to_string(),
                );
            }
            let mut scope_globals = tracks_by_global.keys().copied().collect::<Vec<_>>();
            scope_globals.sort_unstable();
            let scope_signature =
                audio_style_symbolic_scope_signature(encoding, &scope_globals, &tracks_by_global);
            let scope_changed = self.execution.as_ref().is_none_or(|execution| {
                execution.generation != snapshot.generation
                    || execution.scope_signature != scope_signature
            });
            if scope_changed {
                let previous = self.execution.as_ref();
                let scoped = restrict_neural_program_atlas_to_playlist(
                    &encoding.atlas,
                    &encoding.track_keys,
                    &scope_globals,
                )?;
                let scoped_candidates = candidate_relation_from_program_atlas(&scoped.atlas)?;
                let local_track_keys = scoped
                    .global_track_ordinals
                    .iter()
                    .map(|global| encoding.track_keys[*global].clone())
                    .collect::<Vec<_>>();
                let closure = close_neural_program_atlas_cycles(
                    &scoped.atlas,
                    &scoped_candidates,
                    &local_track_keys,
                )?;
                let atlas = Arc::new(closure.atlas.ok_or_else(|| {
                    format!(
                        "playlist symbolic presentations were retracted: {:?}",
                        closure.retracted_presentations
                    )
                })?);
                let orbit_index = Arc::new(compile_program_orbit_index(atlas.as_ref())?);
                let local_by_key = Arc::new(
                    scoped
                        .global_track_ordinals
                        .iter()
                        .enumerate()
                        .flat_map(|(local, global)| {
                            encoding.member_keys[*global]
                                .iter()
                                .cloned()
                                .map(move |member| (member, local))
                        })
                        .collect::<HashMap<_, _>>(),
                );
                let materializations = Arc::new(
                    scoped
                        .global_track_ordinals
                        .iter()
                        .map(|global| {
                            tracks_by_global.get(global).cloned().ok_or_else(|| {
                                "playlist symbolic scope lost materialized track metadata"
                                    .to_string()
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                );
                let current_global = encoding.ordinal_by_key[&current_key];
                let tracks = Arc::new(
                    scoped
                        .global_track_ordinals
                        .iter()
                        .enumerate()
                        .map(|(local, global)| {
                            if *global == current_global {
                                Ok(current_track.clone())
                            } else {
                                materializations[local].first().cloned().ok_or_else(|| {
                                    "playlist symbolic scope has no concrete materialization"
                                        .to_string()
                                })
                            }
                        })
                        .collect::<Result<Vec<_>, String>>()?,
                );
                let current_local = *local_by_key.get(&current_key).ok_or_else(|| {
                    "current track disappeared from playlist symbolic scope".to_string()
                })?;
                let realized = if let Some(previous) = previous {
                    let previous_realized = previous
                        .state
                        .realized_tracks(0)
                        .unwrap_or_default()
                        .into_iter()
                        .collect::<HashSet<_>>();
                    let mut realized = local_by_key
                        .iter()
                        .filter_map(|(key, local)| {
                            previous
                                .local_by_key
                                .get(key)
                                .filter(|previous_local| previous_realized.contains(previous_local))
                                .map(|_| *local)
                        })
                        .collect::<Vec<_>>();
                    realized.sort_unstable();
                    realized.dedup();
                    realized
                } else {
                    recently_played_tracks
                        .iter()
                        .filter_map(|track| {
                            local_by_key
                                .get(&PlaybackTrackKey::from_track(track))
                                .copied()
                        })
                        .collect::<Vec<_>>()
                };
                let state = transport_traversal_state(
                    previous.map(|execution| (execution.atlas.as_ref(), &execution.state)),
                    atlas.as_ref(),
                    &[current_local],
                    &[realized],
                )?;
                AudioStyleSymbolicPlaylistExecution {
                    generation: snapshot.generation,
                    scope_signature,
                    atlas,
                    orbit_index,
                    state,
                    local_by_key,
                    tracks,
                    materializations,
                }
            } else {
                self.execution
                    .as_ref()
                    .expect("unchanged scope has a symbolic execution")
                    .clone()
            }
        };
        let current_local = *execution
            .local_by_key
            .get(&current_key)
            .ok_or_else(|| "current track is outside the active symbolic scope".to_string())?;
        if execution.state.current_track(0) != Some(current_local) {
            let previous_state = execution.state.clone();
            let realized = previous_state.realized_tracks(0).unwrap_or_default();
            execution.state = transport_traversal_state(
                Some((execution.atlas.as_ref(), &previous_state)),
                execution.atlas.as_ref(),
                &[current_local],
                &[realized],
            )?;
        }
        let list = execute_program_list(
            execution.atlas.as_ref(),
            execution.orbit_index.as_ref(),
            1,
            &execution.state,
        )
        .map_err(|error| error.to_string())?;
        let next_local = list.order[0];
        let coverage_epoch = execution.state.coverage_epoch(0).unwrap_or_default();
        let materializations = execution
            .materializations
            .get(next_local)
            .ok_or_else(|| "symbolic execution selected an invalid local track".to_string())?;
        let track = materializations
            .get((coverage_epoch + next_local) % materializations.len())
            .cloned()
            .ok_or_else(|| {
                "symbolic execution selected an empty materialization class".to_string()
            })?;
        execution.state = list.next_state;
        self.pending_checkpoint = Some(Box::new(AudioStyleSymbolicPendingCheckpoint {
            execution: self.execution.clone(),
            scope_revision: self.scope_revision,
            scope_dirty: self.scope_dirty,
        }));
        self.execution = Some(execution);
        Ok(AudioStyleSymbolicNextTrack {
            track,
            style_sector_departure: list.style_sector_departures[0],
            coverage_epoch_transition: list.coverage_epoch_transitions[0],
        })
    }

    pub(crate) fn commit_proposal(&mut self) -> Result<(), String> {
        let checkpoint = self
            .pending_checkpoint
            .take()
            .ok_or_else(|| "symbolic session has no prepared proposal to commit".to_string())?;
        self.scope_dirty = self.scope_revision != checkpoint.scope_revision;
        Ok(())
    }

    pub(crate) fn rollback_proposal(&mut self) -> Result<(), String> {
        let checkpoint = self
            .pending_checkpoint
            .take()
            .ok_or_else(|| "symbolic session has no prepared proposal to roll back".to_string())?;
        self.execution = checkpoint.execution;
        self.scope_dirty =
            checkpoint.scope_dirty || self.scope_revision != checkpoint.scope_revision;
        Ok(())
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
        state: CachedAudioStyleModelState::from_state(
            snapshot.state.as_ref(),
            snapshot.generation(),
        ),
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
    if cached
        .state
        .symbolic_program_encoding
        .as_ref()
        .is_some_and(|encoding| encoding.stable_generation != cached.generation)
    {
        return Err(format!(
            "audio style stable model `{}` has a symbolic encoding from another generation",
            path.display()
        ));
    }
    let mut state = AudioStyleModelState::try_from(cached.state).map_err(|error| {
        format!(
            "audio style stable model `{}` has invalid state: {error}",
            path.display()
        )
    })?;
    if state.symbolic_program_encoding.is_none() {
        match AudioStyleSymbolicProgramEncoding::from_embeddings(
            &state.embeddings,
            state.content_partition.as_ref(),
        ) {
            Ok(encoding) => {
                log::info!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_symbolic_program_migrated source=stable_embeddings generation={} tracks={} policy=\"no_audio_reencoding\"",
                    cached.generation,
                    encoding.ordered_keys.len()
                );
                state.symbolic_program_encoding = Some(Arc::new(encoding));
            }
            Err(error) => {
                log::warn!(
                    target: AUDIO_STYLE_LOG_TARGET,
                    "audio_style_symbolic_program_unavailable source=stable_embeddings generation={} reason=\"{}\"",
                    cached.generation,
                    escape_log_value(&error)
                );
            }
        }
    }
    Ok(AudioStyleModelSnapshot::from_state(
        cached.generation,
        Arc::new(state),
    ))
}

fn read_audio_style_stable_model_with_refresh_status(
    path: &Path,
) -> Result<(AudioStyleModelSnapshot, bool), String> {
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
    let requires_refresh = cached.state.content_classes.is_empty()
        || cached
            .state
            .symbolic_program_encoding
            .as_ref()
            .is_none_or(|encoding| {
                encoding.schema != AUDIO_STYLE_SYMBOLIC_PROGRAM_ENCODING_SCHEMA
                    || encoding.partition_signature.is_empty()
            });
    snapshot_from_cached_audio_style_stable_model(cached, path)
        .map(|snapshot| (snapshot, requires_refresh))
}

#[cfg(test)]
fn read_audio_style_stable_model(path: &Path) -> Result<AudioStyleModelSnapshot, String> {
    read_audio_style_stable_model_with_refresh_status(path).map(|(snapshot, _)| snapshot)
}

fn read_and_refresh_audio_style_stable_model(
    path: &Path,
) -> Result<AudioStyleModelSnapshot, String> {
    let (snapshot, requires_refresh) = read_audio_style_stable_model_with_refresh_status(path)?;
    if requires_refresh {
        write_audio_style_stable_model(path, &snapshot)?;
    }
    Ok(snapshot)
}

#[cfg(test)]
pub(crate) fn read_audio_style_stable_model_for_test(
    path: &Path,
) -> Result<AudioStyleModelSnapshot, String> {
    read_audio_style_stable_model(path)
}

#[cfg(test)]
pub(crate) fn read_and_refresh_audio_style_stable_model_for_test(
    path: &Path,
) -> Result<AudioStyleModelSnapshot, String> {
    read_and_refresh_audio_style_stable_model(path)
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
pub(crate) fn audio_style_training_path_is_transient_for_test(path: &Path) -> bool {
    audio_style_training_path_is_transient(path)
}
