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
use crate::domain::remote_host_identity::RemoteHostIdentity;
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
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use surrealdb::types::RecordId;
use surrealdb_types::SurrealValue;
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::task;
use tokio::time::{MissedTickBehavior, interval, sleep, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tower_http::cors::{Any, CorsLayer};

const REMOTE_SHARE_LOG_TARGET: &str = "remote_share";
const REMOTE_SHARE_SETTINGS_RECORD_KEY: &str = "singleton";
const REMOTE_PAIRING_CODE_MAX_LEN: usize = 8;
const REMOTE_PAIRING_CODE_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const REMOTE_SHARE_PORT: u16 = 48_231;
const REMOTE_CANDIDATE_WINDOW_LIMIT: usize = 96;
const REMOTE_PREFETCH_MIN_FUTURE_TRACKS: usize = 1;
const REMOTE_PREFETCH_MAX_FUTURE_TRACKS: usize = 3;
const REMOTE_RELAY_HOST_URL_ENV: &str = "SLISIC_REMOTE_RELAY_HOST_URL";
const DEFAULT_REMOTE_RELAY_HOST_URL: &str = "wss://slisic-remote.grahlnn.com/ws/host";
const REMOTE_RELAY_RECONNECT_DELAY: Duration = Duration::from_secs(5);
const REMOTE_RELAY_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const REMOTE_RELAY_IDLE_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const REMOTE_RELAY_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const REMOTE_OWNERSHIP_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const REMOTE_CODE_OCCUPIED_ERROR: &str = "remote_code_occupied";
const REMOTE_CODE_NETWORK_REQUIRED_ERROR: &str = "remote_code_network_required";
const REMOTE_CODE_IDENTITY_REJECTED_ERROR: &str = "remote_code_identity_rejected";
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
    code_configured_by_user: bool,
    host_identity_secret: String,
    ownership_revision: u64,
    pending_ownership_transaction_id: String,
    pending_ownership_expected_code: String,
    pending_ownership_desired_code: String,
    pending_ownership_expected_revision: u64,
}

impl Default for RemoteShareSettings {
    fn default() -> Self {
        let identity = RemoteHostIdentity::generate();
        Self {
            enabled: false,
            code: generate_remote_pairing_code(),
            enabled_configured_by_user: false,
            code_configured_by_user: false,
            host_identity_secret: identity.encoded_secret(),
            ownership_revision: 0,
            pending_ownership_transaction_id: String::new(),
            pending_ownership_expected_code: String::new(),
            pending_ownership_desired_code: String::new(),
            pending_ownership_expected_revision: 0,
        }
    }
}

