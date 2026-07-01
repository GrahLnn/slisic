use super::recommendation::{
    AUDIO_STYLE_EMBEDDING_VERSION_FOR_TEST, AudioStyleEmbeddingCache, AudioStyleModelSnapshot,
    AudioStylePlaylistPlaybackRecommender,
    acknowledge_audio_style_pending_training_input_file_for_test,
    audio_style_agreement_aware_continuity_for_test, audio_style_alternative_route_gate_for_test,
    audio_style_semantic_continuity_gate_for_test, audio_style_source_repetition_gate_for_test,
    audio_style_stream_continuation_gate_for_test,
    audio_style_training_inputs_covered_by_snapshot_for_test,
    audio_style_training_path_is_transient_for_test, audio_style_transition_fingerprint_for_test,
    balance_audio_style_candidate_field_basins_for_test,
    choose_audio_style_model_snapshots_for_anchor,
    choose_centerless_audio_style_candidate_for_test, choose_next_audio_style_candidate_for_test,
    choose_next_audio_style_candidate_with_generation_for_test,
    choose_next_audio_style_candidate_with_recent_history_for_test,
    filter_recently_played_recommendation_candidates,
    read_audio_style_pending_training_input_file_for_test, read_audio_style_stable_model_for_test,
    upsert_audio_style_pending_training_input_file_for_test,
    write_audio_style_stable_model_for_test,
};
use crate::domain::player::model::PlaybackTrack;
use crate::domain::playlists::model::{
    AudioStyleTrainingTrackInput, CollectionGroupOwner, Group, LoudnessProfile, Music,
};
use crate::domain::playlists::repo::PlaylistPlaybackTrackSource;
use std::collections::HashMap;
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

fn track_in_source(source: &str, name: &str) -> PlaybackTrack {
    PlaybackTrack {
        file_path: PathBuf::from(format!("youtube/{source}/{name}.m4a")),
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

fn nearby_open_basin_embedding() -> Vec<f32> {
    dense_embedding(&[(2, 0.90), (128, 0.435_889_9)])
}

fn basin_neighbor_embedding() -> Vec<f32> {
    dense_embedding(&[(2, 0.995), (129, 0.099_874_92)])
}

fn listener_load_embedding(
    terminal_bin: usize,
    delta_bin: usize,
    flow_bin: usize,
    transition: (usize, usize),
    support: f32,
) -> Vec<f32> {
    let terminal_offset = terminal_bin.min(63);
    let delta_offset = 64 + delta_bin.min(63);
    let flow_outgoing_offset = 128 + flow_bin.min(63);
    let flow_incoming_offset = 128 + 64 + flow_bin.min(63);
    let transition_offset = 256 + transition.0.min(63) * 64 + transition.1.min(63);
    dense_embedding(&[
        (terminal_offset, 0.60),
        (delta_offset, 0.32),
        (flow_outgoing_offset, 0.34),
        (flow_incoming_offset, 0.34),
        (transition_offset, support),
    ])
}

fn audio_style_selection_share(
    current: &PlaybackTrack,
    candidates: &[PlaybackTrack],
    recommender: &AudioStylePlaylistPlaybackRecommender,
    recently_played_tracks: &[PlaybackTrack],
    selected_index: usize,
) -> f32 {
    let samples = 200usize;
    let hits = (0..samples)
        .filter(|draw_index| {
            let draw = (*draw_index as f32 + 0.5) / samples as f32;
            choose_next_audio_style_candidate_with_recent_history_for_test(
                current,
                candidates,
                recommender,
                recently_played_tracks,
                draw,
            )
            .index
                == selected_index
        })
        .count();
    hits as f32 / samples as f32
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
    let played_d = track_in_basin("Kurzgesagt", "played_d");
    let played_e = track_in_basin("Kurzgesagt", "played_e");
    let played_f = track_in_basin("Kurzgesagt", "played_f");
    let played_g = track_in_basin("Kurzgesagt", "played_g");
    let same_basin = track_in_basin("Kurzgesagt", "same_basin");
    let other_basin = track_in_basin("ZWEI2", "other_basin");
    let other_basin_neighbor = track_in_basin("ZWEI2", "other_basin_neighbor");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (played_a.clone(), basin_neighbor_embedding()),
        (played_b.clone(), basin_neighbor_embedding()),
        (played_c.clone(), basin_neighbor_embedding()),
        (played_d.clone(), basin_neighbor_embedding()),
        (played_e.clone(), basin_neighbor_embedding()),
        (played_f.clone(), basin_neighbor_embedding()),
        (played_g.clone(), basin_neighbor_embedding()),
        (same_basin.clone(), embedding(2)),
        (other_basin.clone(), nearby_open_basin_embedding()),
        (other_basin_neighbor, nearby_open_basin_embedding()),
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
        &[played_a.clone(), played_b.clone(), played_c.clone()],
        0.55,
    );
    let with_mature_pressure = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_basin.clone(), other_basin.clone()],
        &recommender,
        &[played_a, played_b, played_c, played_d, played_e, played_f, played_g],
        0.55,
    );

    assert_eq!(without_pressure.index, 0);
    assert_eq!(with_pressure.index, 0);
    assert!(with_pressure.probability < without_pressure.probability);
    assert_eq!(with_mature_pressure.index, 1);
    assert!(with_mature_pressure.probability > with_mature_pressure.uniform_probability);
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
fn audio_style_stream_continuation_is_adaptive_not_fixed_run_length() {
    let unsupported =
        audio_style_stream_continuation_gate_for_test(2, 1.0, 0.12, 0.18, 1, 8, 0.62, 0.90);
    let supported =
        audio_style_stream_continuation_gate_for_test(2, 1.0, 0.12, 0.18, 4, 2, 0.76, 0.72);
    let supported_after_three =
        audio_style_stream_continuation_gate_for_test(4, 1.1, 0.16, 0.18, 5, 1, 0.82, 0.65);
    let overused =
        audio_style_stream_continuation_gate_for_test(8, 4.0, 0.42, 0.18, 4, 2, 0.76, 0.72);

    assert!(unsupported < 1.0);
    assert!(supported > unsupported);
    assert!(supported > 1.0);
    assert!(supported_after_three > 1.0);
    assert!(overused < supported);
    assert!(overused < 1.0);
}

#[test]
fn audio_style_route_field_requires_escape_pressure_before_alternative_capture() {
    let weak_escape =
        audio_style_alternative_route_gate_for_test(1, 1.0, 0.18, 0.40, 0.40, 2, 8, 0.78, 0.74);
    let supported_escape =
        audio_style_alternative_route_gate_for_test(7, 4.0, 0.62, 0.20, 0.44, 2, 8, 0.78, 0.74);

    assert!(weak_escape < 1.0);
    assert!(supported_escape > weak_escape);
    assert!(supported_escape > 1.0);
}

