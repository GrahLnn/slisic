mod domain {
    pub mod playlists {
        pub(crate) static PLAYLIST_DB_TEST_LOCK: std::sync::LazyLock<std::sync::Mutex<()>> =
            std::sync::LazyLock::new(|| std::sync::Mutex::new(()));

        pub mod model {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/playlists/model.rs"
            ));
        }

        pub mod repo {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/playlists/repo.rs"
            ));
        }
    }

    pub mod meta {
        pub mod model {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/meta/model.rs"
            ));
        }

        pub mod repo {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/meta/repo.rs"
            ));
        }

        pub mod service {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/meta/service.rs"
            ));
        }
    }

    pub mod downloads {
        pub mod model {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/model.rs"
            ));
        }

        pub mod planning {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/planning.rs"
            ));
        }

        pub mod repo {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/repo.rs"
            ));
        }

        pub mod naming {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/naming.rs"
            ));
        }

        pub mod yt_dlp {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/yt_dlp.rs"
            ));
        }

        pub mod service {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/service.rs"
            ));
        }
    }

    pub mod collection_import {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/domain/collection_import.rs"
        ));
    }

    pub mod loudness_evidence {
        use std::path::PathBuf;

        #[derive(Debug, Clone, PartialEq)]
        pub(crate) struct LoudnessEvidenceRequest {
            pub(crate) canonical_music_id: String,
            pub(crate) url: String,
            pub(crate) file_path: PathBuf,
            pub(crate) start_ms: u32,
            pub(crate) end_ms: u32,
        }

        pub(crate) fn request_downloaded_leaf_loudness_evidence(_request: LoudnessEvidenceRequest) {
        }

        pub(crate) fn request_downloaded_leaf_foreground_loudness_evidence(
            _request: LoudnessEvidenceRequest,
        ) {
        }
    }

    pub mod audio_tail_trim {
        use super::downloads::model::CollectionSourceKind;
        use std::path::PathBuf;

        #[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
        pub(crate) struct AudioTailTrimRequest {
            pub(crate) collection_url: String,
            pub(crate) source_kind: CollectionSourceKind,
            pub(crate) save_root: PathBuf,
            pub(crate) scope_group_url: Option<String>,
            pub(crate) focus_music: Option<super::playlists::model::Music>,
        }

        pub(crate) fn request_downloaded_leaf_audio_tail_trim(_request: AudioTailTrimRequest) {}

        pub(crate) fn request_downloaded_leaf_foreground_audio_tail_trim(
            _request: AudioTailTrimRequest,
        ) {
        }
    }

    pub mod player {
        pub mod event {
            #[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
            pub struct PlaybackDiagnosticTraceDetail {
                pub key: String,
                pub value: String,
            }

            #[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
            pub struct PlaybackDiagnosticTraceEvent {
                pub event: String,
                pub playlist_name: Option<String>,
                pub music_name: Option<String>,
                pub music_url: Option<String>,
                pub start_ms: Option<u32>,
                pub end_ms: Option<u32>,
                pub elapsed_ms: Option<u128>,
                pub candidate_count: Option<usize>,
                pub queue_count: Option<usize>,
                pub status: Option<String>,
                pub error: Option<String>,
                pub details: Option<Vec<PlaybackDiagnosticTraceDetail>>,
            }

            impl PlaybackDiagnosticTraceEvent {
                pub fn emit(&self, _app: &tauri::AppHandle) -> Result<(), String> {
                    Ok(())
                }
            }
        }
    }

    pub mod playlist_playback {
        pub mod service {
            use crate::domain::playlists::model::AudioStyleTrainingTrackInput;

            pub(crate) fn notify_music_library_inputs_changed(_reason: &'static str) {}

            pub(crate) fn notify_music_training_inputs_ready(
                _reason: &'static str,
                _inputs: Vec<AudioStyleTrainingTrackInput>,
            ) {
            }

            pub(crate) fn notify_playable_library_changed() {}
        }
    }
}

mod utils {
    pub mod binaries {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/utils/binaries.rs"
        ));
    }
}

use appdb::AutoFill;
use appdb::connection::{InitDbOptions, reinit_db_with_options, reset_db};
use domain::downloads::model::DownloadTaskStatus;
use domain::downloads::service::enqueue_collection_download_for_test;
use domain::downloads::yt_dlp::{
    CliYtDlpClient, DownloadProgress, DownloadedLeaf, LeafProbe, PlaylistRoot, RootProbe,
    RootShellProbe, YtDlpClient,
};
use domain::meta::model::MetaInfo;
use domain::meta::repo::save_meta_info;
use domain::playlists::model::{PlayList, PlayListWriteRequest, PlaylistCollectionRef};
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::runtime::Runtime;

