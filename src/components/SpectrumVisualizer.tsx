import {
  useCallback,
  type Dispatch,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type SetStateAction,
  useState,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { motion } from "motion/react";
import {
  OverlayScrollbarsComponent,
  type OverlayScrollbarsComponentRef,
} from "overlayscrollbars-react";
import type { Elements, EventListeners } from "overlayscrollbars";
import { cn } from "@/lib/utils";
import {
  commands,
  type PlaybackStatusPayload,
  type TrackWaveformSummary,
  type TrackWaveformTile,
  type WaveformPeak,
} from "@/src/cmd/commands";
import {
  installSpectrumWaveformTrace,
  isSpectrumWaveformTraceEnabled,
  recordSpectrumWaveformTrace,
} from "@/src/debug/spectrumWaveformTrace";

const WAVEFORM_CANVAS_HEIGHT = 208;
const WAVEFORM_VERTICAL_PADDING = 18;
const WAVEFORM_PLACEHOLDER_POINTS_PER_SECOND = 80;
const WAVEFORM_PLACEHOLDER_DURATION_MS = 8_000;
const WAVEFORM_MIN_PIXELS_PER_SECOND = 12;
const WAVEFORM_MAX_PIXELS_PER_SECOND = 320;
const WAVEFORM_INITIAL_PIXELS_PER_SECOND = 24;
const WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM = 360;
const WAVEFORM_PIXELS_PER_SECOND_PRECISION = 100;
const WAVEFORM_INACTIVE_OPACITY = 0.42;
const WAVEFORM_RENDER_TARGET_PIXELS_PER_SECOND = WAVEFORM_MAX_PIXELS_PER_SECOND;
const WAVEFORM_TILE_WIDTH = 2048;
const WAVEFORM_TILE_OVERSCAN = 2;
const WAVEFORM_TILE_RETENTION_OVERSCAN = 8;
const WAVEFORM_TILE_LOAD_CONCURRENCY = 2;
const WAVEFORM_OFFSCREEN_RENDER_IDLE_TIMEOUT_MS = 160;
const PLAYBACK_STATUS_POLL_MS = 250;

type WaveformStatus = "idle" | "loading" | "ready" | "error";

type PlaybackSnapshot = PlaybackStatusPayload & {
  received_at_ms: number;
};

type WaveformRenderInputs = {
  contentWidth: number;
  end: number | null;
  filePath: string | null;
  opacity: number;
  pixelsPerSecond: number;
  start: number | null;
  status: WaveformStatus;
  summary: TrackWaveformSummary;
  viewportWidth: number;
};

type WaveformTileWindow = {
  endIndex: number;
  startIndex: number;
};

type WaveformTileDisplayRange = {
  displayStartPx: number;
  displayWidthPx: number;
};

type WaveformTileSourceFetchRange = {
  fetchStartPx: number;
  fetchWidthPx: number;
};

type WaveformTileGeometry = WaveformTileDisplayRange &
  WaveformTileSourceFetchRange & {
    sourceStartPx: number;
    sourceWidthPx: number;
  };

type WaveformTileNodeState = {
  canvas: HTMLCanvasElement;
  data: TrackWaveformTile | null;
  displayStartPx: number;
  displayWidthPx: number;
  fetchStartPx: number;
  fetchWidthPx: number;
  drawDisplayStartPx: number | null;
  drawDisplayWidthPx: number | null;
  drawOpacity: number | null;
  drawSampleOffsetPx: number | null;
  drawScale: number | null;
  drawStatus: "data" | "placeholder" | null;
  index: number;
  sourceStartPx: number;
  sourceWidthPx: number;
  status: "loading" | "pending" | "ready";
};

type WaveformScrollElements = Pick<
  Elements,
  "content" | "host" | "scrollOffsetElement" | "viewport"
>;

type WaveformWheelDeltas = {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
};

type WaveformWheelIntent =
  | {
      deltaX: number;
      kind: "horizontal-pan";
    }
  | {
      deltaY: number;
      kind: "zoom";
    }
  | {
      kind: "none";
    };

type WaveformWheelEvent = Event & {
  nativeEvent?: Event;
};

type WaveformWheelState = {
  contentWidth: number;
  controller: WaveformTileController;
  pixelsPerSecond: number;
  setPixelsPerSecond: Dispatch<SetStateAction<number>>;
  summary: TrackWaveformSummary;
  viewportWidth: number;
};

type WaveformZoomFrame = {
  anchorSeconds: number;
  anchorViewportX: number;
  contentWidth: number;
  pixelsPerSecond: number;
  scrollLeft: number;
};

type WaveformZoomCommit = WaveformZoomFrame & {
  controller: WaveformTileController;
  scrollElements: WaveformScrollElements;
  setPixelsPerSecond: Dispatch<SetStateAction<number>>;
};

type WaveformTileSyncResult = {
  dataReset: boolean;
  displayChanged: boolean;
  sourceChanged: boolean;
};

type WaveformTileDrawResult = "data" | "placeholder" | "skipped";

type WaveformTileRenderStats = {
  createdTileCount: number;
  dataDrawCount: number;
  dataResetCount: number;
  displayChangeCount: number;
  placeholderDrawCount: number;
  removedTileCount: number;
  skippedDrawCount: number;
  sourceChangeCount: number;
  tileCountBefore: number;
};

type WaveformTileRenderPlan = {
  offscreenTileLoadOrder: number[];
  removeIndexes: number[];
  retainedSyncIndexes: number[];
  tileLoadOrder: number[];
  visibleTileLoadOrder: number[];
};

type WaveformIdleDeadline = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type WaveformIdleWindow = Window & {
  cancelIdleCallback?: (handle: number) => void;
  requestIdleCallback?: (
    callback: (deadline: WaveformIdleDeadline) => void,
    options?: { timeout: number },
  ) => number;
};

type WaveformOffscreenTileRenderJob = {
  generation: number;
  indexes: number[];
  inputs: WaveformRenderInputs;
  renderMetrics: ReturnType<typeof resolveWaveformRenderMetrics>;
};

const waveformScrollOptions = {
  overflow: {
    x: "scroll",
    y: "hidden",
  },
  scrollbars: {
    theme: "os-theme-spectrum-waveform",
    autoHide: "never",
    clickScroll: true,
  },
} as const;

export function resolveWaveformPixelsPerSecond(value: number) {
  return roundWaveformPixelsPerSecond(value);
}

export function resolveWaveformContentWidth(args: {
  durationMs: number;
  pixelsPerSecond: number;
  viewportWidth: number;
}) {
  const viewportWidth = Math.max(1, Math.ceil(args.viewportWidth));
  const durationSeconds = Math.max(0, args.durationMs) / 1000;
  const naturalWidth = Math.ceil(durationSeconds * Math.max(1, args.pixelsPerSecond));

  return Math.max(viewportWidth, naturalWidth);
}

export function resolveCenteredWaveformScrollLeft(args: {
  centerSeconds: number;
  contentWidth: number;
  pixelsPerSecond: number;
  viewportWidth: number;
}) {
  return clampNumber(
    args.centerSeconds * args.pixelsPerSecond - args.viewportWidth / 2,
    0,
    Math.max(0, args.contentWidth - args.viewportWidth),
  );
}

export function resolveAnchoredWaveformScrollLeft(args: {
  anchorSeconds: number;
  anchorViewportX: number;
  contentWidth: number;
  pixelsPerSecond: number;
  viewportWidth: number;
}) {
  return clampNumber(
    args.anchorSeconds * args.pixelsPerSecond - args.anchorViewportX,
    0,
    Math.max(0, args.contentWidth - args.viewportWidth),
  );
}

export function resolveWaveformPointerAnchorViewportX(args: {
  clientX: number;
  viewportLeft: number;
  viewportWidth: number;
}) {
  const viewportWidth = Math.max(1, args.viewportWidth);

  return clampNumber(args.clientX - args.viewportLeft, 0, viewportWidth);
}

export function resolveWaveformHorizontalWheelScrollLeft(args: {
  contentWidth: number;
  deltaX: number;
  scrollLeft: number;
  viewportWidth: number;
}) {
  return clampNumber(
    args.scrollLeft + args.deltaX,
    0,
    Math.max(0, args.contentWidth - args.viewportWidth),
  );
}

export function resolveWaveformWheelPanDelta(args: {
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
}) {
  if (args.deltaX !== 0) {
    return args.deltaX;
  }

  if (args.shiftKey && args.deltaY !== 0) {
    return args.deltaY;
  }

  return 0;
}

export function resolveWaveformWheelIntent(args: {
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
}): WaveformWheelIntent {
  const horizontalDelta = resolveWaveformWheelPanDelta(args);

  if (horizontalDelta !== 0) {
    return {
      deltaX: horizontalDelta,
      kind: "horizontal-pan",
    };
  }

  if (args.deltaY !== 0) {
    return {
      deltaY: args.deltaY,
      kind: "zoom",
    };
  }

  return { kind: "none" };
}

export function resolveWaveformWheelDeltaX(args: {
  axis?: number | null;
  deltaX: number;
  wheelDelta?: number | null;
  wheelDeltaX?: number | null;
  wheelDeltaY?: number | null;
  horizontalAxis?: number | null;
}) {
  return resolveWaveformWheelDeltas(args).deltaX;
}

export function resolveWaveformWheelDeltas(args: {
  axis?: number | null;
  deltaMode?: number | null;
  deltaX?: number | null;
  deltaY?: number | null;
  horizontalAxis?: number | null;
  wheelDelta?: number | null;
  wheelDeltaX?: number | null;
  wheelDeltaY?: number | null;
}): WaveformWheelDeltas {
  const deltaX = resolveFiniteWheelDelta(args.deltaX);
  const deltaY = resolveFiniteWheelDelta(args.deltaY);
  const wheelDelta = resolveFiniteWheelDelta(args.wheelDelta);
  const wheelDeltaX = resolveFiniteWheelDelta(args.wheelDeltaX);
  const wheelDeltaY = resolveFiniteWheelDelta(args.wheelDeltaY);
  const hasHorizontalAxis =
    typeof args.axis === "number" &&
    typeof args.horizontalAxis === "number" &&
    args.axis === args.horizontalAxis;

  return {
    deltaMode: Number.isFinite(args.deltaMode) ? Number(args.deltaMode) : 0,
    deltaX:
      deltaX !== 0
        ? deltaX
        : wheelDeltaX !== 0
          ? -wheelDeltaX
          : hasHorizontalAxis
            ? -wheelDelta
            : 0,
    deltaY:
      deltaY !== 0
        ? deltaY
        : wheelDeltaY !== 0
          ? -wheelDeltaY
          : hasHorizontalAxis
            ? 0
            : -wheelDelta,
  };
}

function resolveFiniteWheelDelta(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function resolveWaveformWheelPixelsPerSecond(args: {
  currentPixelsPerSecond: number;
  deltaY: number;
}) {
  if (!Number.isFinite(args.deltaY) || args.deltaY === 0) {
    return resolveWaveformPixelsPerSecond(args.currentPixelsPerSecond);
  }

  return resolveWaveformPixelsPerSecond(
    args.currentPixelsPerSecond * 2 ** (-args.deltaY / WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM),
  );
}

export function resolveWaveformZoomFrame(args: {
  anchorViewportX: number;
  currentPixelsPerSecond: number;
  deltaY: number;
  durationMs: number;
  scrollLeft: number;
  viewportWidth: number;
}): WaveformZoomFrame {
  const pixelsPerSecond = resolveWaveformWheelPixelsPerSecond({
    currentPixelsPerSecond: args.currentPixelsPerSecond,
    deltaY: args.deltaY,
  });
  const anchorSeconds = (args.scrollLeft + args.anchorViewportX) / args.currentPixelsPerSecond;
  const contentWidth = resolveWaveformContentWidth({
    durationMs: args.durationMs,
    pixelsPerSecond,
    viewportWidth: args.viewportWidth,
  });
  const scrollLeft = resolveAnchoredWaveformScrollLeft({
    anchorSeconds,
    anchorViewportX: args.anchorViewportX,
    contentWidth,
    pixelsPerSecond,
    viewportWidth: args.viewportWidth,
  });

  return {
    anchorSeconds,
    anchorViewportX: args.anchorViewportX,
    contentWidth,
    pixelsPerSecond,
    scrollLeft,
  };
}

export function resolveWaveformTileWindow(args: {
  contentWidth: number;
  overscanTiles: number;
  scrollLeft: number;
  tileWidth: number;
  viewportWidth: number;
}): WaveformTileWindow | null {
  const contentWidth = Math.max(0, Math.ceil(args.contentWidth));
  const tileWidth = Math.max(1, Math.ceil(args.tileWidth));
  const viewportWidth = Math.max(1, Math.ceil(args.viewportWidth));

  if (contentWidth <= 0) {
    return null;
  }

  const overscanWidth = Math.max(0, Math.floor(args.overscanTiles)) * tileWidth;
  const maxTileIndex = Math.max(0, Math.ceil(contentWidth / tileWidth) - 1);
  const startIndex = clampInteger(
    Math.floor(Math.max(0, args.scrollLeft - overscanWidth) / tileWidth),
    0,
    maxTileIndex,
  );
  const endIndex = clampInteger(
    Math.ceil(Math.min(contentWidth, args.scrollLeft + viewportWidth + overscanWidth) / tileWidth) -
      1,
    startIndex,
    maxTileIndex,
  );

  return { endIndex, startIndex };
}

export function resolveWaveformTileLoadOrder(args: {
  endIndex: number;
  startIndex: number;
  visibleEndIndex: number;
  visibleStartIndex: number;
}) {
  const startIndex = Math.min(args.startIndex, args.endIndex);
  const endIndex = Math.max(args.startIndex, args.endIndex);
  const visibleStartIndex = Math.min(args.visibleStartIndex, args.visibleEndIndex);
  const visibleEndIndex = Math.max(args.visibleStartIndex, args.visibleEndIndex);
  const visibleCenter = (visibleStartIndex + visibleEndIndex) / 2;
  const indexes: number[] = [];

  for (let index = startIndex; index <= endIndex; index += 1) {
    indexes.push(index);
  }

  return indexes.sort((left, right) => {
    const leftVisible = left >= visibleStartIndex && left <= visibleEndIndex;
    const rightVisible = right >= visibleStartIndex && right <= visibleEndIndex;

    if (leftVisible !== rightVisible) {
      return leftVisible ? -1 : 1;
    }

    return Math.abs(left - visibleCenter) - Math.abs(right - visibleCenter) || left - right;
  });
}

export function resolveWaveformTileRenderPlan(args: {
  mountedTileIndexes: Iterable<number>;
  retentionTileWindow: WaveformTileWindow;
  tileWindow: WaveformTileWindow;
  visibleTileWindow: WaveformTileWindow;
}): WaveformTileRenderPlan {
  const mountedTileIndexes = Array.from(new Set(args.mountedTileIndexes)).sort(
    (left, right) => left - right,
  );
  const removeIndexes = mountedTileIndexes.filter(
    (index) => !isWaveformTileIndexInWindow(index, args.retentionTileWindow),
  );
  const retainedSyncIndexes = mountedTileIndexes.filter((index) =>
    isWaveformTileIndexInWindow(index, args.retentionTileWindow),
  );
  const tileLoadOrder = resolveWaveformTileLoadOrder({
    endIndex: args.tileWindow.endIndex,
    startIndex: args.tileWindow.startIndex,
    visibleEndIndex: args.visibleTileWindow.endIndex,
    visibleStartIndex: args.visibleTileWindow.startIndex,
  });
  const visibleTileLoadOrder = tileLoadOrder.filter((index) =>
    isWaveformTileIndexInWindow(index, args.visibleTileWindow),
  );
  const offscreenTileLoadOrder = tileLoadOrder.filter(
    (index) => !isWaveformTileIndexInWindow(index, args.visibleTileWindow),
  );

  return {
    offscreenTileLoadOrder,
    removeIndexes,
    retainedSyncIndexes,
    tileLoadOrder,
    visibleTileLoadOrder,
  };
}

export function resolveWaveformRenderPixelsPerSecond(summary: TrackWaveformSummary) {
  const sortedLevels = summary.levels
    .filter((level) => Number.isFinite(level) && level > 0)
    .sort((left, right) => left - right);

  return (
    sortedLevels.find((level) => level >= WAVEFORM_RENDER_TARGET_PIXELS_PER_SECOND) ??
    Math.max(summary.base_points_per_second, WAVEFORM_RENDER_TARGET_PIXELS_PER_SECOND)
  );
}

export function resolveWaveformRenderScale(args: {
  pixelsPerSecond: number;
  renderPixelsPerSecond: number;
}) {
  return clampNumber(args.pixelsPerSecond / Math.max(1, args.renderPixelsPerSecond), 0.001, 1);
}

export function resolveWaveformRenderContentWidth(args: {
  durationMs: number;
  pixelsPerSecond: number;
  renderPixelsPerSecond: number;
  viewportWidth: number;
}) {
  const renderScale = resolveWaveformRenderScale({
    pixelsPerSecond: args.pixelsPerSecond,
    renderPixelsPerSecond: args.renderPixelsPerSecond,
  });

  return resolveWaveformContentWidth({
    durationMs: args.durationMs,
    pixelsPerSecond: args.renderPixelsPerSecond,
    viewportWidth: args.viewportWidth / renderScale,
  });
}

export function resolveWaveformRenderViewport(args: {
  renderScale: number;
  scrollLeft: number;
  viewportWidth: number;
}) {
  const safeScale = Math.max(0.001, args.renderScale);

  return {
    scrollLeft: args.scrollLeft / safeScale,
    viewportWidth: args.viewportWidth / safeScale,
  };
}

export function resolveWaveformRasterAlignment(args: {
  sampleScrollLeft?: number;
  scrollLeft: number;
}) {
  const visualScrollLeft = Math.max(0, args.scrollLeft);
  const sampleScrollLeft = Math.max(0, args.sampleScrollLeft ?? visualScrollLeft);
  const snappedScrollLeft = Math.round(visualScrollLeft);
  const sampleDisplayOffsetPx = sampleScrollLeft - snappedScrollLeft;

  return {
    sampleDisplayOffsetPx,
    snappedScrollLeft,
    transformPx: visualScrollLeft - snappedScrollLeft,
  };
}

export function resolveWaveformTileDisplayWidth(args: { renderScale: number; widthPx: number }) {
  const renderScale = clampNumber(args.renderScale, 0.001, 1);

  return Math.max(1, Math.ceil(Math.max(1, args.widthPx) * renderScale));
}

export function resolveWaveformTileDisplayRange(args: {
  contentWidth: number;
  renderScale: number;
  sourceStartPx: number;
  sourceWidthPx: number;
}): WaveformTileDisplayRange {
  const contentWidth = Math.max(1, Math.ceil(args.contentWidth));
  const renderScale = clampNumber(args.renderScale, 0.001, 1);
  const sourceStartPx = Math.max(0, Math.floor(args.sourceStartPx));
  const sourceEndPx = sourceStartPx + Math.max(1, Math.ceil(args.sourceWidthPx));
  const displayStartPx = clampInteger(Math.round(sourceStartPx * renderScale), 0, contentWidth - 1);
  const displayEndPx = clampInteger(
    Math.round(sourceEndPx * renderScale),
    displayStartPx + 1,
    contentWidth,
  );

  return {
    displayStartPx,
    displayWidthPx: displayEndPx - displayStartPx,
  };
}

export function resolveWaveformTileSourcePadding(args: { renderPixelsPerSecond: number }) {
  const minRenderScale = WAVEFORM_MIN_PIXELS_PER_SECOND / Math.max(1, args.renderPixelsPerSecond);

  return Math.ceil(1 / clampNumber(minRenderScale, 0.001, 1)) + 2;
}

export function resolveWaveformTileSourceFetchRange(args: {
  sourceContentWidth: number;
  sourcePaddingPx: number;
  sourceStartPx: number;
  sourceWidthPx: number;
}): WaveformTileSourceFetchRange {
  const sourceContentWidth = Math.max(1, Math.ceil(args.sourceContentWidth));
  const sourceStartPx = clampInteger(args.sourceStartPx, 0, sourceContentWidth - 1);
  const sourceEndPx = clampInteger(
    sourceStartPx + Math.max(1, Math.ceil(args.sourceWidthPx)),
    sourceStartPx + 1,
    sourceContentWidth,
  );
  const sourcePaddingPx = Math.max(0, Math.ceil(args.sourcePaddingPx));
  const fetchStartPx = clampInteger(sourceStartPx - sourcePaddingPx, 0, sourceEndPx - 1);
  const fetchEndPx = clampInteger(
    sourceEndPx + sourcePaddingPx,
    fetchStartPx + 1,
    sourceContentWidth,
  );

  return {
    fetchStartPx,
    fetchWidthPx: fetchEndPx - fetchStartPx,
  };
}

export function resolveWaveformCanvasBackingMetrics(args: {
  cssHeight: number;
  cssWidth: number;
  devicePixelRatio: number;
}) {
  const cssWidth = Math.max(1, Math.ceil(args.cssWidth));
  const cssHeight = Math.max(1, Math.ceil(args.cssHeight));
  const devicePixelRatio = clampNumber(args.devicePixelRatio, 1, 3);
  const backingWidth = Math.max(1, Math.ceil(cssWidth * devicePixelRatio));
  const backingHeight = Math.max(1, Math.ceil(cssHeight * devicePixelRatio));

  return {
    backingHeight,
    backingWidth,
    cssHeight,
    cssWidth,
    scaleX: backingWidth / cssWidth,
    scaleY: backingHeight / cssHeight,
  };
}

function resolveWaveformTileGeometry(args: {
  contentWidth: number;
  index: number;
  renderMetrics: ReturnType<typeof resolveWaveformRenderMetrics>;
}): WaveformTileGeometry {
  const sourceStartPx = args.index * WAVEFORM_TILE_WIDTH;
  const sourceWidthPx = Math.max(
    1,
    Math.min(WAVEFORM_TILE_WIDTH, args.renderMetrics.contentWidth - sourceStartPx),
  );

  return {
    sourceStartPx,
    sourceWidthPx,
    ...resolveWaveformTileDisplayRange({
      contentWidth: args.contentWidth,
      renderScale: args.renderMetrics.scale,
      sourceStartPx,
      sourceWidthPx,
    }),
    ...resolveWaveformTileSourceFetchRange({
      sourceContentWidth: args.renderMetrics.contentWidth,
      sourcePaddingPx: resolveWaveformTileSourcePadding({
        renderPixelsPerSecond: args.renderMetrics.pixelsPerSecond,
      }),
      sourceStartPx,
      sourceWidthPx,
    }),
  };
}

export function resolveWaveformTileSourcePixelRange(args: {
  displayStartPx?: number;
  displayPixelX: number;
  displaySampleOffsetPx?: number;
  renderScale: number;
  sourceStartPx?: number;
  sourcePixelCount: number;
}) {
  const sourcePixelCount = Math.max(0, Math.floor(args.sourcePixelCount));
  if (sourcePixelCount === 0) {
    return null;
  }

  const renderScale = clampNumber(args.renderScale, 0.001, 1);
  const displayStartPx = Math.max(0, args.displayStartPx ?? 0);
  const displaySampleOffsetPx = Number.isFinite(args.displaySampleOffsetPx)
    ? Number(args.displaySampleOffsetPx)
    : 0;
  const sourceStartPx = Math.max(0, args.sourceStartPx ?? 0);
  const globalDisplayStartPx =
    displayStartPx + Math.max(0, args.displayPixelX) + displaySampleOffsetPx;
  const startIndex = clampInteger(
    Math.floor(globalDisplayStartPx / renderScale) - sourceStartPx,
    0,
    sourcePixelCount - 1,
  );
  const endIndex = clampInteger(
    Math.ceil((globalDisplayStartPx + 1) / renderScale) - sourceStartPx,
    startIndex + 1,
    sourcePixelCount,
  );

  return { endIndex, startIndex };
}

export function resolveQuantizedWaveformDisplayPeak(args: {
  displayStartPx?: number;
  displayPixelX: number;
  displaySampleOffsetPx?: number;
  max: readonly number[];
  min: readonly number[];
  renderScale: number;
  sourceStartPx?: number;
}) {
  const sourcePixelCount = Math.min(args.min.length, args.max.length);
  const sourceRange = resolveWaveformTileSourcePixelRange({
    displayStartPx: args.displayStartPx,
    displayPixelX: args.displayPixelX,
    displaySampleOffsetPx: args.displaySampleOffsetPx,
    renderScale: args.renderScale,
    sourceStartPx: args.sourceStartPx,
    sourcePixelCount,
  });

  if (!sourceRange) {
    return { min: 0, max: 0 };
  }

  let min = 127;
  let max = -127;

  for (let index = sourceRange.startIndex; index < sourceRange.endIndex; index += 1) {
    min = Math.min(min, sanitizeQuantizedPeakValue(args.min[index]));
    max = Math.max(max, sanitizeQuantizedPeakValue(args.max[index]));
  }

  if (max < min) {
    return { min: 0, max: 0 };
  }

  return {
    min: min / 127,
    max: max / 127,
  };
}

export function resolveWaveformPeakRange(args: {
  peaks: readonly WaveformPeak[];
  pointsPerSecond: number;
  pixelsPerSecond: number;
  scrollLeft: number;
  pixelX: number;
}) {
  const peakCount = args.peaks.length;
  if (peakCount === 0 || args.pointsPerSecond <= 0 || args.pixelsPerSecond <= 0) {
    return { min: 0, max: 0 };
  }

  const indexRange = resolveWaveformPeakIndexRange({
    peakCount,
    pixelX: args.pixelX,
    pixelsPerSecond: args.pixelsPerSecond,
    pointsPerSecond: args.pointsPerSecond,
    scrollLeft: args.scrollLeft,
  });

  if (!indexRange) {
    return { min: 0, max: 0 };
  }

  let min = 1;
  let max = -1;

  for (let index = indexRange.startIndex; index < indexRange.endIndex; index += 1) {
    const peak = args.peaks[index];
    if (!peak) {
      continue;
    }

    min = Math.min(min, sanitizePeakValue(peak.min));
    max = Math.max(max, sanitizePeakValue(peak.max));
  }

  if (max < min) {
    return { min: 0, max: 0 };
  }

  return { min, max };
}

export function resolvePlaybackPositionMs(args: {
  snapshot: PlaybackSnapshot | null;
  nowMs: number;
  durationMs: number;
}) {
  const snapshot = args.snapshot;
  if (!snapshot) {
    return null;
  }

  const elapsedMs = snapshot.playing && !snapshot.paused ? args.nowMs - snapshot.received_at_ms : 0;
  return clampNumber(snapshot.position_ms + elapsedMs, 0, Math.max(0, args.durationMs));
}

export function resolveWaveformPlayheadX(args: {
  positionMs: number | null;
  pixelsPerSecond: number;
  scrollLeft: number;
}) {
  if (args.positionMs === null) {
    return null;
  }

  return (args.positionMs / 1000) * args.pixelsPerSecond - args.scrollLeft;
}

export function normalizeWaveformPathKey(path: string | null | undefined) {
  return path?.trim().replace(/\\/g, "/").toLowerCase() ?? "";
}

class WaveformTileController {
  private activeTileLoadCount = 0;
  private host: HTMLElement | null = null;
  private inputs: WaveformRenderInputs | null = null;
  private layerKey = "";
  private loadFrameId: number | null = null;
  private loadGeneration = 0;
  private offscreenRenderHandle: number | null = null;
  private offscreenRenderHandleType: "frame" | "idle" | null = null;
  private offscreenRenderOwnerWindow: Window | null = null;
  private playhead: HTMLDivElement | null = null;
  private playbackSnapshot: PlaybackSnapshot | null = null;
  private playheadFrameId: number | null = null;
  private pendingOffscreenRenderJob: WaveformOffscreenTileRenderJob | null = null;
  private playheadOpacity = "";
  private playheadTransform = "";
  private renderFrameId: number | null = null;
  private renderGeneration = 0;
  private renderLayer: HTMLDivElement | null = null;
  private scrollLeft = 0;
  private tileLayer: HTMLDivElement | null = null;
  private tileLoadQueue = new Set<number>();
  private tiles = new Map<number, WaveformTileNodeState>();
  private visualScrollLeft = 0;

  dispose() {
    this.cancelRenderFrame();
    this.cancelPlayheadFrame();
    this.cancelTileLoadFrame();
    this.cancelOffscreenTileRender();
    this.invalidateTileLoads();
    this.playbackSnapshot = null;
    this.clearTiles("dispose");
    this.renderLayer?.remove();
    this.renderLayer = null;
  }

  setHost(host: HTMLElement | null) {
    this.host = host;
    this.requestTileWindowRender();
    this.requestPlayheadRender();
  }

  setPlaybackSnapshot(snapshot: PlaybackSnapshot | null) {
    this.playbackSnapshot = snapshot;

    if (this.isPlaybackAdvancing()) {
      this.requestPlayheadRender();
      return;
    }

    this.cancelPlayheadFrame();
    this.renderPlayhead();
  }

  setPlayhead(playhead: HTMLDivElement | null) {
    this.playhead = playhead;
    this.playheadOpacity = "";
    this.playheadTransform = "";
    this.requestPlayheadRender();
  }

  setRenderInputs(inputs: WaveformRenderInputs) {
    const nextLayerKey = createWaveformTileIdentity(inputs);
    const previousInputs = this.inputs;
    const previousLayerKey = this.layerKey;
    const layerChanged = previousLayerKey !== nextLayerKey;

    this.inputs = inputs;
    this.updateRenderLayerPresentation();

    recordSpectrumWaveformTrace("controller-inputs", {
      contentWidth: inputs.contentWidth,
      layerChanged,
      nextLayerKey,
      pixelsPerSecond: inputs.pixelsPerSecond,
      previous: previousInputs
        ? {
            contentWidth: previousInputs.contentWidth,
            pixelsPerSecond: previousInputs.pixelsPerSecond,
            status: previousInputs.status,
            viewportWidth: previousInputs.viewportWidth,
          }
        : null,
      previousLayerKey,
      status: inputs.status,
      summaryCacheKey: inputs.summary.cache_key,
      tileCount: this.tiles.size,
      viewportWidth: inputs.viewportWidth,
    });

    if (layerChanged) {
      this.layerKey = nextLayerKey;
      this.clearTiles("identity-change");
    }

    this.requestTileWindowRender();
    this.requestPlayheadRender();
  }

  setScrollLeft(scrollLeft: number) {
    this.setViewportScroll({
      scrollLeft,
      visualScrollLeft: scrollLeft,
    });
  }

  setViewportScroll(args: { scrollLeft: number; visualScrollLeft?: number }) {
    const nextScrollLeft = Math.max(0, args.scrollLeft);
    const nextVisualScrollLeft = Math.max(0, args.visualScrollLeft ?? nextScrollLeft);
    if (
      Math.abs(nextScrollLeft - this.scrollLeft) < 0.5 &&
      Math.abs(nextVisualScrollLeft - this.visualScrollLeft) < 0.5
    ) {
      return;
    }

    recordSpectrumWaveformTrace("controller-scroll-left", {
      from: this.scrollLeft,
      to: nextScrollLeft,
      visualFrom: this.visualScrollLeft,
      visualTo: nextVisualScrollLeft,
    });

    this.scrollLeft = nextScrollLeft;
    this.visualScrollLeft = nextVisualScrollLeft;
    this.requestTileWindowRender();
    this.requestPlayheadRender();
  }

  getScrollLeft() {
    return this.scrollLeft;
  }

  renderTileWindowNow() {
    this.cancelRenderFrame();
    this.renderTileWindow();
  }

  recordAnchorSnapshot(args: { anchorViewportX: number; event: string; pixelsPerSecond: number }) {
    if (!isSpectrumWaveformTraceEnabled()) {
      return;
    }

    const inputs = this.inputs;
    const host = this.host;
    const renderLayer = this.renderLayer;
    const tileLayer = this.tileLayer;
    if (!inputs || !host || !renderLayer || !tileLayer) {
      recordSpectrumWaveformTrace(args.event, {
        anchorViewportX: args.anchorViewportX,
        reason: "missing-layer",
      });
      return;
    }

    const renderMetrics = resolveWaveformRenderMetrics(inputs);
    const alignment = resolveWaveformRasterAlignment({
      sampleScrollLeft: this.scrollLeft,
      scrollLeft: this.visualScrollLeft,
    });
    const hostRect = host.getBoundingClientRect();
    const anchorClientX = hostRect.left + args.anchorViewportX;
    const anchorSourcePx = (this.scrollLeft + args.anchorViewportX) / renderMetrics.scale;
    const tileSnapshots = Array.from(this.tiles.values())
      .map((tile) => {
        const rect = tile.canvas.getBoundingClientRect();
        const localCssX = anchorClientX - rect.left;
        const drawSourcePx =
          (tile.displayStartPx + localCssX + alignment.sampleDisplayOffsetPx) / renderMetrics.scale;
        const coversAnchor = localCssX >= 0 && localCssX <= rect.width;

        return {
          backingHeight: tile.canvas.height,
          backingWidth: tile.canvas.width,
          canvasClientWidth: tile.canvas.clientWidth,
          canvasOffsetWidth: tile.canvas.offsetWidth,
          coversAnchor,
          dataStartPx: tile.data?.start_px ?? null,
          dataWidthPx: tile.data?.width_px ?? null,
          displayStartPx: tile.displayStartPx,
          displayWidthPx: tile.displayWidthPx,
          drawDisplayStartPx: tile.drawDisplayStartPx,
          drawDisplayWidthPx: tile.drawDisplayWidthPx,
          drawSampleOffsetPx: tile.drawSampleOffsetPx,
          drawScale: tile.drawScale,
          drawSourceDeltaPx: drawSourcePx - anchorSourcePx,
          drawSourcePx,
          drawStatus: tile.drawStatus,
          fetchStartPx: tile.fetchStartPx,
          fetchWidthPx: tile.fetchWidthPx,
          index: tile.index,
          localCssX,
          rect: snapshotWaveformDomRect(rect),
          sourceStartPx: tile.sourceStartPx,
          sourceWidthPx: tile.sourceWidthPx,
          status: tile.status,
          styleLeft: tile.canvas.style.left,
          styleWidth: tile.canvas.style.width,
        };
      })
      .filter((tile) => tile.coversAnchor || Math.abs(tile.localCssX) < 400)
      .sort((left, right) => {
        if (left.coversAnchor !== right.coversAnchor) {
          return left.coversAnchor ? -1 : 1;
        }

        return Math.abs(left.localCssX) - Math.abs(right.localCssX);
      })
      .slice(0, 8);

    recordSpectrumWaveformTrace(args.event, {
      alignment,
      anchorClientX,
      anchorSourcePx,
      anchorViewportX: args.anchorViewportX,
      contentWidth: inputs.contentWidth,
      host: snapshotWaveformScrollElement(host),
      pixelsPerSecond: args.pixelsPerSecond,
      renderLayer: snapshotWaveformScrollElement(renderLayer),
      renderMetrics,
      scrollLeft: this.scrollLeft,
      tileCount: this.tiles.size,
      tileLayer: snapshotWaveformScrollElement(tileLayer),
      tiles: tileSnapshots,
      visualScrollLeft: this.visualScrollLeft,
    });
  }

  setTileLayer(tileLayer: HTMLDivElement | null) {
    if (this.tileLayer === tileLayer) {
      return;
    }

    this.clearTiles("tile-layer-change");
    this.renderLayer?.remove();
    this.renderLayer = null;
    this.tileLayer = tileLayer;
    this.ensureRenderLayer();
    this.requestTileWindowRender();
  }

  private applyPlayheadStyle(args: { opacity: string; transform: string }) {
    const playhead = this.playhead;
    if (!playhead) {
      return;
    }

    if (this.playheadOpacity !== args.opacity) {
      playhead.style.opacity = args.opacity;
      this.playheadOpacity = args.opacity;
    }

    if (this.playheadTransform !== args.transform) {
      playhead.style.transform = args.transform;
      this.playheadTransform = args.transform;
    }
  }

  private cancelPlayheadFrame() {
    if (this.playheadFrameId === null) {
      return;
    }

    this.getOwnerWindow()?.cancelAnimationFrame(this.playheadFrameId);
    this.playheadFrameId = null;
  }

  private cancelRenderFrame() {
    if (this.renderFrameId === null) {
      return;
    }

    this.getOwnerWindow()?.cancelAnimationFrame(this.renderFrameId);
    this.renderFrameId = null;
  }

  private cancelOffscreenTileRender() {
    if (this.offscreenRenderHandle === null) {
      this.pendingOffscreenRenderJob = null;
      return;
    }

    const ownerWindow = this.offscreenRenderOwnerWindow as WaveformIdleWindow | null;
    if (this.offscreenRenderHandleType === "idle") {
      ownerWindow?.cancelIdleCallback?.(this.offscreenRenderHandle);
    } else {
      ownerWindow?.cancelAnimationFrame(this.offscreenRenderHandle);
    }

    this.offscreenRenderHandle = null;
    this.offscreenRenderHandleType = null;
    this.offscreenRenderOwnerWindow = null;
    this.pendingOffscreenRenderJob = null;
  }

  private cancelTileLoadFrame() {
    if (this.loadFrameId === null) {
      return;
    }

    this.getOwnerWindow()?.cancelAnimationFrame(this.loadFrameId);
    this.loadFrameId = null;
  }

  private clearTiles(reason: string) {
    const tileCount = this.tiles.size;
    const queuedCount = this.tileLoadQueue.size;

    this.cancelOffscreenTileRender();
    this.invalidateTileLoads();

    for (const tile of this.tiles.values()) {
      tile.canvas.remove();
    }

    this.tiles.clear();

    recordSpectrumWaveformTrace("tiles-cleared", {
      queuedCount,
      reason,
      tileCount,
    });
  }

  private createTile(
    index: number,
    inputs: WaveformRenderInputs,
    renderMetrics: ReturnType<typeof resolveWaveformRenderMetrics>,
  ) {
    const host = this.host;
    const renderLayer = this.ensureRenderLayer();
    if (!host || !renderLayer) {
      return null;
    }

    const geometry = resolveWaveformTileGeometry({
      contentWidth: inputs.contentWidth,
      index,
      renderMetrics,
    });
    const canvas = renderLayer.ownerDocument.createElement("canvas");

    canvas.ariaHidden = "true";
    canvas.className = "pointer-events-none absolute top-0 block h-full";
    canvas.style.left = `${geometry.displayStartPx}px`;
    canvas.style.width = `${geometry.displayWidthPx}px`;
    canvas.style.height = `${WAVEFORM_CANVAS_HEIGHT}px`;
    renderLayer.append(canvas);

    const tile: WaveformTileNodeState = {
      canvas,
      data: null,
      displayStartPx: geometry.displayStartPx,
      displayWidthPx: geometry.displayWidthPx,
      fetchStartPx: geometry.fetchStartPx,
      fetchWidthPx: geometry.fetchWidthPx,
      drawDisplayStartPx: null,
      drawDisplayWidthPx: null,
      drawOpacity: null,
      drawSampleOffsetPx: null,
      drawScale: null,
      drawStatus: null,
      index,
      sourceStartPx: geometry.sourceStartPx,
      sourceWidthPx: geometry.sourceWidthPx,
      status: inputs.status === "ready" && Boolean(inputs.filePath) ? "pending" : "ready",
    };

    this.tiles.set(index, tile);
    this.drawTile(tile, inputs, renderMetrics.scale);
    return tile;
  }

  private ensureRenderLayer() {
    if (this.renderLayer) {
      return this.renderLayer;
    }

    const tileLayer = this.tileLayer;
    if (!tileLayer) {
      return null;
    }

    const renderLayer = tileLayer.ownerDocument.createElement("div");
    renderLayer.ariaHidden = "true";
    renderLayer.className = "pointer-events-none absolute inset-y-0 left-0 block h-full";
    renderLayer.style.height = `${WAVEFORM_CANVAS_HEIGHT}px`;
    renderLayer.style.transformOrigin = "left top";
    tileLayer.append(renderLayer);
    this.renderLayer = renderLayer;
    this.updateRenderLayerPresentation();

    return renderLayer;
  }

  private getOwnerWindow() {
    return (
      this.host?.ownerDocument.defaultView ??
      this.tileLayer?.ownerDocument.defaultView ??
      this.playhead?.ownerDocument.defaultView ??
      (typeof window === "undefined" ? null : window)
    );
  }

  private isPlaybackAdvancing() {
    return this.playbackSnapshot?.playing === true && this.playbackSnapshot.paused === false;
  }

  private getNow() {
    return this.getOwnerWindow()?.performance.now() ?? globalThis.performance?.now() ?? Date.now();
  }

  private invalidateTileLoads() {
    this.loadGeneration += 1;
    this.activeTileLoadCount = 0;
    this.tileLoadQueue.clear();
    this.cancelTileLoadFrame();
  }

  private async loadTile(
    tile: WaveformTileNodeState,
    inputs: WaveformRenderInputs,
    renderPixelsPerSecond: number,
    generation: number,
  ) {
    const filePath = inputs.filePath;
    const loadStartMs = this.getNow();

    if (!filePath || !this.host) {
      if (this.loadGeneration === generation) {
        this.activeTileLoadCount = Math.max(0, this.activeTileLoadCount - 1);
        this.requestTileLoadPump();
      }

      return;
    }

    recordSpectrumWaveformTrace("tile-load-start", {
      fetchStartPx: tile.fetchStartPx,
      fetchWidthPx: tile.fetchWidthPx,
      generation,
      index: tile.index,
      renderPixelsPerSecond,
    });

    try {
      const result = await commands.getTrackWaveformTile(
        filePath,
        normalizeWaveformBoundary(inputs.start),
        normalizeWaveformBoundary(inputs.end),
        renderPixelsPerSecond,
        tile.fetchStartPx,
        tile.fetchWidthPx,
      );

      if (result.status === "error") {
        throw new Error(result.error);
      }

      if (this.loadGeneration !== generation || this.tiles.get(tile.index) !== tile) {
        recordSpectrumWaveformTrace("tile-load-stale", {
          durationMs: this.getNow() - loadStartMs,
          generation,
          index: tile.index,
          loadGeneration: this.loadGeneration,
          mounted: this.tiles.get(tile.index) === tile,
        });
        return;
      }

      if (
        tile.fetchStartPx !== result.data.start_px ||
        tile.fetchWidthPx !== result.data.width_px
      ) {
        recordSpectrumWaveformTrace("tile-load-range-mismatch", {
          durationMs: this.getNow() - loadStartMs,
          expected: {
            startPx: tile.fetchStartPx,
            widthPx: tile.fetchWidthPx,
          },
          index: tile.index,
          received: {
            startPx: result.data.start_px,
            widthPx: result.data.width_px,
          },
        });
        tile.status = "pending";
        this.queueTileLoads([tile.index]);
        return;
      }

      tile.data = result.data;
      tile.status = "ready";
      recordSpectrumWaveformTrace("tile-load-ready", {
        durationMs: this.getNow() - loadStartMs,
        index: tile.index,
        maxLength: result.data.max.length,
        minLength: result.data.min.length,
        pointsPerSecond: result.data.points_per_second,
      });
      this.drawTileWithCurrentInputs(tile);
    } catch (error) {
      console.error("Failed to render waveform tile", error);
      recordSpectrumWaveformTrace("tile-load-error", {
        durationMs: this.getNow() - loadStartMs,
        error: error instanceof Error ? error.message : String(error),
        generation,
        index: tile.index,
      });
      if (this.loadGeneration === generation && this.tiles.get(tile.index) === tile) {
        tile.data = null;
        tile.status = "ready";
        this.drawTileWithCurrentInputs(tile);
      }
    } finally {
      if (this.loadGeneration === generation) {
        this.activeTileLoadCount = Math.max(0, this.activeTileLoadCount - 1);
        this.requestTileLoadPump();
      }
    }
  }

  private renderPlayhead() {
    const inputs = this.inputs;
    const snapshot = this.playbackSnapshot;
    if (!inputs || !snapshot) {
      this.applyPlayheadStyle({
        opacity: "0",
        transform: "translate3d(-9999px, 0, 0)",
      });
      return;
    }

    const positionMs = resolvePlaybackPositionMs({
      durationMs: inputs.summary.duration_ms,
      nowMs:
        this.getOwnerWindow()?.performance.now() ?? globalThis.performance?.now() ?? Date.now(),
      snapshot,
    });
    const playheadX = resolveWaveformPlayheadX({
      pixelsPerSecond: inputs.pixelsPerSecond,
      positionMs,
      scrollLeft: this.scrollLeft,
    });
    const isVisible =
      playheadX !== null && playheadX >= 0 && playheadX <= Math.max(1, inputs.viewportWidth);

    this.applyPlayheadStyle({
      opacity: isVisible ? "0.86" : "0",
      transform: isVisible
        ? `translate3d(${Math.round(playheadX)}px, 0, 0)`
        : "translate3d(-9999px, 0, 0)",
    });
  }

  private renderTileWindow() {
    const renderStartMs = this.getNow();
    const inputs = this.inputs;
    const renderLayer = this.ensureRenderLayer();
    if (!inputs || !renderLayer || !this.host || inputs.viewportWidth <= 0) {
      return;
    }

    this.updateRenderLayerPresentation();
    this.renderGeneration += 1;
    const generation = this.renderGeneration;

    const renderMetrics = resolveWaveformRenderMetrics(inputs);
    const renderViewport = resolveWaveformRenderViewport({
      renderScale: renderMetrics.scale,
      scrollLeft: this.scrollLeft,
      viewportWidth: inputs.viewportWidth,
    });
    const tileWindow = resolveWaveformTileWindow({
      contentWidth: renderMetrics.contentWidth,
      overscanTiles: WAVEFORM_TILE_OVERSCAN,
      scrollLeft: renderViewport.scrollLeft,
      tileWidth: WAVEFORM_TILE_WIDTH,
      viewportWidth: renderViewport.viewportWidth,
    });
    const visibleTileWindow = resolveWaveformTileWindow({
      contentWidth: renderMetrics.contentWidth,
      overscanTiles: 0,
      scrollLeft: renderViewport.scrollLeft,
      tileWidth: WAVEFORM_TILE_WIDTH,
      viewportWidth: renderViewport.viewportWidth,
    });
    const retentionTileWindow = resolveWaveformTileWindow({
      contentWidth: renderMetrics.contentWidth,
      overscanTiles: WAVEFORM_TILE_RETENTION_OVERSCAN,
      scrollLeft: renderViewport.scrollLeft,
      tileWidth: WAVEFORM_TILE_WIDTH,
      viewportWidth: renderViewport.viewportWidth,
    });

    if (!tileWindow || !visibleTileWindow || !retentionTileWindow) {
      this.clearTiles("empty-window");
      recordSpectrumWaveformTrace("tile-window-empty", {
        contentWidth: inputs.contentWidth,
        durationMs: this.getNow() - renderStartMs,
        renderMetrics,
        scrollLeft: this.scrollLeft,
        viewportWidth: inputs.viewportWidth,
      });
      return;
    }

    const renderPlan = resolveWaveformTileRenderPlan({
      mountedTileIndexes: this.tiles.keys(),
      retentionTileWindow,
      tileWindow,
      visibleTileWindow,
    });
    const stats = createWaveformTileRenderStats({
      removedTileCount: renderPlan.removeIndexes.length,
      tileCountBefore: this.tiles.size,
    });

    for (const index of renderPlan.removeIndexes) {
      const tile = this.tiles.get(index);
      if (tile) {
        this.removeTile(index, tile);
      }
    }

    for (const index of renderPlan.retainedSyncIndexes) {
      const tile = this.tiles.get(index);
      if (tile) {
        applyWaveformTileSyncStats(stats, this.syncTileGeometry(tile, inputs, renderMetrics));
      }
    }

    this.renderTileIndexes(renderPlan.visibleTileLoadOrder, inputs, renderMetrics, stats);
    this.queueTileLoads(renderPlan.visibleTileLoadOrder);
    this.scheduleOffscreenTileRender({
      generation,
      indexes: renderPlan.offscreenTileLoadOrder,
      inputs,
      renderMetrics,
    });

    recordSpectrumWaveformTrace("tile-window-render", () => ({
      contentWidth: inputs.contentWidth,
      durationMs: this.getNow() - renderStartMs,
      geometry: {
        host: this.host ? snapshotWaveformScrollElement(this.host) : null,
        renderLayer: this.renderLayer ? snapshotWaveformScrollElement(this.renderLayer) : null,
        tileLayer: this.tileLayer ? snapshotWaveformScrollElement(this.tileLayer) : null,
      },
      loadQueueSize: this.tileLoadQueue.size,
      mountedTileCount: this.tiles.size,
      pixelsPerSecond: inputs.pixelsPerSecond,
      renderMetrics,
      renderViewport,
      scrollLeft: this.scrollLeft,
      stats,
      status: inputs.status,
      offscreenTileLoadOrder: renderPlan.offscreenTileLoadOrder,
      removeTileIndexes: renderPlan.removeIndexes,
      retainedSyncIndexes: renderPlan.retainedSyncIndexes,
      tileLoadOrder: renderPlan.tileLoadOrder,
      tileWindow,
      visibleTileLoadOrder: renderPlan.visibleTileLoadOrder,
      visibleTileWindow,
      visualScrollLeft: this.visualScrollLeft,
      viewportWidth: inputs.viewportWidth,
    }));
  }

  private renderTileIndexes(
    indexes: readonly number[],
    inputs: WaveformRenderInputs,
    renderMetrics: ReturnType<typeof resolveWaveformRenderMetrics>,
    stats: WaveformTileRenderStats,
  ) {
    for (const index of indexes) {
      let tile: WaveformTileNodeState | null | undefined = this.tiles.get(index);

      if (!tile) {
        tile = this.createTile(index, inputs, renderMetrics);
        if (tile) {
          stats.createdTileCount += 1;
        }
      }

      if (!tile) {
        continue;
      }

      const syncResult = this.syncTileGeometry(tile, inputs, renderMetrics);
      const drawResult = this.drawTile(tile, inputs, renderMetrics.scale);

      applyWaveformTileRenderStats(stats, syncResult, drawResult);
    }
  }

  private drawTile(
    tile: WaveformTileNodeState,
    inputs: WaveformRenderInputs,
    renderScale: number,
  ): WaveformTileDrawResult {
    const host = this.host;
    if (!host) {
      return "skipped";
    }

    const drawStatus = tile.data ? "data" : "placeholder";
    const drawOpacity = tile.data
      ? inputs.opacity
      : inputs.status === "ready"
        ? WAVEFORM_INACTIVE_OPACITY
        : inputs.opacity;
    const sampleOffsetPx = resolveWaveformRasterAlignment({
      sampleScrollLeft: this.scrollLeft,
      scrollLeft: this.visualScrollLeft,
    }).sampleDisplayOffsetPx;

    if (
      tile.drawStatus === drawStatus &&
      tile.drawDisplayStartPx === tile.displayStartPx &&
      tile.drawDisplayWidthPx === tile.displayWidthPx &&
      tile.drawOpacity === drawOpacity &&
      tile.drawSampleOffsetPx !== null &&
      Math.abs(tile.drawSampleOffsetPx - sampleOffsetPx) < 0.0001 &&
      tile.drawScale !== null &&
      Math.abs(tile.drawScale - renderScale) < 0.0001
    ) {
      return "skipped";
    }

    if (tile.data) {
      drawQuantizedWaveformTile({
        canvas: tile.canvas,
        displayStartPx: tile.displayStartPx,
        displaySampleOffsetPx: sampleOffsetPx,
        displayWidthPx: tile.displayWidthPx,
        host,
        opacity: drawOpacity,
        renderScale,
        tile: tile.data,
      });
    } else {
      drawPlaceholderWaveformTile({
        canvas: tile.canvas,
        displayStartPx: tile.displayStartPx,
        displaySampleOffsetPx: sampleOffsetPx,
        displayWidthPx: tile.displayWidthPx,
        host,
        opacity: drawOpacity,
        renderScale,
      });
    }

    tile.drawOpacity = drawOpacity;
    tile.drawSampleOffsetPx = sampleOffsetPx;
    tile.drawScale = renderScale;
    tile.drawStatus = drawStatus;
    tile.drawDisplayStartPx = tile.displayStartPx;
    tile.drawDisplayWidthPx = tile.displayWidthPx;
    return drawStatus;
  }

  private drawTileWithCurrentInputs(tile: WaveformTileNodeState) {
    const inputs = this.inputs;
    if (!inputs) {
      return;
    }

    this.drawTile(tile, inputs, resolveWaveformRenderMetrics(inputs).scale);
  }

  private scheduleOffscreenTileRender(job: WaveformOffscreenTileRenderJob) {
    if (job.indexes.length === 0) {
      this.cancelOffscreenTileRender();
      return;
    }

    this.pendingOffscreenRenderJob = job;

    if (this.offscreenRenderHandle !== null) {
      return;
    }

    const ownerWindow = this.getOwnerWindow() as WaveformIdleWindow | null;
    if (!ownerWindow) {
      this.runOffscreenTileRender({
        didTimeout: true,
        timeRemaining: () => Number.POSITIVE_INFINITY,
      });
      return;
    }

    this.offscreenRenderOwnerWindow = ownerWindow;

    if (ownerWindow.requestIdleCallback) {
      this.offscreenRenderHandleType = "idle";
      this.offscreenRenderHandle = ownerWindow.requestIdleCallback(
        (deadline) => {
          this.runOffscreenTileRender(deadline);
        },
        { timeout: WAVEFORM_OFFSCREEN_RENDER_IDLE_TIMEOUT_MS },
      );
      return;
    }

    this.offscreenRenderHandleType = "frame";
    this.offscreenRenderHandle = ownerWindow.requestAnimationFrame(() => {
      this.runOffscreenTileRender({
        didTimeout: true,
        timeRemaining: () => Number.POSITIVE_INFINITY,
      });
    });
  }

  private runOffscreenTileRender(deadline: WaveformIdleDeadline) {
    const renderStartMs = this.getNow();
    const job = this.pendingOffscreenRenderJob;

    this.offscreenRenderHandle = null;
    this.offscreenRenderHandleType = null;
    this.offscreenRenderOwnerWindow = null;
    this.pendingOffscreenRenderJob = null;

    if (!job || job.generation !== this.renderGeneration || job.inputs !== this.inputs) {
      return;
    }

    const indexes: number[] = [];
    let remainingIndexes: number[] = [];

    for (const index of job.indexes) {
      if (indexes.length > 0 && !deadline.didTimeout && deadline.timeRemaining() < 2) {
        remainingIndexes = job.indexes.slice(indexes.length);
        break;
      }

      indexes.push(index);
    }

    const stats = createWaveformTileRenderStats({
      removedTileCount: 0,
      tileCountBefore: this.tiles.size,
    });
    this.renderTileIndexes(indexes, job.inputs, job.renderMetrics, stats);
    this.queueTileLoads(indexes);

    recordSpectrumWaveformTrace("tile-offscreen-render", {
      durationMs: this.getNow() - renderStartMs,
      indexes,
      remainingCount: remainingIndexes.length,
      stats,
    });

    if (remainingIndexes.length > 0) {
      this.scheduleOffscreenTileRender({
        ...job,
        indexes: remainingIndexes,
      });
    }
  }

  private pumpTileLoads() {
    this.loadFrameId = null;

    const inputs = this.inputs;
    if (!inputs || inputs.status !== "ready" || !inputs.filePath) {
      this.tileLoadQueue.clear();
      return;
    }

    const generation = this.loadGeneration;
    const renderMetrics = resolveWaveformRenderMetrics(inputs);

    while (
      this.activeTileLoadCount < WAVEFORM_TILE_LOAD_CONCURRENCY &&
      this.tileLoadQueue.size > 0
    ) {
      const nextEntry = this.tileLoadQueue.values().next();
      if (nextEntry.done) {
        break;
      }

      const nextIndex = nextEntry.value;
      this.tileLoadQueue.delete(nextIndex);

      const tile = this.tiles.get(nextIndex);
      if (!tile || tile.status !== "pending") {
        continue;
      }

      tile.status = "loading";
      this.activeTileLoadCount += 1;
      void this.loadTile(tile, inputs, renderMetrics.pixelsPerSecond, generation);
    }
  }

  private queueTileLoads(indexes: readonly number[]) {
    const nextQueue = new Set<number>();

    for (const index of indexes) {
      const tile = this.tiles.get(index);
      if (tile?.status === "pending") {
        nextQueue.add(index);
      }
    }

    for (const index of this.tileLoadQueue) {
      const tile = this.tiles.get(index);
      if (tile?.status === "pending") {
        nextQueue.add(index);
      }
    }

    this.tileLoadQueue = nextQueue;
    this.requestTileLoadPump();
  }

  private removeTile(index: number, tile: WaveformTileNodeState) {
    tile.canvas.remove();
    this.tiles.delete(index);
    this.tileLoadQueue.delete(index);
  }

  private requestPlayheadRender() {
    if (this.playheadFrameId !== null) {
      return;
    }

    const ownerWindow = this.getOwnerWindow();
    if (!ownerWindow) {
      this.renderPlayhead();
      return;
    }

    this.playheadFrameId = ownerWindow.requestAnimationFrame(() => {
      this.playheadFrameId = null;
      this.renderPlayhead();

      if (this.isPlaybackAdvancing()) {
        this.requestPlayheadRender();
      }
    });
  }

  private requestTileWindowRender() {
    if (this.renderFrameId !== null) {
      return;
    }

    const ownerWindow = this.getOwnerWindow();
    if (!ownerWindow) {
      this.renderTileWindow();
      return;
    }

    this.renderFrameId = ownerWindow.requestAnimationFrame(() => {
      this.renderFrameId = null;
      this.renderTileWindow();
    });
  }

  private requestTileLoadPump() {
    if (this.loadFrameId !== null || this.tileLoadQueue.size === 0) {
      return;
    }

    const ownerWindow = this.getOwnerWindow();
    if (!ownerWindow) {
      this.pumpTileLoads();
      return;
    }

    this.loadFrameId = ownerWindow.requestAnimationFrame(() => {
      this.pumpTileLoads();
    });
  }

  private updateRenderLayerPresentation() {
    const inputs = this.inputs;
    const renderLayer = this.renderLayer;
    if (!inputs || !renderLayer) {
      return;
    }

    renderLayer.style.width = `${inputs.contentWidth}px`;
    const alignment = resolveWaveformRasterAlignment({
      sampleScrollLeft: this.scrollLeft,
      scrollLeft: this.visualScrollLeft,
    });

    renderLayer.style.transform =
      Math.abs(alignment.transformPx) < 0.001
        ? "none"
        : `translate3d(${alignment.transformPx}px, 0, 0)`;
  }

  private syncTileGeometry(
    tile: WaveformTileNodeState,
    inputs: WaveformRenderInputs,
    renderMetrics: ReturnType<typeof resolveWaveformRenderMetrics>,
  ): WaveformTileSyncResult {
    const geometry = resolveWaveformTileGeometry({
      contentWidth: inputs.contentWidth,
      index: tile.index,
      renderMetrics,
    });
    const sourceChanged =
      tile.sourceStartPx !== geometry.sourceStartPx ||
      tile.sourceWidthPx !== geometry.sourceWidthPx ||
      tile.fetchStartPx !== geometry.fetchStartPx ||
      tile.fetchWidthPx !== geometry.fetchWidthPx;
    const displayChanged =
      tile.displayStartPx !== geometry.displayStartPx ||
      tile.displayWidthPx !== geometry.displayWidthPx;

    if (!sourceChanged && !displayChanged) {
      return {
        dataReset: false,
        displayChanged: false,
        sourceChanged: false,
      };
    }

    tile.sourceStartPx = geometry.sourceStartPx;
    tile.sourceWidthPx = geometry.sourceWidthPx;
    tile.fetchStartPx = geometry.fetchStartPx;
    tile.fetchWidthPx = geometry.fetchWidthPx;
    tile.displayStartPx = geometry.displayStartPx;
    tile.displayWidthPx = geometry.displayWidthPx;
    tile.canvas.style.left = `${geometry.displayStartPx}px`;
    tile.canvas.style.width = `${geometry.displayWidthPx}px`;
    tile.drawOpacity = null;
    tile.drawSampleOffsetPx = null;
    tile.drawScale = null;
    tile.drawStatus = null;
    tile.drawDisplayStartPx = null;
    tile.drawDisplayWidthPx = null;

    if (sourceChanged) {
      tile.data = null;
      tile.status = inputs.status === "ready" && Boolean(inputs.filePath) ? "pending" : "ready";
    }

    return {
      dataReset: sourceChanged,
      displayChanged,
      sourceChanged,
    };
  }
}

class WaveformZoomController {
  apply(args: {
    anchorViewportX: number;
    deltaY: number;
    scrollElements: WaveformScrollElements;
    scrollLeft: number;
    wheelState: WaveformWheelState;
  }) {
    const ownerWindow = args.scrollElements.viewport.ownerDocument.defaultView;
    const applyStartMs = readWaveformPerformanceNow(ownerWindow);
    const base = {
      pixelsPerSecond: args.wheelState.pixelsPerSecond,
      scrollLeft: args.scrollLeft,
    };
    const nextFrame = resolveWaveformZoomFrame({
      anchorViewportX: args.anchorViewportX,
      currentPixelsPerSecond: base.pixelsPerSecond,
      deltaY: args.deltaY,
      durationMs: args.wheelState.summary.duration_ms,
      scrollLeft: base.scrollLeft,
      viewportWidth: args.wheelState.viewportWidth,
    });
    const changed =
      Math.abs(nextFrame.pixelsPerSecond - base.pixelsPerSecond) >= 0.01 ||
      Math.abs(nextFrame.scrollLeft - base.scrollLeft) >= 0.5;

    if (!changed) {
      recordSpectrumWaveformTrace("zoom-schedule-ignored", {
        base,
        deltaY: args.deltaY,
        reason: "clamped",
      });
      return false;
    }

    const commit = {
      ...nextFrame,
      controller: args.wheelState.controller,
      scrollElements: args.scrollElements,
      setPixelsPerSecond: args.wheelState.setPixelsPerSecond,
    };
    recordSpectrumWaveformTrace("zoom-schedule", () => ({
      base,
      deltaY: args.deltaY,
      mode: "sync",
      nextFrame,
      pendingWheelCount: 1,
      wasPending: false,
    }));
    this.commit(commit, {
      applyStartMs,
      ownerWindow,
    });
    return true;
  }

  private commit(
    pending: WaveformZoomCommit,
    args: {
      applyStartMs: number;
      ownerWindow: Window | null;
    },
  ) {
    const ownerWindow = args.ownerWindow;
    const commitStartMs = readWaveformPerformanceNow(ownerWindow);
    const flushSyncStartMs = commitStartMs;
    flushSync(() => {
      pending.setPixelsPerSecond((current) =>
        Math.abs(current - pending.pixelsPerSecond) < 0.01 ? current : pending.pixelsPerSecond,
      );
    });
    const flushSyncEndMs = readWaveformPerformanceNow(ownerWindow);
    const scrollWriteStartMs = flushSyncEndMs;
    writeWaveformScrollLeft(pending.scrollElements, pending.scrollLeft);
    const scrollWriteEndMs = readWaveformPerformanceNow(ownerWindow);
    const actualScrollLeft = readWaveformScrollLeft(pending.scrollElements);
    const controllerScrollStartMs = scrollWriteEndMs;
    pending.controller.setViewportScroll({
      scrollLeft: pending.scrollLeft,
      visualScrollLeft: actualScrollLeft,
    });
    const controllerScrollEndMs = readWaveformPerformanceNow(ownerWindow);
    const renderStartMs = controllerScrollEndMs;
    pending.controller.renderTileWindowNow();
    pending.controller.recordAnchorSnapshot({
      anchorViewportX: pending.anchorViewportX,
      event: "zoom-canvas-anchor",
      pixelsPerSecond: pending.pixelsPerSecond,
    });
    const renderEndMs = readWaveformPerformanceNow(ownerWindow);
    const actualAnchorSeconds =
      (actualScrollLeft + pending.anchorViewportX) / pending.pixelsPerSecond;
    const logicalAnchorSeconds =
      (pending.scrollLeft + pending.anchorViewportX) / pending.pixelsPerSecond;

    recordSpectrumWaveformTrace("zoom-commit", () => ({
      actualAnchorSeconds,
      actualScrollLeft,
      anchorDriftPx: (logicalAnchorSeconds - pending.anchorSeconds) * pending.pixelsPerSecond,
      anchorViewportX: pending.anchorViewportX,
      contentWidth: pending.contentWidth,
      domAnchorDriftPx: (actualAnchorSeconds - pending.anchorSeconds) * pending.pixelsPerSecond,
      durationMs: renderEndMs - commitStartMs,
      firstScheduleToCommitMs: commitStartMs - args.applyStartMs,
      lastScheduleToCommitMs: commitStartMs - args.applyStartMs,
      pendingWheelCount: 1,
      pixelsPerSecond: pending.pixelsPerSecond,
      scrollLeft: pending.scrollLeft,
      timing: {
        controllerScrollMs: controllerScrollEndMs - controllerScrollStartMs,
        flushSyncMs: flushSyncEndMs - flushSyncStartMs,
        renderTileWindowMs: renderEndMs - renderStartMs,
        scrollWriteMs: scrollWriteEndMs - scrollWriteStartMs,
      },
      trigger: "sync",
      scroll: snapshotWaveformScrollElements(pending.scrollElements),
    }));

    if (isSpectrumWaveformTraceEnabled()) {
      ownerWindow?.requestAnimationFrame(() => {
        const nextFrameActualScrollLeft = readWaveformScrollLeft(pending.scrollElements);
        const nextFrameActualAnchorSeconds =
          (nextFrameActualScrollLeft + pending.anchorViewportX) / pending.pixelsPerSecond;
        const nextFrameLogicalAnchorSeconds =
          (pending.scrollLeft + pending.anchorViewportX) / pending.pixelsPerSecond;

        recordSpectrumWaveformTrace("zoom-commit-next-frame", () => ({
          actualAnchorSeconds: nextFrameActualAnchorSeconds,
          actualScrollLeft: nextFrameActualScrollLeft,
          anchorDriftPx:
            (nextFrameLogicalAnchorSeconds - pending.anchorSeconds) * pending.pixelsPerSecond,
          anchorViewportX: pending.anchorViewportX,
          domAnchorDriftPx:
            (nextFrameActualAnchorSeconds - pending.anchorSeconds) * pending.pixelsPerSecond,
          elapsedMs: readWaveformPerformanceNow(ownerWindow) - commitStartMs,
          pixelsPerSecond: pending.pixelsPerSecond,
          scroll: snapshotWaveformScrollElements(pending.scrollElements),
        }));
        pending.controller.recordAnchorSnapshot({
          anchorViewportX: pending.anchorViewportX,
          event: "zoom-canvas-anchor-next-frame",
          pixelsPerSecond: pending.pixelsPerSecond,
        });
      });
    }
  }
}

function useWaveformTileController() {
  const controllerRef = useRef<WaveformTileController | null>(null);

  if (controllerRef.current === null) {
    controllerRef.current = new WaveformTileController();
  }

  return controllerRef.current;
}

function useWaveformZoomController() {
  const controllerRef = useRef<WaveformZoomController | null>(null);

  if (controllerRef.current === null) {
    controllerRef.current = new WaveformZoomController();
  }

  return controllerRef.current;
}

export function TrackSpectrum(props: {
  className?: string;
  filePath: string | null;
  start: number | null;
  end: number | null;
}) {
  const placeholderSummary = useMemo(() => createPlaceholderWaveformSummary(), []);
  const controller = useWaveformTileController();
  const zoomController = useWaveformZoomController();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollbarsRef = useRef<OverlayScrollbarsComponentRef<"div"> | null>(null);
  const wheelStateRef = useRef<WaveformWheelState | null>(null);
  const [viewportWidth, setViewportWidth] = useState(1);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(WAVEFORM_INITIAL_PIXELS_PER_SECOND);
  const [state, setState] = useState<{ status: WaveformStatus; summary: TrackWaveformSummary }>({
    status: "idle",
    summary: placeholderSummary,
  });
  const summary = state.summary;
  const contentWidth = resolveWaveformContentWidth({
    durationMs: summary.duration_ms,
    pixelsPerSecond,
    viewportWidth,
  });

  wheelStateRef.current = {
    contentWidth,
    controller,
    pixelsPerSecond,
    setPixelsPerSecond,
    summary,
    viewportWidth,
  };

  const handleHostRef = useCallback(
    (node: HTMLDivElement | null) => {
      hostRef.current = node;
      controller.setHost(node);
    },
    [controller],
  );
  const handlePlayheadRef = useCallback(
    (node: HTMLDivElement | null) => {
      controller.setPlayhead(node);
    },
    [controller],
  );
  const handleTileLayerRef = useCallback(
    (node: HTMLDivElement | null) => {
      controller.setTileLayer(node);
    },
    [controller],
  );
  const handleViewportWheel = useCallback(
    (event: WaveformWheelEvent) => {
      const wheelState = wheelStateRef.current;
      const scrollElements = getWaveformScrollElements(scrollbarsRef.current);

      if (!wheelState || !scrollElements) {
        return;
      }

      if (!isWaveformWheelTargetInViewport(event, scrollElements)) {
        return;
      }

      handleWaveformViewportWheel({
        event,
        scrollElements,
        wheelState,
        zoomController,
      });
    },
    [zoomController],
  );
  const scrollEvents = useMemo<EventListeners>(
    () => ({
      scroll: (instance) => {
        const elements = instance.elements();
        const scrollLeft = readWaveformScrollLeft(elements);

        recordSpectrumWaveformTrace("overlay-scroll", () => ({
          scroll: snapshotWaveformScrollElements(elements),
          scrollLeft,
        }));
        controller.setScrollLeft(scrollLeft);
      },
    }),
    [controller],
  );

  useLayoutEffect(() => {
    installSpectrumWaveformTrace();
  }, []);

  useEffect(() => {
    recordSpectrumWaveformTrace("react-render-state", {
      contentWidth,
      durationMs: summary.duration_ms,
      pixelsPerSecond,
      status: state.status,
      summaryCacheKey: summary.cache_key,
      viewportWidth,
    });
  }, [
    contentWidth,
    pixelsPerSecond,
    state.status,
    summary.cache_key,
    summary.duration_ms,
    viewportWidth,
  ]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    const syncWidth = () => {
      const nextViewportWidth = Math.max(1, Math.ceil(host.getBoundingClientRect().width));
      setViewportWidth((current) => (current === nextViewportWidth ? current : nextViewportWidth));
    };

    syncWidth();

    const ResizeObserverConstructor = (
      window as typeof window & { ResizeObserver?: typeof ResizeObserver }
    ).ResizeObserver;

    if (!ResizeObserverConstructor) {
      window.addEventListener("resize", syncWidth);
      return () => {
        window.removeEventListener("resize", syncWidth);
      };
    }

    const observer = new ResizeObserverConstructor(syncWidth);
    observer.observe(host);

    return () => {
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    host.addEventListener("wheel", handleViewportWheel, {
      capture: true,
      passive: false,
    });

    return () => {
      host.removeEventListener("wheel", handleViewportWheel, true);
    };
  }, [handleViewportWheel]);

  useLayoutEffect(() => {
    controller.setRenderInputs({
      contentWidth,
      end: props.end,
      filePath: props.filePath?.trim() || null,
      opacity: state.status === "ready" ? 1 : WAVEFORM_INACTIVE_OPACITY,
      pixelsPerSecond,
      start: props.start,
      status: state.status,
      summary,
      viewportWidth,
    });
  }, [
    contentWidth,
    controller,
    pixelsPerSecond,
    props.end,
    props.filePath,
    props.start,
    state.status,
    summary,
    viewportWidth,
  ]);

  useEffect(() => {
    return () => {
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    const filePath = props.filePath?.trim();
    resetWaveformScrollPosition({
      controller,
      scrollbarsRef,
    });

    if (!filePath) {
      setState({
        status: "idle",
        summary: placeholderSummary,
      });
      controller.setPlaybackSnapshot(null);
      return;
    }

    let cancelled = false;
    setState({
      status: "loading",
      summary: placeholderSummary,
    });

    void commands
      .prepareTrackWaveform(
        filePath,
        normalizeWaveformBoundary(props.start),
        normalizeWaveformBoundary(props.end),
      )
      .then((result) => {
        if (cancelled) {
          return;
        }

        if (result.status === "error") {
          throw new Error(result.error);
        }

        setState({
          status: "ready",
          summary: result.data,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to prepare track waveform", error);
        setState({
          status: "error",
          summary: placeholderSummary,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [controller, placeholderSummary, props.end, props.filePath, props.start]);

  useEffect(() => {
    const filePath = props.filePath?.trim();
    controller.setPlaybackSnapshot(null);

    if (!filePath) {
      return undefined;
    }

    let cancelled = false;
    const refreshPlaybackStatus = async () => {
      try {
        const result = await commands.getPlaybackStatus();
        if (cancelled) {
          return;
        }

        if (
          result.status === "error" ||
          !result.data ||
          !isPlaybackStatusForTrack(result.data, filePath)
        ) {
          controller.setPlaybackSnapshot(null);
          return;
        }

        controller.setPlaybackSnapshot({
          ...result.data,
          received_at_ms: performance.now(),
        });
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to refresh playback status", error);
          controller.setPlaybackSnapshot(null);
        }
      }
    };

    void refreshPlaybackStatus();
    const intervalId = window.setInterval(() => {
      void refreshPlaybackStatus();
    }, PLAYBACK_STATUS_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      controller.setPlaybackSnapshot(null);
    };
  }, [controller, props.filePath]);

  return (
    <motion.div
      ref={handleHostRef}
      aria-label="Current track waveform"
      data-waveform-status={state.status}
      className={cn(
        "relative h-[13rem] w-full overflow-hidden text-black dark:text-white",
        props.className,
      )}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        duration: 0.34,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      <OverlayScrollbarsComponent
        ref={scrollbarsRef}
        defer
        options={waveformScrollOptions}
        events={scrollEvents}
        className="spectrum-waveform-scroll h-full w-full"
      >
        <div className="pointer-events-none relative h-full" style={{ width: contentWidth }}>
          <div
            ref={handleTileLayerRef}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0"
            style={{ width: contentWidth, height: WAVEFORM_CANVAS_HEIGHT }}
          />
        </div>
      </OverlayScrollbarsComponent>
      <div
        ref={handlePlayheadRef}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-[2] w-px bg-current opacity-0 will-change-transform"
      />
    </motion.div>
  );
}

function createPlaceholderWaveformSummary(): TrackWaveformSummary {
  return {
    base_points_per_second: WAVEFORM_PLACEHOLDER_POINTS_PER_SECOND,
    cache_key: "placeholder",
    chunk_duration_ms: 2_000,
    duration_ms: WAVEFORM_PLACEHOLDER_DURATION_MS,
    levels: [WAVEFORM_PLACEHOLDER_POINTS_PER_SECOND],
    sample_rate: 48_000,
    samples_per_point: 600,
    start_ms: 0,
  };
}

function resolveWaveformRenderMetrics(inputs: WaveformRenderInputs) {
  const pixelsPerSecond = resolveWaveformRenderPixelsPerSecond(inputs.summary);
  const scale = resolveWaveformRenderScale({
    pixelsPerSecond: inputs.pixelsPerSecond,
    renderPixelsPerSecond: pixelsPerSecond,
  });
  const contentWidth = resolveWaveformRenderContentWidth({
    durationMs: inputs.summary.duration_ms,
    pixelsPerSecond: inputs.pixelsPerSecond,
    renderPixelsPerSecond: pixelsPerSecond,
    viewportWidth: inputs.viewportWidth,
  });

  return {
    contentWidth,
    pixelsPerSecond,
    scale,
  };
}

function createWaveformTileIdentity(inputs: WaveformRenderInputs) {
  const renderMetrics = resolveWaveformRenderMetrics(inputs);

  return [
    inputs.filePath ?? "",
    inputs.start ?? "",
    inputs.end ?? "",
    inputs.summary.cache_key,
    renderMetrics.pixelsPerSecond,
    inputs.status,
  ].join("|");
}

function drawPlaceholderWaveformTile(args: {
  canvas: HTMLCanvasElement;
  displayStartPx: number;
  displaySampleOffsetPx: number;
  displayWidthPx: number;
  host: HTMLElement;
  opacity: number;
  renderScale: number;
}) {
  const renderScale = clampNumber(args.renderScale, 0.001, 1);

  drawWaveformTileFrame({
    canvas: args.canvas,
    displayWidthPx: args.displayWidthPx,
    host: args.host,
    opacity: args.opacity,
    resolvePeak: (x) => {
      const index = (args.displayStartPx + x + args.displaySampleOffsetPx) / renderScale;
      const primary = Math.sin(index * 0.11) * 0.18;
      const secondary = Math.sin(index * 0.47 + 1.3) * 0.14;
      const ridge = Math.sin(index * 1.7) > 0.72 ? 0.2 : 0;
      const amplitude = clampNumber(0.34 + primary + secondary + ridge, 0.08, 0.86);

      return {
        min: -amplitude,
        max: amplitude,
      };
    },
  });
}

function drawQuantizedWaveformTile(args: {
  canvas: HTMLCanvasElement;
  displayStartPx: number;
  displaySampleOffsetPx: number;
  displayWidthPx: number;
  host: HTMLElement;
  opacity: number;
  renderScale: number;
  tile: TrackWaveformTile;
}) {
  drawWaveformTileFrame({
    canvas: args.canvas,
    displayWidthPx: args.displayWidthPx,
    host: args.host,
    opacity: args.opacity,
    resolvePeak: (x) =>
      resolveQuantizedWaveformDisplayPeak({
        displayStartPx: args.displayStartPx,
        displayPixelX: x,
        displaySampleOffsetPx: args.displaySampleOffsetPx,
        max: args.tile.max,
        min: args.tile.min,
        renderScale: args.renderScale,
        sourceStartPx: args.tile.start_px,
      }),
  });
}

function drawWaveformTileFrame(args: {
  canvas: HTMLCanvasElement;
  displayWidthPx: number;
  host: HTMLElement;
  opacity: number;
  resolvePeak: (pixelX: number) => { min: number; max: number };
}) {
  const ownerWindow = args.canvas.ownerDocument.defaultView;
  const width = Math.max(1, Math.ceil(args.displayWidthPx));
  const height = Math.max(1, Math.ceil(args.canvas.clientHeight || WAVEFORM_CANVAS_HEIGHT));
  const backingMetrics = resolveWaveformCanvasBackingMetrics({
    cssHeight: height,
    cssWidth: width,
    devicePixelRatio: ownerWindow?.devicePixelRatio || 1,
  });

  if (
    args.canvas.width !== backingMetrics.backingWidth ||
    args.canvas.height !== backingMetrics.backingHeight
  ) {
    args.canvas.width = backingMetrics.backingWidth;
    args.canvas.height = backingMetrics.backingHeight;
  }

  const context = args.canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.setTransform(backingMetrics.scaleX, 0, 0, backingMetrics.scaleY, 0, 0);
  context.clearRect(0, 0, width, height);

  const color = ownerWindow?.getComputedStyle(args.host).color || "currentColor";
  const baselineY = height / 2;
  const verticalScale = Math.max(1, height / 2 - WAVEFORM_VERTICAL_PADDING);

  context.lineWidth = 1;
  context.strokeStyle = color;
  context.globalAlpha = 0.1;
  context.beginPath();
  context.moveTo(0, baselineY + 0.5);
  context.lineTo(width, baselineY + 0.5);
  context.stroke();

  context.globalAlpha = args.opacity;
  context.strokeStyle = color;
  context.beginPath();

  for (let x = 0; x < width; x += 1) {
    const peak = args.resolvePeak(x);
    const yFromMax = baselineY - sanitizePeakValue(peak.max) * verticalScale;
    const yFromMin = baselineY - sanitizePeakValue(peak.min) * verticalScale;
    const top = Math.min(yFromMax, yFromMin);
    const bottom = Math.max(yFromMax, yFromMin);
    const resolvedTop = bottom - top < 1 ? baselineY - 0.5 : top;
    const resolvedBottom = bottom - top < 1 ? baselineY + 0.5 : bottom;

    context.moveTo(x + 0.5, resolvedTop);
    context.lineTo(x + 0.5, resolvedBottom);
  }

  context.stroke();
  context.globalAlpha = 1;
}

function resolveWaveformPeakIndexRange(args: {
  peakCount: number;
  pixelX: number;
  pixelsPerSecond: number;
  pointsPerSecond: number;
  scrollLeft: number;
}) {
  if (args.peakCount === 0 || args.pointsPerSecond <= 0 || args.pixelsPerSecond <= 0) {
    return null;
  }

  const pixelStartSeconds = (args.scrollLeft + args.pixelX) / args.pixelsPerSecond;
  const pixelEndSeconds = (args.scrollLeft + args.pixelX + 1) / args.pixelsPerSecond;
  const startIndex = clampInteger(
    Math.floor(pixelStartSeconds * args.pointsPerSecond),
    0,
    args.peakCount - 1,
  );
  const endIndex = clampInteger(
    Math.ceil(pixelEndSeconds * args.pointsPerSecond),
    startIndex + 1,
    args.peakCount,
  );

  return { endIndex, startIndex };
}

function resetWaveformScrollPosition(args: {
  controller: WaveformTileController;
  scrollbarsRef: RefObject<OverlayScrollbarsComponentRef<"div"> | null>;
}) {
  const scrollElements = getWaveformScrollElements(args.scrollbarsRef.current);
  if (scrollElements) {
    writeWaveformScrollLeft(scrollElements, 0);
  }

  args.controller.setScrollLeft(0);
}

function isWaveformTileIndexInWindow(index: number, window: WaveformTileWindow) {
  return index >= window.startIndex && index <= window.endIndex;
}

function createWaveformTileRenderStats(args: {
  removedTileCount: number;
  tileCountBefore: number;
}): WaveformTileRenderStats {
  return {
    createdTileCount: 0,
    dataDrawCount: 0,
    dataResetCount: 0,
    displayChangeCount: 0,
    placeholderDrawCount: 0,
    removedTileCount: args.removedTileCount,
    skippedDrawCount: 0,
    sourceChangeCount: 0,
    tileCountBefore: args.tileCountBefore,
  };
}

function applyWaveformTileRenderStats(
  stats: WaveformTileRenderStats,
  syncResult: WaveformTileSyncResult,
  drawResult: WaveformTileDrawResult,
) {
  applyWaveformTileSyncStats(stats, syncResult);

  if (drawResult === "data") {
    stats.dataDrawCount += 1;
    return;
  }

  if (drawResult === "placeholder") {
    stats.placeholderDrawCount += 1;
    return;
  }

  stats.skippedDrawCount += 1;
}

function applyWaveformTileSyncStats(
  stats: WaveformTileRenderStats,
  syncResult: WaveformTileSyncResult,
) {
  if (syncResult.displayChanged) {
    stats.displayChangeCount += 1;
  }

  if (syncResult.sourceChanged) {
    stats.sourceChangeCount += 1;
  }

  if (syncResult.dataReset) {
    stats.dataResetCount += 1;
  }
}

function handleWaveformViewportWheel(args: {
  event: WaveformWheelEvent;
  scrollElements: WaveformScrollElements;
  wheelState: WaveformWheelState;
  zoomController: WaveformZoomController;
}) {
  const { viewportWidth } = args.wheelState;
  const scrollElement = args.scrollElements.viewport;
  const visualScrollLeft = readWaveformScrollLeft(args.scrollElements);
  const scrollLeft = args.wheelState.controller.getScrollLeft();
  const viewportHeight = Math.max(1, scrollElement.clientHeight || WAVEFORM_CANVAS_HEIGHT);
  const wheelViewportWidth = Math.max(1, scrollElement.clientWidth || viewportWidth);
  const wheelDeltas = resolveWaveformWheelDeltas({
    axis: getNativeWheelAxis(args.event),
    deltaMode: getNativeWheelDeltaMode(args.event),
    deltaX: getNativeWheelDeltaXStandard(args.event),
    deltaY: getNativeWheelDeltaYStandard(args.event),
    horizontalAxis: getNativeWheelHorizontalAxis(args.event),
    wheelDelta: getNativeWheelDelta(args.event),
    wheelDeltaX: getNativeWheelDeltaX(args.event),
    wheelDeltaY: getNativeWheelDeltaY(args.event),
  });
  const normalizedDeltaX = normalizeWheelDeltaX({
    deltaMode: wheelDeltas.deltaMode,
    deltaX: wheelDeltas.deltaX,
    viewportWidth: wheelViewportWidth,
  });
  const normalizedDeltaY = normalizeWheelDeltaY({
    deltaMode: wheelDeltas.deltaMode,
    deltaY: wheelDeltas.deltaY,
    viewportHeight,
  });
  const intent = resolveWaveformWheelIntent({
    deltaX: normalizedDeltaX,
    deltaY: normalizedDeltaY,
    shiftKey: readWaveformWheelBoolean(args.event, "shiftKey"),
  });
  recordSpectrumWaveformTrace("wheel-start", () => ({
    coordinates: snapshotWaveformWheelCoordinates(args.event),
    deltaMode: wheelDeltas.deltaMode,
    intent,
    normalizedDeltaX,
    normalizedDeltaY,
    pixelsPerSecond: args.wheelState.pixelsPerSecond,
    scroll: snapshotWaveformScrollElements(args.scrollElements),
    scrollLeft,
    visualScrollLeft,
    wheelViewportWidth,
  }));

  if (intent.kind === "horizontal-pan") {
    return;
  }

  if (intent.kind === "none") {
    return;
  }

  preventWaveformWheelDefault(args.event);
  handleWaveformZoomWheel({
    deltaY: intent.deltaY,
    event: args.event,
    scrollElements: args.scrollElements,
    scrollLeft,
    wheelState: args.wheelState,
    zoomController: args.zoomController,
  });
}

function handleWaveformZoomWheel(args: {
  deltaY: number;
  event: WaveformWheelEvent;
  scrollElements: WaveformScrollElements;
  scrollLeft: number;
  wheelState: WaveformWheelState;
  zoomController: WaveformZoomController;
}) {
  const scrollElement = args.scrollElements.viewport;

  const rect = scrollElement.getBoundingClientRect();
  const viewportWidth = Math.max(1, scrollElement.clientWidth || args.wheelState.viewportWidth);
  const anchorClientX = readWaveformWheelNumber(
    args.event,
    "clientX",
    rect.left + viewportWidth / 2,
  );
  const anchorViewportX = resolveWaveformPointerAnchorViewportX({
    clientX: anchorClientX,
    viewportLeft: rect.left,
    viewportWidth,
  });

  recordSpectrumWaveformTrace("zoom-anchor", () => ({
    anchorClientX,
    anchorRatio: anchorViewportX / viewportWidth,
    anchorViewportX,
    coordinates: snapshotWaveformWheelCoordinates(args.event),
    pixelsPerSecond: args.wheelState.pixelsPerSecond,
    scroll: snapshotWaveformScrollElements(args.scrollElements),
    scrollLeft: args.scrollLeft,
    visualScrollLeft: readWaveformScrollLeft(args.scrollElements),
    viewportRect: snapshotWaveformDomRect(rect),
  }));

  args.zoomController.apply({
    anchorViewportX,
    deltaY: args.deltaY,
    scrollElements: args.scrollElements,
    scrollLeft: args.scrollLeft,
    wheelState: args.wheelState,
  });
}

function getWaveformScrollElements(
  ref: OverlayScrollbarsComponentRef<"div"> | null,
): WaveformScrollElements | null {
  return ref?.osInstance()?.elements() ?? null;
}

function isWaveformWheelTargetInViewport(
  event: WaveformWheelEvent,
  elements: WaveformScrollElements,
) {
  const target = event.target;
  const ownerWindow = elements.viewport.ownerDocument.defaultView;
  if (!ownerWindow || !(target instanceof ownerWindow.Node)) {
    return false;
  }

  return target === elements.viewport || elements.viewport.contains(target);
}

function readWaveformScrollLeft(elements: WaveformScrollElements) {
  return Math.max(elements.viewport.scrollLeft, elements.scrollOffsetElement.scrollLeft);
}

function writeWaveformScrollLeft(elements: WaveformScrollElements, scrollLeft: number) {
  elements.viewport.scrollLeft = scrollLeft;

  if (elements.scrollOffsetElement !== elements.viewport) {
    elements.scrollOffsetElement.scrollLeft = scrollLeft;
  }
}

function snapshotWaveformScrollElements(elements: WaveformScrollElements) {
  return {
    content: snapshotWaveformScrollElement(elements.content),
    host: snapshotWaveformScrollElement(elements.host),
    offset: snapshotWaveformScrollElement(elements.scrollOffsetElement, {
      isSameAsViewport: elements.scrollOffsetElement === elements.viewport,
    }),
    viewport: snapshotWaveformScrollElement(elements.viewport),
  };
}

function snapshotWaveformScrollElement(
  element: HTMLElement,
  flags: { isSameAsViewport?: boolean } = {},
) {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);

  return {
    ...flags,
    className: readWaveformElementClassName(element),
    clientWidth: element.clientWidth,
    dataOverlayscrollbars: element.getAttribute("data-overlayscrollbars"),
    dataOverlayscrollbarsContent: element.getAttribute("data-overlayscrollbars-content"),
    dataOverlayscrollbarsContents: element.getAttribute("data-overlayscrollbars-contents"),
    dataOverlayscrollbarsViewport: element.getAttribute("data-overlayscrollbars-viewport"),
    offsetWidth: element.offsetWidth,
    rect: snapshotWaveformDomRect(element.getBoundingClientRect()),
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
    styleDisplay: style?.display ?? "",
    styleOverflowX: style?.overflowX ?? "",
    styleOverflowY: style?.overflowY ?? "",
    tagName: element.tagName,
  };
}

function snapshotWaveformDomRect(rect: DOMRect) {
  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
  };
}

function snapshotWaveformWheelCoordinates(event: WaveformWheelEvent) {
  const nativeEvent = getWaveformNativeEvent(event);

  return {
    altKey: readWaveformWheelBoolean(event, "altKey"),
    clientX: readWaveformWheelNumber(event, "clientX", null),
    clientY: readWaveformWheelNumber(event, "clientY", null),
    ctrlKey: readWaveformWheelBoolean(event, "ctrlKey"),
    currentTarget: snapshotWaveformEventTarget(event.currentTarget),
    metaKey: readWaveformWheelBoolean(event, "metaKey"),
    native: nativeEvent
      ? {
          clientX: readWaveformObjectNumber(nativeEvent, "clientX"),
          clientY: readWaveformObjectNumber(nativeEvent, "clientY"),
          pageX: readWaveformObjectNumber(nativeEvent, "pageX"),
          pageY: readWaveformObjectNumber(nativeEvent, "pageY"),
          screenX: readWaveformObjectNumber(nativeEvent, "screenX"),
          screenY: readWaveformObjectNumber(nativeEvent, "screenY"),
        }
      : null,
    pageX: readWaveformWheelNumber(event, "pageX", null),
    pageY: readWaveformWheelNumber(event, "pageY", null),
    screenX: readWaveformWheelNumber(event, "screenX", null),
    screenY: readWaveformWheelNumber(event, "screenY", null),
    shiftKey: readWaveformWheelBoolean(event, "shiftKey"),
    target: snapshotWaveformEventTarget(event.target),
  };
}

function snapshotWaveformEventTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return null;
  }

  return {
    className: readWaveformElementClassName(target),
    dataOverlayscrollbars: target.getAttribute("data-overlayscrollbars"),
    dataOverlayscrollbarsContent: target.getAttribute("data-overlayscrollbars-content"),
    dataOverlayscrollbarsContents: target.getAttribute("data-overlayscrollbars-contents"),
    dataOverlayscrollbarsViewport: target.getAttribute("data-overlayscrollbars-viewport"),
    tagName: target.tagName,
  };
}

function readWaveformElementClassName(element: Element) {
  if (typeof element.className === "string") {
    return element.className;
  }

  return element.getAttribute("class") ?? "";
}

function getNativeWheelDeltaXStandard(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "deltaX", null);
}

function getNativeWheelDeltaYStandard(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "deltaY", null);
}

function getNativeWheelDeltaMode(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "deltaMode", 0);
}

function getNativeWheelDeltaX(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "wheelDeltaX", null);
}

function getNativeWheelDeltaY(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "wheelDeltaY", null);
}

