#[cfg(not(test))]
use super::model::{
    ExcludeCurrentMusicAndSkipResult, PlayPlaylistSession, PlayPlaylistSessionStatus,
};
use crate::domain::downloads::model::DownloadTask;
#[cfg(not(test))]
use crate::domain::downloads::repo as download_repo;
#[cfg(not(test))]
use crate::domain::downloads::service as download_service;
#[cfg(not(test))]
use crate::domain::meta::service as meta_service;
#[cfg(not(test))]
use crate::domain::player::event::{
    NowPlayingTrackChangedEvent, PlaybackDiagnosticTraceDetail, PlaybackDiagnosticTraceEvent,
    PlaybackExcludeCommittedEvent,
};
use crate::domain::player::model::{PlaybackContinuationMode, PlaybackTrack};
#[cfg(not(test))]
use crate::domain::player::service as player_service;
#[cfg(not(test))]
use crate::domain::player::strategy::PlaybackQueueMode;
#[cfg(not(test))]
use crate::domain::playlist_playback::playable_index;
#[cfg(not(test))]
use crate::domain::playlist_playback::recommendation::{
    AudioStyleCandidateSelection, AudioStylePlaylistPlaybackProposal,
    initialize_audio_style_recommendation_runtime, published_audio_style_model_snapshot,
};
use crate::domain::playlist_playback::recommendation::{
    AudioStyleCandidateSelectionSource, filter_recently_played_recommendation_candidates,
};
#[cfg(not(test))]
use crate::domain::playlists::model::Music;
#[cfg(not(test))]
use crate::domain::playlists::repo as playlist_repo;
use crate::domain::playlists::repo::{PlaylistPlaybackSelection, PlaylistPlaybackTrackSource};
#[cfg(not(test))]
use anyhow::{Result, anyhow, bail};
use rand::RngExt;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::sync::{Arc, Mutex};
#[cfg(not(test))]
use std::time::Instant;
#[cfg(not(test))]
use tauri::AppHandle;
#[cfg(not(test))]
use tauri_specta::Event;

#[cfg(not(test))]
const PLAYLIST_PREPARING_MESSAGE: &str = "Preparing...";
#[cfg(not(test))]
const INITIAL_PLAYBACK_QUEUE_LIMIT: usize = 256;
#[cfg(not(test))]
const PLAYLIST_PLAYBACK_INITIAL_RANDOM_SOURCE_LIMIT: usize = 16;
#[cfg(not(test))]
const PLAYLIST_PLAYBACK_RANDOM_WINDOW_LIMIT: usize = 96;
#[cfg(not(test))]
const PLAYLIST_PLAYBACK_QUEUE_REFRESH_INTERVAL_MS: u64 = 250;
#[cfg(not(test))]
const PLAYLIST_PLAYBACK_LIKED_CANDIDATE_LIMIT: usize = 128;

#[cfg(not(test))]
type SharedPlaylistPlaybackRecentHistory = Arc<Mutex<PlaylistPlaybackRecentHistory>>;

#[cfg(not(test))]
#[derive(Clone, Default)]
pub(crate) struct PlaylistPlaybackRecentHistory {
    tracks: Vec<PlaybackTrack>,
}

#[cfg(not(test))]
impl PlaylistPlaybackRecentHistory {
    pub(crate) fn from_initial_track(track: PlaybackTrack) -> Self {
        let mut history = Self::default();
        history.observe(track);
        history
    }

    pub(crate) fn observe(&mut self, track: PlaybackTrack) {
        if !self
            .tracks
            .iter()
            .any(|recorded| are_playlist_playback_tracks_equal(recorded, &track))
        {
            self.tracks.push(track);
        }
    }

    pub(crate) fn snapshot(&self) -> Vec<PlaybackTrack> {
        self.tracks.clone()
    }
}

#[cfg(not(test))]
pub fn initialize_runtime(app: AppHandle) {
    initialize_audio_style_recommendation_runtime(app.clone());
    playable_index::initialize_runtime(app);
}

#[cfg(not(test))]
struct PlaylistPlaybackTrace<'a> {
    app: &'a AppHandle,
    playlist_name: Option<&'a str>,
    track: Option<&'a PlaybackTrack>,
    elapsed_ms: Option<u128>,
    candidate_count: Option<usize>,
    queue_count: Option<usize>,
    status: Option<&'a str>,
    error: Option<String>,
    details: Option<Vec<PlaybackDiagnosticTraceDetail>>,
}

