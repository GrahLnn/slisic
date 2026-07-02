use crate::domain::player::model::PlaybackTrack;
use crate::domain::player::service::{PlaybackLoudnessPlan, playback_loudness_plan_for_profile};
use crate::domain::playlist_playback::service::{
    PlaylistPlaybackRecommendationMode, PlaylistPlaybackRecommendationRequest,
};
#[cfg(not(test))]
use crate::domain::playlist_playback::service::{
    consume_prepared_playlist_initial_track, load_random_playlist_playback_tracks,
    propose_playlist_playback_queue_with_mode,
};
use crate::domain::playlists::model::PlayListListView;
use crate::domain::playlists::repo as playlist_repo;
use crate::utils::binaries::{ManagedBinary, acquire_managed_binary_usage, ensure_managed_binary};
use anyhow::{Result, anyhow};
use appdb::Store;
use appdb::error::{DBError, classify_db_error};
use appdb::model::meta::ModelMeta;
use appdb::repository::Repo;
use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use rand::RngExt;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::collections::{HashMap, VecDeque};
use std::fs as std_fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};
use surrealdb::types::RecordId;
use surrealdb_types::SurrealValue;
use tauri::{AppHandle, Manager};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::task;
use tokio::time::{MissedTickBehavior, interval, sleep};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::io::ReaderStream;
use tower_http::cors::{Any, CorsLayer};

const REMOTE_SHARE_LOG_TARGET: &str = "remote_share";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const REMOTE_SHARE_SETTINGS_RECORD_KEY: &str = "singleton";
const REMOTE_PAIRING_CODE_MAX_LEN: usize = 8;
const REMOTE_PAIRING_CODE_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const REMOTE_SHARE_PORT: u16 = 48_231;
const REMOTE_AUDIO_CHUNK_SIZE: u64 = 256 * 1024;
const REMOTE_AUDIO_CACHE_DIR: &str = "remote-audio";
const REMOTE_AUDIO_GAIN_EPSILON_DB: f32 = 0.001;
const REMOTE_CANDIDATE_WINDOW_LIMIT: usize = 96;
const REMOTE_PREFETCH_FRONTIER_LIMIT: usize = 3;
const REMOTE_RELAY_HOST_URL_ENV: &str = "SLISIC_REMOTE_RELAY_HOST_URL";
const DEFAULT_REMOTE_RELAY_HOST_URL: &str = "wss://slisic-remote.grahlnn.com/ws/host";
const REMOTE_RELAY_RECONNECT_DELAY: Duration = Duration::from_secs(5);
const REMOTE_RELAY_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const REMOTE_RELAY_IDLE_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const DEFAULT_REMOTE_CLIENT_ID: &str = "local";

static REMOTE_SHARE_RUNTIME: OnceLock<Arc<RemoteShareRuntime>> = OnceLock::new();
type RemoteResult<T> = std::result::Result<T, RemoteShareError>;
type RemoteRelayEventSender = UnboundedSender<String>;

#[derive(Clone)]
struct RemoteShareRuntime {
    app: AppHandle,
    settings: Arc<Mutex<RemoteShareSettings>>,
    sessions: Arc<Mutex<RemoteShareSessions>>,
    remote_audio_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

#[derive(Clone)]
struct RemoteShareSettings {
    enabled: bool,
    code: String,
    enabled_configured_by_user: bool,
}

impl Default for RemoteShareSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            code: generate_remote_pairing_code(),
            enabled_configured_by_user: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, SurrealValue, Store)]
struct PersistedRemoteShareSettings {
    enabled: bool,
    code: String,
    #[serde(default)]
    enabled_configured_by_user: bool,
}

impl From<PersistedRemoteShareSettings> for RemoteShareSettings {
    fn from(value: PersistedRemoteShareSettings) -> Self {
        Self {
            enabled: value.enabled_configured_by_user && value.enabled,
            code: normalize_remote_pairing_code(&value.code)
                .unwrap_or_else(|_| generate_remote_pairing_code()),
            enabled_configured_by_user: value.enabled_configured_by_user,
        }
    }
}

impl From<RemoteShareSettings> for PersistedRemoteShareSettings {
    fn from(value: RemoteShareSettings) -> Self {
        Self {
            enabled: value.enabled,
            code: value.code,
            enabled_configured_by_user: value.enabled_configured_by_user,
        }
    }
}

