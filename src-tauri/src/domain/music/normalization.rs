use super::repo::repository;
use super::types::{
    default_music, sync_legacy_loudness_fields, Music, NormalizationStatus, Playlist, ProcessMsg,
    MUSIC_ANALYSIS_VERSION,
};
use crate::utils::ffmpeg;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

pub const PLAYBACK_TARGET_LUFS: f32 = -18.0;
const NORMALIZATION_BOOTSTRAP_PLAYLIST: &str = "__library__";
const ANALYSIS_MAX_RESERVED_CORES: usize = 8;
const ANALYSIS_MAX_CONCURRENCY: usize = 16;
const ANALYSIS_PERSIST_BATCH: usize = 64;

static ANALYSIS_SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct PlaybackNormalization {
    pub target_lufs: f32,
    pub integrated_lufs: Option<f32>,
    pub true_peak_dbtp: Option<f32>,
}

pub async fn bootstrap_library_normalization(app: &AppHandle) -> Result<usize, String> {
    let repo = repository()?;
    let snapshot = repo.snapshot().await?;
    let stale = collect_stale_paths(&snapshot);
    analyze_paths_blocking(
        app,
        stale,
        NORMALIZATION_BOOTSTRAP_PLAYLIST,
        "Updating loudness library",
    )
    .await
}

pub async fn analyze_paths_blocking(
    app: &AppHandle,
    paths: Vec<String>,
    playlist: &str,
    label: &str,
) -> Result<usize, String> {
    let index = repository()?.music_index().await?;
    let mut queue = paths_to_music_queue(paths, &index);
    let total = queue.len();
    if total == 0 {
        return Ok(0);
    }

    let concurrency = analysis_parallelism(total);
    let mut in_flight = JoinSet::new();
    let mut completed = 0usize;
    let mut first_error: Option<String> = None;
    let mut persist_batch = Vec::with_capacity(ANALYSIS_PERSIST_BATCH);

    while in_flight.len() < concurrency {
        let Some(music) = queue.pop_front() else {
            break;
        };
        spawn_analysis_task(&mut in_flight, app.clone(), music);
    }

    while let Some(joined) = in_flight.join_next().await {
        match joined {
            Ok((music_path, result)) => {
                completed += 1;
                ProcessMsg {
                    playlist: playlist.to_string(),
                    str: format!(
                        "{label} {}/{}: {}",
                        completed,
                        total,
                        path_display_name(&music_path)
                    ),
                }
                .emit(app)
                .ok();

                match result {
                    Ok(music) => {
                        persist_batch.push(music);
                        if persist_batch.len() >= ANALYSIS_PERSIST_BATCH {
                            if let Err(error) = flush_analysis_batch(&mut persist_batch).await {
                                if first_error.is_none() {
                                    first_error = Some(error);
                                }
                            }
                        }
                    }
                    Err(error) => {
                        let _ = persist_analysis_failure(&music_path, error.clone()).await;
                        if first_error.is_none() {
                            first_error = Some(error);
                        }
                    }
                }
            }
            Err(error) => {
                completed += 1;
                if first_error.is_none() {
                    first_error = Some(format!("analysis worker join failed: {error}"));
                }
            }
        }

        while in_flight.len() < concurrency {
            let Some(music) = queue.pop_front() else {
                break;
            };
            spawn_analysis_task(&mut in_flight, app.clone(), music);
        }
    }

    if let Err(error) = flush_analysis_batch(&mut persist_batch).await {
        if first_error.is_none() {
            first_error = Some(error);
        }
    }

    match first_error {
        Some(error) => Err(error),
        None => Ok(total),
    }
}

pub fn stale_music_paths(musics: &[Music]) -> Vec<String> {
    dedup_paths(
        musics
            .iter()
            .filter(|music| !is_analysis_fresh(music))
            .map(|music| music.path.clone())
            .collect(),
    )
}

async fn persist_analysis_failure(path: &str, error: String) -> Result<(), String> {
    let path = path.to_string();
    repository()?
        .update_music_by_path(&path, move |music| {
            apply_analysis_failure(music, error.clone());
        })
        .await
}

