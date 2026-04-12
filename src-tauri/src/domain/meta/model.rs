use appdb::{Id, Store};
use serde::{Deserialize, Serialize};
use specta::Type;
use surrealdb_types::SurrealValue;

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct MetaInfo {
    // pub ffmpeg_path: Option<String>,
    // pub ytdlp_path: Option<String>,
    pub save_path: Option<String>,
}
