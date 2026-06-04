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
    DownloadProgress, LeafProbe, RootProbe, YtDlpClient, classify_root_preference,
};
use crate::domain::collection_import;
use crate::domain::collection_import::CollectionShellPlan;
#[cfg(not(test))]
use crate::domain::collection_import::{CollectionSyncPlan, PlannedLeaf};
#[cfg(not(test))]
use crate::domain::meta::service as meta_service;
#[cfg(not(test))]
use crate::domain::player::event::{PlaybackDiagnosticTraceDetail, PlaybackDiagnosticTraceEvent};
use crate::domain::playlists::model::{Collection, Group};
#[cfg(not(test))]
use crate::domain::playlists::repo as playlists_repo;
#[cfg(not(test))]
use crate::utils::binaries::{ManagedBinary, ensure_managed_binary};
use anyhow::{Context, Result, anyhow, bail};
#[cfg(not(test))]
use appdb::Id;
#[cfg(not(test))]
use serde::{Deserialize, Serialize};
#[cfg(not(test))]
use specta::Type;
#[cfg(not(test))]
use std::collections::VecDeque;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(not(test))]
use std::thread;
use std::time::{Duration, Instant};
#[cfg(not(test))]
use tauri::AppHandle;
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
#[cfg(not(test))]
const MAX_PARALLEL_LOUDNESS_MEASUREMENTS: usize = 4;
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
    active_binary_tasks: AtomicUsize,
}

#[cfg(not(test))]
struct ActiveBinaryTaskGuard {
    runtime: &'static DownloadRuntime,
}

#[cfg(not(test))]
impl ActiveBinaryTaskGuard {
    fn new(runtime: &'static DownloadRuntime) -> Self {
        runtime.active_binary_tasks.fetch_add(1, Ordering::SeqCst);
        Self { runtime }
    }
}

#[cfg(not(test))]
impl Drop for ActiveBinaryTaskGuard {
    fn drop(&mut self) {
        self.runtime
            .active_binary_tasks
            .fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone)]
pub(crate) enum PreparedTaskEnqueue {
    Existing(DownloadTask),
    New(DownloadTask),
}

#[derive(Debug, Default, Clone)]
struct GroupCatalog {
    groups: HashMap<String, Group>,
    ambiguous: HashSet<String>,
}

#[derive(Clone)]
struct DownloadExecutionDeps {
    client: Arc<dyn YtDlpClient>,
    #[cfg(not(test))]
    ffmpeg_path: PathBuf,
    save_root: PathBuf,
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
}

#[cfg(not(test))]
struct LeafPreparationInput {
    leaf: DownloadLeaf,
    planned: PlannedLeaf,
}

#[cfg(not(test))]
#[derive(Debug)]
struct PreparedLeafDownload {
    leaf: DownloadLeaf,
    probe: LeafProbe,
    music_probe: LeafProbe,
    group: Option<Group>,
    url: String,
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
}

pub(crate) fn leaf_pipeline_has_work(
    active_prepares: usize,
    active_downloads: usize,
    pending_prepares: usize,
    ready_downloads: usize,
    ready_finalizations: usize,
) -> bool {
    active_prepares > 0
        || active_downloads > 0
        || pending_prepares > 0
        || ready_downloads > 0
        || ready_finalizations > 0
}

