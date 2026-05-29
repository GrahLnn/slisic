# Slisic

Slisic is a local-first desktop music library and player. It combines URL
downloads, local folder import, playlist configuration, model-driven playback,
waveform editing, and managed media tooling in one Tauri application.

The app is built for a library that lives on disk. The database stores the
relationships between collections, groups, tracks, playlists, exclusions, and
edited ranges; the audio files remain in the configured save root.

## Core Behavior

### Library And Storage

- The default save root is the user's documents folder under `slisic`.
- Collections own downloaded or imported music files.
- Groups belong to collections and give playlist configuration a smaller scope
  than a whole collection.
- Playlists are made from collections, groups, and extra tracks.
- Excludes and liked state are stored as library facts, not as playback-only
  UI state.
- Local collection manifests use `.slisic.collection.toml` so imported folders
  can restore collection, group, music, range, and liked evidence.

### Download And Import

- URL ingestion is powered by `yt-dlp`.
- Download tasks persist residual leaf work so interrupted playlist downloads
  can resume without re-probing completed work.
- Provider access failures such as private videos are terminal leaf failures;
  they are not retried.
- Downloaded files are committed through the collection importer before they
  become stable library music.
- Local folder import scans recursively and accepts files that FFmpeg can decode.
- Existing files and temporary residue are recovery evidence only; they do not
  define playlist membership.

### Playlist Playback

- Clicking a playlist starts from a random playable track in that playlist.
- The first track is live randomness; no fixed seed or persisted random order is
  used.
- Later tracks are selected by the audio-style recommendation path.
- The playable-source index prepares one startup option per playlist in the
  background so click latency does not grow with playlist size.
- The player consumes an explicit queue and does not query playlist membership.
- Queue refreshes are generation checked, so late async results cannot replace a
  newer playback session.
- Backend playback normalization currently targets `-18 LUFS`.

### Recommendation Model

- Audio-style embeddings are extracted from local audio through FFmpeg.
- Embeddings are cached by file identity, edit range, embedding version, and
  file metadata.
- Next-track sampling uses a distance-based softmin over playlist-scoped
  candidates.
- Local density correction, recent-history filtering, and attractor-basin
  pressure keep playback from collapsing into short repeated loops.
- Cache hit or miss changes latency and model availability; it does not change
  library membership or whether a track is playable.

### Spectrum And Editing

- The spectrum page renders waveform summaries and tiles for the current track.
- Zoom, pan, selection editing, playhead presentation, and seek are separate
  behavior owners.
- Track identity is projected from a normalized file path before it keys waveform
  cache or playback scope.
- Selection edits operate in real audio seconds; visual padding is never an
  editable audio range.
- Edited titles and ranges update library music identity and the active playback
  session when the edited track is current.

### Desktop Runtime

- The frontend is React 19 on Rsbuild.
- The shell is Tauri 2 with Rust backend commands exported to TypeScript through
  Tauri Specta.
- SurrealDB through `appdb` stores the local application data.
- FFmpeg and yt-dlp are managed binaries. The app installs or updates them in
  the background and defers activation while playback or download work is active.
- A bundled Bun runtime sidecar is included for packaged desktop builds.

## Repository Layout

```text
src/
  App.tsx                         Main page composition
  cmd/                            Generated Tauri command bindings
  components/                     Playlist, config, playback, and spectrum UI
  flow/                           Frontend state machines and effect owners

src-tauri/
  src/app.rs                      Tauri command/event registration
  src/domain/downloads/           URL download task lifecycle
  src/domain/collection_import.rs Collection import and manifest ownership
  src/domain/playlists/           Library and playlist persistence
  src/domain/playlist_playback/   Playable index and recommendation planning
  src/domain/player/              Playback lifecycle, waveform, and seek
  src/domain/meta/                Save root configuration
  src/utils/                      Window, binary, file, and platform utilities

docs/
  blog/                           Design notes and model explanations

scratch/experiments/
  hteb_audio_robustness.py        Local recommendation experiments
```

## Toolchain

- Bun is the JavaScript package manager and script runner.
- Rust is required for the Tauri backend. The crate declares Rust `1.94.0`.
- Tauri CLI is installed as a dev dependency.
- FFmpeg and yt-dlp are runtime-managed by the app; they do not need to be
  installed globally for normal app use.

Install dependencies:

```bash
bun install
```

Run the desktop app in development:

```bash
bunx tauri dev
```

Run the frontend only:

```bash
bun run dev
```

Build the bundled Bun sidecar:

```bash
bun run sidecar:build
```

## Verification

Frontend checks:

```bash
bun run fmt:check
bun run lint
bun run typecheck
```

Rust check:

```bash
bun run rust:check
```

Rust tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Focused playback queue tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml queue -- --nocapture
```

Full project check:

```bash
bun run check:all
```

`check:all` runs the frontend build, so use the narrower checks when a change
does not need packaging or bundle validation.

## Design Notes

The behavior design documents are part of the project contract:

- `src-tauri/src/domain/downloads/download-behavior.design.md`
- `src-tauri/src/domain/playlist_playback/playback-selection.design.md`
- `src/components/spectrum/SpectrumVisualizer.design.md`
- `docs/blog/playlist-local-attractors.md`

They describe the owner boundaries, invariants, fallback rules, cache rules,
async cancellation rules, and known exceptions for the main behavior systems.

## Experiments

Recommendation experiments live under `scratch/experiments`. They are diagnostic
tools for comparing sampling behavior and robustness. They are not part of the
desktop runtime path.
