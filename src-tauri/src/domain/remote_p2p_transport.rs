use anyhow::{Result, anyhow};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::mpsc::{
    Receiver, Sender, UnboundedReceiver, UnboundedSender, channel as mpsc_channel,
    unbounded_channel,
};
use tokio::time::{Duration, timeout};
use webrtc::api::APIBuilder;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::data_channel_state::RTCDataChannelState;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

const REMOTE_SHARE_LOG_TARGET: &str = "remote_share";
const HLS_DATA_CHANNEL_LABEL: &str = "slisic.p2p-hls.v1";
const HLS_ASSET_MAX_MESSAGE_SIZE: usize = 16 * 1024;
const HLS_ASSET_CHUNK_HEADER_SIZE: usize = 12;
const HLS_ASSET_CHUNK_SIZE: usize = HLS_ASSET_MAX_MESSAGE_SIZE - HLS_ASSET_CHUNK_HEADER_SIZE;
const HLS_ASSET_CHUNK_MAGIC: &[u8; 4] = b"SLH1";
const HLS_DATA_CHANNEL_PROGRESS_LEASE: Duration = Duration::from_secs(5);
const HLS_DATA_CHANNEL_CAPACITY_POLL_INTERVAL: Duration = Duration::from_millis(20);
const HLS_DATA_CHANNEL_HIGH_WATERMARK: usize = HLS_ASSET_MAX_MESSAGE_SIZE * 4;
const HLS_DATA_CHANNEL_LOW_WATERMARK: usize = HLS_ASSET_MAX_MESSAGE_SIZE * 2;
const HLS_RESPONSE_INGEST_BUDGET: usize = 64;
const HLS_RESPONSE_QUEUE_CAPACITY: usize = 256;
const HLS_PROMOTION_CAPACITY: usize = 256;
const HLS_NEGOTIATION_LEASE: Duration = Duration::from_secs(10);

