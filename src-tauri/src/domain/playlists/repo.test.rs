use super::model::{
    Collection, CollectionGroupOwner, CollectionSurfaceView, Exclude, Group, GroupSurfaceView,
    Music, PlayList, PlayListConfigView, PlayListListView, PlayListWriteRequest,
    canonical_music_id_for_source,
};
use super::repo::{
    PlaylistPlaybackCollectionRef, PlaylistPlaybackGroupRef, PlaylistPlaybackSelection,
    PlaylistPlaybackTrackSource, SpectrumMusicSourceIdentity, add_exclude,
    claim_generated_playlist_name, create_music, delete_music, delete_playlist_by_name,
    get_collection_by_url, get_playlist_by_name, get_playlist_config_by_name,
    get_playlist_playback_selection_by_name, has_collections, list_collections,
    list_config_library, list_musics_by_file_path, list_playlists,
    load_audio_style_training_musics, load_liked_playlist_playback_track_sources,
    load_playlist_playback_track_sources, load_random_playlist_playback_track_sources,
    load_spectrum_music_context, playlist_playback_owner_attempt_order, push_extra, remove_exclude,
    remove_extra, set_collection_updates, set_music_liked_by_identity, update_music,
    upsert_collection, upsert_playlist, upsert_playlist_surface,
};
use crate::domain::playlists::PLAYLIST_DB_TEST_LOCK;
use appdb::connection::{InitDbOptions, get_db, reinit_db_with_options, reset_db};
use appdb::model::meta::{ModelMeta, ResolveRecordId};
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
        "slisic_playlist_repo_test_{}_{}",
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
    bootstrap_relation_table("include").await;
}

async fn bootstrap_playlist_read_schema() {
    bootstrap_table(Music::table_name()).await;
    bootstrap_relation_table("includes").await;
    bootstrap_relation_table("include").await;
    bootstrap_relation_table("grouped").await;
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

fn collection_owner(name: &str, url: &str, folder: &str) -> CollectionGroupOwner {
    CollectionGroupOwner {
        name: name.to_string(),
        url: url.to_string(),
        folder: folder.to_string(),
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    }
}

fn collection_group(name: &str, url: &str, folder: &str) -> Group {
    let collection_url = url.split_once('#').map(|(base, _)| base).unwrap_or(url);

    Group {
        name: name.to_string(),
        url: url.to_string(),
        collection: collection_owner("Test Collection", collection_url, "youtube/test"),
        folder: folder.to_string(),
    }
}

fn music_canonical_id(url: &str, start_ms: u32, end_ms: u32) -> String {
    canonical_music_id_for_source(url, start_ms, end_ms)
}

fn grouped_collection(url: &str) -> Collection {
    let owner = collection_owner("Grouped Demo", url, "youtube/grouped-demo");

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
                collection: owner,
                folder: "Disc 1".to_string(),
            },
            canonical_music_id: music_canonical_id(&format!("{url}#track"), 0, 180_000),
            url: format!("{url}#track"),
            path: Some(
                PathBuf::from("Disc 1")
                    .join("Track.m4a")
                    .to_string_lossy()
                    .to_string(),
            ),
            start_ms: 0,
            end_ms: 180_000,
            liked: false,
            loudness: 0.0,
        }],
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    }
}

fn named_music(name: &str, group: Group, path: &str) -> Music {
    let url = format!("https://example.com/watch/{name}");
    Music {
        name: name.to_string(),
        alias: name.to_string(),
        group,
        canonical_music_id: music_canonical_id(&url, 0, 180_000),
        url,
        path: Some(path.to_string()),
        start_ms: 0,
        end_ms: 180_000,
        liked: false,
        loudness: 0.0,
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
    let url = "https://example.com/watch/shared";
    Music {
        name: "Shared Track".to_string(),
        alias: "Shared Track".to_string(),
        group: collection_group("Demo", collection_url, collection_folder),
        canonical_music_id: music_canonical_id(url, 0, 180_000),
        url: url.to_string(),
        path: Some("Shared Track.m4a".to_string()),
        start_ms: 0,
        end_ms: 180_000,
        liked: false,
        loudness: 0.0,
    }
}

fn sample_playlist(name: &str) -> PlayList {
    let collection_url = format!("https://example.com/{name}");
    let owner = collection_owner("Repo Demo", &collection_url, &format!("youtube/{name}"));
    PlayList {
        name: name.to_string(),
        collections: vec![Collection {
            name: "Repo Demo".to_string(),
            url: collection_url.clone(),
            folder: format!("youtube/{name}"),
            musics: vec![Music {
                name: "Track".to_string(),
                alias: "Track".to_string(),
                group: Group {
                    name: "Disc 1".to_string(),
                    url: format!("{collection_url}#disc-1"),
                    collection: owner.clone(),
                    folder: "Disc 1".to_string(),
                },
                canonical_music_id: music_canonical_id(
                    &format!("{collection_url}#track"),
                    0,
                    180_000,
                ),
                url: format!("{collection_url}#track"),
                path: Some("Disc 1/Track.m4a".to_string()),
                start_ms: 0,
                end_ms: 180_000,
                liked: false,
                loudness: 0.0,
            }],
            last_updated: "2026-04-12T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        }],
        groups: vec![Group {
            name: "Disc 1".to_string(),
            url: format!("https://example.com/{name}#disc-1"),
            collection: owner,
            folder: "Disc 1".to_string(),
        }],
        extra: vec![],

        created_at: AutoFill::resolved(format!("2026-04-12T00:00:00.{:09}Z", 0)),
    }
}

fn sample_excluded_music() -> Music {
    let url = "https://example.com/watch?v=blocked";
    Music {
        name: "Blocked Track".to_string(),
        alias: "Blocked Track".to_string(),
        group: Group {
            name: "Blocked Collection".to_string(),
            url: "https://example.com/blocked-collection".to_string(),
            collection: collection_owner(
                "Blocked Collection",
                "https://example.com/blocked-collection",
                "youtube/blocked-collection",
            ),
            folder: "youtube/blocked-collection".to_string(),
        },
        canonical_music_id: music_canonical_id(url, 0, 180_000),
        url: url.to_string(),
        path: Some("Blocked Track.m4a".to_string()),
        start_ms: 0,
        end_ms: 180_000,
        liked: false,
        loudness: 0.0,
    }
}

fn assert_playlist_matches(actual: &PlayList, expected: &PlayList) {
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.collections.len(), expected.collections.len());
    assert_eq!(actual.groups.len(), expected.groups.len());
    assert_eq!(actual.extra.len(), expected.extra.len());

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
        assert_eq!(
            actual_collection.musics.len(),
            expected_collection.musics.len()
        );
        for (actual_music, expected_music) in actual_collection
            .musics
            .iter()
            .zip(expected_collection.musics.iter())
        {
            assert_eq!(actual_music.name, expected_music.name);
            assert_eq!(actual_music.alias, expected_music.alias);
            assert_eq!(actual_music.url, expected_music.url);
            assert_eq!(actual_music.path, expected_music.path);
            assert_eq!(actual_music.start_ms, expected_music.start_ms);
            assert_eq!(actual_music.end_ms, expected_music.end_ms);
            assert_eq!(actual_music.group.name, expected_music.group.name);
            assert_eq!(actual_music.group.url, expected_music.group.url);
            assert_eq!(actual_music.group.folder, expected_music.group.folder);
        }
    }

    for (actual_group, expected_group) in actual.groups.iter().zip(expected.groups.iter()) {
        assert_eq!(actual_group.name, expected_group.name);
        assert_eq!(actual_group.url, expected_group.url);
        assert_eq!(actual_group.folder, expected_group.folder);
    }

    for (actual_extra, expected_extra) in actual.extra.iter().zip(expected.extra.iter()) {
        assert_eq!(actual_extra.name, expected_extra.name);
        assert_eq!(actual_extra.alias, expected_extra.alias);
        assert_eq!(
            actual_extra.canonical_music_id,
            expected_extra.canonical_music_id
        );
        assert_eq!(actual_extra.url, expected_extra.url);
        assert_eq!(actual_extra.path, expected_extra.path);
        assert_eq!(actual_extra.start_ms, expected_extra.start_ms);
        assert_eq!(actual_extra.end_ms, expected_extra.end_ms);
        assert_eq!(actual_extra.group.name, expected_extra.group.name);
        assert_eq!(actual_extra.group.url, expected_extra.group.url);
        assert_eq!(actual_extra.group.folder, expected_extra.group.folder);
    }
}

fn assert_playlist_list_view_matches(actual: &PlayListListView, expected: &PlayList) {
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.created_at, expected.created_at);
}

fn assert_collection_surface_matches(actual: &CollectionSurfaceView, expected: &Collection) {
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.url, expected.url);
    assert_eq!(actual.folder, expected.folder);
    assert_eq!(actual.last_updated, expected.last_updated);
    assert_eq!(actual.enable_updates, expected.enable_updates);
}

fn assert_group_surface_matches(actual: &GroupSurfaceView, expected: &Group) {
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.url, expected.url);
    assert_eq!(actual.folder, expected.folder);
}

fn assert_playlist_config_view_matches(actual: &PlayListConfigView, expected: &PlayList) {
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.collections.len(), expected.collections.len());
    assert_eq!(actual.groups.len(), expected.groups.len());
    assert_eq!(actual.extra.len(), expected.extra.len());
    assert_eq!(actual.created_at, expected.created_at);

    for (actual_collection, expected_collection) in
        actual.collections.iter().zip(expected.collections.iter())
    {
        assert_collection_surface_matches(actual_collection, expected_collection);
    }

    for (actual_group, expected_group) in actual.groups.iter().zip(expected.groups.iter()) {
        assert_group_surface_matches(actual_group, expected_group);
    }

    for (actual_extra, expected_extra) in actual.extra.iter().zip(expected.extra.iter()) {
        assert_eq!(
            actual_extra.canonical_music_id,
            expected_extra.canonical_music_id
        );
        assert_eq!(actual_extra.url, expected_extra.url);
        assert_eq!(actual_extra.path, expected_extra.path);
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
                "collection": group.collection,
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

async fn insert_collection_group_edge(collection: &RecordId, group: &RecordId) {
    let db = get_db().expect("global playlist repo database handle should exist");

    db.query(
        "INSERT RELATION INTO $rel { in: $collection, out: $group, position: 0 } RETURN NONE;",
    )
    .bind(("rel", Table::from("include")))
    .bind(("collection", collection.clone()))
    .bind(("group", group.clone()))
    .await
    .expect("collection group edge insert query should succeed")
    .check()
    .expect("collection group edge insert response should succeed");
}

async fn insert_raw_include_edge(source: &RecordId, target: &RecordId) {
    let db = get_db().expect("global playlist repo database handle should exist");

    db.query("INSERT RELATION INTO $rel { in: $source, out: $target, position: 0 } RETURN NONE;")
        .bind(("rel", Table::from("include")))
        .bind(("source", source.clone()))
        .bind(("target", target.clone()))
        .await
        .expect("raw include edge insert query should succeed")
        .check()
        .expect("raw include edge insert response should succeed");
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
    extra: &[RecordId],
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
                "extra": extra,
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

async fn insert_group_edges(source: &RecordId, targets: &[RecordId]) {
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
        bootstrap_collection_write_schema().await;

        let music = sample_excluded_music();
        upsert_collection(&collection_with_musics(
            &music.group.collection.url,
            &music.group.collection.folder,
            Some(false),
            vec![music.clone()],
        ))
        .await
        .expect("exclude identity collection should exist before exclude writes");
        let first = add_exclude(music.clone())
            .await
            .expect("first exclude add should succeed");
        let second = add_exclude(music.clone())
            .await
            .expect("second exclude add should reuse the same row");
        let exclude_count = count_excludes().await;

        assert_eq!(first.exclude.music.url, music.url);
        assert!(!first.exclude.created_at.is_pending());
        assert_eq!(second.exclude.music.url, music.url);
        assert!(!second.exclude.created_at.is_pending());
        assert_eq!(exclude_count, 1);

        let removed = remove_exclude(&music)
            .await
            .expect("exclude removal should succeed");
        let removed_again = remove_exclude(&music)
            .await
            .expect("repeated exclude removal should succeed");
        let exclude_count_after = count_excludes().await;

        assert!(removed.removed);
        assert!(!removed_again.removed);
        assert_eq!(exclude_count_after, 0);

        reset_db();
    });
}

