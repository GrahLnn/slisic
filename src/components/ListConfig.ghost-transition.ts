import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  captureListConfigGhostFrames,
  recordListConfigGhostTrace,
  snapshotListConfigGhostElement,
} from "@/src/debug/listConfigGhostTrace";

type ListConfigGhostTransition = {
  layoutId: string;
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceAngle: number;
  sourceFrame: GhostFrame;
  sourceNode: HTMLDivElement;
};

type GhostTransitionTraceNodes = {
  layoutId: string;
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceNode: HTMLDivElement;
  targetNode: HTMLDivElement | null;
};

type GhostFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type GhostPoint = {
  x: number;
  y: number;
};

type GhostMatrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

type GhostPath = {
  start: GhostPoint;
  control1: GhostPoint;
  control2: GhostPoint;
  end: GhostPoint;
};

type GhostMotionState = {
  angle: number;
  center: GhostPoint;
  followProgress: number;
  height: number;
  left: number;
  pathAngle: number;
  progress: number;
  rawPathAngle: number;
  scaleX: number;
  scaleY: number;
  settleProgress: number;
  settleTargetAngle: number;
  top: number;
  trackedAngle: number;
  width: number;
};

type GhostAnimationController = {
  cancel: () => void;
  finished: Promise<void>;
  play: () => void;
  sample: () => Record<string, unknown>;
};

const LIST_CONFIG_GHOST_Z_INDEX = 180;
const GHOST_MOTION_DURATION = 440;
const GHOST_ANGLE_HOLD_PROGRESS = 0.08;
const GHOST_ANGLE_SETTLE_PROGRESS = 0.82;

function hideGhostTarget(node: HTMLDivElement | null) {
  if (!node) {
    return;
  }

  node.style.opacity = "0";
}

function showGhostTarget(node: HTMLDivElement | null) {
  if (!node) {
    return;
  }

  node.style.opacity = "";
}

function parseGhostMatrix(transform: string): GhostMatrix {
  if (transform === "none") {
    return {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
    };
  }

  const match = transform.match(/matrix\(([^)]+)\)/);
  if (!match) {
    return {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
    };
  }

  const values = match[1].split(",").map((value) => Number.parseFloat(value.trim()));

  return {
    a: values[0] ?? 1,
    b: values[1] ?? 0,
    c: values[2] ?? 0,
    d: values[3] ?? 1,
    e: values[4] ?? 0,
    f: values[5] ?? 0,
  };
}

function parseGhostOrigin(transformOrigin: string): GhostPoint {
  const [originX = "0", originY = "0"] = transformOrigin.split(" ");

  return {
    x: Number.parseFloat(originX) || 0,
    y: Number.parseFloat(originY) || 0,
  };
}

function transformGhostPoint(
  point: GhostPoint,
  origin: GhostPoint,
  matrix: GhostMatrix,
): GhostPoint {
  const localX = point.x - origin.x;
  const localY = point.y - origin.y;

  return {
    x: matrix.a * localX + matrix.c * localY + matrix.e + origin.x,
    y: matrix.b * localX + matrix.d * localY + matrix.f + origin.y,
  };
}

