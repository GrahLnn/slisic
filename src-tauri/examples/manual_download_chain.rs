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

    pub mod player {
        pub mod model {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/player/model.rs"
            ));
        }

        pub mod strategy {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/player/strategy.rs"
            ));
        }

        pub mod event {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/player/event.rs"
            ));
        }

        pub mod waveform {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/player/waveform.rs"
            ));
        }

        pub mod service {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/player/service.rs"
            ));
        }
    }

    pub mod playlist_playback {
        pub mod model {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/playlist_playback/model.rs"
            ));
        }

        pub mod recommendation {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/playlist_playback/recommendation.rs"
            ));
        }

        pub mod service {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/playlist_playback/service.rs"
            ));
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
use domain::downloads::yt_dlp::CliYtDlpClient;
use domain::meta::model::MetaInfo;
use domain::meta::repo::save_meta_info;
use domain::playlist_playback::service::resolve_playlist_playback_source_resolution;
use domain::playlists::model::{PlayList, PlayListWriteRequest, PlaylistCollectionRef};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::runtime::Runtime;

/// This is a manual diagnostics entrypoint, not a Rust test. It intentionally
/// stays out of `tests/` so the default test harness keeps the appdb-style
/// domain boundary: temporary database + fake deps, with no Tauri host runtime.

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

fn main() {
    let _guard = domain::playlists::PLAYLIST_DB_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let runtime = Runtime::new().expect("runtime should be created");

    runtime.block_on(async {
        let url = "https://www.youtube.com/watch?v=JKDPPIlk_HM";
        let db_root = temp_test_dir("manual_download_chain_db");
        let save_root = temp_test_dir("manual_download_chain_save");
        let bin_dir = installed_bin_dir();
        let ytdlp_path = bin_dir.join(if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" });

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

        save_meta_info(MetaInfo {
            save_path: Some(save_root.to_string_lossy().to_string()),
        })
        .await
        .expect("manual download chain save path should persist");

        let enqueued = enqueue_collection_download_for_test(
            url.to_string(),
            Arc::new(CliYtDlpClient::new(ytdlp_path, bin_dir)),
            save_root.clone(),
        )
        .await
        .expect("manual download chain enqueue should succeed");
        let terminal_task = enqueued.task;
        let collection = domain::playlists::repo::get_collection_by_url(url)
            .await
            .expect("manual download chain collection lookup should succeed")
            .expect("manual download chain collection should exist");

        assert!(
            matches!(
                terminal_task.status,
                DownloadTaskStatus::Completed | DownloadTaskStatus::CompletedWithErrors
            ),
            "download task did not complete successfully: status={:?} last_error={:?} leafs={:#?} collection={:#?}",
            terminal_task.status,
            terminal_task.last_error,
            terminal_task.leafs,
            collection
        );
        assert!(
            !collection.musics.is_empty(),
            "download completed but collection stayed empty: task={:#?} collection={:#?}",
            terminal_task,
            collection
        );
        assert!(
            collection.musics.iter().all(|music| {
                music.path.as_ref().is_some_and(|path| {
                    save_root.join(&collection.folder).join(path).is_file()
                })
            }),
            "collection musics were materialized but file paths are missing: collection={:#?}",
            collection
        );

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
        let persisted_collection = domain::playlists::repo::get_collection_by_url(url)
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
        let playback_resolution = resolve_playlist_playback_source_resolution(
            &playback_selection,
            playback_sources,
            &save_root,
        );
        let playback_tracks = playback_resolution.tracks;

        assert_eq!(
            playback_selection.collections.len(),
            1,
            "playback resolution should keep the downloaded collection selected: playlist={:#?} selection={:#?}",
            persisted_playlist,
            playback_selection
        );
        assert!(
            !playback_tracks.is_empty(),
            "playback path resolved no tracks after successful download/import: playlist={:#?} selection={:#?}",
            persisted_playlist,
            playback_selection
        );
        assert!(
            playback_tracks.iter().all(|track| track.file_path.is_file()),
            "playback path produced track entries without readable files: tracks={:#?}",
            playback_tracks
        );

        let _ = std::fs::remove_dir_all(&save_root);
        reset_db();
    });
}
