from __future__ import annotations

import argparse
import math
import re
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable


NOW_PLAY_RE = re.compile(
    r'\[now play\].*?title="(?P<title>.*?)"\s+'
    r"integrated=(?P<integrated>-?\d+(?:\.\d+)?)\s+"
    r"base_gain=(?P<base_gain>-?\d+(?:\.\d+)?)\s+"
    r"final_gain=(?P<final_gain>-?\d+(?:\.\d+)?)\s+"
    r"target_lufs=(?P<target_lufs>-?\d+(?:\.\d+)?)\s+"
    r"true_peak=(?P<true_peak>none|-?\d+(?:\.\d+)?)\s+"
    r"lra=(?P<lra>none|-?\d+(?:\.\d+)?)\s+"
    r"short_p50=(?P<p50>none|-?\d+(?:\.\d+)?)\s+"
    r"short_p80=(?P<p80>none|-?\d+(?:\.\d+)?)\s+"
    r"short_p95=(?P<p95>none|-?\d+(?:\.\d+)?)\s+"
    r"short_max=(?P<pmax>none|-?\d+(?:\.\d+)?)\s+"
    r"presence=(?P<presence>none|-?\d+(?:\.\d+)?)\s+"
    r"correction=(?P<correction>-?\d+(?:\.\d+)?)"
)

TARGET_LUFS = -18.0


@dataclass(frozen=True)
class LoudnessSample:
    title: str
    integrated: float
    current_gain: float
    true_peak: float | None
    lra: float
    p50: float
    p80: float
    p95: float
    pmax: float
    presence: float


@dataclass(frozen=True)
class GainResult:
    sample: LoudnessSample
    gain: float

    @property
    def post_p50(self) -> float:
        return self.sample.p50 + self.gain

    @property
    def post_p80(self) -> float:
        return self.sample.p80 + self.gain

    @property
    def post_p95(self) -> float:
        return self.sample.p95 + self.gain

    @property
    def post_presence(self) -> float:
        return self.sample.presence + self.gain

    @property
    def post_true_peak(self) -> float | None:
        if self.sample.true_peak is None:
            return None
        return self.sample.true_peak + self.gain

    @property
    def perceived_proxy(self) -> float:
        # One scalar for experiment comparison only. It intentionally weights the
        # upper body of short-term loudness because random playback discomfort is
        # dominated by sustained p80/p95, not integrated loudness alone.
        body = self.post_p50 * 0.30 + self.post_p80 * 0.42 + self.post_p95 * 0.28
        presence_excess = max(0.0, self.post_presence - (-18.0))
        density_excess = max(0.0, (8.0 - self.sample.lra) / 8.0)
        return body + presence_excess * 0.12 + density_excess * 0.35


def parse_optional(value: str) -> float | None:
    if value == "none":
        return None
    return float(value)


def parse_samples(paths: Iterable[Path]) -> list[LoudnessSample]:
    samples: list[LoudnessSample] = []
    seen: set[tuple[str, float, float, float, float, float]] = set()
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for match in NOW_PLAY_RE.finditer(text):
            p50 = parse_optional(match.group("p50"))
            p80 = parse_optional(match.group("p80"))
            p95 = parse_optional(match.group("p95"))
            pmax = parse_optional(match.group("pmax"))
            lra = parse_optional(match.group("lra"))
            presence = parse_optional(match.group("presence"))
            if None in (p50, p80, p95, pmax, lra, presence):
                continue
            sample = LoudnessSample(
                title=match.group("title"),
                integrated=float(match.group("integrated")),
                current_gain=float(match.group("final_gain")),
                true_peak=parse_optional(match.group("true_peak")),
                lra=float(lra),
                p50=float(p50),
                p80=float(p80),
                p95=float(p95),
                pmax=float(pmax),
                presence=float(presence),
            )
            key = (
                sample.title,
                sample.integrated,
                sample.p50,
                sample.p80,
                sample.p95,
                sample.presence,
            )
            if key not in seen:
                samples.append(sample)
                seen.add(key)
    return samples


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def gain_current_code(sample: LoudnessSample) -> float:
    base = TARGET_LUFS - sample.integrated
    body = sample.p50 * 0.65 + sample.p80 * 0.25 + sample.p95 * 0.10
    short_corr = clamp(((body + base) - TARGET_LUFS) * -0.5, -2.0, 2.0)
    presence_corr = clamp(((-10.0 - sample.presence) * 0.2), -0.75, 0.75)
    total = clamp(short_corr + presence_corr, -3.0, 3.0)
    return base + total


def gain_integrated(sample: LoudnessSample) -> float:
    return TARGET_LUFS - sample.integrated


def gain_upper_body_anchor(sample: LoudnessSample) -> float:
    body = sample.p50 * 0.30 + sample.p80 * 0.42 + sample.p95 * 0.28
    presence_corr = clamp(((-10.0 - sample.presence) * 0.10), -0.45, 0.45)
    return TARGET_LUFS - body + presence_corr


