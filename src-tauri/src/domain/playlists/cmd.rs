use super::model::PlayList;
use appdb::Crud;

#[tauri::command]
#[specta::specta]
pub async fn check_list() -> Result<bool, String> {
    PlayList::exists().await.map_err(|err| err.to_string())
}
