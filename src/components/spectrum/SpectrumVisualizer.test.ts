import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TrackWaveformSummary } from "@/src/cmd";
import {
  areWaveformSelectionsEqual,
  createWaveformDataRequestKey,
  createWaveformDataScopeKey,
  createWaveformRenderDataStore,
  createWaveformSharedTileCacheForFile,
  normalizeWaveformPathKey,
  projectWaveformTrackIdentity,
  resolveTrackSpectrumWaveformResourcePreloadPlans,
  resolvePlaybackPositionMs,
  resolvePlaybackSnapshotAfterStatusCommit,
  resolvePlaybackSnapshotPausedAtNow,
  resolvePlaybackSnapshotDurationMs,
  resolveQuantizedWaveformDisplayPeak,
  resolveTrackWaveformInitialStatus,
  resolveWaveformContentWidth,
  resolveWaveformCanvasColor,
  resolveWaveformLoadingColorChannels,
  resolveWaveformLoadingGridSize,
  resolveWaveformDataPlan,
  resolveWaveformDataPlanScopedRequests,
  resolveWaveformDataTileIndexes,
  resolveWaveformDataWindow,
  resolveWaveformHardwareHorizontalWheelDelta,
  resolveWaveformInitialViewportFrame,
  resolveWaveformInitialViewport,
  resolveWaveformMaximumPixelsPerSecond,
  resolveWaveformMaximumRenderPixelsPerSecond,
  resolveWaveformMinimumPixelsPerSecond,
  resolveWaveformPixelsPerSecond,
  resolveWaveformPlayheadCssVariables,
  resolveWaveformPlayheadDrag,
  resolveWaveformPlayheadDragPreview,
  resolveWaveformPlayheadStyle,
  resolveWaveformPointerAnchorViewportX,
  resolveWaveformPresentationSelection,
  resolveWaveformRenderPixelsPerSecond,
  resolveWaveformResizeViewportState,
  resolveWaveformSelectionDrag,
  resolveWaveformSelectionDragPreview,
  resolveWaveformSelectionGeometry,
  resolveWaveformSelectionMarkerLayout,
  resolveWaveformSessionFrame,
  resolveWaveformSessionViewportFrame,
  resolveWaveformSelectionStartScrollLeft,
  resolveWaveformTileAvailabilityPresentationPlan,
  resolveWaveformTileLoadResultPolicy,
  resolveWaveformTilePeakAtSeconds,
  resolveWaveformTilePeakRangeAtPixels,
  resolveWaveformTileRequestStartPolicy,
  resolveWaveformTransaction,
  resolveWaveformViewportAudioSeconds,
  resolveWaveformViewportModel,
  resolveWaveformWheelAxisDeltas,
  resolveWaveformWheelDeltas,
  resolveWaveformWheelIntent,
  resolveWaveformWheelOperation,
  resolveWaveformWheelPixelDeltas,
  shouldAcceptWaveformHardwareHorizontalWheel,
  shouldPreventWaveformWheelDefault,
} from "./SpectrumVisualizer";

function createSummary(overrides: Partial<TrackWaveformSummary> = {}): TrackWaveformSummary {
  return {
    base_points_per_second: 3200,
    cache_key: "track",
    chunk_duration_ms: 2_000,
    duration_ms: 120_000,
    levels: [50, 100, 200, 400, 800, 1600, 3200],
    sample_rate: 48_000,
    samples_per_point: 15,
    start_ms: 0,
    ...overrides,
  };
}

