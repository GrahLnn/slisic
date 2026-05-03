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

type WaveformWheelGlobalWindow = Window & {
  __waveformWheelTraceApi?: WaveformWheelTraceApi;
  __waveformWheelTraceInstalled?: boolean;
  __WAVEFORM_WHEEL_TRACE_CONSOLE__?: boolean;
  saveWaveformWheelTrace?: () => Promise<string | null>;
  setWaveformWheelTraceMode?: (mode: WaveformWheelTraceMode) => void;
};

const MAX_TRACE_ENTRIES = 16_000;

let sequence = 0;
let eventSequence = 0;
let traceMode: WaveformWheelTraceMode = "capture";
const entries: WaveformWheelTraceEntry[] = [];
const eventIds = new WeakMap<Event, number>();

function getTraceWindow() {
  return typeof window === "undefined" ? null : (window as WaveformWheelGlobalWindow);
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

function snapshotEventTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return {
      kind: target === null ? "null" : target.constructor.name,
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

async function saveWaveformWheelTrace() {
  const traceWindow = getTraceWindow();
  if (!traceWindow) {
    return null;
  }

  const [{ downloadDir, join }, { writeTextFile }] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const path = await join(
    await downloadDir(),
    `waveform-wheel-trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[waveformWheelTrace] saved ${path}`);
  return path;
}

function recordGlobalWheelEvent(event: Event) {
  if (!(event instanceof WheelEvent)) {
    return;
  }

  recordWaveformWheelTrace("global-wheel-event", {
    event: snapshotWaveformWheelEvent(event),
    path: snapshotWaveformWheelComposedPath(event),
  });
}

export function installWaveformWheelTrace() {
  const traceWindow = getTraceWindow();
  if (!traceWindow || traceWindow.__waveformWheelTraceInstalled) {
    return;
  }

  const api: WaveformWheelTraceApi = {
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

  traceWindow.__waveformWheelTraceInstalled = true;
  traceWindow.__waveformWheelTraceApi = api;
  traceWindow.saveWaveformWheelTrace = api.save;
  traceWindow.setWaveformWheelTraceMode = api.setMode;

  /**
   * This listener is diagnostic only: it records the upstream wheel stream
   * without preventing default scrolling. The waveform viewport owner remains
   * the only place that translates horizontal wheel input into viewport commits.
   */
  traceWindow.addEventListener("wheel", recordGlobalWheelEvent, {
    capture: true,
    passive: true,
  });
  traceWindow.addEventListener("mousewheel", recordGlobalWheelEvent, {
    capture: true,
    passive: true,
  });

  recordWaveformWheelTrace("trace-installed", {
    href: traceWindow.location.href,
  });
}