#[derive(Default)]
struct RemoteShareSessions {
    by_client: HashMap<String, RemoteShareSession>,
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

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteShareStatus {
    enabled: bool,
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

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum RemoteRelayInbound {
    Hello {
        role: String,
        code: String,
    },
    PeerState {
        host_connected: bool,
        client_connected: bool,
    },
    RpcRequest {
        id: String,
        method: String,
        #[serde(default)]
        client_id: Option<String>,
        #[serde(default)]
        params: serde_json::Value,
    },
    AudioRequest {
        id: String,
        #[serde(default)]
        client_id: Option<String>,
        token: String,
        range: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum RemoteRelayOutbound {
    RpcResponse {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    AudioResponse {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content_type: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content_length: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content_range: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        accept_ranges: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        body_base64: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    SessionPrefetchReady {
        client_id: String,
        frontier: Vec<RemotePlaybackCargo>,
    },
    HostPing {},
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
    code: String,
    enabled: bool,
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
    prefetch: Option<RemotePlaybackCargo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemotePlaybackCargo {
    track: RemoteTrackView,
    audio_url: String,
    loudness_plan: Option<RemoteLoudnessPlanView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteLoudnessPlanView {
    integrated_lufs: f32,
    true_peak_dbtp: Option<f32>,
    lra: Option<f32>,
    base_gain_db: f32,
    final_gain_db: f32,
    target_lufs: f32,
    reason: &'static str,
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

struct RemoteAudioRelayCargo {
    status: StatusCode,
    content_type: &'static str,
    content_length: u64,
    content_range: Option<String>,
    accept_ranges: &'static str,
    body: Vec<u8>,
}

struct RemoteNextQueueCommit {
    frontier: Vec<RemotePlaybackCargo>,
    prewarm_tracks: Vec<PlaybackTrack>,
}

pub async fn initialize_runtime(app: AppHandle) -> Result<()> {
    install_remote_tls_crypto_provider();
    let settings = ensure_remote_share_settings()
        .await
        .map_err(|error| anyhow!(error.message))?;

    let runtime = Arc::new(RemoteShareRuntime {
        app,
        settings: Arc::new(Mutex::new(settings)),
        sessions: Arc::new(Mutex::new(RemoteShareSessions::default())),
        remote_audio_locks: Arc::new(Mutex::new(HashMap::new())),
    });
    if REMOTE_SHARE_RUNTIME.set(Arc::clone(&runtime)).is_err() {
        log::warn!(
            target: REMOTE_SHARE_LOG_TARGET,
            "remote_share_runtime_init_skipped reason=already_initialized"
        );
        return Ok(());
    }

    let gateway_runtime = Arc::clone(&runtime);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve_remote_share_gateway(gateway_runtime).await {
            log::error!(
                target: REMOTE_SHARE_LOG_TARGET,
                "remote_share_gateway_failed error=\"{}\"",
                error
            );
        }
    });

    tauri::async_runtime::spawn(run_remote_relay_host(runtime));
    Ok(())
}

fn install_remote_tls_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
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
        .with_state(Arc::clone(&runtime));
    let listener = TcpListener::bind(addr).await?;
    log::info!(
        target: REMOTE_SHARE_LOG_TARGET,
        "remote_share_gateway_started addr=\"{}\" code_len={}",
        addr,
        runtime
            .status()
            .map_err(|error| anyhow!(error.message))?
            .code
            .len()
    );
    axum::serve(listener, app).await?;
    Ok(())
}

async fn run_remote_relay_host(runtime: Arc<RemoteShareRuntime>) {
    loop {
        let status = match runtime.status() {
            Ok(status) => status,
            Err(error) => {
                log::warn!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_share_relay_state_failed error=\"{}\"",
                    error.message
                );
                sleep(REMOTE_RELAY_RECONNECT_DELAY).await;
                continue;
            }
        };
        if !status.enabled {
            sleep(REMOTE_RELAY_RECONNECT_DELAY).await;
            continue;
        }
        let url = remote_relay_host_url(&status.code);
        log::info!(
            target: REMOTE_SHARE_LOG_TARGET,
            "remote_share_relay_connecting url=\"{}\"",
            redact_remote_code_for_log(&url, &status.code)
        );
        match connect_async(&url).await {
            Ok((socket, _)) => {
                log::info!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_share_relay_connected url=\"{}\"",
                    redact_remote_code_for_log(&url, &status.code)
                );
                if let Err(error) =
                    serve_remote_relay_socket(Arc::clone(&runtime), socket, status.code).await
                {
                    log::warn!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_share_relay_disconnected error=\"{}\"",
                        error
                    );
                }
            }
            Err(error) => {
                log::warn!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_share_relay_connect_failed error=\"{}\"",
                    error
                );
            }
        }
        sleep(REMOTE_RELAY_RECONNECT_DELAY).await;
    }
}

async fn serve_remote_relay_socket(
    runtime: Arc<RemoteShareRuntime>,
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    active_code: String,
) -> Result<()> {
    let (mut sink, mut stream) = socket.split();
    let (outbound_tx, mut outbound_rx) = unbounded_channel::<String>();
    let connected_at = Instant::now();
    let mut client_connected = false;
    let mut last_logged_peer_state: Option<(bool, bool)> = None;
    let mut heartbeat = interval(REMOTE_RELAY_HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if !runtime
                    .relay_session_still_current(&active_code)
                    .map_err(|error| anyhow!(error.message))?
                {
                    return Err(anyhow!("remote relay share state changed"));
                }
                if !client_connected && connected_at.elapsed() >= REMOTE_RELAY_IDLE_REFRESH_INTERVAL {
                    return Err(anyhow!("remote relay idle connection refresh requested"));
                }
                let ping = serde_json::to_string(&RemoteRelayOutbound::HostPing {})?;
                sink.send(Message::Text(ping.into())).await?;
            }
            outbound = outbound_rx.recv() => {
                let Some(outbound) = outbound else {
                    return Err(anyhow!("remote relay outbound channel closed"));
                };
                sink.send(Message::Text(outbound.into())).await?;
            }
            message = stream.next() => {
                let Some(message) = message else {
                    return Ok(());
                };
                let message = message?;
                if !message.is_text() {
                    continue;
                }
                let text = message.into_text()?;
                if let Some((host_connected, next_client_connected)) = remote_relay_peer_state(&text) {
                    client_connected = next_client_connected;
                    let peer_state = (host_connected, next_client_connected);
                    if last_logged_peer_state != Some(peer_state) {
                        log::info!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_share_relay_peer_state host_connected={} client_connected={}",
                            host_connected,
                            next_client_connected
                        );
                        last_logged_peer_state = Some(peer_state);
                    }
                }
                let Some(response) = handle_remote_relay_message(
                    Arc::clone(&runtime),
                    &text,
                    outbound_tx.clone(),
                ).await else {
                    continue;
                };
                sink.send(Message::Text(response.into())).await?;
            }
        }
    }
}

fn remote_relay_peer_state(text: &str) -> Option<(bool, bool)> {
    match serde_json::from_str::<RemoteRelayInbound>(text).ok()? {
        RemoteRelayInbound::PeerState {
            host_connected,
            client_connected,
            ..
        } => Some((host_connected, client_connected)),
        _ => None,
    }
}

