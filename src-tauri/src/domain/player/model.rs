use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackContinuationMode {
    Random,
    RepeatCurrent,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlaybackTrackPayload {
    pub playlist_name: String,
    pub music_name: String,
    pub music_url: String,
    pub file_path: String,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlaybackStatusPayload {
    pub path: Option<String>,
    pub playing: bool,
    pub paused: bool,
    pub position_ms: u32,
    pub duration_ms: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct PlaybackTrack {
    pub playlist_name: String,
    pub music_name: String,
    pub music_url: String,
    pub file_path: PathBuf,
    pub start: u32,
    pub end: u32,
}

impl PlaybackTrack {
    pub fn to_payload(&self) -> PlaybackTrackPayload {
        PlaybackTrackPayload {
            playlist_name: self.playlist_name.clone(),
            music_name: self.music_name.clone(),
            music_url: self.music_url.clone(),
            file_path: self.file_path.to_string_lossy().to_string(),
            start: self.start,
            end: self.end,
        }
    }
}
