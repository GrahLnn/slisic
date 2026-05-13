import { recordRenderPerformanceTrace } from "./renderPerformanceTrace";

export type TitleHoverTraceVisual = "hold" | "none" | "retain";

export type TitleHoverTraceContext = {
  layoutId?: string;
  owner?: "list-config" | "playlist-page";
  surface: "editable-title" | "play-item";
  textLength: number;
  visual: TitleHoverTraceVisual;
};

export type TitleHoverTraceSnapshot = {
  animationName: string;
  className: string;
  fontVariationSettings: string;
  fontWeight: string;
  isConnected: boolean;
  isHovered: boolean;
  isParentHovered: boolean;
  letterSpacing: string;
  rect: {
    height: number;
    left: number;
    top: number;
    width: number;
  };
};

export type TitleHoverTraceFramePayload = TitleHoverTraceContext & {
  elapsedMs: number;
  frame: number;
  snapshot: TitleHoverTraceSnapshot | null;
};

const TITLE_HOVER_TRACE_WINDOW_MS = 720;

function roundTraceNumber(value: number) {
  return Math.round(value * 100) / 100;
}

export function readTitleHoverTraceSnapshot(
  node: HTMLElement | null,
): TitleHoverTraceSnapshot | null {
  if (!node) {
    return null;
  }

  const style = window.getComputedStyle(node);
  const rect = node.getBoundingClientRect();

  return {
    animationName: style.animationName,
    className: node.className,
    fontVariationSettings: style.fontVariationSettings,
    fontWeight: style.fontWeight,
    isConnected: node.isConnected,
    isHovered: node.matches(":hover"),
    isParentHovered: node.parentElement?.matches(":hover") ?? false,
    letterSpacing: style.letterSpacing,
    rect: {
      height: roundTraceNumber(rect.height),
      left: roundTraceNumber(rect.left),
      top: roundTraceNumber(rect.top),
      width: roundTraceNumber(rect.width),
    },
  };
}

export function shouldSampleTitleHoverTrace(visual: TitleHoverTraceVisual) {
  return visual === "hold" || visual === "retain";
}

export function shouldRecordTitleHoverTraceCommit(args: {
  current: TitleHoverTraceVisual;
  previous: TitleHoverTraceVisual;
}) {
  return shouldSampleTitleHoverTrace(args.current) || shouldSampleTitleHoverTrace(args.previous);
}

export function createTitleHoverTraceSignature(context: TitleHoverTraceContext) {
  return [
    context.owner ?? "",
    context.surface,
    context.layoutId ?? "",
    context.visual,
    context.textLength,
  ].join("|");
}

export function shouldRecordTitleHoverTraceObservation(args: {
  currentSignature: string;
  previousSignature: string | null;
}) {
  return args.currentSignature !== args.previousSignature;
}

export function createTitleHoverTraceFramePayload(args: {
  context: TitleHoverTraceContext;
  elapsedMs: number;
  frame: number;
  node: HTMLElement | null;
}): TitleHoverTraceFramePayload {
  return {
    ...args.context,
    elapsedMs: roundTraceNumber(args.elapsedMs),
    frame: args.frame,
    snapshot: readTitleHoverTraceSnapshot(args.node),
  };
}

export function recordTitleHoverTraceState(args: {
  context: TitleHoverTraceContext;
  event: string;
  node: HTMLElement | null;
}) {
  recordRenderPerformanceTrace(args.event, {
    ...args.context,
    snapshot: readTitleHoverTraceSnapshot(args.node),
  });
}

export function startTitleHoverTrace(args: {
  context: TitleHoverTraceContext;
  node: HTMLElement | null;
  ownerWindow: Window;
}) {
  const startedAt = args.ownerWindow.performance.now();
  let animationFrame: number | null = null;
  let frame = 0;
  let stopped = false;

  const stop = (reason: string) => {
    if (stopped) {
      return;
    }

    stopped = true;
    if (animationFrame !== null) {
      args.ownerWindow.cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }

    recordRenderPerformanceTrace("title-hover-trace-stop", {
      ...args.context,
      elapsedMs: roundTraceNumber(args.ownerWindow.performance.now() - startedAt),
      reason,
      snapshot: readTitleHoverTraceSnapshot(args.node),
    });
  };

  const sample = (frameTime: number) => {
    if (stopped) {
      return;
    }

    const elapsedMs = frameTime - startedAt;
    recordRenderPerformanceTrace(
      "title-hover-frame",
      createTitleHoverTraceFramePayload({
        context: args.context,
        elapsedMs,
        frame,
        node: args.node,
      }),
    );
    frame += 1;

    if (elapsedMs >= TITLE_HOVER_TRACE_WINDOW_MS) {
      stop("window-complete");
      return;
    }

    animationFrame = args.ownerWindow.requestAnimationFrame(sample);
  };

  recordTitleHoverTraceState({
    context: args.context,
    event: "title-hover-trace-start",
    node: args.node,
  });
  animationFrame = args.ownerWindow.requestAnimationFrame(sample);

  return {
    stop,
  };
}
