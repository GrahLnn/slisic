use super::playable_index::{
    PlayableIndexRefreshReason, PlaylistPlayableIndexSourceKind, cache_file_json_for_test,
    claim_global_refresh_for_test, claim_playlist_refresh_for_test,
    commit_global_snapshot_for_test, commit_playlist_snapshot_for_test, consume_playlist_source,
    discard_playlist_source, first_slot_loudness_request_order_for_test,
    initialize_runtime_for_test, mark_playlist_source_kind_for_test, notify_playlist_renamed,
    publish_first_slot_loudness_evidence, read_playlist_source,
    refresh_playlist_now_for_reason_for_test, refresh_playlist_now_for_test,
    request_global_refresh_while_active_for_test, reset_for_test, restore_cache_file_json_for_test,
    should_skip_global_refresh_for_test, should_skip_playlist_refresh_for_test,
};
use crate::domain::loudness_evidence::LoudnessEvidenceRequest;
use crate::domain::playlists::model::{
    CollectionGroupOwner, Group, LoudnessProfile, Music, canonical_music_id_for_source,
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
        occurrence_id: String::new(),
        name: format!("Track {index}"),
        alias: format!("Track {index}"),
        group: group(),
        canonical_music_id: canonical_music_id_for_source(&url, 0, 180_000),
        url,
        path: Some(format!("track-{index}.m4a")),
        start_ms: 0,
        end_ms: 180_000,
        liked: false,
        loudness_profile: None,
    }
}

fn source(index: usize) -> PlaylistPlaybackTrackSource {
    PlaylistPlaybackTrackSource {
        collection_folder: "youtube/index".to_string(),
        music: music(index),
    }
}

fn loudness_request_for_track(
    track: &crate::domain::player::model::PlaybackTrack,
) -> LoudnessEvidenceRequest {
    LoudnessEvidenceRequest {
        canonical_music_id: track.canonical_music_id.clone(),
        url: track.music_url.clone(),
        file_path: track.file_path.clone(),
        start_ms: track.start_ms,
        end_ms: track.end_ms,
    }
}

