#[cfg(not(test))]
use super::model::{PlayPlaylistSession, PlayPlaylistSessionStatus};
use crate::domain::downloads::model::DownloadTask;
#[cfg(not(test))]
use crate::domain::downloads::repo as download_repo;
#[cfg(not(test))]
use crate::domain::downloads::service as download_service;
#[cfg(not(test))]
use crate::domain::meta::service as meta_service;
#[cfg(not(test))]
use crate::domain::player::event::NowPlayingTrackChangedEvent;
use crate::domain::player::model::{PlaybackContinuationMode, PlaybackTrack};
#[cfg(not(test))]
use crate::domain::player::service as player_service;
#[cfg(not(test))]
use crate::domain::player::strategy::PlaybackQueueMode;
#[cfg(not(test))]
use crate::domain::playlists::repo as playlist_repo;
use crate::domain::playlists::repo::{PlaylistPlaybackSelection, PlaylistPlaybackTrackSource};
#[cfg(not(test))]
use anyhow::{Result, anyhow, bail};
use rand::RngExt;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use tauri::AppHandle;
#[cfg(not(test))]
use tauri_specta::Event;

#[cfg(not(test))]
const PLAYLIST_PREPARING_MESSAGE: &str = "Preparing...";
#[cfg(not(test))]
const INITIAL_PLAYBACK_QUEUE_LIMIT: usize = 256;
#[cfg(not(test))]
const PLAYLIST_PLAYBACK_SEED_SCAN_LIMIT: usize = 32;
#[cfg(not(test))]
const PLAYLIST_PLAYBACK_SEED_PROBE_LIMIT: usize = 1;

#[cfg(not(test))]
pub async fn play_playlist(app: &AppHandle, name: String) -> Result<PlayPlaylistSession> {
    let mut download_changes = download_service::subscribe_download_task_changes();
    let request = player_service::claim_playback_start_request()?;
    let material =
        build_playlist_playback_material(app, &name, &request, &mut download_changes).await?;
    let playlist_name = material.playlist_name;
    let track_count = material.tracks.len().max(1) as u32;
    let seed = material.seed;
    let tracks = ensure_queue_starts_with_seed(material.tracks, &seed);

    ensure_playlist_playback_request_current(&request)?;
    player_service::set_playback_continuation_mode(resolve_playlist_playback_continuation_mode())?;
    let session = player_service::play_tracks_from_initial_track_for_request_with_queue_mode(
        &request,
        playlist_name.clone(),
        tracks,
        seed.clone(),
        PlaybackQueueMode::Ordered,
    )
    .await?;
    spawn_playlist_track_queue_fill(
        app.clone(),
        playlist_name.clone(),
        session.clone(),
        seed.clone(),
    );
    spawn_playlist_track_refresh(
        app.clone(),
        playlist_name.clone(),
        session,
        seed,
        download_changes,
    );

    Ok(PlayPlaylistSession {
        status: PlayPlaylistSessionStatus::Started,
        playlist_name,
        track_count,
    })
}

pub(crate) fn resolve_playlist_playback_continuation_mode() -> PlaybackContinuationMode {
    PlaybackContinuationMode::Random
}

#[cfg(not(test))]
struct PlaylistPlaybackMaterial {
    playlist_name: String,
    seed: PlaybackTrack,
    tracks: Vec<PlaybackTrack>,
}

#[cfg(not(test))]
struct PlaylistTrackResolutionSource {
    selection: PlaylistPlaybackSelection,
    playlist_name: String,
    resolution: PlaylistTrackResolution,
}

pub(crate) struct PlaylistTrackResolution {
    pub(crate) tracks: Vec<PlaybackTrack>,
    pub(crate) failure_description: String,
}

