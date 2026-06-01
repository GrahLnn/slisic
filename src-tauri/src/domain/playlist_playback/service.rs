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
    PlaybackDiagnosticTraceDetail, PlaybackDiagnosticTraceEvent, PlaybackExcludeCommittedEvent,
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
    AudioStyleCandidateSelection, initialize_audio_style_recommendation_runtime,
    notify_audio_style_library_inputs_changed, published_audio_style_model_snapshot,
    published_audio_style_model_snapshots_for_anchor,
};
use crate::domain::playlist_playback::recommendation::{
    AudioStyleCandidateSelectionSource, AudioStyleModelSnapshot,
    AudioStylePlaylistPlaybackProposal, filter_recently_played_recommendation_candidates,
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
#[cfg(not(test))]
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(not(test))]
use std::sync::Mutex;
#[cfg(not(test))]
use std::time::Instant;
#[cfg(not(test))]
use tauri::AppHandle;
#[cfg(not(test))]
use tauri_specta::Event;

#[cfg(not(test))]
const INITIAL_PLAYBACK_QUEUE_LIMIT: usize = 256;
#[cfg(not(test))]
const INITIAL_PLAYBACK_FALLBACK_MAX_SOURCE_LIMIT: usize = 8192;
#[cfg(not(test))]
const PLAYLIST_PLAYBACK_IMMEDIATE_RECOVERY_SOURCE_LIMIT: usize = 16;
#[cfg(not(test))]
const PLAYLIST_PLAYBACK_RANDOM_WINDOW_LIMIT: usize = 96;
#[cfg(not(test))]
const PLAYLIST_PLAYBACK_QUEUE_REFRESH_INTERVAL_MS: u64 = 250;
#[cfg(not(test))]
const PLAYLIST_PLAYBACK_LIKED_CANDIDATE_LIMIT: usize = 128;

#[cfg(not(test))]
type SharedPlaylistPlaybackRecentHistory = Arc<Mutex<PlaylistPlaybackRecentHistory>>;
#[cfg(not(test))]
type SharedPlaylistPlaybackQueueRefreshGate = Arc<tokio::sync::Mutex<()>>;

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
pub(crate) fn notify_music_library_inputs_changed(reason: &'static str) {
    notify_audio_style_library_inputs_changed(reason);
}

#[cfg(not(test))]
pub(crate) fn notify_playable_library_changed() {
    playable_index::notify_library_changed(
        playable_index::PlayableIndexRefreshReason::LibraryChanged,
    );
}

#[cfg(not(test))]
struct PlaylistPlaybackTrace<'a> {
    app: &'a AppHandle,
    playlist_name: Option<&'a str>,
    track: Option<&'a PlaybackTrack>,
    elapsed_ms: Option<u128>,
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
        candidate_count: None,
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
        Ok(Some(material)) => material,
        Ok(None) => {
            emit_playlist_playback_trace(
                "playlist-play-backend-pending-first-track",
                PlaylistPlaybackTrace::new(app)
                    .playlist_name(&name)
                    .elapsed(trace_start)
                    .status("pending_first_track"),
            );
            return Ok(PlayPlaylistSession {
                status: PlayPlaylistSessionStatus::PendingFirstTrack,
                playlist_name: name,
                session_generation: None,
                track_count: 0,
            });
        }
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
    let initial_prepared_source = material.initial_prepared_source;
    let recent_history = PlaylistPlaybackRecentHistory::from_initial_track(initial_track.clone());
    let tracks = material.tracks;
    let track_count = tracks.len() as u32;
    let shared_recent_history = Arc::new(Mutex::new(recent_history));
    let queue_refresh_gate = Arc::new(tokio::sync::Mutex::new(()));

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
            consume_playlist_initial_prepared_source(&initial_prepared_source);
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
    let session_generation = session.session_generation;
    spawn_playlist_track_queue_fill(
        app.clone(),
        playlist_name.clone(),
        session.clone(),
        initial_track.clone(),
        Arc::clone(&shared_recent_history),
        Arc::clone(&queue_refresh_gate),
    );
    spawn_playlist_track_refresh(
        app.clone(),
        playlist_name.clone(),
        session,
        initial_track,
        download_changes,
        shared_recent_history,
        queue_refresh_gate,
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
        session_generation: Some(session_generation),
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
    PlaybackExcludeCommittedEvent {
        exclude: exclude_result.exclude.clone(),
        exclude_availability: exclude_result.exclude_availability.clone(),
    }
    .emit(app)?;
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
        PLAYLIST_PLAYBACK_IMMEDIATE_RECOVERY_SOURCE_LIMIT,
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
    initial_prepared_source: Option<playable_index::PlaylistPlayableIndexSnapshot>,
    tracks: Vec<PlaybackTrack>,
}

