use super::model::{
    ExcludeCurrentMusicAndSkipResult, PlayPlaylistSession, PlayPlaylistSessionStatus,
};
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
                session_generation: None,
                track_count: 0,
                initial_track: None,
            })
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn refresh_playable_index() {
    super::playable_index::request_ready_refresh();
}

#[tauri::command]
#[specta::specta]
pub async fn exclude_current_music_and_skip(
    app: AppHandle,
) -> Result<ExcludeCurrentMusicAndSkipResult, String> {
    super::service::exclude_current_music_and_skip(&app)
        .await
        .map_err(|error| error.to_string())
}
