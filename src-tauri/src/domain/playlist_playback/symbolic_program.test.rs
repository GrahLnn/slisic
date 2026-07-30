use super::symbolic_program::{
    NeuralProgramAtlas, ProgramMorphism, TraversalExhausted, candidate_relation_signature,
    compile_neural_program_atlas, compile_program_orbit_index, execute_program_list,
    initialize_traversal_state, ordered_track_key_signature, program_encoding_signature,
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
            },
            ProgramMorphism {
                lineage: "program:1".to_string(),
                presentation_ordinals: vec![1],
                successors: vec![1, 2, 3, 4, 5, 0],
            },
            ProgramMorphism {
                lineage: "program:2".to_string(),
                presentation_ordinals: vec![2],
                successors: vec![2, 4, 3, 0, 5, 1],
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
