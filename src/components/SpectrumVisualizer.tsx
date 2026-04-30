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

type WaveformTileNodeState = {
  canvas: HTMLCanvasElement;
  data: TrackWaveformTile | null;
  drawOpacity: number | null;
  drawScale: number | null;
  drawStatus: "data" | "placeholder" | null;
  drawWidthPx: number | null;
  index: number;
  startPx: number;
  status: "loading" | "pending" | "ready";
  widthPx: number;
};

type WaveformScrollElements = Pick<Elements, "scrollOffsetElement" | "viewport">;

type WaveformScrollSnapshot = {
  contentWidth: number;
  offset: WaveformScrollElementSnapshot;
  viewport: WaveformScrollElementSnapshot;
};

type WaveformScrollElementSnapshot = {
  className: string;
  clientWidth: number;
  isSameAsViewport?: boolean;
  offsetWidth: number;
  scrollLeft: number;
  scrollWidth: number;
  styleOverflowX: string;
  styleOverflowY: string;
  tagName: string;
};

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

export function resolveWaveformTileDisplayWidth(args: { renderScale: number; widthPx: number }) {
  const renderScale = clampNumber(args.renderScale, 0.001, 1);

  return Math.max(1, Math.ceil(Math.max(1, args.widthPx) * renderScale));
}

export function resolveWaveformTileSourcePixelRange(args: {
  displayPixelX: number;
  renderScale: number;
  sourcePixelCount: number;
}) {
  const sourcePixelCount = Math.max(0, Math.floor(args.sourcePixelCount));
  if (sourcePixelCount === 0) {
    return null;
  }

  const renderScale = clampNumber(args.renderScale, 0.001, 1);
  const startIndex = clampInteger(
    Math.floor(Math.max(0, args.displayPixelX) / renderScale),
    0,
    sourcePixelCount - 1,
  );
  const endIndex = clampInteger(
    Math.ceil((Math.max(0, args.displayPixelX) + 1) / renderScale),
    startIndex + 1,
    sourcePixelCount,
  );

  return { endIndex, startIndex };
}

