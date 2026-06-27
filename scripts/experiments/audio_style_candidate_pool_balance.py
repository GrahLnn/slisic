from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import torch

DEFAULT_STABLE = r"C:/Users/admin/AppData/Local/slisic/audio-style-stable-model/stable.json"
TOP_K = 10
GAP_WEIGHT = 0.35
SEP_MIN = 0.55
SEP_MAX = 0.92
SEP_OFFSET = 0.08
NEAR_DUP = 0.985


@dataclass(frozen=True)
class PoolPolicy:
    name: str
    local_temperature: float = 0.70
    quota_power: float = 1.00
    min_per_basin: int = 0
    basin_soft_cap: int = 0
    reserve_fraction: float = 0.0
    reserve_temperature: float = 0.85
    pressure_alpha: float = 0.0
    pressure_decay: float = 0.90


def load_stable(path: Path, device: torch.device):
    data = json.loads(path.read_text(encoding="utf-8"))
    state = data["state"]
    raw = torch.tensor([entry["values"] for entry in state["embeddings"]], dtype=torch.float32, device=device)
    raw = torch.nn.functional.normalize(raw, dim=1)
    mean = raw.mean(dim=0, keepdim=True)
    centered = torch.nn.functional.normalize(raw - mean, dim=1)
    titles = [entry["track"]["music_name"] for entry in state["indexed_tracks"]]
    paths = [entry["track"]["file_path"] for entry in state["indexed_tracks"]]
    return data["generation"], raw, centered, titles, paths


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
    return labels, raw_sim, centered_sim, separation_floor


def entropy(counts: Counter, total: int):
    if total <= 0 or len(counts) <= 1:
        return 0.0
    return -sum((count / total) * math.log(max(count / total, 1e-12)) for count in counts.values()) / math.log(len(counts))


def longest_run(values: list[int]):
    best = 0
    cur = None
    run = 0
    for value in values:
        if value == cur:
            run += 1
        else:
            cur = value
            run = 1
        best = max(best, run)
    return best


def candidate_pool_baseline(scores: torch.Tensor, pool_size: int, policy: PoolPolicy, g: torch.Generator):
    top_count = min(scores.numel(), max(pool_size * 4, pool_size))
    local = torch.topk(scores, k=top_count).indices
    probs = torch.softmax(scores[local] / policy.local_temperature, dim=0)
    take = min(pool_size, local.numel())
    return local[torch.multinomial(probs, take, replacement=False, generator=g)]


def basin_quota_targets(
    labels: torch.Tensor,
    scores: torch.Tensor,
    pressure: torch.Tensor,
    pool_size: int,
    policy: PoolPolicy,
):
    clusters = int(labels.max().item()) + 1
    sizes = torch.bincount(labels, minlength=clusters).float()
    active = torch.zeros(clusters, dtype=torch.bool, device=labels.device)
    basin_quality = torch.full((clusters,), -1.0e9, dtype=torch.float32, device=labels.device)
    for cid in range(clusters):
        members = torch.where(labels == cid)[0]
        if members.numel() == 0:
            continue
        values = scores[members]
        finite = values > -1.0e8
        if not finite.any():
            continue
        active[cid] = True
        basin_quality[cid] = torch.topk(values[finite], k=min(4, int(finite.sum().item()))).values.mean()
    active_count = int(active.sum().item())
    if active_count == 0:
        return torch.zeros(clusters, dtype=torch.long, device=labels.device)

    pressure_gate = torch.exp(-policy.pressure_alpha * pressure).clamp(0.12, 1.0)
    mass = (sizes.sqrt().clamp_min(1.0) ** policy.quota_power) * pressure_gate
    quality = torch.softmax((basin_quality[active] - policy.pressure_alpha * pressure[active]) / 0.65, dim=0)
    target_weight = mass[active] / mass[active].sum()
    target_weight = 0.55 * target_weight + 0.45 * quality
    raw = target_weight * pool_size
    quotas = torch.zeros(clusters, dtype=torch.long, device=labels.device)
    active_ids = torch.where(active)[0]
    base = torch.floor(raw).long()
    if policy.min_per_basin > 0:
        base = torch.maximum(base, torch.ones_like(base) * policy.min_per_basin)
    if policy.basin_soft_cap > 0:
        base = torch.minimum(base, torch.ones_like(base) * policy.basin_soft_cap)
    quotas[active_ids] = base
    remaining = pool_size - int(quotas.sum().item())
    if remaining > 0:
        frac = raw - torch.floor(raw)
        order = torch.argsort(frac, descending=True)
        for idx in order[:remaining]:
            cid = active_ids[idx]
            if policy.basin_soft_cap > 0 and quotas[cid] >= policy.basin_soft_cap:
                continue
            quotas[cid] += 1
    elif remaining < 0:
        order = torch.argsort(quotas[active_ids].float() - raw, descending=True)
        for idx in order:
            if remaining == 0:
                break
            cid = active_ids[idx]
            floor = policy.min_per_basin if policy.min_per_basin > 0 else 0
            if quotas[cid] > floor:
                quotas[cid] -= 1
                remaining += 1
    return quotas.clamp_min(0)


