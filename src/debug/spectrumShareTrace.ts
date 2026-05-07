import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

type SpectrumShareTraceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type SpectrumShareTraceElementSnapshot = {
  tagName: string;
  className: string;
  text: string;
  rect: SpectrumShareTraceRect;
  dataAttributes: Record<string, string>;
  transform: string;
  opacity: string;
  filter: string;
  display: string;
  visibility: string;
  willChange: string;
};

type SpectrumShareTraceElementDigest = {
  count: number;
  items: {
    dataAttributes: Record<string, string>;
    tagName: string;
  }[];
};

type SpectrumShareTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

type SpectrumShareTraceApi = {
  clear: () => void;
  entries: () => SpectrumShareTraceEntry[];
  save: () => Promise<string | null>;
};

type SpectrumShareTraceState = {
  activeFrameCaptureId: number;
  entries: SpectrumShareTraceEntry[];
  installed: boolean;
  sequence: number;
};

declare global {
  interface Window {
    __spectrumShareTraceInstalled?: boolean;
    __spectrumShareTraceApi?: SpectrumShareTraceApi;
    __spectrumShareTraceState?: SpectrumShareTraceState;
    saveSpectrumShareTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 12_000;
const TARGET_TITLE_SELECTOR = "[data-spectrum-share-trace-title='target']";
const SOURCE_TITLE_SELECTOR = "[data-spectrum-share-trace-title='source']";
const SPECTRUM_PAGE_SELECTOR = "[data-page-state='spectrum']";

const fallbackTraceState: SpectrumShareTraceState = {
  activeFrameCaptureId: 0,
  entries: [],
  installed: false,
  sequence: 0,
};

function getSpectrumShareTraceState() {
  if (typeof window === "undefined") {
    return fallbackTraceState;
  }

  window.__spectrumShareTraceState ??= {
    activeFrameCaptureId: 0,
    entries: [],
    installed: false,
    sequence: 0,
  };

  return window.__spectrumShareTraceState;
}

function toRect(rect: DOMRect): SpectrumShareTraceRect {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

function getElementClassName(node: Element) {
  if (typeof node.className === "string") {
    return node.className;
  }

  if (node instanceof SVGElement) {
    return node.className.baseVal;
  }

  return "";
}

function getTraceDataAttributes(node: Element) {
  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(node.attributes)) {
    if (attribute.name.startsWith("data-spectrum-share-trace-")) {
      attributes[attribute.name] = attribute.value;
    }
  }

  return attributes;
}

function snapshotSpectrumPageChildren() {
  if (typeof document === "undefined") {
    return [];
  }

  const page = document.querySelector(SPECTRUM_PAGE_SELECTOR);
  if (!page) {
    return [];
  }

  return Array.from(page.querySelectorAll("[data-index]"))
    .slice(0, 16)
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        dataIndex: node.getAttribute("data-index"),
        rect: toRect(rect),
        tagName: node.tagName.toLowerCase(),
      };
    });
}

function snapshotElement(node: Element | null): SpectrumShareTraceElementSnapshot | null {
  if (!node) {
    return null;
  }

  const style = window.getComputedStyle(node);

  return {
    tagName: node.tagName.toLowerCase(),
    className: getElementClassName(node),
    text: (node.textContent ?? "").trim().slice(0, 160),
    rect: toRect(node.getBoundingClientRect()),
    dataAttributes: getTraceDataAttributes(node),
    transform: style.transform,
    opacity: style.opacity,
    filter: style.filter,
    display: style.display,
    visibility: style.visibility,
    willChange: style.willChange,
  };
}

function digestElements(selector: string, limit: number): SpectrumShareTraceElementDigest {
  if (typeof document === "undefined") {
    return {
      count: 0,
      items: [],
    };
  }

  const nodes = Array.from(document.querySelectorAll(selector));

  return {
    count: nodes.length,
    items: nodes.slice(0, limit).map((node) => ({
      dataAttributes: getTraceDataAttributes(node),
      tagName: node.tagName.toLowerCase(),
    })),
  };
}

