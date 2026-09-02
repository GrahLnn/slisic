use super::recommendation::{
    AUDIO_STYLE_EMBEDDING_VERSION_FOR_TEST, AudioStyleEmbeddingCache, AudioStyleModelSnapshot,
    AudioStyleSymbolicPendingObservationOutcome, AudioStyleSymbolicPlaybackSession,
    acknowledge_audio_style_pending_training_input_file_for_test, audio_style_intervals_for_test,
    audio_style_training_inputs_covered_by_snapshot_for_test,
    audio_style_training_path_is_transient_for_test, audio_style_transition_fingerprint_for_test,
    choose_audio_style_model_snapshots_for_anchor,
    read_and_refresh_audio_style_stable_model_for_test,
    read_audio_style_pending_training_input_file_for_test, read_audio_style_stable_model_for_test,
    read_legacy_audio_style_training_inputs_for_test,
    upsert_audio_style_pending_training_input_file_for_test,
    write_audio_style_stable_model_for_test,
};
use crate::domain::player::model::PlaybackTrack;
use crate::domain::playlists::model::{AudioStyleTrainingTrackInput, LoudnessProfile};
use crate::domain::playlists::repo::{PlaylistPlaybackGroupRef, PlaylistPlaybackSelection};
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

fn embedding(active_index: usize) -> Vec<f32> {
    let mut values = vec![0.0; TEST_EMBEDDING_WIDTH];
    values[active_index] = 1.0;
    values
}

fn dense_embedding(entries: &[(usize, f32)]) -> Vec<f32> {
    let mut values = vec![0.0; TEST_EMBEDDING_WIDTH];
    for (index, value) in entries {
        values[*index] = *value;
    }
    values
}

fn chromaprint_frames(seed: u32) -> Vec<u32> {
    (0..16)
        .map(|index| seed.wrapping_add(index as u32 * 0x0101_0101))
        .collect()
}

fn acoustic_test_values(
    tracks: Vec<PlaybackTrack>,
    base_keys: &[&str],
    fingerprints: Vec<Vec<u32>>,
) -> Vec<(PlaybackTrack, Vec<f32>, String, Option<(u32, Vec<u32>)>)> {
    tracks
        .into_iter()
        .enumerate()
        .map(|(index, track)| {
            (
                track,
                dense_embedding(&[(0, 1.0)]),
                base_keys[index].to_string(),
                Some((60_000, fingerprints[index].clone())),
            )
        })
        .collect()
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
fn symbolic_playback_session_commits_and_rolls_back_program_state() {
    let tracks = (0..6)
        .map(|index| track(&format!("symbolic-{index}")))
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_embeddings(
        90,
        tracks
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, track)| (track, dense_embedding(&[(index, 1.0)]))),
    );
    let mut session = AudioStyleSymbolicPlaybackSession::default();
    let first = session
        .propose_next(&snapshot, &tracks[0], &tracks, &[tracks[0].clone()])
        .expect("symbolic scope should prepare a next track");
    session
        .rollback_proposal()
        .expect("uncommitted proposal should roll back");
    let replayed = session
        .propose_next(&snapshot, &tracks[0], &tracks, &[tracks[0].clone()])
        .expect("rolled-back state should prepare again");

    assert_eq!(first.track.music_url, replayed.track.music_url);
    session
        .commit_proposal()
        .expect("prepared proposal should commit");
    let second = session
        .propose_next(
            &snapshot,
            &replayed.track,
            &tracks,
            &[tracks[0].clone(), replayed.track.clone()],
        )
        .expect("committed state should continue across queue boundaries");

    assert_ne!(second.track.music_url, tracks[0].music_url);
    assert_ne!(second.track.music_url, replayed.track.music_url);
    session
        .commit_proposal()
        .expect("continued proposal should commit");
}