#[cfg(test)]
pub(crate) fn leaf_pipeline_next_stage(
    active_prepares: usize,
    active_downloads: usize,
    ready_downloads: usize,
    ready_finalizations: usize,
    download_limit: usize,
) -> LeafPipelineStage {
    if ready_finalizations > 0 {
        return LeafPipelineStage::Finalize;
    }

    if ready_downloads > 0 && active_downloads < download_limit {
        return LeafPipelineStage::Download;
    }

    if active_prepares > 0 || active_downloads > 0 {
        return LeafPipelineStage::WaitForWorker;
    }

    LeafPipelineStage::Prepare
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LeafPipelineStage {
    Finalize,
    Download,
    Prepare,
    WaitForWorker,
}

#[cfg(not(test))]
#[derive(Debug, Default)]
struct LeafPipelineState {
    workers: JoinSet<LeafPipelineEvent>,
    pending_prepares: VecDeque<PlannedLeaf>,
    ready_downloads: VecDeque<PreparedLeafDownload>,
    ready_finalizations: VecDeque<LeafFinalization>,
    active_prepares: usize,
    active_downloads: usize,
    prepare_parallelism: usize,
    download_window: LeafDownloadWindow,
}

#[cfg(not(test))]
impl LeafPipelineState {
    fn new(leaves: Vec<PlannedLeaf>, download_window: LeafDownloadWindow) -> Self {
        let prepare_parallelism = download_window.current_limit();
        Self {
            workers: JoinSet::new(),
            pending_prepares: VecDeque::from(leaves),
            ready_downloads: VecDeque::new(),
            ready_finalizations: VecDeque::new(),
            active_prepares: 0,
            active_downloads: 0,
            prepare_parallelism,
            download_window,
        }
    }

    fn has_work(&self) -> bool {
        leaf_pipeline_has_work(
            self.active_prepares,
            self.active_downloads,
            self.pending_prepares.len(),
            self.ready_downloads.len(),
            self.ready_finalizations.len(),
        )
    }
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
    if is_non_retryable_leaf_access_error(&message) {
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

fn is_non_retryable_leaf_access_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "private video",
        "sign in if you've been granted access",
        "sign in to confirm",
        "use --cookies-from-browser or --cookies",
        "this video is private",
        "members-only content",
        "video unavailable",
    ]
    .iter()
    .any(|fatal| message.contains(fatal))
}

#[cfg(not(test))]
type LeafPreparationOutcome = std::result::Result<PreparedLeafDownload, FailedLeafPreparation>;

#[cfg(not(test))]
enum LeafPipelineEvent {
    Prepared(LeafPreparationOutcome),
    Downloaded(LeafDownloadOutcome),
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
}

#[cfg(not(test))]
pub fn initialize_runtime(app: AppHandle) {
    let runtime = DOWNLOAD_RUNTIME.get_or_init(|| DownloadRuntime {
        app: app.clone(),
        active_task_ids: Mutex::new(HashSet::new()),
        active_binary_tasks: AtomicUsize::new(0),
    });

    spawn_recovery(runtime.app.clone());
    spawn_auto_update_loop(runtime.app.clone());
}

#[cfg(not(test))]
pub(crate) fn has_active_download_tasks() -> bool {
    let Some(runtime) = DOWNLOAD_RUNTIME.get() else {
        return false;
    };

    let has_active_task = runtime
        .active_task_ids
        .lock()
        .ok()
        .is_some_and(|active| !active.is_empty());

    has_active_task || runtime.active_binary_tasks.load(Ordering::SeqCst) > 0
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
    let task = repo::get_task(&task_id).await?;
    if task.status == DownloadTaskStatus::Completed {
        bail!("completed download tasks cannot be resumed");
    }
    spawn_task(task.id.to_string(), None)?;
    Ok(task)
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
            eprintln!("[downloads] failed to emit root shell probe trace `{event_name}`: {error}");
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
        eprintln!("[downloads] failed to emit root title stage trace `{stage}`: {emit_error}");
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
    let (task, collection) = match prepare_task_enqueue_outcome(url, trigger).await? {
        PreparedTaskEnqueue::Existing(task) => {
            let collection =
                collection_import::persist_download_collection_shell_from_task(&task).await?;
            (task, collection)
        }
        PreparedTaskEnqueue::New(task) => (task, None),
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
    loop {
        if let Some(existing) = repo::find_latest_active_task_for_url(normalized_url).await? {
            return Ok(PreparedTaskEnqueue::Existing(
                attach_existing_collection_shell_to_task(existing).await?,
            ));
        }

        let Some(_claim) = try_claim_enqueue_url(normalized_url)? else {
            task::yield_now().await;
            continue;
        };

        if let Some(existing) = repo::find_latest_active_task_for_url(normalized_url).await? {
            return Ok(PreparedTaskEnqueue::Existing(
                attach_existing_collection_shell_to_task(existing).await?,
            ));
        }

        let mut task = DownloadTask::new(
            task_id_for(normalized_url, trigger),
            normalized_url.to_string(),
            trigger,
        );
        apply_existing_collection_shell_to_task(&mut task).await?;

        return repo::save_task(task).await.map(PreparedTaskEnqueue::New);
    }
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
        let result = run_task(task_id.clone(), app, root_probe).await;
        if let Err(error) = result {
            let _ = mark_task_failed(&task_id, error.to_string()).await;
        }
        release_task(&task_id);
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
    let active_binary_task = ActiveBinaryTaskGuard::new(runtime()?);
    let deps = resolve_execution_deps(&app).await?;
    let result = run_task_with_deps(task_id, deps, root_probe).await;
    drop(active_binary_task);
    result
}

#[cfg(not(test))]
async fn run_task_with_deps(
    task_id: String,
    deps: DownloadExecutionDeps,
    root_probe: Option<RootProbe>,
) -> Result<()> {
    let mut task_snapshot = repo::get_task(&task_id).await?;
    task_snapshot.url = normalize_url(&task_snapshot.url)?;
    update_task_status(&mut task_snapshot, DownloadTaskStatus::Resolving, None).await?;

    let client = deps.client;
    let save_root = deps.save_root;
    let plan =
        resolve_collection_plan_with_root_probe(&task_snapshot, client.clone(), root_probe).await?;
    let mut collection = collection_import::load_collection_shell(&plan, &save_root).await?;
    collection_import::apply_collection_plan_to_task(&mut task_snapshot, &plan);
    discard_materialized_planned_leaves(
        &mut task_snapshot,
        collection_import::existing_planned_leaf_completions(&collection, &plan, &save_root),
    );
    task_snapshot = repo::save_task(task_snapshot.clone()).await?;
    let shell = collection_import::persist_download_collection_shell_from_task(&task_snapshot)
        .await?
        .context("download task shell evidence did not produce a collection")?;
    publish_download_task_change(&task_snapshot);
    if collection.musics.is_empty() {
        collection = shell;
    }
    let mut group_catalog = GroupCatalog::seed(&collection);

    if task_snapshot.leafs.is_empty() {
        collection_import::persist_empty_collection(&mut collection).await?;
        update_task_status(&mut task_snapshot, DownloadTaskStatus::Completed, None).await?;
        return Ok(());
    }

    let runnable_leaves = runnable_plan_leaves(&task_snapshot, &plan);
    let download_window =
        LeafDownloadWindow::for_collection(plan.source_kind, runnable_leaves.len());
    let parallelism = download_window.current_limit();
    eprintln!(
        "[downloads] task {} pipeline start source_kind={} total_leaves={} runnable_leaves={} download_parallelism={} max_download_parallelism={} folder={}",
        task_snapshot.id,
        plan.source_kind.as_str(),
        plan.leaves.len(),
        runnable_leaves.len(),
        parallelism,
        download_window.max_limit(),
        collection.folder
    );

    let mut pipeline = LeafPipelineState::new(runnable_leaves, download_window);
    fill_leaf_pipeline(
        &mut pipeline,
        &mut task_snapshot,
        &mut collection,
        client.clone(),
        plan.source_kind,
        &save_root,
        &deps.ffmpeg_path,
    )
    .await?;

    while pipeline.has_work() {
        drain_ready_leaf_finalizations(
            &mut pipeline,
            &mut task_snapshot,
            &mut collection,
            plan.source_kind,
            &save_root,
            &deps.ffmpeg_path,
        )
        .await?;
        handle_leaf_pipeline_event(
            &mut pipeline,
            &mut task_snapshot,
            &mut collection,
            &mut group_catalog,
            client.clone(),
            plan.source_kind,
            &save_root,
            &deps.ffmpeg_path,
        )
        .await?;
        fill_leaf_pipeline(
            &mut pipeline,
            &mut task_snapshot,
            &mut collection,
            client.clone(),
            plan.source_kind,
            &save_root,
            &deps.ffmpeg_path,
        )
        .await?;
    }

    mark_unresolved_leaves_failed(&mut task_snapshot).await?;
    let completed = task_snapshot.completed_leaves;
    let next_status = if task_snapshot.failed_leaves == 0 {
        DownloadTaskStatus::Completed
    } else if completed > 0 {
        DownloadTaskStatus::CompletedWithErrors
    } else {
        DownloadTaskStatus::Failed
    };
    let last_error = task_snapshot.last_error.clone();
    update_task_status(&mut task_snapshot, next_status, last_error).await?;
    eprintln!(
        "[downloads] task {} pipeline finished status={} completed={} failed={} total={}",
        task_snapshot.id,
        task_snapshot.status.as_str(),
        task_snapshot.completed_leaves,
        task_snapshot.failed_leaves,
        task_snapshot.total_leaves
    );
    Ok(())
}

#[cfg(not(test))]
fn runnable_plan_leaves(task: &DownloadTask, plan: &CollectionSyncPlan) -> Vec<PlannedLeaf> {
    plan.leaves
        .iter()
        .filter(|planned| {
            matches!(
                task.leafs
                .iter()
                .find(|leaf| leaf.id == planned.id)
                    .map(|leaf| leaf.status),
                Some(status) if !status.is_terminal()
            )
        })
        .cloned()
        .collect()
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
    collection: &mut Collection,
    client: Arc<dyn YtDlpClient>,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    ffmpeg_path: &Path,
) -> Result<()> {
    drain_ready_leaf_finalizations(
        pipeline,
        task_snapshot,
        collection,
        source_kind,
        save_root,
        ffmpeg_path,
    )
    .await?;
    spawn_ready_leaf_downloads(
        pipeline,
        task_snapshot,
        source_kind,
        save_root,
        client.clone(),
    )
    .await?;
    spawn_ready_leaf_preparations(pipeline, task_snapshot, client).await
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
        let Some(planned) = pipeline.pending_prepares.pop_front() else {
            break;
        };
        let mut leaf_snapshot = task_snapshot
            .leafs
            .iter()
            .find(|leaf| leaf.id == planned.id)
            .cloned()
            .ok_or_else(|| {
                anyhow!(
                    "download leaf `{}` disappeared from task snapshot",
                    planned.id
                )
            })?;
        leaf_snapshot.status = DownloadLeafStatus::Probing;
        leaf_snapshot.last_error = None;
        task_snapshot.status = DownloadTaskStatus::Downloading;
        task_snapshot.last_error = None;
        task_snapshot.replace_leaf(leaf_snapshot.clone());
        repo::save_task(task_snapshot.clone()).await?;

        eprintln!(
            "[downloads] leaf {} prepare queued sequence={} url={} active_prepares={} active_downloads={} pending={}",
            leaf_snapshot.id,
            leaf_snapshot.sequence,
            planned.url,
            pipeline.active_prepares + 1,
            pipeline.active_downloads,
            pipeline.pending_prepares.len()
        );

        pipeline.workers.spawn(prepare_leaf_download_worker(
            client.clone(),
            LeafPreparationInput {
                leaf: leaf_snapshot,
                planned,
            },
        ));
        pipeline.active_prepares += 1;
    }

    Ok(())
}

#[cfg(not(test))]
async fn prepare_leaf_download_worker(
    client: Arc<dyn YtDlpClient>,
    input: LeafPreparationInput,
) -> LeafPipelineEvent {
    let probe = match input.planned.initial_probe.clone() {
        Some(probe) => probe,
        None => {
            let url = input.planned.url.clone();
            match run_blocking(move || client.probe_leaf(&url)).await {
                Ok(probe) => probe,
                Err(error) => {
                    return LeafPipelineEvent::Prepared(Err(FailedLeafPreparation {
                        leaf: input.leaf,
                        error: error.to_string(),
                    }));
                }
            }
        }
    };

    let mut music_probe = probe.clone();
    if let Some(music_title) = &input.planned.music_title {
        music_probe.title = music_title.clone();
    }

    LeafPipelineEvent::Prepared(Ok(PreparedLeafDownload {
        leaf: input.leaf,
        probe,
        music_probe,
        group: input.planned.group_hint,
        url: input.planned.url,
    }))
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
        let download_result = run_blocking(move || {
            let mut latest_progress = DownloadProgress::default();
            let downloaded = client.download_leaf_audio(
                &url,
                &target_dir,
                &temp_file_stem,
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
                eprintln!(
                    "[downloads] leaf {} download attempt {} failed; retrying after {}ms: {}",
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
async fn handle_leaf_pipeline_event(
    pipeline: &mut LeafPipelineState,
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    group_catalog: &mut GroupCatalog,
    client: Arc<dyn YtDlpClient>,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    ffmpeg_path: &Path,
) -> Result<()> {
    if !pipeline.ready_finalizations.is_empty() {
        return drain_ready_leaf_finalizations(
            pipeline,
            task_snapshot,
            collection,
            source_kind,
            save_root,
            ffmpeg_path,
        )
        .await;
    }

    if pipeline.active_prepares == 0 && pipeline.active_downloads == 0 {
        return Ok(());
    }

    let event = pipeline
        .workers
        .join_next()
        .await
        .context("download pipeline worker set was unexpectedly empty")?
        .context("download pipeline worker panicked")?;

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
                outcome,
            )
            .await
        }
        LeafPipelineEvent::Downloaded(outcome) => {
            pipeline.active_downloads = pipeline.active_downloads.saturating_sub(1);
            match &outcome {
                Ok(completed) if completed.retry_failures == 0 => {
                    pipeline.download_window.record_success();
                }
                Ok(completed) => {
                    eprintln!(
                        "[downloads] leaf {} download succeeded after {} retry failure(s); reducing future download parallelism",
                        completed.leaf.id, completed.retry_failures
                    );
                    pipeline.download_window.record_failure();
                }
                Err(_) => {
                    pipeline.download_window.record_failure();
                }
            }
            pipeline
                .ready_finalizations
                .push_back(LeafFinalization::Downloaded(outcome));
            drain_ready_leaf_finalizations(
                pipeline,
                task_snapshot,
                collection,
                source_kind,
                save_root,
                ffmpeg_path,
            )
            .await
        }
    }
}

#[cfg(not(test))]
async fn drain_ready_leaf_finalizations(
    pipeline: &mut LeafPipelineState,
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    ffmpeg_path: &Path,
) -> Result<()> {
    while let Some(outcome) = pipeline.ready_finalizations.pop_front() {
        match outcome {
            LeafFinalization::Downloaded(outcome) => {
                handle_finished_leaf_download(
                    task_snapshot,
                    collection,
                    source_kind,
                    save_root,
                    ffmpeg_path,
                    outcome,
                )
                .await?;
            }
            LeafFinalization::ExistingFile(completion) => {
                handle_existing_leaf_completion(
                    task_snapshot,
                    collection,
                    source_kind,
                    save_root,
                    ffmpeg_path,
                    completion,
                )
                .await?;
            }
        }
    }

    Ok(())
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
    outcome: LeafPreparationOutcome,
) -> Result<()> {
    let prepared = match outcome {
        Ok(prepared) => prepared,
        Err(failed) => {
            eprintln!(
                "[downloads] leaf {} prepare failed: {}",
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
    eprintln!(
        "[downloads] leaf {} prepared title={} url={} active_prepares={} active_downloads={}",
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
        eprintln!(
            "[downloads] leaf {} reusing existing file {}",
            leaf_snapshot.id, relative_path
        );
        pipeline
            .ready_finalizations
            .push_back(LeafFinalization::ExistingFile(ExistingLeafCompletion {
                leaf: leaf_snapshot,
                music_probe: prepared.music_probe,
                group: music_group,
                relative_path,
                absolute_path,
            }));
        return Ok(());
    }

    match resolve_residual_temp_downloaded_file(&target_dir, &temp_file_stem) {
        ResidualTempFileResolution::Ready(downloaded_path) => {
            let duration_ms = completed_local_audio_duration_ms(
                ffmpeg_path.to_path_buf(),
                downloaded_path.clone(),
            )
            .await?;
            eprintln!(
                "[downloads] leaf {} found existing temp file {}",
                leaf_snapshot.id,
                downloaded_path.display()
            );
            pipeline
                .ready_finalizations
                .push_back(LeafFinalization::Downloaded(Ok(CompletedLeafDownload {
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
                })));
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
    });
    Ok(())
}

#[cfg(not(test))]
async fn spawn_ready_leaf_downloads(
    pipeline: &mut LeafPipelineState,
    task_snapshot: &mut DownloadTask,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    client: Arc<dyn YtDlpClient>,
) -> Result<()> {
    while pipeline.active_downloads < pipeline.download_window.current_limit() {
        let Some(prepared) = pipeline.ready_downloads.pop_front() else {
            break;
        };

        let mut leaf_snapshot = prepared.leaf;
        leaf_snapshot.status = DownloadLeafStatus::Downloading;
        leaf_snapshot.touch();
        task_snapshot.replace_leaf(leaf_snapshot.clone());
        repo::save_task(task_snapshot.clone()).await?;

        let file_stem = sanitize_path_component(&prepared.probe.title);
        let target_dir = save_root.join(
            task_snapshot
                .collection_folder
                .as_deref()
                .context("download task is missing collection folder")?,
        );
        let temp_file_stem =
            temporary_download_stem(&file_stem, &task_snapshot.id, &leaf_snapshot.id);
        eprintln!(
            "[downloads] leaf {} download queued sequence={} source_kind={} active_downloads={} parallelism={} temp_stem={} target_dir={}",
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
    ffmpeg_path: &Path,
    outcome: LeafDownloadOutcome,
) -> Result<()> {
    let completed = match outcome {
        Ok(completed) => completed,
        Err(failed) => {
            eprintln!(
                "[downloads] leaf {} download failed: {}",
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
    let file_name = match persist_completed_leaf_download(
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
        Ok(file_name) => file_name,
        Err(error) => {
            let error = error.to_string();
            eprintln!(
                "[downloads] leaf {} persist failed downloaded_path={} error={}",
                leaf_snapshot.id,
                downloaded_path.display(),
                error
            );
            mark_leaf_failed(task_snapshot, leaf_snapshot, error).await?;
            return Ok(());
        }
    };

    let leaf_id = leaf_snapshot.id.to_string();
    leaf_snapshot.file_name = Some(file_name.clone());
    leaf_snapshot.relative_path = Some(file_name.clone());
    leaf_snapshot.downloaded_bytes = completed.progress.downloaded_bytes;
    leaf_snapshot.total_bytes = completed.progress.total_bytes;
    leaf_snapshot.speed_bytes_per_second = completed.progress.speed_bytes_per_second;
    leaf_snapshot.eta_seconds = completed.progress.eta_seconds;

    leaf_snapshot.status = DownloadLeafStatus::MeasuringLoudness;
    leaf_snapshot.last_error = None;
    leaf_snapshot.touch();
    task_snapshot.replace_leaf(leaf_snapshot.clone());
    let saved = repo::save_task(task_snapshot.clone()).await?;
    publish_download_task_change(&saved);
    *task_snapshot = saved;

    if let Err(error) = measure_downloaded_leaf_loudness(
        collection,
        save_root,
        &file_name,
        ffmpeg_path.to_path_buf(),
    )
    .await
    {
        let error = error.to_string();
        eprintln!(
            "[downloads] leaf {} loudness measurement failed relative_path={} error={}",
            leaf_id, file_name, error
        );
        mark_leaf_failed(task_snapshot, leaf_snapshot, error).await?;
        return Ok(());
    }

    leaf_snapshot.status = DownloadLeafStatus::Completed;
    leaf_snapshot.last_error = None;
    leaf_snapshot.touch();
    task_snapshot.replace_leaf(leaf_snapshot);
    let saved = repo::save_task(task_snapshot.clone()).await?;
    publish_download_task_change(&saved);
    *task_snapshot = saved;
    eprintln!("[downloads] leaf {} completed file={}", leaf_id, file_name);
    Ok(())
}

#[cfg(not(test))]
async fn handle_existing_leaf_completion(
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    source_kind: CollectionSourceKind,
    save_root: &Path,
    ffmpeg_path: &Path,
    completion: ExistingLeafCompletion,
) -> Result<()> {
    let mut leaf_snapshot = completion.leaf;
    let relative_path = completion.relative_path;
    let leaf_id = leaf_snapshot.id.to_string();
    let leaf_url = completion.music_probe.webpage_url.clone();
    let mut music_probe = completion.music_probe;
    let duration_ms =
        completed_local_audio_duration_ms(ffmpeg_path.to_path_buf(), completion.absolute_path)
            .await?;
    apply_completed_audio_duration_evidence(&mut music_probe, duration_ms);
    leaf_snapshot.duration_ms = music_probe.duration_ms;
    leaf_snapshot.duration_seconds = music_probe.duration_seconds;

    let persist_result = async {
        collection_import::persist_downloaded_leaf_music(
            collection,
            source_kind,
            &music_probe,
            &relative_path,
            completion.group,
        )
        .await?;
        write_collection_manifest_after_download(save_root, collection, source_kind)?;
        Ok::<_, anyhow::Error>(())
    }
    .await;

    if let Err(error) = persist_result {
        let error = error.to_string();
        eprintln!(
            "[downloads] leaf {} existing file persist failed relative_path={} error={}",
            leaf_snapshot.id, relative_path, error
        );
        mark_leaf_failed(task_snapshot, leaf_snapshot, error).await?;
        if source_kind == CollectionSourceKind::Single {
            let last_error = task_snapshot.last_error.clone();
            update_task_status(task_snapshot, DownloadTaskStatus::Failed, last_error).await?;
        }
        return Ok(());
    }

    leaf_snapshot.file_name = Some(relative_path.clone());
    leaf_snapshot.relative_path = Some(relative_path.clone());
    leaf_snapshot.status = DownloadLeafStatus::MeasuringLoudness;
    leaf_snapshot.last_error = None;
    leaf_snapshot.touch();
    task_snapshot.replace_leaf(leaf_snapshot.clone());
    let saved = repo::save_task(task_snapshot.clone()).await?;
    publish_download_task_change(&saved);
    *task_snapshot = saved;

    if let Err(error) = measure_downloaded_leaf_loudness(
        collection,
        save_root,
        &relative_path,
        ffmpeg_path.to_path_buf(),
    )
    .await
    {
        let error = error.to_string();
        eprintln!(
            "[downloads] leaf {} existing file loudness measurement failed relative_path={} error={}",
            leaf_id, relative_path, error
        );
        mark_leaf_failed(task_snapshot, leaf_snapshot, error).await?;
        if source_kind == CollectionSourceKind::Single {
            let last_error = task_snapshot.last_error.clone();
            update_task_status(task_snapshot, DownloadTaskStatus::Failed, last_error).await?;
        }
        return Ok(());
    }

    leaf_snapshot.status = DownloadLeafStatus::Completed;
    leaf_snapshot.last_error = None;
    leaf_snapshot.touch();
    task_snapshot.replace_leaf(leaf_snapshot);
    let saved = repo::save_task(task_snapshot.clone()).await?;
    publish_download_task_change(&saved);
    *task_snapshot = saved;
    eprintln!(
        "[downloads] leaf {} completed existing file={} url={}",
        leaf_id, relative_path, leaf_url
    );
    Ok(())
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
    let file_name = match persist_completed_leaf_download(
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
        Ok(file_name) => file_name,
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
) -> Result<String> {
    eprintln!(
        "[downloads] finalize leaf url={} downloaded_path={} file_stem={} group_url={}",
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
    eprintln!(
        "[downloads] persist music leaf url={} relative_path={}",
        leaf_url, file_name
    );
    collection_import::persist_downloaded_leaf_music(
        collection,
        source_kind,
        music_probe,
        &file_name,
        music_group.clone(),
    )
    .await
    .with_context(|| format!("failed to persist downloaded music for {leaf_url}"))?;
    write_collection_manifest_after_download(save_root, collection, source_kind)
        .with_context(|| format!("failed to write collection manifest for {leaf_url}"))?;
    eprintln!(
        "[downloads] manifest updated collection_folder={} relative_path={}",
        collection.folder, file_name
    );

    Ok(file_name)
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
#[derive(Debug, Clone)]
struct MusicLoudnessMeasurement {
    url: String,
    path: PathBuf,
    start_ms: u32,
    end_ms: u32,
}

#[cfg(not(test))]
async fn measure_downloaded_leaf_loudness(
    collection: &mut Collection,
    save_root: &Path,
    relative_path: &str,
    ffmpeg_path: PathBuf,
) -> Result<()> {
    let measurements = collection
        .musics
        .iter()
        .filter(|music| music.path.as_deref() == Some(relative_path))
        .filter(|music| music.loudness == 0.0)
        .filter_map(|music| {
            if music.start_ms >= music.end_ms {
                return None;
            }
            Some(MusicLoudnessMeasurement {
                url: music.url.clone(),
                path: save_root.join(&collection.folder).join(relative_path),
                start_ms: music.start_ms,
                end_ms: music.end_ms,
            })
        })
        .collect::<Vec<_>>();

    if measurements.is_empty() {
        return Ok(());
    }

    let evidence = run_music_loudness_measurements(ffmpeg_path, measurements).await?;
    for measured in evidence {
        for music in &mut collection.musics {
            if music.url == measured.url
                && music.start_ms == measured.start_ms
                && music.end_ms == measured.end_ms
            {
                music.loudness = measured.loudness;
            }
        }
    }

    Ok(())
}

#[cfg(not(test))]
#[derive(Debug, Clone)]
struct MusicLoudnessEvidence {
    url: String,
    start_ms: u32,
    end_ms: u32,
    loudness: f32,
}

#[cfg(not(test))]
async fn run_music_loudness_measurements(
    ffmpeg_path: PathBuf,
    measurements: Vec<MusicLoudnessMeasurement>,
) -> Result<Vec<MusicLoudnessEvidence>> {
    let parallelism = loudness_measurement_parallelism(measurements.len());
    let mut pending = measurements.into_iter();
    let mut active = JoinSet::new();
    let mut evidence = Vec::new();
    let mut first_error = None;

    loop {
        while active.len() < parallelism {
            let Some(measurement) = pending.next() else {
                break;
            };
            let ffmpeg_path = ffmpeg_path.clone();
            active.spawn(async move { measure_one_music_loudness(ffmpeg_path, measurement).await });
        }

        let Some(result) = active.join_next().await else {
            break;
        };

        match result {
            Ok(Ok(measured)) => {
                evidence.push(measured);
            }
            Ok(Err(error)) => {
                first_error.get_or_insert_with(|| error.to_string());
            }
            Err(error) => {
                first_error.get_or_insert_with(|| format!("loudness worker failed: {error}"));
            }
        }
    }

    if let Some(error) = first_error {
        bail!(error);
    }

    Ok(evidence)
}

#[cfg(not(test))]
async fn measure_one_music_loudness(
    ffmpeg_path: PathBuf,
    measurement: MusicLoudnessMeasurement,
) -> Result<MusicLoudnessEvidence> {
    let analysis = run_blocking({
        let path = measurement.path.clone();
        let start_ms = measurement.start_ms;
        let end_ms = measurement.end_ms;
        move || {
            ffplayr::analyze_loudness_with_binary(
                &ffmpeg_path,
                ffplayr::AudioLoudnessAnalysisRequest {
                    path,
                    time_range: Some(ffplayr::PlaybackTimeRange {
                        start_ms,
                        duration_ms: Some(end_ms.saturating_sub(start_ms)),
                    }),
                },
            )
            .map_err(anyhow::Error::msg)
        }
    })
    .await?;

    let updated = playlists_repo::set_music_loudness_by_identity(
        &measurement.url,
        measurement.start_ms,
        measurement.end_ms,
        analysis.integrated_lufs,
    )
    .await?;

    Ok(MusicLoudnessEvidence {
        url: measurement.url,
        start_ms: measurement.start_ms,
        end_ms: measurement.end_ms,
        loudness: updated
            .as_ref()
            .map(|music| music.loudness)
            .unwrap_or(analysis.integrated_lufs),
    })
}

#[cfg(not(test))]
fn loudness_measurement_parallelism(item_count: usize) -> usize {
    let available = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    item_count
        .min(MAX_PARALLEL_LOUDNESS_MEASUREMENTS)
        .min(available)
        .max(1)
}

#[cfg(not(test))]
fn write_collection_manifest_after_download(
    save_root: &Path,
    collection: &Collection,
    source_kind: CollectionSourceKind,
) -> Result<()> {
    let collection_root = save_root.join(&collection.folder);
    collection_import::write_collection_manifest(&collection_root, collection, source_kind)
}

#[cfg(test)]
fn write_collection_manifest_after_download(
    _save_root: &Path,
    _collection: &Collection,
    _source_kind: CollectionSourceKind,
) -> Result<()> {
    Ok(())
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
    if saved.status.is_terminal() {
        publish_download_task_change(&saved);
    }
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
fn download_task_change_sender() -> &'static broadcast::Sender<DownloadTaskChangeSignal> {
    DOWNLOAD_TASK_CHANGES.get_or_init(|| broadcast::channel(64).0)
}

#[cfg(not(test))]
pub(crate) fn publish_download_task_change(task: &DownloadTask) {
    let signal = DownloadTaskChangeSignal {
        task_id: task.id.to_string(),
        task_url: task.url.clone(),
        collection_url: task.collection_url.clone(),
        collection_name: task.collection_name.clone(),
        status: task.status,
        last_error: task.last_error.clone(),
    };
    if let Ok(runtime) = runtime() {
        let _ = signal.emit(&runtime.app);
    }
    let _ = download_task_change_sender().send(signal);
}

#[cfg(test)]
fn publish_download_task_change(_task: &DownloadTask) {}

#[cfg(not(test))]
fn spawn_recovery(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("download-recovery".to_string())
        .spawn(move || {
            tauri::async_runtime::block_on(async move {
                match recover_incomplete_download_tasks().await {
                    Ok(recovered) if recovered > 0 => {
                        eprintln!("[downloads] resumed {recovered} incomplete download tasks");
                    }
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("[downloads] failed to resume incomplete download tasks: {error}");
                    }
                }

                match resolve_save_root(&app).await {
                    Ok(save_root) => match collection_import::repair_stale_single_source_collections(&save_root).await {
                        Ok(repaired) if repaired > 0 => {
                            eprintln!(
                                "[downloads] repaired {repaired} stale single-source collections"
                            );
                        }
                        Ok(_) => {}
                        Err(error) => {
                            eprintln!(
                                "[downloads] failed to repair stale single-source collections: {error}"
                            );
                        }
                    },
                    Err(error) => {
                        eprintln!("[downloads] failed to resolve save root during recovery: {error}");
                    }
                }

                if let Err(error) = run_auto_update_cycle().await {
                    eprintln!("[downloads] initial auto update failed: {error}");
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
                        eprintln!("[downloads] auto update failed: {error}");
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
    probe.duration_ms = Some(duration_ms);
    probe.duration_seconds = Some(duration_ms.div_ceil(1_000));
}

#[cfg(not(test))]
async fn completed_local_audio_duration_ms(
    ffmpeg_path: PathBuf,
    file_path: PathBuf,
) -> Result<u32> {
    run_blocking(move || {
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
    fn seed(collection: &Collection) -> Self {
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