fn apply_analysis_failure(music: &mut Music, error: String) {
    let analyzed_at_ms = now_timestamp_ms();
    music.integrated_lufs = None;
    music.avg_db = None;
    music.true_peak_dbtp = None;
    music.loudness_range_lu = None;
    music.loudness_threshold_lufs = None;
    music.analyzed_at_ms = Some(analyzed_at_ms);
    music.analysis_version = Some(MUSIC_ANALYSIS_VERSION);
    music.normalization_status = Some(NormalizationStatus::Failed);
    music.normalization_error = Some(error);

    match source_fingerprint(Path::new(&music.path)) {
        Ok((mtime_ms, size_bytes)) => {
            music.source_mtime_ms = Some(mtime_ms);
            music.source_size_bytes = Some(size_bytes);
        }
        Err(_) => {
            music.source_mtime_ms = None;
            music.source_size_bytes = None;
        }
    }

    sync_legacy_loudness_fields(music);
}

async fn current_music_by_path(path: &str) -> Result<Music, String> {
    let repo = repository()?;
    Ok(repo
        .music_index()
        .await?
        .get(path)
        .cloned()
        .unwrap_or_else(|| default_music(path.to_string())))
}

pub async fn resolve_playback_normalization(
    app: &AppHandle,
    path: &str,
) -> Result<PlaybackNormalization, String> {
    let _ = app;
    let music = current_music_by_path(path).await?;
    let (integrated_lufs, true_peak_dbtp) = if is_analysis_fresh(&music) {
        (music.integrated_lufs, music.true_peak_dbtp)
    } else {
        (None, None)
    };
    let target_lufs = PLAYBACK_TARGET_LUFS;

    Ok(PlaybackNormalization {
        target_lufs,
        integrated_lufs,
        true_peak_dbtp,
    })
}

fn collect_stale_paths(playlists: &[Playlist]) -> Vec<String> {
    let mut paths = Vec::new();
    for playlist in playlists {
        for entry in &playlist.entries {
            paths.extend(stale_music_paths(&entry.musics));
        }
        paths.extend(stale_music_paths(&playlist.exclude));
    }
    dedup_paths(paths)
}

fn dedup_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for path in paths {
        if path.trim().is_empty() {
            continue;
        }
        if seen.insert(path.clone()) {
            deduped.push(path);
        }
    }
    deduped
}

fn paths_to_music_queue(paths: Vec<String>, index: &HashMap<String, Music>) -> VecDeque<Music> {
    dedup_paths(paths)
        .into_iter()
        .map(|path| {
            index
                .get(&path)
                .cloned()
                .unwrap_or_else(|| default_music(path))
        })
        .collect()
}

fn analysis_parallelism(total: usize) -> usize {
    let cpu_count = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(8);
    analysis_parallelism_for(cpu_count, total)
}

fn global_analysis_parallelism() -> usize {
    let cpu_count = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(8);
    analysis_parallelism_for(cpu_count, usize::MAX)
}

fn analysis_parallelism_for(cpu_count: usize, total: usize) -> usize {
    let cores = cpu_count.max(1);
    let reserved = cores.div_ceil(3).clamp(1, ANALYSIS_MAX_RESERVED_CORES);
    let budget = cores.saturating_sub(reserved).max(1);
    let soft_cap = (cores / 2).max(2);

    budget
        .min(soft_cap)
        .clamp(1, ANALYSIS_MAX_CONCURRENCY)
        .min(total.max(1))
}

fn analysis_semaphore() -> Arc<Semaphore> {
    ANALYSIS_SEMAPHORE
        .get_or_init(|| Arc::new(Semaphore::new(global_analysis_parallelism())))
        .clone()
}

async fn flush_analysis_batch(batch: &mut Vec<Music>) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }

    repository()?
        .update_music_batch(std::mem::take(batch))
        .await
}

fn spawn_analysis_task(
    join_set: &mut JoinSet<(String, Result<Music, String>)>,
    app: AppHandle,
    music: Music,
) {
    let semaphore = analysis_semaphore();
    join_set.spawn(async move {
        let path = music.path.clone();
        let permit = semaphore
            .acquire_owned()
            .await
            .map_err(|_| "analysis semaphore closed".to_string());
        let result = match permit {
            Ok(_permit) => refresh_analysis_for_path(&app, music).await,
            Err(error) => Err(error),
        };
        (path, result)
    });
}

