#[cfg(not(test))]
use crate::domain::loudness_evidence;
use crate::domain::loudness_evidence::LoudnessEvidenceRequest;
#[cfg(not(test))]
use crate::domain::meta::service as meta_service;
#[cfg(not(test))]
use crate::domain::player::event::{PlaybackDiagnosticTraceDetail, PlaybackDiagnosticTraceEvent};
use crate::domain::player::model::{PlaybackTrack, PlaybackTrackPayload};
#[cfg(not(test))]
use crate::domain::playlist_playback::recommendation::{
    AudioStyleCenterlessSourceStatus, published_audio_style_centerless_source_from_candidates,
};
#[cfg(not(test))]
use crate::domain::playlist_playback::service as playlist_playback_service;
#[cfg(not(test))]
use crate::domain::playlists::repo as playlist_repo;
use crate::domain::playlists::model::LoudnessProfile;
use crate::domain::playlists::repo::{PlaylistPlaybackSelection, PlaylistPlaybackTrackSource};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
#[cfg(not(test))]
use std::fs;
#[cfg(not(test))]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicU64, Ordering},
};
#[cfg(not(test))]
use std::time::{Instant, SystemTime, UNIX_EPOCH};
#[cfg(not(test))]
use tauri::Manager;
#[cfg(not(test))]
use tauri_specta::Event;
use tokio::sync::watch;

const PLAYABLE_INDEX_LOG_TARGET: &str = "playlist_playback_index";
pub(crate) const FIRST_SLOT_CACHE_FILE_NAME: &str = "first-slot-cache.json";
const FIRST_SLOT_CACHE_VERSION: &str = "first-slot-cache.v2";
const FIRST_SLOT_PREPARED_POOL_TARGET: usize = 3;
#[cfg(not(test))]
const FIRST_SLOT_AUDIO_STYLE_CANDIDATE_PROBE_LIMIT: usize = 96;

static PLAYABLE_INDEX_RUNTIME: OnceLock<Arc<PlayableIndexRuntime>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlayableIndexRefreshReason {
    Startup,
    AudioStyleModelAvailable,
    PlaylistChanged,
    PlaylistDeleted,
    LibraryChanged,
    ExcludeChanged,
    SlotVacancy,
}

