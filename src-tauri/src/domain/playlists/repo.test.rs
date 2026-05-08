use super::model::{Collection, Exclude, Group, Music, PlayList};
use super::repo::{
    add_exclude, delete_playlist_by_name, get_collection_by_url, get_playlist_by_name,
    has_collections, list_collections, list_musics_by_file_path, list_playlists, remove_exclude,
    set_collection_updates, update_music, upsert_collection, upsert_playlist, delete_music,
};
use crate::domain::playlists::PLAYLIST_DB_TEST_LOCK;
use appdb::connection::{InitDbOptions, get_db, reinit_db_with_options, reset_db};
use appdb::model::meta::ModelMeta;
use appdb::{AutoFill, Crud};
use serde_json::json;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};
use surrealdb::types::{RecordId, Table};
use surrealdb_types::SurrealValue;
use tokio::runtime::Runtime;

static DB_TEST_RT: LazyLock<Runtime> =
    LazyLock::new(|| Runtime::new().expect("playlist repo test runtime should be created"));

fn test_db_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();

    std::env::temp_dir().join(format!(
        "ransic_playlist_repo_test_{}_{}",
        std::process::id(),
        nanos
    ))
}

fn run_async<T>(fut: impl std::future::Future<Output = T>) -> T {
    DB_TEST_RT.block_on(fut)
}

fn acquire_db_test_lock() -> std::sync::MutexGuard<'static, ()> {
    PLAYLIST_DB_TEST_LOCK
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
    .expect("playlist repo database should initialize");
}

async fn bootstrap_table(table: &str) {
    let db = get_db().expect("global playlist repo database handle should exist");

    db.query(format!("DEFINE TABLE IF NOT EXISTS {table} SCHEMALESS;"))
        .await
        .expect("table bootstrap query should succeed")
        .check()
        .expect("table bootstrap response should succeed");
}

async fn bootstrap_relation_table(table: &str) {
    let db = get_db().expect("global playlist repo database handle should exist");

    db.query(format!(
        "DEFINE TABLE IF NOT EXISTS {table} TYPE RELATION SCHEMALESS;"
    ))
    .await
    .expect("relation table bootstrap query should succeed")
    .check()
    .expect("relation table bootstrap response should succeed");
}

async fn bootstrap_collection_write_schema() {
    bootstrap_table(Music::table_name()).await;
    bootstrap_relation_table("includes").await;
}

async fn bootstrap_playlist_read_schema() {
    bootstrap_table(Music::table_name()).await;
    bootstrap_relation_table("includes").await;
}

fn sample_collection(url: &str, enable_updates: Option<bool>) -> Collection {
    Collection {
        name: "Demo".to_string(),
        url: url.to_string(),
        folder: "youtube/demo".to_string(),
        musics: vec![],
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates,
    }
}

fn collection_group(name: &str, url: &str, folder: &str) -> Group {
    Group {
        name: name.to_string(),
        url: url.to_string(),
        folder: folder.to_string(),
    }
}

fn grouped_collection(url: &str) -> Collection {
    Collection {
        name: "Grouped Demo".to_string(),
        url: url.to_string(),
        folder: "youtube/grouped-demo".to_string(),
        musics: vec![Music {
            name: "Track".to_string(),
            alias: "Track".to_string(),
            group: Group {
                name: "Disc 1".to_string(),
                url: format!("{url}#disc-1"),
                folder: "Disc 1".to_string(),
            },
            url: format!("{url}#track"),
            path: Some(
                PathBuf::from("Disc 1")
                    .join("Track.m4a")
                    .to_string_lossy()
                    .to_string(),
            ),
            start_ms: 0,
            end_ms: 180_000,
        }],
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    }
}

fn collection_with_musics(
    url: &str,
    folder: &str,
    enable_updates: Option<bool>,
    musics: Vec<Music>,
) -> Collection {
    Collection {
        name: "Demo".to_string(),
        url: url.to_string(),
        folder: folder.to_string(),
        musics,
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates,
    }
}

fn shared_music(collection_url: &str, collection_folder: &str) -> Music {
    Music {
        name: "Shared Track".to_string(),
        alias: "Shared Track".to_string(),
        group: collection_group("Demo", collection_url, collection_folder),
        url: "https://example.com/watch/shared".to_string(),
        path: Some("Shared Track.m4a".to_string()),
        start_ms: 0,
        end_ms: 180_000,
    }
}

