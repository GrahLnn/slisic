use super::symbolic_program::{
    NeuralProgramAtlas, NormalFatigueAuxiliary, ProgramList, ProgramMorphism, TraversalExhausted,
    apply_program_transposition, candidate_neighborhood_overlaps,
    candidate_relation_from_program_atlas, candidate_relation_signature,
    close_neural_program_atlas_cycles, compile_neural_program_atlas, compile_program_orbit_index,
    execute_program_list, fatigue_carrier_score_for_test, form_neural_adaptation_cycle,
    initialize_traversal_state, normal_fatigue_auxiliary, ordered_track_key_signature,
    program_encoding_signature, restrict_neural_program_atlas_to_playlist,
    source_fatigue_allows_transposition, transport_traversal_state,
};

use serde::Deserialize;
use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Deserialize)]
struct NativeRegionCoreFixture {
    schema: String,
    package_identity: String,
    input_identities: HashMap<String, InputIdentity>,
    expected_domain: Vec<usize>,
    cycle: Vec<usize>,
    successors: Vec<usize>,
    predecessors: Vec<usize>,
    class_source: Vec<String>,
    class_basin: Vec<String>,
    epoch0_basin: Vec<String>,
    baseline_source_score: FixtureSourceScore,
    lookup: Vec<[u128; 4]>,
}

