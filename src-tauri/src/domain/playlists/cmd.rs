use super::model::{Collection, Exclude, Music, PlayList};
use crate::domain::player::service::{
    PlaybackTrackIdentityUpdate, update_current_session_track_identity,
};
use tauri::AppHandle;

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
pub async fn delete_playlist(name: String) -> Result<bool, String> {
    super::repo::delete_playlist_by_name(&name)
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
pub async fn update_music(
    url: String,
    start_ms: u32,
    end_ms: u32,
    alias: String,
    next_start_ms: u32,
    next_end_ms: u32,
) -> Result<Option<Music>, String> {
    let updated =
        super::repo::update_music(&url, start_ms, end_ms, &alias, next_start_ms, next_end_ms)
            .await
            .map_err(|error| error.to_string())?;

    if let Some(music) = updated.as_ref() {
        update_current_session_track_identity(&PlaybackTrackIdentityUpdate {
            music_name: music.alias.clone(),
            music_url: url,
            start_ms,
            end_ms,
            next_start_ms: music.start_ms,
            next_end_ms: music.end_ms,
        })
        .map_err(|error| error.to_string())?;
    }

    Ok(updated)
}

#[tauri::command]
#[specta::specta]
pub async fn list_musics_by_file_path(
    app: AppHandle,
    file_path: String,
) -> Result<Vec<Music>, String> {
    let save_root = crate::domain::meta::service::resolve_save_root(&app)
        .await
        .map_err(|error| error.to_string())?;

    super::repo::list_musics_by_file_path(std::path::Path::new(&file_path), &save_root)
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
