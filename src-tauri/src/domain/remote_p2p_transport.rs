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
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio::time::{Duration, sleep, timeout};
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
const HLS_CONTROL_CHANNEL_LABEL: &str = "slisic.p2p-hls.control.v2";
const HLS_MEDIA_CHANNEL_LABEL: &str = "slisic.p2p-hls.media.v2";
const HLS_ASSET_MAX_MESSAGE_SIZE: usize = 1_200;
const HLS_ASSET_CHUNK_HEADER_SIZE: usize = 12;
const HLS_ASSET_CHUNK_SIZE: usize = HLS_ASSET_MAX_MESSAGE_SIZE - HLS_ASSET_CHUNK_HEADER_SIZE;
const HLS_ASSET_MAX_BYTES: usize = 8 * 1024 * 1024;
const HLS_ASSET_CHUNK_MAGIC: &[u8; 4] = b"SLH1";
const HLS_DATA_CHANNEL_CAPACITY_POLL_INTERVAL: Duration = Duration::from_millis(20);
const HLS_DATA_CHANNEL_HIGH_WATERMARK: usize = 64 * 1024;
const HLS_DATA_CHANNEL_LOW_WATERMARK: usize = 32 * 1024;
const HLS_RESPONSE_INGEST_BUDGET: usize = 64;
const HLS_RESPONSE_QUEUE_CAPACITY: usize = 256;
const HLS_PROMOTION_CAPACITY: usize = 256;
const HLS_CANCELLATION_CAPACITY: usize = HLS_RESPONSE_QUEUE_CAPACITY;
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
        attempt: u32,
        chunk_indices: Option<Vec<u32>>,
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
        attempt: u32,
        #[serde(default)]
        playout_seconds: Option<f64>,
        #[serde(default)]
        priority: RemoteP2pAssetPriority,
    },
    HlsAssetRepair {
        id: u32,
        url: String,
        chunks: Vec<u32>,
        #[serde(default)]
        attempt: u32,
        #[serde(default)]
        playout_seconds: Option<f64>,
        #[serde(default)]
        priority: RemoteP2pAssetPriority,
    },
    HlsAssetPromote {
        id: u32,
    },
    HlsAssetCancel {
        ids: Vec<u32>,
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
        priority: RemoteP2pOutboundPriority,
        request_id: Option<u32>,
    },
    Asset {
        request_id: u32,
        content_type: String,
        body: Bytes,
        priority: RemoteP2pAssetPriority,
        attempt: u32,
        chunk_indices: Option<Vec<u32>>,
    },
    Promote {
        request_id: u32,
    },
    Register {
        request_id: u32,
    },
    Cancel {
        request_ids: Vec<u32>,
    },
}

enum RemoteP2pOutboundFrame {
    Text(String),
    Binary(Bytes),
}

impl RemoteP2pOutboundFrame {
    fn encoded_len(&self) -> usize {
        match self {
            Self::Text(body) => body.len(),
            Self::Binary(body) => body.len(),
        }
    }
}

struct RemoteP2pScheduledAsset {
    request_id: u32,
    content_type: String,
    body: Bytes,
    priority: RemoteP2pAssetPriority,
    attempt: u32,
    header_sent: bool,
    chunk_indices: VecDeque<u32>,
}

enum RemoteP2pScheduledResponse {
    Text {
        body: String,
        request_id: Option<u32>,
    },
    Asset(RemoteP2pScheduledAsset),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RemoteP2pOutboundQueue {
    Control,
    Foreground,
    Reserve,
}

#[derive(Default)]
struct RemoteP2pSendWindow {
    bytes: usize,
}

impl RemoteP2pSendWindow {
    fn can_admit(&self, bytes: usize) -> bool {
        self.bytes
            .checked_add(bytes)
            .is_some_and(|total| total <= HLS_DATA_CHANNEL_HIGH_WATERMARK)
    }

    fn admit(&mut self, bytes: usize) -> bool {
        if !self.can_admit(bytes) {
            return false;
        }
        self.bytes += bytes;
        true
    }