fn is_analysis_fresh(music: &Music) -> bool {
    if music.analysis_version != Some(MUSIC_ANALYSIS_VERSION) {
        return false;
    }
    if music.normalization_status != Some(NormalizationStatus::Ready) {
        return false;
    }
    if music.normalization_error.is_some() {
        return false;
    }
    if music.integrated_lufs.is_none()
        || music.true_peak_dbtp.is_none()
        || music.loudness_range_lu.is_none()
    {
        return false;
    }

    let Ok((mtime_ms, size_bytes)) = source_fingerprint(Path::new(&music.path)) else {
        return false;
    };

    music.source_mtime_ms == Some(mtime_ms) && music.source_size_bytes == Some(size_bytes)
}

async fn refresh_analysis_for_path(app: &AppHandle, mut music: Music) -> Result<Music, String> {
    let path = Path::new(&music.path);
    if !path.exists() {
        return Err(format!("audio file not found: {}", music.path));
    }

    let (mtime_ms, size_bytes) = source_fingerprint(path)?;
    let analyzed_at_ms = now_timestamp_ms();

    match ffmpeg::analyze_loudness(app, path).await {
        Ok(scan) => {
            music.integrated_lufs = Some(scan.integrated_lufs);
            music.true_peak_dbtp = Some(scan.true_peak_dbtp);
            music.loudness_range_lu = Some(scan.loudness_range_lu);
            music.loudness_threshold_lufs = Some(scan.loudness_threshold_lufs);
            music.analyzed_at_ms = Some(analyzed_at_ms);
            music.analysis_version = Some(MUSIC_ANALYSIS_VERSION);
            music.source_mtime_ms = Some(mtime_ms);
            music.source_size_bytes = Some(size_bytes);
            music.normalization_status = Some(NormalizationStatus::Ready);
            music.normalization_error = None;
        }
        Err(error) => {
            music.integrated_lufs = None;
            music.avg_db = None;
            music.true_peak_dbtp = None;
            music.loudness_range_lu = None;
            music.loudness_threshold_lufs = None;
            music.analyzed_at_ms = Some(analyzed_at_ms);
            music.analysis_version = Some(MUSIC_ANALYSIS_VERSION);
            music.source_mtime_ms = Some(mtime_ms);
            music.source_size_bytes = Some(size_bytes);
            music.normalization_status = Some(NormalizationStatus::Failed);
            music.normalization_error = Some(error);
        }
    }

    sync_legacy_loudness_fields(&mut music);

    Ok(music)
}

fn source_fingerprint(path: &Path) -> Result<(i64, i64), String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = metadata.modified().map_err(|e| e.to_string())?;
    let modified_ms = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    Ok((modified_ms, metadata.len() as i64))
}

