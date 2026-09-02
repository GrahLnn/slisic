use super::*;

use anyhow::{Result, anyhow};
use appdb::error::{DBError, classify_db_error};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;
use surrealdb::types::{RecordId, Table};
use surrealdb_types::{SurrealValue, ToSql};

use crate::domain::playlist_playback::service::resolve_source_music_file_path;

const PLAYLIST_NAME: &str = "All Msic";
const DB_PATH: &str = r"C:\Users\admin\slisic\.tmp\first-slot-fairness-219-v1\surreal.db";
const MODEL_PATH: &str = r"C:\Users\admin\slisic\.tmp\installed-update-2.1.9\previous-data\audio-style-stable-model\stable.json";
const CACHE_PATH: &str =
    r"C:\Users\admin\slisic\.tmp\installed-update-2.1.9\previous-data\first-slot-cache.json";
const SAVE_ROOT: &str = r"C:\Users\admin\Documents\slisic";
const SOURCE_LAW_PATH: &str = r"C:\Users\admin\ann\outputs\audio_style_trajectory_dynamics\current_model_first_slot_sampling_law-v1.md";
const OUTPUT_JSON_PATH: &str = r"C:\Users\admin\ann\outputs\audio_style_trajectory_dynamics\current_model_first_slot_db_inputs-219-v1.json";
const OUTPUT_RECEIPT_PATH: &str = r"C:\Users\admin\ann\outputs\audio_style_trajectory_dynamics\current_model_first_slot_db_inputs-219-v1-receipt.md";
const TEST_LOG_PATH: &str = r"C:\Users\admin\slisic\.tmp\first-slot-fairness-219-v1\export.log";
const CLONE_REPORTED_TOTAL_BYTES: u64 = 313_685_311;
const RANDOM_LIMIT: usize = 96;
const NATIVE_SAMPLE_COUNT: usize = 4;
const MAX_RELATION_ROWS: usize = 200_000;
const MAX_MUSIC_ROWS: usize = 100_000;

