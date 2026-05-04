import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import {
  crab,
  type HardwareHorizontalWheelEvent,
  type PlaybackStatusPayload,
  type TrackWaveformSummary,
  type TrackWaveformTile,
  type WaveformPeak,
} from "@/src/cmd";
import { normalizeMediaPathKey } from "../mediaPath";

const WAVEFORM_CANVAS_HEIGHT = 208;
const WAVEFORM_VERTICAL_PADDING = 18;
const WAVEFORM_PLACEHOLDER_POINTS_PER_SECOND = 80;
const WAVEFORM_PLACEHOLDER_DURATION_MS = 8_000;
const WAVEFORM_MIN_PIXELS_PER_SECOND = 12;
const WAVEFORM_FALLBACK_MAX_PIXELS_PER_SECOND = 320;
const WAVEFORM_INITIAL_PIXELS_PER_SECOND = 24;
const WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM = 360;
const WAVEFORM_MAX_WHEEL_ZOOM_DELTA = WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM / 2;
const WAVEFORM_PIXELS_PER_SECOND_PRECISION = 100;
const WAVEFORM_DATA_TILE_WIDTH = 2_048;
const WAVEFORM_DATA_OVERSCAN_VIEWPORTS = 1.25;
const WAVEFORM_DATA_CACHE_LIMIT = 384;
const WAVEFORM_DATA_LOAD_CONCURRENCY = 2;
const WAVEFORM_DATA_IDLE_OVERSCAN_DELAY_MS = 180;
const WAVEFORM_CANVAS_FRAME_BUDGET_MS = 3.25;
const WAVEFORM_CANVAS_MIN_CHUNK_WIDTH_PX = 96;
const WAVEFORM_CANVAS_MAX_CHUNK_WIDTH_PX = 320;
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
  getPlaybackStatus: () => Promise<PlaybackStatusPayload | null>;
}

export interface TrackSpectrumPorts {
  playback: TrackSpectrumPlaybackPort;
  waveform: TrackSpectrumWaveformPort;
}

type TrackWaveformSummaryState = {
  status: WaveformStatus;
  summary: TrackWaveformSummary;
};

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

type WaveformViewportCommit = (state: WaveformViewportState) => void;

type WaveformDataWindow = {
  endPx: number;
  startPx: number;
};

type WaveformSecondsWindow = {
  endSeconds: number;
  startSeconds: number;
};

type WaveformDataRequest = {
  cacheKey: string;
  dataPixelsPerSecond: number;
  endPx: number;
  index: number;
  priority: "overscan" | "visible";
  scopeKey: string;
  startPx: number;
  widthPx: number;
};

type WaveformDataPlan = {
  dataContentWidth: number;
  dataPixelsPerSecond: number;
  overscanSecondsWindow: WaveformSecondsWindow;
  overscanWindow: WaveformDataWindow;
  requests: WaveformDataRequest[];
  scopeKey: string;
  visibleIndexes: number[];
  visibleSecondsWindow: WaveformSecondsWindow;
  visibleWindow: WaveformDataWindow;
};

type WaveformDataPlanScope = "visible" | "complete";

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
  tilesByIndex: Map<number, WaveformCachedTile>;
};

type WaveformPeakSample = {
  max: number;
  min: number;
};

