use super::event::NowPlayingTrackChangedEvent;
use super::model::{PlayPlaylistSession, PlaybackTrack};
use super::strategy::{PlaybackStrategy, RandomPlaybackStrategy};
use crate::domain::downloads::model::DownloadTask;
use crate::domain::downloads::repo as download_repo;
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
const DOWNLOAD_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(500);
const PLAYLIST_DOWNLOADING_STATUS_TEXT: &str = "Downloading...";

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
    let (session, track_count) = build_playlist_session(&runtime.app, &name).await?;
    let playback = runtime.playback()?;
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;

    if let Err(error) = playback.stop().await {
        eprintln!("[player] failed to stop previous playback before restart: {error}");
    }

    let runtime_for_task = Arc::clone(runtime);
    let playback_for_task = playback.clone();
    let playlist_name = session.playlist_name.clone();
    let playlist_name_for_task = playlist_name.clone();
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

    fn current_playback(&self) -> Result<Option<Playback>> {
        self.playback
            .lock()
            .map(|playback| playback.clone())
            .map_err(|_| anyhow!("player runtime playback lock is poisoned"))
    }
}

struct PlaylistSession {
    playlist_name: String,
    strategy: Box<dyn PlaybackStrategy>,
}

pub(crate) struct PlaylistPlaybackInventory {
    pub(crate) tracks: Vec<PlaybackTrack>,
    pub(crate) has_relevant_active_downloads: bool,
    pub(crate) failure_description: String,
}

async fn build_playlist_session(
    app: &AppHandle,
    playlist_name: &str,
) -> Result<(PlaylistSession, u32)> {
    let (playlist, inventory) = load_playlist_playback_inventory(app, playlist_name).await?;

    if inventory.tracks.is_empty() && !inventory.has_relevant_active_downloads {
        bail!("{}", inventory.failure_description);
    }

    Ok((
        PlaylistSession {
            playlist_name: playlist.name.clone(),
            strategy: Box::new(RandomPlaybackStrategy::new()),
        },
        inventory.tracks.len() as u32,
    ))
}

async fn load_playlist_playback_inventory(
    app: &AppHandle,
    playlist_name: &str,
) -> Result<(PlayList, PlaylistPlaybackInventory)> {
    let playlist = playlist_repo::get_playlist_by_name(playlist_name)
        .await?
        .ok_or_else(|| anyhow!("playlist `{playlist_name}` not found"))?;
    let save_root = meta_service::resolve_save_root(app).await?;
    let library_collections = playlist_repo::list_collections().await?;
    let download_tasks = download_repo::list_tasks().await?;
    let selected_collections = resolve_selected_collections(&playlist, &library_collections);
    let inventory = resolve_playlist_playback_inventory(
        &playlist,
        &selected_collections,
        &library_collections,
        &download_tasks,
        &save_root,
    );

    Ok((playlist, inventory))
}

pub(crate) fn resolve_selected_collections(
    playlist: &PlayList,
    library_collections: &[Collection],
) -> Vec<Collection> {
    playlist
        .collections
        .iter()
        .filter_map(|selected| {
            library_collections
                .iter()
                .find(|candidate| candidate.url == selected.url)
                .cloned()
        })
        .collect()
}

pub(crate) fn playlist_has_relevant_active_downloads(
    playlist: &PlayList,
    download_tasks: &[DownloadTask],
) -> bool {
    let selected_urls = playlist
        .collections
        .iter()
        .map(|collection| collection.url.as_str())
        .chain(playlist.groups.iter().map(|group| group.url.as_str()))
        .collect::<HashSet<_>>();

    if selected_urls.is_empty() {
        return false;
    }

    download_tasks
        .iter()
        .filter(|task| task.status.is_active())
        .any(|task| {
            task.collection_url
                .as_deref()
                .into_iter()
                .chain(std::iter::once(task.url.as_str()))
                .any(|url| selected_urls.contains(url))
        })
}

pub(crate) fn resolve_playlist_playback_inventory(
    playlist: &PlayList,
    selected_collections: &[Collection],
    library_collections: &[Collection],
    download_tasks: &[DownloadTask],
    save_root: &Path,
) -> PlaylistPlaybackInventory {
    // Playback stays data-driven: the session re-resolves tracks from the
    // canonical library and only treats active download tasks as a wait signal.
    let tracks = collect_playlist_tracks(
        playlist,
        selected_collections,
        library_collections,
        save_root,
    );

    PlaylistPlaybackInventory {
        has_relevant_active_downloads: playlist_has_relevant_active_downloads(
            playlist,
            download_tasks,
        ),
        failure_description: describe_playlist_track_resolution_failure(
            playlist,
            selected_collections,
            library_collections,
            save_root,
        ),
        tracks,
    }
}

