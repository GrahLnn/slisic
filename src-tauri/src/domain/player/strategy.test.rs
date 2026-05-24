use super::model::PlaybackContinuationMode;
use super::model::PlaybackTrack;
use super::strategy::{
    PlaybackQueueMode, PlaybackStrategy, PlaybackStrategySet, RandomPlaybackStrategy,
};
use std::path::PathBuf;

fn track(name: &str) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: name.to_string(),
        canonical_music_id: format!("source:https://example.com/{name}:0:60000"),
        music_url: format!("https://example.com/{name}"),
        file_path: PathBuf::from(format!("{name}.m4a")),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
    }
}

#[test]
fn random_strategy_returns_none_for_empty_track_lists() {
    let mut strategy = RandomPlaybackStrategy::new();

    assert!(strategy.next_track(&[]).is_none());
}

#[test]
fn random_strategy_visits_each_track_once_before_repeating() {
    let mut strategy = RandomPlaybackStrategy::new();
    let tracks = vec![track("a"), track("b"), track("c")];

    let first = strategy
        .next_track(&tracks)
        .expect("first track should exist")
        .music_url
        .clone();
    let second = strategy
        .next_track(&tracks)
        .expect("second track should exist")
        .music_url
        .clone();
    let third = strategy
        .next_track(&tracks)
        .expect("third track should exist")
        .music_url
        .clone();

    let visited = std::collections::HashSet::from([first, second, third]);
    assert_eq!(visited.len(), 3);
}

#[test]
fn random_strategy_refills_after_consuming_a_full_round() {
    let mut strategy = RandomPlaybackStrategy::new();
    let tracks = vec![track("a"), track("b")];

    let _ = strategy
        .next_track(&tracks)
        .expect("first track should exist")
        .music_url
        .clone();
    let _ = strategy
        .next_track(&tracks)
        .expect("second track should exist")
        .music_url
        .clone();
    let third = strategy
        .next_track(&tracks)
        .expect("strategy should refill after one full round")
        .music_url
        .clone();

    assert!(tracks.iter().any(|track| track.music_url == third));
}

#[test]
fn random_strategy_resets_when_track_count_changes() {
    let mut strategy = RandomPlaybackStrategy::new();
    let original_tracks = vec![track("a"), track("b"), track("c")];
    let resized_tracks = vec![track("x"), track("y")];

    let _ = strategy
        .next_track(&original_tracks)
        .expect("first track should exist");

    let next = strategy
        .next_track(&resized_tracks)
        .expect("strategy should recover after track count changes");

    assert!(
        resized_tracks
            .iter()
            .any(|track| track.music_url == next.music_url)
    );
}

#[test]
fn playback_strategy_set_repeats_current_track_in_repeat_current_mode() {
    let mut strategy = PlaybackStrategySet::new();
    let tracks = vec![track("a"), track("b"), track("c")];

    let first = strategy
        .next_track(PlaybackContinuationMode::Random, &tracks)
        .expect("first track should exist");
    let repeated = strategy
        .next_track(PlaybackContinuationMode::RepeatCurrent, &tracks)
        .expect("repeat mode should keep the current track");

    assert_eq!(repeated.music_url, first.music_url);
}

#[test]
fn playback_strategy_set_can_select_a_requested_track_before_repeat_current() {
    let mut strategy = PlaybackStrategySet::new();
    let tracks = vec![track("a"), track("b"), track("c")];
    let requested = tracks[1].clone();

    let selected = strategy
        .select_track(&requested, &tracks)
        .expect("requested track should exist");
    strategy.commit_current_track(&selected);
    let repeated = strategy
        .next_track(PlaybackContinuationMode::RepeatCurrent, &tracks)
        .expect("repeat mode should keep the selected track");

    assert_eq!(selected.music_url, requested.music_url);
    assert_eq!(repeated.music_url, requested.music_url);
}

#[test]
fn playback_strategy_set_consumes_ordered_queue_after_explicit_seed() {
    let mut strategy = PlaybackStrategySet::new();
    let tracks = vec![track("seed"), track("next"), track("third")];

    strategy.commit_current_track(&tracks[0]);
    let next = strategy
        .next_track_with_queue_mode(
            PlaybackContinuationMode::Random,
            PlaybackQueueMode::Ordered,
            &tracks,
        )
        .expect("ordered queue should return the next recommended track");
    let third = strategy
        .next_track_with_queue_mode(
            PlaybackContinuationMode::Random,
            PlaybackQueueMode::Ordered,
            &tracks,
        )
        .expect("ordered queue should keep consuming the recommended order");

    assert_eq!(next.music_url, tracks[1].music_url);
    assert_eq!(third.music_url, tracks[2].music_url);
}

