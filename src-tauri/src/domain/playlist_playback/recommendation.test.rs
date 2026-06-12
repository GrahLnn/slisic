use super::recommendation::{
    AUDIO_STYLE_EMBEDDING_VERSION_FOR_TEST, AudioStyleEmbeddingCache, AudioStyleModelSnapshot,
    AudioStylePlaylistPlaybackRecommender, audio_style_training_path_is_transient_for_test,
    audio_style_transition_fingerprint_for_test, choose_audio_style_model_snapshots_for_anchor,
    choose_centerless_audio_style_candidate_for_test, choose_next_audio_style_candidate_for_test,
    choose_next_audio_style_candidate_with_generation_for_test,
    choose_next_audio_style_candidate_with_recent_history_for_test,
    filter_recently_played_recommendation_candidates,
    read_cached_audio_style_model_evidence_for_test,
    write_cached_audio_style_model_evidence_for_test,
};
use crate::domain::player::model::PlaybackTrack;
use crate::domain::playlists::model::{CollectionGroupOwner, Group, LoudnessProfile, Music};
use crate::domain::playlists::repo::PlaylistPlaybackTrackSource;
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
        loudness_profile: None,
    }
}

fn track_with_loudness(name: &str, profile: LoudnessProfile) -> PlaybackTrack {
    PlaybackTrack {
        loudness_profile: Some(profile),
        ..track(name)
    }
}

fn loudness_profile(
    integrated_lufs: f32,
    short_lufs_p50: f32,
    short_lufs_p80: f32,
    short_lufs_p95: f32,
    short_lufs_max: f32,
    presence_db: f32,
    lra: f32,
) -> LoudnessProfile {
    LoudnessProfile {
        integrated_lufs,
        true_peak_dbtp: Some(-0.5),
        lra: Some(lra),
        short_lufs_p50: Some(short_lufs_p50),
        short_lufs_p80: Some(short_lufs_p80),
        short_lufs_p95: Some(short_lufs_p95),
        short_lufs_max: Some(short_lufs_max),
        presence_db: Some(presence_db),
        model_adjustment_db: None,
    }
}

fn track_in_basin(basin: &str, name: &str) -> PlaybackTrack {
    PlaybackTrack {
        file_path: PathBuf::from(format!("youtube/{basin}/{name}.m4a")),
        ..track(name)
    }
}

fn track_in_source_leaf(source: &str, leaf: &str, name: &str) -> PlaybackTrack {
    PlaybackTrack {
        file_path: PathBuf::from(format!("youtube/{source}/{leaf}/{name}.m4a")),
        ..track(name)
    }
}

fn track_in_playlist(playlist_name: &str, name: &str) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: playlist_name.to_string(),
        ..track(name)
    }
}

fn source_from_track(
    collection_folder: &str,
    track: &PlaybackTrack,
) -> PlaylistPlaybackTrackSource {
    PlaylistPlaybackTrackSource {
        collection_folder: collection_folder.to_string(),
        music: Music {
            occurrence_id: String::new(),
            name: track.music_name.clone(),
            alias: track.music_name.clone(),
            group: Group {
                name: String::new(),
                url: String::new(),
                collection: CollectionGroupOwner {
                    name: String::new(),
                    url: String::new(),
                    folder: collection_folder.to_string(),
                    last_updated: String::new(),
                    enable_updates: None,
                },
                folder: String::new(),
            },
            canonical_music_id: track.canonical_music_id.clone(),
            url: track.music_url.clone(),
            path: Some(track.file_path.to_string_lossy().to_string()),
            start_ms: track.start_ms,
            end_ms: track.end_ms,
            liked: track.liked,
            loudness_profile: None,
        },
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
    std::env::temp_dir().join(format!("slisic_audio_style_cache_{name}_{nanos}"))
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
fn audio_style_recommender_skips_recent_non_liked_candidate() {
    let current = track("current");
    let played_near = track("played_near");
    let fresh_far = track("fresh_far");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (played_near.clone(), embedding(2)),
        (fresh_far.clone(), embedding(128)),
    ]);

    let proposed = recommender.propose_queue_with_recent_history(
        current.clone(),
        vec![played_near.clone(), fresh_far.clone()],
        std::slice::from_ref(&played_near),
    );

    assert_eq!(proposed.len(), 2);
    assert_eq!(proposed[0].music_url, current.music_url);
    assert_eq!(proposed[1].music_url, fresh_far.music_url);
}

#[test]
fn audio_style_recommender_skips_same_played_music_identity() {
    let current = track("current");
    let played_near = track("played_near");
    let mut same_music_other_range = track("played_near_other_range");
    same_music_other_range.canonical_music_id = played_near.canonical_music_id.clone();
    same_music_other_range.music_url = "https://example.com/played_near?range=2".to_string();
    same_music_other_range.file_path = PathBuf::from("played-near-other-range.m4a");
    same_music_other_range.start_ms = 60_000;
    same_music_other_range.end_ms = 120_000;
    let fresh_far = track("fresh_far");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (played_near.clone(), embedding(2)),
        (same_music_other_range.clone(), embedding(2)),
        (fresh_far.clone(), embedding(128)),
    ]);

    let proposed = recommender.propose_queue_with_recent_history(
        current.clone(),
        vec![same_music_other_range, fresh_far.clone()],
        std::slice::from_ref(&played_near),
    );

    assert_eq!(proposed.len(), 2);
    assert_eq!(proposed[0].music_url, current.music_url);
    assert_eq!(proposed[1].music_url, fresh_far.music_url);
}

#[test]
fn audio_style_sampler_skips_zero_weight_candidate_at_low_draw() {
    let current = track("current");
    let missing_embedding = track("missing_embedding");
    let near = track("near");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (near.clone(), embedding(2)),
    ]);

    let selection = choose_next_audio_style_candidate_with_generation_for_test(
        &current,
        &[missing_embedding, near],
        &recommender,
        0.0,
        Some(1),
    );

    assert_eq!(selection.index, 1);
    assert_eq!(selection.source.as_str(), "audio_style");
    assert_eq!(selection.reason, None);
    assert!(selection.probability > 0.0);
}

#[test]
fn recommendation_history_filter_does_not_delete_basin_candidates() {
    let played_a = track_in_basin("Kurzgesagt", "played_a");
    let played_b = track_in_basin("Kurzgesagt", "played_b");
    let played_c = track_in_basin("Kurzgesagt", "played_c");
    let same_basin = track_in_basin("Kurzgesagt", "same_basin");
    let other_basin = track_in_basin("ZWEI2", "other_basin");

    let filtered = filter_recently_played_recommendation_candidates(
        vec![same_basin.clone(), other_basin.clone()],
        &[played_a, played_b, played_c],
    );

    assert_eq!(filtered.len(), 2);
    assert!(
        filtered
            .iter()
            .any(|track| track.music_url == same_basin.music_url)
    );
    assert!(
        filtered
            .iter()
            .any(|track| track.music_url == other_basin.music_url)
    );
}

