use super::model::{
    DownloadLeaf, DownloadLeafStatus, DownloadTask, DownloadTaskStatus, DownloadTrigger,
};

#[test]
fn refresh_counts_tracks_leaf_progress() {
    let mut task = DownloadTask::new(
        "task-1",
        "https://example.com/list",
        DownloadTrigger::Manual,
    );
    let mut first = DownloadLeaf::new("leaf-1", "https://example.com/a", 0);
    let mut second = DownloadLeaf::new("leaf-2", "https://example.com/b", 1);

    first.status = DownloadLeafStatus::Completed;
    second.status = DownloadLeafStatus::Failed;

    task.replace_leaf(first);
    task.replace_leaf(second);

    assert_eq!(task.total_leaves, 2);
    assert_eq!(task.completed_leaves, 1);
    assert_eq!(task.failed_leaves, 1);
}

#[test]
fn mark_interrupted_only_changes_active_states() {
    let mut task = DownloadTask::new(
        "task-2",
        "https://example.com/list",
        DownloadTrigger::Manual,
    );
    let mut queued = DownloadLeaf::new("leaf-queued", "https://example.com/a", 0);
    let mut completed = DownloadLeaf::new("leaf-completed", "https://example.com/b", 1);

    task.status = DownloadTaskStatus::Downloading;
    queued.status = DownloadLeafStatus::Downloading;
    completed.status = DownloadLeafStatus::Completed;
    task.leafs = vec![queued, completed];

    task.mark_interrupted();

    assert_eq!(task.status, DownloadTaskStatus::Interrupted);
    assert_eq!(task.leafs[0].status, DownloadLeafStatus::Interrupted);
    assert_eq!(task.leafs[1].status, DownloadLeafStatus::Completed);
}