describe("SpectrumVisualizer stable domains", () => {
  test("keeps canvas theme as an explicit render color input", () => {
    assert.equal(resolveWaveformCanvasColor({ prefersDarkColorScheme: false }), "#262626");
    assert.equal(resolveWaveformCanvasColor({ prefersDarkColorScheme: true }), "#f5f5f5");
  });

  test("keeps the loading dot field density derived from the canvas field", () => {
    assert.deepEqual(resolveWaveformLoadingGridSize({ height: 208, width: 96 }), {
      columns: 8,
      rows: 9,
    });
    assert.deepEqual(resolveWaveformLoadingGridSize({ height: 208, width: 240 }), {
      columns: 20,
      rows: 9,
    });
  });

  test("projects loading shader color from the canvas color input", () => {
    assert.deepEqual(resolveWaveformLoadingColorChannels("#262626"), [
      0x26 / 255,
      0x26 / 255,
      0x26 / 255,
    ]);
    assert.deepEqual(resolveWaveformLoadingColorChannels("rgb(245, 245, 245)"), [
      245 / 255,
      245 / 255,
      245 / 255,
    ]);
    assert.deepEqual(resolveWaveformLoadingColorChannels("rgb(50%, 25%, 0%)"), [0.5, 0.25, 0]);
  });

  test("projects track identity through normalized paths", () => {
    const first = projectWaveformTrackIdentity(" C:\\Music\\Track.M4A ");
    const second = projectWaveformTrackIdentity("c:/music/track.m4a");

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.ok && first.value.fileKey, second.ok && second.value.fileKey);
    assert.equal(normalizeWaveformPathKey("C:\\Music\\Track.M4A"), "c:/music/track.m4a");
    assert.deepEqual(projectWaveformTrackIdentity("  "), {
      error: "missing-file-path",
      ok: false,
    });
  });

  test("keeps shared cache identity inside the render data store", () => {
    const store = createWaveformRenderDataStore();
    const first = createWaveformSharedTileCacheForFile({
      filePath: "C:/Music/Demo.flac",
      store,
    });
    const second = createWaveformSharedTileCacheForFile({
      filePath: "c:\\music\\demo.flac",
      store,
    });
    const isolated = createWaveformSharedTileCacheForFile({
      filePath: "C:/Music/Demo.flac",
      store: createWaveformRenderDataStore(),
    });

    assert.equal(first, second);
    assert.notEqual(first, isolated);
  });

  test("starts loading only for a projected track identity", () => {
    assert.equal(resolveTrackWaveformInitialStatus("C:/music/demo.flac"), "loading");
    assert.equal(resolveTrackWaveformInitialStatus("   "), "idle");
    assert.equal(resolveTrackWaveformInitialStatus(null), "idle");
  });

  test("preloads visible waveform demand for every declared slice", () => {
    const plans = resolveTrackSpectrumWaveformResourcePreloadPlans({
      filePath: "C:/Music/Demo.flac",
      selections: [
        {
          end: 8,
          start: 4,
        },
        {
          end: 42,
          start: 36,
        },
      ],
      summary: createSummary(),
      viewportWidth: 1_000,
    });

    assert.equal(plans.length, 2);
    assert.equal(
      plans.every((plan) => plan.requests.length > 0),
      true,
    );
    assert.notEqual(
      plans[0]?.visibleSecondsWindow.startSeconds,
      plans[1]?.visibleSecondsWindow.startSeconds,
    );
    assert.equal(
      plans.every((plan) => plan.dataPixelsPerSecond > 50),
      true,
    );
  });
});

