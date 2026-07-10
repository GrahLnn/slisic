use crate::utils::binaries::{ManagedBinary, acquire_managed_binary_usage};
use anyhow::{Result, anyhow};
use async_trait::async_trait;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::net::UdpSocket;
use tokio::process::Command;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, channel, unbounded_channel};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval};
use webrtc::api::APIBuilder;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MIME_TYPE_OPUS, MediaEngine};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp::header::Header;
use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::TrackLocalWriter;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::util::Unmarshal;

const REMOTE_SHARE_LOG_TARGET: &str = "remote_share";
const OPUS_CLOCK_RATE: u32 = 48_000;
const OPUS_CHANNELS: u16 = 2;
const OPUS_FRAME_DURATION_MS: u64 = 20;
const OPUS_SAMPLES_PER_FRAME: u32 = 960;
const OPUS_PAYLOAD_TYPE: u8 = 111;
const OPUS_SILENCE_PAYLOAD: &[u8] = &[0xf8, 0xff, 0xfe];
const RTP_SSRC: u32 = 0x534c_4953;
const ENCODED_PACKET_CHANNEL_CAPACITY: usize = 64;
const PLAYOUT_QUEUE_CAPACITY: usize = 50;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

#[derive(Debug)]
pub(super) enum RemoteWebRtcEvent {
    TrackEnded { client_id: String, generation: u64 },
}

pub(super) struct RemoteAudioSource {
    pub(super) ffmpeg_path: PathBuf,
    pub(super) file_path: PathBuf,
    pub(super) start_ms: u32,
    pub(super) end_ms: u32,
    pub(super) gain_db: f32,
}

enum PlayoutCommand {
    Play {
        generation: u64,
        source: RemoteAudioSource,
    },
    Idle,
    Shutdown,
}

struct EncodedPacket {
    generation: u64,
    payload: Bytes,
}

struct WorkerFinished {
    generation: u64,
    result: Result<()>,
}

struct RemoteWebRtcPeer {
    connection: Arc<RTCPeerConnection>,
    playout: UnboundedSender<PlayoutCommand>,
}

#[async_trait]
trait RtpPacketWriter: Send + Sync {
    async fn write_packet(&self, packet: &Packet) -> Result<usize>;
}

#[async_trait]
impl RtpPacketWriter for TrackLocalStaticRTP {
    async fn write_packet(&self, packet: &Packet) -> Result<usize> {
        Ok(self.write_rtp(packet).await?)
    }
}

pub(super) struct RemoteWebRtcAudio {
    peers: tokio::sync::Mutex<HashMap<String, Arc<RemoteWebRtcPeer>>>,
    ice_servers: Mutex<Vec<RTCIceServer>>,
    relay_events: Mutex<Option<RemoteRelayEventSender>>,
    events: UnboundedSender<RemoteWebRtcEvent>,
}

impl RemoteWebRtcAudio {
    pub(super) fn new() -> (Arc<Self>, UnboundedReceiver<RemoteWebRtcEvent>) {
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
        let mut relay_events = self
            .relay_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *relay_events = Some(sender);
    }

    pub(super) fn send_relay_frame(&self, frame: String) -> Result<()> {
        let relay_events = self
            .relay_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let relay_events = relay_events
            .as_ref()
            .ok_or_else(|| anyhow!("remote relay is not connected"))?;
        relay_events
            .send(frame)
            .map_err(|_| anyhow!("remote relay outbound channel is closed"))
    }