#[test]
fn audio_style_route_field_follows_recent_trajectory_before_style_hopping() {
    let previous = track_in_basin("Current", "previous");
    let current = track_in_basin("Current", "current");
    let along_route = track_in_basin("Current", "along_route");
    let side_jump = track_in_basin("Open", "side_jump");
    let open_neighbor = track_in_basin("Open", "open_neighbor");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (previous.clone(), dense_embedding(&[(0, 1.0)])),
        (current.clone(), dense_embedding(&[(0, 0.92), (1, 0.39)])),
        (
            along_route.clone(),
            dense_embedding(&[(0, 0.78), (1, 0.63)]),
        ),
        (side_jump.clone(), dense_embedding(&[(2, 1.0)])),
        (open_neighbor, dense_embedding(&[(2, 0.98), (3, 0.20)])),
    ]);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[along_route.clone(), side_jump.clone()],
        &recommender,
        &[previous],
        0.62,
    );

    assert_eq!(selection.index, 0);
    assert!(selection.probability > selection.uniform_probability);
    assert!(
        selection
            .diagnostics
            .bio_route
            .is_some_and(|route| route.stream_gate >= 1.0),
        "route field should preserve a coherent same-basin trajectory before style hopping"
    );
}

#[test]
fn audio_style_manifold_field_allows_local_residence_before_escape() {
    let current = track_in_basin("Current", "current");
    let recent = (0..2)
        .map(|index| track_in_basin("Current", &format!("recent_{index}")))
        .collect::<Vec<_>>();
    let same_a = track_in_basin("Current", "same_a");
    let same_b = track_in_basin("Current", "same_b");
    let open = track_in_basin("Open", "open");
    let open_neighbor = track_in_basin("Open", "open_neighbor");
    let mut embeddings = vec![
        (current.clone(), dense_embedding(&[(0, 1.0)])),
        (same_a.clone(), dense_embedding(&[(0, 0.985), (1, 0.172)])),
        (same_b.clone(), dense_embedding(&[(0, 0.975), (2, 0.222)])),
        (open.clone(), dense_embedding(&[(0, 0.970), (128, 0.243)])),
        (
            open_neighbor,
            dense_embedding(&[(0, 0.960), (128, 0.280)]),
        ),
    ];
    embeddings.extend(
        recent
            .iter()
            .cloned()
            .map(|track| (track, dense_embedding(&[(0, 0.980), (3, 0.199)]))),
    );
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_a.clone(), same_b.clone(), open.clone()],
        &recommender,
        &recent,
        0.20,
    );

    assert!(selection.index <= 1);
    assert!(selection.probability > selection.uniform_probability);
}

#[test]
fn audio_style_manifold_field_escapes_mature_boundary_basin_without_far_jump() {
    let current = track_in_basin("Current", "current");
    let recent = (0..8)
        .map(|index| track_in_basin("Current", &format!("recent_{index}")))
        .collect::<Vec<_>>();
    let sticky = track_in_basin("Current", "sticky");
    let boundary = track_in_basin("Boundary", "boundary");
    let boundary_neighbor = track_in_basin("Boundary", "boundary_neighbor");
    let far = track_in_basin("Far", "far");
    let mut embeddings = vec![
        (current.clone(), dense_embedding(&[(0, 1.0)])),
        (sticky.clone(), dense_embedding(&[(0, 0.985), (1, 0.172)])),
        (boundary.clone(), dense_embedding(&[(0, 0.975), (128, 0.222)])),
        (
            boundary_neighbor,
            dense_embedding(&[(0, 0.965), (128, 0.262)]),
        ),
        (far.clone(), embedding(256)),
    ];
    embeddings.extend(
        recent
            .iter()
            .cloned()
            .map(|track| (track, dense_embedding(&[(0, 0.990), (2, 0.141)]))),
    );
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[sticky, boundary.clone(), far],
        &recommender,
        &recent,
        0.52,
    );

    assert_eq!(selection.index, 1);
    assert!(selection.probability > selection.uniform_probability);
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
fn audio_style_source_repetition_gate_penalizes_repeated_collection_without_blacklisting_it() {
    let repeated_candidate = track_in_source("Repeated Work", "repeated_candidate");
    let fresh_candidate = track_in_source("Fresh Work", "fresh_candidate");
    let repeated_history = (0..10)
        .map(|index| track_in_source("Repeated Work", &format!("played_{index}")))
        .collect::<Vec<_>>();

    let gates = audio_style_source_repetition_gate_for_test(
        &[repeated_candidate.clone(), fresh_candidate.clone()],
        &repeated_history,
    );

    assert_eq!(gates.len(), 2);
    assert!(gates[0] < gates[1]);
    assert!(gates[0] > 0.0);
}

#[test]
fn audio_style_sampler_can_leave_repeated_source_when_audio_distance_is_ambiguous() {
    let current = track_in_source("Repeated Work", "current");
    let repeated_candidate = track_in_source("Repeated Work", "repeated_candidate");
    let fresh_candidate = track_in_source("Fresh Work", "fresh_candidate");
    let repeated_history = (0..10)
        .map(|index| track_in_source("Repeated Work", &format!("played_{index}")))
        .collect::<Vec<_>>();
    let mut embeddings = vec![
        (current.clone(), embedding(2)),
        (repeated_candidate.clone(), embedding(2)),
        (fresh_candidate.clone(), embedding(2)),
    ];
    embeddings.extend(
        repeated_history
            .iter()
            .cloned()
            .map(|track| (track, embedding(2))),
    );
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[repeated_candidate.clone(), fresh_candidate.clone()],
        &recommender,
        &repeated_history,
        0.50,
    );

    assert_eq!(selection.index, 1);
    assert!(selection.probability > selection.uniform_probability);
}

#[test]
fn audio_style_attractor_basin_pressure_can_move_out_of_repeated_basin() {
    let current = track_in_basin("Kurzgesagt", "current");
    let played = (0..8)
        .map(|index| track_in_basin("Kurzgesagt", &format!("played_epic_{index}")))
        .collect::<Vec<_>>();
    let epic_candidate = track_in_basin("Kurzgesagt", "epic_next");
    let other_candidate = track_in_basin("ZWEI2", "zwei2_next");
    let other_neighbor = track_in_basin("ZWEI2", "zwei2_neighbor");
    let mut embeddings = vec![
        (current.clone(), embedding(2)),
        (epic_candidate.clone(), embedding(2)),
        (other_candidate.clone(), nearby_open_basin_embedding()),
        (other_neighbor, nearby_open_basin_embedding()),
    ];
    embeddings.extend(
        played
            .iter()
            .cloned()
            .map(|track| (track, basin_neighbor_embedding())),
    );
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

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
fn audio_style_basin_pressure_uses_self_supervised_audio_geometry_before_paths() {
    let current = track_in_basin("Current Path", "current");
    let played = (0..7)
        .map(|index| track_in_basin("Played Path", &format!("played_{index}")))
        .collect::<Vec<_>>();
    let same_audio_basin = track_in_basin("Fresh Different Path", "same_audio_basin");
    let open_audio_basin = track_in_basin("Fresh Open Path", "open_audio_basin");
    let open_audio_neighbor = track_in_basin("Fresh Open Path", "open_audio_neighbor");
    let mut embeddings = vec![
        (current.clone(), embedding(2)),
        (same_audio_basin.clone(), embedding(2)),
        (open_audio_basin.clone(), nearby_open_basin_embedding()),
        (open_audio_neighbor, nearby_open_basin_embedding()),
    ];
    embeddings.extend(
        played
            .iter()
            .cloned()
            .map(|track| (track, basin_neighbor_embedding())),
    );
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_audio_basin.clone(), open_audio_basin.clone()],
        &recommender,
        &played,
        0.35,
    );

    assert_eq!(selection.index, 1);
    assert!(
        selection
            .diagnostics
            .selected_basin
            .as_deref()
            .is_some_and(|basin| basin.starts_with("audio-basin:")),
        "trained geometry must expose self-supervised audio basin ids"
    );
}

