use serde::{Deserialize, Serialize};
use specta::Type;

use crate::domain::playlists::model::{Exclude, ExcludeAvailability};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlayPlaylistSession {
    pub status: PlayPlaylistSessionStatus,
    pub playlist_name: String,
    pub session_generation: Option<u64>,
    pub track_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PlayPlaylistSessionStatus {
    Started,
    PendingFirstTrack,
    Superseded,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum ExcludeCurrentMusicAndSkipResult {
    Skipped {
        exclude: Exclude,
        exclude_availability: ExcludeAvailability,
    },
    DeletedPlaylist {
        playlist_name: String,
        exclude: Exclude,
        exclude_availability: ExcludeAvailability,
    },
    NoActiveTrack,
    MissingMusic,
}