    pub(super) fn update_ice_servers(&self, servers: Vec<RemoteIceServer>) {
        let mut ice_servers = self
            .ice_servers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *ice_servers = servers
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
                let peer = self.peer(client_id).await?;
                peer.connection.add_ice_candidate(candidate).await?;
                Ok(())
            }
            RemoteP2pSignal::Close => self.close_peer(client_id).await,
            RemoteP2pSignal::Answer { .. } | RemoteP2pSignal::Error { .. } => Ok(()),
        }
    }

    pub(super) async fn play(
        &self,
        client_id: &str,
        generation: u64,
        source: RemoteAudioSource,
    ) -> Result<()> {
        let peer = self.peer(client_id).await?;
        peer.playout
            .send(PlayoutCommand::Play { generation, source })
            .map_err(|_| anyhow!("remote WebRTC playout task is closed"))
    }

    pub(super) async fn stop(&self, client_id: &str) -> Result<()> {
        let peer = self.peer(client_id).await?;
        peer.playout
            .send(PlayoutCommand::Idle)
            .map_err(|_| anyhow!("remote WebRTC playout task is closed"))
    }

    pub(super) async fn close_all(&self) {
        let peers = {
            let mut peers = self.peers.lock().await;
            peers.drain().map(|(_, peer)| peer).collect::<Vec<_>>()
        };
        for peer in peers {
            let _ = peer.playout.send(PlayoutCommand::Shutdown);
            let _ = peer.connection.close().await;
        }
    }

    async fn accept_offer(self: &Arc<Self>, client_id: &str, sdp: String) -> Result<()> {
        let existing_peer = {
            let peers = self.peers.lock().await;
            peers.get(client_id).cloned()
        };
        let peer = match existing_peer {
            Some(peer) => peer,
            None => self.create_peer(client_id).await?,
        };
        let configuration = RTCConfiguration {
            ice_servers: self.current_ice_servers(),
            ..Default::default()
        };
        peer.connection.set_configuration(configuration).await?;
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

    async fn create_peer(self: &Arc<Self>, client_id: &str) -> Result<Arc<RemoteWebRtcPeer>> {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs()?;
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)?;
        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build();
        let connection = Arc::new(
            api.new_peer_connection(RTCConfiguration {
                ice_servers: self.current_ice_servers(),
                ..Default::default()
            })
            .await?,
        );
        let track = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_owned(),
                clock_rate: OPUS_CLOCK_RATE,
                channels: OPUS_CHANNELS,
                sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                ..Default::default()
            },
            "slisic-remote-audio".to_owned(),
            "slisic-remote-stream".to_owned(),
        ));
        let sender = connection.add_track(track.clone()).await?;
        tokio::spawn(async move { while sender.read_rtcp().await.is_ok() {} });

        let weak = Arc::downgrade(self);
        let candidate_client_id = client_id.to_string();
        connection.on_ice_candidate(Box::new(move |candidate| {
            let weak = Weak::clone(&weak);
            let client_id = candidate_client_id.clone();
            Box::pin(async move {
                let Some(candidate) = candidate else {
                    return;
                };
                let Some(owner) = weak.upgrade() else {
                    return;
                };
                match candidate.to_json() {
                    Ok(candidate) => {
                        owner.emit_signal(&client_id, RemoteP2pSignal::Candidate { candidate })
                    }
                    Err(error) => log::warn!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_p2p_candidate_serialize_failed error=\"{}\"",
                        error
                    ),
                }
            })
        }));
        connection.on_peer_connection_state_change(Box::new(move |state| {
            Box::pin(async move {
                match state {
                    RTCPeerConnectionState::Connected => log::info!(
                        target: REMOTE_SHARE_LOG_TARGET,
                        "remote_p2p_media_connected"
                    ),
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Disconnected => {
                        log::warn!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_p2p_media_path_unhealthy state={:?} recovery=await_ice_restart",
                            state
                        );
                    }
                    _ => {}
                }
            })
        }));

        let (playout, receiver) = unbounded_channel();
        tokio::spawn(run_playout(
            client_id.to_string(),
            track,
            receiver,
            self.events.clone(),
        ));
        let peer = Arc::new(RemoteWebRtcPeer {
            connection,
            playout,
        });
        let mut peers = self.peers.lock().await;
        if let Some(existing) = peers.get(client_id) {
            let _ = peer.playout.send(PlayoutCommand::Shutdown);
            return Ok(existing.clone());
        }
        peers.insert(client_id.to_string(), peer.clone());
        Ok(peer)
    }

    async fn close_peer(&self, client_id: &str) -> Result<()> {
        let peer = self.peers.lock().await.remove(client_id);
        if let Some(peer) = peer {
            let _ = peer.playout.send(PlayoutCommand::Shutdown);
            peer.connection.close().await?;
        }
        Ok(())
    }

    async fn peer(&self, client_id: &str) -> Result<Arc<RemoteWebRtcPeer>> {
        self.peers
            .lock()
            .await
            .get(client_id)
            .cloned()
            .ok_or_else(|| anyhow!("remote WebRTC peer is not ready"))
    }

    fn current_ice_servers(&self) -> Vec<RTCIceServer> {
        self.ice_servers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn emit_signal(&self, client_id: &str, signal: RemoteP2pSignal) {
        let event = serde_json::json!({
            "kind": "p2p_signal",
            "clientId": client_id,
            "signal": signal,
        });
        let Ok(frame) = serde_json::to_string(&event) else {
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

async fn run_playout<W>(
    client_id: String,
    track: Arc<W>,
    mut commands: UnboundedReceiver<PlayoutCommand>,
    events: UnboundedSender<RemoteWebRtcEvent>,
) where
    W: RtpPacketWriter + 'static,
{
    let (packets_tx, mut packets_rx) = channel::<EncodedPacket>(ENCODED_PACKET_CHANNEL_CAPACITY);
    let (finished_tx, mut finished_rx) = unbounded_channel::<WorkerFinished>();
    let (rtp_packets, rtp_packet_receiver) = watch::channel(None);
    let rtp_writer = tokio::spawn(run_latest_rtp_writes(track, rtp_packet_receiver));
    let mut worker: Option<JoinHandle<()>> = None;
    let mut active_generation = None;
    let mut encoded_generation_started = None;
    let mut finished_generation = None;
    let mut queue = VecDeque::new();
    let mut timestamp = 0_u32;
    let mut ticker = interval(Duration::from_millis(OPUS_FRAME_DURATION_MS));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(PlayoutCommand::Play { generation, source }) => {
                        if let Some(worker) = worker.take() {
                            worker.abort();
                        }
                        queue.clear();
                        encoded_generation_started = None;
                        finished_generation = None;
                        active_generation = Some(generation);
                        log::info!(
                            target: REMOTE_SHARE_LOG_TARGET,
                            "remote_p2p_playout_generation_started client_id=\"{}\" generation={} range={}..{}",
                            client_id,
                            generation,
                            source.start_ms,
                            source.end_ms
                        );
                        worker = Some(tokio::spawn(stream_encoded_opus(
                            generation,
                            source,
                            packets_tx.clone(),
                            finished_tx.clone(),
                        )));
                    }
                    Some(PlayoutCommand::Idle) => {
                        if let Some(worker) = worker.take() {
                            worker.abort();
                        }
                        active_generation = None;
                        encoded_generation_started = None;
                        finished_generation = None;
                        queue.clear();
                    }
                    Some(PlayoutCommand::Shutdown) | None => {
                        if let Some(worker) = worker.take() {
                            worker.abort();
                        }
                        break;
                    }
                }
            }
            packet = packets_rx.recv() => {
                if let Some(packet) = packet {
                    if active_generation == Some(packet.generation) {
                        if encoded_generation_started != Some(packet.generation) {
                            encoded_generation_started = Some(packet.generation);
                            log::info!(
                                target: REMOTE_SHARE_LOG_TARGET,
                                "remote_p2p_encoded_audio_started client_id=\"{}\" generation={}",
                                client_id,
                                packet.generation
                            );
                        }
                        push_realtime_packet(&mut queue, packet.payload);
                    }
                }
            }
            finished = finished_rx.recv() => {
                if let Some(finished) = finished {
                    if active_generation == Some(finished.generation) {
                        if let Err(error) = &finished.result {
                            log::warn!(
                                target: REMOTE_SHARE_LOG_TARGET,
                                "remote_p2p_ffmpeg_failed error=\"{}\"",
                                error
                            );
                        }
                        finished_generation = Some(finished.generation);
                        worker = None;
                    }
                }
            }
            _ = ticker.tick() => {
                let payload = queue.pop_front().unwrap_or_else(|| Bytes::from_static(OPUS_SILENCE_PAYLOAD));
                let packet = Packet {
                    header: Header {
                        version: 2,
                        payload_type: OPUS_PAYLOAD_TYPE,
                        timestamp,
                        ssrc: RTP_SSRC,
                        ..Default::default()
                    },
                    payload,
                };
                rtp_packets.send_replace(Some(packet));
                timestamp = timestamp.wrapping_add(OPUS_SAMPLES_PER_FRAME);

                if queue.is_empty() && finished_generation == active_generation {
                    if let Some(generation) = active_generation.take() {
                        finished_generation = None;
                        let _ = events.send(RemoteWebRtcEvent::TrackEnded {
                            client_id: client_id.clone(),
                            generation,
                        });
                    }
                }
            }
        }
    }

    drop(rtp_packets);
    rtp_writer.abort();
    let _ = rtp_writer.await;
}