impl PlayableIndexRefreshReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Startup => "startup",
            Self::AudioStyleModelAvailable => "audio_style_model_available",
            Self::PlaylistChanged => "playlist_changed",
            Self::PlaylistDeleted => "playlist_deleted",
            Self::LibraryChanged => "library_changed",
            Self::ExcludeChanged => "exclude_changed",
            Self::SlotVacancy => "slot_vacancy",
        }
    }

    fn invalidates_existing_snapshots(self) -> bool {
        matches!(
            self,
            Self::PlaylistChanged
                | Self::PlaylistDeleted
                | Self::LibraryChanged
                | Self::ExcludeChanged
        )
    }

    fn replaces_existing_snapshots(self) -> bool {
        self.invalidates_existing_snapshots()
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PlaylistPlayableIndexSnapshot {
    pub(crate) playlist_name: String,
    pub(crate) generation: u64,
    pub(crate) source: Option<PlaylistPlaybackTrackSource>,
    pub(crate) track: Option<PlaybackTrack>,
    #[cfg(test)]
    pub(crate) source_kind: Option<PlaylistPlayableIndexSourceKind>,
    credential_id: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PlaylistPlayableIndexSourceKind {
    AudioStyle,
    RandomFallback,
}

#[derive(Debug, Clone)]
struct PreparedPlaylistSource {
    source: PlaylistPlaybackTrackSource,
    track: PlaybackTrack,
    source_kind: PlaylistPlayableIndexSourceKind,
}

#[derive(Debug, Clone)]
struct PreparedPlaylistSourceCredential {
    generation: u64,
    credential_id: u64,
    source: PlaylistPlaybackTrackSource,
    track: PlaybackTrack,
    source_kind: PlaylistPlayableIndexSourceKind,
}

#[derive(Debug, Clone)]
struct PlaylistPlayableIndexPool {
    playlist_name: String,
    sources: Vec<PreparedPlaylistSourceCredential>,
}

struct PreparedSourcePoolCommit {
    pool: PlaylistPlayableIndexPool,
    added_count: usize,
    removed_count: usize,
    added_credentials: Vec<PreparedPlaylistSourceCredential>,
}

#[derive(Debug, Default)]
struct PreparedPlaylistCommitOutcome {
    committed: bool,
    cache_changed: bool,
    needs_refill: bool,
    added_credentials: Vec<PreparedPlaylistSourceCredential>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FirstSlotCacheFile {
    version: String,
    pool_target: usize,
    playlists: Vec<FirstSlotCachePlaylist>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FirstSlotCachePlaylist {
    playlist_name: String,
    sources: Vec<FirstSlotCacheSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FirstSlotCacheSource {
    collection_folder: String,
    music: crate::domain::playlists::model::Music,
    track: PlaybackTrackPayload,
    source_kind: PlaylistPlayableIndexSourceKind,
}

#[derive(Debug, Clone, Copy, Default)]
struct FirstSlotCacheRestoreSummary {
    playlist_count: usize,
    source_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FirstSlotCacheRestoreMode {
    #[cfg(test)]
    AnyRuntime,
    BlankStartupOnly,
}

impl From<&PreparedPlaylistSourceCredential> for FirstSlotCacheSource {
    fn from(value: &PreparedPlaylistSourceCredential) -> Self {
        Self {
            collection_folder: value.source.collection_folder.clone(),
            music: value.source.music.clone(),
            track: value.track.to_payload(),
            source_kind: value.source_kind,
        }
    }
}

impl FirstSlotCacheSource {
    fn into_prepared_source(self) -> Result<PreparedPlaylistSource> {
        let mut track = PlaybackTrack::try_from_payload(self.track)
            .map_err(|error| anyhow!("invalid cached first-slot playback track: {error}"))?;
        track.source_music = Some(Box::new(self.music.clone()));
        Ok(PreparedPlaylistSource {
            source: PlaylistPlaybackTrackSource {
                collection_folder: self.collection_folder,
                music: self.music,
            },
            track,
            source_kind: self.source_kind,
        })
    }
}

impl PreparedSourcePoolCommit {
    fn changed(&self) -> bool {
        self.added_count > 0 || self.removed_count > 0
    }
}

#[derive(Debug)]
struct PlayableIndexRuntime {
    generation: AtomicU64,
    next_credential_id: AtomicU64,
    #[cfg(not(test))]
    next_refresh_run_id: AtomicU64,
    #[cfg(not(test))]
    app: Mutex<Option<tauri::AppHandle>>,
    state: Mutex<PlayableIndexState>,
    revision: watch::Sender<u64>,
}

#[derive(Debug, Default)]
struct PlayableIndexState {
    playlists: HashMap<String, PlaylistPlayableIndexPool>,
    playlist_generations: HashMap<String, u64>,
    global_generation: u64,
    active_refreshes: HashSet<String>,
    active_global_refresh: bool,
    pending_refreshes: HashMap<String, PlayableIndexRefreshReason>,
    pending_global_refresh: Option<PlayableIndexRefreshReason>,
}

/**
 * Behavior:
 *   Maintain one process-lifetime playable source index for playlist playback
 *   startup. The index is a preparation owner, not a semantic cache: playlist
 *   membership and playability still come from playlist repo projections and
 *   playback file checks.
 *
 * Core invariants:
 *   - Cache hit/miss cannot change playlist membership or recommendation
 *     policy; a miss reports missing cargo and never schedules click-path
 *     work.
 *   - Every committed index value is generation stamped. A late rebuild can
 *     only commit when it still owns the latest generation for that playlist
 *     or global pass.
 *   - Refresh prepares a small centerless startup pool for each playlist and
 *     never stores a seed or deterministic order.
 *   - A prepared startup option is consumed by playlist name, generation, and
 *     credential id after a current play request accepts it. Consumption removes
 *     only that credential and schedules replacement preparation.
 *   - Refresh can be repeated, cancelled by supersession, or raced with
 *     playback-start transitions without producing extra semantic side effects.
 *   - The index never defines file-path semantics; audio-style preparation
 *     asks playback service to eliminate current candidates into
 *     `PlaybackTrack` and treats failed elimination as an explicit miss.
 */
#[cfg(not(test))]
pub(crate) fn initialize_runtime(app: tauri::AppHandle) {
    register_runtime_app(app.clone());
    spawn_startup_lifecycle(app);
}

#[cfg(not(test))]
fn spawn_startup_lifecycle(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = restore_first_slot_cache_for_runtime(&app).await {
            log::warn!(
                target: PLAYABLE_INDEX_LOG_TARGET,
                "first_slot_cache_restore_ignored error=\"{}\"",
                escape_log_value(&error.to_string())
            );
        }
        spawn_refresh_all(app, PlayableIndexRefreshReason::Startup);
    });
}

#[cfg(test)]
pub(crate) fn initialize_runtime_for_test() {
    let _ = runtime();
}

pub(crate) fn request_audio_style_model_available_refresh() {
    request_audio_style_model_available_refresh_impl();
}

#[cfg(not(test))]
fn request_audio_style_model_available_refresh_impl() {
    spawn_refresh_all_without_app(PlayableIndexRefreshReason::AudioStyleModelAvailable);
}

#[cfg(test)]
fn request_audio_style_model_available_refresh_impl() {}

pub(crate) fn notify_playlist_changed(playlist_name: &str) {
    notify_playlist_changed_impl(playlist_name);
}

#[cfg(not(test))]
pub(crate) fn request_playlist_slot_refill(playlist_name: &str) {
    spawn_refresh_playlist(
        None,
        playlist_name.to_string(),
        PlayableIndexRefreshReason::SlotVacancy,
    );
}

pub(crate) fn notify_playlist_deleted(playlist_name: &str) {
    let mut removed = false;
    if let Ok(runtime) = try_runtime() {
        let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut state) = runtime.state.lock() {
            removed = state.playlists.remove(playlist_name).is_some();
            state.active_refreshes.remove(playlist_name);
            state
                .playlist_generations
                .insert(playlist_name.to_string(), generation);
        }
        if removed {
            notify_index_revision(runtime.as_ref());
        }
    }
    if removed {
        write_first_slot_cache_for_registered_runtime();
    }
    log::info!(
        target: PLAYABLE_INDEX_LOG_TARGET,
        "first_slot_playlist_removed playlist=\"{}\" reason={}",
        escape_log_value(playlist_name),
        PlayableIndexRefreshReason::PlaylistDeleted.as_str()
    );
}

pub(crate) fn notify_playlist_renamed(previous_name: &str, next_name: &str) {
    notify_playlist_renamed_impl(previous_name, next_name);
}

pub(crate) fn notify_library_changed(reason: PlayableIndexRefreshReason) {
    notify_library_changed_impl(reason);
}

pub(crate) fn notify_exclude_changed() {
    notify_library_changed_impl(PlayableIndexRefreshReason::ExcludeChanged);
}

pub(crate) fn consume_playlist_source(snapshot: &PlaylistPlayableIndexSnapshot) -> Result<bool> {
    let consumed = remove_playlist_source_snapshot(snapshot, "consume")?;
    if consumed {
        notify_prepared_source_consumed_impl(&snapshot.playlist_name);
    }
    Ok(consumed)
}

pub(crate) fn discard_playlist_source(snapshot: &PlaylistPlayableIndexSnapshot) -> Result<bool> {
    let discarded = remove_playlist_source_snapshot(snapshot, "discard")?;
    if discarded {
        notify_prepared_source_consumed_impl(&snapshot.playlist_name);
    }
    Ok(discarded)
}

pub(crate) fn publish_first_slot_loudness_evidence(
    request: &LoudnessEvidenceRequest,
    profile: LoudnessProfile,
) -> Result<()> {
    if !profile.is_valid() {
        return Err(anyhow!(
            "first-slot loudness profile evidence must be finite and include non-zero integrated LUFS"
        ));
    }
    let runtime = try_runtime()?;
    let mut changed = 0usize;
    let mut changed_playlist_names = Vec::new();
    {
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
        for pool in state.playlists.values_mut() {
            let mut pool_changed = false;
            for credential in &mut pool.sources {
                if !prepared_credential_matches_loudness_request(credential, request)
                    || credential.track.loudness_profile == Some(profile)
                {
                    continue;
                }
                apply_prepared_credential_loudness(credential, profile);
                changed += 1;
                pool_changed = true;
            }
            if pool_changed {
                changed_playlist_names.push(pool.playlist_name.clone());
            }
        }
    }

    if changed == 0 {
        return Ok(());
    }
    notify_index_revision(runtime.as_ref());
    write_first_slot_cache_for_registered_runtime();
    #[cfg(not(test))]
    {
        for playlist_name in changed_playlist_names {
            emit_index_runtime_trace(
                "playlist-playable-index-loudness-evidence-applied",
                Some(&playlist_name),
                None,
                Some(changed),
                None,
                "updated",
                vec![
                    index_trace_detail("canonicalMusicId", &request.canonical_music_id),
                    index_trace_detail("startMs", request.start_ms),
                    index_trace_detail("endMs", request.end_ms),
                    index_trace_detail("integratedLufs", format!("{:.3}", profile.integrated_lufs)),
                ],
            );
        }
        log::info!(
            target: PLAYABLE_INDEX_LOG_TARGET,
            "first_slot_loudness_evidence_applied canonical_music_id=\"{}\" integrated_lufs={:.3} credentials={}",
            escape_log_value(&request.canonical_music_id),
            profile.integrated_lufs,
            changed
        );
    }
    Ok(())
}

#[cfg(not(test))]
fn notify_playlist_changed_impl(playlist_name: &str) {
    spawn_refresh_playlist(
        None,
        playlist_name.to_string(),
        PlayableIndexRefreshReason::PlaylistChanged,
    );
}

#[cfg(test)]
fn notify_playlist_changed_impl(_playlist_name: &str) {}

fn rename_playlist_source_pool(pool: &mut PlaylistPlayableIndexPool, next_name: &str) {
    pool.playlist_name = next_name.to_string();
    for source in &mut pool.sources {
        source.track.playlist_name = next_name.to_string();
    }
}

fn prepared_credential_matches_loudness_request(
    credential: &PreparedPlaylistSourceCredential,
    request: &LoudnessEvidenceRequest,
) -> bool {
    credential.track.canonical_music_id == request.canonical_music_id
        && credential.track.music_url == request.url
        && credential.track.file_path == request.file_path
        && credential.track.start_ms == request.start_ms
        && credential.track.end_ms == request.end_ms
}

fn apply_prepared_credential_loudness(
    credential: &mut PreparedPlaylistSourceCredential,
    profile: LoudnessProfile,
) {
    credential.track.loudness_profile = Some(profile);
    credential.source.music.loudness_profile = Some(profile);
    if let Some(music) = credential.track.source_music.as_mut() {
        music.loudness_profile = Some(profile);
    }
}

fn move_playlist_source_pool(
    state: &mut PlayableIndexState,
    previous_name: &str,
    next_name: &str,
    generation: u64,
) -> bool {
    if previous_name == next_name {
        return false;
    }

    let Some(mut pool) = state.playlists.remove(previous_name) else {
        state
            .playlist_generations
            .insert(previous_name.to_string(), generation);
        return false;
    };

    rename_playlist_source_pool(&mut pool, next_name);
    state.playlists.insert(next_name.to_string(), pool);
    state.active_refreshes.remove(previous_name);
    if let Some(pending) = state.pending_refreshes.remove(previous_name) {
        state
            .pending_refreshes
            .insert(next_name.to_string(), pending);
    }
    state
        .playlist_generations
        .insert(previous_name.to_string(), generation);
    state
        .playlist_generations
        .insert(next_name.to_string(), generation);
    true
}

#[cfg(not(test))]
fn notify_playlist_renamed_impl(previous_name: &str, next_name: &str) {
    let mut moved = false;
    if let Ok(runtime) = try_runtime() {
        let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut state) = runtime.state.lock() {
            moved = move_playlist_source_pool(&mut state, previous_name, next_name, generation);
        }
        if moved {
            notify_index_revision(runtime.as_ref());
        }
    }
    if moved {
        write_first_slot_cache_for_registered_runtime();
    }
    log::info!(
        target: PLAYABLE_INDEX_LOG_TARGET,
        "first_slot_playlist_renamed previous=\"{}\" next=\"{}\" moved={}",
        escape_log_value(previous_name),
        escape_log_value(next_name),
        moved
    );
}

#[cfg(test)]
fn notify_playlist_renamed_impl(previous_name: &str, next_name: &str) {
    if let Ok(runtime) = try_runtime() {
        let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut state) = runtime.state.lock()
            && move_playlist_source_pool(&mut state, previous_name, next_name, generation)
        {
            notify_index_revision(runtime.as_ref());
        }
    }
}

#[cfg(not(test))]
fn notify_library_changed_impl(reason: PlayableIndexRefreshReason) {
    spawn_refresh_all_without_app(reason);
}

#[cfg(test)]
fn notify_library_changed_impl(_reason: PlayableIndexRefreshReason) {}

#[cfg(not(test))]
fn notify_prepared_source_consumed_impl(playlist_name: &str) {
    emit_index_runtime_trace(
        "playlist-playable-index-slot-vacancy-requested",
        Some(playlist_name),
        None,
        None,
        None,
        "requested",
        vec![index_trace_detail(
            "reason",
            PlayableIndexRefreshReason::SlotVacancy.as_str(),
        )],
    );
    spawn_refresh_playlist(
        None,
        playlist_name.to_string(),
        PlayableIndexRefreshReason::SlotVacancy,
    );
}

#[cfg(test)]
fn notify_prepared_source_consumed_impl(_playlist_name: &str) {}

pub(crate) fn read_playlist_source(
    playlist_name: &str,
) -> Result<Option<PlaylistPlayableIndexSnapshot>> {
    let runtime = try_runtime()?;
    let state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    let Some(pool) = state.playlists.get(playlist_name) else {
        #[cfg(not(test))]
        {
            let mut details = vec![index_trace_detail(
                "poolTarget",
                FIRST_SLOT_PREPARED_POOL_TARGET,
            )];
            append_index_state_trace_details(&mut details, &state, playlist_name);
            emit_index_runtime_trace(
                "playlist-playable-index-read-miss",
                Some(playlist_name),
                state.playlist_generations.get(playlist_name).copied(),
                Some(0),
                None,
                "pool_missing",
                details,
            );
        }
        return Ok(None);
    };
    let Some(credential) = pool.sources.first() else {
        #[cfg(not(test))]
        {
            let pool_size = pool.sources.len();
            let mut details = vec![
                index_trace_detail("poolTarget", FIRST_SLOT_PREPARED_POOL_TARGET),
                index_trace_detail("poolSize", pool_size),
            ];
            append_index_state_trace_details(&mut details, &state, playlist_name);
            emit_index_runtime_trace(
                "playlist-playable-index-read-miss",
                Some(playlist_name),
                state.playlist_generations.get(playlist_name).copied(),
                Some(pool_size),
                None,
                "pool_empty",
                details,
            );
        }
        return Ok(None);
    };

    #[cfg(not(test))]
    {
        let pool_size = pool.sources.len();
        let mut details = vec![
            index_trace_detail("poolTarget", FIRST_SLOT_PREPARED_POOL_TARGET),
            index_trace_detail("poolSize", pool_size),
        ];
        append_credential_trace_details(&mut details, credential);
        append_index_state_trace_details(&mut details, &state, playlist_name);
        emit_index_runtime_trace(
            "playlist-playable-index-read-hit",
            Some(playlist_name),
            Some(credential.generation),
            Some(pool_size),
            None,
            "hit",
            details,
        );
    }

    Ok(Some(PlaylistPlayableIndexSnapshot {
        playlist_name: pool.playlist_name.clone(),
        generation: credential.generation,
        source: Some(credential.source.clone()),
        track: Some(credential.track.clone()),
        #[cfg(test)]
        source_kind: Some(credential.source_kind),
        credential_id: Some(credential.credential_id),
    }))
}

fn remove_playlist_source_snapshot(
    snapshot: &PlaylistPlayableIndexSnapshot,
    _operation: &'static str,
) -> Result<bool> {
    let runtime = try_runtime()?;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    let Some(pool) = state.playlists.get_mut(&snapshot.playlist_name) else {
        #[cfg(not(test))]
        {
            let mut details = snapshot_trace_details(snapshot);
            append_index_state_trace_details(&mut details, &state, &snapshot.playlist_name);
            drop(state);
            emit_index_runtime_trace(
                &format!("playlist-playable-index-source-{_operation}"),
                Some(&snapshot.playlist_name),
                Some(snapshot.generation),
                Some(0),
                None,
                "pool_missing",
                details,
            );
        }
        return Ok(false);
    };
    let Some(credential_id) = snapshot.credential_id else {
        #[cfg(not(test))]
        {
            let mut details = snapshot_trace_details(snapshot);
            details.push(index_trace_detail("poolSize", pool.sources.len()));
            drop(state);
            emit_index_runtime_trace(
                &format!("playlist-playable-index-source-{_operation}"),
                Some(&snapshot.playlist_name),
                Some(snapshot.generation),
                None,
                None,
                "credential_missing",
                details,
            );
        }
        return Ok(false);
    };
    let Some(index) = pool.sources.iter().position(|current| {
        current.generation == snapshot.generation && current.credential_id == credential_id
    }) else {
        #[cfg(not(test))]
        {
            let mut details = snapshot_trace_details(snapshot);
            details.push(index_trace_detail("poolSize", pool.sources.len()));
            drop(state);
            emit_index_runtime_trace(
                &format!("playlist-playable-index-source-{_operation}"),
                Some(&snapshot.playlist_name),
                Some(snapshot.generation),
                None,
                None,
                "credential_not_found",
                details,
            );
        }
        return Ok(false);
    };

    #[cfg(not(test))]
    let before_pool_size = pool.sources.len();
    #[cfg(not(test))]
    let removed_source_kind = pool.sources[index].source_kind;
    pool.sources.remove(index);
    #[cfg(not(test))]
    let after_pool_size = pool.sources.len();
    if pool.sources.is_empty() {
        state.playlists.remove(&snapshot.playlist_name);
    }
    drop(state);
    notify_index_revision(runtime.as_ref());
    #[cfg(not(test))]
    emit_index_runtime_trace(
        &format!("playlist-playable-index-source-{_operation}"),
        Some(&snapshot.playlist_name),
        Some(snapshot.generation),
        Some(after_pool_size),
        Some(before_pool_size),
        "removed",
        {
            let mut details = snapshot_trace_details(snapshot);
            details.push(index_trace_detail("beforePoolSize", before_pool_size));
            details.push(index_trace_detail("afterPoolSize", after_pool_size));
            details.push(index_trace_detail(
                "sourceKind",
                source_kind_as_str(removed_source_kind),
            ));
            details
        },
    );
    write_first_slot_cache_for_registered_runtime();
    Ok(true)
}

#[cfg(test)]
pub(crate) async fn refresh_playlist_now_for_test(
    selection: PlaylistPlaybackSelection,
    source: Option<PlaylistPlaybackTrackSource>,
) -> Result<()> {
    let generation = next_generation()?;
    commit_playlist_snapshot(
        selection.playlist_name,
        generation,
        source,
        PlayableIndexRefreshReason::PlaylistChanged,
    )
}

#[cfg(test)]
pub(crate) async fn refresh_playlist_now_for_reason_for_test(
    selection: PlaylistPlaybackSelection,
    source: Option<PlaylistPlaybackTrackSource>,
    reason: PlayableIndexRefreshReason,
) -> Result<()> {
    let generation = next_generation()?;
    commit_playlist_snapshot(selection.playlist_name, generation, source, reason)
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    if let Some(runtime) = PLAYABLE_INDEX_RUNTIME.get()
        && let Ok(mut state) = runtime.state.lock()
    {
        runtime.generation.store(0, Ordering::SeqCst);
        runtime.next_credential_id.store(0, Ordering::SeqCst);
        *state = PlayableIndexState::default();
        notify_index_revision(runtime.as_ref());
    }
}

#[cfg(test)]
pub(crate) fn cache_file_json_for_test() -> Result<String> {
    let cached = first_slot_cache_file_from_runtime()?;
    serde_json::to_string(&cached)
        .map_err(|error| anyhow!("failed to encode first-slot cache for test: {error}"))
}

#[cfg(test)]
pub(crate) fn restore_cache_file_json_for_test(payload: &str) -> Result<()> {
    let cached: FirstSlotCacheFile = serde_json::from_str(payload)
        .map_err(|error| anyhow!("failed to parse first-slot cache for test: {error}"))?;
    restore_first_slot_cache_file_for_test(cached)
}

fn runtime() -> &'static Arc<PlayableIndexRuntime> {
    PLAYABLE_INDEX_RUNTIME.get_or_init(|| {
        Arc::new(PlayableIndexRuntime {
            generation: AtomicU64::new(0),
            next_credential_id: AtomicU64::new(0),
            #[cfg(not(test))]
            next_refresh_run_id: AtomicU64::new(0),
            #[cfg(not(test))]
            app: Mutex::new(None),
            state: Mutex::new(PlayableIndexState::default()),
            revision: watch::channel(0).0,
        })
    })
}