async fn handle_remote_relay_message(
    runtime: Arc<RemoteShareRuntime>,
    text: &str,
    relay_events: RemoteRelayEventSender,
) -> Option<String> {
    let inbound = match serde_json::from_str::<RemoteRelayInbound>(text) {
        Ok(inbound) => inbound,
        Err(error) => {
            log::warn!(
                target: REMOTE_SHARE_LOG_TARGET,
                "remote_share_relay_message_ignored reason=invalid_json error=\"{}\"",
                error
            );
            return None;
        }
    };

    let outbound = match inbound {
        RemoteRelayInbound::Hello { role, code } => {
            log::info!(
                target: REMOTE_SHARE_LOG_TARGET,
                "remote_share_relay_hello role=\"{}\" code_len={}",
                role,
                code.len()
            );
            return None;
        }
        RemoteRelayInbound::PeerState { .. } => {
            return None;
        }
        RemoteRelayInbound::RpcRequest {
            id,
            method,
            client_id,
            params,
        } => {
            handle_remote_relay_rpc(
                Arc::clone(&runtime),
                id,
                method,
                client_id,
                params,
                relay_events,
            )
            .await
        }
        RemoteRelayInbound::AudioRequest {
            id,
            client_id,
            token,
            range,
        } => handle_remote_relay_audio(runtime, id, client_id, token, range).await,
    };
    Some(serde_json::to_string(&outbound).unwrap_or_else(|error| {
        serde_json::json!({
            "kind": "rpc_response",
            "id": "serialization-error",
            "ok": false,
            "error": error.to_string(),
        })
        .to_string()
    }))
}

async fn handle_remote_relay_rpc(
    runtime: Arc<RemoteShareRuntime>,
    id: String,
    method: String,
    client_id: Option<String>,
    params: serde_json::Value,
    relay_events: RemoteRelayEventSender,
) -> RemoteRelayOutbound {
    let started = Instant::now();
    let client_id = normalize_remote_client_id(client_id.as_deref());
    log::info!(
        target: REMOTE_SHARE_LOG_TARGET,
        "remote_share_relay_rpc_received method=\"{}\" client_id_len={}",
        method,
        client_id.len()
    );
    let result = match method.as_str() {
        "connect" => parse_relay_params(params)
            .and_then(|request| relay_json(runtime.handle_connect(&client_id, request))),
        "bootstrap" => relay_json(runtime.handle_bootstrap(&client_id).await),
        "session.start" => match parse_relay_params(params) {
            Ok(request) => relay_json(
                runtime
                    .handle_start(&client_id, request, Some(relay_events))
                    .await,
            ),
            Err(error) => Err(error),
        },
        "session.next" => match parse_relay_params(params) {
            Ok(request) => relay_json(
                runtime
                    .handle_next(&client_id, request, Some(relay_events))
                    .await,
            ),
            Err(error) => Err(error),
        },
        "session.stop" => parse_relay_params(params)
            .and_then(|request| relay_json(runtime.handle_stop(&client_id, request))),
        _ => Err(RemoteShareError::not_found(format!(
            "unknown remote relay method `{method}`"
        ))),
    };

    let outbound = match result {
        Ok(data) => RemoteRelayOutbound::RpcResponse {
            id,
            ok: true,
            data: Some(data),
            error: None,
        },
        Err(error) => RemoteRelayOutbound::RpcResponse {
            id,
            ok: false,
            data: None,
            error: Some(error.message),
        },
    };
    log::info!(
        target: REMOTE_SHARE_LOG_TARGET,
        "remote_share_relay_rpc_finished method=\"{}\" ok={} elapsed_ms={}",
        method,
        matches!(outbound, RemoteRelayOutbound::RpcResponse { ok: true, .. }),
        started.elapsed().as_millis()
    );
    outbound
}

async fn handle_remote_relay_audio(
    runtime: Arc<RemoteShareRuntime>,
    id: String,
    client_id: Option<String>,
    token: String,
    range: Option<String>,
) -> RemoteRelayOutbound {
    let client_id = normalize_remote_client_id(client_id.as_deref());
    match runtime.handle_audio_relay(&client_id, token, range).await {
        Ok(cargo) => RemoteRelayOutbound::AudioResponse {
            id,
            ok: true,
            status: Some(cargo.status.as_u16()),
            content_type: Some(cargo.content_type),
            content_length: Some(cargo.content_length),
            content_range: cargo.content_range,
            accept_ranges: Some(cargo.accept_ranges),
            body_base64: Some(base64::engine::general_purpose::STANDARD.encode(cargo.body)),
            error: None,
        },
        Err(error) => RemoteRelayOutbound::AudioResponse {
            id,
            ok: false,
            status: Some(error.status.as_u16()),
            content_type: None,
            content_length: None,
            content_range: None,
            accept_ranges: None,
            body_base64: None,
            error: Some(error.message),
        },
    }
}

fn relay_json<T: Serialize>(result: RemoteResult<T>) -> RemoteResult<serde_json::Value> {
    result.and_then(|data| {
        serde_json::to_value(data).map_err(|error| RemoteShareError::internal(error.to_string()))
    })
}

fn parse_relay_params<T: DeserializeOwned>(params: serde_json::Value) -> RemoteResult<T> {
    serde_json::from_value(params)
        .map_err(|error| RemoteShareError::internal(format!("invalid relay params: {error}")))
}

fn remote_relay_host_url(code: &str) -> String {
    let base = std::env::var(REMOTE_RELAY_HOST_URL_ENV)
        .unwrap_or_else(|_| DEFAULT_REMOTE_RELAY_HOST_URL.to_string());
    let separator = if base.contains('?') { '&' } else { '?' };
    format!("{base}{separator}code={code}")
}

fn redact_remote_code_for_log(url: &str, code: &str) -> String {
    url.replace(code, "******")
}

async fn remote_share_health(
    State(runtime): State<Arc<RemoteShareRuntime>>,
) -> RemoteResult<Json<RemoteHealthResponse>> {
    let status = runtime.status()?;
    Ok(Json(RemoteHealthResponse {
        service: "slisic_remote_share",
        status: "ok",
        code: status.code,
        enabled: status.enabled,
        remote_page: "http://127.0.0.1:4177/remote",
    }))
}

#[tauri::command]
#[specta::specta]
pub fn get_remote_share_status() -> std::result::Result<RemoteShareStatus, String> {
    remote_runtime()?.status().map_err(|error| error.message)
}

#[tauri::command]
#[specta::specta]
pub async fn set_remote_share_enabled(
    enabled: bool,
) -> std::result::Result<RemoteShareStatus, String> {
    remote_runtime()?
        .set_enabled(enabled)
        .await
        .map_err(|error| error.message)
}

#[tauri::command]
#[specta::specta]
pub async fn set_remote_share_code(code: String) -> std::result::Result<RemoteShareStatus, String> {
    remote_runtime()?
        .set_code(code)
        .await
        .map_err(|error| error.message)
}

