use super::model::DownloadTask;
use anyhow::Result;
use appdb::Crud;
use appdb::connection::get_db;
use appdb::error::{DBError, classify_db_error};
use appdb::model::meta::ModelMeta;
use std::time::Duration;
use surrealdb::types::{RecordId, Table};

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
    let db = get_db()?;
    let mut result = match db
        .query(
            "SELECT VALUE id FROM $table
             WHERE url = $url
               AND status IN ['queued', 'resolving', 'downloading', 'persisting']
             ORDER BY updated_at DESC
             LIMIT 1;",
        )
        .bind(("table", Table::from(DownloadTask::table_name())))
        .bind(("url", url.to_string()))
        .await
    {
        Ok(result) => match result.check() {
            Ok(result) => result,
            Err(error) => match DBError::from(error) {
                DBError::MissingTable(_) => return Ok(None),
                other => return Err(other.into()),
            },
        },
        Err(error) => match classify_db_error(&error.into()) {
            DBError::MissingTable(_) => return Ok(None),
            other => return Err(other.into()),
        },
    };

    let task_ids: Vec<RecordId> = result.take(0)?;
    match task_ids.into_iter().next() {
        Some(record) => Ok(Some(DownloadTask::get_record(record).await?)),
        None => Ok(None),
    }
}

#[cfg(test)]
pub async fn mark_interrupted_tasks() -> Result<Vec<DownloadTask>> {
    let tasks = list_tasks().await?;
    let mut updated = Vec::new();

    for mut task in tasks {
        if !task.status.is_active() {
            continue;
        }

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
