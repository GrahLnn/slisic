use crate::domain::player::model::PlaybackTrack;
use crate::utils::binaries::{ManagedBinary, acquire_managed_binary_usage};
use anyhow::{Result, anyhow};
use bytes::Bytes;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const HLS_SEGMENT_SECONDS: u32 = 2;
const HLS_PRIMING_SEGMENT_SECONDS: f64 = 2.005_333;
const HLS_PRIMING_WINDOW_BEHIND: u64 = 2;
const HLS_PRIMING_WINDOW_AHEAD: u64 = 6;
const HLS_PLAYBACK_AHEAD_SEGMENTS: u32 = 3;
const HLS_DEFAULT_RESERVE_BUFFER_SECONDS: u32 = 60;
const HLS_MAX_RESERVE_BUFFER_SECONDS: u32 = 180;
const HLS_AUDIO_BITRATE: &str = "192k";
const HLS_MATERIALIZATION_VERSION: &str = "p2p-hls-v1";
const LOCAL_PRIMING_SEGMENT_URL: &str = "p2p-local://slisic/prime.ts";

#[derive(Clone)]
pub(super) struct P2pHlsTimelineEntry {
    pub(super) id: String,
    pub(super) track: PlaybackTrack,
    pub(super) start_seconds: f64,
    pub(super) end_seconds: f64,
}

#[derive(Clone)]
pub(super) struct P2pHlsSessionSnapshot {
    pub(super) epoch: u64,
    pub(super) revision: u64,
    pub(super) stream_url: String,
    pub(super) reserve_url: String,
    pub(super) entries: Vec<P2pHlsTimelineEntry>,
}

pub(super) struct P2pHlsAsset {
    pub(super) content_type: &'static str,
    pub(super) body: Bytes,
}

pub(super) struct P2pHlsSource {
    pub(super) ffmpeg_path: PathBuf,
    pub(super) file_path: PathBuf,
    pub(super) start_ms: u32,
    pub(super) end_ms: u32,
    pub(super) gain_db: f32,
}

#[derive(Clone)]
struct HlsSegmentAsset {
    duration_seconds: f64,
    path: PathBuf,
}

#[derive(Clone)]
struct HlsTrackAsset {
    target_duration: u32,
    segments: Vec<HlsSegmentAsset>,
}

#[derive(Clone)]
struct PublishedTrack {
    track: PlaybackTrack,
    asset: HlsTrackAsset,
}

struct ClientHlsSession {
    epoch: u64,
    revision: u64,
    prepared_at: Instant,
    observed_playout_seconds: Option<f64>,
    handoff_sequence: Option<u64>,
    pending_handoff_sequence: Option<u64>,
    reserve_buffer_seconds: u32,
    projected_playback_manifest: bool,
    tracks: Vec<PublishedTrack>,
}

impl ClientHlsSession {
    fn prepared(epoch: u64) -> Self {
        Self {
            epoch,
            revision: 1,
            prepared_at: Instant::now(),
            observed_playout_seconds: None,
            handoff_sequence: None,
            pending_handoff_sequence: None,
            reserve_buffer_seconds: HLS_DEFAULT_RESERVE_BUFFER_SECONDS,
            projected_playback_manifest: false,
            tracks: Vec::new(),
        }
    }

    fn prepare_start(&mut self, track: PublishedTrack) {
        self.tracks.clear();
        self.tracks.push(track);
        self.handoff_sequence = None;
        self.pending_handoff_sequence = None;
        self.revision = self.revision.saturating_add(1);
    }

    #[cfg(test)]
    fn commit_handoff_at(&mut self, current_sequence: u64) -> bool {
        if self.tracks.is_empty() || self.handoff_sequence.is_some() {
            return false;
        }
        self.handoff_sequence = Some(
            current_sequence
                .saturating_add(HLS_PRIMING_WINDOW_AHEAD)
                .saturating_add(1),
        );
        self.revision = self.revision.saturating_add(1);
        true
    }

