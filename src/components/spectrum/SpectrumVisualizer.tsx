import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { crab, type HardwareHorizontalWheelEvent, type PlaybackStatusPayload } from "@/src/cmd";
import { usePrefersDarkColorScheme } from "../colorScheme";
import {
  createPlaceholderWaveformSummary,
  createWaveformRenderDataStore,
  createWaveformSharedTileCacheForFile as createWaveformSharedTileCacheForStore,
  arePlaybackSnapshotsSamePlaybackSegment,
  clampInteger,
  clampNumber,
  projectWaveformTrackIdentity,
  resolvePlaybackPositionMs,
  resolvePlaybackSnapshotAfterStatusCommit,
  resolvePlaybackSnapshotPausedAtNow,
  resolvePlaybackSnapshotDurationMs,
  resolveTrackWaveformInitialStatus,
  resolveWaveformDataPlanScopedRequests,
  resolveWaveformHardwareHorizontalWheelDelta,
  resolveWaveformInitialViewportFrame,
  resolveWaveformPeakFromTileCache,
  resolveWaveformPlayheadCssVariables,
  resolveWaveformPointerAnchorViewportX,
  resolveWaveformMaximumRenderPixelsPerSecond,
  resolveWaveformPresentationSelection,
  resolveWaveformSelectionDragPreview,
  resolveWaveformSelectionGeometry,
  resolveWaveformSelectionMarkerLayout,
  resolveWaveformPlayheadDragPreview,
  resolveWaveformSessionFrame,
  resolveWaveformSessionViewportFrame,
  resolveWaveformTileLoadResultPolicy,
  resolveWaveformTileRequestStartPolicy,
  resolveWaveformTransaction,
  resolveWaveformViewportAudioSeconds,
  resolveWaveformViewportTransition,
  resolveWaveformWheelOperation,
  shouldAcceptWaveformHardwareHorizontalWheel,
  shouldPreventWaveformWheelDefault,
  WAVEFORM_CANVAS_HEIGHT,
  type PlaybackSnapshot,
  type TrackWaveformSummaryState,
  type WaveformCachedTile,
  type WaveformDataPlan,
  type WaveformDataPlanMode,
  type WaveformPlayheadDragInput,
  type WaveformRenderDataStore,
  type WaveformSelectionDragInput,
  type WaveformSelectionDragResolution,
  type WaveformSelectionEdge,
  type WaveformSelectionRange,
  type WaveformSessionViewportState,
  type WaveformStatus,
  type WaveformViewportModel,
  type WaveformZoomOwnership,
} from "./SpectrumVisualizer.model";

export {
  createWaveformRenderDataStore,
  normalizeWaveformPathKey,
  projectWaveformTrackIdentity,
  arePlaybackSnapshotsSamePlaybackSegment,
  resolveAnchoredWaveformScrollLeft,
  areWaveformSelectionsEqual,
  resolveCenteredWaveformScrollLeft,
  resolvePlaybackPositionMs,
  resolvePlaybackSnapshotAfterStatusCommit,
  resolvePlaybackSnapshotPausedAtNow,
  resolvePlaybackSnapshotDurationMs,
  resolveQuantizedWaveformDisplayPeak,
  resolveTrackWaveformInitialStatus,
  resolveWaveformContentWidth,
  resolveWaveformDataPlan,
  resolveWaveformDataPlanScopedRequests,
  resolveWaveformDataScopeKey as createWaveformDataScopeKey,
  createWaveformDataRequestKey,
  resolveWaveformDataTileIndexes,
  resolveWaveformDataWindow,
  resolveWaveformHardwareHorizontalWheelDelta,
  resolveWaveformHorizontalPanFrame,
  resolveWaveformHorizontalScrollLeft,
  resolveWaveformInitialViewportFrame,
  resolveWaveformInitialViewport,
  resolveWaveformMaximumPixelsPerSecond,
  resolveWaveformMaximumRenderPixelsPerSecond,
  resolveWaveformMinimumPixelsPerSecond,
  resolveWaveformPixelsPerSecond,
  resolveWaveformPlayheadCssVariables,
  resolveWaveformPlayheadDrag,
  resolveWaveformPlayheadDragPreview,
  resolveWaveformPresentationSelection,
  resolveWaveformPointerAnchorViewportX,
  resolveWaveformRenderPixelsPerSecond,
  resolveWaveformResizeViewportState,
  resolveWaveformSelectionDrag,
  resolveWaveformSelectionDragPreview,
  resolveWaveformSelectionGeometry,
  resolveWaveformSelectionMarkerLayout,
  resolveWaveformSessionFrame,
  resolveWaveformSessionViewportFrame,
  resolveWaveformSelectionStartScrollLeft,
  resolveWaveformTileAvailabilityPresentationPlan,
  resolveWaveformTileLoadResultPolicy,
  resolveWaveformTilePeakAtSeconds,
  resolveWaveformTilePeakRangeAtPixels,
  resolveWaveformTileRequestStartPolicy,
  resolveWaveformTransaction,
  resolveWaveformViewportAudioSeconds,
  resolveWaveformViewportModel,
  resolveWaveformWheelAxisDeltas,
  resolveWaveformWheelDeltas,
  resolveWaveformWheelIntent,
  resolveWaveformWheelOperation,
  resolveWaveformWheelPixelDeltas,
  resolveWaveformWheelPixelsPerSecond,
  shouldAcceptWaveformHardwareHorizontalWheel,
  shouldPreventWaveformWheelDefault,
} from "./SpectrumVisualizer.model";
export type {
  WaveformPlayheadDragResolution,
  WaveformRenderDataStore,
  WaveformSelectionDragResolution,
  WaveformSelectionGeometry,
  WaveformSelectionRange,
} from "./SpectrumVisualizer.model";

const PLAYBACK_STATUS_POLL_MS = 250;
const WAVEFORM_TILE_CACHE_LIMIT = 256;
const WAVEFORM_TILE_LOAD_CONCURRENCY = 2;
const WAVEFORM_CANVAS_COLOR = {
  dark: "#f5f5f5",
  light: "#262626",
} as const;
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

