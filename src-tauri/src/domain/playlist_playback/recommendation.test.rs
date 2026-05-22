use super::recommendation::{
    AudioStyleEmbeddingCache, AudioStylePlaylistPlaybackRecommender,
    choose_next_audio_style_candidate_for_test,
};
use crate::domain::player::model::PlaybackTrack;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn track(name: &str) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: name.to_string(),
        music_url: format!("https://example.com/{name}"),
        file_path: PathBuf::from(format!("{name}.m4a")),
        start_ms: 0,
        end_ms: 60_000,
        liked: false,
    }
}

fn embedding(active_index: usize) -> Vec<f32> {
    let mut values = vec![0.0; 64 * 64];
    values[active_index] = 1.0;
    values
}

fn temp_cache_root(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("ransic_audio_style_cache_{name}_{nanos}"))
}

#[test]
fn audio_style_recommender_keeps_current_track_at_queue_start() {
    let current = track("current");
    let near = track("near");
    let far = track("far");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (near.clone(), embedding(2)),
        (far.clone(), embedding(128)),
    ]);

    let proposed = recommender.propose_queue(
        current.clone(),
        vec![far.clone(), current.clone(), near.clone()],
    );
    let identity = proposed
        .iter()
        .map(|track| track.music_url.as_str())
        .collect::<std::collections::HashSet<_>>();

    assert_eq!(proposed[0].music_url, current.music_url);
    assert_eq!(proposed.len(), 2);
    assert_eq!(identity.len(), 2);
}

#[test]
fn audio_style_recommender_prefers_near_embedding_when_sampling_low_draw() {
    let current = track("current");
    let near = track("near");
    let far = track("far");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (near.clone(), embedding(2)),
        (far.clone(), embedding(128)),
    ]);

    let index = choose_next_audio_style_candidate_for_test(
        &current,
        &[near.clone(), far.clone()],
        &recommender,
        0.01,
    );

    assert_eq!(index, 0);
}

#[test]
fn audio_style_recommender_keeps_liked_candidate_in_middle_weight_band() {
    let current = track("current");
    let low = track("low");
    let mut liked = track("liked");
    let high = track("high");
    liked.liked = true;
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (low.clone(), embedding(128)),
        (high.clone(), embedding(2)),
    ]);

    let selected_after_low = choose_next_audio_style_candidate_for_test(
        &current,
        &[low.clone(), liked.clone(), high.clone()],
        &recommender,
        0.15,
    );
    let selected_after_liked = choose_next_audio_style_candidate_for_test(
        &current,
        &[low, liked, high],
        &recommender,
        0.5,
    );

    assert_eq!(selected_after_low, 1);
    assert_eq!(selected_after_liked, 2);
}

#[test]
fn audio_style_recommender_after_exclude_does_not_reinsert_current_track() {
    let current = track("current");
    let near = track("near");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (near.clone(), embedding(2)),
    ]);

    let proposed = recommender
        .propose_queue_after_exclude(current.clone(), vec![current.clone(), near.clone()]);

    assert_eq!(proposed.len(), 1);
    assert_eq!(proposed[0].music_url, near.music_url);
}

#[test]
fn cached_audio_style_recommender_does_not_decode_missing_embeddings() {
    let root = temp_cache_root("missing");
    std::fs::create_dir_all(&root).expect("cache test root should be created");
    let cache = AudioStyleEmbeddingCache::new(PathBuf::from("missing-ffmpeg"), root.clone())
        .expect("empty cache should be created without ffmpeg");
    let mut current = track("current");
    let mut near = track("near");
    current.file_path = root.join("current.m4a");
    near.file_path = root.join("near.m4a");
    std::fs::write(&current.file_path, b"current").expect("current test audio should exist");
    std::fs::write(&near.file_path, b"near").expect("near test audio should exist");

    let (recommender, missing_tracks, failures) =
        AudioStylePlaylistPlaybackRecommender::from_cached_tracks(
            &cache,
            &[current.clone(), near.clone()],
        );

    assert!(!recommender.has_embedding_for(&current));
    assert_eq!(missing_tracks.len(), 2);
    assert!(failures.is_empty());

    let _ = std::fs::remove_dir_all(root);
}
