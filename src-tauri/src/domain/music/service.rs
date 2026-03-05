use super::repo::repository;
use super::types::{
    dedup_entries, default_music, entry_key, merge_music_with_template, path_to_title,
    recompute_entry_avg, recompute_playlist_avg, sanitize_name, CollectMission, Entry, EntryType,
    FolderSample, LinkSample, Music, Playlist, ProcessMsg,
};
use crate::utils::file::{all_audio_recursive_inner, is_audio_path};
use crate::utils::ytdlp::{self, DownloadOutcome, ProcessResult};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use tauri::AppHandle;
use tauri_specta::Event;

pub async fn create(app: AppHandle, data: CollectMission) -> Result<(), String> {
    let repo = repository()?;
    let music_index = load_music_index_if_needed(&repo, &data).await?;
    let (playlist, pending) = build_playlist_from_mission(data, &music_index)?;
    let playlist_name = playlist.name.clone();
    repo.create_playlist(playlist).await?;
    spawn_downloads(app, playlist_name, pending);
    Ok(())
}

pub async fn read(name: String) -> Result<Playlist, String> {
    repository()?.read_playlist(&name).await
}

pub async fn read_all() -> Result<Vec<Playlist>, String> {
    repository()?.snapshot().await
}

pub async fn update(app: AppHandle, data: CollectMission, anchor: Playlist) -> Result<(), String> {
    let repo = repository()?;
    let music_index = load_music_index_if_needed(&repo, &data).await?;
    let (playlist, pending) = build_playlist_from_mission(data, &music_index)?;
    let playlist_name = playlist.name.clone();
    repo.replace_playlist(&anchor.name, playlist).await?;
    spawn_downloads(app, playlist_name, pending);
    Ok(())
}

pub async fn delete(name: String) -> Result<(), String> {
    repository()?.delete_playlist(&name).await
}

pub async fn delete_music(music: Music) -> Result<(), String> {
    repository()?.remove_music_by_path(&music.path).await
}

pub async fn fatigue(music: Music) -> Result<(), String> {
    repository()?
        .update_music_by_path(&music.path, |m| {
            m.fatigue += 0.1;
        })
        .await
}

pub async fn cancle_fatigue(music: Music) -> Result<(), String> {
    repository()?
        .update_music_by_path(&music.path, |m| {
            m.fatigue = (m.fatigue - 0.1).max(0.0);
        })
        .await
}

pub async fn boost(music: Music) -> Result<(), String> {
    repository()?
        .update_music_by_path(&music.path, |m| {
            m.user_boost = (m.user_boost + 0.1).min(0.9);
        })
        .await
}

pub async fn cancle_boost(music: Music) -> Result<(), String> {
    repository()?
        .update_music_by_path(&music.path, |m| {
            m.user_boost = (m.user_boost - 0.1).max(0.0);
        })
        .await
}

pub async fn reset_logits() -> Result<(), String> {
    repository()?.reset_logits().await
}

pub async fn unstar(list: Playlist, music: Music) -> Result<(), String> {
    repository()?.add_exclude(&list.name, music).await
}

pub async fn rmexclude(list: Playlist, music: Music) -> Result<(), String> {
    repository()?.remove_exclude(&list.name, &music.path).await
}

pub async fn recheck_folder(entry: Entry) -> Result<Entry, String> {
    let folder = entry
        .path
        .clone()
        .ok_or_else(|| "folder path is missing".to_string())?;

    let repo = repository()?;
    let index = repo.music_index().await?;

    let items = all_audio_recursive_inner(Path::new(&folder))?;
    let mut musics = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        let path = item.to_string_lossy().to_string();
        if !seen.insert(path.clone()) {
            continue;
        }
        let music = merge_music_with_template(path.clone(), index.get(&path));
        musics.push(music);
    }

    let mut updated = Entry {
        path: Some(folder.clone()),
        name: entry.name,
        musics,
        avg_db: None,
        url: entry.url,
        downloaded_ok: Some(true),
        tracking: entry.tracking.or(Some(false)),
        entry_type: EntryType::Local,
    };
    recompute_entry_avg(&mut updated);

    repo.update_entry_everywhere(updated.clone()).await?;
    Ok(updated)
}

pub async fn update_weblist(
    app: AppHandle,
    entry: Entry,
    playlist: String,
) -> Result<Entry, String> {
    let outcome = ytdlp::download_entry_for_library(app.clone(), &playlist, &entry).await?;
    repository()?
        .upsert_entry_in_playlist(&playlist, outcome.entry.clone())
        .await?;

    ProcessResult {
        working_path: outcome.working_path.to_string_lossy().to_string(),
        saved_path: outcome.saved_path.to_string_lossy().to_string(),
        name: outcome.name,
        playlist,
    }
    .emit(&app)
    .ok();

    Ok(outcome.entry)
}