function findSpectrumShareTraceTitleByLayoutId(kind: "source" | "target", layoutId: string | null) {
  if (!layoutId) {
    return null;
  }

  return (
    Array.from(document.querySelectorAll(`[data-spectrum-share-trace-title='${kind}']`)).find(
      (node) => node.getAttribute("data-spectrum-share-trace-layout-id") === layoutId,
    ) ?? null
  );
}

function snapshotFrameEnvironment() {
  if (typeof window === "undefined") {
    return null;
  }

  const targetTitle = document.querySelector(TARGET_TITLE_SELECTOR);
  const targetLayoutId = targetTitle?.getAttribute("data-spectrum-share-trace-layout-id") ?? null;

  return {
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    scroll: {
      x: window.scrollX,
      y: window.scrollY,
    },
    matchedSourceTitle: snapshotElement(
      findSpectrumShareTraceTitleByLayoutId("source", targetLayoutId),
    ),
    sourceTitle: snapshotElement(document.querySelector(SOURCE_TITLE_SELECTOR)),
    targetTitle: snapshotElement(targetTitle),
    sourceTitles: digestElements(SOURCE_TITLE_SELECTOR, 16),
    spectrumRows: snapshotSpectrumPageChildren(),
  };
}

function trimEntries() {
  const state = getSpectrumShareTraceState();
  if (state.entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  state.entries.splice(0, state.entries.length - MAX_TRACE_ENTRIES);
}

export function recordSpectrumShareTrace(event: string, payload: Record<string, unknown> = {}) {
  const state = getSpectrumShareTraceState();
  if (typeof window === "undefined" || !state.installed) {
    return;
  }

  state.entries.push({
    seq: state.sequence,
    isoTime: new Date().toISOString(),
    performanceNow: performance.now(),
    event,
    payload,
  });
  state.sequence += 1;
  trimEntries();
}

export function captureSpectrumShareFrames(
  label: string,
  args?: {
    frames?: number;
    payload?: Record<string, unknown>;
    reset?: boolean;
    sample?: () => Record<string, unknown>;
  },
) {
  const state = getSpectrumShareTraceState();
  if (typeof window === "undefined" || !state.installed) {
    return;
  }

  if (args?.reset) {
    state.entries.length = 0;
    state.sequence = 0;
  }

  state.activeFrameCaptureId += 1;
  const frameCaptureId = state.activeFrameCaptureId;
  const frameCount = args?.frames ?? 48;
  let frameIndex = 0;
  let previousFrameTime: number | null = null;

  recordSpectrumShareTrace("trace-frame-capture-start", {
    label,
    ...args?.payload,
  });

  const sampleFrame = (frameTime: number) => {
    if (frameCaptureId !== state.activeFrameCaptureId) {
      return;
    }

    recordSpectrumShareTrace("frame", {
      label,
      frameIndex,
      frameTime,
      frameDelta: previousFrameTime === null ? null : frameTime - previousFrameTime,
      traceContext: snapshotFrameEnvironment(),
      ...args?.payload,
      ...args?.sample?.(),
    });

    previousFrameTime = frameTime;
    frameIndex += 1;
    if (frameIndex < frameCount) {
      requestAnimationFrame(sampleFrame);
    }
  };

  requestAnimationFrame(sampleFrame);
}

async function saveSpectrumShareTrace() {
  if (typeof window === "undefined") {
    return null;
  }

  const state = getSpectrumShareTraceState();
  const path = await join(
    await downloadDir(),
    `spectrum-share-trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = state.entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[spectrumShareTrace] saved ${path}`);
  return path;
}

export function installSpectrumShareTrace() {
  if (typeof window === "undefined") {
    return;
  }

  const state = getSpectrumShareTraceState();
  const api: SpectrumShareTraceApi = {
    clear() {
      state.entries.length = 0;
      state.sequence = 0;
      recordSpectrumShareTrace("trace-cleared");
    },
    entries() {
      return [...state.entries];
    },
    save: saveSpectrumShareTrace,
  };

  const wasInstalled = state.installed;
  state.installed = true;
  window.__spectrumShareTraceInstalled = true;
  window.__spectrumShareTraceApi = api;
  window.saveSpectrumShareTrace = api.save;

  if (!wasInstalled) {
    recordSpectrumShareTrace("trace-installed", {
      href: window.location.href,
    });
  }
}