describe("SpectrumVisualizer viewport model", () => {
  test("keeps waveform content at least as wide as the viewport", () => {
    assert.equal(
      resolveWaveformContentWidth({
        durationMs: 1_000,
        pixelsPerSecond: 12,
        viewportWidth: 800,
      }),
      800,
    );
    assert.equal(
      resolveWaveformContentWidth({
        durationMs: 10_000,
        pixelsPerSecond: 120,
        viewportWidth: 800,
      }),
      1_680,
    );
  });

  test("clamps viewport zoom and scroll as a stable domain", () => {
    const viewport = resolveWaveformViewportModel({
      durationMs: 120_000,
      focusSeconds: 30,
      maximumPixelsPerSecond: 400,
      pixelsPerSecond: 10_000,
      scrollLeft: 99_999,
      viewportWidth: 1_000,
    });

    assert.equal(
      resolveWaveformMinimumPixelsPerSecond({ durationMs: 10_000, viewportWidth: 1_000 }),
      1_000 / 14,
    );
    assert.equal(resolveWaveformMaximumPixelsPerSecond({ maximumPixelsPerSecond: 640 }), 640);
    assert.equal(resolveWaveformMaximumRenderPixelsPerSecond(createSummary()), 3200);
    assert.equal(
      resolveWaveformPixelsPerSecond(10_000, {
        durationMs: 120_000,
        maximumPixelsPerSecond: 400,
        viewportWidth: 1_000,
      }),
      400,
    );
    assert.equal(viewport.pixelsPerSecond, 400);
    assert.equal(viewport.scrollLeft, viewport.contentWidth - viewport.viewportWidth);
  });

  test("resolves resize without changing explicit viewport ownership", () => {
    assert.deepEqual(
      resolveWaveformResizeViewportState({
        current: {
          contentWidth: 12_000,
          durationMs: 120_000,
          focusSeconds: 8,
          maximumPixelsPerSecond: 800,
          pixelsPerSecond: 125,
          scrollLeft: 400,
          viewportWidth: 1_000,
        },
        viewportWidth: 600,
      }),
      {
        focusSeconds: 8,
        pixelsPerSecond: 125,
        scrollLeft: 400,
        viewportWidth: 600,
      },
    );
  });

  test("maps pointer anchors and selection-start scroll through visual padding", () => {
    assert.equal(
      resolveWaveformPointerAnchorViewportX({
        clientX: 1_500,
        viewportLeft: 250,
        viewportWidth: 1_000,
      }),
      1_000,
    );
    assert.equal(
      resolveWaveformSelectionStartScrollLeft({
        contentWidth: 12_000,
        leadingSpacePx: 96,
        pixelsPerSecond: 100,
        selection: {
          end: 80,
          start: 20,
        },
        viewportWidth: 1_000,
      }),
      2_104,
    );
  });

  test("places the initial playable selection in view with start minus two seconds at the left edge", () => {
    const viewport = resolveWaveformInitialViewport({
      durationMs: 120_000,
      maximumPixelsPerSecond: 800,
      selection: {
        end: 40,
        start: 20,
      },
      viewportWidth: 1_000,
    });

    assert.equal(
      resolveWaveformViewportAudioSeconds({
        pixelsPerSecond: viewport.pixelsPerSecond,
        scrollLeft: viewport.scrollLeft,
        viewportX: 0,
      }),
      18,
    );
    assert.equal(
      resolveWaveformSelectionGeometry({
        selection: {
          end: 40,
          start: 20,
        },
        viewport,
      }).endX <= viewport.viewportWidth,
      true,
    );
  });

  test("marks selection-owned initial viewport so selection edits do not recenter coordinates", () => {
    const frame = resolveWaveformInitialViewportFrame({
      durationMs: 120_000,
      maximumPixelsPerSecond: 800,
      selection: {
        end: 40,
        start: 20,
      },
      viewportWidth: 1_000,
    });

    assert.equal(frame.zoomOwnership, "initial-selection");

    const changedStart = {
      ...frame.viewport,
      scrollLeft: frame.viewport.scrollLeft,
    };
    assert.equal(changedStart.scrollLeft, frame.viewport.scrollLeft);
  });

  test("resolves session initial ready viewport once and keeps resize in the same owner", () => {
    const summary = createSummary();
    const initialFrame = resolveWaveformInitialViewportFrame({
      durationMs: summary.duration_ms,
      maximumPixelsPerSecond: 800,
      selection: {
        end: 40,
        start: 20,
      },
      viewportWidth: 1,
    });
    const firstReady = resolveWaveformSessionViewportFrame({
      elementWidth: 1_000,
      initialSelection: {
        end: 40,
        start: 20,
      },
      maximumPixelsPerSecond: 800,
      state: {
        initialReadyViewportResolved: false,
        userOwned: false,
        viewport: initialFrame.viewport,
        zoomOwnership: "initial-minimum",
      },
      summary,
      waveformStatus: "ready",
    });
    const resized = resolveWaveformSessionViewportFrame({
      elementWidth: 900,
      initialSelection: {
        end: 80,
        start: 60,
      },
      maximumPixelsPerSecond: 800,
      state: firstReady,
      summary,
      waveformStatus: "ready",
    });

    assert.equal(firstReady.initialReadyViewportResolved, true);
    assert.equal(firstReady.zoomOwnership, "initial-selection");
    assert.equal(
      resolveWaveformViewportAudioSeconds({
        pixelsPerSecond: firstReady.viewport.pixelsPerSecond,
        scrollLeft: firstReady.viewport.scrollLeft,
        viewportX: 0,
      }),
      18,
    );
    assert.equal(resized.zoomOwnership, "initial-selection");
    assert.notEqual(resized.viewport.viewportWidth, firstReady.viewport.viewportWidth);
    assert.notEqual(
      resolveWaveformViewportAudioSeconds({
        pixelsPerSecond: resized.viewport.pixelsPerSecond,
        scrollLeft: resized.viewport.scrollLeft,
        viewportX: 0,
      }),
      58,
    );
  });

  test("keeps initial selection start minus two seconds inside the visual padding", () => {
    const viewport = resolveWaveformInitialViewport({
      durationMs: 120_000,
      maximumPixelsPerSecond: 800,
      selection: {
        end: 8,
        start: 1,
      },
      viewportWidth: 1_000,
    });

    assert.equal(
      resolveWaveformViewportAudioSeconds({
        pixelsPerSecond: viewport.pixelsPerSecond,
        scrollLeft: viewport.scrollLeft,
        viewportX: 0,
      }),
      -1,
    );
    assert.equal(
      resolveWaveformSelectionGeometry({
        selection: {
          end: 8,
          start: 1,
        },
        viewport,
      }).endX <= viewport.viewportWidth,
      true,
    );
  });

  test("uses the track start for initial viewport without a complete selection", () => {
    assert.equal(
      resolveWaveformInitialViewport({
        durationMs: 120_000,
        maximumPixelsPerSecond: 800,
        selection: null,
        viewportWidth: 1_000,
      }).scrollLeft,
      0,
    );
  });
});

