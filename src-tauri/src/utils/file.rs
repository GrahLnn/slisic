use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, USER_AGENT},
    redirect,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use tauri::Manager;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct InstallResult {
    pub installed_path: PathBuf,
    pub installed_version: String,
}

const AUDIO_EXTS: &[&str] = &[
    "mp3", "flac", "wav", "aac", "m4a", "ogg", "opus", "aiff", "webm", "mp4",
];

pub fn bin_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("bin");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(unix)]
pub fn make_executable(p: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perm = fs::metadata(p)?.permissions();
    perm.set_mode(0o755);
    fs::set_permissions(p, perm)
}

#[cfg(not(unix))]
pub fn make_executable(_p: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn remove_quarantine(p: &Path) {
    if let Some(s) = p.to_str() {
        let _ = std::process::Command::new("xattr")
            .args(["-dr", "com.apple.quarantine", s])
            .status();
    }
}

#[cfg(not(target_os = "macos"))]
pub fn remove_quarantine(_p: &Path) {}

pub fn is_audio_path(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|ext| {
            AUDIO_EXTS
                .iter()
                .any(|candidate| ext.eq_ignore_ascii_case(candidate))
        })
        .unwrap_or(false)
}

pub fn all_audio_recursive_inner(folder: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for entry in WalkDir::new(folder)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path.is_file() && is_audio_path(path) {
            files.push(path.to_path_buf());
        }
    }
    files.sort_unstable();
    Ok(files)
}

#[tauri::command]
#[specta::specta]
pub fn exists(path: String) -> Result<bool, String> {
    Ok(PathBuf::from(path).exists())
}

#[tauri::command]
#[specta::specta]
pub fn all_audio_recursive(folder: String) -> Result<Vec<PathBuf>, String> {
    all_audio_recursive_inner(Path::new(&folder))
}

const UA: &str = "ransic/1.0 (+tauri)";

pub async fn http() -> Result<reqwest::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(UA));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));

    reqwest::Client::builder()
        .default_headers(headers)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .redirect(redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())
}
