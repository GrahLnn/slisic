import { crab, type TrackWaveformSummary, type TrackWaveformTile } from "@/src/cmd";
import { recordTrace } from "@/src/debug/trace";
import {
  createWaveformDataRequestKey,
  resolveWaveformTilePeakRangeAtPixels,
  resolveWaveformDataScopeKey,
  resolveWaveformRenderPixelsPerSecond,
  WAVEFORM_DATA_TILE_WIDTH,
} from "@/src/components/spectrum/SpectrumVisualizer.model";
import {
  resolveAudioVisualizationFrameWithReactiveAudio,
  shouldResolveAudioVisualizationReactiveSignal,
  type AudioVisualizationFrameSnapshot,
} from "./model";

type AudioVisualizationTileCacheEntry = {
  data: TrackWaveformTile | null;
  promise: Promise<TrackWaveformTile> | null;
};

type AudioVisualizationTrackCache = {
  summary: TrackWaveformSummary;
  tiles: Map<string, AudioVisualizationTileCacheEntry>;
};

type AudioVisualizationTrackCacheEntry = {
  data: AudioVisualizationTrackCache | null;
  promise: Promise<AudioVisualizationTrackCache> | null;
};

type AudioVisualizationReactivityPort = {
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
};

const AUDIO_VISUALIZATION_REACTIVITY_PIXELS_PER_SECOND = 80;
const AUDIO_VISUALIZATION_REACTIVITY_WINDOW_SECONDS = 0.24;
const AUDIO_VISUALIZATION_TRACK_CACHE_LIMIT = 8;
const AUDIO_VISUALIZATION_REACTIVITY_TRACE_INTERVAL_MS = 1_000;

const defaultPort: AudioVisualizationReactivityPort = {
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
};

const trackCache = new Map<string, AudioVisualizationTrackCacheEntry>();
let lastReactivityTraceAtMs = 0;

function recordAudioVisualizationReactivityTrace(
  event: string,
  payload: Record<string, unknown>,
) {
  const nowMs = performance.now();
  if (nowMs - lastReactivityTraceAtMs < AUDIO_VISUALIZATION_REACTIVITY_TRACE_INTERVAL_MS) {
    return;
  }

  lastReactivityTraceAtMs = nowMs;
  recordTrace(event, payload);
}

function readTrackCacheKey(filePath: string) {
  return filePath.trim().toLowerCase();
}

function trimTrackCache() {
  while (trackCache.size > AUDIO_VISUALIZATION_TRACK_CACHE_LIMIT) {
    const oldestKey = trackCache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    trackCache.delete(oldestKey);
  }
}

function ensureTrackCache(filePath: string, port: AudioVisualizationReactivityPort = defaultPort) {
  const cacheKey = readTrackCacheKey(filePath);
  const existing = trackCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const entry: AudioVisualizationTrackCacheEntry = {
    data: null,
    promise: null,
  };
  entry.promise = port
    .prepareTrackWaveform(filePath, null, null)
    .then((summary) => {
      const track = {
        summary,
        tiles: new Map<string, AudioVisualizationTileCacheEntry>(),
      };
      entry.data = track;
      entry.promise = null;
      return track;
    })
    .catch((error) => {
      if (trackCache.get(cacheKey) === entry) {
        trackCache.delete(cacheKey);
      }
      throw error;
    });
  trackCache.set(cacheKey, entry);
  trimTrackCache();

  return entry;
}

function readTrackCache(filePath: string, port: AudioVisualizationReactivityPort = defaultPort) {
  const entry = ensureTrackCache(filePath, port);
  if (entry.data) {
    return Promise.resolve(entry.data);
  }

  if (entry.promise) {
    return entry.promise;
  }

  return Promise.reject(new Error("Audio visualization track cache was not initialized."));
}

function readResolvedTrackCache(
  filePath: string,
  port: AudioVisualizationReactivityPort = defaultPort,
) {
  const entry = ensureTrackCache(filePath, port);
  if (entry.promise) {
    void entry.promise.catch(() => undefined);
  }

  return entry.data;
}

function resolveWaveformTileRequest(args: {
  filePath: string;
  seconds: number;
  summary: TrackWaveformSummary;
}) {
  const pixelsPerSecond = resolveWaveformRenderPixelsPerSecond({
    pixelsPerSecond: AUDIO_VISUALIZATION_REACTIVITY_PIXELS_PER_SECOND,
    summary: args.summary,
  });
  const durationSeconds = Math.max(0.001, args.summary.duration_ms / 1_000);
  const positionSeconds = Math.min(durationSeconds, Math.max(0, args.seconds));
  const positionPx = Math.floor(positionSeconds * pixelsPerSecond);
  const tileStartPx = Math.floor(positionPx / WAVEFORM_DATA_TILE_WIDTH) * WAVEFORM_DATA_TILE_WIDTH;
  const contentWidth = Math.max(1, Math.ceil(durationSeconds * pixelsPerSecond));
  const tileWidth = Math.max(
    1,
    Math.min(WAVEFORM_DATA_TILE_WIDTH, Math.max(1, contentWidth - tileStartPx)),
  );
  const scopeKey = resolveWaveformDataScopeKey({
    filePath: args.filePath,
    summary: args.summary,
  });
  const cacheKey = createWaveformDataRequestKey({
    pixelsPerSecond,
    scopeKey,
    startPx: tileStartPx,
    widthPx: tileWidth,
  });

  return {
    cacheKey,
    contentWidth,
    pixelsPerSecond,
    scopeKey,
    tileStartPx,
    tileWidth,
  };
}

