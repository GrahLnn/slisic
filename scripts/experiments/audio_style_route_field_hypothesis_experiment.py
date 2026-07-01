#!/usr/bin/env python3
"""Validate audio-style route-field walking hypotheses on the stable model.

Run with:
  uv run --with numpy python scripts/experiments/audio_style_route_field_hypothesis_experiment.py
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
from collections import Counter, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np


DEFAULT_STABLE = Path.home() / "AppData/Local/slisic/audio-style-stable-model/stable.json"


@dataclass(frozen=True)
class Policy:
    name: str
    beta: float
    temperature: float
    local_k: int
    local_sample: int
    frontier_basins: int
    recent_track_floor: float
    fatigue_strength: float
    homeostasis_strength: float
    underuse_lift: float
    fixed_stream_target: int = 0
    fixed_stream_strength: float = 0.0
    fixed_escape_strength: float = 0.0
    route_stream_strength: float = 0.0
    route_capture_strength: float = 0.0
    trajectory_strength: float = 0.0
    backtrack_strength: float = 0.0
    field_relaxation: float = 0.0
    route_compression: float = 0.0
    entropy_reserve: float = 0.0
    entropy_reserve_width: float = 0.0


@dataclass(frozen=True)
class StableModel:
    generation: int
    titles: list[str]
    paths: list[str]
    x: np.ndarray
    sim: np.ndarray
    basins: np.ndarray
    basin_names: list[str]
    basin_members: list[np.ndarray]
    basin_target: np.ndarray
    basin_support: np.ndarray
    nearest: np.ndarray


def key_tuple(raw: dict) -> tuple[str, str, int, int]:
    return (
        str(raw.get("music_url", "")),
        str(raw.get("file_path", "")),
        int(raw.get("start_ms", 0) or 0),
        int(raw.get("end_ms", 0) or 0),
    )


def load_stable(path: Path, local_k: int) -> StableModel:
    data = json.loads(path.read_text(encoding="utf-8"))
    state = data["state"]
    rows = np.asarray([entry["values"] for entry in state["embeddings"]], dtype=np.float32)
    rows /= np.maximum(np.linalg.norm(rows, axis=1, keepdims=True), 1.0e-8)
    centered = rows - rows.mean(axis=0, keepdims=True)
    centered /= np.maximum(np.linalg.norm(centered, axis=1, keepdims=True), 1.0e-8)
    sim = centered @ centered.T
    np.fill_diagonal(sim, -1.0)

    indexed = state["indexed_tracks"]
    titles = [entry["track"]["music_name"] for entry in indexed]
    paths = [entry["track"]["file_path"] for entry in indexed]
    index_by_key = {key_tuple(entry["key"]): idx for idx, entry in enumerate(indexed)}

    raw_basins = state["sampling_geometry"].get("self_supervised_basins", [])
    basin_by_track: dict[int, str] = {}
    for entry in raw_basins:
        idx = index_by_key.get(key_tuple(entry.get("key", {})))
        if idx is not None:
            basin_by_track[idx] = str(entry.get("basin", "audio-basin:unknown"))
    names = sorted(set(basin_by_track.values()))
    name_to_id = {name: idx for idx, name in enumerate(names)}
    basins = np.asarray(
        [name_to_id.get(basin_by_track.get(idx, "audio-basin:unknown"), 0) for idx in range(len(rows))],
        dtype=np.int32,
    )

    basin_members = [np.flatnonzero(basins == basin_id).astype(np.int32) for basin_id in range(len(names))]
    sizes = np.asarray([max(1, len(members)) for members in basin_members], dtype=np.float32)
    target = np.sqrt(sizes)
    target /= max(float(target.sum()), 1.0e-8)
    support = np.sqrt(sizes / max(float(sizes.max()), 1.0))
    support = np.clip(support, 0.18, 1.0)

    nearest_count = min(max(local_k * 2, local_k + 1), len(rows) - 1)
    nearest = np.argpartition(sim, -nearest_count, axis=1)[:, -nearest_count:]
    order = np.take_along_axis(sim, nearest, axis=1).argsort(axis=1)[:, ::-1]
    nearest = np.take_along_axis(nearest, order, axis=1).astype(np.int32)

    return StableModel(
        generation=int(data.get("generation", state.get("generation", 0)) or 0),
        titles=titles,
        paths=paths,
        x=centered,
        sim=sim,
        basins=basins,
        basin_names=names,
        basin_members=basin_members,
        basin_target=target,
        basin_support=support,
        nearest=nearest,
    )


def softmax_distribution(scores: np.ndarray, temperature: float) -> np.ndarray:
    scaled = scores / max(temperature, 1.0e-6)
    scaled = scaled - float(np.max(scaled))
    weights = np.exp(np.clip(scaled, -50.0, 50.0))
    total = float(weights.sum())
    if not math.isfinite(total) or total <= 0.0:
        return np.full(len(scores), 1.0 / max(1, len(scores)), dtype=np.float32)
    return weights / total


def softmax_sample(scores: np.ndarray, rng: np.random.Generator, temperature: float) -> tuple[int, float, np.ndarray]:
    probs = softmax_distribution(scores, temperature)
    index = int(np.searchsorted(np.cumsum(probs), rng.random(), side="right"))
    index = min(index, len(scores) - 1)
    return index, float(probs[index]), probs


def effective_width(probs: np.ndarray) -> float:
    squared = float(np.sum(probs * probs))
    if squared <= 1.0e-8 or not math.isfinite(squared):
        return 0.0
    return 1.0 / squared


def unique_preserving_order(values: Iterable[int]) -> np.ndarray:
    seen: set[int] = set()
    out: list[int] = []
    for value in values:
        ivalue = int(value)
        if ivalue in seen:
            continue
        seen.add(ivalue)
        out.append(ivalue)
    return np.asarray(out, dtype=np.int32)


def current_run(seq: list[int]) -> tuple[int, int]:
    if not seq:
        return -1, 0
    current = seq[-1]
    run = 0
    for value in reversed(seq):
        if value != current:
            break
        run += 1
    return current, run


def run_lengths(seq: list[int]) -> list[int]:
    if not seq:
        return []
    lengths: list[int] = []
    last = seq[0]
    run = 1
    for value in seq[1:]:
        if value == last:
            run += 1
            continue
        lengths.append(run)
        last = value
        run = 1
    lengths.append(run)
    return lengths


def normalized_entropy(counts: Counter[int], universe: int) -> float:
    total = sum(counts.values())
    if total <= 0 or universe <= 1:
        return 0.0
    entropy = 0.0
    for count in counts.values():
        p = count / total
        entropy -= p * math.log(max(p, 1.0e-12))
    return entropy / math.log(universe)


def quantile(values: list[float] | list[int], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(float(value) for value in values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * q))]


def choose_frontier_basins(
    model: StableModel,
    usage_share: np.ndarray,
    fatigue: np.ndarray,
    current_basin: int,
    run_len: int,
    policy: Policy,
    rng: np.random.Generator,
) -> list[int]:
    if policy.frontier_basins <= 0:
        return []
    underuse = np.maximum(model.basin_target - usage_share, 0.0)
    escape_pressure = math.log1p(max(run_len - 1, 0)) + 2.5 * max(
        usage_share[current_basin] - model.basin_target[current_basin],
        0.0,
    )
    scores = underuse + 0.08 * rng.random(len(underuse))
    scores += 0.18 * escape_pressure * model.basin_support
    scores -= 0.20 * fatigue
    scores[current_basin] -= 0.40
    count = min(policy.frontier_basins, len(scores) - 1)
    if count <= 0:
        return []
    return [int(value) for value in np.argsort(scores)[-count:][::-1] if int(value) != current_basin]


def build_candidates(
    model: StableModel,
    current: int,
    recent_tracks: deque[int],
    usage_share: np.ndarray,
    fatigue: np.ndarray,
    basin_seq: list[int],
    policy: Policy,
    rng: np.random.Generator,
) -> np.ndarray:
    recent = set(recent_tracks)
    local_source = [int(idx) for idx in model.nearest[current, : policy.local_k] if int(idx) != current]
    local_source = [idx for idx in local_source if idx not in recent]
    if len(local_source) > policy.local_sample:
        local_scores = model.sim[current, local_source]
        local_pick_scores = np.exp(np.clip(local_scores / 0.42, -40.0, 40.0))
        local_pick_scores /= max(float(local_pick_scores.sum()), 1.0e-8)
        local_source = [
            int(local_source[idx])
            for idx in rng.choice(
                len(local_source),
                size=policy.local_sample,
                replace=False,
                p=local_pick_scores,
            )
        ]

    current_basin, run_len = current_run(basin_seq)
    extra: list[int] = []
    if current_basin >= 0:
        same_members = model.basin_members[current_basin]
        same_scores = model.sim[current, same_members]
        same_order = same_members[np.argsort(same_scores)[-8:][::-1]]
        extra.extend(int(idx) for idx in same_order if int(idx) != current and int(idx) not in recent)

    for basin in choose_frontier_basins(model, usage_share, fatigue, current_basin, run_len, policy, rng):
        members = model.basin_members[basin]
        if len(members) == 0:
            continue
        scores = model.sim[current, members]
        for idx in members[np.argsort(scores)[-3:][::-1]]:
            if int(idx) != current and int(idx) not in recent:
                extra.append(int(idx))
                break

    candidates = unique_preserving_order([*local_source, *extra])
    if len(candidates) == 0:
        fallback = [idx for idx in model.nearest[current, : policy.local_k] if int(idx) != current]
        candidates = unique_preserving_order(fallback)
    return candidates


def route_scores(
    model: StableModel,
    policy: Policy,
    current: int,
    previous: int | None,
    candidates: np.ndarray,
    basin_seq: list[int],
    usage_share: np.ndarray,
    fatigue: np.ndarray,
) -> np.ndarray:
    candidate_basins = model.basins[candidates]
    continuity = model.sim[current, candidates]
    scores = policy.beta * continuity
    evidence_confidence = np.clip((len(basin_seq) - 3) / 18.0, 0.0, 1.0)

    overuse = np.maximum(usage_share[candidate_basins] - model.basin_target[candidate_basins], 0.0)
    underuse = np.maximum(model.basin_target[candidate_basins] - usage_share[candidate_basins], 0.0)
    scores -= policy.homeostasis_strength * evidence_confidence * overuse
    scores += policy.underuse_lift * evidence_confidence * underuse
    scores -= policy.fatigue_strength * evidence_confidence * fatigue[candidate_basins]

    current_basin, run_len = current_run(basin_seq)
    same = candidate_basins == current_basin
    if current_basin >= 0 and policy.fixed_stream_target > 0 and same.any():
        comfort = max(policy.fixed_stream_target - run_len + 1, 0) / policy.fixed_stream_target
        scores[same] += policy.fixed_stream_strength * comfort
        overflow = max(run_len - policy.fixed_stream_target, 0)
        scores[same] -= policy.fixed_escape_strength * math.log1p(overflow)

    if current_basin >= 0 and policy.route_stream_strength > 0.0:
        same_best = float(np.max(continuity[same])) if same.any() else -1.0
        other_best = float(np.max(continuity[~same])) if np.any(~same) else -1.0
        support = float(np.mean(same)) if len(same) else 0.0
        quality_margin = np.clip(same_best - other_best + 0.10, -1.0, 1.0)
        support_gate = np.clip((support - 0.08) / 0.92, -1.0, 1.0)
        current_overuse = max(usage_share[current_basin] - model.basin_target[current_basin], 0.0)
        stream_maturity = np.clip((run_len - 2) / 5.0, 0.0, 1.0)
        early_continuity = np.clip((3 - run_len) / 2.0, 0.0, 1.0)
        stream_value = (
            1.65 * quality_margin
            + 0.75 * support_gate
            + 0.58 * early_continuity
            - 0.52 * evidence_confidence * stream_maturity * fatigue[current_basin]
            - 1.35 * evidence_confidence * stream_maturity * current_overuse
            - 0.08 * stream_maturity * math.log1p(max(run_len - 1, 0))
        )
        scores[same] += policy.route_stream_strength * np.clip(stream_value, -2.4, 2.4)

        escape_pressure = (
            stream_maturity
            * evidence_confidence
            * (
                0.42 * math.log1p(max(run_len - 1, 0))
                + 2.4 * current_overuse
                + 0.28 * fatigue[current_basin]
            )
        )
        alternative = ~same
        if np.any(alternative):
            capture_support = model.basin_support[candidate_basins]
            candidate_quality = np.maximum(continuity - same_best + 0.18, 0.0)
            capture = escape_pressure * capture_support * candidate_quality
            scores[alternative] += policy.route_capture_strength * capture[alternative]

    if previous is not None and policy.trajectory_strength > 0.0:
        axis = model.x[current] - model.x[previous]
        axis /= max(float(np.linalg.norm(axis)), 1.0e-8)
        cand_axis = model.x[candidates] - model.x[current]
        cand_axis /= np.maximum(np.linalg.norm(cand_axis, axis=1, keepdims=True), 1.0e-8)
        alignment = cand_axis @ axis
        backtrack = np.maximum(model.sim[previous, candidates] - 0.42, 0.0)
        scores += policy.trajectory_strength * np.clip(alignment, -0.35, 0.85)
        scores -= policy.backtrack_strength * backtrack

    if policy.field_relaxation > 0.0 and len(scores) > 1:
        centered = scores - np.max(scores)
        probs = np.exp(np.clip(centered / policy.temperature, -50.0, 50.0))
        probs /= max(float(probs.sum()), 1.0e-8)
        crowd = probs * len(probs)
        scores -= policy.field_relaxation * np.log1p(crowd)

    if policy.route_compression > 0.0:
        mean = float(np.mean(scores))
        centered = scores - mean
        scale = max(policy.route_compression, 1.0e-6)
        scores = mean + scale * np.tanh(centered / scale)

    if policy.entropy_reserve > 0.0 and len(scores) > 1:
        probs = softmax_distribution(scores, policy.temperature)
        width = effective_width(probs)
        reserve = np.clip(
            (policy.entropy_reserve_width - width) / max(policy.entropy_reserve_width - 1.0, 1.0e-6),
            0.0,
            1.0,
        )
        if reserve > 0.0:
            scores = scores * (1.0 - policy.entropy_reserve * reserve)

    return scores


def simulate_policy(
    model: StableModel,
    policy: Policy,
    runs: int,
    steps: int,
    seed: int,
    starts: list[int] | None = None,
) -> dict:
    rng = np.random.default_rng(seed)
    basin_count = len(model.basin_names)
    all_basins: list[int] = []
    all_tracks: list[int] = []
    all_runs: list[int] = []
    transitions: list[float] = []
    probabilities: list[float] = []
    choice_top_probabilities: list[float] = []
    choice_widths: list[float] = []
    score_spreads: list[float] = []
    bigrams = Counter()

    for run_index in range(runs):
        current = starts[run_index % len(starts)] if starts else int(rng.integers(0, len(model.titles)))
        previous: int | None = None
        recent_tracks: deque[int] = deque([current], maxlen=40)
        basin_seq = [int(model.basins[current])]
        usage = np.zeros(basin_count, dtype=np.float32)
        fatigue = np.zeros(basin_count, dtype=np.float32)
        usage[basin_seq[-1]] += 1.0
        fatigue[basin_seq[-1]] += 1.0
        all_tracks.append(current)
        all_basins.append(basin_seq[-1])

        for _ in range(steps - 1):
            fatigue *= 0.90
            usage *= 0.985
            total_usage = max(float(usage.sum()), 1.0e-8)
            usage_share = usage / total_usage
            candidates = build_candidates(
                model,
                current,
                recent_tracks,
                usage_share,
                fatigue,
                basin_seq,
                policy,
                rng,
            )
            scores = route_scores(
                model,
                policy,
                current,
                previous,
                candidates,
                basin_seq,
                usage_share,
                fatigue,
            )
            if recent_tracks:
                recent = set(recent_tracks)
                recent_mask = np.asarray([int(idx) in recent for idx in candidates], dtype=bool)
                scores[recent_mask] += math.log(max(policy.recent_track_floor, 1.0e-6))

            pick, probability, probs = softmax_sample(scores, rng, policy.temperature)
            nxt = int(candidates[pick])
            basin = int(model.basins[nxt])
            bigrams[(basin_seq[-1], basin)] += 1
            transitions.append(float(model.sim[current, nxt]))
            probabilities.append(probability)
            choice_top_probabilities.append(float(np.max(probs)))
            choice_widths.append(effective_width(probs))
            score_spreads.append(float(np.max(scores) - np.median(scores)))
            previous, current = current, nxt
            recent_tracks.append(current)
            basin_seq.append(basin)
            usage[basin] += 1.0
            fatigue[basin] += 1.0
            all_tracks.append(current)
            all_basins.append(basin)

        all_runs.extend(run_lengths(basin_seq))

    basin_counts = Counter(all_basins)
    track_counts = Counter(all_tracks)
    total = len(all_basins)
    switch_rate = sum(1 for a, b in zip(all_basins, all_basins[1:]) if a != b) / max(1, total - 1)
    repeat_40 = 0
    window: deque[int] = deque(maxlen=40)
    for track in all_tracks:
        if track in window:
            repeat_40 += 1
        window.append(track)

    return {
        "policy": policy.name,
        "runs": runs,
        "steps": steps,
        "switch_rate": switch_rate,
        "mean_run": sum(all_runs) / max(1, len(all_runs)),
        "p50_run": quantile(all_runs, 0.50),
        "p90_run": quantile(all_runs, 0.90),
        "max_run": max(all_runs) if all_runs else 0,
        "singleton_run_share": sum(1 for value in all_runs if value == 1) / max(1, len(all_runs)),
        "stream_2_to_5_share": sum(1 for value in all_runs if 2 <= value <= 5) / max(1, len(all_runs)),
        "overlong_run_share": sum(1 for value in all_runs if value >= 9) / max(1, len(all_runs)),
        "basin_entropy": normalized_entropy(basin_counts, basin_count),
        "basin_coverage": len(basin_counts) / max(1, basin_count),
        "top_basin_share": max(basin_counts.values()) / max(1, total),
        "top_track_share": max(track_counts.values()) / max(1, total),
        "repeat_40_rate": repeat_40 / max(1, total),
        "transition_mean": float(np.mean(transitions)) if transitions else 0.0,
        "transition_p10": float(np.quantile(transitions, 0.10)) if transitions else 0.0,
        "transition_p90": float(np.quantile(transitions, 0.90)) if transitions else 0.0,
        "choice_probability_mean": sum(probabilities) / max(1, len(probabilities)),
        "choice_top_probability_p90": float(np.quantile(choice_top_probabilities, 0.90))
        if choice_top_probabilities
        else 0.0,
        "choice_width_p10": float(np.quantile(choice_widths, 0.10)) if choice_widths else 0.0,
        "choice_width_p50": float(np.quantile(choice_widths, 0.50)) if choice_widths else 0.0,
        "score_spread_p90": float(np.quantile(score_spreads, 0.90)) if score_spreads else 0.0,
        "bigram_entropy": normalized_entropy(bigrams, basin_count * basin_count),
        "top_basins": [(model.basin_names[idx], count) for idx, count in basin_counts.most_common(8)],
        "top_tracks": [(model.titles[idx], count) for idx, count in track_counts.most_common(8)],
    }


def path_diversity(
    model: StableModel,
    policy: Policy,
    starts: list[int],
    repeats: int,
    steps: int,
    seed: int,
) -> dict:
    prefixes: list[tuple[int, ...]] = []
    endings = Counter()
    for start_index, start in enumerate(starts):
        rows = simulate_paths(model, policy, start, repeats, steps, seed + start_index * 1009)
        prefixes.extend(tuple(row[: min(12, len(row))]) for row in rows)
        endings.update(row[-1] for row in rows if row)
    return {
        "policy": policy.name,
        "path_repeats": repeats,
        "path_starts": len(starts),
        "unique_prefix_share": len(set(prefixes)) / max(1, len(prefixes)),
        "ending_entropy": normalized_entropy(endings, len(model.basin_names)),
        "top_endings": [(model.basin_names[idx], count) for idx, count in endings.most_common(6)],
    }


def simulate_paths(
    model: StableModel,
    policy: Policy,
    start: int,
    repeats: int,
    steps: int,
    seed: int,
) -> list[list[int]]:
    rng = np.random.default_rng(seed)
    rows: list[list[int]] = []
    basin_count = len(model.basin_names)
    for _ in range(repeats):
        current = start
        previous: int | None = None
        recent_tracks: deque[int] = deque([current], maxlen=40)
        basin_seq = [int(model.basins[current])]
        usage = np.zeros(basin_count, dtype=np.float32)
        fatigue = np.zeros(basin_count, dtype=np.float32)
        usage[basin_seq[-1]] += 1.0
        fatigue[basin_seq[-1]] += 1.0
        for _step in range(steps - 1):
            fatigue *= 0.90
            usage *= 0.985
            usage_share = usage / max(float(usage.sum()), 1.0e-8)
            candidates = build_candidates(model, current, recent_tracks, usage_share, fatigue, basin_seq, policy, rng)
            scores = route_scores(model, policy, current, previous, candidates, basin_seq, usage_share, fatigue)
            pick, _probability, _probs = softmax_sample(scores, rng, policy.temperature)
            nxt = int(candidates[pick])
            previous, current = current, nxt
            recent_tracks.append(current)
            basin = int(model.basins[current])
            basin_seq.append(basin)
            usage[basin] += 1.0
            fatigue[basin] += 1.0
        rows.append(basin_seq)
    return rows


def acceptance(rows: list[dict], diversity_rows: list[dict]) -> list[str]:
    by_name = {row["policy"]: row for row in rows}
    base = by_name["distance_only"]
    route = by_name["route_field"]
    fixed = by_name["fixed_three"]
    route_div = {row["policy"]: row for row in diversity_rows}["route_field"]
    checks = [
        (
            "less one-step style jitter than distance-only",
            route["singleton_run_share"] <= base["singleton_run_share"] * 0.82,
        ),
        (
            "not a fixed three-track run machine",
            abs(route["mean_run"] - fixed["mean_run"]) > 0.18
            and route["stream_2_to_5_share"] >= fixed["stream_2_to_5_share"] * 0.85,
        ),
        (
            "no weak-attractor collapse",
            route["top_basin_share"] <= 0.18 and route["basin_entropy"] >= base["basin_entropy"] - 0.04,
        ),
        (
            "escapes before long lock-in",
            route["p90_run"] <= 7.0 and route["overlong_run_share"] <= 0.06,
        ),
        (
            "does not buy diversity by random far jumps",
            route["transition_p10"] >= base["transition_p10"] - 0.08,
        ),
        (
            "same demand still admits multiple paths",
            route_div["unique_prefix_share"] >= 0.70 and route_div["ending_entropy"] >= 0.55,
        ),
        (
            "choice field keeps more than a single local winner",
            route["choice_width_p10"] >= 1.40 and route["choice_top_probability_p90"] <= 0.82,
        ),
    ]
    return [f"{'PASS' if ok else 'FAIL'} {name}" for name, ok in checks]


def route_score(row: dict, base: dict, diversity: dict) -> float:
    jitter_gain = base["singleton_run_share"] - row["singleton_run_share"]
    random_jump_cost = max(base["transition_p10"] - row["transition_p10"], 0.0)
    collapse_cost = max(row["top_basin_share"] - 0.18, 0.0)
    lock_cost = max(row["overlong_run_share"] - 0.05, 0.0) + max(row["p90_run"] - 7.0, 0.0) * 0.04
    certainty_cost = max(row["choice_top_probability_p90"] - 0.82, 0.0)
    narrow_cost = max(1.40 - row["choice_width_p10"], 0.0)
    natural_stream = row["stream_2_to_5_share"]
    variable_tail = min(row["max_run"], 8) / 8.0
    multi_path = min(diversity["unique_prefix_share"], 1.0) + 0.35 * diversity["ending_entropy"]
    return (
        5.0 * jitter_gain
        + 1.8 * natural_stream
        + 0.55 * variable_tail
        + 0.45 * multi_path
        - 5.0 * random_jump_cost
        - 3.0 * collapse_cost
        - 4.0 * lock_cost
        - 1.8 * certainty_cost
        - 0.55 * narrow_cost
    )


def route_score_without_diversity(row: dict, base: dict) -> float:
    jitter_gain = base["singleton_run_share"] - row["singleton_run_share"]
    random_jump_cost = max(base["transition_p10"] - row["transition_p10"], 0.0)
    collapse_cost = max(row["top_basin_share"] - 0.18, 0.0)
    lock_cost = max(row["overlong_run_share"] - 0.05, 0.0) + max(row["p90_run"] - 7.0, 0.0) * 0.04
    certainty_cost = max(row["choice_top_probability_p90"] - 0.82, 0.0)
    narrow_cost = max(1.40 - row["choice_width_p10"], 0.0)
    return (
        5.0 * jitter_gain
        + 1.8 * row["stream_2_to_5_share"]
        + 0.55 * min(row["max_run"], 8) / 8.0
        - 5.0 * random_jump_cost
        - 3.0 * collapse_cost
        - 4.0 * lock_cost
        - 1.8 * certainty_cost
        - 0.55 * narrow_cost
    )


def sweep_route_field(
    model: StableModel,
    template: Policy,
    base_row: dict,
    args: argparse.Namespace,
) -> list[tuple[float, Policy, dict, dict]]:
    coarse: list[tuple[float, Policy, dict]] = []
    start_order = [
        idx
        for idx, _count in Counter(int(value) for value in model.basins).most_common(args.path_starts)
        for idx in [int(model.basin_members[idx][0])]
    ]
    sweep_runs = max(24, args.runs // 4)
    sweep_steps = max(48, args.steps // 2)
    for stream_strength in (1.20, 1.55, 1.90):
        for capture_strength in (0.85, 1.25):
            for homeostasis in (1.10, 1.45):
                for fatigue in (0.24, 0.42):
                    policy = dataclasses.replace(
                        template,
                        name=(
                            "route_sweep "
                            f"stream={stream_strength:.2f} "
                            f"capture={capture_strength:.2f} "
                            f"homeo={homeostasis:.2f} "
                            f"fatigue={fatigue:.2f}"
                        ),
                        route_stream_strength=stream_strength,
                        route_capture_strength=capture_strength,
                        homeostasis_strength=homeostasis,
                        fatigue_strength=fatigue,
                    )
                    row = simulate_policy(
                        model,
                        policy,
                        sweep_runs,
                        sweep_steps,
                        args.seed + len(coarse) * 9173 + 5151,
                    )
                    coarse.append((route_score_without_diversity(row, base_row), policy, row))
    coarse.sort(key=lambda item: item[0], reverse=True)

    rows: list[tuple[float, Policy, dict, dict]] = []
    for _coarse_score, policy, row in coarse[:8]:
        diversity = path_diversity(
            model,
            policy,
            start_order,
            max(8, args.path_repeats // 2),
            max(32, args.path_steps),
            args.seed + len(rows) * 9173 + 8181,
        )
        rows.append((route_score(row, base_row, diversity), policy, row, diversity))
    rows.sort(key=lambda item: item[0], reverse=True)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stable", type=Path, default=DEFAULT_STABLE)
    parser.add_argument("--runs", type=int, default=180)
    parser.add_argument("--steps", type=int, default=96)
    parser.add_argument("--seed", type=int, default=20260701)
    parser.add_argument("--local-k", type=int, default=128)
    parser.add_argument("--path-starts", type=int, default=10)
    parser.add_argument("--path-repeats", type=int, default=28)
    parser.add_argument("--path-steps", type=int, default=48)
    parser.add_argument("--policy", action="append", default=[])
    parser.add_argument("--sweep", action="store_true")
    args = parser.parse_args()

    policies = [
        Policy(
            "distance_only",
            beta=5.4,
            temperature=0.92,
            local_k=args.local_k,
            local_sample=72,
            frontier_basins=4,
            recent_track_floor=0.03,
            fatigue_strength=0.36,
            homeostasis_strength=1.10,
            underuse_lift=0.15,
        ),
        Policy(
            "fixed_three",
            beta=5.4,
            temperature=0.92,
            local_k=args.local_k,
            local_sample=72,
            frontier_basins=4,
            recent_track_floor=0.03,
            fatigue_strength=0.44,
            homeostasis_strength=1.25,
            underuse_lift=0.18,
            fixed_stream_target=3,
            fixed_stream_strength=0.95,
            fixed_escape_strength=1.10,
        ),
        Policy(
            "route_field",
            beta=5.4,
            temperature=0.92,
            local_k=args.local_k,
            local_sample=72,
            frontier_basins=6,
            recent_track_floor=0.025,
            fatigue_strength=0.24,
            homeostasis_strength=1.45,
            underuse_lift=0.24,
            route_stream_strength=1.90,
            route_capture_strength=1.25,
            trajectory_strength=0.42,
            backtrack_strength=0.95,
            field_relaxation=0.16,
        ),
        Policy(
            "route_field_soft_gate",
            beta=5.0,
            temperature=1.02,
            local_k=args.local_k,
            local_sample=76,
            frontier_basins=6,
            recent_track_floor=0.025,
            fatigue_strength=0.28,
            homeostasis_strength=1.35,
            underuse_lift=0.24,
            route_stream_strength=1.35,
            route_capture_strength=1.05,
            trajectory_strength=0.36,
            backtrack_strength=0.80,
            field_relaxation=0.22,
            route_compression=3.20,
        ),
        Policy(
            "route_field_entropy_reserve",
            beta=5.0,
            temperature=1.04,
            local_k=args.local_k,
            local_sample=80,
            frontier_basins=6,
            recent_track_floor=0.025,
            fatigue_strength=0.30,
            homeostasis_strength=1.35,
            underuse_lift=0.24,
            route_stream_strength=1.35,
            route_capture_strength=1.05,
            trajectory_strength=0.36,
            backtrack_strength=0.80,
            field_relaxation=0.24,
            route_compression=3.00,
            entropy_reserve=0.24,
            entropy_reserve_width=2.20,
        ),
        Policy(
            "route_field_slow_homeostasis",
            beta=5.1,
            temperature=1.00,
            local_k=args.local_k,
            local_sample=80,
            frontier_basins=7,
            recent_track_floor=0.025,
            fatigue_strength=0.20,
            homeostasis_strength=1.05,
            underuse_lift=0.18,
            route_stream_strength=1.25,
            route_capture_strength=0.90,
            trajectory_strength=0.40,
            backtrack_strength=0.85,
            field_relaxation=0.22,
            route_compression=3.40,
            entropy_reserve=0.18,
            entropy_reserve_width=2.00,
        ),
        Policy(
            "log_like_collapse",
            beta=9.2,
            temperature=0.58,
            local_k=args.local_k,
            local_sample=72,
            frontier_basins=6,
            recent_track_floor=0.025,
            fatigue_strength=0.24,
            homeostasis_strength=1.45,
            underuse_lift=0.24,
            route_stream_strength=2.30,
            route_capture_strength=1.45,
            trajectory_strength=0.46,
            backtrack_strength=0.95,
            field_relaxation=0.08,
        ),
        Policy(
            "log_like_soft_reserve",
            beta=7.4,
            temperature=0.78,
            local_k=args.local_k,
            local_sample=80,
            frontier_basins=6,
            recent_track_floor=0.025,
            fatigue_strength=0.28,
            homeostasis_strength=1.30,
            underuse_lift=0.24,
            route_stream_strength=1.35,
            route_capture_strength=1.05,
            trajectory_strength=0.36,
            backtrack_strength=0.80,
            field_relaxation=0.28,
            route_compression=2.60,
            entropy_reserve=0.34,
            entropy_reserve_width=3.20,
        ),
        Policy(
            "overcorrected_jumpy",
            beta=4.2,
            temperature=1.08,
            local_k=args.local_k,
            local_sample=56,
            frontier_basins=12,
            recent_track_floor=0.02,
            fatigue_strength=0.90,
            homeostasis_strength=2.50,
            underuse_lift=0.55,
            route_stream_strength=0.35,
            route_capture_strength=3.20,
            trajectory_strength=0.12,
            backtrack_strength=0.25,
            field_relaxation=0.45,
        ),
        Policy(
            "sticky_attractor_failure",
            beta=6.1,
            temperature=0.78,
            local_k=args.local_k,
            local_sample=88,
            frontier_basins=1,
            recent_track_floor=0.05,
            fatigue_strength=0.18,
            homeostasis_strength=0.55,
            underuse_lift=0.02,
            fixed_stream_target=6,
            fixed_stream_strength=1.25,
            fixed_escape_strength=0.12,
        ),
    ]
    if args.policy:
        selected = set(args.policy)
        policies = [policy for policy in policies if policy.name in selected]
        missing = selected.difference(policy.name for policy in policies)
        if missing:
            raise SystemExit(f"unknown policy: {', '.join(sorted(missing))}")

    model = load_stable(args.stable, args.local_k)
    print(
        json.dumps(
            {
                "stable_generation": model.generation,
                "tracks": len(model.titles),
                "dim": int(model.x.shape[1]),
                "basins": len(model.basin_names),
                "local_k": args.local_k,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    basin_sizes = Counter(int(value) for value in model.basins)
    print(
        json.dumps(
            {
                "basin_sizes_top": [
                    (model.basin_names[idx], count) for idx, count in basin_sizes.most_common(10)
                ]
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )

    rows = [
        simulate_policy(model, policy, args.runs, args.steps, args.seed + idx * 1009)
        for idx, policy in enumerate(policies)
    ]
    metric_keys = [
        "policy",
        "switch_rate",
        "mean_run",
        "p50_run",
        "p90_run",
        "max_run",
        "singleton_run_share",
        "stream_2_to_5_share",
        "overlong_run_share",
        "basin_entropy",
        "basin_coverage",
        "top_basin_share",
        "top_track_share",
        "repeat_40_rate",
        "transition_mean",
        "transition_p10",
        "transition_p90",
        "choice_top_probability_p90",
        "choice_width_p10",
        "choice_width_p50",
        "score_spread_p90",
        "bigram_entropy",
    ]
    print("\nmetrics:")
    print(" | ".join(metric_keys))
    for row in rows:
        print(
            " | ".join(
                f"{row[key]:.4f}" if isinstance(row[key], float) else str(row[key])
                for key in metric_keys
            )
        )

    start_order = [
        idx
        for idx, _count in Counter(int(value) for value in model.basins).most_common(args.path_starts)
        for idx in [int(model.basin_members[idx][0])]
    ]
    diversity_policies = policies
    diversity_rows = [
        path_diversity(
            model,
            policy,
            start_order,
            args.path_repeats,
            args.path_steps,
            args.seed + 7777 + idx * 1009,
        )
        for idx, policy in enumerate(diversity_policies)
    ]
    print("\npath_diversity:")
    for row in diversity_rows:
        print(json.dumps(row, ensure_ascii=False, sort_keys=True))

    print("\nconcentration:")
    for row in rows:
        print(json.dumps(
            {
                "policy": row["policy"],
                "top_basins": row["top_basins"],
                "top_tracks": row["top_tracks"],
            },
            ensure_ascii=False,
            sort_keys=True,
        ))

    print("\nacceptance:")
    for line in acceptance(rows, diversity_rows):
        print(line)

    if args.sweep:
        print("\nsweep_top:")
        top = sweep_route_field(model, policies[2], rows[0], args)[:8]
        for score, policy, row, diversity in top:
            print(
                json.dumps(
                    {
                        "score": score,
                        "policy": policy.name,
                        "metrics": {
                            key: row[key]
                            for key in (
                                "switch_rate",
                                "mean_run",
                                "p90_run",
                                "max_run",
                                "singleton_run_share",
                                "stream_2_to_5_share",
                                "overlong_run_share",
                                "basin_entropy",
                                "top_basin_share",
                                "transition_p10",
                            )
                        },
                        "diversity": {
                            "unique_prefix_share": diversity["unique_prefix_share"],
                            "ending_entropy": diversity["ending_entropy"],
                        },
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
            )


if __name__ == "__main__":
    main()