fn loudness_request_for_source(source: &PlaylistPlaybackTrackSource) -> LoudnessEvidenceRequest {
    LoudnessEvidenceRequest {
        canonical_music_id: source.music.canonical_music_id.clone(),
        url: source.music.url.clone(),
        file_path: source
            .music
            .path
            .as_ref()
            .expect("test source should have a relative music path")
            .clone()
            .into(),
        start_ms: source.music.start_ms,
        end_ms: source.music.end_ms,
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
    let track = sampled
        .track
        .as_ref()
        .expect("prepared playback track should exist");
    assert_eq!(track.music_url, "https://example.com/watch?v=3");
    assert_eq!(track.music_name, "Track 3");
    assert_eq!(track.start_ms, 0);
    assert_eq!(track.end_ms, 180_000);
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
async fn playable_index_loudness_evidence_updates_prepared_first_slot_cargo_without_consuming_it() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("test snapshot should commit");
    let before = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("prepared source should exist");
    let request = loudness_request_for_track(
        before
            .track
            .as_ref()
            .expect("prepared playback track should exist"),
    );

    publish_first_slot_loudness_evidence(
        &request,
        LoudnessProfile::from_integrated_lufs(-14.25).expect("test LUFS should be valid"),
    )
    .expect("first-slot evidence should publish");

    let updated = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("prepared source should still exist");
    let updated_track = updated
        .track
        .as_ref()
        .expect("prepared playback track should exist");
    assert_eq!(
        updated_track
            .loudness_profile
            .expect("updated track should carry loudness profile")
            .integrated_lufs,
        -14.25
    );
    assert_eq!(
        updated
            .source
            .as_ref()
            .expect("prepared source should exist")
            .music
            .loudness_profile
            .expect("source should carry loudness profile")
            .integrated_lufs,
        -14.25
    );
    assert_eq!(
        updated_track
            .source_music
            .as_ref()
            .expect("source music should stay attached")
            .loudness_profile
            .expect("source music should carry loudness profile")
            .integrated_lufs,
        -14.25
    );
    assert!(
        consume_playlist_source(&updated).expect("updated first-slot credential should consume"),
        "loudness evidence must not consume the linear first-slot credential"
    );
}

#[tokio::test]
async fn playable_index_loudness_evidence_updates_only_matching_first_slot_identity() {
    let _guard = setup_playable_index_test();
    let first_source = source(3);
    let second_source = source(4);
    refresh_playlist_now_for_test(selection("Focus"), Some(first_source.clone()))
        .await
        .expect("first snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(second_source.clone()),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("second snapshot should commit");

    publish_first_slot_loudness_evidence(
        &loudness_request_for_source(&second_source),
        LoudnessProfile::from_integrated_lufs(-20.5).expect("test LUFS should be valid"),
    )
    .expect("second source evidence should publish");

    let first = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("first source should exist");
    assert_eq!(
        first
            .track
            .as_ref()
            .expect("first track should exist")
            .loudness_profile,
        None
    );
    assert!(consume_playlist_source(&first).expect("first source should consume"));
    let second = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("second source should exist");
    assert_eq!(
        second
            .track
            .as_ref()
            .expect("second track should exist")
            .loudness_profile
            .expect("second track should carry loudness profile")
            .integrated_lufs,
        -20.5
    );

    let mut wrong_range = loudness_request_for_source(&second_source);
    wrong_range.end_ms += 1;
    publish_first_slot_loudness_evidence(
        &wrong_range,
        LoudnessProfile::from_integrated_lufs(-8.0).expect("test LUFS should be valid"),
    )
    .expect("nonmatching evidence should be ignored");
    let unchanged_second = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("second source should still exist");
    assert_eq!(
        unchanged_second
            .track
            .as_ref()
            .expect("second track should exist")
            .loudness_profile
            .expect("second track should keep loudness profile")
            .integrated_lufs,
        -20.5
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
async fn playable_index_consumption_removes_only_one_playlist_source_credential() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("focus snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("focus spare snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(5)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("focus second spare snapshot should commit");
    refresh_playlist_now_for_test(selection("Sleep"), Some(source(7)))
        .await
        .expect("sleep snapshot should commit");
    let focus = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("focus snapshot should exist");

    assert!(consume_playlist_source(&focus).expect("current snapshot should be consumed"));

    let focus_spare = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("focus spare snapshot should remain");
    assert_eq!(
        focus_spare
            .source
            .expect("prepared source should exist")
            .music
            .url,
        "https://example.com/watch?v=4"
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
async fn playable_index_rename_moves_prepared_sources_to_next_playlist_key() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("spare test snapshot should commit");

    notify_playlist_renamed("Focus", "Focus Renamed");

    assert!(
        read_playlist_source("Focus")
            .expect("old playlist index read should succeed")
            .is_none(),
        "rename must remove the old first-slot key"
    );
    let renamed = read_playlist_source("Focus Renamed")
        .expect("renamed playlist index read should succeed")
        .expect("renamed playlist should keep prepared first source");
    let renamed_track = renamed
        .track
        .as_ref()
        .expect("renamed prepared track should exist");
    assert_eq!(renamed.playlist_name, "Focus Renamed");
    assert_eq!(renamed_track.playlist_name, "Focus Renamed");
    assert_eq!(renamed_track.music_url, "https://example.com/watch?v=3");
    assert!(consume_playlist_source(&renamed).expect("renamed source should be consumable"));

    let spare = read_playlist_source("Focus Renamed")
        .expect("renamed playlist index read should succeed")
        .expect("renamed spare source should remain");
    assert_eq!(
        spare
            .track
            .as_ref()
            .expect("renamed spare track should exist")
            .playlist_name,
        "Focus Renamed"
    );
    assert_eq!(
        spare
            .source
            .expect("renamed spare source should exist")
            .music
            .url,
        "https://example.com/watch?v=4"
    );
}

#[tokio::test]
async fn playable_index_consumption_allows_replacement_to_commit() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("second test snapshot should commit");
    let consumed = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("first snapshot should exist");

    assert!(consume_playlist_source(&consumed).expect("current snapshot should be consumed"));
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(5)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
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
async fn playable_index_consumes_spare_source_during_active_refill_window() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("second test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(5)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("third test snapshot should commit");
    let first = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("first snapshot should exist");

    assert!(consume_playlist_source(&first).expect("first source should be consumed"));
    let second = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("spare snapshot should be available");
    assert_eq!(
        second
            .source
            .as_ref()
            .expect("spare source should exist")
            .music
            .url,
        "https://example.com/watch?v=4"
    );
    assert!(consume_playlist_source(&second).expect("spare source should be consumed"));
    let third = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("second spare snapshot should remain");
    assert_eq!(
        third
            .source
            .as_ref()
            .expect("second spare source should exist")
            .music
            .url,
        "https://example.com/watch?v=5"
    );
}

#[tokio::test]
async fn playable_index_discard_exposes_spare_source_during_active_refill_window() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("second test snapshot should commit");
    let first = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("first snapshot should exist");

    assert!(discard_playlist_source(&first).expect("first source should be discarded"));
    let second = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("spare snapshot should be available");

    assert_eq!(
        second
            .source
            .as_ref()
            .expect("spare source should exist")
            .music
            .url,
        "https://example.com/watch?v=4"
    );
}

#[tokio::test]
async fn playable_index_slot_vacancy_fill_does_not_replace_unconsumed_source() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");

    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("slot-vacancy fill should be accepted");

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
async fn playable_index_model_available_refresh_can_replace_random_fallback_source() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(3)),
        PlayableIndexRefreshReason::Startup,
    )
    .await
    .expect("cold start fallback snapshot should commit");
    mark_playlist_source_kind_for_test("Focus", PlaylistPlayableIndexSourceKind::RandomFallback)
        .expect("source kind should be updated");

    assert!(
        !should_skip_playlist_refresh_for_test(
            "Focus",
            PlayableIndexRefreshReason::AudioStyleModelAvailable
        )
        .expect("skip check should succeed")
    );
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::AudioStyleModelAvailable,
    )
    .await
    .expect("model-available refresh should be accepted");

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
    assert_eq!(
        current.source_kind,
        Some(PlaylistPlayableIndexSourceKind::AudioStyle)
    );
}

