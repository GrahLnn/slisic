use super::model::PlaybackContinuationMode;
use super::model::PlaybackTrack;
use super::strategy::{PlaybackStrategy, PlaybackStrategySet, RandomPlaybackStrategy};
use std::path::PathBuf;

fn track(name: &str) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: name.to_string(),
        music_url: format!("https://example.com/{name}"),
        file_path: PathBuf::from(format!("{name}.m4a")),
        start: 0,
        end: 60,
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
fn playback_strategy_set_falls_back_to_random_when_current_track_disappears() {
    let mut strategy = PlaybackStrategySet::new();
    let original_tracks = vec![track("a")];
    let resized_tracks = vec![track("b"), track("c")];

    let _ = strategy
        .next_track(PlaybackContinuationMode::Random, &original_tracks)
        .expect("first track should exist");
    let next = strategy
        .next_track(PlaybackContinuationMode::RepeatCurrent, &resized_tracks)
        .expect("repeat mode should recover when the current track is removed");

    assert!(
        resized_tracks
            .iter()
            .any(|track| track.music_url == next.music_url)
    );
}
