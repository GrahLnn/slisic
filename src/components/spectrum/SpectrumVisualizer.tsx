import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { normalizeMediaPathKey } from "@/src/mediaPath";
import {
  crab,
  type HardwareHorizontalWheelEvent,
  type PlaybackStatusPayload,
  type TrackWaveformSummary,
  type TrackWaveformTile,
  type WaveformPeak,
} from "@/src/cmd";

const WAVEFORM_CANVAS_HEIGHT = 208;
const WAVEFORM_VERTICAL_PADDING = 18;
const WAVEFORM_PLACEHOLDER_POINTS_PER_SECOND = 80;
const WAVEFORM_PLACEHOLDER_DURATION_MS = 8_000;
const WAVEFORM_MIN_PIXELS_PER_SECOND = 12;
const WAVEFORM_FALLBACK_MAX_PIXELS_PER_SECOND = 320;
const WAVEFORM_FALLBACK_PIXELS_PER_SECOND = 24;
const WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM = 360;
const WAVEFORM_MAX_WHEEL_ZOOM_DELTA = WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM / 2;
const WAVEFORM_PIXELS_PER_SECOND_PRECISION = 100;
const WAVEFORM_DATA_TILE_WIDTH = 2_048;
const WAVEFORM_DATA_OVERSCAN_VIEWPORTS = 1.25;
const WAVEFORM_DATA_CACHE_LIMIT = 384;
const WAVEFORM_DATA_LOAD_CONCURRENCY = 2;
const WAVEFORM_DATA_IDLE_OVERSCAN_DELAY_MS = 180;
const WAVEFORM_INTERACTIVE_DATA_DEMAND_INTERVAL_MS = 64;
const WAVEFORM_INTERACTIVE_GUARD_VIEWPORTS = 0.5;
const WAVEFORM_DATA_PREFETCH_REVERSE_LEVEL_COUNT = 3;
const WAVEFORM_DATA_PREFETCH_VISIBLE_LEVEL_COUNT = 1;
const WAVEFORM_DATA_PREFETCH_FOCUS_LEVEL_COUNT = 3;
const WAVEFORM_CANVAS_FRAME_BUDGET_MS = 3.25;
const WAVEFORM_CANVAS_MIN_CHUNK_WIDTH_PX = 96;
const WAVEFORM_CANVAS_MAX_CHUNK_WIDTH_PX = 320;
const WAVEFORM_CANVAS_REUSE_MIN_SHIFT_PX = 1;
const WAVEFORM_CANVAS_STROKE_ALPHA = 0.88;
const WAVEFORM_SELECTION_START_LEADING_SPACE_PX = 96;
const WAVEFORM_INITIAL_PREPARE_FRAME_COUNT = 2;
const WAVEFORM_LOADING_DOT_PITCH_PX = 12;
const WAVEFORM_LOADING_MIN_FIELD_WIDTH_PX = 96;
const WAVEFORM_LOADING_MIN_FIELD_HEIGHT_PX = 44;
const WAVEFORM_LOADING_MAX_FIELD_HEIGHT_PX = 112;
const WAVEFORM_LOADING_MAX_DEVICE_PIXEL_RATIO = 1.5;
const WAVEFORM_LOADING_VERTEX_DATA = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
const WAVEFORM_LOADING_VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;
const WAVEFORM_LOADING_FRAGMENT_SHADER_SOURCE = `
precision mediump float;

uniform vec2 u_resolution;
uniform vec2 u_grid;
uniform float u_time;
uniform vec3 u_color;

float random(vec2 value) {
  return fract(sin(dot(value, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 pitch = u_resolution / u_grid;
  vec2 cell = floor(gl_FragCoord.xy / pitch);
  vec2 center = (cell + 0.5) * pitch;
  float distanceToCenter = length(gl_FragCoord.xy - center);
  float radius = 1.35;
  float dotMask = smoothstep(radius + 0.9, radius, distanceToCenter);
  float seed = random(cell + u_grid * 0.173);
  float pulse = 0.5 + 0.5 * sin(u_time * (4.8 + seed * 2.4) + seed * 6.28318);
  float alpha = dotMask * (0.08 + pulse * (0.18 + seed * 0.62));

  gl_FragColor = vec4(u_color, alpha);
}
`;
const PLAYBACK_STATUS_POLL_MS = 250;
const WAVEFORM_VIEWPORT_POSITION_EPSILON_PX = 0.000001;

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
  beginPlaybackSeek: () => Promise<PlaybackStatusPayload | null>;
  cancelPlaybackSeek: () => Promise<PlaybackStatusPayload | null>;
  getPlaybackStatus: () => Promise<PlaybackStatusPayload | null>;
  seekPlayback: (positionMs: number, endMs: number) => Promise<PlaybackStatusPayload | null>;
}

export interface TrackSpectrumPorts {
  playback: TrackSpectrumPlaybackPort;
  waveform: TrackSpectrumWaveformPort;
}

type TrackWaveformSummaryState = {
  status: WaveformStatus;
  summary: TrackWaveformSummary;
};

type WaveformSharedSummaryEntry = {
  promise: Promise<TrackWaveformSummary> | null;
  state: TrackWaveformSummaryState | null;
};

export type WaveformRenderDataStore = {
  summaries: Map<string, WaveformSharedSummaryEntry>;
  tileCaches: Map<string, Map<string, WaveformCachedTile>>;
  tilePromises: Map<string, Promise<TrackWaveformTile>>;
};

type WaveformSharedDataStore = WaveformRenderDataStore;

type WaveformZoomConstraints = {
  durationMs: number;
  maximumPixelsPerSecond?: number;
  viewportWidth: number;
};

type WaveformViewportState = {
  focusSeconds: number | null;
  pixelsPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
};

type WaveformViewportModel = WaveformViewportState & {
  contentWidth: number;
  durationMs: number;
  maximumPixelsPerSecond: number;
};

type WaveformZoomFrame = {
  anchorSeconds: number;
  anchorViewportX: number;
  contentWidth: number;
  pixelsPerSecond: number;
  scrollLeft: number;
};

type WaveformWheelDeltas = {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
};