#[test]
fn symbolic_active_observation_commits_only_the_proposed_track() {
    let tracks = (0..6)
        .map(|index| track(&format!("active-observation-{index}")))
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_embeddings(
        90,
        tracks
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, track)| (track, dense_embedding(&[(index, 1.0)]))),
    );

    let mut pending = AudioStyleSymbolicPlaybackSession::default();
    let prepared = pending
        .propose_next(&snapshot, &tracks[0], &tracks, &[])
        .expect("symbolic proposal should prepare");
    assert_eq!(
        pending
            .observe_active_track(&tracks[0])
            .expect("anchor observation should be accepted"),
        AudioStyleSymbolicPendingObservationOutcome::StillPending
    );
    assert!(
        pending
            .propose_next(&snapshot, &tracks[0], &tracks, &[])
            .is_err(),
        "the anchor must not consume a queued proposal"
    );

    let other = tracks
        .iter()
        .find(|candidate| {
            candidate.music_url != tracks[0].music_url
                && candidate.music_url != prepared.track.music_url
        })
        .expect("the symbolic fixture should have an unrelated track");
    let mut rolled_back = AudioStyleSymbolicPlaybackSession::default();
    let prepared_again = rolled_back
        .propose_next(&snapshot, &tracks[0], &tracks, &[])
        .expect("symbolic proposal should prepare for rollback");
    assert_eq!(
        rolled_back
            .observe_active_track(other)
            .expect("unrelated active track should be observed"),
        AudioStyleSymbolicPendingObservationOutcome::RolledBack
    );
    let replayed = rolled_back
        .propose_next(&snapshot, &tracks[0], &tracks, &[])
        .expect("rollback should restore the committed execution");
    assert_eq!(prepared_again.track.music_url, replayed.track.music_url);

    let mut committed = AudioStyleSymbolicPlaybackSession::default();
    let proposed = committed
        .propose_next(&snapshot, &tracks[0], &tracks, &[])
        .expect("symbolic proposal should prepare for commit");
    assert_eq!(
        committed
            .observe_active_track(&proposed.track)
            .expect("proposed active track should be observed"),
        AudioStyleSymbolicPendingObservationOutcome::Committed
    );
    committed
        .propose_next(&snapshot, &proposed.track, &tracks, &[])
        .expect("a committed proposal should advance the execution");
}

#[test]
fn symbolic_snapshot_materializes_complete_selected_member_sources() {
    let tracks = (0..4)
        .map(|index| track(&format!("materialized-member-{index}")))
        .collect::<Vec<_>>();
    let non_model_track = track("non-model-source");
    let snapshot = AudioStyleModelSnapshot::from_test_acoustic_indexed_embeddings(
        163,
        tracks.iter().cloned().enumerate().map(|(index, track)| {
            (
                track,
                dense_embedding(&[(index, 1.0)]),
                Some(if index < 2 {
                    "shared-content".to_string()
                } else {
                    format!("content-{index}")
                }),
                None,
            )
        }),
    );
    let selection = PlaylistPlaybackSelection {
        playlist_name: "Focus".to_string(),
        collections: vec![],
        groups: vec![PlaylistPlaybackGroupRef::new_for_test(
            "Model Sources",
            "",
            "model",
        )],
        extra: vec![],
        download_scopes: vec![],
    };

    let sources = snapshot.symbolic_playlist_track_sources_for_selection(&selection);
    let source_urls = sources
        .iter()
        .map(|source| source.music.url.as_str())
        .collect::<Vec<_>>();
    assert_eq!(sources.len(), tracks.len());
    assert!(source_urls.contains(&tracks[0].music_url.as_str()));
    assert!(source_urls.contains(&tracks[1].music_url.as_str()));
    assert!(!source_urls.contains(&non_model_track.music_url.as_str()));

    let outside_selection = PlaylistPlaybackSelection {
        playlist_name: "Focus".to_string(),
        collections: vec![],
        groups: vec![PlaylistPlaybackGroupRef::new_for_test(
            "Other Sources",
            "https://example.com/other",
            "other",
        )],
        extra: vec![],
        download_scopes: vec![],
    };
    assert!(
        snapshot
            .symbolic_playlist_track_sources_for_selection(&outside_selection)
            .is_empty(),
        "symbolic materialization must remain inside the playlist selection"
    );
}

