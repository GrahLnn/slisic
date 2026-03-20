use super::normalization;
use super::repo::repository;
use super::types::{
    build_closure_lifecycle_fact, closure_owner_session_id_from_entry,
    closure_owner_session_id_or_entry_identity,
    dedup_entries, default_music, entry_key, merge_music_with_template, path_to_title,
    recompute_entry_avg, recompute_playlist_avg, sanitize_name, ClosureLifecyclePhase,
    CollectMission, Entry, EntryType, FolderSample, LinkSample, Music, Playlist, ProcessMsg,
};
use crate::utils::file::{all_audio_recursive_inner, is_audio_path};
use crate::utils::ytdlp::{self, DownloadOutcome, ProcessResult};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use tauri::AppHandle;
use tauri_specta::Event;

fn emit_closure_lifecycle_fact(
    app: &AppHandle,
    owner_session_id: u64,
    playlist: &str,
    entry: &Entry,
    phase: ClosureLifecyclePhase,
    notification_text: Option<String>,
) {
    if let Some(fact) = build_closure_lifecycle_fact(
        owner_session_id,
        playlist,
        entry,
        phase,
        notification_text,
    ) {
        fact.emit(app).ok();
    }
}

fn can_refresh_file_loudness(entry: &Entry) -> bool {
    matches!(entry.entry_type, EntryType::Local) && entry.url.is_none()
}

pub async fn create(app: AppHandle, data: CollectMission) -> Result<(), String> {
    let repo = repository().await?;
    let music_index = load_music_index_if_needed(&repo, &data).await?;
    let (playlist, pending) = build_playlist_from_mission(data, &music_index)?;
    let playlist_name = playlist.name.clone();
    let analysis_paths = playlist_music_paths(&playlist);
    let canonical_owner_session_id = pending
        .first()
        .and_then(closure_owner_session_id_from_entry);
    repo.create_playlist(playlist).await?;
    normalization::analyze_paths_blocking(
        &app,
        analysis_paths,
        &playlist_name,
        "Analyzing loudness",
        canonical_owner_session_id,
    )
    .await?;
    spawn_downloads(app, playlist_name, pending, canonical_owner_session_id);
    Ok(())
}

pub async fn read(name: String) -> Result<Playlist, String> {
    repository().await?.read_playlist(&name).await
}

pub async fn read_all() -> Result<Vec<Playlist>, String> {
    repository().await?.snapshot().await
}

pub async fn playlist_names() -> Result<Vec<String>, String> {
    repository().await?.playlist_names().await
}

pub async fn update(app: AppHandle, data: CollectMission, anchor: Playlist) -> Result<(), String> {
    let repo = repository().await?;
    let music_index = load_music_index_if_needed(&repo, &data).await?;
    let (playlist, pending) = build_playlist_from_mission(data, &music_index)?;
    let playlist_name = playlist.name.clone();
    let analysis_paths = playlist_music_paths(&playlist);
    let canonical_owner_session_id = pending
        .first()
        .and_then(closure_owner_session_id_from_entry);
    repo.replace_playlist(&anchor.name, playlist).await?;
    normalization::analyze_paths_blocking(
        &app,
        analysis_paths,
        &playlist_name,
        "Analyzing loudness",
        canonical_owner_session_id,
    )
    .await?;
    spawn_downloads(app, playlist_name, pending, canonical_owner_session_id);
    Ok(())
}

pub async fn delete(name: String) -> Result<(), String> {
    repository().await?.delete_playlist(&name).await
}

pub async fn delete_music(music: Music) -> Result<(), String> {
    repository().await?.remove_music_by_path(&music.path).await
}

pub async fn fatigue(music: Music) -> Result<(), String> {
    repository()
        .await?
        .update_music_by_path(&music.path, |m| {
            m.fatigue += 0.1;
        })
        .await
}

pub async fn cancle_fatigue(music: Music) -> Result<(), String> {
    repository()
        .await?
        .update_music_by_path(&music.path, |m| {
            m.fatigue = (m.fatigue - 0.1).max(0.0);
        })
        .await
}

pub async fn boost(music: Music) -> Result<(), String> {
    repository()
        .await?
        .update_music_by_path(&music.path, |m| {
            m.user_boost = (m.user_boost + 0.1).min(0.9);
        })
        .await
}

