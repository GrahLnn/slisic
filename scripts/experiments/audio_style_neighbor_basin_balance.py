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
class Policy:
    name: str
    beta: float = 5.8
    temperature: float = 0.92
    selected_fatigue: float = 0.95
    top_fatigue: float = 0.0
    top_pressure_impulse: float = 0.0
    frontier_reserve: int = 0
    candidate_top_gate: float = 0.0
    candidate_mass_gate: float = 0.0


def load_stable(path: Path, device: torch.device):
    data = json.loads(path.read_text(encoding="utf-8"))
    raw = torch.tensor([entry["values"] for entry in data["embeddings"]], dtype=torch.float32, device=device)
    raw = torch.nn.functional.normalize(raw, dim=1)
    mean = raw.mean(dim=0, keepdim=True)
    centered = torch.nn.functional.normalize(raw - mean, dim=1)
    titles = [entry["track"]["music_name"] for entry in data["indexed_tracks"]]
    return data["generation"], raw, centered, titles


def rust_neighbor_basins(raw: torch.Tensor, centered: torch.Tensor):
    n = raw.shape[0]
    centered_sim = centered @ centered.T
    masked = centered_sim - torch.eye(n, device=raw.device) * 10.0
    neigh_vals, neighbors = torch.topk(masked, k=min(TOP_K, n - 1), dim=1)
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
    assign = torch.argmax(raw_sim[:, proto_tensor], dim=1)
    labels = assign.to(torch.long)
    return labels, proto_tensor, neighbors, local_density, separation_floor


def entropy(counts: Counter, total: int):
    if total <= 0 or len(counts) <= 1:
        return 0.0
    return -sum((c / total) * math.log(max(c / total, 1e-12)) for c in counts.values()) / math.log(len(counts))


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


def pick_pool(current: int, sim: torch.Tensor, labels: torch.Tensor, recent: list[int], top_pressure: torch.Tensor, sizes: torch.Tensor, policy: Policy, g: torch.Generator):
    n = sim.shape[0]
    scores = sim[current].clone()
    scores[current] = -1e9
    if recent:
        scores[torch.tensor(recent[-24:], dtype=torch.long, device=sim.device)] = -1e9
    local_count = max(1, 96 - policy.frontier_reserve)
    local = torch.topk(scores, k=min(max(local_count * 4, 96), n - 1)).indices
    local_probs = torch.softmax(scores[local] / 0.70, dim=0)
    local_pick = local[torch.multinomial(local_probs, min(local_count, local.numel()), replacement=False, generator=g)]
    chunks = [local_pick]
    if policy.frontier_reserve > 0:
        present = torch.zeros(int(labels.max().item()) + 1, dtype=torch.bool, device=sim.device)
        present[labels[local_pick]] = True
        cluster_order = torch.argsort(top_pressure + 0.15 * sizes / sizes.max(), descending=False)
        frontier = []
        per = 1
        for cid_t in cluster_order:
            cid = int(cid_t.item())
            if present[cid]:
                continue
            members = torch.where(labels == cid)[0]
            if members.numel() == 0:
                continue
            member_scores = scores[members]
            finite = member_scores > -1e8
            if not finite.any():
                continue
            members = members[finite]
            member_scores = member_scores[finite]
            frontier.append(members[torch.topk(member_scores, k=min(per, members.numel())).indices])
            if sum(x.numel() for x in frontier) >= policy.frontier_reserve:
                break
        if frontier:
            chunks.append(torch.cat(frontier)[:policy.frontier_reserve])
    pool = torch.unique(torch.cat(chunks))
    candidate_clusters = labels[pool]
    gated = scores[pool].clone()
    if policy.candidate_top_gate > 0:
        gated -= policy.candidate_top_gate * top_pressure[candidate_clusters]
    if policy.candidate_mass_gate > 0:
        gated -= policy.candidate_mass_gate * torch.log1p(sizes[candidate_clusters]) / torch.log1p(sizes.max())
    top_cluster = int(candidate_clusters[torch.argmax(gated)].item())
    return pool, gated, top_cluster


