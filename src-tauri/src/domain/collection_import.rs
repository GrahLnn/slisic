#[cfg(not(test))]
use crate::domain::downloads::model::DownloadTaskStatus;
use crate::domain::downloads::model::{
    CollectionSourceKind, DownloadLeaf, DownloadResourceProbe, DownloadTask, DownloadTrigger,
    PastedDownloadUrlResolution, now_timestamp,
};
use crate::domain::downloads::naming::{
    provider_segment, sanitize_path_component, short_hash, stable_id,
};
use crate::domain::downloads::repo as download_repo;
#[cfg(not(test))]
use crate::domain::downloads::service::{
    DownloadTaskChangeSignal, publish_download_task_change, try_claim_task,
};
use crate::domain::downloads::yt_dlp::{LeafProbe, RootProbe};
#[cfg(not(test))]
use crate::domain::playlist_playback::recommendation::notify_audio_style_training_inputs_changed;
use crate::domain::playlists::model::{Collection, Group, Music, canonical_music_id_for_source};
use crate::domain::playlists::repo as collection_repo;
use anyhow::{Context, Result, bail};
use appdb::Id;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
#[cfg(not(test))]
use tokio::sync::broadcast;
use walkdir::WalkDir;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const COLLECTION_MANIFEST_FILE_NAME: &str = ".slisic.collection.toml";
const LOCAL_AUDIO_PROBE_SAMPLE_RATE: u32 = 48_000;
const TEMP_DOWNLOAD_MARKER: &str = ".__slisic_tmp__";

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
    #[serde(default = "default_manifest_version")]
    version: u32,
    collection: CollectionManifestCollection,
    #[serde(default)]
    groups: Vec<CollectionManifestGroup>,
    #[serde(default, rename = "music")]
    musics: Vec<CollectionManifestMusic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CollectionManifestCollection {
    name: String,
    url: String,
    folder: String,
    #[serde(default)]
    source_kind: Option<CollectionSourceKind>,
    #[serde(default)]
    enable_updates: Option<bool>,
    #[serde(default)]
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
    #[serde(default)]
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

fn default_manifest_version() -> u32 {
    1
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

pub(crate) async fn load_collection_shell(plan: &CollectionSyncPlan) -> Result<Collection> {
    let existing = collection_repo::get_collection_by_url(&plan.collection_url).await?;
    Ok(create_collection_shell(plan, existing))
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
    for leaf in &plan.leaves {
        if task.leafs.iter().any(|existing| existing.id == leaf.id) {
            continue;
        }

        task.leafs.push(DownloadLeaf::new(
            leaf.id.clone(),
            leaf.url.clone(),
            leaf.sequence,
        ));
    }
    task.leafs.sort_by_key(|leaf| leaf.sequence);
    task.refresh_counts();
}

pub(crate) async fn persist_enqueued_collection_shell(
    mut task: DownloadTask,
    plan: &CollectionShellPlan,
) -> Result<(DownloadTask, Collection)> {
    let existing = collection_repo::get_collection_by_url(&plan.collection_url).await?;
    let collection =
        collection_repo::upsert_collection(&create_collection_shell_from_plan(plan, existing))
            .await?;
    apply_collection_shell_plan_to_task(&mut task, plan);
    task.last_error = None;
    task.refresh_counts();
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
    let mut materialized = materialize_music_entries(probe, file_name, group);
    inherit_existing_music_aliases(&mut materialized, &collection.musics);
    if source_kind == CollectionSourceKind::Single {
        collection.musics = materialized;
    } else {
        let replacement_group_url = materialized
            .first()
            .map(|music| music.group.url.clone())
            .unwrap_or_default();
        collection.musics.retain(|music| {
            music.url != probe.webpage_url || music.group.url != replacement_group_url
        });
        collection.musics.append(&mut materialized);
    }
    normalize_music_titles_within_collection(collection);
    collection.last_updated = now_timestamp();
    let saved = collection_repo::upsert_collection(collection).await?;
    *collection = saved;
    notify_audio_style_inputs_changed("downloaded_music_persisted");
    Ok(())
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

#[cfg(not(test))]
pub(crate) fn write_collection_manifest(
    collection_root: &Path,
    collection: &Collection,
    source_kind: CollectionSourceKind,
) -> Result<()> {
    let manifest = manifest_from_collection(collection, source_kind);
    write_collection_manifest_file(collection_root, &manifest)
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

pub(crate) fn finalize_downloaded_leaf(
    collection: &Collection,
    leaf_url: &str,
    group: &Group,
    save_root: &Path,
    _file_stem: &str,
    downloaded_path: PathBuf,
) -> Result<String> {
    let final_file_name = finalized_download_file_name(&downloaded_path)?;
    let relative_path = relative_music_path(collection, &final_file_name, group);
    let final_path = save_root.join(&collection.folder).join(&relative_path);

    remove_existing_leaf_files(collection, leaf_url, group, save_root)?;
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
            canonical_music_id: canonical_music_id_for_source(
                &probe.webpage_url,
                0,
                seconds_to_millis(probe.duration_seconds.unwrap_or(0)),
            ),
            url: probe.webpage_url.clone(),
            path: Some(relative_path.to_string()),
            start_ms: 0,
            end_ms: seconds_to_millis(probe.duration_seconds.unwrap_or(0)),
            liked: false,
        }];
    }

    probe
        .chapters
        .iter()
        .map(|chapter| Music {
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
        })
        .collect()
}

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
    let normalized = normalize_music_title_batch(&titles);
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
    let title_refs = titles.iter().map(String::as_str).collect::<Vec<_>>();
    normalize_common_music_title_affixes(&title_refs)
}

