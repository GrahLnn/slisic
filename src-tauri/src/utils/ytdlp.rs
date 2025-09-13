use anyhow::Result;
use reqwest::header::ACCEPT;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::{
    fs,
    future::Future,
    io::{self, Write},
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::Arc,
    time::Instant,
};

use fs2::FileExt;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::utils::{config::resolve_save_path, enq::finalize_process};
use crate::{
    domain::models::music::ProcessMsg,
    utils::{
        ffmpeg::{ensure_ffmpeg, transcode_to_flac, FlacOpts},
        file::{bin_dir, http, make_executable, remove_quarantine, InstallResult},
    },
};
use chrono::TimeZone;
use futures::stream::{self, StreamExt};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tauri::async_runtime::spawn;
use tauri::AppHandle;
use tauri::Manager;
use tauri_specta::Event;
use tokio::process::Command;
use tokio::time::sleep;
use uuid::Uuid;

const GH_API_LATEST: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const GH_DL_BASE: &str = "https://xget.grahlnn.com/gh/yt-dlp/yt-dlp/releases/latest/download";
const GH_SUMS: &str =
    "https://xget.grahlnn.com/gh/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";

fn file_non_empty(p: &Path) -> bool {
    match fs::metadata(p) {
        Ok(md) => md.is_file() && md.len() > 0,
        Err(_) => false,
    }
}

fn has_part_siblings(p: &Path) -> bool {
    // 简单探测常见的临时/未完成后缀
    let cand = [
        format!("{}.part", p.to_string_lossy()),
        format!("{}.tmp", p.to_string_lossy()),
        format!("{}.download", p.to_string_lossy()),
    ];
    cand.into_iter().any(|s| Path::new(&s).exists())
}

fn ensure_parent_dir(p: &Path) -> io::Result<()> {
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)
    } else {
        Ok(())
    }
}

fn dir_nonempty(p: &Path) -> bool {
    match fs::read_dir(p) {
        Ok(mut it) => it.next().is_some(),
        Err(_) => false,
    }
}

