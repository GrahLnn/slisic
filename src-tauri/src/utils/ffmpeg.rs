use crate::utils::file::{bin_dir, http, make_executable, remove_quarantine, InstallResult};
use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::Manager;
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const FF_API_LATEST: &str = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";
const FF_DL_BASE: &str = "https://xget.r2g2.org/gh/BtbN/FFmpeg-Builds/releases/latest/download";

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct FfCheck {
    pub installed_path: Option<PathBuf>,
    pub latest_tag: Option<String>,
    pub needs_install: bool,
    pub asset_name: Option<String>,
    pub download_url: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone)]
struct AssetSpec {
    asset_name: Option<&'static str>,
    direct_url: Option<&'static str>,
}

fn select_asset() -> Option<AssetSpec> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    match (os, arch) {
        ("windows", "x86") | ("windows", "x86_64") | ("windows", "aarch64") => Some(AssetSpec {
            asset_name: Some("ffmpeg-master-latest-win64-gpl.zip"),
            direct_url: None,
        }),
        ("linux", "x86_64") => Some(AssetSpec {
            asset_name: Some("ffmpeg-master-latest-linux64-gpl.tar.xz"),
            direct_url: None,
        }),
        ("linux", "aarch64") => Some(AssetSpec {
            asset_name: Some("ffmpeg-master-latest-linuxarm64-gpl.tar.xz"),
            direct_url: None,
        }),
        ("macos", "aarch64") => Some(AssetSpec {
            asset_name: None,
            direct_url: Some(
                "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/snapshot/ffmpeg.zip",
            ),
        }),
        ("macos", "x86_64") => Some(AssetSpec {
            asset_name: None,
            direct_url: Some("https://evermeet.cx/ffmpeg/get/zip"),
        }),
        _ => None,
    }
}

fn local_ffmpeg_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let install_name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    Ok(bin_dir(app)?.join(install_name))
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

fn system_ffmpeg_path() -> Option<PathBuf> {
    if cfg!(windows) {
        find_in_path("ffmpeg.exe")
    } else {
        find_in_path("ffmpeg")
    }
}

async fn run_version(path: &Path) -> Result<String, String> {
    let mut cmd = Command::new(path);
    cmd.arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }

    let first_line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("ffmpeg version unknown")
        .to_string();
    let version = first_line
        .split_whitespace()
        .nth(2)
        .unwrap_or("unknown")
        .to_string();
    Ok(version)
}

