use super::model::{Collection, Exclude, Group, Music, PlayList};
use anyhow::{Result, bail};
use appdb::connection::get_db;
use appdb::error::{DBError, classify_db_error};
use appdb::graph;
use appdb::model::meta::ModelMeta;
use appdb::repository::Repo;
use appdb::{AutoFill, Crud, Id, Order, Store};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
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

pub async fn list_playlists() -> Result<Vec<PlayList>> {
    ensure_collection_graph_schema().await?;

    match PlayList::list().order_by("created_at", Order::Asc).await {
        Ok(playlists) => Ok(playlists),
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => Ok(vec![]),
            other => Err(other.into()),
        },
    }
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

pub async fn delete_playlist_by_name(name: &str) -> Result<bool> {
    let Some(record) = find_unique_record_id_by_string_field::<PlayList>("name", name).await?
    else {
        return Ok(false);
    };

    Repo::<PlayList>::delete_record(record).await?;
    Ok(true)
}

pub async fn upsert_playlist(playlist: &PlayList, previous_name: Option<&str>) -> Result<PlayList> {
    let playlist = resolve_playlist_foreign_refs(playlist).await?;
    let existing_record = match previous_name {
        Some(name) => find_unique_record_id_by_string_field::<PlayList>("name", name).await?,
        None => None,
    };
    let record = existing_record
        .clone()
        .unwrap_or_else(|| playlist_record_id(&playlist.name));

    match existing_record {
        Some(record) => Ok(Repo::<PlayList>::update_at(record, playlist.clone()).await?),
        None => Ok(Repo::<PlayList>::create_at(record, playlist.clone()).await?),
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

pub async fn list_musics_by_file_path(file_path: &Path, save_root: &Path) -> Result<Vec<Music>> {
    ensure_collection_graph_schema().await?;

    let target_key = normalize_music_file_path_key(file_path);
    let collections = list_collections().await?;
    let mut seen = HashSet::new();
    let mut musics = Vec::new();

    for collection in collections {
        for music in &collection.musics {
            let Some(resolved_path) =
                resolve_music_file_path(save_root, &collection, music.path.as_deref())
            else {
                continue;
            };

            if normalize_music_file_path_key(&resolved_path) != target_key {
                continue;
            }

            let key = format!("{}:{}:{}", music.url, music.start_ms, music.end_ms);
            if seen.insert(key) {
                musics.push(music.clone());
            }
        }
    }

    Ok(musics)
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

/// Playlists reference canonical library entities. Saving a draft playlist must
/// never overwrite hydrated collection/group records with UI-side shells.
async fn resolve_playlist_foreign_refs(playlist: &PlayList) -> Result<PlayList> {
    let library_collections = list_collections().await?;
    let library_groups = library_group_index(&library_collections);

    Ok(PlayList {
        name: playlist.name.clone(),
        collections: playlist
            .collections
            .iter()
            .map(|collection| {
                library_collections
                    .iter()
                    .find(|candidate| candidate.url == collection.url)
                    .cloned()
                    .unwrap_or_else(|| collection.clone())
            })
            .collect(),
        groups: playlist
            .groups
            .iter()
            .map(|group| {
                library_groups
                    .get(group.url.as_str())
                    .cloned()
                    .unwrap_or_else(|| group.clone())
            })
            .collect(),
        created_at: playlist.created_at.clone(),
    })
}

fn library_group_index(collections: &[Collection]) -> HashMap<String, Group> {
    let mut groups = HashMap::new();

    for collection in collections {
        for music in &collection.musics {
            groups
                .entry(music.group.url.clone())
                .or_insert_with(|| music.group.clone());
        }
    }

    groups
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
