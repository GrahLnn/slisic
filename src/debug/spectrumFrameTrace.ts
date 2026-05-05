import { downloadDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";

type SpectrumFrameTraceRect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
  x: number;
  y: number;
};

type SpectrumFrameTraceElementSnapshot = {
  animationCount: number;
  className: string | null;
  dataset: Record<string, string>;
  rect: SpectrumFrameTraceRect;
  tagName: string;
  text: string;
  transform: string;
};

type SpectrumFrameTraceObservedElement = {
  index: number;
  node: HTMLElement;
  path: string;
  snapshot: SpectrumFrameTraceElementSnapshot | null;
};

type SpectrumFrameTraceObservedElementPayload = Omit<SpectrumFrameTraceObservedElement, "node">;

type SpectrumFrameTraceMotionPoint = {
  centerX: number;
  centerY: number;
  className: string | null;
  deltaFromPreviousFrame: {
    distance: number;
    dx: number;
    dy: number;
    elapsedMs: number | null;
  } | null;
  frameIndex: number;
  frameTime: number;
  path: string;
  rect: SpectrumFrameTraceRect;
  tagName: string;
  transform: string;
  transformTranslateX: number | null;
  transformTranslateY: number | null;
};

type SpectrumLongAnimationFrameScriptEntry = {
  durationMs: number;
  forcedStyleAndLayoutDurationMs: number | null;
  invoker: string | null;
  invokerType: string | null;
  pauseDurationMs: number | null;
  sourceCharPosition: number | null;
  sourceFunctionName: string | null;
  sourceURL: string | null;
};

type SpectrumLongAnimationFrameEntry = PerformanceEntry & {
  blockingDuration?: number;
  firstUIEventTimestamp?: number;
  renderStart?: number;
  scripts?: Array<{
    duration?: number;
    forcedStyleAndLayoutDuration?: number;
    invoker?: string;
    invokerType?: string;
    pauseDuration?: number;
    sourceCharPosition?: number;
    sourceFunctionName?: string;
    sourceURL?: string;
  }>;
  styleAndLayoutStart?: number;
};

type SpectrumFrameTraceEntry = {
  event: string;
  isoTime: string;
  payload: Record<string, unknown>;
  performanceNow: number;
  seq: number;
};

type SpectrumFrameTraceApi = {
  captureTitleFrames: (
    label: string,
    args?: {
      frames?: number;
      payload?: Record<string, unknown>;
      sample?: () => Record<string, unknown>;
      titleNode?: HTMLElement | null;
    },
  ) => void;
  clear: () => void;
  entries: () => SpectrumFrameTraceEntry[];
  record: (event: string, payload?: Record<string, unknown>) => void;
  save: () => Promise<string | null>;
};

export type SpectrumFrameReactProfilerTrace = {
  actualDurationMs: number;
  baseDurationMs: number;
  commitTime: number;
  id: string;
  phase: "mount" | "nested-update" | "update";
  startTime: number;
};

declare global {
  interface Window {
    __spectrumFrameTraceApi?: SpectrumFrameTraceApi;
    __spectrumFrameTraceInstalled?: boolean;
    saveSpectrumFrameTrace?: () => Promise<string | null>;
  }
}

const MAX_TRACE_ENTRIES = 12_000;
const DEFAULT_TITLE_FRAME_COUNT = 90;
const TITLE_MOTION_GAP_THRESHOLD_MS = 24;
const TITLE_MOTION_TRAIL_LENGTH = 12;

let sequence = 0;
const entries: SpectrumFrameTraceEntry[] = [];
const activeTitleCaptureTokens = new Map<string, number>();
let longTaskObserver: PerformanceObserver | null = null;
let longAnimationFrameObserver: PerformanceObserver | null = null;

function trimEntries() {
  if (entries.length <= MAX_TRACE_ENTRIES) {
    return;
  }

  entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

function toTraceRect(rect: DOMRect): SpectrumFrameTraceRect {
  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
    x: rect.x,
    y: rect.y,
  };
}