fn sample_playlist(name: &str) -> PlayList {
    PlayList {
        name: name.to_string(),
        collections: vec![Collection {
            name: "Repo Demo".to_string(),
            url: format!("https://example.com/{name}"),
            folder: format!("youtube/{name}"),
            musics: vec![],
            last_updated: "2026-04-12T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        }],
        groups: vec![Group {
            name: "Disc 1".to_string(),
            url: format!("https://example.com/{name}#disc-1"),
            folder: "Disc 1".to_string(),
        }],
        created_at: AutoFill::pending(),
    }
}

fn sample_excluded_music() -> Music {
    Music {
        name: "Blocked Track".to_string(),
        alias: "Blocked Track".to_string(),
        group: Group {
            name: "Blocked Collection".to_string(),
            url: "https://example.com/blocked-collection".to_string(),
            folder: "youtube/blocked-collection".to_string(),
        },
        url: "https://example.com/watch?v=blocked".to_string(),
        path: Some("Blocked Track.m4a".to_string()),
        start_ms: 0,
        end_ms: 180_000,
    }
}

fn assert_playlist_matches(actual: &PlayList, expected: &PlayList) {
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.collections.len(), expected.collections.len());
    assert_eq!(actual.groups.len(), expected.groups.len());

    for (actual_collection, expected_collection) in
        actual.collections.iter().zip(expected.collections.iter())
    {
        assert_eq!(actual_collection.name, expected_collection.name);
        assert_eq!(actual_collection.url, expected_collection.url);
        assert_eq!(actual_collection.folder, expected_collection.folder);
        assert_eq!(
            actual_collection.last_updated,
            expected_collection.last_updated
        );
        assert_eq!(
            actual_collection.enable_updates,
            expected_collection.enable_updates
        );
        assert!(actual_collection.musics.is_empty());
        assert!(expected_collection.musics.is_empty());
    }

    for (actual_group, expected_group) in actual.groups.iter().zip(expected.groups.iter()) {
        assert_eq!(actual_group.name, expected_group.name);
        assert_eq!(actual_group.url, expected_group.url);
        assert_eq!(actual_group.folder, expected_group.folder);
    }
}

async fn insert_collection_row(id: &str, collection: &Collection) -> RecordId {
    let db = get_db().expect("global playlist repo database handle should exist");
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
    let db = get_db().expect("global playlist repo database handle should exist");
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

async fn insert_music_row(id: &str, music: &Music) -> RecordId {
    let db = get_db().expect("global playlist repo database handle should exist");
    let mut result = db
        .query("CREATE $record CONTENT $data RETURN VALUE id;")
        .bind(("record", RecordId::new(Music::table_name(), id)))
        .bind(("data", music.clone()))
        .await
        .expect("music insert query should succeed")
        .check()
        .expect("music insert response should succeed");

    let record: Option<RecordId> = result.take(0).expect("music insert id should decode");
    record.expect("music insert should return one record id")
}

async fn insert_playlist_row(
    id: &str,
    playlist: &PlayList,
    collections: &[RecordId],
    groups: &[RecordId],
) -> RecordId {
    let db = get_db().expect("global playlist repo database handle should exist");
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

async fn insert_music_edges(source: &RecordId, targets: &[RecordId]) {
    if targets.is_empty() {
        return;
    }

    let db = get_db().expect("global playlist repo database handle should exist");
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

async fn load_collection_ids_by_url(url: &str) -> Vec<RecordId> {
    let db = get_db().expect("global playlist repo database handle should exist");
    let mut result = db
        .query("SELECT VALUE id FROM $table WHERE type::field($field) = $value LIMIT 10;")
        .bind(("table", Table::from(Collection::table_name())))
        .bind(("field", "url".to_string()))
        .bind(("value", url.to_string()))
        .await
        .expect("collection id lookup query should succeed")
        .check()
        .expect("collection id lookup response should succeed");

    result
        .take(0)
        .expect("collection id lookup rows should decode")
}

async fn load_collection_music_ids(record: &RecordId) -> Vec<RecordId> {
    let db = get_db().expect("global playlist repo database handle should exist");
    let mut result = db
        .query("SELECT out, position FROM $rel WHERE in = $record ORDER BY position ASC;")
        .bind(("rel", Table::from("includes")))
        .bind(("record", record.clone()))
        .await
        .expect("collection music edge query should succeed")
        .check()
        .expect("collection music edge response should succeed");

    #[derive(serde::Deserialize, surrealdb_types::SurrealValue)]
    struct EdgeRow {
        #[serde(
            deserialize_with = "appdb::serde_utils::id::deserialize_record_id_or_compat_string"
        )]
        out: RecordId,
    }

    let rows: Vec<EdgeRow> = result
        .take(0)
        .expect("collection music edge rows should decode");
    rows.into_iter().map(|row| row.out).collect()
}

async fn count_excludes() -> usize {
    let db = get_db().expect("global playlist repo database handle should exist");
    let mut result = db
        .query("SELECT VALUE id FROM $table LIMIT 100;")
        .bind(("table", Table::from(Exclude::table_name())))
        .await
        .expect("exclude count query should succeed")
        .check()
        .expect("exclude count response should succeed");

    let ids: Vec<RecordId> = result.take(0).expect("exclude ids should decode");
    ids.len()
}

#[test]
fn has_collections_returns_false_when_collection_table_is_missing_or_empty() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        assert!(
            !has_collections()
                .await
                .expect("missing collection table should not error")
        );

        let db = get_db().expect("global playlist repo database handle should exist");
        db.query(format!(
            "DEFINE TABLE IF NOT EXISTS {} SCHEMALESS;",
            Collection::table_name()
        ))
        .await
        .expect("collection table bootstrap query should succeed")
        .check()
        .expect("collection table bootstrap response should succeed");

        assert!(
            !has_collections()
                .await
                .expect("empty collection table should not error")
        );

        reset_db();
    });
}

