from __future__ import annotations

import argparse
import json
import math
import random
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import numpy as np


SAMPLE_RATE = 16_000
INTERVAL_SECONDS = 8.0
TERMINAL_BINS = 64
TERMINAL_LATENT_WIDTH = TERMINAL_BINS * 2
TRANSITION_WIDTH = TERMINAL_BINS * TERMINAL_BINS
EMBEDDING_WIDTH = TERMINAL_LATENT_WIDTH + TERMINAL_BINS * 2 + TRANSITION_WIDTH
FRAME_SIZE = 1024
HOP_SIZE = 256
LOCAL_DENSITY_TOP_K = 10
SOFTMIN_BETA = 6.0
SPARSE_CODE_TOP_K = 32
SPARSE_COARSE_TOP_K = 6


@dataclass(frozen=True)
class Track:
    path: Path
    basin: str


@dataclass(frozen=True)
class Scenario:
    name: str
    transform: Callable[[np.ndarray, np.random.Generator], np.ndarray]


def audio_files(root: Path, limit: int, seed: int) -> list[Track]:
    suffixes = {".m4a", ".mp3", ".flac", ".wav"}
    tracks: list[Track] = []
    all_paths = [path for path in root.rglob("*") if path.suffix.lower() in suffixes]
    rng = random.Random(seed)
    rng.shuffle(all_paths)
    for path in all_paths:
        try:
            rel = path.relative_to(root)
        except ValueError:
            rel = path
        parts = rel.parts
        basin = parts[1] if len(parts) >= 3 else parts[0] if parts else "unknown"
        tracks.append(Track(path=path, basin=basin))
        if len(tracks) >= limit:
            break
    return tracks


def decode_interval(ffmpeg: Path, path: Path, start_seconds: float = 0.0) -> np.ndarray:
    args = [
        str(ffmpeg),
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-ss",
        f"{start_seconds:.3f}",
        "-t",
        f"{INTERVAL_SECONDS:.3f}",
        "-i",
        str(path),
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "f32le",
        "-c:a",
        "pcm_f32le",
        "pipe:1",
    ]
    output = subprocess.check_output(args)
    samples = np.frombuffer(output, dtype="<f4").astype(np.float32)
    return normalize_samples(samples)


def normalize_samples(samples: np.ndarray) -> np.ndarray:
    if samples.size == 0:
        return samples.astype(np.float32)
    centered = samples.astype(np.float32) - np.mean(samples, dtype=np.float64).astype(np.float32)
    centered = np.nan_to_num(centered, nan=0.0, posinf=1.0, neginf=-1.0)
    peak = max(float(np.max(np.abs(centered))), 1.0e-6)
    return np.clip(centered / peak, -1.0, 1.0).astype(np.float32)


def moving_average(samples: np.ndarray, kernel_size: int) -> np.ndarray:
    if samples.size == 0:
        return samples.copy()
    kernel_size = max(kernel_size | 1, 3)
    radius = kernel_size // 2
    padded = np.pad(samples, (radius, radius), mode="edge")
    kernel = np.ones(kernel_size, dtype=np.float32) / np.float32(kernel_size)
    return np.convolve(padded, kernel, mode="valid").astype(np.float32)