pub(super) type RemoteRelayEventSender = UnboundedSender<String>;
pub(super) type RemoteP2pResponseSender = Sender<RemoteP2pOutboundResponse>;

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum RemoteP2pAssetPriority {
    #[default]
    Foreground,
    Reserve,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteIceServer {
    pub(super) urls: Vec<String>,
    #[serde(default)]
    pub(super) username: String,
    #[serde(default)]
    pub(super) credential: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum RemoteP2pSignal {
    Offer {
        sdp: String,
        #[serde(default)]
        generation: u64,
        #[serde(default)]
        revision: u64,
    },
    Answer {
        sdp: String,
        #[serde(default)]
        generation: u64,
        #[serde(default)]
        revision: u64,
    },
    Candidate {
        candidate: RTCIceCandidateInit,
        #[serde(default)]
        generation: u64,
    },
    Close,
    Error {
        reason: String,
        generation: u64,
        revision: u64,
    },
}

pub(super) enum RemoteP2pTransportEvent {
    HlsAssetRequested {
        client_id: String,
        request_id: u32,
        url: String,
        playout_seconds: Option<f64>,
        priority: RemoteP2pAssetPriority,
        responses: RemoteP2pResponseSender,
    },
    PrefetchReserveRequested {
        client_id: String,
        revision: u32,
        target_tracks: usize,
        buffer_seconds: u32,
    },
    PlaybackReady {
        client_id: String,
        epoch: u64,
        ready_seconds: f64,
        playout_seconds: f64,
        protected_sequence: u64,
        responses: RemoteP2pResponseSender,
    },
    PlaybackHandoffCommit {
        client_id: String,
        epoch: u64,
        handoff_sequence: u64,
    },
    SupplyWriterStalled {
        client_id: String,
        generation: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteP2pWriterExit {
    InputClosed,
    Stalled,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum RemoteP2pDataChannelRequest {
    HlsAssetRequest {
        id: u32,
        url: String,
        #[serde(default)]
        playout_seconds: Option<f64>,
        #[serde(default)]
        priority: RemoteP2pAssetPriority,
    },
    HlsAssetPromote {
        id: u32,
    },
    HlsAssetCancelThrough {
        request_id: u32,
    },
    HlsAssetChunkAcknowledged {
        id: u32,
        chunk: u32,
    },
    PrefetchReserve {
        revision: u32,
        target_tracks: usize,
        buffer_seconds: u32,
    },
    PlaybackReady {
        epoch: u64,
        ready_seconds: f64,
        playout_seconds: f64,
        protected_sequence: u64,
    },
    PlaybackHandoffCommit {
        epoch: u64,
        handoff_sequence: u64,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RemoteP2pDataChannelResponse<'a> {
    HlsAssetResponse {
        id: u32,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        content_type: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        length: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        chunks: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
    },
}

pub(super) enum RemoteP2pOutboundResponse {
    Text {
        body: String,
        priority: RemoteP2pAssetPriority,
        request_id: Option<u32>,
    },
    Asset {
        request_id: u32,
        content_type: String,
        body: Bytes,
        priority: RemoteP2pAssetPriority,
    },
    Promote {
        request_id: u32,
    },
    Register {
        request_id: u32,
    },
    CancelThrough {
        request_id: u32,
    },
    Acknowledge {
        request_id: u32,
        chunk_index: u32,
    },
}

enum RemoteP2pOutboundFrame {
    Text(String),
    Binary {
        request_id: u32,
        chunk_index: u32,
        body: Bytes,
    },
}

#[derive(Default)]
struct RemoteP2pDeliveryWindow {
    chunks: HashMap<(u32, u32), usize>,
    bytes: usize,
}

impl RemoteP2pDeliveryWindow {
    fn can_admit(&self, bytes: usize) -> bool {
        self.bytes.saturating_add(bytes) <= HLS_DATA_CHANNEL_HIGH_WATERMARK
    }

    fn admit(&mut self, request_id: u32, chunk_index: u32, bytes: usize) -> bool {
        if !self.can_admit(bytes) || self.chunks.contains_key(&(request_id, chunk_index)) {
            return false;
        }
        self.chunks.insert((request_id, chunk_index), bytes);
        self.bytes += bytes;
        true
    }

    fn acknowledge(&mut self, request_id: u32, chunk_index: u32) -> bool {
        let Some(bytes) = self.chunks.remove(&(request_id, chunk_index)) else {
            return false;
        };
        self.bytes = self.bytes.saturating_sub(bytes);
        true
    }

    fn cancel_through(&mut self, request_id: u32) {
        self.chunks.retain(|(candidate_request_id, _), bytes| {
            if *candidate_request_id <= request_id {
                self.bytes = self.bytes.saturating_sub(*bytes);
                false
            } else {
                true
            }
        });
    }
}

struct RemoteP2pScheduledAsset {
    request_id: u32,
    content_type: String,
    body: Bytes,
    priority: RemoteP2pAssetPriority,
    header_sent: bool,
    offset: usize,
    chunk_index: u32,
}

enum RemoteP2pScheduledResponse {
    Text(String),
    Asset(RemoteP2pScheduledAsset),
}

#[derive(Default)]
struct RemoteP2pOutboundScheduler {
    foreground: VecDeque<RemoteP2pScheduledResponse>,
    reserve: VecDeque<RemoteP2pScheduledResponse>,
    promoted: VecDeque<u32>,
    requested: HashSet<u32>,
    cancel_through: u32,
}

impl RemoteP2pOutboundScheduler {
    fn push(&mut self, response: RemoteP2pOutboundResponse) {
        let (priority, response) = match response {
            RemoteP2pOutboundResponse::Text {
                body,
                priority,
                request_id,
            } => {
                if let Some(request_id) = request_id {
                    self.requested.remove(&request_id);
                    if let Some(index) = self
                        .promoted
                        .iter()
                        .position(|promoted| *promoted == request_id)
                    {
                        self.promoted.remove(index);
                    }
                }
                (priority, RemoteP2pScheduledResponse::Text(body))
            }
            RemoteP2pOutboundResponse::Asset {
                request_id,
                content_type,
                body,
                priority,
            } => {
                if request_id <= self.cancel_through {
                    return;
                }
                let priority = if let Some(index) = self
                    .promoted
                    .iter()
                    .position(|promoted| *promoted == request_id)
                {
                    self.promoted.remove(index);
                    RemoteP2pAssetPriority::Foreground
                } else {
                    priority
                };
                (
                    priority,
                    RemoteP2pScheduledResponse::Asset(RemoteP2pScheduledAsset {
                        request_id,
                        content_type,
                        body,
                        priority,
                        header_sent: false,
                        offset: 0,
                        chunk_index: 0,
                    }),
                )
            }
            RemoteP2pOutboundResponse::Promote { request_id } => {
                self.promote(request_id);
                return;
            }
            RemoteP2pOutboundResponse::Register { request_id } => {
                if request_id <= self.cancel_through {
                    return;
                }
                self.requested.insert(request_id);
                return;
            }
            RemoteP2pOutboundResponse::CancelThrough { request_id } => {
                self.cancel_through(request_id);
                return;
            }
            RemoteP2pOutboundResponse::Acknowledge { .. } => return,
        };
        self.queue(priority).push_back(response);
    }

    fn promote(&mut self, request_id: u32) {
        if !self.requested.contains(&request_id) {
            return;
        }
        let Some(index) = self.reserve.iter().position(|response| {
            matches!(
                response,
                RemoteP2pScheduledResponse::Asset(asset) if asset.request_id == request_id
            )
        }) else {
            if self.promoted.contains(&request_id) {
                return;
            }
            if self.promoted.len() == HLS_PROMOTION_CAPACITY {
                self.promoted.pop_front();
            }
            self.promoted.push_back(request_id);
            return;
        };
        let Some(RemoteP2pScheduledResponse::Asset(mut asset)) = self.reserve.remove(index) else {
            return;
        };
        asset.priority = RemoteP2pAssetPriority::Foreground;
        self.foreground
            .push_back(RemoteP2pScheduledResponse::Asset(asset));
    }

    fn cancel_through(&mut self, request_id: u32) {
        self.cancel_through = self.cancel_through.max(request_id);
        self.requested
            .retain(|requested| *requested > self.cancel_through);
        self.promoted
            .retain(|promoted| *promoted > self.cancel_through);
        self.foreground.retain(|response| {
            !matches!(
                response,
                RemoteP2pScheduledResponse::Asset(asset) if asset.request_id <= self.cancel_through
            )
        });
        self.reserve.retain(|response| {
            !matches!(
                response,
                RemoteP2pScheduledResponse::Asset(asset) if asset.request_id <= self.cancel_through
            )
        });
    }

    fn next_transmission(&mut self) -> Option<Vec<RemoteP2pOutboundFrame>> {
        let response = self
            .foreground
            .pop_front()
            .or_else(|| self.reserve.pop_front())?;
        match response {
            RemoteP2pScheduledResponse::Text(body) => {
                Some(vec![RemoteP2pOutboundFrame::Text(body)])
            }
            RemoteP2pScheduledResponse::Asset(mut asset) => {
                let mut frames = Vec::with_capacity(2);
                if !asset.header_sent {
                    asset.header_sent = true;
                    let header = encode_hls_asset_response(
                        asset.request_id,
                        &asset.content_type,
                        asset.body.len(),
                    )
                    .ok()?;
                    frames.push(RemoteP2pOutboundFrame::Text(header));
                }
                if asset.offset < asset.body.len() {
                    let end = (asset.offset + HLS_ASSET_CHUNK_SIZE).min(asset.body.len());
                    frames.push(RemoteP2pOutboundFrame::Binary {
                        request_id: asset.request_id,
                        chunk_index: asset.chunk_index,
                        body: encode_hls_asset_chunk(
                            asset.request_id,
                            asset.chunk_index,
                            &asset.body[asset.offset..end],
                        ),
                    });
                    asset.offset = end;
                    asset.chunk_index += 1;
                }
                if asset.offset < asset.body.len() {
                    let priority = asset.priority;
                    self.queue(priority)
                        .push_back(RemoteP2pScheduledResponse::Asset(asset));
                } else {
                    self.requested.remove(&asset.request_id);
                    if let Some(index) = self
                        .promoted
                        .iter()
                        .position(|promoted| *promoted == asset.request_id)
                    {
                        self.promoted.remove(index);
                    }
                }
                Some(frames)
            }
        }
    }

    fn queue(
        &mut self,
        priority: RemoteP2pAssetPriority,
    ) -> &mut VecDeque<RemoteP2pScheduledResponse> {
        match priority {
            RemoteP2pAssetPriority::Foreground => &mut self.foreground,
            RemoteP2pAssetPriority::Reserve => &mut self.reserve,
        }
    }
}

fn encode_hls_asset_response(request_id: u32, content_type: &str, length: usize) -> Result<String> {
    Ok(serde_json::to_string(
        &RemoteP2pDataChannelResponse::HlsAssetResponse {
            id: request_id,
            ok: true,
            content_type: Some(content_type),
            length: Some(length),
            chunks: Some(length.div_ceil(HLS_ASSET_CHUNK_SIZE)),
            error: None,
        },
    )?)
}

#[derive(Serialize)]
struct RemoteP2pHlsTimelineUpdate<'a, T> {
    #[serde(rename = "type")]
    message_type: &'static str,
    hls: &'a T,
}

fn encode_hls_timeline_update<T: Serialize>(hls: &T) -> Result<String> {
    Ok(serde_json::to_string(&RemoteP2pHlsTimelineUpdate {
        message_type: "hls_timeline_updated",
        hls,
    })?)
}

struct RemoteP2pPeer {
    generation: u64,
    connection: Arc<RTCPeerConnection>,
    negotiation: tokio::sync::Mutex<RemoteP2pNegotiation>,
}

#[derive(Default)]
struct RemoteP2pNegotiation {
    offer_sdp: Option<String>,
    answer_sdp: Option<String>,
}

pub(super) struct RemoteP2pTransport {
    peers: tokio::sync::Mutex<HashMap<String, Arc<RemoteP2pPeer>>>,
    ice_servers: Mutex<Vec<RTCIceServer>>,
    relay_events: Mutex<Option<RemoteRelayEventSender>>,
    events: UnboundedSender<RemoteP2pTransportEvent>,
}

impl RemoteP2pTransport {
    pub(super) fn new() -> (Arc<Self>, UnboundedReceiver<RemoteP2pTransportEvent>) {
        let (events, receiver) = unbounded_channel();
        (
            Arc::new(Self {
                peers: tokio::sync::Mutex::new(HashMap::new()),
                ice_servers: Mutex::new(Vec::new()),
                relay_events: Mutex::new(None),
                events,
            }),
            receiver,
        )
    }

    pub(super) fn set_relay_events(&self, sender: RemoteRelayEventSender) {
        *self
            .relay_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sender);
    }

    pub(super) fn send_relay_frame(&self, frame: String) -> Result<()> {
        self.relay_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .ok_or_else(|| anyhow!("remote relay is not connected"))?
            .send(frame)
            .map_err(|_| anyhow!("remote relay outbound channel is closed"))
    }

    pub(super) fn update_ice_servers(&self, servers: Vec<RemoteIceServer>) {
        *self
            .ice_servers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = servers
            .into_iter()
            .filter(|server| !server.urls.is_empty())
            .map(|server| RTCIceServer {
                urls: server.urls,
                username: server.username,
                credential: server.credential,
                ..Default::default()
            })
            .collect();
    }

    pub(super) async fn handle_signal(
        self: &Arc<Self>,
        client_id: &str,
        signal: RemoteP2pSignal,
    ) -> Result<()> {
        match signal {
            RemoteP2pSignal::Offer {
                sdp,
                generation,
                revision,
            } => {
                self.accept_offer(client_id, generation, revision, sdp)
                    .await
            }
            RemoteP2pSignal::Candidate {
                candidate,
                generation,
            } => {
                let peer = self.peer(client_id).await?;
                if peer.generation == generation {
                    peer.connection.add_ice_candidate(candidate).await?;
                }
                Ok(())
            }
            RemoteP2pSignal::Close => self.close_peer(client_id).await,
            RemoteP2pSignal::Answer { .. } | RemoteP2pSignal::Error { .. } => Ok(()),
        }
    }

    pub(super) async fn close_all(&self) {
        let peers = {
            let mut peers = self.peers.lock().await;
            peers.drain().map(|(_, peer)| peer).collect::<Vec<_>>()
        };
        for peer in peers {
            let _ = peer.connection.close().await;
        }
    }

    pub(super) async fn send_hls_asset(
        responses: &RemoteP2pResponseSender,
        request_id: u32,
        content_type: &str,
        body: Bytes,
        priority: RemoteP2pAssetPriority,
    ) -> Result<()> {
        responses
            .send(RemoteP2pOutboundResponse::Asset {
                request_id,
                content_type: content_type.to_owned(),
                body,
                priority,
            })
            .await
            .map_err(|_| anyhow!("remote P2P response writer is closed"))
    }

    pub(super) async fn send_hls_asset_error(
        responses: &RemoteP2pResponseSender,
        request_id: u32,
        error: &str,
    ) -> Result<()> {
        responses
            .send(RemoteP2pOutboundResponse::Text {
                body: serde_json::to_string(&RemoteP2pDataChannelResponse::HlsAssetResponse {
                    id: request_id,
                    ok: false,
                    content_type: None,
                    length: None,
                    chunks: None,
                    error: Some(error),
                })?,
                priority: RemoteP2pAssetPriority::Foreground,
                request_id: Some(request_id),
            })
            .await
            .map_err(|_| anyhow!("remote P2P response writer is closed"))
    }

    pub(super) async fn send_hls_timeline<T: Serialize>(
        responses: &RemoteP2pResponseSender,
        hls: &T,
    ) -> Result<()> {
        responses
            .send(RemoteP2pOutboundResponse::Text {
                body: encode_hls_timeline_update(hls)?,
                priority: RemoteP2pAssetPriority::Foreground,
                request_id: None,
            })
            .await
            .map_err(|_| anyhow!("remote P2P response writer is closed"))
    }

    pub(super) async fn send_handoff_offer(
        responses: &RemoteP2pResponseSender,
        epoch: u64,
        handoff_sequence: u64,
    ) -> Result<()> {
        responses
            .send(RemoteP2pOutboundResponse::Text {
                body: serde_json::json!({
                    "type": "playback_handoff_offer",
                    "epoch": epoch,
                    "handoffSequence": handoff_sequence,
                })
                .to_string(),
                priority: RemoteP2pAssetPriority::Foreground,
                request_id: None,
            })
            .await
            .map_err(|_| anyhow!("remote P2P response writer is closed"))
    }

    async fn send_hls_promotion(
        responses: &RemoteP2pResponseSender,
        request_id: u32,
    ) -> Result<()> {
        responses
            .send(RemoteP2pOutboundResponse::Promote { request_id })
            .await
            .map_err(|_| anyhow!("remote P2P response writer is closed"))
    }

    async fn send_hls_cancellation_through(
        responses: &RemoteP2pResponseSender,
        request_id: u32,
    ) -> Result<()> {
        responses
            .send(RemoteP2pOutboundResponse::CancelThrough { request_id })
            .await
            .map_err(|_| anyhow!("remote P2P response writer is closed"))
    }

    async fn register_hls_request(
        responses: &RemoteP2pResponseSender,
        request_id: u32,
    ) -> Result<()> {
        responses
            .send(RemoteP2pOutboundResponse::Register { request_id })
            .await
            .map_err(|_| anyhow!("remote P2P response writer is closed"))
    }

    async fn accept_offer(
        self: &Arc<Self>,
        client_id: &str,
        generation: u64,
        revision: u64,
        sdp: String,
    ) -> Result<()> {
        let existing = {
            let peers = self.peers.lock().await;
            peers.get(client_id).cloned()
        };
        let peer = match existing {
            Some(peer)
                if peer.generation == generation
                    && !matches!(
                        peer.connection.connection_state(),
                        RTCPeerConnectionState::Closed | RTCPeerConnectionState::Failed
                    ) =>
            {
                peer
            }
            _ => self.create_peer(client_id, generation).await?,
        };
        if peer.generation != generation {
            return Ok(());
        }
        let mut negotiation = peer.negotiation.lock().await;
        if negotiation.offer_sdp.as_deref() == Some(sdp.as_str()) {
            if let Some(answer_sdp) = negotiation.answer_sdp.clone() {
                drop(negotiation);
                self.emit_signal(
                    client_id,
                    RemoteP2pSignal::Answer {
                        sdp: answer_sdp,
                        generation,
                        revision,
                    },
                );
                return Ok(());
            }
        }
        let answer_sdp = await_hls_negotiation(
            async {
                peer.connection
                    .set_configuration(RTCConfiguration {
                        ice_servers: self.current_ice_servers(),
                        ..Default::default()
                    })
                    .await?;
                peer.connection
                    .set_remote_description(RTCSessionDescription::offer(sdp.clone())?)
                    .await?;
                let answer = peer.connection.create_answer(None).await?;
                peer.connection
                    .set_local_description(answer.clone())
                    .await?;
                Ok(answer.sdp)
            },
            HLS_NEGOTIATION_LEASE,
            "remote P2P negotiation",
        )
        .await;
        let answer_sdp = match answer_sdp {
            Ok(answer_sdp) => answer_sdp,
            Err(error) => {
                drop(negotiation);
                self.discard_peer(client_id, &peer).await;
                return Err(error);
            }
        };
        negotiation.offer_sdp = Some(sdp);
        negotiation.answer_sdp = Some(answer_sdp.clone());
        drop(negotiation);
        self.emit_signal(
            client_id,
            RemoteP2pSignal::Answer {
                sdp: answer_sdp,
                generation,
                revision,
            },
        );
        Ok(())
    }

    async fn create_peer(
        self: &Arc<Self>,
        client_id: &str,
        generation: u64,
    ) -> Result<Arc<RemoteP2pPeer>> {
        let connection = Arc::new(
            APIBuilder::new()
                .build()
                .new_peer_connection(RTCConfiguration {
                    ice_servers: self.current_ice_servers(),
                    ..Default::default()
                })
                .await?,
        );
        let weak = Arc::downgrade(self);
        let candidate_client_id = client_id.to_owned();
        let candidate_generation = generation;
        connection.on_ice_candidate(Box::new(move |candidate| {
            let weak = Weak::clone(&weak);
            let client_id = candidate_client_id.clone();
            Box::pin(async move {
                let (Some(candidate), Some(owner)) = (candidate, weak.upgrade()) else {
                    return;
                };
                if let Ok(candidate) = candidate.to_json() {
                    owner.emit_signal(
                        &client_id,
                        RemoteP2pSignal::Candidate {
                            candidate,
                            generation: candidate_generation,
                        },
                    );
                }
            })
        }));
        let events = self.events.clone();
        let channel_client_id = client_id.to_owned();
        let channel_generation = generation;
        connection.on_data_channel(Box::new(move |channel| {
            let events = events.clone();
            let client_id = channel_client_id.clone();
            Box::pin(async move {
                attach_hls_data_channel(events, client_id, channel_generation, channel)
            })
        }));
        connection.on_peer_connection_state_change(Box::new(move |state| {
            Box::pin(async move {
                match state {
                    RTCPeerConnectionState::Connected => log::info!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_p2p_transport_connected"
                    ),
                    RTCPeerConnectionState::Disconnected | RTCPeerConnectionState::Failed => {
                        log::warn!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_p2p_transport_unhealthy state={state:?} recovery=await_ice_restart"
                        )
                    }
                    _ => {}
                }
            })
        }));
        let peer = Arc::new(RemoteP2pPeer {
            generation,
            connection,
            negotiation: tokio::sync::Mutex::new(RemoteP2pNegotiation::default()),
        });
        let mut peers = self.peers.lock().await;
        if let Some(existing) = peers.get(client_id) {
            let existing = existing.clone();
            if existing.generation > generation {
                drop(peers);
                let _ = peer.connection.close().await;
                return Ok(existing);
            }
            if existing.generation < generation
                || matches!(
                    existing.connection.connection_state(),
                    RTCPeerConnectionState::Closed | RTCPeerConnectionState::Failed
                )
            {
                peers.insert(client_id.to_owned(), peer.clone());
                drop(peers);
                let _ = existing.connection.close().await;
                return Ok(peer);
            }
            drop(peers);
            let _ = peer.connection.close().await;
            return Ok(existing);
        }
        peers.insert(client_id.to_owned(), peer.clone());
        Ok(peer)
    }

    async fn close_peer(&self, client_id: &str) -> Result<()> {
        if let Some(peer) = self.peers.lock().await.remove(client_id) {
            peer.connection.close().await?;
        }
        Ok(())
    }

    pub(super) async fn invalidate_supply(&self, client_id: &str, generation: u64) {
        let removed = {
            let mut peers = self.peers.lock().await;
            match peers.get(client_id) {
                Some(peer) if peer.generation == generation => peers.remove(client_id),
                _ => None,
            }
        };
        let Some(peer) = removed else {
            return;
        };
        self.emit_signal(
            client_id,
            RemoteP2pSignal::Error {
                reason: "supply_stalled".to_owned(),
                generation,
                revision: 0,
            },
        );
        let _ = peer.connection.close().await;
    }

    async fn discard_peer(&self, client_id: &str, expected: &Arc<RemoteP2pPeer>) {
        let removed = {
            let mut peers = self.peers.lock().await;
            match peers.get(client_id) {
                Some(current) if Arc::ptr_eq(current, expected) => peers.remove(client_id),
                _ => None,
            }
        };
        if let Some(peer) = removed {
            let _ = peer.connection.close().await;
        }
    }

    async fn peer(&self, client_id: &str) -> Result<Arc<RemoteP2pPeer>> {
        self.peers
            .lock()
            .await
            .get(client_id)
            .cloned()
            .ok_or_else(|| anyhow!("remote P2P peer is not ready"))
    }

    fn current_ice_servers(&self) -> Vec<RTCIceServer> {
        self.ice_servers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn emit_signal(&self, client_id: &str, signal: RemoteP2pSignal) {
        let Ok(frame) = serde_json::to_string(&serde_json::json!({
            "kind": "p2p_signal",
            "clientId": client_id,
            "signal": signal,
        })) else {
            return;
        };
        if self.send_relay_frame(frame).is_err() {
            log::warn!(
                target: REMOTE_SHARE_LOG_TARGET,
                "remote_p2p_signal_send_failed reason=relay_closed"
            );
        }
    }
}

async fn await_hls_negotiation<T, F>(future: F, lease: Duration, label: &str) -> Result<T>
where
    F: Future<Output = Result<T>>,
{
    timeout(lease, future)
        .await
        .map_err(|_| anyhow!("{label} timed out"))?
}

fn attach_hls_data_channel(
    events: UnboundedSender<RemoteP2pTransportEvent>,
    client_id: String,
    generation: u64,
    channel: Arc<RTCDataChannel>,
) {
    if channel.label() != HLS_DATA_CHANNEL_LABEL {
        return;
    }
    let (responses, response_receiver) = mpsc_channel(HLS_RESPONSE_QUEUE_CAPACITY);
    let writer_events = events.clone();
    let writer_client_id = client_id.clone();
    let writer_channel = Arc::clone(&channel);
    tokio::spawn(async move {
        if run_hls_data_channel_writer(writer_channel, response_receiver).await
            == RemoteP2pWriterExit::Stalled
        {
            let _ = writer_events.send(RemoteP2pTransportEvent::SupplyWriterStalled {
                client_id: writer_client_id,
                generation,
            });
        }
    });
    channel.on_message(Box::new(move |message: DataChannelMessage| {
        let events = events.clone();
        let client_id = client_id.clone();
        let responses = responses.clone();
        Box::pin(async move {
            if !message.is_string {
                return;
            }
            let Ok(text) = String::from_utf8(message.data.to_vec()) else {
                return;
            };
            let Ok(request) = serde_json::from_str(&text) else {
                return;
            };
            let event = match request {
                RemoteP2pDataChannelRequest::HlsAssetRequest {
                    id,
                    url,
                    playout_seconds,
                    priority,
                } => {
                    if RemoteP2pTransport::register_hls_request(&responses, id)
                        .await
                        .is_err()
                    {
                        return;
                    }
                    RemoteP2pTransportEvent::HlsAssetRequested {
                        client_id,
                        request_id: id,
                        url,
                        playout_seconds,
                        priority,
                        responses,
                    }
                }
                RemoteP2pDataChannelRequest::HlsAssetPromote { id } => {
                    let _ = RemoteP2pTransport::send_hls_promotion(&responses, id).await;
                    return;
                }
                RemoteP2pDataChannelRequest::HlsAssetCancelThrough { request_id } => {
                    let _ =
                        RemoteP2pTransport::send_hls_cancellation_through(&responses, request_id)
                            .await;
                    return;
                }
                RemoteP2pDataChannelRequest::HlsAssetChunkAcknowledged { id, chunk } => {
                    let _ = responses
                        .send(RemoteP2pOutboundResponse::Acknowledge {
                            request_id: id,
                            chunk_index: chunk,
                        })
                        .await;
                    return;
                }
                RemoteP2pDataChannelRequest::PrefetchReserve {
                    revision,
                    target_tracks,
                    buffer_seconds,
                } => RemoteP2pTransportEvent::PrefetchReserveRequested {
                    client_id,
                    revision,
                    target_tracks,
                    buffer_seconds,
                },
                RemoteP2pDataChannelRequest::PlaybackReady {
                    epoch,
                    ready_seconds,
                    playout_seconds,
                    protected_sequence,
                } => RemoteP2pTransportEvent::PlaybackReady {
                    client_id,
                    epoch,
                    ready_seconds,
                    playout_seconds,
                    protected_sequence,
                    responses,
                },
                RemoteP2pDataChannelRequest::PlaybackHandoffCommit {
                    epoch,
                    handoff_sequence,
                } => RemoteP2pTransportEvent::PlaybackHandoffCommit {
                    client_id,
                    epoch,
                    handoff_sequence,
                },
            };
            let _ = events.send(event);
        })
    }));
}

async fn run_hls_data_channel_writer(
    channel: Arc<RTCDataChannel>,
    mut responses: Receiver<RemoteP2pOutboundResponse>,
) -> RemoteP2pWriterExit {
    let mut scheduler = RemoteP2pOutboundScheduler::default();
    let mut delivery = RemoteP2pDeliveryWindow::default();
    loop {
        ingest_hls_responses(
            &mut responses,
            &mut scheduler,
            &mut delivery,
            HLS_RESPONSE_INGEST_BUDGET,
        );
        let Some(transmission) = scheduler.next_transmission() else {
            let Some(response) = responses.recv().await else {
                return RemoteP2pWriterExit::InputClosed;
            };
            apply_hls_response(response, &mut scheduler, &mut delivery);
            continue;
        };
        let binary_bytes = transmission
            .iter()
            .map(|frame| match frame {
                RemoteP2pOutboundFrame::Text(_) => 0,
                RemoteP2pOutboundFrame::Binary { body, .. } => body.len(),
            })
            .sum();
        if !await_hls_delivery_capacity(
            &channel,
            &mut responses,
            &mut scheduler,
            &mut delivery,
            binary_bytes,
        )
        .await
        {
            return RemoteP2pWriterExit::InputClosed;
        }
        for frame in transmission {
            let result = match frame {
                RemoteP2pOutboundFrame::Text(body) => {
                    await_hls_data_channel_send(
                        channel.send_text(body),
                        HLS_DATA_CHANNEL_PROGRESS_LEASE,
                    )
                    .await
                }
                RemoteP2pOutboundFrame::Binary {
                    request_id,
                    chunk_index,
                    body,
                } => {
                    if !delivery.admit(request_id, chunk_index, body.len()) {
                        log::error!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_p2p_delivery_window_invariant_failed request_id={} chunk_index={} bytes={}",
                            request_id,
                            chunk_index,
                            body.len()
                        );
                        return RemoteP2pWriterExit::Stalled;
                    }
                    await_hls_data_channel_send(
                        channel.send(&body),
                        HLS_DATA_CHANNEL_PROGRESS_LEASE,
                    )
                    .await
                }
            };
            let Some(result) = result else {
                log::warn!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_p2p_response_writer_stalled phase=send recovery=close_supply_epoch"
                );
                let _ = channel.close().await;
                return RemoteP2pWriterExit::Stalled;
            };
            if let Err(error) = result {
                log::warn!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_p2p_response_writer_failed error=\"{}\"",
                    error
                );
                return RemoteP2pWriterExit::Stalled;
            }
        }
    }
}

