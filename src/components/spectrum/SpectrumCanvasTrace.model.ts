export type SpectrumCanvasColumnTraceResult = {
  firstMissingX: number | null;
  hasColumn: boolean;
  lastMissingX: number | null;
  missingPeakColumns: number;
  resolvedPeakCount: number;
  scannedColumns: number;
};

export type SpectrumCanvasTraceColumnRange = {
  endX: number;
  startX: number;
};

export type SpectrumCanvasColumnRangeSummary = {
  count: number;
  firstEndX: number | null;
  firstStartX: number | null;
  largestEndX: number | null;
  largestStartX: number | null;
  largestWidthPx: number;
  lastEndX: number | null;
  lastStartX: number | null;
  maxEndX: number | null;
  minStartX: number | null;
  sample: SpectrumCanvasTraceColumnRange[];
  totalWidthPx: number;
};

export type SpectrumCanvasRenderJobMetrics = {
  chunkCount: number;
  firstMissingX: number | null;
  lastMissingX: number | null;
  maxChunkDurationMs: number;
  missingPeakColumns: number;
  resolvedPeakCount: number;
  scannedColumns: number;
  startedAt: number;
  totalChunkDurationMs: number;
};

export type SpectrumCanvasRenderJobTraceReason = "completed" | "stale" | "cancelled" | "replaced";

export type SpectrumCanvasFastPresentationMode =
  | "dirty-redraw"
  | "exact-cache-redraw"
  | "horizontal-pan"
  | "viewport-resize"
  | "zoom-affine";

export type SpectrumCanvasFastPresentationMetrics = {
  count: number;
  dirtyRedrawCount: number;
  emptyCount: number;
  exactCacheRedrawCount: number;
  firstRevision: number | null;
  horizontalPanCount: number;
  lastKind: "empty" | "presented" | null;
  lastMode: SpectrumCanvasFastPresentationMode | null;
  lastPlanKind: string | null;
  lastReason: string | null;
  lastRevision: number | null;
  maxElapsedMs: number;
  missingPeakColumns: number;
  nextFlushAt: number | null;
  resolvedPeakCount: number;
  scannedColumns: number;
  startedAt: number | null;
  totalElapsedMs: number;
  viewportResizeCount: number;
  zoomAffineCount: number;
};

export type SpectrumCanvasRenderEmptyMetrics = {
  count: number;
  firstRevision: number | null;
  lastKind: string | null;
  lastRevision: number | null;
  lastStatus: string | null;
  maxViewportWidth: number;
  nextFlushAt: number | null;
  startedAt: number | null;
  tileCacheSize: number | null;
};

export type SpectrumCanvasFastPresentationSample =
  | {
      elapsedMs: number;
      kind: "empty";
      planKind: string | null;
      reason: string;
      revision: number;
    }
  | {
      drawSummary: SpectrumCanvasColumnTraceResult;
      elapsedMs: number;
      kind: "presented";
      mode: SpectrumCanvasFastPresentationMode;
      planKind: string;
      revision: number;
    };

export function createSpectrumCanvasRenderJobMetrics(
  startedAt: number,
): SpectrumCanvasRenderJobMetrics {
  return {
    chunkCount: 0,
    firstMissingX: null,
    lastMissingX: null,
    maxChunkDurationMs: 0,
    missingPeakColumns: 0,
    resolvedPeakCount: 0,
    scannedColumns: 0,
    startedAt,
    totalChunkDurationMs: 0,
  };
}

