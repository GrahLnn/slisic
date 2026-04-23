use appdb::{AutoFill, Store};
use serde::{Deserialize, Serialize};
use specta::Type;
use surrealdb_types::SurrealValue;

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct PlayList {
    #[unique]
    pub name: String,
    #[foreign]
    pub collections: Vec<Collection>,
    #[foreign]
    pub groups: Vec<Group>,
    #[pagin]
    #[fill(now)]
    pub created_at: AutoFill,
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct Collection {
    pub name: String,
    #[unique]
    pub url: String,
    pub folder: String,
    #[relate("includes")]
    pub musics: Vec<Music>,
    pub last_updated: String,
    pub enable_updates: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct Group {
    pub name: String,
    #[unique]
    pub url: String,
    pub folder: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct Music {
    pub name: String,
    #[back_relate("grouped")]
    pub group: Group,
    pub url: String,
    pub path: Option<String>,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct Exclude {
    #[foreign]
    pub music: Music,
}