#[test]
fn audio_style_basin_diagnostics_do_not_use_paths_for_embedded_geometry() {
    let current = track_in_basin("Current", "current");
    let same_path_far_audio = track_in_basin("Current", "same_path_far_audio");
    let different_path_same_audio = track_in_basin("Other", "different_path_same_audio");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (current.clone(), embedding(2)),
        (same_path_far_audio.clone(), embedding(128)),
        (different_path_same_audio.clone(), embedding(2)),
    ]);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[
            same_path_far_audio.clone(),
            different_path_same_audio.clone(),
        ],
        &recommender,
        &[],
        0.90,
    );

    assert_eq!(selection.index, 1);
    assert!(
        selection
            .diagnostics
            .top_candidate_basins
            .iter()
            .all(|basin| basin.basin.starts_with("audio-basin:")),
        "embedded trained candidates must be diagnosed by audio topology, not folders"
    );
}

#[test]
fn audio_style_basin_homeostasis_reduces_absorbing_local_basin_window() {
    let current = track_in_basin("Tenet", "current");
    let played = (0..7)
        .map(|index| track_in_basin("Tenet", &format!("played_{index}")))
        .collect::<Vec<_>>();
    let tenet_a = track_in_basin("Tenet", "tenet_a");
    let tenet_b = track_in_basin("Tenet", "tenet_b");
    let open = track_in_basin("Death Stranding", "open");
    let open_neighbor = track_in_basin("Death Stranding", "open_neighbor");
    let mut embeddings = vec![
        (current.clone(), embedding(2)),
        (tenet_a.clone(), embedding(2)),
        (tenet_b.clone(), embedding(2)),
        (open.clone(), nearby_open_basin_embedding()),
        (open_neighbor, nearby_open_basin_embedding()),
    ];
    embeddings.extend(
        played
            .iter()
            .cloned()
            .map(|track| (track, basin_neighbor_embedding())),
    );
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let without_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[tenet_a.clone(), tenet_b.clone(), open.clone()],
        &recommender,
        &[],
        0.40,
    );
    let with_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[tenet_a.clone(), tenet_b.clone(), open.clone()],
        &recommender,
        &played,
        0.40,
    );

    assert!(without_history.index < 2);
    assert_eq!(with_history.index, 2);
    assert!(with_history.probability > without_history.uniform_probability);
}

#[test]
fn audio_style_local_fatigue_reduces_repeated_model_neighborhood_without_changing_basin_contract() {
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
            dense_embedding(&[(0, 0.98), (2, 0.20)]),
        ),
        (
            open_region.clone(),
            dense_embedding(&[(0, 0.80), (3, 0.60)]),
        ),
    ]);
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let without_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_region.clone(), open_region.clone()],
        &recommender,
        &[],
        0.01,
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
fn audio_style_listening_adaptation_reduces_recent_style_macro_basin() {
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
fn audio_style_local_region_fatigue_moves_out_of_repeated_audio_neighborhood() {
    let current = track_in_basin("Current", "current");
    let recent = (0..9)
        .map(|index| track_in_basin(&format!("Recent {index}"), &format!("recent_{index}")))
        .collect::<Vec<_>>();
    let sticky_local = track_in_basin("Fresh Local", "sticky_local");
    let open_local = track_in_basin("Fresh Open", "open_local");
    let mut embeddings = vec![(current.clone(), dense_embedding(&[(0, 1.0)]))];
    embeddings.extend(
        recent
            .iter()
            .cloned()
            .map(|track| (track, dense_embedding(&[(0, 0.92), (1, 0.391_918)]))),
    );
    embeddings.extend([
        (
            sticky_local.clone(),
            dense_embedding(&[(0, 0.92), (1, 0.391_918)]),
        ),
        (
            open_local.clone(),
            dense_embedding(&[(0, 0.90), (2, 0.435_89)]),
        ),
    ]);
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let without_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[sticky_local.clone(), open_local.clone()],
        &recommender,
        &[],
        0.0,
    );
    let with_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[sticky_local.clone(), open_local.clone()],
        &recommender,
        &recent,
        0.01,
    );

    assert_eq!(without_history.index, 0);
    assert_eq!(with_history.index, 1);
    assert!(with_history.probability > with_history.uniform_probability);
}

#[test]
fn audio_style_broad_region_fatigue_reduces_weak_attractor_domain_without_single_neighbor_match() {
    let current = track_in_basin("Current", "current");
    let recent = (0..10)
        .map(|index| track_in_basin(&format!("Recent {index}"), &format!("recent_{index}")))
        .collect::<Vec<_>>();
    let broad_domain = track_in_basin("Fresh Broad Domain", "broad_domain");
    let open_domain = track_in_basin("Fresh Open Domain", "open_domain");
    let mut embeddings = vec![(current.clone(), dense_embedding(&[(0, 1.0)]))];
    embeddings.extend(recent.iter().enumerate().map(|(index, track)| {
        let scatter_axis = 32 + index;
        (
            track.clone(),
            dense_embedding(&[(0, 0.80), (1, 0.28), (scatter_axis, 0.53)]),
        )
    }));
    embeddings.extend([
        (
            broad_domain.clone(),
            dense_embedding(&[(0, 0.80), (1, 0.28), (80, 0.53)]),
        ),
        (
            open_domain.clone(),
            dense_embedding(&[(0, 0.78), (2, 0.32), (90, 0.54)]),
        ),
    ]);
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let without_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[broad_domain.clone(), open_domain.clone()],
        &recommender,
        &[],
        0.0,
    );
    let with_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[broad_domain.clone(), open_domain.clone()],
        &recommender,
        &recent,
        0.0,
    );

    assert_eq!(without_history.index, 0);
    assert_eq!(with_history.index, 0);
    assert!(with_history.probability < without_history.probability);
    assert!(with_history.probability > 0.0);
    assert!(
        with_history
            .diagnostics
            .bio_route
            .is_some_and(|route| route.damping > 0.0),
        "broad local-field fatigue should be visible even without one strong recent-neighbor match"
    );
}

#[test]
fn audio_style_semantic_support_still_prefers_current_anchor_similarity() {
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
fn audio_style_sampling_distribution_does_not_remove_liked_recent_style_candidate() {
    let current = track_in_basin("Current", "current");
    let recent_same_style = (0..10)
        .map(|index| track_in_basin("Cinematic", &format!("played_{index}")))
        .collect::<Vec<_>>();
    let mut liked_same_style = track_in_basin("Fresh Cinematic", "liked_same_style");
    liked_same_style.liked = true;
    let mut plain_same_style = liked_same_style.clone();
    plain_same_style.liked = false;
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
        "liked status must not discount route pressure; it only keeps recent tracks sampleable: liked_probability={} plain_probability={}",
        liked_selection.probability,
        plain_selection.probability
    );
}

