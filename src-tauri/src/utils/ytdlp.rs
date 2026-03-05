use crate::domain::music::types::{
    default_music, recompute_entry_avg, sanitize_name, Entry, EntryType, Music,
};
use crate::utils::config::resolve_save_path;
use crate::utils::file::{
    all_audio_recursive_inner, bin_dir, http, make_executable, remove_quarantine, InstallResult,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::Manager;
use tauri_specta::Event;
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const GH_API_LATEST: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const GH_DL_BASE: &str = "https://xget.r2g2.org/gh/yt-dlp/yt-dlp/releases/latest/download";
const GH_SUMS: &str =
    "https://xget.r2g2.org/gh/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
struct AssetSpec {
    asset_name: &'static str,
    install_name: &'static str,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct CheckResult {
    pub installed_path: Option<PathBuf>,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub needs_update: bool,
    pub asset_name: String,
    pub download_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct MediaInfo {
    pub title: String,
    pub item_type: String,
    pub entries_count: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq, Event)]
pub struct ProcessResult {
    pub working_path: String,
    pub saved_path: String,
    pub name: String,
    pub playlist: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq, Event)]
pub struct YtdlpVersionChanged {
    pub str: String,
}

#[derive(Debug, Clone)]
pub struct DownloadOutcome {
    pub entry: Entry,
    pub working_path: PathBuf,
    pub saved_path: PathBuf,
    pub name: String,
}

fn select_asset() -> AssetSpec {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86") => AssetSpec {
            asset_name: "yt-dlp_x86.exe",
            install_name: "yt-dlp.exe",
        },
        ("windows", _) => AssetSpec {
            asset_name: "yt-dlp.exe",
            install_name: "yt-dlp.exe",
        },
        ("linux", "aarch64") => AssetSpec {
            asset_name: "yt-dlp_linux_aarch64",
            install_name: "yt-dlp",
        },
        ("linux", "arm") | ("linux", "armv7") => AssetSpec {
            asset_name: "yt-dlp_linux_armv7l",
            install_name: "yt-dlp",
        },
        ("linux", _) => AssetSpec {
            asset_name: "yt-dlp_linux",
            install_name: "yt-dlp",
        },
        ("macos", _) => AssetSpec {
            asset_name: "yt-dlp_macos",
            install_name: "yt-dlp",
        },
        _ => AssetSpec {
            asset_name: "yt-dlp",
            install_name: "yt-dlp",
        },
    }
}

fn installed_bin_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let spec = select_asset();
    Ok(bin_dir(app)?.join(spec.install_name))
}

fn version_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(bin_dir(app)?.join("yt-dlp.version.json"))
}

fn find_in_path(file_name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(file_name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn system_ytdlp_path() -> Option<PathBuf> {
    if cfg!(windows) {
        find_in_path("yt-dlp.exe")
    } else {
        find_in_path("yt-dlp")
    }
}

async fn ytdlp_version_from_exec(exec: &Path) -> Option<String> {
    let mut cmd = Command::new(exec);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }

    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

fn read_installed_version_file(app: &tauri::AppHandle) -> Option<String> {
    let file = version_file(app).ok()?;
    let data = fs::read_to_string(file).ok()?;
    serde_json::from_str::<serde_json::Value>(&data)
        .ok()?
        .get("version")?
        .as_str()
        .map(|s| s.to_string())
}

fn write_installed_version_file(app: &tauri::AppHandle, version: &str) -> Result<(), String> {
    let file = version_file(app)?;
    let value = serde_json::json!({ "version": version });
    let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(file, bytes).map_err(|e| e.to_string())
}

fn parse_sha256(sums: &str, asset: &str) -> Option<String> {
    for line in sums.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.ends_with(asset) {
            if let Some((hash, _)) = line.split_once(char::is_whitespace) {
                let hash = hash.trim();
                if hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Some(hash.to_lowercase());
                }
            }
        }
    }
    None
}

fn newer(latest: &str, current: &str) -> bool {
    fn to_num(v: &str) -> Option<i32> {
        let parts: Vec<_> = v.trim_matches('v').split('.').collect();
        if parts.len() == 3 {
            let a = parts[0].parse::<i32>().ok()?;
            let b = parts[1].parse::<i32>().ok()?;
            let c = parts[2].parse::<i32>().ok()?;
            Some(a * 10000 + b * 100 + c)
        } else {
            None
        }
    }

    match (to_num(latest), to_num(current)) {
        (Some(a), Some(b)) => a > b,
        _ => latest > current,
    }
}

