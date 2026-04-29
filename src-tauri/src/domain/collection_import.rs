use crate::domain::downloads::model::{
    CollectionSourceKind, DownloadLeaf, DownloadResourceProbe, DownloadTask, DownloadTaskStatus,
    PastedDownloadUrlResolution, now_timestamp,
};
use crate::domain::downloads::naming::{provider_segment, sanitize_path_component, short_hash};
use crate::domain::downloads::repo as download_repo;
use crate::domain::downloads::yt_dlp::{LeafProbe, RootProbe};
use crate::domain::playlists::model::{Collection, Group, Music};
use crate::domain::playlists::repo as collection_repo;
use anyhow::{Context, Result, bail};
use appdb::Id;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub(crate) struct CollectionSyncPlan {
    pub(crate) source_kind: CollectionSourceKind,
    pub(crate) collection_name: String,
    pub(crate) collection_url: String,
    pub(crate) collection_folder: String,
    pub(crate) enable_updates: Option<bool>,
    pub(crate) leaves: Vec<PlannedLeaf>,
}

#[derive(Debug, Clone)]
pub(crate) struct PlannedLeaf {
    pub(crate) id: Id,
    pub(crate) url: String,
    pub(crate) sequence: u32,
    pub(crate) initial_probe: Option<LeafProbe>,
    pub(crate) group_hint: Option<Group>,
}

pub(crate) async fn resolve_pasted_download_url(
    normalized_url: String,
) -> Result<PastedDownloadUrlResolution> {
    match collection_repo::find_collection_by_url(&normalized_url).await? {
        Some(collection) => Ok(PastedDownloadUrlResolution::existing_collection(
            normalized_url,
            collection,
        )),
        None => Ok(PastedDownloadUrlResolution::new_url(normalized_url)),
    }
}

pub(crate) async fn describe_download_resource(
    root_probe: RootProbe,
) -> Result<DownloadResourceProbe> {
    match root_probe {
        RootProbe::Single(leaf) => {
            let existing = collection_repo::get_collection_by_url(&leaf.webpage_url).await?;
            Ok(DownloadResourceProbe {
                url: leaf.webpage_url.clone(),
                source_kind: CollectionSourceKind::Single,
                title: leaf.title.clone(),
                item_count: 1,
                collection_folder: resolve_collection_folder(
                    &leaf.webpage_url,
                    &leaf.title,
                    existing.as_ref(),
                )
                .await?,
                enable_updates: None,
            })
        }
        RootProbe::List(list) => {
            if list.entries.is_empty() {
                bail!("download resource does not contain any downloadable entries");
            }

            let existing = collection_repo::get_collection_by_url(&list.webpage_url).await?;
            Ok(DownloadResourceProbe {
                url: list.webpage_url.clone(),
                source_kind: CollectionSourceKind::List,
                title: list.title.clone(),
                item_count: list.entries.len() as u32,
                collection_folder: resolve_collection_folder(
                    &list.webpage_url,
                    &list.title,
                    existing.as_ref(),
                )
                .await?,
                enable_updates: Some(
                    existing
                        .and_then(|collection| collection.enable_updates)
                        .unwrap_or(false),
                ),
            })
        }
    }
}

#[cfg(not(test))]
pub(crate) async fn resolve_existing_enqueued_collection(
    task: &DownloadTask,
) -> Result<Collection> {
    if let Some(collection_url) = &task.collection_url
        && let Some(collection) = collection_repo::get_collection_by_url(collection_url).await?
    {
        return Ok(collection);
    }

    bail!(
        "active download task `{}` does not have a persisted collection yet",
        task.id
    );
}

