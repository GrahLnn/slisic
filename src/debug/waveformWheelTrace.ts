import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

type WaveformWheelTraceMode = "capture" | "observe-default" | "off";

type WaveformWheelTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  mode: WaveformWheelTraceMode;
  payload: Record<string, unknown>;
};

type WaveformWheelTraceApi = {
  clear: () => void;
  entries: () => WaveformWheelTraceEntry[];
  mode: () => WaveformWheelTraceMode;
  save: () => Promise<string | null>;
  setMode: (mode: WaveformWheelTraceMode) => void;
};

type WaveformWheelTraceRuntime = {
  api: WaveformWheelTraceApi;
  cleanupGlobalProbe: () => void;
  moduleToken: symbol;
  ownerId: string;
  publicApi: WaveformWheelTraceApi;
};

type WaveformWheelGlobalWindow = Window & {
  __waveformWheelTraceApi?: WaveformWheelTraceApi;
  __waveformWheelTraceRuntime?: WaveformWheelTraceRuntime;
  __WAVEFORM_WHEEL_TRACE_CONSOLE__?: boolean;
  saveWaveformWheelTrace?: () => Promise<string | null>;
  setWaveformWheelTraceMode?: (mode: WaveformWheelTraceMode) => void;
};

type WaveformWheelTraceHotData = {
  entries?: WaveformWheelTraceEntry[];
  eventSequence?: number;
  ownerId?: string;
  sequence?: number;
  traceMode?: WaveformWheelTraceMode;
  wasInstalled?: boolean;
};

type WaveformWheelTraceHot = {
  data?: WaveformWheelTraceHotData;
  dispose: (callback: (data: WaveformWheelTraceHotData) => void) => void;
};

const MAX_TRACE_ENTRIES = 16_000;
const WAVEFORM_WHEEL_TRACE_MODULE_TOKEN = Symbol("waveformWheelTraceModule");
const WAVEFORM_WHEEL_PROBE_DESCRIPTOR_KEYS = [
  "deltaMode",
  "deltaX",
  "deltaY",
  "deltaZ",
  "wheelDelta",
  "wheelDeltaX",
  "wheelDeltaY",
  "detail",
  "type",
] as const;

const waveformWheelTraceHot = getWaveformWheelTraceHot();
const waveformWheelTraceHotData = waveformWheelTraceHot?.data;

let ownerSequence = 0;
let sequence = waveformWheelTraceHotData?.sequence ?? 0;
let eventSequence = waveformWheelTraceHotData?.eventSequence ?? 0;
let traceMode: WaveformWheelTraceMode = isWaveformWheelTraceMode(
  waveformWheelTraceHotData?.traceMode,
)
  ? waveformWheelTraceHotData.traceMode
  : "capture";
const entries: WaveformWheelTraceEntry[] = Array.isArray(waveformWheelTraceHotData?.entries)
  ? waveformWheelTraceHotData.entries
  : [];
const eventIds = new WeakMap<Event, number>();

function getWaveformWheelTraceHot(): WaveformWheelTraceHot | undefined {
  return (import.meta as unknown as { webpackHot?: WaveformWheelTraceHot }).webpackHot;
}

function getTraceWindow() {
  return typeof window === "undefined" ? null : (window as WaveformWheelGlobalWindow);
}

function isWaveformWheelTraceMode(value: unknown): value is WaveformWheelTraceMode {
  return value === "capture" || value === "observe-default" || value === "off";
}

function isWaveformWheelTraceEntry(value: unknown): value is WaveformWheelTraceEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<WaveformWheelTraceEntry>;
  return (
    typeof entry.seq === "number" &&
    typeof entry.isoTime === "string" &&
    typeof entry.performanceNow === "number" &&
    typeof entry.event === "string" &&
    isWaveformWheelTraceMode(entry.mode) &&
    !!entry.payload &&
    typeof entry.payload === "object"
  );
}

function createWaveformWheelTraceOwnerId() {
  ownerSequence += 1;
  return `waveform-wheel-trace.${Date.now()}.${ownerSequence}`;
}

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

