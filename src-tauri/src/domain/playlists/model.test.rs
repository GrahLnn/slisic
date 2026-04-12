use super::model::{Music, PlayList};
use appdb::Crud;
use appdb::connection::{InitDbOptions, get_db, reinit_db_with_options, reset_db};
use appdb::model::meta::ModelMeta;
use appdb::query::{RawSqlStmt, query_bound_checked, query_bound_return};
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
struct StoredPlaylistRow {
    #[serde(deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string")]
    id: RecordId,
    name: String,
    folder: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, SurrealValue)]
struct StoredPlaylistEdgeRow {
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

async fn insert_playlist_row(id: &str, playlist: &PlayList) -> RecordId {
    let db = get_db().expect("global playlist database handle should exist");
    let mut result = db
        .query("CREATE $record CONTENT $data RETURN VALUE id;")
        .bind(("record", RecordId::new(PlayList::table_name(), id)))
        .bind((
            "data",
            json!({
                "name": playlist.name,
                "folder": playlist.folder,
            }),
        ))
        .await
        .expect("playlist insert query should succeed")
        .check()
        .expect("playlist insert response should succeed");

    let record: Option<RecordId> = result.take(0).expect("playlist insert id should decode");
    record.expect("playlist insert should return one record id")
}

async fn insert_playlist_edges(source: &RecordId, targets: &[RecordId]) {
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
        .expect("playlist edge insert query should succeed")
        .check()
        .expect("playlist edge insert response should succeed");
}

async fn load_playlist_rows_raw() -> Vec<serde_json::Value> {
    let stmt = RawSqlStmt::new("SELECT * FROM type::table($table);")
        .bind("table", Table::from(PlayList::table_name()));
    let mut result = query_bound_checked(stmt)
        .await
        .expect("playlist raw row query should succeed");

    result.take(0).expect("playlist raw rows should decode")
}

async fn load_playlist_edges(record: &RecordId) -> Vec<StoredPlaylistEdgeRow> {
    let stmt = RawSqlStmt::new(
        "SELECT in, out, position FROM $rel WHERE in = $record ORDER BY position ASC;",
    )
    .bind("rel", Table::from("includes"))
    .bind("record", record.clone());
    let mut result = query_bound_checked(stmt)
        .await
        .expect("playlist edge query should succeed");

    result.take(0).expect("playlist edge rows should decode")
}

async fn load_music_record(record: &RecordId) -> Music {
    let stmt = RawSqlStmt::new("SELECT * FROM ONLY $record;").bind("record", record.clone());

    query_bound_return::<Music>(stmt)
        .await
        .expect("music raw query should succeed")
        .expect("related music row should exist")
}

fn sample_playlist() -> PlayList {
    PlayList {
        name: "favorites".to_string(),
        folder: "/music/favorites".to_string(),
        musics: vec![
            Music {
                name: "intro".to_string(),
                url: "https://example.com/intro".to_string(),
                path: Some("/music/intro.mp3".to_string()),
                start: 5,
                end: 42,
            },
            Music {
                name: "outro".to_string(),
                url: "https://example.com/outro".to_string(),
                path: None,
                start: 100,
                end: 180,
            },
        ],
    }
}

fn assert_music_eq(actual: &Music, expected: &Music) {
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.url, expected.url);
    assert_eq!(actual.path, expected.path);
    assert_eq!(actual.start, expected.start);
    assert_eq!(actual.end, expected.end);
}

fn assert_playlist_eq(actual: &PlayList, expected: &PlayList) {
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.folder, expected.folder);
    assert_eq!(actual.musics.len(), expected.musics.len());

    for (actual_music, expected_music) in actual.musics.iter().zip(expected.musics.iter()) {
        assert_music_eq(actual_music, expected_music);
    }
}

#[test]
fn serializes_playlist_with_nested_music_entries() {
    let playlist = sample_playlist();

    let value = serde_json::to_value(&playlist).expect("playlist should serialize");

    assert_eq!(value["name"], "favorites");
    assert_eq!(value["folder"], "/music/favorites");
    assert_eq!(value["musics"][0]["name"], "intro");
    assert_eq!(value["musics"][0]["path"], "/music/intro.mp3");
    assert_eq!(value["musics"][1]["name"], "outro");
    assert_eq!(value["musics"][1]["path"], serde_json::Value::Null);
}