/// This is a manual diagnostics entrypoint, not a Rust test. It intentionally
/// stays out of `tests/` so the default test harness keeps the appdb-style
/// domain boundary: temporary database + fake deps, with no Tauri host runtime.

#[derive(Debug)]
struct LeafLimitedYtDlpClient {
    inner: CliYtDlpClient,
    limit: usize,
    stats: Arc<ManualDownloadClientStats>,
}

#[derive(Debug, Default)]
struct ManualDownloadClientStats {
    root_shell_probes: AtomicUsize,
    root_probes: AtomicUsize,
    leaf_probes: AtomicUsize,
    audio_downloads: AtomicUsize,
}

#[derive(Debug, Clone, Copy)]
struct ManualDownloadClientStatsSnapshot {
    root_shell_probes: usize,
    root_probes: usize,
    leaf_probes: usize,
    audio_downloads: usize,
}

impl ManualDownloadClientStats {
    fn snapshot(&self) -> ManualDownloadClientStatsSnapshot {
        ManualDownloadClientStatsSnapshot {
            root_shell_probes: self.root_shell_probes.load(Ordering::Relaxed),
            root_probes: self.root_probes.load(Ordering::Relaxed),
            leaf_probes: self.leaf_probes.load(Ordering::Relaxed),
            audio_downloads: self.audio_downloads.load(Ordering::Relaxed),
        }
    }
}

impl ManualDownloadClientStatsSnapshot {
    fn delta_from(self, previous: Self) -> Self {
        Self {
            root_shell_probes: self.root_shell_probes - previous.root_shell_probes,
            root_probes: self.root_probes - previous.root_probes,
            leaf_probes: self.leaf_probes - previous.leaf_probes,
            audio_downloads: self.audio_downloads - previous.audio_downloads,
        }
    }
}

impl LeafLimitedYtDlpClient {
    fn new(inner: CliYtDlpClient, limit: usize, stats: Arc<ManualDownloadClientStats>) -> Self {
        Self {
            inner,
            limit: limit.max(1),
            stats,
        }
    }
}

impl YtDlpClient for LeafLimitedYtDlpClient {
    fn probe_root_shell(&self, url: &str) -> anyhow::Result<RootShellProbe> {
        self.stats.root_shell_probes.fetch_add(1, Ordering::Relaxed);
        self.inner.probe_root_shell(url)
    }

    fn probe_root(&self, url: &str) -> anyhow::Result<RootProbe> {
        self.stats.root_probes.fetch_add(1, Ordering::Relaxed);
        match self.inner.probe_root(url)? {
            RootProbe::Single(leaf) => Ok(RootProbe::Single(leaf)),
            RootProbe::List(root) => Ok(RootProbe::List(PlaylistRoot {
                entries: root.entries.into_iter().take(self.limit).collect(),
                expected_entry_count: root.expected_entry_count,
                ..root
            })),
        }
    }

    fn probe_leaf(&self, url: &str) -> anyhow::Result<LeafProbe> {
        self.stats.leaf_probes.fetch_add(1, Ordering::Relaxed);
        self.inner.probe_leaf(url)
    }

    fn download_leaf_audio(
        &self,
        url: &str,
        target_dir: &Path,
        file_stem: &str,
        cookies_path: Option<&Path>,
        on_progress: &mut dyn FnMut(DownloadProgress),
    ) -> anyhow::Result<DownloadedLeaf> {
        self.stats.audio_downloads.fetch_add(1, Ordering::Relaxed);
        self.inner
            .download_leaf_audio(url, target_dir, file_stem, cookies_path, on_progress)
    }
}

fn temp_test_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();

    std::env::temp_dir().join(format!("slisic_{prefix}_{}_{}", std::process::id(), nanos))
}

fn installed_bin_dir() -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").expect("LOCALAPPDATA should exist"))
        .join("slisic")
        .join("bin")
}

