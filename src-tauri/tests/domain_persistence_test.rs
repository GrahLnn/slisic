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

        mod model_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/playlists/model.test.rs"
            ));
        }

        mod repo_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/playlists/repo.test.rs"
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

        mod repo_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/meta/repo.test.rs"
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

        pub mod yt_dlp {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/yt_dlp.rs"
            ));
        }

        mod model_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/model.test.rs"
            ));
        }

        mod repo_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/repo.test.rs"
            ));
        }

        mod yt_dlp_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/downloads/yt_dlp.test.rs"
            ));
        }
    }
}
