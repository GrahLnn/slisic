import { normalizeMediaPathKey } from "@/src/mediaPath";
import type { PlaybackStatusPayload, TrackWaveformSummary, TrackWaveformTile } from "@/src/cmd";

const WAVEFORM_VISUAL_EDGE_PADDING_SECONDS = 2;
const WAVEFORM_MIN_PIXELS_PER_SECOND = 12;
const WAVEFORM_FALLBACK_MAX_PIXELS_PER_SECOND = 320;
const WAVEFORM_FALLBACK_PIXELS_PER_SECOND = 24;
const WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM = 360;
const WAVEFORM_MAX_WHEEL_ZOOM_DELTA = WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM / 2;
const WAVEFORM_MACOS_MAGNIFICATION_SENSITIVITY = 2;
const WAVEFORM_PIXELS_PER_SECOND_PRECISION = 100;
export const WAVEFORM_CANVAS_HEIGHT = 208;
export const WAVEFORM_DATA_TILE_WIDTH = 2_048;
const WAVEFORM_DATA_OVERSCAN_VIEWPORTS = 1.25;
const WAVEFORM_INTERACTIVE_GUARD_VIEWPORTS = 0.5;
const WAVEFORM_HORIZONTAL_PAN_GUARD_VIEWPORTS = WAVEFORM_DATA_OVERSCAN_VIEWPORTS;
const WAVEFORM_VIEWPORT_POSITION_EPSILON_PX = 0.000001;

export type ProjectionResult<T, E> =
  | {
      ok: true;
      value: T;
    }
  | {
      error: E;
      ok: false;
    };

export type WaveformStatus = "idle" | "loading" | "ready" | "error";

export type WaveformTrackIdentity = {
  fileKey: string;
  filePath: string;
};

export type WaveformSelectionRange = {
  end: number | null;
  start: number | null;
};

export type WaveformSelectionGeometry = {
  endX: number;
  isComplete: boolean;
  startX: number;
};

export type WaveformSelectionMarkerLayout = {
  handleCenterX: number;
  visualLineLeftX: number;
  visualLineWidth: number;
};

export type WaveformSelectionEdge = "end" | "start";

export type WaveformSelectionDragResolution = WaveformSelectionRange;

/**
 * The active selection drag anchor is the pointer inside the host, not a frozen range.
 * Re-projecting this input through the current viewport keeps selection edits affine under pan.
 */
export type WaveformSelectionDragInput = {
  edge: WaveformSelectionEdge;
  hostRect: Pick<DOMRect, "left">;
  pointerClientX: number;
  selection: WaveformSelectionRange | null;
};

export type WaveformPresentationSelectionInput = {
  committedSelection: WaveformSelectionRange | null;
  interactiveSelection: WaveformSelectionRange | null;
  isDragging: boolean;
  previewSelection: WaveformSelectionRange | null;
};

export type WaveformPlayheadDragResolution = {
  endMs: number;
  positionMs: number;
};

/**
 * The active drag anchor is the pointer inside the host, not a frozen timeline position.
 * Re-projecting this input through the current viewport keeps the playhead affine under pan.
 */
export type WaveformPlayheadDragInput = {
  hostRect: Pick<DOMRect, "left" | "width">;
  pointerClientX: number;
  selection: WaveformSelectionRange | null;
};

export type PlaybackSnapshot = PlaybackStatusPayload & {
  received_at_ms: number;
};

export type WaveformViewportState = {
  focusSeconds: number | null;
  pixelsPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
};

export type WaveformViewportModel = WaveformViewportState & {
  contentWidth: number;
  durationMs: number;
  maximumPixelsPerSecond: number;
};

export type WaveformZoomOwnership = "explicit" | "initial-minimum" | "initial-selection";

export type WaveformInitialViewportFrame = {
  viewport: WaveformViewportModel;
  zoomOwnership: WaveformZoomOwnership;
};

export type WaveformViewportCommand =
  | {
      kind: "pan";
      deltaX: number;
    }
  | {
      anchorViewportX: number;
      deltaY: number;
      kind: "zoom";
    }
  | {
      kind: "resize";
      viewportWidth: number;
    }
  | {
      kind: "scroll-to-selection";
      leadingSpacePx: number;
      selection: WaveformSelectionRange | null;
    };

export type WaveformViewportTransition = {
  changed: boolean;
  command: WaveformViewportCommand["kind"];
  viewport: WaveformViewportModel;
};

export type WaveformSessionViewportState = {
  initialReadyViewportResolved: boolean;
  userOwned: boolean;
  viewport: WaveformViewportModel;
  zoomOwnership: WaveformZoomOwnership;
};

export type WaveformWheelDeltas = {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
};

export type WaveformWheelIntent =
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

export type WaveformDataPlanMode = "interactive" | "settled";
export type WaveformDataPlanInteraction = "default" | "horizontal-pan";
export type WaveformDataPlanScope = "complete" | "visible";
export type WaveformDataRequestPriority =
  | "overscan"
  | "prefetch-focus"
  | "prefetch-visible"
  | "prefetch-reverse"
  | "visible"
  | "visible-guard";

export type WaveformSecondsWindow = {
  endSeconds: number;
  hasAudio: boolean;
  startSeconds: number;
};

export type WaveformDataWindow = {
  endPx: number;
  startPx: number;
};

export type WaveformDataRequest = {
  cacheKey: string;
  dataPixelsPerSecond: number;
  endPx: number;
  focusDistancePx: number;
  index: number;
  priority: WaveformDataRequestPriority;
  scopeKey: string;
  startPx: number;
  widthPx: number;
};

