use super::model::{
    DownloadRootTitleEvidence, DownloadTask, EnqueuedCollectionDownload,
    PastedDownloadUrlResolution,
};
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub async fn enqueue_collection_download(
    url: String,
) -> Result<EnqueuedCollectionDownload, String> {
    super::service::enqueue_collection_download(url)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn resolve_pasted_download_url(
    url: String,
) -> Result<PastedDownloadUrlResolution, String> {
    super::service::resolve_pasted_download_url(url)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn probe_download_root_title(url: String) -> Result<DownloadRootTitleEvidence, String> {
    super::service::probe_download_root_title(url)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn resume_download_task(task_id: String) -> Result<DownloadTask, String> {
    super::service::resume_download_task(task_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn submit_youtube_cookies_and_resume_download_task(
    app: AppHandle,
    task_id: String,
    cookies: String,
) -> Result<DownloadTask, String> {
    let cookies_path = youtube_cookies_path(&app).map_err(|error| error.to_string())?;
    super::service::submit_youtube_cookies_and_resume_download_task(task_id, cookies, cookies_path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_download_task(task_id: String) -> Result<DownloadTask, String> {
    super::service::get_download_task(task_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn list_download_tasks() -> Result<Vec<DownloadTask>, String> {
    super::service::list_download_tasks()
        .await
        .map_err(|error| error.to_string())
}

fn youtube_cookies_path(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    let mut path = app
        .path()
        .app_local_data_dir()
        .map_err(|error| anyhow::anyhow!("failed to resolve app local data directory: {error}"))?;
    path.push("credentials");
    path.push("youtube.cookies.txt");
    Ok(path)
}
