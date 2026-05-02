type WaveformTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

type WaveformTraceApi = {
  clear: () => void;
  entries: () => WaveformTraceEntry[];
  isDetailEnabled: () => boolean;
  save: () => Promise<string | null>;
  text: () => string;
};

declare global {
  interface Window {
    __WAVEFORM_TRACE_CONSOLE__?: boolean;
    __waveformTraceApi?: WaveformTraceApi;
    __waveformTraceInstalled?: boolean;
    saveWaveformTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 12_000;

let sequence = 0;
const entries: WaveformTraceEntry[] = [];

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

export function isWaveformTraceEnabled() {
  return typeof window !== "undefined";
}

export function isWaveformTraceDetailEnabled() {
  return isWaveformTraceEnabled();
}

export function recordWaveformTrace(event: string, payload: Record<string, unknown> = {}) {
  if (typeof window === "undefined") {
    return;
  }

  const entry = {
    seq: sequence,
    isoTime: new Date().toISOString(),
    performanceNow: window.performance.now(),
    event,
    payload,
  } satisfies WaveformTraceEntry;

  sequence += 1;
  entries.push(entry);
  trimEntries();

  if (window.__WAVEFORM_TRACE_CONSOLE__) {
    console.log(`[waveformTrace] ${event}`, entry);
  }
}

function serializeEntries() {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

async function saveWaveformTrace() {
  if (typeof window === "undefined") {
    return null;
  }

  const [{ downloadDir, join }, { writeTextFile }] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const path = await join(
    await downloadDir(),
    `waveform-trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );

  await writeTextFile(path, serializeEntries());
  console.log(`[waveformTrace] saved ${path}`);
  return path;
}

export function installWaveformTrace() {
  if (typeof window === "undefined" || window.__waveformTraceInstalled) {
    return;
  }

  const api: WaveformTraceApi = {
    clear() {
      entries.length = 0;
      sequence = 0;
      recordWaveformTrace("trace-cleared");
    },
    entries() {
      return entries.slice();
    },
    isDetailEnabled: isWaveformTraceDetailEnabled,
    save: saveWaveformTrace,
    text: serializeEntries,
  };

  window.__waveformTraceInstalled = true;
  window.__waveformTraceApi = api;
  window.saveWaveformTrace = api.save;

  recordWaveformTrace("trace-installed", {
    auto: true,
    detail: true,
    href: window.location.href,
  });
}