export type WaveformDataPlan = {
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

export type WaveformTransaction = {
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

export type WaveformSessionFrame = {
  dataPlan: WaveformDataPlan | null;
  isLoading: boolean;
  playheadVisible: boolean;
  selectionVisible: boolean;
};

export type WaveformInteractiveDataDemand = {
  at: number;
  signature: string;
};

export type WaveformCachedTile = {
  data: TrackWaveformTile;
  dataPixelsPerSecond: number;
  requestKey: string;
  scopeKey: string;
};

type WaveformSharedSummaryEntry = {
  promise: Promise<TrackWaveformSummary> | null;
  state: TrackWaveformSummaryState | null;
};

export type TrackWaveformSummaryState = {
  status: WaveformStatus;
  summary: TrackWaveformSummary;
};

export type WaveformRenderDataStore = {
  summaries: Map<string, WaveformSharedSummaryEntry>;
  tileCaches: Map<string, Map<string, WaveformCachedTile>>;
  tilePromises: Map<string, Promise<TrackWaveformTile>>;
};

export type WaveformPeakSample = {
  max: number;
  min: number;
};

export function createPlaceholderWaveformSummary(): TrackWaveformSummary {
  return {
    base_points_per_second: 80,
    cache_key: "placeholder",
    chunk_duration_ms: 2_000,
    duration_ms: 8_000,
    levels: [80],
    sample_rate: 48_000,
    samples_per_point: 600,
    start_ms: 0,
  };
}

export function createWaveformRenderDataStore(): WaveformRenderDataStore {
  return {
    summaries: new Map(),
    tileCaches: new Map(),
    tilePromises: new Map(),
  };
}

export function normalizeWaveformPathKey(path: string | null | undefined) {
  return normalizeMediaPathKey(path);
}

export function projectWaveformTrackIdentity(
  filePath: string | null | undefined,
): ProjectionResult<WaveformTrackIdentity, "missing-file-path"> {
  const resolvedPath = filePath?.trim();
  const fileKey = normalizeWaveformPathKey(resolvedPath);

  return resolvedPath && fileKey
    ? {
        ok: true,
        value: {
          fileKey,
          filePath: resolvedPath,
        },
      }
    : {
        error: "missing-file-path",
        ok: false,
      };
}

export function embedWaveformTrackIdentity(identity: WaveformTrackIdentity) {
  return identity.filePath;
}

export function resolveTrackWaveformInitialStatus(filePath: string | null | undefined) {
  return projectWaveformTrackIdentity(filePath).ok ? "loading" : "idle";
}

export function createWaveformSharedTileCacheForFile(args: {
  filePath: string | null | undefined;
  store: WaveformRenderDataStore;
}) {
  const fileKey = normalizeWaveformPathKey(args.filePath);
  if (!fileKey) {
    return new Map<string, WaveformCachedTile>();
  }

  const existing = args.store.tileCaches.get(fileKey);
  if (existing) {
    return existing;
  }

  const cache = new Map<string, WaveformCachedTile>();
  args.store.tileCaches.set(fileKey, cache);
  return cache;
}

export function clampNumber(value: number, minimum: number, maximum: number) {
  const finiteValue = Number.isFinite(value) ? value : minimum;
  return Math.min(maximum, Math.max(minimum, finiteValue));
}

export function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.round(clampNumber(Math.floor(value), minimum, maximum));
}

function resolveWaveformDurationSeconds(durationMs: number) {
  return Math.max(0, durationMs) / 1000;
}

function resolveWaveformVisualDurationSeconds(durationMs: number) {
  const durationSeconds = resolveWaveformDurationSeconds(durationMs);
  return durationSeconds <= 0 ? 0 : durationSeconds + WAVEFORM_VISUAL_EDGE_PADDING_SECONDS * 2;
}

function audioSecondsToWaveformVisualSeconds(seconds: number) {
  return seconds + WAVEFORM_VISUAL_EDGE_PADDING_SECONDS;
}

function waveformVisualSecondsToAudioSeconds(seconds: number) {
  return seconds - WAVEFORM_VISUAL_EDGE_PADDING_SECONDS;
}

export function resolveWaveformMinimumPixelsPerSecond(
  constraints?: Partial<Pick<WaveformViewportModel, "durationMs" | "viewportWidth">> & {
    maximumPixelsPerSecond?: number;
  },
) {
  const durationSeconds = resolveWaveformVisualDurationSeconds(constraints?.durationMs ?? 0);
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
  constraints?: {
    maximumPixelsPerSecond?: number;
  } | null,
) {
  const maximumPixelsPerSecond = constraints?.maximumPixelsPerSecond;
  return Number.isFinite(maximumPixelsPerSecond)
    ? Math.max(WAVEFORM_MIN_PIXELS_PER_SECOND, Number(maximumPixelsPerSecond))
    : WAVEFORM_FALLBACK_MAX_PIXELS_PER_SECOND;
}

export function resolveWaveformPixelsPerSecond(
  value: number,
  constraints?: {
    durationMs: number;
    maximumPixelsPerSecond?: number;
    viewportWidth: number;
  },
) {
  const maximumPixelsPerSecond = resolveWaveformMaximumPixelsPerSecond(constraints);
  const minimumPixelsPerSecond = constraints
    ? resolveWaveformMinimumPixelsPerSecond(constraints)
    : WAVEFORM_MIN_PIXELS_PER_SECOND;

  return (
    Math.round(
      clampNumber(value, minimumPixelsPerSecond, maximumPixelsPerSecond) *
        WAVEFORM_PIXELS_PER_SECOND_PRECISION,
    ) / WAVEFORM_PIXELS_PER_SECOND_PRECISION
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

export function resolveWaveformContentWidth(args: {
  durationMs: number;
  pixelsPerSecond: number;
  viewportWidth: number;
}) {
  const viewportWidth = Math.max(1, Math.ceil(args.viewportWidth));
  const durationSeconds = resolveWaveformVisualDurationSeconds(args.durationMs);
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

export function toWaveformViewportState(viewport: WaveformViewportModel): WaveformViewportState {
  return {
    focusSeconds: viewport.focusSeconds,
    pixelsPerSecond: viewport.pixelsPerSecond,
    scrollLeft: viewport.scrollLeft,
    viewportWidth: viewport.viewportWidth,
  };
}

function areWaveformViewportsEquivalent(left: WaveformViewportModel, right: WaveformViewportModel) {
  return (
    left.durationMs === right.durationMs &&
    left.maximumPixelsPerSecond === right.maximumPixelsPerSecond &&
    left.focusSeconds === right.focusSeconds &&
    left.viewportWidth === right.viewportWidth &&
    left.contentWidth === right.contentWidth &&
    Math.abs(left.pixelsPerSecond - right.pixelsPerSecond) < 0.01 &&
    Math.abs(left.scrollLeft - right.scrollLeft) < WAVEFORM_VIEWPORT_POSITION_EPSILON_PX
  );
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

function resolveWaveformVisualScrollLeft(args: {
  audioSeconds: number;
  contentWidth: number;
  offsetPx: number;
  pixelsPerSecond: number;
  viewportWidth: number;
}) {
  return clampNumber(
    audioSecondsToWaveformVisualSeconds(args.audioSeconds) * args.pixelsPerSecond -
      Math.max(0, args.offsetPx),
    0,
    Math.max(0, args.contentWidth - args.viewportWidth),
  );
}

export function resolveCenteredWaveformScrollLeft(args: {
  centerSeconds: number;
  contentWidth: number;
  pixelsPerSecond: number;
  viewportWidth: number;
}) {
  return resolveWaveformVisualScrollLeft({
    audioSeconds: args.centerSeconds,
    contentWidth: args.contentWidth,
    offsetPx: args.viewportWidth / 2,
    pixelsPerSecond: args.pixelsPerSecond,
    viewportWidth: args.viewportWidth,
  });
}

export function resolveAnchoredWaveformScrollLeft(args: {
  anchorSeconds: number;
  anchorViewportX: number;
  contentWidth: number;
  pixelsPerSecond: number;
  viewportWidth: number;
}) {
  return resolveWaveformVisualScrollLeft({
    audioSeconds: args.anchorSeconds,
    contentWidth: args.contentWidth,
    offsetPx: args.anchorViewportX,
    pixelsPerSecond: args.pixelsPerSecond,
    viewportWidth: args.viewportWidth,
  });
}

function normalizeWaveformSelectionBoundary(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

export function resolveWaveformSelectionStartScrollLeft(args: {
  contentWidth: number;
  leadingSpacePx: number;
  pixelsPerSecond: number;
  selection: WaveformSelectionRange | null;
  viewportWidth: number;
}) {
  const startSeconds = normalizeWaveformSelectionBoundary(args.selection?.start);
  if (startSeconds === null) {
    return 0;
  }

  return resolveWaveformVisualScrollLeft({
    audioSeconds: startSeconds,
    contentWidth: args.contentWidth,
    offsetPx: args.leadingSpacePx,
    pixelsPerSecond: args.pixelsPerSecond,
    viewportWidth: args.viewportWidth,
  });
}

function resolveCompleteWaveformSelection(args: {
  durationMs: number;
  selection: WaveformSelectionRange | null;
}) {
  const durationSeconds = resolveWaveformDurationSeconds(args.durationMs);
  const startSeconds = normalizeWaveformSelectionBoundary(args.selection?.start);
  const endSeconds = normalizeWaveformSelectionBoundary(args.selection?.end);
  if (
    durationSeconds <= 0 ||
    startSeconds === null ||
    endSeconds === null ||
    endSeconds <= startSeconds
  ) {
    return null;
  }

  const start = clampNumber(startSeconds, 0, durationSeconds);
  const end = clampNumber(endSeconds, start, durationSeconds);
  return end > start
    ? {
        end,
        start,
      }
    : null;
}

export function resolveWaveformInitialViewportFrame(args: {
  durationMs: number;
  maximumPixelsPerSecond: number;
  selection: WaveformSelectionRange | null;
  viewportWidth: number;
}): WaveformInitialViewportFrame {
  const viewportWidth = Math.max(1, Math.ceil(args.viewportWidth));
  const completeSelection = resolveCompleteWaveformSelection({
    durationMs: args.durationMs,
    selection: args.selection,
  });
  if (!completeSelection) {
    return {
      viewport: resolveWaveformViewportModel({
        durationMs: args.durationMs,
        focusSeconds: null,
        maximumPixelsPerSecond: args.maximumPixelsPerSecond,
        pixelsPerSecond: resolveWaveformMinimumPixelsPerSecond({
          durationMs: args.durationMs,
          maximumPixelsPerSecond: args.maximumPixelsPerSecond,
          viewportWidth,
        }),
        scrollLeft: 0,
        viewportWidth,
      }),
      zoomOwnership: "initial-minimum",
    };
  }

  const leftAudioSeconds = Math.max(
    -WAVEFORM_VISUAL_EDGE_PADDING_SECONDS,
    completeSelection.start - WAVEFORM_VISUAL_EDGE_PADDING_SECONDS,
  );
  const leftVisualSeconds = audioSecondsToWaveformVisualSeconds(leftAudioSeconds);
  const rightVisualSeconds = audioSecondsToWaveformVisualSeconds(completeSelection.end);
  const visibleVisualSeconds = Math.max(
    1 / WAVEFORM_PIXELS_PER_SECOND_PRECISION,
    rightVisualSeconds - leftVisualSeconds,
  );
  const pixelsPerSecond = resolveWaveformPixelsPerSecond(viewportWidth / visibleVisualSeconds, {
    durationMs: args.durationMs,
    maximumPixelsPerSecond: args.maximumPixelsPerSecond,
    viewportWidth,
  });

  return {
    viewport: resolveWaveformViewportModel({
      durationMs: args.durationMs,
      focusSeconds: null,
      maximumPixelsPerSecond: args.maximumPixelsPerSecond,
      pixelsPerSecond,
      scrollLeft: leftVisualSeconds * pixelsPerSecond,
      viewportWidth,
    }),
    zoomOwnership: "initial-selection",
  };
}

export function resolveWaveformInitialViewport(args: {
  durationMs: number;
  maximumPixelsPerSecond: number;
  selection: WaveformSelectionRange | null;
  viewportWidth: number;
}): WaveformViewportModel {
  return resolveWaveformInitialViewportFrame(args).viewport;
}

export function resolveWaveformSessionViewportFrame(args: {
  elementWidth: number;
  initialSelection: WaveformSelectionRange | null;
  maximumPixelsPerSecond: number;
  state: WaveformSessionViewportState;
  summary: Pick<TrackWaveformSummary, "duration_ms">;
  waveformStatus: WaveformStatus;
}): WaveformSessionViewportState {
  if (
    args.state.zoomOwnership === "initial-minimum" &&
    !args.state.userOwned &&
    !args.state.initialReadyViewportResolved &&
    args.waveformStatus === "ready" &&
    args.elementWidth > 1
  ) {
    const frame = resolveWaveformInitialViewportFrame({
      durationMs: args.summary.duration_ms,
      maximumPixelsPerSecond: args.maximumPixelsPerSecond,
      selection: args.initialSelection,
      viewportWidth: args.elementWidth,
    });

    return {
      initialReadyViewportResolved: true,
      userOwned: args.state.userOwned,
      viewport: frame.viewport,
      zoomOwnership: frame.zoomOwnership,
    };
  }

  const resizeState = resolveWaveformResizeViewportState({
    current: args.state.viewport,
    viewportWidth: args.elementWidth,
  });
  const viewport = resolveWaveformViewportModel({
    durationMs: args.summary.duration_ms,
    focusSeconds: resizeState.focusSeconds,
    maximumPixelsPerSecond: args.maximumPixelsPerSecond,
    pixelsPerSecond: resolveWaveformZoomOwnedPixelsPerSecond({
      durationMs: args.summary.duration_ms,
      maximumPixelsPerSecond: args.maximumPixelsPerSecond,
      ownership: args.state.zoomOwnership,
      pixelsPerSecond: resizeState.pixelsPerSecond,
      viewportWidth: resizeState.viewportWidth,
    }),
    scrollLeft: resizeState.scrollLeft,
    viewportWidth: resizeState.viewportWidth,
  });

  return areWaveformViewportsEquivalent(viewport, args.state.viewport)
    ? args.state
    : {
        ...args.state,
        viewport,
      };
}

export function resolveWaveformViewportAudioSeconds(args: {
  pixelsPerSecond: number;
  scrollLeft: number;
  viewportX: number;
}) {
  return waveformVisualSecondsToAudioSeconds(
    (args.scrollLeft + args.viewportX) / Math.max(1, args.pixelsPerSecond),
  );
}

export function secondsToWaveformViewportX(args: {
  seconds: number;
  viewport: WaveformViewportModel;
}) {
  return (
    audioSecondsToWaveformVisualSeconds(args.seconds) * args.viewport.pixelsPerSecond -
    args.viewport.scrollLeft
  );
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

export function clampWaveformZoomDeltaY(deltaY: number) {
  return clampNumber(deltaY, -WAVEFORM_MAX_WHEEL_ZOOM_DELTA, WAVEFORM_MAX_WHEEL_ZOOM_DELTA);
}

export function resolveWaveformWheelPixelsPerSecond(args: {
  currentPixelsPerSecond: number;
  deltaY: number;
  durationMs: number;
  maximumPixelsPerSecond: number;
  viewportWidth: number;
}) {
  if (!Number.isFinite(args.deltaY) || args.deltaY === 0) {
    return resolveWaveformPixelsPerSecond(args.currentPixelsPerSecond, args);
  }

  const scale = 2 ** (-clampWaveformZoomDeltaY(args.deltaY) / WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM);
  return resolveWaveformPixelsPerSecond(args.currentPixelsPerSecond * scale, args);
}

export function resolveWaveformMagnificationDeltaY(args: { previousScale: number; scale: number }) {
  if (
    !Number.isFinite(args.previousScale) ||
    !Number.isFinite(args.scale) ||
    args.previousScale <= 0 ||
    args.scale <= 0
  ) {
    return 0;
  }

  return (
    -WAVEFORM_WHEEL_DELTA_FOR_DOUBLE_ZOOM *
    Math.log2(args.scale / args.previousScale) *
    WAVEFORM_MACOS_MAGNIFICATION_SENSITIVITY
  );
}

export function resolveWaveformPointerAnchorViewportX(args: {
  clientX: number;
  viewportLeft: number;
  viewportWidth: number;
}) {
  return clampNumber(args.clientX - args.viewportLeft, 0, Math.max(1, args.viewportWidth));
}

export function resolveWaveformZoomFrame(args: {
  anchorViewportX: number;
  currentPixelsPerSecond: number;
  deltaY: number;
  durationMs: number;
  maximumPixelsPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
}) {
  const anchorVisualSeconds =
    (args.scrollLeft + args.anchorViewportX) / Math.max(1, args.currentPixelsPerSecond);
  const pixelsPerSecond = resolveWaveformWheelPixelsPerSecond({
    currentPixelsPerSecond: args.currentPixelsPerSecond,
    deltaY: args.deltaY,
    durationMs: args.durationMs,
    maximumPixelsPerSecond: args.maximumPixelsPerSecond,
    viewportWidth: args.viewportWidth,
  });
  const contentWidth = resolveWaveformContentWidth({
    durationMs: args.durationMs,
    pixelsPerSecond,
    viewportWidth: args.viewportWidth,
  });
  const scrollLeft = clampNumber(
    anchorVisualSeconds * pixelsPerSecond - args.anchorViewportX,
    0,
    Math.max(0, contentWidth - args.viewportWidth),
  );

  return {
    anchorVisualSeconds,
    contentWidth,
    focusSeconds: clampNumber(
      waveformVisualSecondsToAudioSeconds(anchorVisualSeconds),
      0,
      resolveWaveformDurationSeconds(args.durationMs),
    ),
    pixelsPerSecond,
    scrollLeft,
  };
}

export function resolveWaveformViewportTransition(args: {
  command: WaveformViewportCommand;
  current: WaveformViewportModel;
}): WaveformViewportTransition {
  const command = args.command;
  const current = args.current;
  let next: WaveformViewportModel;

  if (command.kind === "resize") {
    next = resolveWaveformViewportModel({
      ...current,
      viewportWidth: command.viewportWidth,
    });
  } else if (command.kind === "pan") {
    next = resolveWaveformViewportModel({
      ...current,
      focusSeconds: null,
      scrollLeft: resolveWaveformHorizontalScrollLeft({
        contentWidth: current.contentWidth,
        deltaX: command.deltaX,
        scrollLeft: current.scrollLeft,
        viewportWidth: current.viewportWidth,
      }),
    });
  } else if (command.kind === "zoom") {
    const frame = resolveWaveformZoomFrame({
      anchorViewportX: command.anchorViewportX,
      currentPixelsPerSecond: current.pixelsPerSecond,
      deltaY: command.deltaY,
      durationMs: current.durationMs,
      maximumPixelsPerSecond: current.maximumPixelsPerSecond,
      scrollLeft: current.scrollLeft,
      viewportWidth: current.viewportWidth,
    });
    next = resolveWaveformViewportModel({
      durationMs: current.durationMs,
      focusSeconds: frame.focusSeconds,
      maximumPixelsPerSecond: current.maximumPixelsPerSecond,
      pixelsPerSecond: frame.pixelsPerSecond,
      scrollLeft: frame.scrollLeft,
      viewportWidth: current.viewportWidth,
    });
  } else {
    next = resolveWaveformViewportModel({
      ...current,
      scrollLeft: resolveWaveformSelectionStartScrollLeft({
        contentWidth: current.contentWidth,
        leadingSpacePx: command.leadingSpacePx,
        pixelsPerSecond: current.pixelsPerSecond,
        selection: command.selection,
        viewportWidth: current.viewportWidth,
      }),
    });
  }

  const changed =
    current.focusSeconds !== next.focusSeconds ||
    Math.abs(current.pixelsPerSecond - next.pixelsPerSecond) >= 0.01 ||
    Math.abs(current.scrollLeft - next.scrollLeft) >= 0.5 ||
    current.viewportWidth !== next.viewportWidth ||
    current.contentWidth !== next.contentWidth;

  return {
    changed,
    command: command.kind,
    viewport: changed ? next : current,
  };
}

function resolveFiniteWheelDelta(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

export function resolveWaveformWheelAxisDeltas(
  args: WaveformWheelDeltas & {
    ctrlKey?: boolean;
    macosGestures?: boolean;
    shiftKey?: boolean;
  },
): WaveformWheelDeltas {
  if (args.macosGestures === true) {
    if (args.ctrlKey === true) {
      return {
        deltaMode: args.deltaMode,
        deltaX: 0,
        deltaY: args.deltaY * WAVEFORM_MACOS_MAGNIFICATION_SENSITIVITY,
      };
    }

    if (args.deltaX !== 0) {
      return {
        deltaMode: args.deltaMode,
        deltaX: args.deltaX,
        deltaY: 0,
      };
    }
  }

  return args.shiftKey === true && args.deltaY !== 0
    ? {
        deltaMode: args.deltaMode,
        deltaX: args.deltaY,
        deltaY: 0,
      }
    : {
        deltaMode: args.deltaMode,
        deltaX: 0,
        deltaY: args.deltaY,
      };
}

function normalizeWheelDelta(args: { delta: number; deltaMode: number; viewportSize: number }) {
  if (args.deltaMode === 1) {
    return args.delta * 16;
  }

  if (args.deltaMode === 2) {
    return args.delta * Math.max(1, args.viewportSize);
  }

  return args.delta;
}

export function resolveWaveformWheelPixelDeltas(
  args: WaveformWheelDeltas & {
    viewportHeight: number;
    viewportWidth: number;
  },
) {
  return {
    deltaX: normalizeWheelDelta({
      delta: args.deltaX,
      deltaMode: args.deltaMode,
      viewportSize: args.viewportWidth,
    }),
    deltaY: normalizeWheelDelta({
      delta: args.deltaY,
      deltaMode: args.deltaMode,
      viewportSize: args.viewportHeight,
    }),
  };
}

export function resolveWaveformWheelIntent(args: {
  deltaX: number;
  deltaY: number;
}): WaveformWheelIntent {
  if (args.deltaX !== 0) {
    return {
      deltaX: args.deltaX,
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

export function resolveWaveformWheelOperation(
  args: WaveformWheelDeltas & {
    ctrlKey?: boolean;
    macosGestures?: boolean;
    shiftKey?: boolean;
    viewportHeight: number;
    viewportWidth: number;
  },
) {
  return resolveWaveformWheelIntent(
    resolveWaveformWheelPixelDeltas({
      ...resolveWaveformWheelAxisDeltas(args),
      viewportHeight: args.viewportHeight,
      viewportWidth: args.viewportWidth,
    }),
  );
}

export function shouldPreventWaveformWheelDefault(intent: WaveformWheelIntent) {
  return intent.kind !== "none";
}

export function resolveWaveformHardwareHorizontalWheelDelta(args: { deltaX?: number | null }) {
  return resolveFiniteWheelDelta(args.deltaX);
}

export function shouldAcceptWaveformHardwareHorizontalWheel(args: {
  clientX?: number | null;
  clientY?: number | null;
  host: Pick<Element, "getBoundingClientRect"> | null;
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

function sortWaveformLevels(summary: TrackWaveformSummary) {
  const levels = summary.levels.filter((level) => Number.isFinite(level) && level > 0);
  levels.sort((left, right) => left - right);
  return levels.length > 0 ? levels : [summary.base_points_per_second || 80];
}

export function resolveWaveformRenderPixelsPerSecond(args: {
  pixelsPerSecond?: number;
  summary: TrackWaveformSummary;
}) {
  const levels = sortWaveformLevels(args.summary);
  const target = Math.max(1, args.pixelsPerSecond ?? WAVEFORM_FALLBACK_PIXELS_PER_SECOND);
  return levels.find((level) => level >= target) ?? levels[levels.length - 1];
}

export function resolveWaveformMaximumRenderPixelsPerSecond(summary: TrackWaveformSummary) {
  return sortWaveformLevels(summary).at(-1) ?? WAVEFORM_FALLBACK_MAX_PIXELS_PER_SECOND;
}

export function resolveWaveformDataScopeKey(args: {
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
    (Math.round(args.pixelsPerSecond * 100) / 100).toFixed(2),
    Math.max(0, Math.floor(args.startPx)),
    Math.max(1, Math.ceil(args.widthPx)),
  ].join("|");
}

function resolveWaveformVisibleSecondsWindow(args: {
  durationSeconds: number;
  overscanViewports: number;
  pixelsPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
}): WaveformSecondsWindow {
  const overscanSeconds =
    (Math.max(0, args.overscanViewports) * Math.max(1, args.viewportWidth)) /
    Math.max(1, args.pixelsPerSecond);
  const rawStart =
    waveformVisualSecondsToAudioSeconds(args.scrollLeft / Math.max(1, args.pixelsPerSecond)) -
    overscanSeconds;
  const rawEnd =
    waveformVisualSecondsToAudioSeconds(
      (args.scrollLeft + Math.max(1, args.viewportWidth)) / Math.max(1, args.pixelsPerSecond),
    ) + overscanSeconds;
  const startSeconds = clampNumber(rawStart, 0, args.durationSeconds);
  const endSeconds = clampNumber(rawEnd, 0, args.durationSeconds);

  return {
    endSeconds,
    hasAudio: endSeconds > startSeconds,
    startSeconds,
  };
}

export function resolveWaveformDataWindow(args: {
  dataContentWidth: number;
  dataPixelsPerSecond: number;
  window: WaveformSecondsWindow;
}): WaveformDataWindow {
  if (!args.window.hasAudio) {
    const point = clampInteger(
      Math.floor(args.window.startSeconds * Math.max(1, args.dataPixelsPerSecond)),
      0,
      Math.max(0, args.dataContentWidth),
    );
    return {
      endPx: point,
      startPx: point,
    };
  }

  const startPx = clampInteger(
    Math.floor(args.window.startSeconds * Math.max(1, args.dataPixelsPerSecond)),
    0,
    Math.max(0, args.dataContentWidth),
  );
  const endPx = clampInteger(
    Math.ceil(args.window.endSeconds * Math.max(1, args.dataPixelsPerSecond)),
    startPx,
    Math.max(0, args.dataContentWidth),
  );

  return {
    endPx,
    startPx,
  };
}

export function resolveWaveformDataTileIndexes(args: {
  tileWidth: number;
  window: WaveformDataWindow;
}) {
  const tileWidth = Math.max(1, Math.ceil(args.tileWidth));
  if (args.window.endPx <= args.window.startPx) {
    return [];
  }

  const indexes: number[] = [];
  const firstIndex = Math.floor(args.window.startPx / tileWidth);
  const lastIndex = Math.floor((args.window.endPx - 1) / tileWidth);
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    indexes.push(index);
  }
  return indexes;
}

function createWaveformDataRequestsForWindow(args: {
  dataContentWidth: number;
  dataPixelsPerSecond: number;
  focusSeconds: number;
  priority: WaveformDataRequestPriority;
  scopeKey: string;
  tileWidth: number;
  window: WaveformDataWindow;
}) {
  return resolveWaveformDataTileIndexes({
    tileWidth: args.tileWidth,
    window: args.window,
  }).map((index) => {
    const startPx = index * args.tileWidth;
    const widthPx = Math.max(1, Math.min(args.tileWidth, args.dataContentWidth - startPx));
    return {
      cacheKey: createWaveformDataRequestKey({
        pixelsPerSecond: args.dataPixelsPerSecond,
        scopeKey: args.scopeKey,
        startPx,
        widthPx,
      }),
      dataPixelsPerSecond: args.dataPixelsPerSecond,
      endPx: startPx + widthPx,
      focusDistancePx: Math.abs(
        startPx + widthPx / 2 - args.focusSeconds * args.dataPixelsPerSecond,
      ),
      index,
      priority: args.priority,
      scopeKey: args.scopeKey,
      startPx,
      widthPx,
    } satisfies WaveformDataRequest;
  });
}

function priorityRank(priority: WaveformDataRequestPriority) {
  switch (priority) {
    case "visible":
      return 0;
    case "visible-guard":
      return 1;
    case "prefetch-visible":
      return 2;
    case "prefetch-focus":
      return 3;
    case "prefetch-reverse":
      return 3;
    case "overscan":
      return 4;
  }
}

function dedupeWaveformDataRequests(requests: WaveformDataRequest[]) {
  const byKey = new Map<string, WaveformDataRequest>();
  for (const request of requests) {
    const existing = byKey.get(request.cacheKey);
    if (
      !existing ||
      priorityRank(request.priority) < priorityRank(existing.priority) ||
      request.focusDistancePx < existing.focusDistancePx
    ) {
      byKey.set(request.cacheKey, request);
    }
  }

  return Array.from(byKey.values()).sort(
    (left, right) =>
      priorityRank(left.priority) - priorityRank(right.priority) ||
      left.focusDistancePx - right.focusDistancePx ||
      left.index - right.index ||
      left.dataPixelsPerSecond - right.dataPixelsPerSecond,
  );
}

export function resolveWaveformDataPlan(args: {
  contentWidth: number;
  filePath: string | null;
  focusSeconds: number | null;
  interaction?: WaveformDataPlanInteraction;
  mode?: WaveformDataPlanMode;
  pixelsPerSecond: number;
  scrollLeft: number;
  summary: TrackWaveformSummary;
  tileWidth?: number;
  viewportWidth: number;
}): WaveformDataPlan {
  const tileWidth = Math.max(1, Math.ceil(args.tileWidth ?? WAVEFORM_DATA_TILE_WIDTH));
  const dataPixelsPerSecond = resolveWaveformRenderPixelsPerSecond({
    pixelsPerSecond: args.pixelsPerSecond,
    summary: args.summary,
  });
  const mode = args.mode ?? "settled";
  const durationSeconds = resolveWaveformDurationSeconds(args.summary.duration_ms);
  const dataContentWidth = Math.max(1, Math.ceil(durationSeconds * dataPixelsPerSecond));
  const scopeKey = resolveWaveformDataScopeKey({
    filePath: args.filePath,
    summary: args.summary,
  });
  const guardViewports =
    mode === "interactive"
      ? args.interaction === "horizontal-pan"
        ? WAVEFORM_HORIZONTAL_PAN_GUARD_VIEWPORTS
        : WAVEFORM_INTERACTIVE_GUARD_VIEWPORTS
      : 0;
  const visibleSecondsWindow = resolveWaveformVisibleSecondsWindow({
    durationSeconds,
    overscanViewports: 0,
    pixelsPerSecond: args.pixelsPerSecond,
    scrollLeft: args.scrollLeft,
    viewportWidth: args.viewportWidth,
  });
  const guardSecondsWindow = resolveWaveformVisibleSecondsWindow({
    durationSeconds,
    overscanViewports: guardViewports,
    pixelsPerSecond: args.pixelsPerSecond,
    scrollLeft: args.scrollLeft,
    viewportWidth: args.viewportWidth,
  });
  const overscanSecondsWindow = resolveWaveformVisibleSecondsWindow({
    durationSeconds,
    overscanViewports: mode === "settled" ? WAVEFORM_DATA_OVERSCAN_VIEWPORTS : guardViewports,
    pixelsPerSecond: args.pixelsPerSecond,
    scrollLeft: args.scrollLeft,
    viewportWidth: args.viewportWidth,
  });
  const visibleWindow = resolveWaveformDataWindow({
    dataContentWidth,
    dataPixelsPerSecond,
    window: visibleSecondsWindow,
  });
  const guardWindow = resolveWaveformDataWindow({
    dataContentWidth,
    dataPixelsPerSecond,
    window: guardSecondsWindow,
  });
  const overscanWindow = resolveWaveformDataWindow({
    dataContentWidth,
    dataPixelsPerSecond,
    window: overscanSecondsWindow,
  });
  const visibleIndexes = resolveWaveformDataTileIndexes({
    tileWidth,
    window: visibleWindow,
  });
  const visibleIndexSet = new Set(visibleIndexes);
  const focusSeconds =
    typeof args.focusSeconds === "number" && Number.isFinite(args.focusSeconds)
      ? clampNumber(args.focusSeconds, 0, durationSeconds)
      : (visibleSecondsWindow.startSeconds + visibleSecondsWindow.endSeconds) / 2;
  const visibleRequests = createWaveformDataRequestsForWindow({
    dataContentWidth,
    dataPixelsPerSecond,
    focusSeconds,
    priority: "visible",
    scopeKey,
    tileWidth,
    window: visibleWindow,
  });
  const guardRequests = createWaveformDataRequestsForWindow({
    dataContentWidth,
    dataPixelsPerSecond,
    focusSeconds,
    priority: "visible-guard",
    scopeKey,
    tileWidth,
    window: guardWindow,
  }).filter((request) => !visibleIndexSet.has(request.index));
  const overscanRequests =
    mode === "settled"
      ? createWaveformDataRequestsForWindow({
          dataContentWidth,
          dataPixelsPerSecond,
          focusSeconds,
          priority: "overscan",
          scopeKey,
          tileWidth,
          window: overscanWindow,
        }).filter((request) => !visibleIndexSet.has(request.index))
      : [];
  const requests = dedupeWaveformDataRequests([
    ...visibleRequests,
    ...guardRequests,
    ...overscanRequests,
  ]);

  return {
    dataContentWidth,
    dataPixelsPerSecond,
    mode,
    overscanSecondsWindow,
    overscanWindow,
    protectedCacheKeys: requests.map((request) => request.cacheKey),
    requests,
    scopeKey,
    visibleIndexes,
    visibleSecondsWindow,
    visibleWindow,
  };
}

export function resolveWaveformDataPlanScopedRequests(
  plan: WaveformDataPlan,
  scope: WaveformDataPlanScope,
) {
  return scope === "visible"
    ? plan.requests.filter(
        (request) => request.priority === "visible" || request.priority === "visible-guard",
      )
    : plan.requests;
}

export function shouldPresentWaveformTileAvailability(priority: WaveformDataRequestPriority) {
  return priority === "visible" || priority === "visible-guard";
}

export function resolveWaveformTileLoadResultPolicy(args: {
  activeScopeKey: string | null;
  presentationRequestKeys: ReadonlySet<string>;
  requestCacheKey: string;
  requestScopeKey: string;
}) {
  const shouldCache = args.activeScopeKey === args.requestScopeKey;
  return {
    shouldCache,
    shouldRequestPresentation:
      shouldCache && args.presentationRequestKeys.has(args.requestCacheKey),
  };
}

export function resolveWaveformTileRequestStartPolicy(args: { hasCachedTile: boolean }) {
  return {
    rejection: args.hasCachedTile ? ("already-cached" as const) : null,
    shouldLoad: !args.hasCachedTile,
    shouldRequestPresentation: false,
  };
}

function createWaveformDataDemandSignature(plan: WaveformDataPlan | null) {
  if (!plan) {
    return "";
  }

  return plan.requests
    .filter((request) => shouldPresentWaveformTileAvailability(request.priority))
    .map((request) => request.cacheKey)
    .join("\n");
}

export function resolveWaveformTransaction(args: {
  lastInteractiveDataDemand: WaveformInteractiveDataDemand | null;
  mode: WaveformDataPlanMode;
  now: number;
  plan: WaveformDataPlan | null;
}) {
  const signature = createWaveformDataDemandSignature(args.plan);
  const shouldSkipInteractiveDemand =
    args.mode === "interactive" &&
    args.lastInteractiveDataDemand !== null &&
    args.lastInteractiveDataDemand.signature === signature &&
    args.now - args.lastInteractiveDataDemand.at < 64;
  const nextInteractiveDataDemand =
    args.mode === "interactive" && args.plan !== null && !shouldSkipInteractiveDemand
      ? {
          at: args.now,
          signature,
        }
      : args.mode === "interactive"
        ? args.lastInteractiveDataDemand
        : null;

  return {
    nextInteractiveDataDemand,
    nextInteractiveDataDemandAt: nextInteractiveDataDemand?.at ?? null,
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
    } satisfies WaveformTransaction,
  };
}

export function resolveWaveformTileAvailabilityPresentationPlan(args: {
  currentPlan: WaveformDataPlan | null;
  signal: Pick<WaveformDataPlan, "scopeKey">;
}) {
  return args.currentPlan?.scopeKey === args.signal.scopeKey ? args.currentPlan : null;
}

export function resolveWaveformSessionFrame(args: {
  filePath: string | null | undefined;
  playheadEnabled: boolean;
  summary: TrackWaveformSummary;
  tileAvailabilitySignal?: Pick<WaveformDataPlan, "scopeKey"> | null;
  viewport: WaveformViewportModel;
  waveformStatus: WaveformStatus;
}): WaveformSessionFrame {
  const identity = projectWaveformTrackIdentity(args.filePath);
  const isReady = args.waveformStatus === "ready" && identity.ok;
  const dataPlan = isReady
    ? resolveWaveformDataPlan({
        contentWidth: args.viewport.contentWidth,
        filePath: identity.value.filePath,
        focusSeconds: args.viewport.focusSeconds,
        mode: "settled",
        pixelsPerSecond: args.viewport.pixelsPerSecond,
        scrollLeft: args.viewport.scrollLeft,
        summary: args.summary,
        viewportWidth: args.viewport.viewportWidth,
      })
    : null;
  const presentationPlan = args.tileAvailabilitySignal
    ? resolveWaveformTileAvailabilityPresentationPlan({
        currentPlan: dataPlan,
        signal: args.tileAvailabilitySignal,
      })
    : dataPlan;
  const isLoading = args.waveformStatus === "loading";

  return {
    dataPlan: presentationPlan,
    isLoading,
    playheadVisible: args.playheadEnabled && !isLoading,
    selectionVisible: !isLoading,
  };
}

export function resolveWaveformSelectionGeometry(args: {
  selection: WaveformSelectionRange | null;
  viewport: WaveformViewportModel;
}): WaveformSelectionGeometry {
  const durationSeconds = resolveWaveformDurationSeconds(args.viewport.durationMs);
  const startSeconds = normalizeWaveformSelectionBoundary(args.selection?.start);
  const endSeconds = normalizeWaveformSelectionBoundary(args.selection?.end);
  if (
    startSeconds === null ||
    endSeconds === null ||
    endSeconds <= startSeconds ||
    durationSeconds <= 0
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

export function resolveWaveformSelectionMarkerLayout(args: {
  devicePixelRatio?: number | null;
  x: number;
}): WaveformSelectionMarkerLayout {
  const handleCenterX = Number.isFinite(args.x) ? args.x : 0;
  const devicePixelRatio =
    typeof args.devicePixelRatio === "number" && Number.isFinite(args.devicePixelRatio)
      ? Math.max(1, args.devicePixelRatio)
      : 1;
  const visualLinePhysicalWidth = Math.max(1, Math.round(devicePixelRatio));
  const visualLineWidth = visualLinePhysicalWidth / devicePixelRatio;
  const visualLineLeftX =
    Math.round((handleCenterX - visualLineWidth / 2) * devicePixelRatio) / devicePixelRatio;

  return {
    handleCenterX,
    visualLineLeftX,
    visualLineWidth,
  };
}

export function areWaveformSelectionsEqual(
  left: WaveformSelectionRange | null,
  right: WaveformSelectionRange | null,
) {
  return left?.start === right?.start && left?.end === right?.end;
}

export function resolveWaveformPresentationSelection(
  args: WaveformPresentationSelectionInput,
): WaveformSelectionRange | null {
  if (args.previewSelection !== null) {
    return args.previewSelection;
  }

  return args.isDragging ? args.interactiveSelection : args.committedSelection;
}

export function resolveWaveformSelectionDrag(args: {
  edge: WaveformSelectionEdge;
  hostRect: Pick<DOMRect, "left">;
  pointerClientX: number;
  selection: WaveformSelectionRange | null;
  viewport: WaveformViewportModel;
}): WaveformSelectionDragResolution {
  const durationSeconds = resolveWaveformDurationSeconds(args.viewport.durationMs);
  const currentStart = normalizeWaveformSelectionBoundary(args.selection?.start) ?? 0;
  const currentEnd = normalizeWaveformSelectionBoundary(args.selection?.end) ?? durationSeconds;
  const pointerSeconds = clampNumber(
    resolveWaveformViewportAudioSeconds({
      pixelsPerSecond: args.viewport.pixelsPerSecond,
      scrollLeft: args.viewport.scrollLeft,
      viewportX: args.pointerClientX - args.hostRect.left,
    }),
    0,
    durationSeconds,
  );
  const rangeStart = Math.min(currentStart, currentEnd);
  const rangeEnd = Math.max(currentStart, currentEnd);

  return args.edge === "start"
    ? {
        end: rangeEnd,
        start: clampNumber(pointerSeconds, 0, rangeEnd),
      }
    : {
        end: clampNumber(pointerSeconds, rangeStart, durationSeconds),
        start: rangeStart,
      };
}

export function resolveWaveformSelectionDragPreview(args: {
  input: WaveformSelectionDragInput | null;
  viewport: WaveformViewportModel;
}): WaveformSelectionDragResolution | null {
  if (args.input === null) {
    return null;
  }

  return resolveWaveformSelectionDrag({
    ...args.input,
    viewport: args.viewport,
  });
}

export function resolveWaveformPlayheadDrag(args: {
  hostRect: Pick<DOMRect, "left" | "width">;
  pointerClientX: number;
  selection: WaveformSelectionRange | null;
  viewport: WaveformViewportModel;
}): WaveformPlayheadDragResolution | null {
  const startSeconds = normalizeWaveformSelectionBoundary(args.selection?.start);
  const endSeconds = normalizeWaveformSelectionBoundary(args.selection?.end);
  if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) {
    return null;
  }

  const viewportX = clampNumber(args.pointerClientX - args.hostRect.left, 0, args.hostRect.width);
  const targetSeconds = clampNumber(
    resolveWaveformViewportAudioSeconds({
      pixelsPerSecond: args.viewport.pixelsPerSecond,
      scrollLeft: args.viewport.scrollLeft,
      viewportX,
    }),
    startSeconds,
    endSeconds,
  );

  return {
    endMs: Math.round(endSeconds * 1_000),
    positionMs: Math.round(targetSeconds * 1_000),
  };
}

export function resolveWaveformPlayheadDragPreview(args: {
  input: WaveformPlayheadDragInput | null;
  viewport: WaveformViewportModel;
}): WaveformPlayheadDragResolution | null {
  if (args.input === null) {
    return null;
  }

  return resolveWaveformPlayheadDrag({
    ...args.input,
    viewport: args.viewport,
  });
}

export function resolvePlaybackPositionMs(args: {
  durationMs: number;
  nowMs: number;
  snapshot: PlaybackSnapshot | null;
}) {
  if (!args.snapshot) {
    return null;
  }

  const elapsedMs =
    args.snapshot.playing && !args.snapshot.paused ? args.nowMs - args.snapshot.received_at_ms : 0;
  return clampNumber(args.snapshot.position_ms + elapsedMs, 0, Math.max(0, args.durationMs));
}

export function resolvePlaybackSnapshotPausedAtNow(args: {
  durationMs: number;
  nowMs: number;
  snapshot: PlaybackSnapshot | null;
}): PlaybackSnapshot | null {
  if (!args.snapshot) {
    return null;
  }

  if (!args.snapshot.playing || args.snapshot.paused) {
    return args.snapshot;
  }

  return {
    ...args.snapshot,
    paused: true,
    position_ms: resolvePlaybackPositionMs(args) ?? args.snapshot.position_ms,
    received_at_ms: args.nowMs,
  };
}

export function resolvePlaybackSnapshotAfterStatusCommit(args: {
  localPlaybackSnapshot: PlaybackSnapshot | null;
  nextSnapshot: PlaybackSnapshot | null;
}) {
  if (
    args.localPlaybackSnapshot === null ||
    args.nextSnapshot === null ||
    !arePlaybackSnapshotsSamePlaybackSegment(args.localPlaybackSnapshot, args.nextSnapshot)
  ) {
    return args.nextSnapshot;
  }

  if (args.localPlaybackSnapshot.paused || args.nextSnapshot.paused) {
    return args.localPlaybackSnapshot;
  }

  return resolvePlaybackSnapshotAbsolutePositionMs(args.nextSnapshot) <
    resolvePlaybackSnapshotAbsolutePositionMs(args.localPlaybackSnapshot)
    ? args.localPlaybackSnapshot
    : args.nextSnapshot;
}

function resolvePlaybackSnapshotAbsolutePositionMs(snapshot: PlaybackSnapshot) {
  return Math.max(0, (snapshot.playback_start_ms ?? 0) + snapshot.position_ms);
}

export function arePlaybackSnapshotsSamePlaybackSegment(
  left: PlaybackSnapshot,
  right: PlaybackSnapshot,
) {
  return (
    left.path === right.path &&
    left.playlist_name === right.playlist_name &&
    left.music_url === right.music_url &&
    left.track_start_ms === right.track_start_ms &&
    left.track_end_ms === right.track_end_ms &&
    left.playback_start_ms === right.playback_start_ms &&
    left.playback_end_ms === right.playback_end_ms
  );
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

  return typeof args.snapshot?.duration_ms === "number" &&
    Number.isFinite(args.snapshot.duration_ms)
    ? args.snapshot.duration_ms
    : args.fallbackDurationMs;
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

  return (
    audioSecondsToWaveformVisualSeconds(args.playbackStartMs / 1000 + args.positionMs / 1000) *
      args.pixelsPerSecond -
    args.scrollLeft
  );
}

export function resolveWaveformPlayheadCssVariables(args: {
  playbackStartMs: number | null;
  pixelsPerSecond: number;
  positionMs: number | null;
  scrollLeft: number;
  viewportWidth: number;
}) {
  const playheadX = resolveWaveformPlayheadX(args);
  const isVisible =
    playheadX !== null && playheadX >= 0 && playheadX <= Math.max(1, args.viewportWidth);

  return {
    opacity: isVisible ? "0.86" : "0",
    x: isVisible ? `${Math.round(playheadX)}px` : "-9999px",
  };
}

export function resolveQuantizedWaveformDisplayPeak(args: {
  max: readonly number[];
  min: readonly number[];
  offset: number;
}) {
  const offset = clampInteger(args.offset, 0, Math.min(args.min.length, args.max.length) - 1);
  return {
    max: clampNumber(args.max[offset] ?? 0, -127, 127) / 127,
    min: clampNumber(args.min[offset] ?? 0, -127, 127) / 127,
  };
}

export function resolveWaveformTilePeakRangeAtPixels(args: {
  endPx: number;
  startPx: number;
  tile: Pick<TrackWaveformTile, "max" | "min" | "start_px">;
}): WaveformPeakSample | null {
  const pointCount = Math.min(args.tile.max.length, args.tile.min.length);
  if (pointCount <= 0) {
    return null;
  }

  const tileStartPx = args.tile.start_px;
  const tileEndPx = tileStartPx + pointCount;
  const startPx = Math.max(args.startPx, tileStartPx);
  const endPx = Math.min(args.endPx, tileEndPx);
  if (endPx <= startPx) {
    return null;
  }

  const startOffset = clampInteger(Math.floor(startPx) - tileStartPx, 0, pointCount - 1);
  const endOffset = clampInteger(Math.ceil(endPx) - tileStartPx, startOffset + 1, pointCount);
  let max = -1;
  let min = 1;
  for (let offset = startOffset; offset < endOffset; offset += 1) {
    const peak = resolveQuantizedWaveformDisplayPeak({
      max: args.tile.max,
      min: args.tile.min,
      offset,
    });
    max = Math.max(max, peak.max);
    min = Math.min(min, peak.min);
  }

  return max < min ? null : { max, min };
}

export function resolveWaveformTilePeakAtSeconds(args: {
  pixelsPerSecond: number;
  seconds: number;
  tile: Pick<TrackWaveformTile, "max" | "min" | "start_px">;
}) {
  const pixelX = Math.floor(Math.max(0, args.seconds) * Math.max(1, args.pixelsPerSecond));
  return resolveWaveformTilePeakRangeAtPixels({
    endPx: pixelX + 1,
    startPx: pixelX,
    tile: args.tile,
  });
}

export function resolveWaveformPeakFromTileCache(args: {
  cache: ReadonlyMap<string, WaveformCachedTile>;
  endSeconds: number;
  plan: WaveformDataPlan;
  startSeconds: number;
}) {
  if (args.endSeconds <= 0 || args.endSeconds <= args.startSeconds) {
    return null;
  }

  const startPx = Math.max(0, Math.floor(args.startSeconds * args.plan.dataPixelsPerSecond));
  const endPx = Math.max(startPx + 1, Math.ceil(args.endSeconds * args.plan.dataPixelsPerSecond));
  const startIndex = Math.floor(startPx / WAVEFORM_DATA_TILE_WIDTH);
  const endIndex = Math.floor((endPx - 1) / WAVEFORM_DATA_TILE_WIDTH);
  let max = -1;
  let min = 1;
  let found = false;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const tileStartPx = index * WAVEFORM_DATA_TILE_WIDTH;
    const widthPx = Math.max(
      1,
      Math.min(WAVEFORM_DATA_TILE_WIDTH, args.plan.dataContentWidth - tileStartPx),
    );
    const key = createWaveformDataRequestKey({
      pixelsPerSecond: args.plan.dataPixelsPerSecond,
      scopeKey: args.plan.scopeKey,
      startPx: tileStartPx,
      widthPx,
    });
    const tile = args.cache.get(key)?.data;
    if (!tile) {
      continue;
    }

    const peak = resolveWaveformTilePeakRangeAtPixels({
      endPx,
      startPx,
      tile,
    });
    if (!peak) {
      continue;
    }

    max = Math.max(max, peak.max);
    min = Math.min(min, peak.min);
    found = true;
  }

  return found ? { max, min } : null;
}