describe("SpectrumVisualizer input interpretation", () => {
  test("keeps frontend wheel ownership limited to zoom and shift-pan", () => {
    assert.deepEqual(
      resolveWaveformWheelAxisDeltas({
        deltaMode: 0,
        deltaX: 100,
        deltaY: 0,
      }),
      {
        deltaMode: 0,
        deltaX: 0,
        deltaY: 0,
      },
    );
    assert.deepEqual(
      resolveWaveformWheelAxisDeltas({
        deltaMode: 0,
        deltaX: 0,
        deltaY: 50,
        shiftKey: true,
      }),
      {
        deltaMode: 0,
        deltaX: 50,
        deltaY: 0,
      },
    );
  });

  test("normalizes wheel packets before deciding intent", () => {
    assert.deepEqual(resolveWaveformWheelDeltas({ deltaX: Number.NaN, deltaY: 2 }), {
      deltaMode: 0,
      deltaX: 0,
      deltaY: 2,
    });
    assert.deepEqual(
      resolveWaveformWheelPixelDeltas({
        deltaMode: 1,
        deltaX: 2,
        deltaY: -3,
        viewportHeight: 200,
        viewportWidth: 400,
      }),
      {
        deltaX: 32,
        deltaY: -48,
      },
    );
    assert.deepEqual(
      resolveWaveformWheelIntent({
        deltaX: 0,
        deltaY: -48,
      }),
      {
        deltaY: -48,
        kind: "zoom",
      },
    );
    assert.equal(
      shouldPreventWaveformWheelDefault(
        resolveWaveformWheelOperation({
          deltaMode: 0,
          deltaX: 0,
          deltaY: -10,
          viewportHeight: 200,
          viewportWidth: 400,
        }),
      ),
      true,
    );
  });

  test("accepts backend hardware pan only inside the waveform host", () => {
    const host = {
      getBoundingClientRect: () => ({
        bottom: 200,
        height: 180,
        left: 10,
        right: 310,
        top: 20,
        toJSON: () => ({}),
        width: 300,
        x: 10,
        y: 20,
      }),
    };

    assert.equal(
      shouldAcceptWaveformHardwareHorizontalWheel({
        clientX: 100,
        clientY: 100,
        host,
      }),
      true,
    );
    assert.equal(
      shouldAcceptWaveformHardwareHorizontalWheel({
        clientX: 400,
        clientY: 100,
        host,
      }),
      false,
    );
    assert.equal(resolveWaveformHardwareHorizontalWheelDelta({ deltaX: Number.NaN }), 0);
  });
});

