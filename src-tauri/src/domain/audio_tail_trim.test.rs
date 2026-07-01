use super::{
    AudioTailTrimCandidate, AudioTailTrimFocusMusic, AudioTailTrimRequest, AudioTailTrimScopeKind,
    TailEvidenceFrame, TailEvidenceSignature, audio_style_training_input_from_trimmed_music,
    audio_tail_trim_queue_insert_index_for_test, audio_tail_trim_queue_overflow_action_for_test,
    audio_tail_trim_source_completes_foreground_playable_gate_for_test,
    audio_tail_trim_source_requires_active_rerun_for_test, build_audio_tail_trim_focus_plan,
    build_audio_tail_trim_plan, completed_audio_tail_trim_opens_foreground_playable_gate_for_test,
    detect_common_tail_evidence, merge_audio_tail_trim_request,
    prioritize_audio_tail_trim_focus_candidate, read_audio_tail_trim_pending_task_file_for_test,
    remove_audio_tail_trim_pending_task_from_file_for_test, resolve_audio_tail_trim_evidence,
    select_audio_tail_trim_scope, take_next_audio_tail_trim_candidate,
    upsert_audio_tail_trim_pending_task_file_for_test,
};
use crate::domain::downloads::model::CollectionSourceKind;
use crate::domain::playlists::model::{Collection, CollectionGroupOwner, Group, Music};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_pending_path(test_name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();

    std::env::temp_dir()
        .join(format!(
            "slisic_audio_tail_trim_test_{}_{}",
            std::process::id(),
            nanos
        ))
        .join(test_name)
        .join("audio-tail-trim-pending.json")
}

fn request(collection_url: &str, save_root: &str) -> AudioTailTrimRequest {
    AudioTailTrimRequest {
        collection_url: collection_url.to_string(),
        source_kind: CollectionSourceKind::List,
        save_root: PathBuf::from(save_root),
        scope_group_url: None,
        focus_music: None,
    }
}

fn collection_owner() -> CollectionGroupOwner {
    CollectionGroupOwner {
        name: "Collection".to_string(),
        url: "https://example.com/collection".to_string(),
        folder: "Collection".to_string(),
        last_updated: "now".to_string(),
        enable_updates: None,
    }
}

fn group(url: &str, folder: &str) -> Group {
    Group {
        name: folder.to_string(),
        url: url.to_string(),
        collection: collection_owner(),
        folder: folder.to_string(),
    }
}

fn music(group: &Group, name: &str, path: &str, start_ms: u32, end_ms: u32) -> Music {
    Music {
        occurrence_id: String::new(),
        name: name.to_string(),
        alias: name.to_string(),
        group: group.clone(),
        canonical_music_id: format!("source:https://example.com/{name}:{start_ms}:{end_ms}"),
        url: format!("https://example.com/{name}"),
        path: Some(path.to_string()),
        start_ms,
        end_ms,
        liked: false,
        loudness_profile: None,
    }
}

fn collection_with_musics(musics: Vec<Music>) -> Collection {
    Collection {
        name: "Collection".to_string(),
        url: "https://example.com/collection".to_string(),
        folder: "Collection".to_string(),
        musics,
        last_updated: "now".to_string(),
        enable_updates: None,
    }
}

#[test]
fn trimmed_music_audio_style_training_input_uses_updated_identity() {
    let group = group("https://example.com/group", "Album");
    let mut track = music(&group, "Once", "Once.m4a", 0, 221_100);
    track.end_ms = 187_400;
    track.canonical_music_id = "source:https://example.com/Once:0:187400".to_string();
    let collection = collection_with_musics(vec![track.clone()]);

    let input = audio_style_training_input_from_trimmed_music(
        &PathBuf::from("C:/MusicRoot"),
        &collection,
        &track,
    )
    .expect("trimmed playable music should become a training input");

    assert_eq!(input.canonical_music_id, track.canonical_music_id);
    assert_eq!(input.start_ms, 0);
    assert_eq!(input.end_ms, 187_400);
    assert!(
        input.absolute_path.ends_with("Collection\\Once.m4a")
            || input.absolute_path.ends_with("Collection/Once.m4a")
    );
}

fn unit_vector(index: usize) -> Vec<f32> {
    let mut values = vec![0.0; 6];
    let len = values.len();
    values[index % len] = 1.0;
    values
}