function snapshotDataset(node: HTMLElement) {
  return Object.fromEntries(
    Object.entries(node.dataset).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export function snapshotSpectrumFrameTraceElement(
  node: HTMLElement | null,
): SpectrumFrameTraceElementSnapshot | null {
  if (typeof window === "undefined" || !node) {
    return null;
  }

  const style = window.getComputedStyle(node);
  return {
    animationCount: node.getAnimations({ subtree: true }).length,
    className: typeof node.className === "string" ? node.className : null,
    dataset: snapshotDataset(node),
    rect: toTraceRect(node.getBoundingClientRect()),
    tagName: node.tagName.toLowerCase(),
    text: (node.textContent ?? "").trim(),
    transform: style.transform,
  };
}

function createSpectrumFrameTraceElementPath(root: HTMLElement, node: HTMLElement) {
  if (root === node) {
    return ":scope";
  }

  const parts: string[] = [];
  let current: HTMLElement | null = node;

  while (current && current !== root) {
    const parentElement: HTMLElement | null = current.parentElement;
    if (!parentElement) {
      break;
    }

    const childIndex = Array.prototype.indexOf.call(parentElement.children, current);
    parts.unshift(`${current.tagName.toLowerCase()}[${childIndex}]`);
    current = parentElement;
  }

  return parts.length > 0 ? `:scope > ${parts.join(" > ")}` : node.tagName.toLowerCase();
}

function snapshotSpectrumFrameTraceDescendants(
  node: HTMLElement | null,
): SpectrumFrameTraceObservedElement[] {
  if (!node) {
    return [];
  }

  return Array.from(node.querySelectorAll<HTMLElement>("div, textarea"))
    .slice(0, 8)
    .map((descendant, index) => ({
      index,
      node: descendant,
      path: createSpectrumFrameTraceElementPath(node, descendant),
      snapshot: snapshotSpectrumFrameTraceElement(descendant),
    }));
}

function serializeSpectrumFrameTraceObservedElement(
  element: SpectrumFrameTraceObservedElement,
): SpectrumFrameTraceObservedElementPayload {
  return {
    index: element.index,
    path: element.path,
    snapshot: element.snapshot,
  };
}

function serializeSpectrumFrameTraceObservedElements(
  elements: SpectrumFrameTraceObservedElement[],
) {
  return elements.map(serializeSpectrumFrameTraceObservedElement);
}

function readSpectrumFrameTraceTransformTranslation(transform: string) {
  if (typeof window === "undefined" || transform === "none") {
    return {
      x: null,
      y: null,
    };
  }

  try {
    const matrix = new window.DOMMatrixReadOnly(transform);
    return {
      x: matrix.m41,
      y: matrix.m42,
    };
  } catch {
    return {
      x: null,
      y: null,
    };
  }
}

function createSpectrumFrameTraceMotionPointFromSnapshot(args: {
  className: string | null;
  frameIndex: number;
  frameTime: number;
  path: string;
  previousMotion: SpectrumFrameTraceMotionPoint | null;
  rect: SpectrumFrameTraceRect;
  tagName: string;
  transform: string;
}) {
  const { rect, transform } = args;
  const transformTranslation = readSpectrumFrameTraceTransformTranslation(transform);
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const dx = args.previousMotion ? rect.left - args.previousMotion.rect.left : 0;
  const dy = args.previousMotion ? rect.top - args.previousMotion.rect.top : 0;
  const elapsedMs = args.previousMotion ? args.frameTime - args.previousMotion.frameTime : null;

  return {
    centerX,
    centerY,
    className: args.className,
    deltaFromPreviousFrame: args.previousMotion
      ? {
          distance: Math.hypot(dx, dy),
          dx,
          dy,
          elapsedMs,
        }
      : null,
    frameIndex: args.frameIndex,
    frameTime: args.frameTime,
    path: args.path,
    rect,
    tagName: args.tagName,
    transform,
    transformTranslateX: transformTranslation.x,
    transformTranslateY: transformTranslation.y,
  } satisfies SpectrumFrameTraceMotionPoint;
}

function createSpectrumFrameTraceMotionPoint(args: {
  frameIndex: number;
  frameTime: number;
  observed: SpectrumFrameTraceObservedElement;
  previousMotion: SpectrumFrameTraceMotionPoint | null;
}) {
  if (!args.observed.snapshot) {
    return null;
  }

  return createSpectrumFrameTraceMotionPointFromSnapshot({
    className: args.observed.snapshot.className,
    frameIndex: args.frameIndex,
    frameTime: args.frameTime,
    path: args.observed.path,
    previousMotion: args.previousMotion,
    rect: args.observed.snapshot.rect,
    tagName: args.observed.snapshot.tagName,
    transform: args.observed.snapshot.transform,
  });
}

function createSpectrumFrameTraceMotionPointFromNode(args: {
  frameIndex: number;
  frameTime: number;
  node: HTMLElement;
  path: string;
  previousMotion: SpectrumFrameTraceMotionPoint | null;
}) {
  if (typeof window === "undefined") {
    return null;
  }

  const style = window.getComputedStyle(args.node);
  return createSpectrumFrameTraceMotionPointFromSnapshot({
    className: typeof args.node.className === "string" ? args.node.className : null,
    frameIndex: args.frameIndex,
    frameTime: args.frameTime,
    path: args.path,
    previousMotion: args.previousMotion,
    rect: toTraceRect(args.node.getBoundingClientRect()),
    tagName: args.node.tagName.toLowerCase(),
    transform: style.transform,
  });
}

function resolveSpectrumFrameTraceMotionElement(args: {
  activeMotionPath: string | null;
  observedElements: SpectrumFrameTraceObservedElement[];
}) {
  if (args.activeMotionPath) {
    const activeElement = args.observedElements.find(
      (element) => element.path === args.activeMotionPath,
    );
    if (activeElement?.snapshot) {
      return activeElement;
    }
  }

  const transformedElement = args.observedElements.find(
    (element) =>
      element.snapshot?.transform !== undefined &&
      element.snapshot.transform !== "none" &&
      element.snapshot.tagName !== "textarea",
  );
  if (transformedElement) {
    return transformedElement;
  }

  return args.observedElements.find((element) => element.snapshot?.tagName !== "textarea") ?? null;
}

export function recordSpectrumFrameTrace(event: string, payload: Record<string, unknown> = {}) {
  if (typeof window === "undefined" || !window.__spectrumFrameTraceInstalled) {
    return;
  }

  entries.push({
    event,
    isoTime: new Date().toISOString(),
    payload,
    performanceNow: window.performance.now(),
    seq: sequence,
  });
  sequence += 1;
  trimEntries();
}

export function recordSpectrumReactProfilerTrace(trace: SpectrumFrameReactProfilerTrace) {
  recordSpectrumFrameTrace("spectrum-react-profiler", trace);
}

export function captureSpectrumTitleFrames(
  label: string,
  args?: {
    frames?: number;
    payload?: Record<string, unknown>;
    sample?: () => Record<string, unknown>;
    titleNode?: HTMLElement | null;
  },
) {
  if (typeof window === "undefined" || !window.__spectrumFrameTraceInstalled) {
    return;
  }

  const frameCount = args?.frames ?? DEFAULT_TITLE_FRAME_COUNT;
  const nextToken = (activeTitleCaptureTokens.get(label) ?? 0) + 1;
  activeTitleCaptureTokens.set(label, nextToken);
  let frameIndex = 0;
  let previousFrameTime: number | null = null;
  let activeMotionNode: HTMLElement | null = null;
  let activeMotionPath: string | null = null;
  let previousMotion: SpectrumFrameTraceMotionPoint | null = null;
  const motionTrail: SpectrumFrameTraceMotionPoint[] = [];

  recordSpectrumFrameTrace("spectrum-title-capture-start", {
    frameCount,
    label,
    token: nextToken,
  });

  const sampleFrame = (frameTime: number) => {
    if (activeTitleCaptureTokens.get(label) !== nextToken) {
      return;
    }

    const titleNode = args?.titleNode ?? null;
    const canReuseActiveMotionNode = Boolean(
      titleNode && activeMotionNode?.isConnected && titleNode.contains(activeMotionNode),
    );
    let title: SpectrumFrameTraceElementSnapshot | null = null;
    let titleDescendants: SpectrumFrameTraceObservedElement[] = [];
    let titleMotion: SpectrumFrameTraceMotionPoint | null = null;

    if (canReuseActiveMotionNode && activeMotionNode && activeMotionPath) {
      titleMotion = createSpectrumFrameTraceMotionPointFromNode({
        frameIndex,
        frameTime,
        node: activeMotionNode,
        path: activeMotionPath,
        previousMotion,
      });
    } else {
      title = snapshotSpectrumFrameTraceElement(titleNode);
      titleDescendants = snapshotSpectrumFrameTraceDescendants(titleNode);
      const titleRoot: SpectrumFrameTraceObservedElement | null =
        titleNode && title
          ? {
              index: -1,
              node: titleNode,
              path: ":scope",
              snapshot: title,
            }
          : null;
      const observedElements = titleRoot ? [titleRoot, ...titleDescendants] : titleDescendants;
      const motionElement = resolveSpectrumFrameTraceMotionElement({
        activeMotionPath,
        observedElements,
      });
      if (motionElement) {
        activeMotionNode = motionElement.node;
        activeMotionPath = motionElement.path;
        titleMotion = createSpectrumFrameTraceMotionPoint({
          frameIndex,
          frameTime,
          observed: motionElement,
          previousMotion,
        });
      }
    }

    if (titleMotion) {
      motionTrail.push(titleMotion);
      if (motionTrail.length > TITLE_MOTION_TRAIL_LENGTH) {
        motionTrail.splice(0, motionTrail.length - TITLE_MOTION_TRAIL_LENGTH);
      }
    }

    const frameDelta = previousFrameTime === null ? null : frameTime - previousFrameTime;
    recordSpectrumFrameTrace("spectrum-title-frame", {
      frameDelta,
      frameIndex,
      frameTime,
      label,
      title: frameIndex === 0 ? title : null,
      titleDescendants:
        frameIndex === 0 ? serializeSpectrumFrameTraceObservedElements(titleDescendants) : [],
      titleMotion,
      titleMotionPath: activeMotionPath,
      token: nextToken,
      ...args?.payload,
      ...args?.sample?.(),
    });

    if (
      frameDelta !== null &&
      frameDelta >= TITLE_MOTION_GAP_THRESHOLD_MS &&
      previousMotion &&
      titleMotion
    ) {
      const gapTitle = title ?? snapshotSpectrumFrameTraceElement(titleNode);
      const gapTitleDescendants =
        titleDescendants.length > 0
          ? titleDescendants
          : snapshotSpectrumFrameTraceDescendants(titleNode);
      recordSpectrumFrameTrace("spectrum-title-motion-gap", {
        frameDelta,
        frameIndex,
        frameTime,
        label,
        previousMotion,
        title: gapTitle,
        titleDescendants: serializeSpectrumFrameTraceObservedElements(gapTitleDescendants),
        titleMotion,
        titleMotionPath: activeMotionPath,
        titleMotionTrail: motionTrail.slice(),
        token: nextToken,
        ...args?.sample?.(),
      });
    }

    previousFrameTime = frameTime;
    previousMotion = titleMotion;
    frameIndex += 1;
    if (frameIndex < frameCount) {
      window.requestAnimationFrame(sampleFrame);
    }
  };

  window.requestAnimationFrame(sampleFrame);
}

async function saveSpectrumFrameTrace() {
  if (typeof window === "undefined") {
    return null;
  }

  const path = await join(
    await downloadDir(),
    `spectrum-frame-trace.${new Date().toISOString().replace(/:/g, "-")}.${Date.now()}.jsonl`,
  );
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  await writeTextFile(path, contents);
  console.log(`[spectrumFrameTrace] saved ${path}`);
  return path;
}

function serializeSpectrumLongAnimationFrameScript(
  script: NonNullable<SpectrumLongAnimationFrameEntry["scripts"]>[number],
): SpectrumLongAnimationFrameScriptEntry {
  return {
    durationMs: script.duration ?? 0,
    forcedStyleAndLayoutDurationMs: script.forcedStyleAndLayoutDuration ?? null,
    invoker: script.invoker ?? null,
    invokerType: script.invokerType ?? null,
    pauseDurationMs: script.pauseDuration ?? null,
    sourceCharPosition: script.sourceCharPosition ?? null,
    sourceFunctionName: script.sourceFunctionName ?? null,
    sourceURL: script.sourceURL ?? null,
  };
}

function installSpectrumLongAnimationFrameObserver() {
  if (
    typeof window === "undefined" ||
    typeof PerformanceObserver === "undefined" ||
    longAnimationFrameObserver
  ) {
    return;
  }

  try {
    longAnimationFrameObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const frameEntry = entry as SpectrumLongAnimationFrameEntry;
        recordSpectrumFrameTrace("spectrum-long-animation-frame", {
          blockingDurationMs: frameEntry.blockingDuration ?? null,
          durationMs: frameEntry.duration,
          firstUIEventTimestamp: frameEntry.firstUIEventTimestamp ?? null,
          name: frameEntry.name,
          renderStart: frameEntry.renderStart ?? null,
          scripts:
            frameEntry.scripts
              ?.slice(0, 8)
              .map((script) => serializeSpectrumLongAnimationFrameScript(script)) ?? [],
          startTime: frameEntry.startTime,
          styleAndLayoutStart: frameEntry.styleAndLayoutStart ?? null,
        });
      }
    });
    longAnimationFrameObserver.observe({ entryTypes: ["long-animation-frame"] });
  } catch (error) {
    recordSpectrumFrameTrace("spectrum-long-animation-frame-observer-unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function installSpectrumLongTaskObserver() {
  if (
    typeof window === "undefined" ||
    typeof PerformanceObserver === "undefined" ||
    longTaskObserver
  ) {
    return;
  }

  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordSpectrumFrameTrace("spectrum-long-task", {
          durationMs: entry.duration,
          name: entry.name,
          startTime: entry.startTime,
        });
      }
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch (error) {
    recordSpectrumFrameTrace("spectrum-long-task-observer-unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function installSpectrumFrameTrace() {
  if (typeof window === "undefined" || window.__spectrumFrameTraceInstalled) {
    return;
  }

  const api: SpectrumFrameTraceApi = {
    captureTitleFrames: captureSpectrumTitleFrames,
    clear() {
      entries.length = 0;
      sequence = 0;
      recordSpectrumFrameTrace("trace-cleared");
    },
    entries() {
      return entries.slice();
    },
    record: recordSpectrumFrameTrace,
    save: saveSpectrumFrameTrace,
  };

  window.__spectrumFrameTraceInstalled = true;
  window.__spectrumFrameTraceApi = api;
  window.saveSpectrumFrameTrace = api.save;
  installSpectrumLongTaskObserver();
  installSpectrumLongAnimationFrameObserver();

  recordSpectrumFrameTrace("trace-installed", {
    href: window.location.href,
  });
}