#[test]
fn audio_style_sampler_applies_continuous_attractor_basin_pressure() {
    let current = track_in_basin("Kurzgesagt", "current");
    let played_a = track_in_basin("Kurzgesagt", "played_a");
    let played_b = track_in_basin("Kurzgesagt", "played_b");
    let played_c = track_in_basin("Kurzgesagt", "played_c");
    let same_basin = track_in_basin("Kurzgesagt", "same_basin");
    let other_basin = track_in_basin("ZWEI2", "other_basin");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (same_basin.clone(), embedding(2)),
        (other_basin.clone(), embedding(2)),
    ]);

    let without_pressure = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_basin.clone(), other_basin.clone()],
        &recommender,
        &[],
        0.45,
    );
    let with_pressure = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_basin.clone(), other_basin.clone()],
        &recommender,
        &[played_a, played_b, played_c],
        0.55,
    );

    assert_eq!(without_pressure.index, 0);
    assert_eq!(with_pressure.index, 1);
    assert!(with_pressure.probability > without_pressure.probability);
}

#[test]
fn audio_style_basin_pressure_does_not_override_clear_distance_preference() {
    let current = track_in_basin("Kurzgesagt", "current");
    let played = (0..12)
        .map(|index| track_in_basin("Kurzgesagt", &format!("played_{index}")))
        .collect::<Vec<_>>();
    let near_same_basin = track_in_basin("Kurzgesagt", "near_same_basin");
    let far_other_basin = track_in_basin("ZWEI2", "far_other_basin");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (near_same_basin.clone(), embedding(2)),
        (far_other_basin.clone(), embedding(128)),
    ]);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[near_same_basin.clone(), far_other_basin.clone()],
        &recommender,
        &played,
        0.70,
    );

    assert_eq!(selection.index, 0);
    assert!(selection.probability > 0.70);
}

#[test]
fn audio_style_sampler_keeps_liked_candidate_sampleable_under_attractor_basin_pressure() {
    let current = track_in_source_leaf("Shared Source", "Kurzgesagt", "current");
    let played_a = track_in_source_leaf("Shared Source", "Kurzgesagt", "played_a");
    let played_b = track_in_source_leaf("Shared Source", "Kurzgesagt", "played_b");
    let played_c = track_in_source_leaf("Shared Source", "Kurzgesagt", "played_c");
    let mut liked_same_basin =
        track_in_source_leaf("Shared Source", "Kurzgesagt", "liked_same_basin");
    let other_basin = track_in_source_leaf("Shared Source", "ZWEI2", "other_basin");
    liked_same_basin.liked = true;
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (liked_same_basin.clone(), embedding(2)),
        (other_basin.clone(), embedding(2)),
    ]);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[liked_same_basin.clone(), other_basin.clone()],
        &recommender,
        &[played_a, played_b, played_c],
        0.15,
    );

    assert_eq!(selection.index, 0);
    assert!(selection.probability > 0.0);
    assert_eq!(selection.reason, None);
}

#[test]
fn audio_style_distance_softmin_prefers_near_tracks_over_source_balancing() {
    let current = track_in_source_leaf("Epic Mountain - Playlists", "Kurzgesagt 2024", "current");
    let epic_tracks = (0..4)
        .map(|index| {
            track_in_source_leaf(
                "Epic Mountain - Playlists",
                &format!("Kurzgesagt {index}"),
                &format!("epic_{index}"),
            )
        })
        .collect::<Vec<_>>();
    let small_tracks = [
        track_in_source_leaf("ZWEI2 Original Soundtrack", "Disc 1", "zwei2_a"),
        track_in_source_leaf("Death Stranding", "OST", "death_a"),
    ];
    let mut embeddings = vec![(current.clone(), embedding(2))];
    embeddings.extend(
        epic_tracks
            .iter()
            .cloned()
            .map(|track| (track, embedding(2))),
    );
    embeddings.extend(
        small_tracks
            .iter()
            .cloned()
            .map(|track| (track, embedding(128))),
    );
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);
    let candidates = epic_tracks
        .iter()
        .cloned()
        .chain(small_tracks.iter().cloned())
        .collect::<Vec<_>>();

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &candidates,
        &recommender,
        &[],
        0.50,
    );

    assert!(selection.index < epic_tracks.len());
    assert!(selection.probability > selection.uniform_probability);
}

#[test]
fn audio_style_distance_softmin_keeps_smooth_track_preferred() {
    let current = track_in_source_leaf("Epic Mountain - Playlists", "Kurzgesagt 2024", "current");
    let smooth = track_in_source_leaf("Smooth Source", "Leaf", "smooth");
    let far = track_in_source_leaf("Far Source", "Leaf", "far");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (smooth.clone(), embedding(2)),
        (far.clone(), embedding(128)),
    ]);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[smooth.clone(), far.clone()],
        &recommender,
        &[],
        0.75,
    );

    assert_eq!(selection.index, 0);
    assert!(selection.probability > 0.85);
}

#[test]
fn audio_style_attractor_basin_pressure_can_move_out_of_repeated_basin() {
    let current = track_in_basin("Kurzgesagt", "current");
    let played = (0..8)
        .map(|index| track_in_basin("Kurzgesagt", &format!("played_epic_{index}")))
        .collect::<Vec<_>>();
    let epic_candidate = track_in_basin("Kurzgesagt", "epic_next");
    let other_candidate = track_in_basin("ZWEI2", "zwei2_next");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (epic_candidate.clone(), embedding(2)),
        (other_candidate.clone(), embedding(2)),
    ]);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[epic_candidate.clone(), other_candidate.clone()],
        &recommender,
        &played,
        0.35,
    );

    assert_eq!(selection.index, 1);
    assert!(selection.probability > 0.80);
}

#[test]
fn audio_style_region_pressure_reduces_repeated_model_region_without_changing_basin_contract() {
    let current = track_in_basin("Current", "current");
    let recent = (0..8)
        .map(|index| track_in_basin(&format!("Recent {index}"), &format!("recent_{index}")))
        .collect::<Vec<_>>();
    let same_region = track_in_basin("Fresh Same Region", "same_region");
    let open_region = track_in_basin("Fresh Open Region", "open_region");
    let mut embeddings = vec![(current.clone(), dense_embedding(&[(0, 1.0)]))];
    embeddings.extend(
        recent
            .iter()
            .cloned()
            .map(|track| (track, dense_embedding(&[(0, 0.98), (1, 0.20)]))),
    );
    embeddings.extend([
        (
            same_region.clone(),
            dense_embedding(&[(0, 0.98), (1, 0.20)]),
        ),
        (
            open_region.clone(),
            dense_embedding(&[(0, 0.97), (2, 0.243)]),
        ),
    ]);
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let without_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_region.clone(), open_region.clone()],
        &recommender,
        &[],
        0.0,
    );
    let with_region_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_region.clone(), open_region.clone()],
        &recommender,
        &recent,
        0.0,
    );

    assert_eq!(without_history.index, 0);
    assert_eq!(with_region_history.index, 0);
    assert!(with_region_history.probability < without_history.probability);
    assert!(with_region_history.probability > 0.0);
}

#[test]
fn audio_style_readonly_route_pressure_moves_out_of_recent_style_macro_basin() {
    let current = track_in_basin("Current", "current");
    let mut embeddings = vec![(current.clone(), dense_embedding(&[(0, 1.0)]))];
    let recent_same_style = (0..10)
        .map(|index| track_in_basin("Cinematic", &format!("played_{index}")))
        .collect::<Vec<_>>();
    embeddings.extend(
        recent_same_style
            .iter()
            .cloned()
            .map(|track| (track, dense_embedding(&[(0, 0.9), (1, 0.43589)]))),
    );
    let same_style = track_in_basin("Fresh Cinematic", "same_style");
    let open_style = track_in_basin("Fresh Open", "open_style");
    embeddings.extend([
        (
            same_style.clone(),
            dense_embedding(&[(0, 0.9), (1, 0.43589)]),
        ),
        (
            open_style.clone(),
            dense_embedding(&[(0, 0.9), (2, 0.43589)]),
        ),
    ]);
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let without_history_same_style = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_style.clone(), open_style.clone()],
        &recommender,
        &[],
        0.0,
    );
    let with_history_same_style = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_style.clone(), open_style.clone()],
        &recommender,
        &recent_same_style,
        0.0,
    );

    assert_eq!(without_history_same_style.index, 0);
    assert_eq!(with_history_same_style.index, 0);
    assert!(with_history_same_style.probability < without_history_same_style.probability);
    assert!(with_history_same_style.probability > 0.0);
}