#[test]
fn has_collections_returns_true_when_collection_rows_exist() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let _ = upsert_collection(&sample_collection(
            "https://example.com/seeded",
            Some(false),
        ))
        .await
        .expect("seeded collection should save");

        assert!(
            has_collections()
                .await
                .expect("seeded collection table should not error")
        );

        reset_db();
    });
}

#[test]
fn add_exclude_is_idempotent_and_remove_exclude_deletes_the_row() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_table(Music::table_name()).await;

        let music = sample_excluded_music();
        let first = add_exclude(music.clone())
            .await
            .expect("first exclude add should succeed");
        let second = add_exclude(music.clone())
            .await
            .expect("second exclude add should reuse the same row");
        let exclude_count = count_excludes().await;

        assert_eq!(first.music.url, music.url);
        assert!(!first.created_at.is_pending());
        assert_eq!(second.music.url, music.url);
        assert!(!second.created_at.is_pending());
        assert_eq!(exclude_count, 1);

        let removed = remove_exclude(&music)
            .await
            .expect("exclude removal should succeed");
        let removed_again = remove_exclude(&music)
            .await
            .expect("repeated exclude removal should succeed");
        let exclude_count_after = count_excludes().await;

        assert!(removed);
        assert!(!removed_again);
        assert_eq!(exclude_count_after, 0);

        reset_db();
    });
}

#[test]
fn remove_exclude_returns_false_when_table_is_missing() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let removed = remove_exclude(&sample_excluded_music())
            .await
            .expect("missing exclude table should not error");

        assert!(!removed);

        reset_db();
    });
}

#[test]
fn set_collection_updates_keeps_single_collections_at_none() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let collection = upsert_collection(&sample_collection("https://example.com/video", None))
            .await
            .expect("single collection should save");

        let updated = set_collection_updates(&collection.url, true)
            .await
            .expect("single collection update request should succeed")
            .expect("single collection should exist");
        let reloaded = get_collection_by_url(&collection.url)
            .await
            .expect("single collection should reload")
            .expect("single collection should exist after reload");

        assert_eq!(updated.enable_updates, None);
        assert_eq!(reloaded.enable_updates, None);

        reset_db();
    });
}

#[test]
fn set_collection_updates_toggles_list_collections() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let collection = upsert_collection(&sample_collection(
            "https://example.com/playlist",
            Some(false),
        ))
        .await
        .expect("list collection should save");

        let updated = set_collection_updates(&collection.url, true)
            .await
            .expect("list collection update request should succeed")
            .expect("list collection should exist");
        let reloaded = get_collection_by_url(&collection.url)
            .await
            .expect("list collection should reload")
            .expect("list collection should exist after reload");

        assert_eq!(updated.enable_updates, Some(true));
        assert_eq!(reloaded.enable_updates, Some(true));

        reset_db();
    });
}

