# Audio Style Path Fairness Rust Probe

This crate reproduces the conserved audio-style path-fairness experiment in
Rust without linking the Tauri application or invoking Python.

The implementation keeps three owners separate:

- Stable model generation builds the centered top-96 candidate graph, solves a
  track-uniform conserved flow, applies the reciprocal capacity projection, and
  solves the minimum `(previous, current)` lifted coupling.
- A session excludes its current 48-track history after structural
  probabilities are calculated.
- Listener-owned, track-keyed anti-FSRS memory attenuates the remaining
  candidates. Basin pressure is projected from those track exposures through
  the current model and is never persisted.

The expensive solver is model-generation work. Its f32 base probabilities and
successor potential must be cached by stable model generation; playlist or
session initialization must never rebuild them.

## Run

From the repository root:

```text
cargo test --manifest-path src-tauri/probes/path-fairness/Cargo.toml
cargo run --release --manifest-path src-tauri/Cargo.toml \
  -p slisic-path-fairness-probe -- \
  <stable.json> <report.json>
```

When the first argument is omitted, the probe reads Slisic's stable model from
the current user's local application data directory.

The real generation-90 run used 2,825 tracks, 4,352-dimensional embeddings,
55 diagnostic basins, and eight fixed seeds. It completed the full 18-step
continuity-dual search rather than hard-coding the Python result. The run took
about 15 minutes with a hard limit of 20 Rayon workers; runtime sampling is not
part of that cost.

See
[`receipts/stable-generation-90.json`](receipts/stable-generation-90.json) for
the measured receipt.

## Reproduction boundary

The Rust probe uses a deterministic SplitMix64 draw stream, while the Python
probe uses PyTorch's generator. Individual paths are therefore not expected to
be bit-identical. Reproduction means:

- the same structural dual and continuity are recovered from the same stable
  embeddings;
- row, column, reciprocal-cap, and zero-backtrack invariants close;
- anti-FSRS improves adjacent-session real-embedding style recurrence on at
  least six of eight paired seeds with a 95% interval below zero;
- the basin projection is attributed separately from track-only inhibition.

The generation-90 Rust run recovered `beta = 56`, continuity `0.2925304183`,
reciprocal flow `0.9491017762`, and exact zero backtracking. Adjacent-session
nearest style cosine changed by `-0.01402324`; seven of eight seeds improved and
the paired 95% interval was `[-0.02500203, -0.00304445]`.
