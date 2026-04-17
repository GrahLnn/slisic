use super::model::{
    CollectionSourceKind, DownloadLeaf, DownloadLeafStatus, DownloadResourceProbe, DownloadTask,
    DownloadTaskStatus, DownloadTrigger, now_timestamp,
};
use super::repo;
use super::yt_dlp::{
    CliYtDlpClient, DownloadProgress, LeafProbe, LeafReference, RootProbe, YtDlpClient,
    classify_root_preference,
};
use crate::domain::meta::repo as meta_repo;
use crate::domain::playlists::model::{Collection, Group, Music};
use crate::domain::playlists::repo as collection_repo;
use crate::utils::binaries::{ManagedBinary, ensure_managed_binary, managed_bin_dir};
use anyhow::{Context, Result, anyhow, bail};
use appdb::Id;
use reqwest::{Url, blocking::Client as BlockingHttpClient};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::task;

const AUTO_UPDATE_INTERVAL: Duration = Duration::from_secs(60 * 60 * 24);
const GROUP_DISCOVERY_USER_AGENT: &str =
    concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"));

static DOWNLOAD_RUNTIME: OnceLock<DownloadRuntime> = OnceLock::new();
static PENDING_ENQUEUE_URLS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

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
pub(crate) struct PlannedLeaf {
    pub(crate) id: Id,
    pub(crate) url: String,
    pub(crate) sequence: u32,
    pub(crate) initial_probe: Option<LeafProbe>,
    pub(crate) group_hint: Option<Group>,
}

#[derive(Debug, Clone)]
struct PendingLeafExpansion {
    entry: LeafReference,
    group_hint: Option<Group>,
    depth: u8,
}

#[derive(Debug, Default, Clone)]
struct GroupCatalog {
    groups: HashMap<String, Group>,
    ambiguous: HashSet<String>,
    discovery_attempted: bool,
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

pub async fn probe_download_resource(url: String) -> Result<DownloadResourceProbe> {
    let normalized_url = normalize_url(&url)?;
    let app = runtime()?.app.clone();
    let client = build_client(&app)?;
    let root_probe = {
        let client = client.clone();
        let probe_url = normalized_url.clone();
        run_blocking(move || client.probe_root(&probe_url)).await?
    };

    describe_download_resource(root_probe)
}

pub async fn resume_download_task(task_id: String) -> Result<DownloadTask> {
    let task = repo::get_task(&task_id).await?;
    if task.status == DownloadTaskStatus::Completed {
        bail!("completed download tasks cannot be resumed");
    }
    spawn_task(task.id.to_string())?;
    Ok(task)
}

pub async fn get_download_task(task_id: String) -> Result<DownloadTask> {
    repo::get_task(&task_id).await
}

pub async fn list_download_tasks() -> Result<Vec<DownloadTask>> {
    repo::list_tasks().await
}

pub(crate) fn describe_download_resource(root_probe: RootProbe) -> Result<DownloadResourceProbe> {
    match root_probe {
        RootProbe::Single(leaf) => Ok(DownloadResourceProbe {
            url: leaf.webpage_url,
            source_kind: CollectionSourceKind::Single,
            title: leaf.title,
            item_count: 1,
        }),
        RootProbe::List(list) => {
            if list.entries.is_empty() {
                bail!("download resource does not contain any downloadable entries");
            }

            Ok(DownloadResourceProbe {
                url: list.webpage_url,
                source_kind: CollectionSourceKind::List,
                title: list.title,
                item_count: list.entries.len() as u32,
            })
        }
    }
}

async fn enqueue_collection_download_with_trigger(
    url: String,
    trigger: DownloadTrigger,
) -> Result<DownloadTask> {
    let task = prepare_task_enqueue(url, trigger).await?;
    spawn_task(task.id.to_string())?;
    Ok(task)
}

/// Batch imports can enqueue many URLs in parallel, so duplicate suppression
/// must cover the repository read/save window instead of relying on a plain
/// "find active task, then insert" sequence.
pub(crate) async fn prepare_task_enqueue(
    url: String,
    trigger: DownloadTrigger,
) -> Result<DownloadTask> {
    let normalized_url = normalize_url(&url)?;

    loop {
        if let Some(existing) = repo::find_latest_active_task_for_url(&normalized_url).await? {
            return Ok(existing);
        }

        let Some(_claim) = try_claim_enqueue_url(&normalized_url)? else {
            task::yield_now().await;
            continue;
        };

        if let Some(existing) = repo::find_latest_active_task_for_url(&normalized_url).await? {
            return Ok(existing);
        }

        return repo::save_task(DownloadTask::new(
            task_id_for(&normalized_url, trigger),
            normalized_url,
            trigger,
        ))
        .await;
    }
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
    let save_root = resolve_save_root(&app).await?;
    let plan = resolve_collection_plan(&task_snapshot, client.clone(), &save_root).await?;
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
    collection.enable_updates = plan.enable_updates;
    let mut group_catalog = GroupCatalog::seed(&collection);
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
            .ok_or_else(|| {
                anyhow!(
                    "download leaf `{}` disappeared from task snapshot",
                    planned.id
                )
            })?;
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
                match run_blocking(move || client.probe_leaf(&url)).await {
                    Ok(probe) => probe,
                    Err(error) => {
                        failure_count += 1;
                        mark_leaf_failed(&mut task_snapshot, leaf_snapshot, error.to_string())
                            .await?;

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
                }
            }
        };