def stable_time_mask(samples: np.ndarray) -> np.ndarray:
    masked = samples.copy()
    if masked.size <= 8:
        return masked
    width = max(masked.size // 8, 1)
    max_start = max(masked.size - masked.size // 5, 1)
    start = (masked.size // 3) % max_start
    end = min(start + width, masked.size)
    masked[start:end] = 0.0
    return masked


def embedding_views(samples: np.ndarray) -> list[np.ndarray]:
    clean = normalize_samples(samples)
    smooth = normalize_samples(moving_average(clean, 11))
    low = moving_average(clean, 17)
    high = normalize_samples(clean - low)
    masked = normalize_samples(stable_time_mask(clean))
    return [clean, smooth, high, masked]


def spectral_frames(samples: np.ndarray) -> list[tuple[int, float]]:
    if samples.size == 0:
        return []
    if samples.size <= FRAME_SIZE:
        frames = [samples]
    else:
        frames = [
            samples[start : start + FRAME_SIZE]
            for start in range(0, samples.size - FRAME_SIZE + 1, HOP_SIZE)
        ]
    window = np.hanning(FRAME_SIZE).astype(np.float32)
    result: list[tuple[int, float]] = []
    for frame in frames:
        padded = np.zeros(FRAME_SIZE, dtype=np.float32)
        padded[: frame.size] = frame
        spectrum = np.abs(np.fft.rfft(padded * window)).astype(np.float32)
        energy = float(np.sum(spectrum))
        if not math.isfinite(energy):
            energy = 0.0
        if spectrum.size <= 1 or energy <= 1.0e-6:
            pitch_bucket = 0
        else:
            spectrum[0] = 0.0
            peak_index = int(np.argmax(spectrum))
            pitch_bucket = int(min(15, math.floor(math.log2(max(peak_index, 1)) * 3.0)))
        result.append((pitch_bucket, energy))
    return result


def terminals(samples: np.ndarray) -> list[int]:
    frames = spectral_frames(samples)
    if not frames:
        return [0]
    energies = [energy for _, energy in frames]
    min_energy = min(energies)
    max_energy = max(energies)
    span = max(max_energy - min_energy, 1.0e-6)
    out: list[int] = []
    previous_pitch = frames[0][0]
    for pitch_bucket, energy in frames:
        if pitch_bucket > previous_pitch:
            motion = 1
        elif pitch_bucket < previous_pitch:
            motion = 2
        else:
            motion = 0
        energy_bucket = int(np.clip(math.floor(((energy - min_energy) / span) * 3.0), 0, 3))
        out.append(int((pitch_bucket * 4 + motion + energy_bucket) % TERMINAL_BINS))
        previous_pitch = pitch_bucket
    return out


def normalize_sum(values: np.ndarray) -> np.ndarray:
    total = max(float(np.sum(values)), 1.0)
    return (values / np.float32(total)).astype(np.float32)


def normalize_vector(values: np.ndarray) -> np.ndarray:
    norm = max(float(np.linalg.norm(values)), 1.0e-6)
    return (values / np.float32(norm)).astype(np.float32)


def normalize_vector_batch(values: np.ndarray) -> np.ndarray:
    norms = np.maximum(np.linalg.norm(values, axis=1, keepdims=True), np.float32(1.0e-6))
    return (values / norms.astype(np.float32)).astype(np.float32)


def transition_fingerprint(samples: np.ndarray) -> np.ndarray:
    ts = terminals(samples)
    hist = np.zeros(TERMINAL_BINS, dtype=np.float32)
    delta_hist = np.zeros(TERMINAL_BINS, dtype=np.float32)
    for value in ts:
        hist[value % TERMINAL_BINS] += 1.0
    for left, right in zip(ts, ts[1:]):
        delta_hist[min(abs(right - left), TERMINAL_BINS - 1)] += 1.0
    latent = np.concatenate([normalize_sum(hist), normalize_sum(delta_hist)])

    transition = np.zeros((TERMINAL_BINS, TERMINAL_BINS), dtype=np.float32)
    for left, right in zip(ts, ts[1:]):
        if left != right:
            transition[left, right] += 1.0
    outgoing = normalize_sum(np.sum(transition, axis=1))
    incoming = normalize_sum(np.sum(transition, axis=0))
    row_norm = transition.copy()
    for index in range(TERMINAL_BINS):
        row_norm[index, :] = normalize_sum(row_norm[index, :])
    row_norm = row_norm.reshape(-1) * np.float32(0.25)
    return normalize_vector(np.concatenate([latent, outgoing, incoming, row_norm]))


def embedding(samples: np.ndarray) -> np.ndarray:
    merged = np.zeros(EMBEDDING_WIDTH, dtype=np.float32)
    views = embedding_views(samples)
    for view in views:
        merged += transition_fingerprint(view)
    return normalize_vector(merged / np.float32(len(views)))


def multi_vector_embedding(samples: np.ndarray) -> np.ndarray:
    return np.stack([transition_fingerprint(view) for view in embedding_views(samples)], axis=0).astype(np.float32)


def sparse_topk_codes(vectors: np.ndarray, top_k: int) -> tuple[np.ndarray, np.ndarray]:
    if vectors.ndim != 3:
        raise ValueError(f"expected vectors with shape [items, views, dims], got {vectors.shape}")
    k = max(1, min(int(top_k), vectors.shape[-1]))
    flat = vectors.reshape(-1, vectors.shape[-1])
    indices = np.argpartition(flat, -k, axis=1)[:, -k:]
    values = np.take_along_axis(flat, indices, axis=1)
    order = np.argsort(values, axis=1)[:, ::-1]
    indices = np.take_along_axis(indices, order, axis=1)
    values = np.take_along_axis(values, order, axis=1)
    return indices.reshape(vectors.shape[0], vectors.shape[1], k), values.reshape(vectors.shape[0], vectors.shape[1], k)


def sparse_item_impacts(multi_embeddings: np.ndarray, top_k: int) -> np.ndarray:
    indices, values = sparse_topk_codes(multi_embeddings, top_k)
    impacts = np.zeros((multi_embeddings.shape[0], multi_embeddings.shape[-1]), dtype=np.float32)
    item_indices = np.arange(multi_embeddings.shape[0], dtype=np.int64)[:, None]
    for view_index in range(multi_embeddings.shape[1]):
        np.maximum.at(impacts, (item_indices, indices[:, view_index, :]), values[:, view_index, :])
    return impacts


def sparse_candidate_mask(
    item_impacts: np.ndarray,
    query_multi_embedding: np.ndarray,
    current_index: int,
    *,
    top_k: int,
    coarse_top_k: int,
) -> tuple[np.ndarray, int]:
    query_indices, _query_values = sparse_topk_codes(query_multi_embedding[None, :, :], top_k)
    coarse = max(1, min(int(coarse_top_k), query_indices.shape[-1]))
    active_dims = np.unique(query_indices[:, :, :coarse].reshape(-1))
    if active_dims.size == 0:
        mask = np.zeros(item_impacts.shape[0], dtype=bool)
    else:
        mask = np.any(item_impacts[:, active_dims] > 0.0, axis=1)
    mask[current_index] = False
    if not bool(np.any(mask)):
        mask = np.ones(item_impacts.shape[0], dtype=bool)
        mask[current_index] = False
    return mask, int(active_dims.size)


def sparse_reranked_distribution(
    dense_prob: np.ndarray,
    item_impacts: np.ndarray,
    query_multi_embedding: np.ndarray,
    current_index: int,
    *,
    top_k: int,
    coarse_top_k: int,
) -> tuple[np.ndarray, dict[str, float]]:
    mask, active_dim_count = sparse_candidate_mask(
        item_impacts,
        query_multi_embedding,
        current_index,
        top_k=top_k,
        coarse_top_k=coarse_top_k,
    )
    weights = np.where(mask, dense_prob, 0.0).astype(np.float32)
    total = float(np.sum(weights))
    if total <= 0.0 or not math.isfinite(total):
        weights = dense_prob.copy()
        weights[current_index] = 0.0
        total = float(np.sum(weights))
    candidate_count = int(np.sum(mask))
    possible_count = max(item_impacts.shape[0] - 1, 1)
    return weights / np.float32(max(total, 1.0e-9)), {
        "candidate_count": float(candidate_count),
        "candidate_fraction": float(candidate_count / possible_count),
        "active_dim_count": float(active_dim_count),
    }


def centered_cosine(left: np.ndarray, right: np.ndarray, mean: np.ndarray) -> float:
    l = left - mean
    r = right - mean
    denom = max(float(np.linalg.norm(l) * np.linalg.norm(r)), 1.0e-6)
    return float(np.clip(np.dot(l, r) / denom, -1.0, 1.0))


def sampling_geometry(embeddings: np.ndarray) -> tuple[np.ndarray, np.ndarray, float, float]:
    mean = np.mean(embeddings, axis=0).astype(np.float32)
    n = embeddings.shape[0]
    sims = np.zeros((n, n), dtype=np.float32)
    for i in range(n):
        for j in range(n):
            if i == j:
                sims[i, j] = -1.0
            else:
                sims[i, j] = centered_cosine(embeddings[i], embeddings[j], mean)
    density = np.zeros(n, dtype=np.float32)
    for i in range(n):
        row = np.sort(sims[i])[::-1][:LOCAL_DENSITY_TOP_K]
        valid = row[np.isfinite(row)]
        density[i] = float(np.mean(valid)) if valid.size else 0.0
    corrected_values: list[float] = []
    for i in range(n):
        for j in np.argsort(sims[i])[::-1][:LOCAL_DENSITY_TOP_K]:
            if i == j:
                continue
            corrected_values.append(float(2.0 * sims[i, j] - density[i] - density[j]))
    if corrected_values:
        low = float(np.quantile(corrected_values, 0.01))
        high = float(np.quantile(corrected_values, 0.99))
        if abs(high - low) <= 1.0e-6:
            low, high = low - 1.0, high + 1.0
    else:
        low, high = -1.0, 1.0
    return mean, density, low, high


def corrected_similarity(
    embeddings: np.ndarray,
    mean: np.ndarray,
    density: np.ndarray,
    low: float,
    high: float,
    left_index: int,
    right_index: int,
) -> float:
    sim = centered_cosine(embeddings[left_index], embeddings[right_index], mean)
    corrected = 2.0 * sim - float(density[left_index]) - float(density[right_index])
    return float(2.0 * (corrected - low) / max(high - low, 1.0e-6) - 1.0)


def recommendation_distribution(
    embeddings: np.ndarray,
    basins: list[str],
    current_index: int,
    history: list[int],
) -> tuple[np.ndarray, np.ndarray]:
    mean, density, low, high = sampling_geometry(embeddings)
    similarities = np.array(
        [
            corrected_similarity(embeddings, mean, density, low, high, current_index, i)
            if i != current_index
            else np.nan
            for i in range(embeddings.shape[0])
        ],
        dtype=np.float32,
    )
    penalties = basin_penalties(basins, history)
    distances = (1.0 - np.clip(similarities, -1.0, 1.0)) * 0.5
    log_weights = -SOFTMIN_BETA * distances - penalties
    weights = np.where(np.isfinite(log_weights), np.exp(np.clip(log_weights, -30.0, 30.0)), 0.0)
    weights[current_index] = 0.0
    total = float(np.sum(weights))
    if total <= 0.0 or not math.isfinite(total):
        weights = np.ones(embeddings.shape[0], dtype=np.float32)
        weights[current_index] = 0.0
        total = float(np.sum(weights))
    return weights / np.float32(total), similarities


def basin_penalties(basins: list[str], history: list[int]) -> np.ndarray:
    if not history:
        return np.zeros(len(basins), dtype=np.float32)
    fatigue: dict[str, float] = {}
    usage: dict[str, float] = {}
    current_basin: str | None = None
    current_run = 0
    counts: dict[str, int] = {}
    for basin in basins:
        counts[basin] = counts.get(basin, 0) + 1
    target_total = sum(math.sqrt(value) for value in counts.values())
    target = {key: math.sqrt(value) / target_total for key, value in counts.items()}
    for index in history:
        basin = basins[index]
        fatigue = {key: value * 0.86 for key, value in fatigue.items() if value * 0.86 > 1.0e-6}
        usage = {key: value * 0.93 for key, value in usage.items() if value * 0.93 > 1.0e-6}
        fatigue[basin] = fatigue.get(basin, 0.0) + 1.0
        usage[basin] = usage.get(basin, 0.0) + 1.0
        if current_basin == basin:
            current_run += 1
        else:
            current_basin = basin
            current_run = 1
    usage_total = sum(value for value in usage.values() if math.isfinite(value) and value > 0.0)
    out = []
    for basin in basins:
        fatigue_part = fatigue.get(basin, 0.0)
        usage_share = usage.get(basin, 0.0) / usage_total if usage_total > 0.0 else 0.0
        homeostatic = max(usage_share - target.get(basin, 0.0), 0.0) * 3.40
        hazard = math.log(max(current_run, 1)) * 0.95 if current_basin == basin else 0.0
        out.append(min(max(fatigue_part + homeostatic + hazard, 0.0), 2.0))
    return np.array(out, dtype=np.float32)


def identity(samples: np.ndarray, _: np.random.Generator) -> np.ndarray:
    return samples.copy()


def louder(samples: np.ndarray, _: np.random.Generator) -> np.ndarray:
    return np.clip(samples * np.float32(0.55), -1.0, 1.0)


def noisy(samples: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    return np.clip(samples + rng.normal(0.0, 0.018, size=samples.shape).astype(np.float32), -1.0, 1.0)


def eq_tilt(samples: np.ndarray, _: np.random.Generator) -> np.ndarray:
    low = moving_average(samples, 23)
    high = samples - low
    return normalize_samples(low * np.float32(0.7) + high * np.float32(1.35))


def crop_shift(samples: np.ndarray, _: np.random.Generator) -> np.ndarray:
    shift = max(samples.size // 20, 1)
    return np.roll(samples, shift)


def dropout(samples: np.ndarray, _: np.random.Generator) -> np.ndarray:
    masked = samples.copy()
    width = max(samples.size // 12, 1)
    start = samples.size // 2
    masked[start : min(start + width, masked.size)] = 0.0
    return masked


def kl_divergence(left: np.ndarray, right: np.ndarray) -> float:
    eps = 1.0e-9
    return float(np.sum(left * np.log((left + eps) / (right + eps))))


def top_k(prob: np.ndarray, k: int) -> list[int]:
    return list(np.argsort(prob)[::-1][:k])


def run(args: argparse.Namespace) -> dict:
    rng = np.random.default_rng(args.seed)
    tracks = audio_files(args.audio_root, args.limit, args.seed)
    if len(tracks) < 6:
        raise SystemExit("need at least 6 audio files for this experiment")

    samples: list[np.ndarray] = []
    kept_tracks: list[Track] = []
    for track in tracks:
        try:
            decoded = decode_interval(args.ffmpeg, track.path)
        except Exception as error:
            print(f"skip decode failure: {track.path} :: {error}")
            continue
        if decoded.size:
            kept_tracks.append(track)
            samples.append(decoded)
        if len(kept_tracks) >= args.limit:
            break
    tracks = kept_tracks
    if len(tracks) < 6:
        raise SystemExit("not enough decodable tracks")

    scenarios = [
        Scenario("identity", identity),
        Scenario("gain_change", louder),
        Scenario("additive_noise", noisy),
        Scenario("eq_tilt", eq_tilt),
        Scenario("crop_shift", crop_shift),
        Scenario("time_dropout", dropout),
    ]
    base_multi_embeddings = np.stack([multi_vector_embedding(sample) for sample in samples], axis=0)
    base_embeddings = normalize_vector_batch(np.mean(base_multi_embeddings, axis=1).astype(np.float32))
    base_sparse_impacts = sparse_item_impacts(base_multi_embeddings, args.sparse_code_top_k)
    basins = [track.basin for track in tracks]
    current_indices = list(range(min(args.anchors, len(tracks))))
    history = list(range(min(8, len(tracks))))

    rows = []
    sparse_rows = []
    scenario_embeddings: dict[str, np.ndarray] = {}
    for scenario in scenarios:
        transformed_multi = np.stack(
            [multi_vector_embedding(scenario.transform(sample, rng)) for sample in samples],
            axis=0,
        )
        transformed = normalize_vector_batch(np.mean(transformed_multi, axis=1).astype(np.float32))
        transformed_sparse_impacts = sparse_item_impacts(transformed_multi, args.sparse_code_top_k)
        scenario_embeddings[scenario.name] = transformed
        self_cosines = np.array(
            [
                float(np.dot(base_embeddings[i], transformed[i]))
                / max(float(np.linalg.norm(base_embeddings[i]) * np.linalg.norm(transformed[i])), 1.0e-6)
                for i in range(len(tracks))
            ],
            dtype=np.float32,
        )
        for current_index in current_indices:
            base_prob, _ = recommendation_distribution(base_embeddings, basins, current_index, history)
            transformed_prob, _ = recommendation_distribution(transformed, basins, current_index, history)
            base_top = top_k(base_prob, args.top_k)
            transformed_top = top_k(transformed_prob, args.top_k)
            base_sparse_prob, base_sparse_stats = sparse_reranked_distribution(
                base_prob,
                base_sparse_impacts,
                base_multi_embeddings[current_index],
                current_index,
                top_k=args.sparse_code_top_k,
                coarse_top_k=args.sparse_coarse_top_k,
            )
            transformed_sparse_prob, transformed_sparse_stats = sparse_reranked_distribution(
                transformed_prob,
                transformed_sparse_impacts,
                transformed_multi[current_index],
                current_index,
                top_k=args.sparse_code_top_k,
                coarse_top_k=args.sparse_coarse_top_k,
            )
            base_sparse_top = top_k(base_sparse_prob, args.top_k)
            transformed_sparse_top = top_k(transformed_sparse_prob, args.top_k)
            dense_top_set = set(base_top)
            sparse_top_set = set(base_sparse_top)
            transformed_dense_top_set = set(transformed_top)
            transformed_sparse_top_set = set(transformed_sparse_top)
            rows.append(
                {
                    "scenario": scenario.name,
                    "anchor": tracks[current_index].path.stem,
                    "self_cosine_mean": float(np.mean(self_cosines)),
                    "self_cosine_min": float(np.min(self_cosines)),
                    "top1_same": bool(base_top[0] == transformed_top[0]),
                    "top3_overlap": len(set(base_top).intersection(transformed_top)) / args.top_k,
                    "kl": kl_divergence(base_prob, transformed_prob),
                    "base_top1": tracks[base_top[0]].path.stem,
                    "transformed_top1": tracks[transformed_top[0]].path.stem,
                    "base_top1_basin": tracks[base_top[0]].basin,
                    "transformed_top1_basin": tracks[transformed_top[0]].basin,
                }
            )
            sparse_rows.append(
                {
                    "scenario": scenario.name,
                    "anchor": tracks[current_index].path.stem,
                    "base_candidate_fraction": base_sparse_stats["candidate_fraction"],
                    "transformed_candidate_fraction": transformed_sparse_stats["candidate_fraction"],
                    "base_candidate_count": base_sparse_stats["candidate_count"],
                    "transformed_candidate_count": transformed_sparse_stats["candidate_count"],
                    "base_active_dim_count": base_sparse_stats["active_dim_count"],
                    "transformed_active_dim_count": transformed_sparse_stats["active_dim_count"],
                    "base_sparse_top1_matches_dense": bool(base_sparse_top[0] == base_top[0]),
                    "transformed_sparse_top1_matches_dense": bool(transformed_sparse_top[0] == transformed_top[0]),
                    "base_sparse_topk_recall": len(dense_top_set.intersection(sparse_top_set)) / args.top_k,
                    "transformed_sparse_topk_recall": len(
                        transformed_dense_top_set.intersection(transformed_sparse_top_set)
                    )
                    / args.top_k,
                    "sparse_top1_same_under_transform": bool(base_sparse_top[0] == transformed_sparse_top[0]),
                    "sparse_topk_overlap_under_transform": len(set(base_sparse_top).intersection(transformed_sparse_top))
                    / args.top_k,
                    "base_sparse_top1": tracks[base_sparse_top[0]].path.stem,
                    "transformed_sparse_top1": tracks[transformed_sparse_top[0]].path.stem,
                }
            )

    summary = []
    for scenario in scenarios:
        scenario_rows = [row for row in rows if row["scenario"] == scenario.name]
        scenario_sparse_rows = [row for row in sparse_rows if row["scenario"] == scenario.name]
        summary.append(
            {
                "scenario": scenario.name,
                "self_cosine_mean": float(np.mean([row["self_cosine_mean"] for row in scenario_rows])),
                "self_cosine_min": float(np.min([row["self_cosine_min"] for row in scenario_rows])),
                "top1_stability": float(np.mean([row["top1_same"] for row in scenario_rows])),
                "top3_overlap": float(np.mean([row["top3_overlap"] for row in scenario_rows])),
                "mean_kl": float(np.mean([row["kl"] for row in scenario_rows])),
                "sparse_candidate_fraction": float(
                    np.mean(
                        [
                            (row["base_candidate_fraction"] + row["transformed_candidate_fraction"]) * 0.5
                            for row in scenario_sparse_rows
                        ]
                    )
                ),
                "sparse_top1_dense_agreement": float(
                    np.mean(
                        [
                            row["base_sparse_top1_matches_dense"] and row["transformed_sparse_top1_matches_dense"]
                            for row in scenario_sparse_rows
                        ]
                    )
                ),
                "sparse_top3_dense_recall": float(
                    np.mean(
                        [
                            (row["base_sparse_topk_recall"] + row["transformed_sparse_topk_recall"]) * 0.5
                            for row in scenario_sparse_rows
                        ]
                    )
                ),
                "sparse_top1_stability": float(
                    np.mean([row["sparse_top1_same_under_transform"] for row in scenario_sparse_rows])
                ),
                "sparse_top3_overlap": float(
                    np.mean([row["sparse_topk_overlap_under_transform"] for row in scenario_sparse_rows])
                ),
            }
        )

    return {
        "paper_mechanism": "dynamic multi-axis embedding robustness probe plus SSR-style sparse inverted candidate recall",
        "track_count": len(tracks),
        "anchor_count": len(current_indices),
        "audio_root": str(args.audio_root),
        "sparse_retrieval": {
            "mechanism": (
                "SSR-inspired sparse top-k code dimensions act as inverted-index posting keys; "
                "the experiment only filters candidates, then reranks with the existing dense recommendation scores."
            ),
            "code_top_k": args.sparse_code_top_k,
            "coarse_top_k": args.sparse_coarse_top_k,
            "dense_score_owner": "recommendation_distribution",
        },
        "summary": summary,
        "examples": rows[: min(len(rows), 24)],
        "sparse_examples": sparse_rows[: min(len(sparse_rows), 24)],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio-root", type=Path, default=Path(r"C:\Users\admin\Documents\slisic\youtube"))
    parser.add_argument("--ffmpeg", type=Path, default=Path(r"C:\Users\admin\AppData\Local\slisic\bin\ffmpeg.exe"))
    parser.add_argument("--limit", type=int, default=32)
    parser.add_argument("--anchors", type=int, default=8)
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--sparse-code-top-k", type=int, default=SPARSE_CODE_TOP_K)
    parser.add_argument("--sparse-coarse-top-k", type=int, default=SPARSE_COARSE_TOP_K)
    parser.add_argument("--seed", type=int, default=28190)
    parser.add_argument("--out", type=Path, default=Path("scratch/experiments/hteb_audio_robustness.result.json"))
    args = parser.parse_args()

    result = run(args)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result["summary"], indent=2, ensure_ascii=False))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
