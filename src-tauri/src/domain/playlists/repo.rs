use super::model::{
    AddExcludeResult, Collection, CollectionSurfaceView, ConfigLibraryView, Exclude,
    ExcludeAvailability, Group, GroupSurfaceView, Music, MusicSpectrumView, PlayList,
    PlayListConfigView, PlayListListView, RemoveExcludeResult, SpectrumMusicContext,
    SpectrumMusicSourceContext, canonical_music_id_for_source,
};
use anyhow::{Result, bail};
use appdb::connection::get_db;
use appdb::error::{DBError, classify_db_error};
use appdb::graph;
use appdb::model::meta::ModelMeta;
use appdb::repository::Repo;
use appdb::{AutoFill, Crud, Id, Order, Store};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use surrealdb::types::{RecordId, Table};
use surrealdb_types::{SurrealValue, ToSql};

pub async fn list_collections() -> Result<Vec<Collection>> {
    ensure_collection_graph_schema().await?;

    match Collection::list().await {
        Ok(collections) => {
            let mut hydrated = Vec::with_capacity(collections.len());

            for collection in collections {
                let Some(full) = get_collection_by_url(&collection.url).await? else {
                    continue;
                };

                hydrated.push(full);
            }

            Ok(hydrated)
        }
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => Ok(vec![]),
            other => Err(other.into()),
        },
    }
}

pub async fn list_playlists() -> Result<Vec<PlayListListView>> {
    ensure_collection_graph_schema().await?;

    match PlayListListView::list()
        .order_by("created_at", Order::Asc)
        .await
    {
        Ok(playlists) => Ok(playlists),
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => Ok(vec![]),
            other => Err(other.into()),
        },
    }
}

pub async fn list_config_library() -> Result<ConfigLibraryView> {
    ensure_collection_graph_schema().await?;

    let collections = match CollectionSurfaceView::list().await {
        Ok(collections) => collections,
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => vec![],
            other => return Err(other.into()),
        },
    };
    let groups = match GroupSurfaceView::list().await {
        Ok(groups) => groups,
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => vec![],
            other => return Err(other.into()),
        },
    };
    let excludes = match Exclude::list().order_by("created_at", Order::Desc).await {
        Ok(excludes) => excludes,
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => vec![],
            other => return Err(other.into()),
        },
    };

    Ok(ConfigLibraryView {
        collections,
        groups,
        excludes,
        exclude_availability: load_exclude_availability().await?,
    })
}

pub async fn add_exclude(music: Music) -> Result<AddExcludeResult> {
    let record = exclude_record_id(&music);
    let saved = Repo::<StoredExclude>::upsert_at(
        RecordId::new(StoredExclude::table_name(), record.to_string()),
        StoredExclude {
            id: record,
            music: music.clone(),
            created_at: AutoFill::pending(),
        },
    )
    .await?;

    refresh_exclude_availability_for_music_identity(&music).await?;

    Ok(AddExcludeResult {
        exclude: saved.into_public(),
        exclude_availability: load_exclude_availability().await?,
    })
}

pub async fn get_music_by_identity(url: &str, start_ms: u32, end_ms: u32) -> Result<Option<Music>> {
    ensure_collection_graph_schema().await?;

    let canonical_music_id = canonical_music_id_for_source(url, start_ms, end_ms);
    let Some(record) = find_music_record_ids_by_canonical_id(&canonical_music_id)
        .await?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };

    Ok(Some(Music::get_record(record).await?))
}

pub async fn set_music_liked_by_identity(
    url: &str,
    start_ms: u32,
    end_ms: u32,
    liked: bool,
) -> Result<Option<Music>> {
    ensure_collection_graph_schema().await?;

    let canonical_music_id = canonical_music_id_for_source(url, start_ms, end_ms);
    let records = find_music_record_ids_by_canonical_id(&canonical_music_id).await?;
    let mut first_updated = None;

    for record in records {
        let mut music = Music::get_record(record.clone()).await?;
        music.liked = liked;
        let updated = Repo::<Music>::update_at(record, music).await?;

        if first_updated.is_none() {
            first_updated = Some(updated);
        }
    }

    Ok(first_updated)
}

pub async fn is_music_identity_excluded_for_playback(
    url: &str,
    start_ms: u32,
    end_ms: u32,
) -> Result<bool> {
    ensure_collection_graph_schema().await?;
    let canonical_music_id = canonical_music_id_for_source(url, start_ms, end_ms);
    is_music_canonical_id_excluded(&canonical_music_id).await
}

pub async fn remove_exclude(music: &Music) -> Result<RemoveExcludeResult> {
    let record = RecordId::new(
        StoredExclude::table_name(),
        exclude_record_id(music).to_string(),
    );

    let exists = match Repo::<StoredExclude>::exists_record(record.clone()).await {
        Ok(exists) => exists,
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => {
                return Ok(RemoveExcludeResult {
                    removed: false,
                    exclude_availability: load_exclude_availability().await?,
                });
            }
            other => return Err(other.into()),
        },
    };
    if !exists {
        return Ok(RemoveExcludeResult {
            removed: false,
            exclude_availability: load_exclude_availability().await?,
        });
    }

    Repo::<StoredExclude>::delete_record(record).await?;
    refresh_exclude_availability_for_music_identity(music).await?;
    Ok(RemoveExcludeResult {
        removed: true,
        exclude_availability: load_exclude_availability().await?,
    })
}

pub async fn has_collections() -> Result<bool> {
    match Collection::exists().await {
        Ok(exists) => Ok(exists),
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => Ok(false),
            other => Err(other.into()),
        },
    }
}

pub async fn get_collection_by_url(url: &str) -> Result<Option<Collection>> {
    ensure_collection_graph_schema().await?;

    let Some(record) = find_unique_record_id_by_string_field::<Collection>("url", url).await?
    else {
        return Ok(None);
    };

    Ok(Some(Collection::get_record(record).await?))
}

pub async fn find_collection_by_url(url: &str) -> Result<Option<Collection>> {
    ensure_collection_graph_schema().await?;

    let lookup = Collection {
        name: String::new(),
        url: url.to_string(),
        folder: String::new(),
        musics: vec![],
        last_updated: String::new(),
        enable_updates: None,
    };
    let record = match Repo::<Collection>::find_unique_id_for(&lookup).await {
        Ok(record) => record,
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) | DBError::NotFound => return Ok(None),
            other => return Err(other.into()),
        },
    };

    Ok(Some(Collection::get_record(record).await?))
}

pub async fn get_playlist_by_name(name: &str) -> Result<Option<PlayList>> {
    ensure_collection_graph_schema().await?;

    let Some(record) = find_unique_record_id_by_string_field::<PlayList>("name", name).await?
    else {
        return Ok(None);
    };

    Ok(Some(PlayList::get_record(record).await?))
}

pub async fn get_playlist_config_by_name(name: &str) -> Result<Option<PlayListConfigView>> {
    ensure_collection_graph_schema().await?;

    match PlayListConfigView::find_one("name", name).await {
        Ok(playlist) => Ok(Some(playlist)),
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) | DBError::NotFound => Ok(None),
            other => Err(other.into()),
        },
    }
}

