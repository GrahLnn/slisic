from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import torch

DEFAULT_STABLE = r"C:/Users/admin/AppData/Local/slisic/audio-style-stable-model/stable.json"


@dataclass(frozen=True)
class Policy:
    name: str
    pool_size: int = 96
    local_fraction: float = 0.78
    temperature: float = 0.95
    selected_fatigue: float = 0.75
    recent_track_floor: float = 0.04
    top_pressure: float = 0.0
    mass_alpha: float = 0.0
    density_alpha: float = 0.0
    frontier_quota: int = 0
    challenger_bonus: float = 0.0
    field_relax: float = 0.0


def load_stable(path: Path, device: torch.device):
    data = json.loads(path.read_text(encoding="utf-8"))
    state = data["state"]
    x = torch.tensor([entry["values"] for entry in state["embeddings"]], dtype=torch.float32, device=device)
    x = torch.nn.functional.normalize(x, dim=1)
    x = x - x.mean(dim=0, keepdim=True)
    x = torch.nn.functional.normalize(x, dim=1)
    titles = [entry["track"]["music_name"] for entry in state["indexed_tracks"]]
    collections = [entry["source"]["collection_folder"] for entry in state["indexed_tracks"]]
    return data["generation"], x, titles, collections


def cosine_kmeans(x: torch.Tensor, clusters: int, restarts: int, iters: int, seed: int):
    g = torch.Generator(device=x.device).manual_seed(seed)
    n = x.shape[0]
    best_labels = None
    best_score = -float("inf")
    for _ in range(restarts):
        centers = torch.nn.functional.normalize(x[torch.randperm(n, device=x.device, generator=g)[:clusters]].clone(), dim=1)
        for _ in range(iters):
            labels = torch.argmax(x @ centers.T, dim=1)
            next_centers = []
            for cid in range(clusters):
                members = x[labels == cid]
                if members.numel() == 0:
                    next_centers.append(x[int(torch.randint(0, n, (1,), device=x.device, generator=g).item())])
                else:
                    next_centers.append(members.mean(dim=0))
            centers = torch.nn.functional.normalize(torch.stack(next_centers), dim=1)
        score = torch.max(x @ centers.T, dim=1).values.mean().item()
        if score > best_score:
            best_score = score
            best_labels = labels.clone()
    return best_labels


def entropy(counts: Counter, total: int):
    if total <= 0 or len(counts) <= 1:
        return 0.0
    h = 0.0
    for count in counts.values():
        p = count / total
        h -= p * math.log(max(p, 1e-12))
    return h / math.log(len(counts))


def hhi(counts: Counter, total: int):
    if total <= 0:
        return 0.0
    return sum((count / total) ** 2 for count in counts.values())


def longest_run(values: list[int]):
    best = 0
    current = None
    run = 0
    for value in values:
        if value == current:
            run += 1
        else:
            current = value
            run = 1
        best = max(best, run)
    return best


def cluster_stats(labels: torch.Tensor, sim: torch.Tensor, clusters: int):
    sizes = torch.bincount(labels, minlength=clusters).float()
    density = torch.zeros(clusters, dtype=torch.float32, device=labels.device)
    for cid in range(clusters):
        idx = torch.where(labels == cid)[0]
        if idx.numel() <= 1:
            density[cid] = 0.0
            continue
        sub = sim[idx][:, idx]
        density[cid] = ((sub.sum() - idx.numel()) / max(1, idx.numel() * (idx.numel() - 1))).clamp(min=-1.0, max=1.0)
    target = torch.sqrt(sizes.clamp_min(1.0))
    target = target / target.sum()
    return sizes, density, target