fn spawn_downloads(app: AppHandle, playlist_name: String, pending: Vec<Entry>) {
    if pending.is_empty() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        for entry in pending {
            ProcessMsg {
                playlist: playlist_name.clone(),
                str: format!("Downloading {}", entry.name),
            }
            .emit(&app)
            .ok();

            let downloaded =
                ytdlp::download_entry_for_library(app.clone(), &playlist_name, &entry).await;
            match downloaded {
                Ok(DownloadOutcome {
                    entry,
                    working_path,
                    saved_path,
                    name,
                }) => {
                    if let Ok(repo) = repository() {
                        let _ = repo
                            .upsert_entry_in_playlist(&playlist_name, entry.clone())
                            .await;
                    }
                    ProcessResult {
                        working_path: working_path.to_string_lossy().to_string(),
                        saved_path: saved_path.to_string_lossy().to_string(),
                        name,
                        playlist: playlist_name.clone(),
                    }
                    .emit(&app)
                    .ok();
                }
                Err(error) => {
                    let mut failed = entry.clone();
                    failed.downloaded_ok = Some(false);
                    if let Ok(repo) = repository() {
                        let _ = repo.upsert_entry_in_playlist(&playlist_name, failed).await;
                    }
                    ProcessMsg {
                        playlist: playlist_name.clone(),
                        str: format!("Download failed for {}: {}", entry.name, error),
                    }
                    .emit(&app)
                    .ok();
                }
            }
        }
    });
}

fn build_playlist_from_mission(
    mission: CollectMission,
    music_index: &HashMap<String, Music>,
) -> Result<(Playlist, Vec<Entry>), String> {
    let mut entries = Vec::new();
    let mut pending = Vec::new();

    for entry in mission.entries {
        let normalized = normalize_existing_entry(entry, music_index);
        if normalized.url.is_some() && normalized.downloaded_ok != Some(true) {
            pending.push(normalized.clone());
        }
        entries.push(normalized);
    }

    for folder in mission.folders {
        let entry = normalize_folder_entry(folder, music_index)?;
        entries.push(entry);
    }

    for link in mission.links {
        let entry = normalize_link_entry(link);
        pending.push(entry.clone());
        entries.push(entry);
    }

    entries = dedup_entries(entries);
    let pending_keys: HashSet<String> = pending.iter().map(entry_key).collect();
    let pending = entries
        .iter()
        .filter(|entry| pending_keys.contains(&entry_key(entry)))
        .cloned()
        .collect::<Vec<_>>();

    let mut exclude = Vec::new();
    let mut seen_ex = HashSet::new();
    for music in mission.exclude {
        if seen_ex.insert(music.path.clone()) {
            exclude.push(merge_music_with_template(
                music.path.clone(),
                Some(music_index.get(&music.path).unwrap_or(&music)),
            ));
        }
    }

    let mut playlist = Playlist {
        name: sanitize_name(&mission.name),
        avg_db: None,
        entries,
        exclude,
    };

    for entry in &mut playlist.entries {
        recompute_entry_avg(entry);
    }
    recompute_playlist_avg(&mut playlist);

    Ok((playlist, pending))
}

fn normalize_existing_entry(entry: Entry, music_index: &HashMap<String, Music>) -> Entry {
    let mut seen = HashSet::new();
    let mut musics = Vec::new();

    for music in entry.musics {
        if !seen.insert(music.path.clone()) {
            continue;
        }

        let merged = if let Some(existing) = music_index.get(&music.path) {
            merge_music_with_template(music.path.clone(), Some(existing))
        } else {
            let mut base = merge_music_with_template(music.path.clone(), Some(&music));
            base.avg_db = music.avg_db;
            base
        };
        musics.push(merged);
    }

    let mut normalized = Entry {
        path: entry.path,
        name: sanitize_name(&entry.name),
        musics,
        avg_db: None,
        url: entry.url,
        downloaded_ok: entry.downloaded_ok,
        tracking: entry.tracking.or(Some(false)),
        entry_type: entry.entry_type,
    };

    recompute_entry_avg(&mut normalized);
    normalized
}

fn normalize_folder_entry(
    folder: FolderSample,
    music_index: &HashMap<String, Music>,
) -> Result<Entry, String> {
    let folder_path_raw = folder.path.clone();
    let folder_path = Path::new(&folder_path_raw);
    let fallback_name = folder_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&folder_path_raw)
        .to_string();

    let mut items = folder.items;
    if items.is_empty() {
        let scanned = all_audio_recursive_inner(folder_path)?;
        items = scanned
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
    }

    let mut seen = HashSet::new();
    let mut musics = Vec::new();
    for item in items {
        if !is_audio_path(Path::new(&item)) {
            continue;
        }
        if !seen.insert(item.clone()) {
            continue;
        }

        let music = if let Some(existing) = music_index.get(&item) {
            merge_music_with_template(item.clone(), Some(existing))
        } else {
            default_music(item.clone())
        };
        musics.push(music);
    }

    let mut entry = Entry {
        path: Some(folder_path_raw),
        name: sanitize_name(&fallback_name),
        musics,
        avg_db: None,
        url: None,
        downloaded_ok: Some(true),
        tracking: Some(false),
        entry_type: EntryType::Local,
    };
    recompute_entry_avg(&mut entry);
    Ok(entry)
}

fn normalize_link_entry(link: LinkSample) -> Entry {
    let inferred_name = if !link.title_or_msg.trim().is_empty() {
        sanitize_name(&link.title_or_msg)
    } else {
        sanitize_name(&path_to_title(&link.url))
    };

    Entry {
        path: None,
        name: inferred_name,
        musics: Vec::new(),
        avg_db: None,
        url: Some(link.url),
        downloaded_ok: Some(false),
        tracking: Some(link.tracking),
        entry_type: match link.entry_type {
            EntryType::Unknown => EntryType::WebVideo,
            other => other,
        },
    }
}

async fn load_music_index_if_needed(
    repo: &std::sync::Arc<super::repo::LibraryRepo>,
    mission: &CollectMission,
) -> Result<HashMap<String, Music>, String> {
    if mission.folders.is_empty() {
        return Ok(HashMap::new());
    }
    repo.music_index().await
}