fn normalized(values: &[f32]) -> Vec<f32> {
    let mean = values.iter().sum::<f32>() / values.len() as f32;
    let mut centered = values.iter().map(|value| value - mean).collect::<Vec<_>>();
    let norm = centered
        .iter()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt();
    if norm > 0.0 {
        for value in &mut centered {
            *value /= norm;
        }
    }
    centered
}

fn frame(source_end_ms: u32, bands: Vec<f32>) -> TailEvidenceFrame {
    TailEvidenceFrame {
        source_start_ms: source_end_ms.saturating_sub(1_000),
        source_end_ms,
        rms_db: -12.0,
        bands,
    }
}

fn quiet_frame(source_end_ms: u32, bands: Vec<f32>, rms_db: f32) -> TailEvidenceFrame {
    TailEvidenceFrame {
        source_start_ms: source_end_ms.saturating_sub(1_000),
        source_end_ms,
        rms_db,
        bands,
    }
}

fn signature(prefix_labels: &[usize], tail_labels: &[usize]) -> TailEvidenceSignature {
    let mut labels = tail_labels
        .iter()
        .rev()
        .chain(prefix_labels.iter().rev())
        .copied()
        .collect::<Vec<_>>();
    if labels.is_empty() {
        labels.push(0);
    }
    TailEvidenceSignature {
        frames: labels
            .into_iter()
            .enumerate()
            .map(|(index, label)| frame(90_000 - index as u32 * 500, unit_vector(label)))
            .collect(),
        search_start_ms: 15_000,
        effective_end_ms: 90_000,
        window_ms: 1_000,
        hop_ms: 500,
    }
}

fn fuzzy_signature(prefix_labels: &[usize], tail_vectors: &[Vec<f32>]) -> TailEvidenceSignature {
    let mut frames = tail_vectors
        .iter()
        .rev()
        .cloned()
        .chain(prefix_labels.iter().rev().map(|label| unit_vector(*label)))
        .enumerate()
        .map(|(index, bands)| frame(90_000 - index as u32 * 500, bands))
        .collect::<Vec<_>>();
    if frames.is_empty() {
        frames.push(frame(90_000, unit_vector(0)));
    }
    TailEvidenceSignature {
        frames,
        search_start_ms: 15_000,
        effective_end_ms: 90_000,
        window_ms: 1_000,
        hop_ms: 500,
    }
}

fn signature_with_frames(frames: Vec<TailEvidenceFrame>) -> TailEvidenceSignature {
    TailEvidenceSignature {
        frames,
        search_start_ms: 15_000,
        effective_end_ms: 90_000,
        window_ms: 1_000,
        hop_ms: 500,
    }
}

fn repeated_tail(label: usize, frames: usize) -> Vec<usize> {
    std::iter::repeat_n(label, frames).collect()
}

fn candidate(name: &str, end_ms: u32) -> AudioTailTrimCandidate {
    AudioTailTrimCandidate {
        canonical_music_id: format!("music:{name}:0:{end_ms}"),
        url: format!("https://example.com/{name}"),
        path: format!("{name}.m4a"),
        file_path: PathBuf::from(format!("C:/Music/{name}.m4a")),
        start_ms: 0,
        end_ms,
    }
}

#[test]
fn tail_trim_scope_rejects_single_audio_chapter_group() {
    let album = group("https://example.com/group", "Album");
    let collection = collection_with_musics(vec![
        music(&album, "chapter-1", "album.m4a", 0, 90_000),
        music(&album, "chapter-2", "album.m4a", 90_000, 180_000),
        music(&album, "chapter-3", "album.m4a", 180_000, 270_000),
    ]);
    let candidates =
        super::collect_audio_tail_trim_candidates(&collection, &PathBuf::from("C:/Music"));

    assert_eq!(
        select_audio_tail_trim_scope(&collection, candidates, Some(&album.url)),
        None
    );
}

#[test]
fn tail_trim_scope_prefers_requested_group_over_parent_collection() {
    let focused_group = group("https://example.com/focused", "Focused");
    let other_group = group("https://example.com/other", "Other");
    let collection = collection_with_musics(vec![
        music(&focused_group, "a", "focused/a.m4a", 0, 90_000),
        music(&focused_group, "b", "focused/b.m4a", 0, 90_000),
        music(&focused_group, "c", "focused/c.m4a", 0, 90_000),
        music(&other_group, "d", "other/d.m4a", 0, 90_000),
        music(&other_group, "e", "other/e.m4a", 0, 90_000),
        music(&other_group, "f", "other/f.m4a", 0, 90_000),
    ]);
    let candidates =
        super::collect_audio_tail_trim_candidates(&collection, &PathBuf::from("C:/Music"));

    let scope = select_audio_tail_trim_scope(&collection, candidates, Some(&focused_group.url))
        .expect("multi-file group should be eligible");

    assert_eq!(scope.kind, AudioTailTrimScopeKind::Group);
    assert_eq!(scope.url, focused_group.url);
    assert_eq!(scope.candidates.len(), 3);
    assert_eq!(scope.skipped_collection_candidates, 3);
}