export function resolveQuantizedWaveformDisplayPeak(args: {
  displayPixelX: number;
  max: readonly number[];
  min: readonly number[];
  renderScale: number;
}) {
  const sourcePixelCount = Math.min(args.min.length, args.max.length);
  const sourceRange = resolveWaveformTileSourcePixelRange({
    displayPixelX: args.displayPixelX,
    renderScale: args.renderScale,
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
  private playhead: HTMLDivElement | null = null;
  private playbackSnapshot: PlaybackSnapshot | null = null;
  private playheadFrameId: number | null = null;
  private playheadOpacity = "";
  private playheadTransform = "";
  private renderFrameId: number | null = null;
  private renderLayer: HTMLDivElement | null = null;
  private scrollLeft = 0;
  private tileLayer: HTMLDivElement | null = null;
  private tileLoadQueue = new Set<number>();
  private tiles = new Map<number, WaveformTileNodeState>();

  dispose() {
    this.cancelRenderFrame();
    this.cancelPlayheadFrame();
    this.cancelTileLoadFrame();
    this.invalidateTileLoads();
    this.playbackSnapshot = null;
    this.clearTiles();
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

    this.inputs = inputs;
    this.updateRenderLayerPresentation();

    if (this.layerKey !== nextLayerKey) {
      this.layerKey = nextLayerKey;
      this.clearTiles();
    }

    this.requestTileWindowRender();
    this.requestPlayheadRender();
  }

  setScrollLeft(scrollLeft: number) {
    const nextScrollLeft = Math.max(0, scrollLeft);
    if (Math.abs(nextScrollLeft - this.scrollLeft) < 0.5) {
      return;
    }

    this.scrollLeft = nextScrollLeft;
    this.requestTileWindowRender();
    this.requestPlayheadRender();
  }

  setTileLayer(tileLayer: HTMLDivElement | null) {
    if (this.tileLayer === tileLayer) {
      return;
    }

    this.clearTiles();
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

  private cancelTileLoadFrame() {
    if (this.loadFrameId === null) {
      return;
    }

    this.getOwnerWindow()?.cancelAnimationFrame(this.loadFrameId);
    this.loadFrameId = null;
  }

  private clearTiles() {
    this.invalidateTileLoads();

    for (const tile of this.tiles.values()) {
      tile.canvas.remove();
    }

    this.tiles.clear();
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

    const startPx = index * WAVEFORM_TILE_WIDTH;
    const widthPx = Math.max(
      1,
      Math.min(WAVEFORM_TILE_WIDTH, renderMetrics.contentWidth - startPx),
    );
    const canvas = renderLayer.ownerDocument.createElement("canvas");

    canvas.ariaHidden = "true";
    canvas.className = "pointer-events-none absolute top-0 block h-full";
    canvas.style.left = `${startPx}px`;
    canvas.style.width = `${widthPx}px`;
    canvas.style.height = `${WAVEFORM_CANVAS_HEIGHT}px`;
    renderLayer.append(canvas);

    const tile: WaveformTileNodeState = {
      canvas,
      data: null,
      drawOpacity: null,
      drawScale: null,
      drawStatus: null,
      drawWidthPx: null,
      index,
      startPx,
      status: inputs.status === "ready" && Boolean(inputs.filePath) ? "pending" : "ready",
      widthPx,
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
    renderLayer.className =
      "pointer-events-none absolute inset-y-0 left-0 block h-full will-change-transform";
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
    if (!filePath || !this.host) {
      if (this.loadGeneration === generation) {
        this.activeTileLoadCount = Math.max(0, this.activeTileLoadCount - 1);
        this.requestTileLoadPump();
      }

      return;
    }

    try {
      const result = await commands.getTrackWaveformTile(
        filePath,
        normalizeWaveformBoundary(inputs.start),
        normalizeWaveformBoundary(inputs.end),
        renderPixelsPerSecond,
        tile.startPx,
        tile.widthPx,
      );

      if (result.status === "error") {
        throw new Error(result.error);
      }

      if (this.loadGeneration !== generation || this.tiles.get(tile.index) !== tile) {
        return;
      }

      if (tile.startPx !== result.data.start_px || tile.widthPx !== result.data.width_px) {
        tile.status = "pending";
        this.queueTileLoads([tile.index]);
        return;
      }

      tile.data = result.data;
      tile.status = "ready";
      this.drawTileWithCurrentInputs(tile);
    } catch (error) {
      console.error("Failed to render waveform tile", error);
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
    const inputs = this.inputs;
    const renderLayer = this.ensureRenderLayer();
    if (!inputs || !renderLayer || !this.host || inputs.viewportWidth <= 0) {
      return;
    }

    this.updateRenderLayerPresentation();

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
      this.clearTiles();
      return;
    }

    for (const [index, tile] of this.tiles) {
      if (index < retentionTileWindow.startIndex || index > retentionTileWindow.endIndex) {
        this.removeTile(index, tile);
      }
    }

    const tileLoadOrder = resolveWaveformTileLoadOrder({
      endIndex: tileWindow.endIndex,
      startIndex: tileWindow.startIndex,
      visibleEndIndex: visibleTileWindow.endIndex,
      visibleStartIndex: visibleTileWindow.startIndex,
    });

    for (const index of tileLoadOrder) {
      const tile = this.tiles.get(index) ?? this.createTile(index, inputs, renderMetrics);

      if (tile) {
        this.syncTileGeometry(tile, inputs, renderMetrics);
        this.drawTile(tile, inputs, renderMetrics.scale);
      }
    }

    this.queueTileLoads(tileLoadOrder);
  }

  private drawTile(tile: WaveformTileNodeState, inputs: WaveformRenderInputs, renderScale: number) {
    const host = this.host;
    if (!host) {
      return;
    }

    const drawStatus = tile.data ? "data" : "placeholder";
    const drawOpacity = tile.data
      ? inputs.opacity
      : inputs.status === "ready"
        ? WAVEFORM_INACTIVE_OPACITY
        : inputs.opacity;

    if (
      tile.drawStatus === drawStatus &&
      tile.drawWidthPx === tile.widthPx &&
      tile.drawOpacity === drawOpacity &&
      tile.drawScale !== null &&
      Math.abs(tile.drawScale - renderScale) < 0.0001
    ) {
      return;
    }

    if (tile.data) {
      drawQuantizedWaveformTile({
        canvas: tile.canvas,
        host,
        opacity: drawOpacity,
        renderScale,
        tile: tile.data,
      });
    } else {
      drawPlaceholderWaveformTile({
        canvas: tile.canvas,
        host,
        opacity: drawOpacity,
        renderScale,
        startPx: tile.startPx,
        widthPx: tile.widthPx,
      });
    }

    tile.drawOpacity = drawOpacity;
    tile.drawScale = renderScale;
    tile.drawStatus = drawStatus;
    tile.drawWidthPx = tile.widthPx;
  }

  private drawTileWithCurrentInputs(tile: WaveformTileNodeState) {
    const inputs = this.inputs;
    if (!inputs) {
      return;
    }

    this.drawTile(tile, inputs, resolveWaveformRenderMetrics(inputs).scale);
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

    const renderMetrics = resolveWaveformRenderMetrics(inputs);

    renderLayer.style.width = `${renderMetrics.contentWidth}px`;
    renderLayer.style.transform = `translate3d(0, 0, 0) scaleX(${renderMetrics.scale})`;
  }

  private syncTileGeometry(
    tile: WaveformTileNodeState,
    inputs: WaveformRenderInputs,
    renderMetrics: ReturnType<typeof resolveWaveformRenderMetrics>,
  ) {
    const startPx = tile.index * WAVEFORM_TILE_WIDTH;
    const widthPx = Math.max(
      1,
      Math.min(WAVEFORM_TILE_WIDTH, renderMetrics.contentWidth - startPx),
    );

    if (tile.startPx === startPx && tile.widthPx === widthPx) {
      return;
    }

    tile.startPx = startPx;
    tile.widthPx = widthPx;
    tile.data = null;
    tile.drawOpacity = null;
    tile.drawScale = null;
    tile.drawStatus = null;
    tile.drawWidthPx = null;
    tile.status = inputs.status === "ready" && Boolean(inputs.filePath) ? "pending" : "ready";
    tile.canvas.style.left = `${startPx}px`;
    tile.canvas.style.width = `${widthPx}px`;
  }
}

function useWaveformTileController() {
  const controllerRef = useRef<WaveformTileController | null>(null);

  if (controllerRef.current === null) {
    controllerRef.current = new WaveformTileController();
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
  const handleViewportWheel = useCallback((event: WaveformWheelEvent) => {
    const wheelState = wheelStateRef.current;
    const scrollElements = getWaveformScrollElements(scrollbarsRef.current);

    if (!wheelState || !scrollElements) {
      recordSpectrumWaveformTrace("wheel-no-scroll-elements", {
        ...snapshotWaveformWheelEvent(event),
        currentTarget: snapshotWaveformEventTarget(event.currentTarget),
        target: snapshotWaveformEventTarget(event.target),
      });
      return;
    }

    if (!isWaveformWheelTargetInViewport(event, scrollElements)) {
      recordSpectrumWaveformTrace("wheel-outside-viewport", {
        ...snapshotWaveformWheelEvent(event),
        currentTarget: snapshotWaveformEventTarget(event.currentTarget),
        target: snapshotWaveformEventTarget(event.target),
      });
      return;
    }

    handleWaveformViewportWheel({
      event,
      scrollElements,
      wheelState,
    });
  }, []);
  const readTraceContentWidth = useCallback(() => wheelStateRef.current?.contentWidth ?? 0, []);
  const scrollEvents = useMemo<EventListeners>(
    () => ({
      initialized: (instance) => {
        const elements = instance.elements();

        recordSpectrumWaveformTrace("scrollbars-initialized", {
          scroll: snapshotWaveformScrollElements(elements, readTraceContentWidth()),
        });
      },
      scroll: (instance) => {
        const elements = instance.elements();
        const scrollLeft = readWaveformScrollLeft(elements);

        recordSpectrumWaveformTrace("overlay-scroll", {
          scrollLeft,
          scroll: snapshotWaveformScrollElements(elements, readTraceContentWidth()),
        });
        controller.setScrollLeft(scrollLeft);
      },
    }),
    [controller, readTraceContentWidth],
  );

  useLayoutEffect(() => {
    installSpectrumWaveformTrace();
  }, []);

  useEffect(() => {
    recordSpectrumWaveformTrace("render-state", {
      contentWidth,
      durationMs: summary.duration_ms,
      filePath: props.filePath?.trim() || null,
      pixelsPerSecond,
      status: state.status,
      summaryCacheKey: summary.cache_key,
      viewportWidth,
    });
  }, [
    contentWidth,
    pixelsPerSecond,
    props.filePath,
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

    recordSpectrumWaveformTrace("wheel-listener-attached", {
      phase: "host-capture",
      scroll: (() => {
        const elements = getWaveformScrollElements(scrollbarsRef.current);
        return elements ? snapshotWaveformScrollElements(elements, readTraceContentWidth()) : null;
      })(),
    });

    return () => {
      host.removeEventListener("wheel", handleViewportWheel, true);
    };
  }, [handleViewportWheel, readTraceContentWidth]);

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
  host: HTMLElement;
  opacity: number;
  renderScale: number;
  startPx: number;
  widthPx: number;
}) {
  const renderScale = clampNumber(args.renderScale, 0.001, 1);

  drawWaveformTileFrame({
    canvas: args.canvas,
    displayWidthPx: resolveWaveformTileDisplayWidth({
      renderScale,
      widthPx: args.widthPx,
    }),
    host: args.host,
    opacity: args.opacity,
    resolvePeak: (x) => {
      const index = args.startPx + x / renderScale;
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
  host: HTMLElement;
  opacity: number;
  renderScale: number;
  tile: TrackWaveformTile;
}) {
  drawWaveformTileFrame({
    canvas: args.canvas,
    displayWidthPx: resolveWaveformTileDisplayWidth({
      renderScale: args.renderScale,
      widthPx: args.tile.width_px,
    }),
    host: args.host,
    opacity: args.opacity,
    resolvePeak: (x) =>
      resolveQuantizedWaveformDisplayPeak({
        displayPixelX: x,
        max: args.tile.max,
        min: args.tile.min,
        renderScale: args.renderScale,
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
  const dpr = Math.min(Math.max(ownerWindow?.devicePixelRatio || 1, 1), 3);
  const width = Math.max(1, Math.ceil(args.displayWidthPx));
  const height = Math.max(1, Math.ceil(args.canvas.clientHeight || WAVEFORM_CANVAS_HEIGHT));
  const backingWidth = Math.ceil(width * dpr);
  const backingHeight = Math.ceil(height * dpr);

  if (args.canvas.width !== backingWidth || args.canvas.height !== backingHeight) {
    args.canvas.width = backingWidth;
    args.canvas.height = backingHeight;
  }

  const context = args.canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
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

function handleWaveformViewportWheel(args: {
  event: WaveformWheelEvent;
  scrollElements: WaveformScrollElements;
  wheelState: WaveformWheelState;
}) {
  const { contentWidth, pixelsPerSecond, viewportWidth } = args.wheelState;
  const scrollElement = args.scrollElements.viewport;
  const scrollLeft = readWaveformScrollLeft(args.scrollElements);
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
  const beforeScroll = snapshotWaveformScrollElements(args.scrollElements, contentWidth);

  recordSpectrumWaveformTrace("wheel-start", {
    ...snapshotWaveformWheelEvent(args.event),
    altKey: readWaveformWheelBoolean(args.event, "altKey"),
    contentWidth,
    ctrlKey: readWaveformWheelBoolean(args.event, "ctrlKey"),
    deltaMode: wheelDeltas.deltaMode,
    deltaX: wheelDeltas.deltaX,
    deltaY: wheelDeltas.deltaY,
    intent,
    metaKey: readWaveformWheelBoolean(args.event, "metaKey"),
    normalizedDeltaX,
    normalizedDeltaY,
    pixelsPerSecond,
    scrollLeft,
    shiftKey: readWaveformWheelBoolean(args.event, "shiftKey"),
    currentTarget: snapshotWaveformEventTarget(args.event.currentTarget),
    target: snapshotWaveformEventTarget(args.event.target),
    wheelViewportWidth,
    scroll: beforeScroll,
  });

  if (intent.kind === "horizontal-pan") {
    recordSpectrumWaveformTrace("wheel-pan-native", {
      beforeScrollLeft: scrollLeft,
      horizontalDelta: intent.deltaX,
      scroll: snapshotWaveformScrollElements(args.scrollElements, contentWidth),
    });
    recordSpectrumWaveformScrollAfterFrame(
      "wheel-pan-native-after-frame",
      args.scrollElements,
      contentWidth,
    );
    return;
  }

  if (intent.kind === "none") {
    recordSpectrumWaveformTrace("wheel-ignored", {
      reason: "no-delta",
      scroll: snapshotWaveformScrollElements(args.scrollElements, contentWidth),
    });
    return;
  }

  handleWaveformZoomWheel({
    deltaY: intent.deltaY,
    event: args.event,
    scrollElements: args.scrollElements,
    scrollLeft,
    wheelState: args.wheelState,
    wheelViewportWidth,
  });
}

function handleWaveformZoomWheel(args: {
  deltaY: number;
  event: WaveformWheelEvent;
  scrollElements: WaveformScrollElements;
  scrollLeft: number;
  wheelState: WaveformWheelState;
  wheelViewportWidth: number;
}) {
  const { controller, pixelsPerSecond, summary, viewportWidth } = args.wheelState;
  const scrollElement = args.scrollElements.viewport;
  const nextPixelsPerSecond = resolveWaveformWheelPixelsPerSecond({
    currentPixelsPerSecond: pixelsPerSecond,
    deltaY: args.deltaY,
  });

  if (Math.abs(nextPixelsPerSecond - pixelsPerSecond) < 0.01) {
    recordSpectrumWaveformTrace("wheel-ignored", {
      reason: "zoom-clamped",
      nextPixelsPerSecond,
      pixelsPerSecond,
      scroll: snapshotWaveformScrollElements(args.scrollElements, args.wheelState.contentWidth),
    });
    return;
  }

  preventWaveformWheelDefault(args.event);

  const rect = scrollElement.getBoundingClientRect();
  const anchorViewportX = clampNumber(
    readWaveformWheelNumber(args.event, "clientX", rect.left + args.wheelViewportWidth / 2) -
      rect.left,
    0,
    Math.max(1, scrollElement.clientWidth || viewportWidth),
  );
  const anchorSeconds = (args.scrollLeft + anchorViewportX) / pixelsPerSecond;
  const nextContentWidth = resolveWaveformContentWidth({
    durationMs: summary.duration_ms,
    pixelsPerSecond: nextPixelsPerSecond,
    viewportWidth,
  });

  flushSync(() => {
    args.wheelState.setPixelsPerSecond(nextPixelsPerSecond);
  });

  const nextScrollLeft = resolveAnchoredWaveformScrollLeft({
    anchorSeconds,
    anchorViewportX,
    contentWidth: nextContentWidth,
    pixelsPerSecond: nextPixelsPerSecond,
    viewportWidth,
  });

  writeWaveformScrollLeft(args.scrollElements, nextScrollLeft);
  controller.setScrollLeft(nextScrollLeft);
  recordSpectrumWaveformTrace("wheel-zoom-write", {
    anchorSeconds,
    anchorViewportX,
    beforePixelsPerSecond: pixelsPerSecond,
    beforeScrollLeft: args.scrollLeft,
    nextContentWidth,
    nextPixelsPerSecond,
    nextScrollLeft,
    scroll: snapshotWaveformScrollElements(args.scrollElements, nextContentWidth),
  });
  recordSpectrumWaveformScrollAfterFrame(
    "wheel-zoom-after-frame",
    args.scrollElements,
    nextContentWidth,
  );
}

function getWaveformScrollElements(
  ref: OverlayScrollbarsComponentRef<"div"> | null,
): WaveformScrollElements | null {
  const elements = ref?.osInstance()?.elements();
  if (elements) {
    return elements;
  }

  const element = ref?.getElement();
  return element ? { scrollOffsetElement: element, viewport: element } : null;
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

function recordSpectrumWaveformScrollAfterFrame(
  event: string,
  elements: WaveformScrollElements,
  contentWidth: number,
) {
  if (typeof window === "undefined") {
    return;
  }

  window.requestAnimationFrame(() => {
    recordSpectrumWaveformTrace(event, {
      scroll: snapshotWaveformScrollElements(elements, contentWidth),
    });
  });
}

function snapshotWaveformScrollElements(
  elements: WaveformScrollElements,
  contentWidth: number,
): WaveformScrollSnapshot {
  return {
    contentWidth,
    offset: snapshotWaveformScrollElement(elements.scrollOffsetElement, {
      isSameAsViewport: elements.scrollOffsetElement === elements.viewport,
    }),
    viewport: snapshotWaveformScrollElement(elements.viewport),
  };
}

function snapshotWaveformScrollElement(
  element: HTMLElement,
  flags: Pick<WaveformScrollElementSnapshot, "isSameAsViewport"> = {},
): WaveformScrollElementSnapshot {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);

  return {
    ...flags,
    className: element.className,
    clientWidth: element.clientWidth,
    offsetWidth: element.offsetWidth,
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
    styleOverflowX: style?.overflowX ?? "",
    styleOverflowY: style?.overflowY ?? "",
    tagName: element.tagName,
  };
}

function snapshotWaveformEventTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return null;
  }

  return {
    className: target.className,
    dataOverlayscrollbars: target.getAttribute("data-overlayscrollbars"),
    dataOverlayscrollbarsContents: target.getAttribute("data-overlayscrollbars-contents"),
    tagName: target.tagName,
  };
}

function snapshotWaveformWheelEvent(event: WaveformWheelEvent) {
  return {
    axis: getNativeWheelAxis(event),
    cancelable: readWaveformWheelBoolean(event, "cancelable"),
    defaultPrevented: readWaveformWheelBoolean(event, "defaultPrevented"),
    deltaMode: getNativeWheelDeltaMode(event),
    eventPhase: readWaveformWheelNumber(event, "eventPhase", null),
    isTrusted: readWaveformWheelBoolean(event, "isTrusted"),
    nativeDeltaX: getNativeWheelDeltaXStandard(event),
    nativeDeltaY: getNativeWheelDeltaYStandard(event),
    nativeWheelDelta: getNativeWheelDelta(event),
    nativeWheelDeltaX: getNativeWheelDeltaX(event),
    nativeWheelDeltaY: getNativeWheelDeltaY(event),
    type: readWaveformWheelString(event, "type"),
  };
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

function readWaveformWheelBoolean(event: WaveformWheelEvent, key: string) {
  return readWaveformWheelProperty(event, key) === true;
}

function readWaveformWheelString(event: WaveformWheelEvent, key: string) {
  const value = readWaveformWheelProperty(event, key);
  return typeof value === "string" ? value : null;
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

  const nativeEvent = getWaveformNativeEvent(event);
  if (nativeEvent && nativeEvent !== event) {
    nativeEvent.preventDefault();
    nativeEvent.stopPropagation();
  }
}

function isPlaybackStatusForTrack(status: PlaybackStatusPayload, filePath: string) {
  return (
    status.path !== null &&
    normalizeWaveformPathKey(status.path) === normalizeWaveformPathKey(filePath)
  );
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