    fn offer_handoff(
        &mut self,
        ready_seconds: f64,
        playout_seconds: f64,
        protected_sequence: u64,
    ) -> Option<u64> {
        if let Some(sequence) = self.handoff_sequence.or(self.pending_handoff_sequence) {
            return Some(sequence);
        }
        if !ready_seconds.is_finite() || ready_seconds <= 0.0 {
            return None;
        }
        if !playout_seconds.is_finite() || playout_seconds < 0.0 {
            return None;
        }
        let current_sequence = (playout_seconds / HLS_PRIMING_SEGMENT_SECONDS).floor() as u64;
        if protected_sequence <= current_sequence {
            return None;
        }
        self.pending_handoff_sequence = Some(protected_sequence);
        Some(protected_sequence)
    }

    fn commit_offered_handoff(&mut self, sequence: u64) -> bool {
        if self.handoff_sequence == Some(sequence) && self.pending_handoff_sequence.is_none() {
            return true;
        }
        if self.tracks.is_empty() || self.pending_handoff_sequence != Some(sequence) {
            return false;
        }
        self.pending_handoff_sequence = None;
        self.handoff_sequence = Some(sequence);
        self.revision = self.revision.saturating_add(1);
        true
    }

    fn append_tracks(&mut self, tracks: Vec<PublishedTrack>) -> bool {
        if tracks.is_empty() {
            return false;
        }
        self.tracks.extend(tracks);
        self.revision = self.revision.saturating_add(1);
        true
    }

    fn set_reserve_buffer_seconds(&mut self, buffer_seconds: u32) {
        self.reserve_buffer_seconds = self.reserve_buffer_seconds.max(buffer_seconds.clamp(
            HLS_DEFAULT_RESERVE_BUFFER_SECONDS,
            HLS_MAX_RESERVE_BUFFER_SECONDS,
        ));
    }

    fn enable_projected_playback_manifest(&mut self) {
        self.projected_playback_manifest = true;
    }

    fn observe_playout_seconds(&mut self, playout_seconds: Option<f64>) {
        let Some(playout_seconds) =
            playout_seconds.filter(|value| value.is_finite() && *value >= 0.0)
        else {
            return;
        };
        self.observed_playout_seconds = Some(
            self.observed_playout_seconds
                .unwrap_or_default()
                .max(playout_seconds),
        );
    }

    fn snapshot(&self) -> P2pHlsSessionSnapshot {
        let mut cursor =
            self.handoff_sequence.unwrap_or_default() as f64 * HLS_PRIMING_SEGMENT_SECONDS;
        let entries = self
            .tracks
            .iter()
            .enumerate()
            .map(|(index, published)| {
                let start_seconds = cursor;
                cursor += published
                    .asset
                    .segments
                    .iter()
                    .map(|segment| segment.duration_seconds)
                    .sum::<f64>();
                P2pHlsTimelineEntry {
                    id: format!(
                        "{}:{}:{}:{}:{}",
                        self.epoch,
                        index,
                        published.track.canonical_music_id,
                        published.track.start_ms,
                        published.track.end_ms
                    ),
                    track: published.track.clone(),
                    start_seconds,
                    end_seconds: cursor,
                }
            })
            .collect();
        P2pHlsSessionSnapshot {
            epoch: self.epoch,
            revision: self.revision,
            stream_url: stream_url(self.epoch),
            reserve_url: reserve_url(self.epoch),
            entries,
        }
    }

    fn manifest(&self) -> String {
        self.manifest_at(self.current_prime_sequence())
    }

    fn manifest_at(&self, current_sequence: u64) -> String {
        let ahead_seconds = if self.projected_playback_manifest {
            HLS_PLAYBACK_AHEAD_SEGMENTS * HLS_SEGMENT_SECONDS
        } else {
            self.reserve_buffer_seconds
        };
        self.manifest_with_ahead(current_sequence, f64::from(ahead_seconds), false)
    }

    fn reserve_manifest(&self) -> String {
        self.reserve_manifest_at(self.current_prime_sequence())
    }

