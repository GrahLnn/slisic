use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use rodio::cpal;
use rodio::cpal::traits::{DeviceTrait as _, HostTrait as _};
use rodio::cpal::{SampleFormat, SupportedStreamConfig};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::any::Any;
use std::fs::{self, File};
use std::io::{BufReader, ErrorKind, Read, Write};
use std::num::NonZero;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::sync::oneshot;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Event)]
pub struct AudioState {
    pub path: Option<String>,
    pub playing: bool,
    pub paused: bool,
    pub position_ms: u32,
    pub duration_ms: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq, Event)]
pub struct AudioEnded {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioPlayRequest {
    pub path: String,
    pub target_lufs: Option<f32>,
    pub track_lufs: Option<f32>,
    pub track_true_peak_dbtp: Option<f32>,
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
    pub path: String,
    pub duration_ms: Option<u32>,
    pub gain: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioStatus {
    pub path: Option<String>,
    pub playing: bool,
    pub paused: bool,
    pub position_ms: u32,
    pub duration_ms: Option<u32>,
}

struct PlayerState {
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
            Ok(()) => {
                let sample = f32::from_le_bytes(bytes);
                Some(sanitize_pcm_sample(sample))
            }
            Err(error) => {
                if !matches!(
                    error.kind(),
                    ErrorKind::UnexpectedEof | ErrorKind::BrokenPipe
                ) {
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
        req: AudioPlayRequest,
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

static ENGINE_TX: OnceLock<Mutex<Option<Sender<EngineCmd>>>> = OnceLock::new();

fn engine_slot() -> &'static Mutex<Option<Sender<EngineCmd>>> {
    ENGINE_TX.get_or_init(|| Mutex::new(None))
}

const DEFAULT_TARGET_LUFS: f32 = -16.0;
const MAX_GAIN_DB: f32 = 3.0;
const MIN_GAIN_DB: f32 = -18.0;
const OUTPUT_TRUE_PEAK_CEIL_DBTP: f32 = -2.0;
const LIMITER_LINEAR_CEIL: f32 = 0.794_328; // -2.0 dBFS
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

    // Safety-first: without true-peak metadata we never apply positive gain.
    if track_true_peak_dbtp.is_none() && gain_db > 0.0 {
        gain_db = 0.0;
    }

    gain_db.clamp(MIN_GAIN_DB, MAX_GAIN_DB)
}

fn compute_gain_linear(
    target_lufs: Option<f32>,
    track_lufs: Option<f32>,
    track_true_peak_dbtp: Option<f32>,
) -> f32 {
    db_to_linear(compute_gain_db(
        target_lufs,
        track_lufs,
        track_true_peak_dbtp,
    ))
}

fn should_apply_limiter(gain_db: f32, track_true_peak_dbtp: Option<f32>) -> bool {
    let Some(tp) = track_true_peak_dbtp else {
        // Without TP metadata we keep limiter for safety.
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
        .map_err(|e| e.to_string())?; // IEEE float
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
    let exe = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
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
    let millis_u128 = millis as u128;
    Some(millis_u128.min(u32::MAX as u128) as u32)
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

#[allow(dead_code)]
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

    let ranges = device
        .supported_output_configs()
        .map_err(|e| e.to_string())?;
    for range in ranges {
        if range.sample_format() != SampleFormat::F32 {
            continue;
        }

        let min_rate = range.min_sample_rate();
        let max_rate = range.max_sample_rate();
        let chosen_rate = default_rate.clamp(min_rate, max_rate);
        let chosen = range.with_sample_rate(chosen_rate);
        let channel_penalty =
            (i32::from(chosen.channels()) - i32::from(default_channels)).abs() as i64 * 1_000_000;
        let rate_penalty = (i64::from(chosen_rate) - i64::from(default_rate)).abs();
        let score = channel_penalty + rate_penalty;

        match best_f32 {
            Some((best_score, _)) if score >= best_score => {}
            _ => {
                best_f32 = Some((score, chosen));
            }
        }
    }

    if let Some((_, config)) = best_f32 {
        Ok(config)
    } else {
        Ok(default_config)
    }
}

fn try_backend_from_device(device: &cpal::Device) -> Result<AudioBackend, String> {
    let config = pick_preferred_output_config(device)?;
    let output_channels = config.channels();
    let output_sample_rate = config.sample_rate();
    let sample_format = config.sample_format();
    let device_name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "<unknown-device>".to_string());

    let device_sink = DeviceSinkBuilder::from_device(device.clone())
        .map_err(|e| e.to_string())?
        .with_supported_config(&config)
        .open_stream()
        .map_err(|e| e.to_string())?;
    eprintln!(
        "audio backend initialized: device={device_name}, channels={output_channels}, sample_rate={output_sample_rate}, format={sample_format:?}"
    );

    Ok(AudioBackend {
        device_sink,
        output_channels,
        output_sample_rate,
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

    let devices = host.output_devices().map_err(|e| e.to_string())?;
    for device in devices {
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
    let source = FfmpegPcmSource {
        child: Some(child),
        stdout: BufReader::new(stdout),
        channels: output_channels,
        sample_rate: output_sample_rate,
    };

    Ok((source, None))
}

fn open_ffmpeg_stream(
    app: &AppHandle,
    input: &Path,
    gain_db: f32,
    track_true_peak_dbtp: Option<f32>,
    output_channels: u16,
    output_sample_rate: u32,
) -> Result<(FfmpegPcmSource, Option<u32>), String> {
    let ffmpeg = crate::utils::ffmpeg::ensure_ffmpeg(app)?;
    open_ffmpeg_stream_with_binary(
        &ffmpeg,
        input,
        gain_db,
        track_true_peak_dbtp,
        output_channels,
        output_sample_rate,
    )
}

fn spawn_engine(app: AppHandle) -> Result<Sender<EngineCmd>, String> {
    let (tx, rx) = mpsc::channel::<EngineCmd>();
    std::thread::Builder::new()
        .name("ransic-audio-engine".to_string())
        .spawn(move || run_engine_loop(app, rx))
        .map_err(|e| e.to_string())?;

    Ok(tx)
}

fn ensure_engine(app: &AppHandle) -> Result<Sender<EngineCmd>, String> {
    let slot = engine_slot();
    let mut guard = slot
        .lock()
        .map_err(|_| "audio engine lock poisoned".to_string())?;

    if let Some(tx) = guard.as_ref() {
        return Ok(tx.clone());
    }

    let tx = spawn_engine(app.clone())?;
    *guard = Some(tx.clone());
    Ok(tx)
}

fn reset_engine_sender() {
    if let Ok(mut guard) = engine_slot().lock() {
        *guard = None;
    }
}

fn run_engine_loop(app: AppHandle, rx: mpsc::Receiver<EngineCmd>) {
    let backend = create_audio_backend();

    let mut state = PlayerState::new();

    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(cmd) => {
                let result = panic::catch_unwind(AssertUnwindSafe(|| {
                    handle_cmd(&app, &backend, &mut state, cmd);
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
                    emit_state_and_maybe_end(&app, &mut state);
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

fn emit_state_and_maybe_end(app: &AppHandle, state: &mut PlayerState) {
    if state.path.is_none() {
        return;
    }

    let sink_empty = state.sink.as_ref().map(|sink| sink.empty()).unwrap_or(true);

    let status = state.to_status();
    AudioState {
        path: status.path.clone(),
        playing: status.playing,
        paused: status.paused,
        position_ms: status.position_ms,
        duration_ms: status.duration_ms,
    }
    .emit(app)
    .ok();

    if sink_empty {
        if let Some(path) = state.path.clone() {
            AudioEnded { path }.emit(app).ok();
        }
        state.clear();
    }
}

fn handle_cmd(
    app: &AppHandle,
    backend: &Result<AudioBackend, String>,
    state: &mut PlayerState,
    cmd: EngineCmd,
) {
    match cmd {
        EngineCmd::Play { req, respond } => {
            let result = catch_engine("play", || handle_play(app, backend, state, req));
            let _ = respond.send(result);
            emit_state_and_maybe_end(app, state);
        }
        EngineCmd::Pause { respond } => {
            let result = catch_engine("pause", || handle_pause(state));
            let _ = respond.send(result);
            emit_state_and_maybe_end(app, state);
        }
        EngineCmd::Resume { respond } => {
            let result = catch_engine("resume", || handle_resume(state));
            let _ = respond.send(result);
            emit_state_and_maybe_end(app, state);
        }
        EngineCmd::Stop { respond } => {
            let result = catch_engine("stop", || {
                state.clear();
                Ok(())
            });
            let _ = respond.send(result);
        }
        EngineCmd::Status { respond } => {
            let result = catch_engine("status", || Ok(state.to_status()));
            let _ = respond.send(result);
        }
    }
}

fn handle_play(
    app: &AppHandle,
    backend: &Result<AudioBackend, String>,
    state: &mut PlayerState,
    req: AudioPlayRequest,
) -> Result<AudioPlayAck, String> {
    let backend = backend.as_ref().map_err(|e| e.clone())?;
    let path = Path::new(&req.path);
    if !path.exists() {
        return Err(format!("audio file not found: {}", req.path));
    }

    let gain_db = compute_gain_db(req.target_lufs, req.track_lufs, req.track_true_peak_dbtp);
    let (source, duration_ms) = catch_engine("ffmpeg-stream-open", || {
        open_ffmpeg_stream(
            app,
            path,
            gain_db,
            req.track_true_peak_dbtp,
            backend.output_channels,
            backend.output_sample_rate,
        )
    })?;
    let gain = compute_gain_linear(req.target_lufs, req.track_lufs, req.track_true_peak_dbtp);

    let sink = Player::connect_new(backend.device_sink.mixer());
    sink.append(source);
    sink.play();

    state.clear();
    state.path = Some(req.path.clone());
    state.started_at = Some(Instant::now());
    state.paused_started_at = None;
    state.paused_total = Duration::from_millis(0);
    state.duration_ms = duration_ms;
    state.paused = false;
    state.sink = Some(sink);

    Ok(AudioPlayAck {
        path: req.path,
        duration_ms,
        gain,
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

async fn send_cmd<T, F>(app: AppHandle, make_cmd: F) -> Result<T, String>
where
    F: Fn(oneshot::Sender<Result<T, String>>) -> EngineCmd,
{
    let mut last_error = "audio engine unavailable".to_string();

    for _ in 0..2 {
        let tx = ensure_engine(&app)?;
        let (respond, rx) = oneshot::channel();
        let cmd = make_cmd(respond);

        if tx.send(cmd).is_err() {
            reset_engine_sender();
            last_error = "audio engine thread stopped".to_string();
            continue;
        }

        match rx.await {
            Ok(result) => return result,
            Err(_) => {
                reset_engine_sender();
                last_error = "audio engine response dropped".to_string();
            }
        }
    }

    Err(last_error)
}

#[tauri::command]
#[specta::specta]
pub async fn audio_play(app: AppHandle, req: AudioPlayRequest) -> Result<AudioPlayAck, String> {
    send_cmd(app, |respond| EngineCmd::Play {
        req: req.clone(),
        respond,
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn audio_pause(app: AppHandle) -> Result<(), String> {
    send_cmd(app, |respond| EngineCmd::Pause { respond }).await
}

#[tauri::command]
#[specta::specta]
pub async fn audio_resume(app: AppHandle) -> Result<(), String> {
    send_cmd(app, |respond| EngineCmd::Resume { respond }).await
}

#[tauri::command]
#[specta::specta]
pub async fn audio_stop(app: AppHandle) -> Result<(), String> {
    send_cmd(app, |respond| EngineCmd::Stop { respond }).await
}

#[tauri::command]
#[specta::specta]
pub async fn audio_status(app: AppHandle) -> Result<AudioStatus, String> {
    send_cmd(app, |respond| EngineCmd::Status { respond }).await
}

#[tauri::command]
#[specta::specta]
pub async fn audio_debug_spectrogram(
    app: AppHandle,
    req: AudioDebugSpectrogramRequest,
) -> Result<AudioDebugSpectrogram, String> {
    if !cfg!(debug_assertions) {
        return Err("audio_debug_spectrogram is available in debug mode only".to_string());
    }

    let input = Path::new(&req.path);
    if !input.exists() {
        return Err(format!("audio file not found: {}", req.path));
    }

    let width = clamp_spectrogram_size(req.width, 1400, 640, 4096);
    let height = clamp_spectrogram_size(req.height, 260, 120, 1024);
    let gain_db = compute_gain_db(req.target_lufs, req.track_lufs, req.track_true_peak_dbtp);
    let playback_filter = build_playback_filter(gain_db, req.track_true_peak_dbtp);
    let ffmpeg = crate::utils::ffmpeg::ensure_ffmpeg(&app)?;
    let mut duration_ms = open_decoder(input).ok().and_then(|(_, duration)| duration);
    if duration_ms.is_none() {
        duration_ms = probe_duration_ms_with_ffprobe(&ffmpeg, input);
    }
    let ffmpeg_raw = ffmpeg.clone();
    let ffmpeg_processed = ffmpeg;
    let raw_path = input.to_path_buf();
    let processed_path = input.to_path_buf();
    let raw_filter = spectrogram_filter_chain(None, width, height);
    let processed_filter = spectrogram_filter_chain(Some(&playback_filter), width, height);

    let raw_png = tokio::task::spawn_blocking(move || {
        run_ffmpeg_spectrogram_png(&ffmpeg_raw, raw_path.as_path(), &raw_filter)
    })
    .await
    .map_err(|e| e.to_string())??;

    let processed_png = tokio::task::spawn_blocking(move || {
        run_ffmpeg_spectrogram_png(
            &ffmpeg_processed,
            processed_path.as_path(),
            &processed_filter,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let raw_data_url = format!("data:image/png;base64,{}", BASE64_STANDARD.encode(raw_png));
    let processed_data_url = format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(processed_png)
    );

    Ok(AudioDebugSpectrogram {
        raw_data_url,
        processed_data_url,
        gain_db,
        playback_filter,
        width,
        height,
        duration_ms,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn audio_debug_pipeline_probe(
    app: AppHandle,
    req: AudioDebugProbeRequest,
) -> Result<AudioDebugProbeResult, String> {
    if !cfg!(debug_assertions) {
        return Err("audio_debug_pipeline_probe is available in debug mode only".to_string());
    }

    let input = Path::new(&req.path);
    if !input.exists() {
        return Err(format!("audio file not found: {}", req.path));
    }

    let offset_ms = req.offset_ms.unwrap_or(0);
    let capture_ms = clamp_debug_probe_capture_ms(req.capture_ms);
    let sample_rate = clamp_debug_probe_sample_rate(req.sample_rate);
    let channels = clamp_debug_probe_channels(req.channels);

    let gain_db = compute_gain_db(req.target_lufs, req.track_lufs, req.track_true_peak_dbtp);
    let playback_filter = build_playback_filter(gain_db, req.track_true_peak_dbtp);
    let ffmpeg = crate::utils::ffmpeg::ensure_ffmpeg(&app)?;
    let mut output_root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    output_root.push("debug");
    output_root.push("audio-probe");

    let input_for_block = input.to_path_buf();
    let filter_for_block = playback_filter.clone();
    let output_root_for_block = output_root;
    tokio::task::spawn_blocking(move || {
        run_audio_debug_probe_with_binary(
            ffmpeg.as_path(),
            output_root_for_block.as_path(),
            input_for_block.as_path(),
            gain_db,
            &filter_for_block,
            sample_rate,
            channels,
            offset_ms,
            capture_ms,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_probe_stats, build_playback_filter, compute_gain_db, compute_gain_linear,
        run_audio_debug_probe_with_binary, sanitize_pcm_sample, PlayerState,
    };
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    #[test]
    fn compute_gain_should_boost_when_track_is_quiet() {
        let gain = compute_gain_linear(Some(-16.0), Some(-20.0), Some(-6.0));
        assert!(gain > 1.0);
        assert!(gain <= 1.42);
    }

    #[test]
    fn compute_gain_should_not_boost_without_true_peak() {
        let gain_db = compute_gain_db(Some(-16.0), Some(-24.0), None);
        assert_eq!(gain_db, 0.0);
    }

    #[test]
    fn compute_gain_should_not_exceed_limit() {
        let gain = compute_gain_linear(Some(-10.0), Some(-40.0), Some(-6.0));
        assert!((gain - 1.4125376).abs() < 0.01);
    }

    #[test]
    fn compute_gain_should_not_drop_below_floor() {
        let gain = compute_gain_linear(Some(-16.0), Some(30.0), None);
        assert!((gain - 0.1258925).abs() < 0.0001);
    }

    #[test]
    fn compute_gain_should_not_hard_cap_by_true_peak() {
        // Peak control is delegated to limiter; gain should follow loudness target.
        let gain_db = compute_gain_db(Some(-16.0), Some(-24.0), Some(-0.2));
        assert!((gain_db - 3.0).abs() < 0.0001);
    }

    #[test]
    fn compute_gain_should_add_hot_master_guard() {
        let gain_db = compute_gain_db(Some(-16.0), Some(-11.9), None);
        // base gain is -4.1 dB; hot-master guard should add extra attenuation.
        assert!((gain_db - (-4.835)).abs() < 0.001);
    }

    #[test]
    fn build_filter_should_skip_limiter_when_peak_has_headroom() {
        let filter = build_playback_filter(-2.715, Some(0.3));
        assert_eq!(filter, "volume=-2.715dB");
    }

    #[test]
    fn build_filter_should_keep_limiter_when_near_ceiling() {
        let filter = build_playback_filter(-1.9, Some(0.3));
        assert!(filter.contains("alimiter="));
    }

    #[test]
    fn sanitize_pcm_sample_should_clamp_and_zero_non_finite() {
        assert_eq!(sanitize_pcm_sample(1.4), 1.0);
        assert_eq!(sanitize_pcm_sample(-1.2), -1.0);
        assert_eq!(sanitize_pcm_sample(0.25), 0.25);
        assert_eq!(sanitize_pcm_sample(f32::NAN), 0.0);
        assert_eq!(sanitize_pcm_sample(f32::INFINITY), 0.0);
        assert_eq!(sanitize_pcm_sample(f32::NEG_INFINITY), 0.0);
    }

    #[test]
    fn analyze_probe_stats_should_report_over_unity_and_non_finite() {
        let stats = analyze_probe_stats(&[0.0, 0.5, 1.2, -1.5, f32::NAN, f32::INFINITY]);
        assert_eq!(stats.sample_count, 6);
        assert_eq!(stats.finite_sample_count, 4);
        assert_eq!(stats.non_finite_count, 2);
        assert_eq!(stats.over_unity_count, 2);
        assert!((stats.over_unity_ratio - 0.5).abs() < 0.0001);
        assert!(stats.peak_dbfs > 0.0);
    }

    #[test]
    #[ignore]
    fn debug_probe_should_dump_artifacts_for_real_track() {
        let Some(ffmpeg) = find_ffmpeg_binary() else {
            return;
        };

        let track = std::env::var("RANSIC_PROBE_TRACK").unwrap_or_else(|_| {
            "C:\\Users\\admin\\Documents\\ransic\\Uploads from kensuke ushio - Topic\\resetless heart.webm".to_string()
        });
        let path = PathBuf::from(track);
        if !path.exists() {
            return;
        }

        let target_lufs = std::env::var("RANSIC_PROBE_TARGET_LUFS")
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
            .unwrap_or(-15.5);
        let track_lufs = std::env::var("RANSIC_PROBE_TRACK_LUFS")
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
            .unwrap_or(-13.1);
        let track_true_peak = std::env::var("RANSIC_PROBE_TRACK_TP")
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
            .unwrap_or(0.3);

        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let out_root = std::env::temp_dir().join(format!("ransic-probe-run-{ts}"));
        fs::create_dir_all(&out_root).expect("create output root");

        let gain_db = compute_gain_db(Some(target_lufs), Some(track_lufs), Some(track_true_peak));
        let playback_filter = build_playback_filter(gain_db, Some(track_true_peak));

        let result = run_audio_debug_probe_with_binary(
            ffmpeg.as_path(),
            out_root.as_path(),
            path.as_path(),
            gain_db,
            &playback_filter,
            48_000,
            2,
            0,
            12_000,
        )
        .expect("run probe");

        println!("probe_output_dir={}", result.output_dir);
        println!("probe_metadata={}", result.metadata_json);
        println!("probe_raw_wav={}", result.raw_wav);
        println!("probe_processed_wav={}", result.processed_wav);
        println!("probe_output_wav={}", result.output_wav);

        assert!(Path::new(&result.metadata_json).exists());
        assert!(Path::new(&result.raw_wav).exists());
        assert!(Path::new(&result.processed_wav).exists());
        assert!(Path::new(&result.output_wav).exists());
    }

    #[test]
    fn position_should_freeze_while_paused() {
        let now = Instant::now();
        let mut state = PlayerState::new();
        state.started_at = Some(now - Duration::from_secs(10));
        state.paused_total = Duration::from_secs(2);
        state.paused = true;
        state.paused_started_at = Some(now - Duration::from_secs(3));

        let at_pause = state.position_ms_at(now);
        let later = state.position_ms_at(now + Duration::from_secs(4));

        assert_eq!(at_pause, 5000);
        assert_eq!(later, 5000);
    }

    #[test]
    fn resume_should_accumulate_paused_duration() {
        let now = Instant::now();
        let mut state = PlayerState::new();
        state.paused = true;
        state.paused_total = Duration::from_secs(1);
        state.paused_started_at = Some(now - Duration::from_secs(2));

        state.resume_at(now);

        assert!(!state.paused);
        assert_eq!(state.paused_started_at, None);
        assert_eq!(state.paused_total, Duration::from_secs(3));
    }

    #[test]
    fn clear_should_reset_runtime_state() {
        let now = Instant::now();
        let mut state = PlayerState::new();
        state.path = Some("x.mp3".to_string());
        state.started_at = Some(now - Duration::from_secs(1));
        state.paused_started_at = Some(now);
        state.paused_total = Duration::from_millis(123);
        state.duration_ms = Some(999);
        state.paused = true;

        state.clear();

        assert_eq!(state.path, None);
        assert_eq!(state.started_at, None);
        assert_eq!(state.paused_started_at, None);
        assert_eq!(state.paused_total, Duration::from_millis(0));
        assert_eq!(state.duration_ms, None);
        assert!(!state.paused);
    }

    #[test]
    fn open_decoder_should_handle_large_wav_file() {
        let path = temp_wav_path("large-audio");
        write_silence_wav(&path, 48_000, 2, 16, 120).expect("create test wav");

        let meta = std::fs::metadata(&path).expect("metadata");
        assert!(meta.len() > 20 * 1024 * 1024);

        let (_decoder, duration_ms) = super::open_decoder(path.as_path()).expect("decode wav");
        assert!(duration_ms.unwrap_or(0) >= 119_000);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn ffmpeg_stream_repeated_open_drop_should_not_accumulate_processes() {
        let Some(ffmpeg) = find_ffmpeg_binary() else {
            return;
        };

        let path = temp_wav_path("stream-soak");
        write_silence_wav(&path, 48_000, 2, 16, 20).expect("create soak wav");

        let baseline = ffmpeg_process_count();

        for _ in 0..24 {
            let (mut source, _duration) = super::open_ffmpeg_stream_with_binary(
                &ffmpeg,
                path.as_path(),
                0.0,
                None,
                2,
                48_000,
            )
            .expect("open ffmpeg stream");

            // Read a bit to ensure ffmpeg is actively decoding before drop.
            let read = source.by_ref().take(4096).count();
            assert!(read > 0);
            drop(source);
        }

        let settled = wait_until_ffmpeg_count_at_most(baseline + 1, Duration::from_secs(5));
        assert!(
            settled,
            "ffmpeg process count did not return near baseline: baseline={baseline}, now={}",
            ffmpeg_process_count()
        );

        let _ = std::fs::remove_file(path);
    }

    fn find_ffmpeg_binary() -> Option<PathBuf> {
        let exe = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };

        let path_var = std::env::var_os("PATH")?;
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(exe);
            if candidate.exists() {
                return Some(candidate);
            }
        }
        None
    }

    fn wait_until_ffmpeg_count_at_most(target: usize, timeout: Duration) -> bool {
        let started = Instant::now();
        loop {
            if ffmpeg_process_count() <= target {
                return true;
            }
            if Instant::now().saturating_duration_since(started) >= timeout {
                return false;
            }
            sleep(Duration::from_millis(100));
        }
    }

    fn ffmpeg_process_count() -> usize {
        #[cfg(windows)]
        {
            let output = Command::new("tasklist")
                .args(["/FI", "IMAGENAME eq ffmpeg.exe", "/FO", "CSV", "/NH"])
                .output();

            let Ok(output) = output else {
                return 0;
            };

            if !output.status.success() {
                return 0;
            }

            let stdout = String::from_utf8_lossy(&output.stdout);
            return stdout
                .lines()
                .filter(|line| {
                    let trimmed = line.trim();
                    !trimmed.is_empty()
                        && !trimmed.starts_with("INFO:")
                        && trimmed.to_ascii_lowercase().contains("\"ffmpeg.exe\"")
                })
                .count();
        }

        #[cfg(not(windows))]
        {
            let output = Command::new("sh")
                .arg("-lc")
                .arg("ps -A -o comm= | grep -E '^ffmpeg$' | wc -l")
                .output();

            let Ok(output) = output else {
                return 0;
            };

            let raw = String::from_utf8_lossy(&output.stdout);
            return raw.trim().parse::<usize>().unwrap_or(0);
        }
    }

    fn temp_wav_path(tag: &str) -> PathBuf {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("ransic-{tag}-{ts}.wav"))
    }

    fn write_silence_wav(
        path: &Path,
        sample_rate: u32,
        channels: u16,
        bits_per_sample: u16,
        duration_secs: u32,
    ) -> Result<(), std::io::Error> {
        let mut file = File::create(path)?;

        let bytes_per_sample = (bits_per_sample / 8) as u32;
        let data_size = sample_rate
            .saturating_mul(duration_secs)
            .saturating_mul(channels as u32)
            .saturating_mul(bytes_per_sample);
        let riff_chunk_size = 36u32.saturating_add(data_size);
        let byte_rate = sample_rate
            .saturating_mul(channels as u32)
            .saturating_mul(bytes_per_sample);
        let block_align = channels.saturating_mul(bits_per_sample / 8);

        file.write_all(b"RIFF")?;
        file.write_all(&riff_chunk_size.to_le_bytes())?;
        file.write_all(b"WAVE")?;
        file.write_all(b"fmt ")?;
        file.write_all(&16u32.to_le_bytes())?;
        file.write_all(&1u16.to_le_bytes())?;
        file.write_all(&channels.to_le_bytes())?;
        file.write_all(&sample_rate.to_le_bytes())?;
        file.write_all(&byte_rate.to_le_bytes())?;
        file.write_all(&block_align.to_le_bytes())?;
        file.write_all(&bits_per_sample.to_le_bytes())?;
        file.write_all(b"data")?;
        file.write_all(&data_size.to_le_bytes())?;

        let chunk = vec![0u8; 16 * 1024];
        let mut remaining = data_size as usize;
        while remaining > 0 {
            let to_write = remaining.min(chunk.len());
            file.write_all(&chunk[..to_write])?;
            remaining -= to_write;
        }

        file.flush()?;
        Ok(())
    }
}
