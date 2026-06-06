#[cfg(not(test))]
use super::player::{model::PlaybackTrack, service as player_service};
#[cfg(not(test))]
use super::playlists::repo as playlists_repo;
#[cfg(not(test))]
use crate::utils::binaries::{ManagedBinary, ensure_managed_binary};
#[cfg(not(test))]
use anyhow::{Context, Result, anyhow, bail};
#[cfg(not(test))]
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[cfg(not(test))]
use std::collections::{HashMap, VecDeque};
#[cfg(not(test))]
use std::fs;
use std::path::PathBuf;
#[cfg(not(test))]
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
#[cfg(not(test))]
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(not(test))]
use std::time::Duration;
#[cfg(not(test))]
use tauri::{AppHandle, Manager};
#[cfg(not(test))]
use tokio::task;

#[cfg(not(test))]
const LOUDNESS_EVIDENCE_LOG_TARGET: &str = "loudness_evidence";
#[cfg(not(test))]
const MAX_LOUDNESS_EVIDENCE_QUEUE_LEN: usize = 256;
#[cfg(not(test))]
const MAX_COMPLETED_LOUDNESS_RESULT_COUNT: usize = 256;
#[cfg(not(test))]
const LOUDNESS_MEASUREMENT_COOLDOWN: Duration = Duration::from_millis(1500);
#[cfg(not(test))]
const LOUDNESS_SYNC_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(not(test))]
const LOUDNESS_SYNC_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(not(test))]
const LOUDNESS_PENDING_TASK_FILE_NAME: &str = "loudness-evidence-pending.json";
#[cfg(not(test))]
const LOUDNESS_PENDING_TASK_FILE_VERSION: &str = "loudness-evidence-pending.v1";

#[cfg(not(test))]
static LOUDNESS_EVIDENCE_RUNTIME: OnceLock<Arc<LoudnessEvidenceRuntime>> = OnceLock::new();

#[cfg(not(test))]
struct LoudnessEvidenceRuntime {
    app: AppHandle,
    pending_task_path: PathBuf,
    pending_task_file_lock: Mutex<()>,
    active_binary_tasks: AtomicUsize,
    active_identities: Mutex<HashSet<String>>,
    completed_loudness: Mutex<HashMap<String, f32>>,
    completion_notify: tokio::sync::Notify,
    queue: Mutex<VecDeque<QueuedLoudnessEvidence>>,
    worker_running: AtomicBool,
}

#[cfg(not(test))]
struct QueuedLoudnessEvidence {
    request: LoudnessEvidenceRequest,
    source: LoudnessEvidenceSource,
    _claim: LoudnessIdentityClaim,
}

#[cfg(not(test))]
struct ActiveLoudnessBinaryTaskGuard {
    runtime: Arc<LoudnessEvidenceRuntime>,
}

#[cfg(not(test))]
impl ActiveLoudnessBinaryTaskGuard {
    fn new(runtime: Arc<LoudnessEvidenceRuntime>) -> Self {
        runtime.active_binary_tasks.fetch_add(1, Ordering::SeqCst);
        Self { runtime }
    }
}

