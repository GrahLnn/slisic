// Deterministic neural-program traversal shared by the Rust reproduction probe.
//
// The executor remains in one compiled successor program while it produces
// unread consequences. A proposed replay is the only fatigue event. Departure
// then chooses an unread successor whose complete program future has minimum
// overlap with realized history; program order rotates only among exact ties.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Debug, Clone)]
pub(crate) struct SymbolicCatalog<'a> {
    pub(crate) generation: u64,
    pub(crate) embedding_dimension: usize,
    pub(crate) embeddings: &'a [f32],
    pub(crate) track_keys: &'a [String],
    pub(crate) track_titles: &'a [String],
    pub(crate) candidate_count: usize,
    pub(crate) neighbors: &'a [usize],
    pub(crate) candidate_relation_signature: &'a str,
    pub(crate) expected_program_lineages: &'a [String],
    pub(crate) expected_program_encoding_signature: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgramMorphism {
    pub(crate) lineage: String,
    pub(crate) presentation_ordinals: Vec<usize>,
    pub(crate) successors: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NeuralProgramAtlas {
    pub(crate) track_count: usize,
    pub(crate) candidate_count: usize,
    pub(crate) programs: Vec<ProgramMorphism>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CompilationResult {
    pub(crate) atlas: Option<NeuralProgramAtlas>,
    pub(crate) unclosed_presentations: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgramOrbitIndex {
    cycle_ids: Vec<Vec<usize>>,
    cycle_masks: Vec<Vec<Vec<u64>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgramPathState {
    current_track: usize,
    active_program: usize,
    tie_cursor: usize,
    realized_history: Vec<u64>,
    residence_steps: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgramOwnedTraversalState {
    paths: Vec<ProgramPathState>,
    pub(crate) playback_cycle: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgramList {
    pub(crate) path_count: usize,
    pub(crate) tracks_per_list: usize,
    pub(crate) order: Vec<usize>,
    pub(crate) program_ordinals: Vec<usize>,
    pub(crate) departures: Vec<bool>,
    pub(crate) departure_future_overlap: Vec<Option<usize>>,
    pub(crate) next_state: ProgramOwnedTraversalState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TraversalExhausted {
    pub(crate) path_ordinal: usize,
    pub(crate) current_track: usize,
}

impl std::fmt::Display for TraversalExhausted {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "all admitted program consequences are already realized for path {} at track {}",
            self.path_ordinal, self.current_track
        )
    }
}

impl std::error::Error for TraversalExhausted {}

impl ProgramList {
    fn row(&self, path: usize) -> &[usize] {
        let start = path * self.tracks_per_list;
        &self.order[start..start + self.tracks_per_list]
    }
}

// @forma implements material ResearchCandidateTransfer.compile_neural_style_program as compile_neural_program_atlas
// @forma implements material ResearchCandidateTransfer.quotient_by_owned_future as compile_neural_program_atlas
pub(crate) fn compile_neural_program_atlas(
    track_keys: &[String],
    candidate_count: usize,
    neighbors: &[usize],
) -> Result<CompilationResult, String> {
    let track_count = track_keys.len();
    if track_count == 0 || candidate_count == 0 {
        return Ok(CompilationResult {
            atlas: None,
            unclosed_presentations: (0..candidate_count).collect(),
        });
    }
    if neighbors.len() != track_count * candidate_count {
        return Err("candidate relation and stable track keys must align".to_string());
    }
    if track_keys.iter().collect::<HashSet<_>>().len() != track_count {
        return Err("stable track keys must be unique".to_string());
    }
    if neighbors
        .iter()
        .any(|destination| *destination >= track_count)
    {
        return Err("candidate relation contains an invalid track".to_string());
    }

    let mut source_order = (0..track_count).collect::<Vec<_>>();
    source_order.sort_unstable_by(|left, right| track_keys[*left].cmp(&track_keys[*right]));
    let mut programs = Vec::<ProgramMorphism>::new();
    let mut program_by_law = HashMap::<Vec<usize>, usize>::new();
    let mut unclosed = Vec::new();
    for presentation in 0..candidate_count {
        let presented = (0..track_count)
            .map(|source| {
                let row = &neighbors[source * candidate_count..(source + 1) * candidate_count];
                (0..candidate_count)
                    .map(|offset| row[(presentation + offset) % candidate_count])
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let Some(successors) = perfect_matching(&presented, &source_order) else {
            unclosed.push(presentation);
            continue;
        };
        if let Some(program) = program_by_law.get(&successors).copied() {
            programs[program].presentation_ordinals.push(presentation);
        } else {
            let program = programs.len();
            program_by_law.insert(successors.clone(), program);
            programs.push(ProgramMorphism {
                lineage: successor_lineage(track_keys, &successors),
                presentation_ordinals: vec![presentation],
                successors,
            });
        }
    }
    if !unclosed.is_empty() || programs.is_empty() {
        return Ok(CompilationResult {
            atlas: None,
            unclosed_presentations: unclosed,
        });
    }
    Ok(CompilationResult {
        atlas: Some(NeuralProgramAtlas {
            track_count,
            candidate_count,
            programs,
        }),
        unclosed_presentations: Vec::new(),
    })
}

pub(crate) fn ordered_track_key_signature(track_keys: &[String]) -> String {
    let mut digest = Sha256::new();
    for track_key in track_keys {
        digest.update(track_key.as_bytes());
        digest.update(b"\n");
    }
    format!("audio-track-order:{}", hex_digest(digest.finalize()))
}

pub(crate) fn candidate_relation_signature(
    track_keys: &[String],
    candidate_count: usize,
    neighbors: &[usize],
) -> Result<String, String> {
    if neighbors.len() != track_keys.len() * candidate_count {
        return Err("candidate relation and stable track keys must align".to_string());
    }
    let mut digest = Sha256::new();
    for (source, row) in neighbors.chunks_exact(candidate_count).enumerate() {
        digest.update(track_keys[source].as_bytes());
        digest.update(b"\0");
        for (rank, destination) in row.iter().enumerate() {
            let destination_key = track_keys
                .get(*destination)
                .ok_or_else(|| "candidate relation contains an invalid track".to_string())?;
            digest.update(rank.to_string().as_bytes());
            digest.update(b":");
            digest.update(destination_key.as_bytes());
            digest.update(b"\0");
        }
        digest.update(b"\n");
    }
    Ok(format!(
        "audio-candidate-relation:{}",
        hex_digest(digest.finalize())
    ))
}

pub(crate) fn program_encoding_signature(programs: &[ProgramMorphism]) -> String {
    let mut digest = Sha256::new();
    for program in programs {
        digest.update(program.lineage.as_bytes());
        digest.update(b"\n");
    }
    format!("audio-program-encoding:{}", hex_digest(digest.finalize()))
}

fn successor_lineage(track_keys: &[String], successors: &[usize]) -> String {
    let mut source_order = (0..track_keys.len()).collect::<Vec<_>>();
    source_order.sort_unstable_by(|left, right| track_keys[*left].cmp(&track_keys[*right]));
    let mut digest = Sha256::new();
    for source in source_order {
        digest.update(track_keys[source].as_bytes());
        digest.update(b"\0");
        digest.update(track_keys[successors[source]].as_bytes());
        digest.update(b"\n");
    }
    format!("audio-program:{}", hex_digest(digest.finalize()))
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn perfect_matching(rows: &[Vec<usize>], source_order: &[usize]) -> Option<Vec<usize>> {
    let track_count = rows.len();
    let mut match_left = vec![usize::MAX; track_count];
    let mut match_right = vec![usize::MAX; track_count];
    let mut distance = vec![usize::MAX; track_count];
    loop {
        let mut queue = VecDeque::new();
        let mut found = false;
        for source in source_order {
            if match_left[*source] == usize::MAX {
                distance[*source] = 0;
                queue.push_back(*source);
            } else {
                distance[*source] = usize::MAX;
            }
        }
        while let Some(source) = queue.pop_front() {
            for destination in &rows[source] {
                let owner = match_right[*destination];
                if owner == usize::MAX {
                    found = true;
                } else if distance[owner] == usize::MAX {
                    distance[owner] = distance[source] + 1;
                    queue.push_back(owner);
                }
            }
        }
        if !found {
            break;
        }
        for source in source_order {
            if match_left[*source] == usize::MAX {
                augment_matching(
                    *source,
                    rows,
                    &mut match_left,
                    &mut match_right,
                    &mut distance,
                );
            }
        }
    }
    (!match_left.contains(&usize::MAX)).then_some(match_left)
}

fn augment_matching(
    source: usize,
    rows: &[Vec<usize>],
    match_left: &mut [usize],
    match_right: &mut [usize],
    distance: &mut [usize],
) -> bool {
    for destination in &rows[source] {
        let owner = match_right[*destination];
        if owner == usize::MAX
            || (distance[owner] == distance[source] + 1
                && augment_matching(owner, rows, match_left, match_right, distance))
        {
            match_left[source] = *destination;
            match_right[*destination] = source;
            return true;
        }
    }
    distance[source] = usize::MAX;
    false
}

// @forma implements material ResearchCandidateTransfer.split_and_merge_program_species as compile_program_orbit_index
pub(crate) fn compile_program_orbit_index(
    atlas: &NeuralProgramAtlas,
) -> Result<ProgramOrbitIndex, String> {
    let word_count = atlas.track_count.div_ceil(64);
    let mut all_cycle_ids = Vec::with_capacity(atlas.programs.len());
    let mut all_cycle_masks = Vec::with_capacity(atlas.programs.len());
    for program in &atlas.programs {
        let mut cycle_ids = vec![usize::MAX; atlas.track_count];
        let mut cycle_masks = Vec::new();
        for root in 0..atlas.track_count {
            if cycle_ids[root] != usize::MAX {
                continue;
            }
            let mut nodes = Vec::new();
            let mut node = root;
            while cycle_ids[node] == usize::MAX {
                cycle_ids[node] = usize::MAX - 1;
                nodes.push(node);
                node = program.successors[node];
            }
            if cycle_ids[node] != usize::MAX - 1 {
                return Err("an admitted successor law is not a permutation".to_string());
            }
            let cycle = cycle_masks.len();
            let mut mask = vec![0_u64; word_count];
            for member in nodes {
                set_bit(&mut mask, member);
                cycle_ids[member] = cycle;
            }
            cycle_masks.push(mask);
        }
        all_cycle_ids.push(cycle_ids);
        all_cycle_masks.push(cycle_masks);
    }
    Ok(ProgramOrbitIndex {
        cycle_ids: all_cycle_ids,
        cycle_masks: all_cycle_masks,
    })
}

pub(crate) fn initialize_traversal_state(
    atlas: &NeuralProgramAtlas,
    anchors: &[usize],
) -> Result<ProgramOwnedTraversalState, String> {
    if anchors.iter().any(|anchor| *anchor >= atlas.track_count) {
        return Err("anchor contains an invalid track".to_string());
    }
    let word_count = atlas.track_count.div_ceil(64);
    Ok(ProgramOwnedTraversalState {
        paths: anchors
            .iter()
            .map(|anchor| {
                let mut history = vec![0_u64; word_count];
                set_bit(&mut history, *anchor);
                ProgramPathState {
                    current_track: *anchor,
                    active_program: 0,
                    tie_cursor: 1 % atlas.programs.len(),
                    realized_history: history,
                    residence_steps: 0,
                }
            })
            .collect(),
        playback_cycle: 0,
    })
}

// @forma implements material ResearchCandidateTransfer.propose_fresh_departure_from_learnable_future as select_fresh_departure
fn select_fresh_departure(
    atlas: &NeuralProgramAtlas,
    orbit_index: &ProgramOrbitIndex,
    state: &ProgramPathState,
) -> Option<(usize, usize, usize)> {
    let mut minimum_overlap = usize::MAX;
    let mut candidates = HashMap::<usize, usize>::new();
    for (program_ordinal, program) in atlas.programs.iter().enumerate() {
        let destination = program.successors[state.current_track];
        if contains_bit(&state.realized_history, destination) {
            continue;
        }
        let cycle = orbit_index.cycle_ids[program_ordinal][state.current_track];
        let overlap = intersection_count(
            &state.realized_history,
            &orbit_index.cycle_masks[program_ordinal][cycle],
        );
        if overlap < minimum_overlap {
            minimum_overlap = overlap;
            candidates.clear();
        }
        if overlap == minimum_overlap {
            candidates.insert(program_ordinal, destination);
        }
    }
    if candidates.is_empty() {
        return None;
    }
    for offset in 0..atlas.programs.len() {
        let program = (state.tie_cursor + offset) % atlas.programs.len();
        if let Some(destination) = candidates.get(&program).copied() {
            return Some((program, destination, minimum_overlap));
        }
    }
    None
}

// @forma implements material ResearchCandidateTransfer.close_style_residence_from_unread_consequence as execute_program_list
// @forma implements material ResearchCandidateTransfer.separate_familiar_execution_from_departure_pressure as execute_program_list
// @forma implements material ResearchCandidateTransfer.execute_persistent_program_ecology as execute_program_list
pub(crate) fn execute_program_list(
    atlas: &NeuralProgramAtlas,
    orbit_index: &ProgramOrbitIndex,
    tracks_per_list: usize,
    state: &ProgramOwnedTraversalState,
) -> Result<ProgramList, TraversalExhausted> {
    assert!(tracks_per_list > 0, "a playback list must be nonempty");
    let path_count = state.paths.len();
    let mut next_state = state.clone();
    let mut order = vec![0_usize; path_count * tracks_per_list];
    let mut program_ordinals = vec![0_usize; order.len()];
    let mut departures = vec![false; order.len()];
    let mut departure_future_overlap = vec![None; order.len()];
    for step in 0..tracks_per_list {
        for path_ordinal in 0..path_count {
            let path = &mut next_state.paths[path_ordinal];
            let mut program = path.active_program;
            let mut destination = atlas.programs[program].successors[path.current_track];
            let index = path_ordinal * tracks_per_list + step;
            if contains_bit(&path.realized_history, destination) {
                let Some((fresh_program, fresh_destination, overlap)) =
                    select_fresh_departure(atlas, orbit_index, path)
                else {
                    return Err(TraversalExhausted {
                        path_ordinal,
                        current_track: path.current_track,
                    });
                };
                program = fresh_program;
                destination = fresh_destination;
                path.active_program = program;
                path.tie_cursor = (program + 1) % atlas.programs.len();
                path.residence_steps = 1;
                departures[index] = true;
                departure_future_overlap[index] = Some(overlap);
            } else {
                path.residence_steps += 1;
            }
            path.current_track = destination;
            set_bit(&mut path.realized_history, destination);
            order[index] = destination;
            program_ordinals[index] = program;
        }
    }
    next_state.playback_cycle += 1;
    Ok(ProgramList {
        path_count,
        tracks_per_list,
        order,
        program_ordinals,
        departures,
        departure_future_overlap,
        next_state,
    })
}

// @forma implements material ResearchCandidateTransfer.audit_typed_morphism_paths as build_symbolic_program_report
pub(crate) fn build_symbolic_program_report(
    catalog: &SymbolicCatalog<'_>,
    tracks_per_list: usize,
    target_title: &str,
) -> Result<Value, String> {
    let compilation = compile_neural_program_atlas(
        catalog.track_keys,
        catalog.candidate_count,
        catalog.neighbors,
    )?;
    let Some(atlas) = compilation.atlas else {
        return Ok(json!({
            "experiment": "rust_symbolic_audio_program_traversal_probe",
            "status": "explicit_unclosed_branch",
            "unclosed_presentations": compilation.unclosed_presentations,
            "production_authorization": false,
        }));
    };
    let compiled_program_lineages = atlas
        .programs
        .iter()
        .map(|program| program.lineage.clone())
        .collect::<Vec<_>>();
    let compiled_candidate_relation_signature = candidate_relation_signature(
        catalog.track_keys,
        catalog.candidate_count,
        catalog.neighbors,
    )?;
    let compiled_program_encoding_signature = program_encoding_signature(&atlas.programs);
    let finite_encoding_matches = compiled_candidate_relation_signature
        == catalog.candidate_relation_signature
        && compiled_program_lineages == catalog.expected_program_lineages
        && compiled_program_encoding_signature == catalog.expected_program_encoding_signature;
    let orbit_index = compile_program_orbit_index(&atlas)?;
    let anchors = (0..atlas.track_count).collect::<Vec<_>>();
    let initial = initialize_traversal_state(&atlas, &anchors)?;
    let first = execute_program_list(&atlas, &orbit_index, tracks_per_list, &initial)
        .map_err(|error| error.to_string())?;
    let second = execute_program_list(&atlas, &orbit_index, tracks_per_list, &first.next_state)
        .map_err(|error| error.to_string())?;
    let reset = execute_program_list(&atlas, &orbit_index, tracks_per_list, &initial)
        .map_err(|error| error.to_string())?;
    let target = catalog
        .track_titles
        .iter()
        .enumerate()
        .filter(|(_, title)| title.to_lowercase() == target_title.to_lowercase())
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if target.len() != 1 {
        return Err(format!(
            "expected exactly one stable track named `{target_title}`, found {}",
            target.len()
        ));
    }
    let target = target[0];

    let all_programs_bijective = atlas.programs.iter().all(|program| {
        let mut counts = vec![0_usize; atlas.track_count];
        for destination in &program.successors {
            counts[*destination] += 1;
        }
        counts.iter().all(|count| *count == 1)
    });
    let candidate_sets = (0..atlas.track_count)
        .map(|source| {
            let start = source * atlas.candidate_count;
            catalog.neighbors[start..start + atlas.candidate_count]
                .iter()
                .copied()
                .collect::<HashSet<_>>()
        })
        .collect::<Vec<_>>();
    let all_successors_are_candidates = atlas.programs.iter().all(|program| {
        program
            .successors
            .iter()
            .enumerate()
            .all(|(source, destination)| candidate_sets[source].contains(destination))
    });
    let all_paths_unique = (0..atlas.track_count).all(|path| {
        let mut realized = HashSet::from([path]);
        first
            .row(path)
            .iter()
            .chain(second.row(path))
            .all(|track| realized.insert(*track))
    });
    let owned_states_nonmerge = {
        let signatures = second
            .next_state
            .paths
            .iter()
            .map(|path| {
                (
                    path.current_track,
                    path.active_program,
                    path.tie_cursor,
                    path.realized_history.clone(),
                )
            })
            .collect::<HashSet<_>>();
        signatures.len() == atlas.track_count
    };
    let every_path_begins_with_residence =
        (0..atlas.track_count).all(|path| !first.departures[path * tracks_per_list]);
    let departure_count = first
        .departures
        .iter()
        .chain(&second.departures)
        .filter(|departure| **departure)
        .count();
    let full_order = concatenate_rows(&first, &second, |list| &list.order);
    let full_programs = concatenate_rows(&first, &second, |list| &list.program_ordinals);
    let full_departures = concatenate_rows(&first, &second, |list| &list.departures);
    let full_overlaps = concatenate_rows(&first, &second, |list| &list.departure_future_overlap);
    let continuity = execution_continuity(
        catalog,
        &anchors,
        &full_order,
        &full_departures,
        tracks_per_list * 2,
    );
    let overlap_values = full_overlaps
        .iter()
        .filter_map(|value| *value)
        .map(|value| value as f64)
        .collect::<Vec<_>>();
    let residence = residence_summary(&full_programs, atlas.track_count, tracks_per_list * 2);
    let target_audit = target_audit(
        catalog,
        &full_order,
        tracks_per_list * 2,
        target,
        &[16, 32, 96],
    );
    let cross_list = cross_list_metrics(catalog, &first, &second, 8);
    let union_has_escape = program_union_is_strongly_connected(&atlas);
    let reset_replays = reset.order == first.order;
    let persistent_replays = second.order == first.order;

    let acceptance = json!({
        "all_candidate_presentations_closed": compilation.unclosed_presentations.is_empty(),
        "complete_future_laws_are_bijective": all_programs_bijective,
        "all_successors_are_current_candidates": all_successors_are_candidates,
        "every_path_avoids_realized_consequence_replay": all_paths_unique,
        "owned_path_states_do_not_merge": owned_states_nonmerge,
        "program_union_has_executable_escape": union_has_escape,
        "every_path_begins_with_program_residence": every_path_begins_with_residence,
        "fatigue_departures_exist_on_real_paths": departure_count > 0,
        "fatigue_departures_have_less_immediate_similarity":
            continuity.departure_mean < continuity.resident_mean,
        "minimum_future_overlap_departures_execute_without_exhaustion":
            !overlap_values.is_empty(),
        "cross_list_realized_track_overlap_is_zero": cross_list.track_overlap_max == 0.0,
        "persistent_cycle_is_not_reset_replay": !persistent_replays,
        "generation_owned_finite_program_encoding_matches": finite_encoding_matches,
    });
    let passed = acceptance
        .as_object()
        .expect("acceptance is an object")
        .values()
        .all(|value| value == &Value::Bool(true));
    Ok(json!({
        "experiment": "rust_symbolic_audio_program_traversal_probe",
        "status": if passed { "probe_passed" } else { "probe_failed" },
        "input": {
            "generation": catalog.generation,
            "tracks": atlas.track_count,
            "embedding_dimension": catalog.embedding_dimension,
            "candidate_width": atlas.candidate_count,
            "target_title": target_title,
            "target_track_index": target,
            "tracks_per_list": tracks_per_list,
            "playback_lists": 2,
        },
        "construction": {
            "candidate_programs": atlas.candidate_count,
            "future_equivalent_programs": atlas.programs.len(),
            "merged_presentations": atlas.programs.iter()
                .map(|program| program.presentation_ordinals.len().saturating_sub(1))
                .sum::<usize>(),
            "program_identity": "complete stable-key successor law",
            "program_executor": "resident successor law until realized-consequence fatigue, then minimum-future-overlap departure",
            "history_encoding": "exact catalog-incidence bitset per path",
            "probability_kernel": false,
            "embedding_threshold": false,
            "basin_or_fixed_cluster": false,
            "fixed_residence_count_or_timer": false,
            "fatigue_decay_or_threshold": false,
            "fsrs": false,
            "tuned_parameters": [],
        },
        "finite_program_encoding": {
            "track_key_signature": ordered_track_key_signature(catalog.track_keys),
            "candidate_relation_signature": compiled_candidate_relation_signature,
            "program_encoding_signature": compiled_program_encoding_signature,
            "program_lineages": compiled_program_lineages,
            "runtime_local_candidate_reconstruction_owns_program": false,
        },
        "program_structure": {
            "all_programs_bijective": all_programs_bijective,
            "program_union_strongly_connected": union_has_escape,
            "residence_episodes": residence,
            "realized_execution": {
                "resident_transition_count": continuity.resident_count,
                "departure_transition_count": continuity.departure_count,
                "resident_cosine_mean": continuity.resident_mean,
                "departure_cosine_mean": continuity.departure_mean,
            },
            "departure_future_overlap": metric_summary(&overlap_values),
        },
        "cross_cycle_audit": {
            "persistent_program": {
                "track_overlap_rate_maximum": cross_list.track_overlap_max,
                "track_overlap_rate_mean": cross_list.track_overlap_mean,
                "prefix_nearest_style_cosine_mean": cross_list.prefix_nearest_mean,
                "prefix_centroid_style_cosine_mean": cross_list.prefix_centroid_mean,
            },
            "reset_program_control_replays": reset_replays,
            "persistent_program_replays": persistent_replays,
        },
        "reported_target": target_audit,
        "acceptance": acceptance,
        "probe_contract": {
            "fixed_generation_ninety_real_encoded_paths": catalog.generation == 90,
            "all_real_track_starts": true,
            "named_reported_attractor": true,
            "anti_fsrs_control_only": true,
            "production_authorization": false,
        },
    }))
}

fn concatenate_rows<T: Clone>(
    first: &ProgramList,
    second: &ProgramList,
    field: impl Fn(&ProgramList) -> &[T],
) -> Vec<T> {
    let first_field = field(first);
    let second_field = field(second);
    let mut output = Vec::with_capacity(first_field.len() + second_field.len());
    for path in 0..first.path_count {
        let start = path * first.tracks_per_list;
        output.extend_from_slice(&first_field[start..start + first.tracks_per_list]);
        output.extend_from_slice(&second_field[start..start + second.tracks_per_list]);
    }
    output
}

#[derive(Debug, Clone, Copy)]
struct ExecutionContinuity {
    resident_count: usize,
    departure_count: usize,
    resident_mean: f64,
    departure_mean: f64,
}

fn execution_continuity(
    catalog: &SymbolicCatalog<'_>,
    anchors: &[usize],
    order: &[usize],
    departures: &[bool],
    steps: usize,
) -> ExecutionContinuity {
    let mut resident = Vec::new();
    let mut departure = Vec::new();
    for (path, anchor) in anchors.iter().enumerate() {
        let row = &order[path * steps..(path + 1) * steps];
        for step in 0..steps {
            let previous = if step == 0 { *anchor } else { row[step - 1] };
            let cosine = embedding_cosine(catalog, previous, row[step]);
            if departures[path * steps + step] {
                departure.push(cosine);
            } else {
                resident.push(cosine);
            }
        }
    }
    ExecutionContinuity {
        resident_count: resident.len(),
        departure_count: departure.len(),
        resident_mean: mean(&resident),
        departure_mean: mean(&departure),
    }
}

fn residence_summary(programs: &[usize], path_count: usize, steps: usize) -> Value {
    let mut lengths = Vec::new();
    for path in 0..path_count {
        let row = &programs[path * steps..(path + 1) * steps];
        let mut run = 1_usize;
        for pair in row.windows(2) {
            if pair[0] == pair[1] {
                run += 1;
            } else {
                lengths.push(run as f64);
                run = 1;
            }
        }
        lengths.push(run as f64);
    }
    metric_summary(&lengths)
}

fn target_audit(
    catalog: &SymbolicCatalog<'_>,
    order: &[usize],
    steps: usize,
    target: usize,
    sizes: &[usize],
) -> Value {
    let mut ranked = (0..catalog.track_keys.len())
        .map(|track| (track, embedding_cosine(catalog, target, track)))
        .collect::<Vec<_>>();
    ranked.sort_unstable_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    let target_occurrences = order.iter().filter(|track| **track == target).count();
    let paths_reaching_target = (0..catalog.track_keys.len())
        .filter(|path| order[*path * steps..(*path + 1) * steps].contains(&target))
        .count();
    let mut maximum_common_step_preimages = 0_usize;
    for step in 0..steps {
        maximum_common_step_preimages = maximum_common_step_preimages.max(
            (0..catalog.track_keys.len())
                .filter(|path| order[*path * steps + step] == target)
                .count(),
        );
    }
    let mut neighborhoods = serde_json::Map::new();
    let mut maximum_uniform_error = 0.0_f64;
    for size in sizes {
        let size = (*size).min(catalog.track_keys.len());
        let members = ranked
            .iter()
            .take(size)
            .map(|(track, _)| *track)
            .collect::<HashSet<_>>();
        let mut minimum_ratio = f64::INFINITY;
        let mut maximum_ratio = f64::NEG_INFINITY;
        for step in 1..steps {
            let count = (0..catalog.track_keys.len())
                .filter(|path| members.contains(&order[*path * steps + step]))
                .count();
            let ratio = count as f64 / size as f64;
            minimum_ratio = minimum_ratio.min(ratio);
            maximum_ratio = maximum_ratio.max(ratio);
        }
        maximum_uniform_error = maximum_uniform_error
            .max((minimum_ratio - 1.0).abs())
            .max((maximum_ratio - 1.0).abs());
        neighborhoods.insert(
            format!("style_{size}"),
            json!({
                "minimum_to_uniform_ratio": minimum_ratio,
                "maximum_to_uniform_ratio": maximum_ratio,
            }),
        );
    }
    json!({
        "exact_track": {
            "maximum_common_step_preimages": maximum_common_step_preimages,
            "total_target_occurrences": target_occurrences,
            "paths_reaching_target": paths_reaching_target,
            "uniform_occurrence_expectation": steps,
            "uniform_occurrence_error": target_occurrences.abs_diff(steps),
        },
        "style_neighborhoods": neighborhoods,
        "style_uniform_error": maximum_uniform_error,
    })
}

#[derive(Debug, Clone, Copy)]
struct CrossListMetrics {
    track_overlap_max: f64,
    track_overlap_mean: f64,
    prefix_nearest_mean: f64,
    prefix_centroid_mean: f64,
}

fn cross_list_metrics(
    catalog: &SymbolicCatalog<'_>,
    first: &ProgramList,
    second: &ProgramList,
    prefix_tracks: usize,
) -> CrossListMetrics {
    let mut overlaps = Vec::new();
    let mut prefix_nearest = Vec::new();
    let mut prefix_centroid = Vec::new();
    for path in 0..first.path_count {
        let previous = &first.row(path)[1..];
        let current = &second.row(path)[1..];
        let previous_set = previous.iter().copied().collect::<HashSet<_>>();
        overlaps.push(
            current
                .iter()
                .filter(|track| previous_set.contains(track))
                .count() as f64
                / current.len().max(1) as f64,
        );
        let prefix = prefix_tracks.min(previous.len()).min(current.len());
        let mut nearest_total = 0.0_f64;
        for track in &current[..prefix] {
            nearest_total += previous[..prefix]
                .iter()
                .map(|previous_track| embedding_cosine(catalog, *track, *previous_track))
                .fold(f64::NEG_INFINITY, f64::max);
        }
        prefix_nearest.push(nearest_total / prefix.max(1) as f64);
        let current_centroid = normalized_centroid(catalog, &current[..prefix]);
        let previous_centroid = normalized_centroid(catalog, &previous[..prefix]);
        prefix_centroid.push(
            current_centroid
                .iter()
                .zip(previous_centroid)
                .map(|(left, right)| left * right)
                .sum(),
        );
    }
    CrossListMetrics {
        track_overlap_max: overlaps.iter().copied().fold(0.0, f64::max),
        track_overlap_mean: mean(&overlaps),
        prefix_nearest_mean: mean(&prefix_nearest),
        prefix_centroid_mean: mean(&prefix_centroid),
    }
}

fn normalized_centroid(catalog: &SymbolicCatalog<'_>, tracks: &[usize]) -> Vec<f64> {
    let mut centroid = vec![0.0_f64; catalog.embedding_dimension];
    for track in tracks {
        let start = *track * catalog.embedding_dimension;
        for (value, source) in centroid
            .iter_mut()
            .zip(&catalog.embeddings[start..start + catalog.embedding_dimension])
        {
            *value += *source as f64 / tracks.len().max(1) as f64;
        }
    }
    let norm = centroid
        .iter()
        .map(|value| value * value)
        .sum::<f64>()
        .sqrt()
        .max(1.0e-8);
    for value in &mut centroid {
        *value /= norm;
    }
    centroid
}

fn embedding_cosine(catalog: &SymbolicCatalog<'_>, left: usize, right: usize) -> f64 {
    let left_start = left * catalog.embedding_dimension;
    let right_start = right * catalog.embedding_dimension;
    catalog.embeddings[left_start..left_start + catalog.embedding_dimension]
        .iter()
        .zip(&catalog.embeddings[right_start..right_start + catalog.embedding_dimension])
        .map(|(left, right)| *left as f64 * *right as f64)
        .sum()
}

fn program_union_is_strongly_connected(atlas: &NeuralProgramAtlas) -> bool {
    let mut outgoing = vec![Vec::new(); atlas.track_count];
    let mut incoming = vec![Vec::new(); atlas.track_count];
    for program in &atlas.programs {
        for (source, destination) in program.successors.iter().enumerate() {
            outgoing[source].push(*destination);
            incoming[*destination].push(source);
        }
    }
    reachable_count(&outgoing, 0) == atlas.track_count
        && reachable_count(&incoming, 0) == atlas.track_count
}

fn reachable_count(edges: &[Vec<usize>], root: usize) -> usize {
    let mut visited = vec![false; edges.len()];
    visited[root] = true;
    let mut stack = vec![root];
    let mut count = 0;
    while let Some(node) = stack.pop() {
        count += 1;
        for successor in &edges[node] {
            if !visited[*successor] {
                visited[*successor] = true;
                stack.push(*successor);
            }
        }
    }
    count
}

fn metric_summary(values: &[f64]) -> Value {
    json!({
        "mean": mean(values),
        "p50": quantile(values, 0.50),
        "p90": quantile(values, 0.90),
        "p99": quantile(values, 0.99),
        "maximum": values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        "minimum": values.iter().copied().fold(f64::INFINITY, f64::min),
        "count": values.len(),
    })
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len().max(1) as f64
}

fn quantile(values: &[f64], probability: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut ordered = values.to_vec();
    ordered.sort_unstable_by(f64::total_cmp);
    let position = probability.clamp(0.0, 1.0) * (ordered.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    let fraction = position - lower as f64;
    ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction
}

fn set_bit(bits: &mut [u64], index: usize) {
    bits[index / 64] |= 1_u64 << (index % 64);
}

fn contains_bit(bits: &[u64], index: usize) -> bool {
    bits[index / 64] & (1_u64 << (index % 64)) != 0
}

fn intersection_count(left: &[u64], right: &[u64]) -> usize {
    left.iter()
        .zip(right)
        .map(|(left, right)| (left & right).count_ones() as usize)
        .sum()
}
