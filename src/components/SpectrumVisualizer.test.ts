import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TrackWaveformSummary } from "@/src/cmd";
import {
  clampWaveformZoomDeltaY,
  isWaveformTileWindowCoveringWindow,
  normalizeWaveformPathKey,
  resolveWaveformHorizontalPanFrame,
  resolveWaveformHorizontalScrollLeft,
  resolveWaveformWheelPanContentWidth,
  hasWaveformViewportPositionChanged,
  resolveWaveformScrollReadValue,
  resolveWaveformScrollWritePlan,
  resolveWaveformViewportScrollEventFrame,
  resolveTrackWaveformInitialStatus,
  resolveAnchoredWaveformScrollLeft,
  resolveCenteredWaveformScrollLeft,
  resolveWaveformMinimumPixelsPerSecond,
  resolveWaveformMaximumPixelsPerSecond,
  resolvePlaybackPositionMs,
  resolveQuantizedWaveformDisplayPeak,
  resolveWaveformContentWidth,
  resolveWaveformPeakRange,
  resolveWaveformPixelsPerSecond,
  resolveWaveformPlayheadStyle,
  resolveWaveformPlayheadX,
  resolveWaveformPointerAnchorViewportX,
  WaveformZoomController,
  resolveWaveformRasterAlignment,
  resolveWaveformCanvasBackingMetrics,
  resolveWaveformBarWidthPx,
  resolveWaveformRenderContentWidth,
  resolveWaveformRenderPixelsPerSecond,
  resolveWaveformNextRenderPixelsPerSecond,
  resolveWaveformNextDensityPrefetchEntries,
  resolveWaveformRenderScale,
  resolveWaveformRenderTileWindow,
  resolveWaveformRenderViewport,
  resolveWaveformSourceTileWidth,
  resolveWaveformDeferredRenderIndexes,
  resolveWaveformTileLoadGroups,
  resolveWaveformTileLoadQueue,
  resolveWaveformTilePriorityIndex,
  resolveWaveformTileRenderBatch,
  resolveWaveformTileRenderMode,
  resolveWaveformTileRenderScope,
  resolveWaveformTileVisibilityPlan,
  resolveWaveformTileDisplayRange,
  resolveWaveformTileDisplayWidth,
  resolveWaveformTileDrawIntent,
  resolveWaveformTileDrawOpacity,
  resolveWaveformTileLoadOrder,
  resolveWaveformTileRenderPlan,
  resolveWaveformTileSourceFetchRange,
  resolveWaveformTileSourcePadding,
  resolveWaveformTileSourcePixelRange,
  resolveWaveformTileWindow,
  resolveWaveformPresentationTransform,
  shouldPreventWaveformWheelDefault,
  resolveWaveformWheelDeltas,
  resolveWaveformWheelDeltaX,
  resolveWaveformWheelIntent,
  resolveWaveformWheelOperation,
  resolveWaveformWheelPanDelta,
  resolveWaveformWheelPixelsPerSecond,
  resolveQueuedWaveformZoomFrame,
  resolveWaveformZoomScaleFrame,
  resolveWaveformZoomFrame,
  resolveWaveformZoomCommitMaterializeMode,
  resolveWaveformZoomSettleDelayMs,
} from "./SpectrumVisualizer";

function createWaveformTestSummary(overrides: Partial<TrackWaveformSummary> = {}) {
  return {
    base_points_per_second: 800,
    cache_key: "track",
    chunk_duration_ms: 2_000,
    duration_ms: 120_000,
    levels: [50, 100, 200, 400, 800],
    sample_rate: 48_000,
    samples_per_point: 60,
    start_ms: 0,
    ...overrides,
  };
}

function createWaveformTestWindow() {
  let nextFrameId = 1;
  let nextTimerId = 1;
  let nowMs = 0;
  const timers = new Map<number, () => void>();

  return {
    advanceTime(ms: number) {
      nowMs += ms;
    },
    cancelAnimationFrame() {},
    clearTimeout(timerId: number) {
      timers.delete(timerId);
    },
    flushTimers() {
      const callbacks = [...timers.entries()];
      timers.clear();

      for (const [, callback] of callbacks) {
        callback();
      }
    },
    performance: {
      now: () => nowMs,
    },
    requestAnimationFrame(callback: FrameRequestCallback) {
      const frameId = nextFrameId;
      nextFrameId += 1;
      callback(nowMs);
      return frameId;
    },
    setTimeout(callback: () => void) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
  };
}

type WaveformZoomApplyArgs = Parameters<WaveformZoomController["apply"]>[0];