#[cfg(not(test))]
async fn build_playlist_playback_material(
    app: &AppHandle,
    playlist_name: &str,
    request: &player_service::PlaybackStartRequestHandle,
    download_changes: &mut tokio::sync::broadcast::Receiver<
        download_service::DownloadTaskChangeSignal,
    >,
) -> Result<PlaylistPlaybackMaterial> {
    let mut source = load_playlist_playback_selection(playlist_name).await?;
    let mut preparing_emitted = false;

    ensure_playlist_playback_request_current(request)?;
    if let Some(seed) = resolve_playlist_playback_seed(app, &source.selection).await? {
        ensure_playlist_playback_request_current(request)?;
        return Ok(PlaylistPlaybackMaterial {
            playlist_name: source.playlist_name,
            seed,
            tracks: source.resolution.tracks,
        });
    }

    loop {
        let has_relevant_active_downloads =
            playlist_selection_has_active_downloads(&source.selection).await?;
        if !has_relevant_active_downloads {
            source = load_playlist_playback_selection(playlist_name).await?;
            if let Some(seed) = resolve_playlist_playback_seed(app, &source.selection).await? {
                ensure_playlist_playback_request_current(request)?;
                return Ok(PlaylistPlaybackMaterial {
                    playlist_name: source.playlist_name,
                    seed,
                    tracks: source.resolution.tracks,
                });
            }

            bail!("{}", source.resolution.failure_description);
        }

        ensure_playlist_playback_request_current(request)?;
        if !preparing_emitted {
            emit_playlist_preparing(app, &source.playlist_name)?;
            preparing_emitted = true;
        }

        wait_for_download_task_change(download_changes).await?;
        ensure_playlist_playback_request_current(request)?;
        source = load_playlist_playback_selection(playlist_name).await?;

        if let Some(seed) = resolve_playlist_playback_seed(app, &source.selection).await? {
            ensure_playlist_playback_request_current(request)?;
            return Ok(PlaylistPlaybackMaterial {
                playlist_name: source.playlist_name,
                seed,
                tracks: source.resolution.tracks,
            });
        }
    }
}

#[cfg(not(test))]
fn ensure_playlist_playback_request_current(
    request: &player_service::PlaybackStartRequestHandle,
) -> Result<()> {
    if player_service::is_playback_start_request_current(request)? {
        return Ok(());
    }

    Err(player_service::PlaybackStartRequestSuperseded.into())
}

#[cfg(not(test))]
fn spawn_playlist_track_queue_fill(
    app: AppHandle,
    playlist_name: String,
    session: player_service::PlaybackSessionHandle,
    seed: PlaybackTrack,
) {
    let task_playlist_name = playlist_name.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = fill_playlist_track_queue(app, playlist_name, session, seed).await {
            eprintln!(
                "[playlist_playback] failed to fill playback queue for `{task_playlist_name}`: {error}"
            );
        }
    });
}

#[cfg(not(test))]
fn spawn_playlist_track_refresh(
    app: AppHandle,
    playlist_name: String,
    session: player_service::PlaybackSessionHandle,
    seed: PlaybackTrack,
    download_changes: tokio::sync::broadcast::Receiver<download_service::DownloadTaskChangeSignal>,
) {
    let task_playlist_name = playlist_name.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = refresh_playlist_tracks_until_downloads_finish(
            app,
            playlist_name,
            session,
            seed,
            download_changes,
        )
        .await
        {
            eprintln!(
                "[playlist_playback] failed to refresh playback tracks for `{task_playlist_name}`: {error}"
            );
        }
    });
}

#[cfg(not(test))]
async fn fill_playlist_track_queue(
    app: AppHandle,
    playlist_name: String,
    session: player_service::PlaybackSessionHandle,
    seed: PlaybackTrack,
) -> Result<()> {
    if !player_service::is_session_current(&session)? {
        return Ok(());
    }

    let source =
        load_playlist_track_resolution_window(&app, &playlist_name, INITIAL_PLAYBACK_QUEUE_LIMIT)
            .await?;
    if source.resolution.tracks.is_empty() {
        return Ok(());
    }

    if !player_service::is_session_current(&session)? {
        return Ok(());
    }

    let seed = player_service::active_request_track_snapshot_for_session(&session)?.unwrap_or(seed);
    let tracks =
        RandomPlaylistPlaybackRecommender.propose_queue(PlaylistPlaybackRecommendationRequest {
            playlist_name,
            seed,
            candidates: source.resolution.tracks,
        });
    let _ = player_service::update_session_tracks(&session, tracks)?;
    Ok(())
}

#[cfg(not(test))]
async fn refresh_playlist_tracks_until_downloads_finish(
    app: AppHandle,
    playlist_name: String,
    session: player_service::PlaybackSessionHandle,
    seed: PlaybackTrack,
    mut download_changes: tokio::sync::broadcast::Receiver<
        download_service::DownloadTaskChangeSignal,
    >,
) -> Result<()> {
    loop {
        wait_for_download_task_change(&mut download_changes).await?;
        if !player_service::is_session_current(&session)? {
            return Ok(());
        }

        let source = load_playlist_track_resolution_window(
            &app,
            &playlist_name,
            INITIAL_PLAYBACK_QUEUE_LIMIT,
        )
        .await?;
        let has_relevant_active_downloads =
            playlist_selection_has_active_downloads(&source.selection).await?;

        if !source.resolution.tracks.is_empty() {
            let seed = player_service::active_request_track_snapshot_for_session(&session)?
                .unwrap_or_else(|| seed.clone());
            let tracks = RandomPlaylistPlaybackRecommender.propose_queue(
                PlaylistPlaybackRecommendationRequest {
                    playlist_name: playlist_name.clone(),
                    seed,
                    candidates: source.resolution.tracks,
                },
            );
            let updated = player_service::update_session_tracks(&session, tracks)?;
            if !updated {
                return Ok(());
            }
        }

        if !has_relevant_active_downloads {
            return Ok(());
        }
    }
}

