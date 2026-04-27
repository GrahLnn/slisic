use super::model::{
    CollectionSourceKind, DownloadLeaf, DownloadLeafStatus, DownloadResourceProbe, DownloadTask,
    DownloadTaskStatus, DownloadTrigger, EnqueuedCollectionDownload, PastedDownloadUrlResolution,
    now_timestamp,
};
use super::naming::{sanitize_path_component, short_hash, stable_id};
use super::repo;
#[cfg(not(test))]
use super::yt_dlp::CliYtDlpClient;
use super::yt_dlp::{
    DownloadProgress, LeafProbe, LeafReference, RootProbe, YtDlpClient, classify_root_preference,
};
use crate::domain::collection_import::{self, CollectionSyncPlan, PlannedLeaf};
#[cfg(not(test))]
use crate::domain::meta::service as meta_service;
use crate::domain::playlists::model::{Collection, Group};
#[cfg(not(test))]
use crate::utils::binaries::{ManagedBinary, ensure_managed_binary, managed_bin_dir};
use anyhow::{Context, Result, anyhow, bail};
use appdb::Id;
use reqwest::{Url, blocking::Client as BlockingHttpClient};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(not(test))]
use std::thread;
use std::time::Duration;
#[cfg(not(test))]
use tauri::AppHandle;
#[cfg(not(test))]
use tokio::sync::broadcast;
use tokio::task;
#[cfg(not(test))]
use tokio::task::JoinSet;

#[cfg(not(test))]
const AUTO_UPDATE_INTERVAL: Duration = Duration::from_secs(60 * 60 * 24);
const MAX_PARALLEL_LEAF_DOWNLOADS: usize = 4;
const GROUP_DISCOVERY_USER_AGENT: &str =
    concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"));

#[cfg(not(test))]
static DOWNLOAD_RUNTIME: OnceLock<DownloadRuntime> = OnceLock::new();
#[cfg(not(test))]
static DOWNLOAD_TASK_CHANGES: OnceLock<broadcast::Sender<DownloadTaskChangeSignal>> =
    OnceLock::new();
static PENDING_ENQUEUE_URLS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[cfg(not(test))]
pub struct DownloadRuntime {
    app: AppHandle,
    active_task_ids: Mutex<HashSet<String>>,
}

