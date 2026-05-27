#[cfg(not(test))]
use super::model::DownloadLeafGroupContext;
#[cfg(not(test))]
use super::model::EnqueuedCollectionDownload;
use super::model::{
    CollectionSourceKind, DownloadLeaf, DownloadLeafStatus, DownloadTask, DownloadTaskStatus,
    DownloadTrigger, PastedDownloadUrlResolution, now_timestamp,
};
use super::naming::{sanitize_path_component, short_hash, stable_id};
use super::repo;
#[cfg(not(test))]
use super::yt_dlp::CliYtDlpClient;
use super::yt_dlp::{
    DownloadProgress, LeafProbe, LeafReference, RootProbe, YtDlpClient, classify_root_preference,
    is_youtube_mix_playlist_id,
};
#[cfg(not(test))]
use crate::domain::collection_import::CollectionShellPlan;
use crate::domain::collection_import::{self, CollectionSyncPlan, PlannedLeaf};
#[cfg(not(test))]
use crate::domain::meta::service as meta_service;
use crate::domain::playlists::model::{Collection, Group};
#[cfg(not(test))]
use crate::utils::binaries::{ManagedBinary, ensure_managed_binary, managed_bin_dir};
use anyhow::{Context, Result, anyhow, bail};
use appdb::Id;
use reqwest::{Url, blocking::Client as BlockingHttpClient};
#[cfg(not(test))]
use std::collections::VecDeque;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(not(test))]
use std::thread;
use std::time::Duration;
#[cfg(not(test))]
use tauri::AppHandle;
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
const MAX_LEAF_DOWNLOAD_ATTEMPTS: usize = 3;
const LEAF_DOWNLOAD_RETRY_BASE_DELAY_SECS: u64 = 2;
const LEAF_DOWNLOAD_RETRY_MAX_JITTER_MILLIS: u64 = 750;
const GROUP_DISCOVERY_USER_AGENT: &str =
    concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"));

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

#[derive(Debug, Clone)]
struct PendingLeafExpansion {
    entry: LeafReference,
    group_hint: Option<Group>,
    depth: u8,
}

#[derive(Debug, Clone)]
struct ExpandedLeafCandidate {
    id: Id,
    url: String,
    title: Option<String>,
    initial_probe: Option<LeafProbe>,
    group_hint: Option<Group>,
}

#[derive(Debug, Default, Clone)]
struct GroupCatalog {
    groups: HashMap<String, Group>,
    ambiguous: HashSet<String>,
    discovery_attempted: bool,
}

