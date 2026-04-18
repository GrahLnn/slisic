import { downloadDir, join } from "@tauri-apps/api/path";
import { BaseDirectory, writeTextFile } from "@tauri-apps/plugin-fs";

type ConsoleMethod = "log" | "warn" | "error";

export type UiTraceEntry = {
  sessionId: string;
  seq: number;
  at: string;
  sinceStartMs: number;
  scope: string;
  event: string;
  data: unknown;
};

export type UiTraceWindowApi = {
  clear: () => void;
  entries: () => UiTraceEntry[];
  save: (label?: string) => Promise<string>;
};

type UiTraceNodeRecord = {
  scope: string;
  key: string;
  node: Element;
  data: unknown;
};

const MAX_UI_TRACE_ENTRIES = 60_000;
const startedAt =
  typeof performance === "undefined" ? Date.now() : performance.now();
const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const entries: UiTraceEntry[] = [];
const nodeRegistry = new Map<string, UiTraceNodeRecord>();
const originalConsole: Partial<Record<ConsoleMethod, typeof console.log>> = {};
let installed = false;
let consolePatched = false;
let sequence = 0;
let consoleRecordDepth = 0;

declare global {
  interface Window {
    uiTrace?: UiTraceWindowApi;
    save: (label?: string) => Promise<string>;
  }
}

function nowMs() {
  return typeof performance === "undefined"
    ? Date.now() - startedAt
    : performance.now() - startedAt;
}

function sanitizeLabel(label: string) {
  const trimmed = label.trim().toLowerCase();
  const collapsed = trimmed.replace(/\s+/g, "-");
  const safe = collapsed.replace(/[^a-z0-9-_]/g, "");

  return safe.length > 0 ? safe : "capture";
}

function serialize(value: unknown, depth = 0): unknown {
  if (depth > 5) {
    return "[MaxDepth]";
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serialize(item, depth + 1));
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (typeof value !== "object") {
    return String(value);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
      key,
      serialize(nestedValue, depth + 1),
    ]),
  );
}

function appendEntry(scope: string, event: string, data: unknown) {
  const entry: UiTraceEntry = {
    sessionId,
    seq: sequence++,
    at: new Date().toISOString(),
    sinceStartMs: Number(nowMs().toFixed(3)),
    scope,
    event,
    data: serialize(data),
  };

  if (entries.length >= MAX_UI_TRACE_ENTRIES) {
    entries.shift();
  }

  entries.push(entry);
}

function writeTraceConsole(method: ConsoleMethod, message: string, ...rest: unknown[]) {
  const writer = originalConsole[method];

  if (writer) {
    writer(message, ...rest);
    return;
  }

  console[method](message, ...rest);
}

export function snapshotUiTraceElement(node: Element | null) {
  if (!node || typeof window === "undefined") {
    return null;
  }

  const element = node as HTMLElement;
  const rect = element.getBoundingClientRect();
  const computed = window.getComputedStyle(element);

  return {
    childElementCount: element.childElementCount,
    className: element.className,
    computedOpacity: computed.opacity,
    display: computed.display,
    inlineOpacity: element.style.opacity || null,
    inlineTransform: element.style.transform || null,
    pointerEvents: computed.pointerEvents,
    rect: {
      height: Number(rect.height.toFixed(3)),
      left: Number(rect.left.toFixed(3)),
      top: Number(rect.top.toFixed(3)),
      width: Number(rect.width.toFixed(3)),
    },
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    tagName: node.tagName.toLowerCase(),
    visibility: computed.visibility,
  };
}

function snapshotRegisteredNodes() {
  return Array.from(nodeRegistry.values()).map((record) => ({
    scope: record.scope,
    key: record.key,
    data: serialize(record.data),
    snapshot: snapshotUiTraceElement(record.node),
  }));
}

export function sampleUiTraceFrames(args: {
  durationMs?: number;
  label: string;
  scope: string;
}) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const durationMs = args.durationMs ?? 1200;
  const sampleStartedAt = performance.now();
  let frame = 0;
  let frameId: number | null = null;
  let stopped = false;

  const captureFrame = () => {
    if (stopped) {
      return;
    }

    const elapsedMs = performance.now() - sampleStartedAt;

    appendEntry(args.scope, "frame-sample", {
      elapsedMs: Number(elapsedMs.toFixed(3)),
      frame,
      label: args.label,
      nodes: snapshotRegisteredNodes(),
    });
    frame += 1;

    if (elapsedMs >= durationMs) {
      return;
    }

    frameId = window.requestAnimationFrame(captureFrame);
  };

  appendEntry(args.scope, "frame-sample-start", {
    durationMs,
    label: args.label,
    nodes: snapshotRegisteredNodes(),
  });
  frameId = window.requestAnimationFrame(captureFrame);

  return () => {
    stopped = true;

    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
    }

    appendEntry(args.scope, "frame-sample-stop", {
      frameCount: frame,
      label: args.label,
      nodes: snapshotRegisteredNodes(),
    });
  };
}

export function recordUiTrace(scope: string, event: string, data: unknown = {}) {
  appendEntry(scope, event, data);
}

export function registerUiTraceNode(args: {
  scope: string;
  key: string;
  node: Element | null;
  data?: unknown;
}) {
  const registryKey = `${args.scope}:${args.key}`;

  if (!args.node) {
    const current = nodeRegistry.get(registryKey);
    nodeRegistry.delete(registryKey);
    appendEntry(args.scope, "node-detached", {
      key: args.key,
      previous: current ? snapshotUiTraceElement(current.node) : null,
    });
    return;
  }

  nodeRegistry.set(registryKey, {
    scope: args.scope,
    key: args.key,
    node: args.node,
    data: args.data ?? null,
  });
  appendEntry(args.scope, "node-attached", {
    key: args.key,
    data: args.data ?? null,
    snapshot: snapshotUiTraceElement(args.node),
  });
}

async function saveUiTraceLog(label?: string) {
  const fileName = `${sanitizeLabel(label ?? "capture")}.${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.${sessionId}.jsonl`;
  const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(fileName, payload.length > 0 ? `${payload}\n` : "", {
    baseDir: BaseDirectory.Download,
  });

  const absolutePath = await join(await downloadDir(), fileName);
  writeTraceConsole("log", `[uiTrace] saved ${absolutePath}`);

  return absolutePath;
}

function installWindowApi() {
  const api: UiTraceWindowApi = {
    clear: () => {
      entries.length = 0;
      appendEntry("ui-trace", "buffer-cleared", {});
    },
    entries: () => [...entries],
    save: async (label?: string) => saveUiTraceLog(label),
  };

  window.uiTrace = api;
  window.save = api.save;
}

function installConsoleCapture() {
  if (consolePatched) {
    return;
  }

  for (const method of ["log", "warn", "error"] as const) {
    originalConsole[method] = console[method].bind(console);

    console[method] = ((...args: unknown[]) => {
      if (consoleRecordDepth === 0) {
        consoleRecordDepth += 1;

        try {
          appendEntry("console", method, { args });
        } finally {
          consoleRecordDepth -= 1;
        }
      }

      return originalConsole[method]?.(...args);
    }) as typeof console.log;
  }

  consolePatched = true;
}

export async function startUiTraceCapture() {
  if (installed || typeof window === "undefined") {
    return;
  }

  installed = true;
  installConsoleCapture();
  installWindowApi();

  appendEntry("ui-trace", "capture-started", {
    maxEntries: MAX_UI_TRACE_ENTRIES,
    sessionId,
  });
  writeTraceConsole(
    "log",
    "[uiTrace] capture ready. Use window.save() to export the current trace.",
  );
}
