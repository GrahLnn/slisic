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
};

use fs2::FileExt;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::utils::{
    ffmpeg::{ensure_ffmpeg, transcode_to_flac, FlacOpts},
    file::{bin_dir, http, make_executable, remove_quarantine, InstallResult},
};
use futures::stream::{self, StreamExt};
use tauri::Manager;
use tauri_specta::Event;
use tokio::process::Command;
use uuid::Uuid;

const GH_API_LATEST: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const GH_DL_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const GH_SUMS: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";

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
    // 1) 找 yt-dlp
    let exe = installed_bin_path(&app).map_err(|e| e.to_string())?;
    if !exe.exists() {
        return Err("yt-dlp not found, please install/download first".into());
    }

    // 2) 准备保存目录
    if !save_dir.exists() {
        fs::create_dir_all(&save_dir).map_err(|e| format!("create dir failed: {e}"))?;
    } else if !save_dir.is_dir() {
        return Err(format!(
            "save_dir is not a directory: {}",
            save_dir.to_string_lossy()
        ));
    }

    // 3) 输出模板：让 yt-dlp 自己决定扩展名
    // 注意：不要自己猜扩展名，bestaudio 可能是 webm/opus、m4a、aac…不固定。
    let out_tmpl = save_dir.join("%(title)s.m4a");
    let out_tmpl = out_tmpl.to_string_lossy().to_string();

    // 4) 运行 yt-dlp
    // 关键点：
    // -f bestaudio          仅选最佳音轨，不做容器转换
    // --no-playlist         只下单个条目（你也可以去掉让它跟随列表）
    // --no-part             避免 .part 残留
    // --print after_move:filepath  下载完成、移动到最终位置后打印最终文件路径
    // （某些情况下不会触发 move，可按需再加一个 before_dl:filepath 兜底）
    let output = Command::new(&exe)
        .arg("-f")
        .arg("bestaudio")
        .arg("--no-playlist")
        .arg("--no-part")
        .arg("-o")
        .arg(&out_tmpl)
        .arg("--print")
        .arg("after_move:filepath")
        .arg(&url)
        .output()
        .await
        .map_err(|e| format!("execute yt-dlp failed: {e}"))?;

    // 5) 错误处理（复用你上个函数的风格）
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Some(line) = stderr.lines().rev().find(|l| l.contains("ERROR:")) {
            return Err(line
                .to_string()
                .replace("ERROR: ", "")
                .replace(&format!(": {url}"), ""));
        } else {
            return Err(format!("yt-dlp failed: {}", stderr));
        }
    }

    // 6) 解析 stdout 拿最终文件路径
    // --print 会把路径打印到 stdout 的一行；取最后一个非空行最稳妥
    let stdout = String::from_utf8(output.stdout)
        .unwrap_or_else(|v| String::from_utf8_lossy(&v.into_bytes()).into_owned());
    let final_path_line = stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .ok_or_else(|| "yt-dlp did not print final filepath".to_string())?;

    let final_path = Path::new(final_path_line).to_path_buf();

    // 7) 兜底校验：如果没有这个文件，可能是没有触发 move（极少数容器直写）
    // 这时再用模板猜测一下最接近的文件（可选）。这里直接强校验存在性更“实话实说”。
    if !final_path.exists() {
        return Err(format!(
            "download finished but file not found at printed path: {}",
            final_path.display()
        ));
    }

    Ok(final_path)
}

#[tauri::command]
#[specta::specta]
pub async fn look_media(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let v = flat_data(app, url).await?;
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "title filed not found".to_string())?;

    Ok(title.to_string())
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

            let to_flac = false;
            let flac_opts = FlacOpts {
                compression_level: 8,
                keep_source: false,
                copy_metadata: true,
            };
            let chapters = extract_chapters_json(&v);
            let whole_path = {
                let candidate = dir.join(format!("{}.m4a", entry.title));
                if candidate.exists() {
                    candidate
                } else {
                    download_audio(app.clone(), entry.url.clone(), dir.clone()).await?
                }
            };

            if let Some(ref chs) = chapters {
                let mut chapter_dir = dir.clone();
                chapter_dir.push(sanitize_segment(&entry.title));
                let _outs = split_audio_by_chapters(
                    &app,
                    &whole_path,
                    chs,
                    &chapter_dir,
                    if to_flac { Some(flac_opts) } else { None },
                )
                .await?;
                let _ = std::fs::remove_file(&whole_path);

                entry.kind = Some(EntryKind::Single {
                    file: Some(whole_path.to_string_lossy().into_owned()),
                    chapters: Some(chs.clone()),
                    status: DownloadStatus::Ok,
                });
            } else {
                let final_file = if to_flac {
                    transcode_to_flac(&app, &whole_path, flac_opts).await?
                } else {
                    whole_path.clone()
                };
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
