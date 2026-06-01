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

        pub mod track_identity_substitution {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/player/track_identity_substitution.rs"
            ));
        }

        mod track_identity_substitution_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/player/track_identity_substitution.test.rs"
            ));
        }

        pub mod service {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/player/service.rs"
            ));
        }

        mod service_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/player/service.test.rs"
            ));
        }

        mod strategy_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/player/strategy.test.rs"
            ));
        }
    }

    pub mod playlist_playback {
        pub mod recommendation {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/playlist_playback/recommendation.rs"
            ));
        }

        pub mod playable_index {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/playlist_playback/playable_index.rs"
            ));
        }

        pub mod service {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/playlist_playback/service.rs"
            ));
        }

        mod recommendation_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/playlist_playback/recommendation.test.rs"
            ));
        }

        mod service_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/playlist_playback/service.test.rs"
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

    mod collection_import {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/domain/collection_import.rs"
        ));

        mod collection_import_test {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/domain/collection_import.test.rs"
            ));
        }
    }
}
