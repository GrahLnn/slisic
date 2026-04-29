#[cfg(not(test))]
use super::event::NowPlayingTrackChangedEvent;
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
use std::sync::atomic::{AtomicU64, Ordering};
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
    continuation_mode: RwLock<PlaybackContinuationMode>,
    generation: AtomicU64,
}

#[cfg(not(test))]
type SharedPlaybackTracks = Arc<RwLock<Vec<PlaybackTrack>>>;

#[cfg(not(test))]
struct ActivePlaybackSession {
    playlist_name: String,
    generation: u64,
    tracks: SharedPlaybackTracks,
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
            continuation_mode: RwLock::new(PlaybackContinuationMode::Random),
            generation: AtomicU64::new(0),
        })
    });
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
    let playback = runtime.playback()?;
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;

    if let Err(error) = playback.stop().await {
        eprintln!("[player] failed to stop previous playback before restart: {error}");
    }

    let shared_tracks = Arc::new(RwLock::new(tracks));
    runtime.replace_active_session(
        playlist_name.clone(),
        generation,
        Arc::clone(&shared_tracks),
    )?;

    let session = PlaybackSession {
        tracks: shared_tracks,
        strategy: PlaybackStrategySet::new(),
    };
    let runtime_for_task = Arc::clone(runtime);
    let playback_for_task = playback.clone();
    let task_playlist_name = playlist_name.clone();

    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            run_playback_session(runtime_for_task, playback_for_task, generation, session).await
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
pub async fn get_playback_status() -> Result<Option<PlaybackStatusPayload>> {
    let Some(playback) = runtime()?.current_playback()? else {
        return Ok(None);
    };

    let status = playback
        .status()
        .await
        .map_err(|error| anyhow!("failed to read playback status: {error}"))?;

    Ok(Some(PlaybackStatusPayload {
        path: status.path,
        playing: status.playing,
        paused: status.paused,
        position_ms: status.position_ms,
        duration_ms: status.duration_ms,
    }))
}

#[cfg(not(test))]
pub async fn analyze_track_waveform(
    app: &AppHandle,
    file_path: String,
    start: Option<u32>,
    end: Option<u32>,
) -> Result<TrackWaveform> {
    let ffmpeg_path =
        ensure_managed_binary(app, ManagedBinary::Ffmpeg).map_err(|error| anyhow!(error))?;
    tauri::async_runtime::spawn_blocking(move || {
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
    let ffmpeg_path =
        ensure_managed_binary(app, ManagedBinary::Ffmpeg).map_err(|error| anyhow!(error))?;
    let cache_root = waveform_cache_root(app)?;

    tauri::async_runtime::spawn_blocking(move || {
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
    let ffmpeg_path =
        ensure_managed_binary(app, ManagedBinary::Ffmpeg).map_err(|error| anyhow!(error))?;
    let cache_root = waveform_cache_root(app)?;

    tauri::async_runtime::spawn_blocking(move || {
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
    ) -> Result<()> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| anyhow!("player runtime session lock is poisoned"))?;

        *session = Some(ActivePlaybackSession {
            playlist_name,
            generation,
            tracks,
        });
        Ok(())
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

        *current_tracks = tracks;
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
}

#[cfg(not(test))]
struct PlaybackSession {
    tracks: SharedPlaybackTracks,
    strategy: PlaybackStrategySet,
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
    loop {
        if runtime.generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }

        let mode = runtime.continuation_mode()?;
        let tracks = session.tracks_snapshot()?;
        let Some(track) = session.strategy.next_track(mode, &tracks) else {
            return Ok(());
        };

        NowPlayingTrackChangedEvent::from(track.to_payload()).emit(&runtime.app)?;
        let request = playback_request_for_track(&track)?;
        playback
            .play_request(request)
            .await
            .map_err(|error| anyhow!("failed to play `{}`: {error}", track.music_name))?;
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
                && left.start == right.start
                && left.end == right.end
        })
}

#[cfg(not(test))]
fn playback_request_for_track(track: &PlaybackTrack) -> Result<PlaybackRequest> {
    let request = PlaybackRequest::new(track.file_path.clone());

    if track.end > track.start {
        let range = PlaybackTimeRange::bounded_seconds(track.start, track.end)
            .map_err(|error| anyhow!(error))?;
        return Ok(request.with_time_range(range));
    }

    if track.start > 0 {
        return Ok(request.with_time_range(PlaybackTimeRange::from_start_seconds(track.start)));
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
            return Ok(());
        }

        let status = playback
            .status()
            .await
            .map_err(|error| anyhow!("failed to read playback status: {error}"))?;
        let Some(active_path) = status.path else {
            return Ok(());
        };

        if Path::new(&active_path) != current_path {
            return Ok(());
        }

        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