pub async fn cancle_boost(music: Music) -> Result<(), String> {
    repository()
        .await?
        .update_music_by_path(&music.path, |m| {
            m.user_boost = (m.user_boost - 0.1).max(0.0);
        })
        .await
}

pub async fn reset_logits() -> Result<(), String> {
    repository().await?.reset_logits().await
}

pub async fn unstar(list: Playlist, music: Music) -> Result<(), String> {
    repository().await?.add_exclude(&list.name, music).await
}

pub async fn rmexclude(list: Playlist, music: Music) -> Result<(), String> {
    repository()
        .await?
        .remove_exclude(&list.name, &music.path)
        .await
}

pub async fn recheck_folder(app: AppHandle, entry: Entry) -> Result<Entry, String> {
    let folder = entry
        .path
        .clone()
        .ok_or_else(|| "folder path is missing".to_string())?;

    let repo = repository().await?;
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
    normalization::analyze_paths_blocking(
        &app,
        normalization::stale_music_paths(&updated.musics),
        &updated.name,
        "Analyzing loudness",
        None,
    )
    .await?;
    Ok(updated)
}

pub async fn update_weblist(
    app: AppHandle,
    entry: Entry,
    playlist: String,
) -> Result<Entry, String> {
    let owner_session_id = closure_owner_session_id_from_entry(&entry).unwrap_or(0);
    let outcome = ytdlp::download_entry_for_library(app.clone(), &playlist, &entry).await?;
    emit_closure_lifecycle_fact(
        &app,
        owner_session_id,
        &playlist,
        &outcome.entry,
        ClosureLifecyclePhase::Downloaded,
        Some(format!("Downloaded {}", outcome.name)),
    );
    normalization::analyze_paths_blocking(
        &app,
        entry_music_paths(&outcome.entry),
        &playlist,
        "Analyzing loudness",
        Some(owner_session_id),
    )
    .await?;
    emit_download_persisted(
        &app,
        &playlist,
        &outcome.working_path,
        &outcome.saved_path,
        &outcome.name,
    );

    Ok(outcome.entry)
}

fn emit_download_persisted(
    app: &AppHandle,
    playlist: &str,
    working_path: &std::path::Path,
    saved_path: &std::path::Path,
    name: &str,
) {
    ProcessResult {
        working_path: working_path.to_string_lossy().to_string(),
        saved_path: saved_path.to_string_lossy().to_string(),
        name: name.to_string(),
        playlist: playlist.to_string(),
    }
    .emit(app)
    .ok();
}

