import { getName } from "@tauri-apps/api/app";
import { appLogDir, join } from "@tauri-apps/api/path";
import { BaseDirectory, mkdir, writeTextFile } from "@tauri-apps/plugin-fs";

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

const UI_TRACE_DIR = "ui-trace";
const MAX_UI_TRACE_ENTRIES = 40_000;
const startedAt =
  typeof performance === "undefined" ? Date.now() : performance.now();
const sessionId = createUiTraceSessionId();
const entries: UiTraceEntry[] = [];
const originalConsole: Partial<Record<ConsoleMethod, typeof console.log>> = {};
let installed = false;
let consolePatched = false;
let sequence = 0;
let droppedEntries = 0;
let consoleRecordDepth = 0;

declare global {
  interface Window {
    arcTrackDebug?: UiTraceWindowApi;
    save: (label?: string) => Promise<string>;
  }
}

function createUiTraceSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeUiTraceLabel(label: string) {
  const trimmed = label.trim().toLowerCase();
  const collapsed = trimmed.replace(/\s+/g, "-");
  const safe = collapsed.replace(/[^a-z0-9-_]/g, "");

  return safe.length > 0 ? safe : "capture";
}

function serializeUiTraceData(value: unknown, depth = 0): unknown {
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
    return value.map((item) => serializeUiTraceData(item, depth + 1));
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (typeof value !== "object") {
    return String(value);
  }

  const objectValue = value as Record<string, unknown>;

  return Object.fromEntries(
    Object.entries(objectValue).map(([key, nestedValue]) => [
      key,
      serializeUiTraceData(nestedValue, depth + 1),
    ]),
  );
}

function nowMs() {
  return typeof performance === "undefined"
    ? Date.now() - startedAt
    : performance.now() - startedAt;
}

function writeUiTraceConsole(method: ConsoleMethod, message: string, ...rest: unknown[]) {
  const writer = originalConsole[method];

  if (writer) {
    writer(message, ...rest);
    return;
  }

  console[method](message, ...rest);
}

function appendUiTraceEntry(scope: string, event: string, data: unknown) {
  const entry: UiTraceEntry = {
    sessionId,
    seq: sequence++,
    at: new Date().toISOString(),
    sinceStartMs: Number(nowMs().toFixed(3)),
    scope,
    event,
    data: serializeUiTraceData(data),
  };

  if (entries.length >= MAX_UI_TRACE_ENTRIES) {
    entries.shift();
    droppedEntries += 1;
  }

  entries.push(entry);
}

function stringifyUiTraceEntries(input: readonly UiTraceEntry[]) {
  return input.map((entry) => JSON.stringify(entry)).join("\n");
}

function createUiTraceFileName(label?: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = sanitizeUiTraceLabel(label ?? "capture");

  return `${safeLabel}.${timestamp}.${sessionId}.jsonl`;
}

function installUiTraceWindowApi() {
  const api: UiTraceWindowApi = {
    clear: () => {
      entries.length = 0;
      droppedEntries = 0;
      appendUiTraceEntry("ui-trace", "buffer-cleared", {});
    },
    entries: () => [...entries],
    save: async (label?: string) => saveUiTraceLog(label),
  };

  window.arcTrackDebug = api;
  window.save = api.save;
}

function installUiTraceConsoleCapture() {
  if (consolePatched) {
    return;
  }

  for (const method of ["log", "warn", "error"] as const) {
    originalConsole[method] = console[method].bind(console);

    console[method] = ((...args: unknown[]) => {
      if (consoleRecordDepth === 0) {
        consoleRecordDepth += 1;

        try {
          appendUiTraceEntry("console", method, {
            args,
          });
        } finally {
          consoleRecordDepth -= 1;
        }
      }

      return originalConsole[method]?.(...args);
    }) as typeof console.log;
  }

  consolePatched = true;
}