def gain_upper_body_density(sample: LoudnessSample) -> float:
    body = sample.p50 * 0.26 + sample.p80 * 0.40 + sample.p95 * 0.34
    density = clamp((8.0 - sample.lra) / 8.0, 0.0, 1.0)
    low_range_high_density_penalty = 0.70 * density
    presence_corr = clamp(((-10.0 - sample.presence) * 0.08), -0.35, 0.35)
    true_peak_guard = 0.0
    if sample.true_peak is not None:
        predicted_peak = sample.true_peak + (TARGET_LUFS - body)
        true_peak_guard = clamp(predicted_peak - (-1.0), 0.0, 0.6)
    return TARGET_LUFS - body - low_range_high_density_penalty - true_peak_guard + presence_corr


def gain_p95_guard(sample: LoudnessSample) -> float:
    body = sample.p50 * 0.22 + sample.p80 * 0.36 + sample.p95 * 0.42
    gain = TARGET_LUFS - body
    post_p95 = sample.p95 + gain
    p95_penalty = clamp(post_p95 - (-16.7), 0.0, 1.0) * 0.65
    density = clamp((7.0 - sample.lra) / 7.0, 0.0, 1.0)
    return gain - p95_penalty - 0.45 * density


FORMULAS: dict[str, Callable[[LoudnessSample], float]] = {
    "logged_current": lambda sample: sample.current_gain,
    "current_code": gain_current_code,
    "integrated_only": gain_integrated,
    "upper_body_anchor": gain_upper_body_anchor,
    "upper_body_density": gain_upper_body_density,
    "p95_guard": gain_p95_guard,
}


def quantile(values: list[float], q: float) -> float:
    if not values:
        return math.nan
    ordered = sorted(values)
    index = (len(ordered) - 1) * q
    low = math.floor(index)
    high = math.ceil(index)
    if low == high:
        return ordered[low]
    return ordered[low] * (high - index) + ordered[high] * (index - low)


def spread(values: list[float]) -> float:
    return quantile(values, 0.90) - quantile(values, 0.10)


def summarize(name: str, results: list[GainResult]) -> dict[str, float]:
    metrics = {
        "gain_mean": statistics.fmean([row.gain for row in results]),
        "gain_sd": statistics.pstdev([row.gain for row in results]),
        "proxy_sd": statistics.pstdev([row.perceived_proxy for row in results]),
        "proxy_spread": spread([row.perceived_proxy for row in results]),
        "p50_sd": statistics.pstdev([row.post_p50 for row in results]),
        "p80_sd": statistics.pstdev([row.post_p80 for row in results]),
        "p95_sd": statistics.pstdev([row.post_p95 for row in results]),
        "p95_spread": spread([row.post_p95 for row in results]),
        "presence_sd": statistics.pstdev([row.post_presence for row in results]),
        "peak_over_minus1": sum(
            1
            for row in results
            if row.post_true_peak is not None and row.post_true_peak > -1.0
        ),
    }
    print(
        f"{name:20s} "
        f"proxy_sd={metrics['proxy_sd']:.3f} proxy_p90-p10={metrics['proxy_spread']:.3f} "
        f"p80_sd={metrics['p80_sd']:.3f} p95_sd={metrics['p95_sd']:.3f} "
        f"p95_p90-p10={metrics['p95_spread']:.3f} "
        f"peak>-1={metrics['peak_over_minus1']:.0f}"
    )
    return metrics


def print_pair(results_by_name: dict[str, list[GainResult]], title_a: str, title_b: str) -> None:
    print("\nPair focus:")
    for name, rows in results_by_name.items():
        picked = [
            row
            for row in rows
            if title_a.lower() in row.sample.title.lower()
            or title_b.lower() in row.sample.title.lower()
        ]
        if len(picked) < 2:
            continue
        print(f"\n{name}")
        for row in picked:
            peak = "none" if row.post_true_peak is None else f"{row.post_true_peak:.2f}"
            print(
                f"  {row.sample.title[:44]:44s} "
                f"gain={row.gain:6.2f} proxy={row.perceived_proxy:6.2f} "
                f"p50={row.post_p50:6.2f} p80={row.post_p80:6.2f} "
                f"p95={row.post_p95:6.2f} presence={row.post_presence:6.2f} "
                f"peak={peak:>6s} lra={row.sample.lra:4.1f}"
            )


def print_subset_summaries(samples: list[LoudnessSample]) -> None:
    subsets: list[tuple[str, Callable[[LoudnessSample], bool]]] = [
        ("dense_lra_le_6", lambda sample: sample.lra <= 6.0),
        ("dynamic_lra_ge_11", lambda sample: sample.lra >= 11.0),
        ("hot_integrated_gt_neg10", lambda sample: sample.integrated > -10.0),
        ("quiet_integrated_lt_neg16", lambda sample: sample.integrated < -16.0),
    ]
    for subset_name, predicate in subsets:
        subset = [sample for sample in samples if predicate(sample)]
        print(f"\nSubset {subset_name}: samples={len(subset)}")
        if len(subset) < 2:
            continue
        for name, formula in FORMULAS.items():
            summarize(name, [GainResult(sample, formula(sample)) for sample in subset])


