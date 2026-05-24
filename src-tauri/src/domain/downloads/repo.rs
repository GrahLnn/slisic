use super::model::DownloadTask;
#[cfg(test)]
use super::model::DownloadTaskStatus;
use anyhow::Result;
use appdb::error::{DBError, classify_db_error};
use std::time::Duration;

const SAVE_TASK_RETRY_ATTEMPTS: usize = 6;

pub async fn save_task(task: DownloadTask) -> Result<DownloadTask> {
    let mut backoff = Duration::from_millis(5);
    for attempt in 0..SAVE_TASK_RETRY_ATTEMPTS {
        match DownloadTask::save(task.clone()).await {
            Ok(saved) => return Ok(saved),
            Err(error)
                if is_retryable_transaction_conflict(&error)
                    && attempt + 1 < SAVE_TASK_RETRY_ATTEMPTS =>
            {
                tokio::time::sleep(backoff).await;
                backoff = backoff.saturating_mul(2);
            }
            Err(error) => return Err(error.into()),
        }
    }

    unreachable!("save task retry loop should always return or error")
}

pub async fn get_task(id: &str) -> Result<DownloadTask> {
    DownloadTask::get(id).await
}

pub async fn list_tasks() -> Result<Vec<DownloadTask>> {
    match DownloadTask::list().await {
        Ok(mut tasks) => {
            tasks.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
            Ok(tasks)
        }
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => Ok(vec![]),
            other => Err(other.into()),
        },
    }
}

pub async fn find_latest_active_task_for_url(url: &str) -> Result<Option<DownloadTask>> {
    let tasks = list_tasks().await?;
    Ok(tasks
        .into_iter()
        .find(|task| task.url == url && task.status.is_active()))
}

#[cfg(test)]
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

pub(crate) fn is_retryable_transaction_conflict(error: &anyhow::Error) -> bool {
    let text = error.to_string();
    text.contains("Transaction conflict")
        || text.contains("write conflict")
        || text.contains("failed transaction")
}
