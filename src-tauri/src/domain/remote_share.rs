use crate::domain::player::model::PlaybackTrack;
use crate::domain::playlist_playback::service::{
    PlaylistPlaybackRecommendationMode, PlaylistPlaybackRecommendationRequest,
    consume_prepared_playlist_initial_track, load_random_playlist_playback_tracks,
    propose_playlist_playback_queue_with_mode,
};
use crate::domain::playlists::model::PlayListListView;
use crate::domain::playlists::repo as playlist_repo;
use anyhow::{Result, anyhow};
use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::net::TcpListener;
use tokio_util::io::ReaderStream;
use tower_http::cors::{Any, CorsLayer};

const REMOTE_SHARE_LOG_TARGET: &str = "remote_share";
const DEV_PAIRING_CODE: &str = "123456";
const REMOTE_SHARE_PORT: u16 = 48_231;
const REMOTE_AUDIO_CHUNK_SIZE: u64 = 256 * 1024;
const REMOTE_CANDIDATE_WINDOW_LIMIT: usize = 96;

static REMOTE_SHARE_RUNTIME: OnceLock<Arc<RemoteShareRuntime>> = OnceLock::new();
type RemoteResult<T> = std::result::Result<T, RemoteShareError>;

#[derive(Clone)]
struct RemoteShareRuntime {
    app: AppHandle,
    session: Arc<Mutex<RemoteShareSession>>,
}

