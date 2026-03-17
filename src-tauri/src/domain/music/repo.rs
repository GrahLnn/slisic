use super::store::SnapshotStore;
use super::store_surreal::SurrealStore;
use super::types::{
    dedup_entries, entry_key, recompute_entry_avg, recompute_playlist_avg, Entry, LibraryData,
    Music, Playlist,
};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Manager;
use tokio::sync::Mutex;

static REPOSITORY: std::sync::OnceLock<Arc<LibraryRepo>> = std::sync::OnceLock::new();
static REPOSITORY_APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
static REPOSITORY_INIT_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

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

    pub async fn playlist_names(&self) -> Result<Vec<String>, String> {
        self.store.load_playlist_names().await
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

pub fn install_repository_app(app: AppHandle) {
    let _ = REPOSITORY_APP.set(app);
}

pub async fn repository() -> Result<Arc<LibraryRepo>, String> {
    #[cfg(test)]
    {
        let guard = TEST_REPOSITORY.lock().expect("test repo lock");
        if let Some(repo) = guard.as_ref() {
            return Ok(repo.clone());
        }
    }

    if let Some(repo) = REPOSITORY.get() {
        return Ok(repo.clone());
    }

    let _guard = REPOSITORY_INIT_LOCK.lock().await;
    if let Some(repo) = REPOSITORY.get() {
        return Ok(repo.clone());
    }

    let app = REPOSITORY_APP
        .get()
        .cloned()
        .ok_or_else(|| "repository app handle not installed".to_string())?;
    let local_data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let db_path = local_data_dir.join("surreal.db");
    let store: Arc<dyn SnapshotStore> = Arc::new(SurrealStore::open(db_path.clone()).await?);
    println!("[music-repo] using surreal store at {}", db_path.display());

    let repo = Arc::new(LibraryRepo::new(store));
    println!("[music-repo] backend={}", repo.engine_name());
    let _ = REPOSITORY.set(repo.clone());
    Ok(repo)
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
    if let (Some(existing_url), Some(incoming_url)) = (&existing.url, &incoming.url) {
        if existing_url == incoming_url {
            return true;
        }
    }

    if let (Some(existing_path), Some(incoming_path)) = (&existing.path, &incoming.path) {
        if existing_path == incoming_path {
            return true;
        }
    }

    existing.path.is_none()
        && incoming.path.is_none()
        && existing.url.is_none()
        && incoming.url.is_none()
        && existing.name == incoming.name
}

#[cfg(test)]
mod tests {
    use super::{repository, same_entry_slot, LibraryRepo};
    use crate::domain::music::store::SnapshotStore;
    use crate::domain::music::types::{
        Entry, EntryType, LibraryData, Music, Playlist, MUSIC_LIBRARY_SCHEMA_VERSION,
    };
    use std::sync::{Arc, Mutex};

    fn sample_entry(name: &str, path: Option<&str>, url: Option<&str>) -> Entry {
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

    #[derive(Debug)]
    struct TestStore {
        data: Mutex<LibraryData>,
    }

    impl TestStore {
        fn new(data: LibraryData) -> Self {
            Self {
                data: Mutex::new(data),
            }
        }
    }

    #[async_trait::async_trait]
    impl SnapshotStore for TestStore {
        fn engine_name(&self) -> &'static str {
            "test"
        }

        async fn load_data(&self) -> Result<LibraryData, String> {
            Ok(self.data.lock().expect("test store lock").clone())
        }

        async fn save_data(&self, data: &LibraryData) -> Result<(), String> {
            *self.data.lock().expect("test store lock") = data.clone();
            Ok(())
        }
    }

    fn sample_track(path: &str) -> Music {
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

    #[tokio::test]
    async fn add_exclude_true_positive_adds_missing_music_once() {
        let music = sample_track("C:/music/a.flac");
        let repo = LibraryRepo::new_for_tests(Arc::new(TestStore::new(LibraryData {
            schema_version: MUSIC_LIBRARY_SCHEMA_VERSION,
            playlists: vec![Playlist {
                name: "focus".to_string(),
                avg_db: None,
                entries: vec![],
                exclude: vec![],
            }],
        })));

        repo.add_exclude("focus", music.clone())
            .await
            .expect("first add");
        repo.add_exclude("focus", music.clone())
            .await
            .expect("second add");

        let snapshot = repo.snapshot().await.expect("snapshot");
        assert_eq!(snapshot[0].exclude, vec![music]);
    }

    #[tokio::test]
    async fn playlist_names_true_positive_reads_names_in_store_order() {
        let repo = LibraryRepo::new_for_tests(Arc::new(TestStore::new(LibraryData {
            schema_version: MUSIC_LIBRARY_SCHEMA_VERSION,
            playlists: vec![
                Playlist {
                    name: "focus".to_string(),
                    avg_db: None,
                    entries: vec![],
                    exclude: vec![],
                },
                Playlist {
                    name: "ambient".to_string(),
                    avg_db: None,
                    entries: vec![],
                    exclude: vec![],
                },
            ],
        })));

        let names = repo.playlist_names().await.expect("playlist names");

        assert_eq!(names, vec!["focus".to_string(), "ambient".to_string()]);
    }

    #[tokio::test]
    async fn upsert_entry_false_negative_guard_replaces_pending_web_entry_after_download_by_url_identity(
    ) {
        let pending = Entry {
            path: None,
            name: "mix".to_string(),
            musics: vec![],
            avg_db: None,
            url: Some("https://example.com/list".to_string()),
            downloaded_ok: Some(false),
            tracking: Some(false),
            entry_type: EntryType::WebList,
        };
        let downloaded = Entry {
            path: Some("C:/music/mix".to_string()),
            name: "mix".to_string(),
            musics: vec![sample_track("C:/music/mix/a.flac")],
            avg_db: None,
            url: Some("https://example.com/list".to_string()),
            downloaded_ok: Some(true),
            tracking: Some(false),
            entry_type: EntryType::WebList,
        };
        let repo = LibraryRepo::new_for_tests(Arc::new(TestStore::new(LibraryData {
            schema_version: MUSIC_LIBRARY_SCHEMA_VERSION,
            playlists: vec![Playlist {
                name: "focus".to_string(),
                avg_db: None,
                entries: vec![pending],
                exclude: vec![],
            }],
        })));

        repo.upsert_entry_in_playlist("focus", downloaded.clone())
            .await
            .expect("replace pending web entry");

        let snapshot = repo.snapshot().await.expect("snapshot");
        assert_eq!(snapshot[0].entries.len(), 1);
        assert_eq!(snapshot[0].entries[0], downloaded);
    }

    #[tokio::test]
    async fn repository_false_negative_guard_uses_test_override_without_runtime_app_handle() {
        let repo = Arc::new(LibraryRepo::new_for_tests(Arc::new(TestStore::new(
            LibraryData {
                schema_version: MUSIC_LIBRARY_SCHEMA_VERSION,
                playlists: vec![],
            },
        ))));
        let _guard = super::set_repository_for_tests(repo.clone());

        let resolved = repository().await.expect("test repository should resolve");

        assert_eq!(resolved.engine_name(), "test");
        assert!(Arc::ptr_eq(&resolved, &repo));
    }

    #[tokio::test]
    async fn add_exclude_true_negative_errors_for_missing_playlist() {
        let repo = LibraryRepo::new_for_tests(Arc::new(TestStore::new(LibraryData {
            schema_version: MUSIC_LIBRARY_SCHEMA_VERSION,
            playlists: vec![],
        })));

        let error = repo
            .add_exclude("missing", sample_track("C:/music/a.flac"))
            .await
            .expect_err("missing playlist should fail");

        assert_eq!(error, "playlist not found: missing");
    }

    #[tokio::test]
    async fn remove_exclude_false_positive_guard_only_removes_target_path() {
        let keep = sample_track("C:/music/keep.flac");
        let drop = sample_track("C:/music/drop.flac");
        let repo = LibraryRepo::new_for_tests(Arc::new(TestStore::new(LibraryData {
            schema_version: MUSIC_LIBRARY_SCHEMA_VERSION,
            playlists: vec![Playlist {
                name: "focus".to_string(),
                avg_db: None,
                entries: vec![],
                exclude: vec![keep.clone(), drop],
            }],
        })));

        repo.remove_exclude("focus", "C:/music/drop.flac")
            .await
            .expect("remove exclude");

        let snapshot = repo.snapshot().await.expect("snapshot");
        assert_eq!(snapshot[0].exclude, vec![keep]);
    }
}
