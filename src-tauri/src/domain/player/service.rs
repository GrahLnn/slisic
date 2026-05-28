#[cfg(not(test))]
use super::event::{NowPlayingTrackChangedEvent, PlaybackDiagnosticTraceEvent};
use super::model::PlaybackContinuationMode;
#[cfg(not(test))]
use super::model::PlaybackStatusPayload;
use super::model::PlaybackTrack;
use super::strategy::PlaybackQueueMode;
#[cfg(not(test))]
use super::strategy::PlaybackStrategySet;
#[cfg(not(test))]
use super::waveform::{self, TrackWaveform, TrackWaveformSummary, TrackWaveformTile};
#[cfg(not(test))]
use crate::utils::binaries::{ManagedBinary, ensure_managed_binary};
#[cfg(not(test))]
use anyhow::{Context, Result, anyhow, bail};
use ffplayr::PlaybackNormalization;
#[cfg(not(test))]
use ffplayr::{Playback, PlaybackRequest, PlaybackTimeRange};
#[cfg(not(test))]
use std::path::Path;
#[cfg(not(test))]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(not(test))]
use std::sync::{Arc, Mutex, OnceLock, RwLock};
#[cfg(not(test))]
use std::time::{Duration, Instant};
#[cfg(not(test))]
use tauri::{AppHandle, Manager};
#[cfg(not(test))]
use tauri_specta::Event;

#[cfg(not(test))]
static PLAYER_RUNTIME: OnceLock<Arc<PlayerRuntime>> = OnceLock::new();
#[cfg(not(test))]
const PLAYBACK_SESSION_STATUS_POLL_MS: u64 = 250;
#[cfg(not(test))]
const PLAYBACK_SESSION_QUEUE_WAIT_POLL_MS: u64 = 50;
#[cfg(not(test))]
const SPECTRUM_LOOP_SIGNAL_STATUS_POLL_MS: u64 = 16;
pub(crate) const BACKEND_PLAYBACK_TARGET_LUFS: f32 = -18.0;

#[cfg(not(test))]
pub struct PlayerRuntime {
    app: AppHandle,
    playback: Mutex<Option<Playback>>,
    session: Mutex<Option<ActivePlaybackSession>>,
    start_requests: PlaybackStartRequestRegistry,
    active_request_track: RwLock<Option<PlaybackTrack>>,
    active_playback_range: RwLock<Option<ActivePlaybackRange>>,
    spectrum_playback_scope: RwLock<Option<SpectrumPlaybackScope>>,
    spectrum_playback_loop_signal: RwLock<Option<SpectrumPlaybackLoopSignal>>,
    temporary_playback_pause: RwLock<bool>,
    continuation_mode: RwLock<PlaybackContinuationMode>,
    generation: AtomicU64,
    spectrum_playback_scope_generation: AtomicU64,
    active_binary_tasks: AtomicUsize,
}

#[cfg(not(test))]
type SharedPlaybackTracks = Arc<RwLock<Vec<PlaybackTrack>>>;

#[cfg(not(test))]
type SharedPlaybackStrategy = Arc<Mutex<PlaybackStrategySet>>;

#[cfg(not(test))]
struct ActivePlaybackSession {
    playlist_name: String,
    generation: u64,
    tracks: SharedPlaybackTracks,
    strategy: SharedPlaybackStrategy,
    queue_mode: PlaybackQueueMode,
}

#[cfg(not(test))]
struct SpectrumPlaybackStartPlan {
    session: PlaybackSession,
    track: PlaybackTrack,
}

#[cfg(not(test))]
#[derive(Debug)]
pub(crate) struct PlaybackStartRequestSuperseded;

#[cfg(not(test))]
impl std::fmt::Display for PlaybackStartRequestSuperseded {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("playback start request was superseded")
    }
}

#[cfg(not(test))]
impl std::error::Error for PlaybackStartRequestSuperseded {}

