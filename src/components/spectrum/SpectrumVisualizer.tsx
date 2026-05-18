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
  resolveWaveformPlayheadDrag,
  resolveWaveformPointerAnchorViewportX,
  resolveWaveformRenderPixelsPerSecond,
  resolveWaveformPresentationSelection,
  resolveWaveformSelectionDrag,
  resolveWaveformSelectionGeometry,
  resolveWaveformSelectionMarkerLayout,
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
  type WaveformPlayheadDragResolution,
  type WaveformRenderDataStore,
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
  resolveWaveformMinimumPixelsPerSecond,
  resolveWaveformPixelsPerSecond,
  resolveWaveformPlayheadCssVariables,
  resolveWaveformPlayheadDrag,
  resolveWaveformPresentationSelection,
  resolveWaveformPointerAnchorViewportX,
  resolveWaveformRenderPixelsPerSecond,
  resolveWaveformResizeViewportState,
  resolveWaveformSelectionDrag,
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

export function resolveWaveformCanvasColor(args: { prefersDarkColorScheme: boolean }) {
  return args.prefersDarkColorScheme ? WAVEFORM_CANVAS_COLOR.dark : WAVEFORM_CANVAS_COLOR.light;
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
  status: WaveformStatus;
  tileCache: ReadonlyMap<string, WaveformCachedTile>;
  viewport: WaveformViewportModel;
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
        status: args.status,
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
  const dragPreviewRef = useRef<WaveformPlayheadDragResolution | null>(null);
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
    const dragPreview = dragPreviewRef.current;
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
      if (!snapshot?.playing || snapshot.paused || dragPreviewRef.current !== null) {
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
    (resolution: WaveformPlayheadDragResolution | null) => {
      dragPreviewRef.current = resolution;
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
    dragPreviewRef.current = null;
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
    async (resolution: WaveformPlayheadDragResolution) => {
      const beginPromise = beginSeekPromiseRef.current;
      beginSeekPromiseRef.current = null;
      const didBegin = beginPromise ? await beginPromise : true;
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
  const prefersDarkColorScheme = usePrefersDarkColorScheme();
  const waveformCanvasColor = resolveWaveformCanvasColor({ prefersDarkColorScheme });
  const placeholderSummary = useMemo(() => createPlaceholderWaveformSummary(), []);
  const waveformState = useTrackWaveformSummary({
    filePath: props.filePath,
    placeholderSummary,
    renderDataStore,
    waveformPort: ports.waveform,
  });
  const maximumPixelsPerSecond = resolveWaveformRenderPixelsPerSecond({
    summary: waveformState.summary,
  });
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
      {isLoading ? <WaveformLoadingOverlay /> : null}
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

function WaveformLoadingOverlay() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[2] opacity-60"
      style={{
        backgroundImage:
          "radial-gradient(currentColor 1px, transparent 1.6px), radial-gradient(currentColor 1px, transparent 1.6px)",
        backgroundPosition: "0 0, 6px 6px",
        backgroundSize: "12px 12px",
      }}
    />
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
  const [preview, setPreview] = useState<WaveformSelectionRange | null>(null);
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
      const next = resolveWaveformSelectionDrag({
        edge,
        hostRect,
        pointerClientX: event.clientX,
        selection: args.selectionRef.current,
        viewport: args.viewport,
      });
      args.selectionRef.current = next;
      setPreview(next);
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
      const next = resolveWaveformSelectionDrag({
        edge,
        hostRect,
        pointerClientX: event.clientX,
        selection: args.selectionRef.current,
        viewport: args.viewport,
      });
      args.selectionRef.current = next;
      setPreview(next);
    },
    [args],
  );

  const commitDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      args.isDraggingRef.current = false;
      const committed = args.selectionRef.current;
      setPreview(null);
      if (committed) {
        args.onCommit(committed);
      }
    },
    [args],
  );

  const cancelDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      args.isDraggingRef.current = false;
      setPreview(null);
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
  const dragRef = useRef<WaveformPlayheadDragResolution | null>(null);

  const resolveDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const hostRect = event.currentTarget.parentElement?.getBoundingClientRect();
      if (!hostRect) {
        return null;
      }

      return resolveWaveformPlayheadDrag({
        hostRect,
        pointerClientX: event.clientX,
        selection: args.selectionRef.current,
        viewport: args.viewport,
      });
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
          dragRef.current = null;
          args.playback.cancelDrag();
        }}
        onPointerDown={(event) => {
          const resolution = resolveDrag(event);
          if (!resolution) {
            return;
          }
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = resolution;
          args.playback.previewDrag(resolution);
          args.playback.beginDrag();
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
            return;
          }
          const resolution = resolveDrag(event);
          if (!resolution) {
            return;
          }
          dragRef.current = resolution;
          args.playback.previewDrag(resolution);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          const resolution = dragRef.current;
          dragRef.current = null;
          if (!resolution) {
            args.playback.cancelDrag();
            return;
          }
          void args.playback.commitDrag(resolution).catch((error) => {
            console.error("Failed to commit waveform playback seek", error);
            args.playback.cancelDrag();
          });
        }}
      />
    </>
  );
}