impl RemoteShareSettings {
    fn host_identity(&self) -> RemoteResult<RemoteHostIdentity> {
        RemoteHostIdentity::from_encoded_secret(&self.host_identity_secret)
            .map_err(|error| RemoteShareError::internal(error.to_string()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, SurrealValue, Store)]
struct PersistedRemoteShareSettings {
    enabled: bool,
    code: String,
    #[serde(default)]
    enabled_configured_by_user: bool,
    #[serde(default)]
    code_configured_by_user: bool,
    #[serde(default)]
    host_identity_secret: String,
    #[serde(default)]
    ownership_revision: u64,
    #[serde(default)]
    pending_ownership_transaction_id: String,
    #[serde(default)]
    pending_ownership_expected_code: String,
    #[serde(default)]
    pending_ownership_desired_code: String,
    #[serde(default)]
    pending_ownership_expected_revision: u64,
}

impl From<PersistedRemoteShareSettings> for RemoteShareSettings {
    fn from(value: PersistedRemoteShareSettings) -> Self {
        let host_identity_secret =
            RemoteHostIdentity::from_encoded_secret(&value.host_identity_secret)
                .map(|identity| identity.encoded_secret())
                .unwrap_or_else(|_| RemoteHostIdentity::generate().encoded_secret());
        Self {
            enabled: value.enabled_configured_by_user && value.enabled,
            code: normalize_remote_pairing_code(&value.code)
                .unwrap_or_else(|_| generate_remote_pairing_code()),
            enabled_configured_by_user: value.enabled_configured_by_user,
            code_configured_by_user: value.code_configured_by_user,
            host_identity_secret,
            ownership_revision: value.ownership_revision,
            pending_ownership_transaction_id: value.pending_ownership_transaction_id,
            pending_ownership_expected_code: value.pending_ownership_expected_code,
            pending_ownership_desired_code: value.pending_ownership_desired_code,
            pending_ownership_expected_revision: value.pending_ownership_expected_revision,
        }
    }
}

impl From<RemoteShareSettings> for PersistedRemoteShareSettings {
    fn from(value: RemoteShareSettings) -> Self {
        Self {
            enabled: value.enabled,
            code: value.code,
            enabled_configured_by_user: value.enabled_configured_by_user,
            code_configured_by_user: value.code_configured_by_user,
            host_identity_secret: value.host_identity_secret,
            ownership_revision: value.ownership_revision,
            pending_ownership_transaction_id: value.pending_ownership_transaction_id,
            pending_ownership_expected_code: value.pending_ownership_expected_code,
            pending_ownership_desired_code: value.pending_ownership_desired_code,
            pending_ownership_expected_revision: value.pending_ownership_expected_revision,
        }
    }
}

#[derive(Default)]
struct RemoteShareSessions {
    by_client: HashMap<String, RemoteShareSession>,
}

struct RemoteShareSession {
    connected: bool,
    playlist_name: Option<String>,
    current: Option<PlaybackTrack>,
    current_hls_entry_id: Option<String>,
    queue: VecDeque<PlaybackTrack>,
    recently_played: Vec<PlaybackTrack>,
    state: RemotePlaybackState,
    prefetch_target_tracks: usize,
    prefetch_revision: u32,
    queue_fill_in_progress: bool,
}

impl Default for RemoteShareSession {
    fn default() -> Self {
        Self {
            connected: false,
            playlist_name: None,
            current: None,
            current_hls_entry_id: None,
            queue: VecDeque::new(),
            recently_played: Vec::new(),
            state: RemotePlaybackState::Ready,
            prefetch_target_tracks: REMOTE_PREFETCH_MIN_FUTURE_TRACKS,
            prefetch_revision: 0,
            queue_fill_in_progress: false,
        }
    }
}

struct RemoteQueueFillPlan {
    current: PlaybackTrack,
    existing_queue: Vec<PlaybackTrack>,
    recent_history: Vec<PlaybackTrack>,
    target_tracks: usize,
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
    HostChallenge {
        nonce: String,
        expires_at: u64,
    },
    HostRejected {
        reason: String,
        #[serde(default)]
        code: Option<String>,
        #[serde(default)]
        ownership_revision: Option<u64>,
    },
    Hello {
        role: String,
        code: String,
        #[serde(default)]
        ownership_revision: Option<u64>,
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
    HostProof {
        host_id: String,
        public_key: String,
        code: String,
        connection_epoch: u64,
        signature: String,
    },
    RpcResponse {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    P2pSignal {
        client_id: String,
        signal: RemoteP2pSignal,
    },
    HostPing {},
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteOwnershipClaimRequest {
    transaction_id: String,
    host_id: String,
    public_key: String,
    code: String,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteOwnershipClaimResult {
    status: String,
    code: String,
    revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteOwnershipChangeRequest {
    transaction_id: String,
    host_id: String,
    public_key: String,
    expected_code: String,
    desired_code: String,
    expected_revision: u64,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteOwnershipChangeResult {
    status: String,
    code: String,
    revision: u64,
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
    reserve_url: String,
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
            reserve_url: snapshot.reserve_url,
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
    let host_identity = settings
        .host_identity()
        .map_err(|error| anyhow!(error.message))?;
    log::info!(
        target: REMOTE_SHARE_LOG_TARGET,
        "remote_share_host_identity_ready host_id=\"{}\" public_key=\"{}\"",
        host_identity.host_id(),
        host_identity.encoded_public_key()
    );

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
                playout_seconds,
                priority,
                responses,
            } => {
                let trace_asset = should_trace_remote_p2p_hls_asset(request_id, &url);
                let asset_kind = if url.ends_with(".m3u8") {
                    "manifest"
                } else if url.ends_with(".ts") {
                    "segment"
                } else {
                    "other"
                };
                if trace_asset {
                    log::info!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_p2p_hls_asset_request_received request_id={} kind={} priority={priority:?}",
                        request_id,
                        asset_kind
                    );
                }
                let runtime = Arc::clone(&runtime);
                tauri::async_runtime::spawn(async move {
                    let started = Instant::now();
                    match runtime
                        .p2p_hls
                        .resolve_asset(&client_id, &url, playout_seconds)
                        .await
                    {
                        Ok(asset) => {
                            if trace_asset {
                                log::info!(
                                    target: REMOTE_SHARE_LOG_TARGET,
                                    "remote_p2p_hls_asset_resolved request_id={} kind={} bytes={} elapsed_ms={}",
                                    request_id,
                                    asset_kind,
                                    asset.body.len(),
                                    started.elapsed().as_millis()
                                );
                            }
                            if url.ends_with(".m3u8") {
                                if let Ok(snapshot) = runtime.p2p_hls.snapshot(&client_id) {
                                    let view = RemoteHlsSessionView::from(snapshot);
                                    if let Err(error) =
                                        RemoteP2pTransport::send_hls_timeline(&responses, &view)
                                            .await
                                    {
                                        log::warn!(
                                            target: REMOTE_SHARE_LOG_TARGET,
                                            "remote_p2p_hls_timeline_send_failed error=\"{}\"",
                                            escape_remote_log_value(&error.to_string())
                                        );
                                    }
                                }
                            }
                            if let Err(error) = RemoteP2pTransport::send_hls_asset(
                                &responses,
                                request_id,
                                asset.content_type,
                                asset.body,
                                priority,
                            )
                            .await
                            {
                                log::warn!(
                                    target: REMOTE_SHARE_LOG_TARGET,
                                    "remote_p2p_hls_asset_send_failed error=\"{}\"",
                                    escape_remote_log_value(&error.to_string())
                                );
                            } else if trace_asset {
                                log::info!(
                                    target: REMOTE_SHARE_LOG_TARGET,
                                    "remote_p2p_hls_asset_queued request_id={} kind={} elapsed_ms={}",
                                    request_id,
                                    asset_kind,
                                    started.elapsed().as_millis()
                                );
                            }
                        }
                        Err(error) => {
                            let message = escape_remote_log_value(&error.to_string());
                            if let Err(send_error) = RemoteP2pTransport::send_hls_asset_error(
                                &responses, request_id, &url, &message, priority,
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
            RemoteP2pTransportEvent::PrefetchReserveRequested {
                client_id,
                revision,
                target_tracks,
                buffer_seconds,
            } => {
                if let Err(error) = runtime.apply_prefetch_reserve(
                    &client_id,
                    revision,
                    target_tracks,
                    buffer_seconds,
                ) {
                    log::warn!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_prefetch_reserve_rejected error=\"{}\"",
                        escape_remote_log_value(&error.message)
                    );
                }
            }
            RemoteP2pTransportEvent::PlaybackReady {
                client_id,
                epoch,
                ready_seconds,
                playout_seconds,
                protected_sequence,
                responses,
            } => match runtime.p2p_hls.offer_handoff(
                &client_id,
                epoch,
                ready_seconds,
                playout_seconds,
                protected_sequence,
            ) {
                Ok(Some(handoff_sequence)) => {
                    log::info!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_p2p_hls_handoff_offered epoch={epoch} handoff_sequence={handoff_sequence} protected_sequence={protected_sequence} ready_seconds={ready_seconds:.3}"
                    );
                    if let Err(error) =
                        RemoteP2pTransport::send_handoff_offer(&responses, epoch, handoff_sequence)
                            .await
                    {
                        log::warn!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_p2p_hls_handoff_offer_send_failed error=\"{}\"",
                            escape_remote_log_value(&error.to_string())
                        );
                    }
                }
                Ok(None) => {
                    log::warn!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_p2p_hls_handoff_rejected epoch={epoch} ready_seconds={ready_seconds:.3}"
                    );
                }
                Err(error) => {
                    log::warn!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_p2p_hls_handoff_failed error=\"{}\"",
                        escape_remote_log_value(&error.to_string())
                    );
                }
            },
            RemoteP2pTransportEvent::PlaybackHandoffCommit {
                client_id,
                epoch,
                handoff_sequence,
            } => match runtime
                .p2p_hls
                .commit_handoff(&client_id, epoch, handoff_sequence)
            {
                Ok(Some(snapshot)) => {
                    log::info!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_p2p_hls_handoff_committed epoch={epoch} handoff_sequence={handoff_sequence}"
                    );
                    if let Err(error) = runtime
                        .send_hls_timeline_updated(&client_id, snapshot)
                        .await
                    {
                        log::warn!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_p2p_hls_handoff_projection_failed error=\"{}\"",
                            escape_remote_log_value(&error.message)
                        );
                    }
                }
                Ok(None) => log::warn!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_p2p_hls_handoff_commit_rejected epoch={epoch} handoff_sequence={handoff_sequence}"
                ),
                Err(error) => log::warn!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_p2p_hls_handoff_commit_failed error=\"{}\"",
                    escape_remote_log_value(&error.to_string())
                ),
            },
            RemoteP2pTransportEvent::SupplyWriterStalled {
                client_id,
                generation,
            } => {
                log::warn!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_p2p_supply_invalidated generation={generation} reason=writer_stalled"
                );
                runtime
                    .p2p_transport
                    .invalidate_supply(&client_id, generation)
                    .await;
            }
        }
    }
}