#[cfg(not(test))]
pub(crate) fn is_playback_start_request_superseded(error: &anyhow::Error) -> bool {
    error.is::<PlaybackStartRequestSuperseded>()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ActivePlaybackRange {
    pub(crate) start_ms: u32,
    pub(crate) end_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SpectrumPlaybackScope {
    pub(crate) id: u64,
}

#[cfg(not(test))]
struct ActiveBinaryTaskGuard {
    runtime: Arc<PlayerRuntime>,
}

#[cfg(not(test))]
impl ActiveBinaryTaskGuard {
    fn new(runtime: Arc<PlayerRuntime>) -> Self {
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

#[cfg(not(test))]
#[derive(Clone)]
pub(crate) struct PlaybackSessionHandle {
    playlist_name: String,
    generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PlaybackStartRequestHandle {
    generation: u64,
}

#[derive(Debug, Default)]
pub(crate) struct PlaybackStartRequestRegistry {
    generation: AtomicU64,
}

impl PlaybackStartRequestRegistry {
    pub(crate) fn claim(&self) -> PlaybackStartRequestHandle {
        PlaybackStartRequestHandle {
            generation: self.generation.fetch_add(1, Ordering::SeqCst) + 1,
        }
    }

    pub(crate) fn cancel_pending(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn is_current(&self, handle: &PlaybackStartRequestHandle) -> bool {
        self.generation.load(Ordering::SeqCst) == handle.generation
    }
}

#[cfg(not(test))]
pub fn initialize_runtime(app: AppHandle) {
    let _ = PLAYER_RUNTIME.get_or_init(|| {
        Arc::new(PlayerRuntime {
            app,
            playback: Mutex::new(None),
            session: Mutex::new(None),
            start_requests: PlaybackStartRequestRegistry::default(),
            active_request_track: RwLock::new(None),
            active_playback_range: RwLock::new(None),
            spectrum_playback_scope: RwLock::new(None),
            spectrum_playback_loop_signal: RwLock::new(None),
            temporary_playback_pause: RwLock::new(false),
            continuation_mode: RwLock::new(PlaybackContinuationMode::Random),
            generation: AtomicU64::new(0),
            spectrum_playback_scope_generation: AtomicU64::new(0),
            active_binary_tasks: AtomicUsize::new(0),
        })
    });
}

#[cfg(not(test))]
struct PlayerTrace<'a> {
    app: &'a AppHandle,
    playlist_name: Option<&'a str>,
    track: Option<&'a PlaybackTrack>,
    elapsed_ms: Option<u128>,
    queue_count: Option<usize>,
    status: Option<&'a str>,
    error: Option<String>,
}

#[cfg(not(test))]
impl<'a> PlayerTrace<'a> {
    fn new(app: &'a AppHandle) -> Self {
        Self {
            app,
            playlist_name: None,
            track: None,
            elapsed_ms: None,
            queue_count: None,
            status: None,
            error: None,
        }
    }

    fn playlist_name(mut self, playlist_name: &'a str) -> Self {
        self.playlist_name = Some(playlist_name);
        self
    }

    fn track(mut self, track: &'a PlaybackTrack) -> Self {
        self.track = Some(track);
        self
    }

    fn elapsed(mut self, start: Instant) -> Self {
        self.elapsed_ms = Some(start.elapsed().as_millis());
        self
    }

    fn queue_count(mut self, queue_count: usize) -> Self {
        self.queue_count = Some(queue_count);
        self
    }

    fn status(mut self, status: &'a str) -> Self {
        self.status = Some(status);
        self
    }

    fn error(mut self, error: impl ToString) -> Self {
        self.error = Some(error.to_string());
        self
    }
}

#[cfg(not(test))]
fn emit_player_trace(event: &str, trace: PlayerTrace<'_>) {
    let playlist_name = trace
        .playlist_name
        .map(str::to_string)
        .or_else(|| trace.track.map(|track| track.playlist_name.clone()));
    let music_name = trace.track.map(|track| track.music_name.clone());
    let music_url = trace.track.map(|track| track.music_url.clone());
    let start_ms = trace.track.map(|track| track.start_ms);
    let end_ms = trace.track.map(|track| track.end_ms);

    if let Err(error) = (PlaybackDiagnosticTraceEvent {
        event: event.to_string(),
        playlist_name,
        music_name,
        music_url,
        start_ms,
        end_ms,
        elapsed_ms: trace.elapsed_ms,
        candidate_count: None,
        queue_count: trace.queue_count,
        status: trace.status.map(str::to_string),
        error: trace.error,
        details: None,
    })
    .emit(trace.app)
    {
        eprintln!("[player] failed to emit diagnostic trace `{event}`: {error}");
    }
}

#[cfg(not(test))]
pub(crate) fn has_active_player_binary_tasks() -> bool {
    let Some(runtime) = PLAYER_RUNTIME.get() else {
        return false;
    };

    runtime.active_binary_tasks.load(Ordering::SeqCst) > 0
}

#[cfg(not(test))]
pub(crate) async fn play_tracks_from_initial_track_for_request_with_queue_mode(
    request: &PlaybackStartRequestHandle,
    playlist_name: String,
    tracks: Vec<PlaybackTrack>,
    initial_track: PlaybackTrack,
    queue_mode: PlaybackQueueMode,
) -> Result<PlaybackSessionHandle> {
    play_tracks_with_initial_track(
        playlist_name,
        tracks,
        Some(initial_track),
        queue_mode,
        Some(*request),
    )
    .await
}

#[cfg(not(test))]
async fn play_tracks_with_initial_track(
    playlist_name: String,
    tracks: Vec<PlaybackTrack>,
    initial_track: Option<PlaybackTrack>,
    queue_mode: PlaybackQueueMode,
    start_request: Option<PlaybackStartRequestHandle>,
) -> Result<PlaybackSessionHandle> {
    let trace_start = Instant::now();
    if tracks.is_empty() {
        bail!("playback session `{playlist_name}` does not contain any playable tracks");
    }
    if let Some(initial_track) = initial_track.as_ref()
        && !tracks
            .iter()
            .any(|track| are_playback_tracks_equal(track, initial_track))
    {
        bail!("initial playback track is not in session `{playlist_name}`");
    }

    let runtime = runtime()?;
    emit_player_trace(
        "player-session-start",
        PlayerTrace::new(&runtime.app)
            .playlist_name(&playlist_name)
            .elapsed(trace_start)
            .queue_count(tracks.len()),
    );
    let start_request = start_request.unwrap_or_else(|| runtime.claim_playback_start_request());
    if !runtime.is_playback_start_request_current(&start_request) {
        emit_player_trace(
            "player-session-superseded-before-playback",
            PlayerTrace::new(&runtime.app)
                .playlist_name(&playlist_name)
                .elapsed(trace_start),
        );
        return Err(PlaybackStartRequestSuperseded.into());
    }

    let active_binary_task = ActiveBinaryTaskGuard::new(Arc::clone(runtime));
    let playback = runtime.playback()?;
    if !runtime.is_playback_start_request_current(&start_request) {
        emit_player_trace(
            "player-session-superseded-after-playback",
            PlayerTrace::new(&runtime.app)
                .playlist_name(&playlist_name)
                .elapsed(trace_start),
        );
        return Err(PlaybackStartRequestSuperseded.into());
    }

    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;

    emit_player_trace(
        "player-session-stop-start",
        PlayerTrace::new(&runtime.app)
            .playlist_name(&playlist_name)
            .elapsed(trace_start),
    );
    if let Err(error) = playback.stop().await {
        eprintln!("[player] failed to stop previous playback before restart: {error}");
        emit_player_trace(
            "player-session-stop-error",
            PlayerTrace::new(&runtime.app)
                .playlist_name(&playlist_name)
                .elapsed(trace_start)
                .error(error),
        );
    } else {
        emit_player_trace(
            "player-session-stop-ok",
            PlayerTrace::new(&runtime.app)
                .playlist_name(&playlist_name)
                .elapsed(trace_start),
        );
    }
    if !runtime.is_playback_start_request_current(&start_request) {
        runtime.generation.fetch_add(1, Ordering::SeqCst);
        emit_player_trace(
            "player-session-superseded-after-stop",
            PlayerTrace::new(&runtime.app)
                .playlist_name(&playlist_name)
                .elapsed(trace_start),
        );
        return Err(PlaybackStartRequestSuperseded.into());
    }
    runtime.set_temporary_playback_pause(false)?;

    let shared_tracks = Arc::new(RwLock::new(tracks));
    let shared_strategy = Arc::new(Mutex::new(PlaybackStrategySet::new()));
    runtime.replace_active_session(
        playlist_name.clone(),
        generation,
        Arc::clone(&shared_tracks),
        Arc::clone(&shared_strategy),
        queue_mode,
    )?;
    emit_player_trace(
        "player-session-active-replaced",
        PlayerTrace::new(&runtime.app)
            .playlist_name(&playlist_name)
            .elapsed(trace_start),
    );

    let session = PlaybackSession {
        playlist_name: playlist_name.clone(),
        tracks: shared_tracks,
        strategy: shared_strategy,
        queue_mode,
        initial_request: initial_track.map(|track| InitialPlaybackRequest {
            pause_after_start: false,
            range: ActivePlaybackRange {
                start_ms: track.start_ms,
                end_ms: track.end_ms,
            },
            scope: None,
            track,
        }),
    };
    runtime.clear_spectrum_playback_scope()?;
    runtime.clear_spectrum_playback_loop_signal()?;
    emit_player_trace(
        "player-session-spawn",
        PlayerTrace::new(&runtime.app)
            .playlist_name(&playlist_name)
            .elapsed(trace_start),
    );
    let runtime_for_task = Arc::clone(runtime);
    let playback_for_task = playback.clone();
    let task_playlist_name = playlist_name.clone();

    tauri::async_runtime::spawn(async move {
        let _active_binary_task = active_binary_task;
        if let Err(error) = run_playback_session(
            Arc::clone(&runtime_for_task),
            playback_for_task,
            generation,
            session,
        )
        .await
        {
            eprintln!("[player] playback session failed for `{task_playlist_name}`: {error}");
        }
    });

    Ok(PlaybackSessionHandle {
        playlist_name,
        generation,
    })
}

#[cfg(not(test))]
pub async fn play_spectrum_music(
    scope_id: u64,
    track: PlaybackTrack,
    position_ms: Option<u32>,
) -> Result<PlaybackSessionHandle> {
    play_track_in_current_session(scope_id, track, position_ms, false).await
}

#[cfg(not(test))]
pub async fn restore_spectrum_music(
    scope_id: u64,
    track: PlaybackTrack,
    position_ms: Option<u32>,
) -> Result<PlaybackSessionHandle> {
    play_track_in_current_session(scope_id, track, position_ms, true).await
}

#[cfg(not(test))]
pub(crate) fn update_session_tracks(
    handle: &PlaybackSessionHandle,
    tracks: Vec<PlaybackTrack>,
) -> Result<bool> {
    if tracks.is_empty() {
        return Ok(is_session_current(handle)?);
    }

    runtime()?.replace_session_tracks(handle, tracks)
}

#[cfg(not(test))]
pub(crate) fn update_current_session_tracks(tracks: Vec<PlaybackTrack>) -> Result<bool> {
    runtime()?.replace_current_session_tracks(tracks)
}

#[cfg(not(test))]
pub(crate) fn current_session_tracks_snapshot() -> Result<Vec<PlaybackTrack>> {
    runtime()?.current_session_tracks_snapshot()
}

#[cfg(not(test))]
pub(crate) fn active_request_track_snapshot() -> Result<Option<PlaybackTrack>> {
    runtime()?.active_request_track_snapshot()
}

#[derive(Debug, Clone)]
pub(crate) struct PlaybackTrackIdentityUpdate {
    pub(crate) music_name: String,
    pub(crate) music_url: String,
    pub(crate) start_ms: u32,
    pub(crate) end_ms: u32,
    pub(crate) next_start_ms: u32,
    pub(crate) next_end_ms: u32,
}

#[cfg(not(test))]
pub(crate) fn update_current_session_track_identity(
    update: &PlaybackTrackIdentityUpdate,
) -> Result<bool> {
    runtime()?.update_current_session_track_identity(update)
}

#[derive(Debug, Clone)]
pub(crate) struct PlaybackTrackLikedUpdate {
    pub(crate) canonical_music_id: String,
    pub(crate) liked: bool,
}

#[cfg(not(test))]
pub(crate) fn update_current_session_track_liked(
    update: &PlaybackTrackLikedUpdate,
) -> Result<bool> {
    runtime()?.update_current_session_track_liked(update)
}

#[cfg(not(test))]
pub async fn play_track_in_current_session(
    scope_id: u64,
    track: PlaybackTrack,
    position_ms: Option<u32>,
    pause_after_start: bool,
) -> Result<PlaybackSessionHandle> {
    let runtime = runtime()?;
    let scope = SpectrumPlaybackScope { id: scope_id };
    if !runtime.is_spectrum_playback_scope_active(scope)? {
        bail!("spectrum playback signal is not active");
    }
    let plan = runtime.resolve_spectrum_playback_start_plan(
        scope,
        track,
        position_ms,
        pause_after_start,
    )?;
    let active_binary_task = ActiveBinaryTaskGuard::new(Arc::clone(runtime));
    let playback = runtime.playback()?;
    if !runtime.is_spectrum_playback_scope_active(scope)? {
        bail!("spectrum playback signal is not active");
    }

    let start_request = runtime.claim_playback_start_request();
    if let Err(error) = playback.stop().await {
        eprintln!("[player] failed to stop previous playback before selecting track: {error}");
    }
    if !runtime.is_playback_start_request_current(&start_request) {
        return Err(PlaybackStartRequestSuperseded.into());
    }
    if !runtime.is_spectrum_playback_scope_active(scope)? {
        bail!("spectrum playback signal is not active");
    }
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    runtime.set_temporary_playback_pause(false)?;
    runtime.clear_spectrum_playback_loop_signal()?;
    let default_loop_signal = resolve_spectrum_playback_loop_signal(
        scope,
        &plan.track,
        plan.track.start_ms,
        plan.track.end_ms,
    )
    .ok_or_else(|| anyhow!("invalid spectrum playback loop signal"))?;
    runtime.set_spectrum_playback_loop_signal(Some(default_loop_signal))?;

    let runtime_for_task = Arc::clone(runtime);
    let playback_for_task = playback.clone();
    let task_playlist_name = plan.session.playlist_name.clone();
    let session = plan.session;
    let handle_playlist_name = plan.track.playlist_name;

    tauri::async_runtime::spawn(async move {
        let _active_binary_task = active_binary_task;
        if let Err(error) = run_playback_session(
            Arc::clone(&runtime_for_task),
            playback_for_task,
            generation,
            session,
        )
        .await
        {
            eprintln!("[player] playback session failed for `{task_playlist_name}`: {error}");
        }
    });

    Ok(PlaybackSessionHandle {
        playlist_name: handle_playlist_name,
        generation,
    })
}

#[cfg(not(test))]
pub(crate) fn is_session_current(handle: &PlaybackSessionHandle) -> Result<bool> {
    runtime()?.is_session_current(handle)
}

#[cfg(not(test))]
pub(crate) fn active_request_track_snapshot_for_session(
    handle: &PlaybackSessionHandle,
) -> Result<Option<PlaybackTrack>> {
    runtime()?.active_request_track_snapshot_for_session(handle)
}

#[cfg(not(test))]
pub(crate) fn claim_playback_start_request() -> Result<PlaybackStartRequestHandle> {
    Ok(runtime()?.claim_playback_start_request())
}

#[cfg(not(test))]
pub(crate) fn is_playback_start_request_current(
    handle: &PlaybackStartRequestHandle,
) -> Result<bool> {
    Ok(runtime()?.is_playback_start_request_current(handle))
}

#[cfg(not(test))]
pub async fn stop_playback() -> Result<bool> {
    let runtime = runtime()?;
    runtime.cancel_pending_playback_start_requests();
    runtime.generation.fetch_add(1, Ordering::SeqCst);
    runtime.clear_active_session()?;
    runtime.set_temporary_playback_pause(false)?;
    runtime.clear_spectrum_playback_loop_signal()?;
    let Some(playback) = runtime.current_playback()? else {
        return Ok(false);
    };

    playback
        .stop()
        .await
        .map_err(|error| anyhow!("failed to stop playback: {error}"))?;

    Ok(true)
}

#[cfg(not(test))]
pub async fn pause_playback() -> Result<bool> {
    let runtime = runtime()?;
    runtime.set_temporary_playback_pause(false)?;
    let Some(playback) = runtime.current_playback()? else {
        return Ok(false);
    };

    playback
        .pause()
        .await
        .map_err(|error| anyhow!("failed to pause playback: {error}"))?;

    Ok(true)
}

#[cfg(not(test))]
pub async fn resume_playback() -> Result<bool> {
    let runtime = runtime()?;
    runtime.set_temporary_playback_pause(false)?;
    let Some(playback) = runtime.current_playback()? else {
        return Ok(false);
    };

    playback
        .resume()
        .await
        .map_err(|error| anyhow!("failed to resume playback: {error}"))?;

    Ok(true)
}

#[cfg(not(test))]
pub async fn skip_current_track() -> Result<bool> {
    let runtime = runtime()?;
    runtime.set_temporary_playback_pause(false)?;
    runtime.clear_spectrum_playback_loop_signal()?;
    runtime.clear_active_playback_range()?;
    let Some(playback) = runtime.current_playback()? else {
        return Ok(false);
    };

    playback
        .stop()
        .await
        .map_err(|error| anyhow!("failed to skip current playback: {error}"))?;

    Ok(true)
}

#[cfg(not(test))]
pub async fn pause_spectrum_music(scope_id: u64) -> Result<bool> {
    let runtime = runtime()?;
    if !runtime.is_spectrum_playback_scope_active(SpectrumPlaybackScope { id: scope_id })? {
        return Ok(false);
    }
    let Some(playback) = runtime.current_playback()? else {
        return Ok(false);
    };

    runtime.set_temporary_playback_pause(false)?;
    playback
        .pause()
        .await
        .map_err(|error| anyhow!("failed to pause spectrum playback: {error}"))?;

    Ok(true)
}

#[cfg(not(test))]
pub async fn resume_spectrum_music(scope_id: u64, _track: PlaybackTrack) -> Result<bool> {
    let runtime = runtime()?;
    if !runtime.is_spectrum_playback_scope_active(SpectrumPlaybackScope { id: scope_id })? {
        return Ok(false);
    }
    let Some(playback) = runtime.current_playback()? else {
        return Ok(false);
    };

    runtime.set_temporary_playback_pause(false)?;
    playback
        .resume()
        .await
        .map_err(|error| anyhow!("failed to resume spectrum playback: {error}"))?;

    Ok(true)
}

#[cfg(not(test))]
pub async fn update_spectrum_playback_loop_signal(
    scope_id: u64,
    track: PlaybackTrack,
    start_ms: u32,
    end_ms: u32,
) -> Result<Option<PlaybackStatusPayload>> {
    let runtime = runtime()?;
    let scope = SpectrumPlaybackScope { id: scope_id };
    if !runtime.is_spectrum_playback_scope_active(scope)? {
        return Ok(None);
    }
    let Some(playback) = runtime.current_playback()? else {
        return Ok(None);
    };
    let Some(active_track) = runtime.active_request_track_snapshot()? else {
        return Ok(None);
    };
    if !are_playback_tracks_equal(&active_track, &track) {
        return Ok(None);
    }
    if !runtime.is_spectrum_playback_scope_active(scope)? {
        return Ok(None);
    }

    let Some(signal) = resolve_spectrum_playback_loop_signal(scope, &track, start_ms, end_ms)
    else {
        return Ok(None);
    };
    runtime.set_spectrum_playback_loop_signal(Some(signal.clone()))?;

    let status = playback.status().await.map_err(|error| {
        anyhow!("failed to read playback status before spectrum loop signal update: {error}")
    })?;
    if resolve_playback_status_track_identity(status.path.as_deref(), Some(&active_track)).is_none()
    {
        return get_playback_status().await;
    }

    let active_range = runtime.active_playback_range_snapshot()?;
    let current_position_ms = resolve_playback_absolute_position_ms(&status, active_range);
    let Some(seek_position_ms) =
        resolve_spectrum_loop_signal_seek_position(current_position_ms, signal.range)
    else {
        let next_active_range =
            resolve_spectrum_loop_signal_active_range(active_range, signal.range);
        runtime.set_active_playback_range(Some(next_active_range))?;
        return get_playback_status().await;
    };
    let pause_after_seek = resolve_playback_seek_pause_after_request(
        status.playing,
        status.paused,
        runtime.temporary_playback_pause()?,
    );
    let range = ActivePlaybackRange {
        start_ms: seek_position_ms,
        end_ms: signal.range.end_ms,
    };
    let request = playback_request_for_path_position(&active_track.file_path, range.start_ms);
    playback
        .play_request(request)
        .await
        .map_err(|error| anyhow!("failed to seek after spectrum loop signal update: {error}"))?;
    runtime.set_active_playback_range(Some(range))?;

    if pause_after_seek {
        playback.pause().await.map_err(|error| {
            anyhow!("failed to pause playback after spectrum loop signal update: {error}")
        })?;
    }
    runtime.set_temporary_playback_pause(false)?;

    get_playback_status().await
}

#[cfg(not(test))]
pub async fn begin_playback_seek() -> Result<Option<PlaybackStatusPayload>> {
    let runtime = runtime()?;
    let Some(playback) = runtime.current_playback()? else {
        return Ok(None);
    };
    let Some(active_track) = runtime.active_request_track_snapshot()? else {
        return Ok(None);
    };

    let status = playback
        .status()
        .await
        .map_err(|error| anyhow!("failed to read playback status before seek drag: {error}"))?;
    if resolve_playback_status_track_identity(status.path.as_deref(), Some(&active_track)).is_none()
    {
        return Ok(None);
    }

    if status.playing && !status.paused {
        playback
            .pause()
            .await
            .map_err(|error| anyhow!("failed to pause playback for seek drag: {error}"))?;
        runtime.set_temporary_playback_pause(true)?;
    } else {
        runtime.set_temporary_playback_pause(false)?;
    }

    get_playback_status().await
}

#[cfg(not(test))]
pub async fn cancel_playback_seek() -> Result<Option<PlaybackStatusPayload>> {
    let runtime = runtime()?;
    let Some(playback) = runtime.current_playback()? else {
        runtime.set_temporary_playback_pause(false)?;
        return Ok(None);
    };

    let status = playback
        .status()
        .await
        .map_err(|error| anyhow!("failed to read playback status before seek cancel: {error}"))?;
    let active_track = runtime.active_request_track_snapshot()?;
    let status_matches_track =
        resolve_playback_status_track_identity(status.path.as_deref(), active_track.as_ref())
            .is_some();

    if should_resume_playback_seek_cancel(
        status_matches_track,
        status.playing,
        status.paused,
        runtime.temporary_playback_pause()?,
    ) {
        playback
            .resume()
            .await
            .map_err(|error| anyhow!("failed to resume playback after cancelled seek: {error}"))?;
    }
    runtime.set_temporary_playback_pause(false)?;

    get_playback_status().await
}

#[cfg(not(test))]
pub async fn seek_playback(position_ms: u32, end_ms: u32) -> Result<Option<PlaybackStatusPayload>> {
    let runtime = runtime()?;
    let Some(playback) = runtime.current_playback()? else {
        return Ok(None);
    };
    let Some(active_track) = runtime.active_request_track_snapshot()? else {
        return Ok(None);
    };

    let status = playback
        .status()
        .await
        .map_err(|error| anyhow!("failed to read playback status before seek: {error}"))?;
    if resolve_playback_status_track_identity(status.path.as_deref(), Some(&active_track)).is_none()
    {
        return Ok(None);
    }
    let pause_after_seek = resolve_playback_seek_pause_after_request(
        status.playing,
        status.paused,
        runtime.temporary_playback_pause()?,
    );

    let Some(range) = resolve_playback_seek_range(position_ms, end_ms) else {
        return Ok(None);
    };
    let request = playback_request_for_path_position(
        &active_track.file_path,
        resolve_playback_request_position(range),
    );
    playback
        .play_request(request)
        .await
        .map_err(|error| anyhow!("failed to seek playback: {error}"))?;
    runtime.set_active_playback_range(Some(range))?;

    if pause_after_seek {
        playback
            .pause()
            .await
            .map_err(|error| anyhow!("failed to pause playback after seek: {error}"))?;
    }
    runtime.set_temporary_playback_pause(false)?;

    get_playback_status().await
}

#[cfg(not(test))]
pub async fn get_playback_status() -> Result<Option<PlaybackStatusPayload>> {
    let runtime = runtime()?;
    let Some(playback) = runtime.current_playback()? else {
        return Ok(None);
    };

    let status = playback
        .status()
        .await
        .map_err(|error| anyhow!("failed to read playback status: {error}"))?;
    let active_request_track =
        runtime.active_request_track_for_status_path(status.path.as_deref())?;
    let active_playback_range = if active_request_track.is_some() {
        runtime.active_playback_range_snapshot()?
    } else {
        None
    };
    let temporary_playback_pause =
        active_request_track.is_some() && runtime.temporary_playback_pause()?;

    Ok(Some(PlaybackStatusPayload {
        path: status.path,
        playing: if temporary_playback_pause {
            true
        } else {
            status.playing
        },
        paused: if temporary_playback_pause {
            false
        } else {
            status.paused
        },
        position_ms: status.position_ms,
        duration_ms: status.duration_ms,
        playlist_name: active_request_track
            .as_ref()
            .map(|track| track.playlist_name.clone()),
        music_url: active_request_track
            .as_ref()
            .map(|track| track.music_url.clone()),
        track_start_ms: active_request_track.as_ref().map(|track| track.start_ms),
        track_end_ms: active_request_track.as_ref().map(|track| track.end_ms),
        playback_start_ms: active_playback_range
            .as_ref()
            .map(|range| range.start_ms)
            .or_else(|| active_request_track.as_ref().map(|track| track.start_ms)),
        playback_end_ms: active_playback_range
            .as_ref()
            .map(|range| range.end_ms)
            .or_else(|| active_request_track.as_ref().map(|track| track.end_ms)),
    }))
}

#[cfg(not(test))]
pub async fn analyze_track_waveform(
    app: &AppHandle,
    file_path: String,
    start: Option<u32>,
    end: Option<u32>,
) -> Result<TrackWaveform> {
    let runtime = runtime()?;
    let active_binary_task = ActiveBinaryTaskGuard::new(Arc::clone(runtime));
    let ffmpeg_path =
        ensure_managed_binary(app, ManagedBinary::Ffmpeg).map_err(|error| anyhow!(error))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _active_binary_task = active_binary_task;
        waveform::analyze_track_waveform_with_binary(&ffmpeg_path, file_path, start, end)
    })
    .await
    .map_err(|error| anyhow!("waveform analysis task failed: {error}"))?
    .map_err(|error| anyhow!(error))
}

#[cfg(not(test))]
pub async fn prepare_track_waveform(
    app: &AppHandle,
    file_path: String,
    start: Option<u32>,
    end: Option<u32>,
) -> Result<TrackWaveformSummary> {
    let runtime = runtime()?;
    let active_binary_task = ActiveBinaryTaskGuard::new(Arc::clone(runtime));
    let ffmpeg_path =
        ensure_managed_binary(app, ManagedBinary::Ffmpeg).map_err(|error| anyhow!(error))?;
    let cache_root = waveform_cache_root(app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let _active_binary_task = active_binary_task;
        waveform::prepare_track_waveform_cache(&ffmpeg_path, &cache_root, file_path, start, end)
    })
    .await
    .map_err(|error| anyhow!("waveform cache preparation task failed: {error}"))?
    .map_err(|error| anyhow!(error))
}

#[cfg(not(test))]
pub async fn get_track_waveform_tile(
    app: &AppHandle,
    file_path: String,
    start: Option<u32>,
    end: Option<u32>,
    pixels_per_second: f64,
    tile_start_px: u32,
    tile_width: u32,
) -> Result<TrackWaveformTile> {
    let runtime = runtime()?;
    let active_binary_task = ActiveBinaryTaskGuard::new(Arc::clone(runtime));
    let ffmpeg_path =
        ensure_managed_binary(app, ManagedBinary::Ffmpeg).map_err(|error| anyhow!(error))?;
    let cache_root = waveform_cache_root(app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let _active_binary_task = active_binary_task;
        waveform::get_track_waveform_tile_with_binary(
            &ffmpeg_path,
            &cache_root,
            file_path,
            start,
            end,
            pixels_per_second,
            tile_start_px,
            tile_width,
        )
    })
    .await
    .map_err(|error| anyhow!("waveform tile task failed: {error}"))?
    .map_err(|error| anyhow!(error))
}

#[cfg(not(test))]
pub fn set_playback_continuation_mode(mode: PlaybackContinuationMode) -> Result<()> {
    runtime()?.set_continuation_mode(mode)
}

#[cfg(not(test))]
pub fn enter_spectrum_playback_scope() -> Result<u64> {
    runtime()?.enter_spectrum_playback_scope()
}

#[cfg(not(test))]
pub fn exit_spectrum_playback_scope(scope_id: u64) -> Result<()> {
    let runtime = runtime()?;
    if runtime.exit_spectrum_playback_scope(SpectrumPlaybackScope { id: scope_id })? {
        runtime.set_continuation_mode(PlaybackContinuationMode::Random)?;
    }
    Ok(())
}

#[cfg(not(test))]
fn runtime() -> Result<&'static Arc<PlayerRuntime>> {
    PLAYER_RUNTIME
        .get()
        .context("player runtime has not been initialized")
}

