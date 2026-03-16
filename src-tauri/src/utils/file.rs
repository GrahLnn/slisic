use crate::domain::music::types::{sanitize_name, EntryType};
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

pub const ENTRY_METADATA_FILE_NAME: &str = ".slisic-entry.json";

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq)]
pub struct EntryMetadata {
    pub url: String,
    pub entry_type: EntryType,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq)]
pub struct ImportFolderEntry {
    pub path: String,
    pub items: Vec<String>,
    pub url: Option<String>,
    pub entry_type: EntryType,
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

pub fn entry_metadata_path(folder: &Path) -> PathBuf {
    folder.join(ENTRY_METADATA_FILE_NAME)
}

pub fn write_entry_metadata(folder: &Path, metadata: &EntryMetadata) -> Result<(), String> {
    fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(metadata).map_err(|e| e.to_string())?;
    fs::write(entry_metadata_path(folder), json).map_err(|e| e.to_string())
}

pub fn read_entry_metadata(folder: &Path) -> Result<Option<EntryMetadata>, String> {
    let path = entry_metadata_path(folder);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let metadata = serde_json::from_slice::<EntryMetadata>(&bytes).map_err(|e| e.to_string())?;
    Ok(Some(metadata))
}

fn folder_entry_name(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(sanitize_name)
        .unwrap_or_else(|| sanitize_name(&path.to_string_lossy()))
}

fn collect_import_entry(
    folder: &Path,
    metadata: Option<EntryMetadata>,
) -> Result<Option<ImportFolderEntry>, String> {
    let items = all_audio_recursive_inner(folder)?
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    if items.is_empty() {
        return Ok(None);
    }

    let (url, entry_type) = match metadata {
        Some(metadata) => (Some(metadata.url), metadata.entry_type),
        None => (None, EntryType::Local),
    };

    Ok(Some(ImportFolderEntry {
        path: folder.to_string_lossy().to_string(),
        items,
        url,
        entry_type,
    }))
}

pub fn collect_import_folder_entries_inner(
    folder: &Path,
) -> Result<Vec<ImportFolderEntry>, String> {
    if let Some(metadata) = read_entry_metadata(folder)? {
        return Ok(collect_import_entry(folder, Some(metadata))?
            .into_iter()
            .collect());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let metadata = read_entry_metadata(&path)?;
        if metadata.is_none() {
            continue;
        }

        if let Some(import_entry) = collect_import_entry(&path, metadata)? {
            entries.push(import_entry);
        }
    }

    if !entries.is_empty() {
        entries.sort_by(|a, b| {
            folder_entry_name(Path::new(&a.path)).cmp(&folder_entry_name(Path::new(&b.path)))
        });
        return Ok(entries);
    }

    Ok(collect_import_entry(folder, None)?.into_iter().collect())
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

#[tauri::command]
#[specta::specta]
pub fn collect_import_folder_entries(folder: String) -> Result<Vec<ImportFolderEntry>, String> {
    collect_import_folder_entries_inner(Path::new(&folder))
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
