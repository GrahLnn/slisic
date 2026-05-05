import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

type SpectrumInitialRenderTraceEntry = {
  captureId: number | null;
  event: string;
  isoTime: string;
  payload: Record<string, unknown>;
  performanceNow: number;
  seq: number;
  source: "spectrum-initial-render";
};

type SpectrumInitialRenderTraceApi = {
  clear: () => void;
  entries: () => SpectrumInitialRenderTraceEntry[];
  save: () => Promise<string | null>;
};

type SpectrumInitialRenderCaptureStart = {
  commitTime?: number | null;
  durationMs: number;
  filePathKey: string;
  hasFilePath: boolean;
  reason: "layout-mount" | "react-profiler";
  sessionKey: string;
  status: string;
  summaryCacheKey: string;
};

type SpectrumInitialRenderProfilerEntry = SpectrumInitialRenderCaptureStart & {
  actualDuration: number;
  baseDuration: number;
  commitTime: number;
  id: string;
  phase: "mount" | "nested-update" | "update";
  startTime: number;
};

type SpectrumInitialRenderCapture = {
  frameCount: number;
  frameId: number | null;
  longFrameCount: number;
  longTaskObserver: PerformanceObserver | null;
  maxFrameDeltaMs: number;
  previousFrameTime: number | null;
  sessionKey: string;
  startedAt: number;
  totalDroppedFrameEstimate: number;
};

declare global {
  interface Window {
    __SPECTRUM_INITIAL_RENDER_TRACE_CONSOLE__?: boolean;
    __spectrumInitialRenderTraceApi?: SpectrumInitialRenderTraceApi;
    __spectrumInitialRenderTraceInstalled?: boolean;
    saveSpectrumInitialRenderTrace?: () => Promise<string | null>;
  }
}

const FRAME_BUDGET_MS = 1000 / 60;
const LONG_FRAME_THRESHOLD_MS = FRAME_BUDGET_MS * 1.25;
const MAX_CAPTURE_FRAMES = 120;
const MAX_CAPTURE_MS = 3_000;
const MAX_TRACE_ENTRIES = 6_000;
const RECENT_CAPTURE_RECORD_TAIL_MS = 250;

let captureSequence = 0;
let recentRecordUntilMs = 0;
let sequence = 0;

const activeCaptures = new Map<number, SpectrumInitialRenderCapture>();
const entries: SpectrumInitialRenderTraceEntry[] = [];

function readNow() {
  return typeof window === "undefined" ? 0 : window.performance.now();
}

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

function pushSpectrumInitialRenderTraceEntry(
  event: string,
  payload: Record<string, unknown> = {},
  captureId: number | null = null,
) {
  if (typeof window === "undefined") {
    return;
  }

  const entry = {
    captureId,
    event,
    isoTime: new Date().toISOString(),
    payload,
    performanceNow: window.performance.now(),
    seq: sequence++,
    source: "spectrum-initial-render",
  } satisfies SpectrumInitialRenderTraceEntry;

  entries.push(entry);
  trimEntries();

  if (window.__SPECTRUM_INITIAL_RENDER_TRACE_CONSOLE__ === true) {
    console.log(`[spectrumInitialRenderTrace] ${event}`, entry);
  }
}

function ensureSpectrumInitialRenderTraceInstalled() {
  if (typeof window === "undefined" || window.__spectrumInitialRenderTraceInstalled) {
    return;
  }

  const api: SpectrumInitialRenderTraceApi = {
    clear() {
      entries.length = 0;
      sequence = 0;
      pushSpectrumInitialRenderTraceEntry("trace-cleared");
    },
    entries() {
      return entries.slice();
    },
    save: saveSpectrumInitialRenderTrace,
  };

  window.__spectrumInitialRenderTraceInstalled = true;
  window.__spectrumInitialRenderTraceApi = api;
  window.saveSpectrumInitialRenderTrace = api.save;
  pushSpectrumInitialRenderTraceEntry("trace-installed", {
    href: window.location.href,
  });
}

function findActiveCaptureIdForSession(sessionKey: string) {
  for (const [captureId, capture] of activeCaptures) {
    if (capture.sessionKey === sessionKey) {
      return captureId;
    }
  }

  return null;
}

function resolveLatestActiveCaptureId() {
  let latestCaptureId: number | null = null;
  let latestStartedAt = Number.NEGATIVE_INFINITY;

  for (const [captureId, capture] of activeCaptures) {
    if (capture.startedAt > latestStartedAt) {
      latestCaptureId = captureId;
      latestStartedAt = capture.startedAt;
    }
  }

  return latestCaptureId;
}