#[cfg(not(test))]
async fn wait_for_download_task_change(
    download_changes: &mut tokio::sync::broadcast::Receiver<
        download_service::DownloadTaskChangeSignal,
    >,
) -> Result<()> {
    loop {
        match download_changes.recv().await {
            Ok(signal) => {
                let _ = (&signal.task_id, &signal.task_url, &signal.collection_url);
                return Ok(());
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => return Ok(()),
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                bail!("download task change channel closed");
            }
        }
    }
}

#[cfg(not(test))]
async fn load_playlist_playback_selection(
    playlist_name: &str,
) -> Result<PlaylistTrackResolutionSource> {
    let selection = playlist_repo::get_playlist_playback_selection_by_name(playlist_name)
        .await?
        .ok_or_else(|| anyhow!("playlist `{playlist_name}` not found"))?;
    let failure_description = describe_playlist_playback_selection_failure(&selection);

    Ok(PlaylistTrackResolutionSource {
        playlist_name: selection.playlist_name.clone(),
        selection,
        resolution: PlaylistTrackResolution {
            tracks: vec![],
            failure_description,
        },
    })
}

#[cfg(not(test))]
async fn resolve_playlist_playback_seed(
    app: &AppHandle,
    selection: &PlaylistPlaybackSelection,
) -> Result<Option<PlaybackTrack>> {
    let save_root = meta_service::resolve_save_root(app).await?;

    let probe_sources = playlist_repo::load_playlist_playback_track_sources(
        selection,
        PLAYLIST_PLAYBACK_SEED_PROBE_LIMIT,
    )
    .await?;
    let probe_resolution =
        resolve_playlist_playback_source_resolution(selection, probe_sources, &save_root);
    if let Some(seed) = probe_resolution.tracks.first().cloned() {
        return Ok(Some(seed));
    }

    let sequential_sources = playlist_repo::load_playlist_playback_track_sources(
        selection,
        PLAYLIST_PLAYBACK_SEED_SCAN_LIMIT,
    )
    .await?;
    let sequential_resolution =
        resolve_playlist_playback_source_resolution(selection, sequential_sources, &save_root);
    Ok(sequential_resolution.tracks.first().cloned())
}

#[cfg(not(test))]
fn describe_playlist_playback_selection_failure(selection: &PlaylistPlaybackSelection) -> String {
    format!(
        "playlist `{}` does not contain any playable tracks [selected_collection_refs={}, selected_group_refs={}]",
        selection.playlist_name,
        selection.collections.len(),
        selection.groups.len()
    )
}

#[cfg(not(test))]
async fn load_playlist_track_resolution_window(
    app: &AppHandle,
    playlist_name: &str,
    limit: usize,
) -> Result<PlaylistTrackResolutionSource> {
    let selection = playlist_repo::get_playlist_playback_selection_by_name(playlist_name)
        .await?
        .ok_or_else(|| anyhow!("playlist `{playlist_name}` not found"))?;
    let save_root = meta_service::resolve_save_root(app).await?;
    let sources = playlist_repo::load_playlist_playback_track_sources(&selection, limit).await?;
    let resolution = resolve_playlist_playback_source_resolution(&selection, sources, &save_root);

    Ok(PlaylistTrackResolutionSource {
        playlist_name: selection.playlist_name.clone(),
        selection,
        resolution,
    })
}

#[cfg(not(test))]
fn emit_playlist_preparing(app: &AppHandle, playlist_name: &str) -> Result<()> {
    NowPlayingTrackChangedEvent {
        playlist_name: playlist_name.to_string(),
        music_name: PLAYLIST_PREPARING_MESSAGE.to_string(),
        music_url: String::new(),
        file_path: String::new(),
        start_ms: 0,
        end_ms: 0,
    }
    .emit(app)?;

    Ok(())
}

#[cfg(not(test))]
async fn playlist_selection_has_active_downloads(
    selection: &PlaylistPlaybackSelection,
) -> Result<bool> {
    Ok(playlist_selection_has_relevant_active_downloads(
        selection,
        &download_repo::list_tasks().await?,
    ))
}