#[test]
fn tail_trim_scope_rejects_parent_collection_when_multiple_groups_exist() {
    let first_group = group("https://example.com/first", "First");
    let second_group = group("https://example.com/second", "Second");
    let collection = collection_with_musics(vec![
        music(&first_group, "a", "first/a.m4a", 0, 90_000),
        music(&first_group, "b", "first/b.m4a", 0, 90_000),
        music(&first_group, "c", "first/c.m4a", 0, 90_000),
        music(&second_group, "d", "second/d.m4a", 0, 90_000),
        music(&second_group, "e", "second/e.m4a", 0, 90_000),
        music(&second_group, "f", "second/f.m4a", 0, 90_000),
    ]);
    let candidates =
        super::collect_audio_tail_trim_candidates(&collection, &PathBuf::from("C:/Music"));

    assert_eq!(
        select_audio_tail_trim_scope(&collection, candidates, None),
        None
    );
}

#[test]
fn pending_audio_tail_trim_tasks_deduplicate_by_collection_scope() {
    let path = temp_pending_path("deduplicate");
    let first = request("https://example.com/list", "C:/Music/Old");
    let replacement = request("https://example.com/list", "C:/Music/New");
    let mut other = request("https://example.com/list", "C:/Music/Other");
    other.scope_group_url = Some("https://example.com/group".to_string());

    upsert_audio_tail_trim_pending_task_file_for_test(&path, &first)
        .expect("first pending task should persist");
    upsert_audio_tail_trim_pending_task_file_for_test(&path, &other)
        .expect("other pending task should persist");
    upsert_audio_tail_trim_pending_task_file_for_test(&path, &replacement)
        .expect("same collection should replace pending cargo");

    assert_eq!(
        read_audio_tail_trim_pending_task_file_for_test(&path)
            .expect("pending tail trim tasks should read"),
        vec![other, replacement]
    );
}

#[test]
fn completed_audio_tail_trim_task_is_removed_from_pending_store() {
    let path = temp_pending_path("remove-completed");
    let completed = request("https://example.com/list", "C:/Music/List");
    let retained = request("https://example.com/other", "C:/Music/Other");

    upsert_audio_tail_trim_pending_task_file_for_test(&path, &completed)
        .expect("completed pending task should persist");
    upsert_audio_tail_trim_pending_task_file_for_test(&path, &retained)
        .expect("retained pending task should persist");
    remove_audio_tail_trim_pending_task_from_file_for_test(&path, &completed)
        .expect("completed task should be removed");

    assert_eq!(
        read_audio_tail_trim_pending_task_file_for_test(&path)
            .expect("pending tail trim tasks should read"),
        vec![retained]
    );
}

#[test]
fn focus_music_moves_matching_candidate_to_front_without_reordering_others() {
    let mut candidates = vec![
        candidate("first", 90_000),
        candidate("second", 90_000),
        candidate("third", 90_000),
    ];
    let focus = AudioTailTrimFocusMusic {
        url: "https://example.com/third".to_string(),
        path: "third.m4a".to_string(),
        start_ms: 0,
        end_ms: 90_000,
    };

    assert!(prioritize_audio_tail_trim_focus_candidate(
        &mut candidates,
        Some(&focus),
    ));

    assert_eq!(candidates[0].path, "third.m4a");
    assert_eq!(candidates[1].path, "first.m4a");
    assert_eq!(candidates[2].path, "second.m4a");
}

#[test]
fn active_focus_selects_matching_candidate_from_remaining_queue() {
    let mut candidates = vec![
        candidate("first", 90_000),
        candidate("second", 90_000),
        candidate("third", 90_000),
    ];
    let focus = AudioTailTrimFocusMusic {
        url: "https://example.com/third".to_string(),
        path: "third.m4a".to_string(),
        start_ms: 0,
        end_ms: 90_000,
    };

    let selected = take_next_audio_tail_trim_candidate(&mut candidates, Some(&focus))
        .expect("focused candidate should be selected");

    assert_eq!(selected.path, "third.m4a");
    assert_eq!(
        candidates
            .iter()
            .map(|candidate| candidate.path.as_str())
            .collect::<Vec<_>>(),
        vec!["first.m4a", "second.m4a"]
    );
}