async fn connect_remote_share(
    State(runtime): State<Arc<RemoteShareRuntime>>,
    Json(request): Json<RemoteConnectRequest>,
) -> RemoteResult<Json<RemoteConnectResponse>> {
    Ok(Json(
        runtime.handle_connect(DEFAULT_REMOTE_CLIENT_ID, request)?,
    ))
}

async fn bootstrap_remote_share(
    State(runtime): State<Arc<RemoteShareRuntime>>,
) -> RemoteResult<Json<RemoteBootstrapResponse>> {
    Ok(Json(
        runtime.handle_bootstrap(DEFAULT_REMOTE_CLIENT_ID).await?,
    ))
}

async fn start_remote_session(
    State(runtime): State<Arc<RemoteShareRuntime>>,
    Json(request): Json<RemoteStartRequest>,
) -> RemoteResult<Json<RemotePlaybackResponse>> {
    Ok(Json(
        runtime
            .handle_start(DEFAULT_REMOTE_CLIENT_ID, request, None)
            .await?,
    ))
}

async fn next_remote_track(
    State(runtime): State<Arc<RemoteShareRuntime>>,
    Json(request): Json<RemoteCodeRequest>,
) -> RemoteResult<Json<RemotePlaybackResponse>> {
    Ok(Json(
        runtime
            .handle_next(DEFAULT_REMOTE_CLIENT_ID, request, None)
            .await?,
    ))
}

async fn stop_remote_session(
    State(runtime): State<Arc<RemoteShareRuntime>>,
    Json(request): Json<RemoteCodeRequest>,
) -> RemoteResult<Json<RemoteSessionView>> {
    Ok(Json(
        runtime.handle_stop(DEFAULT_REMOTE_CLIENT_ID, request)?,
    ))
}

