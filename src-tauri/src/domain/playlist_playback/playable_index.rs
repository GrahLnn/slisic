#[cfg(not(test))]
use crate::domain::player::event::{PlaybackDiagnosticTraceDetail, PlaybackDiagnosticTraceEvent};
#[cfg(not(test))]
use crate::domain::playlist_playback::recommendation::{
    notify_audio_style_training_inputs_changed, published_audio_style_centerless_source,
};
#[cfg(not(test))]
use crate::domain::playlists::repo as playlist_repo;
use crate::domain::playlists::repo::{PlaylistPlaybackSelection, PlaylistPlaybackTrackSource};
use anyhow::{Result, anyhow};
use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicU64, Ordering},
};
#[cfg(not(test))]
use std::time::Instant;
#[cfg(not(test))]
use tauri_specta::Event;

const PLAYABLE_INDEX_LOG_TARGET: &str = "playlist_playback_index";

static PLAYABLE_INDEX_RUNTIME: OnceLock<Arc<PlayableIndexRuntime>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlayableIndexRefreshReason {
    Startup,
    Ready,
    PlaylistChanged,
    PlaylistDeleted,
    LibraryChanged,
    ExcludeChanged,
    PlaybackMiss,
    PreparedSourceConsumed,
}

impl PlayableIndexRefreshReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Startup => "startup",
            Self::Ready => "ready",
            Self::PlaylistChanged => "playlist_changed",
            Self::PlaylistDeleted => "playlist_deleted",
            Self::LibraryChanged => "library_changed",
            Self::ExcludeChanged => "exclude_changed",
            Self::PlaybackMiss => "playback_miss",
            Self::PreparedSourceConsumed => "prepared_source_consumed",
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
}

#[derive(Debug)]
struct PlayableIndexRuntime {
    generation: AtomicU64,
    #[cfg(not(test))]
    next_refresh_run_id: AtomicU64,
    state: Mutex<PlayableIndexState>,
}

#[derive(Debug, Default)]
struct PlayableIndexState {
    playlists: HashMap<String, PlaylistPlayableIndexSnapshot>,
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
 *     policy; a miss only schedules refresh work.
 *   - Every committed index value is generation stamped. A late rebuild can
 *     only commit when it still owns the latest generation for that playlist
 *     or global pass.
 *   - Refresh prepares one centerless audio-style startup option for each
 *     playlist and never stores a seed or deterministic order.
 *   - A prepared startup option is consumed by playlist name and generation
 *     after a current play request accepts it. Consumption removes only that
 *     playlist snapshot and schedules replacement preparation.
 *   - Refresh can be repeated, cancelled by supersession, or raced with ready
 *     transitions without producing extra semantic side effects.
 *   - The index never validates local file existence; playback service owns
 *     source elimination into `PlaybackTrack`.
 */
#[cfg(not(test))]
pub(crate) fn initialize_runtime(app: tauri::AppHandle) {
    runtime();
    spawn_refresh_all(app, PlayableIndexRefreshReason::Startup);
}

#[cfg(test)]
pub(crate) fn initialize_runtime_for_test() {
    let _ = runtime();
}

pub(crate) fn request_ready_refresh() {
    request_ready_refresh_impl();
}

#[cfg(not(test))]
pub(crate) fn request_ready_refresh_for_app(app: tauri::AppHandle) {
    spawn_refresh_all(app, PlayableIndexRefreshReason::Ready);
}

#[cfg(not(test))]
fn request_ready_refresh_impl() {
    spawn_refresh_all_without_app(PlayableIndexRefreshReason::Ready);
}

#[cfg(test)]
fn request_ready_refresh_impl() {}

pub(crate) fn notify_playlist_changed(playlist_name: &str) {
    notify_playlist_changed_impl(playlist_name);
}

pub(crate) fn notify_playlist_deleted(playlist_name: &str) {
    if let Ok(runtime) = try_runtime() {
        let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut state) = runtime.state.lock() {
            state.playlists.remove(playlist_name);
            state.active_refreshes.remove(playlist_name);
            state
                .playlist_generations
                .insert(playlist_name.to_string(), generation);
        }
    }
    log::info!(
        target: PLAYABLE_INDEX_LOG_TARGET,
        "first_slot_playlist_removed playlist=\"{}\" reason={}",
        escape_log_value(playlist_name),
        PlayableIndexRefreshReason::PlaylistDeleted.as_str()
    );
}

