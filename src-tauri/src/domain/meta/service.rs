use anyhow::{Context, Result, anyhow};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const DEFAULT_SAVE_FOLDER_NAME: &str = "slisic";

pub fn default_save_root(app: &AppHandle) -> Result<PathBuf> {
    let document_dir = app.path().document_dir().map_err(|error| anyhow!(error))?;
    Ok(document_dir.join(DEFAULT_SAVE_FOLDER_NAME))
}

pub async fn resolve_save_root(app: &AppHandle) -> Result<PathBuf> {
    let default_root = default_save_root(app)?;
    let meta = super::repo::ensure_meta_info(default_root.to_string_lossy().to_string()).await?;
    let save_path = meta
        .save_path
        .ok_or_else(|| anyhow!("save path should always be configured"))?;
    let root = PathBuf::from(save_path);
    std::fs::create_dir_all(&root)
        .with_context(|| format!("failed to create {}", root.display()))?;
    Ok(root)
}
