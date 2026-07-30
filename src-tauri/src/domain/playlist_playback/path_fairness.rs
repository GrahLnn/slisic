// Rust reproduction of the conserved audio-style path-fairness experiment.
//
// The module is intentionally pure and model-generation scoped. It does not
// mutate playback state or persist model-local basin identifiers.

use rayon::prelude::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

const UNKNOWN_BASIN: &str = "audio-basin:unknown";

#[derive(Debug, Clone)]
pub(crate) struct FairnessConfig {
    pub(crate) candidate_count: usize,
    pub(crate) smoothness: f64,
    pub(crate) stationary_steps: usize,
    pub(crate) sinkhorn_tolerance: f64,
    pub(crate) sinkhorn_max_steps: usize,
    pub(crate) beta_upper: f64,
    pub(crate) beta_search_steps: usize,
    pub(crate) continuity_tolerance: f64,
    pub(crate) reciprocal_cap: f64,
    pub(crate) reciprocal_projection_margin: f64,
    pub(crate) reciprocal_projection_steps: usize,
    pub(crate) reciprocal_balance_steps: usize,
    pub(crate) reciprocal_final_balance_steps: usize,
    pub(crate) reciprocal_tolerance: f64,
    pub(crate) lifted_coupling_tolerance: f64,
    pub(crate) lifted_coupling_max_steps: usize,
    pub(crate) repair_beta_step: f64,
}