async fn stream_remote_audio(
    State(runtime): State<Arc<RemoteShareRuntime>>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> RemoteResult<Response> {
    if !runtime.status()?.enabled {
        return Err(RemoteShareError::unauthorized("remote share is disabled"));
    }
    let audio_path = runtime
        .materialized_audio_path_for_token(DEFAULT_REMOTE_CLIENT_ID, token)
        .await?;
    stream_file_with_range(audio_path, headers).await
}

async fn resolve_remote_initial_track(
    app: &AppHandle,
    playlist_name: &str,
) -> Result<PlaybackTrack> {
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
    let candidates = load_random_playlist_playback_tracks(
        app,
        &current.playlist_name,
        REMOTE_CANDIDATE_WINDOW_LIMIT,
    )
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

#[cfg(test)]
async fn consume_prepared_playlist_initial_track(
    _app: &AppHandle,
    _playlist_name: &str,
) -> Result<Option<PlaybackTrack>> {
    Ok(None)
}

#[cfg(test)]
async fn load_random_playlist_playback_tracks(
    _app: &AppHandle,
    _playlist_name: &str,
    _limit: usize,
) -> Result<Vec<PlaybackTrack>> {
    Ok(Vec::new())
}

#[cfg(test)]
fn propose_playlist_playback_queue_with_mode(
    _request: PlaylistPlaybackRecommendationRequest,
    _mode: PlaylistPlaybackRecommendationMode,
    _should_log_selection: bool,
) -> Vec<PlaybackTrack> {
    Vec::new()
}

impl RemoteShareRuntime {
    fn lock_settings(&self) -> RemoteResult<std::sync::MutexGuard<'_, RemoteShareSettings>> {
        self.settings
            .lock()
            .map_err(|_| RemoteShareError::internal("remote share settings lock is poisoned"))
    }

    fn lock_sessions(&self) -> RemoteResult<std::sync::MutexGuard<'_, RemoteShareSessions>> {
        self.sessions
            .lock()
            .map_err(|_| RemoteShareError::internal("remote share sessions lock is poisoned"))
    }

    fn status(&self) -> RemoteResult<RemoteShareStatus> {
        let settings = self.lock_settings()?;
        Ok(RemoteShareStatus {
            enabled: settings.enabled,
            code: settings.code.clone(),
        })
    }

    fn relay_session_still_current(&self, active_code: &str) -> RemoteResult<bool> {
        let settings = self.lock_settings()?;
        Ok(settings.enabled && settings.code == active_code)
    }

    async fn set_enabled(&self, enabled: bool) -> RemoteResult<RemoteShareStatus> {
        let next_settings = {
            let settings = self.lock_settings()?;
            RemoteShareSettings {
                enabled,
                code: settings.code.clone(),
                enabled_configured_by_user: true,
            }
        };
        save_remote_share_settings(next_settings.clone()).await?;
        {
            let mut settings = self.lock_settings()?;
            *settings = next_settings;
        }
        if !enabled {
            self.clear_sessions()?;
        }
        self.status()
    }

    async fn set_code(&self, code: String) -> RemoteResult<RemoteShareStatus> {
        let code = normalize_remote_pairing_code(&code)?;
        let (next_settings, code_changed) = {
            let settings = self.lock_settings()?;
            (
                RemoteShareSettings {
                    enabled: settings.enabled,
                    code: code.clone(),
                    enabled_configured_by_user: settings.enabled_configured_by_user,
                },
                settings.code != code,
            )
        };
        if code_changed {
            save_remote_share_settings(next_settings.clone()).await?;
            {
                let mut settings = self.lock_settings()?;
                *settings = next_settings;
            }
        };
        if code_changed {
            self.clear_sessions()?;
        }
        self.status()
    }

    fn clear_sessions(&self) -> RemoteResult<()> {
        let mut sessions = self.lock_sessions()?;
        sessions.by_client.clear();
        Ok(())
    }

    fn ensure_code(&self, code: &str) -> RemoteResult<String> {
        let code = normalize_remote_pairing_code(code)?;
        let settings = self.lock_settings()?;
        if !settings.enabled {
            return Err(RemoteShareError::unauthorized("remote share is disabled"));
        }
        if settings.code == code {
            Ok(settings.code.clone())
        } else {
            Err(RemoteShareError::unauthorized("invalid remote share code"))
        }
    }

    fn session_view(&self, client_id: &str) -> RemoteResult<RemoteSessionView> {
        let sessions = self.lock_sessions()?;
        Ok(sessions
            .by_client
            .get(client_id)
            .map(RemoteShareSession::view)
            .unwrap_or_else(|| RemoteShareSession::default().view()))
    }

    fn handle_connect(
        &self,
        client_id: &str,
        request: RemoteConnectRequest,
    ) -> RemoteResult<RemoteConnectResponse> {
        let code = self.ensure_code(&request.code)?;
        let mut sessions = self.lock_sessions()?;
        sessions
            .by_client
            .entry(client_id.to_string())
            .or_default()
            .connected = true;
        Ok(RemoteConnectResponse {
            connected: true,
            code,
        })
    }

    async fn handle_bootstrap(&self, client_id: &str) -> RemoteResult<RemoteBootstrapResponse> {
        let playlists = playlist_repo::list_playlists().await?;
        let session = self.session_view(client_id)?;
        let status = self.status()?;
        Ok(RemoteBootstrapResponse {
            code: status.code,
            connected: status.enabled && session_connected(self, client_id)?,
            playlists,
            session,
        })
    }

    async fn handle_start(
        &self,
        client_id: &str,
        request: RemoteStartRequest,
        relay_events: Option<RemoteRelayEventSender>,
    ) -> RemoteResult<RemotePlaybackResponse> {
        self.ensure_code(&request.code)?;
        {
            let mut sessions = self.lock_sessions()?;
            let session = sessions.by_client.entry(client_id.to_string()).or_default();
            session.connected = true;
            session.playlist_name = Some(request.playlist_name.clone());
            session.current = None;
            session.queue.clear();
            session.recently_played.clear();
            session.state = RemotePlaybackState::Preparing;
            session.audio_tokens.clear();
        }

        let initial = match resolve_remote_initial_track(&self.app, &request.playlist_name).await {
            Ok(track) => track,
            Err(error) => {
                self.reset_to_ready(client_id)?;
                return Err(error.into());
            }
        };
        let response = self.commit_playback(
            client_id,
            request.playlist_name,
            initial.clone(),
            Vec::new(),
        )?;
        self.spawn_remote_next_queue_fill(client_id.to_string(), initial, Vec::new(), relay_events);
        Ok(response)
    }

    async fn handle_next(
        &self,
        client_id: &str,
        request: RemoteCodeRequest,
        relay_events: Option<RemoteRelayEventSender>,
    ) -> RemoteResult<RemotePlaybackResponse> {
        self.ensure_code(&request.code)?;
        let (playlist_name, current, recent_history) = {
            let mut sessions = self.lock_sessions()?;
            let session = sessions.by_client.entry(client_id.to_string()).or_default();
            let Some(next) = session.queue.pop_front() else {
                session.current = None;
                session.state = RemotePlaybackState::Ready;
                session.audio_tokens.clear();
                let response = RemotePlaybackResponse {
                    session: session.view(),
                    playback: None,
                    prefetch: None,
                };
                return Ok(response);
            };
            let playlist_name = next.playlist_name.clone();
            session.current = Some(next.clone());
            observe_remote_recent_track(&mut session.recently_played, next.clone());
            session.state = RemotePlaybackState::Playing;
            (playlist_name, next, session.recently_played.clone())
        };

        let response =
            self.commit_playback(client_id, playlist_name, current.clone(), Vec::new())?;
        self.spawn_remote_next_queue_fill(
            client_id.to_string(),
            current,
            recent_history,
            relay_events,
        );
        Ok(response)
    }

    fn handle_stop(
        &self,
        client_id: &str,
        request: RemoteCodeRequest,
    ) -> RemoteResult<RemoteSessionView> {
        self.ensure_code(&request.code)?;
        let mut sessions = self.lock_sessions()?;
        let session = sessions.by_client.entry(client_id.to_string()).or_default();
        session.current = None;
        session.queue.clear();
        session.state = RemotePlaybackState::Ready;
        session.audio_tokens.clear();
        Ok(session.view())
    }

    async fn handle_audio_relay(
        &self,
        client_id: &str,
        token: String,
        range: Option<String>,
    ) -> RemoteResult<RemoteAudioRelayCargo> {
        {
            let settings = self.lock_settings()?;
            if !settings.enabled {
                return Err(RemoteShareError::unauthorized("remote share is disabled"));
            }
        }
        let audio_path = self
            .materialized_audio_path_for_token(client_id, token)
            .await?;
        read_file_relay_chunk(audio_path, range.as_deref()).await
    }

    async fn materialized_audio_path_for_token(
        &self,
        client_id: &str,
        token: String,
    ) -> RemoteResult<PathBuf> {
        let token = {
            let sessions = self.lock_sessions()?;
            sessions
                .by_client
                .get(client_id)
                .ok_or(RemoteShareError::not_found(
                    "remote client session not found",
                ))?
                .audio_tokens
                .get(&token)
                .cloned()
                .ok_or(RemoteShareError::not_found("audio token not found"))?
        };
        self.materialize_remote_audio(&token.track).await
    }

    async fn materialize_remote_audio(&self, track: &PlaybackTrack) -> RemoteResult<PathBuf> {
        materialize_remote_audio_for_track(&self.app, &self.remote_audio_locks, track).await
    }

    fn spawn_remote_audio_prewarm(&self, tracks: Vec<PlaybackTrack>) {
        if tracks.is_empty() {
            return;
        }
        let app = self.app.clone();
        let locks = Arc::clone(&self.remote_audio_locks);
        tauri::async_runtime::spawn(async move {
            for track in tracks {
                let title = track.music_name.clone();
                if let Err(error) = materialize_remote_audio_for_track(&app, &locks, &track).await {
                    log::warn!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_audio_prewarm_failed title=\"{}\" error=\"{}\"",
                        escape_remote_log_value(&title),
                        escape_remote_log_value(&error.message)
                    );
                }
            }
        });
    }

    fn spawn_remote_next_queue_fill(
        &self,
        client_id: String,
        current: PlaybackTrack,
        recent_history: Vec<PlaybackTrack>,
        relay_events: Option<RemoteRelayEventSender>,
    ) {
        let app = self.app.clone();
        let sessions = Arc::clone(&self.sessions);
        let locks = Arc::clone(&self.remote_audio_locks);
        tauri::async_runtime::spawn(async move {
            let title = current.music_name.clone();
            let started = Instant::now();
            let queue = match propose_remote_next_queue(&app, &current, &recent_history).await {
                Ok(queue) => queue,
                Err(error) => {
                    log::warn!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_next_queue_fill_failed title=\"{}\" error=\"{}\" elapsed_ms={}",
                        escape_remote_log_value(&title),
                        escape_remote_log_value(&error.to_string()),
                        started.elapsed().as_millis()
                    );
                    return;
                }
            };
            let commit = match commit_remote_next_queue_for_current(
                &sessions, &client_id, &current, queue,
            ) {
                Ok(Some(commit)) => commit,
                Ok(None) => {
                    log::info!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_next_queue_fill_discarded title=\"{}\" reason=stale_session elapsed_ms={}",
                        escape_remote_log_value(&title),
                        started.elapsed().as_millis()
                    );
                    return;
                }
                Err(error) => {
                    log::warn!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_next_queue_fill_commit_failed title=\"{}\" error=\"{}\" elapsed_ms={}",
                        escape_remote_log_value(&title),
                        escape_remote_log_value(&error.message),
                        started.elapsed().as_millis()
                    );
                    return;
                }
            };
            let prewarm_tracks = commit.prewarm_tracks;
            let prefetch_count = commit.frontier.len();
            if let Some(relay_events) = relay_events.as_ref() {
                send_remote_relay_prefetch_ready(relay_events, &client_id, commit.frontier);
            }
            log::info!(
                target: REMOTE_SHARE_LOG_TARGET,
                "remote_next_queue_fill_finished title=\"{}\" prefetch_tracks={} prewarm_tracks={} elapsed_ms={}",
                escape_remote_log_value(&title),
                prefetch_count,
                prewarm_tracks.len(),
                started.elapsed().as_millis()
            );
            for track in prewarm_tracks {
                let title = track.music_name.clone();
                if let Err(error) = materialize_remote_audio_for_track(&app, &locks, &track).await {
                    log::warn!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_next_queue_prewarm_failed title=\"{}\" error=\"{}\"",
                        escape_remote_log_value(&title),
                        escape_remote_log_value(&error.message)
                    );
                }
            }
        });
    }

    fn reset_to_ready(&self, client_id: &str) -> RemoteResult<()> {
        let mut sessions = self.lock_sessions()?;
        let session = sessions.by_client.entry(client_id.to_string()).or_default();
        session.current = None;
        session.queue.clear();
        session.state = RemotePlaybackState::Ready;
        session.audio_tokens.clear();
        Ok(())
    }

    fn commit_playback(
        &self,
        client_id: &str,
        playlist_name: String,
        current: PlaybackTrack,
        queue: Vec<PlaybackTrack>,
    ) -> RemoteResult<RemotePlaybackResponse> {
        let mut sessions = self.lock_sessions()?;
        let session = sessions.by_client.entry(client_id.to_string()).or_default();
        session.playlist_name = Some(playlist_name);
        session.current = Some(current.clone());
        session.queue = queue
            .into_iter()
            .filter(|track| !same_remote_track(track, &current))
            .collect();
        observe_remote_recent_track(&mut session.recently_played, current.clone());
        session.state = RemotePlaybackState::Playing;
        let playback = session.create_playback_cargo(&current);
        let prefetch = session
            .queue
            .front()
            .cloned()
            .map(|track| session.create_playback_cargo(&track));
        let retained_tracks = std::iter::once(current.clone())
            .chain(session.queue.front().cloned())
            .collect::<Vec<_>>();
        session.retain_audio_tokens_for_tracks(&retained_tracks);
        self.spawn_remote_audio_prewarm(retained_tracks);
        Ok(RemotePlaybackResponse {
            session: session.view(),
            playback: Some(playback),
            prefetch,
        })
    }
}

