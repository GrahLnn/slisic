use super::model::{PlayPlaylistSession, PlayPlaylistSessionStatus};
use tauri::AppHandle;

#[tauri::command]
#[specta::specta]
pub async fn play_playlist(app: AppHandle, name: String) -> Result<PlayPlaylistSession, String> {
    match super::service::play_playlist(&app, name.clone()).await {
        Ok(session) => Ok(session),
        Err(error)
            if crate::domain::player::service::is_playback_start_request_superseded(&error) =>
        {
            Ok(PlayPlaylistSession {
                status: PlayPlaylistSessionStatus::Superseded,
                playlist_name: name,
                track_count: 0,
            })
        }
        Err(error) => Err(error.to_string()),
    }
}
