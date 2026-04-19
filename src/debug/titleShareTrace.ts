import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

type TitleShareTraceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type TitleShareTracePoint = {
  x: number;
  y: number;
};

type TitleShareTraceElementSnapshot = {
  tagName: string;
  id: string | null;
  className: string;
  text: string;
  dataAttributes: Record<string, string>;
  rect: TitleShareTraceRect;
  scrollTop: number | null;
  scrollLeft: number | null;
  scrollWidth: number | null;
  scrollHeight: number | null;
  clientWidth: number | null;
  clientHeight: number | null;
  position: string;
  overflowX: string;
  overflowY: string;
  transform: string;
  opacity: string;
  pointerEvents: string;
};

type TitleShareTraceNodeSnapshot = {
  layoutId: string;
  role: string | null;
  text: string;
  tagName: string;
  className: string;
  dataAttributes: Record<string, string>;
  opacity: string;
  transform: string;
  display: string;
  visibility: string;
  pointerEvents: string;
  connected: boolean;
  rect: TitleShareTraceRect;
  nearestScrollRoot: TitleShareTraceElementSnapshot | null;
  offsetToNearestScrollRoot: TitleShareTracePoint | null;
  ancestorChain: TitleShareTraceElementSnapshot[];
};

type TitleShareTraceEnvironmentSnapshot = {
  viewport: {
    innerWidth: number;
    innerHeight: number;
    scrollX: number;
    scrollY: number;
  };
  documentScroll: {
    scrollWidth: number;
    scrollHeight: number;
  };
  activeElement: TitleShareTraceElementSnapshot | null;
  scrollRoots: TitleShareTraceElementSnapshot[];
  pageRoots: TitleShareTraceElementSnapshot[];
};

type TitleShareTraceEntry = {
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

type TitleShareTraceApi = {
  clear: () => void;
  entries: () => TitleShareTraceEntry[];
  save: () => Promise<string | null>;
};

declare global {
  interface Window {
    __titleShareTraceInstalled?: boolean;
    __titleShareTraceApi?: TitleShareTraceApi;
    save?: () => Promise<string | null>;
  }
}

const TITLE_LAYOUT_SELECTOR = "[data-title-layout-id]";
const TRACE_ROOT_SELECTOR = "[data-title-trace-root]";
const TRACE_SCROLL_ROOT_SELECTOR = "[data-title-trace-scroll-root]";
const MAX_TRACE_ENTRIES = 8_000;
const MAX_ANCESTOR_DEPTH = 6;

let sequence = 0;
const entries: TitleShareTraceEntry[] = [];

function toRect(rect: DOMRect): TitleShareTraceRect {
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
  const attributes = Array.from(node.attributes)
    .filter((attribute) =>
      attribute.name.startsWith("data-title-") ||
      attribute.name.startsWith("data-page-"),
    );

  return Object.fromEntries(attributes.map((attribute) => [attribute.name, attribute.value]));
}

function snapshotTraceElement(node: Element | null): TitleShareTraceElementSnapshot | null {
  if (!(node instanceof HTMLElement || node instanceof SVGElement)) {
    return null;
  }

  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  const element = node instanceof HTMLElement ? node : null;

  return {
    tagName: node.tagName.toLowerCase(),
    id: node.id || null,
    className: getElementClassName(node),
    text: (node.textContent ?? "").trim(),
    dataAttributes: getTraceDataAttributes(node),
    rect: toRect(rect),
    scrollTop: element ? element.scrollTop : null,
    scrollLeft: element ? element.scrollLeft : null,
    scrollWidth: element ? element.scrollWidth : null,
    scrollHeight: element ? element.scrollHeight : null,
    clientWidth: element ? element.clientWidth : null,
    clientHeight: element ? element.clientHeight : null,
    position: style.position,
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    transform: style.transform,
    opacity: style.opacity,
    pointerEvents: style.pointerEvents,
  };
}

function snapshotAncestorChain(node: Element) {
  const chain: TitleShareTraceElementSnapshot[] = [];
  let current = node.parentElement;
  let depth = 0;

  while (current && depth < MAX_ANCESTOR_DEPTH) {
    const snapshot = snapshotTraceElement(current);
    if (snapshot) {
      chain.push(snapshot);
    }
    current = current.parentElement;
    depth += 1;
  }

  return chain;
}

function snapshotTitleShareEnvironment(): TitleShareTraceEnvironmentSnapshot | null {
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
    documentScroll: {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    },
    activeElement: snapshotTraceElement(document.activeElement),
    scrollRoots: Array.from(document.querySelectorAll(TRACE_SCROLL_ROOT_SELECTOR))
      .map((node) => snapshotTraceElement(node))
      .filter((node): node is TitleShareTraceElementSnapshot => node !== null),
    pageRoots: Array.from(document.querySelectorAll(TRACE_ROOT_SELECTOR))
      .map((node) => snapshotTraceElement(node))
      .filter((node): node is TitleShareTraceElementSnapshot => node !== null),
  };
}

