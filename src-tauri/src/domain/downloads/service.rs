use super::model::{
    CollectionSourceKind, DownloadLeaf, DownloadLeafStatus, DownloadTask, DownloadTaskStatus,
    DownloadTrigger, now_timestamp,
};
use super::repo;
use super::yt_dlp::{CliYtDlpClient, DownloadProgress, LeafProbe, RootProbe, YtDlpClient};
use crate::domain::meta::repo as meta_repo;
use crate::domain::playlists::model::{Collection, Music};
use crate::domain::playlists::repo as collection_repo;
use crate::utils::binaries::{ManagedBinary, ensure_managed_binary, managed_bin_dir};
use anyhow::{Context, Result, anyhow, bail};
use appdb::Id;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::AppHandle;
use tokio::task;

const AUTO_UPDATE_INTERVAL: Duration = Duration::from_secs(60 * 60 * 24);

static DOWNLOAD_RUNTIME: OnceLock<DownloadRuntime> = OnceLock::new();

pub struct DownloadRuntime {
    app: AppHandle,
    active_task_ids: Mutex<HashSet<String>>,
}

#[derive(Debug, Clone)]
struct CollectionSyncPlan {
    source_kind: CollectionSourceKind,
    collection_name: String,
    collection_url: String,
    collection_folder: String,
    enable_updates: Option<bool>,
    leaves: Vec<PlannedLeaf>,
}

#[derive(Debug, Clone)]
struct PlannedLeaf {
    id: Id,
    url: String,
    sequence: u32,
    initial_probe: Option<LeafProbe>,
}

pub fn initialize_runtime(app: AppHandle) {
    let runtime = DOWNLOAD_RUNTIME.get_or_init(|| DownloadRuntime {
        app: app.clone(),
        active_task_ids: Mutex::new(HashSet::new()),
    });

    spawn_recovery(runtime.app.clone());
    spawn_auto_update_loop(runtime.app.clone());
}

pub async fn enqueue_collection_download(url: String) -> Result<DownloadTask> {
    enqueue_collection_download_with_trigger(url, DownloadTrigger::Manual).await
}

pub async fn resume_download_task(task_id: String) -> Result<DownloadTask> {
    let task = repo::get_task(&task_id).await?;
    spawn_task(task.id.to_string())?;
    Ok(task)
}

pub async fn get_download_task(task_id: String) -> Result<DownloadTask> {
    repo::get_task(&task_id).await
}

pub async fn list_download_tasks() -> Result<Vec<DownloadTask>> {
    repo::list_tasks().await
}

async fn enqueue_collection_download_with_trigger(
    url: String,
    trigger: DownloadTrigger,
) -> Result<DownloadTask> {
    let normalized_url = normalize_url(&url)?;
    if let Some(existing) = repo::find_latest_active_task_for_url(&normalized_url).await? {
        return Ok(existing);
    }

    let task = repo::save_task(DownloadTask::new(
        task_id_for(&normalized_url, trigger),
        normalized_url,
        trigger,
    ))
    .await?;

    spawn_task(task.id.to_string())?;
    Ok(task)
}

fn spawn_task(task_id: String) -> Result<()> {
    let runtime = runtime()?;
    if !try_claim_task(&task_id)? {
        return Ok(());
    }

    let app = runtime.app.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_task(task_id.clone(), app).await;
        if let Err(error) = result {
            let _ = mark_task_failed(&task_id, error.to_string()).await;
        }
        release_task(&task_id);
    });

    Ok(())
}

