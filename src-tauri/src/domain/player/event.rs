use super::model::PlaybackTrackPayload;
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
    pub liked: bool,
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
            liked: value.liked,
        }
    }
}
