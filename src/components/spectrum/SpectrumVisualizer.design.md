# Spectrum Visualizer Behavior Design

## Behavior

`TrackSpectrum` renders the current track waveform, supports viewport zoom/pan, loads waveform tiles, edits the selected playback range, and optionally seeks the current playback position.

## Participants

- `TrackIdentityProjector`: owns `Raw filePath -> WaveformTrackIdentity`.
- `ViewportModel`: owns normalized scroll, zoom, duration, and viewport geometry.
- `WaveformTransactionResolver`: composes viewport and summary into presentation and data demand.
- `WaveformDataLoader`: interprets data demand by loading tiles and writing cache entries.
- `CanvasRenderer`: interprets the current presentation plan against cache contents.
- `SelectionPresenter`: maps stable selection seconds to viewport geometry and emits committed selection changes.
- `PlaybackPresenter`: maps playback status to playhead CSS and interprets seek effects.

## Core Invariants

- Track identity is constructed only by path projection; raw paths do not key cache or session identity.
- `contentWidth >= viewportWidth` and `scrollLeft` is always inside the normalized viewport range.
- Data plan identity contains normalized file identity, summary cache key, render density, and tile range.
- Cache hit/miss changes only availability and latency, not semantic validity.
- Async tile and playback results must still match the current file/scope before they affect presentation.
- Selection and playhead operate in real audio seconds; visual padding never becomes editable audio.
- Canvas drawing is an effect interpreter; it never constructs stable semantic state.
- Canvas theme follows the same color-scheme evidence as CSS. DOM nodes that can
  react through CSS stay in CSS; drawn pixels redraw from explicit theme input
  because canvas does not update after CSS changes.
- Page exit owns only the outer opacity transition; it must not become an input to viewport, tile loading, canvas rendering, selection, or playhead presentation.

## Owned Invariants

`TrackIdentityProjector` owns:

- path trimming, slash normalization, case folding, and missing-path rejection.

`ViewportModel` owns:

- zoom bounds, visual padding, content width, scroll bounds, and pointer-anchor zoom stability.
- initial playable selection viewport: when a complete selection exists, the first resolved viewport keeps the selection visible and maps the left edge to `selection.start - 2s`, clamped only by the visual padding edge.

`WaveformTransactionResolver` owns:

- visible-vs-complete demand classification and interactive throttling semantics.

`WaveformDataLoader` owns:

- request concurrency, promise dedupe, cache writes, stale-scope rejection, and cache pruning.

`CanvasRenderer` owns:

- device-pixel-ratio canvas sizing, explicit theme color input, and visible waveform drawing from current cache evidence.

`SelectionPresenter` owns:

- drag preview, edge clamping, and committed selection emission.
- selection edits preserve the current viewport coordinates; dragging `start`
  keeps `end` fixed, dragging `end` keeps `start` fixed, and neither edge
  re-runs initial viewport placement.
- active selection drags store pointer input and re-project through the current
  viewport, so horizontal pan composes with the drag instead of freezing an old
  range projection.

`PlaybackPresenter` owns:

- polling, playback status projection, seek begin/cancel/commit, and playhead CSS.

## Does Not Own

- `DataLoader` does not decide viewport geometry.
- `CanvasRenderer` does not define tile validity.
- `SelectionPresenter` does not update playback state.
- `SelectionPresenter` does not update viewport zoom, scroll, or coordinate
  anchors.
- `Trace` and diagnostics do not participate in behavior decisions.
- Cache does not project raw paths or manufacture stable state.

## Stable Domains

`RawPath -> WaveformTrackIdentity`:

- owner: `TrackIdentityProjector`
- total: no
- failure: `missing-file-path`
- idempotence: projecting an embedded identity preserves the same `fileKey`.

`RawViewportInput -> WaveformViewportModel`:

- owner: `ViewportModel`
- total: yes after numeric clamping
- invariant: bounded zoom, bounded scroll, stable visual/audio coordinate conversion.

`RawSelection -> WaveformSelectionRange`:

- owner: `SelectionPresenter`
- total: partial at drag/commit boundary
- failure: incomplete selection means geometry/playhead commit is rejected.

`RawStatus -> PlaybackSnapshot`:

- owner: `PlaybackPresenter`
- total: no
- failure: status without matching track identity is ignored.

## Transition Shape

Viewport commands:

- `initial-selection`: writes zoom and scroll from ready summary, committed selection, and measured viewport width.
- `selection-edit`: writes selection only; it does not write viewport slots.
- `resize`: writes viewport width only, then re-normalizes the viewport.
- `pan`: writes scroll from bounded delta, clears focus owner.
- `zoom`: writes pixels-per-second and scroll from pointer anchor, marks zoom as explicit.
- `scroll-to-selection`: writes scroll only from committed selection start.

Data transaction:

- source: normalized viewport + ready summary.
- guard: projected track identity and ready waveform summary.
- writes: none in pure layer.
- emits: presentation plan and data demand description.
- rejection: missing identity or not-ready summary yields no plan.

## Effects

- `WaveformSummaryEffect`: calls `prepareTrackWaveform`.
- `WaveformTileEffect`: calls `getTrackWaveformTile`.
- `PlaybackEffect`: polls status and calls seek commands.
- `CanvasEffect`: writes pixels to canvas.
- `DomStyleEffect`: writes selection/playhead CSS.
- `PageExitPresentationEffect`: fades the page-owned wrapper opacity only.

Effects are interpreted by their owners and cannot reverse-write semantic state.

`PageExitPresentationEffect` does not own waveform children. After Back freezes
the page render data, playback status refreshes, row measurement, title handoff,
and late tile arrivals cannot force the waveform subtree to re-derive layout,
data demand, canvas pixels, selection geometry, or playhead CSS.

## Async

- Summary result belongs to `fileKey`.
- Tile result belongs to `scopeKey + requestKey`.
- Playback status belongs to normalized track identity.
- Hardware wheel result belongs to the current host hit-test at delivery time.
- Late or mismatched results are ignored.

## Fallback

- Missing waveform data renders empty columns while tile loading continues.
- Visual padding renders zero waveform.
- Missing playback origin hides the playhead.
- Fallback never constructs a stable identity, selection, viewport, or playback status.

## Cache

- Summary cache stores ready summary by `fileKey`.
- Tile cache stores tile evidence by `requestKey`.
- Promise cache dedupes in-flight tile requests.
- Cache absence never means the audio range is invalid.

## Checker Coverage

Covered by sidecar tests:

- path projection and store cache identity;
- viewport normalization;
- wheel ownership;
- data request identity and demand scope;
- stale tile-arrival rejection;
- selection geometry and drag clamping;
- playback position and playhead hiding;
- quantized tile peak projection.

## Exceptions

- Canvas progressive proof from the old implementation was removed. The new renderer chooses a simpler single owner and relies on data/cache identities rather than exposing internal proof hooks. This trades some optimized reuse for a shorter, explicit behavior path.