type WaveformWheelPixelDeltas = {
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

type WaveformViewportCommit = (request: WaveformViewportCommitRequest) => void;

type WaveformZoomCommand = {
  anchorViewportX: number;
  deltaY: number;
  viewport: WaveformViewportModel;
};

type WaveformZoomQueue = (command: WaveformZoomCommand) => void;

type WaveformInteractionMode = "interactive" | "settled";
type WaveformZoomOwnership = "explicit" | "initial-minimum";

type WaveformResizeCommand = {
  viewportWidth: number;
};

type WaveformResizeQueue = (command: WaveformResizeCommand) => void;

type WaveformDataWindow = {
  endPx: number;
  startPx: number;
};

export type WaveformSelectionRange = {
  end: number | null;
  start: number | null;
};

type WaveformSelectionEdge = "end" | "start";

export type WaveformSelectionGeometry = {
  endX: number;
  isComplete: boolean;
  startX: number;
};

export type WaveformSelectionDragResolution = {
  end: number;
  start: number;
};

export type WaveformPlayheadDragResolution = {
  endMs: number;
  positionMs: number;
};

type WaveformSecondsWindow = {
  endSeconds: number;
  startSeconds: number;
};

type WaveformDataRequestPriority =
  | "visible"
  | "visible-guard"
  | "prefetch-reverse"
  | "prefetch-focus"
  | "prefetch-visible"
  | "overscan";

type WaveformDataPlanMode = WaveformInteractionMode;

type WaveformDataRequest = {
  cacheKey: string;
  dataPixelsPerSecond: number;
  endPx: number;
  focusDistancePx: number;
  index: number;
  lodDepth: number;
  priority: WaveformDataRequestPriority;
  scopeKey: string;
  startPx: number;
  widthPx: number;
};

type WaveformDataPlan = {
  dataContentWidth: number;
  dataPixelsPerSecond: number;
  mode: WaveformDataPlanMode;
  overscanSecondsWindow: WaveformSecondsWindow;
  overscanWindow: WaveformDataWindow;
  protectedCacheKeys: string[];
  requests: WaveformDataRequest[];
  scopeKey: string;
  visibleIndexes: number[];
  visibleSecondsWindow: WaveformSecondsWindow;
  visibleWindow: WaveformDataWindow;
};

type WaveformDataPlanScope = "visible" | "complete";

type WaveformDataPlanRequest = {
  plan: WaveformDataPlan;
  scope: WaveformDataPlanScope;
};

type WaveformTransaction = {
  dataDemand: {
    plan: WaveformDataPlan | null;
    scope: WaveformDataPlanScope;
    skipped: boolean;
  };
  mode: WaveformDataPlanMode;
  presentation: {
    plan: WaveformDataPlan | null;
  };
  shouldScheduleCompleteData: boolean;
};

type WaveformTransactionResolution = {
  nextInteractiveDataDemand: WaveformInteractiveDataDemand | null;
  nextInteractiveDataDemandAt: number | null;
  transaction: WaveformTransaction;
};

type WaveformInteractiveDataDemand = {
  at: number;
  signature: string | null;
};

type WaveformViewportCommitRequest = {
  mode?: WaveformInteractionMode;
  state: WaveformViewportState;
};

type WaveformCachedTile = {
  data: TrackWaveformTile;
  key: string;
  lastUsedAt: number;
  pixelsPerSecond: number;
  scopeKey: string;
};

type WaveformTileLoadQueueEntry = WaveformDataRequest & {
  order: number;
};

type WaveformInitialPrepareHandle = {
  cancel: () => void;
} | null;

type WaveformPlayheadController = {
  beginPlayheadDrag: () => void;
  cancelPlayheadDrag: () => void;
  commitPlayheadDrag: (resolution: WaveformPlayheadDragResolution) => Promise<void>;
  previewPlayheadDrag: (resolution: WaveformPlayheadDragResolution | null) => void;
  syncPlayhead: () => void;
};

const inertWaveformPlayheadController: WaveformPlayheadController = {
  beginPlayheadDrag: () => undefined,
  cancelPlayheadDrag: () => undefined,
  commitPlayheadDrag: async () => undefined,
  previewPlayheadDrag: () => undefined,
  syncPlayhead: () => undefined,
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

type WaveformLevelTileIndex = {
  pixelsPerSecond: number;
  tilesByIndex: Map<number, TrackWaveformTile>;
};

type WaveformPeakSample = {
  max: number;
  min: number;
};

type WaveformCanvasFrameGeometry = {
  backingHeight: number;
  backingWidth: number;
  devicePixelRatio: number;
  viewportWidth: number;
};

type WaveformCanvasRenderPlan = {
  amplitude: number;
  availableLevels: number[];
  candidateLevels: WaveformLevelTileIndex[];
  centerY: number;
  dataPixelsPerSecond: number;
  geometry: WaveformCanvasFrameGeometry;
  scopeKey: string;
  viewport: WaveformViewportModel;
  visibleSecondsWindow: WaveformSecondsWindow;
  visibleWindow: WaveformDataWindow;
};

type WaveformCanvasFrameDescriptor = {
  dataPixelsPerSecond: number;
  geometry: WaveformCanvasFrameGeometry;
  scopeKey: string;
  viewport: WaveformViewportModel;
};

type WaveformCanvasRenderPlanEmpty =
  | {
      geometry: WaveformCanvasFrameGeometry;
      kind: "missing-data-plan";
      status: WaveformStatus;
      viewport: WaveformViewportModel;
    }
  | {
      geometry: WaveformCanvasFrameGeometry;
      kind: "missing-candidate-levels";
      levelIndexes: Map<number, WaveformLevelTileIndex>;
      plan: WaveformDataPlan;
      tileCacheSize: number;
      viewport: WaveformViewportModel;
    }
  | {
      filePath: string | null;
      geometry: WaveformCanvasFrameGeometry;
      kind: "missing-file" | "not-ready";
      status: WaveformStatus;
      viewport: WaveformViewportModel;
    };

type WaveformCanvasRasterTargetBase = {
  context: CanvasRenderingContext2D;
  frame: HTMLCanvasElement;
  geometry: WaveformCanvasFrameGeometry;
};

type WaveformCanvasBufferedRasterTarget = WaveformCanvasRasterTargetBase & {
  kind: "buffered";
};

type WaveformCanvasRasterTarget = WaveformCanvasBufferedRasterTarget;

type WaveformCanvasFrameCommitResult =
  | {
      kind: "committed";
    }
  | {
      kind: "empty";
      reason: "missing-context";
    };

type WaveformCanvasRenderJobCompletion = WaveformCanvasFrameCommitResult;

type WaveformCanvasRasterTargetEmpty = {
  geometry: WaveformCanvasFrameGeometry;
  kind: "missing-context";
};

type WaveformCanvasRenderCursor = {
  firstMissingX: number | null;
  hasDrawnColumn: boolean;
  lastMissingX: number | null;
  missingPeakColumnCount: number;
  nextX: number;
  resolvedPeakColumnCount: number;
};

type WaveformCanvasChunkResult = {
  completed: boolean;
  cursor: WaveformCanvasRenderCursor;
  firstMissingX: number | null;
  hasChunkColumn: boolean;
  lastMissingX: number | null;
  missingPeakColumns: number;
  resolvedPeakCount: number;
  scannedColumns: number;
};

type WaveformCanvasColumnRangeResult = {
  firstMissingX: number | null;
  hasColumn: boolean;
  lastMissingX: number | null;
  missingPeakColumns: number;
  resolvedPeakCount: number;
  scannedColumns: number;
};

type WaveformCanvasColumnRange = {
  endX: number;
  startX: number;
};

type WaveformCanvasColumnSample = {
  levelPixelsPerSecond: number;
  peak: WaveformPeakSample;
};

type WaveformCanvasFastPresentationResult =
  | {
      draws: WaveformCanvasColumnRangeResult[];
      exposedRanges: WaveformCanvasColumnRange[];
      descriptor: WaveformCanvasFrameDescriptor;
      exposedWidthPx: number;
      kind: "presented";
      mode: "horizontal-pan";
      plan: Extract<WaveformCanvasFrameReusePlan, { kind: "horizontal-pan" }>;
      reuseFrame: HTMLCanvasElement;
    }
  | {
      draws: WaveformCanvasColumnRangeResult[];
      exposedRanges: WaveformCanvasColumnRange[];
      descriptor: WaveformCanvasFrameDescriptor;
      exposedWidthPx: number;
      kind: "presented";
      mode: "viewport-resize";
      plan: Extract<WaveformCanvasFrameReusePlan, { kind: "viewport-resize" }>;
      reuseFrame: HTMLCanvasElement;
    }
  | {
      draw: WaveformCanvasColumnRangeResult;
      descriptor: WaveformCanvasFrameDescriptor;
      kind: "presented";
      mode: "exact-cache-redraw";
      plan: Extract<WaveformCanvasFastPresentationPlan, { kind: "exact-cache-redraw" }>;
      reuseFrame: HTMLCanvasElement | null;
    }
  | {
      kind: "empty";
      plan: WaveformCanvasFastPresentationPlan | null;
      reason:
        | "missing-canvas"
        | "missing-context"
        | "missing-descriptor"
        | "missing-reuse-context"
        | "not-reusable";
      reuseFrame: HTMLCanvasElement | null;
    };

type WaveformCanvasFastPresentationPlan =
  | Extract<WaveformCanvasFrameReusePlan, { kind: "horizontal-pan" }>
  | Extract<WaveformCanvasFrameReusePlan, { kind: "viewport-resize" }>
  | {
      kind: "exact-cache-redraw";
    }
  | Extract<WaveformCanvasFrameReusePlan, { kind: "none" }>;

type WaveformCanvasRenderJob = {
  cursor: WaveformCanvasRenderCursor;
  id: number;
  plan: WaveformCanvasRenderPlan;
  revision: number;
  target: WaveformCanvasRasterTarget;
};

type WaveformCanvasRenderController = {
  dataPlan: WaveformDataPlan | null;
  frameId: number | null;
  job: WaveformCanvasRenderJob | null;
  presentedFrame: WaveformCanvasFrameDescriptor | null;
  requestedRevision: number;
  reuseFrame: HTMLCanvasElement | null;
};

type WaveformCanvasFrameReusePlan =
  | {
      kind: "horizontal-pan";
      exposedEndX: number;
      exposedStartX: number;
      scrollDeltaPx: number;
      shiftX: number;
    }
  | {
      copySourceStartX: number;
      copyTargetStartX: number;
      copyWidthPx: number;
      exposedRanges: WaveformCanvasColumnRange[];
      kind: "viewport-resize";
      scrollDeltaPx: number;
    }
  | {
      kind: "none";
      reason:
        | "content-changed"
        | "geometry-changed"
        | "missing-presented-frame"
        | "render-density-changed"
        | "scale-changed"
        | "scroll-delta-fractional"
        | "scroll-delta-too-small"
        | "scroll-delta-too-wide";
    };

type WaveformLoadingGridSize = {
  columns: number;
  rows: number;
};

type WaveformLoadingRenderer = {
  animationFrameId: number | null;
  animationOwnerWindow: Window | null;
  backingHeight: number | null;
  backingWidth: number | null;
  buffer: WebGLBuffer;
  color: readonly [number, number, number];
  colorUniform: WebGLUniformLocation;
  gridUniform: WebGLUniformLocation;
  gl: WebGLRenderingContext;
  positionAttribute: number;
  program: WebGLProgram;
  resolutionUniform: WebGLUniformLocation;
  resizeObserver: ResizeObserver | null;
  startTimeMs: number;
  timeUniform: WebGLUniformLocation;
};

const crabTrackSpectrumPorts: TrackSpectrumPorts = {
  playback: {
    beginPlaybackSeek: async () => {
      const result = await crab.beginPlaybackSeek();

      return result.match({
        Err: (error) => {
          throw new Error(error);
        },
        Ok: (status) => status,
      });
    },
    cancelPlaybackSeek: async () => {
      const result = await crab.cancelPlaybackSeek();

      return result.match({
        Err: (error) => {
          throw new Error(error);
        },
        Ok: (status) => status,
      });
    },
    getPlaybackStatus: async () => {
      const result = await crab.getPlaybackStatus();

      return result.match({
        Err: (error) => {
          throw new Error(error);
        },
        Ok: (status) => status,
      });
    },
    seekPlayback: async (positionMs, endMs) => {
      const result = await crab.seekPlayback(positionMs, endMs);

      return result.match({
        Err: (error) => {
          throw new Error(error);
        },
        Ok: (status) => status,
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
        Err: (error) => {
          throw new Error(error);
        },
        Ok: (tile) => tile,
      });
    },
    prepareTrackWaveform: async (filePath, start, end) => {
      const result = await crab.prepareTrackWaveform(filePath, start, end);

      return result.match({
        Err: (error) => {
          throw new Error(error);
        },
        Ok: (summary) => summary,
      });
    },
  },
};

let waveformCanvasRenderJobSequence = 0;

export function createWaveformRenderDataStore(): WaveformRenderDataStore {
  return {
    summaries: new Map(),
    tileCaches: new Map(),
    tilePromises: new Map(),
  };
}

const defaultWaveformRenderDataStore = createWaveformRenderDataStore();
const waveformSharedDataStores = new WeakMap<TrackSpectrumWaveformPort, WaveformSharedDataStore>();

function resolveWaveformSharedDataStore(port: TrackSpectrumWaveformPort) {
  if (port === crabTrackSpectrumPorts.waveform) {
    return defaultWaveformRenderDataStore;
  }

  const existing = waveformSharedDataStores.get(port);
  if (existing) {
    return existing;
  }

  const store = createWaveformRenderDataStore();
  waveformSharedDataStores.set(port, store);

  return store;
}

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

export function resolveWaveformZoomOwnedPixelsPerSecond(args: {
  durationMs: number;
  maximumPixelsPerSecond: number;
  ownership: WaveformZoomOwnership;
  pixelsPerSecond: number;
  viewportWidth: number;
}) {
  const constraints = {
    durationMs: args.durationMs,
    maximumPixelsPerSecond: args.maximumPixelsPerSecond,
    viewportWidth: args.viewportWidth,
  };

  return args.ownership === "initial-minimum"
    ? resolveWaveformMinimumPixelsPerSecond(constraints)
    : resolveWaveformPixelsPerSecond(args.pixelsPerSecond, constraints);
}

export function resolveWaveformResizeViewportState(args: {
  current: WaveformViewportModel;
  viewportWidth: number;
}): WaveformViewportState {
  return {
    focusSeconds: args.current.focusSeconds,
    pixelsPerSecond: args.current.pixelsPerSecond,
    scrollLeft: args.current.scrollLeft,
    viewportWidth: Math.max(1, Math.ceil(args.viewportWidth)),
  };
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

export function resolveWaveformViewportModel(args: {
  durationMs: number;
  focusSeconds: number | null;
  maximumPixelsPerSecond: number;
  pixelsPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
}): WaveformViewportModel {
  const viewportWidth = Math.max(1, Math.ceil(args.viewportWidth));
  const pixelsPerSecond = resolveWaveformPixelsPerSecond(args.pixelsPerSecond, {
    durationMs: args.durationMs,
    maximumPixelsPerSecond: args.maximumPixelsPerSecond,
    viewportWidth,
  });
  const contentWidth = resolveWaveformContentWidth({
    durationMs: args.durationMs,
    pixelsPerSecond,
    viewportWidth,
  });
  const scrollLeft = clampNumber(args.scrollLeft, 0, Math.max(0, contentWidth - viewportWidth));

  return {
    contentWidth,
    durationMs: args.durationMs,
    focusSeconds: args.focusSeconds,
    maximumPixelsPerSecond: args.maximumPixelsPerSecond,
    pixelsPerSecond,
    scrollLeft,
    viewportWidth,
  };
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

export function resolveWaveformSelectionStartScrollLeft(args: {
  contentWidth: number;
  leadingSpacePx: number;
  pixelsPerSecond: number;
  selection: WaveformSelectionRange | null;
  viewportWidth: number;
}) {
  const startSeconds = normalizeWaveformSelectionBoundary(args.selection?.start ?? null);

  if (startSeconds === null) {
    return 0;
  }

  return clampNumber(
    startSeconds * args.pixelsPerSecond - Math.max(0, args.leadingSpacePx),
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
  const changed = Math.abs(scrollLeft - args.scrollLeft) > WAVEFORM_VIEWPORT_POSITION_EPSILON_PX;

  return {
    changed,
    scrollLeft: changed ? scrollLeft : args.scrollLeft,
  };
}

export function resolveWaveformCanvasFrameReusePlan(args: {
  current: WaveformCanvasFrameDescriptor;
  previous: WaveformCanvasFrameDescriptor | null;
}): WaveformCanvasFrameReusePlan {
  if (!args.previous) {
    return {
      kind: "none",
      reason: "missing-presented-frame",
    };
  }

  if (
    args.previous.geometry.backingHeight !== args.current.geometry.backingHeight ||
    args.previous.geometry.devicePixelRatio !== args.current.geometry.devicePixelRatio
  ) {
    return {
      kind: "none",
      reason: "geometry-changed",
    };
  }

  if (
    args.previous.viewport.durationMs !== args.current.viewport.durationMs ||
    args.previous.scopeKey !== args.current.scopeKey
  ) {
    return {
      kind: "none",
      reason: "content-changed",
    };
  }

  if (
    Math.abs(args.previous.viewport.pixelsPerSecond - args.current.viewport.pixelsPerSecond) >=
      0.01 ||
    args.previous.viewport.maximumPixelsPerSecond !== args.current.viewport.maximumPixelsPerSecond
  ) {
    return {
      kind: "none",
      reason: "scale-changed",
    };
  }

  if (
    args.previous.viewport.contentWidth !== args.current.viewport.contentWidth &&
    args.previous.viewport.viewportWidth === args.current.viewport.viewportWidth
  ) {
    return {
      kind: "none",
      reason: "content-changed",
    };
  }

  if (args.previous.dataPixelsPerSecond !== args.current.dataPixelsPerSecond) {
    return {
      kind: "none",
      reason: "render-density-changed",
    };
  }

  const rawScrollDeltaPx = args.current.viewport.scrollLeft - args.previous.viewport.scrollLeft;
  const scrollDeltaPx = Math.round(rawScrollDeltaPx);
  if (Math.abs(rawScrollDeltaPx - scrollDeltaPx) > WAVEFORM_VIEWPORT_POSITION_EPSILON_PX) {
    return {
      kind: "none",
      reason: "scroll-delta-fractional",
    };
  }

  if (args.previous.viewport.viewportWidth !== args.current.viewport.viewportWidth) {
    const overlapStartX = Math.max(
      args.previous.viewport.scrollLeft,
      args.current.viewport.scrollLeft,
    );
    const overlapEndX = Math.min(
      args.previous.viewport.scrollLeft + args.previous.geometry.viewportWidth,
      args.current.viewport.scrollLeft + args.current.geometry.viewportWidth,
    );
    const copyWidthPx = Math.round(overlapEndX - overlapStartX);

    if (copyWidthPx <= 0) {
      return {
        kind: "none",
        reason: "scroll-delta-too-wide",
      };
    }

    const copySourceStartX = Math.round(overlapStartX - args.previous.viewport.scrollLeft);
    const copyTargetStartX = Math.round(overlapStartX - args.current.viewport.scrollLeft);
    const copyTargetEndX = copyTargetStartX + copyWidthPx;
    const exposedRanges = [
      {
        endX: copyTargetStartX,
        startX: 0,
      },
      {
        endX: args.current.geometry.viewportWidth,
        startX: copyTargetEndX,
      },
    ].filter((range) => range.endX > range.startX);

    return {
      copySourceStartX,
      copyTargetStartX,
      copyWidthPx,
      exposedRanges,
      kind: "viewport-resize",
      scrollDeltaPx,
    };
  }

  const absScrollDeltaPx = Math.abs(scrollDeltaPx);
  if (absScrollDeltaPx < WAVEFORM_CANVAS_REUSE_MIN_SHIFT_PX) {
    return {
      kind: "none",
      reason: "scroll-delta-too-small",
    };
  }

  if (absScrollDeltaPx >= args.current.geometry.viewportWidth) {
    return {
      kind: "none",
      reason: "scroll-delta-too-wide",
    };
  }

  return {
    exposedEndX: scrollDeltaPx > 0 ? args.current.geometry.viewportWidth : absScrollDeltaPx,
    exposedStartX: scrollDeltaPx > 0 ? args.current.geometry.viewportWidth - scrollDeltaPx : 0,
    kind: "horizontal-pan",
    scrollDeltaPx,
    shiftX: -scrollDeltaPx,
  };
}

function resolveWaveformCanvasFastPresentationPlan(args: {
  current: WaveformCanvasFrameDescriptor;
  hasExactPlan: boolean;
  previous: WaveformCanvasFrameDescriptor | null;
}): WaveformCanvasFastPresentationPlan {
  const reusePlan = resolveWaveformCanvasFrameReusePlan({
    current: args.current,
    previous: args.previous,
  });
  if (reusePlan.kind === "horizontal-pan" || reusePlan.kind === "viewport-resize") {
    return reusePlan;
  }

  if (reusePlan.reason === "scale-changed" && args.hasExactPlan) {
    return {
      kind: "exact-cache-redraw",
    };
  }

  return reusePlan;
}

export function shouldBeginWaveformCanvasChunkPath(args: { startX: number }) {
  return args.startX === 0;
}

export function shouldStrokeWaveformCanvasChunkPath(args: {
  completed: boolean;
  cursorHasDrawnColumn: boolean;
  hasChunkColumn: boolean;
}) {
  return args.completed && args.cursorHasDrawnColumn;
}

export function resolveWaveformWheelPanDelta(args: { deltaX: number }) {
  return args.deltaX;
}

/**
 * Frontend wheel owns only browser vertical zoom and the explicit Shift+Wheel
 * projection. Native horizontal wheel packets are owned by the Windows
 * hardware event path because Chromium/WebView can expose native horizontal
 * packets as zero-valued or one-shot DOM deltas. Keeping direct `deltaX` inert here
 * prevents a second horizontal-scroll owner from reappearing.
 */
export function resolveWaveformWheelAxisDeltas(
  args: WaveformWheelDeltas & {
    shiftKey?: boolean;
  },
): WaveformWheelDeltas {
  const shouldProjectVerticalToHorizontal = args.shiftKey === true && args.deltaY !== 0;

  if (shouldProjectVerticalToHorizontal) {
    return {
      deltaMode: args.deltaMode,
      deltaX: args.deltaY,
      deltaY: 0,
    };
  }

  return {
    deltaMode: args.deltaMode,
    deltaX: 0,
    deltaY: args.deltaY,
  };
}

export function resolveWaveformWheelIntent(args: {
  deltaX: number;
  deltaY: number;
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

export function resolveWaveformWheelPixelDeltas(
  args: WaveformWheelDeltas & {
    viewportHeight: number;
    viewportWidth: number;
  },
) {
  return {
    deltaX: normalizeWheelDeltaX({
      deltaMode: args.deltaMode,
      deltaX: args.deltaX,
      viewportWidth: args.viewportWidth,
    }),
    deltaY: normalizeWheelDeltaY({
      deltaMode: args.deltaMode,
      deltaY: args.deltaY,
      viewportHeight: args.viewportHeight,
    }),
  } satisfies WaveformWheelPixelDeltas;
}

export function resolveWaveformWheelOperation(
  args: WaveformWheelDeltas & {
    shiftKey?: boolean;
    viewportHeight: number;
    viewportWidth: number;
  },
): WaveformWheelIntent {
  return resolveWaveformWheelIntent(
    resolveWaveformWheelPixelDeltas({
      ...resolveWaveformWheelAxisDeltas(args),
      viewportHeight: args.viewportHeight,
      viewportWidth: args.viewportWidth,
    }),
  );
}

export function resolveWaveformWheelDeltaX(args: { deltaX?: number | null }) {
  return resolveWaveformWheelDeltas(args).deltaX;
}

export function resolveWaveformWheelDeltas(args: {
  deltaMode?: number | null;
  deltaX?: number | null;
  deltaY?: number | null;
}): WaveformWheelDeltas {
  return {
    deltaMode: Number.isFinite(args.deltaMode) ? Number(args.deltaMode) : 0,
    deltaX: resolveFiniteWheelDelta(args.deltaX),
    deltaY: resolveFiniteWheelDelta(args.deltaY),
  };
}

export function shouldPreventWaveformWheelDefault(intent: WaveformWheelIntent) {
  return intent.kind !== "none";
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
  const durationSeconds = Math.max(0, args.durationMs) / 1000;
  const anchorSeconds = clampNumber(
    (args.scrollLeft + args.anchorViewportX) / Math.max(1, currentPixelsPerSecond),
    0,
    durationSeconds,
  );
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
  maximumPixelsPerSecond?: number;
  pendingFrame: Pick<WaveformZoomFrame, "pixelsPerSecond" | "scrollLeft"> | null;
  scrollLeft: number;
  viewportWidth: number;
}) {
  const base = args.pendingFrame ?? {
    pixelsPerSecond: args.currentPixelsPerSecond,
    scrollLeft: args.scrollLeft,
  };

  return resolveWaveformZoomFrame({
    anchorViewportX: args.anchorViewportX,
    currentPixelsPerSecond: base.pixelsPerSecond,
    deltaY: args.deltaY,
    durationMs: args.durationMs,
    maximumPixelsPerSecond: args.maximumPixelsPerSecond,
    scrollLeft: base.scrollLeft,
    viewportWidth: args.viewportWidth,
  });
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

  return currentIndex >= 0 && currentIndex < levels.length - 1 ? levels[currentIndex + 1] : null;
}

export function resolveWaveformRenderScale(args: {
  pixelsPerSecond: number;
  renderPixelsPerSecond: number;
}) {
  return args.pixelsPerSecond / Math.max(1, args.renderPixelsPerSecond);
}

export function resolveWaveformBarWidthPx() {
  return 1;
}

export function resolveWaveformDataWindow(args: {
  contentWidth: number;
  overscanPx: number;
  scrollLeft: number;
  viewportWidth: number;
}): WaveformDataWindow {
  const contentWidth = Math.max(1, Math.ceil(args.contentWidth));
  const startPx = clampInteger(
    Math.floor(args.scrollLeft - Math.max(0, args.overscanPx)),
    0,
    contentWidth - 1,
  );
  const endPx = clampInteger(
    Math.ceil(args.scrollLeft + args.viewportWidth + Math.max(0, args.overscanPx)),
    startPx + 1,
    contentWidth,
  );

  return { endPx, startPx };
}

export function resolveWaveformDataTileIndexes(args: {
  tileWidth: number;
  window: WaveformDataWindow;
}) {
  const tileWidth = Math.max(1, Math.ceil(args.tileWidth));
  const startIndex = Math.floor(args.window.startPx / tileWidth);
  const endIndex = Math.max(startIndex, Math.ceil(args.window.endPx / tileWidth) - 1);
  const indexes: number[] = [];

  for (let index = startIndex; index <= endIndex; index += 1) {
    indexes.push(index);
  }

  return indexes;
}

export function createWaveformDataScopeKey(args: {
  filePath: string | null;
  summary: TrackWaveformSummary;
}) {
  return [normalizeWaveformPathKey(args.filePath), args.summary.cache_key].join("|");
}

export function createWaveformDataRequestKey(args: {
  pixelsPerSecond: number;
  scopeKey: string;
  startPx: number;
  widthPx: number;
}) {
  return [
    args.scopeKey,
    roundWaveformDataPixelsPerSecondForKey(args.pixelsPerSecond).toFixed(2),
    Math.max(0, Math.floor(args.startPx)),
    Math.max(1, Math.ceil(args.widthPx)),
  ].join("|");
}

export function resolveWaveformDataPlan(args: {
  contentWidth: number;
  filePath: string | null;
  focusSeconds: number | null;
  mode?: WaveformDataPlanMode;
  pixelsPerSecond: number;
  scrollLeft: number;
  summary: TrackWaveformSummary;
  tileWidth?: number;
  viewportWidth: number;
}): WaveformDataPlan {
  const tileWidth = Math.max(1, Math.ceil(args.tileWidth ?? WAVEFORM_DATA_TILE_WIDTH));
  const displayPixelsPerSecond = Math.max(1, args.pixelsPerSecond);
  const dataPixelsPerSecond = resolveWaveformRenderPixelsPerSecond({
    pixelsPerSecond: displayPixelsPerSecond,
    summary: args.summary,
  });
  const mode = args.mode ?? "settled";
  const renderLevels = resolveWaveformSortedRenderLevels(args.summary);
  const scopeKey = createWaveformDataScopeKey(args);
  const durationSeconds = Math.max(0, args.summary.duration_ms) / 1000;
  const dataContentWidth = Math.max(1, Math.ceil(durationSeconds * dataPixelsPerSecond));
  const overscanViewports = mode === "settled" ? WAVEFORM_DATA_OVERSCAN_VIEWPORTS : 0;
  const guardViewports = mode === "interactive" ? WAVEFORM_INTERACTIVE_GUARD_VIEWPORTS : 0;
  const visiblePrefetchLevelCount =
    mode === "settled" ? WAVEFORM_DATA_PREFETCH_VISIBLE_LEVEL_COUNT : 0;
  const focusPrefetchLevelCount = mode === "settled" ? WAVEFORM_DATA_PREFETCH_FOCUS_LEVEL_COUNT : 0;
  const reversePrefetchLevelCount =
    mode === "settled" ? WAVEFORM_DATA_PREFETCH_REVERSE_LEVEL_COUNT : 0;
  const visibleSecondsWindow = resolveWaveformVisibleSecondsWindow({
    durationSeconds,
    overscanViewports: 0,
    pixelsPerSecond: displayPixelsPerSecond,
    scrollLeft: args.scrollLeft,
    viewportWidth: args.viewportWidth,
  });
  const overscanSecondsWindow = resolveWaveformVisibleSecondsWindow({
    durationSeconds,
    overscanViewports,
    pixelsPerSecond: displayPixelsPerSecond,
    scrollLeft: args.scrollLeft,
    viewportWidth: args.viewportWidth,
  });
  const dataDemandSecondsWindow = resolveWaveformVisibleSecondsWindow({
    durationSeconds,
    overscanViewports: Math.max(overscanViewports, guardViewports),
    pixelsPerSecond: displayPixelsPerSecond,
    scrollLeft: args.scrollLeft,
    viewportWidth: args.viewportWidth,
  });
  const visibleWindow = resolveWaveformDataPixelWindow({
    dataContentWidth,
    dataPixelsPerSecond,
    window: visibleSecondsWindow,
  });
  const overscanWindow = resolveWaveformDataPixelWindow({
    dataContentWidth,
    dataPixelsPerSecond,
    window: overscanSecondsWindow,
  });
  const dataDemandWindow = resolveWaveformDataPixelWindow({
    dataContentWidth,
    dataPixelsPerSecond,
    window: dataDemandSecondsWindow,
  });
  const visibleIndexSet = new Set(
    resolveWaveformDataTileIndexes({
      tileWidth,
      window: visibleWindow,
    }),
  );
  const focusSeconds =
    typeof args.focusSeconds === "number" && Number.isFinite(args.focusSeconds)
      ? clampNumber(args.focusSeconds, 0, durationSeconds)
      : (visibleSecondsWindow.startSeconds + visibleSecondsWindow.endSeconds) / 2;
  const currentLevelRequests = resolveWaveformCurrentDemandRequests({
    dataPixelsPerSecond,
    dataDemandWindow,
    focusSeconds,
    mode,
    scopeKey,
    tileWidth,
    visibleIndexSet,
    durationSeconds,
  });
  const visiblePrefetchRequests = resolveWaveformVisiblePrefetchRequests({
    currentDataPixelsPerSecond: dataPixelsPerSecond,
    durationSeconds,
    focusSeconds,
    levelCount: visiblePrefetchLevelCount,
    levels: renderLevels,
    scopeKey,
    tileWidth,
    visibleSecondsWindow,
  });
  const focusPrefetchRequests = resolveWaveformFocusPrefetchRequests({
    currentDataPixelsPerSecond: dataPixelsPerSecond,
    durationSeconds,
    focusSeconds,
    levelCount: focusPrefetchLevelCount,
    levels: renderLevels,
    scopeKey,
    tileWidth,
  });
  const reversePrefetchRequests = resolveWaveformReversePrefetchRequests({
    currentDataPixelsPerSecond: dataPixelsPerSecond,
    durationSeconds,
    focusSeconds,
    levelCount: reversePrefetchLevelCount,
    levels: renderLevels,
    scopeKey,
    tileWidth,
    visibleSecondsWindow,
  });
  const requests = dedupeWaveformDataRequests([
    ...currentLevelRequests,
    ...focusPrefetchRequests,
    ...visiblePrefetchRequests,
    ...reversePrefetchRequests,
  ]).sort(compareWaveformDataRequests);
  const protectedCacheKeys = resolveWaveformProtectedCacheKeys({
    currentDataPixelsPerSecond: dataPixelsPerSecond,
    durationSeconds,
    focusSeconds,
    levels: renderLevels,
    scopeKey,
    tileWidth,
    visibleSecondsWindow,
  });

  return {
    dataContentWidth,
    dataPixelsPerSecond,
    mode,
    overscanSecondsWindow,
    overscanWindow,
    protectedCacheKeys,
    requests,
    scopeKey,
    visibleIndexes: Array.from(visibleIndexSet).sort((left, right) => left - right),
    visibleSecondsWindow,
    visibleWindow,
  };
}

function resolveWaveformCurrentDemandRequests(args: {
  dataDemandWindow: WaveformDataWindow;
  dataPixelsPerSecond: number;
  durationSeconds: number;
  focusSeconds: number;
  mode: WaveformDataPlanMode;
  scopeKey: string;
  tileWidth: number;
  visibleIndexSet: ReadonlySet<number>;
}) {
  return createWaveformDataRequestsForLevel({
    dataPixelsPerSecond: args.dataPixelsPerSecond,
    durationSeconds: args.durationSeconds,
    focusSeconds: args.focusSeconds,
    priorityForIndex: (index) =>
      args.visibleIndexSet.has(index)
        ? "visible"
        : args.mode === "interactive"
          ? "visible-guard"
          : "overscan",
    scopeKey: args.scopeKey,
    tileWidth: args.tileWidth,
    window: args.dataDemandWindow,
  });
}

function resolveWaveformVisiblePrefetchRequests(args: {
  currentDataPixelsPerSecond: number;
  durationSeconds: number;
  focusSeconds: number;
  levelCount: number;
  levels: readonly number[];
  scopeKey: string;
  tileWidth: number;
  visibleSecondsWindow: WaveformSecondsWindow;
}) {
  return resolveWaveformPrefetchRenderLevels({
    currentDataPixelsPerSecond: args.currentDataPixelsPerSecond,
    levelCount: args.levelCount,
    levels: args.levels,
  }).flatMap((prefetchLevel, lodDepth) =>
    createWaveformDataRequestsForLevel({
      dataPixelsPerSecond: prefetchLevel,
      durationSeconds: args.durationSeconds,
      focusSeconds: args.focusSeconds,
      lodDepth: lodDepth + 1,
      priorityForIndex: () => "prefetch-visible",
      scopeKey: args.scopeKey,
      tileWidth: args.tileWidth,
      window: resolveWaveformDataPixelWindow({
        dataContentWidth: Math.max(1, Math.ceil(args.durationSeconds * prefetchLevel)),
        dataPixelsPerSecond: prefetchLevel,
        window: args.visibleSecondsWindow,
      }),
    }),
  );
}

function resolveWaveformFocusPrefetchRequests(args: {
  currentDataPixelsPerSecond: number;
  durationSeconds: number;
  focusSeconds: number;
  levelCount: number;
  levels: readonly number[];
  scopeKey: string;
  tileWidth: number;
}) {
  return resolveWaveformPrefetchRenderLevels({
    currentDataPixelsPerSecond: args.currentDataPixelsPerSecond,
    levelCount: args.levelCount,
    levels: args.levels,
  }).flatMap((prefetchLevel, lodDepth) => {
    const focusWindow = resolveWaveformFocusedPrefetchWindow({
      dataContentWidth: Math.max(1, Math.ceil(args.durationSeconds * prefetchLevel)),
      focusSeconds: args.focusSeconds,
      pixelsPerSecond: prefetchLevel,
      tileWidth: args.tileWidth,
    });

    return createWaveformDataRequestsForLevel({
      dataPixelsPerSecond: prefetchLevel,
      durationSeconds: args.durationSeconds,
      focusSeconds: args.focusSeconds,
      lodDepth: lodDepth + 1,
      priorityForIndex: () => "prefetch-focus",
      scopeKey: args.scopeKey,
      tileWidth: args.tileWidth,
      window: focusWindow,
    });
  });
}

function resolveWaveformReversePrefetchRequests(args: {
  currentDataPixelsPerSecond: number;
  durationSeconds: number;
  focusSeconds: number;
  levelCount: number;
  levels: readonly number[];
  scopeKey: string;
  tileWidth: number;
  visibleSecondsWindow: WaveformSecondsWindow;
}) {
  return resolveWaveformReversePrefetchRenderLevels({
    currentDataPixelsPerSecond: args.currentDataPixelsPerSecond,
    levelCount: args.levelCount,
    levels: args.levels,
  }).flatMap((prefetchLevel, lodDepth) =>
    createWaveformDataRequestsForLevel({
      dataPixelsPerSecond: prefetchLevel,
      durationSeconds: args.durationSeconds,
      focusSeconds: args.focusSeconds,
      lodDepth: lodDepth + 1,
      priorityForIndex: () => "prefetch-reverse",
      scopeKey: args.scopeKey,
      tileWidth: args.tileWidth,
      window: resolveWaveformDataPixelWindow({
        dataContentWidth: Math.max(1, Math.ceil(args.durationSeconds * prefetchLevel)),
        dataPixelsPerSecond: prefetchLevel,
        window: args.visibleSecondsWindow,
      }),
    }),
  );
}

function resolveWaveformProtectedCacheKeys(args: {
  currentDataPixelsPerSecond: number;
  durationSeconds: number;
  focusSeconds: number;
  levels: readonly number[];
  scopeKey: string;
  tileWidth: number;
  visibleSecondsWindow: WaveformSecondsWindow;
}) {
  return createWaveformReverseCacheRequests(args).map((request) => request.cacheKey);
}

export function resolveWaveformTransaction(args: {
  lastInteractiveDataDemand: WaveformInteractiveDataDemand | null;
  mode: WaveformDataPlanMode;
  now: number;
  plan: WaveformDataPlan | null;
}): WaveformTransactionResolution {
  const dataDemandSignature = args.plan
    ? createWaveformDataPlanSignature(args.plan, "visible")
    : null;
  const shouldSkipInteractiveDemand =
    args.mode === "interactive" &&
    args.lastInteractiveDataDemand !== null &&
    dataDemandSignature === args.lastInteractiveDataDemand.signature &&
    args.now - args.lastInteractiveDataDemand.at < WAVEFORM_INTERACTIVE_DATA_DEMAND_INTERVAL_MS;
  const nextInteractiveDataDemand =
    args.mode === "settled"
      ? null
      : shouldSkipInteractiveDemand
        ? args.lastInteractiveDataDemand
        : {
            at: args.now,
            signature: dataDemandSignature,
          };

  return {
    nextInteractiveDataDemandAt: nextInteractiveDataDemand?.at ?? null,
    nextInteractiveDataDemand,
    transaction: {
      dataDemand: {
        plan: args.plan,
        scope: "visible",
        skipped: shouldSkipInteractiveDemand,
      },
      mode: args.mode,
      presentation: {
        plan: args.plan,
      },
      shouldScheduleCompleteData: args.mode === "settled" && args.plan !== null,
    },
  };
}

export function resolveWaveformSelectionGeometry(args: {
  selection: WaveformSelectionRange | null;
  viewport: WaveformViewportModel;
}): WaveformSelectionGeometry {
  const durationSeconds = Math.max(0, args.viewport.durationMs) / 1000;
  const startSeconds = normalizeWaveformSelectionBoundary(args.selection?.start ?? null);
  const endSeconds = normalizeWaveformSelectionBoundary(args.selection?.end ?? null);

  if (
    startSeconds === null ||
    endSeconds === null ||
    durationSeconds <= 0 ||
    endSeconds <= startSeconds
  ) {
    return {
      endX: args.viewport.viewportWidth,
      isComplete: false,
      startX: 0,
    };
  }

  return {
    endX: secondsToWaveformViewportX({
      seconds: clampNumber(endSeconds, 0, durationSeconds),
      viewport: args.viewport,
    }),
    isComplete: true,
    startX: secondsToWaveformViewportX({
      seconds: clampNumber(startSeconds, 0, durationSeconds),
      viewport: args.viewport,
    }),
  };
}

export function areWaveformSelectionsEqual(
  left: WaveformSelectionRange | null,
  right: WaveformSelectionRange | null,
) {
  return left?.start === right?.start && left?.end === right?.end;
}

export function resolveWaveformSelectionDrag(args: {
  edge: WaveformSelectionEdge;
  selection: WaveformSelectionRange | null;
  pointerClientX: number;
  viewport: WaveformViewportModel;
  hostRect: Pick<DOMRect, "left">;
}): WaveformSelectionDragResolution {
  const durationSeconds = Math.max(0, args.viewport.durationMs) / 1000;
  const currentStart = normalizeWaveformSelectionBoundary(args.selection?.start ?? null) ?? 0;
  const currentEnd =
    normalizeWaveformSelectionBoundary(args.selection?.end ?? null) ?? durationSeconds;
  const pointerSeconds = clampNumber(
    (args.viewport.scrollLeft + args.pointerClientX - args.hostRect.left) /
      Math.max(1, args.viewport.pixelsPerSecond),
    0,
    durationSeconds,
  );
  const boundary = normalizeWaveformSelectionBoundary(pointerSeconds) ?? 0;
  const rangeStart = Math.min(currentStart, currentEnd);
  const rangeEnd = Math.max(currentStart, currentEnd);

  if (args.edge === "start") {
    return {
      start: clampNumber(boundary, 0, rangeEnd),
      end: rangeEnd,
    };
  }

  return {
    start: rangeStart,
    end: clampNumber(boundary, rangeStart, durationSeconds),
  };
}

export function resolveWaveformPlayheadDrag(args: {
  hostRect: Pick<DOMRect, "left" | "width">;
  pointerClientX: number;
  selection: WaveformSelectionRange | null;
  viewport: WaveformViewportModel;
}): WaveformPlayheadDragResolution | null {
  const startSeconds = normalizeWaveformSelectionBoundary(args.selection?.start ?? null);
  const endSeconds = normalizeWaveformSelectionBoundary(args.selection?.end ?? null);
  if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) {
    return null;
  }

  const viewportX = clampNumber(args.pointerClientX - args.hostRect.left, 0, args.hostRect.width);
  const targetSeconds = clampNumber(
    (args.viewport.scrollLeft + viewportX) / Math.max(1, args.viewport.pixelsPerSecond),
    startSeconds,
    endSeconds,
  );

  return {
    endMs: Math.round(endSeconds * 1_000),
    positionMs: Math.round(targetSeconds * 1_000),
  };
}

function secondsToWaveformViewportX(args: { seconds: number; viewport: WaveformViewportModel }) {
  return args.seconds * args.viewport.pixelsPerSecond - args.viewport.scrollLeft;
}

export function resolveWaveformDataPlanScopedRequests(
  plan: WaveformDataPlan,
  scope: WaveformDataPlanScope,
) {
  return scope === "visible"
    ? plan.requests.filter((request) => isWaveformVisibleDemandPriority(request.priority))
    : plan.requests;
}

export function shouldPresentWaveformTileAvailability(priority: WaveformDataRequestPriority) {
  switch (priority) {
    case "visible":
    case "visible-guard":
    case "prefetch-reverse":
      return true;
    case "prefetch-focus":
    case "prefetch-visible":
    case "overscan":
      return false;
  }
}

function resolveWaveformPrefetchRenderLevels(args: {
  currentDataPixelsPerSecond: number;
  levelCount: number;
  levels: readonly number[];
}) {
  if (args.levelCount <= 0) {
    return [];
  }

  return args.levels
    .filter((level) => level > args.currentDataPixelsPerSecond)
    .slice(0, args.levelCount);
}

function resolveWaveformReversePrefetchRenderLevels(args: {
  currentDataPixelsPerSecond: number;
  levelCount: number;
  levels: readonly number[];
}) {
  if (args.levelCount <= 0) {
    return [];
  }

  return args.levels
    .filter((level) => level < args.currentDataPixelsPerSecond)
    .sort((left, right) => right - left)
    .slice(0, args.levelCount);
}

function createWaveformDataRequestsForLevel(args: {
  dataPixelsPerSecond: number;
  durationSeconds: number;
  focusSeconds: number;
  lodDepth?: number;
  priorityForIndex: (index: number) => WaveformDataRequestPriority;
  scopeKey: string;
  tileWidth: number;
  window: WaveformDataWindow;
}): WaveformDataRequest[] {
  const dataPixelsPerSecond = Math.max(1, args.dataPixelsPerSecond);
  const dataContentWidth = Math.max(1, Math.ceil(args.durationSeconds * dataPixelsPerSecond));
  const focusPx = args.focusSeconds * dataPixelsPerSecond;

  return resolveWaveformDataTileIndexes({
    tileWidth: args.tileWidth,
    window: args.window,
  }).map((index) => {
    const startPx = index * args.tileWidth;
    const widthPx = Math.max(1, Math.min(args.tileWidth, dataContentWidth - startPx));

    return {
      cacheKey: createWaveformDataRequestKey({
        pixelsPerSecond: dataPixelsPerSecond,
        scopeKey: args.scopeKey,
        startPx,
        widthPx,
      }),
      dataPixelsPerSecond,
      endPx: startPx + widthPx,
      focusDistancePx: Math.abs(startPx + widthPx / 2 - focusPx),
      index,
      lodDepth: args.lodDepth ?? 0,
      priority: args.priorityForIndex(index),
      scopeKey: args.scopeKey,
      startPx,
      widthPx,
    };
  });
}

function resolveWaveformFocusedPrefetchWindow(args: {
  dataContentWidth: number;
  focusSeconds: number;
  pixelsPerSecond: number;
  tileWidth: number;
}): WaveformDataWindow {
  const dataContentWidth = Math.max(1, Math.ceil(args.dataContentWidth));
  const tileWidth = Math.max(1, Math.ceil(args.tileWidth));
  const focusPx = clampInteger(
    Math.floor(args.focusSeconds * Math.max(1, args.pixelsPerSecond)),
    0,
    dataContentWidth - 1,
  );
  const startPx = Math.floor(focusPx / tileWidth) * tileWidth;

  return {
    endPx: Math.min(dataContentWidth, startPx + tileWidth),
    startPx,
  };
}

function createWaveformReverseCacheRequests(args: {
  currentDataPixelsPerSecond: number;
  durationSeconds: number;
  focusSeconds: number;
  levels: readonly number[];
  scopeKey: string;
  tileWidth: number;
  visibleSecondsWindow: WaveformSecondsWindow;
}) {
  return args.levels
    .filter((level) => level <= args.currentDataPixelsPerSecond)
    .flatMap((level) =>
      createWaveformDataRequestsForLevel({
        dataPixelsPerSecond: level,
        durationSeconds: args.durationSeconds,
        focusSeconds: args.focusSeconds,
        priorityForIndex: () => "visible",
        scopeKey: args.scopeKey,
        tileWidth: args.tileWidth,
        window: resolveWaveformDataPixelWindow({
          dataContentWidth: Math.max(1, Math.ceil(args.durationSeconds * level)),
          dataPixelsPerSecond: level,
          window: args.visibleSecondsWindow,
        }),
      }),
    );
}

function dedupeWaveformDataRequests(requests: WaveformDataRequest[]) {
  const byKey = new Map<string, WaveformDataRequest>();

  for (const request of requests) {
    const existing = byKey.get(request.cacheKey);
    if (!existing || compareWaveformDataRequests(request, existing) < 0) {
      byKey.set(request.cacheKey, request);
    }
  }

  return Array.from(byKey.values());
}

function compareWaveformDataRequests(left: WaveformDataRequest, right: WaveformDataRequest) {
  return (
    resolveWaveformDataRequestPriorityRank(left.priority) -
      resolveWaveformDataRequestPriorityRank(right.priority) ||
    left.lodDepth - right.lodDepth ||
    left.focusDistancePx - right.focusDistancePx ||
    left.index - right.index ||
    left.dataPixelsPerSecond - right.dataPixelsPerSecond
  );
}

function resolveWaveformDataRequestPriorityRank(priority: WaveformDataRequestPriority) {
  switch (priority) {
    case "visible":
      return 0;
    case "visible-guard":
      return 1;
    case "prefetch-reverse":
      return 2;
    case "prefetch-focus":
      return 3;
    case "prefetch-visible":
      return 4;
    case "overscan":
      return 5;
  }

  return 5;
}

function isWaveformVisibleDemandPriority(priority: WaveformDataRequestPriority) {
  return priority === "visible" || priority === "visible-guard" || priority === "prefetch-reverse";
}

export function resolveQuantizedWaveformDisplayPeak(args: {
  max: readonly number[];
  min: readonly number[];
  offset: number;
}) {
  const offset = clampInteger(args.offset, 0, Math.min(args.min.length, args.max.length) - 1);

  return {
    max: sanitizeQuantizedPeakValue(args.max[offset]) / 127,
    min: sanitizeQuantizedPeakValue(args.min[offset]) / 127,
  };
}

export function resolveWaveformTilePeakRangeAtPixels(args: {
  endPx: number;
  startPx: number;
  tile: Pick<TrackWaveformTile, "max" | "min" | "start_px">;
}): WaveformPeakSample | null {
  const tilePointCount = Math.min(args.tile.min.length, args.tile.max.length);
  if (tilePointCount <= 0) {
    return null;
  }

  const tileStartPx = args.tile.start_px;
  const tileEndPx = tileStartPx + tilePointCount;
  const startPx = Math.max(args.startPx, tileStartPx);
  const endPx = Math.min(args.endPx, tileEndPx);
  if (endPx <= startPx) {
    return null;
  }

  const startOffset = clampInteger(Math.floor(startPx) - tileStartPx, 0, tilePointCount - 1);
  const endOffset = clampInteger(Math.ceil(endPx) - tileStartPx, startOffset + 1, tilePointCount);
  let min = 1;
  let max = -1;

  for (let offset = startOffset; offset < endOffset; offset += 1) {
    min = Math.min(min, sanitizeQuantizedPeakValue(args.tile.min[offset]) / 127);
    max = Math.max(max, sanitizeQuantizedPeakValue(args.tile.max[offset]) / 127);
  }

  return max < min ? null : { max, min };
}

export function resolveWaveformTileIndexPeakRangeAtPixels(args: {
  endPx: number;
  startPx: number;
  tileWidth: number;
  tilesByIndex: ReadonlyMap<number, Pick<TrackWaveformTile, "max" | "min" | "start_px">>;
}): WaveformPeakSample | null {
  const startPx = Math.max(0, Math.floor(args.startPx));
  const endPx = Math.max(startPx + 1, Math.ceil(args.endPx));
  const tileWidth = Math.max(1, Math.ceil(args.tileWidth));
  const startIndex = Math.floor(startPx / tileWidth);
  const endIndex = Math.floor((endPx - 1) / tileWidth);
  let min = 1;
  let max = -1;
  let found = false;

  for (let tileIndex = startIndex; tileIndex <= endIndex; tileIndex += 1) {
    const tile = args.tilesByIndex.get(tileIndex);
    if (!tile) {
      continue;
    }

    const tilePeak = resolveWaveformTilePeakRangeAtPixels({
      endPx,
      startPx,
      tile,
    });

    if (!tilePeak) {
      continue;
    }

    min = Math.min(min, tilePeak.min);
    max = Math.max(max, tilePeak.max);
    found = true;
  }

  return found ? { max, min } : null;
}

export function resolveWaveformTilePeakAtSeconds(args: {
  pixelsPerSecond: number;
  seconds: number;
  tile: Pick<TrackWaveformTile, "max" | "min" | "start_px">;
}) {
  const pixelX = Math.floor(Math.max(0, args.seconds) * Math.max(1, args.pixelsPerSecond));
  const offset = pixelX - args.tile.start_px;

  if (offset < 0 || offset >= Math.min(args.tile.min.length, args.tile.max.length)) {
    return null;
  }

  return resolveQuantizedWaveformDisplayPeak({
    max: args.tile.max,
    min: args.tile.min,
    offset,
  });
}

export function resolveWaveformPeakRange(args: {
  peaks: readonly WaveformPeak[];
  pixelX: number;
  pixelsPerSecond: number;
  pointsPerSecond: number;
  scrollLeft: number;
}) {
  const peakCount = args.peaks.length;
  if (peakCount === 0 || args.pointsPerSecond <= 0 || args.pixelsPerSecond <= 0) {
    return { max: 0, min: 0 };
  }

  const pixelStartSeconds = (args.scrollLeft + args.pixelX) / args.pixelsPerSecond;
  const pixelEndSeconds = (args.scrollLeft + args.pixelX + 1) / args.pixelsPerSecond;
  const startIndex = clampInteger(
    Math.floor(pixelStartSeconds * args.pointsPerSecond),
    0,
    peakCount - 1,
  );
  const endIndex = clampInteger(
    Math.ceil(pixelEndSeconds * args.pointsPerSecond),
    startIndex + 1,
    peakCount,
  );
  let min = 1;
  let max = -1;

  for (let index = startIndex; index < endIndex; index += 1) {
    const peak = args.peaks[index];
    if (!peak) {
      continue;
    }

    min = Math.min(min, sanitizePeakValue(peak.min));
    max = Math.max(max, sanitizePeakValue(peak.max));
  }

  return max < min ? { max: 0, min: 0 } : { max, min };
}

export function resolvePlaybackPositionMs(args: {
  durationMs: number;
  nowMs: number;
  snapshot: PlaybackSnapshot | null;
}) {
  const snapshot = args.snapshot;
  if (!snapshot) {
    return null;
  }

  const elapsedMs = snapshot.playing && !snapshot.paused ? args.nowMs - snapshot.received_at_ms : 0;

  return clampNumber(snapshot.position_ms + elapsedMs, 0, Math.max(0, args.durationMs));
}

export function resolvePlaybackSnapshotDurationMs(args: {
  fallbackDurationMs: number;
  snapshot: PlaybackSnapshot | null;
}) {
  const playbackStartMs = args.snapshot?.playback_start_ms;
  const playbackEndMs = args.snapshot?.playback_end_ms;
  if (
    typeof playbackStartMs === "number" &&
    Number.isFinite(playbackStartMs) &&
    typeof playbackEndMs === "number" &&
    Number.isFinite(playbackEndMs) &&
    playbackEndMs > playbackStartMs
  ) {
    return playbackEndMs - playbackStartMs;
  }

  const snapshotDurationMs = args.snapshot?.duration_ms;
  if (typeof snapshotDurationMs === "number" && Number.isFinite(snapshotDurationMs)) {
    return snapshotDurationMs;
  }

  return args.fallbackDurationMs;
}

export function resolveWaveformPlayheadX(args: {
  playbackStartMs: number | null;
  pixelsPerSecond: number;
  positionMs: number | null;
  scrollLeft: number;
}) {
  if (args.positionMs === null || args.playbackStartMs === null) {
    return null;
  }

  const playbackStartSeconds = normalizeWaveformSelectionBoundary(args.playbackStartMs / 1000);
  if (playbackStartSeconds === null) {
    return null;
  }

  const filePositionSeconds = playbackStartSeconds + args.positionMs / 1000;

  return filePositionSeconds * args.pixelsPerSecond - args.scrollLeft;
}

export function resolveWaveformPlayheadStyle(args: {
  playbackStartMs: number | null;
  pixelsPerSecond: number;
  positionMs: number | null;
  scrollLeft: number;
  viewportWidth: number;
}) {
  const playheadX = resolveWaveformPlayheadX({
    playbackStartMs: args.playbackStartMs,
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

export function createWaveformSharedTileCacheForFile(args: {
  filePath: string | null | undefined;
  store?: WaveformRenderDataStore;
}) {
  return resolveWaveformSharedTileCache({
    fileKey: normalizeWaveformPathKey(args.filePath),
    store: args.store ?? defaultWaveformRenderDataStore,
  });
}

function resolveWaveformSharedTileCache(args: { fileKey: string; store: WaveformRenderDataStore }) {
  if (!args.fileKey) {
    return new Map<string, WaveformCachedTile>();
  }

  const existing = args.store.tileCaches.get(args.fileKey);
  if (existing) {
    return existing;
  }

  const cache = new Map<string, WaveformCachedTile>();
  args.store.tileCaches.set(args.fileKey, cache);

  return cache;
}

export function resolveWaveformLoadingGridSize(args: {
  height: number;
  width: number;
}): WaveformLoadingGridSize {
  const width = Number.isFinite(args.width) ? Math.max(0, args.width) : 0;
  const height = Number.isFinite(args.height) ? Math.max(0, args.height) : 0;
  const fieldWidth = Math.max(WAVEFORM_LOADING_MIN_FIELD_WIDTH_PX, Math.floor(width));
  const fieldHeight = clampNumber(
    Math.floor(height * 0.52),
    WAVEFORM_LOADING_MIN_FIELD_HEIGHT_PX,
    WAVEFORM_LOADING_MAX_FIELD_HEIGHT_PX,
  );

  return {
    columns: Math.max(8, Math.floor(fieldWidth / WAVEFORM_LOADING_DOT_PITCH_PX)),
    rows: clampInteger(Math.floor(fieldHeight / WAVEFORM_LOADING_DOT_PITCH_PX), 4, 12),
  };
}

export function TrackSpectrum(props: {
  className?: string;
  filePath: string | null;
  onSelectionCommit?: (range: WaveformSelectionDragResolution) => void;
  playheadEnabled?: boolean;
  ports?: TrackSpectrumPorts;
  renderDataStore?: WaveformRenderDataStore;
  selection?: WaveformSelectionRange | null;
}) {
  const identity = normalizeWaveformPathKey(props.filePath);

  return <TrackSpectrumSession key={identity} {...props} />;
}

function TrackSpectrumSession(props: {
  className?: string;
  filePath: string | null;
  onSelectionCommit?: (range: WaveformSelectionDragResolution) => void;
  playheadEnabled?: boolean;
  ports?: TrackSpectrumPorts;
  renderDataStore?: WaveformRenderDataStore;
  selection?: WaveformSelectionRange | null;
}) {
  const placeholderSummary = useMemo(() => createPlaceholderWaveformSummary(), []);
  const ports = props.ports ?? crabTrackSpectrumPorts;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<WaveformViewportModel | null>(null);
  const selectionRef = useRef<WaveformSelectionRange | null>(props.selection ?? null);
  const initialSelectionViewportAnchorRef = useRef<string | null>(null);
  const commitViewportRef = useRef<WaveformViewportCommit | null>(null);
  const completeDataPlanTimerRef = useRef<number | null>(null);
  const viewportSettledEffectsTimerRef = useRef<number | null>(null);
  const lastInteractiveDataDemandRef = useRef<WaveformInteractiveDataDemand | null>(null);
  const zoomOwnershipRef = useRef<WaveformZoomOwnership>("initial-minimum");
  const renderDataStore = props.renderDataStore ?? resolveWaveformSharedDataStore(ports.waveform);
  const sharedFileKey = normalizeWaveformPathKey(props.filePath);
  const tileCacheRef = useMemo<RefObject<Map<string, WaveformCachedTile>>>(
    () => ({
      current: resolveWaveformSharedTileCache({
        fileKey: sharedFileKey,
        store: renderDataStore,
      }),
    }),
    [renderDataStore, sharedFileKey],
  );
  const [loadingGridSize, setLoadingGridSize] = useState<WaveformLoadingGridSize>(() =>
    resolveWaveformLoadingGridSize({
      height: WAVEFORM_CANVAS_HEIGHT,
      width: WAVEFORM_LOADING_MIN_FIELD_WIDTH_PX,
    }),
  );
  const waveformState = useTrackWaveformSummary({
    filePath: props.filePath,
    placeholderSummary,
    renderDataStore,
    waveformPort: ports.waveform,
  });
  const maximumPixelsPerSecond = resolveWaveformRenderPixelsPerSecond({
    summary: waveformState.summary,
  });
  if (viewportRef.current === null) {
    const viewportWidth = 1;
    const pixelsPerSecond = resolveWaveformZoomOwnedPixelsPerSecond({
      durationMs: waveformState.summary.duration_ms,
      maximumPixelsPerSecond,
      ownership: zoomOwnershipRef.current,
      pixelsPerSecond: WAVEFORM_FALLBACK_PIXELS_PER_SECOND,
      viewportWidth,
    });
    const contentWidth = resolveWaveformContentWidth({
      durationMs: waveformState.summary.duration_ms,
      pixelsPerSecond,
      viewportWidth,
    });
    const scrollLeft = resolveWaveformSelectionStartScrollLeft({
      contentWidth,
      leadingSpacePx: WAVEFORM_SELECTION_START_LEADING_SPACE_PX,
      pixelsPerSecond,
      selection: props.selection ?? null,
      viewportWidth,
    });
    viewportRef.current = resolveWaveformViewportModel({
      durationMs: waveformState.summary.duration_ms,
      focusSeconds: null,
      maximumPixelsPerSecond,
      pixelsPerSecond,
      scrollLeft,
      viewportWidth,
    });
  }

  const drawCanvas = useWaveformCanvasRenderer({
    canvasRef,
    filePath: props.filePath?.trim() || null,
    status: waveformState.status,
    summary: waveformState.summary,
    tileCacheRef,
    viewportRef,
  });
  const requestDataPlan = useWaveformDataLoader({
    filePath: props.filePath?.trim() || null,
    onTileAvailable: drawCanvas,
    status: waveformState.status,
    tileCacheRef,
    tilePromiseStore: renderDataStore.tilePromises,
    waveformPort: ports.waveform,
  });
  const playheadController = useWaveformPlayheadController({
    enabled: props.playheadEnabled === true,
    filePath: props.filePath?.trim() || null,
    hostRef,
    playbackPort: ports.playback,
    selectionRef,
    summary: waveformState.summary,
    viewportRef,
  });
  const shouldShowLoadingGrid = waveformState.status === "loading";
  const externalSelection = props.selection ?? null;
  const previousExternalSelectionRef = useRef<WaveformSelectionRange | null>(externalSelection);
  const isSelectionDragActiveRef = useRef(false);
  if (
    !isSelectionDragActiveRef.current &&
    !areWaveformSelectionsEqual(previousExternalSelectionRef.current, externalSelection)
  ) {
    selectionRef.current = externalSelection;
    previousExternalSelectionRef.current = externalSelection;
  }

  const selectionPresentationRef = useRef({
    visible: !shouldShowLoadingGrid,
  });
  selectionPresentationRef.current = {
    visible: !shouldShowLoadingGrid,
  };

  const syncSelectionOverlay = useCallback(() => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (!host || !viewport) {
      return;
    }

    const geometry = resolveWaveformSelectionGeometry({
      selection: selectionRef.current,
      viewport,
    });
    const visible = geometry.isComplete && selectionPresentationRef.current.visible;
    host.style.setProperty("--waveform-selection-opacity", visible ? "1" : "0");
    host.style.setProperty("--waveform-selection-start-x", `${geometry.startX}px`);
    host.style.setProperty("--waveform-selection-end-x", `${geometry.endX}px`);
    host.style.setProperty(
      "--waveform-selection-start-mask-width",
      `${clampNumber(geometry.startX, 0, viewport.viewportWidth)}px`,
    );
    host.style.setProperty(
      "--waveform-selection-end-mask-left",
      `${clampNumber(geometry.endX, 0, viewport.viewportWidth)}px`,
    );
  }, []);
  const resetSelectionPreview = useCallback(() => {
    selectionRef.current = previousExternalSelectionRef.current;
    syncSelectionOverlay();
  }, [syncSelectionOverlay]);

  useWaveformLoadingRenderer({
    canvasRef: loadingCanvasRef,
    gridSize: loadingGridSize,
    visible: shouldShowLoadingGrid,
  });

  const resolveCurrentDataPlan = useCallback(
    (mode: WaveformDataPlanMode) => {
      const viewport = viewportRef.current;
      const filePath = props.filePath?.trim() || null;

      if (waveformState.status !== "ready" || !filePath || !viewport) {
        return null;
      }

      return resolveWaveformDataPlan({
        contentWidth: viewport.contentWidth,
        filePath,
        focusSeconds: viewport.focusSeconds,
        mode,
        pixelsPerSecond: viewport.pixelsPerSecond,
        scrollLeft: viewport.scrollLeft,
        summary: waveformState.summary,
        viewportWidth: viewport.viewportWidth,
      });
    },
    [props.filePath, waveformState.status, waveformState.summary],
  );

  const cancelCompleteDataPlan = useCallback(() => {
    const ownerWindow =
      hostRef.current?.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);

    if (completeDataPlanTimerRef.current !== null && ownerWindow) {
      ownerWindow.clearTimeout(completeDataPlanTimerRef.current);
    }
    completeDataPlanTimerRef.current = null;
  }, []);

  const scheduleCompleteDataPlan = useCallback(() => {
    const ownerWindow =
      hostRef.current?.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);

    if (!ownerWindow) {
      const plan = resolveCurrentDataPlan("settled");
      if (!plan) {
        return;
      }

      requestDataPlan({
        plan,
        scope: "complete",
      });
      return;
    }

    cancelCompleteDataPlan();

    completeDataPlanTimerRef.current = ownerWindow.setTimeout(() => {
      completeDataPlanTimerRef.current = null;
      const plan = resolveCurrentDataPlan("settled");
      if (!plan) {
        return;
      }

      requestDataPlan({
        plan,
        scope: "complete",
      });
    }, WAVEFORM_DATA_IDLE_OVERSCAN_DELAY_MS);
  }, [cancelCompleteDataPlan, requestDataPlan, resolveCurrentDataPlan]);

  const buildWaveformTransaction = useCallback(
    (mode: WaveformDataPlanMode) => {
      const plan = resolveCurrentDataPlan(mode);
      const ownerWindow =
        hostRef.current?.ownerDocument.defaultView ??
        (typeof window === "undefined" ? null : window);
      const now = readWaveformPerformanceNow(ownerWindow);
      const resolution = resolveWaveformTransaction({
        lastInteractiveDataDemand: lastInteractiveDataDemandRef.current,
        mode,
        now,
        plan,
      });

      return resolution;
    },
    [resolveCurrentDataPlan],
  );

  const applyWaveformTransaction = useCallback(
    (resolution: WaveformTransactionResolution) => {
      const transaction = resolution.transaction;
      if (transaction.mode === "interactive") {
        cancelCompleteDataPlan();
      }

      lastInteractiveDataDemandRef.current = resolution.nextInteractiveDataDemand;

      if (transaction.presentation.plan) {
        drawCanvas(transaction.presentation.plan);
      }

      if (!transaction.dataDemand.skipped && transaction.dataDemand.plan) {
        requestDataPlan({
          plan: transaction.dataDemand.plan,
          scope: transaction.dataDemand.scope,
        });
      }

      if (transaction.shouldScheduleCompleteData) {
        scheduleCompleteDataPlan();
      }
    },
    [cancelCompleteDataPlan, drawCanvas, requestDataPlan, scheduleCompleteDataPlan],
  );

  const runViewportEffects = useCallback(
    (mode: WaveformDataPlanMode) => {
      applyWaveformTransaction(buildWaveformTransaction(mode));
    },
    [applyWaveformTransaction, buildWaveformTransaction],
  );
  const clearViewportSettledEffectsTimer = useCallback(() => {
    const ownerWindow =
      hostRef.current?.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);

    if (viewportSettledEffectsTimerRef.current !== null && ownerWindow) {
      ownerWindow.clearTimeout(viewportSettledEffectsTimerRef.current);
    }
    viewportSettledEffectsTimerRef.current = null;
  }, []);
  const scheduleViewportSettledEffects = useCallback(() => {
    clearViewportSettledEffectsTimer();
    const ownerWindow =
      hostRef.current?.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);

    if (!ownerWindow) {
      runViewportEffects("settled");
      return;
    }

    viewportSettledEffectsTimerRef.current = ownerWindow.setTimeout(() => {
      viewportSettledEffectsTimerRef.current = null;
      runViewportEffects("settled");
    }, WAVEFORM_DATA_IDLE_OVERSCAN_DELAY_MS);
  }, [clearViewportSettledEffectsTimer, runViewportEffects]);

  const commitViewportModel = useCallback(
    (next: WaveformViewportState) => {
      const normalizedModel = resolveWaveformViewportModel({
        durationMs: waveformState.summary.duration_ms,
        focusSeconds: next.focusSeconds,
        maximumPixelsPerSecond,
        pixelsPerSecond: next.pixelsPerSecond,
        scrollLeft: next.scrollLeft,
        viewportWidth: next.viewportWidth,
      });
      const previous = viewportRef.current;
      const changed =
        !previous ||
        previous.focusSeconds !== normalizedModel.focusSeconds ||
        Math.abs(previous.pixelsPerSecond - normalizedModel.pixelsPerSecond) >= 0.01 ||
        Math.abs(previous.scrollLeft - normalizedModel.scrollLeft) >= 0.5 ||
        previous.viewportWidth !== normalizedModel.viewportWidth ||
        previous.contentWidth !== normalizedModel.contentWidth ||
        previous.durationMs !== normalizedModel.durationMs ||
        previous.maximumPixelsPerSecond !== normalizedModel.maximumPixelsPerSecond;

      viewportRef.current = normalizedModel;

      playheadController.syncPlayhead();
      syncSelectionOverlay();

      return changed;
    },
    [
      maximumPixelsPerSecond,
      playheadController.syncPlayhead,
      syncSelectionOverlay,
      waveformState.summary.duration_ms,
    ],
  );
  const commitViewport = useCallback(
    (request: WaveformViewportCommitRequest) => {
      if (commitViewportModel(request.state)) {
        runViewportEffects(request.mode ?? "settled");
      }
    },
    [commitViewportModel, runViewportEffects],
  );
  commitViewportRef.current = commitViewport;

  const markZoomExplicit = useCallback(() => {
    zoomOwnershipRef.current = "explicit";
  }, []);

  const queueZoomViewport = useWaveformZoomViewportScheduler({
    cancelViewportSettledEffects: clearViewportSettledEffectsTimer,
    commitViewportModel,
    hostRef,
    markZoomExplicit,
    runViewportEffects,
    scheduleViewportSettledEffects,
  });
  const queueResizeViewport = useWaveformResizeViewportScheduler({
    cancelViewportSettledEffects: clearViewportSettledEffectsTimer,
    commitViewportModel,
    hostRef,
    resolveState: (command) => {
      const current = viewportRef.current;
      if (!current) {
        return null;
      }

      return resolveWaveformResizeViewportState({
        current,
        viewportWidth: command.viewportWidth,
      });
    },
    runViewportEffects,
    scheduleViewportSettledEffects,
  });

  const handleWheel = useCallback(
    (event: Event) => {
      const current = viewportRef.current;
      const wheelEvent = event as WheelEvent;

      if (!current) {
        return;
      }

      handleWaveformViewportWheel({
        commitViewport: (request) => commitViewportRef.current?.(request),
        event: wheelEvent,
        queueZoomViewport,
        viewport: current,
      });
    },
    [queueZoomViewport],
  );

  const handleHardwareHorizontalWheel = useCallback((payload: HardwareHorizontalWheelEvent) => {
    const host = hostRef.current;
    const current = viewportRef.current;
    const accepted = shouldAcceptWaveformHardwareHorizontalWheel({
      clientX: payload.client_x,
      clientY: payload.client_y,
      host,
    });

    if (!accepted) {
      return;
    }

    if (!current) {
      return;
    }

    handleWaveformHardwareHorizontalWheel({
      commitViewport: (request) => commitViewportRef.current?.(request),
      deltaX: payload.delta_x,
      viewport: current,
    });
  }, []);

  useLayoutEffect(() => {
    const current = viewportRef.current;
    if (!current) {
      return;
    }

    const pixelsPerSecond = resolveWaveformZoomOwnedPixelsPerSecond({
      durationMs: waveformState.summary.duration_ms,
      maximumPixelsPerSecond,
      ownership: zoomOwnershipRef.current,
      pixelsPerSecond: current.pixelsPerSecond,
      viewportWidth: current.viewportWidth,
    });
    const changed = commitViewportModel({
      focusSeconds: current.focusSeconds,
      pixelsPerSecond,
      scrollLeft: current.scrollLeft,
      viewportWidth: current.viewportWidth,
    });
    if (changed || waveformState.status === "ready") {
      runViewportEffects("settled");
    }
  }, [
    commitViewportModel,
    maximumPixelsPerSecond,
    runViewportEffects,
    waveformState.summary.cache_key,
    waveformState.summary.duration_ms,
    waveformState.status,
  ]);

  useLayoutEffect(() => {
    const current = viewportRef.current;
    const filePath = props.filePath?.trim() || null;
    const startSeconds = normalizeWaveformSelectionBoundary(selectionRef.current?.start ?? null);
    if (waveformState.status !== "ready" || !current || !filePath || startSeconds === null) {
      return;
    }

    const anchorKey = [
      normalizeWaveformPathKey(filePath),
      waveformState.summary.cache_key,
      startSeconds,
      current.viewportWidth,
    ].join("|");
    if (initialSelectionViewportAnchorRef.current === anchorKey) {
      return;
    }
    initialSelectionViewportAnchorRef.current = anchorKey;

    const scrollLeft = resolveWaveformSelectionStartScrollLeft({
      contentWidth: current.contentWidth,
      leadingSpacePx: WAVEFORM_SELECTION_START_LEADING_SPACE_PX,
      pixelsPerSecond: current.pixelsPerSecond,
      selection: selectionRef.current,
      viewportWidth: current.viewportWidth,
    });

    commitViewport({
      state: {
        focusSeconds: current.focusSeconds,
        pixelsPerSecond: current.pixelsPerSecond,
        scrollLeft,
        viewportWidth: current.viewportWidth,
      },
    });
  }, [commitViewport, props.filePath, waveformState.status, waveformState.summary.cache_key]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    const syncWidth = () => {
      const hostRect = host.getBoundingClientRect();
      const nextViewportWidth = Math.max(1, Math.ceil(hostRect.width));
      const nextLoadingGridSize = resolveWaveformLoadingGridSize({
        height: hostRect.height || WAVEFORM_CANVAS_HEIGHT,
        width: nextViewportWidth,
      });

      if (shouldShowLoadingGrid) {
        setLoadingGridSize((current) =>
          current.columns === nextLoadingGridSize.columns &&
          current.rows === nextLoadingGridSize.rows
            ? current
            : nextLoadingGridSize,
        );
      }

      const current = viewportRef.current;
      if (!current || current.viewportWidth === nextViewportWidth) {
        return;
      }

      queueResizeViewport({
        viewportWidth: nextViewportWidth,
      });
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
  }, [queueResizeViewport, shouldShowLoadingGrid]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    host.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
    });

    return () => {
      host.removeEventListener("wheel", handleWheel, true);
    };
  }, [handleWheel]);

  useWaveformHardwareHorizontalWheelSubscription(handleHardwareHorizontalWheel);
  useWaveformCompleteDataPlanTimerCleanup({
    completeDataPlanTimerRef,
    hostRef,
  });
  useWaveformViewportSettledEffectsTimerCleanup({
    hostRef,
    viewportSettledEffectsTimerRef,
  });
  useLayoutEffect(() => {
    syncSelectionOverlay();
  }, [props.selection, syncSelectionOverlay]);

  return (
    <motion.div
      ref={hostRef}
      aria-label="Current track waveform"
      data-waveform-status={waveformState.status}
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
      <canvas
        ref={canvasRef}
        aria-hidden
        data-waveform-canvas-loading={shouldShowLoadingGrid ? "true" : "false"}
        className="pointer-events-none absolute inset-0 z-[1] h-full w-full text-inherit"
      />
      {shouldShowLoadingGrid && (
        <canvas
          ref={loadingCanvasRef}
          aria-hidden
          className="spectrum-waveform-loading-canvas pointer-events-none absolute inset-0 z-[1] h-full w-full text-inherit"
        />
      )}
      <WaveformSelectionOverlay
        onSelectionCommit={props.onSelectionCommit}
        isDraggingRef={isSelectionDragActiveRef}
        onSelectionCancelPreview={resetSelectionPreview}
        onSelectionPreview={syncSelectionOverlay}
        selectionRef={selectionRef}
        viewportRef={viewportRef}
        visible={!shouldShowLoadingGrid}
      />
      <WaveformPlayheadDragOverlay
        controller={playheadController}
        selectionRef={selectionRef}
        viewportRef={viewportRef}
        visible={props.playheadEnabled === true && !shouldShowLoadingGrid}
      />
    </motion.div>
  );
}