fn notify_index_revision(runtime: &PlayableIndexRuntime) {
    let next_revision = runtime.revision.borrow().checked_add(1).unwrap_or_default();
    let _previous = runtime.revision.send_replace(next_revision);
}

pub(crate) fn subscribe_index_revision() -> Result<watch::Receiver<u64>> {
    Ok(try_runtime()?.revision.subscribe())
}

#[cfg(not(test))]
fn register_runtime_app(app: tauri::AppHandle) {
    let runtime = runtime();
    match runtime.app.lock() {
        Ok(mut registered_app) => {
            *registered_app = Some(app);
        }
        Err(_) => {
            log::error!(
                target: PLAYABLE_INDEX_LOG_TARGET,
                "first_slot_runtime_app_register_failed error=\"lock_poisoned\""
            );
        }
    }
}

#[cfg(not(test))]
fn registered_runtime_app(runtime: &PlayableIndexRuntime) -> Option<tauri::AppHandle> {
    match runtime.app.lock() {
        Ok(app) => app.clone(),
        Err(_) => {
            log::error!(
                target: PLAYABLE_INDEX_LOG_TARGET,
                "first_slot_runtime_app_read_failed error=\"lock_poisoned\""
            );
            None
        }
    }
}

#[cfg(not(test))]
fn first_slot_cache_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| anyhow!("failed to resolve app local data directory: {error}"))?
        .join(FIRST_SLOT_CACHE_FILE_NAME))
}

#[cfg(not(test))]
async fn restore_first_slot_cache_for_runtime(app: &tauri::AppHandle) -> Result<()> {
    let path = first_slot_cache_path(app)?;
    let path_for_task = path.clone();
    let cached =
        tauri::async_runtime::spawn_blocking(move || read_first_slot_cache_file(&path_for_task))
            .await
            .map_err(|error| anyhow!("first-slot cache restore task failed: {error}"))??;

    let cached_pool_target = cached.pool_target;
    let summary = restore_first_slot_cache_file_on_blank_startup(cached)?;

    log::info!(
        target: PLAYABLE_INDEX_LOG_TARGET,
        "first_slot_cache_restored path=\"{}\" playlists={} prepared_sources={} cached_pool_target={} active_pool_target={}",
        escape_log_value(&path.display().to_string()),
        summary.playlist_count,
        summary.source_count,
        cached_pool_target,
        FIRST_SLOT_PREPARED_POOL_TARGET
    );
    Ok(())
}

#[cfg(not(test))]
fn read_first_slot_cache_file(path: &Path) -> Result<FirstSlotCacheFile> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FirstSlotCacheFile {
                version: FIRST_SLOT_CACHE_VERSION.to_string(),
                pool_target: FIRST_SLOT_PREPARED_POOL_TARGET,
                playlists: Vec::new(),
            });
        }
        Err(error) => {
            return Err(anyhow!(
                "failed to read first-slot cache `{}`: {error}",
                path.display()
            ));
        }
    };
    let cached: FirstSlotCacheFile = serde_json::from_slice(&bytes).map_err(|error| {
        anyhow!(
            "failed to parse first-slot cache `{}`: {error}",
            path.display()
        )
    })?;
    if cached.version != FIRST_SLOT_CACHE_VERSION {
        return Err(anyhow!(
            "first-slot cache `{}` has unsupported version `{}`",
            path.display(),
            cached.version
        ));
    }
    Ok(cached)
}

#[cfg(not(test))]
fn write_first_slot_cache_for_registered_runtime() {
    let runtime = runtime();
    let Some(app) = registered_runtime_app(runtime.as_ref()) else {
        return;
    };
    if let Err(error) = write_first_slot_cache_for_runtime(&app) {
        log::warn!(
            target: PLAYABLE_INDEX_LOG_TARGET,
            "first_slot_cache_write_ignored error=\"{}\"",
            escape_log_value(&error.to_string())
        );
    }
}

#[cfg(test)]
fn write_first_slot_cache_for_registered_runtime() {}

#[cfg(not(test))]
fn write_first_slot_cache_for_runtime(app: &tauri::AppHandle) -> Result<()> {
    let path = first_slot_cache_path(app)?;
    let cached = first_slot_cache_file_from_runtime()?;
    write_first_slot_cache_file(&path, &cached)
}

fn first_slot_cache_file_from_runtime() -> Result<FirstSlotCacheFile> {
    let runtime = try_runtime()?;
    let state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    let mut playlists = state
        .playlists
        .values()
        .filter(|pool| !pool.sources.is_empty())
        .map(|pool| FirstSlotCachePlaylist {
            playlist_name: pool.playlist_name.clone(),
            sources: pool
                .sources
                .iter()
                .map(FirstSlotCacheSource::from)
                .collect(),
        })
        .collect::<Vec<_>>();
    playlists.sort_by(|left, right| left.playlist_name.cmp(&right.playlist_name));

    Ok(FirstSlotCacheFile {
        version: FIRST_SLOT_CACHE_VERSION.to_string(),
        pool_target: FIRST_SLOT_PREPARED_POOL_TARGET,
        playlists,
    })
}

#[cfg(not(test))]
fn write_first_slot_cache_file(path: &Path, cached: &FirstSlotCacheFile) -> Result<()> {
    let bytes = serde_json::to_vec(cached)
        .map_err(|error| anyhow!("failed to encode first-slot cache: {error}"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            anyhow!(
                "failed to create first-slot cache directory `{}`: {error}",
                parent.display()
            )
        })?;
    }
    let temp_path = unique_first_slot_cache_temp_path(path);
    fs::write(&temp_path, bytes).map_err(|error| {
        anyhow!(
            "failed to write first-slot cache `{}`: {error}",
            temp_path.display()
        )
    })?;
    if let Err(error) = fs::remove_file(path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        let _ = fs::remove_file(&temp_path);
        return Err(anyhow!(
            "failed to replace first-slot cache `{}`: {error}",
            path.display()
        ));
    }
    fs::rename(&temp_path, path).map_err(|error| {
        anyhow!(
            "failed to finalize first-slot cache `{}`: {error}",
            path.display()
        )
    })
}

#[cfg(not(test))]
fn unique_first_slot_cache_temp_path(path: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| FIRST_SLOT_CACHE_FILE_NAME.into());
    path.with_file_name(format!("{file_name}.{}.{}.tmp", std::process::id(), nanos))
}

fn next_credential_id(runtime: &PlayableIndexRuntime) -> u64 {
    runtime.next_credential_id.fetch_add(1, Ordering::SeqCst) + 1
}