#[cfg(not(test))]
fn waveform_cache_root(app: &AppHandle) -> Result<std::path::PathBuf> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .context("failed to resolve app cache directory")?
        .join("waveforms");
    std::fs::create_dir_all(&cache_dir)
        .with_context(|| format!("failed to create waveform cache `{}`", cache_dir.display()))?;
    Ok(cache_dir)
}

#[cfg(not(test))]
impl PlayerRuntime {
    fn claim_playback_start_request(&self) -> PlaybackStartRequestHandle {
        self.start_requests.claim()
    }

    fn cancel_pending_playback_start_requests(&self) {
        self.start_requests.cancel_pending();
    }

    fn is_playback_start_request_current(&self, handle: &PlaybackStartRequestHandle) -> bool {
        self.start_requests.is_current(handle)
    }

    fn playback(&self) -> Result<Playback> {
        let mut playback = self
            .playback
            .lock()
            .map_err(|_| anyhow!("player runtime playback lock is poisoned"))?;

        if let Some(current) = playback.as_ref() {
            return Ok(current.clone());
        }

        let ffmpeg_path = ensure_managed_binary(&self.app, ManagedBinary::Ffmpeg)
            .map_err(|error| anyhow!(error))?;
        let created = Playback::builder(ffmpeg_path)
            .default_normalization(backend_playback_normalization())
            .build()
            .map_err(|error| anyhow!(error))?;
        *playback = Some(created.clone());
        Ok(created)
    }

