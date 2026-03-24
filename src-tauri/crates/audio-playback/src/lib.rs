use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use rodio::cpal;
use rodio::cpal::traits::{DeviceTrait as _, HostTrait as _};
use rodio::cpal::{SampleFormat, SupportedStreamConfig};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::any::Any;
use std::fmt;
use std::fs::{self, File};
use std::io::{BufReader, ErrorKind, Read, Write};
use std::num::NonZero;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const DEFAULT_TARGET_LUFS: f32 = -18.0;
const MAX_GAIN_DB: f32 = 3.0;
const MIN_GAIN_DB: f32 = -18.0;
const OUTPUT_TRUE_PEAK_CEIL_DBTP: f32 = -2.0;
const LIMITER_LINEAR_CEIL: f32 = 0.794_328;
const LIMITER_GUARD_MARGIN_DB: f32 = 0.3;
const HOT_MASTER_LUFS_THRESHOLD: f32 = -14.0;
const HOT_MASTER_PROTECT_SLOPE: f32 = 0.35;
const HOT_MASTER_PROTECT_MAX_DB: f32 = 1.5;
const DEBUG_PROBE_DEFAULT_CAPTURE_MS: u32 = 12_000;
const DEBUG_PROBE_MIN_CAPTURE_MS: u32 = 500;
const DEBUG_PROBE_MAX_CAPTURE_MS: u32 = 30_000;
const DEBUG_PROBE_DEFAULT_SAMPLE_RATE: u32 = 48_000;
const DEBUG_PROBE_MIN_SAMPLE_RATE: u32 = 8_000;
const DEBUG_PROBE_MAX_SAMPLE_RATE: u32 = 192_000;
const DEBUG_PROBE_DEFAULT_CHANNELS: u16 = 2;
const DEBUG_PROBE_MAX_CHANNELS: u16 = 2;
const DBFS_FLOOR: f32 = -240.0;

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct AudioStatus {
    pub path: Option<String>,
    pub playing: bool,
    pub paused: bool,
    pub position_ms: u32,
    pub duration_ms: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq)]
pub struct AudioEndedPayload {
    pub session_id: u64,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq)]
pub struct AudioStoppedPayload {
    pub session_id: u64,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq)]
pub struct AudioPausedPayload {
    pub session_id: u64,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq)]
pub struct AudioResumedPayload {
    pub session_id: u64,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq)]
