use super::{
    AudioStyleSymbolicPlaybackSession, PlaybackTrackKey, read_audio_style_stable_model_for_test,
};
use crate::domain::player::model::PlaybackTrack;
use crate::domain::playlist_playback::symbolic_program::{
    execute_program_list, transport_traversal_state,
};
use rand::{RngExt, SeedableRng, rngs::SmallRng};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
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

const LIKE_BASELINE_DB_INPUT_ENV: &str = "SLISIC_NATIVE_LIKE_BASELINE_DB_INPUT";
const LIKE_BASELINE_MODEL_INPUT_ENV: &str = "SLISIC_NATIVE_LIKE_BASELINE_MODEL_INPUT";
const LIKE_BASELINE_OUTPUT_ENV: &str = "SLISIC_NATIVE_LIKE_BASELINE_OUTPUT";
const LIKE_BASELINE_RECEIPT_ENV: &str = "SLISIC_NATIVE_LIKE_BASELINE_RECEIPT";
const LIKE_BASELINE_LOG_ENV: &str = "SLISIC_NATIVE_LIKE_BASELINE_LOG";
const LIKE_BASELINE_ACTUAL_MC_INPUT_ENV: &str = "SLISIC_NATIVE_TICKET_WINDOW_ACTUAL_MC_INPUT";
const LIKE_BASELINE_DRAW_COUNT_ENV: &str = "SLISIC_NATIVE_TICKET_WINDOW_DRAW_COUNT";
const LIKE_BASELINE_DEFAULT_DRAW_COUNT: usize = 8;
const LIKE_BASELINE_PARALLEL_WIDTH: usize = 14;
const LIKE_BASELINE_SEED_BASE: u64 = 0x51A7_0000;

const LIKE_BASELINE_DEFAULT_OUTPUT: &str = r"C:\Users\admin\ann\outputs\audio_style_trajectory_dynamics\native-ticket-window-219-v7-fixed-64.json";
const LIKE_BASELINE_DEFAULT_RECEIPT: &str = r"C:\Users\admin\ann\outputs\audio_style_trajectory_dynamics\native-ticket-window-219-v7-fixed-64-receipt.md";
const LIKE_BASELINE_DEFAULT_LOG: &str = r"C:\Users\admin\slisic\.tmp\native-ticket-window-219-v7-fixed-64\native-ticket-window-219-v7-fixed-64.log";
const LIKE_BASELINE_DEFAULT_ACTUAL_MC_INPUT: &str = r"C:\Users\admin\ann\outputs\audio_style_trajectory_dynamics\current_model_actual_first_slot_mc-219-v1.json";
const LIKE_BASELINE_DEFAULT_DB_INPUT: &str = DEFAULT_DB_INPUT;
const LIKE_BASELINE_DEFAULT_MODEL_INPUT: &str = DEFAULT_MODEL_INPUT;

const LIKE_BASELINE_EXPECTED_GENERATION: u64 = 163;
const LIKE_BASELINE_EXPECTED_DB_KEYS: usize = 3_420;
const LIKE_BASELINE_EXPECTED_MODEL_KEYS: usize = 3_585;
const LIKE_BASELINE_EXPECTED_MODEL_CLASSES: usize = 3_306;
const LIKE_BASELINE_EXPECTED_DB_ROWS: usize = 3_455;
const LIKE_BASELINE_EXPECTED_DB_LIKED_ROWS: usize = 38;
const LIKE_BASELINE_EXPECTED_MODEL_SHA256: &str =
    "C96FA71CD7C3BBCA81191C2E8BD72956EB2C4329A748D89C5DBA8AC88CC6FAC3";
const LIKE_BASELINE_TARGET_CANONICAL_MUSIC_ID: &str =
    "source:https://www.youtube.com/watch?v=uHcJepz3QW0:0:316213";

#[derive(Debug, Deserialize)]
struct LikeBaselineDbInputDocument {
    independent_scope_check: DbScopeCheck,
    frozen_model: DbFrozenModel,
    music_rows: LikeBaselineMusicRows,
}

#[derive(Debug, Deserialize)]
struct LikeBaselineActualMcInputDocument {
    mc: LikeBaselineActualMcInput,
}

#[derive(Debug, Deserialize)]
struct LikeBaselineActualMcInput {
    keys: Vec<DbTrackKey>,
    probability_vector: Vec<f64>,
    #[serde(default)]
    probability_vector_semantics: Option<String>,
}

#[derive(Debug, Clone)]
struct LikeBaselineActualMcStart {
    source_index: usize,
    key: PlaybackTrackKey,
    probability: f64,
}

#[derive(Debug, Deserialize)]
struct LikeBaselineMusicRows {
    model_canonical_domain: LikeBaselineCanonicalDomain,
}

#[derive(Debug, Deserialize)]
struct LikeBaselineCanonicalDomain {
    rows: Vec<LikeBaselineMusicRow>,
}

#[derive(Debug, Deserialize)]
struct LikeBaselineMusicRow {
    canonical_music_id: String,
    liked: bool,
    db_order: usize,
    url: String,
    path: String,
    start_ms: u32,
    end_ms: u32,
}

#[derive(Debug, Clone)]
struct LikeBaselineCarrier {
    materializations: Arc<Vec<Vec<PlaybackTrack>>>,
    tracks: Arc<Vec<PlaybackTrack>>,
    scope_tracks: Arc<Vec<PlaybackTrack>>,
}

#[derive(Debug, Clone)]
struct LikeBaselineVariantRun {
    order: Vec<PlaybackTrackKey>,
    class_order: Vec<usize>,
    first_proposed: Option<PlaybackTrackKey>,
    target_rank: Option<usize>,
    target_wait_ms: Option<u64>,
    steps: usize,
    draw_seed: u64,
    ticket_epoch: Option<usize>,
    ticket_energies: Option<Vec<f32>>,
    style_sector_departures: usize,
    coverage_epoch_transitions: usize,
    within_cos_sum: f64,
    within_cos_count: usize,
    cross_cos_sum: f64,
    cross_cos_count: usize,
}

#[derive(Debug, Clone)]
struct LikeBaselineControlCheck {
    pending_observation: String,
    rollback_observation: String,
    reproposal_observation: String,
    reproposal_equal: bool,
    rollback_order: Vec<PlaybackTrackKey>,
    direct_order: Vec<PlaybackTrackKey>,
    committed_snapshot_order: Vec<PlaybackTrackKey>,
    reopen_anchor: PlaybackTrackKey,
    rollback_order_equal: bool,
    committed_snapshot_order_equal: bool,
}

fn independent_like_baseline_db_projection(path: &Path) -> (LikeBaselineDbInputDocument, usize) {
    let started = Instant::now();
    let bytes = fs::read(path).unwrap_or_else(|error| {
        panic!(
            "independent Like baseline DB input '{}' should be readable: {error}",
            path.display()
        )
    });
    let document =
        serde_json::from_slice::<LikeBaselineDbInputDocument>(&bytes).unwrap_or_else(|error| {
            panic!(
                "independent Like baseline DB input '{}' should be valid JSON: {error}",
                path.display()
            )
        });
    (document, started.elapsed().as_millis() as usize)
}

fn independent_like_baseline_actual_mc_projection(
    path: &Path,
) -> (LikeBaselineActualMcInputDocument, usize) {
    let started = Instant::now();
    let bytes = fs::read(path).unwrap_or_else(|error| {
        panic!(
            "independent actual-model MC input '{}' should be readable: {error}",
            path.display()
        )
    });
    let document = serde_json::from_slice::<LikeBaselineActualMcInputDocument>(&bytes)
        .unwrap_or_else(|error| {
            panic!(
                "independent actual-model MC input '{}' should be valid JSON: {error}",
                path.display()
            )
        });
    (document, started.elapsed().as_millis() as usize)
}

fn like_baseline_sample_actual_mc_start(
    keys: &[PlaybackTrackKey],
    probability_vector: &[f64],
    draw_seed: u64,
) -> LikeBaselineActualMcStart {
    assert_eq!(
        keys.len(),
        probability_vector.len(),
        "actual-model MC keys and probability vector must have equal length"
    );
    assert!(
        !keys.is_empty(),
        "actual-model MC start distribution must not be empty"
    );
    let total = probability_vector
        .iter()
        .try_fold(0.0_f64, |total, probability| {
            assert!(
                probability.is_finite() && *probability >= 0.0,
                "actual-model MC start probabilities must be finite and nonnegative"
            );
            Some(total + probability)
        })
        .expect("actual-model MC probability sum must be finite");
    assert!(
        total.is_finite() && total > 0.0,
        "actual-model MC start probabilities must have a positive finite sum"
    );

    let mut rng = SmallRng::seed_from_u64(draw_seed);
    let target = rng.random::<f64>() * total;
    let mut cumulative = 0.0_f64;
    let mut selected_index = keys.len() - 1;
    for (index, probability) in probability_vector.iter().copied().enumerate() {
        cumulative += probability;
        if target < cumulative {
            selected_index = index;
            break;
        }
    }
    LikeBaselineActualMcStart {
        source_index: selected_index,
        key: keys[selected_index].clone(),
        probability: probability_vector[selected_index],
    }
}