pub fn ensure_ffmpeg(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let local = local_ffmpeg_path(app)?;
    if local.exists() {
        return Ok(local);
    }

    if let Some(system) = system_ffmpeg_path() {
        return Ok(system);
    }

    Err("ffmpeg not found".to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn ffmpeg_check_exists(app: tauri::AppHandle) -> Result<Option<InstallResult>, String> {
    let path = match ensure_ffmpeg(&app) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };

    let version = run_version(&path).await.ok();
    if let Some(installed_version) = version {
        Ok(Some(InstallResult {
            installed_path: path,
            installed_version,
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
#[specta::specta]
pub async fn ffmpeg_check_update(app: tauri::AppHandle) -> Result<FfCheck, String> {
    let installed = ffmpeg_check_exists(app.clone()).await?;

    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
    }

    let latest_tag = http()
        .await?
        .get(FF_API_LATEST)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Release>()
        .await
        .map_err(|e| e.to_string())
        .ok()
        .map(|r| r.tag_name);

    let spec = select_asset();
    let download_url = spec.as_ref().and_then(|asset| {
        if let Some(url) = asset.direct_url {
            Some(url.to_string())
        } else {
            asset.asset_name.map(|name| format!("{FF_DL_BASE}/{name}"))
        }
    });

    Ok(FfCheck {
        installed_path: installed.as_ref().map(|v| v.installed_path.clone()),
        latest_tag,
        needs_install: installed.is_none(),
        asset_name: spec
            .as_ref()
            .and_then(|asset| asset.asset_name.map(|s| s.to_string())),
        download_url,
        note: if spec.is_none() {
            Some("current platform is not bundled; use system package manager".to_string())
        } else {
            None
        },
    })
}

#[tauri::command]
#[specta::specta]
pub async fn ffmpeg_download_and_install(app: tauri::AppHandle) -> Result<InstallResult, String> {
    let spec = select_asset().ok_or_else(|| {
        "current platform is not bundled; install ffmpeg from your system package manager"
            .to_string()
    })?;

    let url = if let Some(direct) = spec.direct_url {
        direct.to_string()
    } else if let Some(asset) = spec.asset_name {
        format!("{FF_DL_BASE}/{asset}")
    } else {
        return Err("no download source for ffmpeg".to_string());
    };

    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let archive_name = spec
        .asset_name
        .map(|s| s.to_string())
        .or_else(|| {
            Path::new(&url)
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "ffmpeg_download".to_string());

    let archive = cache_dir.join(format!("{}.tmp", archive_name));
    let bytes = http()
        .await?
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    fs::write(&archive, &bytes).map_err(|e| e.to_string())?;

    let dest = local_ffmpeg_path(&app)?;
    if dest.exists() {
        let _ = fs::remove_file(&dest);
    }

    extract_and_place_ffmpeg(&archive, &dest)?;
    make_executable(&dest).map_err(|e| e.to_string())?;
    remove_quarantine(&dest);

    let installed_version = run_version(&dest)
        .await
        .unwrap_or_else(|_| "unknown".to_string());

    Ok(InstallResult {
        installed_path: dest,
        installed_version,
    })
}

fn extract_and_place_ffmpeg(archive: &Path, dest_exec: &Path) -> Result<(), String> {
    let tmpdir = archive.with_extension("unpack");
    if tmpdir.exists() {
        let _ = fs::remove_dir_all(&tmpdir);
    }
    fs::create_dir_all(&tmpdir).map_err(|e| e.to_string())?;

    let name = archive.file_name().and_then(|s| s.to_str()).unwrap_or("");

    if name.ends_with(".zip") {
        unpack_zip(archive, &tmpdir)?;
    } else if name.ends_with(".tar.xz") || name.ends_with(".txz") {
        unpack_tar_xz(archive, &tmpdir)?;
    } else {
        // Some sources provide a raw binary. Try direct copy first.
        if let Some(parent) = dest_exec.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(archive, dest_exec).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(archive);
        return Ok(());
    }

    let wanted = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let found = find_file_recursive(&tmpdir, wanted)
        .ok_or_else(|| "ffmpeg executable not found in archive".to_string())?;

    if let Some(parent) = dest_exec.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(found, dest_exec).map_err(|e| e.to_string())?;

    let _ = fs::remove_dir_all(&tmpdir);
    let _ = fs::remove_file(archive);
    Ok(())
}

fn find_file_recursive(dir: &Path, file_name: &str) -> Option<PathBuf> {
    for entry in walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|s| s.to_str()) == Some(file_name) {
            return Some(path.to_path_buf());
        }
    }
    None
}

fn unpack_zip(archive: &Path, tmpdir: &Path) -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let file = fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        for i in 0..archive.len() {
            let mut src = archive.by_index(i).map_err(|e| e.to_string())?;
            let output = tmpdir.join(src.mangled_name());
            if src.is_dir() {
                fs::create_dir_all(&output).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = output.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut dest = fs::File::create(&output).map_err(|e| e.to_string())?;
                std::io::copy(&mut src, &mut dest).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = archive;
        let _ = tmpdir;
        Err("zip extraction is not supported on this platform build".to_string())
    }
}

fn unpack_tar_xz(archive: &Path, tmpdir: &Path) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let file = fs::File::open(archive).map_err(|e| e.to_string())?;
        let decoder = xz2::read::XzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        archive.unpack(tmpdir).map_err(|e| e.to_string())
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = archive;
        let _ = tmpdir;
        Err("tar.xz extraction is not supported on this platform build".to_string())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn ffmpeg_version(app: tauri::AppHandle) -> Result<String, String> {
    let path = ensure_ffmpeg(&app)?;
    let mut cmd = Command::new(path);
    cmd.arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .take(3)
        .collect::<Vec<_>>()
        .join("\n"))
}

#[allow(dead_code)]
pub async fn integrated_lufs<P: AsRef<Path>>(
    app: &tauri::AppHandle,
    path: P,
) -> Result<f64, String> {
    let ffmpeg = ensure_ffmpeg(app)?;
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-nostats")
        .arg("-i")
        .arg(path.as_ref())
        .arg("-filter:a")
        .arg("ebur128=peak=true")
        .arg("-f")
        .arg("null")
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().await.map_err(|e| e.to_string())?;
    let log = String::from_utf8_lossy(&output.stderr);
    let summary = log.split("Summary:").nth(1).unwrap_or(&log);
    let re = Regex::new(r"(?m)^\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS\s*$").map_err(|e| e.to_string())?;

    let Some(captures) = re.captures(summary) else {
        return Err("integrated LUFS not found".to_string());
    };

    captures[1].parse::<f64>().map_err(|e| e.to_string())
}
