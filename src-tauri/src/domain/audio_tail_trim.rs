#[cfg(not(test))]
use super::collection_import;
use super::downloads::model::CollectionSourceKind;
#[cfg(not(test))]
use super::loudness_evidence::{self, LoudnessEvidenceRequest};
#[cfg(not(test))]
use super::player::service as player_service;
#[cfg(not(test))]
use super::player::track_identity_substitution::PlaybackTrackIdentityUpdate;
#[cfg(not(test))]
use super::playlist_playback::service as playlist_playback_service;
use super::playlists::model::{AudioStyleTrainingTrackInput, Collection, Music};
#[cfg(not(test))]
use super::playlists::repo as playlists_repo;
use super::playlists::repo::MusicEndTrim;
#[cfg(not(test))]
use crate::utils::binaries::{
    ManagedBinary, acquire_managed_binary_usage, ensure_managed_binary,
    wait_for_managed_binary_foreground_release,
};
use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
#[cfg(not(test))]
use std::collections::HashMap;
use std::collections::HashSet;
#[cfg(not(test))]
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(test))]
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
#[cfg(not(test))]
use tauri::{AppHandle, Manager};
#[cfg(not(test))]
use tokio::task;

#[cfg_attr(test, allow(dead_code))]
const AUDIO_TAIL_TRIM_LOG_TARGET: &str = "audio_tail_trim";
#[cfg_attr(test, allow(dead_code))]
pub(crate) const AUDIO_TAIL_TRIM_PENDING_TASK_FILE_NAME: &str = "audio-tail-trim-pending.json";
const AUDIO_TAIL_TRIM_PENDING_TASK_FILE_VERSION: &str = "audio-tail-trim-pending.v1";
#[cfg_attr(test, allow(dead_code))]
const MAX_AUDIO_TAIL_TRIM_QUEUE_LEN: usize = 32;
#[cfg_attr(test, allow(dead_code))]
const AUDIO_TAIL_TRIM_WORKER_COOLDOWN: Duration = Duration::from_millis(1500);
const MIN_TAIL_SAMPLE_COUNT: usize = 3;
#[cfg_attr(test, allow(dead_code))]
const TAIL_SEARCH_MS: u32 = 75_000;
const MIN_COMMON_TAIL_MS: u32 = 8_000;
const MIN_REMAINING_TRACK_MS: u32 = 20_000;
#[cfg_attr(test, allow(dead_code))]
const TAIL_FINGERPRINT_SAMPLE_RATE: u32 = 8_000;
const TAIL_FINGERPRINT_WINDOW_MS: u32 = 1_000;
const TAIL_FINGERPRINT_HOP_MS: u32 = 500;
#[cfg_attr(test, allow(dead_code))]
const TAIL_FINGERPRINT_SPECTRAL_BANDS: u32 = 24;
#[cfg_attr(test, allow(dead_code))]
const TAIL_FINGERPRINT_SILENCE_THRESHOLD_DB: f32 = -55.0;
#[cfg_attr(test, allow(dead_code))]
const TAIL_FINGERPRINT_SILENCE_PAD_MS: u32 = 300;
const TAIL_SIMILARITY_THRESHOLD: f32 = 0.88;
const TAIL_MAX_SHIFT_FRAMES: i32 = 2;
const TAIL_MAX_GAP_FRAMES: u32 = 1;
const TAIL_CLUSTER_DURATION_STEP_MS: u32 = 1_000;
const TAIL_CLUSTER_BASE_MIN_SIZE: usize = 5;
const TAIL_CLUSTER_MIN_DENSITY: f32 = 0.62;
const TAIL_CLUSTER_MIN_DEGREE_FRACTION: f32 = 0.50;
const TAIL_DOMINANT_RETENTION: f32 = 0.90;
const TAIL_ATTACHED_DURATION_QUANTILE: f32 = 0.25;
const TAIL_ATTACHED_MIN_LINK_FRACTION: f32 = 0.70;
const TAIL_CUT_REFINEMENT_LOOKBACK_MS: u32 = 3_000;
const TAIL_CUT_SILENCE_THRESHOLD_DB: f32 = -42.0;
const TAIL_CUT_RELATIVE_QUIET_DROP_DB: f32 = 8.0;
const TAIL_CUT_POST_QUIET_GUARD_MS: u32 = 400;
const TAIL_CUT_REENTRY_RISE_DB: f32 = 10.0;
const TAIL_CUT_EDGE_QUIET_MARGIN_DB: f32 = 6.0;

#[cfg(not(test))]
static AUDIO_TAIL_TRIM_RUNTIME: OnceLock<Arc<AudioTailTrimRuntime>> = OnceLock::new();

#[cfg(not(test))]
struct AudioTailTrimRuntime {
    app: AppHandle,
    pending_task_path: PathBuf,
    pending_task_file_lock: Mutex<()>,
    active_collections: Mutex<HashSet<AudioTailTrimCollectionKey>>,
    coalesced_active_requests: Mutex<HashMap<AudioTailTrimCollectionKey, CoalescedAudioTailTrim>>,
    queue: Mutex<VecDeque<QueuedAudioTailTrim>>,
    worker_running: AtomicBool,
}

#[cfg(not(test))]
struct QueuedAudioTailTrim {
    request: AudioTailTrimRequest,
    source: AudioTailTrimSource,
}

#[cfg(not(test))]
struct CoalescedAudioTailTrim {
    request: AudioTailTrimRequest,
    source: AudioTailTrimSource,
    rerun_required: bool,
}

#[cfg(not(test))]
struct AudioTailTrimCollectionClaim {
    runtime: Arc<AudioTailTrimRuntime>,
    collection_key: AudioTailTrimCollectionKey,
}

