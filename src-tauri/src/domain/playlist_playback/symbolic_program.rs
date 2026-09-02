// Deterministic neural-program traversal shared by production and probes.
//
// Generation-owned candidate presentations are restricted to the playlist
// before path-fair closure. Graph splices become semantic sector departures
// only under strict positive contrast against the existing local candidate
// field. Execution state survives queue boundaries and complete finite
// coverage without rebuilding a request-local candidate relation.

#[cfg(test)]
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::ops::Bound::{Excluded, Unbounded};
use std::sync::Arc;

const FATIGUE_RECOVERY_REBALANCE_STEPS: usize = 64;
const FATIGUE_RECOVERY_CANDIDATES_PER_STEP: usize = 128;
const FATIGUE_RECOVERY_DECAY_NUMERATORS: [u128; 4] = [1, 3, 7, 15];
const FATIGUE_RECOVERY_DECAY_DENOMINATORS: [u128; 4] = [2, 4, 8, 16];
const FATIGUE_PRESSURE_SCALE: u128 = 1_u128 << 48;
const FATIGUE_MARGIN_SCALE: i128 = 1_i128 << 40;
const NORMAL_FATIGUE_AUXILIARY_DOMAIN: &[u8] = b"slisic.normal-fatigue-auxiliary.v1";
const NORMAL_CDF_NEGATIVE_ONE_U64: u64 = 2_926_672_865_222_990_848;
const NORMAL_CDF_POSITIVE_ONE_U64: u64 = 15_520_071_208_486_559_744;