fn commit_remote_next_queue_for_current(
    sessions: &Arc<Mutex<RemoteShareSessions>>,
    client_id: &str,
    current: &PlaybackTrack,
    queue: Vec<PlaybackTrack>,
) -> RemoteResult<Option<RemoteNextQueueCommit>> {
    let mut sessions = sessions
        .lock()
        .map_err(|_| RemoteShareError::internal("remote share sessions lock is poisoned"))?;
    let Some(session) = sessions.by_client.get_mut(client_id) else {
        return Ok(None);
    };
    if session.state != RemotePlaybackState::Playing
        || !session
            .current
            .as_ref()
            .is_some_and(|active| same_remote_track(active, current))
    {
        return Ok(None);
    }
    session.queue = queue
        .into_iter()
        .filter(|track| !same_remote_track(track, current))
        .collect();
    let prewarm_tracks = session
        .queue
        .iter()
        .take(REMOTE_PREFETCH_FRONTIER_LIMIT)
        .cloned()
        .collect::<Vec<_>>();
    let frontier = prewarm_tracks
        .iter()
        .map(|track| session.create_playback_cargo(track))
        .collect::<Vec<_>>();
    let retained_tracks = std::iter::once(current.clone())
        .chain(prewarm_tracks.iter().cloned())
        .collect::<Vec<_>>();
    session.retain_audio_tokens_for_tracks(&retained_tracks);
    Ok(Some(RemoteNextQueueCommit {
        frontier,
        prewarm_tracks,
    }))
}

