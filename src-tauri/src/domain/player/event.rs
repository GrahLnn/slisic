use super::model::PlaybackTrackPayload;
use crate::domain::playlists::model::Exclude;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct NowPlayingTrackChangedEvent {
    pub playlist_name: String,
    pub music_name: String,
    pub canonical_music_id: String,
    pub music_url: String,
    pub file_path: String,
    pub start_ms: u32,
    pub end_ms: u32,
    pub liked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PlaybackDiagnosticTraceEvent {
    pub event: String,
    pub playlist_name: Option<String>,
    pub music_name: Option<String>,
    pub music_url: Option<String>,
    pub start_ms: Option<u32>,
    pub end_ms: Option<u32>,
    pub elapsed_ms: Option<u128>,
    pub candidate_count: Option<usize>,
    pub queue_count: Option<usize>,
    pub status: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PlaybackExcludeCommittedEvent {
    pub exclude: Exclude,
}

impl From<PlaybackTrackPayload> for NowPlayingTrackChangedEvent {
    fn from(value: PlaybackTrackPayload) -> Self {
        Self {
            playlist_name: value.playlist_name,
            music_name: value.music_name,
            canonical_music_id: value.canonical_music_id,
            music_url: value.music_url,
            file_path: value.file_path,
            start_ms: value.start_ms,
            end_ms: value.end_ms,
            liked: value.liked,
        }
    }
}