function snapshotNode(node: Element): TitleShareTraceNodeSnapshot | null {
  if (!(node instanceof HTMLElement || node instanceof SVGElement)) {
    return null;
  }

  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  const nearestScrollRoot = node.closest(TRACE_SCROLL_ROOT_SELECTOR);
  const nearestScrollRootSnapshot = snapshotTraceElement(nearestScrollRoot);
  const nearestScrollRootRect = nearestScrollRoot instanceof HTMLElement
    ? nearestScrollRoot.getBoundingClientRect()
    : null;

  return {
    layoutId: node.getAttribute("data-title-layout-id") ?? "",
    role: node.getAttribute("data-title-role"),
    text: (node.textContent ?? "").trim(),
    tagName: node.tagName.toLowerCase(),
    className: getElementClassName(node),
    dataAttributes: getTraceDataAttributes(node),
    opacity: style.opacity,
    transform: style.transform,
    display: style.display,
    visibility: style.visibility,
    pointerEvents: style.pointerEvents,
    connected: node.isConnected,
    rect: toRect(rect),
    nearestScrollRoot: nearestScrollRootSnapshot,
    offsetToNearestScrollRoot: nearestScrollRootRect
      ? {
          x: rect.left - nearestScrollRootRect.left,
          y: rect.top - nearestScrollRootRect.top,
        }
      : null,
    ancestorChain: snapshotAncestorChain(node),
  };
}

export function snapshotTitleShareNodes() {
  if (typeof document === "undefined") {
    return [];
  }

  return Array.from(document.querySelectorAll(TITLE_LAYOUT_SELECTOR))
    .map((node) => snapshotNode(node))
    .filter((node): node is TitleShareTraceNodeSnapshot => node !== null);
}

export function recordTitleShareTrace(
  event: string,
  payload: Record<string, unknown> = {},
) {
  if (typeof window === "undefined") {
    return;
  }

  const traceContext = snapshotTitleShareEnvironment();
  const titleNodes = Array.isArray(payload.titleNodes)
    ? payload.titleNodes
    : snapshotTitleShareNodes();

  entries.push({
    seq: sequence,
    isoTime: new Date().toISOString(),
    performanceNow: performance.now(),
    event,
    payload: {
      ...payload,
      traceContext,
      titleNodes,
    },
  });
  sequence += 1;

  if (entries.length > MAX_TRACE_ENTRIES) {
    entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
  }
}

export function recordTitleShareNodeTrace(
  event: string,
  node: Element | null,
  payload: Record<string, unknown> = {},
) {
  recordTitleShareTrace(event, {
    ...payload,
    node: node ? snapshotNode(node) : null,
  });
}

export function captureTitleShareFrames(
  label: string,
  args?: {
    frames?: number;
    payload?: Record<string, unknown>;
  },
) {
  if (typeof window === "undefined") {
    return;
  }

  const frameCount = args?.frames ?? 18;
  let frameIndex = 0;
  let previousFrameTime: number | null = null;

  const sample = (frameTime: number) => {
    recordTitleShareTrace("frame", {
      label,
      frameIndex,
      frameTime,
      frameDelta: previousFrameTime === null ? null : frameTime - previousFrameTime,
      ...args?.payload,
    });

    previousFrameTime = frameTime;
    frameIndex += 1;
    if (frameIndex < frameCount) {
      requestAnimationFrame(sample);
    }
  };

  requestAnimationFrame(sample);
}

async function saveTitleShareTrace() {
  const path = await join(
    await downloadDir(),
    `title-share.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[titleShareTrace] saved ${path}`);
  return path;
}

export function installTitleShareTrace() {
  if (typeof window === "undefined" || window.__titleShareTraceInstalled) {
    return;
  }

  const api: TitleShareTraceApi = {
    clear() {
      entries.length = 0;
      sequence = 0;
      recordTitleShareTrace("trace-cleared");
    },
    entries() {
      return [...entries];
    },
    save: saveTitleShareTrace,
  };

  window.__titleShareTraceInstalled = true;
  window.__titleShareTraceApi = api;
  window.save = api.save;

  window.addEventListener(
    "scroll",
    (event) => {
      const target =
        event.target instanceof Document ? document.documentElement : event.target;

      recordTitleShareTrace("scroll", {
        target: target instanceof Element ? snapshotTraceElement(target) : null,
      });
    },
    { capture: true, passive: true },
  );

  window.addEventListener("resize", () => {
    recordTitleShareTrace("resize");
  });

  recordTitleShareTrace("trace-installed", {
    href: window.location.href,
  });
}