#[cfg(not(test))]
impl Drop for ActiveLoudnessBinaryTaskGuard {
    fn drop(&mut self) {
        self.runtime
            .active_binary_tasks
            .fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(not(test))]
struct LoudnessIdentityClaim {
    runtime: Arc<LoudnessEvidenceRuntime>,
    key: String,
}

#[cfg(not(test))]
impl Drop for LoudnessIdentityClaim {
    fn drop(&mut self) {
        if let Ok(mut active) = self.runtime.active_identities.lock() {
            active.remove(&self.key);
        }
        self.runtime.completion_notify.notify_waiters();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LoudnessEvidenceRequest {
    pub(crate) canonical_music_id: String,
    pub(crate) url: String,
    pub(crate) file_path: PathBuf,
    pub(crate) start_ms: u32,
    pub(crate) end_ms: u32,
}

#[cfg(not(test))]
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LoudnessPendingTaskFile {
    version: String,
    requests: Vec<LoudnessPendingTaskEntry>,
}

#[cfg(not(test))]
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LoudnessPendingTaskEntry {
    canonical_music_id: String,
    url: String,
    file_path: PathBuf,
    start_ms: u32,
    end_ms: u32,
}

#[cfg(not(test))]
impl From<&LoudnessEvidenceRequest> for LoudnessPendingTaskEntry {
    fn from(request: &LoudnessEvidenceRequest) -> Self {
        Self {
            canonical_music_id: request.canonical_music_id.clone(),
            url: request.url.clone(),
            file_path: request.file_path.clone(),
            start_ms: request.start_ms,
            end_ms: request.end_ms,
        }
    }
}

#[cfg(not(test))]
impl From<LoudnessPendingTaskEntry> for LoudnessEvidenceRequest {
    fn from(entry: LoudnessPendingTaskEntry) -> Self {
        Self {
            canonical_music_id: entry.canonical_music_id,
            url: entry.url,
            file_path: entry.file_path,
            start_ms: entry.start_ms,
            end_ms: entry.end_ms,
        }
    }
}

#[cfg(not(test))]
pub(crate) fn initialize_runtime(app: AppHandle) {
    let runtime = LOUDNESS_EVIDENCE_RUNTIME
        .get_or_init(|| {
            let pending_task_path = loudness_pending_task_path(&app).unwrap_or_else(|error| {
                log::error!(
                    target: LOUDNESS_EVIDENCE_LOG_TARGET,
                    "loudness_evidence_pending_path_failed error=\"{}\"",
                    error
                );
                PathBuf::new()
            });
            Arc::new(LoudnessEvidenceRuntime {
                app,
                pending_task_path,
                pending_task_file_lock: Mutex::new(()),
                active_binary_tasks: AtomicUsize::new(0),
                active_identities: Mutex::new(HashSet::new()),
                completed_loudness: Mutex::new(HashMap::new()),
                completion_notify: tokio::sync::Notify::new(),
                queue: Mutex::new(VecDeque::new()),
                worker_running: AtomicBool::new(false),
            })
        })
        .clone();

    restore_pending_loudness_tasks(runtime);
}

#[cfg(not(test))]
pub(crate) fn has_active_loudness_binary_tasks() -> bool {
    let Some(runtime) = LOUDNESS_EVIDENCE_RUNTIME.get() else {
        return false;
    };

    runtime.active_binary_tasks.load(Ordering::SeqCst) > 0
}

#[cfg(not(test))]
pub(crate) fn request_track_loudness_evidence(request: LoudnessEvidenceRequest) {
    let Some(runtime) = LOUDNESS_EVIDENCE_RUNTIME.get().cloned() else {
        log::warn!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_request_skipped reason=runtime_uninitialized canonical_music_id=\"{}\"",
            request.canonical_music_id
        );
        return;
    };

    enqueue_loudness_measurement(runtime, request, LoudnessEvidenceSource::DirectRequest);
}

#[cfg(not(test))]
pub(crate) fn request_playback_track_loudness_evidence(track: &PlaybackTrack) {
    if track.loudness != 0.0 {
        return;
    }
    let request = LoudnessEvidenceRequest {
        canonical_music_id: track.canonical_music_id.clone(),
        url: track.music_url.clone(),
        file_path: track.file_path.clone(),
        start_ms: track.start_ms,
        end_ms: track.end_ms,
    };

    request_track_loudness_evidence(request);
}

#[cfg(not(test))]
pub(crate) async fn measure_playback_track_loudness_now(
    track: &PlaybackTrack,
) -> Result<Option<f32>> {
    if track.loudness != 0.0 {
        return Ok(Some(track.loudness));
    }
    let Some(runtime) = LOUDNESS_EVIDENCE_RUNTIME.get().cloned() else {
        log::warn!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_wait_skipped reason=runtime_uninitialized canonical_music_id=\"{}\"",
            track.canonical_music_id
        );
        return Ok(None);
    };
    let request = LoudnessEvidenceRequest {
        canonical_music_id: track.canonical_music_id.clone(),
        url: track.music_url.clone(),
        file_path: track.file_path.clone(),
        start_ms: track.start_ms,
        end_ms: track.end_ms,
    };
    let key = loudness_identity_key(&request);
    if let Some(loudness) = completed_loudness_result(&runtime, &key)? {
        return Ok(Some(loudness));
    }