    fn current_playback(&self) -> Result<Option<Playback>> {
        self.playback
            .lock()
            .map(|playback| playback.clone())
            .map_err(|_| anyhow!("player runtime playback lock is poisoned"))
    }

    fn replace_active_session(
        &self,
        playlist_name: String,
        generation: u64,
        tracks: SharedPlaybackTracks,
        strategy: SharedPlaybackStrategy,
        queue_mode: PlaybackQueueMode,
    ) -> Result<()> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| anyhow!("player runtime session lock is poisoned"))?;

        *session = Some(ActivePlaybackSession {
            playlist_name,
            generation,
            tracks,
            strategy,
            queue_mode,
        });
        drop(session);
        self.clear_active_request_track()?;
        self.clear_active_playback_range()?;
        Ok(())
    }

    fn set_active_request_track(&self, track: PlaybackTrack) -> Result<()> {
        let mut active_request_track = self
            .active_request_track
            .write()
            .map_err(|_| anyhow!("player runtime active request track lock is poisoned"))?;
        *active_request_track = Some(track);
        Ok(())
    }

    fn set_active_playback_range(&self, range: Option<ActivePlaybackRange>) -> Result<()> {
        let mut active_playback_range = self
            .active_playback_range
            .write()
            .map_err(|_| anyhow!("player runtime active playback range lock is poisoned"))?;
        *active_playback_range = range;
        Ok(())
    }

    fn set_spectrum_playback_loop_signal(
        &self,
        signal: Option<SpectrumPlaybackLoopSignal>,
    ) -> Result<()> {
        let mut current = self.spectrum_playback_loop_signal.write().map_err(|_| {
            anyhow!("player runtime spectrum playback loop signal lock is poisoned")
        })?;
        *current = signal;
        Ok(())
    }

    fn set_spectrum_playback_scope(&self, scope: Option<SpectrumPlaybackScope>) -> Result<()> {
        let mut current = self
            .spectrum_playback_scope
            .write()
            .map_err(|_| anyhow!("player runtime spectrum playback scope lock is poisoned"))?;
        *current = scope;
        Ok(())
    }

    fn enter_spectrum_playback_scope(&self) -> Result<u64> {
        let scope = SpectrumPlaybackScope {
            id: self
                .spectrum_playback_scope_generation
                .fetch_add(1, Ordering::SeqCst)
                + 1,
        };
        self.set_spectrum_playback_scope(Some(scope))?;
        self.clear_spectrum_playback_loop_signal()?;
        self.set_continuation_mode(PlaybackContinuationMode::RepeatCurrent)?;
        Ok(scope.id)
    }

    fn exit_spectrum_playback_scope(&self, scope: SpectrumPlaybackScope) -> Result<bool> {
        if should_commit_spectrum_playback_scope_exit(
            self.spectrum_playback_scope_snapshot()?,
            scope,
        ) {
            self.clear_spectrum_playback_scope()?;
            self.clear_spectrum_playback_loop_signal()?;
            return Ok(true);
        }
        Ok(false)
    }

    fn set_temporary_playback_pause(&self, value: bool) -> Result<()> {
        let mut temporary_playback_pause = self
            .temporary_playback_pause
            .write()
            .map_err(|_| anyhow!("player runtime temporary playback pause lock is poisoned"))?;
        *temporary_playback_pause = value;
        Ok(())
    }

    fn temporary_playback_pause(&self) -> Result<bool> {
        self.temporary_playback_pause
            .read()
            .map(|value| *value)
            .map_err(|_| anyhow!("player runtime temporary playback pause lock is poisoned"))
    }

    fn clear_active_request_track(&self) -> Result<()> {
        let mut active_request_track = self
            .active_request_track
            .write()
            .map_err(|_| anyhow!("player runtime active request track lock is poisoned"))?;
        *active_request_track = None;
        Ok(())
    }

    fn clear_active_playback_range(&self) -> Result<()> {
        self.set_active_playback_range(None)
    }

    fn clear_spectrum_playback_loop_signal(&self) -> Result<()> {
        self.set_spectrum_playback_loop_signal(None)
    }

    fn clear_spectrum_playback_scope(&self) -> Result<()> {
        self.set_spectrum_playback_scope(None)
    }

    fn spectrum_playback_scope_snapshot(&self) -> Result<Option<SpectrumPlaybackScope>> {
        self.spectrum_playback_scope
            .read()
            .map(|scope| *scope)
            .map_err(|_| anyhow!("player runtime spectrum playback scope lock is poisoned"))
    }

    fn is_spectrum_playback_scope_active(&self, scope: SpectrumPlaybackScope) -> Result<bool> {
        Ok(self.spectrum_playback_scope_snapshot()? == Some(scope))
    }

    fn active_request_track_for_status_path(
        &self,
        status_path: Option<&str>,
    ) -> Result<Option<PlaybackTrack>> {
        let active_request_track = self
            .active_request_track
            .read()
            .map_err(|_| anyhow!("player runtime active request track lock is poisoned"))?;
        let Some(track) = active_request_track.as_ref() else {
            return Ok(None);
        };
        let Some(status_path) = status_path else {
            return Ok(None);
        };

        Ok(resolve_playback_status_track_identity(
            Some(status_path),
            Some(track),
        ))
    }

    fn replace_session_tracks(
        &self,
        handle: &PlaybackSessionHandle,
        tracks: Vec<PlaybackTrack>,
    ) -> Result<bool> {
        if self.generation.load(Ordering::SeqCst) != handle.generation {
            return Ok(false);
        }
        let next_current_track = self.active_request_track_snapshot_for_session(handle)?;

        let session = self
            .session
            .lock()
            .map_err(|_| anyhow!("player runtime session lock is poisoned"))?;
        let Some(active) = session.as_ref() else {
            return Ok(false);
        };
        if active.generation != handle.generation || active.playlist_name != handle.playlist_name {
            return Ok(false);
        }

        let mut current_tracks = active
            .tracks
            .write()
            .map_err(|_| anyhow!("player runtime session tracks lock is poisoned"))?;
        if playback_tracks_match(&current_tracks, &tracks) {
            return Ok(true);
        }

        let previous_tracks = current_tracks.clone();
        {
            let mut strategy = active
                .strategy
                .lock()
                .map_err(|_| anyhow!("player runtime playback strategy lock is poisoned"))?;
            let _ = strategy.reconcile_current_track_identity(
                &previous_tracks,
                &tracks,
                next_current_track.as_ref(),
            );
        }
        *current_tracks = tracks;
        Ok(true)
    }

    fn replace_current_session_tracks(&self, tracks: Vec<PlaybackTrack>) -> Result<bool> {
        let session = self
            .session
            .lock()
            .map_err(|_| anyhow!("player runtime session lock is poisoned"))?;
        let Some(active) = session.as_ref() else {
            return Ok(false);
        };

        let mut current_tracks = active
            .tracks
            .write()
            .map_err(|_| anyhow!("player runtime session tracks lock is poisoned"))?;
        if playback_tracks_match(&current_tracks, &tracks) {
            return Ok(true);
        }

        *current_tracks = tracks;
        Ok(true)
    }

    fn current_session_tracks_snapshot(&self) -> Result<Vec<PlaybackTrack>> {
        let session = self
            .session
            .lock()
            .map_err(|_| anyhow!("player runtime session lock is poisoned"))?;
        let Some(active) = session.as_ref() else {
            return Ok(vec![]);
        };

        active
            .tracks
            .read()
            .map(|tracks| tracks.clone())
            .map_err(|_| anyhow!("player runtime session tracks lock is poisoned"))
    }

    fn resolve_spectrum_playback_start_plan(
        &self,
        scope: SpectrumPlaybackScope,
        track: PlaybackTrack,
        position_ms: Option<u32>,
        pause_after_start: bool,
    ) -> Result<SpectrumPlaybackStartPlan> {
        let initial_range = resolve_spectrum_music_playback_range(&track, position_ms)
            .ok_or_else(|| anyhow!("invalid spectrum playback range"))?;
        let session = self
            .session
            .lock()
            .map_err(|_| anyhow!("player runtime session lock is poisoned"))?;
        let Some(active) = session.as_ref() else {
            bail!("no active playback session to select spectrum music from");
        };
        if active.playlist_name != track.playlist_name {
            bail!(
                "cannot select spectrum music from playlist `{}` while `{}` is active",
                track.playlist_name,
                active.playlist_name
            );
        }

        Ok(SpectrumPlaybackStartPlan {
            session: PlaybackSession {
                playlist_name: active.playlist_name.clone(),
                tracks: Arc::clone(&active.tracks),
                strategy: Arc::clone(&active.strategy),
                queue_mode: active.queue_mode,
                initial_request: Some(InitialPlaybackRequest {
                    pause_after_start,
                    range: initial_range,
                    scope: Some(scope),
                    track: track.clone(),
                }),
            },
            track,
        })
    }

    fn update_current_session_track_identity(
        &self,
        update: &PlaybackTrackIdentityUpdate,
    ) -> Result<bool> {
        let reconciled = {
            let session = self
                .session
                .lock()
                .map_err(|_| anyhow!("player runtime session lock is poisoned"))?;
            let Some(active) = session.as_ref() else {
                return Ok(false);
            };

            let mut current_tracks = active
                .tracks
                .write()
                .map_err(|_| anyhow!("player runtime session tracks lock is poisoned"))?;
            let Some(next_tracks) = resolve_session_track_identity_update(&current_tracks, update)
            else {
                return Ok(false);
            };

            let previous_tracks = current_tracks.clone();
            let next_current_track = resolve_active_request_track_identity_update(
                self.active_request_track_snapshot()?.as_ref(),
                update,
            );
            let active_playback_range = self.active_playback_range_snapshot()?;
            let next_active_playback_range =
                resolve_active_playback_range_identity_update(active_playback_range, update);
            let reconciled = {
                let mut strategy = active
                    .strategy
                    .lock()
                    .map_err(|_| anyhow!("player runtime playback strategy lock is poisoned"))?;
                strategy.reconcile_current_track_identity(
                    &previous_tracks,
                    &next_tracks,
                    next_current_track.as_ref(),
                )
            };
            *current_tracks = next_tracks;
            if let Some(track) = reconciled.as_ref() {
                self.set_active_request_track(track.clone())?;
            }
            if active_playback_range.is_some() {
                self.set_active_playback_range(next_active_playback_range)?;
            }
            if next_current_track.is_some() {
                self.clear_spectrum_playback_loop_signal()?;
            }
            reconciled
        };

        if let Some(track) = reconciled {
            NowPlayingTrackChangedEvent::from(track.to_payload()).emit(&self.app)?;
        }

        Ok(true)
    }

    fn update_current_session_track_liked(
        &self,
        update: &PlaybackTrackLikedUpdate,
    ) -> Result<bool> {
        let active_update = {
            let session = self
                .session
                .lock()
                .map_err(|_| anyhow!("player runtime session lock is poisoned"))?;
            let Some(active) = session.as_ref() else {
                return Ok(false);
            };

            let mut current_tracks = active
                .tracks
                .write()
                .map_err(|_| anyhow!("player runtime session tracks lock is poisoned"))?;
            let Some(next_tracks) = resolve_session_track_liked_update(&current_tracks, update)
            else {
                return Ok(false);
            };

            let next_active_track = resolve_active_request_track_liked_update(
                self.active_request_track_snapshot()?.as_ref(),
                update,
            );
            *current_tracks = next_tracks;
            if let Some(track) = next_active_track.as_ref() {
                self.set_active_request_track(track.clone())?;
            }
            next_active_track
        };

        if let Some(track) = active_update {
            NowPlayingTrackChangedEvent::from(track.to_payload()).emit(&self.app)?;
        }

        Ok(true)
    }

    fn is_session_current(&self, handle: &PlaybackSessionHandle) -> Result<bool> {
        if self.generation.load(Ordering::SeqCst) != handle.generation {
            return Ok(false);
        }

        let session = self
            .session
            .lock()
            .map_err(|_| anyhow!("player runtime session lock is poisoned"))?;
        Ok(session.as_ref().is_some_and(|active| {
            active.generation == handle.generation && active.playlist_name == handle.playlist_name
        }))
    }

    fn clear_active_session(&self) -> Result<()> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| anyhow!("player runtime session lock is poisoned"))?;
        *session = None;
        self.clear_active_request_track()?;
        self.clear_active_playback_range()?;
        self.clear_spectrum_playback_scope()?;
        self.clear_spectrum_playback_loop_signal()?;
        Ok(())
    }

    fn set_continuation_mode(&self, mode: PlaybackContinuationMode) -> Result<()> {
        let mut current = self
            .continuation_mode
            .write()
            .map_err(|_| anyhow!("player runtime continuation mode lock is poisoned"))?;
        *current = mode;
        Ok(())
    }

    fn continuation_mode(&self) -> Result<PlaybackContinuationMode> {
        self.continuation_mode
            .read()
            .map(|mode| *mode)
            .map_err(|_| anyhow!("player runtime continuation mode lock is poisoned"))
    }

    fn active_request_track_snapshot(&self) -> Result<Option<PlaybackTrack>> {
        self.active_request_track
            .read()
            .map(|track| track.clone())
            .map_err(|_| anyhow!("player runtime active request track lock is poisoned"))
    }

    fn active_request_track_snapshot_for_session(
        &self,
        handle: &PlaybackSessionHandle,
    ) -> Result<Option<PlaybackTrack>> {
        if !self.is_session_current(handle)? {
            return Ok(None);
        }

        let track = self.active_request_track_snapshot()?;
        Ok(track.filter(|track| track.playlist_name == handle.playlist_name))
    }

    fn active_playback_range_snapshot(&self) -> Result<Option<ActivePlaybackRange>> {
        self.active_playback_range
            .read()
            .map(|range| *range)
            .map_err(|_| anyhow!("player runtime active playback range lock is poisoned"))
    }

    fn spectrum_playback_loop_signal_snapshot(&self) -> Result<Option<SpectrumPlaybackLoopSignal>> {
        self.spectrum_playback_loop_signal
            .read()
            .map(|signal| signal.clone())
            .map_err(|_| anyhow!("player runtime spectrum playback loop signal lock is poisoned"))
    }
}

