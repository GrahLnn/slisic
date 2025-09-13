use anyhow::Result;
use reqwest::header::ACCEPT;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Stdio,
};

use anyhow::Context;
use regex::Regex;
use tauri::Manager;
use tokio::process::Command;

use crate::utils::file::{bin_dir, http, make_executable, remove_quarantine, InstallResult};
// ========= FFmpeg 下载与安装 =========

const FF_API_LATEST: &str = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";
const FF_DL_BASE: &str = "https://xget.grahlnn.com/gh/BtbN/FFmpeg-Builds/releases/latest/download";
const FF_SUMS: &str =
    "https://xget.grahlnn.com/gh/BtbN/FFmpeg-Builds/releases/latest/download/sha256sums.txt";

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
struct FfAssetSpec {
    asset_name: &'static str,   // 压缩包名
    install_name: &'static str, // bin 下落地名：ffmpeg 或 ffmpeg.exe
}

#[derive(Clone, Copy)]
pub struct FlacOpts {
    pub compression_level: u8, // 0..12，12 最省空间但最慢
    pub keep_source: bool,     // 转码后是否保留源文件
    pub copy_metadata: bool,   // 是否复制源文件元数据
}

// 选择平台对应的 FFmpeg 构建（BtbN 命名规范）
fn ffmpeg_select_asset() -> Option<FfAssetSpec> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    match (os, arch) {
        // Windows
        ("windows", "x86_64") | ("windows", "x86") | ("windows", "aarch64") => Some(FfAssetSpec {
            asset_name: "ffmpeg-master-latest-win64-gpl.zip", // BtbN 主要分发 win64
            install_name: "ffmpeg.exe",
        }),
        // Linux x86_64
        ("linux", "x86_64") => Some(FfAssetSpec {
            asset_name: "ffmpeg-master-latest-linux64-gpl.tar.xz",
            install_name: "ffmpeg",
        }),
        // Linux aarch64
        ("linux", "aarch64") => Some(FfAssetSpec {
            asset_name: "ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
            install_name: "ffmpeg",
        }),
        // Linux armhf (armv7)
        ("linux", "arm") | ("linux", "armv7") => Some(FfAssetSpec {
            asset_name: "ffmpeg-master-latest-linuxarmhf-gpl.tar.xz",
            install_name: "ffmpeg",
        }),
        // macOS：建议 Homebrew；如需内置下载，你可以换成第三方构建源
        ("macos", _) => None,
        _ => None,
    }
}

pub fn ensure_ffmpeg(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(bin_dir(app)?.join(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }))
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct FfCheck {
    pub installed_path: Option<PathBuf>,
    pub latest_tag: Option<String>,
    pub needs_install: bool,
    pub asset_name: Option<String>,
    pub download_url: Option<String>,
    pub note: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn ffmpeg_check_update(app: tauri::AppHandle) -> Result<FfCheck, String> {
    // macOS 直说：用 brew
    if std::env::consts::OS == "macos" {
        return Ok(FfCheck {
            installed_path: ensure_ffmpeg(&app).ok().filter(|p| p.exists()),
            latest_tag: None,
            needs_install: ensure_ffmpeg(&app)
                .ok()
                .map(|p| !p.exists())
                .unwrap_or(true),
            asset_name: None,
            download_url: None,
            note: Some("建议使用 Homebrew 安装: brew install ffmpeg".into()),
        });
    }

    let spec = match ffmpeg_select_asset() {
        Some(s) => s,
        None => {
            return Ok(FfCheck {
                installed_path: None,
                latest_tag: None,
                needs_install: true,
                asset_name: None,
                download_url: None,
                note: Some("当前平台未内置 FFmpeg 构建，请改用系统包管理器或自备二进制".into()),
            })
        }
    };

    // 获取最新 tag（可选）
    #[derive(Deserialize)]
    struct R {
        tag_name: String,
    }
    let latest_tag = http()
        .await
        .map_err(|e| e.to_string())?
        .get(FF_API_LATEST)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<R>()
        .await
        .map_err(|e| e.to_string())
        .ok()
        .map(|r| r.tag_name);

    let installed = ensure_ffmpeg(&app).ok().filter(|p| p.exists());
    Ok(FfCheck {
        installed_path: installed.clone(),
        latest_tag,
        needs_install: installed.is_none(),
        asset_name: Some(spec.asset_name.into()),
        download_url: Some(format!("{FF_DL_BASE}/{}", spec.asset_name)),
        note: None,
    })
}

// 从 BtbN 的 sha256sums.txt 里找目标资产的哈希（兼容两种格式）
async fn ffmpeg_fetch_sum(asset: &str) -> Result<Option<String>, String> {
    let txt = http()
        .await
        .map_err(|e| e.to_string())?
        .get(FF_SUMS)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let mut found = None;
    for line in txt.lines() {
        let s = line.trim();
        if s.is_empty() {
            continue;
        }
        // 常见格式1: "<hash>  <filename>"
        if let Some((h, f)) = s.split_once("  ") {
            if f.ends_with(asset) && h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()) {
                found = Some(h.to_lowercase());
                break;
            }
        }
        // 常见格式2: "SHA256 (filename) = hash"
        if s.contains("( ") && s.contains(" ) = ") {
            // 粗糙解析
            if let Some(pos) = s.rfind(" = ") {
                let (left, h) = s.split_at(pos);
                let h = h.trim_start_matches(" = ").trim();
                if left.contains(asset) && h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())
                {
                    found = Some(h.to_lowercase());
                    break;
                }
            }
        }
    }
    Ok(found)
}