    let claim = match claim_loudness_identity(Arc::clone(&runtime), &request)? {
        Some(claim) => claim,
        None => {
            if promote_queued_loudness_identity(&runtime, &request) {
                persist_pending_loudness_request(&runtime, &request);
                ensure_loudness_worker(Arc::clone(&runtime));
            }
            return wait_for_loudness_identity_result(&runtime, &key).await;
        }
    };

    let loudness = measure_and_persist_loudness(
        Arc::clone(&runtime),
        &request,
        LoudnessEvidenceSource::DirectRequest,
    )
    .await?;
    remove_pending_loudness_request(&runtime, &request);
    drop(claim);
    Ok(Some(loudness))
}

#[cfg(test)]
pub(crate) fn request_track_loudness_evidence(_request: LoudnessEvidenceRequest) {}

#[cfg(test)]
pub(crate) fn request_playback_track_loudness_evidence(
    _track: &super::player::model::PlaybackTrack,
) {
}

#[cfg(test)]
pub(crate) async fn measure_playback_track_loudness_now(
    _track: &super::player::model::PlaybackTrack,
) -> anyhow::Result<Option<f32>> {
    Ok(None)
}

#[cfg(not(test))]
#[derive(Debug, Clone, Copy)]
enum LoudnessEvidenceSource {
    PendingStore,
    DirectRequest,
}

#[cfg(not(test))]
impl LoudnessEvidenceSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::PendingStore => "pending_store",
            Self::DirectRequest => "direct_request",
        }
    }
}

#[cfg(not(test))]
fn restore_pending_loudness_tasks(runtime: Arc<LoudnessEvidenceRuntime>) {
    if runtime.pending_task_path.as_os_str().is_empty() {
        return;
    }
    if !runtime.pending_task_path.is_file() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        if let Err(error) = restore_pending_loudness_tasks_from_disk(runtime).await {
            log::error!(
                target: LOUDNESS_EVIDENCE_LOG_TARGET,
                "loudness_evidence_pending_restore_failed error=\"{}\"",
                error
            );
        }
    });
}

#[cfg(not(test))]
async fn restore_pending_loudness_tasks_from_disk(
    runtime: Arc<LoudnessEvidenceRuntime>,
) -> Result<()> {
    let pending = {
        let _guard = runtime
            .pending_task_file_lock
            .lock()
            .map_err(|_| anyhow!("loudness evidence pending task file lock is poisoned"))?;
        read_loudness_pending_task_file(&runtime.pending_task_path)?
    };
    let total = pending.len();

    for request in pending {
        enqueue_loudness_measurement(
            Arc::clone(&runtime),
            request,
            LoudnessEvidenceSource::PendingStore,
        );
    }

    if total > 0 {
        log::info!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_pending_restored count={}",
            total
        );
    }

    Ok(())
}

#[cfg(not(test))]
fn loudness_pending_task_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| anyhow!("failed to resolve app local data directory: {error}"))?
        .join(LOUDNESS_PENDING_TASK_FILE_NAME))
}