#[derive(Debug, Clone)]
pub struct PlaylistPlaybackSelection {
    pub playlist_name: String,
    pub collections: Vec<PlaylistPlaybackCollectionRef>,
    pub groups: Vec<PlaylistPlaybackGroupRef>,
    pub download_scopes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PlaylistPlaybackCollectionRef {
    record: RecordId,
    pub name: String,
    pub url: String,
    pub folder: String,
}

impl PlaylistPlaybackCollectionRef {
    #[cfg(test)]
    pub(crate) fn new_for_test(name: &str, url: &str, folder: &str) -> Self {
        Self {
            record: RecordId::new(
                Collection::table_name(),
                format!("test-{}", stable_record_key(url)),
            ),
            name: name.to_string(),
            url: url.to_string(),
            folder: folder.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PlaylistPlaybackGroupRef {
    record: RecordId,
    pub name: String,
    pub url: String,
    pub folder: String,
}

impl PlaylistPlaybackGroupRef {
    #[cfg(test)]
    pub(crate) fn new_for_test(name: &str, url: &str, folder: &str) -> Self {
        Self {
            record: RecordId::new(
                Group::table_name(),
                format!("test-{}", stable_record_key(url)),
            ),
            name: name.to_string(),
            url: url.to_string(),
            folder: folder.to_string(),
        }
    }
}

/**
 * Behavior:
 *   Project a committed playlist row into the stable playback selection domain.
 *
 * Core invariants:
 *   - The playlist row is the only source of selected collection/group refs.
 *   - Download readiness is represented by explicit collection URL scopes
 *     owned by this projection, not inferred by downloads or UI fallback.
 *   - Group-only selections carry parent collection scopes when persisted
 *     music evidence exists; before that evidence exists they still retain
 *     their own group URL as a stable waiting scope.
 */
fn push_unique_download_scope(scopes: &mut Vec<String>, url: &str) {
    if scopes.iter().any(|scope| scope == url) {
        return;
    }

    scopes.push(url.to_string());
}

#[derive(Debug, Clone)]
pub struct PlaylistPlaybackTrackSource {
    pub collection_name: String,
    pub collection_url: String,
    pub collection_folder: String,
    pub music: Music,
}

pub async fn get_playlist_playback_selection_by_name(
    name: &str,
) -> Result<Option<PlaylistPlaybackSelection>> {
    ensure_collection_graph_schema().await?;

    let Some(row) = load_playlist_playback_row_by_name(name).await? else {
        return Ok(None);
    };

    let mut collections = Vec::with_capacity(row.collections.len());
    let mut download_scopes = Vec::new();
    for record in row.collections {
        if let Some(collection) = load_playlist_playback_collection_ref(&record).await? {
            push_unique_download_scope(&mut download_scopes, &collection.url);
            collections.push(collection);
        }
    }

    let mut groups = Vec::with_capacity(row.groups.len());
    for record in row.groups {
        if let Some(group) = load_playlist_playback_group_ref(&record).await? {
            push_unique_download_scope(&mut download_scopes, &group.url);
            for url in load_group_parent_collection_urls(&group).await? {
                push_unique_download_scope(&mut download_scopes, &url);
            }
            groups.push(group);
        }
    }

    Ok(Some(PlaylistPlaybackSelection {
        playlist_name: row.name,
        collections,
        groups,
        download_scopes,
    }))
}

pub async fn load_playlist_playback_track_sources(
    selection: &PlaylistPlaybackSelection,
    limit: usize,
) -> Result<Vec<PlaylistPlaybackTrackSource>> {
    if limit == 0 {
        return Ok(vec![]);
    }

    let mut sources = Vec::with_capacity(limit);
    let mut seen = HashSet::new();

    for collection in &selection.collections {
        append_collection_playback_track_sources(collection, limit, &mut seen, &mut sources)
            .await?;
        if sources.len() >= limit {
            return Ok(sources);
        }
    }

    for group in &selection.groups {
        append_group_playback_track_sources(group, limit, &mut seen, &mut sources).await?;
        if sources.len() >= limit {
            return Ok(sources);
        }
    }

    Ok(sources)
}

pub async fn load_liked_playlist_playback_track_sources(
    selection: &PlaylistPlaybackSelection,
    limit: usize,
) -> Result<Vec<PlaylistPlaybackTrackSource>> {
    if limit == 0 {
        return Ok(vec![]);
    }

    let mut sources = Vec::with_capacity(limit);
    let mut seen = HashSet::new();

    for collection in &selection.collections {
        append_liked_collection_playback_track_sources(collection, limit, &mut seen, &mut sources)
            .await?;
        if sources.len() >= limit {
            return Ok(sources);
        }
    }

    for group in &selection.groups {
        append_liked_group_playback_track_sources(group, limit, &mut seen, &mut sources).await?;
        if sources.len() >= limit {
            return Ok(sources);
        }
    }

    Ok(sources)
}

pub async fn load_audio_style_training_track_sources() -> Result<Vec<PlaylistPlaybackTrackSource>> {
    ensure_collection_graph_schema().await?;

    let records = match Collection::list().await {
        Ok(collections) => collections
            .into_iter()
            .map(|collection| collection_record_id(&collection.url))
            .collect::<Vec<_>>(),
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => return Ok(vec![]),
            other => return Err(other.into()),
        },
    };

    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    for record in records {
        let Some(collection) = load_playlist_playback_collection_ref(&record).await? else {
            continue;
        };

        for music_record in load_collection_music_ids(&record).await? {
            if is_music_record_excluded_for_playback(&music_record, Music::table_name()).await? {
                continue;
            }

            let music = Music::get_record(music_record).await?;
            append_playback_track_source(&collection, music, &mut seen, &mut sources);
        }
    }

    Ok(sources)
}

pub async fn load_random_playlist_playback_track_source(
    selection: &PlaylistPlaybackSelection,
) -> Result<Option<PlaylistPlaybackTrackSource>> {
    let owner_count = selection.collections.len() + selection.groups.len();
    if owner_count == 0 {
        return Ok(None);
    }

    for owner_index in playlist_playback_owner_attempt_order(owner_count) {
        let source = if owner_index < selection.collections.len() {
            load_random_collection_playback_track_source(&selection.collections[owner_index])
                .await?
        } else {
            let group_index = owner_index - selection.collections.len();
            load_random_group_playback_track_source(&selection.groups[group_index]).await?
        };

        if source.is_some() {
            return Ok(source);
        }
    }

    Ok(None)
}

pub(crate) fn playlist_playback_owner_attempt_order(owner_count: usize) -> Vec<usize> {
    let mut owners = (0..owner_count).collect::<Vec<_>>();
    shuffle_indices(&mut owners);
    owners
}

fn shuffle_indices(indices: &mut [usize]) {
    let mut rng = rand::rng();
    for index in (1..indices.len()).rev() {
        let swap_index = rng.random_range(0..=index);
        indices.swap(index, swap_index);
    }
}

pub async fn delete_playlist_by_name(name: &str) -> Result<bool> {
    let Some(record) = find_unique_record_id_by_string_field::<PlayList>("name", name).await?
    else {
        return Ok(false);
    };

    Repo::<PlayList>::delete_record(record).await?;
    Ok(true)
}

pub async fn upsert_playlist(playlist: &PlayList, previous_name: Option<&str>) -> Result<PlayList> {
    let foreign_ids = resolve_playlist_foreign_record_ids(playlist).await?;
    let existing_record = match previous_name {
        Some(name) => find_unique_record_id_by_string_field::<PlayList>("name", name).await?,
        None => None,
    };
    let record = existing_record
        .clone()
        .unwrap_or_else(|| playlist_record_id(&playlist.name));
    let write = playlist
        .clone()
        .foreign()
        .collections(foreign_ids.collections)?
        .groups(foreign_ids.groups)?;

    match existing_record {
        Some(record) => Ok(write.update_at(record).await?),
        None => Ok(write.create_at(record).await?),
    }
}

pub async fn upsert_playlist_surface(
    playlist: &PlayList,
    previous_name: Option<&str>,
) -> Result<PlayListListView> {
    let foreign_ids = resolve_playlist_foreign_record_ids(playlist).await?;
    let existing_record = match previous_name {
        Some(name) => find_unique_record_id_by_string_field::<PlayList>("name", name).await?,
        None => None,
    };
    let record = existing_record
        .clone()
        .unwrap_or_else(|| playlist_record_id(&playlist.name));
    let write = playlist
        .clone()
        .foreign()
        .collections(foreign_ids.collections)?
        .groups(foreign_ids.groups)?;

    match existing_record {
        Some(record) => Ok(write
            .update_at_returning::<PlayListListView>(record)
            .await?),
        None => Ok(write
            .create_at_returning::<PlayListListView>(record)
            .await?),
    }
}

pub async fn ensure_playlist_collection_refs_exist(collections: &[Collection]) -> Result<()> {
    ensure_collection_graph_schema().await?;

    for collection in collections {
        if find_unique_record_id_by_string_field::<Collection>("url", &collection.url)
            .await?
            .is_some()
        {
            continue;
        }

        let shell = Collection {
            name: collection.name.clone(),
            url: collection.url.clone(),
            folder: collection.folder.clone(),
            musics: vec![],
            last_updated: collection.last_updated.clone(),
            enable_updates: collection.enable_updates,
        };
        let record = collection_record_id(&shell.url);

        match Repo::<Collection>::create_at(record, shell).await {
            Ok(_) => {}
            Err(error) => match classify_db_error(&error) {
                DBError::Conflict(_) => {}
                other => return Err(other.into()),
            },
        }
    }

    Ok(())
}

pub async fn set_collection_updates(url: &str, enabled: bool) -> Result<Option<Collection>> {
    let Some(mut collection) = get_collection_by_url(url).await? else {
        return Ok(None);
    };

    if collection.enable_updates.is_none() {
        return Ok(Some(collection));
    }

    collection.enable_updates = Some(enabled);
    Ok(Some(upsert_collection(&collection).await?))
}

pub async fn update_music(
    url: &str,
    start_ms: u32,
    end_ms: u32,
    alias: &str,
    next_start_ms: u32,
    next_end_ms: u32,
) -> Result<Option<Music>> {
    ensure_collection_graph_schema().await?;

    let records = find_music_record_ids_by_identity(url, start_ms, end_ms).await?;
    let mut first_updated = None;

    for record in records {
        let mut music = Music::get_record(record.clone()).await?;
        let previous_music = music.clone();
        music.alias = alias.to_string();
        music.start_ms = next_start_ms;
        music.end_ms = next_end_ms;
        music.canonical_music_id =
            canonical_music_id_for_source(&music.url, music.start_ms, music.end_ms);
        let updated = Repo::<Music>::update_at(record.clone(), music).await?;
        refresh_exclude_availability_for_music_record(&record).await?;
        refresh_exclude_availability_for_music_identity(&previous_music).await?;

        if first_updated.is_none() {
            first_updated = Some(updated);
        }
    }

    Ok(first_updated)
}

pub async fn create_music(source_collection_url: &str, music: &Music) -> Result<Music> {
    ensure_collection_graph_schema().await?;

    if music.start_ms >= music.end_ms {
        bail!("music start_ms must be less than end_ms");
    }
    let mut music = music.clone();
    music.canonical_music_id =
        canonical_music_id_for_source(&music.url, music.start_ms, music.end_ms);

    let Some(mut collection) = get_collection_by_url(source_collection_url).await? else {
        bail!("collection `{source_collection_url}` not found");
    };

    if collection.musics.iter().any(|candidate| {
        candidate.url == music.url
            && candidate.start_ms == music.start_ms
            && candidate.end_ms == music.end_ms
    }) {
        return Ok(music.clone());
    }

    collection.musics.push(music.clone());
    let saved = upsert_collection(&collection).await?;
    Ok(saved
        .musics
        .into_iter()
        .find(|candidate| {
            candidate.url == music.url
                && candidate.start_ms == music.start_ms
                && candidate.end_ms == music.end_ms
        })
        .unwrap_or(music))
}

pub async fn delete_music(url: &str, start_ms: u32, end_ms: u32) -> Result<bool> {
    ensure_collection_graph_schema().await?;

    let records = find_music_record_ids_by_identity(url, start_ms, end_ms).await?;
    if records.is_empty() {
        return Ok(false);
    }

    for record in records {
        let music = Music::get_record(record.clone()).await?;
        let parent_collections = load_music_parent_collection_ids(&record).await?;
        let parent_groups = load_music_group_ids(&record).await?;
        delete_music_parent_edges(&record).await?;

        match Music::delete_record(record).await {
            Ok(()) => {}
            Err(error) => match classify_db_error(&error) {
                DBError::MissingTable(_) | DBError::NotFound => {}
                other => return Err(other.into()),
            },
        }
        refresh_exclude_availability_for_owner_records(&parent_collections, &parent_groups).await?;
        refresh_exclude_availability_for_music_identity(&music).await?;
    }

    Ok(true)
}

pub async fn list_musics_by_file_path(file_path: &Path, save_root: &Path) -> Result<Vec<Music>> {
    Ok(load_spectrum_music_context(file_path, save_root, None)
        .await?
        .file_musics)
}

#[derive(Debug, Clone, Copy)]
pub struct SpectrumMusicSourceIdentity<'a> {
    pub url: &'a str,
    pub start_ms: u32,
    pub end_ms: u32,
}

impl SpectrumMusicSourceIdentity<'_> {
    fn matches_spectrum_view(&self, music: &MusicSpectrumView) -> bool {
        music.url == self.url && music.start_ms == self.start_ms && music.end_ms == self.end_ms
    }
}

/**
 * Behavior:
 *   Project persisted collection music rows into the stable spectrum page
 *   context for one file and one currently playing source identity.
 *
 * Core invariants:
 *   - The UI receives owner evidence from collection persistence, never from a
 *     shallow playlist/cache reconstruction.
 *   - File-level draft listing and source-owner evidence are produced by the
 *     same scan, so duplicate or late consumers cannot diverge.
 *   - Missing source evidence stays explicit as `None`; callers cannot create a
 *     pending music draft from an unowned fixed point.
 */
pub async fn load_spectrum_music_context(
    file_path: &Path,
    save_root: &Path,
    source_identity: Option<SpectrumMusicSourceIdentity<'_>>,
) -> Result<SpectrumMusicContext> {
    ensure_collection_graph_schema().await?;

    let relative_file_path = file_path
        .strip_prefix(save_root)
        .ok()
        .map(Path::to_path_buf);
    let collections = match CollectionSurfaceView::list_records().await {
        Ok(collections) => collections,
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => vec![],
            other => return Err(other.into()),
        },
    };
    let mut seen = HashSet::new();
    let mut file_music_records = Vec::<PendingSpectrumMusicContextRecord>::new();