#[test]
fn audio_style_candidate_selection_ignores_measured_loudness_profiles() {
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
    assert!(
        (with_hot_history.probability - without_history.probability).abs() <= 1.0e-6,
        "loudness is playback normalization evidence, not audio-style recommendation input"
    );
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
fn audio_style_control_gate_prefers_open_basin_without_replacing_distance() {
    let current = track_in_basin("Current", "current");
    let played = (0..10)
        .map(|index| track_in_basin("Current", &format!("played_{index}")))
        .collect::<Vec<_>>();
    let repeated_basin = track_in_basin("Current", "repeated_basin");
    let open_basin = track_in_basin("Open", "open_basin");
    let far_open = track_in_basin("Open", "far_open");
    let mut embeddings = vec![
        (current.clone(), embedding(2)),
        (repeated_basin.clone(), embedding(2)),
        (open_basin.clone(), nearby_open_basin_embedding()),
        (far_open.clone(), embedding(128)),
    ];
    embeddings.extend(
        played
            .iter()
            .cloned()
            .map(|track| (track, basin_neighbor_embedding())),
    );
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

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
        0.35,
    );

    assert_eq!(open_selection.index, 1);
    assert!(open_selection.probability > 0.50);
    assert_eq!(distance_selection.index, 1);
    assert!(distance_selection.probability > 0.0);
}

#[test]
fn audio_style_semantic_continuity_gate_suppresses_only_unforced_shock_jumps() {
    let cold = audio_style_semantic_continuity_gate_for_test(&[0.20, -0.80], 0, 0);
    let closed = audio_style_semantic_continuity_gate_for_test(&[0.40, -0.80], 1, 0);
    let reopened_by_basin = audio_style_semantic_continuity_gate_for_test(&[0.20, -0.80], 3, 0);
    let reopened_by_source = audio_style_semantic_continuity_gate_for_test(&[0.20, -0.80], 0, 3);

    assert_eq!(cold, vec![1.0, 1.0]);
    assert!(closed[0] > closed[1]);
    assert!(closed[1] < 1.0);
    assert!(reopened_by_basin[0] > reopened_by_basin[1]);
    assert!(reopened_by_source[0] > reopened_by_source[1]);
    assert!(reopened_by_basin[1] > closed[1]);
    assert!(reopened_by_source[1] > closed[1]);
    assert!(reopened_by_basin[1] < 1.0);
    assert!(reopened_by_source[1] < 1.0);
}

#[test]
fn audio_style_learned_novelty_gate_prefers_manageable_prediction_error() {
    let gates =
        audio_style_semantic_continuity_gate_for_test(&[-0.80, 0.00, 0.40, 0.80, 1.00], 1, 0);

    assert!(gates[2] > gates[1]);
    assert!(gates[2] > gates[3]);
    assert!(gates[3] > gates[4]);
    assert!(gates[0] < gates[1]);
}

#[test]
fn audio_style_semantic_continuity_requires_channel_agreement_for_high_familiarity() {
    let single_axis = audio_style_agreement_aware_continuity_for_test([0.92, 0.16, 0.12, 0.10]);
    let consensus = audio_style_agreement_aware_continuity_for_test([0.86, 0.82, 0.78, 0.75]);
    let below_threshold =
        audio_style_agreement_aware_continuity_for_test([0.52, -0.20, 0.10, 0.18]);

    assert!(single_axis < 0.80);
    assert!(consensus > single_axis);
    assert!(consensus > 0.80);
    assert_eq!(below_threshold, 0.52);
}

#[test]
fn audio_style_selection_keeps_typed_perceptual_channels_until_candidate_topology() {
    let current = track_in_basin("Current", "current");
    let same_scalar = track_in_basin("Current", "same_scalar");
    let open_transition = track_in_basin("Open", "open_transition");
    let open_neighbor = track_in_basin("Open", "open_neighbor");
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings([
        (
            current.clone(),
            dense_embedding(&[(0, 0.62), (128, 0.30), (256, 0.72)]),
        ),
        (
            same_scalar.clone(),
            dense_embedding(&[(0, 0.64), (128, 0.29), (320, 0.70)]),
        ),
        (
            open_transition.clone(),
            dense_embedding(&[(1, 0.58), (129, 0.31), (256, 0.74)]),
        ),
        (
            open_neighbor,
            dense_embedding(&[(1, 0.57), (129, 0.32), (256, 0.73)]),
        ),
    ]);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[same_scalar.clone(), open_transition.clone()],
        &recommender,
        &[],
        0.99,
    );

    assert!(
        selection.diagnostics.perceptual_channels.is_some(),
        "candidate selection must preserve typed perceptual channels instead of reporting only a scalar style score"
    );
    let channels = selection
        .diagnostics
        .perceptual_channels
        .expect("typed channel diagnostics should exist");
    assert!(channels.transition_similarity.is_finite());
    assert!(channels.topology_gate >= 0.18);
    assert!(channels.active_challenger_axis_count <= 3);
    let topology = selection
        .diagnostics
        .topology_health
        .expect("candidate support telemetry should exist");
    assert!(topology.support_width >= 1.0);
    assert!(topology.support_entropy >= 0.0);
    assert!(topology.control_entropy >= 0.0);
    assert!(topology.density_owner_best_vote_count >= 1);
}

#[test]
fn audio_style_typed_channels_keep_transition_neighbor_sampleable_under_scalar_stickiness() {
    let current = track_in_basin("Current", "current");
    let recent = (0..8)
        .map(|index| track_in_basin("Current", &format!("recent_{index}")))
        .collect::<Vec<_>>();
    let repeated = track_in_basin("Current", "repeated");
    let open_transition = track_in_basin("Open", "open_transition");
    let open_neighbor = track_in_basin("Open", "open_neighbor");
    let mut embeddings = vec![
        (
            current.clone(),
            dense_embedding(&[(0, 0.72), (128, 0.28), (260, 0.63)]),
        ),
        (
            repeated.clone(),
            dense_embedding(&[(0, 0.74), (128, 0.27), (400, 0.62)]),
        ),
        (
            open_transition.clone(),
            dense_embedding(&[(6, 0.62), (135, 0.30), (260, 0.70)]),
        ),
        (
            open_neighbor,
            dense_embedding(&[(6, 0.61), (135, 0.31), (260, 0.69)]),
        ),
    ];
    embeddings.extend(recent.iter().cloned().map(|track| {
        (
            track,
            dense_embedding(&[(0, 0.72), (128, 0.28), (401, 0.62)]),
        )
    }));
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let selection = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[repeated.clone(), open_transition.clone()],
        &recommender,
        &recent,
        0.40,
    );

    assert_eq!(selection.index, 1);
    assert!(selection.probability > selection.uniform_probability);
    assert!(
        selection
            .diagnostics
            .perceptual_channels
            .is_some_and(|channels| channels.transition_similarity > channels.terminal_similarity),
        "transition channel evidence should survive until candidate topology"
    );
}