#[derive(Debug, Deserialize)]
struct InputIdentity {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct FixtureSourceScore {
    event_count: usize,
    short_returns: usize,
    gap_sum: usize,
    minimum_recovery: usize,
    recovery_pressures: [u128; 4],
}

type SourceScoreTuple = (usize, usize, usize, usize, [u128; 4]);

fn score_non_regressed(proposed: SourceScoreTuple, baseline: SourceScoreTuple) -> bool {
    proposed.0 >= baseline.0
        && proposed.1 as u128 * baseline.2 as u128 <= baseline.1 as u128 * proposed.2 as u128
        && proposed
            .4
            .iter()
            .zip(baseline.4)
            .all(|(pressure, baseline_pressure)| {
                *pressure * baseline.2 as u128 <= baseline_pressure * proposed.2 as u128
            })
}

fn load_native_region_fixture() -> NativeRegionCoreFixture {
    let fixture: NativeRegionCoreFixture = serde_json::from_str(include_str!(
        "fixtures/native-region-core-generation163.json"
    ))
    .unwrap_or_else(|error| panic!("native-region-core-v4 fixture should be valid JSON: {error}"));
    assert_eq!(fixture.schema, "slisic.native-region-core-v4.fixture.v1");
    assert_eq!(fixture.package_identity, "native-region-core-v4");
    assert_eq!(fixture.cycle.len(), 3_148);
    assert_eq!(fixture.successors.len(), fixture.cycle.len());
    assert_eq!(fixture.predecessors.len(), fixture.cycle.len());
    assert_eq!(fixture.class_source.len(), fixture.cycle.len());
    assert_eq!(fixture.class_basin.len(), fixture.cycle.len());
    assert_eq!(fixture.epoch0_basin.len(), fixture.cycle.len());
    assert_eq!(
        fixture.expected_domain,
        (0..fixture.cycle.len()).collect::<Vec<_>>()
    );
    let mut sorted_cycle = fixture.cycle.clone();
    sorted_cycle.sort_unstable();
    assert_eq!(sorted_cycle, fixture.expected_domain);
    for position in 0..fixture.cycle.len() {
        assert_eq!(
            fixture.successors[fixture.cycle[position]],
            fixture.cycle[(position + 1) % fixture.cycle.len()]
        );
    }
    for (source, destination) in fixture.successors.iter().copied().enumerate() {
        assert_eq!(fixture.predecessors[destination], source);
    }
    assert_eq!(fixture.lookup.len(), fixture.cycle.len() + 1);
    let stable = fixture
        .input_identities
        .get("stable")
        .expect("fixture should retain the stable loader identity");
    assert!(
        stable
            .path
            .ends_with("audio-style-stable-model\\stable.json")
    );
    assert_eq!(stable.bytes, 133_038_870);
    assert_eq!(
        stable.sha256,
        "C96FA71CD7C3BBCA81191C2E8BD72956EB2C4329A748D89C5DBA8AC88CC6FAC3"
    );
    assert_eq!(
        fixture.input_identities.get("native").unwrap().bytes,
        13_229_723
    );
    assert_eq!(
        fixture
            .input_identities
            .get("liked_baseline")
            .unwrap()
            .bytes,
        3_938_929
    );
    assert_eq!(fixture.input_identities.get("mc").unwrap().bytes, 2_646_309);
    assert_eq!(fixture.baseline_source_score.event_count, 2_774);
    assert_eq!(fixture.baseline_source_score.short_returns, 301);
    assert_eq!(fixture.baseline_source_score.minimum_recovery, 3);
    assert_eq!(
        fixture.baseline_source_score.recovery_pressures,
        [
            39_045_993_915_806_747,
            93_217_300_330_119_321,
            167_125_276_831_151_932,
            260_389_930_702_108_042
        ]
    );
    fixture
}

fn fixture_source_ordinals(labels: &[String]) -> Vec<usize> {
    let mut ids = HashMap::<&str, usize>::new();
    labels
        .iter()
        .map(|label| {
            let next = ids.len();
            *ids.entry(label.as_str()).or_insert(next)
        })
        .collect()
}

fn fixture_source_score(fixture: &NativeRegionCoreFixture) -> SourceScoreTuple {
    (
        fixture.baseline_source_score.minimum_recovery,
        fixture.baseline_source_score.short_returns,
        fixture.baseline_source_score.event_count,
        fixture.baseline_source_score.gap_sum,
        fixture.baseline_source_score.recovery_pressures,
    )
}

fn cycle_atlas(track_count: usize, boundary_sources: Vec<usize>) -> NeuralProgramAtlas {
    NeuralProgramAtlas {
        track_count,
        candidate_count: track_count,
        programs: vec![ProgramMorphism {
            lineage: "program:test-cycle".to_string(),
            presentation_ordinals: vec![0],
            successors: (0..track_count)
                .map(|source| (source + 1) % track_count)
                .collect(),
            boundary_sources,
        }],
    }
}

fn two_full_cycle_atlas() -> NeuralProgramAtlas {
    NeuralProgramAtlas {
        track_count: 4,
        candidate_count: 4,
        programs: vec![
            ProgramMorphism {
                lineage: "program:test-cycle-0".to_string(),
                presentation_ordinals: vec![0],
                successors: vec![1, 2, 3, 0],
                boundary_sources: Vec::new(),
            },
            ProgramMorphism {
                lineage: "program:test-cycle-1".to_string(),
                presentation_ordinals: vec![1],
                successors: vec![2, 3, 0, 1],
                boundary_sources: Vec::new(),
            },
        ],
    }
}

fn native_fixture_atlas(fixture: &NativeRegionCoreFixture) -> NeuralProgramAtlas {
    NeuralProgramAtlas {
        track_count: fixture.cycle.len(),
        candidate_count: fixture.cycle.len(),
        programs: vec![ProgramMorphism {
            lineage: "program:native-region-core-v4".to_string(),
            presentation_ordinals: vec![0],
            successors: fixture.successors.clone(),
            boundary_sources: Vec::new(),
        }],
    }
}

fn sigma_for_test(node: usize, left: usize, right: usize) -> usize {
    if node == left {
        right
    } else if node == right {
        left
    } else {
        node
    }
}

fn choose_actual_candidate(
    fixture: &NativeRegionCoreFixture,
    atlas: &NeuralProgramAtlas,
    list: &mut ProgramList,
    source_ordinals: &[usize],
    distinct_source: Option<bool>,
    candidate_trials: &mut usize,
) -> Option<usize> {
    let planned = list.order[0];
    let planned_pair = (
        &fixture.class_basin[planned],
        &fixture.epoch0_basin[planned],
    );
    for candidate in 0..atlas.track_count {
        *candidate_trials += 1;
        if candidate == planned
            || list.next_state.is_track_realized(0, candidate) != Some(false)
            || (
                &fixture.class_basin[candidate],
                &fixture.epoch0_basin[candidate],
            ) != planned_pair
            || distinct_source.is_some_and(|want| {
                (source_ordinals[candidate] != source_ordinals[planned]) != want
            })
        {
            continue;
        }
        let program = list.program_ordinals[0];
        if source_fatigue_allows_transposition(
            atlas,
            &mut list.next_state,
            0,
            program,
            planned,
            candidate,
            source_ordinals,
        )
        .expect("actual source-fatigue candidate should have aligned coordinates")
        {
            return Some(candidate);
        }
    }
    None
}

fn synthetic_relation() -> (Vec<String>, Vec<usize>) {
    (
        ["track:a", "track:b", "track:c", "track:d"]
            .into_iter()
            .map(str::to_string)
            .collect(),
        vec![1, 2, 3, 2, 3, 0, 3, 0, 1, 0, 1, 2],
    )
}

fn residence_departure_atlas() -> NeuralProgramAtlas {
    NeuralProgramAtlas {
        track_count: 6,
        candidate_count: 3,
        programs: vec![
            ProgramMorphism {
                lineage: "program:0".to_string(),
                presentation_ordinals: vec![0],
                successors: vec![1, 0, 3, 2, 5, 4],
                boundary_sources: Vec::new(),
            },
            ProgramMorphism {
                lineage: "program:1".to_string(),
                presentation_ordinals: vec![1],
                successors: vec![1, 2, 3, 4, 5, 0],
                boundary_sources: Vec::new(),
            },
            ProgramMorphism {
                lineage: "program:2".to_string(),
                presentation_ordinals: vec![2],
                successors: vec![2, 4, 3, 0, 5, 1],
                boundary_sources: Vec::new(),
            },
        ],
    }
}

#[test]
fn finite_program_signatures_are_content_owned() {
    // @forma observes observation Domain.CrossRuntimeProgramEncoding
    let (keys, neighbors) = synthetic_relation();
    let atlas = compile_neural_program_atlas(&keys, 3, &neighbors)
        .unwrap()
        .atlas
        .unwrap();

    assert_eq!(
        ordered_track_key_signature(&keys),
        "audio-track-order:9f426d36d59fd5921d1219d344ce64c0a7c912420871e593ee7cce0c6a3c0a5d"
    );
    assert_eq!(
        candidate_relation_signature(&keys, 3, &neighbors).unwrap(),
        "audio-candidate-relation:e261d486c052e183ff62171e28aacc6133917960c44efc6bfde904473ad8306a"
    );
    assert_eq!(
        program_encoding_signature(&atlas.programs),
        "audio-program-encoding:66cb0c22d9303c612141bfba5f4d9cdbf13c051c4489426b6f65fd4673364130"
    );
}

#[test]
fn candidate_presentations_compile_to_complete_bijections() {
    let (keys, neighbors) = synthetic_relation();

    let result = compile_neural_program_atlas(&keys, 3, &neighbors).unwrap();
    let atlas = result.atlas.unwrap();

    assert!(result.unclosed_presentations.is_empty());
    assert_eq!(atlas.programs.len(), 3);
    for program in atlas.programs {
        let mut successors = program.successors.clone();
        successors.sort_unstable();
        assert_eq!(successors, vec![0, 1, 2, 3]);
    }
}

#[test]
fn missing_complete_matching_is_an_explicit_unclosed_branch() {
    let keys = ["a", "b", "c", "d"]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let neighbors = vec![1, 2, 0, 2, 0, 1, 0, 1];

    let result = compile_neural_program_atlas(&keys, 2, &neighbors).unwrap();

    assert!(result.atlas.is_none());
    assert!(!result.unclosed_presentations.is_empty());
}

#[test]
fn residence_continues_until_repetition_then_future_obstruction_departs() {
    // @forma observes observation Domain.StyleProgramResidenceObservation
    // @forma observes observation Domain.StyleProgramFatigueObservation
    // @forma observes observation Domain.PostFatigueNoveltyObservation
    let atlas = residence_departure_atlas();
    let orbits = compile_program_orbit_index(&atlas).unwrap();
    let state = initialize_traversal_state(&atlas, &[0]).unwrap();

    let played = execute_program_list(&atlas, &orbits, 3, &state).unwrap();

    assert_eq!(played.order, vec![1, 4, 5]);
    assert_eq!(played.program_ordinals, vec![0, 2, 2]);
    assert_eq!(played.departures, vec![false, true, false]);
    assert_eq!(played.departure_future_overlap, vec![None, Some(1), None]);
    assert_eq!(played.next_state.playback_cycle, 1);
}

#[test]
fn program_history_survives_list_boundary_while_reset_replays() {
    // @forma observes observation Domain.ProgramOwnedTraversalState
    let atlas = residence_departure_atlas();
    let orbits = compile_program_orbit_index(&atlas).unwrap();
    let initial = initialize_traversal_state(&atlas, &[0]).unwrap();

    let first = execute_program_list(&atlas, &orbits, 2, &initial).unwrap();
    let persistent = execute_program_list(&atlas, &orbits, 1, &first.next_state).unwrap();
    let reset = execute_program_list(&atlas, &orbits, 2, &initial).unwrap();

    assert_eq!(first.order, vec![1, 4]);
    assert_eq!(persistent.order, vec![5]);
    assert_eq!(reset.order, first.order);
    assert_eq!(persistent.next_state.playback_cycle, 2);
}

#[test]
fn exhausted_unread_successors_fail_closed() {
    // @forma observes observation Domain.ExplicitFailureBranch
    let atlas = residence_departure_atlas();
    let orbits = compile_program_orbit_index(&atlas).unwrap();
    let initial = initialize_traversal_state(&atlas, &[0]).unwrap();

    let error = execute_program_list(&atlas, &orbits, 4, &initial).unwrap_err();

    assert_eq!(
        error,
        TraversalExhausted {
            path_ordinal: 0,
            current_track: 5,
        }
    );
}

#[test]
fn one_cycle_first_return_matches_reference_for_all_partial_histories_and_anchors() {
    let track_count = 6;
    let atlas = cycle_atlas(track_count, Vec::new());
    let orbit_index = compile_program_orbit_index(&atlas).unwrap();

    for anchor in 0..track_count {
        for subset in 1_usize..(1_usize << track_count) - 1 {
            if subset & (1_usize << anchor) == 0 {
                continue;
            }
            let realized = (0..track_count)
                .filter(|track| subset & (1_usize << track) != 0)
                .collect::<Vec<_>>();
            let state =
                transport_traversal_state(None, &atlas, &[anchor], std::slice::from_ref(&realized))
                    .unwrap();
            let mut expected = anchor;
            let mut skipped = false;
            for _ in 0..track_count {
                expected = (expected + 1) % track_count;
                if !realized.contains(&expected) {
                    break;
                }
                skipped = true;
            }

            let list = execute_program_list(&atlas, &orbit_index, 1, &state).unwrap();

            assert_eq!(list.order, vec![expected]);
            assert_eq!(list.departures[0], skipped);
            assert_eq!(
                list.next_state.realized_tracks(0).unwrap().len(),
                realized.len() + 1
            );
            assert!(list.next_state.is_track_realized(0, expected).unwrap());
            assert_eq!(list.next_state.coverage_epoch(0), Some(0));
        }
    }
}

#[test]
fn first_return_follows_same_atlas_conjugated_overlay_and_preserves_history() {
    let atlas = cycle_atlas(5, Vec::new());
    let orbit_index = compile_program_orbit_index(&atlas).unwrap();
    let initial = initialize_traversal_state(&atlas, &[0]).unwrap();
    let first = execute_program_list(&atlas, &orbit_index, 1, &initial).unwrap();
    let mut swapped = first;
    apply_program_transposition(&atlas, &orbit_index, &mut swapped, 0, 1, 2).unwrap();
    let current = transport_traversal_state(
        Some((&atlas, &swapped.next_state)),
        &atlas,
        &[1],
        &[vec![1, 3]],
    )
    .unwrap();

    assert_eq!(current.overlay_program_for_test(0), Some(0));
    assert_eq!(
        current.effective_successor_for_test(&atlas, 0, 0, 1),
        Some(3)
    );
    let list = execute_program_list(&atlas, &orbit_index, 1, &current).unwrap();

    assert_eq!(list.order, vec![4]);
    assert_eq!(list.departures, vec![true]);
    assert_eq!(list.style_sector_departures, vec![true]);
    assert_eq!(list.coverage_epoch_transitions, vec![false]);
    assert_eq!(list.next_state.realized_tracks(0).unwrap(), vec![1, 3, 4]);
}

#[test]
fn neural_adaptation_forms_local_chunks_then_preserves_complete_coverage() {
    let mut atlas = NeuralProgramAtlas {
        track_count: 4,
        candidate_count: 4,
        programs: vec![ProgramMorphism {
            lineage: "program:alternating".to_string(),
            presentation_ordinals: vec![0],
            successors: vec![1, 2, 3, 0],
            boundary_sources: Vec::new(),
        }],
    };
    let neighbors = (0..4).flat_map(|_| 0..4).collect::<Vec<_>>();
    let acoustic_basins = [0, 1, 0, 1];
    let source_collections = [0, 1, 0, 1];
    let original = atlas.programs[0].successors.clone();

    // This is the smallest finite restriction that exercises an accepted local
    // chunk splice while retaining the independently reconstructed fatigue
    // ceiling. The generation-163 ANN consumer is covered separately by its
    // opt-in real-model receipt, not by this synthetic carrier restriction.
    assert!(
        form_neural_adaptation_cycle(
            &mut atlas,
            &neighbors,
            &track_keys(4),
            &acoustic_basins,
            &source_collections,
        )
        .unwrap()
    );

    let formed = &atlas.programs[0].successors;
    assert_eq!(successor_cycle_count(formed), 1);
    assert!(formed.iter().enumerate().all(|(source, destination)| {
        neighbors[source * 4..(source + 1) * 4].contains(destination)
    }));
    let local_edges = |successors: &[usize]| {
        successors
            .iter()
            .enumerate()
            .filter(|(source, destination)| {
                acoustic_basins[*source] == acoustic_basins[**destination]
            })
            .count()
    };
    assert!(local_edges(formed) > local_edges(&original));

    let orbits = compile_program_orbit_index(&atlas).unwrap();
    let initial = initialize_traversal_state(&atlas, &[0]).unwrap();
    let list = execute_program_list(&atlas, &orbits, 3, &initial).unwrap();
    assert_eq!(list.next_state.realized_tracks(0), Some((0..4).collect()));
}

#[test]
fn neural_adaptation_rejects_local_chunks_beyond_ungated_ceiling() {
    let mut atlas = NeuralProgramAtlas {
        track_count: 8,
        candidate_count: 8,
        programs: vec![ProgramMorphism {
            lineage: "program:alternating".to_string(),
            presentation_ordinals: vec![0],
            successors: vec![1, 2, 3, 4, 5, 6, 7, 0],
            boundary_sources: Vec::new(),
        }],
    };
    let neighbors = (0..8).flat_map(|_| 0..8).collect::<Vec<_>>();
    let acoustic_basins = [0, 1, 0, 1, 0, 1, 0, 1];
    let source_collections = [0, 1, 0, 1, 0, 1, 0, 1];
    let original = atlas.clone();

    // The normal-assisted candidate gains local edges and meets recovery, but
    // its maximum local run is four while the ungated ceiling is three. The
    // public formation gate must reject it without mutating the atlas.
    assert!(
        !form_neural_adaptation_cycle(
            &mut atlas,
            &neighbors,
            &track_keys(8),
            &acoustic_basins,
            &source_collections,
        )
        .unwrap()
    );
    assert_eq!(atlas, original);
}

#[test]
fn uniform_fatigue_carriers_leave_the_complete_cycle_unchanged() {
    let mut atlas = NeuralProgramAtlas {
        track_count: 4,
        candidate_count: 4,
        programs: vec![ProgramMorphism {
            lineage: "program:uniform".to_string(),
            presentation_ordinals: vec![0],
            successors: vec![1, 2, 3, 0],
            boundary_sources: Vec::new(),
        }],
    };
    let neighbors = (0..4).flat_map(|_| 0..4).collect::<Vec<_>>();
    let original = atlas.clone();

    assert!(
        !form_neural_adaptation_cycle(&mut atlas, &neighbors, &track_keys(4), &[0; 4], &[0; 4],)
            .unwrap()
    );
    assert_eq!(atlas, original);
}

#[test]
fn normal_auxiliary_chooses_direct_or_requests_local_without_owning_fatigue() {
    let keys = track_keys(7);

    assert_eq!(
        normal_fatigue_auxiliary(&keys, (2, 3, 4, 5, 6)),
        NormalFatigueAuxiliary::DirectStyleJump
    );
    assert_eq!(
        normal_fatigue_auxiliary(&keys, (0, 1, 2, 3, 4)),
        NormalFatigueAuxiliary::RequestLocalAuditoryChunk
    );
}

#[test]
fn candidate_cycle_cover_closes_to_path_fair_single_cycles() {
    let source = NeuralProgramAtlas {
        candidate_count: 5,
        ..residence_departure_atlas()
    };
    let neighbors = (0..6)
        .flat_map(|source| (0..6).filter(move |destination| *destination != source))
        .collect::<Vec<_>>();

    let result = close_neural_program_atlas_cycles(&source, &neighbors, &track_keys(6)).unwrap();
    let atlas = result.atlas.unwrap();

    assert!(result.retracted_presentations.is_empty());
    assert!(
        atlas
            .programs
            .iter()
            .all(|program| successor_cycle_count(&program.successors) == 1)
    );
    assert!(
        atlas
            .programs
            .iter()
            .all(|program| program.boundary_sources.is_empty())
    );
}

#[test]
fn style_sector_boundaries_require_positive_local_contrast() {
    let fixture = residence_departure_atlas();
    let atlas = NeuralProgramAtlas {
        track_count: 6,
        candidate_count: 4,
        programs: vec![fixture.programs[0].clone()],
    };
    let neighbors = vec![
        1, 2, 3, 4, 0, 2, 3, 4, 3, 4, 5, 0, 2, 4, 5, 1, 5, 0, 1, 2, 4, 0, 1, 3,
    ];

    let result = close_neural_program_atlas_cycles(&atlas, &neighbors, &track_keys(6)).unwrap();
    let program = &result.atlas.unwrap().programs[0];
    let overlaps = candidate_neighborhood_overlaps(6, 4, &neighbors).unwrap();
    let overlap_by_destination = (0..6)
        .map(|source| {
            neighbors[source * 4..(source + 1) * 4]
                .iter()
                .copied()
                .zip(overlaps[source * 4..(source + 1) * 4].iter().copied())
                .collect::<std::collections::HashMap<_, _>>()
        })
        .collect::<Vec<_>>();

    assert!(!program.boundary_sources.is_empty());
    assert!(program.boundary_sources.iter().all(|source| {
        overlap_by_destination[*source][&program.successors[*source]]
            < overlap_by_destination[*source][&fixture.programs[0].successors[*source]]
    }));
}

#[test]
fn playlist_scope_reifies_all_generation_owned_presentations() {
    // @forma observes observation Domain.CrossRuntimeScopedBoundaryNaturality
    let (keys, neighbors) = synthetic_relation();
    let global = compile_neural_program_atlas(&keys, 3, &neighbors)
        .unwrap()
        .atlas
        .unwrap();
    let scoped = restrict_neural_program_atlas_to_playlist(&global, &keys, &[0, 1, 2]).unwrap();

    let candidates = candidate_relation_from_program_atlas(&scoped.atlas).unwrap();

    assert_eq!(candidates.len(), 9);
    for presentation in 0..3 {
        let owner = scoped
            .atlas
            .programs
            .iter()
            .find(|program| program.presentation_ordinals.contains(&presentation))
            .unwrap();
        assert_eq!(
            (0..3)
                .map(|source| candidates[source * 3 + presentation])
                .collect::<Vec<_>>(),
            owner.successors
        );
    }
}

#[test]
fn complete_coverage_transports_to_nonreset_program_epoch() {
    let source = NeuralProgramAtlas {
        candidate_count: 5,
        ..residence_departure_atlas()
    };
    let neighbors = (0..6)
        .flat_map(|source| (0..6).filter(move |destination| *destination != source))
        .collect::<Vec<_>>();
    let closed = close_neural_program_atlas_cycles(&source, &neighbors, &track_keys(6))
        .unwrap()
        .atlas
        .unwrap();
    let scoped = restrict_neural_program_atlas_to_playlist(&closed, &track_keys(6), &[0, 2, 4])
        .unwrap()
        .atlas;
    let orbits = compile_program_orbit_index(&scoped).unwrap();
    let initial = initialize_traversal_state(&scoped, &[0, 1, 2]).unwrap();

    let first = execute_program_list(&scoped, &orbits, 2, &initial).unwrap();
    let second = execute_program_list(&scoped, &orbits, 2, &first.next_state).unwrap();
    let reset = execute_program_list(&scoped, &orbits, 2, &initial).unwrap();

    assert_eq!(
        second.coverage_epoch_transitions,
        vec![true, false, true, false, true, false]
    );
    assert_ne!(second.order, reset.order);
    for step in 0..2 {
        let values = (0..3)
            .map(|path| second.order[path * 2 + step])
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(values.len(), 3);
    }
}

#[test]
fn state_transport_preserves_program_incidence_and_realized_history() {
    let atlas = residence_departure_atlas();
    let orbits = compile_program_orbit_index(&atlas).unwrap();
    let initial = initialize_traversal_state(&atlas, &[0]).unwrap();
    let first = execute_program_list(&atlas, &orbits, 2, &initial).unwrap();
    let direct = execute_program_list(&atlas, &orbits, 1, &first.next_state).unwrap();
    let transported = transport_traversal_state(
        Some((&atlas, &first.next_state)),
        &atlas,
        &[*first.order.last().unwrap()],
        &[vec![0, first.order[0], first.order[1]]],
    )
    .unwrap();
    let resumed = execute_program_list(&atlas, &orbits, 1, &transported).unwrap();

    assert_eq!(resumed.order, direct.order);
    assert_eq!(resumed.program_ordinals, direct.program_ordinals);
    assert_eq!(
        resumed.next_state.playback_cycle,
        direct.next_state.playback_cycle
    );
}

#[test]
fn native_region_core_v4_initial_cache_matches_old_native_score() {
    let fixture = load_native_region_fixture();
    let atlas = native_fixture_atlas(&fixture);
    let source_ordinals = fixture_source_ordinals(&fixture.class_source);
    let mut state = initialize_traversal_state(&atlas, &[fixture.cycle[0]]).unwrap();

    let left = fixture.cycle[0];
    let right = fixture.cycle[1];
    let _ = source_fatigue_allows_transposition(
        &atlas,
        &mut state,
        0,
        0,
        left,
        right,
        &source_ordinals,
    )
    .unwrap();

    let (_, initial) = state
        .source_fatigue_baselines_for_test(0)
        .expect("the first source guard trial should initialize its cache");
    let expected = fatigue_carrier_score_for_test(&fixture.cycle, &source_ordinals);
    assert_eq!(expected, fixture_source_score(&fixture));
    assert_eq!(initial, expected);
}

#[test]
fn native_region_core_v4_admitted_actual_swaps_match_old_full_score() {
    let fixture = load_native_region_fixture();
    let atlas = native_fixture_atlas(&fixture);
    let orbit_index = compile_program_orbit_index(&atlas).unwrap();
    let source_ordinals = fixture_source_ordinals(&fixture.class_source);
    let initial_score = fixture_source_score(&fixture);
    let mut state = initialize_traversal_state(&atlas, &[fixture.cycle[0]]).unwrap();
    let mut same_source_swaps = 0;
    let mut distinct_source_swaps = 0;
    let mut accepted_swaps = 0;
    let mut candidate_trials = 0;
    let mut core_elapsed_nanos = 0_u128;
    let started = Instant::now();

    for _ in 0..fixture.cycle.len() {
        let event_started = Instant::now();
        let mut list = execute_program_list(&atlas, &orbit_index, 1, &state).unwrap();
        let prefer_distinct = (distinct_source_swaps == 0).then_some(true);
        let prefer_same = (same_source_swaps == 0).then_some(false);
        let candidate = choose_actual_candidate(
            &fixture,
            &atlas,
            &mut list,
            &source_ordinals,
            prefer_distinct.or(prefer_same),
            &mut candidate_trials,
        )
        .or_else(|| {
            choose_actual_candidate(
                &fixture,
                &atlas,
                &mut list,
                &source_ordinals,
                None,
                &mut candidate_trials,
            )
        });
        if let Some(candidate) = candidate {
            let planned = list.order[0];
            if source_ordinals[planned] == source_ordinals[candidate] {
                same_source_swaps += 1;
            } else {
                distinct_source_swaps += 1;
            }
            apply_program_transposition(&atlas, &orbit_index, &mut list, 0, planned, candidate)
                .unwrap();
            state = list.next_state;
            accepted_swaps += 1;
            core_elapsed_nanos += event_started.elapsed().as_nanos();

            let cycle = state
                .source_fatigue_cycle_for_test(0)
                .expect("an admitted transposition should retain its source cache");
            assert_eq!(
                fatigue_carrier_score_for_test(&cycle, &source_ordinals),
                state
                    .source_fatigue_baselines_for_test(0)
                    .expect("source cache should remain available after commit")
                    .0
            );
            assert!(score_non_regressed(
                fatigue_carrier_score_for_test(&cycle, &source_ordinals),
                initial_score
            ));
            assert_eq!(
                state.source_fatigue_baselines_for_test(0).unwrap().1,
                initial_score,
                "the source baseline must stay fixed across accepted swaps"
            );
        } else {
            state = list.next_state;
            core_elapsed_nanos += event_started.elapsed().as_nanos();
        }
    }

    println!(
        "native-region-core-v4 full-domain batch: events={} accepted_swaps={} same_source={} distinct_source={} candidate_trials={} core_elapsed_ms={} elapsed_ms={}",
        fixture.cycle.len(),
        accepted_swaps,
        same_source_swaps,
        distinct_source_swaps,
        candidate_trials,
        core_elapsed_nanos / 1_000_000,
        started.elapsed().as_millis()
    );
    assert!(
        accepted_swaps > 0,
        "the actual source/basin restriction should admit swaps"
    );
    assert!(
        same_source_swaps > 0,
        "the actual restriction should include same-source swaps"
    );
    assert!(
        distinct_source_swaps > 0,
        "the actual restriction should include distinct-source swaps"
    );
}

#[test]
fn adjacent_transposition_conjugates_successors_and_predecessors_from_old_edges() {
    let atlas = cycle_atlas(7, Vec::new());
    let orbit_index = compile_program_orbit_index(&atlas).unwrap();
    let before_orbit_index = orbit_index.clone();
    let initial = initialize_traversal_state(&atlas, &[0]).unwrap();
    let mut list = execute_program_list(&atlas, &orbit_index, 1, &initial).unwrap();
    let before = list.clone();
    let old_successors = atlas.programs[0].successors.clone();
    let mut old_predecessors = vec![usize::MAX; old_successors.len()];
    for (source, destination) in old_successors.iter().copied().enumerate() {
        old_predecessors[destination] = source;
    }
    let left = 1;
    let right = 2;

    apply_program_transposition(&atlas, &orbit_index, &mut list, 0, left, right).unwrap();

    for source in 0..atlas.track_count {
        let expected = sigma_for_test(
            old_successors[sigma_for_test(source, left, right)],
            left,
            right,
        );
        assert_eq!(
            list.next_state
                .effective_successor_for_test(&atlas, 0, 0, source),
            Some(expected),
            "successor conjugation mismatch at source {source}"
        );
    }
    for destination in 0..atlas.track_count {
        let expected = sigma_for_test(
            old_predecessors[sigma_for_test(destination, left, right)],
            left,
            right,
        );
        assert_eq!(
            list.next_state
                .effective_predecessor_for_test(&atlas, &orbit_index, 0, 0, destination),
            Some(expected),
            "predecessor conjugation mismatch at destination {destination}"
        );
    }
    let mut transformed = (0..atlas.track_count)
        .map(|source| {
            list.next_state
                .effective_successor_for_test(&atlas, 0, 0, source)
                .unwrap()
        })
        .collect::<Vec<_>>();
    transformed.sort_unstable();
    assert_eq!(transformed, (0..atlas.track_count).collect::<Vec<_>>());
    assert_eq!(list.order[0], right);
    assert_eq!(list.next_state.current_track(0), Some(right));
    assert_eq!(list.next_state.is_track_realized(0, left), Some(false));
    assert_eq!(list.next_state.is_track_realized(0, right), Some(true));
    assert!(list.opportunity_swaps[0]);
    assert_eq!(orbit_index, before_orbit_index);
    assert_eq!(
        before.order[0], left,
        "the pre-list state remains the rollback state"
    );
    assert_eq!(before.next_state.current_track(0), Some(left));
}

#[test]
fn native_boundary_transport_uses_sigma_instead_of_acoustic_labels() {
    let atlas = cycle_atlas(7, vec![1, 4]);
    let orbit_index = compile_program_orbit_index(&atlas).unwrap();
    let initial = initialize_traversal_state(&atlas, &[0]).unwrap();
    let mut list = execute_program_list(&atlas, &orbit_index, 1, &initial).unwrap();
    apply_program_transposition(&atlas, &orbit_index, &mut list, 0, 1, 2).unwrap();

    for source in 0..atlas.track_count {
        let expected = [2, 4].contains(&source);
        assert_eq!(
            list.next_state
                .effective_boundary_source_for_test(&atlas, 0, 0, source),
            Some(expected),
            "boundary membership must be transported through sigma at source {source}"
        );
    }
}

#[test]
fn fresh_program_departure_stays_style_marked_after_a_swap() {
    let atlas = residence_departure_atlas();
    let orbit_index = compile_program_orbit_index(&atlas).unwrap();
    let initial = initialize_traversal_state(&atlas, &[0]).unwrap();
    let first = execute_program_list(&atlas, &orbit_index, 1, &initial).unwrap();
    let departure = execute_program_list(&atlas, &orbit_index, 1, &first.next_state).unwrap();

    assert_eq!(departure.order, vec![4]);
    assert_eq!(departure.program_ordinals, vec![2]);
    assert!(departure.departures[0]);
    assert!(departure.style_sector_departures[0]);
    assert_eq!(departure.next_state.active_program(0), Some(2));

    let mut swapped = departure;
    apply_program_transposition(&atlas, &orbit_index, &mut swapped, 0, 4, 3).unwrap();
    assert!(swapped.style_sector_departures[0]);
    assert!(swapped.opportunity_swaps[0]);
}

#[test]
fn fresh_departure_reads_the_conjugated_successor_before_selecting_a_program() {
    let atlas = residence_departure_atlas();
    let orbit_index = compile_program_orbit_index(&atlas).unwrap();
    let initial = initialize_traversal_state(&atlas, &[0]).unwrap();
    let first = execute_program_list(&atlas, &orbit_index, 1, &initial).unwrap();
    let mut swapped = first;

    apply_program_transposition(&atlas, &orbit_index, &mut swapped, 0, 1, 4).unwrap();
    assert_eq!(swapped.next_state.current_track(0), Some(4));
    assert_eq!(
        swapped
            .next_state
            .effective_successor_for_test(&atlas, 0, 0, 4),
        Some(0),
        "the overlay must make the active successor repeat before fresh departure"
    );

    let departure = execute_program_list(&atlas, &orbit_index, 1, &swapped.next_state).unwrap();
    assert!(departure.departures[0]);
    assert_ne!(departure.program_ordinals[0], 0);
    assert!(departure.style_sector_departures[0]);
}

#[test]
fn same_atlas_reanchor_retains_overlay_cache_and_coverage_entry_clears_both() {
    let atlas = cycle_atlas(4, Vec::new());
    let orbit_index = compile_program_orbit_index(&atlas).unwrap();
    let initial = initialize_traversal_state(&atlas, &[0]).unwrap();
    let first = execute_program_list(&atlas, &orbit_index, 1, &initial).unwrap();
    let mut list = first;
    let source_ordinals = [0; 4];
    assert!(
        source_fatigue_allows_transposition(
            &atlas,
            &mut list.next_state,
            0,
            0,
            1,
            2,
            &source_ordinals,
        )
        .unwrap()
    );
    apply_program_transposition(&atlas, &orbit_index, &mut list, 0, 1, 2).unwrap();
    let current = list.next_state.current_track(0).unwrap();
    let realized = list.next_state.realized_tracks(0).unwrap();
    let reanchored = transport_traversal_state(
        Some((&atlas, &list.next_state)),
        &atlas,
        &[current],
        &[realized],
    )
    .unwrap();
    assert_eq!(reanchored.overlay_program_for_test(0), Some(0));
    assert!(reanchored.has_source_fatigue_cache_for_test(0));
    assert_eq!(reanchored.playback_cycle, list.next_state.playback_cycle);

    let coverage = execute_program_list(&atlas, &orbit_index, 3, &reanchored).unwrap();
    assert_eq!(
        coverage.coverage_epoch_transitions,
        vec![false, false, true]
    );
    assert_eq!(coverage.next_state.overlay_program_for_test(0), None);
    assert!(!coverage.next_state.has_source_fatigue_cache_for_test(0));
    assert_eq!(coverage.next_state.coverage_epoch(0), Some(1));
    assert_eq!(
        coverage.next_state.playback_cycle,
        reanchored.playback_cycle + 1
    );
}

#[test]
fn coverage_program_switch_clears_overlay_and_source_cache() {
    let atlas = two_full_cycle_atlas();
    let orbit_index = compile_program_orbit_index(&atlas).unwrap();
    let initial = initialize_traversal_state(&atlas, &[0]).unwrap();
    let first = execute_program_list(&atlas, &orbit_index, 1, &initial).unwrap();
    let source_ordinals = [0; 4];
    let mut cached_state = first.next_state;
    assert!(
        source_fatigue_allows_transposition(
            &atlas,
            &mut cached_state,
            0,
            0,
            1,
            2,
            &source_ordinals,
        )
        .unwrap()
    );
    assert!(cached_state.has_source_fatigue_cache_for_test(0));

    let coverage = execute_program_list(&atlas, &orbit_index, 3, &cached_state).unwrap();
    assert_eq!(
        coverage.coverage_epoch_transitions,
        vec![false, false, true]
    );
    assert_eq!(coverage.next_state.active_program(0), Some(1));
    assert_eq!(coverage.next_state.overlay_program_for_test(0), None);
    assert!(!coverage.next_state.has_source_fatigue_cache_for_test(0));
}

fn track_keys(count: usize) -> Vec<String> {
    (0..count).map(|index| format!("track:{index}")).collect()
}

fn successor_cycle_count(successors: &[usize]) -> usize {
    let mut visited = vec![false; successors.len()];
    let mut cycles = 0;
    for source in 0..successors.len() {
        if visited[source] {
            continue;
        }
        cycles += 1;
        let mut current = source;
        while !visited[current] {
            visited[current] = true;
            current = successors[current];
        }
    }
    cycles
}
