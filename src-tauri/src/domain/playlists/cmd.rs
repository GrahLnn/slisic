use super::model::{Collection, PlayList};
use appdb::Crud;

#[tauri::command]
#[specta::specta]
pub async fn check_list() -> Result<bool, String> {
    PlayList::exists().await.map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn list_collections() -> Result<Vec<Collection>, String> {
    super::repo::list_collections()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_collection(url: String) -> Result<Option<Collection>, String> {
    super::repo::get_collection_by_url(&url)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn set_collection_updates(
    url: String,
    enabled: bool,
) -> Result<Option<Collection>, String> {
    super::repo::set_collection_updates(&url, enabled)
        .await
        .map_err(|error| error.to_string())
}