async fn run_task(task_id: String, app: AppHandle) -> Result<()> {
    let mut task_snapshot = repo::get_task(&task_id).await?;
    update_task_status(&mut task_snapshot, DownloadTaskStatus::Resolving, None).await?;

    let client = build_client(&app)?;
    let save_root = resolve_save_root().await?;
    let plan = resolve_collection_plan(&task_snapshot, client.clone()).await?;
    let mut collection = collection_repo::get_collection_by_url(&plan.collection_url)
        .await?
        .unwrap_or_else(|| Collection {
            name: plan.collection_name.clone(),
            url: plan.collection_url.clone(),
            folder: plan.collection_folder.clone(),
            musics: vec![],
            last_updated: now_timestamp(),
            enable_updates: plan.enable_updates,
        });

    collection.name = plan.collection_name.clone();
    collection.url = plan.collection_url.clone();
    collection.folder = plan.collection_folder.clone();
    collection.enable_updates = collection.enable_updates.or(plan.enable_updates);
    task_snapshot.collection_url = Some(plan.collection_url.clone());
    task_snapshot.collection_name = Some(plan.collection_name.clone());
    task_snapshot.collection_folder = Some(plan.collection_folder.clone());
    task_snapshot.source_kind = Some(plan.source_kind);
    task_snapshot.leafs = plan
        .leaves
        .iter()
        .map(|leaf| DownloadLeaf::new(leaf.id.clone(), leaf.url.clone(), leaf.sequence))
        .collect();
    task_snapshot.refresh_counts();
    repo::save_task(task_snapshot.clone()).await?;

    if plan.leaves.is_empty() {
        collection.last_updated = now_timestamp();
        let _ = collection_repo::upsert_collection(&collection).await?;
        update_task_status(&mut task_snapshot, DownloadTaskStatus::Completed, None).await?;
        return Ok(());
    }

    let mut failure_count = 0_u32;
    for planned in &plan.leaves {
        let mut leaf_snapshot = task_snapshot
            .leafs
            .iter()
            .find(|leaf| leaf.id == planned.id)
            .cloned()
            .ok_or_else(|| anyhow!("download leaf `{}` disappeared from task snapshot", planned.id))?;
        leaf_snapshot.status = DownloadLeafStatus::Probing;
        leaf_snapshot.last_error = None;
        task_snapshot.status = DownloadTaskStatus::Downloading;
        task_snapshot.last_error = None;
        task_snapshot.replace_leaf(leaf_snapshot.clone());
        repo::save_task(task_snapshot.clone()).await?;

        let probe = match planned.initial_probe.clone() {
            Some(probe) => probe,
            None => {
                let client = client.clone();
                let url = planned.url.clone();
                run_blocking(move || client.probe_leaf(&url)).await?
            }
        };

        leaf_snapshot.title = Some(probe.title.clone());
        leaf_snapshot.duration_seconds = probe.duration_seconds;
        leaf_snapshot.chapter_count = Some(probe.chapters.len() as u32);
        leaf_snapshot.status = DownloadLeafStatus::Downloading;
        leaf_snapshot.touch();
        task_snapshot.replace_leaf(leaf_snapshot.clone());
        repo::save_task(task_snapshot.clone()).await?;

        let file_stem = sanitize_path_component(&probe.title);
        remove_existing_leaf_files(&collection, &probe.webpage_url, &save_root)?;
        let target_dir = save_root.join(&collection.folder);
        let leaf_url = planned.url.clone();
        let client = client.clone();
        let download_result = run_blocking(move || {
            let mut latest_progress = DownloadProgress::default();
            let downloaded = client.download_leaf_audio(&leaf_url, &target_dir, &file_stem, &mut |progress| {
                latest_progress = progress;
            })?;
            Ok::<_, anyhow::Error>((downloaded, latest_progress))
        })
        .await;

        let (downloaded, progress) = match download_result {
            Ok(result) => result,
            Err(error) => {
                failure_count += 1;
                leaf_snapshot.status = DownloadLeafStatus::Failed;
                leaf_snapshot.last_error = Some(error.to_string());
                leaf_snapshot.touch();
                task_snapshot.last_error = Some(error.to_string());
                task_snapshot.replace_leaf(leaf_snapshot);
                repo::save_task(task_snapshot.clone()).await?;

                if plan.source_kind == CollectionSourceKind::Single {
                    let last_error = task_snapshot.last_error.clone();
                    update_task_status(
                        &mut task_snapshot,
                        DownloadTaskStatus::Failed,
                        last_error,
                    )
                    .await?;
                    return Ok(());
                }
                continue;
            }
        };

        let file_name = downloaded
            .absolute_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(ToOwned::to_owned)
            .ok_or_else(|| anyhow!("downloaded audio path is missing a file name"))?;
        let mut materialized = materialize_music_entries(&probe, &file_name);
        if plan.source_kind == CollectionSourceKind::Single {
            collection.musics = materialized.clone();
        } else {
            collection.musics.retain(|music| music.url != probe.webpage_url);
            collection.musics.append(&mut materialized);
        }
        collection.last_updated = now_timestamp();
        let _ = collection_repo::upsert_collection(&collection).await?;

        leaf_snapshot.file_name = Some(file_name.clone());
        leaf_snapshot.relative_path = Some(file_name);
        leaf_snapshot.downloaded_bytes = progress.downloaded_bytes;
        leaf_snapshot.total_bytes = progress.total_bytes;
        leaf_snapshot.speed_bytes_per_second = progress.speed_bytes_per_second;
        leaf_snapshot.eta_seconds = progress.eta_seconds;
        leaf_snapshot.status = DownloadLeafStatus::Completed;
        leaf_snapshot.last_error = None;
        leaf_snapshot.touch();
        task_snapshot.replace_leaf(leaf_snapshot);
        repo::save_task(task_snapshot.clone()).await?;
    }

    let completed = task_snapshot.completed_leaves;
    let next_status = if failure_count == 0 {
        DownloadTaskStatus::Completed
    } else if completed > 0 {
        DownloadTaskStatus::CompletedWithErrors
    } else {
        DownloadTaskStatus::Failed
    };
    let last_error = task_snapshot.last_error.clone();
    update_task_status(&mut task_snapshot, next_status, last_error).await?;
    Ok(())
}