#[test]
fn audio_style_route_recovery_keeps_boundary_basin_flowing_in_narrow_candidate_pool() {
    let current = track_in_basin("Current", "current");
    let recent = (0..12)
        .map(|index| track_in_basin("Current", &format!("recent_{index}")))
        .collect::<Vec<_>>();
    let same_a = track_in_basin("Current", "same_a");
    let same_b = track_in_basin("Current", "same_b");
    let boundary = track_in_basin("Boundary", "boundary");
    let boundary_neighbor = track_in_basin("Boundary", "boundary_neighbor");
    let far = track_in_basin("Far", "far");
    let mut embeddings = vec![
        (current.clone(), dense_embedding(&[(0, 1.0)])),
        (same_a.clone(), dense_embedding(&[(0, 0.95), (3, 0.31)])),
        (same_b.clone(), dense_embedding(&[(0, 0.95), (3, 0.31)])),
        (boundary.clone(), dense_embedding(&[(0, 0.72), (10, 0.69)])),
        (boundary_neighbor, dense_embedding(&[(0, 0.71), (10, 0.70)])),
        (far.clone(), dense_embedding(&[(48, 1.0)])),
    ];
    embeddings.extend(
        recent
            .iter()
            .cloned()
            .map(|track| (track, dense_embedding(&[(0, 0.95), (3, 0.31)]))),
    );
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let without_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[
            same_a.clone(),
            same_b.clone(),
            boundary.clone(),
            far.clone(),
        ],
        &recommender,
        &[],
        0.68,
    );
    let with_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[
            same_a.clone(),
            same_b.clone(),
            boundary.clone(),
            far.clone(),
        ],
        &recommender,
        &recent,
        0.68,
    );

    assert_ne!(without_history.index, 3);
    assert_eq!(with_history.index, 2);
    assert!(with_history.probability > without_history.probability);
    assert!(
        with_history
            .diagnostics
            .bio_route
            .is_some_and(|route| route.final_weight > 0.0),
        "route recovery should preserve an existing boundary candidate without turning far jumps into exits"
    );
}

#[test]
fn audio_style_listener_recovery_gate_favors_short_term_perceptual_recovery() {
    let listener_state = [0.82, 0.78, 0.74, 0.70, 0.68, 0.76];
    let repeated_load = [0.86, 0.82, 0.78, 0.74, 0.70, 0.80];
    let recovery_load = [0.32, 0.30, 0.28, 0.26, 0.24, 0.30];
    let shock_load = [0.0, 0.0, 0.0, 1.0, 1.0, 0.0];

    let repeated_gate = super::recommendation::audio_style_listener_recovery_gate_for_load_for_test(
        &listener_state,
        &repeated_load,
        0.8,
    );
    let recovery_gate = super::recommendation::audio_style_listener_recovery_gate_for_load_for_test(
        &listener_state,
        &recovery_load,
        0.8,
    );
    let shock_gate = super::recommendation::audio_style_listener_recovery_gate_for_load_for_test(
        &listener_state,
        &shock_load,
        0.8,
    );

    assert!(repeated_gate < 1.0);
    assert!(recovery_gate > repeated_gate * 1.35);
    assert!(shock_gate < recovery_gate);
}

#[test]
fn audio_style_listener_recovery_keeps_bio_route_weight_positive() {
    let current = track_in_basin("Current", "current");
    let recent = (0..10)
        .map(|index| track_in_basin("Current", &format!("recent_load_{index}")))
        .collect::<Vec<_>>();
    let repeated_load = track_in_basin("Current", "repeated_load");
    let recovery = track_in_basin("Open", "recovery");
    let recovery_neighbor = track_in_basin("Open", "recovery_neighbor");
    let far = track_in_basin("Far", "far");
    let high_load = listener_load_embedding(60, 58, 58, (58, 58), 0.52);
    let recovery_load = listener_load_embedding(24, 12, 14, (14, 18), 0.30);
    let far_load = dense_embedding(&[
        (60, -0.60),
        (64 + 58, -0.32),
        (128 + 58, -0.34),
        (128 + 64 + 58, -0.34),
        (256 + 58 * 64 + 58, -0.52),
    ]);
    let mut embeddings = vec![
        (
            current.clone(),
            listener_load_embedding(58, 56, 56, (56, 56), 0.52),
        ),
        (repeated_load.clone(), high_load.clone()),
        (recovery.clone(), recovery_load.clone()),
        (recovery_neighbor, recovery_load),
        (far.clone(), far_load),
    ];
    embeddings.extend(
        recent
            .iter()
            .cloned()
            .map(|track| (track, high_load.clone())),
    );
    let recommender = AudioStylePlaylistPlaybackRecommender::from_test_embeddings(embeddings);

    let without_history = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[repeated_load.clone(), recovery.clone(), far.clone()],
        &recommender,
        &[],
        0.0,
    );
    let with_history_low_draw = choose_next_audio_style_candidate_with_recent_history_for_test(
        &current,
        &[repeated_load.clone(), recovery.clone(), far.clone()],
        &recommender,
        &recent,
        0.0,
    );
    assert_eq!(without_history.index, 0);
    assert_eq!(with_history_low_draw.index, 0);
    assert!(
        with_history_low_draw
            .diagnostics
            .bio_route
            .is_some_and(|route| route.final_weight > 0.0),
        "listener recovery should reshape candidate readout without deleting the topology flow"
    );
}

#[test]
fn audio_style_basin_mass_homeostasis_flattens_weak_attractor_family() {
    let dominant_recent = (0..8)
        .map(|index| track_in_basin("Dominant", &format!("recent_{index}")))
        .collect::<Vec<_>>();
    let dominant = (0..4)
        .map(|index| track_in_basin("Dominant", &format!("candidate_{index}")))
        .collect::<Vec<_>>();
    let open_a = track_in_basin("Open A", "candidate");
    let open_b = track_in_basin("Open B", "candidate");
    let candidates = [
        dominant[0].clone(),
        dominant[1].clone(),
        dominant[2].clone(),
        dominant[3].clone(),
        open_a,
        open_b,
    ];
    let base = [0.24, 0.22, 0.20, 0.18, 0.08, 0.08];

    let gate = super::recommendation::audio_style_basin_mass_homeostasis_gate_for_test(
        &candidates,
        &base,
        &dominant_recent,
    );

    assert!(gate[0] < 0.85);
    assert!(gate[1] < 0.85);
    assert!(gate[4] > gate[0]);
    assert!(gate[5] > gate[1]);
    assert!(gate[4] >= 0.95);
    assert!(gate[5] >= 0.95);
}

#[test]
fn audio_style_basin_mass_homeostasis_preserves_balanced_candidate_field() {
    let candidates = [
        track_in_basin("Dominant", "candidate_0"),
        track_in_basin("Dominant", "candidate_1"),
        track_in_basin("Dominant", "candidate_2"),
        track_in_basin("Dominant", "candidate_3"),
        track_in_basin("Open A", "candidate"),
        track_in_basin("Open B", "candidate"),
    ];
    let base = [0.125, 0.125, 0.125, 0.125, 0.25, 0.25];

    let gate = super::recommendation::audio_style_basin_mass_homeostasis_gate_for_test(
        &candidates,
        &base,
        &[],
    );

    assert!(gate.iter().all(|value| *value >= 0.95));
}

