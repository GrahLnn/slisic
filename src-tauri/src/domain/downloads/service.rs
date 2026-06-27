#[cfg(not(test))]
use super::model::DownloadLeafGroupContext;
use super::model::{
    CollectionSourceKind, DownloadLeaf, DownloadLeafStatus, DownloadRootTitleEvidence,
    DownloadTask, DownloadTaskStatus, DownloadTrigger, EnqueuedCollectionDownload,
    PastedDownloadUrlResolution,
};
use super::naming::{sanitize_path_component, short_hash};
#[cfg(not(test))]
use super::planning::RootShellProbeTraceEvent;
use super::planning::resolve_existing_collection_for_download_identity;
use super::planning::{RootShellProbeTraceSink, probe_root_shell_with_limit};
use super::planning::{normalize_url, parse_download_url, task_id_for};
#[cfg(not(test))]
use super::planning::{resolve_collection_plan, resolve_collection_plan_with_root_probe};
use super::repo;
#[cfg(not(test))]
use super::yt_dlp::CliYtDlpClient;
#[cfg(not(test))]
use super::yt_dlp::probe_downloaded_audio_duration_ms;
use super::yt_dlp::{
    DownloadProgress, LeafProbe, RootProbe, YtDlpClient, audio_duration_boundary_matches,
    classify_root_preference,
};
#[cfg(not(test))]
use crate::domain::audio_tail_trim::{self, AudioTailTrimRequest};
use crate::domain::collection_import;
use crate::domain::collection_import::PlannedLeaf;
use crate::domain::collection_import::{CollectionShellPlan, CollectionSyncPlan};
#[cfg(not(test))]
use crate::domain::loudness_evidence::{self, LoudnessEvidenceRequest};
#[cfg(not(test))]
use crate::domain::meta::service as meta_service;
#[cfg(not(test))]
use crate::domain::player::event::{PlaybackDiagnosticTraceDetail, PlaybackDiagnosticTraceEvent};
use crate::domain::playlists::model::{Collection, Group};
#[cfg(not(test))]
use crate::utils::binaries::acquire_managed_binary_usage;
#[cfg(not(test))]
use crate::utils::binaries::{ManagedBinary, ensure_managed_binary};
use anyhow::{Context, Result, anyhow, bail};
use appdb::Id;
#[cfg(not(test))]
use serde::{Deserialize, Serialize};
#[cfg(not(test))]
use specta::Type;
#[cfg(not(test))]
use std::collections::VecDeque;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(not(test))]
use std::thread;
use std::time::{Duration, Instant};
#[cfg(not(test))]
use tauri::AppHandle;
#[cfg(not(test))]
use tauri::Manager;
#[cfg(not(test))]
use tauri_specta::Event;
#[cfg(not(test))]
use tokio::sync::broadcast;
use tokio::task;
#[cfg(not(test))]
use tokio::task::JoinSet;

#[cfg(not(test))]
const AUTO_UPDATE_INTERVAL: Duration = Duration::from_secs(60 * 60 * 24);
const MIN_PARALLEL_LEAF_DOWNLOADS: usize = 1;
const INITIAL_PARALLEL_LEAF_DOWNLOADS: usize = 4;
const MAX_PARALLEL_LEAF_DOWNLOADS: usize = 8;
const LEAF_PREPARE_CPU_BUDGET_NUMERATOR: usize = 2;
const LEAF_PREPARE_CPU_BUDGET_DENOMINATOR: usize = 3;
const MAX_PARALLEL_LEAF_FINALIZATIONS: usize = 4;
#[cfg(not(test))]
const MAX_PARALLEL_EXISTING_FILE_DURATION_PROBES: usize = 4;
const MAX_LEAF_DOWNLOAD_ATTEMPTS: usize = 3;
const LEAF_DOWNLOAD_RETRY_BASE_DELAY_SECS: u64 = 2;
const LEAF_DOWNLOAD_RETRY_MAX_JITTER_MILLIS: u64 = 750;
const PREPARE_TASK_ENQUEUE_RETRY_ATTEMPTS: usize = 6;
#[cfg(not(test))]
static DOWNLOAD_RUNTIME: OnceLock<DownloadRuntime> = OnceLock::new();
#[cfg(not(test))]
static DOWNLOAD_TASK_CHANGES: OnceLock<broadcast::Sender<DownloadTaskChangeSignal>> =
    OnceLock::new();
static PENDING_ENQUEUE_URLS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[cfg(not(test))]
pub struct DownloadRuntime {
    app: AppHandle,
    active_task_ids: Mutex<HashSet<String>>,
}

#[derive(Debug, Clone)]
pub(crate) enum PreparedTaskEnqueue {
    Existing(DownloadTask),
    New(DownloadTask),
}

#[derive(Debug, Default, Clone)]
pub(crate) struct GroupCatalog {
    groups: HashMap<String, Group>,
    ambiguous: HashSet<String>,
}

#[derive(Clone)]
struct DownloadExecutionDeps {
    client: Arc<dyn YtDlpClient>,
    #[cfg(not(test))]
    ffmpeg_path: PathBuf,
    save_root: PathBuf,
    cookies_path: Option<PathBuf>,
}

#[cfg(not(test))]
struct LeafDownloadInput {
    leaf: DownloadLeaf,
    probe: LeafProbe,
    music_probe: LeafProbe,
    group: Option<Group>,
    url: String,
    target_dir: PathBuf,
    temp_file_stem: String,
    cookies_path: Option<PathBuf>,
    readiness: LeafReadinessCargo,
}

#[cfg(not(test))]
struct LeafPreparationInput {
    work_item: LeafWorkItem,
}

#[cfg(not(test))]
struct ExistingLeafFinalizationInput {
    collection: Collection,
    source_kind: CollectionSourceKind,
    save_root: PathBuf,
    ffmpeg_path: PathBuf,
    completions: Vec<ExistingLeafBatchCompletion>,
}

#[derive(Debug, Clone)]
pub(crate) struct LeafWorkItem {
    pub(crate) leaf: DownloadLeaf,
    pub(crate) planned: Option<PlannedLeaf>,
    pub(crate) readiness: LeafReadinessCargo,
}