def candidate_pool_quota(
    scores: torch.Tensor,
    labels: torch.Tensor,
    pressure: torch.Tensor,
    pool_size: int,
    policy: PoolPolicy,
    g: torch.Generator,
):
    quotas = basin_quota_targets(labels, scores, pressure, pool_size, policy)
    chunks = []
    for cid in torch.where(quotas > 0)[0]:
        quota = int(quotas[cid].item())
        members = torch.where(labels == cid)[0]
        values = scores[members]
        finite = values > -1.0e8
        if not finite.any():
            continue
        members = members[finite]
        values = values[finite]
        take = min(quota, members.numel())
        top = torch.topk(values, k=min(max(take * 4, take), members.numel())).indices
        local = members[top]
        probs = torch.softmax(scores[local] / policy.local_temperature, dim=0)
        chunks.append(local[torch.multinomial(probs, take, replacement=False, generator=g)])
    if chunks:
        pool = torch.unique(torch.cat(chunks))
    else:
        pool = torch.empty(0, dtype=torch.long, device=scores.device)

    reserve = int(round(pool_size * policy.reserve_fraction))
    if reserve > 0 and pool.numel() < pool_size:
        mask = torch.ones(scores.numel(), dtype=torch.bool, device=scores.device)
        if pool.numel() > 0:
            mask[pool] = False
        candidates = torch.where(mask & (scores > -1.0e8))[0]
        if candidates.numel() > 0:
            values = scores[candidates]
            local = candidates[torch.topk(values, k=min(max(reserve * 6, reserve), candidates.numel())).indices]
            probs = torch.softmax(scores[local] / policy.reserve_temperature, dim=0)
            extra = local[torch.multinomial(probs, min(reserve, local.numel()), replacement=False, generator=g)]
            pool = torch.unique(torch.cat([pool, extra]))
    if pool.numel() > pool_size:
        values = scores[pool]
        pool = pool[torch.topk(values, k=pool_size).indices]
    if pool.numel() < pool_size:
        mask = torch.ones(scores.numel(), dtype=torch.bool, device=scores.device)
        if pool.numel() > 0:
            mask[pool] = False
        candidates = torch.where(mask & (scores > -1.0e8))[0]
        if candidates.numel() > 0:
            values = scores[candidates]
            extra = candidates[torch.topk(values, k=min(pool_size - pool.numel(), candidates.numel())).indices]
            pool = torch.unique(torch.cat([pool, extra]))
    return pool


def summarize_pool(pool: torch.Tensor, labels: torch.Tensor):
    counts = Counter(int(value) for value in labels[pool].detach().cpu().tolist())
    top = counts.most_common(4)
    return top[0][0], top[0][1] / max(1, pool.numel()), top


