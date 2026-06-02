use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

use crate::domain::playlists::model::Music;

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
    pub canonical_music_id: String,
    pub music_url: String,
    pub file_path: String,
    pub start_ms: u32,
    pub end_ms: u32,
    pub liked: bool,
    pub loudness: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SpectrumPlaybackLoopSignalPayload {
    pub track: PlaybackTrackPayload,
    pub start_ms: u32,
    pub end_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackTrackProjectionError {
    EmptyFilePath,
    EmptyMusicUrl,
    EmptyPlaylistName,
    InvalidRange,
}

impl std::fmt::Display for PlaybackTrackProjectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyFilePath => formatter.write_str("file path is empty"),
            Self::EmptyMusicUrl => formatter.write_str("music url is empty"),
            Self::EmptyPlaylistName => formatter.write_str("playlist name is empty"),
            Self::InvalidRange => formatter.write_str("start_ms must be less than end_ms"),
        }
    }
}

impl std::error::Error for PlaybackTrackProjectionError {}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlaybackStatusPayload {
    pub path: Option<String>,
    pub playing: bool,
    pub paused: bool,
    pub position_ms: u32,
    pub duration_ms: Option<u32>,
    pub playlist_name: Option<String>,
    pub music_url: Option<String>,
    pub track_start_ms: Option<u32>,
    pub track_end_ms: Option<u32>,
    pub playback_start_ms: Option<u32>,
    pub playback_end_ms: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ActivePlaybackRange {
    pub(crate) start_ms: u32,
    pub(crate) end_ms: u32,
}

#[derive(Debug, Clone)]
pub struct PlaybackTrack {
    pub playlist_name: String,
    pub music_name: String,
    pub canonical_music_id: String,
    pub music_url: String,
    pub file_path: PathBuf,
    pub source_music: Option<Box<Music>>,
    pub start_ms: u32,
    pub end_ms: u32,
    pub liked: bool,
    pub loudness: f32,
}

impl PlaybackTrack {
    pub fn try_from_payload(
        payload: PlaybackTrackPayload,
    ) -> Result<Self, PlaybackTrackProjectionError> {
        if payload.playlist_name.is_empty() {
            return Err(PlaybackTrackProjectionError::EmptyPlaylistName);
        }

        if payload.music_url.is_empty() {
            return Err(PlaybackTrackProjectionError::EmptyMusicUrl);
        }

        if payload.file_path.is_empty() {
            return Err(PlaybackTrackProjectionError::EmptyFilePath);
        }

        if payload.start_ms >= payload.end_ms {
            return Err(PlaybackTrackProjectionError::InvalidRange);
        }

        Ok(Self {
            playlist_name: payload.playlist_name,
            music_name: payload.music_name,
            canonical_music_id: payload.canonical_music_id,
            music_url: payload.music_url,
            file_path: PathBuf::from(payload.file_path),
            source_music: None,
            start_ms: payload.start_ms,
            end_ms: payload.end_ms,
            liked: payload.liked,
            loudness: payload.loudness,
        })
    }

    pub fn to_payload(&self) -> PlaybackTrackPayload {
        PlaybackTrackPayload {
            playlist_name: self.playlist_name.clone(),
            music_name: self.music_name.clone(),
            canonical_music_id: self.canonical_music_id.clone(),
            music_url: self.music_url.clone(),
            file_path: self.file_path.to_string_lossy().to_string(),
            start_ms: self.start_ms,
            end_ms: self.end_ms,
            liked: self.liked,
            loudness: self.loudness,
        }
    }
}
