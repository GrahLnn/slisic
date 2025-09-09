use anyhow::Result;
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

pub fn bin_dir(app: &tauri::AppHandle) -> tauri::Result<PathBuf> {
    let dir = app.path().app_local_data_dir()?.join("bin");
    fs::create_dir_all(&dir)?;
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

const UA: &str = "tauri-app/1.0 (+tauri)";

pub async fn http() -> reqwest::Result<reqwest::Client> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(UA));
    // 禁用压缩
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));

    reqwest::Client::builder()
        .default_headers(headers)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .redirect(redirect::Policy::limited(10))
        .build()
}

#[tauri::command]
#[specta::specta]
pub fn exists(path: String) -> Result<bool, String> {
    Ok(PathBuf::from(path).exists())
}

#[tauri::command]
#[specta::specta]
pub fn all_audio<P: AsRef<Path>>(folder: P) -> Result<Vec<PathBuf>> {
    let iter = fs::read_dir(folder)?
        .filter_map(|res| res.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| is_audio(p));

    let mut files: Vec<PathBuf> = iter.collect();
    files.sort_unstable(); // 可选：稳定输出顺序
    Ok(files)
}

#[tauri::command]
#[specta::specta]
pub fn all_audio_recursive(folder: String) -> Result<Vec<PathBuf>, String> {
    let folder = PathBuf::from(folder);
    let mut files = Vec::new();
    for entry in WalkDir::new(folder)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        let p = entry.path();
        if p.is_file() && is_audio(p) {
            files.push(p.to_path_buf());
        }
    }
    files.sort_unstable();
    Ok(files)
}

const AUDIO_EXTS: &[&str] = &[
    "mp3", "flac", "wav", "aac", "m4a", "ogg", "opus", "aiff", "webm",
];

fn is_audio(p: &Path) -> bool {
    p.extension()
        .and_then(|s| s.to_str())
        .map(|ext| AUDIO_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}