#[derive(Clone)]
struct DownloadExecutionDeps {
    client: Arc<dyn YtDlpClient>,
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
#[derive(Debug, Default)]
struct LeafPipelineState {
    workers: JoinSet<LeafPipelineEvent>,
    pending_prepares: VecDeque<PlannedLeaf>,
    ready_downloads: VecDeque<PreparedLeafDownload>,
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
            active_prepares: 0,
            active_downloads: 0,
            prepare_parallelism,
            download_window,
        }
    }

    fn has_work(&self) -> bool {
        self.active_prepares > 0
            || self.active_downloads > 0
            || !self.pending_prepares.is_empty()
            || !self.ready_downloads.is_empty()
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

#[cfg(not(test))]
type LeafPreparationOutcome = std::result::Result<PreparedLeafDownload, FailedLeafPreparation>;

#[cfg(not(test))]
enum LeafPipelineEvent {
    Prepared(LeafPreparationOutcome),
    Downloaded(LeafDownloadOutcome),
}

#[cfg(not(test))]
#[derive(Debug, Clone)]
pub(crate) struct DownloadTaskChangeSignal {
    pub(crate) task_id: String,
    pub(crate) task_url: String,
    pub(crate) collection_url: Option<String>,
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
    spawn_task(task.id.to_string())?;
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

#[cfg(not(test))]
async fn enqueue_collection_download_with_trigger(
    url: String,
    trigger: DownloadTrigger,
) -> Result<EnqueuedCollectionDownload> {
    let prepared = prepare_task_enqueue_outcome(url, trigger).await?;

    let (task, collection) = match prepared {
        PreparedTaskEnqueue::Existing(task) => {
            let app = runtime()?.app.clone();
            match collection_import::resolve_existing_enqueued_collection(&task).await {
                Ok(collection) => (task, collection),
                Err(_) => bootstrap_enqueued_collection(task, app).await?,
            }
        }
        PreparedTaskEnqueue::New(task) => {
            let app = runtime()?.app.clone();
            bootstrap_enqueued_collection(task, app).await?
        }
    };

    if !task.status.is_terminal() {
        spawn_task(task.id.to_string())?;
    }

    Ok(EnqueuedCollectionDownload { task, collection })
}

#[cfg(not(test))]
#[allow(dead_code)]
pub(crate) async fn enqueue_collection_download_for_test(
    url: String,
    client: Arc<dyn YtDlpClient>,
    save_root: PathBuf,
) -> Result<EnqueuedCollectionDownload> {
    // This helper is reserved for manual chain verification outside `cargo test`.
    // Domain tests should follow the appdb pattern with fake dependencies and
    // temporary appdb state instead of pulling Tauri-hosted execution paths into
    // the Rust test harness.
    let deps = DownloadExecutionDeps { client, save_root };
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
        run_task_with_deps(task.id.to_string(), deps).await?;
        task = repo::get_task(&task.id.to_string()).await?;
        if let Some(collection_url) = task.collection_url.as_deref()
            && let Some(updated) = collection_import::get_collection_by_url(collection_url).await?
        {
            collection = updated;
        }
    }

    Ok(EnqueuedCollectionDownload { task, collection })
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

async fn prepare_task_enqueue_outcome(
    url: String,
    trigger: DownloadTrigger,
) -> Result<PreparedTaskEnqueue> {
    let normalized_url = normalize_url(&url)?;

    loop {
        if let Some(existing) = repo::find_latest_active_task_for_url(&normalized_url).await? {
            return Ok(PreparedTaskEnqueue::Existing(existing));
        }

        let Some(_claim) = try_claim_enqueue_url(&normalized_url)? else {
            task::yield_now().await;
            continue;
        };

        if let Some(existing) = repo::find_latest_active_task_for_url(&normalized_url).await? {
            return Ok(PreparedTaskEnqueue::Existing(existing));
        }

        return repo::save_task(DownloadTask::new(
            task_id_for(&normalized_url, trigger),
            normalized_url,
            trigger,
        ))
        .await
        .map(PreparedTaskEnqueue::New);
    }
}

#[cfg(not(test))]
fn spawn_task(task_id: String) -> Result<()> {
    let runtime = runtime()?;
    if !try_claim_task(&task_id)? {
        return Ok(());
    }

    let app = runtime.app.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_task(task_id.clone(), app).await;
        if let Err(error) = result {
            let _ = mark_task_failed(&task_id, error.to_string()).await;
        }
        release_task(&task_id);
    });

    Ok(())
}

#[cfg(test)]
fn spawn_task(_task_id: String) -> Result<()> {
    Ok(())
}

#[cfg(not(test))]
async fn bootstrap_enqueued_collection(
    task: DownloadTask,
    app: AppHandle,
) -> Result<(DownloadTask, Collection)> {
    let active_binary_task = ActiveBinaryTaskGuard::new(runtime()?);
    let deps = resolve_execution_deps(&app).await?;
    let result = bootstrap_enqueued_collection_with_deps(task, deps).await;
    drop(active_binary_task);
    result
}

#[cfg(not(test))]
async fn bootstrap_enqueued_collection_with_deps(
    task: DownloadTask,
    deps: DownloadExecutionDeps,
) -> Result<(DownloadTask, Collection)> {
    let plan = resolve_collection_shell_plan(&task, deps.client).await?;
    collection_import::persist_enqueued_collection_shell(task, &plan).await
}

#[cfg(not(test))]
async fn run_task(task_id: String, app: AppHandle) -> Result<()> {
    let active_binary_task = ActiveBinaryTaskGuard::new(runtime()?);
    let deps = resolve_execution_deps(&app).await?;
    let result = run_task_with_deps(task_id, deps).await;
    drop(active_binary_task);
    result
}

