import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

export type TraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

export type TraceSummary = {
  enabledProbes: TraceProbe[];
  entryCount: number;
  eventCounts: Record<string, number>;
};

export type TraceProbe =
  | "app-logic-state"
  | "app-viewport"
  | "config-title-check-flow"
  | "list-config-check"
  | "playback-diagnostics"
  | "playback-mode-effect"
  | "playlist-item-play-flow"
  | "playlist-page"
  | "playlist-playback"
  | "spectrum-flow"
  | "title-handoff-flow"
  | "trace-lifecycle";

type TraceApi = {
  clear: () => void;
  enabledProbes: () => TraceProbe[];
  entries: () => TraceEntry[];
  record: (event: string, payload?: Record<string, unknown>) => void;
  save: () => Promise<string | null>;
  setEnabledProbes: (probes: readonly TraceProbe[]) => void;
  summary: () => TraceSummary;
};

export type TraceInstallOptions = {
  enabledProbes?: readonly TraceProbe[];
};

type TraceRegistration =
  | {
      event: string;
      probe: TraceProbe;
    }
  | {
      eventPrefix: string;
      probe: TraceProbe;
    };

declare global {
  interface Window {
    __traceApi?: TraceApi;
    __traceInstalled?: boolean;
    saveTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 8_000;

let sequence = 0;
const entries: TraceEntry[] = [];
let enabledProbes = new Set<TraceProbe>();

export const traceRegistry = [
  { event: "trace-installed", probe: "trace-lifecycle" },
  { event: "trace-cleared", probe: "trace-lifecycle" },
  { event: "app-viewport-projected", probe: "app-viewport" },
  { eventPrefix: "app-state-", probe: "app-logic-state" },
  { eventPrefix: "app-back-", probe: "app-logic-state" },
  { eventPrefix: "app-playback-mode-effect-", probe: "playback-mode-effect" },
  { eventPrefix: "app-draft-name-", probe: "config-title-check-flow" },
  { eventPrefix: "app-playlist-upsert-", probe: "config-title-check-flow" },
  { eventPrefix: "app-title-handoff-", probe: "title-handoff-flow" },
  { eventPrefix: "config-title-", probe: "config-title-check-flow" },
  { eventPrefix: "editable-title-", probe: "config-title-check-flow" },
  { eventPrefix: "title-handoff-", probe: "title-handoff-flow" },
  { eventPrefix: "playlist-page-", probe: "playlist-page" },
  { event: "playlist-open-spectrum-click", probe: "playlist-page" },
  { eventPrefix: "list-config-check-", probe: "list-config-check" },
  { eventPrefix: "playlist-play-action-", probe: "playlist-playback" },
  { eventPrefix: "playlist-play-backend-", probe: "playlist-playback" },
  { eventPrefix: "playlist-play-continuation-", probe: "playlist-playback" },
  { eventPrefix: "playlist-play-invoke-", probe: "playlist-playback" },
  { eventPrefix: "playlist-play-initial-", probe: "playlist-playback" },
  { eventPrefix: "playlist-play-material-", probe: "playlist-playback" },
  { eventPrefix: "playlist-play-player-", probe: "playlist-playback" },
  { eventPrefix: "playlist-play-request-", probe: "playlist-playback" },
  { eventPrefix: "player-now-playing-", probe: "playlist-playback" },
  { eventPrefix: "player-playback-surface-status-", probe: "playlist-playback" },
  { eventPrefix: "download-task-change-", probe: "playlist-playback" },
  { eventPrefix: "playback-exclude-skip-", probe: "playlist-playback" },
  { eventPrefix: "playlist-playback-next-slot-", probe: "playlist-playback" },
  { eventPrefix: "playlist-playable-index-", probe: "playback-diagnostics" },
  { eventPrefix: "spectrum-", probe: "spectrum-flow" },
  { event: "trace-installed", probe: "playlist-item-play-flow" },
  { event: "trace-cleared", probe: "playlist-item-play-flow" },
  { event: "app-viewport-projected", probe: "playlist-item-play-flow" },
  { eventPrefix: "app-state-", probe: "playlist-item-play-flow" },
  { eventPrefix: "list-config-check-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-page-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-item-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-surface-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-play-action-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-play-backend-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-play-continuation-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-play-invoke-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-play-initial-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-play-material-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-play-player-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-play-request-", probe: "playlist-item-play-flow" },
  { eventPrefix: "player-now-playing-", probe: "playlist-item-play-flow" },
  { eventPrefix: "player-playback-surface-status-", probe: "playlist-item-play-flow" },
  { eventPrefix: "download-task-change-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playback-exclude-skip-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-playback-next-slot-", probe: "playlist-item-play-flow" },
  { eventPrefix: "playlist-playable-index-", probe: "playlist-item-play-flow" },
] satisfies TraceRegistration[];

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

export function isTraceInstalled() {
  return typeof window !== "undefined" && window.__traceInstalled === true;
}

export function resolveTraceProbe(
  event: string,
): TraceProbe | null {
  return resolveTraceProbes(event)[0] ?? null;
}

export function resolveTraceProbes(event: string): TraceProbe[] {
  const probes: TraceProbe[] = [];
  for (const registration of traceRegistry) {
    if ("event" in registration && registration.event === event) {
      probes.push(registration.probe);
      continue;
    }

    if (
      "eventPrefix" in registration &&
      registration.eventPrefix !== undefined &&
      event.startsWith(registration.eventPrefix)
    ) {
      probes.push(registration.probe);
    }
  }

  return probes;
}

export function setEnabledTraceProbes(probes: readonly TraceProbe[]) {
  enabledProbes = new Set(probes);
}

export function getEnabledTraceProbes() {
  return [...enabledProbes];
}

export function shouldRecordTraceEvent(args: {
  enabled: ReadonlySet<TraceProbe>;
  event: string;
}) {
  return resolveTraceProbes(args.event).some((probe) => args.enabled.has(probe));
}

export function recordTrace(event: string, payload: Record<string, unknown> = {}) {
  if (!isTraceInstalled()) {
    return;
  }

  if (!shouldRecordTraceEvent({ enabled: enabledProbes, event })) {
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

export function summarizeTraceEntries(
  traceEntries: readonly TraceEntry[] = entries,
): TraceSummary {
  const eventCounts: Record<string, number> = {};

  for (const entry of traceEntries) {
    eventCounts[entry.event] = (eventCounts[entry.event] ?? 0) + 1;
  }

  return {
    enabledProbes: getEnabledTraceProbes(),
    entryCount: traceEntries.length,
    eventCounts,
  };
}

async function saveTrace() {
  if (typeof window === "undefined") {
    return null;
  }

  const path = await join(
    await downloadDir(),
    `trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[trace] saved ${path}`);
  return path;
}

function deprecatedTraceGlobalKeys() {
  const legacyName = `${"render"}${"Performance"}${"Trace"}`;
  const legacyPublicName = `${"Render"}${"Performance"}${"Trace"}`;
  return [
    `__${legacyName}Api`,
    `__${legacyName}Installed`,
    `save${legacyPublicName}`,
  ];
}

function clearDeprecatedTraceGlobals() {
  const target = window as unknown as Record<string, unknown>;
  for (const key of deprecatedTraceGlobalKeys()) {
    delete target[key];
  }
}

function exposeTraceApi(api: TraceApi) {
  clearDeprecatedTraceGlobals();
  window.__traceApi = api;
  window.saveTrace = api.save;
}

function createTraceApi(): TraceApi {
  return {
    clear() {
      entries.length = 0;
      sequence = 0;
      recordTrace("trace-cleared");
    },
    enabledProbes: getEnabledTraceProbes,
    entries() {
      return [...entries];
    },
    record: recordTrace,
    save: saveTrace,
    setEnabledProbes: setEnabledTraceProbes,
    summary: () => summarizeTraceEntries(),
  };
}

export function installTrace(options: TraceInstallOptions = {}) {
  if (typeof window === "undefined") {
    return;
  }

  setEnabledTraceProbes(options.enabledProbes ?? []);

  if (window.__traceInstalled) {
    exposeTraceApi(createTraceApi());
    return;
  }

  const api = createTraceApi();

  window.__traceInstalled = true;
  exposeTraceApi(api);

  recordTrace("trace-installed", {
    href: window.location.href,
  });
}
