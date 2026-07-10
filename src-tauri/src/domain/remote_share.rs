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
use crate::domain::remote_p2p_hls::{P2pHlsSessionSnapshot, P2pHlsSource, RemoteP2pHls};
use crate::domain::remote_p2p_transport::{
    RemoteIceServer, RemoteP2pSignal, RemoteP2pTransport, RemoteP2pTransportEvent,
};
use crate::utils::binaries::{ManagedBinary, ensure_managed_binary};
use anyhow::{Result, anyhow};
use appdb::Store;
use appdb::error::{DBError, classify_db_error};
use appdb::model::meta::ModelMeta;
use appdb::repository::Repo;
use axum::extract::State;
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use rand::RngExt;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use surrealdb::types::RecordId;
use surrealdb_types::SurrealValue;
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::task;
use tokio::time::{MissedTickBehavior, interval, sleep};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tower_http::cors::{Any, CorsLayer};

const REMOTE_SHARE_LOG_TARGET: &str = "remote_share";
const REMOTE_SHARE_SETTINGS_RECORD_KEY: &str = "singleton";
const REMOTE_PAIRING_CODE_MAX_LEN: usize = 8;
const REMOTE_PAIRING_CODE_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const REMOTE_SHARE_PORT: u16 = 48_231;
const REMOTE_CANDIDATE_WINDOW_LIMIT: usize = 96;
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
    p2p_hls: Arc<RemoteP2pHls>,
    p2p_transport: Arc<RemoteP2pTransport>,
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
    current_hls_entry_id: Option<String>,
    queue: VecDeque<PlaybackTrack>,
    recently_played: Vec<PlaybackTrack>,
    state: RemotePlaybackState,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RemotePlaybackState {
    #[default]
    Ready,
    Preparing,
    Playing,
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
struct RemoteSessionCommandRequest {
    code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSessionNextRequest {
    code: String,
    entry_id: String,
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
        #[serde(default)]
        ice_servers: Vec<RemoteIceServer>,
    },
    PeerState {
        host_connected: bool,
        client_connected: bool,
        #[serde(default)]
        ice_servers: Vec<RemoteIceServer>,
    },
    RpcRequest {
        id: String,
        method: String,
        #[serde(default)]
        client_id: Option<String>,
        #[serde(default)]
        params: serde_json::Value,
    },
    P2pSignal {
        #[serde(default)]
        client_id: Option<String>,
        signal: RemoteP2pSignal,
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
    SessionTimelineUpdated {
        client_id: String,
        hls: RemoteHlsSessionView,
    },
    P2pSignal {
        client_id: String,
        signal: RemoteP2pSignal,
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
    hls: RemoteHlsSessionView,
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

#[derive(Debug, Clone, Serialize)]
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
    hls: RemoteHlsSessionView,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHlsSessionView {
    epoch: u64,
    revision: u64,
    stream_url: String,
    entries: Vec<RemoteHlsTimelineEntryView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHlsTimelineEntryView {
    id: String,
    track: RemoteTrackView,
    start_seconds: f64,
    end_seconds: f64,
}

impl From<P2pHlsSessionSnapshot> for RemoteHlsSessionView {
    fn from(snapshot: P2pHlsSessionSnapshot) -> Self {
        Self {
            epoch: snapshot.epoch,
            revision: snapshot.revision,
            stream_url: snapshot.stream_url,
            entries: snapshot
                .entries
                .into_iter()
                .map(|entry| RemoteHlsTimelineEntryView {
                    id: entry.id,
                    track: RemoteTrackView::from_track(&entry.track),
                    start_seconds: entry.start_seconds,
                    end_seconds: entry.end_seconds,
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemotePlaybackCargo {
    track: RemoteTrackView,
    loudness_plan: Option<RemoteLoudnessPlanView>,
}

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
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

pub async fn initialize_runtime(app: AppHandle) -> Result<()> {
    install_remote_tls_crypto_provider();
    let settings = ensure_remote_share_settings()
        .await
        .map_err(|error| anyhow!(error.message))?;

    let (p2p_transport, p2p_events) = RemoteP2pTransport::new();
    let p2p_hls = RemoteP2pHls::new(app.path().app_cache_dir()?.join("remote-p2p-hls"))?;
    let runtime = Arc::new(RemoteShareRuntime {
        app,
        settings: Arc::new(Mutex::new(settings)),
        sessions: Arc::new(Mutex::new(RemoteShareSessions::default())),
        p2p_hls,
        p2p_transport,
    });
    if REMOTE_SHARE_RUNTIME.set(Arc::clone(&runtime)).is_err() {
        log::warn!(
            target: REMOTE_SHARE_LOG_TARGET,
            "remote_share_runtime_init_skipped reason=already_initialized"
        );
        return Ok(());
    }

    let p2p_runtime = Arc::clone(&runtime);
    tauri::async_runtime::spawn(run_remote_p2p_events(p2p_runtime, p2p_events));

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

async fn run_remote_p2p_events(
    runtime: Arc<RemoteShareRuntime>,
    mut events: tokio::sync::mpsc::UnboundedReceiver<RemoteP2pTransportEvent>,
) {
    while let Some(event) = events.recv().await {
        match event {
            RemoteP2pTransportEvent::HlsAssetRequested {
                client_id,
                request_id,
                url,
                channel,
            } => {
                let runtime = Arc::clone(&runtime);
                tauri::async_runtime::spawn(async move {
                    match runtime.p2p_hls.resolve_asset(&client_id, &url).await {
                        Ok(asset) => {
                            if let Err(error) = RemoteP2pTransport::send_hls_asset(
                                channel,
                                request_id,
                                asset.content_type,
                                asset.body,
                            )
                            .await
                            {
                                log::warn!(
                                    target: REMOTE_SHARE_LOG_TARGET,
                                    "remote_p2p_hls_asset_send_failed error=\"{}\"",
                                    escape_remote_log_value(&error.to_string())
                                );
                            }
                        }
                        Err(error) => {
                            let message = escape_remote_log_value(&error.to_string());
                            if let Err(send_error) = RemoteP2pTransport::send_hls_asset_error(
                                channel, request_id, &message,
                            )
                            .await
                            {
                                log::warn!(
                                    target: REMOTE_SHARE_LOG_TARGET,
                                    "remote_p2p_hls_asset_error_send_failed error=\"{}\"",
                                    escape_remote_log_value(&send_error.to_string())
                                );
                            }
                        }
                    }
                });
            }
        }
    }
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
        .route("/api/session/stop", post(stop_remote_session))
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
        match connect_async(&url).await {
            Ok((socket, _)) => {
                match serve_remote_relay_socket(Arc::clone(&runtime), socket, status.code).await {
                    Ok(()) => {}
                    Err(error) if is_expected_remote_relay_disconnect(&error) => {}
                    Err(error) => {
                        log::warn!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_share_relay_disconnected error=\"{}\"",
                            error
                        );
                    }
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
    runtime.p2p_transport.set_relay_events(outbound_tx.clone());
    let connected_at = Instant::now();
    let mut client_connected = false;
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
                if let Some((_host_connected, next_client_connected)) = remote_relay_peer_state(&text) {
                    client_connected = next_client_connected;
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

fn is_expected_remote_relay_disconnect(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    matches!(
        message.as_str(),
        "remote relay idle connection refresh requested" | "remote relay share state changed"
    )
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
        RemoteRelayInbound::Hello {
            role,
            code,
            ice_servers,
        } => {
            let _ = (role, code);
            runtime.p2p_transport.update_ice_servers(ice_servers);
            return None;
        }
        RemoteRelayInbound::PeerState { ice_servers, .. } => {
            runtime.p2p_transport.update_ice_servers(ice_servers);
            return None;
        }
        RemoteRelayInbound::RpcRequest {
            id,
            method,
            client_id,
            params,
        } => Some(
            handle_remote_relay_rpc(
                Arc::clone(&runtime),
                id,
                method,
                client_id,
                params,
                relay_events,
            )
            .await,
        ),
        RemoteRelayInbound::P2pSignal { client_id, signal } => {
            let client_id = normalize_remote_client_id(client_id.as_deref());
            let closes_peer = matches!(signal, RemoteP2pSignal::Close);
            match runtime
                .p2p_transport
                .handle_signal(&client_id, signal)
                .await
            {
                Ok(()) => {
                    if closes_peer {
                        runtime.remove_client(&client_id);
                    }
                    return None;
                }
                Err(error) => Some(RemoteRelayOutbound::P2pSignal {
                    client_id,
                    signal: RemoteP2pSignal::Error {
                        reason: error.to_string(),
                    },
                }),
            }
        }
    };
    let outbound = outbound?;
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
    _relay_events: RemoteRelayEventSender,
) -> RemoteRelayOutbound {
    let started = Instant::now();
    let client_id = normalize_remote_client_id(client_id.as_deref());
    log::debug!(
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
            Ok(request) => relay_json(runtime.handle_start(&client_id, request).await),
            Err(error) => Err(error),
        },
        "session.next" => match parse_relay_params(params) {
            Ok(request) => relay_json(runtime.handle_hls_boundary(&client_id, request).await),
            Err(error) => Err(error),
        },
        "session.stop" => match parse_relay_params(params) {
            Ok(request) => relay_json(runtime.handle_stop(&client_id, request).await),
            Err(error) => Err(error),
        },
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
    let ok = matches!(outbound, RemoteRelayOutbound::RpcResponse { ok: true, .. });
    let elapsed_ms = started.elapsed().as_millis();
    if ok && elapsed_ms < 1000 {
        log::debug!(
            target: REMOTE_SHARE_LOG_TARGET,
            "remote_share_relay_rpc_finished method=\"{}\" ok=true elapsed_ms={}",
            method,
            elapsed_ms
        );
    } else if ok {
        log::info!(
            target: REMOTE_SHARE_LOG_TARGET,
            "remote_share_relay_rpc_finished method=\"{}\" ok=true elapsed_ms={}",
            method,
            elapsed_ms
        );
    } else {
        log::warn!(
            target: REMOTE_SHARE_LOG_TARGET,
            "remote_share_relay_rpc_finished method=\"{}\" ok=false elapsed_ms={}",
            method,
            elapsed_ms
        );
    }
    outbound
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
            .handle_start(DEFAULT_REMOTE_CLIENT_ID, request)
            .await?,
    ))
}

async fn stop_remote_session(
    State(runtime): State<Arc<RemoteShareRuntime>>,
    Json(request): Json<RemoteSessionCommandRequest>,
) -> RemoteResult<Json<RemotePlaybackResponse>> {
    Ok(Json(
        runtime
            .handle_stop(DEFAULT_REMOTE_CLIENT_ID, request)
            .await?,
    ))
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
            self.p2p_transport.close_all().await;
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
            self.p2p_transport.close_all().await;
        }
        self.status()
    }

    fn clear_sessions(&self) -> RemoteResult<()> {
        let mut sessions = self.lock_sessions()?;
        sessions.by_client.clear();
        self.p2p_hls.clear();
        Ok(())
    }

    fn remove_client(&self, client_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.by_client.remove(client_id);
        }
        self.p2p_hls.remove(client_id);
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
        self.p2p_hls.prepare(client_id)?;
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
        let hls = self
            .p2p_hls
            .snapshot(client_id)
            .or_else(|_| self.p2p_hls.prepare(client_id))?;
        Ok(RemoteBootstrapResponse {
            code: status.code,
            connected: status.enabled && session_connected(self, client_id)?,
            playlists,
            session,
            hls: hls.into(),
        })
    }

    async fn handle_start(
        &self,
        client_id: &str,
        request: RemoteStartRequest,
    ) -> RemoteResult<RemotePlaybackResponse> {
        self.ensure_code(&request.code)?;
        {
            let mut sessions = self.lock_sessions()?;
            let session = sessions.by_client.entry(client_id.to_string()).or_default();
            session.connected = true;
            session.playlist_name = Some(request.playlist_name.clone());
            session.current = None;
            session.current_hls_entry_id = None;
            session.queue.clear();
            session.recently_played.clear();
            session.state = RemotePlaybackState::Preparing;
        }

        let initial = match resolve_remote_initial_track(&self.app, &request.playlist_name).await {
            Ok(track) => track,
            Err(error) => {
                self.reset_to_ready(client_id)?;
                return Err(error.into());
            }
        };
        let hls = match remote_p2p_hls_source(&self.app, &initial).await {
            Ok(source) => {
                self.p2p_hls
                    .publish_start(client_id, initial.clone(), source)
                    .await
            }
            Err(error) => Err(anyhow!(error.message)),
        };
        let hls = match hls {
            Ok(hls) => hls,
            Err(error) => {
                self.reset_to_ready(client_id)?;
                return Err(RemoteShareError::unavailable(error.to_string()));
            }
        };
        let response = self.commit_playback(
            client_id,
            request.playlist_name,
            initial.clone(),
            Vec::new(),
            hls,
        )?;
        self.spawn_remote_next_queue_fill(client_id.to_string(), initial, Vec::new());
        Ok(response)
    }

    async fn handle_hls_boundary(
        &self,
        client_id: &str,
        request: RemoteSessionNextRequest,
    ) -> RemoteResult<RemotePlaybackResponse> {
        self.ensure_code(&request.code)?;
        let snapshot = self.p2p_hls.snapshot(client_id)?;
        let target = snapshot
            .entries
            .iter()
            .find(|entry| entry.id == request.entry_id)
            .map(|entry| entry.track.clone())
            .ok_or_else(|| RemoteShareError::not_found("remote HLS timeline entry not found"))?;
        let (response, refill) = {
            let mut sessions = self.lock_sessions()?;
            let session = sessions
                .by_client
                .get_mut(client_id)
                .ok_or_else(|| RemoteShareError::not_found("remote client session not found"))?;
            let advanced = session.commit_hls_boundary(&request.entry_id, &target)?;
            let playback = session.create_playback_cargo(&target);
            (
                RemotePlaybackResponse {
                    session: session.view(),
                    playback: Some(playback),
                    hls: snapshot.into(),
                },
                advanced.then(|| (target, session.recently_played.clone())),
            )
        };
        if let Some((current, recent_history)) = refill {
            self.spawn_remote_next_queue_fill(client_id.to_owned(), current, recent_history);
        }
        Ok(response)
    }

    async fn handle_stop(
        &self,
        client_id: &str,
        request: RemoteSessionCommandRequest,
    ) -> RemoteResult<RemotePlaybackResponse> {
        self.ensure_code(&request.code)?;
        let view = {
            let mut sessions = self.lock_sessions()?;
            let session = sessions.by_client.entry(client_id.to_string()).or_default();
            session.current = None;
            session.current_hls_entry_id = None;
            session.queue.clear();
            session.state = RemotePlaybackState::Ready;
            session.view()
        };
        let hls = self.p2p_hls.prepare(client_id)?;
        Ok(RemotePlaybackResponse {
            session: view,
            playback: None,
            hls: hls.into(),
        })
    }

    fn spawn_remote_next_queue_fill(
        &self,
        client_id: String,
        current: PlaybackTrack,
        recent_history: Vec<PlaybackTrack>,
    ) {
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let title = current.music_name.clone();
            let started = Instant::now();
            let queue =
                match propose_remote_next_queue(&runtime.app, &current, &recent_history).await {
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
            let committed = match commit_remote_next_queue_for_current(
                &runtime.sessions,
                &client_id,
                &current,
                queue,
            ) {
                Ok(Some(committed)) => committed,
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
            let mut published = Vec::with_capacity(committed.len());
            for track in &committed {
                match remote_p2p_hls_source(&runtime.app, &track).await {
                    Ok(source) => published.push((track.clone(), source)),
                    Err(error) => {
                        log::warn!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_p2p_hls_prefetch_source_failed title=\"{}\" error=\"{}\"",
                            escape_remote_log_value(&track.music_name),
                            escape_remote_log_value(&error.message)
                        );
                        rollback_remote_queue_append(
                            &runtime.sessions,
                            &client_id,
                            &current,
                            &committed,
                        );
                        sleep(Duration::from_secs(5)).await;
                        runtime.spawn_remote_next_queue_fill(client_id, current, recent_history);
                        return;
                    }
                }
            }
            if !published.is_empty() {
                match runtime.p2p_hls.append_tracks(&client_id, published).await {
                    Ok(Some(snapshot)) => {
                        if let Err(error) = runtime.send_hls_timeline_updated(&client_id, snapshot)
                        {
                            log::warn!(
                                target: REMOTE_SHARE_LOG_TARGET,
                                "remote_p2p_hls_timeline_projection_failed error=\"{}\"",
                                escape_remote_log_value(&error.message)
                            );
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        rollback_remote_queue_append(
                            &runtime.sessions,
                            &client_id,
                            &current,
                            &committed,
                        );
                        log::warn!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_p2p_hls_prefetch_failed error=\"{}\"",
                            escape_remote_log_value(&error.to_string())
                        );
                        sleep(Duration::from_secs(5)).await;
                        runtime.spawn_remote_next_queue_fill(client_id, current, recent_history);
                        return;
                    }
                }
            }
            log::info!(
                target: REMOTE_SHARE_LOG_TARGET,
                "remote_next_queue_fill_finished title=\"{}\" committed={} elapsed_ms={}",
                escape_remote_log_value(&title),
                true,
                started.elapsed().as_millis()
            );
        });
    }

    fn reset_to_ready(&self, client_id: &str) -> RemoteResult<()> {
        let mut sessions = self.lock_sessions()?;
        let session = sessions.by_client.entry(client_id.to_string()).or_default();
        session.current = None;
        session.current_hls_entry_id = None;
        session.queue.clear();
        session.state = RemotePlaybackState::Ready;
        Ok(())
    }

    fn commit_playback(
        &self,
        client_id: &str,
        playlist_name: String,
        current: PlaybackTrack,
        queue: Vec<PlaybackTrack>,
        hls: P2pHlsSessionSnapshot,
    ) -> RemoteResult<RemotePlaybackResponse> {
        let current_hls_entry_id = hls.entries.first().map(|entry| entry.id.clone());
        let mut sessions = self.lock_sessions()?;
        let session = sessions.by_client.entry(client_id.to_string()).or_default();
        session.playlist_name = Some(playlist_name);
        session.current = Some(current.clone());
        session.current_hls_entry_id = current_hls_entry_id;
        session.queue = queue
            .into_iter()
            .filter(|track| !same_remote_track(track, &current))
            .collect();
        observe_remote_recent_track(&mut session.recently_played, current.clone());
        session.state = RemotePlaybackState::Playing;
        let playback = session.create_playback_cargo(&current);
        Ok(RemotePlaybackResponse {
            session: session.view(),
            playback: Some(playback),
            hls: hls.into(),
        })
    }
}

impl RemoteShareRuntime {
    fn send_hls_timeline_updated(
        &self,
        client_id: &str,
        snapshot: P2pHlsSessionSnapshot,
    ) -> RemoteResult<()> {
        let frame = serde_json::to_string(&RemoteRelayOutbound::SessionTimelineUpdated {
            client_id: client_id.to_owned(),
            hls: snapshot.into(),
        })
        .map_err(|error| RemoteShareError::internal(error.to_string()))?;
        self.p2p_transport
            .send_relay_frame(frame)
            .map_err(|error| RemoteShareError::unavailable(error.to_string()))
    }
}

async fn remote_p2p_hls_source(
    app: &AppHandle,
    track: &PlaybackTrack,
) -> RemoteResult<P2pHlsSource> {
    let metadata = tokio::fs::metadata(&track.file_path)
        .await
        .map_err(|_| RemoteShareError::not_found("audio file not found"))?;
    if metadata.len() == 0 {
        return Err(RemoteShareError::internal("empty audio file"));
    }
    let app = app.clone();
    let ffmpeg_path =
        task::spawn_blocking(move || ensure_managed_binary(&app, ManagedBinary::Ffmpeg))
            .await
            .map_err(|error| RemoteShareError::internal(error.to_string()))?
            .map_err(RemoteShareError::internal)?;
    Ok(P2pHlsSource {
        ffmpeg_path,
        file_path: track.file_path.clone(),
        start_ms: track.start_ms,
        end_ms: track.end_ms,
        gain_db: remote_audio_gain_db(track),
    })
}

fn commit_remote_next_queue_for_current(
    sessions: &Arc<Mutex<RemoteShareSessions>>,
    client_id: &str,
    current: &PlaybackTrack,
    queue: Vec<PlaybackTrack>,
) -> RemoteResult<Option<Vec<PlaybackTrack>>> {
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
    let queue = queue
        .into_iter()
        .filter(|track| !same_remote_track(track, current))
        .filter(|track| {
            !session
                .queue
                .iter()
                .any(|queued| same_remote_track(queued, track))
        })
        .collect::<Vec<_>>();
    session.queue.extend(queue.iter().cloned());
    Ok(Some(queue))
}

fn rollback_remote_queue_append(
    sessions: &Arc<Mutex<RemoteShareSessions>>,
    client_id: &str,
    current: &PlaybackTrack,
    appended: &[PlaybackTrack],
) {
    let Ok(mut sessions) = sessions.lock() else {
        return;
    };
    let Some(session) = sessions.by_client.get_mut(client_id) else {
        return;
    };
    if !session
        .current
        .as_ref()
        .is_some_and(|active| same_remote_track(active, current))
    {
        return;
    }
    for expected in appended.iter().rev() {
        if session
            .queue
            .back()
            .is_some_and(|queued| same_remote_track(queued, expected))
        {
            session.queue.pop_back();
        } else {
            break;
        }
    }
}

impl RemoteShareSession {
    fn commit_hls_boundary(
        &mut self,
        entry_id: &str,
        target: &PlaybackTrack,
    ) -> RemoteResult<bool> {
        if self.current_hls_entry_id.as_deref() == Some(entry_id) {
            return Ok(false);
        }
        let Some(next) = self.queue.pop_front() else {
            return Err(RemoteShareError::unavailable(
                "remote recommendation queue is empty at HLS boundary",
            ));
        };
        if !same_remote_track(&next, target) {
            self.queue.push_front(next);
            return Err(RemoteShareError::unavailable(
                "remote HLS boundary does not match the recommendation frontier",
            ));
        }
        self.playlist_name = Some(target.playlist_name.clone());
        self.current = Some(target.clone());
        self.current_hls_entry_id = Some(entry_id.to_owned());
        observe_remote_recent_track(&mut self.recently_played, target.clone());
        Ok(true)
    }

    fn view(&self) -> RemoteSessionView {
        RemoteSessionView {
            state: self.state,
            playlist_name: self.playlist_name.clone(),
            current: self.current.as_ref().map(RemoteTrackView::from_track),
            queue_count: self.queue.len(),
        }
    }

    fn create_playback_cargo(&mut self, track: &PlaybackTrack) -> RemotePlaybackCargo {
        RemotePlaybackCargo {
            track: RemoteTrackView::from_track(track),
            loudness_plan: track.loudness_profile.as_ref().and_then(|profile| {
                playback_loudness_plan_for_profile(profile).map(RemoteLoudnessPlanView::from_plan)
            }),
        }
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

fn remote_audio_gain_db(track: &PlaybackTrack) -> f32 {
    track
        .loudness_profile
        .as_ref()
        .and_then(playback_loudness_plan_for_profile)
        .map(|plan| plan.final_gain_db)
        .unwrap_or(0.0)
}

fn escape_remote_log_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
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

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
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
