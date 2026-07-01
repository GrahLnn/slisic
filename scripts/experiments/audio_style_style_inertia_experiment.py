from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from statistics import median

import torch


DEFAULT_STABLE = r"C:/Users/admin/AppData/Local/slisic/audio-style-stable-model/stable.json"
TOP_K = 10
GAP_WEIGHT = 0.35
SEP_MIN = 0.55
SEP_MAX = 0.92
SEP_OFFSET = 0.08
NEAR_DUP = 0.985


@dataclass(frozen=True)
class Policy:
    name: str
    beta: float = 5.8
    temperature: float = 0.92
    selected_fatigue: float = 0.95
    fatigue_decay: float = 0.86
    homeostatic_strength: float = 2.60
    run_hazard_strength: float = 0.95
    inertia_strength: float = 0.0
    inertia_target_run: int = 1
    inertia_sigma: float = 1.0
    escape_after_run: int = 3
    escape_strength: float = 0.0
    adaptive_stream: bool = False
    adaptive_quality_strength: float = 1.0
    adaptive_fatigue_strength: float = 0.65
    adaptive_usage_strength: float = 1.20
    adaptive_run_strength: float = 0.55
    adaptive_support_strength: float = 1.15
    adaptive_support_neutral: float = 0.22
    frontier_reserve: int = 8


def load_stable(path: Path, device: torch.device):
    data = json.loads(path.read_text(encoding="utf-8"))
    state = data["state"]
    raw = torch.tensor(
        [entry["values"] for entry in state["embeddings"]],
        dtype=torch.float32,
        device=device,
    )
    raw = torch.nn.functional.normalize(raw, dim=1)
    mean = raw.mean(dim=0, keepdim=True)
    centered = torch.nn.functional.normalize(raw - mean, dim=1)
    titles = [entry["track"]["music_name"] for entry in state["indexed_tracks"]]
    collections = [entry["source"].get("collection_folder", "") for entry in state["indexed_tracks"]]
    return data["generation"], raw, centered, titles, collections


def rust_neighbor_basins(raw: torch.Tensor, centered: torch.Tensor):
    n = raw.shape[0]
    centered_sim = centered @ centered.T
    masked = centered_sim - torch.eye(n, device=raw.device) * 10.0
    neigh_vals, _neighbors = torch.topk(masked, k=min(TOP_K, n - 1), dim=1)
    local_density = neigh_vals.mean(dim=1)
    raw_sim = raw @ raw.T
    tail_mean = neigh_vals[:, -1].mean().item()
    separation_floor = max(SEP_MIN, min(SEP_MAX, tail_mean + SEP_OFFSET))
    local_gap = (neigh_vals[:, 0] - neigh_vals[:, -1]).clamp_min(0.0)
    peak_scores = local_density + GAP_WEIGHT * local_gap
    order = torch.argsort(peak_scores, descending=True)
    max_prototypes = min(n, max(1, int(math.sqrt(n)) + 2))
    prototypes: list[int] = []
    for idx_t in order:
        idx = int(idx_t.item())
        too_close = False
        for proto in prototypes:
            sim = float(raw_sim[idx, proto].item())
            if sim >= separation_floor or sim >= NEAR_DUP:
                too_close = True
                break
        if too_close:
            continue
        prototypes.append(idx)
        if len(prototypes) >= max_prototypes:
            break
    if not prototypes:
        prototypes = [0]
    proto_tensor = torch.tensor(prototypes, dtype=torch.long, device=raw.device)
    labels = torch.argmax(raw_sim[:, proto_tensor], dim=1).to(torch.long)
    return labels, proto_tensor, separation_floor


def entropy(counts: Counter, total: int):
    if total <= 0 or len(counts) <= 1:
        return 0.0
    h = 0.0
    for count in counts.values():
        p = count / total
        h -= p * math.log(max(p, 1e-12))
    return h / math.log(len(counts))


