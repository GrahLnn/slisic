#[cfg(not(test))]
use super::event::{NowPlayingTrackChangedEvent, PlaybackTraceEvent};
use super::model::PlaybackTrack;
#[cfg(not(test))]
use super::model::{PlaybackContinuationMode, PlaybackStatusPayload};
#[cfg(not(test))]
use super::strategy::PlaybackStrategySet;
#[cfg(not(test))]
use super::waveform::{self, TrackWaveform, TrackWaveformSummary, TrackWaveformTile};
#[cfg(not(test))]
use crate::utils::binaries::{ManagedBinary, ensure_managed_binary};
#[cfg(not(test))]
use anyhow::{Context, Result, anyhow, bail};
#[cfg(not(test))]
use ffplayr::{Playback, PlaybackRequest, PlaybackTimeRange};
#[cfg(not(test))]
use std::path::Path;
#[cfg(not(test))]
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
#[cfg(not(test))]
use std::sync::{Arc, Mutex, OnceLock, RwLock};
#[cfg(not(test))]
use std::time::Duration;
#[cfg(not(test))]
use tauri::{AppHandle, Manager};
#[cfg(not(test))]
use tauri_specta::Event;

#[cfg(not(test))]
static PLAYER_RUNTIME: OnceLock<Arc<PlayerRuntime>> = OnceLock::new();