async fn resolve_collection_plan(
    task: &DownloadTask,
    client: Arc<dyn YtDlpClient>,
) -> Result<CollectionSyncPlan> {
    let root_probe = {
        let client = client.clone();
        let url = task.url.clone();
        run_blocking(move || client.probe_root(&url)).await?
    };

    match root_probe {
        RootProbe::Single(leaf) => {
            let collection_url = leaf.webpage_url.clone();
            let existing = collection_repo::get_collection_by_url(&collection_url).await?;
            Ok(CollectionSyncPlan {
                source_kind: CollectionSourceKind::Single,
                collection_name: leaf.title.clone(),
                collection_url: collection_url.clone(),
                collection_folder: resolve_collection_folder(
                    &collection_url,
                    &leaf.title,
                    existing.as_ref(),
                )
                .await?,
                enable_updates: None,
                leaves: vec![PlannedLeaf {
                    id: leaf_id_for(&task.id, &collection_url),
                    url: collection_url,
                    sequence: 0,
                    initial_probe: Some(leaf),
                }],
            })
        }
        RootProbe::List(list) => {
            let collection_url = list.webpage_url.clone();
            let existing = collection_repo::get_collection_by_url(&collection_url).await?;
            let existing_urls = existing_leaf_urls(existing.as_ref());
            let leaves = list
                .entries
                .into_iter()
                .filter(|leaf| !existing_urls.contains(&leaf.url))
                .map(|leaf| PlannedLeaf {
                    id: leaf_id_for(&task.id, &leaf.url),
                    url: leaf.url,
                    sequence: leaf.sequence,
                    initial_probe: None,
                })
                .collect::<Vec<_>>();

            Ok(CollectionSyncPlan {
                source_kind: CollectionSourceKind::List,
                collection_name: list.title.clone(),
                collection_url: collection_url.clone(),
                collection_folder: resolve_collection_folder(
                    &collection_url,
                    &list.title,
                    existing.as_ref(),
                )
                .await?,
                enable_updates: Some(existing.and_then(|collection| collection.enable_updates).unwrap_or(false)),
                leaves,
            })
        }
    }
}