#[tokio::test]
async fn playable_index_model_available_refresh_replaces_only_random_fallback_sources() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("audio-style snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("second audio-style snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(5)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("third audio-style snapshot should commit");
    mark_playlist_source_kind_for_test("Focus", PlaylistPlayableIndexSourceKind::RandomFallback)
        .expect("source kind should be updated");
    let first = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("first snapshot should exist");
    assert!(consume_playlist_source(&first).expect("random fallback source should be consumed"));
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(6)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("audio-style spare should commit");

    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(7)),
        PlayableIndexRefreshReason::AudioStyleModelAvailable,
    )
    .await
    .expect("model-available refresh should fill random fallback slot");

    let current = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("audio-style source should remain first");
    assert_eq!(
        current
            .source
            .as_ref()
            .expect("prepared source should exist")
            .music
            .url,
        "https://example.com/watch?v=6"
    );
    assert_eq!(
        current.source_kind,
        Some(PlaylistPlayableIndexSourceKind::AudioStyle)
    );
    assert!(consume_playlist_source(&current).expect("audio-style source should be consumed"));
    let replacement = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("model replacement should exist");
    assert_eq!(
        replacement
            .source
            .expect("replacement source should exist")
            .music
            .url,
        "https://example.com/watch?v=7"
    );
}

#[tokio::test]
async fn playable_index_model_available_refresh_keeps_unconsumed_audio_style_source() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("audio-style snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("second audio-style snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(5)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("third audio-style snapshot should commit");

    assert!(
        should_skip_playlist_refresh_for_test(
            "Focus",
            PlayableIndexRefreshReason::AudioStyleModelAvailable
        )
        .expect("skip check should succeed")
    );
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(5)),
        PlayableIndexRefreshReason::AudioStyleModelAvailable,
    )
    .await
    .expect("model-available refresh should be accepted");

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
async fn playable_index_slot_vacancy_fill_skips_when_prepared_pool_is_full() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("second test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(5)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("third test snapshot should commit");

    assert!(
        should_skip_global_refresh_for_test(PlayableIndexRefreshReason::SlotVacancy)
            .expect("skip check should succeed")
    );
    assert!(
        should_skip_playlist_refresh_for_test("Focus", PlayableIndexRefreshReason::SlotVacancy)
            .expect("skip check should succeed")
    );
}

