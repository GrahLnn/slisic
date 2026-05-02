use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const WAVEFORM_SAMPLE_RATE: u32 = 48_000;
const WAVEFORM_BASE_POINTS_PER_SECOND: u32 = 800;
const WAVEFORM_SAMPLES_PER_POINT: u32 = WAVEFORM_SAMPLE_RATE / WAVEFORM_BASE_POINTS_PER_SECOND;
const WAVEFORM_CACHE_VERSION: &str = "waveform-v5";
const WAVEFORM_CHUNK_DURATION_MS: u32 = 60_000;
const WAVEFORM_CACHE_LEVELS: [u32; 5] = [50, 100, 200, 400, 800];
const WAVEFORM_POINT_INDEX_EPSILON: f64 = 1.0e-9;
const WAVEFORM_RESAMPLE_FILTER_SIZE: u32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub struct WaveformPeak {
    pub min: f32,
    pub max: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TrackWaveform {
    pub sample_rate: u32,
    pub samples_per_point: u32,
    pub points_per_second: u32,
    pub start_ms: u32,
    pub duration_ms: u32,
    pub peaks: Vec<WaveformPeak>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TrackWaveformSummary {
    pub cache_key: String,
    pub sample_rate: u32,
    pub samples_per_point: u32,
    pub base_points_per_second: u32,
    pub chunk_duration_ms: u32,
    pub start_ms: u32,
    pub duration_ms: u32,
    pub levels: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TrackWaveformTile {
    pub start_px: u32,
    pub width_px: u32,
    pub points_per_second: u32,
    pub min: Vec<i8>,
    pub max: Vec<i8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WaveformDecodeRange {
    pub start_ms: u32,
    pub duration_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct WaveformCacheManifest {
    version: String,
    sample_rate: u32,
    samples_per_point: u32,
    base_points_per_second: u32,
    chunk_duration_ms: u32,
    start_ms: u32,
    duration_ms: u32,
    levels: Vec<WaveformLevelManifest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct WaveformLevelManifest {
    points_per_second: u32,
    points_per_chunk: u32,
    point_count: u64,
    chunk_count: u32,
}

pub fn resolve_waveform_decode_range(
    start_seconds: Option<u32>,
    end_seconds: Option<u32>,
) -> WaveformDecodeRange {
    let start_seconds = start_seconds.unwrap_or(0);
    let duration_ms = end_seconds
        .and_then(|end| end.checked_sub(start_seconds))
        .filter(|duration| *duration > 0)
        .map(seconds_to_millis);

    WaveformDecodeRange {
        start_ms: seconds_to_millis(start_seconds),
        duration_ms,
    }
}

pub fn build_waveform_ffmpeg_args(input: &Path, range: WaveformDecodeRange) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-threads"),
        OsString::from("0"),
    ];

    if range.start_ms > 0 {
        args.push(OsString::from("-ss"));
        args.push(OsString::from(format_millis_as_seconds(range.start_ms)));
    }

    args.push(OsString::from("-i"));
    args.push(input.as_os_str().to_owned());

    if let Some(duration_ms) = range.duration_ms {
        args.push(OsString::from("-t"));
        args.push(OsString::from(format_millis_as_seconds(duration_ms)));
    }

    args.extend([
        OsString::from("-vn"),
        OsString::from("-sn"),
        OsString::from("-dn"),
        OsString::from("-ac"),
        OsString::from("1"),
        OsString::from("-ar"),
        OsString::from(WAVEFORM_SAMPLE_RATE.to_string()),
        OsString::from("-filter:a"),
        OsString::from(format!(
            "aresample={}:filter_size={}:phase_shift=0:linear_interp=1",
            WAVEFORM_SAMPLE_RATE, WAVEFORM_RESAMPLE_FILTER_SIZE
        )),
        OsString::from("-f"),
        OsString::from("f32le"),
        OsString::from("-c:a"),
        OsString::from("pcm_f32le"),
        OsString::from("pipe:1"),
    ]);

    args
}

pub fn prepare_track_waveform_cache(
    ffmpeg: &Path,
    cache_root: &Path,
    file_path: impl Into<PathBuf>,
    start_seconds: Option<u32>,
    end_seconds: Option<u32>,
) -> Result<TrackWaveformSummary, String> {
    let input = file_path.into();
    if !input.is_file() {
        return Err(format!("audio file not found: {}", input.display()));
    }

    let range = resolve_waveform_decode_range(start_seconds, end_seconds);
    let cache_key = build_waveform_cache_key(&input, range)?;
    let cache_dir = waveform_cache_dir(cache_root, &cache_key);
    let manifest_path = cache_dir.join("manifest.json");

    if let Ok(manifest) = read_waveform_manifest(&manifest_path) {
        return Ok(summary_from_manifest(cache_key, &manifest));
    }

    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir).map_err(|error| {
            format!(
                "failed to reset waveform cache `{}`: {error}",
                cache_dir.display()
            )
        })?;
    }
    fs::create_dir_all(&cache_dir).map_err(|error| {
        format!(
            "failed to create waveform cache `{}`: {error}",
            cache_dir.display()
        )
    })?;

    let mut child = spawn_waveform_decode(ffmpeg, &input, range)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg stdout pipe is missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "ffmpeg stderr pipe is missing".to_string())?;
    let stderr_reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut message = String::new();
        let _ = reader.read_to_string(&mut message);
        message
    });

    let mut writer = WaveformChunkCacheWriter::new(cache_dir.clone(), range.start_ms)?;
    read_waveform_samples(stdout, &mut writer)?;

    let status = child.wait().map_err(|error| error.to_string())?;
    let stderr_message = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        let _ = fs::remove_dir_all(&cache_dir);
        return Err(format!("ffmpeg waveform decode failed: {stderr_message}"));
    }

    let manifest = writer.finish()?;
    if manifest.duration_ms == 0 {
        let _ = fs::remove_dir_all(&cache_dir);
        return Err("ffmpeg waveform decode produced no audio frames".to_string());
    }

    write_waveform_manifest(&manifest_path, &manifest)?;

    Ok(summary_from_manifest(cache_key, &manifest))
}