function readEventNumber(event: Event, key: string, fallback: number | null = 0) {
  const value = (event as Event & Record<string, unknown>)[key];

  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getEventTraceId(event: Event) {
  const existing = eventIds.get(event);
  if (existing !== undefined) {
    return existing;
  }

  eventSequence += 1;
  eventIds.set(event, eventSequence);
  return eventSequence;
}

function snapshotEventTarget(target: EventTarget | null | undefined) {
  if (!(target instanceof Element)) {
    return {
      kind: target === null || target === undefined ? "null" : target.constructor.name,
    };
  }

  const rect = target.getBoundingClientRect();

  return {
    ariaLabel: target.getAttribute("aria-label"),
    className: typeof target.className === "string" ? target.className : null,
    dataAttributes: Object.fromEntries(
      Array.from(target.attributes)
        .filter((attribute) => attribute.name.startsWith("data-"))
        .map((attribute) => [attribute.name, attribute.value]),
    ),
    id: target.id || null,
    rect: {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
    },
    scrollLeft: target.scrollLeft,
    scrollTop: target.scrollTop,
    tagName: target.tagName,
  };
}

function snapshotObjectPrototypeChain(value: object) {
  const names: string[] = [];
  let current: object | null = value;

  while (current && names.length < 12) {
    names.push(current.constructor?.name ?? "Object");
    current = Object.getPrototypeOf(current);
  }

  return names;
}

function snapshotPropertyDescriptor(value: object, key: string) {
  let current: object | null = value;
  let depth = 0;

  while (current && depth < 12) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);

    if (descriptor) {
      return {
        configurable: descriptor.configurable,
        depth,
        enumerable: descriptor.enumerable,
        hasGetter: "get" in descriptor && typeof descriptor.get === "function",
        hasSetter: "set" in descriptor && typeof descriptor.set === "function",
        owner: current.constructor?.name ?? "Object",
        valueType: "value" in descriptor ? typeof descriptor.value : null,
        writable: "writable" in descriptor ? descriptor.writable : null,
      };
    }

    current = Object.getPrototypeOf(current);
    depth += 1;
  }

  return null;
}

function snapshotWheelProbeDescriptors(event: WheelEvent) {
  return Object.fromEntries(
    WAVEFORM_WHEEL_PROBE_DESCRIPTOR_KEYS.map((key) => [
      key,
      snapshotPropertyDescriptor(event, key),
    ]),
  );
}

function snapshotWheelProbeValues(event: WheelEvent) {
  const eventRecord = event as WheelEvent & Record<string, unknown>;
  const sourceCapabilities = eventRecord.sourceCapabilities;

  return {
    axis: readEventNumber(event, "axis", null),
    cancelBubble: event.cancelBubble,
    cancelable: event.cancelable,
    defaultPrevented: event.defaultPrevented,
    deltaMode: event.deltaMode,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    detail: event.detail,
    eventPhase: event.eventPhase,
    horizontalAxis: readEventNumber(event, "HORIZONTAL_AXIS", null),
    isTrusted: event.isTrusted,
    returnValue: event.returnValue,
    sourceCapabilities:
      sourceCapabilities && typeof sourceCapabilities === "object"
        ? {
            firesTouchEvents:
              "firesTouchEvents" in sourceCapabilities
                ? Boolean(sourceCapabilities.firesTouchEvents)
                : null,
          }
        : null,
    timeStamp: event.timeStamp,
    type: event.type,
    wheelDelta: readEventNumber(event, "wheelDelta"),
    wheelDeltaX: readEventNumber(event, "wheelDeltaX"),
    wheelDeltaY: readEventNumber(event, "wheelDeltaY"),
  };
}

