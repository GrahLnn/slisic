use super::store::SnapshotStore;
use super::store_surreal::SurrealStore;
use super::types::{
    dedup_entries, entry_key, recompute_entry_avg, recompute_playlist_avg, Entry, LibraryData,
    Music, Playlist, MUSIC_LIBRARY_SCHEMA_VERSION,
};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Manager;
use tokio::sync::Mutex;

static REPOSITORY: std::sync::OnceLock<Arc<LibraryRepo>> = std::sync::OnceLock::new();

#[cfg(test)]
static TEST_REPOSITORY: std::sync::Mutex<Option<Arc<LibraryRepo>>> = std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) struct RepoTestGuard;

pub struct LibraryRepo {
    store: Arc<dyn SnapshotStore>,
    write_lock: Mutex<()>,
}

impl LibraryRepo {
    fn new(store: Arc<dyn SnapshotStore>) -> Self {
        Self {
            store,
            write_lock: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_tests(store: Arc<dyn SnapshotStore>) -> Self {
        Self::new(store)
    }

    pub fn engine_name(&self) -> &'static str {
        self.store.engine_name()
    }

    pub async fn snapshot(&self) -> Result<Vec<Playlist>, String> {
        Ok(self.store.load_data().await?.playlists)
    }

    pub async fn music_index(&self) -> Result<HashMap<String, Music>, String> {
        let data = self.store.load_data().await?;
        let mut index = HashMap::new();
        for playlist in &data.playlists {
            for entry in &playlist.entries {
                for music in &entry.musics {
                    index
                        .entry(music.path.clone())
                        .or_insert_with(|| music.clone());
                }
            }
            for music in &playlist.exclude {
                index
                    .entry(music.path.clone())
                    .or_insert_with(|| music.clone());
            }
        }
        Ok(index)
    }

    pub async fn read_playlist(&self, name: &str) -> Result<Playlist, String> {
        let data = self.store.load_data().await?;
        data.playlists
            .into_iter()
            .find(|p| p.name == name)
            .ok_or_else(|| format!("playlist not found: {name}"))
    }

    pub async fn create_playlist(&self, mut playlist: Playlist) -> Result<(), String> {
        self.mutate(|data| {
            if data.playlists.iter().any(|p| p.name == playlist.name) {
                return Err(format!("playlist already exists: {}", playlist.name));
            }
            playlist.entries = dedup_entries(playlist.entries.clone());
            recompute_playlist_avg(&mut playlist);
            data.playlists.push(playlist);
            Ok(())
        })
        .await
    }

    pub async fn replace_playlist(
        &self,
        anchor: &str,
        mut playlist: Playlist,
    ) -> Result<(), String> {
        playlist.entries = dedup_entries(playlist.entries.clone());
        recompute_playlist_avg(&mut playlist);

        let _guard = self.write_lock.lock().await;
        self.store.replace_playlist(anchor, playlist).await
    }

    pub async fn delete_playlist(&self, name: &str) -> Result<(), String> {
        self.mutate(|data| {
            let before = data.playlists.len();
            data.playlists.retain(|p| p.name != name);
            if data.playlists.len() == before {
                return Err(format!("playlist not found: {name}"));
            }
            Ok(())
        })
        .await
    }

    pub async fn upsert_entry_in_playlist(
        &self,
        playlist_name: &str,
        entry: Entry,
    ) -> Result<(), String> {
        self.mutate(|data| {
            let Some(playlist) = data.playlists.iter_mut().find(|p| p.name == playlist_name) else {
                return Err(format!("playlist not found: {playlist_name}"));
            };

            replace_or_insert_entry(&mut playlist.entries, entry);
            for entry in &mut playlist.entries {
                recompute_entry_avg(entry);
            }
            recompute_playlist_avg(playlist);
            Ok(())
        })
        .await
    }

    pub async fn update_entry_everywhere(&self, entry: Entry) -> Result<(), String> {
        self.mutate(|data| {
            for playlist in &mut data.playlists {
                replace_if_exists(&mut playlist.entries, &entry);
                for entry in &mut playlist.entries {
                    recompute_entry_avg(entry);
                }
                recompute_playlist_avg(playlist);
            }
            Ok(())
        })
        .await
    }

    pub async fn update_music_by_path<F>(&self, path: &str, mut updater: F) -> Result<(), String>
    where
        F: FnMut(&mut Music),
    {
        self.mutate(|data| {
            for playlist in &mut data.playlists {
                for entry in &mut playlist.entries {
                    for music in &mut entry.musics {
                        if music.path == path {
                            updater(music);
                        }
                    }
                    recompute_entry_avg(entry);
                }

                for music in &mut playlist.exclude {
                    if music.path == path {
                        updater(music);
                    }
                }

                recompute_playlist_avg(playlist);
            }
            Ok(())
        })
        .await
    }

    pub async fn update_music_batch(&self, musics: Vec<Music>) -> Result<(), String> {
        if musics.is_empty() {
            return Ok(());
        }

        let updates = musics
            .into_iter()
            .map(|music| (music.path.clone(), music))
            .collect::<HashMap<_, _>>();

        self.mutate(|data| {
            for playlist in &mut data.playlists {
                for entry in &mut playlist.entries {
                    for music in &mut entry.musics {
                        if let Some(updated) = updates.get(&music.path) {
                            *music = updated.clone();
                        }
                    }
                    recompute_entry_avg(entry);
                }

                for music in &mut playlist.exclude {
                    if let Some(updated) = updates.get(&music.path) {
                        *music = updated.clone();
                    }
                }

                recompute_playlist_avg(playlist);
            }
            Ok(())
        })
        .await
    }

    pub async fn remove_music_by_path(&self, path: &str) -> Result<(), String> {
        self.mutate(|data| {
            for playlist in &mut data.playlists {
                for entry in &mut playlist.entries {
                    entry.musics.retain(|m| m.path != path);
                    recompute_entry_avg(entry);
                }
                playlist.exclude.retain(|m| m.path != path);
                recompute_playlist_avg(playlist);
            }
            Ok(())
        })
        .await
    }

    pub async fn add_exclude(&self, playlist_name: &str, music: Music) -> Result<(), String> {
        self.mutate(|data| {
            let Some(playlist) = data.playlists.iter_mut().find(|p| p.name == playlist_name) else {
                return Err(format!("playlist not found: {playlist_name}"));
            };

            if !playlist.exclude.iter().any(|m| m.path == music.path) {
                playlist.exclude.push(music);
            }
            Ok(())
        })
        .await
    }

    pub async fn remove_exclude(&self, playlist_name: &str, path: &str) -> Result<(), String> {
        self.mutate(|data| {
            let Some(playlist) = data.playlists.iter_mut().find(|p| p.name == playlist_name) else {
                return Err(format!("playlist not found: {playlist_name}"));
            };

            playlist.exclude.retain(|m| m.path != path);
            Ok(())
        })
        .await
    }

    pub async fn reset_logits(&self) -> Result<(), String> {
        self.mutate(|data| {
            for playlist in &mut data.playlists {
                for entry in &mut playlist.entries {
                    for music in &mut entry.musics {
                        music.fatigue = 0.0;
                        music.user_boost = 0.0;
                        music.diversity = 0.0;
                    }
                }
                for music in &mut playlist.exclude {
                    music.fatigue = 0.0;
                    music.user_boost = 0.0;
                    music.diversity = 0.0;
                }
            }
            Ok(())
        })
        .await
    }

    async fn mutate<R, F>(&self, mutator: F) -> Result<R, String>
    where
        F: FnOnce(&mut LibraryData) -> Result<R, String>,
    {
        let _guard = self.write_lock.lock().await;
        let mut data = self.store.load_data().await?;
        let output = mutator(&mut data)?;
        self.store.save_data(&data).await?;
        Ok(output)
    }
}

pub fn repository() -> Result<&'static Arc<LibraryRepo>, String> {
    #[cfg(test)]
    {
        let guard = TEST_REPOSITORY.lock().expect("test repo lock");
        if let Some(repo) = guard.as_ref() {
            let repo_ptr = repo as *const Arc<LibraryRepo>;
            drop(guard);
            return Ok(unsafe { &*repo_ptr });
        }
    }