#[test]
fn exclude_identity_keeps_different_segments_separate() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let first_segment = sample_excluded_music();
        let mut second_segment = first_segment.clone();
        second_segment.start_ms = 180_000;
        second_segment.end_ms = 240_000;
        second_segment.canonical_music_id = music_canonical_id(
            &second_segment.url,
            second_segment.start_ms,
            second_segment.end_ms,
        );
        upsert_collection(&collection_with_musics(
            &first_segment.group.collection.url,
            &first_segment.group.collection.folder,
            Some(false),
            vec![first_segment.clone(), second_segment.clone()],
        ))
        .await
        .expect("segmented exclude collection should exist before exclude writes");

        add_exclude(first_segment.clone())
            .await
            .expect("first segment exclude should succeed");
        add_exclude(second_segment.clone())
            .await
            .expect("second segment exclude should succeed");

        assert_eq!(count_excludes().await, 2);

        let removed = remove_exclude(&first_segment)
            .await
            .expect("first segment exclude removal should succeed");

        assert!(removed.removed);
        assert_eq!(count_excludes().await, 1);

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

        assert!(!removed.removed);

        reset_db();
    });
}

#[test]
fn exclude_availability_marks_and_restores_fully_excluded_owners() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let collection_url = "https://example.com/exclude-availability";
        let group = collection_group("Disc 1", &format!("{collection_url}#disc-1"), "Disc 1");
        let first_music = named_music("Availability A", group.clone(), "Disc 1/A.m4a");
        let second_music = named_music("Availability B", group.clone(), "Disc 1/B.m4a");
        let collection = collection_with_musics(
            collection_url,
            "youtube/exclude-availability",
            Some(false),
            vec![first_music.clone(), second_music.clone()],
        );

        upsert_collection(&collection)
            .await
            .expect("collection should exist before exclude availability updates");
        let first_result = add_exclude(first_music.clone())
            .await
            .expect("first exclude should update availability");

        assert!(
            first_result
                .exclude_availability
                .fully_excluded_collection_urls
                .is_empty()
        );
        assert!(
            first_result
                .exclude_availability
                .fully_excluded_group_urls
                .is_empty()
        );

        let second_result = add_exclude(second_music.clone())
            .await
            .expect("second exclude should update availability");

        assert!(
            second_result
                .exclude_availability
                .fully_excluded_collection_urls
                .contains(&collection_url.to_string())
        );
        assert!(
            second_result
                .exclude_availability
                .fully_excluded_group_urls
                .contains(&group.url)
        );

        let new_music = named_music("Availability C", group.clone(), "Disc 1/C.m4a");
        create_music(collection_url, &new_music)
            .await
            .expect("adding music should refresh owner availability");
        let library_after_create = list_config_library()
            .await
            .expect("config library should reload availability");

        assert!(
            !library_after_create
                .exclude_availability
                .fully_excluded_collection_urls
                .contains(&collection_url.to_string())
        );
        assert!(
            !library_after_create
                .exclude_availability
                .fully_excluded_group_urls
                .contains(&group.url)
        );

        let removed = remove_exclude(&first_music)
            .await
            .expect("exclude removal should refresh availability");
        assert!(removed.removed);
        assert!(
            removed
                .exclude_availability
                .fully_excluded_collection_urls
                .is_empty()
        );
        assert!(
            removed
                .exclude_availability
                .fully_excluded_group_urls
                .is_empty()
        );

        reset_db();
    });
}

#[test]
fn list_config_library_does_not_rebuild_missing_exclude_availability() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let collection_url = "https://example.com/passive-exclude-availability";
        let group = collection_group("Disc 1", &format!("{collection_url}#disc-1"), "Disc 1");
        let music = named_music("Passive Availability", group.clone(), "Disc 1/A.m4a");
        let collection = collection_with_musics(
            collection_url,
            "youtube/passive-exclude-availability",
            Some(false),
            vec![music.clone()],
        );

        upsert_collection(&collection)
            .await
            .expect("collection should exist before passive availability read");
        let library_before_exclude = list_config_library()
            .await
            .expect("config library read should not rebuild availability");

        assert!(
            library_before_exclude
                .exclude_availability
                .fully_excluded_collection_urls
                .is_empty()
        );
        assert!(
            library_before_exclude
                .exclude_availability
                .fully_excluded_group_urls
                .is_empty()
        );

        add_exclude(music)
            .await
            .expect("exclude write should update availability");
        let library_after_exclude = list_config_library()
            .await
            .expect("config library should read write-maintained availability");

        assert!(
            library_after_exclude
                .exclude_availability
                .fully_excluded_collection_urls
                .contains(&collection_url.to_string())
        );
        assert!(
            library_after_exclude
                .exclude_availability
                .fully_excluded_group_urls
                .contains(&group.url)
        );

        reset_db();
    });
}

#[test]
fn list_config_library_ignores_invalid_collection_group_membership_edges() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let collection_url = "https://example.com/membership-owner";
        let group = collection_group("Disc 1", &format!("{collection_url}#disc-1"), "Disc 1");
        let music = named_music("Membership Source", group.clone(), "Disc 1/A.m4a");
        let collection = collection_with_musics(
            collection_url,
            "youtube/membership-owner",
            Some(false),
            vec![music.clone()],
        );
        let collection_record =
            insert_collection_row("membership-owner-collection", &collection).await;
        let group_record = insert_group_row("membership-owner-group", &group).await;
        let music_record = insert_music_row("membership-owner-music", &music).await;
        insert_collection_group_edge(&collection_record, &group_record).await;
        insert_raw_include_edge(&music_record, &group_record).await;

        let library = list_config_library()
            .await
            .expect("invalid include edge should not break config library loading");

        assert_eq!(library.collection_group_memberships.len(), 1);
        assert_eq!(
            library.collection_group_memberships[0].collection_url,
            collection_url
        );
        assert_eq!(library.collection_group_memberships[0].group_url, group.url);

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
                canonical_music_id: canonical_music_id_for_source(&url.to_string(), 0, 180_000),
                path: Some("Minus Sixty One.m4a".to_string()),
                start_ms: 0,
                end_ms: 316_000,
                liked: false,
                loudness: 0.0,
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
fn canonical_music_identity_shares_liked_state_across_future_occurrences() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let first_url = "https://example.com/canonical-shared";
        let second_url = "https://example.com/canonical-shared-copy";
        let canonical_url = "https://example.com/watch/shared-canonical";
        let first_group =
            collection_group("Disc 1", "https://example.com/canonical#disc-1", "Disc 1");
        let second_group =
            collection_group("Disc 2", "https://example.com/canonical#disc-2", "Disc 2");
        let first_music = Music {
            name: "Shared Canonical".to_string(),
            alias: "Shared Canonical".to_string(),
            group: first_group,
            canonical_music_id: music_canonical_id(canonical_url, 0, 180_000),
            url: canonical_url.to_string(),
            path: Some("Shared Canonical.m4a".to_string()),
            start_ms: 0,
            end_ms: 180_000,
            liked: false,
            loudness: 0.0,
        };
        let second_music = Music {
            name: "Shared Canonical Copy".to_string(),
            alias: "Shared Canonical Copy".to_string(),
            group: second_group,
            canonical_music_id: music_canonical_id(canonical_url, 0, 180_000),
            url: canonical_url.to_string(),
            path: Some("Shared Canonical Copy.m4a".to_string()),
            start_ms: 0,
            end_ms: 180_000,
            liked: false,
            loudness: 0.0,
        };

        upsert_collection(&collection_with_musics(
            first_url,
            "youtube/canonical-shared",
            Some(false),
            vec![first_music.clone()],
        ))
        .await
        .expect("first occurrence should save");
        set_music_liked_by_identity(canonical_url, 0, 180_000, true)
            .await
            .expect("canonical like should save")
            .expect("liked occurrence should exist");

        let saved = upsert_collection(&collection_with_musics(
            second_url,
            "youtube/canonical-shared-copy",
            Some(false),
            vec![second_music],
        ))
        .await
        .expect("future canonical occurrence should save");

        assert!(saved.musics[0].liked);

        reset_db();
    });
}

#[test]
fn create_music_appends_to_the_source_collection_once() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let collection = upsert_collection(&grouped_collection("https://example.com/music-create"))
            .await
            .expect("grouped collection should save before music create");
        let source_music = collection.musics[0].clone();
        let created_music = Music {
            name: "Created Track".to_string(),
            alias: "Created Track".to_string(),
            group: source_music.group,
            url: "https://example.com/music-create#created".to_string(),
            canonical_music_id: canonical_music_id_for_source(
                &"https://example.com/music-create#created".to_string(),
                0,
                180_000,
            ),
            path: source_music.path,
            start_ms: 0,
            end_ms: 180_000,
            liked: false,
            loudness: 0.0,
        };

        let first = create_music(&collection.url, &created_music)
            .await
            .expect("music create should succeed");
        let second = create_music(&collection.url, &created_music)
            .await
            .expect("repeated music create should be idempotent");
        let reloaded = get_collection_by_url(&collection.url)
            .await
            .expect("updated collection should reload")
            .expect("updated collection should exist");

        assert_eq!(first.alias, "Created Track");
        assert_eq!(second.alias, "Created Track");
        assert_eq!(
            reloaded
                .musics
                .iter()
                .filter(|music| music.url == created_music.url)
                .count(),
            1
        );

        reset_db();
    });
}

#[test]
fn create_music_rejects_missing_source_collection() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let err = create_music(
            "https://example.com/missing",
            &Music {
                name: "Created Track".to_string(),
                alias: "Created Track".to_string(),
                group: collection_group("Disc 1", "https://example.com/missing#disc-1", "Disc 1"),
                url: "https://example.com/missing#created".to_string(),
                canonical_music_id: canonical_music_id_for_source(
                    &"https://example.com/missing#created".to_string(),
                    0,
                    180_000,
                ),
                path: Some("Disc 1/Track.m4a".to_string()),
                start_ms: 0,
                end_ms: 180_000,
                liked: false,
                loudness: 0.0,
            },
        )
        .await
        .expect_err("missing source collection should be rejected");

        assert!(
            err.to_string()
                .contains("collection `https://example.com/missing` not found")
        );

        reset_db();
    });
}