    for collection in collections {
        if !is_collection_candidate_for_file_path(&collection.folder, relative_file_path.as_deref())
        {
            continue;
        }

        let music_records = match load_collection_music_spectrum_records(collection.id()).await {
            Ok(musics) => musics,
            Err(error) => match classify_db_error(&error) {
                DBError::MissingTable(_) => vec![],
                other => return Err(other.into()),
            },
        };

        for music_record in music_records {
            let music_view = music_record.value();
            let Some(resolved_path) =
                resolve_music_file_path(save_root, &collection.folder, music_view.path.as_deref())
            else {
                continue;
            };

            if !same_music_file_path(&resolved_path, file_path) {
                continue;
            }

            let key = format!(
                "{}:{}:{}",
                music_view.url, music_view.start_ms, music_view.end_ms
            );
            if !seen.insert(key) {
                continue;
            }

            file_music_records.push(PendingSpectrumMusicContextRecord {
                collection_url: collection.url.clone(),
                music: music_record,
            });
        }
    }

    let file_music_views = load_spectrum_music_records_with_groups(file_music_records).await?;
    let source = resolve_spectrum_music_source_context(&file_music_views, source_identity).await?;
    let file_musics = file_music_views
        .iter()
        .map(|record| record.music.clone().into_music(record.group.clone()))
        .collect();

    Ok(SpectrumMusicContext {
        file_musics,
        source,
    })
}

#[derive(Debug, Clone)]
struct PendingSpectrumMusicContextRecord {
    collection_url: String,
    music: OrderedMusicSpectrumRecord,
}

#[derive(Debug, Clone)]
struct OrderedMusicSpectrumRecord {
    id: RecordId,
    value: MusicSpectrumView,
}