def score_results(results: list[GainResult]) -> float:
    proxy_sd = statistics.pstdev([row.perceived_proxy for row in results])
    p95_sd = statistics.pstdev([row.post_p95 for row in results])
    p80_sd = statistics.pstdev([row.post_p80 for row in results])
    peak_over_minus1 = sum(
        1 for row in results if row.post_true_peak is not None and row.post_true_peak > -1.0
    )
    return proxy_sd + p95_sd * 0.35 + p80_sd * 0.12 + peak_over_minus1 * 0.01


def make_grid_formula(
    w50: float,
    w80: float,
    density_penalty: float,
    p95_guard_strength: float,
    presence_slope: float,
    peak_guard_strength: float,
) -> Callable[[LoudnessSample], float]:
    w95 = 1.0 - w50 - w80

    def formula(sample: LoudnessSample) -> float:
        body = sample.p50 * w50 + sample.p80 * w80 + sample.p95 * w95
        gain = TARGET_LUFS - body
        density = clamp((8.0 - sample.lra) / 8.0, 0.0, 1.0)
        gain -= density_penalty * density
        post_p95 = sample.p95 + gain
        gain -= p95_guard_strength * clamp(post_p95 - (-16.8), 0.0, 1.4)
        gain += clamp(((-10.0 - sample.presence) * presence_slope), -0.35, 0.35)
        if sample.true_peak is not None:
            post_peak = sample.true_peak + gain
            gain -= peak_guard_strength * clamp(post_peak - (-1.0), 0.0, 1.5)
        return gain

    return formula


def print_grid_search(samples: list[LoudnessSample]) -> None:
    candidates: list[tuple[float, str, Callable[[LoudnessSample], float]]] = []
    for w50 in [0.15, 0.20, 0.25, 0.30]:
        for w80 in [0.30, 0.36, 0.42, 0.48]:
            if w50 + w80 >= 0.90:
                continue
            for density_penalty in [0.0, 0.35, 0.55, 0.75]:
                for p95_guard_strength in [0.0, 0.30, 0.55, 0.80]:
                    for presence_slope in [0.0, 0.04, 0.08]:
                        for peak_guard_strength in [0.0, 0.35, 0.55]:
                            formula = make_grid_formula(
                                w50,
                                w80,
                                density_penalty,
                                p95_guard_strength,
                                presence_slope,
                                peak_guard_strength,
                            )
                            results = [GainResult(sample, formula(sample)) for sample in samples]
                            label = (
                                f"w50={w50:.2f},w80={w80:.2f},w95={1.0 - w50 - w80:.2f},"
                                f"density={density_penalty:.2f},p95guard={p95_guard_strength:.2f},"
                                f"presence={presence_slope:.2f},peak={peak_guard_strength:.2f}"
                            )
                            candidates.append((score_results(results), label, formula))

    print("\nGrid search top 10:")
    for score, label, formula in sorted(candidates, key=lambda row: row[0])[:10]:
        results = [GainResult(sample, formula(sample)) for sample in samples]
        print(f"  score={score:.3f} {label}")
        summarize("    grid", results)


def attachment_texts(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    return list(root.rglob("pasted-text.txt"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--logs",
        type=Path,
        default=Path(r"C:\Users\admin\.codex\attachments"),
        help="A pasted-text file or a directory containing pasted-text.txt files.",
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--subsets", action="store_true")
    parser.add_argument("--grid", action="store_true")
    args = parser.parse_args()

    samples = parse_samples(attachment_texts(args.logs))
    if args.limit > 0:
        samples = samples[: args.limit]
    if not samples:
        raise SystemExit("no [now play] loudness samples found")

    print(f"samples={len(samples)}")
    results_by_name: dict[str, list[GainResult]] = {}
    scored: list[tuple[float, str]] = []
    for name, formula in FORMULAS.items():
        results = [GainResult(sample, formula(sample)) for sample in samples]
        results_by_name[name] = results
        metrics = summarize(name, results)
        score = metrics["proxy_sd"] + metrics["p95_sd"] * 0.35 + metrics["peak_over_minus1"] * 0.01
        scored.append((score, name))

    print("\nRanking:")
    for score, name in sorted(scored):
        print(f"  {name:20s} score={score:.3f}")

    print_pair(results_by_name, "KIRISAME", "Woodkid – To The Wilder")
    if args.subsets:
        print_subset_summaries(samples)
    if args.grid:
        print_grid_search(samples)


if __name__ == "__main__":
    main()