#[test]
fn audio_style_readonly_route_pressure_ignores_current_anchor_similarity() {
    let current = track_in_basin("Current", "current");
    let near = track_in_basin("Near", "near");
    let far = track_in_basin("Far", "far");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), dense_embedding(&[(0, 1.0)])),
        (near.clone(), dense_embedding(&[(0, 0.9), (1, 0.43589)])),
        (far.clone(), dense_embedding(&[(2, 1.0)])),
    ]);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[near.clone(), far.clone()],
        &recommender,
        std::slice::from_ref(&current),
        0.70,
    );

    assert_eq!(selection.index, 0);
    assert!(selection.probability > 0.85);
}

#[test]
fn audio_style_attractor_basin_pressure_does_not_remove_liked_tracks_from_sampling_domain() {
    let current = track_in_basin("Kurzgesagt", "current");
    let played = (0..8)
        .map(|index| track_in_basin("Kurzgesagt", &format!("played_epic_{index}")))
        .collect::<Vec<_>>();
    let mut liked_epic = track_in_basin("Kurzgesagt", "liked_epic");
    liked_epic.liked = true;
    let other_candidate = track_in_basin("ZWEI2", "zwei2_next");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (liked_epic.clone(), embedding(2)),
        (other_candidate.clone(), embedding(2)),
    ]);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[liked_epic.clone(), other_candidate.clone()],
        &recommender,
        &played,
        0.15,
    );

    assert_eq!(selection.index, 0);
    assert!(selection.probability > 0.0);
}

#[test]
fn audio_style_readonly_route_pressure_does_not_discount_liked_recent_style_candidate() {
    let current = track_in_basin("Current", "current");
    let recent_same_style = (0..10)
        .map(|index| track_in_basin("Cinematic", &format!("played_{index}")))
        .collect::<Vec<_>>();
    let mut liked_same_style = track_in_basin("Fresh Cinematic", "liked_same_style");
    liked_same_style.liked = true;
    let plain_same_style = track_in_basin("Fresh Cinematic", "plain_same_style");
    let open_style = track_in_basin("Fresh Open", "open_style");
    let mut embeddings = vec![(current.clone(), dense_embedding(&[(0, 1.0)]))];
    embeddings.extend(
        recent_same_style
            .iter()
            .cloned()
            .map(|track| (track, dense_embedding(&[(0, 0.9), (1, 0.43589)]))),
    );
    embeddings.extend([
        (
            liked_same_style.clone(),
            dense_embedding(&[(0, 0.9), (1, 0.43589)]),
        ),
        (
            plain_same_style.clone(),
            dense_embedding(&[(0, 0.9), (1, 0.43589)]),
        ),
        (
            open_style.clone(),
            dense_embedding(&[(0, 0.9), (2, 0.43589)]),
        ),
    ]);
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let liked_selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[liked_same_style.clone(), open_style.clone()],
        &recommender,
        &recent_same_style,
        0.0,
    );
    let plain_selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[plain_same_style.clone(), open_style.clone()],
        &recommender,
        &recent_same_style,
        0.0,
    );

    assert_eq!(liked_selection.index, plain_selection.index);
    assert!(
        (liked_selection.probability - plain_selection.probability).abs() <= 1.0e-6,
        "liked status must not discount route pressure; it only keeps recent tracks sampleable"
    );
}

#[test]
fn audio_style_measured_loudness_pressure_reduces_repeated_high_arousal_candidate_weight() {
    let current = track_with_loudness(
        "current",
        loudness_profile(-18.0, -18.5, -17.0, -15.0, -14.5, -10.0, 8.0),
    );
    let played_hot = track_with_loudness(
        "played_hot",
        loudness_profile(-8.0, -8.5, -7.0, -5.5, -5.0, -5.0, 4.0),
    );
    let hot_candidate = track_with_loudness(
        "hot_candidate",
        loudness_profile(-7.5, -8.0, -6.8, -5.2, -4.9, -4.8, 4.0),
    );
    let calm_candidate = track_with_loudness(
        "calm_candidate",
        loudness_profile(-22.0, -23.0, -21.0, -19.0, -18.5, -13.0, 10.0),
    );
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_indexed_embeddings([
        (current.clone(), embedding(2), "source".to_string()),
        (played_hot.clone(), embedding(2), "source".to_string()),
        (hot_candidate.clone(), embedding(2), "source".to_string()),
        (calm_candidate.clone(), embedding(2), "source".to_string()),
    ]);

    let without_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[hot_candidate.clone(), calm_candidate.clone()],
        &recommender,
        &[],
        0.0,
    );
    let with_hot_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[hot_candidate, calm_candidate],
        &recommender,
        std::slice::from_ref(&played_hot),
        0.0,
    );

    assert_eq!(without_history.index, 0);
    assert_eq!(with_hot_history.index, 0);
    assert!(without_history.probability > 0.0);
    assert!(with_hot_history.probability > 0.0);
    assert!(with_hot_history.probability < without_history.probability);
}

#[test]
fn recommendation_history_falls_back_when_attractor_basin_fatigue_would_empty_candidates() {
    let played_a = track_in_basin("Kurzgesagt", "played_a");
    let played_b = track_in_basin("Kurzgesagt", "played_b");
    let played_c = track_in_basin("Kurzgesagt", "played_c");
    let same_basin = track_in_basin("Kurzgesagt", "same_basin");

    let filtered = filter_recently_played_recommendation_candidates(
        vec![same_basin.clone()],
        &[played_a, played_b, played_c],
    );

    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].music_url, same_basin.music_url);
}

#[test]
fn audio_style_history_filter_keeps_recent_liked_candidate_sampleable_without_weight_bonus() {
    let current = track("current");
    let low = track("low");
    let mut liked = track("liked");
    let high = track("high");
    liked.liked = true;
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (low.clone(), embedding(128)),
        (liked.clone(), embedding(128)),
        (high.clone(), embedding(2)),
    ]);
    let filtered = filter_recently_played_recommendation_candidates(
        vec![low.clone(), liked.clone(), high.clone()],
        std::slice::from_ref(&liked),
    );

    let selected_after_liked =
        choose_next_audio_style_candidate_for_test(&current, &filtered, &recommender, 0.50);
    let selected_after_near =
        choose_next_audio_style_candidate_for_test(&current, &filtered, &recommender, 0.5);

    assert_eq!(selected_after_liked, 2);
    assert_eq!(selected_after_near, 2);
}

#[test]
fn audio_style_liked_status_does_not_change_distance_distribution() {
    let current = track("current");
    let low = track("low");
    let mut liked = track("liked");
    let high = track("high");
    liked.liked = true;
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (low.clone(), embedding(128)),
        (liked.clone(), embedding(128)),
        (high.clone(), embedding(2)),
    ]);

    let selected_after_liked = choose_next_audio_style_candidate_for_test(
        &current,
        &[low.clone(), liked.clone(), high.clone()],
        &recommender,
        0.50,
    );
    let selected_after_near = choose_next_audio_style_candidate_for_test(
        &current,
        &[low, liked, high],
        &recommender,
        0.5,
    );

    assert_eq!(selected_after_liked, 2);
    assert_eq!(selected_after_near, 2);
}