#[cfg(not(test))]
async fn run_task_with_deps(task_id: String, deps: DownloadExecutionDeps) -> Result<()> {
    let mut task_snapshot = repo::get_task(&task_id).await?;
    task_snapshot.url = normalize_url(&task_snapshot.url)?;
    update_task_status(&mut task_snapshot, DownloadTaskStatus::Resolving, None).await?;

    let client = deps.client;
    let save_root = deps.save_root;
    let plan = resolve_collection_plan(&task_snapshot, client.clone()).await?;
    let mut collection = collection_import::load_collection_shell(&plan, &save_root).await?;
    let mut group_catalog = GroupCatalog::seed(&collection);
    collection_import::apply_collection_plan_to_task(&mut task_snapshot, &plan);
    discard_materialized_planned_leaves(
        &mut task_snapshot,
        collection_import::existing_planned_leaf_completions(&collection, &plan, &save_root),
    );
    repo::save_task(task_snapshot.clone()).await?;

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
        client.clone(),
        plan.source_kind,
        &save_root,
    )
    .await?;

    while pipeline.has_work() {
        handle_leaf_pipeline_event(
            &mut pipeline,
            &mut task_snapshot,
            &mut collection,
            &mut group_catalog,
            client.clone(),
            plan.source_kind,
            &save_root,
        )
        .await?;
        fill_leaf_pipeline(
            &mut pipeline,
            &mut task_snapshot,
            client.clone(),
            plan.source_kind,
            &save_root,
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
    client: Arc<dyn YtDlpClient>,
    source_kind: CollectionSourceKind,
    save_root: &Path,
) -> Result<()> {
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
) -> Result<()> {
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
            handle_finished_leaf_download(
                task_snapshot,
                collection,
                source_kind,
                save_root,
                outcome,
            )
            .await
        }
    }
}