#[cfg(not(test))]
struct PlaybackSession {
    playlist_name: String,
    tracks: SharedPlaybackTracks,
    strategy: SharedPlaybackStrategy,
    queue_mode: PlaybackQueueMode,
    initial_request: Option<InitialPlaybackRequest>,
}

#[cfg(not(test))]
#[derive(Clone)]
struct InitialPlaybackRequest {
    pause_after_start: bool,
    range: ActivePlaybackRange,
    scope: Option<SpectrumPlaybackScope>,
    track: PlaybackTrack,
}

#[cfg(not(test))]
impl PlaybackSession {
    fn tracks_snapshot(&self) -> Result<Vec<PlaybackTrack>> {
        self.tracks
            .read()
            .map(|tracks| tracks.clone())
            .map_err(|_| anyhow!("player runtime session tracks lock is poisoned"))
    }
}

#[cfg(not(test))]
async fn run_playback_session(
    runtime: Arc<PlayerRuntime>,
    playback: Playback,
    generation: u64,
    mut session: PlaybackSession,
) -> Result<()> {
    let trace_start = Instant::now();
    loop {
        if runtime.generation.load(Ordering::SeqCst) != generation {
            emit_player_trace(
                "player-run-session-generation-ended",
                PlayerTrace::new(&runtime.app)
                    .playlist_name(&session.playlist_name)
                    .elapsed(trace_start),
            );
            return Ok(());
        }

        let mode = runtime.continuation_mode()?;
        let tracks = session.tracks_snapshot()?;
        emit_player_trace(
            "player-run-session-tracks-ready",
            PlayerTrace::new(&runtime.app)
                .playlist_name(&session.playlist_name)
                .elapsed(trace_start)
                .queue_count(tracks.len()),
        );
        let initial_request = session.initial_request.take();
        if !should_start_spectrum_playback_session(
            runtime.spectrum_playback_scope_snapshot()?,
            initial_request.as_ref().and_then(|request| request.scope),
        ) {
            emit_player_trace(
                "player-run-session-scope-ended",
                PlayerTrace::new(&runtime.app)
                    .playlist_name(&session.playlist_name)
                    .elapsed(trace_start),
            );
            return Ok(());
        }
        let track = match initial_request.as_ref() {
            Some(request) => Some(request.track.clone()),
            None => {
                resolve_next_session_track(
                    &runtime,
                    generation,
                    &session,
                    mode,
                    &tracks,
                    trace_start,
                )
                .await?
            }
        };
        let Some(track) = track else {
            if runtime.generation.load(Ordering::SeqCst) != generation {
                emit_player_trace(
                    "player-run-session-generation-ended-before-track",
                    PlayerTrace::new(&runtime.app)
                        .playlist_name(&session.playlist_name)
                        .elapsed(trace_start),
                );
                return Ok(());
            }
            emit_player_trace(
                "player-run-session-no-track",
                PlayerTrace::new(&runtime.app)
                    .playlist_name(&session.playlist_name)
                    .elapsed(trace_start)
                    .queue_count(tracks.len()),
            );
            return Ok(());
        };
        emit_player_trace(
            "player-run-track-selected",
            PlayerTrace::new(&runtime.app)
                .playlist_name(&session.playlist_name)
                .track(&track)
                .elapsed(trace_start)
                .queue_count(tracks.len())
                .status(if initial_request.is_some() {
                    "initial"
                } else {
                    "strategy"
                }),
        );
        runtime.set_active_request_track(track.clone())?;
        NowPlayingTrackChangedEvent::from(track.to_payload()).emit(&runtime.app)?;
        emit_player_trace(
            "player-run-now-playing-emitted",
            PlayerTrace::new(&runtime.app)
                .playlist_name(&session.playlist_name)
                .track(&track)
                .elapsed(trace_start),
        );
        let repeated_loop_signal = resolve_spectrum_loop_playback_range(
            runtime.spectrum_playback_scope_snapshot()?,
            &track,
            runtime.spectrum_playback_loop_signal_snapshot()?,
        );
        let active_range = initial_request
            .as_ref()
            .map(|request| request.range)
            .or(repeated_loop_signal)
            .unwrap_or(ActivePlaybackRange {
                start_ms: track.start_ms,
                end_ms: track.end_ms,
            });
        let request = playback_request_for_path_position(
            &track.file_path,
            resolve_playback_request_position(active_range),
        );
        emit_player_trace(
            "player-run-play-request-start",
            PlayerTrace::new(&runtime.app)
                .playlist_name(&session.playlist_name)
                .track(&track)
                .elapsed(trace_start),
        );
        match playback.play_request(request).await {
            Ok(_) => {
                emit_player_trace(
                    "player-run-play-request-ok",
                    PlayerTrace::new(&runtime.app)
                        .playlist_name(&session.playlist_name)
                        .track(&track)
                        .elapsed(trace_start),
                );
            }
            Err(error) => {
                emit_player_trace(
                    "player-run-play-request-error",
                    PlayerTrace::new(&runtime.app)
                        .playlist_name(&session.playlist_name)
                        .track(&track)
                        .elapsed(trace_start)
                        .error(&error),
                );
                return Err(anyhow!("failed to play `{}`: {error}", track.music_name));
            }
        }
        if runtime.generation.load(Ordering::SeqCst) != generation {
            emit_player_trace(
                "player-run-session-generation-ended-after-play",
                PlayerTrace::new(&runtime.app)
                    .playlist_name(&session.playlist_name)
                    .track(&track)
                    .elapsed(trace_start),
            );
            return Ok(());
        }
        if initial_request.is_some() {
            session
                .strategy
                .lock()
                .map_err(|_| anyhow!("player runtime playback strategy lock is poisoned"))?
                .commit_current_track(&track);
        }
        runtime.set_active_playback_range(Some(active_range))?;
        emit_player_trace(
            "player-run-active-range-set",
            PlayerTrace::new(&runtime.app)
                .playlist_name(&session.playlist_name)
                .track(&track)
                .elapsed(trace_start),
        );
        if initial_request
            .as_ref()
            .is_some_and(|request| request.pause_after_start)
        {
            playback.pause().await.map_err(|error| {
                anyhow!(
                    "failed to pause `{}` after start: {error}",
                    track.music_name
                )
            })?;
        }
        wait_until_track_finishes(&runtime, &playback, generation, &track.file_path).await?;
    }
}