#[test]
fn list_collections_returns_hydrated_music_rows() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let saved = upsert_collection(&grouped_collection("https://example.com/listed"))
            .await
            .expect("grouped collection should save");

        let listed = list_collections()
            .await
            .expect("collection listing should succeed");
        let loaded = listed
            .iter()
            .find(|collection| collection.url == saved.url)
            .expect("saved collection should appear in listing");

        assert_eq!(loaded.musics.len(), 1);
        assert_eq!(loaded.musics[0].name, "Track");
        assert_eq!(loaded.musics[0].alias, "Track");
        assert_eq!(loaded.musics[0].path.as_deref(), Some("Disc 1\\Track.m4a"));

        reset_db();
    });
}

#[test]
fn upsert_collection_bootstraps_collection_graph_schema_on_clean_db() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let url = "https://example.com/self-bootstrapped-single";
        let collection = collection_with_musics(
            url,
            "youtube/self-bootstrapped-single",
            None,
            vec![Music {
                name: "Minus Sixty One".to_string(),
                alias: "Minus Sixty One".to_string(),
                group: collection_group("Minus Sixty One", url, "youtube/self-bootstrapped-single"),
                url: url.to_string(),
                path: Some("Minus Sixty One.m4a".to_string()),
                start_ms: 0,
                end_ms: 316_000,
            }],
        );

        let saved = upsert_collection(&collection)
            .await
            .expect("collection upsert should bootstrap graph schema on demand");
        let reloaded = get_collection_by_url(url)
            .await
            .expect("self-bootstrapped collection should reload")
            .expect("self-bootstrapped collection should exist");
        let listed = list_collections()
            .await
            .expect("self-bootstrapped collection listing should succeed");

        assert_eq!(saved.musics.len(), 1);
        assert_eq!(reloaded.musics.len(), 1);
        assert_eq!(reloaded.musics[0].name, "Minus Sixty One");
        assert_eq!(reloaded.musics[0].alias, "Minus Sixty One");
        assert_eq!(
            reloaded.musics[0].path.as_deref(),
            Some("Minus Sixty One.m4a")
        );
        assert!(
            listed
                .iter()
                .any(|candidate| candidate.url == url && candidate.musics.len() == 1)
        );

        reset_db();
    });
}

#[test]
fn upsert_collection_round_trips_grouped_music() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let collection = upsert_collection(&grouped_collection("https://example.com/grouped"))
            .await
            .expect("grouped collection should save");
        let reloaded = get_collection_by_url(&collection.url)
            .await
            .expect("grouped collection should reload")
            .expect("grouped collection should exist");

        assert_eq!(reloaded.musics.len(), 1);
        let music = &reloaded.musics[0];
        assert_eq!(music.name, "Track");
        assert_eq!(music.alias, "Track");
        let group = &music.group;
        assert_eq!(group.name, "Disc 1");
        assert_eq!(group.url, "https://example.com/grouped#disc-1");
        assert_eq!(group.folder, "Disc 1");

        reset_db();
    });
}

#[test]
fn update_music_changes_display_alias_and_range_from_original_identity() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let collection = upsert_collection(&grouped_collection("https://example.com/music-edit"))
            .await
            .expect("grouped collection should save before music update");
        let updated = update_music(
            &format!("{}#track", collection.url),
            0,
            180_000,
            "Track Edit",
            12_250,
            132_750,
        )
        .await
        .expect("music update should succeed")
        .expect("music update target should exist");
        let reloaded = get_collection_by_url(&collection.url)
            .await
            .expect("updated collection should reload")
            .expect("updated collection should exist");

        assert_eq!(updated.name, "Track");
        assert_eq!(updated.alias, "Track Edit");
        assert_eq!(updated.start_ms, 12_250);
        assert_eq!(updated.end_ms, 132_750);
        assert_eq!(reloaded.musics[0].name, "Track");
        assert_eq!(reloaded.musics[0].alias, "Track Edit");
        assert_eq!(reloaded.musics[0].start_ms, 12_250);
        assert_eq!(reloaded.musics[0].end_ms, 132_750);

        reset_db();
    });
}