#[cfg(not(test))]
fn enqueue_loudness_measurement(
    runtime: Arc<LoudnessEvidenceRuntime>,
    request: LoudnessEvidenceRequest,
    source: LoudnessEvidenceSource,
) {
    let claim = match claim_loudness_identity(Arc::clone(&runtime), &request) {
        Ok(Some(claim)) => claim,
        Ok(None) => {
            if matches!(source, LoudnessEvidenceSource::DirectRequest)
                && promote_queued_loudness_identity(&runtime, &request)
            {
                persist_pending_loudness_request(&runtime, &request);
                ensure_loudness_worker(runtime);
            }
            return;
        }
        Err(error) => {
            log::error!(
                target: LOUDNESS_EVIDENCE_LOG_TARGET,
                "loudness_evidence_request_failed reason=claim_failed canonical_music_id=\"{}\" error=\"{}\"",
                request.canonical_music_id,
                error
            );
            return;
        }
    };

    if !push_loudness_queue(
        &runtime,
        QueuedLoudnessEvidence {
            request: request.clone(),
            source,
            _claim: claim,
        },
    ) {
        return;
    }

    if matches!(source, LoudnessEvidenceSource::DirectRequest) {
        persist_pending_loudness_request(&runtime, &request);
    }
    ensure_loudness_worker(runtime);
}

#[cfg(not(test))]
fn promote_queued_loudness_identity(
    runtime: &Arc<LoudnessEvidenceRuntime>,
    request: &LoudnessEvidenceRequest,
) -> bool {
    let key = loudness_identity_key(request);
    let mut queue = match runtime.queue.lock() {
        Ok(queue) => queue,
        Err(_) => {
            log::error!(
                target: LOUDNESS_EVIDENCE_LOG_TARGET,
                "loudness_evidence_request_failed reason=queue_lock_poisoned"
            );
            return false;
        }
    };

    let Some(position) = queue
        .iter()
        .position(|queued| loudness_identity_key(&queued.request) == key)
    else {
        return false;
    };
    let Some(mut queued) = queue.remove(position) else {
        return false;
    };
    queued.request = request.clone();
    queued.source = LoudnessEvidenceSource::DirectRequest;
    queue.push_front(queued);
    true
}

#[cfg(not(test))]
fn push_loudness_queue(
    runtime: &Arc<LoudnessEvidenceRuntime>,
    queued: QueuedLoudnessEvidence,
) -> bool {
    let mut queue = match runtime.queue.lock() {
        Ok(queue) => queue,
        Err(_) => {
            log::error!(
                target: LOUDNESS_EVIDENCE_LOG_TARGET,
                "loudness_evidence_request_failed reason=queue_lock_poisoned"
            );
            return false;
        }
    };

    if queue.len() >= MAX_LOUDNESS_EVIDENCE_QUEUE_LEN {
        match queued.source {
            LoudnessEvidenceSource::DirectRequest => {
                queue.pop_back();
            }
            LoudnessEvidenceSource::PendingStore => return false,
        }
    }

    match queued.source {
        LoudnessEvidenceSource::DirectRequest => queue.push_front(queued),
        LoudnessEvidenceSource::PendingStore => queue.push_back(queued),
    }
    true
}

#[cfg(not(test))]
fn ensure_loudness_worker(runtime: Arc<LoudnessEvidenceRuntime>) {
    if runtime
        .worker_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    tauri::async_runtime::spawn(async move {
        run_loudness_worker(runtime).await;
    });
}

#[cfg(not(test))]
async fn run_loudness_worker(runtime: Arc<LoudnessEvidenceRuntime>) {
    loop {
        let Some(queued) = pop_loudness_queue(&runtime) else {
            runtime.worker_running.store(false, Ordering::SeqCst);
            if queue_has_pending_loudness(&runtime) {
                ensure_loudness_worker(Arc::clone(&runtime));
            }
            return;
        };

        match measure_and_persist_loudness(Arc::clone(&runtime), &queued.request, queued.source)
            .await
        {
            Ok(_) => remove_pending_loudness_request(&runtime, &queued.request),
            Err(error) => {
                if should_close_loudness_request_after_error(&error) {
                    remove_pending_loudness_request(&runtime, &queued.request);
                }
                log::error!(
                    target: LOUDNESS_EVIDENCE_LOG_TARGET,
                    "loudness_evidence_measurement_failed source={} error=\"{}\"",
                    queued.source.as_str(),
                    error
                );
            }
        }

        drop(queued);
        tokio::time::sleep(LOUDNESS_MEASUREMENT_COOLDOWN).await;
    }
}