impl OrderedMusicSpectrumRecord {
    fn id(&self) -> &RecordId {
        &self.id
    }

    fn value(&self) -> &MusicSpectrumView {
        &self.value
    }

    fn into_value(self) -> MusicSpectrumView {
        self.value
    }
}

#[derive(Debug, Clone)]
struct SpectrumMusicContextRecord {
    collection_url: String,
    group: Group,
    music: MusicSpectrumView,
}

async fn resolve_spectrum_music_source_context(
    file_musics: &[SpectrumMusicContextRecord],
    source_identity: Option<SpectrumMusicSourceIdentity<'_>>,
) -> Result<Option<SpectrumMusicSourceContext>> {
    let Some(identity) = source_identity else {
        return Ok(None);
    };
    let Some(source_record) = file_musics
        .iter()
        .find(|record| identity.matches_spectrum_view(&record.music))
    else {
        return Ok(None);
    };
    let Some(source_end_ms) = resolve_spectrum_source_end_ms(file_musics, identity.url) else {
        return Ok(None);
    };

    Ok(Some(SpectrumMusicSourceContext {
        source_collection_url: source_record.collection_url.clone(),
        source_end_ms,
        source_group: source_record.group.clone(),
        source_path: source_record.music.path.clone(),
        source_start_ms: identity.start_ms,
        source_url: identity.url.to_string(),
    }))
}

async fn load_spectrum_music_records_with_groups(
    records: Vec<PendingSpectrumMusicContextRecord>,
) -> Result<Vec<SpectrumMusicContextRecord>> {
    let music_ids = records
        .iter()
        .map(|record| record.music.id().clone())
        .collect::<Vec<_>>();
    let group_records =
        match GroupSurfaceView::incoming_records_by_owners(music_ids, "grouped").await {
            Ok(groups) => groups,
            Err(error) => match classify_db_error(&error) {
                DBError::MissingTable(_) => vec![],
                other => return Err(other.into()),
            },
        };
    let mut groups_by_music = HashMap::<RecordId, Group>::new();
    for related in group_records {
        let (music_id, group) = related.into_parts();
        groups_by_music.entry(music_id).or_insert_with(|| {
            let group = group.into_value();
            Group {
                name: group.name,
                url: group.url,
                folder: group.folder,
            }
        });
    }

    Ok(records
        .into_iter()
        .filter_map(|record| {
            let group = groups_by_music.remove(record.music.id())?;
            Some(SpectrumMusicContextRecord {
                collection_url: record.collection_url,
                group,
                music: record.music.into_value(),
            })
        })
        .collect())
}

async fn load_collection_music_spectrum_records(
    collection_record: &RecordId,
) -> Result<Vec<OrderedMusicSpectrumRecord>> {
    let music_ids = load_collection_music_ids(collection_record).await?;
    let mut records = Vec::with_capacity(music_ids.len());

    for music_id in music_ids {
        records.push(OrderedMusicSpectrumRecord {
            id: music_id.clone(),
            value: MusicSpectrumView::get_record(music_id).await?,
        });
    }

    Ok(records)
}

fn resolve_spectrum_source_end_ms(
    musics: &[SpectrumMusicContextRecord],
    source_url: &str,
) -> Option<u32> {
    musics
        .iter()
        .map(|record| &record.music)
        .filter(|music| music.url == source_url && music.start_ms < music.end_ms)
        .map(|music| music.end_ms)
        .max()
}

pub async fn list_auto_update_collections() -> Result<Vec<Collection>> {
    Ok(list_collections()
        .await?
        .into_iter()
        .filter(|collection| collection.enable_updates == Some(true))
        .collect())
}

pub async fn upsert_collection(collection: &Collection) -> Result<Collection> {
    ensure_collection_graph_schema().await?;

    let collection = inherit_canonical_liked_state(collection).await?;
    let existing_record =
        find_unique_record_id_by_string_field::<Collection>("url", &collection.url).await?;
    let record = existing_record
        .clone()
        .unwrap_or_else(|| collection_record_id(&collection.url));
    let previous_music_ids = load_collection_music_ids(&record).await?;
    let previous_group_ids = load_group_ids_for_music_records(&previous_music_ids).await?;
    let previous_group_urls = load_group_urls_for_records(&previous_group_ids).await?;
    let saved = match existing_record {
        Some(record) => Repo::<Collection>::update_at(record, collection).await?,
        None => Repo::<Collection>::create_at(record.clone(), collection).await?,
    };
    let next_music_ids = load_collection_music_ids(&record).await?;
    let next_group_ids = load_group_ids_for_music_records(&next_music_ids).await?;
    delete_orphaned_music_records(previous_music_ids, &next_music_ids).await?;
    refresh_exclude_availability_for_collection_record(&record).await?;
    refresh_exclude_availability_for_owner_records(&[], &previous_group_ids).await?;
    refresh_exclude_availability_for_owner_records(&[], &next_group_ids).await?;
    delete_exclude_availability_for_missing_group_urls(previous_group_urls).await?;
    Ok(saved)
}

async fn inherit_canonical_liked_state(collection: &Collection) -> Result<Collection> {
    let mut collection = collection.clone();
    for music in &mut collection.musics {
        if music.liked {
            continue;
        }

        if canonical_music_id_has_liked_record(&music.canonical_music_id).await? {
            music.liked = true;
        }
    }

    Ok(collection)
}

async fn canonical_music_id_has_liked_record(canonical_music_id: &str) -> Result<bool> {
    let db = get_db()?;
    let mut result = match db
        .query(
            "RETURN count((SELECT VALUE id FROM $table
             WHERE canonical_music_id = $canonical_music_id AND liked = true LIMIT 1));",
        )
        .bind(("table", Table::from(Music::table_name())))
        .bind(("canonical_music_id", canonical_music_id.to_string()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(false),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(false),
            other => return Err(other.into()),
        },
    };

    let count: Option<i64> = result.take(0)?;
    Ok(count.unwrap_or(0) > 0)
}

/// Collection persistence owns its graph schema so callers never need to
/// remember a separate bootstrap step before writing or hydrating musics.
async fn ensure_collection_graph_schema() -> Result<()> {
    let db = get_db()?;

    db.query(format!(
        "DEFINE TABLE IF NOT EXISTS {} SCHEMALESS;",
        Music::table_name()
    ))
    .await?
    .check()?;

    db.query("DEFINE TABLE IF NOT EXISTS includes TYPE RELATION SCHEMALESS;")
        .await?
        .check()?;

    Ok(())
}

async fn load_collection_music_ids(record: &RecordId) -> Result<Vec<RecordId>> {
    let db = get_db()?;
    let mut result = match db
        .query(
            "SELECT out, position FROM $rel WHERE in = $record AND record::tb(out) = $out_table ORDER BY position ASC;",
        )
        .bind(("rel", Table::from("includes")))
        .bind(("record", record.clone()))
        .bind(("out_table", Music::table_name().to_string()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(vec![]),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(vec![]),
            other => return Err(other.into()),
        },
    };

    let rows: Vec<CollectionEdgeRow> = result.take(0)?;
    Ok(rows.into_iter().map(|row| row.out).collect())
}

async fn load_playlist_playback_row_by_name(name: &str) -> Result<Option<PlaylistPlaybackRow>> {
    let db = get_db()?;
    let mut result = match db
        .query("SELECT name, collections, groups FROM $table WHERE name = $name LIMIT 2;")
        .bind(("table", Table::from(PlayList::table_name())))
        .bind(("name", name.to_string()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(None),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(None),
            other => return Err(other.into()),
        },
    };

    let rows: Vec<PlaylistPlaybackRawRow> = result.take(0)?;
    match rows.len() {
        0 => Ok(None),
        1 => rows
            .into_iter()
            .next()
            .map(project_playlist_playback_raw_row)
            .transpose(),
        _ => bail!("playlist playback lookup matched multiple records for name `{name}`"),
    }
}