#[cfg(not(test))]
impl Drop for AudioTailTrimCollectionClaim {
    fn drop(&mut self) {
        if let Ok(mut active) = self.runtime.active_collections.lock() {
            active.remove(&self.collection_key);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct AudioTailTrimRequest {
    pub(crate) collection_url: String,
    pub(crate) source_kind: CollectionSourceKind,
    pub(crate) save_root: PathBuf,
    #[serde(default)]
    pub(crate) scope_group_url: Option<String>,
    #[serde(default)]
    pub(crate) focus_music: Option<AudioTailTrimFocusMusic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct AudioTailTrimFocusMusic {
    pub(crate) url: String,
    pub(crate) path: String,
    pub(crate) start_ms: u32,
    pub(crate) end_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AudioTailTrimPendingTaskFile {
    version: String,
    requests: Vec<AudioTailTrimRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct AudioTailTrimCollectionKey {
    collection_url: String,
    scope_group_url: Option<String>,
}

impl AudioTailTrimCollectionKey {
    fn from_request(request: &AudioTailTrimRequest) -> Self {
        Self {
            collection_url: request.collection_url.clone(),
            scope_group_url: normalized_optional_url(request.scope_group_url.as_deref()),
        }
    }

    fn as_log_key(&self) -> String {
        match self.scope_group_url.as_deref() {
            Some(group_url) => format!("{}#{}", self.collection_url, group_url),
            None => self.collection_url.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioTailTrimSource {
    PendingStore,
    DownloadedLeaf,
    DownloadedLeafForeground,
}

impl AudioTailTrimSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::PendingStore => "pending_store",
            Self::DownloadedLeaf => "downloaded_leaf",
            Self::DownloadedLeafForeground => "downloaded_leaf_foreground",
        }
    }

    fn priority(self) -> u8 {
        match self {
            Self::PendingStore => 0,
            Self::DownloadedLeaf => 1,
            Self::DownloadedLeafForeground => 2,
        }
    }

    #[cfg(not(test))]
    fn persists_pending(self) -> bool {
        matches!(self, Self::DownloadedLeaf | Self::DownloadedLeafForeground)
    }

    #[cfg(not(test))]
    fn coalesces_active(self) -> bool {
        matches!(self, Self::DownloadedLeaf | Self::DownloadedLeafForeground)
    }

    fn requires_active_rerun(self) -> bool {
        matches!(self, Self::DownloadedLeaf | Self::DownloadedLeafForeground)
    }

    fn completes_foreground_playable_gate(self) -> bool {
        matches!(self, Self::DownloadedLeafForeground)
    }
}

fn completed_audio_tail_trim_opens_foreground_playable_gate(
    source: AudioTailTrimSource,
    processed_ok: bool,
) -> bool {
    processed_ok && source.completes_foreground_playable_gate()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AudioTailTrimCandidate {
    pub(crate) canonical_music_id: String,
    pub(crate) url: String,
    pub(crate) path: String,
    pub(crate) file_path: PathBuf,
    pub(crate) start_ms: u32,
    pub(crate) end_ms: u32,
}

impl AudioTailTrimCandidate {
    #[cfg_attr(test, allow(dead_code))]
    fn playable_duration_ms(&self) -> u32 {
        self.end_ms.saturating_sub(self.start_ms)
    }

    fn trim_to(&self, next_end_ms: u32) -> MusicEndTrim {
        MusicEndTrim {
            url: self.url.clone(),
            start_ms: self.start_ms,
            end_ms: self.end_ms,
            next_end_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TailEvidenceSignature {
    pub(crate) frames: Vec<TailEvidenceFrame>,
    pub(crate) search_start_ms: u32,
    pub(crate) effective_end_ms: u32,
    pub(crate) window_ms: u32,
    pub(crate) hop_ms: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TailEvidenceFrame {
    pub(crate) source_start_ms: u32,
    pub(crate) source_end_ms: u32,
    pub(crate) rms_db: f32,
    pub(crate) bands: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PairTailMatch {
    pub(crate) left_index: usize,
    pub(crate) right_index: usize,
    pub(crate) duration_ms: u32,
    pub(crate) matched_frames: u32,
    pub(crate) visited_frames: u32,
    pub(crate) median_similarity: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CommonTailEvidence {
    pub(crate) duration_ms: u32,
    pub(crate) support: usize,
    pub(crate) density: f32,
    pub(crate) candidate_count: usize,
    pub(crate) similarity_threshold: f32,
    pub(crate) members: Vec<usize>,
    pub(crate) attached: Vec<TrackTailAttachment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TrackTailAttachment {
    pub(crate) index: usize,
    pub(crate) duration_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioTailTrimEvidenceOrigin {
    FullCollection,
}

impl AudioTailTrimEvidenceOrigin {
    #[cfg_attr(test, allow(dead_code))]
    fn as_str(self) -> &'static str {
        match self {
            Self::FullCollection => "full_collection",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolvedAudioTailTrimEvidence {
    pub(crate) evidence: CommonTailEvidence,
    pub(crate) origin: AudioTailTrimEvidenceOrigin,
}

#[cfg(not(test))]
pub(crate) fn initialize_runtime(app: AppHandle) {
    let runtime = AUDIO_TAIL_TRIM_RUNTIME
        .get_or_init(|| {
            let pending_task_path =
                audio_tail_trim_pending_task_path(&app).unwrap_or_else(|error| {
                    log::error!(
                        target: AUDIO_TAIL_TRIM_LOG_TARGET,
                        "audio_tail_trim_pending_path_failed error=\"{}\"",
                        error
                    );
                    PathBuf::new()
                });
            Arc::new(AudioTailTrimRuntime {
                app,
                pending_task_path,
                pending_task_file_lock: Mutex::new(()),
                active_collections: Mutex::new(HashSet::new()),
                coalesced_active_requests: Mutex::new(HashMap::new()),
                queue: Mutex::new(VecDeque::new()),
                worker_running: AtomicBool::new(false),
            })
        })
        .clone();

    restore_pending_audio_tail_trim_tasks(runtime);
}

#[cfg(not(test))]
pub(crate) fn request_downloaded_leaf_audio_tail_trim(request: AudioTailTrimRequest) {
    let Some(runtime) = AUDIO_TAIL_TRIM_RUNTIME.get().cloned() else {
        log::warn!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_request_skipped source=downloaded_leaf reason=runtime_uninitialized collection=\"{}\"",
            request.collection_url
        );
        return;
    };

    log::info!(
        target: AUDIO_TAIL_TRIM_LOG_TARGET,
        "audio_tail_trim_request_received source=downloaded_leaf collection=\"{}\" source_kind={} save_root=\"{}\"",
        request.collection_url,
        request.source_kind.as_str(),
        request.save_root.display()
    );
    enqueue_audio_tail_trim(runtime, request, AudioTailTrimSource::DownloadedLeaf);
}

#[cfg(not(test))]
pub(crate) fn request_downloaded_leaf_foreground_audio_tail_trim(request: AudioTailTrimRequest) {
    let Some(runtime) = AUDIO_TAIL_TRIM_RUNTIME.get().cloned() else {
        log::warn!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_request_skipped source=downloaded_leaf_foreground reason=runtime_uninitialized collection=\"{}\"",
            request.collection_url
        );
        return;
    };

    log::info!(
        target: AUDIO_TAIL_TRIM_LOG_TARGET,
        "audio_tail_trim_request_received source=downloaded_leaf_foreground collection=\"{}\" source_kind={} save_root=\"{}\"",
        request.collection_url,
        request.source_kind.as_str(),
        request.save_root.display()
    );
    enqueue_audio_tail_trim(
        runtime,
        request,
        AudioTailTrimSource::DownloadedLeafForeground,
    );
}

pub(crate) fn collect_audio_tail_trim_candidates(
    collection: &Collection,
    save_root: &Path,
) -> Vec<AudioTailTrimCandidate> {
    let collection_root = save_root.join(&collection.folder);
    let mut seen_paths = HashSet::new();
    collection
        .musics
        .iter()
        .filter_map(|music| candidate_from_music(music, &collection_root))
        .filter(|candidate| {
            candidate.playable_duration_ms() > MIN_COMMON_TAIL_MS + MIN_REMAINING_TRACK_MS
        })
        .filter(|candidate| seen_paths.insert(candidate.path.clone()))
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioTailTrimScopeKind {
    Group,
    Collection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AudioTailTrimScopeSelection {
    pub(crate) kind: AudioTailTrimScopeKind,
    pub(crate) url: String,
    pub(crate) candidates: Vec<AudioTailTrimCandidate>,
    pub(crate) skipped_collection_candidates: usize,
}

impl AudioTailTrimScopeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Group => "group",
            Self::Collection => "collection",
        }
    }
}

pub(crate) fn select_audio_tail_trim_scope(
    collection: &Collection,
    candidates: Vec<AudioTailTrimCandidate>,
    scope_group_url: Option<&str>,
) -> Option<AudioTailTrimScopeSelection> {
    let scope_group_url = normalized_optional_url(scope_group_url);
    if let Some(group_url) = scope_group_url.as_deref() {
        let scoped = candidates
            .iter()
            .filter(|candidate| music_belongs_to_group(collection, candidate, group_url))
            .cloned()
            .collect::<Vec<_>>();
        if scoped.len() >= MIN_TAIL_SAMPLE_COUNT {
            return Some(AudioTailTrimScopeSelection {
                kind: AudioTailTrimScopeKind::Group,
                url: group_url.to_string(),
                skipped_collection_candidates: candidates.len().saturating_sub(scoped.len()),
                candidates: scoped,
            });
        }
        return None;
    }

    let group_urls = collection
        .musics
        .iter()
        .filter_map(|music| {
            candidate_from_music(music, Path::new(""))
                .filter(|candidate| {
                    candidate.playable_duration_ms() > MIN_COMMON_TAIL_MS + MIN_REMAINING_TRACK_MS
                })
                .map(|_| music.group.url.clone())
        })
        .collect::<HashSet<_>>();
    if group_urls.len() > 1 {
        return None;
    }

    (candidates.len() >= MIN_TAIL_SAMPLE_COUNT).then(|| AudioTailTrimScopeSelection {
        kind: AudioTailTrimScopeKind::Collection,
        url: collection.url.clone(),
        skipped_collection_candidates: 0,
        candidates,
    })
}

fn music_belongs_to_group(
    collection: &Collection,
    candidate: &AudioTailTrimCandidate,
    group_url: &str,
) -> bool {
    collection.musics.iter().any(|music| {
        music.group.url == group_url
            && music.url == candidate.url
            && music.start_ms == candidate.start_ms
            && music.end_ms == candidate.end_ms
            && music
                .path
                .as_deref()
                .is_some_and(|path| normalize_path_text(path) == candidate.path)
    })
}

fn prioritize_audio_tail_trim_focus_candidate(
    candidates: &mut Vec<AudioTailTrimCandidate>,
    focus_music: Option<&AudioTailTrimFocusMusic>,
) -> bool {
    let Some(focus_music) = focus_music else {
        return false;
    };
    let Some(index) = candidates
        .iter()
        .position(|candidate| focus_music.matches_candidate(candidate))
    else {
        return false;
    };
    if index == 0 {
        return true;
    }

    let focused = candidates.remove(index);
    candidates.insert(0, focused);
    true
}

fn take_next_audio_tail_trim_candidate(
    candidates: &mut Vec<AudioTailTrimCandidate>,
    focus_music: Option<&AudioTailTrimFocusMusic>,
) -> Option<AudioTailTrimCandidate> {
    if let Some(focus_music) = focus_music
        && let Some(index) = candidates
            .iter()
            .position(|candidate| focus_music.matches_candidate(candidate))
    {
        return Some(candidates.remove(index));
    }

    (!candidates.is_empty()).then(|| candidates.remove(0))
}

impl AudioTailTrimFocusMusic {
    fn matches_candidate(&self, candidate: &AudioTailTrimCandidate) -> bool {
        self.url == candidate.url
            && self.start_ms == candidate.start_ms
            && self.end_ms == candidate.end_ms
            && normalize_path_text(&self.path) == candidate.path
    }

    fn matches_trim(&self, trim: &MusicEndTrim) -> bool {
        self.url == trim.url && self.start_ms == trim.start_ms && self.end_ms == trim.end_ms
    }
}

fn candidate_from_music(music: &Music, collection_root: &Path) -> Option<AudioTailTrimCandidate> {
    if music.start_ms >= music.end_ms {
        return None;
    }
    let path = music.path.as_deref()?.trim();
    if path.is_empty() {
        return None;
    }

    let file_path = collection_root.join(path);
    Some(AudioTailTrimCandidate {
        canonical_music_id: music.canonical_music_id.clone(),
        url: music.url.clone(),
        path: normalize_path_text(path),
        file_path,
        start_ms: music.start_ms,
        end_ms: music.end_ms,
    })
}

pub(crate) fn detect_common_tail_evidence(
    signatures: &[TailEvidenceSignature],
) -> Option<CommonTailEvidence> {
    if signatures.len() < MIN_TAIL_SAMPLE_COUNT {
        return None;
    }

    let pair_matches = build_pair_tail_matches(signatures, TAIL_SIMILARITY_THRESHOLD);
    let dominant = select_dominant_tail_cluster(&pair_matches, signatures.len())?;
    if dominant.duration_ms < MIN_COMMON_TAIL_MS {
        return None;
    }
    let attachments = build_tail_attachments(&pair_matches, signatures.len(), &dominant);
    if attachments.len() < cluster_min_size(signatures.len()) {
        return None;
    }

    Some(CommonTailEvidence {
        duration_ms: dominant.duration_ms,
        support: dominant.members.len(),
        density: dominant.density,
        candidate_count: signatures.len(),
        similarity_threshold: TAIL_SIMILARITY_THRESHOLD,
        members: dominant.members,
        attached: attachments,
    })
}

pub(crate) fn resolve_audio_tail_trim_evidence(
    signatures: &[TailEvidenceSignature],
) -> Option<ResolvedAudioTailTrimEvidence> {
    detect_common_tail_evidence(signatures).map(|evidence| ResolvedAudioTailTrimEvidence {
        evidence,
        origin: AudioTailTrimEvidenceOrigin::FullCollection,
    })
}

pub(crate) fn build_audio_tail_trim_plan(
    candidates: &[AudioTailTrimCandidate],
    signatures: &[TailEvidenceSignature],
    evidence: &CommonTailEvidence,
) -> Vec<MusicEndTrim> {
    evidence
        .attached
        .iter()
        .filter_map(|attachment| {
            let candidate = candidates.get(attachment.index)?;
            let signature = signatures.get(attachment.index)?;
            let next_end_ms = refined_tail_cut_ms(candidate, signature, attachment.duration_ms)?;
            (next_end_ms < candidate.end_ms
                && candidate.start_ms + MIN_REMAINING_TRACK_MS <= next_end_ms)
                .then(|| candidate.trim_to(next_end_ms))
        })
        .collect()
}

fn refined_tail_cut_ms(
    candidate: &AudioTailTrimCandidate,
    signature: &TailEvidenceSignature,
    tail_duration_ms: u32,
) -> Option<u32> {
    let coarse_cut_ms = signature
        .effective_end_ms
        .checked_sub(tail_duration_ms)
        .or_else(|| candidate.end_ms.checked_sub(tail_duration_ms))?
        .clamp(candidate.start_ms, candidate.end_ms);
    Some(
        refine_tail_cut_to_quiet_boundary(signature, coarse_cut_ms)
            .clamp(candidate.start_ms, candidate.end_ms),
    )
}

fn refine_tail_cut_to_quiet_boundary(signature: &TailEvidenceSignature, coarse_cut_ms: u32) -> u32 {
    let nearby_frames = signature
        .frames
        .iter()
        .filter(|frame| {
            frame.source_end_ms >= coarse_cut_ms.saturating_sub(TAIL_CUT_REFINEMENT_LOOKBACK_MS)
                && frame.source_start_ms <= coarse_cut_ms.saturating_add(signature.window_ms)
        })
        .collect::<Vec<_>>();
    if nearby_frames.is_empty() {
        return coarse_cut_ms;
    }

    let loud_reference = nearby_frames
        .iter()
        .map(|frame| frame.rms_db)
        .filter(|value| value.is_finite())
        .fold(f32::NEG_INFINITY, f32::max);
    let quiet_threshold = if loud_reference.is_finite() {
        TAIL_CUT_SILENCE_THRESHOLD_DB.min(loud_reference - TAIL_CUT_RELATIVE_QUIET_DROP_DB)
    } else {
        TAIL_CUT_SILENCE_THRESHOLD_DB
    };

    let quiet_frames = nearby_frames
        .iter()
        .copied()
        .filter(|frame| frame.source_end_ms <= coarse_cut_ms)
        .filter(|frame| frame.rms_db <= quiet_threshold)
        .collect::<Vec<_>>();

    let Some(cut_frame) = quiet_frames
        .iter()
        .max_by(|left, right| {
            left.source_end_ms
                .cmp(&right.source_end_ms)
                .then_with(|| right.rms_db.total_cmp(&left.rms_db))
        })
        .copied()
    else {
        return coarse_cut_ms;
    };

    let trailing_reentry = nearby_frames.iter().any(|frame| {
        frame.source_start_ms
            <= cut_frame
                .source_end_ms
                .saturating_add(TAIL_CUT_POST_QUIET_GUARD_MS)
            && frame.source_end_ms > cut_frame.source_start_ms
            && frame.rms_db >= quiet_threshold + TAIL_CUT_REENTRY_RISE_DB
    });
    let edge_quiet = cut_frame.rms_db >= quiet_threshold - TAIL_CUT_EDGE_QUIET_MARGIN_DB;
    if trailing_reentry && edge_quiet {
        cut_frame.source_start_ms
    } else {
        cut_frame.source_end_ms
    }
}

fn build_audio_tail_trim_focus_plan(
    candidates: &[AudioTailTrimCandidate],
    signatures: &[TailEvidenceSignature],
    focus_music: Option<&AudioTailTrimFocusMusic>,
) -> Option<(ResolvedAudioTailTrimEvidence, Vec<MusicEndTrim>)> {
    let focus_music = focus_music?;
    let resolved = resolve_audio_tail_trim_evidence(signatures)?;
    let plan = build_audio_tail_trim_plan(candidates, signatures, &resolved.evidence)
        .into_iter()
        .filter(|trim| focus_music.matches_trim(trim))
        .collect::<Vec<_>>();

    (!plan.is_empty()).then_some((resolved, plan))
}

fn merge_audio_tail_trim_request(
    existing: AudioTailTrimRequest,
    incoming: AudioTailTrimRequest,
) -> AudioTailTrimRequest {
    AudioTailTrimRequest {
        focus_music: incoming.focus_music.or(existing.focus_music),
        ..incoming
    }
}

fn filter_unapplied_audio_tail_trim_plan(
    plan: Vec<MusicEndTrim>,
    applied_trim_keys: &HashSet<(String, u32, u32)>,
) -> Vec<MusicEndTrim> {
    plan.into_iter()
        .filter(|trim| !applied_trim_keys.contains(&audio_tail_trim_key(trim)))
        .collect()
}

fn audio_tail_trim_key(trim: &MusicEndTrim) -> (String, u32, u32) {
    (trim.url.clone(), trim.start_ms, trim.end_ms)
}

#[derive(Debug, Clone, PartialEq)]
struct TailCluster {
    duration_ms: u32,
    members: Vec<usize>,
    density: f32,
    internal_edges: usize,
}

fn build_pair_tail_matches(
    signatures: &[TailEvidenceSignature],
    threshold: f32,
) -> Vec<PairTailMatch> {
    let mut matches = Vec::new();
    for left_index in 0..signatures.len() {
        for right_index in left_index + 1..signatures.len() {
            let pair = suffix_match(signatures, left_index, right_index, threshold);
            if pair.duration_ms >= MIN_COMMON_TAIL_MS {
                matches.push(pair);
            }
        }
    }
    matches
}

fn suffix_match(
    signatures: &[TailEvidenceSignature],
    left_index: usize,
    right_index: usize,
    threshold: f32,
) -> PairTailMatch {
    let Some(left) = signatures.get(left_index) else {
        return empty_pair_tail_match(left_index, right_index);
    };
    let Some(right) = signatures.get(right_index) else {
        return empty_pair_tail_match(left_index, right_index);
    };
    let left_to_right = suffix_match_frames(&left.frames, &right.frames, threshold);
    let right_to_left = suffix_match_frames(&right.frames, &left.frames, threshold);
    let best =
        if tail_match_stats_sort_key(right_to_left) > tail_match_stats_sort_key(left_to_right) {
            right_to_left
        } else {
            left_to_right
        };

    PairTailMatch {
        left_index,
        right_index,
        duration_ms: best.duration_ms,
        matched_frames: best.matched_frames,
        visited_frames: best.visited_frames,
        median_similarity: best.median_similarity,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct TailMatchStats {
    duration_ms: u32,
    matched_frames: u32,
    visited_frames: u32,
    median_similarity: f32,
}

fn suffix_match_frames(
    left: &[TailEvidenceFrame],
    right: &[TailEvidenceFrame],
    threshold: f32,
) -> TailMatchStats {
    let mut left_frame = 0_usize;
    let mut right_frame = 0_usize;
    let mut visited = 0_u32;
    let mut matched = 0_u32;
    let mut gaps = 0_u32;
    let mut similarities = Vec::new();

    while left_frame < left.len() && right_frame < right.len() {
        let mut best = f32::NEG_INFINITY;
        let mut best_right = right_frame;
        for shift in 0..=TAIL_MAX_SHIFT_FRAMES.max(0) as usize {
            let shifted = right_frame + shift;
            if shifted >= right.len() {
                continue;
            }
            let similarity = cosine_like_dot(&left[left_frame].bands, &right[shifted].bands);
            if similarity > best {
                best = similarity;
                best_right = shifted;
            }
        }

        if best >= threshold {
            matched += 1;
            visited += 1;
            gaps = 0;
            similarities.push(best);
            left_frame += 1;
            right_frame = best_right + 1;
            continue;
        }

        if matched > 0 && gaps < TAIL_MAX_GAP_FRAMES {
            gaps += 1;
            visited += 1;
            similarities.push(best);
            left_frame += 1;
            right_frame += 1;
            continue;
        }

        break;
    }

    if matched == 0 {
        return TailMatchStats {
            duration_ms: 0,
            matched_frames: 0,
            visited_frames: 0,
            median_similarity: 0.0,
        };
    }

    let trimmed_visited = matched.max(visited.saturating_sub(gaps));
    similarities.truncate(trimmed_visited as usize);
    TailMatchStats {
        duration_ms: TAIL_FINGERPRINT_WINDOW_MS
            + trimmed_visited
                .saturating_sub(1)
                .saturating_mul(TAIL_FINGERPRINT_HOP_MS),
        matched_frames: matched,
        visited_frames: trimmed_visited,
        median_similarity: quantile_f32(&similarities, 0.50),
    }
}

fn tail_match_stats_sort_key(stats: TailMatchStats) -> (u32, u32, i32) {
    (
        stats.duration_ms,
        stats.matched_frames,
        (stats.median_similarity * 1_000_000.0) as i32,
    )
}

fn empty_pair_tail_match(left_index: usize, right_index: usize) -> PairTailMatch {
    PairTailMatch {
        left_index,
        right_index,
        duration_ms: 0,
        matched_frames: 0,
        visited_frames: 0,
        median_similarity: 0.0,
    }
}

fn select_dominant_tail_cluster(
    pair_matches: &[PairTailMatch],
    candidate_count: usize,
) -> Option<TailCluster> {
    let max_duration = pair_matches.iter().map(|pair| pair.duration_ms).max()?;
    let mut duration_ms = max_duration - (max_duration % TAIL_CLUSTER_DURATION_STEP_MS);
    let mut best_by_duration = Vec::new();
    while duration_ms >= MIN_COMMON_TAIL_MS {
        if let Some(cluster) = best_cluster_at_duration(pair_matches, candidate_count, duration_ms)
        {
            best_by_duration.push(cluster);
        }
        duration_ms = duration_ms.saturating_sub(TAIL_CLUSTER_DURATION_STEP_MS);
    }

    let max_cluster_size = best_by_duration
        .iter()
        .map(|cluster| cluster.members.len())
        .max()?;
    let retained_size = ((max_cluster_size as f32) * TAIL_DOMINANT_RETENTION).floor() as usize;
    best_by_duration.into_iter().find(|cluster| {
        cluster.members.len() >= retained_size && cluster.density >= TAIL_CLUSTER_MIN_DENSITY
    })
}

fn best_cluster_at_duration(
    pair_matches: &[PairTailMatch],
    candidate_count: usize,
    duration_ms: u32,
) -> Option<TailCluster> {
    let edge_set = edge_set_at_duration(pair_matches, duration_ms);
    let mut clusters = connected_components(candidate_count, &edge_set)
        .into_iter()
        .filter(|component| component.len() >= cluster_min_size(candidate_count))
        .filter_map(|component| {
            let core = refine_dense_core(component, &edge_set);
            build_dense_cluster(core, &edge_set, duration_ms, candidate_count)
        })
        .collect::<Vec<_>>();
    clusters.sort_by(|left, right| {
        right
            .duration_ms
            .cmp(&left.duration_ms)
            .then_with(|| right.members.len().cmp(&left.members.len()))
            .then_with(|| right.density.total_cmp(&left.density))
    });
    clusters.into_iter().next()
}

fn build_tail_attachments(
    pair_matches: &[PairTailMatch],
    candidate_count: usize,
    cluster: &TailCluster,
) -> Vec<TrackTailAttachment> {
    let member_set = cluster.members.iter().copied().collect::<HashSet<_>>();
    let min_link_count = ((cluster.members.len() as f32) * TAIL_ATTACHED_MIN_LINK_FRACTION)
        .ceil()
        .max(1.0) as usize;
    let mut attachments = Vec::new();
    for index in 0..candidate_count {
        let link_durations = pair_matches
            .iter()
            .filter_map(|pair| {
                if pair.left_index == index && member_set.contains(&pair.right_index) {
                    Some(pair.duration_ms)
                } else if pair.right_index == index && member_set.contains(&pair.left_index) {
                    Some(pair.duration_ms)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        if member_set.contains(&index) {
            attachments.push(TrackTailAttachment {
                index,
                duration_ms: cluster.duration_ms,
            });
            continue;
        }
        if link_durations.is_empty() {
            continue;
        }
        let attached_duration = quantile_u32(&link_durations, TAIL_ATTACHED_DURATION_QUANTILE);
        let links_at_duration = link_durations
            .iter()
            .filter(|duration| **duration >= attached_duration)
            .count();
        if attached_duration >= MIN_COMMON_TAIL_MS && links_at_duration >= min_link_count {
            attachments.push(TrackTailAttachment {
                index,
                duration_ms: attached_duration,
            });
        }
    }
    attachments.sort_by_key(|attachment| attachment.index);
    attachments
}

fn edge_set_at_duration(
    pair_matches: &[PairTailMatch],
    duration_ms: u32,
) -> HashSet<(usize, usize)> {
    pair_matches
        .iter()
        .filter(|pair| pair.duration_ms >= duration_ms)
        .map(|pair| normalized_edge(pair.left_index, pair.right_index))
        .collect()
}

fn connected_components(
    candidate_count: usize,
    edges: &HashSet<(usize, usize)>,
) -> Vec<Vec<usize>> {
    let mut parent = (0..candidate_count).collect::<Vec<_>>();
    for &(left, right) in edges {
        union_parent(&mut parent, left, right);
    }
    let mut components = Vec::<Vec<usize>>::new();
    let mut roots = Vec::<usize>::new();
    for index in 0..candidate_count {
        let root = find_parent(&mut parent, index);
        if let Some(position) = roots.iter().position(|existing| *existing == root) {
            components[position].push(index);
        } else {
            roots.push(root);
            components.push(vec![index]);
        }
    }
    components
}

fn refine_dense_core(component: Vec<usize>, edges: &HashSet<(usize, usize)>) -> Vec<usize> {
    let mut nodes = component;
    let mut changed = true;
    while changed && nodes.len() >= MIN_TAIL_SAMPLE_COUNT {
        changed = false;
        let min_degree = 2_usize.max(
            ((nodes.len().saturating_sub(1) as f32) * TAIL_CLUSTER_MIN_DEGREE_FRACTION).ceil()
                as usize,
        );
        let next = nodes
            .iter()
            .copied()
            .filter(|node| {
                nodes
                    .iter()
                    .filter(|other| **other != *node)
                    .filter(|other| edges.contains(&normalized_edge(*node, **other)))
                    .count()
                    >= min_degree
            })
            .collect::<Vec<_>>();
        if next.len() != nodes.len() {
            nodes = next;
            changed = true;
        }
    }
    nodes
}

fn build_dense_cluster(
    members: Vec<usize>,
    edges: &HashSet<(usize, usize)>,
    duration_ms: u32,
    candidate_count: usize,
) -> Option<TailCluster> {
    if members.len() < cluster_min_size(candidate_count) {
        return None;
    }
    let mut internal_edges = 0_usize;
    for left_position in 0..members.len() {
        for right_position in left_position + 1..members.len() {
            if edges.contains(&normalized_edge(
                members[left_position],
                members[right_position],
            )) {
                internal_edges += 1;
            }
        }
    }
    let possible_edges = members.len() * members.len().saturating_sub(1) / 2;
    let density = if possible_edges == 0 {
        0.0
    } else {
        internal_edges as f32 / possible_edges as f32
    };
    (density >= TAIL_CLUSTER_MIN_DENSITY).then_some(TailCluster {
        duration_ms,
        members,
        density,
        internal_edges,
    })
}

fn cluster_min_size(candidate_count: usize) -> usize {
    if candidate_count < TAIL_CLUSTER_BASE_MIN_SIZE {
        MIN_TAIL_SAMPLE_COUNT
    } else {
        TAIL_CLUSTER_BASE_MIN_SIZE
    }
}

fn normalized_edge(left: usize, right: usize) -> (usize, usize) {
    if left <= right {
        (left, right)
    } else {
        (right, left)
    }
}

fn find_parent(parent: &mut [usize], value: usize) -> usize {
    if parent[value] != value {
        parent[value] = find_parent(parent, parent[value]);
    }
    parent[value]
}

fn union_parent(parent: &mut [usize], left: usize, right: usize) {
    let left_root = find_parent(parent, left);
    let right_root = find_parent(parent, right);
    if left_root != right_root {
        parent[right_root] = left_root;
    }
}

fn cosine_like_dot(left: &[f32], right: &[f32]) -> f32 {
    left.iter()
        .zip(right.iter())
        .map(|(left, right)| left * right)
        .sum()
}

fn quantile_u32(values: &[u32], quantile: f32) -> u32 {
    if values.is_empty() {
        return 0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let index = ((sorted.len() - 1) as f32 * quantile.clamp(0.0, 1.0)).floor() as usize;
    sorted[index]
}

fn quantile_f32(values: &[f32], quantile: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.total_cmp(right));
    let index = ((sorted.len() - 1) as f32 * quantile.clamp(0.0, 1.0)).floor() as usize;
    sorted[index]
}

#[cfg(not(test))]
fn restore_pending_audio_tail_trim_tasks(runtime: Arc<AudioTailTrimRuntime>) {
    if runtime.pending_task_path.as_os_str().is_empty() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        if let Err(error) = restore_pending_audio_tail_trim_tasks_from_disk(runtime).await {
            log::error!(
                target: AUDIO_TAIL_TRIM_LOG_TARGET,
                "audio_tail_trim_pending_restore_failed error=\"{}\"",
                error
            );
        }
    });
}

#[cfg(not(test))]
async fn restore_pending_audio_tail_trim_tasks_from_disk(
    runtime: Arc<AudioTailTrimRuntime>,
) -> Result<()> {
    let pending = {
        let _guard = runtime
            .pending_task_file_lock
            .lock()
            .map_err(|_| anyhow!("audio tail trim pending task file lock is poisoned"))?;
        read_audio_tail_trim_pending_task_file(&runtime.pending_task_path)?
    };
    let total = pending.len();

    for request in pending {
        enqueue_audio_tail_trim(
            Arc::clone(&runtime),
            request,
            AudioTailTrimSource::PendingStore,
        );
    }

    if total > 0 {
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_pending_restored count={}",
            total
        );
    }

    Ok(())
}

#[cfg(not(test))]
fn audio_tail_trim_pending_task_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| anyhow!("failed to resolve app local data directory: {error}"))?
        .join(AUDIO_TAIL_TRIM_PENDING_TASK_FILE_NAME))
}

#[cfg(not(test))]
fn enqueue_audio_tail_trim(
    runtime: Arc<AudioTailTrimRuntime>,
    request: AudioTailTrimRequest,
    source: AudioTailTrimSource,
) {
    let collection_key = AudioTailTrimCollectionKey::from_request(&request);
    if request.source_kind != CollectionSourceKind::List {
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_request_skipped source={} reason=unsupported_source_kind collection=\"{}\" source_kind={}",
            source.as_str(),
            collection_key.as_log_key(),
            request.source_kind.as_str()
        );
        return;
    }

    if audio_tail_trim_collection_is_processing(&runtime, &collection_key) {
        if source.coalesces_active() {
            coalesce_active_audio_tail_trim_request(
                &runtime,
                request.clone(),
                source,
                "already_processing",
            );
        }
        if source.persists_pending() {
            persist_pending_audio_tail_trim_request(&runtime, &request);
        }
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_request_coalesced source={} reason=already_processing collection=\"{}\"",
            source.as_str(),
            collection_key.as_log_key()
        );
        return;
    }

    let queued = QueuedAudioTailTrim {
        request: request.clone(),
        source,
    };

    if !push_audio_tail_trim_queue(&runtime, queued) {
        log::warn!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_request_deferred source={} reason=queue_unavailable collection=\"{}\" pending_retained={}",
            source.as_str(),
            collection_key.as_log_key(),
            source.persists_pending()
        );
        if source.persists_pending() {
            persist_pending_audio_tail_trim_request(&runtime, &request);
        }
        return;
    }

    if source.persists_pending() {
        persist_pending_audio_tail_trim_request(&runtime, &request);
    }
    log::info!(
        target: AUDIO_TAIL_TRIM_LOG_TARGET,
        "audio_tail_trim_request_enqueued source={} collection=\"{}\"",
        source.as_str(),
        collection_key.as_log_key()
    );
    ensure_audio_tail_trim_worker(runtime);
}

#[cfg(not(test))]
fn coalesce_active_audio_tail_trim_request(
    runtime: &AudioTailTrimRuntime,
    request: AudioTailTrimRequest,
    source: AudioTailTrimSource,
    reason: &str,
) {
    let mut coalesced = match runtime.coalesced_active_requests.lock() {
        Ok(coalesced) => coalesced,
        Err(_) => {
            log::error!(
                target: AUDIO_TAIL_TRIM_LOG_TARGET,
                "audio_tail_trim_request_failed reason=coalesced_lock_poisoned collection=\"{}\"",
                request.collection_url
            );
            return;
        }
    };
    let key = AudioTailTrimCollectionKey::from_request(&request);
    let log_key = key.as_log_key();
    match coalesced.get_mut(&key) {
        Some(existing) => {
            existing.request = merge_audio_tail_trim_request(existing.request.clone(), request);
            existing.rerun_required = existing.rerun_required || source.requires_active_rerun();
            if source.priority() > existing.source.priority() {
                existing.source = source;
            }
        }
        None => {
            coalesced.insert(
                key,
                CoalescedAudioTailTrim {
                    request,
                    source,
                    rerun_required: source.requires_active_rerun(),
                },
            );
        }
    }
    log::info!(
        target: AUDIO_TAIL_TRIM_LOG_TARGET,
        "audio_tail_trim_active_request_saved source={} reason={} collection_count={}",
        source.as_str(),
        reason,
        coalesced.len()
    );
    log::debug!(
        target: AUDIO_TAIL_TRIM_LOG_TARGET,
        "audio_tail_trim_active_request_key collection=\"{}\"",
        log_key
    );
}

#[cfg(not(test))]
fn push_audio_tail_trim_queue(
    runtime: &Arc<AudioTailTrimRuntime>,
    queued: QueuedAudioTailTrim,
) -> bool {
    let mut queue = match runtime.queue.lock() {
        Ok(queue) => queue,
        Err(_) => {
            log::error!(
                target: AUDIO_TAIL_TRIM_LOG_TARGET,
                "audio_tail_trim_request_failed reason=queue_lock_poisoned"
            );
            return false;
        }
    };
    let queued_key = AudioTailTrimCollectionKey::from_request(&queued.request);
    if let Some(position) = queue.iter().position(|current| {
        AudioTailTrimCollectionKey::from_request(&current.request) == queued_key
    }) {
        let Some(mut existing) = queue.remove(position) else {
            return false;
        };
        let previous_source = existing.source;
        existing.request = merge_audio_tail_trim_request(existing.request, queued.request);
        if queued.source.priority() > previous_source.priority() {
            existing.source = queued.source;
        }
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_request_promoted source={} previous_source={} collection=\"{}\"",
            existing.source.as_str(),
            previous_source.as_str(),
            queued_key.as_log_key()
        );
        insert_audio_tail_trim_queue(&mut queue, existing);
        return true;
    }

    if queue.len() >= MAX_AUDIO_TAIL_TRIM_QUEUE_LEN {
        return false;
    }
    insert_audio_tail_trim_queue(&mut queue, queued);
    true
}

#[cfg(not(test))]
fn insert_audio_tail_trim_queue(
    queue: &mut VecDeque<QueuedAudioTailTrim>,
    queued: QueuedAudioTailTrim,
) {
    let index = audio_tail_trim_queue_insert_index(
        queue.iter().map(|current| current.source),
        queue.len(),
        queued.source,
    );
    queue.insert(index, queued);
}

fn audio_tail_trim_queue_insert_index(
    current_sources: impl IntoIterator<Item = AudioTailTrimSource>,
    current_len: usize,
    source: AudioTailTrimSource,
) -> usize {
    let priority = source.priority();
    if priority == AudioTailTrimSource::PendingStore.priority() {
        return current_len;
    }
    current_sources
        .into_iter()
        .position(|current| current.priority() <= priority)
        .unwrap_or(current_len)
}

#[cfg(test)]
pub(crate) fn request_downloaded_leaf_audio_tail_trim(_request: AudioTailTrimRequest) {}

#[cfg(test)]
pub(crate) fn request_downloaded_leaf_foreground_audio_tail_trim(_request: AudioTailTrimRequest) {}

#[cfg(test)]
pub(crate) fn audio_tail_trim_queue_insert_index_for_test(
    current_sources: &[&str],
    source: &str,
) -> usize {
    let sources = current_sources
        .iter()
        .map(|source| audio_tail_trim_source_for_test(source));
    audio_tail_trim_queue_insert_index(
        sources,
        current_sources.len(),
        audio_tail_trim_source_for_test(source),
    )
}

#[cfg(test)]
pub(crate) fn audio_tail_trim_source_requires_active_rerun_for_test(source: &str) -> bool {
    audio_tail_trim_source_for_test(source).requires_active_rerun()
}

#[cfg(test)]
pub(crate) fn audio_tail_trim_source_completes_foreground_playable_gate_for_test(
    source: &str,
) -> bool {
    audio_tail_trim_source_for_test(source).completes_foreground_playable_gate()
}

#[cfg(test)]
pub(crate) fn completed_audio_tail_trim_opens_foreground_playable_gate_for_test(
    source: &str,
    processed_ok: bool,
) -> bool {
    completed_audio_tail_trim_opens_foreground_playable_gate(
        audio_tail_trim_source_for_test(source),
        processed_ok,
    )
}

#[cfg(test)]
fn audio_tail_trim_source_for_test(source: &str) -> AudioTailTrimSource {
    match source {
        "pending_store" => AudioTailTrimSource::PendingStore,
        "downloaded_leaf" => AudioTailTrimSource::DownloadedLeaf,
        "downloaded_leaf_foreground" => AudioTailTrimSource::DownloadedLeafForeground,
        other => panic!("unknown audio tail trim source `{other}`"),
    }
}

#[cfg(not(test))]
fn ensure_audio_tail_trim_worker(runtime: Arc<AudioTailTrimRuntime>) {
    if runtime
        .worker_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    tauri::async_runtime::spawn(async move {
        run_audio_tail_trim_worker(runtime).await;
    });
}

#[cfg(not(test))]
async fn run_audio_tail_trim_worker(runtime: Arc<AudioTailTrimRuntime>) {
    loop {
        let Some(queued) = pop_audio_tail_trim_queue(&runtime) else {
            runtime.worker_running.store(false, Ordering::SeqCst);
            if queue_has_pending_audio_tail_trim(&runtime) {
                ensure_audio_tail_trim_worker(Arc::clone(&runtime));
            }
            return;
        };

        let collection_key = AudioTailTrimCollectionKey::from_request(&queued.request);
        let claim = match claim_audio_tail_trim_collection(Arc::clone(&runtime), &collection_key) {
            Ok(Some(claim)) => claim,
            Ok(None) => {
                coalesce_active_audio_tail_trim_request(
                    &runtime,
                    queued.request.clone(),
                    queued.source,
                    "already_processing",
                );
                continue;
            }
            Err(error) => {
                log::error!(
                    target: AUDIO_TAIL_TRIM_LOG_TARGET,
                    "audio_tail_trim_request_failed source={} reason=claim_failed collection=\"{}\" error=\"{}\"",
                    queued.source.as_str(),
                    collection_key.as_log_key(),
                    error
                );
                if queued.source.persists_pending() {
                    persist_pending_audio_tail_trim_request(&runtime, &queued.request);
                }
                continue;
            }
        };

        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_worker_processing source={} collection=\"{}\"",
            queued.source.as_str(),
            collection_key.as_log_key()
        );
        let processed_ok = match process_audio_tail_trim_request(
            Arc::clone(&runtime),
            &queued.request,
            queued.source,
        )
        .await
        {
            Ok(()) => true,
            Err(error) => {
                log::error!(
                    target: AUDIO_TAIL_TRIM_LOG_TARGET,
                    "audio_tail_trim_failed source={} collection=\"{}\" pending_retained=true error=\"{}\"",
                    queued.source.as_str(),
                    collection_key.as_log_key(),
                    error
                );
                false
            }
        };

        let completed_request = queued.request.clone();
        let completed_source = queued.source;
        drop(claim);
        drop(queued);
        let opens_foreground_playable_gate =
            completed_audio_tail_trim_opens_foreground_playable_gate(
                completed_source,
                processed_ok,
            );
        let requeued =
            requeue_coalesced_audio_tail_trim_if_present(Arc::clone(&runtime), &collection_key);
        if processed_ok && !requeued {
            remove_pending_audio_tail_trim_request(&runtime, &completed_request);
        }
        if opens_foreground_playable_gate {
            collection_import::notify_downloaded_leaf_foreground_playable_committed();
        }
        tokio::time::sleep(AUDIO_TAIL_TRIM_WORKER_COOLDOWN).await;
    }
}

#[cfg(not(test))]
fn requeue_coalesced_audio_tail_trim_if_present(
    runtime: Arc<AudioTailTrimRuntime>,
    collection_key: &AudioTailTrimCollectionKey,
) -> bool {
    let coalesced = match runtime.coalesced_active_requests.lock() {
        Ok(mut coalesced) => coalesced.remove(collection_key),
        Err(_) => {
            log::error!(
                target: AUDIO_TAIL_TRIM_LOG_TARGET,
                "audio_tail_trim_request_failed reason=coalesced_lock_poisoned collection=\"{}\"",
                collection_key.as_log_key()
            );
            return false;
        }
    };
    let Some(coalesced) = coalesced else {
        return false;
    };
    if !coalesced.rerun_required {
        remove_pending_audio_tail_trim_request(&runtime, &coalesced.request);
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_request_absorbed source={} reason=active_scan_consumed_focus collection=\"{}\"",
            coalesced.source.as_str(),
            collection_key.as_log_key()
        );
        return false;
    }
    log::info!(
        target: AUDIO_TAIL_TRIM_LOG_TARGET,
        "audio_tail_trim_request_requeued source={} reason=coalesced_active collection=\"{}\"",
        coalesced.source.as_str(),
        collection_key.as_log_key()
    );
    enqueue_audio_tail_trim(runtime, coalesced.request, coalesced.source);
    true
}

#[cfg(not(test))]
fn coalesced_audio_tail_trim_focus_snapshot(
    runtime: &AudioTailTrimRuntime,
    collection_key: &AudioTailTrimCollectionKey,
) -> Option<AudioTailTrimFocusMusic> {
    runtime
        .coalesced_active_requests
        .lock()
        .ok()
        .and_then(|coalesced| {
            coalesced
                .get(collection_key)
                .and_then(|coalesced| coalesced.request.focus_music.clone())
        })
}

#[cfg(not(test))]
fn consume_coalesced_audio_tail_trim_focus_if_matched(
    runtime: &AudioTailTrimRuntime,
    collection_key: &AudioTailTrimCollectionKey,
    candidate: &AudioTailTrimCandidate,
) {
    let mut coalesced = match runtime.coalesced_active_requests.lock() {
        Ok(coalesced) => coalesced,
        Err(_) => {
            log::error!(
                target: AUDIO_TAIL_TRIM_LOG_TARGET,
                "audio_tail_trim_request_failed reason=coalesced_lock_poisoned collection=\"{}\"",
                collection_key.as_log_key()
            );
            return;
        }
    };
    let Some(coalesced) = coalesced.get_mut(collection_key) else {
        return;
    };
    let Some(focus) = coalesced.request.focus_music.as_ref() else {
        return;
    };
    if !focus.matches_candidate(candidate) {
        return;
    }

    coalesced.request.focus_music = None;
    log::info!(
        target: AUDIO_TAIL_TRIM_LOG_TARGET,
        "audio_tail_trim_focus_absorbed source={} collection=\"{}\" path=\"{}\" rerun_required={}",
        coalesced.source.as_str(),
        collection_key.as_log_key(),
        candidate.path,
        coalesced.rerun_required
    );
}

#[cfg(not(test))]
fn pop_audio_tail_trim_queue(runtime: &AudioTailTrimRuntime) -> Option<QueuedAudioTailTrim> {
    runtime.queue.lock().ok()?.pop_front()
}

#[cfg(not(test))]
fn queue_has_pending_audio_tail_trim(runtime: &AudioTailTrimRuntime) -> bool {
    runtime
        .queue
        .lock()
        .ok()
        .is_some_and(|queue| !queue.is_empty())
}

#[cfg(not(test))]
fn audio_tail_trim_collection_is_processing(
    runtime: &AudioTailTrimRuntime,
    collection_key: &AudioTailTrimCollectionKey,
) -> bool {
    runtime
        .active_collections
        .lock()
        .ok()
        .is_some_and(|active| active.contains(collection_key))
}

#[cfg(not(test))]
fn claim_audio_tail_trim_collection(
    runtime: Arc<AudioTailTrimRuntime>,
    collection_key: &AudioTailTrimCollectionKey,
) -> Result<Option<AudioTailTrimCollectionClaim>> {
    {
        let mut active = runtime
            .active_collections
            .lock()
            .map_err(|_| anyhow!("audio tail trim active collection set is poisoned"))?;
        if !active.insert(collection_key.clone()) {
            return Ok(None);
        }
    }

    Ok(Some(AudioTailTrimCollectionClaim {
        runtime,
        collection_key: collection_key.clone(),
    }))
}

#[cfg(not(test))]
async fn process_audio_tail_trim_request(
    runtime: Arc<AudioTailTrimRuntime>,
    request: &AudioTailTrimRequest,
    source: AudioTailTrimSource,
) -> Result<()> {
    let collection_key = AudioTailTrimCollectionKey::from_request(request);
    let Some(collection) = playlists_repo::get_collection_by_url(&request.collection_url).await?
    else {
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_skipped source={} reason=collection_not_found collection=\"{}\"",
            source.as_str(),
            request.collection_url
        );
        return Err(anyhow!(
            "audio tail trim collection not found: {}",
            request.collection_url
        ));
    };

    let mut candidates = collect_audio_tail_trim_candidates(&collection, &request.save_root)
        .into_iter()
        .filter(|candidate| candidate.file_path.is_file())
        .collect::<Vec<_>>();
    let raw_candidate_count = candidates.len();
    let Some(scope) =
        select_audio_tail_trim_scope(&collection, candidates, request.scope_group_url.as_deref())
    else {
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_skipped source={} reason=ineligible_scope collection=\"{}\" scope_group=\"{}\" source_kind={} candidates={} musics={}",
            source.as_str(),
            collection.url,
            request.scope_group_url.as_deref().unwrap_or(""),
            request.source_kind.as_str(),
            raw_candidate_count,
            collection.musics.len()
        );
        return Ok(());
    };
    candidates = scope.candidates;
    let focus_matched =
        prioritize_audio_tail_trim_focus_candidate(&mut candidates, request.focus_music.as_ref());
    log::info!(
        target: AUDIO_TAIL_TRIM_LOG_TARGET,
        "audio_tail_trim_collection_loaded source={} collection=\"{}\" scope_kind={} scope=\"{}\" candidates={} raw_candidates={} skipped_collection_candidates={} musics={} focus={}",
        source.as_str(),
        collection.url,
        scope.kind.as_str(),
        scope.url,
        candidates.len(),
        raw_candidate_count,
        scope.skipped_collection_candidates,
        collection.musics.len(),
        focus_matched
    );
    if candidates.len() < MIN_TAIL_SAMPLE_COUNT {
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_skipped source={} reason=too_few_candidates collection=\"{}\" candidates={}",
            source.as_str(),
            collection.url,
            candidates.len()
        );
        return Ok(());
    }

    let ffmpeg_path = ensure_managed_binary(&runtime.app, ManagedBinary::Ffmpeg)
        .map_err(|error| anyhow!(error))?;
    log::info!(
        target: AUDIO_TAIL_TRIM_LOG_TARGET,
        "audio_tail_trim_fingerprint_scan_started collection=\"{}\" candidates={}",
        collection.url,
        candidates.len()
    );

    let mut all_candidates = Vec::new();
    let mut all_signatures = Vec::new();
    let mut applied_trim_keys = HashSet::new();
    let mut absorbed_focus = None::<AudioTailTrimFocusMusic>;
    while !candidates.is_empty() {
        let coalesced_focus = coalesced_audio_tail_trim_focus_snapshot(&runtime, &collection_key);
        let active_focus_snapshot = coalesced_focus
            .clone()
            .or_else(|| absorbed_focus.clone())
            .or_else(|| request.focus_music.clone());
        let Some(candidate) =
            take_next_audio_tail_trim_candidate(&mut candidates, active_focus_snapshot.as_ref())
        else {
            break;
        };
        if let Some(focus) = coalesced_focus.as_ref()
            && focus.matches_candidate(&candidate)
        {
            absorbed_focus = Some(focus.clone());
        }
        consume_coalesced_audio_tail_trim_focus_if_matched(&runtime, &collection_key, &candidate);
        let signature = match analyze_candidate_tail_signature(
            ffmpeg_path.clone(),
            candidate.clone(),
        )
        .await
        {
            Ok(signature) => signature,
            Err(error) => {
                log::warn!(
                    target: AUDIO_TAIL_TRIM_LOG_TARGET,
                    "audio_tail_trim_candidate_failed collection=\"{}\" title_path=\"{}\" error=\"{}\"",
                    collection.url,
                    candidate.path,
                    error
                );
                continue;
            }
        };

        all_candidates.push(candidate);
        all_signatures.push(signature);

        if all_signatures.len() < MIN_TAIL_SAMPLE_COUNT {
            continue;
        }

        let Some((resolved, focus_plan)) = build_audio_tail_trim_focus_plan(
            &all_candidates,
            &all_signatures,
            active_focus_snapshot.as_ref(),
        ) else {
            continue;
        };
        let focus_plan = filter_unapplied_audio_tail_trim_plan(focus_plan, &applied_trim_keys);
        if !focus_plan.is_empty() {
            log::info!(
                target: AUDIO_TAIL_TRIM_LOG_TARGET,
                "audio_tail_trim_focus_tail_detected collection=\"{}\" origin={} duration_ms={} support={} candidates={} density={:.3} trims={}",
                collection.url,
                resolved.origin.as_str(),
                resolved.evidence.duration_ms,
                resolved.evidence.support,
                resolved.evidence.candidate_count,
                resolved.evidence.density,
                focus_plan.len()
            );
            apply_audio_tail_trim_plan(
                request,
                source,
                &collection.url,
                &focus_plan,
                &resolved.evidence,
                "focus",
            )
            .await?;
            applied_trim_keys.extend(focus_plan.iter().map(audio_tail_trim_key));
        }
    }

    if all_signatures.len() < MIN_TAIL_SAMPLE_COUNT {
        return Err(anyhow!(
            "audio tail trim analyzed too few candidates: collection={} analyzed={} required={}",
            collection.url,
            all_signatures.len(),
            MIN_TAIL_SAMPLE_COUNT
        ));
    }

    let Some(resolved_evidence) = resolve_audio_tail_trim_evidence(&all_signatures) else {
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_skipped source={} reason=no_common_tail collection=\"{}\" analyzed_candidates={} candidates={}",
            source.as_str(),
            collection.url,
            all_signatures.len(),
            all_candidates.len()
        );
        return Ok(());
    };
    let evidence = resolved_evidence.evidence;

    log::info!(
        target: AUDIO_TAIL_TRIM_LOG_TARGET,
        "audio_tail_trim_common_tail_detected collection=\"{}\" origin={} duration_ms={} support={} candidates={} density={:.3} attached={} threshold={:.3}",
        collection.url,
        resolved_evidence.origin.as_str(),
        evidence.duration_ms,
        evidence.support,
        evidence.candidate_count,
        evidence.density,
        evidence.attached.len(),
        evidence.similarity_threshold
    );

    let plan = filter_unapplied_audio_tail_trim_plan(
        build_audio_tail_trim_plan(&all_candidates, &all_signatures, &evidence),
        &applied_trim_keys,
    );
    if plan.is_empty() {
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_skipped source={} reason=no_matching_tracks collection=\"{}\" duration_ms={}",
            source.as_str(),
            collection.url,
            evidence.duration_ms
        );
        return Ok(());
    }

    apply_audio_tail_trim_plan(request, source, &collection.url, &plan, &evidence, "full").await?;

    Ok(())
}

#[cfg(not(test))]
async fn apply_audio_tail_trim_plan(
    request: &AudioTailTrimRequest,
    source: AudioTailTrimSource,
    collection_url: &str,
    plan: &[MusicEndTrim],
    evidence: &CommonTailEvidence,
    stage: &str,
) -> Result<()> {
    let Some((updated, applied_plan)) =
        playlists_repo::trim_collection_music_ends_by_identity_with_applied_trims(
            collection_url,
            plan,
        )
        .await?
    else {
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_skipped source={} stage={} reason=collection_disappeared collection=\"{}\"",
            source.as_str(),
            stage,
            collection_url
        );
        return Ok(());
    };
    if applied_plan.is_empty() {
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_skipped source={} stage={} reason=already_applied collection=\"{}\" planned_trims={}",
            source.as_str(),
            stage,
            collection_url,
            plan.len()
        );
        return Ok(());
    }
    collection_import::notify_downloaded_leaf_collection_committed();
    notify_audio_style_training_for_trimmed_music(&updated, &request.save_root, &applied_plan);
    request_current_session_identity_updates_for_trimmed_music(&updated, &applied_plan);
    request_loudness_for_trimmed_music(&updated, &request.save_root, &applied_plan);
    log_applied_audio_tail_trim_tracks(&updated, &applied_plan);