    REPOSITORY
        .get()
        .ok_or_else(|| "repository not initialized".to_string())
}

#[cfg(test)]
pub(crate) fn set_repository_for_tests(repo: Arc<LibraryRepo>) -> RepoTestGuard {
    *TEST_REPOSITORY.lock().expect("test repo lock") = Some(repo);
    RepoTestGuard
}

#[cfg(test)]
impl Drop for RepoTestGuard {
    fn drop(&mut self) {
        *TEST_REPOSITORY.lock().expect("test repo lock") = None;
    }
}

pub async fn init_repository(app: &AppHandle) -> Result<(), String> {
    if REPOSITORY.get().is_some() {
        return Ok(());
    }

    let local_data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let db_path = local_data_dir.join("surreal.db");
    let store: Arc<dyn SnapshotStore> = Arc::new(SurrealStore::open(db_path.clone()).await?);
    bootstrap_from_legacy_json_if_needed(app, &store).await?;
    println!("[music-repo] using surreal store at {}", db_path.display());

    let repo = Arc::new(LibraryRepo::new(store));
    println!("[music-repo] backend={}", repo.engine_name());
    let _ = REPOSITORY.set(repo);
    Ok(())
}

async fn bootstrap_from_legacy_json_if_needed(
    app: &AppHandle,
    store: &Arc<dyn SnapshotStore>,
) -> Result<(), String> {
    let current = store.load_data().await?;
    if !current.playlists.is_empty() {
        return Ok(());
    }

    let legacy_path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("data")
        .join("library.json");

    if !legacy_path.exists() {
        return Ok(());
    }

    let raw = tokio::fs::read_to_string(&legacy_path)
        .await
        .map_err(|e| format!("read legacy library json failed: {e}"))?;
    let parsed: LibraryData =
        serde_json::from_str(&raw).map_err(|e| format!("parse legacy library json failed: {e}"))?;
    let prepared = prepare_legacy_data_for_store(parsed);
    if prepared.playlists.is_empty() {
        return Ok(());
    }

    let playlist_count = prepared.playlists.len();
    store.save_data(&prepared).await?;
    println!(
        "[music-repo] imported {playlist_count} playlists from legacy json at {}",
        legacy_path.display()
    );
    Ok(())
}