fn project_playlist_playback_raw_row(row: PlaylistPlaybackRawRow) -> Result<PlaylistPlaybackRow> {
    Ok(PlaylistPlaybackRow {
        name: row.name,
        collections: project_record_refs(row.collections)?,
        groups: project_record_refs(row.groups)?,
    })
}

fn project_record_refs(values: serde_json::Value) -> Result<Vec<RecordId>> {
    let serde_json::Value::Array(values) = values else {
        return Ok(vec![]);
    };

    values.into_iter().map(project_record_ref).collect()
}

fn project_record_ref(value: serde_json::Value) -> Result<RecordId> {
    match value {
        serde_json::Value::String(text) => appdb::serde_utils::id::parse_record_id_or_plain_string(
            &text, None,
        )
        .map_err(|invalid| anyhow::anyhow!("invalid playlist playback record ref `{invalid}`")),
        other => Ok(serde_json::from_value(other)?),
    }
}

async fn load_playlist_playback_collection_ref(
    record: &RecordId,
) -> Result<Option<PlaylistPlaybackCollectionRef>> {
    let Some(row) = load_collection_shell_row(record).await? else {
        return Ok(None);
    };

    Ok(Some(PlaylistPlaybackCollectionRef {
        record: row.id,
        name: row.name,
        url: row.url,
        folder: row.folder,
    }))
}

async fn load_playlist_playback_group_ref(
    record: &RecordId,
) -> Result<Option<PlaylistPlaybackGroupRef>> {
    let Some(row) = load_group_shell_row(record).await? else {
        return Ok(None);
    };

    Ok(Some(PlaylistPlaybackGroupRef {
        record: row.id,
        name: row.name,
        url: row.url,
        folder: row.folder,
    }))
}

async fn load_group_shell_row(record: &RecordId) -> Result<Option<GroupShellRow>> {
    let db = get_db()?;
    let mut result = match db
        .query("SELECT * FROM ONLY $record;")
        .bind(("record", record.clone()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) | DBError::NotFound => return Ok(None),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) | DBError::NotFound => return Ok(None),
            other => return Err(other.into()),
        },
    };

    let row: Option<GroupShellRow> = result.take(0)?;
    Ok(row)
}

async fn load_collection_shell_row(record: &RecordId) -> Result<Option<CollectionShellRow>> {
    let db = get_db()?;
    let mut result = match db
        .query("SELECT * FROM ONLY $record;")
        .bind(("record", record.clone()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) | DBError::NotFound => return Ok(None),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) | DBError::NotFound => return Ok(None),
            other => return Err(other.into()),
        },
    };

    Ok(result.take(0)?)
}

async fn append_collection_playback_track_sources(
    collection: &PlaylistPlaybackCollectionRef,
    limit: usize,
    seen: &mut HashSet<String>,
    sources: &mut Vec<PlaylistPlaybackTrackSource>,
) -> Result<()> {
    let remaining = limit.saturating_sub(sources.len());
    let music_records =
        load_collection_music_ids_for_playback(&collection.record, remaining).await?;
    for music_record in music_records {
        let music = Music::get_record(music_record).await?;
        append_playback_track_source(collection, music, seen, sources);
        if sources.len() >= limit {
            return Ok(());
        }
    }

    Ok(())
}

async fn append_group_playback_track_sources(
    group: &PlaylistPlaybackGroupRef,
    limit: usize,
    seen: &mut HashSet<String>,
    sources: &mut Vec<PlaylistPlaybackTrackSource>,
) -> Result<()> {
    let remaining = limit.saturating_sub(sources.len());
    let music_records = load_group_music_ids_for_playback(&group.record, remaining).await?;
    for music_record in music_records {
        let parent_records = load_music_parent_collection_ids(&music_record).await?;
        if parent_records.is_empty() {
            continue;
        }

        let music = Music::get_record(music_record).await?;
        for collection_record in parent_records {
            let Some(collection) =
                load_playlist_playback_collection_ref(&collection_record).await?
            else {
                continue;
            };
            append_playback_track_source(&collection, music.clone(), seen, sources);
            if sources.len() >= limit {
                return Ok(());
            }
        }
    }

    Ok(())
}

async fn append_liked_collection_playback_track_sources(
    collection: &PlaylistPlaybackCollectionRef,
    limit: usize,
    seen: &mut HashSet<String>,
    sources: &mut Vec<PlaylistPlaybackTrackSource>,
) -> Result<()> {
    for music_record in load_collection_music_ids(&collection.record).await? {
        if is_music_record_excluded_for_playback(&music_record, Music::table_name()).await? {
            continue;
        }

        let music = Music::get_record(music_record).await?;
        if !music.liked {
            continue;
        }
        append_playback_track_source(collection, music, seen, sources);
        if sources.len() >= limit {
            return Ok(());
        }
    }

    Ok(())
}

async fn append_liked_group_playback_track_sources(
    group: &PlaylistPlaybackGroupRef,
    limit: usize,
    seen: &mut HashSet<String>,
    sources: &mut Vec<PlaylistPlaybackTrackSource>,
) -> Result<()> {
    for music_record in load_relation_out_ids("grouped", &group.record, Music::table_name()).await?
    {
        if is_music_record_excluded_for_playback(&music_record, Music::table_name()).await? {
            continue;
        }

        let music = Music::get_record(music_record.clone()).await?;
        if !music.liked {
            continue;
        }

        for collection_record in load_music_parent_collection_ids(&music_record).await? {
            let Some(collection) =
                load_playlist_playback_collection_ref(&collection_record).await?
            else {
                continue;
            };
            append_playback_track_source(&collection, music.clone(), seen, sources);
            if sources.len() >= limit {
                return Ok(());
            }
        }
    }

    Ok(())
}

async fn load_random_collection_playback_track_source(
    collection: &PlaylistPlaybackCollectionRef,
) -> Result<Option<PlaylistPlaybackTrackSource>> {
    let Some(music_record) = load_random_relation_out_id_for_playback(
        &collection.record,
        "includes",
        Music::table_name(),
    )
    .await?
    else {
        return Ok(None);
    };

    let music = Music::get_record(music_record).await?;
    Ok(Some(project_playback_track_source(collection, music)))
}

async fn load_random_group_playback_track_source(
    group: &PlaylistPlaybackGroupRef,
) -> Result<Option<PlaylistPlaybackTrackSource>> {
    let Some(music_record) =
        load_random_relation_out_id_for_playback(&group.record, "grouped", Music::table_name())
            .await?
    else {
        return Ok(None);
    };

    let parent_records = load_music_parent_collection_ids(&music_record).await?;
    if parent_records.is_empty() {
        return Ok(None);
    }

    let Some(parent_index) = random_index(parent_records.len()) else {
        return Ok(None);
    };
    let Some(collection) =
        load_playlist_playback_collection_ref(&parent_records[parent_index]).await?
    else {
        return Ok(None);
    };
    let music = Music::get_record(music_record).await?;
    Ok(Some(project_playback_track_source(&collection, music)))
}

async fn load_random_relation_out_id_for_playback(
    record: &RecordId,
    relation: &str,
    out_table: &str,
) -> Result<Option<RecordId>> {
    let count = count_relation_out_ids_for_playback(record, relation, out_table).await?;
    if count == 0 {
        return Ok(None);
    }

    let Some(start_offset) = random_index(count) else {
        return Ok(None);
    };

    for step in 0..count {
        let offset = (start_offset + step) % count;
        let Some(candidate) =
            load_relation_out_id_for_playback_at(record, relation, out_table, offset).await?
        else {
            continue;
        };

        if !is_music_record_excluded_for_playback(&candidate, out_table).await? {
            return Ok(Some(candidate));
        }
    }

    Ok(None)
}

fn random_index(len: usize) -> Option<usize> {
    if len == 0 {
        return None;
    }

    Some(rand::rng().random_range(0..len))
}

