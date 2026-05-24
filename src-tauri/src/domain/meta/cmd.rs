use super::model::MetaInfo;
use tauri::AppHandle;

fn default_save_path(app: &AppHandle) -> Result<String, String> {
    Ok(super::service::default_save_root(app)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_meta_info(app: AppHandle) -> Result<Option<MetaInfo>, String> {
    super::repo::ensure_meta_info(default_save_path(&app)?)
        .await
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn save_meta_info(app: AppHandle, meta: MetaInfo) -> Result<MetaInfo, String> {
    super::repo::save_meta_info(super::repo::resolve_meta_info(
        Some(meta),
        default_save_path(&app)?,
    ))
    .await
    .map_err(|error| error.to_string())
}
