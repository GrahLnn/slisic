use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlayPlaylistSession {
    pub status: PlayPlaylistSessionStatus,
    pub playlist_name: String,
    pub track_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PlayPlaylistSessionStatus {
    Started,
    Superseded,
}