async fn resolve_collection_folder(
    collection_url: &str,
    collection_name: &str,
    existing: Option<&Collection>,
) -> Result<String> {
    if let Some(existing) = existing {
        return Ok(existing.folder.clone());
    }

    let prefix = provider_segment(collection_url);
    let base_name = sanitize_path_component(collection_name);
    let mut candidate = PathBuf::from(&prefix);
    candidate.push(&base_name);

    let collections = collection_repo::list_collections().await?;
    let candidate_text = candidate.to_string_lossy().to_string();
    if collections
        .iter()
        .all(|collection| collection.folder != candidate_text || collection.url == collection_url)
    {
        return Ok(candidate_text);
    }

    let mut fallback = PathBuf::from(prefix);
    fallback.push(format!("{}__{}", base_name, short_hash(collection_url)));
    Ok(fallback.to_string_lossy().to_string())
}

async fn update_task_status(
    task: &mut DownloadTask,
    status: DownloadTaskStatus,
    last_error: Option<String>,
) -> Result<()> {
    task.status = status;
    task.last_error = last_error;
    task.touch();
    task.refresh_counts();
    let saved = repo::save_task(task.clone()).await?;
    *task = saved;
    Ok(())
}

async fn mark_task_failed(task_id: &str, error: String) -> Result<()> {
    let mut task = repo::get_task(task_id).await?;
    update_task_status(&mut task, DownloadTaskStatus::Failed, Some(error)).await
}

fn runtime() -> Result<&'static DownloadRuntime> {
    DOWNLOAD_RUNTIME
        .get()
        .context("download runtime has not been initialized")
}

fn try_claim_task(task_id: &str) -> Result<bool> {
    let runtime = runtime()?;
    let mut active = runtime
        .active_task_ids
        .lock()
        .map_err(|_| anyhow!("download runtime task set is poisoned"))?;
    Ok(active.insert(task_id.to_string()))
}

fn release_task(task_id: &str) {
    if let Some(runtime) = DOWNLOAD_RUNTIME.get()
        && let Ok(mut active) = runtime.active_task_ids.lock()
    {
        active.remove(task_id);
    }
}

fn spawn_recovery(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("download-recovery".to_string())
        .spawn(move || {
            tauri::async_runtime::block_on(async move {
                if let Err(error) = repo::mark_interrupted_tasks().await {
                    eprintln!("[downloads] failed to mark interrupted tasks: {error}");
                }

                if let Err(error) = run_auto_update_cycle().await {
                    eprintln!("[downloads] initial auto update failed: {error}");
                }
            });
            drop(app);
        });
}

fn spawn_auto_update_loop(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("download-auto-update".to_string())
        .spawn(move || loop {
            thread::sleep(AUTO_UPDATE_INTERVAL);
            tauri::async_runtime::block_on(async {
                if let Err(error) = run_auto_update_cycle().await {
                    eprintln!("[downloads] auto update failed: {error}");
                }
            });
            let _ = &app;
        });
}

async fn run_auto_update_cycle() -> Result<()> {
    for collection in collection_repo::list_auto_update_collections().await? {
        let _ = enqueue_collection_download_with_trigger(
            collection.url.clone(),
            DownloadTrigger::AutoUpdate,
        )
        .await?;
    }

    Ok(())
}

fn build_client(app: &AppHandle) -> Result<Arc<dyn YtDlpClient>> {
    let ytdlp_path =
        ensure_managed_binary(app, ManagedBinary::YtDlp).map_err(|error| anyhow!(error))?;
    let _ffmpeg_path =
        ensure_managed_binary(app, ManagedBinary::Ffmpeg).map_err(|error| anyhow!(error))?;
    let ffmpeg_dir = managed_bin_dir(app).map_err(|error| anyhow!(error))?;

    Ok(Arc::new(CliYtDlpClient::new(ytdlp_path, ffmpeg_dir)))
}