def run_lengths(values: list[int]) -> list[int]:
    runs: list[int] = []
    current = None
    run = 0
    for value in values:
        if value == current:
            run += 1
        else:
            if run > 0:
                runs.append(run)
            current = value
            run = 1
    if run > 0:
        runs.append(run)
    return runs


def q(values: list[float] | list[int], quantile: float):
    if not values:
        return 0.0
    ordered = sorted(float(value) for value in values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * quantile))]


def target_share_for_basins(labels: torch.Tensor):
    sizes = torch.bincount(labels, minlength=int(labels.max().item()) + 1).float()
    target = torch.sqrt(sizes.clamp_min(1.0))
    target = target / target.sum()
    return sizes, target


def members_by_basin(labels: torch.Tensor):
    return [
        torch.where(labels == cid)[0]
        for cid in range(int(labels.max().item()) + 1)
    ]


def current_run_state(selected_seq: list[int]) -> tuple[int | None, int]:
    if not selected_seq:
        return None, 0
    basin = selected_seq[-1]
    run = 0
    for value in reversed(selected_seq):
        if value != basin:
            break
        run += 1
    return basin, run


def stream_inertia_gate(
    candidate_basins: torch.Tensor,
    continuity: torch.Tensor,
    basin_fatigue: torch.Tensor,
    usage_share: torch.Tensor,
    target_share: torch.Tensor,
    current_basin: int | None,
    current_run: int,
    policy: Policy,
):
    gate = torch.ones(candidate_basins.numel(), dtype=torch.float32, device=candidate_basins.device)
    if current_basin is None or policy.inertia_strength <= 0.0 or current_run <= 0:
        return gate
    same = candidate_basins == current_basin
    if not same.any():
        return gate

    if policy.adaptive_stream:
        same_quality = continuity[same].max().clamp(-1.0, 1.0)
        other_quality = (
            continuity[~same].max().clamp(-1.0, 1.0)
            if (~same).any()
            else torch.tensor(-1.0, dtype=torch.float32, device=continuity.device)
        )
        # Continuation should not require the current stream to beat every challenger.
        # It only needs to remain close enough to be heard as the same coherent stream.
        quality_margin = (same_quality - other_quality + 0.10).clamp(-1.0, 1.0)
        support = same.float().mean().clamp(0.0, 1.0)
        field_support = (
            (support - policy.adaptive_support_neutral)
            / max(1.0 - policy.adaptive_support_neutral, 1.0e-6)
        ).clamp(-1.0, 1.0)
        fatigue = torch.relu(basin_fatigue[current_basin] - 1.0)
        overuse = torch.relu(usage_share[current_basin] - target_share[current_basin])
        run_pressure = math.log1p(max(current_run - 1, 0))
        continuation = (
            policy.adaptive_quality_strength * quality_margin
            + policy.adaptive_support_strength * field_support
            - policy.adaptive_fatigue_strength * fatigue
            - policy.adaptive_usage_strength * overuse
            - policy.adaptive_run_strength * run_pressure
        )
        gate[same] *= torch.exp(policy.inertia_strength * continuation.clamp(-3.2, 3.2)).clamp(0.04, 12.0)
        return gate

    target = max(1, policy.inertia_target_run)
    distance = max(0.0, float(current_run - target))
    comfort = math.exp(-((distance / max(policy.inertia_sigma, 1.0e-6)) ** 2))
    gate[same] *= math.exp(policy.inertia_strength * comfort)

    overflow = max(0, current_run - max(policy.escape_after_run, target))
    if overflow > 0 and policy.escape_strength > 0.0:
        gate[same] *= math.exp(-policy.escape_strength * overflow)
    return gate