#[cfg(not(test))]
struct PlaylistTrackResolutionSource {
    selection: PlaylistPlaybackSelection,
    playlist_name: String,
    resolution: PlaylistTrackResolution,
    source_count: usize,
}

#[cfg(not(test))]
struct ResolvedPlaylistInitialTrack {
    track: PlaybackTrack,
    prepared_source: Option<playable_index::PlaylistPlayableIndexSnapshot>,
}

pub(crate) struct PlaylistTrackResolution {
    pub(crate) tracks: Vec<PlaybackTrack>,
    #[cfg(test)]
    pub(crate) failure_description: String,
}

#[cfg(test)]
#[derive(Default)]
struct PlaylistTrackResolutionStats {
    source_count: usize,
    playable: usize,
    missing_path: usize,
    missing_file: usize,
}

#[cfg(not(test))]
#[derive(Default)]
struct PlaylistTrackResolutionStats;

#[cfg(test)]
impl PlaylistTrackResolutionStats {
    fn observe_source(&mut self) {
        self.source_count += 1;
    }

    fn observe_missing_path(&mut self) {
        self.missing_path += 1;
    }

    fn observe_missing_file(&mut self) {
        self.missing_file += 1;
    }

    fn observe_playable(&mut self) {
        self.playable += 1;
    }
}

#[cfg(not(test))]
impl PlaylistTrackResolutionStats {
    fn observe_source(&mut self) {}

    fn observe_missing_path(&mut self) {}

    fn observe_missing_file(&mut self) {}

    fn observe_playable(&mut self) {}
}

#[cfg(not(test))]
async fn build_playlist_playback_material(
    app: &AppHandle,
    playlist_name: &str,
    request: &player_service::PlaybackStartRequestHandle,
    _download_changes: &mut tokio::sync::broadcast::Receiver<
        download_service::DownloadTaskChangeSignal,
    >,
) -> Result<Option<PlaylistPlaybackMaterial>> {
    let trace_start = Instant::now();
    if let Some(initial) = resolve_prepared_playlist_initial_track(app, playlist_name).await? {
        let tracks = create_start_anchor_playback_queue(initial.track.clone());
        ensure_playlist_playback_request_current(request)?;
        emit_playlist_playback_trace(
            "playlist-play-material-prepared-initial-track-ok",
            PlaylistPlaybackTrace::new(app)
                .playlist_name(playlist_name)
                .track(&initial.track)
                .elapsed(trace_start)
                .queue_count(tracks.len()),
        );
        return Ok(Some(PlaylistPlaybackMaterial {
            playlist_name: playlist_name.to_string(),
            initial_prepared_source: initial.prepared_source,
            initial_track: initial.track,
            tracks,
        }));
    }

    let source = load_initial_playlist_track_resolution(app, playlist_name).await?;
    if let Some(initial_track) = source.resolution.tracks.into_iter().next() {
        let tracks = create_start_anchor_playback_queue(initial_track.clone());
        ensure_playlist_playback_request_current(request)?;
        emit_playlist_playback_trace(
            "playlist-play-material-immediate-track-ok",
            PlaylistPlaybackTrace::new(app)
                .playlist_name(playlist_name)
                .track(&initial_track)
                .elapsed(trace_start)
                .queue_count(tracks.len())
                .status("prepared_first_slot_recovered"),
        );
        return Ok(Some(PlaylistPlaybackMaterial {
            playlist_name: playlist_name.to_string(),
            initial_prepared_source: None,
            initial_track,
            tracks,
        }));
    }

    let has_relevant_active_downloads =
        playlist_selection_has_active_downloads(&source.selection).await?;
    emit_playlist_playback_trace(
        "playlist-play-material-prepared-initial-track-miss",
        PlaylistPlaybackTrace::new(app)
            .playlist_name(playlist_name)
            .elapsed(trace_start)
            .status(if has_relevant_active_downloads {
                "pending_first_track"
            } else {
                "no_playable_track"
            }),
    );
    playable_index::notify_playback_miss(playlist_name);
    if has_relevant_active_downloads {
        Ok(None)
    } else {
        bail!("playlist `{playlist_name}` has no playable tracks")
    }
}

