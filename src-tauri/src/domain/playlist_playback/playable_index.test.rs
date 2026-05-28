use super::playable_index::{
    initialize_runtime_for_test, read_playlist_source, refresh_playlist_now_for_test,
    reset_for_test,
};
use crate::domain::playlists::model::{
    CollectionGroupOwner, Group, Music, canonical_music_id_for_source,
};
use crate::domain::playlists::repo::{
    PlaylistPlaybackCollectionRef, PlaylistPlaybackSelection, PlaylistPlaybackTrackSource,
};

fn group() -> Group {
    Group {
        name: "Index Group".to_string(),
        url: "https://example.com/group".to_string(),
        collection: CollectionGroupOwner {
            name: "Index Collection".to_string(),
            url: "https://example.com/collection".to_string(),
            folder: "youtube/index".to_string(),
            last_updated: "2026-05-28T00:00:00+08:00".to_string(),
            enable_updates: Some(false),
        },
        folder: "group".to_string(),
    }
}

fn music(index: usize) -> Music {
    let url = format!("https://example.com/watch?v={index}");
    Music {
        name: format!("Track {index}"),
        alias: format!("Track {index}"),
        group: group(),
        canonical_music_id: canonical_music_id_for_source(&url, 0, 180_000),
        url,
        path: Some(format!("track-{index}.m4a")),
        start_ms: 0,
        end_ms: 180_000,
        liked: false,
    }
}

fn source(index: usize) -> PlaylistPlaybackTrackSource {
    PlaylistPlaybackTrackSource {
        collection_folder: "youtube/index".to_string(),
        music: music(index),
    }
}

fn selection(name: &str) -> PlaylistPlaybackSelection {
    PlaylistPlaybackSelection {
        playlist_name: name.to_string(),
        collections: vec![PlaylistPlaybackCollectionRef::new_for_test(
            "Index Collection",
            "https://example.com/collection",
            "youtube/index",
        )],
        groups: vec![],
        extra: vec![],
        download_scopes: vec!["https://example.com/collection".to_string()],
    }
}

#[tokio::test]
async fn playable_index_reads_prepared_playlist_source_without_rebuilding() {
    reset_for_test();
    initialize_runtime_for_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("test snapshot should commit");

    let sampled = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("index snapshot should exist");

    assert_eq!(sampled.playlist_name, "Focus");
    assert_eq!(
        sampled
            .source
            .expect("prepared source should exist")
            .music
            .url,
        "https://example.com/watch?v=3"
    );
}

#[tokio::test]
async fn playable_index_miss_is_explicit_for_unprepared_playlist() {
    reset_for_test();
    initialize_runtime_for_test();

    let sampled = read_playlist_source("Missing").expect("index read should succeed");

    assert!(sampled.is_none());
}
