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
    REPOSITORY
        .get()
        .ok_or_else(|| "repository not initialized".to_string())
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
    data.schema_version = 1;
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
    use super::prepare_legacy_data_for_store;
    use crate::domain::music::types::{Entry, EntryType, LibraryData, Music, Playlist};

    #[test]
    fn prepare_legacy_data_should_dedup_entries_and_recompute_avg() {
        let music_a = Music {
            path: "a.flac".to_string(),
            title: "a".to_string(),
            avg_db: Some(-10.0),
            true_peak_dbtp: None,
            base_bias: 0.0,
            user_boost: 0.0,
            fatigue: 0.0,
            diversity: 0.0,
        };
        let music_b = Music {
            path: "b.flac".to_string(),
            title: "b".to_string(),
            avg_db: Some(-20.0),
            true_peak_dbtp: None,
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
        assert_eq!(prepared.schema_version, 1);
        assert_eq!(prepared.playlists.len(), 1);
        assert_eq!(prepared.playlists[0].entries.len(), 1);
        assert_eq!(prepared.playlists[0].entries[0].avg_db, Some(-10.0));
        assert_eq!(prepared.playlists[0].avg_db, Some(-10.0));
    }
}
