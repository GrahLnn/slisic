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
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const FF_API_LATEST: &str = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";
const FF_DL_BASE: &str = "https://xget.r2g2.org/gh/BtbN/FFmpeg-Builds/releases/latest/download";
const FF_SUMS: &str =
    "https://xget.r2g2.org/gh/BtbN/FFmpeg-Builds/releases/latest/download/sha256sums.sha256";

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
struct FfAssetSpec {
    // 对 Win/Linux 仍然用 asset_name + 基础 BASE 拼 URL
    asset_name: Option<&'static str>,
    // macOS 直接给完整 URL
    direct_url: Option<&'static str>,
    install_name: &'static str, // "ffmpeg" or "ffmpeg.exe"
}

// 选择平台对应的 FFmpeg 构建（BtbN 命名规范）
fn ffmpeg_select_asset() -> Option<FfAssetSpec> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    match (os, arch) {
        // Windows
        ("windows", "x86_64") | ("windows", "x86") | ("windows", "aarch64") => Some(FfAssetSpec {
            asset_name: Some("ffmpeg-master-latest-win64-gpl.zip"),
            install_name: "ffmpeg.exe",
            direct_url: None,
        }),
        ("linux", "x86_64") => Some(FfAssetSpec {
            asset_name: Some("ffmpeg-master-latest-linux64-gpl.tar.xz"),
            install_name: "ffmpeg",
            direct_url: None,
        }),
        ("linux", "aarch64") => Some(FfAssetSpec {
            asset_name: Some("ffmpeg-master-latest-linuxarm64-gpl.tar.xz"),
            install_name: "ffmpeg",
            direct_url: None,
        }),
        ("linux", "arm") | ("linux", "armv7") => Some(FfAssetSpec {
            asset_name: Some("ffmpeg-master-latest-linuxarmhf-gpl.tar.xz"),
            install_name: "ffmpeg",
            direct_url: None,
        }),
        // macOS：建议 Homebrew；如需内置下载，你可以换成第三方构建源
        ("macos", "aarch64") => Some(FfAssetSpec {
            asset_name: None,
            direct_url: Some(
                "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/snapshot/ffmpeg.zip",
            ),
            install_name: "ffmpeg",
        }),
        // Intel
        ("macos", "x86_64") => Some(FfAssetSpec {
            asset_name: None,
            // Evermeet 提供 zip 最新快照
            direct_url: Some("https://evermeet.cx/ffmpeg/get/zip"),
            install_name: "ffmpeg",
        }),

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
        asset_name: spec.asset_name.map(|s| s.to_string()),
        download_url: if let Some(url) = spec.direct_url {
            Some(url.to_string())
        } else if let Some(name) = spec.asset_name {
            Some(format!("{FF_DL_BASE}/{}", name))
        } else {
            None
        },
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
    use std::path::Path;

    // 统一通过选择器拿到 spec（Win/Linux 走 BtbN，macOS 走直链）
    let spec = ffmpeg_select_asset().ok_or("当前平台未内置 FFmpeg 构建映射")?;

    // 拼下载 URL：优先 direct_url（macOS），否则用 BtbN 的 BASE+asset_name
    let url = if let Some(dir) = spec.direct_url {
        dir.to_string()
    } else if let Some(name) = spec.asset_name {
        format!("{FF_DL_BASE}/{}", name)
    } else {
        return Err("未找到可用的下载 URL".into());
    };

    // 校验：仅对 BtbN（asset_name 有值）尝试获取 sha256；直链源（macOS）先跳过
    let expect = if let Some(name) = spec.asset_name {
        ffmpeg_fetch_sum(name).await.ok().flatten()
    } else {
        None
    };

    // 生成临时文件名（优先 asset_name，否则从 URL 截取文件名，再不行用固定名）
    let tmp_name = if let Some(name) = spec.asset_name {
        name.to_string()
    } else {
        Path::new(&url)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("ffmpeg_download")
            .to_string()
    };

    // 下载到缓存目录
    let tmp = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(format!("{tmp_name}.tmp"));

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
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(&bytes);
            let got = hex::encode(h.finalize());
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
    remove_quarantine(&final_path); // macOS 有效，其它平台是 no-op 也无妨

    // 统一用实际安装的 ffmpeg -version 解析版本号，更通用
    let ver = {
        let mut cmd = Command::new(&final_path);
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
            "unknown".to_string()
        } else {
            let s = String::from_utf8_lossy(&out.stdout);
            // 典型第一行：ffmpeg version n7.1-...；我们取第二个词当版本
            s.lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(2))
                .unwrap_or("unknown")
                .to_string()
        }
    };

    Ok(InstallResult {
        installed_path: final_path,
        installed_version: ver,
    })
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
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

    // === 按扩展名选择解压器 ===
    let name = archive.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if name.ends_with(".zip") {
        // macOS/Windows: zip 包
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            unpack_zip(archive, &tmpdir)?;
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            return Err("zip 解压在当前平台未实现".into());
        }
    } else if name.ends_with(".tar.xz") || name.ends_with(".txz") {
        // Linux: tar.xz 包
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            unpack_tar_xz(archive, &tmpdir)?;
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            return Err("tar.xz 解压在当前平台未实现".into());
        }
    } else {
        // 兜底（有些直链末尾可能没有扩展名，尝试 zip 解）
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            if let Err(e) = unpack_zip(archive, &tmpdir) {
                return Err(format!("无法识别压缩格式，且 zip 解压失败：{e}"));
            }
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            return Err("无法识别压缩格式（既不是 zip 也不是 tar.xz）".into());
        }
    }

    // === 以下保持不变：递归寻找 ffmpeg 可执行并复制 ===
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
    let mut cmd = Command::new(&p);
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

    let mut cmd = Command::new(&path);
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