fn should_trace_remote_p2p_hls_asset(request_id: u32, url: &str) -> bool {
    request_id <= 8 && !url.ends_with(".m3u8")
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
        if runtime.has_pending_ownership_change() {
            let _ = runtime.reconcile_pending_ownership_change().await;
        }
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
    let connection_epoch = current_epoch_micros();
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
                await_remote_relay_write(
                    sink.send(Message::Text(ping.into())),
                    REMOTE_RELAY_WRITE_TIMEOUT,
                ).await?;
            }
            outbound = outbound_rx.recv() => {
                let Some(outbound) = outbound else {
                    return Err(anyhow!("remote relay outbound channel closed"));
                };
                await_remote_relay_write(
                    sink.send(Message::Text(outbound.into())),
                    REMOTE_RELAY_WRITE_TIMEOUT,
                ).await?;
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
                if remote_relay_message_is_rpc_request(&text) {
                    let runtime = Arc::clone(&runtime);
                    let response_tx = outbound_tx.clone();
                    let relay_events = outbound_tx.clone();
                    let message_active_code = active_code.clone();
                    task::spawn(async move {
                        let Some(response) = handle_remote_relay_message(
                            runtime,
                            &text,
                            relay_events,
                            &message_active_code,
                            connection_epoch,
                        ).await else {
                            return;
                        };
                        let _ = response_tx.send(response);
                    });
                    continue;
                }
                let Some(response) = handle_remote_relay_message(
                    Arc::clone(&runtime),
                    &text,
                    outbound_tx.clone(),
                    &active_code,
                    connection_epoch,
                ).await else {
                    continue;
                };
                await_remote_relay_write(
                    sink.send(Message::Text(response.into())),
                    REMOTE_RELAY_WRITE_TIMEOUT,
                ).await?;
            }
        }
    }
}

