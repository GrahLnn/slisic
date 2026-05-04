import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TrackWaveformSummary } from "@/src/cmd";
import {
  clampWaveformZoomDeltaY,
  createWaveformDataRequestKey,
  createWaveformDataScopeKey,
  handleWaveformViewportWheel,
  normalizeWaveformPathKey,
  resolveAnchoredWaveformScrollLeft,
  resolveCenteredWaveformScrollLeft,
  resolvePlaybackPositionMs,
  resolveQuantizedWaveformDisplayPeak,
  resolveTrackWaveformInitialStatus,
  resolveWaveformBarWidthPx,
  resolveWaveformContentWidth,
  resolveWaveformDataPlan,
  resolveWaveformDataTileIndexes,
  resolveWaveformDataWindow,
  resolveWaveformHardwareHorizontalWheelDelta,
  resolveWaveformHorizontalPanFrame,
  resolveWaveformHorizontalScrollLeft,
  resolveWaveformLoadingGridSize,
  resolveWaveformMaximumPixelsPerSecond,
  resolveWaveformMinimumPixelsPerSecond,
  resolveWaveformNextRenderPixelsPerSecond,
  resolveWaveformPeakRange,
  resolveWaveformPixelsPerSecond,
  resolveWaveformPlayheadStyle,
  resolveWaveformPlayheadX,
  resolveWaveformPointerAnchorViewportX,
  resolveWaveformRenderPixelsPerSecond,
  resolveWaveformRenderScale,
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