#[cfg(not(test))]
impl LeafWorkItem {
    fn url(&self) -> &str {
        self.planned
            .as_ref()
            .map(|planned| planned.url.as_str())
            .unwrap_or(self.leaf.url.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LeafReadinessCargo {
    Background,
    Foreground,
}

impl LeafReadinessCargo {
    fn priority(self) -> u8 {
        match self {
            Self::Background => 0,
            Self::Foreground => 1,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Background => "background",
            Self::Foreground => "foreground",
        }
    }
}

#[cfg(not(test))]
#[derive(Debug)]
struct PreparedLeafDownload {
    leaf: DownloadLeaf,
    probe: LeafProbe,
    music_probe: LeafProbe,
    group: Option<Group>,
    url: String,
    readiness: LeafReadinessCargo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResidualTempFileResolution {
    Missing,
    Ready(PathBuf),
    Ambiguous(Vec<PathBuf>),
}

#[cfg(not(test))]
#[derive(Debug)]
struct FailedLeafPreparation {
    leaf: DownloadLeaf,
    error: String,
}

#[derive(Debug)]
pub(crate) struct CompletedLeafDownload {
    pub(crate) leaf: DownloadLeaf,
    pub(crate) probe: LeafProbe,
    pub(crate) music_probe: LeafProbe,
    pub(crate) group: Option<Group>,
    pub(crate) downloaded: super::yt_dlp::DownloadedLeaf,
    pub(crate) progress: DownloadProgress,
    pub(crate) retry_failures: usize,
    pub(crate) readiness: LeafReadinessCargo,
}

#[derive(Debug)]
pub(crate) struct FailedLeafDownload {
    pub(crate) leaf: DownloadLeaf,
    pub(crate) error: String,
}

type LeafDownloadOutcome = std::result::Result<CompletedLeafDownload, FailedLeafDownload>;

#[cfg(not(test))]
#[derive(Debug)]
enum LeafFinalization {
    Downloaded(LeafDownloadOutcome),
    ExistingFile(ExistingLeafCompletion),
}

#[cfg(not(test))]
#[derive(Debug)]
struct ExistingLeafCompletion {
    leaf: DownloadLeaf,
    music_probe: LeafProbe,
    group: Group,
    relative_path: String,
    absolute_path: PathBuf,
    readiness: LeafReadinessCargo,
}

#[cfg(not(test))]
#[derive(Debug)]
struct ExistingLeafFinalizationFailure {
    completions: Vec<ExistingLeafBatchCompletion>,
    probe_failures: Vec<ExistingLeafProbeFailure>,
    error: String,
}

#[cfg(not(test))]
type ExistingLeafFinalizationOutcome =
    std::result::Result<ExistingLeafFinalizationResult, ExistingLeafFinalizationFailure>;

#[cfg(not(test))]
#[derive(Debug)]
struct ExistingLeafFinalizationResult {
    persist_changed: bool,
    completed: Vec<ExistingLeafBatchCompletion>,
    failed: Vec<ExistingLeafProbeFailure>,
}

#[cfg(not(test))]
#[derive(Debug)]
struct ExistingLeafDurationProbeOutcome {
    completed: Vec<ExistingLeafBatchCompletion>,
    failed: Vec<ExistingLeafProbeFailure>,
}

#[cfg(not(test))]
#[derive(Debug)]
struct ExistingLeafProbeFailure {
    completion: ExistingLeafBatchCompletion,
    error: String,
}

#[derive(Debug)]
pub(crate) struct ExistingLeafBatchCompletion {
    pub(crate) leaf: DownloadLeaf,
    pub(crate) music_probe: LeafProbe,
    pub(crate) group: Group,
    pub(crate) relative_path: String,
    pub(crate) absolute_path: PathBuf,
    pub(crate) readiness: LeafReadinessCargo,
}

#[cfg(not(test))]
impl From<ExistingLeafCompletion> for ExistingLeafBatchCompletion {
    fn from(completion: ExistingLeafCompletion) -> Self {
        Self {
            leaf: completion.leaf,
            music_probe: completion.music_probe,
            group: completion.group,
            relative_path: completion.relative_path,
            absolute_path: completion.absolute_path,
            readiness: completion.readiness,
        }
    }
}

#[cfg(not(test))]
#[derive(Debug, Clone)]
struct CommittedLeafPostProcessing {
    relative_path: String,
    readiness: LeafReadinessCargo,
}

#[cfg(not(test))]
#[derive(Debug, Default)]
struct LeafCommitResult {
    collection_changed: bool,
    committed_paths: Vec<CommittedLeafPostProcessing>,
}

pub(crate) fn leaf_pipeline_has_work(
    active_prepares: usize,
    active_downloads: usize,
    active_finalizations: usize,
    pending_prepares: usize,
    ready_downloads: usize,
    ready_finalizations: usize,
) -> bool {
    active_prepares > 0
        || active_downloads > 0
        || active_finalizations > 0
        || pending_prepares > 0
        || ready_downloads > 0
        || ready_finalizations > 0
}

pub(crate) fn leaf_prepare_parallelism(
    leaf_count: usize,
    download_window: &LeafDownloadWindow,
) -> usize {
    let _ = download_window;
    leaf_prepare_parallelism_for_cpu(leaf_count, resolve_leaf_prepare_cpu_parallelism())
}

pub(crate) fn leaf_prepare_parallelism_for_cpu(leaf_count: usize, cpu_parallelism: usize) -> usize {
    if leaf_count == 0 {
        return 0;
    }

    leaf_count.min(leaf_prepare_cpu_budget(cpu_parallelism))
}

pub(crate) fn leaf_prepare_cpu_budget(cpu_parallelism: usize) -> usize {
    cpu_parallelism
        .saturating_mul(LEAF_PREPARE_CPU_BUDGET_NUMERATOR)
        .checked_div(LEAF_PREPARE_CPU_BUDGET_DENOMINATOR)
        .unwrap_or(0)
        .max(1)
}

#[cfg(not(test))]
fn resolve_leaf_prepare_cpu_parallelism() -> usize {
    thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
}

#[cfg(test)]
fn resolve_leaf_prepare_cpu_parallelism() -> usize {
    1
}

pub(crate) fn leaf_finalization_parallelism(leaf_count: usize) -> usize {
    leaf_count.min(MAX_PARALLEL_LEAF_FINALIZATIONS).max(1)
}

pub(crate) fn existing_file_finalization_batch_limit(
    ready_existing_files: usize,
    available_finalization_slots: usize,
) -> usize {
    if ready_existing_files == 0 || available_finalization_slots == 0 {
        return 0;
    }

    ready_existing_files.div_ceil(available_finalization_slots)
}

pub(crate) fn existing_file_finalization_batch_take_limit(
    first_readiness: LeafReadinessCargo,
    following_readiness: impl IntoIterator<Item = LeafReadinessCargo>,
    fair_share_limit: usize,
) -> usize {
    let fair_share_limit = fair_share_limit.max(1);
    let mut take_limit = 1;
    for readiness in following_readiness {
        if readiness != first_readiness {
            break;
        }
        if first_readiness == LeafReadinessCargo::Background
            && readiness.priority() > first_readiness.priority()
        {
            break;
        }
        if take_limit >= fair_share_limit && first_readiness == LeafReadinessCargo::Background {
            break;
        }
        take_limit += 1;
    }
    take_limit
}

#[cfg(test)]
pub(crate) fn leaf_pipeline_next_stage(
    active_prepares: usize,
    active_downloads: usize,
    active_finalizations: usize,
    pending_prepares: usize,
    ready_downloads: usize,
    ready_finalizations: usize,
    prepare_limit: usize,
    download_limit: usize,
    finalization_limit: usize,
) -> LeafPipelineStage {
    if ready_downloads > 0 && active_downloads < download_limit {
        return LeafPipelineStage::Download;
    }

    if ready_finalizations > 0 && active_finalizations < finalization_limit {
        return LeafPipelineStage::Finalize;
    }

    if pending_prepares > 0 && active_prepares < prepare_limit {
        return LeafPipelineStage::Prepare;
    }

    if active_prepares > 0 || active_downloads > 0 || active_finalizations > 0 {
        return LeafPipelineStage::WaitForWorker;
    }

    LeafPipelineStage::Idle
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LeafPipelineStage {
    Finalize,
    Download,
    Prepare,
    WaitForWorker,
    Idle,
}

#[cfg(not(test))]
#[derive(Debug, Default)]
struct LeafPipelineState {
    workers: JoinSet<LeafPipelineEvent>,
    pending_prepares: VecDeque<LeafWorkItem>,
    ready_downloads: VecDeque<PreparedLeafDownload>,
    ready_finalizations: VecDeque<LeafFinalization>,
    active_prepares: usize,
    active_downloads: usize,
    active_finalizations: usize,
    prepare_parallelism: usize,
    finalization_parallelism: usize,
    download_window: LeafDownloadWindow,
}

#[cfg(not(test))]
impl LeafPipelineState {
    fn new(leaves: Vec<LeafWorkItem>, download_window: LeafDownloadWindow) -> Self {
        let prepare_parallelism = leaf_prepare_parallelism(leaves.len(), &download_window);
        let finalization_parallelism = leaf_finalization_parallelism(leaves.len());
        let mut pending_prepares = VecDeque::new();
        for leaf in leaves {
            push_leaf_work_item(&mut pending_prepares, leaf);
        }
        Self {
            workers: JoinSet::new(),
            pending_prepares,
            ready_downloads: VecDeque::new(),
            ready_finalizations: VecDeque::new(),
            active_prepares: 0,
            active_downloads: 0,
            active_finalizations: 0,
            prepare_parallelism,
            finalization_parallelism,
            download_window,
        }
    }

    fn has_work(&self) -> bool {
        leaf_pipeline_has_work(
            self.active_prepares,
            self.active_downloads,
            self.active_finalizations,
            self.pending_prepares.len(),
            self.ready_downloads.len(),
            self.ready_finalizations.len(),
        )
    }
}

#[cfg(not(test))]
fn merge_leaf_commit_result(target: &mut LeafCommitResult, next: LeafCommitResult) {
    target.collection_changed |= next.collection_changed;
    target.committed_paths.extend(next.committed_paths);
}

#[cfg(not(test))]
fn push_leaf_work_item(queue: &mut VecDeque<LeafWorkItem>, work_item: LeafWorkItem) {
    let index = leaf_work_item_insert_index(
        queue.iter().map(|current| current.readiness),
        queue.len(),
        work_item.readiness,
    );
    queue.insert(index, work_item);
}

#[cfg(not(test))]
fn push_leaf_finalization(queue: &mut VecDeque<LeafFinalization>, finalization: LeafFinalization) {
    let readiness = match &finalization {
        LeafFinalization::Downloaded(Ok(completed)) => completed.readiness,
        LeafFinalization::ExistingFile(completion) => completion.readiness,
        LeafFinalization::Downloaded(Err(_)) => LeafReadinessCargo::Background,
    };
    let index = leaf_finalization_insert_index(
        queue.iter().map(|current| match current {
            LeafFinalization::Downloaded(Ok(completed)) => completed.readiness,
            LeafFinalization::ExistingFile(completion) => completion.readiness,
            LeafFinalization::Downloaded(Err(_)) => LeafReadinessCargo::Background,
        }),
        queue.len(),
        readiness,
    );
    queue.insert(index, finalization);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LeafDownloadWindow {
    min_limit: usize,
    current_limit: usize,
    max_limit: usize,
    sustained_successes: usize,
}

impl Default for LeafDownloadWindow {
    fn default() -> Self {
        Self::fixed(0)
    }
}

impl LeafDownloadWindow {
    pub(crate) fn for_collection(source_kind: CollectionSourceKind, leaf_count: usize) -> Self {
        if leaf_count == 0 {
            return Self::fixed(0);
        }

        if source_kind == CollectionSourceKind::Single {
            return Self::fixed(1);
        }

        let max_limit = leaf_count.min(MAX_PARALLEL_LEAF_DOWNLOADS);
        let current_limit = leaf_count
            .min(INITIAL_PARALLEL_LEAF_DOWNLOADS)
            .clamp(MIN_PARALLEL_LEAF_DOWNLOADS, max_limit);

        Self {
            min_limit: MIN_PARALLEL_LEAF_DOWNLOADS,
            current_limit,
            max_limit,
            sustained_successes: 0,
        }
    }

    fn fixed(limit: usize) -> Self {
        Self {
            min_limit: limit,
            current_limit: limit,
            max_limit: limit,
            sustained_successes: 0,
        }
    }

    pub(crate) fn current_limit(&self) -> usize {
        self.current_limit
    }

    pub(crate) fn max_limit(&self) -> usize {
        self.max_limit
    }

    pub(crate) fn record_success(&mut self) {
        if self.current_limit >= self.max_limit {
            self.sustained_successes = 0;
            return;
        }

        self.sustained_successes += 1;
        if self.sustained_successes < self.current_limit {
            return;
        }

        self.current_limit += 1;
        self.sustained_successes = 0;
    }

    pub(crate) fn record_failure(&mut self) {
        if self.current_limit <= self.min_limit {
            self.sustained_successes = 0;
            return;
        }

        self.current_limit = (self.current_limit / 2).max(self.min_limit);
        self.sustained_successes = 0;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LeafDownloadRetryPolicy {
    max_attempts: usize,
    base_delay: Duration,
}

impl Default for LeafDownloadRetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: MAX_LEAF_DOWNLOAD_ATTEMPTS,
            base_delay: Duration::from_secs(LEAF_DOWNLOAD_RETRY_BASE_DELAY_SECS),
        }
    }
}

impl LeafDownloadRetryPolicy {
    pub(crate) fn cooldown_after_failure(
        &self,
        failed_attempt: usize,
        retry_key: &str,
        error: &anyhow::Error,
    ) -> Option<Duration> {
        if failed_attempt == 0
            || failed_attempt >= self.max_attempts
            || !is_retryable_leaf_download_error(error)
        {
            return None;
        }

        let multiplier = 1_u32
            .checked_shl((failed_attempt - 1) as u32)
            .unwrap_or(u32::MAX);
        self.base_delay
            .checked_mul(multiplier)?
            .checked_add(retry_cooldown_jitter(retry_key, failed_attempt))
    }
}

fn retry_cooldown_jitter(retry_key: &str, failed_attempt: usize) -> Duration {
    let hash = short_hash(&format!("{retry_key}|{failed_attempt}"));
    let jitter_millis =
        u64::from_str_radix(&hash, 16).unwrap_or(0) % (LEAF_DOWNLOAD_RETRY_MAX_JITTER_MILLIS + 1);
    Duration::from_millis(jitter_millis)
}

pub(crate) fn is_retryable_leaf_download_error(error: &anyhow::Error) -> bool {
    let message = format!("{error:#}");
    if is_non_retryable_leaf_access_error_message(&message) {
        return false;
    }
    if is_youtube_cookie_challenge_error_message(&message) {
        return false;
    }

    ![
        "failed to create ",
        "failed to spawn yt-dlp download process",
        "yt-dlp stdout pipe was not captured",
        "yt-dlp stderr pipe was not captured",
        "yt-dlp completed but final audio path could not be resolved",
    ]
    .iter()
    .any(|fatal| message.contains(fatal))
}

pub(crate) fn is_non_retryable_leaf_access_error_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "private video",
        "this video is private",
        "members-only content",
        "video unavailable",
    ]
    .iter()
    .any(|fatal| message.contains(fatal))
}

pub(crate) fn is_youtube_cookie_challenge_error_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    if is_non_retryable_leaf_access_error_message(&message) {
        return false;
    }

    message.contains("use --cookies-from-browser")
        || message.contains("use --cookies ")
        || message.contains("use --cookies for the authentication")
        || message.contains("sign in to confirm")
}

pub(crate) fn normalize_youtube_cookies_text(cookies: &str) -> Result<String> {
    let normalized = cookies.trim().replace("\r\n", "\n").replace('\r', "\n");
    if normalized.is_empty() {
        bail!("YouTube cookies are empty");
    }
    if !normalized
        .lines()
        .any(|line| line.contains("youtube.com") || line.contains(".youtube.com"))
    {
        bail!("YouTube cookies must include youtube.com cookie rows");
    }
    Ok(format!("{normalized}\n"))
}

#[cfg(not(test))]
type LeafPreparationOutcome = std::result::Result<PreparedLeafDownload, FailedLeafPreparation>;

#[cfg(not(test))]
enum LeafPipelineEvent {
    Prepared(LeafPreparationOutcome),
    Downloaded(LeafDownloadOutcome),
    FinalizedExistingFile(ExistingLeafFinalizationOutcome),
}

#[cfg(not(test))]
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub(crate) struct DownloadTaskChangeSignal {
    pub(crate) task_id: String,
    pub(crate) task_url: String,
    pub(crate) collection_url: Option<String>,
    pub(crate) collection_name: Option<String>,
    pub(crate) status: DownloadTaskStatus,
    pub(crate) last_error: Option<String>,
    pub(crate) credential_request: Option<DownloadCredentialRequestSignal>,
}

#[cfg(not(test))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub(crate) struct DownloadCredentialRequestSignal {
    pub(crate) provider: String,
    pub(crate) reason: String,
}

#[cfg(not(test))]
pub fn initialize_runtime(app: AppHandle) {
    let runtime = DOWNLOAD_RUNTIME.get_or_init(|| DownloadRuntime {
        app: app.clone(),
        active_task_ids: Mutex::new(HashSet::new()),
    });

    spawn_recovery(runtime.app.clone());
    spawn_auto_update_loop(runtime.app.clone());
}

#[cfg(not(test))]
pub(crate) fn subscribe_download_task_changes() -> broadcast::Receiver<DownloadTaskChangeSignal> {
    download_task_change_sender().subscribe()
}

#[cfg(not(test))]
pub async fn enqueue_collection_download(url: String) -> Result<EnqueuedCollectionDownload> {
    enqueue_collection_download_with_trigger(url, DownloadTrigger::Manual).await
}

pub async fn resume_download_task(task_id: String) -> Result<DownloadTask> {
    let mut task = repo::get_task(&task_id).await?;
    if task.status == DownloadTaskStatus::Completed {
        bail!("completed download tasks cannot be resumed");
    }
    if task.status == DownloadTaskStatus::AwaitingCredentials {
        task.status = DownloadTaskStatus::Queued;
        task.last_error = None;
        for leaf in &mut task.leafs {
            if leaf.status == DownloadLeafStatus::AwaitingCredentials {
                leaf.status = DownloadLeafStatus::Queued;
                leaf.last_error = None;
                leaf.touch();
            }
        }
        task = repo::save_task(task).await?;
        publish_download_task_change(&task);
    }
    spawn_task(task.id.to_string(), None)?;
    Ok(task)
}

pub async fn submit_youtube_cookies_and_resume_download_task(
    task_id: String,
    cookies: String,
    path: PathBuf,
) -> Result<DownloadTask> {
    let normalized = normalize_youtube_cookies_text(&cookies)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    std::fs::write(&path, normalized)
        .with_context(|| format!("failed to write YouTube cookies to {}", path.display()))?;
    resume_download_task(task_id).await
}

pub async fn get_download_task(task_id: String) -> Result<DownloadTask> {
    repo::get_task(&task_id).await
}

pub async fn list_download_tasks() -> Result<Vec<DownloadTask>> {
    repo::list_tasks().await
}

pub async fn resolve_pasted_download_url(url: String) -> Result<PastedDownloadUrlResolution> {
    let parsed_url = match parse_download_url(&url) {
        Ok(parsed_url) => parsed_url,
        Err(error) => return Ok(PastedDownloadUrlResolution::invalid_url(error)),
    };
    let normalized_url = normalize_url(&parsed_url)?;

    collection_import::resolve_pasted_download_url(normalized_url).await
}

pub async fn probe_download_root_title(url: String) -> Result<DownloadRootTitleEvidence> {
    let parsed_url = parse_download_url(&url).map_err(anyhow::Error::msg)?;
    let normalized_url = normalize_url(&parsed_url)?;
    let trace = download_root_shell_probe_trace_sink(normalized_url.clone());
    probe_download_root_title_with_client(normalized_url, resolve_title_probe_client()?, trace)
        .await
}

#[cfg(not(test))]
fn download_root_shell_probe_trace_sink(url: String) -> Option<RootShellProbeTraceSink> {
    let app = runtime().ok()?.app.clone();

    Some(Arc::new(move |event| {
        let (event_name, elapsed_ms, status, error) = match event {
            RootShellProbeTraceEvent::WaitStart => (
                "download-root-shell-probe-wait-start",
                None,
                Some("waiting"),
                None,
            ),
            RootShellProbeTraceEvent::SlotAcquired { elapsed_ms } => (
                "download-root-shell-probe-slot-acquired",
                Some(elapsed_ms),
                Some("probing"),
                None,
            ),
            RootShellProbeTraceEvent::Done { elapsed_ms } => (
                "download-root-shell-probe-done",
                Some(elapsed_ms),
                Some("done"),
                None,
            ),
            RootShellProbeTraceEvent::Error { elapsed_ms, error } => (
                "download-root-shell-probe-error",
                Some(elapsed_ms),
                Some("error"),
                Some(error),
            ),
        };

        if let Err(error) = (PlaybackDiagnosticTraceEvent {
            event: event_name.to_string(),
            playlist_name: None,
            music_name: None,
            music_url: None,
            start_ms: None,
            end_ms: None,
            elapsed_ms,
            candidate_count: None,
            queue_count: None,
            status: status.map(str::to_string),
            error,
            details: Some(vec![PlaybackDiagnosticTraceDetail {
                key: "url".to_string(),
                value: url.clone(),
            }]),
        })
        .emit(&app)
        {
            log::error!(
                target: "downloads",
                "root_shell_probe_trace_emit_failed event=\"{}\" error=\"{}\"",
                event_name,
                error
            );
        }
    }))
}

#[cfg(test)]
fn download_root_shell_probe_trace_sink(_url: String) -> Option<RootShellProbeTraceSink> {
    None
}

#[cfg(not(test))]
fn emit_download_root_title_stage_trace(
    url: &str,
    stage: &str,
    status: &str,
    elapsed_ms: u128,
    error: Option<String>,
) {
    let Some(app) = runtime().ok().map(|runtime| runtime.app.clone()) else {
        return;
    };

    if let Err(emit_error) = (PlaybackDiagnosticTraceEvent {
        event: "download-root-title-stage".to_string(),
        playlist_name: None,
        music_name: None,
        music_url: None,
        start_ms: None,
        end_ms: None,
        elapsed_ms: Some(elapsed_ms),
        candidate_count: None,
        queue_count: None,
        status: Some(status.to_string()),
        error,
        details: Some(vec![
            PlaybackDiagnosticTraceDetail {
                key: "stage".to_string(),
                value: stage.to_string(),
            },
            PlaybackDiagnosticTraceDetail {
                key: "url".to_string(),
                value: url.to_string(),
            },
        ]),
    })
    .emit(&app)
    {
        log::error!(
            target: "downloads",
            "root_title_stage_trace_emit_failed stage=\"{}\" error=\"{}\"",
            stage,
            emit_error
        );
    }
}

#[cfg(test)]
fn emit_download_root_title_stage_trace(
    _url: &str,
    _stage: &str,
    _status: &str,
    _elapsed_ms: u128,
    _error: Option<String>,
) {
}

pub(crate) async fn probe_download_root_title_with_client(
    url: String,
    client: Arc<dyn YtDlpClient>,
    trace: Option<RootShellProbeTraceSink>,
) -> Result<DownloadRootTitleEvidence> {
    let requested_url = url.clone();
    let command_start = Instant::now();
    emit_download_root_title_stage_trace(&requested_url, "command", "start", 0, None);

    let shell = probe_root_shell_with_limit(client, url, trace).await?;

    let existing_lookup_start = Instant::now();
    emit_download_root_title_stage_trace(&shell.webpage_url, "existing_lookup", "start", 0, None);
    let existing = match resolve_existing_collection_for_download_identity(
        &shell.webpage_url,
        &shell.title,
        shell.source_kind,
    )
    .await
    {
        Ok(existing) => {
            emit_download_root_title_stage_trace(
                &shell.webpage_url,
                "existing_lookup",
                "done",
                existing_lookup_start.elapsed().as_millis(),
                None,
            );
            existing
        }
        Err(error) => {
            emit_download_root_title_stage_trace(
                &shell.webpage_url,
                "existing_lookup",
                "error",
                existing_lookup_start.elapsed().as_millis(),
                Some(error.to_string()),
            );
            return Err(error);
        }
    };

    let folder_resolve_start = Instant::now();
    emit_download_root_title_stage_trace(&shell.webpage_url, "folder_resolve", "start", 0, None);
    let folder = match collection_import::resolve_collection_folder(
        &shell.webpage_url,
        &shell.title,
        existing.as_ref(),
    )
    .await
    {
        Ok(folder) => {
            emit_download_root_title_stage_trace(
                &shell.webpage_url,
                "folder_resolve",
                "done",
                folder_resolve_start.elapsed().as_millis(),
                None,
            );
            folder
        }
        Err(error) => {
            emit_download_root_title_stage_trace(
                &shell.webpage_url,
                "folder_resolve",
                "error",
                folder_resolve_start.elapsed().as_millis(),
                Some(error.to_string()),
            );
            return Err(error);
        }
    };

    let enable_updates = existing
        .as_ref()
        .and_then(|collection| collection.enable_updates)
        .or_else(|| (shell.source_kind == CollectionSourceKind::List).then_some(false));
    let collection_url = existing
        .as_ref()
        .map(|collection| collection.url.clone())
        .unwrap_or_else(|| shell.webpage_url.clone());
    let plan = CollectionShellPlan {
        source_kind: shell.source_kind,
        collection_name: shell.title.clone(),
        collection_url,
        collection_folder: folder.clone(),
        enable_updates,
    };

    let persist_shell_start = Instant::now();
    emit_download_root_title_stage_trace(&plan.collection_url, "persist_shell", "start", 0, None);
    let collection = match collection_import::persist_prepared_collection_shell(plan.clone()).await
    {
        Ok(collection) => {
            emit_download_root_title_stage_trace(
                &plan.collection_url,
                "persist_shell",
                "done",
                persist_shell_start.elapsed().as_millis(),
                None,
            );
            collection
        }
        Err(error) => {
            emit_download_root_title_stage_trace(
                &plan.collection_url,
                "persist_shell",
                "error",
                persist_shell_start.elapsed().as_millis(),
                Some(error.to_string()),
            );
            return Err(error);
        }
    };

    let requested_attach_start = Instant::now();
    emit_download_root_title_stage_trace(&requested_url, "attach_requested_task", "start", 0, None);
    if let Err(error) = attach_prepared_collection_shell_to_active_task(&requested_url, &plan).await
    {
        emit_download_root_title_stage_trace(
            &requested_url,
            "attach_requested_task",
            "error",
            requested_attach_start.elapsed().as_millis(),
            Some(error.to_string()),
        );
        return Err(error);
    }
    emit_download_root_title_stage_trace(
        &requested_url,
        "attach_requested_task",
        "done",
        requested_attach_start.elapsed().as_millis(),
        None,
    );

    if requested_url != plan.collection_url {
        let canonical_attach_start = Instant::now();
        emit_download_root_title_stage_trace(
            &plan.collection_url,
            "attach_canonical_task",
            "start",
            0,
            None,
        );
        if let Err(error) =
            attach_prepared_collection_shell_to_active_task(&plan.collection_url, &plan).await
        {
            emit_download_root_title_stage_trace(
                &plan.collection_url,
                "attach_canonical_task",
                "error",
                canonical_attach_start.elapsed().as_millis(),
                Some(error.to_string()),
            );
            return Err(error);
        }
        emit_download_root_title_stage_trace(
            &plan.collection_url,
            "attach_canonical_task",
            "done",
            canonical_attach_start.elapsed().as_millis(),
            None,
        );
    }

    let evidence = DownloadRootTitleEvidence {
        url: plan.collection_url.clone(),
        title: shell.title,
        folder,
        enable_updates,
        source_kind: shell.source_kind,
        collection,
    };
    emit_download_root_title_stage_trace(
        &evidence.url,
        "command",
        "done",
        command_start.elapsed().as_millis(),
        None,
    );

    Ok(evidence)
}

#[cfg(not(test))]
async fn enqueue_collection_download_with_trigger(
    url: String,
    trigger: DownloadTrigger,
) -> Result<EnqueuedCollectionDownload> {
    log::info!(
        target: "downloads",
        "collection_download_enqueue_requested trigger={} url=\"{}\"",
        trigger.as_str(),
        url
    );
    let (task, collection) = match prepare_task_enqueue_outcome(url, trigger).await? {
        PreparedTaskEnqueue::Existing(task) => {
            log::info!(
                target: "downloads",
                "collection_download_enqueue_reused task={} trigger={} url=\"{}\" status={}",
                task.id,
                task.trigger.as_str(),
                task.url,
                task.status.as_str()
            );
            let collection =
                collection_import::persist_download_collection_shell_from_task(&task).await?;
            (task, collection)
        }
        PreparedTaskEnqueue::New(task) => {
            log::info!(
                target: "downloads",
                "collection_download_enqueue_created task={} trigger={} url=\"{}\" status={}",
                task.id,
                task.trigger.as_str(),
                task.url,
                task.status.as_str()
            );
            (task, None)
        }
    };

    if !task.status.is_terminal() {
        spawn_task(task.id.to_string(), None)?;
    }

    Ok(EnqueuedCollectionDownload { task, collection })
}

#[cfg(not(test))]
#[allow(dead_code)]
pub(crate) async fn enqueue_collection_download_for_test(
    url: String,
    client: Arc<dyn YtDlpClient>,
    ffmpeg_path: PathBuf,
    save_root: PathBuf,
) -> Result<EnqueuedCollectionDownload> {
    // This helper is reserved for manual chain verification outside `cargo test`.
    // Domain tests should follow the appdb pattern with fake dependencies and
    // temporary appdb state instead of pulling Tauri-hosted execution paths into
    // the Rust test harness.
    let deps = DownloadExecutionDeps {
        client,
        ffmpeg_path,
        save_root,
        cookies_path: None,
    };
    let prepared = prepare_task_enqueue_outcome(url, DownloadTrigger::Manual).await?;

    let (mut task, mut collection) = match prepared {
        PreparedTaskEnqueue::Existing(task) => {
            match collection_import::resolve_existing_enqueued_collection(&task).await {
                Ok(collection) => (task, collection),
                Err(_) => bootstrap_enqueued_collection_with_deps(task, deps.clone()).await?,
            }
        }
        PreparedTaskEnqueue::New(task) => {
            bootstrap_enqueued_collection_with_deps(task, deps.clone()).await?
        }
    };

    if !task.status.is_terminal() {
        run_task_with_deps(task.id.to_string(), deps, None).await?;
        task = repo::get_task(&task.id.to_string()).await?;
        if let Some(collection_url) = task.collection_url.as_deref()
            && let Some(updated) = collection_import::get_collection_by_url(collection_url).await?
        {
            collection = updated;
        }
    }

    Ok(EnqueuedCollectionDownload {
        task,
        collection: Some(collection),
    })
}

/// Batch imports can enqueue many URLs in parallel, so duplicate suppression
/// must cover the repository read/save window instead of relying on a plain
/// "find active task, then insert" sequence.
#[cfg(test)]
pub(crate) async fn prepare_task_enqueue(
    url: String,
    trigger: DownloadTrigger,
) -> Result<DownloadTask> {
    Ok(match prepare_task_enqueue_outcome(url, trigger).await? {
        PreparedTaskEnqueue::Existing(task) | PreparedTaskEnqueue::New(task) => task,
    })
}

#[cfg(test)]
pub(crate) async fn accept_collection_download_for_test(
    url: String,
    trigger: DownloadTrigger,
) -> Result<EnqueuedCollectionDownload> {
    let task = prepare_task_enqueue(url, trigger).await?;
    let collection = collection_import::persist_download_collection_shell_from_task(&task).await?;
    Ok(EnqueuedCollectionDownload { task, collection })
}

#[cfg(test)]
pub(crate) async fn accept_collection_download_with_root_shell_for_test(
    url: String,
    trigger: DownloadTrigger,
    client: Arc<dyn YtDlpClient>,
) -> Result<EnqueuedCollectionDownload> {
    let task = prepare_task_enqueue(url, trigger).await?;
    let task = attach_root_shell_to_task(task, client).await?;
    let collection = collection_import::persist_download_collection_shell_from_task(&task).await?;
    Ok(EnqueuedCollectionDownload { task, collection })
}

async fn prepare_task_enqueue_outcome(
    url: String,
    trigger: DownloadTrigger,
) -> Result<PreparedTaskEnqueue> {
    let normalized_url = normalize_url(&url)?;
    let mut backoff = Duration::from_millis(5);

    for attempt in 0..PREPARE_TASK_ENQUEUE_RETRY_ATTEMPTS {
        match prepare_task_enqueue_once(&normalized_url, trigger).await {
            Ok(prepared) => return Ok(prepared),
            Err(error)
                if repo::is_retryable_transaction_conflict(&error)
                    && attempt + 1 < PREPARE_TASK_ENQUEUE_RETRY_ATTEMPTS =>
            {
                tokio::time::sleep(backoff).await;
                backoff = backoff.saturating_mul(2);
            }
            Err(error) => return Err(error),
        }
    }

    unreachable!("prepare task enqueue retry loop should always return or error")
}

async fn prepare_task_enqueue_once(
    normalized_url: &str,
    trigger: DownloadTrigger,
) -> Result<PreparedTaskEnqueue> {
    let stable_task_id = task_id_for(normalized_url, trigger);
    loop {
        if let Some(existing) = repo::try_get_task(&stable_task_id).await? {
            return prepare_existing_stable_task_enqueue(existing).await;
        }

        if let Some(existing) = repo::find_latest_active_task_for_url(normalized_url).await? {
            return Ok(PreparedTaskEnqueue::Existing(
                attach_existing_collection_shell_to_task(existing).await?,
            ));
        }

        let Some(_claim) = try_claim_enqueue_url(normalized_url)? else {
            task::yield_now().await;
            continue;
        };

        if let Some(existing) = repo::try_get_task(&stable_task_id).await? {
            return prepare_existing_stable_task_enqueue(existing).await;
        }

        if let Some(existing) = repo::find_latest_active_task_for_url(normalized_url).await? {
            return Ok(PreparedTaskEnqueue::Existing(
                attach_existing_collection_shell_to_task(existing).await?,
            ));
        }

        let mut task =
            DownloadTask::new(stable_task_id.clone(), normalized_url.to_string(), trigger);
        apply_existing_collection_shell_to_task(&mut task).await?;

        let saved = repo::save_task(task).await?;
        log::info!(
            target: "downloads",
            "download_task_created task={} trigger={} url=\"{}\" collection_url={} collection_name={}",
            saved.id,
            saved.trigger.as_str(),
            saved.url,
            saved.collection_url.as_deref().unwrap_or("none"),
            saved.collection_name.as_deref().unwrap_or("none")
        );
        return Ok(PreparedTaskEnqueue::New(saved));
    }
}

async fn prepare_existing_stable_task_enqueue(
    mut task: DownloadTask,
) -> Result<PreparedTaskEnqueue> {
    if should_revive_stable_download_task(task.status) {
        task.revive_for_retry();
        let saved = repo::save_task(task).await?;
        publish_download_task_change(&saved);
        return Ok(PreparedTaskEnqueue::Existing(
            attach_existing_collection_shell_to_task(saved).await?,
        ));
    }

    Ok(PreparedTaskEnqueue::Existing(
        attach_existing_collection_shell_to_task(task).await?,
    ))
}

fn should_revive_stable_download_task(status: DownloadTaskStatus) -> bool {
    matches!(
        status,
        DownloadTaskStatus::Failed
            | DownloadTaskStatus::Cancelled
            | DownloadTaskStatus::Interrupted
            | DownloadTaskStatus::CompletedWithErrors
    )
}

async fn attach_existing_collection_shell_to_task(mut task: DownloadTask) -> Result<DownloadTask> {
    if !apply_existing_collection_shell_to_task(&mut task).await? {
        return Ok(task);
    }

    task.touch();
    let saved = repo::save_task(task).await?;
    publish_download_task_change(&saved);
    Ok(saved)
}

async fn apply_existing_collection_shell_to_task(task: &mut DownloadTask) -> Result<bool> {
    if task.collection_url.is_some()
        && task.collection_name.is_some()
        && task.collection_folder.is_some()
        && task.source_kind.is_some()
    {
        return Ok(false);
    }

    let Some(plan) = prepared_collection_shell_plan_for_url(&task.url).await? else {
        return Ok(false);
    };

    collection_import::apply_collection_shell_plan_to_task(task, &plan);
    task.last_error = None;
    Ok(true)
}

async fn prepared_collection_shell_plan_for_url(url: &str) -> Result<Option<CollectionShellPlan>> {
    let Some(collection) = collection_import::get_collection_by_url(url).await? else {
        return Ok(None);
    };

    Ok(Some(CollectionShellPlan {
        source_kind: classify_root_preference(&collection.url),
        collection_name: collection.name,
        collection_url: collection.url,
        collection_folder: collection.folder,
        enable_updates: collection.enable_updates,
    }))
}

async fn attach_prepared_collection_shell_to_active_task(
    task_url: &str,
    plan: &CollectionShellPlan,
) -> Result<()> {
    let Some(mut task) = repo::find_latest_active_task_for_url(task_url).await? else {
        return Ok(());
    };

    if task.collection_url.as_deref() == Some(plan.collection_url.as_str())
        && task.collection_name.as_deref() == Some(plan.collection_name.as_str())
        && task.collection_folder.as_deref() == Some(plan.collection_folder.as_str())
        && task.source_kind == Some(plan.source_kind)
    {
        return Ok(());
    }

    collection_import::apply_collection_shell_plan_to_task(&mut task, plan);
    task.last_error = None;
    task.touch();
    let saved = repo::save_task(task).await?;
    publish_download_task_change(&saved);
    Ok(())
}

#[cfg(test)]
pub(crate) async fn attach_root_shell_to_task(
    mut task: DownloadTask,
    client: Arc<dyn YtDlpClient>,
) -> Result<DownloadTask> {
    if task.collection_url.is_some() && task.collection_name.is_some() && task.source_kind.is_some()
    {
        return Ok(task);
    }

    let shell = probe_root_shell_with_limit(client, task.url.clone(), None).await?;
    let existing = collection_import::get_collection_by_url(&shell.webpage_url).await?;
    let collection_url = existing
        .as_ref()
        .map(|collection| collection.url.clone())
        .unwrap_or(shell.webpage_url);
    let collection_folder =
        resolve_enqueue_collection_folder(&task, &collection_url, &shell.title, existing.as_ref())
            .await?;

    task.collection_url = Some(collection_url);
    task.collection_name = Some(shell.title);
    task.collection_folder = Some(collection_folder);
    task.source_kind = Some(shell.source_kind);
    task.last_error = None;
    repo::save_task(task).await
}

#[cfg(test)]
async fn resolve_enqueue_collection_folder(
    task: &DownloadTask,
    collection_url: &str,
    collection_name: &str,
    existing: Option<&Collection>,
) -> Result<String> {
    if let Some(folder) = task
        .collection_folder
        .as_deref()
        .map(str::trim)
        .filter(|folder| !folder.is_empty())
    {
        return Ok(folder.to_string());
    }

    collection_import::resolve_collection_folder(collection_url, collection_name, existing).await
}

#[cfg(not(test))]
fn spawn_task(task_id: String, root_probe: Option<RootProbe>) -> Result<()> {
    let runtime = runtime()?;
    if !try_claim_task(&task_id)? {
        return Ok(());
    }

    let app = runtime.app.clone();
    tauri::async_runtime::spawn(async move {
        let _claim = ActiveDownloadTaskClaim::new(task_id.clone());
        let task_id_for_worker = task_id.clone();
        let handle = tauri::async_runtime::spawn(async move {
            run_task(task_id_for_worker, app, root_probe).await
        });
        match handle.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = mark_task_failed(&task_id, error.to_string()).await;
            }
            Err(join_error) => {
                let _ = mark_task_failed(
                    &task_id,
                    format!("download task worker stopped unexpectedly: {join_error}"),
                )
                .await;
            }
        }
    });

    Ok(())
}

