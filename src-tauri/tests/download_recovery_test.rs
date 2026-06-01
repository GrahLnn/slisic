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

        pub mod planning {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/planning.rs"
            ));
        }

        pub mod service {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/service.rs"
            ));
        }

        mod service_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/service.test.rs"
            ));
        }
    }

    pub mod collection_import {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/domain/collection_import.rs"
        ));
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

use appdb::connection::{InitDbOptions, get_db, reinit_db_with_options, reset_db};
use appdb::model::meta::ModelMeta;
use domain::collection_import::repair_stale_single_source_collections;
use domain::downloads::model::{
    CollectionSourceKind, DownloadLeaf, DownloadLeafStatus, DownloadTask, DownloadTrigger,
};
use domain::downloads::repo::save_task;
use domain::playlists::model::Collection;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::runtime::Runtime;

fn temp_test_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();

    std::env::temp_dir().join(format!("slisic_{prefix}_{}_{}", std::process::id(), nanos))
}

async fn bootstrap_table(table: &str) {
    let db = get_db().expect("global download recovery database handle should exist");

    db.query(format!("DEFINE TABLE IF NOT EXISTS {table} SCHEMALESS;"))
        .await
        .expect("table bootstrap query should succeed")
        .check()
        .expect("table bootstrap response should succeed");
}

async fn bootstrap_relation_table(table: &str) {
    let db = get_db().expect("global download recovery database handle should exist");

    db.query(format!(
        "DEFINE TABLE IF NOT EXISTS {table} TYPE RELATION SCHEMALESS;"
    ))
    .await
    .expect("relation table bootstrap query should succeed")
    .check()
    .expect("relation table bootstrap response should succeed");
}

#[test]
fn repair_stale_single_source_collections_restores_playable_music_from_completed_leafs() {
    let _guard = domain::playlists::PLAYLIST_DB_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let runtime = Runtime::new().expect("runtime should be created");

    runtime.block_on(async {
        let db_root = temp_test_dir("download_recovery_db");
        reinit_db_with_options(
            db_root,
            InitDbOptions::default()
                .versioned(false)
                .changefeed_gc_interval(None),
        )
        .await
        .expect("download recovery test db should initialize");
        bootstrap_table(domain::playlists::model::Music::table_name()).await;
        bootstrap_relation_table("includes").await;

        let save_root = temp_test_dir("download_recovery_save");
        let collection = Collection {
            name: "Recovered Single".to_string(),
            url: "https://www.youtube.com/watch?v=recovered-single".to_string(),
            folder: "youtube/recovered-single".to_string(),
            musics: vec![],
            last_updated: "2026-04-12T00:00:00+00:00".to_string(),
            enable_updates: None,
        };
        let absolute_path = save_root
            .join(&collection.folder)
            .join("Recovered Single.m4a");
        std::fs::create_dir_all(
            absolute_path
                .parent()
                .expect("recovered single file should have a parent directory"),
        )
        .expect("save root should be created for repair test");
        std::fs::write(&absolute_path, b"ok")
            .expect("downloaded audio file should exist for repair test");

        domain::playlists::repo::upsert_collection(&collection)
            .await
            .expect("empty single collection shell should persist");

        let mut task = DownloadTask::new(
            "task-repair-single",
            collection.url.clone(),
            DownloadTrigger::Manual,
        );
        task.collection_url = Some(collection.url.clone());
        task.collection_name = Some(collection.name.clone());
        task.collection_folder = Some(collection.folder.clone());
        task.source_kind = Some(CollectionSourceKind::Single);

        let mut leaf = DownloadLeaf::new("leaf-repair-single", collection.url.clone(), 0);
        leaf.title = Some("Recovered Single".to_string());
        leaf.file_name = Some("Recovered Single.m4a".to_string());
        leaf.relative_path = Some("Recovered Single.m4a".to_string());
        leaf.duration_seconds = Some(245);
        leaf.chapter_count = Some(0);
        leaf.status = DownloadLeafStatus::Interrupted;
        task.replace_leaf(leaf);

        save_task(task)
            .await
            .expect("single download task should persist for recovery");

        let repaired = repair_stale_single_source_collections(&save_root)
            .await
            .expect("stale single-source collections should repair");
        let restored = domain::playlists::repo::get_collection_by_url(&collection.url)
            .await
            .expect("reloaded collection lookup should succeed")
            .expect("repaired collection should exist");

        assert_eq!(repaired, 1);
        assert_eq!(restored.musics.len(), 1);
        assert_eq!(restored.musics[0].name, "Recovered Single");
        assert_eq!(restored.musics[0].alias, "Recovered Single");
        assert_eq!(restored.musics[0].url, collection.url);
        assert_eq!(
            restored.musics[0].path.as_deref(),
            Some("Recovered Single.m4a")
        );
        assert_eq!(restored.musics[0].group.name, collection.name);
        assert_eq!(restored.musics[0].group.url, collection.url);
        assert_eq!(restored.musics[0].group.folder, collection.folder);
        assert_eq!(restored.musics[0].start_ms, 0);
        assert_eq!(restored.musics[0].end_ms, 245_000);

        let _ = std::fs::remove_dir_all(&save_root);
        reset_db();
    });
}