fn remote_relay_message_is_rpc_request(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|kind| kind == "rpc_request")
}

async fn await_remote_relay_write<F, T, E>(operation: F, max_wait: Duration) -> Result<T>
where
    F: Future<Output = std::result::Result<T, E>>,
    E: std::fmt::Display,
{
    match timeout(max_wait, operation).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(anyhow!(error.to_string())),
        Err(_) => Err(anyhow!("remote relay write timed out")),
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
    active_code: &str,
    connection_epoch: u64,
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
        RemoteRelayInbound::HostChallenge { nonce, expires_at } => {
            if current_epoch_millis() > expires_at {
                return None;
            }
            let settings = runtime.lock_settings().ok()?.clone();
            if settings.code != active_code {
                return None;
            }
            let identity = settings.host_identity().ok()?;
            Some(RemoteRelayOutbound::HostProof {
                host_id: identity.host_id(),
                public_key: identity.encoded_public_key(),
                code: active_code.to_owned(),
                connection_epoch,
                signature: identity.sign_host_challenge(&nonce, active_code, connection_epoch),
            })
        }
        RemoteRelayInbound::HostRejected {
            reason,
            code,
            ownership_revision,
        } => {
            if reason == "ownership_mismatch" {
                if let (Some(code), Some(revision)) = (code, ownership_revision) {
                    if let Err(error) = runtime
                        .apply_confirmed_ownership(code, revision, None)
                        .await
                    {
                        log::warn!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_share_ownership_reconcile_failed error=\"{}\"",
                            error.message
                        );
                    }
                }
            } else {
                log::warn!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_share_host_rejected reason=\"{}\"",
                    reason
                );
            }
            return None;
        }
        RemoteRelayInbound::Hello {
            role,
            code,
            ownership_revision,
            ice_servers,
        } => {
            let _ = role;
            if let Some(revision) = ownership_revision {
                if let Err(error) = runtime
                    .apply_confirmed_ownership(code, revision, None)
                    .await
                {
                    log::warn!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_share_ownership_confirm_failed error=\"{}\"",
                        error.message
                    );
                }
            }
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
            let (signal_generation, signal_revision) = match &signal {
                RemoteP2pSignal::Offer {
                    generation,
                    revision,
                    ..
                }
                | RemoteP2pSignal::Answer {
                    generation,
                    revision,
                    ..
                } => (*generation, *revision),
                RemoteP2pSignal::Candidate { generation, .. } => (*generation, 0),
                RemoteP2pSignal::Close | RemoteP2pSignal::Error { .. } => (0, 0),
            };
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
                        generation: signal_generation,
                        revision: signal_revision,
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

fn remote_relay_ownership_url(path: &str) -> RemoteResult<reqwest::Url> {
    let base = std::env::var(REMOTE_RELAY_HOST_URL_ENV)
        .unwrap_or_else(|_| DEFAULT_REMOTE_RELAY_HOST_URL.to_string());
    let mut url = reqwest::Url::parse(&base)
        .map_err(|error| RemoteShareError::internal(error.to_string()))?;
    let next_scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        "https" => "https",
        "http" => "http",
        _ => {
            return Err(RemoteShareError::internal(
                "unsupported remote relay URL scheme",
            ));
        }
    };
    url.set_scheme(next_scheme)
        .map_err(|_| RemoteShareError::internal("invalid remote relay URL scheme"))?;
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