pub(crate) fn notify_library_changed(reason: PlayableIndexRefreshReason) {
    notify_library_changed_impl(reason);
}

pub(crate) fn notify_exclude_changed() {
    notify_library_changed_impl(PlayableIndexRefreshReason::ExcludeChanged);
}

pub(crate) fn notify_playback_miss(playlist_name: &str) {
    notify_playback_miss_impl(playlist_name);
}

pub(crate) fn consume_playlist_source(snapshot: &PlaylistPlayableIndexSnapshot) -> Result<bool> {
    let consumed = remove_playlist_source_snapshot(snapshot)?;
    if consumed {
        notify_prepared_source_consumed_impl(&snapshot.playlist_name);
    }
    Ok(consumed)
}

pub(crate) fn discard_playlist_source(snapshot: &PlaylistPlayableIndexSnapshot) -> Result<bool> {
    let discarded = remove_playlist_source_snapshot(snapshot)?;
    if discarded {
        notify_playback_miss_impl(&snapshot.playlist_name);
    }
    Ok(discarded)
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

#[cfg(not(test))]
fn notify_library_changed_impl(reason: PlayableIndexRefreshReason) {
    spawn_refresh_all_without_app(reason);
}

#[cfg(test)]
fn notify_library_changed_impl(_reason: PlayableIndexRefreshReason) {}

#[cfg(not(test))]
fn notify_playback_miss_impl(playlist_name: &str) {
    spawn_refresh_playlist(
        None,
        playlist_name.to_string(),
        PlayableIndexRefreshReason::PlaybackMiss,
    );
}

#[cfg(test)]
fn notify_playback_miss_impl(_playlist_name: &str) {}

#[cfg(not(test))]
fn notify_prepared_source_consumed_impl(playlist_name: &str) {
    spawn_refresh_playlist(
        None,
        playlist_name.to_string(),
        PlayableIndexRefreshReason::PreparedSourceConsumed,
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
    let Some(snapshot) = state.playlists.get(playlist_name) else {
        return Ok(None);
    };

    Ok(Some(PlaylistPlayableIndexSnapshot {
        playlist_name: snapshot.playlist_name.clone(),
        generation: snapshot.generation,
        source: snapshot.source.clone(),
    }))
}

fn remove_playlist_source_snapshot(snapshot: &PlaylistPlayableIndexSnapshot) -> Result<bool> {
    let runtime = try_runtime()?;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    let current_matches = state
        .playlists
        .get(&snapshot.playlist_name)
        .is_some_and(|current| current.generation == snapshot.generation);
    if !current_matches {
        return Ok(false);
    }

    state.playlists.remove(&snapshot.playlist_name);
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
        *state = PlayableIndexState::default();
    }
}

fn runtime() -> &'static Arc<PlayableIndexRuntime> {
    PLAYABLE_INDEX_RUNTIME.get_or_init(|| {
        Arc::new(PlayableIndexRuntime {
            generation: AtomicU64::new(0),
            #[cfg(not(test))]
            next_refresh_run_id: AtomicU64::new(0),
            state: Mutex::new(PlayableIndexState::default()),
        })
    })
}

fn try_runtime() -> Result<&'static Arc<PlayableIndexRuntime>> {
    PLAYABLE_INDEX_RUNTIME
        .get()
        .ok_or_else(|| anyhow!("playlist playable index runtime has not been initialized"))
}

#[cfg(test)]
fn next_generation() -> Result<u64> {
    Ok(try_runtime()?.generation.fetch_add(1, Ordering::SeqCst) + 1)
}

#[cfg(not(test))]
fn spawn_refresh_all_without_app(reason: PlayableIndexRefreshReason) {
    spawn_refresh_all_with_app(None, reason);
}

#[cfg(not(test))]
fn spawn_refresh_all(app: tauri::AppHandle, reason: PlayableIndexRefreshReason) {
    spawn_refresh_all_with_app(Some(app), reason);
}

