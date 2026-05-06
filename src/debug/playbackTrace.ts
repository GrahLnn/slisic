import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { crab, type PlaybackTraceEvent } from "@/src/cmd";

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
    __playbackTraceEventUnlisten?: () => void;
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

  if (!window.__playbackTraceInstalled) {
    installPlaybackTrace();
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

  if (window.__PLAYBACK_TRACE_CONSOLE__ === true) {
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
    },
    entries() {
      return entries.slice();
    },
    save: savePlaybackTrace,
  };

  window.__playbackTraceInstalled = true;
  window.__playbackTraceApi = api;
  window.savePlaybackTrace = api.save;

  void crab
    .evt("playbackTraceEvent")((payload: PlaybackTraceEvent) => {
      recordPlaybackTrace(`backend:${payload.event}`, {
        durationMs: payload.duration_ms,
        endMs: payload.end_ms,
        generation: payload.generation,
        mode: payload.mode,
        musicUrl: payload.music_url,
        path: payload.path,
        playlistName: payload.playlist_name,
        positionMs: payload.position_ms,
        reason: payload.reason,
        startMs: payload.start_ms,
        statusPath: payload.status_path,
      });
    })
    .then((unlisten) => {
      window.__playbackTraceEventUnlisten = unlisten;
    })
    .catch((error) => {
      console.error("Failed to subscribe to playback trace events", error);
    });
}
