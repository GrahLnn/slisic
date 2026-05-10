import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TrackWaveformSummary } from "@/src/cmd";
import {
  __spectrumVisualizerTestHooks,
  areWaveformSelectionsEqual,
  clampWaveformZoomDeltaY,
  createWaveformDataRequestKey,
  createWaveformDataScopeKey,
  createWaveformRenderDataStore,
  createWaveformSharedTileCacheForFile,
  clearWaveformCanvasColumnRanges,
  drawWaveformCanvasJobChunk,
  drawWaveformCanvasColumnRange,
  handleWaveformViewportWheel,
  normalizeWaveformPathKey,
  resolvePlaybackSnapshotDurationMs,
  resolveAnchoredWaveformScrollLeft,
  resolveCenteredWaveformScrollLeft,
  resolvePlaybackPositionMs,
  resolveQuantizedWaveformDisplayPeak,
  resolveTrackWaveformInitialStatus,
  resolveWaveformBarWidthPx,
  resolveWaveformCanvasRenderRequestTransition,
  shouldContinueWaveformCanvasRenderJobForPendingCoverage,
  shouldRetainWaveformCanvasSnapshotForRenderStart,
  resolveWaveformContentWidth,
  resolveWaveformDataPlan,
  resolveWaveformDataPlanScopedRequests,
  resolveWaveformDataTileIndexes,
  resolveWaveformDataWindow,
  resolveWaveformHardwareHorizontalWheelDelta,
  resolveWaveformHorizontalPanFrame,
  resolveWaveformPanPresentationTransform,
  resolveWaveformPanPresentationTransition,
  shouldStartWaveformHorizontalPanPresentation,
  resolveWaveformHorizontalScrollLeft,
  resolveWaveformCanvasFrameReusePlan,
  resolveWaveformCanvasRetargetRanges,
  resolveWaveformCanvasDirtyRangesAfterPresentation,
  shouldBeginWaveformCanvasChunkPath,
  resolveWaveformLoadingGridSize,
  resolveWaveformMaximumPixelsPerSecond,
  resolveWaveformMinimumPixelsPerSecond,
  resolveWaveformNextRenderPixelsPerSecond,
  resolveWaveformPeakRange,
  resolveWaveformPixelsPerSecond,
  resolveWaveformPlayheadStyle,
  resolveWaveformPlayheadX,
  resolveWaveformPlayheadCssVariables,
  resolveWaveformPointerAnchorViewportX,
  resolveQueuedWaveformZoomFrame,
  resolveWaveformRenderPixelsPerSecond,
  resolveWaveformRenderScale,
  resolveWaveformResizeViewportState,
  resolveWaveformSelectionDrag,
  resolveWaveformSelectionGeometry,
  resolveWaveformInitialSelectionViewportAnchor,
  resolveWaveformSelectionStartScrollLeft,
  resolveWaveformPlayheadDrag,
  resolveWaveformTileIndexPeakRangeAtPixels,
  resolveWaveformTilePeakRangeAtPixels,
  resolveWaveformTilePeakAtSeconds,
  resolveWaveformTileLoadResultPolicy,
  resolveWaveformTileAvailabilityPresentationPlan,
  resolveWaveformTransaction,
  resolveWaveformWheelAxisDeltas,
  resolveWaveformWheelDeltaX,
  resolveWaveformWheelDeltas,
  resolveWaveformWheelOperation,
  resolveWaveformWheelPanDelta,
  resolveWaveformWheelPixelDeltas,
  resolveWaveformWheelPixelsPerSecond,
  resolveWaveformZoomFrame,
  resolveWaveformZoomOwnedPixelsPerSecond,
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
  const dataSignature = "100(0:track|100.00|0|2048)";
  const visualSignature = [
    overrides.scopeKey ?? "track",
    "#262626",
    overrides.dataPixelsPerSecond ?? 100,
    208,
    viewportWidth * 3,
    1,
    -viewportWidth,
    viewportWidth * 3,
    viewportWidth,
    10_000,
    100_000,
    "",
    800,
    100,
    (overrides.scrollLeft ?? 0).toFixed(3),
    viewportWidth,
    "0.000000",
    "10.000000",
    "1",
    0,
    1_000,
  ].join("|");

  return {
    color: "#262626",
    dataPixelsPerSecond: overrides.dataPixelsPerSecond ?? 100,
    dataSignature,
    geometry: {
      backingHeight: 208,
      backingWidth: viewportWidth * 3,
      devicePixelRatio: 1,
      rasterStartX: -viewportWidth,
      rasterWidth: viewportWidth * 3,
      viewportWidth,
    },
    renderSignature: [dataSignature, visualSignature].join("|"),
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
    visualSignature,
  };
}

function createWaveformCanvasTestContext() {
  return {
    beginPathCount: 0,
    clearRects: [] as { h: number; w: number; x: number; y: number }[],
    drawImageCalls: [] as unknown[][],
    globalAlpha: 0,
    globalCompositeOperation: "",
    imageSmoothingEnabled: true,
    lineCap: "",
    lineWidth: 0,
    moveXValues: [] as number[],
    lineYValues: [] as number[],
    lineToCount: 0,
    moveToCount: 0,
    strokeStyle: "",
    transforms: [] as Array<{ kind: "reset" | "scale" | "translate"; x?: number; y?: number }>,
    strokeCount: 0,
    beginPath() {
      this.beginPathCount += 1;
    },
    clearRect(x: number, y: number, w: number, h: number) {
      this.clearRects.push({ h, w, x, y });
    },
    drawImage(...args: unknown[]) {
      this.drawImageCalls.push(args);
    },
    lineTo(_x: number, y: number) {
      this.lineToCount += 1;
      this.lineYValues.push(y);
    },
    moveTo(x: number) {
      this.moveToCount += 1;
      this.moveXValues.push(x);
    },
    resetTransform() {
      this.transforms.push({ kind: "reset" });
    },
    scale(x: number, y: number) {
      this.transforms.push({ kind: "scale", x, y });
    },
    stroke() {
      this.strokeCount += 1;
    },
    translate(x: number, y: number) {
      this.transforms.push({ kind: "translate", x, y });
    },
  };
}