#[cfg(test)]
fn spawn_task(_task_id: String, _root_probe: Option<RootProbe>) -> Result<()> {
    Ok(())
}

#[cfg(not(test))]
async fn bootstrap_enqueued_collection_with_deps(
    task: DownloadTask,
    deps: DownloadExecutionDeps,
) -> Result<(DownloadTask, Collection)> {
    let plan = resolve_collection_plan(&task, deps.client).await?;
    collection_import::persist_enqueued_collection_plan(task, &plan).await
}

#[cfg(not(test))]
async fn run_task(task_id: String, app: AppHandle, root_probe: Option<RootProbe>) -> Result<()> {
    let deps = resolve_execution_deps(&app).await?;
    run_task_with_deps(task_id, deps, root_probe).await
}

#[cfg(not(test))]
async fn run_task_with_deps(
    task_id: String,
    deps: DownloadExecutionDeps,
    root_probe: Option<RootProbe>,
) -> Result<()> {
    let task_started = Instant::now();
    let mut task_snapshot = repo::get_task(&task_id).await?;
    task_snapshot.url = normalize_url(&task_snapshot.url)?;
    log::info!(
        target: "downloads",
        "task_run_loaded task={} trigger={} url=\"{}\" status={} leaves={} completed={} failed={} carried_root_probe={}",
        task_snapshot.id,
        task_snapshot.trigger.as_str(),
        task_snapshot.url,
        task_snapshot.status.as_str(),
        task_snapshot.leafs.len(),
        task_snapshot.completed_leaves,
        task_snapshot.failed_leaves,
        root_probe.is_some()
    );
    let carried_partial_reason = task_snapshot
        .last_error
        .clone()
        .filter(|error| error.starts_with("provider returned "));
    update_task_status(
        &mut task_snapshot,
        DownloadTaskStatus::Resolving,
        carried_partial_reason,
    )
    .await?;

    let client = deps.client;
    let save_root = deps.save_root;
    let plan_started = Instant::now();
    log::info!(
        target: "downloads",
        "task_plan_resolve_started task={} url=\"{}\" carried_root_probe={}",
        task_snapshot.id,
        task_snapshot.url,
        root_probe.is_some()
    );
    let plan =
        match resolve_collection_plan_with_root_probe(&task_snapshot, client.clone(), root_probe)
            .await
        {
            Ok(plan) => plan,
            Err(error) => {
                let message = error.to_string();
                if is_youtube_cookie_challenge_error_message(&message) {
                    pause_task_for_youtube_cookie_challenge_without_leaf(
                        &mut task_snapshot,
                        message,
                    )
                    .await?;
                    return Ok(());
                }
                return Err(error);
            }
        };
    log::info!(
        target: "downloads",
        "task_plan_resolve_finished task={} collection=\"{}\" source_kind={} leaves={} partial={} elapsed_ms={}",
        task_snapshot.id,
        plan.collection_url,
        plan.source_kind.as_str(),
        plan.leaves.len(),
        plan.partial_reason.is_some(),
        plan_started.elapsed().as_millis()
    );
    let mut collection =
        collection_import::load_download_transaction_collection_shell(&plan).await?;
    apply_collection_plan_to_task_with_existing_music_evidence(
        &mut task_snapshot,
        &collection,
        &plan,
        &save_root,
    );
    task_snapshot = repo::save_task(task_snapshot.clone()).await?;
    let shell = collection_import::persist_download_collection_shell_from_task(&task_snapshot)
        .await?
        .context("download task shell evidence did not produce a collection")?;
    publish_download_task_change(&task_snapshot);
    log::info!(
        target: "downloads",
        "task_shell_persisted task={} collection=\"{}\" task_leaves={} collection_musics={} elapsed_ms={}",
        task_snapshot.id,
        task_snapshot.collection_url.as_deref().unwrap_or("none"),
        task_snapshot.leafs.len(),
        shell.musics.len(),
        task_started.elapsed().as_millis()
    );
    if collection.musics.is_empty() {
        collection = shell;
    }
    let mut group_catalog = GroupCatalog::seed(&collection);

    if task_snapshot.leafs.is_empty() {
        collection_import::persist_empty_collection(&mut collection).await?;
        update_task_status(&mut task_snapshot, DownloadTaskStatus::Completed, None).await?;
        return Ok(());
    }

    let mut collection_changed = false;

    if task_snapshot.leafs.is_empty() {
        if collection_changed {
            collection_import::notify_downloaded_leaf_collection_committed();
        }
        let next_status = if plan.partial_reason.is_some() {
            DownloadTaskStatus::CompletedWithErrors
        } else {
            DownloadTaskStatus::Completed
        };
        update_task_status(&mut task_snapshot, next_status, plan.partial_reason.clone()).await?;
        return Ok(());
    }

    let runnable_leaves = runnable_task_leaf_work_items(&task_snapshot, &plan);
    let download_window =
        LeafDownloadWindow::for_collection(plan.source_kind, runnable_leaves.len());
    let parallelism = download_window.current_limit();
    log::info!(
        target: "downloads",
        "task_pipeline_started task={} trigger={} url=\"{}\" collection_url={} source_kind={} total_leaves={} runnable_leaves={} download_parallelism={} max_download_parallelism={} folder=\"{}\" created_at={}",
        task_snapshot.id,
        task_snapshot.trigger.as_str(),
        task_snapshot.url,
        task_snapshot.collection_url.as_deref().unwrap_or("none"),
        plan.source_kind.as_str(),
        plan.leaves.len(),
        runnable_leaves.len(),
        parallelism,
        download_window.max_limit(),
        collection.folder,
        task_snapshot.created_at
    );

    task_snapshot.status = DownloadTaskStatus::Downloading;
    task_snapshot.last_error = None;
    task_snapshot.touch();
    task_snapshot = repo::save_task(task_snapshot.clone()).await?;
    publish_download_task_change(&task_snapshot);

    let mut pipeline = LeafPipelineState::new(runnable_leaves, download_window);
    fill_leaf_pipeline(
        &mut pipeline,
        &mut task_snapshot,
        &collection,
        client.clone(),
        plan.source_kind,
        &save_root,
        &deps.ffmpeg_path,
        deps.cookies_path.clone(),
    )
    .await?;
    log::info!(
        target: "downloads",
        "task_pipeline_seeded task={} active_prepares={} active_downloads={} active_finalizations={} pending_prepares={} ready_downloads={} ready_finalizations={} elapsed_ms={}",
        task_snapshot.id,
        pipeline.active_prepares,
        pipeline.active_downloads,
        pipeline.active_finalizations,
        pipeline.pending_prepares.len(),
        pipeline.ready_downloads.len(),
        pipeline.ready_finalizations.len(),
        task_started.elapsed().as_millis()
    );

    while pipeline.has_work() {
        let commit_result = handle_leaf_pipeline_event(
            &mut pipeline,
            &mut task_snapshot,
            &mut collection,
            &mut group_catalog,
            client.clone(),
            plan.source_kind,
            &save_root,
            &deps.ffmpeg_path,
            deps.cookies_path.clone(),
        )
        .await?;
        collection_changed |= commit_result.collection_changed;
        request_committed_leaf_post_processing(
            &collection,
            plan.source_kind,
            &save_root,
            &commit_result.committed_paths,
        );
        if task_snapshot.status == DownloadTaskStatus::AwaitingCredentials {
            log::warn!(
                target: "downloads",
                "task_pipeline_paused task={} status=awaiting_credentials",
                task_snapshot.id
            );
            break;
        }
        fill_leaf_pipeline(
            &mut pipeline,
            &mut task_snapshot,
            &collection,
            client.clone(),
            plan.source_kind,
            &save_root,
            &deps.ffmpeg_path,
            deps.cookies_path.clone(),
        )
        .await?;
        log::info!(
            target: "downloads",
            "task_pipeline_loop_tick task={} active_prepares={} active_downloads={} active_finalizations={} pending_prepares={} ready_downloads={} ready_finalizations={} completed={} failed={} elapsed_ms={}",
            task_snapshot.id,
            pipeline.active_prepares,
            pipeline.active_downloads,
            pipeline.active_finalizations,
            pipeline.pending_prepares.len(),
            pipeline.ready_downloads.len(),
            pipeline.ready_finalizations.len(),
            task_snapshot.completed_leaves,
            task_snapshot.failed_leaves,
            task_started.elapsed().as_millis()
        );
    }

    if collection_changed {
        collection_import::notify_downloaded_leaf_collection_committed();
    }

    if task_snapshot.status == DownloadTaskStatus::AwaitingCredentials {
        return Ok(());
    }

    mark_unresolved_leaves_failed(&mut task_snapshot).await?;
    let completed = task_snapshot.completed_leaves;
    if task_snapshot.last_error.is_none() {
        task_snapshot.last_error = plan.partial_reason.clone();
    }
    let next_status = if plan.partial_reason.is_some() && task_snapshot.completed_leaves > 0 {
        DownloadTaskStatus::CompletedWithErrors
    } else if task_snapshot.failed_leaves == 0 && task_snapshot.completed_leaves > 0 {
        DownloadTaskStatus::Completed
    } else if completed > 0 {
        DownloadTaskStatus::CompletedWithErrors
    } else {
        DownloadTaskStatus::Failed
    };
    let last_error = task_snapshot.last_error.clone();
    update_task_status(&mut task_snapshot, next_status, last_error).await?;
    log::info!(
        target: "downloads",
        "task_pipeline_finished task={} status={} completed={} failed={} total={}",
        task_snapshot.id,
        task_snapshot.status.as_str(),
        task_snapshot.completed_leaves,
        task_snapshot.failed_leaves,
        task_snapshot.total_leaves
    );
    Ok(())
}