fn now_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn path_display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        analysis_parallelism_for, dedup_paths, global_analysis_parallelism, is_analysis_fresh,
        stale_music_paths, Music, NormalizationStatus, PlaybackNormalization,
        ANALYSIS_MAX_CONCURRENCY, PLAYBACK_TARGET_LUFS,
    };
    use crate::domain::music::repo::{set_repository_for_tests, LibraryRepo};
    use crate::domain::music::store::SnapshotStore;
    use crate::domain::music::types::{Entry, EntryType, LibraryData, Playlist};
    use async_trait::async_trait;
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use tokio::sync::Mutex;

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

    struct TempAudioDir {
        root: PathBuf,
    }

    impl TempAudioDir {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "slisic-normalization-test-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("duration")
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).expect("create temp dir");
            Self { root }
        }

        fn write_file(&self, relative: &str, contents: &[u8]) -> PathBuf {
            let path = self.root.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("create parent dir");
            }
            std::fs::write(&path, contents).expect("write temp file");
            path
        }

        fn path(&self) -> &Path {
            &self.root
        }
    }

    impl Drop for TempAudioDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn fingerprint(path: &Path) -> (i64, i64) {
        super::source_fingerprint(path).expect("fingerprint")
    }

    fn canonical_music(path: &Path, integrated_lufs: f32) -> Music {
        let mut music = sample_music();
        let (mtime_ms, size_bytes) = fingerprint(path);
        music.path = path.to_string_lossy().to_string();
        music.title = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("track")
            .to_string();
        music.avg_db = None;
        music.integrated_lufs = Some(integrated_lufs);
        music.true_peak_dbtp = Some(-1.0);
        music.loudness_range_lu = Some(4.5);
        music.loudness_threshold_lufs = Some(-28.0);
        music.analyzed_at_ms = Some(100);
        music.analysis_version = Some(super::MUSIC_ANALYSIS_VERSION);
        music.source_mtime_ms = Some(mtime_ms);
        music.source_size_bytes = Some(size_bytes);
        music.normalization_status = Some(NormalizationStatus::Ready);
        music.normalization_error = None;
        music
    }

    fn legacy_music(path: &Path) -> Music {
        let mut music = sample_music();
        music.path = path.to_string_lossy().to_string();
        music.title = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("track")
            .to_string();
        music.avg_db = Some(-12.0);
        music.integrated_lufs = None;
        music.true_peak_dbtp = None;
        music.loudness_range_lu = None;
        music.loudness_threshold_lufs = None;
        music.analyzed_at_ms = None;
        music.analysis_version = None;
        music.source_mtime_ms = None;
        music.source_size_bytes = None;
        music.normalization_status = Some(NormalizationStatus::Pending);
        music.normalization_error = None;
        music
    }

    fn playlist_entry(name: &str, folder: &Path, musics: Vec<Music>) -> Entry {
        Entry {
            path: Some(folder.to_string_lossy().to_string()),
            name: name.to_string(),
            musics,
            avg_db: None,
            url: None,
            downloaded_ok: Some(true),
            tracking: Some(false),
            entry_type: EntryType::Local,
        }
    }

    fn playlist_fixture(entries: Vec<Entry>, exclude: Vec<Music>) -> Playlist {
        Playlist {
            name: "library".to_string(),
            avg_db: None,
            entries,
            exclude,
        }
    }

    fn sample_music() -> Music {
        Music {
            path: "C:/music/track.flac".to_string(),
            title: "track".to_string(),
            avg_db: Some(-12.0),
            integrated_lufs: Some(-18.0),
            true_peak_dbtp: Some(-1.0),
            loudness_range_lu: Some(5.0),
            loudness_threshold_lufs: Some(-28.0),
            analyzed_at_ms: Some(100),
            analysis_version: Some(super::MUSIC_ANALYSIS_VERSION),
            source_mtime_ms: Some(1),
            source_size_bytes: Some(2),
            normalization_status: Some(NormalizationStatus::Ready),
            normalization_error: None,
            base_bias: 0.0,
            user_boost: 0.0,
            fatigue: 0.0,
            diversity: 0.0,
        }
    }

    #[test]
    fn dedup_paths_should_preserve_first_occurrence() {
        let paths = dedup_paths(vec![
            "a.flac".to_string(),
            "b.flac".to_string(),
            "a.flac".to_string(),
            "".to_string(),
        ]);
        assert_eq!(paths, vec!["a.flac".to_string(), "b.flac".to_string()]);
    }

    #[test]
    fn stale_music_paths_should_return_only_stale_unique_paths() {
        let mut stale = sample_music();
        stale.path = "a.flac".to_string();
        stale.integrated_lufs = None;
        stale.true_peak_dbtp = None;
        stale.loudness_range_lu = None;

        let mut duplicate = stale.clone();
        duplicate.path = "a.flac".to_string();

        let mut ready = sample_music();
        ready.path = "ready.flac".to_string();
        ready.source_mtime_ms = None;
        ready.source_size_bytes = None;

        let paths = stale_music_paths(&[stale, duplicate, ready]);
        assert_eq!(paths, vec!["a.flac".to_string(), "ready.flac".to_string()]);
    }

    #[test]
    fn analysis_parallelism_should_keep_headroom_on_large_cpus() {
        assert_eq!(analysis_parallelism_for(24, 1_000), 12);
        assert_eq!(analysis_parallelism_for(16, 1_000), 8);
        assert_eq!(analysis_parallelism_for(8, 1_000), 4);
    }

    #[test]
    fn analysis_parallelism_should_not_overcommit_small_cpus() {
        assert_eq!(analysis_parallelism_for(4, 1_000), 2);
        assert_eq!(analysis_parallelism_for(2, 1_000), 1);
        assert_eq!(analysis_parallelism_for(1, 1_000), 1);
        assert_eq!(analysis_parallelism_for(24, 3), 3);
    }

    #[test]
    fn global_analysis_parallelism_should_stay_within_bounds() {
        let value = global_analysis_parallelism();
        assert!(value >= 1);
        assert!(value <= ANALYSIS_MAX_CONCURRENCY);
    }

    #[test]
    fn legacy_only_rows_are_not_fresh() {
        let mut music = sample_music();
        music.integrated_lufs = None;
        music.true_peak_dbtp = None;
        music.loudness_range_lu = None;
        assert!(!is_analysis_fresh(&music));
    }

    #[test]
    fn canonical_ready_requires_full_descriptor_contract() {
        let music = sample_music();
        assert!(!is_analysis_fresh(&music));

        let temp_dir = std::env::temp_dir().join(format!(
            "slisic-normalization-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("duration")
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).expect("create temp dir");
        let temp_path = temp_dir.join("track.flac");
        std::fs::write(&temp_path, b"test audio").expect("write temp file");
        let metadata = std::fs::metadata(&temp_path).expect("metadata");
        let modified = metadata.modified().expect("modified");
        let modified_ms = modified
            .duration_since(std::time::UNIX_EPOCH)
            .expect("duration")
            .as_millis() as i64;
        let mut ready = sample_music();
        ready.path = temp_path.to_string_lossy().to_string();
        ready.source_mtime_ms = Some(modified_ms);
        ready.source_size_bytes = Some(metadata.len() as i64);
        assert!(is_analysis_fresh(&ready));

        let mut missing_lra = ready.clone();
        missing_lra.loudness_range_lu = None;
        assert!(!is_analysis_fresh(&missing_lra));

        let mut mismatched_fingerprint = ready.clone();
        mismatched_fingerprint.source_size_bytes = Some(metadata.len() as i64 + 1);
        assert!(!is_analysis_fresh(&mismatched_fingerprint));

        let mut errored = ready;
        errored.normalization_error = Some("bad scan".to_string());
        assert!(!is_analysis_fresh(&errored));

        let _ = std::fs::remove_file(&temp_path);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    async fn resolve_playback_normalization_for_tests(
        path: &str,
    ) -> Result<PlaybackNormalization, String> {
        let repo = crate::domain::music::repo::repository()?;
        let music = repo
            .music_index()
            .await?
            .get(path)
            .cloned()
            .unwrap_or_else(|| super::default_music(path.to_string()));

        let (integrated_lufs, true_peak_dbtp) = if super::is_analysis_fresh(&music) {
            (music.integrated_lufs, music.true_peak_dbtp)
        } else {
            (None, None)
        };

        Ok(PlaybackNormalization {
            target_lufs: PLAYBACK_TARGET_LUFS,
            integrated_lufs,
            true_peak_dbtp,
        })
    }

    #[tokio::test]
    async fn playback_normalization_ignores_legacy_avg_db() {
        let mut music = sample_music();
        music.avg_db = Some(-12.0);
        music.integrated_lufs = None;
        music.true_peak_dbtp = None;

        let store = Arc::new(TestStore {
            data: Mutex::new(LibraryData {
                schema_version: 2,
                playlists: vec![Playlist {
                    name: "list".to_string(),
                    avg_db: None,
                    entries: vec![crate::domain::music::types::Entry {
                        path: Some("C:/music".to_string()),
                        name: "entry".to_string(),
                        musics: vec![music.clone()],
                        avg_db: None,
                        url: None,
                        downloaded_ok: Some(true),
                        tracking: Some(false),
                        entry_type: crate::domain::music::types::EntryType::Local,
                    }],
                    exclude: vec![],
                }],
            }),
        });
        let _guard = set_repository_for_tests(Arc::new(LibraryRepo::new_for_tests(store)));
        let PlaybackNormalization {
            integrated_lufs,
            true_peak_dbtp,
            ..
        } = resolve_playback_normalization_for_tests(&music.path)
            .await
            .expect("resolve normalization");

        assert_eq!(integrated_lufs, None);
        assert_eq!(true_peak_dbtp, None);
    }

    #[tokio::test]
    async fn playback_normalization_ignores_status_incomplete_canonical_values() {
        let mut music = sample_music();
        music.avg_db = Some(-12.0);
        music.integrated_lufs = Some(-24.0);
        music.true_peak_dbtp = Some(-1.0);
        music.normalization_status = Some(NormalizationStatus::Pending);

        let path = music.path.clone();
        let store = Arc::new(TestStore {
            data: Mutex::new(LibraryData {
                schema_version: 2,
                playlists: vec![Playlist {
                    name: "list".to_string(),
                    avg_db: None,
                    entries: vec![crate::domain::music::types::Entry {
                        path: Some("C:/music".to_string()),
                        name: "entry".to_string(),
                        musics: vec![music],
                        avg_db: None,
                        url: None,
                        downloaded_ok: Some(true),
                        tracking: Some(false),
                        entry_type: crate::domain::music::types::EntryType::Local,
                    }],
                    exclude: vec![],
                }],
            }),
        });
        let _guard = set_repository_for_tests(Arc::new(LibraryRepo::new_for_tests(store)));

        let resolved = resolve_playback_normalization_for_tests(&path)
            .await
            .expect("resolve normalization");

        assert_eq!(resolved.integrated_lufs, None);
        assert_eq!(resolved.true_peak_dbtp, None);
    }

    #[tokio::test]
    async fn analysis_failure_clears_canonical_descriptors_in_store() {
        let mut music = sample_music();
        music.path = "C:/music/missing.flac".to_string();
        music.integrated_lufs = Some(-16.0);
        music.true_peak_dbtp = Some(-0.5);
        music.loudness_range_lu = Some(4.0);
        music.loudness_threshold_lufs = Some(-26.0);

        let store = Arc::new(TestStore {
            data: Mutex::new(LibraryData {
                schema_version: 2,
                playlists: vec![Playlist {
                    name: "list".to_string(),
                    avg_db: None,
                    entries: vec![Entry {
                        path: Some("C:/music".to_string()),
                        name: "entry".to_string(),
                        musics: vec![music.clone()],
                        avg_db: None,
                        url: None,
                        downloaded_ok: Some(true),
                        tracking: Some(false),
                        entry_type: EntryType::Local,
                    }],
                    exclude: vec![],
                }],
            }),
        });
        let repo = Arc::new(LibraryRepo::new_for_tests(store.clone()));
        let _guard = set_repository_for_tests(repo.clone());

        let error_message = "audio file not found: C:/music/missing.flac".to_string();
        repo.update_music_by_path(&music.path, |saved_music| {
            super::apply_analysis_failure(saved_music, error_message.clone());
        })
        .await
        .expect("persist failure");

        let saved = store.load_data().await.expect("load data");
        let failed = &saved.playlists[0].entries[0].musics[0];
        assert_eq!(failed.normalization_status, Some(NormalizationStatus::Failed));
        assert!(failed
            .normalization_error
            .as_deref()
            .is_some_and(|msg| msg.contains(&error_message)));
        assert_eq!(failed.integrated_lufs, None);
        assert_eq!(failed.true_peak_dbtp, None);
        assert_eq!(failed.loudness_range_lu, None);
        assert_eq!(failed.loudness_threshold_lufs, None);
        assert_eq!(failed.avg_db, None);
    }

    #[test]
    fn persist_analysis_failure_applies_failed_state_without_tauri_runtime() {
        let mut music = sample_music();
        music.integrated_lufs = Some(-16.0);
        music.true_peak_dbtp = Some(-0.5);
        music.loudness_range_lu = Some(4.0);
        music.loudness_threshold_lufs = Some(-26.0);

        super::apply_analysis_failure(
            &mut music,
            "audio file not found: C:/music/missing.flac".to_string(),
        );

        assert_eq!(music.normalization_status, Some(NormalizationStatus::Failed));
        assert!(music
            .normalization_error
            .as_deref()
            .is_some_and(|msg| msg.contains("audio file not found")));
        assert_eq!(music.integrated_lufs, None);
        assert_eq!(music.true_peak_dbtp, None);
        assert_eq!(music.loudness_range_lu, None);
        assert_eq!(music.loudness_threshold_lufs, None);
        assert_eq!(music.avg_db, None);
    }

    #[test]
    fn bootstrap_queues_legacy_rows_and_skips_fresh_canonical_rows() {
        let temp = TempAudioDir::new("bootstrap");
        let legacy_path = temp.write_file("legacy.flac", b"legacy");
        let ready_path = temp.write_file("ready.flac", b"ready");

        let queued = super::collect_stale_paths(&[playlist_fixture(
            vec![playlist_entry(
                "entry",
                temp.path(),
                vec![legacy_music(&legacy_path), canonical_music(&ready_path, -18.0)],
            )],
            vec![],
        )]);

        assert_eq!(queued, vec![legacy_path.to_string_lossy().to_string()]);
    }

    #[test]
    fn fingerprint_changes_invalidate_prior_analysis() {
        let temp = TempAudioDir::new("fingerprint");
        let path = temp.write_file("track.flac", b"before");
        let mut music = canonical_music(&path, -18.0);
        assert!(is_analysis_fresh(&music));

        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(&path, b"before-but-longer").expect("rewrite file");

        assert!(!is_analysis_fresh(&music));

        let (mtime_ms, size_bytes) = fingerprint(&path);
        music.source_mtime_ms = Some(mtime_ms);
        music.source_size_bytes = Some(size_bytes);
        assert!(is_analysis_fresh(&music));
    }

    #[tokio::test]
    async fn update_music_batch_propagates_one_canonical_result_to_shared_paths() {
        let temp = TempAudioDir::new("shared");
        let shared_path = temp.write_file("shared.flac", b"shared");
        let shared_string = shared_path.to_string_lossy().to_string();

        let mut source = canonical_music(&shared_path, -21.0);
        source.integrated_lufs = None;
        source.true_peak_dbtp = None;
        source.loudness_range_lu = None;
        source.analysis_version = None;
        source.source_mtime_ms = None;
        source.source_size_bytes = None;
        source.normalization_status = Some(NormalizationStatus::Pending);

        let store = Arc::new(TestStore {
            data: Mutex::new(LibraryData {
                schema_version: 2,
                playlists: vec![playlist_fixture(
                    vec![
                        playlist_entry("entry-a", temp.path(), vec![source.clone()]),
                        playlist_entry("entry-b", temp.path(), vec![source.clone()]),
                    ],
                    vec![source.clone()],
                )],
            }),
        });
        let _guard = set_repository_for_tests(Arc::new(LibraryRepo::new_for_tests(store.clone())));

        let analyzed = canonical_music(&shared_path, -16.5);
        crate::domain::music::repo::repository()
            .expect("repo")
            .update_music_batch(vec![analyzed.clone()])
            .await
            .expect("batch update");

        let saved = store.load_data().await.expect("load data");
        let mut observed = Vec::new();
        for playlist in &saved.playlists {
            for entry in &playlist.entries {
                for music in &entry.musics {
                    if music.path == shared_string {
                        observed.push(music.integrated_lufs);
                        assert_eq!(music.true_peak_dbtp, analyzed.true_peak_dbtp);
                        assert_eq!(music.loudness_range_lu, analyzed.loudness_range_lu);
                        assert_eq!(music.analysis_version, analyzed.analysis_version);
                    }
                }
            }
            for music in &playlist.exclude {
                if music.path == shared_string {
                    observed.push(music.integrated_lufs);
                }
            }
        }

        assert_eq!(observed, vec![Some(-16.5), Some(-16.5), Some(-16.5)]);
    }

    #[test]
    fn folder_recheck_only_marks_new_or_stale_files_for_analysis() {
        let temp = TempAudioDir::new("recheck");
        let keep_path = temp.write_file("keep.flac", b"keep");
        let stale_path = temp.write_file("stale.flac", b"stale");
        let new_path = temp.write_file("new.flac", b"new");

        let mut stale_music = canonical_music(&stale_path, -19.0);
        stale_music.analysis_version = Some(super::MUSIC_ANALYSIS_VERSION - 1);

        let updated = Entry {
            path: Some(temp.path().to_string_lossy().to_string()),
            name: "folder".to_string(),
            musics: vec![
                canonical_music(&keep_path, -18.0),
                stale_music,
                super::default_music(new_path.to_string_lossy().to_string()),
            ],
            avg_db: None,
            url: None,
            downloaded_ok: Some(true),
            tracking: Some(false),
            entry_type: EntryType::Local,
        };

        let stale = super::stale_music_paths(&updated.musics);
        let stale_set = stale.into_iter().collect::<HashSet<_>>();

        assert!(!stale_set.contains(&keep_path.to_string_lossy().to_string()));
        assert!(stale_set.contains(&stale_path.to_string_lossy().to_string()));
        assert!(stale_set.contains(&new_path.to_string_lossy().to_string()));
        assert_eq!(stale_set.len(), 2);
    }
}