fn like_baseline_track_with_liked(
    track: &PlaybackTrack,
    liked_by_canonical: &HashMap<String, bool>,
    like_on: bool,
) -> PlaybackTrack {
    let mut adjusted = track.clone();
    adjusted.liked = if like_on {
        *liked_by_canonical
            .get(&adjusted.canonical_music_id)
            .unwrap_or_else(|| {
                panic!(
                    "DB Like authority is missing canonical music id '{}'",
                    adjusted.canonical_music_id
                )
            })
    } else {
        false
    };
    adjusted
}

fn like_baseline_carrier(
    formed: &AudioStyleSymbolicPlaybackSession,
    scope_tracks: &[PlaybackTrack],
    liked_by_canonical: &HashMap<String, bool>,
    like_on: bool,
) -> LikeBaselineCarrier {
    let execution = formed
        .execution
        .as_ref()
        .expect("formed native execution must remain available for Like counterfactuals");
    LikeBaselineCarrier {
        materializations: Arc::new(
            execution
                .materializations
                .iter()
                .map(|members| {
                    members
                        .iter()
                        .map(|track| {
                            like_baseline_track_with_liked(track, liked_by_canonical, like_on)
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>(),
        ),
        tracks: Arc::new(
            execution
                .tracks
                .iter()
                .map(|track| like_baseline_track_with_liked(track, liked_by_canonical, like_on))
                .collect::<Vec<_>>(),
        ),
        scope_tracks: Arc::new(
            scope_tracks
                .iter()
                .map(|track| like_baseline_track_with_liked(track, liked_by_canonical, like_on))
                .collect::<Vec<_>>(),
        ),
    }
}

fn like_baseline_cached_session(
    formed: &AudioStyleSymbolicPlaybackSession,
    carrier: &LikeBaselineCarrier,
    anchor_key: &PlaybackTrackKey,
) -> AudioStyleSymbolicPlaybackSession {
    let mut session = formed.committed_snapshot();
    let execution = session
        .execution
        .as_mut()
        .expect("formed native execution must be cloneable for a cached Like session");
    let anchor_local = *execution
        .local_by_key
        .get(anchor_key)
        .expect("Like baseline anchor must belong to the formed native scope");
    execution.state = transport_traversal_state(
        None,
        execution.atlas.as_ref(),
        &[anchor_local],
        &[vec![anchor_local]],
    )
    .expect("anchor-only traversal state must transport into the formed native atlas");
    execution.materializations = Arc::clone(&carrier.materializations);
    execution.tracks = Arc::clone(&carrier.tracks);
    session.pending_checkpoint = None;
    session.scope_revision = None;
    session.scope_dirty = false;
    // A formed fixture may already have consumed its first proposal and therefore
    // carry the production epoch tickets.  Each independent MC draw owns a fresh
    // test session and must regenerate tickets after its per-draw RNG seed; the
    // production checkpoint/reanchor retention path remains unchanged.
    session.clear_opportunity_tickets_for_test();
    session
}

fn like_baseline_variant_run(
    snapshot: &super::AudioStyleModelSnapshot,
    formed: &AudioStyleSymbolicPlaybackSession,
    carrier: &LikeBaselineCarrier,
    anchor_key: &PlaybackTrackKey,
    target_key: &PlaybackTrackKey,
    draw_seed: u64,
    variant_name: &str,
) -> LikeBaselineVariantRun {
    let mut session = like_baseline_cached_session(formed, carrier, anchor_key);
    session.set_rng_seed_for_test(draw_seed);
    let anchor_local = *session
        .execution
        .as_ref()
        .expect("cached Like session must retain execution")
        .local_by_key
        .get(anchor_key)
        .expect("cached Like session anchor must remain addressable");
    let mut current = carrier
        .materializations
        .get(anchor_local)
        .and_then(|members| {
            members
                .iter()
                .find(|track| PlaybackTrackKey::from_track(track) == *anchor_key)
        })
        .cloned()
        .expect("cached Like session must retain the exact sampled anchor member");
    let class_count = session
        .execution
        .as_ref()
        .expect("cached Like session must retain execution")
        .atlas
        .track_count;
    let mut order = Vec::new();
    let mut class_order = Vec::with_capacity(class_count.saturating_sub(1));
    let mut seen_classes = BTreeSet::new();
    assert!(
        seen_classes.insert(anchor_local),
        "the exact sampled anchor class must be the first class in the native pass"
    );
    let mut first_proposed = None;
    let mut target_rank = (*anchor_key == *target_key).then_some(0);
    let mut target_wait_ms = (*anchor_key == *target_key).then_some(0);
    let mut ticket_epoch = None;
    let mut ticket_energies = None;
    let mut waited_ms = 0_u64;
    let mut style_sector_departures = 0_usize;
    let mut coverage_epoch_transitions = 0_usize;
    let mut within_cos_sum = 0.0_f64;
    let mut within_cos_count = 0_usize;
    let mut cross_cos_sum = 0.0_f64;
    let mut cross_cos_count = 0_usize;

    for step in 0..class_count.saturating_sub(1) {
        let next = session
            .propose_next(snapshot, &current, carrier.scope_tracks.as_ref(), &[])
            .unwrap_or_else(|error| {
                panic!(
                    "{variant_name} cached Like proposal failed at anchor local {anchor_local}, step {}: {error}",
                    step + 1
                )
            });
        let current_tickets = session
            .opportunity_ticket_snapshot_for_test()
            .map(|(epoch, _, energies)| (epoch, energies));
        if let Some((epoch, energies)) = current_tickets {
            match (&ticket_epoch, &ticket_energies) {
                (Some(expected_epoch), Some(expected_energies)) => {
                    assert_eq!(
                        *expected_epoch, epoch,
                        "{variant_name} ticket epoch must remain stable within a replay"
                    );
                    assert_eq!(
                        *expected_energies, energies,
                        "{variant_name} ticket energies must remain stable within a replay"
                    );
                }
                _ => {
                    ticket_epoch = Some(epoch);
                    ticket_energies = Some(energies);
                }
            }
        }
        let outcome = session
            .observe_active_track(&next.track)
            .unwrap_or_else(|error| {
                panic!(
                    "{variant_name} cached Like commit failed at anchor local {anchor_local}, step {}: {error}",
                    step + 1
                )
            });
        assert_eq!(
            outcome,
            super::AudioStyleSymbolicPendingObservationOutcome::Committed,
            "{variant_name} proposal must commit through the real active-track observer"
        );
        let key = PlaybackTrackKey::from_track(&next.track);
        if first_proposed.is_none() {
            first_proposed = Some(key.clone());
        }
        let current_key = PlaybackTrackKey::from_track(&current);
        let next_local = *session
            .execution
            .as_ref()
            .expect("cached Like session must retain execution")
            .local_by_key
            .get(&key)
            .expect("every committed native pass member must remain class-addressable");
        assert!(
            seen_classes.insert(next_local),
            "native first pass must not duplicate class local {next_local}"
        );
        class_order.push(next_local);
        if let Some(similarity) = session.opportunity_similarity_for_test(&current_key, &key) {
            let current_local = *session
                .execution
                .as_ref()
                .expect("cached Like session must retain execution")
                .local_by_key
                .get(&current_key)
                .expect("the current exact sampled member must remain class-addressable");
            if session.acoustic_basin_for_test(current_local)
                == session.acoustic_basin_for_test(next_local)
            {
                within_cos_sum += f64::from(similarity);
                within_cos_count += 1;
            } else {
                cross_cos_sum += f64::from(similarity);
                cross_cos_count += 1;
            }
        }
        if target_rank.is_none() && key == *target_key {
            target_rank = Some(step + 1);
            target_wait_ms = Some(waited_ms);
        }
        style_sector_departures += usize::from(next.style_sector_departure);
        coverage_epoch_transitions += usize::from(next.coverage_epoch_transition);
        waited_ms = waited_ms.saturating_add(u64::from(
            next.track.end_ms.saturating_sub(next.track.start_ms),
        ));
        order.push(key);
        current = next.track;
    }
    assert_eq!(
        seen_classes.len(),
        class_count,
        "native replay must complete exactly one full class pass without crossing an epoch"
    );
    assert_eq!(
        order.len(),
        class_count.saturating_sub(1),
        "native full first pass starts with the sampled anchor at position zero"
    );

    LikeBaselineVariantRun {
        steps: order.len(),
        class_order,
        first_proposed,
        target_rank,
        target_wait_ms,
        order,
        draw_seed,
        ticket_epoch,
        ticket_energies,
        style_sector_departures,
        coverage_epoch_transitions,
        within_cos_sum,
        within_cos_count,
        cross_cos_sum,
        cross_cos_count,
    }
}

fn like_baseline_propose_and_commit(
    snapshot: &super::AudioStyleModelSnapshot,
    session: &mut AudioStyleSymbolicPlaybackSession,
    current: &PlaybackTrack,
    carrier: &LikeBaselineCarrier,
    context: &str,
) -> PlaybackTrack {
    let next = session
        .propose_next(snapshot, current, carrier.scope_tracks.as_ref(), &[])
        .unwrap_or_else(|error| panic!("{context} Like proposal failed: {error}"));
    let outcome = session
        .observe_active_track(&next.track)
        .unwrap_or_else(|error| panic!("{context} Like proposal observation failed: {error}"));
    assert_eq!(
        outcome,
        super::AudioStyleSymbolicPendingObservationOutcome::Committed,
        "{context} Like proposal must commit through the real active-track observer"
    );
    next.track
}

fn like_baseline_control_check(
    snapshot: &super::AudioStyleModelSnapshot,
    formed: &AudioStyleSymbolicPlaybackSession,
    carrier: &LikeBaselineCarrier,
    anchor_key: &PlaybackTrackKey,
) -> LikeBaselineControlCheck {
    let anchor_local = *formed
        .execution
        .as_ref()
        .expect("control anchor must have formed execution")
        .local_by_key
        .get(anchor_key)
        .expect("control anchor must belong to formed native scope");
    let anchor_track = carrier
        .tracks
        .get(anchor_local)
        .cloned()
        .expect("control anchor must have a representative track");

    let mut direct = like_baseline_cached_session(formed, carrier, anchor_key);
    let first_direct = like_baseline_propose_and_commit(
        snapshot,
        &mut direct,
        &anchor_track,
        carrier,
        "direct control first",
    );
    let second_direct = like_baseline_propose_and_commit(
        snapshot,
        &mut direct,
        &first_direct,
        carrier,
        "direct control second",
    );
    let direct_order = vec![
        PlaybackTrackKey::from_track(&first_direct),
        PlaybackTrackKey::from_track(&second_direct),
    ];

    let mut rollback = like_baseline_cached_session(formed, carrier, anchor_key);
    let first_pending = rollback
        .propose_next(snapshot, &anchor_track, carrier.scope_tracks.as_ref(), &[])
        .expect("pending rollback control proposal must succeed");
    let pending_observation = rollback
        .observe_active_track(&anchor_track)
        .expect("active anchor observation must remain pending");
    let proposed_key = PlaybackTrackKey::from_track(&first_pending.track);
    let wrong_track = carrier
        .scope_tracks
        .iter()
        .find(|track| {
            let key = PlaybackTrackKey::from_track(track);
            key != *anchor_key && key != proposed_key
        })
        .cloned()
        .expect("rollback control needs a distinct real scope track");
    let rollback_observation = rollback
        .observe_active_track(&wrong_track)
        .expect("wrong active track must be observable as a rollback");
    let reproposed = like_baseline_propose_and_commit(
        snapshot,
        &mut rollback,
        &anchor_track,
        carrier,
        "rollback/reproposal first",
    );
    let reproposed_second = like_baseline_propose_and_commit(
        snapshot,
        &mut rollback,
        &reproposed,
        carrier,
        "rollback/reproposal second",
    );
    let rollback_order = vec![
        PlaybackTrackKey::from_track(&reproposed),
        PlaybackTrackKey::from_track(&reproposed_second),
    ];

    let mut before_snapshot = like_baseline_cached_session(formed, carrier, anchor_key);
    let first_snapshot = like_baseline_propose_and_commit(
        snapshot,
        &mut before_snapshot,
        &anchor_track,
        carrier,
        "committed snapshot first",
    );
    let committed = before_snapshot.committed_snapshot();
    let reopen_anchor = committed
        .committed_planning_anchor()
        .expect("committed snapshot must retain a planning anchor");
    let mut reopened = committed.committed_snapshot();
    let second_snapshot = like_baseline_propose_and_commit(
        snapshot,
        &mut reopened,
        &reopen_anchor,
        carrier,
        "committed snapshot reopen",
    );
    let committed_snapshot_order = vec![
        PlaybackTrackKey::from_track(&first_snapshot),
        PlaybackTrackKey::from_track(&second_snapshot),
    ];

    LikeBaselineControlCheck {
        pending_observation: format!("{pending_observation:?}"),
        rollback_observation: format!("{rollback_observation:?}"),
        reproposal_observation: "Committed".to_string(),
        reproposal_equal: PlaybackTrackKey::from_track(&first_pending.track)
            == PlaybackTrackKey::from_track(&reproposed),
        rollback_order_equal: direct_order == rollback_order,
        committed_snapshot_order_equal: direct_order == committed_snapshot_order,
        rollback_order,
        direct_order,
        committed_snapshot_order,
        reopen_anchor: PlaybackTrackKey::from_track(&reopen_anchor),
    }
}

fn like_baseline_variant_json(run: &LikeBaselineVariantRun) -> Value {
    let ticket_fingerprint = run.ticket_energies.as_deref().map(ticket_fingerprint);
    let ticket_sample = run.ticket_energies.as_deref().map(|energies| {
        energies
            .iter()
            .take(4)
            .copied()
            .chain(energies.iter().rev().take(4).copied())
            .collect::<Vec<_>>()
    });
    json!({
        "steps_until_target_or_one_class_pass": run.steps,
        "first_proposed_track_key": run.first_proposed.as_ref().map(json_key),
        "target_rank": run.target_rank,
        "target_wait_ms": run.target_wait_ms,
        "target_wait_hours": run.target_wait_ms.map(|wait_ms| wait_ms as f64 / 3_600_000.0),
        "draw_seed": run.draw_seed,
        "ticket_epoch": run.ticket_epoch,
        "ticket_count": run.ticket_energies.as_ref().map(Vec::len),
        "ticket_fingerprint_fnv1a64": ticket_fingerprint,
        "ticket_energy_sample": ticket_sample,
        "target_rank_semantics": "inclusive: 0 is the anchor itself; positive values count committed proposals after the anchor",
        "class_count_in_full_first_pass": run.class_order.len().saturating_add(1),
        "class_order": &run.class_order,
        "style_sector_departures": run.style_sector_departures,
        "coverage_epoch_transitions": run.coverage_epoch_transitions,
        "within_cos_mean": (run.within_cos_count > 0)
            .then(|| run.within_cos_sum / run.within_cos_count as f64),
        "within_cos_count": run.within_cos_count,
        "cross_cos_mean": (run.cross_cos_count > 0)
            .then(|| run.cross_cos_sum / run.cross_cos_count as f64),
        "cross_cos_count": run.cross_cos_count,
    })
}

fn ticket_fingerprint(energies: &[f32]) -> u64 {
    energies
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, energy| {
            let mut hash = hash ^ u64::from(energy.to_bits());
            hash = hash.wrapping_mul(0x1000_0000_01b3);
            hash ^ (hash >> 32)
        })
}

fn like_baseline_wait_summary(values: &[u64]) -> Value {
    assert!(
        !values.is_empty(),
        "actual-model MC wait summary needs samples"
    );
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let p90_index = ((sorted.len() as f64 * 0.90).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    let mean_ms = values.iter().map(|value| *value as f64).sum::<f64>() / values.len() as f64;
    let at_or_below_8h = values
        .iter()
        .filter(|value| **value <= 8 * 3_600_000)
        .count();
    let at_or_below_24h = values
        .iter()
        .filter(|value| **value <= 24 * 3_600_000)
        .count();
    json!({
        "sample_count": values.len(),
        "mean_wait_ms": mean_ms,
        "mean_wait_hours": mean_ms / 3_600_000.0,
        "p90_wait_ms": sorted[p90_index],
        "p90_wait_hours": sorted[p90_index] as f64 / 3_600_000.0,
        "at_or_below_8h": at_or_below_8h,
        "at_or_below_24h": at_or_below_24h,
    })
}

fn like_baseline_rank_summary(
    rank_sum: &[f64],
    rank_square_sum: &[f64],
    draw_count: usize,
) -> Value {
    assert!(draw_count > 0, "actual-model MC rank summary needs samples");
    assert_eq!(rank_sum.len(), rank_square_sum.len());
    let draw_count = draw_count as f64;
    let means = rank_sum
        .iter()
        .map(|sum| *sum / draw_count)
        .collect::<Vec<_>>();
    let mean_rank = means.iter().sum::<f64>() / means.len().max(1) as f64;
    let rank_mean_dispersion = (means
        .iter()
        .map(|mean| (mean - mean_rank).powi(2))
        .sum::<f64>()
        / means.len().max(1) as f64)
        .sqrt();
    let rank_noise_estimate = (rank_sum
        .iter()
        .zip(rank_square_sum)
        .map(|(sum, square_sum)| {
            ((*square_sum / draw_count) - (*sum / draw_count).powi(2)).max(0.0)
        })
        .sum::<f64>()
        / rank_sum.len().max(1) as f64)
        .sqrt();
    let rank_mean_sample = means
        .iter()
        .take(4)
        .copied()
        .chain(means.iter().rev().take(4).copied())
        .collect::<Vec<_>>();
    json!({
        "class_count": rank_sum.len(),
        "draw_count": draw_count as usize,
        "mean_rank": mean_rank,
        "rank_mean_dispersion": rank_mean_dispersion,
        "rank_noise_estimate": rank_noise_estimate,
        "rank_mean_sample_first_last": rank_mean_sample,
    })
}

fn like_baseline_geometry_summary(
    within_sum: f64,
    within_count: usize,
    cross_sum: f64,
    cross_count: usize,
) -> Value {
    json!({
        "within_count": within_count,
        "within_cos_mean": (within_count > 0).then(|| within_sum / within_count as f64),
        "cross_count": cross_count,
        "cross_cos_mean": (cross_count > 0).then(|| cross_sum / cross_count as f64),
    })
}

fn like_baseline_control_json(control: &LikeBaselineControlCheck) -> Value {
    json!({
        "pending_observation": control.pending_observation,
        "rollback_observation": control.rollback_observation,
        "reproposal_observation": control.reproposal_observation,
        "reproposal_equal": control.reproposal_equal,
        "direct_order": control.direct_order.iter().map(json_key).collect::<Vec<_>>(),
        "rollback_order": control.rollback_order.iter().map(json_key).collect::<Vec<_>>(),
        "committed_snapshot_order": control
            .committed_snapshot_order
            .iter()
            .map(json_key)
            .collect::<Vec<_>>(),
        "reopen_anchor": json_key(&control.reopen_anchor),
        "rollback_order_equal": control.rollback_order_equal,
        "committed_snapshot_order_equal": control.committed_snapshot_order_equal,
    })
}

fn like_baseline_receipt_anchor_summary(rows: &[Value]) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| {
                let control = row
                    .get("session_control")
                    .filter(|value| !value.is_null())
                    .map(|value| {
                        json!({
                            "pending_observation": value["pending_observation"].clone(),
                            "rollback_observation": value["rollback_observation"].clone(),
                            "reproposal_observation": value["reproposal_observation"].clone(),
                            "reproposal_equal": value["reproposal_equal"].clone(),
                            "rollback_order_equal": value["rollback_order_equal"].clone(),
                            "committed_snapshot_order_equal": value["committed_snapshot_order_equal"].clone(),
                        })
                });
                json!({
                    "draw_index": row["draw_index"].clone(),
                    "sampled_source_index": row["sampled_source_index"].clone(),
                    "sampled_probability": row["sampled_probability"].clone(),
                    "anchor_local": row["anchor_local"].clone(),
                    "anchor_is_target": row["anchor_is_target"].clone(),
                    "anchor_is_db_family_control": row["anchor_is_db_family_control"].clone(),
                    "like_on_target_rank": row["like_on"]["target_rank"].clone(),
                    "like_off_target_rank": row["like_off"]["target_rank"].clone(),
                    "like_on_steps_until_target_or_one_class_pass": row["like_on"]["steps_until_target_or_one_class_pass"].clone(),
                    "like_off_steps_until_target_or_one_class_pass": row["like_off"]["steps_until_target_or_one_class_pass"].clone(),
                    "target_rank_semantics": row["like_on"]["target_rank_semantics"].clone(),
                    "order_equal": row["order_equal"].clone(),
                    "target_rank_equal": row["target_rank_equal"].clone(),
                    "session_control": control,
                })
            })
            .collect(),
    )
}

fn like_baseline_row_json(row: &LikeBaselineMusicRow) -> Value {
    json!({
        "canonical_music_id": row.canonical_music_id,
        "liked": row.liked,
        "db_order": row.db_order,
        "url": row.url,
        "path": row.path,
        "start_ms": row.start_ms,
        "end_ms": row.end_ms,
    })
}

#[test]
#[ignore = "actual-model native ticket-window replay; opt in after bounded calibration"]
fn native_scoped_position_ticket_window_generation163_scope3420() {
    const TARGET_URL: &str = "https://www.youtube.com/watch?v=uHcJepz3QW0";
    const TARGET_FILE_PATH: &str = r"C:\Users\admin\Documents\slisic\youtube/Death Stranding 2- On the Beach – All Official Soundtracks\Minus Sixty One.m4a";
    const TARGET_START_MS: u32 = 0;
    const TARGET_END_MS: u32 = 316_213;

    let db_path = path_from_env(LIKE_BASELINE_DB_INPUT_ENV, LIKE_BASELINE_DEFAULT_DB_INPUT);
    let model_path = path_from_env(
        LIKE_BASELINE_MODEL_INPUT_ENV,
        LIKE_BASELINE_DEFAULT_MODEL_INPUT,
    );
    let output_path = path_from_env(LIKE_BASELINE_OUTPUT_ENV, LIKE_BASELINE_DEFAULT_OUTPUT);
    let receipt_path = path_from_env(LIKE_BASELINE_RECEIPT_ENV, LIKE_BASELINE_DEFAULT_RECEIPT);
    let log_path = path_from_env(LIKE_BASELINE_LOG_ENV, LIKE_BASELINE_DEFAULT_LOG);
    let actual_mc_path = path_from_env(
        LIKE_BASELINE_ACTUAL_MC_INPUT_ENV,
        LIKE_BASELINE_DEFAULT_ACTUAL_MC_INPUT,
    );
    assert!(
        db_path.is_file(),
        "Like baseline DB input must exist: {}",
        db_path.display()
    );
    assert!(
        model_path.is_file(),
        "Like baseline stable model input must exist: {}",
        model_path.display()
    );
    assert!(
        actual_mc_path.is_file(),
        "actual-model MC input must exist: {}",
        actual_mc_path.display()
    );

    let (db, db_projection_ms) = independent_like_baseline_db_projection(&db_path);
    let (actual_mc, actual_mc_projection_ms) =
        independent_like_baseline_actual_mc_projection(&actual_mc_path);
    assert_eq!(
        actual_mc.mc.keys.len(),
        LIKE_BASELINE_EXPECTED_DB_KEYS,
        "actual-model MC input must cover the complete admitted DB key domain"
    );
    assert_eq!(
        actual_mc.mc.probability_vector.len(),
        actual_mc.mc.keys.len(),
        "actual-model MC probability vector must cover every admitted key"
    );
    assert_eq!(
        db.music_rows.model_canonical_domain.rows.len(),
        LIKE_BASELINE_EXPECTED_DB_ROWS,
        "Like authority must come from the complete canonical DB row family"
    );
    let scope = &db.independent_scope_check;
    assert!(
        scope.equal,
        "independent DB scope equality receipt must be true"
    );
    assert_eq!(scope.expected_key_count, LIKE_BASELINE_EXPECTED_DB_KEYS);
    assert_eq!(scope.admitted_key_count, LIKE_BASELINE_EXPECTED_DB_KEYS);
    let expected_keys = scope.expected_keys.iter().cloned().collect::<BTreeSet<_>>();
    let admitted_keys = scope.admitted_keys.iter().cloned().collect::<BTreeSet<_>>();
    assert_eq!(expected_keys, admitted_keys);
    let actual_mc_key_set = actual_mc.mc.keys.iter().cloned().collect::<BTreeSet<_>>();
    assert_eq!(
        actual_mc_key_set, expected_keys,
        "actual-model MC keys must equal the independent admitted DB key set"
    );
    let actual_mc_native_keys = actual_mc
        .mc
        .keys
        .iter()
        .map(DbTrackKey::to_native)
        .collect::<Vec<_>>();
    let actual_mc_probability_vector = actual_mc.mc.probability_vector.clone();

    let mut liked_by_canonical =
        HashMap::<String, bool>::with_capacity(db.music_rows.model_canonical_domain.rows.len());
    for row in &db.music_rows.model_canonical_domain.rows {
        if let Some(previous) = liked_by_canonical.insert(row.canonical_music_id.clone(), row.liked)
        {
            assert_eq!(
                previous, row.liked,
                "duplicate DB canonical rows must agree on their liked value"
            );
        }
    }
    let db_liked_rows = db
        .music_rows
        .model_canonical_domain
        .rows
        .iter()
        .filter(|row| row.liked)
        .collect::<Vec<_>>();
    assert_eq!(
        db_liked_rows.len(),
        LIKE_BASELINE_EXPECTED_DB_LIKED_ROWS,
        "DB Like authority row count must remain current"
    );

    let target_key = DbTrackKey {
        music_url: TARGET_URL.to_string(),
        file_path: TARGET_FILE_PATH.to_string(),
        start_ms: TARGET_START_MS,
        end_ms: TARGET_END_MS,
    };
    assert!(expected_keys.contains(&target_key));
    let target_native_key = target_key.to_native();
    let target_row = db
        .music_rows
        .model_canonical_domain
        .rows
        .iter()
        .find(|row| row.canonical_music_id == LIKE_BASELINE_TARGET_CANONICAL_MUSIC_ID)
        .expect("DB Like authority must contain the named target canonical row");
    assert!(
        target_row.liked,
        "the named target must be liked in DB authority"
    );
    assert_eq!(target_row.url, TARGET_URL);
    assert_eq!(target_row.start_ms, TARGET_START_MS);
    assert_eq!(target_row.end_ms, TARGET_END_MS);
    assert!(
        target_key.file_path.ends_with(target_row.path.as_str()),
        "target DB path must identify the target scope key"
    );

    let model_size_bytes = fs::metadata(&model_path)
        .expect("Like baseline model metadata should be readable")
        .len() as usize;
    assert_eq!(model_size_bytes, db.frozen_model.size_bytes);
    assert_eq!(
        db.frozen_model.generation,
        LIKE_BASELINE_EXPECTED_GENERATION
    );
    assert_eq!(
        db.frozen_model.indexed_track_count,
        LIKE_BASELINE_EXPECTED_MODEL_KEYS
    );
    assert_eq!(
        db.frozen_model.indexed_unique_key_count,
        LIKE_BASELINE_EXPECTED_MODEL_KEYS
    );
    assert!(
        db.frozen_model
            .sha256
            .eq_ignore_ascii_case(LIKE_BASELINE_EXPECTED_MODEL_SHA256),
        "stable model SHA-256 must match the authoritative predecessor receipt"
    );

    let model_started = Instant::now();
    let snapshot = read_audio_style_stable_model_for_test(&model_path)
        .expect("production stable loader must read the frozen generation-163 model");
    let model_loader_ms = model_started.elapsed().as_millis() as usize;
    assert_eq!(snapshot.generation(), LIKE_BASELINE_EXPECTED_GENERATION);
    let encoding = snapshot
        .state
        .symbolic_program_encoding
        .as_deref()
        .expect("generation-163 model must expose executable symbolic encoding");
    assert_eq!(
        encoding.ordered_keys.len(),
        LIKE_BASELINE_EXPECTED_MODEL_CLASSES
    );
    assert_eq!(
        encoding.member_keys.len(),
        LIKE_BASELINE_EXPECTED_MODEL_CLASSES
    );
    assert_eq!(
        encoding.track_keys.len(),
        LIKE_BASELINE_EXPECTED_MODEL_CLASSES
    );
    assert_eq!(
        encoding.ordinal_by_key.len(),
        LIKE_BASELINE_EXPECTED_MODEL_KEYS
    );
    assert_eq!(
        snapshot.state.indexed_tracks.len(),
        LIKE_BASELINE_EXPECTED_MODEL_KEYS
    );

    let mut model_tracks = HashMap::<PlaybackTrackKey, PlaybackTrack>::with_capacity(
        LIKE_BASELINE_EXPECTED_MODEL_KEYS,
    );
    for indexed in snapshot.state.indexed_tracks.values() {
        let key = PlaybackTrackKey::from_track(&indexed.track);
        assert!(
            model_tracks.insert(key, indexed.track.clone()).is_none(),
            "frozen model indexed tracks must have unique concrete keys"
        );
    }
    assert_eq!(model_tracks.len(), LIKE_BASELINE_EXPECTED_MODEL_KEYS);
    let target_before_overlay = model_tracks
        .get(&target_native_key)
        .cloned()
        .expect("the named target must have frozen model track metadata");
    assert_eq!(
        target_before_overlay.canonical_music_id,
        LIKE_BASELINE_TARGET_CANONICAL_MUSIC_ID
    );
    let scope_tracks_before_overlay = expected_keys
        .iter()
        .map(|key| {
            model_tracks
                .get(&key.to_native())
                .cloned()
                .unwrap_or_else(|| panic!("DB-authorized key missing from frozen model: {key:?}"))
        })
        .collect::<Vec<_>>();
    for track in &scope_tracks_before_overlay {
        assert!(
            liked_by_canonical.contains_key(&track.canonical_music_id),
            "DB Like authority must cover every scoped concrete track"
        );
    }
    let model_scope_liked_count = scope_tracks_before_overlay
        .iter()
        .filter(|track| track.liked)
        .count();
    let scope_tracks = scope_tracks_before_overlay
        .iter()
        .map(|track| like_baseline_track_with_liked(track, &liked_by_canonical, true))
        .collect::<Vec<_>>();
    let db_scope_liked_count = scope_tracks.iter().filter(|track| track.liked).count();
    let overlay_changed_count = scope_tracks_before_overlay
        .iter()
        .zip(scope_tracks.iter())
        .filter(|(before, after)| before.liked != after.liked)
        .count();
    let target = like_baseline_track_with_liked(&target_before_overlay, &liked_by_canonical, true);
    assert!(target.liked);

    let formation_started = Instant::now();
    let mut session = AudioStyleSymbolicPlaybackSession::default();
    let first = session
        .propose_next(&snapshot, &target, &scope_tracks, &[])
        .expect("actual native Like-on scope formation and first proposal must succeed");
    let first_observation = session
        .observe_active_track(&first.track)
        .expect("actual native first proposal must be observed and committed");
    assert_eq!(
        first_observation,
        super::AudioStyleSymbolicPendingObservationOutcome::Committed
    );
    let formation_ms = formation_started.elapsed().as_millis() as usize;
    let formed = session.committed_snapshot();
    let execution = formed
        .execution
        .as_ref()
        .expect("one real propose_next must retain its formed execution carrier");
    let (
        projection_arc,
        projection_centered_vector_count,
        projection_dimensions,
        projection_vector_bytes,
        projection_indexed_candidates,
    ) = formed
        .opportunity_projection_snapshot_for_test()
        .expect("formed native scope must retain its immutable opportunity projection");
    assert_eq!(execution.generation, LIKE_BASELINE_EXPECTED_GENERATION);
    let scope_signature = execution.scope_signature.clone();
    let native_scope_keys = execution
        .materializations
        .iter()
        .flat_map(|members| {
            members
                .iter()
                .map(|track| db_key(&PlaybackTrackKey::from_track(track)))
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(native_scope_keys, expected_keys);
    assert_eq!(native_scope_keys.len(), LIKE_BASELINE_EXPECTED_DB_KEYS);
    assert!(!execution.atlas.programs.is_empty());

    let target_local = execution
        .local_by_key
        .get(&target_native_key)
        .copied()
        .expect("target must remain addressable in the formed native scope");
    let scope_canonical_ids = scope_tracks
        .iter()
        .map(|track| track.canonical_music_id.clone())
        .collect::<BTreeSet<_>>();
    let family_row = db
        .music_rows
        .model_canonical_domain
        .rows
        .iter()
        .filter(|row| {
            row.liked
                && row.canonical_music_id != target_row.canonical_music_id
                && scope_canonical_ids.contains(&row.canonical_music_id)
        })
        .min_by_key(|row| {
            (
                row.db_order.abs_diff(target_row.db_order),
                row.db_order,
                row.canonical_music_id.clone(),
            )
        })
        .expect("DB authority must provide an adjacent liked in-scope family control");
    let family_track = scope_tracks
        .iter()
        .find(|track| track.canonical_music_id == family_row.canonical_music_id)
        .cloned()
        .expect("mechanically selected DB family control must be materialized");
    let family_key = PlaybackTrackKey::from_track(&family_track);
    let family_local = execution
        .local_by_key
        .get(&family_key)
        .copied()
        .expect("mechanically selected DB family control must be native-addressable");

    let mut anchor_keys = vec![target_native_key.clone()];
    for local in [
        0,
        execution.materializations.len() / 2,
        execution.materializations.len().saturating_sub(1),
    ] {
        if local >= execution.materializations.len() {
            continue;
        }
        let key = PlaybackTrackKey::from_track(
            execution.materializations[local]
                .first()
                .expect("native anchor class must be nonempty"),
        );
        if !anchor_keys.contains(&key) {
            anchor_keys.push(key);
        }
    }
    let target_region_neighbor_local = if target_local + 1 < execution.materializations.len() {
        target_local + 1
    } else {
        target_local.saturating_sub(1)
    };
    let target_region_neighbor_key = PlaybackTrackKey::from_track(
        execution.materializations[target_region_neighbor_local]
            .first()
            .expect("target region neighbor class must be nonempty"),
    );
    if !anchor_keys.contains(&target_region_neighbor_key) {
        anchor_keys.push(target_region_neighbor_key);
    }
    if !anchor_keys.contains(&family_key) {
        anchor_keys.push(family_key.clone());
    }
    assert!(
        anchor_keys.len() >= 4,
        "Like baseline needs several real anchors"
    );

    let like_on = like_baseline_carrier(&formed, &scope_tracks, &liked_by_canonical, true);
    let like_off = like_baseline_carrier(&formed, &scope_tracks, &liked_by_canonical, false);
    let draw_count = like_baseline_draw_count();
    let job_count = draw_count;
    let jobs = Arc::new(Mutex::new((0..job_count).rev().collect::<Vec<_>>()));
    let results = Arc::new(Mutex::new(Vec::<(
        usize,
        LikeBaselineActualMcStart,
        LikeBaselineVariantRun,
        LikeBaselineVariantRun,
    )>::with_capacity(job_count)));
    let replay_started = Instant::now();
    let worker_count = LIKE_BASELINE_PARALLEL_WIDTH.min(job_count.max(1));
    let snapshot_ref = &snapshot;
    let formed_ref = &formed;
    let like_on_ref = &like_on;
    let like_off_ref = &like_off;
    let target_native_key_ref = &target_native_key;
    let actual_mc_native_keys_ref = &actual_mc_native_keys;
    let actual_mc_probability_vector_ref = &actual_mc_probability_vector;
    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            let jobs = Arc::clone(&jobs);
            let results = Arc::clone(&results);
            scope.spawn(move || {
                loop {
                    let Some(job_index) = jobs
                        .lock()
                        .expect("Like ticket-window job queue must remain healthy")
                        .pop()
                    else {
                        break;
                    };
                    let draw_index = job_index;
                    let draw_seed = LIKE_BASELINE_SEED_BASE.wrapping_add(draw_index as u64);
                    let sampled_start = like_baseline_sample_actual_mc_start(
                        actual_mc_native_keys_ref,
                        actual_mc_probability_vector_ref,
                        draw_seed,
                    );
                    let anchor_key = &sampled_start.key;
                    let on_run = like_baseline_variant_run(
                        snapshot_ref,
                        formed_ref,
                        like_on_ref,
                        anchor_key,
                        target_native_key_ref,
                        draw_seed,
                        "LikeOn",
                    );
                    let off_run = like_baseline_variant_run(
                        snapshot_ref,
                        formed_ref,
                        like_off_ref,
                        anchor_key,
                        target_native_key_ref,
                        draw_seed,
                        "LikeOff",
                    );
                    results
                        .lock()
                        .expect("Like ticket-window results must remain healthy")
                        .push((job_index, sampled_start, on_run, off_run));
                }
            });
        }
    });
    let replay_elapsed = replay_started.elapsed();
    let mut paired_runs = Arc::try_unwrap(results)
        .expect("Like ticket-window workers must release their result handles")
        .into_inner()
        .expect("Like ticket-window results must remain healthy");
    paired_runs.sort_by_key(|(job_index, _, _, _)| *job_index);

    let mut anchor_rows = Vec::with_capacity(job_count);
    let mut all_orders_equal = true;
    let mut all_targets_reached = true;
    let mut all_target_ranks_equal = true;
    let mut all_ticket_pairs_equal = true;
    let mut like_effect_observed = false;
    let mut all_like_on_full_first_passes = true;
    let mut all_like_off_full_first_passes = true;
    let mut cached_proposal_count = 0_usize;
    let mut ticket_vectors_by_draw = BTreeMap::<usize, Vec<f32>>::new();
    let class_count = execution.atlas.track_count;
    let mut target_wait_like_on = Vec::<u64>::with_capacity(job_count);
    let mut target_wait_like_off = Vec::<u64>::with_capacity(job_count);
    let mut rank_sum_like_on = vec![0.0_f64; class_count];
    let mut rank_sum_like_off = vec![0.0_f64; class_count];
    let mut rank_square_sum_like_on = vec![0.0_f64; class_count];
    let mut rank_square_sum_like_off = vec![0.0_f64; class_count];
    let mut style_sector_departures_like_on = 0_usize;
    let mut style_sector_departures_like_off = 0_usize;
    let mut coverage_epoch_transitions_like_on = 0_usize;
    let mut coverage_epoch_transitions_like_off = 0_usize;
    let mut within_cos_sum_like_on = 0.0_f64;
    let mut within_cos_count_like_on = 0_usize;
    let mut cross_cos_sum_like_on = 0.0_f64;
    let mut cross_cos_count_like_on = 0_usize;
    let mut within_cos_sum_like_off = 0.0_f64;
    let mut within_cos_count_like_off = 0_usize;
    let mut cross_cos_sum_like_off = 0.0_f64;
    let mut cross_cos_count_like_off = 0_usize;
    for (job_index, sampled_start, on_run, off_run) in paired_runs {
        let draw_index = job_index;
        let anchor_key = &sampled_start.key;
        let anchor_local = *execution
            .local_by_key
            .get(anchor_key)
            .expect("every selected Like anchor must be native-addressable");
        let order_equal = on_run.order == off_run.order;
        let target_reached = on_run.target_rank.is_some() && off_run.target_rank.is_some();
        let target_rank_equal = on_run.target_rank == off_run.target_rank;
        let ticket_equal = on_run.ticket_epoch == off_run.ticket_epoch
            && on_run.ticket_energies == off_run.ticket_energies;
        all_orders_equal &= order_equal;
        all_targets_reached &= target_reached;
        all_target_ranks_equal &= target_rank_equal;
        all_ticket_pairs_equal &= ticket_equal;
        like_effect_observed |= !order_equal || !target_rank_equal;
        all_like_on_full_first_passes &= on_run.class_order.len().saturating_add(1)
            == execution.atlas.track_count
            && on_run
                .class_order
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                .len()
                == on_run.class_order.len();
        all_like_off_full_first_passes &= off_run.class_order.len().saturating_add(1)
            == execution.atlas.track_count
            && off_run
                .class_order
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                .len()
                == off_run.class_order.len();
        cached_proposal_count += on_run.steps + off_run.steps;
        target_wait_like_on.push(
            on_run
                .target_wait_ms
                .expect("Like-on full first pass must reach the target"),
        );
        target_wait_like_off.push(
            off_run
                .target_wait_ms
                .expect("Like-off full first pass must reach the target"),
        );
        rank_sum_like_on[anchor_local] += 0.0;
        rank_sum_like_off[anchor_local] += 0.0;
        rank_square_sum_like_on[anchor_local] += 0.0;
        rank_square_sum_like_off[anchor_local] += 0.0;
        for (rank, local) in on_run.class_order.iter().copied().enumerate() {
            let rank = (rank + 1) as f64;
            rank_sum_like_on[local] += rank;
            rank_square_sum_like_on[local] += rank * rank;
        }
        for (rank, local) in off_run.class_order.iter().copied().enumerate() {
            let rank = (rank + 1) as f64;
            rank_sum_like_off[local] += rank;
            rank_square_sum_like_off[local] += rank * rank;
        }
        style_sector_departures_like_on += on_run.style_sector_departures;
        style_sector_departures_like_off += off_run.style_sector_departures;
        coverage_epoch_transitions_like_on += on_run.coverage_epoch_transitions;
        coverage_epoch_transitions_like_off += off_run.coverage_epoch_transitions;
        within_cos_sum_like_on += on_run.within_cos_sum;
        within_cos_count_like_on += on_run.within_cos_count;
        cross_cos_sum_like_on += on_run.cross_cos_sum;
        cross_cos_count_like_on += on_run.cross_cos_count;
        within_cos_sum_like_off += off_run.within_cos_sum;
        within_cos_count_like_off += off_run.within_cos_count;
        cross_cos_sum_like_off += off_run.cross_cos_sum;
        cross_cos_count_like_off += off_run.cross_cos_count;
        if let Some(energies) = on_run.ticket_energies.as_ref() {
            assert!(
                ticket_vectors_by_draw
                    .insert(draw_index, energies.clone())
                    .is_none(),
                "each actual-model MC draw must have exactly one ticket vector"
            );
        }
        println!(
            "native_ticket_window anchor_local={} draw_index={} draw_seed={} sampled_probability={:.9} target_rank_like_on={:?} target_rank_like_off={:?} order_equal={} ticket_equal={} steps_like_on={} steps_like_off={}",
            anchor_local,
            draw_index,
            on_run.draw_seed,
            sampled_start.probability,
            on_run.target_rank,
            off_run.target_rank,
            order_equal,
            ticket_equal,
            on_run.steps,
            off_run.steps,
        );
        anchor_rows.push(json!({
            "anchor_key": json_key(anchor_key),
            "anchor_local": anchor_local,
            "draw_index": draw_index,
            "sampled_source_index": sampled_start.source_index,
            "sampled_probability": sampled_start.probability,
            "anchor_is_target": anchor_key == &target_native_key,
            "anchor_is_db_family_control": anchor_key == &family_key,
            "like_on": like_baseline_variant_json(&on_run),
            "like_off": like_baseline_variant_json(&off_run),
            "order_equal": order_equal,
            "target_reached": target_reached,
            "target_rank_equal": target_rank_equal,
            "ticket_equal": ticket_equal,
        }));
    }

    assert_eq!(
        ticket_vectors_by_draw.len(),
        job_count,
        "every actual-model MC draw must publish one ticket vector"
    );
    let ticket_vectors = ticket_vectors_by_draw.values().collect::<Vec<_>>();
    let mut all_ticket_draws_distinct = ticket_vectors.len() >= 2;
    for left_index in 0..ticket_vectors.len() {
        for right_index in left_index + 1..ticket_vectors.len() {
            all_ticket_draws_distinct &= ticket_vectors[left_index] != ticket_vectors[right_index];
        }
    }

    let control = like_baseline_control_check(&snapshot, &formed, &like_on, &target_native_key);

    let controls_equal = control.reproposal_equal
        && control.rollback_order_equal
        && control.committed_snapshot_order_equal
        && control.pending_observation == "StillPending"
        && control.rollback_observation == "RolledBack"
        && control.reproposal_observation == "Committed";

    let replay_ms = replay_elapsed.as_millis();
    let projected_64_replay_ms = if draw_count > 0 {
        replay_ms.saturating_mul(64) / draw_count as u128
    } else {
        0
    };
    let target_wait_summary = json!({
        "like_on": like_baseline_wait_summary(&target_wait_like_on),
        "like_off": like_baseline_wait_summary(&target_wait_like_off),
    });
    let rank_summary = json!({
        "like_on": like_baseline_rank_summary(
            &rank_sum_like_on,
            &rank_square_sum_like_on,
            draw_count,
        ),
        "like_off": like_baseline_rank_summary(
            &rank_sum_like_off,
            &rank_square_sum_like_off,
            draw_count,
        ),
    });
    let geometry_summary = json!({
        "like_on": like_baseline_geometry_summary(
            within_cos_sum_like_on,
            within_cos_count_like_on,
            cross_cos_sum_like_on,
            cross_cos_count_like_on,
        ),
        "like_off": like_baseline_geometry_summary(
            within_cos_sum_like_off,
            within_cos_count_like_off,
            cross_cos_sum_like_off,
            cross_cos_count_like_off,
        ),
    });
    let style_mark_summary = json!({
        "like_on": {
            "style_sector_departures": style_sector_departures_like_on,
            "coverage_epoch_transitions": coverage_epoch_transitions_like_on,
        },
        "like_off": {
            "style_sector_departures": style_sector_departures_like_off,
            "coverage_epoch_transitions": coverage_epoch_transitions_like_off,
        },
        "interpretation": "native transition marks are reported from AudioStyleSymbolicNextTrack; basin labels are not substituted for style marks",
    });

    let result_type = if all_targets_reached
        && all_ticket_pairs_equal
        && all_ticket_draws_distinct
        && like_effect_observed
        && all_like_on_full_first_passes
        && all_like_off_full_first_passes
        && controls_equal
    {
        "Exact"
    } else {
        "Refuted"
    };
    let resource = json!({
        "db_input_bytes": fs::metadata(&db_path)
            .expect("Like baseline DB metadata should remain readable")
            .len(),
        "model_input_bytes": model_size_bytes,
        "db_projection_ms": db_projection_ms,
        "actual_mc_input_bytes": fs::metadata(&actual_mc_path)
            .expect("actual-model MC input metadata should remain readable")
            .len(),
        "actual_mc_projection_ms": actual_mc_projection_ms,
        "model_loader_ms": model_loader_ms,
        "scope_formation_ms": formation_ms,
        "scope_formation_count": 1,
        "draw_count": draw_count,
        "actual_mc_key_count": actual_mc_native_keys.len(),
        "focused_control_anchor_count": anchor_keys.len(),
        "cached_proposal_count": cached_proposal_count,
        "replay_ms": replay_ms,
        "projected_64_replay_ms": projected_64_replay_ms,
        "projected_64_replay_within_five_minutes": projected_64_replay_ms <= 5 * 60 * 1000,
        "calibration_draw_count": draw_count.min(8),
        "single_formed_execution_for_all_draws": true,
        "projection_arc_pointer": projection_arc,
        "projection_centered_vector_count": projection_centered_vector_count,
        "projection_dimensions": projection_dimensions,
        "projection_vector_bytes": projection_vector_bytes,
        "projection_indexed_candidates": projection_indexed_candidates,
        "available_parallelism": std::thread::available_parallelism().map(|n| n.get()).ok(),
        "parallel_width": worker_count,
        "peak_memory_bytes": Value::Null,
        "io_note": "read-only DB/model inputs; no audio-tree scan; one native formation and cached observer replays"
    });
    let liked_rows_output = db_liked_rows
        .iter()
        .map(|row| like_baseline_row_json(row))
        .collect::<Vec<_>>();
    let mut artifact = json!({
        "artifact": "native-ticket-window-219-v7",
        "result_type": result_type,
        "baseline_status": "post_change_native_ticket_window_regression",
        "regression_role": "paired actual-model Like-on versus Like-off replay with fixed per-epoch tickets",
        "observer_only": true,
        "observation_hypothesis": "paired Like-on and Like-off replays share epoch tickets while Like changes opportunity priority",
        "authority": "AudioStyleSymbolicPlaybackSession::propose_next with real active-track observation",
        "input_identity": {
            "db_input_path": db_path,
            "db_row_count": LIKE_BASELINE_EXPECTED_DB_ROWS,
            "db_scope_expected_key_count": LIKE_BASELINE_EXPECTED_DB_KEYS,
            "db_scope_admitted_key_count": LIKE_BASELINE_EXPECTED_DB_KEYS,
            "actual_mc_input_path": actual_mc_path,
            "actual_mc_key_count": actual_mc_native_keys.len(),
            "actual_mc_probability_vector_count": actual_mc_probability_vector.len(),
            "actual_mc_probability_vector_semantics": actual_mc.mc.probability_vector_semantics,
            "model_input_path": model_path,
            "model_generation": LIKE_BASELINE_EXPECTED_GENERATION,
            "model_sha256_from_predecessor": db.frozen_model.sha256,
            "model_indexed_key_count": LIKE_BASELINE_EXPECTED_MODEL_KEYS,
            "model_class_count": LIKE_BASELINE_EXPECTED_MODEL_CLASSES,
            "scope_signature": scope_signature,
            "formed_once": true,
            "draw_count": draw_count,
            "per_draw_seed_formula": "0x51A70000 + draw_index",
            "actual_mc_sampling": "sample one admitted key with replacement from mc.probability_vector using the per-draw seed; the sampled key is the native replay anchor",
            "independent_mc_session_reset": "clear inherited epoch tickets before setting each draw seed",
        },
        "db_like_authority": {
            "source": "music_rows.model_canonical_domain.rows",
            "canonical_row_count": db.music_rows.model_canonical_domain.rows.len(),
            "liked_row_count": db_liked_rows.len(),
            "scope_liked_count_after_db_overlay": db_scope_liked_count,
            "model_scope_liked_count_before_overlay": model_scope_liked_count,
            "overlay_changed_count": overlay_changed_count,
            "target": {
                "canonical_music_id": target_row.canonical_music_id,
                "liked": target_row.liked,
                "db_order": target_row.db_order,
                "track_key": json_key(&target_native_key),
                "local": target_local,
            },
            "adjacent_liked_family_control": {
                "canonical_music_id": family_row.canonical_music_id,
                "liked": family_row.liked,
                "db_order": family_row.db_order,
                "track_key": json_key(&family_key),
                "local": family_local,
                "db_order_distance_from_target": family_row.db_order.abs_diff(target_row.db_order),
            },
            "liked_rows": liked_rows_output,
        },
        "first_formed_proposal": {
            "track_key": json_key(&PlaybackTrackKey::from_track(&first.track)),
            "observation": format!("{first_observation:?}"),
        },
        "actual_mc_draws": anchor_rows,
        "focused_controls": {
            "anchor_keys": anchor_keys.iter().map(json_key).collect::<Vec<_>>(),
            "target_control": like_baseline_control_json(&control),
        },
        "native_replay_summary": {
            "target_wait": target_wait_summary,
            "perclass_rank": rank_summary,
            "geometry": geometry_summary,
            "native_style_marks": style_mark_summary,
        },
        "checks": {
            "all_like_on_off_orders_equal": all_orders_equal,
            "like_effect_observed": like_effect_observed,
            "all_targets_reached_in_both_variants": all_targets_reached,
            "all_like_on_off_target_ranks_equal": all_target_ranks_equal,
            "all_like_on_off_ticket_vectors_equal": all_ticket_pairs_equal,
            "different_draw_seeds_have_distinct_ticket_vectors": all_ticket_draws_distinct,
            "all_like_on_full_first_passes_without_duplicate_classes": all_like_on_full_first_passes,
            "all_like_off_full_first_passes_without_duplicate_classes": all_like_off_full_first_passes,
            "actual_mc_key_set_equals_independent_db_scope": actual_mc_key_set == expected_keys,
            "actual_mc_job_count_equals_requested_draw_count": job_count == draw_count,
            "all_actual_mc_ticket_vectors_present": ticket_vectors_by_draw.len() == job_count,
            "pending_rollback_reproposal_and_committed_snapshot_equal": controls_equal,
            "native_scope_union_equals_independent_db_scope": native_scope_keys == expected_keys,
            "scope_formation_count": 1,
            "cached_proposal_count": cached_proposal_count,
        },
        "resource_observation": resource.clone(),
        "not_claimed": [
            "global epoch-join fatigue uniformity",
            "strict uniform rank distribution",
            "full model 3306-cycle equivalence",
            "all-model coverage beyond this formed DB scope",
            "arbitrary app restart semantics",
            "live-device audio outcome"
        ],
    });
    let artifact_bytes_before_resource_projection = serde_json::to_vec_pretty(&artifact)
        .expect("Like baseline artifact should serialize before resource projection");
    let mut resource = resource;
    resource["serialized_bytes_before_resource_projection"] =
        json!(artifact_bytes_before_resource_projection.len());
    artifact["resource_observation"] = resource.clone();
    let artifact_bytes = serde_json::to_vec_pretty(&artifact)
        .expect("Like baseline artifact should serialize after resource projection");

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).expect("Like baseline output directory should exist");
    }
    if let Some(parent) = receipt_path.parent() {
        fs::create_dir_all(parent).expect("Like baseline receipt directory should exist");
    }
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).expect("Like baseline log directory should exist");
    }
    fs::write(&output_path, &artifact_bytes).unwrap_or_else(|error| {
        panic!(
            "Like baseline artifact '{}' should be writable: {error}",
            output_path.display()
        )
    });
    let receipt_anchor_summary = like_baseline_receipt_anchor_summary(&anchor_rows);
    let anchor_summary = serde_json::to_string_pretty(&receipt_anchor_summary)
        .expect("Like baseline compact anchor summary should serialize");
    let receipt = format!(
        r#"# Native ticket-window Like regression — 'native-ticket-window-219-v7'

Result: '{result_type}' for the post-change actual-model Like-on versus Like-off
paired replay. Each independent draw clears inherited tickets, seeds both variants
identically, and retains one ticket vector throughout its replay.

The stable generation-{generation} model was loaded once and one real
AudioStyleSymbolicPlaybackSession::propose_next formed the scope with DB Like
metadata overlaid before formation. All subsequent sampled starts reused that formed
execution through anchor-only transport_traversal_state; each replay resolves the
exact sampled member, records its target first-hit rank, and continues through the
complete native first class pass without crossing into a second epoch. No
counterfactual reformation was performed.

- DB canonical rows: {db_rows}; DB liked rows: {db_liked}; scope DB liked after overlay: {scope_liked}; model liked before overlay: {model_liked}; overlay changes: {overlay_changed}
- Target: '{target_canonical}' liked='{target_liked}', local='{target_local}', DB order='{target_db_order}'
- Adjacent liked family control: '{family_canonical}' liked='{family_liked}', local='{family_local}', DB order='{family_db_order}', distance='{family_distance}'
- Actual MC admitted keys: {actual_mc_key_count}; focused controls: {focused_control_anchor_count}; total sampled starts: {draw_count}; cached proposals: {cached_proposals}; replay ms: {replay_ms}; Like-on/off orders equal: '{orders_equal}'; Like effect observed: '{like_effect_observed}'
- Both variants reached each target: '{targets_reached}'; target ranks equal: '{target_ranks_equal}'; paired ticket vectors equal: '{ticket_pairs_equal}'; distinct draw ticket vectors: '{ticket_draws_distinct}'; full first passes without duplicate classes (Like-on/off): '{full_passes_on}'/'{full_passes_off}'
- Pending/rollback/reproposal and committed snapshot/reopen equal: '{controls_equal}'

## Actual MC draw evidence

BEGIN_ANCHOR_JSON
{anchor_summary}
END_ANCHOR_JSON

The durable JSON artifact contains compact class-order vectors, target first-hit
ranks, and ticket samples rather than full per-step track objects; this receipt
intentionally contains only compact draw summary rows and output paths.

This receipt preserves observer evidence only. It does not modify production
recommendation logic, the stable model, live database state, or audio files. The
prior immutable pre-change receipt remains the separate native-like-baseline-219-v1
artifact.

Output: '{output}'

Log: '{log}'
"#,
        generation = LIKE_BASELINE_EXPECTED_GENERATION,
        db_rows = db.music_rows.model_canonical_domain.rows.len(),
        db_liked = db_liked_rows.len(),
        scope_liked = db_scope_liked_count,
        model_liked = model_scope_liked_count,
        overlay_changed = overlay_changed_count,
        target_canonical = target_row.canonical_music_id,
        target_liked = target_row.liked,
        target_local = target_local,
        target_db_order = target_row.db_order,
        family_canonical = family_row.canonical_music_id,
        family_liked = family_row.liked,
        family_local = family_local,
        family_db_order = family_row.db_order,
        family_distance = family_row.db_order.abs_diff(target_row.db_order),
        actual_mc_key_count = actual_mc_native_keys.len(),
        focused_control_anchor_count = anchor_keys.len(),
        draw_count = draw_count,
        cached_proposals = cached_proposal_count,
        replay_ms = replay_ms,
        orders_equal = all_orders_equal,
        like_effect_observed = like_effect_observed,
        targets_reached = all_targets_reached,
        target_ranks_equal = all_target_ranks_equal,
        ticket_pairs_equal = all_ticket_pairs_equal,
        ticket_draws_distinct = all_ticket_draws_distinct,
        full_passes_on = all_like_on_full_first_passes,
        full_passes_off = all_like_off_full_first_passes,
        controls_equal = controls_equal,
        anchor_summary = anchor_summary,
        output = output_path.display(),
        log = log_path.display(),
    );
    fs::write(&receipt_path, receipt).unwrap_or_else(|error| {
        panic!(
            "Like baseline receipt '{}' should be writable: {error}",
            receipt_path.display()
        )
    });
    fs::write(
        &log_path,
        format!(
            "artifact={} receipt={} result_type={} generation={} scope_signature={} scope_formation_count=1 actual_mc_key_count={} focused_control_anchor_count={} draw_count={} cached_proposal_count={} replay_ms={} orders_equal={} like_effect_observed={} targets_reached={} target_ranks_equal={} ticket_pairs_equal={} ticket_draws_distinct={} controls_equal={} output_bytes={}\n",
            output_path.display(),
            receipt_path.display(),
            result_type,
            LIKE_BASELINE_EXPECTED_GENERATION,
            scope_signature,
            actual_mc_native_keys.len(),
            anchor_keys.len(),
            draw_count,
            cached_proposal_count,
            replay_elapsed.as_millis(),
            all_orders_equal,
            like_effect_observed,
            all_targets_reached,
            all_target_ranks_equal,
            all_ticket_pairs_equal,
            all_ticket_draws_distinct,
            controls_equal,
            artifact_bytes.len(),
        ),
    )
    .unwrap_or_else(|error| {
        panic!(
            "Like baseline log '{}' should be writable: {error}",
            log_path.display()
        )
    });

    assert!(
        all_targets_reached,
        "native ticket-window replay must reach the target in both variants for every sampled actual-model MC start"
    );
    assert!(
        all_ticket_pairs_equal,
        "paired Like-on and Like-off replays must share exactly one ticket vector per draw"
    );
    assert!(
        all_ticket_draws_distinct,
        "different draw seeds must produce distinct ticket vectors"
    );
    assert!(
        controls_equal,
        "pending rollback/reproposal and committed snapshot/reopen must preserve native order"
    );
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

fn like_baseline_draw_count() -> usize {
    match std::env::var(LIKE_BASELINE_DRAW_COUNT_ENV) {
        Ok(value) => {
            let draw_count = value.parse::<usize>().unwrap_or_else(|error| {
                panic!(
                    "{LIKE_BASELINE_DRAW_COUNT_ENV} must be a positive draw count (8 or 64): {error}"
                )
            });
            assert!(
                matches!(draw_count, 8 | 64),
                "{LIKE_BASELINE_DRAW_COUNT_ENV} is bounded to 8 or 64 draws"
            );
            draw_count
        }
        Err(_) => LIKE_BASELINE_DEFAULT_DRAW_COUNT,
    }
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