#[cfg(not(test))]
fn spawn_refresh_all_with_app(app: Option<tauri::AppHandle>, reason: PlayableIndexRefreshReason) {
    let runtime = Arc::clone(runtime());
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
                state.playlists.clear();
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
            if reason.invalidates_existing_snapshots() {
                state.playlists.clear();
            }
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
        if let Err(error) = refresh_all(app, runtime, run_id, generation, reason).await {
            release_global_refresh_and_spawn_pending(None, &cleanup_runtime);
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
                state.playlists.remove(&playlist_name);
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
            if reason.invalidates_existing_snapshots() {
                state.playlists.remove(&playlist_name);
            }
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
            app,
            runtime,
            run_id,
            playlist_name.clone(),
            generation,
            reason,
        )
        .await
        {
            release_playlist_refresh(&cleanup_runtime, &cleanup_playlist_name, generation);
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
    let mut next = HashMap::new();
    for playlist in playlist_repo::list_playlists().await? {
        let Some(selection) =
            playlist_repo::get_playlist_playback_selection_by_name(&playlist.name).await?
        else {
            continue;
        };
        let source = prepare_playlist_source(&selection).await?;
        next.insert(
            selection.playlist_name.clone(),
            PlaylistPlayableIndexSnapshot {
                playlist_name: selection.playlist_name,
                generation,
                source,
            },
        );
    }

    let playlist_count = next.len();
    let source_count = next
        .values()
        .map(|snapshot| usize::from(snapshot.source.is_some()))
        .sum::<usize>();
    let next_names = next.keys().cloned().collect::<HashSet<_>>();
    let mut committed_count = 0usize;
    {
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
        for (playlist_name, snapshot) in next {
            let latest_generation = state
                .playlist_generations
                .get(&playlist_name)
                .copied()
                .unwrap_or(0);
            if snapshot.source.is_none() {
                continue;
            }
            let can_replace =
                can_commit_refresh_snapshot(state.playlists.get(&playlist_name), reason);
            if state.global_generation == generation
                && latest_generation <= generation
                && can_replace
            {
                state
                    .playlist_generations
                    .insert(playlist_name.clone(), generation);
                state.playlists.insert(playlist_name, snapshot);
                committed_count += 1;
            }
        }

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
                state.playlists.remove(&playlist_name);
                state.playlist_generations.insert(playlist_name, generation);
            }
        }
        state.active_global_refresh = false;
    };
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
    spawn_pending_global_refresh(app, &runtime);

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
    let snapshot =
        match playlist_repo::get_playlist_playback_selection_by_name(&playlist_name).await? {
            Some(selection) => {
                let source = prepare_playlist_source(&selection).await?;
                Some(PlaylistPlayableIndexSnapshot {
                    playlist_name: selection.playlist_name,
                    generation,
                    source,
                })
            }
            None => None,
        };
    let source_count = snapshot
        .as_ref()
        .map_or(0, |snapshot| usize::from(snapshot.source.is_some()));
    let mut committed = false;
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
            match snapshot {
                Some(snapshot) if snapshot.source.is_some() => {
                    let can_replace =
                        can_commit_refresh_snapshot(state.playlists.get(&playlist_name), reason);
                    if can_replace {
                        state
                            .playlists
                            .insert(snapshot.playlist_name.clone(), snapshot);
                        committed = true;
                    }
                }
                Some(_) => {}
                None => {
                    state.playlists.remove(&playlist_name);
                    committed = true;
                }
            }
        }
        state.active_refreshes.remove(&playlist_name);
        state.pending_refreshes.remove(&playlist_name)
    };
    if let Some(pending_reason) = pending_reason {
        spawn_refresh_playlist(app.clone(), playlist_name.clone(), pending_reason);
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
        spawn_refresh_playlist(None, playlist_name.to_string(), pending_reason);
    }
}