#[test]
fn focus_plan_trims_only_focused_music_after_common_tail_evidence_exists() {
    let shared_tail = repeated_tail(1, 65);
    let candidates = vec![
        candidate("current", 90_000),
        candidate("second", 90_000),
        candidate("third", 90_000),
    ];
    let signatures = vec![
        signature(&[3, 4], &shared_tail),
        signature(&[4, 3], &shared_tail),
        signature(&[5, 3], &shared_tail),
    ];
    let focus = AudioTailTrimFocusMusic {
        url: "https://example.com/current".to_string(),
        path: "current.m4a".to_string(),
        start_ms: 0,
        end_ms: 90_000,
    };

    let (_evidence, plan) =
        build_audio_tail_trim_focus_plan(&candidates, &signatures, Some(&focus))
            .expect("focused track should be covered by shared tail evidence");

    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].url, "https://example.com/current");
    assert_eq!(plan[0].next_end_ms, 57_000);
}

#[test]
fn merging_collection_cargo_keeps_existing_focus_when_incoming_has_none() {
    let mut existing = request("https://example.com/list", "C:/Music/Old");
    existing.focus_music = Some(AudioTailTrimFocusMusic {
        url: "https://example.com/current".to_string(),
        path: "current.m4a".to_string(),
        start_ms: 0,
        end_ms: 90_000,
    });
    let incoming = request("https://example.com/list", "C:/Music/New");

    let merged = merge_audio_tail_trim_request(existing, incoming);

    assert_eq!(merged.save_root, PathBuf::from("C:/Music/New"));
    assert_eq!(
        merged.focus_music.as_ref().map(|focus| focus.path.as_str()),
        Some("current.m4a")
    );
}

#[test]
fn playback_current_focus_update_preempts_explicit_tail_trim_work() {
    assert_eq!(
        audio_tail_trim_queue_insert_index_for_test(
            &["downloaded_leaf", "pending_store", "pending_store"],
            "playback_current",
        ),
        0
    );
}

#[test]
fn downloaded_leaf_tail_trim_requests_run_before_pending_restore_work() {
    assert_eq!(
        audio_tail_trim_queue_insert_index_for_test(
            &["pending_store", "pending_store"],
            "downloaded_leaf",
        ),
        0
    );
    assert_eq!(
        audio_tail_trim_queue_insert_index_for_test(
            &["playback_current", "downloaded_leaf", "pending_store"],
            "downloaded_leaf_foreground",
        ),
        1
    );
}

#[test]
fn downloaded_leaf_tail_trim_requests_require_active_rerun() {
    assert!(!audio_tail_trim_source_requires_active_rerun_for_test(
        "playback_current"
    ));
    assert!(audio_tail_trim_source_requires_active_rerun_for_test(
        "downloaded_leaf"
    ));
    assert!(audio_tail_trim_source_requires_active_rerun_for_test(
        "downloaded_leaf_foreground"
    ));
    assert!(!audio_tail_trim_source_requires_active_rerun_for_test(
        "pending_store"
    ));
}

#[test]
fn only_foreground_downloaded_tail_trim_completion_opens_the_playable_gate() {
    assert!(!audio_tail_trim_source_completes_foreground_playable_gate_for_test("downloaded_leaf"));
    assert!(
        audio_tail_trim_source_completes_foreground_playable_gate_for_test(
            "downloaded_leaf_foreground"
        )
    );
    assert!(
        !audio_tail_trim_source_completes_foreground_playable_gate_for_test("playback_current")
    );
    assert!(!audio_tail_trim_source_completes_foreground_playable_gate_for_test("pending_store"));
}

#[test]
fn foreground_tail_trim_completion_opens_playable_gate_independent_of_batch_rerun() {
    assert!(
        completed_audio_tail_trim_opens_foreground_playable_gate_for_test(
            "downloaded_leaf_foreground",
            true,
        )
    );
    assert!(
        !completed_audio_tail_trim_opens_foreground_playable_gate_for_test(
            "downloaded_leaf_foreground",
            false,
        )
    );
    assert!(
        !completed_audio_tail_trim_opens_foreground_playable_gate_for_test("downloaded_leaf", true,)
    );
}