fn prepare_legacy_data_for_store(mut data: LibraryData) -> LibraryData {
    data.schema_version = MUSIC_LIBRARY_SCHEMA_VERSION;
    for playlist in &mut data.playlists {
        let entries = std::mem::take(&mut playlist.entries);
        playlist.entries = dedup_entries(entries);
        for entry in &mut playlist.entries {
            if let Some(path) = &entry.path {
                if path.is_empty() {
                    entry.path = None;
                }
            }
            if let Some(url) = &entry.url {
                if url.is_empty() {
                    entry.url = None;
                }
            }
            recompute_entry_avg(entry);
        }
        recompute_playlist_avg(playlist);
    }
    data
}

fn replace_or_insert_entry(entries: &mut Vec<Entry>, entry: Entry) {
    if !replace_if_exists(entries, &entry) {
        entries.push(entry);
    }
    let mut seen = HashMap::new();
    entries.retain(|e| seen.insert(entry_key(e), true).is_none());
}

fn replace_if_exists(entries: &mut [Entry], incoming: &Entry) -> bool {
    for entry in entries {
        if same_entry_slot(entry, incoming) {
            *entry = incoming.clone();
            return true;
        }
    }
    false
}

fn same_entry_slot(existing: &Entry, incoming: &Entry) -> bool {
    match (&existing.path, &incoming.path) {
        (Some(a), Some(b)) => return a == b,
        _ => {}
    }

    match (&existing.url, &incoming.url) {
        (Some(a), Some(b)) => return a == b,
        _ => {}
    }

    existing.name == incoming.name
}

#[cfg(test)]
mod tests {
    use super::{prepare_legacy_data_for_store, same_entry_slot};
    use crate::domain::music::types::{
        Entry, EntryType, LibraryData, Music, Playlist, MUSIC_LIBRARY_SCHEMA_VERSION,
    };