fn normalize_common_music_title_affixes(titles: &[&str]) -> Vec<String> {
    let tokenized = titles
        .iter()
        .map(|title| title_words(title))
        .collect::<Vec<_>>();
    if tokenized.iter().any(|words| words.len() < 2) {
        return titles.iter().map(|title| (*title).to_string()).collect();
    }

    let mut prefix_len = common_prefix_word_count(&tokenized);
    let mut suffix_len = common_suffix_word_count(&tokenized);
    let min_word_count = tokenized.iter().map(Vec::len).min().unwrap_or(0);
    while prefix_len + suffix_len >= min_word_count && suffix_len > 0 {
        suffix_len -= 1;
    }
    while prefix_len + suffix_len >= min_word_count && prefix_len > 0 {
        prefix_len -= 1;
    }

    if prefix_len > 0 && !common_prefix_is_removable(titles, &tokenized, prefix_len, suffix_len) {
        prefix_len = 0;
    }
    if suffix_len > 0 && !common_suffix_is_removable(titles, &tokenized, prefix_len, suffix_len) {
        suffix_len = 0;
    }

    titles
        .iter()
        .zip(tokenized.iter())
        .map(|(title, words)| {
            let start = if prefix_len == 0 {
                0
            } else {
                words[prefix_len].start
            };
            let end = if suffix_len == 0 {
                title.len()
            } else {
                words[words.len() - suffix_len - 1].end
            };
            title[start..end].trim().to_string()
        })
        .collect()
}

#[derive(Debug, Clone)]
struct TitleWord {
    normalized: String,
    start: usize,
    end: usize,
}

fn title_words(title: &str) -> Vec<TitleWord> {
    let mut words = Vec::new();
    let mut current_start = None;
    for (index, character) in title.char_indices() {
        if character.is_alphanumeric() {
            current_start.get_or_insert(index);
            continue;
        }
        if let Some(start) = current_start.take() {
            push_title_word(&mut words, title, start, index);
        }
    }
    if let Some(start) = current_start {
        push_title_word(&mut words, title, start, title.len());
    }
    words
}

fn push_title_word(words: &mut Vec<TitleWord>, title: &str, start: usize, end: usize) {
    words.push(TitleWord {
        normalized: title[start..end].to_lowercase(),
        start,
        end,
    });
}

fn common_prefix_word_count(tokenized: &[Vec<TitleWord>]) -> usize {
    let min_word_count = tokenized.iter().map(Vec::len).min().unwrap_or(0);
    let mut count = 0usize;
    'outer: while count < min_word_count {
        let value = &tokenized[0][count].normalized;
        for words in tokenized.iter().skip(1) {
            if words[count].normalized != *value {
                break 'outer;
            }
        }
        count += 1;
    }
    count
}

fn common_suffix_word_count(tokenized: &[Vec<TitleWord>]) -> usize {
    let min_word_count = tokenized.iter().map(Vec::len).min().unwrap_or(0);
    let mut count = 0usize;
    'outer: while count < min_word_count {
        let first_index = tokenized[0].len() - 1 - count;
        let value = &tokenized[0][first_index].normalized;
        for words in tokenized.iter().skip(1) {
            let index = words.len() - 1 - count;
            if words[index].normalized != *value {
                break 'outer;
            }
        }
        count += 1;
    }
    count
}

fn common_prefix_is_removable(
    titles: &[&str],
    tokenized: &[Vec<TitleWord>],
    prefix_len: usize,
    suffix_len: usize,
) -> bool {
    if prefix_len >= 2 {
        return true;
    }
    titles.iter().zip(tokenized.iter()).all(|(title, words)| {
        let kept_start = prefix_len;
        if kept_start + suffix_len >= words.len() {
            return false;
        }
        title[words[prefix_len - 1].end..words[kept_start].start]
            .chars()
            .any(is_title_affix_separator)
    })
}

