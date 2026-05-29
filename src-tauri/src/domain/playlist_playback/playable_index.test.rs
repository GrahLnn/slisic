use super::playable_index::{
    PlayableIndexRefreshReason, consume_playlist_source, discard_playlist_source,
    initialize_runtime_for_test, read_playlist_source, refresh_playlist_now_for_reason_for_test,
    refresh_playlist_now_for_test, reset_for_test,
};
use crate::domain::playlists::model::{
    CollectionGroupOwner, Group, Music, canonical_music_id_for_source,
};
use crate::domain::playlists::repo::{
    PlaylistPlaybackCollectionRef, PlaylistPlaybackSelection, PlaylistPlaybackTrackSource,
};
use std::sync::{LazyLock, Mutex, MutexGuard};

static PLAYABLE_INDEX_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn setup_playable_index_test() -> MutexGuard<'static, ()> {
    let guard = PLAYABLE_INDEX_TEST_LOCK
        .lock()
        .expect("playable index test lock should not be poisoned");
    reset_for_test();
    initialize_runtime_for_test();
    guard
}

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
    let _guard = setup_playable_index_test();
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
    let _guard = setup_playable_index_test();

    let sampled = read_playlist_source("Missing").expect("index read should succeed");

    assert!(sampled.is_none());
}

#[tokio::test]
async fn playable_index_consumes_only_the_matching_generation() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    let stale = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("first snapshot should exist");
    refresh_playlist_now_for_test(selection("Focus"), Some(source(4)))
        .await
        .expect("second test snapshot should commit");

    assert!(
        !consume_playlist_source(&stale).expect("stale snapshot consumption should be safe"),
        "stale snapshot consumption must not remove a newer prepared source"
    );
    let current = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("current snapshot should still exist");

    assert_eq!(
        current
            .source
            .expect("prepared source should exist")
            .music
            .url,
        "https://example.com/watch?v=4"
    );
}

#[tokio::test]
async fn playable_index_consumption_removes_only_one_playlist_source() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("focus snapshot should commit");
    refresh_playlist_now_for_test(selection("Sleep"), Some(source(7)))
        .await
        .expect("sleep snapshot should commit");
    let focus = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("focus snapshot should exist");

    assert!(consume_playlist_source(&focus).expect("current snapshot should be consumed"));

    assert!(
        read_playlist_source("Focus")
            .expect("index read should succeed")
            .is_none()
    );
    let sleep = read_playlist_source("Sleep")
        .expect("index read should succeed")
        .expect("sleep snapshot should remain");
    assert_eq!(
        sleep
            .source
            .expect("prepared source should exist")
            .music
            .url,
        "https://example.com/watch?v=7"
    );
}

#[tokio::test]
async fn playable_index_consumption_allows_replacement_to_commit() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    let consumed = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("first snapshot should exist");

    assert!(consume_playlist_source(&consumed).expect("current snapshot should be consumed"));
    refresh_playlist_now_for_test(selection("Focus"), Some(source(4)))
        .await
        .expect("replacement snapshot should commit");

    let replacement = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("replacement snapshot should exist");
    assert_eq!(
        replacement
            .source
            .expect("replacement source should exist")
            .music
            .url,
        "https://example.com/watch?v=4"
    );
}

#[tokio::test]
async fn playable_index_ready_refresh_does_not_replace_unconsumed_source() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");

    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::Ready,
    )
    .await
    .expect("ready refresh should be accepted");

    let current = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("prepared source should remain");
    assert_eq!(
        current
            .source
            .expect("prepared source should exist")
            .music
            .url,
        "https://example.com/watch?v=3"
    );
}

#[tokio::test]
async fn playable_index_ready_refresh_fills_empty_source_after_consumption() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    let consumed = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("first snapshot should exist");
    assert!(consume_playlist_source(&consumed).expect("current snapshot should be consumed"));

    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::Ready,
    )
    .await
    .expect("ready refresh should fill empty cache");

    let current = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("prepared source should exist");
    assert_eq!(
        current
            .source
            .expect("prepared source should exist")
            .music
            .url,
        "https://example.com/watch?v=4"
    );
}

#[tokio::test]
async fn playable_index_discard_allows_ready_refresh_to_replace_unplayable_source() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    let discarded = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("first snapshot should exist");

    assert!(discard_playlist_source(&discarded).expect("current snapshot should be discarded"));
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::Ready,
    )
    .await
    .expect("ready refresh should fill after discard");

    let current = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("replacement snapshot should exist");
    assert_eq!(
        current
            .source
            .expect("replacement source should exist")
            .music
            .url,
        "https://example.com/watch?v=4"
    );
}