def build_pool(
    current: int,
    sim: torch.Tensor,
    labels: torch.Tensor,
    basin_fatigue: torch.Tensor,
    sizes: torch.Tensor,
    members: list[torch.Tensor],
    recent_tracks: list[int],
    policy: Policy,
    g: torch.Generator,
):
    n = sim.shape[0]
    scores = sim[current].clone()
    scores[current] = -1.0e9
    if recent_tracks:
        scores[torch.tensor(recent_tracks[-32:], dtype=torch.long, device=sim.device)] = -1.0e9

    local_count = max(1, 96 - policy.frontier_reserve)
    local_top_count = min(n - 1, max(local_count * 4, 96))
    local = torch.topk(scores, k=local_top_count).indices
    local_probs = torch.softmax(scores[local] / 0.70, dim=0)
    local_pick = local[
        torch.multinomial(
            local_probs,
            min(local_count, local.numel()),
            replacement=False,
            generator=g,
        )
    ]
    chunks = [local_pick]

    if policy.frontier_reserve > 0:
        present = torch.zeros(int(labels.max().item()) + 1, dtype=torch.bool, device=sim.device)
        present[labels[local_pick]] = True
        cluster_score = basin_fatigue + 0.15 * torch.log1p(sizes) / torch.log1p(sizes.max())
        frontier = []
        for cid_t in torch.argsort(cluster_score, descending=False):
            cid = int(cid_t.item())
            if present[cid]:
                continue
            basin_members = members[cid]
            if basin_members.numel() == 0:
                continue
            values = scores[basin_members]
            finite = values > -1.0e8
            if not finite.any():
                continue
            basin_members = basin_members[finite]
            values = values[finite]
            frontier.append(basin_members[torch.topk(values, k=1).indices])
            if sum(chunk.numel() for chunk in frontier) >= policy.frontier_reserve:
                break
        if frontier:
            chunks.append(torch.cat(frontier)[: policy.frontier_reserve])
    return torch.unique(torch.cat(chunks))


def sample_next(
    current: int,
    previous: int | None,
    pool: torch.Tensor,
    sim: torch.Tensor,
    x: torch.Tensor,
    labels: torch.Tensor,
    basin_fatigue: torch.Tensor,
    basin_usage: torch.Tensor,
    target_share: torch.Tensor,
    selected_seq: list[int],
    policy: Policy,
    g: torch.Generator,
):
    candidate_basins = labels[pool]
    continuity = sim[current, pool].clamp(-1.0, 1.0)
    scores = policy.beta * continuity

    usage_total = basin_usage.clamp_min(0.0).sum()
    usage_share = basin_usage / usage_total if float(usage_total.item()) > 0.0 else torch.zeros_like(basin_usage)
    over_target = torch.relu(usage_share[candidate_basins] - target_share[candidate_basins])
    scores -= policy.homeostatic_strength * over_target
    scores -= policy.selected_fatigue * basin_fatigue[candidate_basins]

    current_basin, current_run = current_run_state(selected_seq)
    same_current = candidate_basins == current_basin if current_basin is not None else torch.zeros_like(candidate_basins, dtype=torch.bool)
    if same_current.any():
        scores[same_current] -= policy.run_hazard_strength * math.log(max(float(current_run), 1.0))

    inertia = stream_inertia_gate(
        candidate_basins,
        continuity,
        basin_fatigue,
        usage_share,
        target_share,
        current_basin,
        current_run,
        policy,
    )
    scores += torch.log(inertia.clamp_min(1.0e-6))

    if previous is not None:
        direction = torch.nn.functional.normalize((x[current] - x[previous]).view(1, -1), dim=1)[0]
        cand_direction = torch.nn.functional.normalize(x[pool] - x[current].view(1, -1), dim=1)
        momentum = cand_direction @ direction
        backtrack = torch.relu(sim[previous, pool] - 0.40)
        scores += 0.45 * momentum.clamp(-0.25, 0.75)
        scores -= 1.10 * backtrack

    probs = torch.softmax(scores / policy.temperature, dim=0)
    picked = int(torch.multinomial(probs, 1, generator=g).item())
    return int(pool[picked].item()), float(probs[picked].item()), float(inertia[picked].item())


