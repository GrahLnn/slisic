use super::model::MetaInfo;
use super::repo::{
    ensure_meta_info, get_meta_info, is_retryable_transaction_conflict, resolve_meta_info,
    save_meta_info,
};
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
        "slisic_meta_repo_test_{}_{}",
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

        assert!(
            get_meta_info()
                .await
                .expect("meta info lookup should succeed")
                .is_none()
        );

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

#[test]
fn resolve_meta_info_backfills_the_default_save_path() {
    let resolved_missing =
        resolve_meta_info(None, "C:\\Users\\admin\\Documents\\slisic".to_string());
    let resolved_null = resolve_meta_info(
        Some(MetaInfo { save_path: None }),
        "C:\\Users\\admin\\Documents\\slisic".to_string(),
    );
    let resolved_existing = resolve_meta_info(
        Some(MetaInfo {
            save_path: Some("D:\\MediaLibrary".to_string()),
        }),
        "C:\\Users\\admin\\Documents\\slisic".to_string(),
    );

    assert_eq!(
        resolved_missing.save_path.as_deref(),
        Some("C:\\Users\\admin\\Documents\\slisic")
    );
    assert_eq!(
        resolved_null.save_path.as_deref(),
        Some("C:\\Users\\admin\\Documents\\slisic")
    );
    assert_eq!(
        resolved_existing.save_path.as_deref(),
        Some("D:\\MediaLibrary")
    );
}

#[test]
fn ensure_meta_info_persists_the_default_save_path_when_missing() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let default_path = "C:\\Users\\admin\\Documents\\slisic".to_string();
        let meta = ensure_meta_info(default_path.clone())
            .await
            .expect("default meta info should be created");
        let loaded = get_meta_info()
            .await
            .expect("meta info lookup should succeed")
            .expect("meta info should exist after ensure");

        assert_eq!(meta.save_path.as_deref(), Some(default_path.as_str()));
        assert_eq!(loaded.save_path.as_deref(), Some(default_path.as_str()));

        reset_db();
    });
}

#[test]
fn retryable_transaction_conflicts_are_classified_for_startup_meta_resolution() {
    let failed_transaction = anyhow::anyhow!(
        "SurrealDB error: The query was not executed due to a failed transaction"
    );
    let write_conflict = anyhow::anyhow!(
        "Transaction conflict: Transaction write conflict. This transaction can be retried"
    );
    let ordinary_error = anyhow::anyhow!("save path should always be configured");

    assert!(is_retryable_transaction_conflict(&failed_transaction));
    assert!(is_retryable_transaction_conflict(&write_conflict));
    assert!(!is_retryable_transaction_conflict(&ordinary_error));
}