/// 对章节完整性的保守检查：
/// - 若给了章节列表，则检查这些目标文件里“有相当一部分已存在”（>= 80%）
/// - 若没法严格命名匹配，则退化为“目录非空”
/// 你现有的 split 命名策略如果固定（如 `{index:02d} {chapter}.m4a`），
/// 这里也可以完全精确检查。
fn chapters_mostly_ready(chapter_dir: &Path, title: &str, chapters: &[Chapter]) -> bool {
    if chapters.is_empty() {
        return dir_nonempty(chapter_dir);
    }
    let mut hit = 0usize;
    for (i, ch) in chapters.iter().enumerate() {
        // 与 split_audio_by_chapters 的命名保持一致（示例）：
        let basename = format!("{:02} {}", i + 1, sanitize_segment(&ch.title));
        // 允许 m4a/flac 两种容器（与 to_flac 配置一致）
        let cands = [format!("{basename}.m4a"), format!("{basename}.flac")];
        if cands.iter().any(|name| {
            let p = chapter_dir.join(name);
            file_non_empty(&p)
        }) {
            hit += 1;
        }
    }
    // 章数多时允许少量缺失；你也可以改成 == chapters.len() 的严格判定
    hit * 5 >= chapters.len() * 4 // 命中率 >= 80%
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkState {
    pub root_id: Uuid,
    pub url: String,
    pub title: String,
    pub status: NodeStatus,  // 根的状态
    pub progress_done: u32,  // 完成叶子数
    pub progress_total: u32, // 总叶子数（解析后填）
    pub error: Option<String>,
    pub updated_ms: u64,
    pub children: Vec<ChildLeaf>, // 只记录叶子（或也可存中间节点，按需）
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChildLeaf {
    pub id: Uuid,
    pub url: String,
    pub title: String,
    pub status: NodeStatus,
    pub file: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Pending,
    Downloading,
    Ok,
    Err,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn atomic_write_json(p: &Path, v: &WorkState) -> Result<(), String> {
    let tmp = p.with_extension("tmp");
    let data = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&data).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    // 原子替换
    fs::rename(&tmp, p).map_err(|e| e.to_string())?;
    // 保险起见，同步目录
    if let Some(dir) = p.parent() {
        #[cfg(target_family = "unix")]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let d = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY)
                .open(dir)
                .map_err(|e| e.to_string())?;
            d.sync_all().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

struct WorkGuard {
    _file: fs::File,
}
impl WorkGuard {
    fn lock(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let lock_path = dir.join("lock");
        let f = fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(|e| e.to_string())?;
        f.try_lock_exclusive()
            .map_err(|e| format!("lock busy: {e}"))?;
        Ok(Self { _file: f })
    }
}

fn work_dir_for(root_id: Uuid, work_root: &Path) -> PathBuf {
    work_root.join(root_id.to_string())
}
fn state_path_for(root_id: Uuid, work_root: &Path) -> PathBuf {
    work_dir_for(root_id, work_root).join("state.json")
}

fn load_state(p: &Path) -> Option<WorkState> {
    let s = fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_state(p: &Path, s: &mut WorkState) -> Result<(), String> {
    s.updated_ms = now_ms();
    atomic_write_json(p, s)
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
struct AssetSpec {
    /// GitHub 资产文件名（用于下载与校验）
    asset_name: &'static str,
    /// 安装后在 bin/ 下的文件名（统一命名）
    install_name: &'static str,
}

fn select_asset() -> AssetSpec {
    // OS: "windows" | "macos" | "linux" | ...
    // ARCH: "x86_64" | "x86" | "aarch64" | "arm" | "armv7" | ...
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    match (os, arch) {
        // Windows
        ("windows", "x86") => AssetSpec {
            asset_name: "yt-dlp_x86.exe",
            install_name: "yt-dlp.exe",
        },
        ("windows", _) => AssetSpec {
            asset_name: "yt-dlp.exe",
            install_name: "yt-dlp.exe",
        }, // x86_64/arm64 走 x64

        // macOS（优先现代包；极老系统可自行加 _legacy 兜底）
        ("macos", _) => AssetSpec {
            asset_name: "yt-dlp_macos",
            install_name: "yt-dlp",
        },

        // Linux
        ("linux", "x86_64") => AssetSpec {
            asset_name: "yt-dlp_linux",
            install_name: "yt-dlp",
        },
        ("linux", "aarch64") => AssetSpec {
            asset_name: "yt-dlp_linux_aarch64",
            install_name: "yt-dlp",
        },
        ("linux", "arm") => AssetSpec {
            asset_name: "yt-dlp_linux_armv7l",
            install_name: "yt-dlp",
        },
        ("linux", "armv7") => AssetSpec {
            asset_name: "yt-dlp_linux_armv7l",
            install_name: "yt-dlp",
        },

        // 其他：退回脚本（需系统有 Python）
        _ => AssetSpec {
            asset_name: "yt-dlp",
            install_name: "yt-dlp",
        },
    }
}

fn installed_bin_path(app: &tauri::AppHandle) -> tauri::Result<PathBuf> {
    let spec = select_asset();
    Ok(bin_dir(app)?.join(spec.install_name))
}

fn version_file(app: &tauri::AppHandle) -> tauri::Result<PathBuf> {
    Ok(bin_dir(app)?.join("yt-dlp.version.json"))
}

#[tauri::command]
#[specta::specta]
pub async fn github_ok() -> bool {
    let Ok(cli) = http().await else {
        return false;
    };
    cli.head(GH_SUMS).send().await.ok().is_some()
        || cli.head("https://github.com").send().await.ok().is_some()
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
struct GithubRelease {
    tag_name: String,
}

async fn fetch_latest_version() -> reqwest::Result<String> {
    let cli = http().await?;
    let r: GithubRelease = cli
        .get(GH_API_LATEST)
        .send()
        .await?
        .error_for_status()?
        .json::<GithubRelease>()
        .await?;
    Ok(r.tag_name)
}

async fn fetch_sums() -> reqwest::Result<String> {
    let cli = http().await?;
    Ok(cli
        .get(GH_SUMS)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?)
}

fn parse_sha256(sums: &str, asset: &str) -> Option<String> {
    for line in sums.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 行尾匹配资产名即可，格式通常为 "{sha256}  {filename}"
        if line.ends_with(asset) {
            if let Some((hash_part, _)) = line.split_once(char::is_whitespace) {
                let h = hash_part.trim();
                if h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Some(h.to_lowercase());
                }
            }
        }
    }
    None
}

fn read_installed_version(app: &tauri::AppHandle) -> Option<String> {
    let vf = version_file(app).ok()?;
    let data = fs::read_to_string(vf).ok()?;
    serde_json::from_str::<serde_json::Value>(&data)
        .ok()?
        .get("version")?
        .as_str()
        .map(|s| s.to_string())
}

fn write_installed_version(app: &tauri::AppHandle, ver: &str) -> tauri::Result<()> {
    let vf = version_file(app)?;
    fs::write(
        vf,
        serde_json::to_vec_pretty(&serde_json::json!({ "version": ver }))?,
    )?;
    Ok(())
}

fn newer(latest: &str, current: &str) -> bool {
    fn to_num(v: &str) -> Option<i32> {
        let p: Vec<_> = v.trim_matches('v').split('.').collect();
        if p.len() == 3 {
            Some(
                p[0].parse::<i32>().ok()? * 10000
                    + p[1].parse::<i32>().ok()? * 100
                    + p[2].parse::<i32>().ok()?,
            )
        } else {
            None
        }
    }
    match (to_num(latest), to_num(current)) {
        (Some(a), Some(b)) => a > b,
        _ => latest > current,
    }
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

#[tauri::command]
#[specta::specta]
pub async fn ytdlp_check_update(app: tauri::AppHandle) -> Result<CheckResult, String> {
    let spec = select_asset();
    let url = format!("{GH_DL_BASE}/{}", spec.asset_name);

    let installed_path = installed_bin_path(&app).ok();
    let installed_version = read_installed_version(&app);
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

async fn download_with_sha256(
    url: &str,
    expect_sha256: &str,
    dest_tmp: &Path,
) -> Result<(), String> {
    let cli = http().await.map_err(|e| e.to_string())?;
    let resp = cli
        .get(url)
        .header(ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.error_for_status_ref().map_err(|e| e.to_string())?;

    let mut file = fs::File::create(dest_tmp).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut stream = resp.bytes_stream();

    use futures_util::TryStreamExt;
    use std::io::Write;
    while let Some(chunk) = stream.try_next().await.map_err(|e| e.to_string())? {
        let chunk = chunk.to_vec();
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;

    let got = hex::encode(hasher.finalize());
    if got != expect_sha256.to_lowercase() {
        let _ = fs::remove_file(dest_tmp);
        return Err(format!(
            "sha256 mismatch: expected {expect_sha256}, got {got}"
        ));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn ytdlp_download_and_install(app: tauri::AppHandle) -> Result<InstallResult, String> {
    let spec = select_asset();
    let url = format!("{GH_DL_BASE}/{}", spec.asset_name);
    let sums = fetch_sums().await.map_err(|e| format!("fetch sums: {e}"))?;
    let Some(expect) = parse_sha256(&sums, spec.asset_name) else {
        return Err(format!("cannot find sha256 for asset {}", spec.asset_name));
    };

    let tmp = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(format!("{}.tmp", spec.install_name));
    let final_path = installed_bin_path(&app).map_err(|e| e.to_string())?;

    download_with_sha256(&url, &expect, &tmp).await?;

    make_executable(&tmp).map_err(|e| e.to_string())?;
    remove_quarantine(&tmp);

    if final_path.exists() {
        fs::remove_file(&final_path).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;

    let latest = fetch_latest_version()
        .await
        .unwrap_or_else(|_| "unknown".into());
    write_installed_version(&app, &latest).map_err(|e| e.to_string())?;

    Ok(InstallResult {
        installed_path: final_path,
        installed_version: latest,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn check_exists(app: tauri::AppHandle) -> Result<Option<InstallResult>, String> {
    let installed_path = installed_bin_path(&app).ok().filter(|p| p.exists());
    let installed_version = read_installed_version(&app);

    match (installed_path, installed_version) {
        (Some(path), Some(version)) => Ok(Some(InstallResult {
            installed_path: path,
            installed_version: version,
        })),
        _ => Ok(None),
    }
}

fn duration_until_next_9am_local() -> Duration {
    use chrono::{Duration as ChronoDur, Local, NaiveDate, NaiveTime};

    let now = Local::now();
    let today: NaiveDate = now.date_naive();

    let nine = NaiveTime::from_hms_opt(9, 0, 0).unwrap();
    let today_9 = now.timezone().from_local_datetime(&today.and_time(nine));

    // 处理“本地时间歧义/缺失”（DST 切换时可能发生）
    let today_9 = match today_9 {
        chrono::LocalResult::Single(dt) => dt,
        chrono::LocalResult::Ambiguous(early, _late) => early, // 任选其一即可
        chrono::LocalResult::None => {
            // 若 09:00 不存在（极端 DST 情况），退到 09:30 或直接顺延一天 09:00
            let fallback = now + ChronoDur::hours(24);
            let d = fallback.date_naive().and_time(nine);
            now.timezone().from_local_datetime(&d).earliest().unwrap()
        }
    };

    let target = if today_9 > now {
        today_9
    } else {
        let tmr = (today + ChronoDur::days(1)).and_time(nine);
        now.timezone().from_local_datetime(&tmr).earliest().unwrap()
    };

    (target - now)
        .to_std()
        .unwrap_or_else(|_| Duration::from_secs(0))
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Type, Event)]
pub struct YtdlpVersionChanged {
    pub str: String,
}

/// 真正的“检查并（必要时）更新”
/// - 仅当 `needs_update == true` 时，才会调用下载与安装
pub async fn update_ytdlp(app: &AppHandle) {
    match ytdlp_check_update(app.clone()).await {
        Ok(check) => {
            if check.needs_update {
                // info!("yt-dlp: found update {} -> {:?}, start installing", check.installed_version.unwrap_or_default(), check.latest_version);
                let res = ytdlp_download_and_install(app.clone()).await;
                if let Ok(v) = res {
                    YtdlpVersionChanged {
                        str: v.installed_version,
                    }
                    .emit(app)
                    .ok();
                }
            } else {
                // info!("yt-dlp: already up to date ({:?})", check.installed_version);
            }
        }
        Err(_e) => {
            // warn!("yt-dlp: check update failed: {e}");
        }
    }
}

/// 启动一个后台任务：
/// - 应用启动时立即跑一次
/// - 之后每天本地时间 09:00 跑一次
pub fn spawn_ytdlp_auto_update(app: AppHandle) {
    spawn(async move {
        // 启动立刻跑一次（不要在 setup 里直接 await）
        update_ytdlp(&app).await;

        loop {
            let wait: Duration = duration_until_next_9am_local();
            sleep(wait).await; // ✅ 用 tauri::async_runtime::sleep
            update_ytdlp(&app).await;
        }
    });
}

pub async fn flat_data(app: tauri::AppHandle, url: String) -> Result<serde_json::Value, String> {
    let exe = installed_bin_path(&app).map_err(|e| e.to_string())?;
    if !exe.exists() {
        return Err("yt-dlp not found, please install/download first".into());
    }
    let output = Command::new(&exe)
        .arg("-J")
        .arg("--skip-download")
        .arg("--flat-playlist")
        .arg(&url)
        .output()
        .await
        .map_err(|e| format!("execute yt-dlp failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // 找到最后一行包含 "ERROR:" 的
        if let Some(line) = stderr.lines().rev().find(|l| l.contains("ERROR:")) {
            return Err(line
                .to_string()
                .replace("ERROR: ", "")
                .replace(&format!(": {url}"), ""));
        } else {
            return Err(format!("yt-dlp failed: {}", stderr));
        }
    }

    let stdout = String::from_utf8(output.stdout)
        .unwrap_or_else(|v| String::from_utf8_lossy(&v.into_bytes()).into_owned());

    let v: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("parse json failed: {e}"))?;

    Ok(v)
}

pub async fn download_audio(
    app: tauri::AppHandle,
    url: String,
    save_dir: PathBuf,
) -> Result<PathBuf, String> {
    let exe = installed_bin_path(&app).map_err(|e| e.to_string())?;
    if !exe.exists() {
        return Err("yt-dlp not found, please install/download first".into());
    }

    if !save_dir.exists() {
        fs::create_dir_all(&save_dir).map_err(|e| format!("create dir failed: {e}"))?;
    } else if !save_dir.is_dir() {
        return Err(format!(
            "save_dir is not a directory: {}",
            save_dir.to_string_lossy()
        ));
    }

    // 交给 yt-dlp 选扩展名，但示例里你手写了 m4a；如果你确实只要 m4a，可以保留。
    let out_tmpl = save_dir
        .join("%(title)s.%(ext)s")
        .to_string_lossy()
        .to_string();

    let output = Command::new(&exe)
        // 关键：强制 UTF-8 输出，避免 GBK/本地代码页造成的乱码
        .env("PYTHONIOENCODING", "utf-8")
        // 可选：禁用 yt-dlp 自更新
        .env("YTDLP_NO_UPDATE", "1")
        // 让文件名尽量可被 Windows 接受（可选）
        .arg("--windows-filenames")
        .arg("-f")
        .arg("bestaudio")
        .arg("--no-playlist")
        // .arg("--no-part")
        .arg("--continue") // ✅ 断点续传
        .arg("--no-overwrites") // ✅ 不覆盖现有完整文件
        .arg("-N")
        .arg("8")
        .arg("-o")
        .arg(&out_tmpl)
        // 打印最终路径 + 兜底路径（有些情况下没有“move”过程）
        .arg("--print")
        .arg("after_move:filepath")
        .arg("--print")
        .arg("before_dl:filepath")
        .arg(&url)
        .output()
        .await
        .map_err(|e| format!("execute yt-dlp failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8(output.stderr)
            .unwrap_or_else(|v| String::from_utf8_lossy(&v.into_bytes()).into_owned());
        if let Some(line) = stderr.lines().rev().find(|l| l.contains("ERROR:")) {
            return Err(line.replace("ERROR: ", "").replace(&format!(": {url}"), ""));
        } else {
            return Err(format!("yt-dlp failed: {}", stderr));
        }
    }

    // 这里可以安全用 UTF-8 解析
    let stdout = String::from_utf8(output.stdout)
        .unwrap_or_else(|v| String::from_utf8_lossy(&v.into_bytes()).into_owned());

    // 取最后一个非空行（after_move 优先，其次 before_dl）
    let printed = stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .ok_or_else(|| "yt-dlp did not print any filepath".to_string())?;

    let printed = printed.trim_matches(|c| c == '"' || c == '\''); // 有些平台可能带引号
    let final_path = Path::new(printed).to_path_buf();

    if !final_path.exists() {
        // 兜底：部分站点/容器没有触发 move，或者 ext 与模板不同
        // 在 save_dir 下找“最近生成”的音频文件作为近似匹配
        if let Some(p) = newest_in_dir(&save_dir)? {
            return Ok(p);
        }
        return Err(format!(
            "download finished but file not found at printed path: {}",
            final_path.display()
        ));
    }

    Ok(final_path)
}

fn newest_in_dir(dir: &Path) -> Result<Option<PathBuf>, String> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_file() {
            // 这里列表可按需加常见音频后缀
            let is_audio = matches!(
                p.extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .as_str(),
                "m4a" | "mp3" | "opus" | "aac" | "flac" | "wav" | "ogg" | "webm"
            );
            if !is_audio {
                continue;
            }
            let t = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
                best = Some((t, p));
            }
        }
    }
    Ok(best.map(|(_, p)| p))
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct MediaInfo {
    pub title: String,
    pub item_type: String,
    pub entries_count: Option<u32>,
}

#[tauri::command]
#[specta::specta]
pub async fn look_media(app: tauri::AppHandle, url: String) -> Result<MediaInfo, String> {
    let v = flat_data(app, url).await?;
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "title filed not found".to_string())?;
    let item_type = v.get("_type").and_then(|x| x.as_str()).unwrap_or("unknown");
    let entries_count = if item_type == "playlist" {
        v.get("entries")
            .and_then(|x| x.as_array())
            .map(|x| x.len() as u32)
    } else {
        None
    };
    Ok(MediaInfo {
        title: title.to_string(),
        item_type: item_type.to_string(),
        entries_count,
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mission {
    pub version: String,
    pub entries: Vec<Entry>, // forest: 允许多个根 playlist
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Entry {
    pub id: Uuid,    // 稳定标识：下载器回调、并发更新都靠它
    pub url: String, // playlist/single 都可以有 url
    pub title: String,
    pub retries: u32,
    pub error: Option<String>,
    #[serde(flatten)]
    pub kind: Option<EntryKind>, // 具体节点类型
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Chapter {
    pub title: String,
    pub start: f32,
    pub end: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EntryKind {
    /// 中间节点：播放列表或集合
    Playlist {
        children: Vec<Entry>,
        // 可选: 已展开/已解析标记，避免重复解析
        expanded: bool,
    },
    /// 叶子：单个资源
    Single {
        // 可选: 下载目标文件名/相对路径、ETag 等
        file: Option<String>,
        chapters: Option<Vec<Chapter>>,
        status: DownloadStatus,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
pub enum DownloadStatus {
    Pending,
    Downloading,
    Ok,
    Err,
}

fn node_dir(work_root: &Path, ancestors_ids: &[Uuid], id: Uuid) -> PathBuf {
    let mut p = work_root.to_path_buf();
    for a in ancestors_ids {
        p.push(a.to_string());
    }
    p.push(id.to_string());
    p
}

fn node_state_path(work_root: &Path, ancestors_ids: &[Uuid], id: Uuid) -> PathBuf {
    node_dir(work_root, ancestors_ids, id).join("state.json")
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Type, Event)]
pub struct ProcessResult {
    pub working_path: PathBuf,
    pub saved_path: PathBuf,
    pub name: String,
}

/// 递归处理 entry：展开/下载（每节点一个 JSON 快照：working_entry/<id>/state.json）
pub fn process_entry<'a>(
    app: tauri::AppHandle,
    base_save_folder: &'a Path,
    entry: &'a mut Entry,
    ancestors_titles: &'a [String], // 原来的标题链
    ancestors_ids: &'a [Uuid],      // 新增：祖先 id 链
) -> Pin<Box<dyn Future<Output = Result<ProcessResult, String>> + Send + 'a>> {
    Box::pin(async move {
        // ===== 1) 计算保存目录（不含当前 entry.title）=====
        let mut dir = base_save_folder.to_path_buf();
        for t in ancestors_titles {
            dir.push(sanitize_segment(t));
        }

        ProcessMsg {
            str: format!("Processing {}", entry.title),
        }
        .emit(&app)
        .ok();

        // ===== 2) 本节点状态文件路径（按层级建目录）=====
        let work_root = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("working_entry");
        let st_dir = node_dir(&work_root, ancestors_ids, entry.id);
        let st_path = node_state_path(&work_root, ancestors_ids, entry.id);

        // ===== 3) 初始化/更新：标记为 Downloading =====
        let node_id = entry.id;
        let init_url = entry.url.clone();
        let init_title = entry.title.clone();
        let mut mk_init = move || WorkState {
            root_id: node_id, // 这里记录“本节点”的 id
            url: init_url.clone(),
            title: init_title.clone(),
            status: NodeStatus::Pending,
            progress_done: 0,
            progress_total: 0,
            error: None,
            updated_ms: now_ms(),
            children: vec![],
        };

        {
            let _guard = WorkGuard::lock(&st_dir)?;
            let mut st = load_state(&st_path).unwrap_or_else(&mut mk_init);
            st.status = NodeStatus::Downloading;
            st.url = entry.url.clone();
            if !entry.title.is_empty() {
                st.title = entry.title.clone();
            }
            save_state(&st_path, &mut st)?;
        }

        // ===== 4) 拉远端元数据（标题等），拉到后刷新一次 =====
        let v = flat_data(app.clone(), entry.url.clone()).await?;
        if let Some(t) = v.get("title").and_then(|x| x.as_str()) {
            if !t.is_empty() {
                entry.title = t.to_string();
                let _g = WorkGuard::lock(&st_dir)?;
                let mut st = load_state(&st_path).unwrap_or_else(&mut mk_init);
                st.title = entry.title.clone();
                save_state(&st_path, &mut st)?;
            }
        }

        // ===== 5) 分支：playlist / single =====
        let is_playlist = v.get("_type").and_then(|x| x.as_str()) == Some("playlist")
            || v.get("entries").is_some();

        if is_playlist {
            // ---------- playlist ----------
            let mut children = Vec::new();
            if let Some(arr) = v.get("entries").and_then(|x| x.as_array()) {
                println!("Playlist has {} children", arr.len());
                for it in arr {
                    let url = it
                        .get("url")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let title = it
                        .get("title")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    children.push(Entry {
                        id: Uuid::new_v4(),
                        url,
                        title,
                        retries: 0,
                        error: None,
                        kind: Some(EntryKind::Single {
                            file: None,
                            chapters: None,
                            status: DownloadStatus::Pending,
                        }),
                    });
                }
            }
            entry.kind = Some(EntryKind::Playlist {
                children: children.clone(),
                expanded: true,
            });

            // 写 total
            {
                let _g = WorkGuard::lock(&st_dir)?;
                let mut st = load_state(&st_path).unwrap_or_else(&mut mk_init);
                st.progress_total = children.len() as u32;
                save_state(&st_path, &mut st)?;
            }

            // 递归并发处理每个 child
            let concurrency_limit = 16; // 并发上限，可调整
            stream::iter(children.into_iter())
                .map(|mut child| {
                    let mut chain_titles = ancestors_titles.to_vec();
                    chain_titles.push(entry.title.clone());

                    let mut chain_ids = ancestors_ids.to_vec();
                    chain_ids.push(entry.id);

                    let app_cloned = app.clone();
                    async move {
                        let res = process_entry(
                            app_cloned,
                            base_save_folder,
                            &mut child,
                            &chain_titles,
                            &chain_ids,
                        )
                        .await;
                        (res, child)
                    }
                })
                .buffer_unordered(concurrency_limit)
                .for_each(|(res, child)| {
                    let st_dir = st_dir.clone();
                    let st_path = st_path.clone();
                    async move {
                        let _g = WorkGuard::lock(&st_dir).ok();
                        let mut st = load_state(&st_path).unwrap_or_else(|| WorkState {
                            root_id: child.id,
                            url: child.url.clone(),
                            title: child.title.clone(),
                            status: NodeStatus::Pending,
                            progress_done: 0,
                            progress_total: 0,
                            error: None,
                            updated_ms: now_ms(),
                            children: vec![],
                        });
                        match res {
                            Ok(_child_result) => {
                                st.progress_done = st.progress_done.saturating_add(1);
                            }
                            Err(e) => {
                                st.error = Some(e);
                            }
                        }
                        let _ = save_state(&st_path, &mut st);
                    }
                })
                .await;

            // 全部处理完：若 done==total 则置 Ok
            {
                let _g = WorkGuard::lock(&st_dir)?;
                let mut st = load_state(&st_path).unwrap_or_else(&mut mk_init);
                if st.progress_total > 0 && st.progress_done >= st.progress_total {
                    st.status = NodeStatus::Ok;
                    st.error = None;
                }
                save_state(&st_path, &mut st)?;
            }
        } else {
            // ---------- single ----------
            // 幂等短路：若之前已 OK 且文件仍存在，直接跳过
            {
                let _g = WorkGuard::lock(&st_dir)?;
                if let Some(st0) = load_state(&st_path) {
                    if st0.status == NodeStatus::Ok {
                        if let Some(last) = st0.children.last().and_then(|c| c.file.as_ref()) {
                            if Path::new(last).exists() {
                                let saved_path = PathBuf::from(last);
                                return Ok(ProcessResult {
                                    working_path: st_dir.clone(),
                                    saved_path,
                                    name: entry.title.clone(),
                                });
                            }
                        }
                    }
                }
            }

            let chapters = extract_chapters_json(&v);
            let chapter_dir = dir.join(sanitize_segment(&entry.title));

            if let Some(ref chs) = chapters {
                let count = fs::read_dir(&chapter_dir).map(|rd| rd.count()).unwrap_or(0);
                let mut file = None;
                if count != chs.len() {
                    let download =
                        download_audio(app.clone(), entry.url.clone(), dir.clone()).await?;
                    ProcessMsg {
                        str: format!("split audio {}", entry.title),
                    }
                    .emit(&app)
                    .ok();
                    let _outs =
                        split_audio_by_chapters(&app, &download, chs, &chapter_dir, None).await?;
                    let _ = std::fs::remove_file(&download);
                    file = Some(download.to_string_lossy().into_owned());
                }

                entry.kind = Some(EntryKind::Single {
                    file,
                    chapters: Some(chs.clone()),
                    status: DownloadStatus::Ok,
                });
            } else {
                let whole_path = {
                    let candidate = dir.join(format!("{}.m4a", entry.title));
                    if candidate.exists() {
                        candidate
                    } else {
                        download_audio(app.clone(), entry.url.clone(), dir.clone()).await?
                    }
                };
                let final_file = whole_path.clone();
                entry.kind = Some(EntryKind::Single {
                    file: Some(final_file.to_string_lossy().into_owned()),
                    chapters: None,
                    status: DownloadStatus::Ok,
                });
            }

            // single 完成：写 Ok、file，total/done = 1
            if let Some(EntryKind::Single { file, .. }) = &entry.kind {
                let _g = WorkGuard::lock(&st_dir)?;
                let mut st = load_state(&st_path).unwrap_or_else(&mut mk_init);
                st.progress_total = st.progress_total.max(1);
                st.progress_done = st.progress_done.saturating_add(1).min(st.progress_total);
                st.status = NodeStatus::Ok;
                st.error = None;
                st.children.push(ChildLeaf {
                    id: entry.id,
                    url: entry.url.clone(),
                    title: entry.title.clone(),
                    status: NodeStatus::Ok,
                    file: file.clone(),
                    error: None,
                });
                save_state(&st_path, &mut st)?;
            }
        }
        // Determine saved_path based on node type and outcome (exhaustive over EntryKind)
        let saved_path: PathBuf = if is_playlist {
            dir.join(sanitize_segment(&entry.title))
        } else {
            match entry.kind.as_ref() {
                Some(EntryKind::Single { file, chapters, .. }) => {
                    if chapters.as_ref().map_or(false, |chs| !chs.is_empty()) {
                        // Split into a directory named by the entry title
                        dir.join(sanitize_segment(&entry.title))
                    } else if let Some(f) = file {
                        // Final single-file output
                        PathBuf::from(f)
                    } else {
                        // Fallback when file is missing
                        dir.join(sanitize_segment(&entry.title))
                    }
                }
                // Shouldn't happen in this branch, but cover to satisfy exhaustiveness
                Some(EntryKind::Playlist { .. }) | None => dir.join(sanitize_segment(&entry.title)),
            }
        };
        Ok(ProcessResult {
            working_path: st_dir,
            saved_path,
            name: entry.title.clone(),
        })
    })
}

fn extract_chapters_json(v: &serde_json::Value) -> Option<Vec<Chapter>> {
    let arr = v.get("chapters")?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for c in arr {
        let title = c
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let start = c.get("start_time").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
        let end = c
            .get("end_time")
            .and_then(|x| x.as_f64())
            .unwrap_or(start as f64) as f32;
        out.push(Chapter { title, start, end });
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

pub async fn split_audio_by_chapters(
    app: &tauri::AppHandle,
    src: &Path,
    chapters: &[Chapter],
    out_dir: &Path,
    flac: Option<FlacOpts>, // 新增：None => 直接 copy; Some(opts) => 编码为 FLAC
) -> Result<Vec<PathBuf>, String> {
    use tokio::process::Command;

    if !out_dir.exists() {
        fs::create_dir_all(out_dir).map_err(|e| format!("create split dir: {e}"))?;
    }
    let ffmpeg = ensure_ffmpeg(app).map_err(|e| e.to_string())?;

    let mut outs = Vec::with_capacity(chapters.len());
    for ch in chapters {
        // 输出文件名与后缀
        let fname = if flac.is_some() {
            format!("{}.flac", sanitize_segment(&ch.title))
        } else {
            let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("m4a");
            format!("{}.{}", sanitize_segment(&ch.title), ext)
        };
        let outp = out_dir.join(&fname);

        // 组命令
        let mut cmd = Command::new(&ffmpeg);
        cmd.arg("-y")
            .arg("-nostdin")
            // 为了切分更准确，-ss/-to 放在 -i 之后（解码后精确切）
            .arg("-i")
            .arg(src)
            .arg("-ss")
            .arg(format!("{}", ch.start))
            .arg("-to")
            .arg(format!("{}", ch.end))
            .arg("-map")
            .arg("0:a:0?")
            .arg("-vn");

        if let Some(opts) = flac {
            // 直接转成 FLAC
            if opts.copy_metadata {
                cmd.arg("-map_metadata").arg("0");
            } else {
                cmd.arg("-map_metadata").arg("-1");
            }
            cmd.arg("-c:a")
                .arg("flac")
                .arg("-compression_level")
                .arg(opts.compression_level.to_string());
        } else {
            // 仅分割，不转码（最快，但起点需接近关键帧）
            cmd.arg("-c").arg("copy");
            // 可选增强健壮性（避免负时间戳等问题）：
            // cmd.arg("-avoid_negative_ts").arg("make_zero")
            //    .arg("-fflags").arg("+genpts")
            //    .arg("-reset_timestamps").arg("1");
        }

        cmd.arg(&outp);
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("spawn ffmpeg: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffmpeg split failed ({}): {}", outp.display(), err));
        }

        outs.push(outp);
    }
    Ok(outs)
}

// 文件名安全化
fn sanitize_segment(s: &str) -> String {
    let illegal = ['<', '>', '"', ':', '/', '\\', '|', '?', '*'];
    let mut out = String::new();
    for ch in s.chars() {
        if ch.is_control() || illegal.contains(&ch) {
            out.push('_')
        } else {
            out.push(ch)
        }
    }
    out.trim().trim_matches('.').to_string()
}

/// 收集所有叶子文件路径（已下载的 single）
fn collect_leaf_files(e: &Entry, out: &mut Vec<String>) {
    match &e.kind {
        Some(EntryKind::Single { file, status, .. }) => {
            if matches!(status, DownloadStatus::Ok) {
                if let Some(f) = file {
                    out.push(f.clone());
                }
            }
        }
        Some(EntryKind::Playlist { children, .. }) => {
            for c in children {
                collect_leaf_files(c, out);
            }
        }
        _ => {}
    }
}

/// 开发内测命令：下载给定播放列表（只音频 bestaudio）
/// 保存目录固定为 C:\Users\admin\Documents\test
#[tauri::command]
#[specta::specta]
pub async fn test_download_audio(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    // 1) 目标保存目录（Windows）
    let base = PathBuf::from(r"C:\Users\admin\Documents\test");

    // 2) 确保 yt-dlp 就绪（若没有则下载并安装）
    if !installed_bin_path(&app)
        .map_err(|e| e.to_string())?
        .exists()
    {
        let _ = ytdlp_download_and_install(app.clone()).await?;
    }

    // 3) 根 Entry（你给的 URL）
    let url = "https://x.com/i/status/1958162017573020003";
    let mut root = Entry {
        id: Uuid::new_v4(),
        url: url.to_string(),
        title: String::new(),
        retries: 0,
        error: None,
        kind: None,
    };

    // 4) 递归解析 + 下载
    process_entry(app.clone(), &base, &mut root, &[], &[]).await?;

    // 5) 返回所有叶子文件路径，便于在前端直接展示核对
    let mut files = Vec::new();
    collect_leaf_files(&root, &mut files);
    Ok(files)
}

pub fn spawn_resume_on_startup(app: AppHandle, base_save_folder: PathBuf) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = resume_all(&app, &base_save_folder).await {
            eprintln!("[resume] failed: {e}");
        }
    });
}

fn should_resume_with_reason(st: &WorkState) -> (bool, &'static str) {
    match st.status {
        NodeStatus::Pending => (true, "pending"),
        NodeStatus::Downloading => (true, "downloading"),
        NodeStatus::Err => (true, "last_run_error"),
        NodeStatus::Ok => {
            // Ok 但文件可能被删了：也可恢复
            let missing = st
                .children
                .last()
                .and_then(|c| c.file.as_ref())
                .map(|f| !std::path::Path::new(f).exists())
                .unwrap_or(false);
            if missing {
                (true, "ok_but_file_missing")
            } else {
                (false, "already_ok")
            }
        }
    }
}

async fn resume_all(app: &AppHandle, base: &Path) -> Result<(), String> {
    let t0 = Instant::now();

    let work_root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("working_entry");

    if !work_root.exists() {
        println!("[resume] no working_entry dir, nothing to do.");
        return Ok(());
    }

    let mut pendings = Vec::new();
    collect_states(&work_root, &mut pendings)?;
    println!(
        "[resume] scanned {} state.json files under {}",
        pendings.len(),
        work_root.display()
    );

    // 统计分布
    let mut n_pending = 0usize;
    let mut n_dl = 0usize;
    let mut n_err = 0usize;
    let mut n_ok = 0usize;
    for (_, st) in &pendings {
        match st.status {
            NodeStatus::Pending => n_pending += 1,
            NodeStatus::Downloading => n_dl += 1,
            NodeStatus::Err => n_err += 1,
            NodeStatus::Ok => n_ok += 1,
        }
    }
    println!(
        "[resume] status distribution => pending: {}, downloading: {}, err: {}, ok: {}",
        n_pending, n_dl, n_err, n_ok
    );

    // 预筛选并打印将要恢复的节点（含原因）
    let mut to_resume = Vec::new();
    for (st_path, st) in &pendings {
        let (do_resume, why) = should_resume_with_reason(st);
        if do_resume {
            println!(
                "[resume] will resume: id={} title=\"{}\" url={} status={:?} reason={} state={}",
                st.root_id,
                st.title,
                st.url,
                st.status,
                why,
                st_path.display()
            );
            to_resume.push((st_path.clone(), st.clone()));
        } else {
            println!(
                "[resume] skip       : id={} title=\"{}\" status={:?} reason={} state={}",
                st.root_id,
                st.title,
                st.status,
                why,
                st_path.display()
            );
        }
    }
    if to_resume.is_empty() {
        println!("[resume] nothing to resume. elapsed={:?}", t0.elapsed());
        return Ok(());
    }

    // 并发上限
    let concurrency = 8usize;
    println!(
        "[resume] start resuming {} nodes with concurrency={}",
        to_resume.len(),
        concurrency
    );

    // 运行期统计
    let done_ok = AtomicUsize::new(0);
    let done_err = AtomicUsize::new(0);

    futures::stream::iter(to_resume.into_iter())
        .map(|(st_path, st)| {
            let app = app.clone();
            let base = base.to_path_buf();

            async move {
                // 日志：入队
                println!(
                    "[resume] >> run     : id={} title=\"{}\" status={:?}",
                    st.root_id, st.title, st.status
                );

                let mut entry = reconstruct_entry_minimal(&st)?;
                let start = Instant::now();
                let res = process_entry(app.clone(), &base, &mut entry, &[], &[]).await;

                match res {
                    Ok(pr) => {
                        println!(
                            "[resume] << success: id={} title=\"{}\" saved_path={} ...",
                            st.root_id,
                            entry.title,
                            pr.saved_path.display()
                        );
                        finalize_process(&app, pr).await;
                        Ok::<_, String>(true)
                    }
                    Err(e) => {
                        eprintln!(
                            "[resume] <<  failed: id={} title=\"{}\" err={} elapsed={:?}",
                            st.root_id,
                            entry.title,
                            e,
                            start.elapsed()
                        );
                        Err::<bool, String>(e)
                    }
                }
            }
        })
        .buffer_unordered(concurrency)
        .for_each(|r| {
            // 这里在单线程 executor 上跑 closure，统计安全
            if r.is_ok() {
                done_ok.fetch_add(1, Ordering::Relaxed);
            } else {
                done_err.fetch_add(1, Ordering::Relaxed);
            }
            futures::future::ready(())
        })
        .await;

    println!(
        "[resume] finished. ok={} err={} elapsed={:?}",
        done_ok.load(Ordering::Relaxed),
        done_err.load(Ordering::Relaxed),
        t0.elapsed()
    );

    Ok(())
}

fn collect_states(dir: &Path, out: &mut Vec<(PathBuf, WorkState)>) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for e in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let p = e.path();
        if p.is_dir() {
            collect_states(&p, out)?; // 递归
        } else if p.file_name().map(|n| n == "state.json").unwrap_or(false) {
            if let Some(st) = load_state(&p) {
                out.push((p, st));
            }
        }
    }
    Ok(())
}

fn should_resume(st: &WorkState) -> bool {
    match st.status {
        NodeStatus::Pending | NodeStatus::Downloading => true,
        NodeStatus::Err => true, // 也可策略性重试
        NodeStatus::Ok => {
            // 守护：Ok 但文件不存在（例如用户手动删了）→ 也可重跑
            st.children
                .last()
                .and_then(|c| c.file.as_ref())
                .map(|f| !Path::new(f).exists())
                .unwrap_or(false)
        }
    }
}

fn reconstruct_entry_minimal(st: &WorkState) -> Result<Entry, String> {
    Ok(Entry {
        id: st.root_id,
        url: st.url.clone(),
        title: st.title.clone(),
        retries: 0,
        error: st.error.clone(),
        kind: None, // 让 process_entry 自己探测 playlist/single 并填充
    })
}

async fn resume_mission(app: &AppHandle, base: &Path, m: &mut Mission) -> Result<(), String> {
    // 递归地对每个 Entry 调用 process_entry（内部已幂等）
    for e in &mut m.entries {
        let _ = process_entry(app.clone(), base, e, &[], &[]).await;
    }
    Ok(())
}

pub fn auto_resume_mission(app: AppHandle) -> Result<()> {
    let base_folder = resolve_save_path(app.clone()).map_err(anyhow::Error::msg)?;
    // let base_folder = Arc::new(base_folder);
    // 1) 每天 09:00 自动更新 yt-dlp
    spawn_ytdlp_auto_update(app.clone());

    // 2) 启动即尝试恢复未完成任务
    spawn_resume_on_startup(app.clone(), base_folder);

    // 3) （可选）同时恢复 Mission 树（如果你实现了持久化）
    // spawn_resume_all_missions(app.clone(), base_save_folder.clone());
    Ok(())
}