fn playlist_source_key(source: &PlaylistPlaybackTrackSource) -> String {
    format!(
        "{}:{}:{}",
        source.music.url, source.music.start_ms, source.music.end_ms
    )
}

#[cfg(not(test))]
fn source_kind_as_str(source_kind: PlaylistPlayableIndexSourceKind) -> &'static str {
    match source_kind {
        PlaylistPlayableIndexSourceKind::AudioStyle => "audio_style",
        PlaylistPlayableIndexSourceKind::RandomFallback => "random_fallback",
    }
}

#[cfg(not(test))]
fn index_trace_detail(key: &str, value: impl ToString) -> PlaybackDiagnosticTraceDetail {
    PlaybackDiagnosticTraceDetail {
        key: key.to_string(),
        value: value.to_string(),
    }
}

#[cfg(not(test))]
fn append_index_state_trace_details(
    details: &mut Vec<PlaybackDiagnosticTraceDetail>,
    state: &PlayableIndexState,
    playlist_name: &str,
) {
    details.push(index_trace_detail(
        "activeRefresh",
        state.active_refreshes.contains(playlist_name),
    ));
    details.push(index_trace_detail(
        "activeGlobalRefresh",
        state.active_global_refresh,
    ));
    details.push(index_trace_detail(
        "pendingReason",
        state
            .pending_refreshes
            .get(playlist_name)
            .map(|reason| reason.as_str())
            .unwrap_or("none"),
    ));
    details.push(index_trace_detail(
        "pendingGlobalReason",
        state
            .pending_global_refresh
            .map(|reason| reason.as_str())
            .unwrap_or("none"),
    ));
    details.push(index_trace_detail(
        "playlistGeneration",
        state
            .playlist_generations
            .get(playlist_name)
            .copied()
            .unwrap_or(0),
    ));
    details.push(index_trace_detail(
        "globalGeneration",
        state.global_generation,
    ));
}

#[cfg(not(test))]
fn append_credential_trace_details(
    details: &mut Vec<PlaybackDiagnosticTraceDetail>,
    credential: &PreparedPlaylistSourceCredential,
) {
    details.push(index_trace_detail("credentialId", credential.credential_id));
    details.push(index_trace_detail(
        "credentialGeneration",
        credential.generation,
    ));
    details.push(index_trace_detail(
        "sourceKind",
        source_kind_as_str(credential.source_kind),
    ));
    details.push(index_trace_detail("musicUrl", &credential.source.music.url));
    details.push(index_trace_detail(
        "musicName",
        &credential.source.music.alias,
    ));
    details.push(index_trace_detail(
        "canonicalMusicId",
        &credential.source.music.canonical_music_id,
    ));
    details.push(index_trace_detail(
        "collectionFolder",
        &credential.source.collection_folder,
    ));
    details.push(index_trace_detail(
        "startMs",
        credential.source.music.start_ms,
    ));
    details.push(index_trace_detail("endMs", credential.source.music.end_ms));
    details.push(index_trace_detail(
        "path",
        credential.source.music.path.as_deref().unwrap_or("none"),
    ));
    details.push(index_trace_detail(
        "trackPath",
        credential.track.file_path.display(),
    ));
    details.push(index_trace_detail(
        "trackLoudness",
        credential
            .track
            .loudness_profile
            .map(|profile| format!("{:.3}", profile.integrated_lufs))
            .unwrap_or_else(|| "none".to_string()),
    ));
}

#[cfg(not(test))]
fn snapshot_trace_details(
    snapshot: &PlaylistPlayableIndexSnapshot,
) -> Vec<PlaybackDiagnosticTraceDetail> {
    let mut details = vec![
        index_trace_detail("snapshotGeneration", snapshot.generation),
        index_trace_detail(
            "credentialId",
            snapshot
                .credential_id
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string()),
        ),
    ];
    if let Some(source) = snapshot.source.as_ref() {
        details.push(index_trace_detail("musicUrl", &source.music.url));
        details.push(index_trace_detail("musicName", &source.music.alias));
        details.push(index_trace_detail(
            "canonicalMusicId",
            &source.music.canonical_music_id,
        ));
        details.push(index_trace_detail(
            "collectionFolder",
            &source.collection_folder,
        ));
        details.push(index_trace_detail("startMs", source.music.start_ms));
        details.push(index_trace_detail("endMs", source.music.end_ms));
        details.push(index_trace_detail(
            "path",
            source.music.path.as_deref().unwrap_or("none"),
        ));
        details.push(index_trace_detail(
            "trackPath",
            snapshot
                .track
                .as_ref()
                .map(|track| track.file_path.display().to_string())
                .unwrap_or_else(|| "none".to_string()),
        ));
    }
    details
}

#[cfg(not(test))]
fn emit_index_runtime_trace(
    event: impl Into<String>,
    playlist_name: Option<&str>,
    generation: Option<u64>,
    source_count: Option<usize>,
    queue_count: Option<usize>,
    status: &str,
    details: Vec<PlaybackDiagnosticTraceDetail>,
) {
    let Some(app) = registered_runtime_app(runtime().as_ref()) else {
        return;
    };
    let event = event.into();
    if let Err(error) = (PlaybackDiagnosticTraceEvent {
        event: event.clone(),
        playlist_name: playlist_name.map(str::to_string),
        music_name: None,
        music_url: None,
        start_ms: None,
        end_ms: None,
        elapsed_ms: None,
        candidate_count: source_count,
        queue_count,
        status: Some(status.to_string()),
        error: None,
        details: Some({
            let mut next = vec![index_trace_detail(
                "generation",
                generation
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".to_string()),
            )];
            next.extend(details);
            next
        }),
    })
    .emit(&app)
    {
        log::error!(
            target: PLAYABLE_INDEX_LOG_TARGET,
            "first_slot_trace_emit_failed event=\"{}\" error=\"{}\"",
            escape_log_value(&event),
            escape_log_value(&error.to_string())
        );
    }
}

fn pool_needs_refresh(
    pool: Option<&PlaylistPlayableIndexPool>,
    reason: PlayableIndexRefreshReason,
) -> bool {
    let Some(pool) = pool else {
        return true;
    };
    if pool.sources.len() < FIRST_SLOT_PREPARED_POOL_TARGET {
        return true;
    }
    reason == PlayableIndexRefreshReason::AudioStyleModelAvailable
        && pool
            .sources
            .iter()
            .any(|source| source.source_kind == PlaylistPlayableIndexSourceKind::RandomFallback)
}

fn preserved_source_keys_for_refresh(
    current: Option<&PlaylistPlayableIndexPool>,
    reason: PlayableIndexRefreshReason,
) -> HashSet<String> {
    let Some(pool) = current else {
        return HashSet::new();
    };
    if reason.invalidates_existing_snapshots() {
        return HashSet::new();
    }

    pool.sources
        .iter()
        .filter(|source| {
            reason != PlayableIndexRefreshReason::AudioStyleModelAvailable
                || source.source_kind == PlaylistPlayableIndexSourceKind::AudioStyle
        })
        .map(|source| playlist_source_key(&source.source))
        .collect()
}

fn refresh_excluded_source_keys(
    runtime: &PlayableIndexRuntime,
    playlist_name: &str,
    reason: PlayableIndexRefreshReason,
) -> Result<HashSet<String>> {
    let state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    Ok(preserved_source_keys_for_refresh(
        state.playlists.get(playlist_name),
        reason,
    ))
}

fn commit_prepared_sources_to_pool(
    runtime: &PlayableIndexRuntime,
    current: Option<&PlaylistPlayableIndexPool>,
    playlist_name: String,
    generation: u64,
    prepared_sources: Vec<PreparedPlaylistSource>,
    reason: PlayableIndexRefreshReason,
) -> Option<PreparedSourcePoolCommit> {
    if prepared_sources.is_empty() {
        return None;
    }

    let mut pool = if reason.replaces_existing_snapshots() {
        PlaylistPlayableIndexPool {
            playlist_name,
            sources: Vec::with_capacity(FIRST_SLOT_PREPARED_POOL_TARGET),
        }
    } else {
        current
            .cloned()
            .unwrap_or_else(|| PlaylistPlayableIndexPool {
                playlist_name,
                sources: Vec::with_capacity(FIRST_SLOT_PREPARED_POOL_TARGET),
            })
    };
    let before_len = pool.sources.len();
    let has_audio_style_upgrade = reason == PlayableIndexRefreshReason::AudioStyleModelAvailable
        && prepared_sources
            .iter()
            .any(|source| source.source_kind == PlaylistPlayableIndexSourceKind::AudioStyle);
    if has_audio_style_upgrade {
        pool.sources
            .retain(|source| source.source_kind != PlaylistPlayableIndexSourceKind::RandomFallback);
    }
    let removed_count = before_len.saturating_sub(pool.sources.len());

    let mut seen = pool
        .sources
        .iter()
        .map(|source| playlist_source_key(&source.source))
        .collect::<HashSet<_>>();
    let mut added_count = 0usize;
    let mut added_credentials = Vec::new();
    for prepared in prepared_sources {
        if pool.sources.len() >= FIRST_SLOT_PREPARED_POOL_TARGET {
            break;
        }
        if !seen.insert(playlist_source_key(&prepared.source)) {
            continue;
        }
        let credential = PreparedPlaylistSourceCredential {
            generation,
            credential_id: next_credential_id(runtime),
            source: prepared.source,
            track: prepared.track,
            source_kind: prepared.source_kind,
        };
        added_credentials.push(credential.clone());
        pool.sources.push(credential);
        added_count += 1;
    }

    if pool.sources.is_empty() {
        None
    } else {
        Some(PreparedSourcePoolCommit {
            pool,
            added_count,
            removed_count,
            added_credentials,
        })
    }
}

fn request_prepared_first_tracks_loudness_evidence(
    _credentials: &[PreparedPlaylistSourceCredential],
) {
    #[cfg(not(test))]
    {
        for credential in _credentials.iter().rev() {
            if playlist_playback_service::playlist_track_needs_loudness_evidence(&credential.track)
            {
                loudness_evidence::request_first_slot_playback_track_loudness_evidence(
                    &credential.track,
                );
            }
        }
    }
}

fn try_runtime() -> Result<&'static Arc<PlayableIndexRuntime>> {
    PLAYABLE_INDEX_RUNTIME
        .get()
        .ok_or_else(|| anyhow!("playlist playable index runtime has not been initialized"))
}

#[cfg(test)]
fn restore_first_slot_cache_file_for_test(cached: FirstSlotCacheFile) -> Result<()> {
    restore_first_slot_cache_file(cached, FirstSlotCacheRestoreMode::AnyRuntime).map(|_| ())
}

