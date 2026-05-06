use super::model::{PlaybackContinuationMode, PlaybackTrackPayload};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct NowPlayingTrackChangedEvent {
    pub playlist_name: String,
    pub music_name: String,
    pub music_url: String,
    pub file_path: String,
    pub start_ms: u32,
    pub end_ms: u32,
}

impl From<PlaybackTrackPayload> for NowPlayingTrackChangedEvent {
    fn from(value: PlaybackTrackPayload) -> Self {
        Self {
            playlist_name: value.playlist_name,
            music_name: value.music_name,
            music_url: value.music_url,
            file_path: value.file_path,
            start_ms: value.start_ms,
            end_ms: value.end_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PlaybackTraceEvent {
    pub event: String,
    pub generation: Option<u64>,
    pub mode: Option<PlaybackContinuationMode>,
    pub path: Option<String>,
    pub status_path: Option<String>,
    pub playlist_name: Option<String>,
    pub music_url: Option<String>,
    pub start_ms: Option<u32>,
    pub end_ms: Option<u32>,
    pub position_ms: Option<u32>,
    pub duration_ms: Option<u32>,
    pub reason: Option<String>,
}

impl PlaybackTraceEvent {
    pub fn new(event: impl Into<String>) -> Self {
        Self {
            event: event.into(),
            generation: None,
            mode: None,
            path: None,
            status_path: None,
            playlist_name: None,
            music_url: None,
            start_ms: None,
            end_ms: None,
            position_ms: None,
            duration_ms: None,
            reason: None,
        }
    }
}