#[test]
fn audio_style_bio_route_gate_modulates_distance_base_without_replacing_it() {
    let current = track_in_basin("Current", "current");
    let played = (0..12)
        .map(|index| track_in_basin("Current", &format!("played_{index}")))
        .collect::<Vec<_>>();
    let near_same_basin = track_in_basin("Current", "near_same_basin");
    let mut far_liked_open_basin = track_in_basin("Open", "far_liked_open_basin");
    far_liked_open_basin.liked = true;
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (near_same_basin.clone(), embedding(2)),
        (far_liked_open_basin.clone(), embedding(128)),
    ]);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[near_same_basin.clone(), far_liked_open_basin.clone()],
        &recommender,
        &played,
        0.70,
    );

    assert_eq!(selection.index, 0);
    assert!(selection.probability > 0.0);
}

#[test]
fn audio_style_bio_route_hcr_dendrite_prefers_open_basin_without_replacing_distance() {
    let current = track_in_basin("Current", "current");
    let played = (0..10)
        .map(|index| track_in_basin("Current", &format!("played_{index}")))
        .collect::<Vec<_>>();
    let repeated_basin = track_in_basin("Current", "repeated_basin");
    let open_basin = track_in_basin("Open", "open_basin");
    let far_open = track_in_basin("Open", "far_open");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (repeated_basin.clone(), embedding(2)),
        (open_basin.clone(), embedding(2)),
        (far_open.clone(), embedding(128)),
    ]);

    let open_selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[repeated_basin.clone(), open_basin.clone()],
        &recommender,
        &played,
        0.60,
    );
    let distance_selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[repeated_basin, far_open],
        &recommender,
        &played,
        0.95,
    );

    assert_eq!(open_selection.index, 1);
    assert!(open_selection.probability > 0.50);
    assert_eq!(distance_selection.index, 0);
    assert!(distance_selection.probability > 0.0);
}

#[test]
fn audio_style_distributed_field_reduces_recent_region_without_breaking_style_continuity() {
    let current = track_in_basin("Current", "current");
    let recent = (0..10)
        .map(|index| track_in_basin(&format!("Recent {index}"), &format!("recent_{index}")))
        .collect::<Vec<_>>();
    let same_region = track_in_basin("Fresh Same Region", "same_region");
    let open_region = track_in_basin("Fresh Open Region", "open_region");
    let mut embeddings = vec![(current.clone(), dense_embedding(&[(0, 1.0)]))];
    embeddings.extend(
        recent
            .iter()
            .cloned()
            .map(|track| (track, dense_embedding(&[(0, 0.98), (1, 0.20)]))),
    );
    embeddings.extend([
        (
            same_region.clone(),
            dense_embedding(&[(0, 0.98), (1, 0.20)]),
        ),
        (
            open_region.clone(),
            dense_embedding(&[(0, 0.97), (2, 0.243)]),
        ),
    ]);
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let without_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_region.clone(), open_region.clone()],
        &recommender,
        &[],
        0.0,
    );
    let with_recent_region = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_region.clone(), open_region.clone()],
        &recommender,
        &recent,
        0.0,
    );

    assert_eq!(without_history.index, 0);
    assert_eq!(with_recent_region.index, 0);
    assert!(with_recent_region.probability < without_history.probability);
    assert!(with_recent_region.probability > 0.0);
}

#[test]
fn audio_style_distributed_field_keeps_recent_liked_track_from_becoming_attractor() {
    let current = track_in_basin("Current", "current");
    let mut liked_recent = track_in_basin("Current", "liked_recent");
    liked_recent.liked = true;
    let open_region = track_in_basin("Open", "open_region");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (liked_recent.clone(), embedding(2)),
        (open_region.clone(), embedding(2)),
    ]);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[liked_recent.clone(), open_region.clone()],
        &recommender,
        std::slice::from_ref(&liked_recent),
        0.60,
    );

    assert_eq!(selection.index, 1);
    assert!(
        selection.probability > selection.uniform_probability,
        "open candidate should remain a real style-continuity choice"
    );
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
fn audio_style_embedding_cache_open_does_not_scan_or_remove_stale_versions() {
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
        .expect("cache should open without scanning stale embeddings");

    assert!(stale_path.exists());
    assert!(current_path.exists());
    assert!(other_path.exists());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn audio_style_embedding_cache_cleanup_removes_stale_versions_when_explicitly_run() {
    let root = temp_cache_root("explicit-cleanup");
    std::fs::create_dir_all(&root).expect("cache test root should be created");
    let stale_path = root.join("stale.json");
    let current_path = root.join("current.json");
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

    super::recommendation::cleanup_stale_audio_style_embedding_cache(&root)
        .expect("explicit cache cleanup should succeed");

    assert!(!stale_path.exists());
    assert!(current_path.exists());

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
fn audio_style_centerless_initial_selection_uses_trained_geometry_without_anchor() {
    let dense = track("dense");
    let open = track("open");
    let other = track("other");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (dense.clone(), dense_embedding(&[(0, 1.0)])),
        (open.clone(), dense_embedding(&[(1, 1.0)])),
        (other.clone(), dense_embedding(&[(1, 0.95), (2, 0.31225)])),
    ]);

    let selection = choose_centerless_audio_style_candidate_for_test(
        &[dense.clone(), open.clone(), other.clone()],
        &recommender,
        0.0,
    );

    assert_eq!(selection.source.as_str(), "audio_style");
    assert_eq!(selection.reason, Some("centerless_initial"));
    assert!(selection.diagnostics.embedded_candidate_count >= 3);
    assert!(selection.similarity.is_some());
}

#[test]
fn audio_style_centerless_initial_selection_does_not_select_unembedded_candidate() {
    let missing = track("missing");
    let embedded = track("embedded");
    let embedded_other = track("embedded_other");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (embedded.clone(), dense_embedding(&[(1, 1.0)])),
        (embedded_other.clone(), dense_embedding(&[(2, 1.0)])),
    ]);

    let selection = choose_centerless_audio_style_candidate_for_test(
        &[missing.clone(), embedded.clone(), embedded_other.clone()],
        &recommender,
        0.0,
    );

    assert_eq!(selection.source.as_str(), "audio_style");
    assert_eq!(selection.reason, Some("centerless_initial"));
    assert_ne!(selection.index, 0);
    assert_eq!(selection.diagnostics.embedded_candidate_count, 2);
}

#[test]
fn audio_style_centerless_source_is_selected_inside_requested_scope() {
    let outside = track("outside");
    let inside = track("inside");
    let source_inside = "source:inside".to_string();
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_indexed_embeddings([
        (
            outside.clone(),
            dense_embedding(&[(0, 1.0)]),
            "source:outside".to_string(),
        ),
        (
            inside.clone(),
            dense_embedding(&[(1, 1.0)]),
            source_inside.clone(),
        ),
    ]);

    let (source, selection) = recommender
        .propose_centerless_source(|source| source.collection_folder == source_inside)
        .expect("scoped centerless source should be selected");

    assert_eq!(source.collection_folder, source_inside);
    assert_eq!(selection.candidate_count, 1);
    assert_eq!(selection.source.as_str(), "audio_style");
}