#[test]
fn audio_style_training_musics_load_from_music_rows_without_owner_edges() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let group = collection_group(
            "Disc 1",
            "https://example.com/audio-style-training#disc-1",
            "Disc 1",
        )
        .bind_collection_owner(collection_owner(
            "Training",
            "https://example.com/audio-style-training",
            "unused-owner-folder",
        ));
        let save_root = PathBuf::from("C:/Media");
        let trainable_path = save_root.join("Ready.m4a");
        let trainable_music = named_music(
            "Audio Style Trainable",
            group.clone(),
            &trainable_path.to_string_lossy(),
        );
        let mut pending_music = named_music("Audio Style Pending", group.clone(), "Pending.m4a");
        pending_music.path = None;
        let mut invalid_range_music =
            named_music("Audio Style Invalid", group.clone(), "Invalid.m4a");
        invalid_range_music.end_ms = invalid_range_music.start_ms;
        let mut duplicate_music =
            named_music("Audio Style Duplicate", group.clone(), "Duplicate.m4a");
        duplicate_music.canonical_music_id = trainable_music.canonical_music_id.clone();

        insert_music_row("audio-style-trainable", &trainable_music).await;
        insert_music_row("audio-style-pending", &pending_music).await;
        insert_music_row("audio-style-invalid-range", &invalid_range_music).await;
        insert_music_row("zz-audio-style-duplicate", &duplicate_music).await;

        let training_musics = load_audio_style_training_musics(&save_root)
            .await
            .expect("audio-style training music load should succeed");

        assert_eq!(
            training_musics
                .iter()
                .map(|music| music.canonical_music_id.as_str())
                .collect::<Vec<_>>(),
            vec![trainable_music.canonical_music_id.as_str()]
        );
        assert!(
            [
                trainable_path,
                PathBuf::from("C:/Media").join("Duplicate.m4a")
            ]
            .contains(&PathBuf::from(&training_musics[0].absolute_path))
        );

        reset_db();
    });
}

#[test]
fn audio_style_training_musics_project_relative_paths_with_collection_owner_folder() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let save_root = PathBuf::from("C:/Media");
        let collection = collection_with_musics(
            "https://example.com/audio-style-training-owned",
            "youtube/audio-style-training-owned",
            Some(false),
            vec![named_music(
                "Audio Style Owned Relative",
                collection_group(
                    "Disc 1",
                    "https://example.com/audio-style-training-owned#disc-1",
                    "Disc 1",
                ),
                "Ready.m4a",
            )],
        );
        let group = collection.musics[0]
            .group
            .clone()
            .bind_collection_owner(CollectionGroupOwner::from(&collection));
        let collection_record =
            insert_collection_row("audio-style-owned-collection", &collection).await;
        let group_record = insert_group_row("audio-style-owned-group", &group).await;
        let music_record = insert_music_row("audio-style-owned-music", &collection.musics[0]).await;
        insert_collection_group_edge(&collection_record, &group_record).await;
        insert_music_edges(&collection_record, &[music_record.clone()]).await;
        insert_group_edges(&group_record, &[music_record]).await;

        let training_musics = load_audio_style_training_musics(&save_root)
            .await
            .expect("audio-style training music load should succeed");

        assert_eq!(training_musics.len(), 1);
        assert_eq!(
            PathBuf::from(&training_musics[0].absolute_path),
            save_root
                .join("youtube/audio-style-training-owned")
                .join("Ready.m4a")
        );

        reset_db();
    });
}

#[test]
fn audio_style_training_musics_project_relative_paths_from_collection_membership() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let save_root = PathBuf::from("C:/Media");
        let collection = collection_with_musics(
            "https://example.com/audio-style-training-includes",
            "youtube/audio-style-training-includes",
            Some(false),
            vec![named_music(
                "Audio Style Includes Relative",
                collection_group(
                    "Disc 1",
                    "https://example.com/audio-style-training-includes#disc-1",
                    "Disc 1",
                ),
                "Ready.m4a",
            )],
        );
        let collection_record =
            insert_collection_row("audio-style-includes-collection", &collection).await;
        let music_record =
            insert_music_row("audio-style-includes-music", &collection.musics[0]).await;
        insert_music_edges(&collection_record, std::slice::from_ref(&music_record)).await;

        let training_musics = load_audio_style_training_musics(&save_root)
            .await
            .expect("audio-style training music load should succeed");

        assert_eq!(training_musics.len(), 1);
        assert_eq!(
            PathBuf::from(&training_musics[0].absolute_path),
            save_root
                .join("youtube/audio-style-training-includes")
                .join("Ready.m4a")
        );

        reset_db();
    });
}

#[test]
fn audio_style_training_musics_use_meta_save_root_for_relative_paths() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let save_root = PathBuf::from("C:/Users/admin/Documents/slisic");
        let music = named_music(
            "Audio Style Meta Root Relative",
            collection_group(
                "Loose",
                "https://example.com/audio-style-meta-root#loose",
                "Loose",
            ),
            "youtube/Blue Archive OST/Ready.m4a",
        );

        insert_music_row("audio-style-meta-root-music", &music).await;

        let training_musics = load_audio_style_training_musics(&save_root)
            .await
            .expect("audio-style training music load should succeed");

        assert_eq!(training_musics.len(), 1);
        assert_eq!(
            PathBuf::from(&training_musics[0].absolute_path),
            save_root.join("youtube/Blue Archive OST").join("Ready.m4a")
        );

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
                    canonical_music_id: canonical_music_id_for_source(
                        &"https://example.com/music-delete#a".to_string(),
                        0,
                        180_000,
                    ),
                    path: Some(shared_path.to_string_lossy().to_string()),
                    start_ms: 0,
                    end_ms: 120_000,
                    liked: false,
                    loudness: 0.0,
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
                    canonical_music_id: canonical_music_id_for_source(
                        &"https://example.com/music-delete#b".to_string(),
                        0,
                        180_000,
                    ),
                    path: Some(shared_path.to_string_lossy().to_string()),
                    start_ms: 120_000,
                    end_ms: 240_000,
                    liked: false,
                    loudness: 0.0,
                },
            ],
        );
        let saved = upsert_collection(&collection)
            .await
            .expect("collection should save before music deletion");
        let collection_record = load_collection_ids_by_url(&saved.url).await.remove(0);

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

        let lookup_path = save_root.join(&collection.folder).join(&shared_path);
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
                    canonical_music_id: canonical_music_id_for_source(
                        &"https://example.com/spectrum-source#a".to_string(),
                        0,
                        180_000,
                    ),
                    path: Some(shared_path.to_string_lossy().to_string()),
                    start_ms: 0,
                    end_ms: 120_000,
                    liked: false,
                    loudness: 0.0,
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
                    canonical_music_id: canonical_music_id_for_source(
                        &"https://example.com/spectrum-source#b".to_string(),
                        0,
                        180_000,
                    ),
                    path: Some(shared_path.to_string_lossy().to_string()),
                    start_ms: 120_000,
                    end_ms: 240_000,
                    liked: false,
                    loudness: 0.0,
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
                    canonical_music_id: canonical_music_id_for_source(
                        &"https://example.com/spectrum-source#other".to_string(),
                        0,
                        180_000,
                    ),
                    path: Some("Disc 1/Other.m4a".to_string()),
                    start_ms: 0,
                    end_ms: 60_000,
                    liked: false,
                    loudness: 0.0,
                },
            ],
        );
        let _ = upsert_collection(&collection)
            .await
            .expect("collection should save before file music lookup");

        let lookup_path = save_root.join(&collection.folder).join(&shared_path);
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
fn load_spectrum_music_context_carries_source_owner_evidence_without_playlist_hydration() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let save_root = PathBuf::from("C:/Media");
        let shared_path = PathBuf::from("Disc 1").join("Shared.m4a");
        let source_url = "https://example.com/spectrum-source#a";
        let source_group = collection_group(
            "Disc 1",
            "https://example.com/spectrum-source#disc-1",
            "Disc 1",
        );
        let collection = collection_with_musics(
            "https://example.com/spectrum-source",
            "youtube/spectrum-source",
            Some(false),
            vec![
                Music {
                    name: "Track A Intro".to_string(),
                    alias: "Track A Intro".to_string(),
                    group: source_group.clone(),
                    url: source_url.to_string(),
                    canonical_music_id: canonical_music_id_for_source(
                        &source_url.to_string(),
                        0,
                        180_000,
                    ),
                    path: Some(shared_path.to_string_lossy().to_string()),
                    start_ms: 0,
                    end_ms: 120_000,
                    liked: false,
                    loudness: 0.0,
                },
                Music {
                    name: "Track A Tail".to_string(),
                    alias: "Track A Tail".to_string(),
                    group: source_group.clone(),
                    url: source_url.to_string(),
                    canonical_music_id: canonical_music_id_for_source(
                        &source_url.to_string(),
                        0,
                        180_000,
                    ),
                    path: Some(shared_path.to_string_lossy().to_string()),
                    start_ms: 120_000,
                    end_ms: 240_000,
                    liked: false,
                    loudness: 0.0,
                },
                Music {
                    name: "Track B".to_string(),
                    alias: "Track B".to_string(),
                    group: source_group.clone(),
                    url: "https://example.com/spectrum-source#b".to_string(),
                    canonical_music_id: canonical_music_id_for_source(
                        &"https://example.com/spectrum-source#b".to_string(),
                        0,
                        180_000,
                    ),
                    path: Some(shared_path.to_string_lossy().to_string()),
                    start_ms: 0,
                    end_ms: 60_000,
                    liked: false,
                    loudness: 0.0,
                },
            ],
        );
        let _ = upsert_collection(&collection)
            .await
            .expect("collection should save before spectrum context lookup");

        let lookup_path = save_root.join(&collection.folder).join(&shared_path);
        let context = load_spectrum_music_context(
            &lookup_path,
            &save_root,
            Some(SpectrumMusicSourceIdentity {
                url: source_url,
                start_ms: 120_000,
                end_ms: 240_000,
            }),
        )
        .await
        .expect("spectrum context lookup should succeed");

        assert_eq!(context.file_musics.len(), 3);
        let source = context
            .source
            .expect("matching source identity should carry owner evidence");
        assert_eq!(source.source_collection_url, collection.url);
        assert_eq!(source.source_url, source_url);
        assert_eq!(source.source_start_ms, 120_000);
        assert_eq!(source.source_end_ms, 240_000);
        assert_eq!(source.source_group.url, source_group.url);
        assert_eq!(
            source.source_path.as_deref(),
            Some(shared_path.to_string_lossy().as_ref())
        );

        reset_db();
    });
}

#[test]
fn load_spectrum_music_context_filters_collection_candidates_by_path_components() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let save_root = PathBuf::from("C:/Media");
        let shared_path = PathBuf::from("Disc 1").join("Shared.m4a");
        let source_group = collection_group(
            "Disc 1",
            "https://example.com/spectrum-path#disc-1",
            "Disc 1",
        );
        let collection = collection_with_musics(
            "https://example.com/spectrum-path",
            "youtube/spectrum-path",
            Some(false),
            vec![Music {
                name: "Track".to_string(),
                alias: "Track".to_string(),
                group: source_group.clone(),
                url: "https://example.com/spectrum-path#track".to_string(),
                canonical_music_id: canonical_music_id_for_source(
                    &"https://example.com/spectrum-path#track".to_string(),
                    0,
                    180_000,
                ),
                path: Some(shared_path.to_string_lossy().to_string()),
                start_ms: 0,
                end_ms: 120_000,
                liked: false,
                loudness: 0.0,
            }],
        );
        let neighbor = collection_with_musics(
            "https://example.com/spectrum-path-neighbor",
            "youtube/spectrum-path-neighbor",
            Some(false),
            vec![Music {
                name: "Neighbor Track".to_string(),
                alias: "Neighbor Track".to_string(),
                group: collection_group(
                    "Disc 1",
                    "https://example.com/spectrum-path-neighbor#disc-1",
                    "Disc 1",
                ),
                url: "https://example.com/spectrum-path-neighbor#track".to_string(),
                canonical_music_id: canonical_music_id_for_source(
                    &"https://example.com/spectrum-path-neighbor#track".to_string(),
                    0,
                    180_000,
                ),
                path: Some(shared_path.to_string_lossy().to_string()),
                start_ms: 0,
                end_ms: 120_000,
                liked: false,
                loudness: 0.0,
            }],
        );
        let _ = upsert_collection(&collection)
            .await
            .expect("source collection should save");
        let _ = upsert_collection(&neighbor)
            .await
            .expect("neighbor collection should save");

        let lookup_path = save_root.join(&collection.folder).join(&shared_path);
        let context = load_spectrum_music_context(&lookup_path, &save_root, None)
            .await
            .expect("spectrum context lookup should succeed");

        assert_eq!(context.file_musics.len(), 1);
        assert_eq!(context.file_musics[0].alias, "Track");

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
fn upsert_collection_is_idempotent_for_repeated_canonical_collection_writes() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_collection_write_schema().await;

        let url = "https://example.com/repeated-music";
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
            insert_collection_row("corrupted-root", &sample_collection(root_url, Some(false)))
                .await;
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
        let music_record =
            insert_music_row("repo-playlist-track", &playlist.collections[0].musics[0]).await;
        insert_music_edges(&collection_record, std::slice::from_ref(&music_record)).await;
        let group_record = insert_group_row("repo-playlist-group", &playlist.groups[0]).await;
        insert_collection_group_edge(&collection_record, &group_record).await;
        insert_group_edges(&group_record, std::slice::from_ref(&music_record)).await;
        insert_playlist_row(
            "repo-playlist",
            &playlist,
            std::slice::from_ref(&collection_record),
            std::slice::from_ref(&group_record),
            &[],
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
fn list_playlists_reads_surface_rows_without_hydrating_music() {
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
            &[],
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
            &[],
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

        assert_playlist_list_view_matches(first_loaded, &first);
        assert_playlist_list_view_matches(second_loaded, &second);

        reset_db();
    });
}

