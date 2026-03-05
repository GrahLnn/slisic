use super::db_schema::{
    REL_ENTRY_ASSET, REL_PLAYLIST_ENTRY, REL_PLAYLIST_EXCLUDE, TABLE_ASSET, TABLE_ENTRY,
    TABLE_META, TABLE_PLAYLIST,
};
use super::store::SnapshotStore;
use super::types::{
    entry_key, recompute_entry_avg, recompute_playlist_avg, Entry, EntryType, LibraryData, Music,
    Playlist,
};
use appdb::{get_db, init_db, run_tx, RecordId, Table, TxStmt};
use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const META_KEY_STORAGE: &str = "storage";

#[derive(Debug, Clone)]
pub struct SurrealStore;

#[derive(Debug, Deserialize)]
struct PlaylistRow {
    rid: String,
    name: String,
    avg_db: Option<f32>,
    order_index: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct EntryRow {
    rid: String,
    entry_key_norm: String,
    path: Option<String>,
    name: String,
    avg_db: Option<f32>,
    url: Option<String>,
    downloaded_ok: Option<bool>,
    tracking: Option<bool>,
    entry_type: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AssetRow {
    rid: String,
    path: String,
    title: String,
    avg_db: Option<f32>,
    true_peak_dbtp: Option<f32>,
    base_bias: f32,
    user_boost: f32,
    fatigue: f32,
    diversity: f32,
}

#[derive(Debug, Deserialize)]
struct RelRow {
    in_id: String,
    out_id: String,
    order_index: Option<i64>,
}

impl SurrealStore {
    pub async fn open(db_dir: PathBuf) -> Result<Self, String> {
        init_db(db_dir).await.map_err(|e| e.to_string())?;
        Ok(Self)
    }

    async fn query_rows<T>(&self, sql: &str, table: &str) -> Result<Vec<T>, String>
    where
        T: DeserializeOwned,
    {
        let db = get_db().map_err(|e| e.to_string())?;
        let mut result = db
            .query(sql)
            .bind(("table", table.to_string()))
            .await
            .map_err(|e| e.to_string())?
            .check()
            .map_err(|e| e.to_string())?;

        let rows: Vec<serde_json::Value> = result.take(0).map_err(|e| e.to_string())?;
        rows.into_iter()
            .map(|row| serde_json::from_value(row).map_err(|e| e.to_string()))
            .collect()
    }

    async fn load_rel_rows(&self, table: &str) -> Result<Vec<RelRow>, String> {
        self.query_rows::<RelRow>(
            "SELECT record::id(in) AS in_id, record::id(out) AS out_id, order_index FROM type::table($table);",
            table,
        )
        .await
    }

    fn hash_key(prefix: &str, input: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(prefix.as_bytes());
        hasher.update(b"::");
        hasher.update(input.as_bytes());
        let digest = hasher.finalize();
        let mut out = String::with_capacity(digest.len() * 2);
        for byte in digest {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }

    fn playlist_id(name: &str) -> String {
        Self::hash_key("playlist", name)
    }

    fn entry_id(entry_key_norm: &str) -> String {
        Self::hash_key("entry", entry_key_norm)
    }

    fn asset_id(path: &str) -> String {
        Self::hash_key("asset", path)
    }

    fn record_key_from_rid(expected_table: &str, rid: &str) -> Result<String, String> {
        if let Some((table, id)) = rid.split_once(':') {
            if table != expected_table {
                return Err(format!(
                    "record table mismatch: expected {expected_table}, got {table}"
                ));
            }
            if id.is_empty() {
                return Err(format!("empty record id key: {rid}"));
            }
            return Ok(id.to_string());
        }

        if rid.is_empty() {
            return Err("invalid record id: empty".to_string());
        }
        Ok(rid.to_string())
    }

    fn encode_entry_type(entry_type: &EntryType) -> &'static str {
        match entry_type {
            EntryType::Local => "local",
            EntryType::WebList => "weblist",
            EntryType::WebVideo => "webvideo",
            EntryType::Unknown => "unknown",
        }
    }

    fn decode_entry_type(entry_type: &str) -> EntryType {
        match entry_type {
            "local" => EntryType::Local,
            "weblist" => EntryType::WebList,
            "webvideo" => EntryType::WebVideo,
            _ => EntryType::Unknown,
        }
    }

    fn push_rel(
        map: &mut HashMap<String, Vec<(i64, String)>>,
        in_id: String,
        out_id: String,
        order: i64,
    ) {
        map.entry(in_id).or_default().push((order, out_id));
    }

    fn dedup_relation_edges(edges: Vec<(String, String, i64)>) -> Vec<(String, String, i64)> {
        let mut by_pair: HashMap<(String, String), i64> = HashMap::new();
        for (in_id, out_id, order_index) in edges {
            by_pair
                .entry((in_id, out_id))
                .and_modify(|current| {
                    if order_index < *current {
                        *current = order_index;
                    }
                })
                .or_insert(order_index);
        }

        let mut rows: Vec<(String, String, i64)> = by_pair
            .into_iter()
            .map(|((in_id, out_id), order_index)| (in_id, out_id, order_index))
            .collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0).then(a.2.cmp(&b.2)).then(a.1.cmp(&b.1)));
        rows
    }

