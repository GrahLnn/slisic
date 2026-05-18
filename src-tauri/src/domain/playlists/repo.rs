use super::model::{
    Collection, CollectionSurfaceView, ConfigLibraryView, Exclude, Group, GroupSurfaceView, Music,
    PlayList, PlayListConfigView, PlayListListView, SpectrumMusicContext,
    SpectrumMusicSourceContext,
};
use anyhow::{Result, bail};
use appdb::connection::get_db;
use appdb::error::{DBError, classify_db_error};
use appdb::graph;
use appdb::model::meta::ModelMeta;
use appdb::repository::Repo;
use appdb::{AutoFill, Crud, Id, Order, Store};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use surrealdb::types::{RecordId, Table};
use surrealdb_types::SurrealValue;

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

    Ok(ConfigLibraryView {
        collections,
        groups,
    })
}

pub async fn add_exclude(music: Music) -> Result<Exclude> {
    let record = exclude_record_id(&music);
    let saved = Repo::<StoredExclude>::upsert_at(
        RecordId::new(StoredExclude::table_name(), record.to_string()),
        StoredExclude {
            id: record,
            music,
            created_at: AutoFill::pending(),
        },
    )
    .await?;

    Ok(saved.into_public())
}

pub async fn remove_exclude(music: &Music) -> Result<bool> {
    let record = RecordId::new(
        StoredExclude::table_name(),
        exclude_record_id(music).to_string(),
    );

    let exists = match Repo::<StoredExclude>::exists_record(record.clone()).await {
        Ok(exists) => exists,
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => return Ok(false),
            other => return Err(other.into()),
        },
    };
    if !exists {
        return Ok(false);
    }

    Repo::<StoredExclude>::delete_record(record).await?;
    Ok(true)
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
        music.alias = alias.to_string();
        music.start_ms = next_start_ms;
        music.end_ms = next_end_ms;
        let updated = Repo::<Music>::update_at(record, music).await?;

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
        .unwrap_or_else(|| music.clone()))
}

pub async fn delete_music(url: &str, start_ms: u32, end_ms: u32) -> Result<bool> {
    ensure_collection_graph_schema().await?;

    let records = find_music_record_ids_by_identity(url, start_ms, end_ms).await?;
    if records.is_empty() {
        return Ok(false);
    }

    for record in records {
        delete_music_parent_edges(&record).await?;

        match Music::delete_record(record).await {
            Ok(()) => {}
            Err(error) => match classify_db_error(&error) {
                DBError::MissingTable(_) | DBError::NotFound => {}
                other => return Err(other.into()),
            },
        }
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
    fn matches(&self, music: &Music) -> bool {
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

    let target_key = normalize_music_file_path_key(file_path);
    let collections = list_collections().await?;
    let mut seen = HashSet::new();
    let mut file_musics = Vec::new();
    let mut source = None;

    for collection in collections {
        let mut matched_file_musics = Vec::new();

        for music in &collection.musics {
            let Some(resolved_path) =
                resolve_music_file_path(save_root, &collection, music.path.as_deref())
            else {
                continue;
            };

            if normalize_music_file_path_key(&resolved_path) != target_key {
                continue;
            }

            matched_file_musics.push(music);
            let key = format!("{}:{}:{}", music.url, music.start_ms, music.end_ms);
            if seen.insert(key) {
                file_musics.push(music.clone());
            }
        }

        if source.is_none()
            && let Some(identity) = source_identity
            && let Some(source_music) = matched_file_musics
                .iter()
                .copied()
                .find(|music| identity.matches(music))
            && let Some(source_end_ms) =
                resolve_spectrum_source_end_ms(&collection.musics, identity.url)
        {
            source = Some(SpectrumMusicSourceContext {
                source_collection_url: collection.url.clone(),
                source_end_ms,
                source_group: source_music.group.clone(),
                source_path: source_music.path.clone(),
                source_start_ms: identity.start_ms,
                source_url: identity.url.to_string(),
            });
        }
    }

    Ok(SpectrumMusicContext {
        file_musics,
        source,
    })
}

fn resolve_spectrum_source_end_ms(musics: &[Music], source_url: &str) -> Option<u32> {
    musics
        .iter()
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

    let existing_record =
        find_unique_record_id_by_string_field::<Collection>("url", &collection.url).await?;
    let record = existing_record
        .clone()
        .unwrap_or_else(|| collection_record_id(&collection.url));
    let previous_music_ids = load_collection_music_ids(&record).await?;
    let saved = match existing_record {
        Some(record) => Repo::<Collection>::update_at(record, collection.clone()).await?,
        None => Repo::<Collection>::create_at(record.clone(), collection.clone()).await?,
    };
    let next_music_ids = load_collection_music_ids(&record).await?;
    delete_orphaned_music_records(previous_music_ids, &next_music_ids).await?;
    Ok(saved)
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
    Ok(row.map(|row| PlaylistPlaybackGroupRef {
        record: row.id,
        name: row.name,
        url: row.url,
        folder: row.folder,
    }))
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
    let key = format!(
        "{}:{}:{}:{}",
        collection.url, music.url, music.start_ms, music.end_ms
    );
    if !seen.insert(key) {
        return;
    }

    sources.push(PlaylistPlaybackTrackSource {
        collection_name: collection.name.clone(),
        collection_url: collection.url.clone(),
        collection_folder: collection.folder.clone(),
        music,
    });
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

async fn load_relation_out_ids_for_playback(
    relation: &str,
    record: &RecordId,
    out_table: &str,
    limit: usize,
) -> Result<Vec<RecordId>> {
    if limit == 0 {
        return Ok(vec![]);
    }

    let db = get_db()?;
    let mut result = match db
        .query(
            "SELECT out, position FROM $rel WHERE in = $record AND record::tb(out) = $out_table ORDER BY position ASC LIMIT $limit;",
        )
        .bind(("rel", Table::from(relation)))
        .bind(("record", record.clone()))
        .bind(("out_table", out_table.to_string()))
        .bind(("limit", limit))
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

fn playlist_record_id(name: &str) -> RecordId {
    RecordId::new(PlayList::table_name(), stable_record_key(name))
}

fn exclude_record_id(music: &Music) -> Id {
    Id::from(stable_record_key(&music.url))
}

fn stable_record_key(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hex::encode(hasher.finalize())
}

fn resolve_music_file_path(
    save_root: &Path,
    collection: &Collection,
    relative_path: Option<&str>,
) -> Option<PathBuf> {
    let path = PathBuf::from(relative_path?);
    if path.is_absolute() {
        return Some(path);
    }

    Some(save_root.join(&collection.folder).join(path))
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

#[derive(Debug, Clone, serde::Deserialize, surrealdb_types::SurrealValue)]
struct CollectionEdgeRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    out: RecordId,
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