    log::info!(
        target: AUDIO_TAIL_TRIM_LOG_TARGET,
        "audio_tail_trim_applied source={} stage={} collection=\"{}\" trims={} duration_ms={} support={} density={:.3}",
        source.as_str(),
        stage,
        updated.url,
        applied_plan.len(),
        evidence.duration_ms,
        evidence.support,
        evidence.density
    );

    Ok(())
}

#[cfg(not(test))]
fn notify_audio_style_training_for_trimmed_music(
    collection: &Collection,
    save_root: &Path,
    trims: &[MusicEndTrim],
) {
    let trim_keys = applied_tail_trim_keys(trims);
    let inputs = collection
        .musics
        .iter()
        .filter(|music| trim_keys.contains(&(music.url.clone(), music.start_ms, music.end_ms)))
        .filter_map(|music| {
            audio_style_training_input_from_trimmed_music(save_root, collection, music)
        })
        .collect::<Vec<_>>();
    playlist_playback_service::notify_music_training_inputs_ready(
        "audio_tail_trim_applied",
        inputs,
    );
}

fn audio_style_training_input_from_trimmed_music(
    save_root: &Path,
    collection: &Collection,
    music: &Music,
) -> Option<AudioStyleTrainingTrackInput> {
    if music.start_ms >= music.end_ms {
        return None;
    }
    let relative_path = music.path.as_deref()?.trim();
    if relative_path.is_empty() {
        return None;
    }
    Some(AudioStyleTrainingTrackInput {
        occurrence_id: music.occurrence_id.clone(),
        alias: music.alias.clone(),
        canonical_music_id: music.canonical_music_id.clone(),
        url: music.url.clone(),
        absolute_path: save_root
            .join(&collection.folder)
            .join(relative_path)
            .to_string_lossy()
            .to_string(),
        start_ms: music.start_ms,
        end_ms: music.end_ms,
        liked: music.liked,
        loudness_profile: music.loudness_profile,
    })
}

