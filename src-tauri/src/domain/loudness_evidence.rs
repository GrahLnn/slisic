use super::player::model::PlaybackTrack;
#[cfg(not(test))]
use super::player::service as player_service;
#[cfg(not(test))]
use super::playlist_playback::playable_index;
use super::playlists::model::LoudnessProfile;
#[cfg(not(test))]
use super::playlists::repo as playlists_repo;
#[cfg(not(test))]
use crate::utils::binaries::{ManagedBinary, ensure_managed_binary};
#[cfg(not(test))]
use anyhow::bail;
use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
#[cfg(not(test))]
use std::collections::VecDeque;
use std::collections::{HashMap, HashSet};
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
const LOUDNESS_MEASUREMENT_COOLDOWN: Duration = Duration::from_millis(1500);
#[cfg(not(test))]
const LOUDNESS_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(not(test))]
const LOUDNESS_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(not(test))]
const LOUDNESS_REQUEST_REBIND_ATTEMPT_LIMIT: usize = 3;
pub(crate) const LOUDNESS_PENDING_TASK_FILE_NAME: &str = "loudness-evidence-pending.json";
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
    published_profiles: Mutex<HashMap<String, LoudnessProfile>>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LoudnessPendingTaskFile {
    version: String,
    requests: Vec<LoudnessPendingTaskEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LoudnessPendingTaskEntry {
    canonical_music_id: String,
    url: String,
    file_path: PathBuf,
    start_ms: u32,
    end_ms: u32,
}

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
                published_profiles: Mutex::new(HashMap::new()),
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
pub(crate) fn request_downloaded_leaf_loudness_evidence(request: LoudnessEvidenceRequest) {
    let Some(runtime) = LOUDNESS_EVIDENCE_RUNTIME.get().cloned() else {
        log::warn!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_request_skipped reason=runtime_uninitialized source=downloaded_leaf canonical_music_id=\"{}\"",
            request.canonical_music_id
        );
        return;
    };

    enqueue_loudness_measurement(runtime, request, LoudnessEvidenceSource::DownloadedLeaf);
}

#[cfg(not(test))]
pub(crate) fn request_audio_tail_trim_loudness_evidence(request: LoudnessEvidenceRequest) {
    let Some(runtime) = LOUDNESS_EVIDENCE_RUNTIME.get().cloned() else {
        log::warn!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_request_skipped reason=runtime_uninitialized source=audio_tail_trim canonical_music_id=\"{}\"",
            request.canonical_music_id
        );
        return;
    };

    enqueue_loudness_measurement(runtime, request, LoudnessEvidenceSource::AudioTailTrim);
}

#[cfg(not(test))]
pub(crate) fn request_playback_track_loudness_evidence(track: &PlaybackTrack) {
    let Some(request) = loudness_request_from_playback_track(track) else {
        return;
    };

    request_track_loudness_evidence(request);
}

#[cfg(not(test))]
pub(crate) fn request_first_slot_playback_track_loudness_evidence(track: &PlaybackTrack) {
    let Some(request) = loudness_request_from_playback_track(track) else {
        return;
    };
    let Some(runtime) = LOUDNESS_EVIDENCE_RUNTIME.get().cloned() else {
        log::warn!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_request_skipped reason=runtime_uninitialized source=first_slot canonical_music_id=\"{}\"",
            request.canonical_music_id
        );
        return;
    };

    enqueue_loudness_measurement(runtime, request, LoudnessEvidenceSource::FirstSlot);
}

#[cfg(not(test))]
pub(crate) async fn wait_for_playback_track_loudness_profile(
    track: &PlaybackTrack,
) -> Result<Option<LoudnessProfile>> {
    let Some(request) = loudness_request_from_playback_track(track) else {
        return Ok(track.loudness_profile);
    };
    let Some(runtime) = LOUDNESS_EVIDENCE_RUNTIME.get().cloned() else {
        log::warn!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_wait_skipped reason=runtime_uninitialized canonical_music_id=\"{}\"",
            request.canonical_music_id
        );
        return Ok(None);
    };

    if let Some(persisted) =
        persisted_loudness_profile_for_request(&request, LoudnessEvidenceSource::DirectRequest)
            .await?
    {
        return Ok(Some(persisted));
    }
    if let Some(profile) = published_loudness_profile_for_request(&runtime, &request)? {
        return Ok(Some(profile));
    }

    enqueue_loudness_measurement(
        Arc::clone(&runtime),
        request.clone(),
        LoudnessEvidenceSource::DirectRequest,
    );
    wait_for_loudness_profile_request_result(&runtime, &request).await
}