fn describe_playlist_track_resolution_failure(
    playlist: &PlayList,
    selected_collections: &[Collection],
    library_collections: &[Collection],
    save_root: &Path,
) -> String {
    let selected_urls = playlist
        .collections
        .iter()
        .map(|collection| collection.url.as_str())
        .collect::<Vec<_>>();
    let selected_group_urls = playlist
        .groups
        .iter()
        .map(|group| group.url.as_str())
        .collect::<HashSet<_>>();

    let mut collection_summaries = Vec::new();

    for selected in &playlist.collections {
        let Some(collection) = library_collections
            .iter()
            .find(|candidate| candidate.url == selected.url)
        else {
            collection_summaries.push(format!(
                "collection(url={}, status=missing-from-library)",
                selected.url
            ));
            continue;
        };

        let mut playable = 0usize;
        let mut missing_path = 0usize;
        let mut missing_file = 0usize;

        for music in &collection.musics {
            let Some(path) = music.path.as_deref() else {
                missing_path += 1;
                continue;
            };

            let resolved = resolve_music_file_path(save_root, collection, Some(path));
            if resolved.as_ref().is_some_and(|path| path.is_file()) {
                playable += 1;
            } else {
                missing_file += 1;
            }
        }

        collection_summaries.push(format!(
            "collection(url={}, musics={}, playable={}, missing_path={}, missing_file={})",
            collection.url,
            collection.musics.len(),
            playable,
            missing_path,
            missing_file
        ));
    }

    let mut group_matches = 0usize;
    let mut group_playable = 0usize;
    for collection in library_collections {
        for music in &collection.musics {
            if !selected_group_urls.contains(music.group.url.as_str()) {
                continue;
            }

            group_matches += 1;
            if let Some(path) = music.path.as_deref() {
                let resolved = resolve_music_file_path(save_root, collection, Some(path));
                if resolved.as_ref().is_some_and(|path| path.is_file()) {
                    group_playable += 1;
                }
            }
        }
    }

    format!(
        "playlist `{}` does not contain any playable tracks [selected_collection_refs={}, matched_collections={}, selected_group_refs={}, group_matches={}, group_playable={}, save_root={}, selected_urls=[{}], details=[{}]]",
        playlist.name,
        playlist.collections.len(),
        selected_collections.len(),
        playlist.groups.len(),
        group_matches,
        group_playable,
        save_root.display(),
        selected_urls.join(", "),
        collection_summaries.join("; ")
    )
}

async fn run_playlist_session(
    runtime: Arc<PlayerRuntime>,
    playback: Playback,
    generation: u64,
    mut session: PlaylistSession,
) -> Result<()> {
    let mut is_waiting_for_download = false;

    loop {
        if runtime.generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }

        let (_, inventory) =
            load_playlist_playback_inventory(&runtime.app, &session.playlist_name).await?;

        if inventory.tracks.is_empty() {
            if inventory.has_relevant_active_downloads {
                if !is_waiting_for_download {
                    emit_playlist_status_text(
                        &runtime.app,
                        &session.playlist_name,
                        PLAYLIST_DOWNLOADING_STATUS_TEXT,
                    )?;
                    is_waiting_for_download = true;
                }

                tokio::time::sleep(DOWNLOAD_WAIT_POLL_INTERVAL).await;
                continue;
            }

            bail!("{}", inventory.failure_description);
        }

        is_waiting_for_download = false;

        let Some(track) = session.strategy.next_track(&inventory.tracks).cloned() else {
            continue;
        };

        NowPlayingTrackChangedEvent::from(track.to_payload()).emit(&runtime.app)?;
        playback
            .play(track.file_path.clone())
            .await
            .map_err(|error| anyhow!("failed to play `{}`: {error}", track.music_name))?;
        wait_until_track_finishes(&runtime, &playback, generation, &track.file_path).await?;
    }
}

fn emit_playlist_status_text(app: &AppHandle, playlist_name: &str, text: &str) -> Result<()> {
    NowPlayingTrackChangedEvent {
        playlist_name: playlist_name.to_string(),
        music_name: text.to_string(),
        music_url: String::new(),
        start: 0,
        end: 0,
    }
    .emit(app)?;

    Ok(())
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
    selected_collections: &[Collection],
    library_collections: &[Collection],
    save_root: &Path,
) -> Vec<PlaybackTrack> {
    let mut seen = HashSet::new();
    let mut tracks = Vec::new();

    for collection in selected_collections {
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