export function accumulateSpectrumCanvasRenderJobMetrics(args: {
  chunk: SpectrumCanvasColumnTraceResult;
  durationMs: number;
  metrics: SpectrumCanvasRenderJobMetrics;
}) {
  args.metrics.chunkCount += 1;
  args.metrics.firstMissingX ??= args.chunk.firstMissingX;
  args.metrics.lastMissingX = args.chunk.lastMissingX ?? args.metrics.lastMissingX;
  args.metrics.maxChunkDurationMs = Math.max(args.metrics.maxChunkDurationMs, args.durationMs);
  args.metrics.missingPeakColumns += args.chunk.missingPeakColumns;
  args.metrics.resolvedPeakCount += args.chunk.resolvedPeakCount;
  args.metrics.scannedColumns += args.chunk.scannedColumns;
  args.metrics.totalChunkDurationMs += args.durationMs;
}

export function summarizeSpectrumCanvasColumnTraceResults(
  results: readonly SpectrumCanvasColumnTraceResult[],
) {
  const summary: SpectrumCanvasColumnTraceResult = {
    firstMissingX: null,
    hasColumn: false,
    lastMissingX: null,
    missingPeakColumns: 0,
    resolvedPeakCount: 0,
    scannedColumns: 0,
  };

  for (const result of results) {
    summary.firstMissingX ??= result.firstMissingX;
    summary.hasColumn = summary.hasColumn || result.hasColumn;
    summary.lastMissingX = result.lastMissingX ?? summary.lastMissingX;
    summary.missingPeakColumns += result.missingPeakColumns;
    summary.resolvedPeakCount += result.resolvedPeakCount;
    summary.scannedColumns += result.scannedColumns;
  }

  return summary;
}

export function summarizeSpectrumCanvasColumnRanges(
  ranges: readonly SpectrumCanvasTraceColumnRange[],
  sampleLimit = 8,
): SpectrumCanvasColumnRangeSummary {
  const normalizedRanges = ranges.filter(
    (range) =>
      Number.isFinite(range.startX) && Number.isFinite(range.endX) && range.endX > range.startX,
  );
  const first = normalizedRanges[0] ?? null;
  const last = normalizedRanges.at(-1) ?? null;
  let largest: SpectrumCanvasTraceColumnRange | null = null;
  let largestWidthPx = 0;
  let maxEndX: number | null = null;
  let minStartX: number | null = null;
  let totalWidthPx = 0;

  for (const range of normalizedRanges) {
    const width = range.endX - range.startX;
    totalWidthPx += width;
    minStartX = minStartX === null ? range.startX : Math.min(minStartX, range.startX);
    maxEndX = maxEndX === null ? range.endX : Math.max(maxEndX, range.endX);
    if (width > largestWidthPx) {
      largest = range;
      largestWidthPx = width;
    }
  }

  return {
    count: normalizedRanges.length,
    firstEndX: first?.endX ?? null,
    firstStartX: first?.startX ?? null,
    largestEndX: largest?.endX ?? null,
    largestStartX: largest?.startX ?? null,
    largestWidthPx,
    lastEndX: last?.endX ?? null,
    lastStartX: last?.startX ?? null,
    maxEndX,
    minStartX,
    sample: normalizedRanges.slice(0, Math.max(0, Math.floor(sampleLimit))).map((range) => ({
      endX: range.endX,
      startX: range.startX,
    })),
    totalWidthPx,
  };
}

export function createSpectrumCanvasFastPresentationMetrics(): SpectrumCanvasFastPresentationMetrics {
  return {
    count: 0,
    dirtyRedrawCount: 0,
    emptyCount: 0,
    exactCacheRedrawCount: 0,
    firstRevision: null,
    horizontalPanCount: 0,
    lastKind: null,
    lastMode: null,
    lastPlanKind: null,
    lastReason: null,
    lastRevision: null,
    maxElapsedMs: 0,
    missingPeakColumns: 0,
    nextFlushAt: null,
    resolvedPeakCount: 0,
    scannedColumns: 0,
    startedAt: null,
    totalElapsedMs: 0,
    viewportResizeCount: 0,
    zoomAffineCount: 0,
  };
}