function createWaveformCanvasStateTestContext() {
  const state = {
    globalAlpha: 0,
    lineCap: "",
    lineWidth: 0,
    strokeStyle: "",
  };

  return {
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(value: number) {
      state.globalAlpha = value;
    },
    get lineCap() {
      return state.lineCap;
    },
    set lineCap(value: string) {
      state.lineCap = value;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(value: number) {
      state.lineWidth = value;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(value: string) {
      state.strokeStyle = value;
    },
    clearRect() {},
    imageSmoothingEnabled: true,
    resetTransform() {},
    scale() {},
    translate() {},
  };
}

function createWaveformCanvasPixelProbeTestCanvas(args: {
  backingHeight: number;
  backingWidth: number;
  boundingWidth?: number;
  opaqueColumns: Array<{ bottomY: number; topY: number; x: number }>;
  parentWidth?: number;
}) {
  const data = new Uint8ClampedArray(args.backingWidth * args.backingHeight * 4);

  for (const column of args.opaqueColumns) {
    const topY = Math.max(0, Math.floor(column.topY));
    const bottomY = Math.min(args.backingHeight, Math.ceil(column.bottomY));
    for (let y = topY; y < bottomY; y += 1) {
      const alphaIndex = (y * args.backingWidth + column.x) * 4 + 3;
      data[alphaIndex] = 255;
    }
  }

  const createReadbackCanvas = () => ({
    height: 0,
    width: 0,
    getContext(type: string, options?: CanvasRenderingContext2DSettings) {
      assert.equal(type, "2d");
      assert.equal(options?.willReadFrequently, true);
      return {
        drawImage() {},
        getImageData(x: number, y: number, width: number, height: number) {
          assert.equal(y, 0);
          const imageData = new Uint8ClampedArray(width * height * 4);
          for (let row = 0; row < height; row += 1) {
            for (let column = 0; column < width; column += 1) {
              const sourceIndex = (row * args.backingWidth + x + column) * 4;
              const targetIndex = (row * width + column) * 4;
              imageData[targetIndex] = data[sourceIndex] ?? 0;
              imageData[targetIndex + 1] = data[sourceIndex + 1] ?? 0;
              imageData[targetIndex + 2] = data[sourceIndex + 2] ?? 0;
              imageData[targetIndex + 3] = data[sourceIndex + 3] ?? 0;
            }
          }

          return {
            data: imageData,
          };
        },
      };
    },
  });

  return {
    height: args.backingHeight,
    ownerDocument: {
      createElement(tagName: string) {
        assert.equal(tagName, "canvas");
        return createReadbackCanvas();
      },
    },
    parentElement:
      args.parentWidth === undefined
        ? null
        : {
            getBoundingClientRect: () => ({
              bottom: args.backingHeight,
              height: args.backingHeight,
              left: 0,
              right: args.parentWidth,
              top: 0,
              width: args.parentWidth,
            }),
          },
    width: args.backingWidth,
    getBoundingClientRect: () => ({
      bottom: args.backingHeight,
      height: args.backingHeight,
      left: 0,
      right: args.boundingWidth ?? args.backingWidth,
      top: 0,
      width: args.boundingWidth ?? args.backingWidth,
    }),
    getContext(type: string, options?: CanvasRenderingContext2DSettings) {
      assert.equal(type, "2d");
      assert.equal(options, undefined);
      return {
        getImageData(x: number, y: number, width: number, height: number) {
          assert.equal(y, 0);
          const imageData = new Uint8ClampedArray(width * height * 4);
          for (let row = 0; row < height; row += 1) {
            for (let column = 0; column < width; column += 1) {
              const sourceIndex = (row * args.backingWidth + x + column) * 4;
              const targetIndex = (row * width + column) * 4;
              imageData[targetIndex] = data[sourceIndex] ?? 0;
              imageData[targetIndex + 1] = data[sourceIndex + 1] ?? 0;
              imageData[targetIndex + 2] = data[sourceIndex + 2] ?? 0;
              imageData[targetIndex + 3] = data[sourceIndex + 3] ?? 0;
            }
          }

          return {
            data: imageData,
          };
        },
      };
    },
  };
}

function createWaveformCanvasTestPlan(overrides: { viewportWidth?: number } = {}) {
  const viewportWidth = overrides.viewportWidth ?? 4;
  const rasterStartX = -viewportWidth;
  const rasterWidth = viewportWidth * 3;
  const tile = {
    max: Array.from({ length: rasterWidth }, () => 64),
    min: Array.from({ length: rasterWidth }, () => -64),
    points_per_second: 100,
    start_px: rasterStartX,
    width_px: rasterWidth,
  };

  return {
    amplitude: 86,
    availableLevels: [100],
    candidateLevels: [
      {
        pixelsPerSecond: 100,
        tileKeysByIndex: new Map([[0, "track|100.00|0|120"]]),
        tilesByIndex: new Map([[0, tile]]),
      },
    ],
    centerY: 104,
    dataPixelsPerSecond: 100,
    geometry: {
      backingHeight: 208,
      backingWidth: rasterWidth,
      devicePixelRatio: 1,
      rasterStartX,
      rasterWidth,
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
      hasAudio: true,
      startSeconds: 0,
    },
    visibleWindow: {
      endPx: viewportWidth,
      startPx: 0,
    },
  };
}

type WaveformCanvasTestCursor = Parameters<typeof drawWaveformCanvasJobChunk>[0]["cursor"];

type WaveformCanvasTestTarget = Parameters<typeof drawWaveformCanvasJobChunk>[0]["target"];

function createWaveformCanvasTestCursor(
  args: {
    progressive?: boolean;
    ranges?: { endX: number; startX: number }[];
    rasterStartX?: number;
    schedule?: "full-density" | "progressive" | "spatial-progressive";
  } = {},
): WaveformCanvasTestCursor {
  const ranges = args.ranges ?? null;
  const firstRange = ranges?.[0] ?? null;
  const schedule = args.schedule ?? (args.progressive === false ? "full-density" : "progressive");

  return {
    drawnRanges: [],
    firstMissingX: null,
    hasDrawnColumn: false,
    lastMissingX: null,
    missingRanges: [],
    missingPeakColumnCount: 0,
    nextX: firstRange?.startX ?? args.rasterStartX ?? 0,
    passIndex: 0,
    ranges,
    rangeIndex: 0,
    retargetRanges: [],
    resolvedPeakColumnCount: 0,
    schedule: ranges ? "full-density" : schedule,
  };
}

function drawCompleteWaveformCanvasTestJob(args: {
  plan: ReturnType<typeof createWaveformCanvasTestPlan>;
  target: WaveformCanvasTestTarget;
}) {
  let cursor = createWaveformCanvasTestCursor({
    rasterStartX: args.plan.geometry.rasterStartX,
  });
  let chunk: ReturnType<typeof drawWaveformCanvasJobChunk> | null = null;
  let guard = 0;

  while (!chunk?.completed) {
    guard += 1;
    assert.ok(guard <= 32, "waveform canvas job should complete");
    chunk = drawWaveformCanvasJobChunk({
      cursor,
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 0,
      plan: args.plan,
      target: args.target,
    });
    cursor = chunk.cursor;
  }

  return chunk;
}

function createWaveformCanvasFastPresentationTestCanvas(
  context: ReturnType<typeof createWaveformCanvasTestContext>,
) {
  return {
    height: 0,
    ownerDocument: {
      createElement(tagName: string) {
        assert.equal(tagName, "canvas");
        const reuseContext = createWaveformCanvasTestContext();
        return {
          height: 0,
          width: 0,
          getContext(type: string) {
            assert.equal(type, "2d");
            return reuseContext;
          },
        };
      },
    },
    style: {
      left: "",
      width: "",
      height: "",
    },
    width: 0,
    getContext(type: string) {
      assert.equal(type, "2d");
      return context;
    },
  } as unknown as HTMLCanvasElement;
}

describe("SpectrumVisualizer", () => {
  test("starts waveform preparation as loading only when a track is present", () => {
    assert.equal(resolveTrackWaveformInitialStatus("C:/music/demo.flac"), "loading");
    assert.equal(resolveTrackWaveformInitialStatus("   "), "idle");
    assert.equal(resolveTrackWaveformInitialStatus(null), "idle");
  });

  test("shares waveform tile cache by normalized file path", () => {
    const first = createWaveformSharedTileCacheForFile({
      filePath: "C:/Music/Demo.flac",
    });
    const second = createWaveformSharedTileCacheForFile({
      filePath: "c:\\music\\demo.flac",
    });
    const other = createWaveformSharedTileCacheForFile({
      filePath: "C:/Music/Other.flac",
    });

    assert.equal(first, second);
    assert.notEqual(first, other);
  });

  test("keeps waveform render data reusable through an external store", () => {
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
      1_680,
    );
  });

  test("clamps zoom bounds from duration and render density", () => {
    const summary = createWaveformTestSummary();

    assert.equal(
      resolveWaveformMinimumPixelsPerSecond({
        durationMs: 10_000,
        viewportWidth: 1_000,
      }),
      1_000 / 14,
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

  test("keeps initial zoom at the minimum until the user changes zoom", () => {
    assert.equal(
      resolveWaveformZoomOwnedPixelsPerSecond({
        durationMs: 8_000,
        maximumPixelsPerSecond: 800,
        ownership: "initial-minimum",
        pixelsPerSecond: 24,
        viewportWidth: 1_000,
      }),
      1_000 / 12,
    );
    assert.equal(
      resolveWaveformZoomOwnedPixelsPerSecond({
        durationMs: 120_000,
        maximumPixelsPerSecond: 800,
        ownership: "initial-minimum",
        pixelsPerSecond: 125,
        viewportWidth: 1_000,
      }),
      12,
    );
    assert.equal(
      resolveWaveformZoomOwnedPixelsPerSecond({
        durationMs: 120_000,
        maximumPixelsPerSecond: 800,
        ownership: "explicit",
        pixelsPerSecond: 125,
        viewportWidth: 1_000,
      }),
      125,
    );
  });

  test("resolves container resize without changing explicit zoom ownership", () => {
    assert.deepEqual(
      resolveWaveformResizeViewportState({
        current: {
          contentWidth: 12_000,
          durationMs: 120_000,
          focusSeconds: null,
          maximumPixelsPerSecond: 800,
          pixelsPerSecond: 125,
          scrollLeft: 400,
          viewportWidth: 1_000,
        },
        viewportWidth: 600,
      }),
      {
        focusSeconds: null,
        pixelsPerSecond: 125,
        scrollLeft: 400,
        viewportWidth: 600,
      },
    );
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

  test("projects horizontal pan as the shared visual inverse transform", () => {
    assert.equal(resolveWaveformPanPresentationTransform(-120), "translate3d(120px, 0, 0)");
    assert.equal(resolveWaveformPanPresentationTransform(120), "translate3d(-120px, 0, 0)");
    assert.equal(resolveWaveformPanPresentationTransform(Number.NaN), "translate3d(0px, 0, 0)");
    assert.equal(
      resolveWaveformPanPresentationTransition(["transform", "width", "left"]),
      [
        "transform 140ms cubic-bezier(0.22, 1, 0.36, 1)",
        "width 140ms cubic-bezier(0.22, 1, 0.36, 1)",
        "left 140ms cubic-bezier(0.22, 1, 0.36, 1)",
      ].join(", "),
    );
  });

  test("starts a shared horizontal pan presentation only for the matching pending pan", () => {
    assert.equal(
      shouldStartWaveformHorizontalPanPresentation({
        hasDirtyRanges: false,
        pendingScrollDeltaPx: 120,
        shiftX: -120,
      }),
      true,
    );
    assert.equal(
      shouldStartWaveformHorizontalPanPresentation({
        hasDirtyRanges: true,
        pendingScrollDeltaPx: 120,
        shiftX: -120,
      }),
      false,
    );
    assert.equal(
      shouldStartWaveformHorizontalPanPresentation({
        hasDirtyRanges: false,
        pendingScrollDeltaPx: 120,
        shiftX: 120,
      }),
      false,
    );
    assert.equal(
      shouldStartWaveformHorizontalPanPresentation({
        hasDirtyRanges: false,
        pendingScrollDeltaPx: null,
        shiftX: -120,
      }),
      false,
    );
    assert.equal(
      shouldStartWaveformHorizontalPanPresentation({
        hasDirtyRanges: false,
        pendingScrollDeltaPx: 120,
        shiftX: Number.NaN,
      }),
      false,
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
        exposedEndX: 2_000,
        exposedStartX: 1_880,
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
        exposedEndX: -880,
        exposedStartX: -1_000,
        kind: "horizontal-pan",
        scrollDeltaPx: -120,
        shiftX: 120,
      },
    );
  });

  test("keeps horizontal pan reusable when prepared guard data enters the viewport", () => {
    const previous = createWaveformTestFrameDescriptor({
      scrollLeft: 1_000,
    });
    const current = {
      ...createWaveformTestFrameDescriptor({
        scrollLeft: 1_120,
      }),
      dataSignature: "100(1:track|100.00|2048|2048)",
    };

    assert.deepEqual(
      resolveWaveformCanvasFrameReusePlan({
        current,
        previous,
      }),
      {
        exposedEndX: 2_000,
        exposedStartX: 1_880,
        kind: "horizontal-pan",
        scrollDeltaPx: 120,
        shiftX: -120,
      },
    );
  });

  test("redraws dirty retained columns when buffered data arrives", () => {
    const previous = createWaveformTestFrameDescriptor({
      scrollLeft: 1_000,
    });
    const current = {
      ...previous,
      dataSignature: "100(0:track|100.00|0|2048,1:track|100.00|2048|2048)",
    };

    assert.deepEqual(
      resolveWaveformCanvasFrameReusePlan({
        current,
        dirtyRanges: [
          {
            endX: 2_000,
            startX: 1_880,
          },
        ],
        previous,
      }),
      {
        dirtyRanges: [
          {
            endX: 2_000,
            startX: 1_880,
          },
        ],
        kind: "dirty-redraw",
      },
    );
  });

  test("reuses the presented waveform frame when the viewport width exposes new columns", () => {
    const previous = createWaveformTestFrameDescriptor({
      scrollLeft: 1_000,
      viewportWidth: 1_000,
    });

    assert.deepEqual(
      resolveWaveformCanvasFrameReusePlan({
        current: createWaveformTestFrameDescriptor({
          scrollLeft: 1_000,
          viewportWidth: 1_240,
        }),
        previous,
      }),
      {
        copySourceStartX: -1_000,
        copyTargetStartX: -1_000,
        copyWidthPx: 3_000,
        exposedRanges: [
          {
            endX: -1_000,
            startX: -1_240,
          },
          {
            endX: 2_480,
            startX: 2_000,
          },
        ],
        kind: "viewport-resize",
        scrollDeltaPx: 0,
      },
    );
    const resizePlan = resolveWaveformCanvasFrameReusePlan({
      current: createWaveformTestFrameDescriptor({
        scrollLeft: 1_120,
        viewportWidth: 1_240,
      }),
      previous,
    });

    assert.deepEqual(resizePlan, {
      copySourceStartX: -1_000,
      copyTargetStartX: -1_120,
      copyWidthPx: 3_000,
      exposedRanges: [
        {
          endX: -1_120,
          startX: -1_240,
        },
        {
          endX: 2_480,
          startX: 1_880,
        },
      ],
      kind: "viewport-resize",
      scrollDeltaPx: 120,
    });
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

  test("absorbs repeated canvas render requests for the same stable frame", () => {
    const current = createWaveformTestFrameDescriptor({
      scrollLeft: 1_000,
    });
    const changedData = {
      ...current,
      dataSignature: "100(0:track|100.00|2048|2048)",
      renderSignature: ["100(0:track|100.00|2048|2048)", current.visualSignature].join("|"),
    };

    assert.equal(
      resolveWaveformCanvasRenderRequestTransition({
        currentJob: null,
        currentPresentedDirtyRanges: [],
        currentPresentedFrame: current,
        currentRequestedFrame: null,
        hasScheduledFrame: false,
        nextFrame: current,
      }),
      "reuse-presented",
    );
    assert.equal(
      resolveWaveformCanvasRenderRequestTransition({
        currentJob: null,
        currentPresentedDirtyRanges: [
          {
            endX: 120,
            startX: 96,
          },
        ],
        currentPresentedFrame: current,
        currentRequestedFrame: null,
        hasScheduledFrame: false,
        nextFrame: current,
      }),
      "start-new",
    );
    assert.equal(
      resolveWaveformCanvasRenderRequestTransition({
        currentJob: current,
        currentPresentedFrame: null,
        currentRequestedFrame: null,
        hasScheduledFrame: false,
        nextFrame: changedData,
      }),
      "retarget-job",
    );
    assert.equal(
      resolveWaveformCanvasRenderRequestTransition({
        currentJob: null,
        currentPresentedFrame: null,
        currentRequestedFrame: current,
        hasScheduledFrame: true,
        nextFrame: changedData,
      }),
      "reuse-scheduled",
    );
    assert.equal(
      resolveWaveformCanvasRenderRequestTransition({
        currentJob: current,
        currentPresentedFrame: current,
        currentRequestedFrame: current,
        hasScheduledFrame: true,
        nextFrame: changedData,
      }),
      "retarget-job",
    );
    assert.equal(
      resolveWaveformCanvasRenderRequestTransition({
        currentJob: null,
        currentPresentedDirtyRanges: [],
        currentPresentedFrame: current,
        currentRequestedFrame: null,
        hasScheduledFrame: false,
        nextFrame: changedData,
      }),
      "start-new",
    );
    assert.equal(
      resolveWaveformCanvasRenderRequestTransition({
        currentJob: null,
        currentPresentedFrame: current,
        currentRequestedFrame: null,
        hasScheduledFrame: false,
        nextFrame: createWaveformTestFrameDescriptor({
          scrollLeft: 1_120,
        }),
      }),
      "start-new",
    );
  });

  test("replaces progressive canvas work when tile coverage advances", () => {
    const current = createWaveformTestFrameDescriptor({
      scrollLeft: 1_000,
    });
    const coverageUpdates = [
      "100(22:track|100.00|45056|2048,23:track|100.00|47104|2048)",
      "100(21:track|100.00|43008|2048,22:track|100.00|45056|2048,23:track|100.00|47104|2048)",
      "100(20:track|100.00|40960|2048,21:track|100.00|43008|2048,22:track|100.00|45056|2048,23:track|100.00|47104|2048)",
    ].map((dataSignature) => ({
      ...current,
      dataSignature,
      renderSignature: [dataSignature, current.visualSignature].join("|"),
    }));

    assert.deepEqual(
      coverageUpdates.map((nextFrame) =>
        resolveWaveformCanvasRenderRequestTransition({
          currentJob: current,
          currentPresentedFrame: null,
          currentRequestedFrame: current,
          hasScheduledFrame: true,
          nextFrame,
        }),
      ),
      ["retarget-job", "retarget-job", "retarget-job"],
    );
    assert.deepEqual(
      coverageUpdates.map((nextFrame) =>
        resolveWaveformCanvasRenderRequestTransition({
          currentJob: current,
          currentPresentedFrame: null,
          currentRequestedFrame: null,
          hasScheduledFrame: false,
          nextFrame,
        }),
      ),
      ["retarget-job", "retarget-job", "retarget-job"],
    );
  });

  test("keeps retargeted progressive work incomplete until retarget ranges are redrawn", () => {
    const context = createWaveformCanvasTestContext();
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 120 });
    const target = {
      canvas: {} as HTMLCanvasElement,
      color: "#262626",
      context: context as unknown as CanvasRenderingContext2D,
      geometry: plan.geometry,
      kind: "visible" as const,
    };
    const firstChunk = drawWaveformCanvasJobChunk({
      cursor: createWaveformCanvasTestCursor({
        rasterStartX: plan.geometry.rasterStartX,
      }),
      deadlineMs: 0,
      now: () => 1,
      plan,
      target,
    });
    const retargetRanges = resolveWaveformCanvasRetargetRanges({
      currentCursor: firstChunk.cursor,
      geometry: plan.geometry,
    });

    assert.equal(firstChunk.cursor.nextX, -118);
    assert.deepEqual(retargetRanges, [
      {
        endX: 237,
        startX: -120,
      },
    ]);

    const completed = drawWaveformCanvasJobChunk({
      cursor: {
        ...firstChunk.cursor,
        retargetRanges,
      },
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 1,
      plan,
      target,
    });

    assert.equal(completed.completed, false);
    assert.equal(
      completed.cursor.missingRanges.reduce((sum, range) => sum + range.endX - range.startX, 0),
      268,
    );
    assert.deepEqual(completed.cursor.missingRanges[0], {
      endX: -118,
      startX: -120,
    });
    assert.deepEqual(completed.cursor.missingRanges.at(-1), {
      endX: 237,
      startX: 235,
    });
  });

  test("removes stale dirty evidence when target-density redraw covers it", () => {
    const geometry = createWaveformCanvasTestPlan({ viewportWidth: 20 }).geometry;

    assert.deepEqual(
      __spectrumVisualizerTestHooks.resolveWaveformCanvasCoverageRangesAfterDraw({
        geometry,
        previousMissingRanges: [
          {
            endX: 10,
            startX: -10,
          },
        ],
        update: {
          drawnRanges: [
            {
              endX: 6,
              startX: -4,
            },
          ],
          missingRanges: [],
        },
      }),
      [
        {
          endX: -4,
          startX: -10,
        },
        {
          endX: 10,
          startX: 6,
        },
      ],
    );
    assert.deepEqual(
      __spectrumVisualizerTestHooks.resolveWaveformCanvasCoverageRangesAfterDraw({
        geometry,
        previousMissingRanges: [
          {
            endX: 10,
            startX: -10,
          },
        ],
        update: {
          drawnRanges: [
            {
              endX: 10,
              startX: -10,
            },
          ],
          missingRanges: [
            {
              endX: 4,
              startX: 2,
            },
          ],
        },
      }),
      [
        {
          endX: 4,
          startX: 2,
        },
      ],
    );
  });

  test("continues dirty completion when pending tile coverage updates the same visual frame", () => {
    const current = createWaveformTestFrameDescriptor({
      scrollLeft: 1_000,
    });
    const changedData = {
      ...current,
      dataSignature: "100(0:track|100.00|0|2048,1:track|100.00|2048|2048)",
      renderSignature: [
        "100(0:track|100.00|0|2048,1:track|100.00|2048|2048)",
        current.visualSignature,
      ].join("|"),
    };

    assert.equal(
      shouldContinueWaveformCanvasRenderJobForPendingCoverage({
        completedDirtyRanges: [
          {
            endX: 120,
            startX: 96,
          },
        ],
        completedFrame: current,
        requestedFrame: changedData,
      }),
      true,
    );
    assert.equal(
      shouldContinueWaveformCanvasRenderJobForPendingCoverage({
        completedDirtyRanges: [],
        completedFrame: current,
        requestedFrame: changedData,
      }),
      false,
    );
    assert.equal(
      shouldContinueWaveformCanvasRenderJobForPendingCoverage({
        completedDirtyRanges: [
          {
            endX: 120,
            startX: 96,
          },
        ],
        completedFrame: changedData,
        completedJobRetargeted: true,
        requestedFrame: changedData,
      }),
      true,
    );
    assert.equal(
      shouldContinueWaveformCanvasRenderJobForPendingCoverage({
        completedDirtyRanges: [
          {
            endX: 120,
            startX: 96,
          },
        ],
        completedFrame: current,
        requestedFrame: createWaveformTestFrameDescriptor({
          scrollLeft: 1_120,
        }),
      }),
      false,
    );
  });

  test("drops reusable canvas proof before a fresh progressive render mutates the canvas", () => {
    assert.equal(
      shouldRetainWaveformCanvasSnapshotForRenderStart({
        presentation: {
          kind: "fresh",
        },
      }),
      false,
    );
    assert.equal(
      shouldRetainWaveformCanvasSnapshotForRenderStart({
        presentation: {
          descriptor: createWaveformTestFrameDescriptor(),
          dirtyRanges: [
            {
              endX: 120,
              startX: 96,
            },
          ],
          kind: "dirty",
        },
      }),
      true,
    );
  });

  test("treats a clean horizontal pan presentation as the completed stable frame", () => {
    const previous = createWaveformTestFrameDescriptor({
      scrollLeft: 1_000,
      viewportWidth: 1_000,
    });
    const current = createWaveformTestFrameDescriptor({
      scrollLeft: 1_120,
      viewportWidth: 1_000,
    });

    assert.deepEqual(
      resolveWaveformCanvasFrameReusePlan({
        current,
        previous,
      }),
      {
        exposedEndX: 2_000,
        exposedStartX: 1_880,
        kind: "horizontal-pan",
        scrollDeltaPx: 120,
        shiftX: -120,
      },
    );
    assert.equal(
      resolveWaveformCanvasRenderRequestTransition({
        currentJob: null,
        currentPresentedDirtyRanges: [],
        currentPresentedFrame: current,
        currentRequestedFrame: current,
        hasScheduledFrame: false,
        nextFrame: current,
      }),
      "reuse-presented",
    );
    assert.equal(
      resolveWaveformCanvasRenderRequestTransition({
        currentJob: null,
        currentPresentedDirtyRanges: [
          {
            endX: 2_000,
            startX: 1_880,
          },
        ],
        currentPresentedFrame: current,
        currentRequestedFrame: current,
        hasScheduledFrame: false,
        nextFrame: current,
      }),
      "start-new",
    );
  });

  test("keeps waveform canvas stroke opacity out of the pixel buffer", () => {
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 120 });
    const context = createWaveformCanvasStateTestContext();
    const canvas = {
      height: plan.geometry.backingHeight,
      style: {},
      width: plan.geometry.backingWidth,
      getContext(type: string) {
        assert.equal(type, "2d");
        return context;
      },
    } as unknown as HTMLCanvasElement;

    const target = __spectrumVisualizerTestHooks.createWaveformCanvasRasterTarget({
      canvas,
      color: "#262626",
      geometry: plan.geometry,
      presentation: {
        kind: "fresh",
      },
    });

    assert.equal(target.kind, "ready");
    assert.equal(context.globalAlpha, 1);
  });

  test("renders new waveform canvas frames from sparse presentation passes to dense completion", () => {
    const context = createWaveformCanvasTestContext();
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 120 });
    const target = {
      canvas: {} as HTMLCanvasElement,
      color: "#262626",
      context: context as unknown as CanvasRenderingContext2D,
      geometry: plan.geometry,
      kind: "visible" as const,
    };
    const firstChunk = drawWaveformCanvasJobChunk({
      cursor: createWaveformCanvasTestCursor({
        rasterStartX: plan.geometry.rasterStartX,
      }),
      deadlineMs: 0,
      now: () => 1,
      plan,
      target,
    });

    assert.equal(firstChunk.completed, false);
    assert.equal(firstChunk.cursor.nextX, -118);
    assert.equal(firstChunk.cursor.passIndex, 1);
    assert.equal(context.beginPathCount, 1);
    assert.equal(context.strokeCount, 1);
    assert.deepEqual(
      context.moveXValues,
      Array.from({ length: 90 }, (_, index) => -119.5 + index * 4),
    );

    const secondChunk = drawWaveformCanvasJobChunk({
      cursor: firstChunk.cursor,
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 1,
      plan,
      target,
    });

    assert.equal(secondChunk.completed, false);
    assert.equal(secondChunk.cursor.nextX, -119);
    assert.equal(secondChunk.cursor.passIndex, 2);
    assert.equal(context.beginPathCount, 2);
    assert.equal(context.strokeCount, 2);
    assert.equal(context.moveToCount, 180);
    assert.equal(context.lineToCount, 180);

    const completed = drawCompleteWaveformCanvasTestJob({
      plan,
      target,
    });
    const drawnColumnIndexes = context.moveXValues.map((x) => Math.floor(x - 0.5));

    assert.equal(completed.completed, true);
    assert.equal(completed.cursor.nextX, 240);
    assert.equal(context.moveToCount, 540);
    assert.equal(new Set(drawnColumnIndexes).size, 360);
    assert.deepEqual(
      [...new Set(drawnColumnIndexes)].sort((left, right) => left - right),
      Array.from({ length: 360 }, (_, index) => index - 120),
    );
  });

  test("renders initial waveform canvas density passes left to right in bounded chunks", () => {
    const context = createWaveformCanvasTestContext();
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 120 });
    const target = {
      canvas: {} as HTMLCanvasElement,
      color: "#262626",
      context: context as unknown as CanvasRenderingContext2D,
      geometry: plan.geometry,
      kind: "visible" as const,
    };
    const firstChunk = drawWaveformCanvasJobChunk({
      cursor: createWaveformCanvasTestCursor({
        rasterStartX: plan.geometry.rasterStartX,
        schedule: "spatial-progressive",
      }),
      deadlineMs: 0,
      now: () => 1,
      plan,
      target,
    });

    assert.equal(firstChunk.completed, false);
    assert.equal(firstChunk.cursor.nextX, 200);
    assert.equal(firstChunk.cursor.passIndex, 0);
    assert.deepEqual(
      context.moveXValues,
      Array.from({ length: 80 }, (_, index) => -119.5 + index * 4),
    );

    const secondChunk = drawWaveformCanvasJobChunk({
      cursor: firstChunk.cursor,
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 1,
      plan,
      target,
    });

    assert.equal(secondChunk.completed, false);
    assert.equal(secondChunk.cursor.nextX, -118);
    assert.equal(secondChunk.cursor.passIndex, 1);
    assert.equal(context.moveToCount, 90);

    const thirdChunk = drawWaveformCanvasJobChunk({
      cursor: secondChunk.cursor,
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 1,
      plan,
      target,
    });

    assert.equal(thirdChunk.completed, false);
    assert.equal(thirdChunk.cursor.nextX, 202);
    assert.equal(thirdChunk.cursor.passIndex, 1);
    assert.equal(context.moveToCount, 170);
  });

  test("keeps column range planning pure before canvas interpretation", () => {
    const context = createWaveformCanvasTestContext();
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 20 });
    const renderPlan = __spectrumVisualizerTestHooks.createWaveformCanvasColumnRangeRenderPlan({
      plan,
      range: {
        endX: 10,
        startX: 0,
      },
    });

    assert.equal(renderPlan.hasColumn, true);
    assert.equal(renderPlan.columnPaths.size, 10);
    assert.equal(context.moveToCount, 0);
    assert.equal(context.lineToCount, 0);
    assert.equal(context.strokeCount, 0);
    assert.deepEqual(context.clearRects, []);
  });

  test("interprets fast presentation redraw through the single canvas effect owner", () => {
    const context = createWaveformCanvasTestContext();
    const previous = createWaveformTestFrameDescriptor({
      scrollLeft: 20,
      viewportWidth: 20,
    });
    const current = {
      ...previous,
      dataSignature: "100(0:track|100.00|0|20)",
      renderSignature: ["100(0:track|100.00|0|20)", previous.visualSignature].join("|"),
    };
    const plan = {
      ...createWaveformCanvasTestPlan({ viewportWidth: 20 }),
      geometry: current.geometry,
      viewport: current.viewport,
    };
    const canvas = createWaveformCanvasFastPresentationTestCanvas(context);
    const result = __spectrumVisualizerTestHooks.presentWaveformCanvasFrameFast({
      canvas,
      descriptor: current,
      descriptorPlan: plan,
      previous,
      previousDirtyRanges: [
        {
          endX: 10,
          startX: 0,
        },
      ],
      reuseFrame: null,
    });

    assert.equal(result.kind, "presented");
    assert.equal(result.mode, "dirty-redraw");
    assert.equal(context.drawImageCalls.length, 1);
    assert.equal(context.moveToCount, 10);
    assert.equal(context.strokeCount, 3);
    assert.deepEqual(result.dirtyRanges, []);
  });

  test("renders horizontal pan refreshes at full density", () => {
    const context = createWaveformCanvasTestContext();
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 120 });
    const target = {
      canvas: {} as HTMLCanvasElement,
      color: "#262626",
      context: context as unknown as CanvasRenderingContext2D,
      geometry: plan.geometry,
      kind: "visible" as const,
    };
    const chunk = drawWaveformCanvasJobChunk({
      cursor: createWaveformCanvasTestCursor({
        progressive: false,
        rasterStartX: plan.geometry.rasterStartX,
      }),
      deadlineMs: 0,
      now: () => 1,
      plan,
      target,
    });

    assert.equal(chunk.completed, false);
    assert.equal(chunk.cursor.nextX, -23);
    assert.equal(chunk.cursor.passIndex, 0);
    assert.equal(context.strokeCount, 1);
    assert.equal(context.moveToCount, 97);
    assert.equal(context.lineToCount, 97);
    assert.deepEqual(
      context.moveXValues.map((x) => Math.floor(x - 0.5)),
      Array.from({ length: 97 }, (_, index) => index - 120),
    );
  });

  test("prioritizes horizontal pan exposed ranges before any full-frame refresh", () => {
    const context = createWaveformCanvasTestContext();
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 120 });
    const target = {
      canvas: {} as HTMLCanvasElement,
      color: "#262626",
      context: context as unknown as CanvasRenderingContext2D,
      geometry: plan.geometry,
      kind: "visible" as const,
    };
    const completed = drawWaveformCanvasJobChunk({
      cursor: createWaveformCanvasTestCursor({
        progressive: false,
        ranges: [
          {
            endX: 120,
            startX: 96,
          },
        ],
      }),
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 1,
      plan,
      target,
    });

    assert.equal(completed.completed, true);
    assert.equal(completed.cursor.nextX, 240);
    assert.equal(completed.cursor.passIndex, 1);
    assert.equal(context.moveToCount, 24);
    assert.deepEqual(
      context.moveXValues.map((x) => Math.floor(x - 0.5)),
      Array.from({ length: 24 }, (_, index) => index + 96),
    );
  });

  test("carries unfinished horizontal pan dirty ranges across viewport resize", () => {
    const previous = createWaveformTestFrameDescriptor({
      scrollLeft: 1_000,
      viewportWidth: 1_000,
    });

    const resizePlan = resolveWaveformCanvasFrameReusePlan({
      current: createWaveformTestFrameDescriptor({
        scrollLeft: 1_120,
        viewportWidth: 1_240,
      }),
      previous,
    });

    assert.deepEqual(resizePlan, {
      copySourceStartX: -1_000,
      copyTargetStartX: -1_120,
      copyWidthPx: 3_000,
      exposedRanges: [
        {
          endX: -1_120,
          startX: -1_240,
        },
        {
          endX: 2_480,
          startX: 1_880,
        },
      ],
      kind: "viewport-resize",
      scrollDeltaPx: 120,
    });
    assert.equal(resizePlan.kind, "viewport-resize");
    if (resizePlan.kind !== "viewport-resize") {
      return;
    }
    assert.deepEqual(
      resolveWaveformCanvasDirtyRangesAfterPresentation({
        exposedRanges: resizePlan.exposedRanges,
        geometry: createWaveformTestFrameDescriptor({
          scrollLeft: 1_120,
          viewportWidth: 1_240,
        }).geometry,
        plan: resizePlan,
        previousDirtyRanges: [
          {
            endX: 1_000,
            startX: 996,
          },
        ],
      }),
      [
        {
          endX: -1_120,
          startX: -1_240,
        },
        {
          endX: 880,
          startX: 876,
        },
        {
          endX: 2_480,
          startX: 1_880,
        },
      ],
    );

    const context = createWaveformCanvasTestContext();
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 1_240 });
    const target = {
      canvas: {} as HTMLCanvasElement,
      color: "#262626",
      context: context as unknown as CanvasRenderingContext2D,
      geometry: plan.geometry,
      kind: "visible" as const,
    };
    const firstChunk = drawWaveformCanvasJobChunk({
      cursor: createWaveformCanvasTestCursor({
        progressive: false,
        ranges: [
          {
            endX: 1_240,
            startX: 876,
          },
        ],
      }),
      deadlineMs: 0,
      now: () => 1,
      plan,
      target,
    });

    assert.equal(firstChunk.completed, false);
    assert.equal(firstChunk.cursor.nextX, 973);
    assert.deepEqual(
      context.moveXValues.slice(0, 4).map((x) => Math.floor(x - 0.5)),
      [876, 877, 878, 879],
    );
  });

  test("keeps every progressive waveform chunk immediately presentable", () => {
    assert.equal(
      shouldBeginWaveformCanvasChunkPath({
        hasColumn: true,
        startX: 120,
      }),
      true,
    );
    assert.equal(
      shouldBeginWaveformCanvasChunkPath({
        hasColumn: true,
        startX: -120,
      }),
      true,
    );
    assert.equal(
      shouldBeginWaveformCanvasChunkPath({
        hasColumn: false,
        startX: -120,
      }),
      false,
    );
    assert.equal(
      shouldStrokeWaveformCanvasChunkPath({
        completed: false,
        cursorHasDrawnColumn: true,
        hasChunkColumn: true,
      }),
      true,
    );
    assert.equal(
      shouldStrokeWaveformCanvasChunkPath({
        completed: true,
        cursorHasDrawnColumn: true,
        hasChunkColumn: true,
      }),
      true,
    );
  });

  test("draws visual padding as a zero waveform without requiring tile data", () => {
    const context = createWaveformCanvasTestContext();
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 20 });
    const visualPaddingPlan = {
      ...plan,
      candidateLevels: [],
      viewport: {
        ...plan.viewport,
        durationMs: 120_000,
        scrollLeft: 0,
      },
      visibleSecondsWindow: {
        endSeconds: 0,
        hasAudio: false,
        startSeconds: 0,
      },
      visibleWindow: {
        endPx: 0,
        startPx: 0,
      },
    };
    const target = {
      canvas: {} as HTMLCanvasElement,
      color: "#262626",
      context: context as unknown as CanvasRenderingContext2D,
      geometry: plan.geometry,
      kind: "visible" as const,
    };
    const chunk = drawCompleteWaveformCanvasTestJob({
      plan: visualPaddingPlan,
      target,
    });

    assert.equal(chunk.completed, true);
    assert.equal(chunk.missingPeakColumns, 0);
    assert.equal(chunk.cursor.resolvedPeakColumnCount, 60);
    assert.equal(context.moveToCount, 60);
    assert.equal(context.strokeCount, 3);
    assert.ok(context.lineYValues.every((y) => y === 105));
  });

  test("keeps fallback-density waveform columns dirty until target density arrives", () => {
    const context = createWaveformCanvasTestContext();
    const basePlan = createWaveformCanvasTestPlan({ viewportWidth: 20 });
    const geometry = {
      ...basePlan.geometry,
      backingWidth: 20,
      rasterStartX: 0,
      rasterWidth: 20,
    };
    const fallbackTile = {
      max: Array.from({ length: 20 }, () => 64),
      min: Array.from({ length: 20 }, () => -64),
      points_per_second: 50,
      start_px: 0,
      width_px: 20,
    };
    const plan = {
      ...basePlan,
      candidateLevels: [
        {
          pixelsPerSecond: 100,
          tileKeysByIndex: new Map<number, string>(),
          tilesByIndex: new Map(),
        },
        {
          pixelsPerSecond: 50,
          tileKeysByIndex: new Map([[0, "track|50.00|0|20"]]),
          tilesByIndex: new Map([[0, fallbackTile]]),
        },
      ],
      geometry,
      viewport: {
        ...basePlan.viewport,
        contentWidth: 20,
        pixelsPerSecond: 50,
        scrollLeft: 100,
        viewportWidth: 20,
      },
      visibleSecondsWindow: {
        endSeconds: 0.2,
        hasAudio: true,
        startSeconds: 0,
      },
      visibleWindow: {
        endPx: 20,
        startPx: 0,
      },
    };
    const draw = drawWaveformCanvasColumnRange({
      plan,
      range: {
        endX: 10,
        startX: 0,
      },
      target: {
        canvas: {} as HTMLCanvasElement,
        color: "#262626",
        context: context as unknown as CanvasRenderingContext2D,
        geometry,
        kind: "visible",
      },
    });

    assert.equal(draw.hasColumn, true);
    assert.equal(context.moveToCount, 10);
    assert.equal(draw.missingPeakColumns, 10);
    assert.deepEqual(draw.missingRanges, [
      {
        endX: 10,
        startX: 0,
      },
    ]);
  });

  test("keeps partially covered target-density waveform columns dirty", () => {
    const context = createWaveformCanvasTestContext();
    const basePlan = createWaveformCanvasTestPlan({ viewportWidth: 20 });
    const geometry = {
      ...basePlan.geometry,
      backingWidth: 20,
      rasterStartX: 0,
      rasterWidth: 20,
    };
    const partialTargetTile = {
      max: [127],
      min: [-127],
      points_per_second: 100,
      start_px: 0,
      width_px: 1,
    };
    const plan = {
      ...basePlan,
      candidateLevels: [
        {
          pixelsPerSecond: 100,
          tileKeysByIndex: new Map([[0, "track|100.00|0|1"]]),
          tilesByIndex: new Map([[0, partialTargetTile]]),
        },
      ],
      geometry,
      viewport: {
        ...basePlan.viewport,
        contentWidth: 20,
        pixelsPerSecond: 50,
        scrollLeft: 100,
        viewportWidth: 20,
      },
      visibleSecondsWindow: {
        endSeconds: 0.2,
        hasAudio: true,
        startSeconds: 0,
      },
      visibleWindow: {
        endPx: 20,
        startPx: 0,
      },
    };
    const draw = drawWaveformCanvasColumnRange({
      plan,
      range: {
        endX: 1,
        startX: 0,
      },
      target: {
        canvas: {} as HTMLCanvasElement,
        color: "#262626",
        context: context as unknown as CanvasRenderingContext2D,
        geometry,
        kind: "visible",
      },
    });

    assert.equal(draw.hasColumn, true);
    assert.equal(context.moveToCount, 1);
    assert.equal(draw.missingPeakColumns, 1);
    assert.deepEqual(draw.missingRanges, [
      {
        endX: 1,
        startX: 0,
      },
    ]);
  });

  test("keeps progressively drawn fallback columns dirty after completion", () => {
    const context = createWaveformCanvasTestContext();
    const basePlan = createWaveformCanvasTestPlan({ viewportWidth: 8 });
    const geometry = {
      ...basePlan.geometry,
      backingWidth: 8,
      rasterStartX: 0,
      rasterWidth: 8,
    };
    const fallbackTile = {
      max: Array.from({ length: 8 }, () => 64),
      min: Array.from({ length: 8 }, () => -64),
      points_per_second: 50,
      start_px: 0,
      width_px: 8,
    };
    const plan = {
      ...basePlan,
      candidateLevels: [
        {
          pixelsPerSecond: 50,
          tileKeysByIndex: new Map([[0, "track|50.00|0|8"]]),
          tilesByIndex: new Map([[0, fallbackTile]]),
        },
      ],
      geometry,
      viewport: {
        ...basePlan.viewport,
        contentWidth: 8,
        scrollLeft: 200,
        viewportWidth: 8,
      },
      visibleSecondsWindow: {
        endSeconds: 0.08,
        hasAudio: true,
        startSeconds: 0,
      },
      visibleWindow: {
        endPx: 8,
        startPx: 0,
      },
    };
    const target = {
      canvas: {} as HTMLCanvasElement,
      color: "#262626",
      context: context as unknown as CanvasRenderingContext2D,
      geometry,
      kind: "visible" as const,
    };
    const completed = drawCompleteWaveformCanvasTestJob({
      plan,
      target,
    });

    assert.equal(completed.completed, true);
    assert.equal(context.moveToCount, 8);
    assert.equal(completed.cursor.missingPeakColumnCount, 8);
    assert.deepEqual(completed.cursor.missingRanges, [
      {
        endX: 8,
        startX: 0,
      },
    ]);
  });

  test("keeps waveform frame identity stable when unused prefetch levels arrive", () => {
    const current = createWaveformTestFrameDescriptor({
      scrollLeft: 1_000,
    });
    const withPrefetchOnly = {
      ...current,
      dataSignature: current.dataSignature,
      renderSignature: [current.dataSignature, current.visualSignature].join("|"),
    };

    assert.equal(
      resolveWaveformCanvasRenderRequestTransition({
        currentJob: null,
        currentPresentedDirtyRanges: [],
        currentPresentedFrame: current,
        currentRequestedFrame: current,
        hasScheduledFrame: false,
        nextFrame: withPrefetchOnly,
      }),
      "reuse-presented",
    );
  });

  test("clears dirty waveform columns before replacing fallback-density pixels", () => {
    const context = createWaveformCanvasTestContext();
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 20 });

    clearWaveformCanvasColumnRanges({
      context: context as unknown as CanvasRenderingContext2D,
      geometry: plan.geometry,
      ranges: [
        {
          endX: 4,
          startX: 0,
        },
        {
          endX: 8,
          startX: 3,
        },
        {
          endX: 200,
          startX: 100,
        },
      ],
    });

    assert.deepEqual(context.clearRects, [
      {
        h: 208,
        w: 8,
        x: 0,
        y: 0,
      },
    ]);
  });

  test("clears only the dirty waveform chunk being replaced", () => {
    const context = createWaveformCanvasTestContext();
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 120 });
    const target = {
      canvas: {} as HTMLCanvasElement,
      color: "#262626",
      context: context as unknown as CanvasRenderingContext2D,
      geometry: plan.geometry,
      kind: "visible" as const,
    };
    const chunk = drawWaveformCanvasJobChunk({
      cursor: createWaveformCanvasTestCursor({
        progressive: false,
        ranges: [
          {
            endX: -10,
            startX: -120,
          },
        ],
      }),
      deadlineMs: 0,
      now: () => 1,
      plan,
      replaceExistingColumns: true,
      target,
    });

    assert.equal(chunk.completed, false);
    assert.equal(chunk.cursor.nextX, -23);
    assert.deepEqual(context.clearRects, [
      {
        h: 208,
        w: 97,
        x: -120,
        y: 0,
      },
    ]);
  });

  test("does not clear dirty waveform gaps that cannot be redrawn yet", () => {
    const context = createWaveformCanvasTestContext();
    const basePlan = createWaveformCanvasTestPlan({ viewportWidth: 8 });
    const geometry = {
      ...basePlan.geometry,
      backingWidth: 8,
      rasterStartX: 0,
      rasterWidth: 8,
    };
    const partialTargetTile = {
      max: [64, 64],
      min: [-64, -64],
      points_per_second: 100,
      start_px: 0,
      width_px: 2,
    };
    const plan = {
      ...basePlan,
      candidateLevels: [
        {
          pixelsPerSecond: 100,
          tileKeysByIndex: new Map([[0, "track|100.00|0|2"]]),
          tilesByIndex: new Map([[0, partialTargetTile]]),
        },
      ],
      geometry,
      viewport: {
        ...basePlan.viewport,
        contentWidth: 8,
        pixelsPerSecond: 50,
        scrollLeft: 100,
        viewportWidth: 8,
      },
    };
    const target = {
      canvas: {} as HTMLCanvasElement,
      color: "#262626",
      context: context as unknown as CanvasRenderingContext2D,
      geometry,
      kind: "visible" as const,
    };
    const draw = drawWaveformCanvasColumnRange({
      plan,
      range: {
        endX: 8,
        startX: 0,
      },
      replaceExistingColumns: true,
      target,
    });

    assert.equal(draw.hasColumn, true);
    assert.equal(draw.missingPeakColumns, 8);
    assert.deepEqual(context.clearRects, [
      {
        h: 208,
        w: 1,
        x: 0,
        y: 0,
      },
    ]);
  });

  test("samples visible canvas pixels independently from renderer completion state", () => {
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 4 });
    const expectedTopY = 104;
    const expectedBottomY = 105;
    const canvas = createWaveformCanvasPixelProbeTestCanvas({
      backingHeight: plan.geometry.backingHeight,
      backingWidth: plan.geometry.backingWidth,
      opaqueColumns: [
        {
          bottomY: expectedBottomY,
          topY: expectedTopY,
          x: 4,
        },
        {
          bottomY: expectedBottomY,
          topY: expectedTopY,
          x: 5,
        },
        {
          bottomY: 120,
          topY: 100,
          x: 6,
        },
      ],
    });
    const probe = __spectrumVisualizerTestHooks.createWaveformCanvasPixelColumnProbe({
      canvas: canvas as unknown as HTMLCanvasElement,
      plan,
    });

    assert.deepEqual(probe?.counts, {
      "blank-without-plan-data": 0,
      "drawn-fallback-density": 0,
      "drawn-target-covered": 3,
      "drawn-target-undercovered": 0,
      "drawn-without-plan-data": 0,
      "target-density-blank": 9,
    });
    assert.deepEqual(probe?.windows.configuredViewport.counts, {
      "blank-without-plan-data": 0,
      "drawn-fallback-density": 0,
      "drawn-target-covered": 3,
      "drawn-target-undercovered": 0,
      "drawn-without-plan-data": 0,
      "target-density-blank": 1,
    });
    assert.equal(probe?.firstNonTargetX, -4);
    assert.equal(probe?.lastNonTargetX, 7);
    assert.equal(probe?.windows.configuredViewport.firstNonTargetX, 3);
    assert.equal(probe?.windows.configuredViewport.lastNonTargetX, 3);
    assert.equal(probe?.visibleColumns.length, 12);
  });

  test("separates DOM visible canvas pixels from the configured viewport width", () => {
    const plan = createWaveformCanvasTestPlan({ viewportWidth: 4 });
    const expectedTopY = 104;
    const expectedBottomY = 105;
    const canvas = createWaveformCanvasPixelProbeTestCanvas({
      backingHeight: plan.geometry.backingHeight,
      backingWidth: plan.geometry.backingWidth,
      boundingWidth: plan.geometry.rasterWidth,
      opaqueColumns: [
        {
          bottomY: expectedBottomY,
          topY: expectedTopY,
          x: 4,
        },
        {
          bottomY: expectedBottomY,
          topY: expectedTopY,
          x: 5,
        },
      ],
      parentWidth: 6,
    });
    const probe = __spectrumVisualizerTestHooks.createWaveformCanvasPixelColumnProbe({
      canvas: canvas as unknown as HTMLCanvasElement,
      plan,
    });

    assert.deepEqual(probe?.windows.configuredViewport, {
      counts: {
        "blank-without-plan-data": 0,
        "drawn-fallback-density": 0,
        "drawn-target-covered": 2,
        "drawn-target-undercovered": 0,
        "drawn-without-plan-data": 0,
        "target-density-blank": 2,
      },
      endX: 4,
      firstNonTargetX: 2,
      lastNonTargetX: 3,
      sampleCount: 4,
      source: "configured-viewport",
      startX: 0,
    });
    assert.deepEqual(probe?.windows.domVisible, {
      counts: {
        "blank-without-plan-data": 0,
        "drawn-fallback-density": 0,
        "drawn-target-covered": 2,
        "drawn-target-undercovered": 0,
        "drawn-without-plan-data": 0,
        "target-density-blank": 4,
      },
      endX: 2,
      firstNonTargetX: -4,
      lastNonTargetX: -1,
      sampleCount: 6,
      source: "dom-visible",
      startX: -4,
    });
    assert.deepEqual(
      probe?.visibleColumns.map((column) => ({
        opaquePixelCount: column.opaquePixelCount,
        status: column.status,
        x: column.x,
      })),
      [
        { opaquePixelCount: 0, status: "target-density-blank", x: -4 },
        { opaquePixelCount: 0, status: "target-density-blank", x: -3 },
        { opaquePixelCount: 0, status: "target-density-blank", x: -2 },
        { opaquePixelCount: 1, status: "target-density-blank", x: -1 },
        { opaquePixelCount: 2, status: "drawn-target-covered", x: 0 },
        { opaquePixelCount: 2, status: "drawn-target-covered", x: 1 },
      ],
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
      interaction: "horizontal-pan",
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

    assert.equal(frame.anchorVisualSeconds, 10);
    assert.equal(frame.focusSeconds, 8);
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
      endX: 1_540,
      isComplete: true,
      startX: 140,
    });
    assert.equal(changedSelectionScopeKey, baseScopeKey);
  });

  test("keeps equivalent waveform selections stable during local drag previews", () => {
    assert.equal(areWaveformSelectionsEqual(null, null), true);
    assert.equal(
      areWaveformSelectionsEqual(
        {
          end: 80,
          start: 10,
        },
        {
          end: 80,
          start: 10,
        },
      ),
      true,
    );
    assert.equal(
      areWaveformSelectionsEqual(
        {
          end: 80,
          start: 10,
        },
        {
          end: 80,
          start: 10.25,
        },
      ),
      false,
    );
    assert.equal(
      areWaveformSelectionsEqual(null, {
        end: 80,
        start: 10,
      }),
      false,
    );
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
        start: 13.35,
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

  test("keeps selection boundary drags inside real audio when the pointer enters visual padding", () => {
    const viewport = {
      contentWidth: 12_400,
      durationMs: 120_000,
      focusSeconds: null,
      maximumPixelsPerSecond: 800,
      pixelsPerSecond: 100,
      scrollLeft: 0,
      viewportWidth: 1_000,
    };

    assert.deepEqual(
      resolveWaveformSelectionDrag({
        edge: "start",
        hostRect: { left: 0 },
        pointerClientX: 50,
        selection: {
          end: 80,
          start: 10,
        },
        viewport,
      }),
      {
        end: 80,
        start: 0,
      },
    );
    assert.deepEqual(
      resolveWaveformSelectionDrag({
        edge: "end",
        hostRect: { left: 0 },
        pointerClientX: 12_350,
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
        start: 0,
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
      focusSeconds: 24,
      pixelsPerSecond: 200,
      scrollLeft: 4_350,
      summary,
      tileWidth: 1_000,
      viewportWidth: 1_000,
    });

    assert.deepEqual(plan.visibleIndexes, [3, 4]);
    assert.equal(plan.requests[0]?.priority, "visible");
    assert.ok(
      plan.requests.findIndex((request) => request.priority === "visible-guard") <
        plan.requests.findIndex((request) => request.priority === "prefetch-focus"),
    );
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
    assert.deepEqual(visiblePrefetchLevels, [400, 400]);
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

  test("keeps same-scope pan prefetch results available without forcing presentation", () => {
    const presentationKeys = new Set(["track|100.00|2048|2048"]);

    assert.deepEqual(
      resolveWaveformTileLoadResultPolicy({
        activeScopeKey: "track",
        presentationRequestKeys: presentationKeys,
        requestCacheKey: "track|100.00|4096|2048",
        requestScopeKey: "track",
      }),
      {
        shouldCache: true,
        shouldRequestPresentation: false,
      },
    );
    assert.deepEqual(
      resolveWaveformTileLoadResultPolicy({
        activeScopeKey: "track",
        presentationRequestKeys: presentationKeys,
        requestCacheKey: "track|100.00|2048|2048",
        requestScopeKey: "track",
      }),
      {
        shouldCache: true,
        shouldRequestPresentation: true,
      },
    );
    assert.deepEqual(
      resolveWaveformTileLoadResultPolicy({
        activeScopeKey: "other-track",
        presentationRequestKeys: presentationKeys,
        requestCacheKey: "track|100.00|2048|2048",
        requestScopeKey: "track",
      }),
      {
        shouldCache: false,
        shouldRequestPresentation: false,
      },
    );
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
    assert.deepEqual(plan.visibleIndexes, [0, 1]);
    assert.deepEqual(
      plan.requests.map((request) => request.priority),
      ["visible", "visible", "visible-guard"],
    );
    assert.deepEqual(plan.overscanSecondsWindow, plan.visibleSecondsWindow);
    assert.deepEqual(plan.overscanWindow, plan.visibleWindow);
  });

  test("prepares full-density guard data outside the viewport during horizontal pan", () => {
    const summary = createWaveformTestSummary();
    const plan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/music/demo.flac",
      focusSeconds: 6,
      interaction: "horizontal-pan",
      mode: "interactive",
      pixelsPerSecond: 100,
      scrollLeft: 3_000,
      summary,
      tileWidth: 1_000,
      viewportWidth: 1_000,
    });
    const visibleRequests = resolveWaveformDataPlanScopedRequests(plan, "visible");

    assert.deepEqual(plan.visibleIndexes, [2, 3]);
    assert.deepEqual(plan.visibleWindow, {
      endPx: 3_800,
      startPx: 2_800,
    });
    assert.deepEqual(plan.overscanWindow, plan.visibleWindow);
    assert.deepEqual(
      plan.requests.map((request) => request.priority),
      ["visible", "visible", "visible-guard", "visible-guard", "visible-guard"],
    );
    assert.deepEqual(
      visibleRequests.map((request) => request.index),
      [2, 3, 1, 4, 5],
    );
  });

  test("prepares the retained canvas band on settled mount before it enters the viewport", () => {
    const summary = createWaveformTestSummary();
    const plan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/music/demo.flac",
      focusSeconds: 6,
      mode: "settled",
      pixelsPerSecond: 100,
      scrollLeft: 3_000,
      summary,
      tileWidth: 1_000,
      viewportWidth: 1_000,
    });
    const visibleRequests = resolveWaveformDataPlanScopedRequests(plan, "visible");
    const currentDensityRequests = visibleRequests.filter(
      (request) => request.dataPixelsPerSecond === plan.dataPixelsPerSecond,
    );

    assert.deepEqual(plan.visibleIndexes, [2, 3]);
    assert.deepEqual(
      currentDensityRequests.map((request) => [request.index, request.priority]),
      [
        [2, "visible"],
        [3, "visible"],
        [1, "visible-guard"],
        [4, "visible-guard"],
      ],
    );
  });

  test("keeps visible data empty when the viewport is fully inside visual padding", () => {
    const leftPlan = resolveWaveformDataPlan({
      contentWidth: 12_400,
      filePath: "C:/music/demo.flac",
      focusSeconds: 0,
      pixelsPerSecond: 100,
      scrollLeft: 0,
      summary: createWaveformTestSummary(),
      tileWidth: 1_000,
      viewportWidth: 100,
    });
    const rightPlan = resolveWaveformDataPlan({
      contentWidth: 12_400,
      filePath: "C:/music/demo.flac",
      focusSeconds: 120,
      pixelsPerSecond: 100,
      scrollLeft: 12_300,
      summary: createWaveformTestSummary(),
      tileWidth: 1_000,
      viewportWidth: 100,
    });

    assert.deepEqual(leftPlan.visibleSecondsWindow, {
      endSeconds: 0,
      hasAudio: false,
      startSeconds: 0,
    });
    assert.deepEqual(leftPlan.visibleWindow, {
      endPx: 0,
      startPx: 0,
    });
    assert.deepEqual(leftPlan.visibleIndexes, []);
    assert.deepEqual(resolveWaveformDataPlanScopedRequests(leftPlan, "visible"), []);
    assert.deepEqual(rightPlan.visibleSecondsWindow, {
      endSeconds: 120,
      hasAudio: false,
      startSeconds: 120,
    });
    assert.deepEqual(rightPlan.visibleWindow, {
      endPx: 0,
      startPx: 0,
    });
    assert.deepEqual(rightPlan.visibleIndexes, []);
    assert.deepEqual(resolveWaveformDataPlanScopedRequests(rightPlan, "visible"), []);
  });

  test("requests only the real audio intersection when the viewport crosses visual padding", () => {
    const summary = createWaveformTestSummary();
    const leftPlan = resolveWaveformDataPlan({
      contentWidth: 12_400,
      filePath: "C:/music/demo.flac",
      focusSeconds: 0,
      mode: "interactive",
      pixelsPerSecond: 100,
      scrollLeft: 150,
      summary,
      tileWidth: 1_000,
      viewportWidth: 100,
    });
    const rightPlan = resolveWaveformDataPlan({
      contentWidth: 12_400,
      filePath: "C:/music/demo.flac",
      focusSeconds: 120,
      mode: "interactive",
      pixelsPerSecond: 100,
      scrollLeft: 12_150,
      summary,
      tileWidth: 1_000,
      viewportWidth: 100,
    });

    assert.deepEqual(leftPlan.visibleSecondsWindow, {
      endSeconds: 0.5,
      hasAudio: true,
      startSeconds: 0,
    });
    assert.deepEqual(leftPlan.visibleWindow, {
      endPx: 50,
      startPx: 0,
    });
    assert.deepEqual(leftPlan.visibleIndexes, [0]);
    assert.ok(leftPlan.requests.every((request) => request.startPx >= 0));
    assert.deepEqual(rightPlan.visibleSecondsWindow, {
      endSeconds: 120,
      hasAudio: true,
      startSeconds: 119.5,
    });
    assert.deepEqual(rightPlan.visibleWindow, {
      endPx: 12_000,
      startPx: 11_950,
    });
    assert.deepEqual(rightPlan.visibleIndexes, [11]);
    assert.ok(rightPlan.requests.every((request) => request.endPx <= 12_000));
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

  test("resolves tile arrival presentation from the current viewport plan", () => {
    const summary = createWaveformTestSummary();
    const stalePlan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/Music/track.wav",
      focusSeconds: 5,
      interaction: "horizontal-pan",
      mode: "interactive",
      pixelsPerSecond: 100,
      scrollLeft: 500,
      summary,
      viewportWidth: 1_000,
    });
    const currentPlan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/Music/track.wav",
      focusSeconds: 5,
      interaction: "horizontal-pan",
      mode: "interactive",
      pixelsPerSecond: 100,
      scrollLeft: 2_500,
      summary,
      viewportWidth: 1_000,
    });
    const accepted = resolveWaveformTileAvailabilityPresentationPlan({
      currentPlan,
      signal: {
        scopeKey: stalePlan.scopeKey,
      },
    });

    assert.equal(accepted, currentPlan);
    assert.notEqual(accepted, stalePlan);
    assert.equal(accepted?.visibleSecondsWindow.startSeconds, 23);
  });

  test("ignores tile arrival from a stale waveform scope", () => {
    const summary = createWaveformTestSummary();
    const currentPlan = resolveWaveformDataPlan({
      contentWidth: 12_000,
      filePath: "C:/Music/track.wav",
      focusSeconds: 5,
      mode: "interactive",
      pixelsPerSecond: 100,
      scrollLeft: 500,
      summary,
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
      resolveWaveformTileAvailabilityPresentationPlan({
        currentPlan: null,
        signal: {
          scopeKey: currentPlan.scopeKey,
        },
      }),
      null,
    );
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
    assert.equal(first.anchorVisualSeconds, 10);
    assert.equal(first.focusSeconds, 8);
    assert.equal(second.anchorVisualSeconds, 10);
    assert.equal(second.focusSeconds, 8);
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
    assert.equal(cancelled.anchorVisualSeconds, 10);
    assert.equal(cancelled.focusSeconds, 8);
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
      450,
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

  test("maps playback position from playback request start into the full waveform", () => {
    assert.equal(
      resolveWaveformPlayheadX({
        playbackStartMs: 20_000,
        pixelsPerSecond: 100,
        positionMs: 5_000,
        scrollLeft: 1_904,
      }),
      796,
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
      796,
    );
    assert.equal(
      resolveWaveformPlayheadX({
        playbackStartMs: 25_000,
        pixelsPerSecond: 100,
        positionMs: 5_000,
        scrollLeft: 1_904,
      }),
      1_296,
    );
  });

  test("hides the playhead when a playback status cannot provide a position origin", () => {
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
  });

  test("clamps playback playhead drags to the current editable selection", () => {
    const resolution = resolveWaveformPlayheadDrag({
      hostRect: {
        left: 10,
        width: 4_000,
      },
      pointerClientX: 5_000,
      selection: {
        end: 40,
        start: 20,
      },
      viewport: {
        contentWidth: 12_000,
        durationMs: 120_000,
        focusSeconds: null,
        maximumPixelsPerSecond: 800,
        pixelsPerSecond: 100,
        scrollLeft: 1_904,
        viewportWidth: 1_000,
      },
    });

    assert.deepEqual(resolution, {
      endMs: 40_000,
      positionMs: 40_000,
    });
  });

  test("rejects playback playhead drags without a complete editable selection", () => {
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
        viewport: {
          contentWidth: 12_000,
          durationMs: 120_000,
          focusSeconds: null,
          maximumPixelsPerSecond: 800,
          pixelsPerSecond: 100,
          scrollLeft: 0,
          viewportWidth: 1_000,
        },
      }),
      null,
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
          track_end_ms: 40_000,
          track_start_ms: 20_000,
        },
      }),
      20_000,
    );
  });

  test("prefers playback request duration over stale player duration", () => {
    assert.equal(
      resolvePlaybackSnapshotDurationMs({
        fallbackDurationMs: 120_000,
        snapshot: {
          duration_ms: 120_000,
          music_url: "https://example.com/demo",
          path: "C:/music/demo.flac",
          paused: true,
          playback_end_ms: 40_000,
          playback_start_ms: 25_000,
          playing: true,
          playlist_name: "Focus",
          position_ms: 2_000,
          received_at_ms: 100,
          track_end_ms: 40_000,
          track_start_ms: 20_000,
        },
      }),
      15_000,
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
      1_700,
    );
    assert.equal(
      resolveAnchoredWaveformScrollLeft({
        anchorSeconds: 20,
        anchorViewportX: 250,
        contentWidth: 5_000,
        pixelsPerSecond: 100,
        viewportWidth: 1_000,
      }),
      1_950,
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

  test("keeps initial selection viewport anchoring owned by the external committed selection", () => {
    const firstAnchor = resolveWaveformInitialSelectionViewportAnchor({
      cacheKey: "track",
      filePath: "C:/music/demo.flac",
      previousAnchorKey: null,
      selection: {
        end: 80,
        start: 20,
      },
      status: "ready",
    });

    assert.equal(firstAnchor?.anchorKey, "c:/music/demo.flac|track");
    assert.deepEqual(firstAnchor?.selection, {
      end: 80,
      start: 20,
    });
    assert.equal(
      resolveWaveformInitialSelectionViewportAnchor({
        cacheKey: "track",
        filePath: "C:/music/demo.flac",
        previousAnchorKey: firstAnchor?.anchorKey ?? null,
        selection: {
          end: 80,
          start: 30,
        },
        status: "ready",
      }),
      null,
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