fn planned_leaf_evidence_by_id(plan: &CollectionSyncPlan) -> HashMap<Id, PlannedLeaf> {
    let mut evidence = HashMap::new();
    for planned in &plan.leaves {
        evidence
            .entry(planned.id.clone())
            .or_insert_with(|| planned.clone());
    }
    evidence
}

pub(crate) fn runnable_task_leaf_work_items(
    task: &DownloadTask,
    plan: &CollectionSyncPlan,
) -> Vec<LeafWorkItem> {
    let planned_evidence = planned_leaf_evidence_by_id(plan);
    let mut foreground_assigned = false;
    task.leafs
        .iter()
        .filter(|leaf| !leaf.status.is_terminal())
        .cloned()
        .map(|leaf| {
            let planned = planned_evidence.get(&leaf.id).cloned();
            let readiness = if foreground_assigned {
                LeafReadinessCargo::Background
            } else {
                foreground_assigned = true;
                LeafReadinessCargo::Foreground
            };
            LeafWorkItem {
                leaf,
                planned,
                readiness,
            }
        })
        .collect()
}

pub(crate) fn leaf_work_item_insert_index(
    current_readiness: impl IntoIterator<Item = LeafReadinessCargo>,
    current_len: usize,
    readiness: LeafReadinessCargo,
) -> usize {
    let priority = readiness.priority();
    current_readiness
        .into_iter()
        .position(|current| current.priority() < priority)
        .unwrap_or(current_len)
}

pub(crate) fn leaf_finalization_insert_index(
    current_readiness: impl IntoIterator<Item = LeafReadinessCargo>,
    current_len: usize,
    readiness: LeafReadinessCargo,
) -> usize {
    leaf_work_item_insert_index(current_readiness, current_len, readiness)
}

pub(crate) fn discard_materialized_planned_leaves(
    task: &mut DownloadTask,
    completions: Vec<collection_import::ExistingPlannedLeafCompletion>,
) {
    for completion in completions {
        if task.remove_leaf(&completion.leaf_id).is_some() {
            task.completed_leaves = task.completed_leaves.saturating_add(1);
            task.touch();
        }
    }
}

pub(crate) fn apply_collection_plan_to_task_with_existing_music_evidence(
    task: &mut DownloadTask,
    collection: &Collection,
    plan: &CollectionSyncPlan,
    save_root: &Path,
) {
    collection_import::apply_collection_plan_to_task(task, plan);
    discard_materialized_planned_leaves(
        task,
        collection_import::existing_planned_leaf_completions(collection, plan, save_root),
    );
}

async fn mark_unresolved_leaves_failed(task_snapshot: &mut DownloadTask) -> Result<()> {
    let unresolved = task_snapshot
        .leafs
        .iter()
        .filter(|leaf| leaf.status.is_active())
        .cloned()
        .collect::<Vec<_>>();
    for leaf in unresolved {
        mark_leaf_failed(
            task_snapshot,
            leaf,
            "download pipeline drained before this leaf reached a terminal state".to_string(),
        )
        .await?;
    }
    Ok(())
}

#[cfg(not(test))]
async fn fill_leaf_pipeline(
    pipeline: &mut LeafPipelineState,
    task_snapshot: &mut DownloadTask,
    collection: &Collection,
    client: Arc<dyn YtDlpClient>,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    ffmpeg_path: &Path,
    cookies_path: Option<PathBuf>,
) -> Result<()> {
    spawn_ready_leaf_downloads(
        pipeline,
        task_snapshot,
        source_kind,
        save_root,
        client.clone(),
        cookies_path,
    )
    .await?;
    spawn_ready_leaf_finalizations(pipeline, collection, source_kind, save_root, ffmpeg_path);
    spawn_ready_leaf_preparations(pipeline, task_snapshot, client).await?;
    Ok(())
}

#[cfg(not(test))]
async fn spawn_ready_leaf_preparations(
    pipeline: &mut LeafPipelineState,
    task_snapshot: &mut DownloadTask,
    client: Arc<dyn YtDlpClient>,
) -> Result<()> {
    while pipeline.active_prepares < pipeline.prepare_parallelism
        && !pipeline.pending_prepares.is_empty()
    {
        let Some(mut work_item) = pipeline.pending_prepares.pop_front() else {
            break;
        };
        let mut leaf_snapshot = work_item.leaf.clone();
        leaf_snapshot.status = DownloadLeafStatus::Probing;
        leaf_snapshot.last_error = None;
        work_item.leaf = leaf_snapshot.clone();
        task_snapshot.status = DownloadTaskStatus::Downloading;
        task_snapshot.last_error = None;
        task_snapshot.replace_leaf(leaf_snapshot.clone());

        log::info!(
            target: "downloads",
            "leaf_prepare_queued leaf={} sequence={} url={} active_prepares={} active_downloads={} pending={}",
            leaf_snapshot.id,
            leaf_snapshot.sequence,
            work_item.url(),
            pipeline.active_prepares + 1,
            pipeline.active_downloads,
            pipeline.pending_prepares.len()
        );

        pipeline.workers.spawn(prepare_leaf_download_worker(
            client.clone(),
            LeafPreparationInput { work_item },
        ));
        pipeline.active_prepares += 1;
    }

    Ok(())
}

#[cfg(not(test))]
fn spawn_ready_leaf_finalizations(
    pipeline: &mut LeafPipelineState,
    collection: &Collection,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    ffmpeg_path: &Path,
) {
    while pipeline.active_finalizations < pipeline.finalization_parallelism {
        let Some(outcome) = pipeline.ready_finalizations.pop_front() else {
            break;
        };
        match outcome {
            LeafFinalization::Downloaded(outcome) => {
                pipeline
                    .ready_finalizations
                    .push_front(LeafFinalization::Downloaded(outcome));
                break;
            }
            LeafFinalization::ExistingFile(completion) => {
                let first_readiness = completion.readiness;
                let available_slots = pipeline
                    .finalization_parallelism
                    .saturating_sub(pipeline.active_finalizations)
                    .max(1);
                let ready_existing_files = 1 + ready_existing_file_prefix_len(pipeline);
                let fair_share_limit =
                    existing_file_finalization_batch_limit(ready_existing_files, available_slots)
                        .max(1);
                let batch_limit = existing_file_finalization_batch_take_limit(
                    first_readiness,
                    pipeline.ready_finalizations.iter().filter_map(
                        |finalization| match finalization {
                            LeafFinalization::ExistingFile(completion) => {
                                Some(completion.readiness)
                            }
                            LeafFinalization::Downloaded(_) => None,
                        },
                    ),
                    fair_share_limit,
                );
                let completions =
                    collect_ready_existing_file_finalizations(completion, pipeline, batch_limit);
                log::info!(
                    target: "downloads",
                    "leaf_existing_file_finalization_queued collection=\"{}\" leaves={} readiness={} active_finalizations={} pending_finalizations={} available_slots={} ready_existing_files={}",
                    collection.url,
                    completions.len(),
                    first_readiness.as_str(),
                    pipeline.active_finalizations + 1,
                    pipeline.ready_finalizations.len(),
                    available_slots,
                    ready_existing_files
                );
                pipeline.workers.spawn(finalize_existing_leaf_files_worker(
                    ExistingLeafFinalizationInput {
                        collection: collection.clone(),
                        source_kind,
                        save_root: save_root.to_path_buf(),
                        ffmpeg_path: ffmpeg_path.to_path_buf(),
                        completions,
                    },
                ));
                pipeline.active_finalizations += 1;
            }
        }
    }
}