export function accumulateSpectrumCanvasFastPresentationMetrics(args: {
  flushAfterMs: number;
  metrics: SpectrumCanvasFastPresentationMetrics;
  now: number;
  sample: SpectrumCanvasFastPresentationSample;
}) {
  args.metrics.count += 1;
  args.metrics.firstRevision ??= args.sample.revision;
  args.metrics.lastRevision = args.sample.revision;
  args.metrics.startedAt ??= args.now;
  args.metrics.nextFlushAt ??= args.now + args.flushAfterMs;
  args.metrics.maxElapsedMs = Math.max(args.metrics.maxElapsedMs, args.sample.elapsedMs);
  args.metrics.totalElapsedMs += args.sample.elapsedMs;

  if (args.sample.kind === "empty") {
    args.metrics.emptyCount += 1;
    args.metrics.lastKind = "empty";
    args.metrics.lastMode = null;
    args.metrics.lastPlanKind = args.sample.planKind;
    args.metrics.lastReason = args.sample.reason;
    return;
  }

  args.metrics.lastKind = "presented";
  args.metrics.lastMode = args.sample.mode;
  args.metrics.lastPlanKind = args.sample.planKind;
  args.metrics.lastReason = null;
  args.metrics.missingPeakColumns += args.sample.drawSummary.missingPeakColumns;
  args.metrics.resolvedPeakCount += args.sample.drawSummary.resolvedPeakCount;
  args.metrics.scannedColumns += args.sample.drawSummary.scannedColumns;

  if (args.sample.mode === "exact-cache-redraw") {
    args.metrics.exactCacheRedrawCount += 1;
  } else if (args.sample.mode === "dirty-redraw") {
    args.metrics.dirtyRedrawCount += 1;
  } else if (args.sample.mode === "horizontal-pan") {
    args.metrics.horizontalPanCount += 1;
  } else if (args.sample.mode === "zoom-affine") {
    args.metrics.zoomAffineCount += 1;
  } else {
    args.metrics.viewportResizeCount += 1;
  }
}

export function flushDueSpectrumCanvasFastPresentationMetrics(
  metrics: SpectrumCanvasFastPresentationMetrics,
  now: number,
) {
  if (metrics.nextFlushAt === null || now < metrics.nextFlushAt) {
    return null;
  }

  return flushSpectrumCanvasFastPresentationMetrics(metrics, now, "interval");
}

export function flushSpectrumCanvasFastPresentationMetrics(
  metrics: SpectrumCanvasFastPresentationMetrics,
  now: number,
  reason: string,
) {
  if (metrics.count <= 0) {
    return null;
  }

  const payload = {
    averageElapsedMs: metrics.totalElapsedMs / metrics.count,
    count: metrics.count,
    dirtyRedrawCount: metrics.dirtyRedrawCount,
    emptyCount: metrics.emptyCount,
    exactCacheRedrawCount: metrics.exactCacheRedrawCount,
    firstRevision: metrics.firstRevision,
    horizontalPanCount: metrics.horizontalPanCount,
    lastKind: metrics.lastKind,
    lastMode: metrics.lastMode,
    lastPlanKind: metrics.lastPlanKind,
    lastReason: metrics.lastReason,
    lastRevision: metrics.lastRevision,
    maxElapsedMs: metrics.maxElapsedMs,
    missingPeakColumns: metrics.missingPeakColumns,
    reason,
    resolvedPeakCount: metrics.resolvedPeakCount,
    scannedColumns: metrics.scannedColumns,
    windowDurationMs: metrics.startedAt === null ? 0 : Math.max(0, now - metrics.startedAt),
    viewportResizeCount: metrics.viewportResizeCount,
    zoomAffineCount: metrics.zoomAffineCount,
  } satisfies Record<string, unknown>;

  Object.assign(metrics, createSpectrumCanvasFastPresentationMetrics());
  return payload;
}

export function createSpectrumCanvasRenderEmptyMetrics(): SpectrumCanvasRenderEmptyMetrics {
  return {
    count: 0,
    firstRevision: null,
    lastKind: null,
    lastRevision: null,
    lastStatus: null,
    maxViewportWidth: 0,
    nextFlushAt: null,
    startedAt: null,
    tileCacheSize: null,
  };
}