#[derive(Default)]
struct RemoteShareSession {
    connected: bool,
    playlist_name: Option<String>,
    current: Option<PlaybackTrack>,
    queue: VecDeque<PlaybackTrack>,
    recently_played: Vec<PlaybackTrack>,
    state: RemotePlaybackState,
    audio_tokens: HashMap<String, RemoteAudioToken>,
    next_token_id: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RemotePlaybackState {
    #[default]
    Ready,
    Preparing,
    Playing,
}

#[derive(Clone)]
struct RemoteAudioToken {
    track: PlaybackTrack,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteConnectRequest {
    code: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteConnectResponse {
    connected: bool,
    code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteStartRequest {
    code: String,
    playlist_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCodeRequest {
    code: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteBootstrapResponse {
    code: String,
    connected: bool,
    playlists: Vec<PlayListListView>,
    session: RemoteSessionView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHealthResponse {
    service: &'static str,
    status: &'static str,
    code: &'static str,
    remote_page: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSessionView {
    state: RemotePlaybackState,
    playlist_name: Option<String>,
    current: Option<RemoteTrackView>,
    queue_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemotePlaybackResponse {
    session: RemoteSessionView,
    playback: Option<RemotePlaybackCargo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemotePlaybackCargo {
    track: RemoteTrackView,
    audio_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTrackView {
    playlist_name: String,
    title: String,
    canonical_music_id: String,
    music_url: String,
    start_ms: u32,
    end_ms: u32,
    duration_ms: u32,
}

pub fn initialize_runtime(app: AppHandle) {
    let runtime = Arc::new(RemoteShareRuntime {
        app,
        session: Arc::new(Mutex::new(RemoteShareSession::default())),
    });
    if REMOTE_SHARE_RUNTIME.set(Arc::clone(&runtime)).is_err() {
        log::warn!(
            target: REMOTE_SHARE_LOG_TARGET,
            "remote_share_runtime_init_skipped reason=already_initialized"
        );
        return;
    }

    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve_remote_share_gateway(runtime).await {
            log::error!(
                target: REMOTE_SHARE_LOG_TARGET,
                "remote_share_gateway_failed error=\"{}\"",
                error
            );
        }
    });
}

async fn serve_remote_share_gateway(runtime: Arc<RemoteShareRuntime>) -> Result<()> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), REMOTE_SHARE_PORT);
    let app = Router::new()
        .route("/", get(remote_share_health))
        .route("/api/connect", post(connect_remote_share))
        .route("/api/bootstrap", get(bootstrap_remote_share))
        .route("/api/session/start", post(start_remote_session))
        .route("/api/session/next", post(next_remote_track))
        .route("/api/session/stop", post(stop_remote_session))
        .route("/api/audio/{token}", get(stream_remote_audio))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST])
                .allow_headers(Any),
        )
        .with_state(runtime);
    let listener = TcpListener::bind(addr).await?;
    log::info!(
        target: REMOTE_SHARE_LOG_TARGET,
        "remote_share_gateway_started addr=\"{}\" dev_code=\"{}\"",
        addr,
        DEV_PAIRING_CODE
    );
    axum::serve(listener, app).await?;
    Ok(())
}

async fn remote_share_health() -> Json<RemoteHealthResponse> {
    Json(RemoteHealthResponse {
        service: "slisic_remote_share",
        status: "ok",
        code: DEV_PAIRING_CODE,
        remote_page: "http://127.0.0.1:4177/remote",
    })
}

async fn connect_remote_share(
    State(runtime): State<Arc<RemoteShareRuntime>>,
    Json(request): Json<RemoteConnectRequest>,
) -> RemoteResult<Json<RemoteConnectResponse>> {
    ensure_dev_code(&request.code)?;
    let mut session = runtime.lock_session()?;
    session.connected = true;
    Ok(Json(RemoteConnectResponse {
        connected: true,
        code: DEV_PAIRING_CODE.to_string(),
    }))
}

async fn bootstrap_remote_share(
    State(runtime): State<Arc<RemoteShareRuntime>>,
) -> RemoteResult<Json<RemoteBootstrapResponse>> {
    let playlists = playlist_repo::list_playlists().await?;
    let session = runtime.session_view()?;
    Ok(Json(RemoteBootstrapResponse {
        code: DEV_PAIRING_CODE.to_string(),
        connected: session_connected(&runtime)?,
        playlists,
        session,
    }))
}

async fn start_remote_session(
    State(runtime): State<Arc<RemoteShareRuntime>>,
    Json(request): Json<RemoteStartRequest>,
) -> RemoteResult<Json<RemotePlaybackResponse>> {
    ensure_dev_code(&request.code)?;
    {
        let mut session = runtime.lock_session()?;
        session.connected = true;
        session.playlist_name = Some(request.playlist_name.clone());
        session.current = None;
        session.queue.clear();
        session.recently_played.clear();
        session.state = RemotePlaybackState::Preparing;
        session.audio_tokens.clear();
    }

    let initial = match resolve_remote_initial_track(&runtime.app, &request.playlist_name).await {
        Ok(track) => track,
        Err(error) => {
            runtime.reset_to_ready()?;
            return Err(error.into());
        }
    };
    let queue = match propose_remote_next_queue(&runtime.app, &initial, &[]).await {
        Ok(queue) => queue,
        Err(error) => {
            runtime.reset_to_ready()?;
            return Err(error.into());
        }
    };
    let playback = runtime.commit_playback(request.playlist_name, initial, queue)?;
    Ok(Json(playback))
}

async fn next_remote_track(
    State(runtime): State<Arc<RemoteShareRuntime>>,
    Json(request): Json<RemoteCodeRequest>,
) -> RemoteResult<Json<RemotePlaybackResponse>> {
    ensure_dev_code(&request.code)?;
    let (playlist_name, current, recent_history) = {
        let mut session = runtime.lock_session()?;
        let Some(next) = session.queue.pop_front() else {
            session.current = None;
            session.state = RemotePlaybackState::Ready;
            session.audio_tokens.clear();
            let response = RemotePlaybackResponse {
                session: session.view(),
                playback: None,
            };
            return Ok(Json(response));
        };
        let playlist_name = next.playlist_name.clone();
        session.current = Some(next.clone());
        observe_remote_recent_track(&mut session.recently_played, next.clone());
        session.state = RemotePlaybackState::Playing;
        (playlist_name, next, session.recently_played.clone())
    };

    let queue = propose_remote_next_queue(&runtime.app, &current, &recent_history).await?;
    let playback = runtime.commit_playback(playlist_name, current, queue)?;
    Ok(Json(playback))
}

async fn stop_remote_session(
    State(runtime): State<Arc<RemoteShareRuntime>>,
    Json(request): Json<RemoteCodeRequest>,
) -> RemoteResult<Json<RemoteSessionView>> {
    ensure_dev_code(&request.code)?;
    let mut session = runtime.lock_session()?;
    session.current = None;
    session.queue.clear();
    session.state = RemotePlaybackState::Ready;
    session.audio_tokens.clear();
    Ok(Json(session.view()))
}

async fn stream_remote_audio(
    State(runtime): State<Arc<RemoteShareRuntime>>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> RemoteResult<Response> {
    let token = {
        let session = runtime.lock_session()?;
        session
            .audio_tokens
            .get(&token)
            .cloned()
            .ok_or(RemoteShareError::not_found("audio token not found"))?
    };
    stream_file_with_range(token.track.file_path, headers).await
}

async fn resolve_remote_initial_track(app: &AppHandle, playlist_name: &str) -> Result<PlaybackTrack> {
    if let Some(track) = consume_prepared_playlist_initial_track(app, playlist_name).await? {
        return Ok(track);
    }

    load_random_playlist_playback_tracks(app, playlist_name, REMOTE_CANDIDATE_WINDOW_LIMIT)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("playlist `{playlist_name}` has no playable remote tracks"))
}

async fn propose_remote_next_queue(
    app: &AppHandle,
    current: &PlaybackTrack,
    recently_played: &[PlaybackTrack],
) -> Result<Vec<PlaybackTrack>> {
    let candidates =
        load_random_playlist_playback_tracks(app, &current.playlist_name, REMOTE_CANDIDATE_WINDOW_LIMIT)
            .await?;
    let request = PlaylistPlaybackRecommendationRequest {
        playlist_name: current.playlist_name.clone(),
        current_track: current.clone(),
        candidates,
        recently_played_tracks: recently_played.to_vec(),
    };
    let queue = propose_playlist_playback_queue_with_mode(
        request,
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        true,
    );
    Ok(if queue.get(1).is_some() {
        queue
    } else {
        Vec::new()
    })
}

impl RemoteShareRuntime {
    fn lock_session(&self) -> RemoteResult<std::sync::MutexGuard<'_, RemoteShareSession>> {
        self.session
            .lock()
            .map_err(|_| RemoteShareError::internal("remote share session lock is poisoned"))
    }

    fn session_view(&self) -> RemoteResult<RemoteSessionView> {
        Ok(self.lock_session()?.view())
    }

    fn reset_to_ready(&self) -> RemoteResult<()> {
        let mut session = self.lock_session()?;
        session.current = None;
        session.queue.clear();
        session.state = RemotePlaybackState::Ready;
        session.audio_tokens.clear();
        Ok(())
    }

    fn commit_playback(
        &self,
        playlist_name: String,
        current: PlaybackTrack,
        queue: Vec<PlaybackTrack>,
    ) -> RemoteResult<RemotePlaybackResponse> {
        let mut session = self.lock_session()?;
        session.playlist_name = Some(playlist_name);
        session.current = Some(current.clone());
        session.queue = queue
            .into_iter()
            .filter(|track| !same_remote_track(track, &current))
            .collect();
        observe_remote_recent_track(&mut session.recently_played, current.clone());
        session.state = RemotePlaybackState::Playing;
        let token = session.create_audio_token(current.clone());
        let playback = RemotePlaybackCargo {
            track: RemoteTrackView::from_track(&current),
            audio_url: format!("/api/audio/{token}"),
        };
        Ok(RemotePlaybackResponse {
            session: session.view(),
            playback: Some(playback),
        })
    }
}

impl RemoteShareSession {
    fn view(&self) -> RemoteSessionView {
        RemoteSessionView {
            state: self.state,
            playlist_name: self.playlist_name.clone(),
            current: self.current.as_ref().map(RemoteTrackView::from_track),
            queue_count: self.queue.len(),
        }
    }