#[cfg(not(test))]
fn restore_first_slot_cache_file_on_blank_startup(
    cached: FirstSlotCacheFile,
) -> Result<FirstSlotCacheRestoreSummary> {
    if cached.version != FIRST_SLOT_CACHE_VERSION {
        return Err(anyhow!(
            "first-slot cache has unsupported version `{}`",
            cached.version
        ));
    }

    restore_first_slot_cache_file(cached, FirstSlotCacheRestoreMode::BlankStartupOnly)
}

fn restore_first_slot_cache_file(
    cached: FirstSlotCacheFile,
    mode: FirstSlotCacheRestoreMode,
) -> Result<FirstSlotCacheRestoreSummary> {
    if cached.version != FIRST_SLOT_CACHE_VERSION {
        return Err(anyhow!(
            "first-slot cache has unsupported version `{}`",
            cached.version
        ));
    }

    let runtime = try_runtime()?;
    let mut restored_credentials = Vec::new();
    let summary = {
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
        if mode == FirstSlotCacheRestoreMode::BlankStartupOnly
            && !runtime_state_accepts_startup_cache_restore(runtime.as_ref(), &state)
        {
            log::info!(
                target: PLAYABLE_INDEX_LOG_TARGET,
                "first_slot_cache_restore_skipped reason=runtime_already_advanced"
            );
            return Ok(FirstSlotCacheRestoreSummary::default());
        }
        let mut summary = FirstSlotCacheRestoreSummary::default();
        for cached_playlist in cached.playlists {
            let mut seen = HashSet::new();
            let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
            let mut pool = PlaylistPlayableIndexPool {
                playlist_name: cached_playlist.playlist_name.clone(),
                sources: Vec::with_capacity(FIRST_SLOT_PREPARED_POOL_TARGET),
            };
            for source in cached_playlist.sources {
                if pool.sources.len() >= FIRST_SLOT_PREPARED_POOL_TARGET {
                    break;
                }
                let prepared = source.into_prepared_source()?;
                if !seen.insert(playlist_source_key(&prepared.source)) {
                    continue;
                }
                let credential = PreparedPlaylistSourceCredential {
                    generation,
                    credential_id: next_credential_id(runtime),
                    source: prepared.source,
                    track: prepared.track,
                    source_kind: prepared.source_kind,
                };
                restored_credentials.push(credential.clone());
                pool.sources.push(credential);
            }
            if pool.sources.is_empty() {
                continue;
            }
            summary.source_count += pool.sources.len();
            summary.playlist_count += 1;
            state
                .playlist_generations
                .insert(cached_playlist.playlist_name.clone(), generation);
            state.playlists.insert(cached_playlist.playlist_name, pool);
        }
        if summary.source_count > 0 {
            notify_index_revision(runtime.as_ref());
        }
        summary
    };
    request_prepared_first_tracks_loudness_evidence(&restored_credentials);
    Ok(summary)
}

fn runtime_state_accepts_startup_cache_restore(
    runtime: &PlayableIndexRuntime,
    state: &PlayableIndexState,
) -> bool {
    runtime.generation.load(Ordering::SeqCst) == 0
        && runtime.next_credential_id.load(Ordering::SeqCst) == 0
        && state.playlists.is_empty()
        && state.playlist_generations.is_empty()
        && state.global_generation == 0
        && state.active_refreshes.is_empty()
        && !state.active_global_refresh
        && state.pending_refreshes.is_empty()
        && state.pending_global_refresh.is_none()
}

#[cfg(test)]
fn next_generation() -> Result<u64> {
    Ok(try_runtime()?.generation.fetch_add(1, Ordering::SeqCst) + 1)
}

#[cfg(not(test))]
fn spawn_refresh_all_without_app(reason: PlayableIndexRefreshReason) {
    let app = registered_runtime_app(runtime().as_ref());
    spawn_refresh_all_with_app(app, reason);
}

#[cfg(not(test))]
fn spawn_refresh_all(app: tauri::AppHandle, reason: PlayableIndexRefreshReason) {
    spawn_refresh_all_with_app(Some(app), reason);
}

#[cfg(not(test))]
fn spawn_refresh_all_with_app(app: Option<tauri::AppHandle>, reason: PlayableIndexRefreshReason) {
    let runtime = Arc::clone(runtime());
    if let Some(app) = app.clone() {
        register_runtime_app(app);
    }
    let mut skip_status = "already_active";
    let run_id = runtime.next_refresh_run_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (can_start, generation) = {
        let Ok(mut state) = runtime.state.lock() else {
            log::error!(
                target: PLAYABLE_INDEX_LOG_TARGET,
                "first_slot_global_refresh_claim_failed run_id={run_id} reason={} error=\"lock_poisoned\"",
                reason.as_str()
            );
            return;
        };
        if state.active_global_refresh {
            if reason.invalidates_existing_snapshots() {
                let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
                state.global_generation = generation;
                state.pending_global_refresh =
                    merge_pending_global_refresh(state.pending_global_refresh, reason);
                (false, generation)
            } else {
                let generation = state.global_generation;
                state.pending_global_refresh =
                    merge_pending_global_refresh(state.pending_global_refresh, reason);
                (false, generation)
            }
        } else if should_skip_global_refresh(&state, reason) {
            skip_status = "prepared_pool_full";
            (false, runtime.generation.load(Ordering::SeqCst))
        } else {
            let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
            state.global_generation = generation;
            state.active_global_refresh = true;
            (true, generation)
        }
    };
    if !can_start {
        emit_index_trace(
            app.as_ref(),
            "playlist-playable-index-refresh-skipped",
            None,
            reason,
            generation,
            0,
            0,
            skip_status,
            true,
        );
        log::info!(
            target: PLAYABLE_INDEX_LOG_TARGET,
            "first_slot_global_refresh_skipped run_id={run_id} reason={} generation={generation} status={skip_status}",
            reason.as_str()
        );
        return;
    }
    log::info!(
        target: PLAYABLE_INDEX_LOG_TARGET,
        "first_slot_global_refresh_started run_id={run_id} reason={} generation={generation}",
        reason.as_str()
    );
    let cleanup_runtime = Arc::clone(&runtime);

    tauri::async_runtime::spawn(async move {
        if let Err(error) = refresh_all(app.clone(), runtime, run_id, generation, reason).await {
            release_global_refresh_and_spawn_pending(app, &cleanup_runtime);
            log::error!(
                target: PLAYABLE_INDEX_LOG_TARGET,
                "first_slot_global_refresh_failed run_id={run_id} reason={} generation={generation} error=\"{}\"",
                reason.as_str(),
                escape_log_value(&error.to_string())
            );
        }
    });
}

#[cfg(not(test))]
fn spawn_refresh_playlist(
    app: Option<tauri::AppHandle>,
    playlist_name: String,
    reason: PlayableIndexRefreshReason,
) {
    let runtime = Arc::clone(runtime());
    let app = app.or_else(|| registered_runtime_app(runtime.as_ref()));
    let mut claimed_generation = None;
    let mut skipped_generation = None;
    let mut skip_status = "already_active";
    let run_id = runtime.next_refresh_run_id.fetch_add(1, Ordering::SeqCst) + 1;
    let can_start = {
        let Ok(mut state) = runtime.state.lock() else {
            log::error!(
                target: PLAYABLE_INDEX_LOG_TARGET,
                "first_slot_playlist_refresh_claim_failed run_id={run_id} playlist=\"{}\" reason={} error=\"lock_poisoned\"",
                escape_log_value(&playlist_name),
                reason.as_str()
            );
            return;
        };
        if state.active_refreshes.contains(&playlist_name) {
            if reason.invalidates_existing_snapshots() {
                let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
                state
                    .playlist_generations
                    .insert(playlist_name.clone(), generation);
                let pending_reason = merge_pending_playlist_refresh(
                    state.pending_refreshes.get(&playlist_name).copied(),
                    reason,
                );
                state
                    .pending_refreshes
                    .insert(playlist_name.clone(), pending_reason);
                skipped_generation = Some(generation);
            } else {
                let generation = state
                    .playlist_generations
                    .get(&playlist_name)
                    .copied()
                    .unwrap_or_else(|| runtime.generation.load(Ordering::SeqCst));
                let pending_reason = merge_pending_playlist_refresh(
                    state.pending_refreshes.get(&playlist_name).copied(),
                    reason,
                );
                state
                    .pending_refreshes
                    .insert(playlist_name.clone(), pending_reason);
                skipped_generation = Some(generation);
            }
            false
        } else if should_skip_playlist_refresh(&state, &playlist_name, reason) {
            skip_status = "prepared_source_exists";
            skipped_generation = Some(runtime.generation.load(Ordering::SeqCst));
            false
        } else {
            let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
            state.active_refreshes.insert(playlist_name.clone());
            state
                .playlist_generations
                .insert(playlist_name.clone(), generation);
            claimed_generation = Some(generation);
            true
        }
    };
    if !can_start {
        let generation =
            skipped_generation.unwrap_or_else(|| runtime.generation.load(Ordering::SeqCst));
        #[cfg(not(test))]
        emit_index_runtime_trace(
            "playlist-playable-index-refresh-claim",
            Some(&playlist_name),
            Some(generation),
            None,
            None,
            skip_status,
            vec![index_trace_detail("reason", reason.as_str())],
        );
        emit_index_trace(
            app.as_ref(),
            "playlist-playable-index-refresh-skipped",
            Some(&playlist_name),
            reason,
            generation,
            0,
            0,
            skip_status,
            true,
        );
        log::info!(
            target: PLAYABLE_INDEX_LOG_TARGET,
            "first_slot_playlist_refresh_skipped run_id={run_id} playlist=\"{}\" reason={} generation={generation} status={skip_status}",
            escape_log_value(&playlist_name),
            reason.as_str()
        );
        return;
    }
    let generation = claimed_generation.expect("playlist refresh claim should set generation");
    #[cfg(not(test))]
    emit_index_runtime_trace(
        "playlist-playable-index-refresh-claim",
        Some(&playlist_name),
        Some(generation),
        None,
        None,
        "claimed",
        vec![index_trace_detail("reason", reason.as_str())],
    );
    log::info!(
        target: PLAYABLE_INDEX_LOG_TARGET,
        "first_slot_playlist_refresh_started run_id={run_id} playlist=\"{}\" reason={} generation={generation}",
        escape_log_value(&playlist_name),
        reason.as_str()
    );
    let cleanup_runtime = Arc::clone(&runtime);
    let cleanup_playlist_name = playlist_name.clone();

    tauri::async_runtime::spawn(async move {
        if let Err(error) = refresh_playlist(
            app.clone(),
            runtime,
            run_id,
            playlist_name.clone(),
            generation,
            reason,
        )
        .await
        {
            release_playlist_refresh(app, &cleanup_runtime, &cleanup_playlist_name, generation);
            log::error!(
                target: PLAYABLE_INDEX_LOG_TARGET,
                "first_slot_playlist_refresh_failed run_id={run_id} playlist=\"{}\" reason={} generation={generation} error=\"{}\"",
                escape_log_value(&playlist_name),
                reason.as_str(),
                escape_log_value(&error.to_string())
            );
        }
    });
}