fn common_suffix_is_removable(
    titles: &[&str],
    tokenized: &[Vec<TitleWord>],
    prefix_len: usize,
    suffix_len: usize,
) -> bool {
    if suffix_len >= 2 {
        return true;
    }
    titles.iter().zip(tokenized.iter()).all(|(title, words)| {
        if prefix_len + suffix_len >= words.len() {
            return false;
        }
        let suffix_start = words.len() - suffix_len;
        title[words[suffix_start - 1].end..words[suffix_start].start]
            .chars()
            .any(is_title_affix_separator)
    })
}

fn is_title_affix_separator(character: char) -> bool {
    !character.is_alphanumeric() && !character.is_whitespace()
}

fn inherit_existing_music_aliases(musics: &mut [Music], existing_musics: &[Music]) {
    let aliases = existing_musics
        .iter()
        .map(|music| {
            (
                (
                    music.url.as_str(),
                    music.group.url.as_str(),
                    music.start_ms,
                    music.end_ms,
                ),
                music.alias.as_str(),
            )
        })
        .collect::<HashMap<_, _>>();

    for music in musics {
        if let Some(alias) = aliases.get(&(
            music.url.as_str(),
            music.group.url.as_str(),
            music.start_ms,
            music.end_ms,
        )) {
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
    group: &Group,
    save_root: &Path,
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
            canonical_music_id: canonical_music_id_for_source(
                &leaf.url,
                0,
                seconds_to_millis(leaf.duration_seconds.unwrap_or(0)),
            ),
            url: leaf.url.clone(),
            path: Some(relative_path.to_string()),
            start_ms: 0,
            end_ms: seconds_to_millis(leaf.duration_seconds.unwrap_or(0)),
            liked: false,
        });
    }

    restored
}

fn notify_audio_style_inputs_changed(_reason: &'static str) {
    #[cfg(not(test))]
    notify_audio_style_training_inputs_changed(_reason);
}

fn seconds_to_millis(seconds: u32) -> u32 {
    seconds.saturating_mul(1_000)
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
    let groups = manifest
        .groups
        .into_iter()
        .map(|group| {
            let group = group.into_group(&manifest.collection.url, &collection_folder)?;
            Ok((group.url.clone(), group))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;

    let collection_owner = Group {
        name: manifest.collection.name.clone(),
        url: manifest.collection.url.clone(),
        folder: collection_folder.clone(),
    };
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
        if !seen.insert((
            music.url.clone(),
            music.group_url.clone(),
            music.start_ms,
            music.end_ms,
            relative_path.clone(),
        )) {
            continue;
        }

        let group = resolve_manifest_music_group(
            &music.group_url,
            &manifest.collection.url,
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

        if music.start_ms >= music.end_ms {
            continue;
        }

        manifest_file_paths.insert(relative_path.clone());
        musics.push(Music {
            name,
            alias,
            group,
            canonical_music_id: canonical_music_id_for_source(
                &music.url,
                music.start_ms,
                music.end_ms,
            ),
            url: music.url,
            path: Some(relative_path),
            start_ms: music.start_ms,
            end_ms: music.end_ms,
            liked: music.liked,
        });
    }

    for local_file in local_audio_files {
        if manifest_file_paths.contains(&local_file.relative_path) {
            continue;
        }

        let music =
            local_music_from_audio_file(&manifest.collection.url, &collection_owner, local_file);
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
        name: manifest.collection.name,
        url: manifest.collection.url,
        folder: collection_folder,
        musics,
        last_updated: manifest
            .collection
            .last_updated
            .unwrap_or_else(now_timestamp),
        enable_updates: manifest.collection.enable_updates,
    })
}

fn collection_from_local_audio_files(
    collection_path: &Path,
    collection_folder: &str,
    local_audio_files: &[LocalAudioFile],
) -> Result<Collection> {
    let collection_name = local_collection_name(collection_path);
    let collection_url = local_collection_url(collection_path)?;
    let group = Group {
        name: collection_name.clone(),
        url: collection_url.clone(),
        folder: collection_folder.to_string(),
    };
    let mut musics = Vec::new();

    for file in local_audio_files {
        musics.push(local_music_from_audio_file(&collection_url, &group, file));
    }

    Ok(Collection {
        name: collection_name,
        url: collection_url,
        folder: collection_folder.to_string(),
        musics,
        last_updated: now_timestamp(),
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
    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(file_path)
        .arg("-map")
        .arg("0:a:0")
        .arg("-vn")
        .arg("-sn")
        .arg("-dn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg(LOCAL_AUDIO_PROBE_SAMPLE_RATE.to_string())
        .arg("-f")
        .arg("f32le")
        .arg("-c:a")
        .arg("pcm_f32le")
        .arg("pipe:1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to run ffmpeg at {}", ffmpeg_path.display()))?;
    let stdout = child
        .stdout
        .take()
        .context("ffmpeg local audio probe stdout pipe is missing")?;
    let stderr = child
        .stderr
        .take()
        .context("ffmpeg local audio probe stderr pipe is missing")?;
    let stderr_reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut message = String::new();
        let _ = reader.read_to_string(&mut message);
        message
    });

    let decoded_bytes = read_local_audio_probe_output(stdout)?;
    let status = child
        .wait()
        .context("failed to wait for ffmpeg local audio probe")?;
    let _stderr_message = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        return Ok(None);
    }

    Ok(Some(LocalAudioProbe {
        duration_ms: duration_ms_from_f32le_bytes(decoded_bytes, LOCAL_AUDIO_PROBE_SAMPLE_RATE),
    }))
}

