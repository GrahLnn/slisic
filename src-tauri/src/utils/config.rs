use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize)]
struct AppConfig {
    save_path: PathBuf,
    version: u32,
}

fn default_version() -> u32 {
    1
}

fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let mut dir = app.path().app_local_data_dir()?;
    fs::create_dir_all(&dir)?; // 确保目录存在
    dir.push("config.json");
    Ok(dir)
}

fn default_save_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    app.path().document_dir().map_err(|e| e.into())
}

/// 加载（或初始化）配置文件；若不存在则用 Documents 作为 save_path 并写入。
fn load_or_init_config(app: &tauri::AppHandle) -> Result<AppConfig> {
    let cfg_path = config_file_path(app)?;

    match fs::read(&cfg_path) {
        Ok(bytes) => {
            // 已存在：反序列化
            let mut cfg: AppConfig = serde_json::from_slice(&bytes)?;
            // 防御：路径丢失/为空时兜底
            if cfg.save_path.as_os_str().is_empty() {
                cfg.save_path = default_save_dir(app)?;
                persist_config(&cfg_path, &cfg)?;
            }
            Ok(cfg)
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            // 不存在：初始化为 Documents
            let cfg = AppConfig {
                save_path: default_save_dir(app)?.join("slisic"),
                version: default_version(),
            };
            persist_config(&cfg_path, &cfg)?;
            Ok(cfg)
        }
        Err(e) => Err(e.into()),
    }
}

fn persist_config(cfg_path: &Path, cfg: &AppConfig) -> Result<()> {
    if let Some(parent) = cfg_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let pretty = serde_json::to_string_pretty(cfg)?;
    fs::write(cfg_path, pretty)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn resolve_save_path(app: tauri::AppHandle) -> Result<PathBuf, String> {
    let cfg = load_or_init_config(&app).map_err(|e| e.to_string())?;
    Ok(cfg.save_path)
}

#[tauri::command]
#[specta::specta]
pub fn update_save_path(app: tauri::AppHandle, new_path: String) -> Result<(), String> {
    let new_path = PathBuf::from(new_path);
    if !new_path.exists() {
        fs::create_dir_all(&new_path).map_err(|e| e.to_string())?;
    } else if !new_path.is_dir() {
        return Err("save_path must be a directory".to_string());
    }

    let cfg_path = config_file_path(&app).map_err(|e| e.to_string())?;
    let mut cfg = load_or_init_config(&app).map_err(|e| e.to_string())?;
    cfg.save_path = new_path;
    persist_config(&cfg_path, &cfg).map_err(|e| e.to_string())
}
