use super::symbolic_program::{
    NeuralProgramAtlas, ProgramMorphism, TraversalExhausted, candidate_neighborhood_overlaps,
    candidate_relation_from_program_atlas, candidate_relation_signature,
    close_neural_program_atlas_cycles, compile_neural_program_atlas, compile_program_orbit_index,
    execute_program_list, initialize_traversal_state, ordered_track_key_signature,
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

fn basin_selection_atlas() -> NeuralProgramAtlas {
    NeuralProgramAtlas {
        track_count: 8,
        candidate_count: 2,
        programs: vec![
            ProgramMorphism {
                lineage: "program:clustered".to_string(),
                presentation_ordinals: vec![0],
                successors: vec![7, 5, 0, 2, 6, 3, 1, 4],
                boundary_sources: Vec::new(),
            },
            ProgramMorphism {
                lineage: "program:spread".to_string(),
                presentation_ordinals: vec![1],
                successors: vec![1, 3, 5, 4, 7, 6, 0, 2],
                boundary_sources: Vec::new(),
            },
        ],
    }
}

fn first_program_ordinal(atlas: &NeuralProgramAtlas, basin_ordinals: &[usize]) -> usize {
    let orbits = compile_program_orbit_index(atlas, Some(basin_ordinals)).unwrap();
    let initial = initialize_traversal_state(atlas, &orbits, &[0]).unwrap();
    execute_program_list(atlas, &orbits, 1, &initial)
        .unwrap()
        .program_ordinals[0]
}

fn remap_tracks(atlas: &NeuralProgramAtlas, old_track_by_new: &[usize]) -> NeuralProgramAtlas {
    let mut new_track_by_old = vec![usize::MAX; old_track_by_new.len()];
    for (new_track, old_track) in old_track_by_new.iter().copied().enumerate() {
        new_track_by_old[old_track] = new_track;
    }
    let mut remapped = atlas.clone();
    for program in &mut remapped.programs {
        program.successors = old_track_by_new
            .iter()
            .map(|old_source| new_track_by_old[program.successors[*old_source]])
            .collect();
    }
    remapped
}

fn remap_basin_ordinals(basin_ordinals: &[usize], old_track_by_new: &[usize]) -> Vec<usize> {
    old_track_by_new
        .iter()
        .map(|old_track| basin_ordinals[*old_track])
        .collect()
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
    let orbits = compile_program_orbit_index(&atlas, None).unwrap();
    let state = initialize_traversal_state(&atlas, &orbits, &[0]).unwrap();

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
    let orbits = compile_program_orbit_index(&atlas, None).unwrap();
    let initial = initialize_traversal_state(&atlas, &orbits, &[0]).unwrap();

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
    let orbits = compile_program_orbit_index(&atlas, None).unwrap();
    let initial = initialize_traversal_state(&atlas, &orbits, &[0]).unwrap();

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
fn minimax_spacing_beats_aggregate_lookback_and_preserves_coverage() {
    let atlas = basin_selection_atlas();
    let basin_ordinals = [0, 1, 2, 3, 0, 1, 2, 3];
    let orbits = compile_program_orbit_index(&atlas, Some(&basin_ordinals)).unwrap();
    let initial = initialize_traversal_state(&atlas, &orbits, &[0]).unwrap();

    let list = execute_program_list(&atlas, &orbits, 7, &initial).unwrap();

    // Program 0 has fewer boolean lookback-3 hits, but its worst spacing score
    // is 100 versus 80 for program 1; minimax spacing must select program 1.
    assert_eq!(successor_cycle_count(&atlas.programs[1].successors), 1);
    assert_eq!(list.program_ordinals, vec![1; 7]);
    assert_eq!(list.order, vec![1, 3, 4, 7, 2, 5, 6]);
    assert_eq!(list.next_state.realized_tracks(0), Some((0..8).collect()));
}

#[test]
fn minimax_spacing_is_invariant_to_cycle_rotation_and_basin_label_renaming() {
    let atlas = basin_selection_atlas();
    let basin_ordinals = [0, 1, 2, 3, 0, 1, 2, 3];
    let baseline = first_program_ordinal(&atlas, &basin_ordinals);
    let rotation = (1..8).chain(0..1).collect::<Vec<_>>();
    let rotated_atlas = remap_tracks(&atlas, &rotation);
    let rotated_basins = remap_basin_ordinals(&basin_ordinals, &rotation);
    let renamed_basins = basin_ordinals
        .iter()
        .map(|basin| [2, 0, 3, 1][*basin])
        .collect::<Vec<_>>();

    assert_eq!(baseline, 1);
    assert_eq!(
        first_program_ordinal(&rotated_atlas, &rotated_basins),
        baseline
    );
    assert_eq!(first_program_ordinal(&atlas, &renamed_basins), baseline);
}

#[test]
fn missing_basin_assignments_retain_program_zero_initialization() {
    let atlas = basin_selection_atlas();
    let orbits = compile_program_orbit_index(&atlas, None).unwrap();
    let initial = initialize_traversal_state(&atlas, &orbits, &[0]).unwrap();

    let list = execute_program_list(&atlas, &orbits, 1, &initial).unwrap();

    assert_eq!(list.program_ordinals, vec![0]);
    assert_eq!(list.order, vec![1]);
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
    let orbits = compile_program_orbit_index(&scoped, None).unwrap();
    let initial = initialize_traversal_state(&scoped, &orbits, &[0, 1, 2]).unwrap();

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
    let orbits = compile_program_orbit_index(&atlas, None).unwrap();
    let initial = initialize_traversal_state(&atlas, &orbits, &[0]).unwrap();
    let first = execute_program_list(&atlas, &orbits, 2, &initial).unwrap();
    let direct = execute_program_list(&atlas, &orbits, 1, &first.next_state).unwrap();
    let transported = transport_traversal_state(
        Some((&atlas, &first.next_state)),
        &atlas,
        &orbits,
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