function shouldRecordSpectrumInitialRenderWork() {
  if (typeof window === "undefined") {
    return false;
  }

  return activeCaptures.size > 0 || window.performance.now() <= recentRecordUntilMs;
}

function summarizeLongTaskAttribution(entry: PerformanceEntry) {
  const attribution = (entry as unknown as { attribution?: unknown }).attribution;

  return Array.isArray(attribution)
    ? attribution.map((item) => {
        if (!item || typeof item !== "object") {
          return item;
        }

        const record = item as Record<string, unknown>;
        return {
          containerId: record.containerId ?? null,
          containerName: record.containerName ?? null,
          containerSrc: record.containerSrc ?? null,
          containerType: record.containerType ?? null,
          name: record.name ?? null,
        };
      })
    : null;
}

function observeLongTasks(captureId: number, startedAt: number) {
  if (typeof window === "undefined" || typeof window.PerformanceObserver === "undefined") {
    pushSpectrumInitialRenderTraceEntry("long-task-observer-unavailable", {}, captureId);
    return null;
  }

  try {
    const observer = new window.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        pushSpectrumInitialRenderTraceEntry(
          "long-task",
          {
            attribution: summarizeLongTaskAttribution(entry),
            durationMs: entry.duration,
            name: entry.name,
            relativeStartMs: entry.startTime - startedAt,
            startTime: entry.startTime,
          },
          captureId,
        );
      }
    });

    observer.observe({
      buffered: true,
      type: "longtask",
    } as PerformanceObserverInit);

    return observer;
  } catch (error) {
    pushSpectrumInitialRenderTraceEntry(
      "long-task-observer-error",
      {
        error: error instanceof Error ? error.message : String(error),
      },
      captureId,
    );
    return null;
  }
}

function finishSpectrumInitialRenderCapture(captureId: number, reason: string) {
  if (typeof window === "undefined") {
    return;
  }

  const capture = activeCaptures.get(captureId);
  if (!capture) {
    return;
  }

  if (capture.frameId !== null) {
    window.cancelAnimationFrame(capture.frameId);
  }
  capture.longTaskObserver?.disconnect();
  activeCaptures.delete(captureId);
  recentRecordUntilMs = Math.max(
    recentRecordUntilMs,
    window.performance.now() + RECENT_CAPTURE_RECORD_TAIL_MS,
  );

  pushSpectrumInitialRenderTraceEntry(
    "capture-complete",
    {
      durationMs: window.performance.now() - capture.startedAt,
      frameCount: capture.frameCount,
      longFrameCount: capture.longFrameCount,
      maxFrameDeltaMs: capture.maxFrameDeltaMs,
      reason,
      totalDroppedFrameEstimate: capture.totalDroppedFrameEstimate,
    },
    captureId,
  );
}

function sampleSpectrumInitialRenderFrames(captureId: number) {
  if (typeof window === "undefined") {
    return;
  }

  const capture = activeCaptures.get(captureId);
  if (!capture) {
    return;
  }

  capture.frameId = window.requestAnimationFrame((frameTime) => {
    const current = activeCaptures.get(captureId);
    if (!current) {
      return;
    }

    current.frameId = null;
    const frameDeltaMs =
      current.previousFrameTime === null ? null : frameTime - current.previousFrameTime;
    const droppedFrameEstimate =
      frameDeltaMs === null ? 0 : Math.max(0, Math.floor(frameDeltaMs / FRAME_BUDGET_MS) - 1);
    const longFrame = frameDeltaMs !== null && frameDeltaMs > LONG_FRAME_THRESHOLD_MS;

    current.frameCount += 1;
    current.longFrameCount += longFrame ? 1 : 0;
    current.maxFrameDeltaMs =
      frameDeltaMs === null
        ? current.maxFrameDeltaMs
        : Math.max(current.maxFrameDeltaMs, frameDeltaMs);
    current.previousFrameTime = frameTime;
    current.totalDroppedFrameEstimate += droppedFrameEstimate;

    pushSpectrumInitialRenderTraceEntry(
      "frame",
      {
        droppedFrameEstimate,
        frameDeltaMs,
        frameIndex: current.frameCount - 1,
        frameTime,
        longFrame,
        relativeFrameTimeMs: frameTime - current.startedAt,
      },
      captureId,
    );

    if (
      current.frameCount >= MAX_CAPTURE_FRAMES ||
      frameTime - current.startedAt >= MAX_CAPTURE_MS
    ) {
      finishSpectrumInitialRenderCapture(captureId, "frame-window-complete");
      return;
    }

    sampleSpectrumInitialRenderFrames(captureId);
  });
}

