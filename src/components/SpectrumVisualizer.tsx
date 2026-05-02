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
import { motion } from "motion/react";
import {
  OverlayScrollbarsComponent,
  type OverlayScrollbarsComponentRef,
} from "overlayscrollbars-react";
import type { Elements, EventListeners } from "overlayscrollbars";
import { cn } from "@/lib/utils";
import {
  crab,
  type PlaybackStatusPayload,
  type TrackWaveformSummary,
  type TrackWaveformTile,
  type WaveformPeak,
} from "@/src/cmd";
import {
  installWaveformTrace,
  isWaveformTraceDetailEnabled,
  isWaveformTraceEnabled,
  recordWaveformTrace,
} from "@/src/debug/waveformTrace";
import { normalizeMediaPathKey } from "./mediaPath";

const WAVEFORM_CANVAS_HEIGHT = 208;
const WAVEFORM_VERTICAL_PADDING = 18;
const WAVEFORM_PLACEHOLDER_POINTS_PER_SECOND = 80;
const WAVEFORM_PLACEHOLDER_DURATION_MS = 8_000;
const WAVEFORM_MIN_PIXELS_PER_SECOND = 12;
const WAVEFORM_FALLBACK_MAX_PIXELS_PER_SECOND = 320;
const WAVEFORM_INITIAL_PIXELS_PER_SECOND = 24;
const WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM = 360;
const WAVEFORM_MAX_WHEEL_ZOOM_DELTA = WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM / 2;
const WAVEFORM_ZOOM_SETTLE_DELAY_MS = 420;
const WAVEFORM_SCROLL_SETTLE_DELAY_MS = 120;
const WAVEFORM_PIXELS_PER_SECOND_PRECISION = 100;
const WAVEFORM_INACTIVE_OPACITY = 0.42;
const WAVEFORM_TILE_WIDTH = 2048;
const WAVEFORM_TILE_OVERSCAN = 2;
const WAVEFORM_TILE_RETENTION_OVERSCAN = 8;
const WAVEFORM_TILE_LOAD_CONCURRENCY = 2;
const WAVEFORM_TILE_IMMEDIATE_RENDER_LIMIT = 8;
const WAVEFORM_TILE_DATA_CACHE_LIMIT = 192;
const WAVEFORM_TILE_PREFETCH_THRESHOLD = 0.5;
const WAVEFORM_TILE_PREFETCH_LIMIT = 6;
const WAVEFORM_TILE_PREFETCH_CONCURRENCY = 1;
const WAVEFORM_OFFSCREEN_RENDER_BATCH_LIMIT = 4;
const WAVEFORM_OFFSCREEN_RENDER_IDLE_TIMEOUT_MS = 160;
const WAVEFORM_INITIAL_PREPARE_DELAY_MS = 120;
const WAVEFORM_INITIAL_PREPARE_FRAME_COUNT = 2;
const WAVEFORM_SCROLL_ECHO_TOLERANCE_PX = 0.5;
const WAVEFORM_VIEWPORT_POSITION_EPSILON_PX = 0.000001;
const WAVEFORM_TRACE_SAMPLE_LIMIT = 12;
const WAVEFORM_TRACE_DETAIL_SAMPLE_LIMIT = 4;
const WAVEFORM_TRACE_DRAW_DETAIL_THRESHOLD_MS = 1;
const PLAYBACK_STATUS_POLL_MS = 250;
let waveformViewportTraceSequence = 0;

type WaveformStatus = "idle" | "loading" | "ready" | "error";

type PlaybackSnapshot = PlaybackStatusPayload & {
  received_at_ms: number;
};

export interface TrackSpectrumWaveformPort {
  getTrackWaveformTile: (
    filePath: string,
    start: number | null,
    end: number | null,
    pixelsPerSecond: number,
    tileStartPx: number,
    tileWidth: number,
  ) => Promise<TrackWaveformTile>;
  prepareTrackWaveform: (
    filePath: string,
    start: number | null,
    end: number | null,
  ) => Promise<TrackWaveformSummary>;
}

export interface TrackSpectrumPlaybackPort {
  getPlaybackStatus: () => Promise<PlaybackStatusPayload | null>;
}

export interface TrackSpectrumPorts {
  playback: TrackSpectrumPlaybackPort;
  waveform: TrackSpectrumWaveformPort;
}

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
  waveformPort: TrackSpectrumWaveformPort;
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
  drawDataKey: string | null;
  drawOpacity: number | null;
  drawSampleOffsetPx: number | null;
  drawScale: number | null;
  drawStatus: "data" | "placeholder" | null;
  hasDrawnPixels: boolean;
  index: number;
  sourceStartPx: number;
  sourceWidthPx: number;
  status: "loading" | "pending" | "ready";
};

type WaveformTileDataCacheEntry = {
  data: TrackWaveformTile;
  key: string;
  lastUsedMs: number;
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
  nativeEvent?: unknown;
};

type WaveformWheelPropertyReadSource = "direct" | "native" | "none";

type WaveformWheelPropertyCandidate = {
  own: boolean;
  present: boolean;
  value: unknown;
};

type WaveformWheelPropertyRead = {
  direct: WaveformWheelPropertyCandidate;
  native: WaveformWheelPropertyCandidate;
  source: WaveformWheelPropertyReadSource;
  value: unknown;
};

type WaveformWheelState = {
  contentWidth: number;
  controller: WaveformPresentationController;
  maximumPixelsPerSecond: number;
  requestedPixelsPerSecond: number;
  setPixelsPerSecond: Dispatch<SetStateAction<number>>;
  summary: TrackWaveformSummary;
  viewportWidth: number;
};

type WaveformPresentedViewport = {
  pixelsPerSecond: number;
  scrollLeft: number;
  summary: TrackWaveformSummary;
  viewportWidth: number;
};

type WaveformZoomConstraints = {
  durationMs: number;
  maximumPixelsPerSecond?: number;
  viewportWidth: number;
};

type WaveformZoomFrame = {
  anchorSeconds: number;
  anchorViewportX: number;
  contentWidth: number;
  pixelsPerSecond: number;
  scrollLeft: number;
};

type WaveformZoomContext = {
  durationMs: number;
  viewportWidth: number;
};

type WaveformZoomBaseFrame = Pick<WaveformZoomFrame, "pixelsPerSecond" | "scrollLeft"> &
  WaveformZoomContext;

type WaveformZoomCommit = WaveformZoomFrame &
  WaveformZoomContext & {
    controller: WaveformPresentationController;
    generation: number;
    scrollElements: WaveformScrollElements;
    setPixelsPerSecond: Dispatch<SetStateAction<number>>;
  };

type WaveformViewportScrollEventFrame = {
  kind: "external-scroll" | "programmatic-echo";
  scrollLeft: number;
  visualScrollLeft: number;
};

type WaveformViewportTraceReason = "external-scroll" | "horizontal-wheel" | "programmatic-echo";

type WaveformViewportTraceContext = {
  reason: WaveformViewportTraceReason;
  traceId: number;
};

/**
 * Horizontal wheel bugs can be introduced at several effect boundaries:
 * wheel decoding, DOM scroll writes, OverlayScrollbars echoes, viewport state,
 * or tile window rendering. The trace context is created once at the wheel
 * boundary and then carried through those effects so the pure wheel algebra
 * stays uninstrumented.
 */
function createWaveformViewportTraceContext(
  reason: WaveformViewportTraceReason,
): WaveformViewportTraceContext {
  waveformViewportTraceSequence += 1;

  return {
    reason,
    traceId: waveformViewportTraceSequence,
  };
}

type WaveformProgrammaticScrollEcho = {
  trace: WaveformViewportTraceContext | null;
  visualScrollLeft: number;
};

type PendingWaveformZoomCommit = {
  commit: WaveformZoomCommit;
};

type WaveformTileSyncResult = {
  dataReset: boolean;
  displayChanged: boolean;
  sourceChanged: boolean;
};

type WaveformTileDrawResult = "blank" | "data" | "placeholder" | "skipped";

type WaveformTileDrawIntent = "blank" | "data" | "placeholder";

type WaveformTileRenderStats = {
  blankDrawCount: number;
  blankDrawTileIndexes: number[];
  createdTileCount: number;
  createdTileIndexes: number[];
  dataDrawTileIndexes: number[];
  drawDurationMs: number;
  dataDrawCount: number;
  dataResetCount: number;
  dataResetTileIndexes: number[];
  displayChangeCount: number;
  displayChangeTileIndexes: number[];
  placeholderDrawCount: number;
  placeholderDrawTileIndexes: number[];
  removedTileCount: number;
  removedTileIndexes: number[];
  renderedTileSamples: WaveformTileTraceSnapshot[];
  skippedDrawCount: number;
  skippedDrawTileIndexes: number[];
  sourceChangeCount: number;
  sourceChangeTileIndexes: number[];
  tileCountBefore: number;
};

type WaveformTileRenderPlan = {
  offscreenTileLoadOrder: number[];
  removeIndexes: number[];
  retainedSyncIndexes: number[];
  tileLoadOrder: number[];
  visibleTileLoadOrder: number[];
};

type WaveformTileRenderMode = "active-scroll" | "complete" | "visible-only";

type WaveformTileRenderScope = {
  allowOffscreen: boolean;
  immediateIndexes: number[];
  loadIndexes: number[];
  visibilityIndexes: number[];
};

type WaveformTileRenderFocus = Pick<WaveformZoomFrame, "anchorSeconds" | "anchorViewportX">;

type WaveformTileRenderRequest = {
  focus: WaveformTileRenderFocus | null;
  mode: WaveformTileRenderMode;
  trace: WaveformViewportTraceContext | null;
};

type WaveformTileRenderBatch = {
  deferredIndexes: number[];
  immediateIndexes: number[];
};

type WaveformTileVisibilityPlan = {
  hiddenIndexes: number[];
  visibleIndexes: number[];
};

type WaveformTileLoadPriority = "offscreen" | "prefetch" | "visible";

type WaveformTileLoadQueueEntry = {
  cacheKey?: string;
  fetchStartPx?: number;
  fetchWidthPx?: number;
  queuedAtMs: number;
  index: number;
  order: number;
  priority: WaveformTileLoadPriority;
  reason: WaveformTileLoadQueueReason;
  renderPixelsPerSecond?: number;
};

type WaveformTileLoadQueueOptions = {
  entries?: readonly WaveformTilePrefetchQueueEntry[];
  priority?: WaveformTileLoadPriority;
  reason?: WaveformTileLoadQueueReason;
  retainPendingQueue?: boolean;
};

type WaveformTilePrefetchQueueEntry = {
  cacheKey: string;
  fetchStartPx: number;
  fetchWidthPx: number;
  index: number;
  renderPixelsPerSecond: number;
};

type WaveformTileLoadQueueReason =
  | "load-retry"
  | "offscreen-offscreen"
  | "prefetch-next-density"
  | "offscreen-visible"
  | "render-window-offscreen"
  | "render-window-visible";

type WaveformTileLoadQueueState = {
  entries: WaveformTileLoadQueueEntry[];
  nextOrder: number;
};

type WaveformTileWindowReadiness =
  | {
      ready: true;
      reason: "ready";
    }
  | {
      expectedGeometry?: WaveformTileGeometry | null;
      index?: number;
      ready: false;
      reason:
        | "geometry-mismatch"
        | "missing-tile"
        | "not-drawn"
        | "outside-rendered-window"
        | "primary-data-not-ready";
      tile?: WaveformTileTraceSnapshot | null;
    };

type WaveformTileWindowStatusSummary = {
  dataCount: number;
  dirtyDataCount: number;
  drawnCount: number;
  loadingCount: number;
  missingCount: number;
  mountedCount: number;
  pendingCount: number;
  readyCount: number;
  totalCount: number;
};

type WaveformTileTraceRange = Pick<
  WaveformTileNodeState,
  | "displayStartPx"
  | "displayWidthPx"
  | "fetchStartPx"
  | "fetchWidthPx"
  | "index"
  | "sourceStartPx"
  | "sourceWidthPx"
>;

type WaveformTileTraceSnapshot = WaveformTileTraceRange & {
  drawDisplayStartPx: number | null;
  drawDisplayWidthPx: number | null;
  drawDataKey: string | null;
  drawSampleOffsetPx: number | null;
  drawScale: number | null;
  drawStatus: WaveformTileNodeState["drawStatus"];
  hasData: boolean;
  hasDrawnPixels: boolean;
  maxLength: number;
  minLength: number;
  status: WaveformTileNodeState["status"];
};

type WaveformTileDrawTraceResult = {
  durationMs: number;
  result: WaveformTileDrawResult;
};

type WaveformTileDrawSkipReason = "blank-without-pixels" | "draw-state-current" | "no-host";

type WaveformTileFrameDrawMode = "display-pixels";

type WaveformTileFrameTracePayload = {
  backingScaleX: number;
  barCenterSamplePx: number[];
  barCount: number;
  barSpacingSamplePx: number[];
  barWidthCssPx: number;
  barWidthDevicePx: number;
  canvasBackingWidth: number;
  canvasClientWidth: number;
  canvasCssWidth: number;
  canvasStyleWidth: string;
  drawMode: WaveformTileFrameDrawMode;
  lineWidthCssPx: number;
  lineWidthDevicePx: number;
  maxBarSpacingPx: number | null;
  minBarSpacingPx: number | null;
  renderScale: number;
};

type WaveformLayerTraceSnapshot = {
  baseContentWidth: number | null;
  basePixelsPerSecond: number | null;
  childCount: number;
  styleOpacity: string;
  styleTransform: string;
  styleWidth: string;
  styleWillChange: string;
};

type WaveformPresentationTraceSnapshot = {
  inputs: {
    contentWidth: number;
    pixelsPerSecond: number;
    renderContentWidth: number;
    renderPixelsPerSecond: number;
    renderScale: number;
    status: WaveformStatus;
    summaryCacheKey: string;
  } | null;
  renderLayer: WaveformLayerTraceSnapshot | null;
  renderedTileWindow: WaveformTileWindow | null;
  scrollLeft: number;
  tileCount: number;
  visualScrollLeft: number;
};

type WaveformTileLoadResult = "done" | "retry" | "stale";

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

type WaveformInitialPrepareHandle =
  | {
      id: number;
      kind: "idle";
    }
  | {
      frameId: number;
      idleHandle: WaveformInitialPrepareHandle;
      kind: "after-first-frame";
      remainingFrames: number;
    }
  | {
      id: number;
      kind: "timer";
    }
  | null;

type WaveformOffscreenTileRenderJob = {
  generation: number;
  indexes: number[];
  inputs: WaveformRenderInputs;
  reason: "complete-offscreen" | "deferred-visible";
  renderMetrics: ReturnType<typeof resolveWaveformRenderMetrics>;
  visibleTileWindow: WaveformTileWindow;
};

type WaveformTileRenderFrameOwner = {
  getOwnerWindow: () => Window | null;
  renderTileWindow: (request: WaveformTileRenderRequest) => void;
};

type WaveformScrollSettleOwner = {
  getOwnerWindow: () => Window | null;
  renderSettledTileWindow: () => void;
};

type WaveformOffscreenTileRenderOwner = {
  getOwnerWindow: () => Window | null;
  isOffscreenTileRenderJobCurrent: (job: WaveformOffscreenTileRenderJob) => boolean;
  renderOffscreenTileIndexes: (args: {
    indexes: readonly number[];
    job: WaveformOffscreenTileRenderJob;
  }) => void;
};

type WaveformTileLoadOwner = {
  applyTileLoadError: (tile: WaveformTileNodeState) => void;
  applyTileLoadSuccess: (args: {
    tile: WaveformTileNodeState;
    tileData: TrackWaveformTile;
  }) => WaveformTileLoadResult;
  cachePrefetchedTileData: (args: {
    key: string;
    reason: WaveformTileLoadQueueReason;
    tileData: TrackWaveformTile;
  }) => void;
  getCachedTileData: (key: string) => TrackWaveformTile | null;
  getOwnerWindow: () => Window | null;
  getTileLoadInputs: () => WaveformRenderInputs | null;
  getTileLoadNode: (index: number) => WaveformTileNodeState | undefined;
};

