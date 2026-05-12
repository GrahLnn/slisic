import {
  useCallback,
  useEffect,
  useId,
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
  isRenderPerformanceTraceInstalled,
  recordRenderPerformanceTrace,
} from "@/src/debug/renderPerformanceTrace";
import {
  accumulateSpectrumCanvasFastPresentationMetrics,
  accumulateSpectrumCanvasRenderEmptyMetrics,
  accumulateSpectrumCanvasRenderJobMetrics,
  createSpectrumCanvasFastPresentationMetrics,
  createSpectrumCanvasRenderEmptyMetrics,
  createSpectrumCanvasRenderJobMetrics,
  createSpectrumCanvasRenderJobTracePayload,
  flushDueSpectrumCanvasFastPresentationMetrics,
  flushDueSpectrumCanvasRenderEmptyMetrics,
  flushSpectrumCanvasFastPresentationMetrics,
  flushSpectrumCanvasRenderEmptyMetrics,
  summarizeSpectrumCanvasColumnRanges,
  summarizeSpectrumCanvasColumnTraceResults,
  type SpectrumCanvasFastPresentationMetrics,
  type SpectrumCanvasRenderEmptyMetrics,
  type SpectrumCanvasRenderJobMetrics,
  type SpectrumCanvasRenderJobTraceReason,
} from "./SpectrumCanvasTrace.model";
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
const WAVEFORM_HORIZONTAL_PAN_DATA_GUARD_VIEWPORTS = WAVEFORM_DATA_OVERSCAN_VIEWPORTS;
const WAVEFORM_DATA_PREFETCH_REVERSE_LEVEL_COUNT = 3;
const WAVEFORM_DATA_PREFETCH_VISIBLE_LEVEL_COUNT = 1;
const WAVEFORM_DATA_PREFETCH_FOCUS_LEVEL_COUNT = 3;
const WAVEFORM_CANVAS_FRAME_BUDGET_MS = 3.25;
const WAVEFORM_CANVAS_MIN_CHUNK_WIDTH_PX = 96;
const WAVEFORM_CANVAS_MAX_CHUNK_WIDTH_PX = 320;
const WAVEFORM_CANVAS_RETAINED_VIEWPORTS = 1;
const WAVEFORM_CANVAS_PROGRESSIVE_PASSES = [
  { startOffsetX: 0, stepX: 4 },
  { startOffsetX: 2, stepX: 4 },
  { startOffsetX: 1, stepX: 2 },
] as const;
const WAVEFORM_CANVAS_REUSE_MIN_SHIFT_PX = 1;
const WAVEFORM_CANVAS_STROKE_ALPHA = 0.88;
const WAVEFORM_CANVAS_FAST_PRESENTATION_TRACE_FLUSH_MS = 1_000;
const WAVEFORM_CANVAS_DIAGNOSTIC_TRACE_FLUSH_MS = 500;
const WAVEFORM_BAR_PRESENTATION_ANIMATION_DURATION_MS = 140;
const WAVEFORM_PAN_PRESENTATION_DURATION_MS = 140;
const WAVEFORM_PAN_PRESENTATION_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const WAVEFORM_CANVAS_PAN_PRESENTATION_TRANSITION = resolveWaveformPanPresentationTransition([
  "transform",
]);
const WAVEFORM_OVERLAY_PAN_PRESENTATION_TRANSITION = resolveWaveformPanPresentationTransition([
  "transform",
  "width",
  "left",
]);
const waveformOverlayPanPresentationTimeouts = new WeakMap<HTMLElement, number>();
const WAVEFORM_SELECTION_START_LEADING_SPACE_PX = 96;
const WAVEFORM_VISUAL_EDGE_PADDING_SECONDS = 2;
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

export type TrackSpectrumPlaybackStatusCommit = (status: PlaybackStatusPayload | null) => void;

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
  anchorVisualSeconds: number;
  anchorViewportX: number;
  contentWidth: number;
  focusSeconds: number;
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

type WaveformAudioViewportWindow = WaveformSecondsWindow & {
  hasAudio: boolean;
};

type WaveformDataRequestPriority =
  | "visible"
  | "visible-guard"
  | "prefetch-reverse"
  | "prefetch-focus"
  | "prefetch-visible"
  | "overscan";

type WaveformDataPlanInteraction = "default" | "horizontal-pan";
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
  overscanSecondsWindow: WaveformAudioViewportWindow;
  overscanWindow: WaveformDataWindow;
  protectedCacheKeys: string[];
  requests: WaveformDataRequest[];
  scopeKey: string;
  visibleIndexes: number[];
  visibleSecondsWindow: WaveformAudioViewportWindow;
  visibleWindow: WaveformDataWindow;
};

type WaveformDataPlanScope = "visible" | "complete";

type WaveformDataPlanRequest = {
  plan: WaveformDataPlan;
  scope: WaveformDataPlanScope;
};

type WaveformTileAvailabilitySignal = {
  cacheKey: string;
  priority: WaveformDataRequestPriority;
  scopeKey: string;
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
  interaction?: WaveformDataPlanInteraction;
  mode?: WaveformInteractionMode;
  state: WaveformViewportState;
};

type WaveformPanPresentationStart = {
  animate: boolean;
  hasDirtyRanges: boolean;
  shiftX: number;
};

type WaveformCanvasDrawOptions = {
  canStartHorizontalPanPresentation?: (presentation: WaveformPanPresentationStart) => boolean;
  onHorizontalPanPresentationCancel?: () => void;
  onHorizontalPanPresentationPrepare?: (presentation: WaveformPanPresentationStart) => void;
  onHorizontalPanPresentationStart?: (presentation: WaveformPanPresentationStart) => void;
};

type WaveformCanvasDrawResult =
  | {
      kind: "horizontal-pan-presentation-scheduled";
    }
  | {
      kind: "none";
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

type WaveformTileLoadResultPolicy = {
  shouldCache: boolean;
  shouldRequestPresentation: boolean;
};

type WaveformDataPipelineTraceMetrics = {
  cacheHitCount: number;
  cacheStoreCount: number;
  droppedResultCount: number;
  firstPlanSignature: string | null;
  firstScope: WaveformDataPlanScope | null;
  firstScopeKey: string | null;
  firstTraceAt: number | null;
  inFlightSkipCount: number;
  lastAcceptedPlanSignature: string | null;
  lastArrivalCacheKey: string | null;
  lastArrivalPriority: WaveformDataRequestPriority | null;
  lastPlanSignature: string | null;
  lastScope: WaveformDataPlanScope | null;
  lastScopeKey: string | null;
  nextFlushAt: number | null;
  presentationArrivalCount: number;
  presentationRequestKeyCount: number;
  queuedCount: number;
  requestCount: number;
  reusedPlanCount: number;
  scheduledCount: number;
};

type WaveformInitialPrepareHandle = {
  cancel: () => void;
} | null;

type WaveformPlayheadController = {
  beginPlayheadDrag: () => void;
  cancelPlayheadDrag: () => void;
  commitPlayheadDrag: (resolution: WaveformPlayheadDragResolution) => Promise<void>;
  commitPlaybackStatus: TrackSpectrumPlaybackStatusCommit;
  holdPresentationViewport: (viewport: WaveformViewportModel | null) => void;
  previewPlayheadDrag: (resolution: WaveformPlayheadDragResolution | null) => void;
  syncPlayhead: () => void;
  syncPlayheadForViewport: (viewport: WaveformViewportModel) => void;
};

const inertWaveformPlayheadController: WaveformPlayheadController = {
  beginPlayheadDrag: () => undefined,
  cancelPlayheadDrag: () => undefined,
  commitPlayheadDrag: async () => undefined,
  commitPlaybackStatus: () => undefined,
  holdPresentationViewport: () => undefined,
  previewPlayheadDrag: () => undefined,
  syncPlayhead: () => undefined,
  syncPlayheadForViewport: () => undefined,
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
  tileKeysByIndex: Map<number, string>;
  tilesByIndex: Map<number, TrackWaveformTile>;
};

type WaveformPeakSample = {
  max: number;
  min: number;
};

type WaveformPeakRangeResolution = {
  fullyCovered: boolean;
  peak: WaveformPeakSample;
};

type WaveformCanvasFrameGeometry = {
  backingHeight: number;
  backingWidth: number;
  devicePixelRatio: number;
  rasterStartX: number;
  rasterWidth: number;
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
  visibleSecondsWindow: WaveformAudioViewportWindow;
  visibleWindow: WaveformDataWindow;
};

type WaveformCanvasFrameDescriptor = {
  color: string;
  dataPixelsPerSecond: number;
  dataSignature: string;
  geometry: WaveformCanvasFrameGeometry;
  renderSignature: string;
  scopeKey: string;
  viewport: WaveformViewportModel;
  visualSignature: string;
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
  canvas: HTMLCanvasElement;
  color: string;
  context: CanvasRenderingContext2D;
  geometry: WaveformCanvasFrameGeometry;
};

type WaveformCanvasBufferedRasterTarget = WaveformCanvasRasterTargetBase & {
  kind: "visible";
};

type WaveformCanvasRasterTarget = WaveformCanvasBufferedRasterTarget;

type WaveformCanvasRenderJobCompletion =
  | {
      dirtyRanges: WaveformCanvasColumnRange[];
      kind: "committed";
    }
  | {
      kind: "empty";
      reason: "missing-context";
    };

type WaveformCanvasRasterTargetEmpty = {
  geometry: WaveformCanvasFrameGeometry;
  kind: "missing-context";
};

type WaveformCanvasRasterTargetResolution =
  | {
      empty: WaveformCanvasRasterTargetEmpty;
      kind: "empty";
    }
  | {
      kind: "ready";
      target: WaveformCanvasRasterTarget;
    };

type WaveformCanvasRenderCursor = {
  drawnRanges: WaveformCanvasColumnRange[];
  firstMissingX: number | null;
  hasDrawnColumn: boolean;
  lastMissingX: number | null;
  missingRanges: WaveformCanvasColumnRange[];
  missingPeakColumnCount: number;
  passIndex: number;
  nextX: number;
  rangeComposition: WaveformCanvasRangeComposition;
  ranges: WaveformCanvasColumnRange[] | null;
  rangeIndex: number;
  retargetRanges: WaveformCanvasColumnRange[];
  resolvedPeakColumnCount: number;
  schedule: WaveformCanvasCursorSchedule;
};

type WaveformCanvasRangeComposition = "coalesced" | "direct" | "none";

type WaveformCanvasCursorSchedule = "full-density" | "progressive";

type WaveformCanvasChunkResult = {
  completed: boolean;
  cursor: WaveformCanvasRenderCursor;
  drawnRanges: WaveformCanvasColumnRange[];
  firstMissingX: number | null;
  hasChunkColumn: boolean;
  lastMissingX: number | null;
  missingRanges: WaveformCanvasColumnRange[];
  missingPeakColumns: number;
  resolvedPeakCount: number;
  scannedColumns: number;
  trace: WaveformCanvasChunkBehaviorTracePayload | null;
};

type WaveformCanvasColumnRangeResult = {
  firstMissingX: number | null;
  hasColumn: boolean;
  lastMissingX: number | null;
  missingPeakColumns: number;
  resolvedPeakCount: number;
  scannedColumns: number;
};

type WaveformCanvasPresentationRenderPlan = Omit<WaveformCanvasRenderPlan, "viewport"> & {
  viewport: WaveformViewportModel;
};

type WaveformCanvasRangeDrawResult = WaveformCanvasColumnRangeResult & {
  drawnRanges: WaveformCanvasColumnRange[];
  missingRanges: WaveformCanvasColumnRange[];
};

type WaveformCanvasColumnRange = {
  endX: number;
  startX: number;
};

type WaveformCanvasCoverageRangeUpdate = {
  drawnRanges: readonly WaveformCanvasColumnRange[];
  missingRanges: readonly WaveformCanvasColumnRange[];
};

type WaveformCanvasColumnScanPass = {
  startOffsetX: number;
  stepX: number;
};

type WaveformCanvasColumnSample = {
  levelPixelsPerSecond: number;
  peak: WaveformPeakSample;
  targetDensityResolved: boolean;
};

type WaveformBarPresentationModel = {
  anchorViewportX?: number | null;
  anchorVisualSeconds?: number | null;
  pixelsPerSecond: number;
  scrollLeft: number;
};

type WaveformBarPresentationAnimation = {
  durationMs: number;
  from: WaveformBarPresentationModel;
  startedAtMs: number;
  to: WaveformBarPresentationModel;
};

type WaveformCanvasColumnRangeDrawPlan = WaveformCanvasRangeDrawResult & {
  peaksByX: Map<number, WaveformCanvasColumnSample>;
};

type WaveformCanvasColumnRangeRenderPlan = WaveformCanvasColumnRangeDrawPlan & {
  columnPaths: Map<number, WaveformCanvasColumnPath>;
};

type WaveformCanvasColumnPath = {
  barX: number;
  height: number;
  yBottom: number;
  yTop: number;
};

type WaveformCanvasBarTraceSample = {
  barX: number;
  height: number;
  levelPixelsPerSecond: number | null;
  targetDensityResolved: boolean | null;
  x: number;
  yBottom: number;
  yTop: number;
};

type WaveformCanvasBarTraceSummary = {
  averageSpacingPx: number | null;
  barCount: number;
  fallbackDensityCount: number;
  firstBarX: number | null;
  firstX: number | null;
  lastBarX: number | null;
  lastX: number | null;
  levelCounts: Array<{
    count: number;
    pixelsPerSecond: number;
  }>;
  maxBarX: number | null;
  maxSpacingPx: number | null;
  minBarX: number | null;
  minSpacingPx: number | null;
  sample: WaveformCanvasBarTraceSample[];
  targetDensityResolvedCount: number;
};

type WaveformCanvasFastPresentationCommand = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  descriptor: WaveformCanvasFrameDescriptor;
  descriptorPlan: WaveformCanvasRenderPlan;
  plan: Exclude<WaveformCanvasFastPresentationPlan, { kind: "none" }>;
  previousGeometry: WaveformCanvasFrameGeometry;
  previousDirtyRanges: readonly WaveformCanvasColumnRange[];
  reuseFrame: HTMLCanvasElement;
};

type WaveformCanvasJobChunkCommand = {
  collectTrace?: boolean;
  cursor: WaveformCanvasRenderCursor;
  deadlineMs: number;
  now: () => number;
  plan: WaveformCanvasRenderPlan;
  replaceExistingColumns?: boolean;
  target: WaveformCanvasRasterTarget;
};

type WaveformCanvasRenderEffectCommand =
  | {
      kind: "prepare-job-target";
      presentation: WaveformCanvasRenderPresentation;
      target: WaveformCanvasRasterTarget;
    }
  | {
      command: WaveformCanvasFastPresentationCommand;
      kind: "fast-presentation";
    }
  | {
      command: WaveformCanvasJobChunkCommand;
      kind: "job-chunk";
    }
  | {
      kind: "column-range";
      plan: WaveformCanvasRenderPlan;
      range: WaveformCanvasColumnRange | null;
      replaceExistingColumns?: boolean;
      target: WaveformCanvasRasterTarget;
    };

type WaveformCanvasPixelColumnStatus =
  | "blank-without-plan-data"
  | "drawn-fallback-density"
  | "drawn-target-covered"
  | "drawn-target-undercovered"
  | "drawn-without-plan-data"
  | "target-density-blank";

type WaveformCanvasPixelColumnProbeCounts = Record<WaveformCanvasPixelColumnStatus, number>;

type WaveformCanvasPixelColumnProbeWindowSource = "configured-viewport" | "dom-visible" | "raster";

type WaveformCanvasPixelColumnProbeWindow = {
  counts: WaveformCanvasPixelColumnProbeCounts;
  endX: number;
  firstNonTargetX: number | null;
  lastNonTargetX: number | null;
  sampleCount: number;
  source: WaveformCanvasPixelColumnProbeWindowSource;
  startX: number;
};

type WaveformCanvasPixelColumnReadback = {
  context: CanvasRenderingContext2D;
  height: number;
  width: number;
};

