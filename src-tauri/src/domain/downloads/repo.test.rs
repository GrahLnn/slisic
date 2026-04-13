use super::repo::{
    find_latest_active_task_for_url, get_task, list_tasks, mark_interrupted_tasks, save_task,
};
use crate::domain::downloads::model::{
    DownloadLeaf, DownloadLeafStatus, DownloadTask, DownloadTaskStatus, DownloadTrigger,
};
use crate::domain::playlists::PLAYLIST_DB_TEST_LOCK;
use appdb::connection::{InitDbOptions, reinit_db_with_options, reset_db};
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::runtime::Runtime;

static DB_TEST_RT: LazyLock<Runtime> =
    LazyLock::new(|| Runtime::new().expect("download repo test runtime should be created"));

fn test_db_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();

    std::env::temp_dir().join(format!(
        "ransic_download_repo_test_{}_{}",
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
    .expect("download repo database should initialize");
}

fn sample_task(id: &str, url: &str, status: DownloadTaskStatus) -> DownloadTask {
    let mut task = DownloadTask::new(id.to_string(), url.to_string(), DownloadTrigger::Manual);
    let mut leaf = DownloadLeaf::new(format!("{id}-leaf"), format!("{url}/leaf"), 0);
    leaf.status = if status == DownloadTaskStatus::Completed {
        DownloadLeafStatus::Completed
    } else {
        DownloadLeafStatus::Downloading
    };
    task.status = status;
    task.replace_leaf(leaf);
    task
}

#[test]
fn save_and_load_task_round_trips_relation_backed_leafs() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let task = save_task(sample_task(
            "task-roundtrip",
            "https://example.com/list",
            DownloadTaskStatus::Downloading,
        ))
        .await
        .expect("download task should save");

        let loaded = get_task(&task.id.to_string())
            .await
            .expect("download task should load");

        assert_eq!(loaded.id, task.id);
        assert_eq!(loaded.leafs.len(), 1);
        assert_eq!(loaded.leafs[0].id.to_string(), "task-roundtrip-leaf");

        reset_db();
    });
}

#[test]
fn list_tasks_treats_missing_table_as_empty() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let tasks = list_tasks()
            .await
            .expect("missing download task table should behave as empty");

        assert!(tasks.is_empty());

        reset_db();
    });
}

#[test]
fn find_latest_active_task_for_url_ignores_terminal_tasks() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        save_task(sample_task(
            "task-done",
            "https://example.com/list",
            DownloadTaskStatus::Completed,
        ))
        .await
        .expect("completed task should save");

        let active = save_task(sample_task(
            "task-live",
            "https://example.com/list",
            DownloadTaskStatus::Downloading,
        ))
        .await
        .expect("active task should save");

        let found = find_latest_active_task_for_url("https://example.com/list")
            .await
            .expect("active task lookup should succeed")
            .expect("active task should be found");

        assert_eq!(found.id, active.id);

        reset_db();
    });
}

#[test]
fn mark_interrupted_tasks_is_noop_when_task_table_is_missing() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let updated = mark_interrupted_tasks()
            .await
            .expect("missing download task table should behave as no interrupted tasks");

        assert!(updated.is_empty());

        reset_db();
    });
}

#[test]
fn mark_interrupted_tasks_moves_active_rows_into_interrupted_state() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        save_task(sample_task(
            "task-interrupt",
            "https://example.com/list",
            DownloadTaskStatus::Downloading,
        ))
        .await
        .expect("active task should save");
        save_task(sample_task(
            "task-complete",
            "https://example.com/other",
            DownloadTaskStatus::Completed,
        ))
        .await
        .expect("completed task should save");

        let updated = mark_interrupted_tasks()
            .await
            .expect("interrupt recovery should succeed");
        let tasks = list_tasks().await.expect("task listing should succeed");

        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0].status, DownloadTaskStatus::Interrupted);
        assert_eq!(tasks.len(), 2);
        assert!(
            tasks
                .iter()
                .any(|task| task.id.to_string() == "task-interrupt")
        );
        assert!(
            tasks
                .iter()
                .any(|task| task.id.to_string() == "task-complete")
        );

        reset_db();
    });
}