async fn post_remote_ownership<T, R>(path: &str, request: &T) -> RemoteResult<R>
where
    T: Serialize,
    R: DeserializeOwned,
{
    let url = remote_relay_ownership_url(path)?;
    let body = serde_json::to_vec(request)
        .map_err(|error| RemoteShareError::internal(error.to_string()))?;
    let client = reqwest::Client::builder()
        .timeout(REMOTE_OWNERSHIP_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| RemoteShareError::internal(error.to_string()))?;
    let mut last_error = None;
    for attempt in 0..2 {
        match client
            .post(url.clone())
            .header("content-type", "application/json")
            .body(body.clone())
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                let bytes = response
                    .bytes()
                    .await
                    .map_err(|error| RemoteShareError::unavailable(error.to_string()))?;
                return serde_json::from_slice(&bytes)
                    .map_err(|error| RemoteShareError::internal(error.to_string()));
            }
            Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => {
                return Err(RemoteShareError::unauthorized(
                    REMOTE_CODE_IDENTITY_REJECTED_ERROR,
                ));
            }
            Ok(response) => {
                last_error = Some(format!("ownership endpoint returned {}", response.status()));
            }
            Err(error) => last_error = Some(error.to_string()),
        }
        if attempt == 0 {
            sleep(Duration::from_millis(300)).await;
        }
    }
    log::warn!(
        target: REMOTE_SHARE_LOG_TARGET,
        "remote_share_ownership_request_failed error=\"{}\"",
        escape_remote_log_value(last_error.as_deref().unwrap_or("unknown"))
    );
    Err(RemoteShareError::unavailable(
        REMOTE_CODE_NETWORK_REQUIRED_ERROR,
    ))
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

