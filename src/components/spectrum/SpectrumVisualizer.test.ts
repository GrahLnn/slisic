import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TrackWaveformSummary } from "@/src/cmd";
import {
  clampWaveformZoomDeltaY,
  createWaveformDataRequestKey,
  createWaveformDataScopeKey,
  drawWaveformCanvasJobChunk,
  handleWaveformViewportWheel,
  normalizeWaveformPathKey,
  resolvePlaybackSnapshotDurationMs,
  resolveAnchoredWaveformScrollLeft,
  resolveCenteredWaveformScrollLeft,
  resolvePlaybackPositionMs,
  resolveQuantizedWaveformDisplayPeak,
  resolveTrackWaveformInitialStatus,
  resolveWaveformBarWidthPx,
  resolveWaveformContentWidth,
  resolveWaveformDataPlan,
  resolveWaveformDataPlanScopedRequests,
  resolveWaveformDataTileIndexes,
  resolveWaveformDataWindow,
  resolveWaveformHardwareHorizontalWheelDelta,
  resolveWaveformHorizontalPanFrame,
  resolveWaveformHorizontalScrollLeft,
  resolveWaveformCanvasFrameReusePlan,
  shouldBeginWaveformCanvasChunkPath,
  resolveWaveformLoadingGridSize,
  resolveWaveformMaximumPixelsPerSecond,
  resolveWaveformMinimumPixelsPerSecond,
  resolveWaveformNextRenderPixelsPerSecond,
  resolveWaveformPeakRange,
  resolveWaveformPixelsPerSecond,
  resolveWaveformPlayheadStyle,
  resolveWaveformPlayheadX,
  resolveWaveformPointerAnchorViewportX,
  resolveQueuedWaveformZoomFrame,
  resolveWaveformRenderPixelsPerSecond,
  resolveWaveformRenderScale,
  resolveWaveformSelectionDrag,
  resolveWaveformSelectionGeometry,
  resolveWaveformSelectionStartScrollLeft,
  resolveWaveformTileIndexPeakRangeAtPixels,
  resolveWaveformTilePeakRangeAtPixels,
  resolveWaveformTilePeakAtSeconds,
  resolveWaveformTransaction,
  resolveWaveformWheelAxisDeltas,
  resolveWaveformWheelDeltaX,
  resolveWaveformWheelDeltas,
  resolveWaveformWheelOperation,
  resolveWaveformWheelPanDelta,
  resolveWaveformWheelPixelDeltas,
  resolveWaveformWheelPixelsPerSecond,
  resolveWaveformZoomFrame,
  resolveWaveformZoomScaleFrame,
  shouldAcceptWaveformHardwareHorizontalWheel,
  shouldStrokeWaveformCanvasChunkPath,
  shouldPresentWaveformTileAvailability,
  shouldPreventWaveformWheelDefault,
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

function createWaveformTestFrameDescriptor(
  overrides: {
    dataPixelsPerSecond?: number;
    scopeKey?: string;
    scrollLeft?: number;
    viewportWidth?: number;
  } = {},
) {
  const viewportWidth = overrides.viewportWidth ?? 1_000;

  return {
    dataPixelsPerSecond: overrides.dataPixelsPerSecond ?? 100,
    geometry: {
      backingHeight: 208,
      backingWidth: viewportWidth,
      devicePixelRatio: 1,
      viewportWidth,
    },
    scopeKey: overrides.scopeKey ?? "track",
    viewport: {
      contentWidth: 10_000,
      durationMs: 100_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 100,
      scrollLeft: overrides.scrollLeft ?? 0,
      viewportWidth,
    },
  };
}

function createWaveformCanvasTestContext() {
  return {
    beginPathCount: 0,
    lineToCount: 0,
    moveToCount: 0,
    strokeCount: 0,
    beginPath() {
      this.beginPathCount += 1;
    },
    lineTo() {
      this.lineToCount += 1;
    },
    moveTo() {
      this.moveToCount += 1;
    },
    stroke() {
      this.strokeCount += 1;
    },
  };
}

function createWaveformCanvasTestPlan(overrides: { viewportWidth?: number } = {}) {
  const viewportWidth = overrides.viewportWidth ?? 4;
  const tile = {
    max: Array.from({ length: viewportWidth }, () => 64),
    min: Array.from({ length: viewportWidth }, () => -64),
    points_per_second: 100,
    start_px: 0,
    width_px: viewportWidth,
  };

  return {
    amplitude: 86,
    availableLevels: [100],
    candidateLevels: [
      {
        pixelsPerSecond: 100,
        tilesByIndex: new Map([[0, tile]]),
      },
    ],
    centerY: 104,
    dataPixelsPerSecond: 100,
    geometry: {
      backingHeight: 208,
      backingWidth: viewportWidth,
      devicePixelRatio: 1,
      viewportWidth,
    },
    scopeKey: "track",
    viewport: {
      contentWidth: viewportWidth,
      durationMs: 100_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 100,
      scrollLeft: 0,
      viewportWidth,
    },
    visibleSecondsWindow: {
      endSeconds: viewportWidth / 100,
      startSeconds: 0,
    },
    visibleWindow: {
      endPx: viewportWidth,
      startPx: 0,
    },
  };
}

describe("SpectrumVisualizer", () => {
  test("starts waveform preparation as loading only when a track is present", () => {
    assert.equal(resolveTrackWaveformInitialStatus("C:/music/demo.flac"), "loading");
    assert.equal(resolveTrackWaveformInitialStatus("   "), "idle");
    assert.equal(resolveTrackWaveformInitialStatus(null), "idle");
  });

  test("adapts waveform loading grid density to the container", () => {
    const compact = resolveWaveformLoadingGridSize({
      height: 60,
      width: 120,
    });
    const wide = resolveWaveformLoadingGridSize({
      height: 208,
      width: 900,
    });

    assert.deepEqual(compact, {
      columns: 10,
      rows: 4,
    });
    assert.deepEqual(wide, {
      columns: 75,
      rows: 9,
    });
    assert.ok(wide.columns > compact.columns);
    assert.ok(wide.rows > compact.rows);
  });

  test("keeps waveform at least as wide as the viewport", () => {
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
      1_200,
    );
  });

  test("clamps zoom bounds from duration and render density", () => {
    const summary = createWaveformTestSummary();

    assert.equal(
      resolveWaveformMinimumPixelsPerSecond({
        durationMs: 10_000,
        viewportWidth: 1_000,
      }),
      100,
    );
    assert.equal(resolveWaveformMaximumPixelsPerSecond({ maximumPixelsPerSecond: 640 }), 640);
    assert.equal(
      resolveWaveformPixelsPerSecond(10_000, {
        durationMs: summary.duration_ms,
        maximumPixelsPerSecond: 400,
        viewportWidth: 1_000,
      }),
      400,
    );
  });

  test("selects the smallest render level that can represent the current zoom", () => {
    const summary = createWaveformTestSummary();

    assert.equal(resolveWaveformRenderPixelsPerSecond({ pixelsPerSecond: 12, summary }), 50);
    assert.equal(resolveWaveformRenderPixelsPerSecond({ pixelsPerSecond: 80, summary }), 100);
    assert.equal(resolveWaveformRenderPixelsPerSecond({ pixelsPerSecond: 401, summary }), 800);
    assert.equal(resolveWaveformRenderPixelsPerSecond({ summary }), 800);
  });

  test("returns the next render density immediately when a finer level exists", () => {
    const summary = createWaveformTestSummary();

    assert.equal(resolveWaveformNextRenderPixelsPerSecond({ pixelsPerSecond: 51, summary }), 200);
    assert.equal(resolveWaveformNextRenderPixelsPerSecond({ pixelsPerSecond: 399, summary }), 800);
    assert.equal(resolveWaveformNextRenderPixelsPerSecond({ pixelsPerSecond: 800, summary }), null);
  });

  test("keeps bar width constant across all zoom scales", () => {
    assert.equal(resolveWaveformBarWidthPx(), 1);
    assert.equal(
      resolveWaveformRenderScale({
        pixelsPerSecond: 25,
        renderPixelsPerSecond: 50,
      }),
      0.5,
    );
    assert.equal(
      resolveWaveformRenderScale({
        pixelsPerSecond: 800,
        renderPixelsPerSecond: 400,
      }),
      2,
    );
    assert.equal(resolveWaveformBarWidthPx(), 1);
  });

  test("keeps frontend wheel intent limited to zoom and explicit shift-pan", () => {
    assert.deepEqual(
      resolveWaveformWheelOperation({
        deltaMode: 0,
        deltaX: 100,
        deltaY: 80,
        viewportHeight: 200,
        viewportWidth: 900,
      }),
      {
        deltaY: 80,
        kind: "zoom",
      },
    );
    assert.deepEqual(
      resolveWaveformWheelOperation({
        deltaMode: 0,
        deltaX: 0,
        deltaY: 80,
        shiftKey: true,
        viewportHeight: 200,
        viewportWidth: 900,
      }),
      {
        deltaX: 80,
        kind: "horizontal-pan",
      },
    );
    assert.deepEqual(
      resolveWaveformWheelOperation({
        deltaMode: 0,
        deltaX: 0,
        deltaY: 80,
        viewportHeight: 200,
        viewportWidth: 900,
      }),
      {
        deltaY: 80,
        kind: "zoom",
      },
    );
  });

  test("projects shift vertical wheel input onto the horizontal waveform axis", () => {
    assert.deepEqual(
      resolveWaveformWheelAxisDeltas({
        deltaMode: 0,
        deltaX: 0,
        deltaY: 100,
        shiftKey: true,
      }),
      {
        deltaMode: 0,
        deltaX: 100,
        deltaY: 0,
      },
    );
    assert.deepEqual(
      resolveWaveformWheelAxisDeltas({
        deltaMode: 0,
        deltaX: 0,
        deltaY: -100,
        shiftKey: true,
      }),
      {
        deltaMode: 0,
        deltaX: -100,
        deltaY: 0,
      },
    );
    assert.deepEqual(
      resolveWaveformWheelAxisDeltas({
        deltaMode: 0,
        deltaX: -80,
        deltaY: 100,
        shiftKey: true,
      }),
      {
        deltaMode: 0,
        deltaX: 100,
        deltaY: 0,
      },
    );
    assert.deepEqual(
      resolveWaveformWheelOperation({
        deltaMode: 0,
        deltaX: 0,
        deltaY: -120,
        shiftKey: true,
        viewportHeight: 200,
        viewportWidth: 900,
      }),
      {
        deltaX: -120,
        kind: "horizontal-pan",
      },
    );
  });

  test("keeps direct frontend horizontal wheel inert while backend owns hardware pan", () => {
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
      resolveWaveformWheelOperation({
        deltaMode: 0,
        deltaX: -100,
        deltaY: 0,
        viewportHeight: 200,
        viewportWidth: 900,
      }),
      {
        kind: "none",
      },
    );
  });

  test("prevents default scrolling for every concrete waveform wheel operation", () => {
    assert.equal(
      shouldPreventWaveformWheelDefault({
        deltaX: 100,
        kind: "horizontal-pan",
      }),
      true,
    );
    assert.equal(
      shouldPreventWaveformWheelDefault({
        deltaY: 100,
        kind: "zoom",
      }),
      true,
    );
    assert.equal(
      shouldPreventWaveformWheelDefault({
        kind: "none",
      }),
      false,
    );
  });

  test("normalizes wheel deltaX without letting frontend wheel own hardware pan", () => {
    assert.equal(resolveWaveformWheelDeltaX({ deltaX: 100 }), 100);
    assert.equal(resolveWaveformWheelDeltaX({ deltaX: -100 }), -100);
    assert.deepEqual(
      resolveWaveformWheelDeltas({
        deltaX: 100,
        deltaY: 0,
      }),
      {
        deltaMode: 0,
        deltaX: 100,
        deltaY: 0,
      },
    );
    assert.deepEqual(
      resolveWaveformWheelOperation({
        deltaMode: 0,
        deltaX: -100,
        deltaY: 0,
        viewportHeight: 200,
        viewportWidth: 900,
      }),
      {
        kind: "none",
      },
    );
    assert.deepEqual(
      resolveWaveformWheelOperation({
        deltaMode: 0,
        deltaX: 500,
        deltaY: 0,
        viewportHeight: 200,
        viewportWidth: 900,
      }),
      {
        kind: "none",
      },
    );
  });

  test("exposes the wheel pixel-delta conversion independently of intent choice", () => {
    assert.deepEqual(
      resolveWaveformWheelPixelDeltas({
        deltaMode: 1,
        deltaX: -3,
        deltaY: 4,
        viewportHeight: 200,
        viewportWidth: 900,
      }),
      {
        deltaX: -48,
        deltaY: 64,
      },
    );
    assert.deepEqual(
      resolveWaveformWheelPixelDeltas({
        deltaMode: 2,
        deltaX: 1,
        deltaY: -1,
        viewportHeight: 200,
        viewportWidth: 900,
      }),
      {
        deltaX: 900,
        deltaY: -200,
      },
    );
  });

  test("keeps isolated zero-delta wheel packets inert", () => {
    assert.deepEqual(
      resolveWaveformWheelOperation({
        deltaMode: 0,
        deltaX: 0,
        deltaY: 0,
        viewportHeight: 200,
        viewportWidth: 900,
      }),
      {
        kind: "none",
      },
    );
  });

  test("clamps horizontal pan to the scrollable waveform bounds", () => {
    assert.equal(
      resolveWaveformHorizontalScrollLeft({
        contentWidth: 1_000,
        deltaX: 250,
        scrollLeft: 100,
        viewportWidth: 400,
      }),
      350,
    );
    assert.equal(
      resolveWaveformHorizontalScrollLeft({
        contentWidth: 1_000,
        deltaX: 2_000,
        scrollLeft: 100,
        viewportWidth: 400,
      }),
      600,
    );
    assert.deepEqual(
      resolveWaveformHorizontalPanFrame({
        contentWidth: 1_000,
        deltaX: 0,
        scrollLeft: 600,
        viewportWidth: 400,
      }),
      {
        changed: false,
        scrollLeft: 600,
      },
    );
  });

  test("computes horizontal pan from the virtual viewport state only", () => {
    assert.deepEqual(
      resolveWaveformHorizontalPanFrame({
        contentWidth: 1_000,
        deltaX: -120,
        scrollLeft: 350,
        viewportWidth: 400,
      }),
      {
        changed: true,
        scrollLeft: 230,
      },
    );
    assert.deepEqual(
      resolveWaveformHorizontalPanFrame({
        contentWidth: 1_000,
        deltaX: -120,
        scrollLeft: 0,
        viewportWidth: 400,
      }),
      {
        changed: false,
        scrollLeft: 0,
      },
    );
    assert.deepEqual(
      resolveWaveformHorizontalPanFrame({
        contentWidth: 1_000,
        deltaX: 0.0000001,
        scrollLeft: 350,
        viewportWidth: 400,
      }),
      {
        changed: false,
        scrollLeft: 350,
      },
    );
  });

  test("uses backend hardware horizontal wheel deltas as viewport pan deltas", () => {
    assert.equal(resolveWaveformHardwareHorizontalWheelDelta({ deltaX: 120 }), 120);
    assert.equal(resolveWaveformHardwareHorizontalWheelDelta({ deltaX: -120 }), -120);
    assert.equal(resolveWaveformHardwareHorizontalWheelDelta({ deltaX: Number.NaN }), 0);
    assert.deepEqual(
      resolveWaveformHorizontalPanFrame({
        contentWidth: 1_000,
        deltaX: resolveWaveformHardwareHorizontalWheelDelta({ deltaX: -120 }),
        scrollLeft: 350,
        viewportWidth: 400,
      }),
      {
        changed: true,
        scrollLeft: 230,
      },
    );
  });

  test("reuses the presented waveform frame only for affine horizontal pan", () => {
    const previous = createWaveformTestFrameDescriptor({
      scrollLeft: 1_000,
    });

    assert.deepEqual(
      resolveWaveformCanvasFrameReusePlan({
        current: createWaveformTestFrameDescriptor({
          scrollLeft: 1_120,
        }),
        previous,
      }),
      {
        exposedEndX: 1_000,
        exposedStartX: 880,
        kind: "horizontal-pan",
        scrollDeltaPx: 120,
        shiftX: -120,
      },
    );
    assert.deepEqual(
      resolveWaveformCanvasFrameReusePlan({
        current: createWaveformTestFrameDescriptor({
          scrollLeft: 880,
        }),
        previous,
      }),
      {
        exposedEndX: 120,
        exposedStartX: 0,
        kind: "horizontal-pan",
        scrollDeltaPx: -120,
        shiftX: 120,
      },
    );
  });

  test("rejects waveform frame reuse when the affine identity changes", () => {
    const previous = createWaveformTestFrameDescriptor();

    assert.deepEqual(
      resolveWaveformCanvasFrameReusePlan({
        current: {
          ...createWaveformTestFrameDescriptor({
            scrollLeft: 2_500,
          }),
          viewport: {
            ...createWaveformTestFrameDescriptor({
              scrollLeft: 2_500,
            }).viewport,
            contentWidth: 20_000,
            pixelsPerSecond: 200,
          },
        },
        previous,
      }),
      {
        kind: "none",
        reason: "scale-changed",
      },
    );
    assert.deepEqual(
      resolveWaveformCanvasFrameReusePlan({
        current: createWaveformTestFrameDescriptor({
          scopeKey: "other-track",
          scrollLeft: 120,
        }),
        previous,
      }),
      {
        kind: "none",
        reason: "content-changed",
      },
    );
    assert.deepEqual(
      resolveWaveformCanvasFrameReusePlan({
        current: createWaveformTestFrameDescriptor({
          scrollLeft: 0.5,
        }),
        previous,
      }),
      {
        kind: "none",
        reason: "scroll-delta-fractional",
      },
    );
    assert.deepEqual(
      resolveWaveformCanvasFrameReusePlan({
        current: {
          ...createWaveformTestFrameDescriptor(),
          dataPixelsPerSecond: 200,
          viewport: {
            ...createWaveformTestFrameDescriptor().viewport,
            contentWidth: 10_100,
          },
        },
        previous,
      }),
      {
        kind: "none",
        reason: "content-changed",
      },
    );
  });

  test("strokes a complete waveform canvas job only after all chunks are accumulated", () => {
    const context = createWaveformCanvasTestContext();
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 120 });
    const target = {
      context: context as unknown as CanvasRenderingContext2D,
      frame: {} as HTMLCanvasElement,
      geometry: plan.geometry,
      kind: "buffered" as const,
    };
    const firstChunk = drawWaveformCanvasJobChunk({
      cursor: {
        firstMissingX: null,
        hasDrawnColumn: false,
        lastMissingX: null,
        missingPeakColumnCount: 0,
        nextX: 0,
        resolvedPeakColumnCount: 0,
      },
      deadlineMs: 0,
      now: () => 1,
      plan,
      target,
    });

    assert.equal(firstChunk.completed, false);
    assert.equal(firstChunk.cursor.nextX, 97);
    assert.equal(context.beginPathCount, 1);
    assert.equal(context.strokeCount, 0);

    const secondChunk = drawWaveformCanvasJobChunk({
      cursor: firstChunk.cursor,
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 1,
      plan,
      target,
    });

    assert.equal(secondChunk.completed, true);
    assert.equal(secondChunk.cursor.nextX, 120);
    assert.equal(context.beginPathCount, 1);
    assert.equal(context.strokeCount, 1);
    assert.equal(context.moveToCount, 120);
    assert.equal(context.lineToCount, 120);
  });

  test("strokes visible first paint chunks independently", () => {
    assert.equal(
      shouldBeginWaveformCanvasChunkPath({
        startX: 120,
        targetKind: "buffered",
      }),
      false,
    );
    assert.equal(
      shouldBeginWaveformCanvasChunkPath({
        startX: 120,
        targetKind: "visible",
      }),
      true,
    );
    assert.equal(
      shouldStrokeWaveformCanvasChunkPath({
        completed: false,
        cursorHasDrawnColumn: true,
        hasChunkColumn: true,
        targetKind: "buffered",
      }),
      false,
    );
    assert.equal(
      shouldStrokeWaveformCanvasChunkPath({
        completed: false,
        cursorHasDrawnColumn: true,
        hasChunkColumn: true,
        targetKind: "visible",
      }),
      true,
    );
  });

  test("accepts backend hardware horizontal wheel only while the waveform host is hovered", () => {
    const host = {
      getBoundingClientRect: () => ({
        bottom: 250,
        left: 100,
        right: 500,
        top: 50,
      }),
    } as Element;

    assert.equal(
      shouldAcceptWaveformHardwareHorizontalWheel({
        clientX: 200,
        clientY: 120,
        host: null,
      }),
      false,
    );
    assert.equal(
      shouldAcceptWaveformHardwareHorizontalWheel({
        clientX: Number.NaN,
        clientY: 120,
        host,
      }),
      false,
    );
    assert.equal(
      shouldAcceptWaveformHardwareHorizontalWheel({
        clientX: 99,
        clientY: 120,
        host,
      }),
      false,
    );
    assert.equal(
      shouldAcceptWaveformHardwareHorizontalWheel({
        clientX: 200,
        clientY: 120,
        host,
      }),
      true,
    );
  });

  test("ignores non-shift frontend horizontal wheel while backend owns hardware pan", () => {
    let committed = false;
    let prevented = false;

    handleWaveformViewportWheel({
      commitViewport: () => {
        committed = true;
      },
      event: {
        currentTarget: null,
        deltaMode: 0,
        deltaX: 120,
        deltaY: 0,
        deltaZ: 0,
        isTrusted: true,
        preventDefault: () => {
          prevented = true;
        },
        shiftKey: false,
        timeStamp: 1_000,
      } as WheelEvent,
      queueZoomViewport: () => {
        committed = true;
      },
      viewport: {
        contentWidth: 1_000,
        durationMs: 120_000,
        focusSeconds: null,
        maximumPixelsPerSecond: 800,
        pixelsPerSecond: 100,
        scrollLeft: 350,
        viewportWidth: 400,
      },
    });

    assert.equal(prevented, false);
    assert.equal(committed, false);
  });

  test("commits explicit shift-pan as interactive viewport work", () => {
    let prevented = false;
    let request:
      | Parameters<Parameters<typeof handleWaveformViewportWheel>[0]["commitViewport"]>[0]
      | null = null;

    handleWaveformViewportWheel({
      commitViewport: (nextRequest) => {
        request = nextRequest;
      },
      event: {
        currentTarget: null,
        deltaMode: 0,
        deltaX: 0,
        deltaY: 120,
        deltaZ: 0,
        isTrusted: true,
        preventDefault: () => {
          prevented = true;
        },
        shiftKey: true,
        timeStamp: 1_000,
      } as WheelEvent,
      queueZoomViewport: () => {
        assert.fail("shift-pan should not enter the zoom scheduler");
      },
      viewport: {
        contentWidth: 1_000,
        durationMs: 120_000,
        focusSeconds: 4,
        maximumPixelsPerSecond: 800,
        pixelsPerSecond: 100,
        scrollLeft: 350,
        viewportWidth: 400,
      },
    });

    assert.equal(prevented, true);
    assert.notEqual(request, null);
    assert.deepEqual(request, {
      mode: "interactive",
      state: {
        focusSeconds: null,
        pixelsPerSecond: 100,
        scrollLeft: 470,
        viewportWidth: 400,
      },
    });
  });

  test("zooms around the pointer anchor without drifting", () => {
    const frame = resolveWaveformZoomFrame({
      anchorViewportX: 250,
      currentPixelsPerSecond: 100,
      deltaY: -180,
      durationMs: 120_000,
      maximumPixelsPerSecond: 800,
      scrollLeft: 750,
      viewportWidth: 1_000,
    });
    const anchoredAfterZoom = (frame.scrollLeft + frame.anchorViewportX) / frame.pixelsPerSecond;

    assert.equal(frame.anchorSeconds, 10);
    assert.ok(Math.abs(anchoredAfterZoom - 10) < 0.01);
  });

  test("clamps zoom delta and computes zoom scale frame", () => {
    assert.equal(clampWaveformZoomDeltaY(14_200), 180);
    assert.equal(clampWaveformZoomDeltaY(-14_200), -180);

    const frame = resolveWaveformZoomScaleFrame({
      currentPixelsPerSecond: 100,
      deltaY: -180,
      durationMs: 120_000,
      maximumPixelsPerSecond: 800,
      viewportWidth: 1_000,
    });

    assert.equal(frame.changed, true);
    assert.equal(frame.pixelsPerSecond, 141.42);
  });

  test("resolves pointer anchors inside the viewport", () => {
    assert.equal(
      resolveWaveformPointerAnchorViewportX({
        clientX: 500,
        viewportLeft: 300,
        viewportWidth: 400,
      }),
      200,
    );
    assert.equal(
      resolveWaveformPointerAnchorViewportX({
        clientX: 900,
        viewportLeft: 300,
        viewportWidth: 400,
      }),
      400,
    );
  });

  test("builds data windows from the logical viewport plus overscan", () => {
    assert.deepEqual(
      resolveWaveformDataWindow({
        contentWidth: 10_000,
        overscanPx: 500,
        scrollLeft: 1_000,
        viewportWidth: 1_000,
      }),
      {
        endPx: 2_500,
        startPx: 500,
      },
    );
    assert.deepEqual(
      resolveWaveformDataTileIndexes({
        tileWidth: 1_000,
        window: {
          endPx: 2_500,
          startPx: 500,
        },
      }),
      [0, 1, 2],
    );
  });

  test("maps selection boundaries onto the current viewport without changing data scope", () => {
    const viewport = {
      contentWidth: 2_400,
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 20,
      scrollLeft: 100,
      viewportWidth: 1_000,
    };
    const summary = createWaveformTestSummary();
    const baseScopeKey = createWaveformDataScopeKey({
      filePath: "C:/music/demo.flac",
      summary,
    });
    const geometry = resolveWaveformSelectionGeometry({
      selection: {
        end: 80,
        start: 10,
      },
      viewport,
    });
    const changedSelectionScopeKey = createWaveformDataScopeKey({
      filePath: "C:/music/demo.flac",
      summary,
    });

    assert.deepEqual(geometry, {
      endX: 1_500,
      isComplete: true,
      startX: 100,
    });
    assert.equal(changedSelectionScopeKey, baseScopeKey);
  });

  test("resolves selection drags inside the full track duration", () => {
    const viewport = {
      contentWidth: 2_400,
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 20,
      scrollLeft: 100,
      viewportWidth: 1_000,
    };

    assert.deepEqual(
      resolveWaveformSelectionDrag({
        edge: "start",
        hostRect: { left: 50 },
        pointerClientX: 257,
        selection: {
          end: 80,
          start: 10,
        },
        viewport,
      }),
      {
        end: 80,
        start: 15.35,
      },
    );
    assert.deepEqual(
      resolveWaveformSelectionDrag({
        edge: "end",
        hostRect: { left: 50 },
        pointerClientX: 5_000,
        selection: {
          end: 80,
          start: 10,
        },
        viewport,
      }),
      {
        end: 120,
        start: 10,
      },
    );
  });

  test("keeps selection boundary drags continuous at subsecond precision", () => {
    const viewport = {
      contentWidth: 2_400,
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 80,
      scrollLeft: 100,
      viewportWidth: 1_000,
    };

    assert.deepEqual(
      resolveWaveformSelectionDrag({
        edge: "start",
        hostRect: { left: 50 },
        pointerClientX: 77,
        selection: {
          end: 80,
          start: 10,
        },
        viewport,
      }),
      {
        end: 80,
        start: 1.5875,
      },
    );
  });

  test("does not let selection boundary drags cross each other", () => {
    const viewport = {
      contentWidth: 2_400,
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 20,
      scrollLeft: 100,
      viewportWidth: 1_000,
    };

    assert.deepEqual(
      resolveWaveformSelectionDrag({
        edge: "start",
        hostRect: { left: 50 },
        pointerClientX: 2_000,
        selection: {
          end: 80,
          start: 10,
        },
        viewport,
      }),
      {
        end: 80,
        start: 80,
      },
    );
    assert.deepEqual(
      resolveWaveformSelectionDrag({
        edge: "end",
        hostRect: { left: 50 },
        pointerClientX: -1_000,
        selection: {
          end: 80,
          start: 10,
        },
        viewport,
      }),
      {
        end: 10,
        start: 10,
      },
    );
  });

  test("prioritizes visible and focused data without dropping overscan", () => {
    const summary = createWaveformTestSummary();
    const plan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/music/demo.flac",
      focusSeconds: 6,
      pixelsPerSecond: 200,
      scrollLeft: 1_000,
      summary,
      tileWidth: 1_000,
      viewportWidth: 1_000,
    });

    assert.deepEqual(plan.visibleIndexes, [1]);
    assert.equal(plan.requests[0]?.priority, "visible");
    assert.ok(
      plan.requests.findIndex((request) => request.priority === "prefetch-focus") <
        plan.requests.findIndex((request) => request.priority === "prefetch-visible"),
    );
    assert.ok(
      plan.requests.findIndex((request) => request.priority === "prefetch-visible") <
        plan.requests.findIndex((request) => request.priority === "overscan"),
    );
    assert.ok(plan.requests.some((request) => request.priority === "prefetch-visible"));
    assert.ok(plan.requests.some((request) => request.priority === "overscan"));
    assert.ok(plan.requests.length > plan.visibleIndexes.length);
  });

  test("prefetches deeper zoom data around the focus while protecting coarser visible data", () => {
    const summary = createWaveformTestSummary();
    const plan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/music/demo.flac",
      focusSeconds: 6,
      pixelsPerSecond: 200,
      scrollLeft: 1_000,
      summary,
      tileWidth: 1_000,
      viewportWidth: 1_000,
    });
    const focusPrefetchLevels = plan.requests
      .filter((request) => request.priority === "prefetch-focus")
      .map((request) => request.dataPixelsPerSecond);
    const visiblePrefetchLevels = plan.requests
      .filter((request) => request.priority === "prefetch-visible")
      .map((request) => request.dataPixelsPerSecond);
    const reversePrefetchLevels = plan.requests
      .filter((request) => request.priority === "prefetch-reverse")
      .map((request) => request.dataPixelsPerSecond);
    const currentVisibleKeys = plan.requests
      .filter((request) => request.priority === "visible")
      .map((request) => request.cacheKey);
    const lowerVisibleKey = createWaveformDataRequestKey({
      pixelsPerSecond: 50,
      scopeKey: plan.scopeKey,
      startPx: 0,
      widthPx: 1_000,
    });

    assert.deepEqual(focusPrefetchLevels, [400, 800]);
    assert.deepEqual(visiblePrefetchLevels, [400]);
    assert.deepEqual(reversePrefetchLevels, [100, 50]);
    assert.ok(currentVisibleKeys.every((key) => plan.protectedCacheKeys.includes(key)));
    assert.ok(plan.protectedCacheKeys.includes(lowerVisibleKey));
  });

  test("keeps visible demand separate from cache protection", () => {
    const summary = createWaveformTestSummary();
    const plan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/music/demo.flac",
      focusSeconds: 6,
      pixelsPerSecond: 200,
      scrollLeft: 1_000,
      summary,
      tileWidth: 1_000,
      viewportWidth: 1_000,
    });
    const visibleRequests = resolveWaveformDataPlanScopedRequests(plan, "visible");
    const visibleKeys = new Set(visibleRequests.map((request) => request.cacheKey));

    assert.ok(visibleRequests.every((request) => request.priority !== "prefetch-focus"));
    assert.ok(visibleRequests.every((request) => request.priority !== "prefetch-visible"));
    assert.ok(visibleRequests.every((request) => request.priority !== "overscan"));
    assert.ok(plan.protectedCacheKeys.every((key) => visibleKeys.has(key)));
    assert.ok(
      plan.requests
        .filter((request) => request.priority === "prefetch-focus")
        .every((request) => !visibleKeys.has(request.cacheKey)),
    );
  });

  test("keeps prefetch and overscan cache fills from requesting presentation", () => {
    assert.equal(shouldPresentWaveformTileAvailability("visible"), true);
    assert.equal(shouldPresentWaveformTileAvailability("visible-guard"), true);
    assert.equal(shouldPresentWaveformTileAvailability("prefetch-reverse"), true);
    assert.equal(shouldPresentWaveformTileAvailability("prefetch-focus"), false);
    assert.equal(shouldPresentWaveformTileAvailability("prefetch-visible"), false);
    assert.equal(shouldPresentWaveformTileAvailability("overscan"), false);
  });

  test("keeps interactive zoom data demand visible-only", () => {
    const summary = createWaveformTestSummary();
    const plan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/music/demo.flac",
      focusSeconds: 6,
      mode: "interactive",
      pixelsPerSecond: 200,
      scrollLeft: 1_000,
      summary,
      tileWidth: 1_000,
      viewportWidth: 1_000,
    });

    assert.equal(plan.mode, "interactive");
    assert.deepEqual(plan.visibleIndexes, [1]);
    assert.deepEqual(
      plan.requests.map((request) => request.priority),
      ["visible", "visible-guard", "visible-guard"],
    );
    assert.deepEqual(plan.overscanSecondsWindow, plan.visibleSecondsWindow);
    assert.deepEqual(plan.overscanWindow, plan.visibleWindow);
  });

  test("keeps interactive presentation independent from throttled data demand", () => {
    const plan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/Music/track.wav",
      focusSeconds: 5,
      mode: "interactive",
      pixelsPerSecond: 100,
      scrollLeft: 500,
      summary: createWaveformTestSummary(),
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
    const settled = resolveWaveformTransaction({
      lastInteractiveDataDemand: second.nextInteractiveDataDemand,
      mode: "settled",
      now: 200,
      plan,
    });

    assert.equal(first.transaction.dataDemand.skipped, false);
    assert.equal(first.transaction.presentation.plan, plan);
    assert.equal(first.nextInteractiveDataDemandAt, 100);
    assert.equal(second.transaction.dataDemand.skipped, true);
    assert.equal(second.transaction.presentation.plan, plan);
    assert.equal(second.nextInteractiveDataDemandAt, 100);
    assert.equal(settled.transaction.dataDemand.skipped, false);
    assert.equal(settled.nextInteractiveDataDemandAt, null);
    assert.equal(settled.transaction.shouldScheduleCompleteData, true);
  });

  test("does not throttle interactive data demand when the visible demand changes", () => {
    const summary = createWaveformTestSummary();
    const firstPlan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/Music/track.wav",
      focusSeconds: 5,
      mode: "interactive",
      pixelsPerSecond: 100,
      scrollLeft: 500,
      summary,
      viewportWidth: 1_000,
    });
    const secondPlan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/Music/track.wav",
      focusSeconds: 5,
      mode: "interactive",
      pixelsPerSecond: 100,
      scrollLeft: 2_500,
      summary,
      viewportWidth: 1_000,
    });
    const first = resolveWaveformTransaction({
      lastInteractiveDataDemand: null,
      mode: "interactive",
      now: 100,
      plan: firstPlan,
    });
    const second = resolveWaveformTransaction({
      lastInteractiveDataDemand: first.nextInteractiveDataDemand,
      mode: "interactive",
      now: 120,
      plan: secondPlan,
    });

    assert.equal(second.transaction.dataDemand.skipped, false);
    assert.equal(second.nextInteractiveDataDemandAt, 120);
  });

  test("changes data request keys on every render density change", () => {
    const summary = createWaveformTestSummary();
    const scopeKey = createWaveformDataScopeKey({
      filePath: "C:/music/demo.flac",
      summary,
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

    assert.notEqual(low, high);
  });

  test("resolves queued zoom from the pending viewport instead of the stale viewport", () => {
    const first = resolveQueuedWaveformZoomFrame({
      anchorViewportX: 250,
      currentPixelsPerSecond: 100,
      deltaY: -180,
      durationMs: 120_000,
      maximumPixelsPerSecond: 800,
      pendingFrame: null,
      scrollLeft: 750,
      viewportWidth: 1_000,
    });
    const second = resolveQueuedWaveformZoomFrame({
      anchorViewportX: 250,
      currentPixelsPerSecond: 100,
      deltaY: -180,
      durationMs: 120_000,
      maximumPixelsPerSecond: 800,
      pendingFrame: first,
      scrollLeft: 750,
      viewportWidth: 1_000,
    });

    assert.ok(second.pixelsPerSecond > first.pixelsPerSecond);
    assert.equal(first.anchorSeconds, 10);
    assert.equal(second.anchorSeconds, 10);
    assert.equal((second.scrollLeft + second.anchorViewportX) / second.pixelsPerSecond, 10);
  });

  test("can cancel a pending zoom with an opposite same-frame packet", () => {
    const first = resolveQueuedWaveformZoomFrame({
      anchorViewportX: 250,
      currentPixelsPerSecond: 100,
      deltaY: -180,
      durationMs: 120_000,
      maximumPixelsPerSecond: 800,
      pendingFrame: null,
      scrollLeft: 750,
      viewportWidth: 1_000,
    });
    const cancelled = resolveQueuedWaveformZoomFrame({
      anchorViewportX: 250,
      currentPixelsPerSecond: 100,
      deltaY: 180,
      durationMs: 120_000,
      maximumPixelsPerSecond: 800,
      pendingFrame: first,
      scrollLeft: 750,
      viewportWidth: 1_000,
    });

    assert.ok(Math.abs(cancelled.pixelsPerSecond - 100) < 0.01);
    assert.ok(Math.abs(cancelled.scrollLeft - 750) < 0.5);
    assert.equal(cancelled.anchorSeconds, 10);
  });

  test("reads one quantized value per display column without widening bars", () => {
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
    assert.equal(resolveWaveformBarWidthPx(), 1);
  });

  test("can fill a new zoom column from cached old-density data without stretching pixels", () => {
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
    assert.equal(
      resolveWaveformTilePeakAtSeconds({
        pixelsPerSecond: 100,
        seconds: 2,
        tile: {
          max: [0, 64, 127],
          min: [0, -64, -127],
          start_px: 100,
        },
      }),
      null,
    );
  });

  test("aggregates quantized tile ranges without dropping boundary columns", () => {
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
    assert.deepEqual(
      resolveWaveformTilePeakRangeAtPixels({
        endPx: 2_049,
        startPx: 2_047,
        tile: {
          max: [64],
          min: [-64],
          start_px: 2_048,
        },
      }),
      {
        max: 64 / 127,
        min: -64 / 127,
      },
    );
    assert.equal(
      resolveWaveformTilePeakRangeAtPixels({
        endPx: 2_049,
        startPx: 2_047,
        tile: {
          max: [127],
          min: [-127],
          start_px: 2_050,
        },
      }),
      null,
    );
  });

  test("aggregates indexed tile ranges across render-area boundaries", () => {
    assert.deepEqual(
      resolveWaveformTileIndexPeakRangeAtPixels({
        endPx: 2_049,
        startPx: 2_047,
        tileWidth: 2_048,
        tilesByIndex: new Map([
          [
            0,
            {
              max: [0],
              min: [0],
              start_px: 2_047,
            },
          ],
          [
            1,
            {
              max: [127],
              min: [-127],
              start_px: 2_048,
            },
          ],
        ]),
      }),
      {
        max: 1,
        min: -1,
      },
    );
  });

  test("aggregates unquantized peak ranges for fallback callers", () => {
    assert.deepEqual(
      resolveWaveformPeakRange({
        peaks: [
          { max: 0.2, min: -0.1 },
          { max: 0.8, min: -0.5 },
          { max: 0.3, min: -0.2 },
        ],
        pixelX: 0,
        pixelsPerSecond: 1,
        pointsPerSecond: 3,
        scrollLeft: 0,
      }),
      {
        max: 0.8,
        min: -0.5,
      },
    );
  });

  test("maps playback position into the scrolled waveform viewport", () => {
    assert.equal(
      resolveWaveformPlayheadX({
        playbackStartMs: 0,
        pixelsPerSecond: 100,
        positionMs: 5_000,
        scrollLeft: 250,
      }),
      250,
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
        transform: "translate3d(250px, 0, 0)",
      },
    );
  });

  test("maps playback position from playback request start into the full waveform", () => {
    assert.equal(
      resolveWaveformPlayheadX({
        playbackStartMs: 20_000,
        pixelsPerSecond: 100,
        positionMs: 5_000,
        scrollLeft: 1_904,
      }),
      596,
    );
  });

  test("maps playback position from the actual playback request identity", () => {
    assert.equal(
      resolveWaveformPlayheadX({
        playbackStartMs: 20_000,
        pixelsPerSecond: 100,
        positionMs: 5_000,
        scrollLeft: 1_904,
      }),
      596,
    );
    assert.equal(
      resolveWaveformPlayheadX({
        playbackStartMs: 25_000,
        pixelsPerSecond: 100,
        positionMs: 5_000,
        scrollLeft: 1_904,
      }),
      1_096,
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
  });

  test("derives playback snapshot duration from the actual playback request", () => {
    assert.equal(
      resolvePlaybackSnapshotDurationMs({
        fallbackDurationMs: 120_000,
        snapshot: {
          duration_ms: null,
          music_url: "https://example.com/demo",
          path: "C:/music/demo.flac",
          paused: false,
          playback_end_ms: 40_000,
          playback_start_ms: 20_000,
          playing: true,
          playlist_name: "Focus",
          position_ms: 1_000,
          received_at_ms: 100,
        },
      }),
      20_000,
    );
  });

  test("normalizes waveform path keys case-insensitively", () => {
    assert.equal(
      normalizeWaveformPathKey("C:\\Music\\Track.M4A"),
      normalizeWaveformPathKey("c:/music/track.m4a"),
    );
  });

  test("computes centered and anchored scroll positions", () => {
    assert.equal(
      resolveCenteredWaveformScrollLeft({
        centerSeconds: 20,
        contentWidth: 5_000,
        pixelsPerSecond: 100,
        viewportWidth: 1_000,
      }),
      1_500,
    );
    assert.equal(
      resolveAnchoredWaveformScrollLeft({
        anchorSeconds: 20,
        anchorViewportX: 250,
        contentWidth: 5_000,
        pixelsPerSecond: 100,
        viewportWidth: 1_000,
      }),
      1_750,
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
      1_904,
    );
  });

  test("uses only deltaX for horizontal pan delta", () => {
    assert.equal(
      resolveWaveformWheelPanDelta({
        deltaX: 0,
      }),
      0,
    );
    assert.equal(resolveWaveformWheelPanDelta({ deltaX: -100 }), -100);
    assert.equal(
      resolveWaveformWheelPixelsPerSecond({
        currentPixelsPerSecond: 100,
        deltaY: -180,
        durationMs: 120_000,
        maximumPixelsPerSecond: 800,
        viewportWidth: 1_000,
      }),
      141.42,
    );
  });
});
