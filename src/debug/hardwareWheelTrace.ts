import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { crab } from "@/src/cmd";

type HardwareWheelFrontendTraceEntry = {
  event: string;
  isoTime: string;
  payload: Record<string, unknown>;
  performanceNow: number;
  seq: number;
  source: "frontend";
};

type HardwareWheelBackendTraceEntry = {
  elapsed_ms: number;
  event: string;
  payload_json: string;
  seq: number;
  source: "backend";
  thread: string;
  unix_ms: number;
};

type HardwareWheelTraceEntry = HardwareWheelBackendTraceEntry | HardwareWheelFrontendTraceEntry;

type HardwareWheelTraceApi = {
  clear: () => Promise<void>;
  entries: () => HardwareWheelFrontendTraceEntry[];
  record: (event: string, payload?: Record<string, unknown>) => void;
  save: () => Promise<string | null>;
};

declare global {
  interface Window {
    __hardwareWheelTraceApi?: HardwareWheelTraceApi;
    __hardwareWheelTraceInstalled?: boolean;
    saveHardwareWheelTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 20_000;

let sequence = 0;
const frontendEntries: HardwareWheelFrontendTraceEntry[] = [];

function trimFrontendEntries() {
  if (frontendEntries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  frontendEntries.splice(0, frontendEntries.length - MAX_TRACE_ENTRIES);
}

function parseBackendPayload(entry: { payload_json: string }) {
  try {
    return JSON.parse(entry.payload_json) as unknown;
  } catch {
    return entry.payload_json;
  }
}

function normalizeBackendEntry(entry: {
  elapsed_ms: number;
  event: string;
  payload_json: string;
  seq: number;
  thread: string;
  unix_ms: number;
}): HardwareWheelBackendTraceEntry {
  return {
    ...entry,
    payload_json: JSON.stringify(parseBackendPayload(entry)),
    source: "backend",
  };
}

function resolveMergedTraceEntries(
  backendEntries: Array<{
    elapsed_ms: number;
    event: string;
    payload_json: string;
    seq: number;
    thread: string;
    unix_ms: number;
  }>,
) {
  const normalizedBackendEntries = backendEntries.map(normalizeBackendEntry);
  const merged = [
    ...normalizedBackendEntries,
    ...frontendEntries.map((entry) => ({ ...entry })),
  ] satisfies HardwareWheelTraceEntry[];

  return merged.sort((left, right) => {
    const leftTime = "unix_ms" in left ? left.unix_ms : Date.parse(left.isoTime);
    const rightTime = "unix_ms" in right ? right.unix_ms : Date.parse(right.isoTime);

    return leftTime - rightTime || left.seq - right.seq;
  });
}

export function recordHardwareWheelTrace(event: string, payload: Record<string, unknown> = {}) {
  if (typeof window === "undefined") {
    return;
  }

  const entry = {
    event,
    isoTime: new Date().toISOString(),
    payload,
    performanceNow: window.performance.now(),
    seq: sequence++,
    source: "frontend",
  } satisfies HardwareWheelFrontendTraceEntry;

  frontendEntries.push(entry);
  trimFrontendEntries();
}

async function clearHardwareWheelTrace() {
  frontendEntries.length = 0;
  sequence = 0;
  await crab.clearHardwareHorizontalWheelTrace();
  recordHardwareWheelTrace("frontend.trace-cleared");
}

async function saveHardwareWheelTrace() {
  if (typeof window === "undefined") {
    return null;
  }

  const backendEntries = await crab.getHardwareHorizontalWheelTraceEntries();
  const merged = resolveMergedTraceEntries(backendEntries);
  const path = await join(
    await downloadDir(),
    `hardware-wheel-trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = merged.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[hardwareWheelTrace] saved ${path}`);
  return path;
}

export function installHardwareWheelTrace() {
  if (typeof window === "undefined" || window.__hardwareWheelTraceInstalled) {
    return;
  }

  const api: HardwareWheelTraceApi = {
    clear: clearHardwareWheelTrace,
    entries() {
      return frontendEntries.slice();
    },
    record: recordHardwareWheelTrace,
    save: saveHardwareWheelTrace,
  };

  window.__hardwareWheelTraceApi = api;
  window.__hardwareWheelTraceInstalled = true;
  window.saveHardwareWheelTrace = () =>
    window.__hardwareWheelTraceApi?.save() ?? Promise.resolve(null);
  recordHardwareWheelTrace("frontend.trace-installed");
}