#[test]
fn audio_style_centerless_source_ignores_scoped_tracks_without_embeddings() {
    let missing = track("missing");
    let embedded = track("embedded");
    let embedded_other = track("embedded_other");
    let source_inside = "source:inside".to_string();
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_indexed_embeddings([
        (
            embedded.clone(),
            dense_embedding(&[(1, 1.0)]),
            source_inside.clone(),
        ),
        (
            embedded_other.clone(),
            dense_embedding(&[(2, 1.0)]),
            source_inside.clone(),
        ),
    ]);

    let (source, selection) = recommender
        .propose_centerless_source(|source| {
            source.collection_folder == source_inside || source.music.alias == missing.music_name
        })
        .expect("embedded scoped centerless source should be selected");

    assert_ne!(source.music.alias, missing.music_name);
    assert_eq!(selection.candidate_count, 2);
    assert_eq!(selection.source.as_str(), "audio_style");
}

#[test]
fn restored_audio_style_model_evidence_does_not_restore_indexed_sources() {
    let root = temp_cache_root("model-evidence-no-source");
    std::fs::create_dir_all(&root).expect("cache test root should be created");
    let path = root.join("stable.json");
    let old_source = "source:old".to_string();
    let old_track = track("old");
    let snapshot = AudioStyleModelSnapshot::from_test_indexed_embeddings(
        11,
        [(
            old_track.clone(),
            dense_embedding(&[(1, 1.0)]),
            old_source.clone(),
        )],
    );
    let (before_source, _) = snapshot
        .recommender()
        .propose_centerless_source(|source| source.collection_folder == old_source)
        .expect("indexed setup should produce an old source before persistence");
    assert_eq!(before_source.collection_folder, old_source);

    write_cached_audio_style_model_evidence_for_test(&path, &snapshot)
        .expect("model evidence should be written");
    let restored = read_cached_audio_style_model_evidence_for_test(&path)
        .expect("model evidence should be restored");

    assert_eq!(restored.generation(), 11);
    assert!(restored.recommender().has_embedding_for(&old_track));
    assert!(
        restored
            .recommender()
            .propose_centerless_source(|_| true)
            .is_none(),
        "restored model evidence must not manufacture playlist sources"
    );
}

#[test]
fn restored_audio_style_model_evidence_ranks_current_candidate_tracks() {
    let root = temp_cache_root("model-evidence-candidates");
    std::fs::create_dir_all(&root).expect("cache test root should be created");
    let path = root.join("stable.json");
    let current_candidate = track("current_candidate");
    let other_candidate = track("other_candidate");
    let missing_candidate = track("missing_candidate");
    let snapshot = AudioStyleModelSnapshot::from_test_embeddings(
        12,
        [
            (current_candidate.clone(), dense_embedding(&[(2, 1.0)])),
            (other_candidate.clone(), dense_embedding(&[(3, 1.0)])),
        ],
    );
    write_cached_audio_style_model_evidence_for_test(&path, &snapshot)
        .expect("model evidence should be written");
    let restored = read_cached_audio_style_model_evidence_for_test(&path)
        .expect("model evidence should be restored");

    let (source, selected_track, selection) = restored
        .recommender()
        .propose_centerless_source_from_tracks(vec![
            (
                source_from_track("current", &current_candidate),
                current_candidate.clone(),
            ),
            (
                source_from_track("other", &other_candidate),
                other_candidate,
            ),
            (
                source_from_track("missing", &missing_candidate),
                missing_candidate.clone(),
            ),
        ])
        .expect("restored evidence should rank embedded current candidates");

    assert_ne!(source.collection_folder, "missing");
    assert_ne!(selected_track.music_url, missing_candidate.music_url);
    assert_eq!(selection.candidate_count, 2);
    assert_eq!(selection.diagnostics.embedded_candidate_count, 2);
}