function WaveformSelectionOverlay(args: {
  isDraggingRef: RefObject<boolean>;
  onSelectionCancelPreview: () => void;
  onSelectionCommit?: (range: WaveformSelectionDragResolution) => void;
  onSelectionPreview: () => void;
  selectionRef: RefObject<WaveformSelectionRange | null>;
  viewportRef: RefObject<WaveformViewportModel | null>;
  visible: boolean;
}) {
  const {
    isDraggingRef,
    onSelectionCancelPreview,
    onSelectionCommit,
    onSelectionPreview,
    selectionRef,
    viewportRef,
    visible,
  } = args;
  const dragRef = useRef<WaveformSelectionDragResolution | null>(null);
  const beginDrag = useCallback(
    (edge: WaveformSelectionEdge, event: ReactPointerEvent<HTMLButtonElement>) => {
      const host = event.currentTarget.parentElement;
      const viewport = viewportRef.current;
      if (!host || !viewport || !onSelectionCommit) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);

      const hostRect = host.getBoundingClientRect();
      const resolution = resolveWaveformSelectionDrag({
        edge,
        hostRect,
        pointerClientX: event.clientX,
        selection: selectionRef.current,
        viewport,
      });
      dragRef.current = resolution;
      isDraggingRef.current = true;
      selectionRef.current = resolution;
      onSelectionPreview();
    },
    [isDraggingRef, onSelectionCommit, onSelectionPreview, selectionRef, viewportRef],
  );

  const continueDrag = useCallback(
    (edge: WaveformSelectionEdge, event: ReactPointerEvent<HTMLButtonElement>) => {
      const host = event.currentTarget.parentElement;
      const viewport = viewportRef.current;
      if (!host || !viewport || !event.currentTarget.hasPointerCapture(event.pointerId)) {
        return;
      }

      const hostRect = host.getBoundingClientRect();
      const resolution = resolveWaveformSelectionDrag({
        edge,
        hostRect,
        pointerClientX: event.clientX,
        selection: selectionRef.current,
        viewport,
      });
      dragRef.current = resolution;
      selectionRef.current = resolution;
      onSelectionPreview();
    },
    [onSelectionPreview, selectionRef, viewportRef],
  );
  const commitDrag = useCallback(() => {
    const resolution = dragRef.current;
    dragRef.current = null;
    isDraggingRef.current = false;
    if (!resolution) {
      return;
    }

    selectionRef.current = resolution;
    onSelectionPreview();
    onSelectionCommit?.(resolution);
  }, [isDraggingRef, onSelectionCommit, onSelectionPreview, selectionRef]);
  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    isDraggingRef.current = false;
    onSelectionCancelPreview();
  }, [isDraggingRef, onSelectionCancelPreview]);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[3]"
      style={{
        opacity: visible ? "var(--waveform-selection-opacity, 0)" : 0,
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 bg-[#f5f5f5]/58 dark:bg-[#050505]/58"
        style={{
          left: 0,
          width: "var(--waveform-selection-start-mask-width, 0px)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 bg-[#f5f5f5]/58 dark:bg-[#050505]/58"
        style={{
          left: "var(--waveform-selection-end-mask-left, 100%)",
          right: 0,
        }}
      />
      <WaveformSelectionHandle
        edge="start"
        cssX="var(--waveform-selection-start-x, -9999px)"
        onPointerDown={beginDrag}
        onPointerMove={continueDrag}
        onPointerCancel={cancelDrag}
        onPointerUp={commitDrag}
      />
      <WaveformSelectionHandle
        edge="end"
        cssX="var(--waveform-selection-end-x, -9999px)"
        onPointerDown={beginDrag}
        onPointerMove={continueDrag}
        onPointerCancel={cancelDrag}
        onPointerUp={commitDrag}
      />
    </div>
  );
}

function WaveformPlayheadDragOverlay(args: {
  controller: WaveformPlayheadController;
  selectionRef: RefObject<WaveformSelectionRange | null>;
  viewportRef: RefObject<WaveformViewportModel | null>;
  visible: boolean;
}) {
  const { controller, selectionRef, viewportRef, visible } = args;
  const dragRef = useRef<{
    resolution: WaveformPlayheadDragResolution | null;
  } | null>(null);

  const resolveDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const host = event.currentTarget.parentElement;
      const viewport = viewportRef.current;
      if (!host || !viewport) {
        return null;
      }

      return resolveWaveformPlayheadDrag({
        hostRect: host.getBoundingClientRect(),
        pointerClientX: event.clientX,
        selection: selectionRef.current,
        viewport,
      });
    },
    [selectionRef, viewportRef],
  );

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resolution = resolveDrag(event);
      if (!resolution) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        resolution,
      };
      controller.previewPlayheadDrag(resolution);
      controller.beginPlayheadDrag();
    },
    [controller, resolveDrag],
  );

  const continueDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        return;
      }

      const resolution = resolveDrag(event);
      if (!resolution) {
        return;
      }

      dragRef.current = {
        resolution,
      };
      controller.previewPlayheadDrag(resolution);
    },
    [controller, resolveDrag],
  );

  const commitDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        return;
      }

      const drag = dragRef.current;
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);

      if (!drag?.resolution) {
        controller.cancelPlayheadDrag();
        return;
      }

      void controller.commitPlayheadDrag(drag.resolution).catch((error) => {
        console.error("Failed to commit waveform playhead drag", error);
        controller.cancelPlayheadDrag();
      });
    },
    [controller],
  );

  const cancelDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      dragRef.current = null;
      controller.cancelPlayheadDrag();
    },
    [controller],
  );

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-[3] w-0.5 bg-[#404040] will-change-transform dark:bg-[#a3a3a3]"
        style={{
          opacity: visible ? "var(--waveform-playhead-opacity, 0)" : 0,
          transform: "translate3d(calc(var(--waveform-playhead-x, -9999px) - 1px), 0, 0)",
        }}
      />
      <button
        type="button"
        aria-label="Adjust playback position"
        className="absolute inset-y-0 left-0 z-[4] w-7 -translate-x-1/2 cursor-ew-resize touch-none border-0 bg-transparent p-0 focus:outline-none"
        style={{
          opacity: visible ? "var(--waveform-playhead-opacity, 0)" : 0,
          transform: "translate3d(var(--waveform-playhead-x, -9999px), 0, 0)",
        }}
        onPointerCancel={cancelDrag}
        onPointerDown={beginDrag}
        onPointerMove={continueDrag}
        onPointerUp={commitDrag}
      />
    </>
  );
}

