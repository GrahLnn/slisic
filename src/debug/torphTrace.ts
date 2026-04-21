import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

type TorphDebugConfig =
  | boolean
  | {
      enabled?: boolean;
      capture?: boolean;
      console?: boolean;
    };

type TraceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type TraceElementSnapshot = {
  tagName: string;
  id: string | null;
  className: string;
  text: string;
  dataAttributes: Record<string, string>;
  rect: TraceRect;
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
  overflowX: string;
  overflowY: string;
  whiteSpace: string;
  width: string;
  height: string;
  transform: string;
  transformOrigin: string;
  opacity: string;
  filter: string;
  pointerEvents: string;
  willChange: string;
  transitionProperty: string;
  transitionDuration: string;
  transitionTimingFunction: string;
  inlineWidth: string | null;
  inlineHeight: string | null;
  inlineTransform: string | null;
  inlineTransformOrigin: string | null;
  inlineTransition: string | null;
  inlineOpacity: string | null;
  inlineFilter: string | null;
};

type TraceGlyphSnapshot = {
  role: string | null;
  key: string | null;
  glyph: string | null;
  kind: string | null;
  element: TraceElementSnapshot | null;
  contextSlice: TraceElementSnapshot | null;
};

type TraceAncestorSnapshot = {
  depth: number;
  element: TraceElementSnapshot;
};

type TraceItemSnapshot = {
  key: string;
  role: string | null;
  layoutId: string | null;
  text: string;
  playbackTarget: boolean;
  hiddenInPlay: boolean;
  connected: boolean;
  rect: TraceRect;
  offsetToScrollRoot: { x: number; y: number } | null;
  transform: string;
  opacity: string;
  filter: string;
  pointerEvents: string;
  className: string;
  dataAttributes: Record<string, string>;
  textHost: TraceElementSnapshot | null;
  torphRoot: TraceElementSnapshot | null;
  torphFlowShell: TraceElementSnapshot | null;
  torphFlow: TraceElementSnapshot | null;
  torphOverlay: TraceElementSnapshot | null;
  torphMeasurement: TraceElementSnapshot | null;
  torphOverlayGlyphs: TraceGlyphSnapshot[];
  itemAncestorChain: TraceAncestorSnapshot[];
  torphRootAncestorChain: TraceAncestorSnapshot[];
};

type TorphHostTraceEntry = {
  source: "playlist-host";
  seq: number;
  isoTime: string;
  performanceNow: number;
  event: string;
  payload: Record<string, unknown>;
};

type TorphLibraryTraceEntry = {
  source?: string;
  seq?: number;
  performanceNow?: number;
};

type TorphTraceApi = {
  clear: () => void;
  count: () => number;
  download: (filename?: string) => string | null;
  text: () => string;
};

type TorphHostTraceApi = {
  clear: () => void;
  entries: () => TorphHostTraceEntry[];
  save: () => Promise<string | null>;
};

declare global {
  interface Window {
    __TORPH_DEBUG__?: TorphDebugConfig;
    __TORPH_TRACE__?: TorphTraceApi;
    __torphHostTraceInstalled?: boolean;
    __torphHostTraceApi?: TorphHostTraceApi;
    saveTorphTrace?: () => Promise<string | null>;
  }
}

const TRACE_ROOT_SELECTOR = "[data-torph-trace-root]";
const TRACE_SCROLL_ROOT_SELECTOR = "[data-torph-trace-scroll-root]";
const TRACE_ITEM_SELECTOR = "[data-torph-trace-item-key]";
const TRACE_TEXT_HOST_SELECTOR = "[data-torph-trace-text-host]";
const TORPH_DEBUG_ROOT_SELECTOR = "[data-torph-debug-role='root']";
const TORPH_DEBUG_FLOW_SHELL_SELECTOR = "[data-torph-debug-role='flow-shell']";
const TORPH_DEBUG_FLOW_SELECTOR = "[data-torph-debug-role='flow']";
const TORPH_DEBUG_OVERLAY_SELECTOR = "[data-torph-debug-role='overlay']";
const TORPH_DEBUG_MEASUREMENT_SELECTOR = "[data-torph-debug-role='measurement']";
const TORPH_GLYPH_SELECTOR = "[data-morph-role]";
const MAX_TRACE_ENTRIES = 8_000;

