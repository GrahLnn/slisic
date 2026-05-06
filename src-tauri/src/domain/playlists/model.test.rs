use super::model::{Collection, Group, Music, PlayList};
use appdb::connection::{InitDbOptions, get_db, reinit_db_with_options, reset_db};
use appdb::model::meta::ModelMeta;
use appdb::query::{RawSqlStmt, query_bound_checked, query_bound_return};
use appdb::{AutoFill, Crud};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};
use surrealdb::types::{RecordId, SurrealValue, Table};
use tokio::runtime::Runtime;

static DB_TEST_RT: LazyLock<Runtime> =
    LazyLock::new(|| Runtime::new().expect("playlist db test runtime should be created"));

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, SurrealValue)]
struct StoredPlayListRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    id: RecordId,
    name: String,
    collections: Vec<RecordId>,
    groups: Vec<RecordId>,
    created_at: AutoFill,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, SurrealValue)]
struct StoredCollectionRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    id: RecordId,
    name: String,
    url: String,
    folder: String,
    last_updated: String,
    #[serde(default)]
    enable_updates: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, SurrealValue)]
struct StoredMusicEdgeRow {
    #[serde(rename = "in")]
    #[serde(default)]
    source: Option<RecordId>,
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    out: RecordId,
    position: i64,
}

fn test_db_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();

    std::env::temp_dir().join(format!(
        "ransic_playlist_model_test_{}_{}",
        std::process::id(),
        nanos
    ))
}

fn run_async<T>(fut: impl std::future::Future<Output = T>) -> T {
    DB_TEST_RT.block_on(fut)
}

fn acquire_db_test_lock() -> std::sync::MutexGuard<'static, ()> {
    super::PLAYLIST_DB_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn ensure_db() {
    reinit_db_with_options(
        test_db_path(),
        InitDbOptions::default()
            .versioned(false)
            .changefeed_gc_interval(None),
    )
    .await
    .expect("playlist database should initialize");
}

async fn bootstrap_table(table: &str) {
    let db = get_db().expect("global playlist database handle should exist");

    db.query(format!("DEFINE TABLE IF NOT EXISTS {table} SCHEMALESS;"))
        .await
        .expect("table bootstrap query should succeed")
        .check()
        .expect("table bootstrap response should succeed");
}

async fn bootstrap_relation_table(table: &str) {
    let db = get_db().expect("global playlist database handle should exist");

    db.query(format!(
        "DEFINE TABLE IF NOT EXISTS {table} TYPE RELATION SCHEMALESS;"
    ))
    .await
    .expect("relation table bootstrap query should succeed")
    .check()
    .expect("relation table bootstrap response should succeed");
}

async fn insert_music_row(music: &Music) -> RecordId {
    let db = get_db().expect("global playlist database handle should exist");
    let mut result = db
        .query("CREATE $table CONTENT $data RETURN VALUE id;")
        .bind(("table", Table::from(Music::table_name())))
        .bind(("data", music.clone()))
        .await
        .expect("music insert query should succeed")
        .check()
        .expect("music insert response should succeed");

    let record: Option<RecordId> = result.take(0).expect("music insert id should decode");
    record.expect("music insert should return one record id")
}

async fn insert_collection_row(id: &str, collection: &Collection) -> RecordId {
    let db = get_db().expect("global playlist database handle should exist");
    let mut result = db
        .query("CREATE $record CONTENT $data RETURN VALUE id;")
        .bind(("record", RecordId::new(Collection::table_name(), id)))
        .bind((
            "data",
            json!({
                "name": collection.name,
                "url": collection.url,
                "folder": collection.folder,
                "last_updated": collection.last_updated,
                "enable_updates": collection.enable_updates,
            }),
        ))
        .await
        .expect("collection insert query should succeed")
        .check()
        .expect("collection insert response should succeed");

    let record: Option<RecordId> = result.take(0).expect("collection insert id should decode");
    record.expect("collection insert should return one record id")
}

async fn insert_group_row(id: &str, group: &Group) -> RecordId {
    let db = get_db().expect("global playlist database handle should exist");
    let mut result = db
        .query("CREATE $record CONTENT $data RETURN VALUE id;")
        .bind(("record", RecordId::new(Group::table_name(), id)))
        .bind((
            "data",
            json!({
                "name": group.name,
                "url": group.url,
                "folder": group.folder,
            }),
        ))
        .await
        .expect("group insert query should succeed")
        .check()
        .expect("group insert response should succeed");

    let record: Option<RecordId> = result.take(0).expect("group insert id should decode");
    record.expect("group insert should return one record id")
}

