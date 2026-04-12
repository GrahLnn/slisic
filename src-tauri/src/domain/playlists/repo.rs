use super::model::{Collection, Music};
use anyhow::Result;
use appdb::Crud;
use appdb::connection::get_db;
use appdb::error::{DBError, classify_db_error};
use appdb::model::meta::ModelMeta;
use appdb::repository::Repo;
use serde_json::Value;
use sha2::{Digest, Sha256};
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

pub async fn get_collection_by_url(url: &str) -> Result<Option<Collection>> {
    let record = match Collection::find_one_id("url", url).await {
        Ok(record) => record,
        Err(error) => match classify_db_error(&error) {
            DBError::NotFound | DBError::MissingTable(_) => return Ok(None),
            other => return Err(other.into()),
        },
    };

    Ok(Some(Collection::get_record(record).await?))
}

pub async fn set_collection_updates(url: &str, enabled: bool) -> Result<Option<Collection>> {
    let Some(mut collection) = get_collection_by_url(url).await? else {
        return Ok(None);
    };

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
    let record = collection_record_id(&collection.url);
    let previous_music_ids = load_collection_music_ids(&record).await?;
    let root = collection_root_payload(collection)?;
    let db = get_db()?;

    db.query("UPSERT ONLY $record CONTENT $data RETURN NONE;")
        .bind(("record", record.clone()))
        .bind(("data", root))
        .await?
        .check()?;

    let mut next_music_ids = Vec::with_capacity(collection.musics.len());
    for music in &collection.musics {
        let music_record = music_record_id(&collection.url, music);
        Repo::<Music>::upsert_at(music_record.clone(), music.clone()).await?;
        next_music_ids.push(music_record);
    }

    sync_music_edges(&record, &next_music_ids).await?;

    for record in previous_music_ids {
        if next_music_ids.contains(&record) {
            continue;
        }
        let _ = Music::delete_record(record).await;
    }

    Collection::get_record(record).await
}

fn collection_root_payload(collection: &Collection) -> Result<Value> {
    let mut value = serde_json::to_value(collection.clone())?;
    if let Value::Object(map) = &mut value {
        map.remove("musics");
        if map.get("enable_updates").is_some_and(Value::is_null) {
            map.remove("enable_updates");
        }
    }
    Ok(value)
}

async fn load_collection_music_ids(record: &RecordId) -> Result<Vec<RecordId>> {
    let db = get_db()?;
    let mut result = match db
        .query("SELECT out FROM $rel WHERE in = $record ORDER BY position ASC;")
        .bind(("rel", Table::from("includes")))
        .bind(("record", record.clone()))
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

async fn sync_music_edges(source: &RecordId, targets: &[RecordId]) -> Result<()> {
    let db = get_db()?;
    let delete_result = db
        .query("DELETE $rel WHERE in = $record RETURN NONE;")
        .bind(("rel", Table::from("includes")))
        .bind(("record", source.clone()))
        .await?;
    if let Err(error) = delete_result.check() {
        match DBError::from(error) {
            DBError::MissingTable(_) => {}
            other => return Err(other.into()),
        }
    }

    if targets.is_empty() {
        return Ok(());
    }

    let mut sql = String::from("INSERT RELATION INTO $rel [");
    for index in 0..targets.len() {
        if index > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!(
            "{{ in: $in_{index}, out: $out_{index}, position: $position_{index} }}"
        ));
    }
    sql.push_str("] RETURN NONE;");

    let mut query = db.query(sql).bind(("rel", Table::from("includes")));
    for (index, target) in targets.iter().enumerate() {
        query = query
            .bind((format!("in_{index}"), source.clone()))
            .bind((format!("out_{index}"), target.clone()))
            .bind((format!("position_{index}"), index as i64));
    }

    query.await?.check()?;
    Ok(())
}

fn collection_record_id(url: &str) -> RecordId {
    RecordId::new(Collection::table_name(), stable_record_key(url))
}

fn music_record_id(collection_url: &str, music: &Music) -> RecordId {
    RecordId::new(
        Music::table_name(),
        stable_record_key(&format!(
            "{collection_url}|{}|{}|{}|{}",
            music.name,
            music.path.as_deref().unwrap_or_default(),
            music.start,
            music.end
        )),
    )
}

fn stable_record_key(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hex::encode(hasher.finalize())
}

#[derive(Debug, Clone, serde::Deserialize, surrealdb_types::SurrealValue)]
struct CollectionEdgeRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    out: RecordId,
}