#[cfg(not(test))]
impl<'a> PlaylistPlaybackTrace<'a> {
    fn new(app: &'a AppHandle) -> Self {
        Self {
            app,
            playlist_name: None,
            track: None,
            elapsed_ms: None,
            candidate_count: None,
            queue_count: None,
            status: None,
            error: None,
            details: None,
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

    fn candidate_count(mut self, candidate_count: usize) -> Self {
        self.candidate_count = Some(candidate_count);
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

    fn details(mut self, details: Vec<PlaybackDiagnosticTraceDetail>) -> Self {
        self.details = Some(details);
        self
    }
}

#[cfg(not(test))]
fn emit_playlist_playback_trace(event: &str, trace: PlaylistPlaybackTrace<'_>) {
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
        candidate_count: trace.candidate_count,
        queue_count: trace.queue_count,
        status: trace.status.map(str::to_string),
        error: trace.error,
        details: trace.details,
    })
    .emit(trace.app)
    {
        eprintln!("[playlist_playback] failed to emit diagnostic trace `{event}`: {error}");
    }
}

#[cfg(not(test))]
fn trace_detail(key: &str, value: impl ToString) -> PlaybackDiagnosticTraceDetail {
    PlaybackDiagnosticTraceDetail {
        key: key.to_string(),
        value: value.to_string(),
    }
}

#[cfg(not(test))]
pub async fn play_playlist(app: &AppHandle, name: String) -> Result<PlayPlaylistSession> {
    let trace_start = Instant::now();
    emit_playlist_playback_trace(
        "playlist-play-backend-start",
        PlaylistPlaybackTrace::new(app).playlist_name(&name),
    );

    let mut download_changes = download_service::subscribe_download_task_changes();
    let request = player_service::claim_playback_start_request()?;
    emit_playlist_playback_trace(
        "playlist-play-request-claimed",
        PlaylistPlaybackTrace::new(app)
            .playlist_name(&name)
            .elapsed(trace_start),
    );

    let material_result =
        build_playlist_playback_material(app, &name, &request, &mut download_changes).await;
    let material = match material_result {
        Ok(material) => material,
        Err(error) => {
            emit_playlist_playback_trace(
                "playlist-play-material-error",
                PlaylistPlaybackTrace::new(app)
                    .playlist_name(&name)
                    .elapsed(trace_start)
                    .error(&error),
            );
            return Err(error);
        }
    };
    let playlist_name = material.playlist_name;
    let initial_track = material.initial_track;
    let recent_history = PlaylistPlaybackRecentHistory::from_initial_track(initial_track.clone());
    let tracks = material.tracks;
    let track_count = tracks.len() as u32;
    let shared_recent_history = Arc::new(Mutex::new(recent_history));

    ensure_playlist_playback_request_current(&request)?;
    emit_playlist_playback_trace(
        "playlist-play-material-ready",
        PlaylistPlaybackTrace::new(app)
            .playlist_name(&playlist_name)
            .track(&initial_track)
            .elapsed(trace_start)
            .queue_count(tracks.len()),
    );
    let continuation_mode = resolve_playlist_playback_continuation_mode();
    player_service::set_playback_continuation_mode(continuation_mode)?;
    emit_playlist_playback_trace(
        "playlist-play-continuation-mode-set",
        PlaylistPlaybackTrace::new(app)
            .playlist_name(&playlist_name)
            .track(&initial_track)
            .elapsed(trace_start)
            .status(playlist_playback_continuation_mode_name(continuation_mode)),
    );
    emit_playlist_playback_trace(
        "playlist-play-player-submit-start",
        PlaylistPlaybackTrace::new(app)
            .playlist_name(&playlist_name)
            .track(&initial_track)
            .elapsed(trace_start)
            .queue_count(tracks.len()),
    );
    let session_result =
        player_service::play_tracks_from_initial_track_for_request_with_queue_mode(
            &request,
            playlist_name.clone(),
            tracks,
            initial_track.clone(),
            PlaybackQueueMode::Ordered,
        )
        .await;
    let session = match session_result {
        Ok(session) => {
            emit_playlist_playback_trace(
                "playlist-play-player-submit-ok",
                PlaylistPlaybackTrace::new(app)
                    .playlist_name(&playlist_name)
                    .track(&initial_track)
                    .elapsed(trace_start),
            );
            session
        }
        Err(error) => {
            emit_playlist_playback_trace(
                "playlist-play-player-submit-error",
                PlaylistPlaybackTrace::new(app)
                    .playlist_name(&playlist_name)
                    .track(&initial_track)
                    .elapsed(trace_start)
                    .error(&error),
            );
            return Err(error);
        }
    };
    spawn_playlist_track_queue_fill(
        app.clone(),
        playlist_name.clone(),
        session.clone(),
        initial_track.clone(),
        Arc::clone(&shared_recent_history),
    );
    spawn_playlist_track_refresh(
        app.clone(),
        playlist_name.clone(),
        session,
        initial_track,
        download_changes,
        shared_recent_history,
    );
    emit_playlist_playback_trace(
        "playlist-play-backend-ok",
        PlaylistPlaybackTrace::new(app)
            .playlist_name(&playlist_name)
            .elapsed(trace_start)
            .status("started")
            .queue_count(track_count as usize),
    );

    Ok(PlayPlaylistSession {
        status: PlayPlaylistSessionStatus::Started,
        playlist_name,
        track_count,
    })
}

#[cfg(not(test))]
pub async fn exclude_current_music_and_skip(
    app: &AppHandle,
) -> Result<ExcludeCurrentMusicAndSkipResult> {
    let Some(track) = player_service::active_request_track_snapshot()? else {
        return Ok(ExcludeCurrentMusicAndSkipResult::NoActiveTrack);
    };
    let Some(music) = track.source_music.as_deref().cloned() else {
        return Ok(ExcludeCurrentMusicAndSkipResult::MissingMusic);
    };
    let excluded_music = project_excluded_current_music(&track, music);
    PlaybackExcludeCommittedEvent {
        exclude: crate::domain::playlists::model::Exclude {
            music: excluded_music.clone(),
            created_at: appdb::AutoFill::pending(),
        },
    }
    .emit(app)?;
    let immediate_action = prepare_current_session_after_exclude(app, &track).await?;
    match immediate_action {
        ExcludeCurrentImmediatePlaybackAction::Skip => {
            spawn_exclude_current_playback_skip(track.clone());
        }
        ExcludeCurrentImmediatePlaybackAction::Stop => {
            spawn_exclude_current_playback_stop(track.clone());
        }
    }

    let exclude_result = playlist_repo::add_exclude(excluded_music).await?;
    playable_index::notify_exclude_changed();
    let outcome = refresh_current_session_after_exclude(app, &track).await?;
    if let ExcludeCurrentMusicAndSkipOutcome::DeletedPlaylist { .. } = outcome
        && !matches!(
            immediate_action,
            ExcludeCurrentImmediatePlaybackAction::Stop
        )
    {
        spawn_exclude_current_playback_stop(track);
    }

    Ok(outcome.into_result(exclude_result))
}

#[cfg(not(test))]
fn spawn_exclude_current_playback_skip(track: PlaybackTrack) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = player_service::skip_current_track().await {
            eprintln!(
                "[playlist_playback] failed to skip excluded current music `{}`: {error}",
                track.music_name
            );
            return;
        }
    });
}

#[cfg(not(test))]
fn spawn_exclude_current_playback_stop(track: PlaybackTrack) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = player_service::stop_playback().await {
            eprintln!(
                "[playlist_playback] failed to stop playback after excluding `{}`: {error}",
                track.music_name
            );
            return;
        }
    });
}

#[cfg(not(test))]
async fn prepare_current_session_after_exclude(
    app: &AppHandle,
    track: &PlaybackTrack,
) -> Result<ExcludeCurrentImmediatePlaybackAction> {
    let prepared_tracks = load_current_session_track_resolution_snapshot(track)?;
    if !prepared_tracks.is_empty() {
        player_service::update_current_session_tracks(prepared_tracks)?;
        return Ok(ExcludeCurrentImmediatePlaybackAction::Skip);
    }

    let fallback_candidates = load_immediate_playlist_playback_candidates(app, track).await?;

    let fallback_tracks = propose_playlist_playback_queue_after_exclude_with_logging(
        PlaylistPlaybackRecommendationRequest {
            playlist_name: track.playlist_name.clone(),
            current_track: track.clone(),
            candidates: fallback_candidates,
            recently_played_tracks: vec![track.clone()],
        },
    );
    if fallback_tracks.is_empty() {
        return Ok(ExcludeCurrentImmediatePlaybackAction::Stop);
    }

    player_service::update_current_session_tracks(fallback_tracks)?;
    Ok(ExcludeCurrentImmediatePlaybackAction::Skip)
}

