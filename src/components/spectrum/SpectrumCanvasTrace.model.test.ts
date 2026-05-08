import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  accumulateSpectrumCanvasFastPresentationMetrics,
  accumulateSpectrumCanvasRenderEmptyMetrics,
  accumulateSpectrumCanvasRenderJobMetrics,
  createSpectrumCanvasFastPresentationMetrics,
  createSpectrumCanvasRenderEmptyMetrics,
  createSpectrumCanvasRenderJobMetrics,
  flushDueSpectrumCanvasFastPresentationMetrics,
  flushDueSpectrumCanvasRenderEmptyMetrics,
  summarizeSpectrumCanvasColumnTraceResults,
} from "./SpectrumCanvasTrace.model";

describe("SpectrumCanvasTrace.model", () => {
  test("accumulates render job chunk metrics without emitting per chunk", () => {
    const metrics = createSpectrumCanvasRenderJobMetrics(10);

    accumulateSpectrumCanvasRenderJobMetrics({
      chunk: {
        firstMissingX: null,
        hasColumn: true,
        lastMissingX: null,
        missingPeakColumns: 0,
        resolvedPeakCount: 96,
        scannedColumns: 96,
      },
      durationMs: 2,
      metrics,
    });
    accumulateSpectrumCanvasRenderJobMetrics({
      chunk: {
        firstMissingX: 120,
        hasColumn: true,
        lastMissingX: 122,
        missingPeakColumns: 3,
        resolvedPeakCount: 157,
        scannedColumns: 160,
      },
      durationMs: 4,
      metrics,
    });

    assert.deepEqual(metrics, {
      chunkCount: 2,
      firstMissingX: 120,
      lastMissingX: 122,
      maxChunkDurationMs: 4,
      missingPeakColumns: 3,
      resolvedPeakCount: 253,
      scannedColumns: 256,
      startedAt: 10,
      totalChunkDurationMs: 6,
    });
  });

  test("summarizes fast presentation samples into a flushable window", () => {
    const metrics = createSpectrumCanvasFastPresentationMetrics();
    accumulateSpectrumCanvasFastPresentationMetrics({
      flushAfterMs: 100,
      metrics,
      now: 0,
      sample: {
        drawSummary: {
          firstMissingX: null,
          hasColumn: true,
          lastMissingX: null,
          missingPeakColumns: 0,
          resolvedPeakCount: 120,
          scannedColumns: 120,
        },
        elapsedMs: 3,
        kind: "presented",
        mode: "exact-cache-redraw",
        planKind: "exact-cache-redraw",
        revision: 1,
      },
    });
    accumulateSpectrumCanvasFastPresentationMetrics({
      flushAfterMs: 100,
      metrics,
      now: 40,
      sample: {
        elapsedMs: 1,
        kind: "empty",
        planKind: "missing-presented-frame",
        reason: "not-reusable",
        revision: 2,
      },
    });

    assert.equal(flushDueSpectrumCanvasFastPresentationMetrics(metrics, 99), null);
    assert.deepEqual(flushDueSpectrumCanvasFastPresentationMetrics(metrics, 100), {
      averageElapsedMs: 2,
      count: 2,
      emptyCount: 1,
      exactCacheRedrawCount: 1,
      firstRevision: 1,
      horizontalPanCount: 0,
      lastKind: "empty",
      lastMode: null,
      lastPlanKind: "missing-presented-frame",
      lastReason: "not-reusable",
      lastRevision: 2,
      maxElapsedMs: 3,
      missingPeakColumns: 0,
      reason: "interval",
      resolvedPeakCount: 120,
      scannedColumns: 120,
      viewportResizeCount: 0,
      windowDurationMs: 100,
    });
  });

  test("summarizes empty render plans without per-frame trace writes", () => {
    const metrics = createSpectrumCanvasRenderEmptyMetrics();
    accumulateSpectrumCanvasRenderEmptyMetrics(metrics, {
      flushAfterMs: 100,
      kind: "missing-data-plan",
      now: 0,
      requestedRevision: 1,
      status: "ready",
      viewportWidth: 320,
    });
    accumulateSpectrumCanvasRenderEmptyMetrics(metrics, {
      flushAfterMs: 100,
      kind: "missing-candidate-levels",
      now: 20,
      requestedRevision: 2,
      tileCacheSize: 4,
      viewportWidth: 640,
    });

    assert.deepEqual(flushDueSpectrumCanvasRenderEmptyMetrics(metrics, 120), {
      count: 2,
      firstRevision: 1,
      lastKind: "missing-candidate-levels",
      lastRevision: 2,
      lastStatus: null,
      maxViewportWidth: 640,
      reason: "interval",
      tileCacheSize: 4,
      windowDurationMs: 120,
    });
  });

  test("combines exposed draw summaries", () => {
    assert.deepEqual(
      summarizeSpectrumCanvasColumnTraceResults([
        {
          firstMissingX: null,
          hasColumn: false,
          lastMissingX: null,
          missingPeakColumns: 0,
          resolvedPeakCount: 10,
          scannedColumns: 10,
        },
        {
          firstMissingX: 11,
          hasColumn: true,
          lastMissingX: 12,
          missingPeakColumns: 2,
          resolvedPeakCount: 18,
          scannedColumns: 20,
        },
      ]),
      {
        firstMissingX: 11,
        hasColumn: true,
        lastMissingX: 12,
        missingPeakColumns: 2,
        resolvedPeakCount: 28,
        scannedColumns: 30,
      },
    );
  });
});