    fn create_audio_token(&mut self, track: PlaybackTrack) -> String {
        self.next_token_id = self.next_token_id.saturating_add(1);
        let token = format!("dev-{}", self.next_token_id);
        self.audio_tokens
            .insert(token.clone(), RemoteAudioToken { track });
        token
    }
}

impl RemoteTrackView {
    fn from_track(track: &PlaybackTrack) -> Self {
        Self {
            playlist_name: track.playlist_name.clone(),
            title: track.music_name.clone(),
            canonical_music_id: track.canonical_music_id.clone(),
            music_url: track.music_url.clone(),
            start_ms: track.start_ms,
            end_ms: track.end_ms,
            duration_ms: track.end_ms.saturating_sub(track.start_ms),
        }
    }
}

fn session_connected(runtime: &RemoteShareRuntime) -> RemoteResult<bool> {
    Ok(runtime.lock_session()?.connected)
}

fn ensure_dev_code(code: &str) -> RemoteResult<()> {
    if code == DEV_PAIRING_CODE {
        Ok(())
    } else {
        Err(RemoteShareError::unauthorized("invalid remote share code"))
    }
}

fn observe_remote_recent_track(history: &mut Vec<PlaybackTrack>, track: PlaybackTrack) {
    history.retain(|item| !same_remote_track(item, &track));
    history.push(track);
    const MAX_RECENT_HISTORY: usize = 48;
    if history.len() > MAX_RECENT_HISTORY {
        let excess = history.len() - MAX_RECENT_HISTORY;
        history.drain(0..excess);
    }
}

fn same_remote_track(left: &PlaybackTrack, right: &PlaybackTrack) -> bool {
    left.canonical_music_id == right.canonical_music_id
        || (left.music_url == right.music_url
            && left.start_ms == right.start_ms
            && left.end_ms == right.end_ms)
}

async fn stream_file_with_range(path: PathBuf, headers: HeaderMap) -> RemoteResult<Response> {
    let mut file = File::open(&path)
        .await
        .map_err(|_| RemoteShareError::not_found("audio file not found"))?;
    let file_len = file
        .metadata()
        .await
        .map_err(|error| RemoteShareError::internal(error.to_string()))?
        .len();
    if file_len == 0 {
        return Err(RemoteShareError::internal("empty audio file"));
    }

    let range = headers
        .get(RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_single_http_range(value, file_len));
    let (start, end, status) = match range {
        Some((start, end)) => (start, end, StatusCode::PARTIAL_CONTENT),
        None => (0, file_len - 1, StatusCode::OK),
    };
    let len = end.saturating_sub(start).saturating_add(1);
    file.seek(SeekFrom::Start(start))
        .await
        .map_err(|error| RemoteShareError::internal(error.to_string()))?;
    let stream = ReaderStream::with_capacity(file.take(len), REMOTE_AUDIO_CHUNK_SIZE as usize);

    let mut response = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "audio/mp4")
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_LENGTH, len.to_string());
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(
            CONTENT_RANGE,
            format!("bytes {start}-{end}/{file_len}"),
        );
    }
    response
        .body(Body::from_stream(stream))
        .map_err(|error| RemoteShareError::internal(error.to_string()))
}

fn parse_single_http_range(value: &str, file_len: u64) -> Option<(u64, u64)> {
    let range = value.strip_prefix("bytes=")?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        file_len - 1
    } else {
        end.parse::<u64>().ok()?.min(file_len - 1)
    };
    (start <= end && start < file_len).then_some((start, end))
}

#[derive(Debug)]
struct RemoteShareError {
    status: StatusCode,
    message: String,
}

impl RemoteShareError {
    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl From<anyhow::Error> for RemoteShareError {
    fn from(error: anyhow::Error) -> Self {
        Self::internal(error.to_string())
    }
}

impl From<surrealdb::Error> for RemoteShareError {
    fn from(error: surrealdb::Error) -> Self {
        Self::internal(error.to_string())
    }
}

impl IntoResponse for RemoteShareError {
    fn into_response(self) -> Response {
        let body = Json(serde_json::json!({
            "error": self.message,
        }));
        let mut response = body.into_response();
        *response.status_mut() = self.status;
        response.headers_mut().insert(
            "cache-control",
            HeaderValue::from_static("no-store, max-age=0"),
        );
        response
    }
}