#[derive(Debug, Deserialize, SurrealValue)]
struct SnapshotPlaylistRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    id: RecordId,
    name: String,
    collections: Value,
    groups: Value,
    extra: Value,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct RawRelationRow {
    #[serde(
        rename = "owner_record",
        deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string"
    )]
    owner_record: RecordId,
    #[serde(
        rename = "music_record",
        deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string"
    )]
    music_record: RecordId,
    #[serde(default)]
    position: Option<i64>,
    #[serde(default)]
    occurrence_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    canonical_music_id: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    start_ms: Option<u32>,
    #[serde(default)]
    end_ms: Option<u32>,
    #[serde(default)]
    liked: Option<bool>,
    #[serde(default)]
    loudness_profile: Option<LoudnessProfile>,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct RawMusicRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    id: RecordId,
    #[serde(default)]
    occurrence_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    canonical_music_id: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    start_ms: Option<u32>,
    #[serde(default)]
    end_ms: Option<u32>,
    #[serde(default)]
    liked: Option<bool>,
    #[serde(default)]
    loudness_profile: Option<LoudnessProfile>,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct RawSourceCollectionRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    music_record: RecordId,
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    collection_record: RecordId,
    #[serde(default)]
    collection_name: Option<String>,
    #[serde(default)]
    collection_url: Option<String>,
    #[serde(default)]
    collection_folder: Option<String>,
    #[serde(default)]
    collection_last_updated: Option<String>,
    #[serde(default)]
    collection_enable_updates: Option<bool>,
    #[serde(default)]
    position: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct RawMusicGroupRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    music_record: RecordId,
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    group_record: RecordId,
    #[serde(default)]
    group_name: Option<String>,
    #[serde(default)]
    group_url: Option<String>,
    #[serde(default)]
    group_folder: Option<String>,
    #[serde(default)]
    position: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct RawParentRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    group_record: RecordId,
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    collection_record: RecordId,
    #[serde(default)]
    position: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct RawCollectionShell {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    id: RecordId,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    last_updated: Option<String>,
    #[serde(default)]
    enable_updates: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct RawGroupShell {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    id: RecordId,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    folder: Option<String>,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct CountRow {
    row_count: i64,
}

#[derive(Debug, Clone, Deserialize, SurrealValue)]
struct ExcludeRow {
    #[serde(default)]
    canonical_music_id: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct DomainCount {
    total: usize,
    sampler_eligible: usize,
}

fn id_text(id: &RecordId) -> String {
    id.to_sql()
}

fn unique_ids(ids: impl IntoIterator<Item = RecordId>) -> Vec<RecordId> {
    let mut seen = HashSet::new();
    ids.into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

fn canonical_path(path: &Path) -> PathBuf {
    fs::canonicalize(path)
        .unwrap_or_else(|error| panic!("{} should resolve: {error}", path.display()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn sha256_file(path: &Path) -> (usize, String) {
    let bytes = fs::read(path)
        .unwrap_or_else(|error| panic!("{} should be readable: {error}", path.display()));
    (bytes.len(), sha256_bytes(&bytes))
}

fn count_value(rows: Vec<CountRow>) -> Result<usize> {
    Ok(rows
        .first()
        .map(|row| row.row_count.max(0) as usize)
        .unwrap_or(0))
}

async fn count_relation_domain(
    relation: &'static str,
    owner_records: &[RecordId],
    sampler_eligible: bool,
) -> Result<usize> {
    if owner_records.is_empty() {
        return Ok(0);
    }
    let path_clause = if sampler_eligible {
        " AND out.path IS NOT NONE"
    } else {
        ""
    };
    let db = get_db()?;
    let mut result = db
        .query(format!(
            "SELECT count() AS row_count FROM $relation \
             WHERE in IN $owner_records \
               AND record::tb(out) = $music_table{path_clause} \
             GROUP ALL;"
        ))
        .bind(("relation", Table::from(relation)))
        .bind(("owner_records", owner_records.to_vec()))
        .bind(("music_table", Music::table_name().to_string()))
        .await?
        .check()?;
    count_value(result.take(0)?)
}

async fn count_out_domain(
    relation: &'static str,
    music_records: &[RecordId],
    out_table: &'static str,
) -> Result<usize> {
    if music_records.is_empty() {
        return Ok(0);
    }
    let db = get_db()?;
    let mut result = db
        .query(
            "SELECT count() AS row_count FROM $relation \
             WHERE out IN $music_records \
               AND record::tb(in) = $out_table \
             GROUP ALL;",
        )
        .bind(("relation", Table::from(relation)))
        .bind(("music_records", music_records.to_vec()))
        .bind(("out_table", out_table.to_string()))
        .await?
        .check()?;
    count_value(result.take(0)?)
}

async fn count_music_domain(canonical_ids: &[String], path_present: bool) -> Result<usize> {
    if canonical_ids.is_empty() {
        return Ok(0);
    }
    let path_clause = if path_present {
        " AND path IS NOT NONE"
    } else {
        ""
    };
    let db = get_db()?;
    let mut result = db
        .query(format!(
            "SELECT count() AS row_count FROM $table \
             WHERE canonical_music_id IN $canonical_ids{path_clause} \
             GROUP ALL;"
        ))
        .bind(("table", Table::from(Music::table_name())))
        .bind(("canonical_ids", canonical_ids.to_vec()))
        .await?
        .check()?;
    count_value(result.take(0)?)
}

async fn count_direct_music_domain(records: &[RecordId]) -> Result<usize> {
    if records.is_empty() {
        return Ok(0);
    }
    let db = get_db()?;
    let mut result = db
        .query(
            "SELECT count() AS row_count FROM $table\
             WHERE id IN $records AND path IS NOT NONE GROUP ALL;",
        )
        .bind(("table", Table::from(Music::table_name())))
        .bind(("records", records.to_vec()))
        .await?
        .check()?;
    count_value(result.take(0)?)
}

async fn count_record_domain(records: &[RecordId], table: &'static str) -> Result<usize> {
    if records.is_empty() {
        return Ok(0);
    }
    let db = get_db()?;
    let mut result = db
        .query("SELECT count() AS row_count FROM $table WHERE id IN $records GROUP ALL;")
        .bind(("table", Table::from(table)))
        .bind(("records", records.to_vec()))
        .await?
        .check()?;
    count_value(result.take(0)?)
}

async fn load_snapshot_playlist_row() -> Result<SnapshotPlaylistRow> {
    let db = get_db()?;
    let mut result = db
        .query(
            "SELECT id, name, collections, groups, extra FROM $table \
             WHERE name = $name LIMIT 1;",
        )
        .bind(("table", Table::from(PlayList::table_name())))
        .bind(("name", PLAYLIST_NAME.to_string()))
        .await?
        .check()?;
    result
        .take::<Vec<SnapshotPlaylistRow>>(0)?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("playlist `{PLAYLIST_NAME}` is missing"))
}

async fn load_relation_rows(
    relation: &'static str,
    owner_records: &[RecordId],
) -> Result<Vec<RawRelationRow>> {
    if owner_records.is_empty() {
        return Ok(vec![]);
    }
    let db = get_db()?;
    let mut result = db
        .query(
            "SELECT in AS owner_record, out AS music_record, position, \
                    out.occurrence_id AS occurrence_id, out.name AS name, \
                    out.alias AS alias, out.canonical_music_id AS canonical_music_id, \
                    out.url AS url, out.path AS path, out.start_ms AS start_ms, \
                    out.end_ms AS end_ms, out.liked AS liked, \
                    out.loudness_profile AS loudness_profile \
             FROM $relation \
             WHERE in IN $owner_records AND record::tb(out) = $music_table \
             ORDER BY position ASC;",
        )
        .bind(("relation", Table::from(relation)))
        .bind(("owner_records", owner_records.to_vec()))
        .bind(("music_table", Music::table_name().to_string()))
        .await?
        .check()?;
    Ok(result.take(0)?)
}

async fn load_music_rows_by_records(records: &[RecordId]) -> Result<Vec<RawMusicRow>> {
    if records.is_empty() {
        return Ok(vec![]);
    }
    let db = get_db()?;
    let mut result = db
        .query(
            "SELECT id, occurrence_id, name, alias, canonical_music_id, url, path, \
                    start_ms, end_ms, liked, loudness_profile \
             FROM $table WHERE id IN $records;",
        )
        .bind(("table", Table::from(Music::table_name())))
        .bind(("records", records.to_vec()))
        .await?
        .check()?;
    Ok(result.take(0)?)
}

async fn load_music_rows_by_canonical_ids(canonical_ids: &[String]) -> Result<Vec<RawMusicRow>> {
    if canonical_ids.is_empty() {
        return Ok(vec![]);
    }
    let db = get_db()?;
    let mut result = db
        .query(
            "SELECT id, occurrence_id, name, alias, canonical_music_id, url, path, \
                    start_ms, end_ms, liked, loudness_profile \
             FROM $table WHERE canonical_music_id IN $canonical_ids;",
        )
        .bind(("table", Table::from(Music::table_name())))
        .bind(("canonical_ids", canonical_ids.to_vec()))
        .await?
        .check()?;
    Ok(result.take(0)?)
}

async fn load_source_collection_rows(records: &[RecordId]) -> Result<Vec<RawSourceCollectionRow>> {
    if records.is_empty() {
        return Ok(vec![]);
    }
    let db = get_db()?;
    let mut result = db
        .query(
            "SELECT out AS music_record, in AS collection_record, \
                    in.name AS collection_name, in.url AS collection_url, \
                    in.folder AS collection_folder, \
                    in.last_updated AS collection_last_updated, \
                    in.enable_updates AS collection_enable_updates, position \
             FROM $relation \
             WHERE out IN $music_records AND record::tb(in) = $collection_table \
             ORDER BY position ASC;",
        )
        .bind(("relation", Table::from("includes")))
        .bind(("music_records", records.to_vec()))
        .bind(("collection_table", Collection::table_name().to_string()))
        .await?
        .check()?;
    Ok(result.take(0)?)
}

async fn load_group_rows(records: &[RecordId]) -> Result<Vec<RawMusicGroupRow>> {
    if records.is_empty() {
        return Ok(vec![]);
    }
    let db = get_db()?;
    let mut result = db
        .query(
            "SELECT out AS music_record, in AS group_record, \
                    in.name AS group_name, in.url AS group_url, \
                    in.folder AS group_folder, position \
             FROM $relation \
             WHERE out IN $music_records AND record::tb(in) = $group_table \
             ORDER BY position ASC;",
        )
        .bind(("relation", Table::from("grouped")))
        .bind(("music_records", records.to_vec()))
        .bind(("group_table", Group::table_name().to_string()))
        .await?
        .check()?;
    Ok(result.take(0)?)
}

async fn load_parent_rows(records: &[RecordId]) -> Result<Vec<RawParentRow>> {
    if records.is_empty() {
        return Ok(vec![]);
    }
    let db = get_db()?;
    let mut result = db
        .query(
            "SELECT out AS group_record, in AS collection_record, position \
             FROM $relation \
             WHERE out IN $group_records AND record::tb(in) = $collection_table \
             ORDER BY position ASC;",
        )
        .bind(("relation", Table::from("include")))
        .bind(("group_records", records.to_vec()))
        .bind(("collection_table", Collection::table_name().to_string()))
        .await?
        .check()?;
    Ok(result.take(0)?)
}

async fn load_collection_shells(records: &[RecordId]) -> Result<Vec<RawCollectionShell>> {
    if records.is_empty() {
        return Ok(vec![]);
    }
    let db = get_db()?;
    let mut result = db
        .query(
            "SELECT id, name, url, folder, last_updated, enable_updates \
             FROM $table WHERE id IN $records;",
        )
        .bind(("table", Table::from(Collection::table_name())))
        .bind(("records", records.to_vec()))
        .await?
        .check()?;
    Ok(result.take(0)?)
}

async fn load_group_shells(records: &[RecordId]) -> Result<Vec<RawGroupShell>> {
    if records.is_empty() {
        return Ok(vec![]);
    }
    let db = get_db()?;
    let mut result = db
        .query("SELECT id, name, url, folder FROM $table WHERE id IN $records;")
        .bind(("table", Table::from(Group::table_name())))
        .bind(("records", records.to_vec()))
        .await?
        .check()?;
    Ok(result.take(0)?)
}

async fn load_extra_rows(records: &[RecordId]) -> Result<Vec<RawMusicRow>> {
    load_music_rows_by_records(records).await
}

async fn load_excluded_ids(canonical_ids: &[String]) -> Result<(bool, usize, Vec<String>)> {
    if canonical_ids.is_empty() {
        return Ok((true, 0, vec![]));
    }
    let db = get_db()?;
    let count_query = match db
        .query(
            "SELECT count() AS row_count FROM $table \
             WHERE music.canonical_music_id IN $canonical_ids GROUP ALL;",
        )
        .bind(("table", Table::from(Exclude::table_name())))
        .bind(("canonical_ids", canonical_ids.to_vec()))
        .await
    {
        Ok(query) => query,
        Err(error) => {
            return match classify_db_error(&error.into()) {
                DBError::MissingTable(_) => Ok((false, 0, vec![])),
                other => Err(other.into()),
            };
        }
    };
    let mut count_query = match count_query.check() {
        Ok(query) => query,
        Err(error) => {
            return match DBError::from(error) {
                DBError::MissingTable(_) => Ok((false, 0, vec![])),
                other => Err(other.into()),
            };
        }
    };
    let count = count_value(count_query.take(0)?)?;

    let rows = match db
        .query(
            "SELECT music.canonical_music_id AS canonical_music_id \
             FROM $table WHERE music.canonical_music_id IN $canonical_ids;",
        )
        .bind(("table", Table::from(Exclude::table_name())))
        .bind(("canonical_ids", canonical_ids.to_vec()))
        .await
    {
        Ok(query) => query,
        Err(error) => {
            return match classify_db_error(&error.into()) {
                DBError::MissingTable(_) => Ok((false, 0, vec![])),
                other => Err(other.into()),
            };
        }
    };
    let mut rows = match rows.check() {
        Ok(query) => query,
        Err(error) => {
            return match DBError::from(error) {
                DBError::MissingTable(_) => Ok((false, 0, vec![])),
                other => Err(other.into()),
            };
        }
    };
    let excluded_rows: Vec<ExcludeRow> = rows.take(0)?;
    let excluded_ids = excluded_rows
        .into_iter()
        .filter_map(|row| row.canonical_music_id)
        .collect::<Vec<_>>();
    Ok((true, count, excluded_ids))
}

fn music_json(row: &RawMusicRow, db_order: usize) -> Value {
    json!({
        "db_order": db_order,
        "id": id_text(&row.id),
        "occurrence_id": row.occurrence_id,
        "name": row.name,
        "alias": row.alias,
        "canonical_music_id": row.canonical_music_id,
        "url": row.url,
        "path": row.path,
        "start_ms": row.start_ms,
        "end_ms": row.end_ms,
        "liked": row.liked,
        "loudness_profile": row.loudness_profile,
    })
}

fn relation_json(row: &RawRelationRow, db_order: usize) -> Value {
    json!({
        "db_order": db_order,
        "owner_record": id_text(&row.owner_record),
        "music_record": id_text(&row.music_record),
        "position": row.position,
        "occurrence_id": row.occurrence_id,
        "name": row.name,
        "alias": row.alias,
        "canonical_music_id": row.canonical_music_id,
        "url": row.url,
        "path": row.path,
        "start_ms": row.start_ms,
        "end_ms": row.end_ms,
        "liked": row.liked,
        "loudness_profile": row.loudness_profile,
        "sampler_path_eligible": row.path.is_some(),
    })
}

fn source_collection_json(row: &RawSourceCollectionRow, db_order: usize) -> Value {
    json!({
        "db_order": db_order,
        "music_record": id_text(&row.music_record),
        "collection_record": id_text(&row.collection_record),
        "collection_name": row.collection_name,
        "collection_url": row.collection_url,
        "collection_folder": row.collection_folder,
        "collection_last_updated": row.collection_last_updated,
        "collection_enable_updates": row.collection_enable_updates,
        "position": row.position,
    })
}

fn group_json(row: &RawMusicGroupRow, db_order: usize) -> Value {
    json!({
        "db_order": db_order,
        "music_record": id_text(&row.music_record),
        "group_record": id_text(&row.group_record),
        "group_name": row.group_name,
        "group_url": row.group_url,
        "group_folder": row.group_folder,
        "position": row.position,
    })
}

fn parent_json(row: &RawParentRow, db_order: usize) -> Value {
    json!({
        "db_order": db_order,
        "group_record": id_text(&row.group_record),
        "collection_record": id_text(&row.collection_record),
        "position": row.position,
    })
}

fn collection_shell_json(row: &RawCollectionShell, db_order: usize) -> Value {
    json!({
        "db_order": db_order,
        "id": id_text(&row.id),
        "name": row.name,
        "url": row.url,
        "folder": row.folder,
        "last_updated": row.last_updated,
        "enable_updates": row.enable_updates,
    })
}

fn group_shell_json(row: &RawGroupShell, db_order: usize) -> Value {
    json!({
        "db_order": db_order,
        "id": id_text(&row.id),
        "name": row.name,
        "url": row.url,
        "folder": row.folder,
    })
}

fn model_key_json(key: &RealScopeModelKey) -> Value {
    json!({
        "music_url": key.music_url,
        "file_path": key.file_path,
        "start_ms": key.start_ms,
        "end_ms": key.end_ms,
    })
}

fn member_key_json(key: &PlaylistPlaybackModelMemberKey) -> Value {
    json!({
        "music_url": key.music_url,
        "file_path": key.absolute_path.to_string_lossy(),
        "start_ms": key.start_ms,
        "end_ms": key.end_ms,
    })
}

fn source_key(url: &str, start_ms: Option<u32>, end_ms: Option<u32>) -> Option<String> {
    Some(format!("{}:{}:{}", url, start_ms?, end_ms?))
}

fn resolve_candidate_path(
    save_root: &Path,
    folder: Option<&str>,
    path: Option<&str>,
) -> Option<PathBuf> {
    let path = PathBuf::from(path?);
    if path.is_absolute() {
        return Some(path);
    }
    Some(save_root.join(folder?).join(path))
}

fn model_key_for_source(
    url: Option<&str>,
    file_path: Option<&Path>,
    start_ms: Option<u32>,
    end_ms: Option<u32>,
) -> Option<RealScopeModelKey> {
    Some(RealScopeModelKey {
        music_url: url?.to_string(),
        file_path: file_path?.to_string_lossy().into_owned(),
        start_ms: start_ms?,
        end_ms: end_ms?,
    })
}

fn first_group_metadata<'a>(
    music_record: &RecordId,
    groups_by_music: &'a HashMap<RecordId, Vec<RawMusicGroupRow>>,
    parents_by_group: &HashMap<RecordId, Vec<RecordId>>,
    collections_by_record: &'a HashMap<RecordId, RawCollectionShell>,
) -> Option<(&'a RawMusicGroupRow, RecordId, &'a RawCollectionShell)> {
    for group in groups_by_music.get(music_record)? {
        let Some(parent) = parents_by_group
            .get(&group.group_record)
            .and_then(|parents| parents.first())
            .cloned()
        else {
            continue;
        };
        let Some(collection) = collections_by_record.get(&parent) else {
            continue;
        };
        return Some((group, parent, collection));
    }
    None
}

fn materialization_outcome(
    owner_kind: &str,
    owner_index: usize,
    relation: &str,
    owner_record: &RecordId,
    row_index: usize,
    position: Option<i64>,
    music_record: &RecordId,
    canonical_music_id: Option<&str>,
    url: Option<&str>,
    path: Option<&str>,
    start_ms: Option<u32>,
    end_ms: Option<u32>,
    collection_record: Option<&RecordId>,
    collection_folder: Option<&str>,
    excluded: bool,
    model_set: &BTreeSet<RealScopeModelKey>,
    save_root: &Path,
    status: &str,
) -> Value {
    let resolved_path = resolve_candidate_path(save_root, collection_folder, path);
    let is_file = resolved_path.as_ref().is_some_and(|path| path.is_file());
    let model_key = model_key_for_source(url, resolved_path.as_deref(), start_ms, end_ms);
    let model_admitted = model_key
        .as_ref()
        .is_some_and(|key| model_set.contains(key));
    let source_key = url.and_then(|url| source_key(url, start_ms, end_ms));
    let materializable = !excluded && path.is_some() && collection_folder.is_some();
    json!({
        "owner_kind": owner_kind,
        "owner_index": owner_index,
        "relation": relation,
        "owner_record": id_text(owner_record),
        "relation_row_index": row_index,
        "relation_position": position,
        "music_record": id_text(music_record),
        "canonical_music_id": canonical_music_id,
        "source_key": source_key,
        "url": url,
        "path": path,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "collection_record": collection_record.map(id_text),
        "collection_folder": collection_folder,
        "resolved_path": resolved_path.as_ref().map(|path| path.to_string_lossy().into_owned()),
        "is_file": is_file,
        "excluded": excluded,
        "model_key": model_key.as_ref().map(model_key_json),
        "model_admitted": model_admitted,
        "materializable_without_file_check": materializable,
        "status": status,
    })
}

fn cache_source_keys(cache: &Value, playlist_name: &str) -> Vec<String> {
    let Some(playlists) = cache.get("playlists").and_then(Value::as_array) else {
        return vec![];
    };
    playlists
        .iter()
        .find(|playlist| {
            playlist.get("playlist_name").and_then(Value::as_str) == Some(playlist_name)
        })
        .and_then(|playlist| playlist.get("sources"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|source| {
            let music = source.get("music")?;
            source_key(
                music.get("url")?.as_str()?,
                music.get("start_ms")?.as_u64().map(|value| value as u32),
                music.get("end_ms")?.as_u64().map(|value| value as u32),
            )
        })
        .collect()
}

fn cache_playlist_sources(cache: &Value, playlist_name: &str) -> Vec<Value> {
    cache
        .get("playlists")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|playlist| {
            playlist.get("playlist_name").and_then(Value::as_str) == Some(playlist_name)
        })
        .and_then(|playlist| playlist.get("sources").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default()
}

fn db_layout(path: &Path) -> Value {
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(path).follow_links(false) {
        let entry = entry.unwrap_or_else(|error| panic!("DB metadata walk failed: {error}"));
        if entry.file_type().is_file() {
            let metadata = entry.metadata().unwrap_or_else(|error| {
                panic!("{} metadata failed: {error}", entry.path().display())
            });
            files.push(json!({
                "path": entry.path().to_string_lossy(),
                "size_bytes": metadata.len(),
            }));
        }
    }
    files.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    let total_bytes = files
        .iter()
        .map(|file| file["size_bytes"].as_u64().unwrap_or(0))
        .sum::<u64>();
    json!({
        "file_count": files.len(),
        "total_bytes": total_bytes,
        "files": files,
    })
}

fn native_source_json(
    selection: &PlaylistPlaybackSelection,
    source: &PlaylistPlaybackTrackSource,
    sample_index: usize,
    source_index: usize,
    save_root: &Path,
    model_set: &BTreeSet<RealScopeModelKey>,
) -> Value {
    let resolved_path = resolve_source_music_file_path(save_root, source);
    let is_file = resolved_path.as_ref().is_some_and(|path| path.is_file());
    let model_key = resolved_path.as_ref().map(|path| RealScopeModelKey {
        music_url: source.music.url.clone(),
        file_path: path.to_string_lossy().into_owned(),
        start_ms: source.music.start_ms,
        end_ms: source.music.end_ms,
    });
    json!({
        "sample_index": sample_index,
        "source_index": source_index,
        "playlist_name": selection.playlist_name,
        "collection_folder": source.collection_folder,
        "source_key": format!("{}:{}:{}", source.music.url, source.music.start_ms, source.music.end_ms),
        "canonical_music_id": source.music.canonical_music_id,
        "music_url": source.music.url,
        "path": source.music.path,
        "start_ms": source.music.start_ms,
        "end_ms": source.music.end_ms,
        "resolved_path": resolved_path.map(|path| path.to_string_lossy().into_owned()),
        "is_file": is_file,
        "model_admitted": model_key.as_ref().is_some_and(|key| model_set.contains(key)),
        "model_key": model_key.as_ref().map(model_key_json),
        "music": &source.music,
    })
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp_path = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temp_path, bytes)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temp_path, path)?;
    Ok(())
}

fn record_ids_json(ids: &[RecordId]) -> Vec<Value> {
    ids.iter().map(|id| Value::String(id_text(id))).collect()
}

fn add_outcome_field(outcome: &mut Value, key: &str, value: Value) {
    if let Some(object) = outcome.as_object_mut() {
        object.insert(key.to_string(), value);
    }
}

fn relation_identity_status(
    path: Option<&str>,
    canonical_music_id: Option<&str>,
    url: Option<&str>,
    start_ms: Option<u32>,
    end_ms: Option<u32>,
    excluded: bool,
) -> &'static str {
    if path.is_none() {
        "path_filtered"
    } else if canonical_music_id.is_none() {
        "missing_canonical_music_id"
    } else if url.is_none() {
        "missing_music_url"
    } else if start_ms.is_none() || end_ms.is_none() {
        "missing_music_interval"
    } else if excluded {
        "excluded_canonical_id"
    } else {
        "candidate"
    }
}

fn source_collection_missing_metadata(row: &RawSourceCollectionRow) -> bool {
    row.collection_name.is_none()
        || row.collection_url.is_none()
        || row.collection_folder.is_none()
        || row.collection_last_updated.is_none()
}

fn collection_ref_json(
    index: usize,
    record: &RecordId,
    shell: Option<&RawCollectionShell>,
) -> Value {
    let shell = shell.map(|shell| collection_shell_json(shell, 0));
    json!({
        "selection_index": index,
        "record": id_text(record),
        "name": shell.as_ref().and_then(|value| value.get("name")).cloned(),
        "url": shell.as_ref().and_then(|value| value.get("url")).cloned(),
        "folder": shell.as_ref().and_then(|value| value.get("folder")).cloned(),
        "last_updated": shell.as_ref().and_then(|value| value.get("last_updated")).cloned(),
        "enable_updates": shell.as_ref().and_then(|value| value.get("enable_updates")).cloned(),
        "shell_present": shell.is_some(),
    })
}

fn group_ref_json(
    index: usize,
    record: &RecordId,
    shell: Option<&RawGroupShell>,
    parent_records: &[RecordId],
) -> Value {
    let shell = shell.map(|shell| group_shell_json(shell, 0));
    json!({
        "selection_index": index,
        "record": id_text(record),
        "name": shell.as_ref().and_then(|value| value.get("name")).cloned(),
        "url": shell.as_ref().and_then(|value| value.get("url")).cloned(),
        "folder": shell.as_ref().and_then(|value| value.get("folder")).cloned(),
        "parent_collection_records": record_ids_json(parent_records),
        "shell_present": shell.is_some(),
    })
}

fn extra_ref_json(index: usize, record: &RecordId) -> Value {
    json!({
        "selection_index": index,
        "record": id_text(record),
    })
}

#[test]
#[ignore = "requires the owned first-slot fairness DB copy and stable model"]
fn export_all_msic_first_slot_sampler_inputs() {
    let _guard = acquire_db_test_lock();
    let started = Instant::now();

    let db_path = PathBuf::from(DB_PATH);
    let model_path = PathBuf::from(MODEL_PATH);
    let cache_path = PathBuf::from(CACHE_PATH);
    let save_root = PathBuf::from(SAVE_ROOT);
    assert!(
        db_path.is_dir(),
        "owned disposable DB copy must be a directory: {}",
        db_path.display()
    );
    assert!(
        model_path.is_file(),
        "frozen stable model must be a file: {}",
        model_path.display()
    );
    assert!(
        cache_path.is_file(),
        "frozen first-slot cache must be a file: {}",
        cache_path.display()
    );
    assert!(
        Path::new(SOURCE_LAW_PATH).is_file(),
        "source-law receipt must be readable"
    );

    let model_sha256 = sha256_file(&model_path);
    assert_eq!(
        model_sha256.1.to_ascii_uppercase(),
        "C96FA71CD7C3BBCA81191C2E8BD72956EB2C4329A748D89C5DBA8AC88CC6FAC3"
    );
    let (cache_size, cache_sha256) = sha256_file(&cache_path);
    let cache_value: Value =
        serde_json::from_slice(&fs::read(&cache_path).expect("cache bytes should be readable"))
            .unwrap_or_else(|error| panic!("first-slot cache should decode: {error}"));
    let cached_sources = cache_playlist_sources(&cache_value, PLAYLIST_NAME);
    let cached_source_keys = cache_source_keys(&cache_value, PLAYLIST_NAME);

    let (generation, indexed_keys, indexed_key_set, canonical_music_ids) =
        read_real_scope_model_projection(&model_path);
    let snapshot = read_audio_style_stable_model_for_test(&model_path)
        .expect("generation-163 stable model should load through the production carrier");
    assert_eq!(snapshot.generation(), generation);
    let model_members = snapshot.symbolic_playlist_track_member_keys();
    let production_member_keys = model_members
        .iter()
        .map(|member| RealScopeModelKey {
            music_url: member.music_url.clone(),
            file_path: member.absolute_path.to_string_lossy().into_owned(),
            start_ms: member.start_ms,
            end_ms: member.end_ms,
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        production_member_keys, indexed_key_set,
        "stable model production keys must equal independent indexed keys"
    );
    assert_eq!(model_members.len(), indexed_keys.len());

    let db_layout_value = db_layout(&db_path);
    assert_eq!(db_layout_value["file_count"].as_u64(), Some(8));
    assert!(
        db_layout_value["total_bytes"].as_u64().is_some(),
        "owned disposable DB byte total should be observable"
    );

    let export_result = run_async(async {
        reinit_db(db_path.clone())
            .await
            .expect("owned disposable DB copy should initialize");

        let playlist_row = load_snapshot_playlist_row().await?;
        let (raw_collections, raw_groups, raw_extra) =
            load_real_scope_playlist_refs(PLAYLIST_NAME).await;
        let selection = get_playlist_playback_selection_by_name(PLAYLIST_NAME)
            .await?
            .ok_or_else(|| anyhow!("resolved All Msic selection is missing"))?;
        assert_eq!(playlist_row.name, PLAYLIST_NAME);
        assert_eq!(selection.collections.len(), raw_collections.len());
        assert_eq!(selection.groups.len(), raw_groups.len());
        assert_eq!(selection.extra.len(), raw_extra.len());

        let selected_collection_records = raw_collections.clone();
        let selected_group_records = raw_groups.clone();
        let selected_extra_records = raw_extra.clone();
        let unique_collection_records = unique_ids(selected_collection_records.clone());
        let unique_group_records = unique_ids(selected_group_records.clone());
        let unique_extra_records = unique_ids(selected_extra_records.clone());

        let include_count = DomainCount {
            total: count_relation_domain("includes", &unique_collection_records, false).await?,
            sampler_eligible: count_relation_domain("includes", &unique_collection_records, true)
                .await?,
        };
        let grouped_count = DomainCount {
            total: count_relation_domain("grouped", &unique_group_records, false).await?,
            sampler_eligible: count_relation_domain("grouped", &unique_group_records, true).await?,
        };
        assert!(
            include_count.total <= MAX_RELATION_ROWS && grouped_count.total <= MAX_RELATION_ROWS,
            "selected relation domain exceeds bounded export limit"
        );
        let selected_include_rows =
            load_relation_rows("includes", &unique_collection_records).await?;
        let selected_grouped_rows = load_relation_rows("grouped", &unique_group_records).await?;
        assert_eq!(include_count.total, selected_include_rows.len());
        assert_eq!(
            include_count.sampler_eligible,
            selected_include_rows
                .iter()
                .filter(|row| row.path.is_some())
                .count()
        );
        assert_eq!(grouped_count.total, selected_grouped_rows.len());
        assert_eq!(
            grouped_count.sampler_eligible,
            selected_grouped_rows
                .iter()
                .filter(|row| row.path.is_some())
                .count()
        );

        let model_music_count = count_music_domain(&canonical_music_ids, false).await?;
        let model_music_path_count = count_music_domain(&canonical_music_ids, true).await?;
        assert!(
            model_music_count <= MAX_MUSIC_ROWS,
            "model music domain exceeds bounded export limit"
        );
        let model_music_rows = load_music_rows_by_canonical_ids(&canonical_music_ids).await?;
        assert_eq!(model_music_count, model_music_rows.len());

        let mut encountered_music_records = Vec::new();
        encountered_music_records.extend(
            selected_include_rows
                .iter()
                .map(|row| row.music_record.clone()),
        );
        encountered_music_records.extend(
            selected_grouped_rows
                .iter()
                .map(|row| row.music_record.clone()),
        );
        encountered_music_records.extend(selected_extra_records.iter().cloned());
        encountered_music_records.extend(model_music_rows.iter().map(|row| row.id.clone()));
        let encountered_music_records_unique = unique_ids(encountered_music_records.clone());
        let music_domain_count =
            count_record_domain(&encountered_music_records_unique, Music::table_name()).await?;
        assert!(
            music_domain_count <= MAX_MUSIC_ROWS,
            "encountered music domain exceeds bounded export limit"
        );
        let music_rows = load_music_rows_by_records(&encountered_music_records_unique).await?;
        assert_eq!(music_domain_count, music_rows.len());

        let source_collection_count = count_out_domain(
            "includes",
            &encountered_music_records_unique,
            Collection::table_name(),
        )
        .await?;
        let grouped_metadata_count = count_out_domain(
            "grouped",
            &encountered_music_records_unique,
            Group::table_name(),
        )
        .await?;
        let source_collection_rows =
            load_source_collection_rows(&encountered_music_records_unique).await?;
        let grouped_metadata_rows = load_group_rows(&encountered_music_records_unique).await?;
        assert_eq!(source_collection_count, source_collection_rows.len());
        assert_eq!(grouped_metadata_count, grouped_metadata_rows.len());

        let all_group_records = unique_ids(
            selected_group_records.iter().cloned().chain(
                grouped_metadata_rows
                    .iter()
                    .map(|row| row.group_record.clone()),
            ),
        );
        let parent_count =
            count_out_domain("include", &all_group_records, Collection::table_name()).await?;
        let parent_rows = load_parent_rows(&all_group_records).await?;
        assert_eq!(parent_count, parent_rows.len());

        let all_collection_records = unique_ids(
            selected_collection_records
                .iter()
                .cloned()
                .chain(parent_rows.iter().map(|row| row.collection_record.clone()))
                .chain(
                    source_collection_rows
                        .iter()
                        .map(|row| row.collection_record.clone()),
                )
                .chain(parent_rows.iter().map(|row| row.collection_record.clone())),
        );
        let collection_shell_count =
            count_record_domain(&all_collection_records, Collection::table_name()).await?;
        let group_shell_count =
            count_record_domain(&all_group_records, Group::table_name()).await?;
        let collection_shells = load_collection_shells(&all_collection_records).await?;
        let group_shells = load_group_shells(&all_group_records).await?;
        assert_eq!(collection_shell_count, collection_shells.len());
        assert_eq!(group_shell_count, group_shells.len());

        let extra_rows = load_extra_rows(&unique_extra_records).await?;
        let extra_direct_count = count_direct_music_domain(&unique_extra_records).await?;
        assert_eq!(
            extra_direct_count,
            extra_rows.iter().filter(|row| row.path.is_some()).count(),
            "extra direct eligible count must be independently counted"
        );

        let mut all_canonical_ids = canonical_music_ids.clone();
        for row in &music_rows {
            if let Some(id) = row.canonical_music_id.as_ref()
                && !all_canonical_ids.iter().any(|known| known == id)
            {
                all_canonical_ids.push(id.clone());
            }
        }
        for row in selected_include_rows
            .iter()
            .chain(selected_grouped_rows.iter())
        {
            if let Some(id) = row.canonical_music_id.as_ref()
                && !all_canonical_ids.iter().any(|known| known == id)
            {
                all_canonical_ids.push(id.clone());
            }
        }
        for row in &extra_rows {
            if let Some(id) = row.canonical_music_id.as_ref()
                && !all_canonical_ids.iter().any(|known| known == id)
            {
                all_canonical_ids.push(id.clone());
            }
        }
        let (exclude_table_present, exclude_count, excluded_ids) =
            load_excluded_ids(&all_canonical_ids).await?;
        let excluded_set = excluded_ids.iter().cloned().collect::<HashSet<_>>();

        let db_meta = get_meta_info().await?;
        let save_path_from_db = db_meta.as_ref().and_then(|meta| meta.save_path.clone());
        let resolved_meta = resolve_meta_info(db_meta, SAVE_ROOT.to_string());
        let resolved_save_root = PathBuf::from(
            resolved_meta
                .save_path
                .clone()
                .ok_or_else(|| anyhow!("MetaInfo did not provide save root"))?,
        );
        assert_eq!(
            resolved_save_root, save_root,
            "save root must come from copied DB MetaInfo"
        );

        let expected = project_real_scope_from_db(
            &indexed_key_set,
            &canonical_music_ids,
            &raw_collections,
            &raw_groups,
            &raw_extra,
            &resolved_save_root,
        )
        .await;
        let model_sources = load_model_playlist_playback_track_sources(
            &selection,
            &model_members,
            &resolved_save_root,
        )
        .await?;
        let model_resolution = resolve_playlist_playback_source_resolution(
            &selection,
            model_sources,
            &resolved_save_root,
        );
        let admitted_keys = model_resolution
            .tracks
            .iter()
            .map(real_scope_key_from_track)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            admitted_keys, expected.expected_keys,
            "model admitted keys must equal independent DB graph projection"
        );

        let source_collections_by_music = source_collection_rows.iter().cloned().fold(
            HashMap::<RecordId, Vec<RawSourceCollectionRow>>::new(),
            |mut grouped, row| {
                grouped
                    .entry(row.music_record.clone())
                    .or_default()
                    .push(row);
                grouped
            },
        );
        let groups_by_music = grouped_metadata_rows.iter().cloned().fold(
            HashMap::<RecordId, Vec<RawMusicGroupRow>>::new(),
            |mut grouped, row| {
                grouped
                    .entry(row.music_record.clone())
                    .or_default()
                    .push(row);
                grouped
            },
        );
        let parents_by_group = parent_rows.iter().cloned().fold(
            HashMap::<RecordId, Vec<RecordId>>::new(),
            |mut grouped, row| {
                grouped
                    .entry(row.group_record.clone())
                    .or_default()
                    .push(row.collection_record);
                grouped
            },
        );
        let collections_by_record = collection_shells
            .iter()
            .cloned()
            .map(|row| (row.id.clone(), row))
            .collect::<HashMap<_, _>>();
        let groups_by_record = group_shells
            .iter()
            .cloned()
            .map(|row| (row.id.clone(), row))
            .collect::<HashMap<_, _>>();
        let extra_rows_by_record = extra_rows
            .iter()
            .cloned()
            .map(|row| (row.id.clone(), row))
            .collect::<HashMap<_, _>>();

        let mut source_outcomes = Vec::new();
        for (owner_index, collection_record) in raw_collections.iter().enumerate() {
            let collection_shell = collections_by_record.get(collection_record);
            let collection_folder = collection_shell.and_then(|shell| shell.folder.as_deref());
            for (row_index, row) in selected_include_rows
                .iter()
                .filter(|row| row.owner_record == *collection_record)
                .enumerate()
            {
                let excluded = row
                    .canonical_music_id
                    .as_deref()
                    .is_some_and(|id| excluded_set.contains(id));
                let group_metadata = first_group_metadata(
                    &row.music_record,
                    &groups_by_music,
                    &parents_by_group,
                    &collections_by_record,
                );
                let mut status = relation_identity_status(
                    row.path.as_deref(),
                    row.canonical_music_id.as_deref(),
                    row.url.as_deref(),
                    row.start_ms,
                    row.end_ms,
                    excluded,
                );
                if status == "candidate" && collection_shell.is_none() {
                    status = "missing_collection_shell";
                } else if status == "candidate" && collection_folder.is_none() {
                    status = "missing_collection_folder";
                } else if status == "candidate" && group_metadata.is_none() {
                    status = "missing_group_or_parent_metadata";
                }
                let mut outcome = materialization_outcome(
                    "collection",
                    owner_index,
                    "includes",
                    collection_record,
                    row_index,
                    row.position,
                    &row.music_record,
                    row.canonical_music_id.as_deref(),
                    row.url.as_deref(),
                    row.path.as_deref(),
                    row.start_ms,
                    row.end_ms,
                    Some(collection_record),
                    collection_folder,
                    excluded,
                    &expected.expected_keys,
                    &resolved_save_root,
                    status,
                );
                if let Some((group, parent, shell)) = group_metadata {
                    add_outcome_field(
                        &mut outcome,
                        "first_group_metadata",
                        json!({
                            "group_record": id_text(&group.group_record),
                            "group_name": group.group_name,
                            "group_url": group.group_url,
                            "group_folder": group.group_folder,
                            "group_position": group.position,
                            "parent_collection_record": id_text(&parent),
                            "parent_collection_shell": collection_shell_json(shell, 0),
                        }),
                    );
                }
                source_outcomes.push(outcome);
            }
        }

        for (owner_index, group_record) in raw_groups.iter().enumerate() {
            let selected_parent_records = parents_by_group
                .get(group_record)
                .cloned()
                .unwrap_or_default();
            let selected_parents = selected_parent_records.iter().collect::<HashSet<_>>();
            let group_shell_present = groups_by_record.contains_key(group_record);
            for (row_index, row) in selected_grouped_rows
                .iter()
                .filter(|row| row.owner_record == *group_record)
                .enumerate()
            {
                let excluded = row
                    .canonical_music_id
                    .as_deref()
                    .is_some_and(|id| excluded_set.contains(id));
                let mut status = relation_identity_status(
                    row.path.as_deref(),
                    row.canonical_music_id.as_deref(),
                    row.url.as_deref(),
                    row.start_ms,
                    row.end_ms,
                    excluded,
                );
                if status == "candidate" && !group_shell_present {
                    status = "missing_group_shell";
                }
                let matching_collections = source_collections_by_music
                    .get(&row.music_record)
                    .map(|rows| {
                        rows.iter()
                            .filter(|source| selected_parents.contains(&source.collection_record))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if matching_collections.is_empty() {
                    let status = if status == "candidate" {
                        "missing_matching_parent_collection"
                    } else {
                        status
                    };
                    source_outcomes.push(materialization_outcome(
                        "group",
                        owner_index,
                        "grouped",
                        group_record,
                        row_index,
                        row.position,
                        &row.music_record,
                        row.canonical_music_id.as_deref(),
                        row.url.as_deref(),
                        row.path.as_deref(),
                        row.start_ms,
                        row.end_ms,
                        None,
                        None,
                        excluded,
                        &expected.expected_keys,
                        &resolved_save_root,
                        status,
                    ));
                    continue;
                }
                for (choice_index, source_collection) in
                    matching_collections.into_iter().enumerate()
                {
                    let mut choice_status = status;
                    if choice_status == "candidate"
                        && source_collection_missing_metadata(source_collection)
                    {
                        choice_status = "missing_collection_metadata";
                    }
                    let mut outcome = materialization_outcome(
                        "group",
                        owner_index,
                        "grouped",
                        group_record,
                        row_index,
                        row.position,
                        &row.music_record,
                        row.canonical_music_id.as_deref(),
                        row.url.as_deref(),
                        row.path.as_deref(),
                        row.start_ms,
                        row.end_ms,
                        Some(&source_collection.collection_record),
                        source_collection.collection_folder.as_deref(),
                        excluded,
                        &expected.expected_keys,
                        &resolved_save_root,
                        choice_status,
                    );
                    add_outcome_field(
                        &mut outcome,
                        "matching_collection_choice_index",
                        json!(choice_index),
                    );
                    add_outcome_field(
                        &mut outcome,
                        "matching_source_collection",
                        source_collection_json(source_collection, choice_index),
                    );
                    source_outcomes.push(outcome);
                }
            }
        }

        for (owner_index, extra_record) in raw_extra.iter().enumerate() {
            let Some(row) = extra_rows_by_record.get(extra_record) else {
                source_outcomes.push(json!({
                    "owner_kind": "extra",
                    "owner_index": owner_index,
                    "relation": "direct_music",
                    "owner_record": id_text(extra_record),
                    "status": "missing_direct_music_row",
                }));
                continue;
            };
            let excluded = row
                .canonical_music_id
                .as_deref()
                .is_some_and(|id| excluded_set.contains(id));
            let status = relation_identity_status(
                row.path.as_deref(),
                row.canonical_music_id.as_deref(),
                row.url.as_deref(),
                row.start_ms,
                row.end_ms,
                excluded,
            );
            let source_collection = source_collections_by_music
                .get(&row.id)
                .and_then(|rows| rows.first());
            let group_metadata = first_group_metadata(
                &row.id,
                &groups_by_music,
                &parents_by_group,
                &collections_by_record,
            );
            let mut status = status;
            if status == "candidate" && source_collection.is_none() {
                status = "missing_source_collection";
            } else if status == "candidate"
                && source_collection.is_some_and(source_collection_missing_metadata)
            {
                status = "missing_collection_metadata";
            } else if status == "candidate" && group_metadata.is_none() {
                status = "missing_group_or_parent_metadata";
            }
            let mut outcome = materialization_outcome(
                "extra",
                owner_index,
                "direct_music",
                extra_record,
                0,
                None,
                &row.id,
                row.canonical_music_id.as_deref(),
                row.url.as_deref(),
                row.path.as_deref(),
                row.start_ms,
                row.end_ms,
                source_collection.map(|source| &source.collection_record),
                source_collection.and_then(|source| source.collection_folder.as_deref()),
                excluded,
                &expected.expected_keys,
                &resolved_save_root,
                status,
            );
            add_outcome_field(&mut outcome, "direct_music_row", music_json(row, 0));
            if let Some(source_collection) = source_collection {
                add_outcome_field(
                    &mut outcome,
                    "first_source_collection",
                    source_collection_json(source_collection, 0),
                );
            }
            if let Some((group, parent, shell)) = group_metadata {
                add_outcome_field(
                    &mut outcome,
                    "first_group_metadata",
                    json!({
                        "group_record": id_text(&group.group_record),
                        "group_name": group.group_name,
                        "group_url": group.group_url,
                        "group_folder": group.group_folder,
                        "group_position": group.position,
                        "parent_collection_record": id_text(&parent),
                        "parent_collection_shell": collection_shell_json(shell, 0),
                    }),
                );
            }
            source_outcomes.push(outcome);
        }

        let native_started = Instant::now();
        let mut native_samples = Vec::with_capacity(NATIVE_SAMPLE_COUNT);
        for sample_index in 0..NATIVE_SAMPLE_COUNT {
            let sample_started = Instant::now();
            let sources =
                load_random_playlist_playback_track_sources(&selection, RANDOM_LIMIT).await?;
            let source_values = sources
                .iter()
                .enumerate()
                .map(|(source_index, source)| {
                    native_source_json(
                        &selection,
                        source,
                        sample_index,
                        source_index,
                        &resolved_save_root,
                        &expected.expected_keys,
                    )
                })
                .collect::<Vec<_>>();
            native_samples.push(json!({
                "sample_index": sample_index,
                "limit": RANDOM_LIMIT,
                "source_count": sources.len(),
                "elapsed_ms": sample_started.elapsed().as_millis(),
                "sources": source_values,
            }));
        }
        let native_elapsed_ms = native_started.elapsed().as_millis();

        let source_outcomes_by_owner = json!({
            "collection": source_outcomes
                .iter()
                .filter(|outcome| outcome["owner_kind"] == "collection")
                .cloned()
                .collect::<Vec<_>>(),
            "group": source_outcomes
                .iter()
                .filter(|outcome| outcome["owner_kind"] == "group")
                .cloned()
                .collect::<Vec<_>>(),
            "extra": source_outcomes
                .iter()
                .filter(|outcome| outcome["owner_kind"] == "extra")
                .cloned()
                .collect::<Vec<_>>(),
        });
        let model_member_values = model_members
            .iter()
            .map(member_key_json)
            .collect::<Vec<_>>();
        let indexed_key_values = indexed_keys.iter().map(model_key_json).collect::<Vec<_>>();
        let indexed_key_set_values = indexed_key_set
            .iter()
            .map(model_key_json)
            .collect::<Vec<_>>();
        let expected_key_values = expected
            .expected_keys
            .iter()
            .map(model_key_json)
            .collect::<Vec<_>>();
        let admitted_key_values = admitted_keys.iter().map(model_key_json).collect::<Vec<_>>();
        let source_law_meta = sha256_file(Path::new(SOURCE_LAW_PATH));
        let owner_count = selection.collections.len()
            + selection.groups.len()
            + usize::from(!selection.extra.is_empty());
        let owner_probe_limit = owner_count.min(RANDOM_LIMIT);
        let cache_after_pop_first = cached_sources.get(1..).unwrap_or(&[]).to_vec();

        let document = json!({
            "package": "ann-first-slot-db-inputs-219-v1",
            "result_scope": "faithful All Msic first-slot sampler inputs, model scope projection, and handful of native captures",
            "result_type": "Exact",
            "exact_scope": [
                "static selected-reference and relation input export",
                "independent direct eligible counts",
                "independent model graph projection equality",
                "four native random loader captures"
            ],
            "not_claimed": [
                "uniformity",
                "Monte Carlo fairness",
                "fatigue formation",
                "production behavior change"
            ],
            "source_law": {
                "path": SOURCE_LAW_PATH,
                "size_bytes": source_law_meta.0,
                "sha256": source_law_meta.1,
                "owner_sample_limit": RANDOM_LIMIT,
                "owner_selection": "collections_then_groups_then_one_extra_domain",
                "owner_count": owner_count,
                "owner_probe_limit": owner_probe_limit,
                "owner_quota": "ceil(remaining_limit / owners_left)",
                "relation_probe": "min(max(quota, 8), 128)",
                "canonical_id_projection": "model member URL/interval identities are quotiented to distinct canonical_music_id values before DB lookup; exported relation multiplicity remains lossless",
                "native_raw_source_key_dedup": "native appenders dedup raw url:start:end source keys before downstream file/model resolution",
                "model_key_dedup": "model projection retains distinct (music_url, file_path, start_ms, end_ms) keys",
                "group_collection_choice": "all matching parent collection rows retained; native chooses uniformly per grouped row",
                "extra_delivery": "single direct extra domain; native direct-row selection uses rows.pop() (last returned row); prepared cache consumption uses pop-first semantics"
            },
            "authoritative_input": {
                "db_path": DB_PATH,
                "db_path_canonical": canonical_path(&db_path),
                "db_layout": db_layout_value,
                "clone_reported_total_bytes": CLONE_REPORTED_TOTAL_BYTES,
                "db_is_disposable_copy": true,
                "live_db_opened": false,
                "save_root": resolved_save_root,
                "save_root_source": "copied_db_meta",
                "save_path_value_from_db": save_path_from_db,
            },
            "frozen_model": {
                "path": MODEL_PATH,
                "size_bytes": model_sha256.0,
                "sha256": model_sha256.1,
                "generation": generation,
                "indexed_track_count": indexed_keys.len(),
                "indexed_unique_key_count": indexed_key_set.len(),
                "canonical_music_id_count": canonical_music_ids.len(),
                "indexed_ordered_keys": indexed_key_values,
                "indexed_sorted_keys": indexed_key_set_values,
                "canonical_music_ids": canonical_music_ids,
                "production_member_count": model_members.len(),
                "production_member_keys": model_member_values,
            },
            "frozen_cache": {
                "path": CACHE_PATH,
                "size_bytes": cache_size,
                "sha256": cache_sha256,
                "playlist_name": PLAYLIST_NAME,
                "prepared_source_count": cached_sources.len(),
                "prepared_source_keys": cached_source_keys,
                "prepared_sources": cached_sources,
                "after_pop_first_sources": cache_after_pop_first,
                "excluded_keys_carried_in_cache": cached_sources
                    .iter()
                    .filter_map(|source| source.get("excluded_keys"))
                    .cloned()
                    .collect::<Vec<_>>(),
            },
            "playlist_row": {
                "id": id_text(&playlist_row.id),
                "name": playlist_row.name,
                "collections_raw": playlist_row.collections,
                "groups_raw": playlist_row.groups,
                "extra_raw": playlist_row.extra,
            },
            "selected_refs": {
                "raw_collections_ordered": raw_collections
                    .iter()
                    .enumerate()
                    .map(|(index, id)| json!({"selection_index": index, "record": id_text(id)}))
                    .collect::<Vec<_>>(),
                "raw_groups_ordered": raw_groups
                    .iter()
                    .enumerate()
                    .map(|(index, id)| json!({"selection_index": index, "record": id_text(id)}))
                    .collect::<Vec<_>>(),
                "raw_extra_ordered": raw_extra
                    .iter()
                    .enumerate()
                    .map(|(index, id)| json!({"selection_index": index, "record": id_text(id)}))
                    .collect::<Vec<_>>(),
                "resolved_collections_ordered": selection
                    .collections
                    .iter()
                    .enumerate()
                    .map(|(index, _)| {
                        let record = &raw_collections[index];
                        collection_ref_json(index, record, collections_by_record.get(record))
                    })
                    .collect::<Vec<_>>(),
                "resolved_groups_ordered": selection
                    .groups
                    .iter()
                    .enumerate()
                    .map(|(index, _)| {
                        let record = &raw_groups[index];
                        group_ref_json(
                            index,
                            record,
                            groups_by_record.get(record),
                            parents_by_group.get(record).map(Vec::as_slice).unwrap_or(&[]),
                        )
                    })
                    .collect::<Vec<_>>(),
                "resolved_extra_ordered": selection
                    .extra
                    .iter()
                    .enumerate()
                    .map(|(index, _)| extra_ref_json(index, &raw_extra[index]))
                    .collect::<Vec<_>>(),
                "download_scopes_ordered": selection.download_scopes,
                "resolved_owner_counts": {
                    "collections": selection.collections.len(),
                    "groups": selection.groups.len(),
                    "extra_refs": selection.extra.len(),
                    "random_owner_count": owner_count,
                    "random_owner_probe_limit": owner_probe_limit,
                },
            },
            "relation_domains": {
                "selected_includes": {
                    "owner_records_unique_ordered": record_ids_json(&unique_collection_records),
                    "total_count": include_count.total,
                    "sampler_eligible_count": include_count.sampler_eligible,
                    "rows": selected_include_rows
                        .iter()
                        .enumerate()
                        .map(|(index, row)| relation_json(row, index))
                        .collect::<Vec<_>>(),
                },
                "selected_grouped": {
                    "owner_records_unique_ordered": record_ids_json(&unique_group_records),
                    "total_count": grouped_count.total,
                    "sampler_eligible_count": grouped_count.sampler_eligible,
                    "rows": selected_grouped_rows
                        .iter()
                        .enumerate()
                        .map(|(index, row)| relation_json(row, index))
                        .collect::<Vec<_>>(),
                },
                "extra_direct_music": {
                    "record_ids_unique_ordered": record_ids_json(&unique_extra_records),
                    "total_row_count": extra_rows.len(),
                    "sampler_eligible_count": extra_direct_count,
                    "rows": extra_rows
                        .iter()
                        .enumerate()
                        .map(|(index, row)| music_json(row, index))
                        .collect::<Vec<_>>(),
                },
            },
            "music_rows": {
                "model_canonical_domain": {
                    "canonical_ids_ordered": canonical_music_ids,
                    "total_count": model_music_count,
                    "path_present_count": model_music_path_count,
                    "rows": model_music_rows
                        .iter()
                        .enumerate()
                        .map(|(index, row)| music_json(row, index))
                        .collect::<Vec<_>>(),
                },
                "encountered_record_domain": {
                    "record_ids_unique_ordered": record_ids_json(&encountered_music_records_unique),
                    "total_count": music_domain_count,
                    "rows": music_rows
                        .iter()
                        .enumerate()
                        .map(|(index, row)| music_json(row, index))
                        .collect::<Vec<_>>(),
                },
            },
            "metadata_joins": {
                "source_collection_includes": {
                    "music_record_ids_unique_ordered": record_ids_json(&encountered_music_records_unique),
                    "edge_count": source_collection_count,
                    "rows": source_collection_rows
                        .iter()
                        .enumerate()
                        .map(|(index, row)| source_collection_json(row, index))
                        .collect::<Vec<_>>(),
                },
                "music_groups": {
                    "music_record_ids_unique_ordered": record_ids_json(&encountered_music_records_unique),
                    "edge_count": grouped_metadata_count,
                    "rows": grouped_metadata_rows
                        .iter()
                        .enumerate()
                        .map(|(index, row)| group_json(row, index))
                        .collect::<Vec<_>>(),
                },
                "group_parent_collections": {
                    "group_record_ids_unique_ordered": record_ids_json(&all_group_records),
                    "edge_count": parent_count,
                    "rows": parent_rows
                        .iter()
                        .enumerate()
                        .map(|(index, row)| parent_json(row, index))
                        .collect::<Vec<_>>(),
                },
                "collection_shells": {
                    "record_ids_unique_ordered": record_ids_json(&all_collection_records),
                    "row_count": collection_shells.len(),
                    "rows": collection_shells
                        .iter()
                        .enumerate()
                        .map(|(index, row)| collection_shell_json(row, index))
                        .collect::<Vec<_>>(),
                },
                "group_shells": {
                    "record_ids_unique_ordered": record_ids_json(&all_group_records),
                    "row_count": group_shells.len(),
                    "rows": group_shells
                        .iter()
                        .enumerate()
                        .map(|(index, row)| group_shell_json(row, index))
                        .collect::<Vec<_>>(),
                },
            },
            "exclusions": {
                "table_present": exclude_table_present,
                "canonical_ids_queried": all_canonical_ids,
                "row_count": exclude_count,
                "ids": excluded_ids,
                "missing_table_means_no_exclusions": !exclude_table_present,
            },
            "independent_scope_check": {
                "expected_key_count": expected.expected_keys.len(),
                "admitted_key_count": admitted_keys.len(),
                "expected_keys": expected_key_values,
                "admitted_keys": admitted_key_values,
                "equal": expected.expected_keys == admitted_keys,
                "db_graph_projection": {
                    "music_rows": expected.music_rows,
                    "source_collection_edges": expected.source_collection_edges,
                    "grouped_edges": expected.grouped_edges,
                    "group_parent_edges": expected.group_parent_edges,
                    "excluded_ids": expected.excluded_ids,
                },
            },
            "source_outcomes": {
                "outcome_count": source_outcomes.len(),
                "all_relation_candidates_and_missing_cases": source_outcomes,
                "by_owner_kind": source_outcomes_by_owner,
            },
            "native_random_sampler": {
                "sample_count": native_samples.len(),
                "limit": RANDOM_LIMIT,
                "elapsed_ms": native_elapsed_ms,
                "samples": native_samples,
            },
            "resource_observation": {
                "export_elapsed_ms": started.elapsed().as_millis(),
                "native_elapsed_ms": native_elapsed_ms,
                "peak_memory_bytes": Value::Null,
                "memory_note": "Peak memory was not exposed by the bounded Rust test seam; no full audio-tree scan was performed.",
            },
        });
        let json_bytes = serde_json::to_vec_pretty(&document)?;
        atomic_write(Path::new(OUTPUT_JSON_PATH), &json_bytes)?;

        let elapsed_ms = started.elapsed().as_millis();
        let receipt = format!(
            "# All Msic first-slot DB input export receipt\n\n\
Package: `ann-first-slot-db-inputs-219-v1`\n\
Result: **Exact** for the named input export, independent scope/count checks, and four native sampler captures only. This receipt does not claim uniformity, fairness, Monte Carlo coverage, or fatigue behavior.\n\n\
## Frozen inputs\n\n\
- Disposable DB copy: `{DB_PATH}` ({} files, {} bytes).\n\
- Stable model: `{MODEL_PATH}` ({} bytes, SHA-256 `{}`). Generation {} with {} indexed concrete keys and {} production members.\n\
- Cache: `{CACHE_PATH}` ({} bytes, SHA-256 `{}`), {} prepared All Msic sources before pop-first projection.\n\
- Source-law receipt: `{SOURCE_LAW_PATH}` ({} bytes, SHA-256 `{}`).\n\
- Save root resolved from copied DB MetaInfo: `{}`.\n\n\
## Independent DB carrier\n\n\
- Selected refs: {} collections, {} groups, {} extra refs ({} random owner domains; owner probe limit {}).\n\
- Selected `includes`: {} total rows, {} direct sampler-eligible rows.\n\
- Selected `grouped`: {} total rows, {} direct sampler-eligible rows.\n\
- Direct extra rows: {} total rows, {} path-eligible rows.\n\
- Encountered music rows: {}; source-collection edges: {}; grouped metadata edges: {}; group-parent edges: {}; excludes: {} (table present: {}).\n\
- Source outcomes: {} ordered outcomes, including every matching group-parent collection choice and missing/nonmodel/path cases.\n\n\
## Model and native checks\n\n\
- Independent DB graph projection: {} expected admitted model keys; native model loader resolution: {} keys; equality: `{}`.\n\
- Native random loader: {} samples, limit {}, {} total ms; source keys, resolved paths, file existence, and model admission are captured in the JSON.\n\n\
## Execution\n\n\
Command: `cargo test --manifest-path src-tauri/Cargo.toml --lib export_all_msic_first_slot_sampler_inputs -- --ignored --nocapture --test-threads=1`\n\
Total exporter elapsed: {} ms. No live AppData DB, original backup, model/cache mutation, app control, deployment, Git mutation, proposal, fatigue formation, or audio-tree scan was performed.\n",
            db_layout_value["file_count"],
            db_layout_value["total_bytes"],
            model_sha256.0,
            model_sha256.1,
            generation,
            indexed_keys.len(),
            model_members.len(),
            cache_size,
            cache_sha256,
            cached_sources.len(),
            source_law_meta.0,
            source_law_meta.1,
            resolved_save_root.display(),
            selection.collections.len(),
            selection.groups.len(),
            selection.extra.len(),
            owner_count,
            owner_probe_limit,
            include_count.total,
            include_count.sampler_eligible,
            grouped_count.total,
            grouped_count.sampler_eligible,
            extra_rows.len(),
            extra_direct_count,
            music_rows.len(),
            source_collection_rows.len(),
            grouped_metadata_rows.len(),
            parent_rows.len(),
            exclude_count,
            exclude_table_present,
            source_outcomes.len(),
            expected.expected_keys.len(),
            admitted_keys.len(),
            expected.expected_keys == admitted_keys,
            native_samples.len(),
            RANDOM_LIMIT,
            native_elapsed_ms,
            elapsed_ms,
        );
        atomic_write(Path::new(OUTPUT_RECEIPT_PATH), receipt.as_bytes())?;
        let log = format!(
            "package=ann-first-slot-db-inputs-219-v1\nresult=Exact(input-export-native-captures-independent-scope-only)\ndb_path={}\njson_path={}\nreceipt_path={}\nselected_includes_total={}\nselected_includes_eligible={}\nselected_grouped_total={}\nselected_grouped_eligible={}\nextra_total={}\nextra_eligible={}\nmodel_expected_keys={}\nmodel_admitted_keys={}\nmodel_equal={}\nnative_sample_count={}\nnative_elapsed_ms={}\nexport_elapsed_ms={}\n",
            DB_PATH,
            OUTPUT_JSON_PATH,
            OUTPUT_RECEIPT_PATH,
            include_count.total,
            include_count.sampler_eligible,
            grouped_count.total,
            grouped_count.sampler_eligible,
            extra_rows.len(),
            extra_direct_count,
            expected.expected_keys.len(),
            admitted_keys.len(),
            expected.expected_keys == admitted_keys,
            native_samples.len(),
            native_elapsed_ms,
            elapsed_ms,
        );
        atomic_write(Path::new(TEST_LOG_PATH), log.as_bytes())?;
        eprintln!(
            "[first-slot-export] db={} includes={}/{} grouped={}/{} extra={}/{} model={}/{} native_samples={} native_ms={} elapsed_ms={}",
            DB_PATH,
            include_count.sampler_eligible,
            include_count.total,
            grouped_count.sampler_eligible,
            grouped_count.total,
            extra_direct_count,
            extra_rows.len(),
            expected.expected_keys.len(),
            admitted_keys.len(),
            native_samples.len(),
            native_elapsed_ms,
            elapsed_ms,
        );

        Ok::<(), anyhow::Error>(())
    });
    reset_db();
    export_result.expect("All Msic first-slot DB input exporter should complete");
}
