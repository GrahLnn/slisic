import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

type PlaybackTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

type PlaybackTraceApi = {
  clear: () => void;
  entries: () => PlaybackTraceEntry[];
  save: () => Promise<string | null>;
};

declare global {
  interface Window {
    __playbackTraceInstalled?: boolean;
    __playbackTraceApi?: PlaybackTraceApi;
    __PLAYBACK_TRACE_CONSOLE__?: boolean;
    savePlaybackTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 6_000;

let sequence = 0;
const entries: PlaybackTraceEntry[] = [];

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

export function recordPlaybackTrace(event: string, payload: Record<string, unknown> = {}) {
  if (typeof window === "undefined") {
    return;
  }

  const entry = {
    seq: sequence++,
    isoTime: new Date().toISOString(),
    performanceNow: window.performance.now(),
    event,
    payload,
  } satisfies PlaybackTraceEntry;

  entries.push(entry);
  trimEntries();

  if (window.__PLAYBACK_TRACE_CONSOLE__ !== false) {
    console.log(`[playbackTrace] ${event}`, entry);
  }
}

async function savePlaybackTrace() {
  if (typeof window === "undefined") {
    return null;
  }

  const path = await join(
    await downloadDir(),
    `playback-trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[playbackTrace] saved ${path}`);
  return path;
}

export function installPlaybackTrace() {
  if (typeof window === "undefined" || window.__playbackTraceInstalled) {
    return;
  }

  const api: PlaybackTraceApi = {
    clear() {
      entries.length = 0;
      sequence = 0;
      recordPlaybackTrace("trace-cleared");
    },
    entries() {
      return entries.slice();
    },
    save: savePlaybackTrace,
  };

  window.__playbackTraceInstalled = true;
  window.__playbackTraceApi = api;
  window.savePlaybackTrace = api.save;

  recordPlaybackTrace("trace-installed", {
    href: window.location.href,
  });
}
