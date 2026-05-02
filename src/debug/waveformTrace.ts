type WaveformTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

type WaveformTraceApi = {
  clear: () => void;
  disable: () => void;
  disableDetail: () => void;
  enable: () => void;
  enableDetail: () => void;
  entries: () => WaveformTraceEntry[];
  isDetailEnabled: () => boolean;
  isEnabled: () => boolean;
  save: () => Promise<string | null>;
  text: () => string;
};

declare global {
  interface Window {
    __WAVEFORM_TRACE_CONSOLE__?: boolean;
    __WAVEFORM_TRACE_DETAIL__?: boolean;
    __WAVEFORM_TRACE_ENABLED__?: boolean;
    __waveformTraceApi?: WaveformTraceApi;
    __waveformTraceInstalled?: boolean;
    saveWaveformTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 12_000;
const TRACE_DETAIL_STORAGE_KEY = "__WAVEFORM_TRACE_DETAIL__";
const TRACE_STORAGE_KEY = "__WAVEFORM_TRACE__";

let sequence = 0;
const entries: WaveformTraceEntry[] = [];

function readStoredTraceEnabled() {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    return window.localStorage.getItem(TRACE_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeStoredTraceEnabled(enabled: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (enabled) {
      window.localStorage.removeItem(TRACE_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(TRACE_STORAGE_KEY, "0");
  } catch {
    // localStorage can be unavailable in restricted webviews; the in-memory flag still works.
  }
}

function readStoredTraceDetailEnabled() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(TRACE_DETAIL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredTraceDetailEnabled(enabled: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (enabled) {
      window.localStorage.setItem(TRACE_DETAIL_STORAGE_KEY, "1");
      return;
    }

    window.localStorage.removeItem(TRACE_DETAIL_STORAGE_KEY);
  } catch {
    // localStorage can be unavailable in restricted webviews; the in-memory flag still works.
  }
}

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

export function isWaveformTraceEnabled() {
  if (typeof window === "undefined") {
    return false;
  }

  if (typeof window.__WAVEFORM_TRACE_ENABLED__ !== "boolean") {
    window.__WAVEFORM_TRACE_ENABLED__ = readStoredTraceEnabled();
  }

  return window.__WAVEFORM_TRACE_ENABLED__ === true;
}

export function isWaveformTraceDetailEnabled() {
  if (typeof window === "undefined" || !isWaveformTraceEnabled()) {
    return false;
  }

  if (typeof window.__WAVEFORM_TRACE_DETAIL__ !== "boolean") {
    window.__WAVEFORM_TRACE_DETAIL__ = readStoredTraceDetailEnabled();
  }

  return window.__WAVEFORM_TRACE_DETAIL__ === true;
}

export function recordWaveformTrace(event: string, payload: Record<string, unknown> = {}) {
  if (typeof window === "undefined" || !isWaveformTraceEnabled()) {
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

  if (typeof window.__WAVEFORM_TRACE_ENABLED__ !== "boolean") {
    window.__WAVEFORM_TRACE_ENABLED__ = readStoredTraceEnabled();
  }

  const api: WaveformTraceApi = {
    clear() {
      entries.length = 0;
      sequence = 0;
      recordWaveformTrace("trace-cleared");
    },
    disable() {
      window.__WAVEFORM_TRACE_ENABLED__ = false;
      writeStoredTraceEnabled(false);
    },
    disableDetail() {
      window.__WAVEFORM_TRACE_DETAIL__ = false;
      writeStoredTraceDetailEnabled(false);
      recordWaveformTrace("trace-detail-disabled", {
        href: window.location.href,
      });
    },
    enable() {
      window.__WAVEFORM_TRACE_ENABLED__ = true;
      writeStoredTraceEnabled(true);
      recordWaveformTrace("trace-enabled", {
        href: window.location.href,
      });
    },
    enableDetail() {
      window.__WAVEFORM_TRACE_DETAIL__ = true;
      writeStoredTraceDetailEnabled(true);
      recordWaveformTrace("trace-detail-enabled", {
        href: window.location.href,
      });
    },
    entries() {
      return entries.slice();
    },
    isDetailEnabled: isWaveformTraceDetailEnabled,
    isEnabled: isWaveformTraceEnabled,
    save: saveWaveformTrace,
    text: serializeEntries,
  };

  window.__waveformTraceInstalled = true;
  window.__waveformTraceApi = api;
  window.saveWaveformTrace = api.save;

  recordWaveformTrace("trace-installed", {
    href: window.location.href,
  });
}