function WaveformSelectionHandle(args: {
  cssX: string;
  edge: WaveformSelectionEdge;
  onPointerCancel: () => void;
  onPointerDown: (edge: WaveformSelectionEdge, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (edge: WaveformSelectionEdge, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={args.edge === "start" ? "Adjust start" : "Adjust end"}
      className="pointer-events-auto absolute inset-y-0 w-5 -translate-x-1/2 cursor-ew-resize touch-none focus:outline-none"
      style={{
        left: args.cssX,
      }}
      onPointerCancel={args.onPointerCancel}
      onPointerDown={(event) => args.onPointerDown(args.edge, event)}
      onPointerMove={(event) => args.onPointerMove(args.edge, event)}
      onPointerUp={args.onPointerUp}
    >
      <span className="absolute inset-y-0 left-1/2 block w-px -translate-x-1/2 bg-[#d4d4d4] shadow-[0_0_0_1px_rgba(245,245,245,0.65)] dark:bg-[#373737] dark:shadow-[0_0_0_1px_rgba(5,5,5,0.65)]" />
    </button>
  );
}

function useWaveformHardwareHorizontalWheelSubscription(
  handleHardwareHorizontalWheel: (payload: HardwareHorizontalWheelEvent) => void,
) {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const listenHardwareHorizontalWheel = async () => {
      const nextUnlisten = await crab.evt("hardwareHorizontalWheelEvent")(
        handleHardwareHorizontalWheel,
      );
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    };

    void listenHardwareHorizontalWheel();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleHardwareHorizontalWheel]);
}

