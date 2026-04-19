use super::event::NowPlayingTrackChangedEvent;
use super::model::{PlayPlaylistSession, PlaybackTrack};
use super::strategy::{PlaybackStrategy, RandomPlaybackStrategy};
use crate::domain::meta::service as meta_service;
use crate::domain::playlists::model::{Collection, PlayList};
use crate::domain::playlists::repo as playlist_repo;
use crate::utils::binaries::{ManagedBinary, ensure_managed_binary};
use anyhow::{Context, Result, anyhow, bail};
use ffplayr::Playback;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;
use tauri_specta::Event;

static PLAYER_RUNTIME: OnceLock<Arc<PlayerRuntime>> = OnceLock::new();

pub struct PlayerRuntime {
    app: AppHandle,
    playback: Mutex<Option<Playback>>,
    generation: AtomicU64,
}

pub fn initialize_runtime(app: AppHandle) {
    let _ = PLAYER_RUNTIME.get_or_init(|| {
        Arc::new(PlayerRuntime {
            app,
            playback: Mutex::new(None),
            generation: AtomicU64::new(0),
        })
    });
}

pub async fn play_playlist(name: String) -> Result<PlayPlaylistSession> {
    let runtime = runtime()?;
    let session = build_playlist_session(&runtime.app, &name).await?;
    let playback = runtime.playback()?;
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;

    if let Err(error) = playback.stop().await {
        eprintln!("[player] failed to stop previous playback before restart: {error}");
    }

    let runtime_for_task = Arc::clone(runtime);
    let playback_for_task = playback.clone();
    let playlist_name = session.playlist_name.clone();
    let playlist_name_for_task = playlist_name.clone();
    let track_count = session.tracks.len() as u32;
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            run_playlist_session(runtime_for_task, playback_for_task, generation, session).await
        {
            eprintln!("[player] playlist playback failed for `{playlist_name_for_task}`: {error}");
        }
    });

    Ok(PlayPlaylistSession {
        playlist_name,
        track_count,
    })
}

fn runtime() -> Result<&'static Arc<PlayerRuntime>> {
    PLAYER_RUNTIME
        .get()
        .context("player runtime has not been initialized")
}

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
}

struct PlaylistSession {
    playlist_name: String,
    tracks: Vec<PlaybackTrack>,
    strategy: Box<dyn PlaybackStrategy>,
}

async fn build_playlist_session(app: &AppHandle, playlist_name: &str) -> Result<PlaylistSession> {
    let playlist = playlist_repo::get_playlist_by_name(playlist_name)
        .await?
        .ok_or_else(|| anyhow!("playlist `{playlist_name}` not found"))?;
    let library_collections = playlist_repo::list_collections().await?;
    let save_root = meta_service::resolve_save_root(app).await?;
    let tracks = collect_playlist_tracks(&playlist, &library_collections, &save_root);

    if tracks.is_empty() {
        bail!("playlist `{playlist_name}` does not contain any playable tracks");
    }

    Ok(PlaylistSession {
        playlist_name: playlist.name.clone(),
        tracks,
        strategy: Box::new(RandomPlaybackStrategy::new()),
    })
}

async fn run_playlist_session(
    runtime: Arc<PlayerRuntime>,
    playback: Playback,
    generation: u64,
    mut session: PlaylistSession,
) -> Result<()> {
    loop {
        if runtime.generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }

        let Some(track) = session.strategy.next_track(&session.tracks).cloned() else {
            return Ok(());
        };

        NowPlayingTrackChangedEvent::from(track.to_payload()).emit(&runtime.app)?;
        playback
            .play(track.file_path.clone())
            .await
            .map_err(|error| anyhow!("failed to play `{}`: {error}", track.music_name))?;
        wait_until_track_finishes(&runtime, &playback, generation, &track.file_path).await?;
    }
}

async fn wait_until_track_finishes(
    runtime: &PlayerRuntime,
    playback: &Playback,
    generation: u64,
    current_path: &Path,
) -> Result<()> {
    loop {
        if runtime.generation.load(Ordering::SeqCst) != generation {
            if let Err(error) = playback.stop().await {
                eprintln!("[player] failed to stop interrupted playback: {error}");
            }
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

pub(crate) fn collect_playlist_tracks(
    playlist: &PlayList,
    library_collections: &[Collection],
    save_root: &Path,
) -> Vec<PlaybackTrack> {
    let mut seen = HashSet::new();
    let mut tracks = Vec::new();

    for collection in &playlist.collections {
        append_collection_tracks(
            playlist,
            collection,
            save_root,
            &mut seen,
            &mut tracks,
            None,
        );
    }

    let selected_group_urls = playlist
        .groups
        .iter()
        .map(|group| group.url.as_str())
        .collect::<HashSet<_>>();
    if selected_group_urls.is_empty() {
        return tracks;
    }

    for collection in library_collections {
        append_collection_tracks(
            playlist,
            collection,
            save_root,
            &mut seen,
            &mut tracks,
            Some(&selected_group_urls),
        );
    }

    tracks
}

fn append_collection_tracks(
    playlist: &PlayList,
    collection: &Collection,
    save_root: &Path,
    seen: &mut HashSet<String>,
    tracks: &mut Vec<PlaybackTrack>,
    selected_group_urls: Option<&HashSet<&str>>,
) {
    for music in &collection.musics {
        if let Some(group_urls) = selected_group_urls
            && !group_urls.contains(music.group.url.as_str())
        {
            continue;
        }

        let Some(file_path) = resolve_music_file_path(save_root, collection, music.path.as_deref())
        else {
            continue;
        };
        if !file_path.is_file() {
            continue;
        }

        let key = format!("{}:{}:{}", music.url, music.start, music.end);
        if !seen.insert(key) {
            continue;
        }

        tracks.push(PlaybackTrack {
            playlist_name: playlist.name.clone(),
            music_name: music.name.clone(),
            music_url: music.url.clone(),
            file_path,
            start: music.start,
            end: music.end,
        });
    }
}

fn resolve_music_file_path(
    save_root: &Path,
    collection: &Collection,
    relative_path: Option<&str>,
) -> Option<PathBuf> {
    let path = PathBuf::from(relative_path?);
    if path.is_absolute() {
        return Some(path);
    }

    Some(save_root.join(&collection.folder).join(path))
}
