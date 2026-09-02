use super::{
    AudioStyleSymbolicPlaybackSession, PlaybackTrackKey, read_audio_style_stable_model_for_test,
};
use crate::domain::player::model::PlaybackTrack;
use crate::domain::playlist_playback::symbolic_program::{
    execute_program_list, transport_traversal_state,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

const DB_INPUT_ENV: &str = "SLISIC_NATIVE_SCOPED_POSITION_DB_INPUT";
const MODEL_INPUT_ENV: &str = "SLISIC_NATIVE_SCOPED_POSITION_MODEL_INPUT";
const OUTPUT_ENV: &str = "SLISIC_NATIVE_SCOPED_POSITION_OUTPUT";
const RECEIPT_ENV: &str = "SLISIC_NATIVE_SCOPED_POSITION_RECEIPT";
const LOG_ENV: &str = "SLISIC_NATIVE_SCOPED_POSITION_LOG";

const DEFAULT_DB_INPUT: &str = r"C:\Users\admin\ann\outputs\audio_style_trajectory_dynamics\current_model_first_slot_db_inputs-219-v1.json";
const DEFAULT_MODEL_INPUT: &str = r"C:\Users\admin\slisic\.tmp\installed-update-2.1.9\previous-data\audio-style-stable-model\stable.json";
const DEFAULT_OUTPUT: &str = r"C:\Users\admin\ann\outputs\audio_style_trajectory_dynamics\native_scoped_position-219-v1.json";
const DEFAULT_RECEIPT: &str = r"C:\Users\admin\ann\outputs\audio_style_trajectory_dynamics\native_scoped_position-219-v1-receipt.md";
const DEFAULT_LOG: &str =
    r"C:\Users\admin\slisic\.tmp\native-scoped-position-219-v1\native-scoped-position-219-v1.log";

#[derive(Debug, Clone, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct DbTrackKey {
    music_url: String,
    file_path: String,
    start_ms: u32,
    end_ms: u32,
}

#[derive(Debug, Deserialize)]
struct DbInputDocument {
    independent_scope_check: DbScopeCheck,
    frozen_model: DbFrozenModel,
}

#[derive(Debug, Deserialize)]
struct DbScopeCheck {
    admitted_key_count: usize,
    admitted_keys: Vec<DbTrackKey>,
    equal: bool,
    expected_key_count: usize,
    expected_keys: Vec<DbTrackKey>,
}

#[derive(Debug, Deserialize)]
struct DbFrozenModel {
    generation: u64,
    indexed_track_count: usize,
    indexed_unique_key_count: usize,
    path: String,
    sha256: String,
    size_bytes: usize,
}

impl DbTrackKey {
    fn to_native(&self) -> PlaybackTrackKey {
        PlaybackTrackKey {
            music_url: self.music_url.clone(),
            file_path: PathBuf::from(&self.file_path),
            start_ms: self.start_ms,
            end_ms: self.end_ms,
        }
    }
}

fn db_key(key: &PlaybackTrackKey) -> DbTrackKey {
    DbTrackKey {
        music_url: key.music_url.clone(),
        file_path: key.file_path.to_string_lossy().into_owned(),
        start_ms: key.start_ms,
        end_ms: key.end_ms,
    }
}

fn json_key(key: &PlaybackTrackKey) -> Value {
    let key = db_key(key);
    json!({
        "music_url": key.music_url,
        "file_path": key.file_path,
        "start_ms": key.start_ms,
        "end_ms": key.end_ms,
    })
}

fn path_from_env(name: &str, fallback: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(fallback))
}

fn permutation_cycles(successors: &[usize]) -> Vec<Vec<usize>> {
    let mut visited = vec![false; successors.len()];
    let mut cycles = Vec::new();
    for root in 0..successors.len() {
        if visited[root] {
            continue;
        }
        let mut cycle = Vec::new();
        let mut node = root;
        while !visited[node] {
            visited[node] = true;
            cycle.push(node);
            node = successors[node];
        }
        cycles.push(cycle);
    }
    cycles
}

