use super::model::PlaybackTrack;
use super::strategy::{PlaybackStrategy, RandomPlaybackStrategy};
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