    #[test]
    fn prepare_legacy_data_should_dedup_entries_and_recompute_avg() {
        let music_a = Music {
            path: "a.flac".to_string(),
            title: "a".to_string(),
            avg_db: Some(-10.0),
            integrated_lufs: Some(-10.0),
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
        };
        let music_b = Music {
            path: "b.flac".to_string(),
            title: "b".to_string(),
            avg_db: Some(-20.0),
            integrated_lufs: Some(-20.0),
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
        };

        let dup_a = Entry {
            path: Some("a.flac".to_string()),
            name: "A".to_string(),
            musics: vec![music_a.clone()],
            avg_db: Some(-99.0),
            url: None,
            downloaded_ok: Some(true),
            tracking: Some(false),
            entry_type: EntryType::Local,
        };
        let dup_b = Entry {
            path: Some("a.flac".to_string()),
            name: "A duplicate".to_string(),
            musics: vec![music_b.clone()],
            avg_db: Some(-99.0),
            url: None,
            downloaded_ok: Some(true),
            tracking: Some(false),
            entry_type: EntryType::Local,
        };

        let data = LibraryData {
            schema_version: 999,
            playlists: vec![Playlist {
                name: "test".to_string(),
                avg_db: Some(-99.0),
                entries: vec![dup_a, dup_b],
                exclude: vec![],
            }],
        };

        let prepared = prepare_legacy_data_for_store(data);
        assert_eq!(prepared.schema_version, MUSIC_LIBRARY_SCHEMA_VERSION);
        assert_eq!(prepared.playlists.len(), 1);
        assert_eq!(prepared.playlists[0].entries.len(), 1);
        assert_eq!(prepared.playlists[0].entries[0].avg_db, Some(-10.0));
        assert_eq!(prepared.playlists[0].avg_db, Some(-10.0));
    }

    #[test]
    fn prepare_legacy_data_should_null_playlist_avg_when_only_excluded_tracks_are_canonical() {
        let data = LibraryData {
            schema_version: 999,
            playlists: vec![Playlist {
                name: "test".to_string(),
                avg_db: Some(-99.0),
                entries: vec![Entry {
                    path: Some("a.flac".to_string()),
                    name: "A".to_string(),
                    musics: vec![Music {
                        path: "a.flac".to_string(),
                        title: "a".to_string(),
                        avg_db: Some(-10.0),
                        integrated_lufs: None,
                        true_peak_dbtp: None,
                        loudness_range_lu: None,
                        loudness_threshold_lufs: None,
                        analyzed_at_ms: None,
                        analysis_version: None,
                        source_mtime_ms: None,
                        source_size_bytes: None,
                        normalization_status: Some(crate::domain::music::types::NormalizationStatus::Ready),
                        normalization_error: None,
                        base_bias: 0.0,
                        user_boost: 0.0,
                        fatigue: 0.0,
                        diversity: 0.0,
                    }],
                    avg_db: Some(-10.0),
                    url: None,
                    downloaded_ok: Some(true),
                    tracking: Some(false),
                    entry_type: EntryType::Local,
                }],
                exclude: vec![Music {
                    path: "excluded.flac".to_string(),
                    title: "excluded".to_string(),
                    avg_db: Some(-30.0),
                    integrated_lufs: Some(-30.0),
                    true_peak_dbtp: Some(-1.0),
                    loudness_range_lu: Some(2.0),
                    loudness_threshold_lufs: None,
                    analyzed_at_ms: Some(1),
                    analysis_version: Some(1),
                    source_mtime_ms: Some(2),
                    source_size_bytes: Some(3),
                    normalization_status: Some(crate::domain::music::types::NormalizationStatus::Ready),
                    normalization_error: None,
                    base_bias: 0.0,
                    user_boost: 0.0,
                    fatigue: 0.0,
                    diversity: 0.0,
                }],
            }],
        };

        let prepared = prepare_legacy_data_for_store(data);
        assert_eq!(prepared.playlists[0].entries[0].avg_db, None);
        assert_eq!(prepared.playlists[0].avg_db, None);
    }

    #[test]
    fn prepare_legacy_data_does_not_promote_avg_db_into_canonical_fields() {
        let data = LibraryData {
            schema_version: 1,
            playlists: vec![Playlist {
                name: "test".to_string(),
                avg_db: Some(-99.0),
                entries: vec![Entry {
                    path: Some("a.flac".to_string()),
                    name: "A".to_string(),
                    musics: vec![Music {
                        path: "a.flac".to_string(),
                        title: "a".to_string(),
                        avg_db: Some(-10.0),
                        integrated_lufs: None,
                        true_peak_dbtp: None,
                        loudness_range_lu: None,
                        loudness_threshold_lufs: None,
                        analyzed_at_ms: None,
                        analysis_version: None,
                        source_mtime_ms: None,
                        source_size_bytes: None,
                        normalization_status: Some(crate::domain::music::types::NormalizationStatus::Ready),
                        normalization_error: None,
                        base_bias: 0.0,
                        user_boost: 0.0,
                        fatigue: 0.0,
                        diversity: 0.0,
                    }],
                    avg_db: Some(-10.0),
                    url: None,
                    downloaded_ok: Some(true),
                    tracking: Some(false),
                    entry_type: EntryType::Local,
                }],
                exclude: vec![],
            }],
        };

        let prepared = prepare_legacy_data_for_store(data);
        let entry = &prepared.playlists[0].entries[0];
        let music = &entry.musics[0];

        assert_eq!(music.integrated_lufs, None);
        assert_eq!(entry.avg_db, None);
        assert_eq!(prepared.playlists[0].avg_db, None);
    }

