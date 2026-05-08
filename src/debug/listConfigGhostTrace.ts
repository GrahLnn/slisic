import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

export type GhostTraceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type GhostTracePoint = {
  x: number;
  y: number;
};

type GhostTraceMatrixSnapshot = {
  values: number[];
};

export type GhostTraceElementCoreSnapshot = {
  tagName: string;
  id: string | null;
  className: string;
  text: string;
  dataAttributes: Record<string, string>;
  rect: GhostTraceRect;
  devicePixelRatio: number | null;
  devicePixelRect: GhostTraceRect | null;
  textVisibleRectSource: string | null;
  textVisibleRect: GhostTraceRect | null;
  devicePixelTextVisibleRect: GhostTraceRect | null;
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
  visibility: string;
  boxSizing: string;
  left: string;
  top: string;
  margin: string;
  overflow: string;
  overflowX: string;
  overflowY: string;
  whiteSpace: string;
  overflowWrap: string;
  wordBreak: string;
  width: string;
  height: string;
  lineHeight: string;
  transform: string;
  transformMatrix: GhostTraceMatrixSnapshot | null;
  transformOrigin: string;
  transformOriginPoint: GhostTracePoint | null;
  opacity: string;
  clipPath: string;
  filter: string;
  pointerEvents: string;
  willChange: string;
  transitionProperty: string;
  transitionDuration: string;
  transitionTimingFunction: string;
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

type GhostTraceElementSnapshot = GhostTraceElementCoreSnapshot & {
  toolLabelTextContainer: GhostTraceElementCoreSnapshot | null;
  toolLabelTextSurface: GhostTraceElementCoreSnapshot | null;
  torphStage: string | null;
  torphRoot: GhostTraceElementCoreSnapshot | null;
  torphFlowShell: GhostTraceElementCoreSnapshot | null;
  torphFlow: GhostTraceElementCoreSnapshot | null;
  torphOverlay: GhostTraceElementCoreSnapshot | null;
  torphMeasurement: GhostTraceElementCoreSnapshot | null;
  torphOverlayLiveGlyphCount: number;
  torphOverlayLiveGlyphRect: GhostTraceRect | null;
  torphVisibleLayerRole: string | null;
  torphVisibleLayerRectSource: string | null;
  torphVisibleLayerRect: GhostTraceRect | null;
};

type GhostTraceTorphSnapshot = Pick<
  GhostTraceElementSnapshot,
  | "torphStage"
  | "torphRoot"
  | "torphFlowShell"
  | "torphFlow"
  | "torphOverlay"
  | "torphMeasurement"
  | "torphOverlayLiveGlyphCount"
  | "torphOverlayLiveGlyphRect"
  | "torphVisibleLayerRole"
  | "torphVisibleLayerRectSource"
  | "torphVisibleLayerRect"
>;

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
const TORPH_DEBUG_ROOT_SELECTOR = "[data-torph-debug-role='root']";
const TORPH_DEBUG_FLOW_SHELL_SELECTOR = "[data-torph-debug-role='flow-shell']";
const TORPH_DEBUG_FLOW_SELECTOR = "[data-torph-debug-role='flow']";
const TORPH_DEBUG_OVERLAY_SELECTOR = "[data-torph-debug-role='overlay']";
const TORPH_DEBUG_MEASUREMENT_SELECTOR = "[data-torph-debug-role='measurement']";
const TORPH_LIVE_GLYPH_SELECTOR = "[data-morph-role='live']";
const TOOL_LABEL_TEXT_CONTAINER_SELECTOR = "[data-tool-label-debug-role='text-container']";
const TOOL_LABEL_TEXT_SURFACE_SELECTOR = "[data-tool-label-debug-role='text-surface']";
const MAX_TEXT_VISIBLE_RECT_TEXT_LENGTH = 160;
const MAX_TEXT_VISIBLE_RECT_DESCENDANTS = 24;
const MAX_TEXT_VISIBLE_RECT_TEXT_NODES = 24;

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

function toDevicePixelRect(rect: GhostTraceRect | null, devicePixelRatio: number | null) {
  if (!rect || !devicePixelRatio || !Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    return null;
  }

  return {
    x: Math.round(rect.x * devicePixelRatio),
    y: Math.round(rect.y * devicePixelRatio),
    width: Math.round(rect.width * devicePixelRatio),
    height: Math.round(rect.height * devicePixelRatio),
    top: Math.round(rect.top * devicePixelRatio),
    right: Math.round(rect.right * devicePixelRatio),
    bottom: Math.round(rect.bottom * devicePixelRatio),
    left: Math.round(rect.left * devicePixelRatio),
  } satisfies GhostTraceRect;
}

function parseGhostTraceTransformMatrix(transform: string) {
  if (!transform || transform === "none") {
    return null;
  }

  const values = transform
    .match(/matrix(3d)?\((.+)\)/)?.[2]
    ?.split(",")
    .map((part) => Number.parseFloat(part.trim()))
    .filter((value) => Number.isFinite(value));

  if (!values || values.length === 0) {
    return null;
  }

  return {
    values,
  } satisfies GhostTraceMatrixSnapshot;
}

function parseGhostTraceTransformOrigin(transformOrigin: string) {
  const [xValue, yValue] = transformOrigin.split(/\s+/);
  const x = Number.parseFloat(xValue ?? "");
  const y = Number.parseFloat(yValue ?? "");

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return {
    x,
    y,
  } satisfies GhostTracePoint;
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

function resolveGhostTraceTextVisibleRect(node: Element) {
  const ownerDocument = node.ownerDocument;
  if (!ownerDocument || node === ownerDocument.body || node === ownerDocument.documentElement) {
    return {
      rect: null,
      rectSource: null,
    };
  }

  const text = (node.textContent ?? "").trim();
  if (text.length === 0 || text.length > MAX_TEXT_VISIBLE_RECT_TEXT_LENGTH) {
    return {
      rect: null,
      rectSource: null,
    };
  }

  if (node.querySelectorAll("*").length > MAX_TEXT_VISIBLE_RECT_DESCENDANTS) {
    return {
      rect: null,
      rectSource: null,
    };
  }

  const walker = ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode(candidate) {
      return candidate.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const range = ownerDocument.createRange();
  const rects: GhostTraceRect[] = [];
  let textNodeCount = 0;

  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (!(current instanceof Text)) {
      continue;
    }

    textNodeCount += 1;
    if (textNodeCount > MAX_TEXT_VISIBLE_RECT_TEXT_NODES) {
      return {
        rect: null,
        rectSource: null,
      };
    }

    range.selectNodeContents(current);
    for (const clientRect of Array.from(range.getClientRects())) {
      if (clientRect.width <= 0 || clientRect.height <= 0) {
        continue;
      }

      rects.push(toRect(clientRect));
    }
  }

  const rect = resolveGhostTraceRectUnion(rects);
  return {
    rect,
    rectSource: rect ? "text-range-client-rects" : null,
  };
}

function snapshotGhostTraceElementCore(node: Element | null): GhostTraceElementCoreSnapshot | null {
  if (!(node instanceof HTMLElement || node instanceof SVGElement)) {
    return null;
  }

  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  const element = node instanceof HTMLElement ? node : null;
  const devicePixelRatio =
    node.ownerDocument.defaultView?.devicePixelRatio ?? window.devicePixelRatio ?? null;
  const textVisibleRect = resolveGhostTraceTextVisibleRect(node);
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
    devicePixelRatio,
    devicePixelRect: toDevicePixelRect(toRect(rect), devicePixelRatio),
    textVisibleRectSource: textVisibleRect.rectSource,
    textVisibleRect: textVisibleRect.rect,
    devicePixelTextVisibleRect: toDevicePixelRect(textVisibleRect.rect, devicePixelRatio),
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
    visibility: style.visibility,
    boxSizing: style.boxSizing,
    left: style.left,
    top: style.top,
    margin: style.margin,
    overflow: style.overflow,
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    whiteSpace: style.whiteSpace,
    overflowWrap: style.overflowWrap,
    wordBreak: style.wordBreak,
    width: style.width,
    height: style.height,
    lineHeight: style.lineHeight,
    transform: style.transform,
    transformMatrix: parseGhostTraceTransformMatrix(style.transform),
    transformOrigin: style.transformOrigin,
    transformOriginPoint: parseGhostTraceTransformOrigin(style.transformOrigin),
    opacity: style.opacity,
    clipPath: style.clipPath,
    filter: style.filter,
    pointerEvents: style.pointerEvents,
    willChange: style.willChange,
    transitionProperty: style.transitionProperty,
    transitionDuration: style.transitionDuration,
    transitionTimingFunction: style.transitionTimingFunction,
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

function isGhostTraceSnapshotVisible(
  snapshot: GhostTraceElementCoreSnapshot | null,
): snapshot is GhostTraceElementCoreSnapshot {
  if (!snapshot) {
    return false;
  }

  if (snapshot.display === "none" || snapshot.visibility === "hidden") {
    return false;
  }

  const opacity = Number.parseFloat(snapshot.opacity);
  if (Number.isFinite(opacity) && opacity <= 0) {
    return false;
  }

  return snapshot.rect.width > 0 && snapshot.rect.height > 0;
}

export function resolveGhostTraceVisibleLayer(args: {
  flow: GhostTraceElementCoreSnapshot | null;
  flowShell: GhostTraceElementCoreSnapshot | null;
  overlay: GhostTraceElementCoreSnapshot | null;
  overlayLiveGlyphRect: GhostTraceRect | null;
  root: GhostTraceElementCoreSnapshot | null;
}) {
  const resolveVisibleSnapshotRect = (
    snapshot: GhostTraceElementCoreSnapshot,
    role: "flow" | "flow-shell" | "root",
  ) => {
    if (snapshot.textVisibleRect) {
      return {
        role,
        rect: snapshot.textVisibleRect,
        rectSource: `${role}-${snapshot.textVisibleRectSource ?? "text-visible-rect"}`,
      } as const;
    }

    return {
      role,
      rect: snapshot.rect,
      rectSource: role,
    } as const;
  };

  if (isGhostTraceSnapshotVisible(args.overlay) && args.overlayLiveGlyphRect) {
    return {
      role: "overlay",
      rect: args.overlayLiveGlyphRect,
      rectSource: "overlay-live-glyphs",
    } as const;
  }

  if (isGhostTraceSnapshotVisible(args.flow)) {
    return resolveVisibleSnapshotRect(args.flow, "flow");
  }

  if (isGhostTraceSnapshotVisible(args.flowShell)) {
    return resolveVisibleSnapshotRect(args.flowShell, "flow-shell");
  }

  if (isGhostTraceSnapshotVisible(args.root)) {
    return resolveVisibleSnapshotRect(args.root, "root");
  }

  return {
    role: null,
    rect: null,
    rectSource: null,
  } as const;
}

export function resolveGhostTraceElementTextVisibleRect(args: {
  textVisibleRect: GhostTraceRect | null;
  textVisibleRectSource: string | null;
  torphVisibleLayerRect: GhostTraceRect | null;
  torphVisibleLayerRectSource: string | null;
}) {
  if (args.torphVisibleLayerRect) {
    return {
      rect: args.torphVisibleLayerRect,
      rectSource: args.torphVisibleLayerRectSource
        ? `torph:${args.torphVisibleLayerRectSource}`
        : "torph",
    } as const;
  }

  return {
    rect: args.textVisibleRect,
    rectSource: args.textVisibleRect ? args.textVisibleRectSource : null,
  } as const;
}

function resolveGhostTraceRectUnion(rects: GhostTraceRect[]) {
  if (rects.length === 0) {
    return null;
  }

  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    top,
    right,
    bottom,
    left,
  } satisfies GhostTraceRect;
}

function resolveGhostTraceTorphRoot(node: Element) {
  if (node.matches(TORPH_DEBUG_ROOT_SELECTOR)) {
    return node;
  }

  const roots = node.querySelectorAll(TORPH_DEBUG_ROOT_SELECTOR);
  return roots.length === 1 ? roots[0] : null;
}

function resolveGhostTraceScopedNode(scope: Element, selector: string) {
  if (scope.matches(selector)) {
    return scope;
  }

  return scope.querySelector(selector);
}

function snapshotGhostTraceToolLabel(node: Element) {
  const textContainerNode = resolveGhostTraceScopedNode(node, TOOL_LABEL_TEXT_CONTAINER_SELECTOR);
  const textSurfaceNode =
    resolveGhostTraceScopedNode(textContainerNode ?? node, TOOL_LABEL_TEXT_SURFACE_SELECTOR) ??
    null;

  return {
    toolLabelTextContainer: snapshotGhostTraceElementCore(textContainerNode),
    toolLabelTextSurface: snapshotGhostTraceElementCore(textSurfaceNode),
  } satisfies Pick<GhostTraceElementSnapshot, "toolLabelTextContainer" | "toolLabelTextSurface">;
}

function snapshotGhostTraceOverlayLiveGlyphRect(overlayNode: Element | null) {
  if (!(overlayNode instanceof HTMLElement || overlayNode instanceof SVGElement)) {
    return {
      count: 0,
      rect: null,
    };
  }

  const visibleGlyphRects = Array.from(
    overlayNode.querySelectorAll<HTMLElement>(TORPH_LIVE_GLYPH_SELECTOR),
  )
    .map((glyphNode) => snapshotGhostTraceElementCore(glyphNode))
    .filter((snapshot): snapshot is GhostTraceElementCoreSnapshot =>
      isGhostTraceSnapshotVisible(snapshot),
    )
    .map((snapshot) => snapshot.rect);

  return {
    count: visibleGlyphRects.length,
    rect: resolveGhostTraceRectUnion(visibleGlyphRects),
  };
}

function snapshotGhostTraceTorph(node: Element) {
  const torphRootNode = resolveGhostTraceTorphRoot(node);

  if (!torphRootNode) {
    return {
      torphStage: null,
      torphRoot: null,
      torphFlowShell: null,
      torphFlow: null,
      torphOverlay: null,
      torphMeasurement: null,
      torphOverlayLiveGlyphCount: 0,
      torphOverlayLiveGlyphRect: null,
      torphVisibleLayerRole: null,
      torphVisibleLayerRectSource: null,
      torphVisibleLayerRect: null,
    } satisfies GhostTraceTorphSnapshot;
  }

  const torphRoot = snapshotGhostTraceElementCore(torphRootNode);
  const flowShellNode = resolveGhostTraceScopedNode(torphRootNode, TORPH_DEBUG_FLOW_SHELL_SELECTOR);
  const flowNode = resolveGhostTraceScopedNode(torphRootNode, TORPH_DEBUG_FLOW_SELECTOR);
  const overlayNode = resolveGhostTraceScopedNode(torphRootNode, TORPH_DEBUG_OVERLAY_SELECTOR);
  const measurementNode = resolveGhostTraceScopedNode(
    torphRootNode,
    TORPH_DEBUG_MEASUREMENT_SELECTOR,
  );
  const torphFlowShell = snapshotGhostTraceElementCore(flowShellNode);
  const torphFlow = snapshotGhostTraceElementCore(flowNode);
  const torphOverlay = snapshotGhostTraceElementCore(overlayNode);
  const torphMeasurement = snapshotGhostTraceElementCore(measurementNode);
  const overlayLiveGlyph = snapshotGhostTraceOverlayLiveGlyphRect(overlayNode);
  const visibleLayer = resolveGhostTraceVisibleLayer({
    flow: torphFlow,
    flowShell: torphFlowShell,
    overlay: torphOverlay,
    overlayLiveGlyphRect: overlayLiveGlyph.rect,
    root: torphRoot,
  });

  return {
    torphStage: torphRootNode.getAttribute("data-torph-debug-stage"),
    torphRoot,
    torphFlowShell,
    torphFlow,
    torphOverlay,
    torphMeasurement,
    torphOverlayLiveGlyphCount: overlayLiveGlyph.count,
    torphOverlayLiveGlyphRect: overlayLiveGlyph.rect,
    torphVisibleLayerRole: visibleLayer.role,
    torphVisibleLayerRectSource: visibleLayer.rectSource,
    torphVisibleLayerRect: visibleLayer.rect,
  } satisfies GhostTraceTorphSnapshot;
}

export function snapshotListConfigGhostElement(
  node: Element | null,
): GhostTraceElementSnapshot | null {
  const snapshot = snapshotGhostTraceElementCore(node);

  if (!snapshot || !(node instanceof HTMLElement || node instanceof SVGElement)) {
    return null;
  }

  const torphSnapshot = snapshotGhostTraceTorph(node);
  const toolLabelSnapshot = snapshotGhostTraceToolLabel(node);
  const textVisibleRect = resolveGhostTraceElementTextVisibleRect({
    textVisibleRect: snapshot.textVisibleRect,
    textVisibleRectSource: snapshot.textVisibleRectSource,
    torphVisibleLayerRect: torphSnapshot.torphVisibleLayerRect,
    torphVisibleLayerRectSource: torphSnapshot.torphVisibleLayerRectSource,
  });

  return {
    ...snapshot,
    ...toolLabelSnapshot,
    ...torphSnapshot,
    textVisibleRectSource: textVisibleRect.rectSource,
    textVisibleRect: textVisibleRect.rect,
    devicePixelTextVisibleRect: toDevicePixelRect(textVisibleRect.rect, snapshot.devicePixelRatio),
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
      devicePixelRatio: window.devicePixelRatio,
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
