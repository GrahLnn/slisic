use super::path_fairness::{
    CandidateGraph, FairnessConfig, StableCatalog, build_candidate_graph, fsrs_retrievability,
    solve_conserved_flow,
};

fn synthetic_catalog() -> StableCatalog {
    let track_count: usize = 5;
    let candidate_count: usize = 4;
    let neighbors = (0..track_count)
        .flat_map(|source| (0..track_count).filter(move |destination| *destination != source))
        .collect::<Vec<_>>();
    let similarities = (0..track_count)
        .flat_map(|source| {
            (0..track_count)
                .filter(move |destination| *destination != source)
                .map(move |destination| {
                    let distance = source
                        .abs_diff(destination)
                        .min(track_count - source.abs_diff(destination));
                    if distance == 1 { 0.4 } else { 0.1 }
                })
        })
        .collect();
    StableCatalog {
        generation: 1,
        embedding_dimension: 2,
        embeddings: vec![0.0; track_count * 2],
        basins: (0..track_count)
            .map(|index| format!("audio-basin:{index}"))
            .collect(),
        graph: CandidateGraph {
            track_count,
            candidate_count,
            neighbors,
            similarities,
        },
    }
}

#[test]
fn fsrs_curve_is_normalized_at_stability() {
    assert!((fsrs_retrievability(20.0, 20.0, 0.5) - 0.9).abs() < 1.0e-12);
}

#[test]
fn matrix_candidate_graph_matches_expected_cosine_order() {
    let graph = build_candidate_graph(&[1.0, 0.0, 0.8, 0.6, -1.0, 0.0], 3, 2, 1);

    assert_eq!(graph.neighbors, vec![1, 0, 1]);
    assert!(
        graph
            .similarities
            .iter()
            .zip([0.8, 0.8, -0.8])
            .all(|(actual, expected)| (*actual - expected).abs() < 1.0e-6)
    );
}

#[test]
fn conserved_lift_preserves_f32_marginals_without_backtracking() {
    let catalog = synthetic_catalog();
    let config = FairnessConfig {
        candidate_count: 4,
        beta_upper: 16.0,
        reciprocal_projection_steps: 32,
        reciprocal_final_balance_steps: 32,
        ..FairnessConfig::default()
    };

    let flow = solve_conserved_flow(&catalog, &config).expect("synthetic flow should solve");

    assert!(flow.maximum_row_error < 1.0e-8);
    assert!(flow.maximum_column_error < 1.0e-8);
    assert!(flow.maximum_reciprocal_flow <= config.reciprocal_cap + 1.0e-3);
    assert!(flow.maximum_outgoing_marginal_error < 1.0e-5);
    assert_eq!(flow.maximum_backtrack_probability, 0.0);
}