#[cfg(not(test))]
fn pop_loudness_queue(runtime: &LoudnessEvidenceRuntime) -> Option<QueuedLoudnessEvidence> {
    runtime.queue.lock().ok()?.pop_front()
}

#[cfg(not(test))]
fn queue_has_pending_loudness(runtime: &LoudnessEvidenceRuntime) -> bool {
    runtime
        .queue
        .lock()
        .ok()
        .is_some_and(|queue| !queue.is_empty())
}

#[cfg(not(test))]
fn claim_loudness_identity(
    runtime: Arc<LoudnessEvidenceRuntime>,
    request: &LoudnessEvidenceRequest,
) -> Result<Option<LoudnessIdentityClaim>> {
    let key = loudness_identity_key(request);
    let mut active = runtime
        .active_identities
        .lock()
        .map_err(|_| anyhow!("loudness evidence identity set is poisoned"))?;
    if !active.insert(key.clone()) {
        return Ok(None);
    }
    drop(active);

    Ok(Some(LoudnessIdentityClaim { runtime, key }))
}

#[cfg(not(test))]
fn completed_loudness_result(runtime: &LoudnessEvidenceRuntime, key: &str) -> Result<Option<f32>> {
    let completed = runtime
        .completed_loudness
        .lock()
        .map_err(|_| anyhow!("loudness evidence completed result map is poisoned"))?;
    Ok(completed.get(key).copied())
}

#[cfg(not(test))]
fn remember_completed_loudness_result(
    runtime: &LoudnessEvidenceRuntime,
    request: &LoudnessEvidenceRequest,
    loudness: f32,
) -> Result<()> {
    let key = loudness_identity_key(request);
    let mut completed = runtime
        .completed_loudness
        .lock()
        .map_err(|_| anyhow!("loudness evidence completed result map is poisoned"))?;
    if completed.len() >= MAX_COMPLETED_LOUDNESS_RESULT_COUNT
        && !completed.contains_key(&key)
        && let Some(stale_key) = completed.keys().next().cloned()
    {
        completed.remove(&stale_key);
    }
    completed.insert(key, loudness);
    runtime.completion_notify.notify_waiters();
    Ok(())
}

#[cfg(not(test))]
fn loudness_identity_active(runtime: &LoudnessEvidenceRuntime, key: &str) -> Result<bool> {
    let active = runtime
        .active_identities
        .lock()
        .map_err(|_| anyhow!("loudness evidence identity set is poisoned"))?;
    Ok(active.contains(key))
}

#[cfg(not(test))]
async fn wait_for_loudness_identity_result(
    runtime: &Arc<LoudnessEvidenceRuntime>,
    key: &str,
) -> Result<Option<f32>> {
    let wait = async {
        loop {
            let notified = runtime.completion_notify.notified();
            if let Some(loudness) = completed_loudness_result(runtime, key)? {
                return Ok(Some(loudness));
            }
            if !loudness_identity_active(runtime, key)? {
                return Ok(None);
            }
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep(LOUDNESS_SYNC_WAIT_POLL_INTERVAL) => {}
            }
        }
    };

    match tokio::time::timeout(LOUDNESS_SYNC_WAIT_TIMEOUT, wait).await {
        Ok(result) => result,
        Err(_) => Ok(None),
    }
}

