use super::model::MetaInfo;

#[tauri::command]
#[specta::specta]
pub async fn get_meta_info() -> Result<Option<MetaInfo>, String> {
    super::repo::get_meta_info()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn save_meta_info(meta: MetaInfo) -> Result<MetaInfo, String> {
    super::repo::save_meta_info(meta)
        .await
        .map_err(|error| error.to_string())
}