pub async fn integrated_lufs<P: AsRef<Path>>(app: &tauri::AppHandle, path: P) -> Result<f64> {
    let ffmpeg = ensure_ffmpeg(&app)?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-nostats")
        .arg("-i")
        .arg(path.as_ref()) // 直接传 OsStr，跨平台安全
        .arg("-filter:a")
        .arg("ebur128=peak=true")
        .arg("-f")
        .arg("null")
        .arg("-") // 丢到黑洞，不写输出
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().await.with_context(|| "spawn ffmpeg failed")?;

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

pub async fn trim_leading_zero<P: AsRef<Path>>(app: &tauri::AppHandle, path: P) -> Result<()> {
    let ffmpeg = ensure_ffmpeg(&app)?;
    let path = path.as_ref();

    // 1) silencedetect
    let mut cmd = Command::new(&ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-nostats")
        .arg("-i")
        .arg(path)
        .arg("-af")
        .arg("silencedetect=noise=-60dB:d=0.5")
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

    let out = cmd
        .output()
        .await
        .context("spawn ffmpeg(silencedetect) failed")?;
    let log = String::from_utf8_lossy(&out.stderr);

    // 2) 仅当第一段确实从 0 开始时才裁
    let re_start0 = Regex::new(
        r"(?m)^\s*\[(?:Parsed_)?silencedetect(?:_\d+)?[^\]]*\]\s*silence_start:\s*0(?:\.0+)?\s*$",
    )
    .unwrap();
    let start0_pos = if let Some(m) = re_start0.find(&log) {
        m.end()
    } else {
        return Ok(());
    };

    let re_end = Regex::new(
        r"(?m)^\s*\[(?:Parsed_)?silencedetect(?:_\d+)?[^\]]*\]\s*silence_end:\s*([0-9]+(?:\.[0-9]+)?)\b"
    ).unwrap();
    let tail = &log[start0_pos..];
    let cut_time = if let Some(caps) = re_end.captures(tail) {
        caps[1].to_string()
    } else {
        return Ok(());
    };

    // 3) 生成临时输出路径：<stem>.trim.tmp.<ext>
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("out");
    let tmp_name = if ext.is_empty() {
        format!("{stem}.trim.tmp")
    } else {
        format!("{stem}.trim.tmp.{ext}")
    };
    let tmp_path = path.with_file_name(tmp_name);

    // 4) 容器/格式推断：尽量保持与源一致；m4a/mp4 明确用 mp4 容器更稳
    let mut cmd2 = Command::new(&ffmpeg);
    cmd2.arg("-hide_banner")
        .arg("-nostats")
        .arg("-y") // 覆盖临时文件
        .arg("-ss")
        .arg(&cut_time)
        .arg("-i")
        .arg(path)
        .arg("-c")
        .arg("copy")
        .arg("-map")
        .arg("0:a")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd2.creation_flags(CREATE_NO_WINDOW);
    }

    // 针对常见扩展名设置容器/flags
    match ext.to_ascii_lowercase().as_str() {
        "m4a" | "mp4" => {
            cmd2.arg("-movflags").arg("+faststart");
            // 可显式指定：cmd2.arg("-f").arg("mp4");
        }
        "aac" => {
            cmd2.arg("-f").arg("adts");
        } // aac 原始流
        "opus" => { /* ogg/webm 需区分，这里不强制 */ }
        _ => {}
    }

    cmd2.arg(&tmp_path);

    let out2 = cmd2.output().await.context("spawn ffmpeg(cut) failed")?;
    if !out2.status.success() {
        let stderr_s = String::from_utf8_lossy(&out2.stderr);
        // 打印详细错误，便于定位容器/编解码问题
        eprintln!("[ffmpeg cut stderr]\n{stderr_s}");
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(anyhow::anyhow!("ffmpeg cut failed"));
    }

    // 5) 覆盖原文件（Windows 先删后改名）
    #[cfg(windows)]
    {
        let _ = tokio::fs::remove_file(path).await;
    }
    tokio::fs::rename(&tmp_path, path)
        .await
        .context("replace original with trimmed file failed")?;

    Ok(())
}