fn loudness_identity_key(request: &LoudnessEvidenceRequest) -> String {
    format!(
        "{}:{}:{}",
        request.canonical_music_id, request.start_ms, request.end_ms
    )
}

#[cfg(not(test))]
fn persist_pending_loudness_request(
    runtime: &LoudnessEvidenceRuntime,
    request: &LoudnessEvidenceRequest,
) {
    if runtime.pending_task_path.as_os_str().is_empty() {
        return;
    }

    let Ok(_guard) = runtime.pending_task_file_lock.lock() else {
        log::error!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_pending_write_failed error=\"pending_task_file_lock_poisoned\""
        );
        return;
    };
    if let Err(error) = upsert_loudness_pending_task_file(&runtime.pending_task_path, request) {
        log::error!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_pending_write_failed error=\"{}\"",
            error
        );
    }
}

#[cfg(not(test))]
fn remove_pending_loudness_request(
    runtime: &LoudnessEvidenceRuntime,
    request: &LoudnessEvidenceRequest,
) {
    if runtime.pending_task_path.as_os_str().is_empty() {
        return;
    }

    let Ok(_guard) = runtime.pending_task_file_lock.lock() else {
        log::error!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_pending_remove_failed error=\"pending_task_file_lock_poisoned\""
        );
        return;
    };
    if let Err(error) = remove_loudness_pending_task_from_file(&runtime.pending_task_path, request)
    {
        log::error!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_pending_remove_failed error=\"{}\"",
            error
        );
    }
}

#[cfg(not(test))]
fn read_loudness_pending_task_file(path: &std::path::Path) -> Result<Vec<LoudnessEvidenceRequest>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(anyhow!(
                "failed to read loudness pending task file `{}`: {error}",
                path.display()
            ));
        }
    };
    let file: LoudnessPendingTaskFile = serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "failed to parse loudness pending task file `{}`",
            path.display()
        )
    })?;
    if file.version != LOUDNESS_PENDING_TASK_FILE_VERSION {
        return Err(anyhow!(
            "unsupported loudness pending task file version `{}` in `{}`",
            file.version,
            path.display()
        ));
    }

    Ok(deduplicate_pending_loudness_requests(
        file.requests.into_iter().map(Into::into).collect(),
    ))
}

#[cfg(not(test))]
fn upsert_loudness_pending_task_file(
    path: &std::path::Path,
    request: &LoudnessEvidenceRequest,
) -> Result<()> {
    let mut requests = read_loudness_pending_task_file(path)?;
    requests.retain(|existing| loudness_identity_key(existing) != loudness_identity_key(request));
    requests.push(request.clone());
    write_loudness_pending_task_file(path, &requests)
}

#[cfg(not(test))]
fn remove_loudness_pending_task_from_file(
    path: &std::path::Path,
    request: &LoudnessEvidenceRequest,
) -> Result<()> {
    let mut requests = read_loudness_pending_task_file(path)?;
    let key = loudness_identity_key(request);
    requests.retain(|existing| loudness_identity_key(existing) != key);
    write_loudness_pending_task_file(path, &requests)
}

#[cfg(not(test))]
fn write_loudness_pending_task_file(
    path: &std::path::Path,
    requests: &[LoudnessEvidenceRequest],
) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create loudness pending task directory `{}`",
                parent.display()
            )
        })?;
    }

    if requests.is_empty() {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(anyhow!(
                    "failed to remove loudness pending task file `{}`: {error}",
                    path.display()
                ));
            }
        }
        return Ok(());
    }

    let file = LoudnessPendingTaskFile {
        version: LOUDNESS_PENDING_TASK_FILE_VERSION.to_string(),
        requests: requests
            .iter()
            .map(LoudnessPendingTaskEntry::from)
            .collect(),
    };
    let bytes =
        serde_json::to_vec_pretty(&file).context("failed to encode loudness pending tasks")?;
    fs::write(path, bytes).with_context(|| {
        format!(
            "failed to write loudness pending task file `{}`",
            path.display()
        )
    })?;
    Ok(())
}

