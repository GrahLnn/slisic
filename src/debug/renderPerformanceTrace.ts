import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

export type RenderPerformanceTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

export type RenderPerformanceTraceSummary = {
  entryCount: number;
  eventCounts: Record<string, number>;
};

type RenderPerformanceTraceApi = {
  clear: () => void;
  entries: () => RenderPerformanceTraceEntry[];
  record: (event: string, payload?: Record<string, unknown>) => void;
  save: () => Promise<string | null>;
  startFrameDropSampler: (args?: RenderFrameDropSamplerOptions) => RenderFrameDropSamplerHandle;
  summary: () => RenderPerformanceTraceSummary;
};

export type RenderFrameDropSampleState = {
  droppedFrameCount: number;
  dropThresholdMs: number;
  frameCount: number;
  label: string;
  longestFrameDeltaMs: number;
  payload: Record<string, unknown>;
  previousFrameTime: number | null;
  sampleWindowMs: number;
  targetFrameMs: number;
  totalFrameDeltaMs: number;
  windowStartedAt: number;
};

export type RenderFrameDropSampleSummary = {
  averageFrameDeltaMs: number;
  droppedFrameCount: number;
  dropThresholdMs: number;
  durationMs: number;
  endedAt: number;
  frameCount: number;
  label: string;
  longestFrameDeltaMs: number;
  payload: Record<string, unknown>;
  startedAt: number;
  targetFrameMs: number;
};

export type RenderFrameDropSamplerOptions = {
  dropThresholdMs?: number;
  label?: string;
  payload?: Record<string, unknown>;
  sampleWindowMs?: number;
  targetFrameMs?: number;
};

export type RenderFrameDropSamplerHandle = {
  stop: (reason?: string) => void;
};