pub struct AudioFailedPayload {
    pub session_id: u64,
    pub path: String,
    pub action: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioPlayRequest {
    pub session_id: u64,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlaybackNormalization {
    pub target_lufs: f32,
    pub integrated_lufs: Option<f32>,
    pub true_peak_dbtp: Option<f32>,
}

impl Default for PlaybackNormalization {
    fn default() -> Self {
        Self {
            target_lufs: DEFAULT_TARGET_LUFS,
            integrated_lufs: None,
            true_peak_dbtp: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PlaybackRequest {
    pub path: PathBuf,
    pub session_id: Option<u64>,
    pub normalization: Option<PlaybackNormalization>,
}

impl PlaybackRequest {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            session_id: None,
            normalization: None,
        }
    }

    pub fn with_session_id(mut self, session_id: u64) -> Self {
        self.session_id = Some(session_id);
        self
    }

    pub fn with_normalization(mut self, normalization: PlaybackNormalization) -> Self {
        self.normalization = Some(normalization);
        self
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedAudioPlayRequest {
    session_id: u64,
    path: String,
    gain_db: f32,
    target_lufs: f32,
    integrated_lufs: Option<f32>,
    has_canonical_loudness: bool,
    track_true_peak_dbtp: Option<f32>,
    ffmpeg_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioDebugSpectrogramRequest {
    pub path: String,
    pub target_lufs: Option<f32>,
    pub track_lufs: Option<f32>,
    pub track_true_peak_dbtp: Option<f32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioDebugSpectrogram {
    pub raw_data_url: String,
    pub processed_data_url: String,
    pub gain_db: f32,
    pub playback_filter: String,
    pub width: u32,
    pub height: u32,
    pub duration_ms: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioDebugProbeRequest {
    pub path: String,
    pub target_lufs: Option<f32>,
    pub track_lufs: Option<f32>,
    pub track_true_peak_dbtp: Option<f32>,
    pub offset_ms: Option<u32>,
    pub capture_ms: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioDebugProbeStats {
    pub sample_count: u32,
    pub finite_sample_count: u32,
    pub non_finite_count: u32,
    pub over_unity_count: u32,
    pub over_unity_ratio: f32,
    pub peak_dbfs: f32,
    pub rms_dbfs: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioDebugProbeResult {
    pub output_dir: String,
    pub metadata_json: String,
    pub raw_wav: String,
    pub processed_wav: String,
    pub output_wav: String,
    pub gain_db: f32,
    pub playback_filter: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub offset_ms: u32,
    pub requested_capture_ms: u32,
    pub actual_capture_ms: u32,
    pub raw_stats: AudioDebugProbeStats,
    pub processed_stats: AudioDebugProbeStats,
    pub output_stats: AudioDebugProbeStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AudioDebugProbeMetadata {
    created_epoch_ms: u64,
    input_path: String,
    gain_db: f32,
    playback_filter: String,
    sample_rate: u32,
    channels: u16,
    offset_ms: u32,
    requested_capture_ms: u32,
    actual_capture_ms: u32,
    raw_stats: AudioDebugProbeStats,
    processed_stats: AudioDebugProbeStats,
    output_stats: AudioDebugProbeStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioPlayAck {
    pub session_id: u64,
    pub path: String,
    pub duration_ms: Option<u32>,
    pub gain: f32,
    pub gain_db: f32,
    pub target_lufs: f32,
    pub integrated_lufs: Option<f32>,
    pub has_canonical_loudness: bool,
}

pub trait AudioEventSink: Send + Sync + 'static {
    fn emit_state(&self, status: &AudioStatus);
    fn emit_ended(&self, payload: &AudioEndedPayload);
    fn emit_stopped(&self, payload: &AudioStoppedPayload);
    fn emit_paused(&self, payload: &AudioPausedPayload);
    fn emit_resumed(&self, payload: &AudioResumedPayload);
    fn emit_failed(&self, payload: &AudioFailedPayload);
}

#[derive(Debug, Default)]
pub struct NoopAudioEventSink;

impl AudioEventSink for NoopAudioEventSink {
    fn emit_state(&self, _status: &AudioStatus) {}
    fn emit_ended(&self, _payload: &AudioEndedPayload) {}
    fn emit_stopped(&self, _payload: &AudioStoppedPayload) {}
    fn emit_paused(&self, _payload: &AudioPausedPayload) {}
    fn emit_resumed(&self, _payload: &AudioResumedPayload) {}
    fn emit_failed(&self, _payload: &AudioFailedPayload) {}
}

pub struct PlaybackBuilder {
    ffmpeg_path: PathBuf,
    event_sink: Arc<dyn AudioEventSink>,
    default_normalization: PlaybackNormalization,
    session_seed: u64,
}

impl PlaybackBuilder {
    pub fn new(ffmpeg_path: impl Into<PathBuf>) -> Self {
        Self {
            ffmpeg_path: ffmpeg_path.into(),
            event_sink: Arc::new(NoopAudioEventSink),
            default_normalization: PlaybackNormalization::default(),
            session_seed: 1,
        }
    }

    pub fn event_sink(mut self, event_sink: Arc<dyn AudioEventSink>) -> Self {
        self.event_sink = event_sink;
        self
    }

    pub fn default_normalization(mut self, normalization: PlaybackNormalization) -> Self {
        self.default_normalization = normalization;
        self
    }

    pub fn session_seed(mut self, session_seed: u64) -> Self {
        self.session_seed = session_seed.max(1);
        self
    }

    pub fn build(self) -> Result<Playback, String> {
        if !self.ffmpeg_path.exists() {
            return Err(format!(
                "ffmpeg binary not found: {}",
                self.ffmpeg_path.display()
            ));
        }

        Ok(Playback {
            shared: Arc::new(PlaybackShared {
                ffmpeg_path: self.ffmpeg_path,
                default_normalization: self.default_normalization,
                next_session_id: AtomicU64::new(self.session_seed),
                engine: AudioEngine::spawn(self.event_sink)?,
            }),
        })
    }
}

struct PlaybackShared {
    ffmpeg_path: PathBuf,
    default_normalization: PlaybackNormalization,
    next_session_id: AtomicU64,
    engine: AudioEngine,
}

#[derive(Clone)]
pub struct Playback {
    shared: Arc<PlaybackShared>,
}

impl Playback {
    pub fn builder(ffmpeg_path: impl Into<PathBuf>) -> PlaybackBuilder {
        PlaybackBuilder::new(ffmpeg_path)
    }

    pub fn new(ffmpeg_path: impl Into<PathBuf>) -> Result<Self, String> {
        Self::builder(ffmpeg_path).build()
    }

    pub fn ffmpeg_path(&self) -> &Path {
        self.shared.ffmpeg_path.as_path()
    }

    pub fn default_normalization(&self) -> &PlaybackNormalization {
        &self.shared.default_normalization
    }

    pub async fn play(&self, path: impl Into<PathBuf>) -> Result<AudioPlayAck, EngineRequestError> {
        self.play_request(PlaybackRequest::new(path)).await
    }

    pub async fn play_request(
        &self,
        request: PlaybackRequest,
    ) -> Result<AudioPlayAck, EngineRequestError> {
        let resolved = self.resolve_request(request);
        self.shared.engine.play(resolved).await
    }

    pub async fn pause(&self) -> Result<(), EngineRequestError> {
        self.shared.engine.pause().await
    }

    pub async fn resume(&self) -> Result<(), EngineRequestError> {
        self.shared.engine.resume().await
    }

    pub async fn stop(&self) -> Result<(), EngineRequestError> {
        self.shared.engine.stop().await
    }

    pub async fn status(&self) -> Result<AudioStatus, EngineRequestError> {
        self.shared.engine.status().await
    }

    pub fn next_session_id(&self) -> u64 {
        self.shared.next_session_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn resolve_request(&self, request: PlaybackRequest) -> ResolvedAudioPlayRequest {
        let normalization = request
            .normalization
            .map(|value| merge_normalization(self.shared.default_normalization.clone(), value))
            .unwrap_or_else(|| self.shared.default_normalization.clone());
        resolve_audio_play_request(
            AudioPlayRequest {
                session_id: request.session_id.unwrap_or_else(|| self.next_session_id()),
                path: request.path.to_string_lossy().to_string(),
            },
            normalization,
            self.shared.ffmpeg_path.clone(),
        )
    }
}

#[derive(Clone)]
pub struct AudioEngine {
    tx: Sender<EngineCmd>,
}

#[derive(Debug)]
pub enum EngineRequestError {
    Disconnected,
    ResponseDropped,
    Command(String),
}

impl EngineRequestError {
    pub fn should_reset(&self) -> bool {
        matches!(self, Self::Disconnected | Self::ResponseDropped)
    }
}

impl fmt::Display for EngineRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Disconnected => f.write_str("audio engine thread stopped"),
            Self::ResponseDropped => f.write_str("audio engine response dropped"),
            Self::Command(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for EngineRequestError {}

struct PlayerState {
    session_id: Option<u64>,
    sink: Option<Player>,
    path: Option<String>,
    started_at: Option<Instant>,
    paused_started_at: Option<Instant>,
    paused_total: Duration,
    duration_ms: Option<u32>,
    paused: bool,
}

impl PlayerState {
    fn new() -> Self {
        Self {
            session_id: None,
            sink: None,
            path: None,
            started_at: None,
            paused_started_at: None,
            paused_total: Duration::from_millis(0),
            duration_ms: None,
            paused: false,
        }
    }

    fn clear(&mut self) {
        if let Some(sink) = self.sink.take() {
            sink.stop();
        }
        self.session_id = None;
        self.path = None;
        self.started_at = None;
        self.paused_started_at = None;
        self.paused_total = Duration::from_millis(0);
        self.duration_ms = None;
        self.paused = false;
    }

    fn position_ms_at(&self, now: Instant) -> u32 {
        let Some(started_at) = self.started_at else {
            return 0;
        };
        let effective_now = if self.paused {
            self.paused_started_at.unwrap_or(now)
        } else {
            now
        };
        let elapsed = effective_now.saturating_duration_since(started_at);
        let active = elapsed.saturating_sub(self.paused_total);
        saturating_millis_u32(active)
    }

    fn position_ms(&self) -> u32 {
        self.position_ms_at(Instant::now())
    }

    fn resume_at(&mut self, resumed_at: Instant) {
        self.paused = false;
        if let Some(paused_at) = self.paused_started_at.take() {
            self.paused_total += resumed_at.saturating_duration_since(paused_at);
        }
    }

    fn to_status(&self) -> AudioStatus {
        let playing = self
            .sink
            .as_ref()
            .map(|sink| !sink.empty() && !self.paused)
            .unwrap_or(false);

        AudioStatus {
            path: self.path.clone(),
            playing,
            paused: self.paused,
            position_ms: self.position_ms(),
            duration_ms: self.duration_ms,
        }
    }
}

struct AudioBackend {
    device_sink: MixerDeviceSink,
    output_channels: u16,
    output_sample_rate: u32,
}

struct FfmpegPcmSource {
    child: Option<Child>,
    stdout: BufReader<ChildStdout>,
    channels: u16,
    sample_rate: u32,
}

impl Iterator for FfmpegPcmSource {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        let mut bytes = [0u8; 4];
        match self.stdout.read_exact(&mut bytes) {
            Ok(()) => Some(sanitize_pcm_sample(f32::from_le_bytes(bytes))),
            Err(error) => {
                if !matches!(error.kind(), ErrorKind::UnexpectedEof | ErrorKind::BrokenPipe) {
                    eprintln!("ffmpeg pcm stream read error: {error}");
                }
                None
            }
        }
    }
}

impl Source for FfmpegPcmSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> rodio::ChannelCount {
        NonZero::new(self.channels).expect("stream channel count must be non-zero")
    }

    fn sample_rate(&self) -> rodio::SampleRate {
        NonZero::new(self.sample_rate).expect("stream sample rate must be non-zero")
    }

    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

impl Drop for FfmpegPcmSource {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

enum EngineCmd {
    Play {
        req: ResolvedAudioPlayRequest,
        respond: oneshot::Sender<Result<AudioPlayAck, String>>,
    },
    Pause {
        respond: oneshot::Sender<Result<(), String>>,
    },
    Resume {
        respond: oneshot::Sender<Result<(), String>>,
    },
    Stop {
        respond: oneshot::Sender<Result<(), String>>,
    },
    Status {
        respond: oneshot::Sender<Result<AudioStatus, String>>,
    },
}

impl AudioEngine {
    pub fn spawn(event_sink: Arc<dyn AudioEventSink>) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel::<EngineCmd>();
        std::thread::Builder::new()
            .name("slisic-audio-engine".to_string())
            .spawn(move || run_engine_loop(event_sink, rx))
            .map_err(|e| e.to_string())?;
        Ok(Self { tx })
    }

    pub async fn play(
        &self,
        req: ResolvedAudioPlayRequest,
    ) -> Result<AudioPlayAck, EngineRequestError> {
        self.send_request(|respond| EngineCmd::Play {
            req: req.clone(),
            respond,
        })
        .await
    }

    pub async fn pause(&self) -> Result<(), EngineRequestError> {
        self.send_request(|respond| EngineCmd::Pause { respond }).await
    }

    pub async fn resume(&self) -> Result<(), EngineRequestError> {
        self.send_request(|respond| EngineCmd::Resume { respond }).await
    }

    pub async fn stop(&self) -> Result<(), EngineRequestError> {
        self.send_request(|respond| EngineCmd::Stop { respond }).await
    }

    pub async fn status(&self) -> Result<AudioStatus, EngineRequestError> {
        self.send_request(|respond| EngineCmd::Status { respond }).await
    }

    async fn send_request<T, F>(&self, make_cmd: F) -> Result<T, EngineRequestError>
    where
        F: FnOnce(oneshot::Sender<Result<T, String>>) -> EngineCmd,
    {
        let (respond, rx) = oneshot::channel();
        if self.tx.send(make_cmd(respond)).is_err() {
            return Err(EngineRequestError::Disconnected);
        }

        match rx.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(EngineRequestError::Command(error)),
            Err(_) => Err(EngineRequestError::ResponseDropped),
        }
    }
}

pub fn resolve_audio_play_request(
    req: AudioPlayRequest,
    normalization: PlaybackNormalization,
    ffmpeg_path: PathBuf,
) -> ResolvedAudioPlayRequest {
    let gain_db = compute_gain_db(
        Some(normalization.target_lufs),
        normalization.integrated_lufs,
        normalization.true_peak_dbtp,
    );

    ResolvedAudioPlayRequest {
        session_id: req.session_id,
        path: req.path,
        gain_db,
        target_lufs: normalization.target_lufs,
        integrated_lufs: normalization.integrated_lufs,
        has_canonical_loudness: normalization.integrated_lufs.is_some(),
        track_true_peak_dbtp: normalization.true_peak_dbtp,
        ffmpeg_path,
    }
}

fn merge_normalization(
    base: PlaybackNormalization,
    request: PlaybackNormalization,
) -> PlaybackNormalization {
    PlaybackNormalization {
        target_lufs: request.target_lufs,
        integrated_lufs: request.integrated_lufs.or(base.integrated_lufs),
        true_peak_dbtp: request.true_peak_dbtp.or(base.true_peak_dbtp),
    }
}

pub fn ensure_debug_mode_available(command_name: &str) -> Result<(), String> {
    if cfg!(debug_assertions) {
        Ok(())
    } else {
        Err(format!("{command_name} is available in debug mode only"))
    }
}

pub fn ensure_audio_file_exists(path: &str) -> Result<PathBuf, String> {
    let input = PathBuf::from(path);
    if !input.exists() {
        return Err(format!("audio file not found: {path}"));
    }
    Ok(input)
}

pub fn generate_debug_spectrogram_with_binary(
    ffmpeg: &Path,
    req: AudioDebugSpectrogramRequest,
) -> Result<AudioDebugSpectrogram, String> {
    let input = ensure_audio_file_exists(&req.path)?;
    let width = clamp_spectrogram_size(req.width, 1400, 640, 4096);
    let height = clamp_spectrogram_size(req.height, 260, 120, 1024);
    let gain_db = compute_gain_db(req.target_lufs, req.track_lufs, req.track_true_peak_dbtp);
    let playback_filter = build_playback_filter(gain_db, req.track_true_peak_dbtp);
    let mut duration_ms = open_decoder(input.as_path())
        .ok()
        .and_then(|(_, duration)| duration);
    if duration_ms.is_none() {
        duration_ms = probe_duration_ms_with_ffprobe(ffmpeg, input.as_path());
    }

    let raw_filter = spectrogram_filter_chain(None, width, height);
    let processed_filter = spectrogram_filter_chain(Some(&playback_filter), width, height);
    let raw_png = run_ffmpeg_spectrogram_png(ffmpeg, input.as_path(), &raw_filter)?;
    let processed_png = run_ffmpeg_spectrogram_png(ffmpeg, input.as_path(), &processed_filter)?;

    Ok(AudioDebugSpectrogram {
        raw_data_url: format!("data:image/png;base64,{}", BASE64_STANDARD.encode(raw_png)),
        processed_data_url: format!(
            "data:image/png;base64,{}",
            BASE64_STANDARD.encode(processed_png)
        ),
        gain_db,
        playback_filter,
        width,
        height,
        duration_ms,
    })
}

pub fn run_audio_debug_probe(
    ffmpeg: &Path,
    output_root: &Path,
    req: AudioDebugProbeRequest,
) -> Result<AudioDebugProbeResult, String> {
    let input = ensure_audio_file_exists(&req.path)?;
    let offset_ms = req.offset_ms.unwrap_or(0);
    let capture_ms = clamp_debug_probe_capture_ms(req.capture_ms);
    let sample_rate = clamp_debug_probe_sample_rate(req.sample_rate);
    let channels = clamp_debug_probe_channels(req.channels);
    let gain_db = compute_gain_db(req.target_lufs, req.track_lufs, req.track_true_peak_dbtp);
    let playback_filter = build_playback_filter(gain_db, req.track_true_peak_dbtp);

    run_audio_debug_probe_with_binary(
        ffmpeg,
        output_root,
        input.as_path(),
        gain_db,
        &playback_filter,
        sample_rate,
        channels,
        offset_ms,
        capture_ms,
    )
}

fn db_to_linear(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

fn dbfs_from_linear(linear: f32) -> f32 {
    if !linear.is_finite() || linear <= 0.0 {
        DBFS_FLOOR
    } else {
        (20.0 * linear.log10()).max(DBFS_FLOOR)
    }
}

fn sanitize_pcm_sample(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

fn compute_gain_db(
    target_lufs: Option<f32>,
    track_lufs: Option<f32>,
    track_true_peak_dbtp: Option<f32>,
) -> f32 {
    let target = target_lufs.unwrap_or(DEFAULT_TARGET_LUFS);
    let current = track_lufs.unwrap_or(target);
    let mut gain_db = (target - current).clamp(MIN_GAIN_DB, MAX_GAIN_DB);
    let hot_master_guard = ((current - HOT_MASTER_LUFS_THRESHOLD).max(0.0)
        * HOT_MASTER_PROTECT_SLOPE)
        .min(HOT_MASTER_PROTECT_MAX_DB);
    gain_db -= hot_master_guard;

    if track_true_peak_dbtp.is_none() && gain_db > 0.0 {
        gain_db = 0.0;
    }

    gain_db.clamp(MIN_GAIN_DB, MAX_GAIN_DB)
}

fn should_apply_limiter(gain_db: f32, track_true_peak_dbtp: Option<f32>) -> bool {
    let Some(tp) = track_true_peak_dbtp else {
        return true;
    };
    let predicted = tp + gain_db;
    predicted > (OUTPUT_TRUE_PEAK_CEIL_DBTP - LIMITER_GUARD_MARGIN_DB)
}

fn build_playback_filter(gain_db: f32, track_true_peak_dbtp: Option<f32>) -> String {
    if should_apply_limiter(gain_db, track_true_peak_dbtp) {
        format!(
            "volume={gain_db:.3}dB,alimiter=limit={LIMITER_LINEAR_CEIL:.6}:attack=5:release=80:level=disabled:latency=1"
        )
    } else {
        format!("volume={gain_db:.3}dB")
    }
}

fn clamp_spectrogram_size(size: Option<u32>, fallback: u32, min: u32, max: u32) -> u32 {
    size.unwrap_or(fallback).clamp(min, max)
}

fn spectrogram_filter_chain(prefix: Option<&str>, width: u32, height: u32) -> String {
    let suffix = format!(
        "aformat=channel_layouts=mono,showspectrumpic=s={width}x{height}:legend=disabled:scale=log"
    );
    match prefix {
        Some(prefix) if !prefix.trim().is_empty() => format!("{prefix},{suffix}"),
        _ => suffix,
    }
}

fn clamp_debug_probe_capture_ms(value: Option<u32>) -> u32 {
    value
        .unwrap_or(DEBUG_PROBE_DEFAULT_CAPTURE_MS)
        .clamp(DEBUG_PROBE_MIN_CAPTURE_MS, DEBUG_PROBE_MAX_CAPTURE_MS)
}

fn clamp_debug_probe_sample_rate(value: Option<u32>) -> u32 {
    value
        .unwrap_or(DEBUG_PROBE_DEFAULT_SAMPLE_RATE)
        .clamp(DEBUG_PROBE_MIN_SAMPLE_RATE, DEBUG_PROBE_MAX_SAMPLE_RATE)
}

fn clamp_debug_probe_channels(value: Option<u16>) -> u16 {
    value
        .unwrap_or(DEBUG_PROBE_DEFAULT_CHANNELS)
        .clamp(1, DEBUG_PROBE_MAX_CHANNELS)
}

fn safe_probe_slug(input: &Path) -> String {
    let base = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track")
        .trim();
    let mut slug = String::new();
    for ch in base.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            slug.push(ch);
        } else {
            slug.push('_');
        }
    }
    let slug = slug.trim_matches('_').to_string();
    if slug.is_empty() {
        "track".to_string()
    } else {
        slug
    }
}

fn analyze_probe_stats(samples: &[f32]) -> AudioDebugProbeStats {
    let mut finite_count: u64 = 0;
    let mut non_finite_count: u64 = 0;
    let mut over_unity_count: u64 = 0;
    let mut sum_sq: f64 = 0.0;
    let mut peak_abs: f32 = 0.0;

    for &sample in samples {
        if !sample.is_finite() {
            non_finite_count = non_finite_count.saturating_add(1);
            continue;
        }
        finite_count = finite_count.saturating_add(1);
        let abs = sample.abs();
        if abs > peak_abs {
            peak_abs = abs;
        }
        if abs > 1.0 {
            over_unity_count = over_unity_count.saturating_add(1);
        }
        let s = sample as f64;
        sum_sq += s * s;
    }

    let finite_for_ratio = finite_count.max(1);
    let rms = if finite_count == 0 {
        0.0
    } else {
        ((sum_sq / finite_count as f64).sqrt()) as f32
    };

    AudioDebugProbeStats {
        sample_count: samples.len().min(u32::MAX as usize) as u32,
        finite_sample_count: finite_count.min(u32::MAX as u64) as u32,
        non_finite_count: non_finite_count.min(u32::MAX as u64) as u32,
        over_unity_count: over_unity_count.min(u32::MAX as u64) as u32,
        over_unity_ratio: (over_unity_count as f64 / finite_for_ratio as f64) as f32,
        peak_dbfs: dbfs_from_linear(peak_abs),
        rms_dbfs: dbfs_from_linear(rms),
    }
}

fn write_f32_wav(
    path: &Path,
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
) -> Result<(), String> {
    let data_bytes = samples
        .len()
        .checked_mul(4)
        .ok_or_else(|| "wav data size overflow".to_string())?;
    if data_bytes > u32::MAX as usize {
        return Err("wav data too large".to_string());
    }
    let data_bytes_u32 = data_bytes as u32;
    let riff_chunk_size = 36u32
        .checked_add(data_bytes_u32)
        .ok_or_else(|| "wav riff size overflow".to_string())?;
    let bytes_per_sample = 4u32;
    let block_align = channels
        .checked_mul(bytes_per_sample as u16)
        .ok_or_else(|| "wav block align overflow".to_string())?;
    let byte_rate = sample_rate
        .checked_mul(block_align as u32)
        .ok_or_else(|| "wav byte rate overflow".to_string())?;

    let mut file = File::create(path).map_err(|e| e.to_string())?;
    file.write_all(b"RIFF").map_err(|e| e.to_string())?;
    file.write_all(&riff_chunk_size.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(b"WAVE").map_err(|e| e.to_string())?;
    file.write_all(b"fmt ").map_err(|e| e.to_string())?;
    file.write_all(&16u32.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&3u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&channels.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&sample_rate.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&byte_rate.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&block_align.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&32u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(b"data").map_err(|e| e.to_string())?;
    file.write_all(&data_bytes_u32.to_le_bytes())
        .map_err(|e| e.to_string())?;

    for sample in samples {
        file.write_all(&sample.to_le_bytes())
            .map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())
}

fn run_ffmpeg_decode_f32(
    ffmpeg: &Path,
    input: &Path,
    filter_chain: Option<&str>,
    sample_rate: u32,
    channels: u16,
    offset_ms: u32,
    capture_ms: u32,
) -> Result<Vec<f32>, String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin");

    if offset_ms > 0 {
        cmd.arg("-ss")
            .arg(format!("{:.3}", offset_ms as f64 / 1000.0));
    }

    cmd.arg("-i").arg(input);

    if let Some(filter) = filter_chain {
        let trimmed = filter.trim();
        if !trimmed.is_empty() {
            cmd.arg("-filter:a").arg(trimmed);
        }
    }

    cmd.arg("-t")
        .arg(format!("{:.3}", capture_ms as f64 / 1000.0))
        .arg("-vn")
        .arg("-sn")
        .arg("-dn")
        .arg("-ac")
        .arg(channels.to_string())
        .arg("-ar")
        .arg(sample_rate.to_string())
        .arg("-f")
        .arg("f32le")
        .arg("-c:a")
        .arg("pcm_f32le")
        .arg("pipe:1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg decode failed: {err}"));
    }
    if output.stdout.is_empty() {
        return Err("ffmpeg decode output is empty".to_string());
    }
    if output.stdout.len() % 4 != 0 {
        return Err("ffmpeg decode output is not aligned to f32".to_string());
    }

    let mut samples = Vec::with_capacity(output.stdout.len() / 4);
    for chunk in output.stdout.chunks_exact(4) {
        samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(samples)
}

fn run_audio_debug_probe_with_binary(
    ffmpeg: &Path,
    output_root: &Path,
    input: &Path,
    gain_db: f32,
    playback_filter: &str,
    sample_rate: u32,
    channels: u16,
    offset_ms: u32,
    capture_ms: u32,
) -> Result<AudioDebugProbeResult, String> {
    let mut raw = run_ffmpeg_decode_f32(
        ffmpeg,
        input,
        None,
        sample_rate,
        channels,
        offset_ms,
        capture_ms,
    )?;
    let mut processed = run_ffmpeg_decode_f32(
        ffmpeg,
        input,
        Some(playback_filter),
        sample_rate,
        channels,
        offset_ms,
        capture_ms,
    )?;

    let frame_stride = channels as usize;
    let sample_count = raw.len().min(processed.len()) / frame_stride * frame_stride;
    if sample_count == 0 {
        return Err("probe decode produced no aligned audio frame".to_string());
    }
    raw.truncate(sample_count);
    processed.truncate(sample_count);

    let mut output = Vec::with_capacity(sample_count);
    output.extend(processed.iter().map(|&sample| sanitize_pcm_sample(sample)));

    let raw_stats = analyze_probe_stats(&raw);
    let processed_stats = analyze_probe_stats(&processed);
    let output_stats = analyze_probe_stats(&output);

    fs::create_dir_all(output_root).map_err(|e| e.to_string())?;
    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let slug = safe_probe_slug(input);
    let output_dir = output_root.join(format!("{slug}-{epoch_ms}"));
    fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;

    let raw_wav = output_dir.join("raw.wav");
    let processed_wav = output_dir.join("processed.wav");
    let output_wav = output_dir.join("output.wav");
    let metadata_json = output_dir.join("metadata.json");

    write_f32_wav(&raw_wav, &raw, sample_rate, channels)?;
    write_f32_wav(&processed_wav, &processed, sample_rate, channels)?;
    write_f32_wav(&output_wav, &output, sample_rate, channels)?;

    let frame_count = sample_count / frame_stride;
    let actual_capture_ms = ((frame_count as f64 * 1000.0) / sample_rate as f64).round() as u32;

    let metadata = AudioDebugProbeMetadata {
        created_epoch_ms: epoch_ms.min(u64::MAX as u128) as u64,
        input_path: input.to_string_lossy().to_string(),
        gain_db,
        playback_filter: playback_filter.to_string(),
        sample_rate,
        channels,
        offset_ms,
        requested_capture_ms: capture_ms,
        actual_capture_ms,
        raw_stats: raw_stats.clone(),
        processed_stats: processed_stats.clone(),
        output_stats: output_stats.clone(),
    };
    let metadata_raw = serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?;
    fs::write(&metadata_json, metadata_raw).map_err(|e| e.to_string())?;

    Ok(AudioDebugProbeResult {
        output_dir: output_dir.to_string_lossy().to_string(),
        metadata_json: metadata_json.to_string_lossy().to_string(),
        raw_wav: raw_wav.to_string_lossy().to_string(),
        processed_wav: processed_wav.to_string_lossy().to_string(),
        output_wav: output_wav.to_string_lossy().to_string(),
        gain_db,
        playback_filter: playback_filter.to_string(),
        sample_rate,
        channels,
        offset_ms,
        requested_capture_ms: capture_ms,
        actual_capture_ms,
        raw_stats,
        processed_stats,
        output_stats,
    })
}

fn run_ffmpeg_spectrogram_png(
    ffmpeg: &Path,
    input: &Path,
    filter_chain: &str,
) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin")
        .arg("-i")
        .arg(input)
        .arg("-lavfi")
        .arg(filter_chain)
        .arg("-frames:v")
        .arg("1")
        .arg("-f")
        .arg("image2pipe")
        .arg("-vcodec")
        .arg("png")
        .arg("pipe:1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg spectrogram failed: {err}"));
    }
    if output.stdout.is_empty() {
        return Err("ffmpeg spectrogram output is empty".to_string());
    }
    Ok(output.stdout)
}

fn resolve_ffprobe_path(ffmpeg: &Path) -> PathBuf {
    let exe = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
    if let Some(parent) = ffmpeg.parent() {
        let sibling = parent.join(exe);
        if sibling.exists() {
            return sibling;
        }
    }
    PathBuf::from(exe)
}

fn probe_duration_ms_with_ffprobe(ffmpeg: &Path, input: &Path) -> Option<u32> {
    let ffprobe = resolve_ffprobe_path(ffmpeg);
    let mut cmd = Command::new(ffprobe);
    cmd.arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("format=duration")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1")
        .arg(input)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let secs = text.trim().parse::<f64>().ok()?;
    if !secs.is_finite() || secs <= 0.0 {
        return None;
    }
    let millis = (secs * 1000.0).round();
    if !millis.is_finite() || millis <= 0.0 {
        return None;
    }
    Some((millis as u128).min(u32::MAX as u128) as u32)
}

fn saturating_millis_u32(duration: Duration) -> u32 {
    duration.as_millis().min(u32::MAX as u128) as u32
}

fn panic_payload_to_string(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "unknown panic payload".to_string()
}

fn catch_engine<T, F>(stage: &str, op: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    match panic::catch_unwind(AssertUnwindSafe(op)) {
        Ok(result) => result,
        Err(payload) => Err(format!(
            "audio engine panic during {stage}: {}",
            panic_payload_to_string(payload)
        )),
    }
}

fn open_decoder(path: &Path) -> Result<(Decoder<BufReader<File>>, Option<u32>), String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let decoder = Decoder::new(BufReader::new(file)).map_err(|e| e.to_string())?;
    let duration_ms = decoder.total_duration().map(saturating_millis_u32);
    Ok((decoder, duration_ms))
}

fn pick_preferred_output_config(device: &cpal::Device) -> Result<SupportedStreamConfig, String> {
    let default_config = device.default_output_config().map_err(|e| e.to_string())?;
    if default_config.sample_format() == SampleFormat::F32 {
        return Ok(default_config);
    }

    let default_rate = default_config.sample_rate();
    let default_channels = default_config.channels();
    let mut best_f32: Option<(i64, SupportedStreamConfig)> = None;

    for range in device.supported_output_configs().map_err(|e| e.to_string())? {
        if range.sample_format() != SampleFormat::F32 {
            continue;
        }

        let chosen_rate = default_rate.clamp(range.min_sample_rate(), range.max_sample_rate());
        let chosen = range.with_sample_rate(chosen_rate);
        let channel_penalty =
            (i32::from(chosen.channels()) - i32::from(default_channels)).abs() as i64 * 1_000_000;
        let rate_penalty = (i64::from(chosen_rate) - i64::from(default_rate)).abs();
        let score = channel_penalty + rate_penalty;

        match best_f32 {
            Some((best_score, _)) if score >= best_score => {}
            _ => best_f32 = Some((score, chosen)),
        }
    }

    Ok(best_f32.map(|(_, config)| config).unwrap_or(default_config))
}

fn try_backend_from_device(device: &cpal::Device) -> Result<AudioBackend, String> {
    let config = pick_preferred_output_config(device)?;
    let device_sink = DeviceSinkBuilder::from_device(device.clone())
        .map_err(|e| e.to_string())?
        .with_supported_config(&config)
        .open_stream()
        .map_err(|e| e.to_string())?;

    Ok(AudioBackend {
        device_sink,
        output_channels: config.channels(),
        output_sample_rate: config.sample_rate(),
    })
}

fn create_audio_backend() -> Result<AudioBackend, String> {
    let host = cpal::default_host();
    let default_device = host
        .default_output_device()
        .ok_or_else(|| "audio output device not found".to_string())?;

    let mut last_error = match try_backend_from_device(&default_device) {
        Ok(backend) => return Ok(backend),
        Err(err) => err,
    };

    for device in host.output_devices().map_err(|e| e.to_string())? {
        match try_backend_from_device(&device) {
            Ok(backend) => return Ok(backend),
            Err(err) => last_error = err,
        }
    }

    Err(last_error)
}

fn open_ffmpeg_stream_with_binary(
    ffmpeg: &Path,
    input: &Path,
    gain_db: f32,
    track_true_peak_dbtp: Option<f32>,
    output_channels: u16,
    output_sample_rate: u32,
) -> Result<(FfmpegPcmSource, Option<u32>), String> {
    let filter = build_playback_filter(gain_db, track_true_peak_dbtp);
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin")
        .arg("-i")
        .arg(input)
        .arg("-filter:a")
        .arg(filter)
        .arg("-vn")
        .arg("-sn")
        .arg("-dn")
        .arg("-ac")
        .arg(output_channels.to_string())
        .arg("-ar")
        .arg(output_sample_rate.to_string())
        .arg("-f")
        .arg("f32le")
        .arg("-c:a")
        .arg("pcm_f32le")
        .arg("pipe:1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg stdout pipe is missing".to_string())?;
    Ok((
        FfmpegPcmSource {
            child: Some(child),
            stdout: BufReader::new(stdout),
            channels: output_channels,
            sample_rate: output_sample_rate,
        },
        None,
    ))
}

fn run_engine_loop(event_sink: Arc<dyn AudioEventSink>, rx: mpsc::Receiver<EngineCmd>) {
    let backend = create_audio_backend();
    let mut state = PlayerState::new();

    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(cmd) => {
                let result = panic::catch_unwind(AssertUnwindSafe(|| {
                    handle_cmd(event_sink.as_ref(), &backend, &mut state, cmd);
                }));
                if let Err(payload) = result {
                    eprintln!(
                        "audio engine command loop panicked: {}",
                        panic_payload_to_string(payload)
                    );
                    state.clear();
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                let result = panic::catch_unwind(AssertUnwindSafe(|| {
                    emit_state_and_maybe_end(event_sink.as_ref(), &mut state);
                }));
                if let Err(payload) = result {
                    eprintln!(
                        "audio engine tick loop panicked: {}",
                        panic_payload_to_string(payload)
                    );
                    state.clear();
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn emit_state_and_maybe_end(event_sink: &dyn AudioEventSink, state: &mut PlayerState) {
    if state.path.is_none() {
        return;
    }

    let sink_empty = state.sink.as_ref().map(|sink| sink.empty()).unwrap_or(true);
    let status = state.to_status();
    event_sink.emit_state(&status);

    if sink_empty {
        if let (Some(session_id), Some(path)) = (state.session_id, state.path.clone()) {
            event_sink.emit_ended(&AudioEndedPayload { session_id, path });
        }
        state.clear();
    }
}

fn handle_cmd(
    event_sink: &dyn AudioEventSink,
    backend: &Result<AudioBackend, String>,
    state: &mut PlayerState,
    cmd: EngineCmd,
) {
    match cmd {
        EngineCmd::Play { req, respond } => {
            let failure_context = (req.session_id, req.path.clone());
            let result = catch_engine("play", || handle_play(backend, state, req));
            if let Err(error) = &result {
                emit_transport_failure(
                    event_sink,
                    Some((failure_context.0, failure_context.1.as_str())),
                    state,
                    "play",
                    error.clone(),
                );
            }
            let _ = respond.send(result);
            emit_state_and_maybe_end(event_sink, state);
        }
        EngineCmd::Pause { respond } => {
            let result = catch_engine("pause", || handle_pause(state));
            if let Err(error) = &result {
                emit_transport_failure(event_sink, None, state, "pause", error.clone());
            } else {
                emit_transport_paused(event_sink, state);
            }
            let _ = respond.send(result);
            emit_state_and_maybe_end(event_sink, state);
        }
        EngineCmd::Resume { respond } => {
            let result = catch_engine("resume", || handle_resume(state));
            if let Err(error) = &result {
                emit_transport_failure(event_sink, None, state, "resume", error.clone());
            } else {
                emit_transport_resumed(event_sink, state);
            }
            let _ = respond.send(result);
            emit_state_and_maybe_end(event_sink, state);
        }
        EngineCmd::Stop { respond } => {
            let stopped_identity = state.session_id.zip(state.path.clone());
            let result = catch_engine("stop", || {
                state.clear();
                Ok(())
            });
            if result.is_ok() {
                emit_transport_stopped(
                    event_sink,
                    stopped_identity
                        .as_ref()
                        .map(|(session_id, path)| (*session_id, path.as_str())),
                    state,
                );
            }
            let _ = respond.send(result);
        }
        EngineCmd::Status { respond } => {
            let _ = respond.send(catch_engine("status", || Ok(state.to_status())));
        }
    }
}

fn emit_transport_paused(event_sink: &dyn AudioEventSink, state: &PlayerState) {
    if let (true, Some(session_id), Some(path)) = (state.paused, state.session_id, state.path.clone())
    {
        event_sink.emit_paused(&AudioPausedPayload { session_id, path });
    }
}

fn emit_transport_resumed(event_sink: &dyn AudioEventSink, state: &PlayerState) {
    if let (false, Some(session_id), Some(path)) =
        (state.paused, state.session_id, state.path.clone())
    {
        event_sink.emit_resumed(&AudioResumedPayload { session_id, path });
    }
}

fn emit_transport_stopped(
    event_sink: &dyn AudioEventSink,
    explicit: Option<(u64, &str)>,
    state: &PlayerState,
) {
    let explicit = explicit.map(|(session_id, path)| (session_id, path.to_string()));
    if let Some((session_id, path)) = explicit.or_else(|| state.session_id.zip(state.path.clone()))
    {
        event_sink.emit_stopped(&AudioStoppedPayload { session_id, path });
    }
}

fn emit_transport_failure(
    event_sink: &dyn AudioEventSink,
    explicit: Option<(u64, &str)>,
    state: &PlayerState,
    action: &str,
    error: String,
) {
    let explicit = explicit.map(|(session_id, path)| (session_id, path.to_string()));
    if let Some((session_id, path)) = explicit.or_else(|| state.session_id.zip(state.path.clone()))
    {
        event_sink.emit_failed(&AudioFailedPayload {
            session_id,
            path,
            action: action.to_string(),
            error,
        });
    }
}

fn handle_play(
    backend: &Result<AudioBackend, String>,
    state: &mut PlayerState,
    req: ResolvedAudioPlayRequest,
) -> Result<AudioPlayAck, String> {
    let backend = backend.as_ref().map_err(|e| e.clone())?;
    let path = Path::new(&req.path);
    if !path.exists() {
        return Err(format!("audio file not found: {}", req.path));
    }

    let (source, duration_ms) = catch_engine("ffmpeg-stream-open", || {
        open_ffmpeg_stream_with_binary(
            &req.ffmpeg_path,
            path,
            req.gain_db,
            req.track_true_peak_dbtp,
            backend.output_channels,
            backend.output_sample_rate,
        )
    })?;

    let sink = Player::connect_new(backend.device_sink.mixer());
    sink.append(source);
    sink.play();

    state.clear();
    state.session_id = Some(req.session_id);
    state.path = Some(req.path.clone());
    state.started_at = Some(Instant::now());
    state.paused_started_at = None;
    state.paused_total = Duration::from_millis(0);
    state.duration_ms = duration_ms;
    state.paused = false;
    state.sink = Some(sink);

    Ok(AudioPlayAck {
        session_id: req.session_id,
        path: req.path,
        duration_ms,
        gain: db_to_linear(req.gain_db),
        gain_db: req.gain_db,
        target_lufs: req.target_lufs,
        integrated_lufs: req.integrated_lufs,
        has_canonical_loudness: req.has_canonical_loudness,
    })
}

fn handle_pause(state: &mut PlayerState) -> Result<(), String> {
    let Some(sink) = state.sink.as_ref() else {
        return Ok(());
    };
    if !state.paused {
        sink.pause();
        state.paused = true;
        state.paused_started_at = Some(Instant::now());
    }
    Ok(())
}

fn handle_resume(state: &mut PlayerState) -> Result<(), String> {
    let Some(sink) = state.sink.as_ref() else {
        return Ok(());
    };
    if state.paused {
        sink.play();
        state.resume_at(Instant::now());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_probe_stats, build_playback_filter, compute_gain_db, ensure_audio_file_exists,
        ensure_debug_mode_available, merge_normalization, sanitize_pcm_sample,
        PlaybackNormalization, PlaybackRequest, DEFAULT_TARGET_LUFS,
    };

    #[test]
    fn compute_gain_should_not_boost_without_true_peak() {
        assert_eq!(compute_gain_db(Some(-16.0), Some(-24.0), None), 0.0);
    }

    #[test]
    fn compute_gain_should_keep_safety_floor_when_canonical_loudness_is_missing() {
        let gain_db = compute_gain_db(Some(-16.0), None, None);
        assert_eq!(gain_db, 0.0);
        assert!(build_playback_filter(gain_db, None).contains("alimiter="));
    }

    #[test]
    fn debug_mode_guard_returns_explicit_command_error() {
        if cfg!(debug_assertions) {
            assert_eq!(
                ensure_debug_mode_available("audio_debug_pipeline_probe"),
                Ok(())
            );
        }
    }

    #[test]
    fn missing_audio_file_returns_explicit_error() {
        let err = ensure_audio_file_exists("C:/missing/file.flac").unwrap_err();
        assert!(err.starts_with("audio file not found: "));
    }

    #[test]
    fn sanitize_pcm_sample_should_clamp_and_zero_non_finite() {
        assert_eq!(sanitize_pcm_sample(1.4), 1.0);
        assert_eq!(sanitize_pcm_sample(-1.2), -1.0);
        assert_eq!(sanitize_pcm_sample(f32::NAN), 0.0);
    }

    #[test]
    fn analyze_probe_stats_should_report_over_unity_and_non_finite() {
        let stats = analyze_probe_stats(&[0.0, 0.5, 1.2, -1.5, f32::NAN, f32::INFINITY]);
        assert_eq!(stats.sample_count, 6);
        assert_eq!(stats.finite_sample_count, 4);
        assert_eq!(stats.non_finite_count, 2);
        assert_eq!(stats.over_unity_count, 2);
    }

    #[test]
    fn playback_request_defaults_to_engine_normalization_and_generated_session() {
        let request = PlaybackRequest::new("track.mp3");
        assert_eq!(request.path, std::path::PathBuf::from("track.mp3"));
        assert_eq!(request.session_id, None);
        assert_eq!(request.normalization, None);
    }

    #[test]
    fn merge_normalization_prefers_request_overrides_and_preserves_base_metadata() {
        let merged = merge_normalization(
            PlaybackNormalization {
                target_lufs: -17.0,
                integrated_lufs: Some(-20.0),
                true_peak_dbtp: Some(-1.0),
            },
            PlaybackNormalization {
                target_lufs: DEFAULT_TARGET_LUFS,
                integrated_lufs: None,
                true_peak_dbtp: Some(-0.5),
            },
        );

        assert_eq!(merged.target_lufs, DEFAULT_TARGET_LUFS);
        assert_eq!(merged.integrated_lufs, Some(-20.0));
        assert_eq!(merged.true_peak_dbtp, Some(-0.5));
    }
}
