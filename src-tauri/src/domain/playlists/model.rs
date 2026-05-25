use appdb::{AutoFill, Crud, Store, View};
use serde::{Deserialize, Serialize};
use specta::Type;
use surrealdb::types::RecordId;
use surrealdb_types::SurrealValue;

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct PlayList {
    #[unique]
    pub name: String,
    #[foreign]
    pub collections: Vec<Collection>,
    #[foreign]
    pub groups: Vec<Group>,
    #[foreign]
    pub extra: Vec<Music>,
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
    #[view(nested)]
    pub extra: Vec<Music>,
    pub created_at: AutoFill,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct ConfigLibraryView {
    pub collections: Vec<CollectionSurfaceView>,
    pub groups: Vec<GroupSurfaceView>,
    pub excludes: Vec<Exclude>,
    pub exclude_availability: ExcludeAvailability,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct ExcludeAvailability {
    pub fully_excluded_collection_urls: Vec<String>,
    pub fully_excluded_group_urls: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct AddExcludeResult {
    pub exclude: Exclude,
    pub exclude_availability: ExcludeAvailability,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct RemoveExcludeResult {
    pub removed: bool,
    pub exclude_availability: ExcludeAvailability,
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct Music {
    pub name: String,
    pub alias: String,
    #[back_relate("grouped")]
    pub group: Group,
    pub canonical_music_id: String,
    pub url: String,
    pub path: Option<String>,
    pub start_ms: u32,
    pub end_ms: u32,
    pub liked: bool,
}

#[async_trait::async_trait]
impl appdb::ViewShape for Music {
    type Stored = RecordId;

    async fn hydrate_view_shape(stored: Self::Stored) -> anyhow::Result<Self> {
        Music::get_record(stored).await
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, View, Type)]
#[view(source = Music)]
pub struct MusicSpectrumView {
    pub name: String,
    pub alias: String,
    pub canonical_music_id: String,
    pub url: String,
    pub path: Option<String>,
    pub start_ms: u32,
    pub end_ms: u32,
    pub liked: bool,
}

impl MusicSpectrumView {
    pub fn into_music(self, group: Group) -> Music {
        Music {
            name: self.name,
            alias: self.alias,
            group,
            canonical_music_id: self.canonical_music_id,
            url: self.url,
            path: self.path,
            start_ms: self.start_ms,
            end_ms: self.end_ms,
            liked: self.liked,
        }
    }
}

pub fn canonical_music_id_for_source(url: &str, start_ms: u32, end_ms: u32) -> String {
    format!("source:{}:{}:{}", url.trim(), start_ms, end_ms)
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct SpectrumMusicSourceContext {
    pub source_collection_url: String,
    pub source_end_ms: u32,
    pub source_group: Group,
    pub source_path: Option<String>,
    pub source_start_ms: u32,
    pub source_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct SpectrumMusicContext {
    pub file_musics: Vec<Music>,
    pub source: Option<SpectrumMusicSourceContext>,
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct Exclude {
    #[foreign]
    pub music: Music,
    #[pagin]
    #[fill(now)]
    pub created_at: AutoFill,
}