export function resolveAudioVisualizationInstantEnergyFromTile(args: {
  filePath: string;
  seconds: number;
  summary: TrackWaveformSummary;
  tile: TrackWaveformTile;
}) {
  const request = resolveWaveformTileRequest({
    filePath: args.filePath,
    seconds: args.seconds,
    summary: args.summary,
  });
  const startSeconds = Math.max(
    0,
    args.seconds - AUDIO_VISUALIZATION_REACTIVITY_WINDOW_SECONDS / 2,
  );
  const endSeconds = args.seconds + AUDIO_VISUALIZATION_REACTIVITY_WINDOW_SECONDS / 2;
  const peak = resolveWaveformTilePeakRangeAtPixels({
    endPx: Math.ceil(endSeconds * request.pixelsPerSecond),
    startPx: Math.floor(startSeconds * request.pixelsPerSecond),
    tile: args.tile,
  });

  if (!peak) {
    return null;
  }

  return Math.min(1, Math.max(Math.abs(peak.min), Math.abs(peak.max)));
}

export function resolveAudioVisualizationBrightTransientFromTile(args: {
  filePath: string;
  seconds: number;
  summary: TrackWaveformSummary;
  tile: TrackWaveformTile;
}) {
  const request = resolveWaveformTileRequest({
    filePath: args.filePath,
    seconds: args.seconds,
    summary: args.summary,
  });
  const centerPx = Math.floor(args.seconds * request.pixelsPerSecond) - args.tile.start_px;
  const radiusPx = Math.max(2, Math.round(request.pixelsPerSecond * 0.055));
  const startPx = Math.max(0, centerPx - radiusPx);
  const endPx = Math.min(args.tile.width_px, centerPx + radiusPx + 1);
  if (endPx - startPx < 3) {
    return null;
  }

  let previousEnvelope: number | null = null;
  let variationSum = 0;
  let envelopeSum = 0;
  let sampleCount = 0;
  for (let index = startPx; index < endPx; index += 1) {
    const envelope = Math.min(
      1,
      Math.max(Math.abs(args.tile.min[index] ?? 0), Math.abs(args.tile.max[index] ?? 0)) / 127,
    );
    envelopeSum += envelope;
    sampleCount += 1;
    if (previousEnvelope !== null) {
      variationSum += Math.abs(envelope - previousEnvelope);
    }
    previousEnvelope = envelope;
  }

  const averageEnvelope = envelopeSum / Math.max(1, sampleCount);
  const averageVariation = variationSum / Math.max(1, sampleCount - 1);

  return Math.min(1, Math.max(0, averageVariation * 3.8 + averageEnvelope * averageVariation * 2.2));
}

function resolveAudioVisualizationReactiveAudioFromTile(args: {
  filePath: string;
  seconds: number;
  summary: TrackWaveformSummary;
  tile: TrackWaveformTile;
}) {
  return {
    brightTransient: resolveAudioVisualizationBrightTransientFromTile(args),
    instantEnergy: resolveAudioVisualizationInstantEnergyFromTile(args),
  };
}

function resolveLiveAudioVisualizationPosition(args: {
  frame: AudioVisualizationFrameSnapshot;
  nowMs: number;
}) {
  const elapsedMs =
    args.frame.playing && !args.frame.paused
      ? Math.max(0, args.nowMs - args.frame.received_at_ms)
      : 0;
  const currentPositionMs = Math.min(
    args.frame.range_end_ms,
    Math.max(args.frame.range_start_ms, Math.floor(args.frame.current_position_ms + elapsedMs)),
  );

  return {
    currentPositionMs,
    rangeProgress: Math.min(
      1,
      Math.max(
        0,
        (currentPositionMs - args.frame.range_start_ms) /
          Math.max(1, args.frame.range_end_ms - args.frame.range_start_ms),
      ),
    ),
  };
}

function requestWaveformTile(args: {
  filePath: string;
  port: AudioVisualizationReactivityPort;
  request: ReturnType<typeof resolveWaveformTileRequest>;
  track: AudioVisualizationTrackCache;
}) {
  const cached = args.track.tiles.get(args.request.cacheKey);
  if (cached?.data || cached?.promise) {
    return cached;
  }

  const promise = args.port
    .getTrackWaveformTile(
      args.filePath,
      null,
      null,
      args.request.pixelsPerSecond,
      args.request.tileStartPx,
      args.request.tileWidth,
    )
    .then((tile) => {
      args.track.tiles.set(args.request.cacheKey, {
        data: tile,
        promise: null,
      });
      return tile;
    })
    .catch((error) => {
      args.track.tiles.delete(args.request.cacheKey);
      throw error;
    });
  args.track.tiles.set(args.request.cacheKey, {
    data: null,
    promise,
  });
  void promise.catch(() => undefined);

  return args.track.tiles.get(args.request.cacheKey);
}