    async fn clear_music_tables(&self) -> Result<(), String> {
        let mut statements = Vec::with_capacity(7);
        for table in [
            REL_PLAYLIST_ENTRY,
            REL_ENTRY_ASSET,
            REL_PLAYLIST_EXCLUDE,
            TABLE_PLAYLIST,
            TABLE_ENTRY,
            TABLE_ASSET,
            TABLE_META,
        ] {
            statements
                .push(TxStmt::new("DELETE $table RETURN NONE;").bind("table", Table::from(table)));
        }
        run_tx(statements).await.map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[async_trait]
impl SnapshotStore for SurrealStore {
    fn engine_name(&self) -> &'static str {
        "surreal"
    }

    async fn replace_playlist(&self, anchor: &str, playlist: Playlist) -> Result<(), String> {
        let playlist_rows = self
            .query_rows::<PlaylistRow>(
                "SELECT record::id(id) AS rid, name, avg_db, order_index FROM type::table($table);",
                TABLE_PLAYLIST,
            )
            .await?;

        let Some(anchor_row) = playlist_rows.iter().find(|row| row.name == anchor) else {
            return Err(format!("playlist not found: {anchor}"));
        };

        if playlist.name != anchor
            && playlist_rows
                .iter()
                .any(|row| row.name == playlist.name && row.rid != anchor_row.rid)
        {
            return Err(format!("playlist already exists: {}", playlist.name));
        }

        let anchor_playlist_id = Self::record_key_from_rid(TABLE_PLAYLIST, &anchor_row.rid)?;
        let target_playlist_id = Self::playlist_id(&playlist.name);
        let order_index = anchor_row.order_index.unwrap_or(0);
        let now = now_timestamp_ms();

        let mut entry_rows: HashMap<String, Entry> = HashMap::new();
        let mut asset_rows: HashMap<String, Music> = HashMap::new();
        let mut rel_playlist_entry = Vec::new();
        let mut rel_entry_asset = Vec::new();
        let mut rel_playlist_exclude = Vec::new();

        for (entry_order, entry) in playlist.entries.iter().enumerate() {
            let norm = entry_key(entry);
            let entry_id = Self::entry_id(&norm);
            entry_rows
                .entry(entry_id.clone())
                .or_insert_with(|| entry.clone());

            rel_playlist_entry.push((
                target_playlist_id.clone(),
                entry_id.clone(),
                entry_order as i64,
            ));

            for (asset_order, music) in entry.musics.iter().enumerate() {
                let asset_id = Self::asset_id(&music.path);
                asset_rows
                    .entry(asset_id.clone())
                    .or_insert_with(|| music.clone());
                rel_entry_asset.push((entry_id.clone(), asset_id, asset_order as i64));
            }
        }

        for (exclude_order, music) in playlist.exclude.iter().enumerate() {
            let asset_id = Self::asset_id(&music.path);
            asset_rows
                .entry(asset_id.clone())
                .or_insert_with(|| music.clone());
            rel_playlist_exclude.push((target_playlist_id.clone(), asset_id, exclude_order as i64));
        }

        let rel_playlist_entry = Self::dedup_relation_edges(rel_playlist_entry);
        let rel_entry_asset = Self::dedup_relation_edges(rel_entry_asset);
        let rel_playlist_exclude = Self::dedup_relation_edges(rel_playlist_exclude);

        let mut statements = Vec::new();

        statements.push(
            TxStmt::new(
                "UPSERT type::record($table, $id) MERGE {\
                    name: $name,\
                    avg_db: $avg_db,\
                    order_index: $order_index,\
                    updated_at: $updated_at\
                } RETURN NONE;",
            )
            .bind("table", TABLE_PLAYLIST.to_string())
            .bind("id", target_playlist_id.clone())
            .bind("name", playlist.name.clone())
            .bind("avg_db", playlist.avg_db)
            .bind("order_index", order_index)
            .bind("updated_at", now),
        );

        let mut playlist_relation_cleanup_ids = vec![target_playlist_id.clone()];
        if anchor_playlist_id != target_playlist_id {
            playlist_relation_cleanup_ids.push(anchor_playlist_id.clone());
        }

        for playlist_id in playlist_relation_cleanup_ids {
            statements.push(
                TxStmt::new("DELETE $rel WHERE in = $in RETURN NONE;")
                    .bind("rel", Table::from(REL_PLAYLIST_ENTRY))
                    .bind("in", RecordId::new(TABLE_PLAYLIST, playlist_id.clone())),
            );
            statements.push(
                TxStmt::new("DELETE $rel WHERE in = $in RETURN NONE;")
                    .bind("rel", Table::from(REL_PLAYLIST_EXCLUDE))
                    .bind("in", RecordId::new(TABLE_PLAYLIST, playlist_id)),
            );
        }

        let entry_ids: Vec<String> = entry_rows.keys().cloned().collect();
        for entry_id in &entry_ids {
            statements.push(
                TxStmt::new("DELETE $rel WHERE in = $in RETURN NONE;")
                    .bind("rel", Table::from(REL_ENTRY_ASSET))
                    .bind("in", RecordId::new(TABLE_ENTRY, entry_id.clone())),
            );
        }

        for (entry_id, entry) in entry_rows {
            statements.push(
                TxStmt::new(
                    "UPSERT type::record($table, $id) MERGE {\
                        entry_key_norm: $entry_key_norm,\
                        path: $path,\
                        name: $name,\
                        avg_db: $avg_db,\
                        url: $url,\
                        downloaded_ok: $downloaded_ok,\
                        tracking: $tracking,\
                        entry_type: $entry_type,\
                        updated_at: $updated_at\
                    } RETURN NONE;",
                )
                .bind("table", TABLE_ENTRY.to_string())
                .bind("id", entry_id)
                .bind("entry_key_norm", entry_key(&entry))
                .bind("path", entry.path)
                .bind("name", entry.name)
                .bind("avg_db", entry.avg_db)
                .bind("url", entry.url)
                .bind("downloaded_ok", entry.downloaded_ok)
                .bind("tracking", entry.tracking)
                .bind(
                    "entry_type",
                    Self::encode_entry_type(&entry.entry_type).to_string(),
                )
                .bind("updated_at", now),
            );
        }

        for (asset_id, music) in asset_rows {
            statements.push(
                TxStmt::new(
                    "UPSERT type::record($table, $id) MERGE {\
                        path: $path,\
                        title: $title,\
                        avg_db: $avg_db,\
                        true_peak_dbtp: $true_peak_dbtp,\
                        base_bias: $base_bias,\
                        user_boost: $user_boost,\
                        fatigue: $fatigue,\
                        diversity: $diversity,\
                        updated_at: $updated_at\
                    } RETURN NONE;",
                )
                .bind("table", TABLE_ASSET.to_string())
                .bind("id", asset_id)
                .bind("path", music.path)
                .bind("title", music.title)
                .bind("avg_db", music.avg_db)
                .bind("true_peak_dbtp", music.true_peak_dbtp)
                .bind("base_bias", music.base_bias)
                .bind("user_boost", music.user_boost)
                .bind("fatigue", music.fatigue)
                .bind("diversity", music.diversity)
                .bind("updated_at", now),
            );
        }

        for (in_id, out_id, order_index) in rel_playlist_entry {
            statements.push(
                TxStmt::new(
                    "INSERT RELATION INTO $rel [{ in: $in, out: $out, order_index: $order_index, updated_at: $updated_at }] RETURN NONE;",
                )
                .bind("rel", Table::from(REL_PLAYLIST_ENTRY))
                .bind("in", RecordId::new(TABLE_PLAYLIST, in_id))
                .bind("out", RecordId::new(TABLE_ENTRY, out_id))
                .bind("order_index", order_index)
                .bind("updated_at", now),
            );
        }

        for (in_id, out_id, order_index) in rel_entry_asset {
            statements.push(
                TxStmt::new(
                    "INSERT RELATION INTO $rel [{ in: $in, out: $out, order_index: $order_index, updated_at: $updated_at }] RETURN NONE;",
                )
                .bind("rel", Table::from(REL_ENTRY_ASSET))
                .bind("in", RecordId::new(TABLE_ENTRY, in_id))
                .bind("out", RecordId::new(TABLE_ASSET, out_id))
                .bind("order_index", order_index)
                .bind("updated_at", now),
            );
        }

        for (in_id, out_id, order_index) in rel_playlist_exclude {
            statements.push(
                TxStmt::new(
                    "INSERT RELATION INTO $rel [{ in: $in, out: $out, order_index: $order_index, updated_at: $updated_at }] RETURN NONE;",
                )
                .bind("rel", Table::from(REL_PLAYLIST_EXCLUDE))
                .bind("in", RecordId::new(TABLE_PLAYLIST, in_id))
                .bind("out", RecordId::new(TABLE_ASSET, out_id))
                .bind("order_index", order_index)
                .bind("updated_at", now),
            );
        }

        if anchor_playlist_id != target_playlist_id {
            statements.push(
                TxStmt::new("DELETE type::record($table, $id) RETURN NONE;")
                    .bind("table", TABLE_PLAYLIST.to_string())
                    .bind("id", anchor_playlist_id),
            );
        }

        statements.push(
            TxStmt::new(
                "UPSERT type::record($table, $id) MERGE {\
                    key: $key,\
                    schema_version: $schema_version,\
                    updated_at: $updated_at\
                } RETURN NONE;",
            )
            .bind("table", TABLE_META.to_string())
            .bind("id", META_KEY_STORAGE.to_string())
            .bind("key", META_KEY_STORAGE.to_string())
            .bind("schema_version", 1_i64)
            .bind("updated_at", now),
        );

        run_tx(statements).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn load_data(&self) -> Result<LibraryData, String> {
        let mut playlist_rows = self
            .query_rows::<PlaylistRow>(
                "SELECT record::id(id) AS rid, name, avg_db, order_index FROM type::table($table) ORDER BY order_index ASC;",
                TABLE_PLAYLIST,
            )
            .await?;

        if playlist_rows.is_empty() {
            return Ok(LibraryData {
                schema_version: 1,
                playlists: Vec::new(),
            });
        }

        playlist_rows.sort_by_key(|row| row.order_index.unwrap_or(0));

        let entry_rows = self
            .query_rows::<EntryRow>(
                "SELECT record::id(id) AS rid, entry_key_norm, path, name, avg_db, url, downloaded_ok, tracking, entry_type FROM type::table($table);",
                TABLE_ENTRY,
            )
            .await?;

        let asset_rows = self
            .query_rows::<AssetRow>(
                "SELECT record::id(id) AS rid, path, title, avg_db, true_peak_dbtp, base_bias, user_boost, fatigue, diversity FROM type::table($table);",
                TABLE_ASSET,
            )
            .await?;

        let playlist_entry_rows = self.load_rel_rows(REL_PLAYLIST_ENTRY).await?;
        let entry_asset_rows = self.load_rel_rows(REL_ENTRY_ASSET).await?;
        let playlist_exclude_rows = self.load_rel_rows(REL_PLAYLIST_EXCLUDE).await?;

        let entry_map: HashMap<String, EntryRow> = entry_rows
            .into_iter()
            .map(|row| {
                let key = row.rid.clone();
                (key, row)
            })
            .collect();

        let asset_map: HashMap<String, AssetRow> = asset_rows
            .into_iter()
            .map(|row| {
                let key = row.rid.clone();
                (key, row)
            })
            .collect();

        let mut playlist_entries: HashMap<String, Vec<(i64, String)>> = HashMap::new();
        for row in playlist_entry_rows {
            Self::push_rel(
                &mut playlist_entries,
                row.in_id,
                row.out_id,
                row.order_index.unwrap_or(0),
            );
        }

        let mut entry_assets: HashMap<String, Vec<(i64, String)>> = HashMap::new();
        for row in entry_asset_rows {
            Self::push_rel(
                &mut entry_assets,
                row.in_id,
                row.out_id,
                row.order_index.unwrap_or(0),
            );
        }

        let mut playlist_excludes: HashMap<String, Vec<(i64, String)>> = HashMap::new();
        for row in playlist_exclude_rows {
            Self::push_rel(
                &mut playlist_excludes,
                row.in_id,
                row.out_id,
                row.order_index.unwrap_or(0),
            );
        }

        let mut playlists = Vec::with_capacity(playlist_rows.len());
        for playlist_row in playlist_rows {
            let playlist_id = playlist_row.rid.clone();

            let mut entry_edges = playlist_entries.remove(&playlist_id).unwrap_or_default();
            entry_edges.sort_by_key(|(order, _)| *order);

            let mut entries = Vec::with_capacity(entry_edges.len());
            for (_, entry_id) in entry_edges {
                let Some(entry_row) = entry_map.get(&entry_id) else {
                    continue;
                };

                let _entry_key_norm = entry_row.entry_key_norm.clone();

                let mut asset_edges = entry_assets
                    .get(&entry_row.rid)
                    .cloned()
                    .unwrap_or_default();
                asset_edges.sort_by_key(|(order, _)| *order);

                let mut musics = Vec::with_capacity(asset_edges.len());
                for (_, asset_id) in asset_edges {
                    let Some(asset_row) = asset_map.get(&asset_id) else {
                        continue;
                    };
                    musics.push(Music {
                        path: asset_row.path.clone(),
                        title: asset_row.title.clone(),
                        avg_db: asset_row.avg_db,
                        true_peak_dbtp: asset_row.true_peak_dbtp,
                        base_bias: asset_row.base_bias,
                        user_boost: asset_row.user_boost,
                        fatigue: asset_row.fatigue,
                        diversity: asset_row.diversity,
                    });
                }

                let mut entry = Entry {
                    path: entry_row.path.clone(),
                    name: entry_row.name.clone(),
                    musics,
                    avg_db: entry_row.avg_db,
                    url: entry_row.url.clone(),
                    downloaded_ok: entry_row.downloaded_ok,
                    tracking: entry_row.tracking,
                    entry_type: Self::decode_entry_type(&entry_row.entry_type),
                };
                recompute_entry_avg(&mut entry);
                entries.push(entry);
            }

            let mut exclude_edges = playlist_excludes.remove(&playlist_id).unwrap_or_default();
            exclude_edges.sort_by_key(|(order, _)| *order);

            let mut exclude = Vec::with_capacity(exclude_edges.len());
            for (_, asset_id) in exclude_edges {
                let Some(asset_row) = asset_map.get(&asset_id) else {
                    continue;
                };
                exclude.push(Music {
                    path: asset_row.path.clone(),
                    title: asset_row.title.clone(),
                    avg_db: asset_row.avg_db,
                    true_peak_dbtp: asset_row.true_peak_dbtp,
                    base_bias: asset_row.base_bias,
                    user_boost: asset_row.user_boost,
                    fatigue: asset_row.fatigue,
                    diversity: asset_row.diversity,
                });
            }

            let mut playlist = Playlist {
                name: playlist_row.name,
                avg_db: playlist_row.avg_db,
                entries,
                exclude,
            };
            recompute_playlist_avg(&mut playlist);
            playlists.push(playlist);
        }

        Ok(LibraryData {
            schema_version: 1,
            playlists,
        })
    }

    async fn save_data(&self, data: &LibraryData) -> Result<(), String> {
        let now = now_timestamp_ms();

        let mut playlist_rows = Vec::with_capacity(data.playlists.len());
        let mut entry_rows: HashMap<String, Entry> = HashMap::new();
        let mut asset_rows: HashMap<String, Music> = HashMap::new();

        let mut rel_playlist_entry = Vec::new();
        let mut rel_entry_asset = Vec::new();
        let mut rel_playlist_exclude = Vec::new();

        for (playlist_order, playlist) in data.playlists.iter().enumerate() {
            let playlist_id = Self::playlist_id(&playlist.name);
            playlist_rows.push((playlist_id.clone(), playlist.clone(), playlist_order as i64));

            for (entry_order, entry) in playlist.entries.iter().enumerate() {
                let norm = entry_key(entry);
                let entry_id = Self::entry_id(&norm);
                entry_rows
                    .entry(entry_id.clone())
                    .or_insert_with(|| entry.clone());

                rel_playlist_entry.push((
                    playlist_id.clone(),
                    entry_id.clone(),
                    entry_order as i64,
                ));

                for (asset_order, music) in entry.musics.iter().enumerate() {
                    let asset_id = Self::asset_id(&music.path);
                    asset_rows
                        .entry(asset_id.clone())
                        .or_insert_with(|| music.clone());
                    rel_entry_asset.push((entry_id.clone(), asset_id, asset_order as i64));
                }
            }

            for (exclude_order, music) in playlist.exclude.iter().enumerate() {
                let asset_id = Self::asset_id(&music.path);
                asset_rows
                    .entry(asset_id.clone())
                    .or_insert_with(|| music.clone());
                rel_playlist_exclude.push((playlist_id.clone(), asset_id, exclude_order as i64));
            }
        }

        let rel_playlist_entry = Self::dedup_relation_edges(rel_playlist_entry);
        let rel_entry_asset = Self::dedup_relation_edges(rel_entry_asset);
        let rel_playlist_exclude = Self::dedup_relation_edges(rel_playlist_exclude);

        self.clear_music_tables().await?;

        let mut statements = Vec::new();

        for (playlist_id, playlist, order_index) in playlist_rows {
            statements.push(
                TxStmt::new(
                    "UPSERT type::record($table, $id) MERGE {\
                        name: $name,\
                        avg_db: $avg_db,\
                        order_index: $order_index,\
                        updated_at: $updated_at\
                    } RETURN NONE;",
                )
                .bind("table", TABLE_PLAYLIST.to_string())
                .bind("id", playlist_id)
                .bind("name", playlist.name)
                .bind("avg_db", playlist.avg_db)
                .bind("order_index", order_index)
                .bind("updated_at", now),
            );
        }

        for (entry_id, entry) in entry_rows {
            statements.push(
                TxStmt::new(
                    "UPSERT type::record($table, $id) MERGE {\
                        entry_key_norm: $entry_key_norm,\
                        path: $path,\
                        name: $name,\
                        avg_db: $avg_db,\
                        url: $url,\
                        downloaded_ok: $downloaded_ok,\
                        tracking: $tracking,\
                        entry_type: $entry_type,\
                        updated_at: $updated_at\
                    } RETURN NONE;",
                )
                .bind("table", TABLE_ENTRY.to_string())
                .bind("id", entry_id)
                .bind("entry_key_norm", entry_key(&entry))
                .bind("path", entry.path)
                .bind("name", entry.name)
                .bind("avg_db", entry.avg_db)
                .bind("url", entry.url)
                .bind("downloaded_ok", entry.downloaded_ok)
                .bind("tracking", entry.tracking)
                .bind(
                    "entry_type",
                    Self::encode_entry_type(&entry.entry_type).to_string(),
                )
                .bind("updated_at", now),
            );
        }

        for (asset_id, music) in asset_rows {
            statements.push(
                TxStmt::new(
                    "UPSERT type::record($table, $id) MERGE {\
                        path: $path,\
                        title: $title,\
                        avg_db: $avg_db,\
                        true_peak_dbtp: $true_peak_dbtp,\
                        base_bias: $base_bias,\
                        user_boost: $user_boost,\
                        fatigue: $fatigue,\
                        diversity: $diversity,\
                        updated_at: $updated_at\
                    } RETURN NONE;",
                )
                .bind("table", TABLE_ASSET.to_string())
                .bind("id", asset_id)
                .bind("path", music.path)
                .bind("title", music.title)
                .bind("avg_db", music.avg_db)
                .bind("true_peak_dbtp", music.true_peak_dbtp)
                .bind("base_bias", music.base_bias)
                .bind("user_boost", music.user_boost)
                .bind("fatigue", music.fatigue)
                .bind("diversity", music.diversity)
                .bind("updated_at", now),
            );
        }

        for (in_id, out_id, order_index) in rel_playlist_entry {
            statements.push(
                TxStmt::new(
                    "INSERT RELATION INTO $rel [{ in: $in, out: $out, order_index: $order_index, updated_at: $updated_at }] RETURN NONE;",
                )
                .bind("rel", Table::from(REL_PLAYLIST_ENTRY))
                .bind("in", RecordId::new(TABLE_PLAYLIST, in_id))
                .bind("out", RecordId::new(TABLE_ENTRY, out_id))
                .bind("order_index", order_index)
                .bind("updated_at", now),
            );
        }

        for (in_id, out_id, order_index) in rel_entry_asset {
            statements.push(
                TxStmt::new(
                    "INSERT RELATION INTO $rel [{ in: $in, out: $out, order_index: $order_index, updated_at: $updated_at }] RETURN NONE;",
                )
                .bind("rel", Table::from(REL_ENTRY_ASSET))
                .bind("in", RecordId::new(TABLE_ENTRY, in_id))
                .bind("out", RecordId::new(TABLE_ASSET, out_id))
                .bind("order_index", order_index)
                .bind("updated_at", now),
            );
        }

        for (in_id, out_id, order_index) in rel_playlist_exclude {
            statements.push(
                TxStmt::new(
                    "INSERT RELATION INTO $rel [{ in: $in, out: $out, order_index: $order_index, updated_at: $updated_at }] RETURN NONE;",
                )
                .bind("rel", Table::from(REL_PLAYLIST_EXCLUDE))
                .bind("in", RecordId::new(TABLE_PLAYLIST, in_id))
                .bind("out", RecordId::new(TABLE_ASSET, out_id))
                .bind("order_index", order_index)
                .bind("updated_at", now),
            );
        }

        statements.push(
            TxStmt::new(
                "UPSERT type::record($table, $id) MERGE {\
                    key: $key,\
                    schema_version: $schema_version,\
                    updated_at: $updated_at\
                } RETURN NONE;",
            )
            .bind("table", TABLE_META.to_string())
            .bind("id", META_KEY_STORAGE.to_string())
            .bind("key", META_KEY_STORAGE.to_string())
            .bind("schema_version", data.schema_version as i64)
            .bind("updated_at", now),
        );

        run_tx(statements).await.map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn now_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::SurrealStore;
    use crate::domain::music::store::SnapshotStore;
    use crate::domain::music::types::{Entry, EntryType, LibraryData, Music, Playlist};

    fn sample_music(path: &str, title: &str, avg_db: Option<f32>) -> Music {
        Music {
            path: path.to_string(),
            title: title.to_string(),
            avg_db,
            true_peak_dbtp: None,
            base_bias: 0.1,
            user_boost: 0.2,
            fatigue: 0.3,
            diversity: 0.4,
        }
    }

    fn sample_data() -> LibraryData {
        let entry = Entry {
            path: Some("C:\\music\\alpha".to_string()),
            name: "alpha-folder".to_string(),
            musics: vec![
                sample_music("C:\\music\\alpha\\a.flac", "a", Some(-16.2)),
                sample_music("C:\\music\\alpha\\b.flac", "b", Some(-18.1)),
            ],
            avg_db: None,
            url: None,
            downloaded_ok: Some(true),
            tracking: Some(false),
            entry_type: EntryType::Local,
        };

        let web_entry = Entry {
            path: None,
            name: "web-entry".to_string(),
            musics: vec![sample_music("C:\\music\\web\\x.flac", "x", Some(-14.0))],
            avg_db: None,
            url: Some("https://example.com/list".to_string()),
            downloaded_ok: Some(true),
            tracking: Some(true),
            entry_type: EntryType::WebList,
        };

        let playlist = Playlist {
            name: "contemporary".to_string(),
            avg_db: None,
            entries: vec![entry, web_entry],
            exclude: vec![sample_music(
                "C:\\music\\excluded\\z.flac",
                "z",
                Some(-20.0),
            )],
        };

        LibraryData {
            schema_version: 1,
            playlists: vec![playlist],
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    #[ignore = "depends on local SurrealKV file-lock behavior in CI/dev sandboxes"]
    async fn save_load_roundtrip_preserves_structure() {
        let db_dir = std::env::current_dir()
            .expect("current dir")
            .join("target")
            .join(format!(
                "ransic_music_store_test_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));

        if db_dir.exists() {
            let _ = std::fs::remove_dir_all(&db_dir);
        }

        let store = SurrealStore::open(db_dir)
            .await
            .expect("open surreal store");
        let data = sample_data();
        store.save_data(&data).await.expect("save data");

        let loaded = store.load_data().await.expect("load data");
        assert_eq!(loaded.playlists.len(), 1);
        assert_eq!(loaded.playlists[0].name, "contemporary");
        assert_eq!(loaded.playlists[0].entries.len(), 2);
        assert_eq!(loaded.playlists[0].entries[0].name, "alpha-folder");
        assert_eq!(loaded.playlists[0].entries[1].name, "web-entry");
        assert_eq!(loaded.playlists[0].exclude.len(), 1);
        assert_eq!(loaded.playlists[0].exclude[0].title, "z");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    #[ignore = "depends on local SurrealKV file-lock behavior in CI/dev sandboxes"]
    async fn replace_playlist_should_update_single_playlist() {
        let db_dir = std::env::current_dir()
            .expect("current dir")
            .join("target")
            .join(format!(
                "ransic_music_store_replace_test_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));

        if db_dir.exists() {
            let _ = std::fs::remove_dir_all(&db_dir);
        }

        let store = SurrealStore::open(db_dir)
            .await
            .expect("open surreal store");
        let data = sample_data();
        store.save_data(&data).await.expect("save data");

        let mut next = data.playlists[0].clone();
        next.name = "contemporary-renamed".to_string();
        next.exclude.clear();
        next.entries.reverse();

        store
            .replace_playlist("contemporary", next)
            .await
            .expect("replace playlist");

        let loaded = store.load_data().await.expect("load data");
        assert_eq!(loaded.playlists.len(), 1);
        assert_eq!(loaded.playlists[0].name, "contemporary-renamed");
        assert!(loaded.playlists[0].exclude.is_empty());
        assert_eq!(loaded.playlists[0].entries.len(), 2);
    }

    #[test]
    fn dedup_relation_edges_should_keep_smallest_order_for_same_pair() {
        let rows = vec![
            ("p1".to_string(), "e1".to_string(), 4),
            ("p1".to_string(), "e1".to_string(), 2),
            ("p1".to_string(), "e2".to_string(), 3),
            ("p1".to_string(), "e2".to_string(), 5),
            ("p2".to_string(), "e3".to_string(), 1),
        ];
        let deduped = SurrealStore::dedup_relation_edges(rows);
        assert_eq!(
            deduped,
            vec![
                ("p1".to_string(), "e1".to_string(), 2),
                ("p1".to_string(), "e2".to_string(), 3),
                ("p2".to_string(), "e3".to_string(), 1),
            ]
        );
    }

    #[test]
    fn clear_music_tables_delete_sql_should_use_bound_table() {
        let stmt = super::TxStmt::new("DELETE $table RETURN NONE;")
            .bind("table", super::Table::from(super::TABLE_PLAYLIST));
        assert_eq!(stmt.sql, "DELETE $table RETURN NONE;");
        assert!(stmt.bindings.contains_key("table"));
    }

    #[test]
    fn record_key_from_rid_should_parse_expected_table() {
        let key = SurrealStore::record_key_from_rid("music_playlist", "music_playlist:abc123")
            .expect("parse record id");
        assert_eq!(key, "abc123");
    }

    #[test]
    fn record_key_from_rid_should_reject_wrong_table() {
        let err = SurrealStore::record_key_from_rid("music_playlist", "music_asset:abc123")
            .expect_err("table mismatch should fail");
        assert!(err.contains("record table mismatch"));
    }

    #[test]
    fn record_key_from_rid_should_accept_plain_key() {
        let key = SurrealStore::record_key_from_rid("music_playlist", "abc123")
            .expect("plain key should be accepted");
        assert_eq!(key, "abc123");
    }
}