pub fn get_track_waveform_tile_with_binary(
    ffmpeg: &Path,
    cache_root: &Path,
    file_path: impl Into<PathBuf>,
    start_seconds: Option<u32>,
    end_seconds: Option<u32>,
    pixels_per_second: f64,
    tile_start_px: u32,
    tile_width: u32,
) -> Result<TrackWaveformTile, String> {
    let input = file_path.into();
    let summary =
        prepare_track_waveform_cache(ffmpeg, cache_root, &input, start_seconds, end_seconds)?;
    let cache_dir = waveform_cache_dir(cache_root, &summary.cache_key);
    let manifest = read_waveform_manifest(&cache_dir.join("manifest.json"))?;
    let source_points_per_second =
        resolve_waveform_level(pixels_per_second.ceil() as u32, &summary.levels);
    let level = manifest
        .levels
        .iter()
        .find(|level| level.points_per_second == source_points_per_second)
        .ok_or_else(|| {
            format!("waveform cache level {source_points_per_second} points/s is missing")
        })?;
    let width_px = tile_width.clamp(1, 4096);
    let mut tile_reader = WaveformTileReader::new(cache_dir, level);
    let (min, max) = tile_reader.resolve_tile(
        tile_start_px,
        width_px,
        pixels_per_second,
        source_points_per_second,
    )?;

    Ok(TrackWaveformTile {
        start_px: tile_start_px,
        width_px,
        points_per_second: source_points_per_second,
        min,
        max,
    })
}