export function snapshotWaveformWheelEvent(event: WheelEvent) {
  return {
    altKey: event.altKey,
    bubbles: event.bubbles,
    button: event.button,
    buttons: event.buttons,
    cancelable: event.cancelable,
    clientX: event.clientX,
    clientY: event.clientY,
    ctrlKey: event.ctrlKey,
    currentTarget: snapshotEventTarget(event.currentTarget),
    defaultPrevented: event.defaultPrevented,
    deltaMode: event.deltaMode,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    detail: event.detail,
    eventPhase: event.eventPhase,
    eventTraceId: getEventTraceId(event),
    horizontalAxis: readEventNumber(event, "HORIZONTAL_AXIS", null),
    isTrusted: event.isTrusted,
    metaKey: event.metaKey,
    pageX: event.pageX,
    pageY: event.pageY,
    screenX: event.screenX,
    screenY: event.screenY,
    shiftKey: event.shiftKey,
    target: snapshotEventTarget(event.target),
    timeStamp: event.timeStamp,
    type: event.type,
    wheelDelta: readEventNumber(event, "wheelDelta"),
    wheelDeltaX: readEventNumber(event, "wheelDeltaX"),
    wheelDeltaY: readEventNumber(event, "wheelDeltaY"),
  };
}

export function snapshotWaveformWheelComposedPath(event: Event) {
  return event.composedPath().map((target, index) => ({
    index,
    target: snapshotEventTarget(target),
  }));
}

export function recordWaveformWheelTrace(event: string, payload: Record<string, unknown> = {}) {
  const traceWindow = getTraceWindow();
  if (!traceWindow || traceMode === "off") {
    return;
  }

  const entry = {
    seq: sequence++,
    isoTime: new Date().toISOString(),
    performanceNow: traceWindow.performance.now(),
    event,
    mode: traceMode,
    payload,
  } satisfies WaveformWheelTraceEntry;

  entries.push(entry);
  trimEntries();

  if (traceWindow.__WAVEFORM_WHEEL_TRACE_CONSOLE__) {
    console.log(`[waveformWheelTrace] ${event}`, entry);
  }
}

function isTraceableWheelEvent(event: Event): event is WheelEvent {
  return (
    event.type === "wheel" &&
    "deltaX" in event &&
    "deltaY" in event &&
    typeof (event as WheelEvent).deltaX === "number" &&
    typeof (event as WheelEvent).deltaY === "number"
  );
}

function recordWaveformGlobalWheelProbe(args: {
  event: WheelEvent;
  label: string;
  ownerId: string;
  scheduleFollowUp: boolean;
  timing: "animation-frame" | "microtask" | "sync";
}) {
  recordWaveformWheelTrace(`global-wheel-probe-${args.label}-${args.timing}`, {
    descriptors: snapshotWheelProbeDescriptors(args.event),
    event: snapshotWaveformWheelEvent(args.event),
    ownerId: args.ownerId,
    path: args.timing === "sync" ? snapshotWaveformWheelComposedPath(args.event) : null,
    prototypeChain: snapshotObjectPrototypeChain(args.event),
    scheduleFollowUp: args.scheduleFollowUp,
    values: snapshotWheelProbeValues(args.event),
  });
}

