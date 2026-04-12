use super::model::{DownloadTask, DownloadTaskStatus};
use anyhow::Result;

pub async fn save_task(task: DownloadTask) -> Result<DownloadTask> {
    DownloadTask::save(task).await
}

pub async fn get_task(id: &str) -> Result<DownloadTask> {
    DownloadTask::get(id).await
}

pub async fn list_tasks() -> Result<Vec<DownloadTask>> {
    let mut tasks = DownloadTask::list().await?;
    tasks.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(tasks)
}

pub async fn find_latest_active_task_for_url(url: &str) -> Result<Option<DownloadTask>> {
    let tasks = list_tasks().await?;
    Ok(tasks
        .into_iter()
        .find(|task| task.url == url && task.status.is_active()))
}

pub async fn mark_interrupted_tasks() -> Result<Vec<DownloadTask>> {
    let tasks = list_tasks().await?;
    let mut updated = Vec::new();

    for mut task in tasks {
        if !task.status.is_active() {
            continue;
        }

        task.status = DownloadTaskStatus::Interrupted;
        task.mark_interrupted();
        updated.push(save_task(task).await?);
    }

    Ok(updated)
}
