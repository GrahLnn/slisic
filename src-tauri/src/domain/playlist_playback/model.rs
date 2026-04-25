use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlayPlaylistSession {
    pub playlist_name: String,
    pub track_count: u32,
}