function installWaveformWheelGlobalProbe(traceWindow: WaveformWheelGlobalWindow, ownerId: string) {
  const cleanupCallbacks: Array<() => void> = [];
  const ownerDocument = traceWindow.document;
  const targets = [
    {
      capture: true,
      label: "window-capture",
      target: traceWindow,
    },
    {
      capture: true,
      label: "document-capture",
      target: ownerDocument,
    },
    {
      capture: true,
      label: "document-element-capture",
      target: ownerDocument?.documentElement,
    },
    {
      capture: true,
      label: "body-capture",
      target: ownerDocument?.body,
    },
    {
      capture: false,
      label: "body-bubble",
      target: ownerDocument?.body,
    },
    {
      capture: false,
      label: "document-bubble",
      target: ownerDocument,
    },
    {
      capture: false,
      label: "window-bubble",
      target: traceWindow,
    },
  ];
  const installedLabels: string[] = [];

  for (const targetDescriptor of targets) {
    const target = targetDescriptor.target;

    if (
      !target ||
      typeof target.addEventListener !== "function" ||
      typeof target.removeEventListener !== "function"
    ) {
      continue;
    }

    const listener = (event: Event) => {
      if (!isTraceableWheelEvent(event)) {
        return;
      }

      const scheduleFollowUp = targetDescriptor.label === "window-capture";

      recordWaveformGlobalWheelProbe({
        event,
        label: targetDescriptor.label,
        ownerId,
        scheduleFollowUp,
        timing: "sync",
      });

      if (!scheduleFollowUp) {
        return;
      }

      traceWindow.queueMicrotask?.(() => {
        recordWaveformGlobalWheelProbe({
          event,
          label: targetDescriptor.label,
          ownerId,
          scheduleFollowUp: false,
          timing: "microtask",
        });
      });
      traceWindow.requestAnimationFrame?.(() => {
        recordWaveformGlobalWheelProbe({
          event,
          label: targetDescriptor.label,
          ownerId,
          scheduleFollowUp: false,
          timing: "animation-frame",
        });
      });
    };

    target.addEventListener("wheel", listener, {
      capture: targetDescriptor.capture,
      passive: true,
    });
    installedLabels.push(targetDescriptor.label);
    cleanupCallbacks.push(() => {
      target.removeEventListener("wheel", listener, targetDescriptor.capture);
    });
  }

  recordWaveformWheelTrace("global-wheel-probe-installed", {
    installedLabels,
    ownerId,
  });

  return () => {
    for (const cleanup of cleanupCallbacks.splice(0)) {
      cleanup();
    }
    recordWaveformWheelTrace("global-wheel-probe-detached", {
      installedLabels,
      ownerId,
    });
  };
}

async function saveWaveformWheelTrace() {
  const traceWindow = getTraceWindow();
  if (!traceWindow) {
    return null;
  }

  const path = await join(
    await downloadDir(),
    `waveform-wheel-trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[waveformWheelTrace] saved ${path}`);
  return path;
}

function getCurrentWaveformWheelTraceApi() {
  return getTraceWindow()?.__waveformWheelTraceRuntime?.api ?? null;
}

function adoptExistingWaveformWheelTraceEntries(traceWindow: WaveformWheelGlobalWindow) {
  if (entries.length > 0) {
    return;
  }

  const existingEntries = traceWindow.__waveformWheelTraceApi?.entries();
  if (!Array.isArray(existingEntries)) {
    return;
  }

  entries.push(...existingEntries.filter(isWaveformWheelTraceEntry));
  trimEntries();

  const nextSequence = Math.max(0, ...entries.map((entry) => entry.seq + 1));
  sequence = Math.max(sequence, nextSequence);
}

function createWaveformWheelTracePublicApi(): WaveformWheelTraceApi {
  /**
   * Console commands outlive hot-replaced modules. These methods are stable
   * forwarders, so a saved `window.saveWaveformWheelTrace` never owns the
   * async filesystem imports from an already disposed module.
   */
  return {
    clear() {
      getCurrentWaveformWheelTraceApi()?.clear();
    },
    entries() {
      return getCurrentWaveformWheelTraceApi()?.entries() ?? [];
    },
    mode() {
      return getCurrentWaveformWheelTraceApi()?.mode() ?? "off";
    },
    save() {
      return getCurrentWaveformWheelTraceApi()?.save() ?? Promise.resolve(null);
    },
    setMode(mode) {
      getCurrentWaveformWheelTraceApi()?.setMode(mode);
    },
  };
}

function createWaveformWheelTraceRuntimeApi(): WaveformWheelTraceApi {
  return {
    clear() {
      entries.length = 0;
      sequence = 0;
      eventSequence = 0;
    },
    entries() {
      return entries.slice();
    },
    mode() {
      return traceMode;
    },
    save: saveWaveformWheelTrace,
    setMode(mode) {
      traceMode = mode;
    },
  };
}

