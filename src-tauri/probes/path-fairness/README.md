# Audio Style Path Fairness Rust Probe

This crate contains Rust reproductions of the conserved-flow control and the
neural symbolic audio-program traversal experiment without linking the Tauri
application at runtime.

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

## Symbolic program reproduction

The symbolic probe does not let each runtime reconstruct its own floating
top-k relation. ANN's neural compiler emits one generation-owned finite
encoding containing:

- the stable track-order signature;
- the complete top-96 candidate relation and its signature;
- the expected complete-successor program lineages and aggregate signature.

Rust reads that encoding, independently recompiles every cyclic candidate-rank
presentation into a perfect matching, quotients identical successor laws, and
rejects any lineage or signature mismatch. The encoded relation owns program
identity; a Rust-local embedding calculation is used only for observation
metrics.

Generate the encoding and Python evidence from the ANN repository:

```text
uv run python experiments/audio_style_trajectory_dynamics/symbolic_audio_program_traversal_probe.py \
  --device cpu \
  --tracks-per-list 32 \
  --output outputs/audio_style_trajectory_dynamics/symbolic-audio-program-32.json \
  --program-encoding-output outputs/audio_style_trajectory_dynamics/generation-90-program-encoding.json
```

Then reproduce the same finite program in Rust:

```text
cargo test --manifest-path src-tauri/probes/path-fairness/Cargo.toml \
  --bin symbolic_audio_program_probe

cargo run --release \
  --manifest-path src-tauri/probes/path-fairness/Cargo.toml \
  --bin symbolic_audio_program_probe -- \
  <stable.json> <generation-90-program-encoding.json> <report.json> 32
```

The generation-90 receipts are
[`receipts/symbolic-program-generation-90-32.json`](receipts/symbolic-program-generation-90-32.json)
and
[`receipts/symbolic-program-generation-90-64.json`](receipts/symbolic-program-generation-90-64.json).
Both execute all 2,825 real starts with zero realized-track replay and zero
cross-list overlap. Python and Rust produce the same 96 program lineages,
departure counts (`729` and `982`), median residence (`64` and `128`), target
occurrences (`75` and `144`), and future/history-overlap summaries. This is
path-level reproduction, not a tolerance-based aggregate comparison.