async fn propose_remote_queue_suffix(
    app: &AppHandle,
    current: &PlaybackTrack,
    existing_queue: &[PlaybackTrack],
    recently_played: &[PlaybackTrack],
    target_tracks: usize,
) -> Result<Vec<PlaybackTrack>> {
    let target_tracks = target_tracks.clamp(
        REMOTE_PREFETCH_MIN_FUTURE_TRACKS,
        REMOTE_PREFETCH_MAX_FUTURE_TRACKS,
    );
    let mut frontier = existing_queue.to_vec();
    let existing_len = frontier.len();
    let mut planned_history = recently_played.to_vec();
    for track in &frontier {
        observe_remote_recent_track(&mut planned_history, track.clone());
    }
    while frontier.len() < target_tracks {
        let anchor = frontier.last().unwrap_or(current);
        observe_remote_recent_track(&mut planned_history, anchor.clone());
        let proposal = propose_remote_next_queue(app, anchor, &planned_history).await?;
        let next = proposal.into_iter().find(|candidate| {
            !same_remote_track(candidate, current)
                && !frontier
                    .iter()
                    .any(|planned| same_remote_track(planned, candidate))
        });
        let Some(next) = next else {
            break;
        };
        frontier.push(next);
    }
    Ok(frontier.drain(existing_len..).collect())
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
            let mut next = settings.clone();
            next.enabled = enabled;
            next.enabled_configured_by_user = true;
            next
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
        let desired_code = normalize_remote_pairing_code(&code)?;
        if self.has_pending_ownership_change() {
            self.reconcile_pending_ownership_change().await?;
        }
        if self.lock_settings()?.code == desired_code {
            return self.status();
        }

        let mut current = self.ensure_remote_code_ownership().await?;
        for _ in 0..2 {
            if current.code == desired_code {
                self.apply_confirmed_ownership(
                    current.code,
                    current.ownership_revision,
                    Some(true),
                )
                .await?;
                return self.status();
            }
            let identity = current.host_identity()?;
            let transaction_id = generate_ownership_transaction_id();
            let request = RemoteOwnershipChangeRequest {
                transaction_id: transaction_id.clone(),
                host_id: identity.host_id(),
                public_key: identity.encoded_public_key(),
                expected_code: current.code.clone(),
                desired_code: desired_code.clone(),
                expected_revision: current.ownership_revision,
                signature: identity.sign_code_change(
                    &transaction_id,
                    &current.code,
                    &desired_code,
                    current.ownership_revision,
                ),
            };
            self.stage_pending_ownership_change(&request).await?;
            let result: RemoteOwnershipChangeResult =
                post_remote_ownership("/v1/ownership/change", &request).await?;
            match result.status.as_str() {
                "changed" | "unchanged" => {
                    self.apply_confirmed_ownership(result.code, result.revision, Some(true))
                        .await?;
                    self.clear_sessions()?;
                    self.p2p_transport.close_all().await;
                    return self.status();
                }
                "occupied" => {
                    self.clear_pending_ownership_change().await?;
                    return Err(RemoteShareError::unauthorized(REMOTE_CODE_OCCUPIED_ERROR));
                }
                "stale_revision" => {
                    self.apply_confirmed_ownership(result.code, result.revision, None)
                        .await?;
                    current = self.lock_settings()?.clone();
                }
                _ => {
                    self.clear_pending_ownership_change().await?;
                    return Err(RemoteShareError::unauthorized(
                        REMOTE_CODE_IDENTITY_REJECTED_ERROR,
                    ));
                }
            }
        }
        Err(RemoteShareError::unavailable(
            REMOTE_CODE_NETWORK_REQUIRED_ERROR,
        ))
    }

    async fn ensure_remote_code_ownership(&self) -> RemoteResult<RemoteShareSettings> {
        let current = self.lock_settings()?.clone();
        if current.ownership_revision > 0 {
            return Ok(current);
        }
        let identity = current.host_identity()?;
        let transaction_id = generate_ownership_transaction_id();
        let request = RemoteOwnershipClaimRequest {
            transaction_id: transaction_id.clone(),
            host_id: identity.host_id(),
            public_key: identity.encoded_public_key(),
            code: current.code.clone(),
            signature: identity.sign_code_claim(&transaction_id, &current.code),
        };
        let result: RemoteOwnershipClaimResult =
            post_remote_ownership("/v1/ownership/claim", &request).await?;
        match result.status.as_str() {
            "claimed" | "ownership_mismatch" => {
                self.apply_confirmed_ownership(result.code, result.revision, None)
                    .await?;
                Ok(self.lock_settings()?.clone())
            }
            "occupied" => Err(RemoteShareError::unauthorized(REMOTE_CODE_OCCUPIED_ERROR)),
            _ => Err(RemoteShareError::unauthorized(
                REMOTE_CODE_IDENTITY_REJECTED_ERROR,
            )),
        }
    }

    async fn apply_confirmed_ownership(
        &self,
        code: String,
        revision: u64,
        configured_by_user: Option<bool>,
    ) -> RemoteResult<()> {
        let code = normalize_remote_pairing_code(&code)?;
        let next_settings = {
            let settings = self.lock_settings()?;
            if settings.code == code
                && settings.ownership_revision == revision
                && configured_by_user.is_none_or(|value| settings.code_configured_by_user == value)
                && settings.pending_ownership_transaction_id.is_empty()
            {
                return Ok(());
            }
            let mut next = settings.clone();
            next.code = code;
            next.ownership_revision = revision;
            next.pending_ownership_transaction_id.clear();
            next.pending_ownership_expected_code.clear();
            next.pending_ownership_desired_code.clear();
            next.pending_ownership_expected_revision = 0;
            if let Some(configured_by_user) = configured_by_user {
                next.code_configured_by_user = configured_by_user;
            }
            next
        };
        match save_remote_share_settings(next_settings.clone()).await {
            Ok(persisted) => *self.lock_settings()? = persisted,
            Err(error) => {
                *self.lock_settings()? = next_settings;
                log::warn!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_share_ownership_local_persist_deferred error=\"{}\"",
                    escape_remote_log_value(&error.message)
                );
            }
        }
        Ok(())
    }

    fn has_pending_ownership_change(&self) -> bool {
        self.lock_settings()
            .map(|settings| !settings.pending_ownership_transaction_id.is_empty())
            .unwrap_or(false)
    }

    async fn stage_pending_ownership_change(
        &self,
        request: &RemoteOwnershipChangeRequest,
    ) -> RemoteResult<()> {
        let next = {
            let settings = self.lock_settings()?;
            let mut next = settings.clone();
            next.pending_ownership_transaction_id = request.transaction_id.clone();
            next.pending_ownership_expected_code = request.expected_code.clone();
            next.pending_ownership_desired_code = request.desired_code.clone();
            next.pending_ownership_expected_revision = request.expected_revision;
            next
        };
        let persisted = save_remote_share_settings(next).await?;
        *self.lock_settings()? = persisted;
        Ok(())
    }

    async fn clear_pending_ownership_change(&self) -> RemoteResult<()> {
        let current = self.lock_settings()?.clone();
        if current.pending_ownership_transaction_id.is_empty() {
            return Ok(());
        }
        self.apply_confirmed_ownership(current.code, current.ownership_revision, None)
            .await
    }

    async fn reconcile_pending_ownership_change(&self) -> RemoteResult<()> {
        let current = self.lock_settings()?.clone();
        if current.pending_ownership_transaction_id.is_empty() {
            return Ok(());
        }
        let identity = current.host_identity()?;
        let request = RemoteOwnershipChangeRequest {
            transaction_id: current.pending_ownership_transaction_id.clone(),
            host_id: identity.host_id(),
            public_key: identity.encoded_public_key(),
            expected_code: current.pending_ownership_expected_code.clone(),
            desired_code: current.pending_ownership_desired_code.clone(),
            expected_revision: current.pending_ownership_expected_revision,
            signature: identity.sign_code_change(
                &current.pending_ownership_transaction_id,
                &current.pending_ownership_expected_code,
                &current.pending_ownership_desired_code,
                current.pending_ownership_expected_revision,
            ),
        };
        let result: RemoteOwnershipChangeResult =
            post_remote_ownership("/v1/ownership/change", &request).await?;
        match result.status.as_str() {
            "changed" | "unchanged" | "stale_revision" => {
                self.apply_confirmed_ownership(result.code, result.revision, None)
                    .await
            }
            "occupied" | "identity_rejected" => self.clear_pending_ownership_change().await,
            _ => Err(RemoteShareError::unavailable(
                REMOTE_CODE_NETWORK_REQUIRED_ERROR,
            )),
        }
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
            session.queue_fill_in_progress = false;
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
        self.spawn_remote_next_queue_fill(client_id.to_string());
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
                advanced,
            )
        };
        if refill {
            self.spawn_remote_next_queue_fill(client_id.to_owned());
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
            session.queue_fill_in_progress = false;
            session.prefetch_target_tracks = REMOTE_PREFETCH_MIN_FUTURE_TRACKS;
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

    fn apply_prefetch_reserve(
        &self,
        client_id: &str,
        revision: u32,
        target_tracks: usize,
        buffer_seconds: u32,
    ) -> RemoteResult<()> {
        let target_tracks = target_tracks.clamp(
            REMOTE_PREFETCH_MIN_FUTURE_TRACKS,
            REMOTE_PREFETCH_MAX_FUTURE_TRACKS,
        );
        let accepted = {
            let mut sessions = self.lock_sessions()?;
            let session = sessions.by_client.entry(client_id.to_owned()).or_default();
            session.set_prefetch_target(revision, target_tracks)
        };
        if accepted {
            self.p2p_hls
                .set_reserve_buffer_seconds(client_id, buffer_seconds)
                .map_err(|error| RemoteShareError::internal(error.to_string()))?;
            log::info!(
                target: REMOTE_SHARE_LOG_TARGET,
                "remote_prefetch_reserve_updated target_tracks={target_tracks} buffer_seconds={buffer_seconds}"
            );
        }
        self.spawn_remote_next_queue_fill(client_id.to_owned());
        Ok(())
    }

    fn spawn_remote_next_queue_fill(&self, client_id: String) {
        let plan = {
            let Ok(mut sessions) = self.sessions.lock() else {
                return;
            };
            let Some(session) = sessions.by_client.get_mut(&client_id) else {
                return;
            };
            session.begin_queue_fill()
        };
        let Some(plan) = plan else {
            return;
        };
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let current = plan.current.clone();
            let title = current.music_name.clone();
            let started = Instant::now();
            let proposed = propose_remote_queue_suffix(
                &runtime.app,
                &current,
                &plan.existing_queue,
                &plan.recent_history,
                plan.target_tracks,
            )
            .await;
            let queue = match proposed {
                Ok(queue) => queue,
                Err(error) => {
                    runtime.finish_remote_queue_fill(&client_id, &current);
                    log::warn!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_next_queue_fill_failed title=\"{}\" error=\"{}\" elapsed_ms={}",
                        escape_remote_log_value(&title),
                        escape_remote_log_value(&error.to_string()),
                        started.elapsed().as_millis()
                    );
                    sleep(Duration::from_secs(5)).await;
                    runtime.spawn_remote_next_queue_fill(client_id);
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
                    runtime.finish_remote_queue_fill(&client_id, &current);
                    log::info!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_next_queue_fill_discarded title=\"{}\" reason=stale_session elapsed_ms={}",
                        escape_remote_log_value(&title),
                        started.elapsed().as_millis()
                    );
                    return;
                }
                Err(error) => {
                    runtime.finish_remote_queue_fill(&client_id, &current);
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
                match remote_p2p_hls_source(&runtime.app, track).await {
                    Ok(source) => published.push((track.clone(), source)),
                    Err(error) => {
                        rollback_remote_queue_append(
                            &runtime.sessions,
                            &client_id,
                            &current,
                            &committed,
                        );
                        runtime.finish_remote_queue_fill(&client_id, &current);
                        log::warn!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_p2p_hls_prefetch_source_failed title=\"{}\" error=\"{}\"",
                            escape_remote_log_value(&track.music_name),
                            escape_remote_log_value(&error.message)
                        );
                        sleep(Duration::from_secs(5)).await;
                        runtime.spawn_remote_next_queue_fill(client_id);
                        return;
                    }
                }
            }
            if !published.is_empty() {
                match runtime.p2p_hls.append_tracks(&client_id, published).await {
                    Ok(Some(snapshot)) => {
                        if let Err(error) = runtime
                            .send_hls_timeline_updated(&client_id, snapshot)
                            .await
                        {
                            log::warn!(
                                target: REMOTE_SHARE_LOG_TARGET,
                                "remote_p2p_hls_timeline_projection_failed error=\"{}\"",
                                escape_remote_log_value(&error.message)
                            );
                        }
                    }
                    Ok(None) => {
                        rollback_remote_queue_append(
                            &runtime.sessions,
                            &client_id,
                            &current,
                            &committed,
                        );
                        runtime.finish_remote_queue_fill(&client_id, &current);
                        log::info!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_next_queue_fill_discarded title=\"{}\" reason=stale_hls_session elapsed_ms={}",
                            escape_remote_log_value(&title),
                            started.elapsed().as_millis()
                        );
                        return;
                    }
                    Err(error) => {
                        rollback_remote_queue_append(
                            &runtime.sessions,
                            &client_id,
                            &current,
                            &committed,
                        );
                        runtime.finish_remote_queue_fill(&client_id, &current);
                        log::warn!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_p2p_hls_prefetch_failed error=\"{}\"",
                            escape_remote_log_value(&error.to_string())
                        );
                        sleep(Duration::from_secs(5)).await;
                        runtime.spawn_remote_next_queue_fill(client_id);
                        return;
                    }
                }
            }
            runtime.finish_remote_queue_fill(&client_id, &current);
            log::info!(
                target: REMOTE_SHARE_LOG_TARGET,
                "remote_next_queue_fill_finished title=\"{}\" committed={} target_tracks={} elapsed_ms={}",
                escape_remote_log_value(&title),
                committed.len(),
                plan.target_tracks,
                started.elapsed().as_millis()
            );
            if committed.is_empty() {
                sleep(Duration::from_secs(5)).await;
            }
            runtime.spawn_remote_next_queue_fill(client_id);
        });
    }

    fn finish_remote_queue_fill(&self, client_id: &str, current: &PlaybackTrack) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let Some(session) = sessions.by_client.get_mut(client_id) else {
            return;
        };
        session.finish_queue_fill(current);
    }

    fn reset_to_ready(&self, client_id: &str) -> RemoteResult<()> {
        let mut sessions = self.lock_sessions()?;
        let session = sessions.by_client.entry(client_id.to_string()).or_default();
        session.current = None;
        session.current_hls_entry_id = None;
        session.queue.clear();
        session.queue_fill_in_progress = false;
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
        session.queue_fill_in_progress = false;
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

fn generate_ownership_transaction_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::rng().fill(&mut bytes);
    hex::encode(bytes)
}