fn cycle_json(cycles: &[Vec<usize>]) -> Value {
    Value::Array(cycles.iter().map(|cycle| json!(cycle)).collect::<Vec<_>>())
}

fn class_member_ordinals(
    materializations: &[Vec<PlaybackTrack>],
) -> Vec<HashMap<PlaybackTrackKey, usize>> {
    materializations
        .iter()
        .map(|members| {
            members
                .iter()
                .enumerate()
                .map(|(ordinal, track)| (PlaybackTrackKey::from_track(track), ordinal))
                .collect()
        })
        .collect()
}

fn native_member_event(
    event_index: usize,
    list: &crate::domain::playlist_playback::symbolic_program::ProgramList,
    materializations: &[Vec<PlaybackTrack>],
) -> (Value, PlaybackTrackKey) {
    let next_local = list.order[0];
    let coverage_epoch = list.next_state.coverage_epoch(0).unwrap_or_default();
    let members = materializations
        .get(next_local)
        .expect("native execution must select an existing local class");
    assert!(
        !members.is_empty(),
        "native materialization classes must be nonempty"
    );
    let member_ordinal = (coverage_epoch + next_local) % members.len();
    let track = members[member_ordinal].clone();
    let key = PlaybackTrackKey::from_track(&track);
    (
        json!({
            "event_index": event_index,
            "coverage_epoch": coverage_epoch,
            "local_class": next_local,
            "member_ordinal": member_ordinal,
            "program_ordinal": list.program_ordinals[0],
            "coverage_epoch_transition": list.coverage_epoch_transitions[0],
            "track_key": json_key(&key),
        }),
        key,
    )
}

fn independent_db_projection(path: &Path) -> (DbInputDocument, usize) {
    let started = Instant::now();
    let bytes = fs::read(path).unwrap_or_else(|error| {
        panic!(
            "independent current-scope DB input `{}` should be readable: {error}",
            path.display()
        )
    });
    let document = serde_json::from_slice::<DbInputDocument>(&bytes).unwrap_or_else(|error| {
        panic!(
            "independent current-scope DB input `{}` should be valid JSON: {error}",
            path.display()
        )
    });
    (document, started.elapsed().as_millis() as usize)
}

fn write_receipt(
    path: &Path,
    output_path: &Path,
    log_path: &Path,
    generation: u64,
    scope_signature: &str,
    model_classes: usize,
    model_keys: usize,
    scoped_classes: usize,
    scoped_keys: usize,
    program_count: usize,
    target_global: usize,
    target_local: usize,
    prefix_anchor_count: usize,
    full_replay: &Value,
    resource: &Value,
) {
    let coverage_status = full_replay["result_type"].as_str().unwrap_or("Residual");
    let coverage_complete = full_replay["concrete_coverage_complete"]
        .as_bool()
        .unwrap_or(false);
    let full_replay_json =
        serde_json::to_string_pretty(full_replay).expect("full replay should serialize");
    let resource_json =
        serde_json::to_string_pretty(resource).expect("resource observation should serialize");
    let identity = format!(
        "## Identity and domain\n\n\
 - model generation: {}\n\
 - model carrier: {} keys / {} classes\n\
 - scoped materializations: {} concrete keys / {} local classes\n\
 - scope signature: {}\n\
 - target global ordinal: {}\n\
 - target derived local ordinal: {}\n\
 - program count: {}\n\
 - fresh native prefix anchors: {}\n\
 - DB/model scope union: exact and disjoint before export\n",
        generation,
        model_keys,
        model_classes,
        scoped_keys,
        scoped_classes,
        scope_signature,
        target_global,
        target_local,
        program_count,
        prefix_anchor_count,
    );
    let text = format!(
        "{identity}\n# Native scoped position export — `native-scoped-position-219-v1`\n\n\
Result: `Exact` for the formed generation-{generation} native scope carrier and its\
test-only fresh-state positional witnesses. The optional bounded dynamic replay is\
`{coverage_status}` (`concrete_coverage_complete={coverage_complete}`).\n\n\
This is observer/test evidence only. It does not change production probability/model\
logic, deployment, live database state, or the stable model. The native source remains\
the authority; this receipt records the formed carrier after one real `propose_next`.\n\n\
## Identity and domain\n\n\
## Dynamic replay\n\n\
```json\n{full_replay_json}\n```\n\n\
`session_control` remains explicitly untested in this minimum export; no extra scope\
formation or resumed/cancelled session result is inferred. First-slot uniformity and\
Monte Carlo fairness remain outside this artifact.\n\n\
## Resource observation\n\n\
```json\n{resource_json}\n```\n\n\
Output: `{output_path}`\n\nLog: `{log_path}`\n",
        generation = generation,
        coverage_status = coverage_status,
        coverage_complete = coverage_complete,
        identity = identity,
        full_replay_json = full_replay_json,
        resource_json = resource_json,
        output_path = output_path.display(),
        log_path = log_path.display(),
    );
    fs::write(path, text).unwrap_or_else(|error| {
        panic!(
            "native scoped position receipt `{}` should be writable: {error}",
            path.display()
        )
    });
}

