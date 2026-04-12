use super::PLAYLIST_DB_TEST_LOCK;
use super::check_list;
use super::model::PlayList;
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

#[test]
fn check_list_returns_false_when_playlist_table_is_missing_or_empty() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        assert!(
            !check_list()
                .await
                .expect("missing playlist table should not error")
        );

        bootstrap_table(PlayList::table_name()).await;

        assert!(
            !check_list()
                .await
                .expect("empty playlist table should not error")
        );

        reset_db();
    });
}

#[test]
fn check_list_returns_true_when_playlist_table_has_rows() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        bootstrap_table(PlayList::table_name()).await;
        insert_playlist_row("seeded-playlist").await;

        assert!(
            check_list()
                .await
                .expect("seeded playlist table should not error")
        );

        reset_db();
    });
}