pub fn analyze_track_waveform_with_binary(
    ffmpeg: &Path,
    file_path: impl Into<PathBuf>,
    start_seconds: Option<u32>,
    end_seconds: Option<u32>,
) -> Result<TrackWaveform, String> {
    let input = file_path.into();
    if !input.is_file() {
        return Err(format!("audio file not found: {}", input.display()));
    }

    let range = resolve_waveform_decode_range(start_seconds, end_seconds);
    let mut child = spawn_waveform_decode(ffmpeg, &input, range)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg stdout pipe is missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "ffmpeg stderr pipe is missing".to_string())?;
    let stderr_reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut message = String::new();
        let _ = reader.read_to_string(&mut message);
        message
    });

    let mut accumulator = WaveformPeakAccumulator::new(WAVEFORM_SAMPLES_PER_POINT);
    read_waveform_samples(stdout, &mut accumulator)?;

    let status = child.wait().map_err(|error| error.to_string())?;
    let stderr_message = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("ffmpeg waveform decode failed: {stderr_message}"));
    }

    let frame_count = accumulator.frame_count();
    if frame_count == 0 {
        return Err("ffmpeg waveform decode produced no audio frames".to_string());
    }

    Ok(TrackWaveform {
        sample_rate: WAVEFORM_SAMPLE_RATE,
        samples_per_point: WAVEFORM_SAMPLES_PER_POINT,
        points_per_second: WAVEFORM_SAMPLE_RATE / WAVEFORM_SAMPLES_PER_POINT,
        start_ms: range.start_ms,
        duration_ms: duration_ms_from_frames(frame_count, WAVEFORM_SAMPLE_RATE),
        peaks: accumulator.finish(),
    })
}

fn spawn_waveform_decode(
    ffmpeg: &Path,
    input: &Path,
    range: WaveformDecodeRange,
) -> Result<std::process::Child, String> {
    let mut command = Command::new(ffmpeg);
    for arg in build_waveform_ffmpeg_args(input, range) {
        command.arg(arg);
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn().map_err(|error| error.to_string())
}

fn read_waveform_samples(
    stdout: std::process::ChildStdout,
    sink: &mut impl WaveformSampleSink,
) -> Result<(), String> {
    let mut reader = BufReader::new(stdout);
    let mut buffer = [0_u8; 64 * 1024];
    let mut pending = Vec::<u8>::new();

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("failed to read ffmpeg waveform output: {error}"))?;
        if read == 0 {
            break;
        }

        pending.extend_from_slice(&buffer[..read]);
        let aligned_len = pending.len() / 4 * 4;
        for chunk in pending[..aligned_len].chunks_exact(4) {
            sink.push_sample(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))?;
        }
        pending.drain(..aligned_len);
    }

    if !pending.is_empty() {
        return Err("ffmpeg waveform output ended with an incomplete f32 sample".to_string());
    }

    Ok(())
}

pub trait WaveformSampleSink {
    fn push_sample(&mut self, sample: f32) -> Result<(), String>;
}

pub struct WaveformPeakAccumulator {
    samples_per_point: u32,
    frame_count: u64,
    current_count: u32,
    current_min: f32,
    current_max: f32,
    peaks: Vec<WaveformPeak>,
}

impl WaveformPeakAccumulator {
    pub fn new(samples_per_point: u32) -> Self {
        Self {
            samples_per_point: samples_per_point.max(1),
            frame_count: 0,
            current_count: 0,
            current_min: 0.0,
            current_max: 0.0,
            peaks: Vec::new(),
        }
    }

    pub fn push_sample(&mut self, sample: f32) -> Result<(), String> {
        let sample = sanitize_pcm_sample(sample);
        if self.current_count == 0 {
            self.current_min = sample;
            self.current_max = sample;
        } else {
            self.current_min = self.current_min.min(sample);
            self.current_max = self.current_max.max(sample);
        }

        self.current_count += 1;
        self.frame_count += 1;

        if self.current_count >= self.samples_per_point {
            self.flush_current_peak();
        }

        Ok(())
    }

    pub fn frame_count(&self) -> u64 {
        self.frame_count
    }

    pub fn finish(mut self) -> Vec<WaveformPeak> {
        self.flush_current_peak();
        self.peaks
    }

    fn flush_current_peak(&mut self) {
        if self.current_count == 0 {
            return;
        }

        self.peaks.push(WaveformPeak {
            min: self.current_min,
            max: self.current_max,
        });
        self.current_count = 0;
        self.current_min = 0.0;
        self.current_max = 0.0;
    }
}

