import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

type SpectrumWaveformTraceValue =
  | null
  | string
  | number
  | boolean
  | SpectrumWaveformTraceValue[]
  | { [key: string]: SpectrumWaveformTraceValue };

type SpectrumWaveformTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, SpectrumWaveformTraceValue>;
};

type SpectrumWaveformTraceApi = {
  clear: () => void;
  entries: () => SpectrumWaveformTraceEntry[];
  save: () => Promise<string | null>;
};

type SpectrumWaveformTracePayload = Record<string, unknown> | (() => Record<string, unknown>);

declare global {
  interface Window {
    __spectrumWaveformTraceInstalled?: boolean;
    __spectrumWaveformTraceApi?: SpectrumWaveformTraceApi;
    __SPECTRUM_WAVEFORM_TRACE_CONSOLE__?: boolean;
    saveSpectrumWaveformTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 12_000;
const MAX_TRACE_DEPTH = 6;
const MAX_TRACE_ARRAY_ITEMS = 80;
const MAX_TRACE_OBJECT_KEYS = 80;
const MAX_TRACE_STRING_LENGTH = 4_000;
const MAX_TRACE_DATA_ATTRIBUTES = 32;

let sequence = 0;
const entries: SpectrumWaveformTraceEntry[] = [];

function truncateTraceString(value: string) {
  if (value.length <= MAX_TRACE_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_TRACE_STRING_LENGTH)}[truncated ${value.length - MAX_TRACE_STRING_LENGTH} chars]`;
}

function getTraceObjectType(value: object) {
  return value.constructor?.name || Object.prototype.toString.call(value).slice(8, -1) || "Object";
}

function isTraceObject(
  value: SpectrumWaveformTraceValue,
): value is Record<string, SpectrumWaveformTraceValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTraceElement(value: object): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

function isTraceEvent(value: object): value is Event {
  return typeof Event !== "undefined" && value instanceof Event;
}

function getTraceElementClassName(node: Element) {
  if (typeof node.className === "string") {
    return node.className;
  }

  return node.getAttribute("class") ?? "";
}

function snapshotTraceElement(node: Element): Record<string, SpectrumWaveformTraceValue> {
  const dataAttributes = Object.fromEntries(
    Array.from(node.attributes)
      .filter((attribute) => attribute.name.startsWith("data-"))
      .slice(0, MAX_TRACE_DATA_ATTRIBUTES)
      .map((attribute) => [attribute.name, truncateTraceString(attribute.value)]),
  );

  return {
    __type: "Element",
    tagName: node.tagName.toLowerCase(),
    id: node.id || null,
    className: truncateTraceString(getTraceElementClassName(node)),
    dataAttributes,
  };
}

function snapshotTraceEventTarget(target: EventTarget | null) {
  if (!target) {
    return null;
  }

  if (isTraceElement(target)) {
    return snapshotTraceElement(target);
  }

  return {
    __type: getTraceObjectType(target),
  };
}

function snapshotTraceEvent(event: Event): Record<string, SpectrumWaveformTraceValue> {
  return {
    __type: "Event",
    eventType: event.type,
    cancelable: event.cancelable,
    defaultPrevented: event.defaultPrevented,
    target: snapshotTraceEventTarget(event.target),
    currentTarget: snapshotTraceEventTarget(event.currentTarget),
  };
}

function snapshotTraceArrayBufferView(value: ArrayBufferView) {
  const sampleLength = Math.min(value.byteLength, 16);
  const sampleBytes = Array.from(new Uint8Array(value.buffer, value.byteOffset, sampleLength));

  return {
    __type: getTraceObjectType(value),
    byteLength: value.byteLength,
    sampleBytes,
  } satisfies Record<string, SpectrumWaveformTraceValue>;
}

function sanitizeSpectrumWaveformTraceValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): SpectrumWaveformTraceValue {
  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    return truncateTraceString(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "undefined") {
    return "[Undefined]";
  }

  if (typeof value === "symbol") {
    return `[Symbol ${value.description ?? ""}]`;
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (isTraceElement(value)) {
    return snapshotTraceElement(value);
  }

  if (isTraceEvent(value)) {
    return snapshotTraceEvent(value);
  }

  if (value instanceof Error) {
    return {
      __type: "Error",
      name: value.name,
      message: truncateTraceString(value.message),
      stack: value.stack ? truncateTraceString(value.stack) : null,
    };
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[Invalid Date]" : value.toISOString();
  }

  if (value instanceof RegExp) {
    return value.toString();
  }

  if (ArrayBuffer.isView(value)) {
    return snapshotTraceArrayBufferView(value);
  }

  if (value instanceof ArrayBuffer) {
    return {
      __type: "ArrayBuffer",
      byteLength: value.byteLength,
    };
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (depth >= MAX_TRACE_DEPTH) {
    return `[MaxDepth ${getTraceObjectType(value)}]`;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const output = value
      .slice(0, MAX_TRACE_ARRAY_ITEMS)
      .map((item) => sanitizeSpectrumWaveformTraceValue(item, seen, depth + 1));

    if (value.length > MAX_TRACE_ARRAY_ITEMS) {
      output.push(`[truncated ${value.length - MAX_TRACE_ARRAY_ITEMS} items]`);
    }

    return output;
  }

  if (value instanceof Map) {
    const output = Array.from(value.entries())
      .slice(0, MAX_TRACE_ARRAY_ITEMS)
      .map(([key, mapValue]) => ({
        key: sanitizeSpectrumWaveformTraceValue(key, seen, depth + 1),
        value: sanitizeSpectrumWaveformTraceValue(mapValue, seen, depth + 1),
      }));

    return {
      __type: "Map",
      size: value.size,
      entries:
        value.size > MAX_TRACE_ARRAY_ITEMS
          ? [...output, `[truncated ${value.size - MAX_TRACE_ARRAY_ITEMS} entries]`]
          : output,
    };
  }

  if (value instanceof Set) {
    const output = Array.from(value.values())
      .slice(0, MAX_TRACE_ARRAY_ITEMS)
      .map((item) => sanitizeSpectrumWaveformTraceValue(item, seen, depth + 1));

    return {
      __type: "Set",
      size: value.size,
      values:
        value.size > MAX_TRACE_ARRAY_ITEMS
          ? [...output, `[truncated ${value.size - MAX_TRACE_ARRAY_ITEMS} items]`]
          : output,
    };
  }

  const objectType = getTraceObjectType(value);
  const output: Record<string, SpectrumWaveformTraceValue> = {};

  if (objectType !== "Object") {
    output.__type = objectType;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);

  for (const key of keys.slice(0, MAX_TRACE_OBJECT_KEYS)) {
    try {
      output[key] = sanitizeSpectrumWaveformTraceValue(record[key], seen, depth + 1);
    } catch (error) {
      output[key] = `[Thrown ${error instanceof Error ? error.message : String(error)}]`;
    }
  }

  if (keys.length > MAX_TRACE_OBJECT_KEYS) {
    output.__truncatedKeys = keys.length - MAX_TRACE_OBJECT_KEYS;
  }

  return output;
}

export function sanitizeSpectrumWaveformTracePayload(payload: Record<string, unknown> = {}) {
  const value = sanitizeSpectrumWaveformTraceValue(payload, new WeakSet(), 0);

  if (isTraceObject(value)) {
    return value;
  }

  return {
    value,
  };
}

function stringifySpectrumWaveformTraceEntry(entry: SpectrumWaveformTraceEntry) {
  try {
    return JSON.stringify(entry);
  } catch (error) {
    return JSON.stringify({
      seq: entry.seq,
      isoTime: entry.isoTime,
      performanceNow: entry.performanceNow,
      event: entry.event,
      payload: sanitizeSpectrumWaveformTracePayload(entry.payload),
      serializationError: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveSpectrumWaveformTracePayload(payload: SpectrumWaveformTracePayload) {
  try {
    return typeof payload === "function" ? payload() : payload;
  } catch (error) {
    return {
      __tracePayloadError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isSpectrumWaveformTraceEnabled() {
  return typeof window !== "undefined" && window.__spectrumWaveformTraceInstalled === true;
}

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

export function recordSpectrumWaveformTrace(
  event: string,
  payload: SpectrumWaveformTracePayload = {},
) {
  if (!isSpectrumWaveformTraceEnabled()) {
    return;
  }

  const entry = {
    seq: sequence++,
    isoTime: new Date().toISOString(),
    performanceNow: window.performance.now(),
    event,
    payload: sanitizeSpectrumWaveformTracePayload(resolveSpectrumWaveformTracePayload(payload)),
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
  const contents = entries.map((entry) => stringifySpectrumWaveformTraceEntry(entry)).join("\n");

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