let sequence = 0;
const entries: TorphHostTraceEntry[] = [];

function toRect(rect: DOMRect): TraceRect {
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
      .filter(
        (attribute) =>
          attribute.name.startsWith("data-torph-trace-") ||
          attribute.name.startsWith("data-torph-debug-") ||
          attribute.name.startsWith("data-title-") ||
          attribute.name.startsWith("data-page-") ||
          attribute.name.startsWith("data-morph-"),
      )
      .map((attribute) => [attribute.name, attribute.value]),
  );
}

function snapshotTraceElement(node: Element | null): TraceElementSnapshot | null {
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
    offsetWidth: element ? element.offsetWidth : null,
    offsetHeight: element ? element.offsetHeight : null,
    offsetLeft: element ? element.offsetLeft : null,
    offsetTop: element ? element.offsetTop : null,
    position: style.position,
    display: style.display,
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    whiteSpace: style.whiteSpace,
    width: style.width,
    height: style.height,
    transform: style.transform,
    transformOrigin: style.transformOrigin,
    opacity: style.opacity,
    filter: style.filter,
    pointerEvents: style.pointerEvents,
    willChange: style.willChange,
    transitionProperty: style.transitionProperty,
    transitionDuration: style.transitionDuration,
    transitionTimingFunction: style.transitionTimingFunction,
    inlineWidth: element?.style.width || null,
    inlineHeight: element?.style.height || null,
    inlineTransform: element?.style.transform || null,
    inlineTransformOrigin: element?.style.transformOrigin || null,
    inlineTransition: element?.style.transition || null,
    inlineOpacity: element?.style.opacity || null,
    inlineFilter: element?.style.filter || null,
  };
}

function snapshotAncestorChain(
  node: Element | null,
  options?: {
    maxDepth?: number;
  },
): TraceAncestorSnapshot[] {
  if (node === null) {
    return [];
  }

  const maxDepth = options?.maxDepth ?? 10;
  const ancestors: TraceAncestorSnapshot[] = [];
  let depth = 0;
  let current = node.parentElement;

  while (current !== null && depth < maxDepth) {
    const snapshot = snapshotTraceElement(current);
    if (snapshot !== null) {
      ancestors.push({
        depth,
        element: snapshot,
      });
    }

    if (
      current.matches(TRACE_SCROLL_ROOT_SELECTOR) ||
      current.matches(TRACE_ROOT_SELECTOR)
    ) {
      break;
    }

    current = current.parentElement;
    depth += 1;
  }

  return ancestors;
}

function snapshotOverlayGlyphs(node: Element | null): TraceGlyphSnapshot[] {
  if (!(node instanceof HTMLElement || node instanceof SVGElement)) {
    return [];
  }

  return Array.from(node.querySelectorAll<HTMLElement>(TORPH_GLYPH_SELECTOR)).map(
    (glyphNode) => {
      const contextSlice = glyphNode.querySelector<HTMLElement>(
        "[data-morph-slice='context']",
      );

      return {
        role: glyphNode.dataset.morphRole ?? null,
        key: glyphNode.dataset.morphKey ?? null,
        glyph: glyphNode.dataset.morphGlyph ?? null,
        kind: glyphNode.dataset.morphKind ?? null,
        element: snapshotTraceElement(glyphNode),
        contextSlice: snapshotTraceElement(contextSlice),
      };
    },
  );
}