type WaveformCanvasRenderJob = {
  amplitude: number;
  candidateLevels: WaveformLevelTileIndex[];
  centerY: number;
  context: CanvasRenderingContext2D;
  hasDrawnColumn: boolean;
  nextX: number;
  ownerWindow: Window | null;
  viewport: WaveformViewportModel;
  viewportWidth: number;
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
    getPlaybackStatus: async () => {
      const result = await crab.getPlaybackStatus();

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
  end: number | null;
  filePath: string | null;
  start: number | null;
  summary: TrackWaveformSummary;
}) {
  return [
    normalizeWaveformPathKey(args.filePath),
    normalizeWaveformBoundary(args.start) ?? "",
    normalizeWaveformBoundary(args.end) ?? "",
    args.summary.cache_key,
  ].join("|");
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
  end: number | null;
  filePath: string | null;
  focusSeconds: number | null;
  pixelsPerSecond: number;
  scrollLeft: number;
  start: number | null;
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
  const scopeKey = createWaveformDataScopeKey(args);
  const durationSeconds = Math.max(0, args.summary.duration_ms) / 1000;
  const dataContentWidth = Math.max(1, Math.ceil(durationSeconds * dataPixelsPerSecond));
  const visibleSecondsWindow = resolveWaveformVisibleSecondsWindow({
    durationSeconds,
    overscanViewports: 0,
    pixelsPerSecond: displayPixelsPerSecond,
    scrollLeft: args.scrollLeft,
    viewportWidth: args.viewportWidth,
  });
  const overscanSecondsWindow = resolveWaveformVisibleSecondsWindow({
    durationSeconds,
    overscanViewports: WAVEFORM_DATA_OVERSCAN_VIEWPORTS,
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
  const focusPx = focusSeconds * dataPixelsPerSecond;
  const indexes = resolveWaveformDataTileIndexes({
    tileWidth,
    window: overscanWindow,
  }).sort((left, right) => {
    const leftVisible = visibleIndexSet.has(left);
    const rightVisible = visibleIndexSet.has(right);

    if (leftVisible !== rightVisible) {
      return leftVisible ? -1 : 1;
    }

    return (
      Math.abs(left * tileWidth + tileWidth / 2 - focusPx) -
        Math.abs(right * tileWidth + tileWidth / 2 - focusPx) || left - right
    );
  });

  return {
    dataContentWidth,
    dataPixelsPerSecond,
    overscanSecondsWindow,
    overscanWindow,
    requests: indexes.map((index) => {
      const startPx = index * tileWidth;
      const widthPx = Math.max(1, Math.min(tileWidth, dataContentWidth - startPx));

      return {
        cacheKey: createWaveformDataRequestKey({
          pixelsPerSecond: dataPixelsPerSecond,
          scopeKey,
          startPx,
          widthPx,
        }),
        dataPixelsPerSecond,
        endPx: startPx + widthPx,
        index,
        priority: visibleIndexSet.has(index) ? "visible" : "overscan",
        scopeKey,
        startPx,
        widthPx,
      };
    }),
    scopeKey,
    visibleIndexes: Array.from(visibleIndexSet).sort((left, right) => left - right),
    visibleSecondsWindow,
    visibleWindow,
  };
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

export function resolveWaveformPlayheadX(args: {
  pixelsPerSecond: number;
  positionMs: number | null;
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
  end: number | null;
  filePath: string | null;
  ports?: TrackSpectrumPorts;
  start: number | null;
}) {
  const identity = [
    normalizeWaveformPathKey(props.filePath),
    normalizeWaveformBoundary(props.start) ?? "",
    normalizeWaveformBoundary(props.end) ?? "",
  ].join("|");

  return <TrackSpectrumSession key={identity} {...props} />;
}

function TrackSpectrumSession(props: {
  className?: string;
  end: number | null;
  filePath: string | null;
  ports?: TrackSpectrumPorts;
  start: number | null;
}) {
  const placeholderSummary = useMemo(() => createPlaceholderWaveformSummary(), []);
  const ports = props.ports ?? crabTrackSpectrumPorts;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<WaveformViewportModel | null>(null);
  const commitViewportRef = useRef<WaveformViewportCommit | null>(null);
  const tileCacheRef = useRef(new Map<string, WaveformCachedTile>());
  const overscanTimerRef = useRef<number | null>(null);
  const [loadingGridSize, setLoadingGridSize] = useState<WaveformLoadingGridSize>(() =>
    resolveWaveformLoadingGridSize({
      height: WAVEFORM_CANVAS_HEIGHT,
      width: WAVEFORM_LOADING_MIN_FIELD_WIDTH_PX,
    }),
  );
  const waveformState = useTrackWaveformSummary({
    end: props.end,
    filePath: props.filePath,
    placeholderSummary,
    start: props.start,
    waveformPort: ports.waveform,
  });
  const maximumPixelsPerSecond = resolveWaveformRenderPixelsPerSecond({
    summary: waveformState.summary,
  });
  if (viewportRef.current === null) {
    const viewportWidth = 1;
    const pixelsPerSecond = resolveWaveformPixelsPerSecond(WAVEFORM_INITIAL_PIXELS_PER_SECOND, {
      durationMs: waveformState.summary.duration_ms,
      maximumPixelsPerSecond,
      viewportWidth,
    });
    viewportRef.current = resolveWaveformViewportModel({
      durationMs: waveformState.summary.duration_ms,
      focusSeconds: null,
      maximumPixelsPerSecond,
      pixelsPerSecond,
      scrollLeft: 0,
      viewportWidth,
    });
  }

  const drawCanvas = useWaveformCanvasRenderer({
    canvasRef,
    end: props.end,
    filePath: props.filePath?.trim() || null,
    start: props.start,
    status: waveformState.status,
    summary: waveformState.summary,
    tileCacheRef,
    viewportRef,
  });
  const requestDataPlan = useWaveformDataLoader({
    end: props.end,
    filePath: props.filePath?.trim() || null,
    onTileAvailable: drawCanvas,
    start: props.start,
    status: waveformState.status,
    summary: waveformState.summary,
    tileCacheRef,
    viewportRef,
    waveformPort: ports.waveform,
  });
  const syncPlayhead = useWaveformPlayheadController({
    filePath: props.filePath?.trim() || null,
    hostRef,
    playbackPort: ports.playback,
    summary: waveformState.summary,
    viewportRef,
  });
  const shouldShowLoadingGrid = waveformState.status === "loading";
  useWaveformLoadingRenderer({
    canvasRef: loadingCanvasRef,
    gridSize: loadingGridSize,
    visible: shouldShowLoadingGrid,
  });

  const scheduleOverscanDataPlan = useCallback(() => {
    const ownerWindow =
      hostRef.current?.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);

    if (!ownerWindow) {
      requestDataPlan("complete");
      return;
    }

    if (overscanTimerRef.current !== null) {
      ownerWindow.clearTimeout(overscanTimerRef.current);
    }

    overscanTimerRef.current = ownerWindow.setTimeout(() => {
      overscanTimerRef.current = null;
      requestDataPlan("complete");
    }, WAVEFORM_DATA_IDLE_OVERSCAN_DELAY_MS);
  }, [requestDataPlan]);

  const commitViewport = useCallback(
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

      syncPlayhead();

      if (!changed) {
        return;
      }

      drawCanvas();
      requestDataPlan("visible");
      scheduleOverscanDataPlan();
    },
    [
      drawCanvas,
      maximumPixelsPerSecond,
      requestDataPlan,
      scheduleOverscanDataPlan,
      syncPlayhead,
      waveformState.summary.duration_ms,
    ],
  );
  commitViewportRef.current = commitViewport;

  const handleWheel = useCallback((event: Event) => {
    const current = viewportRef.current;
    const wheelEvent = event as WheelEvent;

    if (!current) {
      return;
    }

    handleWaveformViewportWheel({
      commitViewport: (next) => commitViewportRef.current?.(next),
      event: wheelEvent,
      viewport: current,
    });
  }, []);

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
      commitViewport: (next) => commitViewportRef.current?.(next),
      deltaX: payload.delta_x,
      viewport: current,
    });
  }, []);

  useLayoutEffect(() => {
    const current = viewportRef.current;
    if (!current) {
      return;
    }

    commitViewport({
      focusSeconds: current.focusSeconds,
      pixelsPerSecond: current.pixelsPerSecond,
      scrollLeft: current.scrollLeft,
      viewportWidth: current.viewportWidth,
    });
  }, [
    commitViewport,
    maximumPixelsPerSecond,
    waveformState.summary.cache_key,
    waveformState.summary.duration_ms,
  ]);

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

      setLoadingGridSize((current) =>
        current.columns === nextLoadingGridSize.columns && current.rows === nextLoadingGridSize.rows
          ? current
          : nextLoadingGridSize,
      );

      const current = viewportRef.current;
      if (!current || current.viewportWidth === nextViewportWidth) {
        return;
      }

      commitViewport({
        focusSeconds: current.focusSeconds,
        pixelsPerSecond: current.pixelsPerSecond,
        scrollLeft: current.scrollLeft,
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
  }, [commitViewport]);

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

  useEffect(
    () => () => {
      const ownerWindow =
        hostRef.current?.ownerDocument.defaultView ??
        (typeof window === "undefined" ? null : window);

      if (overscanTimerRef.current !== null && ownerWindow) {
        ownerWindow.clearTimeout(overscanTimerRef.current);
      }
      overscanTimerRef.current = null;
    },
    [],
  );

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
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-[2] w-px bg-[#404040] will-change-transform dark:bg-[#a3a3a3]"
        style={{
          opacity: shouldShowLoadingGrid ? "0" : "var(--waveform-playhead-opacity, 0)",
          transform: "translate3d(var(--waveform-playhead-x, -9999px), 0, 0)",
        }}
      />
    </motion.div>
  );
}