#[test]
fn get_playlist_config_reads_one_level_surfaces_without_music() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let playlist = sample_playlist("repo-playlist-config");
        let collection_record =
            insert_collection_row("repo-playlist-config-collection", &playlist.collections[0])
                .await;
        let group_record =
            insert_group_row("repo-playlist-config-group", &playlist.groups[0]).await;
        insert_collection_group_edge(&collection_record, &group_record).await;
        insert_playlist_row(
            "repo-playlist-config",
            &playlist,
            std::slice::from_ref(&collection_record),
            std::slice::from_ref(&group_record),
            &[],
        )
        .await;

        let loaded = get_playlist_config_by_name(&playlist.name)
            .await
            .expect("playlist config lookup should succeed")
            .expect("playlist config should exist");

        assert_playlist_config_view_matches(&loaded, &playlist);

        reset_db();
    });
}

#[test]
fn list_config_library_reads_collection_and_group_surfaces() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let playlist = sample_playlist("repo-config-library");
        let collection_record =
            insert_collection_row("repo-config-library-collection", &playlist.collections[0]).await;
        let group_record = insert_group_row("repo-config-library-group", &playlist.groups[0]).await;
        insert_collection_group_edge(&collection_record, &group_record).await;
        let excluded_music = playlist.collections[0].musics[0].clone();
        add_exclude(excluded_music.clone())
            .await
            .expect("exclude row should save before config library load");

        let library = list_config_library()
            .await
            .expect("config library should load");

        let collection = library
            .collections
            .iter()
            .find(|collection| collection.url == playlist.collections[0].url)
            .expect("surface collection should be listed");
        let group = library
            .groups
            .iter()
            .find(|group| group.url == playlist.groups[0].url)
            .expect("surface group should be listed");

        assert_collection_surface_matches(collection, &playlist.collections[0]);
        assert_group_surface_matches(group, &playlist.groups[0]);
        assert_eq!(library.excludes.len(), 1);
        assert_eq!(library.excludes[0].music.url, excluded_music.url);
        assert_eq!(library.excludes[0].music.start_ms, excluded_music.start_ms);
        assert_eq!(library.excludes[0].music.end_ms, excluded_music.end_ms);

        reset_db();
    });
}

#[test]
fn upsert_playlist_creates_new_rows_and_updates_existing_renames() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let original = sample_playlist("Original");
        upsert_collection(&original.collections[0])
            .await
            .expect("original collection should exist before playlist save");
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
        assert_playlist_list_view_matches(&listed[0], &renamed);

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
            extra: vec![],

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
fn upsert_playlist_surface_is_immediately_usable_for_playback_selection() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let collection_url = "https://example.com/immediate-playback";
        let collection_folder = "youtube/immediate-playback";
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
            name: "Immediate Playback".to_string(),
            collections: vec![Collection {
                musics: vec![],
                ..sample_collection(collection_url, Some(false))
            }],
            groups: vec![],
            extra: vec![],

            created_at: AutoFill::pending(),
        };

        let upsert = upsert_playlist_surface(&PlayListWriteRequest::from_playlist(&playlist), None)
            .await
            .expect("playlist save should succeed");
        let saved = upsert.playlist;
        let persisted_collection = get_collection_by_url(collection_url)
            .await
            .expect("library collection reload should succeed")
            .expect("library collection should still exist");
        let selection = get_playlist_playback_selection_by_name(&saved.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist immediately after save");
        let sources = load_playlist_playback_track_sources(&selection, 1)
            .await
            .expect("playback source should load immediately after save");

        assert_eq!(selection.playlist_name, playlist.name);
        assert_eq!(saved.name, playlist.name);
        assert!(upsert.playback_selection_changed);
        assert_eq!(persisted_collection.musics.len(), 1);
        assert_eq!(
            persisted_collection.musics[0].url,
            populated_collection.musics[0].url
        );
        assert_eq!(selection.collections.len(), 1);
        assert_eq!(selection.collections[0].url, populated_collection.url);
        assert_eq!(
            selection.download_scopes,
            vec![populated_collection.url.clone()]
        );
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].music.url, populated_collection.musics[0].url);

        reset_db();
    });
}

#[test]
fn upsert_playlist_surface_rename_is_immediately_usable_for_playback_selection() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let collection_url = "https://example.com/immediate-playback-rename";
        let collection_folder = "youtube/immediate-playback-rename";
        let populated_collection = collection_with_musics(
            collection_url,
            collection_folder,
            Some(false),
            vec![shared_music(collection_url, collection_folder)],
        );
        upsert_collection(&populated_collection)
            .await
            .expect("library collection should persist before playlist save");

        let original = PlayList {
            name: "Immediate Playback Original".to_string(),
            collections: vec![Collection {
                musics: vec![],
                ..sample_collection(collection_url, Some(false))
            }],
            groups: vec![],
            extra: vec![],
            created_at: AutoFill::pending(),
        };
        let renamed = PlayList {
            name: "Immediate Playback Renamed".to_string(),
            ..original.clone()
        };

        let created =
            upsert_playlist_surface(&PlayListWriteRequest::from_playlist(&original), None)
                .await
                .expect("playlist create should succeed");
        let renamed_upsert = upsert_playlist_surface(
            &PlayListWriteRequest::from_playlist(&renamed),
            Some(&original.name),
        )
        .await
        .expect("playlist rename should succeed");
        let saved = renamed_upsert.playlist;
        let missing_original = get_playlist_by_name(&original.name)
            .await
            .expect("original playlist lookup should succeed");
        let selection = get_playlist_playback_selection_by_name(&saved.name)
            .await
            .expect("renamed playback selection lookup should succeed")
            .expect("renamed playback selection should exist immediately after save");
        let sources = load_playlist_playback_track_sources(&selection, 1)
            .await
            .expect("renamed playback source should load immediately after save");

        assert!(created.playback_selection_changed);
        assert!(
            !renamed_upsert.playback_selection_changed,
            "pure rename must not invalidate first-slot playback cargo"
        );
        assert!(missing_original.is_none());
        assert_eq!(saved.name, renamed.name);
        assert_eq!(selection.playlist_name, renamed.name);
        assert_eq!(selection.collections.len(), 1);
        assert_eq!(selection.collections[0].url, populated_collection.url);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].music.url, populated_collection.musics[0].url);

        reset_db();
    });
}

#[test]
fn upsert_playlist_surface_releases_previous_title_for_later_create() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let original = PlayList {
            name: "PlayList 1".to_string(),
            collections: vec![],
            groups: vec![],
            extra: vec![],
            created_at: AutoFill::pending(),
        };
        let renamed = PlayList {
            name: "PlayList".to_string(),
            ..original.clone()
        };
        let replacement = PlayList {
            name: original.name.clone(),
            collections: vec![],
            groups: vec![],
            extra: vec![],
            created_at: AutoFill::pending(),
        };

        upsert_playlist_surface(&PlayListWriteRequest::from_playlist(&original), None)
            .await
            .expect("original playlist create should succeed");
        upsert_playlist_surface(
            &PlayListWriteRequest::from_playlist(&renamed),
            Some(&original.name),
        )
        .await
        .expect("rename should release the old title");
        let created_replacement =
            upsert_playlist_surface(&PlayListWriteRequest::from_playlist(&replacement), None)
                .await
                .expect("released title should be available for a new playlist");
        let playlists = list_playlists()
            .await
            .expect("playlist listing should succeed after title reuse");

        assert_eq!(created_replacement.playlist.name, replacement.name);
        assert_eq!(playlists.len(), 2);
        assert!(
            playlists
                .iter()
                .any(|playlist| playlist.name == renamed.name)
        );
        assert!(
            playlists
                .iter()
                .any(|playlist| playlist.name == replacement.name)
        );

        reset_db();
    });
}

#[test]
fn upsert_playlist_surface_rejects_create_when_title_is_still_occupied() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let existing = PlayList {
            name: "PlayList 1".to_string(),
            collections: vec![],
            groups: vec![],
            extra: vec![],
            created_at: AutoFill::pending(),
        };
        let duplicate = PlayList {
            name: existing.name.clone(),
            collections: vec![],
            groups: vec![],
            extra: vec![],
            created_at: AutoFill::pending(),
        };

        upsert_playlist_surface(&PlayListWriteRequest::from_playlist(&existing), None)
            .await
            .expect("existing playlist create should succeed");
        let error = upsert_playlist_surface(&PlayListWriteRequest::from_playlist(&duplicate), None)
            .await
            .expect_err("duplicate create must be rejected by repository name index");
        let message = error.to_string();

        assert!(
            message.contains("already exists") || message.contains("play_list_name_unique"),
            "duplicate create should fail on name ownership, got: {message}"
        );

        reset_db();
    });
}

#[test]
fn claim_generated_playlist_name_uses_repository_name_index_not_visible_seed() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let occupied = PlayList {
            name: "PlayList 1".to_string(),
            collections: vec![],
            groups: vec![],
            extra: vec![],
            created_at: AutoFill::pending(),
        };

        upsert_playlist_surface(&PlayListWriteRequest::from_playlist(&occupied), None)
            .await
            .expect("occupied playlist create should succeed");

        let claimed = claim_generated_playlist_name(&[])
            .await
            .expect("repository name claim should succeed");

        assert_eq!(claimed, "PlayList 2");

        reset_db();
    });
}

#[test]
fn claim_generated_playlist_name_respects_visible_seed_names() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let claimed =
            claim_generated_playlist_name(&["PlayList 1".to_string(), "PlayList 3".to_string()])
                .await
                .expect("repository name claim should use visible seed names");

        assert_eq!(claimed, "PlayList 2");

        reset_db();
    });
}

