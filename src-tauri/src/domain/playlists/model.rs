use appdb::model::meta::{ModelMeta, ViewParams};
use appdb::query::RawSqlStmt;
use appdb::{AutoFill, Crud, Store, View};
use serde::{Deserialize, Serialize};
use specta::Type;
use surrealdb::types::{RecordId, Table};
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

/// Behavior:
///   Playlist write requests carry UI-selected library refs, not stored
///   collection/group rows. The playlist repository owns the projection from
///   these refs to canonical record ids and rejects missing refs explicitly.
///
/// Core invariants:
///   - UI code cannot construct `Group.collection`; that evidence belongs to
///     the persisted `Collection -> include -> Group` graph.
///   - Cache, fallback, and draft surfaces are not allowed to materialize
///     stable playlist storage rows.
///   - Repeating the same request resolves to the same referenced records.
#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct PlayListWriteRequest {
    pub name: String,
    pub collections: Vec<PlaylistCollectionRef>,
    pub groups: Vec<PlaylistGroupRef>,
    pub extra: Vec<Music>,
    pub created_at: AutoFill,
}

impl PlayListWriteRequest {
    #[cfg(test)]
    pub(crate) fn from_playlist(playlist: &PlayList) -> Self {
        Self {
            name: playlist.name.clone(),
            collections: playlist
                .collections
                .iter()
                .map(PlaylistCollectionRef::from)
                .collect(),
            groups: playlist.groups.iter().map(PlaylistGroupRef::from).collect(),
            extra: playlist.extra.clone(),
            created_at: playlist.created_at.clone(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct PlaylistCollectionRef {
    pub name: String,
    pub url: String,
    pub folder: String,
    pub last_updated: String,
    pub enable_updates: Option<bool>,
}

impl From<&Collection> for PlaylistCollectionRef {
    fn from(value: &Collection) -> Self {
        Self {
            name: value.name.clone(),
            url: value.url.clone(),
            folder: value.folder.clone(),
            last_updated: value.last_updated.clone(),
            enable_updates: value.enable_updates,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct PlaylistGroupRef {
    pub name: String,
    pub url: String,
    pub folder: String,
}

impl From<&Group> for PlaylistGroupRef {
    fn from(value: &Group) -> Self {
        Self {
            name: value.name.clone(),
            url: value.url.clone(),
            folder: value.folder.clone(),
        }
    }
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

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Type)]
pub struct CollectionGroupOwner {
    pub name: String,
    pub url: String,
    pub folder: String,
    pub last_updated: String,
    pub enable_updates: Option<bool>,
}

impl From<&Collection> for CollectionGroupOwner {
    fn from(value: &Collection) -> Self {
        Self {
            name: value.name.clone(),
            url: value.url.clone(),
            folder: value.folder.clone(),
            last_updated: value.last_updated.clone(),
            enable_updates: value.enable_updates,
        }
    }
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
    #[back_relate("include")]
    pub collection: CollectionGroupOwner,
    pub folder: String,
}

impl Group {
    pub fn bind_collection(mut self, collection: &Collection) -> Self {
        self.collection = CollectionGroupOwner::from(collection);
        self
    }

    pub fn bind_collection_owner(mut self, collection: CollectionGroupOwner) -> Self {
        self.collection = collection;
        self
    }
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
    pub collection_group_memberships: Vec<CollectionGroupMembershipView>,
    pub excludes: Vec<Exclude>,
    pub exclude_availability: ExcludeAvailability,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, SurrealValue)]
pub struct CollectionGroupMembershipView {
    pub collection_url: String,
    pub group_url: String,
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
    #[unique]
    #[serde(default)]
    pub occurrence_id: String,
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
    #[serde(default)]
    pub loudness_profile: Option<LoudnessProfile>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, SurrealValue, Type)]
pub struct LoudnessProfile {
    pub integrated_lufs: f32,
    #[serde(default)]
    pub true_peak_dbtp: Option<f32>,
    #[serde(default)]
    pub lra: Option<f32>,
    #[serde(default)]
    pub short_lufs_p50: Option<f32>,
    #[serde(default)]
    pub short_lufs_p80: Option<f32>,
    #[serde(default)]
    pub short_lufs_p95: Option<f32>,
    #[serde(default)]
    pub short_lufs_max: Option<f32>,
    #[serde(default)]
    pub presence_db: Option<f32>,
    #[serde(default)]
    pub model_adjustment_db: Option<f32>,
}

impl LoudnessProfile {
    pub fn from_integrated_lufs(integrated_lufs: f32) -> Option<Self> {
        if !is_valid_loudness_evidence(integrated_lufs) {
            return None;
        }

        Some(Self {
            integrated_lufs,
            true_peak_dbtp: None,
            lra: None,
            short_lufs_p50: None,
            short_lufs_p80: None,
            short_lufs_p95: None,
            short_lufs_max: None,
            presence_db: None,
            model_adjustment_db: None,
        })
    }

    pub fn is_valid(self) -> bool {
        is_valid_loudness_evidence(self.integrated_lufs)
            && self.true_peak_dbtp.is_none_or(is_finite_optional_evidence)
            && self.lra.is_none_or(is_finite_optional_evidence)
            && self.short_lufs_p50.is_none_or(is_finite_optional_evidence)
            && self.short_lufs_p80.is_none_or(is_finite_optional_evidence)
            && self.short_lufs_p95.is_none_or(is_finite_optional_evidence)
            && self.short_lufs_max.is_none_or(is_finite_optional_evidence)
            && self.presence_db.is_none_or(is_finite_optional_evidence)
            && self
                .model_adjustment_db
                .is_none_or(is_finite_optional_evidence)
    }
}

pub fn is_valid_loudness_evidence(loudness: f32) -> bool {
    loudness.is_finite() && loudness != 0.0
}

fn is_finite_optional_evidence(value: f32) -> bool {
    value.is_finite()
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
    pub occurrence_id: String,
    pub name: String,
    pub alias: String,
    pub canonical_music_id: String,
    pub url: String,
    pub path: Option<String>,
    pub start_ms: u32,
    pub end_ms: u32,
    pub liked: bool,
    #[serde(default)]
    pub loudness_profile: Option<LoudnessProfile>,
}

impl MusicSpectrumView {
    pub fn into_music(self, group: Group) -> Music {
        Music {
            occurrence_id: self.occurrence_id,
            name: self.name,
            alias: self.alias,
            group,
            canonical_music_id: self.canonical_music_id,
            url: self.url,
            path: self.path,
            start_ms: self.start_ms,
            end_ms: self.end_ms,
            liked: self.liked,
            loudness_profile: self.loudness_profile,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PlaylistRelationPlayableTrackViewParams {
    pub relation: &'static str,
    pub owner_records: Vec<RecordId>,
    pub liked_only: bool,
    pub limit: usize,
    pub offset: usize,
}

impl ViewParams for PlaylistRelationPlayableTrackViewParams {
    fn bind_view_params(self, stmt: RawSqlStmt) -> anyhow::Result<RawSqlStmt> {
        Ok(stmt
            .bind("relation", Table::from(self.relation))
            .bind("owner_records", self.owner_records)
            .bind("music_table", Music::table_name().to_string())
            .bind("liked_only", self.liked_only)
            .bind("limit", self.limit)
            .bind("offset", self.offset))
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, View)]
#[view(
    sql = r#"
        SELECT
            in AS owner_record,
            out AS music_record,
            position,
            out.occurrence_id AS occurrence_id,
            out.name AS name,
            out.alias AS alias,
            out.canonical_music_id AS canonical_music_id,
            out.url AS url,
            out.path AS path,
            out.start_ms AS start_ms,
            out.end_ms AS end_ms,
            out.liked AS liked,
            out.loudness_profile AS loudness_profile
        FROM $relation
        WHERE in IN $owner_records
            AND record::tb(out) = $music_table
            AND out.path IS NOT NONE
            AND ($liked_only = false OR out.liked = true)
        ORDER BY position ASC
        LIMIT $limit
        START $offset;
    "#,
    params = PlaylistRelationPlayableTrackViewParams
)]
pub struct PlaylistRelationPlayableTrackView {
    pub owner_record: RecordId,
    pub music_record: RecordId,
    pub position: i64,
    pub occurrence_id: String,
    pub name: String,
    pub alias: String,
    pub canonical_music_id: String,
    pub url: String,
    pub path: Option<String>,
    pub start_ms: u32,
    pub end_ms: u32,
    pub liked: bool,
    #[serde(default)]
    pub loudness_profile: Option<LoudnessProfile>,
}

#[derive(Debug, Clone)]
pub struct RandomPlaylistRelationPlayableTrackViewParams {
    pub relation: &'static str,
    pub owner_records: Vec<RecordId>,
    pub liked_only: bool,
    pub limit: usize,
}

impl ViewParams for RandomPlaylistRelationPlayableTrackViewParams {
    fn bind_view_params(self, stmt: RawSqlStmt) -> anyhow::Result<RawSqlStmt> {
        Ok(stmt
            .bind("relation", Table::from(self.relation))
            .bind("owner_records", self.owner_records)
            .bind("music_table", Music::table_name().to_string())
            .bind("liked_only", self.liked_only)
            .bind("limit", self.limit))
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, View)]
#[view(
    sql = r#"
        SELECT
            in AS owner_record,
            out AS music_record,
            position,
            out.occurrence_id AS occurrence_id,
            out.name AS name,
            out.alias AS alias,
            out.canonical_music_id AS canonical_music_id,
            out.url AS url,
            out.path AS path,
            out.start_ms AS start_ms,
            out.end_ms AS end_ms,
            out.liked AS liked,
            out.loudness_profile AS loudness_profile
        FROM $relation
        WHERE in IN $owner_records
            AND record::tb(out) = $music_table
            AND out.path IS NOT NONE
            AND ($liked_only = false OR out.liked = true)
        ORDER BY rand()
        LIMIT $limit;
    "#,
    params = RandomPlaylistRelationPlayableTrackViewParams
)]
pub struct RandomPlaylistRelationPlayableTrackView {
    pub owner_record: RecordId,
    pub music_record: RecordId,
    pub position: i64,
    pub occurrence_id: String,
    pub name: String,
    pub alias: String,
    pub canonical_music_id: String,
    pub url: String,
    pub path: Option<String>,
    pub start_ms: u32,
    pub end_ms: u32,
    pub liked: bool,
    #[serde(default)]
    pub loudness_profile: Option<LoudnessProfile>,
}

#[derive(Debug, Clone)]
pub struct PlaylistRecordPlayableTrackViewParams {
    pub music_records: Vec<RecordId>,
    pub liked_only: bool,
}

impl ViewParams for PlaylistRecordPlayableTrackViewParams {
    fn bind_view_params(self, stmt: RawSqlStmt) -> anyhow::Result<RawSqlStmt> {
        Ok(stmt
            .bind("music_table", Table::from(Music::table_name()))
            .bind("music_records", self.music_records)
            .bind("liked_only", self.liked_only))
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, View)]
#[view(
    sql = r#"
        SELECT
            id AS music_record,
            occurrence_id,
            name,
            alias,
            canonical_music_id,
            url,
            path,
            start_ms,
            end_ms,
            liked,
            loudness_profile
        FROM $music_table
        WHERE id IN $music_records
            AND path IS NOT NONE
            AND ($liked_only = false OR liked = true);
    "#,
    params = PlaylistRecordPlayableTrackViewParams
)]
pub struct PlaylistRecordPlayableTrackView {
    pub music_record: RecordId,
    pub occurrence_id: String,
    pub name: String,
    pub alias: String,
    pub canonical_music_id: String,
    pub url: String,
    pub path: Option<String>,
    pub start_ms: u32,
    pub end_ms: u32,
    pub liked: bool,
    #[serde(default)]
    pub loudness_profile: Option<LoudnessProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AudioStyleTrainingTrackInput {
    pub occurrence_id: String,
    pub alias: String,
    pub canonical_music_id: String,
    pub url: String,
    pub absolute_path: String,
    pub start_ms: u32,
    pub end_ms: u32,
    pub liked: bool,
    pub loudness_profile: Option<LoudnessProfile>,
}

#[derive(Debug, Clone)]
pub struct PlaylistMusicSourceCollectionViewParams {
    pub music_records: Vec<RecordId>,
}

impl ViewParams for PlaylistMusicSourceCollectionViewParams {
    fn bind_view_params(self, stmt: RawSqlStmt) -> anyhow::Result<RawSqlStmt> {
        Ok(stmt
            .bind("relation", Table::from("includes"))
            .bind("music_records", self.music_records)
            .bind("collection_table", Collection::table_name().to_string()))
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, View)]
#[view(
    sql = r#"
        SELECT
            out AS music_record,
            in AS collection_record,
            in.name AS collection_name,
            in.url AS collection_url,
            in.folder AS collection_folder,
            in.last_updated AS collection_last_updated,
            in.enable_updates AS collection_enable_updates,
            position
        FROM $relation
        WHERE out IN $music_records
            AND record::tb(in) = $collection_table
        ORDER BY position ASC;
    "#,
    params = PlaylistMusicSourceCollectionViewParams
)]
pub struct PlaylistMusicSourceCollectionView {
    pub music_record: RecordId,
    pub collection_record: RecordId,
    pub collection_name: String,
    pub collection_url: String,
    pub collection_folder: String,
    pub collection_last_updated: String,
    pub collection_enable_updates: Option<bool>,
    pub position: i64,
}

#[derive(Debug, Clone)]
pub struct PlaylistMusicGroupViewParams {
    pub music_records: Vec<RecordId>,
}

impl ViewParams for PlaylistMusicGroupViewParams {
    fn bind_view_params(self, stmt: RawSqlStmt) -> anyhow::Result<RawSqlStmt> {
        Ok(stmt
            .bind("relation", Table::from("grouped"))
            .bind("music_records", self.music_records)
            .bind("group_table", Group::table_name().to_string()))
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, View)]
#[view(
    sql = r#"
        SELECT
            out AS music_record,
            in AS group_record,
            in.name AS group_name,
            in.url AS group_url,
            in.folder AS group_folder,
            position
        FROM $relation
        WHERE out IN $music_records
            AND record::tb(in) = $group_table
        ORDER BY position ASC;
    "#,
    params = PlaylistMusicGroupViewParams
)]
pub struct PlaylistMusicGroupView {
    pub music_record: RecordId,
    pub group_record: RecordId,
    pub group_name: String,
    pub group_url: String,
    pub group_folder: String,
    pub position: i64,
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