function useWaveformCompleteDataPlanTimerCleanup(args: {
  completeDataPlanTimerRef: RefObject<number | null>;
  hostRef: RefObject<HTMLDivElement | null>;
}) {
  useEffect(
    () => () => {
      const ownerWindow =
        args.hostRef.current?.ownerDocument.defaultView ??
        (typeof window === "undefined" ? null : window);

      if (args.completeDataPlanTimerRef.current !== null && ownerWindow) {
        ownerWindow.clearTimeout(args.completeDataPlanTimerRef.current);
      }
      args.completeDataPlanTimerRef.current = null;
    },
    [args.completeDataPlanTimerRef, args.hostRef],
  );
}

function useWaveformViewportSettledEffectsTimerCleanup(args: {
  hostRef: RefObject<HTMLDivElement | null>;
  viewportSettledEffectsTimerRef: RefObject<number | null>;
}) {
  useEffect(
    () => () => {
      const ownerWindow =
        args.hostRef.current?.ownerDocument.defaultView ??
        (typeof window === "undefined" ? null : window);

      if (args.viewportSettledEffectsTimerRef.current !== null && ownerWindow) {
        ownerWindow.clearTimeout(args.viewportSettledEffectsTimerRef.current);
      }
      args.viewportSettledEffectsTimerRef.current = null;
    },
    [args.hostRef, args.viewportSettledEffectsTimerRef],
  );
}

function useWaveformZoomViewportScheduler(args: {
  cancelViewportSettledEffects: () => void;
  commitViewportModel: (next: WaveformViewportState) => boolean;
  hostRef: RefObject<HTMLDivElement | null>;
  markZoomExplicit: () => void;
  runViewportEffects: (mode: WaveformDataPlanMode) => void;
  scheduleViewportSettledEffects: () => void;
}): WaveformZoomQueue {
  const latestArgsRef = useRef(args);
  latestArgsRef.current = args;
  const frameIdRef = useRef<number | null>(null);
  const pendingCommandRef = useRef<WaveformZoomCommand | null>(null);
  const pendingFrameRef = useRef<WaveformZoomFrame | null>(null);

  const flush = useCallback(() => {
    frameIdRef.current = null;
    const command = pendingCommandRef.current;
    const frame = pendingFrameRef.current;
    pendingCommandRef.current = null;
    pendingFrameRef.current = null;

    if (!command || !frame) {
      return;
    }

    const changed = latestArgsRef.current.commitViewportModel({
      focusSeconds: frame.anchorSeconds,
      pixelsPerSecond: frame.pixelsPerSecond,
      scrollLeft: frame.scrollLeft,
      viewportWidth: command.viewport.viewportWidth,
    });

    if (changed) {
      latestArgsRef.current.markZoomExplicit();
      latestArgsRef.current.runViewportEffects("interactive");
      latestArgsRef.current.scheduleViewportSettledEffects();
    }
  }, []);

  const queue = useCallback<WaveformZoomQueue>(
    (command) => {
      latestArgsRef.current.cancelViewportSettledEffects();
      const frame = resolveQueuedWaveformZoomFrame({
        anchorViewportX: command.anchorViewportX,
        currentPixelsPerSecond: command.viewport.pixelsPerSecond,
        deltaY: command.deltaY,
        durationMs: command.viewport.durationMs,
        maximumPixelsPerSecond: command.viewport.maximumPixelsPerSecond,
        pendingFrame: pendingFrameRef.current,
        scrollLeft: command.viewport.scrollLeft,
        viewportWidth: command.viewport.viewportWidth,
      });
      const changed =
        Math.abs(frame.pixelsPerSecond - command.viewport.pixelsPerSecond) >= 0.01 ||
        Math.abs(frame.scrollLeft - command.viewport.scrollLeft) >= 0.5;

      if (!changed) {
        pendingCommandRef.current = null;
        pendingFrameRef.current = null;
        return;
      }

      pendingCommandRef.current = command;
      pendingFrameRef.current = frame;
      const ownerWindow =
        latestArgsRef.current.hostRef.current?.ownerDocument.defaultView ??
        (typeof window === "undefined" ? null : window);

      if (!ownerWindow) {
        flush();
        return;
      }

      if (frameIdRef.current !== null) {
        return;
      }

      frameIdRef.current = ownerWindow.requestAnimationFrame(flush);
    },
    [flush],
  );

  useEffect(
    () => () => {
      const ownerWindow =
        latestArgsRef.current.hostRef.current?.ownerDocument.defaultView ??
        (typeof window === "undefined" ? null : window);

      if (frameIdRef.current !== null && ownerWindow) {
        ownerWindow.cancelAnimationFrame(frameIdRef.current);
      }
      frameIdRef.current = null;
      pendingCommandRef.current = null;
      pendingFrameRef.current = null;
    },
    [],
  );

  return queue;
}

function useWaveformResizeViewportScheduler(args: {
  cancelViewportSettledEffects: () => void;
  commitViewportModel: (next: WaveformViewportState) => boolean;
  hostRef: RefObject<HTMLDivElement | null>;
  resolveState: (command: WaveformResizeCommand) => WaveformViewportState | null;
  runViewportEffects: (mode: WaveformDataPlanMode) => void;
  scheduleViewportSettledEffects: () => void;
}): WaveformResizeQueue {
  const latestArgsRef = useRef(args);
  latestArgsRef.current = args;
  const frameIdRef = useRef<number | null>(null);
  const pendingCommandRef = useRef<WaveformResizeCommand | null>(null);

  const flush = useCallback(() => {
    frameIdRef.current = null;
    const command = pendingCommandRef.current;
    pendingCommandRef.current = null;

    if (!command) {
      return;
    }

    const state = latestArgsRef.current.resolveState(command);
    if (!state) {
      return;
    }

    if (latestArgsRef.current.commitViewportModel(state)) {
      latestArgsRef.current.runViewportEffects("interactive");
      latestArgsRef.current.scheduleViewportSettledEffects();
    }
  }, []);

  const queue = useCallback<WaveformResizeQueue>(
    (command) => {
      latestArgsRef.current.cancelViewportSettledEffects();
      pendingCommandRef.current = command;
      const ownerWindow =
        latestArgsRef.current.hostRef.current?.ownerDocument.defaultView ??
        (typeof window === "undefined" ? null : window);

      if (!ownerWindow) {
        flush();
        return;
      }

      if (frameIdRef.current !== null) {
        return;
      }

      frameIdRef.current = ownerWindow.requestAnimationFrame(flush);
    },
    [flush],
  );

  useEffect(
    () => () => {
      const ownerWindow =
        latestArgsRef.current.hostRef.current?.ownerDocument.defaultView ??
        (typeof window === "undefined" ? null : window);

      if (frameIdRef.current !== null && ownerWindow) {
        ownerWindow.cancelAnimationFrame(frameIdRef.current);
      }
      frameIdRef.current = null;
      pendingCommandRef.current = null;
    },
    [],
  );

  return queue;
}

function useTrackWaveformSummary(args: {
  filePath: string | null;
  placeholderSummary: TrackWaveformSummary;
  renderDataStore: WaveformRenderDataStore;
  waveformPort: TrackSpectrumWaveformPort;
}) {
  const [state, setState] = useState<TrackWaveformSummaryState>(() => ({
    status: resolveTrackWaveformInitialStatus(args.filePath),
    summary: args.placeholderSummary,
  }));
  useEffect(() => {
    const filePath = args.filePath?.trim();
    const fileKey = normalizeWaveformPathKey(filePath);

    if (!filePath || !fileKey) {
      setState({
        status: "idle",
        summary: args.placeholderSummary,
      });
      return undefined;
    }

    let cancelled = false;
    const ownerWindow = typeof window === "undefined" ? null : window;
    const cached = args.renderDataStore.summaries.get(fileKey)?.state;
    if (cached) {
      setState(cached);
    } else {
      setState({
        status: "loading",
        summary: args.placeholderSummary,
      });
    }

    const handle = scheduleWaveformInitialPrepare(ownerWindow, () => {
      const existing = args.renderDataStore.summaries.get(fileKey);
      const promise =
        existing?.promise ??
        (existing?.state
          ? Promise.resolve(existing.state.summary)
          : args.waveformPort.prepareTrackWaveform(filePath, null, null).then((summary) => {
              args.renderDataStore.summaries.set(fileKey, {
                promise: null,
                state: {
                  status: "ready",
                  summary,
                },
              });

              return summary;
            }));

      if (!existing?.promise && !existing?.state) {
        args.renderDataStore.summaries.set(fileKey, {
          promise,
          state: null,
        });
      }

      void promise
        .then((summary) => {
          if (cancelled) {
            return;
          }

          setState({
            status: "ready",
            summary,
          });
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }

          console.error("Failed to prepare track waveform", error);
          args.renderDataStore.summaries.delete(fileKey);
          setState({
            status: "error",
            summary: args.placeholderSummary,
          });
        });
    });

    return () => {
      cancelled = true;
      cancelWaveformInitialPrepare(ownerWindow, handle);
    };
  }, [args.filePath, args.placeholderSummary, args.renderDataStore, args.waveformPort]);

  return state;
}

function useWaveformLoadingRenderer(args: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  gridSize: WaveformLoadingGridSize;
  visible: boolean;
}) {
  const latestArgsRef = useRef(args);
  latestArgsRef.current = args;
  const rendererRef = useRef<WaveformLoadingRenderer | null>(null);

  useEffect(() => {
    if (!args.visible) {
      destroyWaveformLoadingRenderer(rendererRef.current);
      rendererRef.current = null;
      return undefined;
    }

    const canvas = args.canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const ownerWindow =
      canvas.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);
    if (!ownerWindow) {
      return undefined;
    }

    const renderer = rendererRef.current ?? createWaveformLoadingRenderer(canvas);
    rendererRef.current = renderer;

    if (!renderer) {
      return undefined;
    }

    renderer.startTimeMs = readWaveformPerformanceNow(ownerWindow);

    const render = () => {
      const latest = latestArgsRef.current;
      const currentCanvas = latest.canvasRef.current;
      if (!latest.visible || !currentCanvas) {
        stopWaveformLoadingRenderer(renderer);
        return;
      }

      drawWaveformLoadingRenderer({
        canvas: currentCanvas,
        gridSize: latest.gridSize,
        nowMs: readWaveformPerformanceNow(ownerWindow),
        renderer,
      });
      renderer.animationOwnerWindow = ownerWindow;
      renderer.animationFrameId = ownerWindow.requestAnimationFrame(render);
    };

    render();

    return () => {
      stopWaveformLoadingRenderer(renderer);
    };
  }, [args.canvasRef, args.gridSize, args.visible]);

  useEffect(
    () => () => {
      destroyWaveformLoadingRenderer(rendererRef.current);
      rendererRef.current = null;
    },
    [],
  );
}