impl WaveformSampleSink for WaveformPeakAccumulator {
    fn push_sample(&mut self, sample: f32) -> Result<(), String> {
        WaveformPeakAccumulator::push_sample(self, sample)
    }
}

struct WaveformChunkCacheWriter {
    frame_count: u64,
    current_count: u32,
    current_min: f32,
    current_max: f32,
    levels: Vec<WaveformLevelChunkWriter>,
    start_ms: u32,
}

impl WaveformChunkCacheWriter {
    fn new(cache_dir: PathBuf, start_ms: u32) -> Result<Self, String> {
        let mut levels = Vec::with_capacity(WAVEFORM_CACHE_LEVELS.len());

        for points_per_second in WAVEFORM_CACHE_LEVELS {
            levels.push(WaveformLevelChunkWriter::new(
                cache_dir.join(points_per_second.to_string()),
                points_per_second,
            )?);
        }

        Ok(Self {
            frame_count: 0,
            current_count: 0,
            current_min: 0.0,
            current_max: 0.0,
            levels,
            start_ms,
        })
    }

    fn finish(mut self) -> Result<WaveformCacheManifest, String> {
        self.flush_current_peak()?;

        let duration_ms = duration_ms_from_frames(self.frame_count, WAVEFORM_SAMPLE_RATE);
        let mut levels = Vec::with_capacity(self.levels.len());

        for level in self.levels {
            levels.push(level.finish()?);
        }

        Ok(WaveformCacheManifest {
            version: WAVEFORM_CACHE_VERSION.to_string(),
            sample_rate: WAVEFORM_SAMPLE_RATE,
            samples_per_point: WAVEFORM_SAMPLES_PER_POINT,
            base_points_per_second: WAVEFORM_BASE_POINTS_PER_SECOND,
            chunk_duration_ms: WAVEFORM_CHUNK_DURATION_MS,
            start_ms: self.start_ms,
            duration_ms,
            levels,
        })
    }

    fn flush_current_peak(&mut self) -> Result<(), String> {
        if self.current_count == 0 {
            return Ok(());
        }

        let peak = WaveformPeak {
            min: self.current_min,
            max: self.current_max,
        };

        for level in &mut self.levels {
            level.push_base_peak(peak)?;
        }

        self.current_count = 0;
        self.current_min = 0.0;
        self.current_max = 0.0;
        Ok(())
    }
}

impl WaveformSampleSink for WaveformChunkCacheWriter {
    fn push_sample(&mut self, sample: f32) -> Result<(), String> {
        let sample = sanitize_pcm_sample(sample);
        if self.current_count == 0 {
            self.current_min = sample;
            self.current_max = sample;
        } else {
            self.current_min = self.current_min.min(sample);
            self.current_max = self.current_max.max(sample);
        }

        self.current_count += 1;
        self.frame_count += 1;

        if self.current_count >= WAVEFORM_SAMPLES_PER_POINT {
            self.flush_current_peak()?;
        }

        Ok(())
    }
}

struct WaveformLevelChunkWriter {
    chunk_index: u32,
    current_count: u32,
    current_max: f32,
    current_min: f32,
    dir: PathBuf,
    max_values: Vec<i8>,
    min_values: Vec<i8>,
    point_count: u64,
    points_per_chunk: u32,
    points_per_second: u32,
    source_peaks_per_point: u32,
}

impl WaveformLevelChunkWriter {
    fn new(dir: PathBuf, points_per_second: u32) -> Result<Self, String> {
        fs::create_dir_all(&dir).map_err(|error| {
            format!(
                "failed to create waveform level cache `{}`: {error}",
                dir.display()
            )
        })?;

        let points_per_chunk = resolve_waveform_points_per_chunk(points_per_second);
        let source_peaks_per_point =
            (WAVEFORM_BASE_POINTS_PER_SECOND / points_per_second.max(1)).max(1);

        Ok(Self {
            chunk_index: 0,
            current_count: 0,
            current_max: 0.0,
            current_min: 0.0,
            dir,
            max_values: Vec::with_capacity(points_per_chunk as usize),
            min_values: Vec::with_capacity(points_per_chunk as usize),
            point_count: 0,
            points_per_chunk,
            points_per_second,
            source_peaks_per_point,
        })
    }