#[test]
#[ignore = "requires the frozen DB scope and generation-163 stable model; emits observer-only native traversal evidence"]
fn native_scoped_position_export_generation163_scope3420() {
    const EXPECTED_GENERATION: u64 = 163;
    const EXPECTED_DB_KEYS: usize = 3_420;
    const EXPECTED_MODEL_KEYS: usize = 3_585;
    const EXPECTED_MODEL_CLASSES: usize = 3_306;
    const TARGET_URL: &str = "https://www.youtube.com/watch?v=uHcJepz3QW0";
    const TARGET_PATH: &str = r"C:\Users\admin\Documents\slisic\youtube/Death Stranding 2- On the Beach – All Official Soundtracks\Minus Sixty One.m4a";
    const TARGET_START_MS: u32 = 0;
    const TARGET_END_MS: u32 = 316_213;

    let db_path = path_from_env(DB_INPUT_ENV, DEFAULT_DB_INPUT);
    let model_path = path_from_env(MODEL_INPUT_ENV, DEFAULT_MODEL_INPUT);
    let output_path = path_from_env(OUTPUT_ENV, DEFAULT_OUTPUT);
    let receipt_path = path_from_env(RECEIPT_ENV, DEFAULT_RECEIPT);
    let log_path = path_from_env(LOG_ENV, DEFAULT_LOG);
    assert!(
        db_path.is_file(),
        "DB input must exist: {}",
        db_path.display()
    );
    assert!(
        model_path.is_file(),
        "stable model input must exist: {}",
        model_path.display()
    );

    let (db, db_projection_ms) = independent_db_projection(&db_path);
    let scope = db.independent_scope_check;
    assert!(
        scope.equal,
        "the independent DB scope equality receipt must be true"
    );
    assert_eq!(scope.expected_key_count, EXPECTED_DB_KEYS);
    assert_eq!(scope.admitted_key_count, EXPECTED_DB_KEYS);
    let expected_keys = scope.expected_keys.into_iter().collect::<BTreeSet<_>>();
    let admitted_keys = scope.admitted_keys.into_iter().collect::<BTreeSet<_>>();
    assert_eq!(expected_keys.len(), EXPECTED_DB_KEYS);
    assert_eq!(admitted_keys.len(), EXPECTED_DB_KEYS);
    assert_eq!(
        admitted_keys, expected_keys,
        "DB admitted and expected domains must agree"
    );

    let target_key = DbTrackKey {
        music_url: TARGET_URL.to_string(),
        file_path: TARGET_PATH.to_string(),
        start_ms: TARGET_START_MS,
        end_ms: TARGET_END_MS,
    };
    assert!(
        expected_keys.contains(&target_key),
        "the named Minus Sixty One target must be in the independent DB domain"
    );
    let target_native_key = target_key.to_native();

    let model_size_bytes = fs::metadata(&model_path)
        .expect("stable model metadata should be readable")
        .len() as usize;
    assert_eq!(model_size_bytes, db.frozen_model.size_bytes);
    assert_eq!(db.frozen_model.generation, EXPECTED_GENERATION);
    assert_eq!(db.frozen_model.indexed_track_count, EXPECTED_MODEL_KEYS);
    assert_eq!(
        db.frozen_model.indexed_unique_key_count,
        EXPECTED_MODEL_KEYS
    );

    let model_started = Instant::now();
    let snapshot = read_audio_style_stable_model_for_test(&model_path)
        .expect("production stable loader must read the frozen generation-163 model");
    let model_loader_ms = model_started.elapsed().as_millis() as usize;
    assert_eq!(snapshot.generation(), EXPECTED_GENERATION);
    let encoding = snapshot
        .state
        .symbolic_program_encoding
        .as_deref()
        .expect("generation-163 model must expose the executable symbolic encoding");
    assert_eq!(encoding.ordered_keys.len(), EXPECTED_MODEL_CLASSES);
    assert_eq!(encoding.member_keys.len(), EXPECTED_MODEL_CLASSES);
    assert_eq!(encoding.track_keys.len(), EXPECTED_MODEL_CLASSES);
    assert_eq!(encoding.ordinal_by_key.len(), EXPECTED_MODEL_KEYS);
    assert_eq!(snapshot.state.indexed_tracks.len(), EXPECTED_MODEL_KEYS);

    let mut model_tracks =
        HashMap::<PlaybackTrackKey, PlaybackTrack>::with_capacity(EXPECTED_MODEL_KEYS);
    for indexed in snapshot.state.indexed_tracks.values() {
        let key = PlaybackTrackKey::from_track(&indexed.track);
        assert!(
            model_tracks.insert(key, indexed.track.clone()).is_none(),
            "frozen model indexed tracks must have unique concrete keys"
        );
    }
    assert_eq!(model_tracks.len(), EXPECTED_MODEL_KEYS);
    let target = model_tracks
        .get(&target_native_key)
        .cloned()
        .expect("the named target must have frozen model track metadata");
    let scope_tracks = expected_keys
        .iter()
        .map(|key| {
            model_tracks
                .get(&key.to_native())
                .cloned()
                .unwrap_or_else(|| panic!("DB-authorized key missing from frozen model: {key:?}"))
        })
        .collect::<Vec<_>>();

    let mut session = AudioStyleSymbolicPlaybackSession::default();
    let formation_started = Instant::now();
    let first = session
        .propose_next(&snapshot, &target, &scope_tracks, &[])
        .expect("native scope formation and first proposal must succeed");
    let formation_ms = formation_started.elapsed().as_millis() as usize;
    let execution = session
        .execution
        .as_ref()
        .expect("successful native proposal must retain its formed execution carrier");
    assert_eq!(execution.generation, EXPECTED_GENERATION);
    let generation = execution.generation;
    let scope_signature = execution.scope_signature.clone();
    let atlas = Arc::clone(&execution.atlas);
    let orbit_index = Arc::clone(&execution.orbit_index);
    let local_by_key = Arc::clone(&execution.local_by_key);
    let materializations = Arc::clone(&execution.materializations);
    assert_eq!(atlas.track_count, materializations.len());
    assert!(!atlas.programs.is_empty());

    let native_scope_keys = materializations
        .iter()
        .enumerate()
        .flat_map(|(local, members)| {
            assert!(
                !members.is_empty(),
                "local class {local} must have materializations"
            );
            members
                .iter()
                .map(|track| db_key(&PlaybackTrackKey::from_track(track)))
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        native_scope_keys, expected_keys,
        "formed native M union must equal independent DB scope"
    );
    assert_eq!(native_scope_keys.len(), EXPECTED_DB_KEYS);

    let mut local_globals = Vec::with_capacity(materializations.len());
    for members in materializations.iter() {
        let member_key = PlaybackTrackKey::from_track(&members[0]);
        let global = encoding
            .ordinal_by_key
            .get(&member_key)
            .copied()
            .expect("every native materialization must be generation-owned");
        assert!(
            encoding.member_keys[global].contains(&member_key),
            "native materialization must remain inside its generation member class"
        );
        local_globals.push(global);
    }
    assert!(
        local_globals
            .windows(2)
            .all(|window| encoding.track_keys[window[0]] < encoding.track_keys[window[1]]),
        "native local classes must follow generation schedule-key ordering"
    );
    let target_global = encoding
        .ordinal_by_key
        .get(&target_native_key)
        .copied()
        .expect("target must have a generation global ordinal");
    let target_local = local_by_key
        .get(&target_native_key)
        .copied()
        .expect("target must have a native local ordinal");
    assert_eq!(local_globals[target_local], target_global);

    assert!(
        local_by_key.len() >= native_scope_keys.len(),
        "native local_by_key must cover every materialized DB key"
    );
    assert!(
        local_by_key.len() <= encoding.ordinal_by_key.len(),
        "native local_by_key must remain within generation-owned member keys"
    );
    for (key, local) in local_by_key.iter() {
        assert!(
            *local < materializations.len(),
            "local_by_key must point into native M"
        );
        let global = encoding
            .ordinal_by_key
            .get(key)
            .copied()
            .expect("local_by_key must only contain generation-owned keys");
        assert_eq!(local_globals[*local], global);
    }
    for key in expected_keys.iter() {
        let native = key.to_native();
        let local = local_by_key
            .get(&native)
            .copied()
            .expect("every independent DB key must have a native local ordinal");
        assert!(
            materializations[local]
                .iter()
                .any(|track| PlaybackTrackKey::from_track(track) == native),
            "every independent DB key must occur in its local native materialization"
        );
    }

    let mut permutation_checks = Vec::with_capacity(atlas.programs.len());
    let expected_ordinals = (0..atlas.track_count).collect::<BTreeSet<_>>();
    for (program_ordinal, program) in atlas.programs.iter().enumerate() {
        assert_eq!(program.successors.len(), atlas.track_count);
        let successors = program.successors.iter().copied().collect::<BTreeSet<_>>();
        assert_eq!(
            successors, expected_ordinals,
            "program {program_ordinal} must be a permutation"
        );
        let cycles = permutation_cycles(&program.successors);
        permutation_checks.push(json!({
            "program_ordinal": program_ordinal,
            "lineage": program.lineage.clone(),
            "presentation_ordinals": program.presentation_ordinals.clone(),
            "boundary_sources": program.boundary_sources.clone(),
            "cycle_count": cycles.len(),
            "cycle_lengths": cycles.iter().map(Vec::len).collect::<Vec<_>>(),
            "successors": program.successors.clone(),
        }));
    }
    let program0_cycles = permutation_cycles(&atlas.programs[0].successors);

    let member_ordinals = class_member_ordinals(materializations.as_ref());
    let mut anchor_keys = vec![target_native_key.clone()];
    for local in [
        0,
        materializations.len() / 2,
        materializations.len().saturating_sub(1),
    ] {
        if local >= materializations.len() || local == target_local {
            continue;
        }
        let key = PlaybackTrackKey::from_track(&materializations[local][0]);
        if !anchor_keys.contains(&key) {
            anchor_keys.push(key);
        }
    }
    assert!(
        anchor_keys.len() >= 3,
        "native prefix witness needs several classes"
    );

    let prefix_started = Instant::now();
    let mut prefix_witnesses = Vec::with_capacity(anchor_keys.len());
    for anchor_key in &anchor_keys {
        let anchor_local = local_by_key
            .get(anchor_key)
            .copied()
            .expect("prefix anchor must be in native local map");
        let mut state =
            transport_traversal_state(None, atlas.as_ref(), &[anchor_local], &[vec![anchor_local]])
                .expect("fresh native prefix state must transport");
        let mut current = anchor_local;
        let mut seen = BTreeSet::from([anchor_local]);
        let mut events = Vec::new();
        let mut expected_next = atlas.programs[0].successors[current];
        while seen.insert(expected_next) {
            let list = execute_program_list(atlas.as_ref(), orbit_index.as_ref(), 1, &state)
                .expect("program-0 fresh prefix must execute before first repeat");
            assert_eq!(
                list.program_ordinals[0], 0,
                "fresh native prefix must remain on program 0 before its first repeat"
            );
            assert_eq!(
                list.order[0], expected_next,
                "native fresh prefix must equal the independently walked program-0 successor"
            );
            let (event, _) =
                native_member_event(events.len() + 1, &list, materializations.as_ref());
            events.push(event);
            state = list.next_state;
            current = expected_next;
            expected_next = atlas.programs[0].successors[current];
        }
        prefix_witnesses.push(json!({
            "anchor_key": json_key(anchor_key),
            "anchor_local": anchor_local,
            "program0_cycle_length": seen.len(),
            "events_before_first_repeat": events,
        }));
    }
    let prefix_ms = prefix_started.elapsed().as_millis() as usize;

    let full_replay_started = Instant::now();
    let max_member_count = materializations
        .iter()
        .map(Vec::len)
        .max()
        .expect("native scope must contain a materialization class");
    let step_bound = materializations
        .len()
        .checked_mul(max_member_count + 1)
        .expect("bounded native replay size must fit usize");
    let mut observed_member_ordinals = vec![BTreeSet::<usize>::new(); materializations.len()];
    let initial_member_ordinal = member_ordinals[target_local]
        .get(&target_native_key)
        .copied()
        .expect("target must occur in its materialization class");
    observed_member_ordinals[target_local].insert(initial_member_ordinal);
    let mut observed_keys = BTreeSet::from([db_key(&target_native_key)]);
    let mut observed_classes = BTreeSet::new();
    let mut coverage_epoch_transitions = 0_usize;
    let mut max_coverage_epoch = 0_usize;
    let mut replay_state =
        transport_traversal_state(None, atlas.as_ref(), &[target_local], &[vec![target_local]])
            .expect("full fresh replay state must transport");
    let mut termination = None;
    let mut replay_event_count = 0_usize;
    for event_index in 1..=step_bound {
        let list =
            match execute_program_list(atlas.as_ref(), orbit_index.as_ref(), 1, &replay_state) {
                Ok(list) => list,
                Err(error) => {
                    termination = Some(json!({
                        "event_index": event_index,
                        "path_ordinal": error.path_ordinal,
                        "current_track": error.current_track,
                        "message": error.to_string(),
                    }));
                    break;
                }
            };
        let (event, key) = native_member_event(event_index, &list, materializations.as_ref());
        let local = list.order[0];
        let epoch = list.next_state.coverage_epoch(0).unwrap_or_default();
        let ordinal = (epoch + local) % materializations[local].len();
        assert_eq!(
            member_ordinals[local].get(&key).copied(),
            Some(ordinal),
            "native concrete member must follow post-transition epoch law"
        );
        observed_member_ordinals[local].insert(ordinal);
        observed_keys.insert(db_key(&key));
        observed_classes.insert(local);
        coverage_epoch_transitions += usize::from(list.coverage_epoch_transitions[0]);
        max_coverage_epoch = max_coverage_epoch.max(epoch);
        replay_event_count = event_index;
        replay_state = list.next_state;
        let _ = event;
    }
    let missing_member_count = observed_member_ordinals
        .iter()
        .zip(materializations.iter())
        .map(|(observed, members)| members.len().saturating_sub(observed.len()))
        .sum::<usize>();
    let concrete_coverage_complete = missing_member_count == 0;
    let full_replay_ms = full_replay_started.elapsed().as_millis() as usize;
    let full_replay = json!({
        "result_type": if concrete_coverage_complete { "Exact" } else { "Residual" },
        "event_count_including_initial_anchor": replay_event_count + 1,
        "proposal_event_count": replay_event_count,
        "step_bound": step_bound,
        "max_member_count": max_member_count,
        "coverage_epoch_transition_count": coverage_epoch_transitions,
        "max_coverage_epoch": max_coverage_epoch,
        "observed_class_count": observed_classes.len(),
        "observed_concrete_key_count": observed_keys.len(),
        "expected_concrete_key_count": native_scope_keys.len(),
        "missing_member_count": missing_member_count,
        "concrete_coverage_complete": concrete_coverage_complete,
        "missing_member_sample": observed_member_ordinals
            .iter()
            .zip(materializations.iter())
            .enumerate()
            .filter_map(|(local, (observed, members))| {
                let missing = (0..members.len())
                    .filter(|ordinal| !observed.contains(ordinal))
                    .collect::<Vec<_>>();
                (!missing.is_empty()).then_some(json!({
                    "local_class": local,
                    "missing_ordinals": missing,
                }))
            })
            .take(16)
            .collect::<Vec<_>>(),
        "termination": termination,
        "same_formed_carrier": true,
        "session_control": {
            "status": "untested",
            "reason": "minimum export did not perform a second scope formation or resumed/cancelled session run"
        },
        "elapsed_ms": full_replay_ms,
    });

    let resource = json!({
        "db_input_bytes": fs::metadata(&db_path).expect("DB metadata should remain readable").len(),
        "model_input_bytes": model_size_bytes,
        "db_projection_ms": db_projection_ms,
        "model_loader_ms": model_loader_ms,
        "scope_formation_ms": formation_ms,
        "fresh_prefix_replay_ms": prefix_ms,
        "bounded_full_replay_ms": full_replay_ms,
        "available_parallelism": std::thread::available_parallelism().map(|n| n.get()).ok(),
        "parallel_width": 1,
        "peak_memory_bytes": Value::Null,
        "io_note": "read-only DB/model inputs; no audio-tree scan; output and receipt are observer artifacts"
    });

    let local_classes = materializations
        .iter()
        .enumerate()
        .map(|(local, members)| {
            json!({
                "local": local,
                "global": local_globals[local],
                "schedule_key": encoding.track_keys[local_globals[local]].clone(),
                "members": members.iter().enumerate().map(|(ordinal, track)| {
                    let key = PlaybackTrackKey::from_track(track);
                    assert!(track.end_ms >= track.start_ms);
                    json!({
                        "member_ordinal": ordinal,
                        "duration_ms": track.end_ms - track.start_ms,
                        "track_key": json_key(&key),
                    })
                }).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    let mut local_by_key_rows = local_by_key
        .iter()
        .map(|(key, local)| {
            let global = encoding.ordinal_by_key[key];
            (
                db_key(key),
                json!({
                    "track_key": json_key(key),
                    "local": local,
                    "global": global,
                    "in_materializations": native_scope_keys.contains(&db_key(key)),
                }),
            )
        })
        .collect::<Vec<_>>();
    local_by_key_rows.sort_by(|left, right| left.0.cmp(&right.0));
    let local_by_key_output = local_by_key_rows
        .into_iter()
        .map(|(_, row)| row)
        .collect::<Vec<_>>();

    let artifact = json!({
        "artifact": "native-scoped-position-219-v1",
        "result_type": "Exact",
        "result_scope": "actual formed native traversal carrier for the independent DB-authorized All Msic scope",
        "authority": "native recommendation.rs formation and execution",
        "observer_only": true,
        "input_identity": {
            "db_input_path": db_path,
            "db_scope_expected_key_count": EXPECTED_DB_KEYS,
            "db_scope_admitted_key_count": EXPECTED_DB_KEYS,
            "model_input_path": model_path,
            "model_generation": generation,
            "model_sha256_from_predecessor": db.frozen_model.sha256,
            "model_indexed_key_count": EXPECTED_MODEL_KEYS,
            "model_class_count": EXPECTED_MODEL_CLASSES,
        },
        "scope_identity": {
            "generation": generation,
            "scope_signature": scope_signature,
            "track_key_signature": encoding.track_key_signature,
            "partition_signature": encoding.partition_signature,
            "candidate_relation_signature": encoding.candidate_relation_signature,
            "program_encoding_signature": encoding.program_encoding_signature,
            "local_class_count_q": materializations.len(),
            "concrete_member_count_M": native_scope_keys.len(),
            "local_by_key_count": local_by_key.len(),
            "local_by_key_outside_M_count": local_by_key
                .iter()
                .filter(|(key, _)| !native_scope_keys.contains(&db_key(key)))
                .count(),
        },
        "target": {
            "track_key": json_key(&target_native_key),
            "global_ordinal": target_global,
            "local_ordinal": target_local,
            "duration_ms": target.end_ms - target.start_ms,
            "first_proposed_track_key": json_key(&PlaybackTrackKey::from_track(&first.track)),
        },
        "local_classes": local_classes,
        "local_by_key": local_by_key_output,
        "programs": permutation_checks,
        "program0_cycles": cycle_json(&program0_cycles),
        "fresh_anchor_prefixes": prefix_witnesses,
        "bounded_full_replay": full_replay,
        "resource_observation": resource.clone(),
        "not_claimed": [
            "first-slot uniformity",
            "Monte Carlo fairness",
            "old full-model 3306-cycle equivalence",
            "production behavior change",
            "live-device audio outcome"
        ],
    });
    let mut resource = resource;
    let artifact_bytes = serde_json::to_vec_pretty(&artifact)
        .expect("native scoped position artifact should serialize");
    resource["serialized_bytes_before_resource_projection"] = json!(artifact_bytes.len());
    let artifact = {
        let mut artifact = artifact;
        artifact["resource_observation"] = resource.clone();
        artifact
    };
    let artifact_bytes = serde_json::to_vec_pretty(&artifact)
        .expect("native scoped position artifact should serialize after resource update");
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).expect("native scoped position output directory should exist");
    }
    if let Some(parent) = receipt_path.parent() {
        fs::create_dir_all(parent).expect("native scoped position receipt directory should exist");
    }
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).expect("native scoped position log directory should exist");
    }
    fs::write(&output_path, &artifact_bytes).unwrap_or_else(|error| {
        panic!(
            "native scoped position artifact `{}` should be writable: {error}",
            output_path.display()
        )
    });
    write_receipt(
        &receipt_path,
        &output_path,
        &log_path,
        generation,
        &scope_signature,
        EXPECTED_MODEL_CLASSES,
        EXPECTED_MODEL_KEYS,
        materializations.len(),
        native_scope_keys.len(),
        atlas.programs.len(),
        target_global,
        target_local,
        prefix_witnesses.len(),
        &full_replay,
        &resource,
    );
    fs::write(
        &log_path,
        format!(
            "artifact={} receipt={} generation={} scoped_classes={} scoped_keys={} programs={} target_global={} target_local={} formation_ms={} prefix_ms={} full_replay_ms={} output_bytes={}\n",
            output_path.display(),
            receipt_path.display(),
            generation,
            materializations.len(),
            native_scope_keys.len(),
            atlas.programs.len(),
            target_global,
            target_local,
            formation_ms,
            prefix_ms,
            full_replay_ms,
            artifact_bytes.len(),
        ),
    )
    .unwrap_or_else(|error| panic!("native scoped position log `{}` should be writable: {error}", log_path.display()));
}