async fn insert_music_edges(source: &RecordId, targets: &[RecordId]) {
    if targets.is_empty() {
        return;
    }

    let db = get_db().expect("global playlist database handle should exist");
    let mut sql = String::from("INSERT RELATION INTO $rel [");
    for idx in 0..targets.len() {
        if idx > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!(
            "{{ in: $in_{idx}, out: $out_{idx}, position: $position_{idx} }}"
        ));
    }
    sql.push_str("] RETURN NONE;");

    let mut query = db.query(sql).bind(("rel", Table::from("includes")));
    for (idx, target) in targets.iter().enumerate() {
        query = query
            .bind((format!("in_{idx}"), source.clone()))
            .bind((format!("out_{idx}"), target.clone()))
            .bind((format!("position_{idx}"), idx as i64));
    }

    query
        .await
        .expect("music edge insert query should succeed")
        .check()
        .expect("music edge insert response should succeed");
}

async fn insert_group_edges(source: &RecordId, targets: &[RecordId]) {
    if targets.is_empty() {
        return;
    }

    let db = get_db().expect("global playlist database handle should exist");
    let mut sql = String::from("INSERT RELATION INTO $rel [");
    for idx in 0..targets.len() {
        if idx > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!(
            "{{ in: $in_{idx}, out: $out_{idx}, position: $position_{idx} }}"
        ));
    }
    sql.push_str("] RETURN NONE;");

    let mut query = db.query(sql).bind(("rel", Table::from("grouped")));
    for (idx, target) in targets.iter().enumerate() {
        query = query
            .bind((format!("in_{idx}"), source.clone()))
            .bind((format!("out_{idx}"), target.clone()))
            .bind((format!("position_{idx}"), idx as i64));
    }

    query
        .await
        .expect("group edge insert query should succeed")
        .check()
        .expect("group edge insert response should succeed");
}

async fn insert_playlist_row(
    id: &str,
    playlist: &PlayList,
    collections: &[RecordId],
    groups: &[RecordId],
) -> RecordId {
    let db = get_db().expect("global playlist database handle should exist");
    let mut result = db
        .query("CREATE $record CONTENT $data RETURN VALUE id;")
        .bind(("record", RecordId::new(PlayList::table_name(), id)))
        .bind((
            "data",
            json!({
                "name": playlist.name,
                "collections": collections,
                "groups": groups,
                "created_at": playlist.created_at.clone(),
            }),
        ))
        .await
        .expect("playlist insert query should succeed")
        .check()
        .expect("playlist insert response should succeed");

    let record: Option<RecordId> = result.take(0).expect("playlist insert id should decode");
    record.expect("playlist insert should return one record id")
}

async fn load_playlist_rows_raw() -> Vec<serde_json::Value> {
    let stmt = RawSqlStmt::new("SELECT * FROM type::table($table);")
        .bind("table", Table::from(PlayList::table_name()));
    let mut result = query_bound_checked(stmt)
        .await
        .expect("playlist raw row query should succeed");

    result.take(0).expect("playlist raw rows should decode")
}

async fn load_collection_row(record: &RecordId) -> StoredCollectionRow {
    let stmt = RawSqlStmt::new("SELECT * FROM ONLY $record;").bind("record", record.clone());

    let value = query_bound_return::<serde_json::Value>(stmt)
        .await
        .expect("collection raw query should succeed")
        .expect("collection row should exist");

    serde_json::from_value(value).expect("collection row should decode")
}

async fn load_group_row(record: &RecordId) -> Group {
    let stmt = RawSqlStmt::new("SELECT * FROM ONLY $record;").bind("record", record.clone());

    query_bound_return::<Group>(stmt)
        .await
        .expect("group raw query should succeed")
        .expect("group row should exist")
}

async fn load_music_edges(record: &RecordId) -> Vec<StoredMusicEdgeRow> {
    let stmt = RawSqlStmt::new(
        "SELECT in, out, position FROM $rel WHERE in = $record ORDER BY position ASC;",
    )
    .bind("rel", Table::from("includes"))
    .bind("record", record.clone());
    let mut result = query_bound_checked(stmt)
        .await
        .expect("music edge query should succeed");

    result.take(0).expect("music edge rows should decode")
}

async fn load_music_record(record: &RecordId) -> Music {
    let stmt = RawSqlStmt::new("SELECT * FROM ONLY $record;").bind("record", record.clone());

    query_bound_return::<Music>(stmt)
        .await
        .expect("music raw query should succeed")
        .expect("related music row should exist")
}