#[cfg(not(test))]
fn log_applied_audio_tail_trim_tracks(collection: &Collection, trims: &[MusicEndTrim]) {
    for trim in trims {
        let title = collection
            .musics
            .iter()
            .find(|music| {
                music.url == trim.url
                    && music.start_ms == trim.start_ms
                    && music.end_ms == trim.next_end_ms
            })
            .map(|music| music.alias.as_str())
            .unwrap_or("");
        log::info!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_track_applied collection=\"{}\" title=\"{}\" previous_end_ms={} next_end_ms={}",
            collection.url,
            title,
            trim.end_ms,
            trim.next_end_ms
        );
    }
}

#[cfg(not(test))]
fn request_current_session_identity_updates_for_trimmed_music(
    collection: &Collection,
    trims: &[MusicEndTrim],
) {
    for trim in trims {
        let music_name = collection
            .musics
            .iter()
            .find(|music| {
                music.url == trim.url
                    && music.start_ms == trim.start_ms
                    && music.end_ms == trim.next_end_ms
            })
            .map(|music| music.alias.clone())
            .unwrap_or_default();
        player_service::request_current_session_track_identity_update(
            PlaybackTrackIdentityUpdate {
                music_name,
                music_url: trim.url.clone(),
                start_ms: trim.start_ms,
                end_ms: trim.end_ms,
                next_start_ms: trim.start_ms,
                next_end_ms: trim.next_end_ms,
            },
        );
    }
}