fn merge_pending_global_refresh(
    current: Option<PlayableIndexRefreshReason>,
    next: PlayableIndexRefreshReason,
) -> Option<PlayableIndexRefreshReason> {
    Some(merge_pending_refresh_reason(current, next))
}

fn merge_pending_playlist_refresh(
    current: Option<PlayableIndexRefreshReason>,
    next: PlayableIndexRefreshReason,
) -> PlayableIndexRefreshReason {
    merge_pending_refresh_reason(current, next)
}

fn merge_pending_refresh_reason(
    current: Option<PlayableIndexRefreshReason>,
    next: PlayableIndexRefreshReason,
) -> PlayableIndexRefreshReason {
    match current {
        Some(current) if current.invalidates_existing_snapshots() => current,
        _ => next,
    }
}

#[cfg(not(test))]
async fn refresh_all(
    app: Option<tauri::AppHandle>,
    runtime: Arc<PlayableIndexRuntime>,
    run_id: u64,
    generation: u64,
    reason: PlayableIndexRefreshReason,
) -> Result<()> {
    let started = Instant::now();
    let app_handle = app.as_ref().ok_or_else(|| {
        anyhow!(
            "playlist playable index refresh requires app handle for playback source projection"
        )
    })?;
    let mut playlist_count = 0usize;
    let mut source_count = 0usize;
    let mut committed_count = 0usize;
    let mut cache_changed = reason == PlayableIndexRefreshReason::Startup;
    let mut refill_playlists = Vec::new();
    let mut next_names = HashSet::new();
    for playlist in playlist_repo::list_playlists().await? {
        let Some(selection) =
            playlist_repo::get_playlist_playback_selection_by_name(&playlist.name).await?
        else {
            continue;
        };
        next_names.insert(selection.playlist_name.clone());
        playlist_count += 1;
        let excluded_source_keys =
            refresh_excluded_source_keys(runtime.as_ref(), &selection.playlist_name, reason)?;
        let missing_count = FIRST_SLOT_PREPARED_POOL_TARGET.saturating_sub(
            excluded_source_keys
                .len()
                .min(FIRST_SLOT_PREPARED_POOL_TARGET),
        );
        let prepared_sources =
            prepare_playlist_sources(app_handle, &selection, missing_count, &excluded_source_keys)
                .await?;
        source_count += prepared_sources.len();

        let outcome = {
            let mut state = runtime
                .state
                .lock()
                .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
            let latest_generation = state
                .playlist_generations
                .get(&selection.playlist_name)
                .copied()
                .unwrap_or(0);
            if state.global_generation == generation && latest_generation <= generation {
                commit_prepared_playlist_sources(
                    runtime.as_ref(),
                    &mut state,
                    selection.playlist_name.clone(),
                    generation,
                    prepared_sources,
                    reason,
                )
            } else {
                PreparedPlaylistCommitOutcome::default()
            }
        };
        if outcome.committed {
            committed_count += 1;
        }
        request_prepared_first_tracks_loudness_evidence(&outcome.added_credentials);
        if outcome.cache_changed {
            cache_changed = true;
            write_first_slot_cache_for_registered_runtime();
        }
        if outcome.needs_refill {
            refill_playlists.push(selection.playlist_name);
        }
    }

    let has_pending_global_refresh: bool;
    {
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
        let stale_playlists = state
            .playlists
            .keys()
            .filter(|playlist_name| !next_names.contains(*playlist_name))
            .cloned()
            .collect::<Vec<_>>();
        for playlist_name in stale_playlists {
            let latest_generation = state
                .playlist_generations
                .get(&playlist_name)
                .copied()
                .unwrap_or(0);
            if state.global_generation == generation && latest_generation <= generation {
                if state.playlists.remove(&playlist_name).is_some() {
                    cache_changed = true;
                    notify_index_revision(runtime.as_ref());
                }
                state.playlist_generations.insert(playlist_name, generation);
            }
        }
        state.active_global_refresh = false;
        has_pending_global_refresh = state.pending_global_refresh.is_some();
    };
    if cache_changed {
        write_first_slot_cache_for_registered_runtime();
    }
    let committed = committed_count == playlist_count;

    log::info!(
        target: PLAYABLE_INDEX_LOG_TARGET,
        "first_slot_global_refresh_finished run_id={run_id} reason={} generation={generation} playlists={playlist_count} prepared_sources={source_count} committed={committed} committed_playlists={committed_count} elapsed_ms={}",
        reason.as_str(),
        started.elapsed().as_millis()
    );
    emit_index_trace(
        app.as_ref(),
        "playlist-playable-index-refresh-ok",
        None,
        reason,
        generation,
        playlist_count,
        source_count,
        "global",
        committed,
    );
    if !spawn_pending_global_refresh(app.clone(), &runtime) {
        for playlist_name in refill_playlists {
            spawn_refresh_playlist(
                app.clone(),
                playlist_name,
                PlayableIndexRefreshReason::SlotVacancy,
            );
        }
    } else if !refill_playlists.is_empty() {
        log::info!(
            target: PLAYABLE_INDEX_LOG_TARGET,
            "first_slot_global_refill_deferred reason={} refill_playlists={} pending_global_refresh={}",
            reason.as_str(),
            refill_playlists.len(),
            has_pending_global_refresh
        );
    }

    Ok(())
}

#[cfg(not(test))]
async fn refresh_playlist(
    app: Option<tauri::AppHandle>,
    runtime: Arc<PlayableIndexRuntime>,
    run_id: u64,
    playlist_name: String,
    generation: u64,
    reason: PlayableIndexRefreshReason,
) -> Result<()> {
    let started = Instant::now();
    let app_handle = app.as_ref().ok_or_else(|| {
        anyhow!(
            "playlist playable index refresh requires app handle for playback source projection"
        )
    })?;
    let prepared_sources =
        match playlist_repo::get_playlist_playback_selection_by_name(&playlist_name).await? {
            Some(selection) => {
                let excluded_source_keys =
                    refresh_excluded_source_keys(runtime.as_ref(), &playlist_name, reason)?;
                let missing_count = FIRST_SLOT_PREPARED_POOL_TARGET.saturating_sub(
                    excluded_source_keys
                        .len()
                        .min(FIRST_SLOT_PREPARED_POOL_TARGET),
                );
                prepare_playlist_sources(
                    app_handle,
                    &selection,
                    missing_count,
                    &excluded_source_keys,
                )
                .await?
            }
            None => Vec::new(),
        };
    let source_count = prepared_sources.len();
    let mut committed = false;
    let mut cache_changed = false;
    let mut needs_refill = false;
    let mut added_credentials = Vec::new();
    let pending_reason = {
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
        if state
            .playlist_generations
            .get(&playlist_name)
            .copied()
            .is_some_and(|latest_generation| latest_generation == generation)
        {
            let outcome = commit_prepared_playlist_sources(
                runtime.as_ref(),
                &mut state,
                playlist_name.clone(),
                generation,
                prepared_sources,
                reason,
            );
            committed = outcome.committed;
            cache_changed = outcome.cache_changed;
            needs_refill = outcome.needs_refill;
            added_credentials = outcome.added_credentials;
        }
        state.active_refreshes.remove(&playlist_name);
        state.pending_refreshes.remove(&playlist_name)
    };
    request_prepared_first_tracks_loudness_evidence(&added_credentials);
    if cache_changed {
        write_first_slot_cache_for_registered_runtime();
    }
    if let Some(pending_reason) = pending_reason {
        #[cfg(not(test))]
        emit_index_runtime_trace(
            "playlist-playable-index-refresh-pending-spawned",
            Some(&playlist_name),
            Some(generation),
            Some(source_count),
            None,
            "pending_reason",
            vec![
                index_trace_detail("reason", reason.as_str()),
                index_trace_detail("pendingReason", pending_reason.as_str()),
                index_trace_detail("committed", committed),
                index_trace_detail("needsRefill", needs_refill),
            ],
        );
        spawn_refresh_playlist(app.clone(), playlist_name.clone(), pending_reason);
    } else if needs_refill {
        #[cfg(not(test))]
        emit_index_runtime_trace(
            "playlist-playable-index-refresh-refill-spawned",
            Some(&playlist_name),
            Some(generation),
            Some(source_count),
            None,
            "slot_vacancy",
            vec![
                index_trace_detail("reason", reason.as_str()),
                index_trace_detail("committed", committed),
                index_trace_detail("needsRefill", needs_refill),
            ],
        );
        spawn_refresh_playlist(
            app.clone(),
            playlist_name.clone(),
            PlayableIndexRefreshReason::SlotVacancy,
        );
    }

    log::info!(
        target: PLAYABLE_INDEX_LOG_TARGET,
        "first_slot_playlist_refresh_finished run_id={run_id} playlist=\"{}\" reason={} generation={generation} prepared_sources={source_count} committed={committed} elapsed_ms={}",
        escape_log_value(&playlist_name),
        reason.as_str(),
        started.elapsed().as_millis()
    );
    emit_index_trace(
        app.as_ref(),
        "playlist-playable-index-refresh-ok",
        Some(&playlist_name),
        reason,
        generation,
        usize::from(source_count > 0),
        source_count,
        "playlist",
        committed,
    );

    Ok(())
}

#[cfg(not(test))]
fn release_playlist_refresh(
    app: Option<tauri::AppHandle>,
    runtime: &Arc<PlayableIndexRuntime>,
    playlist_name: &str,
    _generation: u64,
) {
    let pending_reason = {
        let Ok(mut state) = runtime.state.lock() else {
            log::error!(
                target: PLAYABLE_INDEX_LOG_TARGET,
                "first_slot_playlist_refresh_release_failed playlist=\"{}\" error=\"lock_poisoned\"",
                escape_log_value(playlist_name)
            );
            return;
        };
        state.active_refreshes.remove(playlist_name);
        state.pending_refreshes.remove(playlist_name)
    };
    if let Some(pending_reason) = pending_reason {
        spawn_refresh_playlist(app, playlist_name.to_string(), pending_reason);
    }
}