export function startSpectrumInitialRenderTraceCapture(args: SpectrumInitialRenderCaptureStart) {
  if (typeof window === "undefined") {
    return null;
  }

  ensureSpectrumInitialRenderTraceInstalled();
  const existingCaptureId = findActiveCaptureIdForSession(args.sessionKey);
  if (existingCaptureId !== null) {
    pushSpectrumInitialRenderTraceEntry(
      "capture-reused",
      {
        reason: args.reason,
        sessionKey: args.sessionKey,
      },
      existingCaptureId,
    );
    return existingCaptureId;
  }

  const captureId = captureSequence++;
  const startedAt = window.performance.now();
  const capture: SpectrumInitialRenderCapture = {
    frameCount: 0,
    frameId: null,
    longFrameCount: 0,
    longTaskObserver: observeLongTasks(captureId, startedAt),
    maxFrameDeltaMs: 0,
    previousFrameTime: null,
    sessionKey: args.sessionKey,
    startedAt,
    totalDroppedFrameEstimate: 0,
  };

  activeCaptures.set(captureId, capture);
  recentRecordUntilMs = Math.max(recentRecordUntilMs, startedAt + MAX_CAPTURE_MS);

  pushSpectrumInitialRenderTraceEntry(
    "capture-start",
    {
      ...args,
      frameBudgetMs: FRAME_BUDGET_MS,
      maxCaptureFrames: MAX_CAPTURE_FRAMES,
      maxCaptureMs: MAX_CAPTURE_MS,
      startedAt,
    },
    captureId,
  );
  sampleSpectrumInitialRenderFrames(captureId);

  return captureId;
}

export function recordSpectrumInitialRenderProfiler(args: SpectrumInitialRenderProfilerEntry) {
  if (typeof window === "undefined") {
    return;
  }

  const captureId =
    args.phase === "mount"
      ? startSpectrumInitialRenderTraceCapture({
          commitTime: args.commitTime,
          durationMs: args.durationMs,
          filePathKey: args.filePathKey,
          hasFilePath: args.hasFilePath,
          reason: "react-profiler",
          sessionKey: args.sessionKey,
          status: args.status,
          summaryCacheKey: args.summaryCacheKey,
        })
      : resolveLatestActiveCaptureId();

  if (captureId === null && !shouldRecordSpectrumInitialRenderWork()) {
    return;
  }

  ensureSpectrumInitialRenderTraceInstalled();
  pushSpectrumInitialRenderTraceEntry(
    "react-profiler",
    {
      actualDuration: args.actualDuration,
      baseDuration: args.baseDuration,
      commitTime: args.commitTime,
      durationMs: args.durationMs,
      filePathKey: args.filePathKey,
      hasFilePath: args.hasFilePath,
      id: args.id,
      phase: args.phase,
      sessionKey: args.sessionKey,
      startTime: args.startTime,
      status: args.status,
      summaryCacheKey: args.summaryCacheKey,
    },
    captureId,
  );
}

export function recordSpectrumInitialRenderWork(
  event: string,
  payload: Record<string, unknown> = {},
) {
  if (!shouldRecordSpectrumInitialRenderWork()) {
    return;
  }

  ensureSpectrumInitialRenderTraceInstalled();
  pushSpectrumInitialRenderTraceEntry(event, payload, resolveLatestActiveCaptureId());
}

export function measureSpectrumInitialRenderWork<T>(
  event: string,
  payload: Record<string, unknown>,
  work: () => T,
) {
  if (!shouldRecordSpectrumInitialRenderWork()) {
    return work();
  }

  const startedAt = readNow();
  try {
    return work();
  } finally {
    recordSpectrumInitialRenderWork(event, {
      ...payload,
      durationMs: readNow() - startedAt,
    });
  }
}

async function saveSpectrumInitialRenderTrace() {
  if (typeof window === "undefined") {
    return null;
  }

  const path = await join(
    await downloadDir(),
    `spectrum-initial-render-trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[spectrumInitialRenderTrace] saved ${path}`);
  return path;
}