impl RemoteShareRuntime {
    async fn send_hls_timeline_updated(
        &self,
        client_id: &str,
        snapshot: P2pHlsSessionSnapshot,
    ) -> RemoteResult<()> {
        let hls = RemoteHlsSessionView::from(snapshot);
        self.p2p_transport
            .send_hls_timeline_to_client(client_id, &hls)
            .await
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
    fn set_prefetch_target(&mut self, revision: u32, target_tracks: usize) -> bool {
        if revision <= self.prefetch_revision {
            return false;
        }
        self.prefetch_revision = revision;
        let target_tracks = target_tracks.clamp(
            REMOTE_PREFETCH_MIN_FUTURE_TRACKS,
            REMOTE_PREFETCH_MAX_FUTURE_TRACKS,
        );
        if self.prefetch_target_tracks == target_tracks {
            return true;
        }
        self.prefetch_target_tracks = target_tracks;
        true
    }

    fn begin_queue_fill(&mut self) -> Option<RemoteQueueFillPlan> {
        if self.queue_fill_in_progress
            || self.state != RemotePlaybackState::Playing
            || self.queue.len() >= self.prefetch_target_tracks
        {
            return None;
        }
        let current = self.current.clone()?;
        self.queue_fill_in_progress = true;
        Some(RemoteQueueFillPlan {
            current,
            existing_queue: self.queue.iter().cloned().collect(),
            recent_history: self.recently_played.clone(),
            target_tracks: self.prefetch_target_tracks,
        })
    }

    fn finish_queue_fill(&mut self, current: &PlaybackTrack) {
        if self
            .current
            .as_ref()
            .is_some_and(|active| same_remote_track(active, current))
        {
            self.queue_fill_in_progress = false;
        }
    }

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
        self.queue_fill_in_progress = false;
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
        return save_remote_share_settings(settings).await;
    }
    save_remote_share_settings(RemoteShareSettings::default()).await
}

fn current_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn current_epoch_micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
        .min(u64::MAX as u128) as u64
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
