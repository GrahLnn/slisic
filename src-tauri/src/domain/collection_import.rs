#[cfg(not(test))]
use crate::domain::downloads::model::DownloadTaskStatus;
use crate::domain::downloads::model::{
    CollectionSourceKind, DownloadLeaf, DownloadTask, DownloadTrigger, PastedDownloadUrlResolution,
    now_timestamp,
};
use crate::domain::downloads::naming::{
    provider_segment, sanitize_path_component, short_hash, stable_id,
};
use crate::domain::downloads::repo as download_repo;
#[cfg(not(test))]
use crate::domain::downloads::service::{
    DownloadTaskChangeSignal, publish_download_task_change, try_claim_task,
};
use crate::domain::downloads::yt_dlp::{
    LeafProbe, audio_duration_boundary_matches, probe_downloaded_audio_duration_ms,
};
#[cfg(not(test))]
use crate::domain::playlist_playback::service as playlist_playback_service;
use crate::domain::playlists::model::{
    Collection, CollectionGroupOwner, Group, Music, canonical_music_id_for_source,
};
use crate::domain::playlists::repo as collection_repo;
use anyhow::{Context, Result, bail};
use appdb::Id;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
#[cfg(not(test))]
use tokio::sync::broadcast;
use walkdir::WalkDir;
const COLLECTION_MANIFEST_FILE_NAME: &str = ".slisic.collection.toml";
const TEMP_DOWNLOAD_MARKER: &str = ".__slisic_tmp__";
const LOCAL_AUDIO_PRECISE_DURATION_BOUNDARY_TOLERANCE_MS: u32 = 100;