#[test]
fn upsert_playlist_surface_rename_reports_playback_selection_change_only_for_ref_changes() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let first_collection_url = "https://example.com/rename-selection-first";
        let second_collection_url = "https://example.com/rename-selection-second";
        let first_collection = collection_with_musics(
            first_collection_url,
            "youtube/rename-selection-first",
            Some(false),
            vec![shared_music(
                first_collection_url,
                "youtube/rename-selection-first",
            )],
        );
        let second_collection = collection_with_musics(
            second_collection_url,
            "youtube/rename-selection-second",
            Some(false),
            vec![shared_music(
                second_collection_url,
                "youtube/rename-selection-second",
            )],
        );
        upsert_collection(&first_collection)
            .await
            .expect("first library collection should persist before playlist save");
        upsert_collection(&second_collection)
            .await
            .expect("second library collection should persist before playlist save");

        let original = PlayList {
            name: "Rename Selection Original".to_string(),
            collections: vec![Collection {
                musics: vec![],
                ..first_collection.clone()
            }],
            groups: vec![],
            extra: vec![],
            created_at: AutoFill::pending(),
        };
        let changed = PlayList {
            name: "Rename Selection Changed".to_string(),
            collections: vec![Collection {
                musics: vec![],
                ..second_collection.clone()
            }],
            ..original.clone()
        };

        upsert_playlist_surface(&PlayListWriteRequest::from_playlist(&original), None)
            .await
            .expect("playlist create should succeed");
        let changed_upsert = upsert_playlist_surface(
            &PlayListWriteRequest::from_playlist(&changed),
            Some(&original.name),
        )
        .await
        .expect("playlist rename with selection change should succeed");

        assert!(
            changed_upsert.playback_selection_changed,
            "rename with changed playback refs must invalidate first-slot cargo"
        );
        let selection = get_playlist_playback_selection_by_name(&changed_upsert.playlist.name)
            .await
            .expect("changed playback selection lookup should succeed")
            .expect("changed playback selection should exist");
        assert_eq!(selection.collections.len(), 1);
        assert_eq!(selection.collections[0].url, second_collection.url);

        reset_db();
    });
}

#[test]
fn upsert_playlist_surface_writes_extra_refs_without_hydrating_music() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let collection_url = "https://example.com/surface-extra-library";
        let collection_folder = "youtube/surface-extra-library";
        let group = collection_group("Disc 1", &format!("{collection_url}#disc-1"), "Disc 1");
        let extra_music = named_music(
            "Surface Extra Track",
            group,
            "Disc 1/Surface Extra Track.m4a",
        );
        let collection = collection_with_musics(
            collection_url,
            collection_folder,
            Some(false),
            vec![extra_music.clone()],
        );
        upsert_collection(&collection)
            .await
            .expect("extra source collection should exist before playlist save");

        let playlist = PlayList {
            name: "Surface Extra Playlist".to_string(),
            collections: vec![],
            groups: vec![],
            extra: vec![extra_music.clone()],
            created_at: AutoFill::pending(),
        };
        let upsert = upsert_playlist_surface(&PlayListWriteRequest::from_playlist(&playlist), None)
            .await
            .expect("playlist surface save should succeed");
        let saved = upsert.playlist;
        let expected_music_record = extra_music
            .resolve_record_id()
            .await
            .expect("extra music record id should resolve");
        let mut row_result = get_db()
            .expect("global playlist repo database handle should exist")
            .query("SELECT VALUE extra FROM $table WHERE name = $name LIMIT 1;")
            .bind(("table", Table::from(PlayList::table_name())))
            .bind(("name", saved.name.clone()))
            .await
            .expect("playlist extra row query should succeed")
            .check()
            .expect("playlist extra row response should succeed");
        let row_extra: Option<Vec<RecordId>> = row_result
            .take(0)
            .expect("playlist extra refs should decode");
        let selection = get_playlist_playback_selection_by_name(&saved.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist immediately after save");
        let sources = load_playlist_playback_track_sources(&selection, 1)
            .await
            .expect("extra playback source should load immediately after save");

        assert!(upsert.playback_selection_changed);
        assert_eq!(row_extra, Some(vec![expected_music_record]));
        assert_eq!(selection.collections.len(), 0);
        assert_eq!(selection.groups.len(), 0);
        assert_eq!(selection.extra.len(), 1);
        assert_eq!(sources.len(), 1);
        assert_eq!(
            sources[0].music.canonical_music_id,
            extra_music.canonical_music_id
        );

        reset_db();
    });
}

#[test]
fn upsert_playlist_persists_extra_and_config_view_hydrates_music() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let collection_url = "https://example.com/extra-library";
        let collection_folder = "youtube/extra-library";
        let group = collection_group("Disc 1", &format!("{collection_url}#disc-1"), "Disc 1");
        let extra_music = named_music("Extra Track", group, "Disc 1/Extra Track.m4a");
        let collection = collection_with_musics(
            collection_url,
            collection_folder,
            Some(false),
            vec![extra_music.clone()],
        );
        upsert_collection(&collection)
            .await
            .expect("extra source collection should exist before playlist save");

        let playlist = PlayList {
            name: "Extra Playlist".to_string(),
            collections: vec![],
            groups: vec![],
            extra: vec![extra_music.clone()],
            created_at: AutoFill::pending(),
        };
        let saved = upsert_playlist(&playlist, None)
            .await
            .expect("playlist with extra should save");
        let loaded = get_playlist_by_name(&playlist.name)
            .await
            .expect("playlist with extra should load")
            .expect("playlist should exist");
        let config = get_playlist_config_by_name(&playlist.name)
            .await
            .expect("playlist config with extra should load")
            .expect("playlist config should exist");

        assert_eq!(saved.extra.len(), 1);
        assert_eq!(
            saved.extra[0].canonical_music_id,
            extra_music.canonical_music_id
        );
        assert_eq!(loaded.extra.len(), 1);
        assert_eq!(
            loaded.extra[0].canonical_music_id,
            extra_music.canonical_music_id
        );
        assert_eq!(config.extra.len(), 1);
        assert_eq!(
            config.extra[0].canonical_music_id,
            extra_music.canonical_music_id
        );
        assert_eq!(config.extra[0].path, extra_music.path);

        reset_db();
    });
}

#[test]
fn push_extra_is_idempotent_and_remove_extra_updates_config() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let collection_url = "https://example.com/push-extra-library";
        let group = collection_group("Disc 1", &format!("{collection_url}#disc-1"), "Disc 1");
        let extra_music = named_music("Push Extra", group, "Disc 1/Push Extra.m4a");
        let collection = collection_with_musics(
            collection_url,
            "youtube/push-extra-library",
            Some(false),
            vec![extra_music.clone()],
        );
        upsert_collection(&collection)
            .await
            .expect("extra source collection should exist before push");

        let playlist = PlayList {
            name: "Push Extra Playlist".to_string(),
            collections: vec![],
            groups: vec![],
            extra: vec![],
            created_at: AutoFill::pending(),
        };
        upsert_playlist(&playlist, None)
            .await
            .expect("empty extra playlist should save");

        let first = push_extra(&playlist.name, extra_music.clone())
            .await
            .expect("first extra push should succeed")
            .expect("playlist should still exist");
        let second = push_extra(&playlist.name, extra_music.clone())
            .await
            .expect("second extra push should be idempotent")
            .expect("playlist should still exist");

        assert_eq!(first.extra.len(), 1);
        assert_eq!(second.extra.len(), 1);
        assert_eq!(
            second.extra[0].canonical_music_id,
            extra_music.canonical_music_id
        );

        let removed = remove_extra(&playlist.name, &extra_music)
            .await
            .expect("extra removal should succeed")
            .expect("playlist should still exist");
        let removed_again = remove_extra(&playlist.name, &extra_music)
            .await
            .expect("repeated extra removal should succeed")
            .expect("playlist should still exist");

        assert!(removed.extra.is_empty());
        assert!(removed_again.extra.is_empty());

        reset_db();
    });
}

#[test]
fn push_extra_updates_only_extra_refs() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let collection_url = "https://example.com/push-extra-only-library";
        let group = collection_group("Disc 1", &format!("{collection_url}#disc-1"), "Disc 1");
        let extra_music = named_music("Push Extra Only", group, "Disc 1/Push Extra Only.m4a");
        let collection = collection_with_musics(
            collection_url,
            "youtube/push-extra-only-library",
            Some(false),
            vec![extra_music.clone()],
        );
        upsert_collection(&collection)
            .await
            .expect("extra source collection should exist before push");

        let playlist = PlayList {
            name: "Push Extra Only Playlist".to_string(),
            collections: vec![],
            groups: vec![],
            extra: vec![],
            created_at: AutoFill::pending(),
        };
        upsert_playlist(&playlist, None)
            .await
            .expect("empty extra playlist should save");
        let mut playlist_record_result = get_db()
            .expect("global playlist repo database handle should exist")
            .query("SELECT VALUE id FROM $table WHERE name = $name LIMIT 1;")
            .bind(("table", Table::from(PlayList::table_name())))
            .bind(("name", playlist.name.clone()))
            .await
            .expect("playlist lookup query should succeed")
            .check()
            .expect("playlist lookup response should succeed");
        let playlist_record: Option<RecordId> = playlist_record_result
            .take(0)
            .expect("playlist lookup id should decode");
        let playlist_record = playlist_record.expect("playlist record should exist");
        let mut original_result = get_db()
            .expect("global playlist repo database handle should exist")
            .query("SELECT collections, groups, created_at FROM ONLY $record;")
            .bind(("record", playlist_record.clone()))
            .await
            .expect("playlist row query should succeed")
            .check()
            .expect("playlist row query response should succeed");
        let original_playlist_row: Option<serde_json::Value> =
            original_result.take(0).expect("playlist row should decode");
        let original_playlist_row = original_playlist_row.expect("playlist row should exist");

        push_extra(&playlist.name, extra_music)
            .await
            .expect("extra push should succeed")
            .expect("playlist should still exist");

        let mut updated_result = get_db()
            .expect("global playlist repo database handle should exist")
            .query("SELECT collections, groups, created_at FROM ONLY $record;")
            .bind(("record", playlist_record))
            .await
            .expect("playlist row query should succeed")
            .check()
            .expect("playlist row query response should succeed");
        let updated_playlist_row: Option<serde_json::Value> =
            updated_result.take(0).expect("playlist row should decode");
        let updated_playlist_row = updated_playlist_row.expect("playlist row should exist");

        assert_eq!(updated_playlist_row, original_playlist_row);

        reset_db();
    });
}

#[test]
fn upsert_playlist_rejects_unknown_collection_refs() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let playlist = PlayList {
            name: "Broken Reference".to_string(),
            collections: vec![Collection {
                name: "Missing".to_string(),
                url: "https://example.com/missing-collection".to_string(),
                folder: "youtube/missing-collection".to_string(),
                musics: vec![],
                last_updated: "2026-04-12T00:00:00+00:00".to_string(),
                enable_updates: None,
            }],
            groups: vec![],
            extra: vec![],

            created_at: AutoFill::pending(),
        };

        let error = upsert_playlist(&playlist, None)
            .await
            .expect_err("playlist save should reject unknown collection refs")
            .to_string();

        assert!(error.contains("references unknown collection"));

        reset_db();
    });
}

#[test]
fn upsert_playlist_rejects_unknown_group_refs() {
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
            name: "Broken Group Reference".to_string(),
            collections: vec![Collection {
                musics: vec![],
                ..sample_collection(collection_url, Some(false))
            }],
            groups: vec![Group {
                name: "Missing Disc".to_string(),
                url: "https://example.com/missing-disc".to_string(),
                collection: collection_owner(
                    "Missing Collection",
                    "https://example.com/missing-collection",
                    "youtube/missing-collection",
                ),
                folder: "Missing Disc".to_string(),
            }],
            extra: vec![],

            created_at: AutoFill::pending(),
        };

        let error = upsert_playlist(&playlist, None)
            .await
            .expect_err("playlist save should reject unknown group refs")
            .to_string();

        assert!(error.contains("references unknown group"));

        reset_db();
    });
}