describe("SpectrumVisualizer data plans", () => {
  test("derives session frame demand only from ready projected tracks", () => {
    const summary = createSummary();
    const viewport = resolveWaveformViewportModel({
      durationMs: summary.duration_ms,
      focusSeconds: null,
      maximumPixelsPerSecond: resolveWaveformMaximumRenderPixelsPerSecond(summary),
      pixelsPerSecond: 120,
      scrollLeft: 0,
      viewportWidth: 800,
    });

    const loadingFrame = resolveWaveformSessionFrame({
      filePath: "C:/music/demo.flac",
      playheadEnabled: true,
      summary,
      viewport,
      waveformStatus: "loading",
    });
    const readyFrame = resolveWaveformSessionFrame({
      filePath: "C:/music/demo.flac",
      playheadEnabled: true,
      summary,
      viewport,
      waveformStatus: "ready",
    });

    assert.equal(loadingFrame.dataPlan, null);
    assert.equal(loadingFrame.selectionVisible, false);
    assert.equal(loadingFrame.playheadVisible, false);
    assert.equal(readyFrame.dataPlan?.scopeKey.includes("c:/music/demo.flac"), true);
    assert.equal(readyFrame.selectionVisible, true);
    assert.equal(readyFrame.playheadVisible, true);
  });

  test("keeps session tile presentation scoped to the current data plan", () => {
    const summary = createSummary();
    const viewport = resolveWaveformViewportModel({
      durationMs: summary.duration_ms,
      focusSeconds: null,
      maximumPixelsPerSecond: resolveWaveformMaximumRenderPixelsPerSecond(summary),
      pixelsPerSecond: 120,
      scrollLeft: 0,
      viewportWidth: 800,
    });
    const current = resolveWaveformSessionFrame({
      filePath: "C:/music/current.flac",
      playheadEnabled: false,
      summary,
      viewport,
      waveformStatus: "ready",
    });
    const stale = resolveWaveformSessionFrame({
      filePath: "C:/music/current.flac",
      playheadEnabled: false,
      summary,
      tileAvailabilitySignal: {
        scopeKey: "stale-scope",
      },
      viewport,
      waveformStatus: "ready",
    });

    assert.equal(current.dataPlan?.scopeKey.includes("c:/music/current.flac"), true);
    assert.equal(stale.dataPlan, null);
  });

  test("creates scope and request keys from stable identity and density", () => {
    const scopeKey = createWaveformDataScopeKey({
      filePath: "C:/music/demo.flac",
      summary: createSummary(),
    });
    const low = createWaveformDataRequestKey({
      pixelsPerSecond: 100,
      scopeKey,
      startPx: 0,
      widthPx: 2_048,
    });
    const high = createWaveformDataRequestKey({
      pixelsPerSecond: 101,
      scopeKey,
      startPx: 0,
      widthPx: 2_048,
    });

    assert.equal(scopeKey, "c:/music/demo.flac|track");
    assert.notEqual(low, high);
  });

  test("requests only real audio when viewport intersects visual padding", () => {
    const plan = resolveWaveformDataPlan({
      contentWidth: 12_400,
      filePath: "C:/music/demo.flac",
      focusSeconds: 0,
      mode: "interactive",
      pixelsPerSecond: 100,
      scrollLeft: 150,
      summary: createSummary(),
      tileWidth: 1_000,
      viewportWidth: 100,
    });

    assert.deepEqual(plan.visibleSecondsWindow, {
      endSeconds: 0.5,
      hasAudio: true,
      startSeconds: 0,
    });
    assert.deepEqual(plan.visibleWindow, {
      endPx: 50,
      startPx: 0,
    });
    assert.equal(
      plan.requests.every((request) => request.startPx >= 0),
      true,
    );
  });

  test("keeps visible demand separate from complete demand", () => {
    const plan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/Music/track.wav",
      focusSeconds: 5,
      mode: "settled",
      pixelsPerSecond: 100,
      scrollLeft: 500,
      summary: createSummary(),
      viewportWidth: 1_000,
    });

    const visible = resolveWaveformDataPlanScopedRequests(plan, "visible");
    const complete = resolveWaveformDataPlanScopedRequests(plan, "complete");

    assert.ok(complete.length >= visible.length);
    assert.equal(
      visible.every((request) => request.priority !== "overscan"),
      true,
    );
  });

  test("keeps interactive presentation independent from throttled data demand", () => {
    const plan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/Music/track.wav",
      focusSeconds: 5,
      mode: "interactive",
      pixelsPerSecond: 100,
      scrollLeft: 500,
      summary: createSummary(),
      viewportWidth: 1_000,
    });
    const first = resolveWaveformTransaction({
      lastInteractiveDataDemand: null,
      mode: "interactive",
      now: 100,
      plan,
    });
    const second = resolveWaveformTransaction({
      lastInteractiveDataDemand: first.nextInteractiveDataDemand,
      mode: "interactive",
      now: 120,
      plan,
    });

    assert.equal(first.transaction.dataDemand.skipped, false);
    assert.equal(second.transaction.dataDemand.skipped, true);
    assert.equal(second.transaction.presentation.plan, plan);
  });

  test("ignores tile arrivals from stale scopes", () => {
    const currentPlan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/Music/track.wav",
      focusSeconds: 5,
      mode: "interactive",
      pixelsPerSecond: 100,
      scrollLeft: 500,
      summary: createSummary(),
      viewportWidth: 1_000,
    });

    assert.equal(
      resolveWaveformTileAvailabilityPresentationPlan({
        currentPlan,
        signal: {
          scopeKey: "other-track",
        },
      }),
      null,
    );
    assert.equal(
      resolveWaveformTileLoadResultPolicy({
        activeScopeKey: currentPlan.scopeKey,
        presentationRequestKeys: new Set([currentPlan.requests[0]?.cacheKey ?? ""]),
        requestCacheKey: currentPlan.requests[0]?.cacheKey ?? "",
        requestScopeKey: currentPlan.scopeKey,
      }).shouldRequestPresentation,
      true,
    );
  });

  test("absorbs cached tile requests without emitting another presentation demand", () => {
    assert.deepEqual(resolveWaveformTileRequestStartPolicy({ hasCachedTile: true }), {
      rejection: "already-cached",
      shouldLoad: false,
      shouldRequestPresentation: false,
    });
    assert.deepEqual(resolveWaveformTileRequestStartPolicy({ hasCachedTile: false }), {
      rejection: null,
      shouldLoad: true,
      shouldRequestPresentation: false,
    });
  });
});

