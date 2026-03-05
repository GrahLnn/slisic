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

fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    dir.push("config.json");
    Ok(dir)
}

fn default_save_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .document_dir()
        .map_err(|e| e.to_string())
        .map(|d| d.join("ransic"))
}

fn persist_config(path: &Path, cfg: &AppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn load_or_init_config(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    let path = config_file_path(app)?;
    match fs::read(&path) {
        Ok(bytes) => {
            let mut cfg: AppConfig = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if cfg.save_path.as_os_str().is_empty() {
                cfg.save_path = default_save_dir(app)?;
                persist_config(&path, &cfg)?;
            }
            Ok(cfg)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let cfg = AppConfig {
                save_path: default_save_dir(app)?,
                version: 1,
            };
            persist_config(&path, &cfg)?;
            Ok(cfg)
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
#[specta::specta]
pub fn resolve_save_path(app: tauri::AppHandle) -> Result<PathBuf, String> {
    let cfg = load_or_init_config(&app)?;
    Ok(cfg.save_path)
}

#[tauri::command]
#[specta::specta]
pub fn update_save_path(app: tauri::AppHandle, new_path: String) -> Result<(), String> {
    let path = PathBuf::from(new_path);
    if path.exists() {
        if !path.is_dir() {
            return Err("save_path must be a directory".to_string());
        }
    } else {
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }

    let file = config_file_path(&app)?;
    let mut cfg = load_or_init_config(&app)?;
    cfg.save_path = path;
    persist_config(&file, &cfg)
}