#[tauri::command]
#[specta::specta]
pub async fn ffmpeg_download_and_install(app: tauri::AppHandle) -> Result<InstallResult, String> {
    // macOS 简单提示
    if std::env::consts::OS == "macos" {
        return Err(
            "macOS 建议用 Homebrew 安装：brew install ffmpeg（如需内置包，请换成你信任的二进制源）"
                .into(),
        );
    }

    let spec = ffmpeg_select_asset().ok_or("当前平台未内置 FFmpeg 构建映射")?;
    let url = format!("{FF_DL_BASE}/{}", spec.asset_name);

    // 取校验（可选，如果拿不到就跳过校验）
    let expect = ffmpeg_fetch_sum(spec.asset_name).await.ok().flatten();

    // 下载到缓存
    let tmp = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(format!("{}.tmp", spec.asset_name));
    {
        let cli = http().await.map_err(|e| e.to_string())?;
        let resp = cli
            .get(&url)
            .header(ACCEPT, "application/octet-stream")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        resp.error_for_status_ref().map_err(|e| e.to_string())?;
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        if let Some(exp) = expect {
            let got = {
                use sha2::{Digest, Sha256};
                let mut h = Sha256::new();
                h.update(&bytes);
                hex::encode(h.finalize())
            };
            if got != exp {
                return Err(format!("sha256 mismatch: expected {exp}, got {got}"));
            }
        }
        fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    }

    // 解压并把 ffmpeg 可执行复制到 bin/ffmpeg(.exe)
    let final_path = ensure_ffmpeg(&app).map_err(|e| e.to_string())?;
    if final_path.exists() {
        fs::remove_file(&final_path).map_err(|e| e.to_string())?;
    }
    extract_and_place_ffmpeg(&tmp, &final_path).await?;

    make_executable(&final_path).map_err(|e| e.to_string())?;
    remove_quarantine(&final_path);

    // 用 latest tag 作为“版本号”；拿不到就写 unknown
    #[derive(Deserialize)]
    struct R {
        tag_name: String,
    }
    let ver = http()
        .await
        .ok()
        .and_then(|cli| {
            futures::executor::block_on(async move {
                cli.get(FF_API_LATEST)
                    .send()
                    .await
                    .ok()?
                    .error_for_status()
                    .ok()?
                    .json::<R>()
                    .await
                    .ok()
            })
        })
        .map(|r| r.tag_name)
        .unwrap_or_else(|| "unknown".into());

    // 记录到原有 InstallResult 结构里
    Ok(InstallResult {
        installed_path: final_path,
        installed_version: ver,
    })
}

