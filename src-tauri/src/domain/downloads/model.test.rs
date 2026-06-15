use super::model::{
    DownloadLeaf, DownloadLeafStatus, DownloadTask, DownloadTaskStatus, DownloadTrigger,
};

#[test]
fn completed_leaf_is_consumed_from_residual_task_queue() {
    let mut task = DownloadTask::new(
        "task-1",
        "https://example.com/list",
        DownloadTrigger::Manual,
    );
    let mut first = DownloadLeaf::new("leaf-1", "https://example.com/a", 0);
    let mut second = DownloadLeaf::new("leaf-2", "https://example.com/b", 1);

    first.status = DownloadLeafStatus::Completed;
    second.status = DownloadLeafStatus::Failed;

    task.replace_leaf(DownloadLeaf::new("leaf-1", "https://example.com/a", 0));
    task.replace_leaf(first);
    task.replace_leaf(second);

    assert_eq!(task.total_leaves, 1);
    assert_eq!(task.completed_leaves, 1);
    assert_eq!(task.failed_leaves, 1);
    assert_eq!(task.leafs[0].id.to_string(), "leaf-2");
}

#[test]
fn completed_leaf_count_survives_later_residual_count_refreshes() {
    let mut task = DownloadTask::new(
        "task-completion-count",
        "https://example.com/list",
        DownloadTrigger::Manual,
    );
    let queued = DownloadLeaf::new("leaf-queued", "https://example.com/a", 0);
    let mut completed = DownloadLeaf::new("leaf-completed", "https://example.com/b", 1);
    let mut failed = DownloadLeaf::new("leaf-failed", "https://example.com/c", 2);

    task.replace_leaf(queued);
    task.replace_leaf(completed.clone());
    completed.status = DownloadLeafStatus::Completed;
    task.replace_leaf(completed);
    failed.status = DownloadLeafStatus::Failed;
    task.replace_leaf(failed);

    assert_eq!(task.completed_leaves, 1);
    assert_eq!(task.failed_leaves, 1);
    assert_eq!(task.total_leaves, 2);
}

#[test]
fn repeated_completed_leaf_result_does_not_increment_progress_twice() {
    let mut task = DownloadTask::new(
        "task-duplicate-completion",
        "https://example.com/list",
        DownloadTrigger::Manual,
    );
    let mut completed = DownloadLeaf::new("leaf-completed", "https://example.com/a", 0);

    task.replace_leaf(completed.clone());
    completed.status = DownloadLeafStatus::Completed;
    task.replace_leaf(completed.clone());
    task.replace_leaf(completed);

    assert!(task.leafs.is_empty());
    assert_eq!(task.completed_leaves, 1);
}

#[test]
fn residual_leaf_normalization_keeps_one_leaf_per_identity() {
    let mut task = DownloadTask::new(
        "task-duplicate-residual",
        "https://example.com/list",
        DownloadTrigger::Manual,
    );
    let queued = DownloadLeaf::new("leaf-duplicate", "https://example.com/a", 0);
    let mut probing = DownloadLeaf::new("leaf-duplicate", "https://example.com/a", 0);
    let mut other = DownloadLeaf::new("leaf-other", "https://example.com/b", 1);

    probing.status = DownloadLeafStatus::Probing;
    probing.title = Some("Latest residual state".to_string());
    other.status = DownloadLeafStatus::Failed;
    task.leafs = vec![queued, other, probing];

    task.refresh_counts();

    assert_eq!(task.leafs.len(), 2);
    assert_eq!(task.total_leaves, 2);
    assert_eq!(task.failed_leaves, 1);
    let duplicate = task
        .leafs
        .iter()
        .find(|leaf| leaf.id.to_string() == "leaf-duplicate")
        .expect("duplicate identity should remain once");
    assert_eq!(duplicate.status, DownloadLeafStatus::Probing);
    assert_eq!(duplicate.title.as_deref(), Some("Latest residual state"));
}

#[test]
fn mark_interrupted_only_changes_active_states() {
    let mut task = DownloadTask::new(
        "task-2",
        "https://example.com/list",
        DownloadTrigger::Manual,
    );
    let mut queued = DownloadLeaf::new("leaf-queued", "https://example.com/a", 0);

    task.status = DownloadTaskStatus::Downloading;
    queued.status = DownloadLeafStatus::Downloading;
    task.leafs = vec![queued];

    task.mark_interrupted();

    assert_eq!(task.status, DownloadTaskStatus::Interrupted);
    assert_eq!(task.leafs[0].status, DownloadLeafStatus::Interrupted);
}