#[test]
fn delete_music_removes_only_the_matching_music_identity() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let save_root = PathBuf::from("C:/Media");
        let shared_path = PathBuf::from("Disc 1").join("Shared.m4a");
        let collection = collection_with_musics(
            "https://example.com/music-delete",
            "youtube/music-delete",
            Some(false),
            vec![
                Music {
                    name: "Track A".to_string(),
                    alias: "Track A".to_string(),
                    group: collection_group(
                        "Disc 1",
                        "https://example.com/music-delete#disc-1",
                        "Disc 1",
                    ),
                    url: "https://example.com/music-delete#a".to_string(),
                    path: Some(shared_path.to_string_lossy().to_string()),
                    start_ms: 0,
                    end_ms: 120_000,
                },
                Music {
                    name: "Track B".to_string(),
                    alias: "Track B".to_string(),
                    group: collection_group(
                        "Disc 1",
                        "https://example.com/music-delete#disc-1",
                        "Disc 1",
                    ),
                    url: "https://example.com/music-delete#b".to_string(),
                    path: Some(shared_path.to_string_lossy().to_string()),
                    start_ms: 120_000,
                    end_ms: 240_000,
                },
            ],
        );
        let saved = upsert_collection(&collection)
            .await
            .expect("collection should save before music deletion");
        let collection_record = load_collection_ids_by_url(&saved.url)
            .await
            .remove(0);

        assert!(
            delete_music("https://example.com/music-delete#a", 0, 120_000)
                .await
                .expect("music deletion should succeed")
        );
        assert!(
            !delete_music("https://example.com/music-delete#a", 0, 120_000)
                .await
                .expect("repeated music deletion should be idempotent")
        );

        let lookup_path = save_root.join(&collection.folder).join(shared_path);
        let musics = list_musics_by_file_path(&lookup_path, &save_root)
            .await
            .expect("music lookup by file path should succeed after deletion");

        assert_eq!(musics.len(), 1);
        assert_eq!(musics[0].alias, "Track B");
        assert_eq!(load_collection_music_ids(&collection_record).await.len(), 1);

        reset_db();
    });
}

#[test]
fn list_musics_by_file_path_reads_matching_database_music_records() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let save_root = PathBuf::from("C:/Media");
        let shared_path = PathBuf::from("Disc 1").join("Shared.m4a");
        let collection = collection_with_musics(
            "https://example.com/spectrum-source",
            "youtube/spectrum-source",
            Some(false),
            vec![
                Music {
                    name: "Track A".to_string(),
                    alias: "Track A".to_string(),
                    group: collection_group(
                        "Disc 1",
                        "https://example.com/spectrum-source#disc-1",
                        "Disc 1",
                    ),
                    url: "https://example.com/spectrum-source#a".to_string(),
                    path: Some(shared_path.to_string_lossy().to_string()),
                    start_ms: 0,
                    end_ms: 120_000,
                },
                Music {
                    name: "Track B".to_string(),
                    alias: "Track B".to_string(),
                    group: collection_group(
                        "Disc 1",
                        "https://example.com/spectrum-source#disc-1",
                        "Disc 1",
                    ),
                    url: "https://example.com/spectrum-source#b".to_string(),
                    path: Some(shared_path.to_string_lossy().to_string()),
                    start_ms: 120_000,
                    end_ms: 240_000,
                },
                Music {
                    name: "Other".to_string(),
                    alias: "Other".to_string(),
                    group: collection_group(
                        "Disc 1",
                        "https://example.com/spectrum-source#disc-1",
                        "Disc 1",
                    ),
                    url: "https://example.com/spectrum-source#other".to_string(),
                    path: Some("Disc 1/Other.m4a".to_string()),
                    start_ms: 0,
                    end_ms: 60_000,
                },
            ],
        );
        let _ = upsert_collection(&collection)
            .await
            .expect("collection should save before file music lookup");

        let lookup_path = save_root.join(&collection.folder).join(shared_path);
        let musics = list_musics_by_file_path(&lookup_path, &save_root)
            .await
            .expect("music lookup by file path should succeed");

        assert_eq!(musics.len(), 2);
        assert_eq!(musics[0].alias, "Track A");
        assert_eq!(musics[1].alias, "Track B");

        reset_db();
    });
}