        leaf_snapshot.title = Some(probe.title.clone());
        leaf_snapshot.duration_seconds = probe.duration_seconds;
        leaf_snapshot.chapter_count = Some(probe.chapters.len() as u32);
        leaf_snapshot.status = DownloadLeafStatus::Downloading;
        leaf_snapshot.touch();
        task_snapshot.replace_leaf(leaf_snapshot.clone());
        repo::save_task(task_snapshot.clone()).await?;
        let group = match planned.group_hint.clone() {
            Some(group) => Some(group),
            None => {
                resolve_probe_group(
                    plan.source_kind,
                    &probe,
                    &task_snapshot.url,
                    client.clone(),
                    &mut group_catalog,
                )
                .await
            }
        };

        let file_stem = sanitize_path_component(&probe.title);
        let target_dir = save_root.join(&collection.folder);
        let leaf_url = planned.url.clone();
        let temp_file_stem = temporary_download_stem(&file_stem, &task_snapshot.id, &planned.id);
        let client = client.clone();
        let download_result = run_blocking(move || {
            let mut latest_progress = DownloadProgress::default();
            let downloaded = client.download_leaf_audio(
                &leaf_url,
                &target_dir,
                &temp_file_stem,
                &mut |progress| {
                    latest_progress = progress;
                },
            )?;
            Ok::<_, anyhow::Error>((downloaded, latest_progress))
        })
        .await;

        let (downloaded, progress) = match download_result {
            Ok(result) => result,
            Err(error) => {
                failure_count += 1;
                mark_leaf_failed(&mut task_snapshot, leaf_snapshot, error.to_string()).await?;

                if plan.source_kind == CollectionSourceKind::Single {
                    let last_error = task_snapshot.last_error.clone();
                    update_task_status(&mut task_snapshot, DownloadTaskStatus::Failed, last_error)
                        .await?;
                    return Ok(());
                }
                continue;
            }
        };