fn send_remote_relay_prefetch_ready(
    relay_events: &RemoteRelayEventSender,
    client_id: &str,
    frontier: Vec<RemotePlaybackCargo>,
) {
    if frontier.is_empty() {
        return;
    }
    let event = RemoteRelayOutbound::SessionPrefetchReady {
        client_id: client_id.to_string(),
        frontier,
    };
    match serde_json::to_string(&event) {
        Ok(frame) => {
            if relay_events.send(frame).is_err() {
                log::warn!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_prefetch_event_send_failed reason=relay_closed"
                );
            }
        }
        Err(error) => {
            log::warn!(
                target: REMOTE_SHARE_LOG_TARGET,
                "remote_prefetch_event_serialize_failed error=\"{}\"",
                error
            );
        }
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

    fn create_playback_cargo(&mut self, track: &PlaybackTrack) -> RemotePlaybackCargo {
        let token = self.create_audio_token(track.clone());
        RemotePlaybackCargo {
            track: RemoteTrackView::from_track(track),
            audio_url: format!("/api/audio/{token}"),
            loudness_plan: track.loudness_profile.as_ref().and_then(|profile| {
                playback_loudness_plan_for_profile(profile).map(RemoteLoudnessPlanView::from_plan)
            }),
        }
    }

    fn create_audio_token(&mut self, track: PlaybackTrack) -> String {
        if let Some((token, _)) = self
            .audio_tokens
            .iter()
            .find(|(_, token)| same_remote_track(&token.track, &track))
        {
            return token.clone();
        }

        self.next_token_id = self.next_token_id.saturating_add(1);
        let token = format!("dev-{}", self.next_token_id);
        self.audio_tokens
            .insert(token.clone(), RemoteAudioToken { track });
        token
    }

    fn retain_audio_tokens_for_tracks(&mut self, retained_tracks: &[PlaybackTrack]) {
        self.audio_tokens.retain(|_, token| {
            retained_tracks
                .iter()
                .any(|track| same_remote_track(track, &token.track))
        });
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

impl RemoteLoudnessPlanView {
    fn from_plan(plan: PlaybackLoudnessPlan) -> Self {
        Self {
            integrated_lufs: plan.integrated_lufs,
            true_peak_dbtp: plan.true_peak_dbtp,
            lra: plan.lra,
            base_gain_db: plan.base_gain_db,
            final_gain_db: plan.final_gain_db,
            target_lufs: plan.target_lufs,
            reason: plan.reason,
        }
    }
}

fn session_connected(runtime: &RemoteShareRuntime, client_id: &str) -> RemoteResult<bool> {
    Ok(runtime
        .lock_sessions()?
        .by_client
        .get(client_id)
        .map(|session| session.connected)
        .unwrap_or(false))
}

fn remote_runtime() -> std::result::Result<Arc<RemoteShareRuntime>, String> {
    REMOTE_SHARE_RUNTIME
        .get()
        .cloned()
        .ok_or_else(|| "remote share runtime is not initialized".to_string())
}

async fn get_remote_share_settings() -> RemoteResult<Option<RemoteShareSettings>> {
    match Repo::<PersistedRemoteShareSettings>::get_record(remote_share_settings_record_id()).await
    {
        Ok(settings) => Ok(Some(settings.into())),
        Err(error) => match classify_db_error(&error) {
            DBError::NotFound | DBError::MissingTable(_) => Ok(None),
            other => Err(RemoteShareError::internal(other.to_string())),
        },
    }
}

async fn save_remote_share_settings(
    settings: RemoteShareSettings,
) -> RemoteResult<RemoteShareSettings> {
    let persisted = PersistedRemoteShareSettings::from(settings);
    Repo::<PersistedRemoteShareSettings>::upsert_at(remote_share_settings_record_id(), persisted)
        .await
        .map(RemoteShareSettings::from)
        .map_err(|error| RemoteShareError::internal(error.to_string()))
}

async fn ensure_remote_share_settings() -> RemoteResult<RemoteShareSettings> {
    if let Some(settings) = get_remote_share_settings().await? {
        return Ok(settings);
    }
    save_remote_share_settings(RemoteShareSettings::default()).await
}

fn remote_share_settings_record_id() -> RecordId {
    RecordId::new(
        PersistedRemoteShareSettings::table_name(),
        REMOTE_SHARE_SETTINGS_RECORD_KEY,
    )
}

fn generate_remote_pairing_code() -> String {
    let mut rng = rand::rng();
    (0..REMOTE_PAIRING_CODE_MAX_LEN)
        .map(|_| {
            let index = rng.random_range(0..REMOTE_PAIRING_CODE_ALPHABET.len());
            REMOTE_PAIRING_CODE_ALPHABET[index] as char
        })
        .collect()
}

fn normalize_remote_pairing_code(code: &str) -> RemoteResult<String> {
    let normalized = code
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_uppercase())
        .take(REMOTE_PAIRING_CODE_MAX_LEN)
        .collect::<String>();
    if normalized.is_empty() {
        Err(RemoteShareError::unauthorized(
            "remote share code must contain at least one letter or digit",
        ))
    } else {
        Ok(normalized)
    }
}

fn normalize_remote_client_id(client_id: Option<&str>) -> String {
    client_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_REMOTE_CLIENT_ID)
        .to_string()
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

struct RemoteAudioMaterializationDescriptor {
    key: String,
    app: AppHandle,
    track: PlaybackTrack,
    output_path: PathBuf,
    gain_db: f32,
}

async fn remote_audio_materialization_descriptor(
    app: &AppHandle,
    track: &PlaybackTrack,
) -> RemoteResult<RemoteAudioMaterializationDescriptor> {
    let metadata = tokio::fs::metadata(&track.file_path)
        .await
        .map_err(|_| RemoteShareError::not_found("audio file not found"))?;
    if metadata.len() == 0 {
        return Err(RemoteShareError::internal("empty audio file"));
    }

    let gain_db = remote_audio_gain_db(track);
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());
    let key = remote_audio_materialization_key(track, gain_db, metadata.len(), modified_ms);
    let output_path = remote_audio_cache_root(app)?.join(format!("{key}.m4a"));
    Ok(RemoteAudioMaterializationDescriptor {
        key,
        app: app.clone(),
        track: track.clone(),
        output_path,
        gain_db,
    })
}

fn remote_audio_cache_root(app: &AppHandle) -> RemoteResult<PathBuf> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| RemoteShareError::internal(error.to_string()))?
        .join(REMOTE_AUDIO_CACHE_DIR);
    std_fs::create_dir_all(&cache_dir)
        .map_err(|error| RemoteShareError::internal(error.to_string()))?;
    Ok(cache_dir)
}

fn remote_audio_gain_db(track: &PlaybackTrack) -> f32 {
    track
        .loudness_profile
        .as_ref()
        .and_then(playback_loudness_plan_for_profile)
        .map(|plan| plan.final_gain_db)
        .unwrap_or(0.0)
}

