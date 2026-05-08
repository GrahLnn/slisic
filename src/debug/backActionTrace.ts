import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

type BackActionTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

type BackActionTraceApi = {
  clear: () => void;
  entries: () => BackActionTraceEntry[];
  save: () => Promise<string | null>;
};

declare global {
  interface Window {
    __backActionTraceInstalled?: boolean;
    __backActionTraceApi?: BackActionTraceApi;
    saveBackActionTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 4_000;

let sequence = 0;
const entries: BackActionTraceEntry[] = [];

function pushBackActionTraceEntry(entry: BackActionTraceEntry) {
  entries.push(entry);

  if (entries.length > MAX_TRACE_ENTRIES) {
    entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
  }
}

export function recordBackActionTrace(event: string, payload: Record<string, unknown> = {}) {
  if (typeof window === "undefined" || !window.__backActionTraceInstalled) {
    return;
  }

  pushBackActionTraceEntry({
    seq: sequence++,
    isoTime: new Date().toISOString(),
    performanceNow: window.performance.now(),
    event,
    payload,
  });
}

async function saveBackActionTrace() {
  if (typeof window === "undefined") {
    return null;
  }

  const directory = await downloadDir();
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const filename = `back-action-trace.${stamp}.${Date.now()}.jsonl`;
  const path = await join(directory, filename);
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[backActionTrace] saved ${path}`);
  return path;
}

export function installBackActionTrace() {
  if (typeof window === "undefined" || window.__backActionTraceInstalled) {
    return;
  }

  const api: BackActionTraceApi = {
    clear: () => {
      entries.length = 0;
      recordBackActionTrace("trace-cleared");
    },
    entries: () => entries.slice(),
    save: saveBackActionTrace,
  };

  window.__backActionTraceInstalled = true;
  window.__backActionTraceApi = api;
  window.saveBackActionTrace = api.save;

  recordBackActionTrace("trace-installed", {
    href: window.location.href,
  });
}
