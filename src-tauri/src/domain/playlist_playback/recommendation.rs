use crate::domain::player::model::PlaybackTrack;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{BufReader, Read};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const AUDIO_STYLE_EMBEDDING_VERSION: &str = "audio-style-sketch-v1";
const AUDIO_STYLE_SAMPLE_RATE: u32 = 6_000;
const AUDIO_STYLE_INTERVAL_SECONDS: f64 = 12.0;
const AUDIO_STYLE_INTERVAL_COUNT: usize = 6;
const AUDIO_STYLE_TERMINAL_BINS: usize = 64;
const AUDIO_STYLE_EMBEDDING_WIDTH: usize = AUDIO_STYLE_TERMINAL_BINS * AUDIO_STYLE_TERMINAL_BINS;
const AUDIO_STYLE_FRAME_SIZE: usize = 512;
const AUDIO_STYLE_HOP_SIZE: usize = 128;
const AUDIO_STYLE_SMOOTHNESS: f32 = 5.0;
const AUDIO_STYLE_EXPLORATION_FLOOR: f32 = 0.04;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PlaybackTrackKey {
    playlist_name: String,
    music_url: String,
    file_path: PathBuf,
    start_ms: u32,
    end_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAudioStyleEmbedding {
    version: String,
    values: Vec<f32>,
}

#[derive(Debug, Clone)]
pub(crate) struct AudioStyleEmbedding {
    values: Vec<f32>,
}

pub(crate) struct AudioStyleEmbeddingCache {
    cache_root: PathBuf,
    ffmpeg_path: PathBuf,
}

pub(crate) struct AudioStylePlaylistPlaybackRecommender {
    embeddings: HashMap<PlaybackTrackKey, AudioStyleEmbedding>,
}

impl PlaybackTrackKey {
    fn from_track(track: &PlaybackTrack) -> Self {
        Self {
            playlist_name: track.playlist_name.clone(),
            music_url: track.music_url.clone(),
            file_path: track.file_path.clone(),
            start_ms: track.start_ms,
            end_ms: track.end_ms,
        }
    }

    fn matches_track(&self, track: &PlaybackTrack) -> bool {
        self.playlist_name == track.playlist_name
            && self.music_url == track.music_url
            && self.file_path == track.file_path
            && self.start_ms == track.start_ms
            && self.end_ms == track.end_ms
    }
}

impl AudioStyleEmbedding {
    fn normalize(mut values: Vec<f32>) -> Option<Self> {
        if values.len() != AUDIO_STYLE_EMBEDDING_WIDTH {
            return None;
        }
        let norm = values
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt()
            .max(1.0e-6);
        for value in &mut values {
            *value = (*value / norm).clamp(-1.0, 1.0);
        }
        Some(Self { values })
    }

    fn cosine(&self, other: &Self) -> f32 {
        self.values
            .iter()
            .zip(other.values.iter())
            .map(|(left, right)| left * right)
            .sum::<f32>()
            .clamp(-1.0, 1.0)
    }
}

impl AudioStyleEmbeddingCache {
    pub(crate) fn new(ffmpeg_path: PathBuf, cache_root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&cache_root).map_err(|error| {
            format!(
                "failed to create audio style embedding cache `{}`: {error}",
                cache_root.display()
            )
        })?;
        Ok(Self {
            cache_root,
            ffmpeg_path,
        })
    }

    pub(crate) fn embedding_for_track(
        &self,
        track: &PlaybackTrack,
    ) -> Result<AudioStyleEmbedding, String> {
        let cache_key = build_audio_style_embedding_cache_key(track)?;
        let cache_path = self.cache_root.join(format!("{cache_key}.json"));
        if let Ok(embedding) = read_cached_audio_style_embedding(&cache_path) {
            return Ok(embedding);
        }

        let embedding = decode_audio_style_embedding(&self.ffmpeg_path, track)?;
        write_cached_audio_style_embedding(&cache_path, &embedding)?;
        Ok(embedding)
    }

    pub(crate) fn cached_embedding_for_track(
        &self,
        track: &PlaybackTrack,
    ) -> Result<Option<AudioStyleEmbedding>, String> {
        let cache_key = build_audio_style_embedding_cache_key(track)?;
        let cache_path = self.cache_root.join(format!("{cache_key}.json"));
        match read_cached_audio_style_embedding_with_kind(&cache_path) {
            Ok(embedding) => Ok(Some(embedding)),
            Err(error) if error.kind == AudioStyleEmbeddingCacheReadErrorKind::Missing => Ok(None),
            Err(error) => Err(error.message),
        }
    }
}