describe("SpectrumVisualizer selection and playback", () => {
  test("maps selection boundaries onto the current viewport", () => {
    const viewport = resolveWaveformViewportModel({
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 100,
      scrollLeft: 1_904,
      viewportWidth: 1_000,
    });

    assert.deepEqual(
      resolveWaveformSelectionGeometry({
        selection: {
          end: 40,
          start: 20,
        },
        viewport,
      }),
      {
        endX: 2_296,
        isComplete: true,
        startX: 296,
      },
    );
  });

  test("keeps selection marker lines on the physical pixel grid while handles use semantic coordinates", () => {
    assert.deepEqual(resolveWaveformSelectionMarkerLayout({ devicePixelRatio: 1, x: 120.49 }), {
      handleCenterX: 120.49,
      visualLineLeftX: 120,
      visualLineWidth: 1,
    });

    const highDpiMarker = resolveWaveformSelectionMarkerLayout({
      devicePixelRatio: 1.5,
      x: 41.06,
    });

    assert.equal(highDpiMarker.handleCenterX, 41.06);
    assert.equal(highDpiMarker.visualLineLeftX * 1.5, 61);
    assert.equal(highDpiMarker.visualLineWidth * 1.5, 2);
  });

  test("uses the committed draft selection after reset when the interactive selection is stale", () => {
    const baselineSelection = {
      end: 120,
      start: 0,
    };
    const staleInteractiveSelection = {
      end: 112,
      start: 8,
    };
    const previewSelection = {
      end: 90,
      start: 12,
    };

    assert.deepEqual(
      resolveWaveformPresentationSelection({
        committedSelection: baselineSelection,
        interactiveSelection: staleInteractiveSelection,
        isDragging: false,
        previewSelection: null,
      }),
      baselineSelection,
    );
    assert.deepEqual(
      resolveWaveformPresentationSelection({
        committedSelection: baselineSelection,
        interactiveSelection: staleInteractiveSelection,
        isDragging: true,
        previewSelection: null,
      }),
      staleInteractiveSelection,
    );
    assert.deepEqual(
      resolveWaveformPresentationSelection({
        committedSelection: baselineSelection,
        interactiveSelection: staleInteractiveSelection,
        isDragging: false,
        previewSelection,
      }),
      previewSelection,
    );
  });

  test("keeps selection drags in the real audio range without crossing edges", () => {
    const viewport = resolveWaveformViewportModel({
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 100,
      scrollLeft: 1_904,
      viewportWidth: 1_000,
    });

    assert.deepEqual(
      resolveWaveformSelectionDrag({
        edge: "start",
        hostRect: { left: 10 },
        pointerClientX: 5_000,
        selection: {
          end: 40,
          start: 20,
        },
        viewport,
      }),
      {
        end: 40,
        start: 40,
      },
    );
    assert.equal(areWaveformSelectionsEqual({ end: 40, start: 20 }, { end: 40, start: 20 }), true);
  });

  test("keeps the opposite selection edge fixed while dragging either handle", () => {
    const viewport = resolveWaveformViewportModel({
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 100,
      scrollLeft: 1_904,
      viewportWidth: 1_000,
    });
    const selection = {
      end: 40,
      start: 20,
    };

    assert.equal(
      resolveWaveformSelectionDrag({
        edge: "start",
        hostRect: { left: 10 },
        pointerClientX: 2_500,
        selection,
        viewport,
      }).end,
      selection.end,
    );
    assert.equal(
      resolveWaveformSelectionDrag({
        edge: "end",
        hostRect: { left: 10 },
        pointerClientX: 2_500,
        selection,
        viewport,
      }).start,
      selection.start,
    );
  });

  test("reprojects selection drag previews through the current viewport", () => {
    const baseViewport = resolveWaveformViewportModel({
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 100,
      scrollLeft: 1_800,
      viewportWidth: 1_000,
    });
    const pannedViewport = resolveWaveformViewportModel({
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 100,
      scrollLeft: 2_600,
      viewportWidth: 1_000,
    });
    const hostRect = {
      left: 10,
    };

    const endInput = {
      edge: "end" as const,
      hostRect,
      pointerClientX: 610,
      selection: {
        end: 40,
        start: 10,
      },
    };
    const pannedEndPreview = resolveWaveformSelectionDragPreview({
      input: endInput,
      viewport: pannedViewport,
    });

    assert.deepEqual(
      resolveWaveformSelectionDragPreview({
        input: endInput,
        viewport: baseViewport,
      }),
      {
        end: 22,
        start: 10,
      },
    );
    assert.deepEqual(pannedEndPreview, {
      end: 30,
      start: 10,
    });
    assert.equal(
      resolveWaveformSelectionGeometry({
        selection: pannedEndPreview,
        viewport: pannedViewport,
      }).endX,
      600,
    );

    const startInput = {
      ...endInput,
      edge: "start" as const,
    };
    const pannedStartPreview = resolveWaveformSelectionDragPreview({
      input: startInput,
      viewport: pannedViewport,
    });

    assert.deepEqual(pannedStartPreview, {
      end: 40,
      start: 30,
    });
    assert.equal(
      resolveWaveformSelectionGeometry({
        selection: pannedStartPreview,
        viewport: pannedViewport,
      }).startX,
      600,
    );
  });

  test("clamps playhead drags to complete editable selections", () => {
    const viewport = resolveWaveformViewportModel({
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 100,
      scrollLeft: 1_904,
      viewportWidth: 1_000,
    });

    assert.deepEqual(
      resolveWaveformPlayheadDrag({
        hostRect: {
          left: 10,
          width: 4_000,
        },
        pointerClientX: 5_000,
        selection: {
          end: 40,
          start: 20,
        },
        viewport,
      }),
      {
        endMs: 40_000,
        positionMs: 40_000,
      },
    );
    assert.equal(
      resolveWaveformPlayheadDrag({
        hostRect: {
          left: 0,
          width: 1_000,
        },
        pointerClientX: 500,
        selection: {
          end: 40,
          start: null,
        },
        viewport,
      }),
      null,
    );
  });

  test("reprojects playhead drag previews through the current viewport", () => {
    const baseViewport = resolveWaveformViewportModel({
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 100,
      scrollLeft: 1_800,
      viewportWidth: 1_000,
    });
    const pannedViewport = resolveWaveformViewportModel({
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 100,
      scrollLeft: 2_600,
      viewportWidth: 1_000,
    });
    const input = {
      hostRect: {
        left: 10,
        width: 1_000,
      },
      pointerClientX: 610,
      selection: {
        end: 40,
        start: 10,
      },
    };

    const basePreview = resolveWaveformPlayheadDragPreview({
      input,
      viewport: baseViewport,
    });
    const pannedPreview = resolveWaveformPlayheadDragPreview({
      input,
      viewport: pannedViewport,
    });

    assert.deepEqual(basePreview, {
      endMs: 40_000,
      positionMs: 22_000,
    });
    assert.deepEqual(pannedPreview, {
      endMs: 40_000,
      positionMs: 30_000,
    });
    assert.deepEqual(
      resolveWaveformPlayheadCssVariables({
        playbackStartMs: 0,
        pixelsPerSecond: pannedViewport.pixelsPerSecond,
        positionMs: pannedPreview?.positionMs ?? null,
        scrollLeft: pannedViewport.scrollLeft,
        viewportWidth: pannedViewport.viewportWidth,
      }),
      {
        opacity: "0.86",
        x: "600px",
      },
    );
  });

  test("advances playback snapshots only while playing", () => {
    const snapshot = {
      duration_ms: 20_000,
      music_url: "https://example.com/demo",
      path: "C:/music/demo.flac",
      paused: false,
      playback_end_ms: 40_000,
      playback_start_ms: 20_000,
      playing: true,
      playlist_name: "Focus",
      position_ms: 1_000,
      received_at_ms: 100,
      track_end_ms: 40_000,
      track_start_ms: 20_000,
    };

    assert.equal(
      resolvePlaybackPositionMs({
        durationMs: 20_000,
        nowMs: 350,
        snapshot,
      }),
      1_250,
    );
    assert.equal(
      resolvePlaybackPositionMs({
        durationMs: 20_000,
        nowMs: 350,
        snapshot: {
          ...snapshot,
          paused: true,
        },
      }),
      1_000,
    );
    assert.equal(
      resolvePlaybackSnapshotDurationMs({
        fallbackDurationMs: 120_000,
        snapshot,
      }),
      20_000,
    );
  });

  test("freezes playback snapshots at the local pause timestamp", () => {
    const snapshot = {
      duration_ms: 20_000,
      music_url: "https://example.com/demo",
      path: "C:/music/demo.flac",
      paused: false,
      playback_end_ms: 40_000,
      playback_start_ms: 20_000,
      playing: true,
      playlist_name: "Focus",
      position_ms: 1_000,
      received_at_ms: 100,
      track_end_ms: 40_000,
      track_start_ms: 20_000,
    };

    const paused = resolvePlaybackSnapshotPausedAtNow({
      durationMs: 20_000,
      nowMs: 350,
      snapshot,
    });

    assert.deepEqual(paused, {
      ...snapshot,
      paused: true,
      position_ms: 1_250,
      received_at_ms: 350,
    });
    assert.equal(
      resolvePlaybackPositionMs({
        durationMs: 20_000,
        nowMs: 900,
        snapshot: paused,
      }),
      1_250,
    );
  });

  test("keeps the local pause point across backend pause confirmation", () => {
    const localPause = {
      duration_ms: 20_000,
      music_url: "https://example.com/demo",
      path: "C:/music/demo.flac",
      paused: true,
      playback_end_ms: 40_000,
      playback_start_ms: 20_000,
      playing: true,
      playlist_name: "Focus",
      position_ms: 1_250,
      received_at_ms: 350,
      track_end_ms: 40_000,
      track_start_ms: 20_000,
    };
    const backendPause = {
      ...localPause,
      position_ms: 1_000,
      received_at_ms: 600,
    };
    const backendResumeAck = {
      ...localPause,
      paused: false,
      position_ms: 1_250,
      received_at_ms: 800,
    };

    assert.equal(
      resolvePlaybackSnapshotAfterStatusCommit({
        localPlaybackSnapshot: localPause,
        nextSnapshot: backendPause,
      }),
      localPause,
    );
    assert.equal(
      resolvePlaybackSnapshotAfterStatusCommit({
        localPlaybackSnapshot: localPause,
        nextSnapshot: backendResumeAck,
      }),
      localPause,
    );
  });

  test("hides playhead without a playback origin", () => {
    assert.deepEqual(
      resolveWaveformPlayheadCssVariables({
        playbackStartMs: null,
        pixelsPerSecond: 100,
        positionMs: 5_000,
        scrollLeft: 0,
        viewportWidth: 800,
      }),
      {
        opacity: "0",
        x: "-9999px",
      },
    );
    assert.deepEqual(
      resolveWaveformPlayheadStyle({
        playbackStartMs: 0,
        pixelsPerSecond: 100,
        positionMs: 5_000,
        scrollLeft: 250,
        viewportWidth: 800,
      }),
      {
        opacity: "0.86",
        transform: "translate3d(450px, 0, 0)",
      },
    );
  });
});