#[cfg(not(test))]
async fn prepare_leaf_download_worker(
    client: Arc<dyn YtDlpClient>,
    input: LeafPreparationInput,
) -> LeafPipelineEvent {
    let leaf = input.work_item.leaf;
    let planned = input.work_item.planned;
    let url = planned
        .as_ref()
        .map(|planned| planned.url.as_str())
        .unwrap_or(leaf.url.as_str())
        .to_string();
    let probe = match planned
        .as_ref()
        .and_then(|planned| planned.initial_probe.clone())
    {
        Some(probe) => probe,
        None => match probe_leaf_with_retry(client.clone(), leaf.id.to_string(), url.clone()).await
        {
            Ok(probe) => probe,
            Err(error) => {
                return LeafPipelineEvent::Prepared(Err(FailedLeafPreparation {
                    leaf,
                    error: error.to_string(),
                }));
            }
        },
    };

    let mut music_probe = probe.clone();
    if let Some(music_title) = planned
        .as_ref()
        .and_then(|planned| planned.music_title.as_ref())
    {
        music_probe.title = music_title.clone();
    }
    let group = planned.and_then(|planned| planned.group_hint);

    LeafPipelineEvent::Prepared(Ok(PreparedLeafDownload {
        leaf,
        probe,
        music_probe,
        group,
        url,
        readiness: input.work_item.readiness,
    }))
}