fn loudness_request_from_playback_track(track: &PlaybackTrack) -> Option<LoudnessEvidenceRequest> {
    if track.loudness_profile.is_some() {
        return None;
    }
    Some(LoudnessEvidenceRequest {
        canonical_music_id: track.canonical_music_id.clone(),
        url: track.music_url.clone(),
        file_path: track.file_path.clone(),
        start_ms: track.start_ms,
        end_ms: track.end_ms,
    })
}

#[cfg(test)]
pub(crate) fn request_track_loudness_evidence(_request: LoudnessEvidenceRequest) {}

#[cfg(test)]
pub(crate) fn request_playback_track_loudness_evidence(
    _track: &super::player::model::PlaybackTrack,
) {
}

#[cfg(test)]
pub(crate) fn request_first_slot_playback_track_loudness_evidence(
    _track: &super::player::model::PlaybackTrack,
) {
}

#[cfg(test)]
pub(crate) async fn wait_for_playback_track_loudness_profile(
    _track: &super::player::model::PlaybackTrack,
) -> anyhow::Result<Option<LoudnessProfile>> {
    Ok(None)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoudnessEvidenceSource {
    PendingStore,
    DownloadedLeaf,
    AudioTailTrim,
    DirectRequest,
    FirstSlot,
}

impl LoudnessEvidenceSource {
    #[cfg(not(test))]
    fn as_str(self) -> &'static str {
        match self {
            Self::PendingStore => "pending_store",
            Self::DownloadedLeaf => "downloaded_leaf",
            Self::AudioTailTrim => "audio_tail_trim",
            Self::DirectRequest => "direct_request",
            Self::FirstSlot => "first_slot",
        }
    }

    fn priority(self) -> u8 {
        match self {
            Self::PendingStore => 0,
            Self::DownloadedLeaf => 1,
            Self::AudioTailTrim => 1,
            Self::DirectRequest => 2,
            Self::FirstSlot => 3,
        }
    }

    fn persists_pending(self) -> bool {
        matches!(
            self,
            Self::DownloadedLeaf | Self::AudioTailTrim | Self::DirectRequest | Self::FirstSlot
        )
    }
}

#[cfg(not(test))]
fn restore_pending_loudness_tasks(runtime: Arc<LoudnessEvidenceRuntime>) {
    if runtime.pending_task_path.as_os_str().is_empty() {
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
            if source.persists_pending()
                && promote_queued_loudness_identity(&runtime, &request, source)
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
        if source.persists_pending() {
            persist_pending_loudness_request(&runtime, &request);
        }
        log::warn!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_request_deferred source={} reason=queue_unavailable canonical_music_id=\"{}\" pending_retained={}",
            source.as_str(),
            request.canonical_music_id,
            source.persists_pending()
        );
        return;
    }

    if source.persists_pending() {
        persist_pending_loudness_request(&runtime, &request);
    }
    ensure_loudness_worker(runtime);
}

#[cfg(not(test))]
fn promote_queued_loudness_identity(
    runtime: &Arc<LoudnessEvidenceRuntime>,
    request: &LoudnessEvidenceRequest,
    source: LoudnessEvidenceSource,
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
    let previous_source = queued.source;
    queued.request = request.clone();
    queued.source = if source.priority() > previous_source.priority() {
        source
    } else {
        previous_source
    };
    insert_loudness_queue(&mut queue, queued);
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
            LoudnessEvidenceSource::PendingStore
            | LoudnessEvidenceSource::DownloadedLeaf
            | LoudnessEvidenceSource::AudioTailTrim => return false,
            LoudnessEvidenceSource::DirectRequest | LoudnessEvidenceSource::FirstSlot => {
                queue.pop_back();
            }
        }
    }

    insert_loudness_queue(&mut queue, queued);
    true
}

#[cfg(not(test))]
fn insert_loudness_queue(
    queue: &mut VecDeque<QueuedLoudnessEvidence>,
    queued: QueuedLoudnessEvidence,
) {
    let index = loudness_queue_insert_index(
        queue.iter().map(|current| current.source),
        queue.len(),
        queued.source,
    );
    queue.insert(index, queued);
}

