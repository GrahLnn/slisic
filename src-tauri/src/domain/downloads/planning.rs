// Download planning owns the semantic morphisms before any download worker runs.
//
// The important boundary is that URL shape, provider evidence, residual task
// evidence, and collection plans compose into one stable plan. A failed morphism
// is a download failure, not permission to invent a collection identity.

use super::model::{
    CollectionSourceKind, DownloadLeaf, DownloadLeafGroupContext, DownloadTask, DownloadTrigger,
    now_timestamp,
};
use super::naming::{sanitize_path_component, stable_id};
use super::yt_dlp::RootShellProbe;
use super::yt_dlp::{
    LeafProbe, LeafReference, RootProbe, YtDlpClient, classify_root_preference,
    is_youtube_mix_playlist_id,
};
use crate::domain::collection_import::{self, CollectionSyncPlan, PlannedLeaf};
use crate::domain::playlists::model::{Collection, Group};
#[cfg(not(test))]
use crate::utils::binaries::{ManagedBinary, acquire_managed_binary_usage};
use anyhow::{Context, Result, bail};
use appdb::Id;
use reqwest::Url;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tokio::sync::Semaphore;
use tokio::task;

const MAX_CONCURRENT_ROOT_PROBES: usize = 2;
const MAX_CONCURRENT_ROOT_SHELL_PROBES: usize = 4;
const MAX_NESTED_LIST_DEPTH: u8 = 4;

static ROOT_PROBE_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
static ROOT_SHELL_PROBE_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[derive(Debug, Clone)]
pub(crate) enum RootShellProbeTraceEvent {
    WaitStart,
    SlotAcquired { elapsed_ms: u128 },
    Done { elapsed_ms: u128 },
    Error { elapsed_ms: u128, error: String },
}

pub(crate) type RootShellProbeTraceSink = Arc<dyn Fn(RootShellProbeTraceEvent) + Send + Sync>;

pub(crate) async fn resolve_collection_plan(
    task: &DownloadTask,
    client: Arc<dyn YtDlpClient>,
) -> Result<CollectionSyncPlan> {
    if let Some(plan) = residual_collection_plan(task) {
        return Ok(plan);
    }

    let root_probe = probe_root_with_limit(client.clone(), task.url.clone()).await?;
    resolve_collection_plan_from_root_probe(task, client, root_probe).await
}

pub(crate) async fn resolve_collection_plan_with_root_probe(
    task: &DownloadTask,
    client: Arc<dyn YtDlpClient>,
    root_probe: Option<RootProbe>,
) -> Result<CollectionSyncPlan> {
    if let Some(plan) = residual_collection_plan(task) {
        return Ok(plan);
    }

    let root_probe = match root_probe {
        Some(root_probe) => root_probe,
        None => probe_root_with_limit(client.clone(), task.url.clone()).await?,
    };
    resolve_collection_plan_from_root_probe(task, client, root_probe).await
}