    fn finish(mut self) -> Result<WaveformLevelManifest, String> {
        self.flush_current_point()?;
        self.flush_chunk()?;

        Ok(WaveformLevelManifest {
            points_per_second: self.points_per_second,
            points_per_chunk: self.points_per_chunk,
            point_count: self.point_count,
            chunk_count: self.chunk_index,
        })
    }

    fn flush_chunk(&mut self) -> Result<(), String> {
        if self.min_values.is_empty() {
            return Ok(());
        }

        let mut bytes = Vec::with_capacity(self.min_values.len() * 2);
        for (min, max) in self.min_values.iter().zip(&self.max_values) {
            bytes.push(*min as u8);
            bytes.push(*max as u8);
        }

        let path = self.dir.join(format!("{}.bin", self.chunk_index));
        fs::File::create(&path)
            .and_then(|mut file| file.write_all(&bytes))
            .map_err(|error| {
                format!(
                    "failed to write waveform chunk `{}`: {error}",
                    path.display()
                )
            })?;

        self.chunk_index += 1;
        self.min_values.clear();
        self.max_values.clear();
        Ok(())
    }

    fn flush_current_point(&mut self) -> Result<(), String> {
        if self.current_count == 0 {
            return Ok(());
        }

        self.min_values
            .push(quantize_waveform_peak(self.current_min));
        self.max_values
            .push(quantize_waveform_peak(self.current_max));
        self.point_count += 1;
        self.current_count = 0;
        self.current_min = 0.0;
        self.current_max = 0.0;

        if self.min_values.len() >= self.points_per_chunk as usize {
            self.flush_chunk()?;
        }

        Ok(())
    }