def simulate(policy: PoolPolicy, sim: torch.Tensor, labels: torch.Tensor, pool_size: int, runs: int, steps: int, seed: int):
    g = torch.Generator(device=sim.device).manual_seed(seed)
    n = sim.shape[0]
    top_seq: list[int] = []
    top_shares: list[float] = []
    coverage: list[int] = []
    pool_sizes: list[int] = []
    for _ in range(runs):
        current = int(torch.randint(0, n, (1,), device=sim.device, generator=g).item())
        recent = [current]
        pressure = torch.zeros(int(labels.max().item()) + 1, dtype=torch.float32, device=sim.device)
        for _ in range(steps):
            pressure *= policy.pressure_decay
            scores = sim[current].clone()
            scores[current] = -1.0e9
            if recent:
                scores[torch.tensor(recent[-24:], dtype=torch.long, device=sim.device)] = -1.0e9
            if policy.name == "baseline_random_window":
                pool = candidate_pool_baseline(scores, pool_size, policy, g)
            else:
                pool = candidate_pool_quota(scores, labels, pressure, pool_size, policy, g)
            top_cluster, top_share, _top = summarize_pool(pool, labels)
            pressure[top_cluster] += 1.0
            top_seq.append(top_cluster)
            top_shares.append(top_share)
            coverage.append(len(set(labels[pool].detach().cpu().tolist())))
            pool_sizes.append(int(pool.numel()))
            # Advance with the strongest member to stress candidate field continuity.
            current = int(pool[torch.argmax(scores[pool])].item())
            recent.append(current)
    counts = Counter(top_seq)
    return {
        "policy": policy.name,
        "top_share": max(counts.values()) / len(top_seq),
        "entropy": entropy(counts, len(top_seq)),
        "longest_run": longest_run(top_seq),
        "same_step": sum(1 for a, b in zip(top_seq, top_seq[1:]) if a == b) / max(1, len(top_seq) - 1),
        "mean_top_fraction": sum(top_shares) / len(top_shares),
        "p90_top_fraction": sorted(top_shares)[int(0.90 * (len(top_shares) - 1))],
        "mean_basin_coverage": sum(coverage) / len(coverage),
        "mean_pool_size": sum(pool_sizes) / len(pool_sizes),
        "top_counts": counts.most_common(8),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stable", default=DEFAULT_STABLE)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--runs", type=int, default=64)
    parser.add_argument("--steps", type=int, default=64)
    parser.add_argument("--pool-size", type=int, default=96)
    parser.add_argument("--seed", type=int, default=20260620)
    args = parser.parse_args()

    device = torch.device(args.device if torch.cuda.is_available() and args.device.startswith("cuda") else "cpu")
    generation, raw, centered, _titles, _paths = load_stable(Path(args.stable), device)
    labels, _raw_sim, centered_sim, sep = rust_neighbor_basins(raw, centered)
    sizes = torch.bincount(labels, minlength=int(labels.max().item()) + 1)
    print(
        f"stable generation={generation} tracks={raw.shape[0]} dim={raw.shape[1]} "
        f"basins={int(labels.max().item()) + 1} sep={sep:.3f} device={device}",
        flush=True,
    )
    print(
        "basin_sizes_top",
        sorted([(i, int(v.item())) for i, v in enumerate(sizes)], key=lambda pair: pair[1], reverse=True)[:10],
        flush=True,
    )
    policies = [
        PoolPolicy("baseline_random_window"),
        PoolPolicy("sqrt_quota", quota_power=1.0, min_per_basin=1, reserve_fraction=0.05),
        PoolPolicy("soft_cap_12", quota_power=0.85, min_per_basin=1, basin_soft_cap=12, reserve_fraction=0.08),
        PoolPolicy("soft_cap_8", quota_power=0.65, min_per_basin=1, basin_soft_cap=8, reserve_fraction=0.10),
        PoolPolicy("flat_cap_6", quota_power=0.25, min_per_basin=1, basin_soft_cap=6, reserve_fraction=0.12),
        PoolPolicy(
            "soft_cap_8_pressure",
            quota_power=0.65,
            min_per_basin=1,
            basin_soft_cap=8,
            reserve_fraction=0.10,
            pressure_alpha=0.55,
            pressure_decay=0.88,
        ),
        PoolPolicy(
            "soft_cap_8_strong_pressure",
            quota_power=0.65,
            min_per_basin=1,
            basin_soft_cap=8,
            reserve_fraction=0.10,
            pressure_alpha=0.85,
            pressure_decay=0.86,
        ),
    ]
    rows = [
        simulate(policy, centered_sim, labels, args.pool_size, args.runs, args.steps, args.seed + index * 1009)
        for index, policy in enumerate(policies)
    ]
    keys = [
        "policy",
        "top_share",
        "entropy",
        "longest_run",
        "same_step",
        "mean_top_fraction",
        "p90_top_fraction",
        "mean_basin_coverage",
        "mean_pool_size",
    ]
    print("\nmetrics:", flush=True)
    print(" | ".join(keys), flush=True)
    for row in rows:
        print(" | ".join(f"{row[key]:.4f}" if isinstance(row[key], float) else str(row[key]) for key in keys), flush=True)
    print("\nconcentration:", flush=True)
    for row in rows:
        print(row["policy"], row["top_counts"], flush=True)
    print("\nacceptance:", flush=True)
    print("  candidate top entropy should rise, longest_run should fall, and mean_basin_coverage should stay high.", flush=True)
    print("  avoid policies that flatten so hard that every candidate field becomes nearly uniform.", flush=True)


if __name__ == "__main__":
    main()