def simulate(
    policy: Policy,
    x: torch.Tensor,
    sim: torch.Tensor,
    labels: torch.Tensor,
    sizes: torch.Tensor,
    target_share: torch.Tensor,
    members: list[torch.Tensor],
    runs: int,
    steps: int,
    seed: int,
):
    g = torch.Generator(device=x.device).manual_seed(seed)
    n = x.shape[0]
    clusters = int(labels.max().item()) + 1
    all_selected: list[int] = []
    transitions: list[float] = []
    probabilities: list[float] = []
    inertia_values: list[float] = []

    for _ in range(runs):
        current = int(torch.randint(0, n, (1,), device=x.device, generator=g).item())
        previous = None
        recent_tracks = [current]
        selected_seq = [int(labels[current].item())]
        basin_fatigue = torch.zeros(clusters, dtype=torch.float32, device=x.device)
        basin_usage = torch.zeros(clusters, dtype=torch.float32, device=x.device)
        basin = int(labels[current].item())
        basin_fatigue[basin] += 1.0
        basin_usage[basin] += 1.0
        all_selected.append(basin)

        for _step in range(steps - 1):
            basin_fatigue *= policy.fatigue_decay
            basin_usage *= 0.93
            pool = build_pool(
                current,
                sim,
                labels,
                basin_fatigue,
                sizes,
                members,
                recent_tracks,
                policy,
                g,
            )
            nxt, probability, inertia = sample_next(
                current,
                previous,
                pool,
                sim,
                x,
                labels,
                basin_fatigue,
                basin_usage,
                target_share,
                selected_seq,
                policy,
                g,
            )
            next_basin = int(labels[nxt].item())
            basin_fatigue[next_basin] += 1.0
            basin_usage[next_basin] += 1.0
            selected_seq.append(next_basin)
            all_selected.append(next_basin)
            transitions.append(float(sim[current, nxt].item()))
            probabilities.append(probability)
            inertia_values.append(inertia)
            previous, current = current, nxt
            recent_tracks.append(current)

    counts = Counter(all_selected)
    lengths = run_lengths(all_selected)
    total_steps = len(all_selected)
    switch_rate = sum(1 for a, b in zip(all_selected, all_selected[1:]) if a != b) / max(1, total_steps - 1)
    singleton_run_share = sum(1 for value in lengths if value == 1) / max(1, len(lengths))
    short_stream_share = sum(1 for value in lengths if 2 <= value <= 3) / max(1, len(lengths))
    long_run_share = sum(1 for value in lengths if value >= 5) / max(1, len(lengths))
    return {
        "policy": policy.name,
        "switch_rate": switch_rate,
        "mean_run": sum(lengths) / max(1, len(lengths)),
        "median_run": median(lengths) if lengths else 0.0,
        "p90_run": q(lengths, 0.90),
        "max_run": max(lengths) if lengths else 0,
        "singleton_run_share": singleton_run_share,
        "short_stream_share": short_stream_share,
        "long_run_share": long_run_share,
        "top_basin_share": max(counts.values()) / max(1, total_steps),
        "basin_entropy": entropy(counts, total_steps),
        "basin_coverage": len(counts),
        "transition_mean": sum(transitions) / max(1, len(transitions)),
        "transition_p10": q(transitions, 0.10),
        "transition_p90": q(transitions, 0.90),
        "mean_probability": sum(probabilities) / max(1, len(probabilities)),
        "mean_inertia_gate": sum(inertia_values) / max(1, len(inertia_values)),
        "top_counts": counts.most_common(8),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stable", default=DEFAULT_STABLE)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--runs", type=int, default=32)
    parser.add_argument("--steps", type=int, default=64)
    parser.add_argument("--seed", type=int, default=20260630)
    args = parser.parse_args()

    requested = torch.device(args.device)
    device = requested if requested.type == "cuda" and torch.cuda.is_available() else torch.device("cpu")
    generation, raw, x, _titles, _collections = load_stable(Path(args.stable), device)
    labels, _prototypes, sep = rust_neighbor_basins(raw, x)
    sizes, target_share = target_share_for_basins(labels)
    members = members_by_basin(labels)
    sim = x @ x.T

    print(
        f"stable generation={generation} tracks={x.shape[0]} dim={x.shape[1]} "
        f"basins={int(labels.max().item()) + 1} sep={sep:.3f} device={device}",
        flush=True,
    )
    print(
        "basin_sizes_top",
        sorted([(idx, int(value.item())) for idx, value in enumerate(sizes)], key=lambda item: item[1], reverse=True)[:12],
        flush=True,
    )

    policies = [
        Policy("current_like_escape"),
        Policy(
            "weak_stream_inertia",
            inertia_strength=0.38,
            inertia_target_run=2,
            inertia_sigma=1.15,
            escape_after_run=3,
            escape_strength=0.75,
        ),
        Policy(
            "balanced_stream_inertia",
            inertia_strength=0.72,
            inertia_target_run=3,
            inertia_sigma=1.20,
            escape_after_run=3,
            escape_strength=1.05,
        ),
        Policy(
            "adaptive_stream_mild",
            inertia_strength=0.75,
            run_hazard_strength=0.60,
            adaptive_stream=True,
            adaptive_quality_strength=1.10,
            adaptive_fatigue_strength=0.62,
            adaptive_usage_strength=1.35,
            adaptive_run_strength=0.38,
        ),
        Policy(
            "adaptive_stream_balanced",
            inertia_strength=2.40,
            run_hazard_strength=0.10,
            selected_fatigue=0.70,
            homeostatic_strength=2.70,
            adaptive_stream=True,
            adaptive_quality_strength=2.20,
            adaptive_fatigue_strength=0.45,
            adaptive_usage_strength=1.45,
            adaptive_run_strength=0.10,
            adaptive_support_strength=1.25,
            adaptive_support_neutral=0.08,
        ),
        Policy(
            "adaptive_stream_free_flow",
            inertia_strength=1.35,
            run_hazard_strength=0.35,
            selected_fatigue=0.82,
            adaptive_stream=True,
            adaptive_quality_strength=1.55,
            adaptive_fatigue_strength=0.82,
            adaptive_usage_strength=1.85,
            adaptive_run_strength=0.52,
        ),
        Policy(
            "strong_stream_inertia",
            inertia_strength=1.05,
            inertia_target_run=3,
            inertia_sigma=1.50,
            escape_after_run=4,
            escape_strength=0.70,
        ),
        Policy(
            "sticky_failure_case",
            selected_fatigue=0.55,
            homeostatic_strength=1.25,
            run_hazard_strength=0.30,
            inertia_strength=1.25,
            inertia_target_run=5,
            inertia_sigma=2.50,
            escape_after_run=6,
            escape_strength=0.25,
            frontier_reserve=4,
        ),
    ]

    rows = [
        simulate(
            policy,
            x,
            sim,
            labels,
            sizes,
            target_share,
            members,
            args.runs,
            args.steps,
            args.seed + i * 1009,
        )
        for i, policy in enumerate(policies)
    ]
    keys = [
        "policy",
        "switch_rate",
        "mean_run",
        "median_run",
        "p90_run",
        "max_run",
        "singleton_run_share",
        "short_stream_share",
        "long_run_share",
        "top_basin_share",
        "basin_entropy",
        "basin_coverage",
        "transition_mean",
        "transition_p10",
        "transition_p90",
        "mean_inertia_gate",
    ]
    print("\nmetrics:", flush=True)
    print(" | ".join(keys), flush=True)
    for row in rows:
        print(
            " | ".join(f"{row[key]:.4f}" if isinstance(row[key], float) else str(row[key]) for key in keys),
            flush=True,
        )
    print("\nconcentration:", flush=True)
    for row in rows:
        print(f"{row['policy']}: {row['top_counts']}", flush=True)


if __name__ == "__main__":
    main()