type TrackWaveformSummaryState = {
  status: WaveformStatus;
  summary: TrackWaveformSummary;
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

const crabTrackSpectrumPorts: TrackSpectrumPorts = {
  playback: {
    getPlaybackStatus: async () => {
      const result = await crab.getPlaybackStatus();

      return result.match({
        Ok: (status) => status,
        Err: (error) => {
          throw new Error(error);
        },
      });
    },
  },
  waveform: {
    getTrackWaveformTile: async (filePath, start, end, pixelsPerSecond, tileStartPx, tileWidth) => {
      const result = await crab.getTrackWaveformTile(
        filePath,
        start,
        end,
        pixelsPerSecond,
        tileStartPx,
        tileWidth,
      );

      return result.match({
        Ok: (tile) => tile,
        Err: (error) => {
          throw new Error(error);
        },
      });
    },
    prepareTrackWaveform: async (filePath, start, end) => {
      const result = await crab.prepareTrackWaveform(filePath, start, end);

      return result.match({
        Ok: (summary) => summary,
        Err: (error) => {
          throw new Error(error);
        },
      });
    },
  },
};

export function resolveWaveformPixelsPerSecond(
  value: number,
  constraints?: WaveformZoomConstraints,
) {
  return roundWaveformPixelsPerSecond(value, constraints);
}

export function resolveWaveformMinimumPixelsPerSecond(
  constraints?: Partial<WaveformZoomConstraints>,
) {
  const durationSeconds = Math.max(0, constraints?.durationMs ?? 0) / 1000;
  const viewportWidth = Math.max(0, constraints?.viewportWidth ?? 0);

  if (durationSeconds <= 0 || viewportWidth <= 0) {
    return WAVEFORM_MIN_PIXELS_PER_SECOND;
  }

  return clampNumber(
    Math.max(WAVEFORM_MIN_PIXELS_PER_SECOND, viewportWidth / durationSeconds),
    WAVEFORM_MIN_PIXELS_PER_SECOND,
    resolveWaveformMaximumPixelsPerSecond(constraints),
  );
}

export function resolveWaveformMaximumPixelsPerSecond(
  constraints?: Pick<WaveformZoomConstraints, "maximumPixelsPerSecond"> | null,
) {
  const maximumPixelsPerSecond = constraints?.maximumPixelsPerSecond;

  return Number.isFinite(maximumPixelsPerSecond)
    ? Math.max(WAVEFORM_MIN_PIXELS_PER_SECOND, Number(maximumPixelsPerSecond))
    : WAVEFORM_FALLBACK_MAX_PIXELS_PER_SECOND;
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

export function resolveWaveformHorizontalScrollLeft(args: {
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

export function resolveWaveformHorizontalPanFrame(args: {
  contentWidth: number;
  deltaX: number;
  scrollLeft: number;
  viewportWidth: number;
}) {
  const scrollLeft = resolveWaveformHorizontalScrollLeft(args);

  return {
    changed: Math.abs(scrollLeft - args.scrollLeft) > WAVEFORM_VIEWPORT_POSITION_EPSILON_PX,
    scrollLeft,
  };
}

export function resolveWaveformWheelPanContentWidth(args: {
  scrollOffsetElementScrollWidth?: number | null;
  viewportScrollWidth?: number | null;
  viewportWidth: number;
  wheelStateContentWidth: number;
}) {
  return Math.max(
    args.viewportWidth,
    args.wheelStateContentWidth,
    resolveFiniteWheelDelta(args.viewportScrollWidth),
    resolveFiniteWheelDelta(args.scrollOffsetElementScrollWidth),
  );
}

export function hasWaveformViewportPositionChanged(args: {
  currentScrollLeft: number;
  currentVisualScrollLeft: number;
  nextScrollLeft: number;
  nextVisualScrollLeft: number;
}) {
  return (
    Math.abs(args.nextScrollLeft - args.currentScrollLeft) >
      WAVEFORM_VIEWPORT_POSITION_EPSILON_PX ||
    Math.abs(args.nextVisualScrollLeft - args.currentVisualScrollLeft) >
      WAVEFORM_VIEWPORT_POSITION_EPSILON_PX
  );
}

export function resolveWaveformScrollReadValue(args: {
  scrollOffsetElementScrollLeft: number;
  viewportScrollLeft: number;
}) {
  return Math.max(args.viewportScrollLeft, args.scrollOffsetElementScrollLeft);
}

export function resolveWaveformScrollWritePlan(args: {
  hasSeparateScrollOffsetElement: boolean;
  scrollLeft: number;
}) {
  return {
    scrollOffsetElementScrollLeft: args.hasSeparateScrollOffsetElement ? args.scrollLeft : null,
    viewportScrollLeft: args.scrollLeft,
  };
}

export function resolveWaveformViewportScrollEventFrame(args: {
  currentScrollLeft: number;
  incomingVisualScrollLeft: number;
  isLogicalScrollLocked: boolean;
  pendingProgrammaticScrollEcho: WaveformProgrammaticScrollEcho | null;
}): WaveformViewportScrollEventFrame {
  const visualScrollLeft = Math.max(0, args.incomingVisualScrollLeft);
  const pendingEcho = args.pendingProgrammaticScrollEcho;

  if (args.isLogicalScrollLocked) {
    return {
      kind: "programmatic-echo",
      scrollLeft: Math.max(0, args.currentScrollLeft),
      visualScrollLeft,
    };
  }

  if (
    pendingEcho &&
    Math.abs(visualScrollLeft - pendingEcho.visualScrollLeft) < WAVEFORM_SCROLL_ECHO_TOLERANCE_PX
  ) {
    return {
      kind: "programmatic-echo",
      scrollLeft: Math.max(0, args.currentScrollLeft),
      visualScrollLeft,
    };
  }

  return {
    kind: "external-scroll",
    scrollLeft: visualScrollLeft,
    visualScrollLeft,
  };
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

/**
 * Pure wheel algebra: every raw wheel event maps to at most one waveform operation.
 * The DOM layer may consume that operation, but it must not reinterpret it.
 */
export function resolveWaveformWheelOperation(
  args: WaveformWheelDeltas & {
    shiftKey: boolean;
    viewportHeight: number;
    viewportWidth: number;
  },
): WaveformWheelIntent {
  const deltaX = normalizeWheelDeltaX({
    deltaMode: args.deltaMode,
    deltaX: args.deltaX,
    viewportWidth: args.viewportWidth,
  });
  const deltaY = normalizeWheelDeltaY({
    deltaMode: args.deltaMode,
    deltaY: args.deltaY,
    viewportHeight: args.viewportHeight,
  });

  return resolveWaveformWheelIntent({
    deltaX,
    deltaY,
    shiftKey: args.shiftKey,
  });
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
          : hasHorizontalAxis && wheelDelta !== 0
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

/**
 * Wheel fields are source-selected by presence, not by value. A zero direct
 * delta is a real input sample; replacing it with a native fallback would let
 * the reader synthesize motion and blur the pan/zoom boundary.
 */
export function resolveWaveformWheelNumberPropertyRead(
  read: WaveformWheelPropertyRead,
  fallback: number,
): { source: WaveformWheelPropertyReadSource; value: number };
export function resolveWaveformWheelNumberPropertyRead(
  read: WaveformWheelPropertyRead,
  fallback: null,
): { source: WaveformWheelPropertyReadSource; value: number | null };
export function resolveWaveformWheelNumberPropertyRead(
  read: WaveformWheelPropertyRead,
  fallback: number | null,
) {
  const directValue = resolveFiniteWheelPropertyNumber(read.direct.value);
  const nativeValue = resolveFiniteWheelPropertyNumber(read.native.value);

  if (directValue !== null) {
    return {
      source: "direct",
      value: directValue,
    };
  }

  if (nativeValue !== null) {
    return {
      source: "native",
      value: nativeValue,
    };
  }

  return {
    source: "none",
    value: fallback,
  };
}

export function resolveWaveformWheelBooleanPropertyRead(read: WaveformWheelPropertyRead) {
  if (read.direct.value === true || read.native.value === true) {
    return true;
  }

  if (read.direct.value === false || read.native.value === false) {
    return false;
  }

  return false;
}

function resolveFiniteWheelPropertyNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveWaveformWheelPixelsPerSecond(args: {
  currentPixelsPerSecond: number;
  deltaY: number;
  durationMs?: number;
  maximumPixelsPerSecond?: number;
  viewportWidth?: number;
}) {
  const constraints =
    typeof args.durationMs === "number" && typeof args.viewportWidth === "number"
      ? {
          durationMs: args.durationMs,
          maximumPixelsPerSecond: args.maximumPixelsPerSecond,
          viewportWidth: args.viewportWidth,
        }
      : undefined;

  if (!Number.isFinite(args.deltaY) || args.deltaY === 0) {
    return resolveWaveformPixelsPerSecond(args.currentPixelsPerSecond, constraints);
  }

  const deltaY = clampWaveformZoomDeltaY(args.deltaY);

  return resolveWaveformPixelsPerSecond(
    args.currentPixelsPerSecond * 2 ** (-deltaY / WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM),
    constraints,
  );
}

export function clampWaveformZoomDeltaY(deltaY: number) {
  return clampNumber(deltaY, -WAVEFORM_MAX_WHEEL_ZOOM_DELTA, WAVEFORM_MAX_WHEEL_ZOOM_DELTA);
}

export function resolveWaveformZoomScaleFrame(args: {
  currentPixelsPerSecond: number;
  deltaY: number;
  durationMs: number;
  maximumPixelsPerSecond?: number;
  viewportWidth: number;
}) {
  const currentPixelsPerSecond = resolveWaveformPixelsPerSecond(args.currentPixelsPerSecond, {
    durationMs: args.durationMs,
    maximumPixelsPerSecond: args.maximumPixelsPerSecond,
    viewportWidth: args.viewportWidth,
  });
  const pixelsPerSecond = resolveWaveformWheelPixelsPerSecond({
    currentPixelsPerSecond,
    deltaY: args.deltaY,
    durationMs: args.durationMs,
    maximumPixelsPerSecond: args.maximumPixelsPerSecond,
    viewportWidth: args.viewportWidth,
  });

  return {
    changed: Math.abs(pixelsPerSecond - currentPixelsPerSecond) >= 0.01,
    pixelsPerSecond,
  };
}

export function resolveWaveformZoomFrame(args: {
  anchorViewportX: number;
  currentPixelsPerSecond: number;
  deltaY: number;
  durationMs: number;
  maximumPixelsPerSecond?: number;
  scrollLeft: number;
  viewportWidth: number;
}): WaveformZoomFrame {
  const pixelsPerSecond = resolveWaveformWheelPixelsPerSecond({
    currentPixelsPerSecond: args.currentPixelsPerSecond,
    deltaY: args.deltaY,
    durationMs: args.durationMs,
    maximumPixelsPerSecond: args.maximumPixelsPerSecond,
    viewportWidth: args.viewportWidth,
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

export function resolveQueuedWaveformZoomFrame(args: {
  anchorViewportX: number;
  currentPixelsPerSecond: number;
  deltaY: number;
  durationMs: number;
  pendingFrame:
    | (Pick<WaveformZoomFrame, "pixelsPerSecond" | "scrollLeft"> & Partial<WaveformZoomContext>)
    | null;
  maximumPixelsPerSecond?: number;
  scrollLeft: number;
  viewportWidth: number;
}) {
  const base = args.pendingFrame ?? {
    pixelsPerSecond: args.currentPixelsPerSecond,
    scrollLeft: args.scrollLeft,
  };
  const durationMs = base.durationMs ?? args.durationMs;
  const viewportWidth = base.viewportWidth ?? args.viewportWidth;

  return resolveWaveformZoomFrame({
    anchorViewportX: args.anchorViewportX,
    currentPixelsPerSecond: base.pixelsPerSecond,
    deltaY: args.deltaY,
    durationMs,
    maximumPixelsPerSecond: args.maximumPixelsPerSecond,
    scrollLeft: base.scrollLeft,
    viewportWidth,
  });
}

export function resolveWaveformZoomSettleDelayMs(args: {
  lastCommitMs: number;
  nowMs: number;
  settleDelayMs?: number;
}) {
  const settleDelayMs = Math.max(0, args.settleDelayMs ?? WAVEFORM_ZOOM_SETTLE_DELAY_MS);
  const quietMs = Math.max(0, args.nowMs - args.lastCommitMs);

  return Math.max(0, settleDelayMs - quietMs);
}

export function resolveWaveformZoomCommitMaterializeMode(): WaveformTileRenderMode {
  return "active-scroll";
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
  priorityIndex?: number | null;
  startIndex: number;
  visibleEndIndex: number;
  visibleStartIndex: number;
}) {
  const startIndex = Math.min(args.startIndex, args.endIndex);
  const endIndex = Math.max(args.startIndex, args.endIndex);
  const visibleStartIndex = Math.min(args.visibleStartIndex, args.visibleEndIndex);
  const visibleEndIndex = Math.max(args.visibleStartIndex, args.visibleEndIndex);
  const visibleCenter = (visibleStartIndex + visibleEndIndex) / 2;
  const priorityIndex = Number.isFinite(args.priorityIndex)
    ? clampNumber(Number(args.priorityIndex), visibleStartIndex, visibleEndIndex)
    : visibleCenter;
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

    return Math.abs(left - priorityIndex) - Math.abs(right - priorityIndex) || left - right;
  });
}

export function resolveWaveformTileRenderPlan(args: {
  mountedTileIndexes: Iterable<number>;
  priorityIndex?: number | null;
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
    priorityIndex: args.priorityIndex,
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

export function resolveWaveformTileRenderMode(
  current: WaveformTileRenderMode,
  requested: WaveformTileRenderMode,
): WaveformTileRenderMode {
  const priority: Record<WaveformTileRenderMode, number> = {
    "visible-only": 0,
    "active-scroll": 1,
    complete: 2,
  };

  return priority[requested] > priority[current] ? requested : current;
}

export function resolveWaveformTileVisibilityPlan(args: {
  mountedTileIndexes: Iterable<number>;
  visibleTileIndexes: Iterable<number>;
}): WaveformTileVisibilityPlan {
  const mountedTileIndexes = Array.from(new Set(args.mountedTileIndexes)).sort(
    (left, right) => left - right,
  );
  const visibleIndexes = new Set(args.visibleTileIndexes);

  return {
    hiddenIndexes: mountedTileIndexes.filter((index) => !visibleIndexes.has(index)),
    visibleIndexes: mountedTileIndexes.filter((index) => visibleIndexes.has(index)),
  };
}

export function resolveWaveformRenderPixelsPerSecond(args: {
  pixelsPerSecond?: number;
  summary: TrackWaveformSummary;
}) {
  const levels = resolveWaveformSortedRenderLevels(args.summary);
  const highestLevel = levels.at(-1) ?? Math.max(1, args.summary.base_points_per_second);

  if (!Number.isFinite(args.pixelsPerSecond)) {
    return highestLevel;
  }

  return resolveWaveformRenderLevelForPixelsPerSecond({
    levels,
    pixelsPerSecond: Number(args.pixelsPerSecond),
  });
}

function resolveWaveformSortedRenderLevels(summary: TrackWaveformSummary) {
  return summary.levels
    .filter((level) => Number.isFinite(level) && level > 0)
    .sort((left, right) => left - right);
}

function resolveWaveformRenderLevelForPixelsPerSecond(args: {
  levels: readonly number[];
  pixelsPerSecond: number;
}) {
  const fallbackPixelsPerSecond = args.levels.at(-1) ?? 1;
  const targetPixelsPerSecond = Math.max(1, Math.ceil(args.pixelsPerSecond));

  return args.levels.find((level) => level >= targetPixelsPerSecond) ?? fallbackPixelsPerSecond;
}

function resolveWaveformRenderMetricsForPixelsPerSecond(args: {
  durationMs: number;
  pixelsPerSecond: number;
  renderPixelsPerSecond: number;
}) {
  return {
    contentWidth: resolveWaveformRenderContentWidth({
      durationMs: args.durationMs,
      renderPixelsPerSecond: args.renderPixelsPerSecond,
    }),
    pixelsPerSecond: args.renderPixelsPerSecond,
    scale: resolveWaveformRenderScale({
      pixelsPerSecond: args.pixelsPerSecond,
      renderPixelsPerSecond: args.renderPixelsPerSecond,
    }),
  };
}

export function resolveWaveformNextRenderPixelsPerSecond(args: {
  pixelsPerSecond: number;
  summary: TrackWaveformSummary;
}) {
  const levels = resolveWaveformSortedRenderLevels(args.summary);
  const currentLevel = resolveWaveformRenderLevelForPixelsPerSecond({
    levels,
    pixelsPerSecond: args.pixelsPerSecond,
  });
  const currentIndex = levels.findIndex((level) => level === currentLevel);

  if (currentIndex < 0 || currentIndex >= levels.length - 1) {
    return null;
  }

  const levelStart = currentIndex === 0 ? 0 : levels[currentIndex - 1];
  const span = Math.max(1, currentLevel - levelStart);
  const progress = (Math.max(1, args.pixelsPerSecond) - levelStart) / span;

  return progress >= WAVEFORM_TILE_PREFETCH_THRESHOLD ? levels[currentIndex + 1] : null;
}

export function resolveWaveformBarWidthPx(args: { renderScale: number }) {
  return Math.max(1, Math.ceil(Math.min(1, Math.max(0.001, args.renderScale))));
}

export function resolveWaveformSourceTileWidth(args: { renderScale: number }) {
  void args;
  return WAVEFORM_TILE_WIDTH;
}

export function resolveWaveformRenderScale(args: {
  pixelsPerSecond: number;
  renderPixelsPerSecond: number;
}) {
  return resolveWaveformDisplayScale(
    args.pixelsPerSecond / Math.max(1, args.renderPixelsPerSecond),
  );
}

export function resolveWaveformRenderContentWidth(args: {
  durationMs: number;
  renderPixelsPerSecond: number;
}) {
  const durationSeconds = Math.max(0, args.durationMs) / 1000;

  return Math.max(1, Math.ceil(durationSeconds * Math.max(1, args.renderPixelsPerSecond)));
}

export function resolveWaveformRenderViewport(args: {
  renderScale: number;
  scrollLeft: number;
  viewportWidth: number;
}) {
  const safeScale = resolveWaveformDisplayScale(args.renderScale);

  return {
    scrollLeft: args.scrollLeft / safeScale,
    viewportWidth: args.viewportWidth / safeScale,
  };
}

export function resolveWaveformRenderTileWindow(args: {
  contentWidth: number;
  overscanTiles: number;
  renderScale: number;
  scrollLeft: number;
  tileWidth: number;
  viewportWidth: number;
}) {
  const renderViewport = resolveWaveformRenderViewport({
    renderScale: args.renderScale,
    scrollLeft: args.scrollLeft,
    viewportWidth: args.viewportWidth,
  });

  return resolveWaveformTileWindow({
    contentWidth: args.contentWidth,
    overscanTiles: args.overscanTiles,
    scrollLeft: renderViewport.scrollLeft,
    tileWidth: args.tileWidth,
    viewportWidth: renderViewport.viewportWidth,
  });
}

export function resolveWaveformTilePriorityIndex(args: {
  anchorSeconds?: number | null;
  renderPixelsPerSecond: number;
  sourceTileWidth: number;
}) {
  if (typeof args.anchorSeconds !== "number" || !Number.isFinite(args.anchorSeconds)) {
    return null;
  }

  const renderPixelsPerSecond = Math.max(1, args.renderPixelsPerSecond);
  const sourceTileWidth = Math.max(1, args.sourceTileWidth);

  return (Math.max(0, args.anchorSeconds) * renderPixelsPerSecond) / sourceTileWidth;
}

export function resolveWaveformTileRenderBatch(args: {
  indexes: readonly number[];
  limit: number;
  mode: WaveformTileRenderMode;
}): WaveformTileRenderBatch {
  const limit = clampInteger(args.limit, 1, Math.max(1, args.indexes.length));

  if (args.indexes.length <= limit) {
    return {
      deferredIndexes: [],
      immediateIndexes: [...args.indexes],
    };
  }

  return {
    deferredIndexes: args.indexes.slice(limit),
    immediateIndexes: args.indexes.slice(0, limit),
  };
}

export function resolveWaveformTileRenderScope(args: {
  mode: WaveformTileRenderMode;
  renderBatch: WaveformTileRenderBatch;
  tileLoadOrder: readonly number[];
  visibleTileLoadOrder: readonly number[];
}): WaveformTileRenderScope {
  if (args.mode === "active-scroll") {
    return {
      allowOffscreen: false,
      immediateIndexes: [...args.visibleTileLoadOrder],
      loadIndexes: [...args.tileLoadOrder],
      visibilityIndexes: [...args.visibleTileLoadOrder],
    };
  }

  const visibilityIndexes =
    args.mode === "visible-only" ? args.visibleTileLoadOrder : args.tileLoadOrder;

  return {
    allowOffscreen: args.mode === "complete",
    immediateIndexes: [...args.renderBatch.immediateIndexes],
    loadIndexes: [...args.renderBatch.immediateIndexes],
    visibilityIndexes: [...visibilityIndexes],
  };
}

export function resolveWaveformDeferredRenderIndexes(args: {
  allowOffscreen?: boolean;
  deferredIndexes: readonly number[];
  mode: WaveformTileRenderMode;
  offscreenTileLoadOrder: readonly number[];
}): number[] {
  if (args.mode === "complete" && args.allowOffscreen !== false) {
    return [...args.deferredIndexes, ...args.offscreenTileLoadOrder];
  }

  return [...args.deferredIndexes];
}

export function resolveWaveformTileLoadQueue(args: {
  current: WaveformTileLoadQueueState;
  entries?: readonly WaveformTilePrefetchQueueEntry[];
  indexes: readonly number[];
  shouldQueue: (index: number) => boolean;
  priority: WaveformTileLoadPriority;
  reason: WaveformTileLoadQueueReason;
  queuedAtMs: number;
  retainPendingQueue: boolean;
}): WaveformTileLoadQueueState {
  let nextOrder = args.current.nextOrder;
  const byQueueKey = new Map<string, WaveformTileLoadQueueEntry>();

  if (args.retainPendingQueue) {
    for (const entry of args.current.entries) {
      if (args.shouldQueue(entry.index)) {
        byQueueKey.set(createWaveformTileLoadQueueEntryKey(entry), entry);
      }
    }
  }

  const explicitEntries = new Map<number, WaveformTilePrefetchQueueEntry>();
  for (const entry of args.entries ?? []) {
    explicitEntries.set(entry.index, entry);
  }

  for (const index of args.indexes) {
    if (!args.shouldQueue(index)) {
      continue;
    }

    const explicitEntry = explicitEntries.get(index);
    const nextEntry: WaveformTileLoadQueueEntry = {
      cacheKey: explicitEntry?.cacheKey,
      fetchStartPx: explicitEntry?.fetchStartPx,
      fetchWidthPx: explicitEntry?.fetchWidthPx,
      index,
      order: nextOrder,
      priority: args.priority,
      queuedAtMs: args.queuedAtMs,
      reason: args.reason,
      renderPixelsPerSecond: explicitEntry?.renderPixelsPerSecond,
    };
    const queueKey = createWaveformTileLoadQueueEntryKey(nextEntry);
    const existing = byQueueKey.get(queueKey);
    if (existing) {
      byQueueKey.set(queueKey, {
        ...existing,
        priority: resolveWaveformTileLoadPriority(existing.priority, args.priority),
        reason:
          resolveWaveformTileLoadPriority(existing.priority, args.priority) === existing.priority
            ? existing.reason
            : args.reason,
      });
      continue;
    }

    byQueueKey.set(queueKey, nextEntry);
    nextOrder += 1;
  }

  return {
    entries: Array.from(byQueueKey.values()).sort(
      (left, right) =>
        resolveWaveformTileLoadPriorityRank(left.priority) -
          resolveWaveformTileLoadPriorityRank(right.priority) ||
        left.order - right.order ||
        left.index - right.index,
    ),
    nextOrder,
  };
}

function resolveWaveformTileLoadPriority(
  left: WaveformTileLoadPriority,
  right: WaveformTileLoadPriority,
) {
  return resolveWaveformTileLoadPriorityRank(left) <= resolveWaveformTileLoadPriorityRank(right)
    ? left
    : right;
}

function resolveWaveformTileLoadPriorityRank(priority: WaveformTileLoadPriority) {
  const priorityRank: Record<WaveformTileLoadPriority, number> = {
    visible: 0,
    prefetch: 1,
    offscreen: 2,
  };

  return priorityRank[priority];
}

function createWaveformTileLoadQueueEntryKey(
  entry: Pick<WaveformTileLoadQueueEntry, "index"> & {
    cacheKey?: string;
  },
) {
  return entry.cacheKey ? `cache:${entry.cacheKey}` : `tile:${entry.index}`;
}

export function resolveWaveformTileLoadGroups(args: {
  indexes: readonly number[];
  visibleTileWindow: WaveformTileWindow;
}) {
  const visibleIndexes: number[] = [];
  const offscreenIndexes: number[] = [];

  for (const index of args.indexes) {
    if (isWaveformTileIndexInWindow(index, args.visibleTileWindow)) {
      visibleIndexes.push(index);
    } else {
      offscreenIndexes.push(index);
    }
  }

  return {
    offscreenIndexes,
    visibleIndexes,
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

export function resolveWaveformPresentationTransform(args: { transformPx: number }) {
  const transforms: string[] = [];

  if (Math.abs(args.transformPx) >= 0.001) {
    transforms.push(`translate3d(${args.transformPx}px, 0, 0)`);
  }

  return transforms.join(" ") || "none";
}

export function resolveWaveformTileDisplayWidth(args: { renderScale: number; widthPx: number }) {
  const renderScale = resolveWaveformDisplayScale(args.renderScale);

  return Math.max(1, Math.ceil(Math.max(1, args.widthPx) * renderScale));
}

export function resolveWaveformTileDisplayRange(args: {
  contentWidth: number;
  renderScale: number;
  sourceStartPx: number;
  sourceWidthPx: number;
}): WaveformTileDisplayRange {
  const contentWidth = Math.max(1, Math.ceil(args.contentWidth));
  const renderScale = resolveWaveformDisplayScale(args.renderScale);
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
  const maxRenderScale =
    WAVEFORM_FALLBACK_MAX_PIXELS_PER_SECOND / Math.max(1, args.renderPixelsPerSecond);

  return Math.ceil(1 / Math.max(0.001, Math.min(1, minRenderScale, maxRenderScale))) + 2;
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
  const sourceTileWidth = resolveWaveformSourceTileWidth({
    renderScale: args.renderMetrics.scale,
  });
  const sourceStartPx = args.index * sourceTileWidth;
  const sourceWidthPx = Math.max(
    1,
    Math.min(sourceTileWidth, args.renderMetrics.contentWidth - sourceStartPx),
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

  const renderScale = resolveWaveformDisplayScale(args.renderScale);
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

function resolveWaveformDisplayScale(renderScale: number) {
  return clampNumber(renderScale, 0.001, 1);
}

export function resolveWaveformNextDensityPrefetchEntries(args: {
  contentWidth: number;
  currentRenderPixelsPerSecond: number;
  durationMs: number;
  nextRenderPixelsPerSecond: number;
  pixelsPerSecond: number;
  priorityIndex?: number | null;
  visibleTileWindow: WaveformTileWindow;
}) {
  const nextMetrics = resolveWaveformRenderMetricsForPixelsPerSecond({
    durationMs: args.durationMs,
    pixelsPerSecond: args.pixelsPerSecond,
    renderPixelsPerSecond: args.nextRenderPixelsPerSecond,
  });
  const nextSourceTileWidth = resolveWaveformSourceTileWidth({
    renderScale: nextMetrics.scale,
  });
  const scaleRatio =
    Math.max(1, args.nextRenderPixelsPerSecond) / Math.max(1, args.currentRenderPixelsPerSecond);
  const startIndex = Math.floor(args.visibleTileWindow.startIndex * scaleRatio);
  const endIndex = Math.ceil((args.visibleTileWindow.endIndex + 1) * scaleRatio) - 1;
  const maxIndex = Math.max(0, Math.ceil(nextMetrics.contentWidth / nextSourceTileWidth) - 1);
  const nextTileWindow: WaveformTileWindow = {
    startIndex: clampInteger(startIndex, 0, maxIndex),
    endIndex: clampInteger(endIndex, 0, maxIndex),
  };
  const priorityIndex =
    typeof args.priorityIndex === "number" && Number.isFinite(args.priorityIndex)
      ? args.priorityIndex * scaleRatio
      : null;
  const indexes = resolveWaveformTileLoadOrder({
    endIndex: nextTileWindow.endIndex,
    priorityIndex,
    startIndex: nextTileWindow.startIndex,
    visibleEndIndex: nextTileWindow.endIndex,
    visibleStartIndex: nextTileWindow.startIndex,
  });

  return indexes.slice(0, WAVEFORM_TILE_PREFETCH_LIMIT).map((index) => {
    const geometry = resolveWaveformTileGeometry({
      contentWidth: args.contentWidth,
      index,
      renderMetrics: nextMetrics,
    });

    return {
      fetchStartPx: geometry.fetchStartPx,
      fetchWidthPx: geometry.fetchWidthPx,
      index,
      renderPixelsPerSecond: args.nextRenderPixelsPerSecond,
    };
  });
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

export function resolveWaveformPlayheadStyle(args: {
  pixelsPerSecond: number;
  positionMs: number | null;
  scrollLeft: number;
  viewportWidth: number;
}) {
  const playheadX = resolveWaveformPlayheadX({
    pixelsPerSecond: args.pixelsPerSecond,
    positionMs: args.positionMs,
    scrollLeft: args.scrollLeft,
  });
  const isVisible =
    playheadX !== null && playheadX >= 0 && playheadX <= Math.max(1, args.viewportWidth);

  return {
    opacity: isVisible ? "0.86" : "0",
    transform: isVisible
      ? `translate3d(${Math.round(playheadX)}px, 0, 0)`
      : "translate3d(-9999px, 0, 0)",
  };
}

export function normalizeWaveformPathKey(path: string | null | undefined) {
  return normalizeMediaPathKey(path);
}

export function resolveTrackWaveformInitialStatus(filePath: string | null | undefined) {
  return filePath?.trim() ? "loading" : "idle";
}

class WaveformPlayheadController {
  private host: HTMLElement | null = null;
  private playhead: HTMLDivElement | null = null;
  private playbackSnapshot: PlaybackSnapshot | null = null;
  private presentation: WaveformPresentedViewport | null = null;
  private playheadFrameId: number | null = null;
  private playheadOpacity = "";
  private playheadTransform = "";

  dispose() {
    this.cancelPlayheadFrame();
    this.playbackSnapshot = null;
    this.presentation = null;
    this.playhead = null;
    this.host = null;
    this.playheadOpacity = "";
    this.playheadTransform = "";
  }

  setHost(host: HTMLElement | null) {
    this.host = host;
    this.requestPlayheadRender();
  }

  setPlayhead(playhead: HTMLDivElement | null) {
    this.playhead = playhead;
    this.playheadOpacity = "";
    this.playheadTransform = "";
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

  setPresentation(presentation: WaveformPresentedViewport | null) {
    this.presentation = presentation;
    this.requestPlayheadRender();
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

  getOwnerWindow() {
    return (
      this.host?.ownerDocument.defaultView ??
      this.playhead?.ownerDocument.defaultView ??
      (typeof window === "undefined" ? null : window)
    );
  }

  private isPlaybackAdvancing() {
    return this.playbackSnapshot?.playing === true && this.playbackSnapshot.paused === false;
  }

  private renderPlayhead() {
    const snapshot = this.playbackSnapshot;
    const presentation = this.presentation;
    if (!snapshot || !presentation) {
      this.applyPlayheadStyle({
        opacity: "0",
        transform: "translate3d(-9999px, 0, 0)",
      });
      return;
    }

    const positionMs = resolvePlaybackPositionMs({
      durationMs: presentation.summary.duration_ms,
      nowMs: readWaveformPerformanceNow(this.getOwnerWindow()),
      snapshot,
    });

    this.applyPlayheadStyle(
      resolveWaveformPlayheadStyle({
        pixelsPerSecond: presentation.pixelsPerSecond,
        positionMs,
        scrollLeft: presentation.scrollLeft,
        viewportWidth: presentation.viewportWidth,
      }),
    );
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
}

class WaveformTileRenderFrameController {
  private frameId: number | null = null;
  private pendingRequest: WaveformTileRenderRequest = {
    focus: null,
    mode: "complete",
    trace: null,
  };

  constructor(private readonly owner: WaveformTileRenderFrameOwner) {}

  dispose() {
    this.cancel();
  }

  cancel() {
    if (this.frameId === null) {
      this.pendingRequest = {
        focus: null,
        mode: "complete",
        trace: null,
      };
      return;
    }

    this.owner.getOwnerWindow()?.cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.pendingRequest = {
      focus: null,
      mode: "complete",
      trace: null,
    };
  }

  request(request: Partial<WaveformTileRenderRequest> = {}) {
    if (this.frameId !== null) {
      this.pendingRequest = this.mergeRequest(this.pendingRequest, request);
      return;
    }

    this.pendingRequest = {
      focus: request.focus ?? null,
      mode: request.mode ?? "complete",
      trace: request.trace ?? null,
    };

    const ownerWindow = this.owner.getOwnerWindow();
    if (!ownerWindow) {
      const pendingRequest = this.flushPendingRequest();
      this.owner.renderTileWindow(pendingRequest);
      return;
    }

    this.frameId = ownerWindow.requestAnimationFrame(() => {
      this.frameId = null;
      const pendingRequest = this.flushPendingRequest();
      this.owner.renderTileWindow(pendingRequest);
    });
  }

  private mergeRequest(
    current: WaveformTileRenderRequest,
    incoming: Partial<WaveformTileRenderRequest>,
  ): WaveformTileRenderRequest {
    return {
      focus: incoming.focus ?? current.focus,
      mode: incoming.mode
        ? resolveWaveformTileRenderMode(current.mode, incoming.mode)
        : current.mode,
      trace: incoming.trace ?? current.trace,
    };
  }

  private flushPendingRequest() {
    const pendingRequest = this.pendingRequest;
    this.pendingRequest = {
      focus: null,
      mode: "complete",
      trace: null,
    };
    return pendingRequest;
  }
}

class WaveformScrollSettleController {
  private ownerWindow: Window | null = null;
  private timerId: number | null = null;

  constructor(private readonly owner: WaveformScrollSettleOwner) {}

  dispose() {
    this.cancel();
  }

  cancel() {
    if (this.timerId === null) {
      return;
    }

    this.ownerWindow?.clearTimeout(this.timerId);
    this.ownerWindow = null;
    this.timerId = null;
  }

  schedule() {
    this.cancel();

    const ownerWindow = this.owner.getOwnerWindow();
    if (!ownerWindow) {
      this.owner.renderSettledTileWindow();
      return;
    }

    this.ownerWindow = ownerWindow;
    this.timerId = ownerWindow.setTimeout(() => {
      this.ownerWindow = null;
      this.timerId = null;
      this.owner.renderSettledTileWindow();
    }, WAVEFORM_SCROLL_SETTLE_DELAY_MS);
  }
}

class WaveformOffscreenTileRenderController {
  private handle: number | null = null;
  private handleType: "frame" | "idle" | null = null;
  private ownerWindow: Window | null = null;
  private pendingJob: WaveformOffscreenTileRenderJob | null = null;

  constructor(private readonly owner: WaveformOffscreenTileRenderOwner) {}

  dispose() {
    this.cancel();
  }

  cancel() {
    if (this.handle === null) {
      this.pendingJob = null;
      return;
    }

    const ownerWindow = this.ownerWindow as WaveformIdleWindow | null;
    if (this.handleType === "idle") {
      ownerWindow?.cancelIdleCallback?.(this.handle);
    } else {
      ownerWindow?.cancelAnimationFrame(this.handle);
    }

    this.handle = null;
    this.handleType = null;
    this.ownerWindow = null;
    this.pendingJob = null;
  }

  schedule(job: WaveformOffscreenTileRenderJob) {
    if (job.indexes.length === 0) {
      this.cancel();
      return;
    }

    this.pendingJob = job;

    if (this.handle !== null) {
      return;
    }

    const ownerWindow = this.owner.getOwnerWindow() as WaveformIdleWindow | null;
    if (!ownerWindow) {
      this.run({
        didTimeout: true,
        timeRemaining: () => Number.POSITIVE_INFINITY,
      });
      return;
    }

    this.ownerWindow = ownerWindow;

    if (ownerWindow.requestIdleCallback) {
      this.handleType = "idle";
      this.handle = ownerWindow.requestIdleCallback(
        (deadline) => {
          this.run(deadline);
        },
        { timeout: WAVEFORM_OFFSCREEN_RENDER_IDLE_TIMEOUT_MS },
      );
      return;
    }

    this.handleType = "frame";
    this.handle = ownerWindow.requestAnimationFrame(() => {
      this.run({
        didTimeout: true,
        timeRemaining: () => Number.POSITIVE_INFINITY,
      });
    });
  }

  private run(deadline: WaveformIdleDeadline) {
    const job = this.pendingJob;

    this.handle = null;
    this.handleType = null;
    this.ownerWindow = null;
    this.pendingJob = null;

    if (!job || !this.owner.isOffscreenTileRenderJobCurrent(job)) {
      return;
    }

    const indexes: number[] = [];
    let remainingIndexes: number[] = [];

    for (const index of job.indexes) {
      if (
        indexes.length >= WAVEFORM_OFFSCREEN_RENDER_BATCH_LIMIT ||
        (indexes.length > 0 && !deadline.didTimeout && deadline.timeRemaining() < 2)
      ) {
        remainingIndexes = job.indexes.slice(indexes.length);
        break;
      }

      indexes.push(index);
    }

    recordWaveformTrace("tile.offscreen.run", {
      didTimeout: deadline.didTimeout,
      generation: job.generation,
      indexes: sampleWaveformTraceIndexes(indexes),
      processedCount: indexes.length,
      reason: job.reason,
      remainingIndexes: sampleWaveformTraceIndexes(remainingIndexes),
      remainingCount: remainingIndexes.length,
      timeRemaining: deadline.timeRemaining(),
      totalCount: job.indexes.length,
    });

    this.owner.renderOffscreenTileIndexes({ indexes, job });

    if (remainingIndexes.length > 0) {
      this.schedule({
        ...job,
        indexes: remainingIndexes,
      });
    }
  }
}

class WaveformTileLoadController {
  private activeCount = 0;
  private frameId: number | null = null;
  private generation = 0;
  private queue: WaveformTileLoadQueueState = {
    entries: [],
    nextOrder: 0,
  };

  constructor(private readonly owner: WaveformTileLoadOwner) {}

  dispose() {
    this.invalidate();
  }

  delete(index: number) {
    this.queue = {
      ...this.queue,
      entries: this.queue.entries.filter((entry) => entry.index !== index),
    };
  }

  invalidate() {
    this.generation += 1;
    this.activeCount = 0;
    this.queue = {
      entries: [],
      nextOrder: 0,
    };
    this.cancelFrame();
  }

  queueIndexes(indexes: readonly number[], options: WaveformTileLoadQueueOptions = {}) {
    const previousQueueSize = this.queue.entries.length;
    const retainPendingQueue = options.retainPendingQueue ?? true;
    const priority = options.priority ?? "visible";
    const reason =
      options.reason ??
      (priority === "visible" ? "render-window-visible" : "render-window-offscreen");
    const queuedAtMs = readWaveformPerformanceNow(this.owner.getOwnerWindow());
    const incomingTiles = isWaveformTraceDetailEnabled()
      ? sampleWaveformTraceItems(indexes, (index) => {
          const tile = this.owner.getTileLoadNode(index);

          return {
            index,
            isPending: tile?.status === "pending",
            tile: tile ? createWaveformTileTracePayload(tile) : null,
          };
        })
      : [];

    this.queue = resolveWaveformTileLoadQueue({
      current: this.queue,
      entries: options.entries,
      indexes,
      shouldQueue: (index) => {
        if (options.entries) {
          return true;
        }

        return this.owner.getTileLoadNode(index)?.status === "pending";
      },
      priority,
      reason,
      queuedAtMs,
      retainPendingQueue,
    });
    recordWaveformTrace("tile.load.queue", {
      activeCount: this.activeCount,
      incomingIndexes: sampleWaveformTraceIndexes(indexes),
      incomingCount: indexes.length,
      incomingTiles,
      nextQueueSize: this.queue.entries.length,
      offscreenQueueCount: this.queue.entries.filter((entry) => entry.priority === "offscreen")
        .length,
      prefetchQueueCount: this.queue.entries.filter(
        (entry) => entry.reason === "prefetch-next-density",
      ).length,
      previousQueueSize,
      priority,
      queue: sampleWaveformTraceItems(this.queue.entries, (entry) => ({
        ageMs: queuedAtMs - entry.queuedAtMs,
        index: entry.index,
        priority: entry.priority,
        reason: entry.reason,
      })),
      queueSampleSize: Math.min(this.queue.entries.length, WAVEFORM_TRACE_SAMPLE_LIMIT),
      reason,
      retainPendingQueue,
      visibleQueueCount: this.queue.entries.filter((entry) => entry.priority === "visible").length,
    });
    this.requestPump();
  }

  queuePrefetchEntries(
    entries: readonly WaveformTilePrefetchQueueEntry[],
    options: Omit<WaveformTileLoadQueueOptions, "entries"> = {},
  ) {
    const pendingEntries = entries.filter((entry) => !this.owner.getCachedTileData(entry.cacheKey));

    if (pendingEntries.length === 0) {
      return;
    }

    this.queueIndexes(
      pendingEntries.map((entry) => entry.index),
      {
        ...options,
        entries: pendingEntries,
        priority: options.priority ?? "prefetch",
        reason: options.reason ?? "prefetch-next-density",
        retainPendingQueue: true,
      },
    );
  }

  private cancelFrame() {
    if (this.frameId === null) {
      return;
    }

    this.owner.getOwnerWindow()?.cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  private finishLoad(generation: number) {
    if (this.generation !== generation) {
      return;
    }

    this.activeCount = Math.max(0, this.activeCount - 1);
    this.requestPump();
  }

  private pump() {
    this.frameId = null;

    const inputs = this.owner.getTileLoadInputs();
    if (!inputs || inputs.status !== "ready" || !inputs.filePath) {
      recordWaveformTrace("tile.load.pump.skip", {
        hasFilePath: Boolean(inputs?.filePath),
        hasInputs: Boolean(inputs),
        queueSize: this.queue.entries.length,
        status: inputs?.status ?? null,
      });
      this.queue = {
        ...this.queue,
        entries: [],
      };
      return;
    }

    const generation = this.generation;
    const renderMetrics = resolveWaveformRenderMetrics(inputs);

    while (this.activeCount < this.resolveLoadConcurrency() && this.queue.entries.length > 0) {
      const nextEntry = this.queue.entries.shift();
      if (!nextEntry) {
        break;
      }

      const isPrefetch = nextEntry.reason === "prefetch-next-density";
      const tile = this.owner.getTileLoadNode(nextEntry.index);
      if (!isPrefetch && (!tile || tile.status !== "pending")) {
        recordWaveformTrace("tile.load.drop", {
          index: nextEntry.index,
          priority: nextEntry.priority,
          queueSize: this.queue.entries.length,
          loadReason: nextEntry.reason,
          reason: tile ? "not-pending" : "missing-tile",
          tile: tile ? createWaveformTileTracePayload(tile) : null,
        });
        continue;
      }

      const renderPixelsPerSecond =
        nextEntry.renderPixelsPerSecond ?? renderMetrics.pixelsPerSecond;
      const fetchStartPx = nextEntry.fetchStartPx ?? tile?.fetchStartPx;
      const fetchWidthPx = nextEntry.fetchWidthPx ?? tile?.fetchWidthPx;
      if (fetchStartPx === undefined || fetchWidthPx === undefined) {
        recordWaveformTrace("tile.load.drop", {
          index: nextEntry.index,
          priority: nextEntry.priority,
          queueSize: this.queue.entries.length,
          loadReason: nextEntry.reason,
          reason: "missing-fetch-range",
          tile: tile ? createWaveformTileTracePayload(tile) : null,
        });
        continue;
      }
      const cacheKey =
        nextEntry.cacheKey ??
        createWaveformTileRequestCacheKey({
          inputs,
          renderPixelsPerSecond,
          tileStartPx: fetchStartPx,
          tileWidthPx: fetchWidthPx,
        });
      const cachedTileData = this.owner.getCachedTileData(cacheKey);
      if (cachedTileData) {
        recordWaveformTrace("tile.load.cache-hit", {
          cacheKey,
          index: nextEntry.index,
          priority: nextEntry.priority,
          queueSize: this.queue.entries.length,
          reason: nextEntry.reason,
          renderPixelsPerSecond,
        });
        if (!isPrefetch && tile) {
          void this.owner.applyTileLoadSuccess({ tile, tileData: cachedTileData });
        }
        continue;
      }

      if (!isPrefetch && tile) {
        tile.status = "loading";
      }
      this.activeCount += 1;
      recordWaveformTrace("tile.load.start", {
        activeCount: this.activeCount,
        displayStartPx: tile?.displayStartPx ?? null,
        displayWidthPx: tile?.displayWidthPx ?? null,
        fetchStartPx,
        fetchWidthPx,
        generation,
        index: nextEntry.index,
        priority: nextEntry.priority,
        queueWaitMs: readWaveformPerformanceNow(this.owner.getOwnerWindow()) - nextEntry.queuedAtMs,
        queueSize: this.queue.entries.length,
        reason: nextEntry.reason,
        renderPixelsPerSecond,
        sourceStartPx: tile?.sourceStartPx ?? null,
        sourceWidthPx: tile?.sourceWidthPx ?? null,
      });
      void this.loadTileNode({
        cacheKey,
        fetchStartPx,
        fetchWidthPx,
        inputs,
        index: nextEntry.index,
        reason: nextEntry.reason,
        renderPixelsPerSecond,
        tile,
      })
        .then((result) => {
          if (result === "retry" && tile) {
            this.queueIndexes([tile.index], {
              reason: "load-retry",
            });
          }
        })
        .finally(() => {
          this.finishLoad(generation);
        });
    }

    if (
      this.queue.entries.length > 0 &&
      this.activeCount < this.resolveLoadConcurrency() &&
      this.frameId === null
    ) {
      this.requestPump();
    }
  }

  private async loadTileNode(args: {
    cacheKey: string;
    fetchStartPx: number;
    fetchWidthPx: number;
    index: number;
    inputs: WaveformRenderInputs;
    reason: WaveformTileLoadQueueReason;
    renderPixelsPerSecond: number;
    tile: WaveformTileNodeState | null | undefined;
  }): Promise<WaveformTileLoadResult> {
    const { inputs, renderPixelsPerSecond, tile } = args;
    const filePath = inputs.filePath;
    const ownerWindow = tile?.canvas.ownerDocument.defaultView ?? this.owner.getOwnerWindow();
    const startedAt = readWaveformPerformanceNow(ownerWindow);

    if (!filePath) {
      return "done";
    }

    try {
      const tileData = await inputs.waveformPort.getTrackWaveformTile(
        filePath,
        normalizeWaveformBoundary(inputs.start),
        normalizeWaveformBoundary(inputs.end),
        renderPixelsPerSecond,
        args.fetchStartPx,
        args.fetchWidthPx,
      );

      recordWaveformTrace("tile.load.resolve", {
        cacheKey: args.cacheKey,
        durationMs: readWaveformPerformanceNow(ownerWindow) - startedAt,
        displayStartPx: tile?.displayStartPx ?? null,
        displayWidthPx: tile?.displayWidthPx ?? null,
        fetchStartPx: args.fetchStartPx,
        fetchWidthPx: args.fetchWidthPx,
        index: args.index,
        maxLength: tileData.max.length,
        minLength: tileData.min.length,
        reason: args.reason,
        renderPixelsPerSecond,
        resultStartPx: tileData.start_px,
        resultWidthPx: tileData.width_px,
        sourceStartPx: tile?.sourceStartPx ?? null,
        sourceWidthPx: tile?.sourceWidthPx ?? null,
      });
      this.owner.cachePrefetchedTileData({
        key: args.cacheKey,
        reason: args.reason,
        tileData,
      });
      if (args.reason === "prefetch-next-density") {
        return "done";
      }
      if (!tile || this.owner.getTileLoadNode(tile.index) !== tile || tile.status !== "loading") {
        recordWaveformTrace("tile.load.stale", {
          index: args.index,
          reason: "status-changed-before-apply",
          renderPixelsPerSecond,
          status: tile?.status ?? null,
        });
        return "stale";
      }
      return this.owner.applyTileLoadSuccess({ tile, tileData });
    } catch (error) {
      console.error("Failed to render waveform tile", error);
      recordWaveformTrace("tile.load.error", {
        durationMs: readWaveformPerformanceNow(ownerWindow) - startedAt,
        index: args.index,
        message: error instanceof Error ? error.message : String(error),
        renderPixelsPerSecond,
      });
      if (tile) {
        this.owner.applyTileLoadError(tile);
      }
      return "done";
    }
  }

  private requestPump() {
    if (this.frameId !== null || this.queue.entries.length === 0) {
      return;
    }

    if (this.queue.entries.some((entry) => entry.priority === "visible")) {
      this.pump();
      return;
    }

    const ownerWindow = this.owner.getOwnerWindow();
    if (!ownerWindow) {
      this.pump();
      return;
    }

    this.frameId = ownerWindow.requestAnimationFrame(() => {
      this.pump();
    });
  }

  private resolveLoadConcurrency() {
    if (this.queue.entries.every((entry) => entry.reason === "prefetch-next-density")) {
      return WAVEFORM_TILE_PREFETCH_CONCURRENCY;
    }

    return this.queue.entries.some((entry) => entry.priority === "visible")
      ? WAVEFORM_TILE_LOAD_CONCURRENCY
      : 1;
  }
}

class WaveformTileController {
  private cachedTileData = new Map<string, WaveformTileDataCacheEntry>();
  private tileDataScopeKey = "";
  private host: HTMLElement | null = null;
  private inputs: WaveformRenderInputs | null = null;
  private layerKey = "";
  private renderGeneration = 0;
  private renderLayer: HTMLDivElement | null = null;
  private renderLayerBaseContentWidth = 1;
  private renderLayerBasePixelsPerSecond = 1;
  private renderLayerTransformStyle = "";
  private renderLayerWidthStyle = "";
  private renderLayerWillChangeStyle = "";
  private renderedTileWindow: WaveformTileWindow | null = null;
  private scrollLeft = 0;
  private tileLayer: HTMLDivElement | null = null;
  private tiles = new Map<number, WaveformTileNodeState>();
  private visualScrollLeft = 0;
  private programmaticScrollEcho: WaveformProgrammaticScrollEcho | null = null;
  private readonly offscreenTileRenderController = new WaveformOffscreenTileRenderController(this);
  private readonly renderFrameController = new WaveformTileRenderFrameController(this);
  private readonly scrollSettleController = new WaveformScrollSettleController(this);
  private readonly tileLoadController = new WaveformTileLoadController(this);

  dispose() {
    this.renderFrameController.dispose();
    this.programmaticScrollEcho = null;
    this.clearTiles();
    this.cachedTileData.clear();
    this.renderLayer?.remove();
    this.renderLayer = null;
    this.resetRenderLayerStyleCache();
  }

  setHost(host: HTMLElement | null) {
    this.host = host;
    this.requestTileWindowRender();
  }

  setRenderInputs(inputs: WaveformRenderInputs) {
    const nextInputs = inputs;
    const nextLayerKey = createWaveformTileIdentity(nextInputs);
    const nextDataScopeKey = createWaveformTileDataScopeKey(nextInputs);
    const previousLayerKey = this.layerKey;
    const previousDataScopeKey = this.tileDataScopeKey;
    const layerChanged = previousLayerKey !== nextLayerKey;
    const dataScopeChanged = previousDataScopeKey !== nextDataScopeKey;

    this.inputs = nextInputs;
    this.tileDataScopeKey = nextDataScopeKey;

    if (layerChanged) {
      if (dataScopeChanged) {
        this.cachedTileData.clear();
      }
      this.layerKey = nextLayerKey;
      this.clearTiles();
    } else if (dataScopeChanged) {
      this.cachedTileData.clear();
    }

    this.applyContentWidth(nextInputs.contentWidth);
    this.updateRenderLayerPresentation();
    this.requestTileWindowRender();
  }

  setScrollLeft(scrollLeft: number) {
    this.programmaticScrollEcho = null;
    this.beginViewportScroll(null);
    const changed = this.setActiveViewportScroll({
      scrollLeft,
      trace: null,
      visualScrollLeft: scrollLeft,
    });

    if (changed) {
      this.settleViewportScroll(null);
    }
  }

  applyViewportScrollEvent(visualScrollLeft: number) {
    const previousProgrammaticEcho = this.programmaticScrollEcho;
    const frame = resolveWaveformViewportScrollEventFrame({
      currentScrollLeft: this.scrollLeft,
      incomingVisualScrollLeft: visualScrollLeft,
      isLogicalScrollLocked: false,
      pendingProgrammaticScrollEcho: previousProgrammaticEcho,
    });
    const trace =
      frame.kind === "programmatic-echo"
        ? (previousProgrammaticEcho?.trace ?? null)
        : createWaveformViewportTraceContext("external-scroll");

    if (frame.kind === "external-scroll") {
      this.programmaticScrollEcho = null;
      this.beginViewportScroll(trace);
    }

    recordWaveformTrace("viewport.scroll.event", {
      frame,
      incomingVisualScrollLeft: visualScrollLeft,
      previousScrollLeft: this.scrollLeft,
      previousVisualScrollLeft: this.visualScrollLeft,
      trace,
    });

    const changed = this.setActiveViewportScroll({
      scrollLeft: frame.scrollLeft,
      trace,
      visualScrollLeft: frame.visualScrollLeft,
    });

    if (frame.kind === "external-scroll" && changed) {
      this.settleViewportScroll(trace);
    }

    return changed;
  }

  applyProgrammaticViewportScroll(args: {
    scrollLeft: number;
    trace?: WaveformViewportTraceContext | null;
    visualScrollLeft?: number;
  }) {
    const visualScrollLeft = Math.max(0, args.visualScrollLeft ?? args.scrollLeft);
    this.programmaticScrollEcho = { trace: args.trace ?? null, visualScrollLeft };
    recordWaveformTrace("viewport.programmatic-scroll.apply", {
      previousScrollLeft: this.scrollLeft,
      previousVisualScrollLeft: this.visualScrollLeft,
      requestedScrollLeft: args.scrollLeft,
      trace: args.trace ?? null,
      visualScrollLeft,
    });
    return this.setActiveViewportScroll({
      scrollLeft: args.scrollLeft,
      trace: args.trace ?? null,
      visualScrollLeft,
    });
  }

  beginViewportScroll(trace: WaveformViewportTraceContext | null = null) {
    recordWaveformTrace("viewport.scroll.begin", {
      scrollLeft: this.scrollLeft,
      trace,
      visualScrollLeft: this.visualScrollLeft,
    });
    this.offscreenTileRenderController.cancel();
    this.scrollSettleController.cancel();
  }

  settleViewportScroll(trace: WaveformViewportTraceContext | null = null) {
    recordWaveformTrace("viewport.scroll.settle.schedule", {
      scrollLeft: this.scrollLeft,
      trace,
      visualScrollLeft: this.visualScrollLeft,
    });
    this.scrollSettleController.schedule();
  }

  setActiveViewportScroll(args: {
    scrollLeft: number;
    trace?: WaveformViewportTraceContext | null;
    visualScrollLeft?: number;
  }) {
    const previousScrollLeft = this.scrollLeft;
    const previousVisualScrollLeft = this.visualScrollLeft;
    const changed = this.setViewportPosition(args);
    recordWaveformTrace("viewport.position.apply", {
      changed,
      nextScrollLeft: Math.max(0, args.scrollLeft),
      nextVisualScrollLeft: Math.max(0, args.visualScrollLeft ?? args.scrollLeft),
      previousScrollLeft,
      previousVisualScrollLeft,
      trace: args.trace ?? null,
    });

    if (!changed) {
      return false;
    }

    this.requestActiveScrollTileWindowRender(args.trace ?? null);
    return true;
  }

  private setViewportPosition(args: { scrollLeft: number; visualScrollLeft?: number }) {
    const nextScrollLeft = Math.max(0, args.scrollLeft);
    const nextVisualScrollLeft = Math.max(0, args.visualScrollLeft ?? nextScrollLeft);
    if (
      !hasWaveformViewportPositionChanged({
        currentScrollLeft: this.scrollLeft,
        currentVisualScrollLeft: this.visualScrollLeft,
        nextScrollLeft,
        nextVisualScrollLeft,
      })
    ) {
      return false;
    }

    this.scrollLeft = nextScrollLeft;
    this.visualScrollLeft = nextVisualScrollLeft;
    this.updateRenderLayerPresentation();
    return true;
  }

  getScrollLeft() {
    return this.scrollLeft;
  }

  getContentWidth() {
    return this.inputs?.contentWidth ?? null;
  }

  applyZoomViewportState(args: {
    contentWidth: number;
    scrollLeft: number;
    visualScrollLeft: number;
  }) {
    const visualScrollLeft = Math.max(0, args.visualScrollLeft);
    this.scrollLeft = Math.max(0, args.scrollLeft);
    this.visualScrollLeft = visualScrollLeft;
    this.programmaticScrollEcho = { trace: null, visualScrollLeft };
    this.applyContentWidth(args.contentWidth);
  }

  prepareZoomScrollRange(args: { contentWidth: number; visualScrollLeft: number }) {
    this.programmaticScrollEcho = {
      trace: null,
      visualScrollLeft: Math.max(0, args.visualScrollLeft),
    };
    this.applyContentWidth(args.contentWidth);
  }

  materializeZoomTiles(args: {
    focus?: WaveformTileRenderFocus | null;
    contentWidth: number;
    mode: WaveformTileRenderMode;
    pixelsPerSecond: number;
  }) {
    const startedAt = readWaveformPerformanceNow(this.getOwnerWindow());
    const shouldRecordDetailTrace = isWaveformTraceDetailEnabled();
    const beforeSnapshot = shouldRecordDetailTrace ? this.createPresentationTraceSnapshot() : null;
    const inputs = this.inputs;
    if (!inputs) {
      recordWaveformTrace("zoom.materialize.no-inputs", {
        contentWidth: args.contentWidth,
        mode: args.mode,
        pixelsPerSecond: args.pixelsPerSecond,
      });
      return;
    }

    const nextInputs = {
      ...inputs,
      contentWidth: args.contentWidth,
      pixelsPerSecond: args.pixelsPerSecond,
    };
    const nextLayerKey = createWaveformTileIdentity(nextInputs);
    const nextDataScopeKey = createWaveformTileDataScopeKey(nextInputs);
    const previousDataScopeKey = this.tileDataScopeKey;
    const layerChanged = this.layerKey !== nextLayerKey;
    const dataScopeChanged = previousDataScopeKey !== nextDataScopeKey;

    this.inputs = nextInputs;
    this.tileDataScopeKey = nextDataScopeKey;

    recordWaveformTrace("zoom.materialize.start", {
      focus: args.focus ?? null,
      layerChanged,
      mode: args.mode,
      nextContentWidth: nextInputs.contentWidth,
      nextPixelsPerSecond: nextInputs.pixelsPerSecond,
      previousLayerKey: this.layerKey,
      presentationBefore: beforeSnapshot,
      tileCount: this.tiles.size,
    });

    if (layerChanged) {
      if (dataScopeChanged) {
        this.cachedTileData.clear();
      }
      this.layerKey = nextLayerKey;
      this.clearTiles();
    } else if (dataScopeChanged) {
      this.cachedTileData.clear();
    }

    this.applyContentWidth(nextInputs.contentWidth);
    this.updateRenderLayerPresentation();
    this.renderMaterializedZoomTileWindow({
      focus: args.focus ?? null,
      mode: args.mode,
      trace: null,
    });
    recordWaveformTrace("zoom.materialize.done", {
      afterRender: shouldRecordDetailTrace ? this.createPresentationTraceSnapshot() : null,
      durationMs: readWaveformPerformanceNow(this.getOwnerWindow()) - startedAt,
      layerChanged,
      mode: args.mode,
      renderedTileWindow: this.renderedTileWindow,
      tileCount: this.tiles.size,
    });
  }

  getPresentedViewport(): WaveformPresentedViewport | null {
    const inputs = this.inputs;
    if (!inputs) {
      return null;
    }

    return {
      pixelsPerSecond: inputs.pixelsPerSecond,
      scrollLeft: this.scrollLeft,
      summary: inputs.summary,
      viewportWidth: inputs.viewportWidth,
    };
  }

  private renderMaterializedZoomTileWindow(request: WaveformTileRenderRequest) {
    this.renderFrameController.cancel();
    this.renderTileWindow(request);
  }

  renderTileWindowNow(mode: WaveformTileRenderMode = "complete") {
    this.renderFrameController.cancel();
    this.renderTileWindow({
      focus: null,
      mode,
      trace: null,
    });
  }

  private requestActiveScrollTileWindowRender(trace: WaveformViewportTraceContext | null = null) {
    const inputs = this.inputs;
    if (!inputs || inputs.viewportWidth <= 0) {
      recordWaveformTrace("tile.render.active-scroll.no-inputs", {
        hasInputs: Boolean(inputs),
        trace,
        viewportWidth: inputs?.viewportWidth ?? null,
      });
      return;
    }

    const renderMetrics = resolveWaveformRenderMetrics(inputs);
    const sourceTileWidth = resolveWaveformSourceTileWidth({
      renderScale: renderMetrics.scale,
    });
    const visibleTileWindow = resolveWaveformRenderTileWindow({
      contentWidth: renderMetrics.contentWidth,
      overscanTiles: 0,
      renderScale: renderMetrics.scale,
      scrollLeft: this.scrollLeft,
      tileWidth: sourceTileWidth,
      viewportWidth: inputs.viewportWidth,
    });
    const readiness = visibleTileWindow
      ? this.inspectTileWindowReadiness(visibleTileWindow, renderMetrics)
      : null;
    const ready = readiness?.ready === true;
    const shouldRecordDetailTrace = isWaveformTraceDetailEnabled();
    recordWaveformTrace("tile.render.active-scroll.inspect", {
      ...createWaveformRenderTracePayload({
        inputs,
        renderMetrics,
        scrollLeft: this.scrollLeft,
        sourceTileWidth,
        visualScrollLeft: this.visualScrollLeft,
      }),
      ready,
      readiness,
      renderedTileWindow: this.renderedTileWindow,
      tileWindowSummary:
        shouldRecordDetailTrace && visibleTileWindow
          ? this.summarizeTileWindowStatus(visibleTileWindow)
          : null,
      tileCount: this.tiles.size,
      trace,
      visibleTileWindow,
    });

    if (ready && visibleTileWindow) {
      if (isWaveformTraceEnabled()) {
        recordWaveformTrace("tile.render.active-scroll.skip", {
          ...createWaveformRenderTracePayload({
            inputs,
            renderMetrics,
            scrollLeft: this.scrollLeft,
            sourceTileWidth,
            visualScrollLeft: this.visualScrollLeft,
          }),
          readiness,
          trace,
          tileWindowSummary: shouldRecordDetailTrace
            ? this.summarizeTileWindowStatus(visibleTileWindow)
            : null,
          visibleTileWindow,
        });
      }
      return;
    }

    this.requestTileWindowRender({
      mode: "active-scroll",
      trace,
    });
  }

  private isTileWindowReadyForViewport(
    visibleTileWindow: WaveformTileWindow,
    renderMetrics: ReturnType<typeof resolveWaveformRenderMetrics>,
  ) {
    return this.inspectTileWindowReadiness(visibleTileWindow, renderMetrics).ready;
  }

  private inspectTileWindowReadiness(
    visibleTileWindow: WaveformTileWindow,
    renderMetrics: ReturnType<typeof resolveWaveformRenderMetrics>,
  ): WaveformTileWindowReadiness {
    if (
      !this.renderedTileWindow ||
      !isWaveformTileWindowCoveringWindow(this.renderedTileWindow, visibleTileWindow)
    ) {
      return {
        ready: false,
        reason: "outside-rendered-window",
      };
    }

    for (
      let index = visibleTileWindow.startIndex;
      index <= visibleTileWindow.endIndex;
      index += 1
    ) {
      const tile = this.tiles.get(index);
      if (!tile) {
        return {
          index,
          ready: false,
          reason: "missing-tile",
          tile: null,
        };
      }

      if (!tile.hasDrawnPixels) {
        return {
          index,
          ready: false,
          reason: "not-drawn",
          tile: createWaveformTileTracePayload(tile),
        };
      }

      if (!tile.data) {
        return {
          index,
          ready: false,
          reason: "primary-data-not-ready",
          tile: createWaveformTileTracePayload(tile),
        };
      }

      const geometry = resolveWaveformTileGeometry({
        contentWidth: this.inputs?.contentWidth ?? 0,
        index,
        renderMetrics,
      });
      if (
        tile.sourceStartPx !== geometry.sourceStartPx ||
        tile.sourceWidthPx !== geometry.sourceWidthPx ||
        tile.displayStartPx !== geometry.displayStartPx ||
        tile.displayWidthPx !== geometry.displayWidthPx
      ) {
        return {
          expectedGeometry: geometry,
          index,
          ready: false,
          reason: "geometry-mismatch",
          tile: createWaveformTileTracePayload(tile),
        };
      }
    }

    return {
      ready: true,
      reason: "ready",
    };
  }

  setTileLayer(tileLayer: HTMLDivElement | null) {
    if (this.tileLayer === tileLayer) {
      return;
    }

    this.clearTiles();
    this.renderLayer?.remove();
    this.renderLayer = null;
    this.resetRenderLayerStyleCache();
    this.tileLayer = tileLayer;
    this.ensureRenderLayer();
    this.requestTileWindowRender();
  }

  private clearTiles() {
    const tileCount = this.tiles.size;
    recordWaveformTrace("tile.clear", {
      renderedTileWindow: this.renderedTileWindow,
      tileCount,
      tiles: sampleWaveformTraceItems(this.tiles.values(), createWaveformTileTracePayload),
    });
    this.offscreenTileRenderController.cancel();
    this.scrollSettleController.cancel();
    this.tileLoadController.invalidate();

    for (const tile of this.tiles.values()) {
      tile.canvas.remove();
    }

    this.tiles.clear();
    this.renderedTileWindow = null;
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
    canvas.className = "pointer-events-none absolute top-0 block h-full bg-transparent";
    canvas.style.left = `${geometry.displayStartPx}px`;
    canvas.style.width = `${geometry.displayWidthPx}px`;
    canvas.style.height = `${WAVEFORM_CANVAS_HEIGHT}px`;
    renderLayer.append(canvas);

    const tile: WaveformTileNodeState = {
      canvas,
      data: null,
      displayStartPx: geometry.displayStartPx,
      displayWidthPx: geometry.displayWidthPx,
      drawDataKey: null,
      fetchStartPx: geometry.fetchStartPx,
      fetchWidthPx: geometry.fetchWidthPx,
      drawDisplayStartPx: null,
      drawDisplayWidthPx: null,
      drawOpacity: null,
      drawSampleOffsetPx: null,
      drawScale: null,
      drawStatus: null,
      hasDrawnPixels: false,
      index,
      sourceStartPx: geometry.sourceStartPx,
      sourceWidthPx: geometry.sourceWidthPx,
      status: inputs.status === "ready" && Boolean(inputs.filePath) ? "pending" : "ready",
    };

    const cacheKey = createWaveformTileRequestCacheKey({
      inputs,
      renderPixelsPerSecond: renderMetrics.pixelsPerSecond,
      tileStartPx: geometry.fetchStartPx,
      tileWidthPx: geometry.fetchWidthPx,
    });
    const cachedData = this.getCachedTileData(cacheKey);
    if (cachedData) {
      tile.data = cachedData;
      tile.status = "ready";
      recordWaveformTrace("tile.create.cache-hit", {
        cacheKey,
        index,
        renderPixelsPerSecond: renderMetrics.pixelsPerSecond,
      });
    }

    this.tiles.set(index, tile);
    recordWaveformTrace("tile.create", {
      ...createWaveformTileTracePayload(tile),
      renderPixelsPerSecond: renderMetrics.pixelsPerSecond,
      renderScale: renderMetrics.scale,
    });
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
    renderLayer.className = "pointer-events-none absolute inset-y-0 left-0 z-[1] block h-full";
    renderLayer.style.height = `${WAVEFORM_CANVAS_HEIGHT}px`;
    renderLayer.style.transformOrigin = "left top";
    tileLayer.append(renderLayer);
    this.renderLayer = renderLayer;
    this.resetRenderLayerStyleCache();
    this.applyContentWidth(this.inputs?.contentWidth ?? 1);
    this.updateRenderLayerPresentation();

    return renderLayer;
  }

  private applyContentWidth(contentWidth: number) {
    const width = `${Math.max(1, Math.ceil(contentWidth))}px`;

    if (this.tileLayer) {
      this.tileLayer.style.width = width;
      if (this.tileLayer.parentElement) {
        this.tileLayer.parentElement.style.width = width;
      }
    }
  }

  private createPresentationTraceSnapshot(): WaveformPresentationTraceSnapshot {
    const inputs = this.inputs;
    const renderMetrics = inputs ? resolveWaveformRenderMetrics(inputs) : null;

    return {
      inputs:
        inputs && renderMetrics
          ? {
              contentWidth: inputs.contentWidth,
              pixelsPerSecond: inputs.pixelsPerSecond,
              renderContentWidth: renderMetrics.contentWidth,
              renderPixelsPerSecond: renderMetrics.pixelsPerSecond,
              renderScale: renderMetrics.scale,
              status: inputs.status,
              summaryCacheKey: inputs.summary.cache_key,
            }
          : null,
      renderLayer: this.renderLayer
        ? createWaveformLayerTraceSnapshot({
            baseContentWidth: this.renderLayerBaseContentWidth,
            basePixelsPerSecond: this.renderLayerBasePixelsPerSecond,
            layer: this.renderLayer,
          })
        : null,
      renderedTileWindow: this.renderedTileWindow,
      scrollLeft: this.scrollLeft,
      tileCount: this.tiles.size,
      visualScrollLeft: this.visualScrollLeft,
    };
  }

  createTraceSnapshot() {
    return this.createPresentationTraceSnapshot();
  }

  getOwnerWindow() {
    return (
      this.host?.ownerDocument.defaultView ??
      this.tileLayer?.ownerDocument.defaultView ??
      (typeof window === "undefined" ? null : window)
    );
  }

  private getPresentedInputs() {
    const inputs = this.inputs;
    return inputs;
  }

  renderTileWindow(request: WaveformTileRenderRequest) {
    const startedAt = readWaveformPerformanceNow(this.getOwnerWindow());
    const mode = request.mode;
    const inputs = this.inputs;
    const renderLayer = this.ensureRenderLayer();
    if (!inputs || !renderLayer || !this.host || inputs.viewportWidth <= 0) {
      recordWaveformTrace("tile.render.skip", {
        hasHost: Boolean(this.host),
        hasInputs: Boolean(inputs),
        hasRenderLayer: Boolean(renderLayer),
        mode,
        trace: request.trace,
        viewportWidth: inputs?.viewportWidth ?? null,
      });
      return;
    }

    this.updateRenderLayerPresentation();
    this.renderGeneration += 1;
    const generation = this.renderGeneration;

    const renderMetrics = resolveWaveformRenderMetrics(inputs);
    const sourceTileWidth = resolveWaveformSourceTileWidth({
      renderScale: renderMetrics.scale,
    });
    const tileWindow = resolveWaveformRenderTileWindow({
      contentWidth: renderMetrics.contentWidth,
      overscanTiles: WAVEFORM_TILE_OVERSCAN,
      renderScale: renderMetrics.scale,
      scrollLeft: this.scrollLeft,
      tileWidth: sourceTileWidth,
      viewportWidth: inputs.viewportWidth,
    });
    const visibleTileWindow = resolveWaveformRenderTileWindow({
      contentWidth: renderMetrics.contentWidth,
      overscanTiles: 0,
      renderScale: renderMetrics.scale,
      scrollLeft: this.scrollLeft,
      tileWidth: sourceTileWidth,
      viewportWidth: inputs.viewportWidth,
    });
    const retentionTileWindow = resolveWaveformRenderTileWindow({
      contentWidth: renderMetrics.contentWidth,
      overscanTiles: WAVEFORM_TILE_RETENTION_OVERSCAN,
      renderScale: renderMetrics.scale,
      scrollLeft: this.scrollLeft,
      tileWidth: sourceTileWidth,
      viewportWidth: inputs.viewportWidth,
    });

    if (!tileWindow || !visibleTileWindow || !retentionTileWindow) {
      recordWaveformTrace("tile.render.empty-window", {
        ...createWaveformRenderTracePayload({
          inputs,
          renderMetrics,
          scrollLeft: this.scrollLeft,
          sourceTileWidth,
          visualScrollLeft: this.visualScrollLeft,
        }),
        mode,
        tileCount: this.tiles.size,
        trace: request.trace,
      });
      this.clearTiles();
      this.renderedTileWindow = null;
      return;
    }

    const renderPlan = resolveWaveformTileRenderPlan({
      mountedTileIndexes: this.tiles.keys(),
      priorityIndex: resolveWaveformTilePriorityIndex({
        anchorSeconds: request.focus?.anchorSeconds,
        renderPixelsPerSecond: renderMetrics.pixelsPerSecond,
        sourceTileWidth,
      }),
      retentionTileWindow,
      tileWindow,
      visibleTileWindow,
    });
    const stats = createWaveformTileRenderStats({
      removedTileIndexes: renderPlan.removeIndexes,
      removedTileCount: renderPlan.removeIndexes.length,
      tileCountBefore: this.tiles.size,
    });
    const viewportSampleIndexes = resolveWaveformTraceViewportSampleIndexes({
      tileLoadOrder: renderPlan.tileLoadOrder,
      visibleTileLoadOrder: renderPlan.visibleTileLoadOrder,
    });
    const shouldRecordDetailTrace = isWaveformTraceDetailEnabled();
    const viewportTileSamplesBefore = shouldRecordDetailTrace
      ? this.createTileGeometryTraceSamples(viewportSampleIndexes)
      : [];
    const visibleSummaryBefore = shouldRecordDetailTrace
      ? this.summarizeTileWindowStatus(visibleTileWindow)
      : null;
    const tileSummaryBefore = shouldRecordDetailTrace
      ? this.summarizeTileWindowStatus(tileWindow)
      : null;

    for (const index of renderPlan.removeIndexes) {
      const tile = this.tiles.get(index);
      if (tile) {
        this.removeTile(index, tile);
      }
    }

    const visibleTileIndexes = new Set(renderPlan.visibleTileLoadOrder);
    const renderIndexes =
      mode === "active-scroll" ? renderPlan.tileLoadOrder : renderPlan.visibleTileLoadOrder;
    const renderBatch = resolveWaveformTileRenderBatch({
      indexes: renderIndexes,
      limit: WAVEFORM_TILE_IMMEDIATE_RENDER_LIMIT,
      mode,
    });
    const renderScope = resolveWaveformTileRenderScope({
      mode,
      renderBatch,
      tileLoadOrder: renderPlan.tileLoadOrder,
      visibleTileLoadOrder: renderPlan.visibleTileLoadOrder,
    });
    const retainedSyncIndexes =
      mode === "complete"
        ? renderPlan.retainedSyncIndexes.filter((index) => !visibleTileIndexes.has(index))
        : [];
    const offscreenTileLoadOrder = mode === "complete" ? renderPlan.offscreenTileLoadOrder : [];

    for (const index of retainedSyncIndexes) {
      const tile = this.tiles.get(index);
      if (tile) {
        applyWaveformTileSyncStats(
          stats,
          tile.index,
          this.syncTileGeometry(tile, inputs, renderMetrics),
        );
      }
    }

    this.renderTileIndexes(renderScope.immediateIndexes, inputs, renderMetrics, stats);
    const visibilityPlan = resolveWaveformTileVisibilityPlan({
      mountedTileIndexes: this.tiles.keys(),
      visibleTileIndexes: renderScope.visibilityIndexes,
    });
    this.applyTileVisibilityPlan(visibilityPlan);
    const loadGroups = resolveWaveformTileLoadGroups({
      indexes: renderScope.loadIndexes,
      visibleTileWindow,
    });
    this.tileLoadController.queueIndexes(loadGroups.visibleIndexes, {
      priority: "visible",
      reason: "render-window-visible",
      retainPendingQueue: mode === "complete",
    });
    this.tileLoadController.queueIndexes(loadGroups.offscreenIndexes, {
      priority: "offscreen",
      reason: "render-window-offscreen",
      retainPendingQueue: true,
    });
    this.queueNextDensityPrefetch({
      focus: request.focus ?? null,
      inputs,
      renderMetrics,
      sourceTileWidth,
      visibleTileWindow,
    });
    this.renderedTileWindow = mode === "visible-only" ? visibleTileWindow : tileWindow;
    const readiness = this.inspectTileWindowReadiness(visibleTileWindow, renderMetrics);
    if (mode === "active-scroll" && readiness.ready !== true) {
      this.requestTileWindowRender({
        focus: request.focus ?? null,
        mode: "visible-only",
        trace: request.trace,
      });
    }
    const allowOffscreenRender = renderScope.allowOffscreen && readiness.ready;
    const deferredRenderIndexes = resolveWaveformDeferredRenderIndexes({
      allowOffscreen: allowOffscreenRender,
      deferredIndexes: renderBatch.deferredIndexes,
      mode,
      offscreenTileLoadOrder,
    });
    recordWaveformTrace("tile.render.window", {
      ...createWaveformRenderTracePayload({
        inputs,
        renderMetrics,
        scrollLeft: this.scrollLeft,
        sourceTileWidth,
        visualScrollLeft: this.visualScrollLeft,
      }),
      deferredIndexes: sampleWaveformTraceIndexes(deferredRenderIndexes),
      deferredCount: deferredRenderIndexes.length,
      durationMs: readWaveformPerformanceNow(this.getOwnerWindow()) - startedAt,
      focus: request.focus ?? null,
      generation,
      immediateIndexes: sampleWaveformTraceIndexes(renderScope.immediateIndexes),
      immediateCount: renderScope.immediateIndexes.length,
      loadIndexes: sampleWaveformTraceIndexes(renderScope.loadIndexes),
      loadIndexCount: renderScope.loadIndexes.length,
      mode,
      renderPlanCounts: {
        offscreenAllowed: allowOffscreenRender,
        offscreen: renderPlan.offscreenTileLoadOrder.length,
        removed: renderPlan.removeIndexes.length,
        retainedSync: retainedSyncIndexes.length,
        tileLoad: renderPlan.tileLoadOrder.length,
        visibleLoad: renderPlan.visibleTileLoadOrder.length,
      },
      renderPlanSamples: {
        offscreen: sampleWaveformTraceIndexes(renderPlan.offscreenTileLoadOrder),
        retainedSync: sampleWaveformTraceIndexes(retainedSyncIndexes),
        tileLoad: sampleWaveformTraceIndexes(renderPlan.tileLoadOrder),
        visibleLoad: sampleWaveformTraceIndexes(renderPlan.visibleTileLoadOrder),
      },
      readiness,
      stats,
      tileSummaryAfter: shouldRecordDetailTrace ? this.summarizeTileWindowStatus(tileWindow) : null,
      tileSummaryBefore,
      tileCountAfter: this.tiles.size,
      tileWindowCount: resolveWaveformTileWindowIndexCount(tileWindow),
      tileWindow,
      trace: request.trace,
      visibilityScope: mode === "visible-only" ? "viewport" : "render-window",
      visibleSummaryAfter: shouldRecordDetailTrace
        ? this.summarizeTileWindowStatus(visibleTileWindow)
        : null,
      visibleSummaryBefore,
      viewportTileSamplesAfter: shouldRecordDetailTrace
        ? this.createTileGeometryTraceSamples(viewportSampleIndexes)
        : [],
      viewportTileSamplesBefore,
      visibleTileWindowCount: resolveWaveformTileWindowIndexCount(visibleTileWindow),
      visibleTileWindow,
    });
    if (deferredRenderIndexes.length === 0) {
      this.offscreenTileRenderController.cancel();
    } else {
      this.offscreenTileRenderController.schedule({
        generation,
        indexes: deferredRenderIndexes,
        inputs,
        reason: mode === "complete" ? "complete-offscreen" : "deferred-visible",
        renderMetrics,
        visibleTileWindow,
      });
    }
  }

  private renderTileIndexes(
    indexes: readonly number[],
    inputs: WaveformRenderInputs,
    renderMetrics: ReturnType<typeof resolveWaveformRenderMetrics>,
    stats: WaveformTileRenderStats,
  ) {
    const startedAt = readWaveformPerformanceNow(this.getOwnerWindow());
    const tileCountBefore = this.tiles.size;

    for (const index of indexes) {
      let tile: WaveformTileNodeState | null | undefined = this.tiles.get(index);

      if (!tile) {
        tile = this.createTile(index, inputs, renderMetrics);
        if (tile) {
          stats.createdTileCount += 1;
          pushWaveformTraceSample(stats.createdTileIndexes, index);
        }
      }

      if (!tile) {
        continue;
      }

      tile.canvas.style.visibility = "";
      const syncResult = this.syncTileGeometry(tile, inputs, renderMetrics);
      const drawTraceResult = this.drawTile(tile, inputs, renderMetrics.scale);

      applyWaveformTileRenderStats(stats, tile.index, syncResult, drawTraceResult);
      if (isWaveformTraceDetailEnabled()) {
        pushWaveformTraceSample(stats.renderedTileSamples, createWaveformTileTracePayload(tile));
      }
    }

    recordWaveformTrace("tile.render.indexes", {
      durationMs: readWaveformPerformanceNow(this.getOwnerWindow()) - startedAt,
      indexCount: indexes.length,
      indexes: sampleWaveformTraceIndexes(indexes),
      renderScale: renderMetrics.scale,
      status: inputs.status,
      tileCountAfter: this.tiles.size,
      tileCountBefore,
    });
  }

  private applyTileVisibilityPlan(plan: WaveformTileVisibilityPlan) {
    recordWaveformTrace("tile.visibility.plan", {
      hiddenCount: plan.hiddenIndexes.length,
      hiddenIndexes: sampleWaveformTraceIndexes(plan.hiddenIndexes),
      visibleCount: plan.visibleIndexes.length,
      visibleIndexes: sampleWaveformTraceIndexes(plan.visibleIndexes),
    });

    for (const index of plan.visibleIndexes) {
      const tile = this.tiles.get(index);
      if (tile) {
        tile.canvas.style.visibility = "";
      }
    }

    for (const index of plan.hiddenIndexes) {
      const tile = this.tiles.get(index);
      if (tile) {
        tile.canvas.style.visibility = "hidden";
      }
    }

    if (plan.visibleIndexes.length > 0) {
      const shouldRecordDetailTrace = isWaveformTraceDetailEnabled();
      recordWaveformTrace("tile.viewport.enter", {
        count: plan.visibleIndexes.length,
        indexes: sampleWaveformTraceIndexes(plan.visibleIndexes),
        tiles: shouldRecordDetailTrace
          ? sampleWaveformTraceItems(
              plan.visibleIndexes,
              (index) => this.tiles.get(index),
              WAVEFORM_TRACE_DETAIL_SAMPLE_LIMIT,
            )
              .filter((tile): tile is WaveformTileNodeState => Boolean(tile))
              .map(createWaveformTileTracePayload)
          : [],
        visibilityScope: "render-plan",
      });
    }

    if (plan.hiddenIndexes.length > 0) {
      recordWaveformTrace("tile.viewport.exit", {
        count: plan.hiddenIndexes.length,
        indexes: sampleWaveformTraceIndexes(plan.hiddenIndexes),
        visibilityScope: "render-plan",
      });
    }
  }

  private createTileGeometryTraceSamples(indexes: readonly number[]) {
    return sampleWaveformTraceItems(indexes, (index) => {
      const tile = this.tiles.get(index);

      return {
        index,
        mounted: Boolean(tile),
        tile: tile ? createWaveformTileTracePayload(tile) : null,
      };
    });
  }

  private summarizeTileWindowStatus(window: WaveformTileWindow): WaveformTileWindowStatusSummary {
    const inputs = this.inputs;
    const renderMetrics = inputs ? resolveWaveformRenderMetrics(inputs) : null;
    const summary: WaveformTileWindowStatusSummary = {
      dataCount: 0,
      dirtyDataCount: 0,
      drawnCount: 0,
      loadingCount: 0,
      missingCount: 0,
      mountedCount: 0,
      pendingCount: 0,
      readyCount: 0,
      totalCount: resolveWaveformTileWindowIndexCount(window),
    };

    for (let index = window.startIndex; index <= window.endIndex; index += 1) {
      const tile = this.tiles.get(index);
      if (!tile) {
        summary.missingCount += 1;
        continue;
      }

      summary.mountedCount += 1;
      if (tile.status === "pending") {
        summary.pendingCount += 1;
      } else if (tile.status === "loading") {
        summary.loadingCount += 1;
      } else {
        summary.readyCount += 1;
      }

      if (tile.data) {
        summary.dataCount += 1;
        const geometry = renderMetrics
          ? resolveWaveformTileGeometry({
              contentWidth: inputs?.contentWidth ?? 0,
              index,
              renderMetrics,
            })
          : null;
        if (geometry && !isWaveformTileDataCoveringGeometry(tile.data, geometry)) {
          summary.dirtyDataCount += 1;
        }
      }

      if (tile.hasDrawnPixels) {
        summary.drawnCount += 1;
      }
    }

    return summary;
  }

  private queueNextDensityPrefetch(args: {
    focus?: WaveformTileRenderFocus | null;
    inputs: WaveformRenderInputs;
    renderMetrics: ReturnType<typeof resolveWaveformRenderMetrics>;
    sourceTileWidth: number;
    visibleTileWindow: WaveformTileWindow;
  }) {
    if (args.inputs.status !== "ready" || !args.inputs.filePath) {
      return;
    }

    const nextRenderPixelsPerSecond = resolveWaveformNextRenderPixelsPerSecond({
      pixelsPerSecond: args.inputs.pixelsPerSecond,
      summary: args.inputs.summary,
    });
    if (
      !nextRenderPixelsPerSecond ||
      nextRenderPixelsPerSecond <= args.renderMetrics.pixelsPerSecond
    ) {
      return;
    }

    const prefetchMetrics = createWaveformPrefetchRenderMetrics({
      inputs: args.inputs,
      renderPixelsPerSecond: nextRenderPixelsPerSecond,
    });
    const sourceTileWidth = resolveWaveformSourceTileWidth({
      renderScale: prefetchMetrics.scale,
    });
    const entries = resolveWaveformNextDensityPrefetchEntries({
      contentWidth: args.inputs.contentWidth,
      currentRenderPixelsPerSecond: args.renderMetrics.pixelsPerSecond,
      durationMs: args.inputs.summary.duration_ms,
      nextRenderPixelsPerSecond,
      pixelsPerSecond: args.inputs.pixelsPerSecond,
      priorityIndex: resolveWaveformTilePriorityIndex({
        anchorSeconds: args.focus?.anchorSeconds,
        renderPixelsPerSecond: args.renderMetrics.pixelsPerSecond,
        sourceTileWidth: args.sourceTileWidth,
      }),
      visibleTileWindow: args.visibleTileWindow,
    }).map((entry) => ({
      cacheKey: createWaveformTileRequestCacheKey({
        inputs: args.inputs,
        renderPixelsPerSecond: nextRenderPixelsPerSecond,
        tileStartPx: entry.fetchStartPx,
        tileWidthPx: entry.fetchWidthPx,
      }),
      ...entry,
    }));
    const uniqueEntries = Array.from(
      new Map(entries.map((entry) => [entry.cacheKey, entry])).values(),
    );

    if (uniqueEntries.length === 0) {
      return;
    }

    recordWaveformTrace("tile.prefetch.next-density", {
      currentRenderPixelsPerSecond: args.renderMetrics.pixelsPerSecond,
      currentSourceTileWidth: args.sourceTileWidth,
      entryCount: uniqueEntries.length,
      focus: args.focus ?? null,
      nextRenderPixelsPerSecond,
      nextSourceTileWidth: sourceTileWidth,
      renderScale: args.renderMetrics.scale,
      visibleTileWindow: args.visibleTileWindow,
      samples: sampleWaveformTraceItems(uniqueEntries, (entry) => entry),
    });
    this.tileLoadController.queuePrefetchEntries(uniqueEntries, {
      priority: "prefetch",
      reason: "prefetch-next-density",
    });
  }

  private drawTile(
    tile: WaveformTileNodeState,
    inputs: WaveformRenderInputs,
    renderScale: number,
  ): WaveformTileDrawTraceResult {
    const startedAt = readWaveformPerformanceNow(tile.canvas.ownerDocument.defaultView);
    const finish = (
      result: WaveformTileDrawResult,
      details: {
        drawIntent?: WaveformTileDrawIntent | null;
        drawOpacity?: number | null;
        frameTrace?: WaveformTileFrameTracePayload | null;
        sampleOffsetPx?: number | null;
        skipReason?: WaveformTileDrawSkipReason | null;
      } = {},
    ): WaveformTileDrawTraceResult => {
      const durationMs =
        readWaveformPerformanceNow(tile.canvas.ownerDocument.defaultView) - startedAt;
      if (
        isWaveformTraceEnabled() &&
        (result !== "skipped" ||
          details.skipReason !== "draw-state-current" ||
          durationMs >= WAVEFORM_TRACE_DRAW_DETAIL_THRESHOLD_MS)
      ) {
        recordWaveformTrace("tile.draw.done", {
          ...createWaveformTileTracePayload(tile),
          canvasBackingHeight: tile.canvas.height,
          canvasBackingWidth: tile.canvas.width,
          canvasCssHeight: tile.canvas.clientHeight || WAVEFORM_CANVAS_HEIGHT,
          canvasCssWidth: Math.max(1, Math.ceil(tile.displayWidthPx)),
          drawIntent: details.drawIntent ?? null,
          drawOpacity: details.drawOpacity ?? null,
          durationMs,
          frameTrace: details.frameTrace ?? null,
          renderScale,
          result,
          sampleOffsetPx: details.sampleOffsetPx ?? null,
          skipReason: details.skipReason ?? null,
          status: inputs.status,
        });
      }

      return {
        durationMs,
        result,
      };
    };
    const host = this.host;
    if (!host) {
      return finish("skipped", {
        skipReason: "no-host",
      });
    }

    const drawIntent = resolveWaveformTileDrawIntent({
      hasData: Boolean(tile.data),
      status: inputs.status,
    });

    const drawOpacity = resolveWaveformTileDrawOpacity({
      intent: drawIntent,
      opacity: inputs.opacity,
      status: inputs.status,
    });
    const frameData = tile.data;
    const frameDataKey = frameData ? createWaveformTileDataKey(frameData) : null;
    const sampleOffsetPx = resolveWaveformRasterAlignment({
      sampleScrollLeft: this.scrollLeft,
      scrollLeft: this.visualScrollLeft,
    }).sampleDisplayOffsetPx;

    const drawStatus = drawIntent === "blank" ? null : drawIntent;
    let frameTrace: WaveformTileFrameTracePayload | null = null;
    if (
      tile.drawStatus === drawStatus &&
      tile.drawDataKey === frameDataKey &&
      tile.drawDisplayStartPx === tile.displayStartPx &&
      tile.drawDisplayWidthPx === tile.displayWidthPx &&
      tile.drawOpacity === drawOpacity &&
      tile.drawSampleOffsetPx !== null &&
      Math.abs(tile.drawSampleOffsetPx - sampleOffsetPx) < 0.0001 &&
      tile.drawScale !== null &&
      Math.abs(tile.drawScale - renderScale) < 0.0001
    ) {
      return finish("skipped", {
        drawIntent,
        drawOpacity,
        sampleOffsetPx,
        skipReason: "draw-state-current",
      });
    }

    if (frameData) {
      frameTrace = drawQuantizedWaveformTile({
        canvas: tile.canvas,
        displayStartPx: tile.displayStartPx,
        displaySampleOffsetPx: sampleOffsetPx,
        displayWidthPx: tile.displayWidthPx,
        host,
        opacity: drawOpacity,
        renderScale,
        tile: frameData,
      });
      tile.hasDrawnPixels = true;
    } else if (drawIntent === "blank") {
      if (!tile.hasDrawnPixels) {
        return finish("skipped", {
          drawIntent,
          drawOpacity,
          sampleOffsetPx,
          skipReason: "blank-without-pixels",
        });
      }

      clearWaveformTileCanvas(tile.canvas, tile.displayWidthPx);
      tile.hasDrawnPixels = false;
    } else {
      frameTrace = drawPlaceholderWaveformTile({
        canvas: tile.canvas,
        displayStartPx: tile.displayStartPx,
        displaySampleOffsetPx: sampleOffsetPx,
        displayWidthPx: tile.displayWidthPx,
        host,
        opacity: drawOpacity,
        renderScale,
      });
      tile.hasDrawnPixels = true;
    }

    tile.drawOpacity = drawOpacity;
    tile.drawSampleOffsetPx = sampleOffsetPx;
    tile.drawScale = renderScale;
    tile.drawDataKey = frameDataKey;
    tile.drawStatus = drawStatus;
    tile.drawDisplayStartPx = tile.displayStartPx;
    tile.drawDisplayWidthPx = tile.displayWidthPx;
    return finish(drawIntent, {
      drawIntent,
      drawOpacity,
      frameTrace,
      sampleOffsetPx,
    });
  }

  private drawTileWithCurrentInputs(tile: WaveformTileNodeState) {
    const inputs = this.getPresentedInputs();
    if (!inputs) {
      return;
    }

    const renderMetrics = resolveWaveformRenderMetrics(inputs);
    this.syncTileGeometry(tile, inputs, renderMetrics);
    this.drawTile(tile, inputs, renderMetrics.scale);
  }

  getCachedTileData(key: string): TrackWaveformTile | null {
    const cached = this.cachedTileData.get(key);
    if (!cached) {
      return null;
    }

    cached.lastUsedMs = readWaveformPerformanceNow(this.getOwnerWindow());
    return cached.data;
  }

  cachePrefetchedTileData(args: {
    key: string;
    reason: WaveformTileLoadQueueReason;
    tileData: TrackWaveformTile;
  }) {
    this.cachedTileData.set(args.key, {
      data: args.tileData,
      key: args.key,
      lastUsedMs: readWaveformPerformanceNow(this.getOwnerWindow()),
    });
    this.evictCachedTileData();
    const appliedTileIndexes =
      args.reason === "prefetch-next-density"
        ? this.applyPrefetchedTileDataToWaitingTiles({
            key: args.key,
            tileData: args.tileData,
          })
        : [];
    recordWaveformTrace("tile.data-cache.store", {
      appliedTileCount: appliedTileIndexes.length,
      appliedTileIndexes,
      cacheKey: args.key,
      cacheSize: this.cachedTileData.size,
      maxLength: args.tileData.max.length,
      minLength: args.tileData.min.length,
      pointsPerSecond: args.tileData.points_per_second,
      reason: args.reason,
      startPx: args.tileData.start_px,
      widthPx: args.tileData.width_px,
    });
  }

  private applyPrefetchedTileDataToWaitingTiles(args: {
    key: string;
    tileData: TrackWaveformTile;
  }) {
    const inputs = this.inputs;
    if (!inputs) {
      return [];
    }

    const renderMetrics = resolveWaveformRenderMetrics(inputs);
    const appliedTileIndexes: number[] = [];

    for (const tile of this.tiles.values()) {
      if (tile.status !== "pending" && tile.status !== "loading") {
        continue;
      }

      const tileCacheKey = createWaveformTileRequestCacheKey({
        inputs,
        renderPixelsPerSecond: renderMetrics.pixelsPerSecond,
        tileStartPx: tile.fetchStartPx,
        tileWidthPx: tile.fetchWidthPx,
      });
      if (tileCacheKey !== args.key) {
        continue;
      }

      const result = this.applyTileLoadSuccess({
        tile,
        tileData: args.tileData,
      });
      if (result === "done") {
        pushWaveformTraceSample(appliedTileIndexes, tile.index);
      }
    }

    return appliedTileIndexes;
  }

  private evictCachedTileData() {
    if (this.cachedTileData.size <= WAVEFORM_TILE_DATA_CACHE_LIMIT) {
      return;
    }

    const entries = [...this.cachedTileData.values()].sort(
      (left, right) => left.lastUsedMs - right.lastUsedMs,
    );
    const removeCount = this.cachedTileData.size - WAVEFORM_TILE_DATA_CACHE_LIMIT;

    for (const entry of entries.slice(0, removeCount)) {
      this.cachedTileData.delete(entry.key);
    }

    recordWaveformTrace("tile.data-cache.evict", {
      cacheSize: this.cachedTileData.size,
      removedCount: removeCount,
    });
  }

  renderOffscreenTileIndexes(args: {
    indexes: readonly number[];
    job: WaveformOffscreenTileRenderJob;
  }) {
    const startedAt = readWaveformPerformanceNow(this.getOwnerWindow());
    const stats = createWaveformTileRenderStats({
      removedTileIndexes: [],
      removedTileCount: 0,
      tileCountBefore: this.tiles.size,
    });
    this.renderTileIndexes(args.indexes, args.job.inputs, args.job.renderMetrics, stats);
    const loadGroups = resolveWaveformTileLoadGroups({
      indexes: args.indexes,
      visibleTileWindow: args.job.visibleTileWindow,
    });
    this.tileLoadController.queueIndexes(loadGroups.visibleIndexes, {
      priority: "visible",
      reason: "offscreen-visible",
    });
    this.tileLoadController.queueIndexes(loadGroups.offscreenIndexes, {
      priority: "offscreen",
      reason: "offscreen-offscreen",
    });
    const sourceTileWidth = resolveWaveformSourceTileWidth({
      renderScale: args.job.renderMetrics.scale,
    });
    this.queueNextDensityPrefetch({
      inputs: args.job.inputs,
      renderMetrics: args.job.renderMetrics,
      sourceTileWidth,
      visibleTileWindow: args.job.visibleTileWindow,
    });
    recordWaveformTrace("tile.render.offscreen", {
      ...createWaveformRenderTracePayload({
        inputs: args.job.inputs,
        renderMetrics: args.job.renderMetrics,
        scrollLeft: this.scrollLeft,
        sourceTileWidth,
        visualScrollLeft: this.visualScrollLeft,
      }),
      durationMs: readWaveformPerformanceNow(this.getOwnerWindow()) - startedAt,
      generation: args.job.generation,
      indexes: sampleWaveformTraceIndexes(args.indexes),
      indexCount: args.indexes.length,
      reason: args.job.reason,
      stats,
      tileCountAfter: this.tiles.size,
    });
  }

  private removeTile(index: number, tile: WaveformTileNodeState) {
    tile.canvas.remove();
    this.tiles.delete(index);
    this.tileLoadController.delete(index);
  }

  private requestTileWindowRender(request: Partial<WaveformTileRenderRequest> = {}) {
    recordWaveformTrace("tile.render.request", {
      mode: request.mode ?? "complete",
      pendingTileCount: this.tiles.size,
      renderedTileWindow: this.renderedTileWindow,
      scrollLeft: this.scrollLeft,
      trace: request.trace ?? null,
      visualScrollLeft: this.visualScrollLeft,
    });
    this.renderFrameController.request(request);
  }

  renderSettledTileWindow() {
    this.requestTileWindowRender({
      mode: "complete",
      trace: null,
    });
  }

  isOffscreenTileRenderJobCurrent(job: WaveformOffscreenTileRenderJob) {
    return job.generation === this.renderGeneration && job.inputs === this.inputs;
  }

  getTileLoadInputs() {
    return this.inputs;
  }

  getTileLoadNode(index: number) {
    return this.tiles.get(index);
  }

  applyTileLoadError(tile: WaveformTileNodeState) {
    if (this.tiles.get(tile.index) !== tile) {
      return;
    }

    tile.data = null;
    tile.status = "ready";
    this.drawTileWithCurrentInputs(tile);
  }

  applyTileLoadSuccess(args: {
    tile: WaveformTileNodeState;
    tileData: TrackWaveformTile;
  }): WaveformTileLoadResult {
    const { tile, tileData } = args;

    if (this.tiles.get(tile.index) !== tile) {
      recordWaveformTrace("tile.load.stale", {
        index: tile.index,
        resultStartPx: tileData.start_px,
        resultWidthPx: tileData.width_px,
      });
      return "stale";
    }

    if (tile.fetchStartPx !== tileData.start_px || tile.fetchWidthPx !== tileData.width_px) {
      tile.status = "pending";
      recordWaveformTrace("tile.load.retry", {
        expectedStartPx: tile.fetchStartPx,
        expectedWidthPx: tile.fetchWidthPx,
        index: tile.index,
        resultStartPx: tileData.start_px,
        resultWidthPx: tileData.width_px,
      });
      return "retry";
    }

    tile.data = tileData;
    tile.status = "ready";
    this.drawTileWithCurrentInputs(tile);
    this.requestCompleteRenderAfterVisibleTileLoad(tile);
    recordWaveformTrace("tile.load.success", {
      ...createWaveformTileTracePayload(tile),
      hasDrawnPixels: tile.hasDrawnPixels,
      index: tile.index,
      maxLength: tileData.max.length,
      minLength: tileData.min.length,
    });
    return "done";
  }

  private requestCompleteRenderAfterVisibleTileLoad(tile: WaveformTileNodeState) {
    if (!tile.hasDrawnPixels) {
      return;
    }

    const inputs = this.inputs;
    if (!inputs) {
      return;
    }

    const renderMetrics = resolveWaveformRenderMetrics(inputs);
    const visibleTileWindow = resolveWaveformRenderTileWindow({
      contentWidth: renderMetrics.contentWidth,
      overscanTiles: 0,
      renderScale: renderMetrics.scale,
      scrollLeft: this.scrollLeft,
      tileWidth: resolveWaveformSourceTileWidth({ renderScale: renderMetrics.scale }),
      viewportWidth: inputs.viewportWidth,
    });

    if (
      !visibleTileWindow ||
      !isWaveformTileIndexInWindow(tile.index, visibleTileWindow) ||
      !this.isTileWindowReadyForViewport(visibleTileWindow, renderMetrics)
    ) {
      return;
    }

    recordWaveformTrace("tile.render.defer-resume", {
      index: tile.index,
      visibleTileWindow,
    });
    this.requestTileWindowRender({
      mode: "complete",
      trace: null,
    });
  }

  private resetRenderLayerStyleCache() {
    this.renderLayerBaseContentWidth = 1;
    this.renderLayerBasePixelsPerSecond = 1;
    this.renderLayerTransformStyle = "";
    this.renderLayerWidthStyle = "";
    this.renderLayerWillChangeStyle = "";
  }

  private updateRenderLayerPresentation() {
    const startedAt = isWaveformTraceEnabled()
      ? readWaveformPerformanceNow(this.getOwnerWindow())
      : 0;
    const inputs = this.inputs;
    const renderLayer = this.renderLayer;
    if (!inputs || !renderLayer) {
      return;
    }

    const renderBaseContentWidth = inputs.contentWidth;
    const renderBasePixelsPerSecond = inputs.pixelsPerSecond;
    this.renderLayerBaseContentWidth = renderBaseContentWidth;
    this.renderLayerBasePixelsPerSecond = renderBasePixelsPerSecond;

    const nextWidthStyle = `${renderBaseContentWidth}px`;
    const widthChanged = this.renderLayerWidthStyle !== nextWidthStyle;
    if (this.renderLayerWidthStyle !== nextWidthStyle) {
      renderLayer.style.width = nextWidthStyle;
      this.renderLayerWidthStyle = nextWidthStyle;
    }

    const alignment = resolveWaveformRasterAlignment({
      sampleScrollLeft: this.scrollLeft,
      scrollLeft: this.visualScrollLeft,
    });
    const transformPx = alignment.transformPx;
    const nextTransformStyle = resolveWaveformPresentationTransform({
      transformPx,
    });
    const transformChanged = this.renderLayerTransformStyle !== nextTransformStyle;
    if (transformChanged) {
      renderLayer.style.transform = nextTransformStyle;
      this.renderLayerTransformStyle = nextTransformStyle;
    }

    const nextWillChangeStyle = "";
    const willChangeChanged = this.renderLayerWillChangeStyle !== nextWillChangeStyle;
    if (willChangeChanged) {
      renderLayer.style.willChange = nextWillChangeStyle;
      this.renderLayerWillChangeStyle = nextWillChangeStyle;
    }

    if (isWaveformTraceEnabled() && (widthChanged || transformChanged || willChangeChanged)) {
      recordWaveformTrace("render-layer.presentation.apply", {
        alignment,
        durationMs: readWaveformPerformanceNow(this.getOwnerWindow()) - startedAt,
        presentationPixelsPerSecond: inputs.pixelsPerSecond,
        renderBaseContentWidth,
        renderBasePixelsPerSecond,
        renderLayer: createWaveformLayerTraceSnapshot({
          baseContentWidth: renderBaseContentWidth,
          basePixelsPerSecond: renderBasePixelsPerSecond,
          layer: renderLayer,
        }),
        scrollLeft: this.scrollLeft,
        styleChanged: {
          transform: transformChanged,
          width: widthChanged,
          willChange: willChangeChanged,
        },
        transformPx,
        visualScrollLeft: this.visualScrollLeft,
      });
    }
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
    const dataReset = sourceChanged && !isWaveformTileDataCoveringGeometry(tile.data, geometry);
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

    if (isWaveformTraceEnabled()) {
      recordWaveformTrace("tile.geometry.sync", {
        dataReset,
        displayChanged,
        hasData: Boolean(tile.data),
        index: tile.index,
        maxLength: tile.data?.max.length ?? 0,
        minLength: tile.data?.min.length ?? 0,
        next: geometry,
        previous: {
          displayStartPx: tile.displayStartPx,
          displayWidthPx: tile.displayWidthPx,
          fetchStartPx: tile.fetchStartPx,
          fetchWidthPx: tile.fetchWidthPx,
          sourceStartPx: tile.sourceStartPx,
          sourceWidthPx: tile.sourceWidthPx,
        },
        sourceChanged,
        status: tile.status,
      });
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
    tile.drawDataKey = null;
    tile.drawStatus = null;
    tile.drawDisplayStartPx = null;
    tile.drawDisplayWidthPx = null;

    if (dataReset) {
      tile.data = null;
      tile.status = inputs.status === "ready" && Boolean(inputs.filePath) ? "pending" : "ready";
    }

    return {
      dataReset,
      displayChanged,
      sourceChanged,
    };
  }
}

class WaveformPresentationController {
  constructor(
    private readonly tiles: WaveformTileController,
    private readonly playhead: WaveformPlayheadController,
  ) {}

  dispose() {
    this.tiles.dispose();
    this.playhead.dispose();
  }

  setHost(host: HTMLElement | null) {
    this.tiles.setHost(host);
    this.playhead.setHost(host);
  }

  setPlayhead(playhead: HTMLDivElement | null) {
    this.playhead.setPlayhead(playhead);
  }

  setTileLayer(tileLayer: HTMLDivElement | null) {
    this.tiles.setTileLayer(tileLayer);
    this.syncPlayheadPresentation();
  }

  setPlaybackSnapshot(snapshot: PlaybackSnapshot | null) {
    this.playhead.setPlaybackSnapshot(snapshot);
  }

  setRenderInputs(inputs: WaveformRenderInputs) {
    this.tiles.setRenderInputs(inputs);
    this.syncPlayheadPresentation();
  }

  setScrollLeft(scrollLeft: number) {
    this.tiles.setScrollLeft(scrollLeft);
    this.syncPlayheadPresentation();
  }

  applyViewportScrollEvent(visualScrollLeft: number) {
    const changed = this.tiles.applyViewportScrollEvent(visualScrollLeft);
    if (changed) {
      this.syncPlayheadPresentation();
    }
    return changed;
  }

  beginViewportScroll(trace: WaveformViewportTraceContext | null = null) {
    this.tiles.beginViewportScroll(trace);
  }

  settleViewportScroll(trace: WaveformViewportTraceContext | null = null) {
    this.tiles.settleViewportScroll(trace);
  }

  setActiveViewportScroll(args: {
    scrollLeft: number;
    trace?: WaveformViewportTraceContext | null;
    visualScrollLeft?: number;
  }) {
    const changed = this.tiles.setActiveViewportScroll(args);
    if (changed) {
      this.syncPlayheadPresentation();
    }
    return changed;
  }

  applyProgrammaticViewportScroll(args: {
    scrollLeft: number;
    trace?: WaveformViewportTraceContext | null;
    visualScrollLeft?: number;
  }) {
    const changed = this.tiles.applyProgrammaticViewportScroll(args);
    if (changed) {
      this.syncPlayheadPresentation();
    }
    return changed;
  }

  getScrollLeft() {
    return this.tiles.getScrollLeft();
  }

  getContentWidth() {
    return this.tiles.getContentWidth();
  }

  prepareZoomScrollRange(args: { contentWidth: number; visualScrollLeft: number }) {
    this.tiles.prepareZoomScrollRange(args);
    this.syncPlayheadPresentation();
  }

  applyZoomViewportState(args: {
    contentWidth: number;
    scrollLeft: number;
    visualScrollLeft: number;
  }) {
    this.tiles.applyZoomViewportState(args);
    this.syncPlayheadPresentation();
  }

  materializeZoomTiles(args: {
    focus?: WaveformTileRenderFocus | null;
    contentWidth: number;
    mode: WaveformTileRenderMode;
    pixelsPerSecond: number;
  }) {
    this.tiles.materializeZoomTiles(args);
    this.syncPlayheadPresentation();
  }

  createTraceSnapshot() {
    return this.tiles.createTraceSnapshot();
  }

  private syncPlayheadPresentation() {
    this.playhead.setPresentation(this.tiles.getPresentedViewport());
  }
}

function createWaveformRenderTracePayload(args: {
  contentWidth?: number;
  inputs: WaveformRenderInputs;
  renderMetrics: ReturnType<typeof resolveWaveformRenderMetrics>;
  scrollLeft: number;
  sourceTileWidth: number;
  visualScrollLeft: number;
}) {
  return {
    contentWidth: args.contentWidth ?? args.inputs.contentWidth,
    filePath: args.inputs.filePath,
    pixelsPerSecond: args.inputs.pixelsPerSecond,
    renderContentWidth: args.renderMetrics.contentWidth,
    renderPixelsPerSecond: args.renderMetrics.pixelsPerSecond,
    renderScale: args.renderMetrics.scale,
    scrollLeft: args.scrollLeft,
    sourceTileWidth: args.sourceTileWidth,
    status: args.inputs.status,
    summaryCacheKey: args.inputs.summary.cache_key,
    viewportWidth: args.inputs.viewportWidth,
    visualScrollLeft: args.visualScrollLeft,
  };
}

function createWaveformLayerTraceSnapshot(args: {
  baseContentWidth: number | null;
  basePixelsPerSecond: number | null;
  layer: HTMLElement;
}): WaveformLayerTraceSnapshot {
  return {
    baseContentWidth: args.baseContentWidth,
    basePixelsPerSecond: args.basePixelsPerSecond,
    childCount: args.layer.childElementCount,
    styleOpacity: args.layer.style.opacity,
    styleTransform: args.layer.style.transform || "none",
    styleWidth: args.layer.style.width,
    styleWillChange: args.layer.style.willChange,
  };
}

function resolveWaveformTraceViewportSampleIndexes(args: {
  tileLoadOrder: readonly number[];
  visibleTileLoadOrder: readonly number[];
}) {
  const indexes: number[] = [];

  for (const index of args.visibleTileLoadOrder) {
    if (!indexes.includes(index)) {
      indexes.push(index);
    }
  }

  for (const index of args.tileLoadOrder) {
    if (!indexes.includes(index)) {
      indexes.push(index);
    }
  }

  return indexes.slice(0, WAVEFORM_TRACE_SAMPLE_LIMIT);
}

function sampleWaveformTraceItems<T, R>(
  items: Iterable<T>,
  mapItem: (item: T) => R,
  limit = WAVEFORM_TRACE_SAMPLE_LIMIT,
) {
  const sample: R[] = [];
  for (const item of items) {
    if (sample.length >= limit) {
      break;
    }

    sample.push(mapItem(item));
  }

  return sample;
}

function sampleWaveformTraceIndexes(
  indexes: Iterable<number>,
  limit = WAVEFORM_TRACE_SAMPLE_LIMIT,
) {
  return sampleWaveformTraceItems(indexes, (index) => index, limit);
}

function pushWaveformTraceSample<T>(target: T[], value: T) {
  if (target.length < WAVEFORM_TRACE_SAMPLE_LIMIT) {
    target.push(value);
  }
}

function resolveWaveformTileWindowIndexCount(window: WaveformTileWindow) {
  return Math.max(0, window.endIndex - window.startIndex + 1);
}

function createWaveformTileTracePayload(tile: WaveformTileNodeState): WaveformTileTraceSnapshot {
  return {
    displayStartPx: tile.displayStartPx,
    displayWidthPx: tile.displayWidthPx,
    drawDisplayStartPx: tile.drawDisplayStartPx,
    drawDisplayWidthPx: tile.drawDisplayWidthPx,
    drawDataKey: tile.drawDataKey,
    drawSampleOffsetPx: tile.drawSampleOffsetPx,
    drawScale: tile.drawScale,
    drawStatus: tile.drawStatus,
    fetchStartPx: tile.fetchStartPx,
    fetchWidthPx: tile.fetchWidthPx,
    hasData: Boolean(tile.data),
    hasDrawnPixels: tile.hasDrawnPixels,
    index: tile.index,
    maxLength: tile.data?.max.length ?? 0,
    minLength: tile.data?.min.length ?? 0,
    sourceStartPx: tile.sourceStartPx,
    sourceWidthPx: tile.sourceWidthPx,
    status: tile.status,
  };
}

export class WaveformZoomController {
  private commitGeneration = 0;
  private lastCommitMs = 0;
  private scheduledCommitFrameId: number | null = null;
  private scheduledCommitOwnerWindow: Window | null = null;
  private materializeOwnerWindow: Window | null = null;
  private materializeTimerId: number | null = null;
  private pendingCommit: PendingWaveformZoomCommit | null = null;
  private pendingMaterialize: WaveformZoomCommit | null = null;
  private activePixelsPerSecond: number | null = null;
  private stateSyncFrameId: number | null = null;
  private stateSyncOwnerWindow: Window | null = null;

  reset() {
    this.cancelScheduledCommit();

    this.cancelPendingMaterialize();
    this.cancelStateSync();
    this.pendingCommit = null;
    this.activePixelsPerSecond = null;
  }

  dispose() {
    this.reset();
    this.materializeOwnerWindow = null;
  }

  apply(args: {
    anchorViewportX: number;
    deltaY: number;
    scrollElements: WaveformScrollElements;
    scrollLeft: number;
    viewportWidth: number;
    wheelState: WaveformWheelState;
  }) {
    const ownerWindow = args.scrollElements.viewport.ownerDocument.defaultView;
    const previousPending = this.pendingCommit;
    const base: WaveformZoomBaseFrame = previousPending?.commit ?? {
      durationMs: args.wheelState.summary.duration_ms,
      pixelsPerSecond: this.activePixelsPerSecond ?? args.wheelState.requestedPixelsPerSecond,
      scrollLeft: args.scrollLeft,
      viewportWidth: args.viewportWidth,
    };
    const nextFrame = resolveQueuedWaveformZoomFrame({
      anchorViewportX: args.anchorViewportX,
      currentPixelsPerSecond: args.wheelState.requestedPixelsPerSecond,
      deltaY: args.deltaY,
      durationMs: args.wheelState.summary.duration_ms,
      maximumPixelsPerSecond: args.wheelState.maximumPixelsPerSecond,
      pendingFrame: base,
      scrollLeft: args.scrollLeft,
      viewportWidth: args.viewportWidth,
    });
    const changed =
      Math.abs(nextFrame.pixelsPerSecond - base.pixelsPerSecond) >= 0.01 ||
      Math.abs(nextFrame.scrollLeft - base.scrollLeft) >= 0.5;

    if (!changed) {
      return false;
    }

    this.cancelPendingMaterialize();
    this.cancelStateSync();

    const commit = {
      ...nextFrame,
      controller: args.wheelState.controller,
      durationMs: base.durationMs,
      generation: previousPending?.commit.generation ?? this.commitGeneration + 1,
      scrollElements: args.scrollElements,
      setPixelsPerSecond: args.wheelState.setPixelsPerSecond,
      viewportWidth: base.viewportWidth,
    };
    const pendingCommit = {
      commit,
    };

    this.pendingCommit = pendingCommit;
    this.activePixelsPerSecond = commit.pixelsPerSecond;
    this.scheduleCommit(ownerWindow);
    return true;
  }

  private scheduleCommit(ownerWindow: Window | null) {
    if (!ownerWindow) {
      this.flushPendingCommit(null);
      return;
    }

    if (this.scheduledCommitFrameId !== null) {
      if (this.scheduledCommitOwnerWindow === ownerWindow) {
        return;
      }

      this.cancelScheduledCommit();
    }

    this.scheduledCommitOwnerWindow = ownerWindow;
    this.scheduledCommitFrameId = ownerWindow.requestAnimationFrame(() => {
      this.scheduledCommitFrameId = null;
      this.scheduledCommitOwnerWindow = null;
      this.flushPendingCommit(ownerWindow);
    });
  }

  private flushPendingCommit(ownerWindow: Window | null) {
    const pending = this.pendingCommit;
    this.pendingCommit = null;

    if (!pending) {
      return;
    }

    this.commit(pending.commit, {
      ownerWindow,
    });
  }

  private cancelScheduledCommit() {
    if (this.scheduledCommitFrameId === null) {
      return;
    }

    this.scheduledCommitOwnerWindow?.cancelAnimationFrame(this.scheduledCommitFrameId);
    this.scheduledCommitFrameId = null;
    this.scheduledCommitOwnerWindow = null;
  }

  private commit(
    pending: WaveformZoomCommit,
    args: {
      ownerWindow: Window | null;
    },
  ) {
    const startedAt = readWaveformPerformanceNow(args.ownerWindow);
    this.commitGeneration = pending.generation;
    const ownerWindow = args.ownerWindow;
    const shouldRecordDetailTrace = isWaveformTraceDetailEnabled();
    const beforeCommit = shouldRecordDetailTrace ? pending.controller.createTraceSnapshot() : null;
    pending.controller.prepareZoomScrollRange({
      contentWidth: pending.contentWidth,
      visualScrollLeft: pending.scrollLeft,
    });
    const afterPrepare = shouldRecordDetailTrace ? pending.controller.createTraceSnapshot() : null;
    writeWaveformScrollLeft(pending.scrollElements, pending.scrollLeft);
    const actualScrollLeft = readWaveformScrollLeft(pending.scrollElements);
    pending.controller.applyZoomViewportState({
      contentWidth: pending.contentWidth,
      scrollLeft: pending.scrollLeft,
      visualScrollLeft: actualScrollLeft,
    });
    const afterApply = shouldRecordDetailTrace ? pending.controller.createTraceSnapshot() : null;
    const materializeMode = resolveWaveformZoomCommitMaterializeMode();
    recordWaveformTrace("zoom.commit", {
      actualScrollLeft,
      anchorSeconds: pending.anchorSeconds,
      anchorViewportX: pending.anchorViewportX,
      beforeCommit,
      contentWidth: pending.contentWidth,
      durationMs: readWaveformPerformanceNow(ownerWindow) - startedAt,
      generation: pending.generation,
      materializeMode,
      pixelsPerSecond: pending.pixelsPerSecond,
      presentationAfterApply: afterApply,
      presentationAfterPrepare: afterPrepare,
      requestedScrollLeft: pending.scrollLeft,
      scrollOffsetElementScrollLeft: pending.scrollElements.scrollOffsetElement.scrollLeft,
      viewportScrollLeft: pending.scrollElements.viewport.scrollLeft,
      viewportWidth: pending.viewportWidth,
    });
    pending.controller.materializeZoomTiles({
      contentWidth: pending.contentWidth,
      focus: {
        anchorSeconds: pending.anchorSeconds,
        anchorViewportX: pending.anchorViewportX,
      },
      mode: materializeMode,
      pixelsPerSecond: pending.pixelsPerSecond,
    });
    this.scheduleMaterialize(pending, ownerWindow);
  }

  private scheduleMaterialize(pending: WaveformZoomCommit, ownerWindow: Window | null) {
    this.cancelPendingMaterialize();
    this.cancelStateSync();
    this.pendingMaterialize = pending;
    this.materializeOwnerWindow = ownerWindow;

    if (!ownerWindow) {
      this.materializeSettled();
      return;
    }

    const now = readWaveformPerformanceNow(ownerWindow);
    this.lastCommitMs = now;

    this.materializeTimerId = ownerWindow.setTimeout(() => {
      this.materializeAfterQuiet();
    }, WAVEFORM_ZOOM_SETTLE_DELAY_MS);
  }

  private materializeAfterQuiet() {
    const ownerWindow = this.materializeOwnerWindow;
    if (!ownerWindow) {
      this.materializeSettled();
      return;
    }

    const now = readWaveformPerformanceNow(ownerWindow);
    const waitMs = resolveWaveformZoomSettleDelayMs({
      lastCommitMs: this.lastCommitMs,
      nowMs: now,
    });

    if (waitMs > 0) {
      this.materializeTimerId = ownerWindow.setTimeout(() => {
        this.materializeAfterQuiet();
      }, waitMs);
      return;
    }

    this.materializeSettled();
  }

  private materializeSettled() {
    const pending = this.pendingMaterialize;
    const ownerWindow = this.materializeOwnerWindow;

    if (this.materializeTimerId !== null) {
      ownerWindow?.clearTimeout(this.materializeTimerId);
    }

    this.pendingMaterialize = null;
    this.materializeTimerId = null;
    this.materializeOwnerWindow = null;

    if (!pending) {
      return;
    }

    if (pending.generation !== this.commitGeneration) {
      return;
    }

    this.scheduleStateSync(pending, ownerWindow);

    recordWaveformTrace("zoom.materialize.request", {
      anchorSeconds: pending.anchorSeconds,
      anchorViewportX: pending.anchorViewportX,
      contentWidth: pending.contentWidth,
      generation: pending.generation,
      pixelsPerSecond: pending.pixelsPerSecond,
      reason: "settled",
      scrollLeft: pending.scrollLeft,
      viewportWidth: pending.viewportWidth,
    });
    pending.controller.materializeZoomTiles({
      contentWidth: pending.contentWidth,
      focus: {
        anchorSeconds: pending.anchorSeconds,
        anchorViewportX: pending.anchorViewportX,
      },
      mode: "complete",
      pixelsPerSecond: pending.pixelsPerSecond,
    });
  }

  private scheduleStateSync(pending: WaveformZoomCommit, ownerWindow: Window | null) {
    this.cancelStateSync();

    if (!ownerWindow) {
      this.syncPixelsPerSecondState(pending);
      return;
    }

    const generation = pending.generation;
    this.stateSyncOwnerWindow = ownerWindow;
    this.stateSyncFrameId = ownerWindow.requestAnimationFrame(() => {
      this.stateSyncFrameId = null;
      this.stateSyncOwnerWindow = null;

      if (generation !== this.commitGeneration) {
        return;
      }

      this.syncPixelsPerSecondState(pending);
    });
  }

  private syncPixelsPerSecondState(pending: WaveformZoomCommit) {
    if (
      this.activePixelsPerSecond !== null &&
      Math.abs(this.activePixelsPerSecond - pending.pixelsPerSecond) >= 0.01
    ) {
      recordWaveformTrace("zoom.state-sync.skip", {
        activePixelsPerSecond: this.activePixelsPerSecond,
        generation: pending.generation,
        reason: "stale-active-pixels-per-second",
        syncPixelsPerSecond: pending.pixelsPerSecond,
      });
      return;
    }

    pending.setPixelsPerSecond((current) =>
      Math.abs(current - pending.pixelsPerSecond) < 0.01 ? current : pending.pixelsPerSecond,
    );
  }

  private cancelPendingMaterialize() {
    if (this.materializeTimerId !== null) {
      this.materializeOwnerWindow?.clearTimeout(this.materializeTimerId);
    }

    this.materializeOwnerWindow = null;
    this.materializeTimerId = null;
    this.pendingMaterialize = null;
  }

  private cancelStateSync() {
    if (this.stateSyncFrameId === null) {
      return;
    }

    this.stateSyncOwnerWindow?.cancelAnimationFrame(this.stateSyncFrameId);
    this.stateSyncFrameId = null;
    this.stateSyncOwnerWindow = null;
  }
}

class WaveformPanController {
  apply(args: {
    deltaX: number;
    scrollElements: WaveformScrollElements;
    trace: WaveformViewportTraceContext;
    wheelState: WaveformWheelState;
  }) {
    const scrollElement = args.scrollElements.viewport;
    const viewportWidth = Math.max(1, scrollElement.clientWidth || args.wheelState.viewportWidth);
    const contentWidth = resolveWaveformWheelPanContentWidth({
      scrollOffsetElementScrollWidth: args.scrollElements.scrollOffsetElement.scrollWidth,
      viewportScrollWidth: scrollElement.scrollWidth,
      viewportWidth,
      wheelStateContentWidth: args.wheelState.contentWidth,
    });
    const previousScrollLeft = args.wheelState.controller.getScrollLeft();
    const targetFrame = resolveWaveformHorizontalPanFrame({
      contentWidth,
      deltaX: args.deltaX,
      scrollLeft: previousScrollLeft,
      viewportWidth,
    });

    args.wheelState.controller.beginViewportScroll(args.trace);

    if (!targetFrame.changed) {
      recordWaveformTrace("wheel.pan", {
        actualScrollLeft: readWaveformScrollLeft(args.scrollElements),
        changed: false,
        contentWidth,
        deltaX: args.deltaX,
        previousScrollLeft,
        requestedScrollLeft: targetFrame.scrollLeft,
        trace: args.trace,
        viewportWidth,
      });
      args.wheelState.controller.settleViewportScroll(args.trace);
      return;
    }

    writeWaveformScrollLeft(args.scrollElements, targetFrame.scrollLeft);
    const actualScrollLeft = readWaveformScrollLeft(args.scrollElements);
    recordWaveformTrace("wheel.pan.dom-write", {
      actualScrollLeft,
      deltaX: args.deltaX,
      previousScrollLeft,
      requestedScrollLeft: targetFrame.scrollLeft,
      scrollOffsetElementScrollLeft: args.scrollElements.scrollOffsetElement.scrollLeft,
      trace: args.trace,
      viewportScrollLeft: args.scrollElements.viewport.scrollLeft,
      viewportWidth,
    });

    args.wheelState.controller.applyProgrammaticViewportScroll({
      scrollLeft: targetFrame.scrollLeft,
      trace: args.trace,
      visualScrollLeft: actualScrollLeft,
    });
    recordWaveformTrace("wheel.pan", {
      actualScrollLeft,
      changed: true,
      contentWidth,
      deltaX: args.deltaX,
      previousScrollLeft,
      requestedScrollLeft: targetFrame.scrollLeft,
      trace: args.trace,
      viewportWidth,
    });
    args.wheelState.controller.settleViewportScroll(args.trace);
  }
}

function useWaveformPresentationController() {
  const controllerRef = useRef<WaveformPresentationController | null>(null);

  if (controllerRef.current === null) {
    controllerRef.current = new WaveformPresentationController(
      new WaveformTileController(),
      new WaveformPlayheadController(),
    );
  }

  return controllerRef.current;
}

function useWaveformPanController() {
  const controllerRef = useRef<WaveformPanController | null>(null);

  if (controllerRef.current === null) {
    controllerRef.current = new WaveformPanController();
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

function useTrackWaveformSummary(args: {
  end: number | null;
  filePath: string | null;
  placeholderSummary: TrackWaveformSummary;
  start: number | null;
  waveformPort: TrackSpectrumWaveformPort;
}) {
  const [state, setState] = useState<TrackWaveformSummaryState>({
    status: resolveTrackWaveformInitialStatus(args.filePath),
    summary: args.placeholderSummary,
  });

  useEffect(() => {
    const filePath = args.filePath?.trim();

    if (!filePath) {
      setState((current) =>
        current.status === "idle" && current.summary === args.placeholderSummary
          ? current
          : {
              status: "idle",
              summary: args.placeholderSummary,
            },
      );
      return;
    }

    const scheduledAt = readWaveformPerformanceNow(typeof window === "undefined" ? null : window);
    let cancelled = false;
    setState((current) =>
      current.status === "loading" && current.summary === args.placeholderSummary
        ? current
        : {
            status: "loading",
            summary: args.placeholderSummary,
          },
    );
    recordWaveformTrace("summary.prepare.scheduled", {
      end: args.end,
      filePath,
      placeholderDurationMs: args.placeholderSummary.duration_ms,
      placeholderCacheKey: args.placeholderSummary.cache_key,
      start: args.start,
    });

    const ownerWindow = typeof window === "undefined" ? null : window;
    const delayHandle = scheduleWaveformInitialPrepare(ownerWindow, () => {
      const startedAt = readWaveformPerformanceNow(ownerWindow);
      recordWaveformTrace("summary.prepare.start", {
        queueDelayMs: startedAt - scheduledAt,
        end: args.end,
        filePath,
        start: args.start,
      });
      void args.waveformPort
        .prepareTrackWaveform(
          filePath,
          normalizeWaveformBoundary(args.start),
          normalizeWaveformBoundary(args.end),
        )
        .then((summary) => {
          if (cancelled) {
            return;
          }

          setState({
            status: "ready",
            summary,
          });
          recordWaveformTrace("summary.prepare.done", {
            durationMs: readWaveformPerformanceNow(ownerWindow) - startedAt,
            filePath,
            levelCount: summary.levels.length,
            levels: sampleWaveformTraceItems(summary.levels, (level) => level),
            pointsPerSecond: summary.base_points_per_second,
            summaryCacheKey: summary.cache_key,
            summaryDurationMs: summary.duration_ms,
          });
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }

          console.error("Failed to prepare track waveform", error);
          recordWaveformTrace("summary.prepare.error", {
            durationMs: readWaveformPerformanceNow(ownerWindow) - startedAt,
            filePath,
            message: error instanceof Error ? error.message : String(error),
          });
          setState({
            status: "error",
            summary: args.placeholderSummary,
          });
        });
    });

    return () => {
      cancelled = true;
      recordWaveformTrace("summary.prepare.cancel", {
        filePath,
      });
      cancelWaveformInitialPrepare(ownerWindow, delayHandle);
    };
  }, [args.end, args.filePath, args.placeholderSummary, args.start, args.waveformPort]);

  return state;
}

function useTrackPlaybackSnapshot(args: {
  filePath: string | null;
  playbackPort: TrackSpectrumPlaybackPort;
}) {
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);

  useEffect(() => {
    const filePath = args.filePath?.trim();
    setSnapshot(null);

    if (!filePath) {
      return undefined;
    }

    let cancelled = false;
    const refreshPlaybackStatus = async () => {
      try {
        const status = await args.playbackPort.getPlaybackStatus();
        if (cancelled) {
          return;
        }

        if (!status || !isPlaybackStatusForTrack(status, filePath)) {
          setSnapshot(null);
          return;
        }

        setSnapshot({
          ...status,
          received_at_ms: performance.now(),
        });
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to refresh playback status", error);
          setSnapshot(null);
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
    };
  }, [args.filePath, args.playbackPort]);

  return snapshot;
}

export function TrackSpectrum(props: {
  className?: string;
  filePath: string | null;
  ports?: TrackSpectrumPorts;
  start: number | null;
  end: number | null;
}) {
  const placeholderSummary = useMemo(() => createPlaceholderWaveformSummary(), []);
  const ports = props.ports ?? crabTrackSpectrumPorts;
  const controller = useWaveformPresentationController();
  const panController = useWaveformPanController();
  const zoomController = useWaveformZoomController();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollbarsRef = useRef<OverlayScrollbarsComponentRef<"div"> | null>(null);
  const wheelStateRef = useRef<WaveformWheelState | null>(null);
  const [viewportWidth, setViewportWidth] = useState(1);
  const [requestedPixelsPerSecond, setPixelsPerSecond] = useState(
    WAVEFORM_INITIAL_PIXELS_PER_SECOND,
  );
  const state = useTrackWaveformSummary({
    end: props.end,
    filePath: props.filePath,
    placeholderSummary,
    start: props.start,
    waveformPort: ports.waveform,
  });
  const playbackSnapshot = useTrackPlaybackSnapshot({
    filePath: props.filePath,
    playbackPort: ports.playback,
  });
  const summary = state.summary;
  const maximumPixelsPerSecond = resolveWaveformRenderPixelsPerSecond({
    summary,
  });
  const pixelsPerSecond = resolveWaveformPixelsPerSecond(requestedPixelsPerSecond, {
    durationMs: summary.duration_ms,
    maximumPixelsPerSecond,
    viewportWidth,
  });
  const contentWidth = resolveWaveformContentWidth({
    durationMs: summary.duration_ms,
    pixelsPerSecond,
    viewportWidth,
  });

  wheelStateRef.current = {
    contentWidth,
    controller,
    maximumPixelsPerSecond,
    requestedPixelsPerSecond: pixelsPerSecond,
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

      handleWaveformViewportWheel({
        event,
        panController,
        scrollElements,
        wheelState,
        zoomController,
      });
    },
    [panController, zoomController],
  );
  const scrollEvents = useMemo<EventListeners>(
    () => ({
      scroll: (instance) => {
        const elements = instance.elements();
        const scrollLeft = readWaveformScrollLeft(elements);

        controller.applyViewportScrollEvent(scrollLeft);
      },
    }),
    [controller],
  );

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

    /**
     * WheelEvent is an input signal, not a reliable scroll result. The listener
     * lives on the stable waveform host so OverlayScrollbars internals can change
     * without changing the waveform input boundary.
     */
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
      waveformPort: ports.waveform,
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
    ports.waveform,
  ]);

  useEffect(() => {
    installWaveformTrace();
  }, []);

  useEffect(() => {
    if (!isWaveformTraceEnabled()) {
      return;
    }

    recordWaveformTrace("component.render-state", {
      contentWidth,
      filePath: props.filePath?.trim() || null,
      maximumPixelsPerSecond,
      pixelsPerSecond,
      requestedPixelsPerSecond,
      status: state.status,
      summaryCacheKey: summary.cache_key,
      summaryDurationMs: summary.duration_ms,
      viewportWidth,
    });
  }, [
    contentWidth,
    maximumPixelsPerSecond,
    pixelsPerSecond,
    props.filePath,
    requestedPixelsPerSecond,
    state.status,
    summary,
    viewportWidth,
  ]);

  useEffect(() => {
    return () => {
      zoomController.dispose();
      controller.dispose();
    };
  }, [controller, zoomController]);

  useEffect(() => {
    resetWaveformScrollPosition({
      controller,
      zoomController,
      scrollbarsRef,
    });
  }, [controller, zoomController, props.end, props.filePath, props.start]);

  useEffect(() => {
    controller.setPlaybackSnapshot(playbackSnapshot);
  }, [controller, playbackSnapshot]);

  return (
    <motion.div
      ref={handleHostRef}
      aria-label="Current track waveform"
      data-waveform-status={state.status}
      className={cn(
        "relative h-[13rem] w-full overflow-hidden text-[#262626] dark:text-[#f5f5f5]",
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
        className="pointer-events-none absolute inset-y-0 left-0 z-[2] w-px bg-[#404040] opacity-0 will-change-transform dark:bg-[#a3a3a3]"
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
  const pixelsPerSecond = resolveWaveformRenderPixelsPerSecond({
    pixelsPerSecond: inputs.pixelsPerSecond,
    summary: inputs.summary,
  });

  return resolveWaveformRenderMetricsForPixelsPerSecond({
    durationMs: inputs.summary.duration_ms,
    pixelsPerSecond: inputs.pixelsPerSecond,
    renderPixelsPerSecond: pixelsPerSecond,
  });
}

function createWaveformPrefetchRenderMetrics(args: {
  inputs: WaveformRenderInputs;
  renderPixelsPerSecond: number;
}) {
  return resolveWaveformRenderMetricsForPixelsPerSecond({
    durationMs: args.inputs.summary.duration_ms,
    pixelsPerSecond: args.inputs.pixelsPerSecond,
    renderPixelsPerSecond: args.renderPixelsPerSecond,
  });
}

function createWaveformTileIdentity(inputs: WaveformRenderInputs) {
  const renderMetrics = resolveWaveformRenderMetrics(inputs);
  const sourceTileWidth = resolveWaveformSourceTileWidth({
    renderScale: renderMetrics.scale,
  });

  return [
    inputs.filePath ?? "",
    inputs.start ?? "",
    inputs.end ?? "",
    inputs.summary.cache_key,
    renderMetrics.pixelsPerSecond,
    sourceTileWidth,
    inputs.status,
  ].join("|");
}

function createWaveformTileDataScopeKey(inputs: WaveformRenderInputs) {
  return [
    inputs.filePath ?? "",
    inputs.start ?? "",
    inputs.end ?? "",
    inputs.summary.cache_key,
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
}): WaveformTileFrameTracePayload {
  return drawWaveformTileFrame({
    canvas: args.canvas,
    displayWidthPx: args.displayWidthPx,
    host: args.host,
    opacity: args.opacity,
    renderScale: args.renderScale,
    resolvePeak: (x) => {
      const index = args.displayStartPx + x + args.displaySampleOffsetPx;
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
}): WaveformTileFrameTracePayload {
  return drawWaveformTileFrame({
    canvas: args.canvas,
    displayWidthPx: args.displayWidthPx,
    host: args.host,
    opacity: args.opacity,
    renderScale: args.renderScale,
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

function clearWaveformTileCanvas(canvas: HTMLCanvasElement, displayWidthPx: number) {
  const ownerWindow = canvas.ownerDocument.defaultView;
  const width = Math.max(1, Math.ceil(displayWidthPx));
  const height = Math.max(1, Math.ceil(canvas.clientHeight || WAVEFORM_CANVAS_HEIGHT));
  const backingMetrics = resolveWaveformCanvasBackingMetrics({
    cssHeight: height,
    cssWidth: width,
    devicePixelRatio: ownerWindow?.devicePixelRatio || 1,
  });

  if (
    canvas.width !== backingMetrics.backingWidth ||
    canvas.height !== backingMetrics.backingHeight
  ) {
    canvas.width = backingMetrics.backingWidth;
    canvas.height = backingMetrics.backingHeight;
    return;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.setTransform(backingMetrics.scaleX, 0, 0, backingMetrics.scaleY, 0, 0);
  context.clearRect(0, 0, width, height);
}

function drawWaveformTileFrame(args: {
  canvas: HTMLCanvasElement;
  displayWidthPx: number;
  host: HTMLElement;
  opacity: number;
  resolvePeak: (pixelX: number) => { min: number; max: number };
  renderScale: number;
}): WaveformTileFrameTracePayload {
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
    return createWaveformTileFrameTracePayload({
      backingMetrics,
      barCount: 0,
      canvas: args.canvas,
      drawMode: "display-pixels",
      lineWidthCssPx: 0,
      renderScale: args.renderScale,
      sampledBarCenters: [],
    });
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

  const drawMode: WaveformTileFrameDrawMode = "display-pixels";
  const sampledBarCenters: number[] = [];
  for (let x = 0; x < width; x += 1) {
    pushWaveformTraceSample(sampledBarCenters, x + 0.5);
    appendWaveformBarPath({
      baselineY,
      context,
      peak: args.resolvePeak(x),
      verticalScale,
      widthPx: width,
      xPx: x,
    });
  }

  context.stroke();
  context.globalAlpha = 1;

  return createWaveformTileFrameTracePayload({
    backingMetrics,
    barCount: width,
    canvas: args.canvas,
    drawMode,
    lineWidthCssPx: context.lineWidth,
    renderScale: args.renderScale,
    sampledBarCenters,
  });
}

function appendWaveformBarPath(args: {
  baselineY: number;
  context: CanvasRenderingContext2D;
  peak: {
    max: number;
    min: number;
  };
  verticalScale: number;
  widthPx: number;
  xPx: number;
}) {
  const barWidthPx = resolveWaveformBarWidthPx({ renderScale: 1 });
  const barX = args.xPx + barWidthPx / 2;

  if (args.xPx <= -barWidthPx || args.xPx >= args.widthPx) {
    return;
  }

  const yFromMax = args.baselineY - sanitizePeakValue(args.peak.max) * args.verticalScale;
  const yFromMin = args.baselineY - sanitizePeakValue(args.peak.min) * args.verticalScale;
  const top = Math.min(yFromMax, yFromMin);
  const bottom = Math.max(yFromMax, yFromMin);
  const resolvedTop = bottom - top < 1 ? args.baselineY - 0.5 : top;
  const resolvedBottom = bottom - top < 1 ? args.baselineY + 0.5 : bottom;

  args.context.moveTo(barX, resolvedTop);
  args.context.lineTo(barX, resolvedBottom);
}

function createWaveformTileFrameTracePayload(args: {
  backingMetrics: ReturnType<typeof resolveWaveformCanvasBackingMetrics>;
  barCount: number;
  canvas: HTMLCanvasElement;
  drawMode: WaveformTileFrameDrawMode;
  lineWidthCssPx: number;
  renderScale: number;
  sampledBarCenters: readonly number[];
}): WaveformTileFrameTracePayload {
  const barCenterSamplePx = isWaveformTraceDetailEnabled()
    ? sampleWaveformTraceItems(args.sampledBarCenters, (centerPx) => centerPx)
    : [];
  const barSpacingSamplePx = resolveWaveformBarSpacingSamplePx(barCenterSamplePx);
  const barWidthCssPx = resolveWaveformBarWidthPx({ renderScale: 1 });

  return {
    backingScaleX: args.backingMetrics.scaleX,
    barCenterSamplePx,
    barCount: args.barCount,
    barSpacingSamplePx,
    barWidthCssPx,
    barWidthDevicePx: barWidthCssPx * args.backingMetrics.scaleX,
    canvasBackingWidth: args.canvas.width,
    canvasClientWidth: args.canvas.clientWidth,
    canvasCssWidth: args.backingMetrics.cssWidth,
    canvasStyleWidth: args.canvas.style.width,
    drawMode: args.drawMode,
    lineWidthCssPx: args.lineWidthCssPx,
    lineWidthDevicePx: args.lineWidthCssPx * args.backingMetrics.scaleX,
    maxBarSpacingPx: barSpacingSamplePx.length > 0 ? Math.max(...barSpacingSamplePx) : null,
    minBarSpacingPx: barSpacingSamplePx.length > 0 ? Math.min(...barSpacingSamplePx) : null,
    renderScale: args.renderScale,
  };
}

function resolveWaveformBarSpacingSamplePx(barCenterSamplePx: readonly number[]) {
  const barSpacingSamplePx: number[] = [];
  for (let index = 1; index < barCenterSamplePx.length; index += 1) {
    barSpacingSamplePx.push(barCenterSamplePx[index] - barCenterSamplePx[index - 1]);
  }

  return barSpacingSamplePx;
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
  controller: Pick<WaveformPresentationController, "setScrollLeft">;
  zoomController?: Pick<WaveformZoomController, "reset">;
  scrollbarsRef: RefObject<OverlayScrollbarsComponentRef<"div"> | null>;
}) {
  args.zoomController?.reset();
  const scrollElements = getWaveformScrollElements(args.scrollbarsRef.current);
  if (scrollElements) {
    writeWaveformScrollLeft(scrollElements, 0);
  }

  args.controller.setScrollLeft(0);
}

function isWaveformTileIndexInWindow(index: number, window: WaveformTileWindow) {
  return index >= window.startIndex && index <= window.endIndex;
}

export function isWaveformTileWindowCoveringWindow(
  container: WaveformTileWindow,
  contained: WaveformTileWindow,
) {
  return container.startIndex <= contained.startIndex && container.endIndex >= contained.endIndex;
}

function isWaveformTileDataCoveringGeometry(
  data: TrackWaveformTile | null,
  geometry: WaveformTileGeometry,
) {
  if (!data) {
    return false;
  }

  const dataStartPx = Math.max(0, data.start_px);
  const dataEndPx = dataStartPx + Math.max(0, data.width_px);
  const sourceStartPx = Math.max(0, geometry.sourceStartPx);
  const sourceEndPx = sourceStartPx + Math.max(0, geometry.sourceWidthPx);

  return dataStartPx <= sourceStartPx && dataEndPx >= sourceEndPx;
}

function createWaveformTileDataKey(data: TrackWaveformTile) {
  return `${data.points_per_second}:${data.start_px}:${data.width_px}:${data.min.length}:${data.max.length}`;
}

function createWaveformTileRequestCacheKey(args: {
  inputs: WaveformRenderInputs;
  renderPixelsPerSecond: number;
  tileStartPx: number;
  tileWidthPx: number;
}) {
  return [
    createWaveformTileDataScopeKey(args.inputs),
    Math.max(1, Math.ceil(args.renderPixelsPerSecond)),
    Math.max(0, Math.floor(args.tileStartPx)),
    Math.max(1, Math.ceil(args.tileWidthPx)),
  ].join("|");
}

export function resolveWaveformTileDrawIntent(args: {
  hasData: boolean;
  status: WaveformStatus;
}): WaveformTileDrawIntent {
  if (args.hasData) {
    return "data";
  }

  return args.status === "idle" ? "placeholder" : "blank";
}

export function resolveWaveformTileDrawOpacity(args: {
  intent: WaveformTileDrawIntent;
  opacity: number;
  status: WaveformStatus;
}) {
  return args.intent === "placeholder" && args.status === "ready"
    ? WAVEFORM_INACTIVE_OPACITY
    : args.opacity;
}

function createWaveformTileRenderStats(args: {
  removedTileIndexes: readonly number[];
  removedTileCount: number;
  tileCountBefore: number;
}): WaveformTileRenderStats {
  return {
    blankDrawCount: 0,
    blankDrawTileIndexes: [],
    createdTileCount: 0,
    createdTileIndexes: [],
    dataDrawCount: 0,
    dataDrawTileIndexes: [],
    drawDurationMs: 0,
    dataResetCount: 0,
    dataResetTileIndexes: [],
    displayChangeCount: 0,
    displayChangeTileIndexes: [],
    placeholderDrawCount: 0,
    placeholderDrawTileIndexes: [],
    removedTileCount: args.removedTileCount,
    removedTileIndexes: sampleWaveformTraceIndexes(args.removedTileIndexes),
    renderedTileSamples: [],
    skippedDrawCount: 0,
    skippedDrawTileIndexes: [],
    sourceChangeCount: 0,
    sourceChangeTileIndexes: [],
    tileCountBefore: args.tileCountBefore,
  };
}

function applyWaveformTileRenderStats(
  stats: WaveformTileRenderStats,
  index: number,
  syncResult: WaveformTileSyncResult,
  drawTraceResult: WaveformTileDrawTraceResult,
) {
  applyWaveformTileSyncStats(stats, index, syncResult);
  stats.drawDurationMs += drawTraceResult.durationMs;
  const drawResult = drawTraceResult.result;

  if (drawResult === "data") {
    stats.dataDrawCount += 1;
    pushWaveformTraceSample(stats.dataDrawTileIndexes, index);
    return;
  }

  if (drawResult === "placeholder") {
    stats.placeholderDrawCount += 1;
    pushWaveformTraceSample(stats.placeholderDrawTileIndexes, index);
    return;
  }

  if (drawResult === "blank") {
    stats.blankDrawCount += 1;
    pushWaveformTraceSample(stats.blankDrawTileIndexes, index);
    return;
  }

  stats.skippedDrawCount += 1;
  pushWaveformTraceSample(stats.skippedDrawTileIndexes, index);
}

function applyWaveformTileSyncStats(
  stats: WaveformTileRenderStats,
  index: number,
  syncResult: WaveformTileSyncResult,
) {
  if (syncResult.displayChanged) {
    stats.displayChangeCount += 1;
    pushWaveformTraceSample(stats.displayChangeTileIndexes, index);
  }

  if (syncResult.sourceChanged) {
    stats.sourceChangeCount += 1;
    pushWaveformTraceSample(stats.sourceChangeTileIndexes, index);
  }

  if (syncResult.dataReset) {
    stats.dataResetCount += 1;
    pushWaveformTraceSample(stats.dataResetTileIndexes, index);
  }
}

export function shouldPreventWaveformWheelDefault(intent: WaveformWheelIntent) {
  return intent.kind !== "none";
}

function handleWaveformViewportWheel(args: {
  event: WaveformWheelEvent;
  panController: WaveformPanController;
  scrollElements: WaveformScrollElements;
  wheelState: WaveformWheelState;
  zoomController: WaveformZoomController;
}) {
  const { viewportWidth } = args.wheelState;
  const scrollElement = args.scrollElements.viewport;
  const viewportHeight = Math.max(1, scrollElement.clientHeight || WAVEFORM_CANVAS_HEIGHT);
  const wheelViewportWidth = Math.max(1, scrollElement.clientWidth || viewportWidth);
  const wheelFieldDeltas = {
    axis: readWaveformWheelAxis(args.event),
    deltaMode: readWaveformWheelDeltaMode(args.event),
    deltaX: readWaveformWheelDeltaX(args.event),
    deltaY: readWaveformWheelDeltaY(args.event),
    horizontalAxis: readWaveformWheelHorizontalAxis(args.event),
    wheelDelta: readWaveformLegacyWheelDelta(args.event),
    wheelDeltaX: readWaveformLegacyWheelDeltaX(args.event),
    wheelDeltaY: readWaveformLegacyWheelDeltaY(args.event),
  };
  const wheelDeltas = resolveWaveformWheelDeltas({
    ...wheelFieldDeltas,
  });
  const shiftKey = readWaveformWheelBoolean(args.event, "shiftKey");
  const intent = resolveWaveformWheelOperation({
    ...wheelDeltas,
    viewportHeight,
    viewportWidth: wheelViewportWidth,
    shiftKey,
  });
  const trace =
    intent.kind === "horizontal-pan"
      ? createWaveformViewportTraceContext("horizontal-wheel")
      : null;
  if (intent.kind !== "none" || isWaveformTraceEnabled()) {
    recordWaveformTrace("wheel.intent", {
      contentWidth: args.wheelState.contentWidth,
      intent,
      fields: wheelFieldDeltas,
      resolved: wheelDeltas,
      shiftKey,
      trace,
      viewportHeight,
      viewportWidth: wheelViewportWidth,
    });
  }

  if (intent.kind === "none") {
    return;
  }

  if (!shouldPreventWaveformWheelDefault(intent)) {
    return;
  }

  preventWaveformWheelDefault(args.event);

  if (intent.kind === "horizontal-pan") {
    if (!trace) {
      return;
    }

    handleWaveformHorizontalPanWheel({
      deltaX: intent.deltaX,
      panController: args.panController,
      scrollElements: args.scrollElements,
      trace,
      wheelState: args.wheelState,
    });
    return;
  }

  const scrollLeft = args.wheelState.controller.getScrollLeft();

  handleWaveformZoomWheel({
    deltaY: intent.deltaY,
    event: args.event,
    scrollElements: args.scrollElements,
    scrollLeft,
    wheelState: args.wheelState,
    zoomController: args.zoomController,
  });
}

function handleWaveformHorizontalPanWheel(args: {
  deltaX: number;
  panController: WaveformPanController;
  scrollElements: WaveformScrollElements;
  trace: WaveformViewportTraceContext;
  wheelState: WaveformWheelState;
}) {
  args.panController.apply({
    deltaX: args.deltaX,
    scrollElements: args.scrollElements,
    trace: args.trace,
    wheelState: args.wheelState,
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
  recordWaveformTrace("wheel.zoom", {
    anchorClientX,
    anchorViewportX,
    deltaY: args.deltaY,
    pixelsPerSecond: args.wheelState.requestedPixelsPerSecond,
    scrollLeft: args.scrollLeft,
    viewportWidth,
  });

  args.zoomController.apply({
    anchorViewportX,
    deltaY: args.deltaY,
    scrollElements: args.scrollElements,
    scrollLeft: args.scrollLeft,
    viewportWidth,
    wheelState: args.wheelState,
  });
}

function getWaveformScrollElements(
  ref: OverlayScrollbarsComponentRef<"div"> | null,
): WaveformScrollElements | null {
  return ref?.osInstance()?.elements() ?? null;
}

function readWaveformScrollLeft(elements: WaveformScrollElements) {
  return resolveWaveformScrollReadValue({
    scrollOffsetElementScrollLeft: elements.scrollOffsetElement.scrollLeft,
    viewportScrollLeft: elements.viewport.scrollLeft,
  });
}

function writeWaveformScrollLeft(elements: WaveformScrollElements, scrollLeft: number) {
  const writePlan = resolveWaveformScrollWritePlan({
    hasSeparateScrollOffsetElement: elements.scrollOffsetElement !== elements.viewport,
    scrollLeft,
  });

  elements.viewport.scrollLeft = writePlan.viewportScrollLeft;

  if (writePlan.scrollOffsetElementScrollLeft !== null) {
    elements.scrollOffsetElement.scrollLeft = writePlan.scrollOffsetElementScrollLeft;
  }
}

function readWaveformWheelDeltaX(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "deltaX", null);
}

function readWaveformWheelDeltaY(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "deltaY", null);
}

function readWaveformWheelDeltaMode(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "deltaMode", 0);
}

function readWaveformLegacyWheelDeltaX(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "wheelDeltaX", null);
}

function readWaveformLegacyWheelDeltaY(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "wheelDeltaY", null);
}

function readWaveformLegacyWheelDelta(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "wheelDelta", null);
}

function readWaveformWheelAxis(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "axis", null);
}

function readWaveformWheelHorizontalAxis(event: WaveformWheelEvent) {
  return readWaveformWheelNumber(event, "HORIZONTAL_AXIS", null);
}

function readWaveformWheelNumber(event: WaveformWheelEvent, key: string, fallback: number): number;
function readWaveformWheelNumber(
  event: WaveformWheelEvent,
  key: string,
  fallback: null,
): number | null;
function readWaveformWheelNumber(event: WaveformWheelEvent, key: string, fallback: number | null) {
  const read = readWaveformWheelProperty(event, key);
  return fallback === null
    ? resolveWaveformWheelNumberPropertyRead(read, null).value
    : resolveWaveformWheelNumberPropertyRead(read, fallback).value;
}

function readWaveformWheelBoolean(event: WaveformWheelEvent, key: string) {
  return resolveWaveformWheelBooleanPropertyRead(readWaveformWheelProperty(event, key));
}

function readWaveformWheelProperty(
  event: WaveformWheelEvent,
  key: string,
): WaveformWheelPropertyRead {
  const directObject = event as unknown as Record<string, unknown>;
  const nativeObject = getWaveformNativeEvent(event);
  const direct = createWaveformWheelPropertyCandidate(directObject, key);
  const native = createWaveformWheelPropertyCandidate(nativeObject, key);
  const source = direct.present ? "direct" : native.present ? "native" : "none";

  return {
    direct,
    native,
    source,
    value: source === "direct" ? direct.value : source === "native" ? native.value : undefined,
  };
}

function createWaveformWheelPropertyCandidate(
  target: Record<string, unknown> | null,
  key: string,
): WaveformWheelPropertyCandidate {
  if (!target) {
    return {
      own: false,
      present: false,
      value: undefined,
    };
  }

  const own = Object.prototype.hasOwnProperty.call(target, key);
  const value = target[key];

  return {
    own,
    present: own || value !== undefined,
    value,
  };
}

function getWaveformNativeEvent(event: WaveformWheelEvent) {
  const nativeEvent = event.nativeEvent;
  return typeof Event !== "undefined" && nativeEvent instanceof Event
    ? (nativeEvent as unknown as Record<string, unknown>)
    : null;
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

function scheduleWaveformInitialPrepare(
  ownerWindow: Window | null,
  callback: () => void,
): WaveformInitialPrepareHandle {
  if (ownerWindow) {
    const handle: WaveformInitialPrepareHandle = {
      frameId: 0,
      idleHandle: null,
      kind: "after-first-frame",
      remainingFrames: WAVEFORM_INITIAL_PREPARE_FRAME_COUNT,
    };
    const scheduleAfterFrame = () => {
      handle.remainingFrames -= 1;
      if (handle.remainingFrames <= 0) {
        handle.idleHandle = scheduleWaveformIdlePrepare(ownerWindow, callback);
        return;
      }

      handle.frameId = ownerWindow.requestAnimationFrame(scheduleAfterFrame);
    };

    handle.frameId = ownerWindow.requestAnimationFrame(scheduleAfterFrame);

    return handle;
  }

  callback();
  return null;
}

function scheduleWaveformIdlePrepare(
  ownerWindow: Window,
  callback: () => void,
): WaveformInitialPrepareHandle {
  const idleWindow = ownerWindow as WaveformIdleWindow;

  if (idleWindow.requestIdleCallback) {
    return {
      id: idleWindow.requestIdleCallback(callback, { timeout: WAVEFORM_INITIAL_PREPARE_DELAY_MS }),
      kind: "idle",
    };
  }

  return {
    id: ownerWindow.setTimeout(callback, WAVEFORM_INITIAL_PREPARE_DELAY_MS),
    kind: "timer",
  };
}

function cancelWaveformInitialPrepare(
  ownerWindow: Window | null,
  handle: WaveformInitialPrepareHandle,
) {
  if (!handle || !ownerWindow) {
    return;
  }

  const idleWindow = ownerWindow as WaveformIdleWindow;
  if (handle.kind === "after-first-frame") {
    ownerWindow.cancelAnimationFrame(handle.frameId);
    cancelWaveformInitialPrepare(ownerWindow, handle.idleHandle);
    return;
  }

  if (handle.kind === "idle") {
    idleWindow.cancelIdleCallback?.(handle.id);
    return;
  }

  ownerWindow.clearTimeout(handle.id);
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

function roundWaveformPixelsPerSecond(value: number, constraints?: WaveformZoomConstraints) {
  const minimumPixelsPerSecond = resolveWaveformMinimumPixelsPerSecond(constraints);
  const maximumPixelsPerSecond = Math.max(
    minimumPixelsPerSecond,
    resolveWaveformMaximumPixelsPerSecond(constraints),
  );

  return (
    Math.round(
      clampNumber(value, minimumPixelsPerSecond, maximumPixelsPerSecond) *
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