async fn resolve_save_root() -> Result<PathBuf> {
    let meta = meta_repo::get_meta_info()
        .await?
        .ok_or_else(|| anyhow!("save path is not configured"))?;
    let save_path = meta
        .save_path
        .ok_or_else(|| anyhow!("save path is not configured"))?;
    let root = PathBuf::from(save_path);
    std::fs::create_dir_all(&root)
        .with_context(|| format!("failed to create {}", root.display()))?;
    Ok(root)
}

async fn run_blocking<T>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T>
where
    T: Send + 'static,
{
    task::spawn_blocking(work)
        .await
        .context("blocking download task panicked")?
}

fn task_id_for(url: &str, trigger: DownloadTrigger) -> String {
    format!(
        "{}-{}",
        match trigger {
            DownloadTrigger::Manual => "manual",
            DownloadTrigger::AutoUpdate => "auto",
        },
        stable_id(&format!("{url}|{}", now_timestamp()))
    )
}

fn leaf_id_for(task_id: &Id, leaf_url: &str) -> Id {
    Id::from(stable_id(&format!("{}|{leaf_url}", task_id)))
}

fn stable_id(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hex::encode(hasher.finalize())
}

fn short_hash(seed: &str) -> String {
    stable_id(seed)[..8].to_string()
}

fn normalize_url(url: &str) -> Result<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        bail!("download url is empty");
    }

    Ok(trimmed.to_string())
}

pub(crate) fn sanitize_path_component(text: &str) -> String {
    let mut sanitized = text
        .trim()
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            ch if ch.is_control() => '-',
            _ => ch,
        })
        .collect::<String>();

    while sanitized.ends_with('.') || sanitized.ends_with(' ') {
        sanitized.pop();
    }

    if sanitized.is_empty() {
        "untitled".to_string()
    } else {
        sanitized
    }
}

pub(crate) fn provider_segment(url: &str) -> String {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return "downloads".to_string();
    };

    let Some(host) = parsed.host_str() else {
        return "downloads".to_string();
    };

    if host.ends_with("youtube.com") || host.eq_ignore_ascii_case("youtu.be") {
        return "youtube".to_string();
    }

    host.trim_start_matches("www.")
        .split('.')
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or("downloads")
        .to_string()
}

pub(crate) fn materialize_music_entries(probe: &LeafProbe, relative_path: &str) -> Vec<Music> {
    if probe.chapters.is_empty() {
        return vec![Music {
            name: probe.title.clone(),
            url: probe.webpage_url.clone(),
            path: Some(relative_path.to_string()),
            start: 0,
            end: probe.duration_seconds.unwrap_or(0),
        }];
    }

    probe
        .chapters
        .iter()
        .map(|chapter| Music {
            name: chapter.title.clone(),
            url: probe.webpage_url.clone(),
            path: Some(relative_path.to_string()),
            start: chapter.start_seconds,
            end: chapter.end_seconds,
        })
        .collect()
}

fn existing_leaf_urls(collection: Option<&Collection>) -> HashSet<String> {
    collection
        .map(|collection| {
            collection
                .musics
                .iter()
                .map(|music| music.url.clone())
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default()
}

fn remove_existing_leaf_files(collection: &Collection, leaf_url: &str, save_root: &Path) -> Result<()> {
    let mut seen_paths = BTreeSet::new();
    for music in &collection.musics {
        if music.url != leaf_url {
            continue;
        }

        let Some(relative_path) = &music.path else {
            continue;
        };
        if !seen_paths.insert(relative_path.clone()) {
            continue;
        }

        let absolute_path = save_root.join(&collection.folder).join(relative_path);
        if absolute_path.exists() {
            std::fs::remove_file(&absolute_path).with_context(|| {
                format!("failed to remove existing file {}", absolute_path.display())
            })?;
        }
    }

    Ok(())
}