function useWaveformPlayheadController(args: {
  enabled: boolean;
  filePath: string | null;
  hostRef: RefObject<HTMLDivElement | null>;
  playbackPort: TrackSpectrumPlaybackPort;
  selectionRef: RefObject<WaveformSelectionRange | null>;
  summary: TrackWaveformSummary;
  viewportRef: RefObject<WaveformViewportModel | null>;
}): WaveformPlayheadController {
  const latestArgsRef = useRef(args);
  latestArgsRef.current = args;
  const playbackSnapshotRef = useRef<PlaybackSnapshot | null>(null);
  const frameIdRef = useRef<number | null>(null);
  const frameOwnerWindowRef = useRef<Window | null>(null);
  const playheadDragActiveRef = useRef(false);
  const dragPreviewRef = useRef<WaveformPlayheadDragResolution | null>(null);
  const beginSeekPromiseRef = useRef<Promise<boolean> | null>(null);

  const syncPlayhead = useCallback((nowMs?: number) => {
    const latest = latestArgsRef.current;
    const host = latest.hostRef.current;
    const viewport = latest.viewportRef.current;
    if (!host || !viewport) {
      return;
    }

    const ownerWindow = host.ownerDocument.defaultView;
    const snapshot = playbackSnapshotRef.current;
    const dragPreview = dragPreviewRef.current;
    const positionMs =
      dragPreview?.positionMs ??
      resolvePlaybackPositionMs({
        durationMs: resolvePlaybackSnapshotDurationMs({
          fallbackDurationMs: latest.summary.duration_ms,
          snapshot,
        }),
        nowMs: nowMs ?? readWaveformPerformanceNow(ownerWindow),
        snapshot,
      });
    const cssVars = resolveWaveformPlayheadCssVariables({
      playbackStartMs: dragPreview !== null ? 0 : (snapshot?.playback_start_ms ?? null),
      pixelsPerSecond: viewport.pixelsPerSecond,
      positionMs,
      scrollLeft: viewport.scrollLeft,
      viewportWidth: viewport.viewportWidth,
    });

    host.style.setProperty("--waveform-playhead-opacity", cssVars.opacity);
    host.style.setProperty("--waveform-playhead-x", cssVars.x);
  }, []);

  const stopPlayheadAnimation = useCallback(() => {
    if (frameIdRef.current !== null) {
      frameOwnerWindowRef.current?.cancelAnimationFrame(frameIdRef.current);
      frameIdRef.current = null;
      frameOwnerWindowRef.current = null;
    }
  }, []);

  const startPlayheadAnimation = useCallback(() => {
    if (frameIdRef.current !== null) {
      return;
    }

    const ownerWindow =
      latestArgsRef.current.hostRef.current?.ownerDocument.defaultView ??
      (typeof window === "undefined" ? null : window);
    if (!ownerWindow) {
      return;
    }

    const tick = () => {
      if (playheadDragActiveRef.current) {
        frameIdRef.current = null;
        frameOwnerWindowRef.current = null;
        return;
      }

      const snapshot = playbackSnapshotRef.current;
      if (!snapshot?.playing || snapshot.paused) {
        frameIdRef.current = null;
        frameOwnerWindowRef.current = null;
        return;
      }

      syncPlayhead(readWaveformPerformanceNow(ownerWindow));
      frameIdRef.current = ownerWindow.requestAnimationFrame(tick);
    };

    frameOwnerWindowRef.current = ownerWindow;
    frameIdRef.current = ownerWindow.requestAnimationFrame(tick);
  }, [syncPlayhead]);

  const commitPlaybackSnapshot = useCallback(
    (snapshot: PlaybackSnapshot | null) => {
      if (!latestArgsRef.current.enabled) {
        playbackSnapshotRef.current = null;
        stopPlayheadAnimation();
        return;
      }

      playbackSnapshotRef.current = snapshot;
      syncPlayhead();

      if (playheadDragActiveRef.current) {
        stopPlayheadAnimation();
        return;
      }

      if (snapshot?.playing && !snapshot.paused) {
        startPlayheadAnimation();
        return;
      }

      stopPlayheadAnimation();
    },
    [startPlayheadAnimation, stopPlayheadAnimation, syncPlayhead],
  );

  const commitPlaybackStatus = useCallback(
    (status: PlaybackStatusPayload | null, ownerWindow: Window | null) => {
      const latest = latestArgsRef.current;
      const filePath = latest.filePath?.trim();
      const statusMatchesTrack =
        status && filePath ? isPlaybackStatusForTrack(status, filePath) : false;

      if (!status || !statusMatchesTrack) {
        commitPlaybackSnapshot(null);
        return false;
      }

      commitPlaybackSnapshot({
        ...status,
        received_at_ms: readWaveformPerformanceNow(ownerWindow),
      });
      return true;
    },
    [commitPlaybackSnapshot],
  );

  const previewPlayheadDrag = useCallback(
    (resolution: WaveformPlayheadDragResolution | null) => {
      dragPreviewRef.current = resolution;
      syncPlayhead();
    },
    [syncPlayhead],
  );

  const beginPlayheadDrag = useCallback(() => {
    playheadDragActiveRef.current = true;
    stopPlayheadAnimation();
    const ownerWindow =
      latestArgsRef.current.hostRef.current?.ownerDocument.defaultView ??
      (typeof window === "undefined" ? null : window);
    const beginPromise = latestArgsRef.current.playbackPort
      .beginPlaybackSeek()
      .then((status) => {
        if (beginSeekPromiseRef.current !== beginPromise) {
          return true;
        }

        return commitPlaybackStatus(status, ownerWindow);
      })
      .catch((error) => {
        if (beginSeekPromiseRef.current === beginPromise) {
          beginSeekPromiseRef.current = null;
          playheadDragActiveRef.current = false;
          dragPreviewRef.current = null;
          syncPlayhead();
        }
        console.error("Failed to begin waveform playhead drag", error);
        return false;
      });
    beginSeekPromiseRef.current = beginPromise;
  }, [commitPlaybackStatus, stopPlayheadAnimation, syncPlayhead]);

  const cancelPlayheadDrag = useCallback(() => {
    const ownerWindow =
      latestArgsRef.current.hostRef.current?.ownerDocument.defaultView ??
      (typeof window === "undefined" ? null : window);
    const beginPromise = beginSeekPromiseRef.current;
    beginSeekPromiseRef.current = null;
    playheadDragActiveRef.current = false;
    dragPreviewRef.current = null;
    stopPlayheadAnimation();
    syncPlayhead();

    void (beginPromise ?? Promise.resolve())
      .then((didBegin) =>
        didBegin === false ? null : latestArgsRef.current.playbackPort.cancelPlaybackSeek(),
      )
      .then((status) => {
        commitPlaybackStatus(status, ownerWindow);
      })
      .catch((error) => {
        console.error("Failed to cancel waveform playhead drag", error);
      });
  }, [commitPlaybackStatus, stopPlayheadAnimation, syncPlayhead]);

  const commitPlayheadDrag = useCallback(
    async (resolution: WaveformPlayheadDragResolution) => {
      const ownerWindow =
        latestArgsRef.current.hostRef.current?.ownerDocument.defaultView ??
        (typeof window === "undefined" ? null : window);
      const beginPromise = beginSeekPromiseRef.current;
      let didBegin = true;
      if (beginPromise) {
        didBegin = await beginPromise;
        if (beginSeekPromiseRef.current !== beginPromise) {
          dragPreviewRef.current = null;
          syncPlayhead();
          return;
        }
      }
      beginSeekPromiseRef.current = null;
      playheadDragActiveRef.current = false;
      if (!didBegin) {
        dragPreviewRef.current = null;
        syncPlayhead();
        return;
      }
      const status = await latestArgsRef.current.playbackPort.seekPlayback(
        resolution.positionMs,
        resolution.endMs,
      );
      dragPreviewRef.current = null;
      commitPlaybackStatus(status, ownerWindow);
    },
    [commitPlaybackStatus, syncPlayhead],
  );

  useLayoutEffect(() => {
    if (!args.enabled) {
      return;
    }

    syncPlayhead();
  }, [args.enabled, args.summary.duration_ms, syncPlayhead]);

  useEffect(() => {
    if (!args.enabled) {
      commitPlaybackSnapshot(null);
      return undefined;
    }

    const filePath = args.filePath?.trim();

    commitPlaybackSnapshot(null);

    if (!filePath) {
      return undefined;
    }

    const ownerWindow =
      latestArgsRef.current.hostRef.current?.ownerDocument.defaultView ??
      (typeof window === "undefined" ? null : window);
    if (!ownerWindow) {
      return undefined;
    }

    let cancelled = false;
    const refreshPlaybackStatus = async () => {
      try {
        const status = await args.playbackPort.getPlaybackStatus();
        if (cancelled) {
          return;
        }

        const statusMatchesTrack = status ? isPlaybackStatusForTrack(status, filePath) : false;

        commitPlaybackStatus(statusMatchesTrack ? status : null, ownerWindow);
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to refresh playback status", error);
          commitPlaybackSnapshot(null);
        }
      }
    };

    void refreshPlaybackStatus();
    const intervalId = ownerWindow.setInterval(() => {
      void refreshPlaybackStatus();
    }, PLAYBACK_STATUS_POLL_MS);

    return () => {
      cancelled = true;
      ownerWindow.clearInterval(intervalId);
      commitPlaybackSnapshot(null);
    };
  }, [args.enabled, args.filePath, args.playbackPort, commitPlaybackSnapshot]);

  useEffect(() => stopPlayheadAnimation, [stopPlayheadAnimation]);

  if (!args.enabled) {
    return inertWaveformPlayheadController;
  }

  return {
    beginPlayheadDrag,
    cancelPlayheadDrag,
    commitPlayheadDrag,
    previewPlayheadDrag,
    syncPlayhead,
  };
}

function useWaveformDataLoader(args: {
  filePath: string | null;
  onTileAvailable: (plan: WaveformDataPlan) => void;
  status: WaveformStatus;
  tileCacheRef: RefObject<Map<string, WaveformCachedTile>>;
  tilePromiseStore: Map<string, Promise<TrackWaveformTile>>;
  waveformPort: TrackSpectrumWaveformPort;
}) {
  const activeCountRef = useRef(0);
  const inFlightKeysRef = useRef(new Set<string>());
  const latestCacheAcceptedRequestKeySetRef = useRef(new Set<string>());
  const latestPresentationRequestKeySetRef = useRef(new Set<string>());
  const nextOrderRef = useRef(0);
  const previousPlanSignatureRef = useRef<string | null>(null);
  const queueRef = useRef<WaveformTileLoadQueueEntry[]>([]);
  const loadContextRef = useRef<{
    filePath: string;
    waveformPort: TrackSpectrumWaveformPort;
  } | null>(null);
  const latestArgsRef = useRef(args);
  latestArgsRef.current = args;
  const onTileAvailableRef = useRef(args.onTileAvailable);
  onTileAvailableRef.current = args.onTileAvailable;
  const latestAcceptedPlanRef = useRef<WaveformDataPlan | null>(null);

  const resetLoader = useCallback(() => {
    queueRef.current = [];
    latestCacheAcceptedRequestKeySetRef.current = new Set();
    latestPresentationRequestKeySetRef.current = new Set();
    latestAcceptedPlanRef.current = null;
    previousPlanSignatureRef.current = null;
    loadContextRef.current = null;
  }, []);

  const pumpRef = useRef<() => void>(() => {});
  pumpRef.current = () => {
    const context = loadContextRef.current;
    const cache = latestArgsRef.current.tileCacheRef.current;

    if (!context) {
      return;
    }

    while (activeCountRef.current < WAVEFORM_DATA_LOAD_CONCURRENCY && queueRef.current.length > 0) {
      const entry = queueRef.current.shift();
      if (!entry) {
        break;
      }

      if (cache.has(entry.cacheKey) || inFlightKeysRef.current.has(entry.cacheKey)) {
        continue;
      }

      activeCountRef.current += 1;
      inFlightKeysRef.current.add(entry.cacheKey);

      let tilePromise = latestArgsRef.current.tilePromiseStore.get(entry.cacheKey);
      if (!tilePromise) {
        tilePromise = context.waveformPort.getTrackWaveformTile(
          context.filePath,
          null,
          null,
          entry.dataPixelsPerSecond,
          entry.startPx,
          entry.widthPx,
        );
        latestArgsRef.current.tilePromiseStore.set(entry.cacheKey, tilePromise);
      }

      void tilePromise
        .then((tileData) => {
          const acceptedByCurrentDemand = latestCacheAcceptedRequestKeySetRef.current.has(
            entry.cacheKey,
          );
          const shouldRequestPresentation = latestPresentationRequestKeySetRef.current.has(
            entry.cacheKey,
          );

          if (acceptedByCurrentDemand) {
            latestArgsRef.current.tileCacheRef.current.set(entry.cacheKey, {
              data: tileData,
              key: entry.cacheKey,
              lastUsedAt: readWaveformPerformanceNow(window),
              pixelsPerSecond: entry.dataPixelsPerSecond,
              scopeKey: entry.scopeKey,
            });
            const acceptedPlan = latestAcceptedPlanRef.current;
            if (acceptedPlan && shouldRequestPresentation) {
              onTileAvailableRef.current(acceptedPlan);
            }
            return;
          }
        })
        .catch((error) => {
          console.error("Failed to load waveform tile", error);
        })
        .finally(() => {
          activeCountRef.current = Math.max(0, activeCountRef.current - 1);
          inFlightKeysRef.current.delete(entry.cacheKey);
          if (latestArgsRef.current.tilePromiseStore.get(entry.cacheKey) === tilePromise) {
            latestArgsRef.current.tilePromiseStore.delete(entry.cacheKey);
          }
          pumpRef.current();
        });
    }
  };

  const requestDataPlan = useCallback(
    (request: WaveformDataPlanRequest) => {
      const latest = latestArgsRef.current;
      const scope = request.scope;

      if (latest.status !== "ready" || !latest.filePath) {
        resetLoader();
        return;
      }

      const filePath = latest.filePath;
      loadContextRef.current = {
        filePath,
        waveformPort: latest.waveformPort,
      };

      const plan = request.plan;
      const scopedRequests = resolveWaveformDataPlanScopedRequests(plan, scope);
      const cache = latest.tileCacheRef.current;
      const planSignature = createWaveformDataPlanSignature(plan, scope);
      const queuedKeys = new Set(queueRef.current.map((entry) => entry.cacheKey));
      const hasUnscheduledMissingRequest = scopedRequests.some(
        (request) =>
          !cache.has(request.cacheKey) &&
          !inFlightKeysRef.current.has(request.cacheKey) &&
          !queuedKeys.has(request.cacheKey),
      );

      if (previousPlanSignatureRef.current === planSignature && !hasUnscheduledMissingRequest) {
        return;
      }

      const scheduledKeys = new Set(scopedRequests.map((request) => request.cacheKey));
      const presentationKeys = new Set(
        scopedRequests
          .filter((request) => shouldPresentWaveformTileAvailability(request.priority))
          .map((request) => request.cacheKey),
      );
      const protectedKeys = new Set([...scheduledKeys, ...plan.protectedCacheKeys]);
      previousPlanSignatureRef.current = planSignature;
      latestCacheAcceptedRequestKeySetRef.current = scheduledKeys;
      latestPresentationRequestKeySetRef.current = presentationKeys;
      latestAcceptedPlanRef.current = plan;
      queueRef.current = queueRef.current.filter(
        (entry) => entry.scopeKey === plan.scopeKey && scheduledKeys.has(entry.cacheKey),
      );

      const nextQueuedKeys = new Set(queueRef.current.map((entry) => entry.cacheKey));
      const now = readWaveformPerformanceNow(typeof window === "undefined" ? null : window);
      for (const request of scopedRequests) {
        const cached = cache.get(request.cacheKey);
        if (cached) {
          cached.lastUsedAt = now;
          continue;
        }

        if (inFlightKeysRef.current.has(request.cacheKey) || nextQueuedKeys.has(request.cacheKey)) {
          continue;
        }

        queueRef.current.push({
          ...request,
          order: nextOrderRef.current,
        });
        nextQueuedKeys.add(request.cacheKey);
        nextOrderRef.current += 1;
      }

      queueRef.current.sort(compareWaveformTileLoadQueueEntries);
      pruneWaveformTileCache(cache, protectedKeys);
      pumpRef.current();
    },
    [resetLoader],
  );

  return requestDataPlan;
}

function useWaveformCanvasRenderer(args: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  filePath: string | null;
  status: WaveformStatus;
  summary: TrackWaveformSummary;
  tileCacheRef: RefObject<Map<string, WaveformCachedTile>>;
  viewportRef: RefObject<WaveformViewportModel | null>;
}) {
  const latestArgsRef = useRef(args);
  latestArgsRef.current = args;
  const controllerRef = useRef<WaveformCanvasRenderController>({
    dataPlan: null,
    frameId: null,
    job: null,
    presentedFrame: null,
    requestedRevision: 0,
    reuseFrame: null,
  });

  const runFrame = useCallback(() => {
    const controller = controllerRef.current;
    controller.frameId = null;

    const latest = latestArgsRef.current;
    const canvas = latest.canvasRef.current;
    const viewport = latest.viewportRef.current;
    if (!canvas || !viewport) {
      controller.job = null;
      return;
    }

    const ownerWindow =
      canvas.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);
    let job = controller.job;

    if (!job) {
      const geometry = resolveWaveformCanvasFrameGeometry({
        devicePixelRatio: ownerWindow?.devicePixelRatio ?? 1,
        viewportWidth: viewport.viewportWidth,
      });
      const plan = resolveWaveformCanvasRenderPlan({
        dataPlan: controller.dataPlan,
        filePath: latest.filePath,
        geometry,
        status: latest.status,
        summary: latest.summary,
        tileCache: latest.tileCacheRef.current,
        viewport,
      });

      if (plan.kind === "empty") {
        controller.job = null;
        return;
      }

      const target = createWaveformCanvasRasterTarget({
        canvas,
        color: readCanvasWaveformColor(canvas),
        geometry,
      });

      if (target.kind === "empty") {
        controller.job = null;
        return;
      }

      job = createWaveformCanvasRenderJob({
        id: waveformCanvasRenderJobSequence++,
        plan: plan.plan,
        revision: controller.requestedRevision,
        target: target.target,
      });
      controller.job = job;
    }

    if (!job) {
      return;
    }

    const chunk = drawWaveformCanvasJobChunk({
      deadlineMs: readWaveformPerformanceNow(ownerWindow) + WAVEFORM_CANVAS_FRAME_BUDGET_MS,
      cursor: job.cursor,
      now: () => readWaveformPerformanceNow(ownerWindow),
      plan: job.plan,
      target: job.target,
    });
    job.cursor = chunk.cursor;

    if (chunk.completed) {
      const accepted = job.revision === controller.requestedRevision;

      if (accepted) {
        const completion = completeWaveformCanvasRenderJob({
          canvas,
          job,
        });
        if (completion.kind === "committed") {
          controller.presentedFrame = createWaveformCanvasFrameDescriptor(job.plan);
        }
      }
      controller.job = null;
      return;
    }

    controller.frameId = ownerWindow ? ownerWindow.requestAnimationFrame(runFrame) : null;

    if (!ownerWindow) {
      runFrame();
    }
  }, []);

  const requestDraw = useCallback(
    (dataPlan: WaveformDataPlan) => {
      const latest = latestArgsRef.current;
      const controller = controllerRef.current;
      const nextRevision = controller.requestedRevision + 1;
      controller.requestedRevision = nextRevision;
      controller.dataPlan = dataPlan;
      const viewport = latest.viewportRef.current;
      const canvas = latest.canvasRef.current;
      const geometry =
        canvas && viewport
          ? resolveWaveformCanvasFrameGeometry({
              devicePixelRatio: canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1,
              viewportWidth: viewport.viewportWidth,
            })
          : null;
      const renderPlan =
        geometry && viewport
          ? resolveWaveformCanvasRenderPlan({
              dataPlan,
              filePath: latest.filePath,
              geometry,
              status: latest.status,
              summary: latest.summary,
              tileCache: latest.tileCacheRef.current,
              viewport,
            })
          : null;
      const descriptor =
        renderPlan?.kind === "ready" ? createWaveformCanvasFrameDescriptor(renderPlan.plan) : null;
      const presented = presentWaveformCanvasFrameFast({
        canvas,
        descriptor,
        plan: renderPlan?.kind === "ready" ? renderPlan.plan : null,
        previous: controller.presentedFrame,
        reuseFrame: controller.reuseFrame,
      });
      if (presented.kind === "presented") {
        controller.presentedFrame = presented.descriptor;
        controller.reuseFrame = presented.reuseFrame;
      }

      controller.job = null;

      if (
        presented.kind === "presented" &&
        presented.mode === "exact-cache-redraw" &&
        presented.draw.hasColumn &&
        presented.draw.missingPeakColumns === 0 &&
        presented.draw.scannedColumns === presented.descriptor.geometry.viewportWidth
      ) {
        return;
      }

      if (controller.frameId !== null) {
        return;
      }

      const ownerWindow =
        latest.canvasRef.current?.ownerDocument.defaultView ??
        (typeof window === "undefined" ? null : window);

      if (!ownerWindow) {
        runFrame();
        return;
      }

      controller.frameId = ownerWindow.requestAnimationFrame(runFrame);
    },
    [runFrame],
  );

  useWaveformCanvasRendererCleanup({
    canvasRef: args.canvasRef,
    controllerRef,
    latestArgsRef,
  });

  return requestDraw;
}

function useWaveformCanvasRendererCleanup(args: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  controllerRef: RefObject<WaveformCanvasRenderController>;
  latestArgsRef: RefObject<{
    canvasRef: RefObject<HTMLCanvasElement | null>;
  }>;
}) {
  useEffect(
    () => () => {
      const latest = args.latestArgsRef.current;
      const ownerWindow = latest.canvasRef.current?.ownerDocument.defaultView;
      const controller = args.controllerRef.current;
      if (controller.frameId !== null && ownerWindow) {
        ownerWindow.cancelAnimationFrame(controller.frameId);
      }
      controller.frameId = null;
      controller.job = null;
      controller.dataPlan = null;
      controller.presentedFrame = null;
      controller.reuseFrame = null;
    },
    [args.canvasRef, args.controllerRef, args.latestArgsRef],
  );
}

function resolveWaveformCanvasFrameGeometry(args: {
  devicePixelRatio: number;
  viewportWidth: number;
}): WaveformCanvasFrameGeometry {
  const viewportWidth = Math.max(1, Math.ceil(args.viewportWidth));
  const devicePixelRatio = clampNumber(args.devicePixelRatio, 1, 3);
  const backingWidth = Math.max(1, Math.ceil(viewportWidth * devicePixelRatio));
  const backingHeight = Math.max(1, Math.ceil(WAVEFORM_CANVAS_HEIGHT * devicePixelRatio));

  return {
    backingHeight,
    backingWidth,
    devicePixelRatio,
    viewportWidth,
  };
}

function isWaveformCanvasFrameGeometryEqual(
  left: WaveformCanvasFrameGeometry,
  right: WaveformCanvasFrameGeometry,
) {
  return (
    left.backingHeight === right.backingHeight &&
    left.backingWidth === right.backingWidth &&
    left.devicePixelRatio === right.devicePixelRatio &&
    left.viewportWidth === right.viewportWidth
  );
}

function resolveWaveformCanvasRenderPlan(args: {
  dataPlan: WaveformDataPlan | null;
  filePath: string | null;
  geometry: WaveformCanvasFrameGeometry;
  status: WaveformStatus;
  summary: TrackWaveformSummary;
  tileCache: Map<string, WaveformCachedTile>;
  viewport: WaveformViewportModel;
}):
  | {
      empty: WaveformCanvasRenderPlanEmpty;
      kind: "empty";
    }
  | {
      kind: "ready";
      plan: WaveformCanvasRenderPlan;
    } {
  if (args.status !== "ready" || !args.filePath) {
    return {
      empty: {
        filePath: args.filePath,
        geometry: args.geometry,
        kind: args.status !== "ready" ? "not-ready" : "missing-file",
        status: args.status,
        viewport: args.viewport,
      },
      kind: "empty",
    };
  }

  if (!args.dataPlan) {
    return {
      empty: {
        geometry: args.geometry,
        kind: "missing-data-plan",
        status: args.status,
        viewport: args.viewport,
      },
      kind: "empty",
    };
  }

  const plan = args.dataPlan;
  const levelIndexes = resolveWaveformLevelTileIndexes({
    endSeconds: plan.visibleSecondsWindow.endSeconds,
    scopeKey: plan.scopeKey,
    startSeconds: plan.visibleSecondsWindow.startSeconds,
    tileCache: args.tileCache,
    tileWidth: WAVEFORM_DATA_TILE_WIDTH,
  });
  const candidateLevels = resolveWaveformCandidateLevels({
    dataPixelsPerSecond: plan.dataPixelsPerSecond,
    levelIndexes,
    pixelsPerSecond: args.viewport.pixelsPerSecond,
  });

  if (candidateLevels.length === 0) {
    return {
      empty: {
        geometry: args.geometry,
        kind: "missing-candidate-levels",
        levelIndexes,
        plan,
        tileCacheSize: args.tileCache.size,
        viewport: args.viewport,
      },
      kind: "empty",
    };
  }

  const centerY = WAVEFORM_CANVAS_HEIGHT / 2;
  const amplitude = Math.max(1, centerY - WAVEFORM_VERTICAL_PADDING);

  return {
    kind: "ready",
    plan: {
      amplitude,
      availableLevels: Array.from(levelIndexes.keys()).sort((left, right) => left - right),
      candidateLevels,
      centerY,
      dataPixelsPerSecond: plan.dataPixelsPerSecond,
      geometry: args.geometry,
      scopeKey: plan.scopeKey,
      viewport: args.viewport,
      visibleSecondsWindow: plan.visibleSecondsWindow,
      visibleWindow: plan.visibleWindow,
    },
  };
}