function installUiTraceWindowErrorCapture() {
  window.addEventListener("error", (event) => {
    appendUiTraceEntry("window", "error", {
      colno: event.colno,
      error: event.error,
      filename: event.filename,
      lineno: event.lineno,
      message: event.message,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    appendUiTraceEntry("window", "unhandledrejection", {
      reason: event.reason,
    });
  });
}

export function recordUiTrace(scope: string, event: string, data: unknown = {}) {
  appendUiTraceEntry(scope, event, data);
}

export function snapshotUiTraceElement(node: Element | null) {
  if (!node || typeof window === "undefined") {
    return null;
  }

  const element = node as HTMLElement;
  const rect = element.getBoundingClientRect();
  const computed = window.getComputedStyle(element);
  const path = node.querySelector("path");
  const svg = node.querySelector("svg");
  const svgElement = svg instanceof SVGElement ? svg : null;
  const svgComputed = svgElement ? window.getComputedStyle(svgElement) : null;
  const pathElement = path instanceof SVGPathElement ? path : null;

  return {
    childElementCount: element.childElementCount,
    className: element.className,
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    computedOpacity: computed.opacity,
    display: computed.display,
    inlineOpacity: element.style.opacity || null,
    path: pathElement
      ? {
          dLength: pathElement.getAttribute("d")?.length ?? 0,
          strokeWidth: pathElement.getAttribute("stroke-width") ?? null,
          totalLength:
            typeof pathElement.getTotalLength === "function"
              ? Number(pathElement.getTotalLength().toFixed(3))
              : null,
        }
      : null,
    rect: {
      height: Number(rect.height.toFixed(3)),
      left: Number(rect.left.toFixed(3)),
      top: Number(rect.top.toFixed(3)),
      width: Number(rect.width.toFixed(3)),
    },
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    svg: svgElement
      ? {
          computedOpacity: svgComputed?.opacity ?? null,
          viewBox: svgElement.getAttribute("viewBox"),
        }
      : null,
    tagName: node.tagName.toLowerCase(),
    visibility: computed.visibility,
  };
}

export function sampleUiTraceFrames(args: {
  durationMs?: number;
  label: string;
  node: Element;
  scope: string;
}) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const durationMs = args.durationMs ?? 900;
  const sampleStartedAt = performance.now();
  let frame = 0;
  let frameId: number | null = null;
  let stopped = false;

  const captureFrame = () => {
    if (stopped) {
      return;
    }

    const elapsedMs = performance.now() - sampleStartedAt;

    recordUiTrace(args.scope, "frame-sample", {
      elapsedMs: Number(elapsedMs.toFixed(3)),
      frame,
      label: args.label,
      snapshot: snapshotUiTraceElement(args.node),
    });
    frame += 1;

    if (elapsedMs >= durationMs) {
      return;
    }

    frameId = window.requestAnimationFrame(captureFrame);
  };

  recordUiTrace(args.scope, "frame-sample-start", {
    durationMs,
    label: args.label,
    snapshot: snapshotUiTraceElement(args.node),
  });
  frameId = window.requestAnimationFrame(captureFrame);

  return () => {
    stopped = true;
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
    }

    recordUiTrace(args.scope, "frame-sample-stop", {
      frameCount: frame,
      label: args.label,
      snapshot: snapshotUiTraceElement(args.node),
    });
  };
}

export async function saveUiTraceLog(label?: string) {
  const fileName = createUiTraceFileName(label);
  const relativePath = `${UI_TRACE_DIR}/${fileName}`;
  appendUiTraceEntry("ui-trace", "save-requested", {
    droppedEntries,
    entryCountBeforeSave: entries.length,
    fileName,
    label: label ?? null,
  });
  const payload = stringifyUiTraceEntries(entries);

  await mkdir(UI_TRACE_DIR, {
    baseDir: BaseDirectory.AppLog,
    recursive: true,
  });
  await writeTextFile(relativePath, payload.length > 0 ? `${payload}\n` : "", {
    baseDir: BaseDirectory.AppLog,
  });

  const absolutePath = await join(await appLogDir(), UI_TRACE_DIR, fileName);

  writeUiTraceConsole("log", `[uiTrace] saved ${absolutePath}`);

  return absolutePath;
}

export async function startUiTraceCapture() {
  if (installed || typeof window === "undefined") {
    return;
  }

  installed = true;
  installUiTraceConsoleCapture();
  installUiTraceWindowApi();
  installUiTraceWindowErrorCapture();

  appendUiTraceEntry("ui-trace", "capture-started", {
    appName: await getName().catch(() => null),
    droppedEntries,
    maxEntries: MAX_UI_TRACE_ENTRIES,
    sessionId,
  });
  writeUiTraceConsole(
    "log",
    "[uiTrace] capture ready. Use window.save() to export the current trace.",
  );
}