#[test]
fn restored_audio_style_model_evidence_preserves_measured_loudness_pressure() {
    let root = temp_cache_root("model-evidence-loudness");
    std::fs::create_dir_all(&root).expect("cache test root should be created");
    let path = root.join("stable.json");
    let current = track_with_loudness(
        "current",
        loudness_profile(-18.0, -18.5, -17.0, -15.0, -14.5, -10.0, 8.0),
    );
    let played_hot = track_with_loudness(
        "played_hot",
        loudness_profile(-8.0, -8.5, -7.0, -5.5, -5.0, -5.0, 4.0),
    );
    let hot_candidate = track_with_loudness(
        "hot_candidate",
        loudness_profile(-7.5, -8.0, -6.8, -5.2, -4.9, -4.8, 4.0),
    );
    let calm_candidate = track_with_loudness(
        "calm_candidate",
        loudness_profile(-22.0, -23.0, -21.0, -19.0, -18.5, -13.0, 10.0),
    );
    let snapshot = AudioStyleModelSnapshot::from_test_indexed_embeddings(
        13,
        [
            (current.clone(), embedding(2), "source".to_string()),
            (played_hot.clone(), embedding(2), "source".to_string()),
            (hot_candidate.clone(), embedding(2), "source".to_string()),
            (calm_candidate.clone(), embedding(2), "source".to_string()),
        ],
    );
    write_cached_audio_style_model_evidence_for_test(&path, &snapshot)
        .expect("model evidence should be written");
    let restored = read_cached_audio_style_model_evidence_for_test(&path)
        .expect("model evidence should be restored");

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[hot_candidate, calm_candidate],
        restored.recommender(),
        std::slice::from_ref(&played_hot),
        0.0,
    );

    assert_eq!(restored.generation(), 13);
    assert_eq!(selection.source.as_str(), "audio_style");
    assert_eq!(selection.index, 0);
    assert!(selection.probability > 0.0);
    assert!(selection.probability < 0.5);
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
fn audio_style_model_refresh_reuses_cached_embeddings_without_progressive_training() {
    let root = temp_cache_root("refresh_cached_no_progress");
    std::fs::create_dir_all(&root).expect("cache test root should be created");
    let cache = AudioStyleEmbeddingCache::new(PathBuf::from("missing-ffmpeg"), root.clone())
        .expect("cache should be created without ffmpeg");
    let mut current = track("current");
    let mut added_one = track("added_one");
    let mut added_two = track("added_two");
    current.file_path = root.join("current.m4a");
    added_one.file_path = root.join("added_one.m4a");
    added_two.file_path = root.join("added_two.m4a");
    std::fs::write(&current.file_path, b"current").expect("current test audio should exist");
    std::fs::write(&added_one.file_path, b"added_one").expect("first test audio should exist");
    std::fs::write(&added_two.file_path, b"added_two").expect("second test audio should exist");

    let previous =
        AudioStyleModelSnapshot::from_test_embeddings(1, [(current.clone(), embedding(2))]);
    cache
        .write_test_embedding_for_track(&added_one, embedding(3))
        .expect("first new embedding should be cached");
    cache
        .write_test_embedding_for_track(&added_two, embedding(4))
        .expect("second new embedding should be cached");

    let snapshot = AudioStyleModelSnapshot::refresh_from_indexed_tracks_for_test(
        2,
        Some(&previous),
        &cache,
        vec![current.clone(), added_one.clone(), added_two.clone()],
    )
    .expect("refresh should reuse cache-backed embeddings without training progress");

    assert_eq!(snapshot.generation(), 2);
    assert!(snapshot.recommender().has_embedding_for(&current));
    assert!(snapshot.recommender().has_embedding_for(&added_one));
    assert!(snapshot.recommender().has_embedding_for(&added_two));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn audio_style_model_refresh_keeps_previous_snapshot_when_inputs_are_unchanged() {
    let root = temp_cache_root("refresh_unchanged");
    std::fs::create_dir_all(&root).expect("cache test root should be created");
    let cache = AudioStyleEmbeddingCache::new(PathBuf::from("missing-ffmpeg"), root.clone())
        .expect("cache should be created without ffmpeg");
    let mut current = track("current");
    let mut other = track("other");
    current.file_path = root.join("current.m4a");
    other.file_path = root.join("other.m4a");
    std::fs::write(&current.file_path, b"current").expect("current test audio should exist");
    std::fs::write(&other.file_path, b"other").expect("other test audio should exist");

    let previous = AudioStyleModelSnapshot::from_test_indexed_embeddings(
        7,
        [
            (current.clone(), embedding(2), "album".to_string()),
            (other.clone(), embedding(3), "album".to_string()),
        ],
    );

    let refreshed = AudioStyleModelSnapshot::refresh_from_indexed_tracks_for_test(
        8,
        Some(&previous),
        &cache,
        vec![current.clone(), other.clone()],
    )
    .expect("unchanged refresh should keep the previous snapshot");

    assert_eq!(refreshed.generation(), 7);
    assert!(refreshed.recommender().has_embedding_for(&current));
    assert!(refreshed.recommender().has_embedding_for(&other));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn audio_style_model_refresh_updates_when_loudness_profile_changes() {
    let root = temp_cache_root("refresh_loudness_changed");
    std::fs::create_dir_all(&root).expect("cache test root should be created");
    let cache = AudioStyleEmbeddingCache::new(PathBuf::from("missing-ffmpeg"), root.clone())
        .expect("cache should be created without ffmpeg");
    let mut current = track("current");
    current.file_path = root.join("current.m4a");
    current.loudness_profile = LoudnessProfile::from_integrated_lufs(-18.0);
    std::fs::write(&current.file_path, b"current").expect("current test audio should exist");

    let previous = AudioStyleModelSnapshot::from_test_indexed_embeddings(
        7,
        [(current.clone(), embedding(2), "album".to_string())],
    );
    let mut changed = current.clone();
    changed.loudness_profile = LoudnessProfile::from_integrated_lufs(-12.0);

    let refreshed = AudioStyleModelSnapshot::refresh_from_indexed_tracks_for_test(
        8,
        Some(&previous),
        &cache,
        vec![changed.clone()],
    )
    .expect("loudness changes should publish a new snapshot");

    assert_eq!(refreshed.generation(), 8);
    assert!(refreshed.recommender().has_embedding_for(&changed));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn audio_style_model_refresh_uses_cache_evidence_without_previous_snapshot() {
    let root = temp_cache_root("refresh_cache_no_previous");
    std::fs::create_dir_all(&root).expect("cache test root should be created");
    let cache = AudioStyleEmbeddingCache::new(PathBuf::from("missing-ffmpeg"), root.clone())
        .expect("cache should be created without ffmpeg");
    let mut first = track("first");
    let mut second = track("second");
    let mut third = track("third");
    first.file_path = root.join("first.m4a");
    second.file_path = root.join("second.m4a");
    third.file_path = root.join("third.m4a");
    std::fs::write(&first.file_path, b"first").expect("first test audio should exist");
    std::fs::write(&second.file_path, b"second").expect("second test audio should exist");
    std::fs::write(&third.file_path, b"third").expect("third test audio should exist");
    cache
        .write_test_embedding_for_track(&first, embedding(2))
        .expect("first embedding should be cached");
    cache
        .write_test_embedding_for_track(&second, embedding(3))
        .expect("second embedding should be cached");
    cache
        .write_test_embedding_for_track(&third, embedding(4))
        .expect("third embedding should be cached");

    let snapshot = AudioStyleModelSnapshot::refresh_from_indexed_tracks_for_test(
        2,
        None,
        &cache,
        vec![first.clone(), second.clone(), third.clone()],
    )
    .expect("refresh should restore cache evidence without requiring model evidence");

    assert_eq!(snapshot.generation(), 2);
    assert!(snapshot.recommender().has_embedding_for(&first));
    assert!(snapshot.recommender().has_embedding_for(&second));
    assert!(snapshot.recommender().has_embedding_for(&third));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn audio_style_training_path_rejects_transient_download_outputs() {
    assert!(audio_style_training_path_is_transient_for_test(
        &PathBuf::from("track.m4a.part")
    ));
    assert!(audio_style_training_path_is_transient_for_test(
        &PathBuf::from("track.__slisic_tmp__abc.m4a")
    ));
    assert!(audio_style_training_path_is_transient_for_test(
        &PathBuf::from("cache.tmp")
    ));
    assert!(!audio_style_training_path_is_transient_for_test(
        &PathBuf::from("track.m4a")
    ));
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
fn trained_audio_style_snapshot_does_not_promote_liked_tail_candidate() {
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
        &[best, liked_tail.clone(), low],
        snapshot.recommender(),
        0.995,
        Some(snapshot.generation()),
    );

    assert_eq!(selection.index, 0);
    assert_eq!(selection.model_generation, Some(9));
    assert_ne!(
        selection.index, 1,
        "liked status must not add a sampling bonus over distance and flow pressure"
    );
    assert!(
        selection
            .local_rank_fraction
            .is_some_and(|rank| rank <= 0.5)
    );
}

#[test]
fn audio_style_selection_reports_embedding_and_basin_coverage() {
    let current = track_in_basin("Current", "current");
    let zwei = track_in_basin("ZWEI2", "zwei");
    let tenet = track_in_basin("TENET", "tenet");
    let death_stranding = track_in_basin("Death Stranding", "death_stranding");
    let snapshot = AudioStyleModelSnapshot::from_test_embeddings(
        10,
        [
            (current.clone(), embedding(0)),
            (zwei.clone(), embedding(1)),
            (death_stranding.clone(), embedding(2)),
        ],
    );

    let selection = choose_next_audio_style_candidate_with_generation_for_test(
        &current,
        &[zwei, tenet, death_stranding],
        snapshot.recommender(),
        0.4,
        Some(snapshot.generation()),
    );

    assert!(selection.diagnostics.anchor_embedded);
    assert_eq!(selection.candidate_count, 3);
    assert_eq!(selection.diagnostics.embedded_candidate_count, 2);
    assert_eq!(selection.diagnostics.valid_similarity_count, 2);
    assert!(selection.diagnostics.selected_basin.is_some());

    let basin = selection
        .diagnostics
        .top_candidate_basins
        .iter()
        .find(|basin| basin.basin == "youtube:tenet")
        .expect("TENET basin should be visible even without an embedding");
    assert_eq!(basin.candidate_count, 1);
    assert_eq!(basin.embedded_candidate_count, 0);
}

#[test]
fn audio_style_random_fallback_reports_candidate_coverage() {
    let current = track_in_basin("Current", "current");
    let zwei = track_in_basin("ZWEI2", "zwei");
    let tenet = track_in_basin("TENET", "tenet");
    let snapshot =
        AudioStyleModelSnapshot::from_test_embeddings(11, [(zwei.clone(), embedding(1))]);

    let selection = choose_next_audio_style_candidate_with_generation_for_test(
        &current,
        &[zwei, tenet],
        snapshot.recommender(),
        0.8,
        Some(snapshot.generation()),
    );

    assert_eq!(
        selection.source,
        super::recommendation::AudioStyleCandidateSelectionSource::RandomFallback
    );
    assert_eq!(selection.reason, Some("missing_anchor_embedding"));
    assert!(!selection.diagnostics.anchor_embedded);
    assert_eq!(selection.diagnostics.embedded_candidate_count, 1);
    assert_eq!(selection.diagnostics.valid_similarity_count, 0);
    assert!(selection.diagnostics.selected_basin.is_some());
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
    let new = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        2,
        [
            (current.clone(), embedding(2)),
            (near.clone(), embedding(128)),
            (far.clone(), embedding(2)),
        ],
    ));
    let published = new;

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
fn audio_style_snapshot_selection_uses_latest_model_that_contains_the_current_anchor() {
    let current = track("current");
    let old_neighbor = track("old_neighbor");
    let new_only = track("new_only");
    let old = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        10,
        [
            (current.clone(), embedding(2)),
            (old_neighbor, embedding(3)),
        ],
    ));
    let latest = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        11,
        [(new_only, embedding(4))],
    ));

    let selected =
        choose_audio_style_model_snapshots_for_anchor(&current, [latest.clone(), old.clone()])
            .into_iter()
            .next()
            .expect("old completed model should serve while the latest model lacks the anchor");

    assert_eq!(selected.generation(), old.generation());
}