#[test]
fn playback_current_focus_update_can_replace_queue_tail_after_explicit_task_match() {
    assert_eq!(
        audio_tail_trim_queue_overflow_action_for_test("playback_current"),
        "drop_tail"
    );
    assert_eq!(
        audio_tail_trim_queue_overflow_action_for_test("downloaded_leaf"),
        "defer"
    );
    assert_eq!(
        audio_tail_trim_queue_overflow_action_for_test("downloaded_leaf_foreground"),
        "defer"
    );
}

#[test]
fn dominant_cluster_beats_tiny_longer_cluster() {
    let dominant_tail = repeated_tail(1, 65);
    let tiny_long_tail = repeated_tail(2, 90);
    let signatures = vec![
        signature(&[3, 4, 5], &dominant_tail),
        signature(&[4, 3, 5], &dominant_tail),
        signature(&[5, 4, 3], &dominant_tail),
        signature(&[3, 5, 4], &dominant_tail),
        signature(&[4, 5, 3], &dominant_tail),
        signature(&[5, 3, 4], &dominant_tail),
        signature(&[0, 3, 4], &tiny_long_tail),
        signature(&[4, 0, 3], &tiny_long_tail),
    ];

    let evidence =
        detect_common_tail_evidence(&signatures).expect("dominant family should be selected");

    assert_eq!(evidence.duration_ms, 33_000);
    assert_eq!(evidence.support, 6);
    assert_eq!(evidence.attached.len(), 6);
    assert!(evidence.density > 0.99);
}

#[test]
fn attached_duration_admits_shorter_but_valid_member() {
    let long_tail = repeated_tail(1, 65);
    let shorter_tail = repeated_tail(1, 63);
    let signatures = vec![
        signature(&[3, 4], &long_tail),
        signature(&[4, 3], &long_tail),
        signature(&[5, 3], &long_tail),
        signature(&[3, 5], &long_tail),
        signature(&[4, 5], &long_tail),
        signature(&[5, 4], &long_tail),
        signature(&[0, 2], &shorter_tail),
    ];

    let evidence =
        detect_common_tail_evidence(&signatures).expect("dominant family should be selected");
    let attached = evidence
        .attached
        .iter()
        .find(|attachment| attachment.index == 6)
        .expect("shorter member should attach to dominant family");

    assert_eq!(evidence.duration_ms, 33_000);
    assert_eq!(attached.duration_ms, 32_000);
}

#[test]
fn no_cluster_when_only_small_sparse_group_exists() {
    let shared_tail = repeated_tail(1, 40);
    let signatures = vec![
        signature(&[3, 4], &shared_tail),
        signature(&[4, 3], &shared_tail),
        signature(&[0, 1], &repeated_tail(2, 40)),
        signature(&[1, 0], &repeated_tail(3, 40)),
        signature(&[2, 0], &repeated_tail(4, 40)),
        signature(&[0, 2], &repeated_tail(5, 40)),
    ];

    assert_eq!(detect_common_tail_evidence(&signatures), None);
}

#[test]
fn reverse_matching_tolerates_fuzzy_spectral_variation() {
    let base = normalized(&[1.0, 2.0, 5.0, 3.0, 2.0, 1.0]);
    let near = normalized(&[1.1, 1.9, 5.1, 3.0, 1.9, 1.1]);
    let near_second = normalized(&[0.9, 2.1, 4.9, 3.1, 2.0, 1.0]);
    let far = normalized(&[5.0, 1.0, 1.0, 1.0, 4.0, 5.0]);
    let tail_a = std::iter::repeat_n(base.clone(), 30).collect::<Vec<_>>();
    let tail_b = std::iter::repeat_n(near, 30).collect::<Vec<_>>();
    let tail_c = std::iter::repeat_n(near_second, 30).collect::<Vec<_>>();
    let tail_d = std::iter::repeat_n(far, 30).collect::<Vec<_>>();
    let signatures = vec![
        fuzzy_signature(&[3, 4], &tail_a),
        fuzzy_signature(&[4, 3], &tail_b),
        fuzzy_signature(&[5, 3], &tail_c),
        fuzzy_signature(&[3, 5], &tail_d),
    ];

    let evidence =
        detect_common_tail_evidence(&signatures).expect("near spectral tails should match");

    assert_eq!(evidence.support, 3);
    assert_eq!(evidence.duration_ms, 16_000);
    assert_eq!(evidence.attached.len(), 3);
}

