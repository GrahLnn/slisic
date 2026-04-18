use super::model::{Collection, Exclude, Music, PlayList};

#[tauri::command]
#[specta::specta]
pub async fn check_list() -> Result<bool, String> {
    super::repo::has_collections()
        .await
        .map_err(|error| error.to_string())
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
pub async fn list_playlists() -> Result<Vec<PlayList>, String> {
    super::repo::list_playlists()
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
pub async fn get_playlist(name: String) -> Result<Option<PlayList>, String> {
    super::repo::get_playlist_by_name(&name)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn upsert_playlist(
    previous_name: Option<String>,
    playlist: PlayList,
) -> Result<PlayList, String> {
    super::repo::upsert_playlist(&playlist, previous_name.as_deref())
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

#[tauri::command]
#[specta::specta]
pub async fn add_exclude(music: Music) -> Result<Exclude, String> {
    super::repo::add_exclude(music)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn remove_exclude(music: Music) -> Result<bool, String> {
    super::repo::remove_exclude(&music)
        .await
        .map_err(|error| error.to_string())
}
