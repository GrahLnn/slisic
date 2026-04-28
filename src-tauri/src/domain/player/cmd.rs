use super::model::PlaybackContinuationMode;

#[tauri::command]
#[specta::specta]
pub fn set_playback_continuation_mode(mode: PlaybackContinuationMode) -> Result<(), String> {
    super::service::set_playback_continuation_mode(mode).map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn stop_playback() -> Result<bool, String> {
    super::service::stop_playback()
        .await
        .map_err(|error| error.to_string())
}
