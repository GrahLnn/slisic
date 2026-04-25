#[cfg(not(test))]
use super::model::PlayPlaylistSession;
use crate::domain::downloads::model::DownloadTask;
#[cfg(not(test))]
use crate::domain::downloads::repo as download_repo;
#[cfg(not(test))]
use crate::domain::meta::service as meta_service;
#[cfg(not(test))]
use crate::domain::player::event::NowPlayingTrackChangedEvent;
use crate::domain::player::model::PlaybackTrack;
#[cfg(not(test))]
use crate::domain::player::service as player_service;
use crate::domain::playlists::model::{Collection, PlayList};
#[cfg(not(test))]
use crate::domain::playlists::repo as playlist_repo;
#[cfg(not(test))]
use anyhow::{Result, anyhow, bail};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::time::Duration;
#[cfg(not(test))]
use tauri::AppHandle;
#[cfg(not(test))]
use tauri_specta::Event;

#[cfg(not(test))]
const DOWNLOAD_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(500);
#[cfg(not(test))]
const PLAYLIST_PREPARING_MESSAGE: &str = "Preparing...";

#[cfg(not(test))]
pub async fn play_playlist(app: &AppHandle, name: String) -> Result<PlayPlaylistSession> {
    let material = build_playlist_playback_material(app, &name).await?;
    let playlist_name = material.playlist_name;
    let track_count = material.tracks.len() as u32;

    player_service::play_tracks(playlist_name.clone(), material.tracks).await?;

    Ok(PlayPlaylistSession {
        playlist_name,
        track_count,
    })
}

#[cfg(not(test))]
struct PlaylistPlaybackMaterial {
    playlist_name: String,
    tracks: Vec<PlaybackTrack>,
}

#[cfg(not(test))]
struct PlaylistTrackResolutionSource {
    playlist: PlayList,
    playlist_name: String,
    resolution: PlaylistTrackResolution,
}

pub(crate) struct PlaylistTrackResolution {
    pub(crate) tracks: Vec<PlaybackTrack>,
    pub(crate) failure_description: String,
}

pub(crate) struct PlaylistPlaybackInventory {
    pub(crate) tracks: Vec<PlaybackTrack>,
    pub(crate) has_relevant_active_downloads: bool,
    pub(crate) failure_description: String,
}

#[cfg(not(test))]
async fn build_playlist_playback_material(
    app: &AppHandle,
    playlist_name: &str,
) -> Result<PlaylistPlaybackMaterial> {
    let mut source = load_playlist_track_resolution(app, playlist_name).await?;
    let mut preparing_emitted = false;

    if !source.resolution.tracks.is_empty() {
        return Ok(PlaylistPlaybackMaterial {
            playlist_name: source.playlist_name,
            tracks: source.resolution.tracks,
        });
    }

    loop {
        if !playlist_has_active_downloads(&source.playlist).await? {
            bail!("{}", source.resolution.failure_description);
        }

        if !preparing_emitted {
            emit_playlist_preparing(app, &source.playlist_name)?;
            preparing_emitted = true;
        }

        tokio::time::sleep(DOWNLOAD_WAIT_POLL_INTERVAL).await;
        source = load_playlist_track_resolution(app, playlist_name).await?;

        if !source.resolution.tracks.is_empty() {
            return Ok(PlaylistPlaybackMaterial {
                playlist_name: source.playlist_name,
                tracks: source.resolution.tracks,
            });
        }
    }
}

#[cfg(not(test))]
async fn load_playlist_track_resolution(
    app: &AppHandle,
    playlist_name: &str,
) -> Result<PlaylistTrackResolutionSource> {
    let playlist = playlist_repo::get_playlist_by_name(playlist_name)
        .await?
        .ok_or_else(|| anyhow!("playlist `{playlist_name}` not found"))?;
    let save_root = meta_service::resolve_save_root(app).await?;
    let library_collections = playlist_repo::list_collections().await?;
    let selected_collections = resolve_selected_collections(&playlist, &library_collections);
    let resolution = resolve_playlist_track_resolution(
        &playlist,
        &selected_collections,
        &library_collections,
        &save_root,
    );

    Ok(PlaylistTrackResolutionSource {
        playlist_name: playlist.name.clone(),
        playlist,
        resolution,
    })
}

#[cfg(not(test))]
fn emit_playlist_preparing(app: &AppHandle, playlist_name: &str) -> Result<()> {
    NowPlayingTrackChangedEvent {
        playlist_name: playlist_name.to_string(),
        music_name: PLAYLIST_PREPARING_MESSAGE.to_string(),
        music_url: String::new(),
        start: 0,
        end: 0,
    }
    .emit(app)?;

    Ok(())
}

#[cfg(not(test))]
async fn playlist_has_active_downloads(playlist: &PlayList) -> Result<bool> {
    Ok(playlist_has_relevant_active_downloads(
        playlist,
        &download_repo::list_tasks().await?,
    ))
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
    let resolution = resolve_playlist_track_resolution(
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
        failure_description: resolution.failure_description,
        tracks: resolution.tracks,
    }
}

pub(crate) fn resolve_playlist_track_resolution(
    playlist: &PlayList,
    selected_collections: &[Collection],
    library_collections: &[Collection],
    save_root: &Path,
) -> PlaylistTrackResolution {
    PlaylistTrackResolution {
        tracks: collect_playlist_tracks(
            playlist,
            selected_collections,
            library_collections,
            save_root,
        ),
        failure_description: describe_playlist_track_resolution_failure(
            playlist,
            selected_collections,
            library_collections,
            save_root,
        ),
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
