from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import torch

DEFAULT_STABLE = r"C:/Users/admin/AppData/Local/slisic/audio-style-model-evidence/stable.json"
TOP_K = 10
GAP_WEIGHT = 0.35
SEP_MIN = 0.55
SEP_MAX = 0.92
SEP_OFFSET = 0.08
NEAR_DUP = 0.985


@dataclass(frozen=True)
class PoolPolicy:
    name: str
    kind: str
    local_temperature: float = 0.70
    basin_temperature: float = 0.46
    mass_weight: float = 0.22
    cap_multiplier: float = 2.70
    min_cap: int = 5
    max_cap: int = 10
    min_active_basins: int = 24
    reserve_fraction: float = 0.08


def load_stable(path: Path, device: torch.device):
    data = json.loads(path.read_text(encoding="utf-8"))
    raw = torch.tensor([entry["values"] for entry in data["embeddings"]], dtype=torch.float32, device=device)
    raw = torch.nn.functional.normalize(raw, dim=1)
    mean = raw.mean(dim=0, keepdim=True)
    centered = torch.nn.functional.normalize(raw - mean, dim=1)
    return data["generation"], raw, centered


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
    return labels, separation_floor


def expand_scenario(
    raw: torch.Tensor,
    centered: torch.Tensor,
    labels: torch.Tensor,
    scenario: str,
    seed: int,
):
    if scenario == "base":
        return raw, centered, labels
    g = torch.Generator(device=raw.device).manual_seed(seed)
    sizes = torch.bincount(labels, minlength=int(labels.max().item()) + 1)
    largest = int(torch.argmax(sizes).item())
    members = torch.where(labels == largest)[0]
    if scenario == "largest_basin_2x":
        repeats = 1
    elif scenario == "largest_basin_4x":
        repeats = 3
    else:
        raise ValueError(f"unknown scenario: {scenario}")
    clones_raw = []
    clones_centered = []
    clones_labels = []
    for _ in range(repeats):
        noise = torch.randn((members.numel(), raw.shape[1]), generator=g, device=raw.device) * 0.006
        clones_raw.append(torch.nn.functional.normalize(raw[members] + noise, dim=1))
        clones_centered.append(torch.nn.functional.normalize(centered[members] + noise, dim=1))
        clones_labels.append(torch.full((members.numel(),), largest, dtype=torch.long, device=raw.device))
    return (
        torch.cat([raw, *clones_raw], dim=0),
        torch.cat([centered, *clones_centered], dim=0),
        torch.cat([labels, *clones_labels], dim=0),
    )


def sample_baseline_pool(scores: torch.Tensor, pool_size: int, policy: PoolPolicy, g: torch.Generator):
    top_count = min(scores.numel(), max(pool_size * 4, pool_size))
    local = torch.topk(scores, k=top_count).indices
    probs = torch.softmax(scores[local] / policy.local_temperature, dim=0)
    return local[torch.multinomial(probs, min(pool_size, local.numel()), replacement=False, generator=g)]


def quota_cap(pool_size: int, active_basin_count: int, policy: PoolPolicy):
    if active_basin_count <= 0:
        return policy.max_cap
    average = pool_size / active_basin_count
    return max(policy.min_cap, min(policy.max_cap, math.ceil(average * policy.cap_multiplier)))


def waterfill_quotas(raw: torch.Tensor, active_ids: torch.Tensor, cap: int, pool_size: int):
    raw = raw.clamp_min(0.0)
    if raw.sum() <= 0:
        raw = torch.ones_like(raw)
    raw = raw / raw.sum() * pool_size
    quotas = torch.floor(raw).long().clamp(min=0, max=cap)
    remaining = pool_size - int(quotas.sum().item())
    if remaining > 0:
        frac = raw - torch.floor(raw)
        order = torch.argsort(frac, descending=True)
        for idx in order.tolist():
            if remaining == 0:
                break
            if quotas[idx] >= cap:
                continue
            quotas[idx] += 1
            remaining -= 1
    elif remaining < 0:
        order = torch.argsort(quotas.float() - raw, descending=True)
        for idx in order.tolist():
            if remaining == 0:
                break
            if quotas[idx] <= 0:
                continue
            quotas[idx] -= 1
            remaining += 1
    result = torch.zeros(int(active_ids.max().item()) + 1, dtype=torch.long, device=active_ids.device)
    result[active_ids] = quotas
    return result


