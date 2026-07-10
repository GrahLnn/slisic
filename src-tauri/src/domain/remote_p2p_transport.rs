use anyhow::{Result, anyhow};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use webrtc::api::APIBuilder;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

const REMOTE_SHARE_LOG_TARGET: &str = "remote_share";
const HLS_DATA_CHANNEL_LABEL: &str = "slisic.p2p-hls.v1";
const HLS_ASSET_CHUNK_SIZE: usize = 16 * 1024;
const HLS_ASSET_CHUNK_MAGIC: &[u8; 4] = b"SLH1";

pub(super) type RemoteRelayEventSender = UnboundedSender<String>;

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
    Offer { sdp: String },
    Answer { sdp: String },
    Candidate { candidate: RTCIceCandidateInit },
    Close,
    Error { reason: String },
}

pub(super) enum RemoteP2pTransportEvent {
    HlsAssetRequested {
        client_id: String,
        request_id: u32,
        url: String,
        channel: Arc<RTCDataChannel>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RemoteP2pDataChannelRequest {
    HlsAssetRequest { id: u32, url: String },
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

struct RemoteP2pPeer {
    connection: Arc<RTCPeerConnection>,
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
            RemoteP2pSignal::Offer { sdp } => self.accept_offer(client_id, sdp).await,
            RemoteP2pSignal::Candidate { candidate } => {
                self.peer(client_id)
                    .await?
                    .connection
                    .add_ice_candidate(candidate)
                    .await?;
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
        channel: Arc<RTCDataChannel>,
        request_id: u32,
        content_type: &str,
        body: Bytes,
    ) -> Result<()> {
        let chunks = body.len().div_ceil(HLS_ASSET_CHUNK_SIZE);
        channel
            .send_text(serde_json::to_string(
                &RemoteP2pDataChannelResponse::HlsAssetResponse {
                    id: request_id,
                    ok: true,
                    content_type: Some(content_type),
                    length: Some(body.len()),
                    chunks: Some(chunks),
                    error: None,
                },
            )?)
            .await?;
        for (index, chunk) in body.chunks(HLS_ASSET_CHUNK_SIZE).enumerate() {
            channel
                .send(&encode_hls_asset_chunk(request_id, index as u32, chunk))
                .await?;
        }
        Ok(())
    }

    pub(super) async fn send_hls_asset_error(
        channel: Arc<RTCDataChannel>,
        request_id: u32,
        error: &str,
    ) -> Result<()> {
        channel
            .send_text(serde_json::to_string(
                &RemoteP2pDataChannelResponse::HlsAssetResponse {
                    id: request_id,
                    ok: false,
                    content_type: None,
                    length: None,
                    chunks: None,
                    error: Some(error),
                },
            )?)
            .await?;
        Ok(())
    }

    async fn accept_offer(self: &Arc<Self>, client_id: &str, sdp: String) -> Result<()> {
        let existing = {
            let peers = self.peers.lock().await;
            peers.get(client_id).cloned()
        };
        let peer = match existing {
            Some(peer) if peer.connection.connection_state() != RTCPeerConnectionState::Closed => {
                peer
            }
            _ => self.create_peer(client_id).await?,
        };
        peer.connection
            .set_configuration(RTCConfiguration {
                ice_servers: self.current_ice_servers(),
                ..Default::default()
            })
            .await?;
        peer.connection
            .set_remote_description(RTCSessionDescription::offer(sdp)?)
            .await?;
        let answer = peer.connection.create_answer(None).await?;
        peer.connection
            .set_local_description(answer.clone())
            .await?;
        self.emit_signal(client_id, RemoteP2pSignal::Answer { sdp: answer.sdp });
        Ok(())
    }

    async fn create_peer(self: &Arc<Self>, client_id: &str) -> Result<Arc<RemoteP2pPeer>> {
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
        connection.on_ice_candidate(Box::new(move |candidate| {
            let weak = Weak::clone(&weak);
            let client_id = candidate_client_id.clone();
            Box::pin(async move {
                let (Some(candidate), Some(owner)) = (candidate, weak.upgrade()) else {
                    return;
                };
                if let Ok(candidate) = candidate.to_json() {
                    owner.emit_signal(&client_id, RemoteP2pSignal::Candidate { candidate });
                }
            })
        }));
        let events = self.events.clone();
        let channel_client_id = client_id.to_owned();
        connection.on_data_channel(Box::new(move |channel| {
            let events = events.clone();
            let client_id = channel_client_id.clone();
            Box::pin(async move { attach_hls_data_channel(events, client_id, channel) })
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
        let peer = Arc::new(RemoteP2pPeer { connection });
        let mut peers = self.peers.lock().await;
        if let Some(existing) = peers.get(client_id) {
            let existing = existing.clone();
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

fn attach_hls_data_channel(
    events: UnboundedSender<RemoteP2pTransportEvent>,
    client_id: String,
    channel: Arc<RTCDataChannel>,
) {
    if channel.label() != HLS_DATA_CHANNEL_LABEL {
        return;
    }
    let response_channel = Arc::clone(&channel);
    channel.on_message(Box::new(move |message: DataChannelMessage| {
        let events = events.clone();
        let client_id = client_id.clone();
        let channel = Arc::clone(&response_channel);
        Box::pin(async move {
            if !message.is_string {
                return;
            }
            let Ok(text) = String::from_utf8(message.data.to_vec()) else {
                return;
            };
            let Ok(RemoteP2pDataChannelRequest::HlsAssetRequest { id, url }) =
                serde_json::from_str(&text)
            else {
                return;
            };
            let _ = events.send(RemoteP2pTransportEvent::HlsAssetRequested {
                client_id,
                request_id: id,
                url,
                channel,
            });
        })
    }));
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
