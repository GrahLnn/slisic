import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

export type RenderPerformanceTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

type RenderPerformanceTraceApi = {
  clear: () => void;
  entries: () => RenderPerformanceTraceEntry[];
  record: (event: string, payload?: Record<string, unknown>) => void;
  save: () => Promise<string | null>;
};

declare global {
  interface Window {
    __renderPerformanceTraceApi?: RenderPerformanceTraceApi;
    __renderPerformanceTraceInstalled?: boolean;
    saveRenderPerformanceTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 8_000;

let sequence = 0;
const entries: RenderPerformanceTraceEntry[] = [];

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

export function isRenderPerformanceTraceInstalled() {
  return typeof window !== "undefined" && window.__renderPerformanceTraceInstalled === true;
}

export function recordRenderPerformanceTrace(event: string, payload: Record<string, unknown> = {}) {
  if (!isRenderPerformanceTraceInstalled()) {
    return;
  }

  entries.push({
    seq: sequence++,
    isoTime: new Date().toISOString(),
    performanceNow: window.performance.now(),
    event,
    payload,
  });
  trimEntries();
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
  };

  window.__renderPerformanceTraceInstalled = true;
  window.__renderPerformanceTraceApi = api;
  window.saveRenderPerformanceTrace = api.save;

  recordRenderPerformanceTrace("trace-installed", {
    href: window.location.href,
  });
}