        let music_group = resolve_music_group(group, &collection);
        let file_name = finalize_downloaded_leaf(
            &collection,
            &probe.webpage_url,
            &music_group,
            &save_root,
            &file_stem,
            downloaded.absolute_path,
        )?;
        let mut materialized = materialize_music_entries(&probe, &file_name, music_group);
        if plan.source_kind == CollectionSourceKind::Single {
            collection.musics = materialized.clone();
        } else {
            collection
                .musics
                .retain(|music| music.url != probe.webpage_url);
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

async fn mark_leaf_failed(
    task_snapshot: &mut DownloadTask,
    mut leaf_snapshot: DownloadLeaf,
    error: String,
) -> Result<()> {
    leaf_snapshot.status = DownloadLeafStatus::Failed;
    leaf_snapshot.last_error = Some(error.clone());
    leaf_snapshot.touch();
    task_snapshot.last_error = Some(error);
    task_snapshot.replace_leaf(leaf_snapshot);
    repo::save_task(task_snapshot.clone()).await?;
    Ok(())
}

async fn resolve_collection_plan(
    task: &DownloadTask,
    client: Arc<dyn YtDlpClient>,
    save_root: &Path,
) -> Result<CollectionSyncPlan> {
    let root_preference = classify_root_preference(&task.url);
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
                    initial_probe: (!should_reprobe_single_leaf(root_preference)).then_some(leaf),
                    group_hint: None,
                }],
            })
        }
        RootProbe::List(list) => {
            let collection_url = list.webpage_url.clone();
            let existing = collection_repo::get_collection_by_url(&collection_url).await?;
            let existing_leafs = existing_leaf_urls(existing.as_ref(), save_root);
            let leaves =
                expand_root_entries_to_planned_leafs(&task.id, client.clone(), list.entries, None)
                    .await?
                    .into_iter()
                    .filter(|leaf| !existing_leafs.contains(&leaf.url))
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
                enable_updates: Some(
                    existing
                        .and_then(|collection| collection.enable_updates)
                        .unwrap_or(false),
                ),
                leaves,
            })
        }
    }
}

const MAX_NESTED_LIST_DEPTH: u8 = 4;

pub(crate) async fn expand_root_entries_to_planned_leafs(
    task_id: &Id,
    client: Arc<dyn YtDlpClient>,
    entries: Vec<LeafReference>,
    group_hint: Option<Group>,
) -> Result<Vec<PlannedLeaf>> {
    let mut pending = entries
        .into_iter()
        .rev()
        .map(|entry| PendingLeafExpansion {
            entry,
            group_hint: group_hint.clone(),
            depth: 0,
        })
        .collect::<Vec<_>>();
    let mut planned = Vec::new();

    while let Some(next) = pending.pop() {
        let preference = classify_root_preference(&next.entry.url);
        if preference == CollectionSourceKind::Single {
            planned.push(PlannedLeaf {
                id: leaf_id_for(task_id, &next.entry.url),
                url: next.entry.url,
                sequence: planned.len() as u32,
                initial_probe: None,
                group_hint: next.group_hint,
            });
            continue;
        }

        if next.depth >= MAX_NESTED_LIST_DEPTH {
            bail!(
                "nested playlists deeper than {} levels are not supported",
                MAX_NESTED_LIST_DEPTH
            );
        }

        let nested_url = next.entry.url.clone();
        let nested_probe = {
            let client = client.clone();
            let url = nested_url.clone();
            run_blocking(move || client.probe_root(&url)).await?
        };

        match nested_probe {
            RootProbe::Single(leaf) => {
                let leaf_url = leaf.webpage_url.clone();
                planned.push(PlannedLeaf {
                    id: leaf_id_for(task_id, &leaf_url),
                    url: leaf_url,
                    sequence: planned.len() as u32,
                    initial_probe: (!should_reprobe_single_leaf(preference)).then_some(leaf),
                    group_hint: next.group_hint,
                });
            }
            RootProbe::List(list) => {
                let nested_group = Some(Group {
                    name: list.title.clone(),
                    url: list.webpage_url.clone(),
                    folder: sanitize_path_component(&list.title),
                });

                for entry in list.entries.into_iter().rev() {
                    pending.push(PendingLeafExpansion {
                        entry,
                        group_hint: nested_group.clone(),
                        depth: next.depth + 1,
                    });
                }
            }
        }
    }

    Ok(planned)
}

fn temporary_download_stem(file_stem: &str, task_id: &Id, leaf_id: &Id) -> String {
    format!(
        "{file_stem}.__ransic_tmp__{}",
        short_hash(&format!("{task_id}|{leaf_id}"))
    )
}