#[cfg(not(test))]
async fn load_immediate_playlist_playback_candidates(
    app: &AppHandle,
    track: &PlaybackTrack,
) -> Result<Vec<PlaybackTrack>> {
    let selection = playlist_repo::get_playlist_playback_selection_by_name(&track.playlist_name)
        .await?
        .ok_or_else(|| anyhow!("playlist `{}` not found", track.playlist_name))?;
    let save_root = meta_service::resolve_save_root(app).await?;

    let mut seen = HashSet::new();
    let sources = load_random_playlist_playback_track_sources(
        &selection,
        PLAYLIST_PLAYBACK_INITIAL_RANDOM_SOURCE_LIMIT,
    )
    .await?;
    for source in sources {
        let source_key = playlist_playback_track_source_key(&source);
        if !seen.insert(source_key) {
            continue;
        }

        let Some(candidate) =
            resolve_playlist_playback_source_track(&selection, source, &save_root)
        else {
            continue;
        };
        if !are_playlist_playback_tracks_equal(&candidate, track) {
            return Ok(vec![candidate]);
        }
    }

    Ok(vec![])
}

#[cfg(not(test))]
fn load_current_session_track_resolution_snapshot(
    track: &PlaybackTrack,
) -> Result<Vec<PlaybackTrack>> {
    Ok(player_service::current_session_tracks_snapshot()?
        .into_iter()
        .filter(|candidate| !are_playlist_playback_tracks_equal(candidate, track))
        .collect())
}

#[cfg(not(test))]
async fn refresh_current_session_after_exclude(
    app: &AppHandle,
    track: &PlaybackTrack,
) -> Result<ExcludeCurrentMusicAndSkipOutcome> {
    let source = load_playlist_track_resolution_window(
        app,
        &track.playlist_name,
        INITIAL_PLAYBACK_QUEUE_LIMIT,
    )
    .await?;

    if source.resolution.tracks.is_empty() {
        player_service::update_current_session_tracks(vec![])?;
        playlist_repo::delete_playlist_by_name(&track.playlist_name).await?;
        playable_index::notify_playlist_deleted(&track.playlist_name);
        return Ok(ExcludeCurrentMusicAndSkipOutcome::DeletedPlaylist {
            playlist_name: track.playlist_name.clone(),
        });
    }

    let tracks = propose_playlist_playback_queue_after_exclude_with_logging(
        PlaylistPlaybackRecommendationRequest {
            playlist_name: source.playlist_name,
            current_track: track.clone(),
            candidates: source.resolution.tracks,
            recently_played_tracks: vec![track.clone()],
        },
    );
    player_service::update_current_session_tracks(tracks)?;
    Ok(ExcludeCurrentMusicAndSkipOutcome::Skipped)
}

#[cfg(not(test))]
enum ExcludeCurrentMusicAndSkipOutcome {
    Skipped,
    DeletedPlaylist { playlist_name: String },
}

#[cfg(not(test))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum ExcludeCurrentImmediatePlaybackAction {
    Skip,
    Stop,
}

#[cfg(not(test))]
impl ExcludeCurrentMusicAndSkipOutcome {
    fn into_result(
        self,
        exclude_result: crate::domain::playlists::model::AddExcludeResult,
    ) -> ExcludeCurrentMusicAndSkipResult {
        match self {
            ExcludeCurrentMusicAndSkipOutcome::Skipped => {
                ExcludeCurrentMusicAndSkipResult::Skipped {
                    exclude: exclude_result.exclude,
                    exclude_availability: exclude_result.exclude_availability,
                }
            }
            ExcludeCurrentMusicAndSkipOutcome::DeletedPlaylist { playlist_name } => {
                ExcludeCurrentMusicAndSkipResult::DeletedPlaylist {
                    playlist_name,
                    exclude: exclude_result.exclude,
                    exclude_availability: exclude_result.exclude_availability,
                }
            }
        }
    }
}

#[cfg(not(test))]
fn project_excluded_current_music(
    track: &crate::domain::player::model::PlaybackTrack,
    mut music: Music,
) -> Music {
    music.alias = track.music_name.clone();
    music.path = Some(track.file_path.to_string_lossy().to_string());
    music
}

pub(crate) fn resolve_playlist_playback_continuation_mode() -> PlaybackContinuationMode {
    PlaybackContinuationMode::Random
}

#[cfg(not(test))]
fn playlist_playback_continuation_mode_name(mode: PlaybackContinuationMode) -> &'static str {
    match mode {
        PlaybackContinuationMode::Random => "random",
        PlaybackContinuationMode::RepeatCurrent => "repeat_current",
    }
}

#[cfg(not(test))]
struct PlaylistPlaybackMaterial {
    playlist_name: String,
    initial_track: PlaybackTrack,
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
    let trace_start = Instant::now();
    let mut source = load_playlist_playback_selection(playlist_name).await?;
    let mut preparing_emitted = false;
    let mut wait_count = 0usize;

    emit_playlist_playback_trace(
        "playlist-play-material-selection-loaded",
        PlaylistPlaybackTrace::new(app)
            .playlist_name(&source.playlist_name)
            .elapsed(trace_start)
            .details(selection_trace_details(&source.selection, wait_count)),
    );

    ensure_playlist_playback_request_current(request)?;
    if let Some(initial_track) = resolve_playlist_initial_track(app, &source.selection).await? {
        let tracks = create_start_anchor_playback_queue(initial_track.clone());
        ensure_playlist_playback_request_current(request)?;
        emit_playlist_playback_trace(
            "playlist-play-material-initial-track-ok",
            PlaylistPlaybackTrace::new(app)
                .playlist_name(&source.playlist_name)
                .track(&initial_track)
                .elapsed(trace_start)
                .details(selection_trace_details(&source.selection, wait_count)),
        );
        return Ok(PlaylistPlaybackMaterial {
            playlist_name: source.playlist_name,
            initial_track,
            tracks,
        });
    }
    emit_playlist_playback_trace(
        "playlist-play-material-initial-track-miss",
        PlaylistPlaybackTrace::new(app)
            .playlist_name(&source.playlist_name)
            .elapsed(trace_start)
            .details(selection_trace_details(&source.selection, wait_count)),
    );