#[cfg(not(test))]
fn spawn_pending_global_refresh(
    app: Option<tauri::AppHandle>,
    runtime: &Arc<PlayableIndexRuntime>,
) -> bool {
    let pending_reason = {
        let Ok(mut state) = runtime.state.lock() else {
            log::error!(
                target: PLAYABLE_INDEX_LOG_TARGET,
                "first_slot_pending_global_refresh_claim_failed error=\"lock_poisoned\""
            );
            return false;
        };
        state.pending_global_refresh.take()
    };
    let Some(pending_reason) = pending_reason else {
        return false;
    };
    match app {
        Some(app) => spawn_refresh_all(app, pending_reason),
        None => spawn_refresh_all_without_app(pending_reason),
    }
    true
}

#[cfg(not(test))]
fn release_global_refresh_and_spawn_pending(
    app: Option<tauri::AppHandle>,
    runtime: &Arc<PlayableIndexRuntime>,
) {
    let Ok(mut state) = runtime.state.lock() else {
        log::error!(
            target: PLAYABLE_INDEX_LOG_TARGET,
            "first_slot_global_refresh_release_failed error=\"lock_poisoned\""
        );
        return;
    };
    state.active_global_refresh = false;
    drop(state);
    spawn_pending_global_refresh(app, runtime);
}

#[cfg(not(test))]
async fn prepare_playlist_source(
    app: &tauri::AppHandle,
    selection: &PlaylistPlaybackSelection,
    excluded_source_keys: &HashSet<String>,
) -> Result<Option<PreparedPlaylistSource>> {
    let candidates =
        prepare_audio_style_candidate_tracks(app, selection, excluded_source_keys).await?;
    match published_audio_style_centerless_source_from_candidates(candidates) {
        AudioStyleCenterlessSourceStatus::Ready(source, track, selection_trace) => {
            log::info!(
                target: PLAYABLE_INDEX_LOG_TARGET,
                "first_slot_source_prepared playlist=\"{}\" source={} selection_reason={} probability={:.6} candidates={} model_generation={}",
                escape_log_value(&selection.playlist_name),
                selection_trace.source.as_str(),
                selection_trace.reason.unwrap_or("none"),
                selection_trace.probability,
                selection_trace.candidate_count,
                selection_trace
                    .model_generation
                    .map(|generation| generation.to_string())
                    .unwrap_or_else(|| "none".to_string())
            );
            Ok(Some(PreparedPlaylistSource {
                source,
                track,
                source_kind: PlaylistPlayableIndexSourceKind::AudioStyle,
            }))
        }
        AudioStyleCenterlessSourceStatus::ModelUnavailable => {
            prepare_playlist_random_fallback_source(
                app,
                selection,
                excluded_source_keys,
                "model_unavailable",
            )
            .await
        }
        AudioStyleCenterlessSourceStatus::NoScopedCandidate => {
            prepare_playlist_random_fallback_source(
                app,
                selection,
                excluded_source_keys,
                "no_scoped_model_candidate",
            )
            .await
        }
    }
}

#[cfg(not(test))]
async fn prepare_audio_style_candidate_tracks(
    app: &tauri::AppHandle,
    selection: &PlaylistPlaybackSelection,
    excluded_source_keys: &HashSet<String>,
) -> Result<Vec<(PlaylistPlaybackTrackSource, PlaybackTrack)>> {
    let save_root = meta_service::resolve_save_root(app).await?;
    let sources = playlist_repo::load_random_playlist_playback_track_sources(
        selection,
        FIRST_SLOT_AUDIO_STYLE_CANDIDATE_PROBE_LIMIT,
    )
    .await?;
    let mut candidates = Vec::with_capacity(sources.len());

    for source in sources {
        if excluded_source_keys.contains(&playlist_source_key(&source)) {
            continue;
        }
        let Some(file_path) =
            playlist_playback_service::resolve_source_music_file_path(&save_root, &source)
        else {
            continue;
        };
        if !file_path.is_file() {
            continue;
        }
        let track = playlist_playback_service::project_playlist_playback_track_for_playlist(
            &selection.playlist_name,
            &source,
            file_path,
        );
        candidates.push((source, track));
    }

    Ok(candidates)
}

#[cfg(not(test))]
async fn prepare_playlist_sources(
    app: &tauri::AppHandle,
    selection: &PlaylistPlaybackSelection,
    target_count: usize,
    excluded_source_keys: &HashSet<String>,
) -> Result<Vec<PreparedPlaylistSource>> {
    let mut prepared_sources = Vec::with_capacity(target_count);
    let mut seen = excluded_source_keys.clone();

    for attempt_index in 0..target_count {
        let Some(prepared) = prepare_playlist_source(app, selection, &seen).await? else {
            #[cfg(not(test))]
            emit_index_runtime_trace(
                "playlist-playable-index-prepare-step",
                Some(&selection.playlist_name),
                None,
                Some(prepared_sources.len()),
                None,
                "source_missing",
                vec![
                    index_trace_detail("targetCount", target_count),
                    index_trace_detail("attemptIndex", attempt_index),
                    index_trace_detail("excludedSourceCount", excluded_source_keys.len()),
                ],
            );
            break;
        };
        if !seen.insert(playlist_source_key(&prepared.source)) {
            #[cfg(not(test))]
            emit_index_runtime_trace(
                "playlist-playable-index-prepare-step",
                Some(&selection.playlist_name),
                None,
                Some(prepared_sources.len()),
                None,
                "duplicate_source",
                vec![
                    index_trace_detail("targetCount", target_count),
                    index_trace_detail("attemptIndex", attempt_index),
                    index_trace_detail("sourceKind", source_kind_as_str(prepared.source_kind)),
                    index_trace_detail("musicUrl", &prepared.source.music.url),
                ],
            );
            continue;
        }
        #[cfg(not(test))]
        emit_index_runtime_trace(
            "playlist-playable-index-prepare-step",
            Some(&selection.playlist_name),
            None,
            Some(prepared_sources.len() + 1),
            None,
            "prepared",
            vec![
                index_trace_detail("targetCount", target_count),
                index_trace_detail("attemptIndex", attempt_index),
                index_trace_detail("sourceKind", source_kind_as_str(prepared.source_kind)),
                index_trace_detail("musicUrl", &prepared.source.music.url),
                index_trace_detail("musicName", &prepared.source.music.alias),
                index_trace_detail(
                    "path",
                    prepared.source.music.path.as_deref().unwrap_or("none"),
                ),
            ],
        );
        prepared_sources.push(prepared);
    }

    #[cfg(not(test))]
    emit_index_runtime_trace(
        "playlist-playable-index-prepare-finished",
        Some(&selection.playlist_name),
        None,
        Some(prepared_sources.len()),
        None,
        "finished",
        vec![
            index_trace_detail("targetCount", target_count),
            index_trace_detail("excludedSourceCount", excluded_source_keys.len()),
        ],
    );
    Ok(prepared_sources)
}

#[cfg(not(test))]
async fn prepare_playlist_random_fallback_source(
    app: &tauri::AppHandle,
    selection: &PlaylistPlaybackSelection,
    excluded_source_keys: &HashSet<String>,
    selection_reason: &'static str,
) -> Result<Option<PreparedPlaylistSource>> {
    let save_root = meta_service::resolve_save_root(app).await?;
    let mut sources = playlist_repo::load_random_playlist_playback_track_sources(
        selection,
        FIRST_SLOT_PREPARED_POOL_TARGET + excluded_source_keys.len(),
    )
    .await?;
    sources.retain(|source| !excluded_source_keys.contains(&playlist_source_key(source)));
    let Some((source, track)) = sources.into_iter().find_map(|source| {
        let file_path =
            playlist_playback_service::resolve_source_music_file_path(&save_root, &source)?;
        if !file_path.is_file() {
            return None;
        }
        let track = playlist_playback_service::project_playlist_playback_track_for_playlist(
            &selection.playlist_name,
            &source,
            file_path,
        );
        Some((source, track))
    }) else {
        log::warn!(
            target: PLAYABLE_INDEX_LOG_TARGET,
            "first_slot_source_unavailable playlist=\"{}\" status=random_fallback_empty selection_reason={} action=none",
            escape_log_value(&selection.playlist_name),
            selection_reason
        );
        return Ok(None);
    };
    log::warn!(
        target: PLAYABLE_INDEX_LOG_TARGET,
        "first_slot_source_prepared playlist=\"{}\" source=random_fallback selection_reason={} probability=1.000000 candidates=1 model_generation=none",
        escape_log_value(&selection.playlist_name),
        selection_reason
    );
    Ok(Some(PreparedPlaylistSource {
        source,
        track,
        source_kind: PlaylistPlayableIndexSourceKind::RandomFallback,
    }))
}

fn should_skip_global_refresh(
    state: &PlayableIndexState,
    reason: PlayableIndexRefreshReason,
) -> bool {
    if reason == PlayableIndexRefreshReason::Startup
        || reason.invalidates_existing_snapshots()
        || state.active_global_refresh
    {
        return false;
    }
    !state.playlists.is_empty()
        && state
            .playlists
            .values()
            .all(|pool| !pool_needs_refresh(Some(pool), reason))
}

fn should_skip_playlist_refresh(
    state: &PlayableIndexState,
    playlist_name: &str,
    reason: PlayableIndexRefreshReason,
) -> bool {
    !reason.invalidates_existing_snapshots()
        && !pool_needs_refresh(state.playlists.get(playlist_name), reason)
}

fn can_commit_refresh_snapshot(
    current: Option<&PlaylistPlayableIndexPool>,
    reason: PlayableIndexRefreshReason,
) -> bool {
    reason.replaces_existing_snapshots() || pool_needs_refresh(current, reason)
}

