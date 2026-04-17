use super::PLAYLIST_DB_TEST_LOCK;
use super::add_exclude;
use super::check_list;
use super::get_playlist;
use super::list_playlists;
use super::model::{Collection, Exclude, Group, Music, PlayList};
use super::remove_exclude;
use appdb::connection::{InitDbOptions, get_db, reinit_db_with_options, reset_db};
use appdb::model::meta::ModelMeta;
use serde_json::json;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};
use surrealdb::types::RecordId;
use tokio::runtime::Runtime;

static DB_TEST_RT: LazyLock<Runtime> =
    LazyLock::new(|| Runtime::new().expect("playlist cmd test runtime should be created"));

fn test_db_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();

    std::env::temp_dir().join(format!(
        "ransic_playlist_cmd_test_{}_{}",
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
    .expect("playlist cmd database should initialize");
}

async fn bootstrap_table(table: &str) {
    let db = get_db().expect("global playlist cmd database handle should exist");

    db.query(format!("DEFINE TABLE IF NOT EXISTS {table} SCHEMALESS;"))
        .await
        .expect("table bootstrap query should succeed")
        .check()
        .expect("table bootstrap response should succeed");
}

async fn insert_playlist_row(id: &str) {
    let db = get_db().expect("global playlist cmd database handle should exist");

    db.query("CREATE $record CONTENT $data RETURN NONE;")
        .bind(("record", RecordId::new(PlayList::table_name(), id)))
        .bind((
            "data",
            json!({
                "name": "seeded",
                "folder": "/seeded",
            }),
        ))
        .await
        .expect("playlist row insert query should succeed")
        .check()
        .expect("playlist row insert response should succeed");
}

async fn insert_group_row(id: &str, group: &Group) -> RecordId {
    let db = get_db().expect("global playlist cmd database handle should exist");
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
        .expect("group row insert query should succeed")
        .check()
        .expect("group row insert response should succeed");

    let record: Option<RecordId> = result.take(0).expect("group insert id should decode");
    record.expect("group insert should return one record id")
}

async fn insert_collection_row(id: &str) {
    let db = get_db().expect("global playlist cmd database handle should exist");

    db.query("CREATE $record CONTENT $data RETURN NONE;")
        .bind(("record", RecordId::new(Collection::table_name(), id)))
        .bind((
            "data",
            json!({
                "name": "seeded-collection",
                "url": format!("https://example.com/{id}"),
                "folder": format!("youtube/{id}"),
                "last_updated": "2026-04-13T00:00:00+00:00",
                "enable_updates": false,
            }),
        ))
        .await
        .expect("collection row insert query should succeed")
        .check()
        .expect("collection row insert response should succeed");
}

async fn insert_collection_row_with_data(id: &str, collection: &Collection) -> RecordId {
    let db = get_db().expect("global playlist cmd database handle should exist");
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
        .expect("collection row insert query should succeed")
        .check()
        .expect("collection row insert response should succeed");

    let record: Option<RecordId> = result.take(0).expect("collection insert id should decode");
    record.expect("collection insert should return one record id")
}

async fn insert_playlist_with_relations(
    id: &str,
    playlist: &PlayList,
    collections: &[RecordId],
    groups: &[RecordId],
) {
    let db = get_db().expect("global playlist cmd database handle should exist");

    db.query("CREATE $record CONTENT $data RETURN NONE;")
        .bind(("record", RecordId::new(PlayList::table_name(), id)))
        .bind((
            "data",
            json!({
                "name": playlist.name,
                "collections": collections,
                "groups": groups,
            }),
        ))
        .await
        .expect("playlist row insert query should succeed")
        .check()
        .expect("playlist row insert response should succeed");
}

fn sample_music() -> Music {
    Music {
        name: "Blocked Track".to_string(),
        group: Group {
            name: "Blocked Collection".to_string(),
            url: "https://example.com/blocked-collection".to_string(),
            folder: "youtube/blocked-collection".to_string(),
        },
        url: "https://example.com/watch?v=blocked".to_string(),
        path: Some("Blocked Track.m4a".to_string()),
        start: 0,
        end: 180,
    }
}

fn sample_playlist() -> PlayList {
    PlayList {
        name: "favorites".to_string(),
        collections: vec![Collection {
            name: "Calm Set".to_string(),
            url: "https://example.com/calm-set".to_string(),
            folder: "youtube/calm-set".to_string(),
            musics: vec![],
            last_updated: "2026-04-13T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        }],
        groups: vec![Group {
            name: "Disc 1".to_string(),
            url: "https://example.com/calm-set#disc-1".to_string(),
            folder: "Disc 1".to_string(),
        }],
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
    }

    for (actual_group, expected_group) in actual.groups.iter().zip(expected.groups.iter()) {
        assert_eq!(actual_group.name, expected_group.name);
        assert_eq!(actual_group.url, expected_group.url);
        assert_eq!(actual_group.folder, expected_group.folder);
    }
}

#[test]
fn check_list_returns_false_when_collection_table_is_missing_or_empty() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        assert!(
            !check_list()
                .await
                .expect("missing playlist table should not error")
        );

        bootstrap_table(Collection::table_name()).await;

        assert!(
            !check_list()
                .await
                .expect("empty collection table should not error")
        );

        reset_db();
    });
}

