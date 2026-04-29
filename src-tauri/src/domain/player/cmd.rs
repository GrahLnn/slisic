use super::model::{PlaybackContinuationMode, PlaybackStatusPayload};
use super::waveform::{TrackWaveform, TrackWaveformSummary, TrackWaveformTile};
use tauri::AppHandle;

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

#[tauri::command]
#[specta::specta]
pub async fn get_playback_status() -> Result<Option<PlaybackStatusPayload>, String> {
    super::service::get_playback_status()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn analyze_track_waveform(
    app: AppHandle,
    file_path: String,
    start: Option<u32>,
    end: Option<u32>,
) -> Result<TrackWaveform, String> {
    super::service::analyze_track_waveform(&app, file_path, start, end)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn prepare_track_waveform(
    app: AppHandle,
    file_path: String,
    start: Option<u32>,
    end: Option<u32>,
) -> Result<TrackWaveformSummary, String> {
    super::service::prepare_track_waveform(&app, file_path, start, end)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_track_waveform_tile(
    app: AppHandle,
    file_path: String,
    start: Option<u32>,
    end: Option<u32>,
    pixels_per_second: f64,
    tile_start_px: u32,
    tile_width: u32,
) -> Result<TrackWaveformTile, String> {
    super::service::get_track_waveform_tile(
        &app,
        file_path,
        start,
        end,
        pixels_per_second,
        tile_start_px,
        tile_width,
    )
    .await
    .map_err(|error| error.to_string())
}