    fn reserve_manifest_at(&self, current_sequence: u64) -> String {
        self.manifest_with_ahead(current_sequence, f64::INFINITY, true)
    }

    fn manifest_with_ahead(
        &self,
        current_sequence: u64,
        ahead_seconds: f64,
        include_prepared_tracks: bool,
    ) -> String {
        let target_duration = self
            .tracks
            .iter()
            .map(|track| track.asset.target_duration)
            .max()
            .unwrap_or(HLS_SEGMENT_SECONDS)
            .max(HLS_SEGMENT_SECONDS);
        let handoff_sequence = self.handoff_sequence;
        let media_sequence = handoff_sequence
            .map(|handoff| handoff.saturating_sub(HLS_PRIMING_WINDOW_BEHIND.saturating_add(1)))
            .unwrap_or_else(|| current_sequence.saturating_sub(HLS_PRIMING_WINDOW_BEHIND));
        let mut manifest = format!(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:{target_duration}\n\
             #EXT-X-MEDIA-SEQUENCE:{media_sequence}\n"
        );
        let priming_end = handoff_sequence.unwrap_or_else(|| {
            current_sequence
                .saturating_add(HLS_PRIMING_WINDOW_AHEAD)
                .saturating_add(1)
        });
        for _ in media_sequence..priming_end {
            manifest.push_str(&format!(
                "#EXTINF:{HLS_PRIMING_SEGMENT_SECONDS:.6},\n{LOCAL_PRIMING_SEGMENT_URL}\n"
            ));
        }
        if handoff_sequence.is_none() && !include_prepared_tracks {
            return manifest;
        }
        let handoff_seconds =
            handoff_sequence.unwrap_or(priming_end) as f64 * HLS_PRIMING_SEGMENT_SECONDS;
        let availability_end = handoff_seconds
            .max(current_sequence as f64 * HLS_PRIMING_SEGMENT_SECONDS)
            + ahead_seconds;
        let mut cursor = handoff_seconds;
        'tracks: for (track_index, track) in self.tracks.iter().enumerate() {
            let mut discontinuity_pending = true;
            for (segment_index, segment) in track.asset.segments.iter().enumerate() {
                if cursor >= availability_end {
                    break 'tracks;
                }
                if discontinuity_pending {
                    manifest.push_str("#EXT-X-DISCONTINUITY\n");
                    discontinuity_pending = false;
                }
                manifest.push_str(&format!(
                    "#EXTINF:{:.6},\np2p-hls://session/{}/track/{track_index}/segment/{segment_index}.ts\n",
                    segment.duration_seconds, self.epoch
                ));
                cursor += segment.duration_seconds;
            }
        }
        manifest
    }

    fn current_prime_sequence(&self) -> u64 {
        let playout_seconds = self
            .observed_playout_seconds
            .unwrap_or_else(|| self.prepared_at.elapsed().as_secs_f64());
        (playout_seconds / HLS_PRIMING_SEGMENT_SECONDS).floor() as u64
    }
}