async fn load_group_parent_collection_urls(
    group: &PlaylistPlaybackGroupRef,
) -> Result<Vec<String>> {
    let db = get_db()?;
    let mut result = match db
        .query(
            "SELECT VALUE in FROM includes WHERE out IN (
                SELECT VALUE out FROM grouped WHERE in = $group AND record::tb(out) = $music_table
            ) AND record::tb(in) = $collection_table;",
        )
        .bind(("group", group.record().clone()))
        .bind(("music_table", Music::table_name().to_string()))
        .bind(("collection_table", Collection::table_name().to_string()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(vec![]),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(vec![]),
            other => return Err(other.into()),
        },
    };

    let records: Vec<RecordId> = result.take(0)?;
    let mut seen = HashSet::new();
    let mut urls = Vec::new();

    for record in records {
        if !seen.insert(record.clone()) {
            continue;
        }

        if let Some(collection) = load_playlist_playback_collection_ref(&record).await? {
            urls.push(collection.url);
        }
    }

    Ok(urls)
}

impl PlaylistPlaybackGroupRef {
    fn record(&self) -> &RecordId {
        &self.record
    }
}

fn append_playback_track_source(
    collection: &PlaylistPlaybackCollectionRef,
    music: Music,
    seen: &mut HashSet<String>,
    sources: &mut Vec<PlaylistPlaybackTrackSource>,
) {
    if !seen.insert(music.canonical_music_id.clone()) {
        return;
    }

    sources.push(PlaylistPlaybackTrackSource {
        collection_name: collection.name.clone(),
        collection_url: collection.url.clone(),
        collection_folder: collection.folder.clone(),
        music,
    });
}

fn project_playback_track_source(
    collection: &PlaylistPlaybackCollectionRef,
    music: Music,
) -> PlaylistPlaybackTrackSource {
    PlaylistPlaybackTrackSource {
        collection_name: collection.name.clone(),
        collection_url: collection.url.clone(),
        collection_folder: collection.folder.clone(),
        music,
    }
}

async fn load_collection_music_ids_for_playback(
    record: &RecordId,
    limit: usize,
) -> Result<Vec<RecordId>> {
    load_relation_out_ids_for_playback("includes", record, Music::table_name(), limit).await
}

async fn load_group_music_ids_for_playback(
    record: &RecordId,
    limit: usize,
) -> Result<Vec<RecordId>> {
    load_relation_out_ids_for_playback("grouped", record, Music::table_name(), limit).await
}

async fn load_music_parent_collection_ids(record: &RecordId) -> Result<Vec<RecordId>> {
    load_relation_in_ids("includes", record, Collection::table_name()).await
}

async fn load_music_group_ids(record: &RecordId) -> Result<Vec<RecordId>> {
    load_relation_in_ids("grouped", record, Group::table_name()).await
}

async fn load_relation_out_ids_for_playback(
    relation: &str,
    record: &RecordId,
    out_table: &str,
    limit: usize,
) -> Result<Vec<RecordId>> {
    if limit == 0 {
        return Ok(vec![]);
    }

    let mut accepted = Vec::with_capacity(limit);
    let mut offset = 0usize;
    let batch_limit = limit.max(32);

    loop {
        let rows = load_relation_out_id_rows_for_playback(
            relation,
            record,
            out_table,
            batch_limit,
            offset,
        )
        .await?;
        if rows.is_empty() {
            return Ok(accepted);
        }

        let row_count = rows.len();
        for row in rows {
            if is_music_record_excluded_for_playback(&row.out, out_table).await? {
                continue;
            }

            accepted.push(row.out);
            if accepted.len() >= limit {
                return Ok(accepted);
            }
        }

        offset += row_count;
        if row_count < batch_limit {
            return Ok(accepted);
        }
    }
}

async fn load_relation_out_id_rows_for_playback(
    relation: &str,
    record: &RecordId,
    out_table: &str,
    limit: usize,
    offset: usize,
) -> Result<Vec<CollectionEdgeRow>> {
    let db = get_db()?;
    let mut result = match db
        .query(
            "SELECT out, position FROM $rel WHERE in = $record AND record::tb(out) = $out_table ORDER BY position ASC LIMIT $limit START $offset;",
        )
        .bind(("rel", Table::from(relation)))
        .bind(("record", record.clone()))
        .bind(("out_table", out_table.to_string()))
        .bind(("limit", limit))
        .bind(("offset", offset))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(vec![]),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(vec![]),
            other => return Err(other.into()),
        },
    };

    Ok(result.take(0)?)
}

async fn is_music_record_excluded_for_playback(record: &RecordId, out_table: &str) -> Result<bool> {
    if out_table != Music::table_name() {
        return Ok(false);
    }

    let Some(identity) = load_music_playback_identity(record).await? else {
        return Ok(false);
    };

    is_music_canonical_id_excluded(&identity.canonical_music_id).await
}

async fn is_music_canonical_id_excluded(canonical_music_id: &str) -> Result<bool> {
    let record = RecordId::new(
        StoredExclude::table_name(),
        exclude_canonical_record_id(canonical_music_id).to_string(),
    );

    match Repo::<StoredExclude>::exists_record(record).await {
        Ok(exists) => Ok(exists),
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => Ok(false),
            other => Err(other.into()),
        },
    }
}

async fn count_relation_out_ids_for_playback(
    record: &RecordId,
    relation: &str,
    out_table: &str,
) -> Result<usize> {
    let db = get_db()?;
    let mut result = match db
        .query(
            "RETURN count((SELECT VALUE out FROM $rel WHERE in = $record AND record::tb(out) = $out_table));",
        )
        .bind(("rel", Table::from(relation)))
        .bind(("record", record.clone()))
        .bind(("out_table", out_table.to_string()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(0),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(0),
            other => return Err(other.into()),
        },
    };

    let count: Option<i64> = result.take(0)?;
    Ok(count.unwrap_or(0).max(0) as usize)
}

async fn load_relation_out_id_for_playback_at(
    record: &RecordId,
    relation: &str,
    out_table: &str,
    offset: usize,
) -> Result<Option<RecordId>> {
    let db = get_db()?;
    let mut result = match db
        .query(
            "SELECT out, position FROM $rel WHERE in = $record AND record::tb(out) = $out_table ORDER BY position ASC LIMIT 1 START $offset;",
        )
        .bind(("rel", Table::from(relation)))
        .bind(("record", record.clone()))
        .bind(("out_table", out_table.to_string()))
        .bind(("offset", offset))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(None),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(None),
            other => return Err(other.into()),
        },
    };

    let rows: Vec<CollectionEdgeRow> = result.take(0)?;
    Ok(rows.into_iter().next().map(|row| row.out))
}

async fn load_relation_in_ids(
    relation: &str,
    record: &RecordId,
    in_table: &str,
) -> Result<Vec<RecordId>> {
    let db = get_db()?;
    let mut result = match db
        .query("SELECT VALUE in FROM $rel WHERE out = $record AND record::tb(in) = $in_table;")
        .bind(("rel", Table::from(relation)))
        .bind(("record", record.clone()))
        .bind(("in_table", in_table.to_string()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(vec![]),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(vec![]),
            other => return Err(other.into()),
        },
    };

    Ok(result.take(0)?)
}

async fn find_music_record_ids_by_identity(
    url: &str,
    start_ms: u32,
    end_ms: u32,
) -> Result<Vec<RecordId>> {
    let db = get_db()?;
    let mut result = match db
        .query(
            "SELECT VALUE id FROM $table
             WHERE url = $url AND start_ms = $start_ms AND end_ms = $end_ms;",
        )
        .bind(("table", Table::from(Music::table_name())))
        .bind(("url", url.to_string()))
        .bind(("start_ms", start_ms))
        .bind(("end_ms", end_ms))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(vec![]),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(vec![]),
            other => return Err(other.into()),
        },
    };

    Ok(result.take(0)?)
}