impl AudioStylePlaylistPlaybackRecommender {
    pub(crate) fn from_cached_tracks(
        cache: &AudioStyleEmbeddingCache,
        tracks: &[PlaybackTrack],
    ) -> (Self, Vec<PlaybackTrack>, Vec<String>) {
        let mut embeddings = HashMap::new();
        let mut missing_tracks = Vec::new();
        let mut failures = Vec::new();
        let mut seen = HashSet::new();
        for track in tracks {
            let key = PlaybackTrackKey::from_track(track);
            if !seen.insert(key.clone()) {
                continue;
            }
            match cache.cached_embedding_for_track(track) {
                Ok(Some(embedding)) => {
                    embeddings.insert(key, embedding);
                }
                Ok(None) => {
                    missing_tracks.push(track.clone());
                }
                Err(error) => {
                    failures.push(format!("{}: {error}", track.file_path.display()));
                    missing_tracks.push(track.clone());
                }
            }
        }
        (Self { embeddings }, missing_tracks, failures)
    }

    #[cfg(test)]
    pub(crate) fn from_test_embeddings(
        values: impl IntoIterator<Item = (PlaybackTrack, Vec<f32>)>,
    ) -> Self {
        let embeddings = values
            .into_iter()
            .filter_map(|(track, values)| {
                AudioStyleEmbedding::normalize(values)
                    .map(|embedding| (PlaybackTrackKey::from_track(&track), embedding))
            })
            .collect();
        Self { embeddings }
    }

    pub(crate) fn has_embedding_for(&self, track: &PlaybackTrack) -> bool {
        self.embeddings
            .contains_key(&PlaybackTrackKey::from_track(track))
    }

    pub(crate) fn propose_queue(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
    ) -> Vec<PlaybackTrack> {
        let remaining = dedupe_tracks_excluding(candidates, Some(&current_track));
        let mut queue = Vec::with_capacity(2);
        queue.push(current_track.clone());
        if let Some(next) = self.propose_next(&current_track, remaining) {
            queue.push(next);
        }
        queue
    }

    pub(crate) fn propose_queue_after_exclude(
        &self,
        current_track: PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
    ) -> Vec<PlaybackTrack> {
        let remaining = dedupe_tracks_excluding(candidates, Some(&current_track));
        self.propose_next(&current_track, remaining)
            .into_iter()
            .collect()
    }

    fn propose_next(
        &self,
        current_track: &PlaybackTrack,
        candidates: Vec<PlaybackTrack>,
    ) -> Option<PlaybackTrack> {
        if candidates.is_empty() {
            return None;
        }

        let mut rng = rand::rng();
        let draw = rng.random_range(0.0..1.0);
        let next_index = select_next_audio_style_candidate_index(
            &candidates,
            self.embeddings
                .get(&PlaybackTrackKey::from_track(current_track)),
            &self.embeddings,
            draw,
        );
        candidates.into_iter().nth(next_index)
    }
}

fn dedupe_tracks_excluding(
    tracks: Vec<PlaybackTrack>,
    excluded: Option<&PlaybackTrack>,
) -> Vec<PlaybackTrack> {
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(tracks.len());
    for track in tracks {
        if excluded
            .is_some_and(|excluded| PlaybackTrackKey::from_track(excluded).matches_track(&track))
        {
            continue;
        }
        let key = PlaybackTrackKey::from_track(&track);
        if seen.insert(key) {
            result.push(track);
        }
    }
    result
}