#[cfg(not(test))]
async fn resolve_prepared_playlist_initial_track(
    app: &AppHandle,
    playlist_name: &str,
) -> Result<Option<ResolvedPlaylistInitialTrack>> {
    let trace_start = Instant::now();
    let save_root = meta_service::resolve_save_root(app).await?;
    let Some(selection) = playlist_repo::get_playlist_playback_selection_by_name(playlist_name).await?
    else {
        return Ok(None);
    };
    loop {
        let Some(snapshot) = playable_index::read_playlist_source(playlist_name)? else {
            return Ok(None);
        };
        let Some(source) = snapshot.source.clone() else {
            if let Err(error) = playable_index::discard_playlist_source(&snapshot) {
                eprintln!(
                    "[playlist_playback] failed to discard empty prepared first track source playlist=\"{}\" generation={}: {error}",
                    snapshot.playlist_name, snapshot.generation
                );
            }
            continue;
        };
        if !selection.contains_track_source(&source) {
            if let Err(error) = playable_index::discard_playlist_source(&snapshot) {
                eprintln!(
                    "[playlist_playback] failed to discard out-of-scope prepared first track source playlist=\"{}\" generation={}: {error}",
                    snapshot.playlist_name, snapshot.generation
                );
            }
            continue;
        }
        let Some(track) =
            resolve_playlist_playback_source_track_for_playlist(playlist_name, source, &save_root)
        else {
            if let Err(error) = playable_index::discard_playlist_source(&snapshot) {
                eprintln!(
                    "[playlist_playback] failed to discard unplayable prepared first track source playlist=\"{}\" generation={}: {error}",
                    snapshot.playlist_name, snapshot.generation
                );
            }
            continue;
        };

        emit_playlist_playback_trace(
            "playlist-play-initial-prepared-hit",
            PlaylistPlaybackTrace::new(app)
                .playlist_name(playlist_name)
                .track(&track)
                .elapsed(trace_start)
                .details(vec![
                    trace_detail("indexStatus", "hit"),
                    trace_detail("indexGeneration", snapshot.generation),
                ]),
        );
        return Ok(Some(ResolvedPlaylistInitialTrack {
            track,
            prepared_source: Some(snapshot),
        }));
    }
}