def sample_partition_pool(
    scores: torch.Tensor,
    labels: torch.Tensor,
    pool_size: int,
    policy: PoolPolicy,
    g: torch.Generator,
):
    clusters = int(labels.max().item()) + 1
    sizes = torch.bincount(labels, minlength=clusters).float()
    quality = torch.full((clusters,), -1.0e9, dtype=torch.float32, device=scores.device)
    active = torch.zeros(clusters, dtype=torch.bool, device=scores.device)
    for cid in range(clusters):
        members = torch.where(labels == cid)[0]
        if members.numel() == 0:
            continue
        values = scores[members]
        finite = values > -1.0e8
        if not finite.any():
            continue
        active[cid] = True
        quality[cid] = torch.topk(values[finite], k=min(4, int(finite.sum().item()))).values.mean()
    active_ids = torch.where(active)[0]
    if active_ids.numel() == 0:
        return sample_baseline_pool(scores, pool_size, policy, g)
    active_count = max(policy.min_active_basins, int(active_ids.numel()))
    cap = quota_cap(pool_size, active_count, policy)
    basin_logits = quality[active_ids] / policy.basin_temperature
    basin_logits += policy.mass_weight * torch.log1p(sizes[active_ids].sqrt())
    target = torch.softmax(basin_logits, dim=0)
    quotas = waterfill_quotas(target, active_ids, cap, pool_size)
    chunks = []
    for cid_t in torch.where(quotas > 0)[0]:
        quota = int(quotas[cid_t].item())
        members = torch.where(labels == cid_t)[0]
        values = scores[members]
        finite = values > -1.0e8
        if not finite.any():
            continue
        members = members[finite]
        values = values[finite]
        top = torch.topk(values, k=min(max(quota * 4, quota), members.numel())).indices
        local = members[top]
        probs = torch.softmax(scores[local] / policy.local_temperature, dim=0)
        chunks.append(local[torch.multinomial(probs, min(quota, local.numel()), replacement=False, generator=g)])
    pool = torch.unique(torch.cat(chunks)) if chunks else torch.empty(0, dtype=torch.long, device=scores.device)
    reserve = int(round(pool_size * policy.reserve_fraction))
    if reserve > 0 and pool.numel() < pool_size:
        mask = torch.ones(scores.numel(), dtype=torch.bool, device=scores.device)
        if pool.numel() > 0:
            mask[pool] = False
        candidates = torch.where(mask & (scores > -1.0e8))[0]
        if candidates.numel() > 0:
            values = scores[candidates]
            local = candidates[torch.topk(values, k=min(max(reserve * 8, reserve), candidates.numel())).indices]
            probs = torch.softmax(scores[local] / policy.local_temperature, dim=0)
            extra = local[torch.multinomial(probs, min(reserve, local.numel()), replacement=False, generator=g)]
            pool = torch.unique(torch.cat([pool, extra]))
    if pool.numel() < pool_size:
        mask = torch.ones(scores.numel(), dtype=torch.bool, device=scores.device)
        if pool.numel() > 0:
            mask[pool] = False
        candidates = torch.where(mask & (scores > -1.0e8))[0]
        if candidates.numel() > 0:
            values = scores[candidates]
            extra = candidates[torch.topk(values, k=min(pool_size - pool.numel(), candidates.numel())).indices]
            pool = torch.unique(torch.cat([pool, extra]))
    if pool.numel() > pool_size:
        pool = pool[torch.topk(scores[pool], k=pool_size).indices]
    return pool


def pool_stats(pool: torch.Tensor, labels: torch.Tensor, scores: torch.Tensor):
    pool_labels = labels[pool].detach().cpu().tolist()
    counts = Counter(int(value) for value in pool_labels)
    top = counts.most_common(4)
    top_count = top[0][1] if top else 0
    second_count = top[1][1] if len(top) > 1 else 0
    return {
        "top_fraction": top_count / max(1, int(pool.numel())),
        "top_margin_fraction": (top_count - second_count) / max(1, int(pool.numel())),
        "coverage": len(counts),
        "pool_mean_similarity": float(scores[pool].mean().item()) if pool.numel() > 0 else 0.0,
        "pool_p10_similarity": float(torch.quantile(scores[pool], 0.10).item()) if pool.numel() > 0 else 0.0,
        "top_label": top[0][0] if top else -1,
    }


def quantile(values: list[float], q: float):
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * q))]