#[test]
fn playback_strategy_set_consumes_ordered_queue_after_seed_is_inserted_into_refreshed_queue() {
    let mut strategy = PlaybackStrategySet::new();
    let seed_only = vec![track("seed")];
    let refreshed = vec![track("seed"), track("next"), track("third")];

    strategy.commit_current_track(&seed_only[0]);
    assert!(
        strategy
            .reconcile_current_track_identity(&seed_only, &refreshed, Some(&seed_only[0]))
            .is_none()
    );
    let next = strategy
        .next_track_with_queue_mode(
            PlaybackContinuationMode::Random,
            PlaybackQueueMode::Ordered,
            &refreshed,
        )
        .expect("ordered queue should continue after the active seed");

    assert_eq!(next.music_url, refreshed[1].music_url);
}

#[test]
fn playback_strategy_set_keeps_repeat_current_above_ordered_queue_mode() {
    let mut strategy = PlaybackStrategySet::new();
    let tracks = vec![track("seed"), track("next")];

    strategy.commit_current_track(&tracks[0]);
    let repeated = strategy
        .next_track_with_queue_mode(
            PlaybackContinuationMode::RepeatCurrent,
            PlaybackQueueMode::Ordered,
            &tracks,
        )
        .expect("repeat mode should still keep the current track");

    assert_eq!(repeated.music_url, tracks[0].music_url);
}

#[test]
fn playback_strategy_set_does_not_randomize_when_current_track_disappears_in_repeat_current_mode() {
    let mut strategy = PlaybackStrategySet::new();
    let original_tracks = vec![track("a")];
    let resized_tracks = vec![track("b"), track("c")];

    let _ = strategy
        .next_track(PlaybackContinuationMode::Random, &original_tracks)
        .expect("first track should exist");

    assert!(
        strategy
            .next_track(PlaybackContinuationMode::RepeatCurrent, &resized_tracks)
            .is_none()
    );
}

#[test]
fn playback_strategy_set_reconciles_current_track_identity_after_range_update() {
    let mut strategy = PlaybackStrategySet::new();
    let mut original = track("a");
    original.start_ms = 8_000;
    original.end_ms = 112_000;
    let mut updated = original.clone();
    updated.music_name = "A edited".to_string();
    updated.start_ms = 9_250;
    updated.end_ms = 110_750;

    let first = strategy
        .next_track(
            PlaybackContinuationMode::Random,
            std::slice::from_ref(&original),
        )
        .expect("first track should exist");
    assert_eq!(first.start_ms, 8_000);

    let reconciled = strategy
        .reconcile_current_track_identity(
            std::slice::from_ref(&original),
            &[updated.clone()],
            Some(&updated),
        )
        .expect("current identity should migrate to the matching edited track");
    assert_eq!(reconciled.start_ms, 9_250);

    let repeated = strategy
        .next_track(PlaybackContinuationMode::RepeatCurrent, &[updated])
        .expect("repeat mode should keep the edited current track");
    assert_eq!(repeated.music_name, "A edited");
    assert_eq!(repeated.start_ms, 9_250);
    assert_eq!(repeated.end_ms, 110_750);
}

#[test]
fn playback_strategy_set_uses_explicit_identity_update_when_same_media_has_many_ranges() {
    let mut strategy = PlaybackStrategySet::new();
    let mut original = track("a");
    original.start_ms = 1_255_050;
    original.end_ms = 1_355_000;

    let mut edited = original.clone();
    edited.start_ms = 1_254_046;
    edited.end_ms = 1_355_000;

    let mut sibling = original.clone();
    sibling.music_name = "A sibling".to_string();
    sibling.start_ms = 387_872;
    sibling.end_ms = 458_000;

    let _ = strategy
        .next_track(
            PlaybackContinuationMode::Random,
            std::slice::from_ref(&original),
        )
        .expect("first track should exist");
    let reconciled = strategy
        .reconcile_current_track_identity(
            std::slice::from_ref(&original),
            &[sibling, edited.clone()],
            Some(&edited),
        )
        .expect("explicit identity update should select the edited current track");

    assert_eq!(reconciled.start_ms, 1_254_046);
    assert_eq!(reconciled.end_ms, 1_355_000);
}

#[test]
fn playback_strategy_set_rejects_ambiguous_media_only_identity_migration() {
    let mut strategy = PlaybackStrategySet::new();
    let mut original = track("a");
    original.start_ms = 1_255_050;
    original.end_ms = 1_355_000;

    let mut left = original.clone();
    left.start_ms = 1_254_046;
    let mut right = original.clone();
    right.start_ms = 387_872;
    right.end_ms = 458_000;

    let _ = strategy
        .next_track(
            PlaybackContinuationMode::Random,
            std::slice::from_ref(&original),
        )
        .expect("first track should exist");

    assert!(
        strategy
            .reconcile_current_track_identity(std::slice::from_ref(&original), &[left, right], None)
            .is_none()
    );
}