function resolveWaveformLevelTileIndexes(args: {
  endSeconds: number;
  scopeKey: string;
  startSeconds: number;
  tileCache: Map<string, WaveformCachedTile>;
  tileWidth: number;
}) {
  const byLevel = new Map<number, WaveformLevelTileIndex>();

  for (const entry of args.tileCache.values()) {
    if (entry.scopeKey !== args.scopeKey) {
      continue;
    }

    if (
      !isWaveformTileOverlappingSeconds({
        endSeconds: args.endSeconds,
        entry,
        startSeconds: args.startSeconds,
      })
    ) {
      continue;
    }

    const pixelsPerSecond = Math.max(1, entry.pixelsPerSecond);
    const level = byLevel.get(pixelsPerSecond) ?? {
      pixelsPerSecond,
      tilesByIndex: new Map<number, TrackWaveformTile>(),
    };
    const tileIndex = Math.floor(entry.data.start_px / Math.max(1, args.tileWidth));
    level.tilesByIndex.set(tileIndex, entry.data);
    byLevel.set(pixelsPerSecond, level);
  }

  return byLevel;
}

function createWaveformCanvasRasterTarget(args: {
  canvas: HTMLCanvasElement;
  color: string;
  geometry: WaveformCanvasFrameGeometry;
}):
  | {
      empty: WaveformCanvasRasterTargetEmpty;
      kind: "empty";
    }
  | {
      kind: "ready";
      target: WaveformCanvasRasterTarget;
    } {
  const frame = args.canvas.ownerDocument.createElement("canvas");
  if (frame.width !== args.geometry.backingWidth) {
    frame.width = args.geometry.backingWidth;
  }

  if (frame.height !== args.geometry.backingHeight) {
    frame.height = args.geometry.backingHeight;
  }

  const context = frame.getContext("2d");
  if (!context) {
    return {
      empty: {
        geometry: args.geometry,
        kind: "missing-context",
      },
      kind: "empty",
    };
  }

  context.resetTransform();
  context.clearRect(0, 0, args.geometry.backingWidth, args.geometry.backingHeight);
  context.scale(args.geometry.devicePixelRatio, args.geometry.devicePixelRatio);
  context.imageSmoothingEnabled = false;
  context.lineWidth = resolveWaveformBarWidthPx();
  context.lineCap = "butt";
  context.strokeStyle = args.color;
  context.globalAlpha = WAVEFORM_CANVAS_STROKE_ALPHA;

  return {
    kind: "ready",
    target: {
      context,
      frame,
      geometry: args.geometry,
      kind: "buffered",
    },
  };
}

function createWaveformCanvasRenderJob(args: {
  id: number;
  plan: WaveformCanvasRenderPlan;
  revision: number;
  target: WaveformCanvasRasterTarget;
}): WaveformCanvasRenderJob {
  return {
    cursor: createWaveformCanvasRenderCursor(),
    id: args.id,
    plan: args.plan,
    revision: args.revision,
    target: args.target,
  };
}

function createWaveformCanvasRenderCursor(): WaveformCanvasRenderCursor {
  return {
    firstMissingX: null,
    hasDrawnColumn: false,
    lastMissingX: null,
    missingPeakColumnCount: 0,
    nextX: 0,
    resolvedPeakColumnCount: 0,
  };
}

function createWaveformCanvasFrameDescriptor(
  plan: WaveformCanvasRenderPlan,
): WaveformCanvasFrameDescriptor {
  return {
    dataPixelsPerSecond: plan.dataPixelsPerSecond,
    geometry: plan.geometry,
    scopeKey: plan.scopeKey,
    viewport: plan.viewport,
  };
}

function applyWaveformVisibleCanvasGeometry(args: {
  canvas: HTMLCanvasElement;
  geometry: WaveformCanvasFrameGeometry;
}) {
  if (args.canvas.width !== args.geometry.backingWidth) {
    args.canvas.width = args.geometry.backingWidth;
  }

  if (args.canvas.height !== args.geometry.backingHeight) {
    args.canvas.height = args.geometry.backingHeight;
  }

  args.canvas.style.width = `${args.geometry.viewportWidth}px`;
  args.canvas.style.height = `${WAVEFORM_CANVAS_HEIGHT}px`;
}

function completeWaveformCanvasRenderJob(args: {
  canvas: HTMLCanvasElement;
  job: WaveformCanvasRenderJob;
}): WaveformCanvasRenderJobCompletion {
  return commitWaveformCanvasFrame({
    canvas: args.canvas,
    plan: args.job.plan,
    target: args.job.target,
  });
}

function commitWaveformCanvasFrame(args: {
  canvas: HTMLCanvasElement;
  plan: WaveformCanvasRenderPlan;
  target: WaveformCanvasBufferedRasterTarget;
}): WaveformCanvasFrameCommitResult {
  const context = args.canvas.getContext("2d");
  if (!context) {
    return {
      kind: "empty",
      reason: "missing-context",
    };
  }

  applyWaveformVisibleCanvasGeometry({
    canvas: args.canvas,
    geometry: args.plan.geometry,
  });
  context.resetTransform();
  context.clearRect(0, 0, args.plan.geometry.backingWidth, args.plan.geometry.backingHeight);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.drawImage(args.target.frame, 0, 0);

  return {
    kind: "committed",
  };
}

function presentWaveformCanvasFrameFast(args: {
  canvas: HTMLCanvasElement | null;
  descriptor: WaveformCanvasFrameDescriptor | null;
  plan: WaveformCanvasRenderPlan | null;
  previous: WaveformCanvasFrameDescriptor | null;
  reuseFrame: HTMLCanvasElement | null;
}): WaveformCanvasFastPresentationResult {
  if (!args.canvas) {
    return {
      kind: "empty",
      plan: null,
      reason: "missing-canvas",
      reuseFrame: args.reuseFrame,
    };
  }

  if (!args.descriptor) {
    return {
      kind: "empty",
      plan: null,
      reason: "missing-descriptor",
      reuseFrame: args.reuseFrame,
    };
  }

  const context = args.canvas.getContext("2d");
  if (!context) {
    return {
      kind: "empty",
      plan: null,
      reason: "missing-context",
      reuseFrame: args.reuseFrame,
    };
  }

  const presentationPlan = resolveWaveformCanvasFastPresentationPlan({
    current: args.descriptor,
    hasExactPlan: Boolean(args.plan),
    previous: args.previous,
  });

  if (presentationPlan.kind === "none") {
    return {
      kind: "empty",
      plan: presentationPlan,
      reason: "not-reusable",
      reuseFrame: args.reuseFrame,
    };
  }

  if (presentationPlan.kind === "exact-cache-redraw") {
    const plan = args.plan;
    if (!plan) {
      return {
        kind: "empty",
        plan: {
          kind: "none",
          reason: "scale-changed",
        },
        reason: "not-reusable",
        reuseFrame: args.reuseFrame,
      };
    }

    const draw = drawWaveformCanvasExactDataFrame({
      canvas: args.canvas,
      plan,
    });

    return {
      descriptor: args.descriptor,
      draw,
      kind: "presented",
      mode: "exact-cache-redraw",
      plan: presentationPlan,
      reuseFrame: args.reuseFrame,
    };
  }

  const reuseFrame = args.reuseFrame ?? args.canvas.ownerDocument.createElement("canvas");
  const previousGeometry = args.previous?.geometry ?? args.descriptor.geometry;
  reuseFrame.width = previousGeometry.backingWidth;
  reuseFrame.height = previousGeometry.backingHeight;

  const reuseContext = reuseFrame.getContext("2d");
  if (!reuseContext) {
    return {
      kind: "empty",
      plan: presentationPlan,
      reason: "missing-reuse-context",
      reuseFrame,
    };
  }

  reuseContext.resetTransform();
  reuseContext.clearRect(0, 0, previousGeometry.backingWidth, previousGeometry.backingHeight);
  reuseContext.drawImage(args.canvas, 0, 0);

  applyWaveformVisibleCanvasGeometry({
    canvas: args.canvas,
    geometry: args.descriptor.geometry,
  });
  context.resetTransform();
  context.clearRect(
    0,
    0,
    args.descriptor.geometry.backingWidth,
    args.descriptor.geometry.backingHeight,
  );
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  if (presentationPlan.kind === "horizontal-pan") {
    context.drawImage(
      reuseFrame,
      presentationPlan.shiftX * args.descriptor.geometry.devicePixelRatio,
      0,
    );
  } else {
    const scale = args.descriptor.geometry.devicePixelRatio;
    context.drawImage(
      reuseFrame,
      presentationPlan.copySourceStartX * scale,
      0,
      presentationPlan.copyWidthPx * scale,
      previousGeometry.backingHeight,
      presentationPlan.copyTargetStartX * scale,
      0,
      presentationPlan.copyWidthPx * scale,
      args.descriptor.geometry.backingHeight,
    );
  }
  context.scale(
    args.descriptor.geometry.devicePixelRatio,
    args.descriptor.geometry.devicePixelRatio,
  );
  context.imageSmoothingEnabled = false;
  context.lineWidth = resolveWaveformBarWidthPx();
  context.lineCap = "butt";
  context.strokeStyle = readCanvasWaveformColor(args.canvas);
  context.globalAlpha = WAVEFORM_CANVAS_STROKE_ALPHA;
  const exposedRanges = args.plan
    ? presentationPlan.kind === "horizontal-pan"
      ? [
          {
            endX: presentationPlan.exposedEndX,
            startX: presentationPlan.exposedStartX,
          },
        ]
      : presentationPlan.exposedRanges
    : [];
  const plan = args.plan;
  const draws = plan
    ? exposedRanges.map((range) =>
        drawWaveformCanvasColumnRange({
          context,
          endX: range.endX,
          plan,
          startX: range.startX,
        }),
      )
    : [];

  if (presentationPlan.kind === "horizontal-pan") {
    return {
      descriptor: args.descriptor,
      draws,
      exposedRanges,
      exposedWidthPx: exposedRanges.reduce((sum, range) => sum + range.endX - range.startX, 0),
      kind: "presented",
      mode: "horizontal-pan",
      plan: presentationPlan,
      reuseFrame,
    };
  }

  return {
    descriptor: args.descriptor,
    draws,
    exposedRanges,
    exposedWidthPx: exposedRanges.reduce((sum, range) => sum + range.endX - range.startX, 0),
    kind: "presented",
    mode: "viewport-resize",
    plan: presentationPlan,
    reuseFrame,
  };
}

function resolveWaveformCanvasChunkWindow(args: { startX: number; viewportWidth: number }): {
  maxChunkEndX: number;
  minChunkEndX: number;
} {
  return {
    maxChunkEndX: Math.min(args.viewportWidth, args.startX + WAVEFORM_CANVAS_MAX_CHUNK_WIDTH_PX),
    minChunkEndX: Math.min(args.viewportWidth, args.startX + WAVEFORM_CANVAS_MIN_CHUNK_WIDTH_PX),
  };
}

function resolveWaveformCanvasColumnPeak(args: {
  candidateLevels: WaveformLevelTileIndex[];
  tileWidth: number;
  viewport: WaveformViewportModel;
  x: number;
}): WaveformCanvasColumnSample | null {
  const startSeconds = (args.viewport.scrollLeft + args.x) / args.viewport.pixelsPerSecond;
  const endSeconds = (args.viewport.scrollLeft + args.x + 1) / args.viewport.pixelsPerSecond;

  return resolveWaveformPeakFromCandidateLevels({
    candidateLevels: args.candidateLevels,
    endSeconds,
    startSeconds,
    tileWidth: args.tileWidth,
  });
}

function drawWaveformCanvasColumn(args: {
  context: CanvasRenderingContext2D;
  peak: WaveformCanvasColumnSample;
  plan: WaveformCanvasRenderPlan;
  x: number;
}) {
  const barX = args.x + 0.5;
  const yTop = args.plan.centerY - args.peak.peak.max * args.plan.amplitude;
  const yBottom = args.plan.centerY - args.peak.peak.min * args.plan.amplitude;

  args.context.moveTo(barX, yTop);
  args.context.lineTo(barX, Math.max(yTop + 1, yBottom));
}

function drawWaveformCanvasColumnRange(args: {
  context: CanvasRenderingContext2D;
  endX: number;
  plan: WaveformCanvasRenderPlan;
  startX: number;
}): WaveformCanvasColumnRangeResult {
  const startX = clampInteger(args.startX, 0, args.plan.geometry.viewportWidth);
  const endX = clampInteger(args.endX, startX, args.plan.geometry.viewportWidth);
  let firstMissingX: number | null = null;
  let lastMissingX: number | null = null;
  let hasColumn = false;
  let missingPeakColumns = 0;
  let resolvedPeakCount = 0;
  let scannedColumns = 0;

  args.context.beginPath();

  for (let x = startX; x < endX; x += 1) {
    scannedColumns += 1;
    const peak = resolveWaveformCanvasColumnPeak({
      candidateLevels: args.plan.candidateLevels,
      tileWidth: WAVEFORM_DATA_TILE_WIDTH,
      viewport: args.plan.viewport,
      x,
    });

    if (peak) {
      drawWaveformCanvasColumn({
        context: args.context,
        peak,
        plan: args.plan,
        x,
      });
      hasColumn = true;
      resolvedPeakCount += 1;
    } else {
      firstMissingX ??= x;
      lastMissingX = x;
      missingPeakColumns += 1;
    }
  }

  if (hasColumn) {
    args.context.stroke();
  }

  return {
    firstMissingX,
    hasColumn,
    lastMissingX,
    missingPeakColumns,
    resolvedPeakCount,
    scannedColumns,
  };
}

function drawWaveformCanvasExactDataFrame(args: {
  canvas: HTMLCanvasElement;
  plan: WaveformCanvasRenderPlan;
}): WaveformCanvasColumnRangeResult {
  const context = args.canvas.getContext("2d");
  if (!context) {
    return {
      firstMissingX: 0,
      hasColumn: false,
      lastMissingX: Math.max(0, args.plan.geometry.viewportWidth - 1),
      missingPeakColumns: args.plan.geometry.viewportWidth,
      resolvedPeakCount: 0,
      scannedColumns: args.plan.geometry.viewportWidth,
    };
  }

  applyWaveformVisibleCanvasGeometry({
    canvas: args.canvas,
    geometry: args.plan.geometry,
  });
  context.resetTransform();
  context.clearRect(0, 0, args.plan.geometry.backingWidth, args.plan.geometry.backingHeight);
  context.scale(args.plan.geometry.devicePixelRatio, args.plan.geometry.devicePixelRatio);
  context.imageSmoothingEnabled = false;
  context.lineWidth = resolveWaveformBarWidthPx();
  context.lineCap = "butt";
  context.strokeStyle = readCanvasWaveformColor(args.canvas);
  context.globalAlpha = WAVEFORM_CANVAS_STROKE_ALPHA;
  context.globalCompositeOperation = "source-over";

  return drawWaveformCanvasColumnRange({
    context,
    endX: args.plan.geometry.viewportWidth,
    plan: args.plan,
    startX: 0,
  });
}

function mergeWaveformCanvasChunkCursor(args: {
  chunk: {
    firstMissingX: number | null;
    hasChunkColumn: boolean;
    lastMissingX: number | null;
    missingPeakColumns: number;
    resolvedPeakCount: number;
  };
  cursor: WaveformCanvasRenderCursor;
  endX: number;
}): WaveformCanvasRenderCursor {
  return {
    firstMissingX: args.cursor.firstMissingX ?? args.chunk.firstMissingX,
    hasDrawnColumn: args.cursor.hasDrawnColumn || args.chunk.hasChunkColumn,
    lastMissingX: args.chunk.lastMissingX ?? args.cursor.lastMissingX,
    missingPeakColumnCount: args.cursor.missingPeakColumnCount + args.chunk.missingPeakColumns,
    nextX: args.endX,
    resolvedPeakColumnCount: args.cursor.resolvedPeakColumnCount + args.chunk.resolvedPeakCount,
  };
}

export function drawWaveformCanvasJobChunk(args: {
  cursor: WaveformCanvasRenderCursor;
  deadlineMs: number;
  now: () => number;
  plan: WaveformCanvasRenderPlan;
  target: WaveformCanvasRasterTarget;
}): WaveformCanvasChunkResult {
  const context = args.target.context;
  const plan = args.plan;
  const startX = args.cursor.nextX;
  const { maxChunkEndX, minChunkEndX } = resolveWaveformCanvasChunkWindow({
    startX,
    viewportWidth: plan.geometry.viewportWidth,
  });
  let x = startX;
  let hasChunkColumn = false;
  let firstMissingX: number | null = null;
  let lastMissingX: number | null = null;
  let missingPeakColumns = 0;
  let resolvedPeakCount = 0;
  let scannedColumns = 0;

  if (
    shouldBeginWaveformCanvasChunkPath({
      startX,
    })
  ) {
    context.beginPath();
  }

  for (; x < plan.geometry.viewportWidth; x += 1) {
    scannedColumns += 1;
    const peak = resolveWaveformCanvasColumnPeak({
      candidateLevels: plan.candidateLevels,
      tileWidth: WAVEFORM_DATA_TILE_WIDTH,
      viewport: plan.viewport,
      x,
    });

    if (peak) {
      drawWaveformCanvasColumn({
        context,
        peak,
        plan,
        x,
      });
      hasChunkColumn = true;
      resolvedPeakCount += 1;
    } else {
      firstMissingX ??= x;
      lastMissingX = x;
      missingPeakColumns += 1;
    }

    if (x >= minChunkEndX && (x >= maxChunkEndX || args.now() >= args.deadlineMs)) {
      x += 1;
      break;
    }
  }

  const cursor = mergeWaveformCanvasChunkCursor({
    chunk: {
      firstMissingX,
      hasChunkColumn,
      lastMissingX,
      missingPeakColumns,
      resolvedPeakCount,
    },
    cursor: args.cursor,
    endX: x,
  });
  const completed = cursor.nextX >= plan.geometry.viewportWidth;

  if (
    shouldStrokeWaveformCanvasChunkPath({
      completed,
      cursorHasDrawnColumn: cursor.hasDrawnColumn,
      hasChunkColumn,
    })
  ) {
    context.stroke();
  }

  return {
    completed,
    cursor,
    firstMissingX,
    hasChunkColumn,
    lastMissingX,
    missingPeakColumns,
    resolvedPeakCount,
    scannedColumns,
  };
}

function resolveWaveformCandidateLevels(args: {
  dataPixelsPerSecond: number;
  levelIndexes: Map<number, WaveformLevelTileIndex>;
  pixelsPerSecond: number;
}) {
  return Array.from(args.levelIndexes.values()).sort((left, right) => {
    const leftPreferred = left.pixelsPerSecond === args.dataPixelsPerSecond;
    const rightPreferred = right.pixelsPerSecond === args.dataPixelsPerSecond;

    if (leftPreferred !== rightPreferred) {
      return leftPreferred ? -1 : 1;
    }

    const leftScore = Math.abs(Math.log2(left.pixelsPerSecond / args.dataPixelsPerSecond));
    const rightScore = Math.abs(Math.log2(right.pixelsPerSecond / args.dataPixelsPerSecond));

    return leftScore - rightScore || right.pixelsPerSecond - left.pixelsPerSecond;
  });
}

function resolveWaveformPeakFromCandidateLevels(args: {
  candidateLevels: WaveformLevelTileIndex[];
  endSeconds: number;
  startSeconds: number;
  tileWidth: number;
}): WaveformCanvasColumnSample | null {
  for (const level of args.candidateLevels) {
    const peak = resolveWaveformPeakFromLevelIndex({
      endSeconds: args.endSeconds,
      level,
      startSeconds: args.startSeconds,
      tileWidth: args.tileWidth,
    });

    if (peak) {
      return {
        levelPixelsPerSecond: level.pixelsPerSecond,
        peak,
      };
    }
  }

  return null;
}