#[test]
fn audio_style_candidate_field_balance_caps_dominant_basin() {
    let dominant = (0..80).map(|index| ("Dominant", 1.0 - index as f32 * 0.001));
    let open = (0..200).map(|index| {
        let basin = match index % 20 {
            0 => "Open 00",
            1 => "Open 01",
            2 => "Open 02",
            3 => "Open 03",
            4 => "Open 04",
            5 => "Open 05",
            6 => "Open 06",
            7 => "Open 07",
            8 => "Open 08",
            9 => "Open 09",
            10 => "Open 10",
            11 => "Open 11",
            12 => "Open 12",
            13 => "Open 13",
            14 => "Open 14",
            15 => "Open 15",
            16 => "Open 16",
            17 => "Open 17",
            18 => "Open 18",
            _ => "Open 19",
        };
        (basin, 0.70 - index as f32 * 0.001)
    });

    let selected = balance_audio_style_candidate_field_basins_for_test(dominant.chain(open), 96);
    let counts = basin_counts(&selected);

    assert_eq!(selected.len(), 96);
    assert!(counts["youtube:dominant"] <= 16);
    assert!(counts.len() >= 20);
}

#[test]
fn audio_style_candidate_field_balance_keeps_small_fields_unchanged() {
    let selected = balance_audio_style_candidate_field_basins_for_test(
        [("A", 0.9), ("A", 0.8), ("B", 0.7), ("C", 0.6)],
        96,
    );

    assert_eq!(
        selected,
        vec![
            "youtube:a".to_string(),
            "youtube:a".to_string(),
            "youtube:b".to_string(),
            "youtube:c".to_string(),
        ]
    );
}

#[test]
fn audio_style_candidate_field_balance_keeps_locality_in_reserve() {
    let dominant = (0..80).map(|index| ("Dominant", 1.0 - index as f32 * 0.001));
    let open = (0..80).map(|index| {
        let basin = match index {
            0..=7 => "Open 00",
            8..=15 => "Open 01",
            16..=23 => "Open 02",
            24..=31 => "Open 03",
            32..=39 => "Open 04",
            40..=47 => "Open 05",
            48..=55 => "Open 06",
            56..=63 => "Open 07",
            64..=71 => "Open 08",
            _ => "Open 09",
        };
        (basin, 0.50 - index as f32 * 0.001)
    });

    let selected = balance_audio_style_candidate_field_basins_for_test(dominant.chain(open), 40);
    let counts = basin_counts(&selected);

    assert_eq!(selected.len(), 40);
    assert!(counts["youtube:dominant"] > 5);
    assert!(counts["youtube:dominant"] <= 8);
    assert!(counts.len() >= 8);
}