def evaluate_policy(
    policy: PoolPolicy,
    sim: torch.Tensor,
    labels: torch.Tensor,
    pool_size: int,
    anchors: torch.Tensor,
    seed: int,
):
    g = torch.Generator(device=sim.device).manual_seed(seed)
    rows = []
    top_seq = []
    for anchor_t in anchors:
        anchor = int(anchor_t.item())
        scores = sim[anchor].clone()
        scores[anchor] = -1.0e9
        if policy.kind == "baseline":
            pool = sample_baseline_pool(scores, pool_size, policy, g)
        else:
            pool = sample_partition_pool(scores, labels, pool_size, policy, g)
        stat = pool_stats(pool, labels, scores)
        rows.append(stat)
        top_seq.append(stat["top_label"])
    top_counts = Counter(top_seq)
    return {
        "policy": policy.name,
        "mean_top_fraction": sum(row["top_fraction"] for row in rows) / len(rows),
        "p95_top_fraction": quantile([row["top_fraction"] for row in rows], 0.95),
        "max_top_fraction": max(row["top_fraction"] for row in rows),
        "mean_top_margin": sum(row["top_margin_fraction"] for row in rows) / len(rows),
        "p95_top_margin": quantile([row["top_margin_fraction"] for row in rows], 0.95),
        "mean_coverage": sum(row["coverage"] for row in rows) / len(rows),
        "mean_similarity": sum(row["pool_mean_similarity"] for row in rows) / len(rows),
        "p10_similarity": quantile([row["pool_p10_similarity"] for row in rows], 0.10),
        "top_label_share": max(top_counts.values()) / len(top_seq),
        "top_label_counts": top_counts.most_common(6),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stable", default=DEFAULT_STABLE)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--pool-size", type=int, default=96)
    parser.add_argument("--anchors", type=int, default=192)
    parser.add_argument("--seed", type=int, default=20260620)
    args = parser.parse_args()

    device = torch.device(args.device if torch.cuda.is_available() and args.device.startswith("cuda") else "cpu")
    generation, raw, centered = load_stable(Path(args.stable), device)
    base_labels, sep = rust_neighbor_basins(raw, centered)
    policies = [
        PoolPolicy("baseline_random_window", kind="baseline"),
        PoolPolicy("partition_cap_10", kind="partition", cap_multiplier=3.20, min_cap=6, max_cap=10, min_active_basins=24),
        PoolPolicy("partition_cap_8", kind="partition", cap_multiplier=2.70, min_cap=5, max_cap=8, min_active_basins=28),
        PoolPolicy("partition_cap_6", kind="partition", cap_multiplier=2.20, min_cap=4, max_cap=6, min_active_basins=30),
    ]
    print(f"stable generation={generation} tracks={raw.shape[0]} dim={raw.shape[1]} sep={sep:.3f} device={device}", flush=True)
    keys = [
        "scenario",
        "policy",
        "mean_top_fraction",
        "p95_top_fraction",
        "max_top_fraction",
        "mean_top_margin",
        "p95_top_margin",
        "mean_coverage",
        "mean_similarity",
        "p10_similarity",
        "top_label_share",
    ]
    print(" | ".join(keys), flush=True)
    for scenario_index, scenario in enumerate(["base", "largest_basin_2x", "largest_basin_4x"]):
        scenario_raw, scenario_centered, labels = expand_scenario(raw, centered, base_labels, scenario, args.seed + scenario_index)
        sim = scenario_centered @ scenario_centered.T
        sizes = torch.bincount(labels, minlength=int(labels.max().item()) + 1)
        g = torch.Generator(device=device).manual_seed(args.seed + scenario_index * 4099)
        anchors = torch.randint(0, scenario_centered.shape[0], (args.anchors,), device=device, generator=g)
        print(
            f"# {scenario}: tracks={scenario_centered.shape[0]} basin_sizes_top="
            f"{sorted([(i, int(v.item())) for i, v in enumerate(sizes)], key=lambda pair: pair[1], reverse=True)[:5]}",
            flush=True,
        )
        for policy_index, policy in enumerate(policies):
            row = evaluate_policy(policy, sim, labels, args.pool_size, anchors, args.seed + scenario_index * 1009 + policy_index * 97)
            row["scenario"] = scenario
            print(" | ".join(f"{row[key]:.4f}" if isinstance(row[key], float) else str(row[key]) for key in keys), flush=True)
            print(f"  top_label_counts {row['top_label_counts']}", flush=True)


if __name__ == "__main__":
    main()