#[cfg(not(test))]
async fn handle_prepared_leaf_download(
    pipeline: &mut LeafPipelineState,
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    group_catalog: &mut GroupCatalog,
    client: Arc<dyn YtDlpClient>,
    source_kind: CollectionSourceKind,
    save_root: &Path,
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

    let group = match prepared.group.clone() {
        Some(group) => Some(group),
        None => {
            resolve_probe_group(
                source_kind,
                &prepared.probe,
                &task_snapshot.url,
                client.clone(),
                group_catalog,
            )
            .await
        }
    };

    let mut leaf_snapshot = prepared.leaf;
    leaf_snapshot.title = Some(prepared.probe.title.clone());
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
        eprintln!(
            "[downloads] leaf {} reusing existing file {}",
            leaf_snapshot.id, relative_path
        );
        collection_import::persist_downloaded_leaf_music(
            collection,
            source_kind,
            &prepared.music_probe,
            &relative_path,
            music_group,
        )
        .await?;
        write_collection_manifest_after_download(save_root, collection, source_kind)?;
        leaf_snapshot.file_name = Some(relative_path.clone());
        leaf_snapshot.relative_path = Some(relative_path);
        leaf_snapshot.status = DownloadLeafStatus::Completed;
        leaf_snapshot.last_error = None;
        leaf_snapshot.touch();
        task_snapshot.replace_leaf(leaf_snapshot);
        let saved = repo::save_task(task_snapshot.clone()).await?;
        publish_download_task_change(&saved);
        *task_snapshot = saved;
        return Ok(());
    }

    match resolve_residual_temp_downloaded_file(&target_dir, &temp_file_stem) {
        ResidualTempFileResolution::Ready(downloaded_path) => {
            eprintln!(
                "[downloads] leaf {} found existing temp file {}",
                leaf_snapshot.id,
                downloaded_path.display()
            );
            handle_finished_leaf_download(
                task_snapshot,
                collection,
                source_kind,
                save_root,
                Ok(CompletedLeafDownload {
                    leaf: leaf_snapshot,
                    probe: prepared.probe,
                    music_probe: prepared.music_probe,
                    group,
                    downloaded: super::yt_dlp::DownloadedLeaf {
                        absolute_path: downloaded_path,
                    },
                    progress: DownloadProgress::default(),
                    retry_failures: 0,
                }),
            )
            .await?;
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
    let downloaded_path = completed.downloaded.absolute_path;
    let file_name = match persist_completed_leaf_download(
        collection,
        source_kind,
        &completed.probe.webpage_url,
        &completed.music_probe,
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
    let file_name = match persist_completed_leaf_download(
        collection,
        source_kind,
        &completed.probe.webpage_url,
        &completed.music_probe,
        &music_group,
        save_root,
        &file_stem,
        completed.downloaded.absolute_path,
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

pub(crate) async fn resolve_collection_plan(
    task: &DownloadTask,
    client: Arc<dyn YtDlpClient>,
) -> Result<CollectionSyncPlan> {
    if let Some(plan) = residual_collection_plan(task) {
        return Ok(plan);
    }

    let root_preference = classify_root_preference(&task.url);
    let root_probe = {
        let client = client.clone();
        let url = task.url.clone();
        run_blocking(move || client.probe_root(&url)).await?
    };

    match root_probe {
        RootProbe::Single(leaf) => {
            let collection_url = leaf.webpage_url.clone();
            let existing = collection_import::get_collection_by_url(&collection_url).await?;
            Ok(CollectionSyncPlan {
                source_kind: CollectionSourceKind::Single,
                collection_name: leaf.title.clone(),
                collection_url: collection_url.clone(),
                collection_folder: resolve_task_collection_folder(
                    task,
                    &collection_url,
                    &leaf.title,
                    existing.as_ref(),
                )
                .await?,
                enable_updates: None,
                leaves: vec![PlannedLeaf {
                    id: leaf_id_for(&task.id, &collection_url, None),
                    url: collection_url,
                    sequence: 0,
                    initial_probe: (!should_reprobe_single_leaf(root_preference)).then_some(leaf),
                    music_title: None,
                    group_hint: None,
                }],
            })
        }
        RootProbe::List(list) => {
            let collection_url = list.webpage_url.clone();
            let existing = collection_import::get_collection_by_url(&collection_url).await?;
            let leaves = collection_import::deduplicate_planned_leaves(
                &collection_url,
                expand_root_entries_to_planned_leafs(&task.id, client.clone(), list.entries, None)
                    .await?,
            );

            Ok(CollectionSyncPlan {
                source_kind: CollectionSourceKind::List,
                collection_name: list.title.clone(),
                collection_url: collection_url.clone(),
                collection_folder: resolve_task_collection_folder(
                    task,
                    &collection_url,
                    &list.title,
                    existing.as_ref(),
                )
                .await?,
                enable_updates: Some(
                    existing
                        .and_then(|collection| collection.enable_updates)
                        .unwrap_or(false),
                ),
                leaves,
            })
        }
    }
}

pub(crate) fn residual_collection_plan(task: &DownloadTask) -> Option<CollectionSyncPlan> {
    if task.leafs.is_empty() {
        return None;
    }

    Some(CollectionSyncPlan {
        source_kind: task.source_kind?,
        collection_name: task.collection_name.clone()?,
        collection_url: task.collection_url.clone()?,
        collection_folder: task.collection_folder.clone()?,
        enable_updates: None,
        leaves: task.leafs.iter().map(planned_leaf_from_residual).collect(),
    })
}

fn planned_leaf_from_residual(leaf: &DownloadLeaf) -> PlannedLeaf {
    PlannedLeaf {
        id: leaf.id.clone(),
        url: leaf.url.clone(),
        sequence: leaf.sequence,
        initial_probe: None,
        music_title: leaf.title.clone(),
        group_hint: leaf.group.clone().map(Into::into),
    }
}

pub(crate) async fn resolve_task_collection_folder(
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
async fn resolve_collection_shell_plan(
    task: &DownloadTask,
    client: Arc<dyn YtDlpClient>,
) -> Result<CollectionShellPlan> {
    let root_probe = {
        let client = client.clone();
        let url = task.url.clone();
        run_blocking(move || client.probe_root(&url)).await?
    };

    match root_probe {
        RootProbe::Single(leaf) => {
            let collection_url = leaf.webpage_url.clone();
            let existing = collection_import::get_collection_by_url(&collection_url).await?;
            Ok(CollectionShellPlan {
                source_kind: CollectionSourceKind::Single,
                collection_name: leaf.title.clone(),
                collection_url: collection_url.clone(),
                collection_folder: collection_import::resolve_collection_folder(
                    &collection_url,
                    &leaf.title,
                    existing.as_ref(),
                )
                .await?,
                enable_updates: None,
            })
        }
        RootProbe::List(list) => {
            if list.entries.is_empty() {
                bail!("download resource does not contain any downloadable entries");
            }

            let collection_url = list.webpage_url.clone();
            let existing = collection_import::get_collection_by_url(&collection_url).await?;
            Ok(CollectionShellPlan {
                source_kind: CollectionSourceKind::List,
                collection_name: list.title.clone(),
                collection_url: collection_url.clone(),
                collection_folder: collection_import::resolve_collection_folder(
                    &collection_url,
                    &list.title,
                    existing.as_ref(),
                )
                .await?,
                enable_updates: Some(
                    existing
                        .and_then(|collection| collection.enable_updates)
                        .unwrap_or(false),
                ),
            })
        }
    }
}

const MAX_NESTED_LIST_DEPTH: u8 = 4;

pub(crate) async fn expand_root_entries_to_planned_leafs(
    task_id: &Id,
    client: Arc<dyn YtDlpClient>,
    entries: Vec<LeafReference>,
    group_hint: Option<Group>,
) -> Result<Vec<PlannedLeaf>> {
    let mut pending = entries
        .into_iter()
        .rev()
        .map(|entry| PendingLeafExpansion {
            entry,
            group_hint: group_hint.clone(),
            depth: 0,
        })
        .collect::<Vec<_>>();
    let mut candidates = Vec::new();

    while let Some(next) = pending.pop() {
        let preference = classify_root_preference(&next.entry.url);
        if preference == CollectionSourceKind::Single {
            let url = next.entry.url;
            let id = leaf_id_for(task_id, &url, next.group_hint.as_ref());
            candidates.push(ExpandedLeafCandidate {
                id,
                url,
                title: next.entry.title,
                initial_probe: None,
                group_hint: next.group_hint,
            });
            continue;
        }

        if next.depth >= MAX_NESTED_LIST_DEPTH {
            bail!(
                "nested playlists deeper than {} levels are not supported",
                MAX_NESTED_LIST_DEPTH
            );
        }

        let nested_url = next.entry.url.clone();
        let nested_probe = {
            let client = client.clone();
            let url = nested_url.clone();
            run_blocking(move || client.probe_root(&url)).await?
        };

        match nested_probe {
            RootProbe::Single(leaf) => {
                let leaf_url = leaf.webpage_url.clone();
                candidates.push(ExpandedLeafCandidate {
                    id: leaf_id_for(task_id, &leaf_url, next.group_hint.as_ref()),
                    url: leaf_url,
                    title: Some(leaf.title.clone()),
                    initial_probe: (!should_reprobe_single_leaf(preference)).then_some(leaf),
                    group_hint: next.group_hint,
                });
            }
            RootProbe::List(list) => {
                let nested_group = Some(Group {
                    name: list.title.clone(),
                    url: list.webpage_url.clone(),
                    folder: sanitize_path_component(&list.title),
                });

                for entry in list.entries.into_iter().rev() {
                    pending.push(PendingLeafExpansion {
                        entry,
                        group_hint: nested_group.clone(),
                        depth: next.depth + 1,
                    });
                }
            }
        }
    }

    Ok(assign_normalized_music_titles(candidates))
}

fn assign_normalized_music_titles(candidates: Vec<ExpandedLeafCandidate>) -> Vec<PlannedLeaf> {
    let mut group_titles = HashMap::<String, Vec<String>>::new();
    for candidate in &candidates {
        let Some(title) = &candidate.title else {
            continue;
        };
        group_titles
            .entry(candidate_title_group_key(candidate))
            .or_default()
            .push(title.clone());
    }

    let normalized_by_group = group_titles
        .into_iter()
        .map(|(group, titles)| {
            (
                group,
                collection_import::normalize_music_title_batch(&titles),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut group_offsets = HashMap::<String, usize>::new();

    candidates
        .into_iter()
        .enumerate()
        .map(|(index, candidate)| {
            let group_key = candidate_title_group_key(&candidate);
            let music_title = candidate.title.as_ref().and_then(|_| {
                let offset = group_offsets.entry(group_key.clone()).or_default();
                let title = normalized_by_group
                    .get(&group_key)
                    .and_then(|titles| titles.get(*offset))
                    .cloned();
                *offset += 1;
                title
            });

            PlannedLeaf {
                id: candidate.id,
                url: candidate.url,
                sequence: index as u32,
                initial_probe: candidate.initial_probe,
                music_title,
                group_hint: candidate.group_hint,
            }
        })
        .collect()
}

fn candidate_title_group_key(candidate: &ExpandedLeafCandidate) -> String {
    candidate
        .group_hint
        .as_ref()
        .map(|group| group.url.clone())
        .unwrap_or_default()
}

#[cfg(not(test))]
fn temporary_download_stem(file_stem: &str, task_id: &Id, leaf_id: &Id) -> String {
    format!(
        "{file_stem}.__slisic_tmp__{}",
        short_hash(&format!("{task_id}|{leaf_id}"))
    )
}

#[cfg(not(test))]
async fn resolve_probe_group(
    source_kind: CollectionSourceKind,
    probe: &LeafProbe,
    source_url: &str,
    client: Arc<dyn YtDlpClient>,
    catalog: &mut GroupCatalog,
) -> Option<Group> {
    if source_kind != CollectionSourceKind::List {
        return None;
    }

    if let Some(group) = catalog.resolve(probe) {
        return Some(group);
    }

    if probe.album.is_none() || catalog.discovery_attempted {
        return None;
    }

    catalog.discovery_attempted = true;
    match discover_group_catalog(source_url.to_string(), client).await {
        Ok(groups) => catalog.extend(groups),
        Err(error) => {
            eprintln!("[downloads] group discovery failed: {error}");
        }
    }

    catalog.resolve(probe)
}

/// Group data is leaf-level enrichment: root collection shape stays flat, and
/// album metadata only adds a parent folder when a real playlist URL is known.
#[cfg(not(test))]
async fn discover_group_catalog(
    source_url: String,
    client: Arc<dyn YtDlpClient>,
) -> Result<Vec<Group>> {
    run_blocking(move || discover_group_catalog_blocking(&source_url, client)).await
}

#[cfg(not(test))]
fn discover_group_catalog_blocking(
    source_url: &str,
    client: Arc<dyn YtDlpClient>,
) -> Result<Vec<Group>> {
    let http = group_discovery_http_client()?;
    let mut groups = Vec::new();
    let mut errors = Vec::new();
    let mut seen_urls = BTreeSet::new();

    for candidate_url in group_discovery_source_urls(source_url) {
        match discover_groups_from_source(&http, &candidate_url, client.clone(), &mut seen_urls) {
            Ok(found) => groups.extend(found),
            Err(error) => errors.push(format!("{candidate_url}: {error}")),
        }
    }

    if !groups.is_empty() || errors.is_empty() {
        return Ok(groups);
    }

    bail!("{}", errors.join("; "))
}

#[cfg(not(test))]
fn discover_groups_from_source(
    http: &BlockingHttpClient,
    source_url: &str,
    client: Arc<dyn YtDlpClient>,
    seen_urls: &mut BTreeSet<String>,
) -> Result<Vec<Group>> {
    let html = http
        .get(source_url)
        .send()
        .and_then(|response| response.error_for_status())
        .context("failed to fetch source html")?
        .text()
        .context("failed to read source html")?;

    let mut groups = Vec::new();
    for playlist_id in extract_olak_playlist_ids(&html) {
        let playlist_url = format!("https://www.youtube.com/playlist?list={playlist_id}");
        if !seen_urls.insert(playlist_url.clone()) {
            continue;
        }

        let RootProbe::List(list) = client.probe_root(&playlist_url)? else {
            continue;
        };

        groups.push(Group {
            name: list.title.clone(),
            url: list.webpage_url.clone(),
            folder: sanitize_path_component(&list.title),
        });
    }

    Ok(groups)
}

fn group_discovery_http_client() -> Result<BlockingHttpClient> {
    BlockingHttpClient::builder()
        .user_agent(GROUP_DISCOVERY_USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .context("failed to build group discovery http client")
}

fn group_discovery_source_urls(source_url: &str) -> Vec<String> {
    let mut urls = vec![source_url.to_string()];
    if let Some(channel_url) = derive_youtube_channel_url_from_uploads_playlist(source_url)
        && !urls.contains(&channel_url)
    {
        urls.push(channel_url);
    }
    urls
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
    let _ = download_task_change_sender().send(DownloadTaskChangeSignal {
        task_id: task.id.to_string(),
        task_url: task.url.clone(),
        collection_url: task.collection_url.clone(),
    });
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

        spawn_task(task.id.to_string())?;
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

#[cfg(not(test))]
fn build_client(app: &AppHandle) -> Result<Arc<dyn YtDlpClient>> {
    let ytdlp_path =
        ensure_managed_binary(app, ManagedBinary::YtDlp).map_err(|error| anyhow!(error))?;
    let _ffmpeg_path =
        ensure_managed_binary(app, ManagedBinary::Ffmpeg).map_err(|error| anyhow!(error))?;
    let ffmpeg_dir = managed_bin_dir(app).map_err(|error| anyhow!(error))?;

    Ok(Arc::new(CliYtDlpClient::new(ytdlp_path, ffmpeg_dir)))
}

#[cfg(not(test))]
async fn resolve_save_root(app: &AppHandle) -> Result<PathBuf> {
    meta_service::resolve_save_root(app).await
}

#[cfg(not(test))]
async fn resolve_execution_deps(app: &AppHandle) -> Result<DownloadExecutionDeps> {
    Ok(DownloadExecutionDeps {
        client: build_client(app)?,
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

fn task_id_for(url: &str, trigger: DownloadTrigger) -> String {
    format!(
        "{}-{}",
        match trigger {
            DownloadTrigger::Manual => "manual",
            DownloadTrigger::LocalImport => "local",
            DownloadTrigger::AutoUpdate => "auto",
        },
        stable_id(&format!("{url}|{}", now_timestamp()))
    )
}

fn leaf_id_for(task_id: &Id, leaf_url: &str, group: Option<&Group>) -> Id {
    let group_url = group.map(|group| group.url.as_str()).unwrap_or_default();
    Id::from(stable_id(&format!("{task_id}|{group_url}|{leaf_url}")))
}

fn normalize_url(url: &str) -> Result<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        bail!("download url is empty");
    }

    if let Some(canonical) = normalize_youtube_watch_playlist_item_url(trimmed) {
        return Ok(canonical);
    }

    if let Some(canonical) = normalize_youtube_playlist_url(trimmed) {
        return Ok(canonical);
    }

    if let Some(canonical) = normalize_youtube_direct_leaf_url(trimmed) {
        return Ok(canonical);
    }

    Ok(trimmed.to_string())
}

fn parse_download_url(text: &str) -> std::result::Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Clipboard does not contain a URL.".to_string());
    }

    let parsed =
        Url::parse(trimmed).map_err(|_| "Clipboard does not contain a valid URL.".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(trimmed.to_string()),
        _ => Err("Only http and https URLs can be downloaded.".to_string()),
    }
}

fn normalize_youtube_direct_leaf_url(url: &str) -> Option<String> {
    if !super::yt_dlp::looks_like_direct_leaf_url(url) {
        return None;
    }

    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();

    if host == "youtu.be" {
        let video_id = parsed.path_segments()?.next()?.trim();
        if video_id.is_empty() {
            return None;
        }
        return Some(format!("https://www.youtube.com/watch?v={video_id}"));
    }

    if !host.ends_with("youtube.com") {
        return None;
    }

    let query = parsed.query_pairs().collect::<Vec<_>>();
    if let Some(video_id) = query
        .iter()
        .find(|(key, value)| key == "v" && !value.is_empty())
        .map(|(_, value)| value.to_string())
    {
        let playlist_id = query
            .iter()
            .find(|(key, value)| key == "list" && !value.is_empty())
            .map(|(_, value)| value.to_string());
        let has_non_video_query = query
            .iter()
            .any(|(key, value)| key != "v" && !value.is_empty());
        if has_non_video_query
            && !playlist_id
                .as_deref()
                .is_some_and(is_youtube_mix_playlist_id)
        {
            return None;
        }

        return Some(format!("https://www.youtube.com/watch?v={video_id}"));
    }

    let mut segments = parsed.path_segments()?;
    let scope = segments.next()?;
    let video_id = segments.next()?.trim();
    if video_id.is_empty() {
        return None;
    }

    match scope {
        "shorts" | "live" => Some(format!("https://www.youtube.com/watch?v={video_id}")),
        _ => None,
    }
}

fn normalize_youtube_watch_playlist_item_url(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if !host.ends_with("youtube.com") {
        return None;
    }

    let mut segments = parsed.path_segments()?;
    if segments.next()? != "watch" {
        return None;
    }

    let mut video_id = None;
    let mut has_playlist = false;
    let mut has_index = false;

    for (key, value) in parsed.query_pairs() {
        if value.is_empty() {
            continue;
        }

        match key.as_ref() {
            "v" => video_id = Some(value.to_string()),
            "list" => has_playlist = true,
            "index" => has_index = true,
            _ => {}
        }
    }

    if !has_playlist || !has_index {
        return None;
    }

    video_id.map(|video_id| format!("https://www.youtube.com/watch?v={video_id}"))
}

fn normalize_youtube_playlist_url(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host != "youtu.be" && !host.ends_with("youtube.com") {
        return None;
    }

    let playlist_id = parsed
        .query_pairs()
        .find(|(key, value)| key == "list" && !value.is_empty())
        .map(|(_, value)| value.to_string())?;
    if is_youtube_mix_playlist_id(&playlist_id) {
        return None;
    }

    Some(format!(
        "https://www.youtube.com/playlist?list={playlist_id}"
    ))
}

/// Root probing decides collection shape; full leaf metadata should only be
/// reused when the input was already classified as a direct leaf URL.
pub(crate) fn should_reprobe_single_leaf(preference: CollectionSourceKind) -> bool {
    preference != CollectionSourceKind::Single
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
    group.unwrap_or_else(|| Group {
        name: collection.name.clone(),
        url: collection.url.clone(),
        folder: collection.folder.clone(),
    })
}

fn normalize_group_key(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.to_lowercase())
    }
}

pub(crate) fn derive_youtube_channel_url_from_uploads_playlist(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if !host.ends_with("youtube.com") {
        return None;
    }

    let list_id = parsed
        .query_pairs()
        .find(|(key, value)| key == "list" && value.starts_with("UU"))
        .map(|(_, value)| value.to_string())?;
    Some(format!(
        "https://www.youtube.com/channel/UC{}",
        &list_id[2..]
    ))
}

pub(crate) fn extract_olak_playlist_ids(html: &str) -> BTreeSet<String> {
    const PREFIX: &[u8] = b"OLAK5uy_";

    let bytes = html.as_bytes();
    let mut ids = BTreeSet::new();
    let mut index = 0_usize;
    while index + PREFIX.len() <= bytes.len() {
        if &bytes[index..index + PREFIX.len()] != PREFIX {
            index += 1;
            continue;
        }

        let mut end = index + PREFIX.len();
        while end < bytes.len() {
            let byte = bytes[end];
            if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' {
                end += 1;
            } else {
                break;
            }
        }

        ids.insert(html[index..end].to_string());
        index = end;
    }

    ids
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