    loop {
        let has_relevant_active_downloads =
            playlist_selection_has_active_downloads(&source.selection).await?;
        emit_playlist_playback_trace(
            "playlist-play-material-active-downloads-checked",
            PlaylistPlaybackTrace::new(app)
                .playlist_name(&source.playlist_name)
                .elapsed(trace_start)
                .status(if has_relevant_active_downloads {
                    "active"
                } else {
                    "inactive"
                })
                .details(selection_trace_details(&source.selection, wait_count)),
        );
        if !has_relevant_active_downloads {
            source = load_playlist_playback_selection(playlist_name).await?;
            if let Some(initial_track) =
                resolve_playlist_initial_track(app, &source.selection).await?
            {
                let tracks = create_start_anchor_playback_queue(initial_track.clone());
                ensure_playlist_playback_request_current(request)?;
                emit_playlist_playback_trace(
                    "playlist-play-material-initial-track-ok",
                    PlaylistPlaybackTrace::new(app)
                        .playlist_name(&source.playlist_name)
                        .track(&initial_track)
                        .elapsed(trace_start)
                        .details(selection_trace_details(&source.selection, wait_count)),
                );
                return Ok(PlaylistPlaybackMaterial {
                    playlist_name: source.playlist_name,
                    initial_track,
                    tracks,
                });
            }

            emit_playlist_playback_trace(
                "playlist-play-material-unplayable",
                PlaylistPlaybackTrace::new(app)
                    .playlist_name(&source.playlist_name)
                    .elapsed(trace_start)
                    .error(&source.resolution.failure_description)
                    .details(selection_trace_details(&source.selection, wait_count)),
            );
            bail!("{}", source.resolution.failure_description);
        }

        ensure_playlist_playback_request_current(request)?;
        if !preparing_emitted {
            emit_playlist_preparing(app, &source.playlist_name)?;
            preparing_emitted = true;
            emit_playlist_playback_trace(
                "playlist-play-material-preparing-emitted",
                PlaylistPlaybackTrace::new(app)
                    .playlist_name(&source.playlist_name)
                    .elapsed(trace_start)
                    .details(selection_trace_details(&source.selection, wait_count)),
            );
        }

        emit_playlist_playback_trace(
            "playlist-play-material-wait-download-change-start",
            PlaylistPlaybackTrace::new(app)
                .playlist_name(&source.playlist_name)
                .elapsed(trace_start)
                .details(selection_trace_details(&source.selection, wait_count)),
        );
        let wait_start = Instant::now();
        wait_for_download_task_change(download_changes).await?;
        wait_count += 1;
        emit_playlist_playback_trace(
            "playlist-play-material-wait-download-change-ok",
            PlaylistPlaybackTrace::new(app)
                .playlist_name(&source.playlist_name)
                .elapsed(trace_start)
                .details(vec![
                    trace_detail("waitMs", wait_start.elapsed().as_millis()),
                    trace_detail("waitCount", wait_count),
                ]),
        );
        ensure_playlist_playback_request_current(request)?;
        source = load_playlist_playback_selection(playlist_name).await?;

        if let Some(initial_track) = resolve_playlist_initial_track(app, &source.selection).await? {
            let tracks = create_start_anchor_playback_queue(initial_track.clone());
            ensure_playlist_playback_request_current(request)?;
            emit_playlist_playback_trace(
                "playlist-play-material-initial-track-ok",
                PlaylistPlaybackTrace::new(app)
                    .playlist_name(&source.playlist_name)
                    .track(&initial_track)
                    .elapsed(trace_start)
                    .details(selection_trace_details(&source.selection, wait_count)),
            );
            return Ok(PlaylistPlaybackMaterial {
                playlist_name: source.playlist_name,
                initial_track,
                tracks,
            });
        }
    }
}

