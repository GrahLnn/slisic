import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

type GhostTraceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type GhostTraceElementSnapshot = {
  tagName: string;
  id: string | null;
  className: string;
  text: string;
  dataAttributes: Record<string, string>;
  rect: GhostTraceRect;
  scrollTop: number | null;
  scrollLeft: number | null;
  scrollWidth: number | null;
  scrollHeight: number | null;
  clientWidth: number | null;
  clientHeight: number | null;
  offsetWidth: number | null;
  offsetHeight: number | null;
  offsetLeft: number | null;
  offsetTop: number | null;
  position: string;
  display: string;
  boxSizing: string;
  left: string;
  top: string;
  margin: string;
  whiteSpace: string;
  overflowWrap: string;
  wordBreak: string;
  width: string;
  height: string;
  lineHeight: string;
  transform: string;
  transformOrigin: string;
  opacity: string;
  pointerEvents: string;
  animationStates: GhostTraceAnimationSnapshot[];
  inlineLeft: string | null;
  inlineTop: string | null;
  inlineWidth: string | null;
  inlineHeight: string | null;
  inlineTransform: string | null;
  inlineTransformOrigin: string | null;
  inlineOpacity: string | null;
  inlineTransition: string | null;
};

type GhostTraceAnimationSnapshot = {
  currentTime: number | null;
  playState: string;
  progress: number | null;
};

type GhostTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

type ListConfigGhostTraceApi = {
  clear: () => void;
  entries: () => GhostTraceEntry[];
  save: () => Promise<string | null>;
};

declare global {
  interface Window {
    __listConfigGhostTraceInstalled?: boolean;
    __listConfigGhostTraceApi?: ListConfigGhostTraceApi;
    saveListConfigGhostTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 4_000;

let sequence = 0;
const entries: GhostTraceEntry[] = [];

function toRect(rect: DOMRect): GhostTraceRect {
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
  return Object.fromEntries(
    Array.from(node.attributes)
      .filter((attribute) => attribute.name.startsWith("data-"))
      .map((attribute) => [attribute.name, attribute.value]),
  );
}

export function snapshotListConfigGhostElement(
  node: Element | null,
): GhostTraceElementSnapshot | null {
  if (!(node instanceof HTMLElement || node instanceof SVGElement)) {
    return null;
  }

  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  const element = node instanceof HTMLElement ? node : null;
  const animationStates =
    element?.getAnimations().map((animation) => {
      const computedTiming = animation.effect?.getComputedTiming();
      return {
        currentTime: typeof animation.currentTime === "number" ? animation.currentTime : null,
        playState: animation.playState,
        progress: typeof computedTiming?.progress === "number" ? computedTiming.progress : null,
      } satisfies GhostTraceAnimationSnapshot;
    }) ?? [];

  return {
    tagName: node.tagName.toLowerCase(),
    id: node.id || null,
    className: getElementClassName(node),
    text: (node.textContent ?? "").trim(),
    dataAttributes: getTraceDataAttributes(node),
    rect: toRect(rect),
    scrollTop: element?.scrollTop ?? null,
    scrollLeft: element?.scrollLeft ?? null,
    scrollWidth: element?.scrollWidth ?? null,
    scrollHeight: element?.scrollHeight ?? null,
    clientWidth: element?.clientWidth ?? null,
    clientHeight: element?.clientHeight ?? null,
    offsetWidth: element?.offsetWidth ?? null,
    offsetHeight: element?.offsetHeight ?? null,
    offsetLeft: element?.offsetLeft ?? null,
    offsetTop: element?.offsetTop ?? null,
    position: style.position,
    display: style.display,
    boxSizing: style.boxSizing,
    left: style.left,
    top: style.top,
    margin: style.margin,
    whiteSpace: style.whiteSpace,
    overflowWrap: style.overflowWrap,
    wordBreak: style.wordBreak,
    width: style.width,
    height: style.height,
    lineHeight: style.lineHeight,
    transform: style.transform,
    transformOrigin: style.transformOrigin,
    opacity: style.opacity,
    pointerEvents: style.pointerEvents,
    animationStates,
    inlineLeft: element?.style.left || null,
    inlineTop: element?.style.top || null,
    inlineWidth: element?.style.width || null,
    inlineHeight: element?.style.height || null,
    inlineTransform: element?.style.transform || null,
    inlineTransformOrigin: element?.style.transformOrigin || null,
    inlineOpacity: element?.style.opacity || null,
    inlineTransition: element?.style.transition || null,
  };
}

function snapshotEnvironment() {
  if (typeof document === "undefined") {
    return null;
  }

  return {
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    activeElement: snapshotListConfigGhostElement(document.activeElement),
  };
}

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

export function recordListConfigGhostTrace(event: string, payload: Record<string, unknown> = {}) {
  if (typeof window === "undefined") {
    return;
  }

  entries.push({
    seq: sequence,
    isoTime: new Date().toISOString(),
    performanceNow: performance.now(),
    event,
    payload: {
      ...payload,
      traceContext: snapshotEnvironment(),
    },
  });
  sequence += 1;
  trimEntries();
}

export function captureListConfigGhostFrames(
  label: string,
  args?: {
    frames?: number;
    payload?: Record<string, unknown>;
    sample?: () => Record<string, unknown>;
  },
) {
  if (typeof window === "undefined") {
    return;
  }

  const frameCount = args?.frames ?? 18;
  let frameIndex = 0;
  let previousFrameTime: number | null = null;

  const sampleFrame = (frameTime: number) => {
    recordListConfigGhostTrace("frame", {
      label,
      frameIndex,
      frameTime,
      frameDelta: previousFrameTime === null ? null : frameTime - previousFrameTime,
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

async function saveListConfigGhostTrace() {
  const path = await join(
    await downloadDir(),
    `list-config-ghost.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[listConfigGhostTrace] saved ${path}`);
  return path;
}

export function installListConfigGhostTrace() {
  if (typeof window === "undefined" || window.__listConfigGhostTraceInstalled) {
    return;
  }

  const api: ListConfigGhostTraceApi = {
    clear() {
      entries.length = 0;
      sequence = 0;
      recordListConfigGhostTrace("trace-cleared");
    },
    entries() {
      return [...entries];
    },
    save: saveListConfigGhostTrace,
  };

  window.__listConfigGhostTraceInstalled = true;
  window.__listConfigGhostTraceApi = api;
  window.saveListConfigGhostTrace = api.save;

  recordListConfigGhostTrace("trace-installed", {
    href: window.location.href,
  });
}