declare global {
  interface Window {
    __renderPerformanceTraceApi?: RenderPerformanceTraceApi;
    __renderPerformanceTraceInstalled?: boolean;
    saveRenderPerformanceTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 6_000;
const DEFAULT_TARGET_FRAME_MS = 1_000 / 60;
const DEFAULT_SAMPLE_WINDOW_MS = 1_000;

let sequence = 0;
const entries: RenderPerformanceTraceEntry[] = [];

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

function pushRenderPerformanceTraceEntry(entry: RenderPerformanceTraceEntry) {
  entries.push(entry);
  trimEntries();
}

export function isRenderPerformanceTraceInstalled() {
  return typeof window !== "undefined" && window.__renderPerformanceTraceInstalled === true;
}

export function recordRenderPerformanceTrace(event: string, payload: Record<string, unknown> = {}) {
  if (!isRenderPerformanceTraceInstalled()) {
    return;
  }

  pushRenderPerformanceTraceEntry({
    seq: sequence++,
    isoTime: new Date().toISOString(),
    performanceNow: window.performance.now(),
    event,
    payload,
  });
}

export function createRenderFrameDropSampleState(
  args: RenderFrameDropSamplerOptions & {
    startedAt: number;
  },
): RenderFrameDropSampleState {
  const targetFrameMs =
    typeof args.targetFrameMs === "number" && Number.isFinite(args.targetFrameMs)
      ? Math.max(1, args.targetFrameMs)
      : DEFAULT_TARGET_FRAME_MS;

  return {
    droppedFrameCount: 0,
    dropThresholdMs:
      typeof args.dropThresholdMs === "number" && Number.isFinite(args.dropThresholdMs)
        ? Math.max(targetFrameMs, args.dropThresholdMs)
        : targetFrameMs * 1.5,
    frameCount: 0,
    label: args.label ?? "render",
    longestFrameDeltaMs: 0,
    payload: { ...args.payload },
    previousFrameTime: null,
    sampleWindowMs:
      typeof args.sampleWindowMs === "number" && Number.isFinite(args.sampleWindowMs)
        ? Math.max(targetFrameMs, args.sampleWindowMs)
        : DEFAULT_SAMPLE_WINDOW_MS,
    targetFrameMs,
    totalFrameDeltaMs: 0,
    windowStartedAt: args.startedAt,
  };
}

function resolveDroppedFrames(args: {
  deltaMs: number;
  dropThresholdMs: number;
  targetFrameMs: number;
}) {
  if (args.deltaMs <= args.dropThresholdMs) {
    return 0;
  }

  return Math.max(1, Math.floor(args.deltaMs / args.targetFrameMs) - 1);
}

export function flushRenderFrameDropSampleState(
  state: RenderFrameDropSampleState,
  endedAt: number,
): RenderFrameDropSampleSummary | null {
  if (state.frameCount <= 0) {
    state.windowStartedAt = endedAt;
    return null;
  }

  const summary = {
    averageFrameDeltaMs: state.totalFrameDeltaMs / state.frameCount,
    droppedFrameCount: state.droppedFrameCount,
    dropThresholdMs: state.dropThresholdMs,
    durationMs: Math.max(0, endedAt - state.windowStartedAt),
    endedAt,
    frameCount: state.frameCount,
    label: state.label,
    longestFrameDeltaMs: state.longestFrameDeltaMs,
    payload: state.payload,
    startedAt: state.windowStartedAt,
    targetFrameMs: state.targetFrameMs,
  } satisfies RenderFrameDropSampleSummary;

  state.droppedFrameCount = 0;
  state.frameCount = 0;
  state.longestFrameDeltaMs = 0;
  state.totalFrameDeltaMs = 0;
  state.windowStartedAt = endedAt;

  return summary;
}

export function sampleRenderFrameDropState(
  state: RenderFrameDropSampleState,
  frameTime: number,
): RenderFrameDropSampleSummary | null {
  const previousFrameTime = state.previousFrameTime;
  state.previousFrameTime = frameTime;

  if (previousFrameTime === null) {
    state.windowStartedAt = frameTime;
    return null;
  }

  const deltaMs = Math.max(0, frameTime - previousFrameTime);
  state.frameCount += 1;
  state.totalFrameDeltaMs += deltaMs;
  state.longestFrameDeltaMs = Math.max(state.longestFrameDeltaMs, deltaMs);
  state.droppedFrameCount += resolveDroppedFrames({
    deltaMs,
    dropThresholdMs: state.dropThresholdMs,
    targetFrameMs: state.targetFrameMs,
  });

  return frameTime - state.windowStartedAt >= state.sampleWindowMs
    ? flushRenderFrameDropSampleState(state, frameTime)
    : null;
}

export function summarizeRenderPerformanceTraceEntries(
  traceEntries: readonly RenderPerformanceTraceEntry[] = entries,
): RenderPerformanceTraceSummary {
  const eventCounts: Record<string, number> = {};

  for (const entry of traceEntries) {
    eventCounts[entry.event] = (eventCounts[entry.event] ?? 0) + 1;
  }

  return {
    entryCount: traceEntries.length,
    eventCounts,
  };
}

export function startRenderFrameDropSampler(
  args: RenderFrameDropSamplerOptions = {},
): RenderFrameDropSamplerHandle {
  if (typeof window === "undefined") {
    return {
      stop: () => undefined,
    };
  }

  const state = createRenderFrameDropSampleState({
    ...args,
    startedAt: window.performance.now(),
  });
  let frameId: number | null = null;
  let stopped = false;

  const sample = (frameTime: number) => {
    if (stopped) {
      return;
    }

    const summary = sampleRenderFrameDropState(state, frameTime);
    if (summary) {
      recordRenderPerformanceTrace("frame-drop-summary", { ...summary });
    }

    frameId = window.requestAnimationFrame(sample);
  };

  recordRenderPerformanceTrace("frame-drop-sampler-started", {
    dropThresholdMs: state.dropThresholdMs,
    label: state.label,
    payload: state.payload,
    sampleWindowMs: state.sampleWindowMs,
    targetFrameMs: state.targetFrameMs,
  });

  frameId = window.requestAnimationFrame(sample);

  return {
    stop(reason = "stopped") {
      if (stopped) {
        return;
      }

      stopped = true;
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }

      const stoppedAt = window.performance.now();
      const summary = flushRenderFrameDropSampleState(state, stoppedAt);
      if (summary) {
        recordRenderPerformanceTrace("frame-drop-summary", { ...summary, reason });
      }

      recordRenderPerformanceTrace("frame-drop-sampler-stopped", {
        label: state.label,
        reason,
      });
    },
  };
}

async function saveRenderPerformanceTrace() {
  if (typeof window === "undefined") {
    return null;
  }

  const path = await join(
    await downloadDir(),
    `render-performance-trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[renderPerformanceTrace] saved ${path}`);
  return path;
}

export function installRenderPerformanceTrace() {
  if (typeof window === "undefined" || window.__renderPerformanceTraceInstalled) {
    return;
  }

  const api: RenderPerformanceTraceApi = {
    clear() {
      entries.length = 0;
      sequence = 0;
      recordRenderPerformanceTrace("trace-cleared");
    },
    entries() {
      return [...entries];
    },
    record: recordRenderPerformanceTrace,
    save: saveRenderPerformanceTrace,
    startFrameDropSampler: startRenderFrameDropSampler,
    summary: () => summarizeRenderPerformanceTraceEntries(),
  };

  window.__renderPerformanceTraceInstalled = true;
  window.__renderPerformanceTraceApi = api;
  window.saveRenderPerformanceTrace = api.save;

  recordRenderPerformanceTrace("trace-installed", {
    href: window.location.href,
  });
}