pub(crate) fn create_collection_shell(
    plan: &CollectionSyncPlan,
    existing: Option<Collection>,
) -> Collection {
    let mut collection = existing.unwrap_or_else(|| Collection {
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
    collection
}

pub(crate) async fn load_collection_shell(plan: &CollectionSyncPlan) -> Result<Collection> {
    let existing = collection_repo::get_collection_by_url(&plan.collection_url).await?;
    Ok(create_collection_shell(plan, existing))
}

pub(crate) fn apply_collection_plan_to_task(task: &mut DownloadTask, plan: &CollectionSyncPlan) {
    task.collection_url = Some(plan.collection_url.clone());
    task.collection_name = Some(plan.collection_name.clone());
    task.collection_folder = Some(plan.collection_folder.clone());
    task.source_kind = Some(plan.source_kind);
    task.leafs = plan
        .leaves
        .iter()
        .map(|leaf| DownloadLeaf::new(leaf.id.clone(), leaf.url.clone(), leaf.sequence))
        .collect();
    task.refresh_counts();
}

pub(crate) async fn persist_enqueued_collection_state(
    mut task: DownloadTask,
    plan: &CollectionSyncPlan,
) -> Result<(DownloadTask, Collection)> {
    let collection =
        collection_repo::upsert_collection(&load_collection_shell(plan).await?).await?;
    apply_collection_plan_to_task(&mut task, plan);

    if plan.leaves.is_empty() {
        task.status = DownloadTaskStatus::Completed;
        task.last_error = None;
        task.refresh_counts();
    }

    let task = download_repo::save_task(task).await?;
    Ok((task, collection))
}

pub(crate) async fn persist_empty_collection(collection: &mut Collection) -> Result<()> {
    collection.last_updated = now_timestamp();
    let saved = collection_repo::upsert_collection(collection).await?;
    *collection = saved;
    Ok(())
}

pub(crate) async fn persist_downloaded_leaf_music(
    collection: &mut Collection,
    source_kind: CollectionSourceKind,
    probe: &LeafProbe,
    file_name: &str,
    group: Group,
) -> Result<()> {
    let mut materialized = materialize_music_entries(probe, file_name, group);
    inherit_existing_music_aliases(&mut materialized, &collection.musics);
    if source_kind == CollectionSourceKind::Single {
        collection.musics = materialized.clone();
    } else {
        collection
            .musics
            .retain(|music| music.url != probe.webpage_url);
        collection.musics.append(&mut materialized);
    }
    collection.last_updated = now_timestamp();
    let saved = collection_repo::upsert_collection(collection).await?;
    *collection = saved;
    Ok(())
}

pub(crate) async fn get_collection_by_url(url: &str) -> Result<Option<Collection>> {
    collection_repo::get_collection_by_url(url).await
}

#[cfg(not(test))]
pub(crate) async fn list_auto_update_collection_urls() -> Result<Vec<String>> {
    Ok(collection_repo::list_auto_update_collections()
        .await?
        .into_iter()
        .map(|collection| collection.url)
        .collect())
}

pub(crate) async fn resolve_collection_folder(
    collection_url: &str,
    collection_name: &str,
    existing: Option<&Collection>,
) -> Result<String> {
    if let Some(existing) = existing {
        return Ok(existing.folder.clone());
    }

    let prefix = provider_segment(collection_url);
    let base_name = sanitize_path_component(collection_name);
    let candidate_text = format!("{prefix}/{base_name}");

    let collections = collection_repo::list_collections().await?;
    if collections
        .iter()
        .all(|collection| collection.folder != candidate_text || collection.url == collection_url)
    {
        return Ok(candidate_text);
    }

    Ok(format!(
        "{prefix}/{}__{}",
        base_name,
        short_hash(collection_url)
    ))
}

#[cfg(not(test))]
pub(crate) fn finalize_downloaded_leaf(
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

pub(crate) fn materialize_music_entries(
    probe: &LeafProbe,
    relative_path: &str,
    group: Group,
) -> Vec<Music> {
    if probe.chapters.is_empty() {
        let name = probe.title.clone();
        return vec![Music {
            name: name.clone(),
            alias: name,
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
            alias: chapter.title.clone(),
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

fn inherit_existing_music_aliases(musics: &mut [Music], existing_musics: &[Music]) {
    let aliases = existing_musics
        .iter()
        .map(|music| {
            (
                (music.url.as_str(), music.start, music.end),
                music.alias.as_str(),
            )
        })
        .collect::<HashMap<_, _>>();

    for music in musics {
        if let Some(alias) = aliases.get(&(music.url.as_str(), music.start, music.end)) {
            music.alias = (*alias).to_string();
        }
    }
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
    let mut seen_paths = std::collections::BTreeSet::new();
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

pub(crate) async fn repair_stale_single_source_collections(save_root: &Path) -> Result<usize> {
    let mut repaired = 0;
    let mut tasks_by_collection = std::collections::HashMap::<String, Vec<DownloadTask>>::new();

    for task in download_repo::list_tasks().await? {
        if task.source_kind != Some(CollectionSourceKind::Single) {
            continue;
        }

        let Some(collection_url) = task.collection_url.as_ref() else {
            continue;
        };

        tasks_by_collection
            .entry(collection_url.clone())
            .or_default()
            .push(task);
    }

    for (collection_url, mut tasks) in tasks_by_collection {
        tasks.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));

        let Some(mut collection) = collection_repo::get_collection_by_url(&collection_url).await?
        else {
            continue;
        };
        if !collection.musics.is_empty() {
            continue;
        }

        for task in tasks {
            let restored = restore_single_source_musics_from_task(&collection, &task, save_root);
            if restored.is_empty() {
                continue;
            }

            collection.musics = restored;
            collection.last_updated = now_timestamp();
            let _ = collection_repo::upsert_collection(&collection).await?;
            repaired += 1;
            break;
        }
    }

    Ok(repaired)
}

pub(crate) fn restore_single_source_musics_from_task(
    collection: &Collection,
    task: &DownloadTask,
    save_root: &Path,
) -> Vec<Music> {
    if task.source_kind != Some(CollectionSourceKind::Single) {
        return vec![];
    }

    let default_group = Group {
        name: collection.name.clone(),
        url: collection.url.clone(),
        folder: collection.folder.clone(),
    };
    let mut restored = Vec::new();
    let mut seen_urls = HashSet::new();

    for leaf in &task.leafs {
        let Some(relative_path) = leaf.relative_path.as_ref() else {
            continue;
        };
        let relative_path = relative_path.trim();
        if relative_path.is_empty() {
            continue;
        }

        let absolute_path = save_root.join(&collection.folder).join(relative_path);
        if !absolute_path.is_file() {
            continue;
        }

        if !seen_urls.insert(leaf.url.clone()) {
            continue;
        }

        let name = leaf
            .title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or(&collection.name)
            .to_string();
        restored.push(Music {
            name: name.clone(),
            alias: name,
            group: default_group.clone(),
            url: leaf.url.clone(),
            path: Some(relative_path.to_string()),
            start: 0,
            end: leaf.duration_seconds.unwrap_or(0),
        });
    }

    restored
}