pub(super) struct RemoteP2pHls {
    cache_root: PathBuf,
    epoch_clock: AtomicU64,
    sessions: Mutex<HashMap<String, ClientHlsSession>>,
    materialization_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl RemoteP2pHls {
    pub(super) fn new(cache_root: PathBuf) -> Result<Arc<Self>> {
        fs::create_dir_all(&cache_root)?;
        Ok(Arc::new(Self {
            cache_root,
            epoch_clock: AtomicU64::new(current_epoch_micros()),
            sessions: Mutex::new(HashMap::new()),
            materialization_locks: Mutex::new(HashMap::new()),
        }))
    }

    pub(super) fn prepare(&self, client_id: &str) -> Result<P2pHlsSessionSnapshot> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("remote P2P HLS session lock is poisoned"))?;
        self.epoch_clock
            .fetch_max(current_epoch_micros(), Ordering::Relaxed);
        let epoch = self.epoch_clock.fetch_add(1, Ordering::Relaxed) + 1;
        let session = ClientHlsSession::prepared(epoch);
        let snapshot = session.snapshot();
        sessions.insert(client_id.to_owned(), session);
        Ok(snapshot)
    }

    pub(super) async fn publish_start(
        self: &Arc<Self>,
        client_id: &str,
        track: PlaybackTrack,
        source: P2pHlsSource,
    ) -> Result<P2pHlsSessionSnapshot> {
        let asset = self.materialize(source).await?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("remote P2P HLS session lock is poisoned"))?;
        let session = sessions
            .get_mut(client_id)
            .ok_or_else(|| anyhow!("remote P2P HLS session is not prepared"))?;
        if !session.tracks.is_empty() {
            return Err(anyhow!(
                "remote P2P HLS session must be stopped before a new start"
            ));
        }
        session.prepare_start(PublishedTrack { track, asset });
        Ok(session.snapshot())
    }

    pub(super) fn offer_handoff(
        &self,
        client_id: &str,
        epoch: u64,
        ready_seconds: f64,
        playout_seconds: f64,
        protected_sequence: u64,
    ) -> Result<Option<u64>> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("remote P2P HLS session lock is poisoned"))?;
        let Some(session) = sessions.get_mut(client_id) else {
            return Ok(None);
        };
        if session.epoch != epoch {
            return Ok(None);
        }
        Ok(session.offer_handoff(ready_seconds, playout_seconds, protected_sequence))
    }

    pub(super) fn commit_handoff(
        &self,
        client_id: &str,
        epoch: u64,
        handoff_sequence: u64,
    ) -> Result<Option<P2pHlsSessionSnapshot>> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("remote P2P HLS session lock is poisoned"))?;
        let Some(session) = sessions.get_mut(client_id) else {
            return Ok(None);
        };
        if session.epoch != epoch || !session.commit_offered_handoff(handoff_sequence) {
            return Ok(None);
        }
        Ok(Some(session.snapshot()))
    }

    pub(super) async fn append_tracks(
        self: &Arc<Self>,
        client_id: &str,
        tracks: Vec<(PlaybackTrack, P2pHlsSource)>,
    ) -> Result<Option<P2pHlsSessionSnapshot>> {
        let epoch = self.snapshot(client_id)?.epoch;
        let mut published = Vec::with_capacity(tracks.len());
        for (track, source) in tracks {
            published.push(PublishedTrack {
                track,
                asset: self.materialize(source).await?,
            });
        }
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("remote P2P HLS session lock is poisoned"))?;
        let session = sessions
            .get_mut(client_id)
            .ok_or_else(|| anyhow!("remote P2P HLS session is not prepared"))?;
        if session.epoch != epoch || !session.append_tracks(published) {
            return Ok(None);
        }
        Ok(Some(session.snapshot()))
    }

    pub(super) fn set_reserve_buffer_seconds(
        &self,
        client_id: &str,
        buffer_seconds: u32,
    ) -> Result<bool> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("remote P2P HLS session lock is poisoned"))?;
        let Some(session) = sessions.get_mut(client_id) else {
            return Ok(false);
        };
        session.set_reserve_buffer_seconds(buffer_seconds);
        Ok(true)
    }

    pub(super) fn snapshot(&self, client_id: &str) -> Result<P2pHlsSessionSnapshot> {
        self.sessions
            .lock()
            .map_err(|_| anyhow!("remote P2P HLS session lock is poisoned"))?
            .get(client_id)
            .map(ClientHlsSession::snapshot)
            .ok_or_else(|| anyhow!("remote P2P HLS session is not prepared"))
    }

    pub(super) fn remove(&self, client_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(client_id);
        }
    }

    pub(super) fn clear(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.clear();
        }
    }

    pub(super) async fn resolve_asset(
        &self,
        client_id: &str,
        url: &str,
        playout_seconds: Option<f64>,
    ) -> Result<P2pHlsAsset> {
        enum AssetRef {
            Manifest(String),
            Segment(PathBuf),
        }
        let asset = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("remote P2P HLS session lock is poisoned"))?;
            let session = sessions
                .get_mut(client_id)
                .ok_or_else(|| anyhow!("remote P2P HLS session is not prepared"))?;
            let path = parse_session_url(url, session.epoch)?;
            match path {
                SessionAssetPath::Manifest => {
                    session.observe_playout_seconds(playout_seconds);
                    AssetRef::Manifest(session.manifest())
                }
                SessionAssetPath::ReserveManifest => {
                    session.enable_projected_playback_manifest();
                    session.observe_playout_seconds(playout_seconds);
                    AssetRef::Manifest(session.reserve_manifest())
                }
                SessionAssetPath::Segment {
                    track_index,
                    segment_index,
                } => {
                    let path = session
                        .tracks
                        .get(track_index)
                        .and_then(|track| track.asset.segments.get(segment_index))
                        .map(|segment| segment.path.clone())
                        .ok_or_else(|| anyhow!("remote P2P HLS segment is not published"))?;
                    AssetRef::Segment(path)
                }
            }
        };
        match asset {
            AssetRef::Manifest(manifest) => Ok(P2pHlsAsset {
                content_type: "application/vnd.apple.mpegurl",
                body: Bytes::from(manifest),
            }),
            AssetRef::Segment(path) => Ok(P2pHlsAsset {
                content_type: "video/mp2t",
                body: Bytes::from(tokio::fs::read(path).await?),
            }),
        }
    }

    async fn materialize(self: &Arc<Self>, source: P2pHlsSource) -> Result<HlsTrackAsset> {
        let metadata = tokio::fs::metadata(&source.file_path).await?;
        if metadata.len() == 0 {
            return Err(anyhow!("remote P2P HLS source is empty"));
        }
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(HLS_MATERIALIZATION_VERSION.as_bytes());
        hasher.update(source.file_path.to_string_lossy().as_bytes());
        hasher.update(source.start_ms.to_le_bytes());
        hasher.update(source.end_ms.to_le_bytes());
        hasher.update(source.gain_db.to_bits().to_le_bytes());
        hasher.update(metadata.len().to_le_bytes());
        hasher.update(modified_ms.to_le_bytes());
        let key = hex::encode(hasher.finalize());
        let hls_dir = self.cache_root.join(format!("{key}.hls"));
        let playlist_path = hls_dir.join("playlist.m3u8");
        if let Ok(asset) = parse_track_asset(&playlist_path, &hls_dir) {
            if !asset.segments.is_empty() {
                return Ok(asset);
            }
        }
        let lock = {
            let mut locks = self
                .materialization_locks
                .lock()
                .map_err(|_| anyhow!("remote P2P HLS materialization lock is poisoned"))?;
            Arc::clone(locks.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))))
        };
        tokio::task::spawn_blocking(move || {
            materialize_blocking(source, hls_dir, playlist_path, lock)
        })
        .await?
    }
}