#[test]
fn exact_content_class_owns_one_symbolic_position_and_one_history_slot() {
    let tracks = (0..6)
        .map(|index| track(&format!("content-class-{index}")))
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_content_embeddings(
        100,
        tracks.iter().cloned().enumerate().map(|(index, track)| {
            let content_key = if index < 2 {
                "shared-content".to_string()
            } else {
                format!("unique-content-{index}")
            };
            (track, dense_embedding(&[(index, 1.0)]), content_key)
        }),
    );

    assert_eq!(snapshot.symbolic_track_count(), Some(5));

    let mut session = AudioStyleSymbolicPlaybackSession::default();
    let mut current = tracks[0].clone();
    let mut recent = vec![current.clone()];
    for _ in 0..4 {
        let next = session
            .propose_next(&snapshot, &current, &tracks, &recent)
            .expect("content-collapsed symbolic scope should remain executable");
        assert_ne!(next.track.music_url, tracks[1].music_url);
        assert!(!next.coverage_epoch_transition);
        session
            .commit_proposal()
            .expect("content-collapsed proposal should commit");
        current = next.track;
        recent.push(current.clone());
    }

    let mut reached_second_materialization = false;
    for _ in 0..6 {
        let next = session
            .propose_next(&snapshot, &current, &tracks, &recent)
            .expect("later coverage epochs should keep the content class materializable");
        reached_second_materialization |= next.track.music_url == tracks[1].music_url;
        session
            .commit_proposal()
            .expect("later content materialization should commit");
        current = next.track;
        recent.push(current.clone());
    }
    assert!(reached_second_materialization);

    let cached = session
        .cached_scope_tracks_for(&snapshot, &current)
        .expect("all materializations should resolve to the shared class scope");
    assert_eq!(cached.len(), 5);
}

#[test]
fn file_content_evidence_collapses_distinct_track_identities() {
    let root = temp_cache_root("content-evidence");
    std::fs::create_dir_all(&root).expect("content evidence root should be created");
    let mut tracks = (0..6)
        .map(|index| track(&format!("content-evidence-{index}")))
        .collect::<Vec<_>>();
    for (index, track) in tracks.iter_mut().enumerate() {
        let file_path = root.join(format!("audio-{index}.bin"));
        let byte = if index < 2 { 9 } else { index as u8 };
        std::fs::write(&file_path, vec![byte; 32])
            .expect("content evidence file should be written");
        track.file_path = file_path;
    }

    let snapshot = AudioStyleModelSnapshot::from_test_indexed_embeddings(
        104,
        tracks.iter().cloned().enumerate().map(|(index, track)| {
            (
                track,
                dense_embedding(&[(index, 1.0)]),
                "content-evidence".to_string(),
            )
        }),
    );

    assert_eq!(snapshot.symbolic_track_count(), Some(5));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn newly_current_materialization_rebuilds_a_cached_content_scope() {
    let tracks = (0..6)
        .map(|index| track(&format!("materialization-scope-{index}")))
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_content_embeddings(
        105,
        tracks.iter().cloned().enumerate().map(|(index, track)| {
            let content_key = if index < 2 {
                "shared-materialization".to_string()
            } else {
                format!("materialization-{index}")
            };
            (track, dense_embedding(&[(index, 1.0)]), content_key)
        }),
    );
    let initial_candidates = tracks
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != 1)
        .map(|(_, track)| track.clone())
        .collect::<Vec<_>>();
    let mut session = AudioStyleSymbolicPlaybackSession::default();
    session
        .propose_next(
            &snapshot,
            &tracks[0],
            &initial_candidates,
            &[tracks[0].clone()],
        )
        .expect("initial materialized scope should compile");
    session
        .commit_proposal()
        .expect("initial materialized scope should commit");

    assert!(
        session
            .cached_scope_tracks_for(&snapshot, &tracks[1])
            .is_none()
    );
    session
        .propose_next(&snapshot, &tracks[1], &tracks, &[tracks[1].clone()])
        .expect("a newly current concrete member should rebuild its class materializations");
    session
        .commit_proposal()
        .expect("rebuilt materialization scope should commit");
    assert!(
        session
            .cached_scope_tracks_for(&snapshot, &tracks[1])
            .is_some()
    );
}

#[test]
fn similar_embeddings_do_not_create_hard_content_identity() {
    let mut tracks = (0..6)
        .map(|index| track(&format!("distinct-content-{index}")))
        .collect::<Vec<_>>();
    tracks[1].music_name = tracks[0].music_name.clone();
    let snapshot = AudioStyleModelSnapshot::from_test_content_embeddings(
        101,
        tracks.iter().cloned().enumerate().map(|(index, track)| {
            let embedding = if index < 2 {
                dense_embedding(&[(0, 1.0)])
            } else {
                dense_embedding(&[(index, 1.0)])
            };
            (track, embedding, format!("content-{index}"))
        }),
    );

    assert_eq!(snapshot.symbolic_track_count(), Some(6));
}