#[test]
fn get_collection_by_url_reads_legacy_record_ids_via_url_lookup() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let url = "https://example.com/legacy";
        let legacy_record =
            insert_collection_row("legacy-collection", &sample_collection(url, Some(false))).await;

        let loaded = get_collection_by_url(url)
            .await
            .expect("legacy collection lookup should succeed")
            .expect("legacy collection should exist");

        assert_eq!(loaded.url, url);
        assert_eq!(load_collection_ids_by_url(url).await, vec![legacy_record]);

        reset_db();
    });
}

#[test]
fn collection_unique_index_rejects_duplicate_urls_before_lookup_becomes_ambiguous() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let url = "https://example.com/ambiguous";
        let collection = sample_collection(url, Some(false));
        insert_collection_row("ambiguous-a", &collection).await;

        let db = get_db().expect("global playlist repo database handle should exist");
        let duplicate_error = db
            .query("CREATE $record CONTENT $data RETURN NONE;")
            .bind((
                "record",
                RecordId::new(Collection::table_name(), "ambiguous-b"),
            ))
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
            .expect("duplicate insert should return a response")
            .check()
            .expect_err("duplicate collection insert should fail");
        let loaded = get_collection_by_url(url)
            .await
            .expect("unique lookup should still succeed")
            .expect("unique collection should still exist");

        assert!(
            duplicate_error.to_string().contains("already contains"),
            "{duplicate_error}"
        );
        assert_eq!(loaded.url, url);

        reset_db();
    });
}

#[test]
fn upsert_collection_reuses_existing_legacy_record_id_and_removes_old_music() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let url = "https://example.com/legacy-grouped";
        let legacy_collection = sample_collection(url, Some(false));
        let legacy_record = insert_collection_row("legacy-grouped", &legacy_collection).await;
        let stale_music = Music {
            name: "Stale Track".to_string(),
            alias: "Stale Track".to_string(),
            group: collection_group("Demo", url, "youtube/demo"),
            url: format!("{url}#stale"),
            path: Some("Stale Track.m4a".to_string()),
            start_ms: 0,
            end_ms: 90_000,
        };
        let stale_music_record = insert_music_row("legacy-stale-music", &stale_music).await;
        insert_music_edges(&legacy_record, std::slice::from_ref(&stale_music_record)).await;

        let saved = upsert_collection(&grouped_collection(url))
            .await
            .expect("grouped collection upsert should succeed");
        let reloaded = get_collection_by_url(url)
            .await
            .expect("grouped collection should reload")
            .expect("grouped collection should exist");

        assert_eq!(saved.url, url);
        assert_eq!(
            load_collection_ids_by_url(url).await,
            vec![legacy_record.clone()]
        );
        assert_eq!(load_collection_music_ids(&legacy_record).await.len(), 1);
        assert!(
            Music::get_record(stale_music_record).await.is_err(),
            "stale music with no remaining parents should be deleted"
        );
        assert_eq!(reloaded.musics.len(), 1);

        reset_db();
    });
}

#[test]
fn upsert_collection_reuses_music_records_via_fallback_lookup_without_explicit_ids() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let url = "https://example.com/fallback-music";
        let collection = grouped_collection(url);
        let first = upsert_collection(&collection)
            .await
            .expect("first grouped collection upsert should succeed");
        let first_collection_ids = load_collection_ids_by_url(url).await;
        let first_music_ids = load_collection_music_ids(&first_collection_ids[0]).await;

        let second = upsert_collection(&collection)
            .await
            .expect("second grouped collection upsert should succeed");
        let second_music_ids = load_collection_music_ids(&first_collection_ids[0]).await;

        assert_eq!(first.url, second.url);
        assert_eq!(first_music_ids, second_music_ids);
        assert_eq!(second_music_ids.len(), 1);

        reset_db();
    });
}