#[cfg(not(test))]
async fn analyze_candidate_tail_signature(
    ffmpeg_path: PathBuf,
    candidate: AudioTailTrimCandidate,
) -> Result<TailEvidenceSignature> {
    let duration_ms = candidate.playable_duration_ms().min(TAIL_SEARCH_MS);
    let start_ms = candidate.end_ms.saturating_sub(duration_ms);
    wait_for_managed_binary_foreground_release(ManagedBinary::Ffmpeg);
    let _guard = acquire_managed_binary_usage(ManagedBinary::Ffmpeg, "audio_tail_trim");
    task::spawn_blocking(move || {
        let mut request = ffplayr::AudioTailFingerprintAnalysisRequest::new(candidate.file_path);
        request.time_range = Some(ffplayr::PlaybackTimeRange {
            start_ms,
            duration_ms: Some(duration_ms),
        });
        request.sample_rate = TAIL_FINGERPRINT_SAMPLE_RATE;
        request.max_search_ms = TAIL_SEARCH_MS;
        request.window_ms = TAIL_FINGERPRINT_WINDOW_MS;
        request.hop_ms = TAIL_FINGERPRINT_HOP_MS;
        request.spectral_bands = TAIL_FINGERPRINT_SPECTRAL_BANDS;
        request.silence_threshold_db = TAIL_FINGERPRINT_SILENCE_THRESHOLD_DB;
        request.silence_pad_ms = TAIL_FINGERPRINT_SILENCE_PAD_MS;
        let analysis = ffplayr::analyze_tail_fingerprint_with_binary(&ffmpeg_path, request)
            .map_err(anyhow::Error::msg)?;
        Ok(TailEvidenceSignature {
            search_start_ms: analysis.search_start_ms,
            effective_end_ms: analysis.effective_end_ms,
            window_ms: analysis.window_ms,
            hop_ms: analysis.hop_ms,
            frames: analysis
                .frames
                .into_iter()
                .map(|frame| TailEvidenceFrame {
                    source_start_ms: frame.source_start_ms,
                    source_end_ms: frame.source_end_ms,
                    rms_db: frame.rms_db,
                    bands: frame.bands,
                })
                .collect(),
        })
    })
    .await
    .context("audio tail trim fingerprint task failed")?
}