fn spawn_downloads(
    app: AppHandle,
    playlist_name: String,
    pending: Vec<Entry>,
    canonical_owner_session_id: Option<u64>,
) {
    if pending.is_empty() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        for entry in pending {
            let owner_session_id =
                closure_owner_session_id_or_entry_identity(canonical_owner_session_id, &entry)
                    .unwrap_or(0);
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
                    if let Ok(repo) = repository().await {
                        let _ = repo
                            .upsert_entry_in_playlist(&playlist_name, entry.clone())
                            .await;
                    }
                    emit_download_persisted(
                        &app,
                        &playlist_name,
                        &working_path,
                        &saved_path,
                        &name,
                    );
                    emit_closure_lifecycle_fact(
                        &app,
                        owner_session_id,
                        &playlist_name,
                        &entry,
                        ClosureLifecyclePhase::Downloaded,
                        Some(format!("Downloaded {name}")),
                    );
                    let _ = normalization::analyze_paths_blocking(
                        &app,
                        entry_music_paths(&entry),
                        &playlist_name,
                        "Analyzing loudness",
                        Some(owner_session_id),
                    )
                    .await;
                    emit_download_persisted(
                        &app,
                        &playlist_name,
                        &working_path,
                        &saved_path,
                        &name,
                    );
                }
                Err(error) => {
                    let mut failed = entry.clone();
                    failed.downloaded_ok = Some(false);
                    emit_closure_lifecycle_fact(
                        &app,
                        owner_session_id,
                        &playlist_name,
                        &failed,
                        ClosureLifecyclePhase::Failed,
                        Some(format!("Download failed: {error}")),
                    );
                    if let Ok(repo) = repository().await {
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

fn playlist_music_paths(playlist: &Playlist) -> Vec<String> {
    let mut paths = Vec::new();
    for entry in &playlist.entries {
        paths.extend(entry_music_paths(entry));
    }
    for music in &playlist.exclude {
        paths.push(music.path.clone());
    }
    paths
}

fn entry_music_paths(entry: &Entry) -> Vec<String> {
    entry
        .musics
        .iter()
        .map(|music| music.path.clone())
        .collect()
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
            base.integrated_lufs = music.integrated_lufs;
            base.true_peak_dbtp = music.true_peak_dbtp;
            base.loudness_range_lu = music.loudness_range_lu;
            base.loudness_threshold_lufs = music.loudness_threshold_lufs;
            base.analyzed_at_ms = music.analyzed_at_ms;
            base.analysis_version = music.analysis_version;
            base.source_mtime_ms = music.source_mtime_ms;
            base.source_size_bytes = music.source_size_bytes;
            base.normalization_status = music.normalization_status.clone();
            base.normalization_error = music.normalization_error.clone();
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
    let needs_index = !mission.folders.is_empty()
        || mission.entries.iter().any(can_refresh_file_loudness)
        || mission
            .exclude
            .iter()
            .any(|music| !music.path.trim().is_empty());

    if !needs_index {
        return Ok(HashMap::new());
    }
    repo.music_index().await
}

#[cfg(test)]
mod tests {
    use super::build_playlist_from_mission;
    use crate::domain::music::repo::{set_repository_for_tests, LibraryRepo};
    use crate::domain::music::store::SnapshotStore;
    use crate::domain::music::types::{
        CollectMission, Entry, EntryType, FolderSample, LinkSample, LinkStatus, Music,
        LibraryData, NormalizationStatus, Playlist, MUSIC_LIBRARY_SCHEMA_VERSION,
    };
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    fn music(path: &str) -> Music {
        Music {
            path: path.to_string(),
            title: path.to_string(),
            avg_db: None,
            integrated_lufs: None,
            true_peak_dbtp: None,
            loudness_range_lu: None,
            loudness_threshold_lufs: None,
            analyzed_at_ms: None,
            analysis_version: None,
            source_mtime_ms: None,
            source_size_bytes: None,
            normalization_status: None,
            normalization_error: None,
            base_bias: 0.0,
            user_boost: 0.0,
            fatigue: 0.0,
            diversity: 0.0,
        }
    }

    fn canonical_music(path: &str, integrated_lufs: f32) -> Music {
        Music {
            integrated_lufs: Some(integrated_lufs),
            true_peak_dbtp: Some(-1.0),
            loudness_range_lu: Some(4.0),
            analyzed_at_ms: Some(10),
            analysis_version: Some(1),
            source_mtime_ms: Some(20),
            source_size_bytes: Some(30),
            normalization_status: Some(NormalizationStatus::Ready),
            ..music(path)
        }
    }

    fn entry(path: Option<&str>, name: &str, url: Option<&str>, musics: Vec<Music>) -> Entry {
        Entry {
            path: path.map(str::to_string),
            name: name.to_string(),
            musics,
            avg_db: None,
            url: url.map(str::to_string),
            downloaded_ok: Some(true),
            tracking: Some(false),
            entry_type: if url.is_some() {
                EntryType::WebList
            } else {
                EntryType::Local
            },
        }
    }

    #[derive(Default)]
    struct TestStore {
        data: Mutex<LibraryData>,
    }

    #[async_trait]
    impl SnapshotStore for TestStore {
        fn engine_name(&self) -> &'static str {
            "test"
        }

        async fn load_data(&self) -> Result<LibraryData, String> {
            Ok(self.data.lock().await.clone())
        }

        async fn save_data(&self, data: &LibraryData) -> Result<(), String> {
            *self.data.lock().await = data.clone();
            Ok(())
        }
    }

    fn playlist(name: &str, entries: Vec<Entry>) -> Playlist {
        Playlist {
            name: name.to_string(),
            avg_db: None,
            entries,
            exclude: vec![],
        }
    }

    #[test]
    fn build_playlist_from_mission_true_positive_merges_canonical_index_and_tracks_pending_links() {
        let mission = CollectMission {
            name: "  Focus / Mix  ".to_string(),
            folders: vec![],
            entries: vec![entry(
                Some("C:/music/a.flac"),
                "legacy-a",
                None,
                vec![music("C:/music/a.flac")],
            )],
            links: vec![LinkSample {
                url: "https://example.com/list".to_string(),
                title_or_msg: "Web Mix".to_string(),
                entry_type: EntryType::WebList,
                count: Some(2),
                status: Some(LinkStatus::Ok),
                tracking: true,
            }],
            exclude: vec![],
        };

        let playlist = build_playlist_from_mission(
            mission,
            &HashMap::from([(
                "C:/music/a.flac".to_string(),
                canonical_music("C:/music/a.flac", -18.5),
            )]),
        )
        .expect("mission should normalize");

        assert_eq!(playlist.0.name, "Focus _ Mix");
        assert_eq!(playlist.0.entries.len(), 2);
        assert_eq!(playlist.0.entries[0].musics[0].integrated_lufs, Some(-18.5));
        assert_eq!(playlist.1.len(), 1);
        assert_eq!(
            playlist.1[0].url.as_deref(),
            Some("https://example.com/list")
        );
        assert_eq!(playlist.1[0].downloaded_ok, Some(false));
    }

    #[test]
    fn build_playlist_from_mission_true_negative_keeps_distinct_entries_with_same_name_but_different_paths(
    ) {
        let mission = CollectMission {
            name: "same-name".to_string(),
            folders: vec![],
            entries: vec![
                entry(
                    Some("C:/music/a.flac"),
                    "duplicate-name",
                    None,
                    vec![music("C:/music/a.flac")],
                ),
                entry(
                    Some("C:/music/b.flac"),
                    "duplicate-name",
                    None,
                    vec![music("C:/music/b.flac")],
                ),
            ],
            links: vec![],
            exclude: vec![],
        };

        let playlist = build_playlist_from_mission(mission, &HashMap::new())
            .expect("same-name entries should coexist");

        assert_eq!(playlist.0.entries.len(), 2);
        assert_eq!(
            playlist.0.entries[0].path.as_deref(),
            Some("C:/music/a.flac")
        );
        assert_eq!(
            playlist.0.entries[1].path.as_deref(),
            Some("C:/music/b.flac")
        );
    }

    #[test]
    fn build_playlist_from_mission_false_positive_does_not_leak_index_metadata_across_paths() {
        let mission = CollectMission {
            name: "no-cross-path".to_string(),
            folders: vec![],
            entries: vec![entry(
                Some("C:/music/b.flac"),
                "same-title",
                None,
                vec![music("C:/music/b.flac")],
            )],
            links: vec![],
            exclude: vec![],
        };

        let playlist = build_playlist_from_mission(
            mission,
            &HashMap::from([(
                "C:/music/a.flac".to_string(),
                canonical_music("C:/music/a.flac", -17.0),
            )]),
        )
        .expect("unrelated path should stay untouched");

        assert_eq!(playlist.0.entries[0].musics[0].integrated_lufs, None);
        assert_eq!(playlist.0.entries[0].musics[0].path, "C:/music/b.flac");
    }

    #[test]
    fn build_playlist_from_mission_false_negative_preserves_canonical_exclude_and_dedups_duplicate_rows(
    ) {
        let mission = CollectMission {
            name: "exclude".to_string(),
            folders: vec![FolderSample {
                path: "C:/folder".to_string(),
                items: vec!["C:/folder/track.flac".to_string()],
            }],
            entries: vec![],
            links: vec![],
            exclude: vec![
                Music {
                    user_boost: 0.4,
                    ..music("C:/folder/track.flac")
                },
                Music {
                    user_boost: 0.1,
                    ..music("C:/folder/track.flac")
                },
            ],
        };

        let playlist = build_playlist_from_mission(
            mission,
            &HashMap::from([(
                "C:/folder/track.flac".to_string(),
                Music {
                    user_boost: 0.7,
                    fatigue: 0.2,
                    integrated_lufs: Some(-16.0),
                    true_peak_dbtp: Some(-0.8),
                    loudness_range_lu: Some(5.0),
                    analyzed_at_ms: Some(100),
                    analysis_version: Some(1),
                    source_mtime_ms: Some(200),
                    source_size_bytes: Some(300),
                    normalization_status: Some(NormalizationStatus::Ready),
                    normalization_error: None,
                    ..music("C:/folder/track.flac")
                },
            )]),
        )
        .expect("exclude normalization should preserve canonical metadata");

        assert_eq!(playlist.0.exclude.len(), 1);
        assert_eq!(playlist.0.exclude[0].integrated_lufs, Some(-16.0));
        assert_eq!(playlist.0.exclude[0].user_boost, 0.7);
        assert_eq!(playlist.0.entries.len(), 1);
        assert_eq!(playlist.0.entries[0].avg_db, Some(-16.0));
    }

}