#[test]
fn delete_playlist_by_name_removes_only_the_playlist_row() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let playlist = sample_playlist("Delete Me");
        upsert_collection(&playlist.collections[0])
            .await
            .expect("playlist collection should exist before playlist save");
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

#[test]
fn playlist_playback_selection_reads_refs_without_hydrating_unselected_collections() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let selected_group =
            collection_group("Disc 1", "https://example.com/selected#disc-1", "Disc 1");
        let selected_music = Music {
            name: "Selected".to_string(),
            alias: "Selected".to_string(),
            group: selected_group.clone(),
            url: "https://example.com/watch/selected".to_string(),
            canonical_music_id: canonical_music_id_for_source(
                &"https://example.com/watch/selected".to_string(),
                0,
                180_000,
            ),
            path: Some("Selected.m4a".to_string()),
            start_ms: 0,
            end_ms: 60_000,
            liked: false,
            loudness: 0.0,
        };
        let selected_collection = collection_with_musics(
            "https://example.com/selected",
            "youtube/selected",
            Some(false),
            vec![selected_music.clone()],
        );
        let unselected_collection = collection_with_musics(
            "https://example.com/unselected",
            "youtube/unselected",
            Some(false),
            vec![Music {
                name: "Unselected".to_string(),
                alias: "Unselected".to_string(),
                group: collection_group("Other", "https://example.com/unselected#disc-1", "Disc 1"),
                url: "https://example.com/watch/unselected".to_string(),
                canonical_music_id: canonical_music_id_for_source(
                    &"https://example.com/watch/unselected".to_string(),
                    0,
                    180_000,
                ),
                path: Some("Unselected.m4a".to_string()),
                start_ms: 0,
                end_ms: 60_000,
                liked: false,
                loudness: 0.0,
            }],
        );

        let selected_collection_record =
            insert_collection_row("playback-selected-collection", &selected_collection).await;
        let unselected_collection_record =
            insert_collection_row("playback-unselected-collection", &unselected_collection).await;
        let selected_group_record =
            insert_group_row("playback-selected-group", &selected_group).await;
        insert_collection_group_edge(&selected_collection_record, &selected_group_record).await;
        let selected_music_record =
            insert_music_row("playback-selected-music", &selected_music).await;
        let unselected_music_record = insert_music_row(
            "playback-unselected-music",
            &unselected_collection.musics[0],
        )
        .await;

        insert_music_edges(
            &selected_collection_record,
            std::slice::from_ref(&selected_music_record),
        )
        .await;
        insert_music_edges(
            &unselected_collection_record,
            std::slice::from_ref(&unselected_music_record),
        )
        .await;
        insert_group_edges(
            &selected_group_record,
            std::slice::from_ref(&selected_music_record),
        )
        .await;

        let playlist = PlayList {
            name: "Playback Fast Path".to_string(),
            collections: vec![selected_collection.clone()],
            groups: vec![selected_group.clone()],
            extra: vec![],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "playback-fast-path-playlist",
            &playlist,
            std::slice::from_ref(&selected_collection_record),
            std::slice::from_ref(&selected_group_record),
            &[],
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_playlist_playback_track_sources(&selection, 16)
            .await
            .expect("playback sources should load");

        assert_eq!(selection.playlist_name, playlist.name);
        assert_eq!(selection.collections.len(), 1);
        assert_eq!(selection.collections[0].url, selected_collection.url);
        assert_eq!(selection.groups.len(), 1);
        assert_eq!(selection.groups[0].url, selected_group.url);
        assert_eq!(
            selection.download_scopes,
            vec![selected_collection.url.clone(), selected_group.url.clone()]
        );
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].music.url, selected_music.url);

        reset_db();
    });
}

#[test]
fn playlist_playback_sources_skip_excluded_music() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let selected_group = collection_group(
            "Disc 1",
            "https://example.com/excluded-source#disc-1",
            "Disc 1",
        );
        let excluded_music = named_music("Excluded Source", selected_group.clone(), "Excluded.m4a");
        let playable_music = named_music("Playable Source", selected_group.clone(), "Playable.m4a");
        let selected_collection = collection_with_musics(
            "https://example.com/excluded-source",
            "youtube/excluded-source",
            Some(false),
            vec![excluded_music.clone(), playable_music.clone()],
        );
        let selected_collection_record =
            insert_collection_row("excluded-source-collection", &selected_collection).await;
        let selected_group_record =
            insert_group_row("excluded-source-group", &selected_group).await;
        insert_collection_group_edge(&selected_collection_record, &selected_group_record).await;
        let selected_music_record =
            insert_music_row("excluded-source-music", &excluded_music).await;
        let playable_music_record =
            insert_music_row("playable-source-music", &playable_music).await;

        insert_music_edges(
            &selected_collection_record,
            &[selected_music_record.clone(), playable_music_record.clone()],
        )
        .await;
        insert_group_edges(
            &selected_group_record,
            &[selected_music_record, playable_music_record],
        )
        .await;
        add_exclude(excluded_music.clone())
            .await
            .expect("exclude row should save before playback source load");

        let playlist = PlayList {
            name: "Exclude Playback Sources".to_string(),
            collections: vec![selected_collection.clone()],
            groups: vec![],
            extra: vec![],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "exclude-playback-sources-playlist",
            &playlist,
            std::slice::from_ref(&selected_collection_record),
            &[],
            &[],
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_playlist_playback_track_sources(&selection, 2)
            .await
            .expect("playback sources should load");
        let random_source = load_random_playlist_playback_track_sources(&selection, 1)
            .await
            .expect("random playback source should load")
            .into_iter()
            .next()
            .expect("random playback source should exist");

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].music.url, playable_music.url);
        assert_eq!(random_source.music.url, playable_music.url);

        reset_db();
    });
}

#[test]
fn playlist_playback_sources_include_extra_music() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let collection_url = "https://example.com/extra-playback";
        let group = collection_group("Disc 1", &format!("{collection_url}#disc-1"), "Disc 1");
        let extra_music = named_music("Extra Playback", group, "Disc 1/Extra Playback.m4a");
        let collection = collection_with_musics(
            collection_url,
            "youtube/extra-playback",
            Some(false),
            vec![extra_music.clone()],
        );
        let collection_record =
            insert_collection_row("extra-playback-collection", &collection).await;
        let music_record = insert_music_row("extra-playback-music", &extra_music).await;
        let group_record = insert_group_row("extra-playback-group", &extra_music.group).await;
        insert_collection_group_edge(&collection_record, &group_record).await;
        insert_music_edges(&collection_record, std::slice::from_ref(&music_record)).await;
        insert_group_edges(&group_record, std::slice::from_ref(&music_record)).await;
        let playlist = PlayList {
            name: "Extra Playback Playlist".to_string(),
            collections: vec![],
            groups: vec![],
            extra: vec![extra_music.clone()],
            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "extra-playback-playlist",
            &playlist,
            &[],
            &[],
            std::slice::from_ref(&music_record),
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_playlist_playback_track_sources(&selection, 8)
            .await
            .expect("extra playback sources should load");
        let random_source = load_random_playlist_playback_track_sources(&selection, 1)
            .await
            .expect("random extra playback source should load")
            .into_iter()
            .next()
            .expect("random extra playback source should exist");

        assert_eq!(selection.collections.len(), 0);
        assert_eq!(selection.groups.len(), 0);
        assert_eq!(selection.extra.len(), 1);
        assert!(selection.download_scopes.is_empty());
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].collection_folder, collection.folder);
        assert_eq!(
            sources[0].music.canonical_music_id,
            extra_music.canonical_music_id
        );
        assert_eq!(random_source.collection_folder, collection.folder);
        assert_eq!(
            random_source.music.canonical_music_id,
            extra_music.canonical_music_id
        );
        assert_eq!(
            load_collection_music_ids(&collection_record).await,
            vec![music_record]
        );

        reset_db();
    });
}

#[test]
fn liked_playlist_playback_sources_include_liked_extra_music() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let collection_url = "https://example.com/liked-extra-playback";
        let group = collection_group("Disc 1", &format!("{collection_url}#disc-1"), "Disc 1");
        let mut liked_extra = named_music("Liked Extra", group.clone(), "Disc 1/Liked Extra.m4a");
        let unliked_extra = named_music("Unliked Extra", group, "Disc 1/Unliked Extra.m4a");
        liked_extra.liked = true;
        let collection = collection_with_musics(
            collection_url,
            "youtube/liked-extra-playback",
            Some(false),
            vec![liked_extra.clone(), unliked_extra.clone()],
        );
        let collection_record =
            insert_collection_row("liked-extra-playback-collection", &collection).await;
        let liked_record = insert_music_row("liked-extra-playback-liked", &liked_extra).await;
        let unliked_record = insert_music_row("liked-extra-playback-unliked", &unliked_extra).await;
        let group_record = insert_group_row("liked-extra-playback-group", &liked_extra.group).await;
        insert_collection_group_edge(&collection_record, &group_record).await;
        let music_records = vec![liked_record, unliked_record];
        insert_music_edges(&collection_record, &music_records).await;
        insert_group_edges(&group_record, &music_records).await;
        let playlist = PlayList {
            name: "Liked Extra Playback Playlist".to_string(),
            collections: vec![],
            groups: vec![],
            extra: vec![liked_extra.clone(), unliked_extra],
            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "liked-extra-playback-playlist",
            &playlist,
            &[],
            &[],
            &music_records,
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_liked_playlist_playback_track_sources(&selection, 8)
            .await
            .expect("liked extra playback sources should load");

        assert_eq!(sources.len(), 1);
        assert_eq!(
            sources[0].music.canonical_music_id,
            liked_extra.canonical_music_id
        );

        reset_db();
    });
}

#[test]
fn liked_playlist_playback_sources_skip_excluded_music() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let selected_group = collection_group(
            "Disc 1",
            "https://example.com/liked-excluded-source#disc-1",
            "Disc 1",
        );
        let mut excluded_music = named_music(
            "Liked Excluded Source",
            selected_group.clone(),
            "Excluded.m4a",
        );
        let mut playable_music = named_music(
            "Liked Playable Source",
            selected_group.clone(),
            "Playable.m4a",
        );
        excluded_music.liked = true;
        playable_music.liked = true;
        let selected_collection = collection_with_musics(
            "https://example.com/liked-excluded-source",
            "youtube/liked-excluded-source",
            Some(false),
            vec![excluded_music.clone(), playable_music.clone()],
        );
        let selected_collection_record =
            insert_collection_row("liked-excluded-source-collection", &selected_collection).await;
        let selected_group_record =
            insert_group_row("liked-excluded-source-group", &selected_group).await;
        insert_collection_group_edge(&selected_collection_record, &selected_group_record).await;
        let selected_music_record =
            insert_music_row("liked-excluded-source-music", &excluded_music).await;
        let playable_music_record =
            insert_music_row("liked-playable-source-music", &playable_music).await;

        insert_music_edges(
            &selected_collection_record,
            &[selected_music_record.clone(), playable_music_record.clone()],
        )
        .await;
        insert_group_edges(
            &selected_group_record,
            &[selected_music_record.clone(), playable_music_record],
        )
        .await;
        add_exclude(excluded_music)
            .await
            .expect("exclude row should save before liked playback source load");

        let playlist = PlayList {
            name: "Liked Exclude Playback Sources".to_string(),
            collections: vec![selected_collection],
            groups: vec![],
            extra: vec![],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "liked-exclude-playback-sources-playlist",
            &playlist,
            std::slice::from_ref(&selected_collection_record),
            &[],
            &[],
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_liked_playlist_playback_track_sources(&selection, 2)
            .await
            .expect("liked playback sources should load");

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].music.url, playable_music.url);

        reset_db();
    });
}