#[tokio::test]
async fn playable_index_slot_vacancy_fill_does_not_skip_missing_prepared_source() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), None)
        .await
        .expect("empty test snapshot should commit");

    assert!(
        !should_skip_global_refresh_for_test(PlayableIndexRefreshReason::SlotVacancy)
            .expect("skip check should succeed")
    );
    assert!(
        !should_skip_playlist_refresh_for_test("Focus", PlayableIndexRefreshReason::SlotVacancy)
            .expect("skip check should succeed")
    );
}

#[tokio::test]
async fn playable_index_cache_round_trip_restores_three_first_slot_credentials() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("second test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(5)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("third test snapshot should commit");
    let payload = cache_file_json_for_test().expect("cache payload should encode");

    reset_for_test();
    initialize_runtime_for_test();
    restore_cache_file_json_for_test(&payload).expect("cache payload should restore");

    let first = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("first restored source should exist");
    assert_eq!(
        first
            .source
            .as_ref()
            .expect("first restored source should exist")
            .music
            .url,
        "https://example.com/watch?v=3"
    );
    assert!(consume_playlist_source(&first).expect("first restored source should be consumed"));
    let second = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("second restored source should exist");
    assert_eq!(
        second
            .source
            .as_ref()
            .expect("second restored source should exist")
            .music
            .url,
        "https://example.com/watch?v=4"
    );
    assert!(consume_playlist_source(&second).expect("second restored source should be consumed"));
    let third = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("third restored source should exist");
    assert_eq!(
        third
            .source
            .as_ref()
            .expect("third restored source should exist")
            .music
            .url,
        "https://example.com/watch?v=5"
    );
}

#[tokio::test]
async fn playable_index_cache_restore_preserves_source_kind_without_serializing_linear_identity() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    mark_playlist_source_kind_for_test("Focus", PlaylistPlayableIndexSourceKind::RandomFallback)
        .expect("source kind should be updated");
    let payload = cache_file_json_for_test().expect("cache payload should encode");
    assert!(
        !payload.contains("credential_id"),
        "cache must not serialize linear credential id"
    );
    assert!(
        !payload.contains("generation"),
        "cache must not serialize process-lifetime generation"
    );

    reset_for_test();
    initialize_runtime_for_test();
    restore_cache_file_json_for_test(&payload).expect("cache payload should restore");

    let restored = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("restored source should exist");
    assert_eq!(
        restored.source_kind,
        Some(PlaylistPlayableIndexSourceKind::RandomFallback)
    );
    assert!(
        consume_playlist_source(&restored).expect("restored credential should be consumable"),
        "restored credential should receive a process-local linear identity"
    );
}

#[tokio::test]
async fn playable_index_unavailable_model_does_not_commit_empty_global_snapshot() {
    let _guard = setup_playable_index_test();
    let generation = claim_global_refresh_for_test(PlayableIndexRefreshReason::Startup)
        .expect("startup refresh should claim generation");

    assert!(
        commit_global_snapshot_for_test(
            "Focus".to_string(),
            generation,
            None,
            PlayableIndexRefreshReason::Startup,
        )
        .expect("global snapshot commit should be checked"),
        "the active generation is still current even when no source was prepared",
    );
    assert!(
        read_playlist_source("Focus")
            .expect("index read should succeed")
            .is_none(),
        "model-unavailable preparation must leave the first-slot pool empty"
    );
}

#[tokio::test]
async fn playable_index_unavailable_model_does_not_commit_empty_playlist_snapshot() {
    let _guard = setup_playable_index_test();
    let generation = claim_playlist_refresh_for_test("Focus", PlayableIndexRefreshReason::Startup)
        .expect("playlist refresh should claim generation");

    assert!(
        commit_playlist_snapshot_for_test(
            "Focus".to_string(),
            generation,
            None,
            PlayableIndexRefreshReason::Startup,
        )
        .expect("playlist snapshot commit should be checked"),
        "the active generation is still current even when no source was prepared",
    );
    assert!(
        read_playlist_source("Focus")
            .expect("index read should succeed")
            .is_none(),
        "model-unavailable preparation must leave the first-slot pool empty"
    );
}

