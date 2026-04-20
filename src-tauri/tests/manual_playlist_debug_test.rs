mod domain {
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
    }

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
    }
}

use appdb::connection::reset_db;
use appdb::prelude::{InitDbOptions, init_db_with_options};
use domain::downloads::repo::list_tasks;
use domain::meta::repo::get_meta_info;
use domain::playlists::repo::{get_playlist_by_name, list_collections};
use std::path::{Path, PathBuf};
use tokio::runtime::Runtime;

fn local_db_path() -> PathBuf {
    if let Ok(path) = std::env::var("RANSIC_DEBUG_DB_PATH") {
        return PathBuf::from(path);
    }

    PathBuf::from(std::env::var("LOCALAPPDATA").expect("LOCALAPPDATA should exist"))
        .join("com.ransic.app")
        .join("surreal.db")
}

fn default_save_root() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").expect("USERPROFILE should exist"))
        .join("Documents")
        .join("ransic")
}

fn resolve_music_file_path(save_root: &Path, folder: &str, relative_path: Option<&str>) -> PathBuf {
    let path = PathBuf::from(relative_path.unwrap_or(""));
    if path.is_absolute() {
        return path;
    }

    save_root.join(folder).join(path)
}

#[test]
fn manual_debug_playlist_1() {
    let runtime = Runtime::new().expect("runtime should be created");

    runtime.block_on(async {
        let db_path = local_db_path();
        init_db_with_options(
            db_path.clone(),
            InitDbOptions::default()
                .versioned(false)
                .changefeed_gc_interval(None),
        )
        .await
        .expect("real app db should initialize");

        let playlist = get_playlist_by_name("PlayList 1")
            .await
            .expect("playlist lookup should succeed")
            .expect("playlist should exist");
        let library = list_collections()
            .await
            .expect("collection listing should succeed");
        let tasks = list_tasks().await.expect("task listing should succeed");
        let meta = get_meta_info().await.expect("meta lookup should succeed");
        let save_root = PathBuf::from(
            meta.and_then(|value| value.save_path)
                .unwrap_or_else(|| default_save_root().to_string_lossy().to_string()),
        );

        println!("db_path={}", db_path.display());
        println!("save_root={}", save_root.display());
        println!("playlist.name={}", playlist.name);
        println!("playlist.collections={}", playlist.collections.len());
        println!("playlist.groups={}", playlist.groups.len());
        println!("download.tasks={}", tasks.len());

        for collection in &playlist.collections {
            println!(
                "playlist.collection url={} name={} folder={} musics={}",
                collection.url,
                collection.name,
                collection.folder,
                collection.musics.len()
            );
        }

        for group in &playlist.groups {
            println!(
                "playlist.group url={} name={} folder={}",
                group.url, group.name, group.folder
            );
        }

        for task in &tasks {
            println!(
                "task id={} url={} status={:?} collection_url={:?} collection_name={:?} leafs={} completed={} failed={} last_error={:?}",
                task.id,
                task.url,
                task.status,
                task.collection_url,
                task.collection_name,
                task.leafs.len(),
                task.completed_leaves,
                task.failed_leaves,
                task.last_error
            );

            for leaf in &task.leafs {
                println!(
                    "task.leaf id={} url={} status={:?} title={:?} file_name={:?} relative_path={:?} last_error={:?}",
                    leaf.id,
                    leaf.url,
                    leaf.status,
                    leaf.title,
                    leaf.file_name,
                    leaf.relative_path,
                    leaf.last_error
                );
            }
        }

        for selected in &playlist.collections {
            match library
                .iter()
                .find(|candidate| candidate.url == selected.url)
            {
                Some(collection) => {
                    println!(
                        "library.collection url={} name={} folder={} musics={}",
                        collection.url,
                        collection.name,
                        collection.folder,
                        collection.musics.len()
                    );

                    for music in &collection.musics {
                        let file_path = resolve_music_file_path(
                            &save_root,
                            &collection.folder,
                            music.path.as_deref(),
                        );
                        println!(
                            "music name={} url={} path={:?} resolved={} exists={} group_url={}",
                            music.name,
                            music.url,
                            music.path,
                            file_path.display(),
                            file_path.is_file(),
                            music.group.url
                        );
                    }
                }
                None => {
                    println!("missing library collection for url={}", selected.url);
                }
            }
        }

        reset_db();
    });
}