pub(crate) fn playlist_selection_has_relevant_active_downloads(
    selection: &PlaylistPlaybackSelection,
    download_tasks: &[DownloadTask],
) -> bool {
    let selected_urls = selection
        .download_scopes
        .iter()
        .map(String::as_str)
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

pub(crate) fn resolve_playlist_playback_source_resolution(
    selection: &PlaylistPlaybackSelection,
    sources: Vec<PlaylistPlaybackTrackSource>,
    save_root: &Path,
) -> PlaylistTrackResolution {
    let mut seen = HashSet::new();
    let mut tracks = Vec::new();
    let mut source_count = 0usize;
    let mut playable = 0usize;
    let mut missing_path = 0usize;
    let mut missing_file = 0usize;

    for source in sources {
        source_count += 1;
        let Some(file_path) = resolve_source_music_file_path(save_root, &source) else {
            missing_path += 1;
            continue;
        };
        if !file_path.is_file() {
            missing_file += 1;
            continue;
        }

        let key = format!(
            "{}:{}:{}",
            source.music.url, source.music.start_ms, source.music.end_ms
        );
        if !seen.insert(key) {
            continue;
        }

        playable += 1;
        tracks.push(PlaybackTrack {
            playlist_name: selection.playlist_name.clone(),
            music_name: source.music.alias.clone(),
            music_url: source.music.url.clone(),
            file_path,
            start_ms: source.music.start_ms,
            end_ms: source.music.end_ms,
        });
    }

    PlaylistTrackResolution {
        tracks,
        failure_description: format!(
            "playlist `{}` does not contain any playable tracks [selected_collection_refs={}, selected_group_refs={}, checked_sources={}, playable={}, missing_path={}, missing_file={}, save_root={}]",
            selection.playlist_name,
            selection.collections.len(),
            selection.groups.len(),
            source_count,
            playable,
            missing_path,
            missing_file,
            save_root.display()
        ),
    }
}

pub(crate) fn ensure_queue_starts_with_seed(
    mut tracks: Vec<PlaybackTrack>,
    seed: &PlaybackTrack,
) -> Vec<PlaybackTrack> {
    let Some(seed_index) = tracks
        .iter()
        .position(|track| are_playlist_playback_tracks_equal(track, seed))
    else {
        let mut seeded = Vec::with_capacity(tracks.len() + 1);
        seeded.push(seed.clone());
        seeded.extend(tracks);
        return seeded;
    };

    if seed_index != 0 {
        tracks.swap(0, seed_index);
    }
    tracks
}

fn are_playlist_playback_tracks_equal(left: &PlaybackTrack, right: &PlaybackTrack) -> bool {
    left.playlist_name == right.playlist_name
        && left.music_url == right.music_url
        && left.file_path == right.file_path
        && left.start_ms == right.start_ms
        && left.end_ms == right.end_ms
}

fn resolve_source_music_file_path(
    save_root: &Path,
    source: &PlaylistPlaybackTrackSource,
) -> Option<PathBuf> {
    let path = PathBuf::from(source.music.path.as_deref()?);
    if path.is_absolute() {
        return Some(path);
    }

    Some(save_root.join(&source.collection_folder).join(path))
}

pub(crate) struct PlaylistPlaybackRecommendationRequest {
    pub(crate) playlist_name: String,
    pub(crate) seed: PlaybackTrack,
    pub(crate) candidates: Vec<PlaybackTrack>,
}

pub(crate) trait PlaylistPlaybackRecommender {
    fn propose_queue(&self, request: PlaylistPlaybackRecommendationRequest) -> Vec<PlaybackTrack>;
}

pub(crate) struct RandomPlaylistPlaybackRecommender;

impl PlaylistPlaybackRecommender for RandomPlaylistPlaybackRecommender {
    fn propose_queue(
        &self,
        mut request: PlaylistPlaybackRecommendationRequest,
    ) -> Vec<PlaybackTrack> {
        let _playlist_name = &request.playlist_name;
        let tracks = &mut request.candidates;
        shuffle_playback_tracks(tracks);
        ensure_queue_starts_with_seed(request.candidates, &request.seed)
    }
}

pub(crate) fn shuffle_playback_tracks(tracks: &mut [PlaybackTrack]) {
    let mut rng = rand::rng();
    let len = tracks.len();
    for index in (1..len).rev() {
        let swap_index = rng.random_range(0..=index);
        tracks.swap(index, swap_index);
    }
}
