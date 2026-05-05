import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

export type SpectrumTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

type SpectrumTraceApi = {
  clear: () => void;
  entries: () => SpectrumTraceEntry[];
  save: () => Promise<string | null>;
};

declare global {
  interface Window {
    __SPECTRUM_TRACE_CONSOLE__?: boolean;
    __spectrumTraceApi?: SpectrumTraceApi;
    __spectrumTraceInstalled?: boolean;
    saveSpectrumTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 12_000;

let sequence = 0;
const entries: SpectrumTraceEntry[] = [];

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

export function recordSpectrumTrace(event: string, payload: Record<string, unknown> = {}) {
  if (typeof window === "undefined") {
    return;
  }

  const entry = {
    event,
    isoTime: new Date().toISOString(),
    payload,
    performanceNow: window.performance.now(),
    seq: sequence++,
  } satisfies SpectrumTraceEntry;

  entries.push(entry);
  trimEntries();

  if (window.__SPECTRUM_TRACE_CONSOLE__ === true) {
    console.log(`[spectrumTrace] ${event}`, entry);
  }
}

async function saveSpectrumTrace() {
  if (typeof window === "undefined") {
    return null;
  }

  const path = await join(
    await downloadDir(),
    `spectrum-trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[spectrumTrace] saved ${path}`);
  return path;
}

export function installSpectrumTrace() {
  if (typeof window === "undefined" || window.__spectrumTraceInstalled) {
    return;
  }

  const api: SpectrumTraceApi = {
    clear() {
      entries.length = 0;
      sequence = 0;
      recordSpectrumTrace("trace-cleared");
    },
    entries() {
      return entries.slice();
    },
    save: saveSpectrumTrace,
  };

  window.__spectrumTraceInstalled = true;
  window.__spectrumTraceApi = api;
  window.saveSpectrumTrace = api.save;

  recordSpectrumTrace("trace-installed", {
    href: window.location.href,
  });
}