fn select_next_audio_style_candidate_index(
    candidates: &[PlaybackTrack],
    anchor: Option<&AudioStyleEmbedding>,
    embeddings: &HashMap<PlaybackTrackKey, AudioStyleEmbedding>,
    draw_unit: f32,
) -> usize {
    if candidates.is_empty() {
        return 0;
    }
    let Some(anchor) = anchor else {
        return random_fallback_index(candidates.len(), draw_unit);
    };

    let mut candidate_weights = Vec::with_capacity(candidates.len());
    let mut non_liked_weights = Vec::new();
    for candidate in candidates {
        let key = PlaybackTrackKey::from_track(candidate);
        let style_weight = embeddings
            .get(&key)
            .map(|embedding| {
                (AUDIO_STYLE_SMOOTHNESS * anchor.cosine(embedding)).exp()
                    + AUDIO_STYLE_EXPLORATION_FLOOR
            })
            .unwrap_or(AUDIO_STYLE_EXPLORATION_FLOOR);
        let safe_style_weight = style_weight.max(AUDIO_STYLE_EXPLORATION_FLOOR);
        if !candidate.liked {
            non_liked_weights.push(safe_style_weight);
        }
        candidate_weights.push((candidate.liked, safe_style_weight));
    }

    let liked_weight = liked_candidate_weight(&non_liked_weights);
    let mut weights = Vec::with_capacity(candidate_weights.len());
    let mut total = 0.0_f32;
    for (liked, style_weight) in candidate_weights {
        let safe_weight = if liked { liked_weight } else { style_weight };
        weights.push(safe_weight);
        total += safe_weight;
    }

    if total <= 0.0 || !total.is_finite() {
        return random_fallback_index(candidates.len(), draw_unit);
    }

    let mut cursor = draw_unit.clamp(0.0, 0.999_999) * total;
    for (index, weight) in weights.into_iter().enumerate() {
        if cursor <= weight {
            return index;
        }
        cursor -= weight;
    }
    candidates.len() - 1
}

fn liked_candidate_weight(non_liked_weights: &[f32]) -> f32 {
    if non_liked_weights.is_empty() {
        return 1.0;
    }

    let mut weights = non_liked_weights
        .iter()
        .copied()
        .filter(|weight| weight.is_finite() && *weight > 0.0)
        .collect::<Vec<_>>();
    if weights.is_empty() {
        return 1.0;
    }

    weights.sort_by(|left, right| left.total_cmp(right));
    if weights.len() == 1 {
        return weights[0].max(AUDIO_STYLE_EXPLORATION_FLOOR);
    }

    let middle = weights.len() / 2;
    let median = if weights.len() % 2 == 0 {
        (weights[middle - 1] + weights[middle]) / 2.0
    } else {
        weights[middle]
    };
    median.max(AUDIO_STYLE_EXPLORATION_FLOOR)
}

fn random_fallback_index(len: usize, draw_unit: f32) -> usize {
    ((draw_unit.clamp(0.0, 0.999_999) * len as f32).floor() as usize).min(len.saturating_sub(1))
}

fn decode_audio_style_embedding(
    ffmpeg_path: &Path,
    track: &PlaybackTrack,
) -> Result<AudioStyleEmbedding, String> {
    let starts = audio_style_interval_starts(track.start_ms, track.end_ms);
    let mut merged = vec![0.0_f32; AUDIO_STYLE_EMBEDDING_WIDTH];
    let mut decoded_count = 0usize;
    for start_seconds in starts {
        let samples = decode_audio_style_interval(ffmpeg_path, &track.file_path, start_seconds)?;
        let local = audio_style_transition_fingerprint(&samples);
        for (merged_value, local_value) in merged.iter_mut().zip(local.into_iter()) {
            *merged_value += local_value;
        }
        decoded_count += 1;
    }

    if decoded_count == 0 {
        return Err("audio style embedding decoded no intervals".to_string());
    }
    let scale = 1.0 / decoded_count as f32;
    for value in &mut merged {
        *value *= scale;
    }
    AudioStyleEmbedding::normalize(merged)
        .ok_or_else(|| "audio style embedding has invalid width".to_string())
}