#[cfg(not(test))]
fn selection_trace_details(
    selection: &PlaylistPlaybackSelection,
    wait_count: usize,
) -> Vec<PlaybackDiagnosticTraceDetail> {
    vec![
        trace_detail("selectedCollectionRefs", selection.collections.len()),
        trace_detail("selectedGroupRefs", selection.groups.len()),
        trace_detail("selectedExtraRefs", selection.extra.len()),
        trace_detail("downloadScopes", selection.download_scopes.len()),
        trace_detail("waitCount", wait_count),
    ]
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
    initial_track: PlaybackTrack,
    recent_history: SharedPlaylistPlaybackRecentHistory,
) {
    let task_playlist_name = playlist_name.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            fill_playlist_track_queue(app, playlist_name, session, initial_track, recent_history)
                .await
        {
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
    initial_track: PlaybackTrack,
    download_changes: tokio::sync::broadcast::Receiver<download_service::DownloadTaskChangeSignal>,
    recent_history: SharedPlaylistPlaybackRecentHistory,
) {
    let task_playlist_name = playlist_name.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = refresh_playlist_tracks_until_downloads_finish(
            app,
            playlist_name,
            session,
            initial_track,
            download_changes,
            recent_history,
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
    initial_track: PlaybackTrack,
    recent_history: SharedPlaylistPlaybackRecentHistory,
) -> Result<()> {
    let mut current_anchor: Option<PlaybackTrack> = None;
    loop {
        if !player_service::is_session_current(&session)? {
            return Ok(());
        }

        let active_track = resolve_playlist_playback_queue_anchor(&session, &initial_track).await?;
        let recent_history_snapshot =
            observe_playlist_playback_recent_history(&recent_history, active_track.clone())?;
        let queue_has_next = current_session_queue_contains_next(&session)?;
        if should_refresh_playlist_queue_for_anchor(
            current_anchor.as_ref(),
            &active_track,
            queue_has_next,
        ) {
            refresh_playlist_track_queue_for_anchor(
                &app,
                &playlist_name,
                &session,
                active_track.clone(),
                &recent_history_snapshot,
                true,
            )
            .await?;
            current_anchor = Some(active_track);
        }

        tokio::time::sleep(std::time::Duration::from_millis(
            PLAYLIST_PLAYBACK_QUEUE_REFRESH_INTERVAL_MS,
        ))
        .await;
    }
}

pub(crate) fn should_refresh_playlist_queue_for_anchor(
    current_anchor: Option<&PlaybackTrack>,
    active_track: &PlaybackTrack,
    queue_has_next: bool,
) -> bool {
    current_anchor.is_none_or(|anchor| !are_playlist_playback_tracks_equal(anchor, active_track))
        || !queue_has_next
}

#[cfg(not(test))]
fn current_session_queue_contains_next(
    session: &player_service::PlaybackSessionHandle,
) -> Result<bool> {
    if !player_service::is_session_current(session)? {
        return Ok(false);
    }

    Ok(playlist_playback_proposal_contains_next_track(
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        &player_service::current_session_tracks_snapshot()?,
    ))
}

#[cfg(not(test))]
async fn refresh_playlist_tracks_until_downloads_finish(
    app: AppHandle,
    playlist_name: String,
    session: player_service::PlaybackSessionHandle,
    initial_track: PlaybackTrack,
    mut download_changes: tokio::sync::broadcast::Receiver<
        download_service::DownloadTaskChangeSignal,
    >,
    recent_history: SharedPlaylistPlaybackRecentHistory,
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
            let current_track =
                resolve_playlist_playback_queue_anchor(&session, &initial_track).await?;
            let recent_history_snapshot =
                observe_playlist_playback_recent_history(&recent_history, current_track.clone())?;
            let updated = refresh_playlist_track_queue_for_anchor(
                &app,
                &playlist_name,
                &session,
                current_track,
                &recent_history_snapshot,
                false,
            )
            .await?;
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
async fn refresh_playlist_track_queue_for_anchor(
    app: &AppHandle,
    playlist_name: &str,
    session: &player_service::PlaybackSessionHandle,
    current_track: PlaybackTrack,
    recently_played_tracks: &[PlaybackTrack],
    should_log_selection: bool,
) -> Result<bool> {
    let source = load_random_playlist_track_resolution_window(
        app,
        playlist_name,
        PLAYLIST_PLAYBACK_RANDOM_WINDOW_LIMIT,
    )
    .await?;
    if source.resolution.tracks.is_empty() {
        return Ok(true);
    }

    if !player_service::is_session_current(session)? {
        return Ok(false);
    }

    let tracks = propose_playlist_playback_queue_with_mode(
        PlaylistPlaybackRecommendationRequest {
            playlist_name: playlist_name.to_string(),
            current_track,
            candidates: source.resolution.tracks,
            recently_played_tracks: recently_played_tracks.to_vec(),
        },
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        should_log_selection,
    );
    player_service::update_session_tracks(session, tracks)
}

#[cfg(not(test))]
fn observe_playlist_playback_recent_history(
    recent_history: &SharedPlaylistPlaybackRecentHistory,
    track: PlaybackTrack,
) -> Result<Vec<PlaybackTrack>> {
    let mut history = recent_history
        .lock()
        .map_err(|_| anyhow!("playlist playback recent history lock is poisoned"))?;
    history.observe(track);
    Ok(history.snapshot())
}

#[cfg(not(test))]
async fn resolve_playlist_playback_queue_anchor(
    session: &player_service::PlaybackSessionHandle,
    initial_track: &PlaybackTrack,
) -> Result<PlaybackTrack> {
    let Some(active_track) = player_service::active_request_track_snapshot_for_session(session)?
    else {
        return Ok(initial_track.clone());
    };

    if playlist_repo::is_music_identity_excluded_for_playback(
        &active_track.music_url,
        active_track.start_ms,
        active_track.end_ms,
    )
    .await?
    {
        return Ok(initial_track.clone());
    }

    Ok(active_track)
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
async fn resolve_playlist_initial_track(
    app: &AppHandle,
    selection: &PlaylistPlaybackSelection,
) -> Result<Option<PlaybackTrack>> {
    let trace_start = Instant::now();
    emit_playlist_playback_trace(
        "playlist-play-initial-resolve-start",
        PlaylistPlaybackTrace::new(app)
            .playlist_name(&selection.playlist_name)
            .details(selection_trace_details(selection, 0)),
    );
    let save_root = meta_service::resolve_save_root(app).await?;
    emit_playlist_playback_trace(
        "playlist-play-initial-save-root-ok",
        PlaylistPlaybackTrace::new(app)
            .playlist_name(&selection.playlist_name)
            .elapsed(trace_start)
            .details(vec![trace_detail(
                "saveRoot",
                save_root.display().to_string(),
            )]),
    );

    let random_load_start = Instant::now();
    let mut seen = HashSet::new();
    let indexed_source = playable_index::read_playlist_source(&selection.playlist_name)?;
    let (sources, index_status, index_generation) = match indexed_source {
        Some(snapshot) => (
            snapshot.source.into_iter().collect::<Vec<_>>(),
            "hit",
            Some(snapshot.generation),
        ),
        None => {
            playable_index::notify_playback_miss(&selection.playlist_name);
            (
                load_random_playlist_playback_track_sources(
                    selection,
                    PLAYLIST_PLAYBACK_INITIAL_RANDOM_SOURCE_LIMIT,
                )
                .await?,
                "miss",
                None,
            )
        }
    };
    let sampled_count = sources.len();
    let mut tracks = Vec::new();
    for source in sources {
        let source_key = playlist_playback_track_source_key(&source);
        if !seen.insert(source_key) {
            continue;
        }

        let Some(track) = resolve_playlist_playback_source_track(selection, source, &save_root)
        else {
            continue;
        };
        tracks.push(track);
    }

    let playable_count = tracks.len();
    shuffle_playback_tracks(&mut tracks);
    if let Some(track) = tracks.into_iter().next() {
        emit_playlist_playback_trace(
            "playlist-play-initial-random-hit",
            PlaylistPlaybackTrace::new(app)
                .playlist_name(&selection.playlist_name)
                .track(&track)
                .elapsed(trace_start)
                .candidate_count(playable_count)
                .details(vec![
                    trace_detail("randomLoadMs", random_load_start.elapsed().as_millis()),
                    trace_detail(
                        "randomSourceLimit",
                        PLAYLIST_PLAYBACK_INITIAL_RANDOM_SOURCE_LIMIT,
                    ),
                    trace_detail("sampledSources", sampled_count),
                    trace_detail("uniqueSources", seen.len()),
                    trace_detail("indexStatus", index_status),
                    trace_detail(
                        "indexGeneration",
                        index_generation
                            .map(|generation| generation.to_string())
                            .unwrap_or_else(|| "none".to_string()),
                    ),
                ]),
        );
        return Ok(Some(track));
    }

    playable_index::notify_playback_miss(&selection.playlist_name);
    emit_playlist_playback_trace(
        "playlist-play-initial-random-miss",
        PlaylistPlaybackTrace::new(app)
            .playlist_name(&selection.playlist_name)
            .elapsed(trace_start)
            .candidate_count(playable_count)
            .details(vec![
                trace_detail("randomLoadMs", random_load_start.elapsed().as_millis()),
                trace_detail(
                    "randomSourceLimit",
                    PLAYLIST_PLAYBACK_INITIAL_RANDOM_SOURCE_LIMIT,
                ),
                trace_detail("sampledSources", sampled_count),
                trace_detail("uniqueSources", seen.len()),
                trace_detail("indexStatus", index_status),
                trace_detail(
                    "indexGeneration",
                    index_generation
                        .map(|generation| generation.to_string())
                        .unwrap_or_else(|| "none".to_string()),
                ),
            ]),
    );
    Ok(None)
}

#[cfg(not(test))]
fn describe_playlist_playback_selection_failure(selection: &PlaylistPlaybackSelection) -> String {
    format!(
        "playlist `{}` does not contain any playable tracks [selected_collection_refs={}, selected_group_refs={}, selected_extra_refs={}]",
        selection.playlist_name,
        selection.collections.len(),
        selection.groups.len(),
        selection.extra.len()
    )
}

#[cfg(not(test))]
async fn load_random_playlist_track_resolution_window(
    app: &AppHandle,
    playlist_name: &str,
    limit: usize,
) -> Result<PlaylistTrackResolutionSource> {
    let selection = playlist_repo::get_playlist_playback_selection_by_name(playlist_name)
        .await?
        .ok_or_else(|| anyhow!("playlist `{playlist_name}` not found"))?;
    let save_root = meta_service::resolve_save_root(app).await?;
    let sources = load_random_playlist_playback_track_sources(&selection, limit).await?;
    let liked_sources = playlist_repo::load_liked_playlist_playback_track_sources(
        &selection,
        PLAYLIST_PLAYBACK_LIKED_CANDIDATE_LIMIT,
    )
    .await?;
    let sources = merge_playlist_playback_track_sources(sources, liked_sources);
    let resolution = resolve_playlist_playback_source_resolution(&selection, sources, &save_root);

    Ok(PlaylistTrackResolutionSource {
        playlist_name: selection.playlist_name.clone(),
        selection,
        resolution,
    })
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
    let liked_sources = playlist_repo::load_liked_playlist_playback_track_sources(
        &selection,
        PLAYLIST_PLAYBACK_LIKED_CANDIDATE_LIMIT,
    )
    .await?;
    let sources = merge_playlist_playback_track_sources(sources, liked_sources);
    let resolution = resolve_playlist_playback_source_resolution(&selection, sources, &save_root);

    Ok(PlaylistTrackResolutionSource {
        playlist_name: selection.playlist_name.clone(),
        selection,
        resolution,
    })
}

#[cfg(not(test))]
async fn load_random_playlist_playback_track_sources(
    selection: &PlaylistPlaybackSelection,
    limit: usize,
) -> Result<Vec<PlaylistPlaybackTrackSource>> {
    playlist_repo::load_random_playlist_playback_track_sources(selection, limit).await
}

#[cfg(not(test))]
fn merge_playlist_playback_track_sources(
    base: Vec<PlaylistPlaybackTrackSource>,
    extra: Vec<PlaylistPlaybackTrackSource>,
) -> Vec<PlaylistPlaybackTrackSource> {
    let mut seen = HashSet::new();
    let mut merged = Vec::with_capacity(base.len() + extra.len());
    for source in base.into_iter().chain(extra) {
        let key = playlist_playback_track_source_key(&source);
        if seen.insert(key) {
            merged.push(source);
        }
    }
    merged
}

#[cfg(not(test))]
fn emit_playlist_preparing(app: &AppHandle, playlist_name: &str) -> Result<()> {
    NowPlayingTrackChangedEvent {
        playlist_name: playlist_name.to_string(),
        music_name: PLAYLIST_PREPARING_MESSAGE.to_string(),
        canonical_music_id: String::new(),
        music_url: String::new(),
        file_path: String::new(),
        start_ms: 0,
        end_ms: 0,
        liked: false,
    }
    .emit(app)?;

    Ok(())
}

pub(crate) fn create_start_anchor_playback_queue(
    initial_track: PlaybackTrack,
) -> Vec<PlaybackTrack> {
    vec![initial_track]
}

#[cfg(not(test))]
fn propose_playlist_playback_queue_after_exclude_with_logging(
    request: PlaylistPlaybackRecommendationRequest,
) -> Vec<PlaybackTrack> {
    propose_playlist_playback_queue_with_mode(
        request,
        PlaylistPlaybackRecommendationMode::ExcludeCurrent,
        true,
    )
}

#[derive(Clone, Copy)]
pub(crate) enum PlaylistPlaybackRecommendationMode {
    KeepCurrent,
    ExcludeCurrent,
}

impl PlaylistPlaybackRecommendationMode {
    #[cfg(not(test))]
    fn as_str(self) -> &'static str {
        match self {
            Self::KeepCurrent => "keep_current",
            Self::ExcludeCurrent => "exclude_current",
        }
    }
}

#[cfg(not(test))]
fn propose_playlist_playback_queue_with_mode(
    request: PlaylistPlaybackRecommendationRequest,
    mode: PlaylistPlaybackRecommendationMode,
    should_log_selection: bool,
) -> Vec<PlaybackTrack> {
    let unavailable_request = request.clone();
    let result = try_propose_audio_style_playlist_playback_queue(request, mode);
    match result {
        Ok(Some(proposal)) => {
            if should_log_selection {
                log_playlist_playback_next_track_selection(
                    "audio_style",
                    mode,
                    proposal.tracks.as_slice(),
                    proposal
                        .selection
                        .as_ref()
                        .map(PlaylistPlaybackSelectionTrace::from),
                );
            }
            proposal.tracks
        }
        Ok(None) => propose_unavailable_audio_style_playlist_playback_queue(
            unavailable_request,
            mode,
            should_log_selection,
        ),
        Err(error) => {
            eprintln!("[playlist_playback] audio style recommendation unavailable: {error}");
            propose_unavailable_audio_style_playlist_playback_queue(
                unavailable_request,
                mode,
                should_log_selection,
            )
        }
    }
}

#[cfg(not(test))]
fn propose_unavailable_audio_style_playlist_playback_queue(
    request: PlaylistPlaybackRecommendationRequest,
    mode: PlaylistPlaybackRecommendationMode,
    should_log_selection: bool,
) -> Vec<PlaybackTrack> {
    match mode {
        PlaylistPlaybackRecommendationMode::KeepCurrent => {
            propose_playlist_playback_queue_without_audio_style_model(request, mode)
        }
        PlaylistPlaybackRecommendationMode::ExcludeCurrent => {
            let proposal = propose_random_playlist_playback_queue_with_trace(request, mode);
            if should_log_selection {
                log_playlist_playback_next_track_selection(
                    "random",
                    mode,
                    proposal.tracks.as_slice(),
                    proposal.selection,
                );
            }
            proposal.tracks
        }
    }
}

#[cfg(not(test))]
fn try_propose_audio_style_playlist_playback_queue(
    request: PlaylistPlaybackRecommendationRequest,
    mode: PlaylistPlaybackRecommendationMode,
) -> Result<Option<AudioStylePlaylistPlaybackProposal>> {
    let Some(snapshot) = published_audio_style_model_snapshot() else {
        return Ok(None);
    };
    let recommender = snapshot.recommender();

    if recommender.has_embedding_for(&request.current_track) {
        let mut proposal = match mode {
            PlaylistPlaybackRecommendationMode::KeepCurrent => recommender
                .propose_queue_with_trace_and_recent_history(
                    request.current_track,
                    request.candidates,
                    &request.recently_played_tracks,
                ),
            PlaylistPlaybackRecommendationMode::ExcludeCurrent => recommender
                .propose_queue_after_exclude_with_trace_and_recent_history(
                    request.current_track,
                    request.candidates,
                    &request.recently_played_tracks,
                ),
        };
        if let Some(selection) = proposal.selection.as_mut() {
            selection.model_generation = Some(snapshot.generation());
        }
        if !audio_style_playlist_playback_proposal_is_complete(
            mode,
            proposal.tracks.as_slice(),
            proposal
                .selection
                .as_ref()
                .map(|selection| selection.source),
        ) {
            return Ok(None);
        }
        return Ok(Some(proposal));
    }

    Ok(None)
}

pub(crate) fn playlist_playback_proposal_contains_next_track(
    mode: PlaylistPlaybackRecommendationMode,
    tracks: &[PlaybackTrack],
) -> bool {
    match mode {
        PlaylistPlaybackRecommendationMode::KeepCurrent => {
            let Some(current) = tracks.first() else {
                return false;
            };
            tracks
                .iter()
                .skip(1)
                .any(|track| !are_playlist_playback_tracks_equal(track, current))
        }
        PlaylistPlaybackRecommendationMode::ExcludeCurrent => !tracks.is_empty(),
    }
}

pub(crate) fn audio_style_playlist_playback_proposal_is_complete(
    mode: PlaylistPlaybackRecommendationMode,
    tracks: &[PlaybackTrack],
    selection_source: Option<AudioStyleCandidateSelectionSource>,
) -> bool {
    if matches!(mode, PlaylistPlaybackRecommendationMode::KeepCurrent)
        && selection_source
            .is_some_and(|source| source != AudioStyleCandidateSelectionSource::AudioStyle)
    {
        return false;
    }

    playlist_playback_proposal_contains_next_track(mode, tracks)
}

pub(crate) fn propose_playlist_playback_queue_without_audio_style_model(
    request: PlaylistPlaybackRecommendationRequest,
    mode: PlaylistPlaybackRecommendationMode,
) -> Vec<PlaybackTrack> {
    match mode {
        PlaylistPlaybackRecommendationMode::KeepCurrent => {
            create_start_anchor_playback_queue(request.current_track)
        }
        PlaylistPlaybackRecommendationMode::ExcludeCurrent => {
            RandomPlaylistPlaybackRecommender.propose_queue_after_exclude(request)
        }
    }
}

#[cfg(not(test))]
fn propose_random_playlist_playback_queue_with_trace(
    request: PlaylistPlaybackRecommendationRequest,
    mode: PlaylistPlaybackRecommendationMode,
) -> PlaylistPlaybackQueueProposal {
    let mut request = request.with_recent_history_applied();
    let current_track = request.current_track.clone();
    let candidates = request.candidates.clone();
    let candidate_count = candidates
        .iter()
        .filter(|candidate| !are_playlist_playback_tracks_equal(candidate, &current_track))
        .count();
    request.recently_played_tracks.clear();
    let tracks = match mode {
        PlaylistPlaybackRecommendationMode::KeepCurrent => {
            RandomPlaylistPlaybackRecommender.propose_queue(request)
        }
        PlaylistPlaybackRecommendationMode::ExcludeCurrent => {
            RandomPlaylistPlaybackRecommender.propose_queue_after_exclude(request)
        }
    };
    let selection = next_track_for_recommendation_mode(mode, tracks.as_slice()).map(|track| {
        let selected_occurrences = candidates
            .iter()
            .filter(|candidate| are_playlist_playback_tracks_equal(candidate, track))
            .count();
        let probability = if candidate_count == 0 {
            0.0
        } else {
            selected_occurrences as f32 / candidate_count as f32
        };
        PlaylistPlaybackSelectionTrace {
            source: "random",
            reason: None,
            probability,
            uniform_probability: probability,
            similarity: None,
            best_similarity: None,
            local_rank_fraction: None,
            draw_unit: None,
            candidate_count,
            model_generation: None,
        }
    });
    PlaylistPlaybackQueueProposal { tracks, selection }
}

#[cfg(not(test))]
struct PlaylistPlaybackQueueProposal {
    tracks: Vec<PlaybackTrack>,
    selection: Option<PlaylistPlaybackSelectionTrace>,
}

#[cfg(not(test))]
struct PlaylistPlaybackSelectionTrace {
    source: &'static str,
    reason: Option<&'static str>,
    probability: f32,
    uniform_probability: f32,
    similarity: Option<f32>,
    best_similarity: Option<f32>,
    local_rank_fraction: Option<f32>,
    draw_unit: Option<f32>,
    candidate_count: usize,
    model_generation: Option<u64>,
}

#[cfg(not(test))]
impl From<&AudioStyleCandidateSelection> for PlaylistPlaybackSelectionTrace {
    fn from(selection: &AudioStyleCandidateSelection) -> Self {
        Self {
            source: selection.source.as_str(),
            reason: selection.reason,
            probability: selection.probability,
            uniform_probability: selection.uniform_probability,
            similarity: selection.similarity,
            best_similarity: selection.best_similarity,
            local_rank_fraction: selection.local_rank_fraction,
            draw_unit: Some(selection.draw_unit),
            candidate_count: selection.candidate_count,
            model_generation: selection.model_generation,
        }
    }
}

#[cfg(not(test))]
fn log_playlist_playback_next_track_selection(
    requested_source: &'static str,
    mode: PlaylistPlaybackRecommendationMode,
    tracks: &[PlaybackTrack],
    selection: Option<PlaylistPlaybackSelectionTrace>,
) {
    let next_track = next_track_for_recommendation_mode(mode, tracks);
    let Some(next_track) = next_track else {
        return;
    };
    let trace = selection;
    let source = trace
        .as_ref()
        .map(|trace| trace.source)
        .unwrap_or(requested_source);
    let reason = trace
        .as_ref()
        .and_then(|trace| trace.reason)
        .unwrap_or("none");
    let probability = trace.as_ref().map(|trace| trace.probability).unwrap_or(0.0);
    let uniform_probability = trace
        .as_ref()
        .map(|trace| trace.uniform_probability)
        .unwrap_or(0.0);
    let similarity = trace
        .as_ref()
        .and_then(|trace| trace.similarity)
        .map(|similarity| format!("{similarity:.6}"))
        .unwrap_or_else(|| "none".to_string());
    let best_similarity = trace
        .as_ref()
        .and_then(|trace| trace.best_similarity)
        .map(|similarity| format!("{similarity:.6}"))
        .unwrap_or_else(|| "none".to_string());
    let local_rank_fraction = trace
        .as_ref()
        .and_then(|trace| trace.local_rank_fraction)
        .map(|rank| format!("{rank:.6}"))
        .unwrap_or_else(|| "none".to_string());
    let candidate_count = trace
        .as_ref()
        .map(|trace| trace.candidate_count)
        .unwrap_or(0);
    let draw = trace
        .as_ref()
        .and_then(|trace| trace.draw_unit)
        .map(|draw| format!("{draw:.6}"))
        .unwrap_or_else(|| "none".to_string());
    let model_generation = trace
        .as_ref()
        .and_then(|trace| trace.model_generation)
        .map(|generation| generation.to_string())
        .unwrap_or_else(|| "none".to_string());

    println!(
        "[playlist_playback] next track selected source={source} requested_source={requested_source} mode={} model_generation={model_generation} probability={probability:.6} uniform_probability={uniform_probability:.6} similarity={similarity} best_similarity={best_similarity} local_rank_fraction={local_rank_fraction} draw={draw} candidates={candidate_count} reason={reason} playlist=\"{}\" music=\"{}\" url=\"{}\" range={}..{} file=\"{}\"",
        mode.as_str(),
        escape_log_value(&next_track.playlist_name),
        escape_log_value(&next_track.music_name),
        escape_log_value(&next_track.music_url),
        next_track.start_ms,
        next_track.end_ms,
        escape_log_value(&next_track.file_path.display().to_string()),
    );
}

#[cfg(not(test))]
fn next_track_for_recommendation_mode(
    mode: PlaylistPlaybackRecommendationMode,
    tracks: &[PlaybackTrack],
) -> Option<&PlaybackTrack> {
    match mode {
        PlaylistPlaybackRecommendationMode::KeepCurrent => tracks.get(1),
        PlaylistPlaybackRecommendationMode::ExcludeCurrent => tracks.first(),
    }
}

#[cfg(not(test))]
fn escape_log_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
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

        let key = playlist_playback_track_source_key(&source);
        if !seen.insert(key) {
            continue;
        }

        playable += 1;
        tracks.push(project_playlist_playback_track(
            selection, &source, file_path,
        ));
    }

    PlaylistTrackResolution {
        tracks,
        failure_description: format!(
            "playlist `{}` does not contain any playable tracks [selected_collection_refs={}, selected_group_refs={}, selected_extra_refs={}, checked_sources={}, playable={}, missing_path={}, missing_file={}, save_root={}]",
            selection.playlist_name,
            selection.collections.len(),
            selection.groups.len(),
            selection.extra.len(),
            source_count,
            playable,
            missing_path,
            missing_file,
            save_root.display()
        ),
    }
}

fn resolve_playlist_playback_source_track(
    selection: &PlaylistPlaybackSelection,
    source: PlaylistPlaybackTrackSource,
    save_root: &Path,
) -> Option<PlaybackTrack> {
    let file_path = resolve_source_music_file_path(save_root, &source)?;
    if !file_path.is_file() {
        return None;
    }

    Some(project_playlist_playback_track(
        selection, &source, file_path,
    ))
}

fn project_playlist_playback_track(
    selection: &PlaylistPlaybackSelection,
    source: &PlaylistPlaybackTrackSource,
    file_path: PathBuf,
) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: selection.playlist_name.clone(),
        music_name: source.music.alias.clone(),
        canonical_music_id: source.music.canonical_music_id.clone(),
        music_url: source.music.url.clone(),
        file_path,
        source_music: Some(Box::new(source.music.clone())),
        start_ms: source.music.start_ms,
        end_ms: source.music.end_ms,
        liked: source.music.liked,
    }
}