#[test]
fn acoustic_pass_merges_preexisting_base_classes_and_singleton() {
    let tracks = (0..5)
        .map(|index| track(&format!("acoustic-base-{index}")))
        .collect::<Vec<_>>();
    let mut tracks = tracks;
    let root = temp_cache_root("acoustic-base-classes");
    std::fs::create_dir_all(&root).expect("acoustic base root should be created");
    for (index, track) in tracks.iter_mut().enumerate() {
        let file_path = root.join(format!("base-{index}.m4a"));
        track.file_path = file_path.clone();
        std::fs::write(
            &file_path,
            if index < 2 {
                vec![9; 32]
            } else {
                vec![index as u8; 32]
            },
        )
        .expect("acoustic base evidence should be written");
    }
    let shared = chromaprint_frames(0x1200_0000);
    let mut fingerprints = vec![shared.clone(); 5];
    fingerprints[1] = {
        let mut shifted = vec![0xFFFF_FFFF];
        shifted.extend(shared.iter().copied());
        shifted
    };
    let snapshot = AudioStyleModelSnapshot::from_test_acoustic_indexed_embeddings(
        110,
        tracks
            .clone()
            .into_iter()
            .enumerate()
            .map(|(index, track)| {
                (
                    track,
                    dense_embedding(&[(0, 1.0)]),
                    match index {
                        2 | 3 => Some("override-b".to_string()),
                        _ => None,
                    },
                    Some((60_000, fingerprints[index].clone())),
                )
            }),
    );

    let classes = snapshot.content_partition_classes_for_test();
    assert_eq!(classes.len(), 1);
    assert_eq!(classes[0].len(), tracks.len());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn style_observation_windows_ignore_source_identity() {
    let mut first = track("observation-first");
    let mut second = track("observation-second");
    first.start_ms = 7_000;
    first.end_ms = 67_000;
    second.start_ms = first.start_ms;
    second.end_ms = first.end_ms;
    second.music_url = "https://different.example/identity".to_string();
    second.file_path = PathBuf::from("different-source.m4a");

    assert_eq!(audio_style_intervals_for_test(&first).len(), 4);
    assert_eq!(
        audio_style_intervals_for_test(&first),
        audio_style_intervals_for_test(&second)
    );
}

#[test]
fn acoustic_pass_keeps_style_near_nonmatching_fingerprints_separate() {
    let tracks = (0..2)
        .map(|index| track(&format!("acoustic-negative-{index}")))
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_acoustic_embeddings(
        111,
        acoustic_test_values(
            tracks,
            &["style-a", "style-b"],
            vec![vec![0; 16], vec![u32::MAX; 16]],
        ),
    );

    assert_eq!(snapshot.content_partition_classes_for_test().len(), 2);
}

#[test]
fn acoustic_pass_uses_complete_link_instead_of_transitive_chaining() {
    let tracks = (0..3)
        .map(|index| track(&format!("acoustic-chain-{index}")))
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_acoustic_embeddings(
        112,
        acoustic_test_values(
            tracks,
            &["chain-a", "chain-b", "chain-c"],
            vec![vec![0; 16], vec![0x0000_00FF; 16], vec![0x0000_FFFF; 16]],
        ),
    );

    let classes = snapshot.content_partition_classes_for_test();
    assert!(classes.iter().all(|class| class.len() < 3));
    assert_eq!(classes.iter().map(Vec::len).sum::<usize>(), 3);
}

#[test]
fn missing_malformed_and_short_fingerprints_stay_in_base_classes() {
    let tracks = (0..4)
        .map(|index| track(&format!("acoustic-invalid-{index}")))
        .collect::<Vec<_>>();
    let values = vec![
        (
            tracks[0].clone(),
            dense_embedding(&[(0, 1.0)]),
            "missing".to_string(),
            None,
        ),
        (
            tracks[1].clone(),
            dense_embedding(&[(0, 1.0)]),
            "malformed".to_string(),
            Some((0, vec![0; 16])),
        ),
        (
            tracks[2].clone(),
            dense_embedding(&[(0, 1.0)]),
            "short".to_string(),
            Some((60_000, vec![0; 3])),
        ),
        (
            tracks[3].clone(),
            dense_embedding(&[(0, 1.0)]),
            "valid".to_string(),
            Some((60_000, vec![0; 16])),
        ),
    ];
    let snapshot = AudioStyleModelSnapshot::from_test_acoustic_embeddings(113, values);

    assert_eq!(snapshot.content_partition_classes_for_test().len(), 4);
}

#[test]
fn symbolic_partition_signature_is_order_independent_and_membership_sensitive() {
    let tracks = (0..6)
        .map(|index| track(&format!("partition-signature-{index}")))
        .collect::<Vec<_>>();
    let values = tracks
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, track)| {
            let content_key = if index < 2 {
                "shared".to_string()
            } else {
                format!("unique-{index}")
            };
            (track, dense_embedding(&[(index, 1.0)]), content_key)
        })
        .collect::<Vec<_>>();
    let first = AudioStyleModelSnapshot::from_test_content_embeddings(102, values.clone());
    let mut reversed = values.clone();
    reversed.reverse();
    let reordered = AudioStyleModelSnapshot::from_test_content_embeddings(102, reversed);
    let changed = AudioStyleModelSnapshot::from_test_content_embeddings(
        102,
        values
            .into_iter()
            .enumerate()
            .map(|(index, (track, embedding, content_key))| {
                let content_key = if index == 1 {
                    "split-member".to_string()
                } else {
                    content_key
                };
                (track, embedding, content_key)
            }),
    );

    assert_eq!(
        first.symbolic_partition_signature_for_test(),
        reordered.symbolic_partition_signature_for_test()
    );
    assert_ne!(
        first.symbolic_partition_signature_for_test(),
        changed.symbolic_partition_signature_for_test()
    );
}