#[test]
fn deserializes_playlist_with_optional_music_path() {
    let value = json!({
        "name": "study",
        "folder": "/music/study",
        "musics": [
            {
                "name": "focus",
                "url": "https://example.com/focus",
                "path": null,
                "start": 0,
                "end": 90
            },
            {
                "name": "break",
                "url": "https://example.com/break",
                "path": "/music/break.mp3",
                "start": 90,
                "end": 120
            }
        ]
    });

    let playlist: PlayList =
        serde_json::from_value(value).expect("playlist json should deserialize");

    assert_eq!(playlist.name, "study");
    assert_eq!(playlist.folder, "/music/study");
    assert_eq!(playlist.musics.len(), 2);
    assert_eq!(playlist.musics[0].path, None);
    assert_eq!(playlist.musics[1].path.as_deref(), Some("/music/break.mp3"));
    assert_eq!(playlist.musics[1].start, 90);
    assert_eq!(playlist.musics[1].end, 120);
}

#[test]
fn clone_keeps_playlist_data_independent() {
    let playlist = sample_playlist();
    let mut cloned = playlist.clone();

    cloned.name = "favorites-copy".to_string();
    cloned.musics[0].name = "intro-remix".to_string();
    cloned.musics[0].path = None;

    assert_eq!(playlist.name, "favorites");
    assert_eq!(playlist.musics[0].name, "intro");
    assert_eq!(playlist.musics[0].path.as_deref(), Some("/music/intro.mp3"));

    assert_eq!(cloned.name, "favorites-copy");
    assert_eq!(cloned.musics[0].name, "intro-remix");
    assert_eq!(cloned.musics[0].path, None);
}

#[test]
fn create_fails_on_fresh_db_when_related_music_table_is_missing() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let err = sample_playlist()
            .create()
            .await
            .expect_err("playlist create should fail before the related music table exists");

        assert!(err.to_string().contains("Missing table"));
        assert!(err.to_string().contains(Music::table_name()));

        reset_db();
    });
}

#[test]
fn get_and_list_hydrate_playlist_relations_from_seeded_database_rows() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_table(Music::table_name()).await;
        bootstrap_table(PlayList::table_name()).await;

        let playlist = sample_playlist();
        let mut music_records = Vec::with_capacity(playlist.musics.len());
        for music in &playlist.musics {
            music_records.push(insert_music_row(music).await);
        }
        let playlist_record = insert_playlist_row("seeded-playlist", &playlist).await;
        insert_playlist_edges(&playlist_record, &music_records).await;

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
        assert_eq!(
            raw_root_object.get("folder"),
            Some(&serde_json::Value::String("/music/favorites".to_owned()))
        );
        assert!(
            !raw_root_object.contains_key("musics"),
            "playlist row should not inline relate-backed musics field"
        );

        let stored_root: StoredPlaylistRow =
            serde_json::from_value(raw_root).expect("playlist raw row should decode");
        let edge_rows = load_playlist_edges(&stored_root.id).await;

        assert_eq!(stored_root.name, playlist.name);
        assert_eq!(stored_root.folder, playlist.folder);
        assert_eq!(
            edge_rows
                .iter()
                .map(|edge| edge.position)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );

        let mut related_musics = Vec::with_capacity(edge_rows.len());
        for edge in &edge_rows {
            related_musics.push(load_music_record(&edge.out).await);
        }

        assert_eq!(related_musics.len(), playlist.musics.len());
        for (actual_music, expected_music) in related_musics.iter().zip(playlist.musics.iter()) {
            assert_music_eq(actual_music, expected_music);
        }

        reset_db();
    });
}

#[test]
fn save_fails_for_playlist_without_id_field() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let err = PlayList::save(sample_playlist())
            .await
            .expect_err("playlist save should fail without an id field");

        assert!(
            err.to_string()
                .contains("does not contain an `id` string or i64 field")
        );

        reset_db();
    });
}