function clampGhostValue(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function lerpGhostValue(from: number, to: number, progress: number) {
  return from + (to - from) * clampGhostValue(progress, 0, 1);
}

function easeOutGhostProgress(progress: number) {
  const clampedProgress = clampGhostValue(progress, 0, 1);

  return 1 - Math.pow(1 - clampedProgress, 5);
}

function normalizeGhostAngle(angle: number) {
  const normalizedAngle = ((((angle + 180) % 360) + 360) % 360) - 180;

  return normalizedAngle === -180 ? 180 : normalizedAngle;
}

function resolveGhostUnwrappedAngle(angle: number, referenceAngle: number) {
  return referenceAngle + normalizeGhostAngle(angle - referenceAngle);
}

function resolveGhostFrameCenter(frame: GhostFrame): GhostPoint {
  return {
    x: frame.left + frame.width / 2,
    y: frame.top + frame.height / 2,
  };
}

function resolveGhostPointDistance(from: GhostPoint, to: GhostPoint) {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function resolveGhostDirection(point: GhostPoint): GhostPoint {
  const magnitude = Math.hypot(point.x, point.y);

  if (magnitude <= 1e-6) {
    return { x: 1, y: 0 };
  }

  return {
    x: point.x / magnitude,
    y: point.y / magnitude,
  };
}

function resolveGhostDirectionFromAngle(angle: number): GhostPoint {
  const angleInRadians = (angle * Math.PI) / 180;

  return {
    x: Math.cos(angleInRadians),
    y: Math.sin(angleInRadians),
  };
}

function resolveGhostAngleFromPoint(point: GhostPoint) {
  return normalizeGhostAngle((Math.atan2(point.y, point.x) * 180) / Math.PI);
}

export function resolveGhostAngleFromTransform(transform: string) {
  const matrix = parseGhostMatrix(transform);

  return resolveGhostAngleFromPoint({ x: matrix.a, y: matrix.b });
}

function resolveGhostBezierPoint(path: GhostPath, progress: number): GhostPoint {
  const inverseProgress = 1 - progress;
  const a = inverseProgress * inverseProgress * inverseProgress;
  const b = 3 * inverseProgress * inverseProgress * progress;
  const c = 3 * inverseProgress * progress * progress;
  const d = progress * progress * progress;

  return {
    x: a * path.start.x + b * path.control1.x + c * path.control2.x + d * path.end.x,
    y: a * path.start.y + b * path.control1.y + c * path.control2.y + d * path.end.y,
  };
}

function resolveGhostBezierDerivative(path: GhostPath, progress: number): GhostPoint {
  const inverseProgress = 1 - progress;

  return {
    x:
      3 * inverseProgress * inverseProgress * (path.control1.x - path.start.x) +
      6 * inverseProgress * progress * (path.control2.x - path.control1.x) +
      3 * progress * progress * (path.end.x - path.control2.x),
    y:
      3 * inverseProgress * inverseProgress * (path.control1.y - path.start.y) +
      6 * inverseProgress * progress * (path.control2.y - path.control1.y) +
      3 * progress * progress * (path.end.y - path.control2.y),
  };
}

function resolveGhostPathAngleProgressSteps(progress: number) {
  return Math.max(1, Math.ceil(progress * 48));
}

export function resolveGhostContinuousPathAngle(args: {
  path: GhostPath;
  progress: number;
  sourceAngle: number;
}) {
  const progress = clampGhostValue(args.progress, 0, 1);

  if (progress === 0) {
    return args.sourceAngle;
  }

  const steps = resolveGhostPathAngleProgressSteps(progress);
  let continuousAngle = args.sourceAngle;

  for (let stepIndex = 1; stepIndex <= steps; stepIndex += 1) {
    const stepProgress = (progress * stepIndex) / steps;
    const rawAngle = resolveGhostAngleFromPoint(
      resolveGhostBezierDerivative(args.path, stepProgress),
    );

    continuousAngle = resolveGhostUnwrappedAngle(rawAngle, continuousAngle);
  }

  return continuousAngle;
}

export function resolveGhostCloneFrame(args: {
  sourceRect: GhostFrame;
  width: number;
  height: number;
  transform: string;
  transformOrigin: string;
}) {
  const matrix = parseGhostMatrix(args.transform);
  const origin = parseGhostOrigin(args.transformOrigin);
  const corners = [
    transformGhostPoint({ x: 0, y: 0 }, origin, matrix),
    transformGhostPoint({ x: args.width, y: 0 }, origin, matrix),
    transformGhostPoint({ x: args.width, y: args.height }, origin, matrix),
    transformGhostPoint({ x: 0, y: args.height }, origin, matrix),
  ];
  const minX = Math.min(...corners.map((corner) => corner.x));
  const minY = Math.min(...corners.map((corner) => corner.y));

  return {
    left: args.sourceRect.left - minX,
    top: args.sourceRect.top - minY,
    width: args.width,
    height: args.height,
  } as const;
}

export function resolveGhostMotionPath(args: {
  sourceAngle: number;
  sourceFrame: GhostFrame;
  targetFrame: GhostFrame;
}) {
  const start = resolveGhostFrameCenter(args.sourceFrame);
  const end = resolveGhostFrameCenter(args.targetFrame);
  const distance = resolveGhostPointDistance(start, end);
  const toTargetDirection = resolveGhostDirection({
    x: end.x - start.x,
    y: end.y - start.y,
  });
  const sourceDirection = resolveGhostDirectionFromAngle(args.sourceAngle);
  const exitDirection = sourceDirection;
  const entryDirection = resolveGhostDirection({
    x: toTargetDirection.x * 0.94 - sourceDirection.x * 0.06,
    y: toTargetDirection.y * 0.94 - sourceDirection.y * 0.06,
  });
  const exitDistance = clampGhostValue(distance * 0.28, 72, 220);
  const entryDistance = clampGhostValue(distance * 0.2, 56, 172);

  return {
    start,
    control1: {
      x: start.x + exitDirection.x * exitDistance,
      y: start.y + exitDirection.y * exitDistance,
    },
    control2: {
      x: end.x - entryDirection.x * entryDistance,
      y: end.y - entryDirection.y * entryDistance,
    },
    end,
  } satisfies GhostPath;
}

export function resolveGhostMotionState(args: {
  path: GhostPath;
  progress: number;
  sourceAngle: number;
  sourceFrame: GhostFrame;
  targetFrame: GhostFrame;
}) {
  const progress = clampGhostValue(args.progress, 0, 1);
  const width = lerpGhostValue(args.sourceFrame.width, args.targetFrame.width, progress);
  const height = lerpGhostValue(args.sourceFrame.height, args.targetFrame.height, progress);
  const center = resolveGhostBezierPoint(args.path, progress);
  const rawPathAngle = resolveGhostAngleFromPoint(
    resolveGhostBezierDerivative(args.path, progress),
  );
  const pathAngle = resolveGhostContinuousPathAngle({
    path: args.path,
    progress,
    sourceAngle: args.sourceAngle,
  });
  const followProgress = clampGhostValue(
    (progress - GHOST_ANGLE_HOLD_PROGRESS) /
      (GHOST_ANGLE_SETTLE_PROGRESS - GHOST_ANGLE_HOLD_PROGRESS),
    0,
    1,
  );
  const trackedAngle = lerpGhostValue(
    args.sourceAngle,
    pathAngle,
    easeOutGhostProgress(followProgress),
  );
  const settleProgress = clampGhostValue(
    (progress - GHOST_ANGLE_SETTLE_PROGRESS) / (1 - GHOST_ANGLE_SETTLE_PROGRESS),
    0,
    1,
  );
  const settleTargetAngle = resolveGhostUnwrappedAngle(0, trackedAngle);
  const angle = lerpGhostValue(
    trackedAngle,
    settleTargetAngle,
    easeOutGhostProgress(settleProgress),
  );

  return {
    angle,
    center,
    followProgress,
    height,
    left: center.x - width / 2,
    pathAngle,
    progress,
    rawPathAngle,
    scaleX: args.sourceFrame.width === 0 ? 1 : width / args.sourceFrame.width,
    scaleY: args.sourceFrame.height === 0 ? 1 : height / args.sourceFrame.height,
    settleProgress,
    settleTargetAngle,
    top: center.y - height / 2,
    trackedAngle,
    width,
  } satisfies GhostMotionState;
}

function createGhostClone(sourceNode: HTMLDivElement) {
  const sourceRect = sourceNode.getBoundingClientRect();
  const cloneContentNode = sourceNode.cloneNode(true) as HTMLDivElement;
  const cloneNode = sourceNode.ownerDocument.createElement("div");
  const sourceStyle = window.getComputedStyle(sourceNode);
  const resolvedWidth = Number.parseFloat(sourceStyle.width) || sourceNode.offsetWidth;
  const resolvedHeight = Number.parseFloat(sourceStyle.height) || sourceNode.offsetHeight;
  const sourceFrame = resolveGhostCloneFrame({
    sourceRect: {
      left: sourceRect.left,
      top: sourceRect.top,
      width: sourceRect.width,
      height: sourceRect.height,
    },
    width: resolvedWidth,
    height: resolvedHeight,
    transform: sourceStyle.transform,
    transformOrigin: sourceStyle.transformOrigin,
  });
  const sourceAngle = resolveGhostAngleFromTransform(sourceStyle.transform);

  cloneContentNode
    .querySelectorAll<HTMLElement>("[data-tool-label-overlay='true']")
    .forEach((node) => {
      node.remove();
    });

  cloneNode.style.position = "fixed";
  cloneNode.style.left = `${sourceFrame.left}px`;
  cloneNode.style.top = `${sourceFrame.top}px`;
  cloneNode.style.width = `${sourceFrame.width}px`;
  cloneNode.style.height = `${sourceFrame.height}px`;
  cloneNode.style.margin = "0";
  cloneNode.style.pointerEvents = "none";
  cloneNode.style.zIndex = `${LIST_CONFIG_GHOST_Z_INDEX}`;
  cloneNode.style.transformOrigin = "top left";
  cloneNode.style.willChange = "transform";
  cloneNode.style.opacity = sourceStyle.opacity;
  cloneNode.dataset.listConfigGhostClone = "true";

  cloneContentNode.style.width = "100%";
  cloneContentNode.style.height = "100%";
  cloneContentNode.style.margin = "0";
  cloneContentNode.style.boxSizing = sourceStyle.boxSizing;
  cloneContentNode.style.whiteSpace = sourceStyle.whiteSpace;
  cloneContentNode.style.overflowWrap = sourceStyle.overflowWrap;
  cloneContentNode.style.wordBreak = sourceStyle.wordBreak;
  cloneContentNode.style.lineHeight = sourceStyle.lineHeight;
  cloneContentNode.style.transformOrigin = sourceStyle.transformOrigin;
  cloneContentNode.style.transform = `rotate(${sourceAngle}deg)`;
  cloneContentNode.style.willChange = "transform";
  cloneContentNode.dataset.listConfigGhostCloneContent = "true";

  cloneNode.appendChild(cloneContentNode);
  sourceNode.ownerDocument.body.appendChild(cloneNode);

  return {
    cloneContentNode,
    cloneNode,
    sourceAngle,
    sourceFrame,
  } as const;
}

function resolveGhostFrame(
  rect: Pick<GhostFrame, "left" | "top" | "width" | "height">,
): GhostFrame {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function createGhostTransitionTracePayload(
  nodes: GhostTransitionTraceNodes,
): Record<string, unknown> {
  return {
    layoutId: nodes.layoutId,
    sourceNode: snapshotListConfigGhostElement(nodes.sourceNode),
    cloneNode: snapshotListConfigGhostElement(nodes.cloneNode),
    cloneContentNode: snapshotListConfigGhostElement(nodes.cloneContentNode),
    targetNode: snapshotListConfigGhostElement(nodes.targetNode),
  };
}

function recordGhostTransitionTrace(
  event: string,
  nodes: GhostTransitionTraceNodes,
  payload: Record<string, unknown> = {},
) {
  recordListConfigGhostTrace(event, {
    ...createGhostTransitionTracePayload(nodes),
    ...payload,
  });
}

function captureGhostTransitionFrames(args: {
  label: string;
  frames?: number;
  layoutId: string;
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceNode: HTMLDivElement;
  resolveTargetNode: () => HTMLDivElement | null;
  sampleMotion?: () => Record<string, unknown>;
}) {
  captureListConfigGhostFrames(args.label, {
    frames: args.frames,
    sample: () => ({
      ...createGhostTransitionTracePayload({
        layoutId: args.layoutId,
        sourceNode: args.sourceNode,
        cloneNode: args.cloneNode,
        cloneContentNode: args.cloneContentNode,
        targetNode: args.resolveTargetNode(),
      }),
      ...args.sampleMotion?.(),
    }),
  });
}

function applyGhostMotionState(args: {
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceFrame: GhostFrame;
  state: GhostMotionState;
}) {
  const translateX = args.state.left - args.sourceFrame.left;
  const translateY = args.state.top - args.sourceFrame.top;

  args.cloneNode.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${args.state.scaleX}, ${args.state.scaleY})`;
  args.cloneContentNode.style.transform = `rotate(${args.state.angle}deg)`;
}

function createGhostAnimation(args: {
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceAngle: number;
  sourceFrame: GhostFrame;
  targetFrame: GhostFrame;
}): GhostAnimationController {
  const ownerWindow = args.cloneNode.ownerDocument.defaultView;
  const path = resolveGhostMotionPath({
    sourceAngle: args.sourceAngle,
    sourceFrame: args.sourceFrame,
    targetFrame: args.targetFrame,
  });
  const prefersReducedMotion =
    ownerWindow?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
  const duration = prefersReducedMotion ? 1 : GHOST_MOTION_DURATION;
  let frameId: number | null = null;
  let isRunning = false;
  let resolveFinished: (() => void) | null = null;
  let rejectFinished: ((reason?: unknown) => void) | null = null;
  let startTime = 0;
  let latestState = resolveGhostMotionState({
    path,
    progress: 0,
    sourceAngle: args.sourceAngle,
    sourceFrame: args.sourceFrame,
    targetFrame: args.targetFrame,
  });
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  applyGhostMotionState({
    cloneContentNode: args.cloneContentNode,
    cloneNode: args.cloneNode,
    sourceFrame: args.sourceFrame,
    state: latestState,
  });

  const complete = () => {
    if (frameId !== null) {
      ownerWindow?.cancelAnimationFrame(frameId);
      frameId = null;
    }

    isRunning = false;
    resolveFinished?.();
    resolveFinished = null;
    rejectFinished = null;
  };

  const tick = (frameTime: number) => {
    if (!isRunning) {
      return;
    }

    const rawProgress =
      duration <= 1 ? 1 : clampGhostValue((frameTime - startTime) / duration, 0, 1);
    latestState = resolveGhostMotionState({
      path,
      progress: prefersReducedMotion ? rawProgress : easeOutGhostProgress(rawProgress),
      sourceAngle: args.sourceAngle,
      sourceFrame: args.sourceFrame,
      targetFrame: args.targetFrame,
    });
    applyGhostMotionState({
      cloneContentNode: args.cloneContentNode,
      cloneNode: args.cloneNode,
      sourceFrame: args.sourceFrame,
      state: latestState,
    });

    if (rawProgress >= 1) {
      complete();
      return;
    }

    frameId = ownerWindow?.requestAnimationFrame(tick) ?? null;
  };

  return {
    cancel() {
      if (frameId !== null) {
        ownerWindow?.cancelAnimationFrame(frameId);
        frameId = null;
      }

      isRunning = false;
      rejectFinished?.(new Error("Ghost animation cancelled"));
      resolveFinished = null;
      rejectFinished = null;
    },
    finished,
    play() {
      if (isRunning) {
        return;
      }

      if (!ownerWindow) {
        latestState = resolveGhostMotionState({
          path,
          progress: 1,
          sourceAngle: args.sourceAngle,
          sourceFrame: args.sourceFrame,
          targetFrame: args.targetFrame,
        });
        applyGhostMotionState({
          cloneContentNode: args.cloneContentNode,
          cloneNode: args.cloneNode,
          sourceFrame: args.sourceFrame,
          state: latestState,
        });
        complete();
        return;
      }

      isRunning = true;
      startTime = ownerWindow.performance.now();
      frameId = ownerWindow.requestAnimationFrame(tick);
    },
    sample() {
      return {
        ghostMotion: {
          path,
          state: latestState,
          derivative: resolveGhostBezierDerivative(path, latestState.progress),
        },
      };
    },
  };
}

function scheduleGhostAnimationPlayback(args: {
  ghostTransition: ListConfigGhostTransition;
  targetNode: HTMLDivElement;
  resolveTargetNode: () => HTMLDivElement | null;
  onFinish: () => void;
}) {
  const { ghostTransition, targetNode } = args;
  const traceBase = {
    layoutId: ghostTransition.layoutId,
    sourceNode: ghostTransition.sourceNode,
    cloneNode: ghostTransition.cloneNode,
    cloneContentNode: ghostTransition.cloneContentNode,
  } as const;
  const targetFrame = resolveGhostFrame(targetNode.getBoundingClientRect());
  const animation = createGhostAnimation({
    cloneContentNode: ghostTransition.cloneContentNode,
    cloneNode: ghostTransition.cloneNode,
    sourceAngle: ghostTransition.sourceAngle,
    sourceFrame: ghostTransition.sourceFrame,
    targetFrame,
  });

  recordGhostTransitionTrace(
    "list-config:ghost-animation-start",
    {
      ...traceBase,
      targetNode,
    },
    {
      sourceAngle: ghostTransition.sourceAngle,
      sourceFrame: ghostTransition.sourceFrame,
      targetRect: targetFrame,
      ...animation.sample(),
    },
  );
  hideGhostTarget(targetNode);

  let beforePaintFrame: number | null = null;
  let startAnimationFrame: number | null = null;
  let isCancelled = false;
  const ownerWindow = ghostTransition.cloneNode.ownerDocument.defaultView;

  beforePaintFrame =
    ownerWindow?.requestAnimationFrame(() => {
      recordGhostTransitionTrace(
        "list-config:ghost-before-paint",
        {
          ...traceBase,
          targetNode,
        },
        animation.sample(),
      );
      recordGhostTransitionTrace(
        "list-config:ghost-animation-bound",
        {
          ...traceBase,
          targetNode,
        },
        animation.sample(),
      );

      animation.finished
        .catch(() => {})
        .finally(() => {
          if (isCancelled) {
            return;
          }

          recordGhostTransitionTrace(
            "list-config:ghost-animation-finished",
            {
              ...traceBase,
              targetNode,
            },
            animation.sample(),
          );
          showGhostTarget(targetNode);
          ghostTransition.cloneNode.remove();
          args.onFinish();
        });

      startAnimationFrame =
        ownerWindow?.requestAnimationFrame(() => {
          recordGhostTransitionTrace(
            "list-config:ghost-before-play",
            {
              ...traceBase,
              targetNode: args.resolveTargetNode(),
            },
            animation.sample(),
          );
          captureGhostTransitionFrames({
            label: "list-config:ghost-animation",
            frames: 48,
            ...traceBase,
            resolveTargetNode: args.resolveTargetNode,
            sampleMotion: animation.sample,
          });
          animation.play();
        }) ?? null;
    }) ?? null;

  return () => {
    isCancelled = true;

    if (beforePaintFrame !== null) {
      ownerWindow?.cancelAnimationFrame(beforePaintFrame);
    }
    if (startAnimationFrame !== null) {
      ownerWindow?.cancelAnimationFrame(startAnimationFrame);
    }
    animation.cancel();
    recordGhostTransitionTrace(
      "list-config:ghost-animation-cancelled",
      {
        ...traceBase,
        targetNode: args.resolveTargetNode() ?? targetNode,
      },
      animation.sample(),
    );
    showGhostTarget(targetNode);
    ghostTransition.cloneNode.remove();
  };
}

export function useListConfigGhostTransition(targetIdsKey: string) {
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null);
  const [dismissHoverSignal, setDismissHoverSignal] = useState(0);
  const ghostTransitionRef = useRef<ListConfigGhostTransition | null>(null);
  const targetRegistryRef = useRef<Map<string, HTMLDivElement>>(new Map());

  useLayoutEffect(() => {
    const ghostTransition = ghostTransitionRef.current;

    if (!activeLayoutId || !ghostTransition) {
      return;
    }

    const targetNode = targetRegistryRef.current.get(activeLayoutId);

    if (!targetNode) {
      recordGhostTransitionTrace("list-config:ghost-target-missing", {
        layoutId: activeLayoutId,
        sourceNode: ghostTransition.sourceNode,
        cloneNode: ghostTransition.cloneNode,
        cloneContentNode: ghostTransition.cloneContentNode,
        targetNode: null,
      });
      return;
    }

    return scheduleGhostAnimationPlayback({
      ghostTransition,
      targetNode,
      resolveTargetNode: () => targetRegistryRef.current.get(activeLayoutId) ?? null,
      onFinish: () => {
        if (ghostTransitionRef.current?.layoutId === ghostTransition.layoutId) {
          ghostTransitionRef.current = null;
        }

        setActiveLayoutId((current) => (current === ghostTransition.layoutId ? null : current));
      },
    });
  }, [activeLayoutId, targetIdsKey]);

  const registerTargetNode = useCallback((layoutId: string, node: HTMLDivElement | null) => {
    const registry = targetRegistryRef.current;

    if (!node) {
      registry.delete(layoutId);
      return;
    }

    registry.set(layoutId, node);
  }, []);

  const startGhostTransition = useCallback(
    (args: { layoutId: string; sourceNode: HTMLDivElement | null }) => {
      ghostTransitionRef.current?.cloneNode.remove();
      ghostTransitionRef.current = null;

      if (!args.sourceNode) {
        recordListConfigGhostTrace("list-config:ghost-start-missing-source", {
          layoutId: args.layoutId,
        });
        return;
      }

      const { cloneContentNode, cloneNode, sourceAngle, sourceFrame } = createGhostClone(
        args.sourceNode,
      );
      const traceBase = {
        layoutId: args.layoutId,
        sourceNode: args.sourceNode,
        cloneNode,
        cloneContentNode,
      } as const;

      recordGhostTransitionTrace(
        "list-config:ghost-clone-created",
        {
          ...traceBase,
          targetNode: null,
        },
        {
          sourceAngle,
          sourceFrame,
        },
      );
      ghostTransitionRef.current = {
        layoutId: args.layoutId,
        cloneContentNode,
        cloneNode,
        sourceAngle,
        sourceFrame,
        sourceNode: args.sourceNode,
      };
      recordGhostTransitionTrace("list-config:ghost-start", {
        ...traceBase,
        targetNode: targetRegistryRef.current.get(args.layoutId) ?? null,
      });

      flushSync(() => {
        setDismissHoverSignal((current) => current + 1);
        setActiveLayoutId(args.layoutId);
      });
      recordGhostTransitionTrace("list-config:ghost-after-flush", {
        ...traceBase,
        targetNode: targetRegistryRef.current.get(args.layoutId) ?? null,
      });
    },
    [],
  );

  return {
    activeLayoutId,
    dismissHoverSignal,
    isAnimating: activeLayoutId !== null,
    registerTargetNode,
    startGhostTransition,
  };
}
