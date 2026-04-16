use super::model::{Collection, Group, Music};
use super::repo::{get_collection_by_url, set_collection_updates, upsert_collection};
use crate::domain::playlists::PLAYLIST_DB_TEST_LOCK;
use appdb::Crud;
use appdb::connection::{InitDbOptions, get_db, reinit_db_with_options, reset_db};
use appdb::model::meta::ModelMeta;
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
            start: 0,
            end: 180,
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
        group: collection_group("Demo", collection_url, collection_folder),
        url: "https://example.com/watch/shared".to_string(),
        path: Some("Shared Track.m4a".to_string()),
        start: 0,
        end: 180,
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
        .query("SELECT out FROM $rel WHERE in = $record ORDER BY position ASC;")
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
fn upsert_collection_round_trips_grouped_music() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

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
        let group = &music.group;
        assert_eq!(group.name, "Disc 1");
        assert_eq!(group.url, "https://example.com/grouped#disc-1");
        assert_eq!(group.folder, "Disc 1");

        reset_db();
    });
}

#[test]
fn get_collection_by_url_reads_legacy_record_ids_via_url_lookup() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

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
fn get_collection_by_url_errors_when_url_matches_multiple_records() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let url = "https://example.com/ambiguous";
        let collection = sample_collection(url, Some(false));
        insert_collection_row("ambiguous-a", &collection).await;
        insert_collection_row("ambiguous-b", &collection).await;

        let error = get_collection_by_url(url)
            .await
            .expect_err("ambiguous url lookup should fail");
        assert!(error.to_string().contains("multiple records"), "{error}");

        reset_db();
    });
}

#[test]
fn upsert_collection_reuses_existing_legacy_record_id_and_removes_old_music() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let url = "https://example.com/legacy-grouped";
        let legacy_collection = sample_collection(url, Some(false));
        let legacy_record = insert_collection_row("legacy-grouped", &legacy_collection).await;
        let stale_music = Music {
            name: "Stale Track".to_string(),
            group: collection_group("Demo", url, "youtube/demo"),
            url: format!("{url}#stale"),
            path: Some("Stale Track.m4a".to_string()),
            start: 0,
            end: 90,
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
fn upsert_collection_deletes_music_only_after_all_collection_edges_are_gone() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

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
        assert_ne!(
            first_music_ids, second_music_ids,
            "collection-backed root groups should keep music records collection-scoped"
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
            Music::get_record(first_music_record.clone()).await.is_err(),
            "collection-scoped music should be deleted after its collection edge is removed"
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