function uninstallWaveformWheelTraceRuntime(runtime: WaveformWheelTraceRuntime) {
  const traceWindow = getTraceWindow();
  if (!traceWindow || traceWindow.__waveformWheelTraceRuntime !== runtime) {
    return;
  }

  runtime.cleanupGlobalProbe();
  delete traceWindow.__waveformWheelTraceRuntime;
}

function uninstallWaveformWheelTraceApi(runtime: WaveformWheelTraceRuntime) {
  const traceWindow = getTraceWindow();
  if (!traceWindow) {
    return;
  }

  uninstallWaveformWheelTraceRuntime(runtime);

  if (traceWindow.__waveformWheelTraceApi === runtime.publicApi) {
    delete traceWindow.__waveformWheelTraceApi;
  }

  if (traceWindow.saveWaveformWheelTrace === runtime.publicApi.save) {
    delete traceWindow.saveWaveformWheelTrace;
  }

  if (traceWindow.setWaveformWheelTraceMode === runtime.publicApi.setMode) {
    delete traceWindow.setWaveformWheelTraceMode;
  }
}

function uninstallWaveformWheelTraceOwner(ownerId: string) {
  const runtime = getTraceWindow()?.__waveformWheelTraceRuntime;
  if (runtime?.ownerId === ownerId && runtime.moduleToken === WAVEFORM_WHEEL_TRACE_MODULE_TOKEN) {
    uninstallWaveformWheelTraceApi(runtime);
  }
}

export function installWaveformWheelTraceApi(ownerId = createWaveformWheelTraceOwnerId()) {
  const traceWindow = getTraceWindow();
  if (!traceWindow) {
    return () => {};
  }

  const api = createWaveformWheelTraceRuntimeApi();
  const publicApi = traceWindow.__waveformWheelTraceApi ?? createWaveformWheelTracePublicApi();
  const runtime: WaveformWheelTraceRuntime = {
    api,
    cleanupGlobalProbe: installWaveformWheelGlobalProbe(traceWindow, ownerId),
    moduleToken: WAVEFORM_WHEEL_TRACE_MODULE_TOKEN,
    ownerId,
    publicApi,
  };
  traceWindow.__waveformWheelTraceRuntime = runtime;
  traceWindow.__waveformWheelTraceApi = publicApi;
  traceWindow.saveWaveformWheelTrace = publicApi.save;
  traceWindow.setWaveformWheelTraceMode = publicApi.setMode;

  recordWaveformWheelTrace("trace-installed", {
    href: traceWindow.location.href,
    ownerId,
  });

  return () => {
    uninstallWaveformWheelTraceOwner(ownerId);
  };
}

function shouldAdoptExistingWaveformWheelTraceApi() {
  const traceWindow = getTraceWindow();
  return !!(
    traceWindow?.__waveformWheelTraceRuntime ||
    traceWindow?.__waveformWheelTraceApi ||
    traceWindow?.saveWaveformWheelTrace ||
    traceWindow?.setWaveformWheelTraceMode
  );
}

waveformWheelTraceHot?.dispose((data) => {
  const runtime = getTraceWindow()?.__waveformWheelTraceRuntime;
  const ownsRuntime = runtime?.moduleToken === WAVEFORM_WHEEL_TRACE_MODULE_TOKEN;

  data.entries = entries;
  data.eventSequence = eventSequence;
  data.ownerId = ownsRuntime ? runtime.ownerId : undefined;
  data.sequence = sequence;
  data.traceMode = traceMode;
  data.wasInstalled = ownsRuntime;

  if (ownsRuntime) {
    uninstallWaveformWheelTraceRuntime(runtime);
  }
});

if (
  waveformWheelTraceHotData?.wasInstalled &&
  typeof waveformWheelTraceHotData.ownerId === "string"
) {
  installWaveformWheelTraceApi(waveformWheelTraceHotData.ownerId);
} else if (shouldAdoptExistingWaveformWheelTraceApi()) {
  const traceWindow = getTraceWindow();
  if (traceWindow) {
    adoptExistingWaveformWheelTraceEntries(traceWindow);
  }
  installWaveformWheelTraceApi();
}