    fn push_base_peak(&mut self, peak: WaveformPeak) -> Result<(), String> {
        if self.current_count == 0 {
            self.current_min = peak.min;
            self.current_max = peak.max;
        } else {
            self.current_min = self.current_min.min(peak.min);
            self.current_max = self.current_max.max(peak.max);
        }

        self.current_count += 1;
        if self.current_count >= self.source_peaks_per_point {
            self.flush_current_point()?;
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct QuantizedWaveformPeak {
    min: i8,
    max: i8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WaveformTilePointRange {
    pub end_index: u64,
    pub start_index: u64,
}

pub(crate) fn resolve_waveform_points_per_chunk(points_per_second: u32) -> u32 {
    points_per_second.max(1) * (WAVEFORM_CHUNK_DURATION_MS / 1000).max(1)
}

pub(crate) fn resolve_waveform_tile_point_range(
    tile_start_px: u32,
    pixel_offset: u32,
    pixels_per_second: f64,
    points_per_second: u32,
) -> WaveformTilePointRange {
    let safe_pixels_per_second = pixels_per_second.max(1.0);
    let safe_points_per_second = points_per_second.max(1) as f64;
    let pixel_start = tile_start_px.saturating_add(pixel_offset) as f64;
    let pixel_end = pixel_start + 1.0;
    let start_index =
        floor_waveform_point_index((pixel_start / safe_pixels_per_second) * safe_points_per_second);
    let end_index =
        ceil_waveform_point_index((pixel_end / safe_pixels_per_second) * safe_points_per_second)
            .max(start_index.saturating_add(1));

    WaveformTilePointRange {
        end_index,
        start_index,
    }
}

fn floor_waveform_point_index(value: f64) -> u64 {
    let nearest = value.round();
    let epsilon = waveform_point_index_epsilon(value);

    if (value - nearest).abs() <= epsilon {
        return nearest.max(0.0) as u64;
    }

    value.floor().max(0.0) as u64
}

fn ceil_waveform_point_index(value: f64) -> u64 {
    let nearest = value.round();
    let epsilon = waveform_point_index_epsilon(value);

    if (value - nearest).abs() <= epsilon {
        return nearest.max(0.0) as u64;
    }

    value.ceil().max(0.0) as u64
}

fn waveform_point_index_epsilon(value: f64) -> f64 {
    (value.abs() * f64::EPSILON * 16.0).max(WAVEFORM_POINT_INDEX_EPSILON)
}

struct WaveformTileReader<'a> {
    cache_dir: PathBuf,
    chunks: HashMap<u32, Vec<u8>>,
    level: &'a WaveformLevelManifest,
}

impl<'a> WaveformTileReader<'a> {
    fn new(cache_dir: PathBuf, level: &'a WaveformLevelManifest) -> Self {
        Self {
            cache_dir,
            chunks: HashMap::new(),
            level,
        }
    }

    fn read_chunk(&mut self, chunk_index: u32) -> Result<&[u8], String> {
        if !self.chunks.contains_key(&chunk_index) {
            let path = self
                .cache_dir
                .join(self.level.points_per_second.to_string())
                .join(format!("{chunk_index}.bin"));
            let bytes = fs::read(&path).map_err(|error| {
                format!(
                    "failed to read waveform chunk `{}`: {error}",
                    path.display()
                )
            })?;

            self.chunks.insert(chunk_index, bytes);
        }

        Ok(self
            .chunks
            .get(&chunk_index)
            .map(|bytes| bytes.as_slice())
            .unwrap_or(&[]))
    }

    fn resolve_tile(
        &mut self,
        tile_start_px: u32,
        width_px: u32,
        pixels_per_second: f64,
        points_per_second: u32,
    ) -> Result<(Vec<i8>, Vec<i8>), String> {
        let mut min = Vec::with_capacity(width_px as usize);
        let mut max = Vec::with_capacity(width_px as usize);

        for pixel_offset in 0..width_px {
            let point_range = resolve_waveform_tile_point_range(
                tile_start_px,
                pixel_offset,
                pixels_per_second,
                points_per_second,
            );
            let peak = self.resolve_range(point_range.start_index, point_range.end_index)?;

            min.push(peak.min);
            max.push(peak.max);
        }

        Ok((min, max))
    }

    fn resolve_range(
        &mut self,
        start_index: u64,
        end_index: u64,
    ) -> Result<QuantizedWaveformPeak, String> {
        let start = start_index.min(self.level.point_count);
        let end = end_index
            .min(self.level.point_count)
            .max(start.saturating_add(1));
        let mut min = i8::MAX;
        let mut max = i8::MIN;
        let mut found = false;

        if start >= self.level.point_count {
            return Ok(QuantizedWaveformPeak { min: 0, max: 0 });
        }

        let mut index = start;
        let end = end.min(self.level.point_count);
        let points_per_chunk = self.level.points_per_chunk.max(1) as u64;

        while index < end {
            let chunk_index = (index / points_per_chunk) as u32;
            let chunk_offset = (index % points_per_chunk) as usize;
            let chunk_end = ((chunk_index as u64 + 1) * points_per_chunk).min(end);
            let expected_points = (chunk_end - index) as usize;
            let bytes = self.read_chunk(chunk_index)?;
            let available_points = bytes.len() / 2;
            let available_end = (chunk_offset + expected_points).min(available_points);

            if available_end > chunk_offset {
                let byte_start = chunk_offset * 2;
                let byte_end = available_end * 2;
                for pair in bytes[byte_start..byte_end].chunks_exact(2) {
                    min = min.min(pair[0] as i8);
                    max = max.max(pair[1] as i8);
                    found = true;
                }
            }

            if available_end < chunk_offset + expected_points {
                min = min.min(0);
                max = max.max(0);
                found = true;
            }

            index = chunk_end;
        }

        if !found {
            return Ok(QuantizedWaveformPeak { min: 0, max: 0 });
        }

        Ok(QuantizedWaveformPeak { min, max })
    }
}

fn sanitize_pcm_sample(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

pub(crate) fn quantize_waveform_peak(value: f32) -> i8 {
    (sanitize_pcm_sample(value) * 127.0)
        .round()
        .clamp(-127.0, 127.0) as i8
}

fn duration_ms_from_frames(frame_count: u64, sample_rate: u32) -> u32 {
    if sample_rate == 0 {
        return 0;
    }

    let sample_rate = sample_rate as u64;
    let duration_ms = frame_count
        .saturating_mul(1000)
        .saturating_add(sample_rate / 2)
        / sample_rate;
    duration_ms.min(u32::MAX as u64) as u32
}

fn seconds_to_millis(seconds: u32) -> u32 {
    seconds.saturating_mul(1000)
}

fn format_millis_as_seconds(ms: u32) -> String {
    format!("{:.3}", ms as f64 / 1000.0)
}

fn build_waveform_cache_key(input: &Path, range: WaveformDecodeRange) -> Result<String, String> {
    let metadata = input
        .metadata()
        .map_err(|error| format!("failed to read audio file metadata: {error}"))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let canonical_input = input.canonicalize().unwrap_or_else(|_| input.to_path_buf());
    let mut hasher = Sha256::new();

    hasher.update(WAVEFORM_CACHE_VERSION.as_bytes());
    hasher.update(canonical_input.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified_ms.to_le_bytes());
    hasher.update(range.start_ms.to_le_bytes());
    hasher.update(range.duration_ms.unwrap_or(0).to_le_bytes());

    Ok(hex::encode(hasher.finalize()))
}

fn read_waveform_manifest(path: &Path) -> Result<WaveformCacheManifest, String> {
    let bytes = fs::read(path).map_err(|error| {
        format!(
            "failed to read waveform manifest `{}`: {error}",
            path.display()
        )
    })?;
    let manifest = serde_json::from_slice::<WaveformCacheManifest>(&bytes).map_err(|error| {
        format!(
            "failed to parse waveform manifest `{}`: {error}",
            path.display()
        )
    })?;

    if manifest.version != WAVEFORM_CACHE_VERSION {
        return Err(format!(
            "waveform manifest `{}` has unsupported version `{}`",
            path.display(),
            manifest.version
        ));
    }

    Ok(manifest)
}

fn write_waveform_manifest(path: &Path, manifest: &WaveformCacheManifest) -> Result<(), String> {
    let bytes = serde_json::to_vec(manifest)
        .map_err(|error| format!("failed to encode waveform manifest: {error}"))?;
    let temporary_path = path.with_extension("json.tmp");

    fs::write(&temporary_path, bytes).map_err(|error| {
        format!(
            "failed to write waveform manifest `{}`: {error}",
            temporary_path.display()
        )
    })?;
    fs::rename(&temporary_path, path).map_err(|error| {
        format!(
            "failed to finalize waveform manifest `{}`: {error}",
            path.display()
        )
    })
}

pub(crate) fn resolve_waveform_level(target_points_per_second: u32, levels: &[u32]) -> u32 {
    let target = target_points_per_second.max(1);
    let mut sorted_levels = levels.to_vec();
    sorted_levels.sort_unstable();

    sorted_levels
        .iter()
        .copied()
        .find(|level| *level >= target)
        .or_else(|| sorted_levels.last().copied())
        .unwrap_or(WAVEFORM_BASE_POINTS_PER_SECOND)
}

fn summary_from_manifest(
    cache_key: String,
    manifest: &WaveformCacheManifest,
) -> TrackWaveformSummary {
    TrackWaveformSummary {
        cache_key,
        sample_rate: manifest.sample_rate,
        samples_per_point: manifest.samples_per_point,
        base_points_per_second: manifest.base_points_per_second,
        chunk_duration_ms: manifest.chunk_duration_ms,
        start_ms: manifest.start_ms,
        duration_ms: manifest.duration_ms,
        levels: manifest
            .levels
            .iter()
            .map(|level| level.points_per_second)
            .collect(),
    }
}

fn waveform_cache_dir(cache_root: &Path, cache_key: &str) -> PathBuf {
    cache_root.join(WAVEFORM_CACHE_VERSION).join(cache_key)
}