function snapshotTraceItems(): TraceItemSnapshot[] {
  if (typeof document === "undefined") {
    return [];
  }

  return Array.from(document.querySelectorAll<HTMLElement>(TRACE_ITEM_SELECTOR))
    .map((node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const scrollRoot = node.closest(TRACE_SCROLL_ROOT_SELECTOR);
      const scrollRootRect =
        scrollRoot instanceof HTMLElement
          ? scrollRoot.getBoundingClientRect()
          : null;
      const textHost = node.querySelector(TRACE_TEXT_HOST_SELECTOR);
      const torphScope = textHost ?? node;
      const torphRoot = torphScope.querySelector(TORPH_DEBUG_ROOT_SELECTOR);
      const torphFlowShell = torphScope.querySelector(TORPH_DEBUG_FLOW_SHELL_SELECTOR);
      const torphFlow = torphScope.querySelector(TORPH_DEBUG_FLOW_SELECTOR);
      const torphOverlay = torphScope.querySelector(TORPH_DEBUG_OVERLAY_SELECTOR);
      const torphMeasurement = torphScope.querySelector(
        TORPH_DEBUG_MEASUREMENT_SELECTOR,
      );

      return {
        key: node.dataset.torphTraceItemKey ?? "",
        role: node.dataset.torphTraceRole ?? null,
        layoutId: node.dataset.torphTraceLayoutId ?? null,
        text: node.dataset.torphTraceText ?? (node.textContent ?? "").trim(),
        playbackTarget: node.dataset.torphTracePlaybackTarget === "true",
        hiddenInPlay: node.dataset.torphTraceHiddenInPlay === "true",
        connected: node.isConnected,
        rect: toRect(rect),
        offsetToScrollRoot: scrollRootRect
          ? {
              x: rect.left - scrollRootRect.left,
              y: rect.top - scrollRootRect.top,
            }
          : null,
        transform: style.transform,
        opacity: style.opacity,
        filter: style.filter,
        pointerEvents: style.pointerEvents,
        className: getElementClassName(node),
        dataAttributes: getTraceDataAttributes(node),
        textHost: snapshotTraceElement(textHost),
        torphRoot: snapshotTraceElement(torphRoot),
        torphFlowShell: snapshotTraceElement(torphFlowShell),
        torphFlow: snapshotTraceElement(torphFlow),
        torphOverlay: snapshotTraceElement(torphOverlay),
        torphMeasurement: snapshotTraceElement(torphMeasurement),
        torphOverlayGlyphs: snapshotOverlayGlyphs(torphOverlay),
        itemAncestorChain: snapshotAncestorChain(node),
        torphRootAncestorChain: snapshotAncestorChain(torphRoot),
      };
    })
    .sort((left, right) => left.rect.top - right.rect.top);
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
    activeElement: snapshotTraceElement(document.activeElement),
    roots: Array.from(document.querySelectorAll(TRACE_ROOT_SELECTOR))
      .map((node) => snapshotTraceElement(node))
      .filter((node): node is TraceElementSnapshot => node !== null),
    scrollRoots: Array.from(document.querySelectorAll(TRACE_SCROLL_ROOT_SELECTOR))
      .map((node) => snapshotTraceElement(node))
      .filter((node): node is TraceElementSnapshot => node !== null),
    itemCount: document.querySelectorAll(TRACE_ITEM_SELECTOR).length,
  };
}