fn playlist_playback_track_source_key(source: &PlaylistPlaybackTrackSource) -> String {
    format!(
        "{}:{}:{}",
        source.music.url, source.music.start_ms, source.music.end_ms
    )
}

#[cfg(test)]
pub(crate) fn place_track_at_queue_start(
    mut tracks: Vec<PlaybackTrack>,
    anchor: &PlaybackTrack,
) -> Vec<PlaybackTrack> {
    let Some(anchor_index) = tracks
        .iter()
        .position(|track| are_playlist_playback_tracks_equal(track, anchor))
    else {
        let mut anchored = Vec::with_capacity(tracks.len() + 1);
        anchored.push(anchor.clone());
        anchored.extend(tracks);
        return anchored;
    };

    if anchor_index != 0 {
        tracks.swap(0, anchor_index);
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

#[derive(Clone)]
pub(crate) struct PlaylistPlaybackRecommendationRequest {
    pub(crate) playlist_name: String,
    pub(crate) current_track: PlaybackTrack,
    pub(crate) candidates: Vec<PlaybackTrack>,
    pub(crate) recently_played_tracks: Vec<PlaybackTrack>,
}

impl PlaylistPlaybackRecommendationRequest {
    fn with_recent_history_applied(mut self) -> Self {
        self.candidates = filter_recently_played_recommendation_candidates(
            self.candidates,
            &self.recently_played_tracks,
        );
        self
    }
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
        request = request.with_recent_history_applied();
        let tracks = &mut request.candidates;
        shuffle_playback_tracks(tracks);
        create_short_playback_queue(request.current_track, request.candidates)
    }
}

impl RandomPlaylistPlaybackRecommender {
    pub(crate) fn propose_queue_after_exclude(
        &self,
        mut request: PlaylistPlaybackRecommendationRequest,
    ) -> Vec<PlaybackTrack> {
        request = request.with_recent_history_applied();
        propose_random_queue_after_exclude(&mut request.candidates, &request.current_track)
    }
}

pub(crate) fn propose_random_queue_after_exclude(
    candidates: &mut Vec<PlaybackTrack>,
    current_track: &PlaybackTrack,
) -> Vec<PlaybackTrack> {
    candidates.retain(|candidate| !are_playlist_playback_tracks_equal(candidate, current_track));
    shuffle_playback_tracks(candidates);
    candidates.drain(..).take(1).collect()
}

pub(crate) fn create_short_playback_queue(
    current_track: PlaybackTrack,
    candidates: Vec<PlaybackTrack>,
) -> Vec<PlaybackTrack> {
    let mut queue = Vec::with_capacity(2);
    queue.push(current_track.clone());
    if let Some(next) = candidates
        .into_iter()
        .find(|candidate| !are_playlist_playback_tracks_equal(candidate, &current_track))
    {
        queue.push(next);
    }
    queue
}

pub(crate) fn shuffle_playback_tracks(tracks: &mut [PlaybackTrack]) {
    let mut rng = rand::rng();
    let len = tracks.len();
    for index in (1..len).rev() {
        let swap_index = rng.random_range(0..=index);
        tracks.swap(index, swap_index);
    }
}
