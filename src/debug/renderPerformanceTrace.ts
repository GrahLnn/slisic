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
  enabledProbes: RenderPerformanceTraceProbe[];
  entryCount: number;
  eventCounts: Record<string, number>;
};

export type RenderPerformanceTraceProbe =
  | "app-logic-state"
  | "app-viewport"
  | "list-config-check"
  | "playback-diagnostics"
  | "playback-mode-effect"
  | "playlist-page"
  | "playlist-playback"
  | "spectrum-flow"
  | "trace-lifecycle";

type RenderPerformanceTraceApi = {
  clear: () => void;
  enabledProbes: () => RenderPerformanceTraceProbe[];
  entries: () => RenderPerformanceTraceEntry[];
  record: (event: string, payload?: Record<string, unknown>) => void;
  save: () => Promise<string | null>;
  setEnabledProbes: (probes: readonly RenderPerformanceTraceProbe[]) => void;
  summary: () => RenderPerformanceTraceSummary;
};

export type RenderPerformanceTraceInstallOptions = {
  enabledProbes?: readonly RenderPerformanceTraceProbe[];
};

type RenderPerformanceTraceRegistration =
  | {
      event: string;
      probe: RenderPerformanceTraceProbe;
    }
  | {
      eventPrefix: string;
      probe: RenderPerformanceTraceProbe;
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
let enabledProbes = new Set<RenderPerformanceTraceProbe>();

export const renderPerformanceTraceRegistry = [
  { event: "trace-installed", probe: "trace-lifecycle" },
  { event: "trace-cleared", probe: "trace-lifecycle" },
  { event: "app-viewport-projected", probe: "app-viewport" },
  { eventPrefix: "app-state-", probe: "app-logic-state" },
  { eventPrefix: "app-back-", probe: "app-logic-state" },
  { eventPrefix: "app-playback-mode-effect-", probe: "playback-mode-effect" },
  { eventPrefix: "playlist-page-", probe: "playlist-page" },
  { event: "playlist-open-spectrum-click", probe: "playlist-page" },
  { eventPrefix: "list-config-check-", probe: "list-config-check" },
  { eventPrefix: "playlist-play-action-", probe: "playlist-playback" },
  { eventPrefix: "playlist-play-invoke-", probe: "playlist-playback" },
  { eventPrefix: "player-now-playing-", probe: "playlist-playback" },
  { eventPrefix: "download-task-change-", probe: "playlist-playback" },
  { eventPrefix: "playback-exclude-skip-", probe: "playlist-playback" },
  { eventPrefix: "playlist-playable-index-", probe: "playback-diagnostics" },
  { eventPrefix: "spectrum-", probe: "spectrum-flow" },
] satisfies RenderPerformanceTraceRegistration[];

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

export function isRenderPerformanceTraceInstalled() {
  return typeof window !== "undefined" && window.__renderPerformanceTraceInstalled === true;
}

export function resolveRenderPerformanceTraceProbe(
  event: string,
): RenderPerformanceTraceProbe | null {
  for (const registration of renderPerformanceTraceRegistry) {
    if ("event" in registration && registration.event === event) {
      return registration.probe;
    }

    if (
      "eventPrefix" in registration &&
      registration.eventPrefix !== undefined &&
      event.startsWith(registration.eventPrefix)
    ) {
      return registration.probe;
    }
  }

  return null;
}

export function setEnabledRenderPerformanceTraceProbes(
  probes: readonly RenderPerformanceTraceProbe[],
) {
  enabledProbes = new Set(probes);
}

export function getEnabledRenderPerformanceTraceProbes() {
  return [...enabledProbes];
}

export function shouldRecordRenderPerformanceTraceEvent(args: {
  enabled: ReadonlySet<RenderPerformanceTraceProbe>;
  event: string;
}) {
  const probe = resolveRenderPerformanceTraceProbe(args.event);
  return probe !== null && args.enabled.has(probe);
}

export function recordTrace(event: string, payload: Record<string, unknown> = {}) {
  if (!isRenderPerformanceTraceInstalled()) {
    return;
  }

  const probe = resolveRenderPerformanceTraceProbe(event);
  if (probe === null || !enabledProbes.has(probe)) {
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

export function summarizeRenderPerformanceTraceEntries(
  traceEntries: readonly RenderPerformanceTraceEntry[] = entries,
): RenderPerformanceTraceSummary {
  const eventCounts: Record<string, number> = {};

  for (const entry of traceEntries) {
    eventCounts[entry.event] = (eventCounts[entry.event] ?? 0) + 1;
  }

  return {
    enabledProbes: getEnabledRenderPerformanceTraceProbes(),
    entryCount: traceEntries.length,
    eventCounts,
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

export function installRenderPerformanceTrace(options: RenderPerformanceTraceInstallOptions = {}) {
  if (typeof window === "undefined") {
    return;
  }

  setEnabledRenderPerformanceTraceProbes(options.enabledProbes ?? []);

  if (window.__renderPerformanceTraceInstalled) {
    return;
  }

  const api: RenderPerformanceTraceApi = {
    clear() {
      entries.length = 0;
      sequence = 0;
      recordTrace("trace-cleared");
    },
    enabledProbes: getEnabledRenderPerformanceTraceProbes,
    entries() {
      return [...entries];
    },
    record: recordTrace,
    save: saveRenderPerformanceTrace,
    setEnabledProbes: setEnabledRenderPerformanceTraceProbes,
    summary: () => summarizeRenderPerformanceTraceEntries(),
  };

  window.__renderPerformanceTraceInstalled = true;
  window.__renderPerformanceTraceApi = api;
  window.saveRenderPerformanceTrace = api.save;

  recordTrace("trace-installed", {
    href: window.location.href,
  });
}