#[tokio::test]
async fn playable_index_invalidating_global_claim_preserves_current_source_until_commit() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");

    let generation = claim_global_refresh_for_test(PlayableIndexRefreshReason::LibraryChanged)
        .expect("library refresh should claim generation");

    let current = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("prepared source must remain while refresh is active");
    assert_eq!(
        current
            .source
            .expect("prepared source should exist")
            .music
            .url,
        "https://example.com/watch?v=3"
    );

    assert!(
        commit_global_snapshot_for_test(
            "Focus".to_string(),
            generation,
            Some(source(4)),
            PlayableIndexRefreshReason::LibraryChanged,
        )
        .expect("global snapshot commit should be checked"),
        "invalidating global refresh should still commit its replacement",
    );
    let replacement = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("replacement source should exist");
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
async fn playable_index_invalidating_playlist_claim_preserves_current_source_until_commit() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");

    let generation =
        claim_playlist_refresh_for_test("Focus", PlayableIndexRefreshReason::PlaylistChanged)
            .expect("playlist refresh should claim generation");

    let current = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("prepared source must remain while refresh is active");
    assert_eq!(
        current
            .source
            .expect("prepared source should exist")
            .music
            .url,
        "https://example.com/watch?v=3"
    );

    assert!(
        commit_playlist_snapshot_for_test(
            "Focus".to_string(),
            generation,
            Some(source(4)),
            PlayableIndexRefreshReason::PlaylistChanged,
        )
        .expect("playlist snapshot commit should be checked"),
        "invalidating playlist refresh should still commit its replacement",
    );
    let replacement = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("replacement source should exist");
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
async fn playable_index_slot_vacancy_fill_does_not_supersede_active_global_fill() {
    let _guard = setup_playable_index_test();
    let generation = claim_global_refresh_for_test(PlayableIndexRefreshReason::Startup)
        .expect("startup refresh should claim generation");

    let skipped_generation =
        request_global_refresh_while_active_for_test(PlayableIndexRefreshReason::SlotVacancy)
            .expect("slot-vacancy fill should be coalesced");

    assert_eq!(
        skipped_generation, generation,
        "slot-vacancy fill must not age out an active first-slot fill"
    );
    assert!(
        commit_global_snapshot_for_test(
            "Focus".to_string(),
            generation,
            Some(source(4)),
            PlayableIndexRefreshReason::Startup,
        )
        .expect("global snapshot commit should be checked"),
        "active global fill should still commit after a coalesced slot-vacancy fill",
    );
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
async fn playable_index_slot_vacancy_fill_refills_after_consumption() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("second test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(5)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("third test snapshot should commit");
    let consumed = read_playlist_source("Focus")
        .expect("index read should succeed")
        .expect("first snapshot should exist");
    assert!(consume_playlist_source(&consumed).expect("current snapshot should be consumed"));

    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(6)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("slot-vacancy fill should refill one missing slot");

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
async fn playable_index_first_slot_loudness_requests_follow_consumption_order() {
    let _guard = setup_playable_index_test();
    refresh_playlist_now_for_test(selection("Focus"), Some(source(3)))
        .await
        .expect("first test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(4)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("second test snapshot should commit");
    refresh_playlist_now_for_reason_for_test(
        selection("Focus"),
        Some(source(5)),
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("third test snapshot should commit");

    assert_eq!(
        first_slot_loudness_request_order_for_test("Focus")
            .expect("first-slot request order should be readable"),
        vec![
            "https://example.com/watch?v=3".to_string(),
            "https://example.com/watch?v=4".to_string(),
            "https://example.com/watch?v=5".to_string(),
        ],
        "the first credential consumed by ready->play must be the first one queued for loudness"
    );
}

#[tokio::test]
async fn playable_index_discard_allows_slot_vacancy_fill_to_replace_unplayable_source() {
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
        PlayableIndexRefreshReason::SlotVacancy,
    )
    .await
    .expect("slot-vacancy fill should fill after discard");

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