export function resolveWaveformCanvasColor(args: { prefersDarkColorScheme: boolean }) {
  return args.prefersDarkColorScheme ? WAVEFORM_CANVAS_COLOR.dark : WAVEFORM_CANVAS_COLOR.light;
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

export function resolveWaveformLoadingColorChannels(
  color: string,
): readonly [number, number, number] | null {
  const trimmedColor = color.trim();
  const hex = trimmedColor.match(/^#([\da-f]{3}|[\da-f]{6})$/i);

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

  if (!/^rgba?\(/i.test(trimmedColor)) {
    return null;
  }

  const colorComponents = trimmedColor.match(/-?\d*\.?\d+(?:e[+-]?\d+)?%?/gi);

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

export interface TrackSpectrumWaveformPort {
  getTrackWaveformTile: (
    filePath: string,
    start: number | null,
    end: number | null,
    pixelsPerSecond: number,
    tileStartPx: number,
    tileWidth: number,
  ) => Promise<import("@/src/cmd").TrackWaveformTile>;
  prepareTrackWaveform: (
    filePath: string,
    start: number | null,
    end: number | null,
  ) => Promise<import("@/src/cmd").TrackWaveformSummary>;
}

export interface TrackSpectrumPlaybackPort {
  beginPlaybackSeek: () => Promise<PlaybackStatusPayload | null>;
  cancelPlaybackSeek: () => Promise<PlaybackStatusPayload | null>;
  getPlaybackStatus: () => Promise<PlaybackStatusPayload | null>;
  seekPlayback: (positionMs: number, endMs: number) => Promise<PlaybackStatusPayload | null>;
}

export type TrackSpectrumPlaybackStatusCommit = (status: PlaybackStatusPayload | null) => void;
export type TrackSpectrumImmediatePlaybackPause = () => PlaybackStatusPayload | null;
export interface TrackSpectrumPlaybackControl {
  commitImmediatePause: TrackSpectrumImmediatePlaybackPause;
  commitPlaybackStatus: TrackSpectrumPlaybackStatusCommit;
}

export interface TrackSpectrumPorts {
  playback: TrackSpectrumPlaybackPort;
  waveform: TrackSpectrumWaveformPort;
}

type TrackSpectrumProps = {
  className?: string;
  filePath: string | null;
  onSelectionCommit?: (
    range: WaveformSelectionDragResolution,
    commitPlaybackStatus?: TrackSpectrumPlaybackStatusCommit,
  ) => void;
  onPlaybackControlReady?: (control: TrackSpectrumPlaybackControl | null) => void;
  playheadEnabled?: boolean;
  ports?: TrackSpectrumPorts;
  renderDataStore?: WaveformRenderDataStore;
  selection?: WaveformSelectionRange | null;
};

type WaveformTileAvailabilitySignal = {
  priority: string;
  requestCacheKey: string;
  scopeKey: string;
};

type WaveformDrawPlan = {
  dataPlan: WaveformDataPlan;
  tileCache: ReadonlyMap<string, WaveformCachedTile>;
  viewport: WaveformViewportModel;
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
  colorUniform: WebGLUniformLocation;
  gl: WebGLRenderingContext;
  gridUniform: WebGLUniformLocation;
  positionAttribute: number;
  program: WebGLProgram;
  resolutionUniform: WebGLUniformLocation;
  resizeObserver: ResizeObserver | null;
  startTimeMs: number;
  timeUniform: WebGLUniformLocation;
};

/**
 * Behavior:
 *   TrackSpectrum composes waveform viewport, data loading, canvas drawing,
 *   selection editing, and playback seeking without letting any one role own
 *   another role's invariants.
 *
 * Core invariants:
 *   - Track identity is the only key that resets the session.
 *   - Viewport state is normalized before data plans or overlays observe it.
 *   - Cache hit and cache miss do not define semantic validity; they only change
 *     drawing availability.
 *   - Async summary, tile, playback, and hardware-wheel results are accepted only
 *     when their explicit file/scope identity still matches the current session.
 *   - Canvas and DOM writes are effect interpretation; pure helpers define the
 *     stable coordinates and requests.
 */

const crabTrackSpectrumPorts: TrackSpectrumPorts = {
  playback: {
    beginPlaybackSeek: async () =>
      crab.beginPlaybackSeek().then((result) =>
        result.match({
          Err: (error) => {
            throw new Error(error);
          },
          Ok: (status) => status,
        }),
      ),
    cancelPlaybackSeek: async () =>
      crab.cancelPlaybackSeek().then((result) =>
        result.match({
          Err: (error) => {
            throw new Error(error);
          },
          Ok: (status) => status,
        }),
      ),
    getPlaybackStatus: async () =>
      crab.getPlaybackStatus().then((result) =>
        result.match({
          Err: (error) => {
            throw new Error(error);
          },
          Ok: (status) => status,
        }),
      ),
    seekPlayback: async (positionMs, endMs) =>
      crab.seekPlayback(positionMs, endMs).then((result) =>
        result.match({
          Err: (error) => {
            throw new Error(error);
          },
          Ok: (status) => status,
        }),
      ),
  },
  waveform: {
    getTrackWaveformTile: async (filePath, start, end, pixelsPerSecond, tileStartPx, tileWidth) =>
      crab
        .getTrackWaveformTile(filePath, start, end, pixelsPerSecond, tileStartPx, tileWidth)
        .then((result) =>
          result.match({
            Err: (error) => {
              throw new Error(error);
            },
            Ok: (tile) => tile,
          }),
        ),
    prepareTrackWaveform: async (filePath, start, end) =>
      crab.prepareTrackWaveform(filePath, start, end).then((result) =>
        result.match({
          Err: (error) => {
            throw new Error(error);
          },
          Ok: (summary) => summary,
        }),
      ),
  },
};

const defaultWaveformRenderDataStore = createWaveformRenderDataStore();
const waveformPortStores = new WeakMap<TrackSpectrumWaveformPort, WaveformRenderDataStore>();

function resolveWaveformRenderDataStore(args: {
  port: TrackSpectrumWaveformPort;
  provided?: WaveformRenderDataStore;
}) {
  if (args.provided) {
    return args.provided;
  }

  if (args.port === crabTrackSpectrumPorts.waveform) {
    return defaultWaveformRenderDataStore;
  }

  const existing = waveformPortStores.get(args.port);
  if (existing) {
    return existing;
  }

  const store = createWaveformRenderDataStore();
  waveformPortStores.set(args.port, store);
  return store;
}

export function createWaveformSharedTileCacheForFile(args: {
  filePath: string | null | undefined;
  store?: WaveformRenderDataStore;
}) {
  return createWaveformSharedTileCacheForStore({
    filePath: args.filePath,
    store: args.store ?? defaultWaveformRenderDataStore,
  });
}

export function resolveWaveformPlayheadStyle(args: {
  playbackStartMs: number | null;
  pixelsPerSecond: number;
  positionMs: number | null;
  scrollLeft: number;
  viewportWidth: number;
}) {
  const css = resolveWaveformPlayheadCssVariables(args);
  return {
    opacity: css.opacity,
    transform: css.x === "-9999px" ? "translate3d(-9999px, 0, 0)" : `translate3d(${css.x}, 0, 0)`,
  };
}

export function resolveWaveformPlayheadX(args: {
  playbackStartMs: number | null;
  pixelsPerSecond: number;
  positionMs: number | null;
  scrollLeft: number;
}) {
  const css = resolveWaveformPlayheadCssVariables({
    ...args,
    viewportWidth: Number.POSITIVE_INFINITY,
  });
  return css.x === "-9999px" ? null : Number.parseFloat(css.x);
}

export function resolveWaveformBarWidthPx() {
  return 1;
}

function isPlaybackStatusForTrack(status: PlaybackStatusPayload | null, filePath: string | null) {
  const track = projectWaveformTrackIdentity(filePath);
  const statusTrack = projectWaveformTrackIdentity(status?.path);
  return track.ok && statusTrack.ok && track.value.fileKey === statusTrack.value.fileKey;
}

function readPerformanceNow(ownerWindow: Window | null) {
  return ownerWindow?.performance.now() ?? Date.now();
}

function useTrackWaveformSummary(args: {
  filePath: string | null;
  placeholderSummary: import("@/src/cmd").TrackWaveformSummary;
  renderDataStore: WaveformRenderDataStore;
  waveformPort: TrackSpectrumWaveformPort;
}) {
  const [state, setState] = useState<TrackWaveformSummaryState>(() => ({
    status: resolveTrackWaveformInitialStatus(args.filePath),
    summary: args.placeholderSummary,
  }));

  useEffect(() => {
    const identity = projectWaveformTrackIdentity(args.filePath);
    if (!identity.ok) {
      setState({
        status: "idle",
        summary: args.placeholderSummary,
      });
      return undefined;
    }

    let cancelled = false;
    const cached = args.renderDataStore.summaries.get(identity.value.fileKey)?.state;
    setState(
      cached ?? {
        status: "loading",
        summary: args.placeholderSummary,
      },
    );

    const existing = args.renderDataStore.summaries.get(identity.value.fileKey);
    const promise =
      existing?.promise ??
      (existing?.state
        ? Promise.resolve(existing.state.summary)
        : args.waveformPort.prepareTrackWaveform(identity.value.filePath, null, null));

    if (!existing) {
      args.renderDataStore.summaries.set(identity.value.fileKey, {
        promise,
        state: null,
      });
    }

    void promise
      .then((summary) => {
        const readyState = {
          status: "ready" as const,
          summary,
        };
        args.renderDataStore.summaries.set(identity.value.fileKey, {
          promise: null,
          state: readyState,
        });
        if (!cancelled) {
          setState(readyState);
        }
      })
      .catch((error) => {
        args.renderDataStore.summaries.delete(identity.value.fileKey);
        if (!cancelled) {
          console.error("Failed to prepare track waveform", error);
          setState({
            status: "error",
            summary: args.placeholderSummary,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [args.filePath, args.placeholderSummary, args.renderDataStore, args.waveformPort]);

  return state;
}

export function resolveTrackSpectrumWaveformResourcePreloadPlans(args: {
  filePath: string | null;
  selections: readonly WaveformSelectionRange[];
  summary: import("@/src/cmd").TrackWaveformSummary;
  viewportWidth: number;
}) {
  const maximumPixelsPerSecond = resolveWaveformMaximumRenderPixelsPerSecond(args.summary);
  return args.selections.flatMap((selection) => {
    const initialViewport = resolveWaveformInitialViewportFrame({
      durationMs: args.summary.duration_ms,
      maximumPixelsPerSecond,
      selection,
      viewportWidth: args.viewportWidth,
    });
    const sessionFrame = resolveWaveformSessionFrame({
      filePath: args.filePath,
      playheadEnabled: false,
      summary: args.summary,
      viewport: initialViewport.viewport,
      waveformStatus: "ready",
    });

    return sessionFrame.dataPlan ? [sessionFrame.dataPlan] : [];
  });
}

function usePreloadTrackWaveformTiles(args: {
  filePath: string | null;
  renderDataStore: WaveformRenderDataStore;
  selections: readonly WaveformSelectionRange[];
  status: WaveformStatus;
  summary: import("@/src/cmd").TrackWaveformSummary;
  tileCache: Map<string, WaveformCachedTile>;
  viewportWidth: number;
  waveformPort: TrackSpectrumWaveformPort;
}) {
  useEffect(() => {
    const identity = projectWaveformTrackIdentity(args.filePath);
    if (!identity.ok || args.status !== "ready" || args.selections.length === 0) {
      return;
    }

    const plans = resolveTrackSpectrumWaveformResourcePreloadPlans({
      filePath: identity.value.filePath,
      selections: args.selections,
      summary: args.summary,
      viewportWidth: args.viewportWidth,
    });
    if (plans.length === 0) {
      return;
    }

    const protectedCacheKeys = plans.flatMap((plan) => plan.protectedCacheKeys);
    const requestsByKey = new Map<
      string,
      ReturnType<typeof resolveWaveformDataPlanScopedRequests>[number]
    >();
    plans.forEach((plan) => {
      resolveWaveformDataPlanScopedRequests(plan, "visible").forEach((request) => {
        if (!args.tileCache.has(request.cacheKey) && !requestsByKey.has(request.cacheKey)) {
          requestsByKey.set(request.cacheKey, request);
        }
      });
    });
    const requests = Array.from(requestsByKey.values());
    if (requests.length === 0) {
      return;
    }

    let cancelled = false;
    let activeCount = 0;
    let cursor = 0;
    const pump = () => {
      if (cancelled) {
        return;
      }

      while (activeCount < WAVEFORM_TILE_LOAD_CONCURRENCY && cursor < requests.length) {
        const request = requests[cursor];
        cursor += 1;
        activeCount += 1;
        const promise =
          args.renderDataStore.tilePromises.get(request.cacheKey) ??
          args.waveformPort.getTrackWaveformTile(
            identity.value.filePath,
            null,
            null,
            request.dataPixelsPerSecond,
            request.startPx,
            request.widthPx,
          );
        args.renderDataStore.tilePromises.set(request.cacheKey, promise);

        void promise
          .then((tile) => {
            if (cancelled) {
              return;
            }
            args.tileCache.set(request.cacheKey, {
              data: tile,
              dataPixelsPerSecond: request.dataPixelsPerSecond,
              requestKey: request.cacheKey,
              scopeKey: request.scopeKey,
            });
            pruneWaveformTileCache(args.tileCache, protectedCacheKeys);
          })
          .catch((error) => {
            if (!cancelled) {
              console.error("Failed to preload track waveform tile", error);
            }
          })
          .finally(() => {
            if (args.renderDataStore.tilePromises.get(request.cacheKey) === promise) {
              args.renderDataStore.tilePromises.delete(request.cacheKey);
            }
            activeCount -= 1;
            pump();
          });
      }
    };

    pump();

    return () => {
      cancelled = true;
    };
  }, [
    args.filePath,
    args.renderDataStore,
    args.selections,
    args.status,
    args.summary,
    args.tileCache,
    args.viewportWidth,
    args.waveformPort,
  ]);
}

export function TrackSpectrumWaveformResourceOwner(props: {
  filePath: string | null;
  ports?: TrackSpectrumPorts;
  renderDataStore?: WaveformRenderDataStore;
  selections?: readonly WaveformSelectionRange[];
  viewportWidth?: number;
}) {
  const ports = props.ports ?? crabTrackSpectrumPorts;
  const renderDataStore = resolveWaveformRenderDataStore({
    port: ports.waveform,
    provided: props.renderDataStore,
  });
  const placeholderSummary = useMemo(() => createPlaceholderWaveformSummary(), []);
  const waveformState = useTrackWaveformSummary({
    filePath: props.filePath,
    placeholderSummary,
    renderDataStore,
    waveformPort: ports.waveform,
  });
  const tileCache = useMemo(
    () =>
      createWaveformSharedTileCacheForStore({
        filePath: props.filePath,
        store: renderDataStore,
      }),
    [props.filePath, renderDataStore],
  );
  usePreloadTrackWaveformTiles({
    filePath: props.filePath,
    renderDataStore,
    selections: props.selections ?? [],
    status: waveformState.status,
    summary: waveformState.summary,
    tileCache,
    viewportWidth: props.viewportWidth ?? 1,
    waveformPort: ports.waveform,
  });

  return null;
}

function useElementWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(1);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return undefined;
    }

    const sync = () => {
      const rect = node.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.ceil(rect.width));
      setWidth((current) => (current === nextWidth ? current : nextWidth));
    };

    sync();
    const ResizeObserverCtor = node.ownerDocument.defaultView?.ResizeObserver;
    if (!ResizeObserverCtor) {
      node.ownerDocument.defaultView?.addEventListener("resize", sync);
      return () => {
        node.ownerDocument.defaultView?.removeEventListener("resize", sync);
      };
    }

    const observer = new ResizeObserverCtor(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

function useWaveformDataLoader(args: {
  filePath: string | null;
  onTileAvailable: (signal: WaveformTileAvailabilitySignal) => void;
  renderDataStore: WaveformRenderDataStore;
  status: WaveformStatus;
  tileCache: Map<string, WaveformCachedTile>;
  waveformPort: TrackSpectrumWaveformPort;
}) {
  const activeScopeKeyRef = useRef<string | null>(null);
  const presentationRequestKeysRef = useRef(new Set<string>());
  const latestArgsRef = useRef(args);
  latestArgsRef.current = args;

  return useCallback((plan: WaveformDataPlan | null, mode: WaveformDataPlanMode) => {
    const latest = latestArgsRef.current;
    const identity = projectWaveformTrackIdentity(latest.filePath);
    if (!identity.ok || latest.status !== "ready" || !plan) {
      return;
    }

    const scopedRequests = resolveWaveformDataPlanScopedRequests(
      plan,
      mode === "interactive" ? "visible" : "complete",
    );
    activeScopeKeyRef.current = plan.scopeKey;
    presentationRequestKeysRef.current = new Set(
      scopedRequests
        .filter((request) => request.priority === "visible" || request.priority === "visible-guard")
        .map((request) => request.cacheKey),
    );

    let activeCount = 0;
    let cursor = 0;
    const pump = () => {
      while (activeCount < WAVEFORM_TILE_LOAD_CONCURRENCY && cursor < scopedRequests.length) {
        const request = scopedRequests[cursor];
        cursor += 1;
        const startPolicy = resolveWaveformTileRequestStartPolicy({
          hasCachedTile: latest.tileCache.has(request.cacheKey),
        });
        if (!startPolicy.shouldLoad) {
          continue;
        }

        activeCount += 1;
        const promise =
          latest.renderDataStore.tilePromises.get(request.cacheKey) ??
          latest.waveformPort.getTrackWaveformTile(
            identity.value.filePath,
            null,
            null,
            request.dataPixelsPerSecond,
            request.startPx,
            request.widthPx,
          );
        latest.renderDataStore.tilePromises.set(request.cacheKey, promise);

        void promise
          .then((tile) => {
            const policy = resolveWaveformTileLoadResultPolicy({
              activeScopeKey: activeScopeKeyRef.current,
              presentationRequestKeys: presentationRequestKeysRef.current,
              requestCacheKey: request.cacheKey,
              requestScopeKey: request.scopeKey,
            });

            if (policy.shouldCache) {
              latest.tileCache.set(request.cacheKey, {
                data: tile,
                dataPixelsPerSecond: request.dataPixelsPerSecond,
                requestKey: request.cacheKey,
                scopeKey: request.scopeKey,
              });
              pruneWaveformTileCache(latest.tileCache, plan.protectedCacheKeys);
            }

            if (policy.shouldRequestPresentation) {
              latest.onTileAvailable({
                priority: request.priority,
                requestCacheKey: request.cacheKey,
                scopeKey: request.scopeKey,
              });
            }
          })
          .catch((error) => {
            console.error("Failed to load waveform tile", error);
          })
          .finally(() => {
            if (latest.renderDataStore.tilePromises.get(request.cacheKey) === promise) {
              latest.renderDataStore.tilePromises.delete(request.cacheKey);
            }
            activeCount -= 1;
            pump();
          });
      }
    };

    pump();
  }, []);
}

function pruneWaveformTileCache(
  cache: Map<string, WaveformCachedTile>,
  protectedKeys: readonly string[],
) {
  if (cache.size <= WAVEFORM_TILE_CACHE_LIMIT) {
    return;
  }

  const protectedSet = new Set(protectedKeys);
  for (const key of cache.keys()) {
    if (cache.size <= WAVEFORM_TILE_CACHE_LIMIT) {
      return;
    }
    if (!protectedSet.has(key)) {
      cache.delete(key);
    }
  }
}

function clearWaveformCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawWaveformCanvas(args: {
  canvas: HTMLCanvasElement;
  color: string;
  plan: WaveformDrawPlan;
}) {
  const canvas = args.canvas;
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const ownerWindow = canvas.ownerDocument.defaultView;
  const devicePixelRatio = Math.max(1, ownerWindow?.devicePixelRatio ?? 1);
  const viewportWidth = Math.max(1, args.plan.viewport.viewportWidth);
  const backingWidth = Math.max(1, Math.ceil(viewportWidth * devicePixelRatio));
  const backingHeight = Math.max(1, Math.ceil(WAVEFORM_CANVAS_HEIGHT * devicePixelRatio));
  if (canvas.width !== backingWidth) {
    canvas.width = backingWidth;
  }
  if (canvas.height !== backingHeight) {
    canvas.height = backingHeight;
  }

  canvas.style.width = `${viewportWidth}px`;
  canvas.style.height = `${WAVEFORM_CANVAS_HEIGHT}px`;
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, viewportWidth, WAVEFORM_CANVAS_HEIGHT);
  context.fillStyle = args.color;
  context.globalAlpha = 0.88;

  const centerY = WAVEFORM_CANVAS_HEIGHT / 2;
  const amplitude = WAVEFORM_CANVAS_HEIGHT / 2 - 18;
  for (let x = 0; x < viewportWidth; x += 1) {
    const startSeconds = resolveWaveformViewportAudioSeconds({
      pixelsPerSecond: args.plan.viewport.pixelsPerSecond,
      scrollLeft: args.plan.viewport.scrollLeft,
      viewportX: x,
    });
    const endSeconds = resolveWaveformViewportAudioSeconds({
      pixelsPerSecond: args.plan.viewport.pixelsPerSecond,
      scrollLeft: args.plan.viewport.scrollLeft,
      viewportX: x + 1,
    });
    const durationSeconds = Math.max(0, args.plan.viewport.durationMs / 1000);
    const peak =
      endSeconds <= 0 || startSeconds >= durationSeconds
        ? {
            max: 0,
            min: 0,
          }
        : resolveWaveformPeakFromTileCache({
            cache: args.plan.tileCache,
            endSeconds: Math.min(durationSeconds, endSeconds),
            plan: args.plan.dataPlan,
            startSeconds: Math.max(0, startSeconds),
          });

    if (!peak) {
      continue;
    }

    const top = centerY - peak.max * amplitude;
    const bottom = centerY - peak.min * amplitude;
    context.fillRect(x, top, resolveWaveformBarWidthPx(), Math.max(1, bottom - top));
  }

  context.globalAlpha = 1;
}

function useWaveformCanvas(args: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  color: string;
  dataPlan: WaveformDataPlan | null;
  status: WaveformStatus;
  tileCache: Map<string, WaveformCachedTile>;
  tileRevision: number;
  viewport: WaveformViewportModel;
}) {
  useLayoutEffect(() => {
    const canvas = args.canvasRef.current;
    if (!canvas || !args.dataPlan || args.status !== "ready") {
      if (canvas) {
        clearWaveformCanvas(canvas);
      }
      return;
    }

    drawWaveformCanvas({
      canvas,
      color: args.color,
      plan: {
        dataPlan: args.dataPlan,
        tileCache: args.tileCache,
        viewport: args.viewport,
      },
    });
  }, [
    args.canvasRef,
    args.color,
    args.dataPlan,
    args.status,
    args.tileCache,
    args.tileRevision,
    args.viewport,
  ]);
}

function useWaveformLoadingRenderer(args: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  color: string;
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

    renderer.startTimeMs = readPerformanceNow(ownerWindow);

    const render = () => {
      const latest = latestArgsRef.current;
      const currentCanvas = latest.canvasRef.current;
      if (!latest.visible || !currentCanvas) {
        stopWaveformLoadingRenderer(renderer);
        return;
      }

      drawWaveformLoadingRenderer({
        canvas: currentCanvas,
        color: latest.color,
        gridSize: latest.gridSize,
        nowMs: readPerformanceNow(ownerWindow),
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

function usePlaybackController(args: {
  enabled: boolean;
  filePath: string | null;
  hostRef: RefObject<HTMLDivElement | null>;
  playbackPort: TrackSpectrumPlaybackPort;
  selectionRef: RefObject<WaveformSelectionRange | null>;
  summaryDurationMs: number;
  viewport: WaveformViewportModel;
}) {
  const latestArgsRef = useRef(args);
  latestArgsRef.current = args;
  const dragPreviewInputRef = useRef<WaveformPlayheadDragInput | null>(null);
  const snapshotRef = useRef<PlaybackSnapshot | null>(null);
  const localPlaybackSnapshotRef = useRef<PlaybackSnapshot | null>(null);
  const frameIdRef = useRef<number | null>(null);
  const beginSeekPromiseRef = useRef<Promise<boolean> | null>(null);

  const syncPlayhead = useCallback((nowMs?: number) => {
    const latest = latestArgsRef.current;
    const host = latest.hostRef.current;
    if (!host || !latest.enabled) {
      return;
    }

    const ownerWindow = host.ownerDocument.defaultView;
    const snapshot = snapshotRef.current;
    const dragPreview = resolveWaveformPlayheadDragPreview({
      input: dragPreviewInputRef.current,
      viewport: latest.viewport,
    });
    const positionMs =
      dragPreview?.positionMs ??
      resolvePlaybackPositionMs({
        durationMs: resolvePlaybackSnapshotDurationMs({
          fallbackDurationMs: latest.summaryDurationMs,
          snapshot,
        }),
        nowMs: nowMs ?? readPerformanceNow(ownerWindow),
        snapshot,
      });
    const playbackStartMs =
      dragPreview !== null ? 0 : positionMs === null ? null : (snapshot?.playback_start_ms ?? null);
    const css = resolveWaveformPlayheadCssVariables({
      playbackStartMs,
      pixelsPerSecond: latest.viewport.pixelsPerSecond,
      positionMs,
      scrollLeft: latest.viewport.scrollLeft,
      viewportWidth: latest.viewport.viewportWidth,
    });
    host.style.setProperty("--waveform-playhead-opacity", css.opacity);
    host.style.setProperty("--waveform-playhead-x", css.x);
  }, []);

  const stopAnimation = useCallback(() => {
    const ownerWindow = latestArgsRef.current.hostRef.current?.ownerDocument.defaultView;
    if (frameIdRef.current !== null) {
      ownerWindow?.cancelAnimationFrame(frameIdRef.current);
      frameIdRef.current = null;
    }
  }, []);

  const startAnimation = useCallback(() => {
    const ownerWindow = latestArgsRef.current.hostRef.current?.ownerDocument.defaultView;
    if (!ownerWindow || frameIdRef.current !== null) {
      return;
    }

    const tick = (frameTime: number) => {
      const snapshot = snapshotRef.current;
      if (!snapshot?.playing || snapshot.paused || dragPreviewInputRef.current !== null) {
        frameIdRef.current = null;
        return;
      }

      syncPlayhead(frameTime);
      frameIdRef.current = ownerWindow.requestAnimationFrame(tick);
    };
    frameIdRef.current = ownerWindow.requestAnimationFrame(tick);
  }, [syncPlayhead]);

  const commitPlaybackStatus = useCallback(
    (status: PlaybackStatusPayload | null) => {
      const latest = latestArgsRef.current;
      const ownerWindow = latest.hostRef.current?.ownerDocument.defaultView ?? null;
      if (!latest.enabled || !isPlaybackStatusForTrack(status, latest.filePath)) {
        snapshotRef.current = null;
        localPlaybackSnapshotRef.current = null;
        stopAnimation();
        syncPlayhead();
        return;
      }

      const nextSnapshot = {
        ...status!,
        received_at_ms: readPerformanceNow(ownerWindow),
      };
      const committedSnapshot = resolvePlaybackSnapshotAfterStatusCommit({
        localPlaybackSnapshot: localPlaybackSnapshotRef.current,
        nextSnapshot,
      });
      snapshotRef.current = committedSnapshot;
      if (
        localPlaybackSnapshotRef.current !== null &&
        !arePlaybackSnapshotsSamePlaybackSegment(localPlaybackSnapshotRef.current, nextSnapshot)
      ) {
        localPlaybackSnapshotRef.current = null;
      }
      if (committedSnapshot === null) {
        stopAnimation();
        syncPlayhead();
        return;
      }
      syncPlayhead();
      if (committedSnapshot.playing && !committedSnapshot.paused) {
        startAnimation();
      } else {
        stopAnimation();
      }
    },
    [startAnimation, stopAnimation, syncPlayhead],
  );

  const commitImmediatePause = useCallback(() => {
    const latest = latestArgsRef.current;
    const ownerWindow = latest.hostRef.current?.ownerDocument.defaultView ?? null;
    const snapshot = resolvePlaybackSnapshotPausedAtNow({
      durationMs: resolvePlaybackSnapshotDurationMs({
        fallbackDurationMs: latest.summaryDurationMs,
        snapshot: snapshotRef.current,
      }),
      nowMs: readPerformanceNow(ownerWindow),
      snapshot: snapshotRef.current,
    });
    if (!snapshot || snapshotRef.current === snapshot) {
      return snapshot;
    }

    snapshotRef.current = snapshot;
    localPlaybackSnapshotRef.current = snapshot;
    syncPlayhead(snapshot.received_at_ms);
    stopAnimation();
    return snapshot;
  }, [stopAnimation, syncPlayhead]);

  useEffect(() => {
    if (!args.enabled) {
      commitPlaybackStatus(null);
      return undefined;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const status = await args.playbackPort.getPlaybackStatus();
        if (!cancelled) {
          commitPlaybackStatus(status);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to refresh waveform playback status", error);
          commitPlaybackStatus(null);
        }
      }
    };

    void poll();
    const ownerWindow = args.hostRef.current?.ownerDocument.defaultView ?? window;
    const intervalId = ownerWindow.setInterval(poll, PLAYBACK_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      ownerWindow.clearInterval(intervalId);
      stopAnimation();
      snapshotRef.current = null;
      localPlaybackSnapshotRef.current = null;
    };
  }, [
    args.enabled,
    args.filePath,
    args.hostRef,
    args.playbackPort,
    commitPlaybackStatus,
    stopAnimation,
  ]);

  useLayoutEffect(() => {
    syncPlayhead();
  }, [args.viewport, syncPlayhead]);

  const previewDrag = useCallback(
    (input: WaveformPlayheadDragInput | null) => {
      dragPreviewInputRef.current = input;
      syncPlayhead();
    },
    [syncPlayhead],
  );

  const beginDrag = useCallback(() => {
    const promise = latestArgsRef.current.playbackPort
      .beginPlaybackSeek()
      .then((status) => {
        if (beginSeekPromiseRef.current !== promise) {
          return true;
        }
        commitPlaybackStatus(status);
        return true;
      })
      .catch((error) => {
        console.error("Failed to begin waveform playback seek", error);
        return false;
      });
    beginSeekPromiseRef.current = promise;
  }, [commitPlaybackStatus]);

  const cancelDrag = useCallback(() => {
    const beginPromise = beginSeekPromiseRef.current;
    beginSeekPromiseRef.current = null;
    dragPreviewInputRef.current = null;
    syncPlayhead();
    void (beginPromise ?? Promise.resolve(true))
      .then((didBegin) =>
        didBegin ? latestArgsRef.current.playbackPort.cancelPlaybackSeek() : Promise.resolve(null),
      )
      .then(commitPlaybackStatus)
      .catch((error) => {
        console.error("Failed to cancel waveform playback seek", error);
      });
  }, [commitPlaybackStatus, syncPlayhead]);

  const commitDrag = useCallback(
    async (input: WaveformPlayheadDragInput) => {
      const beginPromise = beginSeekPromiseRef.current;
      beginSeekPromiseRef.current = null;
      const resolution = resolveWaveformPlayheadDragPreview({
        input,
        viewport: latestArgsRef.current.viewport,
      });
      if (!resolution) {
        dragPreviewInputRef.current = null;
        syncPlayhead();
        const didBegin = beginPromise ? await beginPromise : true;
        if (didBegin) {
          const status = await latestArgsRef.current.playbackPort.cancelPlaybackSeek();
          commitPlaybackStatus(status);
        }
        return;
      }

      const didBegin = beginPromise ? await beginPromise : true;
      if (!didBegin) {
        dragPreviewInputRef.current = null;
        syncPlayhead();
        return;
      }

      const status = await latestArgsRef.current.playbackPort.seekPlayback(
        resolution.positionMs,
        resolution.endMs,
      );
      dragPreviewInputRef.current = null;
      localPlaybackSnapshotRef.current = null;
      commitPlaybackStatus(status);
    },
    [commitPlaybackStatus, syncPlayhead],
  );

  return {
    beginDrag,
    cancelDrag,
    commitDrag,
    commitImmediatePause,
    commitPlaybackStatus,
    previewDrag,
  };
}

export function TrackSpectrum(props: TrackSpectrumProps) {
  const identity = projectWaveformTrackIdentity(props.filePath);
  return <TrackSpectrumSession key={identity.ok ? identity.value.fileKey : "empty"} {...props} />;
}

function TrackSpectrumSession(props: TrackSpectrumProps) {
  const ports = props.ports ?? crabTrackSpectrumPorts;
  const renderDataStore = resolveWaveformRenderDataStore({
    port: ports.waveform,
    provided: props.renderDataStore,
  });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const prefersDarkColorScheme = usePrefersDarkColorScheme();
  const waveformCanvasColor = resolveWaveformCanvasColor({ prefersDarkColorScheme });
  const placeholderSummary = useMemo(() => createPlaceholderWaveformSummary(), []);
  const waveformState = useTrackWaveformSummary({
    filePath: props.filePath,
    placeholderSummary,
    renderDataStore,
    waveformPort: ports.waveform,
  });
  const maximumPixelsPerSecond = resolveWaveformMaximumRenderPixelsPerSecond(waveformState.summary);
  const initialViewportSelectionRef = useRef<WaveformSelectionRange | null>(
    props.selection ?? null,
  );
  const [sessionViewport, setSessionViewport] = useState<WaveformSessionViewportState>(() => {
    const frame = resolveWaveformInitialViewportFrame({
      durationMs: waveformState.summary.duration_ms,
      maximumPixelsPerSecond,
      selection: props.selection ?? null,
      viewportWidth: 1,
    });

    return {
      initialReadyViewportResolved: false,
      userOwned: false,
      viewport: frame.viewport,
      zoomOwnership: "initial-minimum",
    };
  });
  const viewport = sessionViewport.viewport;
  const updateViewportWithOwnership = useCallback(
    (args: {
      resolve: (current: WaveformViewportModel) => WaveformViewportModel;
      zoomOwnership?: WaveformZoomOwnership;
    }) => {
      setSessionViewport((current) => {
        const viewport = args.resolve(current.viewport);
        const zoomOwnership = args.zoomOwnership ?? current.zoomOwnership;
        if (
          current.userOwned &&
          current.zoomOwnership === zoomOwnership &&
          viewport === current.viewport
        ) {
          return current;
        }

        const next = {
          ...current,
          userOwned: true,
          viewport,
          zoomOwnership,
        };
        return next;
      });
    },
    [],
  );
  const elementWidth = useElementWidth(hostRef);
  const [tileRevision, setTileRevision] = useState(0);
  const tileCache = useMemo(
    () =>
      createWaveformSharedTileCacheForStore({
        filePath: props.filePath,
        store: renderDataStore,
      }),
    [props.filePath, renderDataStore],
  );
  const sessionFrame = useMemo(
    () =>
      resolveWaveformSessionFrame({
        filePath: props.filePath,
        playheadEnabled: props.playheadEnabled === true,
        summary: waveformState.summary,
        viewport,
        waveformStatus: waveformState.status,
      }),
    [props.filePath, props.playheadEnabled, viewport, waveformState.status, waveformState.summary],
  );
  const dataPlan = sessionFrame.dataPlan;
  const loadingGridSize = useMemo(
    () =>
      resolveWaveformLoadingGridSize({
        height: WAVEFORM_CANVAS_HEIGHT,
        width: viewport.viewportWidth,
      }),
    [viewport.viewportWidth],
  );
  const selectionRef = useRef<WaveformSelectionRange | null>(props.selection ?? null);
  const isDraggingSelectionRef = useRef(false);
  const onSelectionCommitRef = useRef(props.onSelectionCommit);
  onSelectionCommitRef.current = props.onSelectionCommit;

  const playback = usePlaybackController({
    enabled: props.playheadEnabled === true,
    filePath: props.filePath,
    hostRef,
    playbackPort: ports.playback,
    selectionRef,
    summaryDurationMs: waveformState.summary.duration_ms,
    viewport,
  });
  const onPlaybackControlReady = props.onPlaybackControlReady;
  const playheadEnabled = props.playheadEnabled === true;

  useLayoutEffect(() => {
    onPlaybackControlReady?.(
      playheadEnabled
        ? {
            commitImmediatePause: playback.commitImmediatePause,
            commitPlaybackStatus: playback.commitPlaybackStatus,
          }
        : null,
    );

    return () => {
      onPlaybackControlReady?.(null);
    };
  }, [
    onPlaybackControlReady,
    playback.commitImmediatePause,
    playback.commitPlaybackStatus,
    playheadEnabled,
  ]);

  const requestDataPlan = useWaveformDataLoader({
    filePath: props.filePath,
    onTileAvailable: (signal) => {
      const presentationFrame = resolveWaveformSessionFrame({
        filePath: props.filePath,
        playheadEnabled: props.playheadEnabled === true,
        summary: waveformState.summary,
        tileAvailabilitySignal: signal,
        viewport,
        waveformStatus: waveformState.status,
      });
      if (presentationFrame.dataPlan) {
        setTileRevision((revision) => revision + 1);
      }
    },
    renderDataStore,
    status: waveformState.status,
    tileCache,
    waveformPort: ports.waveform,
  });

  useLayoutEffect(() => {
    setSessionViewport((current) => {
      const next = resolveWaveformSessionViewportFrame({
        elementWidth,
        initialSelection: initialViewportSelectionRef.current,
        maximumPixelsPerSecond,
        state: current,
        summary: waveformState.summary,
        waveformStatus: waveformState.status,
      });
      return next;
    });
  }, [elementWidth, maximumPixelsPerSecond, waveformState.status, waveformState.summary]);

  useEffect(() => {
    if (!dataPlan) {
      return;
    }

    const resolution = resolveWaveformTransaction({
      lastInteractiveDataDemand: null,
      mode: "settled",
      now: readPerformanceNow(hostRef.current?.ownerDocument.defaultView ?? null),
      plan: dataPlan,
    });
    if (!resolution.transaction.dataDemand.skipped) {
      requestDataPlan(resolution.transaction.dataDemand.plan, "settled");
    }
  }, [dataPlan, requestDataPlan]);

  useWaveformCanvas({
    canvasRef,
    color: waveformCanvasColor,
    dataPlan,
    status: waveformState.status,
    tileCache,
    tileRevision,
    viewport,
  });
  useWaveformLoadingRenderer({
    canvasRef: loadingCanvasRef,
    color: waveformCanvasColor,
    gridSize: loadingGridSize,
    visible: sessionFrame.isLoading,
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    const handleWheel = (event: WheelEvent) => {
      const intent = resolveWaveformWheelOperation({
        deltaMode: event.deltaMode,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        shiftKey: event.shiftKey,
        viewportHeight: WAVEFORM_CANVAS_HEIGHT,
        viewportWidth: viewport.viewportWidth,
      });
      if (!shouldPreventWaveformWheelDefault(intent)) {
        return;
      }

      event.preventDefault();
      if (intent.kind === "zoom") {
        const anchorViewportX = resolveWaveformPointerAnchorViewportX({
          clientX: event.clientX,
          viewportLeft: host.getBoundingClientRect().left,
          viewportWidth: viewport.viewportWidth,
        });
        updateViewportWithOwnership({
          resolve: (current) =>
            resolveWaveformViewportTransition({
              command: {
                anchorViewportX,
                deltaY: intent.deltaY,
                kind: "zoom",
              },
              current,
            }).viewport,
          zoomOwnership: "explicit",
        });
        return;
      }

      updateViewportWithOwnership({
        resolve: (current) =>
          resolveWaveformViewportTransition({
            command: {
              deltaX: intent.deltaX,
              kind: "pan",
            },
            current,
          }).viewport,
      });
    };

    host.addEventListener("wheel", handleWheel, {
      passive: false,
    });
    return () => host.removeEventListener("wheel", handleWheel);
  }, [updateViewportWithOwnership, viewport]);

  useEffect(() => {
    let disposed = false;

    let unlisten: (() => void) | null = null;
    void crab
      .evt("hardwareHorizontalWheelEvent")((payload: HardwareHorizontalWheelEvent) => {
        if (disposed) {
          return;
        }

        const host = hostRef.current;
        if (
          !shouldAcceptWaveformHardwareHorizontalWheel({
            clientX: payload.client_x,
            clientY: payload.client_y,
            host,
          })
        ) {
          return;
        }

        const deltaX = resolveWaveformHardwareHorizontalWheelDelta({
          deltaX: payload.delta_x,
        });
        if (deltaX === 0) {
          return;
        }

        updateViewportWithOwnership({
          resolve: (current) =>
            resolveWaveformViewportTransition({
              command: {
                deltaX,
                kind: "pan",
              },
              current,
            }).viewport,
        });
      })
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [updateViewportWithOwnership]);

  useLayoutEffect(() => {
    if (isDraggingSelectionRef.current) {
      return;
    }
    selectionRef.current = props.selection ?? null;
  }, [props.selection]);

  const commitSelection = useCallback(
    (selection: WaveformSelectionDragResolution) => {
      selectionRef.current = selection;
      onSelectionCommitRef.current?.(
        selection,
        props.playheadEnabled === true ? playback.commitPlaybackStatus : undefined,
      );
    },
    [playback.commitPlaybackStatus, props.playheadEnabled],
  );

  const isLoading = sessionFrame.isLoading;

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
      style={
        {
          "--waveform-selection-opacity": isLoading ? 0 : undefined,
          "--waveform-playhead-opacity": 0,
          "--waveform-playhead-x": "-9999px",
        } as CSSProperties
      }
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1] h-full w-full text-inherit"
      />
      {isLoading ? (
        <canvas
          ref={loadingCanvasRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[2] h-full w-full text-inherit"
        />
      ) : null}
      <WaveformSelectionOverlay
        committedSelection={props.selection ?? null}
        onCommit={commitSelection}
        isDraggingRef={isDraggingSelectionRef}
        selectionRef={selectionRef}
        viewport={viewport}
        visible={sessionFrame.selectionVisible}
      />
      {sessionFrame.playheadVisible ? (
        <WaveformPlayheadOverlay
          playback={playback}
          selectionRef={selectionRef}
          viewport={viewport}
        />
      ) : null}
    </motion.div>
  );
}

function WaveformSelectionOverlay(args: {
  committedSelection: WaveformSelectionRange | null;
  isDraggingRef: MutableRefObject<boolean>;
  onCommit: (selection: WaveformSelectionDragResolution) => void;
  selectionRef: MutableRefObject<WaveformSelectionRange | null>;
  viewport: WaveformViewportModel;
  visible: boolean;
}) {
  const [dragInput, setDragInput] = useState<WaveformSelectionDragInput | null>(null);
  const dragInputRef = useRef<WaveformSelectionDragInput | null>(null);
  const preview = resolveWaveformSelectionDragPreview({
    input: dragInput,
    viewport: args.viewport,
  });
  const activeSelection = resolveWaveformPresentationSelection({
    committedSelection: args.committedSelection,
    interactiveSelection: args.selectionRef.current,
    isDragging: args.isDraggingRef.current,
    previewSelection: preview,
  });
  const geometry = resolveWaveformSelectionGeometry({
    selection: activeSelection,
    viewport: args.viewport,
  });

  const beginDrag = useCallback(
    (edge: WaveformSelectionEdge, event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      args.isDraggingRef.current = true;
      const hostRect = event.currentTarget.parentElement?.getBoundingClientRect();
      if (!hostRect) {
        return;
      }
      const input: WaveformSelectionDragInput = {
        edge,
        hostRect,
        pointerClientX: event.clientX,
        selection: args.selectionRef.current,
      };
      const next = resolveWaveformSelectionDragPreview({
        input,
        viewport: args.viewport,
      });
      args.selectionRef.current = next;
      dragInputRef.current = input;
      setDragInput(input);
    },
    [args],
  );

  const continueDrag = useCallback(
    (edge: WaveformSelectionEdge, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        return;
      }
      const hostRect = event.currentTarget.parentElement?.getBoundingClientRect();
      if (!hostRect) {
        return;
      }
      const selection = dragInputRef.current?.selection ?? args.selectionRef.current;
      const input: WaveformSelectionDragInput = {
        edge,
        hostRect,
        pointerClientX: event.clientX,
        selection,
      };
      const next = resolveWaveformSelectionDragPreview({
        input,
        viewport: args.viewport,
      });
      args.selectionRef.current = next;
      dragInputRef.current = input;
      setDragInput(input);
    },
    [args],
  );

  const commitDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      args.isDraggingRef.current = false;
      const committed =
        resolveWaveformSelectionDragPreview({
          input: dragInputRef.current,
          viewport: args.viewport,
        }) ?? args.selectionRef.current;
      args.selectionRef.current = committed;
      dragInputRef.current = null;
      setDragInput(null);
      if (committed) {
        args.onCommit(committed);
      }
    },
    [args, dragInput],
  );

  const cancelDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      args.isDraggingRef.current = false;
      dragInputRef.current = null;
      setDragInput(null);
    },
    [args],
  );

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[3]"
      style={{
        opacity: args.visible && geometry.isComplete ? 1 : 0,
      }}
    >
      <div
        aria-hidden
        className="absolute inset-y-0 bg-[#f5f5f5]/58 dark:bg-[#050505]/58"
        style={{ left: 0, width: Math.max(0, geometry.startX) }}
      />
      <div
        aria-hidden
        className="absolute inset-y-0 right-0 bg-[#f5f5f5]/58 dark:bg-[#050505]/58"
        style={{ left: Math.max(0, geometry.endX) }}
      />
      <WaveformSelectionHandle
        edge="start"
        x={geometry.startX}
        onPointerCancel={cancelDrag}
        onPointerDown={beginDrag}
        onPointerMove={continueDrag}
        onPointerUp={commitDrag}
      />
      <WaveformSelectionHandle
        edge="end"
        x={geometry.endX}
        onPointerCancel={cancelDrag}
        onPointerDown={beginDrag}
        onPointerMove={continueDrag}
        onPointerUp={commitDrag}
      />
    </div>
  );
}

function WaveformSelectionHandle(args: {
  edge: WaveformSelectionEdge;
  x: number;
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerDown: (edge: WaveformSelectionEdge, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (edge: WaveformSelectionEdge, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  const marker = resolveWaveformSelectionMarkerLayout({
    devicePixelRatio,
    x: args.x,
  });

  return (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 block bg-[#d4d4d4] dark:bg-[#373737]"
        style={{
          left: marker.visualLineLeftX,
          width: marker.visualLineWidth,
        }}
      />
      <button
        type="button"
        aria-label={args.edge === "start" ? "Adjust start" : "Adjust end"}
        className="pointer-events-auto absolute inset-y-0 w-5 cursor-ew-resize touch-none bg-transparent p-0 focus:outline-none"
        style={{ left: marker.handleCenterX, transform: "translateX(-50%)" }}
        onPointerCancel={args.onPointerCancel}
        onPointerDown={(event) => args.onPointerDown(args.edge, event)}
        onPointerMove={(event) => args.onPointerMove(args.edge, event)}
        onPointerUp={args.onPointerUp}
      />
    </>
  );
}

function WaveformPlayheadOverlay(args: {
  playback: ReturnType<typeof usePlaybackController>;
  selectionRef: MutableRefObject<WaveformSelectionRange | null>;
  viewport: WaveformViewportModel;
}) {
  const dragInputRef = useRef<WaveformPlayheadDragInput | null>(null);

  const resolveDragInput = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const hostRect = event.currentTarget.parentElement?.getBoundingClientRect();
      if (!hostRect) {
        return null;
      }

      const input: WaveformPlayheadDragInput = {
        hostRect,
        pointerClientX: event.clientX,
        selection: args.selectionRef.current,
      };
      return resolveWaveformPlayheadDragPreview({
        input,
        viewport: args.viewport,
      }) === null
        ? null
        : input;
    },
    [args.selectionRef, args.viewport],
  );

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-[4] w-0.5 bg-[#404040] dark:bg-[#a3a3a3]"
        style={{
          opacity: "var(--waveform-playhead-opacity, 0)",
          transform: "translate3d(calc(var(--waveform-playhead-x, -9999px) - 1px), 0, 0)",
        }}
      />
      <button
        type="button"
        aria-label="Adjust playback position"
        className="absolute inset-y-0 left-0 z-[5] w-7 -translate-x-1/2 cursor-ew-resize touch-none border-0 bg-transparent p-0 focus:outline-none"
        style={{
          opacity: "var(--waveform-playhead-opacity, 0)",
          transform: "translate3d(var(--waveform-playhead-x, -9999px), 0, 0)",
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          dragInputRef.current = null;
          args.playback.cancelDrag();
        }}
        onPointerDown={(event) => {
          const input = resolveDragInput(event);
          if (!input) {
            return;
          }
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragInputRef.current = input;
          args.playback.previewDrag(input);
          args.playback.beginDrag();
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
            return;
          }
          const input = resolveDragInput(event);
          if (!input) {
            return;
          }
          dragInputRef.current = input;
          args.playback.previewDrag(input);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          const input = dragInputRef.current;
          dragInputRef.current = null;
          if (!input) {
            args.playback.cancelDrag();
            return;
          }
          void args.playback.commitDrag(input).catch((error) => {
            console.error("Failed to commit waveform playback seek", error);
            args.playback.cancelDrag();
          });
        }}
      />
    </>
  );
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

  const renderer: WaveformLoadingRenderer = {
    animationFrameId: null,
    animationOwnerWindow: null,
    backingHeight: null,
    backingWidth: null,
    buffer,
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
  color: string;
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

  const color = resolveWaveformLoadingColorChannels(args.color);
  if (!color) {
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
  gl.uniform3f(renderer.colorUniform, color[0], color[1], color[2]);
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
