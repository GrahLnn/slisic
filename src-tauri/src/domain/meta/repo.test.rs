use super::model::MetaInfo;
use super::repo::{get_meta_info, save_meta_info};
use crate::domain::playlists::PLAYLIST_DB_TEST_LOCK;
use appdb::connection::{InitDbOptions, reinit_db_with_options, reset_db};
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::runtime::Runtime;

static DB_TEST_RT: LazyLock<Runtime> =
    LazyLock::new(|| Runtime::new().expect("meta repo test runtime should be created"));

fn test_db_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();

    std::env::temp_dir().join(format!(
        "ransic_meta_repo_test_{}_{}",
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
    .expect("meta repo database should initialize");
}

#[test]
fn saves_and_loads_singleton_meta_info() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        assert!(get_meta_info()
            .await
            .expect("meta info lookup should succeed")
            .is_none());

        save_meta_info(MetaInfo {
            save_path: Some("D:\\MediaLibrary".to_string()),
        })
        .await
        .expect("meta info should save");

        let loaded = get_meta_info()
            .await
            .expect("meta info lookup should succeed")
            .expect("meta info should exist");

        assert_eq!(loaded.save_path.as_deref(), Some("D:\\MediaLibrary"));

        reset_db();
    });
}