#[test]
fn extreme_topology_block_uses_sublinear_schedule_capacity() {
    let tracks = (0..48)
        .map(|index| track(&format!("topology-block-{index}")))
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_content_embeddings(
        103,
        tracks.into_iter().enumerate().map(|(index, track)| {
            let embedding = if index < 9 {
                dense_embedding(&[(0, 1.0)])
            } else {
                dense_embedding(&[(index, 1.0)])
            };
            (track, embedding, format!("topology-content-{index}"))
        }),
    );

    let schedule_count = snapshot
        .symbolic_track_count()
        .expect("topology schedule should compile");
    assert!(schedule_count < 48);
    assert!(schedule_count >= 40);
}

#[test]
fn large_content_clusters_keep_their_epoch_mass_across_scope_and_session_continuation() {
    #[derive(Default)]
    struct EpochExposure {
        total: usize,
        main_title: usize,
        chorus: usize,
        carol: usize,
        controls: usize,
    }

    impl EpochExposure {
        fn observe(&mut self, track: &PlaybackTrack) {
            self.total += 1;
            if track.music_name.starts_with("main-title-") {
                self.main_title += 1;
            } else if track.music_name.starts_with("chorus-") {
                self.chorus += 1;
            } else if track.music_name.starts_with("carol-") {
                self.carol += 1;
            } else if track.music_name.starts_with("control-") {
                self.controls += 1;
            }
        }

        fn assert_expected(&self, schedule_count: usize, control_count: usize) {
            assert_eq!(self.total, schedule_count);
            assert_eq!(self.main_title, 1);
            assert_eq!(self.chorus, 1);
            assert_eq!(self.carol, 7);
            assert_eq!(self.controls, control_count);
        }
    }

    let mut values = Vec::new();
    for index in 0..11 {
        values.push((
            track(&format!("main-title-{index}")),
            dense_embedding(&[(0, 1.0)]),
            "main-title-content".to_string(),
        ));
    }
    for index in 0..5 {
        values.push((
            track(&format!("chorus-{index}")),
            dense_embedding(&[(0, 0.999), (200, 0.03)]),
            "chorus-content".to_string(),
        ));
    }
    for index in 0..45 {
        values.push((
            track(&format!("carol-{index}")),
            dense_embedding(&[(1, 1.0)]),
            format!("carol-content-{index}"),
        ));
    }
    for index in 0..80 {
        values.push((
            track(&format!("control-{index}")),
            dense_embedding(&[(2 + index, 1.0)]),
            format!("control-content-{index}"),
        ));
    }
    let tracks = values
        .iter()
        .map(|(track, _, _)| track.clone())
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_content_embeddings(106, values);
    let schedule_count = snapshot
        .symbolic_track_count()
        .expect("large content-collapsed schedule should compile");
    assert_eq!(schedule_count, 89);

    let mut current = tracks
        .iter()
        .find(|track| track.music_name == "control-0")
        .cloned()
        .expect("control anchor should exist");
    let mut recent = vec![current.clone()];
    let mut active_candidates = tracks
        .iter()
        .filter(|track| track.music_name != "control-79")
        .cloned()
        .collect::<Vec<_>>();
    let mut session = AudioStyleSymbolicPlaybackSession::default();
    session.observe_scope_revision(1);
    let mut exposure = EpochExposure::default();
    exposure.observe(&current);
    let mut completed_epochs = 0;
    let mut scope_revision_injected = false;
    let mut committed_session_reloaded = false;

    while completed_epochs < 4 {
        let next = session
            .propose_next(&snapshot, &current, &active_candidates, &recent)
            .expect("large symbolic traversal should remain executable");
        if next.coverage_epoch_transition {
            if completed_epochs == 0 {
                exposure.assert_expected(schedule_count - 1, 79);
            } else {
                exposure.assert_expected(schedule_count, 80);
            }
            completed_epochs += 1;
            exposure = EpochExposure::default();
        }
        exposure.observe(&next.track);
        if completed_epochs == 1 && exposure.total == 20 && !scope_revision_injected {
            active_candidates = tracks.clone();
            session.observe_scope_revision(2);
            scope_revision_injected = true;
        }
        session
            .commit_proposal()
            .expect("large symbolic proposal should commit");
        current = next.track;
        recent.push(current.clone());
        if completed_epochs == 2 && !committed_session_reloaded {
            session = session.committed_snapshot();
            committed_session_reloaded = true;
        }
    }

    assert!(scope_revision_injected);
    assert!(committed_session_reloaded);
}