#[test]
fn audio_style_snapshot_selection_prefers_latest_model_when_it_contains_the_current_anchor() {
    let current = track("current");
    let old = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        10,
        [(current.clone(), embedding(2))],
    ));
    let latest = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        11,
        [(current.clone(), embedding(4))],
    ));

    let selected =
        choose_audio_style_model_snapshots_for_anchor(&current, [old.clone(), latest.clone()])
            .into_iter()
            .next()
            .expect("latest matching model should be selected");

    assert_eq!(selected.generation(), latest.generation());
}

#[test]
fn audio_style_snapshot_selection_returns_matching_models_from_latest_to_oldest() {
    let current = track("current");
    let ignored = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        12,
        [(track("ignored"), embedding(8))],
    ));
    let older = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        10,
        [(current.clone(), embedding(2))],
    ));
    let newer = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        11,
        [(current.clone(), embedding(4))],
    ));

    let generations = choose_audio_style_model_snapshots_for_anchor(
        &current,
        [older.clone(), ignored, newer.clone()],
    )
    .into_iter()
    .map(|snapshot| snapshot.generation())
    .collect::<Vec<_>>();

    assert_eq!(generations, vec![newer.generation(), older.generation()]);
}

#[test]
fn audio_style_snapshot_selection_keeps_latest_for_centerless_when_anchor_is_missing() {
    let current = track("current");
    let latest = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        12,
        [(track("latest"), embedding(8))],
    ));
    let older = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        10,
        [(track("older"), embedding(2))],
    ));

    let generations =
        choose_audio_style_model_snapshots_for_anchor(&current, [older.clone(), latest.clone()])
            .into_iter()
            .map(|snapshot| snapshot.generation())
            .collect::<Vec<_>>();

    assert_eq!(generations, vec![latest.generation(), older.generation()]);
}

#[test]
fn stable_audio_style_snapshot_replacement_accepts_only_newer_generations() {
    let current = track("current");
    let stable =
        AudioStyleModelSnapshot::from_test_embeddings(10, [(current.clone(), embedding(2))]);
    let older_candidate =
        AudioStyleModelSnapshot::from_test_embeddings(9, [(current.clone(), embedding(3))]);
    let same_candidate =
        AudioStyleModelSnapshot::from_test_embeddings(10, [(current.clone(), embedding(4))]);
    let newer_candidate =
        AudioStyleModelSnapshot::from_test_embeddings(11, [(current, embedding(5))]);

    assert!(!super::recommendation::should_replace_stable_snapshot(
        Some(&stable),
        &older_candidate,
    ));
    assert!(!super::recommendation::should_replace_stable_snapshot(
        Some(&stable),
        &same_candidate,
    ));
    assert!(super::recommendation::should_replace_stable_snapshot(
        Some(&stable),
        &newer_candidate,
    ));
    assert!(super::recommendation::should_replace_stable_snapshot(
        None,
        &older_candidate,
    ));
}

#[test]
fn stable_audio_style_snapshot_publication_refreshes_first_slot_only_on_availability_edges() {
    use super::recommendation::{
        StableSnapshotPublicationReason, stable_snapshot_publication_requests_first_slot_refresh,
    };

    assert!(stable_snapshot_publication_requests_first_slot_refresh(
        StableSnapshotPublicationReason::TrainingComplete,
        false,
    ));
    assert!(stable_snapshot_publication_requests_first_slot_refresh(
        StableSnapshotPublicationReason::TrainingComplete,
        true,
    ));
    assert!(stable_snapshot_publication_requests_first_slot_refresh(
        StableSnapshotPublicationReason::StartupEvidence,
        false,
    ));
    assert!(!stable_snapshot_publication_requests_first_slot_refresh(
        StableSnapshotPublicationReason::StartupEvidence,
        true,
    ));
}

#[test]
fn audio_style_startup_skips_training_when_model_evidence_restores_without_input_changes() {
    use super::recommendation::{
        AudioStyleStartupTrainingDecision, audio_style_startup_training_decision,
    };

    assert_eq!(
        audio_style_startup_training_decision(true, 0),
        AudioStyleStartupTrainingDecision::SkipRestoredEvidence
    );
    assert_eq!(
        audio_style_startup_training_decision(false, 0),
        AudioStyleStartupTrainingDecision::TrainInitialModel
    );
    assert_eq!(
        audio_style_startup_training_decision(true, 2),
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges
    );
    assert_eq!(
        audio_style_startup_training_decision(false, 2),
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges
    );
}

#[test]
fn audio_style_training_worker_count_scales_with_hardware_profile_and_task_count() {
    assert_eq!(
        super::recommendation::audio_style_training_worker_count_for_test(0, 64, true, 2),
        0
    );
    assert_eq!(
        super::recommendation::audio_style_training_worker_count_for_test(4, 64, true, 2),
        4
    );
    assert_eq!(
        super::recommendation::audio_style_training_worker_count_for_test(64, 12, false, 0),
        12
    );
    assert_eq!(
        super::recommendation::audio_style_training_worker_count_for_test(64, 12, true, 0),
        12
    );
    let single_hardware =
        super::recommendation::audio_style_training_worker_count_for_test(64, 12, true, 1);
    let dual_large_hardware =
        super::recommendation::audio_style_training_worker_count_for_test(64, 12, true, 2);
    let quad_large_hardware =
        super::recommendation::audio_style_training_worker_count_for_test(64, 12, true, 4);
    assert!(
        single_hardware
            > super::recommendation::audio_style_training_worker_count_for_test(64, 12, false, 0)
    );
    assert_eq!(single_hardware, 13);
    assert_eq!(dual_large_hardware, 14);
    assert_eq!(quad_large_hardware, 14);
    assert_eq!(
        super::recommendation::audio_style_training_worker_count_for_test(20, 64, true, 2),
        dual_large_hardware
    );
    assert_eq!(quad_large_hardware, 14);
}