enum SessionAssetPath {
    Manifest,
    ReserveManifest,
    Segment {
        track_index: usize,
        segment_index: usize,
    },
}

fn parse_session_url(url: &str, expected_epoch: u64) -> Result<SessionAssetPath> {
    let path = url
        .strip_prefix("p2p-hls://session/")
        .ok_or_else(|| anyhow!("invalid remote P2P HLS URL"))?;
    let mut parts = path.split('/');
    let epoch = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| anyhow!("invalid remote P2P HLS epoch"))?;
    if epoch != expected_epoch {
        return Err(anyhow!("stale remote P2P HLS epoch"));
    }
    match parts.next() {
        Some("index.m3u8") if parts.next().is_none() => Ok(SessionAssetPath::Manifest),
        Some("reserve.m3u8") if parts.next().is_none() => Ok(SessionAssetPath::ReserveManifest),
        Some("track") => {
            let track_index = parts
                .next()
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or_else(|| anyhow!("invalid remote P2P HLS track index"))?;
            if parts.next() != Some("segment") {
                return Err(anyhow!("invalid remote P2P HLS segment URL"));
            }
            let segment_index = parts
                .next()
                .and_then(|value| value.strip_suffix(".ts"))
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or_else(|| anyhow!("invalid remote P2P HLS segment index"))?;
            if parts.next().is_some() {
                return Err(anyhow!("invalid remote P2P HLS segment suffix"));
            }
            Ok(SessionAssetPath::Segment {
                track_index,
                segment_index,
            })
        }
        _ => Err(anyhow!("unknown remote P2P HLS asset")),
    }
}