fn commit_prepared_playlist_sources(
    runtime: &PlayableIndexRuntime,
    state: &mut PlayableIndexState,
    playlist_name: String,
    generation: u64,
    prepared_sources: Vec<PreparedPlaylistSource>,
    reason: PlayableIndexRefreshReason,
) -> PreparedPlaylistCommitOutcome {
    let current = state.playlists.get(&playlist_name);
    if !can_commit_refresh_snapshot(current, reason) {
        #[cfg(not(test))]
        emit_index_runtime_trace(
            "playlist-playable-index-commit-skipped",
            Some(&playlist_name),
            Some(generation),
            current.map(|pool| pool.sources.len()),
            None,
            "commit_not_needed",
            vec![
                index_trace_detail("reason", reason.as_str()),
                index_trace_detail("preparedSourceCount", prepared_sources.len()),
                index_trace_detail("poolTarget", FIRST_SLOT_PREPARED_POOL_TARGET),
            ],
        );
        return PreparedPlaylistCommitOutcome::default();
    }

    #[cfg(not(test))]
    let prepared_source_count = prepared_sources.len();
    if let Some(pool) = commit_prepared_sources_to_pool(
        runtime,
        current,
        playlist_name.clone(),
        generation,
        prepared_sources,
        reason,
    ) {
        let needs_refill =
            pool_needs_refresh(Some(&pool.pool), PlayableIndexRefreshReason::SlotVacancy)
                && pool.changed()
                && !reason.invalidates_existing_snapshots();
        #[cfg(not(test))]
        let after_pool_size = pool.pool.sources.len();
        #[cfg(not(test))]
        let added_count = pool.added_count;
        #[cfg(not(test))]
        let removed_count = pool.removed_count;
        state
            .playlist_generations
            .insert(playlist_name.clone(), generation);
        state.playlists.insert(playlist_name.clone(), pool.pool);
        notify_index_revision(runtime);
        #[cfg(not(test))]
        emit_index_runtime_trace(
            "playlist-playable-index-commit",
            Some(&playlist_name),
            Some(generation),
            Some(after_pool_size),
            None,
            "committed",
            vec![
                index_trace_detail("reason", reason.as_str()),
                index_trace_detail("preparedSourceCount", prepared_source_count),
                index_trace_detail("addedCount", added_count),
                index_trace_detail("removedCount", removed_count),
                index_trace_detail("afterPoolSize", after_pool_size),
                index_trace_detail("poolTarget", FIRST_SLOT_PREPARED_POOL_TARGET),
                index_trace_detail("needsRefill", needs_refill),
            ],
        );
        return PreparedPlaylistCommitOutcome {
            committed: true,
            cache_changed: true,
            needs_refill,
            added_credentials: pool.added_credentials,
        };
    }

    if reason.replaces_existing_snapshots() {
        state
            .playlist_generations
            .insert(playlist_name.clone(), generation);
        let removed_existing = state.playlists.remove(&playlist_name).is_some();
        if removed_existing {
            notify_index_revision(runtime);
        }
        #[cfg(not(test))]
        emit_index_runtime_trace(
            "playlist-playable-index-commit",
            Some(&playlist_name),
            Some(generation),
            Some(0),
            None,
            "removed_empty_snapshot",
            vec![
                index_trace_detail("reason", reason.as_str()),
                index_trace_detail("preparedSourceCount", prepared_source_count),
                index_trace_detail("removedExistingPool", removed_existing),
            ],
        );
        return PreparedPlaylistCommitOutcome {
            committed: true,
            cache_changed: removed_existing,
            needs_refill: false,
            added_credentials: Vec::new(),
        };
    }

    PreparedPlaylistCommitOutcome::default()
}

#[cfg(test)]
pub(crate) fn should_skip_global_refresh_for_test(
    reason: PlayableIndexRefreshReason,
) -> Result<bool> {
    let runtime = try_runtime()?;
    let state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    Ok(should_skip_global_refresh(&state, reason))
}

#[cfg(test)]
pub(crate) fn should_skip_playlist_refresh_for_test(
    playlist_name: &str,
    reason: PlayableIndexRefreshReason,
) -> Result<bool> {
    let runtime = try_runtime()?;
    let state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    Ok(should_skip_playlist_refresh(&state, playlist_name, reason))
}

#[cfg(test)]
pub(crate) fn claim_global_refresh_for_test(_reason: PlayableIndexRefreshReason) -> Result<u64> {
    let runtime = try_runtime()?;
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    state.global_generation = generation;
    state.active_global_refresh = true;
    Ok(generation)
}

#[cfg(test)]
pub(crate) fn request_global_refresh_while_active_for_test(
    reason: PlayableIndexRefreshReason,
) -> Result<u64> {
    let runtime = try_runtime()?;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    if reason.invalidates_existing_snapshots() {
        let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
        state.global_generation = generation;
        state.pending_global_refresh =
            merge_pending_global_refresh(state.pending_global_refresh, reason);
        Ok(generation)
    } else {
        let generation = state.global_generation;
        state.pending_global_refresh =
            merge_pending_global_refresh(state.pending_global_refresh, reason);
        Ok(generation)
    }
}

#[cfg(test)]
pub(crate) fn commit_global_snapshot_for_test(
    playlist_name: String,
    generation: u64,
    source: Option<PlaylistPlaybackTrackSource>,
    reason: PlayableIndexRefreshReason,
) -> Result<bool> {
    let runtime = try_runtime()?;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    let latest_generation = state
        .playlist_generations
        .get(&playlist_name)
        .copied()
        .unwrap_or(0);
    let current = state.playlists.get(&playlist_name);
    let can_replace = can_commit_refresh_snapshot(current, reason);
    let committed =
        state.global_generation == generation && latest_generation <= generation && can_replace;
    if committed {
        if let Some(source) = source {
            let track = playback_track_from_source_for_test(&playlist_name, &source);
            let prepared_sources = vec![PreparedPlaylistSource {
                source,
                track,
                source_kind: PlaylistPlayableIndexSourceKind::AudioStyle,
            }];
            let pool = commit_prepared_sources_to_pool(
                runtime,
                current,
                playlist_name.clone(),
                generation,
                prepared_sources,
                reason,
            );
            if let Some(pool) = pool {
                state
                    .playlist_generations
                    .insert(playlist_name.clone(), generation);
                state.playlists.insert(playlist_name, pool.pool);
                notify_index_revision(runtime);
            }
        }
    }
    state.active_global_refresh = false;
    Ok(committed)
}

#[cfg(test)]
pub(crate) fn claim_playlist_refresh_for_test(
    playlist_name: &str,
    _reason: PlayableIndexRefreshReason,
) -> Result<u64> {
    let runtime = try_runtime()?;
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    state.active_refreshes.insert(playlist_name.to_string());
    state
        .playlist_generations
        .insert(playlist_name.to_string(), generation);
    Ok(generation)
}

#[cfg(test)]
pub(crate) fn commit_playlist_snapshot_for_test(
    playlist_name: String,
    generation: u64,
    source: Option<PlaylistPlaybackTrackSource>,
    reason: PlayableIndexRefreshReason,
) -> Result<bool> {
    let runtime = try_runtime()?;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    let committed = state
        .playlist_generations
        .get(&playlist_name)
        .copied()
        .is_some_and(|latest_generation| latest_generation == generation);
    if committed {
        match source {
            Some(source) => {
                let track = playback_track_from_source_for_test(&playlist_name, &source);
                let current = state.playlists.get(&playlist_name);
                let can_replace = can_commit_refresh_snapshot(current, reason);
                if can_replace {
                    let prepared_sources = vec![PreparedPlaylistSource {
                        source,
                        track,
                        source_kind: PlaylistPlayableIndexSourceKind::AudioStyle,
                    }];
                    if let Some(pool) = commit_prepared_sources_to_pool(
                        runtime,
                        current,
                        playlist_name.clone(),
                        generation,
                        prepared_sources,
                        reason,
                    ) {
                        state.playlists.insert(playlist_name.clone(), pool.pool);
                        notify_index_revision(runtime);
                    }
                }
            }
            None => {}
        }
    }
    state.active_refreshes.remove(&playlist_name);
    Ok(committed)
}

#[cfg(test)]
pub(crate) fn mark_playlist_source_kind_for_test(
    playlist_name: &str,
    source_kind: PlaylistPlayableIndexSourceKind,
) -> Result<()> {
    let runtime = try_runtime()?;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    let snapshot = state
        .playlists
        .get_mut(playlist_name)
        .ok_or_else(|| anyhow!("playlist source does not exist"))?;
    for source in &mut snapshot.sources {
        source.source_kind = source_kind;
    }
    Ok(())
}

#[cfg(not(test))]
#[allow(clippy::too_many_arguments)]
fn emit_index_trace(
    app: Option<&tauri::AppHandle>,
    event: &str,
    playlist_name: Option<&str>,
    reason: PlayableIndexRefreshReason,
    generation: u64,
    playlist_count: usize,
    source_count: usize,
    status: &str,
    committed: bool,
) {
    let Some(app) = app else {
        return;
    };
    if let Err(error) = (PlaybackDiagnosticTraceEvent {
        event: event.to_string(),
        playlist_name: playlist_name.map(str::to_string),
        music_name: None,
        music_url: None,
        start_ms: None,
        end_ms: None,
        elapsed_ms: None,
        candidate_count: Some(source_count),
        queue_count: None,
        status: Some(status.to_string()),
        error: None,
        details: Some(vec![
            PlaybackDiagnosticTraceDetail {
                key: "reason".to_string(),
                value: reason.as_str().to_string(),
            },
            PlaybackDiagnosticTraceDetail {
                key: "generation".to_string(),
                value: generation.to_string(),
            },
            PlaybackDiagnosticTraceDetail {
                key: "playlistCount".to_string(),
                value: playlist_count.to_string(),
            },
            PlaybackDiagnosticTraceDetail {
                key: "committed".to_string(),
                value: committed.to_string(),
            },
        ]),
    })
    .emit(app)
    {
        log::error!(
            target: PLAYABLE_INDEX_LOG_TARGET,
            "first_slot_trace_emit_failed event=\"{}\" error=\"{}\"",
            escape_log_value(event),
            escape_log_value(&error.to_string())
        );
    }
}

#[cfg(test)]
fn commit_playlist_snapshot(
    playlist_name: String,
    generation: u64,
    source: Option<PlaylistPlaybackTrackSource>,
    reason: PlayableIndexRefreshReason,
) -> Result<()> {
    let runtime = try_runtime()?;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    if !can_commit_refresh_snapshot(state.playlists.get(&playlist_name), reason) {
        return Ok(());
    }
    if let Some(source) = source {
        let track = playback_track_from_source_for_test(&playlist_name, &source);
        let current = state.playlists.get(&playlist_name);
        let prepared_sources = vec![PreparedPlaylistSource {
            source,
            track,
            source_kind: PlaylistPlayableIndexSourceKind::AudioStyle,
        }];
        if let Some(pool) = commit_prepared_sources_to_pool(
            runtime,
            current,
            playlist_name.clone(),
            generation,
            prepared_sources,
            reason,
        ) {
            state.playlists.insert(playlist_name.clone(), pool.pool);
            state
                .playlist_generations
                .insert(playlist_name.clone(), generation);
            notify_index_revision(runtime);
        }
    }
    Ok(())
}

#[cfg(test)]
fn playback_track_from_source_for_test(
    playlist_name: &str,
    source: &PlaylistPlaybackTrackSource,
) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: playlist_name.to_string(),
        music_name: source.music.alias.clone(),
        canonical_music_id: source.music.canonical_music_id.clone(),
        music_url: source.music.url.clone(),
        file_path: source
            .music
            .path
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_default(),
        source_music: Some(Box::new(source.music.clone())),
        start_ms: source.music.start_ms,
        end_ms: source.music.end_ms,
        liked: source.music.liked,
        loudness_profile: source.music.loudness_profile,
    }
}

fn escape_log_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