fn basin_counts(basins: &[String]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for basin in basins {
        *counts.entry(basin.clone()).or_insert(0) += 1;
    }
    counts
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
fn restored_audio_style_stable_model_restores_indexed_sources_and_geometry() {
    let root = temp_cache_root("stable-model-source");
    std::fs::create_dir_all(&root).expect("stable model test root should be created");
    let path = root.join("stable.json");
    let source = "source:current".to_string();
    let current = track("current");
    let near = track("near");
    let far = track("far");
    let snapshot = AudioStyleModelSnapshot::from_test_indexed_embeddings(
        11,
        [
            (
                current.clone(),
                dense_embedding(&[(0, 1.0)]),
                source.clone(),
            ),
            (
                near.clone(),
                dense_embedding(&[(0, 0.9), (1, 0.43589)]),
                source.clone(),
            ),
            (far.clone(), dense_embedding(&[(2, 1.0)]), source.clone()),
        ],
    );
    let before_similarity = snapshot
        .recommender()
        .centered_similarity_for_test(&current, &near)
        .expect("trained setup should expose sampling geometry");

    write_audio_style_stable_model_for_test(&path, &snapshot)
        .expect("stable model should be written");
    let restored =
        read_audio_style_stable_model_for_test(&path).expect("stable model should be restored");

    assert_eq!(restored.generation(), 11);
    assert!(restored.recommender().has_embedding_for(&current));
    let (after_source, after_selection) = restored
        .recommender()
        .propose_centerless_source(|candidate_source| candidate_source.collection_folder == source)
        .expect("stable model should restore indexed source evidence");
    assert_eq!(after_source.collection_folder, source);
    assert_eq!(after_selection.candidate_count, 3);
    let after_similarity = restored
        .recommender()
        .centered_similarity_for_test(&current, &near)
        .expect("stable model should restore sampling geometry");
    assert!((before_similarity - after_similarity).abs() < 1.0e-6);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn restored_audio_style_stable_model_ranks_current_candidate_tracks() {
    let root = temp_cache_root("stable-model-candidates");
    std::fs::create_dir_all(&root).expect("stable model test root should be created");
    let path = root.join("stable.json");
    let current_candidate = track("current_candidate");
    let other_candidate = track("other_candidate");
    let missing_candidate = track("missing_candidate");
    let snapshot = AudioStyleModelSnapshot::from_test_indexed_embeddings(
        12,
        [
            (
                current_candidate.clone(),
                dense_embedding(&[(2, 1.0)]),
                "current".to_string(),
            ),
            (
                other_candidate.clone(),
                dense_embedding(&[(3, 1.0)]),
                "other".to_string(),
            ),
        ],
    );
    write_audio_style_stable_model_for_test(&path, &snapshot)
        .expect("stable model should be written");
    let restored =
        read_audio_style_stable_model_for_test(&path).expect("stable model should be restored");

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
        .expect("stable model should rank embedded current candidates");

    assert_ne!(source.collection_folder, "missing");
    assert_ne!(selected_track.music_url, missing_candidate.music_url);
    assert_eq!(selection.candidate_count, 2);
    assert_eq!(selection.diagnostics.embedded_candidate_count, 2);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn legacy_audio_style_model_evidence_is_not_restored_as_stable_model() {
    let root = temp_cache_root("legacy-model-evidence-rejected");
    std::fs::create_dir_all(&root).expect("legacy evidence test root should be created");
    let path = root.join("stable.json");
    std::fs::write(
        &path,
        serde_json::json!({
            "version": "audio-style-model-evidence-v3-indexed-sources",
            "embedding_version": AUDIO_STYLE_EMBEDDING_VERSION_FOR_TEST,
            "generation": 13,
            "embeddings": [],
            "indexed_tracks": []
        })
        .to_string(),
    )
    .expect("legacy evidence fixture should be written");

    let error = match read_audio_style_stable_model_for_test(&path) {
        Ok(_) => panic!("legacy evidence must not restore as the new stable model"),
        Err(error) => error,
    };

    assert!(
        error.contains("audio style stable model"),
        "legacy evidence should fail inside the stable model reader: {error}"
    );

    let _ = std::fs::remove_dir_all(root);
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
fn audio_style_model_refresh_ignores_loudness_profile_changes() {
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
    .expect("loudness changes should keep the previous audio style snapshot");

    assert_eq!(refreshed.generation(), 7);
    assert!(refreshed.recommender().has_embedding_for(&changed));
    let previous_embedding = previous
        .embedding_arc_for_track(&current)
        .expect("previous embedding should exist");
    let refreshed_embedding = refreshed
        .embedding_arc_for_track(&changed)
        .expect("refreshed embedding should exist");
    assert!(std::sync::Arc::ptr_eq(
        &previous_embedding,
        &refreshed_embedding
    ));

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
    let plain_tail = track("liked_tail");
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
        &[best.clone(), liked_tail.clone(), low.clone()],
        snapshot.recommender(),
        0.995,
        Some(snapshot.generation()),
    );
    let plain_selection = choose_next_audio_style_candidate_with_generation_for_test(
        &current,
        &[best, plain_tail, low],
        snapshot.recommender(),
        0.995,
        Some(snapshot.generation()),
    );

    assert_eq!(selection.index, plain_selection.index);
    assert!(
        (selection.probability - plain_selection.probability).abs() <= 1.0e-6,
        "liked status must not add a sampling bonus over distance and flow pressure"
    );
    assert_eq!(selection.model_generation, Some(9));
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
    assert!(
        selection
            .diagnostics
            .selected_basin
            .as_deref()
            .is_some_and(|basin| basin.starts_with("audio-basin:"))
    );
    assert!(
        selection
            .diagnostics
            .top_candidate_basins
            .iter()
            .all(|basin| basin.basin.starts_with("audio-basin:")),
        "trained geometry must not fall back to folder basins for unembedded candidates"
    );
    assert_eq!(
        selection
            .diagnostics
            .top_candidate_basins
            .iter()
            .map(|basin| basin.embedded_candidate_count)
            .sum::<usize>(),
        2
    );
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
        StableSnapshotPublicationReason::StartupStableModel,
        false,
    ));
    assert!(!stable_snapshot_publication_requests_first_slot_refresh(
        StableSnapshotPublicationReason::StartupStableModel,
        true,
    ));
}

#[test]
fn audio_style_startup_skips_training_only_when_stable_model_restores_without_pending_records() {
    use super::recommendation::{
        AudioStyleStartupInputCoverage, AudioStyleStartupTrainingDecision,
        audio_style_startup_training_decision,
    };

    assert_eq!(
        audio_style_startup_training_decision(
            true,
            0,
            0,
            0,
            AudioStyleStartupInputCoverage::Covered,
        ),
        AudioStyleStartupTrainingDecision::SkipRestoredStableModel
    );
    assert_eq!(
        audio_style_startup_training_decision(
            false,
            0,
            0,
            0,
            AudioStyleStartupInputCoverage::Covered,
        ),
        AudioStyleStartupTrainingDecision::SkipNoTrainingInputs
    );
    assert_eq!(
        audio_style_startup_training_decision(
            true,
            2,
            0,
            0,
            AudioStyleStartupInputCoverage::Covered,
        ),
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges
    );
    assert_eq!(
        audio_style_startup_training_decision(
            false,
            2,
            0,
            0,
            AudioStyleStartupInputCoverage::Covered,
        ),
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges
    );
    assert_eq!(
        audio_style_startup_training_decision(
            false,
            0,
            2,
            0,
            AudioStyleStartupInputCoverage::Covered,
        ),
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges
    );
    assert_eq!(
        audio_style_startup_training_decision(
            true,
            0,
            2,
            0,
            AudioStyleStartupInputCoverage::Covered,
        ),
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges
    );
    assert_eq!(
        audio_style_startup_training_decision(
            true,
            0,
            0,
            1,
            AudioStyleStartupInputCoverage::Covered,
        ),
        AudioStyleStartupTrainingDecision::SkipRestoredStableModel
    );
    assert_eq!(
        audio_style_startup_training_decision(
            false,
            0,
            0,
            1,
            AudioStyleStartupInputCoverage::Covered,
        ),
        AudioStyleStartupTrainingDecision::SkipNoTrainingInputs
    );
    assert_eq!(
        audio_style_startup_training_decision(
            true,
            0,
            0,
            0,
            AudioStyleStartupInputCoverage::Changed,
        ),
        AudioStyleStartupTrainingDecision::TrainPendingInputChanges
    );
    assert_eq!(
        audio_style_startup_training_decision(true, 0, 0, 0, AudioStyleStartupInputCoverage::Empty,),
        AudioStyleStartupTrainingDecision::SkipNoTrainingInputs
    );
}

#[test]
fn audio_style_training_invalidations_dedupe_by_music_identity() {
    use super::recommendation::{
        AudioStyleMusicInputIdentity, AudioStyleTrainingInvalidationRecord,
        read_audio_style_training_invalidation_file, upsert_audio_style_training_invalidation_file,
    };

    let root = temp_cache_root("audio-style-training-invalidations");
    std::fs::create_dir_all(&root).expect("invalidation test root should be created");
    let path = root.join("invalidations.json");
    let music = AudioStyleMusicInputIdentity {
        canonical_music_id: "canonical-a".to_owned(),
        music_url: "https://example.test/a".to_owned(),
        path: Some("A.m4a".to_owned()),
        start_ms: 0,
        end_ms: 100,
    };

    let first_count = upsert_audio_style_training_invalidation_file(
        &path,
        AudioStyleTrainingInvalidationRecord {
            reason: "music_create".to_owned(),
            created_at_ms: 1,
            music: Some(music.clone()),
        },
    )
    .expect("first invalidation should write");
    let second_count = upsert_audio_style_training_invalidation_file(
        &path,
        AudioStyleTrainingInvalidationRecord {
            reason: "music_identity_update".to_owned(),
            created_at_ms: 2,
            music: Some(music),
        },
    )
    .expect("second invalidation should replace same music identity");

    let records =
        read_audio_style_training_invalidation_file(&path).expect("records should read back");
    assert_eq!(first_count, 1);
    assert_eq!(second_count, 1);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].reason, "music_identity_update");
    assert_eq!(records[0].created_at_ms, 2);
}

#[test]
fn audio_style_training_invalidations_clear_after_successful_training() {
    use super::recommendation::{
        AudioStyleTrainingInvalidationRecord, clear_audio_style_training_invalidation_file,
        read_audio_style_training_invalidation_file, upsert_audio_style_training_invalidation_file,
    };

    let root = temp_cache_root("audio-style-training-invalidation-clear");
    std::fs::create_dir_all(&root).expect("invalidation clear root should be created");
    let path = root.join("invalidations.json");

    upsert_audio_style_training_invalidation_file(
        &path,
        AudioStyleTrainingInvalidationRecord {
            reason: "local_collection_imported".to_owned(),
            created_at_ms: 1,
            music: None,
        },
    )
    .expect("library invalidation should write");

    let removed =
        clear_audio_style_training_invalidation_file(&path).expect("clear should succeed");
    let records =
        read_audio_style_training_invalidation_file(&path).expect("empty records should read");
    assert_eq!(removed, 1);
    assert!(records.is_empty());
    assert!(!path.exists());
}