async fn find_music_record_ids_by_canonical_id(canonical_music_id: &str) -> Result<Vec<RecordId>> {
    let db = get_db()?;
    let mut result = match db
        .query(
            "SELECT VALUE id FROM $table
             WHERE canonical_music_id = $canonical_music_id;",
        )
        .bind(("table", Table::from(Music::table_name())))
        .bind(("canonical_music_id", canonical_music_id.to_string()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(vec![]),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(vec![]),
            other => return Err(other.into()),
        },
    };

    Ok(result.take(0)?)
}

async fn load_music_playback_identity(
    record: &RecordId,
) -> Result<Option<MusicPlaybackIdentityRow>> {
    let db = get_db()?;
    let mut result = match db
        .query("SELECT canonical_music_id FROM ONLY $record;")
        .bind(("record", record.clone()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) | DBError::NotFound => return Ok(None),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) | DBError::NotFound => return Ok(None),
            other => return Err(other.into()),
        },
    };

    Ok(result.take(0)?)
}

async fn delete_music_parent_edges(record: &RecordId) -> Result<()> {
    let db = get_db()?;

    match db
        .query("DELETE $rel WHERE out = $record RETURN NONE;")
        .bind(("rel", Table::from("includes")))
        .bind(("record", record.clone()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(_) => Ok(()),
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => Ok(()),
                other => Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => Ok(()),
            other => Err(other.into()),
        },
    }
}

async fn find_unique_record_id_by_string_field<T>(
    field: &str,
    value: &str,
) -> Result<Option<RecordId>>
where
    T: ModelMeta,
{
    let db = get_db()?;
    let mut result = match db
        .query("SELECT VALUE id FROM $table WHERE type::field($field) = $value LIMIT 2;")
        .bind(("table", Table::from(T::table_name())))
        .bind(("field", field.to_string()))
        .bind(("value", value.to_string()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(None),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(None),
            other => return Err(other.into()),
        },
    };

    let ids: Vec<RecordId> = result.take(0)?;
    match ids.len() {
        0 => Ok(None),
        1 => Ok(ids.into_iter().next()),
        _ => bail!(
            "unique lookup on `{}`.{} matched multiple records for value `{value}`",
            T::table_name(),
            field
        ),
    }
}

async fn delete_orphaned_music_records(
    previous_music_ids: Vec<RecordId>,
    next_music_ids: &[RecordId],
) -> Result<()> {
    // appdb fallback lookup can legally reuse one Music row across multiple
    // collections, so cleanup must wait until no includes edge points at it.
    for record in previous_music_ids {
        if next_music_ids.contains(&record) {
            continue;
        }
        if music_parent_count(&record).await? > 0 {
            continue;
        }
        match Music::delete_record(record).await {
            Ok(()) => {}
            Err(error) => match classify_db_error(&error) {
                DBError::MissingTable(_) | DBError::NotFound => {}
                other => return Err(other.into()),
            },
        }
    }

    Ok(())
}

async fn load_exclude_availability() -> Result<ExcludeAvailability> {
    let records = load_exclude_availability_rows().await?;
    let mut fully_excluded_collection_urls = Vec::new();
    let mut fully_excluded_group_urls = Vec::new();

    for record in records {
        if !record.is_fully_excluded() {
            continue;
        }

        match ExcludeOwnerKind::from_str(&record.owner_kind) {
            Some(ExcludeOwnerKind::Collection) => {
                fully_excluded_collection_urls.push(record.owner_url)
            }
            Some(ExcludeOwnerKind::Group) => fully_excluded_group_urls.push(record.owner_url),
            None => continue,
        }
    }

    Ok(ExcludeAvailability {
        fully_excluded_collection_urls,
        fully_excluded_group_urls,
    })
}

async fn load_exclude_availability_rows() -> Result<Vec<StoredExcludeOwnerAvailabilityRow>> {
    let db = get_db()?;
    let mut result = match db
        .query("SELECT owner_kind, owner_url, total_music_count, excluded_music_count FROM $table;")
        .bind((
            "table",
            Table::from(StoredExcludeOwnerAvailability::table_name()),
        ))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(vec![]),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(vec![]),
            other => return Err(other.into()),
        },
    };

    Ok(result.take(0)?)
}

async fn refresh_exclude_availability_for_music_identity(music: &Music) -> Result<()> {
    let records = find_music_record_ids_by_canonical_id(&music.canonical_music_id).await?;
    for record in records {
        refresh_exclude_availability_for_music_record(&record).await?;
    }

    Ok(())
}

async fn refresh_exclude_availability_for_music_record(record: &RecordId) -> Result<()> {
    let parent_collections = load_music_parent_collection_ids(record).await?;
    let parent_groups = load_music_group_ids(record).await?;
    refresh_exclude_availability_for_owner_records(&parent_collections, &parent_groups).await
}

async fn load_group_ids_for_music_records(records: &[RecordId]) -> Result<Vec<RecordId>> {
    let mut seen = HashSet::new();
    let mut groups = Vec::new();

    for record in records {
        for group in load_music_group_ids(record).await? {
            if seen.insert(group.clone()) {
                groups.push(group);
            }
        }
    }

    Ok(groups)
}

async fn load_group_urls_for_records(records: &[RecordId]) -> Result<Vec<String>> {
    let mut urls = Vec::new();

    for record in records {
        if let Some(group) = load_group_shell_row(record).await? {
            urls.push(group.url);
        }
    }

    Ok(urls)
}

async fn refresh_exclude_availability_for_owner_records(
    collection_records: &[RecordId],
    group_records: &[RecordId],
) -> Result<()> {
    for collection_record in collection_records {
        refresh_exclude_availability_for_collection_record(collection_record).await?;
    }
    for group_record in group_records {
        refresh_exclude_availability_for_group_record(group_record).await?;
    }

    Ok(())
}

async fn delete_exclude_availability_for_missing_group_urls(urls: Vec<String>) -> Result<()> {
    for url in urls {
        let exists = find_unique_record_id_by_string_field::<Group>("url", &url)
            .await?
            .is_some();
        if exists {
            continue;
        }

        delete_exclude_availability_for_owner_url(ExcludeOwnerKind::Group, &url).await?;
    }

    Ok(())
}

async fn refresh_exclude_availability_for_collection_record(record: &RecordId) -> Result<()> {
    let Some(collection) = load_collection_shell_row(record).await? else {
        delete_exclude_availability_record(ExcludeOwnerKind::Collection, record).await?;
        return Ok(());
    };

    refresh_exclude_availability_for_owner_record(
        ExcludeOwnerKind::Collection,
        record,
        collection.url,
        "includes",
    )
    .await?;

    let music_records = load_collection_music_ids(record).await?;
    let mut seen_groups = HashSet::<RecordId>::new();
    for music_record in music_records {
        for group_record in load_music_group_ids(&music_record).await? {
            if seen_groups.insert(group_record.clone()) {
                refresh_exclude_availability_for_group_record(&group_record).await?;
            }
        }
    }

    Ok(())
}

async fn refresh_exclude_availability_for_group_record(record: &RecordId) -> Result<()> {
    let Some(group) = load_group_shell_row(record).await? else {
        delete_exclude_availability_record(ExcludeOwnerKind::Group, record).await?;
        return Ok(());
    };

    refresh_exclude_availability_for_owner_record(
        ExcludeOwnerKind::Group,
        record,
        group.url,
        "grouped",
    )
    .await
}

