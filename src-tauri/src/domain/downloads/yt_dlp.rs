use super::model::CollectionSourceKind;
use anyhow::{Context, Result, bail};
use reqwest::Url;
use serde_json::Value;
use std::io::{BufRead, BufReader};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const AUDIO_ONLY_FORMAT_SELECTOR: &str = "bestaudio[ext=m4a]/bestaudio";
const YOUTUBE_PLAYLIST_EXTRACTOR_ARGS: &str = "youtube:playlist_ajax=true;tab_max_pages=50";
const PYTHON_UTF8_ENV_VAR: &str = "PYTHONUTF8";
const PYTHON_IO_ENCODING_ENV_VAR: &str = "PYTHONIOENCODING";
const UTF8_ENCODING_VALUE: &str = "utf-8";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistRoot {
    pub title: String,
    pub webpage_url: String,
    pub extractor_key: Option<String>,
    pub entries: Vec<LeafReference>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeafReference {
    pub url: String,
    pub title: Option<String>,
    pub sequence: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeafProbe {
    pub title: String,
    pub webpage_url: String,
    pub extractor_key: Option<String>,
    pub album: Option<String>,
    pub duration_seconds: Option<u32>,
    pub chapters: Vec<LeafChapter>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeafChapter {
    pub title: String,
    pub start_ms: u32,
    pub end_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootProbe {
    Single(LeafProbe),
    List(PlaylistRoot),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadedLeaf {
    pub absolute_path: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DownloadProgress {
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub speed_bytes_per_second: Option<u64>,
    pub eta_seconds: Option<u64>,
    pub phase: Option<String>,
}

pub trait YtDlpClient: Send + Sync {
    fn probe_root(&self, url: &str) -> Result<RootProbe>;
    fn probe_leaf(&self, url: &str) -> Result<LeafProbe>;
    fn download_leaf_audio(
        &self,
        url: &str,
        target_dir: &Path,
        file_stem: &str,
        on_progress: &mut dyn FnMut(DownloadProgress),
    ) -> Result<DownloadedLeaf>;
}

#[derive(Debug, Clone)]
pub struct CliYtDlpClient {
    ytdlp_path: PathBuf,
    ffmpeg_dir: PathBuf,
}

impl CliYtDlpClient {
    pub fn new(ytdlp_path: PathBuf, ffmpeg_dir: PathBuf) -> Self {
        Self {
            ytdlp_path,
            ffmpeg_dir,
        }
    }

    fn run_json_command(&self, args: &[String]) -> Result<Value> {
        let output =
            self.base_command().args(args).output().with_context(|| {
                format!("failed to run yt-dlp at {}", self.ytdlp_path.display())
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("yt-dlp command failed: {stderr}");
        }

        serde_json::from_slice::<Value>(&output.stdout).context("yt-dlp did not return valid json")
    }

    fn base_command(&self) -> Command {
        let mut command = Command::new(&self.ytdlp_path);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env(PYTHON_UTF8_ENV_VAR, "1")
            .env(PYTHON_IO_ENCODING_ENV_VAR, UTF8_ENCODING_VALUE);

        #[cfg(windows)]
        {
            command.creation_flags(CREATE_NO_WINDOW);
        }

        command
    }

    fn common_probe_args(&self) -> Vec<String> {
        vec![
            "-J".to_string(),
            "--no-warnings".to_string(),
            "--ignore-errors".to_string(),
        ]
    }
}

impl YtDlpClient for CliYtDlpClient {
    fn probe_root(&self, url: &str) -> Result<RootProbe> {
        match classify_root_preference(url) {
            CollectionSourceKind::Single => self.probe_leaf(url).map(RootProbe::Single),
            CollectionSourceKind::List => {
                let args = build_root_playlist_probe_args(url);
                parse_root_probe(self.run_json_command(&args)?, url)
            }
        }
    }

    fn probe_leaf(&self, url: &str) -> Result<LeafProbe> {
        let mut args = self.common_probe_args();
        args.push("--no-playlist".to_string());
        args.push(url.to_string());
        parse_leaf_probe(self.run_json_command(&args)?)
    }

    fn download_leaf_audio(
        &self,
        url: &str,
        target_dir: &Path,
        file_stem: &str,
        on_progress: &mut dyn FnMut(DownloadProgress),
    ) -> Result<DownloadedLeaf> {
        std::fs::create_dir_all(target_dir)
            .with_context(|| format!("failed to create {}", target_dir.display()))?;

        let output_template = target_dir
            .join(format!("{file_stem}.%(ext)s"))
            .to_string_lossy()
            .to_string();
        eprintln!(
            "[downloads:yt-dlp] spawn download url={} target_dir={} file_stem={} output_template={}",
            url,
            target_dir.display(),
            file_stem,
            output_template
        );
        let mut command = self.base_command();
        command.args(build_leaf_audio_download_args(
            &self.ffmpeg_dir,
            &output_template,
            url,
        ));

        let mut child = command.spawn().with_context(|| {
            format!(
                "failed to spawn yt-dlp download process at {}",
                self.ytdlp_path.display()
            )
        })?;

        let stdout = child
            .stdout
            .take()
            .context("yt-dlp stdout pipe was not captured")?;
        let stderr = child
            .stderr
            .take()
            .context("yt-dlp stderr pipe was not captured")?;

        let (sender, receiver) = mpsc::channel::<String>();
        let stdout_handle = spawn_line_reader(stdout, sender.clone());
        let stderr_handle = spawn_line_reader(stderr, sender);
        let mut final_path = None::<PathBuf>;

        for line in receiver {
            if let Some(progress) = parse_progress_line(&line) {
                on_progress(progress);
                continue;
            }

            if let Some(path) = line.strip_prefix("after_move:") {
                final_path = Some(PathBuf::from(path.trim()));
            }
        }

        let status = child.wait().context("failed waiting for yt-dlp download")?;
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();
        eprintln!(
            "[downloads:yt-dlp] process exited url={} status={} after_move={}",
            url,
            status,
            final_path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "<none>".to_string())
        );
        if !status.success() {
            bail!("yt-dlp download exited with status {status}");
        }

        let absolute_path =
            resolve_downloaded_file(target_dir, file_stem, final_path.as_deref())
                .context("yt-dlp completed but final audio path could not be resolved")?;
        eprintln!(
            "[downloads:yt-dlp] resolved audio url={} path={}",
            url,
            absolute_path.display()
        );

        Ok(DownloadedLeaf { absolute_path })
    }
}

pub(crate) fn build_leaf_audio_download_args(
    ffmpeg_dir: &Path,
    output_template: &str,
    url: &str,
) -> Vec<String> {
    let ffmpeg_dir = ffmpeg_dir.to_string_lossy().to_string();

    [
            "--no-warnings",
            "--no-restrict-filenames",
            "--ignore-errors",
            "--no-playlist",
            "--format",
            AUDIO_ONLY_FORMAT_SELECTOR,
            "--extract-audio",
            "--audio-format",
            "m4a",
            "--audio-quality",
            "0",
            "--ffmpeg-location",
            &ffmpeg_dir,
            "-o",
            output_template,
            "--newline",
            "--progress-template",
            "download:progress:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s|%(progress.status)s",
            "--print",
            "after_move:after_move:%(filepath)s",
            url,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub(crate) fn build_root_playlist_probe_args(url: &str) -> Vec<String> {
    [
        "-J",
        "--no-warnings",
        "--ignore-errors",
        "--flat-playlist",
        "--extractor-args",
        YOUTUBE_PLAYLIST_EXTRACTOR_ARGS,
        url,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub fn classify_root_preference(url: &str) -> CollectionSourceKind {
    if looks_like_direct_leaf_url(url) {
        CollectionSourceKind::Single
    } else {
        CollectionSourceKind::List
    }
}

pub fn looks_like_direct_leaf_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };

    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = parsed.path().to_ascii_lowercase();

    if host == "youtu.be" {
        return true;
    }

    if host.ends_with("youtube.com") {
        let query = parsed.query_pairs().collect::<Vec<_>>();
        let has_video = query
            .iter()
            .any(|(key, value)| key == "v" && !value.is_empty());
        let playlist_id = query
            .iter()
            .find(|(key, value)| key == "list" && !value.is_empty())
            .map(|(_, value)| value.to_string());
        if has_video
            && playlist_id
                .as_deref()
                .is_some_and(is_youtube_mix_playlist_id)
        {
            return true;
        }

        if has_video && playlist_id.is_none() {
            return true;
        }

        if path.starts_with("/shorts/") || path.starts_with("/live/") {
            return true;
        }
    }

    false
}

pub fn parse_root_probe(value: Value, input_url: &str) -> Result<RootProbe> {
    let is_playlist = value
        .get("_type")
        .and_then(Value::as_str)
        .map(|kind| matches!(kind, "playlist" | "multi_video"))
        .unwrap_or_else(|| {
            value
                .get("entries")
                .map(|entries| entries.is_array())
                .unwrap_or(false)
        });

    if !is_playlist {
        return Ok(RootProbe::Single(parse_leaf_probe(value)?));
    }

    let title = read_required_string(&value, "title")?;
    let webpage_url =
        read_optional_string(&value, "webpage_url").unwrap_or_else(|| input_url.to_string());
    let extractor_key = read_optional_string(&value, "extractor_key");
    let entries = value
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut leafs = Vec::new();
    for (index, entry) in entries.into_iter().enumerate() {
        if entry.is_null() {
            continue;
        }

        let entry_type = entry
            .get("_type")
            .and_then(Value::as_str)
            .unwrap_or("video");

        let Some(url) = resolve_leaf_reference_url(&entry, input_url, entry_type) else {
            continue;
        };
        let title = read_optional_string(&entry, "title");
        leafs.push(LeafReference {
            url,
            title,
            sequence: index as u32,
        });
    }

    if let Some(expected_count) = value
        .get("playlist_count")
        .and_then(parse_number_like)
        .map(|value| value as usize)
        && expected_count > leafs.len()
    {
        bail!(
            "yt-dlp returned {}/{} playlist entries; refusing to complete a partial playlist probe",
            leafs.len(),
            expected_count
        );
    }

    Ok(RootProbe::List(PlaylistRoot {
        title,
        webpage_url,
        extractor_key,
        entries: leafs,
    }))
}

pub fn parse_leaf_probe(value: Value) -> Result<LeafProbe> {
    let title = read_required_string(&value, "title")?;
    let webpage_url = read_optional_string(&value, "webpage_url")
        .or_else(|| read_optional_string(&value, "original_url"))
        .context("yt-dlp metadata is missing webpage_url")?;
    let extractor_key = read_optional_string(&value, "extractor_key");
    let album = read_optional_string(&value, "album");
    let duration_seconds = value
        .get("duration")
        .and_then(parse_number_like)
        .map(|value| value.ceil() as u32);
    let chapters = value
        .get("chapters")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(parse_chapter)
                .collect::<Vec<LeafChapter>>()
        })
        .unwrap_or_default();
    let chapters = normalize_chapters(&title, duration_seconds, chapters);

    Ok(LeafProbe {
        title,
        webpage_url,
        extractor_key,
        album,
        duration_seconds,
        chapters,
    })
}

pub fn parse_progress_line(line: &str) -> Option<DownloadProgress> {
    let payload = line.strip_prefix("progress:")?;
    let parts = payload.split('|').collect::<Vec<_>>();
    if parts.len() != 5 {
        return None;
    }

    Some(DownloadProgress {
        downloaded_bytes: parse_optional_u64(parts[0]),
        total_bytes: parse_optional_u64(parts[1]),
        speed_bytes_per_second: parse_optional_u64(parts[2]),
        eta_seconds: parse_optional_u64(parts[3]),
        phase: parse_optional_string(parts[4]),
    })
}

fn parse_chapter(value: &Value) -> Option<LeafChapter> {
    let title = read_optional_string(value, "title")?;
    let start_ms = value
        .get("start_time")
        .and_then(parse_number_like)
        .map(seconds_to_millis)?;
    let end_ms = value
        .get("end_time")
        .and_then(parse_number_like)
        .map(seconds_to_millis)?;
    if end_ms <= start_ms {
        return None;
    }

    Some(LeafChapter {
        title,
        start_ms,
        end_ms,
    })
}

fn normalize_chapters(
    video_title: &str,
    duration_seconds: Option<u32>,
    mut chapters: Vec<LeafChapter>,
) -> Vec<LeafChapter> {
    if chapters.len() != 1 {
        return chapters;
    }

    let chapter = chapters.pop().expect("single chapter should exist");
    let covers_full_duration = duration_seconds.is_some_and(|duration| {
        chapter.start_ms == 0 && chapter.end_ms >= duration.saturating_sub(1).saturating_mul(1_000)
    });
    let repeats_video_title = chapter
        .title
        .trim()
        .eq_ignore_ascii_case(video_title.trim());

    if covers_full_duration
        || duration_seconds.is_none() && repeats_video_title && chapter.start_ms == 0
    {
        return vec![];
    }

    vec![chapter]
}

fn resolve_leaf_reference_url(entry: &Value, input_url: &str, entry_type: &str) -> Option<String> {
    if let Some(url) = read_optional_string(entry, "webpage_url") {
        return Some(url);
    }

    if let Some(url) = read_optional_string(entry, "original_url") {
        return Some(url);
    }

    let raw_url = read_optional_string(entry, "url")?;
    if raw_url.starts_with("http://") || raw_url.starts_with("https://") {
        return Some(raw_url);
    }

    if matches!(entry_type, "playlist" | "multi_video") && looks_like_youtube_root(input_url) {
        return Some(format!("https://www.youtube.com/playlist?list={raw_url}"));
    }

    if looks_like_youtube_root(input_url) {
        return Some(format!("https://www.youtube.com/watch?v={raw_url}"));
    }

    Some(raw_url)
}

fn looks_like_youtube_root(url: &str) -> bool {
    Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .map(|host| host.eq_ignore_ascii_case("youtu.be") || host.ends_with("youtube.com"))
        .unwrap_or(false)
}

pub(crate) fn is_youtube_mix_playlist_id(list_id: &str) -> bool {
    list_id.to_ascii_uppercase().starts_with("RD")
}

fn read_required_string(value: &Value, key: &str) -> Result<String> {
    read_optional_string(value, key).with_context(|| format!("yt-dlp metadata is missing {key}"))
}

fn read_optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn parse_number_like(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    }
}

fn seconds_to_millis(seconds: f64) -> u32 {
    if !seconds.is_finite() || seconds <= 0.0 {
        return 0;
    }

    (seconds * 1_000.0).round().min(u32::MAX as f64) as u32
}

fn parse_optional_u64(value: &str) -> Option<u64> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("na") {
        return None;
    }

    trimmed
        .parse::<f64>()
        .ok()
        .map(|value| value.round() as u64)
}

fn parse_optional_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("na") {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn spawn_line_reader(
    reader: impl std::io::Read + Send + 'static,
    sender: mpsc::Sender<String>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = sender.send(line);
        }
    })
}

pub(crate) fn resolve_downloaded_file(
    target_dir: &Path,
    file_stem: &str,
    reported_path: Option<&Path>,
) -> Option<PathBuf> {
    reported_path
        .filter(|path| path.is_file())
        .map(Path::to_path_buf)
        .or_else(|| find_downloaded_file(target_dir, file_stem))
}

fn find_downloaded_file(target_dir: &Path, file_stem: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(target_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let stem = path.file_stem().and_then(|value| value.to_str());
        if stem == Some(file_stem) {
            return Some(path);
        }
    }

    None
}
