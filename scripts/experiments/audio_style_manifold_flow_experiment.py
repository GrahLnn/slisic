#!/usr/bin/env python3
"""Probe manifold-owned controls for Slisic audio-style walking.

Run with CUDA torch:
  C:/Users/admin/ann/.venv/Scripts/python.exe scripts/experiments/audio_style_manifold_flow_experiment.py

The experiment intentionally avoids sweeping recommendation hyperparameters. It
builds local manifold tensors from the current stable embedding field and lets
intrinsic geometry control sampling sharpness, continuity, and escape pressure.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import torch


DEFAULT_STABLE = Path.home() / "AppData/Local/slisic/audio-style-stable-model/stable.json"


@dataclass(frozen=True)
class StableModel:
    generation: int
    titles: list[str]
    x: torch.Tensor
    sim: torch.Tensor
    basins: torch.Tensor
    basin_names: list[str]
    basin_members: list[torch.Tensor]
    nearest: torch.Tensor


@dataclass(frozen=True)
class ManifoldBank:
    neighbors: torch.Tensor
    tangent_basis: torch.Tensor
    spectral_rank: torch.Tensor
    local_density: torch.Tensor
    curvature: torch.Tensor
    boundary_pressure: torch.Tensor


def key_tuple(raw: dict) -> tuple[str, str, int, int]:
    return (
        str(raw.get("music_url", "")),
        str(raw.get("file_path", "")),
        int(raw.get("start_ms", 0) or 0),
        int(raw.get("end_ms", 0) or 0),
    )


def normalize_rows(x: torch.Tensor) -> torch.Tensor:
    return torch.nn.functional.normalize(x, dim=1, eps=1.0e-8)


def load_stable(path: Path, device: torch.device, neighbor_k: int) -> StableModel:
    data = json.loads(path.read_text(encoding="utf-8"))
    state = data["state"]
    x = torch.tensor([entry["values"] for entry in state["embeddings"]], dtype=torch.float32, device=device)
    x = normalize_rows(x)
    x = normalize_rows(x - x.mean(dim=0, keepdim=True))
    sim = x @ x.T
    sim.fill_diagonal_(-1.0)

    indexed = state["indexed_tracks"]
    titles = [entry["track"]["music_name"] for entry in indexed]
    index_by_key = {key_tuple(entry["key"]): idx for idx, entry in enumerate(indexed)}
    basin_by_track: dict[int, str] = {}
    for entry in state["sampling_geometry"].get("self_supervised_basins", []):
        idx = index_by_key.get(key_tuple(entry.get("key", {})))
        if idx is not None:
            basin_by_track[idx] = str(entry.get("basin", "audio-basin:unknown"))
    names = sorted(set(basin_by_track.values()))
    name_to_id = {name: idx for idx, name in enumerate(names)}
    basins = torch.tensor(
        [name_to_id.get(basin_by_track.get(idx, "audio-basin:unknown"), 0) for idx in range(x.size(0))],
        dtype=torch.long,
        device=device,
    )
    basin_members = [torch.where(basins == basin_id)[0] for basin_id in range(len(names))]
    nearest = torch.topk(sim, k=min(neighbor_k, x.size(0) - 1), dim=1).indices
    return StableModel(
        generation=int(data.get("generation", state.get("generation", 0)) or 0),
        titles=titles,
        x=x,
        sim=sim,
        basins=basins,
        basin_names=names,
        basin_members=basin_members,
        nearest=nearest,
    )


def effective_rank(values: torch.Tensor) -> torch.Tensor:
    weights = torch.clamp(values, min=0.0)
    weights = weights / torch.clamp(weights.sum(dim=-1, keepdim=True), min=1.0e-8)
    entropy = -(weights * torch.log(torch.clamp(weights, min=1.0e-8))).sum(dim=-1)
    return torch.exp(entropy)


def build_manifold_bank(model: StableModel, tangent_k: int, tangent_dim: int) -> ManifoldBank:
    n, d = model.x.shape
    neighbors = model.nearest[:, :tangent_k]
    tangent_basis = torch.empty((n, tangent_dim, d), dtype=torch.float32, device=model.x.device)
    spectral_rank = torch.empty(n, dtype=torch.float32, device=model.x.device)
    local_density = torch.empty(n, dtype=torch.float32, device=model.x.device)
    curvature = torch.empty(n, dtype=torch.float32, device=model.x.device)
    boundary_pressure = torch.empty(n, dtype=torch.float32, device=model.x.device)

    eye = torch.eye(tangent_dim, dtype=torch.float32, device=model.x.device)
    for start in range(0, n, 128):
        end = min(n, start + 128)
        batch = torch.arange(start, end, device=model.x.device)
        nb = neighbors[batch]
        anchor = model.x[batch].unsqueeze(1)
        delta = model.x[nb] - anchor
        delta = delta - delta.mean(dim=1, keepdim=True)
        # SVD gives the local tangent chart. For this data size it is cheap on GPU
        # and keeps the experiment close to the tensor structure we want in Rust.
        _u, s, vh = torch.linalg.svd(delta, full_matrices=False)
        basis = vh[:, :tangent_dim, :]
        if basis.size(1) < tangent_dim:
            pad = eye[: tangent_dim - basis.size(1)].unsqueeze(0).expand(end - start, -1, -1)
            basis = torch.cat([basis, pad], dim=1)
        tangent_basis[batch] = basis
        spectral_rank[batch] = effective_rank(s[:, : min(s.size(1), tangent_dim * 2)])
        local_density[batch] = model.sim[batch.unsqueeze(1), nb].mean(dim=1)

        projected = torch.einsum("bkd,btd->bkt", delta, basis)
        reconstructed = torch.einsum("bkt,btd->bkd", projected, basis)
        normal = torch.linalg.norm(delta - reconstructed, dim=-1)
        tangent = torch.linalg.norm(reconstructed, dim=-1)
        curvature[batch] = normal.mean(dim=1) / torch.clamp(tangent.mean(dim=1), min=1.0e-6)

        basin = model.basins[batch].unsqueeze(1)
        boundary_pressure[batch] = (model.basins[nb] != basin).float().mean(dim=1)

    return ManifoldBank(
        neighbors=neighbors,
        tangent_basis=tangent_basis,
        spectral_rank=spectral_rank,
        local_density=local_density,
        curvature=curvature,
        boundary_pressure=boundary_pressure,
    )


def quantile(values: list[float] | list[int], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(float(value) for value in values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * q))]


def normalized_entropy(counts: Counter[int], universe: int) -> float:
    total = sum(counts.values())
    if total <= 0 or universe <= 1:
        return 0.0
    entropy = 0.0
    for count in counts.values():
        p = count / total
        entropy -= p * math.log(max(p, 1.0e-12))
    return entropy / math.log(universe)


def run_lengths(seq: list[int]) -> list[int]:
    if not seq:
        return []
    out: list[int] = []
    last = seq[0]
    run = 1
    for value in seq[1:]:
        if value == last:
            run += 1
            continue
        out.append(run)
        last = value
        run = 1
    out.append(run)
    return out


def unique_preserving_order(values: Iterable[int]) -> list[int]:
    seen: set[int] = set()
    out: list[int] = []
    for value in values:
        ivalue = int(value)
        if ivalue in seen:
            continue
        seen.add(ivalue)
        out.append(ivalue)
    return out


def candidate_pool(
    model: StableModel,
    bank: ManifoldBank,
    current: int,
    recent: deque[int],
    pool_size: int,
    frontier: int,
    generator: torch.Generator,
) -> torch.Tensor:
    recent_set = set(recent)
    local = [idx for idx in model.nearest[current, : pool_size * 2].tolist() if idx not in recent_set]
    local = local[: max(pool_size - frontier, 8)]
    current_basin = int(model.basins[current].item())
    boundary = float(bank.boundary_pressure[current].item())
    extra: list[int] = []
    if boundary > 0.18 and frontier > 0:
        neighbor_basins = model.basins[bank.neighbors[current, :64]]
        counts = Counter(int(value) for value in neighbor_basins.tolist() if int(value) != current_basin)
        for basin, _count in counts.most_common(frontier):
            members = model.basin_members[basin]
            if members.numel() == 0:
                continue
            scores = model.sim[current, members]
            order = torch.argsort(scores, descending=True)
            for member in members[order[:8]].tolist():
                if member not in recent_set and member != current:
                    extra.append(member)
                    break
    if len(local) < pool_size:
        fill = [idx for idx in model.nearest[current, : pool_size * 4].tolist() if idx not in recent_set]
        local = unique_preserving_order([*local, *fill])[:pool_size]
    pool = unique_preserving_order([*local, *extra])[:pool_size]
    if not pool:
        pool = [int(model.nearest[current, 0].item())]
    return torch.tensor(pool, dtype=torch.long, device=model.x.device)


def manifold_scores(
    model: StableModel,
    bank: ManifoldBank,
    current: int,
    previous: int | None,
    pool: torch.Tensor,
    basin_usage: torch.Tensor,
    recent_basin_run: int,
) -> tuple[torch.Tensor, dict[str, float]]:
    anchor = model.x[current]
    delta = model.x[pool] - anchor
    basis = bank.tangent_basis[current]
    tangent_coord = delta @ basis.T
    tangent_recon = tangent_coord @ basis
    tangent_norm = torch.linalg.norm(tangent_recon, dim=1)
    normal_norm = torch.linalg.norm(delta - tangent_recon, dim=1)
    tangent_alignment = torch.zeros(pool.numel(), dtype=torch.float32, device=model.x.device)
    if previous is not None:
        velocity = model.x[current] - model.x[previous]
        velocity_coord = velocity @ basis.T
        velocity_norm = torch.linalg.norm(velocity_coord)
        if float(velocity_norm.item()) > 1.0e-6:
            tangent_alignment = (tangent_coord @ velocity_coord) / torch.clamp(
                torch.linalg.norm(tangent_coord, dim=1) * velocity_norm,
                min=1.0e-6,
            )

    intrinsic_distance = torch.linalg.norm(tangent_coord, dim=1)
    manifold_residual = normal_norm / torch.clamp(tangent_norm + normal_norm, min=1.0e-6)
    candidate_density = bank.local_density[pool]
    candidate_boundary = bank.boundary_pressure[pool]
    candidate_rank = bank.spectral_rank[pool]
    candidate_basin = model.basins[pool]
    current_basin = int(model.basins[current].item())
    same = candidate_basin == current_basin

    usage_share = basin_usage / torch.clamp(basin_usage.sum(), min=1.0e-8)
    overuse = usage_share[candidate_basin]
    current_overuse = float(usage_share[current_basin].item())
    boundary_readiness = float(bank.boundary_pressure[current].item())
    curvature = float(bank.curvature[current].item())
    spectral = float(bank.spectral_rank[current].item())
    # A local chart can host several coherent steps, but its usable residence
    # capacity grows sublinearly with rank. Using rank directly makes broad
    # charts behave like absorbing basins; sqrt(rank) keeps the controller tied
    # to manifold geometry without hard-coding a global run length.
    route_capacity = max(1.0, math.sqrt(max(spectral, 1.0)) * (1.25 - 0.55 * boundary_readiness))
    maturity = min(1.0, max(0.0, (recent_basin_run - 1) / route_capacity))
    escape_pressure = maturity * (
        0.42 * min(1.0, boundary_readiness * 1.35)
        + 0.34 * min(1.0, curvature)
        + 0.24 * min(1.0, current_overuse * 5.0)
    )

    scores = 4.4 * model.sim[current, pool]
    scores += 0.95 * tangent_alignment
    scores -= 1.30 * manifold_residual
    scores -= 0.55 * torch.relu(candidate_density - bank.local_density[current])
    scores -= 0.75 * overuse
    scores += escape_pressure * (~same).float() * (0.55 + candidate_boundary)
    scores += (1.0 - escape_pressure) * same.float() * torch.clamp(torch.sqrt(candidate_rank) / 3.0, 0.0, 1.0)

    # The controller owns sharpness through manifold state. Narrow local charts
    # and high curvature raise temperature; coherent broad charts lower it.
    temperature = 0.72 + 0.34 * torch.sigmoid(torch.tensor(2.2 - spectral, device=model.x.device))
    temperature += 0.34 * min(1.0, curvature)
    temperature += 0.22 * boundary_readiness
    probs = torch.softmax(scores / temperature, dim=0)
    width = 1.0 / torch.clamp(torch.sum(probs * probs), min=1.0e-8)
    if float(width.item()) < max(2.0, 0.035 * pool.numel()):
        reserve = torch.clamp((max(2.0, 0.035 * pool.numel()) - width) / max(1.0, 0.035 * pool.numel()), 0.0, 1.0)
        scores = scores * (1.0 - 0.28 * reserve)

    diagnostics = {
        "spectral_rank": spectral,
        "curvature": curvature,
        "boundary": boundary_readiness,
        "escape_pressure": escape_pressure,
        "route_capacity": route_capacity,
    }
    return scores, diagnostics


def baseline_scores(model: StableModel, current: int, pool: torch.Tensor) -> torch.Tensor:
    return 5.4 * model.sim[current, pool]


def simulate(
    model: StableModel,
    bank: ManifoldBank,
    policy: str,
    runs: int,
    steps: int,
    pool_size: int,
    seed: int,
) -> dict:
    generator = torch.Generator(device=model.x.device).manual_seed(seed)
    basin_count = len(model.basin_names)
    basin_seq_all: list[int] = []
    track_seq_all: list[int] = []
    transitions: list[float] = []
    probabilities: list[float] = []
    widths: list[float] = []
    spectral: list[float] = []
    curvature: list[float] = []
    boundary: list[float] = []
    escape: list[float] = []
    bigrams = Counter()

    for _run in range(runs):
        current = int(torch.randint(0, model.x.size(0), (1,), device=model.x.device, generator=generator).item())
        previous: int | None = None
        recent: deque[int] = deque([current], maxlen=48)
        local_basin_seq = [int(model.basins[current].item())]
        basin_usage = torch.ones(basin_count, dtype=torch.float32, device=model.x.device) * 1.0e-4
        basin_usage[local_basin_seq[-1]] += 1.0
        basin_seq_all.append(local_basin_seq[-1])
        track_seq_all.append(current)
        for _step in range(steps - 1):
            basin_usage *= 0.986
            current_basin = local_basin_seq[-1]
            run = 0
            for basin in reversed(local_basin_seq):
                if basin != current_basin:
                    break
                run += 1
            pool = candidate_pool(model, bank, current, recent, pool_size, frontier=10, generator=generator)
            if policy == "manifold":
                scores, diag = manifold_scores(model, bank, current, previous, pool, basin_usage, run)
            else:
                scores = baseline_scores(model, current, pool)
                diag = {
                    "spectral_rank": float(bank.spectral_rank[current].item()),
                    "curvature": float(bank.curvature[current].item()),
                    "boundary": float(bank.boundary_pressure[current].item()),
                    "escape_pressure": 0.0,
                }
            if recent:
                recent_set = set(recent)
                recent_mask = torch.tensor([int(idx.item()) in recent_set for idx in pool], dtype=torch.bool, device=model.x.device)
                scores[recent_mask] += math.log(0.025)
            probs = torch.softmax(scores / 0.92, dim=0)
            width = 1.0 / torch.clamp(torch.sum(probs * probs), min=1.0e-8)
            pick = int(torch.multinomial(probs, 1, generator=generator).item())
            nxt = int(pool[pick].item())
            nxt_basin = int(model.basins[nxt].item())
            bigrams[(current_basin, nxt_basin)] += 1
            transitions.append(float(model.sim[current, nxt].item()))
            probabilities.append(float(probs[pick].item()))
            widths.append(float(width.item()))
            spectral.append(diag["spectral_rank"])
            curvature.append(diag["curvature"])
            boundary.append(diag["boundary"])
            escape.append(diag["escape_pressure"])
            previous, current = current, nxt
            recent.append(current)
            local_basin_seq.append(nxt_basin)
            basin_usage[nxt_basin] += 1.0
            basin_seq_all.append(nxt_basin)
            track_seq_all.append(current)

    runs_all = run_lengths(basin_seq_all)
    basin_counts = Counter(basin_seq_all)
    track_counts = Counter(track_seq_all)
    total = len(basin_seq_all)
    switch_rate = sum(1 for a, b in zip(basin_seq_all, basin_seq_all[1:]) if a != b) / max(1, total - 1)
    return {
        "policy": policy,
        "switch_rate": switch_rate,
        "mean_run": sum(runs_all) / max(1, len(runs_all)),
        "p90_run": quantile(runs_all, 0.90),
        "max_run": max(runs_all) if runs_all else 0,
        "singleton_run_share": sum(1 for value in runs_all if value == 1) / max(1, len(runs_all)),
        "stream_2_to_5_share": sum(1 for value in runs_all if 2 <= value <= 5) / max(1, len(runs_all)),
        "basin_entropy": normalized_entropy(basin_counts, basin_count),
        "top_basin_share": max(basin_counts.values()) / max(1, total),
        "top_track_share": max(track_counts.values()) / max(1, total),
        "transition_p10": quantile(transitions, 0.10),
        "transition_p50": quantile(transitions, 0.50),
        "choice_prob_p90": quantile(probabilities, 0.90),
        "choice_width_p10": quantile(widths, 0.10),
        "choice_width_p50": quantile(widths, 0.50),
        "spectral_rank_p50": quantile(spectral, 0.50),
        "curvature_p50": quantile(curvature, 0.50),
        "boundary_p50": quantile(boundary, 0.50),
        "escape_p90": quantile(escape, 0.90),
        "bigram_entropy": normalized_entropy(bigrams, basin_count * basin_count),
        "top_basins": [(model.basin_names[idx], count) for idx, count in basin_counts.most_common(8)],
        "top_tracks": [(model.titles[idx], count) for idx, count in track_counts.most_common(8)],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stable", type=Path, default=DEFAULT_STABLE)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--runs", type=int, default=96)
    parser.add_argument("--steps", type=int, default=96)
    parser.add_argument("--neighbor-k", type=int, default=160)
    parser.add_argument("--tangent-k", type=int, default=64)
    parser.add_argument("--tangent-dim", type=int, default=12)
    parser.add_argument("--pool-size", type=int, default=96)
    parser.add_argument("--seed", type=int, default=20260701)
    args = parser.parse_args()

    device = torch.device(args.device if torch.cuda.is_available() else "cpu")
    torch.set_float32_matmul_precision("high")
    model = load_stable(args.stable, device, args.neighbor_k)
    bank = build_manifold_bank(model, args.tangent_k, args.tangent_dim)
    print(
        json.dumps(
            {
                "device": str(device),
                "cuda_name": torch.cuda.get_device_name(device) if device.type == "cuda" else "cpu",
                "generation": model.generation,
                "tracks": model.x.size(0),
                "dim": model.x.size(1),
                "basins": len(model.basin_names),
                "spectral_rank_p50": quantile(bank.spectral_rank.detach().cpu().tolist(), 0.50),
                "curvature_p50": quantile(bank.curvature.detach().cpu().tolist(), 0.50),
                "boundary_p50": quantile(bank.boundary_pressure.detach().cpu().tolist(), 0.50),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    rows = [
        simulate(model, bank, "baseline", args.runs, args.steps, args.pool_size, args.seed),
        simulate(model, bank, "manifold", args.runs, args.steps, args.pool_size, args.seed + 1009),
    ]
    keys = [
        "policy",
        "switch_rate",
        "mean_run",
        "p90_run",
        "max_run",
        "singleton_run_share",
        "stream_2_to_5_share",
        "basin_entropy",
        "top_basin_share",
        "top_track_share",
        "transition_p10",
        "transition_p50",
        "choice_prob_p90",
        "choice_width_p10",
        "choice_width_p50",
        "spectral_rank_p50",
        "curvature_p50",
        "boundary_p50",
        "escape_p90",
        "bigram_entropy",
    ]
    print(" | ".join(keys))
    for row in rows:
        print(" | ".join(f"{row[key]:.4f}" if isinstance(row[key], float) else str(row[key]) for key in keys))
    print("concentration:")
    for row in rows:
        print(json.dumps({"policy": row["policy"], "top_basins": row["top_basins"], "top_tracks": row["top_tracks"]}, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
