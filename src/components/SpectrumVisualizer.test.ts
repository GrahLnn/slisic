import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  normalizeWaveformPathKey,
  resolveAnchoredWaveformScrollLeft,
  resolveCenteredWaveformScrollLeft,
  resolvePlaybackPositionMs,
  resolveQuantizedWaveformDisplayPeak,
  resolveWaveformContentWidth,
  resolveWaveformHorizontalWheelScrollLeft,
  resolveWaveformPeakRange,
  resolveWaveformPixelsPerSecond,
  resolveWaveformPlayheadX,
  resolveWaveformRenderContentWidth,
  resolveWaveformRenderPixelsPerSecond,
  resolveWaveformRenderScale,
  resolveWaveformRenderViewport,
  resolveWaveformTileDisplayWidth,
  resolveWaveformTileLoadOrder,
  resolveWaveformTileSourcePixelRange,
  resolveWaveformTileWindow,
  resolveWaveformWheelDeltas,
  resolveWaveformWheelDeltaX,
  resolveWaveformWheelPanDelta,
  resolveWaveformWheelPixelsPerSecond,
} from "./SpectrumVisualizer";

describe("SpectrumVisualizer", () => {
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
  });

  test("clamps horizontal wheel pan to scrollable waveform bounds", () => {
    assert.equal(
      resolveWaveformHorizontalWheelScrollLeft({
        contentWidth: 1_000,
        deltaX: 90,
        scrollLeft: 120,
        viewportWidth: 300,
      }),
      210,
    );
    assert.equal(
      resolveWaveformHorizontalWheelScrollLeft({
        contentWidth: 1_000,
        deltaX: 900,
        scrollLeft: 120,
        viewportWidth: 300,
      }),
      700,
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

  test("uses the lowest cached render density that covers the maximum zoom", () => {
    assert.equal(
      resolveWaveformRenderPixelsPerSecond({
        base_points_per_second: 800,
        cache_key: "track",
        chunk_duration_ms: 2_000,
        duration_ms: 120_000,
        levels: [50, 100, 200, 400, 800],
        sample_rate: 48_000,
        samples_per_point: 60,
        start_ms: 0,
      }),
      400,
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

  test("maps viewport scroll into the fixed render coordinate space", () => {
    assert.equal(
      resolveWaveformRenderScale({
        pixelsPerSecond: 20,
        renderPixelsPerSecond: 400,
      }),
      0.05,
    );
    assert.deepEqual(
      resolveWaveformRenderViewport({
        renderScale: 0.05,
        scrollLeft: 200,
        viewportWidth: 800,
      }),
      {
        scrollLeft: 4_000,
        viewportWidth: 16_000,
      },
    );
  });

  test("keeps the fixed render layer wide enough after visual scaling", () => {
    assert.equal(
      resolveWaveformRenderContentWidth({
        durationMs: 2_000,
        pixelsPerSecond: 20,
        renderPixelsPerSecond: 400,
        viewportWidth: 800,
      }),
      16_000,
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

  test("normalizes windows paths for playback status matching", () => {
    assert.equal(
      normalizeWaveformPathKey("C:\\Music\\Track.M4A"),
      normalizeWaveformPathKey("c:/music/track.m4a"),
    );
  });
});