def build_pool(current: int, sim: torch.Tensor, labels: torch.Tensor, pressure: torch.Tensor, sizes: torch.Tensor, density: torch.Tensor, policy: Policy, recent: list[int], g: torch.Generator):
    n = sim.shape[0]
    scores = sim[current].clone()
    scores[current] = -1e9
    if recent:
        recent_tensor = torch.tensor(recent[-32:], dtype=torch.long, device=sim.device)
        scores[recent_tensor] = -1e9

    local_count = max(1, int(policy.pool_size * policy.local_fraction))
    top_count = min(n - 1, max(policy.pool_size * 4, local_count))
    local_candidates = torch.topk(scores, k=top_count).indices
    local_scores = scores[local_candidates]
    local_probs = torch.softmax(local_scores / 0.55, dim=0)
    local_pick = local_candidates[torch.multinomial(local_probs, min(local_count, local_candidates.numel()), replacement=False, generator=g)]
    chunks = [local_pick]

    if policy.frontier_quota > 0:
        present = torch.zeros(int(labels.max().item()) + 1, dtype=torch.bool, device=sim.device)
        present[labels[local_pick]] = True
        cluster_score = pressure.clone()
        cluster_score += policy.mass_alpha * torch.log1p(sizes) / torch.log1p(sizes.max())
        cluster_score += policy.density_alpha * density.clamp_min(0.0)
        order = torch.argsort(cluster_score, descending=False)
        frontier = []
        per = max(1, math.ceil(policy.frontier_quota / max(1, int((~present).sum().item()))))
        for cid_t in order:
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
            take = members[torch.topk(member_scores, k=min(per, members.numel())).indices]
            frontier.append(take)
            if sum(x.numel() for x in frontier) >= policy.frontier_quota:
                break
        if frontier:
            chunks.append(torch.cat(frontier)[: policy.frontier_quota])

    pool = torch.unique(torch.cat(chunks))
    candidate_clusters = labels[pool]
    # Candidate-field source gates: this is the mechanism under test. It acts before sampling,
    # so a huge basin cannot dominate the candidate field just by being dense.
    gates = torch.ones(pool.numel(), dtype=torch.float32, device=sim.device)
    if policy.top_pressure > 0:
        gates *= torch.exp(-policy.top_pressure * pressure[candidate_clusters])
    if policy.mass_alpha > 0:
        mass = torch.log1p(sizes[candidate_clusters]) / torch.log1p(sizes.max())
        gates *= torch.exp(-policy.mass_alpha * mass)
    if policy.density_alpha > 0:
        gates *= torch.exp(-policy.density_alpha * density[candidate_clusters].clamp_min(0.0))
    if policy.challenger_bonus > 0:
        min_pressure = pressure.min()
        gates *= 1.0 + policy.challenger_bonus * torch.relu(pressure[candidate_clusters].mean() - pressure[candidate_clusters])
        gates *= 1.0 + 0.25 * policy.challenger_bonus * torch.relu(pressure[candidate_clusters] - min_pressure).reciprocal().clamp(max=2.0)

    gated_scores = scores[pool] + torch.log(gates.clamp_min(1e-6))
    top_cluster = int(candidate_clusters[torch.argmax(gated_scores)].item())
    return pool, gated_scores, top_cluster


def sample_next(current: int, previous: int | None, pool: torch.Tensor, gated_scores: torch.Tensor, sim: torch.Tensor, x: torch.Tensor, labels: torch.Tensor, selected_pressure: torch.Tensor, policy: Policy, recent: list[int], g: torch.Generator):
    cand_clusters = labels[pool]
    scores = 5.2 * gated_scores.clone()
    scores -= policy.selected_fatigue * selected_pressure[cand_clusters]
    if recent:
        recent_set = set(recent[-24:])
        mask = torch.tensor([int(i.item()) in recent_set for i in pool], dtype=torch.bool, device=pool.device)
        scores[mask] += math.log(policy.recent_track_floor)
    if previous is not None:
        direction = torch.nn.functional.normalize((x[current] - x[previous]).view(1, -1), dim=1)[0]
        cand_direction = torch.nn.functional.normalize(x[pool] - x[current].view(1, -1), dim=1)
        momentum = cand_direction @ direction
        backtrack = torch.relu(sim[previous, pool] - 0.40)
        scores += 0.45 * momentum.clamp(-0.25, 0.75)
        scores -= 1.10 * backtrack
    probs = torch.softmax(scores / policy.temperature, dim=0)
    if policy.field_relax > 0:
        for _ in range(6):
            crowd = probs * probs.numel()
            relaxed = torch.softmax((scores - policy.field_relax * torch.log1p(crowd)) / policy.temperature, dim=0)
            probs = 0.70 * probs + 0.30 * relaxed
            probs = probs / probs.sum()
    pick = int(torch.multinomial(probs, 1, generator=g).item())
    return int(pool[pick].item()), float(probs[pick].item())