#[test]
fn upsert_collection_keeps_shared_music_until_all_collection_edges_are_gone() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let first = collection_with_musics(
            "https://example.com/collection-a",
            "youtube/a",
            Some(false),
            vec![shared_music(
                "https://example.com/collection-a",
                "youtube/a",
            )],
        );
        let second = collection_with_musics(
            "https://example.com/collection-b",
            "youtube/b",
            Some(false),
            vec![shared_music(
                "https://example.com/collection-b",
                "youtube/b",
            )],
        );

        let _ = upsert_collection(&first)
            .await
            .expect("first collection upsert should succeed");
        let _ = upsert_collection(&second)
            .await
            .expect("second collection upsert should succeed");

        let mut first_records = load_collection_ids_by_url(&first.url).await;
        let mut second_records = load_collection_ids_by_url(&second.url).await;
        let first_record = first_records.remove(0);
        let second_record = second_records.remove(0);
        let first_music_ids = load_collection_music_ids(&first_record).await;
        let second_music_ids = load_collection_music_ids(&second_record).await;
        assert_eq!(
            first_music_ids, second_music_ids,
            "shared music urls should resolve to the same persisted music record"
        );
        let first_music_record = first_music_ids[0].clone();
        let second_music_record = second_music_ids[0].clone();

        let _ = upsert_collection(&collection_with_musics(
            &first.url,
            &first.folder,
            first.enable_updates,
            vec![],
        ))
        .await
        .expect("removing one collection edge should succeed");

        assert!(
            Music::get_record(first_music_record.clone()).await.is_ok(),
            "shared music should stay alive while another collection still includes it"
        );
        assert_eq!(
            load_collection_music_ids(&second_record).await,
            vec![second_music_record.clone()]
        );
        assert!(
            Music::get_record(second_music_record.clone()).await.is_ok(),
            "other collection music should stay alive"
        );

        let _ = upsert_collection(&collection_with_musics(
            &second.url,
            &second.folder,
            second.enable_updates,
            vec![],
        ))
        .await
        .expect("removing the last collection edge should succeed");

        assert!(
            Music::get_record(second_music_record).await.is_err(),
            "music should be deleted after its collection loses the final edge"
        );

        reset_db();
    });
}

#[test]
fn upsert_collection_never_deletes_non_music_records_from_corrupted_include_edges() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let root_url = "https://example.com/root";
        let foreign_url = "https://example.com/foreign";
        let root_record =
            insert_collection_row("legacy-root", &sample_collection(root_url, Some(false))).await;
        let foreign_record = insert_collection_row(
            "foreign-collection",
            &sample_collection(foreign_url, Some(false)),
        )
        .await;
        insert_music_edges(&root_record, std::slice::from_ref(&foreign_record)).await;

        let _ = upsert_collection(&sample_collection(root_url, Some(false)))
            .await
            .expect("collection upsert should ignore corrupted non-music edges");

        let foreign = get_collection_by_url(foreign_url)
            .await
            .expect("foreign collection lookup should succeed");
        assert!(
            foreign.is_some(),
            "orphan cleanup must never delete records outside the music table"
        );
        assert_eq!(
            load_collection_ids_by_url(foreign_url).await,
            vec![foreign_record]
        );

        reset_db();
    });
}

#[test]
fn get_playlist_by_name_reads_related_collections_and_groups() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let playlist = sample_playlist("repo-playlist");
        let collection_record =
            insert_collection_row("repo-playlist-collection", &playlist.collections[0]).await;
        let group_record = insert_group_row("repo-playlist-group", &playlist.groups[0]).await;
        insert_playlist_row(
            "repo-playlist",
            &playlist,
            std::slice::from_ref(&collection_record),
            std::slice::from_ref(&group_record),
        )
        .await;

        let loaded = get_playlist_by_name(&playlist.name)
            .await
            .expect("playlist lookup should succeed")
            .expect("playlist should exist");

        assert_playlist_matches(&loaded, &playlist);

        reset_db();
    });
}

#[test]
fn list_playlists_reads_hydrated_rows() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let first = sample_playlist("repo-playlist-a");
        let first_collection =
            insert_collection_row("repo-playlist-a-collection", &first.collections[0]).await;
        let first_group = insert_group_row("repo-playlist-a-group", &first.groups[0]).await;
        insert_playlist_row(
            "repo-playlist-a",
            &first,
            std::slice::from_ref(&first_collection),
            std::slice::from_ref(&first_group),
        )
        .await;

        let second = sample_playlist("repo-playlist-b");
        let second_collection =
            insert_collection_row("repo-playlist-b-collection", &second.collections[0]).await;
        let second_group = insert_group_row("repo-playlist-b-group", &second.groups[0]).await;
        insert_playlist_row(
            "repo-playlist-b",
            &second,
            std::slice::from_ref(&second_collection),
            std::slice::from_ref(&second_group),
        )
        .await;

        let loaded = list_playlists()
            .await
            .expect("playlist listing should succeed");

        assert_eq!(loaded.len(), 2);
        let first_loaded = loaded
            .iter()
            .find(|playlist| playlist.name == first.name)
            .expect("first playlist should be listed");
        let second_loaded = loaded
            .iter()
            .find(|playlist| playlist.name == second.name)
            .expect("second playlist should be listed");

        assert_playlist_matches(first_loaded, &first);
        assert_playlist_matches(second_loaded, &second);

        reset_db();
    });
}