#[cfg(not(test))]
async fn resolve_next_session_track(
    runtime: &PlayerRuntime,
    generation: u64,
    session: &PlaybackSession,
    mode: PlaybackContinuationMode,
    tracks: &[PlaybackTrack],
    trace_start: Instant,
) -> Result<Option<PlaybackTrack>> {
    if !should_wait_for_ordered_queue_supply(mode, session.queue_mode) {
        return session
            .strategy
            .lock()
            .map_err(|_| anyhow!("player runtime playback strategy lock is poisoned"))
            .map(|mut strategy| {
                strategy.next_track_with_queue_mode(mode, session.queue_mode, tracks)
            });
    }

    let mut waiting_trace_emitted = false;
    loop {
        if runtime.generation.load(Ordering::SeqCst) != generation {
            return Ok(None);
        }

        let tracks = session.tracks_snapshot()?;
        let track = session
            .strategy
            .lock()
            .map_err(|_| anyhow!("player runtime playback strategy lock is poisoned"))?
            .next_track_with_queue_mode(mode, session.queue_mode, &tracks);
        if track.is_some() {
            return Ok(track);
        }

        if !waiting_trace_emitted {
            emit_player_trace(
                "player-run-session-waiting-for-ordered-queue",
                PlayerTrace::new(&runtime.app)
                    .playlist_name(&session.playlist_name)
                    .elapsed(trace_start)
                    .queue_count(tracks.len()),
            );
            waiting_trace_emitted = true;
        }
        tokio::time::sleep(Duration::from_millis(PLAYBACK_SESSION_QUEUE_WAIT_POLL_MS)).await;
    }
}

