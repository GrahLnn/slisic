use super::recommendation::{
    AUDIO_STYLE_EMBEDDING_VERSION_FOR_TEST, AudioStyleEmbeddingCache, AudioStyleModelSnapshot,
    AudioStylePlaylistPlaybackRecommender, audio_style_transition_fingerprint_for_test,
    choose_next_audio_style_candidate_for_test,
    choose_next_audio_style_candidate_with_generation_for_test,
};
use crate::domain::player::model::PlaybackTrack;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const TEST_EMBEDDING_WIDTH: usize = 64 * 2 + 64 * 2 + 64 * 64;

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

fn track_in_playlist(playlist_name: &str, name: &str) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: playlist_name.to_string(),
        ..track(name)
    }
}

fn embedding(active_index: usize) -> Vec<f32> {
    let mut values = vec![0.0; TEST_EMBEDDING_WIDTH];
    values[active_index] = 1.0;
    values
}

fn padded_embedding(values: &[f32]) -> Vec<f32> {
    let mut embedding = vec![0.0; TEST_EMBEDDING_WIDTH];
    for (index, value) in values.iter().enumerate() {
        embedding[index] = *value;
    }
    embedding
}

fn dense_embedding(entries: &[(usize, f32)]) -> Vec<f32> {
    let mut values = vec![0.0; TEST_EMBEDDING_WIDTH];
    for (index, value) in entries {
        values[*index] = *value;
    }
    values
}

fn sine_wave(hz: f32, seconds: f32) -> Vec<f32> {
    let sample_rate = 16_000.0_f32;
    let sample_count = (sample_rate * seconds) as usize;
    (0..sample_count)
        .map(|index| {
            let time = index as f32 / sample_rate;
            (2.0 * std::f32::consts::PI * hz * time).sin()
        })
        .collect()
}

fn cosine(left: &[f32], right: &[f32]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum()
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

#[test]
fn audio_style_embedding_cache_removes_stale_versions_on_open() {
    let root = temp_cache_root("cleanup");
    std::fs::create_dir_all(&root).expect("cache test root should be created");
    let stale_path = root.join("stale.json");
    let current_path = root.join("current.json");
    let other_path = root.join("note.txt");
    std::fs::write(
        &stale_path,
        serde_json::json!({
            "version": "audio-style-sketch-v1",
            "values": [0.0]
        })
        .to_string(),
    )
    .expect("stale cache should be written");
    std::fs::write(
        &current_path,
        serde_json::json!({
            "version": AUDIO_STYLE_EMBEDDING_VERSION_FOR_TEST,
            "values": [0.0]
        })
        .to_string(),
    )
    .expect("current cache should be written");
    std::fs::write(&other_path, b"keep").expect("non-json cache sibling should be written");

    AudioStyleEmbeddingCache::new(PathBuf::from("missing-ffmpeg"), root.clone())
        .expect("cache should open and clean stale embeddings");

    assert!(!stale_path.exists());
    assert!(current_path.exists());
    assert!(other_path.exists());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn audio_style_track_key_matches_across_playlists() {
    let current = track_in_playlist("Playlist 1", "current");
    let current_alias = track_in_playlist("Playlist 2", "current");
    let near = track_in_playlist("Playlist 2", "near");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (near.clone(), embedding(2)),
    ]);

    let proposed = recommender.propose_queue(current_alias, vec![near.clone()]);

    assert_eq!(proposed.len(), 2);
    assert_eq!(proposed[1].music_url, near.music_url);
}

#[test]
fn audio_style_recommender_without_trained_weights_falls_back_to_random() {
    let current = track("current");
    let near = track("near");
    let far = track("far");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_untrained_test_embeddings([(
        current.clone(),
        embedding(2),
    )]);

    let selection = choose_next_audio_style_candidate_with_generation_for_test(
        &current,
        &[near, far],
        &recommender,
        0.75,
        None,
    );

    assert_eq!(selection.source.as_str(), "random_fallback");
    assert_eq!(selection.reason, Some("untrained_model"));
    assert_eq!(selection.index, 1);
}