fn sample_collection(
    name: &str,
    url: &str,
    folder: &str,
    enable_updates: Option<bool>,
) -> Collection {
    let group = Group {
        name: name.to_string(),
        url: url.to_string(),
        folder: folder.to_string(),
    };

    Collection {
        name: name.to_string(),
        url: url.to_string(),
        folder: folder.to_string(),
        musics: vec![
            Music {
                name: format!("{name} intro"),
                alias: format!("{name} intro"),
                group: group.clone(),
                url: format!("{url}#intro"),
                path: Some(format!("{name}.m4a")),
                start_ms: 0,
                end_ms: 42_000,
            },
            Music {
                name: format!("{name} outro"),
                alias: format!("{name} outro"),
                group,
                url: format!("{url}#outro"),
                path: Some(format!("{name}.m4a")),
                start_ms: 42_000,
                end_ms: 84_000,
            },
        ],
        last_updated: "2026-04-12T12:00:00+00:00".to_string(),
        enable_updates,
    }
}

fn sample_playlist() -> PlayList {
    PlayList {
        name: "favorites".to_string(),
        collections: vec![
            sample_collection(
                "playlist-alpha",
                "https://example.com/playlist-alpha",
                "youtube/playlist-alpha",
                Some(false),
            ),
            sample_collection(
                "single-beta",
                "https://example.com/single-beta",
                "youtube/single-beta",
                None,
            ),
        ],
        groups: vec![
            Group {
                name: "playlist-alpha".to_string(),
                url: "https://example.com/playlist-alpha".to_string(),
                folder: "youtube/playlist-alpha".to_string(),
            },
            Group {
                name: "single-beta".to_string(),
                url: "https://example.com/single-beta".to_string(),
                folder: "youtube/single-beta".to_string(),
            },
        ],
        created_at: AutoFill::pending(),
    }
}

fn assert_group_eq(actual: &Group, expected: &Group) {
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.url, expected.url);
    assert_eq!(actual.folder, expected.folder);
}

fn assert_music_eq(actual: &Music, expected: &Music) {
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.alias, expected.alias);
    assert_eq!(actual.group.name, expected.group.name);
    assert_eq!(actual.group.url, expected.group.url);
    assert_eq!(actual.group.folder, expected.group.folder);
    assert_eq!(actual.url, expected.url);
    assert_eq!(actual.path, expected.path);
    assert_eq!(actual.start_ms, expected.start_ms);
    assert_eq!(actual.end_ms, expected.end_ms);
}

fn assert_collection_eq(actual: &Collection, expected: &Collection) {
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.url, expected.url);
    assert_eq!(actual.folder, expected.folder);
    assert_eq!(actual.last_updated, expected.last_updated);
    assert_eq!(actual.enable_updates, expected.enable_updates);
    assert_eq!(actual.musics.len(), expected.musics.len());

    for (actual_music, expected_music) in actual.musics.iter().zip(expected.musics.iter()) {
        assert_music_eq(actual_music, expected_music);
    }
}

fn assert_playlist_eq(actual: &PlayList, expected: &PlayList) {
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.collections.len(), expected.collections.len());
    assert_eq!(actual.groups.len(), expected.groups.len());

    for (actual_collection, expected_collection) in
        actual.collections.iter().zip(expected.collections.iter())
    {
        assert_collection_eq(actual_collection, expected_collection);
    }

    for (actual_group, expected_group) in actual.groups.iter().zip(expected.groups.iter()) {
        assert_group_eq(actual_group, expected_group);
    }
}

#[test]
fn serializes_playlist_with_nested_collections_and_musics() {
    let playlist = sample_playlist();

    let value = serde_json::to_value(&playlist).expect("playlist should serialize");

    assert_eq!(value["name"], "favorites");
    assert_eq!(value["collections"][0]["folder"], "youtube/playlist-alpha");
    assert_eq!(
        value["groups"][0]["url"],
        "https://example.com/playlist-alpha"
    );
    assert_eq!(
        value["collections"][0]["musics"][0]["name"],
        "playlist-alpha intro"
    );
    assert_eq!(
        value["collections"][0]["musics"][0]["alias"],
        "playlist-alpha intro"
    );
    assert_eq!(
        value["collections"][0]["musics"][0]["group"]["url"],
        "https://example.com/playlist-alpha"
    );
    assert_eq!(
        value["collections"][1]["enable_updates"],
        serde_json::Value::Null
    );
}