    fn complete(&mut self, bytes: usize) {
        self.bytes = self
            .bytes
            .checked_sub(bytes)
            .expect("each admitted send must complete exactly once");
    }
}

#[derive(Clone, Copy)]
pub(super) enum RemoteP2pOutboundPriority {
    Control,
    Foreground,
    Reserve,
}

impl From<RemoteP2pAssetPriority> for RemoteP2pOutboundPriority {
    fn from(priority: RemoteP2pAssetPriority) -> Self {
        match priority {
            RemoteP2pAssetPriority::Foreground => Self::Foreground,
            RemoteP2pAssetPriority::Reserve => Self::Reserve,
        }
    }
}

fn outbound_asset_priority(
    content_type: &str,
    priority: RemoteP2pAssetPriority,
) -> RemoteP2pOutboundPriority {
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim();
    if media_type.eq_ignore_ascii_case("application/vnd.apple.mpegurl")
        || media_type.eq_ignore_ascii_case("application/x-mpegurl")
    {
        RemoteP2pOutboundPriority::Control
    } else {
        priority.into()
    }
}

fn outbound_request_priority(
    url: &str,
    priority: RemoteP2pAssetPriority,
) -> RemoteP2pOutboundPriority {
    if url.ends_with(".m3u8") {
        RemoteP2pOutboundPriority::Control
    } else {
        priority.into()
    }
}

fn scheduled_request_id(response: &RemoteP2pScheduledResponse) -> Option<u32> {
    match response {
        RemoteP2pScheduledResponse::Text { request_id, .. } => *request_id,
        RemoteP2pScheduledResponse::Asset(asset) => Some(asset.request_id),
    }
}

#[derive(Default)]
struct RemoteP2pOutboundScheduler {
    control: VecDeque<RemoteP2pScheduledResponse>,
    foreground: VecDeque<RemoteP2pScheduledResponse>,
    reserve: VecDeque<RemoteP2pScheduledResponse>,
    promoted: VecDeque<u32>,
    requested: HashSet<u32>,
    cancelled: VecDeque<u32>,
    control_sent_since_media: bool,
}

impl RemoteP2pOutboundScheduler {
    fn is_empty(&self) -> bool {
        self.control.is_empty() && self.foreground.is_empty() && self.reserve.is_empty()
    }