fn finalize_downloaded_leaf(
    collection: &Collection,
    leaf_url: &str,
    group: &Group,
    save_root: &Path,
    file_stem: &str,
    downloaded_path: PathBuf,
) -> Result<String> {
    let extension = downloaded_path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let final_file_name = extension
        .map(|extension| format!("{file_stem}.{extension}"))
        .unwrap_or_else(|| file_stem.to_string());
    let relative_path = relative_music_path(collection, &final_file_name, group);
    let final_path = save_root.join(&collection.folder).join(&relative_path);

    remove_existing_leaf_files(collection, leaf_url, save_root)?;
    if final_path.exists() && final_path != downloaded_path {
        std::fs::remove_file(&final_path)
            .with_context(|| format!("failed to remove existing file {}", final_path.display()))?;
    }

    if downloaded_path != final_path {
        if let Some(parent) = final_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }

        std::fs::rename(&downloaded_path, &final_path).with_context(|| {
            format!(
                "failed to move downloaded audio from {} to {}",
                downloaded_path.display(),
                final_path.display()
            )
        })?;
    }

    Ok(relative_path)
}

async fn resolve_probe_group(
    source_kind: CollectionSourceKind,
    probe: &LeafProbe,
    source_url: &str,
    client: Arc<dyn YtDlpClient>,
    catalog: &mut GroupCatalog,
) -> Option<Group> {
    if source_kind != CollectionSourceKind::List {
        return None;
    }

    if let Some(group) = catalog.resolve(probe) {
        return Some(group);
    }

    if probe.album.is_none() || catalog.discovery_attempted {
        return None;
    }

    catalog.discovery_attempted = true;
    match discover_group_catalog(source_url.to_string(), client).await {
        Ok(groups) => catalog.extend(groups),
        Err(error) => {
            eprintln!("[downloads] group discovery failed: {error}");
        }
    }

    catalog.resolve(probe)
}

/// Group data is leaf-level enrichment: root collection shape stays flat, and
/// album metadata only adds a parent folder when a real playlist URL is known.
async fn discover_group_catalog(
    source_url: String,
    client: Arc<dyn YtDlpClient>,
) -> Result<Vec<Group>> {
    run_blocking(move || discover_group_catalog_blocking(&source_url, client)).await
}

fn discover_group_catalog_blocking(
    source_url: &str,
    client: Arc<dyn YtDlpClient>,
) -> Result<Vec<Group>> {
    let http = group_discovery_http_client()?;
    let mut groups = Vec::new();
    let mut errors = Vec::new();
    let mut seen_urls = BTreeSet::new();

    for candidate_url in group_discovery_source_urls(source_url) {
        match discover_groups_from_source(&http, &candidate_url, client.clone(), &mut seen_urls) {
            Ok(found) => groups.extend(found),
            Err(error) => errors.push(format!("{candidate_url}: {error}")),
        }
    }

    if !groups.is_empty() || errors.is_empty() {
        return Ok(groups);
    }

    bail!("{}", errors.join("; "))
}

fn discover_groups_from_source(
    http: &BlockingHttpClient,
    source_url: &str,
    client: Arc<dyn YtDlpClient>,
    seen_urls: &mut BTreeSet<String>,
) -> Result<Vec<Group>> {
    let html = http
        .get(source_url)
        .send()
        .and_then(|response| response.error_for_status())
        .context("failed to fetch source html")?
        .text()
        .context("failed to read source html")?;

    let mut groups = Vec::new();
    for playlist_id in extract_olak_playlist_ids(&html) {
        let playlist_url = format!("https://www.youtube.com/playlist?list={playlist_id}");
        if !seen_urls.insert(playlist_url.clone()) {
            continue;
        }

        let RootProbe::List(list) = client.probe_root(&playlist_url)? else {
            continue;
        };

        groups.push(Group {
            name: list.title.clone(),
            url: list.webpage_url.clone(),
            folder: sanitize_path_component(&list.title),
        });
    }

    Ok(groups)
}