fn audio_style_interval_starts(start_ms: u32, end_ms: u32) -> Vec<f64> {
    let start_seconds = start_ms as f64 / 1000.0;
    let end_seconds = end_ms as f64 / 1000.0;
    let duration = (end_seconds - start_seconds).max(0.0);
    if duration <= AUDIO_STYLE_INTERVAL_SECONDS {
        return vec![start_seconds];
    }

    let max_start = start_seconds + duration - AUDIO_STYLE_INTERVAL_SECONDS;
    if AUDIO_STYLE_INTERVAL_COUNT <= 1 {
        return vec![start_seconds.min(max_start)];
    }

    (0..AUDIO_STYLE_INTERVAL_COUNT)
        .map(|index| {
            let ratio = index as f64 / (AUDIO_STYLE_INTERVAL_COUNT - 1) as f64;
            start_seconds + ratio * (max_start - start_seconds)
        })
        .collect()
}

fn decode_audio_style_interval(
    ffmpeg_path: &Path,
    input: &Path,
    start_seconds: f64,
) -> Result<Vec<f32>, String> {
    let mut command = Command::new(ffmpeg_path);
    for arg in build_audio_style_ffmpeg_args(input, start_seconds) {
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

    let mut child = command.spawn().map_err(|error| error.to_string())?;
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

    let mut samples = read_f32le_samples(stdout)?;
    let status = child.wait().map_err(|error| error.to_string())?;
    let stderr_message = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        return Err(format!(
            "ffmpeg audio style decode failed: {stderr_message}"
        ));
    }
    normalize_samples(&mut samples);
    if samples.is_empty() {
        return Err("ffmpeg audio style decode produced no samples".to_string());
    }
    Ok(samples)
}

fn build_audio_style_ffmpeg_args(input: &Path, start_seconds: f64) -> Vec<OsString> {
    vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-ss"),
        OsString::from(format!("{start_seconds:.3}")),
        OsString::from("-t"),
        OsString::from(format!("{AUDIO_STYLE_INTERVAL_SECONDS:.3}")),
        OsString::from("-i"),
        input.as_os_str().to_owned(),
        OsString::from("-vn"),
        OsString::from("-sn"),
        OsString::from("-dn"),
        OsString::from("-ac"),
        OsString::from("1"),
        OsString::from("-ar"),
        OsString::from(AUDIO_STYLE_SAMPLE_RATE.to_string()),
        OsString::from("-f"),
        OsString::from("f32le"),
        OsString::from("-c:a"),
        OsString::from("pcm_f32le"),
        OsString::from("pipe:1"),
    ]
}

fn read_f32le_samples(stdout: std::process::ChildStdout) -> Result<Vec<f32>, String> {
    let mut reader = BufReader::new(stdout);
    let mut buffer = [0_u8; 64 * 1024];
    let mut pending = Vec::<u8>::new();
    let mut samples = Vec::new();

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("failed to read ffmpeg audio style output: {error}"))?;
        if read == 0 {
            break;
        }
        pending.extend_from_slice(&buffer[..read]);
        let aligned_len = pending.len() / 4 * 4;
        for chunk in pending[..aligned_len].chunks_exact(4) {
            samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        pending.drain(..aligned_len);
    }

    if !pending.is_empty() {
        return Err("ffmpeg audio style output ended with an incomplete f32 sample".to_string());
    }
    Ok(samples)
}

fn normalize_samples(samples: &mut [f32]) {
    if samples.is_empty() {
        return;
    }
    let mean = samples.iter().sum::<f32>() / samples.len() as f32;
    let mut peak = 1.0e-6_f32;
    for sample in samples.iter_mut() {
        *sample = sanitize_sample(*sample - mean);
        peak = peak.max(sample.abs());
    }
    for sample in samples {
        *sample = (*sample / peak).clamp(-1.0, 1.0);
    }
}