    fn push(&mut self, response: RemoteP2pOutboundResponse) {
        let (priority, response) = match response {
            RemoteP2pOutboundResponse::Text {
                body,
                priority,
                request_id,
            } => {
                if let Some(request_id) = request_id {
                    if self.take_cancelled(request_id) {
                        self.requested.remove(&request_id);
                        return;
                    }
                    self.requested.remove(&request_id);
                    if let Some(index) = self
                        .promoted
                        .iter()
                        .position(|promoted| *promoted == request_id)
                    {
                        self.promoted.remove(index);
                    }
                }
                (
                    priority,
                    RemoteP2pScheduledResponse::Text { body, request_id },
                )
            }
            RemoteP2pOutboundResponse::Asset {
                request_id,
                content_type,
                body,
                priority,
                attempt,
                chunk_indices,
            } => {
                if self.take_cancelled(request_id) {
                    self.requested.remove(&request_id);
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
                let outbound_priority = outbound_asset_priority(&content_type, priority);
                let chunk_indices = selected_hls_chunk_indices(body.len(), chunk_indices);
                (
                    outbound_priority,
                    RemoteP2pScheduledResponse::Asset(RemoteP2pScheduledAsset {
                        request_id,
                        content_type,
                        body,
                        priority,
                        attempt,
                        header_sent: false,
                        chunk_indices,
                    }),
                )
            }
            RemoteP2pOutboundResponse::Promote { request_id } => {
                self.promote(request_id);
                return;
            }
            RemoteP2pOutboundResponse::Register { request_id } => {
                if self.cancelled.contains(&request_id) {
                    return;
                }
                self.requested.insert(request_id);
                return;
            }
            RemoteP2pOutboundResponse::Cancel { request_ids } => {
                self.cancel_requests(request_ids);
                return;
            }
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

    fn cancel_requests(&mut self, request_ids: Vec<u32>) {
        let cancelled_now = request_ids
            .into_iter()
            .take(HLS_CANCELLATION_CAPACITY)
            .collect::<HashSet<_>>();
        for request_id in cancelled_now.iter().copied() {
            if self.cancelled.contains(&request_id) {
                continue;
            }
            if self.cancelled.len() == HLS_CANCELLATION_CAPACITY {
                self.cancelled.pop_front();
            }
            self.cancelled.push_back(request_id);
        }
        self.requested
            .retain(|requested| !cancelled_now.contains(requested));
        self.promoted
            .retain(|promoted| !cancelled_now.contains(promoted));
        self.foreground.retain(|response| {
            scheduled_request_id(response)
                .is_none_or(|request_id| !cancelled_now.contains(&request_id))
        });
        self.reserve.retain(|response| {
            scheduled_request_id(response)
                .is_none_or(|request_id| !cancelled_now.contains(&request_id))
        });
        self.control.retain(|response| {
            scheduled_request_id(response)
                .is_none_or(|request_id| !cancelled_now.contains(&request_id))
        });
    }

    fn take_cancelled(&mut self, request_id: u32) -> bool {
        let Some(index) = self
            .cancelled
            .iter()
            .position(|cancelled| *cancelled == request_id)
        else {
            return false;
        };
        self.cancelled.remove(index);
        true
    }

    fn next_transmission_bytes(&self) -> Option<usize> {
        let response = self.queue_ref(self.next_response_queue()?).front()?;
        match response {
            RemoteP2pScheduledResponse::Text { body, .. } => Some(body.len()),
            RemoteP2pScheduledResponse::Asset(asset) => {
                let header_bytes = if asset.header_sent {
                    0
                } else {
                    encode_hls_asset_response(
                        asset.request_id,
                        &asset.content_type,
                        asset.body.len(),
                    )
                    .ok()?
                    .len()
                };
                let chunk_bytes = asset.chunk_indices.front().map_or(0, |chunk_index| {
                    let offset = *chunk_index as usize * HLS_ASSET_CHUNK_SIZE;
                    HLS_ASSET_CHUNK_HEADER_SIZE
                        + (asset.body.len() - offset).min(HLS_ASSET_CHUNK_SIZE)
                });
                let finish_bytes = if asset.chunk_indices.len() <= 1 {
                    encode_hls_asset_attempt_finished(asset.request_id, asset.attempt)
                        .ok()?
                        .len()
                } else {
                    0
                };
                header_bytes
                    .checked_add(chunk_bytes)?
                    .checked_add(finish_bytes)
            }
        }
    }

    fn next_response_queue(&self) -> Option<RemoteP2pOutboundQueue> {
        let media_pending = !self.foreground.is_empty() || !self.reserve.is_empty();
        if !self.control.is_empty() && (!self.control_sent_since_media || !media_pending) {
            Some(RemoteP2pOutboundQueue::Control)
        } else if !self.foreground.is_empty() {
            Some(RemoteP2pOutboundQueue::Foreground)
        } else if !self.reserve.is_empty() {
            Some(RemoteP2pOutboundQueue::Reserve)
        } else if !self.control.is_empty() {
            Some(RemoteP2pOutboundQueue::Control)
        } else {
            None
        }
    }

    fn next_transmission(&mut self) -> Option<Vec<RemoteP2pOutboundFrame>> {
        let queue = self.next_response_queue()?;
        self.control_sent_since_media = queue == RemoteP2pOutboundQueue::Control;
        let response = match queue {
            RemoteP2pOutboundQueue::Control => self.control.pop_front(),
            RemoteP2pOutboundQueue::Foreground => self.foreground.pop_front(),
            RemoteP2pOutboundQueue::Reserve => self.reserve.pop_front(),
        }?;
        match response {
            RemoteP2pScheduledResponse::Text { body, .. } => {
                Some(vec![RemoteP2pOutboundFrame::Text(body)])
            }
            RemoteP2pScheduledResponse::Asset(mut asset) => {
                let mut frames = Vec::with_capacity(3);
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
                if let Some(chunk_index) = asset.chunk_indices.pop_front() {
                    let offset = chunk_index as usize * HLS_ASSET_CHUNK_SIZE;
                    let end = (offset + HLS_ASSET_CHUNK_SIZE).min(asset.body.len());
                    frames.push(RemoteP2pOutboundFrame::Binary(encode_hls_asset_chunk(
                        asset.request_id,
                        chunk_index,
                        &asset.body[offset..end],
                    )));
                }
                if !asset.chunk_indices.is_empty() {
                    let priority = outbound_asset_priority(&asset.content_type, asset.priority);
                    self.queue(priority)
                        .push_back(RemoteP2pScheduledResponse::Asset(asset));
                } else {
                    frames.push(RemoteP2pOutboundFrame::Text(
                        encode_hls_asset_attempt_finished(asset.request_id, asset.attempt).ok()?,
                    ));
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
        priority: RemoteP2pOutboundPriority,
    ) -> &mut VecDeque<RemoteP2pScheduledResponse> {
        match priority {
            RemoteP2pOutboundPriority::Control => &mut self.control,
            RemoteP2pOutboundPriority::Foreground => &mut self.foreground,
            RemoteP2pOutboundPriority::Reserve => &mut self.reserve,
        }
    }

    fn queue_ref(&self, queue: RemoteP2pOutboundQueue) -> &VecDeque<RemoteP2pScheduledResponse> {
        match queue {
            RemoteP2pOutboundQueue::Control => &self.control,
            RemoteP2pOutboundQueue::Foreground => &self.foreground,
            RemoteP2pOutboundQueue::Reserve => &self.reserve,
        }
    }
}

fn selected_hls_chunk_indices(body_len: usize, requested: Option<Vec<u32>>) -> VecDeque<u32> {
    let chunk_count = body_len.div_ceil(HLS_ASSET_CHUNK_SIZE) as u32;
    let mut seen = HashSet::new();
    requested
        .unwrap_or_else(|| (0..chunk_count).collect())
        .into_iter()
        .filter(|index| *index < chunk_count && seen.insert(*index))
        .collect()
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

fn encode_hls_asset_attempt_finished(request_id: u32, attempt: u32) -> Result<String> {
    Ok(serde_json::json!({
        "type": "hls_asset_attempt_finished",
        "id": request_id,
        "attempt": attempt,
    })
    .to_string())
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
    responses: Arc<Mutex<Option<RemoteP2pResponseSender>>>,
    writer_lifetime: watch::Sender<bool>,
}

struct RemoteP2pDataChannelPair {
    control: Option<Arc<RTCDataChannel>>,
    media: Option<Arc<RTCDataChannel>>,
    responses: Option<Receiver<RemoteP2pOutboundResponse>>,
}

impl RemoteP2pPeer {
    fn cancel_writers(&self) {
        self.responses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        self.writer_lifetime.send_replace(true);
    }

    async fn close(&self) -> Result<()> {
        self.cancel_writers();
        self.connection.close().await?;
        Ok(())
    }
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
        for peer in &peers {
            peer.cancel_writers();
        }
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
        attempt: u32,
        chunk_indices: Option<Vec<u32>>,
    ) -> Result<()> {
        if body.len() > HLS_ASSET_MAX_BYTES {
            let error = "remote P2P HLS asset exceeds protocol capacity";
            Self::send_hls_asset_error_with_priority(
                responses,
                request_id,
                error,
                outbound_asset_priority(content_type, priority),
            )
            .await?;
            return Err(anyhow!(error));
        }
        responses
            .send(RemoteP2pOutboundResponse::Asset {
                request_id,
                content_type: content_type.to_owned(),
                body,
                priority,
                attempt,
                chunk_indices,
            })
            .await
            .map_err(|_| anyhow!("remote P2P response writer is closed"))
    }

    pub(super) async fn send_hls_asset_error(
        responses: &RemoteP2pResponseSender,
        request_id: u32,
        url: &str,
        error: &str,
        priority: RemoteP2pAssetPriority,
    ) -> Result<()> {
        Self::send_hls_asset_error_with_priority(
            responses,
            request_id,
            error,
            outbound_request_priority(url, priority),
        )
        .await
    }

    async fn send_hls_asset_error_with_priority(
        responses: &RemoteP2pResponseSender,
        request_id: u32,
        error: &str,
        priority: RemoteP2pOutboundPriority,
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
                priority,
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
                priority: RemoteP2pOutboundPriority::Control,
                request_id: None,
            })
            .await
            .map_err(|_| anyhow!("remote P2P response writer is closed"))
    }

    pub(super) async fn send_hls_timeline_to_client<T: Serialize>(
        &self,
        client_id: &str,
        hls: &T,
    ) -> Result<()> {
        let peer = self.peer(client_id).await?;
        let responses = peer
            .responses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| anyhow!("remote P2P control channel is not ready"))?;
        Self::send_hls_timeline(&responses, hls).await
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
                priority: RemoteP2pOutboundPriority::Control,
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

    async fn send_hls_cancellation(
        responses: &RemoteP2pResponseSender,
        request_ids: Vec<u32>,
    ) -> Result<()> {
        responses
            .send(RemoteP2pOutboundResponse::Cancel { request_ids })
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
        let (writer_lifetime, _) = watch::channel(false);
        let channel_writer_lifetime = writer_lifetime.clone();
        let (response_sender, response_receiver) = mpsc_channel(HLS_RESPONSE_QUEUE_CAPACITY);
        let responses = Arc::new(Mutex::new(None));
        let channel_responses = Arc::clone(&responses);
        let channels = Arc::new(Mutex::new(RemoteP2pDataChannelPair {
            control: None,
            media: None,
            responses: Some(response_receiver),
        }));
        let channel_pair = Arc::clone(&channels);
        connection.on_data_channel(Box::new(move |channel| {
            let events = events.clone();
            let client_id = channel_client_id.clone();
            let writer_lifetime = channel_writer_lifetime.subscribe();
            let responses = Arc::clone(&channel_responses);
            let response_sender = response_sender.clone();
            let channels = Arc::clone(&channel_pair);
            Box::pin(async move {
                attach_hls_data_channel(
                    events,
                    client_id,
                    channel_generation,
                    channel,
                    writer_lifetime,
                    responses,
                    response_sender,
                    channels,
                )
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
            responses,
            writer_lifetime,
        });
        let mut peers = self.peers.lock().await;
        if let Some(existing) = peers.get(client_id) {
            let existing = existing.clone();
            if existing.generation > generation {
                drop(peers);
                let _ = peer.close().await;
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
                let _ = existing.close().await;
                return Ok(peer);
            }
            drop(peers);
            let _ = peer.close().await;
            return Ok(existing);
        }
        peers.insert(client_id.to_owned(), peer.clone());
        Ok(peer)
    }

    async fn close_peer(&self, client_id: &str) -> Result<()> {
        if let Some(peer) = self.peers.lock().await.remove(client_id) {
            peer.close().await?;
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
        let _ = peer.close().await;
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
            let _ = peer.close().await;
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
    writer_lifetime: watch::Receiver<bool>,
    response_slot: Arc<Mutex<Option<RemoteP2pResponseSender>>>,
    responses: RemoteP2pResponseSender,
    channels: Arc<Mutex<RemoteP2pDataChannelPair>>,
) {
    let label = channel.label();
    if label != HLS_CONTROL_CHANNEL_LABEL && label != HLS_MEDIA_CHANNEL_LABEL {
        return;
    }
    if label == HLS_CONTROL_CHANNEL_LABEL {
        let request_events = events.clone();
        let request_client_id = client_id.clone();
        let request_responses = responses.clone();
        channel.on_message(Box::new(move |message: DataChannelMessage| {
            let events = request_events.clone();
            let client_id = request_client_id.clone();
            let responses = request_responses.clone();
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
                        attempt,
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
                            attempt,
                            chunk_indices: None,
                            responses,
                        }
                    }
                    RemoteP2pDataChannelRequest::HlsAssetRepair {
                        id,
                        url,
                        chunks,
                        attempt,
                        playout_seconds,
                        priority,
                    } => {
                        if chunks.is_empty()
                            || RemoteP2pTransport::register_hls_request(&responses, id)
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
                            attempt,
                            chunk_indices: Some(chunks),
                            responses,
                        }
                    }
                    RemoteP2pDataChannelRequest::HlsAssetPromote { id } => {
                        let _ = RemoteP2pTransport::send_hls_promotion(&responses, id).await;
                        return;
                    }
                    RemoteP2pDataChannelRequest::HlsAssetCancel { ids } => {
                        let _ = RemoteP2pTransport::send_hls_cancellation(&responses, ids).await;
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
    let writer = {
        let mut pair = channels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if label == HLS_CONTROL_CHANNEL_LABEL {
            pair.control = Some(channel);
        } else {
            pair.media = Some(channel);
        }
        match (
            pair.control.clone(),
            pair.media.clone(),
            pair.responses.take(),
        ) {
            (Some(control), Some(media), Some(response_receiver)) => {
                Some((control, media, response_receiver))
            }
            (_, _, response_receiver) => {
                pair.responses = response_receiver;
                None
            }
        }
    };
    let Some((control, media, response_receiver)) = writer else {
        return;
    };
    *response_slot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(responses);
    tokio::spawn(async move {
        let exit =
            run_hls_data_channel_writer(control, media, response_receiver, writer_lifetime).await;
        response_slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if exit == RemoteP2pWriterExit::Stalled {
            let _ = events.send(RemoteP2pTransportEvent::SupplyWriterStalled {
                client_id,
                generation,
            });
        }
    });
}

async fn run_hls_data_channel_writer(
    control_channel: Arc<RTCDataChannel>,
    media_channel: Arc<RTCDataChannel>,
    mut responses: Receiver<RemoteP2pOutboundResponse>,
    mut writer_lifetime: watch::Receiver<bool>,
) -> RemoteP2pWriterExit {
    let mut scheduler = RemoteP2pOutboundScheduler::default();
    let mut sends: JoinSet<(usize, Result<()>)> = JoinSet::new();
    let mut send_window = RemoteP2pSendWindow::default();
    'writer: loop {
        if *writer_lifetime.borrow() {
            return RemoteP2pWriterExit::InputClosed;
        }
        ingest_hls_responses(&mut responses, &mut scheduler, HLS_RESPONSE_INGEST_BUDGET);
        if scheduler.is_empty() {
            if !sends.is_empty() {
                tokio::select! {
                    changed = writer_lifetime.changed() => {
                        let _ = changed;
                        return RemoteP2pWriterExit::InputClosed;
                    }
                    response = responses.recv() => {
                        let Some(response) = response else {
                            return RemoteP2pWriterExit::InputClosed;
                        };
                        scheduler.push(response);
                    }
                    completion = sends.join_next() => {
                        let Some(completion) = completion else {
                            continue;
                        };
                        match completion {
                            Ok((bytes, Ok(()))) => {
                                send_window.complete(bytes);
                            }
                            Ok((_, Err(error))) => {
                                log::warn!(
                                    target: REMOTE_SHARE_LOG_TARGET,
                                    "remote_p2p_response_writer_failed error=\"{}\"",
                                    error
                                );
                                return RemoteP2pWriterExit::Stalled;
                            }
                            Err(error) => {
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
                continue;
            }
            let Some(response) =
                await_hls_writer_response(&mut responses, &mut writer_lifetime).await
            else {
                return RemoteP2pWriterExit::InputClosed;
            };
            scheduler.push(response);
            continue;
        }
        let transmission_bytes = loop {
            let Some(projected_bytes) = scheduler.next_transmission_bytes() else {
                continue 'writer;
            };
            if projected_bytes > HLS_DATA_CHANNEL_HIGH_WATERMARK {
                log::warn!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_p2p_response_writer_failed error=\"transmission exceeds send window\" bytes={}",
                    projected_bytes
                );
                return RemoteP2pWriterExit::Stalled;
            }
            if send_window.can_admit(projected_bytes) {
                break projected_bytes;
            }
            let Some(completion) =
                await_hls_send_completion(&mut sends, &mut writer_lifetime).await
            else {
                return RemoteP2pWriterExit::InputClosed;
            };
            match completion {
                Ok(bytes) => send_window.complete(bytes),
                Err(error) => {
                    log::warn!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_p2p_response_writer_failed error=\"{}\"",
                        error
                    );
                    return RemoteP2pWriterExit::Stalled;
                }
            }
            ingest_hls_responses(&mut responses, &mut scheduler, HLS_RESPONSE_INGEST_BUDGET);
        };
        let transmission = scheduler
            .next_transmission()
            .expect("a non-empty scheduler must yield a transmission");
        let emitted_bytes = transmission
            .iter()
            .map(RemoteP2pOutboundFrame::encoded_len)
            .sum::<usize>();
        assert_eq!(
            emitted_bytes, transmission_bytes,
            "capacity projection must equal the emitted transmission"
        );
        for frame in transmission {
            let frame_bytes = frame.encoded_len();
            match frame {
                RemoteP2pOutboundFrame::Text(body) => {
                    let result = tokio::select! {
                        changed = writer_lifetime.changed() => {
                            let _ = changed;
                            return RemoteP2pWriterExit::InputClosed;
                        }
                        result = control_channel.send_text(body) => result,
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
                RemoteP2pOutboundFrame::Binary(body) => {
                    let media_channel = Arc::clone(&media_channel);
                    sends.spawn(async move {
                        let result = media_channel
                            .send(&body)
                            .await
                            .map(|_| ())
                            .map_err(anyhow::Error::from);
                        (frame_bytes, result)
                    });
                    assert!(
                        send_window.admit(frame_bytes),
                        "reserved transmission capacity must admit every media frame"
                    );
                }
            }
        }
        if !await_hls_data_channel_capacity(
            || media_channel.buffered_amount(),
            || {
                control_channel.ready_state() == RTCDataChannelState::Open
                    && media_channel.ready_state() == RTCDataChannelState::Open
            },
            || *writer_lifetime.borrow(),
            HLS_DATA_CHANNEL_HIGH_WATERMARK,
            HLS_DATA_CHANNEL_LOW_WATERMARK,
            HLS_DATA_CHANNEL_CAPACITY_POLL_INTERVAL,
        )
        .await
        {
            return RemoteP2pWriterExit::InputClosed;
        }
    }
}

async fn await_hls_send_completion(
    sends: &mut JoinSet<(usize, Result<()>)>,
    writer_lifetime: &mut watch::Receiver<bool>,
) -> Option<Result<usize>> {
    if *writer_lifetime.borrow() {
        return None;
    }
    tokio::select! {
        changed = writer_lifetime.changed() => {
            let _ = changed;
            None
        }
        completion = sends.join_next() => completion.map(|completion| match completion {
            Ok((bytes, Ok(()))) => Ok(bytes),
            Ok((_, Err(error))) => Err(error),
            Err(error) => Err(anyhow!(error)),
        })
    }
}

async fn await_hls_writer_response(
    responses: &mut Receiver<RemoteP2pOutboundResponse>,
    writer_lifetime: &mut watch::Receiver<bool>,
) -> Option<RemoteP2pOutboundResponse> {
    if *writer_lifetime.borrow() {
        return None;
    }
    tokio::select! {
        changed = writer_lifetime.changed() => {
            let _ = changed;
            None
        }
        response = responses.recv() => response,
    }
}

fn ingest_hls_responses(
    responses: &mut Receiver<RemoteP2pOutboundResponse>,
    scheduler: &mut RemoteP2pOutboundScheduler,
    budget: usize,
) -> usize {
    let mut ingested = 0;
    while ingested < budget {
        let Ok(response) = responses.try_recv() else {
            break;
        };
        scheduler.push(response);
        ingested += 1;
    }
    ingested
}

async fn await_hls_data_channel_capacity<F, Fut, G, H>(
    mut buffered_amount: F,
    mut channel_is_open: G,
    mut writer_is_cancelled: H,
    high_watermark: usize,
    low_watermark: usize,
    observation_interval: Duration,
) -> bool
where
    F: FnMut() -> Fut,
    Fut: Future<Output = usize>,
    G: FnMut() -> bool,
    H: FnMut() -> bool,
{
    debug_assert!(low_watermark <= high_watermark);
    let mut buffered = loop {
        if writer_is_cancelled() || !channel_is_open() {
            return false;
        }
        if let Ok(buffered) = timeout(observation_interval, buffered_amount()).await {
            break buffered;
        }
    };
    if buffered <= high_watermark {
        return true;
    }
    while buffered > low_watermark {
        if writer_is_cancelled() || !channel_is_open() {
            return false;
        }
        sleep(observation_interval).await;
        if let Ok(current) = timeout(observation_interval, buffered_amount()).await {
            buffered = current;
        }
    }
    true
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
