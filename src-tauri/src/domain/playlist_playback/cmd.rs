use super::model::PlayPlaylistSession;
use tauri::AppHandle;

#[tauri::command]
#[specta::specta]
pub async fn play_playlist(app: AppHandle, name: String) -> Result<PlayPlaylistSession, String> {
    super::service::play_playlist(&app, name)
        .await
        .map_err(|error| error.to_string())
}
