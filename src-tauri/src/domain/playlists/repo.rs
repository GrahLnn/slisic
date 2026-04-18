use super::model::{Collection, Exclude, Music, PlayList};
use anyhow::{Result, bail};
use appdb::{Crud, Id, Store};
use appdb::connection::get_db;
use appdb::error::{DBError, classify_db_error};
use appdb::graph;
use appdb::model::meta::ModelMeta;
use appdb::repository::Repo;
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use surrealdb::types::{RecordId, Table};
use surrealdb_types::SurrealValue;

pub async fn list_collections() -> Result<Vec<Collection>> {
    match Collection::list().await {
        Ok(collections) => Ok(collections),
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => Ok(vec![]),
            other => Err(other.into()),
        },
    }
}

pub async fn list_playlists() -> Result<Vec<PlayList>> {
    match PlayList::list().await {
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
        StoredExclude { id: record, music },
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
    let Some(record) = find_unique_record_id_by_string_field::<Collection>("url", url).await?
    else {
        return Ok(None);
    };

    Ok(Some(Collection::get_record(record).await?))
}

pub async fn get_playlist_by_name(name: &str) -> Result<Option<PlayList>> {
    let Some(record) = find_unique_record_id_by_string_field::<PlayList>("name", name).await?
    else {
        return Ok(None);
    };

    Ok(Some(PlayList::get_record(record).await?))
}

pub async fn upsert_playlist(playlist: &PlayList, previous_name: Option<&str>) -> Result<PlayList> {
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

pub async fn list_auto_update_collections() -> Result<Vec<Collection>> {
    Ok(list_collections()
        .await?
        .into_iter()
        .filter(|collection| collection.enable_updates == Some(true))
        .collect())
}

pub async fn upsert_collection(collection: &Collection) -> Result<Collection> {
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

#[derive(Debug, Clone, Serialize, Deserialize, SurrealValue, Store)]
#[table_as(Exclude)]
struct StoredExclude {
    id: Id,
    #[foreign]
    music: Music,
}

impl StoredExclude {
    fn into_public(self) -> Exclude {
        Exclude { music: self.music }
    }
}

#[derive(Debug, Clone, serde::Deserialize, surrealdb_types::SurrealValue)]
struct CollectionEdgeRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    out: RecordId,
}