#[test]
fn check_list_returns_true_when_collection_table_has_rows() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_table(Collection::table_name()).await;
        insert_collection_row("seeded-collection").await;

        assert!(
            check_list()
                .await
                .expect("seeded collection table should not error")
        );

        reset_db();
    });
}

#[test]
fn check_list_ignores_legacy_playlist_rows_without_collections() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_table(PlayList::table_name()).await;
        insert_playlist_row("legacy-playlist").await;

        assert!(
            !check_list()
                .await
                .expect("legacy playlist-only rows should not count as collections")
        );

        reset_db();
    });
}

#[test]
fn get_playlist_returns_none_when_the_name_is_missing() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let playlist = get_playlist("missing".to_string())
            .await
            .expect("missing playlist lookup should not error");

        assert!(playlist.is_none());

        reset_db();
    });
}

#[test]
fn get_playlist_hydrates_related_collections_and_groups() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_table(PlayList::table_name()).await;
        bootstrap_table(Collection::table_name()).await;
        bootstrap_table(Group::table_name()).await;

        let playlist = sample_playlist();
        let collection_record =
            insert_collection_row_with_data("favorites-collection", &playlist.collections[0]).await;
        let group_record = insert_group_row("favorites-group", &playlist.groups[0]).await;
        insert_playlist_with_relations(
            "favorites-playlist",
            &playlist,
            std::slice::from_ref(&collection_record),
            std::slice::from_ref(&group_record),
        )
        .await;

        let loaded = get_playlist(playlist.name.clone())
            .await
            .expect("seeded playlist lookup should succeed")
            .expect("seeded playlist should exist");

        assert_playlist_matches(&loaded, &playlist);

        reset_db();
    });
}

#[test]
fn list_playlists_returns_hydrated_rows() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_table(PlayList::table_name()).await;
        bootstrap_table(Collection::table_name()).await;
        bootstrap_table(Group::table_name()).await;

        let playlist = sample_playlist();
        let collection_record =
            insert_collection_row_with_data("favorites-collection", &playlist.collections[0]).await;
        let group_record = insert_group_row("favorites-group", &playlist.groups[0]).await;
        insert_playlist_with_relations(
            "favorites-playlist",
            &playlist,
            std::slice::from_ref(&collection_record),
            std::slice::from_ref(&group_record),
        )
        .await;

        let loaded = list_playlists()
            .await
            .expect("playlist listing should succeed");

        assert_eq!(loaded.len(), 1);
        assert_playlist_matches(&loaded[0], &playlist);

        reset_db();
    });
}

#[test]
fn add_exclude_is_idempotent_and_remove_exclude_deletes_the_row() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let music = sample_music();
        let first = add_exclude(music.clone())
            .await
            .expect("first exclude add should succeed");
        let second = add_exclude(music.clone())
            .await
            .expect("second exclude add should reuse the same row");
        let excludes = Exclude::list()
            .await
            .expect("exclude listing should succeed after add");

        assert_eq!(first.music.url, music.url);
        assert_eq!(second.music.url, music.url);
        assert_eq!(excludes.len(), 1);
        assert_eq!(excludes[0].music.url, music.url);

        let removed = remove_exclude(music.clone())
            .await
            .expect("exclude removal should succeed");
        let removed_again = remove_exclude(music)
            .await
            .expect("repeated exclude removal should succeed");
        let excludes_after = Exclude::list()
            .await
            .expect("exclude listing should succeed after delete");

        assert!(removed);
        assert!(!removed_again);
        assert!(excludes_after.is_empty());

        reset_db();
    });
}

#[test]
fn remove_exclude_returns_false_when_table_is_missing() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let removed = remove_exclude(sample_music())
            .await
            .expect("missing exclude table should not error");

        assert!(!removed);

        reset_db();
    });
}