#[cfg(not(test))]
fn spawn_pending_global_refresh(
    app: Option<tauri::AppHandle>,
    runtime: &Arc<PlayableIndexRuntime>,
) {
    let pending_reason = {
        let Ok(mut state) = runtime.state.lock() else {
            log::error!(
                target: PLAYABLE_INDEX_LOG_TARGET,
                "first_slot_pending_global_refresh_claim_failed error=\"lock_poisoned\""
            );
            return;
        };
        state.pending_global_refresh.take()
    };
    let Some(pending_reason) = pending_reason else {
        return;
    };
    match app {
        Some(app) => spawn_refresh_all(app, pending_reason),
        None => spawn_refresh_all_without_app(pending_reason),
    }
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
    selection: &PlaylistPlaybackSelection,
) -> Result<Option<PlaylistPlaybackTrackSource>> {
    if let Some((source, selection_trace)) =
        published_audio_style_centerless_source(|source| selection.contains_track_source(source))
    {
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
        return Ok(Some(source));
    }

    notify_audio_style_training_inputs_changed("first_slot_model_unavailable");
    log::warn!(
        target: PLAYABLE_INDEX_LOG_TARGET,
        "first_slot_source_unavailable playlist=\"{}\" status=model_unavailable action=request_training",
        escape_log_value(&selection.playlist_name)
    );
    Ok(None)
}

fn should_skip_global_refresh(
    state: &PlayableIndexState,
    reason: PlayableIndexRefreshReason,
) -> bool {
    if reason.invalidates_existing_snapshots() || state.active_global_refresh {
        return false;
    }
    !state.playlists.is_empty()
        && state
            .playlists
            .values()
            .all(playlist_snapshot_has_prepared_source)
}

fn should_skip_playlist_refresh(
    state: &PlayableIndexState,
    playlist_name: &str,
    reason: PlayableIndexRefreshReason,
) -> bool {
    !reason.invalidates_existing_snapshots()
        && state
            .playlists
            .get(playlist_name)
            .is_some_and(playlist_snapshot_has_prepared_source)
}

fn can_commit_refresh_snapshot(
    current: Option<&PlaylistPlayableIndexSnapshot>,
    reason: PlayableIndexRefreshReason,
) -> bool {
    reason.replaces_existing_snapshots()
        || current.is_none_or(|snapshot| !playlist_snapshot_has_prepared_source(snapshot))
}

fn playlist_snapshot_has_prepared_source(snapshot: &PlaylistPlayableIndexSnapshot) -> bool {
    snapshot.source.is_some()
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
pub(crate) fn claim_global_refresh_for_test(reason: PlayableIndexRefreshReason) -> Result<u64> {
    let runtime = try_runtime()?;
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    if reason.invalidates_existing_snapshots() {
        state.playlists.clear();
    }
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
        state.playlists.clear();
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
    let can_replace = can_commit_refresh_snapshot(state.playlists.get(&playlist_name), reason);
    let committed =
        state.global_generation == generation && latest_generation <= generation && can_replace;
    if committed {
        if let Some(source) = source {
            state
                .playlist_generations
                .insert(playlist_name.clone(), generation);
            state.playlists.insert(
                playlist_name.clone(),
                PlaylistPlayableIndexSnapshot {
                    playlist_name,
                    generation,
                    source: Some(source),
                },
            );
        }
    }
    state.active_global_refresh = false;
    Ok(committed)
}

#[cfg(test)]
pub(crate) fn claim_playlist_refresh_for_test(
    playlist_name: &str,
    reason: PlayableIndexRefreshReason,
) -> Result<u64> {
    let runtime = try_runtime()?;
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| anyhow!("playlist playable index lock is poisoned"))?;
    if reason.invalidates_existing_snapshots() {
        state.playlists.remove(playlist_name);
    }
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
                let can_replace =
                    can_commit_refresh_snapshot(state.playlists.get(&playlist_name), reason);
                if can_replace {
                    state.playlists.insert(
                        playlist_name.clone(),
                        PlaylistPlayableIndexSnapshot {
                            playlist_name: playlist_name.clone(),
                            generation,
                            source: Some(source),
                        },
                    );
                }
            }
            None => {}
        }
    }
    state.active_refreshes.remove(&playlist_name);
    Ok(committed)
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
    if !reason.replaces_existing_snapshots() && state.playlists.contains_key(&playlist_name) {
        return Ok(());
    }
    state.playlists.insert(
        playlist_name.clone(),
        PlaylistPlayableIndexSnapshot {
            playlist_name: playlist_name.clone(),
            generation,
            source,
        },
    );
    state
        .playlist_generations
        .insert(playlist_name.clone(), generation);
    Ok(())
}

fn escape_log_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
