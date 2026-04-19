use super::model::PlayPlaylistSession;

#[tauri::command]
#[specta::specta]
pub async fn play_playlist(name: String) -> Result<PlayPlaylistSession, String> {
    super::service::play_playlist(name)
        .await
        .map_err(|error| error.to_string())
}