function getNativeWheelDelta(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "wheelDelta", null);
}

function getNativeWheelAxis(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "axis", null);
}

function getNativeWheelHorizontalAxis(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "HORIZONTAL_AXIS", null);
}

function readWaveformWheelNumber(event: WaveformWheelEvent, key: string, fallback: number): number;
function readWaveformWheelNumber(
  event: WaveformWheelEvent,
  key: string,
  fallback: null,
): number | null;
function readWaveformWheelNumber(event: WaveformWheelEvent, key: string, fallback: number | null) {
  const value = readWaveformWheelProperty(event, key);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readWaveformObjectNumber(source: object, key: string) {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readWaveformWheelBoolean(event: WaveformWheelEvent, key: string) {
  return readWaveformWheelProperty(event, key) === true;
}

function readWaveformWheelProperty(event: WaveformWheelEvent, key: string) {
  const directValue = (event as unknown as Record<string, unknown>)[key];
  if (directValue !== undefined) {
    return directValue;
  }

  return (getWaveformNativeEvent(event) as Record<string, unknown> | null)?.[key];
}

function getWaveformNativeEvent(event: WaveformWheelEvent) {
  const nativeEvent = event.nativeEvent;
  return nativeEvent instanceof Event ? nativeEvent : null;
}

function preventWaveformWheelDefault(event: WaveformWheelEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function isPlaybackStatusForTrack(status: PlaybackStatusPayload, filePath: string) {
  return (
    status.path !== null &&
    normalizeWaveformPathKey(status.path) === normalizeWaveformPathKey(filePath)
  );
}

function readWaveformPerformanceNow(ownerWindow: Window | null) {
  return ownerWindow?.performance.now() ?? globalThis.performance?.now() ?? Date.now();
}

function normalizeWaveformBoundary(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.floor(value));
}

function normalizeWheelDeltaX(args: { deltaMode: number; deltaX: number; viewportWidth: number }) {
  if (args.deltaMode === 1) {
    return args.deltaX * 16;
  }

  if (args.deltaMode === 2) {
    return args.deltaX * Math.max(1, args.viewportWidth);
  }

  return args.deltaX;
}

function normalizeWheelDeltaY(args: { deltaMode: number; deltaY: number; viewportHeight: number }) {
  if (args.deltaMode === 1) {
    return args.deltaY * 16;
  }

  if (args.deltaMode === 2) {
    return args.deltaY * Math.max(1, args.viewportHeight);
  }

  return args.deltaY;
}

function roundWaveformPixelsPerSecond(value: number) {
  return (
    Math.round(
      clampNumber(value, WAVEFORM_MIN_PIXELS_PER_SECOND, WAVEFORM_MAX_PIXELS_PER_SECOND) *
        WAVEFORM_PIXELS_PER_SECOND_PRECISION,
    ) / WAVEFORM_PIXELS_PER_SECOND_PRECISION
  );
}

function sanitizePeakValue(value: number) {
  return Number.isFinite(value) ? clampNumber(value, -1, 1) : 0;
}

function sanitizeQuantizedPeakValue(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return clampInteger(value, -127, 127);
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(Math.max(Math.floor(value), min), max);
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