function resolveWaveformPeakFromLevelIndex(args: {
  endSeconds: number;
  level: WaveformLevelTileIndex;
  startSeconds: number;
  tileWidth: number;
}): WaveformPeakSample | null {
  const pixelsPerSecond = Math.max(1, args.level.pixelsPerSecond);
  const startPx = Math.max(0, Math.floor(args.startSeconds * pixelsPerSecond));
  const endPx = Math.max(startPx + 1, Math.ceil(args.endSeconds * pixelsPerSecond));

  return resolveWaveformTileIndexPeakRangeAtPixels({
    endPx,
    startPx,
    tileWidth: args.tileWidth,
    tilesByIndex: args.level.tilesByIndex,
  });
}

function createWaveformLoadingRenderer(canvas: HTMLCanvasElement): WaveformLoadingRenderer | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    powerPreference: "low-power",
    preserveDrawingBuffer: false,
    stencil: false,
  });

  if (!gl) {
    return null;
  }

  const vertexShader = createWaveformLoadingShader(
    gl,
    gl.VERTEX_SHADER,
    WAVEFORM_LOADING_VERTEX_SHADER_SOURCE,
  );
  const fragmentShader = createWaveformLoadingShader(
    gl,
    gl.FRAGMENT_SHADER,
    WAVEFORM_LOADING_FRAGMENT_SHADER_SOURCE,
  );

  if (!vertexShader || !fragmentShader) {
    if (vertexShader) {
      gl.deleteShader(vertexShader);
    }
    if (fragmentShader) {
      gl.deleteShader(fragmentShader);
    }
    return null;
  }

  const program = gl.createProgram();

  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const buffer = gl.createBuffer();

  if (!buffer) {
    gl.deleteProgram(program);
    return null;
  }

  const positionAttribute = gl.getAttribLocation(program, "a_position");

  if (positionAttribute < 0) {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    return null;
  }

  const resolutionUniform = gl.getUniformLocation(program, "u_resolution");
  const gridUniform = gl.getUniformLocation(program, "u_grid");
  const timeUniform = gl.getUniformLocation(program, "u_time");
  const colorUniform = gl.getUniformLocation(program, "u_color");

  if (!resolutionUniform || !gridUniform || !timeUniform || !colorUniform) {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    return null;
  }

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, WAVEFORM_LOADING_VERTEX_DATA, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionAttribute);
  gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const color = parseWaveformLoadingColor(canvas);
  if (!color) {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    return null;
  }

  const renderer: WaveformLoadingRenderer = {
    animationFrameId: null,
    animationOwnerWindow: null,
    backingHeight: null,
    backingWidth: null,
    buffer,
    color,
    colorUniform,
    gl,
    gridUniform,
    positionAttribute,
    program,
    resolutionUniform,
    resizeObserver: null,
    startTimeMs: 0,
    timeUniform,
  };

  resizeWaveformLoadingRendererCanvas(canvas, renderer);

  const ResizeObserverConstructor = canvas.ownerDocument.defaultView?.ResizeObserver;
  if (ResizeObserverConstructor) {
    renderer.resizeObserver = new ResizeObserverConstructor(() => {
      resizeWaveformLoadingRendererCanvas(canvas, renderer);
    });
    renderer.resizeObserver.observe(canvas);
  }

  return renderer;
}

function drawWaveformLoadingRenderer(args: {
  canvas: HTMLCanvasElement;
  gridSize: WaveformLoadingGridSize;
  nowMs: number;
  renderer: WaveformLoadingRenderer;
}) {
  const renderer = args.renderer;
  const gl = renderer.gl;

  if (renderer.backingWidth === null || renderer.backingHeight === null) {
    resizeWaveformLoadingRendererCanvas(args.canvas, renderer);
  }

  if (renderer.backingWidth === null || renderer.backingHeight === null) {
    return;
  }

  gl.useProgram(renderer.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.buffer);
  gl.enableVertexAttribArray(renderer.positionAttribute);
  gl.vertexAttribPointer(renderer.positionAttribute, 2, gl.FLOAT, false, 0, 0);
  gl.uniform2f(renderer.resolutionUniform, renderer.backingWidth, renderer.backingHeight);
  gl.uniform2f(
    renderer.gridUniform,
    Math.max(1, args.gridSize.columns),
    Math.max(1, args.gridSize.rows),
  );
  gl.uniform1f(renderer.timeUniform, (args.nowMs - renderer.startTimeMs) / 1000);
  gl.uniform3f(renderer.colorUniform, renderer.color[0], renderer.color[1], renderer.color[2]);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function resizeWaveformLoadingRendererCanvas(
  canvas: HTMLCanvasElement,
  renderer: WaveformLoadingRenderer,
) {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.clientWidth;
  const height = rect.height || canvas.clientHeight;

  if (width <= 0 || height <= 0) {
    renderer.backingWidth = null;
    renderer.backingHeight = null;
    return;
  }

  const ownerWindow = canvas.ownerDocument.defaultView;
  const devicePixelRatio = clampNumber(
    ownerWindow?.devicePixelRatio ?? 1,
    1,
    WAVEFORM_LOADING_MAX_DEVICE_PIXEL_RATIO,
  );
  const backingWidth = Math.max(1, Math.ceil(width * devicePixelRatio));
  const backingHeight = Math.max(1, Math.ceil(height * devicePixelRatio));

  renderer.backingWidth = backingWidth;
  renderer.backingHeight = backingHeight;

  if (canvas.width !== backingWidth) {
    canvas.width = backingWidth;
  }

  if (canvas.height !== backingHeight) {
    canvas.height = backingHeight;
  }

  renderer.gl.viewport(0, 0, backingWidth, backingHeight);
}

function createWaveformLoadingShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);

  if (!shader) {
    return null;
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

function stopWaveformLoadingRenderer(renderer: WaveformLoadingRenderer | null) {
  if (!renderer) {
    return;
  }

  if (renderer.animationFrameId !== null) {
    renderer.animationOwnerWindow?.cancelAnimationFrame(renderer.animationFrameId);
  }

  renderer.animationFrameId = null;
  renderer.animationOwnerWindow = null;
}

function destroyWaveformLoadingRenderer(renderer: WaveformLoadingRenderer | null) {
  if (!renderer) {
    return;
  }

  stopWaveformLoadingRenderer(renderer);
  renderer.resizeObserver?.disconnect();
  renderer.gl.deleteBuffer(renderer.buffer);
  renderer.gl.deleteProgram(renderer.program);
}

function parseWaveformLoadingColor(
  canvas: HTMLCanvasElement,
): readonly [number, number, number] | null {
  const color = canvas.ownerDocument.defaultView?.getComputedStyle(canvas).color.trim();

  if (!color || color === "rgba(0, 0, 0, 0)") {
    return null;
  }

  const hex = color.match(/^#([\da-f]{3}|[\da-f]{6})$/i);

  if (hex) {
    const value =
      hex[1].length === 3
        ? hex[1]
            .split("")
            .map((character) => character + character)
            .join("")
        : hex[1];

    return [
      Number.parseInt(value.slice(0, 2), 16) / 255,
      Number.parseInt(value.slice(2, 4), 16) / 255,
      Number.parseInt(value.slice(4, 6), 16) / 255,
    ];
  }

  if (!/^rgba?\(/i.test(color)) {
    return null;
  }

  const colorComponents = color.match(/-?\d*\.?\d+(?:e[+-]?\d+)?%?/gi);

  if (!colorComponents || colorComponents.length < 3) {
    return null;
  }

  const red = parseWaveformLoadingRgbChannel(colorComponents[0]);
  const green = parseWaveformLoadingRgbChannel(colorComponents[1]);
  const blue = parseWaveformLoadingRgbChannel(colorComponents[2]);

  if (red === null || green === null || blue === null) {
    return null;
  }

  return [red, green, blue];
}

function parseWaveformLoadingRgbChannel(value: string) {
  if (value.endsWith("%")) {
    const percent = Number.parseFloat(value);
    return Number.isFinite(percent) ? clampNumber(percent / 100, 0, 1) : null;
  }

  const channel = Number.parseFloat(value);
  return Number.isFinite(channel) ? clampNumber(channel / 255, 0, 1) : null;
}

function resolveWaveformPlayheadCssVariables(args: {
  playbackStartMs: number | null;
  pixelsPerSecond: number;
  positionMs: number | null;
  scrollLeft: number;
  viewportWidth: number;
}) {
  const playheadX = resolveWaveformPlayheadX({
    playbackStartMs: args.playbackStartMs,
    pixelsPerSecond: args.pixelsPerSecond,
    positionMs: args.positionMs,
    scrollLeft: args.scrollLeft,
  });
  const isVisible =
    playheadX !== null && playheadX >= 0 && playheadX <= Math.max(1, args.viewportWidth);

  return {
    opacity: isVisible ? "0.86" : "0",
    x: isVisible ? `${Math.round(playheadX)}px` : "-9999px",
  };
}

export function handleWaveformViewportWheel(args: {
  commitViewport: WaveformViewportCommit;
  event: WheelEvent;
  queueZoomViewport: WaveformZoomQueue;
  viewport: WaveformViewportModel;
}) {
  const viewportHeight = WAVEFORM_CANVAS_HEIGHT;
  const viewportWidth = args.viewport.viewportWidth;
  const rawWheelDeltas = resolveWaveformWheelDeltas({
    deltaMode: readWaveformWheelNumber(args.event, "deltaMode", 0),
    deltaX: readWaveformWheelNumber(args.event, "deltaX", 0),
    deltaY: readWaveformWheelNumber(args.event, "deltaY", 0),
  });
  const wheelDeltas = resolveWaveformWheelAxisDeltas({
    ...rawWheelDeltas,
    shiftKey: args.event.shiftKey,
  });
  const pixelDeltas = resolveWaveformWheelPixelDeltas({
    ...wheelDeltas,
    viewportHeight,
    viewportWidth,
  });
  const intent = resolveWaveformWheelIntent(pixelDeltas);
  const preventDefault = shouldPreventWaveformWheelDefault(intent);

  if (!preventDefault) {
    return;
  }

  args.event.preventDefault();

  if (intent.kind === "horizontal-pan") {
    handleWaveformHorizontalPanWheel({
      commitViewport: args.commitViewport,
      deltaX: intent.deltaX,
      viewport: args.viewport,
    });
    return;
  }

  handleWaveformZoomWheel({
    deltaY: intent.deltaY,
    event: args.event,
    queueZoomViewport: args.queueZoomViewport,
    viewport: args.viewport,
  });
}

export function resolveWaveformHardwareHorizontalWheelDelta(args: { deltaX?: number | null }) {
  return resolveFiniteWheelDelta(args.deltaX);
}

export function shouldAcceptWaveformHardwareHorizontalWheel(args: {
  clientX?: number | null;
  clientY?: number | null;
  host: Element | null;
}) {
  const clientX = args.clientX;
  const clientY = args.clientY;

  if (
    !args.host ||
    typeof clientX !== "number" ||
    typeof clientY !== "number" ||
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY)
  ) {
    return false;
  }

  const rect = args.host.getBoundingClientRect();

  return (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  );
}

function handleWaveformHardwareHorizontalWheel(args: {
  commitViewport: WaveformViewportCommit;
  deltaX: number;
  viewport: WaveformViewportModel;
}) {
  const deltaX = resolveWaveformHardwareHorizontalWheelDelta({
    deltaX: args.deltaX,
  });

  if (deltaX === 0) {
    return;
  }

  handleWaveformHorizontalPanWheel({
    commitViewport: args.commitViewport,
    deltaX,
    viewport: args.viewport,
  });
}

function handleWaveformHorizontalPanWheel(args: {
  commitViewport: WaveformViewportCommit;
  deltaX: number;
  viewport: WaveformViewportModel;
}) {
  const viewportWidth = args.viewport.viewportWidth;
  const targetFrame = resolveWaveformHorizontalPanFrame({
    contentWidth: args.viewport.contentWidth,
    deltaX: args.deltaX,
    scrollLeft: args.viewport.scrollLeft,
    viewportWidth,
  });

  if (!targetFrame.changed) {
    return;
  }

  args.commitViewport({
    mode: "interactive",
    state: {
      focusSeconds: null,
      pixelsPerSecond: args.viewport.pixelsPerSecond,
      scrollLeft: targetFrame.scrollLeft,
      viewportWidth: args.viewport.viewportWidth,
    },
  });
}

function handleWaveformZoomWheel(args: {
  deltaY: number;
  event: WheelEvent;
  queueZoomViewport: WaveformZoomQueue;
  viewport: WaveformViewportModel;
}) {
  const rect =
    args.event.currentTarget instanceof Element
      ? args.event.currentTarget.getBoundingClientRect()
      : null;
  const viewportWidth = args.viewport.viewportWidth;
  const anchorViewportX = resolveWaveformPointerAnchorViewportX({
    clientX: args.event.clientX,
    viewportLeft: rect?.left ?? 0,
    viewportWidth,
  });
  args.queueZoomViewport({
    anchorViewportX,
    deltaY: args.deltaY,
    viewport: args.viewport,
  });
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

function resolveWaveformSortedRenderLevels(summary: TrackWaveformSummary) {
  const levels = summary.levels
    .filter((level) => Number.isFinite(level) && level > 0)
    .sort((left, right) => left - right);

  if (levels.length > 0) {
    return levels;
  }

  return [Math.max(1, summary.base_points_per_second)];
}

function resolveWaveformRenderLevelForPixelsPerSecond(args: {
  levels: readonly number[];
  pixelsPerSecond: number;
}) {
  const fallbackPixelsPerSecond = args.levels.at(-1) ?? 1;
  const targetPixelsPerSecond = Math.max(1, Math.ceil(args.pixelsPerSecond));

  return args.levels.find((level) => level >= targetPixelsPerSecond) ?? fallbackPixelsPerSecond;
}

function compareWaveformTileLoadQueueEntries(
  left: WaveformTileLoadQueueEntry,
  right: WaveformTileLoadQueueEntry,
) {
  return (
    compareWaveformDataRequests(left, right) || left.order - right.order || left.index - right.index
  );
}

function pruneWaveformTileCache(
  cache: Map<string, WaveformCachedTile>,
  protectedKeys: Set<string>,
) {
  if (cache.size <= WAVEFORM_DATA_CACHE_LIMIT) {
    return;
  }

  const removable = Array.from(cache.values())
    .filter((entry) => !protectedKeys.has(entry.key))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  const removeCount = Math.max(0, cache.size - WAVEFORM_DATA_CACHE_LIMIT);
  const removed = removable.slice(0, removeCount);

  for (const entry of removed) {
    cache.delete(entry.key);
  }
}

function isWaveformTileOverlappingSeconds(args: {
  endSeconds: number;
  entry: Pick<WaveformCachedTile, "data" | "pixelsPerSecond">;
  startSeconds: number;
}) {
  const tileStartSeconds = args.entry.data.start_px / Math.max(1, args.entry.pixelsPerSecond);
  const tileEndSeconds =
    (args.entry.data.start_px + args.entry.data.width_px) / Math.max(1, args.entry.pixelsPerSecond);

  return tileStartSeconds < args.endSeconds && tileEndSeconds > args.startSeconds;
}

function resolveWaveformVisibleSecondsWindow(args: {
  durationSeconds: number;
  overscanViewports: number;
  pixelsPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
}): WaveformSecondsWindow {
  const pixelsPerSecond = Math.max(1, args.pixelsPerSecond);
  const viewportSeconds = Math.max(0, args.viewportWidth) / pixelsPerSecond;
  const overscanSeconds = viewportSeconds * Math.max(0, args.overscanViewports);
  const startSeconds = clampNumber(
    args.scrollLeft / pixelsPerSecond - overscanSeconds,
    0,
    args.durationSeconds,
  );
  const endSeconds = clampNumber(
    (args.scrollLeft + args.viewportWidth) / pixelsPerSecond + overscanSeconds,
    startSeconds,
    args.durationSeconds,
  );

  return {
    endSeconds: Math.max(startSeconds, endSeconds),
    startSeconds,
  };
}

function resolveWaveformDataPixelWindow(args: {
  dataContentWidth: number;
  dataPixelsPerSecond: number;
  window: WaveformSecondsWindow;
}): WaveformDataWindow {
  const dataContentWidth = Math.max(1, Math.ceil(args.dataContentWidth));
  const pixelsPerSecond = Math.max(1, args.dataPixelsPerSecond);
  const startPx = clampInteger(
    Math.floor(args.window.startSeconds * pixelsPerSecond),
    0,
    dataContentWidth - 1,
  );
  const endPx = clampInteger(
    Math.ceil(args.window.endSeconds * pixelsPerSecond),
    startPx + 1,
    dataContentWidth,
  );

  return { endPx, startPx };
}

function createWaveformDataPlanSignature(plan: WaveformDataPlan, scope: WaveformDataPlanScope) {
  const requests =
    scope === "visible"
      ? plan.requests.filter((request) => isWaveformVisibleDemandPriority(request.priority))
      : plan.requests;

  return [
    plan.mode,
    scope,
    plan.scopeKey,
    roundWaveformDataPixelsPerSecondForKey(plan.dataPixelsPerSecond).toFixed(2),
    requests.map((request) => request.cacheKey).join(","),
  ].join("|");
}

function readCanvasWaveformColor(canvas: HTMLCanvasElement) {
  const color = canvas.ownerDocument.defaultView?.getComputedStyle(canvas).color;

  return color && color !== "rgba(0, 0, 0, 0)" ? color : "#262626";
}

function readWaveformWheelNumber(event: WheelEvent, key: string, fallback: number): number;
function readWaveformWheelNumber(event: WheelEvent, key: string, fallback: null): number | null;
function readWaveformWheelNumber(event: WheelEvent, key: string, fallback: number | null) {
  const value = (event as unknown as Record<string, unknown>)[key];

  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isPlaybackStatusForTrack(status: PlaybackStatusPayload, filePath: string) {
  return (
    normalizeWaveformPathKey(status.path) === normalizeWaveformPathKey(filePath) &&
    status.playback_start_ms !== null
  );
}

function readWaveformPerformanceNow(ownerWindow: Window | null) {
  return (
    ownerWindow?.performance.now() ?? (typeof performance === "undefined" ? 0 : performance.now())
  );
}

function scheduleWaveformInitialPrepare(
  ownerWindow: Window | null,
  callback: () => void,
): WaveformInitialPrepareHandle {
  if (!ownerWindow) {
    callback();
    return null;
  }

  let cancelled = false;
  let frameId: number | null = null;
  let idleId: number | null = null;
  let timerId: number | null = null;
  const run = () => {
    if (!cancelled) {
      callback();
    }
  };
  const idleWindow = ownerWindow as WaveformIdleWindow;

  if (idleWindow.requestIdleCallback) {
    idleId = idleWindow.requestIdleCallback(run, { timeout: 500 });
    return {
      cancel: () => {
        cancelled = true;
        if (idleId !== null) {
          idleWindow.cancelIdleCallback?.(idleId);
        }
      },
    };
  }

  const scheduleAfterFrame = (remainingFrames: number) => {
    if (cancelled) {
      return;
    }

    if (remainingFrames <= 0) {
      timerId = ownerWindow.setTimeout(run, 0);
      return;
    }

    frameId = ownerWindow.requestAnimationFrame(() => {
      frameId = null;
      scheduleAfterFrame(remainingFrames - 1);
    });
  };

  scheduleAfterFrame(WAVEFORM_INITIAL_PREPARE_FRAME_COUNT);

  return {
    cancel: () => {
      cancelled = true;
      if (frameId !== null) {
        ownerWindow.cancelAnimationFrame(frameId);
      }
      if (timerId !== null) {
        ownerWindow.clearTimeout(timerId);
      }
    },
  };
}

function cancelWaveformInitialPrepare(
  _ownerWindow: Window | null,
  handle: WaveformInitialPrepareHandle,
) {
  handle?.cancel();
}

function normalizeWaveformSelectionBoundary(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
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

function roundWaveformDataPixelsPerSecondForKey(value: number) {
  const finiteValue = Number.isFinite(value)
    ? Math.max(1, value)
    : WAVEFORM_FALLBACK_PIXELS_PER_SECOND;

  return (
    Math.round(finiteValue * WAVEFORM_PIXELS_PER_SECOND_PRECISION) /
    WAVEFORM_PIXELS_PER_SECOND_PRECISION
  );
}

function roundWaveformPixelsPerSecond(value: number, constraints?: WaveformZoomConstraints) {
  const maximumPixelsPerSecond = resolveWaveformMaximumPixelsPerSecond(constraints);
  const minimumPixelsPerSecond = constraints
    ? resolveWaveformMinimumPixelsPerSecond(constraints)
    : WAVEFORM_MIN_PIXELS_PER_SECOND;
  const finiteValue = Number.isFinite(value) ? value : WAVEFORM_FALLBACK_PIXELS_PER_SECOND;
  const rounded =
    Math.round(finiteValue * WAVEFORM_PIXELS_PER_SECOND_PRECISION) /
    WAVEFORM_PIXELS_PER_SECOND_PRECISION;

  return clampNumber(rounded, minimumPixelsPerSecond, maximumPixelsPerSecond);
}

function resolveFiniteWheelDelta(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sanitizePeakValue(value: number) {
  return Number.isFinite(value) ? clampNumber(value, -1, 1) : 0;
}

function sanitizeQuantizedPeakValue(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? clampNumber(value, -127, 127) : 0;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.trunc(clampNumber(value, min, max));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