fn loudness_queue_insert_index(
    current_sources: impl IntoIterator<Item = LoudnessEvidenceSource>,
    current_len: usize,
    source: LoudnessEvidenceSource,
) -> usize {
    let priority = source.priority();
    if priority == LoudnessEvidenceSource::PendingStore.priority() {
        return current_len;
    }
    current_sources
        .into_iter()
        .position(|current| current.priority() <= priority)
        .unwrap_or(current_len)
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
                if is_stale_loudness_target_error(&error) {
                    log::info!(
                        target: LOUDNESS_EVIDENCE_LOG_TARGET,
                        "loudness_evidence_request_obsolete source={} reason=target_identity_moved error=\"{}\"",
                        queued.source.as_str(),
                        error
                    );
                } else {
                    log::error!(
                        target: LOUDNESS_EVIDENCE_LOG_TARGET,
                        "loudness_evidence_measurement_failed source={} error=\"{}\"",
                        queued.source.as_str(),
                        error
                    );
                }
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
async fn wait_for_loudness_profile_request_result(
    runtime: &Arc<LoudnessEvidenceRuntime>,
    request: &LoudnessEvidenceRequest,
) -> Result<Option<LoudnessProfile>> {
    let key = loudness_identity_key(request);
    let wait = async {
        loop {
            if let Some(profile) = persisted_loudness_profile_for_request(
                request,
                LoudnessEvidenceSource::DirectRequest,
            )
            .await?
            {
                return Ok(Some(profile));
            }
            if let Some(profile) = published_loudness_profile_for_request(runtime, request)? {
                return Ok(Some(profile));
            }
            if !loudness_identity_active(runtime, &key)? {
                if let Some(profile) = published_loudness_profile_for_request(runtime, request)? {
                    return Ok(Some(profile));
                }
                return Ok(None);
            }
            let notified = runtime.completion_notify.notified();
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep(LOUDNESS_WAIT_POLL_INTERVAL) => {}
            }
        }
    };

    match tokio::time::timeout(LOUDNESS_WAIT_TIMEOUT, wait).await {
        Ok(result) => result,
        Err(_) => Ok(None),
    }
}

#[cfg(not(test))]
fn loudness_identity_active(runtime: &LoudnessEvidenceRuntime, key: &str) -> Result<bool> {
    let active = runtime
        .active_identities
        .lock()
        .map_err(|_| anyhow!("loudness evidence identity set is poisoned"))?;
    Ok(active.contains(key))
}

fn loudness_identity_key(request: &LoudnessEvidenceRequest) -> String {
    format!(
        "{}:{}:{}",
        request.canonical_music_id, request.start_ms, request.end_ms
    )
}

fn remember_published_loudness_profile(
    profiles: &mut HashMap<String, LoudnessProfile>,
    request: &LoudnessEvidenceRequest,
    profile: LoudnessProfile,
) {
    profiles.insert(loudness_identity_key(request), profile);
}

fn read_published_loudness_profile(
    profiles: &HashMap<String, LoudnessProfile>,
    request: &LoudnessEvidenceRequest,
) -> Option<LoudnessProfile> {
    profiles.get(&loudness_identity_key(request)).copied()
}

#[cfg(not(test))]
fn publish_loudness_profile_to_runtime(
    request: &LoudnessEvidenceRequest,
    profile: LoudnessProfile,
) {
    let Some(runtime) = LOUDNESS_EVIDENCE_RUNTIME.get() else {
        return;
    };
    let Ok(mut profiles) = runtime.published_profiles.lock() else {
        log::warn!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_publish_cache_failed reason=published_profile_lock_poisoned canonical_music_id=\"{}\"",
            request.canonical_music_id
        );
        return;
    };
    remember_published_loudness_profile(&mut profiles, request, profile);
}

#[cfg(not(test))]
fn published_loudness_profile_for_request(
    runtime: &LoudnessEvidenceRuntime,
    request: &LoudnessEvidenceRequest,
) -> Result<Option<LoudnessProfile>> {
    let profiles = runtime
        .published_profiles
        .lock()
        .map_err(|_| anyhow!("loudness evidence published profile lock is poisoned"))?;
    Ok(read_published_loudness_profile(&profiles, request))
}

#[cfg(test)]
pub(crate) fn remember_published_loudness_profile_for_test(
    profiles: &mut HashMap<String, LoudnessProfile>,
    request: &LoudnessEvidenceRequest,
    profile: LoudnessProfile,
) {
    remember_published_loudness_profile(profiles, request, profile);
}