pub(crate) fn should_wait_for_ordered_queue_supply(
    mode: PlaybackContinuationMode,
    queue_mode: PlaybackQueueMode,
) -> bool {
    matches!(
        (mode, queue_mode),
        (PlaybackContinuationMode::Random, PlaybackQueueMode::Ordered)
    )
}

pub(crate) fn backend_playback_normalization() -> PlaybackNormalization {
    PlaybackNormalization {
        target_lufs: BACKEND_PLAYBACK_TARGET_LUFS,
        integrated_lufs: None,
        true_peak_dbtp: None,
    }
}

pub(crate) fn playback_tracks_match(left: &[PlaybackTrack], right: &[PlaybackTrack]) -> bool {
    left.len() == right.len()
        && left.iter().zip(right.iter()).all(|(left, right)| {
            left.playlist_name == right.playlist_name
                && left.music_name == right.music_name
                && left.music_url == right.music_url
                && left.file_path == right.file_path
                && left.start_ms == right.start_ms
                && left.end_ms == right.end_ms
                && left.liked == right.liked
        })
}

pub(crate) fn are_playback_tracks_equal(left: &PlaybackTrack, right: &PlaybackTrack) -> bool {
    left.playlist_name == right.playlist_name
        && left.music_url == right.music_url
        && left.file_path == right.file_path
        && left.start_ms == right.start_ms
        && left.end_ms == right.end_ms
}

pub(crate) fn resolve_session_track_identity_update(
    tracks: &[PlaybackTrack],
    update: &PlaybackTrackIdentityUpdate,
) -> Option<Vec<PlaybackTrack>> {
    let mut changed = false;
    let next_tracks = tracks
        .iter()
        .map(|track| {
            if track.music_url != update.music_url
                || track.start_ms != update.start_ms
                || track.end_ms != update.end_ms
            {
                return track.clone();
            }

            let mut next = track.clone();
            next.music_name = update.music_name.clone();
            next.start_ms = update.next_start_ms;
            next.end_ms = update.next_end_ms;
            sync_playback_track_source_music(&mut next);
            changed = changed
                || !playback_tracks_match(std::slice::from_ref(track), std::slice::from_ref(&next));
            next
        })
        .collect::<Vec<_>>();

    changed.then_some(next_tracks)
}

pub(crate) fn resolve_playback_status_track_identity(
    status_path: Option<&str>,
    active_request_track: Option<&PlaybackTrack>,
) -> Option<PlaybackTrack> {
    let track = active_request_track?;
    let status_path = status_path?;

    (std::path::Path::new(status_path) == track.file_path).then(|| track.clone())
}

pub(crate) fn resolve_active_request_track_identity_update(
    active_request_track: Option<&PlaybackTrack>,
    update: &PlaybackTrackIdentityUpdate,
) -> Option<PlaybackTrack> {
    let track = active_request_track?;

    if track.music_url != update.music_url
        || track.start_ms != update.start_ms
        || track.end_ms != update.end_ms
    {
        return None;
    }

    let mut next = track.clone();
    next.music_name = update.music_name.clone();
    next.start_ms = update.next_start_ms;
    next.end_ms = update.next_end_ms;
    sync_playback_track_source_music(&mut next);
    Some(next)
}

pub(crate) fn resolve_session_track_liked_update(
    tracks: &[PlaybackTrack],
    update: &PlaybackTrackLikedUpdate,
) -> Option<Vec<PlaybackTrack>> {
    let mut changed = false;
    let next_tracks = tracks
        .iter()
        .map(|track| {
            if track.canonical_music_id != update.canonical_music_id {
                return track.clone();
            }

            let mut next = track.clone();
            next.liked = update.liked;
            sync_playback_track_source_music(&mut next);
            changed = changed || track.liked != next.liked;
            next
        })
        .collect::<Vec<_>>();

    changed.then_some(next_tracks)
}

pub(crate) fn resolve_active_request_track_liked_update(
    active_request_track: Option<&PlaybackTrack>,
    update: &PlaybackTrackLikedUpdate,
) -> Option<PlaybackTrack> {
    let track = active_request_track?;

    if track.canonical_music_id != update.canonical_music_id {
        return None;
    }

    let mut next = track.clone();
    next.liked = update.liked;
    sync_playback_track_source_music(&mut next);
    Some(next)
}

fn sync_playback_track_source_music(track: &mut PlaybackTrack) {
    let Some(music) = track.source_music.as_mut() else {
        return;
    };

    music.alias = track.music_name.clone();
    music.path = Some(track.file_path.to_string_lossy().to_string());
    music.start_ms = track.start_ms;
    music.end_ms = track.end_ms;
    music.liked = track.liked;
}