#[test]
fn playlist_playback_sources_return_empty_when_all_music_is_excluded() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let selected_group = collection_group(
            "Disc 1",
            "https://example.com/all-excluded#disc-1",
            "Disc 1",
        );
        let excluded_music = named_music("All Excluded", selected_group.clone(), "Excluded.m4a");
        let selected_collection = collection_with_musics(
            "https://example.com/all-excluded",
            "youtube/all-excluded",
            Some(false),
            vec![excluded_music.clone()],
        );
        let selected_collection_record =
            insert_collection_row("all-excluded-collection", &selected_collection).await;
        let selected_music_record = insert_music_row("all-excluded-music", &excluded_music).await;
        let selected_group_record = insert_group_row("all-excluded-group", &selected_group).await;
        insert_collection_group_edge(&selected_collection_record, &selected_group_record).await;
        insert_music_edges(
            &selected_collection_record,
            std::slice::from_ref(&selected_music_record),
        )
        .await;
        add_exclude(excluded_music)
            .await
            .expect("exclude row should save before playback source load");

        let playlist = PlayList {
            name: "All Excluded Playback Sources".to_string(),
            collections: vec![selected_collection],
            groups: vec![],
            extra: vec![],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "all-excluded-playback-sources-playlist",
            &playlist,
            std::slice::from_ref(&selected_collection_record),
            &[],
            &[],
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_playlist_playback_track_sources(&selection, 2)
            .await
            .expect("playback sources should load");
        let random_sources = load_random_playlist_playback_track_sources(&selection, 1)
            .await
            .expect("random playback source should load");

        assert!(sources.is_empty());
        assert!(random_sources.is_empty());

        reset_db();
    });
}

#[test]
fn playlist_playback_sources_deduplicate_collection_group_and_extra_by_canonical_music_id() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let collection_url = "https://example.com/canonical-playback";
        let group = collection_group("Disc 1", &format!("{collection_url}#disc-1"), "Disc 1");
        let primary_music = named_music("Canonical Primary", group.clone(), "Primary.m4a");
        let mut duplicate_music =
            named_music("Canonical Duplicate", group.clone(), "Duplicate.m4a");
        duplicate_music.canonical_music_id = primary_music.canonical_music_id.clone();
        let collection = collection_with_musics(
            collection_url,
            "youtube/canonical-playback",
            Some(false),
            vec![primary_music.clone(), duplicate_music.clone()],
        );
        let collection_record =
            insert_collection_row("canonical-playback-collection", &collection).await;
        let group_record = insert_group_row("canonical-playback-group", &group).await;
        insert_collection_group_edge(&collection_record, &group_record).await;
        let primary_record = insert_music_row("canonical-playback-primary", &primary_music).await;
        let duplicate_record =
            insert_music_row("canonical-playback-duplicate", &duplicate_music).await;

        insert_music_edges(
            &collection_record,
            &[primary_record.clone(), duplicate_record.clone()],
        )
        .await;
        insert_group_edges(
            &group_record,
            &[primary_record.clone(), duplicate_record.clone()],
        )
        .await;

        let playlist = PlayList {
            name: "Canonical Playback Sources".to_string(),
            collections: vec![collection],
            groups: vec![group],
            extra: vec![duplicate_music.clone()],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "canonical-playback-playlist",
            &playlist,
            std::slice::from_ref(&collection_record),
            std::slice::from_ref(&group_record),
            std::slice::from_ref(&duplicate_record),
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_playlist_playback_track_sources(&selection, 8)
            .await
            .expect("playback sources should load");

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].music.url, primary_music.url);
        assert_eq!(
            sources[0].music.canonical_music_id,
            primary_music.canonical_music_id
        );

        reset_db();
    });
}

#[test]
fn liked_playlist_playback_sources_preserve_owner_and_position_order() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let first_group = collection_group(
            "Disc 1",
            "https://example.com/liked-order-first#disc-1",
            "Disc 1",
        );
        let second_group = collection_group(
            "Disc 1",
            "https://example.com/liked-order-second#disc-1",
            "Disc 1",
        );
        let unliked_first = named_music(
            "Liked Order Unliked First",
            first_group.clone(),
            "Unliked First.m4a",
        );
        let mut liked_first =
            named_music("Liked Order First", first_group.clone(), "Liked First.m4a");
        let mut liked_second = named_music(
            "Liked Order Second",
            second_group.clone(),
            "Liked Second.m4a",
        );
        liked_first.liked = true;
        liked_second.liked = true;

        let first_collection = collection_with_musics(
            "https://example.com/liked-order-first",
            "youtube/liked-order-first",
            Some(false),
            vec![unliked_first.clone(), liked_first.clone()],
        );
        let second_collection = collection_with_musics(
            "https://example.com/liked-order-second",
            "youtube/liked-order-second",
            Some(false),
            vec![liked_second.clone()],
        );
        let first_collection_record =
            insert_collection_row("liked-order-first-collection", &first_collection).await;
        let second_collection_record =
            insert_collection_row("liked-order-second-collection", &second_collection).await;
        let first_group_record = insert_group_row("liked-order-first-group", &first_group).await;
        let second_group_record = insert_group_row("liked-order-second-group", &second_group).await;
        insert_collection_group_edge(&first_collection_record, &first_group_record).await;
        insert_collection_group_edge(&second_collection_record, &second_group_record).await;
        let unliked_first_record =
            insert_music_row("liked-order-unliked-first", &unliked_first).await;
        let liked_first_record = insert_music_row("liked-order-first", &liked_first).await;
        let liked_second_record = insert_music_row("liked-order-second", &liked_second).await;

        insert_music_edges(
            &first_collection_record,
            &[unliked_first_record.clone(), liked_first_record.clone()],
        )
        .await;
        insert_music_edges(
            &second_collection_record,
            std::slice::from_ref(&liked_second_record),
        )
        .await;
        insert_group_edges(
            &first_group_record,
            &[unliked_first_record, liked_first_record],
        )
        .await;
        insert_group_edges(
            &second_group_record,
            std::slice::from_ref(&liked_second_record),
        )
        .await;

        let playlist = PlayList {
            name: "Liked Playback Owner Order".to_string(),
            collections: vec![first_collection, second_collection],
            groups: vec![],
            extra: vec![],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "liked-playback-owner-order-playlist",
            &playlist,
            &[first_collection_record, second_collection_record],
            &[],
            &[],
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_liked_playlist_playback_track_sources(&selection, 8)
            .await
            .expect("liked playback sources should load");

        assert_eq!(
            sources
                .iter()
                .map(|source| source.music.url.as_str())
                .collect::<Vec<_>>(),
            vec![liked_first.url.as_str(), liked_second.url.as_str()]
        );

        reset_db();
    });
}

#[test]
fn group_playlist_playback_sources_skip_music_without_parent_collection() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let group = collection_group(
            "Loose Group",
            "https://example.com/group-without-parent#disc-1",
            "Disc 1",
        );
        let loose_music = named_music("Loose Group Music", group.clone(), "Loose.m4a");
        let group_record = insert_group_row("group-without-parent", &group).await;
        let loose_record = insert_music_row("group-without-parent-music", &loose_music).await;
        insert_group_edges(&group_record, std::slice::from_ref(&loose_record)).await;

        let playlist = PlayList {
            name: "Group Without Parent Playback".to_string(),
            collections: vec![],
            groups: vec![group.clone()],
            extra: vec![],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "group-without-parent-playlist",
            &playlist,
            &[],
            std::slice::from_ref(&group_record),
            &[],
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_playlist_playback_track_sources(&selection, 8)
            .await
            .expect("playback sources should load");
        let random_sources = load_random_playlist_playback_track_sources(&selection, 1)
            .await
            .expect("random playback source should load");

        assert_eq!(selection.download_scopes, vec![group.url]);
        assert!(sources.is_empty());
        assert!(random_sources.is_empty());

        reset_db();
    });
}

#[test]
fn extra_playlist_playback_sources_preserve_playlist_ref_order_after_filtering() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let collection_url = "https://example.com/extra-order";
        let group = collection_group("Disc 1", &format!("{collection_url}#disc-1"), "Disc 1");
        let first_music = named_music("Extra Order First", group.clone(), "First.m4a");
        let mut skipped_music = named_music("Extra Order Skipped", group.clone(), "Skipped.m4a");
        let second_music = named_music("Extra Order Second", group.clone(), "Second.m4a");
        skipped_music.path = None;

        let collection = collection_with_musics(
            collection_url,
            "youtube/extra-order",
            Some(false),
            vec![
                first_music.clone(),
                skipped_music.clone(),
                second_music.clone(),
            ],
        );
        let collection_record = insert_collection_row("extra-order-collection", &collection).await;
        let group_record = insert_group_row("extra-order-group", &group).await;
        insert_collection_group_edge(&collection_record, &group_record).await;
        let first_record = insert_music_row("extra-order-first", &first_music).await;
        let skipped_record = insert_music_row("extra-order-skipped", &skipped_music).await;
        let second_record = insert_music_row("extra-order-second", &second_music).await;
        let music_records = vec![
            first_record.clone(),
            skipped_record.clone(),
            second_record.clone(),
        ];

        insert_music_edges(&collection_record, &music_records).await;
        insert_group_edges(&group_record, &music_records).await;

        let playlist = PlayList {
            name: "Extra Playback Ref Order".to_string(),
            collections: vec![],
            groups: vec![],
            extra: vec![
                second_music.clone(),
                skipped_music.clone(),
                first_music.clone(),
            ],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "extra-playback-ref-order-playlist",
            &playlist,
            &[],
            &[],
            &[second_record, skipped_record, first_record],
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_playlist_playback_track_sources(&selection, 8)
            .await
            .expect("extra playback sources should load");

        assert_eq!(
            sources
                .iter()
                .map(|source| source.music.url.as_str())
                .collect::<Vec<_>>(),
            vec![second_music.url.as_str(), first_music.url.as_str()]
        );

        reset_db();
    });
}

#[test]
fn playlist_playback_selection_adds_parent_download_scope_for_group_only_refs() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let selected_group =
            collection_group("Disc 1", "https://example.com/group-only#disc-1", "Disc 1");
        let selected_music = Music {
            name: "Selected".to_string(),
            alias: "Selected".to_string(),
            group: selected_group.clone(),
            url: "https://example.com/watch/group-only".to_string(),
            canonical_music_id: canonical_music_id_for_source(
                &"https://example.com/watch/group-only".to_string(),
                0,
                180_000,
            ),
            path: Some("Selected.m4a".to_string()),
            start_ms: 0,
            end_ms: 60_000,
            liked: false,
            loudness: 0.0,
        };
        let selected_collection = collection_with_musics(
            "https://example.com/group-only",
            "youtube/group-only",
            Some(false),
            vec![selected_music.clone()],
        );
        let selected_collection_record =
            insert_collection_row("group-only-selected-collection", &selected_collection).await;
        let selected_group_record =
            insert_group_row("group-only-selected-group", &selected_group).await;
        insert_collection_group_edge(&selected_collection_record, &selected_group_record).await;
        let selected_music_record =
            insert_music_row("group-only-selected-music", &selected_music).await;

        insert_music_edges(
            &selected_collection_record,
            std::slice::from_ref(&selected_music_record),
        )
        .await;
        insert_group_edges(
            &selected_group_record,
            std::slice::from_ref(&selected_music_record),
        )
        .await;

        let playlist = PlayList {
            name: "Group Only Playback".to_string(),
            collections: vec![],
            groups: vec![selected_group.clone()],
            extra: vec![],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "group-only-playback-playlist",
            &playlist,
            &[],
            std::slice::from_ref(&selected_group_record),
            &[],
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");

        assert_eq!(selection.collections.len(), 0);
        assert_eq!(selection.groups.len(), 1);
        assert_eq!(
            selection.download_scopes,
            vec![selected_group.url.clone(), selected_collection.url.clone()]
        );

        reset_db();
    });
}