impl Default for FairnessConfig {
    fn default() -> Self {
        Self {
            candidate_count: 96,
            smoothness: 6.0,
            stationary_steps: 384,
            sinkhorn_tolerance: 2.0e-4,
            sinkhorn_max_steps: 8_192,
            beta_upper: 64.0,
            beta_search_steps: 18,
            continuity_tolerance: 1.0e-5,
            reciprocal_cap: 0.95,
            reciprocal_projection_margin: 1.0e-3,
            reciprocal_projection_steps: 256,
            reciprocal_balance_steps: 4,
            reciprocal_final_balance_steps: 256,
            reciprocal_tolerance: 1.0e-3,
            lifted_coupling_tolerance: 1.0e-8,
            lifted_coupling_max_steps: 512,
            repair_beta_step: 4.0,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CompositionConfig {
    pub(crate) seeds: Vec<u64>,
    pub(crate) sessions: usize,
    pub(crate) tracks_per_session: usize,
    pub(crate) session_gap_hours: f64,
    pub(crate) short_history_window: usize,
    pub(crate) track_stability_hours: f64,
    pub(crate) fsrs_decay: f64,
    pub(crate) track_inhibition_strength: f64,
    pub(crate) basin_inhibition_strength: f64,
    pub(crate) stability_repeat_gain: f64,
    pub(crate) stability_cap_hours: f64,
    pub(crate) paired_ci95_t_critical: f64,
}

impl Default for CompositionConfig {
    fn default() -> Self {
        Self {
            seeds: (20260730..=20260737).collect(),
            sessions: 12,
            tracks_per_session: 32,
            session_gap_hours: 18.0,
            short_history_window: 48,
            track_stability_hours: 20.0,
            fsrs_decay: 0.5,
            track_inhibition_strength: 2.4,
            basin_inhibition_strength: 1.1,
            stability_repeat_gain: 0.35,
            stability_cap_hours: 120.0,
            paired_ci95_t_critical: 2.365,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct StableCatalog {
    pub(crate) generation: u64,
    pub(crate) embedding_dimension: usize,
    pub(crate) embeddings: Vec<f32>,
    pub(crate) basins: Vec<String>,
    pub(crate) graph: CandidateGraph,
}

#[derive(Debug, Clone)]
pub(crate) struct CandidateGraph {
    pub(crate) track_count: usize,
    pub(crate) candidate_count: usize,
    pub(crate) neighbors: Vec<usize>,
    pub(crate) similarities: Vec<f32>,
}

#[derive(Debug, Clone)]
pub(crate) struct ConservedFlow {
    graph: CandidateGraph,
    base_probabilities: Vec<f32>,
    successor_log_potential: Vec<f32>,
    pub(crate) similarity_dual: f64,
    pub(crate) expected_continuity: f64,
    pub(crate) maximum_row_error: f64,
    pub(crate) maximum_column_error: f64,
    pub(crate) maximum_reciprocal_flow: f64,
    pub(crate) maximum_outgoing_marginal_error: f64,
    pub(crate) maximum_backtrack_probability: f64,
}

#[derive(Debug, Clone)]
struct FlowSolution {
    probabilities: Vec<f64>,
    similarity_dual: f64,
    expected_continuity: f64,
}

#[derive(Debug, Clone, Copy)]
struct Exposure {
    played_at_hours: f64,
    stability_hours: f64,
}

#[derive(Debug, Clone, Default)]
struct SimulationMetrics {
    mean_cross_session_track_repeat_rate: f64,
    mean_previous_session_track_repeat_rate: f64,
    mean_previous_session_nearest_style_cosine: f64,
    p90_previous_session_nearest_style_cosine: f64,
    mean_previous_session_bidirectional_style_cosine: f64,
    mean_previous_session_centroid_style_cosine: f64,
    mean_previous_session_basin_overlap_rate: f64,
    mean_adjacent_cosine: f64,
    mean_unique_track_fraction: f64,
    immediate_backtrack_rate: f64,
    visit_entropy: f64,
    maximum_visit_share: f64,
}

#[derive(Debug, Deserialize)]
struct StablePayload {
    generation: u64,
    state: StableState,
}

#[derive(Debug, Deserialize)]
struct StableState {
    embeddings: Vec<StableEmbedding>,
    indexed_tracks: Vec<StableIndexedTrack>,
    sampling_geometry: Option<StableSamplingGeometry>,
}

#[derive(Debug, Deserialize)]
struct StableEmbedding {
    key: StableTrackKey,
    values: Vec<f32>,
}

#[derive(Debug, Deserialize)]
struct StableIndexedTrack {
    key: StableTrackKey,
}

#[derive(Debug, Deserialize)]
struct StableSamplingGeometry {
    #[serde(default)]
    self_supervised_basins: Vec<StableBasinAssignment>,
}

#[derive(Debug, Deserialize)]
struct StableBasinAssignment {
    key: StableTrackKey,
    basin: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Hash)]
struct StableTrackKey {
    #[serde(default)]
    music_url: String,
    #[serde(default)]
    file_path: String,
    #[serde(default)]
    start_ms: u32,
    #[serde(default)]
    end_ms: u32,
}

pub(crate) fn load_stable_catalog(
    path: &Path,
    config: &FairnessConfig,
) -> Result<StableCatalog, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("failed to read stable model `{}`: {error}", path.display()))?;
    let payload: StablePayload = serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to parse stable model `{}`: {error}", path.display()))?;
    let track_count = payload.state.indexed_tracks.len();
    if track_count < 2 || payload.state.embeddings.len() != track_count {
        return Err("stable model must contain one embedding per indexed track".to_string());
    }

    let embedding_dimension = payload.state.embeddings[0].values.len();
    if embedding_dimension == 0
        || payload
            .state
            .embeddings
            .iter()
            .any(|entry| entry.values.len() != embedding_dimension)
    {
        return Err("stable model embeddings must have one non-empty dimension".to_string());
    }

    let embedding_by_key: HashMap<_, _> = payload
        .state
        .embeddings
        .into_iter()
        .map(|entry| (entry.key, entry.values))
        .collect();
    let mut embeddings = Vec::with_capacity(track_count * embedding_dimension);
    for indexed in &payload.state.indexed_tracks {
        let values = embedding_by_key
            .get(&indexed.key)
            .ok_or_else(|| "indexed track is missing its stable embedding".to_string())?;
        embeddings.extend_from_slice(values);
    }
    normalize_center_normalize(&mut embeddings, track_count, embedding_dimension);

    let basin_by_key: HashMap<_, _> = payload
        .state
        .sampling_geometry
        .map(|geometry| {
            geometry
                .self_supervised_basins
                .into_iter()
                .map(|entry| (entry.key, entry.basin))
                .collect()
        })
        .unwrap_or_default();
    let basins = payload
        .state
        .indexed_tracks
        .iter()
        .map(|entry| {
            basin_by_key
                .get(&entry.key)
                .cloned()
                .unwrap_or_else(|| UNKNOWN_BASIN.to_string())
        })
        .collect();
    let graph = build_candidate_graph(
        &embeddings,
        track_count,
        embedding_dimension,
        config.candidate_count,
    );
    Ok(StableCatalog {
        generation: payload.generation,
        embedding_dimension,
        embeddings,
        basins,
        graph,
    })
}

fn normalize_center_normalize(values: &mut [f32], rows: usize, columns: usize) {
    values.par_chunks_mut(columns).for_each(normalize_embedding);
    let mut mean = vec![0.0_f64; columns];
    for row in values.chunks_exact(columns) {
        for (destination, value) in mean.iter_mut().zip(row) {
            *destination += f64::from(*value);
        }
    }
    let denominator = rows as f64;
    for value in &mut mean {
        *value /= denominator;
    }
    values.par_chunks_mut(columns).for_each(|row| {
        for (value, center) in row.iter_mut().zip(&mean) {
            *value -= *center as f32;
        }
        normalize_embedding(row);
    });
}

fn normalize_embedding(values: &mut [f32]) {
    let norm = values
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>()
        .sqrt()
        .max(1.0e-8) as f32;
    for value in values {
        *value /= norm;
    }
}

pub(crate) fn build_candidate_graph(
    embeddings: &[f32],
    track_count: usize,
    embedding_dimension: usize,
    requested_candidates: usize,
) -> CandidateGraph {
    let candidate_count = requested_candidates.clamp(1, track_count - 1);
    let mut similarity_matrix = vec![0.0_f32; track_count * track_count];
    // Both operands and the output are contiguous allocations with the exact
    // dimensions declared below. The second operand uses transposed strides so
    // the calculation is embeddings * embeddings^T without another 50 MB copy.
    unsafe {
        matrixmultiply::sgemm(
            track_count,
            embedding_dimension,
            track_count,
            1.0,
            embeddings.as_ptr(),
            embedding_dimension as isize,
            1,
            embeddings.as_ptr(),
            1,
            embedding_dimension as isize,
            0.0,
            similarity_matrix.as_mut_ptr(),
            track_count as isize,
            1,
        );
    }
    let rows: Vec<(Vec<usize>, Vec<f32>)> = similarity_matrix
        .par_chunks_exact(track_count)
        .enumerate()
        .map(|(source, similarities)| {
            let mut candidates = Vec::with_capacity(track_count - 1);
            for (destination, &similarity) in similarities.iter().enumerate() {
                if source == destination {
                    continue;
                }
                candidates.push((destination, similarity));
            }
            candidates.select_nth_unstable_by(candidate_count - 1, |left, right| {
                right
                    .1
                    .total_cmp(&left.1)
                    .then_with(|| left.0.cmp(&right.0))
            });
            candidates.truncate(candidate_count);
            candidates.sort_unstable_by(|left, right| {
                right
                    .1
                    .total_cmp(&left.1)
                    .then_with(|| left.0.cmp(&right.0))
            });
            candidates.into_iter().unzip()
        })
        .collect();
    let mut neighbors = Vec::with_capacity(track_count * candidate_count);
    let mut similarities = Vec::with_capacity(track_count * candidate_count);
    for (row_neighbors, row_similarities) in rows {
        neighbors.extend(row_neighbors);
        similarities.extend(row_similarities);
    }
    CandidateGraph {
        track_count,
        candidate_count,
        neighbors,
        similarities,
    }
}

fn embedding_row(values: &[f32], width: usize, row: usize) -> &[f32] {
    &values[row * width..(row + 1) * width]
}

fn dot(left: &[f32], right: &[f32]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum()
}

pub(crate) fn solve_conserved_flow(
    catalog: &StableCatalog,
    config: &FairnessConfig,
) -> Result<ConservedFlow, String> {
    let baseline = softmax_kernel(&catalog.graph, config.smoothness, None);
    let stationary = stationary_distribution(&catalog.graph, &baseline, config.stationary_steps);
    let continuity_floor = expected_continuity(&catalog.graph, &baseline, Some(&stationary));
    let direct = fit_continuity_constrained_flow(&catalog.graph, continuity_floor, config)?;
    let first_beta =
        (direct.similarity_dual / config.repair_beta_step).ceil() * config.repair_beta_step;
    let mut beta = first_beta;
    while beta <= config.beta_upper + 1.0e-9 {
        let seed = solve_doubly_stochastic_flow(&catalog.graph, beta, config)?;
        let (projected, row_error, column_error, reciprocal_flow) =
            project_reciprocal_capacity(&catalog.graph, &seed.probabilities, config);
        let continuity = expected_continuity(&catalog.graph, &projected, None);
        if row_error <= config.reciprocal_tolerance
            && column_error <= config.reciprocal_tolerance
            && reciprocal_flow <= config.reciprocal_cap + config.reciprocal_tolerance
            && continuity + config.continuity_tolerance >= continuity_floor
        {
            let (successor, outgoing_error, backtrack) =
                solve_lifted_edge_coupling(&catalog.graph, &projected, config)?;
            let base_probabilities: Vec<f32> =
                projected.iter().map(|value| *value as f32).collect();
            let successor_log_potential: Vec<f32> =
                successor.iter().map(|value| *value as f32).collect();
            let (quantized_outgoing_error, quantized_backtrack) = replay_quantized_lift(
                &catalog.graph,
                &base_probabilities,
                &successor_log_potential,
            )?;
            return Ok(ConservedFlow {
                graph: catalog.graph.clone(),
                base_probabilities,
                successor_log_potential,
                similarity_dual: beta,
                expected_continuity: continuity,
                maximum_row_error: row_error,
                maximum_column_error: column_error,
                maximum_reciprocal_flow: reciprocal_flow,
                maximum_outgoing_marginal_error: quantized_outgoing_error.max(outgoing_error),
                maximum_backtrack_probability: quantized_backtrack.max(backtrack),
            });
        }
        beta += config.repair_beta_step;
    }
    Err("no reciprocal-cap conserved flow preserves the baseline continuity floor".to_string())
}

fn softmax_kernel(
    graph: &CandidateGraph,
    similarity_dual: f64,
    destination_potential: Option<&[f64]>,
) -> Vec<f64> {
    let mut probabilities = vec![0.0; graph.neighbors.len()];
    probabilities
        .par_chunks_mut(graph.candidate_count)
        .enumerate()
        .for_each(|(source, row)| {
            let start = source * graph.candidate_count;
            let maximum = (0..graph.candidate_count)
                .map(|slot| {
                    let edge = start + slot;
                    similarity_dual * f64::from(graph.similarities[edge])
                        + destination_potential
                            .map(|potential| potential[graph.neighbors[edge]])
                            .unwrap_or(0.0)
                })
                .fold(f64::NEG_INFINITY, f64::max);
            let mut total = 0.0;
            for (slot, probability) in row.iter_mut().enumerate() {
                let edge = start + slot;
                *probability = (similarity_dual * f64::from(graph.similarities[edge])
                    + destination_potential
                        .map(|potential| potential[graph.neighbors[edge]])
                        .unwrap_or(0.0)
                    - maximum)
                    .exp();
                total += *probability;
            }
            for probability in row {
                *probability /= total;
            }
        });
    probabilities
}

fn stationary_distribution(
    graph: &CandidateGraph,
    probabilities: &[f64],
    steps: usize,
) -> Vec<f64> {
    let mut distribution = vec![1.0 / graph.track_count as f64; graph.track_count];
    for _ in 0..steps {
        distribution = probabilities
            .par_chunks(graph.candidate_count)
            .enumerate()
            .fold(
                || vec![0.0; graph.track_count],
                |mut partial, (source, row)| {
                    let start = source * graph.candidate_count;
                    for (slot, probability) in row.iter().enumerate() {
                        partial[graph.neighbors[start + slot]] +=
                            distribution[source] * probability;
                    }
                    partial
                },
            )
            .reduce(
                || vec![0.0; graph.track_count],
                |mut left, right| {
                    for (left, right) in left.iter_mut().zip(right) {
                        *left += right;
                    }
                    left
                },
            );
    }
    distribution
}

fn expected_continuity(
    graph: &CandidateGraph,
    probabilities: &[f64],
    stationary: Option<&[f64]>,
) -> f64 {
    let uniform = 1.0 / graph.track_count as f64;
    (0..graph.track_count)
        .into_par_iter()
        .map(|source| {
            let local = row_range(graph, source)
                .map(|edge| probabilities[edge] * f64::from(graph.similarities[edge]))
                .sum::<f64>();
            local * stationary.map(|values| values[source]).unwrap_or(uniform)
        })
        .sum()
}

fn solve_doubly_stochastic_flow(
    graph: &CandidateGraph,
    similarity_dual: f64,
    config: &FairnessConfig,
) -> Result<FlowSolution, String> {
    let mut destination_potential = vec![0.0; graph.track_count];
    let mut probabilities = Vec::new();
    let mut maximum_column_error = f64::INFINITY;
    for _ in 0..config.sinkhorn_max_steps {
        probabilities = softmax_kernel(graph, similarity_dual, Some(&destination_potential));
        let columns = column_sums(graph, &probabilities);
        if columns.iter().any(|value| *value <= 0.0) {
            return Err("candidate support contains a track without incoming flow".to_string());
        }
        maximum_column_error = columns
            .iter()
            .map(|value| (value - 1.0).abs())
            .fold(0.0, f64::max);
        if maximum_column_error <= config.sinkhorn_tolerance {
            break;
        }
        for (potential, column) in destination_potential.iter_mut().zip(columns) {
            *potential -= column.ln();
        }
        let mean = destination_potential.iter().sum::<f64>() / destination_potential.len() as f64;
        for potential in &mut destination_potential {
            *potential -= mean;
        }
    }
    if maximum_column_error > config.sinkhorn_tolerance {
        return Err(format!(
            "doubly stochastic flow did not converge: column_error={maximum_column_error:.6e}"
        ));
    }
    let expected_continuity = expected_continuity(graph, &probabilities, None);
    Ok(FlowSolution {
        probabilities,
        similarity_dual,
        expected_continuity,
    })
}

fn fit_continuity_constrained_flow(
    graph: &CandidateGraph,
    continuity_floor: f64,
    config: &FairnessConfig,
) -> Result<FlowSolution, String> {
    let mut lower = 0.0;
    let mut upper = config.beta_upper;
    let mut solution = solve_doubly_stochastic_flow(graph, upper, config)?;
    if solution.expected_continuity + config.continuity_tolerance < continuity_floor {
        return Err(
            "uniform track flow cannot satisfy continuity on the candidate support".to_string(),
        );
    }
    for _ in 0..config.beta_search_steps {
        let middle = 0.5 * (lower + upper);
        let candidate = solve_doubly_stochastic_flow(graph, middle, config)?;
        if candidate.expected_continuity + config.continuity_tolerance >= continuity_floor {
            upper = middle;
            solution = candidate;
        } else {
            lower = middle;
        }
    }
    Ok(solution)
}

fn project_reciprocal_capacity(
    graph: &CandidateGraph,
    seed: &[f64],
    config: &FairnessConfig,
) -> (Vec<f64>, f64, f64, f64) {
    let reverse = reciprocal_edge_index(graph);
    let pairs: Vec<_> = reverse
        .iter()
        .enumerate()
        .filter_map(|(edge, reverse)| reverse.filter(|reverse| edge < *reverse).map(|r| (edge, r)))
        .collect();
    let target_cap = config.reciprocal_cap - config.reciprocal_projection_margin;
    let mut probabilities = seed.to_vec();
    for _ in 0..config.reciprocal_projection_steps {
        for &(left, right) in &pairs {
            let total = probabilities[left] + probabilities[right];
            if total > target_cap {
                let scale = target_cap / total;
                probabilities[left] *= scale;
                probabilities[right] *= scale;
            }
        }
        balance_candidate_flow(graph, &mut probabilities, config.reciprocal_balance_steps);
    }
    balance_candidate_flow(
        graph,
        &mut probabilities,
        config.reciprocal_final_balance_steps,
    );
    let row_error = maximum_row_error(graph, &probabilities);
    let column_error = column_sums(graph, &probabilities)
        .into_iter()
        .map(|value| (value - 1.0).abs())
        .fold(0.0, f64::max);
    let reciprocal_flow = pairs
        .iter()
        .map(|(left, right)| probabilities[*left] + probabilities[*right])
        .fold(0.0, f64::max);
    (probabilities, row_error, column_error, reciprocal_flow)
}

fn balance_candidate_flow(graph: &CandidateGraph, probabilities: &mut [f64], steps: usize) {
    for _ in 0..steps {
        probabilities
            .par_chunks_mut(graph.candidate_count)
            .for_each(|row| {
                let total = row.iter().sum::<f64>();
                for probability in row {
                    *probability /= total;
                }
            });
        let columns = column_sums(graph, probabilities);
        probabilities
            .par_iter_mut()
            .enumerate()
            .for_each(|(edge, probability)| {
                *probability /= columns[graph.neighbors[edge]];
            });
    }
}

fn reciprocal_edge_index(graph: &CandidateGraph) -> Vec<Option<usize>> {
    let mut by_pair = HashMap::with_capacity(graph.neighbors.len());
    for source in 0..graph.track_count {
        for edge in row_range(graph, source) {
            by_pair.insert((source, graph.neighbors[edge]), edge);
        }
    }
    (0..graph.neighbors.len())
        .into_par_iter()
        .map(|edge| {
            let source = edge / graph.candidate_count;
            by_pair.get(&(graph.neighbors[edge], source)).copied()
        })
        .collect()
}

fn solve_lifted_edge_coupling(
    graph: &CandidateGraph,
    base: &[f64],
    config: &FairnessConfig,
) -> Result<(Vec<f64>, f64, f64), String> {
    let reverse = reciprocal_edge_index(graph);
    let mut successor = vec![0.0_f64; base.len()];
    let mut maximum_error = f64::INFINITY;
    for _ in 0..config.lifted_coupling_max_steps {
        let outgoing = lifted_outgoing_marginal(graph, base, &successor, &reverse)?;
        maximum_error = outgoing
            .par_iter()
            .zip(base)
            .map(|(actual, expected)| (actual - expected).abs())
            .reduce(|| 0.0, f64::max);
        if maximum_error <= config.lifted_coupling_tolerance {
            return Ok((successor, maximum_error, 0.0));
        }
        successor
            .par_chunks_mut(graph.candidate_count)
            .enumerate()
            .for_each(|(source, row)| {
                let start = source * graph.candidate_count;
                for (slot, value) in row.iter_mut().enumerate() {
                    let edge = start + slot;
                    *value += (base[edge] / outgoing[edge]).ln();
                }
                let mean = row.iter().sum::<f64>() / graph.candidate_count as f64;
                for value in row {
                    *value -= mean;
                }
            });
    }
    Err(format!(
        "lifted edge coupling did not converge: outgoing_error={maximum_error:.6e}"
    ))
}

fn lifted_outgoing_marginal(
    graph: &CandidateGraph,
    base: &[f64],
    successor: &[f64],
    reverse: &[Option<usize>],
) -> Result<Vec<f64>, String> {
    let columns = column_sums(graph, base);
    let mut outgoing = vec![0.0; base.len()];
    outgoing
        .par_chunks_mut(graph.candidate_count)
        .enumerate()
        .try_for_each(|(current, row)| -> Result<(), String> {
            let range = row_range(graph, current);
            let adjusted: Vec<_> = range
                .clone()
                .map(|edge| base[edge] * successor[edge].exp())
                .collect();
            let total = adjusted.iter().sum::<f64>();
            let mut reciprocal_incoming = vec![0.0; graph.candidate_count];
            for (slot, edge) in range.clone().enumerate() {
                if let Some(reverse_edge) = reverse[edge] {
                    reciprocal_incoming[slot] = base[reverse_edge];
                }
            }
            let reciprocal_total = reciprocal_incoming.iter().sum::<f64>();
            let non_reciprocal = (columns[current] - reciprocal_total).max(0.0);
            let mut shared_factor = non_reciprocal / total;
            for slot in 0..graph.candidate_count {
                let incoming = reciprocal_incoming[slot];
                if incoming > 0.0 {
                    let denominator = total - adjusted[slot];
                    if denominator <= 0.0 {
                        return Err("reciprocal cap left no non-backtracking successor".to_string());
                    }
                    shared_factor += incoming / denominator;
                }
            }
            for (slot, destination) in row.iter_mut().enumerate() {
                let excluded_factor = if reciprocal_incoming[slot] > 0.0 {
                    reciprocal_incoming[slot] / (total - adjusted[slot])
                } else {
                    0.0
                };
                *destination = adjusted[slot] * (shared_factor - excluded_factor);
            }
            Ok(())
        })?;
    Ok(outgoing)
}

fn replay_quantized_lift(
    graph: &CandidateGraph,
    base: &[f32],
    successor: &[f32],
) -> Result<(f64, f64), String> {
    let base_f64: Vec<_> = base.iter().map(|value| f64::from(*value)).collect();
    let successor_f64: Vec<_> = successor.iter().map(|value| f64::from(*value)).collect();
    let reverse = reciprocal_edge_index(graph);
    let outgoing = lifted_outgoing_marginal(graph, &base_f64, &successor_f64, &reverse)?;
    let error = outgoing
        .iter()
        .zip(&base_f64)
        .map(|(actual, expected)| (actual - expected).abs())
        .fold(0.0, f64::max);
    Ok((error, 0.0))
}

fn maximum_row_error(graph: &CandidateGraph, probabilities: &[f64]) -> f64 {
    (0..graph.track_count)
        .into_par_iter()
        .map(|source| (probabilities[row_range(graph, source)].iter().sum::<f64>() - 1.0).abs())
        .reduce(|| 0.0, f64::max)
}

fn column_sums(graph: &CandidateGraph, probabilities: &[f64]) -> Vec<f64> {
    probabilities
        .par_chunks(graph.candidate_count)
        .enumerate()
        .fold(
            || vec![0.0; graph.track_count],
            |mut partial, (source, row)| {
                let start = source * graph.candidate_count;
                for (slot, probability) in row.iter().enumerate() {
                    partial[graph.neighbors[start + slot]] += probability;
                }
                partial
            },
        )
        .reduce(
            || vec![0.0; graph.track_count],
            |mut left, right| {
                for (left, right) in left.iter_mut().zip(right) {
                    *left += right;
                }
                left
            },
        )
}

fn row_range(graph: &CandidateGraph, source: usize) -> std::ops::Range<usize> {
    let start = source * graph.candidate_count;
    start..start + graph.candidate_count
}

fn lifted_candidate_probabilities(
    flow: &ConservedFlow,
    previous: Option<usize>,
    current: usize,
) -> Vec<f64> {
    let range = row_range(&flow.graph, current);
    let mut weights: Vec<_> = range
        .clone()
        .map(|edge| {
            f64::from(flow.base_probabilities[edge])
                * f64::from(flow.successor_log_potential[edge]).exp()
        })
        .collect();
    if let Some(previous) = previous {
        for (slot, edge) in range.enumerate() {
            if flow.graph.neighbors[edge] == previous {
                weights[slot] = 0.0;
            }
        }
    }
    normalize_weights(&mut weights);
    weights
}

fn normalize_weights(weights: &mut [f64]) {
    let total = weights.iter().sum::<f64>();
    if total > 0.0 {
        for weight in weights {
            *weight /= total;
        }
    }
}

pub(crate) fn fsrs_retrievability(elapsed_hours: f64, stability_hours: f64, decay: f64) -> f64 {
    if elapsed_hours <= 0.0 {
        return 1.0;
    }
    let safe_decay = decay.max(1.0e-6);
    let safe_stability = stability_hours.max(1.0e-6);
    let factor = 0.9_f64.powf(-1.0 / safe_decay) - 1.0;
    (1.0 + factor * elapsed_hours / safe_stability).powf(-safe_decay)
}

fn simulate_composition(
    catalog: &StableCatalog,
    flow: &ConservedFlow,
    config: &CompositionConfig,
    seed: u64,
    use_temporal_memory: bool,
    use_basin_projection: bool,
) -> SimulationMetrics {
    let mut rng = ProbeRng::new(seed);
    let mut memory: HashMap<usize, Exposure> = HashMap::new();
    let mut prior_sessions: Vec<Vec<usize>> = Vec::new();
    let mut track_repeats = Vec::new();
    let mut previous_track_repeats = Vec::new();
    let mut nearest_cosines = Vec::new();
    let mut bidirectional_cosines = Vec::new();
    let mut centroid_cosines = Vec::new();
    let mut basin_overlaps = Vec::new();
    let mut adjacent_cosines = Vec::new();
    let mut unique_fractions = Vec::new();
    let mut visits = vec![0_usize; catalog.graph.track_count];
    let mut backtracks = 0_usize;
    let mut transitions = 0_usize;
    for session_index in 0..config.sessions {
        let now_hours = session_index as f64 * config.session_gap_hours;
        let basin_pressure = current_basin_pressure(catalog, &memory, now_hours, config);
        let anchor = rng.index(catalog.graph.track_count);
        let mut order = vec![anchor];
        visits[anchor] += 1;
        while order.len() < config.tracks_per_session {
            let previous = (order.len() >= 2).then(|| order[order.len() - 2]);
            let current = *order.last().expect("session has an anchor");
            let structural = lifted_candidate_probabilities(flow, previous, current);
            let short_start = order.len().saturating_sub(config.short_history_window);
            let short_history: HashSet<_> = order[short_start..].iter().copied().collect();
            let row = row_range(&flow.graph, current);
            let mut candidate_slots: Vec<_> = row
                .clone()
                .enumerate()
                .filter_map(|(slot, edge)| {
                    (!short_history.contains(&flow.graph.neighbors[edge])).then_some(slot)
                })
                .collect();
            if candidate_slots.is_empty() {
                candidate_slots.extend(0..catalog.graph.candidate_count);
            }
            let mut logits: Vec<_> = candidate_slots
                .iter()
                .map(|slot| structural[*slot].max(1.0e-300).ln())
                .collect();
            if use_temporal_memory {
                for (logit, slot) in logits.iter_mut().zip(&candidate_slots) {
                    let track = flow.graph.neighbors[row.start + *slot];
                    let track_pressure = memory
                        .get(&track)
                        .map(|exposure| {
                            fsrs_retrievability(
                                now_hours - exposure.played_at_hours,
                                exposure.stability_hours,
                                config.fsrs_decay,
                            )
                        })
                        .unwrap_or(0.0);
                    let basin = &catalog.basins[track];
                    let projected_pressure = if use_basin_projection {
                        basin_pressure.get(basin).copied().unwrap_or(0.0)
                    } else {
                        0.0
                    };
                    *logit -= config.track_inhibition_strength * track_pressure
                        + config.basin_inhibition_strength * projected_pressure;
                }
            }
            let probabilities = softmax_values(&logits);
            let selected_slot = candidate_slots[rng.weighted_index(&probabilities)];
            let selected = flow.graph.neighbors[row.start + selected_slot];
            if previous == Some(selected) {
                backtracks += 1;
            }
            adjacent_cosines.push(f64::from(
                flow.graph.similarities[row.start + selected_slot],
            ));
            transitions += 1;
            order.push(selected);
            visits[selected] += 1;
        }
        if let Some(previous_order) = prior_sessions.last() {
            let all_prior: HashSet<_> = prior_sessions.iter().flatten().copied().collect();
            let previous_tracks: HashSet<_> = previous_order.iter().copied().collect();
            track_repeats.push(
                order
                    .iter()
                    .filter(|track| all_prior.contains(track))
                    .count() as f64
                    / order.len() as f64,
            );
            previous_track_repeats.push(
                order
                    .iter()
                    .filter(|track| previous_tracks.contains(track))
                    .count() as f64
                    / order.len() as f64,
            );
            let style = previous_session_style_metrics(catalog, &order, previous_order);
            nearest_cosines.extend(style.current_nearest);
            bidirectional_cosines.push(style.bidirectional_nearest);
            centroid_cosines.push(style.centroid_cosine);
            basin_overlaps.push(style.basin_overlap);
        }
        unique_fractions
            .push(order.iter().copied().collect::<HashSet<_>>().len() as f64 / order.len() as f64);
        prior_sessions.push(order.clone());
        for track in order {
            let stability_hours = memory
                .get(&track)
                .map(|previous| {
                    (previous.stability_hours * (1.0 + config.stability_repeat_gain))
                        .clamp(config.track_stability_hours, config.stability_cap_hours)
                })
                .unwrap_or(config.track_stability_hours);
            memory.insert(
                track,
                Exposure {
                    played_at_hours: now_hours,
                    stability_hours,
                },
            );
        }
    }
    let total_visits = visits.iter().sum::<usize>() as f64;
    let visit_probabilities: Vec<_> = visits
        .iter()
        .map(|count| *count as f64 / total_visits)
        .collect();
    SimulationMetrics {
        mean_cross_session_track_repeat_rate: mean(&track_repeats),
        mean_previous_session_track_repeat_rate: mean(&previous_track_repeats),
        mean_previous_session_nearest_style_cosine: mean(&nearest_cosines),
        p90_previous_session_nearest_style_cosine: quantile(&nearest_cosines, 0.9),
        mean_previous_session_bidirectional_style_cosine: mean(&bidirectional_cosines),
        mean_previous_session_centroid_style_cosine: mean(&centroid_cosines),
        mean_previous_session_basin_overlap_rate: mean(&basin_overlaps),
        mean_adjacent_cosine: mean(&adjacent_cosines),
        mean_unique_track_fraction: mean(&unique_fractions),
        immediate_backtrack_rate: backtracks as f64 / transitions.max(1) as f64,
        visit_entropy: normalized_entropy(&visit_probabilities),
        maximum_visit_share: visit_probabilities.into_iter().fold(0.0, f64::max),
    }
}

fn current_basin_pressure(
    catalog: &StableCatalog,
    memory: &HashMap<usize, Exposure>,
    now_hours: f64,
    config: &CompositionConfig,
) -> HashMap<String, f64> {
    let mut pressure: HashMap<String, f64> = HashMap::new();
    for (track, exposure) in memory {
        let retrievability = fsrs_retrievability(
            now_hours - exposure.played_at_hours,
            exposure.stability_hours,
            config.fsrs_decay,
        );
        pressure
            .entry(catalog.basins[*track].clone())
            .and_modify(|value| *value = value.max(retrievability))
            .or_insert(retrievability);
    }
    pressure
}

struct StyleMetrics {
    current_nearest: Vec<f64>,
    bidirectional_nearest: f64,
    centroid_cosine: f64,
    basin_overlap: f64,
}

fn previous_session_style_metrics(
    catalog: &StableCatalog,
    current: &[usize],
    previous: &[usize],
) -> StyleMetrics {
    let mut current_nearest = vec![f64::NEG_INFINITY; current.len()];
    let mut previous_nearest = vec![f64::NEG_INFINITY; previous.len()];
    for (current_slot, current_track) in current.iter().enumerate() {
        let current_embedding = embedding_row(
            &catalog.embeddings,
            catalog.embedding_dimension,
            *current_track,
        );
        for (previous_slot, previous_track) in previous.iter().enumerate() {
            let similarity = f64::from(dot(
                current_embedding,
                embedding_row(
                    &catalog.embeddings,
                    catalog.embedding_dimension,
                    *previous_track,
                ),
            ));
            current_nearest[current_slot] = current_nearest[current_slot].max(similarity);
            previous_nearest[previous_slot] = previous_nearest[previous_slot].max(similarity);
        }
    }
    let mut current_centroid = vec![0.0_f32; catalog.embedding_dimension];
    let mut previous_centroid = vec![0.0_f32; catalog.embedding_dimension];
    for track in current {
        for (value, source) in current_centroid.iter_mut().zip(embedding_row(
            &catalog.embeddings,
            catalog.embedding_dimension,
            *track,
        )) {
            *value += *source / current.len() as f32;
        }
    }
    for track in previous {
        for (value, source) in previous_centroid.iter_mut().zip(embedding_row(
            &catalog.embeddings,
            catalog.embedding_dimension,
            *track,
        )) {
            *value += *source / previous.len() as f32;
        }
    }
    normalize_embedding(&mut current_centroid);
    normalize_embedding(&mut previous_centroid);
    let previous_basins: HashSet<_> = previous
        .iter()
        .map(|track| &catalog.basins[*track])
        .collect();
    StyleMetrics {
        bidirectional_nearest: 0.5 * (mean(&current_nearest) + mean(&previous_nearest)),
        centroid_cosine: f64::from(dot(&current_centroid, &previous_centroid)),
        basin_overlap: current
            .iter()
            .filter(|track| previous_basins.contains(&catalog.basins[**track]))
            .count() as f64
            / current.len() as f64,
        current_nearest,
    }
}

fn softmax_values(logits: &[f64]) -> Vec<f64> {
    let maximum = logits.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mut probabilities: Vec<_> = logits.iter().map(|value| (value - maximum).exp()).collect();
    normalize_weights(&mut probabilities);
    probabilities
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len().max(1) as f64
}

fn quantile(values: &[f64], probability: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut ordered = values.to_vec();
    ordered.sort_by(f64::total_cmp);
    let position = probability.clamp(0.0, 1.0) * (ordered.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    ordered[lower] + (ordered[upper] - ordered[lower]) * position.fract()
}

fn normalized_entropy(values: &[f64]) -> f64 {
    if values.len() <= 1 {
        return 0.0;
    }
    -values
        .iter()
        .filter(|value| **value > 0.0)
        .map(|value| value * value.ln())
        .sum::<f64>()
        / (values.len() as f64).ln()
}

#[derive(Debug)]
struct ProbeRng {
    state: u64,
}

impl ProbeRng {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e3779b97f4a7c15);
        let mut value = self.state;
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d049bb133111eb);
        value ^ (value >> 31)
    }

    fn unit(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64) / ((1_u64 << 53) as f64)
    }