#[test]
fn deserializes_playlist_with_collection_update_flags() {
    let value = json!({
        "name": "study",
        "created_at": "2026-04-12T00:00:00.000000000Z",
        "groups": [
            {
                "name": "playlist-a",
                "url": "https://example.com/playlist-a",
                "folder": "youtube/playlist-a"
            },
            {
                "name": "single-b",
                "url": "https://example.com/single-b",
                "folder": "youtube/single-b"
            }
        ],
        "collections": [
            {
                "name": "playlist-a",
                "url": "https://example.com/playlist-a",
                "folder": "youtube/playlist-a",
                "last_updated": "2026-04-12T00:00:00+00:00",
                "enable_updates": true,
                "musics": [
                    {
                        "name": "track-a",
                        "alias": "track-a",
                        "group": {
                            "name": "playlist-a",
                            "url": "https://example.com/playlist-a",
                            "folder": "youtube/playlist-a"
                        },
                        "url": "https://example.com/track-a",
                        "path": "track-a.m4a",
                        "start_ms": 0,
                        "end_ms": 120000
                    }
                ]
            },
            {
                "name": "single-b",
                "url": "https://example.com/single-b",
                "folder": "youtube/single-b",
                "last_updated": "2026-04-12T00:00:00+00:00",
                "enable_updates": null,
                "musics": [
                    {
                        "name": "track-b",
                        "alias": "track-b",
                        "group": {
                            "name": "single-b",
                            "url": "https://example.com/single-b",
                            "folder": "youtube/single-b"
                        },
                        "url": "https://example.com/track-b",
                        "path": null,
                        "start_ms": 0,
                        "end_ms": 90000
                    }
                ]
            }
        ]
    });

    let playlist: PlayList =
        serde_json::from_value(value).expect("playlist json should deserialize");

    assert_eq!(playlist.name, "study");
    assert_eq!(playlist.collections.len(), 2);
    assert_eq!(playlist.groups.len(), 2);
    assert_eq!(playlist.collections[0].enable_updates, Some(true));
    assert_eq!(playlist.collections[1].enable_updates, None);
    assert_eq!(playlist.groups[0].url, "https://example.com/playlist-a");
    assert_eq!(playlist.collections[1].musics[0].path, None);
    assert_eq!(
        playlist.created_at.as_str(),
        Some("2026-04-12T00:00:00.000000000Z")
    );
}

#[test]
fn clone_keeps_nested_collection_data_independent() {
    let playlist = sample_playlist();
    let mut cloned = playlist.clone();

    cloned.name = "favorites-copy".to_string();
    cloned.groups[0].name = "playlist-alpha-group-copy".to_string();
    cloned.collections[0].name = "playlist-alpha-copy".to_string();
    cloned.collections[0].musics[0].name = "playlist-alpha remix".to_string();
    cloned.collections[0].musics[0].alias = "playlist-alpha remix".to_string();

    assert_eq!(playlist.name, "favorites");
    assert_eq!(playlist.groups[0].name, "playlist-alpha");
    assert_eq!(playlist.collections[0].name, "playlist-alpha");
    assert_eq!(
        playlist.collections[0].musics[0].name,
        "playlist-alpha intro"
    );
    assert_eq!(
        playlist.collections[0].musics[0].alias,
        "playlist-alpha intro"
    );

    assert_eq!(cloned.name, "favorites-copy");
    assert_eq!(cloned.groups[0].name, "playlist-alpha-group-copy");
    assert_eq!(cloned.collections[0].name, "playlist-alpha-copy");
    assert_eq!(cloned.collections[0].musics[0].name, "playlist-alpha remix");
    assert_eq!(
        cloned.collections[0].musics[0].alias,
        "playlist-alpha remix"
    );
}

#[test]
fn collection_create_fails_on_fresh_db_when_related_music_table_is_missing() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let err = sample_collection(
            "playlist-alpha",
            "https://example.com/playlist-alpha",
            "youtube/playlist-alpha",
            Some(false),
        )
        .create()
        .await
        .expect_err("collection create should fail before the related music table exists");

        assert!(err.to_string().contains("Missing table"));
        assert!(err.to_string().contains(Music::table_name()));

        reset_db();
    });
}