#[test]
fn symbolic_playback_session_exposes_reusable_materialized_scope() {
    let tracks = (0..6)
        .map(|index| track(&format!("cached-symbolic-{index}")))
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_embeddings(
        90,
        tracks
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, track)| (track, dense_embedding(&[(index, 1.0)]))),
    );
    let mut session = AudioStyleSymbolicPlaybackSession::default();
    session
        .propose_next(&snapshot, &tracks[0], &tracks, &[])
        .expect("symbolic scope should be materialized");
    session
        .commit_proposal()
        .expect("materialized scope proposal should commit");

    let cached = session
        .cached_scope_tracks_for(&snapshot, &tracks[0])
        .expect("same generation and anchor should reuse the materialized scope");
    assert_eq!(cached.len(), tracks.len());
    session.observe_scope_revision(1);
    session.observe_scope_revision(2);
    assert!(
        session
            .cached_scope_tracks_for(&snapshot, &tracks[0])
            .is_none()
    );

    let next_generation = AudioStyleModelSnapshot::from_test_embeddings(
        91,
        tracks
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, track)| (track, dense_embedding(&[(index, 1.0)]))),
    );
    assert!(
        session
            .cached_scope_tracks_for(&next_generation, &tracks[0])
            .is_none()
    );
}

#[test]
fn symbolic_snapshot_drops_pending_proposal_before_persistence() {
    let tracks = (0..6)
        .map(|index| track(&format!("snapshot-symbolic-{index}")))
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_embeddings(
        90,
        tracks
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, track)| (track, dense_embedding(&[(index, 1.0)]))),
    );
    let mut session = AudioStyleSymbolicPlaybackSession::default();
    session
        .propose_next(&snapshot, &tracks[0], &tracks, &[])
        .expect("symbolic proposal should prepare");
    let mut pending_snapshot = session.committed_snapshot();
    let mut fresh = AudioStyleSymbolicPlaybackSession::default();
    let pending_next = pending_snapshot
        .propose_next(&snapshot, &tracks[0], &tracks, &[])
        .expect("persisted committed state should remain usable");
    let fresh_next = fresh
        .propose_next(&snapshot, &tracks[0], &tracks, &[])
        .expect("fresh state should remain usable");
    assert_eq!(pending_next.track.music_url, fresh_next.track.music_url);

    session
        .commit_proposal()
        .expect("symbolic proposal should commit");
    let mut committed = session.committed_snapshot();
    committed
        .propose_next(&snapshot, &pending_next.track, &tracks, &[])
        .expect("committed snapshot should remain usable");
}

