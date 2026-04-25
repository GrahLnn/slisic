#[cfg(not(test))]
use super::event::NowPlayingTrackChangedEvent;
#[cfg(not(test))]
use super::model::PlaybackTrack;
#[cfg(not(test))]
use super::strategy::{PlaybackStrategy, RandomPlaybackStrategy};
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
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(not(test))]
use std::time::Duration;
#[cfg(not(test))]
use tauri::AppHandle;
#[cfg(not(test))]
use tauri_specta::Event;

#[cfg(not(test))]
static PLAYER_RUNTIME: OnceLock<Arc<PlayerRuntime>> = OnceLock::new();

#[cfg(not(test))]
pub struct PlayerRuntime {
    app: AppHandle,
    playback: Mutex<Option<Playback>>,
    generation: AtomicU64,
}

#[cfg(not(test))]
pub fn initialize_runtime(app: AppHandle) {
    let _ = PLAYER_RUNTIME.get_or_init(|| {
        Arc::new(PlayerRuntime {
            app,
            playback: Mutex::new(None),
            generation: AtomicU64::new(0),
        })
    });
}

#[cfg(not(test))]
pub async fn play_tracks(playlist_name: String, tracks: Vec<PlaybackTrack>) -> Result<()> {
    if tracks.is_empty() {
        bail!("playback session `{playlist_name}` does not contain any playable tracks");
    }

    let runtime = runtime()?;
    let playback = runtime.playback()?;
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;

    if let Err(error) = playback.stop().await {
        eprintln!("[player] failed to stop previous playback before restart: {error}");
    }

    let session = PlaybackSession {
        tracks,
        strategy: Box::new(RandomPlaybackStrategy::new()),
    };
    let runtime_for_task = Arc::clone(runtime);
    let playback_for_task = playback.clone();

    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            run_playback_session(runtime_for_task, playback_for_task, generation, session).await
        {
            eprintln!("[player] playback session failed for `{playlist_name}`: {error}");
        }
    });

    Ok(())
}

#[cfg(not(test))]
pub async fn stop_playback() -> Result<bool> {
    let runtime = runtime()?;
    runtime.generation.fetch_add(1, Ordering::SeqCst);
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
fn runtime() -> Result<&'static Arc<PlayerRuntime>> {
    PLAYER_RUNTIME
        .get()
        .context("player runtime has not been initialized")
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
}

#[cfg(not(test))]
struct PlaybackSession {
    tracks: Vec<PlaybackTrack>,
    strategy: Box<dyn PlaybackStrategy>,
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

        let Some(track) = session.strategy.next_track(&session.tracks).cloned() else {
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