#[cfg(not(test))]
fn request_loudness_for_trimmed_music(
    collection: &Collection,
    save_root: &Path,
    trims: &[MusicEndTrim],
) {
    let trim_keys = applied_tail_trim_keys(trims);
    for music in &collection.musics {
        if !trim_keys.contains(&(music.url.clone(), music.start_ms, music.end_ms)) {
            continue;
        }
        let Some(relative_path) = music.path.as_deref() else {
            continue;
        };
        if music.start_ms >= music.end_ms || music.loudness_profile.is_some() {
            continue;
        }
        loudness_evidence::request_audio_tail_trim_loudness_evidence(LoudnessEvidenceRequest {
            canonical_music_id: music.canonical_music_id.clone(),
            url: music.url.clone(),
            file_path: save_root.join(&collection.folder).join(relative_path),
            start_ms: music.start_ms,
            end_ms: music.end_ms,
        });
    }
}

#[cfg(not(test))]
fn applied_tail_trim_keys(trims: &[MusicEndTrim]) -> HashSet<(String, u32, u32)> {
    trims
        .iter()
        .map(|trim| (trim.url.clone(), trim.start_ms, trim.next_end_ms))
        .collect()
}

#[cfg(not(test))]
fn persist_pending_audio_tail_trim_request(
    runtime: &AudioTailTrimRuntime,
    request: &AudioTailTrimRequest,
) {
    if runtime.pending_task_path.as_os_str().is_empty() {
        return;
    }

    let Ok(_guard) = runtime.pending_task_file_lock.lock() else {
        log::error!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_pending_write_failed error=\"pending_task_file_lock_poisoned\""
        );
        return;
    };
    if let Err(error) =
        upsert_audio_tail_trim_pending_task_file(&runtime.pending_task_path, request)
    {
        log::error!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_pending_write_failed error=\"{}\"",
            error
        );
    }
}