def simulate(policy: Policy, x: torch.Tensor, sim: torch.Tensor, labels: torch.Tensor, sizes: torch.Tensor, density: torch.Tensor, runs: int, steps: int, seed: int):
    g = torch.Generator(device=x.device).manual_seed(seed)
    n = x.shape[0]
    clusters = int(labels.max().item()) + 1
    top_seq: list[int] = []
    selected_seq: list[int] = []
    transitions = []
    probs = []
    for _ in range(runs):
        current = int(torch.randint(0, n, (1,), device=x.device, generator=g).item())
        previous = None
        recent = [current]
        pressure = torch.zeros(clusters, dtype=torch.float32, device=x.device)
        selected_pressure = torch.zeros(clusters, dtype=torch.float32, device=x.device)
        selected_seq.append(int(labels[current].item()))
        for _ in range(steps - 1):
            pressure *= 0.91
            selected_pressure *= 0.86
            pool, gated_scores, top_cluster = build_pool(current, sim, labels, pressure, sizes, density, policy, recent, g)
            pressure[top_cluster] += 1.0
            nxt, prob = sample_next(current, previous, pool, gated_scores, sim, x, labels, selected_pressure, policy, recent, g)
            selected_cluster = int(labels[nxt].item())
            selected_pressure[selected_cluster] += 1.0
            top_seq.append(top_cluster)
            selected_seq.append(selected_cluster)
            transitions.append(float(sim[current, nxt].item()))
            probs.append(prob)
            previous, current = current, nxt
            recent.append(current)
    top_counts = Counter(top_seq)
    selected_counts = Counter(selected_seq)
    t = torch.tensor(transitions, device=x.device)
    return {
        "policy": policy.name,
        "candidate_top_share": max(top_counts.values()) / len(top_seq),
        "candidate_entropy": entropy(top_counts, len(top_seq)),
        "candidate_hhi": hhi(top_counts, len(top_seq)),
        "candidate_longest_run": longest_run(top_seq),
        "candidate_same_step": sum(1 for a, b in zip(top_seq, top_seq[1:]) if a == b) / max(1, len(top_seq) - 1),
        "selected_top_share": max(selected_counts.values()) / len(selected_seq),
        "selected_entropy": entropy(selected_counts, len(selected_seq)),
        "selected_hhi": hhi(selected_counts, len(selected_seq)),
        "selected_longest_run": longest_run(selected_seq),
        "selected_same_step": sum(1 for a, b in zip(selected_seq, selected_seq[1:]) if a == b) / max(1, len(selected_seq) - 1),
        "transition_mean": float(t.mean().item()),
        "transition_p10": float(torch.quantile(t, 0.10).item()),
        "transition_p90": float(torch.quantile(t, 0.90).item()),
        "choice_prob_mean": sum(probs) / len(probs),
        "top_counts": top_counts.most_common(8),
        "selected_counts": selected_counts.most_common(8),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stable", default=DEFAULT_STABLE)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--clusters", type=int, default=33)
    parser.add_argument("--runs", type=int, default=160)
    parser.add_argument("--steps", type=int, default=96)
    parser.add_argument("--seed", type=int, default=20260619)
    parser.add_argument("--kmeans-restarts", type=int, default=8)
    parser.add_argument("--kmeans-iters", type=int, default=60)
    args = parser.parse_args()
    device = torch.device(args.device if torch.cuda.is_available() and args.device.startswith("cuda") else "cpu")
    generation, x, _titles, _collections = load_stable(Path(args.stable), device)
    sim = x @ x.T
    labels = cosine_kmeans(x, args.clusters, args.kmeans_restarts, args.kmeans_iters, args.seed)
    sizes, density, target = cluster_stats(labels, sim, args.clusters)
    print(f"stable generation={generation} tracks={x.shape[0]} dim={x.shape[1]} clusters={args.clusters} device={device}")
    print("cluster_sizes_top", sorted([(int(i), int(v.item())) for i, v in enumerate(sizes)], key=lambda p: p[1], reverse=True)[:8])

    policies = [
        Policy("baseline", top_pressure=0.0, mass_alpha=0.0, density_alpha=0.0, frontier_quota=0, field_relax=0.0),
        Policy("late_top_pressure", top_pressure=0.85, mass_alpha=0.0, density_alpha=0.0, frontier_quota=0, field_relax=0.0),
        Policy("source_mass_gate", top_pressure=0.35, mass_alpha=0.75, density_alpha=0.35, frontier_quota=0, field_relax=0.0),
        Policy("mass_plus_frontier", top_pressure=0.45, mass_alpha=0.85, density_alpha=0.45, frontier_quota=18, challenger_bonus=0.0, field_relax=0.0),
        Policy("mass_frontier_relax", top_pressure=0.45, mass_alpha=0.85, density_alpha=0.45, frontier_quota=18, challenger_bonus=0.10, field_relax=0.22, temperature=0.92),
        Policy("overcorrected_randomish", top_pressure=1.20, mass_alpha=1.50, density_alpha=0.85, frontier_quota=28, challenger_bonus=0.25, field_relax=0.45, temperature=1.05),
    ]
    rows = [simulate(policy, x, sim, labels, sizes, density, args.runs, args.steps, args.seed + i * 1009) for i, policy in enumerate(policies)]
    keys = [
        "policy",
        "candidate_top_share",
        "candidate_entropy",
        "candidate_hhi",
        "candidate_longest_run",
        "candidate_same_step",
        "selected_top_share",
        "selected_entropy",
        "selected_hhi",
        "selected_longest_run",
        "selected_same_step",
        "transition_mean",
        "transition_p10",
        "transition_p90",
        "choice_prob_mean",
    ]
    print("\nmetrics:")
    print(" | ".join(keys))
    for row in rows:
        print(" | ".join(f"{row[k]:.4f}" if isinstance(row[k], float) else str(row[k]) for k in keys))
    print("\nconcentration:")
    for row in rows:
        print(row["policy"])
        print("  top_counts     ", row["top_counts"])
        print("  selected_counts", row["selected_counts"])
    print("\nacceptance:")
    print("  prefer candidate_top_share <= 0.18 and candidate_longest_run much lower than baseline")
    print("  keep selected_entropy >= 0.90 and transition_p10 close to baseline, otherwise it is random hopping")


if __name__ == "__main__":
    main()