def simulate(policy: Policy, sim: torch.Tensor, centered: torch.Tensor, labels: torch.Tensor, runs: int, steps: int, seed: int):
    g = torch.Generator(device=sim.device).manual_seed(seed)
    n = sim.shape[0]
    clusters = int(labels.max().item()) + 1
    sizes = torch.bincount(labels, minlength=clusters).float()
    top_seq: list[int] = []
    selected_seq: list[int] = []
    transitions: list[float] = []
    for _ in range(runs):
        current = int(torch.randint(0, n, (1,), device=sim.device, generator=g).item())
        prev = None
        recent = [current]
        top_pressure = torch.zeros(clusters, dtype=torch.float32, device=sim.device)
        selected_pressure = torch.zeros(clusters, dtype=torch.float32, device=sim.device)
        selected_seq.append(int(labels[current].item()))
        for _ in range(steps - 1):
            top_pressure *= 0.90
            selected_pressure *= 0.86
            pool, gated, top_cluster = pick_pool(current, sim, labels, recent, top_pressure, sizes, policy, g)
            top_pressure[top_cluster] += 1.0 + policy.top_pressure_impulse
            cand_clusters = labels[pool]
            score = policy.beta * gated
            score -= policy.top_fatigue * top_pressure[cand_clusters]
            score -= policy.selected_fatigue * selected_pressure[cand_clusters]
            if prev is not None:
                direction = torch.nn.functional.normalize((centered[current] - centered[prev]).view(1, -1), dim=1)[0]
                cand_dir = torch.nn.functional.normalize(centered[pool] - centered[current].view(1, -1), dim=1)
                score += 0.55 * (cand_dir @ direction).clamp(-0.25, 0.75)
                score -= 1.20 * torch.relu(sim[prev, pool] - 0.45)
            probs = torch.softmax(score / policy.temperature, dim=0)
            picked = int(torch.multinomial(probs, 1, generator=g).item())
            nxt = int(pool[picked].item())
            selected_cluster = int(labels[nxt].item())
            selected_pressure[selected_cluster] += 1.0
            top_seq.append(top_cluster)
            selected_seq.append(selected_cluster)
            transitions.append(float(sim[current, nxt].item()))
            prev, current = current, nxt
            recent.append(current)
    top_counts = Counter(top_seq)
    selected_counts = Counter(selected_seq)
    t = torch.tensor(transitions, device=sim.device)
    return {
        "policy": policy.name,
        "candidate_top_share": max(top_counts.values()) / len(top_seq),
        "candidate_entropy": entropy(top_counts, len(top_seq)),
        "candidate_longest_run": longest_run(top_seq),
        "candidate_same_step": sum(1 for a, b in zip(top_seq, top_seq[1:]) if a == b) / max(1, len(top_seq) - 1),
        "selected_top_share": max(selected_counts.values()) / len(selected_seq),
        "selected_entropy": entropy(selected_counts, len(selected_seq)),
        "selected_longest_run": longest_run(selected_seq),
        "selected_same_step": sum(1 for a, b in zip(selected_seq, selected_seq[1:]) if a == b) / max(1, len(selected_seq) - 1),
        "transition_mean": float(t.mean().item()),
        "transition_p10": float(torch.quantile(t, 0.10).item()),
        "transition_p90": float(torch.quantile(t, 0.90).item()),
        "top_counts": top_counts.most_common(8),
        "selected_counts": selected_counts.most_common(8),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stable", default=DEFAULT_STABLE)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--runs", type=int, default=96)
    parser.add_argument("--steps", type=int, default=80)
    parser.add_argument("--seed", type=int, default=20260619)
    args = parser.parse_args()
    device = torch.device(args.device if torch.cuda.is_available() and args.device.startswith("cuda") else "cpu")
    generation, raw, centered, _titles = load_stable(Path(args.stable), device)
    labels, prototypes, _neighbors, density, sep = rust_neighbor_basins(raw, centered)
    sim = centered @ centered.T
    sizes = torch.bincount(labels, minlength=int(labels.max().item()) + 1)
    print(f"stable generation={generation} tracks={raw.shape[0]} dim={raw.shape[1]} rust_like_basins={int(labels.max().item())+1} sep={sep:.3f} device={device}", flush=True)
    print("basin_sizes_top", sorted([(i, int(v.item())) for i, v in enumerate(sizes)], key=lambda p: p[1], reverse=True)[:10], flush=True)
    policies = [
        Policy("baseline"),
        Policy("top_fatigue", top_fatigue=0.75, top_pressure_impulse=0.45),
        Policy("top_fatigue_frontier", top_fatigue=0.75, top_pressure_impulse=0.45, frontier_reserve=12),
        Policy("candidate_top_gate", top_fatigue=0.65, top_pressure_impulse=0.45, candidate_top_gate=0.55, frontier_reserve=8),
        Policy("candidate_top_mass_gate", top_fatigue=0.65, top_pressure_impulse=0.45, candidate_top_gate=0.45, candidate_mass_gate=0.35, frontier_reserve=8),
        Policy("strong_candidate_gate", top_fatigue=0.95, top_pressure_impulse=0.65, candidate_top_gate=0.85, candidate_mass_gate=0.45, frontier_reserve=14),
    ]
    rows = [simulate(policy, sim, centered, labels, args.runs, args.steps, args.seed + i * 1009) for i, policy in enumerate(policies)]
    keys = ["policy", "candidate_top_share", "candidate_entropy", "candidate_longest_run", "candidate_same_step", "selected_top_share", "selected_entropy", "selected_longest_run", "selected_same_step", "transition_mean", "transition_p10", "transition_p90"]
    print("\nmetrics:", flush=True)
    print(" | ".join(keys), flush=True)
    for row in rows:
        print(" | ".join(f"{row[k]:.4f}" if isinstance(row[k], float) else str(row[k]) for k in keys), flush=True)
    print("\nconcentration:", flush=True)
    for row in rows:
        print(row["policy"], flush=True)
        print("  top_counts     ", row["top_counts"], flush=True)
        print("  selected_counts", row["selected_counts"], flush=True)


if __name__ == "__main__":
    main()