#[cfg(test)]
#[path = "collection_import.test.rs"]
mod tests;

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
    pub(crate) music_title: Option<String>,
    pub(crate) group_hint: Option<Group>,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExistingPlannedLeafCompletion {
    pub(crate) leaf_id: Id,
    pub(crate) title: Option<String>,
    pub(crate) relative_path: String,
    pub(crate) duration_seconds: Option<u32>,
    pub(crate) chapter_count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct LeafGroupIdentity {
    url: String,
    group_url: String,
}

impl LeafGroupIdentity {
    pub(crate) fn from_plan(collection_url: &str, leaf: &PlannedLeaf) -> Self {
        Self {
            url: leaf.url.clone(),
            group_url: leaf
                .group_hint
                .as_ref()
                .map(|group| group.url.clone())
                .unwrap_or_else(|| collection_url.to_string()),
        }
    }

    #[cfg(test)]
    fn from_music(music: &Music) -> Self {
        Self {
            url: music.url.clone(),
            group_url: music.group.url.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CollectionShellPlan {
    pub(crate) source_kind: CollectionSourceKind,
    pub(crate) collection_name: String,
    pub(crate) collection_url: String,
    pub(crate) collection_folder: String,
    pub(crate) enable_updates: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CollectionManifest {
    version: u32,
    collection: CollectionManifestCollection,
    groups: Vec<CollectionManifestGroup>,
    #[serde(rename = "music")]
    musics: Vec<CollectionManifestMusic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CollectionManifestCollection {
    name: String,
    url: String,
    folder: String,
    source_kind: Option<CollectionSourceKind>,
    enable_updates: Option<bool>,
    last_updated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CollectionManifestGroup {
    name: String,
    url: String,
    folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CollectionManifestMusic {
    name: String,
    alias: String,
    url: String,
    path: String,
    group_url: String,
    start_ms: u32,
    end_ms: u32,
    liked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LocalAudioProbe {
    duration_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalAudioFile {
    absolute_path: PathBuf,
    relative_path: String,
    duration_ms: u32,
}

pub(crate) async fn resolve_pasted_download_url(
    normalized_url: String,
) -> Result<PastedDownloadUrlResolution> {
    match collection_repo::get_collection_by_url(&normalized_url).await? {
        Some(collection) => Ok(PastedDownloadUrlResolution::existing_collection(
            normalized_url,
            collection,
        )),
        None => Ok(PastedDownloadUrlResolution::new_url(normalized_url)),
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
    create_collection_shell_from_plan(&plan.shell_plan(), existing)
}

pub(crate) fn create_collection_shell_from_plan(
    plan: &CollectionShellPlan,
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

fn collection_group_owner(collection: &Collection) -> CollectionGroupOwner {
    CollectionGroupOwner::from(collection)
}

fn collection_owner_group(collection: &Collection) -> Group {
    Group {
        name: collection.name.clone(),
        url: collection.url.clone(),
        collection: collection_group_owner(collection),
        folder: collection.folder.clone(),
    }
}

impl CollectionSyncPlan {
    pub(crate) fn shell_plan(&self) -> CollectionShellPlan {
        CollectionShellPlan {
            source_kind: self.source_kind,
            collection_name: self.collection_name.clone(),
            collection_url: self.collection_url.clone(),
            collection_folder: self.collection_folder.clone(),
            enable_updates: self.enable_updates,
        }
    }
}

pub(crate) async fn load_download_transaction_collection_shell(
    plan: &CollectionSyncPlan,
) -> Result<Collection> {
    let existing = collection_repo::get_collection_by_url(&plan.collection_url).await?;
    Ok(create_collection_shell(plan, existing))
}

#[cfg(test)]
pub(crate) async fn load_collection_shell_with_local_duration_probe(
    plan: &CollectionSyncPlan,
    save_root: &Path,
    local_duration_probe: impl Fn(&Path) -> Result<Option<u32>>,
) -> Result<Collection> {
    let existing = collection_repo::get_collection_by_url(&plan.collection_url).await?;
    let mut collection = create_collection_shell(plan, existing);

    if restore_download_manifest_evidence(&mut collection, save_root, &local_duration_probe)? {
        let saved = collection_repo::upsert_collection(&collection).await?;
        notify_audio_style_inputs_changed("download_manifest_evidence_restored");
        notify_playlist_playback_library_changed();
        collection = saved;
    }

    Ok(collection)
}

pub(crate) fn apply_collection_shell_plan_to_task(
    task: &mut DownloadTask,
    plan: &CollectionShellPlan,
) {
    task.collection_url = Some(plan.collection_url.clone());
    task.collection_name = Some(plan.collection_name.clone());
    task.collection_folder = Some(plan.collection_folder.clone());
    task.source_kind = Some(plan.source_kind);
}

pub(crate) fn apply_collection_plan_to_task(task: &mut DownloadTask, plan: &CollectionSyncPlan) {
    apply_collection_shell_plan_to_task(task, &plan.shell_plan());
    task.discard_completed_leafs();
    for leaf in &plan.leaves {
        if task.leafs.iter().any(|existing| existing.id == leaf.id) {
            continue;
        }

        let mut residual = DownloadLeaf::new(leaf.id.clone(), leaf.url.clone(), leaf.sequence);
        residual.title = leaf.music_title.clone();
        residual.group = leaf.group_hint.clone().map(Into::into);
        task.leafs.push(residual);
    }
    task.leafs.sort_by_key(|leaf| leaf.sequence);
    task.refresh_counts();
}

pub(crate) async fn persist_download_collection_shell_from_task(
    task: &DownloadTask,
) -> Result<Option<Collection>> {
    let Some(source_kind) = task.source_kind else {
        return Ok(None);
    };
    let Some(collection_name) = task.collection_name.as_ref() else {
        return Ok(None);
    };
    let Some(collection_url) = task.collection_url.as_ref() else {
        return Ok(None);
    };
    let Some(collection_folder) = task.collection_folder.as_ref() else {
        return Ok(None);
    };

    let existing = collection_repo::get_collection_by_url(collection_url).await?;
    let enable_updates = match source_kind {
        CollectionSourceKind::Single => None,
        CollectionSourceKind::List => Some(
            existing
                .as_ref()
                .and_then(|collection| collection.enable_updates)
                .unwrap_or(false),
        ),
    };
    let collection = collection_repo::upsert_collection(&create_collection_shell_from_plan(
        &CollectionShellPlan {
            source_kind,
            collection_name: collection_name.clone(),
            collection_url: collection_url.clone(),
            collection_folder: collection_folder.clone(),
            enable_updates,
        },
        existing,
    ))
    .await?;

    Ok(Some(collection))
}

pub(crate) async fn persist_prepared_collection_shell(
    plan: CollectionShellPlan,
) -> Result<Collection> {
    let existing = collection_repo::get_collection_by_url(&plan.collection_url).await?;
    Ok(
        collection_repo::upsert_collection(&create_collection_shell_from_plan(&plan, existing))
            .await?,
    )
}

pub(crate) async fn persist_enqueued_collection_plan(
    mut task: DownloadTask,
    plan: &CollectionSyncPlan,
) -> Result<(DownloadTask, Collection)> {
    let existing = collection_repo::get_collection_by_url(&plan.collection_url).await?;
    let collection =
        collection_repo::upsert_collection(&create_collection_shell(plan, existing)).await?;
    apply_collection_plan_to_task(&mut task, plan);
    task.last_error = None;
    let task = download_repo::save_task(task).await?;
    Ok((task, collection))
}

pub(crate) async fn persist_empty_collection(collection: &mut Collection) -> Result<()> {
    collection.last_updated = now_timestamp();
    let saved = collection_repo::upsert_collection(collection).await?;
    *collection = saved;
    notify_audio_style_inputs_changed("downloaded_music_persisted");
    Ok(())
}

pub(crate) async fn persist_downloaded_leaf_music(
    collection: &mut Collection,
    source_kind: CollectionSourceKind,
    probe: &LeafProbe,
    file_name: &str,
    group: Group,
) -> Result<()> {
    ensure_committable_download_file_name(file_name)?;
    let mut materialized = materialize_music_entries(probe, file_name, group);
    let _collection_write = collection_repo::acquire_collection_write_composition_lock().await;
    let mut current = collection_repo::get_collection_by_url(&collection.url)
        .await?
        .unwrap_or_else(|| collection.clone());
    inherit_existing_music_lifecycle(&mut materialized, &current.musics);
    if source_kind == CollectionSourceKind::Single {
        current.musics = materialized;
    } else {
        let replacement_group_url = materialized
            .first()
            .map(|music| music.group.url.clone())
            .unwrap_or_default();
        current.musics.retain(|music| {
            music.url != probe.webpage_url || music.group.url != replacement_group_url
        });
        current.musics.append(&mut materialized);
    }
    normalize_music_titles_within_collection(&mut current);
    current.last_updated = now_timestamp();
    let saved = collection_repo::upsert_collection(&current).await?;
    *collection = saved;
    Ok(())
}

pub(crate) fn notify_downloaded_leaf_collection_committed() {
    notify_audio_style_inputs_changed("downloaded_leaf_collection_committed");
    notify_playlist_playback_library_changed();
}

pub(crate) async fn import_local_collection_folder(
    collection_path: &Path,
    save_root: &Path,
    ffmpeg_path: &Path,
) -> Result<Collection> {
    let collection_path = collection_path
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", collection_path.display()))?;
    if !collection_path.is_dir() {
        bail!("local collection import only accepts a folder");
    }

    let collection_folder = collection_folder_from_local_path(save_root, &collection_path)?;
    let local_audio_files = collect_local_audio_files(&collection_path, ffmpeg_path)?;
    let manifest = read_collection_manifest(&collection_path)?;
    let mut collection = match manifest {
        Some(manifest) => {
            collection_from_manifest(collection_folder, manifest, &local_audio_files)?
        }
        None => collection_from_local_audio_files(
            &collection_path,
            &collection_folder,
            &local_audio_files,
        )?,
    };

    if collection.musics.is_empty() {
        bail!("collection folder does not contain ffmpeg-playable audio files");
    }

    normalize_music_titles_within_collection(&mut collection);
    collection.last_updated = now_timestamp();
    let saved = collection_repo::upsert_collection(&collection).await?;
    notify_audio_style_inputs_changed("local_collection_imported");
    notify_playlist_playback_library_changed();
    Ok(saved)
}

#[cfg(not(test))]
async fn import_local_collection_folder_with_task_signal(
    collection_path: &Path,
    save_root: &Path,
    ffmpeg_path: &Path,
) -> Result<Collection> {
    let shell = project_local_collection_shell(collection_path, save_root)?;
    let mut task = create_local_import_task(&shell);
    let task_id = task.id.to_string();

    if !try_claim_task(&task_id)? {
        return wait_for_local_import_collection(shell, &task_id).await;
    }

    let result: Result<Collection> = async {
        task.status = DownloadTaskStatus::Resolving;
        task.touch();
        task = download_repo::save_task(task).await?;
        publish_download_task_change(&task);

        let collection =
            import_local_collection_folder(collection_path, save_root, ffmpeg_path).await?;

        task.status = DownloadTaskStatus::Completed;
        task.last_error = None;
        task.touch();
        task = download_repo::save_task(task).await?;
        publish_download_task_change(&task);

        Ok(collection)
    }
    .await;

    crate::domain::downloads::service::release_task(&task_id);
    if let Err(error) = &result {
        let mut failed = create_local_import_task(&shell);
        failed.status = DownloadTaskStatus::Failed;
        failed.last_error = Some(error.to_string());
        failed.touch();
        if let Ok(saved) = download_repo::save_task(failed).await {
            publish_download_task_change(&saved);
        }
    }

    result
}

#[cfg(not(test))]
async fn prepare_local_import_collection_shell(
    collection_path: &Path,
    save_root: &Path,
) -> Result<Collection> {
    let shell = project_local_collection_shell(collection_path, save_root)?;
    let existing = collection_repo::get_collection_by_url(&shell.url).await?;
    let saved = collection_repo::upsert_collection(&create_collection_shell_from_plan(
        &CollectionShellPlan {
            source_kind: CollectionSourceKind::List,
            collection_name: shell.name.clone(),
            collection_url: shell.url.clone(),
            collection_folder: shell.folder.clone(),
            enable_updates: shell.enable_updates,
        },
        existing,
    ))
    .await?;

    let active_task = match download_repo::get_task(&local_import_task_id(&saved.url)).await {
        Ok(task) if task.status.is_active() => task,
        _ => download_repo::save_task(create_local_import_task(&saved)).await?,
    };
    publish_download_task_change(&active_task);

    Ok(saved)
}

#[cfg(not(test))]
async fn wait_for_local_import_collection(shell: Collection, task_id: &str) -> Result<Collection> {
    let mut changes = crate::domain::downloads::service::subscribe_download_task_changes();
    loop {
        if let Some(collection) = collection_repo::get_collection_by_url(&shell.url).await?
            && !collection.musics.is_empty()
        {
            return Ok(collection);
        }

        match download_repo::get_task(task_id).await {
            Ok(task) if task.status.is_terminal() => {
                if task.status == DownloadTaskStatus::Failed {
                    bail!(
                        "{}",
                        task.last_error
                            .unwrap_or_else(|| "local collection import failed".to_string())
                    );
                }
                if let Some(collection) = collection_repo::get_collection_by_url(&shell.url).await?
                {
                    return Ok(collection);
                }
                bail!("local collection import finished without persisted collection");
            }
            Ok(_) => {}
            Err(_) => {}
        }

        wait_for_collection_task_change(&mut changes, task_id, &shell.url).await?;
    }
}

#[cfg(not(test))]
async fn wait_for_collection_task_change(
    changes: &mut broadcast::Receiver<DownloadTaskChangeSignal>,
    task_id: &str,
    collection_url: &str,
) -> Result<()> {
    loop {
        let signal = changes
            .recv()
            .await
            .context("local import task change channel closed")?;
        if signal.task_id == task_id
            || signal.collection_url.as_deref() == Some(collection_url)
            || signal.task_url == collection_url
        {
            return Ok(());
        }
    }
}

pub(crate) fn create_local_import_task(shell: &Collection) -> DownloadTask {
    let mut task = DownloadTask::new(
        local_import_task_id(&shell.url),
        shell.url.clone(),
        DownloadTrigger::LocalImport,
    );
    task.collection_url = Some(shell.url.clone());
    task.collection_name = Some(shell.name.clone());
    task.collection_folder = Some(shell.folder.clone());
    task.source_kind = Some(CollectionSourceKind::List);
    task
}

fn local_import_task_id(collection_url: &str) -> String {
    format!("local-{}", stable_id(collection_url))
}

pub(crate) fn project_local_collection_shell(
    collection_path: &Path,
    save_root: &Path,
) -> Result<Collection> {
    let collection_path = collection_path
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", collection_path.display()))?;
    if !collection_path.is_dir() {
        bail!("local collection import only accepts a folder");
    }

    let collection_folder = collection_folder_from_local_path(save_root, &collection_path)?;
    if let Some(manifest) = read_collection_manifest(&collection_path)? {
        return Ok(Collection {
            name: manifest.collection.name,
            url: manifest.collection.url,
            folder: collection_folder,
            musics: vec![],
            last_updated: manifest
                .collection
                .last_updated
                .unwrap_or_else(now_timestamp),
            enable_updates: manifest.collection.enable_updates,
        });
    }

    let collection_name = local_collection_name(&collection_path);
    Ok(Collection {
        name: collection_name,
        url: local_collection_url(&collection_path)?,
        folder: collection_folder,
        musics: vec![],
        last_updated: now_timestamp(),
        enable_updates: None,
    })
}

pub(crate) fn write_raw_leaf_manifest_evidence(
    collection_root: &Path,
    collection: &Collection,
    source_kind: CollectionSourceKind,
    probe: &LeafProbe,
    relative_path: &str,
    group: &Group,
) -> Result<()> {
    let manifest =
        manifest_from_raw_leaf_evidence(collection, source_kind, probe, relative_path, group);
    write_raw_leaf_manifest_file(collection_root, &manifest)
}

#[cfg(not(test))]
#[tauri::command]
#[specta::specta]
pub async fn import_local_collection(
    app: tauri::AppHandle,
    collection_path: String,
) -> Result<Collection, String> {
    let save_root = crate::domain::meta::service::resolve_save_root(&app)
        .await
        .map_err(|error| error.to_string())?;
    let ffmpeg_path = crate::utils::binaries::ensure_managed_binary(
        &app,
        crate::utils::binaries::ManagedBinary::Ffmpeg,
    )
    .map_err(|error| error.to_string())?;

    import_local_collection_folder_with_task_signal(
        Path::new(&collection_path),
        &save_root,
        &ffmpeg_path,
    )
    .await
    .map_err(|error| error.to_string())
}

#[cfg(not(test))]
#[tauri::command]
#[specta::specta]
pub async fn create_local_collection_shell(
    app: tauri::AppHandle,
    collection_path: String,
) -> Result<Collection, String> {
    let save_root = crate::domain::meta::service::resolve_save_root(&app)
        .await
        .map_err(|error| error.to_string())?;

    prepare_local_import_collection_shell(Path::new(&collection_path), &save_root)
        .await
        .map_err(|error| error.to_string())
}

pub(crate) async fn get_collection_by_url(url: &str) -> Result<Option<Collection>> {
    collection_repo::get_collection_by_url(url).await
}

pub(crate) async fn get_collection_by_name(name: &str) -> Result<Option<Collection>> {
    collection_repo::get_collection_by_name(name).await
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

    Ok(candidate_text)
}

pub(crate) fn finalize_downloaded_leaf(
    collection: &Collection,
    leaf_url: &str,
    group: &Group,
    save_root: &Path,
    _file_stem: &str,
    downloaded_path: PathBuf,
) -> Result<String> {
    let final_file_name = finalized_download_file_name(&downloaded_path)?;
    ensure_committable_download_file_name(&final_file_name)?;
    let relative_path = relative_music_path(collection, &final_file_name, group);
    let final_path = save_root.join(&collection.folder).join(&relative_path);

    if final_path.exists() && final_path != downloaded_path {
        std::fs::remove_file(&final_path)
            .with_context(|| format!("failed to remove existing file {}", final_path.display()))?;
    }
    remove_existing_leaf_files(collection, leaf_url, group, save_root, Some(&final_path))?;

    commit_downloaded_file(&downloaded_path, &final_path)?;

    Ok(relative_path)
}

fn ensure_committable_download_file_name(file_name: &str) -> Result<()> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("part") {
        bail!("downloaded audio is still incomplete: {file_name}");
    }

    Ok(())
}

fn commit_downloaded_file(downloaded_path: &Path, final_path: &Path) -> Result<()> {
    if downloaded_path == final_path {
        return Ok(());
    }

    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    match std::fs::rename(downloaded_path, final_path) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            std::fs::copy(downloaded_path, final_path).with_context(|| {
                format!(
                    "failed to copy downloaded audio from {} to {} after rename failed: {}",
                    downloaded_path.display(),
                    final_path.display(),
                    rename_error
                )
            })?;
            std::fs::remove_file(downloaded_path).with_context(|| {
                format!(
                    "failed to remove downloaded temp file {} after copying it to {}",
                    downloaded_path.display(),
                    final_path.display()
                )
            })?;
            Ok(())
        }
    }
}

fn finalized_download_file_name(downloaded_path: &Path) -> Result<String> {
    let file_name = downloaded_path
        .file_name()
        .and_then(|value| value.to_str())
        .context("downloaded audio path does not contain a unicode file name")?;
    let Some(file_stem) = downloaded_path.file_stem().and_then(|value| value.to_str()) else {
        return Ok(file_name.to_string());
    };

    let Some((stable_stem, suffix)) = file_stem.rsplit_once(TEMP_DOWNLOAD_MARKER) else {
        return Ok(file_name.to_string());
    };
    if stable_stem.is_empty() || suffix.is_empty() {
        return Ok(file_name.to_string());
    }

    match downloaded_path.extension().and_then(|value| value.to_str()) {
        Some(extension) if !extension.is_empty() => Ok(format!("{stable_stem}.{extension}")),
        _ => Ok(stable_stem.to_string()),
    }
}

pub(crate) fn resolve_existing_leaf_file(
    collection: &Collection,
    group: &Group,
    save_root: &Path,
    file_stem: &str,
) -> Option<String> {
    let relative_path = relative_music_path(collection, &format!("{file_stem}.m4a"), group);
    let absolute_path = save_root.join(&collection.folder).join(&relative_path);

    absolute_path.is_file().then_some(relative_path)
}

pub(crate) fn filter_new_planned_leaves(
    collection_url: &str,
    leaves: Vec<PlannedLeaf>,
    existing_leafs: &HashSet<LeafGroupIdentity>,
) -> Vec<PlannedLeaf> {
    let mut planned_leafs = HashSet::new();
    leaves
        .into_iter()
        .filter(|leaf| {
            let identity = LeafGroupIdentity::from_plan(collection_url, leaf);
            !existing_leafs.contains(&identity) && planned_leafs.insert(identity)
        })
        .collect()
}

pub(crate) fn deduplicate_planned_leaves(
    collection_url: &str,
    leaves: Vec<PlannedLeaf>,
) -> Vec<PlannedLeaf> {
    filter_new_planned_leaves(collection_url, leaves, &HashSet::new())
}

pub(crate) fn materialize_music_entries(
    probe: &LeafProbe,
    relative_path: &str,
    group: Group,
) -> Vec<Music> {
    if probe.chapters.is_empty() {
        let name = probe.title.clone();
        return vec![Music {
            occurrence_id: String::new(),
            name: name.clone(),
            alias: name,
            group,
            canonical_music_id: canonical_music_id_for_source(
                &probe.webpage_url,
                0,
                probe_duration_ms(probe),
            ),
            url: probe.webpage_url.clone(),
            path: Some(relative_path.to_string()),
            start_ms: 0,
            end_ms: probe_duration_ms(probe),
            liked: false,
            loudness_profile: None,
        }];
    }

    probe
        .chapters
        .iter()
        .map(|chapter| Music {
            occurrence_id: String::new(),
            name: chapter.title.clone(),
            alias: chapter.title.clone(),
            group: group.clone(),
            canonical_music_id: canonical_music_id_for_source(
                &probe.webpage_url,
                chapter.start_ms,
                chapter.end_ms,
            ),
            url: probe.webpage_url.clone(),
            path: Some(relative_path.to_string()),
            start_ms: chapter.start_ms,
            end_ms: chapter.end_ms,
            liked: false,
            loudness_profile: None,
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn existing_leaf_identities(
    collection: Option<&Collection>,
    save_root: &Path,
) -> HashSet<LeafGroupIdentity> {
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
                .map(LeafGroupIdentity::from_music)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn existing_planned_leaf_completions(
    collection: &Collection,
    plan: &CollectionSyncPlan,
    save_root: &Path,
) -> Vec<ExistingPlannedLeafCompletion> {
    let mut music_by_identity = HashMap::<LeafGroupIdentity, Vec<&Music>>::new();
    for music in &collection.musics {
        let Some(relative_path) = music.path.as_deref().map(str::trim) else {
            continue;
        };
        if relative_path.is_empty()
            || !save_root
                .join(&collection.folder)
                .join(relative_path)
                .is_file()
        {
            continue;
        }

        music_by_identity
            .entry(LeafGroupIdentity::from_music(music))
            .or_default()
            .push(music);
    }

    plan.leaves
        .iter()
        .filter_map(|leaf| {
            let identity = LeafGroupIdentity::from_plan(&plan.collection_url, leaf);
            let musics = music_by_identity.get(&identity)?;
            let first = musics.first()?;
            let relative_path = first.path.as_ref()?.trim();
            if relative_path.is_empty() {
                return None;
            }

            let title = leaf
                .music_title
                .clone()
                .or_else(|| Some(first.name.clone()))
                .filter(|value| !value.trim().is_empty());
            let duration_seconds = musics
                .iter()
                .map(|music| music.end_ms)
                .max()
                .map(|end_ms| end_ms / 1_000);

            Some(ExistingPlannedLeafCompletion {
                leaf_id: leaf.id.clone(),
                title,
                relative_path: relative_path.to_string(),
                duration_seconds,
                chapter_count: Some(musics.len() as u32),
            })
        })
        .collect()
}

#[cfg(test)]
fn restore_download_manifest_evidence(
    collection: &mut Collection,
    save_root: &Path,
    local_duration_probe: &impl Fn(&Path) -> Result<Option<u32>>,
) -> Result<bool> {
    let collection_path = save_root.join(&collection.folder);
    let Some(manifest) = read_collection_manifest(&collection_path)? else {
        return Ok(false);
    };
    if manifest.collection.url != collection.url {
        return Ok(false);
    }

    let manifest_paths = manifest
        .musics
        .iter()
        .map(|music| normalize_manifest_relative_path(&music.path))
        .collect::<Result<HashSet<_>>>()?;
    let local_audio_files =
        collect_manifest_audio_file_paths(&collection_path, &manifest_paths, local_duration_probe)?;
    let restored =
        collection_from_manifest(collection.folder.clone(), manifest, &local_audio_files)?;
    if restored.musics.is_empty() {
        return Ok(false);
    }

    let mut restored_any = false;
    for music in restored.musics {
        if let Some(existing) = collection.musics.iter_mut().find(|existing| {
            manifest_restored_music_source_key(existing)
                == manifest_restored_music_source_key(&music)
        }) {
            if !manifest_restored_music_matches(existing, &music) {
                *existing = music;
                restored_any = true;
            }
            continue;
        }

        if !collection.musics.iter().any(|existing| {
            manifest_restored_music_key(existing) == manifest_restored_music_key(&music)
        }) {
            collection.musics.push(music);
            restored_any = true;
        }
    }

    Ok(restored_any)
}

#[cfg(test)]
fn manifest_restored_music_key(music: &Music) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        music.url,
        music.group.url,
        music.path.as_deref().unwrap_or_default(),
        music.start_ms,
        music.end_ms
    )
}

#[cfg(test)]
fn manifest_restored_music_source_key(music: &Music) -> String {
    format!(
        "{}\n{}\n{}\n{}",
        music.url,
        music.group.url,
        music.path.as_deref().unwrap_or_default(),
        music.start_ms
    )
}

#[cfg(test)]
fn manifest_restored_music_matches(left: &Music, right: &Music) -> bool {
    left.name == right.name
        && left.alias == right.alias
        && left.group.name == right.group.name
        && left.group.url == right.group.url
        && left.group.folder == right.group.folder
        && left.canonical_music_id == right.canonical_music_id
        && left.url == right.url
        && left.path == right.path
        && left.start_ms == right.start_ms
        && left.end_ms == right.end_ms
        && left.liked == right.liked
        && left.loudness_profile == right.loudness_profile
}

pub(crate) fn normalize_music_titles_within_collection(collection: &mut Collection) {
    let mut group_indexes = HashMap::<String, Vec<usize>>::new();
    for (index, music) in collection.musics.iter().enumerate() {
        group_indexes
            .entry(music.group.url.clone())
            .or_default()
            .push(index);
    }

    for indexes in group_indexes.values() {
        normalize_music_titles_for_group(&mut collection.musics, indexes);
    }
}

fn normalize_music_titles_for_group(musics: &mut [Music], indexes: &[usize]) {
    if indexes.len() < 2 {
        return;
    }

    let titles = indexes
        .iter()
        .map(|index| musics[*index].name.clone())
        .collect::<Vec<_>>();
    let evidence_titles = indexes
        .iter()
        .enumerate()
        .flat_map(|(source_index, index)| {
            music_title_normalization_evidence(&musics[*index], source_index)
        })
        .collect::<Vec<_>>();
    let normalized = normalize_music_title_batch_with_evidence(&titles, &evidence_titles);
    for (index, title) in indexes.iter().zip(normalized.into_iter()) {
        if title == musics[*index].name {
            continue;
        }

        let previous_name = std::mem::replace(&mut musics[*index].name, title.clone());
        if musics[*index].alias == previous_name {
            musics[*index].alias = title;
        }
    }
}

pub(crate) fn normalize_music_title_batch(titles: &[String]) -> Vec<String> {
    let evidence_titles = titles
        .iter()
        .enumerate()
        .map(|(source_index, title)| TitleNoiseEvidence {
            source_index,
            title: title.clone(),
        })
        .collect::<Vec<_>>();
    normalize_music_title_batch_with_evidence(titles, &evidence_titles)
}

fn normalize_music_title_batch_with_evidence(
    titles: &[String],
    evidence_titles: &[TitleNoiseEvidence],
) -> Vec<String> {
    let mut normalized = titles
        .iter()
        .map(|title| normalize_mechanical_title_noise(title))
        .collect::<Vec<_>>();
    let mut evidence = evidence_titles
        .iter()
        .map(|evidence| TitleNoiseEvidence {
            source_index: evidence.source_index,
            title: normalize_mechanical_title_noise(&evidence.title),
        })
        .collect::<Vec<_>>();

    while let Some(pattern) = best_repeated_title_noise_pattern(&evidence) {
        let mut changed = false;
        for evidence in &mut evidence {
            let next = apply_title_noise_pattern(&evidence.title, &pattern);
            if next != evidence.title {
                evidence.title = next;
                changed = true;
            }
        }

        for title in &mut normalized {
            let next = apply_title_noise_pattern(title, &pattern);
            if next != *title {
                *title = next;
                changed = true;
            }
        }

        if !changed {
            break;
        }
    }

    repair_normalized_titles_from_source_evidence(&mut normalized, &evidence);
    normalized
}

fn normalize_mechanical_title_noise(title: &str) -> String {
    let mut normalized = cleanup_title_after_noise_deletion(title);
    for _ in 0..8 {
        let next = [
            delete_source_note_suffix(&normalized),
            delete_media_wrapper_suffix(&normalized),
            delete_catalog_suffix(&normalized),
            delete_catalog_prefix(&normalized),
        ]
        .into_iter()
        .find(|candidate| candidate != &normalized)
        .unwrap_or_else(|| normalized.clone());
        if next == normalized {
            break;
        }
        normalized = next;
    }
    normalized
}

fn delete_source_note_suffix(title: &str) -> String {
    for (start, character) in title.char_indices() {
        if !matches!(character, '(' | '[') {
            continue;
        }
        let tail = &title[start..];
        if !source_note_tail_is_candidate(tail) {
            continue;
        }
        let span =
            TitleTextSpan::to_end(title, start).expect("source note span must be UTF-8 aligned");
        let normalized = delete_title_span(title, span);
        if title_noise_text_has_language_character(&normalized)
            && !title_is_number_like_only(&normalized)
            && title_bracket_damage_score(&normalized) <= title_bracket_damage_score(title)
        {
            return normalized;
        }
    }
    title.to_string()
}

fn source_note_tail_is_candidate(tail: &str) -> bool {
    let trimmed = tail.trim_start();
    let lower = title_noise_canonical_key(trimmed);
    if !(lower.starts_with("(from ") || lower.starts_with("[from ")) {
        return false;
    }

    lower.contains("soundtra")
        || lower.contains("soundtrack")
        || lower.contains("score")
        || lower.contains(" ost")
        || lower.contains(" official audio")
        || lower.contains(" official video")
        || lower.contains(" lyric video")
        || source_note_tail_has_media_wrapper_after_closing_bracket(trimmed)
}

fn source_note_tail_has_media_wrapper_after_closing_bracket(tail: &str) -> bool {
    let mut stack = Vec::<char>::new();
    for (index, character) in tail.char_indices() {
        if opening_bracket_pair(character).is_some() {
            stack.push(character);
            continue;
        }
        let Some(expected_opening) = closing_bracket_pair(character) else {
            continue;
        };
        if !stack
            .last()
            .is_some_and(|opening| *opening == expected_opening)
        {
            continue;
        }
        stack.pop();
        if !stack.is_empty() {
            continue;
        }
        let after = tail[index + character.len_utf8()..].trim();
        return after.is_empty() || media_wrapper_suffix_is_candidate(after);
    }
    false
}

fn delete_media_wrapper_suffix(title: &str) -> String {
    const MEDIA_SUFFIXES: &[&str] = &[
        "[Official Lyric Video]",
        "(Official Lyric Video)",
        "[Official Video]",
        "(Official Video)",
        "[Official Audio]",
        "(Official Audio)",
        "| Lyric Video",
        "- Lyric Video",
        "| Official Video",
        "- Official Video",
        "| Official Audio",
        "- Official Audio",
    ];

    for suffix in MEDIA_SUFFIXES {
        if let Some(normalized) = delete_title_suffix(title, suffix) {
            return normalized;
        }
    }
    title.to_string()
}

fn media_wrapper_suffix_is_candidate(text: &str) -> bool {
    let lower = title_noise_canonical_key(text);
    matches!(
        lower.as_str(),
        "| lyric video"
            | "- lyric video"
            | "| official video"
            | "- official video"
            | "| official audio"
            | "- official audio"
            | "[official lyric video]"
            | "(official lyric video)"
            | "[official video]"
            | "(official video)"
            | "[official audio]"
            | "(official audio)"
    )
}

fn delete_catalog_suffix(title: &str) -> String {
    const SUFFIXES: &[&str] = &[
        "| Cyberpunk 2077 OST",
        "- Cyberpunk 2077 OST",
        "| Cyberpunk 2077: Phantom Liberty (Original Score) [Deluxe Version]",
        "- Cyberpunk 2077- Phantom Liberty (Original Score) [Deluxe Version]",
        "- Cyberpunk 2077- Phantom Liberty (Original Score)",
        "| Death Stranding 2 On The Beach Original Video Game Score",
        "- Death Stranding 2- On The Beach (Original Video Game Score)",
        "- Death Stranding OST",
        "- WaterTower",
    ];

    for suffix in SUFFIXES {
        if let Some(normalized) = delete_title_suffix(title, suffix) {
            return normalized;
        }
    }
    if let Some(normalized) = delete_genshin_suffix(title) {
        return normalized;
    }
    if let Some(normalized) = delete_year_soundtrack_suffix(title) {
        return normalized;
    }
    title.to_string()
}

fn delete_genshin_suffix(title: &str) -> Option<String> {
    let split = title
        .rfind('｜')
        .or_else(|| title.rfind('|'))
        .filter(|index| {
            title[*index..]
                .to_ascii_lowercase()
                .contains("genshin impact")
        })?;
    let normalized = delete_title_span(title, TitleTextSpan::to_end(title, split)?);
    title_stable_residue_is_valid(&normalized).then_some(normalized)
}

fn delete_year_soundtrack_suffix(title: &str) -> Option<String> {
    let suffix_marker = rfind_ascii_case_insensitive_span(title, " soundtrack (")?;
    let (separator_start, separator) = title[..suffix_marker.start].char_indices().next_back()?;
    if !matches!(separator, '-' | '–' | '—') {
        return None;
    }
    let year_start = suffix_marker.end;
    let year_end = year_start + 4;
    let year = title.get(year_start..year_end)?;
    if !year.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    if title.get(year_end..year_end + 1) != Some(")") || year_end + 1 != title.len() {
        return None;
    }
    let normalized = delete_title_span(title, TitleTextSpan::to_end(title, separator_start)?);
    title_stable_residue_is_valid(&normalized).then_some(normalized)
}

fn delete_catalog_prefix(title: &str) -> String {
    const PREFIXES: &[&str] = &[
        "Terraria Music - ",
        "Terraria OST - ",
        "Terraria: Otherworld OST - ",
        "Terraria- Otherworld OST - ",
        "Terraria Console Soundtrack - ",
        "Terraria Overhaul Music - ",
        "TENET Official Soundtrack - ",
        "ZWEI2 - ",
        "[Official] TUNIC (Original Soundtrack) - Full Album - Lifeformed × Janice Kwan - ",
        "[Official] TUNIC (Original Soundtrack) - ",
    ];

    if let Some(normalized) = delete_blue_archive_catalog_prefix(title) {
        return normalized;
    }
    if let Some(normalized) = delete_minecraft_volume_alpha_prefix(title) {
        return normalized;
    }
    for prefix in PREFIXES {
        if let Some(normalized) = delete_title_prefix(title, prefix) {
            return normalized;
        }
    }
    title.to_string()
}

fn delete_blue_archive_catalog_prefix(title: &str) -> Option<String> {
    for prefix in ["ブルーアーカイブ Blue Archive OST ", "Blue Archive OST "] {
        let Some(rest) = title.strip_prefix(prefix) else {
            continue;
        };
        let mut end = 0usize;
        for (index, character) in rest.char_indices() {
            if !character.is_ascii_digit() {
                break;
            }
            end = index + character.len_utf8();
        }
        if end == 0 {
            continue;
        }
        let rest = &rest[end..];
        let rest = rest.strip_prefix('.').unwrap_or(rest).trim_start();
        if !title_stable_residue_is_valid(rest) {
            continue;
        }
        return Some(cleanup_title_after_noise_deletion(rest));
    }
    None
}

fn delete_minecraft_volume_alpha_prefix(title: &str) -> Option<String> {
    let prefix = "Minecraft Volume Alpha - ";
    let rest = title.strip_prefix(prefix)?;
    let (number, residue) = rest.split_once(" - ")?;
    if !number.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    title_stable_residue_is_valid(residue).then(|| cleanup_title_after_noise_deletion(residue))
}

fn delete_title_prefix(title: &str, prefix: &str) -> Option<String> {
    let rest = title.strip_prefix(prefix)?;
    title_stable_residue_is_valid(rest).then(|| cleanup_title_after_noise_deletion(rest))
}

fn delete_title_suffix(title: &str, suffix: &str) -> Option<String> {
    let span = title_suffix_span_ascii_case_insensitive(title, suffix)?;
    let normalized = delete_title_span(title, span);
    title_stable_residue_is_valid(&normalized).then_some(normalized)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TitleTextSpan {
    start: usize,
    end: usize,
}

impl TitleTextSpan {
    fn new(text: &str, start: usize, end: usize) -> Option<Self> {
        (start <= end
            && end <= text.len()
            && text.is_char_boundary(start)
            && text.is_char_boundary(end))
        .then_some(Self { start, end })
    }

    fn to_end(text: &str, start: usize) -> Option<Self> {
        Self::new(text, start, text.len())
    }

    fn is_whole(self, text: &str) -> bool {
        self.start == 0 && self.end == text.len()
    }

    fn delete_from(self, title: &str) -> String {
        let mut normalized = String::new();
        normalized.push_str(&title[..self.start]);
        normalized.push_str(&title[self.end..]);
        cleanup_title_after_noise_deletion(&normalized)
    }
}

fn delete_title_span(title: &str, span: TitleTextSpan) -> String {
    span.delete_from(title)
}

fn title_suffix_span_ascii_case_insensitive(title: &str, suffix: &str) -> Option<TitleTextSpan> {
    let start = title.len().checked_sub(suffix.len())?;
    let span = TitleTextSpan::new(title, start, title.len())?;
    title.as_bytes()[span.start..span.end]
        .eq_ignore_ascii_case(suffix.as_bytes())
        .then_some(span)
}

fn rfind_ascii_case_insensitive_span(text: &str, needle: &str) -> Option<TitleTextSpan> {
    let needle = needle.as_bytes();
    if needle.is_empty() {
        return TitleTextSpan::new(text, text.len(), text.len());
    }

    text.as_bytes()
        .windows(needle.len())
        .rposition(|candidate| candidate.eq_ignore_ascii_case(needle))
        .and_then(|start| TitleTextSpan::new(text, start, start + needle.len()))
}

fn title_stable_residue_is_valid(title: &str) -> bool {
    let title = cleanup_title_after_noise_deletion(title);
    title_noise_text_has_language_character(&title) && !title_is_number_like_only(&title)
}

fn music_title_normalization_evidence(
    music: &Music,
    source_index: usize,
) -> Vec<TitleNoiseEvidence> {
    let mut evidence = vec![TitleNoiseEvidence {
        source_index,
        title: music.name.clone(),
    }];
    if let Some(path_title) = music
        .path
        .as_deref()
        .and_then(music_path_stem_for_title_evidence)
    {
        if path_title != music.name {
            evidence.push(TitleNoiseEvidence {
                source_index,
                title: path_title,
            });
        }
    }
    evidence
}

fn music_path_stem_for_title_evidence(relative_path: &str) -> Option<String> {
    let stem = Path::new(relative_path)
        .file_stem()
        .and_then(|value| value.to_str())?
        .trim();
    (!stem.is_empty()).then(|| stem.to_string())
}

fn best_repeated_title_noise_pattern(evidence: &[TitleNoiseEvidence]) -> Option<TitleNoisePattern> {
    repeated_title_noise_patterns(evidence)
        .into_iter()
        .max_by_key(title_noise_pattern_rank)
}

fn repeated_title_noise_patterns(evidence: &[TitleNoiseEvidence]) -> Vec<TitleNoisePattern> {
    let mut patterns = Vec::new();
    patterns.extend(repeated_boundary_title_noise_patterns(
        TitleNoisePatternKind::Prefix,
        evidence,
    ));
    patterns.extend(repeated_boundary_title_noise_patterns(
        TitleNoisePatternKind::Suffix,
        evidence,
    ));
    patterns.extend(repeated_bracketed_title_noise_patterns(evidence));
    patterns
}

fn repeated_boundary_title_noise_patterns(
    kind: TitleNoisePatternKind,
    evidence: &[TitleNoiseEvidence],
) -> Vec<TitleNoisePattern> {
    let mut groups = BTreeMap::<String, BTreeSet<usize>>::new();
    for evidence in evidence {
        for text in boundary_title_noise_text_candidates(kind, &evidence.title) {
            if !boundary_title_noise_occurrence_has_external_anchor(kind, &evidence.title, text) {
                continue;
            }
            groups
                .entry(text.to_string())
                .or_default()
                .insert(evidence.source_index);
        }
    }

    groups
        .into_iter()
        .filter_map(|(text, indexes)| {
            let support = indexes.len();
            (support >= 2).then(|| TitleNoisePattern {
                word_count: title_word_count(&text),
                kind,
                text,
                support,
            })
        })
        .collect()
}

fn boundary_title_noise_text_candidates(kind: TitleNoisePatternKind, title: &str) -> Vec<&str> {
    let mut candidates = Vec::new();
    match kind {
        TitleNoisePatternKind::Prefix => {
            for (end, _) in title.char_indices().skip(1) {
                let text = &title[..end];
                if title_noise_affix_span_is_semantic_boundary(title, 0, end)
                    && (boundary_title_noise_text_is_candidate(kind, text)
                        || prefix_before_opening_bracket_is_candidate(title, end))
                {
                    candidates.push(text);
                }
            }
        }
        TitleNoisePatternKind::Suffix => {
            for (start, _) in title.char_indices().skip(1) {
                let text = &title[start..];
                if title_noise_affix_span_is_semantic_boundary(title, start, title.len())
                    && boundary_title_noise_text_is_candidate(kind, text)
                {
                    candidates.push(text);
                }
            }
        }
        TitleNoisePatternKind::Bracketed => {}
    }
    candidates
}

fn boundary_title_noise_occurrence_has_external_anchor(
    kind: TitleNoisePatternKind,
    title: &str,
    text: &str,
) -> bool {
    title_noise_affix_deletion_span(kind, title, text).is_some_and(|span| {
        span.start < span.end
            && !span.is_whole(title)
            && title_noise_affix_residue_is_valid(title, span)
    })
}

fn boundary_title_noise_text_is_candidate(kind: TitleNoisePatternKind, text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() || !title_noise_text_has_language_character(text) {
        return false;
    }

    match kind {
        TitleNoisePatternKind::Prefix => {
            let first = text.chars().next();
            let last = text.chars().next_back();
            first.is_some_and(is_title_affix_separator)
                || last.is_some_and(|character| {
                    is_title_affix_separator(character) || is_title_bracket(character)
                })
                || !unmatched_opening_brackets(text).is_empty()
        }
        TitleNoisePatternKind::Suffix => text.chars().next().is_some_and(|character| {
            is_title_affix_separator(character) || is_title_bracket(character)
        }),
        TitleNoisePatternKind::Bracketed => false,
    }
}

fn prefix_before_opening_bracket_is_candidate(title: &str, end: usize) -> bool {
    title[end..]
        .chars()
        .next()
        .is_some_and(|character| opening_bracket_pair(character).is_some())
        && title_noise_text_has_language_character(&title[..end])
}

fn repeated_bracketed_title_noise_patterns(
    evidence: &[TitleNoiseEvidence],
) -> Vec<TitleNoisePattern> {
    let mut groups = BTreeMap::<String, BTreeSet<usize>>::new();
    for evidence in evidence {
        for (start, end) in balanced_bracket_spans(&evidence.title) {
            if start == 0 && end == evidence.title.len() {
                continue;
            }
            let text = &evidence.title[start..end];
            if bracketed_title_noise_text_is_candidate(text) {
                groups
                    .entry(text.to_string())
                    .or_default()
                    .insert(evidence.source_index);
            }
        }
    }

    groups
        .into_iter()
        .filter_map(|(text, indexes)| {
            let support = indexes.len();
            (support >= 2).then(|| TitleNoisePattern {
                word_count: title_word_count(&text),
                kind: TitleNoisePatternKind::Bracketed,
                text,
                support,
            })
        })
        .collect()
}

fn bracketed_title_noise_text_is_candidate(text: &str) -> bool {
    title_noise_text_has_language_character(text)
}

fn title_noise_text_has_language_character(text: &str) -> bool {
    text.chars().any(char::is_alphabetic)
}

fn title_is_number_like_only(title: &str) -> bool {
    if title_is_plain_number_index(title) {
        return true;
    }

    let normalized = title_noise_canonical_key(title);
    for marker in ["pt", "part"] {
        let Some(rest) = normalized.strip_prefix(marker) else {
            continue;
        };
        let rest = rest.trim_start_matches(|character: char| {
            character.is_whitespace()
                || matches!(
                    character,
                    '#' | '.' | '-' | '–' | '—' | '_' | ':' | ';' | '/' | '\\'
                )
        });
        if title_is_plain_number_index(rest) {
            return true;
        }
    }

    false
}

fn title_is_plain_number_index(title: &str) -> bool {
    let mut has_digit = false;
    for character in title.chars() {
        if character.is_ascii_digit() {
            has_digit = true;
            continue;
        }
        if character.is_whitespace()
            || matches!(
                character,
                '#' | '.' | '-' | '–' | '—' | '_' | ':' | ';' | '/' | '\\' | '(' | ')' | '[' | ']'
            )
        {
            continue;
        }
        return false;
    }
    has_digit
}

fn title_noise_canonical_key(text: &str) -> String {
    let mut normalized = String::new();
    let mut previous_was_space = false;
    for character in text.chars().flat_map(char::to_lowercase) {
        let character = match character {
            '：' => ':',
            '｜' => '|',
            '“' | '”' | '"' | '\'' | '’' | '‘' => ' ',
            '–' | '—' | '_' => '-',
            _ => character,
        };
        if character.is_whitespace() {
            if !previous_was_space {
                normalized.push(' ');
            }
            previous_was_space = true;
            continue;
        }
        normalized.push(character);
        previous_was_space = false;
    }
    normalized.trim().to_string()
}

fn repair_normalized_titles_from_source_evidence(
    normalized: &mut [String],
    evidence: &[TitleNoiseEvidence],
) {
    let mut evidence_by_source = vec![Vec::<&str>::new(); normalized.len()];
    for evidence in evidence {
        if let Some(source_evidence) = evidence_by_source.get_mut(evidence.source_index) {
            source_evidence.push(evidence.title.as_str());
        }
    }

    for (source_index, title) in normalized.iter_mut().enumerate() {
        let current_damage = title_bracket_damage_score(title);
        let needs_source_repair = title_needs_source_evidence_repair(title);
        if current_damage == 0 && !needs_source_repair {
            continue;
        }
        let Some(repaired) = evidence_by_source
            .get(source_index)
            .and_then(|source_evidence| best_source_evidence_title_repair(title, source_evidence))
        else {
            continue;
        };
        *title = repaired;
    }
}

fn best_source_evidence_title_repair(current: &str, source_evidence: &[&str]) -> Option<String> {
    let current_damage = title_bracket_damage_score(current);
    let current_needs_source_repair = title_needs_source_evidence_repair(current);
    source_evidence
        .iter()
        .map(|candidate| cleanup_title_after_noise_deletion(candidate))
        .filter(|candidate| {
            candidate != current
                && title_noise_text_has_language_character(candidate)
                && (title_bracket_damage_score(candidate) < current_damage
                    || (current_needs_source_repair
                        && !title_needs_source_evidence_repair(candidate)
                        && title_bracket_damage_score(candidate) <= current_damage))
        })
        .max_by_key(|candidate| {
            (
                current_damage.saturating_sub(title_bracket_damage_score(candidate)),
                usize::from(current_needs_source_repair),
                title_word_count(candidate),
                candidate.chars().count(),
            )
        })
}

fn title_needs_source_evidence_repair(title: &str) -> bool {
    let normalized = title_noise_canonical_key(title);
    title_is_catalog_number_without_title(&normalized) || title_is_catalog_shell(&normalized)
}

fn title_is_catalog_number_without_title(normalized: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "ブルーアーカイブ blue archive ost ",
        "blue archive ost ",
        "minecraft volume alpha - ",
    ];

    for prefix in PREFIXES {
        let Some(rest) = normalized.strip_prefix(prefix) else {
            continue;
        };
        let rest = rest.trim_matches(|character: char| {
            character.is_whitespace() || is_dangling_title_separator(character) || character == '.'
        });
        if !rest.is_empty() && rest.chars().all(|character| character.is_ascii_digit()) {
            return true;
        }
    }
    false
}

fn title_is_catalog_shell(normalized: &str) -> bool {
    matches!(
        normalized,
        "cyberpunk 2077 ost"
            | "death stranding ost"
            | "death stranding 2 on the beach original video game score"
            | "tenet official soundtrack"
            | "tenet official soundtrack - watertower music"
            | "zwei2 original soundtrack"
    )
}

fn balanced_bracket_spans(title: &str) -> Vec<(usize, usize)> {
    let mut stack = Vec::<(char, usize)>::new();
    let mut spans = Vec::new();
    for (index, character) in title.char_indices() {
        if opening_bracket_pair(character).is_some() {
            stack.push((character, index));
            continue;
        }

        let Some(expected_opening) = closing_bracket_pair(character) else {
            continue;
        };
        if stack
            .last()
            .is_some_and(|(opening, _)| *opening == expected_opening)
        {
            let (_, start) = stack.pop().expect("matching bracket is on stack");
            spans.push((start, index + character.len_utf8()));
        }
    }

    spans
}

fn apply_title_noise_pattern(title: &str, pattern: &TitleNoisePattern) -> String {
    if pattern.text.is_empty() {
        return title.to_string();
    }

    match pattern.kind {
        TitleNoisePatternKind::Prefix => {
            if !title.starts_with(&pattern.text) {
                return title.to_string();
            }
            delete_title_noise_affix_occurrence(pattern.kind, title, &pattern.text)
        }
        TitleNoisePatternKind::Suffix => {
            if !title.ends_with(&pattern.text) {
                return title.to_string();
            }
            delete_title_noise_affix_occurrence(pattern.kind, title, &pattern.text)
        }
        TitleNoisePatternKind::Bracketed => {
            remove_title_noise_fragment_occurrences(title, &pattern.text)
        }
    }
}

fn title_noise_pattern_rank(pattern: &TitleNoisePattern) -> (usize, usize, usize, usize) {
    let kind_rank = match pattern.kind {
        TitleNoisePatternKind::Prefix => 1,
        TitleNoisePatternKind::Suffix => 2,
        TitleNoisePatternKind::Bracketed => 3,
    };
    (
        pattern.word_count,
        pattern.support,
        pattern.text.chars().count(),
        kind_rank,
    )
}

#[derive(Debug, Clone)]
struct TitleNoisePattern {
    kind: TitleNoisePatternKind,
    text: String,
    support: usize,
    word_count: usize,
}

#[derive(Debug, Clone)]
struct TitleNoiseEvidence {
    source_index: usize,
    title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TitleNoisePatternKind {
    Prefix,
    Suffix,
    Bracketed,
}

fn delete_title_noise_affix_occurrence(
    kind: TitleNoisePatternKind,
    title: &str,
    noise: &str,
) -> String {
    let Some(span) = title_noise_affix_deletion_span(kind, title, noise) else {
        return title.to_string();
    };
    if span.is_whole(title) {
        return title.to_string();
    }

    let normalized = delete_title_span(title, span);
    if !title_stable_residue_is_valid(&normalized) {
        return title.to_string();
    }
    if title_bracket_damage_score(&normalized) > title_bracket_damage_score(title) {
        return title.to_string();
    }

    normalized
}

fn remove_title_noise_fragment_occurrences(title: &str, fragment: &str) -> String {
    let mut normalized = title.to_string();
    while let Some(start) = normalized.find(fragment) {
        let Some(span) = TitleTextSpan::new(&normalized, start, start + fragment.len()) else {
            break;
        };
        if span.is_whole(&normalized) {
            break;
        }
        let next = delete_title_span(&normalized, span);
        if !title_noise_text_has_language_character(&next) {
            break;
        }
        if next == normalized {
            break;
        }
        normalized = next;
    }
    normalized
}

fn cleanup_title_after_noise_deletion(title: &str) -> String {
    let normalized = title.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized
        .trim_matches(|character: char| {
            character.is_whitespace() || is_dangling_title_separator(character)
        })
        .trim()
        .to_string()
}

fn title_noise_affix_residue_is_valid(title: &str, span: TitleTextSpan) -> bool {
    let residue = delete_title_span(title, span);
    title_stable_residue_is_valid(&residue)
        && title_bracket_damage_score(&residue) <= title_bracket_damage_score(title)
}

fn title_noise_affix_span_is_semantic_boundary(title: &str, start: usize, end: usize) -> bool {
    (start == 0 || title_text_boundary_is_semantic(title, start))
        && (end == title.len() || title_text_boundary_is_semantic(title, end))
}

fn title_text_boundary_is_semantic(title: &str, index: usize) -> bool {
    let previous = title[..index].chars().next_back();
    let next = title[index..].chars().next();
    if title_text_boundary_is_inside_word_apostrophe(title, index, previous, next) {
        return false;
    }
    !previous.is_some_and(char::is_alphanumeric) || !next.is_some_and(char::is_alphanumeric)
}

fn title_text_boundary_is_inside_word_apostrophe(
    title: &str,
    index: usize,
    previous: Option<char>,
    next: Option<char>,
) -> bool {
    if previous.is_some_and(is_title_word_apostrophe) && next.is_some_and(is_ascii_alphabetic) {
        return title[..index]
            .chars()
            .rev()
            .nth(1)
            .is_some_and(is_ascii_alphabetic);
    }
    if next.is_some_and(is_title_word_apostrophe) && previous.is_some_and(is_ascii_alphabetic) {
        return title[index + next.expect("next was checked").len_utf8()..]
            .chars()
            .next()
            .is_some_and(is_ascii_alphabetic);
    }
    false
}

fn is_title_word_apostrophe(character: char) -> bool {
    matches!(character, '\'' | '’' | 'ʼ' | '`' | '´')
}

fn is_ascii_alphabetic(character: char) -> bool {
    character.is_ascii_alphabetic()
}

fn is_dangling_title_separator(character: char) -> bool {
    matches!(
        character,
        '-' | '–' | '—' | '/' | '\\' | '|' | ':' | ';' | '_' | '•'
    )
}

fn title_noise_affix_deletion_span(
    kind: TitleNoisePatternKind,
    title: &str,
    noise: &str,
) -> Option<TitleTextSpan> {
    match kind {
        TitleNoisePatternKind::Prefix => {
            if !title.starts_with(noise) {
                return None;
            }
            let mut end = noise.len();
            let openings = unmatched_opening_brackets(noise);
            if !openings.is_empty() {
                end = openings.first().map(|opening| opening.index).unwrap_or(end);
            }
            TitleTextSpan::new(title, 0, end)
        }
        TitleNoisePatternKind::Suffix => {
            if !title.ends_with(noise) {
                return None;
            }
            let mut start = title.len() - noise.len();
            let closings = unmatched_closing_brackets(noise);
            if !closings.is_empty() {
                start += closings
                    .last()
                    .map(|closing| closing.index + closing.character.len_utf8())
                    .unwrap_or(0);
            }
            TitleTextSpan::to_end(title, start)
        }
        TitleNoisePatternKind::Bracketed => None,
    }
}

#[derive(Debug, Clone, Copy)]
struct BracketBoundary {
    character: char,
    index: usize,
}

fn unmatched_opening_brackets(prefix: &str) -> Vec<BracketBoundary> {
    let mut stack = Vec::new();
    for (index, character) in prefix.char_indices() {
        if opening_bracket_pair(character).is_some() {
            stack.push(BracketBoundary { character, index });
            continue;
        }

        let Some(expected_opening) = closing_bracket_pair(character) else {
            continue;
        };
        if stack
            .last()
            .is_some_and(|opening| opening.character == expected_opening)
        {
            stack.pop();
        }
    }
    stack
}

fn unmatched_closing_brackets(suffix: &str) -> Vec<BracketBoundary> {
    let mut opening_stack = Vec::new();
    let mut closings = Vec::new();
    for (index, character) in suffix.char_indices() {
        if opening_bracket_pair(character).is_some() {
            opening_stack.push(character);
            continue;
        }

        let Some(expected_opening) = closing_bracket_pair(character) else {
            continue;
        };
        if opening_stack
            .last()
            .is_some_and(|opening| *opening == expected_opening)
        {
            opening_stack.pop();
            continue;
        }

        closings.push(BracketBoundary { character, index });
    }
    closings
}

fn title_bracket_damage_score(title: &str) -> usize {
    unmatched_opening_brackets(title).len() + unmatched_closing_brackets(title).len()
}

fn opening_bracket_pair(character: char) -> Option<char> {
    match character {
        '(' => Some(')'),
        '[' => Some(']'),
        '{' => Some('}'),
        '<' => Some('>'),
        _ => None,
    }
}

fn closing_bracket_pair(character: char) -> Option<char> {
    match character {
        ')' => Some('('),
        ']' => Some('['),
        '}' => Some('{'),
        '>' => Some('<'),
        _ => None,
    }
}

fn is_title_bracket(character: char) -> bool {
    opening_bracket_pair(character).is_some() || closing_bracket_pair(character).is_some()
}

fn title_word_count(title: &str) -> usize {
    let mut count = 0usize;
    let mut in_word = false;
    for character in title.chars() {
        if character.is_alphanumeric() {
            if !in_word {
                count += 1;
                in_word = true;
            }
            continue;
        }
        in_word = false;
    }
    count
}

fn is_title_affix_separator(character: char) -> bool {
    !character.is_alphanumeric() && !character.is_whitespace()
}

fn inherit_existing_music_lifecycle(musics: &mut [Music], existing_musics: &[Music]) {
    let lifecycle = existing_musics
        .iter()
        .map(|music| {
            (
                (music.url.as_str(), music.group.url.as_str(), music.start_ms),
                music,
            )
        })
        .collect::<HashMap<_, _>>();

    for music in musics {
        if let Some(existing) =
            lifecycle.get(&(music.url.as_str(), music.group.url.as_str(), music.start_ms))
        {
            inherit_existing_music_lifecycle_fields(music, existing);
        }
    }
}

fn inherit_existing_music_lifecycle_fields(music: &mut Music, existing: &Music) {
    music.alias = existing.alias.clone();
    music.liked = existing.liked;

    if existing.end_ms < music.end_ms && existing.start_ms < existing.end_ms {
        music.end_ms = existing.end_ms;
        music.canonical_music_id =
            canonical_music_id_for_source(&music.url, music.start_ms, music.end_ms);
    }

    if existing.canonical_music_id == music.canonical_music_id {
        music.loudness_profile = existing.loudness_profile;
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
    group: &Group,
    save_root: &Path,
    except: Option<&Path>,
) -> Result<()> {
    let mut seen_paths = std::collections::BTreeSet::new();
    for music in &collection.musics {
        if music.url != leaf_url || music.group.url != group.url {
            continue;
        }

        let Some(relative_path) = &music.path else {
            continue;
        };
        if !seen_paths.insert(relative_path.clone()) {
            continue;
        }

        let absolute_path = save_root.join(&collection.folder).join(relative_path);
        if except.is_some_and(|except| except == absolute_path) {
            continue;
        }
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
            notify_audio_style_inputs_changed("download_recovery_music_restored");
            notify_playlist_playback_library_changed();
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

    let default_group = collection_owner_group(collection);
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
            occurrence_id: String::new(),
            name: name.clone(),
            alias: name,
            group: default_group.clone(),
            canonical_music_id: canonical_music_id_for_source(&leaf.url, 0, leaf_duration_ms(leaf)),
            url: leaf.url.clone(),
            path: Some(relative_path.to_string()),
            start_ms: 0,
            end_ms: leaf_duration_ms(leaf),
            liked: false,
            loudness_profile: None,
        });
    }

    restored
}

fn notify_audio_style_inputs_changed(_reason: &'static str) {
    #[cfg(not(test))]
    playlist_playback_service::notify_music_library_inputs_changed(_reason);
}

fn notify_playlist_playback_library_changed() {
    #[cfg(not(test))]
    playlist_playback_service::notify_playable_library_changed();
}

fn seconds_to_millis(seconds: u32) -> u32 {
    seconds.saturating_mul(1_000)
}

fn probe_duration_ms(probe: &LeafProbe) -> u32 {
    probe
        .duration_ms
        .unwrap_or_else(|| seconds_to_millis(probe.duration_seconds.unwrap_or(0)))
}

fn leaf_duration_ms(leaf: &DownloadLeaf) -> u32 {
    leaf.duration_ms
        .unwrap_or_else(|| seconds_to_millis(leaf.duration_seconds.unwrap_or(0)))
}

fn collection_folder_from_local_path(save_root: &Path, collection_path: &Path) -> Result<String> {
    let save_root = save_root
        .canonicalize()
        .unwrap_or_else(|_| save_root.to_path_buf());
    match collection_path.strip_prefix(&save_root) {
        Ok(relative) if !relative.as_os_str().is_empty() => normalize_relative_path_text(relative),
        _ => Ok(normalize_path_text(&collection_path.to_string_lossy())),
    }
}

fn read_collection_manifest(collection_path: &Path) -> Result<Option<CollectionManifest>> {
    read_collection_manifest_file(&collection_path.join(COLLECTION_MANIFEST_FILE_NAME))
}

fn read_collection_manifest_file(manifest_path: &Path) -> Result<Option<CollectionManifest>> {
    if !manifest_path.is_file() {
        return Ok(None);
    }

    let text = std::fs::read_to_string(&manifest_path)
        .with_context(|| format!("failed to read {}", manifest_path.display()))?;
    let manifest = toml::from_str::<CollectionManifest>(&text)
        .with_context(|| format!("failed to parse {}", manifest_path.display()))?;
    if manifest.version != 1 {
        bail!(
            "unsupported collection manifest version {} in {}",
            manifest.version,
            manifest_path.display()
        );
    }

    Ok(Some(manifest))
}

fn collection_from_manifest(
    collection_folder: String,
    manifest: CollectionManifest,
    local_audio_files: &[LocalAudioFile],
) -> Result<Collection> {
    let local_files_by_path = local_audio_files
        .iter()
        .map(|file| (file.relative_path.clone(), file))
        .collect::<BTreeMap<_, _>>();
    let collection_shell = Collection {
        name: manifest.collection.name.clone(),
        url: manifest.collection.url.clone(),
        folder: collection_folder.clone(),
        musics: vec![],
        last_updated: manifest
            .collection
            .last_updated
            .clone()
            .unwrap_or_else(now_timestamp),
        enable_updates: manifest.collection.enable_updates,
    };
    let collection_owner = collection_owner_group(&collection_shell);
    let groups = manifest
        .groups
        .into_iter()
        .map(|group| {
            let group = group.into_group(
                &manifest.collection.url,
                &collection_folder,
                &collection_shell,
            )?;
            Ok((group.url.clone(), group))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;

    let collection_name = manifest.collection.name;
    let collection_url = manifest.collection.url;
    let collection_last_updated = manifest
        .collection
        .last_updated
        .unwrap_or_else(now_timestamp);
    let collection_enable_updates = manifest.collection.enable_updates;
    let mut musics = Vec::new();
    let mut seen = HashSet::new();
    let mut manifest_file_paths = HashSet::new();

    for music in manifest.musics {
        let relative_path = normalize_manifest_relative_path(&music.path)?;
        let Some(local_file) = local_files_by_path.get(&relative_path) else {
            continue;
        };
        if music.end_ms > local_file.duration_ms.saturating_add(1_000) {
            continue;
        }
        let end_ms = restore_manifest_music_end_ms_from_local_file(&music, local_file);
        if !seen.insert((
            music.url.clone(),
            music.group_url.clone(),
            music.start_ms,
            end_ms,
            relative_path.clone(),
        )) {
            continue;
        }

        let group = resolve_manifest_music_group(
            &music.group_url,
            &collection_url,
            &collection_owner,
            &groups,
        );
        let Some(group) = group else {
            continue;
        };
        let name = music.name.trim();
        let name = if name.is_empty() {
            local_music_name_from_path(Path::new(&relative_path))
        } else {
            name.to_string()
        };
        let alias = music.alias.trim();
        let alias = if alias.is_empty() {
            name.clone()
        } else {
            alias.to_string()
        };

        if music.start_ms >= end_ms {
            continue;
        }

        manifest_file_paths.insert(relative_path.clone());
        musics.push(Music {
            occurrence_id: String::new(),
            name,
            alias,
            group,
            canonical_music_id: canonical_music_id_for_source(&music.url, music.start_ms, end_ms),
            url: music.url,
            path: Some(relative_path),
            start_ms: music.start_ms,
            end_ms,
            liked: music.liked,
            loudness_profile: None,
        });
    }

    for local_file in local_audio_files {
        if manifest_file_paths.contains(&local_file.relative_path) {
            continue;
        }

        let music = local_music_from_audio_file(&collection_url, &collection_owner, local_file);
        if seen.insert((
            music.url.clone(),
            music.group.url.clone(),
            music.start_ms,
            music.end_ms,
            local_file.relative_path.clone(),
        )) {
            musics.push(music);
        }
    }

    Ok(Collection {
        name: collection_name,
        url: collection_url,
        folder: collection_folder.clone(),
        musics,
        last_updated: collection_last_updated,
        enable_updates: collection_enable_updates,
    })
}

fn collection_from_local_audio_files(
    collection_path: &Path,
    collection_folder: &str,
    local_audio_files: &[LocalAudioFile],
) -> Result<Collection> {
    let collection_name = local_collection_name(collection_path);
    let collection_url = local_collection_url(collection_path)?;
    let collection_shell = Collection {
        name: collection_name.clone(),
        url: collection_url.clone(),
        folder: collection_folder.to_string(),
        musics: vec![],
        last_updated: now_timestamp(),
        enable_updates: None,
    };
    let group = collection_owner_group(&collection_shell);
    let mut musics = Vec::new();

    for file in local_audio_files {
        musics.push(local_music_from_audio_file(&collection_url, &group, file));
    }

    Ok(Collection {
        name: collection_name,
        url: collection_url,
        folder: collection_folder.to_string(),
        musics,
        last_updated: collection_shell.last_updated,
        enable_updates: None,
    })
}

fn local_collection_name(collection_path: &Path) -> String {
    collection_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Local Collection")
        .to_string()
}

fn collect_local_audio_files(
    collection_path: &Path,
    ffmpeg_path: &Path,
) -> Result<Vec<LocalAudioFile>> {
    let mut files = Vec::new();
    for file_path in local_collection_file_candidates(collection_path) {
        let relative_path = normalize_local_relative_path(collection_path, &file_path)?;
        let Some(probe) = probe_local_audio_file(ffmpeg_path, &file_path)? else {
            continue;
        };
        if probe.duration_ms == 0 {
            continue;
        }

        files.push(LocalAudioFile {
            absolute_path: file_path,
            relative_path,
            duration_ms: probe.duration_ms,
        });
    }

    Ok(files)
}

#[cfg(test)]
fn collect_manifest_audio_file_paths(
    collection_path: &Path,
    manifest_paths: &HashSet<String>,
    local_duration_probe: &impl Fn(&Path) -> Result<Option<u32>>,
) -> Result<Vec<LocalAudioFile>> {
    let mut files = Vec::new();
    for file_path in local_collection_file_candidates(collection_path) {
        let relative_path = normalize_local_relative_path(collection_path, &file_path)?;
        if !manifest_paths.contains(&relative_path) {
            continue;
        }

        let Some(duration_ms) = local_duration_probe(&file_path)? else {
            continue;
        };

        files.push(LocalAudioFile {
            absolute_path: file_path,
            relative_path,
            duration_ms,
        });
    }

    Ok(files)
}

fn restore_manifest_music_end_ms_from_local_file(
    music: &CollectionManifestMusic,
    local_file: &LocalAudioFile,
) -> u32 {
    if manifest_music_end_ms_targets_local_file_boundary(music.end_ms, local_file.duration_ms) {
        local_file.duration_ms
    } else {
        music.end_ms
    }
}

fn manifest_music_end_ms_targets_local_file_boundary(end_ms: u32, duration_ms: u32) -> bool {
    if end_ms == duration_ms {
        return true;
    }

    if end_ms % 1_000 == 0 {
        return audio_duration_boundary_matches(end_ms, duration_ms);
    }

    end_ms.abs_diff(duration_ms) <= LOCAL_AUDIO_PRECISE_DURATION_BOUNDARY_TOLERANCE_MS
}

fn local_collection_file_candidates(collection_path: &Path) -> Vec<PathBuf> {
    let mut files = WalkDir::new(collection_path)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(|name| name != COLLECTION_MANIFEST_FILE_NAME)
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| {
        normalize_music_file_path_key(left).cmp(&normalize_music_file_path_key(right))
    });
    files
}

fn probe_local_audio_file(ffmpeg_path: &Path, file_path: &Path) -> Result<Option<LocalAudioProbe>> {
    Ok(probe_downloaded_audio_duration_ms(ffmpeg_path, file_path)?
        .map(|duration_ms| LocalAudioProbe { duration_ms }))
}

fn local_collection_url(collection_path: &Path) -> Result<String> {
    Ok(format!(
        "local://collection/{}",
        short_hash(&collection_path.canonicalize()?.to_string_lossy())
    ))
}

fn local_music_url(collection_url: &str, relative_path: &str) -> String {
    format!("{collection_url}#{}", relative_path.replace('\\', "/"))
}

fn local_music_name_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled")
                .to_string()
        })
}

fn local_music_from_audio_file(
    collection_url: &str,
    group: &Group,
    file: &LocalAudioFile,
) -> Music {
    let name = local_music_name_from_path(&file.absolute_path);
    let url = local_music_url(collection_url, &file.relative_path);
    Music {
        occurrence_id: String::new(),
        name: name.clone(),
        alias: name,
        group: group.clone(),
        canonical_music_id: canonical_music_id_for_source(&url, 0, file.duration_ms),
        url,
        path: Some(file.relative_path.clone()),
        start_ms: 0,
        end_ms: file.duration_ms,
        liked: false,
        loudness_profile: None,
    }
}

fn manifest_from_raw_leaf_evidence(
    collection: &Collection,
    source_kind: CollectionSourceKind,
    probe: &LeafProbe,
    relative_path: &str,
    group: &Group,
) -> CollectionManifest {
    let musics = materialize_music_entries(probe, relative_path, group.clone())
        .into_iter()
        .map(collection_manifest_music_from_music)
        .collect();
    let groups = (group.url != collection.url)
        .then(|| CollectionManifestGroup {
            name: group.name.clone(),
            url: group.url.clone(),
            folder: group.folder.clone(),
        })
        .into_iter()
        .collect();

    CollectionManifest {
        version: 1,
        collection: CollectionManifestCollection {
            name: collection.name.clone(),
            url: collection.url.clone(),
            folder: collection.folder.clone(),
            source_kind: Some(source_kind),
            enable_updates: collection.enable_updates,
            last_updated: Some(collection.last_updated.clone()),
        },
        groups,
        musics,
    }
}

fn collection_manifest_music_from_music(music: Music) -> CollectionManifestMusic {
    CollectionManifestMusic {
        name: music.name,
        alias: music.alias,
        url: music.url,
        path: normalize_path_text(music.path.as_deref().unwrap_or_default()),
        group_url: music.group.url,
        start_ms: music.start_ms,
        end_ms: music.end_ms,
        liked: music.liked,
    }
}

fn resolve_manifest_music_group(
    group_url: &str,
    collection_url: &str,
    collection_owner: &Group,
    groups: &BTreeMap<String, Group>,
) -> Option<Group> {
    if group_url == collection_url {
        return Some(collection_owner.clone());
    }

    groups.get(group_url).cloned()
}

fn write_raw_leaf_manifest_file(
    collection_root: &Path,
    manifest: &CollectionManifest,
) -> Result<()> {
    std::fs::create_dir_all(collection_root)
        .with_context(|| format!("failed to create {}", collection_root.display()))?;
    let manifest_path = collection_root.join(COLLECTION_MANIFEST_FILE_NAME);
    let manifest = match read_collection_manifest_file(&manifest_path)? {
        Some(existing) => merge_raw_leaf_manifest_evidence(existing, manifest.clone()),
        None => manifest.clone(),
    };
    let text =
        toml::to_string_pretty(&manifest).context("failed to serialize collection manifest")?;
    std::fs::write(&manifest_path, text)
        .with_context(|| format!("failed to write {}", manifest_path.display()))
}

fn merge_raw_leaf_manifest_evidence(
    existing: CollectionManifest,
    next: CollectionManifest,
) -> CollectionManifest {
    if existing.collection.url != next.collection.url {
        return next;
    }

    let next_file_scopes = next
        .musics
        .iter()
        .map(collection_manifest_music_file_scope)
        .collect::<HashSet<_>>();
    let CollectionManifest {
        version,
        collection,
        groups,
        musics,
    } = existing;
    let retained_musics = musics
        .into_iter()
        .filter(|music| !next_file_scopes.contains(&collection_manifest_music_file_scope(music)));

    let mut merged = CollectionManifest {
        version,
        collection,
        groups,
        musics: retained_musics.collect(),
    };

    let mut group_urls = merged
        .groups
        .iter()
        .map(|group| group.url.clone())
        .collect::<HashSet<_>>();
    for group in next.groups {
        if group_urls.insert(group.url.clone()) {
            merged.groups.push(group);
        }
    }

    let mut music_keys = merged
        .musics
        .iter()
        .map(collection_manifest_music_key)
        .collect::<HashSet<_>>();
    for music in next.musics {
        let key = collection_manifest_music_key(&music);
        if music_keys.insert(key) {
            merged.musics.push(music);
        }
    }

    merged
}

fn collection_manifest_music_key(music: &CollectionManifestMusic) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        music.url,
        music.group_url,
        normalize_path_text(&music.path),
        music.start_ms,
        music.end_ms
    )
}

fn collection_manifest_music_file_scope(music: &CollectionManifestMusic) -> String {
    format!(
        "{}\n{}\n{}",
        music.url,
        music.group_url,
        normalize_path_text(&music.path)
    )
}

impl CollectionManifestGroup {
    fn into_group(
        self,
        collection_url: &str,
        collection_folder: &str,
        collection: &Collection,
    ) -> Result<Group> {
        let folder = if self.url == collection_url {
            collection_folder.to_string()
        } else {
            normalize_manifest_relative_path(&self.folder)?
        };

        Ok(Group {
            name: self.name,
            url: self.url,
            collection: collection_group_owner(collection),
            folder,
        })
    }
}

fn normalize_manifest_relative_path(path: &str) -> Result<String> {
    let path = Path::new(path.trim());
    if path.is_absolute() {
        bail!("collection manifest music path must be relative");
    }

    normalize_relative_path_text(path)
}

fn normalize_local_relative_path(collection_path: &Path, file_path: &Path) -> Result<String> {
    let relative = file_path.strip_prefix(collection_path).with_context(|| {
        format!(
            "{} is not inside {}",
            file_path.display(),
            collection_path.display()
        )
    })?;

    normalize_relative_path_text(relative)
}

fn normalize_relative_path_text(path: &Path) -> Result<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let text = value
                    .to_str()
                    .context("collection path contains non-unicode component")?
                    .trim();
                if text.is_empty() {
                    bail!("collection path contains an empty component");
                }
                parts.push(text.to_string());
            }
            Component::CurDir => {}
            _ => bail!("collection path must stay relative to the collection folder"),
        }
    }

    if parts.is_empty() {
        bail!("collection path is empty");
    }

    Ok(parts.join("/"))
}

fn normalize_path_text(path: &str) -> String {
    path.replace('\\', "/")
}

fn normalize_music_file_path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}