type WaveformCanvasFastPresentationResult =
  | {
      dirtyRanges: WaveformCanvasColumnRange[];
      draws: WaveformCanvasRangeDrawResult[];
      exposedRanges: WaveformCanvasColumnRange[];
      descriptor: WaveformCanvasFrameDescriptor;
      exposedWidthPx: number;
      kind: "presented";
      mode: "dirty-redraw";
      plan: Extract<WaveformCanvasFrameReusePlan, { kind: "dirty-redraw" }>;
      reuseFrame: HTMLCanvasElement;
    }
  | {
      dirtyRanges: WaveformCanvasColumnRange[];
      draws: WaveformCanvasRangeDrawResult[];
      exposedRanges: WaveformCanvasColumnRange[];
      descriptor: WaveformCanvasFrameDescriptor;
      exposedWidthPx: number;
      kind: "presented";
      mode: "horizontal-pan";
      plan: Extract<WaveformCanvasFrameReusePlan, { kind: "horizontal-pan" }>;
      reuseFrame: HTMLCanvasElement;
    }
  | {
      dirtyRanges: WaveformCanvasColumnRange[];
      draws: WaveformCanvasRangeDrawResult[];
      exposedRanges: WaveformCanvasColumnRange[];
      descriptor: WaveformCanvasFrameDescriptor;
      exposedWidthPx: number;
      kind: "presented";
      mode: "viewport-resize";
      plan: Extract<WaveformCanvasFrameReusePlan, { kind: "viewport-resize" }>;
      reuseFrame: HTMLCanvasElement;
    }
  | {
      dirtyRanges: WaveformCanvasColumnRange[];
      draws: WaveformCanvasRangeDrawResult[];
      exposedRanges: WaveformCanvasColumnRange[];
      descriptor: WaveformCanvasFrameDescriptor;
      exposedWidthPx: number;
      insertionRanges: WaveformCanvasColumnRange[];
      insertionWidthPx: number;
      kind: "presented";
      mode: "zoom-affine";
      plan: Extract<WaveformCanvasFrameReusePlan, { kind: "zoom-affine" }>;
      reuseFrame: HTMLCanvasElement;
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
  | Extract<WaveformCanvasFrameReusePlan, { kind: "dirty-redraw" }>
  | Extract<WaveformCanvasFrameReusePlan, { kind: "horizontal-pan" }>
  | Extract<WaveformCanvasFrameReusePlan, { kind: "viewport-resize" }>
  | Extract<WaveformCanvasFrameReusePlan, { kind: "zoom-affine" }>
  | Extract<WaveformCanvasFrameReusePlan, { kind: "none" }>;

type WaveformCanvasRenderJob = {
  coverageTrace: WaveformCanvasRenderPlanCoverageTracePayload;
  cursor: WaveformCanvasRenderCursor;
  descriptor: WaveformCanvasFrameDescriptor;
  id: number;
  metrics: SpectrumCanvasRenderJobMetrics;
  plan: WaveformCanvasRenderPlan;
  presentation: WaveformCanvasRenderPresentation;
  retargeted: boolean;
  revision: number;
  target: WaveformCanvasRasterTarget;
};

type WaveformCanvasBarPresentationFrame = {
  isAnimating: boolean;
};

type WaveformCanvasRenderTraceJobLifecycle = "initial-mount" | "update";

type WaveformCanvasRendererTraceState = {
  jobCauses: Map<number, WaveformCanvasRenderRequestTraceCause>;
  jobLifecycles: Map<number, WaveformCanvasRenderTraceJobLifecycle>;
  jobStartCount: number;
  pendingJobCause: WaveformCanvasRenderRequestTraceCause | null;
  requestCount: number;
};

type WaveformCanvasRenderRequestTraceCause =
  | "data-change"
  | "density-change"
  | "empty"
  | "geometry-change"
  | "initial-mount"
  | "repeat"
  | "request-transition"
  | "scope-change"
  | "scroll";

type WaveformCanvasChunkLimitReason = "deadline" | "max-width" | "range-end";

type WaveformCanvasChunkBehaviorTracePayload = ReturnType<
  typeof createWaveformCanvasChunkBehaviorTracePayload
>;

type WaveformCanvasRenderPresentation =
  | {
      kind: "fresh";
    }
  | {
      descriptor: WaveformCanvasFrameDescriptor;
      dirtyRanges: WaveformCanvasColumnRange[];
      kind: "dirty";
    }
  | {
      descriptor: WaveformCanvasFrameDescriptor;
      insertionRanges: WaveformCanvasColumnRange[];
      kind: "insertion";
    };

type WaveformCanvasRenderController = {
  barPresentationAnimation: WaveformBarPresentationAnimation | null;
  barPresentationModel: WaveformBarPresentationModel | null;
  dataPlan: WaveformDataPlan | null;
  frameId: number | null;
  fastPresentationMetrics: SpectrumCanvasFastPresentationMetrics;
  job: WaveformCanvasRenderJob | null;
  panPresentationFrameId: number | null;
  panPresentationTargetFrame: WaveformCanvasFrameDescriptor | null;
  panPresentationTimeoutId: number | null;
  reusableFrame: WaveformCanvasFrameDescriptor | null;
  presentedFrame: WaveformCanvasFrameDescriptor | null;
  presentedDirtyRanges: WaveformCanvasColumnRange[];
  renderSchedule: WaveformCanvasCursorSchedule;
  renderPresentation: WaveformCanvasRenderPresentation;
  requestedFrame: WaveformCanvasFrameDescriptor | null;
  requestedRevision: number;
  renderEmptyMetrics: SpectrumCanvasRenderEmptyMetrics;
  reuseFrame: HTMLCanvasElement | null;
  traceState: WaveformCanvasRendererTraceState;
};

type WaveformTracePlanSource = "data-demand" | "effect" | "presentation" | "tile-availability";

type WaveformCanvasFrameReusePlan =
  | {
      dirtyRanges: WaveformCanvasColumnRange[];
      kind: "dirty-redraw";
    }
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
      anchorViewportX: number;
      anchorVisualSeconds: number;
      dirtyRanges: WaveformCanvasColumnRange[];
      exposedRanges: WaveformCanvasColumnRange[];
      kind: "zoom-affine";
      scaleX: number;
      sourceOffsetX: number;
      targetOffsetX: number;
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

type WaveformCanvasRenderPlanCoverageTracePayload = {
  audioWindowEndSeconds: number;
  audioWindowStartSeconds: number;
  availableLevels: number[];
  candidateLevels: {
    dataPixelsPerSecond: number;
    firstTileIndex: number | null;
    lastTileIndex: number | null;
    tileCount: number;
    tileIndexSample: number[];
  }[];
  dataPixelsPerSecond: number;
  missingTargetTileIndexes: number[];
  missingTargetTileRangeCount: number;
  missingTargetTileRanges: WaveformTileIndexRange[];
  rasterAudioWindowEndSeconds: number;
  rasterAudioWindowStartSeconds: number;
  targetLevelTileCount: number;
  targetLevelTileIndexSample: number[];
  targetLevelTileRangeCount: number;
  targetLevelTileRanges: WaveformTileIndexRange[];
  targetTileEndIndex: number | null;
  targetTileStartIndex: number | null;
};

type WaveformTileIndexRange = {
  endIndex: number;
  startIndex: number;
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

function resolveWaveformAnchoredVisualScrollLeft(args: {
  contentWidth: number;
  offsetPx: number;
  pixelsPerSecond: number;
  viewportWidth: number;
  visualSeconds: number;
}) {
  return clampNumber(
    args.visualSeconds * args.pixelsPerSecond - Math.max(0, args.offsetPx),
    0,
    Math.max(0, args.contentWidth - args.viewportWidth),
  );
}

function resolveWaveformViewportAudioSeconds(args: {
  pixelsPerSecond: number;
  scrollLeft: number;
  viewportX: number;
}) {
  const visualSeconds = (args.scrollLeft + args.viewportX) / Math.max(1, args.pixelsPerSecond);

  return waveformVisualSecondsToAudioSeconds(visualSeconds);
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

  return resolveWaveformVisualScrollLeft({
    audioSeconds: startSeconds,
    contentWidth: args.contentWidth,
    offsetPx: args.leadingSpacePx,
    pixelsPerSecond: args.pixelsPerSecond,
    viewportWidth: args.viewportWidth,
  });
}

export function resolveWaveformInitialSelectionViewportAnchor(args: {
  cacheKey: string;
  filePath: string | null;
  previousAnchorKey: string | null;
  selection: WaveformSelectionRange | null;
  status: WaveformStatus;
}) {
  const filePath = args.filePath?.trim() || null;
  const startSeconds = normalizeWaveformSelectionBoundary(args.selection?.start ?? null);
  if (args.status !== "ready" || !filePath || startSeconds === null) {
    return null;
  }

  const anchorKey = [normalizeWaveformPathKey(filePath), args.cacheKey].join("|");

  return args.previousAnchorKey === anchorKey
    ? null
    : {
        anchorKey,
        selection: args.selection,
      };
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

export function resolveWaveformPanPresentationTransform(shiftX: number) {
  const resolvedShiftX = Number.isFinite(shiftX) ? shiftX : 0;

  return `translate3d(${-resolvedShiftX}px, 0, 0)`;
}

export function resolveWaveformPanPresentationTransition(properties: readonly string[]) {
  return properties
    .map(
      (property) =>
        `${property} ${WAVEFORM_PAN_PRESENTATION_DURATION_MS}ms ${WAVEFORM_PAN_PRESENTATION_EASING}`,
    )
    .join(", ");
}

export function shouldStartWaveformHorizontalPanPresentation(args: {
  hasDirtyRanges: boolean;
  pendingScrollDeltaPx: number | null;
  shiftX: number;
}) {
  const shiftX = Number.isFinite(args.shiftX) ? args.shiftX : 0;

  return (
    !args.hasDirtyRanges &&
    args.pendingScrollDeltaPx !== null &&
    args.pendingScrollDeltaPx === -shiftX
  );
}

function resolveWaveformCanvasDescriptorVisualSecondsAtViewportX(args: {
  descriptor: WaveformCanvasFrameDescriptor;
  viewportX: number;
}) {
  return (
    (args.descriptor.viewport.scrollLeft + args.viewportX) /
    Math.max(1, args.descriptor.viewport.pixelsPerSecond)
  );
}

function resolveWaveformCanvasZoomAffineReusePlan(args: {
  current: WaveformCanvasFrameDescriptor;
  dirtyRanges: readonly WaveformCanvasColumnRange[];
  previous: WaveformCanvasFrameDescriptor;
}): Extract<WaveformCanvasFrameReusePlan, { kind: "zoom-affine" }> | null {
  if (
    args.previous.geometry.backingWidth !== args.current.geometry.backingWidth ||
    args.previous.geometry.rasterStartX !== args.current.geometry.rasterStartX ||
    args.previous.geometry.rasterWidth !== args.current.geometry.rasterWidth ||
    args.previous.geometry.viewportWidth !== args.current.geometry.viewportWidth
  ) {
    return null;
  }

  const previousPixelsPerSecond = Math.max(1, args.previous.viewport.pixelsPerSecond);
  const currentPixelsPerSecond = Math.max(1, args.current.viewport.pixelsPerSecond);
  const scaleX = currentPixelsPerSecond / previousPixelsPerSecond;

  if (!Number.isFinite(scaleX) || scaleX <= 0 || Math.abs(scaleX - 1) < 0.0001) {
    return null;
  }

  const previousRasterEndX = resolveWaveformCanvasRasterEndX(args.previous.geometry);
  const currentRasterEndX = resolveWaveformCanvasRasterEndX(args.current.geometry);
  const sharedVisualStartSeconds = Math.max(
    resolveWaveformCanvasDescriptorVisualSecondsAtViewportX({
      descriptor: args.previous,
      viewportX: args.previous.geometry.rasterStartX,
    }),
    resolveWaveformCanvasDescriptorVisualSecondsAtViewportX({
      descriptor: args.current,
      viewportX: args.current.geometry.rasterStartX,
    }),
  );
  const sharedVisualEndSeconds = Math.min(
    resolveWaveformCanvasDescriptorVisualSecondsAtViewportX({
      descriptor: args.previous,
      viewportX: previousRasterEndX,
    }),
    resolveWaveformCanvasDescriptorVisualSecondsAtViewportX({
      descriptor: args.current,
      viewportX: currentRasterEndX,
    }),
  );

  if (sharedVisualEndSeconds <= sharedVisualStartSeconds) {
    return null;
  }

  const targetStartX = Math.floor(
    sharedVisualStartSeconds * currentPixelsPerSecond - args.current.viewport.scrollLeft,
  );
  const targetEndX = Math.ceil(
    sharedVisualEndSeconds * currentPixelsPerSecond - args.current.viewport.scrollLeft,
  );
  const retainedRange = normalizeWaveformCanvasColumnRange({
    geometry: args.current.geometry,
    range: {
      endX: targetEndX,
      startX: targetStartX,
    },
  });

  if (!retainedRange) {
    return null;
  }

  const sourceOffsetX = args.previous.geometry.rasterStartX + args.previous.viewport.scrollLeft;
  const targetOffsetX = args.current.geometry.rasterStartX + args.current.viewport.scrollLeft;
  const durationVisualSeconds = resolveWaveformVisualDurationSeconds(
    args.current.viewport.durationMs,
  );
  const anchorVisualSeconds = clampNumber(
    typeof args.current.viewport.focusSeconds === "number" &&
      Number.isFinite(args.current.viewport.focusSeconds)
      ? audioSecondsToWaveformVisualSeconds(args.current.viewport.focusSeconds)
      : sharedVisualStartSeconds + (sharedVisualEndSeconds - sharedVisualStartSeconds) / 2,
    0,
    durationVisualSeconds,
  );
  const anchorViewportX =
    anchorVisualSeconds * currentPixelsPerSecond - args.current.viewport.scrollLeft;
  const exposedRanges = normalizeWaveformCanvasColumnRanges({
    geometry: args.current.geometry,
    ranges: [
      {
        endX: retainedRange.startX,
        startX: args.current.geometry.rasterStartX,
      },
      {
        endX: currentRasterEndX,
        startX: retainedRange.endX,
      },
    ],
  });
  const dirtyRanges = normalizeWaveformCanvasColumnRanges({
    geometry: args.current.geometry,
    ranges: args.dirtyRanges,
  });

  return {
    anchorViewportX,
    anchorVisualSeconds,
    dirtyRanges,
    exposedRanges,
    kind: "zoom-affine",
    scaleX,
    sourceOffsetX,
    targetOffsetX,
  };
}

export function resolveWaveformCanvasFrameReusePlan(args: {
  current: WaveformCanvasFrameDescriptor;
  dirtyRanges?: readonly WaveformCanvasColumnRange[];
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
    args.previous.scopeKey !== args.current.scopeKey ||
    args.previous.color !== args.current.color
  ) {
    return {
      kind: "none",
      reason: "content-changed",
    };
  }

  const dataSignatureChanged = args.previous.dataSignature !== args.current.dataSignature;
  const dirtyRanges = args.dirtyRanges ?? [];

  if (
    Math.abs(args.previous.viewport.pixelsPerSecond - args.current.viewport.pixelsPerSecond) >=
      0.01 ||
    args.previous.viewport.maximumPixelsPerSecond !== args.current.viewport.maximumPixelsPerSecond
  ) {
    if (
      args.previous.viewport.maximumPixelsPerSecond !== args.current.viewport.maximumPixelsPerSecond
    ) {
      return {
        kind: "none",
        reason: "scale-changed",
      };
    }

    const zoomAffinePlan = resolveWaveformCanvasZoomAffineReusePlan({
      current: args.current,
      dirtyRanges,
      previous: args.previous,
    });
    if (zoomAffinePlan) {
      return zoomAffinePlan;
    }

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
    const zoomAffinePlan = resolveWaveformCanvasZoomAffineReusePlan({
      current: args.current,
      dirtyRanges,
      previous: args.previous,
    });
    if (zoomAffinePlan) {
      return zoomAffinePlan;
    }

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

  if (dataSignatureChanged && scrollDeltaPx === 0 && dirtyRanges.length > 0) {
    return {
      dirtyRanges: dirtyRanges.map((range) => ({
        endX: range.endX,
        startX: range.startX,
      })),
      kind: "dirty-redraw",
    };
  }

  if (args.previous.viewport.viewportWidth !== args.current.viewport.viewportWidth) {
    if (dataSignatureChanged) {
      return {
        kind: "none",
        reason: "content-changed",
      };
    }

    const previousRasterEndX = resolveWaveformCanvasRasterEndX(args.previous.geometry);
    const currentRasterEndX = resolveWaveformCanvasRasterEndX(args.current.geometry);
    const previousWorldStartX =
      args.previous.viewport.scrollLeft + args.previous.geometry.rasterStartX;
    const previousWorldEndX = args.previous.viewport.scrollLeft + previousRasterEndX;
    const currentWorldStartX =
      args.current.viewport.scrollLeft + args.current.geometry.rasterStartX;
    const currentWorldEndX = args.current.viewport.scrollLeft + currentRasterEndX;
    const overlapStartX = Math.max(previousWorldStartX, currentWorldStartX);
    const overlapEndX = Math.min(previousWorldEndX, currentWorldEndX);
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
        startX: args.current.geometry.rasterStartX,
      },
      {
        endX: currentRasterEndX,
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

  if (absScrollDeltaPx >= args.current.geometry.rasterWidth) {
    return {
      kind: "none",
      reason: "scroll-delta-too-wide",
    };
  }

  const rasterEndX = resolveWaveformCanvasRasterEndX(args.current.geometry);
  return {
    exposedEndX:
      scrollDeltaPx > 0 ? rasterEndX : args.current.geometry.rasterStartX + absScrollDeltaPx,
    exposedStartX:
      scrollDeltaPx > 0 ? rasterEndX - scrollDeltaPx : args.current.geometry.rasterStartX,
    kind: "horizontal-pan",
    scrollDeltaPx,
    shiftX: -scrollDeltaPx,
  };
}

export function resolveWaveformCanvasRenderRequestTransition(args: {
  currentJob: WaveformCanvasFrameDescriptor | null;
  currentPresentedDirtyRanges?: readonly WaveformCanvasColumnRange[];
  currentPresentedFrame: WaveformCanvasFrameDescriptor | null;
  currentRequestedFrame: WaveformCanvasFrameDescriptor | null;
  hasScheduledFrame: boolean;
  nextFrame: WaveformCanvasFrameDescriptor | null;
}) {
  if (!args.nextFrame) {
    return "start-new" as const;
  }

  if (
    args.currentJob &&
    areWaveformCanvasFrameRenderSignaturesEqual(args.currentJob, args.nextFrame)
  ) {
    return "reuse-job" as const;
  }

  if (
    args.currentJob &&
    areWaveformCanvasFrameVisualSignaturesEqual(args.currentJob, args.nextFrame)
  ) {
    return "retarget-job" as const;
  }

  if (
    args.currentRequestedFrame &&
    args.hasScheduledFrame &&
    areWaveformCanvasFrameVisualSignaturesEqual(args.currentRequestedFrame, args.nextFrame)
  ) {
    return "reuse-scheduled" as const;
  }

  if (
    args.currentPresentedFrame &&
    (!args.currentPresentedDirtyRanges || args.currentPresentedDirtyRanges.length === 0) &&
    areWaveformCanvasFrameRenderSignaturesEqual(args.currentPresentedFrame, args.nextFrame)
  ) {
    return "reuse-presented" as const;
  }

  return "start-new" as const;
}

export function shouldContinueWaveformCanvasRenderJobForPendingCoverage(args: {
  completedDirtyRanges: readonly WaveformCanvasColumnRange[];
  completedFrame: WaveformCanvasFrameDescriptor;
  completedJobRetargeted?: boolean;
  requestedFrame: WaveformCanvasFrameDescriptor | null;
}) {
  return (
    args.completedDirtyRanges.length > 0 &&
    args.requestedFrame !== null &&
    areWaveformCanvasFrameVisualSignaturesEqual(args.completedFrame, args.requestedFrame) &&
    (args.completedJobRetargeted === true ||
      !areWaveformCanvasFrameRenderSignaturesEqual(args.completedFrame, args.requestedFrame))
  );
}

export function resolveWaveformCanvasRetargetRanges(args: {
  currentCursor: WaveformCanvasRenderCursor;
  geometry: WaveformCanvasFrameGeometry;
}) {
  const ranges = normalizeWaveformCanvasColumnRanges({
    geometry: args.geometry,
    ranges: [...args.currentCursor.drawnRanges, ...args.currentCursor.retargetRanges],
  });

  if (ranges.length === 0) {
    return [];
  }

  return [
    {
      endX: Math.max(...ranges.map((range) => range.endX)),
      startX: Math.min(...ranges.map((range) => range.startX)),
    },
  ];
}

export function shouldRetainWaveformCanvasSnapshotForRenderStart(args: {
  presentation: WaveformCanvasRenderPresentation;
}) {
  return args.presentation.kind === "dirty";
}

function resolveWaveformCanvasInsertedRangesAfterZoomAffinePresentation(args: {
  draws: readonly WaveformCanvasRangeDrawResult[];
  geometry: WaveformCanvasFrameGeometry;
  ranges: readonly WaveformCanvasColumnRange[];
}) {
  const drawnRanges = args.draws.flatMap((draw) => draw.drawnRanges);
  const missingRanges = args.draws.flatMap((draw) => draw.missingRanges);

  return normalizeWaveformCanvasColumnRanges({
    geometry: args.geometry,
    ranges: [
      ...subtractWaveformCanvasColumnRanges({
        geometry: args.geometry,
        ranges: args.ranges,
        subtract: drawnRanges,
      }),
      ...missingRanges,
    ],
  });
}

function resolveWaveformCanvasFastPresentationPlan(args: {
  current: WaveformCanvasFrameDescriptor;
  dirtyRanges?: readonly WaveformCanvasColumnRange[];
  previous: WaveformCanvasFrameDescriptor | null;
}): WaveformCanvasFastPresentationPlan {
  const reusePlan = resolveWaveformCanvasFrameReusePlan({
    current: args.current,
    dirtyRanges: args.dirtyRanges,
    previous: args.previous,
  });
  if (
    reusePlan.kind === "dirty-redraw" ||
    reusePlan.kind === "horizontal-pan" ||
    reusePlan.kind === "viewport-resize" ||
    reusePlan.kind === "zoom-affine"
  ) {
    return reusePlan;
  }

  return reusePlan;
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
  const durationSeconds = resolveWaveformDurationSeconds(args.durationMs);
  const anchorVisualSeconds = clampNumber(
    (args.scrollLeft + args.anchorViewportX) / Math.max(1, currentPixelsPerSecond),
    0,
    resolveWaveformVisualDurationSeconds(args.durationMs),
  );
  const focusSeconds = clampNumber(
    waveformVisualSecondsToAudioSeconds(anchorVisualSeconds),
    0,
    durationSeconds,
  );
  const contentWidth = resolveWaveformContentWidth({
    durationMs: args.durationMs,
    pixelsPerSecond,
    viewportWidth: args.viewportWidth,
  });
  const scrollLeft = resolveWaveformAnchoredVisualScrollLeft({
    contentWidth,
    offsetPx: args.anchorViewportX,
    pixelsPerSecond,
    viewportWidth: args.viewportWidth,
    visualSeconds: anchorVisualSeconds,
  });

  return {
    anchorVisualSeconds,
    anchorViewportX: args.anchorViewportX,
    contentWidth,
    focusSeconds,
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

function resolveWaveformBarPresentationModel(
  viewport: Pick<WaveformViewportModel, "focusSeconds" | "pixelsPerSecond" | "scrollLeft">,
): WaveformBarPresentationModel {
  const pixelsPerSecond = Math.max(1, viewport.pixelsPerSecond);
  const focusSeconds =
    typeof viewport.focusSeconds === "number" && Number.isFinite(viewport.focusSeconds)
      ? viewport.focusSeconds
      : null;

  if (focusSeconds === null) {
    return {
      anchorViewportX: null,
      anchorVisualSeconds: null,
      pixelsPerSecond,
      scrollLeft: viewport.scrollLeft,
    };
  }

  const anchorVisualSeconds = audioSecondsToWaveformVisualSeconds(focusSeconds);

  return {
    anchorViewportX: anchorVisualSeconds * pixelsPerSecond - viewport.scrollLeft,
    anchorVisualSeconds,
    pixelsPerSecond,
    scrollLeft: viewport.scrollLeft,
  };
}

export function resolveWaveformBarPresentationProgress(args: {
  durationMs: number;
  elapsedMs: number;
}) {
  const durationMs = Math.max(1, args.durationMs);
  const t = clampNumber(args.elapsedMs / durationMs, 0, 1);

  return 1 - (1 - t) ** 3;
}

export function resolveWaveformBarPresentationAtProgress(args: {
  from: WaveformBarPresentationModel;
  progress: number;
  to: WaveformBarPresentationModel;
}): WaveformBarPresentationModel {
  const progress = clampNumber(args.progress, 0, 1);
  const pixelsPerSecond =
    args.from.pixelsPerSecond + (args.to.pixelsPerSecond - args.from.pixelsPerSecond) * progress;
  const anchor = resolveWaveformBarPresentationSharedAnchor({
    from: args.from,
    to: args.to,
  });

  return {
    anchorViewportX: anchor?.anchorViewportX ?? args.to.anchorViewportX ?? null,
    anchorVisualSeconds: anchor?.anchorVisualSeconds ?? args.to.anchorVisualSeconds ?? null,
    pixelsPerSecond,
    scrollLeft: anchor
      ? anchor.anchorVisualSeconds * pixelsPerSecond - anchor.anchorViewportX
      : args.from.scrollLeft + (args.to.scrollLeft - args.from.scrollLeft) * progress,
  };
}

function resolveWaveformBarPresentationSharedAnchor(args: {
  from: WaveformBarPresentationModel;
  to: WaveformBarPresentationModel;
}) {
  const anchorVisualSeconds = args.to.anchorVisualSeconds;
  const anchorViewportX = args.to.anchorViewportX;

  if (
    typeof anchorVisualSeconds !== "number" ||
    typeof anchorViewportX !== "number" ||
    !Number.isFinite(anchorVisualSeconds) ||
    !Number.isFinite(anchorViewportX)
  ) {
    return null;
  }

  const fromAnchorViewportX =
    anchorVisualSeconds * args.from.pixelsPerSecond - args.from.scrollLeft;
  if (Math.abs(fromAnchorViewportX - anchorViewportX) > 0.5) {
    return null;
  }

  return {
    anchorViewportX,
    anchorVisualSeconds,
  };
}

function areWaveformBarPresentationModelsEqual(
  left: WaveformBarPresentationModel | null,
  right: WaveformBarPresentationModel | null,
) {
  if (!left || !right) {
    return left === right;
  }

  return (
    Math.abs(left.pixelsPerSecond - right.pixelsPerSecond) < 0.01 &&
    Math.abs(left.scrollLeft - right.scrollLeft) < 0.5
  );
}

function createWaveformBarPresentationAnimation(args: {
  from: WaveformBarPresentationModel | null;
  nowMs: number;
  to: WaveformBarPresentationModel;
  zoomChanged: boolean;
}): WaveformBarPresentationAnimation | null {
  if (!args.zoomChanged) {
    return null;
  }

  if (!args.from || areWaveformBarPresentationModelsEqual(args.from, args.to)) {
    return null;
  }

  return {
    durationMs: WAVEFORM_BAR_PRESENTATION_ANIMATION_DURATION_MS,
    from: args.from,
    startedAtMs: args.nowMs,
    to: args.to,
  };
}

function resolveAnimatedWaveformBarPresentation(args: {
  animation: WaveformBarPresentationAnimation | null;
  nowMs: number;
  target: WaveformBarPresentationModel;
}) {
  if (!args.animation) {
    return {
      completed: true,
      model: args.target,
    };
  }

  const progress = resolveWaveformBarPresentationProgress({
    durationMs: args.animation.durationMs,
    elapsedMs: args.nowMs - args.animation.startedAtMs,
  });

  return {
    completed: progress >= 1,
    model: resolveWaveformBarPresentationAtProgress({
      from: args.animation.from,
      progress,
      to: args.animation.to,
    }),
  };
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
  if (args.window.endPx <= args.window.startPx) {
    return [];
  }

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
  interaction?: WaveformDataPlanInteraction;
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
  const interaction = args.interaction ?? "default";
  const guardViewports =
    mode === "interactive"
      ? interaction === "horizontal-pan"
        ? WAVEFORM_HORIZONTAL_PAN_DATA_GUARD_VIEWPORTS
        : WAVEFORM_INTERACTIVE_GUARD_VIEWPORTS
      : 0;
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
  const canvasRetainedSecondsWindow = resolveWaveformVisibleSecondsWindow({
    durationSeconds,
    overscanViewports: WAVEFORM_CANVAS_RETAINED_VIEWPORTS,
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
  const dataDemandViewports = Math.max(
    overscanViewports,
    guardViewports,
    WAVEFORM_CANVAS_RETAINED_VIEWPORTS,
  );
  const dataDemandSecondsWindow = resolveWaveformVisibleSecondsWindow({
    durationSeconds,
    overscanViewports: dataDemandViewports,
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
  const canvasRetainedWindow = resolveWaveformDataPixelWindow({
    dataContentWidth,
    dataPixelsPerSecond,
    window: canvasRetainedSecondsWindow,
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
    canvasRetainedWindow,
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
  canvasRetainedWindow: WaveformDataWindow;
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
        : isWaveformDataTileIndexInsideWindow({
              index,
              tileWidth: args.tileWidth,
              window: args.canvasRetainedWindow,
            })
          ? "visible-guard"
          : args.mode === "interactive"
            ? "visible-guard"
            : "overscan",
    scopeKey: args.scopeKey,
    tileWidth: args.tileWidth,
    window: args.dataDemandWindow,
  });
}

function isWaveformDataTileIndexInsideWindow(args: {
  index: number;
  tileWidth: number;
  window: WaveformDataWindow;
}) {
  const tileWidth = Math.max(1, Math.ceil(args.tileWidth));
  const tileStartPx = args.index * tileWidth;
  const tileEndPx = tileStartPx + tileWidth;

  return tileStartPx < args.window.endPx && tileEndPx > args.window.startPx;
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

export function resolveWaveformTileAvailabilityPresentationPlan(args: {
  currentPlan: WaveformDataPlan | null;
  signal: Pick<WaveformTileAvailabilitySignal, "scopeKey">;
}) {
  if (!args.currentPlan || args.currentPlan.scopeKey !== args.signal.scopeKey) {
    return null;
  }

  return args.currentPlan;
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
    resolveWaveformViewportAudioSeconds({
      pixelsPerSecond: args.viewport.pixelsPerSecond,
      scrollLeft: args.viewport.scrollLeft,
      viewportX: args.pointerClientX - args.hostRect.left,
    }),
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

function secondsToWaveformViewportX(args: { seconds: number; viewport: WaveformViewportModel }) {
  return (
    audioSecondsToWaveformVisualSeconds(args.seconds) * args.viewport.pixelsPerSecond -
    args.viewport.scrollLeft
  );
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

export function resolveWaveformTileLoadResultPolicy(args: {
  activeScopeKey: string | null;
  presentationRequestKeys: ReadonlySet<string>;
  requestCacheKey: string;
  requestScopeKey: string;
}): WaveformTileLoadResultPolicy {
  const shouldCache = args.activeScopeKey === args.requestScopeKey;

  return {
    shouldCache,
    shouldRequestPresentation:
      shouldCache && args.presentationRequestKeys.has(args.requestCacheKey),
  };
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
  if (args.window.endPx <= args.window.startPx) {
    return [];
  }

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

  return (
    audioSecondsToWaveformVisualSeconds(filePositionSeconds) * args.pixelsPerSecond -
    args.scrollLeft
  );
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
  onSelectionCommit?: (
    range: WaveformSelectionDragResolution,
    commitPlaybackStatus?: TrackSpectrumPlaybackStatusCommit,
  ) => void;
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
  onSelectionCommit?: (
    range: WaveformSelectionDragResolution,
    commitPlaybackStatus?: TrackSpectrumPlaybackStatusCommit,
  ) => void;
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
  const traceSessionId = useId();
  const commitViewportRef = useRef<WaveformViewportCommit | null>(null);
  const completeDataPlanTimerRef = useRef<number | null>(null);
  const viewportSettledEffectsTimerRef = useRef<number | null>(null);
  const lastInteractiveDataDemandRef = useRef<WaveformInteractiveDataDemand | null>(null);
  const pendingHorizontalPanPresentationRef = useRef<{
    scrollDeltaPx: number;
    viewport: WaveformViewportModel;
  } | null>(null);
  const onWaveformTileAvailableRef = useRef<
    ((signal: WaveformTileAvailabilitySignal) => void) | null
  >(null);
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
    traceSessionId,
    viewportRef,
  });
  const handleWaveformTileAvailable = useCallback((signal: WaveformTileAvailabilitySignal) => {
    onWaveformTileAvailableRef.current?.(signal);
  }, []);
  const requestDataPlan = useWaveformDataLoader({
    filePath: props.filePath?.trim() || null,
    onTileAvailable: handleWaveformTileAvailable,
    status: waveformState.status,
    tileCacheRef,
    tilePromiseStore: renderDataStore.tilePromises,
    traceSessionId,
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
  const onSelectionCommitRef = useRef(props.onSelectionCommit);
  onSelectionCommitRef.current = props.onSelectionCommit;
  const commitPlaybackStatusRef = useRef<TrackSpectrumPlaybackStatusCommit | null>(null);
  commitPlaybackStatusRef.current =
    props.playheadEnabled === true ? playheadController.commitPlaybackStatus : null;
  const commitSelection = useCallback((range: WaveformSelectionDragResolution) => {
    onSelectionCommitRef.current?.(range, commitPlaybackStatusRef.current ?? undefined);
  }, []);
  const shouldShowLoadingGrid = waveformState.status === "loading";
  const externalSelection = props.selection ?? null;
  const externalSelectionStart = externalSelection?.start ?? null;
  const externalSelectionEnd = externalSelection?.end ?? null;
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

  const syncSelectionOverlayForViewport = useCallback(
    (viewport: WaveformViewportModel, mode: "full" | "handles-only" = "full") => {
      const host = hostRef.current;
      if (!host) {
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

      if (mode === "handles-only") {
        return;
      }

      host.style.setProperty(
        "--waveform-selection-start-mask-width",
        `${clampNumber(geometry.startX, 0, viewport.viewportWidth)}px`,
      );
      host.style.setProperty(
        "--waveform-selection-end-mask-left",
        `${clampNumber(geometry.endX, 0, viewport.viewportWidth)}px`,
      );
    },
    [],
  );
  const syncSelectionOverlay = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    syncSelectionOverlayForViewport(viewport);
  }, [syncSelectionOverlayForViewport]);
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
    (
      mode: WaveformDataPlanMode,
      interaction: WaveformDataPlanInteraction = "default",
      source: WaveformTracePlanSource = "presentation",
    ) => {
      const viewport = viewportRef.current;
      const filePath = props.filePath?.trim() || null;

      if (waveformState.status !== "ready" || !filePath || !viewport) {
        recordWaveformDataPlanBoundaryTrace({
          interaction,
          mode,
          plan: null,
          source,
          traceSessionId,
          viewport,
        });
        return null;
      }

      const plan = resolveWaveformDataPlan({
        contentWidth: viewport.contentWidth,
        filePath,
        focusSeconds: viewport.focusSeconds,
        interaction,
        mode,
        pixelsPerSecond: viewport.pixelsPerSecond,
        scrollLeft: viewport.scrollLeft,
        summary: waveformState.summary,
        viewportWidth: viewport.viewportWidth,
      });
      recordWaveformDataPlanBoundaryTrace({
        interaction,
        mode,
        plan,
        source,
        traceSessionId,
        viewport,
      });
      return plan;
    },
    [props.filePath, traceSessionId, waveformState.status, waveformState.summary],
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
    (mode: WaveformDataPlanMode, interaction: WaveformDataPlanInteraction = "default") => {
      const plan = resolveCurrentDataPlan(mode, interaction);
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

  const clearViewportSettledEffectsTimer = useCallback(() => {
    const ownerWindow =
      hostRef.current?.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);

    if (viewportSettledEffectsTimerRef.current !== null && ownerWindow) {
      ownerWindow.clearTimeout(viewportSettledEffectsTimerRef.current);
    }
    viewportSettledEffectsTimerRef.current = null;
  }, []);

  const commitViewportModel = useCallback(
    (next: WaveformViewportState, interaction: WaveformDataPlanInteraction = "default") => {
      const previous = viewportRef.current;
      const normalizedModel = resolveWaveformViewportModel({
        durationMs: waveformState.summary.duration_ms,
        focusSeconds: next.focusSeconds,
        maximumPixelsPerSecond,
        pixelsPerSecond: next.pixelsPerSecond,
        scrollLeft: next.scrollLeft,
        viewportWidth: next.viewportWidth,
      });
      const changed =
        !previous ||
        previous.focusSeconds !== normalizedModel.focusSeconds ||
        Math.abs(previous.pixelsPerSecond - normalizedModel.pixelsPerSecond) >= 0.01 ||
        Math.abs(previous.scrollLeft - normalizedModel.scrollLeft) >= 0.5 ||
        previous.viewportWidth !== normalizedModel.viewportWidth ||
        previous.contentWidth !== normalizedModel.contentWidth ||
        previous.durationMs !== normalizedModel.durationMs ||
        previous.maximumPixelsPerSecond !== normalizedModel.maximumPixelsPerSecond;

      const shouldDeferHorizontalPanPresentation =
        previous &&
        changed &&
        interaction === "horizontal-pan" &&
        previous.viewportWidth === normalizedModel.viewportWidth &&
        Math.abs(previous.pixelsPerSecond - normalizedModel.pixelsPerSecond) < 0.01 &&
        previous.contentWidth === normalizedModel.contentWidth;

      if (shouldDeferHorizontalPanPresentation) {
        const scrollDeltaPx = Math.round(normalizedModel.scrollLeft - previous.scrollLeft);
        pendingHorizontalPanPresentationRef.current =
          scrollDeltaPx === 0
            ? null
            : {
                scrollDeltaPx,
                viewport: normalizedModel,
              };
      } else {
        pendingHorizontalPanPresentationRef.current = null;
      }

      playheadController.holdPresentationViewport(
        pendingHorizontalPanPresentationRef.current ? previous : null,
      );
      viewportRef.current = normalizedModel;

      if (!pendingHorizontalPanPresentationRef.current) {
        playheadController.syncPlayhead();
        syncSelectionOverlay();
      }

      return changed;
    },
    [
      maximumPixelsPerSecond,
      playheadController,
      syncSelectionOverlay,
      waveformState.summary.duration_ms,
    ],
  );
  const syncHorizontalPanPresentation = useCallback(
    (presentation: WaveformPanPresentationStart) => {
      const pending = pendingHorizontalPanPresentationRef.current;
      pendingHorizontalPanPresentationRef.current = null;
      if (!pending || pending.scrollDeltaPx !== -presentation.shiftX) {
        playheadController.holdPresentationViewport(null);
        playheadController.syncPlayhead();
        syncSelectionOverlay();
        return;
      }

      if (presentation.animate) {
        startWaveformOverlayPanPresentation({ host: hostRef.current });
      }
      playheadController.holdPresentationViewport(null);
      playheadController.syncPlayheadForViewport(pending.viewport);
      syncSelectionOverlayForViewport(pending.viewport);
    },
    [playheadController, syncSelectionOverlay, syncSelectionOverlayForViewport],
  );
  const prepareHorizontalPanPresentation = useCallback(
    (presentation: WaveformPanPresentationStart) => {
      const pending = pendingHorizontalPanPresentationRef.current;
      if (!pending || pending.scrollDeltaPx !== -presentation.shiftX) {
        return;
      }

      if (!presentation.animate) {
        return;
      }

      prepareWaveformOverlayPanPresentation({
        host: hostRef.current,
        shiftX: presentation.shiftX,
      });
      playheadController.holdPresentationViewport(null);
      playheadController.syncPlayheadForViewport(pending.viewport);
      syncSelectionOverlayForViewport(pending.viewport, "handles-only");
    },
    [playheadController, syncSelectionOverlayForViewport],
  );
  const cancelHorizontalPanPresentation = useCallback(() => {
    resetWaveformOverlayPanPresentation(hostRef.current);
    playheadController.holdPresentationViewport(null);
    playheadController.syncPlayhead();
    syncSelectionOverlay();
  }, [playheadController, syncSelectionOverlay]);
  const drawCanvasForHorizontalPanOwner = useCallback(
    (plan: WaveformDataPlan) => {
      const canStartHorizontalPanPresentation = (presentation: WaveformPanPresentationStart) => {
        const pending = pendingHorizontalPanPresentationRef.current;

        return shouldStartWaveformHorizontalPanPresentation({
          hasDirtyRanges: presentation.hasDirtyRanges,
          pendingScrollDeltaPx: pending?.scrollDeltaPx ?? null,
          shiftX: presentation.shiftX,
        });
      };

      return drawCanvas(plan, {
        canStartHorizontalPanPresentation,
        onHorizontalPanPresentationCancel: cancelHorizontalPanPresentation,
        onHorizontalPanPresentationPrepare: prepareHorizontalPanPresentation,
        onHorizontalPanPresentationStart: syncHorizontalPanPresentation,
      });
    },
    [
      cancelHorizontalPanPresentation,
      drawCanvas,
      prepareHorizontalPanPresentation,
      syncHorizontalPanPresentation,
    ],
  );
  const drawCanvasForTileAvailability = useCallback(
    (signal: WaveformTileAvailabilitySignal) => {
      const currentPlan = resolveWaveformTileAvailabilityPresentationPlan({
        currentPlan: resolveCurrentDataPlan(
          "interactive",
          pendingHorizontalPanPresentationRef.current ? "horizontal-pan" : "default",
          "tile-availability",
        ),
        signal,
      });

      if (!currentPlan) {
        return;
      }

      drawCanvasForHorizontalPanOwner(currentPlan);
    },
    [drawCanvasForHorizontalPanOwner, resolveCurrentDataPlan],
  );
  onWaveformTileAvailableRef.current = drawCanvasForTileAvailability;

  const applyWaveformTransaction = useCallback(
    (resolution: WaveformTransactionResolution) => {
      const transaction = resolution.transaction;
      if (transaction.mode === "interactive") {
        cancelCompleteDataPlan();
      }

      lastInteractiveDataDemandRef.current = resolution.nextInteractiveDataDemand;

      if (transaction.presentation.plan) {
        const drawResult = drawCanvasForHorizontalPanOwner(transaction.presentation.plan);
        if (drawResult.kind !== "horizontal-pan-presentation-scheduled") {
          pendingHorizontalPanPresentationRef.current = null;
          playheadController.holdPresentationViewport(null);
          playheadController.syncPlayhead();
          syncSelectionOverlay();
        }
      } else if (pendingHorizontalPanPresentationRef.current) {
        pendingHorizontalPanPresentationRef.current = null;
        playheadController.holdPresentationViewport(null);
        playheadController.syncPlayhead();
        syncSelectionOverlay();
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
    [
      cancelCompleteDataPlan,
      drawCanvasForHorizontalPanOwner,
      playheadController,
      requestDataPlan,
      scheduleCompleteDataPlan,
      syncSelectionOverlay,
    ],
  );

  const runViewportEffects = useCallback(
    (mode: WaveformDataPlanMode, interaction: WaveformDataPlanInteraction = "default") => {
      const viewportBefore = viewportRef.current;
      recordWaveformDataPlanBoundaryTrace({
        interaction,
        mode,
        plan: null,
        source: "effect",
        traceSessionId,
        viewport: viewportBefore,
      });
      applyWaveformTransaction(buildWaveformTransaction(mode, interaction));
    },
    [applyWaveformTransaction, buildWaveformTransaction, traceSessionId],
  );

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
  const commitViewport = useCallback(
    (request: WaveformViewportCommitRequest) => {
      if (commitViewportModel(request.state, request.interaction)) {
        runViewportEffects(request.mode ?? "settled", request.interaction);
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
    const anchorSelection =
      externalSelectionStart === null && externalSelectionEnd === null
        ? null
        : {
            end: externalSelectionEnd,
            start: externalSelectionStart,
          };
    const resolution = resolveWaveformInitialSelectionViewportAnchor({
      cacheKey: waveformState.summary.cache_key,
      filePath: props.filePath?.trim() || null,
      previousAnchorKey: initialSelectionViewportAnchorRef.current,
      selection: anchorSelection,
      status: waveformState.status,
    });
    if (!current || !resolution) {
      return;
    }

    initialSelectionViewportAnchorRef.current = resolution.anchorKey;

    const scrollLeft = resolveWaveformSelectionStartScrollLeft({
      contentWidth: current.contentWidth,
      leadingSpacePx: WAVEFORM_SELECTION_START_LEADING_SPACE_PX,
      pixelsPerSecond: current.pixelsPerSecond,
      selection: resolution.selection,
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
  }, [
    commitViewport,
    externalSelectionEnd,
    externalSelectionStart,
    props.filePath,
    waveformState.status,
    waveformState.summary.cache_key,
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
        style={{
          opacity: WAVEFORM_CANVAS_STROKE_ALPHA,
          transform:
            "var(--waveform-canvas-pan-presentation-transform, var(--waveform-canvas-bar-presentation-transform, translate3d(0, 0, 0)))",
          transformOrigin: "var(--waveform-canvas-bar-presentation-origin, 50% 50%)",
          transition: "var(--waveform-canvas-pan-presentation-transition, none)",
          willChange:
            "var(--waveform-canvas-pan-presentation-will-change, var(--waveform-canvas-bar-presentation-will-change, auto))",
        }}
      />
      {shouldShowLoadingGrid && (
        <canvas
          ref={loadingCanvasRef}
          aria-hidden
          className="spectrum-waveform-loading-canvas pointer-events-none absolute inset-0 z-[1] h-full w-full text-inherit"
        />
      )}
      <div className="absolute inset-0 z-[3]">
        <WaveformSelectionOverlay
          onSelectionCommit={commitSelection}
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
      </div>
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
      className="pointer-events-none absolute inset-0"
      style={{
        opacity: visible ? "var(--waveform-selection-opacity, 0)" : 0,
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 bg-[#f5f5f5]/58 dark:bg-[#050505]/58"
        style={{
          left: 0,
          transition: "var(--waveform-pan-presentation-transition, none)",
          willChange: "var(--waveform-pan-presentation-will-change, auto)",
          width: "var(--waveform-selection-start-mask-width, 0px)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 bg-[#f5f5f5]/58 dark:bg-[#050505]/58"
        style={{
          left: "var(--waveform-selection-end-mask-left, 100%)",
          right: 0,
          transition: "var(--waveform-pan-presentation-transition, none)",
          willChange: "var(--waveform-pan-presentation-will-change, auto)",
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
      <WaveformSelectionEdgeIndicator cssX="var(--waveform-selection-start-x, -9999px)" />
      <WaveformSelectionEdgeIndicator cssX="var(--waveform-selection-end-x, -9999px)" />
    </div>
  );
}

function WaveformSelectionEdgeIndicator(args: { cssX: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 block w-px bg-[#d4d4d4] shadow-[0_0_0_1px_rgba(245,245,245,0.65)] dark:bg-[#373737] dark:shadow-[0_0_0_1px_rgba(5,5,5,0.65)]"
      style={{
        left: args.cssX,
        transform:
          "var(--waveform-pan-presentation-transform, translate3d(0, 0, 0)) translateX(-50%)",
        transition: "var(--waveform-pan-presentation-transition, none)",
        willChange: "var(--waveform-pan-presentation-will-change, auto)",
      }}
    />
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
          transform:
            "var(--waveform-pan-presentation-transform, translate3d(0, 0, 0)) translate3d(calc(var(--waveform-playhead-x, -9999px) - 1px), 0, 0)",
          transition: "var(--waveform-pan-presentation-transition, none)",
          willChange: "var(--waveform-pan-presentation-will-change, auto)",
        }}
      />
      <button
        type="button"
        aria-label="Adjust playback position"
        className="absolute inset-y-0 left-0 z-[4] w-7 -translate-x-1/2 cursor-ew-resize touch-none border-0 bg-transparent p-0 focus:outline-none"
        style={{
          opacity: visible ? "var(--waveform-playhead-opacity, 0)" : 0,
          transform:
            "var(--waveform-pan-presentation-transform, translate3d(0, 0, 0)) translate3d(var(--waveform-playhead-x, -9999px), 0, 0) translateX(-50%)",
          transition: "var(--waveform-pan-presentation-transition, none)",
          willChange: "var(--waveform-pan-presentation-will-change, auto)",
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
      className="pointer-events-auto absolute inset-y-0 w-5 cursor-ew-resize touch-none focus:outline-none"
      style={{
        left: args.cssX,
        transform:
          "var(--waveform-pan-presentation-transform, translate3d(0, 0, 0)) translateX(-50%)",
        transition: "var(--waveform-pan-presentation-transition, none)",
        willChange: "var(--waveform-pan-presentation-will-change, auto)",
      }}
      onPointerCancel={args.onPointerCancel}
      onPointerDown={(event) => args.onPointerDown(args.edge, event)}
      onPointerMove={(event) => args.onPointerMove(args.edge, event)}
      onPointerUp={args.onPointerUp}
    />
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
      focusSeconds: frame.focusSeconds,
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
  const heldPresentationViewportRef = useRef<WaveformViewportModel | null>(null);
  const beginSeekPromiseRef = useRef<Promise<boolean> | null>(null);

  const syncPlayheadForViewport = useCallback((viewport: WaveformViewportModel, nowMs?: number) => {
    const latest = latestArgsRef.current;
    const host = latest.hostRef.current;
    if (!host) {
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
    const playbackStartMs =
      dragPreview !== null ? 0 : positionMs === null ? null : (snapshot?.playback_start_ms ?? null);
    const cssVars = resolveWaveformPlayheadCssVariables({
      playbackStartMs,
      pixelsPerSecond: viewport.pixelsPerSecond,
      positionMs,
      scrollLeft: viewport.scrollLeft,
      viewportWidth: viewport.viewportWidth,
    });

    host.style.setProperty("--waveform-playhead-opacity", cssVars.opacity);
    host.style.setProperty("--waveform-playhead-x", cssVars.x);
  }, []);

  const syncPlayhead = useCallback(
    (nowMs?: number) => {
      const viewport =
        heldPresentationViewportRef.current ?? latestArgsRef.current.viewportRef.current;
      if (!viewport) {
        return;
      }

      syncPlayheadForViewport(viewport, nowMs);
    },
    [syncPlayheadForViewport],
  );

  const holdPresentationViewport = useCallback((viewport: WaveformViewportModel | null) => {
    heldPresentationViewportRef.current = viewport;
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
  const commitExternalPlaybackStatus = useCallback(
    (status: PlaybackStatusPayload | null) => {
      const ownerWindow =
        latestArgsRef.current.hostRef.current?.ownerDocument.defaultView ??
        (typeof window === "undefined" ? null : window);
      commitPlaybackStatus(status, ownerWindow);
    },
    [commitPlaybackStatus],
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
  }, [
    args.enabled,
    args.filePath,
    args.playbackPort,
    commitPlaybackSnapshot,
    commitPlaybackStatus,
  ]);

  useEffect(() => stopPlayheadAnimation, [stopPlayheadAnimation]);

  if (!args.enabled) {
    return inertWaveformPlayheadController;
  }

  return {
    beginPlayheadDrag,
    cancelPlayheadDrag,
    commitPlayheadDrag,
    commitPlaybackStatus: commitExternalPlaybackStatus,
    holdPresentationViewport,
    previewPlayheadDrag,
    syncPlayhead,
    syncPlayheadForViewport,
  };
}

function useWaveformDataLoader(args: {
  filePath: string | null;
  onTileAvailable: (signal: WaveformTileAvailabilitySignal) => void;
  status: WaveformStatus;
  tileCacheRef: RefObject<Map<string, WaveformCachedTile>>;
  tilePromiseStore: Map<string, Promise<TrackWaveformTile>>;
  traceSessionId: string;
  waveformPort: TrackSpectrumWaveformPort;
}) {
  const activeCountRef = useRef(0);
  const inFlightKeysRef = useRef(new Set<string>());
  const latestCacheAcceptedScopeKeyRef = useRef<string | null>(null);
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
  const traceMetricsRef = useRef(createWaveformDataPipelineTraceMetrics());

  const resetLoader = useCallback(() => {
    queueRef.current = [];
    latestCacheAcceptedScopeKeyRef.current = null;
    latestPresentationRequestKeySetRef.current = new Set();
    previousPlanSignatureRef.current = null;
    loadContextRef.current = null;
    recordNullableRenderPerformanceTrace(
      "waveform-canvas-data-pipeline",
      flushWaveformDataPipelineTraceMetrics(
        traceMetricsRef.current,
        readWaveformPerformanceNow(typeof window === "undefined" ? null : window),
        "reset",
      ),
    );
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
          const resultPolicy = resolveWaveformTileLoadResultPolicy({
            activeScopeKey: latestCacheAcceptedScopeKeyRef.current,
            presentationRequestKeys: latestPresentationRequestKeySetRef.current,
            requestCacheKey: entry.cacheKey,
            requestScopeKey: entry.scopeKey,
          });

          if (resultPolicy.shouldCache) {
            latestArgsRef.current.tileCacheRef.current.set(entry.cacheKey, {
              data: tileData,
              key: entry.cacheKey,
              lastUsedAt: readWaveformPerformanceNow(window),
              pixelsPerSecond: entry.dataPixelsPerSecond,
              scopeKey: entry.scopeKey,
            });
            accumulateWaveformDataPipelineTileResultTrace({
              cacheKey: entry.cacheKey,
              cached: true,
              metrics: traceMetricsRef.current,
              presentation: resultPolicy.shouldRequestPresentation,
              priority: entry.priority,
            });
            if (resultPolicy.shouldRequestPresentation) {
              recordRenderPerformanceTrace("waveform-tile-availability-boundary", {
                cacheKey: entry.cacheKey,
                priority: entry.priority,
                scopeKey: entry.scopeKey,
                traceSessionId: latestArgsRef.current.traceSessionId,
              });
              onTileAvailableRef.current({
                cacheKey: entry.cacheKey,
                priority: entry.priority,
                scopeKey: entry.scopeKey,
              });
            }
            recordNullableRenderPerformanceTrace(
              "waveform-canvas-data-pipeline",
              flushDueWaveformDataPipelineTraceMetrics(
                traceMetricsRef.current,
                readWaveformPerformanceNow(typeof window === "undefined" ? null : window),
              ),
            );
            return;
          }
          accumulateWaveformDataPipelineTileResultTrace({
            cacheKey: entry.cacheKey,
            cached: false,
            metrics: traceMetricsRef.current,
            presentation: false,
            priority: entry.priority,
          });
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
      recordWaveformDataPlanBoundaryTrace({
        mode: plan.mode,
        plan,
        source: "data-demand",
        traceSessionId: latest.traceSessionId,
        viewport: null,
      });
      const queuedKeys = new Set(queueRef.current.map((entry) => entry.cacheKey));
      const hasUnscheduledMissingRequest = scopedRequests.some(
        (request) =>
          !cache.has(request.cacheKey) &&
          !inFlightKeysRef.current.has(request.cacheKey) &&
          !queuedKeys.has(request.cacheKey),
      );

      if (previousPlanSignatureRef.current === planSignature && !hasUnscheduledMissingRequest) {
        accumulateWaveformDataPipelineReusedPlanTrace({
          flushAfterMs: WAVEFORM_CANVAS_DIAGNOSTIC_TRACE_FLUSH_MS,
          metrics: traceMetricsRef.current,
          now: readWaveformPerformanceNow(typeof window === "undefined" ? null : window),
          plan,
          planSignature,
          scope,
        });
        recordNullableRenderPerformanceTrace(
          "waveform-canvas-data-pipeline",
          flushDueWaveformDataPipelineTraceMetrics(
            traceMetricsRef.current,
            readWaveformPerformanceNow(typeof window === "undefined" ? null : window),
          ),
        );
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
      latestCacheAcceptedScopeKeyRef.current = plan.scopeKey;
      latestPresentationRequestKeySetRef.current = presentationKeys;
      queueRef.current = queueRef.current.filter(
        (entry) => entry.scopeKey === plan.scopeKey && scheduledKeys.has(entry.cacheKey),
      );

      const nextQueuedKeys = new Set(queueRef.current.map((entry) => entry.cacheKey));
      let cachedRequestCount = 0;
      let inFlightOrQueuedRequestCount = 0;
      let scheduledRequestCount = 0;
      const now = readWaveformPerformanceNow(typeof window === "undefined" ? null : window);
      for (const request of scopedRequests) {
        const cached = cache.get(request.cacheKey);
        if (cached) {
          cached.lastUsedAt = now;
          cachedRequestCount += 1;
          continue;
        }

        if (inFlightKeysRef.current.has(request.cacheKey) || nextQueuedKeys.has(request.cacheKey)) {
          inFlightOrQueuedRequestCount += 1;
          continue;
        }

        queueRef.current.push({
          ...request,
          order: nextOrderRef.current,
        });
        nextQueuedKeys.add(request.cacheKey);
        nextOrderRef.current += 1;
        scheduledRequestCount += 1;
      }

      queueRef.current.sort(compareWaveformTileLoadQueueEntries);
      pruneWaveformTileCache(cache, protectedKeys);
      traceMetricsRef.current.lastAcceptedPlanSignature = planSignature;
      accumulateWaveformDataPipelineTraceMetrics({
        cachedRequestCount,
        flushAfterMs: WAVEFORM_CANVAS_DIAGNOSTIC_TRACE_FLUSH_MS,
        inFlightOrQueuedRequestCount,
        metrics: traceMetricsRef.current,
        now,
        plan,
        planSignature,
        presentationRequestKeyCount: presentationKeys.size,
        queuedBeforeCount: nextQueuedKeys.size - scheduledRequestCount,
        scheduledRequestCount,
        scope,
        scopedRequestCount: scopedRequests.length,
      });
      recordNullableRenderPerformanceTrace(
        "waveform-canvas-data-pipeline",
        flushDueWaveformDataPipelineTraceMetrics(traceMetricsRef.current, now),
      );
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
  traceSessionId: string;
  viewportRef: RefObject<WaveformViewportModel | null>;
}) {
  const latestArgsRef = useRef(args);
  latestArgsRef.current = args;
  const previousTraceFileKeyRef = useRef<string | null>(null);
  const controllerRef = useRef<WaveformCanvasRenderController>({
    barPresentationAnimation: null,
    barPresentationModel: null,
    dataPlan: null,
    frameId: null,
    fastPresentationMetrics: createSpectrumCanvasFastPresentationMetrics(),
    job: null,
    panPresentationFrameId: null,
    panPresentationTargetFrame: null,
    panPresentationTimeoutId: null,
    reusableFrame: null,
    presentedFrame: null,
    presentedDirtyRanges: [],
    renderSchedule: "progressive",
    renderPresentation: {
      kind: "fresh",
    },
    requestedFrame: null,
    requestedRevision: 0,
    renderEmptyMetrics: createSpectrumCanvasRenderEmptyMetrics(),
    reuseFrame: null,
    traceState: {
      jobCauses: new Map(),
      jobLifecycles: new Map(),
      jobStartCount: 0,
      pendingJobCause: null,
      requestCount: 0,
    },
  });

  const runFrame = useCallback(() => {
    const controller = controllerRef.current;
    controller.frameId = null;

    const latest = latestArgsRef.current;
    const canvas = latest.canvasRef.current;
    const viewport = latest.viewportRef.current;
    if (!canvas || !viewport) {
      if (controller.job) {
        recordWaveformCanvasRenderJobTrace({
          accepted: false,
          completion: null,
          endedAt: readWaveformPerformanceNow(null),
          job: controller.job,
          reason: "cancelled",
          requestedRevision: controller.requestedRevision,
        });
        controller.traceState.jobLifecycles.delete(controller.job.id);
        controller.traceState.jobCauses.delete(controller.job.id);
      }
      controller.job = null;
      controller.barPresentationAnimation = null;
      if (canvas) {
        resetWaveformCanvasBarPresentation(canvas);
      }
      return;
    }

    const ownerWindow =
      canvas.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);
    const barPresentationFrame = resolveWaveformCanvasBarPresentationFrame({
      canvas,
      controller,
      ownerWindow,
      viewport,
    });
    if (isRenderPerformanceTraceInstalled()) {
      const targetBarPresentation = resolveWaveformBarPresentationModel(viewport);
      recordRenderPerformanceTrace(
        "waveform-canvas-bar-presentation",
        createWaveformCanvasBarPresentationTracePayload({
          isAnimating: barPresentationFrame.isAnimating,
          presentation: barPresentationFrame.isAnimating
            ? {
                current: controller.barPresentationModel ?? targetBarPresentation,
                target: targetBarPresentation,
              }
            : null,
          traceSessionId: latest.traceSessionId,
        }),
      );
    }
    const scheduleNextFrame = () => {
      if (ownerWindow && controller.frameId === null) {
        controller.frameId = ownerWindow.requestAnimationFrame(runFrame);
      }
    };
    if (barPresentationFrame.isAnimating) {
      scheduleNextFrame();
    }
    let job = controller.job;
    const requestedFrameAtStart = controller.requestedFrame;

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
        accumulateSpectrumCanvasRenderEmptyMetrics(controller.renderEmptyMetrics, {
          flushAfterMs: WAVEFORM_CANVAS_FAST_PRESENTATION_TRACE_FLUSH_MS,
          now: readWaveformPerformanceNow(ownerWindow),
          requestedRevision: controller.requestedRevision,
          ...createWaveformCanvasRenderPlanEmptyMetricsPayload(plan.empty),
        });
        recordNullableRenderPerformanceTrace(
          "waveform-canvas-render-empty",
          flushDueSpectrumCanvasRenderEmptyMetrics(
            controller.renderEmptyMetrics,
            readWaveformPerformanceNow(ownerWindow),
          ),
        );
        controller.job = null;
        controller.requestedFrame = null;
        return;
      }

      const targetColor = readCanvasWaveformColor(canvas);
      const presentationRenderPlan = barPresentationFrame.isAnimating
        ? createWaveformCanvasPresentationRenderPlan({
            current: controller.barPresentationModel,
            plan: plan.plan,
          })
        : plan.plan;
      const jobDescriptor = createWaveformCanvasFrameDescriptor({
        color: targetColor,
        plan: presentationRenderPlan,
      });
      const deferredFastPlan =
        requestedFrameAtStart &&
        areWaveformCanvasFrameVisualSignaturesEqual(requestedFrameAtStart, jobDescriptor)
          ? resolveWaveformCanvasFrameReusePlan({
              current: jobDescriptor,
              dirtyRanges: controller.presentedDirtyRanges,
              previous: controller.reusableFrame,
            })
          : null;
      if (deferredFastPlan?.kind === "zoom-affine") {
        const fastStartedAt = readWaveformPerformanceNow(ownerWindow);
        const presented = presentWaveformCanvasFrameFast({
          canvas,
          descriptor: jobDescriptor,
          descriptorPlan: presentationRenderPlan,
          previousDirtyRanges: controller.presentedDirtyRanges,
          previous: controller.reusableFrame,
          reuseFrame: controller.reuseFrame,
        });
        const fastPresentationElapsedMs = Math.max(
          0,
          readWaveformPerformanceNow(ownerWindow) - fastStartedAt,
        );
        accumulateSpectrumCanvasFastPresentationMetrics({
          flushAfterMs: WAVEFORM_CANVAS_FAST_PRESENTATION_TRACE_FLUSH_MS,
          metrics: controller.fastPresentationMetrics,
          now: readWaveformPerformanceNow(ownerWindow),
          sample: createWaveformCanvasFastPresentationSample({
            elapsedMs: fastPresentationElapsedMs,
            result: presented,
            revision: controller.requestedRevision,
          }),
        });

        if (isRenderPerformanceTraceInstalled()) {
          recordRenderPerformanceTrace(
            "waveform-canvas-frame-diagnostic",
            createWaveformCanvasFrameDiagnosticTracePayload({
              controller,
              descriptor: jobDescriptor,
              fastPresentationElapsedMs,
              renderPlan: presentationRenderPlan,
              requestTransition: "deferred-fast-presentation",
              result: presented,
              revision: controller.requestedRevision,
            }),
          );
        }

        if (presented.kind === "presented" && presented.mode === "zoom-affine") {
          controller.presentedFrame = presented.descriptor;
          controller.reusableFrame = presented.descriptor;
          controller.presentedDirtyRanges = presented.dirtyRanges;
          controller.reuseFrame = presented.reuseFrame;
          controller.renderSchedule =
            presented.insertionRanges.length > 0 ? "full-density" : "progressive";
          controller.renderPresentation =
            presented.insertionRanges.length > 0
              ? {
                  descriptor: presented.descriptor,
                  insertionRanges: presented.insertionRanges,
                  kind: "insertion",
                }
              : {
                  kind: "fresh",
                };
          recordWaveformCanvasProofTrace({
            controller,
            descriptor: jobDescriptor,
            phase: "fast-presentation-deferred-result",
            renderPlan: presentationRenderPlan,
            requestTransition: "deferred-fast-presentation",
            result: presented,
            revision: controller.requestedRevision,
            shouldCompleteWithFastPresentation: presented.insertionRanges.length === 0,
            traceSessionId: latest.traceSessionId,
          });
          if (presented.insertionRanges.length === 0) {
            controller.requestedFrame = presented.descriptor;
            controller.presentedDirtyRanges = [];
            controller.renderSchedule = "progressive";
            controller.renderPresentation = {
              kind: "fresh",
            };
            return;
          }
        }
      }

      const target = createWaveformCanvasRasterTarget({
        canvas,
        color: targetColor,
        geometry: presentationRenderPlan.geometry,
        presentation: controller.renderPresentation,
      });
      if (target.kind === "empty") {
        accumulateSpectrumCanvasRenderEmptyMetrics(controller.renderEmptyMetrics, {
          flushAfterMs: WAVEFORM_CANVAS_FAST_PRESENTATION_TRACE_FLUSH_MS,
          kind: target.empty.kind,
          now: readWaveformPerformanceNow(ownerWindow),
          requestedRevision: controller.requestedRevision,
          viewportWidth: target.empty.geometry.viewportWidth,
        });
        recordNullableRenderPerformanceTrace(
          "waveform-canvas-render-empty",
          flushDueSpectrumCanvasRenderEmptyMetrics(
            controller.renderEmptyMetrics,
            readWaveformPerformanceNow(ownerWindow),
          ),
        );
        controller.job = null;
        controller.requestedFrame = null;
        return;
      }

      const startedAt = readWaveformPerformanceNow(ownerWindow);
      if (
        !shouldRetainWaveformCanvasSnapshotForRenderStart({
          presentation: controller.renderPresentation,
        })
      ) {
        if (controller.renderPresentation.kind === "fresh") {
          controller.presentedFrame = null;
          controller.reusableFrame = null;
        }
        controller.presentedDirtyRanges = [];
      }
      job = createWaveformCanvasRenderJob({
        id: waveformCanvasRenderJobSequence++,
        descriptor: jobDescriptor,
        plan: presentationRenderPlan,
        presentation: controller.renderPresentation,
        schedule: controller.renderSchedule,
        revision: controller.requestedRevision,
        startedAt,
        target: target.target,
      });
      controller.job = job;
      controller.traceState.jobStartCount += 1;
      controller.traceState.jobLifecycles.set(
        job.id,
        controller.traceState.jobStartCount === 1 ? "initial-mount" : "update",
      );
      controller.traceState.jobCauses.set(
        job.id,
        controller.traceState.pendingJobCause ??
          (controller.traceState.jobLifecycles.get(job.id) === "initial-mount"
            ? "initial-mount"
            : "request-transition"),
      );
      controller.traceState.pendingJobCause = null;
      if (isRenderPerformanceTraceInstalled()) {
        recordRenderPerformanceTrace("waveform-canvas-job-lifecycle", {
          cause: controller.traceState.jobCauses.get(job.id),
          jobId: job.id,
          lifecycle: controller.traceState.jobLifecycles.get(job.id),
          revision: job.revision,
          schedule: job.cursor.schedule,
          traceSessionId: latest.traceSessionId,
        });
      }
      recordWaveformCanvasProofTrace({
        controller,
        descriptor: jobDescriptor,
        job,
        phase: "job-start",
        renderPlan: presentationRenderPlan,
        revision: job.revision,
        traceSessionId: latest.traceSessionId,
      });
    }

    if (
      job &&
      requestedFrameAtStart &&
      areWaveformCanvasFrameVisualSignaturesEqual(job.descriptor, requestedFrameAtStart) &&
      !areWaveformCanvasFrameRenderSignaturesEqual(job.descriptor, requestedFrameAtStart)
    ) {
      const requestedPlan = resolveWaveformCanvasRenderPlan({
        dataPlan: controller.dataPlan,
        filePath: latest.filePath,
        geometry: job.plan.geometry,
        status: latest.status,
        summary: latest.summary,
        tileCache: latest.tileCacheRef.current,
        viewport,
      });
      if (requestedPlan.kind === "ready") {
        retargetWaveformCanvasRenderJob({
          descriptor: requestedFrameAtStart,
          job,
          plan: requestedPlan.plan,
        });
        recordWaveformCanvasProofTrace({
          controller,
          descriptor: requestedFrameAtStart,
          job,
          phase: "job-retarget",
          renderPlan: requestedPlan.plan,
          revision: job.revision,
          traceSessionId: latest.traceSessionId,
        });
      }
    }

    if (!job) {
      return;
    }

    const chunkStartedAt = readWaveformPerformanceNow(ownerWindow);
    const chunk = renderWaveformCanvasEffect({
      command: {
        command: {
          collectTrace: isRenderPerformanceTraceInstalled(),
          deadlineMs: readWaveformPerformanceNow(ownerWindow) + WAVEFORM_CANVAS_FRAME_BUDGET_MS,
          cursor: job.cursor,
          now: () => readWaveformPerformanceNow(ownerWindow),
          plan: job.plan,
          replaceExistingColumns: job.presentation.kind === "dirty",
          target: job.target,
        },
        kind: "job-chunk",
      },
    }) as WaveformCanvasChunkResult;
    const chunkEndedAt = readWaveformPerformanceNow(ownerWindow);
    accumulateSpectrumCanvasRenderJobMetrics({
      chunk: {
        ...chunk,
        hasColumn: chunk.hasChunkColumn,
      },
      durationMs: Math.max(0, chunkEndedAt - chunkStartedAt),
      metrics: job.metrics,
    });
    job.cursor = chunk.cursor;
    if (chunk.trace) {
      recordRenderPerformanceTrace("waveform-canvas-chunk-behavior", {
        durationMs: Math.max(0, chunkEndedAt - chunkStartedAt),
        jobId: job.id,
        cause: controller.traceState.jobCauses.get(job.id) ?? "repeat",
        lifecycle: controller.traceState.jobLifecycles.get(job.id) ?? "update",
        presentationKind: job.presentation.kind,
        replaceExistingColumns: job.presentation.kind === "dirty",
        requestedRevision: controller.requestedRevision,
        revision: job.revision,
        schedule: job.cursor.schedule,
        trace: chunk.trace,
        traceSessionId: latest.traceSessionId,
      });
    }

    if (chunk.completed) {
      const accepted = job.revision === controller.requestedRevision;
      let completion: WaveformCanvasRenderJobCompletion | null = null;
      const requestedFrameAtCompletion = controller.requestedFrame;
      let shouldContinuePendingCoverage = false;

      if (accepted) {
        completion = completeWaveformCanvasRenderJob({
          canvas,
          job,
        });
        if (completion.kind === "committed") {
          shouldContinuePendingCoverage = shouldContinueWaveformCanvasRenderJobForPendingCoverage({
            completedDirtyRanges: completion.dirtyRanges,
            completedFrame: job.descriptor,
            completedJobRetargeted: job.retargeted,
            requestedFrame: requestedFrameAtCompletion,
          });
          if (completion.kind === "committed") {
            const completedFrame =
              completion.dirtyRanges.length === 0 &&
              requestedFrameAtCompletion !== null &&
              areWaveformCanvasFrameRenderSignaturesEqual(
                job.descriptor,
                requestedFrameAtCompletion,
              )
                ? requestedFrameAtCompletion
                : job.descriptor;
            const committedFrame =
              completion.dirtyRanges.length === 0 && controller.barPresentationAnimation === null
                ? (requestedFrameAtCompletion ?? completedFrame)
                : completedFrame;
            controller.presentedFrame = committedFrame;
            controller.reusableFrame = committedFrame;
            controller.requestedFrame = shouldContinuePendingCoverage
              ? requestedFrameAtCompletion
              : committedFrame;
            controller.presentedDirtyRanges = completion.dirtyRanges;
            controller.renderSchedule =
              completion.dirtyRanges.length === 0 ? "progressive" : "full-density";
            controller.renderPresentation =
              completion.dirtyRanges.length > 0
                ? {
                    descriptor: committedFrame,
                    dirtyRanges: completion.dirtyRanges,
                    kind: "dirty",
                  }
                : {
                    kind: "fresh",
                  };
          }
        }
      }
      recordWaveformCanvasRenderJobTrace({
        accepted,
        completion,
        endedAt: readWaveformPerformanceNow(ownerWindow),
        job,
        reason: accepted ? "completed" : "stale",
        requestedRevision: controller.requestedRevision,
      });
      recordWaveformCanvasProofTrace({
        completion,
        controller,
        descriptor: controller.requestedFrame,
        job,
        phase: accepted ? "job-complete-accepted" : "job-complete-stale",
        renderPlan: job.plan,
        revision: job.revision,
        shouldContinuePendingCoverage,
        traceSessionId: latest.traceSessionId,
      });
      controller.traceState.jobLifecycles.delete(job.id);
      controller.traceState.jobCauses.delete(job.id);
      if (accepted && completion?.kind === "committed") {
        recordWaveformCanvasPixelColumnProbeTrace({
          canvas,
          phase: "job-complete-accepted",
          plan: job.plan,
          revision: job.revision,
          traceSessionId: latest.traceSessionId,
        });
      }
      controller.job = null;
      if (shouldContinuePendingCoverage || controller.barPresentationAnimation) {
        scheduleNextFrame();
        if (!ownerWindow) {
          runFrame();
        }
      }
      return;
    }

    if (ownerWindow) {
      scheduleNextFrame();
    } else {
      controller.frameId = null;
    }

    if (!ownerWindow) {
      runFrame();
    }
  }, []);

  const requestDraw = useCallback(
    (dataPlan: WaveformDataPlan, options?: WaveformCanvasDrawOptions): WaveformCanvasDrawResult => {
      const latest = latestArgsRef.current;
      const controller = controllerRef.current;
      const ownerWindow =
        latest.canvasRef.current?.ownerDocument.defaultView ??
        (typeof window === "undefined" ? null : window);
      const fileKey = normalizeWaveformPathKey(latest.filePath);
      if (previousTraceFileKeyRef.current !== fileKey) {
        previousTraceFileKeyRef.current = fileKey;
        recordRenderPerformanceTrace("waveform-canvas-file-scope", {
          fileKey,
          scopeKey: dataPlan.scopeKey,
        });
      }
      const viewport = latest.viewportRef.current;
      const canvas = latest.canvasRef.current;
      const geometry =
        canvas && viewport
          ? resolveWaveformCanvasFrameGeometry({
              devicePixelRatio: canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1,
              viewportWidth: viewport.viewportWidth,
            })
          : null;
      const color = canvas ? readCanvasWaveformColor(canvas) : null;
      const previousFrame = controller.requestedFrame ?? controller.presentedFrame;
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
      syncWaveformCanvasBarPresentationAnimation({
        controller,
        nowMs: readWaveformPerformanceNow(ownerWindow),
        viewport,
      });
      const descriptor =
        renderPlan?.kind === "ready" && color
          ? createWaveformCanvasPresentationFrameDescriptor({
              color,
              current: controller.barPresentationModel,
              plan: renderPlan.plan,
            })
          : null;
      const requestTransition = resolveWaveformCanvasRenderRequestTransition({
        currentJob: controller.job?.descriptor ?? null,
        currentPresentedDirtyRanges: controller.presentedDirtyRanges,
        currentPresentedFrame: controller.presentedFrame,
        currentRequestedFrame: controller.requestedFrame,
        hasScheduledFrame: controller.frameId !== null,
        nextFrame: descriptor,
      });
      const requestCause = resolveWaveformCanvasRenderRequestTraceCause({
        current: previousFrame,
        next: descriptor,
        requestCount: controller.traceState.requestCount,
      });
      controller.traceState.requestCount += 1;
      if (requestTransition === "start-new") {
        controller.traceState.pendingJobCause = requestCause;
      }
      recordWaveformCanvasRenderLifecycleTrace({
        canvas,
        cause: requestCause,
        descriptor,
        fileKey,
        filePath: latest.filePath,
        previousFrame,
        renderPlan: renderPlan?.kind === "ready" ? renderPlan.plan : null,
        requestTransition,
        requestedRevision: controller.requestedRevision,
        scopeKey: dataPlan.scopeKey,
        status: latest.status,
        summary: latest.summary,
        traceSessionId: latest.traceSessionId,
        viewport,
      });
      recordWaveformCanvasProofTrace({
        controller,
        descriptor,
        phase: "request-transition",
        renderPlan: renderPlan?.kind === "ready" ? renderPlan.plan : null,
        requestTransition,
        revision: controller.requestedRevision,
        traceSessionId: latest.traceSessionId,
      });

      if (requestTransition !== "start-new") {
        controller.dataPlan = dataPlan;
        controller.requestedFrame = descriptor;
        if (controller.barPresentationAnimation && ownerWindow && controller.frameId === null) {
          controller.frameId = ownerWindow.requestAnimationFrame(runFrame);
        }
        if (
          requestTransition === "retarget-job" &&
          controller.job &&
          descriptor &&
          renderPlan?.kind === "ready"
        ) {
          controller.traceState.jobCauses.set(controller.job.id, requestCause);
          retargetWaveformCanvasRenderJob({
            descriptor,
            job: controller.job,
            plan: renderPlan.plan,
          });
        }
        if (requestTransition === "reuse-presented") {
          controller.presentedFrame = descriptor;
          controller.reusableFrame = descriptor;
          controller.presentedDirtyRanges = [];
        }
        recordWaveformCanvasProofTrace({
          controller,
          descriptor,
          phase: `request-${requestTransition}`,
          renderPlan: renderPlan?.kind === "ready" ? renderPlan.plan : null,
          requestTransition,
          revision: controller.requestedRevision,
          traceSessionId: latest.traceSessionId,
        });
        return {
          kind: "none",
        };
      }

      const nextRevision = controller.requestedRevision + 1;
      if (controller.job) {
        recordWaveformCanvasRenderJobTrace({
          accepted: false,
          completion: null,
          endedAt: readWaveformPerformanceNow(ownerWindow),
          job: controller.job,
          reason: "replaced",
          requestedRevision: nextRevision,
        });
        controller.traceState.jobLifecycles.delete(controller.job.id);
        controller.traceState.jobCauses.delete(controller.job.id);
      }
      controller.requestedRevision = nextRevision;
      controller.dataPlan = dataPlan;
      controller.requestedFrame = descriptor;
      controller.traceState.pendingJobCause = requestCause;
      const keepsActivePanPresentation =
        descriptor !== null &&
        controller.panPresentationTargetFrame !== null &&
        areWaveformCanvasFrameVisualSignaturesEqual(
          controller.panPresentationTargetFrame,
          descriptor,
        );
      if (!keepsActivePanPresentation) {
        resetWaveformPanPresentation({
          controller,
          ownerWindow,
        });
        if (canvas) {
          resetWaveformCanvasPanPresentation(canvas);
        }
      }
      const fastStartedAt = readWaveformPerformanceNow(ownerWindow);
      const presented = presentWaveformCanvasFrameFast({
        canvas,
        descriptor,
        descriptorPlan: renderPlan?.kind === "ready" ? renderPlan.plan : null,
        previousDirtyRanges: controller.presentedDirtyRanges,
        previous: controller.reusableFrame,
        reuseFrame: controller.reuseFrame,
      });
      const fastPresentationElapsedMs = Math.max(
        0,
        readWaveformPerformanceNow(ownerWindow) - fastStartedAt,
      );
      accumulateSpectrumCanvasFastPresentationMetrics({
        flushAfterMs: WAVEFORM_CANVAS_FAST_PRESENTATION_TRACE_FLUSH_MS,
        metrics: controller.fastPresentationMetrics,
        now: readWaveformPerformanceNow(ownerWindow),
        sample: createWaveformCanvasFastPresentationSample({
          elapsedMs: fastPresentationElapsedMs,
          result: presented,
          revision: nextRevision,
        }),
      });
      if (isRenderPerformanceTraceInstalled()) {
        recordRenderPerformanceTrace(
          "waveform-canvas-frame-diagnostic",
          createWaveformCanvasFrameDiagnosticTracePayload({
            controller,
            descriptor,
            fastPresentationElapsedMs,
            renderPlan: renderPlan?.kind === "ready" ? renderPlan.plan : null,
            requestTransition,
            result: presented,
            revision: nextRevision,
          }),
        );
      }
      let drawResult: WaveformCanvasDrawResult = {
        kind: "none",
      };
      if (presented.kind === "presented") {
        controller.presentedFrame = presented.descriptor;
        controller.reusableFrame = presented.descriptor;
        controller.presentedDirtyRanges = presented.dirtyRanges;
        controller.reuseFrame = presented.reuseFrame;
        if (
          presented.mode === "horizontal-pan" &&
          presented.dirtyRanges.length === 0 &&
          canvas &&
          options?.canStartHorizontalPanPresentation &&
          options.onHorizontalPanPresentationStart
        ) {
          const scheduled = startWaveformPanPresentation({
            canStart: options.canStartHorizontalPanPresentation,
            canvas,
            controller,
            descriptor: presented.descriptor,
            onCancel: options.onHorizontalPanPresentationCancel,
            onPrepare: options.onHorizontalPanPresentationPrepare,
            onStart: options.onHorizontalPanPresentationStart,
            shiftX: presented.plan.shiftX,
          });
          if (scheduled) {
            drawResult = {
              kind: "horizontal-pan-presentation-scheduled",
            };
          }
        }
      }

      controller.job = null;
      const shouldCompleteWithFastPresentation =
        presented.kind === "presented" &&
        (presented.mode === "zoom-affine"
          ? presented.insertionRanges.length === 0
          : (presented.mode === "dirty-redraw" || presented.mode === "horizontal-pan") &&
            presented.dirtyRanges.length === 0);
      controller.traceState.pendingJobCause = shouldCompleteWithFastPresentation
        ? null
        : requestCause;
      controller.renderSchedule =
        presented.kind === "presented" &&
        (presented.mode === "dirty-redraw" ||
          presented.mode === "horizontal-pan" ||
          presented.mode === "zoom-affine")
          ? presented.mode === "zoom-affine"
            ? presented.insertionRanges.length === 0
              ? "progressive"
              : "full-density"
            : "full-density"
          : "progressive";
      controller.renderPresentation =
        presented.kind === "presented"
          ? presented.mode === "zoom-affine" && presented.insertionRanges.length > 0
            ? {
                descriptor: presented.descriptor,
                insertionRanges: presented.insertionRanges,
                kind: "insertion",
              }
            : presented.dirtyRanges.length > 0
              ? {
                  dirtyRanges: presented.dirtyRanges,
                  descriptor: presented.descriptor,
                  kind: "dirty",
                }
              : {
                  kind: "fresh",
                }
          : {
              kind: "fresh",
            };
      recordWaveformCanvasProofTrace({
        controller,
        descriptor,
        phase: "fast-presentation-result",
        renderPlan: renderPlan?.kind === "ready" ? renderPlan.plan : null,
        requestTransition,
        result: presented,
        revision: nextRevision,
        shouldCompleteWithFastPresentation,
        traceSessionId: latest.traceSessionId,
      });

      if (controller.barPresentationAnimation && ownerWindow && controller.frameId === null) {
        controller.frameId = ownerWindow.requestAnimationFrame(runFrame);
      }

      if (shouldCompleteWithFastPresentation) {
        controller.requestedFrame = descriptor;
        controller.presentedDirtyRanges = [];
        controller.renderSchedule = "progressive";
        controller.renderPresentation = {
          kind: "fresh",
        };
        recordWaveformCanvasProofTrace({
          controller,
          descriptor,
          phase: "fast-presentation-complete",
          renderPlan: renderPlan?.kind === "ready" ? renderPlan.plan : null,
          requestTransition,
          result: presented,
          revision: nextRevision,
          shouldCompleteWithFastPresentation,
          traceSessionId: latest.traceSessionId,
        });
        recordNullableRenderPerformanceTrace(
          "waveform-canvas-fast-presentation",
          flushSpectrumCanvasFastPresentationMetrics(
            controller.fastPresentationMetrics,
            readWaveformPerformanceNow(ownerWindow),
            presented.mode === "dirty-redraw"
              ? "dirty-redraw-presented"
              : presented.mode === "zoom-affine"
                ? "zoom-affine-presented"
                : "horizontal-pan-presented",
          ),
        );
        if (!controller.barPresentationAnimation && controller.frameId !== null && ownerWindow) {
          ownerWindow.cancelAnimationFrame(controller.frameId);
          controller.frameId = null;
        }
        return drawResult;
      }

      if (controller.frameId !== null) {
        recordNullableRenderPerformanceTrace(
          "waveform-canvas-fast-presentation",
          flushDueSpectrumCanvasFastPresentationMetrics(
            controller.fastPresentationMetrics,
            readWaveformPerformanceNow(ownerWindow),
          ),
        );
        return drawResult;
      }

      if (!ownerWindow) {
        recordNullableRenderPerformanceTrace(
          "waveform-canvas-fast-presentation",
          flushSpectrumCanvasFastPresentationMetrics(
            controller.fastPresentationMetrics,
            readWaveformPerformanceNow(ownerWindow),
            "sync-run-frame",
          ),
        );
        runFrame();
        return drawResult;
      }

      recordNullableRenderPerformanceTrace(
        "waveform-canvas-fast-presentation",
        flushSpectrumCanvasFastPresentationMetrics(
          controller.fastPresentationMetrics,
          readWaveformPerformanceNow(ownerWindow),
          "render-job-scheduled",
        ),
      );
      controller.frameId = ownerWindow.requestAnimationFrame(runFrame);
      return drawResult;
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

function syncWaveformCanvasBarPresentationAnimation(args: {
  controller: WaveformCanvasRenderController;
  nowMs: number;
  viewport: WaveformViewportModel | null;
}) {
  const targetBarPresentation = args.viewport
    ? resolveWaveformBarPresentationModel(args.viewport)
    : args.controller.barPresentationModel;

  if (!targetBarPresentation) {
    args.controller.barPresentationAnimation = null;
    return;
  }

  const currentBarPresentation =
    args.controller.barPresentationAnimation && args.viewport
      ? resolveAnimatedWaveformBarPresentation({
          animation: args.controller.barPresentationAnimation,
          nowMs: args.nowMs,
          target: targetBarPresentation,
        }).model
      : args.controller.barPresentationModel;
  const zoomChanged =
    currentBarPresentation !== null &&
    Math.abs(currentBarPresentation.pixelsPerSecond - targetBarPresentation.pixelsPerSecond) >=
      0.01;

  if (!zoomChanged && !args.controller.barPresentationAnimation) {
    args.controller.barPresentationModel = targetBarPresentation;
  }

  args.controller.barPresentationAnimation = createWaveformBarPresentationAnimation({
    from: currentBarPresentation,
    nowMs: args.nowMs,
    to: targetBarPresentation,
    zoomChanged,
  });
  args.controller.barPresentationModel = args.controller.barPresentationAnimation
    ? currentBarPresentation
    : targetBarPresentation;
}

function createWaveformCanvasPresentationRenderPlan(args: {
  current: WaveformBarPresentationModel | null;
  plan: WaveformCanvasRenderPlan;
}): WaveformCanvasPresentationRenderPlan {
  if (!args.current) {
    return args.plan;
  }

  return {
    ...args.plan,
    viewport: {
      ...args.plan.viewport,
      contentWidth: resolveWaveformContentWidth({
        durationMs: args.plan.viewport.durationMs,
        pixelsPerSecond: args.current.pixelsPerSecond,
        viewportWidth: args.plan.viewport.viewportWidth,
      }),
      focusSeconds:
        typeof args.current.anchorVisualSeconds === "number" &&
        Number.isFinite(args.current.anchorVisualSeconds)
          ? waveformVisualSecondsToAudioSeconds(args.current.anchorVisualSeconds)
          : args.plan.viewport.focusSeconds,
      pixelsPerSecond: args.current.pixelsPerSecond,
      scrollLeft: args.current.scrollLeft,
    },
  } satisfies WaveformCanvasPresentationRenderPlan;
}

function createWaveformCanvasPresentationFrameDescriptor(args: {
  color: string;
  current: WaveformBarPresentationModel | null;
  plan: WaveformCanvasRenderPlan;
}) {
  return createWaveformCanvasFrameDescriptor({
    color: args.color,
    plan: createWaveformCanvasPresentationRenderPlan({
      current: args.current,
      plan: args.plan,
    }),
  });
}

function resolveWaveformCanvasBarPresentationFrame(args: {
  canvas: HTMLCanvasElement;
  controller: WaveformCanvasRenderController;
  ownerWindow: Window | null;
  viewport: WaveformViewportModel;
}): WaveformCanvasBarPresentationFrame {
  const targetBarPresentation = resolveWaveformBarPresentationModel(args.viewport);
  const barPresentationResolution = resolveAnimatedWaveformBarPresentation({
    animation: args.controller.barPresentationAnimation,
    nowMs: readWaveformPerformanceNow(args.ownerWindow),
    target: targetBarPresentation,
  });
  const isBarPresentationAnimating =
    args.controller.barPresentationAnimation !== null && !barPresentationResolution.completed;

  args.controller.barPresentationModel = barPresentationResolution.model;
  applyWaveformCanvasBarPresentation({
    canvas: args.canvas,
    presentation: isBarPresentationAnimating
      ? {
          current: barPresentationResolution.model,
          target: targetBarPresentation,
        }
      : null,
  });

  if (barPresentationResolution.completed) {
    args.controller.barPresentationAnimation = null;
    args.controller.barPresentationModel = targetBarPresentation;
  }

  return {
    isAnimating: isBarPresentationAnimating,
  };
}

export function resolveWaveformBarPresentationTransform(args: {
  current: WaveformBarPresentationModel;
  target: WaveformBarPresentationModel;
}) {
  const translateX = args.current.scrollLeft - args.target.scrollLeft;

  return `translate3d(${translateX}px, 0, 0)`;
}

function createWaveformCanvasBarPresentationTracePayload(args: {
  isAnimating: boolean;
  presentation: {
    current: WaveformBarPresentationModel;
    target: WaveformBarPresentationModel;
  } | null;
  traceSessionId: string;
}) {
  if (!args.presentation) {
    return {
      isAnimating: args.isAnimating,
      presentation: null,
      traceSessionId: args.traceSessionId,
    } satisfies Record<string, unknown>;
  }

  return {
    isAnimating: args.isAnimating,
    presentation: {
      currentPixelsPerSecond: args.presentation.current.pixelsPerSecond,
      currentScrollLeft: args.presentation.current.scrollLeft,
      cssTransform: null,
      spacingEffect: "canvas-column-transport",
      targetPixelsPerSecond: args.presentation.target.pixelsPerSecond,
      targetScrollLeft: args.presentation.target.scrollLeft,
    },
    traceSessionId: args.traceSessionId,
  } satisfies Record<string, unknown>;
}

function applyWaveformCanvasBarPresentation(args: {
  canvas: HTMLCanvasElement;
  presentation: {
    current: WaveformBarPresentationModel;
    target: WaveformBarPresentationModel;
  } | null;
}) {
  void args.presentation;
  resetWaveformCanvasBarPresentation(args.canvas);
}

function resetWaveformCanvasBarPresentation(canvas: HTMLCanvasElement) {
  canvas.style.removeProperty("--waveform-canvas-bar-presentation-transform");
  canvas.style.removeProperty("--waveform-canvas-bar-presentation-origin");
  canvas.style.removeProperty("--waveform-canvas-bar-presentation-will-change");
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
      if (controller.job) {
        recordWaveformCanvasRenderJobTrace({
          accepted: false,
          completion: null,
          endedAt: readWaveformPerformanceNow(ownerWindow ?? null),
          job: controller.job,
          reason: "cancelled",
          requestedRevision: controller.requestedRevision,
        });
        controller.traceState.jobLifecycles.delete(controller.job.id);
        controller.traceState.jobCauses.delete(controller.job.id);
      }
      if (controller.frameId !== null && ownerWindow) {
        ownerWindow.cancelAnimationFrame(controller.frameId);
      }
      resetWaveformPanPresentation({
        controller,
        ownerWindow: ownerWindow ?? null,
      });
      if (latest.canvasRef.current) {
        resetWaveformCanvasPanPresentation(latest.canvasRef.current);
        resetWaveformCanvasBarPresentation(latest.canvasRef.current);
      }
      recordNullableRenderPerformanceTrace(
        "waveform-canvas-fast-presentation",
        flushSpectrumCanvasFastPresentationMetrics(
          controller.fastPresentationMetrics,
          readWaveformPerformanceNow(ownerWindow ?? null),
          "cleanup",
        ),
      );
      recordNullableRenderPerformanceTrace(
        "waveform-canvas-render-empty",
        flushSpectrumCanvasRenderEmptyMetrics(
          controller.renderEmptyMetrics,
          readWaveformPerformanceNow(ownerWindow ?? null),
          "cleanup",
        ),
      );
      controller.frameId = null;
      controller.job = null;
      controller.barPresentationAnimation = null;
      controller.barPresentationModel = null;
      controller.dataPlan = null;
      controller.reusableFrame = null;
      controller.presentedFrame = null;
      controller.presentedDirtyRanges = [];
      controller.renderSchedule = "progressive";
      controller.renderPresentation = {
        kind: "fresh",
      };
      controller.requestedFrame = null;
      controller.reuseFrame = null;
      controller.fastPresentationMetrics = createSpectrumCanvasFastPresentationMetrics();
      controller.renderEmptyMetrics = createSpectrumCanvasRenderEmptyMetrics();
      controller.panPresentationFrameId = null;
      controller.panPresentationTargetFrame = null;
      controller.panPresentationTimeoutId = null;
      controller.traceState = {
        jobCauses: new Map(),
        jobLifecycles: new Map(),
        jobStartCount: 0,
        pendingJobCause: null,
        requestCount: 0,
      };
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
  const retainedWidth = Math.ceil(viewportWidth * WAVEFORM_CANVAS_RETAINED_VIEWPORTS);
  const rasterStartX = -retainedWidth;
  const rasterWidth = Math.max(1, viewportWidth + retainedWidth * 2);
  const backingWidth = Math.max(1, Math.ceil(rasterWidth * devicePixelRatio));
  const backingHeight = Math.max(1, Math.ceil(WAVEFORM_CANVAS_HEIGHT * devicePixelRatio));

  return {
    backingHeight,
    backingWidth,
    devicePixelRatio,
    rasterStartX,
    rasterWidth,
    viewportWidth,
  };
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
  const renderStartSeconds = resolveWaveformViewportAudioSeconds({
    pixelsPerSecond: args.viewport.pixelsPerSecond,
    scrollLeft: args.viewport.scrollLeft,
    viewportX: args.geometry.rasterStartX,
  });
  const renderEndSeconds = resolveWaveformViewportAudioSeconds({
    pixelsPerSecond: args.viewport.pixelsPerSecond,
    scrollLeft: args.viewport.scrollLeft,
    viewportX: resolveWaveformCanvasRasterEndX(args.geometry),
  });
  const renderSecondsWindow = {
    endSeconds: Math.max(plan.visibleSecondsWindow.endSeconds, renderEndSeconds),
    startSeconds: Math.min(plan.visibleSecondsWindow.startSeconds, renderStartSeconds),
  };
  const levelIndexes = resolveWaveformLevelTileIndexes({
    endSeconds: renderSecondsWindow.endSeconds,
    scopeKey: plan.scopeKey,
    startSeconds: renderSecondsWindow.startSeconds,
    tileCache: args.tileCache,
    tileWidth: WAVEFORM_DATA_TILE_WIDTH,
  });
  const candidateLevels = resolveWaveformCandidateLevels({
    dataPixelsPerSecond: plan.dataPixelsPerSecond,
    levelIndexes,
    pixelsPerSecond: args.viewport.pixelsPerSecond,
  });

  if (candidateLevels.length === 0 && plan.visibleSecondsWindow.hasAudio) {
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
      tileKeysByIndex: new Map<number, string>(),
      tilesByIndex: new Map<number, TrackWaveformTile>(),
    };
    const tileIndex = Math.floor(entry.data.start_px / Math.max(1, args.tileWidth));
    level.tileKeysByIndex.set(tileIndex, entry.key);
    level.tilesByIndex.set(tileIndex, entry.data);
    byLevel.set(pixelsPerSecond, level);
  }

  return byLevel;
}

function createWaveformCanvasRasterTarget(args: {
  canvas: HTMLCanvasElement;
  color: string;
  geometry: WaveformCanvasFrameGeometry;
  presentation: WaveformCanvasRenderPresentation;
}): WaveformCanvasRasterTargetResolution {
  const target = resolveWaveformCanvasRasterTarget(args);

  if (target.kind === "empty") {
    return target;
  }

  renderWaveformCanvasEffect({
    command: {
      kind: "prepare-job-target",
      presentation: args.presentation,
      target: target.target,
    },
  });

  return target;
}

function prepareWaveformCanvasJobTarget(args: {
  presentation: WaveformCanvasRenderPresentation;
  target: WaveformCanvasRasterTarget;
}) {
  const context = args.target.context;

  applyWaveformVisibleCanvasGeometry({
    canvas: args.target.canvas,
    geometry: args.target.geometry,
  });
  context.resetTransform();
  if (args.presentation.kind === "fresh") {
    context.clearRect(0, 0, args.target.geometry.backingWidth, args.target.geometry.backingHeight);
    resetWaveformCanvasBarPresentation(args.target.canvas);
  }
  context.scale(args.target.geometry.devicePixelRatio, args.target.geometry.devicePixelRatio);
  context.translate(-args.target.geometry.rasterStartX, 0);
  context.imageSmoothingEnabled = false;
  context.fillStyle = args.target.color;
  context.globalAlpha = 1;
}

function renderWaveformCanvasEffect(args: {
  command: WaveformCanvasRenderEffectCommand;
}):
  | WaveformCanvasChunkResult
  | WaveformCanvasFastPresentationResult
  | WaveformCanvasRangeDrawResult
  | void {
  if (args.command.kind === "prepare-job-target") {
    prepareWaveformCanvasJobTarget({
      presentation: args.command.presentation,
      target: args.command.target,
    });
    return;
  }

  if (args.command.kind === "fast-presentation") {
    return runWaveformCanvasFastPresentationEffect(args.command.command);
  }

  if (args.command.kind === "job-chunk") {
    return runWaveformCanvasJobChunkEffect(args.command.command);
  }

  return runWaveformCanvasColumnRangeEffect({
    plan: args.command.plan,
    range: args.command.range,
    replaceExistingColumns: args.command.replaceExistingColumns,
    target: args.command.target,
  });
}

function resolveWaveformCanvasRasterTarget(args: {
  canvas: HTMLCanvasElement;
  color: string;
  geometry: WaveformCanvasFrameGeometry;
}): WaveformCanvasRasterTargetResolution {
  const context = args.canvas.getContext("2d");
  if (!context) {
    return {
      empty: {
        geometry: args.geometry,
        kind: "missing-context",
      },
      kind: "empty",
    };
  }

  return {
    kind: "ready",
    target: {
      canvas: args.canvas,
      color: args.color,
      context,
      geometry: {
        ...args.geometry,
      },
      kind: "visible",
    },
  };
}

function createWaveformCanvasRenderJob(args: {
  descriptor: WaveformCanvasFrameDescriptor;
  id: number;
  plan: WaveformCanvasRenderPlan;
  presentation: WaveformCanvasRenderPresentation;
  revision: number;
  schedule: WaveformCanvasCursorSchedule;
  target: WaveformCanvasRasterTarget;
  startedAt: number;
}): WaveformCanvasRenderJob {
  return {
    coverageTrace: createWaveformCanvasRenderPlanCoverageTracePayload(args.plan),
    cursor: createWaveformCanvasRenderCursor({
      geometry: args.plan.geometry,
      presentation: args.presentation,
      schedule: args.schedule,
    }),
    descriptor: args.descriptor,
    id: args.id,
    metrics: createSpectrumCanvasRenderJobMetrics(args.startedAt),
    plan: args.plan,
    presentation: args.presentation,
    retargeted: false,
    revision: args.revision,
    target: args.target,
  };
}

function retargetWaveformCanvasRenderJob(args: {
  descriptor: WaveformCanvasFrameDescriptor;
  job: WaveformCanvasRenderJob;
  plan: WaveformCanvasRenderPlan;
}) {
  args.job.cursor = {
    ...args.job.cursor,
    rangeComposition: "coalesced",
    retargetRanges: resolveWaveformCanvasRetargetRanges({
      currentCursor: args.job.cursor,
      geometry: args.job.plan.geometry,
    }),
  };
  args.job.coverageTrace = createWaveformCanvasRenderPlanCoverageTracePayload(args.plan);
  args.job.descriptor = args.descriptor;
  args.job.plan = args.plan;
  args.job.retargeted = true;
}

function createWaveformCanvasRenderPlanTracePayload(plan: WaveformCanvasRenderPlan) {
  return {
    availableLevels: plan.availableLevels,
    dataSignature: createWaveformCanvasRenderPlanDataSignature(plan),
    dataPixelsPerSecond: plan.dataPixelsPerSecond,
    devicePixelRatio: plan.geometry.devicePixelRatio,
    durationMs: plan.viewport.durationMs,
    candidateLevelCount: plan.candidateLevels.length,
    pixelsPerSecond: plan.viewport.pixelsPerSecond,
    rasterEndX: resolveWaveformCanvasRasterEndX(plan.geometry),
    rasterStartX: plan.geometry.rasterStartX,
    rasterWidth: plan.geometry.rasterWidth,
    scopeKey: plan.scopeKey,
    scrollLeft: plan.viewport.scrollLeft,
    viewportWidth: plan.geometry.viewportWidth,
    visibleEndSeconds: plan.visibleSecondsWindow.endSeconds,
    visibleStartSeconds: plan.visibleSecondsWindow.startSeconds,
  };
}

function createWaveformDataPlanBoundaryTracePayload(args: {
  interaction?: WaveformDataPlanInteraction;
  mode: WaveformDataPlanMode;
  plan: WaveformDataPlan | null;
  source: WaveformTracePlanSource;
  traceSessionId: string;
  viewport: WaveformViewportModel | null;
}) {
  return {
    interaction: args.interaction ?? null,
    mode: args.mode,
    plan: args.plan
      ? {
          dataPixelsPerSecond: args.plan.dataPixelsPerSecond,
          mode: args.plan.mode,
          overscanWindowEndPx: args.plan.overscanWindow.endPx,
          overscanWindowStartPx: args.plan.overscanWindow.startPx,
          requestCount: args.plan.requests.length,
          scopeKey: args.plan.scopeKey,
          visibleEndSeconds: args.plan.visibleSecondsWindow.endSeconds,
          visibleIndexCount: args.plan.visibleIndexes.length,
          visibleIndexSample: args.plan.visibleIndexes.slice(0, 8),
          visibleStartSeconds: args.plan.visibleSecondsWindow.startSeconds,
          visibleWindowEndPx: args.plan.visibleWindow.endPx,
          visibleWindowStartPx: args.plan.visibleWindow.startPx,
        }
      : null,
    source: args.source,
    traceSessionId: args.traceSessionId,
    viewport: args.viewport
      ? {
          contentWidth: args.viewport.contentWidth,
          durationMs: args.viewport.durationMs,
          focusSeconds: args.viewport.focusSeconds,
          maximumPixelsPerSecond: args.viewport.maximumPixelsPerSecond,
          pixelsPerSecond: args.viewport.pixelsPerSecond,
          scrollLeft: args.viewport.scrollLeft,
          viewportWidth: args.viewport.viewportWidth,
        }
      : null,
  } satisfies Record<string, unknown>;
}

function recordWaveformDataPlanBoundaryTrace(args: {
  interaction?: WaveformDataPlanInteraction;
  mode: WaveformDataPlanMode;
  plan: WaveformDataPlan | null;
  source: WaveformTracePlanSource;
  traceSessionId: string;
  viewport: WaveformViewportModel | null;
}) {
  if (!isRenderPerformanceTraceInstalled()) {
    return;
  }

  recordRenderPerformanceTrace(
    "waveform-data-plan-boundary",
    createWaveformDataPlanBoundaryTracePayload(args),
  );
}

function createWaveformDataPipelineTraceMetrics(): WaveformDataPipelineTraceMetrics {
  return {
    cacheHitCount: 0,
    cacheStoreCount: 0,
    droppedResultCount: 0,
    firstPlanSignature: null,
    firstScope: null,
    firstScopeKey: null,
    firstTraceAt: null,
    inFlightSkipCount: 0,
    lastAcceptedPlanSignature: null,
    lastArrivalCacheKey: null,
    lastArrivalPriority: null,
    lastPlanSignature: null,
    lastScope: null,
    lastScopeKey: null,
    nextFlushAt: null,
    presentationArrivalCount: 0,
    presentationRequestKeyCount: 0,
    queuedCount: 0,
    requestCount: 0,
    reusedPlanCount: 0,
    scheduledCount: 0,
  };
}

function accumulateWaveformDataPipelineTraceMetrics(args: {
  cachedRequestCount: number;
  flushAfterMs: number;
  inFlightOrQueuedRequestCount: number;
  metrics: WaveformDataPipelineTraceMetrics;
  now: number;
  plan: WaveformDataPlan;
  planSignature: string;
  presentationRequestKeyCount: number;
  queuedBeforeCount: number;
  scheduledRequestCount: number;
  scope: WaveformDataPlanScope;
  scopedRequestCount: number;
}) {
  args.metrics.firstTraceAt ??= args.now;
  args.metrics.nextFlushAt ??= args.now + args.flushAfterMs;
  args.metrics.firstPlanSignature ??= args.planSignature;
  args.metrics.firstScope ??= args.scope;
  args.metrics.firstScopeKey ??= args.plan.scopeKey;
  args.metrics.lastPlanSignature = args.planSignature;
  args.metrics.lastScope = args.scope;
  args.metrics.lastScopeKey = args.plan.scopeKey;
  args.metrics.cacheHitCount += args.cachedRequestCount;
  args.metrics.inFlightSkipCount += args.inFlightOrQueuedRequestCount;
  args.metrics.presentationRequestKeyCount = args.presentationRequestKeyCount;
  args.metrics.queuedCount = args.queuedBeforeCount + args.scheduledRequestCount;
  args.metrics.requestCount += args.scopedRequestCount;
  args.metrics.scheduledCount += args.scheduledRequestCount;
}

function accumulateWaveformDataPipelineReusedPlanTrace(args: {
  flushAfterMs: number;
  metrics: WaveformDataPipelineTraceMetrics;
  now: number;
  plan: WaveformDataPlan;
  planSignature: string;
  scope: WaveformDataPlanScope;
}) {
  args.metrics.firstTraceAt ??= args.now;
  args.metrics.nextFlushAt ??= args.now + args.flushAfterMs;
  args.metrics.firstPlanSignature ??= args.planSignature;
  args.metrics.firstScope ??= args.scope;
  args.metrics.firstScopeKey ??= args.plan.scopeKey;
  args.metrics.lastPlanSignature = args.planSignature;
  args.metrics.lastScope = args.scope;
  args.metrics.lastScopeKey = args.plan.scopeKey;
  args.metrics.reusedPlanCount += 1;
}

function accumulateWaveformDataPipelineTileResultTrace(args: {
  cacheKey: string;
  cached: boolean;
  metrics: WaveformDataPipelineTraceMetrics;
  presentation: boolean;
  priority: WaveformDataRequestPriority;
}) {
  args.metrics.lastArrivalCacheKey = args.cacheKey;
  args.metrics.lastArrivalPriority = args.priority;
  if (args.cached) {
    args.metrics.cacheStoreCount += 1;
  } else {
    args.metrics.droppedResultCount += 1;
  }
  if (args.presentation) {
    args.metrics.presentationArrivalCount += 1;
  }
}

function flushDueWaveformDataPipelineTraceMetrics(
  metrics: WaveformDataPipelineTraceMetrics,
  now: number,
) {
  if (metrics.nextFlushAt === null || now < metrics.nextFlushAt) {
    return null;
  }

  return flushWaveformDataPipelineTraceMetrics(metrics, now, "interval");
}

function flushWaveformDataPipelineTraceMetrics(
  metrics: WaveformDataPipelineTraceMetrics,
  now: number,
  reason: string,
) {
  if (
    metrics.requestCount <= 0 &&
    metrics.reusedPlanCount <= 0 &&
    metrics.cacheStoreCount <= 0 &&
    metrics.droppedResultCount <= 0
  ) {
    return null;
  }

  const payload = {
    cacheHitCount: metrics.cacheHitCount,
    cacheStoreCount: metrics.cacheStoreCount,
    droppedResultCount: metrics.droppedResultCount,
    firstPlanSignature: metrics.firstPlanSignature,
    firstScope: metrics.firstScope,
    firstScopeKey: metrics.firstScopeKey,
    inFlightSkipCount: metrics.inFlightSkipCount,
    lastAcceptedPlanSignature: metrics.lastAcceptedPlanSignature,
    lastArrivalCacheKey: metrics.lastArrivalCacheKey,
    lastArrivalPriority: metrics.lastArrivalPriority,
    lastPlanSignature: metrics.lastPlanSignature,
    lastScope: metrics.lastScope,
    lastScopeKey: metrics.lastScopeKey,
    presentationArrivalCount: metrics.presentationArrivalCount,
    presentationRequestKeyCount: metrics.presentationRequestKeyCount,
    queuedCount: metrics.queuedCount,
    reason,
    requestCount: metrics.requestCount,
    reusedPlanCount: metrics.reusedPlanCount,
    scheduledCount: metrics.scheduledCount,
    windowDurationMs: metrics.firstTraceAt === null ? 0 : Math.max(0, now - metrics.firstTraceAt),
  } satisfies Record<string, unknown>;

  Object.assign(metrics, createWaveformDataPipelineTraceMetrics());
  return payload;
}

function createWaveformCanvasRenderPlanCoverageTracePayload(
  plan: WaveformCanvasRenderPlan,
): WaveformCanvasRenderPlanCoverageTracePayload {
  const rasterAudioWindowStartSeconds = resolveWaveformViewportAudioSeconds({
    pixelsPerSecond: plan.viewport.pixelsPerSecond,
    scrollLeft: plan.viewport.scrollLeft,
    viewportX: plan.geometry.rasterStartX,
  });
  const rasterAudioWindowEndSeconds = resolveWaveformViewportAudioSeconds({
    pixelsPerSecond: plan.viewport.pixelsPerSecond,
    scrollLeft: plan.viewport.scrollLeft,
    viewportX: resolveWaveformCanvasRasterEndX(plan.geometry),
  });
  const durationSeconds = resolveWaveformDurationSeconds(plan.viewport.durationMs);
  const audioWindowStartSeconds = clampNumber(rasterAudioWindowStartSeconds, 0, durationSeconds);
  const audioWindowEndSeconds = clampNumber(rasterAudioWindowEndSeconds, 0, durationSeconds);
  const targetTileRange = resolveWaveformCanvasTargetTileRange({
    dataPixelsPerSecond: plan.dataPixelsPerSecond,
    endSeconds: audioWindowEndSeconds,
    startSeconds: audioWindowStartSeconds,
  });
  const targetLevel =
    plan.candidateLevels.find((level) => level.pixelsPerSecond === plan.dataPixelsPerSecond) ??
    null;
  const targetTileIndexes = targetLevel
    ? Array.from(targetLevel.tileKeysByIndex.keys()).sort((left, right) => left - right)
    : [];
  const targetTileIndexSet = new Set(targetTileIndexes);
  const expectedTargetTileIndexes =
    targetTileRange === null
      ? []
      : Array.from(
          { length: targetTileRange.endIndex - targetTileRange.startIndex + 1 },
          (_, index) => targetTileRange.startIndex + index,
        );
  const missingTargetTileIndexes = expectedTargetTileIndexes.filter(
    (index) => !targetTileIndexSet.has(index),
  );
  const missingTargetTileRanges = createWaveformTileIndexRanges(missingTargetTileIndexes);
  const targetLevelTileRanges = createWaveformTileIndexRanges(targetTileIndexes);

  return {
    audioWindowEndSeconds,
    audioWindowStartSeconds,
    availableLevels: plan.availableLevels,
    candidateLevels: plan.candidateLevels.map((level) => {
      const tileIndexes = Array.from(level.tileKeysByIndex.keys()).sort(
        (left, right) => left - right,
      );

      return {
        dataPixelsPerSecond: level.pixelsPerSecond,
        firstTileIndex: tileIndexes[0] ?? null,
        lastTileIndex: tileIndexes.at(-1) ?? null,
        tileCount: tileIndexes.length,
        tileIndexSample: tileIndexes.slice(0, 8),
      };
    }),
    dataPixelsPerSecond: plan.dataPixelsPerSecond,
    missingTargetTileIndexes: missingTargetTileIndexes.slice(0, 16),
    missingTargetTileRangeCount: missingTargetTileRanges.length,
    missingTargetTileRanges: missingTargetTileRanges.slice(0, 8),
    rasterAudioWindowEndSeconds,
    rasterAudioWindowStartSeconds,
    targetLevelTileCount: targetTileIndexes.length,
    targetLevelTileIndexSample: targetTileIndexes.slice(0, 8),
    targetLevelTileRangeCount: targetLevelTileRanges.length,
    targetLevelTileRanges: targetLevelTileRanges.slice(0, 8),
    targetTileEndIndex: targetTileRange?.endIndex ?? null,
    targetTileStartIndex: targetTileRange?.startIndex ?? null,
  };
}

function resolveWaveformCanvasTargetTileRange(args: {
  dataPixelsPerSecond: number;
  endSeconds: number;
  startSeconds: number;
}): WaveformTileIndexRange | null {
  if (args.endSeconds <= args.startSeconds) {
    return null;
  }

  const dataPixelsPerSecond = Math.max(1, args.dataPixelsPerSecond);
  const startPx = Math.max(0, Math.floor(args.startSeconds * dataPixelsPerSecond));
  const endPx = Math.max(startPx + 1, Math.ceil(args.endSeconds * dataPixelsPerSecond));

  return {
    endIndex: Math.floor((endPx - 1) / WAVEFORM_DATA_TILE_WIDTH),
    startIndex: Math.floor(startPx / WAVEFORM_DATA_TILE_WIDTH),
  };
}

function createWaveformTileIndexRanges(indexes: readonly number[]): WaveformTileIndexRange[] {
  const sortedIndexes = Array.from(new Set(indexes))
    .filter((index) => Number.isInteger(index))
    .sort((left, right) => left - right);
  const ranges: WaveformTileIndexRange[] = [];
  let activeStartIndex: number | null = null;
  let activeEndIndex: number | null = null;

  for (const index of sortedIndexes) {
    if (activeEndIndex === index) {
      activeEndIndex = index + 1;
      continue;
    }

    if (activeStartIndex !== null && activeEndIndex !== null) {
      ranges.push({
        endIndex: activeEndIndex,
        startIndex: activeStartIndex,
      });
    }
    activeStartIndex = index;
    activeEndIndex = index + 1;
  }

  if (activeStartIndex !== null && activeEndIndex !== null) {
    ranges.push({
      endIndex: activeEndIndex,
      startIndex: activeStartIndex,
    });
  }

  return ranges;
}

function createWaveformCanvasRenderPlanDataSignature(plan: WaveformCanvasRenderPlan) {
  const targetLevel = plan.candidateLevels.find(
    (level) => level.pixelsPerSecond === plan.dataPixelsPerSecond,
  );
  const levels = targetLevel ? [targetLevel] : [];
  const levelSignatures = levels.map((level) => {
    const tileSignatures = Array.from(level.tileKeysByIndex.entries())
      .sort((left, right) => left[0] - right[0])
      .map(([index, key]) => `${index}:${key}`)
      .join(",");

    return `${level.pixelsPerSecond}(${tileSignatures})`;
  });

  return levelSignatures.join(";");
}

function createWaveformCanvasRenderPlanEmptyMetricsPayload(empty: WaveformCanvasRenderPlanEmpty) {
  return {
    kind: empty.kind,
    status: "status" in empty ? empty.status : null,
    tileCacheSize: "tileCacheSize" in empty ? empty.tileCacheSize : null,
    viewportWidth: empty.geometry.viewportWidth,
  };
}

function createWaveformCanvasViewportTracePayload(viewport: WaveformViewportModel | null) {
  if (!viewport) {
    return null;
  }

  return {
    contentWidth: viewport.contentWidth,
    durationMs: viewport.durationMs,
    focusSeconds: viewport.focusSeconds,
    maximumPixelsPerSecond: viewport.maximumPixelsPerSecond,
    pixelsPerSecond: viewport.pixelsPerSecond,
    scrollLeft: viewport.scrollLeft,
    viewportWidth: viewport.viewportWidth,
  };
}

function resolveWaveformCanvasRenderRequestTraceCause(args: {
  current: WaveformCanvasFrameDescriptor | null;
  next: WaveformCanvasFrameDescriptor | null;
  requestCount: number;
}): WaveformCanvasRenderRequestTraceCause {
  if (!args.next) {
    return "empty";
  }

  if (!args.current || args.requestCount <= 0) {
    return "initial-mount";
  }

  const current = args.current;
  const next = args.next;
  if (current.scopeKey !== next.scopeKey) {
    return "scope-change";
  }
  if (
    current.geometry.viewportWidth !== next.geometry.viewportWidth ||
    current.geometry.rasterWidth !== next.geometry.rasterWidth ||
    current.geometry.rasterStartX !== next.geometry.rasterStartX
  ) {
    return "geometry-change";
  }
  if (current.dataPixelsPerSecond !== next.dataPixelsPerSecond) {
    return "density-change";
  }
  if (current.dataSignature !== next.dataSignature) {
    return "data-change";
  }
  if (Math.abs(current.viewport.scrollLeft - next.viewport.scrollLeft) > 0.001) {
    return "scroll";
  }

  return "repeat";
}

function createWaveformCanvasRenderLifecycleTracePayload(args: {
  canvas: HTMLCanvasElement | null;
  cause: WaveformCanvasRenderRequestTraceCause;
  descriptor: WaveformCanvasFrameDescriptor | null;
  fileKey: string;
  filePath: string | null;
  previousFrame: WaveformCanvasFrameDescriptor | null;
  renderPlan: WaveformCanvasRenderPlan | null;
  requestTransition: string;
  requestedRevision: number;
  scopeKey: string | null;
  status: WaveformStatus;
  summary: TrackWaveformSummary;
  traceSessionId: string;
  viewport: WaveformViewportModel | null;
}) {
  return {
    canvas: args.canvas
      ? {
          height: args.canvas.height,
          width: args.canvas.width,
        }
      : null,
    cause: args.cause,
    descriptor: createWaveformCanvasFrameSignatureTracePayload(args.descriptor),
    fileKey: args.fileKey,
    filePathPresent: args.filePath !== null,
    plan: args.renderPlan ? createWaveformCanvasRenderPlanTracePayload(args.renderPlan) : null,
    previousFrame: createWaveformCanvasFrameSignatureTracePayload(args.previousFrame),
    requestTransition: args.requestTransition,
    requestedRevision: args.requestedRevision,
    scopeKey: args.scopeKey,
    status: args.status,
    summary: {
      basePointsPerSecond: args.summary.base_points_per_second,
      cacheKey: args.summary.cache_key,
      durationMs: args.summary.duration_ms,
      levelCount: args.summary.levels.length,
      levels: args.summary.levels,
    },
    traceSessionId: args.traceSessionId,
    viewport: createWaveformCanvasViewportTracePayload(args.viewport),
  } satisfies Record<string, unknown>;
}

function recordWaveformCanvasRenderLifecycleTrace(args: {
  canvas: HTMLCanvasElement | null;
  cause: WaveformCanvasRenderRequestTraceCause;
  descriptor: WaveformCanvasFrameDescriptor | null;
  fileKey: string;
  filePath: string | null;
  previousFrame: WaveformCanvasFrameDescriptor | null;
  renderPlan: WaveformCanvasRenderPlan | null;
  requestTransition: string;
  requestedRevision: number;
  scopeKey: string | null;
  status: WaveformStatus;
  summary: TrackWaveformSummary;
  traceSessionId: string;
  viewport: WaveformViewportModel | null;
}) {
  if (!isRenderPerformanceTraceInstalled()) {
    return;
  }

  recordRenderPerformanceTrace(
    "waveform-canvas-render-lifecycle",
    createWaveformCanvasRenderLifecycleTracePayload(args),
  );
}

function createWaveformCanvasFastPresentationSample(args: {
  elapsedMs: number;
  result: WaveformCanvasFastPresentationResult;
  revision: number;
}) {
  if (args.result.kind === "empty") {
    return {
      elapsedMs: args.elapsedMs,
      kind: "empty" as const,
      planKind: args.result.plan?.kind ?? null,
      reason: args.result.reason,
      revision: args.revision,
    };
  }

  return {
    drawSummary: summarizeSpectrumCanvasColumnTraceResults(args.result.draws),
    elapsedMs: args.elapsedMs,
    insertionRanges:
      args.result.mode === "zoom-affine"
        ? summarizeSpectrumCanvasColumnRanges(args.result.insertionRanges)
        : null,
    insertionWidthPx: args.result.mode === "zoom-affine" ? args.result.insertionWidthPx : null,
    kind: "presented" as const,
    mode: args.result.mode,
    planKind: args.result.plan.kind,
    revision: args.revision,
  };
}

function createWaveformCanvasFrameDiagnosticTracePayload(args: {
  controller: WaveformCanvasRenderController;
  descriptor: WaveformCanvasFrameDescriptor | null;
  fastPresentationElapsedMs: number;
  renderPlan: WaveformCanvasRenderPlan | null;
  requestTransition: string;
  result: WaveformCanvasFastPresentationResult;
  revision: number;
}) {
  const previousDirtyRanges = args.controller.presentedDirtyRanges;
  const nextDirtyRanges = args.result.kind === "presented" ? args.result.dirtyRanges : [];
  const draws =
    args.result.kind === "presented"
      ? summarizeSpectrumCanvasColumnTraceResults(args.result.draws)
      : null;
  const coverage = args.renderPlan
    ? createWaveformCanvasRenderPlanCoverageTracePayload(args.renderPlan)
    : null;
  const zoomAffineTransport =
    args.result.kind === "presented" && args.result.plan.kind === "zoom-affine" && args.descriptor
      ? resolveWaveformCanvasZoomAffineTransportPlan({
          current: args.descriptor,
          plan: args.result.plan,
          previous: args.result.reuseFrame
            ? {
                backingHeight: args.result.reuseFrame.height,
                backingWidth: args.result.reuseFrame.width,
                devicePixelRatio: args.descriptor.geometry.devicePixelRatio,
                rasterStartX: args.descriptor.geometry.rasterStartX,
                rasterWidth:
                  args.result.reuseFrame.width / args.descriptor.geometry.devicePixelRatio,
                viewportWidth: args.descriptor.geometry.viewportWidth,
              }
            : args.descriptor.geometry,
        })
      : null;
  const insertionRanges =
    args.result.kind === "presented" && args.result.mode === "zoom-affine"
      ? args.result.insertionRanges
      : [];

  return {
    coverage,
    dataSignature: args.descriptor?.dataSignature ?? null,
    descriptorPresent: args.descriptor !== null,
    draws,
    exposedRanges:
      args.result.kind === "presented"
        ? summarizeSpectrumCanvasColumnRanges(args.result.exposedRanges)
        : null,
    fastPresentationElapsedMs: args.fastPresentationElapsedMs,
    fastPresentationKind: args.result.kind,
    fastPresentationMode: args.result.kind === "presented" ? args.result.mode : null,
    fastPresentationReason: args.result.kind === "empty" ? args.result.reason : null,
    nextDirtyRanges: summarizeSpectrumCanvasColumnRanges(nextDirtyRanges),
    plan: args.renderPlan ? createWaveformCanvasRenderPlanTracePayload(args.renderPlan) : null,
    reusePlan:
      args.result.kind === "presented" && args.result.plan.kind === "zoom-affine"
        ? {
            anchorViewportX: args.result.plan.anchorViewportX,
            anchorVisualSeconds: args.result.plan.anchorVisualSeconds,
            dirtyRanges: summarizeSpectrumCanvasColumnRanges(args.result.plan.dirtyRanges),
            exposedRanges: summarizeSpectrumCanvasColumnRanges(args.result.plan.exposedRanges),
            insertionRanges: summarizeSpectrumCanvasColumnRanges(insertionRanges),
            insertionWidthPx:
              args.result.kind === "presented" && args.result.mode === "zoom-affine"
                ? args.result.insertionWidthPx
                : null,
            kind: args.result.plan.kind,
            scaleX: args.result.plan.scaleX,
            sourceOffsetX: args.result.plan.sourceOffsetX,
            targetOffsetX: args.result.plan.targetOffsetX,
            transportedColumnCount: zoomAffineTransport?.columnCopies.length ?? null,
            transportDirtyRanges: summarizeSpectrumCanvasColumnRanges(
              zoomAffineTransport?.dirtyRanges ?? [],
            ),
          }
        : null,
    previousDirtyRanges: summarizeSpectrumCanvasColumnRanges(previousDirtyRanges),
    renderPresentationKind: args.controller.renderPresentation.kind,
    requestTransition: args.requestTransition,
    reusePlanKind: args.result.plan?.kind ?? null,
    revision: args.revision,
  } satisfies Record<string, unknown>;
}

function createWaveformCanvasFrameSignatureTracePayload(
  descriptor: WaveformCanvasFrameDescriptor | null,
) {
  if (!descriptor) {
    return null;
  }

  return {
    dataPixelsPerSecond: descriptor.dataPixelsPerSecond,
    dataSignatureLength: descriptor.dataSignature.length,
    renderSignatureLength: descriptor.renderSignature.length,
    scopeKey: descriptor.scopeKey,
    scrollLeft: descriptor.viewport.scrollLeft,
    viewportWidth: descriptor.geometry.viewportWidth,
    visualSignatureLength: descriptor.visualSignature.length,
  };
}

function createWaveformCanvasCursorTracePayload(args: {
  cursor: WaveformCanvasRenderCursor | null;
  geometry: WaveformCanvasFrameGeometry;
}) {
  const cursor = args.cursor;
  if (!cursor) {
    return null;
  }

  return {
    firstMissingX: cursor.firstMissingX,
    hasDrawnColumn: cursor.hasDrawnColumn,
    drawnRanges: summarizeSpectrumCanvasColumnRanges(cursor.drawnRanges),
    lastMissingX: cursor.lastMissingX,
    missingPeakColumnCount: cursor.missingPeakColumnCount,
    missingRanges: summarizeSpectrumCanvasColumnRanges(cursor.missingRanges),
    nextX: cursor.nextX,
    passIndex: cursor.passIndex,
    rangeComposition: cursor.rangeComposition,
    redrawRanges: summarizeSpectrumCanvasColumnRanges(
      resolveWaveformCanvasDirtyRedrawRanges({
        cursor,
        geometry: args.geometry,
      }) ?? [],
    ),
    schedule: cursor.schedule,
    rangeIndex: cursor.rangeIndex,
    ranges: cursor.ranges ? summarizeSpectrumCanvasColumnRanges(cursor.ranges) : null,
    retargetRanges: summarizeSpectrumCanvasColumnRanges(cursor.retargetRanges),
    resolvedPeakColumnCount: cursor.resolvedPeakColumnCount,
  };
}

function createWaveformCanvasBarTraceSummary(
  plan: WaveformCanvasColumnRangeRenderPlan,
): WaveformCanvasBarTraceSummary {
  const entries = Array.from(plan.columnPaths.entries()).sort((left, right) => left[0] - right[0]);
  const levelCounts = new Map<number, number>();
  let previousBarX: number | null = null;
  let spacingTotal = 0;
  let spacingCount = 0;
  let minSpacingPx: number | null = null;
  let maxSpacingPx: number | null = null;
  let targetDensityResolvedCount = 0;
  let fallbackDensityCount = 0;
  const sampleIndexes = new Set<number>();
  if (entries.length > 0) {
    sampleIndexes.add(0);
    sampleIndexes.add(Math.floor((entries.length - 1) / 2));
    sampleIndexes.add(entries.length - 1);
  }
  const sample: WaveformCanvasBarTraceSample[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const [x, path] = entries[index];
    const peak = plan.peaksByX.get(x) ?? null;
    if (peak) {
      levelCounts.set(
        peak.levelPixelsPerSecond,
        (levelCounts.get(peak.levelPixelsPerSecond) ?? 0) + 1,
      );
      if (peak.targetDensityResolved) {
        targetDensityResolvedCount += 1;
      } else {
        fallbackDensityCount += 1;
      }
    }
    if (previousBarX !== null) {
      const spacing = path.barX - previousBarX;
      spacingTotal += spacing;
      spacingCount += 1;
      minSpacingPx = minSpacingPx === null ? spacing : Math.min(minSpacingPx, spacing);
      maxSpacingPx = maxSpacingPx === null ? spacing : Math.max(maxSpacingPx, spacing);
    }
    previousBarX = path.barX;

    if (sampleIndexes.has(index)) {
      sample.push({
        barX: path.barX,
        height: path.height,
        levelPixelsPerSecond: peak?.levelPixelsPerSecond ?? null,
        targetDensityResolved: peak?.targetDensityResolved ?? null,
        x,
        yBottom: path.yBottom,
        yTop: path.yTop,
      });
    }
  }

  const first = entries[0] ?? null;
  const last = entries.at(-1) ?? null;
  const barXs = entries.map(([, path]) => path.barX);

  return {
    averageSpacingPx: spacingCount > 0 ? spacingTotal / spacingCount : null,
    barCount: entries.length,
    fallbackDensityCount,
    firstBarX: first?.[1].barX ?? null,
    firstX: first?.[0] ?? null,
    lastBarX: last?.[1].barX ?? null,
    lastX: last?.[0] ?? null,
    levelCounts: Array.from(levelCounts.entries())
      .sort((left, right) => left[0] - right[0])
      .map(([pixelsPerSecond, count]) => ({
        count,
        pixelsPerSecond,
      })),
    maxBarX: barXs.length > 0 ? Math.max(...barXs) : null,
    maxSpacingPx,
    minBarX: barXs.length > 0 ? Math.min(...barXs) : null,
    minSpacingPx,
    sample,
    targetDensityResolvedCount,
  };
}

function createWaveformCanvasChunkBehaviorTracePayload(args: {
  completed: boolean;
  cursorBefore: WaveformCanvasRenderCursor;
  cursorAfter: WaveformCanvasRenderCursor;
  deadlineHit: boolean;
  drawPlan: WaveformCanvasColumnRangeRenderPlan;
  endX: number;
  limitReason: WaveformCanvasChunkLimitReason;
  maxChunkEndX: number;
  minChunkEndX: number;
  pass: WaveformCanvasColumnScanPass;
  plan: WaveformCanvasRenderPlan;
  range: WaveformCanvasColumnRange | null;
  rangeEndX: number;
  startX: number;
}) {
  return {
    barSummary: createWaveformCanvasBarTraceSummary(args.drawPlan),
    completed: args.completed,
    cursorAfter: createWaveformCanvasCursorTracePayload({
      cursor: args.cursorAfter,
      geometry: args.plan.geometry,
    }),
    cursorBefore: createWaveformCanvasCursorTracePayload({
      cursor: args.cursorBefore,
      geometry: args.plan.geometry,
    }),
    deadlineHit: args.deadlineHit,
    drawnRanges: summarizeSpectrumCanvasColumnRanges(args.drawPlan.drawnRanges),
    firstMissingX: args.drawPlan.firstMissingX,
    geometry: {
      backingHeight: args.plan.geometry.backingHeight,
      backingWidth: args.plan.geometry.backingWidth,
      devicePixelRatio: args.plan.geometry.devicePixelRatio,
      rasterEndX: resolveWaveformCanvasRasterEndX(args.plan.geometry),
      rasterStartX: args.plan.geometry.rasterStartX,
      rasterWidth: args.plan.geometry.rasterWidth,
      viewportWidth: args.plan.geometry.viewportWidth,
    },
    hasColumn: args.drawPlan.hasColumn,
    lastMissingX: args.drawPlan.lastMissingX,
    limitReason: args.limitReason,
    maxChunkEndX: args.maxChunkEndX,
    minChunkEndX: args.minChunkEndX,
    missingPeakColumns: args.drawPlan.missingPeakColumns,
    missingRanges: summarizeSpectrumCanvasColumnRanges(args.drawPlan.missingRanges),
    pass: {
      startOffsetX: args.pass.startOffsetX,
      stepX: args.pass.stepX,
    },
    range: args.range,
    rangeEndX: args.rangeEndX,
    resolvedPeakCount: args.drawPlan.resolvedPeakCount,
    scannedColumns: args.drawPlan.scannedColumns,
    startX: args.startX,
    endX: args.endX,
    viewport: createWaveformCanvasViewportTracePayload(args.plan.viewport),
  } satisfies Record<string, unknown>;
}

function createWaveformCanvasProofTracePayload(args: {
  completion?: WaveformCanvasRenderJobCompletion | null;
  controller: WaveformCanvasRenderController;
  descriptor: WaveformCanvasFrameDescriptor | null;
  job?: WaveformCanvasRenderJob | null;
  phase: string;
  renderPlan: WaveformCanvasRenderPlan | null;
  requestTransition?: string | null;
  result?: WaveformCanvasFastPresentationResult | null;
  revision: number;
  shouldCompleteWithFastPresentation?: boolean | null;
  shouldContinuePendingCoverage?: boolean | null;
  traceSessionId: string;
}) {
  const controller = args.controller;
  const job = args.job ?? controller.job;
  const result = args.result ?? null;
  const completion = args.completion ?? null;
  const descriptor = args.descriptor;
  const coverage = args.renderPlan
    ? createWaveformCanvasRenderPlanCoverageTracePayload(args.renderPlan)
    : null;

  return {
    completionDirtyRanges:
      completion?.kind === "committed"
        ? summarizeSpectrumCanvasColumnRanges(completion.dirtyRanges)
        : null,
    completionKind: completion?.kind ?? null,
    descriptor: createWaveformCanvasFrameSignatureTracePayload(descriptor),
    descriptorMatchesJobVisual:
      descriptor && job
        ? areWaveformCanvasFrameVisualSignaturesEqual(job.descriptor, descriptor)
        : null,
    descriptorMatchesPresentedRender:
      descriptor && controller.presentedFrame
        ? areWaveformCanvasFrameRenderSignaturesEqual(controller.presentedFrame, descriptor)
        : null,
    descriptorMatchesPresentedVisual:
      descriptor && controller.presentedFrame
        ? areWaveformCanvasFrameVisualSignaturesEqual(controller.presentedFrame, descriptor)
        : null,
    descriptorMatchesRequestedRender:
      descriptor && controller.requestedFrame
        ? areWaveformCanvasFrameRenderSignaturesEqual(controller.requestedFrame, descriptor)
        : null,
    descriptorMatchesRequestedVisual:
      descriptor && controller.requestedFrame
        ? areWaveformCanvasFrameVisualSignaturesEqual(controller.requestedFrame, descriptor)
        : null,
    descriptorMatchesReusableRender:
      descriptor && controller.reusableFrame
        ? areWaveformCanvasFrameRenderSignaturesEqual(controller.reusableFrame, descriptor)
        : null,
    descriptorMatchesReusableVisual:
      descriptor && controller.reusableFrame
        ? areWaveformCanvasFrameVisualSignaturesEqual(controller.reusableFrame, descriptor)
        : null,
    frameIdScheduled: controller.frameId !== null,
    job: job
      ? {
          cursor: createWaveformCanvasCursorTracePayload({
            cursor: job.cursor,
            geometry: job.plan.geometry,
          }),
          descriptor: createWaveformCanvasFrameSignatureTracePayload(job.descriptor),
          id: job.id,
          presentationKind: job.presentation.kind,
          retargeted: job.retargeted,
          revision: job.revision,
        }
      : null,
    phase: args.phase,
    plan: args.renderPlan ? createWaveformCanvasRenderPlanTracePayload(args.renderPlan) : null,
    planCoverage: coverage,
    presentedDirtyRanges: summarizeSpectrumCanvasColumnRanges(controller.presentedDirtyRanges),
    presentedFrame: createWaveformCanvasFrameSignatureTracePayload(controller.presentedFrame),
    presentationScale:
      job && args.renderPlan
        ? {
            framePixelsPerSecond: job.descriptor.viewport.pixelsPerSecond,
            jobPixelsPerSecond: job.plan.viewport.pixelsPerSecond,
            requestedPixelsPerSecond: args.renderPlan.viewport.pixelsPerSecond,
          }
        : null,
    renderSchedule: controller.renderSchedule,
    renderPresentation:
      controller.renderPresentation.kind === "dirty"
        ? {
            dirtyRanges: summarizeSpectrumCanvasColumnRanges(
              controller.renderPresentation.dirtyRanges,
            ),
            kind: "dirty",
          }
        : controller.renderPresentation.kind === "insertion"
          ? {
              insertionRanges: summarizeSpectrumCanvasColumnRanges(
                controller.renderPresentation.insertionRanges,
              ),
              kind: "insertion",
            }
          : {
              kind: "fresh",
            },
    requestTransition: args.requestTransition ?? null,
    requestedFrame: createWaveformCanvasFrameSignatureTracePayload(controller.requestedFrame),
    requestedRevision: controller.requestedRevision,
    result:
      result?.kind === "presented"
        ? {
            dirtyRanges: summarizeSpectrumCanvasColumnRanges(result.dirtyRanges),
            draws: summarizeSpectrumCanvasColumnTraceResults(result.draws),
            exposedRanges: summarizeSpectrumCanvasColumnRanges(result.exposedRanges),
            kind: "presented",
            mode: result.mode,
            plan:
              result.mode === "zoom-affine"
                ? {
                    anchorViewportX: result.plan.anchorViewportX,
                    anchorVisualSeconds: result.plan.anchorVisualSeconds,
                    dirtyRanges: summarizeSpectrumCanvasColumnRanges(result.plan.dirtyRanges),
                    exposedRanges: summarizeSpectrumCanvasColumnRanges(result.plan.exposedRanges),
                    insertionRanges: summarizeSpectrumCanvasColumnRanges(result.insertionRanges),
                    insertionWidthPx: result.insertionWidthPx,
                    kind: result.plan.kind,
                    scaleX: result.plan.scaleX,
                    sourceOffsetX: result.plan.sourceOffsetX,
                    targetOffsetX: result.plan.targetOffsetX,
                  }
                : null,
            planKind: result.plan.kind,
          }
        : result
          ? {
              kind: "empty",
              planKind: result.plan?.kind ?? null,
              reason: result.reason,
            }
          : null,
    reusableFrame: createWaveformCanvasFrameSignatureTracePayload(controller.reusableFrame),
    reuseFramePresent: controller.reuseFrame !== null,
    revision: args.revision,
    shouldCompleteWithFastPresentation: args.shouldCompleteWithFastPresentation ?? null,
    shouldContinuePendingCoverage: args.shouldContinuePendingCoverage ?? null,
    traceSessionId: args.traceSessionId,
  } satisfies Record<string, unknown>;
}

function resolveWaveformCanvasPixelColumnRange(args: {
  data: Uint8ClampedArray;
  devicePixelRatio: number;
  height: number;
  originX: number;
  width: number;
  x: number;
}): { bottomY: number; topY: number } | null {
  const scale = Math.max(1, args.devicePixelRatio);
  const localX = args.x - args.originX;
  const startPixelX = clampInteger(Math.floor(localX * scale), 0, args.width);
  const endPixelX = clampInteger(
    Math.ceil((localX + resolveWaveformBarWidthPx()) * scale),
    startPixelX,
    args.width,
  );
  let topY: number | null = null;
  let bottomY: number | null = null;

  for (let pixelX = startPixelX; pixelX < endPixelX; pixelX += 1) {
    for (let pixelY = 0; pixelY < args.height; pixelY += 1) {
      const alphaIndex = (pixelY * args.width + pixelX) * 4 + 3;
      if (args.data[alphaIndex] === 0) {
        continue;
      }

      topY = topY === null ? pixelY : Math.min(topY, pixelY);
      bottomY = bottomY === null ? pixelY : Math.max(bottomY, pixelY);
    }
  }

  if (topY === null || bottomY === null) {
    return null;
  }

  return {
    bottomY: (bottomY + 1) / scale,
    topY: topY / scale,
  };
}

function resolveWaveformCanvasPixelColumnShape(args: {
  data: Uint8ClampedArray;
  devicePixelRatio: number;
  height: number;
  originX: number;
  width: number;
  x: number;
}) {
  const scale = Math.max(1, args.devicePixelRatio);
  const localX = args.x - args.originX;
  const centerPixelX = clampInteger(Math.floor((localX + 0.5) * scale), 0, args.width - 1);
  const probeStartPixelX = clampInteger(Math.floor((localX - 0.5) * scale), 0, args.width);
  const probeEndPixelX = clampInteger(
    Math.ceil((localX + 1.5) * scale),
    probeStartPixelX,
    args.width,
  );
  let opaquePixelCount = 0;
  let centerOpaquePixelCount = 0;
  let firstOpaquePixelX: number | null = null;
  let lastOpaquePixelX: number | null = null;

  for (let pixelX = probeStartPixelX; pixelX < probeEndPixelX; pixelX += 1) {
    let columnOpaquePixelCount = 0;
    for (let pixelY = 0; pixelY < args.height; pixelY += 1) {
      const alphaIndex = (pixelY * args.width + pixelX) * 4 + 3;
      if (args.data[alphaIndex] === 0) {
        continue;
      }

      columnOpaquePixelCount += 1;
    }

    if (columnOpaquePixelCount <= 0) {
      continue;
    }

    opaquePixelCount += columnOpaquePixelCount;
    firstOpaquePixelX ??= pixelX;
    lastOpaquePixelX = pixelX;
    if (pixelX === centerPixelX) {
      centerOpaquePixelCount = columnOpaquePixelCount;
    }
  }

  return {
    centerOpaquePixelCount,
    centerPixelX,
    opaqueCssWidth:
      firstOpaquePixelX === null || lastOpaquePixelX === null
        ? 0
        : (lastOpaquePixelX - firstOpaquePixelX + 1) / scale,
    opaquePixelCount,
  };
}

function resolveWaveformCanvasExpectedColumnRange(args: {
  plan: WaveformCanvasRenderPlan;
  x: number;
}): {
  bottomY: number;
  levelPixelsPerSecond: number;
  targetDensityResolved: boolean;
  topY: number;
} | null {
  const peak = resolveWaveformCanvasColumnPeak({
    candidateLevels: args.plan.candidateLevels,
    dataPixelsPerSecond: args.plan.dataPixelsPerSecond,
    tileWidth: WAVEFORM_DATA_TILE_WIDTH,
    viewport: args.plan.viewport,
    x: args.x,
  });

  if (!peak) {
    return null;
  }

  const topY = args.plan.centerY - peak.peak.max * args.plan.amplitude;
  const bottomY = Math.max(topY + 1, args.plan.centerY - peak.peak.min * args.plan.amplitude);

  return {
    bottomY,
    levelPixelsPerSecond: peak.levelPixelsPerSecond,
    targetDensityResolved: peak.targetDensityResolved,
    topY,
  };
}

function classifyWaveformCanvasPixelColumn(args: {
  actual: { bottomY: number; topY: number } | null;
  expected: {
    bottomY: number;
    levelPixelsPerSecond: number;
    targetDensityResolved: boolean;
    topY: number;
  } | null;
}): WaveformCanvasPixelColumnStatus {
  if (!args.expected) {
    return args.actual ? "drawn-without-plan-data" : "blank-without-plan-data";
  }

  if (!args.actual) {
    return args.expected.targetDensityResolved ? "target-density-blank" : "blank-without-plan-data";
  }

  if (!args.expected.targetDensityResolved) {
    return "drawn-fallback-density";
  }

  const tolerancePx = 1.25;
  return args.actual.topY <= args.expected.topY + tolerancePx &&
    args.actual.bottomY >= args.expected.bottomY - tolerancePx
    ? "drawn-target-covered"
    : "drawn-target-undercovered";
}

function createEmptyWaveformCanvasPixelColumnProbeCounts(): WaveformCanvasPixelColumnProbeCounts {
  return {
    "blank-without-plan-data": 0,
    "drawn-fallback-density": 0,
    "drawn-target-covered": 0,
    "drawn-target-undercovered": 0,
    "drawn-without-plan-data": 0,
    "target-density-blank": 0,
  };
}

function createWaveformCanvasPixelColumnProbeWindow(args: {
  endX: number;
  rasterEndX: number;
  rasterStartX: number;
  source: WaveformCanvasPixelColumnProbeWindowSource;
  startX: number;
  statusesByX: Map<number, WaveformCanvasPixelColumnStatus>;
}): WaveformCanvasPixelColumnProbeWindow {
  const startX = clampInteger(Math.floor(args.startX), args.rasterStartX, args.rasterEndX);
  const endX = clampInteger(Math.ceil(args.endX), startX, args.rasterEndX);
  const counts = createEmptyWaveformCanvasPixelColumnProbeCounts();
  let firstNonTargetX: number | null = null;
  let lastNonTargetX: number | null = null;

  for (let x = startX; x < endX; x += 1) {
    const status = args.statusesByX.get(x);
    if (!status) {
      continue;
    }

    counts[status] += 1;
    if (status !== "drawn-target-covered") {
      firstNonTargetX ??= x;
      lastNonTargetX = x;
    }
  }

  return {
    counts,
    endX,
    firstNonTargetX,
    lastNonTargetX,
    sampleCount: endX - startX,
    source: args.source,
    startX,
  };
}

function resolveWaveformCanvasDomVisibleColumnWindow(args: {
  canvas: HTMLCanvasElement;
  geometry: WaveformCanvasFrameGeometry;
}) {
  if (typeof args.canvas.getBoundingClientRect !== "function") {
    return null;
  }

  const canvasRect = args.canvas.getBoundingClientRect();
  const parentRect =
    args.canvas.parentElement &&
    typeof args.canvas.parentElement.getBoundingClientRect === "function"
      ? args.canvas.parentElement.getBoundingClientRect()
      : null;
  const visibleRect = parentRect
    ? {
        bottom: Math.min(canvasRect.bottom, parentRect.bottom),
        left: Math.max(canvasRect.left, parentRect.left),
        right: Math.min(canvasRect.right, parentRect.right),
        top: Math.max(canvasRect.top, parentRect.top),
      }
    : canvasRect;
  const rectWidth = Math.max(0, canvasRect.width);
  const visibleWidth = Math.max(0, visibleRect.right - visibleRect.left);

  if (rectWidth <= 0 || visibleWidth <= 0) {
    return {
      canvasRect: {
        height: canvasRect.height,
        left: canvasRect.left,
        top: canvasRect.top,
        width: canvasRect.width,
      },
      parentRect: parentRect
        ? {
            height: parentRect.height,
            left: parentRect.left,
            top: parentRect.top,
            width: parentRect.width,
          }
        : null,
      window: null,
    };
  }

  const cssToCanvasColumn = args.geometry.rasterWidth / rectWidth;
  const startX =
    args.geometry.rasterStartX +
    Math.max(0, visibleRect.left - canvasRect.left) * cssToCanvasColumn;
  const endX =
    args.geometry.rasterStartX +
    Math.min(rectWidth, visibleRect.right - canvasRect.left) * cssToCanvasColumn;

  return {
    canvasRect: {
      height: canvasRect.height,
      left: canvasRect.left,
      top: canvasRect.top,
      width: canvasRect.width,
    },
    parentRect: parentRect
      ? {
          height: parentRect.height,
          left: parentRect.left,
          top: parentRect.top,
          width: parentRect.width,
        }
      : null,
    window: {
      endX,
      startX,
    },
  };
}

function createWaveformCanvasPixelColumnShapeSamples(args: {
  endX: number;
  shapesByX: Map<
    number,
    {
      centerOpaquePixelCount: number;
      centerPixelX: number;
      opaqueCssWidth: number;
      opaquePixelCount: number;
    }
  >;
  startX: number;
}) {
  const startX = Math.ceil(args.startX);
  const endX = Math.floor(args.endX);
  const sampleCount = 64;
  const width = Math.max(0, endX - startX);
  if (width <= 0) {
    return [];
  }

  return Array.from({ length: Math.min(sampleCount, width) }, (_, index) => {
    const x = startX + Math.floor((index * width) / Math.min(sampleCount, width));
    const shape = args.shapesByX.get(x);
    return {
      centerOpaquePixelCount: shape?.centerOpaquePixelCount ?? 0,
      opaqueCssWidth: shape?.opaqueCssWidth ?? 0,
      opaquePixelCount: shape?.opaquePixelCount ?? 0,
      x,
    };
  });
}

function createWaveformCanvasPixelColumnVisibleShapeColumns(args: {
  endX: number;
  shapesByX: Map<
    number,
    {
      centerOpaquePixelCount: number;
      centerPixelX: number;
      opaqueCssWidth: number;
      opaquePixelCount: number;
    }
  >;
  startX: number;
  statusesByX: Map<number, WaveformCanvasPixelColumnStatus>;
}) {
  const startX = Math.ceil(args.startX);
  const endX = Math.floor(args.endX);
  const columns: Array<{
    centerOpaquePixelCount: number;
    opaqueCssWidth: number;
    opaquePixelCount: number;
    status: WaveformCanvasPixelColumnStatus | null;
    x: number;
  }> = [];

  for (let x = startX; x < endX; x += 1) {
    const shape = args.shapesByX.get(x);
    columns.push({
      centerOpaquePixelCount: shape?.centerOpaquePixelCount ?? 0,
      opaqueCssWidth: shape?.opaqueCssWidth ?? 0,
      opaquePixelCount: shape?.opaquePixelCount ?? 0,
      status: args.statusesByX.get(x) ?? null,
      x,
    });
  }

  return columns;
}

function createWaveformCanvasPixelColumnReadback(
  canvas: HTMLCanvasElement,
): WaveformCanvasPixelColumnReadback | null {
  const ownerDocument = canvas.ownerDocument ?? (typeof document === "undefined" ? null : document);
  const readbackCanvas = ownerDocument?.createElement("canvas") ?? null;
  const width = canvas.width;
  const height = canvas.height;

  if (!readbackCanvas || width <= 0 || height <= 0) {
    return null;
  }

  readbackCanvas.width = width;
  readbackCanvas.height = height;
  const context = readbackCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  if (!context) {
    return null;
  }

  context.drawImage(canvas, 0, 0);

  return {
    context,
    height,
    width,
  };
}

function createWaveformCanvasPixelColumnProbe(args: {
  canvas: HTMLCanvasElement;
  plan: WaveformCanvasRenderPlan;
}) {
  const readback = createWaveformCanvasPixelColumnReadback(args.canvas);
  if (!readback) {
    return null;
  }

  const geometry = args.plan.geometry;
  const scale = Math.max(1, geometry.devicePixelRatio);
  const startX = geometry.rasterStartX;
  const endX = resolveWaveformCanvasRasterEndX(geometry);
  const readX = clampInteger(
    Math.floor((startX - geometry.rasterStartX) * scale),
    0,
    readback.width,
  );
  const readWidth = clampInteger(Math.ceil((endX - startX) * scale), 0, readback.width - readX);
  const readHeight = Math.min(readback.height, geometry.backingHeight);

  if (readWidth <= 0 || readHeight <= 0) {
    return null;
  }

  const imageData = readback.context.getImageData(readX, 0, readWidth, readHeight);
  const counts = createEmptyWaveformCanvasPixelColumnProbeCounts();
  const mismatchSamples: Array<{
    actualBottomY: number | null;
    actualTopY: number | null;
    expectedBottomY: number | null;
    expectedLevelPixelsPerSecond: number | null;
    expectedTargetDensityResolved: boolean | null;
    expectedTopY: number | null;
    status: WaveformCanvasPixelColumnStatus;
    x: number;
  }> = [];
  let firstNonTargetX: number | null = null;
  let lastNonTargetX: number | null = null;
  const statusesByX = new Map<number, WaveformCanvasPixelColumnStatus>();
  const shapesByX = new Map<
    number,
    {
      centerOpaquePixelCount: number;
      centerPixelX: number;
      opaqueCssWidth: number;
      opaquePixelCount: number;
    }
  >();

  for (let x = startX; x < endX; x += 1) {
    const actual = resolveWaveformCanvasPixelColumnRange({
      data: imageData.data,
      devicePixelRatio: scale,
      height: readHeight,
      originX: startX,
      width: readWidth,
      x,
    });
    const shape = resolveWaveformCanvasPixelColumnShape({
      data: imageData.data,
      devicePixelRatio: scale,
      height: readHeight,
      originX: startX,
      width: readWidth,
      x,
    });
    const expected = resolveWaveformCanvasExpectedColumnRange({
      plan: args.plan,
      x,
    });
    const status = classifyWaveformCanvasPixelColumn({
      actual,
      expected,
    });

    statusesByX.set(x, status);
    shapesByX.set(x, shape);
    counts[status] += 1;
    if (status !== "drawn-target-covered") {
      firstNonTargetX ??= x;
      lastNonTargetX = x;
      if (mismatchSamples.length < 16) {
        mismatchSamples.push({
          actualBottomY: actual?.bottomY ?? null,
          actualTopY: actual?.topY ?? null,
          expectedBottomY: expected?.bottomY ?? null,
          expectedLevelPixelsPerSecond: expected?.levelPixelsPerSecond ?? null,
          expectedTargetDensityResolved: expected?.targetDensityResolved ?? null,
          expectedTopY: expected?.topY ?? null,
          status,
          x,
        });
      }
    }
  }
  const domVisible = resolveWaveformCanvasDomVisibleColumnWindow({
    canvas: args.canvas,
    geometry,
  });
  const rasterWindow = createWaveformCanvasPixelColumnProbeWindow({
    endX,
    rasterEndX: endX,
    rasterStartX: startX,
    source: "raster",
    startX,
    statusesByX,
  });
  const configuredViewportWindow = createWaveformCanvasPixelColumnProbeWindow({
    endX: geometry.viewportWidth,
    rasterEndX: endX,
    rasterStartX: startX,
    source: "configured-viewport",
    startX: 0,
    statusesByX,
  });
  const domVisibleWindow = domVisible?.window
    ? createWaveformCanvasPixelColumnProbeWindow({
        endX: domVisible.window.endX,
        rasterEndX: endX,
        rasterStartX: startX,
        source: "dom-visible",
        startX: domVisible.window.startX,
        statusesByX,
      })
    : null;
  const shapeSamples =
    domVisibleWindow === null
      ? []
      : createWaveformCanvasPixelColumnShapeSamples({
          endX: domVisibleWindow.endX,
          shapesByX,
          startX: domVisibleWindow.startX,
        });
  const visibleColumns =
    domVisibleWindow === null
      ? []
      : createWaveformCanvasPixelColumnVisibleShapeColumns({
          endX: domVisibleWindow.endX,
          shapesByX,
          startX: domVisibleWindow.startX,
          statusesByX,
        });

  return {
    canvasBox: {
      boundingHeight: domVisible?.canvasRect.height ?? null,
      boundingLeft: domVisible?.canvasRect.left ?? null,
      boundingTop: domVisible?.canvasRect.top ?? null,
      boundingWidth: domVisible?.canvasRect.width ?? null,
      height: args.canvas.height,
      width: args.canvas.width,
    },
    counts,
    firstNonTargetX,
    geometry: {
      backingHeight: geometry.backingHeight,
      backingWidth: geometry.backingWidth,
      devicePixelRatio: geometry.devicePixelRatio,
      rasterEndX: endX,
      rasterStartX: startX,
      rasterWidth: geometry.rasterWidth,
      viewportWidth: geometry.viewportWidth,
    },
    lastNonTargetX,
    parentBox: domVisible?.parentRect ?? null,
    readHeight,
    readWidth,
    readX,
    rasterEndX: endX,
    rasterStartX: startX,
    sampleCount: endX - startX,
    samples: mismatchSamples,
    shapeSamples,
    visibleColumns,
    windows: {
      configuredViewport: configuredViewportWindow,
      domVisible: domVisibleWindow,
      raster: rasterWindow,
    },
  } satisfies Record<string, unknown>;
}

function recordWaveformCanvasPixelColumnProbeTrace(args: {
  canvas: HTMLCanvasElement;
  phase: string;
  plan: WaveformCanvasRenderPlan;
  revision: number;
  traceSessionId: string;
}) {
  if (!isRenderPerformanceTraceInstalled()) {
    return;
  }

  const probe = createWaveformCanvasPixelColumnProbe({
    canvas: args.canvas,
    plan: args.plan,
  });
  if (!probe) {
    return;
  }

  recordRenderPerformanceTrace("waveform-canvas-pixel-column-probe", {
    phase: args.phase,
    plan: createWaveformCanvasRenderPlanTracePayload(args.plan),
    probe,
    revision: args.revision,
    traceSessionId: args.traceSessionId,
  });
}

function recordWaveformCanvasProofTrace(
  args: Parameters<typeof createWaveformCanvasProofTracePayload>[0],
) {
  if (!isRenderPerformanceTraceInstalled()) {
    return;
  }

  recordRenderPerformanceTrace(
    "waveform-canvas-proof-state",
    createWaveformCanvasProofTracePayload(args),
  );
}

function recordNullableRenderPerformanceTrace(
  event: string,
  payload: Record<string, unknown> | null,
) {
  if (payload === null) {
    return;
  }

  recordRenderPerformanceTrace(event, payload);
}

function recordWaveformCanvasRenderJobTrace(args: {
  accepted: boolean;
  completion: WaveformCanvasRenderJobCompletion | null;
  endedAt: number;
  job: WaveformCanvasRenderJob;
  reason: SpectrumCanvasRenderJobTraceReason;
  requestedRevision: number;
}) {
  if (!isRenderPerformanceTraceInstalled()) {
    return;
  }

  recordRenderPerformanceTrace(
    "waveform-canvas-job",
    createSpectrumCanvasRenderJobTracePayload({
      accepted: args.accepted,
      completionKind: args.completion?.kind ?? null,
      dirtyRanges: args.completion?.kind === "committed" ? args.completion.dirtyRanges : undefined,
      endedAt: args.endedAt,
      jobId: args.job.id,
      metrics: args.job.metrics,
      missingRanges: args.job.cursor.missingRanges,
      plan: {
        ...createWaveformCanvasRenderPlanTracePayload(args.job.plan),
        coverage: args.job.coverageTrace,
      },
      reason: args.reason,
      requestedRevision: args.requestedRevision,
      revision: args.job.revision,
    }),
  );
}

function createWaveformCanvasRenderCursor(args: {
  geometry: WaveformCanvasFrameGeometry;
  presentation: WaveformCanvasRenderPresentation;
  schedule: WaveformCanvasCursorSchedule;
}): WaveformCanvasRenderCursor {
  const ranges =
    args.presentation.kind === "fresh"
      ? null
      : args.presentation.kind === "dirty"
        ? args.presentation.dirtyRanges.map((range) => ({
            endX: range.endX,
            startX: range.startX,
          }))
        : args.presentation.insertionRanges.map((range) => ({
            endX: range.endX,
            startX: range.startX,
          }));
  const firstRange = ranges?.[0] ?? null;

  return {
    drawnRanges: [],
    firstMissingX: null,
    hasDrawnColumn: false,
    lastMissingX: null,
    missingRanges: [],
    missingPeakColumnCount: 0,
    nextX: firstRange?.startX ?? args.geometry.rasterStartX,
    passIndex: 0,
    rangeComposition:
      args.presentation.kind === "insertion" ? "direct" : ranges ? "coalesced" : "none",
    ranges,
    rangeIndex: 0,
    retargetRanges: [],
    resolvedPeakColumnCount: 0,
    schedule: ranges ? "full-density" : args.schedule,
  };
}

export function drawWaveformCanvasColumnRange(args: {
  plan: WaveformCanvasRenderPlan;
  range: WaveformCanvasColumnRange;
  replaceExistingColumns?: boolean;
  target: WaveformCanvasRasterTarget;
}): WaveformCanvasRangeDrawResult {
  const range = normalizeWaveformCanvasColumnRange({
    geometry: args.plan.geometry,
    range: args.range,
  });
  return runWaveformCanvasColumnRangeEffect({
    plan: args.plan,
    range,
    replaceExistingColumns: args.replaceExistingColumns,
    target: args.target,
  });
}

function resolveFirstWaveformCanvasPassColumnX(args: {
  geometry: WaveformCanvasFrameGeometry;
  pass: WaveformCanvasColumnScanPass;
  startX: number;
}) {
  const baseX = args.geometry.rasterStartX + args.pass.startOffsetX;
  const stepX = Math.max(1, args.pass.stepX);
  return baseX + Math.max(0, Math.ceil((args.startX - baseX) / stepX)) * stepX;
}

function createWaveformCanvasColumnRangeDrawPlan(args: {
  pass?: WaveformCanvasColumnScanPass;
  plan: WaveformCanvasRenderPlan;
  range: WaveformCanvasColumnRange | null;
}): WaveformCanvasColumnRangeDrawPlan {
  const missingRanges: WaveformCanvasColumnRange[] = [];
  let activeMissingStartX: number | null = null;
  let activeMissingEndX: number | null = null;
  let firstMissingX: number | null = null;
  let lastMissingX: number | null = null;
  let missingPeakColumns = 0;
  let resolvedPeakCount = 0;
  let scannedColumns = 0;
  const peaksByX = new Map<number, WaveformCanvasColumnSample>();
  const drawnRanges: WaveformCanvasColumnRange[] = [];
  let activeDrawnStartX: number | null = null;
  let activeDrawnEndX: number | null = null;

  if (!args.range) {
    return {
      drawnRanges,
      firstMissingX,
      hasColumn: false,
      lastMissingX,
      missingPeakColumns,
      missingRanges,
      peaksByX,
      resolvedPeakCount,
      scannedColumns,
    };
  }

  const startX = args.pass
    ? resolveFirstWaveformCanvasPassColumnX({
        geometry: args.plan.geometry,
        pass: args.pass,
        startX: args.range.startX,
      })
    : args.range.startX;
  const stepX = args.pass?.stepX ?? 1;

  for (let x = startX; x < args.range.endX; x += stepX) {
    scannedColumns += 1;
    const peak = resolveWaveformCanvasColumnPeak({
      candidateLevels: args.plan.candidateLevels,
      dataPixelsPerSecond: args.plan.dataPixelsPerSecond,
      tileWidth: WAVEFORM_DATA_TILE_WIDTH,
      viewport: args.plan.viewport,
      x,
    });

    if (peak) {
      peaksByX.set(x, peak);
      resolvedPeakCount += 1;
      if (activeDrawnEndX === x) {
        activeDrawnEndX = x + 1;
      } else {
        if (activeDrawnStartX !== null && activeDrawnEndX !== null) {
          drawnRanges.push({
            endX: activeDrawnEndX,
            startX: activeDrawnStartX,
          });
        }
        activeDrawnStartX = x;
        activeDrawnEndX = x + 1;
      }
    }

    if (peak?.targetDensityResolved) {
      if (activeMissingStartX !== null) {
        missingRanges.push({
          endX: x,
          startX: activeMissingStartX,
        });
        activeMissingStartX = null;
        activeMissingEndX = null;
      }
      continue;
    }

    firstMissingX ??= x;
    lastMissingX = x;
    if (activeMissingEndX === x) {
      activeMissingEndX = x + 1;
    } else {
      if (activeMissingStartX !== null && activeMissingEndX !== null) {
        missingRanges.push({
          endX: activeMissingEndX,
          startX: activeMissingStartX,
        });
      }
      activeMissingStartX = x;
      activeMissingEndX = x + 1;
    }
    missingPeakColumns += 1;
  }

  if (activeMissingStartX !== null && activeMissingEndX !== null) {
    missingRanges.push({
      endX: activeMissingEndX,
      startX: activeMissingStartX,
    });
  }
  if (activeDrawnStartX !== null && activeDrawnEndX !== null) {
    drawnRanges.push({
      endX: activeDrawnEndX,
      startX: activeDrawnStartX,
    });
  }

  return {
    drawnRanges: normalizeWaveformCanvasColumnRanges({
      geometry: args.plan.geometry,
      ranges: drawnRanges,
    }),
    firstMissingX,
    hasColumn: peaksByX.size > 0,
    lastMissingX,
    missingPeakColumns,
    missingRanges: normalizeWaveformCanvasColumnRanges({
      geometry: args.plan.geometry,
      ranges: missingRanges,
    }),
    peaksByX,
    resolvedPeakCount,
    scannedColumns,
  };
}

function createWaveformCanvasColumnRangeRenderPlan(args: {
  pass?: WaveformCanvasColumnScanPass;
  plan: WaveformCanvasRenderPlan;
  range: WaveformCanvasColumnRange | null;
}): WaveformCanvasColumnRangeRenderPlan {
  const drawPlan = createWaveformCanvasColumnRangeDrawPlan({
    pass: args.pass,
    plan: args.plan,
    range: args.range,
  });
  const columnPaths = new Map<number, WaveformCanvasColumnPath>();

  for (const [x, peak] of drawPlan.peaksByX) {
    columnPaths.set(
      x,
      resolveWaveformCanvasColumnPath({
        peak,
        plan: args.plan,
        x,
      }),
    );
  }

  return {
    ...drawPlan,
    columnPaths,
  };
}

function runWaveformCanvasColumnRangeEffect(args: {
  plan: WaveformCanvasRenderPlan;
  range: WaveformCanvasColumnRange | null;
  replaceExistingColumns?: boolean;
  target: WaveformCanvasRasterTarget;
}): WaveformCanvasRangeDrawResult {
  const context = args.target.context;
  const drawPlan = createWaveformCanvasColumnRangeRenderPlan({
    plan: args.plan,
    range: args.range,
  });

  if (!args.range || !drawPlan.hasColumn) {
    return {
      drawnRanges: drawPlan.drawnRanges,
      firstMissingX: drawPlan.firstMissingX,
      hasColumn: drawPlan.hasColumn,
      lastMissingX: drawPlan.lastMissingX,
      missingPeakColumns: drawPlan.missingPeakColumns,
      missingRanges: drawPlan.missingRanges,
      resolvedPeakCount: drawPlan.resolvedPeakCount,
      scannedColumns: drawPlan.scannedColumns,
    };
  }

  if (args.replaceExistingColumns && drawPlan.drawnRanges.length > 0) {
    clearWaveformCanvasColumnRanges({
      context,
      geometry: args.plan.geometry,
      ranges: drawPlan.drawnRanges,
    });
  }

  for (const pass of WAVEFORM_CANVAS_PROGRESSIVE_PASSES) {
    for (
      let x = resolveFirstWaveformCanvasPassColumnX({
        geometry: args.plan.geometry,
        pass,
        startX: args.range.startX,
      });
      x < args.range.endX;
      x += pass.stepX
    ) {
      const columnPath = drawPlan.columnPaths.get(x);
      if (!columnPath) {
        continue;
      }

      drawWaveformCanvasColumn({
        columnPath,
        context,
      });
    }
  }

  return {
    drawnRanges: drawPlan.drawnRanges,
    firstMissingX: drawPlan.firstMissingX,
    hasColumn: drawPlan.hasColumn,
    lastMissingX: drawPlan.lastMissingX,
    missingPeakColumns: drawPlan.missingPeakColumns,
    missingRanges: drawPlan.missingRanges,
    resolvedPeakCount: drawPlan.resolvedPeakCount,
    scannedColumns: drawPlan.scannedColumns,
  };
}

function createWaveformCanvasFrameDescriptor(args: {
  color: string;
  plan: WaveformCanvasRenderPlan;
}): WaveformCanvasFrameDescriptor {
  const dataSignature = createWaveformCanvasRenderPlanDataSignature(args.plan);
  const visualSignature = createWaveformCanvasFrameVisualSignature({
    color: args.color,
    plan: args.plan,
  });

  return {
    color: args.color,
    dataPixelsPerSecond: args.plan.dataPixelsPerSecond,
    dataSignature,
    geometry: args.plan.geometry,
    renderSignature: createWaveformCanvasFrameRenderSignature({
      color: args.color,
      dataSignature,
      plan: args.plan,
    }),
    scopeKey: args.plan.scopeKey,
    viewport: args.plan.viewport,
    visualSignature,
  };
}

function createWaveformCanvasFrameVisualSignature(args: {
  color: string;
  plan: WaveformCanvasRenderPlan;
}) {
  const viewport = args.plan.viewport;
  const geometry = args.plan.geometry;

  return [
    args.plan.scopeKey,
    args.color,
    args.plan.dataPixelsPerSecond,
    geometry.backingHeight,
    geometry.backingWidth,
    geometry.devicePixelRatio,
    geometry.rasterStartX,
    geometry.rasterWidth,
    geometry.viewportWidth,
    viewport.contentWidth,
    viewport.durationMs,
    viewport.focusSeconds ?? "",
    viewport.maximumPixelsPerSecond,
    viewport.pixelsPerSecond,
    viewport.scrollLeft.toFixed(3),
    viewport.viewportWidth,
    args.plan.visibleSecondsWindow.startSeconds.toFixed(6),
    args.plan.visibleSecondsWindow.endSeconds.toFixed(6),
    args.plan.visibleSecondsWindow.hasAudio ? "1" : "0",
    args.plan.visibleWindow.startPx,
    args.plan.visibleWindow.endPx,
  ].join("|");
}

function createWaveformCanvasFrameRenderSignature(args: {
  color: string;
  dataSignature: string;
  plan: WaveformCanvasRenderPlan;
}) {
  return [args.dataSignature, createWaveformCanvasFrameVisualSignature(args)].join("|");
}

function areWaveformCanvasFrameVisualSignaturesEqual(
  left: WaveformCanvasFrameDescriptor,
  right: WaveformCanvasFrameDescriptor,
) {
  return left.visualSignature === right.visualSignature;
}

function areWaveformCanvasFrameRenderSignaturesEqual(
  left: WaveformCanvasFrameDescriptor,
  right: WaveformCanvasFrameDescriptor,
) {
  return left.renderSignature === right.renderSignature;
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

  args.canvas.style.left = `${args.geometry.rasterStartX}px`;
  args.canvas.style.width = `${args.geometry.rasterWidth}px`;
  args.canvas.style.height = `${WAVEFORM_CANVAS_HEIGHT}px`;
}

function normalizeWaveformCanvasColumnRange(args: {
  range: WaveformCanvasColumnRange;
  geometry: WaveformCanvasFrameGeometry;
}): WaveformCanvasColumnRange | null {
  const rasterEndX = resolveWaveformCanvasRasterEndX(args.geometry);
  const startX = clampInteger(args.range.startX, args.geometry.rasterStartX, rasterEndX);
  const endX = clampInteger(args.range.endX, startX, rasterEndX);

  return endX > startX
    ? {
        endX,
        startX,
      }
    : null;
}

function normalizeWaveformCanvasColumnRanges(args: {
  geometry: WaveformCanvasFrameGeometry;
  ranges: readonly WaveformCanvasColumnRange[];
}) {
  const normalized = args.ranges
    .map((range) =>
      normalizeWaveformCanvasColumnRange({
        geometry: args.geometry,
        range,
      }),
    )
    .filter((range): range is WaveformCanvasColumnRange => range !== null)
    .sort((left, right) => left.startX - right.startX || left.endX - right.endX);
  const merged: WaveformCanvasColumnRange[] = [];

  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.startX <= previous.endX) {
      previous.endX = Math.max(previous.endX, range.endX);
    } else {
      merged.push({
        endX: range.endX,
        startX: range.startX,
      });
    }
  }

  return merged;
}

export function clearWaveformCanvasColumnRanges(args: {
  context: CanvasRenderingContext2D;
  geometry: WaveformCanvasFrameGeometry;
  ranges: readonly WaveformCanvasColumnRange[];
}) {
  for (const range of normalizeWaveformCanvasColumnRanges({
    geometry: args.geometry,
    ranges: args.ranges,
  })) {
    args.context.clearRect(range.startX, 0, range.endX - range.startX, WAVEFORM_CANVAS_HEIGHT);
  }
}

export const __spectrumVisualizerTestHooks = {
  createWaveformCanvasColumnRangeRenderPlan,
  createWaveformCanvasBarTraceSummary,
  createWaveformCanvasChunkBehaviorTracePayload,
  createWaveformCanvasRenderLifecycleTracePayload,
  createWaveformCanvasRasterTarget,
  createWaveformCanvasPixelColumnProbe,
  resolveWaveformBarPresentationModel,
  resolveWaveformBarPresentationTransform,
  createWaveformCanvasBarPresentationTracePayload,
  presentWaveformCanvasFrameFast,
  resolveWaveformCanvasCoverageRangesAfterDraw,
};

function shiftWaveformCanvasColumnRange(args: {
  geometry: WaveformCanvasFrameGeometry;
  range: WaveformCanvasColumnRange;
  shiftX: number;
}) {
  return normalizeWaveformCanvasColumnRange({
    geometry: args.geometry,
    range: {
      endX: args.range.endX + args.shiftX,
      startX: args.range.startX + args.shiftX,
    },
  });
}

function transportWaveformCanvasColumnRangeThroughResize(args: {
  geometry: WaveformCanvasFrameGeometry;
  plan: Extract<WaveformCanvasFrameReusePlan, { kind: "viewport-resize" }>;
  range: WaveformCanvasColumnRange;
}) {
  const copySourceEndX = args.plan.copySourceStartX + args.plan.copyWidthPx;
  const overlapStartX = Math.max(args.range.startX, args.plan.copySourceStartX);
  const overlapEndX = Math.min(args.range.endX, copySourceEndX);

  if (overlapEndX <= overlapStartX) {
    return null;
  }

  const shiftX = args.plan.copyTargetStartX - args.plan.copySourceStartX;
  return normalizeWaveformCanvasColumnRange({
    geometry: args.geometry,
    range: {
      endX: overlapEndX + shiftX,
      startX: overlapStartX + shiftX,
    },
  });
}

function resolveWaveformCanvasViewportResizeDirtyRanges(args: {
  exposedRanges: readonly WaveformCanvasColumnRange[];
  geometry: WaveformCanvasFrameGeometry;
  plan: Extract<WaveformCanvasFrameReusePlan, { kind: "viewport-resize" }>;
  previousDirtyRanges: readonly WaveformCanvasColumnRange[];
}) {
  const transportedDirtyRanges = args.previousDirtyRanges
    .map((range) =>
      transportWaveformCanvasColumnRangeThroughResize({
        geometry: args.geometry,
        plan: args.plan,
        range,
      }),
    )
    .filter((range): range is WaveformCanvasColumnRange => range !== null);

  return normalizeWaveformCanvasColumnRanges({
    geometry: args.geometry,
    ranges: [...transportedDirtyRanges, ...args.exposedRanges],
  });
}

function resolveWaveformCanvasHorizontalPanDirtyRanges(args: {
  exposedRanges: readonly WaveformCanvasColumnRange[];
  geometry: WaveformCanvasFrameGeometry;
  plan: Extract<WaveformCanvasFrameReusePlan, { kind: "horizontal-pan" }>;
  previousDirtyRanges: readonly WaveformCanvasColumnRange[];
}) {
  const shiftX = args.plan.shiftX;
  const transportedDirtyRanges = args.previousDirtyRanges
    .map((range) =>
      shiftWaveformCanvasColumnRange({
        geometry: args.geometry,
        range,
        shiftX,
      }),
    )
    .filter((range): range is WaveformCanvasColumnRange => range !== null);

  return normalizeWaveformCanvasColumnRanges({
    geometry: args.geometry,
    ranges: [...transportedDirtyRanges, ...args.exposedRanges],
  });
}

function resolveWaveformCanvasZoomAffineColumnTargetX(args: {
  current: WaveformCanvasFrameDescriptor;
  plan: Extract<WaveformCanvasFrameReusePlan, { kind: "zoom-affine" }>;
  previousX: number;
  previous: WaveformCanvasFrameGeometry;
}) {
  const previousViewportX = args.previousX - args.previous.rasterStartX;
  const previousVisualSeconds =
    (args.plan.sourceOffsetX + previousViewportX) /
    Math.max(1, args.current.viewport.pixelsPerSecond / args.plan.scaleX);

  return Math.round(
    previousVisualSeconds * Math.max(1, args.current.viewport.pixelsPerSecond) -
      args.current.viewport.scrollLeft,
  );
}

function resolveWaveformCanvasZoomAffineTransportPlan(args: {
  current: WaveformCanvasFrameDescriptor;
  plan: Extract<WaveformCanvasFrameReusePlan, { kind: "zoom-affine" }>;
  previous: WaveformCanvasFrameGeometry;
}) {
  const previousRasterEndX = resolveWaveformCanvasRasterEndX(args.previous);
  const columnCopies: Array<{ sourceX: number; targetX: number }> = [];
  const dirtyRanges: WaveformCanvasColumnRange[] = [];
  let activeGapStartX: number | null = null;
  let activeGapEndX: number | null = null;
  let previousTargetX: number | null = null;

  for (let previousX = args.previous.rasterStartX; previousX < previousRasterEndX; previousX += 1) {
    const targetX = resolveWaveformCanvasZoomAffineColumnTargetX({
      current: args.current,
      plan: args.plan,
      previous: args.previous,
      previousX,
    });
    const targetColumn = normalizeWaveformCanvasColumnRange({
      geometry: args.current.geometry,
      range: {
        endX: targetX + 1,
        startX: targetX,
      },
    });

    if (!targetColumn) {
      continue;
    }

    columnCopies.push({
      sourceX: previousX,
      targetX: targetColumn.startX,
    });

    if (previousTargetX !== null && targetColumn.startX > previousTargetX + 1) {
      if (activeGapEndX === previousTargetX + 1) {
        activeGapEndX = targetColumn.startX;
      } else {
        if (activeGapStartX !== null && activeGapEndX !== null) {
          dirtyRanges.push({
            endX: activeGapEndX,
            startX: activeGapStartX,
          });
        }
        activeGapStartX = previousTargetX + 1;
        activeGapEndX = targetColumn.startX;
      }
    }

    previousTargetX = targetColumn.startX;
  }

  if (activeGapStartX !== null && activeGapEndX !== null) {
    dirtyRanges.push({
      endX: activeGapEndX,
      startX: activeGapStartX,
    });
  }

  return {
    dirtyRanges: normalizeWaveformCanvasColumnRanges({
      geometry: args.current.geometry,
      ranges: [...args.plan.dirtyRanges, ...args.plan.exposedRanges, ...dirtyRanges],
    }),
    columnCopies,
  };
}

export function resolveWaveformCanvasDirtyRangesAfterPresentation(args: {
  exposedRanges: readonly WaveformCanvasColumnRange[];
  geometry: WaveformCanvasFrameGeometry;
  plan: Extract<
    WaveformCanvasFrameReusePlan,
    { kind: "horizontal-pan" | "viewport-resize" | "zoom-affine" }
  >;
  previousDirtyRanges: readonly WaveformCanvasColumnRange[];
}) {
  if (args.plan.kind === "viewport-resize") {
    return resolveWaveformCanvasViewportResizeDirtyRanges({
      exposedRanges: args.exposedRanges,
      geometry: args.geometry,
      plan: args.plan,
      previousDirtyRanges: args.previousDirtyRanges,
    });
  }

  if (args.plan.kind === "zoom-affine") {
    return normalizeWaveformCanvasColumnRanges({
      geometry: args.geometry,
      ranges: args.exposedRanges,
    });
  }

  return resolveWaveformCanvasHorizontalPanDirtyRanges({
    exposedRanges: args.exposedRanges,
    geometry: args.geometry,
    plan: args.plan,
    previousDirtyRanges: args.previousDirtyRanges,
  });
}

function subtractWaveformCanvasColumnRanges(args: {
  geometry: WaveformCanvasFrameGeometry;
  ranges: readonly WaveformCanvasColumnRange[];
  subtract: readonly WaveformCanvasColumnRange[];
}) {
  let remaining = normalizeWaveformCanvasColumnRanges({
    geometry: args.geometry,
    ranges: args.ranges,
  });
  const subtract = normalizeWaveformCanvasColumnRanges({
    geometry: args.geometry,
    ranges: args.subtract,
  });

  for (const resolved of subtract) {
    remaining = remaining.flatMap((range) => {
      if (resolved.endX <= range.startX || resolved.startX >= range.endX) {
        return [range];
      }

      const fragments: WaveformCanvasColumnRange[] = [];
      if (resolved.startX > range.startX) {
        fragments.push({
          endX: resolved.startX,
          startX: range.startX,
        });
      }
      if (resolved.endX < range.endX) {
        fragments.push({
          endX: range.endX,
          startX: resolved.endX,
        });
      }

      return fragments;
    });
  }

  return normalizeWaveformCanvasColumnRanges({
    geometry: args.geometry,
    ranges: remaining,
  });
}

function resolveWaveformCanvasCoverageRangesAfterDraw(args: {
  geometry: WaveformCanvasFrameGeometry;
  previousMissingRanges: readonly WaveformCanvasColumnRange[];
  update: WaveformCanvasCoverageRangeUpdate;
}) {
  // A redrawn column gets a fresh density verdict; fallback draws re-enter through missingRanges.
  return normalizeWaveformCanvasColumnRanges({
    geometry: args.geometry,
    ranges: [
      ...subtractWaveformCanvasColumnRanges({
        geometry: args.geometry,
        ranges: args.previousMissingRanges,
        subtract: args.update.drawnRanges,
      }),
      ...args.update.missingRanges,
    ],
  });
}

function completeWaveformCanvasRenderJob(args: {
  canvas: HTMLCanvasElement;
  job: WaveformCanvasRenderJob;
}): WaveformCanvasRenderJobCompletion {
  if (args.job.target.canvas !== args.canvas) {
    return {
      kind: "empty",
      reason: "missing-context",
    };
  }

  return {
    dirtyRanges: normalizeWaveformCanvasColumnRanges({
      geometry: args.job.plan.geometry,
      ranges: args.job.cursor.missingRanges,
    }),
    kind: "committed",
  };
}

function resetWaveformPanPresentation(args: {
  controller: WaveformCanvasRenderController;
  ownerWindow: Window | null;
}) {
  const ownerWindow = args.ownerWindow;
  if (args.controller.panPresentationFrameId !== null && ownerWindow) {
    ownerWindow.cancelAnimationFrame(args.controller.panPresentationFrameId);
  }
  if (args.controller.panPresentationTimeoutId !== null && ownerWindow) {
    ownerWindow.clearTimeout(args.controller.panPresentationTimeoutId);
  }
  args.controller.panPresentationFrameId = null;
  args.controller.panPresentationTargetFrame = null;
  args.controller.panPresentationTimeoutId = null;
}

function resetWaveformCanvasPanPresentation(canvas: HTMLCanvasElement) {
  canvas.style.removeProperty("--waveform-canvas-pan-presentation-transform");
  canvas.style.removeProperty("--waveform-canvas-pan-presentation-transition");
  canvas.style.removeProperty("--waveform-canvas-pan-presentation-will-change");
}

function prepareWaveformOverlayPanPresentation(args: { host: HTMLElement | null; shiftX: number }) {
  const ownerWindow = args.host?.ownerDocument.defaultView;
  const shiftX = Number.isFinite(args.shiftX) ? args.shiftX : 0;

  if (shiftX === 0 || !args.host || !ownerWindow) {
    return;
  }

  if (ownerWindow.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  const existingTimeout = waveformOverlayPanPresentationTimeouts.get(args.host);
  if (existingTimeout !== undefined) {
    ownerWindow.clearTimeout(existingTimeout);
  }

  args.host.style.setProperty("--waveform-pan-presentation-transition", "none");
  args.host.style.setProperty(
    "--waveform-pan-presentation-transform",
    resolveWaveformPanPresentationTransform(shiftX),
  );
  args.host.style.setProperty("--waveform-pan-presentation-will-change", "transform");
}

function startWaveformOverlayPanPresentation(args: { host: HTMLElement | null }) {
  const ownerWindow = args.host?.ownerDocument.defaultView;
  if (!args.host || !ownerWindow) {
    return;
  }

  args.host.style.setProperty(
    "--waveform-pan-presentation-transition",
    WAVEFORM_OVERLAY_PAN_PRESENTATION_TRANSITION,
  );
  args.host.style.setProperty("--waveform-pan-presentation-transform", "translate3d(0, 0, 0)");
  waveformOverlayPanPresentationTimeouts.set(
    args.host,
    ownerWindow.setTimeout(() => {
      args.host?.style.removeProperty("--waveform-pan-presentation-transition");
      args.host?.style.removeProperty("--waveform-pan-presentation-transform");
      args.host?.style.removeProperty("--waveform-pan-presentation-will-change");
      if (args.host) {
        waveformOverlayPanPresentationTimeouts.delete(args.host);
      }
    }, WAVEFORM_PAN_PRESENTATION_DURATION_MS),
  );
}

function resetWaveformOverlayPanPresentation(host: HTMLElement | null) {
  const ownerWindow = host?.ownerDocument.defaultView;
  if (!host || !ownerWindow) {
    return;
  }

  const existingTimeout = waveformOverlayPanPresentationTimeouts.get(host);
  if (existingTimeout !== undefined) {
    ownerWindow.clearTimeout(existingTimeout);
    waveformOverlayPanPresentationTimeouts.delete(host);
  }

  host.style.removeProperty("--waveform-pan-presentation-transition");
  host.style.removeProperty("--waveform-pan-presentation-transform");
  host.style.removeProperty("--waveform-pan-presentation-will-change");
}

function startWaveformPanPresentation(args: {
  canStart: (presentation: WaveformPanPresentationStart) => boolean;
  canvas: HTMLCanvasElement;
  controller: WaveformCanvasRenderController;
  descriptor: WaveformCanvasFrameDescriptor;
  onCancel?: () => void;
  onPrepare?: (presentation: WaveformPanPresentationStart) => void;
  onStart: (presentation: WaveformPanPresentationStart) => void;
  shiftX: number;
}) {
  const ownerWindow = args.canvas.ownerDocument.defaultView;
  const shiftX = Number.isFinite(args.shiftX) ? args.shiftX : 0;
  resetWaveformPanPresentation({
    controller: args.controller,
    ownerWindow,
  });
  resetWaveformCanvasPanPresentation(args.canvas);

  if (shiftX === 0 || !ownerWindow) {
    return false;
  }

  const presentation = {
    animate: !ownerWindow.matchMedia("(prefers-reduced-motion: reduce)").matches,
    hasDirtyRanges: args.controller.presentedDirtyRanges.length > 0,
    shiftX,
  };
  if (!args.canStart(presentation)) {
    return false;
  }

  if (!presentation.animate) {
    args.onPrepare?.(presentation);
    args.onStart(presentation);
    return true;
  }

  const initialTransform = resolveWaveformPanPresentationTransform(shiftX);
  const finalTransform = "translate3d(0, 0, 0)";
  args.controller.panPresentationTargetFrame = args.descriptor;
  args.canvas.style.setProperty("--waveform-canvas-pan-presentation-transition", "none");
  args.canvas.style.setProperty("--waveform-canvas-pan-presentation-transform", initialTransform);
  args.canvas.style.setProperty("--waveform-canvas-pan-presentation-will-change", "transform");
  args.onPrepare?.(presentation);
  args.controller.panPresentationFrameId = ownerWindow.requestAnimationFrame(() => {
    args.controller.panPresentationFrameId = null;
    if (!args.canStart(presentation)) {
      args.controller.panPresentationTargetFrame = null;
      resetWaveformCanvasPanPresentation(args.canvas);
      args.onCancel?.();
      return;
    }
    args.onStart(presentation);
    args.canvas.style.setProperty(
      "--waveform-canvas-pan-presentation-transition",
      WAVEFORM_CANVAS_PAN_PRESENTATION_TRANSITION,
    );
    args.canvas.style.setProperty("--waveform-canvas-pan-presentation-transform", finalTransform);
    args.controller.panPresentationTimeoutId = ownerWindow.setTimeout(() => {
      args.controller.panPresentationTimeoutId = null;
      args.controller.panPresentationTargetFrame = null;
      resetWaveformCanvasPanPresentation(args.canvas);
    }, WAVEFORM_PAN_PRESENTATION_DURATION_MS);
  });

  return true;
}

function presentWaveformCanvasFrameFast(args: {
  canvas: HTMLCanvasElement | null;
  descriptor: WaveformCanvasFrameDescriptor | null;
  descriptorPlan: WaveformCanvasRenderPlan | null;
  previousDirtyRanges: readonly WaveformCanvasColumnRange[];
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

  if (!args.descriptorPlan) {
    return {
      kind: "empty",
      plan: null,
      reason: "missing-descriptor",
      reuseFrame: args.reuseFrame,
    };
  }

  const canvas = args.canvas;
  const descriptor = args.descriptor;
  const descriptorPlan = args.descriptorPlan;
  const target = resolveWaveformCanvasRasterTarget({
    canvas,
    color: descriptor.color,
    geometry: descriptor.geometry,
  });
  if (target.kind === "empty") {
    return {
      kind: "empty",
      plan: null,
      reason: "missing-context",
      reuseFrame: args.reuseFrame,
    };
  }

  const presentationPlan = resolveWaveformCanvasFastPresentationPlan({
    current: descriptor,
    dirtyRanges: args.previousDirtyRanges,
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

  const reuseFrame = args.reuseFrame ?? canvas.ownerDocument.createElement("canvas");
  const previousGeometry = args.previous?.geometry ?? descriptor.geometry;
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

  return renderWaveformCanvasEffect({
    command: {
      command: {
        canvas,
        context: target.target.context,
        descriptor,
        descriptorPlan,
        plan: presentationPlan,
        previousDirtyRanges: args.previousDirtyRanges,
        previousGeometry,
        reuseFrame,
      },
      kind: "fast-presentation",
    },
  }) as WaveformCanvasFastPresentationResult;
}

function runWaveformCanvasFastPresentationEffect(
  command: WaveformCanvasFastPresentationCommand,
): WaveformCanvasFastPresentationResult {
  const context = command.context;
  const descriptor = command.descriptor;
  const presentationPlan = command.plan;
  const previousGeometry = command.previousGeometry;
  const reuseFrame = command.reuseFrame;
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
  reuseContext.drawImage(command.canvas, 0, 0);

  applyWaveformVisibleCanvasGeometry({
    canvas: command.canvas,
    geometry: descriptor.geometry,
  });
  context.resetTransform();
  if (presentationPlan.kind !== "zoom-affine") {
    context.clearRect(0, 0, descriptor.geometry.backingWidth, descriptor.geometry.backingHeight);
  }
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  copyWaveformCanvasFastPresentationFrame({
    context,
    descriptor,
    plan: presentationPlan,
    previousGeometry,
    reuseFrame,
  });

  const zoomAffineTransport =
    presentationPlan.kind === "zoom-affine"
      ? resolveWaveformCanvasZoomAffineTransportPlan({
          current: descriptor,
          plan: presentationPlan,
          previous: previousGeometry,
        })
      : null;
  const exposedRanges = resolveWaveformCanvasFastPresentationExposedRanges(presentationPlan);
  const insertionRanges =
    presentationPlan.kind === "zoom-affine"
      ? normalizeWaveformCanvasColumnRanges({
          geometry: descriptor.geometry,
          ranges: zoomAffineTransport?.dirtyRanges ?? [],
        })
      : [];
  const insertionWidthPx = insertionRanges.reduce(
    (sum, range) => sum + range.endX - range.startX,
    0,
  );
  const redraw = redrawWaveformCanvasFastPresentationExposedRanges({
    canvas: command.canvas,
    context,
    descriptor,
    descriptorPlan: command.descriptorPlan,
    exposedRanges: presentationPlan.kind === "zoom-affine" ? insertionRanges : exposedRanges,
    plan: presentationPlan,
  });
  const undrawnExposedRanges = redraw.undrawnExposedRanges;
  const unresolvedInsertionRanges =
    presentationPlan.kind === "zoom-affine"
      ? resolveWaveformCanvasInsertedRangesAfterZoomAffinePresentation({
          draws: redraw.draws,
          geometry: descriptor.geometry,
          ranges: insertionRanges,
        })
      : [];
  const dirtyRanges =
    presentationPlan.kind === "dirty-redraw"
      ? normalizeWaveformCanvasColumnRanges({
          geometry: descriptor.geometry,
          ranges: undrawnExposedRanges,
        })
      : presentationPlan.kind === "zoom-affine"
        ? unresolvedInsertionRanges
        : resolveWaveformCanvasDirtyRangesAfterPresentation({
            exposedRanges: undrawnExposedRanges,
            geometry: descriptor.geometry,
            plan: presentationPlan,
            previousDirtyRanges: command.previousDirtyRanges,
          });

  if (presentationPlan.kind === "dirty-redraw") {
    return {
      descriptor,
      dirtyRanges,
      draws: redraw.draws,
      exposedRanges,
      exposedWidthPx: exposedRanges.reduce((sum, range) => sum + range.endX - range.startX, 0),
      kind: "presented",
      mode: "dirty-redraw",
      plan: presentationPlan,
      reuseFrame,
    };
  }

  if (presentationPlan.kind === "horizontal-pan") {
    return {
      descriptor,
      dirtyRanges,
      draws: redraw.draws,
      exposedRanges,
      exposedWidthPx: exposedRanges.reduce((sum, range) => sum + range.endX - range.startX, 0),
      kind: "presented",
      mode: "horizontal-pan",
      plan: presentationPlan,
      reuseFrame,
    };
  }

  if (presentationPlan.kind === "zoom-affine") {
    return {
      descriptor,
      dirtyRanges,
      draws: redraw.draws,
      exposedRanges,
      exposedWidthPx: exposedRanges.reduce((sum, range) => sum + range.endX - range.startX, 0),
      insertionWidthPx,
      insertionRanges: unresolvedInsertionRanges,
      kind: "presented",
      mode: "zoom-affine",
      plan: presentationPlan,
      reuseFrame,
    };
  }

  return {
    descriptor,
    dirtyRanges,
    draws: redraw.draws,
    exposedRanges,
    exposedWidthPx: exposedRanges.reduce((sum, range) => sum + range.endX - range.startX, 0),
    kind: "presented",
    mode: "viewport-resize",
    plan: presentationPlan,
    reuseFrame,
  };
}

function copyWaveformCanvasFastPresentationFrame(args: {
  context: CanvasRenderingContext2D;
  descriptor: WaveformCanvasFrameDescriptor;
  plan: WaveformCanvasFastPresentationCommand["plan"];
  previousGeometry: WaveformCanvasFrameGeometry;
  reuseFrame: HTMLCanvasElement;
}) {
  if (args.plan.kind === "dirty-redraw") {
    args.context.drawImage(args.reuseFrame, 0, 0);
    return;
  }

  if (args.plan.kind === "horizontal-pan") {
    args.context.drawImage(
      args.reuseFrame,
      args.plan.shiftX * args.descriptor.geometry.devicePixelRatio,
      0,
    );
    return;
  }

  if (args.plan.kind === "zoom-affine") {
    const scale = args.descriptor.geometry.devicePixelRatio;
    const transport = resolveWaveformCanvasZoomAffineTransportPlan({
      current: args.descriptor,
      plan: args.plan,
      previous: args.previousGeometry,
    });
    const targetColumns = new Set(transport.columnCopies.map((copy) => copy.targetX));
    args.context.imageSmoothingEnabled = false;
    args.context.globalCompositeOperation = "source-over";
    for (const copy of transport.columnCopies) {
      if (targetColumns.has(copy.sourceX)) {
        continue;
      }
      args.context.clearRect(
        (copy.sourceX - args.previousGeometry.rasterStartX) * scale,
        0,
        scale,
        args.previousGeometry.backingHeight,
      );
    }
    for (const copy of transport.columnCopies) {
      args.context.drawImage(
        args.reuseFrame,
        (copy.sourceX - args.previousGeometry.rasterStartX) * scale,
        0,
        scale,
        args.descriptor.geometry.backingHeight,
        (copy.targetX - args.descriptor.geometry.rasterStartX) * scale,
        0,
        scale,
        args.descriptor.geometry.backingHeight,
      );
    }
    args.context.globalCompositeOperation = "source-over";
    return;
  }

  const scale = args.descriptor.geometry.devicePixelRatio;
  const sourceStartX = (args.plan.copySourceStartX - args.previousGeometry.rasterStartX) * scale;
  const targetStartX = (args.plan.copyTargetStartX - args.descriptor.geometry.rasterStartX) * scale;
  args.context.drawImage(
    args.reuseFrame,
    sourceStartX,
    0,
    args.plan.copyWidthPx * scale,
    args.previousGeometry.backingHeight,
    targetStartX,
    0,
    args.plan.copyWidthPx * scale,
    args.descriptor.geometry.backingHeight,
  );
}

function resolveWaveformCanvasFastPresentationExposedRanges(
  plan: WaveformCanvasFastPresentationCommand["plan"],
) {
  if (plan.kind === "horizontal-pan") {
    return [
      {
        endX: plan.exposedEndX,
        startX: plan.exposedStartX,
      },
    ];
  }

  if (plan.kind === "zoom-affine") {
    return plan.exposedRanges;
  }

  return plan.kind === "dirty-redraw" ? plan.dirtyRanges : plan.exposedRanges;
}

function redrawWaveformCanvasFastPresentationExposedRanges(args: {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  descriptor: WaveformCanvasFrameDescriptor;
  descriptorPlan: WaveformCanvasRenderPlan;
  exposedRanges: readonly WaveformCanvasColumnRange[];
  plan: WaveformCanvasFastPresentationCommand["plan"];
}) {
  const draws: WaveformCanvasRangeDrawResult[] = [];

  if (args.plan.kind === "viewport-resize") {
    return {
      draws,
      undrawnExposedRanges: args.exposedRanges,
    };
  }

  args.context.scale(
    args.descriptor.geometry.devicePixelRatio,
    args.descriptor.geometry.devicePixelRatio,
  );
  args.context.translate(-args.descriptor.geometry.rasterStartX, 0);
  args.context.imageSmoothingEnabled = false;
  args.context.fillStyle = args.descriptor.color;
  args.context.globalAlpha = 1;

  const target = {
    canvas: args.canvas,
    color: args.descriptor.color,
    context: args.context,
    geometry: args.descriptor.geometry,
    kind: "visible" as const,
  };

  return {
    draws,
    undrawnExposedRanges: args.exposedRanges.flatMap((range) => {
      const draw = renderWaveformCanvasEffect({
        command: {
          kind: "column-range",
          plan: args.descriptorPlan,
          range,
          replaceExistingColumns: args.plan.kind === "dirty-redraw",
          target,
        },
      }) as WaveformCanvasRangeDrawResult;
      draws.push(draw);

      return draw.missingRanges;
    }),
  };
}

function resolveWaveformCanvasChunkWindow(args: {
  startX: number;
  stepX: number;
  viewportWidth: number;
}): {
  maxChunkEndX: number;
  minChunkEndX: number;
} {
  return {
    maxChunkEndX: Math.min(
      args.viewportWidth,
      args.startX + (WAVEFORM_CANVAS_MAX_CHUNK_WIDTH_PX - 1) * args.stepX + 1,
    ),
    minChunkEndX: Math.min(
      args.viewportWidth,
      args.startX + (WAVEFORM_CANVAS_MIN_CHUNK_WIDTH_PX - 1) * args.stepX + 1,
    ),
  };
}

function resolveWaveformCanvasProgressivePass(passIndex: number) {
  return (
    WAVEFORM_CANVAS_PROGRESSIVE_PASSES[passIndex] ?? {
      startOffsetX: 0,
      stepX: 1,
    }
  );
}

function resolveWaveformCanvasProgressivePassCount() {
  return WAVEFORM_CANVAS_PROGRESSIVE_PASSES.length;
}

function resolveWaveformCanvasCursorPass(args: { cursor: WaveformCanvasRenderCursor }) {
  return args.cursor.schedule !== "full-density"
    ? resolveWaveformCanvasProgressivePass(args.cursor.passIndex)
    : {
        startOffsetX: 0,
        stepX: 1,
      };
}

function resolveWaveformCanvasCursorCompletionPassCount(args: {
  cursor: WaveformCanvasRenderCursor;
}) {
  return args.cursor.schedule !== "full-density" && !args.cursor.ranges
    ? resolveWaveformCanvasProgressivePassCount()
    : 1;
}

function resolveWaveformCanvasProgressivePassStartX(args: {
  geometry: WaveformCanvasFrameGeometry;
  startOffsetX: number;
}) {
  const startX = args.geometry.rasterStartX + args.startOffsetX;
  const endX = args.geometry.rasterStartX + args.geometry.rasterWidth;

  return startX < endX ? startX : endX;
}

function resolveWaveformCanvasRasterEndX(geometry: WaveformCanvasFrameGeometry) {
  return geometry.rasterStartX + geometry.rasterWidth;
}

function resolveWaveformCanvasDirtyRedrawRanges(args: {
  cursor: WaveformCanvasRenderCursor;
  geometry: WaveformCanvasFrameGeometry;
}) {
  if (!args.cursor.ranges) {
    return null;
  }
  if (args.cursor.rangeComposition === "direct") {
    return normalizeWaveformCanvasColumnRanges({
      geometry: args.geometry,
      ranges: args.cursor.ranges,
    });
  }

  const ranges = normalizeWaveformCanvasColumnRanges({
    geometry: args.geometry,
    ranges: args.cursor.ranges,
  });
  if (ranges.length === 0) {
    return [];
  }

  const redrawRanges: WaveformCanvasColumnRange[] = [];

  for (const range of ranges) {
    const previous = redrawRanges.at(-1);
    if (previous && range.startX - previous.endX <= WAVEFORM_CANVAS_MAX_CHUNK_WIDTH_PX) {
      previous.endX = Math.max(previous.endX, range.endX);
    } else {
      redrawRanges.push({
        endX: range.endX,
        startX: range.startX,
      });
    }
  }

  return redrawRanges;
}

function advanceWaveformCanvasProgressiveCursor(args: {
  cursor: WaveformCanvasRenderCursor;
  geometry: WaveformCanvasFrameGeometry;
  nextX: number;
  rangeEndX: number;
  ranges?: readonly WaveformCanvasColumnRange[] | null;
}): Pick<WaveformCanvasRenderCursor, "nextX" | "passIndex" | "rangeIndex"> {
  if (args.nextX < args.rangeEndX) {
    return {
      nextX: args.nextX,
      passIndex: args.cursor.passIndex,
      rangeIndex: args.cursor.rangeIndex,
    };
  }

  const nextRangeIndex = args.cursor.rangeIndex + 1;
  const nextRange = (args.ranges ?? args.cursor.ranges)?.[nextRangeIndex] ?? null;
  if (nextRange) {
    return {
      nextX: nextRange.startX,
      passIndex: args.cursor.passIndex,
      rangeIndex: nextRangeIndex,
    };
  }

  const nextPassIndex = args.cursor.passIndex + 1;
  if (
    nextPassIndex >=
    resolveWaveformCanvasCursorCompletionPassCount({
      cursor: args.cursor,
    })
  ) {
    return {
      nextX: resolveWaveformCanvasRasterEndX(args.geometry),
      passIndex: nextPassIndex,
      rangeIndex: nextRangeIndex,
    };
  }

  const nextPass = resolveWaveformCanvasCursorPass({
    cursor: {
      ...args.cursor,
      passIndex: nextPassIndex,
    },
  });

  return {
    nextX: resolveWaveformCanvasProgressivePassStartX({
      geometry: args.geometry,
      startOffsetX: nextPass.startOffsetX,
    }),
    passIndex: nextPassIndex,
    rangeIndex: 0,
  };
}

function resolveWaveformCanvasColumnPeak(args: {
  candidateLevels: WaveformLevelTileIndex[];
  dataPixelsPerSecond: number;
  tileWidth: number;
  viewport: WaveformViewportModel;
  x: number;
}): WaveformCanvasColumnSample | null {
  const durationSeconds = resolveWaveformDurationSeconds(args.viewport.durationMs);
  const startSeconds = resolveWaveformViewportAudioSeconds({
    pixelsPerSecond: args.viewport.pixelsPerSecond,
    scrollLeft: args.viewport.scrollLeft,
    viewportX: args.x,
  });
  const endSeconds = resolveWaveformViewportAudioSeconds({
    pixelsPerSecond: args.viewport.pixelsPerSecond,
    scrollLeft: args.viewport.scrollLeft,
    viewportX: args.x + 1,
  });

  if (endSeconds <= 0 || startSeconds >= durationSeconds) {
    return {
      levelPixelsPerSecond: args.dataPixelsPerSecond,
      peak: {
        max: 0,
        min: 0,
      },
      targetDensityResolved: true,
    };
  }

  return resolveWaveformPeakFromCandidateLevels({
    candidateLevels: args.candidateLevels,
    dataPixelsPerSecond: args.dataPixelsPerSecond,
    endSeconds: clampNumber(endSeconds, 0, durationSeconds),
    startSeconds: clampNumber(startSeconds, 0, durationSeconds),
    tileWidth: args.tileWidth,
  });
}

function resolveWaveformCanvasColumnPath(args: {
  peak: WaveformCanvasColumnSample;
  plan: WaveformCanvasRenderPlan;
  x: number;
}): WaveformCanvasColumnPath {
  const barX = args.x + 0.5;
  const yTop = args.plan.centerY - args.peak.peak.max * args.plan.amplitude;
  const yBottom = args.plan.centerY - args.peak.peak.min * args.plan.amplitude;
  const height = Math.max(1, yBottom - yTop);

  return {
    barX,
    height,
    yBottom,
    yTop,
  };
}

function drawWaveformCanvasColumn(args: {
  columnPath: WaveformCanvasColumnPath;
  context: CanvasRenderingContext2D;
}) {
  args.context.fillRect(
    args.columnPath.barX - resolveWaveformBarWidthPx() / 2,
    args.columnPath.yTop,
    resolveWaveformBarWidthPx(),
    args.columnPath.height,
  );
}

function mergeWaveformCanvasChunkCursor(args: {
  chunk: {
    drawnRanges: WaveformCanvasColumnRange[];
    firstMissingX: number | null;
    hasChunkColumn: boolean;
    lastMissingX: number | null;
    missingRanges: WaveformCanvasColumnRange[];
    missingPeakColumns: number;
    resolvedPeakCount: number;
  };
  cursor: WaveformCanvasRenderCursor;
  endX: number;
  geometry: WaveformCanvasFrameGeometry;
  rangeEndX: number;
  ranges?: readonly WaveformCanvasColumnRange[] | null;
}): WaveformCanvasRenderCursor {
  const nextPosition = advanceWaveformCanvasProgressiveCursor({
    cursor: args.cursor,
    geometry: args.geometry,
    nextX: args.endX,
    rangeEndX: args.rangeEndX,
    ranges: args.ranges,
  });

  return {
    drawnRanges: normalizeWaveformCanvasColumnRanges({
      geometry: args.geometry,
      ranges: [...args.cursor.drawnRanges, ...args.chunk.drawnRanges],
    }),
    firstMissingX: args.cursor.firstMissingX ?? args.chunk.firstMissingX,
    hasDrawnColumn: args.cursor.hasDrawnColumn || args.chunk.hasChunkColumn,
    lastMissingX: args.chunk.lastMissingX ?? args.cursor.lastMissingX,
    missingRanges: resolveWaveformCanvasCoverageRangesAfterDraw({
      geometry: args.geometry,
      previousMissingRanges: [...args.cursor.missingRanges, ...args.cursor.retargetRanges],
      update: {
        drawnRanges: args.chunk.drawnRanges,
        missingRanges: args.chunk.missingRanges,
      },
    }),
    missingPeakColumnCount: args.cursor.missingPeakColumnCount + args.chunk.missingPeakColumns,
    nextX: nextPosition.nextX,
    passIndex: nextPosition.passIndex,
    rangeComposition: args.cursor.rangeComposition,
    ranges: args.cursor.ranges,
    rangeIndex: nextPosition.rangeIndex,
    retargetRanges: [],
    resolvedPeakColumnCount: args.cursor.resolvedPeakColumnCount + args.chunk.resolvedPeakCount,
    schedule: args.cursor.schedule,
  };
}

export function drawWaveformCanvasJobChunk(
  args: WaveformCanvasJobChunkCommand,
): WaveformCanvasChunkResult {
  return runWaveformCanvasJobChunkEffect(args);
}

function runWaveformCanvasJobChunkEffect(
  args: WaveformCanvasJobChunkCommand,
): WaveformCanvasChunkResult {
  const context = args.target.context;
  const plan = args.plan;
  const pass = resolveWaveformCanvasCursorPass({
    cursor: args.cursor,
  });
  const redrawRanges = resolveWaveformCanvasDirtyRedrawRanges({
    cursor: args.cursor,
    geometry: plan.geometry,
  });
  const activeRange = redrawRanges?.[args.cursor.rangeIndex] ?? null;
  const startX = args.cursor.nextX;
  const rangeEndX = activeRange?.endX ?? resolveWaveformCanvasRasterEndX(plan.geometry);
  const { maxChunkEndX, minChunkEndX } = resolveWaveformCanvasChunkWindow({
    startX,
    stepX: pass.stepX,
    viewportWidth: rangeEndX,
  });
  let endX = startX;
  let deadlineHit = false;

  for (; endX < rangeEndX; endX += pass.stepX) {
    const reachedMaxChunkEnd = endX >= minChunkEndX && endX >= maxChunkEndX;
    const reachedDeadline =
      endX >= minChunkEndX && !reachedMaxChunkEnd && args.now() >= args.deadlineMs;
    if (reachedMaxChunkEnd || reachedDeadline) {
      deadlineHit = reachedDeadline;
      endX += pass.stepX;
      break;
    }
  }

  const chunkRange = normalizeWaveformCanvasColumnRange({
    geometry: plan.geometry,
    range: {
      endX,
      startX,
    },
  });
  const drawPlan = createWaveformCanvasColumnRangeRenderPlan({
    pass,
    plan,
    range: chunkRange,
  });
  const drawnRanges = drawPlan.drawnRanges;

  if (args.replaceExistingColumns && drawnRanges.length > 0) {
    clearWaveformCanvasColumnRanges({
      context,
      geometry: plan.geometry,
      ranges: drawnRanges,
    });
  }

  for (const columnPath of drawPlan.columnPaths.values()) {
    drawWaveformCanvasColumn({
      columnPath,
      context,
    });
  }

  const cursor = mergeWaveformCanvasChunkCursor({
    chunk: {
      drawnRanges,
      firstMissingX: drawPlan.firstMissingX,
      hasChunkColumn: drawPlan.hasColumn,
      lastMissingX: drawPlan.lastMissingX,
      missingRanges: drawPlan.missingRanges,
      missingPeakColumns: drawPlan.missingPeakColumns,
      resolvedPeakCount: drawPlan.resolvedPeakCount,
    },
    cursor: args.cursor,
    endX,
    geometry: plan.geometry,
    rangeEndX,
    ranges: redrawRanges,
  });
  const completed =
    cursor.passIndex >=
    resolveWaveformCanvasCursorCompletionPassCount({
      cursor,
    });
  const limitReason: WaveformCanvasChunkLimitReason =
    endX >= rangeEndX ? "range-end" : deadlineHit ? "deadline" : "max-width";
  const trace =
    args.collectTrace === true
      ? createWaveformCanvasChunkBehaviorTracePayload({
          completed,
          cursorAfter: cursor,
          cursorBefore: args.cursor,
          deadlineHit,
          drawPlan,
          endX,
          limitReason,
          maxChunkEndX,
          minChunkEndX,
          pass,
          plan,
          range: chunkRange,
          rangeEndX,
          startX,
        })
      : null;

  return {
    completed,
    cursor,
    drawnRanges,
    firstMissingX: drawPlan.firstMissingX,
    hasChunkColumn: drawPlan.hasColumn,
    lastMissingX: drawPlan.lastMissingX,
    missingRanges: drawPlan.missingRanges,
    missingPeakColumns: drawPlan.missingPeakColumns,
    resolvedPeakCount: drawPlan.resolvedPeakCount,
    scannedColumns: drawPlan.scannedColumns,
    trace,
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
  dataPixelsPerSecond: number;
  endSeconds: number;
  startSeconds: number;
  tileWidth: number;
}): WaveformCanvasColumnSample | null {
  let completeFallbackSample: WaveformCanvasColumnSample | null = null;
  let partialSample: WaveformCanvasColumnSample | null = null;

  for (const level of args.candidateLevels) {
    const resolution = resolveWaveformPeakFromLevelIndex({
      endSeconds: args.endSeconds,
      level,
      startSeconds: args.startSeconds,
      tileWidth: args.tileWidth,
    });

    if (resolution) {
      const targetDensityResolved = level.pixelsPerSecond === args.dataPixelsPerSecond;
      const sample: WaveformCanvasColumnSample = {
        levelPixelsPerSecond: level.pixelsPerSecond,
        peak: resolution.peak,
        targetDensityResolved: targetDensityResolved && resolution.fullyCovered,
      };

      if (sample.targetDensityResolved) {
        return sample;
      }

      if (resolution.fullyCovered) {
        completeFallbackSample ??= sample;
      }
      partialSample ??= sample;
    }
  }

  return completeFallbackSample ?? partialSample;
}

function resolveWaveformPeakFromLevelIndex(args: {
  endSeconds: number;
  level: WaveformLevelTileIndex;
  startSeconds: number;
  tileWidth: number;
}): WaveformPeakRangeResolution | null {
  if (args.endSeconds <= 0 || args.startSeconds < 0 || args.endSeconds <= args.startSeconds) {
    return null;
  }

  const pixelsPerSecond = Math.max(1, args.level.pixelsPerSecond);
  const startPx = Math.max(0, Math.floor(args.startSeconds * pixelsPerSecond));
  const endPx = Math.max(startPx + 1, Math.ceil(args.endSeconds * pixelsPerSecond));

  return resolveWaveformTileIndexPeakRangeCoverageAtPixels({
    endPx,
    startPx,
    tileWidth: args.tileWidth,
    tilesByIndex: args.level.tilesByIndex,
  });
}

function resolveWaveformTileIndexPeakRangeCoverageAtPixels(args: {
  endPx: number;
  startPx: number;
  tileWidth: number;
  tilesByIndex: ReadonlyMap<number, Pick<TrackWaveformTile, "max" | "min" | "start_px">>;
}): WaveformPeakRangeResolution | null {
  const startPx = Math.max(0, Math.floor(args.startPx));
  const endPx = Math.max(startPx + 1, Math.ceil(args.endPx));
  const tileWidth = Math.max(1, Math.ceil(args.tileWidth));
  const startIndex = Math.floor(startPx / tileWidth);
  const endIndex = Math.floor((endPx - 1) / tileWidth);
  let min = 1;
  let max = -1;
  let found = false;
  let fullyCovered = true;

  for (let tileIndex = startIndex; tileIndex <= endIndex; tileIndex += 1) {
    const segmentStartPx = Math.max(startPx, tileIndex * tileWidth);
    const segmentEndPx = Math.min(endPx, (tileIndex + 1) * tileWidth);
    const tile = args.tilesByIndex.get(tileIndex);

    if (!tile) {
      fullyCovered = false;
      continue;
    }

    const tilePointCount = Math.min(tile.min.length, tile.max.length);
    const tileStartPx = tile.start_px;
    const tileEndPx = tileStartPx + tilePointCount;
    if (tileStartPx > segmentStartPx || tileEndPx < segmentEndPx) {
      fullyCovered = false;
    }

    const tilePeak = resolveWaveformTilePeakRangeAtPixels({
      endPx: segmentEndPx,
      startPx: segmentStartPx,
      tile,
    });

    if (!tilePeak) {
      fullyCovered = false;
      continue;
    }

    min = Math.min(min, tilePeak.min);
    max = Math.max(max, tilePeak.max);
    found = true;
  }

  return found
    ? {
        fullyCovered,
        peak: {
          max,
          min,
        },
      }
    : null;
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

export function resolveWaveformPlayheadCssVariables(args: {
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
    interaction: "horizontal-pan",
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
}): WaveformAudioViewportWindow {
  const pixelsPerSecond = Math.max(1, args.pixelsPerSecond);
  const viewportSeconds = Math.max(0, args.viewportWidth) / pixelsPerSecond;
  const overscanSeconds = viewportSeconds * Math.max(0, args.overscanViewports);
  const audioStartSeconds = waveformVisualSecondsToAudioSeconds(
    args.scrollLeft / pixelsPerSecond - overscanSeconds,
  );
  const audioEndSeconds = waveformVisualSecondsToAudioSeconds(
    (args.scrollLeft + args.viewportWidth) / pixelsPerSecond + overscanSeconds,
  );
  const startSeconds = clampNumber(audioStartSeconds, 0, args.durationSeconds);
  const endSeconds = clampNumber(audioEndSeconds, startSeconds, args.durationSeconds);

  return {
    endSeconds: Math.max(startSeconds, endSeconds),
    hasAudio:
      args.durationSeconds > 0 && audioEndSeconds > 0 && audioStartSeconds < args.durationSeconds,
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
  const hasAudio = !("hasAudio" in args.window) || args.window.hasAudio;

  if (!hasAudio || args.window.endSeconds <= args.window.startSeconds) {
    return { endPx: 0, startPx: 0 };
  }

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
