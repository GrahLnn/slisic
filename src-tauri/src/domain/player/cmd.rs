use super::model::{
    PlaybackContinuationMode, PlaybackStatusPayload, PlaybackTrackPayload,
    SpectrumPlaybackLoopSignalPayload,
};
use super::waveform::{TrackWaveform, TrackWaveformSummary, TrackWaveformTile};
use tauri::AppHandle;

#[tauri::command]
#[specta::specta]
pub fn set_playback_continuation_mode(mode: PlaybackContinuationMode) -> Result<(), String> {
    super::service::set_playback_continuation_mode(mode).map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn enter_spectrum_playback_scope() -> Result<u64, String> {
    super::service::enter_spectrum_playback_scope().map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn exit_spectrum_playback_scope(scope_id: u64) -> Result<(), String> {
    super::service::exit_spectrum_playback_scope(scope_id).map_err(|error| error.to_string())
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
pub async fn pause_playback() -> Result<bool, String> {
    super::service::pause_playback()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn resume_playback() -> Result<bool, String> {
    super::service::resume_playback()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn play_spectrum_music(
    scope_id: u64,
    track: PlaybackTrackPayload,
    position_ms: Option<u32>,
) -> Result<bool, String> {
    super::service::play_spectrum_music(
        scope_id,
        super::model::PlaybackTrack::try_from_payload(track)
            .map_err(|error| format!("invalid playback track payload: {error}"))?,
        position_ms,
    )
    .await
    .map(|_| true)
    .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn restore_spectrum_music(
    scope_id: u64,
    track: PlaybackTrackPayload,
    position_ms: Option<u32>,
) -> Result<bool, String> {
    super::service::restore_spectrum_music(
        scope_id,
        super::model::PlaybackTrack::try_from_payload(track)
            .map_err(|error| format!("invalid playback track payload: {error}"))?,
        position_ms,
    )
    .await
    .map(|_| true)
    .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn pause_spectrum_music(
    scope_id: u64,
    track: PlaybackTrackPayload,
) -> Result<bool, String> {
    super::service::pause_spectrum_music(
        scope_id,
        super::model::PlaybackTrack::try_from_payload(track)
            .map_err(|error| format!("invalid playback track payload: {error}"))?,
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn resume_spectrum_music(
    scope_id: u64,
    track: PlaybackTrackPayload,
) -> Result<bool, String> {
    super::service::resume_spectrum_music(
        scope_id,
        super::model::PlaybackTrack::try_from_payload(track)
            .map_err(|error| format!("invalid playback track payload: {error}"))?,
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn update_spectrum_playback_loop_signal(
    scope_id: u64,
    payload: SpectrumPlaybackLoopSignalPayload,
) -> Result<Option<PlaybackStatusPayload>, String> {
    super::service::update_spectrum_playback_loop_signal(
        scope_id,
        super::model::PlaybackTrack::try_from_payload(payload.track)
            .map_err(|error| format!("invalid spectrum loop signal track: {error}"))?,
        payload.start_ms,
        payload.end_ms,
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn begin_playback_seek() -> Result<Option<PlaybackStatusPayload>, String> {
    super::service::begin_playback_seek()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_playback_seek() -> Result<Option<PlaybackStatusPayload>, String> {
    super::service::cancel_playback_seek()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn seek_playback(
    position_ms: u32,
    end_ms: u32,
) -> Result<Option<PlaybackStatusPayload>, String> {
    super::service::seek_playback(position_ms, end_ms)
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