#[test]
fn trim_plan_uses_per_track_attached_duration_and_respects_safe_remaining_range() {
    let long_tail = repeated_tail(1, 65);
    let shorter_tail = repeated_tail(1, 63);
    let signatures = vec![
        signature(&[3, 4], &long_tail),
        signature(&[4, 3], &long_tail),
        signature(&[5, 3], &long_tail),
        signature(&[3, 5], &long_tail),
        signature(&[4, 5], &long_tail),
        signature(&[5, 4], &long_tail),
        signature(&[0, 2], &shorter_tail),
    ];
    let candidates = vec![
        candidate("first", 90_000),
        candidate("second", 90_000),
        candidate("third", 90_000),
        candidate("fourth", 90_000),
        candidate("fifth", 90_000),
        candidate("too-short", 45_000),
        candidate("shorter-attached", 90_000),
    ];
    let evidence = resolve_audio_tail_trim_evidence(&signatures)
        .expect("full collection evidence should own commit duration")
        .evidence;

    let plan = build_audio_tail_trim_plan(&candidates, &signatures, &evidence);

    assert_eq!(plan.len(), 6);
    assert_eq!(plan[0].url, "https://example.com/first");
    assert_eq!(plan[0].next_end_ms, 57_000);
    assert!(
        plan.iter()
            .all(|trim| trim.url != "https://example.com/too-short")
    );
    let shorter = plan
        .iter()
        .find(|trim| trim.url == "https://example.com/shorter-attached")
        .expect("shorter attached tail should be trimmed with its own duration");
    assert_eq!(shorter.next_end_ms, 58_000);
}

#[test]
fn trim_plan_refines_common_tail_start_to_nearest_quiet_boundary() {
    let tail = repeated_tail(1, 65);
    let mut signatures = vec![
        signature(&[3, 4], &tail),
        signature(&[4, 3], &tail),
        signature(&[5, 3], &tail),
        signature(&[3, 5], &tail),
        signature(&[4, 5], &tail),
    ];
    signatures.insert(
        0,
        signature_with_frames(
            (0..65)
                .map(|index| {
                    let end_ms = 90_000 - index * 500;
                    quiet_frame(end_ms, unit_vector(1), -12.0)
                })
                .chain([
                    quiet_frame(56_500, unit_vector(3), -50.0),
                    quiet_frame(56_000, unit_vector(4), -18.0),
                ])
                .collect(),
        ),
    );
    let mut candidates = vec![
        candidate("focused", 90_000),
        candidate("first", 90_000),
        candidate("second", 90_000),
        candidate("third", 90_000),
        candidate("fourth", 90_000),
        candidate("fifth", 90_000),
    ];
    candidates[0].canonical_music_id = "music:focused:0:90000".to_string();
    let evidence = resolve_audio_tail_trim_evidence(&signatures)
        .expect("full collection evidence should own commit duration")
        .evidence;

    let plan = build_audio_tail_trim_plan(&candidates, &signatures, &evidence);

    let focused = plan
        .iter()
        .find(|trim| trim.url == "https://example.com/focused")
        .expect("focused member should be trimmed");
    assert_eq!(focused.next_end_ms, 56_500);
}

#[test]
fn trim_plan_moves_edge_quiet_window_before_tail_reentry() {
    let tail = repeated_tail(1, 65);
    let mut signatures = vec![
        signature(&[3, 4], &tail),
        signature(&[4, 3], &tail),
        signature(&[5, 3], &tail),
        signature(&[3, 5], &tail),
        signature(&[4, 5], &tail),
    ];
    signatures.insert(
        0,
        signature_with_frames(
            (0..65)
                .map(|index| {
                    let end_ms = 90_000 - index * 500;
                    quiet_frame(end_ms, unit_vector(1), -12.0)
                })
                .chain([
                    quiet_frame(56_500, unit_vector(3), -45.0),
                    quiet_frame(56_000, unit_vector(4), -18.0),
                ])
                .into_iter()
                .collect(),
        ),
    );
    let mut candidates = vec![
        candidate("focused", 90_000),
        candidate("first", 90_000),
        candidate("second", 90_000),
        candidate("third", 90_000),
        candidate("fourth", 90_000),
        candidate("fifth", 90_000),
    ];
    candidates[0].canonical_music_id = "music:focused:0:90000".to_string();
    let evidence = resolve_audio_tail_trim_evidence(&signatures)
        .expect("full collection evidence should own commit duration")
        .evidence;

    let plan = build_audio_tail_trim_plan(&candidates, &signatures, &evidence);

    let focused = plan
        .iter()
        .find(|trim| trim.url == "https://example.com/focused")
        .expect("focused member should be trimmed");
    assert_eq!(focused.next_end_ms, 55_500);
}