function useTrackWaveformSummary(args: {
  end: number | null;
  filePath: string | null;
  placeholderSummary: TrackWaveformSummary;
  start: number | null;
  waveformPort: TrackSpectrumWaveformPort;
}) {
  const [state, setState] = useState<TrackWaveformSummaryState>(() => ({
    status: resolveTrackWaveformInitialStatus(args.filePath),
    summary: args.placeholderSummary,
  }));

  useEffect(() => {
    const filePath = args.filePath?.trim();

    if (!filePath) {
      setState({
        status: "idle",
        summary: args.placeholderSummary,
      });
      return undefined;
    }

    let cancelled = false;
    const ownerWindow = typeof window === "undefined" ? null : window;
    setState({
      status: "loading",
      summary: args.placeholderSummary,
    });

    const handle = scheduleWaveformInitialPrepare(ownerWindow, () => {
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
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }

          console.error("Failed to prepare track waveform", error);
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
  }, [args.end, args.filePath, args.placeholderSummary, args.start, args.waveformPort]);

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
  }, [args.canvasRef, args.visible]);

  useEffect(
    () => () => {
      destroyWaveformLoadingRenderer(rendererRef.current);
      rendererRef.current = null;
    },
    [],
  );
}

function useWaveformPlayheadController(args: {
  filePath: string | null;
  hostRef: RefObject<HTMLDivElement | null>;
  playbackPort: TrackSpectrumPlaybackPort;
  summary: TrackWaveformSummary;
  viewportRef: RefObject<WaveformViewportModel | null>;
}) {
  const latestArgsRef = useRef(args);
  latestArgsRef.current = args;
  const playbackSnapshotRef = useRef<PlaybackSnapshot | null>(null);
  const frameIdRef = useRef<number | null>(null);
  const frameOwnerWindowRef = useRef<Window | null>(null);

  const syncPlayhead = useCallback((nowMs?: number) => {
    const latest = latestArgsRef.current;
    const host = latest.hostRef.current;
    const viewport = latest.viewportRef.current;
    if (!host || !viewport) {
      return;
    }

    const ownerWindow = host.ownerDocument.defaultView;
    const positionMs = resolvePlaybackPositionMs({
      durationMs: latest.summary.duration_ms,
      nowMs: nowMs ?? readWaveformPerformanceNow(ownerWindow),
      snapshot: playbackSnapshotRef.current,
    });
    const cssVars = resolveWaveformPlayheadCssVariables({
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
      playbackSnapshotRef.current = snapshot;
      syncPlayhead();

      if (snapshot?.playing && !snapshot.paused) {
        startPlayheadAnimation();
        return;
      }

      stopPlayheadAnimation();
    },
    [startPlayheadAnimation, stopPlayheadAnimation, syncPlayhead],
  );

  useLayoutEffect(() => {
    syncPlayhead();
  }, [args.summary.duration_ms, syncPlayhead]);

  useEffect(() => {
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

        if (!status || !isPlaybackStatusForTrack(status, filePath)) {
          commitPlaybackSnapshot(null);
          return;
        }

        commitPlaybackSnapshot({
          ...status,
          received_at_ms: readWaveformPerformanceNow(ownerWindow),
        });
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
  }, [args.filePath, args.playbackPort, commitPlaybackSnapshot]);

  useEffect(() => stopPlayheadAnimation, [stopPlayheadAnimation]);

  return syncPlayhead;
}

function useWaveformDataLoader(args: {
  end: number | null;
  filePath: string | null;
  onTileAvailable: () => void;
  start: number | null;
  status: WaveformStatus;
  summary: TrackWaveformSummary;
  tileCacheRef: RefObject<Map<string, WaveformCachedTile>>;
  viewportRef: RefObject<WaveformViewportModel | null>;
  waveformPort: TrackSpectrumWaveformPort;
}) {
  const activeCountRef = useRef(0);
  const inFlightKeysRef = useRef(new Set<string>());
  const latestPlanKeySetRef = useRef(new Set<string>());
  const nextOrderRef = useRef(0);
  const previousPlanSignatureRef = useRef<string | null>(null);
  const queueRef = useRef<WaveformTileLoadQueueEntry[]>([]);
  const loadContextRef = useRef<{
    end: number | null;
    filePath: string;
    start: number | null;
    waveformPort: TrackSpectrumWaveformPort;
  } | null>(null);
  const latestArgsRef = useRef(args);
  latestArgsRef.current = args;
  const onTileAvailableRef = useRef(args.onTileAvailable);
  onTileAvailableRef.current = args.onTileAvailable;

  const resetLoader = useCallback(() => {
    queueRef.current = [];
    latestPlanKeySetRef.current = new Set();
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

      void context.waveformPort
        .getTrackWaveformTile(
          context.filePath,
          normalizeWaveformBoundary(context.start),
          normalizeWaveformBoundary(context.end),
          entry.dataPixelsPerSecond,
          entry.startPx,
          entry.widthPx,
        )
        .then((tileData) => {
          if (latestPlanKeySetRef.current.has(entry.cacheKey)) {
            cache.set(entry.cacheKey, {
              data: tileData,
              key: entry.cacheKey,
              lastUsedAt: readWaveformPerformanceNow(window),
              pixelsPerSecond: entry.dataPixelsPerSecond,
              scopeKey: entry.scopeKey,
            });
            onTileAvailableRef.current();
            return;
          }
        })
        .catch((error) => {
          console.error("Failed to load waveform tile", error);
        })
        .finally(() => {
          activeCountRef.current = Math.max(0, activeCountRef.current - 1);
          inFlightKeysRef.current.delete(entry.cacheKey);
          pumpRef.current();
        });
    }
  };

  const requestDataPlan = useCallback(
    (scope: WaveformDataPlanScope = "visible") => {
      const latest = latestArgsRef.current;
      const viewport = latest.viewportRef.current;

      if (latest.status !== "ready" || !latest.filePath || !viewport) {
        resetLoader();
        return;
      }

      const filePath = latest.filePath;
      loadContextRef.current = {
        end: latest.end,
        filePath,
        start: latest.start,
        waveformPort: latest.waveformPort,
      };

      const plan = resolveWaveformDataPlan({
        contentWidth: viewport.contentWidth,
        end: latest.end,
        filePath,
        focusSeconds: viewport.focusSeconds,
        pixelsPerSecond: viewport.pixelsPerSecond,
        scrollLeft: viewport.scrollLeft,
        start: latest.start,
        summary: latest.summary,
        viewportWidth: viewport.viewportWidth,
      });
      const scopedRequests =
        scope === "visible"
          ? plan.requests.filter((request) => request.priority === "visible")
          : plan.requests;
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

      const neededKeys = new Set(scopedRequests.map((request) => request.cacheKey));
      previousPlanSignatureRef.current = planSignature;
      latestPlanKeySetRef.current = neededKeys;
      queueRef.current = queueRef.current.filter(
        (entry) => entry.scopeKey === plan.scopeKey && neededKeys.has(entry.cacheKey),
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
      pruneWaveformTileCache(cache, neededKeys);
      pumpRef.current();
    },
    [resetLoader],
  );

  useEffect(() => {
    requestDataPlan("visible");
  }, [
    args.end,
    args.filePath,
    args.start,
    args.status,
    args.summary,
    args.tileCacheRef,
    args.waveformPort,
    requestDataPlan,
  ]);

  return requestDataPlan;
}

function useWaveformCanvasRenderer(args: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  end: number | null;
  filePath: string | null;
  start: number | null;
  status: WaveformStatus;
  summary: TrackWaveformSummary;
  tileCacheRef: RefObject<Map<string, WaveformCachedTile>>;
  viewportRef: RefObject<WaveformViewportModel | null>;
}) {
  const latestArgsRef = useRef(args);
  latestArgsRef.current = args;
  const frameIdRef = useRef<number | null>(null);
  const activeJobRef = useRef<WaveformCanvasRenderJob | null>(null);

  const runFrame = useCallback(() => {
    frameIdRef.current = null;

    const latest = latestArgsRef.current;
    const canvas = latest.canvasRef.current;
    const viewport = latest.viewportRef.current;
    if (!canvas || !viewport) {
      activeJobRef.current = null;
      return;
    }

    const ownerWindow =
      canvas.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);
    let job = activeJobRef.current;

    if (!job) {
      job = createWaveformCanvasRenderJob({
        canvas,
        end: latest.end,
        filePath: latest.filePath,
        start: latest.start,
        status: latest.status,
        summary: latest.summary,
        tileCache: latest.tileCacheRef.current,
        viewport,
      });
      activeJobRef.current = job;
    }

    if (!job) {
      return;
    }

    const completed = drawWaveformCanvasJobFrame({
      deadlineMs: readWaveformPerformanceNow(ownerWindow) + WAVEFORM_CANVAS_FRAME_BUDGET_MS,
      job,
    });

    if (completed) {
      activeJobRef.current = null;
      return;
    }

    frameIdRef.current = ownerWindow ? ownerWindow.requestAnimationFrame(runFrame) : null;

    if (!ownerWindow) {
      runFrame();
    }
  }, []);

  const requestDraw = useCallback(() => {
    activeJobRef.current = null;

    if (frameIdRef.current !== null) {
      return;
    }

    const latest = latestArgsRef.current;
    const ownerWindow =
      latest.canvasRef.current?.ownerDocument.defaultView ??
      (typeof window === "undefined" ? null : window);

    if (!ownerWindow) {
      runFrame();
      return;
    }

    frameIdRef.current = ownerWindow.requestAnimationFrame(runFrame);
  }, [runFrame]);

  useLayoutEffect(() => {
    requestDraw();
  }, [args.end, args.filePath, args.start, args.status, args.summary, requestDraw]);

  useEffect(
    () => () => {
      const latest = latestArgsRef.current;
      const ownerWindow = latest.canvasRef.current?.ownerDocument.defaultView;
      if (frameIdRef.current !== null && ownerWindow) {
        ownerWindow.cancelAnimationFrame(frameIdRef.current);
      }
      frameIdRef.current = null;
      activeJobRef.current = null;
    },
    [],
  );

  return requestDraw;
}

function createWaveformCanvasRenderJob(args: {
  canvas: HTMLCanvasElement;
  end: number | null;
  filePath: string | null;
  start: number | null;
  status: WaveformStatus;
  summary: TrackWaveformSummary;
  tileCache: Map<string, WaveformCachedTile>;
  viewport: WaveformViewportModel;
}): WaveformCanvasRenderJob | null {
  const ownerWindow = args.canvas.ownerDocument.defaultView;
  const viewportWidth = Math.max(1, Math.ceil(args.viewport.viewportWidth));
  const devicePixelRatio = clampNumber(ownerWindow?.devicePixelRatio ?? 1, 1, 3);
  const backingWidth = Math.max(1, Math.ceil(viewportWidth * devicePixelRatio));
  const backingHeight = Math.max(1, Math.ceil(WAVEFORM_CANVAS_HEIGHT * devicePixelRatio));

  if (args.canvas.width !== backingWidth) {
    args.canvas.width = backingWidth;
  }

  if (args.canvas.height !== backingHeight) {
    args.canvas.height = backingHeight;
  }

  args.canvas.style.width = `${viewportWidth}px`;
  args.canvas.style.height = `${WAVEFORM_CANVAS_HEIGHT}px`;

  const context = args.canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.resetTransform();
  context.clearRect(0, 0, backingWidth, backingHeight);
  context.scale(devicePixelRatio, devicePixelRatio);
  context.imageSmoothingEnabled = false;
  context.lineWidth = resolveWaveformBarWidthPx();
  context.lineCap = "butt";
  context.strokeStyle = readCanvasWaveformColor(args.canvas);

  if (args.status !== "ready" || !args.filePath) {
    return null;
  }

  context.globalAlpha = 0.88;

  const plan = resolveWaveformDataPlan({
    contentWidth: args.viewport.contentWidth,
    end: args.end,
    filePath: args.filePath,
    focusSeconds: args.viewport.focusSeconds,
    pixelsPerSecond: args.viewport.pixelsPerSecond,
    scrollLeft: args.viewport.scrollLeft,
    start: args.start,
    summary: args.summary,
    viewportWidth,
  });
  const levelIndexes = createWaveformLevelTileIndexes({
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
    return null;
  }

  const centerY = WAVEFORM_CANVAS_HEIGHT / 2;
  const amplitude = Math.max(1, centerY - WAVEFORM_VERTICAL_PADDING);

  return {
    amplitude,
    candidateLevels,
    centerY,
    context,
    hasDrawnColumn: false,
    nextX: 0,
    ownerWindow,
    viewport: args.viewport,
    viewportWidth,
  };
}

function drawWaveformCanvasJobFrame(args: { deadlineMs: number; job: WaveformCanvasRenderJob }) {
  const job = args.job;
  const context = job.context;
  const startX = job.nextX;
  const minChunkEndX = Math.min(job.viewportWidth, startX + WAVEFORM_CANVAS_MIN_CHUNK_WIDTH_PX);
  const maxChunkEndX = Math.min(job.viewportWidth, startX + WAVEFORM_CANVAS_MAX_CHUNK_WIDTH_PX);
  let x = startX;
  let hasChunkColumn = false;
  let resolvedPeakCount = 0;

  context.beginPath();

  for (; x < job.viewportWidth; x += 1) {
    const startSeconds = (job.viewport.scrollLeft + x) / job.viewport.pixelsPerSecond;
    const endSeconds = (job.viewport.scrollLeft + x + 1) / job.viewport.pixelsPerSecond;
    const peak = resolveWaveformPeakFromCandidateLevels({
      candidateLevels: job.candidateLevels,
      endSeconds,
      startSeconds,
      tileWidth: WAVEFORM_DATA_TILE_WIDTH,
    });

    if (peak) {
      const barX = x + 0.5;
      const yTop = job.centerY - peak.max * job.amplitude;
      const yBottom = job.centerY - peak.min * job.amplitude;

      context.moveTo(barX, yTop);
      context.lineTo(barX, Math.max(yTop + 1, yBottom));
      hasChunkColumn = true;
      job.hasDrawnColumn = true;
      resolvedPeakCount += 1;
    }

    if (
      x >= minChunkEndX &&
      (x >= maxChunkEndX || readWaveformPerformanceNow(job.ownerWindow) >= args.deadlineMs)
    ) {
      x += 1;
      break;
    }
  }

  if (hasChunkColumn) {
    context.stroke();
  }

  job.nextX = x;

  return job.nextX >= job.viewportWidth;
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
    x: isVisible ? `${Math.round(playheadX)}px` : "-9999px",
  };
}

export function handleWaveformViewportWheel(args: {
  commitViewport: (state: WaveformViewportState) => void;
  event: WheelEvent;
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

  if (!shouldPreventWaveformWheelDefault(intent)) {
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
    commitViewport: args.commitViewport,
    deltaY: intent.deltaY,
    event: args.event,
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
  commitViewport: (state: WaveformViewportState) => void;
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
  commitViewport: (state: WaveformViewportState) => void;
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
    focusSeconds: null,
    pixelsPerSecond: args.viewport.pixelsPerSecond,
    scrollLeft: targetFrame.scrollLeft,
    viewportWidth: args.viewport.viewportWidth,
  });
}

function handleWaveformZoomWheel(args: {
  commitViewport: (state: WaveformViewportState) => void;
  deltaY: number;
  event: WheelEvent;
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
  const frame = resolveWaveformZoomFrame({
    anchorViewportX,
    currentPixelsPerSecond: args.viewport.pixelsPerSecond,
    deltaY: args.deltaY,
    durationMs: args.viewport.durationMs,
    maximumPixelsPerSecond: args.viewport.maximumPixelsPerSecond,
    scrollLeft: args.viewport.scrollLeft,
    viewportWidth,
  });

  if (
    Math.abs(frame.pixelsPerSecond - args.viewport.pixelsPerSecond) < 0.01 &&
    Math.abs(frame.scrollLeft - args.viewport.scrollLeft) < 0.5
  ) {
    return;
  }

  args.commitViewport({
    focusSeconds: frame.anchorSeconds,
    pixelsPerSecond: frame.pixelsPerSecond,
    scrollLeft: frame.scrollLeft,
    viewportWidth: args.viewport.viewportWidth,
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
  const leftRank = left.priority === "visible" ? 0 : 1;
  const rightRank = right.priority === "visible" ? 0 : 1;

  return leftRank - rightRank || left.order - right.order || left.index - right.index;
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

function createWaveformLevelTileIndexes(args: {
  endSeconds: number;
  scopeKey: string;
  startSeconds: number;
  tileCache: Map<string, WaveformCachedTile>;
  tileWidth: number;
}) {
  const byLevel = new Map<number, WaveformLevelTileIndex>();
  const now = readWaveformPerformanceNow(typeof window === "undefined" ? null : window);

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

    entry.lastUsedAt = now;
    const pixelsPerSecond = Math.max(1, entry.pixelsPerSecond);
    const level = byLevel.get(pixelsPerSecond) ?? {
      pixelsPerSecond,
      tilesByIndex: new Map<number, WaveformCachedTile>(),
    };
    const tileIndex = Math.floor(entry.data.start_px / Math.max(1, args.tileWidth));
    level.tilesByIndex.set(tileIndex, entry);
    byLevel.set(pixelsPerSecond, level);
  }

  return byLevel;
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
}): WaveformPeakSample | null {
  for (const level of args.candidateLevels) {
    const peak = resolveWaveformPeakFromLevelIndex({
      endSeconds: args.endSeconds,
      level,
      startSeconds: args.startSeconds,
      tileWidth: args.tileWidth,
    });

    if (peak) {
      return peak;
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
  const tileWidth = Math.max(1, Math.ceil(args.tileWidth));
  const startIndex = Math.floor(startPx / tileWidth);
  const endIndex = Math.floor((endPx - 1) / tileWidth);
  let min = 1;
  let max = -1;
  let found = false;

  for (let tileIndex = startIndex; tileIndex <= endIndex; tileIndex += 1) {
    const entry = args.level.tilesByIndex.get(tileIndex);
    if (!entry) {
      continue;
    }

    const tilePeak = resolveWaveformTilePeakRangeAtPixels({
      endPx,
      startPx,
      tile: entry.data,
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

function resolveWaveformTilePeakRangeAtPixels(args: {
  endPx: number;
  startPx: number;
  tile: Pick<TrackWaveformTile, "max" | "min" | "start_px">;
}): WaveformPeakSample | null {
  const tilePointCount = Math.min(args.tile.min.length, args.tile.max.length);
  if (tilePointCount <= 0) {
    return null;
  }

  const startOffset = clampInteger(args.startPx - args.tile.start_px, 0, tilePointCount - 1);
  const endOffset = clampInteger(args.endPx - args.tile.start_px, startOffset + 1, tilePointCount);
  let min = 1;
  let max = -1;

  for (let offset = startOffset; offset < endOffset; offset += 1) {
    min = Math.min(min, sanitizeQuantizedPeakValue(args.tile.min[offset]) / 127);
    max = Math.max(max, sanitizeQuantizedPeakValue(args.tile.max[offset]) / 127);
  }

  return max < min ? null : { max, min };
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
      ? plan.requests.filter((request) => request.priority === "visible")
      : plan.requests;

  return [
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
  return normalizeWaveformPathKey(status.path) === normalizeWaveformPathKey(filePath);
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

function normalizeWaveformBoundary(value: number | null) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
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
    : WAVEFORM_INITIAL_PIXELS_PER_SECOND;

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
  const finiteValue = Number.isFinite(value) ? value : WAVEFORM_INITIAL_PIXELS_PER_SECOND;
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