    fn index(&mut self, length: usize) -> usize {
        self.next_u64() as usize % length.max(1)
    }

    fn weighted_index(&mut self, probabilities: &[f64]) -> usize {
        let draw = self.unit();
        let mut cumulative = 0.0;
        for (index, probability) in probabilities.iter().enumerate() {
            cumulative += probability;
            if draw <= cumulative {
                return index;
            }
        }
        probabilities.len().saturating_sub(1)
    }
}

pub(crate) fn build_real_data_report(
    stable_path: &Path,
    fairness: &FairnessConfig,
    composition: &CompositionConfig,
) -> Result<Value, String> {
    let catalog = load_stable_catalog(stable_path, fairness)?;
    let flow = solve_conserved_flow(&catalog, fairness)?;
    let structural_rows: Vec<_> = composition
        .seeds
        .iter()
        .map(|seed| simulate_composition(&catalog, &flow, composition, *seed, false, false))
        .collect();
    let track_only_rows: Vec<_> = composition
        .seeds
        .iter()
        .map(|seed| simulate_composition(&catalog, &flow, composition, *seed, true, false))
        .collect();
    let full_rows: Vec<_> = composition
        .seeds
        .iter()
        .map(|seed| simulate_composition(&catalog, &flow, composition, *seed, true, true))
        .collect();
    let structural = aggregate_metrics(&structural_rows);
    let track_only = aggregate_metrics(&track_only_rows);
    let full = aggregate_metrics(&full_rows);
    let paired_deltas: Vec<_> = full_rows
        .iter()
        .zip(&structural_rows)
        .map(|(full, structural)| {
            full.mean_previous_session_nearest_style_cosine
                - structural.mean_previous_session_nearest_style_cosine
        })
        .collect();
    let paired_mean = mean(&paired_deltas);
    let paired_variance = paired_deltas
        .iter()
        .map(|value| (value - paired_mean).powi(2))
        .sum::<f64>()
        / (paired_deltas.len().saturating_sub(1).max(1) as f64);
    let standard_error = (paired_variance / paired_deltas.len().max(1) as f64).sqrt();
    let ci95 = [
        paired_mean - composition.paired_ci95_t_critical * standard_error,
        paired_mean + composition.paired_ci95_t_critical * standard_error,
    ];
    let improvement_fraction = paired_deltas.iter().filter(|value| **value < 0.0).count() as f64
        / paired_deltas.len().max(1) as f64;
    Ok(json!({
        "experiment": "rust_lifted_flow_spacing_composition_probe",
        "status": if flow.maximum_outgoing_marginal_error <= 1.0e-5
            && flow.maximum_backtrack_probability == 0.0
            && paired_mean < 0.0
            && improvement_fraction >= 0.75
            && ci95[1] < 0.0
        {
            "reproduced"
        } else {
            "not_reproduced"
        },
        "input": {
            "stable_model": stable_path,
            "generation": catalog.generation,
            "tracks": catalog.graph.track_count,
            "embedding_dimension": catalog.embedding_dimension,
            "candidate_window": catalog.graph.candidate_count,
            "basins": catalog.basins.iter().collect::<HashSet<_>>().len(),
        },
        "structural_receipt": {
            "similarity_dual": flow.similarity_dual,
            "expected_continuity": flow.expected_continuity,
            "maximum_row_error": flow.maximum_row_error,
            "maximum_column_error": flow.maximum_column_error,
            "maximum_reciprocal_flow": flow.maximum_reciprocal_flow,
            "quantized_f32_input_maximum_outgoing_marginal_error": flow.maximum_outgoing_marginal_error,
            "maximum_backtrack_probability": flow.maximum_backtrack_probability,
        },
        "config": {
            "candidate_count": fairness.candidate_count,
            "smoothness": fairness.smoothness,
            "sinkhorn_tolerance": fairness.sinkhorn_tolerance,
            "sinkhorn_max_steps": fairness.sinkhorn_max_steps,
            "beta_search_steps": fairness.beta_search_steps,
            "reciprocal_cap": fairness.reciprocal_cap,
            "lifted_coupling_tolerance": fairness.lifted_coupling_tolerance,
            "seeds": composition.seeds,
            "sessions": composition.sessions,
            "tracks_per_session": composition.tracks_per_session,
            "session_gap_hours": composition.session_gap_hours,
            "short_history_window": composition.short_history_window,
            "track_stability_hours": composition.track_stability_hours,
            "fsrs_decay": composition.fsrs_decay,
            "track_inhibition_strength": composition.track_inhibition_strength,
            "basin_inhibition_strength": composition.basin_inhibition_strength,
        },
        "structural_only": metrics_value(&structural),
        "structural_plus_track_only_anti_fsrs_control": metrics_value(&track_only),
        "structural_plus_anti_fsrs": metrics_value(&full),
        "paired_seed_style_delta": {
            "values": paired_deltas,
            "mean": paired_mean,
            "standard_error": standard_error,
            "ci95": ci95,
            "improvement_fraction": improvement_fraction,
        },
        "delta": {
            "previous_session_nearest_style_cosine": full.mean_previous_session_nearest_style_cosine - structural.mean_previous_session_nearest_style_cosine,
            "previous_session_style_p90_cosine": full.p90_previous_session_nearest_style_cosine - structural.p90_previous_session_nearest_style_cosine,
            "previous_session_bidirectional_style_cosine": full.mean_previous_session_bidirectional_style_cosine - structural.mean_previous_session_bidirectional_style_cosine,
            "previous_session_centroid_style_cosine": full.mean_previous_session_centroid_style_cosine - structural.mean_previous_session_centroid_style_cosine,
            "previous_session_basin_overlap_rate": full.mean_previous_session_basin_overlap_rate - structural.mean_previous_session_basin_overlap_rate,
            "adjacent_cosine": full.mean_adjacent_cosine - structural.mean_adjacent_cosine,
        },
        "mechanism_attribution": {
            "track_only_local_nearest": track_only.mean_previous_session_nearest_style_cosine,
            "full_local_nearest": full.mean_previous_session_nearest_style_cosine,
            "track_only_centroid": track_only.mean_previous_session_centroid_style_cosine,
            "full_centroid": full.mean_previous_session_centroid_style_cosine,
            "track_only_basin_overlap": track_only.mean_previous_session_basin_overlap_rate,
            "full_basin_overlap": full.mean_previous_session_basin_overlap_rate,
        },
        "owner_boundary": {
            "structural": "model-generation track-uniform conserved flow and current directed edge",
            "temporal": "listener-keyed exposure projected through the current model after structural probabilities",
            "forbidden": "listener history fitting structural flow or persisted basin identity",
        },
    }))
}