#[test]
fn audio_style_hardware_budget_tiles_large_similarity_grids_before_cpu_fallback() {
    let single_gpu_grid =
        super::recommendation::audio_style_hardware_similarity_grid_tile_shape_for_test(
            4096, 4096, 1,
        );
    let dual_gpu_grid =
        super::recommendation::audio_style_hardware_similarity_grid_tile_shape_for_test(
            4096, 4096, 2,
        );

    let single_gpu_grid = single_gpu_grid.expect("single gpu should still use hardware tiles");
    let dual_gpu_grid = dual_gpu_grid.expect("dual gpu should still use hardware tiles");

    assert!(single_gpu_grid.0 < 4096 || single_gpu_grid.1 < 4096);
    assert_eq!(dual_gpu_grid, single_gpu_grid);
}

#[test]
fn audio_style_hardware_op_gate_falls_back_when_busy_or_cooling_down() {
    super::recommendation::reset_audio_style_hardware_op_gate_for_test();
    let held = super::recommendation::hold_audio_style_hardware_op_for_test()
        .expect("first hardware operation should acquire the gate");

    assert!(
        !super::recommendation::acquire_audio_style_hardware_op_for_test(),
        "a second operation must fall back instead of queueing more GPU work"
    );
    drop(held);
    assert!(super::recommendation::acquire_audio_style_hardware_op_for_test());

    super::recommendation::reset_audio_style_hardware_op_gate_for_test();
    super::recommendation::enter_audio_style_hardware_op_cooldown_for_test();
    assert!(
        !super::recommendation::acquire_audio_style_hardware_op_for_test(),
        "after a hardware failure, background work must cool down before trying the GPU again"
    );
    super::recommendation::reset_audio_style_hardware_op_gate_for_test();
}

#[test]
fn audio_style_tensor_runtime_profile_owns_actual_tensor_devices() {
    let (backend, device_count, source) =
        super::recommendation::audio_style_tensor_runtime_profile_for_test(2);

    assert_eq!(backend, "hardware");
    assert_eq!(device_count, 2);
    assert_eq!(source, "test_discrete_gpu");

    let (backend, device_count, source) =
        super::recommendation::audio_style_tensor_runtime_profile_for_test(0);
    assert_eq!(backend, "cpu");
    assert_eq!(device_count, 0);
    assert_eq!(source, "test_cpu");
}

#[test]
fn audio_style_tensor_runtime_defaults_to_hardware() {
    assert_eq!(
        super::recommendation::audio_style_tensor_runtime_preference_for_test(None, None),
        ("hardware", "hardware_default")
    );
    assert_eq!(
        super::recommendation::audio_style_tensor_runtime_profile_from_preference_for_test(
            None, None
        ),
        ("hardware", 1, "hardware_default")
    );
}

#[test]
fn audio_style_tensor_runtime_hardware_env_keeps_hardware_source() {
    assert_eq!(
        super::recommendation::audio_style_tensor_runtime_preference_for_test(Some("wgpu"), None),
        ("hardware", "tensor_backend_env_hardware")
    );
    assert_eq!(
        super::recommendation::audio_style_tensor_runtime_profile_from_preference_for_test(
            Some("hardware"),
            None
        ),
        ("hardware", 1, "tensor_backend_env_hardware")
    );
    assert_eq!(
        super::recommendation::audio_style_tensor_runtime_preference_for_test(
            None,
            Some("DiscreteGpu(0)")
        ),
        ("hardware", "wgpu_env_hardware")
    );
}

#[test]
fn audio_style_tensor_runtime_cpu_override_wins_over_wgpu_device_env() {
    assert_eq!(
        super::recommendation::audio_style_tensor_runtime_preference_for_test(
            Some("cpu"),
            Some("DiscreteGpu(0)")
        ),
        ("cpu", "tensor_backend_env_cpu")
    );
    assert_eq!(
        super::recommendation::audio_style_tensor_runtime_preference_for_test(None, Some("Cpu")),
        ("cpu", "wgpu_env_cpu")
    );
}

#[test]
fn audio_style_wgpu_device_override_parser_accepts_portable_device_kinds() {
    assert_eq!(
        super::recommendation::parse_audio_style_wgpu_device_for_test("DiscreteGpu(2)").as_deref(),
        Some("DiscreteGpu(2)")
    );
    assert_eq!(
        super::recommendation::parse_audio_style_wgpu_device_for_test("IntegratedGpu(1)")
            .as_deref(),
        Some("IntegratedGpu(1)")
    );
    assert_eq!(
        super::recommendation::parse_audio_style_wgpu_device_for_test("VirtualGpu(0)").as_deref(),
        Some("VirtualGpu(0)")
    );
    assert_eq!(
        super::recommendation::parse_audio_style_wgpu_device_for_test("Cpu").as_deref(),
        Some("Cpu")
    );
    assert_eq!(
        super::recommendation::parse_audio_style_wgpu_device_for_test("DefaultDevice").as_deref(),
        Some("DefaultDevice")
    );
    assert!(super::recommendation::parse_audio_style_wgpu_device_for_test("RTX4090").is_none());
}

#[test]
fn audio_style_wgpu_hardware_candidates_prefer_accelerators_before_cpu() {
    assert_eq!(
        super::recommendation::sort_audio_style_wgpu_devices_for_test(&[
            "Cpu",
            "IntegratedGpu(0)",
            "DiscreteGpu(1)",
            "VirtualGpu(0)",
            "DiscreteGpu(0)",
            "DefaultDevice",
        ]),
        vec![
            "DiscreteGpu(0)",
            "DiscreteGpu(1)",
            "IntegratedGpu(0)",
            "VirtualGpu(0)",
            "DefaultDevice",
            "Cpu",
        ]
    );
}

#[test]
fn audio_style_hardware_runtime_pool_keeps_one_selected_device() {
    assert_eq!(
        super::recommendation::bound_audio_style_hardware_device_pool_for_test(&[
            "DiscreteGpu(0)",
            "DiscreteGpu(1)",
            "IntegratedGpu(0)",
        ]),
        vec!["DiscreteGpu(0)"]
    );
    assert_eq!(
        super::recommendation::bound_audio_style_hardware_device_pool_for_test(&[
            "IntegratedGpu(0)",
            "VirtualGpu(0)",
        ]),
        vec!["IntegratedGpu(0)"]
    );
}

#[test]
fn audio_style_hardware_cleanup_logs_only_unhealthy_or_slow_cleanup() {
    assert!(
        !super::recommendation::audio_style_hardware_cleanup_should_log_for_test(true, true, 0,)
    );
    assert!(
        super::recommendation::audio_style_hardware_cleanup_should_log_for_test(false, true, 0,)
    );
    assert!(
        super::recommendation::audio_style_hardware_cleanup_should_log_for_test(true, false, 0,)
    );
    assert!(
        super::recommendation::audio_style_hardware_cleanup_should_log_for_test(true, true, 50,)
    );
}

#[test]
fn audio_style_wgpu_hardware_enumeration_roots_exclude_default_device() {
    assert_eq!(
        super::recommendation::audio_style_wgpu_hardware_device_enumeration_roots_for_test(),
        vec!["DiscreteGpu(0)", "IntegratedGpu(0)", "VirtualGpu(0)"]
    );
}

#[test]
fn audio_style_transition_fingerprint_preserves_spectral_style_neighborhood() {
    let base = audio_style_transition_fingerprint_for_test(&sine_wave(220.0, 8.0));
    let near = audio_style_transition_fingerprint_for_test(&sine_wave(224.0, 8.0));
    let far = audio_style_transition_fingerprint_for_test(&sine_wave(880.0, 8.0));

    assert_eq!(base.len(), TEST_EMBEDDING_WIDTH);
    assert!(cosine(&base, &near) > cosine(&base, &far));
}