#[derive(Debug, Clone)]
pub(crate) enum PreparedTaskEnqueue {
    Existing(DownloadTask),
    New(DownloadTask),
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

#[derive(Clone)]
struct DownloadExecutionDeps {
    client: Arc<dyn YtDlpClient>,
    save_root: PathBuf,
}

#[cfg(not(test))]
struct LeafDownloadInput {
    leaf: DownloadLeaf,
    probe: LeafProbe,
    group: Option<Group>,
    url: String,
    target_dir: PathBuf,
    temp_file_stem: String,
}

#[cfg(not(test))]
struct CompletedLeafDownload {
    leaf: DownloadLeaf,
    probe: LeafProbe,
    group: Option<Group>,
    downloaded: super::yt_dlp::DownloadedLeaf,
    progress: DownloadProgress,
}

#[cfg(not(test))]
struct FailedLeafDownload {
    leaf: DownloadLeaf,
    error: String,
}

#[cfg(not(test))]
type LeafDownloadOutcome = std::result::Result<CompletedLeafDownload, FailedLeafDownload>;

#[cfg(not(test))]
#[derive(Debug, Clone)]
pub(crate) struct DownloadTaskChangeSignal {
    pub(crate) task_id: String,
    pub(crate) task_url: String,
    pub(crate) collection_url: Option<String>,
}

#[cfg(not(test))]
pub fn initialize_runtime(app: AppHandle) {
    let runtime = DOWNLOAD_RUNTIME.get_or_init(|| DownloadRuntime {
        app: app.clone(),
        active_task_ids: Mutex::new(HashSet::new()),
    });

    spawn_recovery(runtime.app.clone());
    spawn_auto_update_loop(runtime.app.clone());
}

#[cfg(not(test))]
pub(crate) fn subscribe_download_task_changes() -> broadcast::Receiver<DownloadTaskChangeSignal> {
    download_task_change_sender().subscribe()
}

#[cfg(not(test))]
pub async fn enqueue_collection_download(url: String) -> Result<EnqueuedCollectionDownload> {
    enqueue_collection_download_with_trigger(url, DownloadTrigger::Manual).await
}

#[cfg(not(test))]
pub async fn probe_download_resource(url: String) -> Result<DownloadResourceProbe> {
    let normalized_url = normalize_url(&url)?;
    let app = runtime()?.app.clone();
    let deps = resolve_execution_deps(&app).await?;
    let root_probe = {
        let client = deps.client.clone();
        let probe_url = normalized_url.clone();
        run_blocking(move || client.probe_root(&probe_url)).await?
    };

    collection_import::describe_download_resource(root_probe).await
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

pub async fn resolve_pasted_download_url(url: String) -> Result<PastedDownloadUrlResolution> {
    let parsed_url = match parse_download_url(&url) {
        Ok(parsed_url) => parsed_url,
        Err(error) => return Ok(PastedDownloadUrlResolution::invalid_url(error)),
    };
    let normalized_url = normalize_url(&parsed_url)?;

    collection_import::resolve_pasted_download_url(normalized_url).await
}

#[cfg(not(test))]
async fn enqueue_collection_download_with_trigger(
    url: String,
    trigger: DownloadTrigger,
) -> Result<EnqueuedCollectionDownload> {
    let prepared = prepare_task_enqueue_outcome(url, trigger).await?;

    let (task, collection) = match prepared {
        PreparedTaskEnqueue::Existing(task) => {
            let app = runtime()?.app.clone();
            match collection_import::resolve_existing_enqueued_collection(&task).await {
                Ok(collection) => (task, collection),
                Err(_) => bootstrap_enqueued_collection(task, app).await?,
            }
        }
        PreparedTaskEnqueue::New(task) => {
            let app = runtime()?.app.clone();
            bootstrap_enqueued_collection(task, app).await?
        }
    };

    if !task.status.is_terminal() {
        spawn_task(task.id.to_string())?;
    }

    Ok(EnqueuedCollectionDownload { task, collection })
}

#[cfg(not(test))]
pub(crate) async fn enqueue_collection_download_for_test(
    url: String,
    client: Arc<dyn YtDlpClient>,
    save_root: PathBuf,
) -> Result<EnqueuedCollectionDownload> {
    // This helper is reserved for manual chain verification outside `cargo test`.
    // Domain tests should follow the appdb pattern with fake dependencies and
    // temporary appdb state instead of pulling Tauri-hosted execution paths into
    // the Rust test harness.
    let deps = DownloadExecutionDeps { client, save_root };
    let prepared = prepare_task_enqueue_outcome(url, DownloadTrigger::Manual).await?;

    let (mut task, mut collection) = match prepared {
        PreparedTaskEnqueue::Existing(task) => {
            match collection_import::resolve_existing_enqueued_collection(&task).await {
                Ok(collection) => (task, collection),
                Err(_) => bootstrap_enqueued_collection_with_deps(task, deps.clone()).await?,
            }
        }
        PreparedTaskEnqueue::New(task) => {
            bootstrap_enqueued_collection_with_deps(task, deps.clone()).await?
        }
    };

    if !task.status.is_terminal() {
        run_task_with_deps(task.id.to_string(), deps).await?;
        task = repo::get_task(&task.id.to_string()).await?;
        if let Some(collection_url) = task.collection_url.as_deref()
            && let Some(updated) = collection_import::get_collection_by_url(collection_url).await?
        {
            collection = updated;
        }
    }

    Ok(EnqueuedCollectionDownload { task, collection })
}

/// Batch imports can enqueue many URLs in parallel, so duplicate suppression
/// must cover the repository read/save window instead of relying on a plain
/// "find active task, then insert" sequence.
pub(crate) async fn prepare_task_enqueue(
    url: String,
    trigger: DownloadTrigger,
) -> Result<DownloadTask> {
    Ok(match prepare_task_enqueue_outcome(url, trigger).await? {
        PreparedTaskEnqueue::Existing(task) | PreparedTaskEnqueue::New(task) => task,
    })
}

async fn prepare_task_enqueue_outcome(
    url: String,
    trigger: DownloadTrigger,
) -> Result<PreparedTaskEnqueue> {
    let normalized_url = normalize_url(&url)?;

    loop {
        if let Some(existing) = repo::find_latest_active_task_for_url(&normalized_url).await? {
            return Ok(PreparedTaskEnqueue::Existing(existing));
        }

        let Some(_claim) = try_claim_enqueue_url(&normalized_url)? else {
            task::yield_now().await;
            continue;
        };

        if let Some(existing) = repo::find_latest_active_task_for_url(&normalized_url).await? {
            return Ok(PreparedTaskEnqueue::Existing(existing));
        }

        return repo::save_task(DownloadTask::new(
            task_id_for(&normalized_url, trigger),
            normalized_url,
            trigger,
        ))
        .await
        .map(PreparedTaskEnqueue::New);
    }
}

#[cfg(not(test))]
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

#[cfg(test)]
fn spawn_task(_task_id: String) -> Result<()> {
    Ok(())
}

#[cfg(not(test))]
async fn bootstrap_enqueued_collection(
    task: DownloadTask,
    app: AppHandle,
) -> Result<(DownloadTask, Collection)> {
    let deps = resolve_execution_deps(&app).await?;
    bootstrap_enqueued_collection_with_deps(task, deps).await
}

#[cfg(not(test))]
async fn bootstrap_enqueued_collection_with_deps(
    task: DownloadTask,
    deps: DownloadExecutionDeps,
) -> Result<(DownloadTask, Collection)> {
    let plan = resolve_collection_plan(&task, deps.client, &deps.save_root).await?;
    collection_import::persist_enqueued_collection_state(task, &plan).await
}

#[cfg(not(test))]
async fn run_task(task_id: String, app: AppHandle) -> Result<()> {
    let deps = resolve_execution_deps(&app).await?;
    run_task_with_deps(task_id, deps).await
}

#[cfg(not(test))]
async fn run_task_with_deps(task_id: String, deps: DownloadExecutionDeps) -> Result<()> {
    let mut task_snapshot = repo::get_task(&task_id).await?;
    update_task_status(&mut task_snapshot, DownloadTaskStatus::Resolving, None).await?;

    let client = deps.client;
    let save_root = deps.save_root;
    let plan = resolve_collection_plan(&task_snapshot, client.clone(), &save_root).await?;
    let mut collection = collection_import::load_collection_shell(&plan).await?;
    let mut group_catalog = GroupCatalog::seed(&collection);
    collection_import::apply_collection_plan_to_task(&mut task_snapshot, &plan);
    repo::save_task(task_snapshot.clone()).await?;

    if plan.leaves.is_empty() {
        collection_import::persist_empty_collection(&mut collection).await?;
        update_task_status(&mut task_snapshot, DownloadTaskStatus::Completed, None).await?;
        return Ok(());
    }

    let mut active_downloads = JoinSet::new();
    let parallelism = leaf_download_parallelism(plan.source_kind, plan.leaves.len());
    for planned in &plan.leaves {
        while active_downloads.len() >= parallelism {
            handle_finished_leaf_download(
                &mut active_downloads,
                &mut task_snapshot,
                &mut collection,
                plan.source_kind,
                &save_root,
            )
            .await?;
        }

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

        leaf_snapshot.title = Some(probe.title.clone());
        leaf_snapshot.duration_seconds = probe.duration_seconds;
        leaf_snapshot.chapter_count = Some(probe.chapters.len() as u32);
        leaf_snapshot.status = DownloadLeafStatus::Downloading;
        leaf_snapshot.touch();
        task_snapshot.replace_leaf(leaf_snapshot.clone());
        repo::save_task(task_snapshot.clone()).await?;

        let file_stem = sanitize_path_component(&probe.title);
        let target_dir = save_root.join(&collection.folder);
        let leaf_url = planned.url.clone();
        let temp_file_stem = temporary_download_stem(&file_stem, &task_snapshot.id, &planned.id);
        let client = client.clone();
        active_downloads.spawn(download_leaf_audio_worker(
            client,
            LeafDownloadInput {
                leaf: leaf_snapshot,
                probe,
                group,
                url: leaf_url,
                target_dir,
                temp_file_stem,
            },
        ));
    }

    while !active_downloads.is_empty() {
        handle_finished_leaf_download(
            &mut active_downloads,
            &mut task_snapshot,
            &mut collection,
            plan.source_kind,
            &save_root,
        )
        .await?;
    }

    let completed = task_snapshot.completed_leaves;
    let next_status = if task_snapshot.failed_leaves == 0 {
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

#[cfg(not(test))]
async fn download_leaf_audio_worker(
    client: Arc<dyn YtDlpClient>,
    input: LeafDownloadInput,
) -> LeafDownloadOutcome {
    let url = input.url.clone();
    let target_dir = input.target_dir.clone();
    let temp_file_stem = input.temp_file_stem.clone();
    let download_result = run_blocking(move || {
        let mut latest_progress = DownloadProgress::default();
        let downloaded =
            client.download_leaf_audio(&url, &target_dir, &temp_file_stem, &mut |progress| {
                latest_progress = progress;
            })?;
        Ok::<_, anyhow::Error>((downloaded, latest_progress))
    })
    .await;

    match download_result {
        Ok((downloaded, progress)) => Ok(CompletedLeafDownload {
            leaf: input.leaf,
            probe: input.probe,
            group: input.group,
            downloaded,
            progress,
        }),
        Err(error) => Err(FailedLeafDownload {
            leaf: input.leaf,
            error: error.to_string(),
        }),
    }
}

#[cfg(not(test))]
async fn handle_finished_leaf_download(
    active_downloads: &mut JoinSet<LeafDownloadOutcome>,
    task_snapshot: &mut DownloadTask,
    collection: &mut Collection,
    source_kind: CollectionSourceKind,
    save_root: &Path,
) -> Result<()> {
    let outcome = active_downloads
        .join_next()
        .await
        .context("download worker set was unexpectedly empty")?
        .context("download worker panicked")?;

    let completed = match outcome {
        Ok(completed) => completed,
        Err(failed) => {
            mark_leaf_failed(task_snapshot, failed.leaf, failed.error).await?;

            if source_kind == CollectionSourceKind::Single {
                let last_error = task_snapshot.last_error.clone();
                update_task_status(task_snapshot, DownloadTaskStatus::Failed, last_error).await?;
            }
            return Ok(());
        }
    };

    let mut leaf_snapshot = completed.leaf;
    let file_stem = sanitize_path_component(&completed.probe.title);
    let music_group = resolve_music_group(completed.group, collection);
    let file_name = collection_import::finalize_downloaded_leaf(
        collection,
        &completed.probe.webpage_url,
        &music_group,
        save_root,
        &file_stem,
        completed.downloaded.absolute_path,
    )?;
    collection_import::persist_downloaded_leaf_music(
        collection,
        source_kind,
        &completed.probe,
        &file_name,
        music_group,
    )
    .await?;

    leaf_snapshot.file_name = Some(file_name.clone());
    leaf_snapshot.relative_path = Some(file_name);
    leaf_snapshot.downloaded_bytes = completed.progress.downloaded_bytes;
    leaf_snapshot.total_bytes = completed.progress.total_bytes;
    leaf_snapshot.speed_bytes_per_second = completed.progress.speed_bytes_per_second;
    leaf_snapshot.eta_seconds = completed.progress.eta_seconds;
    leaf_snapshot.status = DownloadLeafStatus::Completed;
    leaf_snapshot.last_error = None;
    leaf_snapshot.touch();
    task_snapshot.replace_leaf(leaf_snapshot);
    let saved = repo::save_task(task_snapshot.clone()).await?;
    publish_download_task_change(&saved);
    *task_snapshot = saved;
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
    let saved = repo::save_task(task_snapshot.clone()).await?;
    publish_download_task_change(&saved);
    *task_snapshot = saved;
    Ok(())
}

#[cfg(not(test))]
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
            let existing = collection_import::get_collection_by_url(&collection_url).await?;
            Ok(CollectionSyncPlan {
                source_kind: CollectionSourceKind::Single,
                collection_name: leaf.title.clone(),
                collection_url: collection_url.clone(),
                collection_folder: collection_import::resolve_collection_folder(
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
            let existing = collection_import::get_collection_by_url(&collection_url).await?;
            let existing_leafs =
                collection_import::existing_leaf_urls(existing.as_ref(), save_root);
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
                collection_folder: collection_import::resolve_collection_folder(
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

#[cfg(not(test))]
fn temporary_download_stem(file_stem: &str, task_id: &Id, leaf_id: &Id) -> String {
    format!(
        "{file_stem}.__ransic_tmp__{}",
        short_hash(&format!("{task_id}|{leaf_id}"))
    )
}

#[cfg(not(test))]
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
#[cfg(not(test))]
async fn discover_group_catalog(
    source_url: String,
    client: Arc<dyn YtDlpClient>,
) -> Result<Vec<Group>> {
    run_blocking(move || discover_group_catalog_blocking(&source_url, client)).await
}

#[cfg(not(test))]
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

#[cfg(not(test))]
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
    if saved.status.is_terminal() {
        publish_download_task_change(&saved);
    }
    *task = saved;
    Ok(())
}

async fn mark_task_failed(task_id: &str, error: String) -> Result<()> {
    let mut task = repo::get_task(task_id).await?;
    update_task_status(&mut task, DownloadTaskStatus::Failed, Some(error)).await
}

#[cfg(not(test))]
fn runtime() -> Result<&'static DownloadRuntime> {
    DOWNLOAD_RUNTIME
        .get()
        .context("download runtime has not been initialized")
}

#[cfg(not(test))]
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

#[cfg(not(test))]
fn release_task(task_id: &str) {
    if let Some(runtime) = DOWNLOAD_RUNTIME.get()
        && let Ok(mut active) = runtime.active_task_ids.lock()
    {
        active.remove(task_id);
    }
}

#[cfg(not(test))]
fn download_task_change_sender() -> &'static broadcast::Sender<DownloadTaskChangeSignal> {
    DOWNLOAD_TASK_CHANGES.get_or_init(|| broadcast::channel(64).0)
}

#[cfg(not(test))]
fn publish_download_task_change(task: &DownloadTask) {
    let _ = download_task_change_sender().send(DownloadTaskChangeSignal {
        task_id: task.id.to_string(),
        task_url: task.url.clone(),
        collection_url: task.collection_url.clone(),
    });
}

#[cfg(test)]
fn publish_download_task_change(_task: &DownloadTask) {}

#[cfg(not(test))]
fn spawn_recovery(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("download-recovery".to_string())
        .spawn(move || {
            tauri::async_runtime::block_on(async move {
                match recover_incomplete_download_tasks().await {
                    Ok(recovered) if recovered > 0 => {
                        eprintln!("[downloads] resumed {recovered} incomplete download tasks");
                    }
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("[downloads] failed to resume incomplete download tasks: {error}");
                    }
                }

                match resolve_save_root(&app).await {
                    Ok(save_root) => match collection_import::repair_stale_single_source_collections(&save_root).await {
                        Ok(repaired) if repaired > 0 => {
                            eprintln!(
                                "[downloads] repaired {repaired} stale single-source collections"
                            );
                        }
                        Ok(_) => {}
                        Err(error) => {
                            eprintln!(
                                "[downloads] failed to repair stale single-source collections: {error}"
                            );
                        }
                    },
                    Err(error) => {
                        eprintln!("[downloads] failed to resolve save root during recovery: {error}");
                    }
                }

                if let Err(error) = run_auto_update_cycle().await {
                    eprintln!("[downloads] initial auto update failed: {error}");
                }
            });
        });
}

#[cfg(not(test))]
async fn recover_incomplete_download_tasks() -> Result<usize> {
    let tasks = repo::list_tasks().await?;
    let mut recovered = 0_usize;

    for mut task in tasks {
        if !should_resume_download_task_after_restart(task.status) {
            continue;
        }

        if task.status == DownloadTaskStatus::Interrupted {
            let last_error = task.last_error.clone();
            update_task_status(&mut task, DownloadTaskStatus::Queued, last_error).await?;
        }

        spawn_task(task.id.to_string())?;
        recovered += 1;
    }

    Ok(recovered)
}

#[cfg(not(test))]
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

#[cfg(not(test))]
async fn run_auto_update_cycle() -> Result<()> {
    let mut errors = Vec::new();
    for collection_url in collection_import::list_auto_update_collection_urls().await? {
        if let Err(error) = enqueue_collection_download_with_trigger(
            collection_url.clone(),
            DownloadTrigger::AutoUpdate,
        )
        .await
        {
            errors.push(format!("{collection_url}: {error}"));
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

#[cfg(not(test))]
fn build_client(app: &AppHandle) -> Result<Arc<dyn YtDlpClient>> {
    let ytdlp_path =
        ensure_managed_binary(app, ManagedBinary::YtDlp).map_err(|error| anyhow!(error))?;
    let _ffmpeg_path =
        ensure_managed_binary(app, ManagedBinary::Ffmpeg).map_err(|error| anyhow!(error))?;
    let ffmpeg_dir = managed_bin_dir(app).map_err(|error| anyhow!(error))?;

    Ok(Arc::new(CliYtDlpClient::new(ytdlp_path, ffmpeg_dir)))
}

#[cfg(not(test))]
async fn resolve_save_root(app: &AppHandle) -> Result<PathBuf> {
    meta_service::resolve_save_root(app).await
}

#[cfg(not(test))]
async fn resolve_execution_deps(app: &AppHandle) -> Result<DownloadExecutionDeps> {
    Ok(DownloadExecutionDeps {
        client: build_client(app)?,
        save_root: resolve_save_root(app).await?,
    })
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

fn parse_download_url(text: &str) -> std::result::Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Clipboard does not contain a URL.".to_string());
    }

    let parsed =
        Url::parse(trimmed).map_err(|_| "Clipboard does not contain a valid URL.".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(trimmed.to_string()),
        _ => Err("Only http and https URLs can be downloaded.".to_string()),
    }
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

pub(crate) fn leaf_download_parallelism(
    source_kind: CollectionSourceKind,
    leaf_count: usize,
) -> usize {
    if leaf_count == 0 || source_kind == CollectionSourceKind::Single {
        return leaf_count.min(1);
    }

    leaf_count.min(MAX_PARALLEL_LEAF_DOWNLOADS)
}

pub(crate) fn should_resume_download_task_after_restart(status: DownloadTaskStatus) -> bool {
    status.is_active() || status == DownloadTaskStatus::Interrupted
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