fn sanitize_sample(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

fn audio_style_transition_fingerprint(samples: &[f32]) -> Vec<f32> {
    let terminals = audio_style_terminals(samples);
    let mut transition = vec![0.0_f32; AUDIO_STYLE_EMBEDDING_WIDTH];
    if terminals.len() < 2 {
        return transition;
    }
    for pair in terminals.windows(2) {
        let prev = pair[0] as usize;
        let next = pair[1] as usize;
        transition[prev * AUDIO_STYLE_TERMINAL_BINS + next] += 1.0;
    }
    let total = transition.iter().sum::<f32>().max(1.0);
    for value in &mut transition {
        *value /= total;
    }
    transition
}

fn audio_style_terminals(samples: &[f32]) -> Vec<u8> {
    if samples.len() <= AUDIO_STYLE_FRAME_SIZE {
        return vec![audio_style_terminal_for_frame(samples, 0)];
    }

    let mut raw = Vec::new();
    let mut start = 0usize;
    while start + AUDIO_STYLE_FRAME_SIZE <= samples.len() {
        raw.push(audio_style_frame_features(
            &samples[start..start + AUDIO_STYLE_FRAME_SIZE],
        ));
        start += AUDIO_STYLE_HOP_SIZE;
    }
    if raw.is_empty() {
        return vec![audio_style_terminal_for_frame(samples, 0)];
    }

    let min_energy = raw
        .iter()
        .map(|frame| frame.energy)
        .fold(f32::INFINITY, f32::min);
    let max_energy = raw
        .iter()
        .map(|frame| frame.energy)
        .fold(f32::NEG_INFINITY, f32::max);
    let energy_span = (max_energy - min_energy).max(1.0e-6);
    let mut terminals = Vec::with_capacity(raw.len());
    let mut previous_bucket = raw[0].pitch_bucket;
    for frame in raw {
        let motion = if frame.pitch_bucket > previous_bucket {
            1
        } else if frame.pitch_bucket < previous_bucket {
            2
        } else {
            0
        };
        let energy_bucket = (((frame.energy - min_energy) / energy_span) * 3.0)
            .floor()
            .clamp(0.0, 3.0) as u8;
        let terminal = (frame.pitch_bucket as usize * 4 + motion as usize + energy_bucket as usize)
            % AUDIO_STYLE_TERMINAL_BINS;
        terminals.push(terminal as u8);
        previous_bucket = frame.pitch_bucket;
    }
    terminals
}

#[derive(Debug, Clone, Copy)]
struct AudioStyleFrameFeatures {
    pitch_bucket: u8,
    energy: f32,
}

fn audio_style_frame_features(frame: &[f32]) -> AudioStyleFrameFeatures {
    let energy =
        frame.iter().map(|sample| sample * sample).sum::<f32>() / frame.len().max(1) as f32;
    let crossings = frame
        .windows(2)
        .filter(|pair| (pair[0] <= 0.0 && pair[1] > 0.0) || (pair[0] >= 0.0 && pair[1] < 0.0))
        .count();
    let seconds = frame.len().max(1) as f32 / AUDIO_STYLE_SAMPLE_RATE as f32;
    let estimated_hz = (crossings as f32 / (2.0 * seconds)).max(1.0);
    let pitch_bucket = ((12.0 * (estimated_hz / 55.0).log2()).round() as i32).rem_euclid(16) as u8;
    AudioStyleFrameFeatures {
        pitch_bucket,
        energy,
    }
}

fn audio_style_terminal_for_frame(frame: &[f32], previous_bucket: u8) -> u8 {
    let features = audio_style_frame_features(frame);
    let motion = if features.pitch_bucket > previous_bucket {
        1
    } else if features.pitch_bucket < previous_bucket {
        2
    } else {
        0
    };
    ((features.pitch_bucket as usize * 4 + motion) % AUDIO_STYLE_TERMINAL_BINS) as u8
}

fn build_audio_style_embedding_cache_key(track: &PlaybackTrack) -> Result<String, String> {
    let metadata = track
        .file_path
        .metadata()
        .map_err(|error| format!("failed to read audio file metadata: {error}"))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let canonical_input = track
        .file_path
        .canonicalize()
        .unwrap_or_else(|_| track.file_path.clone());
    let mut hasher = Sha256::new();
    hasher.update(AUDIO_STYLE_EMBEDDING_VERSION.as_bytes());
    hasher.update(canonical_input.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified_ms.to_le_bytes());
    hasher.update(track.start_ms.to_le_bytes());
    hasher.update(track.end_ms.to_le_bytes());
    hasher.update(AUDIO_STYLE_SAMPLE_RATE.to_le_bytes());
    hasher.update(AUDIO_STYLE_INTERVAL_SECONDS.to_bits().to_le_bytes());
    hasher.update((AUDIO_STYLE_INTERVAL_COUNT as u64).to_le_bytes());
    Ok(hex::encode(hasher.finalize()))
}

fn read_cached_audio_style_embedding(path: &Path) -> Result<AudioStyleEmbedding, String> {
    read_cached_audio_style_embedding_with_kind(path).map_err(|error| error.message)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioStyleEmbeddingCacheReadErrorKind {
    Invalid,
    Missing,
}

#[derive(Debug)]
struct AudioStyleEmbeddingCacheReadError {
    kind: AudioStyleEmbeddingCacheReadErrorKind,
    message: String,
}

fn read_cached_audio_style_embedding_with_kind(
    path: &Path,
) -> Result<AudioStyleEmbedding, AudioStyleEmbeddingCacheReadError> {
    let bytes = fs::read(path).map_err(|error| AudioStyleEmbeddingCacheReadError {
        kind: if error.kind() == std::io::ErrorKind::NotFound {
            AudioStyleEmbeddingCacheReadErrorKind::Missing
        } else {
            AudioStyleEmbeddingCacheReadErrorKind::Invalid
        },
        message: format!(
            "failed to read audio style embedding cache `{}`: {error}",
            path.display()
        ),
    })?;
    let cached = serde_json::from_slice::<CachedAudioStyleEmbedding>(&bytes).map_err(|error| {
        AudioStyleEmbeddingCacheReadError {
            kind: AudioStyleEmbeddingCacheReadErrorKind::Invalid,
            message: format!(
                "failed to parse audio style embedding cache `{}`: {error}",
                path.display()
            ),
        }
    })?;
    if cached.version != AUDIO_STYLE_EMBEDDING_VERSION {
        return Err(AudioStyleEmbeddingCacheReadError {
            kind: AudioStyleEmbeddingCacheReadErrorKind::Invalid,
            message: format!(
                "audio style embedding cache `{}` has unsupported version `{}`",
                path.display(),
                cached.version
            ),
        });
    }
    AudioStyleEmbedding::normalize(cached.values).ok_or_else(|| AudioStyleEmbeddingCacheReadError {
        kind: AudioStyleEmbeddingCacheReadErrorKind::Invalid,
        message: format!(
            "audio style embedding cache `{}` has invalid width",
            path.display()
        ),
    })
}

fn write_cached_audio_style_embedding(
    path: &Path,
    embedding: &AudioStyleEmbedding,
) -> Result<(), String> {
    let cached = CachedAudioStyleEmbedding {
        version: AUDIO_STYLE_EMBEDDING_VERSION.to_string(),
        values: embedding.values.clone(),
    };
    let bytes = serde_json::to_vec(&cached)
        .map_err(|error| format!("failed to encode audio style embedding cache: {error}"))?;
    let temp_path = unique_audio_style_embedding_temp_path(path);
    fs::write(&temp_path, bytes).map_err(|error| {
        format!(
            "failed to write audio style embedding cache `{}`: {error}",
            temp_path.display()
        )
    })?;
    if let Err(error) = fs::remove_file(path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "failed to replace audio style embedding cache `{}`: {error}",
            path.display()
        ));
    }
    fs::rename(&temp_path, path).map_err(|error| {
        format!(
            "failed to finalize audio style embedding cache `{}`: {error}",
            path.display()
        )
    })
}

fn unique_audio_style_embedding_temp_path(path: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "audio-style-embedding.json".into());
    path.with_file_name(format!("{file_name}.{}.{}.tmp", std::process::id(), nanos))
}

#[cfg(test)]
pub(crate) fn choose_next_audio_style_candidate_for_test(
    current_track: &PlaybackTrack,
    candidates: &[PlaybackTrack],
    embeddings: &AudioStylePlaylistPlaybackRecommender,
    draw_unit: f32,
) -> usize {
    select_next_audio_style_candidate_index(
        candidates,
        embeddings
            .embeddings
            .get(&PlaybackTrackKey::from_track(current_track)),
        &embeddings.embeddings,
        draw_unit,
    )
}