function readTorphLibraryEntries() {
  const text = window.__TORPH_TRACE__?.text();
  if (!text) {
    return [] as Record<string, unknown>[];
  }

  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function resolveMergedTraceEntries() {
  const hostEntries = [...entries];
  const libraryEntries = readTorphLibraryEntries();
  const merged = [
    ...hostEntries.map((entry, index) => ({
      entry,
      index,
      performanceNow: entry.performanceNow,
      seq: entry.seq,
      source: entry.source,
    })),
    ...libraryEntries.map((entry, index) => {
      const typedEntry = entry as TorphLibraryTraceEntry;
      return {
        entry,
        index: hostEntries.length + index,
        performanceNow:
          typeof typedEntry.performanceNow === "number"
            ? typedEntry.performanceNow
            : Number.POSITIVE_INFINITY,
        seq: typeof typedEntry.seq === "number" ? typedEntry.seq : index,
        source: typedEntry.source ?? "torph",
      };
    }),
  ];

  merged.sort((left, right) => {
    if (left.performanceNow !== right.performanceNow) {
      return left.performanceNow - right.performanceNow;
    }

    if (left.source !== right.source) {
      return String(left.source).localeCompare(String(right.source));
    }

    if (left.seq !== right.seq) {
      return left.seq - right.seq;
    }

    return left.index - right.index;
  });

  return merged.map((item) => item.entry);
}

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

function resolveTorphDebugConfig(config: TorphDebugConfig | undefined) {
  if (typeof config === "boolean") {
    return {
      enabled: config,
      capture: true,
      console: false,
    } satisfies Exclude<TorphDebugConfig, boolean>;
  }

  return {
    ...config,
    capture: true,
    console: config?.console ?? false,
  } satisfies Exclude<TorphDebugConfig, boolean>;
}

export function recordTorphHostTrace(
  event: string,
  payload: Record<string, unknown> = {},
) {
  if (typeof window === "undefined") {
    return;
  }

  entries.push({
    source: "playlist-host",
    seq: sequence,
    isoTime: new Date().toISOString(),
    performanceNow: performance.now(),
    event,
    payload: {
      ...payload,
      traceContext: snapshotEnvironment(),
      items:
        Array.isArray(payload.items) && payload.items.length > 0
          ? payload.items
          : snapshotTraceItems(),
    },
  });
  sequence += 1;
  trimEntries();
}

export function captureTorphHostFrames(
  label: string,
  args?: {
    frames?: number;
    payload?: Record<string, unknown>;
  },
) {
  if (typeof window === "undefined") {
    return;
  }

  const frameCount = args?.frames ?? 24;
  let frameIndex = 0;
  let previousFrameTime: number | null = null;

  const sample = (frameTime: number) => {
    recordTorphHostTrace("frame", {
      label,
      frameIndex,
      frameTime,
      frameDelta:
        previousFrameTime === null ? null : frameTime - previousFrameTime,
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

async function saveTorphTrace() {
  const path = await join(
    await downloadDir(),
    `torph-trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = resolveMergedTraceEntries()
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  await writeTextFile(path, contents);
  console.log(`[torphTrace] saved ${path}`);
  return path;
}

export function installTorphTrace() {
  if (typeof window === "undefined" || window.__torphHostTraceInstalled) {
    return;
  }

  window.__TORPH_DEBUG__ = resolveTorphDebugConfig(window.__TORPH_DEBUG__);

  const api: TorphHostTraceApi = {
    clear() {
      entries.length = 0;
      sequence = 0;
      window.__TORPH_TRACE__?.clear();
      recordTorphHostTrace("trace-cleared");
    },
    entries() {
      return [...entries];
    },
    save: saveTorphTrace,
  };

  window.__torphHostTraceInstalled = true;
  window.__torphHostTraceApi = api;
  window.saveTorphTrace = api.save;

  window.addEventListener(
    "scroll",
    (event) => {
      const target =
        event.target instanceof Document ? document.documentElement : event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const isRelevant =
        target.matches(TRACE_SCROLL_ROOT_SELECTOR) ||
        target.closest(TRACE_ROOT_SELECTOR) !== null;
      if (!isRelevant) {
        return;
      }

      recordTorphHostTrace("scroll", {
        target: snapshotTraceElement(target),
      });
    },
    { capture: true, passive: true },
  );

  window.addEventListener("resize", () => {
    recordTorphHostTrace("resize");
  });

  recordTorphHostTrace("trace-installed", {
    href: window.location.href,
  });
}