#[cfg(test)]
pub(crate) fn read_published_loudness_profile_for_test(
    profiles: &HashMap<String, LoudnessProfile>,
    request: &LoudnessEvidenceRequest,
) -> Option<LoudnessProfile> {
    read_published_loudness_profile(profiles, request)
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

fn upsert_loudness_pending_task_file(
    path: &std::path::Path,
    request: &LoudnessEvidenceRequest,
) -> Result<()> {
    let mut requests = read_loudness_pending_task_file(path)?;
    requests.retain(|existing| loudness_identity_key(existing) != loudness_identity_key(request));
    requests.push(request.clone());
    write_loudness_pending_task_file(path, &requests)
}

fn remove_loudness_pending_task_from_file(
    path: &std::path::Path,
    request: &LoudnessEvidenceRequest,
) -> Result<()> {
    let mut requests = read_loudness_pending_task_file(path)?;
    let key = loudness_identity_key(request);
    requests.retain(|existing| loudness_identity_key(existing) != key);
    write_loudness_pending_task_file(path, &requests)
}

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

fn should_close_loudness_request_after_error(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("invalid loudness evidence range")
        || message.contains("missing loudness evidence audio file")
        || message.contains("music loudness evidence must be a finite non-zero LUFS value")
        || is_stale_loudness_target_error(error)
        || message.contains("player session loudness evidence must be finite and non-zero")
}

fn is_stale_loudness_target_error(error: &anyhow::Error) -> bool {
    error
        .to_string()
        .contains("music loudness evidence target not found")
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
pub(crate) fn loudness_request_from_playback_track_for_test(
    track: &PlaybackTrack,
) -> Option<LoudnessEvidenceRequest> {
    loudness_request_from_playback_track(track)
}

#[cfg(test)]
pub(crate) fn read_loudness_pending_task_file_for_test(
    path: &std::path::Path,
) -> anyhow::Result<Vec<LoudnessEvidenceRequest>> {
    read_loudness_pending_task_file(path)
}

#[cfg(test)]
pub(crate) fn upsert_loudness_pending_task_file_for_test(
    path: &std::path::Path,
    request: &LoudnessEvidenceRequest,
) -> anyhow::Result<()> {
    upsert_loudness_pending_task_file(path, request)
}

#[cfg(test)]
pub(crate) fn remove_loudness_pending_task_from_file_for_test(
    path: &std::path::Path,
    request: &LoudnessEvidenceRequest,
) -> anyhow::Result<()> {
    remove_loudness_pending_task_from_file(path, request)
}

#[cfg(test)]
pub(crate) fn should_close_loudness_request_after_error_for_test(error: &anyhow::Error) -> bool {
    should_close_loudness_request_after_error(error)
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

    for _attempt in 0..LOUDNESS_REQUEST_REBIND_ATTEMPT_LIMIT {
        let Some(current_request) = project_loudness_request_to_current_music(request).await?
        else {
            bail!(
                "music loudness evidence target not found for {} {}..{}",
                request.url,
                request.start_ms,
                request.end_ms
            );
        };
        log_loudness_request_rebound(source, request, &current_request, "before_analysis");

        if let Some(persisted) =
            persisted_loudness_profile_for_request(&current_request, source).await?
        {
            if current_request != *request {
                publish_persisted_loudness_evidence(request, persisted);
            }
            runtime.completion_notify.notify_waiters();
            return Ok(persisted.integrated_lufs);
        }

        let _guard = ActiveLoudnessBinaryTaskGuard::new(Arc::clone(&runtime));
        let ffmpeg_path = ensure_managed_binary(&runtime.app, ManagedBinary::Ffmpeg)
            .map_err(|error| anyhow!(error))?;
        let analysis = run_loudness_analysis(ffmpeg_path, current_request.clone()).await?;
        let profile = loudness_profile_from_analysis(analysis)?;
        drop(_guard);

        let Some(commit_request) = project_loudness_request_to_current_music(request).await? else {
            bail!(
                "music loudness evidence target not found for {} {}..{}",
                request.url,
                request.start_ms,
                request.end_ms
            );
        };
        if commit_request != current_request {
            log_loudness_request_rebound(
                source,
                &current_request,
                &commit_request,
                "after_analysis",
            );
            continue;
        }

        let persisted = playlists_repo::set_music_loudness_profile_by_identity(
            &commit_request.url,
            commit_request.start_ms,
            commit_request.end_ms,
            profile,
        )
        .await?
        .ok_or_else(|| {
            anyhow!(
                "music loudness evidence target not found for {} {}..{}",
                commit_request.url,
                commit_request.start_ms,
                commit_request.end_ms
            )
        })?
        .loudness_profile
        .unwrap_or(profile);
        publish_persisted_loudness_evidence(&commit_request, persisted);
        if commit_request != *request {
            publish_persisted_loudness_evidence(request, persisted);
        }
        runtime.completion_notify.notify_waiters();
        log::info!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_persisted source={} canonical_music_id=\"{}\" integrated={:.3} true_peak={} lra={}",
            source.as_str(),
            commit_request.canonical_music_id,
            persisted.integrated_lufs,
            format_optional_loudness(persisted.true_peak_dbtp),
            format_optional_loudness(persisted.lra),
        );

        return Ok(persisted.integrated_lufs);
    }

    bail!(
        "music loudness evidence target moved while measuring for {} {}..{}",
        request.url,
        request.start_ms,
        request.end_ms
    )
}

#[cfg(not(test))]
async fn project_loudness_request_to_current_music(
    request: &LoudnessEvidenceRequest,
) -> Result<Option<LoudnessEvidenceRequest>> {
    let Some(music) = playlists_repo::project_music_loudness_identity(
        &request.url,
        &request.file_path,
        request.start_ms,
        request.end_ms,
    )
    .await?
    else {
        return Ok(None);
    };

    Ok(Some(LoudnessEvidenceRequest {
        canonical_music_id: music.canonical_music_id,
        url: music.url,
        file_path: request.file_path.clone(),
        start_ms: music.start_ms,
        end_ms: music.end_ms,
    }))
}

#[cfg(not(test))]
fn log_loudness_request_rebound(
    source: LoudnessEvidenceSource,
    previous: &LoudnessEvidenceRequest,
    current: &LoudnessEvidenceRequest,
    stage: &str,
) {
    if previous == current {
        return;
    }

    log::info!(
        target: LOUDNESS_EVIDENCE_LOG_TARGET,
        "loudness_evidence_request_rebound source={} stage={} from_canonical_music_id=\"{}\" from_range={}..{} to_canonical_music_id=\"{}\" to_range={}..{}",
        source.as_str(),
        stage,
        previous.canonical_music_id,
        previous.start_ms,
        previous.end_ms,
        current.canonical_music_id,
        current.start_ms,
        current.end_ms
    );
}

#[cfg(not(test))]
async fn persisted_loudness_profile_for_request(
    request: &LoudnessEvidenceRequest,
    source: LoudnessEvidenceSource,
) -> Result<Option<LoudnessProfile>> {
    let Some(persisted) = playlists_repo::get_music_loudness_profile_by_identity(
        &request.url,
        request.start_ms,
        request.end_ms,
    )
    .await?
    else {
        return Ok(None);
    };

    publish_persisted_loudness_evidence(request, persisted);
    log::info!(
        target: LOUDNESS_EVIDENCE_LOG_TARGET,
        "loudness_evidence_reused source={} canonical_music_id=\"{}\" integrated={:.3} true_peak={} lra={}",
        source.as_str(),
        request.canonical_music_id,
        persisted.integrated_lufs,
        format_optional_loudness(persisted.true_peak_dbtp),
        format_optional_loudness(persisted.lra),
    );
    Ok(Some(persisted))
}

#[cfg(not(test))]
fn publish_persisted_loudness_evidence(
    request: &LoudnessEvidenceRequest,
    persisted: LoudnessProfile,
) {
    publish_loudness_profile_to_runtime(request, persisted);
    if let Err(error) =
        player_service::publish_loudness_evidence_to_current_session(request, persisted)
    {
        log::warn!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_player_session_publish_failed canonical_music_id=\"{}\" error=\"{}\"",
            request.canonical_music_id,
            error
        );
    }
    if let Err(error) = playable_index::publish_first_slot_loudness_evidence(request, persisted) {
        log::warn!(
            target: LOUDNESS_EVIDENCE_LOG_TARGET,
            "loudness_evidence_first_slot_publish_failed canonical_music_id=\"{}\" error=\"{}\"",
            request.canonical_music_id,
            error
        );
    }
}

fn loudness_profile_from_analysis(
    analysis: ffplayr::AudioLoudnessAnalysis,
) -> Result<LoudnessProfile> {
    let mut profile = LoudnessProfile::from_integrated_lufs(analysis.integrated_lufs)
        .ok_or_else(|| anyhow!("music loudness evidence must be a finite non-zero LUFS value"))?;
    profile.true_peak_dbtp = analysis.true_peak_dbtp;
    profile.lra = analysis.lra;
    profile.short_lufs_p50 = analysis.short_lufs_p50;
    profile.short_lufs_p80 = analysis.short_lufs_p80;
    profile.short_lufs_p95 = analysis.short_lufs_p95;
    profile.short_lufs_max = analysis.short_lufs_max;
    profile.presence_db = analysis.presence_db;
    if !profile.is_valid() {
        anyhow::bail!(
            "music loudness profile evidence must be finite and include non-zero integrated LUFS"
        );
    }

    Ok(profile)
}

fn format_optional_loudness(value: Option<f32>) -> String {
    value
        .map(|value| format!("{value:.3}"))
        .unwrap_or_else(|| "none".to_string())
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