#[cfg(not(test))]
async fn probe_leaf_with_retry(
    client: Arc<dyn YtDlpClient>,
    leaf_id: String,
    url: String,
) -> Result<LeafProbe> {
    let retry_policy = LeafDownloadRetryPolicy::default();
    let mut attempt = 1;

    loop {
        let client = client.clone();
        let probe_url = url.clone();
        let usage = acquire_downloads_ytdlp_probe_usage();
        let probe_result = run_blocking(move || {
            let _usage = usage;
            client.probe_leaf(&probe_url)
        })
        .await;

        match probe_result {
            Ok(probe) => return Ok(probe),
            Err(error) => {
                let Some(delay) = retry_policy.cooldown_after_failure(attempt, &leaf_id, &error)
                else {
                    return Err(error);
                };

                log::warn!(
                    target: "downloads",
                    "leaf_prepare_retry leaf={} attempt={} delay_ms={} error=\"{}\"",
                    leaf_id,
                    attempt,
                    delay.as_millis(),
                    error
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
        }
    }
}

#[cfg(not(test))]
async fn download_leaf_audio_worker(
    client: Arc<dyn YtDlpClient>,
    input: LeafDownloadInput,
) -> LeafPipelineEvent {
    let retry_policy = LeafDownloadRetryPolicy::default();
    let retry_key = input.leaf.id.to_string();
    let mut attempt = 1;
    let mut retry_failures = 0;

    loop {
        let client = client.clone();
        let url = input.url.clone();
        let target_dir = input.target_dir.clone();
        let temp_file_stem = input.temp_file_stem.clone();
        let cookies_path = input.cookies_path.clone();
        let ytdlp_usage = acquire_downloads_ytdlp_download_usage();
        let ffmpeg_usage = acquire_downloads_ffmpeg_download_usage();
        let download_result = run_blocking(move || {
            let _ytdlp_usage = ytdlp_usage;
            let _ffmpeg_usage = ffmpeg_usage;
            let mut latest_progress = DownloadProgress::default();
            let downloaded = client.download_leaf_audio(
                &url,
                &target_dir,
                &temp_file_stem,
                cookies_path.as_deref(),
                &mut |progress| {
                    latest_progress = progress;
                },
            )?;
            Ok::<_, anyhow::Error>((downloaded, latest_progress))
        })
        .await;

        match download_result {
            Ok((downloaded, progress)) => {
                return LeafPipelineEvent::Downloaded(Ok(CompletedLeafDownload {
                    leaf: input.leaf,
                    probe: input.probe,
                    music_probe: input.music_probe,
                    group: input.group,
                    downloaded,
                    progress,
                    retry_failures,
                    readiness: input.readiness,
                }));
            }
            Err(error) => {
                let Some(delay) = retry_policy.cooldown_after_failure(attempt, &retry_key, &error)
                else {
                    return LeafPipelineEvent::Downloaded(Err(FailedLeafDownload {
                        leaf: input.leaf,
                        error: error.to_string(),
                    }));
                };

                retry_failures += 1;
                log::warn!(
                    target: "downloads",
                    "leaf_download_retry leaf={} attempt={} delay_ms={} error=\"{}\"",
                    input.leaf.id,
                    attempt,
                    delay.as_millis(),
                    error
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
        }
    }
}

#[cfg(not(test))]
async fn finalize_existing_leaf_files_worker(
    input: ExistingLeafFinalizationInput,
) -> LeafPipelineEvent {
    let collection_url = input.collection.url.clone();
    let leaves = input.completions.len();
    log::info!(
        target: "downloads",
        "leaf_existing_file_finalization_worker_started collection=\"{}\" leaves={}",
        collection_url,
        leaves
    );
    let outcome = finalize_existing_leaf_files(input).await.map_err(
        |(completions, probe_failures, error)| ExistingLeafFinalizationFailure {
            completions,
            probe_failures,
            error: error.to_string(),
        },
    );
    log::info!(
        target: "downloads",
        "leaf_existing_file_finalization_worker_finished collection=\"{}\" leaves={} status={}",
        collection_url,
        leaves,
        if outcome.is_ok() { "ok" } else { "failed" }
    );
    LeafPipelineEvent::FinalizedExistingFile(outcome)
}

#[cfg(not(test))]
async fn finalize_existing_leaf_files(
    input: ExistingLeafFinalizationInput,
) -> std::result::Result<
    ExistingLeafFinalizationResult,
    (
        Vec<ExistingLeafBatchCompletion>,
        Vec<ExistingLeafProbeFailure>,
        anyhow::Error,
    ),
> {
    let ExistingLeafFinalizationInput {
        mut collection,
        source_kind,
        save_root,
        ffmpeg_path,
        completions,
    } = input;

    log::info!(
        target: "downloads",
        "leaf_existing_file_duration_probe_batch_started collection=\"{}\" leaves={}",
        collection.url,
        completions.len()
    );
    let probe_outcome = probe_existing_file_batch_durations(&ffmpeg_path, completions).await;
    log::info!(
        target: "downloads",
        "leaf_existing_file_duration_probe_batch_finished collection=\"{}\" completed={} failed={}",
        collection.url,
        probe_outcome.completed.len(),
        probe_outcome.failed.len()
    );

    let materializations = probe_outcome
        .completed
        .iter()
        .map(
            |completion| collection_import::DownloadedLeafMusicMaterialization {
                probe: completion.music_probe.clone(),
                file_name: completion.relative_path.clone(),
                group: completion.group.clone(),
            },
        )
        .collect::<Vec<_>>();
    log::info!(
        target: "downloads",
        "leaf_existing_file_batch_persist_requested collection=\"{}\" leaves={}",
        collection.url,
        materializations.len()
    );
    let persist_outcome = match collection_import::persist_downloaded_leaf_music_batch(
        &mut collection,
        source_kind,
        &save_root,
        &materializations,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => return Err((probe_outcome.completed, probe_outcome.failed, error)),
    };
    log::info!(
        target: "downloads",
        "leaf_existing_file_batch_persist_finished collection=\"{}\" leaves={} changed={}",
        collection.url,
        materializations.len(),
        persist_outcome.changed
    );
    if let Err(error) = collection_import::write_raw_leaf_manifest_evidence_batch(
        &save_root.join(&collection.folder),
        &collection,
        source_kind,
        &materializations,
    ) {
        log::warn!(
            target: "downloads",
            "leaf_existing_file_manifest_evidence_write_failed collection=\"{}\" leaves={} error=\"{}\"",
            collection.url,
            materializations.len(),
            error
        );
    } else {
        log::info!(
            target: "downloads",
            "leaf_existing_file_manifest_evidence_written collection=\"{}\" leaves={}",
            collection.url,
            materializations.len()
        );
    }

    Ok(ExistingLeafFinalizationResult {
        persist_changed: persist_outcome.changed,
        completed: probe_outcome.completed,
        failed: probe_outcome.failed,
    })
}

#[cfg(not(test))]
async fn handle_leaf_pipeline_event(
    pipeline: &mut LeafPipelineState,
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    group_catalog: &mut GroupCatalog,
    client: Arc<dyn YtDlpClient>,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    ffmpeg_path: &Path,
    cookies_path: Option<PathBuf>,
) -> Result<LeafCommitResult> {
    if !pipeline.ready_downloads.is_empty()
        && pipeline.active_downloads < pipeline.download_window.current_limit()
    {
        spawn_ready_leaf_downloads(
            pipeline,
            task_snapshot,
            source_kind,
            save_root,
            client,
            cookies_path,
        )
        .await?;
        return Ok(LeafCommitResult::default());
    }

    let mut commit_result = drain_ready_leaf_worker_events(
        pipeline,
        task_snapshot,
        collection,
        group_catalog,
        client.clone(),
        source_kind,
        save_root,
        ffmpeg_path,
        cookies_path.clone(),
    )
    .await?;

    if pipeline.active_finalizations < pipeline.finalization_parallelism {
        spawn_ready_leaf_finalizations(pipeline, collection, source_kind, save_root, ffmpeg_path);
    }

    if !pipeline.ready_finalizations.is_empty()
        && pipeline
            .ready_finalizations
            .front()
            .is_some_and(|finalization| matches!(finalization, LeafFinalization::Downloaded(_)))
    {
        let next = finalize_one_ready_leaf(
            pipeline,
            task_snapshot,
            collection,
            source_kind,
            save_root,
            ffmpeg_path,
        )
        .await?;
        merge_leaf_commit_result(&mut commit_result, next);
        return Ok(commit_result);
    }

    if !pipeline.pending_prepares.is_empty()
        && pipeline.active_prepares < pipeline.prepare_parallelism
    {
        spawn_ready_leaf_preparations(pipeline, task_snapshot, client).await?;
        return Ok(commit_result);
    }

    if pipeline.active_prepares == 0
        && pipeline.active_downloads == 0
        && pipeline.active_finalizations == 0
    {
        return Ok(commit_result);
    }

    let event = pipeline
        .workers
        .join_next()
        .await
        .context("download pipeline worker set was unexpectedly empty")?
        .context("download pipeline worker panicked")?;

    let next = handle_leaf_worker_event(
        pipeline,
        task_snapshot,
        collection,
        group_catalog,
        client,
        source_kind,
        save_root,
        ffmpeg_path,
        cookies_path,
        event,
    )
    .await?;
    merge_leaf_commit_result(&mut commit_result, next);
    Ok(commit_result)
}

#[cfg(not(test))]
async fn drain_ready_leaf_worker_events(
    pipeline: &mut LeafPipelineState,
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    group_catalog: &mut GroupCatalog,
    client: Arc<dyn YtDlpClient>,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    ffmpeg_path: &Path,
    cookies_path: Option<PathBuf>,
) -> Result<LeafCommitResult> {
    let mut commit_result = LeafCommitResult::default();
    while let Some(joined) = pipeline.workers.try_join_next() {
        let event = joined.context("download pipeline worker panicked")?;
        let next = handle_leaf_worker_event(
            pipeline,
            task_snapshot,
            collection,
            group_catalog,
            client.clone(),
            source_kind,
            save_root,
            ffmpeg_path,
            cookies_path.clone(),
            event,
        )
        .await?;
        merge_leaf_commit_result(&mut commit_result, next);
    }
    Ok(commit_result)
}

#[cfg(not(test))]
async fn handle_leaf_worker_event(
    pipeline: &mut LeafPipelineState,
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    group_catalog: &mut GroupCatalog,
    client: Arc<dyn YtDlpClient>,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    ffmpeg_path: &Path,
    cookies_path: Option<PathBuf>,
    event: LeafPipelineEvent,
) -> Result<LeafCommitResult> {
    match event {
        LeafPipelineEvent::Prepared(outcome) => {
            pipeline.active_prepares = pipeline.active_prepares.saturating_sub(1);
            handle_prepared_leaf_download(
                pipeline,
                task_snapshot,
                collection,
                group_catalog,
                client,
                source_kind,
                save_root,
                ffmpeg_path,
                cookies_path,
                outcome,
            )
            .await?;
            Ok(LeafCommitResult::default())
        }
        LeafPipelineEvent::Downloaded(outcome) => {
            pipeline.active_downloads = pipeline.active_downloads.saturating_sub(1);
            if let Err(failed) = &outcome
                && is_youtube_cookie_challenge_error_message(&failed.error)
            {
                pause_task_for_youtube_cookie_challenge(
                    task_snapshot,
                    failed.leaf.clone(),
                    failed.error.clone(),
                )
                .await?;
                return Ok(LeafCommitResult::default());
            }

            match &outcome {
                Ok(completed) if completed.retry_failures == 0 => {
                    pipeline.download_window.record_success();
                }
                Ok(completed) => {
                    log::warn!(
                        target: "downloads",
                        "leaf_download_succeeded_after_retries leaf={} retry_failures={} action=reduce_future_parallelism",
                        completed.leaf.id, completed.retry_failures
                    );
                    pipeline.download_window.record_failure();
                }
                Err(_) => {
                    pipeline.download_window.record_failure();
                }
            }
            push_leaf_finalization(
                &mut pipeline.ready_finalizations,
                LeafFinalization::Downloaded(outcome),
            );
            Ok(LeafCommitResult::default())
        }
        LeafPipelineEvent::FinalizedExistingFile(outcome) => {
            pipeline.active_finalizations = pipeline.active_finalizations.saturating_sub(1);
            let commit_result =
                handle_existing_file_finalization_result(task_snapshot, collection, outcome)
                    .await?;
            Ok(commit_result)
        }
    }
}

#[cfg(not(test))]
async fn finalize_one_ready_leaf(
    pipeline: &mut LeafPipelineState,
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    ffmpeg_path: &Path,
) -> Result<LeafCommitResult> {
    let Some(outcome) = pipeline.ready_finalizations.pop_front() else {
        return Ok(LeafCommitResult::default());
    };

    match outcome {
        LeafFinalization::Downloaded(outcome) => {
            handle_finished_leaf_download(
                task_snapshot,
                collection,
                source_kind,
                save_root,
                outcome,
            )
            .await
        }
        LeafFinalization::ExistingFile(completion) => {
            pipeline
                .ready_finalizations
                .push_front(LeafFinalization::ExistingFile(completion));
            spawn_ready_leaf_finalizations(
                pipeline,
                collection,
                source_kind,
                save_root,
                ffmpeg_path,
            );
            Ok(LeafCommitResult::default())
        }
    }
}

#[cfg(not(test))]
async fn handle_existing_file_finalization_result(
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    outcome: ExistingLeafFinalizationOutcome,
) -> Result<LeafCommitResult> {
    match outcome {
        Ok(result) => {
            for failure in result.failed {
                mark_leaf_failed(task_snapshot, failure.completion.leaf, failure.error).await?;
            }
            commit_existing_file_finalizations(
                collection,
                task_snapshot,
                result.persist_changed,
                result.completed,
            )
            .await
        }
        Err(failure) => {
            for probe_failure in failure.probe_failures {
                mark_leaf_failed(
                    task_snapshot,
                    probe_failure.completion.leaf,
                    probe_failure.error,
                )
                .await?;
            }
            for completion in failure.completions {
                mark_leaf_failed(task_snapshot, completion.leaf, failure.error.clone()).await?;
            }
            Ok(LeafCommitResult::default())
        }
    }
}

#[cfg(not(test))]
fn collect_ready_existing_file_finalizations(
    first: ExistingLeafCompletion,
    pipeline: &mut LeafPipelineState,
    batch_limit: usize,
) -> Vec<ExistingLeafBatchCompletion> {
    let mut completions = vec![ExistingLeafBatchCompletion::from(first)];
    while completions.len() < batch_limit
        && matches!(
            pipeline.ready_finalizations.front(),
            Some(LeafFinalization::ExistingFile(_))
        )
    {
        let Some(LeafFinalization::ExistingFile(completion)) =
            pipeline.ready_finalizations.pop_front()
        else {
            break;
        };
        completions.push(ExistingLeafBatchCompletion::from(completion));
    }
    completions
}

#[cfg(not(test))]
fn ready_existing_file_prefix_len(pipeline: &LeafPipelineState) -> usize {
    pipeline
        .ready_finalizations
        .iter()
        .take_while(|finalization| matches!(finalization, LeafFinalization::ExistingFile(_)))
        .count()
}

#[cfg(not(test))]
async fn handle_prepared_leaf_download(
    pipeline: &mut LeafPipelineState,
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    group_catalog: &mut GroupCatalog,
    _client: Arc<dyn YtDlpClient>,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    ffmpeg_path: &Path,
    _cookies_path: Option<PathBuf>,
    outcome: LeafPreparationOutcome,
) -> Result<()> {
    let prepared = match outcome {
        Ok(prepared) => prepared,
        Err(failed) => {
            if is_youtube_cookie_challenge_error_message(&failed.error) {
                pause_task_for_youtube_cookie_challenge(task_snapshot, failed.leaf, failed.error)
                    .await?;
                return Ok(());
            }
            if is_non_retryable_leaf_access_error_message(&failed.error) {
                discard_inaccessible_leaf(task_snapshot, failed.leaf, failed.error).await?;
                return Ok(());
            }
            log::warn!(
                target: "downloads",
                "leaf_prepare_failed leaf={} error=\"{}\"",
                failed.leaf.id, failed.error
            );
            mark_leaf_failed(task_snapshot, failed.leaf, failed.error.clone()).await?;

            if source_kind == CollectionSourceKind::Single {
                let last_error = task_snapshot.last_error.clone();
                update_task_status(task_snapshot, DownloadTaskStatus::Failed, last_error).await?;
            }
            return Ok(());
        }
    };
    log::info!(
        target: "downloads",
        "leaf_prepared leaf={} title=\"{}\" url={} active_prepares={} active_downloads={}",
        prepared.leaf.id,
        prepared.probe.title,
        prepared.url,
        pipeline.active_prepares,
        pipeline.active_downloads
    );

    let group = prepared
        .group
        .clone()
        .or_else(|| group_catalog.resolve(&prepared.probe));

    let mut leaf_snapshot = prepared.leaf;
    leaf_snapshot.title = Some(prepared.probe.title.clone());
    leaf_snapshot.duration_ms = prepared.probe.duration_ms;
    leaf_snapshot.duration_seconds = prepared.probe.duration_seconds;
    leaf_snapshot.chapter_count = Some(prepared.probe.chapters.len() as u32);
    let file_stem = sanitize_path_component(&prepared.probe.title);
    let music_group = resolve_music_group(group.clone(), collection);
    leaf_snapshot.group = Some(DownloadLeafGroupContext::from(music_group.clone()));
    let target_dir = save_root.join(&collection.folder);
    let temp_file_stem = temporary_download_stem(&file_stem, &task_snapshot.id, &leaf_snapshot.id);

    if let Some(relative_path) = collection_import::resolve_existing_leaf_file(
        collection,
        &music_group,
        save_root,
        &file_stem,
    ) {
        let absolute_path = target_dir.join(&relative_path);
        log::info!(
            target: "downloads",
            "leaf_reusing_existing_file leaf={} relative_path=\"{}\"",
            leaf_snapshot.id, relative_path
        );
        push_leaf_finalization(
            &mut pipeline.ready_finalizations,
            LeafFinalization::ExistingFile(ExistingLeafCompletion {
                leaf: leaf_snapshot,
                music_probe: prepared.music_probe,
                group: music_group,
                relative_path,
                absolute_path,
                readiness: prepared.readiness,
            }),
        );
        return Ok(());
    }

    match resolve_residual_temp_downloaded_file(&target_dir, &temp_file_stem) {
        ResidualTempFileResolution::Ready(downloaded_path) => {
            let duration_ms = completed_local_audio_duration_ms(
                ffmpeg_path.to_path_buf(),
                downloaded_path.clone(),
            )
            .await?;
            log::info!(
                target: "downloads",
                "leaf_found_existing_temp_file leaf={} path=\"{}\"",
                leaf_snapshot.id,
                downloaded_path.display()
            );
            push_leaf_finalization(
                &mut pipeline.ready_finalizations,
                LeafFinalization::Downloaded(Ok(CompletedLeafDownload {
                    leaf: leaf_snapshot,
                    probe: prepared.probe,
                    music_probe: prepared.music_probe,
                    group,
                    downloaded: super::yt_dlp::DownloadedLeaf {
                        absolute_path: downloaded_path,
                        duration_ms: Some(duration_ms),
                    },
                    progress: DownloadProgress::default(),
                    retry_failures: 0,
                    readiness: prepared.readiness,
                })),
            );
            return Ok(());
        }
        ResidualTempFileResolution::Ambiguous(candidates) => {
            let candidate_list = candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            mark_leaf_failed(
                task_snapshot,
                leaf_snapshot,
                format!("ambiguous residual temp files for `{temp_file_stem}`: {candidate_list}"),
            )
            .await?;
            return Ok(());
        }
        ResidualTempFileResolution::Missing => {}
    }

    pipeline.ready_downloads.push_back(PreparedLeafDownload {
        leaf: leaf_snapshot,
        probe: prepared.probe,
        music_probe: prepared.music_probe,
        group,
        url: prepared.url,
        readiness: prepared.readiness,
    });
    Ok(())
}

#[cfg(test)]
pub(crate) fn existing_file_completions_from_task_leaves(
    collection: &Collection,
    group_catalog: &GroupCatalog,
    runnable_leaves: &[LeafWorkItem],
    save_root: &Path,
) -> Vec<ExistingLeafBatchCompletion> {
    let mut completions = Vec::new();
    for work_item in runnable_leaves {
        let Some(planned) = work_item.planned.as_ref() else {
            continue;
        };
        let Some(probe) = planned.initial_probe.clone() else {
            continue;
        };

        let mut music_probe = probe.clone();
        if let Some(music_title) = planned.music_title.as_ref() {
            music_probe.title = music_title.clone();
        }
        let group = resolve_music_group(
            planned
                .group_hint
                .clone()
                .or_else(|| group_catalog.resolve(&probe)),
            collection,
        );
        let file_stem = sanitize_path_component(&probe.title);
        let Some(relative_path) = collection_import::resolve_existing_leaf_file(
            collection, &group, save_root, &file_stem,
        ) else {
            continue;
        };

        completions.push(ExistingLeafBatchCompletion {
            leaf: work_item.leaf.clone(),
            music_probe,
            group,
            absolute_path: save_root.join(&collection.folder).join(&relative_path),
            relative_path,
            readiness: work_item.readiness,
        });
    }

    completions
}

#[cfg(not(test))]
async fn commit_existing_file_finalizations(
    collection: &mut Collection,
    task_snapshot: &mut DownloadTask,
    persist_changed: bool,
    completions: Vec<ExistingLeafBatchCompletion>,
) -> Result<LeafCommitResult> {
    if completions.is_empty() {
        return Ok(LeafCommitResult::default());
    }

    let mut post_processing = Vec::new();
    for completion in completions {
        sync_existing_leaf_completion_into_collection(collection, &completion);
        let mut leaf_snapshot = completion.leaf;
        let leaf_id = leaf_snapshot.id.to_string();
        leaf_snapshot.title = Some(completion.music_probe.title.clone());
        leaf_snapshot.file_name = Some(completion.relative_path.clone());
        leaf_snapshot.relative_path = Some(completion.relative_path.clone());
        leaf_snapshot.group = Some(DownloadLeafGroupContext::from(completion.group));
        leaf_snapshot.duration_ms = completion.music_probe.duration_ms;
        leaf_snapshot.duration_seconds = completion.music_probe.duration_seconds;
        leaf_snapshot.chapter_count = Some(completion.music_probe.chapters.len() as u32);
        leaf_snapshot.status = DownloadLeafStatus::Completed;
        leaf_snapshot.last_error = None;
        leaf_snapshot.touch();
        task_snapshot.replace_leaf(leaf_snapshot);

        post_processing.push(CommittedLeafPostProcessing {
            relative_path: completion.relative_path.clone(),
            readiness: completion.readiness,
        });
        log::info!(
            target: "downloads",
            "leaf_completed_existing_file leaf={} relative_path=\"{}\" url={}",
            leaf_id,
            completion.relative_path,
            completion.music_probe.webpage_url
        );
    }

    Ok(LeafCommitResult {
        collection_changed: persist_changed,
        committed_paths: post_processing,
    })
}

#[cfg(not(test))]
fn sync_existing_leaf_completion_into_collection(
    collection: &mut Collection,
    completion: &ExistingLeafBatchCompletion,
) {
    let mut materialized = collection_import::materialize_music_entries(
        &completion.music_probe,
        &completion.relative_path,
        completion.group.clone(),
    );
    let replacement_group_url = materialized.first().map(|music| music.group.url.clone());
    let mut replaced = false;
    let mut next_musics = Vec::with_capacity(collection.musics.len() + materialized.len());
    for music in collection.musics.drain(..) {
        let should_replace = music.url == completion.music_probe.webpage_url
            && replacement_group_url
                .as_ref()
                .is_some_and(|group_url| music.group.url == *group_url);
        if should_replace {
            if !replaced {
                next_musics.append(&mut materialized);
                replaced = true;
            }
        } else {
            next_musics.push(music);
        }
    }
    if !replaced {
        next_musics.append(&mut materialized);
    }
    collection.musics = next_musics;
    collection_import::normalize_music_titles_within_collection(collection);
}

#[cfg(not(test))]
async fn probe_existing_file_batch_durations(
    ffmpeg_path: &Path,
    completions: Vec<ExistingLeafBatchCompletion>,
) -> ExistingLeafDurationProbeOutcome {
    let mut pending = VecDeque::from(completions);
    let mut workers = JoinSet::new();
    let mut completed = Vec::new();
    let mut failed = Vec::new();
    let parallelism = MAX_PARALLEL_EXISTING_FILE_DURATION_PROBES.max(1);

    loop {
        while workers.len() < parallelism {
            let Some(completion) = pending.pop_front() else {
                break;
            };
            let ffmpeg_path = ffmpeg_path.to_path_buf();
            workers.spawn(async move {
                let started = Instant::now();
                log::info!(
                    target: "downloads",
                    "leaf_existing_file_duration_probe_started leaf={} relative_path=\"{}\"",
                    completion.leaf.id,
                    completion.relative_path
                );
                let duration_result = completed_local_audio_duration_ms(
                    ffmpeg_path,
                    completion.absolute_path.clone(),
                )
                .await;
                log::info!(
                    target: "downloads",
                    "leaf_existing_file_duration_probe_finished leaf={} relative_path=\"{}\" status={} elapsed_ms={}",
                    completion.leaf.id,
                    completion.relative_path,
                    if duration_result.is_ok() { "ok" } else { "failed" },
                    started.elapsed().as_millis()
                );
                (completion, duration_result)
            });
        }

        let Some(joined) = workers.join_next().await else {
            break;
        };
        let Ok((mut completion, duration_result)) = joined else {
            continue;
        };
        match duration_result {
            Ok(duration_ms) => {
                apply_completed_audio_duration_evidence(&mut completion.music_probe, duration_ms);
                completed.push(completion);
            }
            Err(error) => {
                let error = error.to_string();
                log::warn!(
                    target: "downloads",
                    "leaf_existing_file_duration_probe_failed leaf={} relative_path=\"{}\" error=\"{}\"",
                    completion.leaf.id,
                    completion.relative_path,
                    error
                );
                failed.push(ExistingLeafProbeFailure { completion, error });
            }
        }
    }

    ExistingLeafDurationProbeOutcome { completed, failed }
}

#[cfg(not(test))]
async fn discard_inaccessible_leaf(
    task_snapshot: &mut DownloadTask,
    leaf: DownloadLeaf,
    error: String,
) -> Result<()> {
    let leaf_id = leaf.id.clone();
    let leaf_url = leaf.url.clone();
    let removed = task_snapshot.remove_leaf(&leaf_id).is_some();
    task_snapshot.last_error = Some(error.clone());
    let saved = repo::save_task(task_snapshot.clone()).await?;
    *task_snapshot = saved;
    log::warn!(
        target: "downloads",
        "leaf_discarded_permanent_access_error leaf={} url={} removed={} error=\"{}\"",
        leaf_id, leaf_url, removed, error
    );
    Ok(())
}

async fn pause_task_for_youtube_cookie_challenge(
    task_snapshot: &mut DownloadTask,
    mut leaf: DownloadLeaf,
    error: String,
) -> Result<()> {
    leaf.status = DownloadLeafStatus::AwaitingCredentials;
    leaf.last_error = Some(error.clone());
    leaf.touch();
    task_snapshot.status = DownloadTaskStatus::AwaitingCredentials;
    task_snapshot.last_error = Some(error);
    task_snapshot.replace_leaf(leaf);
    let saved = repo::save_task(task_snapshot.clone()).await?;
    publish_download_task_change(&saved);
    *task_snapshot = saved;
    Ok(())
}

async fn pause_task_for_youtube_cookie_challenge_without_leaf(
    task_snapshot: &mut DownloadTask,
    error: String,
) -> Result<()> {
    task_snapshot.status = DownloadTaskStatus::AwaitingCredentials;
    task_snapshot.last_error = Some(error);
    task_snapshot.touch();
    let saved = repo::save_task(task_snapshot.clone()).await?;
    publish_download_task_change(&saved);
    *task_snapshot = saved;
    Ok(())
}

#[cfg(not(test))]
async fn spawn_ready_leaf_downloads(
    pipeline: &mut LeafPipelineState,
    task_snapshot: &mut DownloadTask,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    client: Arc<dyn YtDlpClient>,
    cookies_path: Option<PathBuf>,
) -> Result<()> {
    while pipeline.active_downloads < pipeline.download_window.current_limit() {
        let Some(prepared) = pipeline.ready_downloads.pop_front() else {
            break;
        };

        let mut leaf_snapshot = prepared.leaf;
        leaf_snapshot.status = DownloadLeafStatus::Downloading;
        leaf_snapshot.touch();
        task_snapshot.replace_leaf(leaf_snapshot.clone());

        let file_stem = sanitize_path_component(&prepared.probe.title);
        let target_dir = save_root.join(
            task_snapshot
                .collection_folder
                .as_deref()
                .context("download task is missing collection folder")?,
        );
        let temp_file_stem =
            temporary_download_stem(&file_stem, &task_snapshot.id, &leaf_snapshot.id);
        log::info!(
            target: "downloads",
            "leaf_download_queued leaf={} sequence={} source_kind={} active_downloads={} parallelism={} temp_stem=\"{}\" target_dir=\"{}\"",
            leaf_snapshot.id,
            leaf_snapshot.sequence,
            source_kind.as_str(),
            pipeline.active_downloads + 1,
            pipeline.download_window.current_limit(),
            temp_file_stem,
            target_dir.display()
        );

        pipeline.workers.spawn(download_leaf_audio_worker(
            client.clone(),
            LeafDownloadInput {
                leaf: leaf_snapshot,
                probe: prepared.probe,
                music_probe: prepared.music_probe,
                group: prepared.group,
                url: prepared.url,
                target_dir,
                temp_file_stem,
                cookies_path: cookies_path.clone(),
                readiness: prepared.readiness,
            },
        ));
        pipeline.active_downloads += 1;
    }

    Ok(())
}

#[cfg(test)]
pub(crate) async fn handle_finished_leaf_download(
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    outcome: LeafDownloadOutcome,
) -> Result<()> {
    handle_finished_leaf_download_for_test(
        task_snapshot,
        collection,
        source_kind,
        save_root,
        outcome,
    )
    .await
}

pub(crate) fn resolve_residual_temp_downloaded_file(
    target_dir: &Path,
    temp_file_stem: &str,
) -> ResidualTempFileResolution {
    let candidates = residual_temp_downloaded_files(target_dir, temp_file_stem);
    match candidates.len() {
        0 => ResidualTempFileResolution::Missing,
        1 => ResidualTempFileResolution::Ready(candidates[0].clone()),
        _ => ResidualTempFileResolution::Ambiguous(candidates),
    }
}

fn residual_temp_downloaded_files(target_dir: &Path, temp_file_stem: &str) -> Vec<PathBuf> {
    let Some(entries) = std::fs::read_dir(target_dir).ok() else {
        return vec![];
    };
    let stable_stem = stable_stem_from_temp_stem(temp_file_stem);
    let expected_marker = temp_marker_from_stem(temp_file_stem);
    let mut exact = Vec::new();
    let mut stable = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !is_residual_temp_download_candidate(&path) {
            continue;
        }

        let stem = match path.file_stem().and_then(|value| value.to_str()) {
            Some(stem) => stem,
            None => continue,
        };
        if stem == temp_file_stem {
            exact.push(path);
            continue;
        }

        if !stem.contains(".__slisic_tmp__") {
            continue;
        }
        let Some(stem_stable) = stable_stem_from_temp_stem(stem) else {
            continue;
        };
        if Some(stem_stable) != stable_stem {
            continue;
        }
        if let Some(marker) = expected_marker
            && stem.contains(marker)
        {
            exact.push(path);
        } else {
            stable.push(path);
        }
    }

    exact.sort();
    stable.sort();
    if !exact.is_empty() { exact } else { stable }
}

fn is_residual_temp_download_candidate(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()) != Some("part")
}

fn stable_stem_from_temp_stem(stem: &str) -> Option<&str> {
    let (stable, suffix) = stem.rsplit_once(".__slisic_tmp__")?;
    (!stable.is_empty() && !suffix.is_empty()).then_some(stable)
}

fn temp_marker_from_stem(stem: &str) -> Option<&str> {
    let (_, suffix) = stem.rsplit_once(".__slisic_tmp__")?;
    (!suffix.is_empty()).then_some(suffix)
}

#[cfg(not(test))]
async fn handle_finished_leaf_download(
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    outcome: LeafDownloadOutcome,
) -> Result<LeafCommitResult> {
    let completed = match outcome {
        Ok(completed) => completed,
        Err(failed) => {
            log::warn!(
                target: "downloads",
                "leaf_download_failed leaf={} error=\"{}\"",
                failed.leaf.id, failed.error
            );
            mark_leaf_failed(task_snapshot, failed.leaf, failed.error.clone()).await?;

            if source_kind == CollectionSourceKind::Single {
                let last_error = task_snapshot.last_error.clone();
                update_task_status(task_snapshot, DownloadTaskStatus::Failed, last_error).await?;
            }
            return Ok(LeafCommitResult::default());
        }
    };

    let mut leaf_snapshot = completed.leaf;
    let readiness = completed.readiness;
    let file_stem = sanitize_path_component(&completed.probe.title);
    let music_group = resolve_music_group(completed.group, collection);
    let mut music_probe = completed.music_probe;
    let downloaded = completed.downloaded;
    let downloaded_path = downloaded.absolute_path;
    if let Some(duration_ms) = downloaded.duration_ms {
        apply_completed_audio_duration_evidence(&mut music_probe, duration_ms);
        leaf_snapshot.duration_ms = music_probe.duration_ms;
        leaf_snapshot.duration_seconds = music_probe.duration_seconds;
    }
    let (file_name, persist_changed) = match persist_completed_leaf_download(
        collection,
        source_kind,
        &completed.probe.webpage_url,
        &music_probe,
        &music_group,
        save_root,
        &file_stem,
        downloaded_path.clone(),
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            let error = error.to_string();
            log::warn!(
                target: "downloads",
                "leaf_persist_failed leaf={} downloaded_path=\"{}\" error=\"{}\"",
                leaf_snapshot.id,
                downloaded_path.display(),
                error
            );
            mark_leaf_failed(task_snapshot, leaf_snapshot, error).await?;
            return Ok(LeafCommitResult::default());
        }
    };

    let leaf_id = leaf_snapshot.id.to_string();
    leaf_snapshot.file_name = Some(file_name.clone());
    leaf_snapshot.relative_path = Some(file_name.clone());
    leaf_snapshot.downloaded_bytes = completed.progress.downloaded_bytes;
    leaf_snapshot.total_bytes = completed.progress.total_bytes;
    leaf_snapshot.speed_bytes_per_second = completed.progress.speed_bytes_per_second;
    leaf_snapshot.eta_seconds = completed.progress.eta_seconds;

    leaf_snapshot.status = DownloadLeafStatus::Completed;
    leaf_snapshot.last_error = None;
    leaf_snapshot.touch();
    task_snapshot.replace_leaf(leaf_snapshot.clone());
    let saved = repo::save_task(task_snapshot.clone()).await?;
    publish_download_task_change(&saved);
    *task_snapshot = saved;

    log::info!(
        target: "downloads",
        "leaf_completed leaf={} file=\"{}\"",
        leaf_id,
        file_name
    );
    Ok(LeafCommitResult {
        collection_changed: persist_changed,
        committed_paths: vec![CommittedLeafPostProcessing {
            relative_path: file_name,
            readiness,
        }],
    })
}

#[cfg(test)]
async fn handle_finished_leaf_download_for_test(
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    outcome: LeafDownloadOutcome,
) -> Result<()> {
    let completed = match outcome {
        Ok(completed) => completed,
        Err(failed) => {
            mark_leaf_failed(task_snapshot, failed.leaf, failed.error).await?;
            return Ok(());
        }
    };

    let mut leaf_snapshot = completed.leaf;
    let file_stem = sanitize_path_component(&completed.probe.title);
    let music_group = resolve_music_group(completed.group, collection);
    let mut music_probe = completed.music_probe;
    let downloaded = completed.downloaded;
    let downloaded_path = downloaded.absolute_path;
    if let Some(duration_ms) = downloaded.duration_ms {
        apply_completed_audio_duration_evidence(&mut music_probe, duration_ms);
        leaf_snapshot.duration_ms = music_probe.duration_ms;
        leaf_snapshot.duration_seconds = music_probe.duration_seconds;
    }
    let (file_name, _persist_changed) = match persist_completed_leaf_download(
        collection,
        source_kind,
        &completed.probe.webpage_url,
        &music_probe,
        &music_group,
        save_root,
        &file_stem,
        downloaded_path,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            mark_leaf_failed(task_snapshot, leaf_snapshot, error.to_string()).await?;
            return Ok(());
        }
    };

    leaf_snapshot.file_name = Some(file_name.clone());
    leaf_snapshot.relative_path = Some(file_name);
    leaf_snapshot.downloaded_bytes = completed.progress.downloaded_bytes;
    leaf_snapshot.total_bytes = completed.progress.total_bytes;
    leaf_snapshot.speed_bytes_per_second = completed.progress.speed_bytes_per_second;
    leaf_snapshot.eta_seconds = completed.progress.eta_seconds;
    leaf_snapshot.status = DownloadLeafStatus::Completed;
    leaf_snapshot.last_error = None;
    leaf_snapshot.touch();
    task_snapshot.replace_leaf(leaf_snapshot);
    let saved = repo::save_task(task_snapshot.clone()).await?;
    *task_snapshot = saved;
    Ok(())
}