fn remote_audio_materialization_key(
    track: &PlaybackTrack,
    gain_db: f32,
    file_len: u64,
    modified_ms: Option<u128>,
) -> String {
    let gain_millidb = (gain_db * 1000.0).round() as i32;
    let mut hasher = Sha256::new();
    hasher.update(track.canonical_music_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(track.music_url.as_bytes());
    hasher.update(b"\0");
    hasher.update(track.file_path.to_string_lossy().as_bytes());
    hasher.update(b"\0");
    hasher.update(track.start_ms.to_le_bytes());
    hasher.update(track.end_ms.to_le_bytes());
    hasher.update(file_len.to_le_bytes());
    hasher.update(modified_ms.unwrap_or_default().to_le_bytes());
    hasher.update(gain_millidb.to_le_bytes());
    hex::encode(hasher.finalize())
}

async fn remote_audio_cache_file_is_ready(path: &PathBuf) -> bool {
    tokio::fs::metadata(path)
        .await
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
}

async fn materialize_remote_audio_for_track(
    app: &AppHandle,
    locks: &Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    track: &PlaybackTrack,
) -> RemoteResult<PathBuf> {
    let descriptor = remote_audio_materialization_descriptor(app, track).await?;
    if remote_audio_cache_file_is_ready(&descriptor.output_path).await {
        return Ok(descriptor.output_path);
    }

    let lock = remote_audio_materialization_lock_from(locks, &descriptor.key)?;
    task::spawn_blocking(move || materialize_remote_audio_blocking(descriptor, lock))
        .await
        .map_err(|error| RemoteShareError::internal(error.to_string()))?
}

fn remote_audio_materialization_lock_from(
    locks: &Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    key: &str,
) -> RemoteResult<Arc<Mutex<()>>> {
    let mut locks = locks
        .lock()
        .map_err(|_| RemoteShareError::internal("remote audio materialization lock is poisoned"))?;
    Ok(Arc::clone(
        locks
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(()))),
    ))
}

fn materialize_remote_audio_blocking(
    descriptor: RemoteAudioMaterializationDescriptor,
    lock: Arc<Mutex<()>>,
) -> RemoteResult<PathBuf> {
    let _guard = lock
        .lock()
        .map_err(|_| RemoteShareError::internal("remote audio materialization lock is poisoned"))?;
    if std_fs::metadata(&descriptor.output_path)
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
    {
        return Ok(descriptor.output_path);
    }

    let Some(parent) = descriptor.output_path.parent() else {
        return Err(RemoteShareError::internal(
            "remote audio cache path has no parent",
        ));
    };
    std_fs::create_dir_all(parent)
        .map_err(|error| RemoteShareError::internal(error.to_string()))?;
    let temp_path = parent.join(format!("{}.tmp", descriptor.key));
    let _ = std_fs::remove_file(&temp_path);

    let ffmpeg_path = ensure_managed_binary(&descriptor.app, ManagedBinary::Ffmpeg)
        .map_err(RemoteShareError::internal)?;
    let _usage = acquire_managed_binary_usage(ManagedBinary::Ffmpeg, "remote_share_audio");
    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-ss")
        .arg(format_remote_seconds(descriptor.track.start_ms))
        .arg("-i")
        .arg(&descriptor.track.file_path)
        .arg("-t")
        .arg(format_remote_seconds(
            descriptor
                .track
                .end_ms
                .saturating_sub(descriptor.track.start_ms),
        ))
        .arg("-map")
        .arg("0:a:0")
        .arg("-vn");
    if descriptor.gain_db.abs() > REMOTE_AUDIO_GAIN_EPSILON_DB {
        command
            .arg("-af")
            .arg(format!("volume={:.3}dB", descriptor.gain_db));
    }
    command
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("192k")
        .arg("-movflags")
        .arg("+faststart")
        .arg("-f")
        .arg("mp4")
        .arg(&temp_path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|error| RemoteShareError::internal(error.to_string()))?;
    if !output.status.success() {
        let _ = std_fs::remove_file(&temp_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(RemoteShareError::internal(format!(
            "remote audio materialization failed: {}",
            stderr.trim()
        )));
    }
    if !std_fs::metadata(&temp_path)
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
    {
        let _ = std_fs::remove_file(&temp_path);
        return Err(RemoteShareError::internal(
            "remote audio materialization produced empty output",
        ));
    }
    std_fs::rename(&temp_path, &descriptor.output_path)
        .map_err(|error| RemoteShareError::internal(error.to_string()))?;
    Ok(descriptor.output_path)
}

fn format_remote_seconds(ms: u32) -> String {
    format!("{:.3}", f64::from(ms) / 1000.0)
}

fn escape_remote_log_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
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
        response = response.header(CONTENT_RANGE, format!("bytes {start}-{end}/{file_len}"));
    }
    response
        .body(Body::from_stream(stream))
        .map_err(|error| RemoteShareError::internal(error.to_string()))
}

async fn read_file_relay_chunk(
    path: PathBuf,
    range: Option<&str>,
) -> RemoteResult<RemoteAudioRelayCargo> {
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

    let parsed = range.and_then(|value| parse_single_http_range(value, file_len));
    let (start, requested_end, range_requested) = match parsed {
        Some((start, end)) => (start, end, true),
        None => (0, file_len - 1, false),
    };
    let end = requested_end.min(start + REMOTE_AUDIO_CHUNK_SIZE - 1);
    let len = end.saturating_sub(start).saturating_add(1);
    file.seek(SeekFrom::Start(start))
        .await
        .map_err(|error| RemoteShareError::internal(error.to_string()))?;
    let mut body = Vec::with_capacity(len as usize);
    file.take(len)
        .read_to_end(&mut body)
        .await
        .map_err(|error| RemoteShareError::internal(error.to_string()))?;
    let partial = range_requested || end < file_len - 1 || start > 0;

    Ok(RemoteAudioRelayCargo {
        status: if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        },
        content_type: "audio/mp4",
        content_length: body.len() as u64,
        content_range: partial.then(|| format!("bytes {start}-{end}/{file_len}")),
        accept_ranges: "bytes",
        body,
    })
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

#[cfg(test)]
#[path = "remote_share.test.rs"]
mod tests;