fn read_local_audio_probe_output(stdout: std::process::ChildStdout) -> Result<u64> {
    let mut reader = BufReader::new(stdout);
    let mut buffer = [0_u8; 64 * 1024];
    let mut decoded_bytes = 0_u64;

    loop {
        let read = reader
            .read(&mut buffer)
            .context("failed to read ffmpeg local audio probe output")?;
        if read == 0 {
            break;
        }
        decoded_bytes = decoded_bytes.saturating_add(read as u64);
    }

    Ok(decoded_bytes)
}

fn duration_ms_from_f32le_bytes(decoded_bytes: u64, sample_rate: u32) -> u32 {
    if sample_rate == 0 {
        return 0;
    }

    let frame_count = decoded_bytes / 4;
    let sample_rate = sample_rate as u64;
    let duration_ms = frame_count
        .saturating_mul(1_000)
        .saturating_add(sample_rate / 2)
        / sample_rate;
    duration_ms.min(u32::MAX as u64) as u32
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
        name: name.clone(),
        alias: name,
        group: group.clone(),
        canonical_music_id: canonical_music_id_for_source(&url, 0, file.duration_ms),
        url,
        path: Some(file.relative_path.clone()),
        start_ms: 0,
        end_ms: file.duration_ms,
        liked: false,
    }
}

fn manifest_from_collection(
    collection: &Collection,
    source_kind: CollectionSourceKind,
) -> CollectionManifest {
    let mut groups = BTreeMap::<String, CollectionManifestGroup>::new();
    let musics = collection
        .musics
        .iter()
        .filter_map(|music| {
            let path = music.path.as_deref()?.trim();
            if path.is_empty() {
                return None;
            }

            if music.group.url != collection.url {
                groups
                    .entry(music.group.url.clone())
                    .or_insert_with(|| CollectionManifestGroup {
                        name: music.group.name.clone(),
                        url: music.group.url.clone(),
                        folder: music.group.folder.clone(),
                    });
            }

            Some(CollectionManifestMusic {
                name: music.name.clone(),
                alias: music.alias.clone(),
                url: music.url.clone(),
                path: normalize_path_text(path),
                group_url: music.group.url.clone(),
                start_ms: music.start_ms,
                end_ms: music.end_ms,
                liked: music.liked,
            })
        })
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
        groups: groups.into_values().collect(),
        musics,
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

fn write_collection_manifest_file(
    collection_root: &Path,
    manifest: &CollectionManifest,
) -> Result<()> {
    std::fs::create_dir_all(collection_root)
        .with_context(|| format!("failed to create {}", collection_root.display()))?;
    let manifest_path = collection_root.join(COLLECTION_MANIFEST_FILE_NAME);
    let manifest = match read_collection_manifest_file(&manifest_path)? {
        Some(existing) => merge_collection_manifest(existing, manifest.clone()),
        None => manifest.clone(),
    };
    let text =
        toml::to_string_pretty(&manifest).context("failed to serialize collection manifest")?;
    std::fs::write(&manifest_path, text)
        .with_context(|| format!("failed to write {}", manifest_path.display()))
}

fn merge_collection_manifest(
    existing: CollectionManifest,
    next: CollectionManifest,
) -> CollectionManifest {
    if existing.collection.url != next.collection.url {
        return next;
    }

    let mut merged = existing;
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
    let existing_file_scopes = merged
        .musics
        .iter()
        .map(collection_manifest_music_file_scope)
        .collect::<HashSet<_>>();
    for music in next.musics {
        if existing_file_scopes.contains(&collection_manifest_music_file_scope(&music)) {
            continue;
        }

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
    fn into_group(self, collection_url: &str, collection_folder: &str) -> Result<Group> {
        let folder = if self.url == collection_url {
            collection_folder.to_string()
        } else {
            normalize_manifest_relative_path(&self.folder)?
        };

        Ok(Group {
            name: self.name,
            url: self.url,
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