#[test]
fn upsert_playlist_creates_new_rows_and_updates_existing_renames() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let original = sample_playlist("Original");
        let created = upsert_playlist(&original, None)
            .await
            .expect("playlist create should succeed");
        let loaded_created = get_playlist_by_name("Original")
            .await
            .expect("created playlist should load")
            .expect("created playlist should exist");

        assert_playlist_matches(&created, &original);
        assert_playlist_matches(&loaded_created, &original);

        let renamed = PlayList {
            name: "Renamed".to_string(),
            ..original.clone()
        };
        let updated = upsert_playlist(&renamed, Some("Original"))
            .await
            .expect("playlist update should succeed");
        let loaded_updated = get_playlist_by_name("Renamed")
            .await
            .expect("renamed playlist should load")
            .expect("renamed playlist should exist");
        let missing_original = get_playlist_by_name("Original")
            .await
            .expect("original lookup should succeed");
        let listed = list_playlists()
            .await
            .expect("playlist listing should succeed after rename");

        assert_playlist_matches(&updated, &renamed);
        assert_playlist_matches(&loaded_updated, &renamed);
        assert!(missing_original.is_none());
        assert_eq!(listed.len(), 1);
        assert_playlist_matches(&listed[0], &renamed);

        reset_db();
    });
}

#[test]
fn upsert_playlist_does_not_clobber_existing_collection_graph_data() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let collection_url = "https://example.com/library-album";
        let collection_folder = "youtube/library-album";
        let populated_collection = collection_with_musics(
            collection_url,
            collection_folder,
            Some(false),
            vec![shared_music(collection_url, collection_folder)],
        );
        upsert_collection(&populated_collection)
            .await
            .expect("library collection should persist before playlist save");

        let playlist = PlayList {
            name: "Reference Only".to_string(),
            collections: vec![Collection {
                musics: vec![],
                ..sample_collection(collection_url, Some(false))
            }],
            groups: vec![],
            created_at: AutoFill::pending(),
        };

        upsert_playlist(&playlist, None)
            .await
            .expect("playlist save should succeed");

        let persisted_collection = get_collection_by_url(collection_url)
            .await
            .expect("library collection reload should succeed")
            .expect("library collection should still exist");
        let persisted_playlist = get_playlist_by_name(&playlist.name)
            .await
            .expect("saved playlist should load")
            .expect("saved playlist should exist");

        assert_eq!(persisted_collection.url, populated_collection.url);
        assert_eq!(persisted_collection.musics.len(), 1);
        assert_eq!(
            persisted_collection.musics[0].url,
            populated_collection.musics[0].url
        );
        assert_eq!(
            persisted_playlist.collections[0].url,
            populated_collection.url
        );
        assert_eq!(persisted_playlist.collections[0].musics.len(), 1);
        assert_eq!(
            persisted_playlist.collections[0].musics[0].url,
            populated_collection.musics[0].url
        );

        reset_db();
    });
}

#[test]
fn delete_playlist_by_name_removes_only_the_playlist_row() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let playlist = sample_playlist("Delete Me");
        let created = upsert_playlist(&playlist, None)
            .await
            .expect("playlist create should succeed before deletion");
        let deleted = delete_playlist_by_name(&created.name)
            .await
            .expect("playlist delete should succeed");
        let missing = get_playlist_by_name(&created.name)
            .await
            .expect("deleted playlist lookup should succeed");
        let collections = list_collections()
            .await
            .expect("collections should still list");

        assert!(deleted);
        assert!(missing.is_none());
        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].url, playlist.collections[0].url);

        reset_db();
    });
}