#[cfg(not(test))]
fn remove_pending_audio_tail_trim_request(
    runtime: &AudioTailTrimRuntime,
    request: &AudioTailTrimRequest,
) {
    if runtime.pending_task_path.as_os_str().is_empty() {
        return;
    }

    let Ok(_guard) = runtime.pending_task_file_lock.lock() else {
        log::error!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_pending_remove_failed error=\"pending_task_file_lock_poisoned\""
        );
        return;
    };
    if let Err(error) =
        remove_audio_tail_trim_pending_task_from_file(&runtime.pending_task_path, request)
    {
        log::error!(
            target: AUDIO_TAIL_TRIM_LOG_TARGET,
            "audio_tail_trim_pending_remove_failed error=\"{}\"",
            error
        );
    }
}

fn read_audio_tail_trim_pending_task_file(path: &Path) -> Result<Vec<AudioTailTrimRequest>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(anyhow!(
                "failed to read audio tail trim pending task file `{}`: {error}",
                path.display()
            ));
        }
    };
    let file: AudioTailTrimPendingTaskFile = serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "failed to parse audio tail trim pending task file `{}`",
            path.display()
        )
    })?;
    if file.version != AUDIO_TAIL_TRIM_PENDING_TASK_FILE_VERSION {
        return Err(anyhow!(
            "unsupported audio tail trim pending task file version `{}` in `{}`",
            file.version,
            path.display()
        ));
    }

    Ok(deduplicate_audio_tail_trim_requests(file.requests))
}