#[cfg(not(test))]
pub struct PlayerRuntime {
    app: AppHandle,
    playback: Mutex<Option<Playback>>,
    session: Mutex<Option<ActivePlaybackSession>>,
    active_request_track: RwLock<Option<PlaybackTrack>>,
    continuation_mode: RwLock<PlaybackContinuationMode>,
    generation: AtomicU64,
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

#[cfg(not(test))]
pub fn initialize_runtime(app: AppHandle) {
    let _ = PLAYER_RUNTIME.get_or_init(|| {
        Arc::new(PlayerRuntime {
            app,
            playback: Mutex::new(None),
            session: Mutex::new(None),
            active_request_track: RwLock::new(None),
            continuation_mode: RwLock::new(PlaybackContinuationMode::Random),
            generation: AtomicU64::new(0),
            active_binary_tasks: AtomicUsize::new(0),
        })
    });
}

#[cfg(not(test))]
pub(crate) fn has_active_player_binary_tasks() -> bool {
    let Some(runtime) = PLAYER_RUNTIME.get() else {
        return false;
    };

    runtime.active_binary_tasks.load(Ordering::SeqCst) > 0
}

#[cfg(not(test))]
pub async fn play_tracks(
    playlist_name: String,
    tracks: Vec<PlaybackTrack>,
) -> Result<PlaybackSessionHandle> {
    if tracks.is_empty() {
        bail!("playback session `{playlist_name}` does not contain any playable tracks");
    }

    let runtime = runtime()?;
    let active_binary_task = ActiveBinaryTaskGuard::new(Arc::clone(runtime));
    let playback = runtime.playback()?;
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;

    if let Err(error) = playback.stop().await {
        eprintln!("[player] failed to stop previous playback before restart: {error}");
    }

    let shared_tracks = Arc::new(RwLock::new(tracks));
    let shared_strategy = Arc::new(Mutex::new(PlaybackStrategySet::new()));
    runtime.replace_active_session(
        playlist_name.clone(),
        generation,
        Arc::clone(&shared_tracks),
        Arc::clone(&shared_strategy),
    )?;

    let session = PlaybackSession {
        tracks: shared_tracks,
        strategy: shared_strategy,
    };
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
pub(crate) fn update_session_tracks(
    handle: &PlaybackSessionHandle,
    tracks: Vec<PlaybackTrack>,
) -> Result<bool> {
    if tracks.is_empty() {
        return Ok(is_session_current(handle)?);
    }

    runtime()?.replace_session_tracks(handle, tracks)
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

#[cfg(not(test))]
pub(crate) fn is_session_current(handle: &PlaybackSessionHandle) -> Result<bool> {
    runtime()?.is_session_current(handle)
}

#[cfg(not(test))]
pub async fn stop_playback() -> Result<bool> {
    let runtime = runtime()?;
    runtime.generation.fetch_add(1, Ordering::SeqCst);
    runtime.clear_active_session()?;
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
    let Some(playback) = runtime()?.current_playback()? else {
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
    let Some(playback) = runtime()?.current_playback()? else {
        return Ok(false);
    };

    playback
        .resume()
        .await
        .map_err(|error| anyhow!("failed to resume playback: {error}"))?;

    Ok(true)
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

    Ok(Some(PlaybackStatusPayload {
        path: status.path,
        playing: status.playing,
        paused: status.paused,
        position_ms: status.position_ms,
        duration_ms: status.duration_ms,
        playlist_name: active_request_track
            .as_ref()
            .map(|track| track.playlist_name.clone()),
        music_url: active_request_track
            .as_ref()
            .map(|track| track.music_url.clone()),
        playback_start_ms: active_request_track.as_ref().map(|track| track.start_ms),
        playback_end_ms: active_request_track.as_ref().map(|track| track.end_ms),
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
        let created = Playback::new(ffmpeg_path).map_err(|error| anyhow!(error))?;
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
        });
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

    fn clear_active_request_track(&self) -> Result<()> {
        let mut active_request_track = self
            .active_request_track
            .write()
            .map_err(|_| anyhow!("player runtime active request track lock is poisoned"))?;
        *active_request_track = None;
        Ok(())
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

    fn emit_playback_trace(&self, event: PlaybackTraceEvent) {
        let _ = event.emit(&self.app);
    }

    fn replace_session_tracks(
        &self,
        handle: &PlaybackSessionHandle,
        tracks: Vec<PlaybackTrack>,
    ) -> Result<bool> {
        if self.generation.load(Ordering::SeqCst) != handle.generation {
            return Ok(false);
        }

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
            let _ = strategy.reconcile_current_track_identity(&previous_tracks, &tracks, None);
        }
        *current_tracks = tracks;
        Ok(true)
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
            reconciled
        };

        if let Some(track) = reconciled {
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
        Ok(())
    }

    fn set_continuation_mode(&self, mode: PlaybackContinuationMode) -> Result<()> {
        let mut current = self
            .continuation_mode
            .write()
            .map_err(|_| anyhow!("player runtime continuation mode lock is poisoned"))?;
        *current = mode;
        self.emit_playback_trace(PlaybackTraceEvent {
            mode: Some(mode),
            ..PlaybackTraceEvent::new("player-continuation-mode-set")
        });
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
}

#[cfg(not(test))]
struct PlaybackSession {
    tracks: SharedPlaybackTracks,
    strategy: SharedPlaybackStrategy,
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
    session: PlaybackSession,
) -> Result<()> {
    loop {
        if runtime.generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }

        let mode = runtime.continuation_mode()?;
        let tracks = session.tracks_snapshot()?;
        let Some(track) = session
            .strategy
            .lock()
            .map_err(|_| anyhow!("player runtime playback strategy lock is poisoned"))?
            .next_track(mode, &tracks)
        else {
            return Ok(());
        };

        runtime.emit_playback_trace(PlaybackTraceEvent {
            generation: Some(generation),
            mode: Some(mode),
            path: Some(track.file_path.to_string_lossy().to_string()),
            playlist_name: Some(track.playlist_name.clone()),
            music_url: Some(track.music_url.clone()),
            start_ms: Some(track.start_ms),
            end_ms: Some(track.end_ms),
            ..PlaybackTraceEvent::new("player-session-track-selected")
        });
        NowPlayingTrackChangedEvent::from(track.to_payload()).emit(&runtime.app)?;
        let request = playback_request_for_track(&track)?;
        playback
            .play_request(request)
            .await
            .map_err(|error| anyhow!("failed to play `{}`: {error}", track.music_name))?;
        runtime.set_active_request_track(track.clone())?;
        wait_until_track_finishes(&runtime, &playback, generation, &track.file_path).await?;
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
        })
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
    Some(next)
}

#[cfg(not(test))]
fn playback_request_for_track(track: &PlaybackTrack) -> Result<PlaybackRequest> {
    let request = PlaybackRequest::new(track.file_path.clone());

    if track.end_ms > track.start_ms {
        return Ok(request.with_time_range(PlaybackTimeRange {
            start_ms: track.start_ms,
            duration_ms: track.end_ms.checked_sub(track.start_ms),
        }));
    }

    if track.start_ms > 0 {
        return Ok(request.with_time_range(PlaybackTimeRange {
            start_ms: track.start_ms,
            duration_ms: None,
        }));
    }

    Ok(request)
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
            runtime.emit_playback_trace(PlaybackTraceEvent {
                generation: Some(generation),
                path: Some(current_path.to_string_lossy().to_string()),
                reason: Some("generation-changed".to_string()),
                ..PlaybackTraceEvent::new("player-track-finish-wait-ended")
            });
            return Ok(());
        }

        let status = playback
            .status()
            .await
            .map_err(|error| anyhow!("failed to read playback status: {error}"))?;
        let Some(active_path) = status.path else {
            runtime.emit_playback_trace(PlaybackTraceEvent {
                generation: Some(generation),
                path: Some(current_path.to_string_lossy().to_string()),
                status_path: None,
                position_ms: Some(status.position_ms),
                duration_ms: status.duration_ms,
                reason: Some("status-path-empty".to_string()),
                ..PlaybackTraceEvent::new("player-track-finish-wait-ended")
            });
            return Ok(());
        };

        if Path::new(&active_path) != current_path {
            runtime.emit_playback_trace(PlaybackTraceEvent {
                generation: Some(generation),
                path: Some(current_path.to_string_lossy().to_string()),
                status_path: Some(active_path),
                position_ms: Some(status.position_ms),
                duration_ms: status.duration_ms,
                reason: Some("status-path-changed".to_string()),
                ..PlaybackTraceEvent::new("player-track-finish-wait-ended")
            });
            return Ok(());
        }

        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