#[cfg(target_os = "windows")]
fn unpack_zip(archive: &Path, tmpdir: &Path) -> Result<(), String> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        let out_path = tmpdir.join(f.mangled_name());
        if f.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out_path.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unpack_tar_xz(archive: &Path, tmpdir: &Path) -> Result<(), String> {
    let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let dec = xz2::read::XzDecoder::new(f);
    let mut ar = tar::Archive::new(dec);
    ar.unpack(tmpdir).map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn extract_and_place_ffmpeg(archive: &Path, dest_exec: &Path) -> Result<(), String> {
    let tmpdir = archive.with_extension("unpack");
    if tmpdir.exists() {
        let _ = fs::remove_dir_all(&tmpdir);
    }
    fs::create_dir_all(&tmpdir).map_err(|e| e.to_string())?;

    // 编译期根据平台选择
    #[cfg(target_os = "windows")]
    unpack_zip(archive, &tmpdir)?;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    unpack_tar_xz(archive, &tmpdir)?;

    // 找 ffmpeg 可执行文件
    let wanted = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let mut found = None;
    fn walk_find(dir: &Path, name: &str, out: &mut Option<PathBuf>) {
        if out.is_some() {
            return;
        }
        if let Ok(rd) = fs::read_dir(dir) {
            for ent in rd.flatten() {
                let p = ent.path();
                if p.is_dir() {
                    walk_find(&p, name, out);
                } else if p.file_name().and_then(|s| s.to_str()) == Some(name) {
                    *out = Some(p);
                    return;
                }
            }
        }
    }
    walk_find(&tmpdir, wanted, &mut found);
    let src_exec = found.ok_or_else(|| "ffmpeg executable not found in archive".to_string())?;
    fs::copy(&src_exec, dest_exec).map_err(|e| e.to_string())?;

    // 清理
    let _ = fs::remove_dir_all(&tmpdir);
    let _ = fs::remove_file(archive);
    Ok(())
}

// 一个简易自检命令（可选）：返回 `ffmpeg -version` 的前几行
#[tauri::command]
#[specta::specta]
pub async fn ffmpeg_version(app: tauri::AppHandle) -> Result<String, String> {
    let p = ensure_ffmpeg(&app).map_err(|e| e.to_string())?;
    if !p.exists() {
        return Err("ffmpeg not installed".into());
    }
    let out = Command::new(&p)
        .arg("-version")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let s = String::from_utf8_lossy(&out.stdout);
    Ok(s.lines().take(3).collect::<Vec<_>>().join("\n"))
}

#[tauri::command]
#[specta::specta]
pub async fn ffmpeg_check_exists(app: tauri::AppHandle) -> Result<Option<InstallResult>, String> {
    let path = ensure_ffmpeg(&app).map_err(|e| e.to_string())?;
    if !path.exists() {
        return Ok(None);
    }

    // 尝试读取版本
    let out = Command::new(&path)
        .arg("-version")
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        // 可执行存在但无法运行（缺依赖/损坏），按“不存在”处理更稳妥
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    // 典型第一行：`ffmpeg version n7.1-...`
    let installed_version = stdout
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(2)) // 取 "version" 后的那个字段
        .map(|s| s.to_string())
        .unwrap_or_else(|| "unknown".to_string());

    Ok(Some(InstallResult {
        installed_path: path,
        installed_version,
    }))
}

fn unique_flac_path(orig: &Path) -> PathBuf {
    let parent = orig.parent().unwrap_or_else(|| Path::new("."));
    let stem = orig
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let p = parent.join(format!("{stem}.flac"));
    if !p.exists() {
        return p;
    }
    for i in 1..=999 {
        let c = parent.join(format!("{stem} ({i}).flac"));
        if !c.exists() {
            return c;
        }
    }
    parent.join(format!("{stem}.{}.flac", uuid::Uuid::new_v4()))
}

pub async fn transcode_to_flac(
    app: &tauri::AppHandle,
    src: &Path,
    opts: FlacOpts,
) -> Result<PathBuf, String> {
    use tokio::process::Command;

    let ffmpeg = ensure_ffmpeg(&app).map_err(|e| e.to_string())?;
    let out = unique_flac_path(src);

    // 精简稳妥参数：
    // -map 0:a:0? 只取第一条音轨（大多数音乐够用）
    // -map_metadata 0 复制元数据（可开关）
    // -vn 去视频轨
    // -c:a flac -compression_level N
    let mut cmd = Command::new(&ffmpeg);
    cmd.arg("-y")
        .arg("-nostdin")
        .arg("-i")
        .arg(src)
        .arg("-map")
        .arg("0:a:0?")
        .arg("-vn")
        .arg("-c:a")
        .arg("flac")
        .arg("-compression_level")
        .arg(opts.compression_level.to_string());

    if opts.copy_metadata {
        cmd.arg("-map_metadata").arg("0");
    } else {
        cmd.arg("-map_metadata").arg("-1");
    }

    cmd.arg(&out);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    let status = cmd
        .status()
        .await
        .map_err(|e| format!("ffmpeg 执行失败: {e}"))?;
    if !status.success() {
        return Err(format!("ffmpeg 转码失败：{}", out.display()));
    }

    if !opts.keep_source {
        let _ = std::fs::remove_file(src);
    }

    Ok(out)
}

pub fn integrated_lufs<P: AsRef<Path>>(app: &tauri::AppHandle, path: P) -> Result<f64> {
    let ffmpeg = ensure_ffmpeg(&app)?;
    let output = std::process::Command::new(&ffmpeg)
        .arg("-hide_banner")
        .arg("-nostats")
        .arg("-i")
        .arg(path.as_ref()) // 直接传 OsStr，跨平台安全
        .arg("-filter:a")
        .arg("ebur128=peak=true")
        .arg("-f")
        .arg("null")
        .arg("-") // 丢到黑洞，不写输出
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| "spawn ffmpeg failed")?;

    let log = String::from_utf8_lossy(&output.stderr);

    // 仅在 Summary 段内找 I:，避免滚动行的中间值干扰
    let summary = log.split("Summary:").nth(1).unwrap_or(&log);
    let re =
        Regex::new(r"(?m)^\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS\s*$").expect("regex compile failed");
    let caps = re
        .captures(summary)
        .ok_or_else(|| anyhow::anyhow!("Integrated LUFS not found in ffmpeg output"))?;

    let i: f64 = caps[1].parse().context("parse LUFS number failed")?;
    Ok(i)
}