#[cfg(not(test))]
fn consume_playlist_initial_prepared_source(
    prepared_source: &Option<playable_index::PlaylistPlayableIndexSnapshot>,
) {
    if let Some(snapshot) = prepared_source
        && let Err(error) = playable_index::consume_playlist_source(snapshot)
    {
        eprintln!(
            "[playlist_playback] failed to consume prepared first track source playlist=\"{}\" generation={}: {error}",
            snapshot.playlist_name, snapshot.generation
        );
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
    initial_track: PlaybackTrack,
    recent_history: SharedPlaylistPlaybackRecentHistory,
    queue_refresh_gate: SharedPlaylistPlaybackQueueRefreshGate,
) {
    let task_playlist_name = playlist_name.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = fill_playlist_track_queue(
            app,
            playlist_name,
            session,
            initial_track,
            recent_history,
            queue_refresh_gate,
        )
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
    queue_refresh_gate: SharedPlaylistPlaybackQueueRefreshGate,
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
            queue_refresh_gate,
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
    queue_refresh_gate: SharedPlaylistPlaybackQueueRefreshGate,
) -> Result<()> {
    let mut current_anchor: Option<PlaybackTrack> = None;
    loop {
        if !player_service::is_session_current(&session)? {
            return Ok(());
        }

        let active_track = resolve_playlist_playback_queue_anchor(&session, &initial_track).await?;
        let recent_history_snapshot =
            observe_playlist_playback_recent_history(&recent_history, active_track.clone())?;
        let queue_has_next = current_session_queue_contains_next(&session, &active_track)?;
        if should_refresh_playlist_queue_for_anchor_after_startup(
            current_anchor.as_ref(),
            &active_track,
            queue_has_next,
        ) {
            let _guard = queue_refresh_gate.lock().await;
            if current_session_queue_contains_next(&session, &active_track)? {
                current_anchor = Some(active_track);
                tokio::time::sleep(std::time::Duration::from_millis(
                    PLAYLIST_PLAYBACK_QUEUE_REFRESH_INTERVAL_MS,
                ))
                .await;
                continue;
            }
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

pub(crate) fn should_refresh_playlist_queue_for_anchor_after_startup(
    current_anchor: Option<&PlaybackTrack>,
    active_track: &PlaybackTrack,
    queue_has_next: bool,
) -> bool {
    current_anchor.is_some_and(|anchor| !are_playlist_playback_tracks_equal(anchor, active_track))
        || should_refresh_playlist_queue_for_same_anchor(queue_has_next)
}

pub(crate) fn should_refresh_playlist_queue_for_same_anchor(queue_has_next: bool) -> bool {
    !queue_has_next
}

#[cfg(not(test))]
fn current_session_queue_contains_next(
    session: &player_service::PlaybackSessionHandle,
    active_track: &PlaybackTrack,
) -> Result<bool> {
    if !player_service::is_session_current(session)? {
        return Ok(false);
    }

    Ok(playlist_playback_queue_contains_next_track_after_anchor(
        &player_service::current_session_tracks_snapshot()?,
        active_track,
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
    queue_refresh_gate: SharedPlaylistPlaybackQueueRefreshGate,
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
            if !should_refresh_playlist_queue_for_same_anchor(current_session_queue_contains_next(
                &session,
                &current_track,
            )?) {
                if !has_relevant_active_downloads {
                    return Ok(());
                }
                continue;
            }
            let recent_history_snapshot =
                observe_playlist_playback_recent_history(&recent_history, current_track.clone())?;
            let _guard = queue_refresh_gate.lock().await;
            if !should_refresh_playlist_queue_for_same_anchor(current_session_queue_contains_next(
                &session,
                &current_track,
            )?) {
                if !has_relevant_active_downloads {
                    return Ok(());
                }
                continue;
            }
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
    let readiness = audio_style_playlist_queue_readiness_for_anchor(&current_track);
    if !readiness.is_ready() {
        emit_playlist_playback_trace(
            "playlist-playback-next-slot-waiting-for-model",
            PlaylistPlaybackTrace::new(app)
                .playlist_name(playlist_name)
                .track(&current_track)
                .status(readiness.diagnostic_status()),
        );
    }

    let source = load_random_playlist_track_resolution_window(
        app,
        playlist_name,
        PLAYLIST_PLAYBACK_RANDOM_WINDOW_LIMIT,
    )
    .await?;
    if source.resolution.tracks.is_empty() {
        emit_playlist_playback_trace(
            "playlist-playback-next-slot-empty-candidates",
            PlaylistPlaybackTrace::new(app)
                .playlist_name(playlist_name)
                .track(&current_track)
                .status("empty_candidate_window"),
        );
        return Ok(true);
    }

    if !player_service::is_session_current(session)? {
        return Ok(false);
    }

    let tracks = propose_playlist_playback_queue_with_mode(
        PlaylistPlaybackRecommendationRequest {
            playlist_name: playlist_name.to_string(),
            current_track: current_track.clone(),
            candidates: source.resolution.tracks,
            recently_played_tracks: recently_played_tracks.to_vec(),
        },
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        should_log_selection,
    );
    if !should_commit_playlist_queue_refresh(
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        &tracks,
    ) {
        emit_playlist_playback_trace(
            "playlist-playback-next-slot-not-ready",
            PlaylistPlaybackTrace::new(app)
                .playlist_name(playlist_name)
                .track(&current_track)
                .queue_count(tracks.len())
                .status("missing_next"),
        );
        return Ok(true);
    }
    player_service::update_session_tracks(session, tracks)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaylistQueueRecommendationReadinessStatus {
    Ready,
    ModelUnavailable,
    MissingCurrentEmbedding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PlaylistQueueRecommendationReadiness {
    status: PlaylistQueueRecommendationReadinessStatus,
    model_generation: Option<u64>,
}

impl PlaylistQueueRecommendationReadiness {
    pub(crate) fn ready(model_generation: u64) -> Self {
        Self {
            status: PlaylistQueueRecommendationReadinessStatus::Ready,
            model_generation: Some(model_generation),
        }
    }

    pub(crate) fn model_unavailable() -> Self {
        Self {
            status: PlaylistQueueRecommendationReadinessStatus::ModelUnavailable,
            model_generation: None,
        }
    }

    pub(crate) fn missing_current_embedding(model_generation: u64) -> Self {
        Self {
            status: PlaylistQueueRecommendationReadinessStatus::MissingCurrentEmbedding,
            model_generation: Some(model_generation),
        }
    }

    fn is_ready(self) -> bool {
        self.status == PlaylistQueueRecommendationReadinessStatus::Ready
    }

    pub(crate) fn diagnostic_status(self) -> &'static str {
        match self.status {
            PlaylistQueueRecommendationReadinessStatus::Ready => "playlist_playback_ready",
            PlaylistQueueRecommendationReadinessStatus::ModelUnavailable => {
                "playlist_playback_model_unavailable"
            }
            PlaylistQueueRecommendationReadinessStatus::MissingCurrentEmbedding => {
                "playlist_playback_missing_current_embedding"
            }
        }
    }
}

#[cfg(not(test))]
fn audio_style_playlist_queue_readiness_for_anchor(
    current_track: &PlaybackTrack,
) -> PlaylistQueueRecommendationReadiness {
    let Some(snapshot) = published_audio_style_model_snapshot() else {
        return PlaylistQueueRecommendationReadiness::model_unavailable();
    };

    if snapshot.recommender().has_embedding_for(current_track) {
        PlaylistQueueRecommendationReadiness::ready(snapshot.generation())
    } else {
        PlaylistQueueRecommendationReadiness::missing_current_embedding(snapshot.generation())
    }
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
    let source_count = sources.len();
    let sources = merge_playlist_playback_track_sources(sources, liked_sources);
    let resolution = resolve_playlist_playback_source_resolution(&selection, sources, &save_root);

    Ok(PlaylistTrackResolutionSource {
        playlist_name: selection.playlist_name.clone(),
        selection,
        source_count,
        resolution,
    })
}

#[cfg(not(test))]
async fn load_initial_playlist_track_resolution(
    app: &AppHandle,
    playlist_name: &str,
) -> Result<PlaylistTrackResolutionSource> {
    let mut limit = INITIAL_PLAYBACK_QUEUE_LIMIT;
    loop {
        let source = load_playlist_track_resolution_window(app, playlist_name, limit).await?;
        if !source.resolution.tracks.is_empty()
            || source.source_count < limit
            || limit >= INITIAL_PLAYBACK_FALLBACK_MAX_SOURCE_LIMIT
        {
            return Ok(source);
        }

        limit = (limit * 2).min(INITIAL_PLAYBACK_FALLBACK_MAX_SOURCE_LIMIT);
    }
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
    let source_count = sources.len();
    let sources = merge_playlist_playback_track_sources(sources, liked_sources);
    let resolution = resolve_playlist_playback_source_resolution(&selection, sources, &save_root);

    Ok(PlaylistTrackResolutionSource {
        playlist_name: selection.playlist_name.clone(),
        selection,
        source_count,
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

#[cfg(not(test))]
fn try_propose_audio_style_playlist_playback_queue(
    request: PlaylistPlaybackRecommendationRequest,
    mode: PlaylistPlaybackRecommendationMode,
) -> Result<Option<AudioStylePlaylistPlaybackProposal>> {
    let snapshots = published_audio_style_model_snapshots_for_anchor(&request.current_track);
    Ok(propose_audio_style_playlist_playback_queue_from_snapshots(
        request, mode, snapshots,
    ))
}

pub(crate) fn propose_audio_style_playlist_playback_queue_from_snapshots(
    request: PlaylistPlaybackRecommendationRequest,
    mode: PlaylistPlaybackRecommendationMode,
    snapshots: impl IntoIterator<Item = Arc<AudioStyleModelSnapshot>>,
) -> Option<AudioStylePlaylistPlaybackProposal> {
    for snapshot in snapshots {
        let proposal =
            propose_audio_style_playlist_playback_queue_from_snapshot(&request, mode, snapshot);
        if proposal.is_some() {
            return proposal;
        }
    }

    None
}

fn propose_audio_style_playlist_playback_queue_from_snapshot(
    request: &PlaylistPlaybackRecommendationRequest,
    mode: PlaylistPlaybackRecommendationMode,
    snapshot: Arc<AudioStyleModelSnapshot>,
) -> Option<AudioStylePlaylistPlaybackProposal> {
    let recommender = snapshot.recommender();
    let anchor_has_embedding = snapshot.has_embedding_for(&request.current_track);

    let mut proposal = match mode {
        PlaylistPlaybackRecommendationMode::KeepCurrent => {
            if anchor_has_embedding {
                recommender.propose_queue_with_trace_and_recent_history(
                    request.current_track.clone(),
                    request.candidates.clone(),
                    &request.recently_played_tracks,
                )
            } else {
                recommender.propose_centerless_queue_with_trace_and_recent_history(
                    request.current_track.clone(),
                    request.candidates.clone(),
                    &request.recently_played_tracks,
                )
            }
        }
        PlaylistPlaybackRecommendationMode::ExcludeCurrent => recommender
            .propose_queue_after_exclude_with_trace_and_recent_history(
                request.current_track.clone(),
                request.candidates.clone(),
                &request.recently_played_tracks,
            ),
    };
    if let Some(selection) = proposal.selection.as_mut() {
        selection.model_generation = Some(snapshot.generation());
    }
    let selection_source = proposal.selection.as_ref().map(|selection| selection.source);
    let selection_is_centerless_fallback = matches!(
        (mode, anchor_has_embedding, selection_source),
        (
            PlaylistPlaybackRecommendationMode::KeepCurrent,
            false,
            Some(AudioStyleCandidateSelectionSource::RandomFallback)
        )
    );
    let proposal_is_complete = if selection_is_centerless_fallback {
        playlist_playback_proposal_contains_next_track(mode, proposal.tracks.as_slice())
    } else {
        audio_style_playlist_playback_proposal_is_complete(
            mode,
            proposal.tracks.as_slice(),
            selection_source,
        )
    };
    if !proposal_is_complete
    {
        return None;
    }

    Some(proposal)
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

pub(crate) fn playlist_playback_queue_contains_next_track_after_anchor(
    tracks: &[PlaybackTrack],
    anchor: &PlaybackTrack,
) -> bool {
    let Some(anchor_index) = tracks
        .iter()
        .position(|track| are_playlist_playback_tracks_equal(track, anchor))
    else {
        return false;
    };

    tracks
        .iter()
        .skip(anchor_index + 1)
        .any(|track| !are_playlist_playback_tracks_equal(track, anchor))
}

pub(crate) fn should_commit_playlist_queue_refresh(
    mode: PlaylistPlaybackRecommendationMode,
    tracks: &[PlaybackTrack],
) -> bool {
    playlist_playback_proposal_contains_next_track(mode, tracks)
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
            RandomPlaylistPlaybackRecommender.propose_queue(request)
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
    let tracks = propose_playlist_playback_queue_without_audio_style_model(request, mode);
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
            anchor_embedded: false,
            embedded_candidate_count: 0,
            valid_similarity_count: 0,
            selected_basin: None,
            top_candidate_basins: "none".to_string(),
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
    anchor_embedded: bool,
    embedded_candidate_count: usize,
    valid_similarity_count: usize,
    selected_basin: Option<String>,
    top_candidate_basins: String,
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
            anchor_embedded: selection.diagnostics.anchor_embedded,
            embedded_candidate_count: selection.diagnostics.embedded_candidate_count,
            valid_similarity_count: selection.diagnostics.valid_similarity_count,
            selected_basin: selection.diagnostics.selected_basin.clone(),
            top_candidate_basins: format_audio_style_candidate_basins(
                &selection.diagnostics.top_candidate_basins,
            ),
        }
    }
}

#[cfg(not(test))]
fn format_audio_style_candidate_basins(
    basins: &[super::recommendation::AudioStyleCandidateBasinDiagnostics],
) -> String {
    if basins.is_empty() {
        return "none".to_string();
    }

    let mut text = String::new();
    for basin in basins {
        if !text.is_empty() {
            text.push('|');
        }
        let _ = write!(
            text,
            "{}:{}/{}",
            escape_log_value(&basin.basin),
            basin.embedded_candidate_count,
            basin.candidate_count
        );
    }
    text
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
    let anchor_embedded = trace
        .as_ref()
        .map(|trace| trace.anchor_embedded.to_string())
        .unwrap_or_else(|| "none".to_string());
    let embedded_candidate_count = trace
        .as_ref()
        .map(|trace| trace.embedded_candidate_count.to_string())
        .unwrap_or_else(|| "none".to_string());
    let valid_similarity_count = trace
        .as_ref()
        .map(|trace| trace.valid_similarity_count.to_string())
        .unwrap_or_else(|| "none".to_string());
    let selected_basin = trace
        .as_ref()
        .and_then(|trace| trace.selected_basin.as_ref())
        .map(|basin| escape_log_value(basin))
        .unwrap_or_else(|| "none".to_string());
    let candidate_basin_top = trace
        .as_ref()
        .map(|trace| trace.top_candidate_basins.as_str())
        .unwrap_or("none");

    println!(
        "[playlist_playback] next track selected source={source} requested_source={requested_source} mode={} model_generation={model_generation} probability={probability:.6} uniform_probability={uniform_probability:.6} similarity={similarity} best_similarity={best_similarity} local_rank_fraction={local_rank_fraction} draw={draw} candidates={candidate_count} anchor_embedded={anchor_embedded} embedded_candidates={embedded_candidate_count} valid_similarities={valid_similarity_count} selected_basin=\"{selected_basin}\" candidate_basin_top=\"{candidate_basin_top}\" reason={reason} playlist=\"{}\" music=\"{}\" url=\"{}\" range={}..{} file=\"{}\"",
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
    let mut stats = PlaylistTrackResolutionStats::default();

    for source in sources {
        stats.observe_source();
        let Some(file_path) = resolve_source_music_file_path(save_root, &source) else {
            stats.observe_missing_path();
            continue;
        };
        if !file_path.is_file() {
            stats.observe_missing_file();
            continue;
        }

        let key = playlist_playback_track_source_key(&source);
        if !seen.insert(key) {
            continue;
        }

        stats.observe_playable();
        tracks.push(project_playlist_playback_track(
            selection, &source, file_path,
        ));
    }

    #[cfg(test)]
    let failure_description = format!(
        "playlist `{}` does not contain any playable tracks [selected_collection_refs={}, selected_group_refs={}, selected_extra_refs={}, checked_sources={}, playable={}, missing_path={}, missing_file={}, save_root={}]",
        selection.playlist_name,
        selection.collections.len(),
        selection.groups.len(),
        selection.extra.len(),
        stats.source_count,
        stats.playable,
        stats.missing_path,
        stats.missing_file,
        save_root.display()
    );

    PlaylistTrackResolution {
        tracks,
        #[cfg(test)]
        failure_description,
    }
}

fn resolve_playlist_playback_source_track(
    selection: &PlaylistPlaybackSelection,
    source: PlaylistPlaybackTrackSource,
    save_root: &Path,
) -> Option<PlaybackTrack> {
    resolve_playlist_playback_source_track_for_playlist(&selection.playlist_name, source, save_root)
}

fn resolve_playlist_playback_source_track_for_playlist(
    playlist_name: &str,
    source: PlaylistPlaybackTrackSource,
    save_root: &Path,
) -> Option<PlaybackTrack> {
    let file_path = resolve_source_music_file_path(save_root, &source)?;
    if !file_path.is_file() {
        return None;
    }

    Some(project_playlist_playback_track_for_playlist(
        playlist_name,
        &source,
        file_path,
    ))
}

fn project_playlist_playback_track(
    selection: &PlaylistPlaybackSelection,
    source: &PlaylistPlaybackTrackSource,
    file_path: PathBuf,
) -> PlaybackTrack {
    project_playlist_playback_track_for_playlist(&selection.playlist_name, source, file_path)
}

pub(crate) fn project_playlist_playback_track_for_playlist(
    playlist_name: &str,
    source: &PlaylistPlaybackTrackSource,
    file_path: PathBuf,
) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: playlist_name.to_string(),
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

pub(crate) fn resolve_source_music_file_path(
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