export function resolveAudioVisualizationLiveFrame(
  frame: AudioVisualizationFrameSnapshot,
  nowMs: number,
  port: AudioVisualizationReactivityPort = defaultPort,
): AudioVisualizationFrameSnapshot {
  const position = resolveLiveAudioVisualizationPosition({
    frame,
    nowMs,
  });
  const liveFrame = {
    ...frame,
    current_position_ms: position.currentPositionMs,
    range_progress: position.rangeProgress,
  };
  if (
    !shouldResolveAudioVisualizationReactiveSignal({
      frame,
      nowMs,
    })
  ) {
    return resolveAudioVisualizationFrameWithReactiveAudio(liveFrame, {
      brightTransient: null,
      instantEnergy: null,
    });
  }

  const track = readResolvedTrackCache(frame.file_path, port);
  if (!track) {
    recordAudioVisualizationReactivityTrace("player-audio-visualizer-live-frame-cache-miss", {
      canonicalMusicId: frame.canonical_music_id,
      currentPositionMs: liveFrame.current_position_ms,
      rangeEndMs: frame.range_end_ms,
      rangeStartMs: frame.range_start_ms,
      receivedAtMs: frame.received_at_ms,
    });
    return resolveAudioVisualizationFrameWithReactiveAudio(liveFrame, {
      brightTransient: null,
      instantEnergy: null,
    });
  }

  const seconds = liveFrame.current_position_ms / 1_000;
  const request = resolveWaveformTileRequest({
    filePath: frame.file_path,
    seconds,
    summary: track.summary,
  });
  const tileEntry = requestWaveformTile({
    filePath: frame.file_path,
    port,
    request,
    track,
  });
  if (!tileEntry?.data) {
    recordAudioVisualizationReactivityTrace("player-audio-visualizer-live-frame-tile-pending", {
      canonicalMusicId: frame.canonical_music_id,
      currentPositionMs: liveFrame.current_position_ms,
      hasPromise: Boolean(tileEntry?.promise),
      rangeEndMs: frame.range_end_ms,
      rangeStartMs: frame.range_start_ms,
      seconds,
      tileStartPx: request.tileStartPx,
      tileWidth: request.tileWidth,
    });
    return resolveAudioVisualizationFrameWithReactiveAudio(liveFrame, {
      brightTransient: null,
      instantEnergy: null,
    });
  }

  const reactiveAudio = resolveAudioVisualizationReactiveAudioFromTile({
      filePath: frame.file_path,
      seconds,
      summary: track.summary,
      tile: tileEntry.data,
  });
  recordAudioVisualizationReactivityTrace("player-audio-visualizer-live-frame-reactive-audio", {
    brightTransient: reactiveAudio.brightTransient,
    canonicalMusicId: frame.canonical_music_id,
    currentPositionMs: liveFrame.current_position_ms,
    instantEnergy: reactiveAudio.instantEnergy,
    rangeProgress: liveFrame.range_progress,
    seconds,
    tileStartPx: request.tileStartPx,
  });

  return resolveAudioVisualizationFrameWithReactiveAudio(liveFrame, reactiveAudio);
}

export async function resolveAudioVisualizationReactiveFrame(
  frame: AudioVisualizationFrameSnapshot,
  port: AudioVisualizationReactivityPort = defaultPort,
) {
  if (
    !shouldResolveAudioVisualizationReactiveSignal({
      frame,
      nowMs: frame.received_at_ms,
    })
  ) {
    return resolveAudioVisualizationFrameWithReactiveAudio(frame, {
      brightTransient: null,
      instantEnergy: null,
    });
  }

  const track = await readTrackCache(frame.file_path, port);
  const seconds = frame.current_position_ms / 1_000;
  const request = resolveWaveformTileRequest({
    filePath: frame.file_path,
    seconds,
    summary: track.summary,
  });
  const existingTile = track.tiles.get(request.cacheKey)?.data;
  if (existingTile) {
    return resolveAudioVisualizationFrameWithReactiveAudio(
      frame,
      resolveAudioVisualizationReactiveAudioFromTile({
        filePath: frame.file_path,
        seconds,
        summary: track.summary,
        tile: existingTile,
      }),
    );
  }

  const tileEntry = requestWaveformTile({
    filePath: frame.file_path,
    port,
    request,
    track,
  });
  if (!tileEntry?.promise) {
    return frame;
  }

  const tile = await tileEntry.promise;
  track.tiles.set(request.cacheKey, {
    data: tile,
    promise: null,
  });

  return resolveAudioVisualizationFrameWithReactiveAudio(
    frame,
    resolveAudioVisualizationReactiveAudioFromTile({
      filePath: frame.file_path,
      seconds,
      summary: track.summary,
      tile,
    }),
  );
}

export function resetAudioVisualizationReactivityCacheForTest() {
  trackCache.clear();
}