#[test]
fn stable_model_refreshes_derived_symbolic_encoding_without_audio_reencoding() {
    let root = temp_cache_root("stable-model-symbolic-refresh");
    std::fs::create_dir_all(&root).expect("stable model test root should be created");
    let path = root.join("stable.json");
    let tracks = (0..4)
        .map(|index| track(&format!("migration-{index}")))
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_indexed_embeddings(
        21,
        tracks.iter().cloned().enumerate().map(|(index, track)| {
            (
                track,
                dense_embedding(&[(index, 1.0)]),
                "migration".to_string(),
            )
        }),
    );
    write_audio_style_stable_model_for_test(&path, &snapshot)
        .expect("stable model should be written");
    let mut payload: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).expect("stable model should be readable"))
            .expect("stable model should be valid JSON");
    payload["state"]["symbolic_program_encoding"]["schema"] =
        serde_json::Value::String("slisic.symbolic-audio-program-encoding.v1".to_string());
    payload["state"]["symbolic_program_encoding"]
        .as_object_mut()
        .expect("symbolic encoding should be an object")
        .remove("partition_signature");
    std::fs::write(
        &path,
        serde_json::to_vec(&payload).expect("stale stable model should encode"),
    )
    .expect("stale stable model should be written");

    let restored = read_and_refresh_audio_style_stable_model_for_test(&path)
        .expect("stale derived encoding should refresh");
    let refreshed_payload: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).expect("refreshed cache should be readable"))
            .expect("refreshed cache should be valid JSON");

    assert_eq!(restored.generation(), 21);
    assert_eq!(restored.symbolic_track_count(), Some(4));
    assert!(tracks.iter().all(|track| restored.has_embedding_for(track)));
    assert_eq!(
        refreshed_payload["version"],
        serde_json::Value::String("audio-style-stable-model-v3".to_string())
    );
    assert!(
        refreshed_payload["state"]["symbolic_program_encoding"].is_object(),
        "refreshed cache should persist the generation-owned symbolic program"
    );
    assert_eq!(
        refreshed_payload["state"]["symbolic_program_encoding"]["schema"],
        serde_json::Value::String("slisic.symbolic-audio-program-encoding.v2".to_string())
    );
    assert!(
        refreshed_payload["state"]["symbolic_program_encoding"]["partition_signature"]
            .as_str()
            .is_some_and(|signature| !signature.is_empty())
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
#[ignore = "requires the current generation-90 stable model and validated finite encoding"]
fn current_stable_model_consumes_validated_symbolic_encoding_without_reconstruction() {
    let migrated_path =
        PathBuf::from(r"C:\Users\admin\AppData\Local\slisic\audio-style-stable-model\stable.json");
    let encoding_path = PathBuf::from(
        r"C:\Users\admin\ann\outputs\audio_style_trajectory_dynamics\generation-90-symbolic-audio-program-encoding-cuda-20260731.json",
    );
    let encoding: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&encoding_path).expect("validated encoding should be readable"),
    )
    .expect("validated encoding should be valid JSON");

    let snapshot = read_audio_style_stable_model_for_test(&migrated_path)
        .expect("production stable loader should admit the Rust migration candidate");
    let signatures = snapshot
        .symbolic_program_signatures_for_test()
        .expect("validated symbolic encoding should remain generation-owned");

    assert_eq!(snapshot.generation(), 90);
    assert_eq!(snapshot.symbolic_track_count(), Some(2_825));
    assert_eq!(
        signatures.1,
        encoding["candidate_relation_signature"]
            .as_str()
            .expect("encoding candidate signature should be a string")
    );
    assert_eq!(
        signatures.2,
        encoding["program_encoding_signature"]
            .as_str()
            .expect("encoding program signature should be a string")
    );
}

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
fn legacy_stable_metadata_requeues_all_indexed_inputs_and_seeds_next_generation() {
    let root = temp_cache_root("legacy-stable-migration");
    std::fs::create_dir_all(&root).expect("legacy migration root should be created");
    let path = root.join("stable.json");
    let indexed_tracks = (0..3)
        .map(|index| {
            let file_path = root.join(format!("legacy-{index}.m4a"));
            let url = format!("https://example.com/legacy-{index}");
            serde_json::json!({
                "key": {
                    "music_url": url,
                    "file_path": file_path.to_string_lossy(),
                    "start_ms": 1000,
                    "end_ms": 61000
                },
                "track": {
                    "playlist_name": "__audio_style_model__",
                    "music_name": format!("Legacy {index}"),
                    "canonical_music_id": format!("legacy-id-{index}"),
                    "music_url": format!("https://example.com/legacy-{index}"),
                    "file_path": file_path.to_string_lossy(),
                    "start_ms": 1000,
                    "end_ms": 61000,
                    "liked": index == 1
                },
                "source": {
                    "collection_folder": "legacy-collection",
                    "music": {
                        "occurrence_id": format!("occurrence-{index}"),
                        "name": format!("Legacy name {index}"),
                        "alias": format!("Legacy alias {index}"),
                        "group": {
                            "name": "legacy-group",
                            "url": "https://example.com/group",
                            "folder": "legacy-group",
                            "collection": {
                                "name": "legacy-collection",
                                "url": "https://example.com/collection",
                                "folder": "legacy-collection",
                                "last_updated": "",
                                "enable_updates": null
                            }
                        },
                        "canonical_music_id": format!("legacy-id-{index}"),
                        "url": format!("https://example.com/legacy-{index}"),
                        "path": file_path.to_string_lossy(),
                        "start_ms": 1000,
                        "end_ms": 61000,
                        "liked": index == 1,
                        "loudness_profile": if index == 0 {
                            serde_json::json!({"integrated_lufs": -15.0})
                        } else {
                            serde_json::Value::Null
                        }
                    }
                }
            })
        })
        .collect::<Vec<_>>();
    std::fs::write(
        &path,
        serde_json::json!({
            "version": "audio-style-stable-model-v2",
            "generation": 162,
            "state": {"indexed_tracks": indexed_tracks}
        })
        .to_string(),
    )
    .expect("legacy stable metadata should be written");
    let original_bytes = std::fs::read(&path).expect("legacy stable bytes should be readable");

    let migrated = read_legacy_audio_style_training_inputs_for_test(&path)
        .expect("legacy metadata should parse")
        .expect("legacy version should be recognized");
    assert_eq!(migrated.0, 162);
    assert_eq!(migrated.1.len(), 3);
    assert_eq!(migrated.1[0].occurrence_id, "occurrence-0");
    assert_eq!(migrated.1[0].alias, "Legacy alias 0");
    assert_eq!(migrated.1[0].canonical_music_id, "legacy-id-0");
    assert_eq!(migrated.1[0].url, "https://example.com/legacy-0");
    assert_eq!(
        migrated.1[0].absolute_path,
        root.join("legacy-0.m4a").to_string_lossy()
    );
    assert_eq!(migrated.1[0].start_ms, 1000);
    assert_eq!(migrated.1[0].end_ms, 61000);
    assert!(!migrated.1[0].liked);
    assert_eq!(
        migrated.1[0]
            .loudness_profile
            .expect("legacy loudness should be preserved")
            .integrated_lufs,
        -15.0
    );
    assert_eq!(migrated.0.saturating_add(1), 163);
    assert_eq!(
        std::fs::read(&path).expect("legacy stable bytes should remain readable"),
        original_bytes
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
    assert!(refreshed.has_embedding_for(&added));

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
    assert!(snapshot.has_embedding_for(&current));
    assert!(snapshot.has_embedding_for(&added_one));
    assert!(snapshot.has_embedding_for(&added_two));

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
    assert!(refreshed.has_embedding_for(&current));
    assert!(refreshed.has_embedding_for(&other));

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
    assert!(refreshed.has_embedding_for(&changed));
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
    assert!(snapshot.has_embedding_for(&first));
    assert!(snapshot.has_embedding_for(&second));
    assert!(snapshot.has_embedding_for(&third));

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