async fn run_latest_rtp_writes<W>(track: Arc<W>, mut packets: watch::Receiver<Option<Packet>>)
where
    W: RtpPacketWriter + 'static,
{
    let mut write_failed = false;
    let mut sequence_number = 0_u16;
    while packets.changed().await.is_ok() {
        let Some(mut packet) = packets.borrow_and_update().clone() else {
            continue;
        };
        packet.header.sequence_number = sequence_number;
        match track.write_packet(&packet).await {
            Ok(written) => {
                write_failed = false;
                if written > 0 {
                    sequence_number = sequence_number.wrapping_add(1);
                }
            }
            Err(error) if !write_failed => {
                write_failed = true;
                log::warn!(
                    target: REMOTE_SHARE_LOG_TARGET,
                    "remote_p2p_rtp_write_failed error=\"{}\"",
                    error
                );
            }
            Err(_) => {}
        }
    }
}

async fn stream_encoded_opus(
    generation: u64,
    source: RemoteAudioSource,
    packets: tokio::sync::mpsc::Sender<EncodedPacket>,
    finished: UnboundedSender<WorkerFinished>,
) {
    let result = stream_encoded_opus_inner(generation, source, packets).await;
    let _ = finished.send(WorkerFinished { generation, result });
}

async fn stream_encoded_opus_inner(
    generation: u64,
    source: RemoteAudioSource,
    packets: tokio::sync::mpsc::Sender<EncodedPacket>,
) -> Result<()> {
    if source.end_ms <= source.start_ms {
        return Err(anyhow!("remote audio range is empty"));
    }
    let socket = UdpSocket::bind("127.0.0.1:0").await?;
    let port = socket.local_addr()?.port();
    let _usage = acquire_managed_binary_usage(ManagedBinary::Ffmpeg, "remote-webrtc-audio");
    let mut command = Command::new(&source.ffmpeg_path);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-re")
        .arg("-ss")
        .arg(format_seconds(source.start_ms))
        .arg("-i")
        .arg(&source.file_path)
        .arg("-t")
        .arg(format_seconds(source.end_ms - source.start_ms))
        .arg("-vn")
        .arg("-sn")
        .arg("-dn");
    if source.gain_db.abs() > 0.001 {
        command
            .arg("-af")
            .arg(format!("volume={:.3}dB", source.gain_db));
    }
    command
        .arg("-ac")
        .arg(OPUS_CHANNELS.to_string())
        .arg("-ar")
        .arg(OPUS_CLOCK_RATE.to_string())
        .arg("-c:a")
        .arg("libopus")
        .arg("-application")
        .arg("audio")
        .arg("-frame_duration")
        .arg(OPUS_FRAME_DURATION_MS.to_string())
        .arg("-b:a")
        .arg("160k")
        .arg("-f")
        .arg("rtp")
        .arg("-payload_type")
        .arg(OPUS_PAYLOAD_TYPE.to_string())
        .arg(format!("rtp://127.0.0.1:{port}?pkt_size=1200"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn()?;
    let mut buffer = vec![0_u8; 2048];
    loop {
        tokio::select! {
            received = socket.recv(&mut buffer) => {
                let received = received?;
                if !forward_encoded_packet(generation, &buffer[..received], &packets).await? {
                    return Ok(());
                }
            }
            status = child.wait() => {
                let status = status?;
                if status.success() {
                    loop {
                        let received = tokio::time::timeout(
                            Duration::from_millis(OPUS_FRAME_DURATION_MS),
                            socket.recv(&mut buffer),
                        )
                        .await;
                        let Ok(received) = received else {
                            break;
                        };
                        let received = received?;
                        if !forward_encoded_packet(generation, &buffer[..received], &packets).await? {
                            return Ok(());
                        }
                    }
                    return Ok(());
                }
                return Err(anyhow!("FFmpeg exited with status {status}"));
            }
        }
    }
}

async fn forward_encoded_packet(
    generation: u64,
    bytes: &[u8],
    packets: &tokio::sync::mpsc::Sender<EncodedPacket>,
) -> Result<bool> {
    let mut bytes = Bytes::copy_from_slice(bytes);
    let packet = Packet::unmarshal(&mut bytes)?;
    Ok(packets
        .send(EncodedPacket {
            generation,
            payload: packet.payload,
        })
        .await
        .is_ok())
}

fn push_realtime_packet(queue: &mut VecDeque<Bytes>, payload: Bytes) {
    if queue.len() >= PLAYOUT_QUEUE_CAPACITY {
        queue.pop_front();
    }
    queue.push_back(payload);
}

fn format_seconds(ms: u32) -> String {
    format!("{:.3}", f64::from(ms) / 1000.0)
}

#[cfg(test)]
#[path = "remote_webrtc_audio.test.rs"]
mod tests;