fn group_discovery_http_client() -> Result<BlockingHttpClient> {
    BlockingHttpClient::builder()
        .user_agent(GROUP_DISCOVERY_USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .context("failed to build group discovery http client")
}

fn group_discovery_source_urls(source_url: &str) -> Vec<String> {
    let mut urls = vec![source_url.to_string()];
    if let Some(channel_url) = derive_youtube_channel_url_from_uploads_playlist(source_url)
        && !urls.contains(&channel_url)
    {
        urls.push(channel_url);
    }
    urls
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

fn pending_enqueue_urls() -> &'static Mutex<HashSet<String>> {
    PENDING_ENQUEUE_URLS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(crate) fn try_claim_enqueue_url(url: &str) -> Result<Option<PendingEnqueueUrlGuard>> {
    let mut active = pending_enqueue_urls()
        .lock()
        .map_err(|_| anyhow!("pending enqueue url set is poisoned"))?;
    if !active.insert(url.to_string()) {
        return Ok(None);
    }

    Ok(Some(PendingEnqueueUrlGuard {
        url: url.to_string(),
    }))
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
        .spawn(move || {
            loop {
                thread::sleep(AUTO_UPDATE_INTERVAL);
                tauri::async_runtime::block_on(async {
                    if let Err(error) = run_auto_update_cycle().await {
                        eprintln!("[downloads] auto update failed: {error}");
                    }
                });
                let _ = &app;
            }
        });
}

async fn run_auto_update_cycle() -> Result<()> {
    let mut errors = Vec::new();
    for collection in collection_repo::list_auto_update_collections().await? {
        if let Err(error) = enqueue_collection_download_with_trigger(
            collection.url.clone(),
            DownloadTrigger::AutoUpdate,
        )
        .await
        {
            errors.push(format!("{}: {error}", collection.url));
        }
    }

    if !errors.is_empty() {
        bail!(
            "auto update cycle completed with errors: {}",
            errors.join("; ")
        );
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

fn default_save_root(app: &AppHandle) -> Result<PathBuf> {
    let document_dir = app
        .path()
        .document_dir()
        .map_err(|error| anyhow!(error))?;

    Ok(document_dir.join(&app.package_info().name))
}

async fn resolve_save_root(app: &AppHandle) -> Result<PathBuf> {
    let default_root = default_save_root(app)?;
    let meta = meta_repo::ensure_meta_info(default_root.to_string_lossy().to_string()).await?;
    let save_path = meta
        .save_path
        .ok_or_else(|| anyhow!("save path should always be configured"))?;
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
    Id::from(stable_id(&format!("{task_id}|{leaf_url}")))
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

    if let Some(canonical) = normalize_youtube_direct_leaf_url(trimmed) {
        return Ok(canonical);
    }

    Ok(trimmed.to_string())
}

fn normalize_youtube_direct_leaf_url(url: &str) -> Option<String> {
    if !super::yt_dlp::looks_like_direct_leaf_url(url) {
        return None;
    }

    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();

    if host == "youtu.be" {
        let video_id = parsed.path_segments()?.next()?.trim();
        if video_id.is_empty() {
            return None;
        }
        return Some(format!("https://www.youtube.com/watch?v={video_id}"));
    }

    if !host.ends_with("youtube.com") {
        return None;
    }

    if let Some(video_id) = parsed
        .query_pairs()
        .find(|(key, value)| key == "v" && !value.is_empty())
        .map(|(_, value)| value.to_string())
    {
        return Some(format!("https://www.youtube.com/watch?v={video_id}"));
    }

    let mut segments = parsed.path_segments()?;
    let scope = segments.next()?;
    let video_id = segments.next()?.trim();
    if video_id.is_empty() {
        return None;
    }

    match scope {
        "shorts" | "live" => Some(format!("https://www.youtube.com/watch?v={video_id}")),
        _ => None,
    }
}

/// Root probing decides collection shape; full leaf metadata should only be
/// reused when the input was already classified as a direct leaf URL.
pub(crate) fn should_reprobe_single_leaf(preference: CollectionSourceKind) -> bool {
    preference != CollectionSourceKind::Single
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

pub(crate) fn materialize_music_entries(
    probe: &LeafProbe,
    relative_path: &str,
    group: Group,
) -> Vec<Music> {
    if probe.chapters.is_empty() {
        return vec![Music {
            name: probe.title.clone(),
            group,
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
            group: group.clone(),
            url: probe.webpage_url.clone(),
            path: Some(relative_path.to_string()),
            start: chapter.start_seconds,
            end: chapter.end_seconds,
        })
        .collect()
}

pub(crate) fn existing_leaf_urls(
    collection: Option<&Collection>,
    save_root: &Path,
) -> HashSet<String> {
    collection
        .map(|collection| {
            collection
                .musics
                .iter()
                .filter(|music| {
                    music
                        .path
                        .as_deref()
                        .map(|relative_path| {
                            save_root
                                .join(&collection.folder)
                                .join(relative_path)
                                .is_file()
                        })
                        .unwrap_or(false)
                })
                .map(|music| music.url.clone())
                .collect::<HashSet<String>>()
        })
        .unwrap_or_default()
}

fn relative_music_path(collection: &Collection, file_name: &str, group: &Group) -> String {
    if group.url == collection.url || group.folder == collection.folder {
        return file_name.to_string();
    }

    PathBuf::from(&group.folder)
        .join(file_name)
        .to_string_lossy()
        .to_string()
}

fn remove_existing_leaf_files(
    collection: &Collection,
    leaf_url: &str,
    save_root: &Path,
) -> Result<()> {
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

impl GroupCatalog {
    fn seed(collection: &Collection) -> Self {
        let mut catalog = Self::default();
        catalog.extend(collection.musics.iter().map(|music| music.group.clone()));
        catalog
    }

    fn extend(&mut self, groups: impl IntoIterator<Item = Group>) {
        for group in groups {
            let Some(key) = normalize_group_key(&group.name) else {
                continue;
            };

            if self.ambiguous.contains(&key) {
                continue;
            }

            match self.groups.get(&key) {
                None => {
                    self.groups.insert(key, group);
                }
                Some(existing) if existing.url == group.url => {}
                Some(_) => {
                    self.groups.remove(&key);
                    self.ambiguous.insert(key);
                }
            }
        }
    }

    fn resolve(&self, probe: &LeafProbe) -> Option<Group> {
        let key = normalize_group_key(probe.album.as_deref()?)?;
        self.groups.get(&key).cloned()
    }
}

fn resolve_music_group(group: Option<Group>, collection: &Collection) -> Group {
    group.unwrap_or_else(|| Group {
        name: collection.name.clone(),
        url: collection.url.clone(),
        folder: collection.folder.clone(),
    })
}

fn normalize_group_key(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.to_lowercase())
    }
}

pub(crate) fn derive_youtube_channel_url_from_uploads_playlist(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if !host.ends_with("youtube.com") {
        return None;
    }

    let list_id = parsed
        .query_pairs()
        .find(|(key, value)| key == "list" && value.starts_with("UU"))
        .map(|(_, value)| value.to_string())?;
    Some(format!(
        "https://www.youtube.com/channel/UC{}",
        &list_id[2..]
    ))
}

pub(crate) fn extract_olak_playlist_ids(html: &str) -> BTreeSet<String> {
    const PREFIX: &[u8] = b"OLAK5uy_";

    let bytes = html.as_bytes();
    let mut ids = BTreeSet::new();
    let mut index = 0_usize;
    while index + PREFIX.len() <= bytes.len() {
        if &bytes[index..index + PREFIX.len()] != PREFIX {
            index += 1;
            continue;
        }

        let mut end = index + PREFIX.len();
        while end < bytes.len() {
            let byte = bytes[end];
            if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' {
                end += 1;
            } else {
                break;
            }
        }

        ids.insert(html[index..end].to_string());
        index = end;
    }

    ids
}

pub(crate) struct PendingEnqueueUrlGuard {
    url: String,
}

impl Drop for PendingEnqueueUrlGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = pending_enqueue_urls().lock() {
            active.remove(&self.url);
        }
    }
}
