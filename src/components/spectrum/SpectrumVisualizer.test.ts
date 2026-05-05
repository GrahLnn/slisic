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
  resolveAnchoredWaveformScrollLeft,
  resolveCenteredWaveformScrollLeft,
  resolvePlaybackPositionMs,
  resolveQuantizedWaveformDisplayPeak,
  resolveTrackWaveformInitialStatus,
  resolveWaveformBarWidthPx,
  resolveWaveformCanvasSeamBoundaryProbes,
  resolveWaveformContentWidth,
  resolveWaveformDataPlan,
  resolveWaveformDataTileIndexes,
  resolveWaveformDataWindow,
  resolveWaveformHardwareHorizontalWheelDelta,
  resolveWaveformHorizontalPanFrame,
  resolveWaveformHorizontalScrollLeft,
  resolveWaveformCanvasFrameReusePlan,
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
  resolveWaveformTileIndexPeakRangeAtPixels,
  resolveWaveformTilePeakRangeAtPixels,
  resolveWaveformTilePeakAtSeconds,
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
  shouldPreventWaveformWheelDefault,
  summarizeWaveformCanvasSeamPixelColumn,
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
        current: createWaveformTestFrameDescriptor({
          dataPixelsPerSecond: 200,
          scrollLeft: 120,
        }),
        previous,
      }),
      {
        kind: "none",
        reason: "render-density-changed",
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
  });

  test("probes waveform seam evidence at data tile and render chunk boundaries", () => {
    const tile = {
      max: Array.from({ length: 2_048 }, () => 64),
      min: Array.from({ length: 2_048 }, () => -64),
      points_per_second: 100,
      start_px: 2_048,
      width_px: 2_048,
    };
    const plan = {
      amplitude: 86,
      availableLevels: [100],
      candidateLevels: [
        {
          pixelsPerSecond: 100,
          tilesByIndex: new Map([[1, tile]]),
        },
      ],
      centerY: 104,
      dataPixelsPerSecond: 100,
      geometry: {
        backingHeight: 208,
        backingWidth: 1_000,
        devicePixelRatio: 1,
        viewportWidth: 1_000,
      },
      scopeKey: "track",
      viewport: {
        contentWidth: 10_000,
        durationMs: 100_000,
        focusSeconds: null,
        maximumPixelsPerSecond: 800,
        pixelsPerSecond: 100,
        scrollLeft: 1_548,
        viewportWidth: 1_000,
      },
      visibleSecondsWindow: {
        endSeconds: 25.48,
        startSeconds: 15.48,
      },
      visibleWindow: {
        endPx: 2_548,
        startPx: 1_548,
      },
    };

    const probes = resolveWaveformCanvasSeamBoundaryProbes({
      chunkBoundaries: [320, 640],
      plan,
    });

    assert.deepEqual(
      probes.map((probe) => ({
        kind: probe.kind,
        roundedViewportX: probe.roundedViewportX,
      })),
      [
        {
          kind: "render-chunk",
          roundedViewportX: 320,
        },
        {
          kind: "data-tile",
          roundedViewportX: 500,
        },
        {
          kind: "render-chunk",
          roundedViewportX: 640,
        },
      ],
    );

    const dataTileProbe = probes.find((probe) => probe.kind === "data-tile");
    assert.ok(dataTileProbe);
    assert.equal(dataTileProbe.tileIndex, 1);
    assert.equal(dataTileProbe.nearestDataTileBoundaryDistancePx, 0);
    assert.equal(dataTileProbe.nearestRenderChunkBoundaryDistancePx, 140);
    assert.deepEqual(
      dataTileProbe.samples.map((sample) => ({
        hasPeak: sample.hasPeak,
        offsetX: sample.offsetX,
      })),
      [
        { hasPeak: false, offsetX: -2 },
        { hasPeak: false, offsetX: -1 },
        { hasPeak: true, offsetX: 0 },
        { hasPeak: true, offsetX: 1 },
        { hasPeak: true, offsetX: 2 },
      ],
    );
  });

  test("summarizes seam readback columns without reusing the whole strip", () => {
    const data = new Uint8ClampedArray(3 * 2 * 4);
    data[3] = 16;
    data[7] = 32;
    data[11] = 48;
    data[15] = 64;
    data[19] = 80;
    data[23] = 96;

    assert.deepEqual(
      summarizeWaveformCanvasSeamPixelColumn({
        backingEndX: 2,
        backingStartX: 1,
        cssX: 10,
        image: {
          data,
          height: 2,
          width: 3,
        },
      }),
      {
        alphaCoverageRatio: 1,
        alphaMax: 80,
        alphaMean: 56,
        alphaSum: 112,
        backingEndX: 2,
        backingStartX: 1,
        cssX: 10,
        drawnPixelCount: 2,
        firstDrawnBackingY: 0,
        lastDrawnBackingY: 1,
        totalPixelCount: 2,
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

  test("prioritizes visible and focused data without dropping overscan", () => {
    const summary = createWaveformTestSummary();
    const plan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      end: null,
      filePath: "C:/music/demo.flac",
      focusSeconds: 6,
      pixelsPerSecond: 200,
      scrollLeft: 1_000,
      start: null,
      summary,
      tileWidth: 1_000,
      viewportWidth: 1_000,
    });

    assert.deepEqual(plan.visibleIndexes, [1]);
    assert.equal(plan.requests[0]?.priority, "visible");
    assert.ok(plan.requests.some((request) => request.priority === "overscan"));
    assert.ok(plan.requests.length > plan.visibleIndexes.length);
  });

  test("changes data request keys on every render density change", () => {
    const summary = createWaveformTestSummary();
    const scopeKey = createWaveformDataScopeKey({
      end: null,
      filePath: "C:/music/demo.flac",
      start: null,
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
        pixelsPerSecond: 100,
        positionMs: 5_000,
        scrollLeft: 250,
      }),
      250,
    );
    assert.deepEqual(
      resolveWaveformPlayheadStyle({
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

  test("advances playback snapshots only while playing", () => {
    const snapshot = {
      duration_ms: 20_000,
      path: "C:/music/demo.flac",
      paused: false,
      playing: true,
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