async fn resolve_collection_plan_from_root_probe(
    task: &DownloadTask,
    client: Arc<dyn YtDlpClient>,
    root_probe: RootProbe,
) -> Result<CollectionSyncPlan> {
    let root_preference = classify_root_preference(&task.url);
    match root_probe {
        RootProbe::Single(leaf) => {
            let collection_url = leaf.webpage_url.clone();
            let existing = resolve_existing_collection_for_download_identity(
                &collection_url,
                &leaf.title,
                CollectionSourceKind::Single,
            )
            .await?;
            let collection_url = existing
                .as_ref()
                .map(|collection| collection.url.clone())
                .unwrap_or(collection_url);
            Ok(CollectionSyncPlan {
                source_kind: CollectionSourceKind::Single,
                collection_name: leaf.title.clone(),
                collection_url: collection_url.clone(),
                collection_folder: resolve_task_collection_folder(
                    task,
                    &collection_url,
                    &leaf.title,
                    existing.as_ref(),
                )
                .await?,
                enable_updates: None,
                leaves: vec![PlannedLeaf {
                    id: leaf_id_for(&task.id, &collection_url, None),
                    url: collection_url,
                    sequence: 0,
                    initial_probe: (!should_reprobe_single_leaf(root_preference)).then_some(leaf),
                    music_title: None,
                    group_hint: None,
                }],
            })
        }
        RootProbe::List(list) => {
            if list.entries.is_empty() {
                bail!("download resource does not contain any downloadable entries");
            }

            let collection_url = list.webpage_url.clone();
            let existing = resolve_existing_collection_for_download_identity(
                &collection_url,
                &list.title,
                CollectionSourceKind::List,
            )
            .await?;
            let collection_url = existing
                .as_ref()
                .map(|collection| collection.url.clone())
                .unwrap_or(collection_url);
            let collection_folder = resolve_task_collection_folder(
                task,
                &collection_url,
                &list.title,
                existing.as_ref(),
            )
            .await?;
            let collection_shell = Collection {
                name: list.title.clone(),
                url: collection_url.clone(),
                folder: collection_folder.clone(),
                musics: vec![],
                last_updated: now_timestamp(),
                enable_updates: existing
                    .as_ref()
                    .and_then(|collection| collection.enable_updates)
                    .or(Some(false)),
            };
            let leaves = collection_import::deduplicate_planned_leaves(
                &collection_url,
                expand_root_entries_to_planned_leafs(
                    &task.id,
                    client.clone(),
                    list.entries,
                    &collection_shell,
                    None,
                )
                .await?,
            );

            Ok(CollectionSyncPlan {
                source_kind: CollectionSourceKind::List,
                collection_name: list.title.clone(),
                collection_url: collection_url.clone(),
                collection_folder,
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

pub(crate) async fn resolve_existing_collection_for_download_identity(
    collection_url: &str,
    collection_name: &str,
    source_kind: CollectionSourceKind,
) -> Result<Option<Collection>> {
    if let Some(collection) = collection_import::get_collection_by_url(collection_url).await? {
        return Ok(Some(collection));
    }

    let Some(collection) = collection_import::get_collection_by_name(collection_name).await? else {
        return Ok(None);
    };

    if classify_root_preference(&collection.url) == source_kind {
        Ok(Some(collection))
    } else {
        Ok(None)
    }
}

pub(crate) fn residual_collection_plan(task: &DownloadTask) -> Option<CollectionSyncPlan> {
    if task.leafs.is_empty() {
        return None;
    }

    let collection_owner = residual_task_collection_owner(task)?;

    Some(CollectionSyncPlan {
        source_kind: task.source_kind?,
        collection_name: task.collection_name.clone()?,
        collection_url: task.collection_url.clone()?,
        collection_folder: task.collection_folder.clone()?,
        enable_updates: None,
        leaves: task
            .leafs
            .iter()
            .map(|leaf| planned_leaf_from_residual(leaf, &collection_owner))
            .collect(),
    })
}

fn residual_task_collection_owner(task: &DownloadTask) -> Option<Collection> {
    Some(Collection {
        name: task.collection_name.clone()?,
        url: task.collection_url.clone()?,
        folder: task.collection_folder.clone()?,
        musics: vec![],
        last_updated: now_timestamp(),
        enable_updates: None,
    })
}

fn planned_leaf_from_residual(leaf: &DownloadLeaf, collection: &Collection) -> PlannedLeaf {
    PlannedLeaf {
        id: leaf.id.clone(),
        url: leaf.url.clone(),
        sequence: leaf.sequence,
        initial_probe: None,
        music_title: leaf.title.clone(),
        group_hint: leaf
            .group
            .clone()
            .map(|group| group_context_into_collection_group(group, collection)),
    }
}

fn group_context_into_collection_group(
    group: DownloadLeafGroupContext,
    collection: &Collection,
) -> Group {
    Group {
        name: group.name,
        url: group.url,
        collection: collection.into(),
        folder: group.folder,
    }
}

pub(crate) async fn resolve_task_collection_folder(
    task: &DownloadTask,
    collection_url: &str,
    collection_name: &str,
    existing: Option<&Collection>,
) -> Result<String> {
    if let Some(folder) = task
        .collection_folder
        .as_deref()
        .map(str::trim)
        .filter(|folder| !folder.is_empty())
    {
        return Ok(folder.to_string());
    }

    collection_import::resolve_collection_folder(collection_url, collection_name, existing).await
}

#[derive(Debug, Clone)]
struct PendingLeafExpansion {
    entry: LeafReference,
    group_hint: Option<Group>,
    depth: u8,
}

#[derive(Debug, Clone)]
struct ExpandedLeafCandidate {
    id: Id,
    url: String,
    title: Option<String>,
    initial_probe: Option<LeafProbe>,
    group_hint: Option<Group>,
}

pub(crate) async fn expand_root_entries_to_planned_leafs(
    task_id: &Id,
    client: Arc<dyn YtDlpClient>,
    entries: Vec<LeafReference>,
    collection: &Collection,
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
    let mut candidates = Vec::new();

    while let Some(next) = pending.pop() {
        let preference = classify_root_preference(&next.entry.url);
        if preference == CollectionSourceKind::Single {
            let url = next.entry.url;
            let id = leaf_id_for(task_id, &url, next.group_hint.as_ref());
            candidates.push(ExpandedLeafCandidate {
                id,
                url,
                title: next.entry.title,
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
        let nested_probe = probe_root_with_limit(client.clone(), nested_url.clone()).await?;

        match nested_probe {
            RootProbe::Single(leaf) => {
                let leaf_url = leaf.webpage_url.clone();
                candidates.push(ExpandedLeafCandidate {
                    id: leaf_id_for(task_id, &leaf_url, next.group_hint.as_ref()),
                    url: leaf_url,
                    title: Some(leaf.title.clone()),
                    initial_probe: (!should_reprobe_single_leaf(preference)).then_some(leaf),
                    group_hint: next.group_hint,
                });
            }
            RootProbe::List(list) => {
                let nested_group = Some(Group {
                    name: list.title.clone(),
                    url: list.webpage_url.clone(),
                    collection: collection.into(),
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

    Ok(assign_normalized_music_titles(candidates))
}

fn assign_normalized_music_titles(candidates: Vec<ExpandedLeafCandidate>) -> Vec<PlannedLeaf> {
    let mut group_titles = HashMap::<String, Vec<String>>::new();
    for candidate in &candidates {
        let Some(title) = &candidate.title else {
            continue;
        };
        group_titles
            .entry(candidate_title_group_key(candidate))
            .or_default()
            .push(title.clone());
    }

    let normalized_by_group = group_titles
        .into_iter()
        .map(|(group, titles)| {
            (
                group,
                collection_import::normalize_music_title_batch(&titles),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut group_offsets = HashMap::<String, usize>::new();

    candidates
        .into_iter()
        .enumerate()
        .map(|(index, candidate)| {
            let group_key = candidate_title_group_key(&candidate);
            let music_title = candidate.title.as_ref().and_then(|_| {
                let offset = group_offsets.entry(group_key.clone()).or_default();
                let title = normalized_by_group
                    .get(&group_key)
                    .and_then(|titles| titles.get(*offset))
                    .cloned();
                *offset += 1;
                title
            });

            PlannedLeaf {
                id: candidate.id,
                url: candidate.url,
                sequence: index as u32,
                initial_probe: candidate.initial_probe,
                music_title,
                group_hint: candidate.group_hint,
            }
        })
        .collect()
}

fn candidate_title_group_key(candidate: &ExpandedLeafCandidate) -> String {
    candidate
        .group_hint
        .as_ref()
        .map(|group| group.url.clone())
        .unwrap_or_default()
}

pub(crate) async fn probe_root_with_limit(
    client: Arc<dyn YtDlpClient>,
    url: String,
) -> Result<RootProbe> {
    let _permit = root_probe_slots()
        .acquire_owned()
        .await
        .context("download root probe limiter closed")?;
    let _usage = acquire_downloads_ytdlp_usage();
    run_blocking(move || {
        let _usage = _usage;
        client.probe_root(&url)
    })
    .await
}

pub(crate) async fn probe_root_shell_with_limit(
    client: Arc<dyn YtDlpClient>,
    url: String,
    trace: Option<RootShellProbeTraceSink>,
) -> Result<RootShellProbe> {
    let wait_start = Instant::now();
    if let Some(trace) = trace.as_ref() {
        trace(RootShellProbeTraceEvent::WaitStart);
    }

    let _permit = root_shell_probe_slots()
        .acquire_owned()
        .await
        .context("download root shell probe limiter closed")?;
    if let Some(trace) = trace.as_ref() {
        trace(RootShellProbeTraceEvent::SlotAcquired {
            elapsed_ms: wait_start.elapsed().as_millis(),
        });
    }

    let probe_start = Instant::now();
    let _usage = acquire_downloads_ytdlp_usage();
    match run_blocking(move || {
        let _usage = _usage;
        client.probe_root_shell(&url)
    })
    .await
    {
        Ok(shell) => {
            if let Some(trace) = trace.as_ref() {
                trace(RootShellProbeTraceEvent::Done {
                    elapsed_ms: probe_start.elapsed().as_millis(),
                });
            }
            Ok(shell)
        }
        Err(error) => {
            if let Some(trace) = trace.as_ref() {
                trace(RootShellProbeTraceEvent::Error {
                    elapsed_ms: probe_start.elapsed().as_millis(),
                    error: error.to_string(),
                });
            }
            Err(error)
        }
    }
}

#[cfg(not(test))]
fn acquire_downloads_ytdlp_usage() -> crate::utils::binaries::ManagedBinaryUsageGuard {
    acquire_managed_binary_usage(ManagedBinary::YtDlp, "downloads_probe")
}

#[cfg(test)]
fn acquire_downloads_ytdlp_usage() {}

#[cfg(test)]
pub(crate) fn root_probe_parallelism() -> usize {
    MAX_CONCURRENT_ROOT_PROBES
}

fn root_probe_slots() -> Arc<Semaphore> {
    Arc::clone(
        ROOT_PROBE_SLOTS.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_ROOT_PROBES))),
    )
}

fn root_shell_probe_slots() -> Arc<Semaphore> {
    Arc::clone(
        ROOT_SHELL_PROBE_SLOTS
            .get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_ROOT_SHELL_PROBES))),
    )
}

async fn run_blocking<T>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T>
where
    T: Send + 'static,
{
    task::spawn_blocking(work)
        .await
        .context("blocking download task panicked")?
}

pub(crate) fn task_id_for(url: &str, trigger: DownloadTrigger) -> String {
    format!(
        "{}-{}",
        match trigger {
            DownloadTrigger::Manual => "manual",
            DownloadTrigger::LocalImport => "local",
            DownloadTrigger::AutoUpdate => "auto",
        },
        stable_id(&format!("{url}|{}", now_timestamp()))
    )
}

pub(crate) fn leaf_id_for(task_id: &Id, leaf_url: &str, group: Option<&Group>) -> Id {
    let group_url = group.map(|group| group.url.as_str()).unwrap_or_default();
    Id::from(stable_id(&format!("{task_id}|{group_url}|{leaf_url}")))
}

pub(crate) fn normalize_url(url: &str) -> Result<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        bail!("download url is empty");
    }

    if let Some(canonical) = normalize_youtube_watch_playlist_item_url(trimmed) {
        return Ok(canonical);
    }

    if let Some(canonical) = normalize_youtube_playlist_url(trimmed) {
        return Ok(canonical);
    }

    if let Some(canonical) = normalize_youtube_direct_leaf_url(trimmed) {
        return Ok(canonical);
    }

    Ok(trimmed.to_string())
}

pub(crate) fn parse_download_url(text: &str) -> std::result::Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Clipboard does not contain a URL.".to_string());
    }

    let parsed =
        Url::parse(trimmed).map_err(|_| "Clipboard does not contain a valid URL.".to_string())?;
    if trimmed.chars().any(char::is_whitespace)
        || trimmed.chars().any(|character| character.is_control())
    {
        return Err("Clipboard must contain exactly one URL.".to_string());
    }

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

    let query = parsed.query_pairs().collect::<Vec<_>>();
    if let Some(video_id) = query
        .iter()
        .find(|(key, value)| key == "v" && !value.is_empty())
        .map(|(_, value)| value.to_string())
    {
        let playlist_id = query
            .iter()
            .find(|(key, value)| key == "list" && !value.is_empty())
            .map(|(_, value)| value.to_string());
        if playlist_id.is_some()
            && !playlist_id
                .as_deref()
                .is_some_and(is_youtube_mix_playlist_id)
        {
            return None;
        }

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

fn normalize_youtube_watch_playlist_item_url(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if !host.ends_with("youtube.com") {
        return None;
    }

    let mut segments = parsed.path_segments()?;
    if segments.next()? != "watch" {
        return None;
    }

    let mut video_id = None;
    let mut has_playlist = false;
    let mut has_index = false;

    for (key, value) in parsed.query_pairs() {
        if value.is_empty() {
            continue;
        }

        match key.as_ref() {
            "v" => video_id = Some(value.to_string()),
            "list" => has_playlist = true,
            "index" => has_index = true,
            _ => {}
        }
    }

    if !has_playlist || !has_index {
        return None;
    }

    video_id.map(|video_id| format!("https://www.youtube.com/watch?v={video_id}"))
}

fn normalize_youtube_playlist_url(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host != "youtu.be" && !host.ends_with("youtube.com") {
        return None;
    }

    let playlist_id = parsed
        .query_pairs()
        .find(|(key, value)| key == "list" && !value.is_empty())
        .map(|(_, value)| value.to_string())?;
    if is_youtube_mix_playlist_id(&playlist_id) {
        return None;
    }

    Some(format!(
        "https://www.youtube.com/playlist?list={playlist_id}"
    ))
}

/// Root probing decides collection shape; full leaf metadata should only be
/// reused when the input was already classified as a direct leaf URL.
pub(crate) fn should_reprobe_single_leaf(preference: CollectionSourceKind) -> bool {
    preference != CollectionSourceKind::Single
}