async fn persist_completed_leaf_download(
    collection: &mut Collection,
    source_kind: CollectionSourceKind,
    leaf_url: &str,
    music_probe: &LeafProbe,
    music_group: &Group,
    save_root: &Path,
    file_stem: &str,
    downloaded_path: PathBuf,
) -> Result<(String, bool)> {
    log::info!(
        target: "downloads",
        "finalize_leaf url={} downloaded_path=\"{}\" file_stem=\"{}\" group_url={}",
        leaf_url,
        downloaded_path.display(),
        file_stem,
        music_group.url
    );
    let file_name = collection_import::finalize_downloaded_leaf(
        collection,
        leaf_url,
        music_group,
        save_root,
        file_stem,
        downloaded_path,
    )?;
    log::info!(
        target: "downloads",
        "persist_music_leaf url={} relative_path=\"{}\"",
        leaf_url, file_name
    );
    let persist_outcome = collection_import::persist_downloaded_leaf_music(
        collection,
        source_kind,
        save_root,
        music_probe,
        &file_name,
        music_group.clone(),
    )
    .await
    .with_context(|| format!("failed to persist downloaded music for {leaf_url}"))?;
    write_collection_manifest_after_download(
        save_root,
        collection,
        source_kind,
        music_probe,
        &file_name,
    )
    .with_context(|| format!("failed to write collection manifest for {leaf_url}"))?;
    log::info!(
        target: "downloads",
        "manifest_updated collection_folder=\"{}\" relative_path=\"{}\"",
        collection.folder, file_name
    );

    Ok((file_name, persist_outcome.changed))
}

async fn mark_leaf_failed(
    task_snapshot: &mut DownloadTask,
    mut leaf_snapshot: DownloadLeaf,
    error: String,
) -> Result<()> {
    leaf_snapshot.status = DownloadLeafStatus::Failed;
    leaf_snapshot.last_error = Some(error.clone());
    leaf_snapshot.touch();
    task_snapshot.last_error = Some(error);
    task_snapshot.replace_leaf(leaf_snapshot);
    let saved = repo::save_task(task_snapshot.clone()).await?;
    publish_download_task_change(&saved);
    *task_snapshot = saved;
    Ok(())
}

#[cfg(not(test))]
fn request_committed_leaf_post_processing(
    collection: &Collection,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    committed: &[CommittedLeafPostProcessing],
) {
    if committed.is_empty() {
        return;
    }

    request_committed_leaf_loudness_evidence_batch(collection, save_root, committed);
    request_committed_leaf_audio_tail_trim_batch(collection, source_kind, save_root, committed);
}

#[cfg(not(test))]
fn request_committed_leaf_loudness_evidence_batch(
    collection: &Collection,
    save_root: &Path,
    committed: &[CommittedLeafPostProcessing],
) {
    let path_readiness = committed_path_readiness(committed);
    let mut path_matches = 0usize;
    let mut queued = 0usize;
    let mut skipped_has_profile = 0usize;
    let mut skipped_invalid_range = 0usize;
    let mut skipped_missing_file = 0usize;
    for music in collection.musics.iter().filter(|music| {
        music
            .path
            .as_deref()
            .is_some_and(|path| path_readiness.contains_key(path))
    }) {
        path_matches += 1;
        if music.loudness_profile.is_some() {
            skipped_has_profile += 1;
            continue;
        }
        if music.start_ms >= music.end_ms {
            skipped_invalid_range += 1;
            continue;
        }
        let Some(relative_path) = music.path.as_deref() else {
            continue;
        };
        let file_path = save_root.join(&collection.folder).join(relative_path);
        if !file_path.is_file() {
            skipped_missing_file += 1;
            continue;
        }
        let request = LoudnessEvidenceRequest {
            canonical_music_id: music.canonical_music_id.clone(),
            url: music.url.clone(),
            file_path,
            start_ms: music.start_ms,
            end_ms: music.end_ms,
        };
        match path_readiness
            .get(relative_path)
            .copied()
            .unwrap_or(LeafReadinessCargo::Background)
        {
            LeafReadinessCargo::Background => {
                loudness_evidence::request_downloaded_leaf_loudness_evidence(request);
            }
            LeafReadinessCargo::Foreground => {
                loudness_evidence::request_downloaded_leaf_foreground_loudness_evidence(request);
            }
        }
        queued += 1;
    }

    log::info!(
        target: "downloads",
        "downloaded_leaf_loudness_evidence_batch_scanned collection=\"{}\" paths={} musics={} path_matches={} queued={} skipped_has_profile={} skipped_invalid_range={} skipped_missing_file={}",
        collection.url,
        path_readiness.len(),
        collection.musics.len(),
        path_matches,
        queued,
        skipped_has_profile,
        skipped_invalid_range,
        skipped_missing_file
    );
}

#[cfg(not(test))]
fn request_committed_leaf_audio_tail_trim_batch(
    collection: &Collection,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    committed: &[CommittedLeafPostProcessing],
) {
    let path_readiness = committed_path_readiness(committed);
    let mut trim_requests = HashMap::<String, (Option<String>, LeafReadinessCargo, usize)>::new();
    for music in collection.musics.iter().filter(|music| {
        music
            .path
            .as_deref()
            .is_some_and(|path| path_readiness.contains_key(path))
    }) {
        let readiness = music
            .path
            .as_deref()
            .and_then(|path| path_readiness.get(path))
            .copied()
            .unwrap_or(LeafReadinessCargo::Background);
        let entry = trim_requests.entry(music.group.url.clone()).or_insert((
            Some(music.group.url.clone()),
            readiness,
            0,
        ));
        if readiness.priority() > entry.1.priority() {
            entry.1 = readiness;
        }
        entry.2 += 1;
    }

    if trim_requests.is_empty() {
        log::info!(
            target: "downloads",
            "downloaded_leaf_audio_tail_trim_batch_skipped collection=\"{}\" paths={} reason=no_matching_music musics={}",
            collection.url,
            path_readiness.len(),
            collection.musics.len()
        );
        return;
    }

    for (_, (scope_group_url, readiness, matching_musics)) in trim_requests {
        log::info!(
            target: "downloads",
            "downloaded_leaf_audio_tail_trim_batch_requested collection=\"{}\" source_kind={} matching_musics={} scope_group=\"{}\"",
            collection.url,
            source_kind.as_str(),
            matching_musics,
            scope_group_url.as_deref().unwrap_or("")
        );
        let request = AudioTailTrimRequest {
            collection_url: collection.url.clone(),
            source_kind,
            save_root: save_root.to_path_buf(),
            scope_group_url,
            focus_music: None,
        };
        match readiness {
            LeafReadinessCargo::Background => {
                audio_tail_trim::request_downloaded_leaf_audio_tail_trim(request);
            }
            LeafReadinessCargo::Foreground => {
                audio_tail_trim::request_downloaded_leaf_foreground_audio_tail_trim(request);
            }
        }
    }
}

#[cfg(not(test))]
fn committed_path_readiness(
    committed: &[CommittedLeafPostProcessing],
) -> HashMap<String, LeafReadinessCargo> {
    let mut readiness_by_path = HashMap::new();
    for item in committed {
        readiness_by_path
            .entry(item.relative_path.clone())
            .and_modify(|readiness: &mut LeafReadinessCargo| {
                if item.readiness.priority() > readiness.priority() {
                    *readiness = item.readiness;
                }
            })
            .or_insert(item.readiness);
    }
    readiness_by_path
}

