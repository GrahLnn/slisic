import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

type SpectrumWaveformTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

type SpectrumWaveformTraceApi = {
  clear: () => void;
  entries: () => SpectrumWaveformTraceEntry[];
  save: () => Promise<string | null>;
};

declare global {
  interface Window {
    __spectrumWaveformTraceInstalled?: boolean;
    __spectrumWaveformTraceApi?: SpectrumWaveformTraceApi;
    __SPECTRUM_WAVEFORM_TRACE_CONSOLE__?: boolean;
    saveSpectrumWaveformTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 10_000;

let sequence = 0;
const entries: SpectrumWaveformTraceEntry[] = [];

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

export function recordSpectrumWaveformTrace(event: string, payload: Record<string, unknown> = {}) {
  if (typeof window === "undefined" || !window.__spectrumWaveformTraceInstalled) {
    return;
  }

  const entry = {
    seq: sequence++,
    isoTime: new Date().toISOString(),
    performanceNow: window.performance.now(),
    event,
    payload,
  } satisfies SpectrumWaveformTraceEntry;

  entries.push(entry);
  trimEntries();

  if (window.__SPECTRUM_WAVEFORM_TRACE_CONSOLE__ === true) {
    console.log(`[spectrumWaveformTrace] ${event}`, entry);
  }
}

async function saveSpectrumWaveformTrace() {
  if (typeof window === "undefined") {
    return null;
  }

  const path = await join(
    await downloadDir(),
    `spectrum-waveform-trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[spectrumWaveformTrace] saved ${path}`);
  return path;
}

export function installSpectrumWaveformTrace() {
  if (typeof window === "undefined" || window.__spectrumWaveformTraceInstalled) {
    return;
  }

  const api: SpectrumWaveformTraceApi = {
    clear() {
      entries.length = 0;
      sequence = 0;
      recordSpectrumWaveformTrace("trace-cleared");
    },
    entries() {
      return entries.slice();
    },
    save: saveSpectrumWaveformTrace,
  };

  window.__spectrumWaveformTraceInstalled = true;
  window.__spectrumWaveformTraceApi = api;
  window.saveSpectrumWaveformTrace = api.save;

  recordSpectrumWaveformTrace("trace-installed", {
    href: window.location.href,
  });
}
