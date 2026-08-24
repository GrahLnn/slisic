use super::symbolic_program::{
    NeuralProgramAtlas, NormalFatigueAuxiliary, ProgramMorphism, TraversalExhausted,
    candidate_neighborhood_overlaps, candidate_relation_from_program_atlas,
    candidate_relation_signature, close_neural_program_atlas_cycles, compile_neural_program_atlas,
    compile_program_orbit_index, execute_program_list, form_neural_adaptation_cycle,
    initialize_traversal_state, normal_fatigue_auxiliary, ordered_track_key_signature,
    program_encoding_signature, restrict_neural_program_atlas_to_playlist,
    transport_traversal_state,
};

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
fn neural_adaptation_forms_local_chunks_then_preserves_complete_coverage() {
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
    let original = atlas.programs[0].successors.clone();

    assert!(
        form_neural_adaptation_cycle(
            &mut atlas,
            &neighbors,
            &track_keys(8),
            &acoustic_basins,
            &source_collections,
        )
        .unwrap()
    );

    let formed = &atlas.programs[0].successors;
    assert_eq!(successor_cycle_count(formed), 1);
    assert!(formed.iter().enumerate().all(|(source, destination)| {
        neighbors[source * 8..(source + 1) * 8].contains(destination)
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
    let list = execute_program_list(&atlas, &orbits, 7, &initial).unwrap();
    assert_eq!(list.next_state.realized_tracks(0), Some((0..8).collect()));
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