fn ingest_hls_responses(
    responses: &mut Receiver<RemoteP2pOutboundResponse>,
    scheduler: &mut RemoteP2pOutboundScheduler,
    delivery: &mut RemoteP2pDeliveryWindow,
    budget: usize,
) -> usize {
    let mut ingested = 0;
    while ingested < budget {
        let Ok(response) = responses.try_recv() else {
            break;
        };
        apply_hls_response(response, scheduler, delivery);
        ingested += 1;
    }
    ingested
}

fn apply_hls_response(
    response: RemoteP2pOutboundResponse,
    scheduler: &mut RemoteP2pOutboundScheduler,
    delivery: &mut RemoteP2pDeliveryWindow,
) {
    match response {
        RemoteP2pOutboundResponse::Acknowledge {
            request_id,
            chunk_index,
        } => {
            delivery.acknowledge(request_id, chunk_index);
        }
        RemoteP2pOutboundResponse::CancelThrough { request_id } => {
            delivery.cancel_through(request_id);
            scheduler.push(RemoteP2pOutboundResponse::CancelThrough { request_id });
        }
        response => scheduler.push(response),
    }
}

async fn await_hls_delivery_capacity(
    channel: &RTCDataChannel,
    responses: &mut Receiver<RemoteP2pOutboundResponse>,
    scheduler: &mut RemoteP2pOutboundScheduler,
    delivery: &mut RemoteP2pDeliveryWindow,
    next_bytes: usize,
) -> bool {
    if delivery.can_admit(next_bytes) {
        return true;
    }
    while delivery.bytes > HLS_DATA_CHANNEL_LOW_WATERMARK {
        if channel.ready_state() != RTCDataChannelState::Open {
            return false;
        }
        match timeout(HLS_DATA_CHANNEL_CAPACITY_POLL_INTERVAL, responses.recv()).await {
            Ok(Some(response)) => apply_hls_response(response, scheduler, delivery),
            Ok(None) => return false,
            Err(_) => {}
        }
    }
    delivery.can_admit(next_bytes)
}

async fn await_hls_data_channel_send<F, T>(send: F, lease: Duration) -> Option<T>
where
    F: Future<Output = T>,
{
    timeout(lease, send).await.ok()
}

fn encode_hls_asset_chunk(request_id: u32, chunk_index: u32, chunk: &[u8]) -> Bytes {
    let mut packet = Vec::with_capacity(12 + chunk.len());
    packet.extend_from_slice(HLS_ASSET_CHUNK_MAGIC);
    packet.extend_from_slice(&request_id.to_be_bytes());
    packet.extend_from_slice(&chunk_index.to_be_bytes());
    packet.extend_from_slice(chunk);
    Bytes::from(packet)
}

#[cfg(test)]
#[path = "remote_p2p_transport.test.rs"]
mod tests;
