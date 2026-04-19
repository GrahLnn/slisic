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

type TitleShareTraceNodeSnapshot = {
  layoutId: string;
  role: string | null;
  text: string;
  opacity: string;
  transform: string;
  display: string;
  visibility: string;
  pointerEvents: string;
  connected: boolean;
  rect: TitleShareTraceRect;
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
const MAX_TRACE_ENTRIES = 4_000;

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

function snapshotNode(node: Element): TitleShareTraceNodeSnapshot | null {
  if (!(node instanceof HTMLElement || node instanceof SVGElement)) {
    return null;
  }

  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);

  return {
    layoutId: node.getAttribute("data-title-layout-id") ?? "",
    role: node.getAttribute("data-title-role"),
    text: (node.textContent ?? "").trim(),
    opacity: style.opacity,
    transform: style.transform,
    display: style.display,
    visibility: style.visibility,
    pointerEvents: style.pointerEvents,
    connected: node.isConnected,
    rect: toRect(rect),
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

  entries.push({
    seq: sequence,
    isoTime: new Date().toISOString(),
    performanceNow: performance.now(),
    event,
    payload,
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
    titleNodes: snapshotTitleShareNodes(),
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

  const sample = () => {
    recordTitleShareTrace("frame", {
      label,
      frameIndex,
      ...args?.payload,
      titleNodes: snapshotTitleShareNodes(),
    });

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

  recordTitleShareTrace("trace-installed", {
    href: window.location.href,
  });
}