#[test]
fn audio_style_model_refresh_reuses_unchanged_embeddings() {
    let root = temp_cache_root("refresh_reuse");
    std::fs::create_dir_all(&root).expect("cache test root should be created");
    let cache = AudioStyleEmbeddingCache::new(PathBuf::from("missing-ffmpeg"), root.clone())
        .expect("cache should be created without ffmpeg");
    let mut current = track("current");
    let mut near = track("near");
    let mut added = track("added");
    current.file_path = root.join("current.m4a");
    near.file_path = root.join("near.m4a");
    added.file_path = root.join("added.m4a");
    std::fs::write(&current.file_path, b"current").expect("current test audio should exist");
    std::fs::write(&near.file_path, b"near").expect("near test audio should exist");
    std::fs::write(&added.file_path, b"added").expect("added test audio should exist");

    let previous = AudioStyleModelSnapshot::from_test_embeddings(
        1,
        [
            (current.clone(), embedding(2)),
            (near.clone(), embedding(3)),
        ],
    );
    cache
        .write_test_embedding_for_track(&added, embedding(4))
        .expect("new embedding should be cached");

    let refreshed = AudioStyleModelSnapshot::refresh_for_test(
        2,
        Some(&previous),
        &cache,
        vec![current.clone(), near.clone(), added.clone()],
    )
    .expect("refresh should reuse previous embeddings and load only added track");

    let previous_current = previous
        .embedding_arc_for_track(&current)
        .expect("previous current embedding should exist");
    let refreshed_current = refreshed
        .embedding_arc_for_track(&current)
        .expect("refreshed current embedding should exist");
    assert!(std::sync::Arc::ptr_eq(
        &previous_current,
        &refreshed_current
    ));
    assert!(refreshed.recommender().has_embedding_for(&added));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn audio_style_model_refresh_recenters_reused_embeddings_with_new_mean() {
    let current = track("current");
    let near = track("near");
    let far = track("far");
    let previous = AudioStyleModelSnapshot::from_test_embeddings(
        1,
        [
            (current.clone(), dense_embedding(&[(0, 1.0)])),
            (near.clone(), dense_embedding(&[(0, 0.8), (1, 0.6)])),
            (far.clone(), dense_embedding(&[(1, 1.0)])),
        ],
    );
    let added = track("added");
    let previous_similarity = previous
        .recommender()
        .centered_similarity_for_test(&current, &near)
        .expect("previous similarity should exist");
    let embeddings = [
        (current.clone(), dense_embedding(&[(0, 1.0)])),
        (near.clone(), dense_embedding(&[(0, 0.8), (1, 0.6)])),
        (far, dense_embedding(&[(1, 1.0)])),
        (added, dense_embedding(&[(0, -1.0)])),
    ];
    let refreshed = AudioStyleModelSnapshot::from_test_embeddings(2, embeddings);
    let refreshed_similarity = refreshed
        .recommender()
        .centered_similarity_for_test(&current, &near)
        .expect("refreshed similarity should exist");

    assert!((previous_similarity - refreshed_similarity).abs() > 0.01);
}

#[test]
fn trained_audio_style_snapshot_lifts_near_neighbors_above_uniform() {
    let current = track("current");
    let near = track("near");
    let far = track("far");
    let snapshot = AudioStyleModelSnapshot::from_test_embeddings(
        7,
        [
            (current.clone(), embedding(2)),
            (near.clone(), embedding(2)),
            (far.clone(), embedding(128)),
        ],
    );

    let selection = choose_next_audio_style_candidate_with_generation_for_test(
        &current,
        &[near, far],
        snapshot.recommender(),
        0.8,
        Some(snapshot.generation()),
    );

    assert_eq!(selection.index, 0);
    assert_eq!(selection.model_generation, Some(7));
    assert!(selection.probability > 0.5);
}

#[test]
fn trained_audio_style_snapshot_uses_centered_local_density_corrected_scores() {
    let current = track("current");
    let hub = track("hub");
    let sparse = track("sparse");
    let hub_neighbors = (0..10)
        .map(|index| track(&format!("hub_neighbor_{index}")))
        .collect::<Vec<_>>();
    let outliers = (0..6)
        .map(|index| track(&format!("outlier_{index}")))
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_embeddings(
        8,
        [
            (
                current.clone(),
                padded_embedding(&[1.0, 0.0, 0.0, 0.0, 0.0]),
            ),
            (
                sparse.clone(),
                padded_embedding(&[0.802816, 0.596226, 0.0, 0.0, 0.0]),
            ),
            (
                hub.clone(),
                padded_embedding(&[0.951076, -0.10741, 0.289685, 0.0, 0.0]),
            ),
        ]
        .into_iter()
        .chain(
            [
                [0.954189, -0.0907814, 0.28248, 0.0383638, 0.00396523],
                [0.941647, -0.16309, 0.29444, -0.00277155, -0.000048089],
                [0.967979, -0.0759486, 0.233064, 0.0117537, -0.0528366],
                [0.944065, -0.0809485, 0.313463, -0.035779, -0.0514705],
                [0.953696, -0.115017, 0.275433, -0.0316627, -0.0192341],
                [0.954346, -0.123972, 0.266257, -0.0542629, 0.00421383],
                [0.942844, -0.0778902, 0.313207, -0.00974958, 0.0823689],
                [0.939892, -0.161365, 0.299301, -0.0311113, 0.00380005],
                [0.930676, -0.144995, 0.325934, 0.00535817, -0.0809686],
                [0.9433, -0.173602, 0.280446, -0.0331067, -0.0173823],
            ]
            .into_iter()
            .zip(hub_neighbors.iter().cloned())
            .map(|(values, track)| (track, padded_embedding(&values))),
        )
        .chain(
            [
                [-0.128714, 0.691807, -0.26131, 0.227741, -0.620231],
                [-0.838392, -0.296527, 0.0833028, -0.0344585, -0.448378],
                [0.430704, 0.354962, 0.369595, -0.0777352, 0.738819],
                [-0.26541, 0.444057, -0.407852, -0.656995, -0.366585],
                [-0.301473, 0.293728, 0.840836, 0.0341619, 0.338623],
                [0.186061, 0.288762, -0.332066, 0.282154, 0.831937],
            ]
            .into_iter()
            .zip(outliers.iter().cloned())
            .map(|(values, track)| (track, padded_embedding(&values))),
        ),
    );

    let candidates = [hub, sparse];
    let selection = choose_next_audio_style_candidate_with_generation_for_test(
        &current,
        &candidates,
        snapshot.recommender(),
        0.5,
        Some(snapshot.generation()),
    );

    assert_eq!(selection.index, 1);
    assert_eq!(selection.model_generation, Some(8));
    assert!(
        selection
            .similarity
            .is_some_and(|similarity| (-1.0..=1.0).contains(&similarity))
    );
}

#[test]
fn trained_audio_style_snapshot_keeps_liked_tail_candidate_sampleable() {
    let current = track("current");
    let best = track("best");
    let mut liked_tail = track("liked_tail");
    let low = track("low");
    liked_tail.liked = true;
    let snapshot = AudioStyleModelSnapshot::from_test_embeddings(
        9,
        [
            (current.clone(), dense_embedding(&[(0, 1.0)])),
            (best.clone(), dense_embedding(&[(0, 0.9), (1, 0.43589)])),
            (
                liked_tail.clone(),
                dense_embedding(&[(0, 0.72), (1, 0.693974)]),
            ),
            (low.clone(), dense_embedding(&[(0, 0.6), (1, 0.8)])),
        ],
    );

    let selection = choose_next_audio_style_candidate_with_generation_for_test(
        &current,
        &[best, liked_tail, low],
        snapshot.recommender(),
        0.96,
        Some(snapshot.generation()),
    );

    assert_eq!(selection.index, 1);
    assert_eq!(selection.model_generation, Some(9));
    assert!(
        selection
            .local_rank_fraction
            .is_some_and(|rank| rank >= 0.5)
    );
}

#[test]
fn replacing_audio_style_snapshot_does_not_mutate_old_snapshot() {
    let current = track("current");
    let near = track("near");
    let far = track("far");
    let old = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        1,
        [
            (current.clone(), embedding(2)),
            (near.clone(), embedding(2)),
            (far.clone(), embedding(128)),
        ],
    ));
    let mut published = old.clone();
    let new = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        2,
        [
            (current.clone(), embedding(2)),
            (near.clone(), embedding(128)),
            (far.clone(), embedding(2)),
        ],
    ));
    published = new;

    let old_selection = choose_next_audio_style_candidate_with_generation_for_test(
        &current,
        &[near.clone(), far.clone()],
        old.recommender(),
        0.8,
        Some(old.generation()),
    );
    let new_selection = choose_next_audio_style_candidate_with_generation_for_test(
        &current,
        &[near, far],
        published.recommender(),
        0.8,
        Some(published.generation()),
    );

    assert_eq!(old_selection.index, 0);
    assert_eq!(old_selection.model_generation, Some(1));
    assert_eq!(new_selection.index, 1);
    assert_eq!(new_selection.model_generation, Some(2));
}

#[test]
fn audio_style_transition_fingerprint_preserves_spectral_style_neighborhood() {
    let base = audio_style_transition_fingerprint_for_test(&sine_wave(220.0, 8.0));
    let near = audio_style_transition_fingerprint_for_test(&sine_wave(224.0, 8.0));
    let far = audio_style_transition_fingerprint_for_test(&sine_wave(880.0, 8.0));

    assert_eq!(base.len(), TEST_EMBEDDING_WIDTH);
    assert!(cosine(&base, &near) > cosine(&base, &far));
}