    #[test]
    fn prepare_legacy_data_keeps_canonical_analysis_metadata_for_fresh_rows() {
        let data = LibraryData {
            schema_version: 1,
            playlists: vec![Playlist {
                name: "test".to_string(),
                avg_db: Some(-99.0),
                entries: vec![Entry {
                    path: Some("a.flac".to_string()),
                    name: "A".to_string(),
                    musics: vec![Music {
                        path: "a.flac".to_string(),
                        title: "a".to_string(),
                        avg_db: Some(-10.0),
                        integrated_lufs: Some(-18.5),
                        true_peak_dbtp: Some(-1.2),
                        loudness_range_lu: Some(4.2),
                        loudness_threshold_lufs: Some(-28.0),
                        analyzed_at_ms: Some(123),
                        analysis_version: Some(1),
                        source_mtime_ms: Some(456),
                        source_size_bytes: Some(789),
                        normalization_status: Some(crate::domain::music::types::NormalizationStatus::Ready),
                        normalization_error: None,
                        base_bias: 0.0,
                        user_boost: 0.0,
                        fatigue: 0.0,
                        diversity: 0.0,
                    }],
                    avg_db: Some(-10.0),
                    url: None,
                    downloaded_ok: Some(true),
                    tracking: Some(false),
                    entry_type: EntryType::Local,
                }],
                exclude: vec![],
            }],
        };

        let prepared = prepare_legacy_data_for_store(data);
        let music = &prepared.playlists[0].entries[0].musics[0];

        assert_eq!(music.integrated_lufs, Some(-18.5));
        assert_eq!(music.true_peak_dbtp, Some(-1.2));
        assert_eq!(music.loudness_range_lu, Some(4.2));
        assert_eq!(music.loudness_threshold_lufs, Some(-28.0));
        assert_eq!(music.analyzed_at_ms, Some(123));
        assert_eq!(music.analysis_version, Some(1));
        assert_eq!(music.source_mtime_ms, Some(456));
        assert_eq!(music.source_size_bytes, Some(789));
        assert_eq!(music.normalization_status, Some(crate::domain::music::types::NormalizationStatus::Ready));
        assert_eq!(music.normalization_error, None);
    }

    fn sample_entry(
        name: &str,
        path: Option<&str>,
        url: Option<&str>,
    ) -> Entry {
        Entry {
            path: path.map(str::to_string),
            name: name.to_string(),
            musics: vec![],
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

    #[test]
    fn same_entry_slot_true_positive_matches_same_path_identity() {
        let existing = sample_entry("alpha", Some("C:/music/alpha"), None);
        let incoming = sample_entry("alpha renamed", Some("C:/music/alpha"), None);

        assert!(same_entry_slot(&existing, &incoming));
    }

    #[test]
    fn same_entry_slot_true_positive_matches_same_url_identity() {
        let existing = sample_entry("daily mix", None, Some("https://example.com/list"));
        let incoming = sample_entry("daily mix reloaded", None, Some("https://example.com/list"));

        assert!(same_entry_slot(&existing, &incoming));
    }

    #[test]
    fn same_entry_slot_true_negative_rejects_distinct_name_only_entries() {
        let existing = sample_entry("alpha", None, None);
        let incoming = sample_entry("beta", None, None);

        assert!(!same_entry_slot(&existing, &incoming));
    }

    #[test]
    fn same_entry_slot_false_positive_guard_rejects_same_name_with_different_identity() {
        let existing = sample_entry("duplicate-title", Some("C:/music/one"), None);
        let incoming = sample_entry("duplicate-title", Some("C:/music/two"), None);

        assert!(!same_entry_slot(&existing, &incoming));
    }

    #[test]
    fn same_entry_slot_false_negative_guard_keeps_name_only_identity_when_no_stronger_key_exists() {
        let existing = sample_entry("name-only", None, None);
        let incoming = sample_entry("name-only", None, None);

        assert!(same_entry_slot(&existing, &incoming));
    }
}