fn upsert_audio_tail_trim_pending_task_file(
    path: &Path,
    request: &AudioTailTrimRequest,
) -> Result<()> {
    let mut requests = read_audio_tail_trim_pending_task_file(path)?;
    let request_key = AudioTailTrimCollectionKey::from_request(request);
    requests.retain(|existing| AudioTailTrimCollectionKey::from_request(existing) != request_key);
    requests.push(request.clone());
    write_audio_tail_trim_pending_task_file(path, &requests)
}

fn remove_audio_tail_trim_pending_task_from_file(
    path: &Path,
    request: &AudioTailTrimRequest,
) -> Result<()> {
    let mut requests = read_audio_tail_trim_pending_task_file(path)?;
    let request_key = AudioTailTrimCollectionKey::from_request(request);
    requests.retain(|existing| AudioTailTrimCollectionKey::from_request(existing) != request_key);
    write_audio_tail_trim_pending_task_file(path, &requests)
}

fn write_audio_tail_trim_pending_task_file(
    path: &Path,
    requests: &[AudioTailTrimRequest],
) -> Result<()> {
    if requests.is_empty() {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(anyhow!(
                    "failed to remove empty audio tail trim pending task file `{}`: {error}",
                    path.display()
                ));
            }
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create audio tail trim pending task dir `{}`",
                parent.display()
            )
        })?;
    }
    let file = AudioTailTrimPendingTaskFile {
        version: AUDIO_TAIL_TRIM_PENDING_TASK_FILE_VERSION.to_string(),
        requests: requests.to_vec(),
    };
    fs::write(path, serde_json::to_vec_pretty(&file)?).with_context(|| {
        format!(
            "failed to write audio tail trim pending task file `{}`",
            path.display()
        )
    })
}

fn deduplicate_audio_tail_trim_requests(
    requests: Vec<AudioTailTrimRequest>,
) -> Vec<AudioTailTrimRequest> {
    let mut deduplicated = Vec::<AudioTailTrimRequest>::new();
    for request in requests {
        let request_key = AudioTailTrimCollectionKey::from_request(&request);
        deduplicated
            .retain(|existing| AudioTailTrimCollectionKey::from_request(existing) != request_key);
        deduplicated.push(request);
    }
    deduplicated
}

fn normalized_optional_url(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg_attr(test, allow(dead_code))]
fn normalize_path_text(path: &str) -> String {
    path.replace('\\', "/")
}

#[cfg(test)]
pub(crate) fn read_audio_tail_trim_pending_task_file_for_test(
    path: &Path,
) -> Result<Vec<AudioTailTrimRequest>> {
    read_audio_tail_trim_pending_task_file(path)
}

#[cfg(test)]
pub(crate) fn upsert_audio_tail_trim_pending_task_file_for_test(
    path: &Path,
    request: &AudioTailTrimRequest,
) -> Result<()> {
    upsert_audio_tail_trim_pending_task_file(path, request)
}

#[cfg(test)]
pub(crate) fn remove_audio_tail_trim_pending_task_from_file_for_test(
    path: &Path,
    request: &AudioTailTrimRequest,
) -> Result<()> {
    remove_audio_tail_trim_pending_task_from_file(path, request)
}

#[cfg(test)]
#[path = "audio_tail_trim.test.rs"]
mod tests;