#[test]
fn playlist_playback_sources_respect_ordered_window_limit() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let selected_group =
            collection_group("Disc 1", "https://example.com/selected#disc-1", "Disc 1");
        let selected_music_a = named_music("Selected A", selected_group.clone(), "Selected A.m4a");
        let selected_music_b = named_music("Selected B", selected_group.clone(), "Selected B.m4a");
        let selected_collection = collection_with_musics(
            "https://example.com/selected",
            "youtube/selected",
            Some(false),
            vec![selected_music_a.clone(), selected_music_b.clone()],
        );
        let unselected_group =
            collection_group("Other", "https://example.com/unselected#disc-1", "Disc 1");
        let unselected_music = named_music("Unselected", unselected_group, "Unselected.m4a");
        let unselected_collection = collection_with_musics(
            "https://example.com/unselected",
            "youtube/unselected",
            Some(false),
            vec![unselected_music.clone()],
        );

        let selected_collection_record =
            insert_collection_row("selected-collection", &selected_collection).await;
        let unselected_collection_record =
            insert_collection_row("unselected-collection", &unselected_collection).await;
        let selected_group_record = insert_group_row("selected-group", &selected_group).await;
        insert_collection_group_edge(&selected_collection_record, &selected_group_record).await;
        let selected_music_a_record = insert_music_row("selected-a", &selected_music_a).await;
        let selected_music_b_record = insert_music_row("selected-b", &selected_music_b).await;
        let unselected_music_record = insert_music_row("unselected", &unselected_music).await;

        insert_music_edges(
            &selected_collection_record,
            &[
                selected_music_a_record.clone(),
                selected_music_b_record.clone(),
            ],
        )
        .await;
        insert_music_edges(
            &unselected_collection_record,
            std::slice::from_ref(&unselected_music_record),
        )
        .await;
        insert_group_edges(
            &selected_group_record,
            &[selected_music_a_record, selected_music_b_record],
        )
        .await;

        let playlist = PlayList {
            name: "Ordered Playback Window".to_string(),
            collections: vec![selected_collection.clone()],
            groups: vec![selected_group.clone()],
            extra: vec![],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "ordered-playback-window-playlist",
            &playlist,
            std::slice::from_ref(&selected_collection_record),
            std::slice::from_ref(&selected_group_record),
            &[],
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_playlist_playback_track_sources(&selection, 1)
            .await
            .expect("playback source should load");

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].music.url, selected_music_a.url);

        reset_db();
    });
}

#[test]
fn playlist_playback_owner_attempt_order_respects_probe_limit() {
    let owners = playlist_playback_owner_attempt_order(100, 8);
    let mut sorted = owners.clone();
    sorted.sort_unstable();
    sorted.dedup();

    assert_eq!(owners.len(), 8);
    assert_eq!(sorted.len(), owners.len());
    assert!(owners.iter().all(|owner| *owner < 100));
}

#[test]
fn playlist_playback_owner_attempt_order_visits_each_owner_when_probe_covers_all() {
    let mut owners = playlist_playback_owner_attempt_order(8, 32);
    owners.sort_unstable();

    assert_eq!(owners, (0..8).collect::<Vec<_>>());
}

#[test]
fn random_playlist_playback_source_uses_selected_playlist_scope() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let selected_group = collection_group(
            "Disc 1",
            "https://example.com/random-selected#disc-1",
            "Disc 1",
        );
        let selected_music_a = named_music(
            "Random Selected A",
            selected_group.clone(),
            "Selected A.m4a",
        );
        let selected_music_b = named_music(
            "Random Selected B",
            selected_group.clone(),
            "Selected B.m4a",
        );
        let selected_collection = collection_with_musics(
            "https://example.com/random-selected",
            "youtube/random-selected",
            Some(false),
            vec![selected_music_a.clone(), selected_music_b.clone()],
        );
        let unselected_group = collection_group(
            "Other",
            "https://example.com/random-unselected#disc-1",
            "Disc 1",
        );
        let unselected_music = named_music("Random Unselected", unselected_group, "Unselected.m4a");
        let unselected_collection = collection_with_musics(
            "https://example.com/random-unselected",
            "youtube/random-unselected",
            Some(false),
            vec![unselected_music.clone()],
        );

        let selected_collection_record =
            insert_collection_row("random-selected-collection", &selected_collection).await;
        let unselected_collection_record =
            insert_collection_row("random-unselected-collection", &unselected_collection).await;
        let selected_group_record =
            insert_group_row("random-selected-group", &selected_group).await;
        insert_collection_group_edge(&selected_collection_record, &selected_group_record).await;
        let selected_music_a_record =
            insert_music_row("random-selected-a", &selected_music_a).await;
        let selected_music_b_record =
            insert_music_row("random-selected-b", &selected_music_b).await;
        let unselected_music_record =
            insert_music_row("random-unselected", &unselected_music).await;

        insert_music_edges(
            &selected_collection_record,
            &[
                selected_music_a_record.clone(),
                selected_music_b_record.clone(),
            ],
        )
        .await;
        insert_music_edges(
            &unselected_collection_record,
            std::slice::from_ref(&unselected_music_record),
        )
        .await;
        insert_group_edges(
            &selected_group_record,
            &[selected_music_a_record, selected_music_b_record],
        )
        .await;

        let playlist = PlayList {
            name: "Random Playback Source".to_string(),
            collections: vec![selected_collection.clone()],
            groups: vec![selected_group],
            extra: vec![],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "random-playback-source-playlist",
            &playlist,
            std::slice::from_ref(&selected_collection_record),
            std::slice::from_ref(&selected_group_record),
            &[],
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let source = load_random_playlist_playback_track_sources(&selection, 1)
            .await
            .expect("random playback source should load")
            .into_iter()
            .next()
            .expect("random playback source should exist");
        let selected_urls = [selected_music_a.url.as_str(), selected_music_b.url.as_str()];

        assert!(selected_urls.contains(&source.music.url.as_str()));
        assert_ne!(source.music.url, unselected_music.url);

        reset_db();
    });
}

#[test]
fn random_playlist_playback_source_skips_music_without_downloaded_path() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let group = collection_group("Disc 1", "https://example.com/random-path#disc-1", "Disc 1");
        let mut pending_music = named_music("Random Pending", group.clone(), "Pending.m4a");
        pending_music.path = None;
        let playable_music = named_music("Random Playable", group.clone(), "Playable.m4a");
        let collection = collection_with_musics(
            "https://example.com/random-path",
            "youtube/random-path",
            Some(false),
            vec![pending_music.clone(), playable_music.clone()],
        );
        let collection_record = insert_collection_row("random-path-collection", &collection).await;
        let group_record = insert_group_row("random-path-group", &group).await;
        insert_collection_group_edge(&collection_record, &group_record).await;
        let pending_record = insert_music_row("random-path-pending", &pending_music).await;
        let playable_record = insert_music_row("random-path-playable", &playable_music).await;

        insert_music_edges(
            &collection_record,
            &[pending_record.clone(), playable_record.clone()],
        )
        .await;
        insert_group_edges(&group_record, &[pending_record, playable_record]).await;

        let playlist = PlayList {
            name: "Random Playback Path".to_string(),
            collections: vec![collection],
            groups: vec![],
            extra: vec![],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "random-path-playlist",
            &playlist,
            std::slice::from_ref(&collection_record),
            &[],
            &[],
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_playlist_playback_track_sources(&selection, 8)
            .await
            .expect("playback sources should load");

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].music.url, playable_music.url);

        for _ in 0..8 {
            let source = load_random_playlist_playback_track_sources(&selection, 8)
                .await
                .expect("random playback source should load")
                .into_iter()
                .next()
                .expect("random playback source should exist");
            assert_eq!(source.music.url, playable_music.url);
        }

        reset_db();
    });
}

#[test]
fn extra_playlist_playback_sources_skip_music_without_downloaded_path() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_playlist_read_schema().await;

        let collection_url = "https://example.com/extra-path";
        let group = collection_group("Disc 1", &format!("{collection_url}#disc-1"), "Disc 1");
        let mut pending_music = named_music("Extra Pending", group.clone(), "Pending.m4a");
        pending_music.path = None;
        let playable_music = named_music("Extra Playable", group, "Playable.m4a");
        let collection = collection_with_musics(
            collection_url,
            "youtube/extra-path",
            Some(false),
            vec![pending_music.clone(), playable_music.clone()],
        );
        let collection_record = insert_collection_row("extra-path-collection", &collection).await;
        let group_record = insert_group_row("extra-path-group", &playable_music.group).await;
        insert_collection_group_edge(&collection_record, &group_record).await;
        let pending_record = insert_music_row("extra-path-pending", &pending_music).await;
        let playable_record = insert_music_row("extra-path-playable", &playable_music).await;
        let music_records = vec![pending_record.clone(), playable_record.clone()];

        insert_music_edges(&collection_record, &music_records).await;
        insert_group_edges(&group_record, &music_records).await;

        let playlist = PlayList {
            name: "Extra Playback Path".to_string(),
            collections: vec![],
            groups: vec![],
            extra: vec![pending_music, playable_music.clone()],

            created_at: AutoFill::pending(),
        };
        insert_playlist_row(
            "extra-path-playlist",
            &playlist,
            &[],
            &[],
            &[pending_record, playable_record],
        )
        .await;

        let selection = get_playlist_playback_selection_by_name(&playlist.name)
            .await
            .expect("playback selection lookup should succeed")
            .expect("playback selection should exist");
        let sources = load_playlist_playback_track_sources(&selection, 8)
            .await
            .expect("extra playback sources should load");
        let random_source = load_random_playlist_playback_track_sources(&selection, 8)
            .await
            .expect("random extra playback source should load")
            .into_iter()
            .next()
            .expect("random extra playback source should exist");

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].music.url, playable_music.url);
        assert_eq!(random_source.music.url, playable_music.url);

        reset_db();
    });
}

#[test]
fn playlist_playback_selection_contains_only_its_own_track_sources() {
    let collection = PlaylistPlaybackCollectionRef::new_for_test(
        "Selected Collection",
        "https://example.com/selected",
        "youtube/selected",
    );
    let group = collection_group("Selected Group", "https://example.com/group", "Disc 1");
    let inside_collection = PlaylistPlaybackTrackSource {
        collection_folder: "youtube/selected".to_string(),
        music: named_music("A", group.clone(), "A.m4a"),
    };
    let inside_group = PlaylistPlaybackTrackSource {
        collection_folder: "youtube/other".to_string(),
        music: named_music("B", group.clone(), "B.m4a"),
    };
    let outside_group = collection_group("Other Group", "https://example.com/other", "Disc 1");
    let outside = PlaylistPlaybackTrackSource {
        collection_folder: "youtube/other".to_string(),
        music: named_music("C", outside_group, "C.m4a"),
    };
    let selection = PlaylistPlaybackSelection {
        playlist_name: "Scoped".to_string(),
        collections: vec![collection],
        groups: vec![PlaylistPlaybackGroupRef::new_for_test(
            "Selected Group",
            "https://example.com/group",
            "Disc 1",
        )],
        extra: vec![],
        download_scopes: vec![],
    };

    assert!(selection.contains_track_source(&inside_collection));
    assert!(selection.contains_track_source(&inside_group));
    assert!(!selection.contains_track_source(&outside));
}