#[cfg(test)]
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
    pub(crate) boundary_sources: Vec<usize>,
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
pub(crate) struct PathFairCompilationResult {
    pub(crate) atlas: Option<NeuralProgramAtlas>,
    pub(crate) retracted_presentations: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlaylistScopedProgramAtlas {
    pub(crate) atlas: NeuralProgramAtlas,
    pub(crate) global_track_ordinals: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgramOrbitIndex {
    cycle_ids: Vec<Vec<usize>>,
    cycle_masks: Vec<Vec<Vec<u64>>>,
    coverage_successors: Vec<(usize, usize)>,
    predecessors: Vec<Vec<usize>>,
}

/// A prepared region opportunity belongs to one path, not to the immutable
/// model atlas. Keeping only changed edges lets the atlas and its orbit index
/// stay shared across session clones while a path temporarily conjugates its
/// active cyclic program.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProgramPathOverlay {
    program_ordinal: usize,
    successor_overrides: HashMap<usize, usize>,
    predecessor_overrides: HashMap<usize, usize>,
    boundary_sources: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceFatigueAggregate {
    minimum_recovery: usize,
    short_returns: usize,
    event_count: usize,
    gap_sum: usize,
    recovery_pressures: [u128; FATIGUE_RECOVERY_DECAY_NUMERATORS.len()],
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceFatigueCache {
    program_ordinal: usize,
    cycle: Vec<usize>,
    positions_by_track: Vec<usize>,
    carriers_by_track: Vec<usize>,
    positions_by_carrier: HashMap<usize, Vec<usize>>,
    scores_by_carrier: HashMap<usize, FatigueCarrierScore>,
    minimum_recovery_counts: BTreeMap<usize, usize>,
    aggregate: SourceFatigueAggregate,
    /// The score captured before the first accepted transposition on this
    /// active program. This value is deliberately never replaced by the
    /// current trial or commit score.
    initial_aggregate: SourceFatigueAggregate,
    pressure_lookup: Arc<Vec<[u128; 4]>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgramPathState {
    current_track: usize,
    active_program: usize,
    tie_cursor: usize,
    realized_history: Vec<u64>,
    residence_steps: usize,
    coverage_epoch: usize,
    overlay: Option<ProgramPathOverlay>,
    source_fatigue_cache: Option<SourceFatigueCache>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgramOwnedTraversalState {
    paths: Vec<ProgramPathState>,
    pub(crate) playback_cycle: usize,
}

impl ProgramOwnedTraversalState {
    pub(crate) fn current_track(&self, path_ordinal: usize) -> Option<usize> {
        self.paths.get(path_ordinal).map(|path| path.current_track)
    }

    pub(crate) fn coverage_epoch(&self, path_ordinal: usize) -> Option<usize> {
        self.paths.get(path_ordinal).map(|path| path.coverage_epoch)
    }

    pub(crate) fn active_program(&self, path_ordinal: usize) -> Option<usize> {
        self.paths.get(path_ordinal).map(|path| path.active_program)
    }

    pub(crate) fn is_track_realized(&self, path_ordinal: usize, track: usize) -> Option<bool> {
        self.paths
            .get(path_ordinal)
            .map(|path| contains_bit(&path.realized_history, track))
    }

    pub(crate) fn realized_tracks(&self, path_ordinal: usize) -> Option<Vec<usize>> {
        self.paths.get(path_ordinal).map(|path| {
            (0..path.realized_history.len() * 64)
                .filter(|track| contains_bit(&path.realized_history, *track))
                .collect()
        })
    }

    #[cfg(test)]
    pub(crate) fn source_fatigue_cycle_for_test(&self, path_ordinal: usize) -> Option<Vec<usize>> {
        self.paths
            .get(path_ordinal)
            .and_then(|path| path.source_fatigue_cache.as_ref())
            .map(|cache| cache.cycle.clone())
    }

    #[cfg(test)]
    pub(crate) fn source_fatigue_baselines_for_test(
        &self,
        path_ordinal: usize,
    ) -> Option<(
        (
            usize,
            usize,
            usize,
            usize,
            [u128; FATIGUE_RECOVERY_DECAY_NUMERATORS.len()],
        ),
        (
            usize,
            usize,
            usize,
            usize,
            [u128; FATIGUE_RECOVERY_DECAY_NUMERATORS.len()],
        ),
    )> {
        self.paths
            .get(path_ordinal)
            .and_then(|path| path.source_fatigue_cache.as_ref())
            .map(|cache| {
                (
                    (
                        cache.aggregate.minimum_recovery,
                        cache.aggregate.short_returns,
                        cache.aggregate.event_count,
                        cache.aggregate.gap_sum,
                        cache.aggregate.recovery_pressures,
                    ),
                    (
                        cache.initial_aggregate.minimum_recovery,
                        cache.initial_aggregate.short_returns,
                        cache.initial_aggregate.event_count,
                        cache.initial_aggregate.gap_sum,
                        cache.initial_aggregate.recovery_pressures,
                    ),
                )
            })
    }

    #[cfg(test)]
    pub(crate) fn has_source_fatigue_cache_for_test(&self, path_ordinal: usize) -> bool {
        self.paths
            .get(path_ordinal)
            .is_some_and(|path| path.source_fatigue_cache.is_some())
    }

    #[cfg(test)]
    pub(crate) fn overlay_program_for_test(&self, path_ordinal: usize) -> Option<usize> {
        self.paths
            .get(path_ordinal)
            .and_then(|path| path.overlay.as_ref())
            .map(|overlay| overlay.program_ordinal)
    }

    #[cfg(test)]
    pub(crate) fn effective_successor_for_test(
        &self,
        atlas: &NeuralProgramAtlas,
        path_ordinal: usize,
        program_ordinal: usize,
        source: usize,
    ) -> Option<usize> {
        let path = self.paths.get(path_ordinal)?;
        (program_ordinal < atlas.programs.len() && source < atlas.track_count)
            .then(|| effective_successor(atlas, path, program_ordinal, source))
    }

    #[cfg(test)]
    pub(crate) fn effective_predecessor_for_test(
        &self,
        atlas: &NeuralProgramAtlas,
        orbit_index: &ProgramOrbitIndex,
        path_ordinal: usize,
        program_ordinal: usize,
        destination: usize,
    ) -> Option<usize> {
        let path = self.paths.get(path_ordinal)?;
        let predecessors = orbit_index.predecessors.get(program_ordinal)?;
        (program_ordinal < atlas.programs.len() && destination < atlas.track_count)
            .then(|| effective_predecessor(predecessors, path, program_ordinal, destination))
    }

    #[cfg(test)]
    pub(crate) fn effective_boundary_source_for_test(
        &self,
        atlas: &NeuralProgramAtlas,
        path_ordinal: usize,
        program_ordinal: usize,
        source: usize,
    ) -> Option<bool> {
        let path = self.paths.get(path_ordinal)?;
        (program_ordinal < atlas.programs.len() && source < atlas.track_count)
            .then(|| effective_boundary_source(atlas, path, program_ordinal, source))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgramList {
    pub(crate) path_count: usize,
    pub(crate) tracks_per_list: usize,
    pub(crate) order: Vec<usize>,
    source_ordinals: Vec<usize>,
    pub(crate) program_ordinals: Vec<usize>,
    pub(crate) departures: Vec<bool>,
    pub(crate) style_sector_departures: Vec<bool>,
    pub(crate) coverage_epoch_transitions: Vec<bool>,
    pub(crate) opportunity_swaps: Vec<bool>,
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

#[cfg(test)]
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
                lineage: successor_lineage(track_keys, &successors, &[]),
                presentation_ordinals: vec![presentation],
                successors,
                boundary_sources: Vec::new(),
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
        if !program.boundary_sources.is_empty() {
            digest.update(b"boundaries:");
            digest.update(
                program
                    .boundary_sources
                    .iter()
                    .map(usize::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
                    .as_bytes(),
            );
            digest.update(b"\n");
        }
    }
    format!("audio-program-encoding:{}", hex_digest(digest.finalize()))
}

fn successor_lineage(
    track_keys: &[String],
    successors: &[usize],
    boundary_sources: &[usize],
) -> String {
    let mut source_order = (0..track_keys.len()).collect::<Vec<_>>();
    source_order.sort_unstable_by(|left, right| track_keys[*left].cmp(&track_keys[*right]));
    let mut digest = Sha256::new();
    for source in source_order {
        digest.update(track_keys[source].as_bytes());
        digest.update(b"\0");
        digest.update(track_keys[successors[source]].as_bytes());
        digest.update(b"\n");
    }
    let mut boundary_order = boundary_sources.to_vec();
    boundary_order.sort_unstable_by(|left, right| track_keys[*left].cmp(&track_keys[*right]));
    for source in boundary_order {
        digest.update(b"boundary\0");
        digest.update(track_keys[source].as_bytes());
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

fn permutation_cycle_ids(successors: &[usize]) -> Vec<usize> {
    let mut cycle_ids = vec![usize::MAX; successors.len()];
    let mut cycle = 0;
    for root in 0..successors.len() {
        if cycle_ids[root] != usize::MAX {
            continue;
        }
        let mut node = root;
        while cycle_ids[node] == usize::MAX {
            cycle_ids[node] = cycle;
            node = successors[node];
        }
        cycle += 1;
    }
    cycle_ids
}

pub(crate) fn program_cycle_separations(
    atlas: &NeuralProgramAtlas,
    neighbors: &[usize],
) -> Result<Vec<usize>, String> {
    if neighbors.len() != atlas.track_count * atlas.candidate_count {
        return Err("candidate relation and program atlas must align".to_string());
    }
    let cycle_ids = atlas
        .programs
        .iter()
        .map(|program| permutation_cycle_ids(&program.successors))
        .collect::<Vec<_>>();
    let mut separations = vec![0; neighbors.len()];
    for source in 0..atlas.track_count {
        for (rank, destination) in neighbors
            [source * atlas.candidate_count..(source + 1) * atlas.candidate_count]
            .iter()
            .copied()
            .enumerate()
        {
            separations[source * atlas.candidate_count + rank] = cycle_ids
                .iter()
                .filter(|program_cycles| program_cycles[source] != program_cycles[destination])
                .count();
        }
    }
    Ok(separations)
}

pub(crate) fn candidate_neighborhood_overlaps(
    track_count: usize,
    candidate_count: usize,
    neighbors: &[usize],
) -> Result<Vec<usize>, String> {
    if neighbors.len() != track_count * candidate_count {
        return Err("candidate relation shape is invalid".to_string());
    }
    let sets = neighbors
        .chunks_exact(candidate_count)
        .map(|row| row.iter().copied().collect::<HashSet<_>>())
        .collect::<Vec<_>>();
    Ok(neighbors
        .chunks_exact(candidate_count)
        .enumerate()
        .flat_map(|(source, row)| {
            row.iter()
                .map(|destination| sets[source].intersection(&sets[*destination]).count())
                .collect::<Vec<_>>()
        })
        .collect())
}

fn close_successor_law_to_single_cycle(
    successors: &[usize],
    candidate_count: usize,
    neighbors: &[usize],
    candidate_separations: &[usize],
    candidate_local_overlaps: &[usize],
    candidate_ranks_by_source: &[Vec<usize>],
    track_keys: &[String],
) -> Option<Vec<usize>> {
    let original = successors.to_vec();
    let mut closed = original.clone();
    let mut changed_sources = Vec::<usize>::new();
    let mut changed_flags = vec![false; closed.len()];

    loop {
        let cycle_ids = permutation_cycle_ids(&closed);
        if cycle_ids.iter().copied().max().unwrap_or(0) == 0 {
            return Some(closed);
        }
        let mut predecessor = vec![0; closed.len()];
        for (source, destination) in closed.iter().copied().enumerate() {
            predecessor[destination] = source;
        }
        let mut best = None;
        for left_source in 0..closed.len() {
            let left_destination = closed[left_source];
            let left_row =
                &neighbors[left_source * candidate_count..(left_source + 1) * candidate_count];
            for (left_rank, right_destination) in left_row.iter().copied().enumerate() {
                let right_source = predecessor[right_destination];
                if cycle_ids[left_source] == cycle_ids[right_source] {
                    continue;
                }
                let right_rank = candidate_ranks_by_source[right_source][left_destination];
                if right_rank == usize::MAX {
                    continue;
                }
                let left_changed = right_destination != original[left_source];
                let right_changed = left_destination != original[right_source];
                let previous_left_changed = changed_flags[left_source];
                let previous_right_changed = changed_flags[right_source];
                changed_flags[left_source] = left_changed;
                changed_flags[right_source] = right_changed;
                let changed_mapping_is_closed = changed_sources
                    .iter()
                    .copied()
                    .filter(|source| *source != left_source && *source != right_source)
                    .any(|source| changed_flags[closed[source]])
                    || (left_changed && changed_flags[right_destination])
                    || (right_changed && changed_flags[left_destination]);
                if changed_mapping_is_closed {
                    changed_flags[left_source] = previous_left_changed;
                    changed_flags[right_source] = previous_right_changed;
                    continue;
                }
                let left_separation =
                    candidate_separations[left_source * candidate_count + left_rank];
                let right_separation =
                    candidate_separations[right_source * candidate_count + right_rank];
                let left_overlap =
                    candidate_local_overlaps[left_source * candidate_count + left_rank];
                let right_overlap =
                    candidate_local_overlaps[right_source * candidate_count + right_rank];
                let score = (
                    left_overlap.max(right_overlap),
                    left_overlap + right_overlap,
                    std::cmp::Reverse(left_separation.min(right_separation)),
                    std::cmp::Reverse(left_separation + right_separation),
                    track_keys[left_source].as_str(),
                    track_keys[right_source].as_str(),
                );
                if best
                    .as_ref()
                    .is_none_or(|(best_score, _, _)| score < *best_score)
                {
                    best = Some((score, left_source, right_source));
                }
            }
        }
        let (_, left_source, right_source) = best?;
        let left_destination = closed[left_source];
        closed[left_source] = closed[right_source];
        closed[right_source] = left_destination;
        changed_sources.retain(|source| *source != left_source && *source != right_source);
        if closed[left_source] != original[left_source] {
            changed_sources.push(left_source);
        }
        if closed[right_source] != original[right_source] {
            changed_sources.push(right_source);
        }
        changed_flags[left_source] = closed[left_source] != original[left_source];
        changed_flags[right_source] = closed[right_source] != original[right_source];
    }
}

// @forma implements architecture Domain.PlaylistScopedPathFairExecution as close_neural_program_atlas_cycles
// @forma implements architecture Domain.SemanticStyleSectorTraversal as close_neural_program_atlas_cycles
pub(crate) fn close_neural_program_atlas_cycles(
    atlas: &NeuralProgramAtlas,
    neighbors: &[usize],
    track_keys: &[String],
) -> Result<PathFairCompilationResult, String> {
    if track_keys.len() != atlas.track_count
        || neighbors.len() != atlas.track_count * atlas.candidate_count
    {
        return Err("candidate relation and program atlas must align".to_string());
    }
    let candidate_separations = program_cycle_separations(atlas, neighbors)?;
    let candidate_local_overlaps =
        candidate_neighborhood_overlaps(atlas.track_count, atlas.candidate_count, neighbors)?;
    let candidate_ranks_by_source = neighbors
        .chunks_exact(atlas.candidate_count)
        .map(|row| {
            let mut ranks = vec![usize::MAX; atlas.track_count];
            for (rank, destination) in row.iter().copied().enumerate() {
                ranks[destination] = rank;
            }
            ranks
        })
        .collect::<Vec<_>>();
    let overlap_by_destination = (0..atlas.track_count)
        .map(|source| {
            let row =
                &neighbors[source * atlas.candidate_count..(source + 1) * atlas.candidate_count];
            let overlap_row = &candidate_local_overlaps
                [source * atlas.candidate_count..(source + 1) * atlas.candidate_count];
            let mut overlaps = vec![0; atlas.track_count];
            for (destination, overlap) in row.iter().copied().zip(overlap_row.iter().copied()) {
                overlaps[destination] = overlap;
            }
            overlaps
        })
        .collect::<Vec<_>>();
    let mut programs = Vec::<ProgramMorphism>::new();
    let mut program_by_code = HashMap::<(Vec<usize>, Vec<usize>), usize>::new();
    let mut retracted = Vec::new();
    for program in &atlas.programs {
        let Some(successors) = close_successor_law_to_single_cycle(
            &program.successors,
            atlas.candidate_count,
            neighbors,
            &candidate_separations,
            &candidate_local_overlaps,
            &candidate_ranks_by_source,
            track_keys,
        ) else {
            retracted.extend(program.presentation_ordinals.iter().copied());
            continue;
        };
        let boundary_sources = program
            .successors
            .iter()
            .copied()
            .zip(successors.iter().copied())
            .enumerate()
            .filter_map(|(source, (before, after))| {
                (before != after
                    && overlap_by_destination[source][after]
                        < overlap_by_destination[source][before])
                    .then_some(source)
            })
            .collect::<Vec<_>>();
        let code = (successors.clone(), boundary_sources.clone());
        if let Some(index) = program_by_code.get(&code).copied() {
            programs[index]
                .presentation_ordinals
                .extend(program.presentation_ordinals.iter().copied());
            programs[index].presentation_ordinals.sort_unstable();
            programs[index].presentation_ordinals.dedup();
            continue;
        }
        program_by_code.insert(code, programs.len());
        programs.push(ProgramMorphism {
            lineage: successor_lineage(track_keys, &successors, &boundary_sources),
            presentation_ordinals: program.presentation_ordinals.clone(),
            successors,
            boundary_sources,
        });
    }
    retracted.sort_unstable();
    Ok(PathFairCompilationResult {
        atlas: (!programs.is_empty()).then_some(NeuralProgramAtlas {
            track_count: atlas.track_count,
            candidate_count: atlas.candidate_count,
            programs,
        }),
        retracted_presentations: retracted,
    })
}

// @forma implements architecture Domain.PlaylistScopedProgramExecution as restrict_neural_program_atlas_to_playlist
pub(crate) fn restrict_neural_program_atlas_to_playlist(
    atlas: &NeuralProgramAtlas,
    track_keys: &[String],
    playlist_track_ordinals: &[usize],
) -> Result<PlaylistScopedProgramAtlas, String> {
    if track_keys.len() != atlas.track_count {
        return Err("program atlas and stable track keys must align".to_string());
    }
    let mut selected = playlist_track_ordinals.to_vec();
    selected.sort_unstable();
    selected.dedup();
    if selected.is_empty() {
        return Err("playlist program scope must contain an encoded track".to_string());
    }
    if selected.iter().any(|ordinal| *ordinal >= atlas.track_count) {
        return Err("playlist program scope contains an invalid track".to_string());
    }
    selected.sort_unstable_by(|left, right| track_keys[*left].cmp(&track_keys[*right]));
    let mut local_by_global = vec![None; atlas.track_count];
    for (local, global) in selected.iter().copied().enumerate() {
        local_by_global[global] = Some(local);
    }
    let scoped_track_keys = selected
        .iter()
        .map(|ordinal| track_keys[*ordinal].clone())
        .collect::<Vec<_>>();
    let mut programs = Vec::<ProgramMorphism>::new();
    let mut program_by_code = HashMap::<(Vec<usize>, Vec<usize>), usize>::new();
    for program in &atlas.programs {
        let mut boundary_flags = vec![false; atlas.track_count];
        for source in program.boundary_sources.iter().copied() {
            boundary_flags[source] = true;
        }
        let mut visited = vec![false; atlas.track_count];
        let mut returned_locals = vec![usize::MAX; atlas.track_count];
        let mut crossed_boundaries = vec![false; atlas.track_count];
        for root in 0..atlas.track_count {
            if visited[root] {
                continue;
            }
            let mut cycle = Vec::new();
            let mut node = root;
            while !visited[node] {
                visited[node] = true;
                cycle.push(node);
                node = program.successors[node];
            }
            let cycle_length = cycle.len();
            if cycle_length == 0 {
                continue;
            }
            let mut next_selected_positions = vec![usize::MAX; cycle_length];
            let mut next_selected = usize::MAX;
            for doubled_position in (0..cycle_length * 2).rev() {
                let position = doubled_position % cycle_length;
                next_selected_positions[position] = next_selected;
                if local_by_global[cycle[position]].is_some() {
                    next_selected = position;
                }
            }
            let mut boundary_prefix = vec![0usize; cycle_length * 2 + 1];
            for doubled_position in 0..cycle_length * 2 {
                boundary_prefix[doubled_position + 1] = boundary_prefix[doubled_position]
                    + usize::from(boundary_flags[cycle[doubled_position % cycle_length]]);
            }
            for position in 0..cycle_length {
                let global_source = cycle[position];
                if local_by_global[global_source].is_none() {
                    continue;
                }
                let next_position = next_selected_positions[position];
                if next_position == usize::MAX {
                    return Err("program orbit has no playlist return".to_string());
                }
                let global_destination = cycle[next_position];
                returned_locals[global_source] = local_by_global[global_destination]
                    .ok_or_else(|| "program orbit has no playlist return".to_string())?;
                let interval_end = if next_position > position {
                    next_position
                } else {
                    next_position + cycle_length
                };
                crossed_boundaries[global_source] =
                    boundary_prefix[interval_end] > boundary_prefix[position];
            }
        }
        let mut successors = Vec::with_capacity(selected.len());
        let mut boundary_sources = Vec::new();
        for (local_source, global_source) in selected.iter().copied().enumerate() {
            let returned = returned_locals[global_source];
            if returned == usize::MAX {
                return Err("program orbit has no playlist return".to_string());
            }
            if crossed_boundaries[global_source] {
                boundary_sources.push(local_source);
            }
            successors.push(returned);
        }
        let code = (successors.clone(), boundary_sources.clone());
        if let Some(index) = program_by_code.get(&code).copied() {
            programs[index]
                .presentation_ordinals
                .extend(program.presentation_ordinals.iter().copied());
            programs[index].presentation_ordinals.sort_unstable();
            programs[index].presentation_ordinals.dedup();
            continue;
        }
        program_by_code.insert(code, programs.len());
        programs.push(ProgramMorphism {
            lineage: successor_lineage(&scoped_track_keys, &successors, &boundary_sources),
            presentation_ordinals: program.presentation_ordinals.clone(),
            successors,
            boundary_sources,
        });
    }
    programs.sort_by_key(|program| {
        (
            program
                .successors
                .iter()
                .enumerate()
                .any(|(source, destination)| source == *destination),
            program
                .presentation_ordinals
                .iter()
                .copied()
                .min()
                .unwrap_or(0),
        )
    });
    Ok(PlaylistScopedProgramAtlas {
        atlas: NeuralProgramAtlas {
            track_count: selected.len(),
            candidate_count: atlas.candidate_count,
            programs,
        },
        global_track_ordinals: selected,
    })
}

pub(crate) fn candidate_relation_from_program_atlas(
    atlas: &NeuralProgramAtlas,
) -> Result<Vec<usize>, String> {
    let mut owners = vec![None; atlas.candidate_count];
    for (program_index, program) in atlas.programs.iter().enumerate() {
        for presentation in &program.presentation_ordinals {
            let Some(owner) = owners.get_mut(*presentation) else {
                return Err("program presentation is outside candidate width".to_string());
            };
            *owner = Some(program_index);
        }
    }
    if owners.iter().any(Option::is_none) {
        return Err("program atlas does not own every candidate presentation".to_string());
    }
    Ok((0..atlas.track_count)
        .flat_map(|source| {
            owners
                .iter()
                .map(|owner| atlas.programs[owner.unwrap()].successors[source])
                .collect::<Vec<_>>()
        })
        .collect())
}

// @forma implements material ResearchCandidateTransfer.split_and_merge_program_species as compile_program_orbit_index
pub(crate) fn compile_program_orbit_index(
    atlas: &NeuralProgramAtlas,
) -> Result<ProgramOrbitIndex, String> {
    let word_count = atlas.track_count.div_ceil(64);
    let mut all_cycle_ids = Vec::with_capacity(atlas.programs.len());
    let mut all_cycle_masks = Vec::with_capacity(atlas.programs.len());
    let mut all_predecessors = Vec::with_capacity(atlas.programs.len());
    for program in &atlas.programs {
        let predecessors = successor_predecessors(&program.successors)?;
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
        all_predecessors.push(predecessors);
    }
    let coverage_successors = atlas
        .programs
        .iter()
        .enumerate()
        .map(|(program_ordinal, program)| {
            atlas
                .programs
                .iter()
                .enumerate()
                .filter(|(candidate_ordinal, _)| *candidate_ordinal != program_ordinal)
                .map(|(candidate_ordinal, candidate)| {
                    (
                        maximum_common_successor_run(program, candidate),
                        program
                            .successors
                            .iter()
                            .zip(&candidate.successors)
                            .filter(|(left, right)| left == right)
                            .count(),
                        candidate.lineage.as_str(),
                        candidate_ordinal,
                    )
                })
                .min()
                .map(|(_, _, _, candidate_ordinal)| (candidate_ordinal, 1))
                .unwrap_or((program_ordinal, 0))
        })
        .collect();
    Ok(ProgramOrbitIndex {
        cycle_ids: all_cycle_ids,
        cycle_masks: all_cycle_masks,
        coverage_successors,
        predecessors: all_predecessors,
    })
}

fn single_program_cycle(program: &ProgramMorphism) -> Option<Vec<usize>> {
    let track_count = program.successors.len();
    if track_count == 0
        || program
            .successors
            .iter()
            .any(|destination| *destination >= track_count)
    {
        return None;
    }
    let mut visited = vec![false; track_count];
    let mut cycle = Vec::with_capacity(track_count);
    let mut node = 0;
    while !visited[node] {
        visited[node] = true;
        cycle.push(node);
        node = program.successors[node];
    }
    (node == 0 && cycle.len() == track_count).then_some(cycle)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FatigueChunk {
    start: usize,
    end: usize,
    carrier: usize,
    start_position: usize,
    end_position: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FatigueCarrierScore {
    short_returns: usize,
    event_count: usize,
    minimum_recovery: usize,
    gap_sum: usize,
    recovery_pressures: [u128; FATIGUE_RECOVERY_DECAY_NUMERATORS.len()],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct FatigueChunkRelocation {
    start: usize,
    end: usize,
    insertion_source: usize,
    previous: usize,
    following: usize,
    insertion_destination: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NormalFatigueAuxiliary {
    DirectStyleJump,
    RequestLocalAuditoryChunk,
}

pub(crate) fn normal_fatigue_auxiliary(
    track_keys: &[String],
    candidate: (usize, usize, usize, usize, usize),
) -> NormalFatigueAuxiliary {
    let mut digest = Sha256::new();
    digest.update(NORMAL_FATIGUE_AUXILIARY_DOMAIN);
    for ordinal in [
        candidate.0,
        candidate.1,
        candidate.2,
        candidate.3,
        candidate.4,
    ] {
        let encoded = track_keys[ordinal].as_bytes();
        digest.update((encoded.len() as u64).to_le_bytes());
        digest.update(encoded);
    }
    let digest = digest.finalize();
    let quantile = u64::from_be_bytes(
        digest[..8]
            .try_into()
            .expect("SHA-256 prefix is eight bytes"),
    );
    if (NORMAL_CDF_NEGATIVE_ONE_U64..NORMAL_CDF_POSITIVE_ONE_U64).contains(&quantile) {
        NormalFatigueAuxiliary::DirectStyleJump
    } else {
        NormalFatigueAuxiliary::RequestLocalAuditoryChunk
    }
}

fn successor_predecessors(successors: &[usize]) -> Result<Vec<usize>, String> {
    let mut predecessors = vec![usize::MAX; successors.len()];
    for (source, destination) in successors.iter().copied().enumerate() {
        if destination >= successors.len() || predecessors[destination] != usize::MAX {
            return Err("successor law is not a permutation".to_string());
        }
        predecessors[destination] = source;
    }
    Ok(predecessors)
}

fn fatigue_chunks(cycle: &[usize], carrier_ordinals: &[usize]) -> Vec<FatigueChunk> {
    if cycle.is_empty() {
        return Vec::new();
    }
    let Some(rotation) = cycle.iter().enumerate().find_map(|(position, track)| {
        (carrier_ordinals[*track]
            != carrier_ordinals[cycle[(position + cycle.len() - 1) % cycle.len()]])
        .then_some(position)
    }) else {
        return vec![FatigueChunk {
            start: cycle[0],
            end: *cycle.last().unwrap(),
            carrier: carrier_ordinals[cycle[0]],
            start_position: 0,
            end_position: cycle.len() - 1,
        }];
    };
    let ordered = cycle
        .iter()
        .cycle()
        .skip(rotation)
        .take(cycle.len())
        .copied()
        .collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut start = ordered[0];
    let mut previous = ordered[0];
    let mut start_position = 0;
    let mut carrier = carrier_ordinals[start];
    for (position, track) in ordered.iter().copied().enumerate().skip(1) {
        let track_carrier = carrier_ordinals[track];
        if track_carrier != carrier {
            chunks.push(FatigueChunk {
                start,
                end: previous,
                carrier,
                start_position,
                end_position: position - 1,
            });
            start = track;
            start_position = position;
            carrier = track_carrier;
        }
        previous = track;
    }
    chunks.push(FatigueChunk {
        start,
        end: previous,
        carrier,
        start_position,
        end_position: ordered.len() - 1,
    });
    chunks
}

fn fatigue_pressure_lookup(maximum_gap: usize) -> Vec<[u128; 4]> {
    let mut lookup = Vec::with_capacity(maximum_gap + 1);
    lookup.push([FATIGUE_PRESSURE_SCALE; 4]);
    for gap in 1..=maximum_gap {
        let mut pressures = [0; 4];
        for scale in 0..pressures.len() {
            pressures[scale] = lookup[gap - 1][scale] * FATIGUE_RECOVERY_DECAY_NUMERATORS[scale]
                / FATIGUE_RECOVERY_DECAY_DENOMINATORS[scale];
        }
        lookup.push(pressures);
    }
    lookup
}

fn fatigue_carrier_score(
    cycle: &[usize],
    carrier_ordinals: &[usize],
    pressure_lookup: &[[u128; 4]],
) -> FatigueCarrierScore {
    let mut chunks_by_carrier = HashMap::<usize, Vec<FatigueChunk>>::new();
    for chunk in fatigue_chunks(cycle, carrier_ordinals) {
        chunks_by_carrier
            .entry(chunk.carrier)
            .or_default()
            .push(chunk);
    }
    let mut short_returns = 0;
    let mut event_count = 0;
    let mut recovery_witness = Vec::new();
    let mut gap_sum = 0;
    let mut recovery_pressures = [0_u128; FATIGUE_RECOVERY_DECAY_NUMERATORS.len()];
    for chunks in chunks_by_carrier.into_values() {
        let occurrence_count = chunks.len();
        for (index, chunk) in chunks.iter().enumerate() {
            let following = chunks[(index + 1) % occurrence_count];
            let gap =
                (cycle.len() + following.start_position - chunk.end_position - 1) % cycle.len();
            short_returns += usize::from(gap <= 2);
            event_count += 1;
            gap_sum += gap;
            recovery_witness.push(gap * occurrence_count);
            for (target, pressure) in recovery_pressures.iter_mut().zip(pressure_lookup[gap]) {
                *target += pressure;
            }
        }
    }
    recovery_witness.sort_unstable();
    FatigueCarrierScore {
        short_returns,
        event_count,
        minimum_recovery: recovery_witness.first().copied().unwrap_or(0),
        gap_sum,
        recovery_pressures,
    }
}

#[cfg(test)]
pub(crate) fn fatigue_carrier_score_for_test(
    cycle: &[usize],
    carrier_ordinals: &[usize],
) -> (
    usize,
    usize,
    usize,
    usize,
    [u128; FATIGUE_RECOVERY_DECAY_NUMERATORS.len()],
) {
    let pressure_lookup = fatigue_pressure_lookup(cycle.len());
    let score = fatigue_carrier_score(cycle, carrier_ordinals, &pressure_lookup);
    (
        score.minimum_recovery,
        score.short_returns,
        score.event_count,
        score.gap_sum,
        score.recovery_pressures,
    )
}

fn fatigue_scores(
    cycle: &[usize],
    recovery_carriers: &[&[usize]],
    pressure_lookup: &[[u128; 4]],
) -> Vec<FatigueCarrierScore> {
    recovery_carriers
        .iter()
        .map(|carrier| fatigue_carrier_score(cycle, carrier, pressure_lookup))
        .collect()
}

fn normalized_fatigue_margin(numerator: i128, denominator: u128) -> i128 {
    numerator.saturating_mul(FATIGUE_MARGIN_SCALE) / denominator.max(1) as i128
}

fn fatigue_target_key(
    cycle: &[usize],
    recovery_carriers: &[&[usize]],
    targets: &[FatigueCarrierScore],
    pressure_lookup: &[[u128; 4]],
) -> Vec<i128> {
    let scores = fatigue_scores(cycle, recovery_carriers, pressure_lookup);
    let mut margins = Vec::new();
    for (score, target) in scores.iter().zip(targets) {
        margins.push(normalized_fatigue_margin(
            score.minimum_recovery as i128 - target.minimum_recovery as i128,
            target.minimum_recovery.max(1) as u128,
        ));
        margins.push(normalized_fatigue_margin(
            (score.gap_sum as u128 * target.event_count as u128) as i128
                - (target.gap_sum as u128 * score.event_count as u128) as i128,
            target.gap_sum as u128 * score.event_count as u128,
        ));
        for (pressure, target_pressure) in score
            .recovery_pressures
            .iter()
            .zip(target.recovery_pressures)
        {
            margins.push(normalized_fatigue_margin(
                (target_pressure * score.event_count as u128) as i128
                    - (*pressure * target.event_count as u128) as i128,
                target_pressure * score.event_count as u128,
            ));
        }
        margins.push(normalized_fatigue_margin(
            (target.short_returns as u128 * score.event_count as u128) as i128
                - (score.short_returns as u128 * target.event_count as u128) as i128,
            target.short_returns as u128 * score.event_count as u128,
        ));
    }
    margins.sort_unstable();
    margins
}

fn fatigue_recovery_target_met(
    proposed: &[FatigueCarrierScore],
    target: &[FatigueCarrierScore],
) -> bool {
    proposed.iter().zip(target).all(|(score, baseline)| {
        score.minimum_recovery >= baseline.minimum_recovery
            && score.short_returns as u128 * baseline.event_count as u128
                <= baseline.short_returns as u128 * score.event_count as u128
            && score
                .recovery_pressures
                .iter()
                .zip(baseline.recovery_pressures)
                .all(|(pressure, baseline_pressure)| {
                    *pressure * (baseline.event_count as u128)
                        < baseline_pressure * (score.event_count as u128)
                })
    })
}

fn same_carrier_edge_count(successors: &[usize], carrier_ordinals: &[usize]) -> usize {
    successors
        .iter()
        .enumerate()
        .filter(|(source, destination)| {
            carrier_ordinals[*source] == carrier_ordinals[**destination]
        })
        .count()
}

fn pair_isolated_fatigue_visits(
    successors: &mut [usize],
    candidate_sets: &[HashSet<usize>],
    incoming: &[Vec<usize>],
    acoustic_basins: &[usize],
    track_keys: &[String],
    apply_normal_auxiliary: bool,
) -> Result<(), String> {
    loop {
        let predecessors = successor_predecessors(successors)?;
        let mut selected = None::<(usize, usize, usize, usize, usize)>;
        for track in 0..successors.len() {
            let previous = predecessors[track];
            let following = successors[track];
            let basin = acoustic_basins[track];
            if acoustic_basins[previous] == basin
                || acoustic_basins[following] == basin
                || !candidate_sets[previous].contains(&following)
            {
                continue;
            }
            for insertion_source in incoming[track].iter().copied() {
                let insertion_destination = successors[insertion_source];
                if insertion_source == track
                    || insertion_source == previous
                    || insertion_destination == track
                    || acoustic_basins[insertion_source] != basin
                    || acoustic_basins[predecessors[insertion_source]] == basin
                    || acoustic_basins[insertion_destination] == basin
                    || !candidate_sets[track].contains(&insertion_destination)
                {
                    continue;
                }
                let candidate = (
                    track,
                    insertion_source,
                    previous,
                    following,
                    insertion_destination,
                );
                // The normal draw may only decline an otherwise eligible local pair. The
                // separately reconstructed ungated predecessor retains the fatigue ceiling.
                if apply_normal_auxiliary
                    && normal_fatigue_auxiliary(track_keys, candidate)
                        != NormalFatigueAuxiliary::RequestLocalAuditoryChunk
                {
                    continue;
                }
                if selected.is_none_or(|current| candidate < current) {
                    selected = Some(candidate);
                }
            }
        }
        let Some((track, insertion_source, previous, following, insertion_destination)) = selected
        else {
            return Ok(());
        };
        successors[previous] = following;
        successors[insertion_source] = track;
        successors[track] = insertion_destination;
    }
}

fn fatigue_chunk_relocations(
    successors: &[usize],
    cycle: &[usize],
    candidate_sets: &[HashSet<usize>],
    incoming: &[Vec<usize>],
    acoustic_basins: &[usize],
) -> Result<Vec<FatigueChunkRelocation>, String> {
    let predecessors = successor_predecessors(successors)?;
    let chunks = fatigue_chunks(cycle, acoustic_basins);
    let chunk_ends = chunks.iter().map(|chunk| chunk.end).collect::<HashSet<_>>();
    let mut relocations = Vec::new();
    for chunk in chunks {
        let previous = predecessors[chunk.start];
        let following = successors[chunk.end];
        if !candidate_sets[previous].contains(&following) {
            continue;
        }
        let mut members = HashSet::new();
        let mut node = chunk.start;
        loop {
            members.insert(node);
            if node == chunk.end {
                break;
            }
            node = successors[node];
        }
        for insertion_source in incoming[chunk.start].iter().copied() {
            let insertion_destination = successors[insertion_source];
            if !chunk_ends.contains(&insertion_source)
                || members.contains(&insertion_source)
                || members.contains(&insertion_destination)
                || insertion_source == previous
                || !candidate_sets[chunk.end].contains(&insertion_destination)
            {
                continue;
            }
            relocations.push(FatigueChunkRelocation {
                start: chunk.start,
                end: chunk.end,
                insertion_source,
                previous,
                following,
                insertion_destination,
            });
        }
    }
    relocations.sort_unstable();
    Ok(relocations)
}

fn evenly_sampled_relocations(length: usize, step: usize) -> Vec<usize> {
    if length <= FATIGUE_RECOVERY_CANDIDATES_PER_STEP {
        return (0..length).collect();
    }
    let offset = step.wrapping_mul(97) % length;
    (0..FATIGUE_RECOVERY_CANDIDATES_PER_STEP)
        .map(|index| (offset + index * length / FATIGUE_RECOVERY_CANDIDATES_PER_STEP) % length)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub(crate) fn form_neural_adaptation_cycle(
    atlas: &mut NeuralProgramAtlas,
    candidate_neighbors: &[usize],
    track_keys: &[String],
    acoustic_basins: &[usize],
    source_collections: &[usize],
) -> Result<bool, String> {
    if atlas.programs.is_empty()
        || atlas.track_count < 2
        || candidate_neighbors.len() != atlas.track_count * atlas.candidate_count
        || track_keys.len() != atlas.track_count
        || acoustic_basins.len() != atlas.track_count
        || source_collections.len() != atlas.track_count
    {
        return Err("neural-adaptation formation inputs must align".to_string());
    }
    let original = atlas.programs[0].clone();
    let original_cycle = single_program_cycle(&original)
        .ok_or_else(|| "neural-adaptation formation requires one complete cycle".to_string())?;
    let candidate_sets = candidate_neighbors
        .chunks_exact(atlas.candidate_count)
        .map(|row| row.iter().copied().collect::<HashSet<_>>())
        .collect::<Vec<_>>();
    let mut incoming = vec![Vec::new(); atlas.track_count];
    for (source, row) in candidate_neighbors
        .chunks_exact(atlas.candidate_count)
        .enumerate()
    {
        for destination in row.iter().copied() {
            if destination >= atlas.track_count {
                return Err("candidate relation contains an invalid track".to_string());
            }
            incoming[destination].push(source);
        }
    }
    let recovery_carriers = [acoustic_basins, source_collections];
    let pressure_lookup = fatigue_pressure_lookup(atlas.track_count);
    let original_scores = fatigue_scores(&original_cycle, &recovery_carriers, &pressure_lookup);
    let original_local_edges = same_carrier_edge_count(&original.successors, acoustic_basins);

    let mut fatigue_ceiling_successors = original.successors.clone();
    pair_isolated_fatigue_visits(
        &mut fatigue_ceiling_successors,
        &candidate_sets,
        &incoming,
        acoustic_basins,
        track_keys,
        false,
    )?;
    let fatigue_ceiling_cycle = single_program_cycle(&ProgramMorphism {
        successors: fatigue_ceiling_successors,
        ..original.clone()
    })
    .ok_or_else(|| "neural fatigue ceiling formation split the complete cycle".to_string())?;
    let fatigue_upper_bound = fatigue_chunks(&fatigue_ceiling_cycle, acoustic_basins)
        .iter()
        .map(|chunk| chunk.end_position - chunk.start_position + 1)
        .max()
        .unwrap_or(1);

    let mut successors = original.successors.clone();
    pair_isolated_fatigue_visits(
        &mut successors,
        &candidate_sets,
        &incoming,
        acoustic_basins,
        track_keys,
        true,
    )?;
    let mut cycle = single_program_cycle(&ProgramMorphism {
        successors: successors.clone(),
        ..original.clone()
    })
    .ok_or_else(|| "local fatigue formation split the complete cycle".to_string())?;
    let mut score = fatigue_target_key(
        &cycle,
        &recovery_carriers,
        &original_scores,
        &pressure_lookup,
    );
    for step in 0..FATIGUE_RECOVERY_REBALANCE_STEPS {
        let relocations = fatigue_chunk_relocations(
            &successors,
            &cycle,
            &candidate_sets,
            &incoming,
            acoustic_basins,
        )?;
        let mut selected = None::<(Vec<i128>, Vec<usize>, Vec<usize>)>;
        for relocation_index in evenly_sampled_relocations(relocations.len(), step) {
            let relocation = relocations[relocation_index];
            let mut proposed = successors.clone();
            proposed[relocation.previous] = relocation.following;
            proposed[relocation.insertion_source] = relocation.start;
            proposed[relocation.end] = relocation.insertion_destination;
            let proposal = ProgramMorphism {
                successors: proposed.clone(),
                ..original.clone()
            };
            let Some(proposed_cycle) = single_program_cycle(&proposal) else {
                continue;
            };
            let proposed_score = fatigue_target_key(
                &proposed_cycle,
                &recovery_carriers,
                &original_scores,
                &pressure_lookup,
            );
            if proposed_score <= score {
                continue;
            }
            if selected
                .as_ref()
                .is_none_or(|(selected_score, _, _)| proposed_score > *selected_score)
            {
                selected = Some((proposed_score, proposed, proposed_cycle));
            }
        }
        let Some((next_score, next_successors, next_cycle)) = selected else {
            break;
        };
        score = next_score;
        successors = next_successors;
        cycle = next_cycle;
    }

    let all_edges_admitted = successors
        .iter()
        .enumerate()
        .all(|(source, destination)| candidate_sets[source].contains(destination));
    let local_edges = same_carrier_edge_count(&successors, acoustic_basins);
    let maximum_local_run = fatigue_chunks(&cycle, acoustic_basins)
        .iter()
        .map(|chunk| chunk.end_position - chunk.start_position + 1)
        .max()
        .unwrap_or(1);
    let scores = fatigue_scores(&cycle, &recovery_carriers, &pressure_lookup);
    if !all_edges_admitted
        || local_edges <= original_local_edges
        || maximum_local_run > fatigue_upper_bound
        || !fatigue_recovery_target_met(&scores, &original_scores)
    {
        return Ok(false);
    }
    let boundary_sources = successors
        .iter()
        .enumerate()
        .filter(|(source, destination)| acoustic_basins[*source] != acoustic_basins[**destination])
        .map(|(source, _)| source)
        .collect::<Vec<_>>();
    atlas.programs[0] = ProgramMorphism {
        lineage: successor_lineage(track_keys, &successors, &boundary_sources),
        presentation_ordinals: original.presentation_ordinals,
        successors,
        boundary_sources,
    };
    Ok(true)
}

fn maximum_common_successor_run(left: &ProgramMorphism, right: &ProgramMorphism) -> usize {
    let mut visited = HashSet::new();
    let mut maximum = 0;
    for root in 0..left.successors.len() {
        if visited.contains(&root) {
            continue;
        }
        let mut cycle = Vec::new();
        let mut node = root;
        while visited.insert(node) {
            cycle.push(left.successors[node] == right.successors[node]);
            node = left.successors[node];
        }
        if cycle.iter().all(|shared| *shared) {
            maximum = maximum.max(cycle.len());
            continue;
        }
        let mut run = 0;
        for shared in cycle.iter().chain(&cycle) {
            run = if *shared { run + 1 } else { 0 };
            maximum = maximum.max(run.min(cycle.len()));
        }
    }
    maximum
}

fn sigma_swap(node: usize, left: usize, right: usize) -> usize {
    if node == left {
        right
    } else if node == right {
        left
    } else {
        node
    }
}

fn effective_successor(
    atlas: &NeuralProgramAtlas,
    path: &ProgramPathState,
    program_ordinal: usize,
    source: usize,
) -> usize {
    if path
        .overlay
        .as_ref()
        .is_some_and(|overlay| overlay.program_ordinal == program_ordinal)
    {
        if let Some(destination) = path
            .overlay
            .as_ref()
            .expect("overlay presence checked")
            .successor_overrides
            .get(&source)
        {
            return *destination;
        }
    }
    atlas.programs[program_ordinal].successors[source]
}

fn effective_predecessor(
    native_predecessors: &[usize],
    path: &ProgramPathState,
    program_ordinal: usize,
    destination: usize,
) -> usize {
    if path
        .overlay
        .as_ref()
        .is_some_and(|overlay| overlay.program_ordinal == program_ordinal)
    {
        if let Some(source) = path
            .overlay
            .as_ref()
            .expect("overlay presence checked")
            .predecessor_overrides
            .get(&destination)
        {
            return *source;
        }
    }
    native_predecessors[destination]
}

fn effective_boundary_source(
    atlas: &NeuralProgramAtlas,
    path: &ProgramPathState,
    program_ordinal: usize,
    source: usize,
) -> bool {
    path.overlay
        .as_ref()
        .filter(|overlay| overlay.program_ordinal == program_ordinal)
        .map(|overlay| overlay.boundary_sources.contains(&source))
        .unwrap_or_else(|| {
            atlas.programs[program_ordinal]
                .boundary_sources
                .contains(&source)
        })
}

fn effective_program_cycle(
    atlas: &NeuralProgramAtlas,
    path: &ProgramPathState,
    program_ordinal: usize,
) -> Option<Vec<usize>> {
    let track_count = atlas.track_count;
    if track_count == 0 || program_ordinal >= atlas.programs.len() {
        return None;
    }
    let mut visited = vec![false; track_count];
    let mut cycle = Vec::with_capacity(track_count);
    let mut node = 0;
    while !visited[node] {
        visited[node] = true;
        cycle.push(node);
        node = effective_successor(atlas, path, program_ordinal, node);
        if node >= track_count {
            return None;
        }
    }
    (node == 0 && cycle.len() == track_count).then_some(cycle)
}

/// Source recovery score with a sparse occupied-position presentation. A
/// zero gap joins adjacent occurrences into one carrier chunk; the all-carrier
/// case retains the single zero-gap event used by the native formation law.
fn fatigue_score_from_positions(
    cycle_length: usize,
    positions: &[usize],
    pressure_lookup: &[[u128; 4]],
) -> FatigueCarrierScore {
    if positions.is_empty() || cycle_length == 0 {
        return FatigueCarrierScore {
            short_returns: 0,
            event_count: 0,
            minimum_recovery: 0,
            gap_sum: 0,
            recovery_pressures: [0; FATIGUE_RECOVERY_DECAY_NUMERATORS.len()],
        };
    }
    if positions.len() == cycle_length {
        return FatigueCarrierScore {
            short_returns: 1,
            event_count: 1,
            minimum_recovery: 0,
            gap_sum: 0,
            recovery_pressures: pressure_lookup[0],
        };
    }

    let occurrence_count = positions
        .iter()
        .zip(positions.iter().cycle().skip(1))
        .filter_map(|(position, next)| {
            let gap = (cycle_length + *next - *position - 1) % cycle_length;
            (gap > 0).then_some(gap)
        })
        .collect::<Vec<_>>();
    let event_count = occurrence_count.len();
    if event_count == 0 {
        return FatigueCarrierScore {
            short_returns: 0,
            event_count: 0,
            minimum_recovery: 0,
            gap_sum: 0,
            recovery_pressures: [0; FATIGUE_RECOVERY_DECAY_NUMERATORS.len()],
        };
    }
    let mut recovery_pressures = [0_u128; FATIGUE_RECOVERY_DECAY_NUMERATORS.len()];
    for gap in occurrence_count.iter().copied() {
        for (target, pressure) in recovery_pressures
            .iter_mut()
            .zip(pressure_lookup[gap.min(pressure_lookup.len() - 1)])
        {
            *target += pressure;
        }
    }
    let minimum_recovery = occurrence_count
        .iter()
        .copied()
        .min()
        .unwrap_or_default()
        .saturating_mul(event_count);
    FatigueCarrierScore {
        short_returns: occurrence_count.iter().filter(|gap| **gap <= 2).count(),
        event_count,
        minimum_recovery,
        gap_sum: occurrence_count.iter().sum(),
        recovery_pressures,
    }
}

fn source_fatigue_aggregate(
    scores: impl IntoIterator<Item = FatigueCarrierScore>,
) -> SourceFatigueAggregate {
    let mut minimum_recovery = usize::MAX;
    let mut short_returns = 0;
    let mut event_count = 0;
    let mut gap_sum = 0;
    let mut recovery_pressures = [0_u128; FATIGUE_RECOVERY_DECAY_NUMERATORS.len()];
    for score in scores {
        minimum_recovery = minimum_recovery.min(score.minimum_recovery);
        short_returns += score.short_returns;
        event_count += score.event_count;
        gap_sum += score.gap_sum;
        for (target, pressure) in recovery_pressures.iter_mut().zip(score.recovery_pressures) {
            *target += pressure;
        }
    }
    SourceFatigueAggregate {
        minimum_recovery: if minimum_recovery == usize::MAX {
            0
        } else {
            minimum_recovery
        },
        short_returns,
        event_count,
        gap_sum,
        recovery_pressures,
    }
}

fn add_minimum_recovery_count(counts: &mut BTreeMap<usize, usize>, minimum_recovery: usize) {
    *counts.entry(minimum_recovery).or_default() += 1;
}

fn remove_minimum_recovery_count(counts: &mut BTreeMap<usize, usize>, minimum_recovery: usize) {
    let Some(count) = counts.get_mut(&minimum_recovery) else {
        return;
    };
    if *count == 1 {
        counts.remove(&minimum_recovery);
    } else {
        *count -= 1;
    }
}

fn replace_aggregate_contribution(
    aggregate: &mut SourceFatigueAggregate,
    old: &FatigueCarrierScore,
    proposed: &FatigueCarrierScore,
) {
    aggregate.short_returns = aggregate.short_returns - old.short_returns + proposed.short_returns;
    aggregate.event_count = aggregate.event_count - old.event_count + proposed.event_count;
    aggregate.gap_sum = aggregate.gap_sum - old.gap_sum + proposed.gap_sum;
    for (current, (old_pressure, proposed_pressure)) in aggregate.recovery_pressures.iter_mut().zip(
        old.recovery_pressures
            .into_iter()
            .zip(proposed.recovery_pressures),
    ) {
        *current = *current - old_pressure + proposed_pressure;
    }
}

fn trial_minimum_recovery(
    cache: &SourceFatigueCache,
    proposed_scores: &HashMap<usize, FatigueCarrierScore>,
) -> usize {
    let current_minimum = cache.aggregate.minimum_recovery;
    let total_at_current_minimum = cache
        .minimum_recovery_counts
        .get(&current_minimum)
        .copied()
        .unwrap_or_default();
    let removed_at_current_minimum = proposed_scores
        .keys()
        .filter(|carrier| {
            cache
                .scores_by_carrier
                .get(carrier)
                .is_some_and(|score| score.minimum_recovery == current_minimum)
        })
        .count();
    let untouched_minimum = if removed_at_current_minimum < total_at_current_minimum {
        current_minimum
    } else {
        cache
            .minimum_recovery_counts
            .range((Excluded(current_minimum), Unbounded))
            .next()
            .map(|(minimum, _)| *minimum)
            .unwrap_or(usize::MAX)
    };
    let proposed_minimum = proposed_scores
        .values()
        .map(|score| score.minimum_recovery)
        .min()
        .unwrap_or(usize::MAX);
    match untouched_minimum.min(proposed_minimum) {
        usize::MAX => 0,
        minimum => minimum,
    }
}

fn source_fatigue_aggregate_non_regressed(
    proposed: &SourceFatigueAggregate,
    baseline: &SourceFatigueAggregate,
) -> bool {
    proposed.minimum_recovery >= baseline.minimum_recovery
        && proposed.short_returns as u128 * baseline.event_count as u128
            <= baseline.short_returns as u128 * proposed.event_count as u128
        && proposed
            .recovery_pressures
            .iter()
            .zip(baseline.recovery_pressures)
            .all(|(pressure, baseline_pressure)| {
                *pressure * baseline.event_count as u128
                    <= baseline_pressure * proposed.event_count as u128
            })
}

/// Commit the conjugated cycle to the path-owned fatigue cache. The cycle
/// representation only changes at the two swapped positions; recomputing the
/// aggregate scans carriers (not the full track cycle) and therefore keeps
/// the initial baseline independent from accepted proposals.
fn commit_source_fatigue_cache(
    atlas: &NeuralProgramAtlas,
    path: &mut ProgramPathState,
    program_ordinal: usize,
    left: usize,
    right: usize,
) {
    let Some(cache) = path.source_fatigue_cache.as_mut() else {
        return;
    };
    if cache.program_ordinal != program_ordinal {
        return;
    }
    let Some(left_position) = cache.positions_by_track.get(left).copied() else {
        return;
    };
    let Some(right_position) = cache.positions_by_track.get(right).copied() else {
        return;
    };
    if left_position == usize::MAX
        || right_position == usize::MAX
        || left_position >= cache.cycle.len()
        || right_position >= cache.cycle.len()
    {
        return;
    }

    let left_carrier = cache.carriers_by_track[left];
    let right_carrier = cache.carriers_by_track[right];
    let Some(old_left_score) = cache.scores_by_carrier.get(&left_carrier).cloned() else {
        return;
    };
    let Some(old_right_score) = cache.scores_by_carrier.get(&right_carrier).cloned() else {
        return;
    };
    cache.cycle[left_position] = right;
    cache.cycle[right_position] = left;
    cache.positions_by_track[left] = right_position;
    cache.positions_by_track[right] = left_position;

    if left_carrier == right_carrier {
        return;
    }
    if let Some(positions) = cache.positions_by_carrier.get_mut(&left_carrier) {
        positions.retain(|position| *position != left_position);
        positions.push(right_position);
        positions.sort_unstable();
    }
    if let Some(positions) = cache.positions_by_carrier.get_mut(&right_carrier) {
        positions.retain(|position| *position != right_position);
        positions.push(left_position);
        positions.sort_unstable();
    }
    let mut new_scores = HashMap::new();
    for carrier in [left_carrier, right_carrier] {
        let score = cache
            .positions_by_carrier
            .get(&carrier)
            .map(|positions| {
                fatigue_score_from_positions(atlas.track_count, positions, &cache.pressure_lookup)
            })
            .unwrap_or_else(|| fatigue_score_from_positions(0, &[], &cache.pressure_lookup));
        new_scores.insert(carrier, score);
    }
    remove_minimum_recovery_count(
        &mut cache.minimum_recovery_counts,
        old_left_score.minimum_recovery,
    );
    remove_minimum_recovery_count(
        &mut cache.minimum_recovery_counts,
        old_right_score.minimum_recovery,
    );
    let new_left_score = new_scores
        .get(&left_carrier)
        .cloned()
        .expect("left source score should be rebuilt");
    let new_right_score = new_scores
        .get(&right_carrier)
        .cloned()
        .expect("right source score should be rebuilt");
    add_minimum_recovery_count(
        &mut cache.minimum_recovery_counts,
        new_left_score.minimum_recovery,
    );
    add_minimum_recovery_count(
        &mut cache.minimum_recovery_counts,
        new_right_score.minimum_recovery,
    );
    cache
        .scores_by_carrier
        .insert(left_carrier, new_left_score.clone());
    cache
        .scores_by_carrier
        .insert(right_carrier, new_right_score.clone());
    replace_aggregate_contribution(&mut cache.aggregate, &old_left_score, &new_left_score);
    replace_aggregate_contribution(&mut cache.aggregate, &old_right_score, &new_right_score);
    cache.aggregate.minimum_recovery = cache
        .minimum_recovery_counts
        .keys()
        .next()
        .copied()
        .unwrap_or(0);
}

fn build_source_fatigue_cache(
    atlas: &NeuralProgramAtlas,
    path: &ProgramPathState,
    program_ordinal: usize,
    source_collections: &[usize],
) -> Result<SourceFatigueCache, String> {
    if source_collections.len() != atlas.track_count {
        return Err("source-fatigue carrier coordinates must align with the cycle".to_string());
    }
    let cycle = effective_program_cycle(atlas, path, program_ordinal)
        .ok_or_else(|| "source-fatigue guard requires one complete active cycle".to_string())?;
    let pressure_lookup = fatigue_pressure_lookup(atlas.track_count);
    let mut positions_by_carrier = HashMap::<usize, Vec<usize>>::new();
    for (position, track) in cycle.iter().copied().enumerate() {
        positions_by_carrier
            .entry(source_collections[track])
            .or_default()
            .push(position);
    }
    let scores_by_carrier = positions_by_carrier
        .iter()
        .map(|(carrier, positions)| {
            (
                *carrier,
                fatigue_score_from_positions(atlas.track_count, positions, &pressure_lookup),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut minimum_recovery_counts = BTreeMap::new();
    for score in scores_by_carrier.values() {
        add_minimum_recovery_count(&mut minimum_recovery_counts, score.minimum_recovery);
    }
    let aggregate = source_fatigue_aggregate(scores_by_carrier.values().cloned());
    let mut positions_by_track = vec![usize::MAX; atlas.track_count];
    for (position, track) in cycle.iter().copied().enumerate() {
        positions_by_track[track] = position;
    }
    Ok(SourceFatigueCache {
        program_ordinal,
        cycle,
        positions_by_track,
        carriers_by_track: source_collections.to_vec(),
        positions_by_carrier,
        scores_by_carrier,
        minimum_recovery_counts,
        initial_aggregate: aggregate.clone(),
        aggregate,
        pressure_lookup: Arc::new(pressure_lookup),
    })
}

/// Check one active-program transposition against the initial current cycle's
/// source recovery score. The aggregate baseline is cached on the path before
/// any candidate is tried; only the two carriers touched by the transposition
/// are rebuilt for each trial.
pub(crate) fn source_fatigue_allows_transposition(
    atlas: &NeuralProgramAtlas,
    state: &mut ProgramOwnedTraversalState,
    path_ordinal: usize,
    program_ordinal: usize,
    left: usize,
    right: usize,
    source_collections: &[usize],
) -> Result<bool, String> {
    if left == right {
        return Ok(true);
    }
    if source_collections.len() != atlas.track_count
        || path_ordinal >= state.paths.len()
        || program_ordinal >= atlas.programs.len()
        || left >= atlas.track_count
        || right >= atlas.track_count
    {
        return Err("source-fatigue transposition inputs must align".to_string());
    }
    let path = &mut state.paths[path_ordinal];
    if path.active_program != program_ordinal {
        return Err("source-fatigue transposition program is not active on the path".to_string());
    }
    if path.source_fatigue_cache.as_ref().is_none_or(|cache| {
        cache.program_ordinal != program_ordinal
            || cache.carriers_by_track.as_slice() != source_collections
    }) {
        path.source_fatigue_cache = Some(build_source_fatigue_cache(
            atlas,
            path,
            program_ordinal,
            source_collections,
        )?);
    }
    let cache = path
        .source_fatigue_cache
        .as_ref()
        .expect("source-fatigue cache initialized");
    let left_position = cache
        .positions_by_track
        .get(left)
        .copied()
        .filter(|position| *position != usize::MAX)
        .ok_or_else(|| "source-fatigue transposition left class is not in the cycle".to_string())?;
    let right_position = cache
        .positions_by_track
        .get(right)
        .copied()
        .filter(|position| *position != usize::MAX)
        .ok_or_else(|| {
            "source-fatigue transposition right class is not in the cycle".to_string()
        })?;
    let left_carrier = source_collections[left];
    let right_carrier = source_collections[right];
    if left_carrier == right_carrier {
        return Ok(true);
    }

    let mut proposed_scores = HashMap::<usize, FatigueCarrierScore>::new();
    for carrier in [left_carrier, right_carrier] {
        if proposed_scores.contains_key(&carrier) {
            continue;
        }
        let mut positions = cache
            .positions_by_carrier
            .get(&carrier)
            .cloned()
            .unwrap_or_default();
        if carrier == left_carrier {
            positions.retain(|position| *position != left_position);
            positions.push(right_position);
        }
        if carrier == right_carrier {
            positions.retain(|position| *position != right_position);
            positions.push(left_position);
        }
        positions.sort_unstable();
        proposed_scores.insert(
            carrier,
            fatigue_score_from_positions(atlas.track_count, &positions, &cache.pressure_lookup),
        );
    }
    let mut trial_aggregate = cache.aggregate.clone();
    for (carrier, proposed) in &proposed_scores {
        let baseline = cache
            .scores_by_carrier
            .get(carrier)
            .expect("source-fatigue trial carrier should have a cached score");
        replace_aggregate_contribution(&mut trial_aggregate, baseline, proposed);
    }
    trial_aggregate.minimum_recovery = trial_minimum_recovery(cache, &proposed_scores);
    Ok(source_fatigue_aggregate_non_regressed(
        &trial_aggregate,
        &cache.initial_aggregate,
    ))
}

/// Apply a prepared swap to one path's active cyclic program and to the
/// first output slot. This is the sole owner of the mutable program overlay;
/// callers never replace only the returned concrete track.
pub(crate) fn apply_program_transposition(
    atlas: &NeuralProgramAtlas,
    orbit_index: &ProgramOrbitIndex,
    list: &mut ProgramList,
    path_ordinal: usize,
    left: usize,
    right: usize,
) -> Result<(), String> {
    if left == right {
        return Ok(());
    }
    if path_ordinal >= list.next_state.paths.len()
        || path_ordinal >= list.path_count
        || left >= atlas.track_count
        || right >= atlas.track_count
    {
        return Err("program transposition inputs are outside the active path".to_string());
    }
    let index = path_ordinal * list.tracks_per_list;
    if list.order.get(index).copied() != Some(left)
        || list.next_state.paths[path_ordinal].current_track != left
    {
        return Err("program transposition must replace the executed destination".to_string());
    }
    let program_ordinal = list.program_ordinals[index];
    let source_ordinal = list.source_ordinals[index];
    let native_predecessors = orbit_index
        .predecessors
        .get(program_ordinal)
        .ok_or_else(|| "program transposition has no native predecessor index".to_string())?;
    let path = &mut list.next_state.paths[path_ordinal];
    if path.active_program != program_ordinal {
        return Err("program transposition active program is not the executed program".to_string());
    }
    let previous_overlay = path.overlay.clone();
    let mut overrides = previous_overlay
        .as_ref()
        .filter(|overlay| overlay.program_ordinal == program_ordinal)
        .map(|overlay| overlay.successor_overrides.clone())
        .unwrap_or_default()
        .into_iter()
        .collect::<HashMap<_, _>>();
    let mut predecessor_overrides = previous_overlay
        .as_ref()
        .filter(|overlay| overlay.program_ordinal == program_ordinal)
        .map(|overlay| overlay.predecessor_overrides.clone())
        .unwrap_or_default()
        .into_iter()
        .collect::<HashMap<_, _>>();
    let mut affected_sources = vec![left, right];
    for destination in [left, right] {
        affected_sources.push(effective_predecessor(
            native_predecessors,
            path,
            program_ordinal,
            destination,
        ));
    }
    affected_sources.sort_unstable();
    affected_sources.dedup();
    for source in affected_sources {
        let transformed_source = sigma_swap(source, left, right);
        let old_destination = effective_successor(atlas, path, program_ordinal, transformed_source);
        let destination = sigma_swap(old_destination, left, right);
        let native_destination = atlas.programs[program_ordinal].successors[source];
        if destination == native_destination {
            overrides.remove(&source);
        } else {
            overrides.insert(source, destination);
        }
    }
    let mut affected_destinations = vec![left, right];
    affected_destinations.extend([
        effective_successor(atlas, path, program_ordinal, left),
        effective_successor(atlas, path, program_ordinal, right),
    ]);
    affected_destinations.sort_unstable();
    affected_destinations.dedup();
    for destination in affected_destinations {
        let old_destination = sigma_swap(destination, left, right);
        let old_source =
            effective_predecessor(native_predecessors, path, program_ordinal, old_destination);
        let source = sigma_swap(old_source, left, right);
        let native_source = native_predecessors[destination];
        if source == native_source {
            predecessor_overrides.remove(&destination);
        } else {
            predecessor_overrides.insert(destination, source);
        }
    }
    let mut boundary_sources = previous_overlay
        .as_ref()
        .filter(|overlay| overlay.program_ordinal == program_ordinal)
        .map(|overlay| overlay.boundary_sources.clone())
        .unwrap_or_else(|| atlas.programs[program_ordinal].boundary_sources.clone())
        .into_iter()
        .map(|source| sigma_swap(source, left, right))
        .collect::<Vec<_>>();
    boundary_sources.sort_unstable();
    boundary_sources.dedup();
    path.overlay = Some(ProgramPathOverlay {
        program_ordinal,
        successor_overrides: overrides,
        predecessor_overrides,
        boundary_sources,
    });
    commit_source_fatigue_cache(atlas, path, program_ordinal, left, right);
    clear_bit(&mut path.realized_history, left);
    set_bit(&mut path.realized_history, right);
    path.current_track = right;
    list.order[index] = right;
    list.style_sector_departures[index] = list.departures[index]
        || effective_boundary_source(atlas, path, program_ordinal, source_ordinal);
    list.opportunity_swaps[index] = true;
    Ok(())
}

pub(crate) fn initialize_traversal_state(
    atlas: &NeuralProgramAtlas,
    anchors: &[usize],
) -> Result<ProgramOwnedTraversalState, String> {
    if atlas.programs.is_empty() {
        return Err("program atlas must contain an executable program".to_string());
    }
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
                    coverage_epoch: 0,
                    overlay: None,
                    source_fatigue_cache: None,
                }
            })
            .collect(),
        playback_cycle: 0,
    })
}

pub(crate) fn transport_traversal_state(
    previous: Option<(&NeuralProgramAtlas, &ProgramOwnedTraversalState)>,
    atlas: &NeuralProgramAtlas,
    anchors: &[usize],
    realized_histories: &[Vec<usize>],
) -> Result<ProgramOwnedTraversalState, String> {
    if anchors.len() != realized_histories.len() {
        return Err("transported anchors and realized histories must align".to_string());
    }
    if let Some((_, state)) = previous
        && state.paths.len() != anchors.len()
    {
        return Err("transported path count must remain stable".to_string());
    }
    let mut transported = initialize_traversal_state(atlas, anchors)?;
    for path_ordinal in 0..anchors.len() {
        let path = &mut transported.paths[path_ordinal];
        for realized in &realized_histories[path_ordinal] {
            if *realized >= atlas.track_count {
                return Err("transported history contains an invalid track".to_string());
            }
            set_bit(&mut path.realized_history, *realized);
        }
        let Some((previous_atlas, previous_state)) = previous else {
            continue;
        };
        let previous_path = &previous_state.paths[path_ordinal];
        let presentation = previous_atlas.programs[previous_path.active_program]
            .presentation_ordinals
            .iter()
            .copied()
            .min()
            .unwrap_or(0);
        if let Some(program) = atlas
            .programs
            .iter()
            .position(|program| program.presentation_ordinals.contains(&presentation))
        {
            path.active_program = program;
            path.tie_cursor = (program + 1) % atlas.programs.len();
            path.residence_steps = previous_path.residence_steps;
            if previous_atlas == atlas {
                path.overlay = previous_path
                    .overlay
                    .clone()
                    .filter(|overlay| overlay.program_ordinal == program);
                path.source_fatigue_cache = previous_path
                    .source_fatigue_cache
                    .clone()
                    .filter(|cache| cache.program_ordinal == program);
            }
        }
        path.coverage_epoch = previous_path.coverage_epoch;
    }
    transported.playback_cycle = previous.map(|(_, state)| state.playback_cycle).unwrap_or(0);
    Ok(transported)
}

// @forma implements material ResearchCandidateTransfer.propose_fresh_departure_from_learnable_future as select_fresh_departure
fn select_fresh_departure(
    atlas: &NeuralProgramAtlas,
    orbit_index: &ProgramOrbitIndex,
    state: &ProgramPathState,
) -> Option<(usize, usize, usize)> {
    let mut minimum_overlap = usize::MAX;
    let mut candidates = HashMap::<usize, usize>::new();
    for program_ordinal in 0..atlas.programs.len() {
        let destination = effective_successor(atlas, state, program_ordinal, state.current_track);
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
    let mut source_ordinals = vec![0_usize; order.len()];
    let mut program_ordinals = vec![0_usize; order.len()];
    let mut departures = vec![false; order.len()];
    let mut style_sector_departures = vec![false; order.len()];
    let mut coverage_epoch_transitions = vec![false; order.len()];
    let opportunity_swaps = vec![false; order.len()];
    let mut departure_future_overlap = vec![None; order.len()];
    for step in 0..tracks_per_list {
        for path_ordinal in 0..path_count {
            let path = &mut next_state.paths[path_ordinal];
            if path
                .overlay
                .as_ref()
                .is_some_and(|overlay| overlay.program_ordinal != path.active_program)
            {
                path.overlay = None;
                path.source_fatigue_cache = None;
            }
            let mut program = path.active_program;
            let source = path.current_track;
            let mut crosses_style_sector = effective_boundary_source(atlas, path, program, source);
            let mut destination = effective_successor(atlas, path, program, source);
            let index = path_ordinal * tracks_per_list + step;
            source_ordinals[index] = source;
            if contains_bit(&path.realized_history, destination) {
                if let Some((fresh_program, fresh_destination, overlap)) =
                    select_fresh_departure(atlas, orbit_index, path)
                {
                    program = fresh_program;
                    destination = fresh_destination;
                    if program != path.active_program {
                        path.overlay = None;
                        path.source_fatigue_cache = None;
                    }
                    crosses_style_sector = true;
                    departures[index] = true;
                    departure_future_overlap[index] = Some(overlap);
                } else {
                    if bit_count(&path.realized_history) != atlas.track_count
                        || atlas.track_count < 2
                    {
                        return Err(TraversalExhausted {
                            path_ordinal,
                            current_track: path.current_track,
                        });
                    }
                    let (coverage_program, encoded_power) =
                        orbit_index.coverage_successors[program];
                    path.overlay = None;
                    path.source_fatigue_cache = None;
                    program = coverage_program;
                    let entry_power = if encoded_power == 0 {
                        1 + path.coverage_epoch % (atlas.track_count - 1)
                    } else {
                        encoded_power
                    };
                    destination = path.current_track;
                    for _ in 0..entry_power {
                        destination = atlas.programs[program].successors[destination];
                    }
                    path.realized_history.fill(0);
                    path.coverage_epoch += 1;
                    coverage_epoch_transitions[index] = true;
                }
                path.active_program = program;
                path.tie_cursor = (program + 1) % atlas.programs.len();
                path.residence_steps = 1;
            } else {
                path.residence_steps += 1;
            }
            path.current_track = destination;
            set_bit(&mut path.realized_history, destination);
            order[index] = destination;
            program_ordinals[index] = program;
            style_sector_departures[index] = crosses_style_sector;
        }
    }
    next_state.playback_cycle += 1;
    Ok(ProgramList {
        path_count,
        tracks_per_list,
        order,
        source_ordinals,
        program_ordinals,
        departures,
        style_sector_departures,
        coverage_epoch_transitions,
        opportunity_swaps,
        departure_future_overlap,
        next_state,
    })
}

#[cfg(test)]
#[derive(Debug)]
struct PathFairClosureAudit {
    value: Value,
    paired_cosine_difference: f64,
    paired_neighborhood_overlap_difference: f64,
    semantic_boundary_local_contrast_violations: usize,
    resident_span_minimum: usize,
    all_boundaries_are_candidate_edges: bool,
}

#[cfg(test)]
fn path_fair_closure_audit(
    original: &NeuralProgramAtlas,
    closed: &NeuralProgramAtlas,
    candidate_neighbors: &[usize],
    catalog: &SymbolicCatalog<'_>,
    global_track_ordinals: &[usize],
) -> Result<PathFairClosureAudit, String> {
    if original.track_count != closed.track_count
        || original.track_count != global_track_ordinals.len()
        || candidate_neighbors.len() != original.track_count * original.candidate_count
    {
        return Err("path-fair closure audit inputs must align".to_string());
    }
    let overlaps = candidate_neighborhood_overlaps(
        original.track_count,
        original.candidate_count,
        candidate_neighbors,
    )?;
    let closed_by_presentation = closed
        .programs
        .iter()
        .flat_map(|program| {
            program
                .presentation_ordinals
                .iter()
                .map(move |presentation| (*presentation, program))
        })
        .collect::<HashMap<_, _>>();
    let candidate_sets = (0..original.track_count)
        .map(|source| {
            let start = source * original.candidate_count;
            candidate_neighbors[start..start + original.candidate_count]
                .iter()
                .copied()
                .collect::<HashSet<_>>()
        })
        .collect::<Vec<_>>();
    let local_overlap = |source: usize, destination: usize| -> Result<usize, String> {
        let start = source * original.candidate_count;
        let position = candidate_neighbors[start..start + original.candidate_count]
            .iter()
            .position(|candidate| *candidate == destination)
            .ok_or_else(|| {
                format!("program edge {source}->{destination} is outside the candidate relation")
            })?;
        Ok(overlaps[start + position])
    };

    let mut admitted_program_count = 0_usize;
    let mut changed_program_count = 0_usize;
    let mut semantic_boundary_program_count = 0_usize;
    let mut graph_splice_edge_count = 0_usize;
    let mut semantic_boundary_edge_count = 0_usize;
    let mut resident_edge_count = 0_usize;
    let mut semantic_boundary_local_contrast_violations = 0_usize;
    let mut all_boundaries_are_candidate_edges = true;
    let mut paired_cosine_differences = Vec::new();
    let mut paired_neighborhood_overlap_differences = Vec::new();
    let mut resident_spans = Vec::new();
    let mut resident_cosines = Vec::new();
    let mut boundary_cosines = Vec::new();
    let mut resident_neighborhood_overlaps = Vec::new();
    let mut boundary_neighborhood_overlaps = Vec::new();
    let candidate_ranks = candidate_neighbors
        .chunks_exact(original.candidate_count)
        .map(|row| {
            row.iter()
                .copied()
                .enumerate()
                .map(|(rank, destination)| (destination, rank))
                .collect::<HashMap<_, _>>()
        })
        .collect::<Vec<_>>();
    let candidate_separations = program_cycle_separations(original, candidate_neighbors)?;
    let mut resident_symbolic_separations = Vec::new();
    let mut boundary_symbolic_separations = Vec::new();
    let mut resident_candidate_ranks = Vec::new();
    let mut boundary_candidate_ranks = Vec::new();
    let mut paired_symbolic_separation_differences = Vec::new();
    let mut programs_with_lower_bridge_neighborhood_overlap = 0_usize;

    for source_program in &original.programs {
        let Some(program) = source_program
            .presentation_ordinals
            .iter()
            .find_map(|presentation| closed_by_presentation.get(presentation).copied())
        else {
            continue;
        };
        admitted_program_count += 1;
        let changed = source_program
            .successors
            .iter()
            .zip(&program.successors)
            .filter(|(before, after)| before != after)
            .count();
        graph_splice_edge_count += changed;
        changed_program_count += usize::from(changed > 0);
        semantic_boundary_program_count += usize::from(!program.boundary_sources.is_empty());
        let boundary_sources = program
            .boundary_sources
            .iter()
            .copied()
            .collect::<HashSet<_>>();
        let mut program_resident_cosines = Vec::new();
        let mut program_boundary_cosines = Vec::new();
        let mut program_resident_overlaps = Vec::new();
        let mut program_boundary_overlaps = Vec::new();
        let mut program_resident_separations = Vec::new();
        let mut program_boundary_separations = Vec::new();
        for (source, destination) in program.successors.iter().copied().enumerate() {
            let source_global = global_track_ordinals[source];
            let destination_global = global_track_ordinals[destination];
            let cosine = embedding_cosine(catalog, source_global, destination_global);
            let start = source * original.candidate_count;
            let candidate_position = candidate_neighbors[start..start + original.candidate_count]
                .iter()
                .position(|candidate| *candidate == destination)
                .ok_or_else(|| {
                    format!(
                        "program edge {source}->{destination} is outside the candidate relation"
                    )
                })?;
            let neighborhood_overlap = local_overlap(source, destination)? as f64
                / candidate_sets[source].len().max(1) as f64;
            let symbolic_separation = candidate_separations[start + candidate_position] as f64;
            let candidate_rank = candidate_ranks[source][&destination] as f64;
            if boundary_sources.contains(&source) {
                semantic_boundary_edge_count += 1;
                all_boundaries_are_candidate_edges &= candidate_sets[source].contains(&destination);
                semantic_boundary_local_contrast_violations += usize::from(
                    local_overlap(source, destination)?
                        >= local_overlap(source, source_program.successors[source])?,
                );
                boundary_cosines.push(cosine);
                boundary_neighborhood_overlaps.push(neighborhood_overlap);
                boundary_symbolic_separations.push(symbolic_separation);
                boundary_candidate_ranks.push(candidate_rank);
                program_boundary_cosines.push(cosine);
                program_boundary_overlaps.push(neighborhood_overlap);
                program_boundary_separations.push(symbolic_separation);
            } else {
                resident_edge_count += 1;
                resident_cosines.push(cosine);
                resident_neighborhood_overlaps.push(neighborhood_overlap);
                resident_symbolic_separations.push(symbolic_separation);
                resident_candidate_ranks.push(candidate_rank);
                program_resident_cosines.push(cosine);
                program_resident_overlaps.push(neighborhood_overlap);
                program_resident_separations.push(symbolic_separation);
            }
        }
        if !program.boundary_sources.is_empty() {
            paired_cosine_differences
                .push(mean(&program_boundary_cosines) - mean(&program_resident_cosines));
            paired_neighborhood_overlap_differences
                .push(mean(&program_boundary_overlaps) - mean(&program_resident_overlaps));
            paired_symbolic_separation_differences
                .push(mean(&program_boundary_separations) - mean(&program_resident_separations));
            programs_with_lower_bridge_neighborhood_overlap += usize::from(
                (program_boundary_overlaps.iter().sum::<f64>()
                    / program_boundary_overlaps.len().max(1) as f64)
                    < (program_resident_overlaps.iter().sum::<f64>()
                        / program_resident_overlaps.len().max(1) as f64),
            );

            let start = program.boundary_sources[0];
            let mut node = program.successors[start];
            let mut resident_span = 0_usize;
            while node != start {
                if boundary_sources.contains(&node) {
                    resident_spans.push(resident_span);
                    resident_span = 0;
                } else {
                    resident_span += 1;
                }
                node = program.successors[node];
            }
            resident_spans.push(resident_span);
        } else {
            resident_spans.push(program.successors.len());
        }
    }

    let paired_cosine_difference = mean(&paired_cosine_differences);
    let paired_neighborhood_overlap_difference = mean(&paired_neighborhood_overlap_differences);
    let resident_span_minimum = resident_spans.iter().copied().min().unwrap_or(0);
    let resident_span_values = resident_spans
        .iter()
        .map(|span| *span as f64)
        .collect::<Vec<_>>();
    Ok(PathFairClosureAudit {
        value: json!({
            "admitted_original_program_count": admitted_program_count,
            "changed_original_program_count": changed_program_count,
            "semantic_boundary_program_count": semantic_boundary_program_count,
            "semantic_boundary_local_contrast_violations":
                semantic_boundary_local_contrast_violations,
            "graph_splice_edge_count": graph_splice_edge_count,
            "resident_edge_count": resident_edge_count,
            "fatigue_bridge_edge_count": semantic_boundary_edge_count,
            "resident_edge_cosine_mean": mean(&resident_cosines),
            "fatigue_bridge_edge_cosine_mean": optional_mean(&boundary_cosines),
            "program_paired_bridge_minus_resident_cosine_mean":
                optional_mean(&paired_cosine_differences),
            "resident_edge_symbolic_separation_mean": mean(&resident_symbolic_separations),
            "fatigue_bridge_symbolic_separation_mean":
                optional_mean(&boundary_symbolic_separations),
            "resident_edge_candidate_rank_mean": mean(&resident_candidate_ranks),
            "fatigue_bridge_candidate_rank_mean": optional_mean(&boundary_candidate_ranks),
            "program_paired_bridge_minus_resident_symbolic_separation_mean":
                optional_mean(&paired_symbolic_separation_differences),
            "resident_edge_neighborhood_overlap_mean":
                mean(&resident_neighborhood_overlaps),
            "fatigue_bridge_neighborhood_overlap_mean":
                optional_mean(&boundary_neighborhood_overlaps),
            "program_paired_bridge_minus_resident_neighborhood_overlap_mean":
                optional_mean(&paired_neighborhood_overlap_differences),
            "programs_with_lower_bridge_neighborhood_overlap":
                programs_with_lower_bridge_neighborhood_overlap,
            "resident_span_between_bridges_median":
                quantile(&resident_span_values, 0.50),
            "resident_span_between_bridges_minimum": resident_span_minimum,
            "all_fatigue_bridges_are_candidate_edges":
                all_boundaries_are_candidate_edges,
        }),
        paired_cosine_difference,
        paired_neighborhood_overlap_difference,
        semantic_boundary_local_contrast_violations,
        resident_span_minimum,
        all_boundaries_are_candidate_edges,
    })
}

#[cfg(test)]
// @forma implements architecture Domain.PlaylistScopedPathFairExecution as build_symbolic_playlist_scope_report
// @forma implements architecture Domain.CrossRuntimeScopedBoundaryNaturality as build_symbolic_playlist_scope_report
// @forma observes observation Domain.PlaybackSessionProgramState
pub(crate) fn build_symbolic_playlist_scope_report(
    catalog: &SymbolicCatalog<'_>,
    scopes: &[(String, Vec<usize>)],
    target_title: &str,
) -> Result<Value, String> {
    let compilation = compile_neural_program_atlas(
        catalog.track_keys,
        catalog.candidate_count,
        catalog.neighbors,
    )?;
    let Some(original_atlas) = compilation.atlas else {
        return Err(format!(
            "global candidate presentations are unclosed: {:?}",
            compilation.unclosed_presentations
        ));
    };
    let global_closure =
        close_neural_program_atlas_cycles(&original_atlas, catalog.neighbors, catalog.track_keys)?;
    let Some(global_atlas) = global_closure.atlas else {
        return Err("no global candidate presentation closes to a path-fair cycle".to_string());
    };
    let global_ordinals = (0..original_atlas.track_count).collect::<Vec<_>>();
    let global_audit = path_fair_closure_audit(
        &original_atlas,
        &global_atlas,
        catalog.neighbors,
        catalog,
        &global_ordinals,
    )?;
    let target_global = catalog
        .track_titles
        .iter()
        .position(|title| title.eq_ignore_ascii_case(target_title));

    let mut scope_reports = Vec::with_capacity(scopes.len());
    let mut executable_scope_count = 0_usize;
    let mut insufficient_scope_count = 0_usize;
    let mut total_fatigue_departures = 0_usize;
    let mut maximum_common_step_preimages = 0_usize;
    let mut all_capable_scopes_execute = true;
    let mut all_programs_bijective = true;
    let mut all_scopes_begin_with_resident_continuation = true;
    let mut all_departures_have_resident_continuation = true;
    let mut all_small_scopes_are_explicit = true;
    let mut all_cross_list_overlap_is_zero = true;
    let mut all_persistent_queues_are_nonreset = true;
    let mut all_owned_states_are_distinct = true;
    let mut all_scoped_boundaries_have_positive_contrast = true;

    for (scope_name, scope_ordinals) in scopes {
        if scope_ordinals.len() < 3 {
            insufficient_scope_count += 1;
            scope_reports.push(json!({
                "scope": scope_name,
                "track_count": scope_ordinals.len(),
                "status": "explicit_insufficient_two_list_capacity",
            }));
            continue;
        }
        let scoped_proposals = restrict_neural_program_atlas_to_playlist(
            &original_atlas,
            catalog.track_keys,
            scope_ordinals,
        )?;
        let scoped_candidates = candidate_relation_from_program_atlas(&scoped_proposals.atlas)?;
        let scoped_closure = close_neural_program_atlas_cycles(
            &scoped_proposals.atlas,
            &scoped_candidates,
            &scoped_proposals
                .global_track_ordinals
                .iter()
                .map(|ordinal| catalog.track_keys[*ordinal].clone())
                .collect::<Vec<_>>(),
        )?;
        let Some(atlas) = scoped_closure.atlas else {
            all_capable_scopes_execute = false;
            scope_reports.push(json!({
                "scope": scope_name,
                "track_count": scope_ordinals.len(),
                "status": "explicit_scoped_program_retraction",
                "retracted_presentations": scoped_closure.retracted_presentations,
            }));
            continue;
        };
        let local_audit = path_fair_closure_audit(
            &scoped_proposals.atlas,
            &atlas,
            &scoped_candidates,
            catalog,
            &scoped_proposals.global_track_ordinals,
        )?;
        all_scoped_boundaries_have_positive_contrast &=
            local_audit.semantic_boundary_local_contrast_violations == 0;
        let orbit_index = compile_program_orbit_index(&atlas)?;
        let anchors = (0..atlas.track_count).collect::<Vec<_>>();
        let initial = initialize_traversal_state(&atlas, &anchors)?;
        let tracks_per_list = 32.min(((atlas.track_count - 1) / 2).max(1));
        let first = match execute_program_list(&atlas, &orbit_index, tracks_per_list, &initial) {
            Ok(list) => list,
            Err(error) => {
                all_capable_scopes_execute = false;
                scope_reports.push(json!({
                    "scope": scope_name,
                    "track_count": scope_ordinals.len(),
                    "status": "explicit_scoped_traversal_exhaustion",
                    "path_ordinal": error.path_ordinal,
                    "current_track": error.current_track,
                }));
                continue;
            }
        };
        let second =
            match execute_program_list(&atlas, &orbit_index, tracks_per_list, &first.next_state) {
                Ok(list) => list,
                Err(error) => {
                    all_capable_scopes_execute = false;
                    scope_reports.push(json!({
                        "scope": scope_name,
                        "track_count": scope_ordinals.len(),
                        "status": "explicit_scoped_traversal_exhaustion",
                        "path_ordinal": error.path_ordinal,
                        "current_track": error.current_track,
                    }));
                    continue;
                }
            };
        let reset = execute_program_list(&atlas, &orbit_index, tracks_per_list, &initial)
            .map_err(|error| error.to_string())?;
        let scoped_bijective = atlas.programs.iter().all(|program| {
            let mut successors = program.successors.clone();
            successors.sort_unstable();
            successors == (0..atlas.track_count).collect::<Vec<_>>()
        });
        let initial_continuation = atlas.programs[0]
            .successors
            .iter()
            .enumerate()
            .all(|(source, destination)| source != *destination);
        let mut no_consecutive_style_departures = true;
        let mut cross_list_overlap_maximum = 0_usize;
        let mut fatigue_departures = 0_usize;
        for path in 0..atlas.track_count {
            let first_start = path * tracks_per_list;
            let first_end = first_start + tracks_per_list;
            let first_tracks = &first.order[first_start..first_end];
            let second_tracks = &second.order[first_start..first_end];
            let first_set = first_tracks.iter().copied().collect::<HashSet<_>>();
            cross_list_overlap_maximum = cross_list_overlap_maximum.max(
                second_tracks
                    .iter()
                    .filter(|track| first_set.contains(track))
                    .count(),
            );
            let semantic_departures = first.style_sector_departures[first_start..first_end]
                .iter()
                .chain(&second.style_sector_departures[first_start..first_end])
                .copied()
                .collect::<Vec<_>>();
            fatigue_departures += semantic_departures
                .iter()
                .filter(|departure| **departure)
                .count();
            no_consecutive_style_departures &= semantic_departures
                .windows(2)
                .all(|pair| !(pair[0] && pair[1]));
        }
        let owned_states_are_distinct = first
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
            .collect::<HashSet<_>>()
            .len()
            == atlas.track_count;
        let scope_maximum_common_step_preimages = (0..tracks_per_list)
            .map(|step| {
                let mut preimages = HashMap::<usize, usize>::new();
                for path in 0..atlas.track_count {
                    *preimages
                        .entry(second.order[path * tracks_per_list + step])
                        .or_default() += 1;
                }
                preimages.values().copied().max().unwrap_or(0)
            })
            .max()
            .unwrap_or(0);
        let persistent_is_not_reset = second.order != reset.order;
        let target_local = target_global.and_then(|target| {
            scoped_proposals
                .global_track_ordinals
                .iter()
                .position(|ordinal| *ordinal == target)
        });
        let target_occurrences = target_local.map(|target| {
            first
                .order
                .iter()
                .chain(&second.order)
                .filter(|track| **track == target)
                .count()
        });

        executable_scope_count += 1;
        total_fatigue_departures += fatigue_departures;
        maximum_common_step_preimages =
            maximum_common_step_preimages.max(scope_maximum_common_step_preimages);
        all_programs_bijective &= scoped_bijective;
        all_scopes_begin_with_resident_continuation &= initial_continuation;
        all_departures_have_resident_continuation &= no_consecutive_style_departures;
        all_cross_list_overlap_is_zero &= cross_list_overlap_maximum == 0;
        all_persistent_queues_are_nonreset &= persistent_is_not_reset;
        all_owned_states_are_distinct &= owned_states_are_distinct;
        scope_reports.push(json!({
            "scope": scope_name,
            "track_count": scope_ordinals.len(),
            "status": "passed",
            "program_count": atlas.programs.len(),
            "tracks_per_list": tracks_per_list,
            "all_programs_bijective": scoped_bijective,
            "initial_program_has_continuation_for_every_start": initial_continuation,
            "first_step_is_resident_for_every_start":
                (0..atlas.track_count).all(|path|
                    !first.style_sector_departures[path * tracks_per_list]),
            "no_consecutive_style_sector_departures":
                no_consecutive_style_departures,
            "cross_list_realized_track_overlap_maximum":
                cross_list_overlap_maximum,
            "persistent_second_is_not_reset_replay": persistent_is_not_reset,
            "owned_states_remain_distinct": owned_states_are_distinct,
            "maximum_common_step_preimages":
                scope_maximum_common_step_preimages,
            "fatigue_departures": fatigue_departures,
            "semantic_closure": local_audit.value,
            "target_occurrences": target_occurrences,
            "target_uniform_expectation":
                target_local.map(|_| tracks_per_list * 2),
        }));
    }

    let capable_scope_count = scopes
        .iter()
        .filter(|(_, ordinals)| ordinals.len() >= 3)
        .count();
    all_capable_scopes_execute &= executable_scope_count == capable_scope_count;
    all_small_scopes_are_explicit &= insufficient_scope_count
        == scopes
            .iter()
            .filter(|(_, ordinals)| ordinals.len() < 3)
            .count();
    let acceptance = json!({
        "every_two_list_capable_real_scope_executes": all_capable_scopes_execute,
        "every_scoped_program_is_bijective": all_programs_bijective,
        "every_scope_begins_with_resident_continuation":
            all_scopes_begin_with_resident_continuation,
        "every_departure_is_followed_by_resident_continuation":
            all_departures_have_resident_continuation,
        "playlist_membership_capacity_is_explicit": all_small_scopes_are_explicit,
        "cross_list_state_never_replays_realized_tracks":
            all_cross_list_overlap_is_zero,
        "persistent_queue_state_is_not_reset_replay":
            all_persistent_queues_are_nonreset,
        "owned_path_states_do_not_merge": all_owned_states_are_distinct,
        "resident_edges_are_more_continuous_than_fatigue_bridges":
            global_audit.paired_cosine_difference < 0.0,
        "fatigue_bridges_are_supported_neural_edges":
            global_audit.all_boundaries_are_candidate_edges,
        "fatigue_bridges_leave_resident_neural_neighborhoods":
            global_audit.paired_neighborhood_overlap_difference < 0.0,
        "every_scoped_fatigue_bridge_has_positive_local_contrast":
            all_scoped_boundaries_have_positive_contrast,
        "programs_reside_between_structural_fatigue_bridges":
            global_audit.resident_span_minimum > 0,
    });
    let passed = acceptance
        .as_object()
        .expect("acceptance is an object")
        .values()
        .all(|value| value == &Value::Bool(true));
    Ok(json!({
        "experiment": "rust_symbolic_audio_playlist_scope_first_return_probe",
        "status": if passed { "probe_passed" } else { "probe_failed" },
        "input": {
            "generation": catalog.generation,
            "track_count": global_atlas.track_count,
            "real_directory_scope_count": scopes.len(),
            "candidate_width": global_atlas.candidate_count,
            "admitted_single_cycle_programs": global_atlas.programs.len(),
            "retracted_presentations":
                global_closure.retracted_presentations,
        },
        "construction": {
            "scope_law":
                "first return of each generation-owned permutation program",
            "runtime_candidate_relation_reconstruction": false,
            "out_of_playlist_selection": false,
            "tuned_parameters": [],
        },
        "summary": {
            "executable_scope_count": executable_scope_count,
            "singleton_obstruction_count": insufficient_scope_count,
            "total_fatigue_departures": total_fatigue_departures,
            "maximum_common_step_preimages": maximum_common_step_preimages,
        },
        "path_fair_closure": global_audit.value,
        "acceptance": acceptance,
        "scopes": scope_reports,
    }))
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
#[derive(Debug, Clone, Copy)]
struct ExecutionContinuity {
    resident_count: usize,
    departure_count: usize,
    resident_mean: f64,
    departure_mean: f64,
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
#[derive(Debug, Clone, Copy)]
struct CrossListMetrics {
    track_overlap_max: f64,
    track_overlap_mean: f64,
    prefix_nearest_mean: f64,
    prefix_centroid_mean: f64,
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
fn embedding_cosine(catalog: &SymbolicCatalog<'_>, left: usize, right: usize) -> f64 {
    let left_start = left * catalog.embedding_dimension;
    let right_start = right * catalog.embedding_dimension;
    catalog.embeddings[left_start..left_start + catalog.embedding_dimension]
        .iter()
        .zip(&catalog.embeddings[right_start..right_start + catalog.embedding_dimension])
        .map(|(left, right)| *left as f64 * *right as f64)
        .sum()
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len().max(1) as f64
}

#[cfg(test)]
fn optional_mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| mean(values))
}

#[cfg(test)]
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

fn clear_bit(bits: &mut [u64], index: usize) {
    bits[index / 64] &= !(1_u64 << (index % 64));
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

fn bit_count(bits: &[u64]) -> usize {
    bits.iter().map(|word| word.count_ones() as usize).sum()
}