async fn refresh_exclude_availability_for_owner_record(
    owner_kind: ExcludeOwnerKind,
    owner_record: &RecordId,
    owner_url: String,
    relation: &str,
) -> Result<()> {
    let music_records = load_relation_out_ids(relation, owner_record, Music::table_name()).await?;
    let total_music_count = music_records.len() as u32;
    let mut excluded_music_count = 0u32;

    for music_record in music_records {
        if is_music_record_excluded_for_playback(&music_record, Music::table_name()).await? {
            excluded_music_count += 1;
        }
    }

    let id = exclude_availability_record_id(owner_kind, owner_record);
    let record = RecordId::new(StoredExcludeOwnerAvailability::table_name(), id.to_string());
    Repo::<StoredExcludeOwnerAvailability>::upsert_at(
        record,
        StoredExcludeOwnerAvailability {
            id,
            owner_kind: owner_kind.as_str().to_string(),
            owner_url,
            total_music_count,
            excluded_music_count,
            updated_at: AutoFill::pending(),
        },
    )
    .await?;

    Ok(())
}

async fn delete_exclude_availability_record(
    owner_kind: ExcludeOwnerKind,
    owner_record: &RecordId,
) -> Result<()> {
    let record = RecordId::new(
        StoredExcludeOwnerAvailability::table_name(),
        exclude_availability_record_id(owner_kind, owner_record).to_string(),
    );
    delete_exclude_availability_record_id(record).await
}

async fn delete_exclude_availability_for_owner_url(
    owner_kind: ExcludeOwnerKind,
    owner_url: &str,
) -> Result<()> {
    let owner_record = match owner_kind {
        ExcludeOwnerKind::Collection => collection_record_id(owner_url),
        ExcludeOwnerKind::Group => group_record_id(owner_url),
    };
    let record = RecordId::new(
        StoredExcludeOwnerAvailability::table_name(),
        exclude_availability_record_id(owner_kind, &owner_record).to_string(),
    );
    delete_exclude_availability_record_id(record).await
}

async fn delete_exclude_availability_record_id(record: RecordId) -> Result<()> {
    match Repo::<StoredExcludeOwnerAvailability>::delete_record(record).await {
        Ok(()) => Ok(()),
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) | DBError::NotFound => Ok(()),
            other => Err(other.into()),
        },
    }
}

async fn load_relation_out_ids(
    relation: &str,
    record: &RecordId,
    out_table: &str,
) -> Result<Vec<RecordId>> {
    let db = get_db()?;
    let mut result = match db
        .query("SELECT VALUE out FROM $rel WHERE in = $record AND record::tb(out) = $out_table;")
        .bind(("rel", Table::from(relation)))
        .bind(("record", record.clone()))
        .bind(("out_table", out_table.to_string()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(vec![]),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(vec![]),
            other => return Err(other.into()),
        },
    };

    Ok(result.take(0)?)
}

#[derive(Debug, Clone)]
struct PlaylistForeignRecordIds {
    collections: Vec<RecordId>,
    groups: Vec<RecordId>,
}

/// Playlists reference canonical library entities. Saving a draft playlist
/// resolves only the referenced ids; collection/group persistence owns their
/// own fields and graph edges.
async fn resolve_playlist_foreign_record_ids(
    playlist: &PlayList,
) -> Result<PlaylistForeignRecordIds> {
    let mut collections = Vec::with_capacity(playlist.collections.len());
    for collection in &playlist.collections {
        let Some(record) =
            find_unique_record_id_by_string_field::<Collection>("url", &collection.url).await?
        else {
            bail!(
                "playlist `{}` references unknown collection `{}`",
                playlist.name,
                collection.url
            );
        };
        collections.push(record);
    }

    let mut groups = Vec::with_capacity(playlist.groups.len());
    for group in &playlist.groups {
        let Some(record) =
            find_unique_record_id_by_string_field::<Group>("url", &group.url).await?
        else {
            bail!(
                "playlist `{}` references unknown group `{}`",
                playlist.name,
                group.url
            );
        };
        groups.push(record);
    }

    Ok(PlaylistForeignRecordIds {
        collections,
        groups,
    })
}

async fn music_parent_count(record: &RecordId) -> Result<i64> {
    match graph::incoming_count_as::<Collection>(record.clone(), "includes").await {
        Ok(count) => Ok(count),
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => Ok(0),
            other => Err(other.into()),
        },
    }
}

fn collection_record_id(url: &str) -> RecordId {
    RecordId::new(Collection::table_name(), stable_record_key(url))
}

fn group_record_id(url: &str) -> RecordId {
    RecordId::new(Group::table_name(), stable_record_key(url))
}

fn playlist_record_id(name: &str) -> RecordId {
    RecordId::new(PlayList::table_name(), stable_record_key(name))
}

fn exclude_record_id(music: &Music) -> Id {
    exclude_canonical_record_id(&music.canonical_music_id)
}

fn exclude_canonical_record_id(canonical_music_id: &str) -> Id {
    Id::from(stable_record_key(canonical_music_id))
}

fn exclude_availability_record_id(owner_kind: ExcludeOwnerKind, owner_record: &RecordId) -> Id {
    Id::from(stable_record_key(&format!(
        "{}:{}",
        owner_kind.as_str(),
        owner_record.key.to_sql()
    )))
}

fn stable_record_key(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hex::encode(hasher.finalize())
}

fn resolve_music_file_path(
    save_root: &Path,
    collection_folder: &str,
    relative_path: Option<&str>,
) -> Option<PathBuf> {
    let path = PathBuf::from(relative_path?);
    if path.is_absolute() {
        return Some(path);
    }

    Some(save_root.join(collection_folder).join(path))
}

fn is_collection_candidate_for_file_path(
    collection_folder: &str,
    relative_file_path: Option<&Path>,
) -> bool {
    let Some(relative_file_path) = relative_file_path else {
        return true;
    };
    let collection_folder = Path::new(collection_folder);
    relative_file_path == collection_folder || relative_file_path.starts_with(collection_folder)
}

fn same_music_file_path(left: &Path, right: &Path) -> bool {
    normalize_music_file_path_key(left) == normalize_music_file_path_key(right)
}

fn normalize_music_file_path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

#[derive(Debug, Clone, Serialize, Deserialize, SurrealValue, Store)]
#[table_as(Exclude)]
struct StoredExclude {
    id: Id,
    #[foreign]
    music: Music,
    #[pagin]
    #[fill(now)]
    created_at: AutoFill,
}

impl StoredExclude {
    fn into_public(self) -> Exclude {
        Exclude {
            music: self.music,
            created_at: self.created_at,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, SurrealValue)]
#[serde(rename_all = "snake_case")]
enum ExcludeOwnerKind {
    Collection,
    Group,
}

impl ExcludeOwnerKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Collection => "collection",
            Self::Group => "group",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "collection" => Some(Self::Collection),
            "group" => Some(Self::Group),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, SurrealValue, Store)]
struct StoredExcludeOwnerAvailability {
    id: Id,
    owner_kind: String,
    owner_url: String,
    total_music_count: u32,
    excluded_music_count: u32,
    #[pagin]
    #[fill(now)]
    updated_at: AutoFill,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct StoredExcludeOwnerAvailabilityRow {
    #[serde(default)]
    owner_kind: String,
    #[serde(default)]
    owner_url: String,
    #[serde(default)]
    total_music_count: u32,
    #[serde(default)]
    excluded_music_count: u32,
}

impl StoredExcludeOwnerAvailabilityRow {
    fn is_fully_excluded(&self) -> bool {
        self.total_music_count > 0 && self.excluded_music_count >= self.total_music_count
    }
}

#[derive(Debug, Clone, serde::Deserialize, surrealdb_types::SurrealValue)]
struct CollectionEdgeRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    out: RecordId,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct MusicPlaybackIdentityRow {
    canonical_music_id: String,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct PlaylistPlaybackRawRow {
    name: String,
    #[serde(default)]
    collections: serde_json::Value,
    #[serde(default)]
    groups: serde_json::Value,
}

#[derive(Debug, Clone)]
struct PlaylistPlaybackRow {
    name: String,
    collections: Vec<RecordId>,
    groups: Vec<RecordId>,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct CollectionShellRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    id: RecordId,
    name: String,
    url: String,
    folder: String,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct GroupShellRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    id: RecordId,
    name: String,
    url: String,
    folder: String,
}