fn write_collection_manifest_after_download(
    save_root: &Path,
    collection: &Collection,
    source_kind: CollectionSourceKind,
    probe: &LeafProbe,
    relative_path: &str,
) -> Result<()> {
    let collection_root = save_root.join(&collection.folder);
    let Some(group) = collection
        .musics
        .iter()
        .find(|music| {
            music.url == probe.webpage_url && music.path.as_deref() == Some(relative_path)
        })
        .map(|music| music.group.clone())
    else {
        bail!(
            "downloaded raw manifest evidence target not found for {} at {}",
            probe.webpage_url,
            relative_path
        );
    };
    collection_import::write_raw_leaf_manifest_evidence(
        &collection_root,
        collection,
        source_kind,
        probe,
        relative_path,
        &group,
    )
}

#[cfg(not(test))]
fn temporary_download_stem(file_stem: &str, task_id: &Id, leaf_id: &Id) -> String {
    format!(
        "{file_stem}.__slisic_tmp__{}",
        short_hash(&format!("{task_id}|{leaf_id}"))
    )
}

async fn update_task_status(
    task: &mut DownloadTask,
    status: DownloadTaskStatus,
    last_error: Option<String>,
) -> Result<()> {
    task.status = status;
    task.last_error = last_error;
    task.touch();
    task.refresh_counts();
    let saved = repo::save_task(task.clone()).await?;
    publish_download_task_change(&saved);
    *task = saved;
    Ok(())
}

async fn mark_task_failed(task_id: &str, error: String) -> Result<()> {
    let mut task = repo::get_task(task_id).await?;
    update_task_status(&mut task, DownloadTaskStatus::Failed, Some(error)).await
}

#[cfg(not(test))]
fn runtime() -> Result<&'static DownloadRuntime> {
    DOWNLOAD_RUNTIME
        .get()
        .context("download runtime has not been initialized")
}

#[cfg(not(test))]
fn resolve_title_probe_client() -> Result<Arc<dyn YtDlpClient>> {
    let app = &runtime()?.app;
    let ytdlp_path =
        ensure_managed_binary(app, ManagedBinary::YtDlp).map_err(|error| anyhow!(error))?;
    let ffmpeg_dir = ytdlp_path
        .parent()
        .map(Path::to_path_buf)
        .context("managed yt-dlp path has no parent directory")?;

    Ok(Arc::new(CliYtDlpClient::new(ytdlp_path, ffmpeg_dir)))
}

#[cfg(test)]
fn resolve_title_probe_client() -> Result<Arc<dyn YtDlpClient>> {
    bail!("test callers must inject a root title probe client")
}

#[cfg(not(test))]
pub(crate) fn try_claim_task(task_id: &str) -> Result<bool> {
    let runtime = runtime()?;
    let mut active = runtime
        .active_task_ids
        .lock()
        .map_err(|_| anyhow!("download runtime task set is poisoned"))?;
    Ok(active.insert(task_id.to_string()))
}

fn pending_enqueue_urls() -> &'static Mutex<HashSet<String>> {
    PENDING_ENQUEUE_URLS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(crate) fn try_claim_enqueue_url(url: &str) -> Result<Option<PendingEnqueueUrlGuard>> {
    let mut active = pending_enqueue_urls()
        .lock()
        .map_err(|_| anyhow!("pending enqueue url set is poisoned"))?;
    if !active.insert(url.to_string()) {
        return Ok(None);
    }

    Ok(Some(PendingEnqueueUrlGuard {
        url: url.to_string(),
    }))
}

#[cfg(not(test))]
pub(crate) fn release_task(task_id: &str) {
    if let Some(runtime) = DOWNLOAD_RUNTIME.get()
        && let Ok(mut active) = runtime.active_task_ids.lock()
    {
        active.remove(task_id);
    }
}

#[cfg(not(test))]
struct ActiveDownloadTaskClaim {
    task_id: String,
}

#[cfg(not(test))]
impl ActiveDownloadTaskClaim {
    fn new(task_id: String) -> Self {
        Self { task_id }
    }
}

#[cfg(not(test))]
impl Drop for ActiveDownloadTaskClaim {
    fn drop(&mut self) {
        release_task(&self.task_id);
    }
}

#[cfg(not(test))]
fn download_task_change_sender() -> &'static broadcast::Sender<DownloadTaskChangeSignal> {
    DOWNLOAD_TASK_CHANGES.get_or_init(|| broadcast::channel(64).0)
}

#[cfg(not(test))]
pub(crate) fn publish_download_task_change(task: &DownloadTask) {
    let credential_request = if task.status == DownloadTaskStatus::AwaitingCredentials {
        Some(DownloadCredentialRequestSignal {
            provider: "youtube".to_string(),
            reason: task
                .last_error
                .as_deref()
                .map(summarize_youtube_cookie_challenge_reason)
                .unwrap_or_else(|| "YouTube needs cookies to continue this download.".to_string()),
        })
    } else {
        None
    };
    let signal = DownloadTaskChangeSignal {
        task_id: task.id.to_string(),
        task_url: task.url.clone(),
        collection_url: task.collection_url.clone(),
        collection_name: task.collection_name.clone(),
        status: task.status,
        last_error: task.last_error.clone(),
        credential_request,
    };
    if let Ok(runtime) = runtime() {
        let _ = signal.emit(&runtime.app);
    }
    let _ = download_task_change_sender().send(signal);
}

#[cfg(test)]
fn publish_download_task_change(_task: &DownloadTask) {}

fn summarize_youtube_cookie_challenge_reason(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("confirm you're not a bot") {
        return "YouTube wants a bot confirmation before continuing.".to_string();
    }
    if lower.contains("confirm your age") {
        return "YouTube wants age confirmation before continuing.".to_string();
    }
    "YouTube needs cookies to continue this download.".to_string()
}

#[cfg(not(test))]
fn spawn_recovery(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("download-recovery".to_string())
        .spawn(move || {
            tauri::async_runtime::block_on(async move {
                match recover_incomplete_download_tasks().await {
                    Ok(recovered) if recovered > 0 => {
                        log::info!(
                            target: "downloads",
                            "incomplete_download_tasks_resumed count={}",
                            recovered
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        log::error!(
                            target: "downloads",
                            "incomplete_download_tasks_resume_failed error=\"{}\"",
                            error
                        );
                    }
                }

                match resolve_save_root(&app).await {
                    Ok(save_root) => {
                        match collection_import::repair_stale_single_source_collections(&save_root)
                            .await
                        {
                            Ok(repaired) if repaired > 0 => {
                                log::info!(
                                    target: "downloads",
                                    "stale_single_source_collections_repaired count={}",
                                    repaired
                                );
                            }
                            Ok(_) => {}
                            Err(error) => {
                                log::error!(
                                    target: "downloads",
                                    "stale_single_source_collections_repair_failed error=\"{}\"",
                                    error
                                );
                            }
                        }
                    }
                    Err(error) => {
                        log::error!(
                            target: "downloads",
                            "recovery_save_root_resolve_failed error=\"{}\"",
                            error
                        );
                    }
                }

                if let Err(error) = run_auto_update_cycle().await {
                    log::error!(
                        target: "downloads",
                        "initial_auto_update_failed error=\"{}\"",
                        error
                    );
                }
            });
        });
}

#[cfg(not(test))]
pub(crate) async fn recover_incomplete_download_tasks() -> Result<usize> {
    let tasks = repo::list_tasks().await?;
    let mut recovered = 0_usize;

    for mut task in tasks {
        if should_interrupt_unresumable_active_task_after_restart(&task) {
            task.mark_interrupted();
            let last_error = task.last_error.clone();
            update_task_status(&mut task, DownloadTaskStatus::Interrupted, last_error).await?;
            continue;
        }

        if !should_recover_download_task_after_restart(&task) {
            continue;
        }

        if task.status == DownloadTaskStatus::Interrupted {
            let last_error = task.last_error.clone();
            update_task_status(&mut task, DownloadTaskStatus::Queued, last_error).await?;
        }

        spawn_task(task.id.to_string(), None)?;
        recovered += 1;
    }

    Ok(recovered)
}

#[cfg(not(test))]
fn spawn_auto_update_loop(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("download-auto-update".to_string())
        .spawn(move || {
            loop {
                thread::sleep(AUTO_UPDATE_INTERVAL);
                tauri::async_runtime::block_on(async {
                    if let Err(error) = run_auto_update_cycle().await {
                        log::error!(
                            target: "downloads",
                            "auto_update_failed error=\"{}\"",
                            error
                        );
                    }
                });
                let _ = &app;
            }
        });
}

#[cfg(not(test))]
async fn run_auto_update_cycle() -> Result<()> {
    let mut errors = Vec::new();
    for collection_url in collection_import::list_auto_update_collection_urls().await? {
        if let Err(error) = enqueue_collection_download_with_trigger(
            collection_url.clone(),
            DownloadTrigger::AutoUpdate,
        )
        .await
        {
            errors.push(format!("{collection_url}: {error}"));
        }
    }

    if !errors.is_empty() {
        bail!(
            "auto update cycle completed with errors: {}",
            errors.join("; ")
        );
    }

    Ok(())
}

pub(crate) fn apply_completed_audio_duration_evidence(probe: &mut LeafProbe, duration_ms: u32) {
    let previous_duration_ms = probe.duration_ms.or_else(|| {
        probe
            .duration_seconds
            .map(|seconds| seconds.saturating_mul(1_000))
    });

    probe.duration_ms = Some(duration_ms);
    probe.duration_seconds = Some(duration_ms.div_ceil(1_000));

    let Some(previous_duration_ms) = previous_duration_ms else {
        return;
    };

    for chapter in &mut probe.chapters {
        if audio_duration_boundary_matches(chapter.end_ms, previous_duration_ms) {
            chapter.end_ms = duration_ms;
        }
    }
}

#[cfg(not(test))]
async fn completed_local_audio_duration_ms(
    ffmpeg_path: PathBuf,
    file_path: PathBuf,
) -> Result<u32> {
    let usage = acquire_downloads_ffmpeg_probe_usage();
    run_blocking(move || {
        let _usage = usage;
        probe_downloaded_audio_duration_ms(&ffmpeg_path, &file_path)?.with_context(|| {
            format!(
                "local audio file has no playable audio stream: {}",
                file_path.display()
            )
        })
    })
    .await
}

#[cfg(not(test))]
fn build_client(app: &AppHandle, ffmpeg_path: &Path) -> Result<Arc<dyn YtDlpClient>> {
    let ytdlp_path =
        ensure_managed_binary(app, ManagedBinary::YtDlp).map_err(|error| anyhow!(error))?;
    let ffmpeg_dir = ffmpeg_path
        .parent()
        .map(Path::to_path_buf)
        .context("managed ffmpeg binary path is missing a parent directory")?;

    Ok(Arc::new(CliYtDlpClient::new(ytdlp_path, ffmpeg_dir)))
}

#[cfg(not(test))]
async fn resolve_save_root(app: &AppHandle) -> Result<PathBuf> {
    meta_service::resolve_save_root(app).await
}

#[cfg(not(test))]
async fn resolve_execution_deps(app: &AppHandle) -> Result<DownloadExecutionDeps> {
    let ffmpeg_path =
        ensure_managed_binary(app, ManagedBinary::Ffmpeg).map_err(|error| anyhow!(error))?;
    let client = build_client(app, &ffmpeg_path)?;
    Ok(DownloadExecutionDeps {
        client,
        ffmpeg_path,
        save_root: resolve_save_root(app).await?,
        cookies_path: {
            let mut path = app
                .path()
                .app_local_data_dir()
                .map_err(|error| anyhow!("failed to resolve app local data directory: {error}"))?;
            path.push("credentials");
            path.push("youtube.cookies.txt");
            path.exists().then_some(path)
        },
    })
}

async fn run_blocking<T>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T>
where
    T: Send + 'static,
{
    task::spawn_blocking(work)
        .await
        .context("blocking download task panicked")?
}

#[cfg(not(test))]
fn acquire_downloads_ytdlp_probe_usage() -> crate::utils::binaries::ManagedBinaryUsageGuard {
    acquire_managed_binary_usage(ManagedBinary::YtDlp, "downloads_probe")
}

#[cfg(test)]
fn acquire_downloads_ytdlp_probe_usage() {}

#[cfg(not(test))]
fn acquire_downloads_ytdlp_download_usage() -> crate::utils::binaries::ManagedBinaryUsageGuard {
    acquire_managed_binary_usage(ManagedBinary::YtDlp, "downloads_download")
}

#[cfg(test)]
fn acquire_downloads_ytdlp_download_usage() {}

#[cfg(not(test))]
fn acquire_downloads_ffmpeg_download_usage() -> crate::utils::binaries::ManagedBinaryUsageGuard {
    acquire_managed_binary_usage(ManagedBinary::Ffmpeg, "downloads_download")
}

#[cfg(test)]
fn acquire_downloads_ffmpeg_download_usage() {}

#[cfg(not(test))]
fn acquire_downloads_ffmpeg_probe_usage() -> crate::utils::binaries::ManagedBinaryUsageGuard {
    acquire_managed_binary_usage(ManagedBinary::Ffmpeg, "downloads_probe")
}

#[cfg(test)]
fn acquire_downloads_ffmpeg_probe_usage() {}

#[cfg(test)]
pub(crate) fn leaf_download_parallelism(
    source_kind: CollectionSourceKind,
    leaf_count: usize,
) -> usize {
    LeafDownloadWindow::for_collection(source_kind, leaf_count).current_limit()
}

pub(crate) fn should_resume_download_task_after_restart(status: DownloadTaskStatus) -> bool {
    status.is_active() || status == DownloadTaskStatus::Interrupted
}

pub(crate) fn should_recover_download_task_after_restart(task: &DownloadTask) -> bool {
    task.trigger != DownloadTrigger::LocalImport
        && should_resume_download_task_after_restart(task.status)
}

pub(crate) fn should_interrupt_unresumable_active_task_after_restart(task: &DownloadTask) -> bool {
    task.trigger == DownloadTrigger::LocalImport && task.status.is_active()
}

impl GroupCatalog {
    pub(crate) fn seed(collection: &Collection) -> Self {
        let mut catalog = Self::default();
        catalog.extend(collection.musics.iter().map(|music| music.group.clone()));
        catalog
    }

    fn extend(&mut self, groups: impl IntoIterator<Item = Group>) {
        for group in groups {
            let Some(key) = normalize_group_key(&group.name) else {
                continue;
            };

            if self.ambiguous.contains(&key) {
                continue;
            }

            match self.groups.get(&key) {
                None => {
                    self.groups.insert(key, group);
                }
                Some(existing) if existing.url == group.url => {}
                Some(_) => {
                    self.groups.remove(&key);
                    self.ambiguous.insert(key);
                }
            }
        }
    }

    fn resolve(&self, probe: &LeafProbe) -> Option<Group> {
        let key = normalize_group_key(probe.album.as_deref()?)?;
        self.groups.get(&key).cloned()
    }
}

fn resolve_music_group(group: Option<Group>, collection: &Collection) -> Group {
    group
        .unwrap_or_else(|| Group {
            name: collection.name.clone(),
            url: collection.url.clone(),
            collection: collection.into(),
            folder: collection.folder.clone(),
        })
        .bind_collection(collection)
}

fn normalize_group_key(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.to_lowercase())
    }
}

pub(crate) struct PendingEnqueueUrlGuard {
    url: String,
}

impl Drop for PendingEnqueueUrlGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = pending_enqueue_urls().lock() {
            active.remove(&self.url);
        }
    }
}