export function accumulateSpectrumCanvasRenderEmptyMetrics(
  metrics: SpectrumCanvasRenderEmptyMetrics,
  args: {
    flushAfterMs: number;
    kind: string;
    now: number;
    requestedRevision: number;
    status?: string | null;
    tileCacheSize?: number | null;
    viewportWidth: number;
  },
) {
  metrics.count += 1;
  metrics.firstRevision ??= args.requestedRevision;
  metrics.lastKind = args.kind;
  metrics.lastRevision = args.requestedRevision;
  metrics.lastStatus = args.status ?? null;
  metrics.maxViewportWidth = Math.max(metrics.maxViewportWidth, args.viewportWidth);
  metrics.nextFlushAt ??= args.now + args.flushAfterMs;
  metrics.startedAt ??= args.now;
  metrics.tileCacheSize = args.tileCacheSize ?? metrics.tileCacheSize;
}

export function flushDueSpectrumCanvasRenderEmptyMetrics(
  metrics: SpectrumCanvasRenderEmptyMetrics,
  now: number,
) {
  if (metrics.nextFlushAt === null || now < metrics.nextFlushAt) {
    return null;
  }

  return flushSpectrumCanvasRenderEmptyMetrics(metrics, now, "interval");
}

export function flushSpectrumCanvasRenderEmptyMetrics(
  metrics: SpectrumCanvasRenderEmptyMetrics,
  now: number,
  reason: string,
) {
  if (metrics.count <= 0) {
    return null;
  }

  const payload = {
    count: metrics.count,
    firstRevision: metrics.firstRevision,
    lastKind: metrics.lastKind,
    lastRevision: metrics.lastRevision,
    lastStatus: metrics.lastStatus,
    maxViewportWidth: metrics.maxViewportWidth,
    reason,
    tileCacheSize: metrics.tileCacheSize,
    windowDurationMs: metrics.startedAt === null ? 0 : Math.max(0, now - metrics.startedAt),
  } satisfies Record<string, unknown>;

  Object.assign(metrics, createSpectrumCanvasRenderEmptyMetrics());
  return payload;
}

export function createSpectrumCanvasRenderJobTracePayload(args: {
  accepted: boolean;
  completionKind: string | null;
  dirtyRanges?: readonly SpectrumCanvasTraceColumnRange[];
  endedAt: number;
  jobId: number;
  metrics: SpectrumCanvasRenderJobMetrics;
  missingRanges?: readonly SpectrumCanvasTraceColumnRange[];
  plan: Record<string, unknown>;
  reason: SpectrumCanvasRenderJobTraceReason;
  requestedRevision: number;
  revision: number;
}) {
  return {
    accepted: args.accepted,
    chunkCount: args.metrics.chunkCount,
    completionKind: args.completionKind,
    dirtyRanges: summarizeSpectrumCanvasColumnRanges(args.dirtyRanges ?? []),
    durationMs: Math.max(0, args.endedAt - args.metrics.startedAt),
    firstMissingX: args.metrics.firstMissingX,
    jobId: args.jobId,
    lastMissingX: args.metrics.lastMissingX,
    maxChunkDurationMs: args.metrics.maxChunkDurationMs,
    missingRanges: summarizeSpectrumCanvasColumnRanges(args.missingRanges ?? []),
    missingPeakColumns: args.metrics.missingPeakColumns,
    plan: args.plan,
    reason: args.reason,
    requestedRevision: args.requestedRevision,
    resolvedPeakCount: args.metrics.resolvedPeakCount,
    revision: args.revision,
    scannedColumns: args.metrics.scannedColumns,
    totalChunkDurationMs: args.metrics.totalChunkDurationMs,
  } satisfies Record<string, unknown>;
}