describe("SpectrumVisualizer tile peak projection", () => {
  test("selects the smallest render level that represents current zoom", () => {
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({ pixelsPerSecond: 12, summary: createSummary() }),
      50,
    );
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({ pixelsPerSecond: 250, summary: createSummary() }),
      400,
    );
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({ pixelsPerSecond: 900, summary: createSummary() }),
      1600,
    );
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({ pixelsPerSecond: 4_000, summary: createSummary() }),
      3200,
    );
  });

  test("reads quantized tile values without widening columns", () => {
    assert.deepEqual(
      resolveQuantizedWaveformDisplayPeak({
        max: [0, 64, 127],
        min: [0, -64, -127],
        offset: 1,
      }),
      {
        max: 64 / 127,
        min: -64 / 127,
      },
    );
    assert.deepEqual(
      resolveWaveformTilePeakAtSeconds({
        pixelsPerSecond: 100,
        seconds: 1.02,
        tile: {
          max: [0, 64, 127],
          min: [0, -64, -127],
          start_px: 100,
        },
      }),
      {
        max: 127 / 127,
        min: -127 / 127,
      },
    );
  });

  test("aggregates quantized tile ranges without dropping boundaries", () => {
    assert.deepEqual(
      resolveWaveformTilePeakRangeAtPixels({
        endPx: 2_049,
        startPx: 2_047,
        tile: {
          max: [0, 127],
          min: [0, -127],
          start_px: 2_047,
        },
      }),
      {
        max: 1,
        min: -1,
      },
    );
  });

  test("builds data windows and tile indexes from explicit data coordinates", () => {
    assert.deepEqual(
      resolveWaveformDataWindow({
        dataContentWidth: 1_000,
        dataPixelsPerSecond: 100,
        window: {
          endSeconds: 2.1,
          hasAudio: true,
          startSeconds: 0.2,
        },
      }),
      {
        endPx: 210,
        startPx: 20,
      },
    );
    assert.deepEqual(
      resolveWaveformDataTileIndexes({
        tileWidth: 100,
        window: {
          endPx: 210,
          startPx: 20,
        },
      }),
      [0, 1, 2],
    );
  });
});