fn manual_download_urls() -> Vec<String> {
    std::env::var("SLISIC_MANUAL_DOWNLOAD_URLS")
        .ok()
        .map(|value| {
            value
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .filter(|urls: &Vec<String>| !urls.is_empty())
        .unwrap_or_else(|| vec!["https://www.youtube.com/watch?v=JKDPPIlk_HM".to_string()])
}

fn manual_download_leaf_limit() -> usize {
    std::env::var("SLISIC_MANUAL_DOWNLOAD_LEAF_LIMIT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(usize::MAX)
}

fn create_manual_download_client(
    ytdlp_path: PathBuf,
    bin_dir: PathBuf,
    leaf_limit: usize,
    stats: Arc<ManualDownloadClientStats>,
) -> Arc<dyn YtDlpClient> {
    Arc::new(LeafLimitedYtDlpClient::new(
        CliYtDlpClient::new(ytdlp_path, bin_dir),
        leaf_limit,
        stats,
    ))
}

async fn run_manual_download_pass(
    label: &str,
    urls: &[String],
    client: Arc<dyn YtDlpClient>,
    stats: &Arc<ManualDownloadClientStats>,
    ffmpeg_path: &Path,
    save_root: &Path,
    expect_no_audio_downloads: bool,
) -> Vec<domain::playlists::model::Collection> {
    let stats_before = stats.snapshot();
    let started = Instant::now();
    let mut downloaded_collections = Vec::new();
    println!(
        "manual_download_chain pass_started label={} urls={} save_root=\"{}\"",
        label,
        urls.len(),
        save_root.display()
    );

    for url in urls {
        let enqueued = enqueue_collection_download_for_test(
            url.to_string(),
            Arc::clone(&client),
            ffmpeg_path.to_path_buf(),
            save_root.to_path_buf(),
        )
        .await
        .unwrap_or_else(|error| {
            panic!("manual download chain enqueue should succeed for {url}: {error}")
        });
        let terminal_task = enqueued.task;
        let collection = domain::playlists::repo::get_collection_by_url(url)
            .await
            .unwrap_or_else(|error| {
                panic!("manual download chain collection lookup should succeed for {url}: {error}")
            })
            .unwrap_or_else(|| panic!("manual download chain collection should exist for {url}"));

        assert!(
            matches!(
                terminal_task.status,
                DownloadTaskStatus::Completed | DownloadTaskStatus::CompletedWithErrors
            ),
            "download task did not complete successfully for {url}: status={:?} last_error={:?} leafs={:#?} collection={:#?}",
            terminal_task.status,
            terminal_task.last_error,
            terminal_task.leafs,
            collection
        );
        assert!(
            !collection.musics.is_empty(),
            "download completed but collection stayed empty for {url}: task={:#?} collection={:#?}",
            terminal_task,
            collection
        );
        assert!(
            collection.musics.iter().all(|music| {
                music
                    .path
                    .as_ref()
                    .is_some_and(|path| save_root.join(&collection.folder).join(path).is_file())
            }),
            "collection musics were materialized but file paths are missing for {url}: collection={:#?}",
            collection
        );
        println!(
            "manual_download_chain collection label={} url={} title=\"{}\" musics={} task={} status={} residual_leaves={} completed_leaves={} failed_leaves={}",
            label,
            url,
            collection.name,
            collection.musics.len(),
            terminal_task.id,
            terminal_task.status.as_str(),
            terminal_task.leafs.len(),
            terminal_task.completed_leaves,
            terminal_task.failed_leaves
        );
        downloaded_collections.push(collection);
    }

    let delta = stats.snapshot().delta_from(stats_before);
    println!(
        "manual_download_chain pass_finished label={} elapsed_ms={} root_shell_probes={} root_probes={} leaf_probes={} audio_downloads={}",
        label,
        started.elapsed().as_millis(),
        delta.root_shell_probes,
        delta.root_probes,
        delta.leaf_probes,
        delta.audio_downloads
    );
    if expect_no_audio_downloads {
        assert_eq!(
            delta.audio_downloads, 0,
            "pass {label} should reuse existing files without invoking audio download"
        );
    }

    downloaded_collections
}

async fn assert_manual_download_playback_path(
    collection: &domain::playlists::model::Collection,
    save_root: &Path,
) {
    let playlist = PlayList {
        name: "Manual Download Chain".to_string(),
        collections: vec![domain::playlists::model::Collection {
            musics: vec![],
            ..collection.clone()
        }],
        groups: vec![],
        extra: vec![],

        created_at: AutoFill::pending(),
    };
    let playlist_request = PlayListWriteRequest {
        name: playlist.name.clone(),
        collections: playlist
            .collections
            .iter()
            .map(|collection| PlaylistCollectionRef {
                name: collection.name.clone(),
                url: collection.url.clone(),
                folder: collection.folder.clone(),
                last_updated: collection.last_updated.clone(),
                enable_updates: collection.enable_updates,
            })
            .collect(),
        groups: vec![],
        extra: vec![],
        created_at: playlist.created_at.clone(),
    };
    domain::playlists::repo::upsert_playlist_surface(&playlist_request, None)
        .await
        .expect("manual download chain playlist save should succeed");
    let persisted_collection = domain::playlists::repo::get_collection_by_url(&collection.url)
        .await
        .expect("manual download chain persisted collection lookup should succeed")
        .expect("manual download chain persisted collection should exist");
    let persisted_playlist = domain::playlists::repo::get_playlist_by_name(&playlist.name)
        .await
        .expect("manual download chain persisted playlist lookup should succeed")
        .expect("manual download chain persisted playlist should exist");

    assert!(
        !persisted_collection.musics.is_empty(),
        "playlist save clobbered collection musics after download: collection={:#?} playlist={:#?}",
        persisted_collection,
        persisted_playlist
    );
    assert_eq!(persisted_playlist.collections.len(), 1);
    assert_eq!(persisted_playlist.collections[0].url, collection.url);
    assert!(
        !persisted_playlist.collections[0].musics.is_empty(),
        "playlist should resolve canonical collection data after save: playlist={:#?}",
        persisted_playlist
    );

    let playback_selection =
        domain::playlists::repo::get_playlist_playback_selection_by_name(&persisted_playlist.name)
            .await
            .expect("manual download chain playback selection should load")
            .expect("manual download chain playback selection should exist");
    let playback_sources =
        domain::playlists::repo::load_playlist_playback_track_sources(&playback_selection, 16)
            .await
            .expect("manual download chain playback sources should load");
    assert_eq!(
        playback_selection.collections.len(),
        1,
        "playback resolution should keep the downloaded collection selected: playlist={:#?} selection={:#?}",
        persisted_playlist,
        playback_selection
    );
    assert!(
        !playback_sources.is_empty(),
        "playback path resolved no tracks after successful download/import: playlist={:#?} selection={:#?}",
        persisted_playlist,
        playback_selection
    );
    assert!(
        playback_sources.iter().all(|source| {
            source.music.path.as_deref().is_some_and(|path| {
                save_root
                    .join(&source.collection_folder)
                    .join(path)
                    .is_file()
            })
        }),
        "playback source path produced entries without readable files: sources={:#?}",
        playback_sources
    );
    println!(
        "manual_download_chain playback_sources_ready playlist=\"{}\" sources={}",
        persisted_playlist.name,
        playback_sources.len()
    );
}

fn main() {
    let _guard = domain::playlists::PLAYLIST_DB_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let runtime = Runtime::new().expect("runtime should be created");

    runtime.block_on(async {
        let urls = manual_download_urls();
        let leaf_limit = manual_download_leaf_limit();
        let db_root = temp_test_dir("manual_download_chain_db");
        let save_root = temp_test_dir("manual_download_chain_save");
        let bin_dir = installed_bin_dir();
        let ytdlp_path = bin_dir.join(if cfg!(windows) {
            "yt-dlp.exe"
        } else {
            "yt-dlp"
        });
        let ffmpeg_path = bin_dir.join(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        });

        reinit_db_with_options(
            db_root,
            InitDbOptions::default()
                .versioned(false)
                .changefeed_gc_interval(None),
        )
        .await
        .expect("manual download chain test db should initialize");

        std::fs::create_dir_all(&save_root).expect("manual download chain save root should exist");
        assert!(
            ytdlp_path.is_file(),
            "manual download chain requires yt-dlp at {}",
            ytdlp_path.display()
        );
        assert!(
            ffmpeg_path.is_file(),
            "manual download chain requires ffmpeg at {}",
            ffmpeg_path.display()
        );

        save_meta_info(MetaInfo {
            save_path: Some(save_root.to_string_lossy().to_string()),
        })
        .await
        .expect("manual download chain save path should persist");

        let stats = Arc::new(ManualDownloadClientStats::default());
        let client = create_manual_download_client(
            ytdlp_path.clone(),
            bin_dir.clone(),
            leaf_limit,
            Arc::clone(&stats),
        );
        let first_pass_collections = run_manual_download_pass(
            "first",
            &urls,
            Arc::clone(&client),
            &stats,
            &ffmpeg_path,
            &save_root,
            false,
        )
        .await;
        run_manual_download_pass(
            "same_db_repeat",
            &urls,
            Arc::clone(&client),
            &stats,
            &ffmpeg_path,
            &save_root,
            true,
        )
        .await;
        let collection = first_pass_collections
            .first()
            .expect("manual download chain should have at least one collection")
            .clone();
        assert_manual_download_playback_path(&collection, &save_root).await;

        let second_db_root = temp_test_dir("manual_download_chain_recreated_db");
        reinit_db_with_options(
            second_db_root,
            InitDbOptions::default()
                .versioned(false)
                .changefeed_gc_interval(None),
        )
        .await
        .expect("manual download chain recreated db should initialize");
        save_meta_info(MetaInfo {
            save_path: Some(save_root.to_string_lossy().to_string()),
        })
        .await
        .expect("manual download chain recreated db save path should persist");
        let recreated_client =
            create_manual_download_client(ytdlp_path, bin_dir, leaf_limit, Arc::clone(&stats));
        let recreated_collections = run_manual_download_pass(
            "recreated_db_existing_files",
            &urls,
            recreated_client,
            &stats,
            &ffmpeg_path,
            &save_root,
            true,
        )
        .await;
        let recreated_collection = recreated_collections
            .first()
            .expect("manual download chain recreated db should have at least one collection")
            .clone();
        assert_manual_download_playback_path(&recreated_collection, &save_root).await;

        let _ = std::fs::remove_dir_all(&save_root);
        reset_db();
    });
}