#[test]
fn get_and_list_hydrate_nested_playlist_relations_from_seeded_rows() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_table(Group::table_name()).await;
        bootstrap_table(Music::table_name()).await;
        bootstrap_table(Collection::table_name()).await;
        bootstrap_table(PlayList::table_name()).await;
        bootstrap_relation_table("includes").await;
        bootstrap_relation_table("grouped").await;

        let playlist = sample_playlist();
        let mut collection_records = Vec::with_capacity(playlist.collections.len());
        let mut group_records = Vec::with_capacity(playlist.groups.len());

        for (index, group) in playlist.groups.iter().enumerate() {
            group_records.push(insert_group_row(&format!("seeded-group-{index}"), group).await);
        }

        for (index, collection) in playlist.collections.iter().enumerate() {
            let mut music_records = Vec::with_capacity(collection.musics.len());
            for music in &collection.musics {
                music_records.push(insert_music_row(music).await);
            }

            let collection_record =
                insert_collection_row(&format!("seeded-collection-{index}"), collection).await;
            insert_music_edges(&collection_record, &music_records).await;
            insert_group_edges(&group_records[index], &music_records).await;
            collection_records.push(collection_record);
        }

        let playlist_record = insert_playlist_row(
            "seeded-playlist",
            &playlist,
            &collection_records,
            &group_records,
        )
        .await;

        let saved = PlayList::get_record(playlist_record.clone())
            .await
            .expect("playlist get_record should succeed");
        let listed = PlayList::list()
            .await
            .expect("playlist list should succeed");
        let raw_rows = load_playlist_rows_raw().await;

        assert_playlist_eq(&saved, &playlist);
        assert_eq!(listed.len(), 1);
        assert_playlist_eq(&listed[0], &playlist);
        assert_eq!(raw_rows.len(), 1);

        let raw_root = raw_rows
            .into_iter()
            .next()
            .expect("playlist raw row should exist");
        let raw_root_object = raw_root
            .as_object()
            .expect("playlist raw row should be an object");

        assert_eq!(
            raw_root_object.get("name"),
            Some(&serde_json::Value::String("favorites".to_owned()))
        );
        assert!(
            raw_root_object.contains_key("collections"),
            "playlist row should store foreign collection links inline"
        );
        assert!(
            raw_root_object.contains_key("groups"),
            "playlist row should store foreign group links inline"
        );

        let stored_root: StoredPlayListRow =
            serde_json::from_value(raw_root).expect("playlist raw row should decode");
        assert_eq!(stored_root.name, playlist.name);
        assert_eq!(stored_root.collections.len(), playlist.collections.len());
        assert_eq!(stored_root.groups.len(), playlist.groups.len());
        assert_eq!(stored_root.created_at, playlist.created_at);

        for (group_record, expected_group) in stored_root.groups.iter().zip(playlist.groups.iter())
        {
            let stored_group = load_group_row(group_record).await;
            assert_group_eq(&stored_group, expected_group);
        }

        for (index, collection_record) in stored_root.collections.iter().enumerate() {
            let stored_collection = load_collection_row(collection_record).await;
            let collection_edges = load_music_edges(&stored_collection.id).await;
            let expected_collection = &playlist.collections[index];

            assert_eq!(stored_collection.name, expected_collection.name);
            assert_eq!(stored_collection.url, expected_collection.url);
            assert_eq!(stored_collection.folder, expected_collection.folder);
            assert_eq!(
                stored_collection.last_updated,
                expected_collection.last_updated
            );
            assert_eq!(
                stored_collection.enable_updates,
                expected_collection.enable_updates
            );
            assert_eq!(collection_edges.len(), expected_collection.musics.len());

            for (edge, expected_music) in collection_edges
                .iter()
                .zip(expected_collection.musics.iter())
            {
                let stored_music = load_music_record(&edge.out).await;
                assert_music_eq(&stored_music, expected_music);
            }
        }

        reset_db();
    });
}

#[test]
fn playlist_create_and_list_succeed_once_relation_schema_exists() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_table(Group::table_name()).await;
        bootstrap_table(Music::table_name()).await;
        bootstrap_table(Collection::table_name()).await;
        bootstrap_table(PlayList::table_name()).await;
        bootstrap_relation_table("includes").await;

        let playlist = sample_playlist();
        let saved = PlayList::create_at(
            RecordId::new(PlayList::table_name(), "model-check"),
            playlist.clone(),
        )
        .await
        .expect("playlist create_at should succeed once relation schema exists");
        let listed = PlayList::list()
            .await
            .expect("playlist list should succeed once relation schema exists");

        assert_playlist_eq(&saved, &playlist);
        assert_eq!(listed.len(), 1);
        assert_playlist_eq(&listed[0], &playlist);
        assert!(
            saved.created_at.as_str().is_some(),
            "playlist create_at should resolve created_at"
        );
        assert_eq!(saved.created_at, listed[0].created_at);

        reset_db();
    });
}
