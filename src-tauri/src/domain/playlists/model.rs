use appdb::{AutoFill, Store, View};
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

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, View, Type)]
#[view(source = PlayList)]
pub struct PlayListListView {
    pub name: String,
    pub created_at: AutoFill,
}

impl From<PlayList> for PlayListListView {
    fn from(value: PlayList) -> Self {
        Self {
            name: value.name,
            created_at: value.created_at,
        }
    }
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

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, View, Type)]
#[view(source = Collection)]
pub struct CollectionSurfaceView {
    pub name: String,
    pub url: String,
    pub folder: String,
    pub last_updated: String,
    pub enable_updates: Option<bool>,
}

impl From<Collection> for CollectionSurfaceView {
    fn from(value: Collection) -> Self {
        Self {
            name: value.name,
            url: value.url,
            folder: value.folder,
            last_updated: value.last_updated,
            enable_updates: value.enable_updates,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct Group {
    pub name: String,
    #[unique]
    pub url: String,
    pub folder: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, View, Type)]
#[view(source = Group)]
pub struct GroupSurfaceView {
    pub name: String,
    pub url: String,
    pub folder: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, View, Type)]
#[view(source = PlayList)]
pub struct PlayListConfigView {
    pub name: String,
    #[view(nested)]
    pub collections: Vec<CollectionSurfaceView>,
    #[view(nested)]
    pub groups: Vec<GroupSurfaceView>,
    pub created_at: AutoFill,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct ConfigLibraryView {
    pub collections: Vec<CollectionSurfaceView>,
    pub groups: Vec<GroupSurfaceView>,
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct Music {
    pub name: String,
    pub alias: String,
    #[back_relate("grouped")]
    pub group: Group,
    pub url: String,
    pub path: Option<String>,
    pub start_ms: u32,
    pub end_ms: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct Exclude {
    #[foreign]
    pub music: Music,
    #[pagin]
    #[fill(now)]
    pub created_at: AutoFill,
}