#[test]
fn audio_style_pending_training_inputs_are_durable_and_deduplicated_by_track_identity() {
    let root = temp_cache_root("audio-style-pending-training-inputs");
    std::fs::create_dir_all(&root).expect("pending input test root should be created");
    let path = root.join("pending-inputs.json");
    let first = AudioStyleTrainingTrackInput {
        occurrence_id: "occ-a".to_string(),
        alias: "Track A".to_string(),
        canonical_music_id: "canonical-a".to_string(),
        url: "https://example.test/a".to_string(),
        absolute_path: "C:/music/a.m4a".to_string(),
        start_ms: 0,
        end_ms: 100,
        liked: false,
        loudness_profile: None,
    };
    let duplicate = AudioStyleTrainingTrackInput {
        alias: "Track A renamed".to_string(),
        ..first.clone()
    };
    let second = AudioStyleTrainingTrackInput {
        canonical_music_id: "canonical-b".to_string(),
        url: "https://example.test/b".to_string(),
        absolute_path: "C:/music/b.m4a".to_string(),
        ..first.clone()
    };

    let first_count =
        upsert_audio_style_pending_training_input_file_for_test(&path, &[first.clone(), duplicate])
            .expect("first pending input write should succeed");
    let second_count = upsert_audio_style_pending_training_input_file_for_test(
        &path,
        std::slice::from_ref(&second),
    )
    .expect("second pending input write should succeed");
    let inputs = read_audio_style_pending_training_input_file_for_test(&path)
        .expect("pending inputs should read");

    assert_eq!(first_count, 1);
    assert_eq!(second_count, 2);
    assert_eq!(inputs.len(), 2);
    assert!(
        inputs
            .iter()
            .any(|input| input.canonical_music_id == "canonical-a")
    );
    assert!(
        inputs
            .iter()
            .any(|input| input.canonical_music_id == "canonical-b")
    );
}

#[test]
fn audio_style_pending_training_input_ack_only_removes_consumed_records() {
    let root = temp_cache_root("audio-style-pending-training-inputs-ack");
    std::fs::create_dir_all(&root).expect("pending input ack root should be created");
    let path = root.join("pending-inputs.json");
    let first = AudioStyleTrainingTrackInput {
        occurrence_id: "occ-a".to_string(),
        alias: "Track A".to_string(),
        canonical_music_id: "canonical-a".to_string(),
        url: "https://example.test/a".to_string(),
        absolute_path: "C:/music/a.m4a".to_string(),
        start_ms: 0,
        end_ms: 100,
        liked: false,
        loudness_profile: None,
    };
    let second = AudioStyleTrainingTrackInput {
        occurrence_id: "occ-b".to_string(),
        alias: "Track B".to_string(),
        canonical_music_id: "canonical-b".to_string(),
        url: "https://example.test/b".to_string(),
        absolute_path: "C:/music/b.m4a".to_string(),
        start_ms: 0,
        end_ms: 100,
        liked: false,
        loudness_profile: None,
    };
    let updated_first = AudioStyleTrainingTrackInput {
        alias: "Track A updated".to_string(),
        liked: true,
        ..first.clone()
    };
    let third = AudioStyleTrainingTrackInput {
        occurrence_id: "occ-c".to_string(),
        alias: "Track C".to_string(),
        canonical_music_id: "canonical-c".to_string(),
        url: "https://example.test/c".to_string(),
        absolute_path: "C:/music/c.m4a".to_string(),
        start_ms: 0,
        end_ms: 100,
        liked: false,
        loudness_profile: None,
    };

    upsert_audio_style_pending_training_input_file_for_test(
        &path,
        &[first.clone(), second.clone()],
    )
    .expect("initial pending inputs should write");
    upsert_audio_style_pending_training_input_file_for_test(
        &path,
        &[updated_first.clone(), third.clone()],
    )
    .expect("new pending inputs should write");

    let (removed, remaining) =
        acknowledge_audio_style_pending_training_input_file_for_test(&path, &[first, second])
            .expect("ack should remove only records consumed by the finished run");
    let inputs = read_audio_style_pending_training_input_file_for_test(&path)
        .expect("remaining pending inputs should read");

    assert_eq!(removed, 1);
    assert_eq!(remaining, 2);
    assert_eq!(inputs.len(), 2);
    assert!(inputs.iter().any(|input| input == &updated_first));
    assert!(inputs.iter().any(|input| input == &third));
}

#[test]
fn audio_style_pending_training_input_ack_only_covers_stable_embeddings() {
    let covered_track = track("covered");
    let missing_track = track("missing");
    let covered_input = AudioStyleTrainingTrackInput {
        occurrence_id: "occ-covered".to_string(),
        alias: covered_track.music_name.clone(),
        canonical_music_id: covered_track.canonical_music_id.clone(),
        url: covered_track.music_url.clone(),
        absolute_path: covered_track.file_path.to_string_lossy().to_string(),
        start_ms: covered_track.start_ms,
        end_ms: covered_track.end_ms,
        liked: covered_track.liked,
        loudness_profile: covered_track.loudness_profile,
    };
    let missing_input = AudioStyleTrainingTrackInput {
        occurrence_id: "occ-missing".to_string(),
        alias: missing_track.music_name.clone(),
        canonical_music_id: missing_track.canonical_music_id.clone(),
        url: missing_track.music_url.clone(),
        absolute_path: missing_track.file_path.to_string_lossy().to_string(),
        start_ms: missing_track.start_ms,
        end_ms: missing_track.end_ms,
        liked: missing_track.liked,
        loudness_profile: missing_track.loudness_profile,
    };
    let snapshot = AudioStyleModelSnapshot::from_test_indexed_embeddings(
        9,
        [(covered_track, embedding(9), "album".to_string())],
    );

    let covered = audio_style_training_inputs_covered_by_snapshot_for_test(
        &[covered_input.clone(), missing_input.clone()],
        &snapshot,
    );

    assert_eq!(covered, vec![covered_input]);
    assert!(!covered.contains(&missing_input));
}

#[test]
fn audio_style_training_empty_inputs_are_noop_before_model_build() {
    use super::recommendation::{
        AudioStyleTrainingInputReadiness, audio_style_training_input_readiness,
    };

    assert_eq!(
        audio_style_training_input_readiness(0),
        AudioStyleTrainingInputReadiness::NoIndexableTracks,
        "empty libraries are a legal idle state, not a failed model build"
    );
    assert_eq!(
        audio_style_training_input_readiness(1),
        AudioStyleTrainingInputReadiness::ReadyToBuildModel
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
    assert!(
        super::recommendation::log_audio_style_hardware_busy_skip_for_test(),
        "the first busy skip should remain observable"
    );
    assert!(
        !super::recommendation::log_audio_style_hardware_busy_skip_for_test(),
        "repeated busy skips in the same window should be aggregated"
    );
    assert_eq!(
        super::recommendation::audio_style_hardware_busy_skip_suppressed_for_test(),
        1
    );
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
