#!/usr/bin/env python3
"""Compare modular-route and distributed-field audio-style walks.

This experiment uses Slisic's existing audio-style embedding cache. It does not
decode audio and does not mutate app state.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np


CURRENT_EMBEDDING_VERSION = "audio-style-watermark-transition-v3-measured-flow"


@dataclass(frozen=True)
class WalkMetrics:
    name: str
    steps: int
    mean_step_similarity: float
    p10_step_similarity: float
    region_entropy: float
    region_share_error: float
    max_region_run: int
    unique_region_share: float
    repeat_24_rate: float


def load_embeddings(
    cache_dir: Path,
    limit: int,
    seed: int,
    version: str,
) -> tuple[list[str], np.ndarray]:
    paths = sorted(cache_dir.glob("*.json"))
    rng = random.Random(seed)
    rng.shuffle(paths)
    keys: list[str] = []
    rows: list[np.ndarray] = []
    for path in paths:
        if len(rows) >= limit:
            break
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("version") != version:
                continue
            values = data.get("values")
        except Exception:
            continue
        if not isinstance(values, list):
            continue
        row = np.asarray(values, dtype=np.float32)
        norm = float(np.linalg.norm(row))
        if not math.isfinite(norm) or norm <= 1.0e-8:
            continue
        rows.append(row / norm)
        keys.append(path.stem)
    if len(rows) < 64:
        raise RuntimeError(f"not enough embeddings loaded from {cache_dir}: {len(rows)}")
    widths: dict[int, int] = {}
    for row in rows:
        widths[len(row)] = widths.get(len(row), 0) + 1
    width = max(widths, key=widths.get)
    filtered = [(key, row) for key, row in zip(keys, rows) if len(row) == width]
    keys = [key for key, _ in filtered]
    rows = [row for _, row in filtered]
    if len(rows) < 64:
        raise RuntimeError(
            f"not enough same-width embeddings loaded from {cache_dir}: {len(rows)} width={width}"
        )
    return keys, np.stack(rows, axis=0)


def build_regions(embeddings: np.ndarray, sample_size: int) -> np.ndarray:
    sample = embeddings[: min(sample_size, len(embeddings))]
    similarity = sample @ sample.T
    np.fill_diagonal(similarity, -2.0)
    density = np.partition(similarity, -11, axis=1)[:, -10:].mean(axis=1)
    nearest = similarity.argmax(axis=1)
    local_region = np.arange(len(sample), dtype=np.int32)
    better = density[nearest] > density
    local_region[better] = nearest[better]
    if len(sample) == len(embeddings):
        return local_region
    assigned = embeddings @ sample.T
    return local_region[assigned.argmax(axis=1)]


def target_region_share(regions: np.ndarray) -> dict[int, float]:
    counts: dict[int, int] = {}
    for region in regions:
        counts[int(region)] = counts.get(int(region), 0) + 1
    total = sum(math.sqrt(count) for count in counts.values())
    return {region: math.sqrt(count) / total for region, count in counts.items()}


def softmax_sample(weights: np.ndarray, rng: np.random.Generator) -> int:
    total = float(weights.sum())
    if not math.isfinite(total) or total <= 0.0:
        return int(rng.integers(0, len(weights)))
    return int(np.searchsorted(np.cumsum(weights), rng.random() * total, side="right"))


def modular_route_step(
    similarities: np.ndarray,
    candidate_indices: np.ndarray,
    candidate_regions: np.ndarray,
    region_usage: dict[int, float],
    recent_regions: list[int],
    rng: np.random.Generator,
) -> int:
    sim = similarities[candidate_indices]
    distance_base = np.exp(6.0 * np.clip(sim, -1.0, 1.0))
    penalties = np.zeros_like(distance_base)
    for i, region in enumerate(candidate_regions):
        usage = region_usage.get(int(region), 0.0)
        if recent_regions and int(region) == recent_regions[-1]:
            usage += math.log1p(sum(1 for r in reversed(recent_regions[-12:]) if r == int(region)))
        penalties[i] = min(1.25, 0.33 * usage)
    return int(candidate_indices[softmax_sample(distance_base * np.exp(-penalties), rng)])


def distributed_field_step(
    similarities: np.ndarray,
    candidate_indices: np.ndarray,
    candidate_regions: np.ndarray,
    region_usage: dict[int, float],
    target_share: dict[int, float],
    recent_indices: list[int],
    recent_regions: list[int],
    rng: np.random.Generator,
    region_fatigue: float,
    repeat_gate_floor: float,
    homeostasis_strength: float,
    run_hazard_strength: float,
) -> int:
    sim = np.clip(similarities[candidate_indices], -1.0, 1.0)
    base = np.exp(5.4 * sim)

    if recent_indices:
        recent_set = set(recent_indices[-24:])
        repeat_gate = np.asarray(
            [repeat_gate_floor if int(idx) in recent_set else 1.0 for idx in candidate_indices],
            dtype=np.float32,
        )
    else:
        repeat_gate = np.ones_like(base)

    usage_total = sum(max(v, 0.0) for v in region_usage.values())
    usage_share = {
        region: (value / usage_total if usage_total > 0.0 else 0.0)
        for region, value in region_usage.items()
    }
    homeostasis = np.asarray(
        [
            math.exp(1.15 * max(target_share.get(int(region), 0.0) - usage_share.get(int(region), 0.0), 0.0))
            / math.exp(
                homeostasis_strength
                * max(usage_share.get(int(region), 0.0) - target_share.get(int(region), 0.0), 0.0)
            )
            for region in candidate_regions
        ],
        dtype=np.float32,
    )

    recent_same = np.asarray(
        [
            sum(1 for region in recent_regions[-16:] if region == int(candidate_region))
            for candidate_region in candidate_regions
        ],
        dtype=np.float32,
    )
    distributed_fatigue = 1.0 / (1.0 + region_fatigue * recent_same)
    if recent_regions:
        current_region = recent_regions[-1]
        run_len = 0
        for region in reversed(recent_regions):
            if region != current_region:
                break
            run_len += 1
        run_hazard = np.asarray(
            [
                1.0 / (1.0 + run_hazard_strength * max(run_len - 1, 0))
                if int(candidate_region) == current_region
                else 1.0
                for candidate_region in candidate_regions
            ],
            dtype=np.float32,
        )
    else:
        run_hazard = np.ones_like(base)

    # A small fixed-point relaxation: each candidate is pulled by continuity but
    # pushed away from local crowding in the same candidate field.
    field = base * repeat_gate * homeostasis * distributed_fatigue * run_hazard
    field = field / max(float(field.sum()), 1.0e-8)
    for _ in range(10):
        crowding = np.minimum(0.35, field * len(field))
        target = (
            base
            * repeat_gate
            * homeostasis
            * distributed_fatigue
            * run_hazard
            / (1.0 + 0.18 * crowding)
        )
        target = target / max(float(target.sum()), 1.0e-8)
        field = 0.72 * field + 0.28 * target
    return int(candidate_indices[softmax_sample(field, rng)])


def run_walk(
    name: str,
    embeddings: np.ndarray,
    regions: np.ndarray,
    steps: int,
    candidate_k: int,
    seed: int,
    mode: str,
    region_fatigue: float = 0.32,
    repeat_gate_floor: float = 0.08,
    homeostasis_strength: float = 1.55,
    run_hazard_strength: float = 0.22,
) -> WalkMetrics:
    rng = np.random.default_rng(seed)
    target_share = target_region_share(regions)
    current = int(rng.integers(0, len(embeddings)))
    recent_indices: list[int] = []
    recent_regions: list[int] = []
    step_similarities: list[float] = []
    region_counts: dict[int, int] = {}
    region_usage: dict[int, float] = {}

    for _ in range(steps):
        similarities = embeddings @ embeddings[current]
        candidate_count = min(candidate_k + 1, len(embeddings))
        candidates = np.argpartition(similarities, -candidate_count)[-candidate_count:]
        candidates = candidates[candidates != current]
        if len(candidates) > candidate_k:
            candidates = candidates[:candidate_k]
        candidate_regions = regions[candidates]

        for region in list(region_usage):
            region_usage[region] *= 0.93
            if region_usage[region] < 1.0e-4:
                del region_usage[region]

        if mode == "modular":
            nxt = modular_route_step(similarities, candidates, candidate_regions, region_usage, recent_regions, rng)
        elif mode == "distributed":
            nxt = distributed_field_step(
                similarities,
                candidates,
                candidate_regions,
                region_usage,
                target_share,
                recent_indices,
                recent_regions,
                rng,
                region_fatigue,
                repeat_gate_floor,
                homeostasis_strength,
                run_hazard_strength,
            )
        else:
            raise ValueError(mode)

        region = int(regions[nxt])
        step_similarities.append(float(similarities[nxt]))
        region_counts[region] = region_counts.get(region, 0) + 1
        region_usage[region] = region_usage.get(region, 0.0) + 1.0
        recent_indices.append(nxt)
        recent_regions.append(region)
        current = nxt

    shares = {region: count / steps for region, count in region_counts.items()}
    entropy = -sum(share * math.log(max(share, 1.0e-12)) for share in shares.values())
    max_entropy = math.log(max(len(shares), 1))
    normalized_entropy = entropy / max(max_entropy, 1.0e-8)
    share_error = sum(abs(shares.get(region, 0.0) - target_share.get(region, 0.0)) for region in set(shares) | set(target_share))
    max_run = 1
    run = 1
    for left, right in zip(recent_regions, recent_regions[1:]):
        if left == right:
            run += 1
            max_run = max(max_run, run)
        else:
            run = 1
    repeat_24 = 0
    seen_window: list[int] = []
    for idx in recent_indices:
        if idx in seen_window:
            repeat_24 += 1
        seen_window.append(idx)
        seen_window = seen_window[-24:]
    sim_array = np.asarray(step_similarities, dtype=np.float32)
    return WalkMetrics(
        name=name,
        steps=steps,
        mean_step_similarity=float(sim_array.mean()),
        p10_step_similarity=float(np.quantile(sim_array, 0.10)),
        region_entropy=normalized_entropy,
        region_share_error=share_error,
        max_region_run=max_run,
        unique_region_share=len(set(recent_regions)) / max(len(set(regions.tolist())), 1),
        repeat_24_rate=repeat_24 / steps,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", type=Path, default=Path.home() / "AppData/Local/slisic/audio-style-embeddings")
    parser.add_argument("--limit", type=int, default=1800)
    parser.add_argument("--region-sample", type=int, default=900)
    parser.add_argument("--steps", type=int, default=1200)
    parser.add_argument("--candidate-k", type=int, default=96)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--version", default=CURRENT_EMBEDDING_VERSION)
    parser.add_argument("--sweep", action="store_true")
    parser.add_argument("--region-fatigue", type=float, default=0.55)
    parser.add_argument("--repeat-gate-floor", type=float, default=0.08)
    parser.add_argument("--homeostasis-strength", type=float, default=1.55)
    parser.add_argument("--run-hazard-strength", type=float, default=0.40)
    args = parser.parse_args()

    started = time.perf_counter()
    keys, embeddings = load_embeddings(args.cache_dir, args.limit, args.seed, args.version)
    regions = build_regions(embeddings, args.region_sample)
    print(json.dumps(
        {
            "loaded_embeddings": len(keys),
            "width": int(embeddings.shape[1]),
            "regions": len(set(regions.tolist())),
            "elapsed_load_s": round(time.perf_counter() - started, 3),
        },
        ensure_ascii=False,
    ))

    rows = [run_walk("modular_route", embeddings, regions, args.steps, args.candidate_k, args.seed + 1, "modular")]
    if args.sweep:
        for region_fatigue in (0.28, 0.40, 0.55):
            for repeat_floor in (0.04, 0.08, 0.14):
                for homeostasis in (1.55, 2.10):
                    for run_hazard in (0.22, 0.40):
                        rows.append(
                            run_walk(
                                f"distributed_field rf={region_fatigue:.2f} repeat={repeat_floor:.2f} homeo={homeostasis:.2f} run={run_hazard:.2f}",
                                embeddings,
                                regions,
                                args.steps,
                                args.candidate_k,
                                args.seed + 1,
                                "distributed",
                                region_fatigue=region_fatigue,
                                repeat_gate_floor=repeat_floor,
                                homeostasis_strength=homeostasis,
                                run_hazard_strength=run_hazard,
                            )
                        )
    else:
        rows.append(
            run_walk(
                "distributed_field",
                embeddings,
                regions,
                args.steps,
                args.candidate_k,
                args.seed + 1,
                "distributed",
                region_fatigue=args.region_fatigue,
                repeat_gate_floor=args.repeat_gate_floor,
                homeostasis_strength=args.homeostasis_strength,
                run_hazard_strength=args.run_hazard_strength,
            )
        )
    for row in rows:
        print(json.dumps(row.__dict__, ensure_ascii=False, sort_keys=True))

    modular = rows[0]
    scored = []
    for distributed in rows[1:]:
        delta = {
            "mean_step_similarity": distributed.mean_step_similarity - modular.mean_step_similarity,
            "region_entropy": distributed.region_entropy - modular.region_entropy,
            "region_share_error": distributed.region_share_error - modular.region_share_error,
            "max_region_run": distributed.max_region_run - modular.max_region_run,
            "repeat_24_rate": distributed.repeat_24_rate - modular.repeat_24_rate,
        }
        score = (
            2.0 * delta["region_entropy"]
            - 0.6 * max(-delta["mean_step_similarity"], 0.0)
            - 0.8 * max(delta["max_region_run"], 0.0)
            - 4.0 * delta["repeat_24_rate"]
            - 0.5 * delta["region_share_error"]
        )
        scored.append((score, distributed.name, delta))
    for score, name, delta in sorted(scored, reverse=True)[:5]:
        print(json.dumps({"score": score, "name": name, "delta": delta}, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
