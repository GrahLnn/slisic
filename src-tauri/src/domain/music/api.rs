use super::service;
use super::types::{CollectMission, Entry, Music, Playlist};
use tauri::AppHandle;

#[tauri::command]
#[specta::specta]
pub async fn create(app: AppHandle, data: CollectMission) -> Result<(), String> {
    service::create(app, data).await
}

#[tauri::command]
#[specta::specta]
pub async fn read(name: String) -> Result<Playlist, String> {
    service::read(name).await
}

#[tauri::command]
#[specta::specta]
pub async fn read_all() -> Result<Vec<Playlist>, String> {
    service::read_all().await
}

#[tauri::command]
#[specta::specta]
pub async fn update(app: AppHandle, data: CollectMission, anchor: Playlist) -> Result<(), String> {
    service::update(app, data, anchor).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete(name: String) -> Result<(), String> {
    service::delete(name).await
}

#[tauri::command]
#[specta::specta]
pub async fn fatigue(music: Music) -> Result<(), String> {
    service::fatigue(music).await
}

#[tauri::command]
#[specta::specta]
pub async fn boost(music: Music) -> Result<(), String> {
    service::boost(music).await
}

#[tauri::command]
#[specta::specta]
pub async fn cancle_boost(music: Music) -> Result<(), String> {
    service::cancle_boost(music).await
}

#[tauri::command]
#[specta::specta]
pub async fn cancle_fatigue(music: Music) -> Result<(), String> {
    service::cancle_fatigue(music).await
}

#[tauri::command]
#[specta::specta]
pub async fn unstar(list: Playlist, music: Music) -> Result<(), String> {
    service::unstar(list, music).await
}

#[tauri::command]
#[specta::specta]
pub async fn reset_logits() -> Result<(), String> {
    service::reset_logits().await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_music(music: Music) -> Result<(), String> {
    service::delete_music(music).await
}

#[tauri::command]
#[specta::specta]
pub async fn recheck_folder(entry: Entry) -> Result<Entry, String> {
    service::recheck_folder(entry).await
}

#[tauri::command]
#[specta::specta]
pub async fn rmexclude(list: Playlist, music: Music) -> Result<(), String> {
    service::rmexclude(list, music).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_weblist(
    app: AppHandle,
    entry: Entry,
    playlist: String,
) -> Result<Entry, String> {
    service::update_weblist(app, entry, playlist).await
}
