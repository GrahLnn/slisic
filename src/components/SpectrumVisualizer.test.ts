import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clampWaveformZoomDeltaY,
  isWaveformTileWindowCoveringWindow,
  normalizeWaveformPathKey,
  resolveAnchoredWaveformScrollLeft,
  resolveCenteredWaveformScrollLeft,
  resolveWaveformMinimumPixelsPerSecond,
  resolvePlaybackPositionMs,
  resolveQuantizedWaveformDisplayPeak,
  resolveWaveformContentWidth,
  resolveWaveformPeakRange,
  resolveWaveformPixelsPerSecond,
  resolveWaveformPlayheadX,
  resolveWaveformPointerAnchorViewportX,
  resolveWaveformRasterAlignment,
  resolveWaveformCanvasBackingMetrics,
  resolveWaveformRenderContentWidth,
  resolveWaveformRenderPixelsPerSecond,
  resolveWaveformRenderScale,
  resolveWaveformRenderTileWindow,
  resolveWaveformRenderViewport,
  resolveWaveformTileRenderMode,
  resolveWaveformTileVisibilityPlan,
  resolveWaveformTileDisplayRange,
  resolveWaveformTileDisplayWidth,
  resolveWaveformTileLoadOrder,
  resolveWaveformTileRenderPlan,
  resolveWaveformTileSourceFetchRange,
  resolveWaveformTileSourcePadding,
  resolveWaveformTileSourcePixelRange,
  resolveWaveformTileWindow,
  resolveWaveformPresentationTransform,
  resolveWaveformWheelDeltas,
  resolveWaveformWheelDeltaX,
  resolveWaveformWheelIntent,
  resolveWaveformWheelPanDelta,
  resolveWaveformWheelPixelsPerSecond,
  resolveQueuedWaveformZoomFrame,
  resolveWaveformZoomScaleFrame,
  resolveWaveformZoomFrame,
  resolveWaveformZoomSettleDelayMs,
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

  test("uses a stable source density that covers the maximum zoom", () => {
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

  test("uses a layer transform for continuous zoom presentation", () => {
    assert.equal(
      resolveWaveformPresentationTransform({
        exactPixelsPerSecond: 24,
        pixelsPerSecond: 48,
        transformPx: 0.25,
      }),
      "translate3d(0.25px, 0, 0) scaleX(2)",
    );

    assert.equal(
      resolveWaveformPresentationTransform({
        exactPixelsPerSecond: 24,
        pixelsPerSecond: 24,
        transformPx: 0,
      }),
      "none",
    );
  });

  test("keeps source fetch windows padded for low zoom edge pixels", () => {
    const sourcePaddingPx = resolveWaveformTileSourcePadding({
      renderPixelsPerSecond: 400,
    });

    assert.equal(sourcePaddingPx, 36);
    assert.deepEqual(
      resolveWaveformTileSourceFetchRange({
        sourceContentWidth: 10_000,
        sourcePaddingPx,
        sourceStartPx: 2_048,
        sourceWidthPx: 2_048,
      }),
      {
        fetchStartPx: 2_012,
        fetchWidthPx: 2_120,
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
    assert.deepEqual(resolveWaveformRasterAlignment({ scrollLeft: 771.3333129882812 }), {
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
    const scrollLeft = 771.3333129882812;
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

  test("shrinks the rendered tile window as zoom increases", () => {
    const lowZoomWindow = resolveWaveformRenderTileWindow({
      contentWidth: 400_000,
      overscanTiles: 0,
      renderScale: 12 / 400,
      scrollLeft: 4_800,
      tileWidth: 2_048,
      viewportWidth: 800,
    });
    const highZoomWindow = resolveWaveformRenderTileWindow({
      contentWidth: 400_000,
      overscanTiles: 0,
      renderScale: 320 / 400,
      scrollLeft: 4_800,
      tileWidth: 2_048,
      viewportWidth: 800,
    });

    assert.ok(lowZoomWindow);
    assert.ok(highZoomWindow);
    assert.ok(
      highZoomWindow.endIndex - highZoomWindow.startIndex <
        lowZoomWindow.endIndex - lowZoomWindow.startIndex,
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