async fn fetch_latest_version() -> Result<String, String> {
    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
    }

    let release = http()
        .await?
        .get(GH_API_LATEST)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Release>()
        .await
        .map_err(|e| e.to_string())?;

    Ok(release.tag_name)
}

async fn fetch_sums() -> Result<String, String> {
    http()
        .await?
        .get(GH_SUMS)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())
}

async fn download_with_optional_sha256(
    url: &str,
    expect_sha256: Option<&str>,
    dest: &Path,
) -> Result<(), String> {
    let response = http()
        .await?
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;

    if let Some(expect) = expect_sha256 {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let got = hex::encode(hasher.finalize());
        if got != expect.to_lowercase() {
            return Err(format!("sha256 mismatch, expected {}, got {}", expect, got));
        }
    }

    fs::write(dest, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn github_ok() -> bool {
    let Ok(client) = http().await else {
        return false;
    };
    client.head(GH_SUMS).send().await.ok().is_some()
        || client
            .head("https://github.com")
            .send()
            .await
            .ok()
            .is_some()
}

#[tauri::command]
#[specta::specta]
pub async fn check_exists(app: tauri::AppHandle) -> Result<Option<InstallResult>, String> {
    let local = installed_bin_path(&app)?;
    if local.exists() {
        let version = ytdlp_version_from_exec(&local)
            .await
            .or_else(|| read_installed_version_file(&app))
            .unwrap_or_else(|| "unknown".to_string());
        return Ok(Some(InstallResult {
            installed_path: local,
            installed_version: version,
        }));
    }

    if let Some(system) = system_ytdlp_path() {
        let version = ytdlp_version_from_exec(&system)
            .await
            .unwrap_or_else(|| "unknown".to_string());
        return Ok(Some(InstallResult {
            installed_path: system,
            installed_version: version,
        }));
    }

    Ok(None)
}

#[tauri::command]
#[specta::specta]
pub async fn ytdlp_check_update(app: tauri::AppHandle) -> Result<CheckResult, String> {
    let spec = select_asset();
    let url = format!("{GH_DL_BASE}/{}", spec.asset_name);

    let installed = check_exists(app.clone()).await?;
    let installed_path = installed.as_ref().map(|r| r.installed_path.clone());
    let installed_version = installed
        .as_ref()
        .map(|r| r.installed_version.clone())
        .or_else(|| read_installed_version_file(&app));

    let latest_version = fetch_latest_version().await.ok();

    let needs_update = match (&installed_version, &latest_version) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(cur), Some(lat)) => newer(lat, cur),
    };

    Ok(CheckResult {
        installed_path,
        installed_version,
        latest_version,
        needs_update,
        asset_name: spec.asset_name.to_string(),
        download_url: url,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn ytdlp_download_and_install(app: tauri::AppHandle) -> Result<InstallResult, String> {
    let spec = select_asset();
    let url = format!("{GH_DL_BASE}/{}", spec.asset_name);

    let sums = fetch_sums().await.ok();
    let checksum = sums
        .as_ref()
        .and_then(|value| parse_sha256(value, spec.asset_name));

    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let tmp = cache_dir.join(format!("{}.tmp", spec.install_name));
    download_with_optional_sha256(&url, checksum.as_deref(), &tmp).await?;

    make_executable(&tmp).map_err(|e| e.to_string())?;
    remove_quarantine(&tmp);

    let final_path = installed_bin_path(&app)?;
    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if final_path.exists() {
        let _ = fs::remove_file(&final_path);
    }
    fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;

    let fallback_latest = fetch_latest_version().await.ok();
    let installed_version = ytdlp_version_from_exec(&final_path)
        .await
        .or(fallback_latest)
        .unwrap_or_else(|| "unknown".to_string());

    write_installed_version_file(&app, &installed_version)?;

    Ok(InstallResult {
        installed_path: final_path,
        installed_version,
    })
}

fn choose_ytdlp_exec(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let local = installed_bin_path(app)?;
    if local.exists() {
        return Ok(local);
    }
    if let Some(system) = system_ytdlp_path() {
        return Ok(system);
    }
    Err("yt-dlp not found".to_string())
}

async fn flat_data(app: &tauri::AppHandle, url: &str) -> Result<serde_json::Value, String> {
    let exec = choose_ytdlp_exec(app)?;

    let mut cmd = Command::new(exec);
    cmd.arg("-J")
        .arg("--skip-download")
        .arg("--flat-playlist")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(stderr);
    }

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    serde_json::from_str(&stdout).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn look_media(app: tauri::AppHandle, url: String) -> Result<MediaInfo, String> {
    let json = flat_data(&app, &url).await?;
    let title = json
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("Unknown")
        .to_string();

    let item_type = json
        .get("_type")
        .and_then(|value| value.as_str())
        .unwrap_or("video")
        .to_string();

    let entries_count = if item_type == "playlist" {
        json.get("entries")
            .and_then(|value| value.as_array())
            .map(|arr| arr.len() as u32)
    } else {
        None
    };

    Ok(MediaInfo {
        title,
        item_type,
        entries_count,
    })
}

pub async fn download_entry_for_library(
    app: tauri::AppHandle,
    playlist_name: &str,
    entry: &Entry,
) -> Result<DownloadOutcome, String> {
    let url = entry
        .url
        .clone()
        .ok_or_else(|| "entry url is empty".to_string())?;

    let exec = match choose_ytdlp_exec(&app) {
        Ok(exec) => exec,
        Err(_) => {
            ytdlp_download_and_install(app.clone()).await?;
            choose_ytdlp_exec(&app)?
        }
    };

    let base = resolve_save_path(app.clone())?;
    let playlist_folder = base.join(sanitize_name(playlist_name));
    let entry_name = if entry.name.trim().is_empty() {
        sanitize_name(&url)
    } else {
        sanitize_name(&entry.name)
    };
    let working_dir = playlist_folder.join(&entry_name);

    fs::create_dir_all(&working_dir).map_err(|e| e.to_string())?;

    let output_template = working_dir.join("%(title)s.%(ext)s");
    let mut cmd = Command::new(exec);
    cmd.env("PYTHONIOENCODING", "utf-8")
        .arg("--ignore-errors")
        .arg("--windows-filenames")
        .arg("-f")
        .arg("bestaudio")
        .arg("--extract-audio")
        .arg("--audio-format")
        .arg("mp3")
        .arg("--audio-quality")
        .arg("0")
        .arg("--continue")
        .arg("--no-overwrites")
        .arg("--yes-playlist")
        .arg("-o")
        .arg(output_template)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let last_error = stderr
            .lines()
            .rev()
            .find(|line| line.contains("ERROR:"))
            .map(|line| line.replace("ERROR: ", ""))
            .unwrap_or(stderr);
        return Err(last_error);
    }

    let files = all_audio_recursive_inner(&working_dir)?;
    let existing = entry
        .musics
        .iter()
        .map(|music| (music.path.clone(), music.clone()))
        .collect::<HashMap<String, Music>>();

    let mut musics = Vec::new();
    for path in files {
        let path_str = path.to_string_lossy().to_string();
        if let Some(music) = existing.get(&path_str) {
            musics.push(music.clone());
        } else {
            musics.push(default_music(path_str));
        }
    }
    let downloaded_count = musics.len();

    let mut updated_entry = Entry {
        path: Some(working_dir.to_string_lossy().to_string()),
        name: entry_name.clone(),
        musics,
        avg_db: None,
        url: entry.url.clone(),
        downloaded_ok: Some(false),
        tracking: entry.tracking.or(Some(false)),
        entry_type: if entry.entry_type == EntryType::Unknown {
            if downloaded_count > 1 {
                EntryType::WebList
            } else {
                EntryType::WebVideo
            }
        } else {
            entry.entry_type.clone()
        },
    };
    recompute_entry_avg(&mut updated_entry);
    updated_entry.downloaded_ok = Some(!updated_entry.musics.is_empty());

    let saved_path = if updated_entry.musics.len() == 1 {
        PathBuf::from(updated_entry.musics[0].path.clone())
    } else {
        working_dir.clone()
    };

    Ok(DownloadOutcome {
        entry: updated_entry,
        working_path: working_dir.clone(),
        saved_path,
        name: entry_name,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn test_download_audio(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let sample_url = "https://x.com/i/status/1958162017573020003";
    let entry = Entry {
        path: None,
        name: "test".to_string(),
        musics: Vec::new(),
        avg_db: None,
        url: Some(sample_url.to_string()),
        downloaded_ok: Some(false),
        tracking: Some(false),
        entry_type: EntryType::WebVideo,
    };

    let outcome = download_entry_for_library(app, "test", &entry).await?;
    Ok(outcome
        .entry
        .musics
        .into_iter()
        .map(|music| music.path)
        .collect())
}

pub fn spawn_ytdlp_auto_update(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let check = ytdlp_check_update(app.clone()).await;
        if let Ok(check) = check {
            if check.needs_update {
                if let Ok(installed) = ytdlp_download_and_install(app.clone()).await {
                    YtdlpVersionChanged {
                        str: installed.installed_version,
                    }
                    .emit(&app)
                    .ok();
                }
            }
        }
    });
}