fn materialize_blocking(
    source: P2pHlsSource,
    hls_dir: PathBuf,
    playlist_path: PathBuf,
    lock: Arc<Mutex<()>>,
) -> Result<HlsTrackAsset> {
    let _guard = lock
        .lock()
        .map_err(|_| anyhow!("remote P2P HLS materialization lock is poisoned"))?;
    if let Ok(asset) = parse_track_asset(&playlist_path, &hls_dir) {
        if !asset.segments.is_empty() {
            return Ok(asset);
        }
    }
    let _ = fs::remove_dir_all(&hls_dir);
    fs::create_dir_all(&hls_dir)?;
    let segment_pattern = hls_dir.join("segment%05d.ts");
    let _usage = acquire_managed_binary_usage(ManagedBinary::Ffmpeg, "remote-p2p-hls");
    let mut command = Command::new(&source.ffmpeg_path);
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-ss")
        .arg(format_seconds(source.start_ms))
        .arg("-i")
        .arg(&source.file_path)
        .arg("-t")
        .arg(format_seconds(
            source.end_ms.saturating_sub(source.start_ms),
        ))
        .arg("-map")
        .arg("0:a:0")
        .arg("-vn");
    if source.gain_db.abs() > 0.001 {
        command
            .arg("-af")
            .arg(format!("volume={:.3}dB", source.gain_db));
    }
    command
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg(HLS_AUDIO_BITRATE)
        .arg("-f")
        .arg("hls")
        .arg("-hls_time")
        .arg(HLS_SEGMENT_SECONDS.to_string())
        .arg("-hls_playlist_type")
        .arg("event")
        .arg("-hls_segment_filename")
        .arg(&segment_pattern)
        .arg(&playlist_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = command.output()?;
    if !output.status.success() {
        let _ = fs::remove_dir_all(&hls_dir);
        return Err(anyhow!(
            "remote P2P HLS materialization failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let asset = parse_track_asset(&playlist_path, &hls_dir)?;
    if asset.segments.is_empty() {
        let _ = fs::remove_dir_all(&hls_dir);
        return Err(anyhow!(
            "remote P2P HLS materialization produced no segments"
        ));
    }
    Ok(asset)
}

fn parse_track_asset(playlist_path: &Path, hls_dir: &Path) -> Result<HlsTrackAsset> {
    let text = fs::read_to_string(playlist_path)?;
    let mut target_duration = HLS_SEGMENT_SECONDS;
    let mut pending_duration = None;
    let mut segments = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Some(value) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            target_duration = value.parse::<u32>().unwrap_or(target_duration).max(1);
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            pending_duration = value.trim_end_matches(',').parse::<f64>().ok();
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let Some(duration_seconds) = pending_duration.take() else {
            continue;
        };
        let path = hls_dir.join(line);
        if !path
            .metadata()
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            return Err(anyhow!("remote P2P HLS segment is missing"));
        }
        segments.push(HlsSegmentAsset {
            duration_seconds,
            path,
        });
    }
    Ok(HlsTrackAsset {
        target_duration,
        segments,
    })
}

fn stream_url(epoch: u64) -> String {
    format!("p2p-hls://session/{epoch}/index.m3u8")
}

fn reserve_url(epoch: u64) -> String {
    format!("p2p-hls://session/{epoch}/reserve.m3u8")
}

fn current_epoch_micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_micros() as u64)
        .unwrap_or(1)
}

fn format_seconds(ms: u32) -> String {
    format!("{:.3}", f64::from(ms) / 1000.0)
}

#[cfg(test)]
#[path = "remote_p2p_hls.test.rs"]
mod tests;
