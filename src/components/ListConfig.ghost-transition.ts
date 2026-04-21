import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  captureListConfigGhostFrames,
  recordListConfigGhostTrace,
  snapshotListConfigGhostElement,
} from "@/src/debug/listConfigGhostTrace";

type ListConfigGhostTransition = {
  layoutId: string;
  cloneNode: HTMLDivElement;
  sourceNode: HTMLDivElement;
};

type GhostTransitionTraceNodes = {
  layoutId: string;
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

const LIST_CONFIG_GHOST_Z_INDEX = 180;

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

function createGhostClone(sourceNode: HTMLDivElement) {
  const sourceRect = sourceNode.getBoundingClientRect();
  const cloneNode = sourceNode.cloneNode(true) as HTMLDivElement;
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

  cloneNode.querySelectorAll<HTMLElement>("[data-tool-label-overlay='true']").forEach((node) => {
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
  cloneNode.style.transform = sourceStyle.transform;
  cloneNode.style.transformOrigin = sourceStyle.transformOrigin;
  cloneNode.style.opacity = sourceStyle.opacity;
  cloneNode.style.boxSizing = sourceStyle.boxSizing;
  cloneNode.style.whiteSpace = sourceStyle.whiteSpace;
  cloneNode.style.overflowWrap = sourceStyle.overflowWrap;
  cloneNode.style.wordBreak = sourceStyle.wordBreak;
  cloneNode.style.lineHeight = sourceStyle.lineHeight;
  cloneNode.dataset.listConfigGhostClone = "true";

  sourceNode.ownerDocument.body.appendChild(cloneNode);

  return cloneNode;
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
  cloneNode: HTMLDivElement;
  sourceNode: HTMLDivElement;
  resolveTargetNode: () => HTMLDivElement | null;
}) {
  captureListConfigGhostFrames(args.label, {
    frames: args.frames,
    sample: () =>
      createGhostTransitionTracePayload({
        layoutId: args.layoutId,
        sourceNode: args.sourceNode,
        cloneNode: args.cloneNode,
        targetNode: args.resolveTargetNode(),
      }),
  });
}

function createGhostAnimation(args: { cloneNode: HTMLDivElement; targetFrame: GhostFrame }) {
  return args.cloneNode.animate(
    [
      {
        left: args.cloneNode.style.left,
        top: args.cloneNode.style.top,
        width: args.cloneNode.style.width,
        height: args.cloneNode.style.height,
        transform: args.cloneNode.style.transform || "none",
      },
      {
        left: `${args.targetFrame.left}px`,
        top: `${args.targetFrame.top}px`,
        width: `${args.targetFrame.width}px`,
        height: `${args.targetFrame.height}px`,
        transform: "none",
      },
    ],
    {
      duration: 360,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "forwards",
    },
  );
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
  } as const;
  const targetFrame = resolveGhostFrame(targetNode.getBoundingClientRect());

  recordGhostTransitionTrace(
    "list-config:ghost-animation-start",
    {
      ...traceBase,
      targetNode,
    },
    {
      targetRect: targetFrame,
    },
  );
  hideGhostTarget(targetNode);

  let animation: Animation | null = null;
  let beforePaintFrame: number | null = null;
  let startAnimationFrame: number | null = null;
  const ownerWindow = ghostTransition.cloneNode.ownerDocument.defaultView;

  beforePaintFrame =
    ownerWindow?.requestAnimationFrame(() => {
      recordGhostTransitionTrace("list-config:ghost-before-paint", {
        ...traceBase,
        targetNode,
      });

      // Keep the ghost frozen at the source frame for one committed paint
      // before the timeline starts, otherwise the first visible frame can
      // already be part-way through the motion.
      animation = createGhostAnimation({
        cloneNode: ghostTransition.cloneNode,
        targetFrame,
      });
      animation.pause();
      animation.currentTime = 0;
      recordGhostTransitionTrace("list-config:ghost-animation-bound", {
        ...traceBase,
        targetNode,
      });

      animation.finished
        .catch(() => {})
        .finally(() => {
          recordGhostTransitionTrace("list-config:ghost-animation-finished", {
            ...traceBase,
            targetNode,
          });
          showGhostTarget(targetNode);
          ghostTransition.cloneNode.remove();
          args.onFinish();
        });

      startAnimationFrame =
        ownerWindow?.requestAnimationFrame(() => {
          recordGhostTransitionTrace("list-config:ghost-before-play", {
            ...traceBase,
            targetNode: args.resolveTargetNode(),
          });
          captureGhostTransitionFrames({
            label: "list-config:ghost-animation",
            frames: 24,
            ...traceBase,
            resolveTargetNode: args.resolveTargetNode,
          });
          animation?.play();
        }) ?? null;
    }) ?? null;

  return () => {
    if (beforePaintFrame !== null) {
      ownerWindow?.cancelAnimationFrame(beforePaintFrame);
    }
    if (startAnimationFrame !== null) {
      ownerWindow?.cancelAnimationFrame(startAnimationFrame);
    }
    animation?.cancel();
    recordGhostTransitionTrace("list-config:ghost-animation-cancelled", {
      ...traceBase,
      targetNode: args.resolveTargetNode() ?? targetNode,
    });
    showGhostTarget(targetNode);
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

      const cloneNode = createGhostClone(args.sourceNode);
      const traceBase = {
        layoutId: args.layoutId,
        sourceNode: args.sourceNode,
        cloneNode,
      } as const;

      recordGhostTransitionTrace("list-config:ghost-clone-created", {
        ...traceBase,
        targetNode: null,
      });
      ghostTransitionRef.current = {
        layoutId: args.layoutId,
        cloneNode,
        sourceNode: args.sourceNode,
      };
      recordGhostTransitionTrace("list-config:ghost-start", {
        ...traceBase,
        targetNode: targetRegistryRef.current.get(args.layoutId) ?? null,
      });
      captureGhostTransitionFrames({
        label: "list-config:ghost-pre-activation",
        frames: 12,
        ...traceBase,
        resolveTargetNode: () => targetRegistryRef.current.get(args.layoutId) ?? null,
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