fn deduplicate_pending_loudness_requests(
    requests: Vec<LoudnessEvidenceRequest>,
) -> Vec<LoudnessEvidenceRequest> {
    let mut seen = HashSet::new();
    let mut deduplicated = Vec::new();
    for request in requests.into_iter().rev() {
        if seen.insert(loudness_identity_key(&request)) {
            deduplicated.push(request);
        }
    }
    deduplicated.reverse();
    deduplicated
}

#[cfg(not(test))]
fn should_close_loudness_request_after_error(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("invalid loudness evidence range")
        || message.contains("missing loudness evidence audio file")
        || message.contains("music loudness evidence must be a finite non-zero LUFS value")
        || message.contains("player session loudness evidence must be finite and non-zero")
}

#[cfg(test)]
pub(crate) fn loudness_identity_key_for_test(request: &LoudnessEvidenceRequest) -> String {
    loudness_identity_key(request)
}

#[cfg(test)]
pub(crate) fn deduplicate_pending_loudness_requests_for_test(
    requests: Vec<LoudnessEvidenceRequest>,
) -> Vec<LoudnessEvidenceRequest> {
    deduplicate_pending_loudness_requests(requests)
}

#[cfg(test)]
#[path = "loudness_evidence.test.rs"]
mod tests;

#[cfg(not(test))]
async fn measure_and_persist_loudness(
    runtime: Arc<LoudnessEvidenceRuntime>,
    request: &LoudnessEvidenceRequest,
    source: LoudnessEvidenceSource,
) -> Result<f32> {
    if request.start_ms >= request.end_ms {
        bail!(
            "invalid loudness evidence range {}..{} for {}",
            request.start_ms,
            request.end_ms,
            request.canonical_music_id
        );
    }
    if !request.file_path.is_file() {
        bail!(
            "missing loudness evidence audio file {}",
            request.file_path.display()
        );
    }

    let _guard = ActiveLoudnessBinaryTaskGuard::new(Arc::clone(&runtime));
    let ffmpeg_path = ensure_managed_binary(&runtime.app, ManagedBinary::Ffmpeg)
        .map_err(|error| anyhow!(error))?;
    let analysis = run_loudness_analysis(ffmpeg_path, request.clone()).await?;
    let updated = playlists_repo::set_music_loudness_by_identity(
        &request.url,
        request.start_ms,
        request.end_ms,
        analysis.integrated_lufs,
    )
    .await?;

    let persisted = updated
        .as_ref()
        .map(|music| music.loudness)
        .unwrap_or(analysis.integrated_lufs);
    player_service::publish_loudness_evidence_to_current_session(&request, persisted)?;
    remember_completed_loudness_result(&runtime, request, persisted)?;
    log::info!(
        target: LOUDNESS_EVIDENCE_LOG_TARGET,
        "loudness_evidence_persisted source={} canonical_music_id=\"{}\" loudness={:.3}",
        source.as_str(),
        request.canonical_music_id,
        persisted
    );

    Ok(persisted)
}

#[cfg(not(test))]
async fn run_loudness_analysis(
    ffmpeg_path: PathBuf,
    request: LoudnessEvidenceRequest,
) -> Result<ffplayr::AudioLoudnessAnalysis> {
    task::spawn_blocking(move || {
        ffplayr::analyze_loudness_with_binary(
            &ffmpeg_path,
            ffplayr::AudioLoudnessAnalysisRequest {
                path: request.file_path,
                time_range: Some(ffplayr::PlaybackTimeRange {
                    start_ms: request.start_ms,
                    duration_ms: Some(request.end_ms.saturating_sub(request.start_ms)),
                }),
            },
        )
        .map_err(anyhow::Error::msg)
    })
    .await
    .context("loudness evidence worker panicked")?
}