fn aggregate_metrics(rows: &[SimulationMetrics]) -> SimulationMetrics {
    let count = rows.len().max(1) as f64;
    let mut output = SimulationMetrics::default();
    for row in rows {
        output.mean_cross_session_track_repeat_rate +=
            row.mean_cross_session_track_repeat_rate / count;
        output.mean_previous_session_track_repeat_rate +=
            row.mean_previous_session_track_repeat_rate / count;
        output.mean_previous_session_nearest_style_cosine +=
            row.mean_previous_session_nearest_style_cosine / count;
        output.p90_previous_session_nearest_style_cosine +=
            row.p90_previous_session_nearest_style_cosine / count;
        output.mean_previous_session_bidirectional_style_cosine +=
            row.mean_previous_session_bidirectional_style_cosine / count;
        output.mean_previous_session_centroid_style_cosine +=
            row.mean_previous_session_centroid_style_cosine / count;
        output.mean_previous_session_basin_overlap_rate +=
            row.mean_previous_session_basin_overlap_rate / count;
        output.mean_adjacent_cosine += row.mean_adjacent_cosine / count;
        output.mean_unique_track_fraction += row.mean_unique_track_fraction / count;
        output.immediate_backtrack_rate += row.immediate_backtrack_rate / count;
        output.visit_entropy += row.visit_entropy / count;
        output.maximum_visit_share += row.maximum_visit_share / count;
    }
    output
}

fn metrics_value(metrics: &SimulationMetrics) -> Value {
    json!({
        "mean_cross_session_track_repeat_rate": metrics.mean_cross_session_track_repeat_rate,
        "mean_previous_session_track_repeat_rate": metrics.mean_previous_session_track_repeat_rate,
        "mean_previous_session_nearest_style_cosine": metrics.mean_previous_session_nearest_style_cosine,
        "p90_previous_session_nearest_style_cosine": metrics.p90_previous_session_nearest_style_cosine,
        "mean_previous_session_bidirectional_style_cosine": metrics.mean_previous_session_bidirectional_style_cosine,
        "mean_previous_session_centroid_style_cosine": metrics.mean_previous_session_centroid_style_cosine,
        "mean_previous_session_basin_overlap_rate": metrics.mean_previous_session_basin_overlap_rate,
        "mean_adjacent_cosine": metrics.mean_adjacent_cosine,
        "mean_unique_track_fraction": metrics.mean_unique_track_fraction,
        "immediate_backtrack_rate": metrics.immediate_backtrack_rate,
        "visit_entropy": metrics.visit_entropy,
        "maximum_visit_share": metrics.maximum_visit_share,
    })
}