pub(crate) fn resolve_active_playback_range_identity_update(
    active_range: Option<ActivePlaybackRange>,
    update: &PlaybackTrackIdentityUpdate,
) -> Option<ActivePlaybackRange> {
    let range = active_range?;

    if range.start_ms == update.start_ms && range.end_ms == update.end_ms {
        return Some(ActivePlaybackRange {
            start_ms: update.next_start_ms,
            end_ms: update.next_end_ms,
        });
    }

    if range.start_ms < update.next_start_ms || range.start_ms > update.next_end_ms {
        return None;
    }

    Some(ActivePlaybackRange {
        start_ms: range.start_ms,
        end_ms: update.next_end_ms,
    })
}

#[cfg(not(test))]
fn playback_request_for_path_position(path: &Path, position_ms: u32) -> PlaybackRequest {
    let request = PlaybackRequest::new(path.to_path_buf());

    if position_ms > 0 {
        return request.with_time_range(PlaybackTimeRange {
            start_ms: position_ms,
            duration_ms: None,
        });
    }

    request
}

pub(crate) fn resolve_playback_seek_range(
    position_ms: u32,
    end_ms: u32,
) -> Option<ActivePlaybackRange> {
    if end_ms == 0 {
        return None;
    }

    let start_ms = position_ms.min(end_ms.saturating_sub(1));

    Some(ActivePlaybackRange { start_ms, end_ms })
}

pub(crate) fn resolve_playback_request_position(range: ActivePlaybackRange) -> u32 {
    range.start_ms
}

pub(crate) fn resolve_playback_absolute_position_ms(
    status: &ffplayr::AudioStatus,
    active_range: Option<ActivePlaybackRange>,
) -> u32 {
    active_range
        .map(|range| range.start_ms)
        .unwrap_or(0)
        .saturating_add(status.position_ms)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlaybackRangeCompletion {
    Continue,
    Finish,
    Repeat(ActivePlaybackRange),
}

pub(crate) fn resolve_playback_range_completion(
    current_position_ms: u32,
    active_range: ActivePlaybackRange,
    spectrum_loop_range: Option<ActivePlaybackRange>,
) -> PlaybackRangeCompletion {
    if let Some(loop_range) = spectrum_loop_range {
        if current_position_ms >= loop_range.end_ms {
            return PlaybackRangeCompletion::Repeat(loop_range);
        }
    }

    if current_position_ms >= active_range.end_ms {
        return PlaybackRangeCompletion::Finish;
    }

    PlaybackRangeCompletion::Continue
}

pub(crate) fn resolve_spectrum_loop_playback_range(
    active_scope: Option<SpectrumPlaybackScope>,
    track: &PlaybackTrack,
    signal: Option<SpectrumPlaybackLoopSignal>,
) -> Option<ActivePlaybackRange> {
    let signal = signal?;
    if should_accept_spectrum_playback_signal(active_scope, signal.scope) {
        return resolve_repeated_playback_range_override(track, signal);
    }

    None
}

pub(crate) fn should_accept_spectrum_playback_signal(
    active_scope: Option<SpectrumPlaybackScope>,
    signal_scope: SpectrumPlaybackScope,
) -> bool {
    active_scope == Some(signal_scope)
}

pub(crate) fn should_start_spectrum_playback_session(
    active_scope: Option<SpectrumPlaybackScope>,
    request_scope: Option<SpectrumPlaybackScope>,
) -> bool {
    match request_scope {
        Some(scope) => active_scope == Some(scope),
        None => true,
    }
}

pub(crate) fn should_commit_spectrum_playback_scope_exit(
    active_scope: Option<SpectrumPlaybackScope>,
    requested_scope: SpectrumPlaybackScope,
) -> bool {
    active_scope == Some(requested_scope)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SpectrumPlaybackLoopSignal {
    pub(crate) scope: SpectrumPlaybackScope,
    pub(crate) file_path: std::path::PathBuf,
    pub(crate) music_url: String,
    pub(crate) playlist_name: String,
    pub(crate) track_start_ms: u32,
    pub(crate) track_end_ms: u32,
    pub(crate) range: ActivePlaybackRange,
}

pub(crate) fn resolve_repeated_playback_range_override(
    track: &PlaybackTrack,
    signal: SpectrumPlaybackLoopSignal,
) -> Option<ActivePlaybackRange> {
    if track.playlist_name != signal.playlist_name
        || track.music_url != signal.music_url
        || track.file_path != signal.file_path
        || track.start_ms != signal.track_start_ms
        || track.end_ms != signal.track_end_ms
    {
        return None;
    }

    if signal.range.start_ms >= signal.range.end_ms {
        return None;
    }

    Some(signal.range)
}

pub(crate) fn resolve_spectrum_playback_loop_signal(
    scope: SpectrumPlaybackScope,
    track: &PlaybackTrack,
    start_ms: u32,
    end_ms: u32,
) -> Option<SpectrumPlaybackLoopSignal> {
    if start_ms >= end_ms {
        return None;
    }

    Some(SpectrumPlaybackLoopSignal {
        scope,
        file_path: track.file_path.clone(),
        music_url: track.music_url.clone(),
        playlist_name: track.playlist_name.clone(),
        track_start_ms: track.start_ms,
        track_end_ms: track.end_ms,
        range: ActivePlaybackRange { start_ms, end_ms },
    })
}

pub(crate) fn resolve_spectrum_loop_signal_seek_position(
    current_position_ms: u32,
    signal_range: ActivePlaybackRange,
) -> Option<u32> {
    if current_position_ms < signal_range.start_ms {
        return Some(signal_range.start_ms);
    }

    if current_position_ms >= signal_range.end_ms {
        return Some(
            signal_range
                .end_ms
                .saturating_sub(1)
                .max(signal_range.start_ms),
        );
    }

    None
}

pub(crate) fn resolve_spectrum_loop_signal_active_range(
    current_range: Option<ActivePlaybackRange>,
    signal_range: ActivePlaybackRange,
) -> ActivePlaybackRange {
    ActivePlaybackRange {
        start_ms: current_range
            .map(|range| range.start_ms)
            .unwrap_or(signal_range.start_ms),
        end_ms: signal_range.end_ms,
    }
}

pub(crate) fn resolve_spectrum_music_playback_range(
    track: &PlaybackTrack,
    position_ms: Option<u32>,
) -> Option<ActivePlaybackRange> {
    if track.start_ms >= track.end_ms {
        return None;
    }

    let position_ms = position_ms.unwrap_or(track.start_ms);
    let start_ms = position_ms.clamp(track.start_ms, track.end_ms.saturating_sub(1));

    Some(ActivePlaybackRange {
        start_ms,
        end_ms: track.end_ms,
    })
}

pub(crate) fn resolve_playback_seek_pause_after_request(
    playing: bool,
    paused: bool,
    temporary_playback_pause: bool,
) -> bool {
    !temporary_playback_pause && (!playing || paused)
}

pub(crate) fn should_resume_playback_seek_cancel(
    status_matches_track: bool,
    playing: bool,
    paused: bool,
    temporary_playback_pause: bool,
) -> bool {
    status_matches_track && temporary_playback_pause && playing && paused
}

#[cfg(not(test))]
async fn wait_until_track_finishes(
    runtime: &PlayerRuntime,
    playback: &Playback,
    generation: u64,
    current_path: &Path,
) -> Result<()> {
    loop {
        if runtime.generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }

        let status = playback
            .status()
            .await
            .map_err(|error| anyhow!("failed to read playback status: {error}"))?;
        let Some(active_path) = status.path.as_deref() else {
            return Ok(());
        };

        if Path::new(active_path) != current_path {
            return Ok(());
        }

        let active_track = runtime.active_request_track_snapshot()?;
        let active_range = runtime.active_playback_range_snapshot()?;
        let active_scope = runtime.spectrum_playback_scope_snapshot()?;
        let loop_signal = runtime.spectrum_playback_loop_signal_snapshot()?;
        let spectrum_loop_range = active_track.as_ref().and_then(|track| {
            resolve_spectrum_loop_playback_range(active_scope, track, loop_signal)
        });

        if let Some(active_range) = active_range {
            let current_position_ms =
                resolve_playback_absolute_position_ms(&status, Some(active_range));

            match resolve_playback_range_completion(
                current_position_ms,
                active_range,
                spectrum_loop_range,
            ) {
                PlaybackRangeCompletion::Continue => {}
                PlaybackRangeCompletion::Finish => return Ok(()),
                PlaybackRangeCompletion::Repeat(loop_range) => {
                    let request =
                        playback_request_for_path_position(current_path, loop_range.start_ms);
                    playback
                        .play_request(request)
                        .await
                        .map_err(|error| anyhow!("failed to repeat spectrum loop: {error}"))?;
                    runtime.set_active_playback_range(Some(loop_range))?;
                    continue;
                }
            }
        }

        let poll_ms = if spectrum_loop_range.is_some() {
            SPECTRUM_LOOP_SIGNAL_STATUS_POLL_MS
        } else {
            PLAYBACK_SESSION_STATUS_POLL_MS
        };
        tokio::time::sleep(Duration::from_millis(poll_ms)).await;
    }
}