describe("SpectrumVisualizer", () => {
  test("starts waveform preparation as loading when a track is present", () => {
    assert.equal(resolveTrackWaveformInitialStatus("C:/music/demo.flac"), "loading");
    assert.equal(resolveTrackWaveformInitialStatus("   "), "idle");
    assert.equal(resolveTrackWaveformInitialStatus(null), "idle");
  });

  test("keeps first track tiles blank until waveform data is available", () => {
    assert.equal(resolveWaveformTileDrawIntent({ hasData: false, status: "idle" }), "placeholder");
    assert.equal(resolveWaveformTileDrawIntent({ hasData: false, status: "loading" }), "blank");
    assert.equal(resolveWaveformTileDrawIntent({ hasData: false, status: "ready" }), "blank");
    assert.equal(resolveWaveformTileDrawIntent({ hasData: false, status: "error" }), "blank");
    assert.equal(resolveWaveformTileDrawIntent({ hasData: true, status: "loading" }), "data");
  });

  test("keeps draw opacity dependent on the resolved draw intent", () => {
    assert.equal(
      resolveWaveformTileDrawOpacity({
        intent: "placeholder",
        opacity: 1,
        status: "ready",
      }),
      0.42,
    );
    assert.equal(
      resolveWaveformTileDrawOpacity({
        intent: "data",
        opacity: 1,
        status: "ready",
      }),
      1,
    );
    assert.equal(
      resolveWaveformTileDrawOpacity({
        intent: "blank",
        opacity: 0.42,
        status: "loading",
      }),
      0.42,
    );
  });

  test("keeps the waveform at least as wide as the viewport", () => {
    assert.equal(
      resolveWaveformContentWidth({
        durationMs: 2_000,
        pixelsPerSecond: 24,
        viewportWidth: 800,
      }),
      800,
    );
  });

  test("expands content width as zoom increases", () => {
    const durationMs = 30_000;
    const viewportWidth = 600;
    const lowZoomWidth = resolveWaveformContentWidth({
      durationMs,
      viewportWidth,
      pixelsPerSecond: resolveWaveformPixelsPerSecond(24),
    });
    const highZoomWidth = resolveWaveformContentWidth({
      durationMs,
      viewportWidth,
      pixelsPerSecond: resolveWaveformPixelsPerSecond(96),
    });

    assert.ok(highZoomWidth > lowZoomWidth);
  });

  test("wheel zoom changes pixels per second continuously within bounds", () => {
    const zoomedIn = resolveWaveformWheelPixelsPerSecond({
      currentPixelsPerSecond: 24,
      deltaY: -90,
    });
    const zoomedOut = resolveWaveformWheelPixelsPerSecond({
      currentPixelsPerSecond: 24,
      deltaY: 90,
    });

    assert.ok(zoomedIn > 24 && zoomedIn < 48);
    assert.ok(zoomedOut < 24 && zoomedOut > 12);
    assert.equal(
      resolveWaveformWheelPixelsPerSecond({
        currentPixelsPerSecond: 400,
        deltaY: -900,
      }),
      320,
    );
    assert.equal(
      resolveWaveformWheelPixelsPerSecond({
        currentPixelsPerSecond: 48,
        deltaY: -900,
        durationMs: 120_000,
        maximumPixelsPerSecond: 50,
        viewportWidth: 800,
      }),
      50,
    );
  });

  test("limits maximum zoom at zero bar spacing", () => {
    assert.equal(resolveWaveformMaximumPixelsPerSecond({ maximumPixelsPerSecond: 50 }), 50);
    assert.equal(
      resolveWaveformPixelsPerSecond(320, {
        durationMs: 120_000,
        maximumPixelsPerSecond: 50,
        viewportWidth: 800,
      }),
      50,
    );
    assert.deepEqual(
      resolveWaveformZoomScaleFrame({
        currentPixelsPerSecond: 50,
        deltaY: -100,
        durationMs: 120_000,
        maximumPixelsPerSecond: 50,
        viewportWidth: 800,
      }),
      {
        changed: false,
        pixelsPerSecond: 50,
      },
    );
    assert.equal(
      resolveWaveformRenderScale({
        pixelsPerSecond: 50,
        renderPixelsPerSecond: 50,
      }),
      1,
    );
  });

  test("limits one wheel zoom step so large device deltas do not jump to the boundary", () => {
    assert.equal(clampWaveformZoomDeltaY(14_200), 180);
    assert.equal(clampWaveformZoomDeltaY(-14_200), -180);
    assert.equal(
      resolveWaveformWheelPixelsPerSecond({
        currentPixelsPerSecond: 122.19,
        deltaY: 14_200,
      }),
      86.4,
    );
  });

  test("detects clamped zoom before measuring a viewport anchor", () => {
    assert.deepEqual(
      resolveWaveformZoomScaleFrame({
        currentPixelsPerSecond: 320,
        deltaY: -100,
        durationMs: 140_000,
        viewportWidth: 1_400,
      }),
      {
        changed: false,
        pixelsPerSecond: 320,
      },
    );
    assert.deepEqual(
      resolveWaveformZoomScaleFrame({
        currentPixelsPerSecond: 217.73,
        deltaY: -100,
        durationMs: 140_000,
        viewportWidth: 1_400,
      }),
      {
        changed: true,
        pixelsPerSecond: 263.96,
      },
    );
  });

  test("settles only the latest zoom commit", () => {
    const ownerWindow = createWaveformTestWindow();
    const materializedPixelsPerSecond: number[] = [];
    const syncedPixelsPerSecond: number[] = [];
    const controller = new WaveformZoomController();
    const scrollElement = {
      clientHeight: 208,
      clientWidth: 800,
      getBoundingClientRect: () => ({ left: 0 }),
      ownerDocument: {
        defaultView: ownerWindow,
      },
      scrollLeft: 0,
      scrollWidth: 96_000,
    };
    const scrollElements = {
      content: scrollElement,
      host: scrollElement,
      scrollOffsetElement: scrollElement,
      viewport: scrollElement,
    } as unknown as WaveformZoomApplyArgs["scrollElements"];
    const wheelState = {
      contentWidth: 3_000,
      controller: {
        applyZoomViewportState(args: { scrollLeft: number }) {
          scrollElement.scrollLeft = args.scrollLeft;
        },
        createTraceSnapshot: () => null,
        materializeZoomTiles(args: { pixelsPerSecond: number }) {
          materializedPixelsPerSecond.push(args.pixelsPerSecond);
        },
        prepareZoomScrollRange() {},
      },
      maximumPixelsPerSecond: 800,
      requestedPixelsPerSecond: 24,
      setPixelsPerSecond(update: (current: number) => number) {
        syncedPixelsPerSecond.push(update(syncedPixelsPerSecond.at(-1) ?? 24));
      },
      summary: createWaveformTestSummary(),
      viewportWidth: 800,
    } as unknown as WaveformZoomApplyArgs["wheelState"];

    controller.apply({
      anchorViewportX: 400,
      deltaY: -100,
      scrollElements,
      scrollLeft: 0,
      viewportWidth: 800,
      wheelState,
    });
    ownerWindow.advanceTime(100);
    controller.apply({
      anchorViewportX: 400,
      deltaY: -100,
      scrollElements,
      scrollLeft: 0,
      viewportWidth: 800,
      wheelState,
    });
    ownerWindow.advanceTime(420);
    ownerWindow.flushTimers();

    assert.equal(materializedPixelsPerSecond.length, 3);
    assert.ok(materializedPixelsPerSecond[1] > materializedPixelsPerSecond[0]);
    assert.equal(materializedPixelsPerSecond[2], materializedPixelsPerSecond[1]);
    assert.deepEqual(syncedPixelsPerSecond, [materializedPixelsPerSecond[1]]);
  });

  test("fits the whole track at the minimum zoom when the viewport is wider", () => {
    const pixelsPerSecond = resolveWaveformPixelsPerSecond(12, {
      durationMs: 85_000,
      viewportWidth: 1_400,
    });

    assert.equal(
      resolveWaveformMinimumPixelsPerSecond({
        durationMs: 85_000,
        viewportWidth: 1_400,
      }),
      1_400 / 85,
    );
    assert.equal(pixelsPerSecond, 16.47);
    assert.equal(
      resolveWaveformContentWidth({
        durationMs: 85_000,
        pixelsPerSecond,
        viewportWidth: 1_400,
      }),
      1_400,
    );
  });

  test("composes repeated wheel zoom deltas around the pointer anchor", () => {
    const first = resolveWaveformZoomFrame({
      anchorViewportX: 120,
      currentPixelsPerSecond: 24,
      deltaY: -90,
      durationMs: 120_000,
      scrollLeft: 360,
      viewportWidth: 800,
    });
    const second = resolveWaveformZoomFrame({
      anchorViewportX: 120,
      currentPixelsPerSecond: first.pixelsPerSecond,
      deltaY: -90,
      durationMs: 120_000,
      scrollLeft: first.scrollLeft,
      viewportWidth: 800,
    });

    assert.ok(second.pixelsPerSecond > first.pixelsPerSecond);
    assert.ok(
      Math.abs(
        (second.scrollLeft + second.anchorViewportX) / second.pixelsPerSecond - first.anchorSeconds,
      ) < 0.000001,
    );
  });

  test("queues repeated wheel zoom deltas from the pending frame", () => {
    const first = resolveQueuedWaveformZoomFrame({
      anchorViewportX: 120,
      currentPixelsPerSecond: 24,
      deltaY: -90,
      durationMs: 120_000,
      pendingFrame: null,
      scrollLeft: 360,
      viewportWidth: 800,
    });
    const second = resolveQueuedWaveformZoomFrame({
      anchorViewportX: 120,
      currentPixelsPerSecond: 24,
      deltaY: -90,
      durationMs: 120_000,
      pendingFrame: first,
      scrollLeft: 360,
      viewportWidth: 800,
    });

    assert.equal(second.pixelsPerSecond, 33.94);
    assert.ok(second.scrollLeft > first.scrollLeft);
    assert.ok(
      Math.abs(
        (second.scrollLeft + second.anchorViewportX) / second.pixelsPerSecond - first.anchorSeconds,
      ) < 0.000001,
    );
  });

  test("keeps queued zoom in the committed frame until state catches up", () => {
    const committed = resolveQueuedWaveformZoomFrame({
      anchorViewportX: 408,
      currentPixelsPerSecond: 148.13,
      deltaY: 100,
      durationMs: 140_000,
      pendingFrame: null,
      scrollLeft: 2_110.3353195359014,
      viewportWidth: 1_400,
    });
    const next = resolveQueuedWaveformZoomFrame({
      anchorViewportX: 408,
      currentPixelsPerSecond: 148.13,
      deltaY: -100,
      durationMs: 140_000,
      pendingFrame: {
        durationMs: 140_000,
        pixelsPerSecond: committed.pixelsPerSecond,
        scrollLeft: committed.scrollLeft,
        viewportWidth: 1_400,
      },
      scrollLeft: 2_110.3353195359014,
      viewportWidth: 1_400,
    });
    const fromStaleState = resolveQueuedWaveformZoomFrame({
      anchorViewportX: 408,
      currentPixelsPerSecond: 148.13,
      deltaY: -100,
      durationMs: 140_000,
      pendingFrame: null,
      scrollLeft: committed.scrollLeft,
      viewportWidth: 1_400,
    });

    assert.equal(committed.pixelsPerSecond, 122.19);
    assert.ok(Math.abs(next.pixelsPerSecond - 148.13) < 0.01);
    assert.ok(Math.abs(fromStaleState.pixelsPerSecond - 179.58) < 0.01);
  });

  test("materializes zoom commits beyond the exact viewport", () => {
    assert.equal(resolveWaveformZoomCommitMaterializeMode(), "active-scroll");
  });

  test("waits for a quiet zoom window before settling the presentation", () => {
    assert.equal(
      resolveWaveformZoomSettleDelayMs({
        lastCommitMs: 1_000,
        nowMs: 1_360,
      }),
      60,
    );
    assert.equal(
      resolveWaveformZoomSettleDelayMs({
        lastCommitMs: 1_000,
        nowMs: 1_110,
        settleDelayMs: 240,
      }),
      130,
    );
    assert.equal(
      resolveWaveformZoomSettleDelayMs({
        lastCommitMs: 1_000,
        nowMs: 1_240,
        settleDelayMs: 240,
      }),
      0,
    );
  });

  test("keeps zoom centered while clamping to scrollable bounds", () => {
    assert.equal(
      resolveCenteredWaveformScrollLeft({
        centerSeconds: 10,
        contentWidth: 1_000,
        pixelsPerSecond: 50,
        viewportWidth: 300,
      }),
      350,
    );

    assert.equal(
      resolveCenteredWaveformScrollLeft({
        centerSeconds: 100,
        contentWidth: 1_000,
        pixelsPerSecond: 50,
        viewportWidth: 300,
      }),
      700,
    );
  });

  test("keeps the pointer anchored while wheel zooming", () => {
    assert.equal(
      resolveAnchoredWaveformScrollLeft({
        anchorSeconds: 10,
        anchorViewportX: 120,
        contentWidth: 1_000,
        pixelsPerSecond: 50,
        viewportWidth: 300,
      }),
      380,
    );
  });

  test("measures the zoom anchor in viewport coordinates", () => {
    assert.equal(
      resolveWaveformPointerAnchorViewportX({
        clientX: 620,
        viewportLeft: 200,
        viewportWidth: 1_000,
      }),
      420,
    );
    assert.equal(
      resolveWaveformPointerAnchorViewportX({
        clientX: 1_800,
        viewportLeft: 200,
        viewportWidth: 1_000,
      }),
      1_000,
    );
  });

  test("treats any horizontal wheel delta as pan instead of zoom", () => {
    assert.equal(
      resolveWaveformWheelPanDelta({
        deltaX: 48,
        deltaY: 3,
        shiftKey: false,
      }),
      48,
    );
    assert.equal(
      resolveWaveformWheelPanDelta({
        deltaX: 3,
        deltaY: 48,
        shiftKey: false,
      }),
      3,
    );
    assert.equal(
      resolveWaveformWheelPanDelta({
        deltaX: 0,
        deltaY: 48,
        shiftKey: true,
      }),
      48,
    );
    assert.equal(
      resolveWaveformWheelPanDelta({
        deltaX: 0,
        deltaY: 48,
        shiftKey: false,
      }),
      0,
    );
  });

  test("classifies wheel intent without mixing pan and zoom effects", () => {
    assert.deepEqual(
      resolveWaveformWheelIntent({
        deltaX: 48,
        deltaY: 90,
        shiftKey: false,
      }),
      {
        deltaX: 48,
        kind: "horizontal-pan",
      },
    );
    assert.deepEqual(
      resolveWaveformWheelIntent({
        deltaX: 0,
        deltaY: 90,
        shiftKey: true,
      }),
      {
        deltaX: 90,
        kind: "horizontal-pan",
      },
    );
    assert.deepEqual(
      resolveWaveformWheelIntent({
        deltaX: 0,
        deltaY: -90,
        shiftKey: false,
      }),
      {
        deltaY: -90,
        kind: "zoom",
      },
    );
    assert.deepEqual(
      resolveWaveformWheelIntent({
        deltaX: 0,
        deltaY: 0,
        shiftKey: false,
      }),
      { kind: "none" },
    );
  });

  test("normalizes raw wheel input into one affine waveform operation", () => {
    assert.deepEqual(
      resolveWaveformWheelOperation({
        deltaMode: 1,
        deltaX: 3,
        deltaY: 9,
        shiftKey: false,
        viewportHeight: 200,
        viewportWidth: 800,
      }),
      {
        deltaX: 48,
        kind: "horizontal-pan",
      },
    );
    assert.deepEqual(
      resolveWaveformWheelOperation({
        deltaMode: 0,
        deltaX: 0,
        deltaY: 90,
        shiftKey: true,
        viewportHeight: 200,
        viewportWidth: 800,
      }),
      {
        deltaX: 90,
        kind: "horizontal-pan",
      },
    );
    assert.deepEqual(
      resolveWaveformWheelOperation({
        deltaMode: 0,
        deltaX: 0,
        deltaY: -90,
        shiftKey: false,
        viewportHeight: 200,
        viewportWidth: 800,
      }),
      {
        deltaY: -90,
        kind: "zoom",
      },
    );
  });

  test("prevents default browser behavior only for handled waveform wheel intents", () => {
    assert.equal(shouldPreventWaveformWheelDefault({ kind: "none" }), false);
    assert.equal(
      shouldPreventWaveformWheelDefault({
        deltaX: 48,
        kind: "horizontal-pan",
      }),
      true,
    );
    assert.equal(
      shouldPreventWaveformWheelDefault({
        deltaY: -90,
        kind: "zoom",
      }),
      true,
    );
  });

  test("clamps horizontal wheel pan to scrollable waveform bounds", () => {
    assert.equal(
      resolveWaveformHorizontalScrollLeft({
        contentWidth: 1_000,
        deltaX: 90,
        scrollLeft: 120,
        viewportWidth: 300,
      }),
      210,
    );
    assert.equal(
      resolveWaveformHorizontalScrollLeft({
        contentWidth: 1_000,
        deltaX: 900,
        scrollLeft: 120,
        viewportWidth: 300,
      }),
      700,
    );
  });

  test("resolves horizontal wheel pan as a single scroll frame", () => {
    assert.deepEqual(
      resolveWaveformHorizontalPanFrame({
        contentWidth: 1_000,
        deltaX: 90,
        scrollLeft: 120,
        viewportWidth: 300,
      }),
      {
        changed: true,
        scrollLeft: 210,
      },
    );
    assert.deepEqual(
      resolveWaveformHorizontalPanFrame({
        contentWidth: 1_000,
        deltaX: -90,
        scrollLeft: 0,
        viewportWidth: 300,
      }),
      {
        changed: false,
        scrollLeft: 0,
      },
    );
  });

  test("keeps subpixel horizontal pan input in logical scroll state", () => {
    assert.deepEqual(
      resolveWaveformHorizontalPanFrame({
        contentWidth: 1_000,
        deltaX: 0.25,
        scrollLeft: 120,
        viewportWidth: 300,
      }),
      {
        changed: true,
        scrollLeft: 120.25,
      },
    );
    assert.equal(
      hasWaveformViewportPositionChanged({
        currentScrollLeft: 120,
        currentVisualScrollLeft: 120,
        nextScrollLeft: 120.25,
        nextVisualScrollLeft: 120,
      }),
      true,
    );
    assert.equal(
      hasWaveformViewportPositionChanged({
        currentScrollLeft: 120,
        currentVisualScrollLeft: 120,
        nextScrollLeft: 120,
        nextVisualScrollLeft: 120,
      }),
      false,
    );
  });

  test("models OverlayScrollbars scroll state as one logical waveform position", () => {
    assert.equal(
      resolveWaveformScrollReadValue({
        scrollOffsetElementScrollLeft: 210,
        viewportScrollLeft: 0,
      }),
      210,
    );
    assert.equal(
      resolveWaveformScrollReadValue({
        scrollOffsetElementScrollLeft: 0,
        viewportScrollLeft: 210,
      }),
      210,
    );
    assert.deepEqual(
      resolveWaveformScrollWritePlan({
        hasSeparateScrollOffsetElement: true,
        scrollLeft: 320,
      }),
      {
        scrollOffsetElementScrollLeft: 320,
        viewportScrollLeft: 320,
      },
    );
    assert.deepEqual(
      resolveWaveformScrollWritePlan({
        hasSeparateScrollOffsetElement: false,
        scrollLeft: 320,
      }),
      {
        scrollOffsetElementScrollLeft: null,
        viewportScrollLeft: 320,
      },
    );
  });

  test("uses horizontal legacy wheel fields without treating generic wheelDelta as pan", () => {
    assert.equal(
      resolveWaveformWheelDeltaX({
        deltaX: 0,
        wheelDeltaX: -120,
      }),
      120,
    );
    assert.equal(
      resolveWaveformWheelDeltaX({
        deltaX: 42,
        wheelDeltaX: -120,
      }),
      42,
    );
    assert.deepEqual(
      resolveWaveformWheelDeltas({
        deltaX: 0,
        deltaY: 0,
        wheelDelta: -120,
      }),
      {
        deltaMode: 0,
        deltaX: 0,
        deltaY: 120,
      },
    );
  });

  test("uses generic legacy wheelDelta as pan only for explicit horizontal axis", () => {
    assert.equal(
      resolveWaveformWheelDeltaX({
        axis: 1,
        deltaX: 0,
        wheelDelta: -120,
        horizontalAxis: 1,
      }),
      120,
    );
    assert.deepEqual(
      resolveWaveformWheelDeltas({
        axis: 1,
        deltaX: 0,
        deltaY: 100,
        horizontalAxis: 1,
      }),
      {
        deltaMode: 0,
        deltaX: 0,
        deltaY: 100,
      },
    );
    assert.deepEqual(
      resolveWaveformWheelOperation({
        ...resolveWaveformWheelDeltas({
          axis: 1,
          deltaX: 0,
          deltaY: 100,
          horizontalAxis: 1,
        }),
        shiftKey: false,
        viewportHeight: 200,
        viewportWidth: 800,
      }),
      {
        deltaY: 100,
        kind: "zoom",
      },
    );
  });

  test("does not synthesize horizontal pan from vertical wheel fields", () => {
    assert.deepEqual(
      resolveWaveformWheelDeltas({
        axis: 1,
        deltaX: 0,
        deltaY: 0,
        horizontalAxis: 1,
        wheelDeltaY: -120,
      }),
      {
        deltaMode: 0,
        deltaX: 0,
        deltaY: 120,
      },
    );
    assert.deepEqual(
      resolveWaveformWheelDeltas({
        axis: 1,
        deltaX: 0,
        deltaY: 0,
        horizontalAxis: 1,
        wheelDelta: 0,
      }),
      {
        deltaMode: 0,
        deltaX: 0,
        deltaY: 0,
      },
    );
  });

  test("uses the scroll container as the pan extent source", () => {
    assert.equal(
      resolveWaveformWheelPanContentWidth({
        scrollOffsetElementScrollWidth: 12_000,
        viewportScrollWidth: 11_500,
        viewportWidth: 800,
        wheelStateContentWidth: 3_000,
      }),
      12_000,
    );
  });

  test("keeps only the visible waveform tiles plus overscan mounted", () => {
    assert.deepEqual(
      resolveWaveformTileWindow({
        contentWidth: 10_000,
        overscanTiles: 1,
        scrollLeft: 2_500,
        tileWidth: 1_000,
        viewportWidth: 1_200,
      }),
      {
        startIndex: 1,
        endIndex: 4,
      },
    );
  });

  test("loads visible waveform tiles before overscan tiles", () => {
    assert.deepEqual(
      resolveWaveformTileLoadOrder({
        startIndex: 2,
        endIndex: 8,
        visibleStartIndex: 4,
        visibleEndIndex: 6,
      }),
      [5, 4, 6, 3, 7, 2, 8],
    );
  });

  test("loads waveform tiles around the zoom anchor before visible edges", () => {
    assert.deepEqual(
      resolveWaveformTileLoadOrder({
        startIndex: 2,
        endIndex: 8,
        priorityIndex: 6.2,
        visibleStartIndex: 4,
        visibleEndIndex: 6,
      }),
      [6, 5, 4, 7, 8, 3, 2],
    );
  });

  test("maps zoom anchor seconds into source tile priority space", () => {
    assert.equal(
      resolveWaveformTilePriorityIndex({
        anchorSeconds: 12.8,
        renderPixelsPerSecond: 50,
        sourceTileWidth: 128,
      }),
      5,
    );
    assert.equal(
      resolveWaveformTilePriorityIndex({
        anchorSeconds: null,
        renderPixelsPerSecond: 50,
        sourceTileWidth: 128,
      }),
      null,
    );
  });

  test("keeps tile work bounded near the first visible priority", () => {
    assert.deepEqual(
      resolveWaveformTileRenderBatch({
        indexes: [6, 5, 4, 7, 8, 3],
        limit: 3,
        mode: "visible-only",
      }),
      {
        immediateIndexes: [6, 5, 4],
        deferredIndexes: [7, 8, 3],
      },
    );
    assert.deepEqual(
      resolveWaveformTileRenderBatch({
        indexes: [6, 5, 4, 7, 8, 3],
        limit: 3,
        mode: "complete",
      }),
      {
        immediateIndexes: [6, 5, 4],
        deferredIndexes: [7, 8, 3],
      },
    );
  });

  test("keeps deferred visible tiles in the complete render pipeline", () => {
    assert.deepEqual(
      resolveWaveformDeferredRenderIndexes({
        allowOffscreen: true,
        deferredIndexes: [8, 3],
        mode: "complete",
        offscreenTileLoadOrder: [2, 9],
      }),
      [8, 3, 2, 9],
    );
    assert.deepEqual(
      resolveWaveformDeferredRenderIndexes({
        deferredIndexes: [8, 3],
        mode: "visible-only",
        offscreenTileLoadOrder: [2, 9],
      }),
      [8, 3],
    );
  });

  test("keeps active zoom rendering limited to the visible tiles", () => {
    assert.deepEqual(
      resolveWaveformTileRenderScope({
        mode: "active-scroll",
        renderBatch: {
          immediateIndexes: [6, 5, 4, 7],
          deferredIndexes: [8, 3],
        },
        tileLoadOrder: [6, 5, 4, 7, 8, 3],
        visibleTileLoadOrder: [6, 5],
      }),
      {
        allowOffscreen: false,
        immediateIndexes: [6, 5],
        loadIndexes: [6, 5, 4, 7, 8, 3],
        visibilityIndexes: [6, 5],
      },
    );
  });

  test("keeps complete rendering responsible for overscan tiles", () => {
    assert.deepEqual(
      resolveWaveformTileRenderScope({
        mode: "complete",
        renderBatch: {
          immediateIndexes: [6, 5, 4],
          deferredIndexes: [7, 8, 3],
        },
        tileLoadOrder: [6, 5, 4, 7, 8, 3],
        visibleTileLoadOrder: [6, 5],
      }),
      {
        allowOffscreen: true,
        immediateIndexes: [6, 5, 4],
        loadIndexes: [6, 5, 4],
        visibilityIndexes: [6, 5, 4, 7, 8, 3],
      },
    );
  });

  test("defers offscreen detail until the visible window has pixels", () => {
    assert.deepEqual(
      resolveWaveformDeferredRenderIndexes({
        allowOffscreen: false,
        deferredIndexes: [8, 3],
        mode: "complete",
        offscreenTileLoadOrder: [2, 9],
      }),
      [8, 3],
    );
  });

  test("keeps visible tile loads ahead of retained offscreen work", () => {
    const offscreenQueued = resolveWaveformTileLoadQueue({
      current: {
        entries: [],
        nextOrder: 0,
      },
      indexes: [2, 3],
      shouldQueue: () => true,
      priority: "offscreen",
      reason: "render-window-offscreen",
      queuedAtMs: 10,
      retainPendingQueue: true,
    });
    const visibleQueued = resolveWaveformTileLoadQueue({
      current: offscreenQueued,
      indexes: [0, 1],
      shouldQueue: () => true,
      priority: "visible",
      reason: "render-window-visible",
      queuedAtMs: 20,
      retainPendingQueue: true,
    });

    assert.deepEqual(
      visibleQueued.entries.map((entry) => ({
        index: entry.index,
        priority: entry.priority,
      })),
      [
        { index: 0, priority: "visible" },
        { index: 1, priority: "visible" },
        { index: 2, priority: "offscreen" },
        { index: 3, priority: "offscreen" },
      ],
    );
  });

  test("promotes a pending offscreen tile when it becomes visible", () => {
    const queued = resolveWaveformTileLoadQueue({
      current: {
        entries: [
          {
            index: 2,
            order: 0,
            priority: "offscreen",
            queuedAtMs: 10,
            reason: "render-window-offscreen",
          },
          {
            index: 3,
            order: 1,
            priority: "offscreen",
            queuedAtMs: 12,
            reason: "render-window-offscreen",
          },
        ],
        nextOrder: 2,
      },
      indexes: [3],
      shouldQueue: () => true,
      priority: "visible",
      reason: "render-window-visible",
      queuedAtMs: 30,
      retainPendingQueue: true,
    });

    assert.deepEqual(
      queued.entries.map((entry) => ({
        index: entry.index,
        priority: entry.priority,
      })),
      [
        { index: 3, priority: "visible" },
        { index: 2, priority: "offscreen" },
      ],
    );
  });

  test("keeps queue timestamps stable when a pending tile is promoted", () => {
    const queued = resolveWaveformTileLoadQueue({
      current: {
        entries: [
          {
            index: 2,
            order: 0,
            priority: "offscreen",
            queuedAtMs: 10,
            reason: "render-window-offscreen",
          },
          {
            index: 3,
            order: 1,
            priority: "offscreen",
            queuedAtMs: 12,
            reason: "render-window-offscreen",
          },
        ],
        nextOrder: 2,
      },
      indexes: [3, 4],
      shouldQueue: () => true,
      priority: "visible",
      reason: "render-window-visible",
      queuedAtMs: 30,
      retainPendingQueue: true,
    });

    assert.deepEqual(
      queued.entries.map((entry) => ({
        index: entry.index,
        priority: entry.priority,
        queuedAtMs: entry.queuedAtMs,
      })),
      [
        { index: 3, priority: "visible", queuedAtMs: 12 },
        { index: 4, priority: "visible", queuedAtMs: 30 },
        { index: 2, priority: "offscreen", queuedAtMs: 10 },
      ],
    );
  });

  test("queues next-density prefetch as its own target tile", () => {
    const queued = resolveWaveformTileLoadQueue({
      current: {
        entries: [],
        nextOrder: 0,
      },
      entries: [
        {
          cacheKey: "next-density",
          fetchStartPx: 2_037,
          fetchWidthPx: 2_070,
          index: 1,
          renderPixelsPerSecond: 100,
        },
      ],
      indexes: [1],
      shouldQueue: (index) => index === 1,
      priority: "prefetch",
      reason: "prefetch-next-density",
      queuedAtMs: 40,
      retainPendingQueue: true,
    });

    assert.deepEqual(queued.entries, [
      {
        cacheKey: "next-density",
        fetchStartPx: 2_037,
        fetchWidthPx: 2_070,
        index: 1,
        order: 0,
        priority: "prefetch",
        queuedAtMs: 40,
        reason: "prefetch-next-density",
        renderPixelsPerSecond: 100,
      },
    ]);
  });

  test("keeps prefetch and visible load entries independent for the same index", () => {
    const queued = resolveWaveformTileLoadQueue({
      current: {
        entries: [
          {
            cacheKey: "next-density",
            fetchStartPx: 2_037,
            fetchWidthPx: 2_070,
            index: 1,
            order: 0,
            priority: "prefetch",
            queuedAtMs: 40,
            reason: "prefetch-next-density",
            renderPixelsPerSecond: 100,
          },
        ],
        nextOrder: 1,
      },
      indexes: [1],
      shouldQueue: () => true,
      priority: "visible",
      reason: "render-window-visible",
      queuedAtMs: 50,
      retainPendingQueue: true,
    });

    assert.deepEqual(
      queued.entries.map((entry) => ({
        cacheKey: entry.cacheKey ?? null,
        index: entry.index,
        priority: entry.priority,
        reason: entry.reason,
      })),
      [
        {
          cacheKey: null,
          index: 1,
          priority: "visible",
          reason: "render-window-visible",
        },
        {
          cacheKey: "next-density",
          index: 1,
          priority: "prefetch",
          reason: "prefetch-next-density",
        },
      ],
    );
  });

  test("keeps next-density prefetch ahead of retained offscreen work", () => {
    const queued = resolveWaveformTileLoadQueue({
      current: {
        entries: [
          {
            index: 8,
            order: 0,
            priority: "offscreen",
            queuedAtMs: 10,
            reason: "render-window-offscreen",
          },
        ],
        nextOrder: 1,
      },
      entries: [
        {
          cacheKey: "next-density",
          fetchStartPx: 4_085,
          fetchWidthPx: 2_070,
          index: 2,
          renderPixelsPerSecond: 100,
        },
      ],
      indexes: [2],
      shouldQueue: () => true,
      priority: "prefetch",
      reason: "prefetch-next-density",
      queuedAtMs: 30,
      retainPendingQueue: true,
    });

    assert.deepEqual(
      queued.entries.map((entry) => ({
        index: entry.index,
        priority: entry.priority,
        reason: entry.reason,
      })),
      [
        { index: 2, priority: "prefetch", reason: "prefetch-next-density" },
        { index: 8, priority: "offscreen", reason: "render-window-offscreen" },
      ],
    );
  });

  test("classifies tile loads at the render layer boundary", () => {
    assert.deepEqual(
      resolveWaveformTileLoadGroups({
        indexes: [0, 1, 2, 3],
        visibleTileWindow: {
          startIndex: 1,
          endIndex: 2,
        },
      }),
      {
        visibleIndexes: [1, 2],
        offscreenIndexes: [0, 3],
      },
    );
  });

  test("selects the lowest source density that keeps zoom detail continuous", () => {
    const summary = createWaveformTestSummary();

    assert.equal(
      resolveWaveformRenderPixelsPerSecond({
        pixelsPerSecond: 24,
        summary,
      }),
      50,
    );
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({
        pixelsPerSecond: 192,
        summary,
      }),
      200,
    );
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({
        pixelsPerSecond: 900,
        summary,
      }),
      800,
    );
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({
        summary,
      }),
      800,
    );
  });

  test("refines source density before one displayed bar has to represent too much data", () => {
    const summary = createWaveformTestSummary();
    const renderPixelsPerSecond = resolveWaveformRenderPixelsPerSecond({
      pixelsPerSecond: 293.31,
      summary,
    });
    const renderScale = resolveWaveformRenderScale({
      pixelsPerSecond: 293.31,
      renderPixelsPerSecond,
    });

    assert.equal(renderPixelsPerSecond, 400);
    assert.ok(renderScale < 1);
  });

  test("loads the next source density while zoom still feels continuous", () => {
    const summary = createWaveformTestSummary();

    assert.equal(
      resolveWaveformNextRenderPixelsPerSecond({
        pixelsPerSecond: 37,
        summary,
      }),
      100,
    );
    assert.equal(
      resolveWaveformNextRenderPixelsPerSecond({
        pixelsPerSecond: 86,
        summary,
      }),
      200,
    );
    assert.equal(
      resolveWaveformNextRenderPixelsPerSecond({
        pixelsPerSecond: 120,
        summary,
      }),
      null,
    );
    assert.equal(
      resolveWaveformNextRenderPixelsPerSecond({
        pixelsPerSecond: 800,
        summary,
      }),
      null,
    );
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({
        pixelsPerSecond: 51.85,
        summary,
      }),
      100,
    );
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({
        pixelsPerSecond: 79.38,
        summary,
      }),
      100,
    );
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({
        pixelsPerSecond: 80.01,
        summary,
      }),
      100,
    );
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({
        pixelsPerSecond: 160.01,
        summary,
      }),
      200,
    );
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({
        pixelsPerSecond: 320.01,
        summary,
      }),
      400,
    );
  });

  test("maps the visible tile window to next-density target tiles", () => {
    assert.deepEqual(
      resolveWaveformNextDensityPrefetchEntries({
        contentWidth: 12_000,
        currentRenderPixelsPerSecond: 50,
        durationMs: 120_000,
        nextRenderPixelsPerSecond: 100,
        pixelsPerSecond: 42,
        visibleTileWindow: {
          startIndex: 0,
          endIndex: 1,
        },
      }),
      [
        {
          fetchStartPx: 2037,
          fetchWidthPx: 2070,
          index: 1,
          renderPixelsPerSecond: 100,
        },
        {
          fetchStartPx: 4085,
          fetchWidthPx: 2070,
          index: 2,
          renderPixelsPerSecond: 100,
        },
        {
          fetchStartPx: 0,
          fetchWidthPx: 2059,
          index: 0,
          renderPixelsPerSecond: 100,
        },
        {
          fetchStartPx: 6133,
          fetchWidthPx: 2070,
          index: 3,
          renderPixelsPerSecond: 100,
        },
      ],
    );
  });

  test("prioritizes next-density prefetch around the zoom anchor", () => {
    assert.deepEqual(
      resolveWaveformNextDensityPrefetchEntries({
        contentWidth: 24_000,
        currentRenderPixelsPerSecond: 50,
        durationMs: 120_000,
        nextRenderPixelsPerSecond: 100,
        pixelsPerSecond: 42,
        priorityIndex: 1,
        visibleTileWindow: {
          startIndex: 0,
          endIndex: 2,
        },
      }).map((entry) => entry.index),
      [2, 1, 3, 0, 4, 5],
    );
  });

  test("draws scaled tiles at display resolution while keeping source ranges stable", () => {
    assert.equal(
      resolveWaveformTileDisplayWidth({
        widthPx: 2_048,
        renderScale: 0.125,
      }),
      256,
    );
    assert.deepEqual(
      resolveWaveformTileSourcePixelRange({
        displayPixelX: 1,
        renderScale: 0.25,
        sourcePixelCount: 16,
      }),
      {
        startIndex: 4,
        endIndex: 8,
      },
    );
  });

  test("does not stretch a lower-density tile when display scale exceeds one", () => {
    assert.equal(
      resolveWaveformTileDisplayWidth({
        widthPx: 640,
        renderScale: 3.2,
      }),
      640,
    );
    assert.deepEqual(
      resolveWaveformTileSourcePixelRange({
        displayPixelX: 7,
        renderScale: 3.2,
        sourcePixelCount: 16,
      }),
      {
        startIndex: 7,
        endIndex: 8,
      },
    );
  });

  test("maps source tile edges into display pixels without layout gaps", () => {
    const left = resolveWaveformTileDisplayRange({
      contentWidth: 2_000,
      renderScale: 0.3,
      sourceStartPx: 0,
      sourceWidthPx: 2_048,
    });
    const right = resolveWaveformTileDisplayRange({
      contentWidth: 2_000,
      renderScale: 0.3,
      sourceStartPx: 2_048,
      sourceWidthPx: 2_048,
    });

    assert.equal(left.displayStartPx + left.displayWidthPx, right.displayStartPx);
    assert.equal(left.displayWidthPx, 614);
    assert.equal(right.displayWidthPx, 615);
  });

  test("keeps retained tile geometry current even when a tile is outside the active render window", () => {
    const mountedTileIndexes = Array.from({ length: 14 }, (_, index) => index);
    const plan = resolveWaveformTileRenderPlan({
      mountedTileIndexes,
      retentionTileWindow: {
        startIndex: 0,
        endIndex: 13,
      },
      tileWindow: {
        startIndex: 0,
        endIndex: 8,
      },
      visibleTileWindow: {
        startIndex: 2,
        endIndex: 6,
      },
    });

    assert.deepEqual(plan.removeIndexes, []);
    assert.ok(plan.retainedSyncIndexes.includes(13));
    assert.ok(!plan.tileLoadOrder.includes(13));
    assert.ok(!plan.visibleTileLoadOrder.includes(13));
    assert.ok(!plan.offscreenTileLoadOrder.includes(13));
  });

  test("does not downgrade a scheduled complete tile render to visible only", () => {
    assert.equal(resolveWaveformTileRenderMode("visible-only", "visible-only"), "visible-only");
    assert.equal(resolveWaveformTileRenderMode("visible-only", "active-scroll"), "active-scroll");
    assert.equal(resolveWaveformTileRenderMode("active-scroll", "visible-only"), "active-scroll");
    assert.equal(resolveWaveformTileRenderMode("visible-only", "complete"), "complete");
    assert.equal(resolveWaveformTileRenderMode("complete", "active-scroll"), "complete");
  });

  test("keeps tile render mode composition associative and monotonic", () => {
    const compose = (modes: Array<"active-scroll" | "complete" | "visible-only">) =>
      modes.reduce(resolveWaveformTileRenderMode, "visible-only");

    assert.equal(compose(["active-scroll", "visible-only", "complete"]), "complete");
    assert.equal(compose(["complete", "visible-only", "active-scroll"]), "complete");
    assert.equal(compose(["visible-only", "active-scroll", "visible-only"]), "active-scroll");
  });

  test("keeps the active render window while it still covers the viewport", () => {
    assert.equal(
      isWaveformTileWindowCoveringWindow(
        {
          startIndex: 8,
          endIndex: 14,
        },
        {
          startIndex: 10,
          endIndex: 12,
        },
      ),
      true,
    );
    assert.equal(
      isWaveformTileWindowCoveringWindow(
        {
          startIndex: 8,
          endIndex: 14,
        },
        {
          startIndex: 7,
          endIndex: 12,
        },
      ),
      false,
    );
  });

  test("hides mounted tiles outside the active visibility window", () => {
    assert.deepEqual(
      resolveWaveformTileVisibilityPlan({
        mountedTileIndexes: [3, 4, 5, 9],
        visibleTileIndexes: [4, 5],
      }),
      {
        hiddenIndexes: [3, 9],
        visibleIndexes: [4, 5],
      },
    );
  });

  test("shows overscan indexes supplied by the render plan", () => {
    assert.deepEqual(
      resolveWaveformTileVisibilityPlan({
        mountedTileIndexes: [3, 4, 5, 9],
        visibleTileIndexes: [3, 4, 5],
      }),
      {
        hiddenIndexes: [9],
        visibleIndexes: [3, 4, 5],
      },
    );
  });

  test("keeps presentation transform limited to raster alignment", () => {
    assert.equal(
      resolveWaveformPresentationTransform({
        transformPx: 0.25,
      }),
      "translate3d(0.25px, 0, 0)",
    );

    assert.equal(
      resolveWaveformPresentationTransform({
        transformPx: 0,
      }),
      "none",
    );
  });

  test("keeps waveform bars one css pixel wide across render scales", () => {
    assert.equal(resolveWaveformBarWidthPx({ renderScale: 0.12 }), 1);
    assert.equal(resolveWaveformBarWidthPx({ renderScale: 1 }), 1);
    assert.equal(resolveWaveformBarWidthPx({ renderScale: 2.4 }), 1);
  });

  test("keeps source fetch windows padded for the lowest zoom edge pixels", () => {
    const sourcePaddingPx = resolveWaveformTileSourcePadding({
      renderPixelsPerSecond: 50,
    });

    assert.equal(sourcePaddingPx, 7);
    assert.deepEqual(
      resolveWaveformTileSourceFetchRange({
        sourceContentWidth: 10_000,
        sourcePaddingPx,
        sourceStartPx: 2_048,
        sourceWidthPx: 2_048,
      }),
      {
        fetchStartPx: 2_041,
        fetchWidthPx: 2_062,
      },
    );
  });

  test("maps display pixels back into padded source tile data", () => {
    assert.deepEqual(
      resolveWaveformTileSourcePixelRange({
        displayStartPx: 614,
        displayPixelX: 0,
        renderScale: 0.3,
        sourcePixelCount: 2_120,
        sourceStartPx: 2_012,
      }),
      {
        startIndex: 34,
        endIndex: 38,
      },
    );
  });

  test("aligns fractional scroll rasterization to viewport pixels", () => {
    const scrollLeft = 771 + 0.33331298828125;

    assert.deepEqual(resolveWaveformRasterAlignment({ scrollLeft }), {
      sampleDisplayOffsetPx: 0.33331298828125,
      snappedScrollLeft: 771,
      transformPx: 0.33331298828125,
    });
    assert.deepEqual(resolveWaveformRasterAlignment({ scrollLeft: 10.75 }), {
      sampleDisplayOffsetPx: -0.25,
      snappedScrollLeft: 11,
      transformPx: -0.25,
    });
  });

  test("keeps logical waveform sampling separate from quantized DOM scroll", () => {
    const alignment = resolveWaveformRasterAlignment({
      sampleScrollLeft: 1669.6067639495554,
      scrollLeft: 1669.3333740234375,
    });

    assert.equal(alignment.snappedScrollLeft, 1669);
    assert.equal(alignment.transformPx, 0.3333740234375);
    assert.ok(Math.abs(alignment.sampleDisplayOffsetPx - 0.6067639495554) < 0.000000000001);
  });

  test("samples the source range under the viewport pixel after fractional scroll snapping", () => {
    const scrollLeft = 771 + 0.33331298828125;
    const anchorViewportX = 665;
    const renderScale = 51.85 / 400;
    const alignment = resolveWaveformRasterAlignment({ scrollLeft });

    assert.deepEqual(
      resolveWaveformTileSourcePixelRange({
        displayStartPx: alignment.snappedScrollLeft,
        displayPixelX: anchorViewportX,
        displaySampleOffsetPx: alignment.sampleDisplayOffsetPx,
        renderScale,
        sourcePixelCount: 50_000,
      }),
      {
        startIndex: Math.floor((scrollLeft + anchorViewportX) / renderScale),
        endIndex: Math.ceil((scrollLeft + anchorViewportX + 1) / renderScale),
      },
    );
  });

  test("keeps repeated zoom anchored from logical scroll instead of DOM quantization", () => {
    const anchorViewportX = 408;
    const currentPixelsPerSecond = 148.13;
    const logicalScrollLeft = 2110.3353195359014;
    const quantizedScrollLeft = 2110.666748046875;
    const logical = resolveWaveformZoomFrame({
      anchorViewportX,
      currentPixelsPerSecond,
      deltaY: 100,
      durationMs: 140_000,
      scrollLeft: logicalScrollLeft,
      viewportWidth: 1_400,
    });
    const quantized = resolveWaveformZoomFrame({
      anchorViewportX,
      currentPixelsPerSecond,
      deltaY: 100,
      durationMs: 140_000,
      scrollLeft: quantizedScrollLeft,
      viewportWidth: 1_400,
    });

    assert.equal(logical.pixelsPerSecond, 122.19);
    assert.equal(logical.anchorSeconds, (logicalScrollLeft + anchorViewportX) / 148.13);
    assert.ok(Math.abs(quantized.scrollLeft - logical.scrollLeft) > 0.27);
  });

  test("keeps programmatic scroll echoes from overwriting logical scroll", () => {
    assert.deepEqual(
      resolveWaveformViewportScrollEventFrame({
        currentScrollLeft: 2_110.3353195359014,
        incomingVisualScrollLeft: 2_110.666748046875,
        isLogicalScrollLocked: false,
        pendingProgrammaticScrollEcho: {
          trace: null,
          visualScrollLeft: 2_110.666748046875,
        },
      }),
      {
        kind: "programmatic-echo",
        scrollLeft: 2_110.3353195359014,
        visualScrollLeft: 2_110.666748046875,
      },
    );
  });

  test("treats non-echo viewport scroll as the new logical scroll", () => {
    assert.deepEqual(
      resolveWaveformViewportScrollEventFrame({
        currentScrollLeft: 2_110.3353195359014,
        incomingVisualScrollLeft: 2_320,
        isLogicalScrollLocked: false,
        pendingProgrammaticScrollEcho: {
          trace: null,
          visualScrollLeft: 2_110.666748046875,
        },
      }),
      {
        kind: "external-scroll",
        scrollLeft: 2_320,
        visualScrollLeft: 2_320,
      },
    );
  });

  test("keeps explicit logical scroll locks separate from presentation state", () => {
    assert.deepEqual(
      resolveWaveformViewportScrollEventFrame({
        currentScrollLeft: 1_669.3333740234375,
        incomingVisualScrollLeft: 2_110.666748046875,
        isLogicalScrollLocked: true,
        pendingProgrammaticScrollEcho: {
          trace: null,
          visualScrollLeft: 1_669.3333740234375,
        },
      }),
      {
        kind: "programmatic-echo",
        scrollLeft: 1_669.3333740234375,
        visualScrollLeft: 2_110.666748046875,
      },
    );
  });

  test("uses actual backing-store scale for fractional device pixels", () => {
    assert.deepEqual(
      resolveWaveformCanvasBackingMetrics({
        cssHeight: 208,
        cssWidth: 123,
        devicePixelRatio: 1.5,
      }),
      {
        backingHeight: 312,
        backingWidth: 185,
        cssHeight: 208,
        cssWidth: 123,
        scaleX: 185 / 123,
        scaleY: 1.5,
      },
    );
  });

  test("aggregates high resolution quantized peaks into one display pixel", () => {
    assert.deepEqual(
      resolveQuantizedWaveformDisplayPeak({
        min: [-10, -80, -20, -40],
        max: [10, 30, 90, 20],
        displayPixelX: 0,
        renderScale: 0.25,
      }),
      {
        min: -80 / 127,
        max: 90 / 127,
      },
    );
  });

  test("maps viewport scroll into the slot coordinate space", () => {
    assert.equal(
      resolveWaveformRenderScale({
        pixelsPerSecond: 20,
        renderPixelsPerSecond: 50,
      }),
      0.4,
    );
    assert.deepEqual(
      resolveWaveformRenderViewport({
        renderScale: 0.4,
        scrollLeft: 200,
        viewportWidth: 800,
      }),
      {
        scrollLeft: 500,
        viewportWidth: 2_000,
      },
    );
  });

  test("keeps waveform bar width constant while zoom changes slot spacing", () => {
    const lowScale = resolveWaveformRenderScale({
      pixelsPerSecond: 20,
      renderPixelsPerSecond: 50,
    });
    const highScale = resolveWaveformRenderScale({
      pixelsPerSecond: 160,
      renderPixelsPerSecond: 50,
    });

    assert.equal(lowScale, 0.4);
    assert.equal(highScale, 1);
    assert.equal(resolveWaveformBarWidthPx({ renderScale: lowScale }), 1);
    assert.equal(resolveWaveformBarWidthPx({ renderScale: highScale }), 1);
  });

  test("keeps source tile width independent from presentation spacing", () => {
    assert.equal(resolveWaveformSourceTileWidth({ renderScale: 0.4 }), 2_048);
    assert.equal(resolveWaveformSourceTileWidth({ renderScale: 3.2 }), 2_048);
    assert.equal(resolveWaveformSourceTileWidth({ renderScale: 3.6 }), 2_048);
    assert.equal(resolveWaveformSourceTileWidth({ renderScale: 4.1 }), 2_048);
  });

  test("keeps the rendered tile window bounded as slot spacing changes", () => {
    const lowZoomScale = 12 / 50;
    const highZoomScale = 320 / 50;
    const lowZoomWindow = resolveWaveformRenderTileWindow({
      contentWidth: 50_000,
      overscanTiles: 0,
      renderScale: lowZoomScale,
      scrollLeft: 4_800,
      tileWidth: resolveWaveformSourceTileWidth({ renderScale: lowZoomScale }),
      viewportWidth: 800,
    });
    const highZoomWindow = resolveWaveformRenderTileWindow({
      contentWidth: 320_000,
      overscanTiles: 0,
      renderScale: highZoomScale,
      scrollLeft: 4_800,
      tileWidth: resolveWaveformSourceTileWidth({ renderScale: highZoomScale }),
      viewportWidth: 800,
    });

    assert.ok(lowZoomWindow);
    assert.ok(highZoomWindow);
    assertWaveformTileWindow(lowZoomWindow);
    assertWaveformTileWindow(highZoomWindow);
    assert.ok(
      highZoomWindow.endIndex - highZoomWindow.startIndex <
        lowZoomWindow.endIndex - lowZoomWindow.startIndex,
    );
  });

  test("keeps source density width tied to audio duration", () => {
    assert.equal(
      resolveWaveformRenderContentWidth({
        durationMs: 2_000,
        renderPixelsPerSecond: 50,
      }),
      100,
    );
  });

  test("keeps source density width independent from viewport fill width", () => {
    assert.equal(
      resolveWaveformRenderContentWidth({
        durationMs: 99_000,
        renderPixelsPerSecond: 50,
      }),
      4_950,
    );
  });

  test("aggregates all backend peaks covered by a rendered pixel", () => {
    assert.deepEqual(
      resolveWaveformPeakRange({
        peaks: [
          { min: -0.1, max: 0.2 },
          { min: -0.9, max: 0.1 },
          { min: -0.2, max: 0.7 },
        ],
        pointsPerSecond: 3,
        pixelsPerSecond: 1,
        scrollLeft: 0,
        pixelX: 0,
      }),
      {
        min: -0.9,
        max: 0.7,
      },
    );
  });

  test("interpolates playback position while audio is playing", () => {
    assert.equal(
      resolvePlaybackPositionMs({
        snapshot: {
          path: "C:/music/track.m4a",
          playing: true,
          paused: false,
          position_ms: 1_000,
          duration_ms: 10_000,
          received_at_ms: 500,
        },
        nowMs: 750,
        durationMs: 10_000,
      }),
      1_250,
    );
  });

  test("keeps paused playback position stable", () => {
    assert.equal(
      resolvePlaybackPositionMs({
        snapshot: {
          path: "C:/music/track.m4a",
          playing: true,
          paused: true,
          position_ms: 1_000,
          duration_ms: 10_000,
          received_at_ms: 500,
        },
        nowMs: 1_500,
        durationMs: 10_000,
      }),
      1_000,
    );
  });

  test("maps playback position into the scrolled waveform viewport", () => {
    assert.equal(
      resolveWaveformPlayheadX({
        positionMs: 2_000,
        pixelsPerSecond: 100,
        scrollLeft: 50,
      }),
      150,
    );
  });

  test("resolves playhead visibility without touching DOM state", () => {
    assert.deepEqual(
      resolveWaveformPlayheadStyle({
        positionMs: 2_000,
        pixelsPerSecond: 100,
        scrollLeft: 50,
        viewportWidth: 300,
      }),
      {
        opacity: "0.86",
        transform: "translate3d(150px, 0, 0)",
      },
    );
    assert.deepEqual(
      resolveWaveformPlayheadStyle({
        positionMs: 2_000,
        pixelsPerSecond: 100,
        scrollLeft: 400,
        viewportWidth: 300,
      }),
      {
        opacity: "0",
        transform: "translate3d(-9999px, 0, 0)",
      },
    );
  });

  test("normalizes windows paths for playback status matching", () => {
    assert.equal(
      normalizeWaveformPathKey("C:\\Music\\Track.M4A"),
      normalizeWaveformPathKey("c:/music/track.m4a"),
    );
  });
});

function assertWaveformTileWindow(
  window: ReturnType<typeof resolveWaveformRenderTileWindow>,
): asserts window is NonNullable<ReturnType<typeof resolveWaveformRenderTileWindow>> {
  assert.ok(window);
}
