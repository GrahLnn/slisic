import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { recordListConfigGhostTrace } from "@/src/debug/listConfigGhostTrace";
import { type GhostFrame, resolveGhostFrame } from "./ListConfig.ghost-geometry";
import {
  applyGhostMotionState,
  createGhostClone,
  hideGhostTarget,
  showGhostTarget,
} from "./ListConfig.ghost-dom";
import {
  createGhostMotionModel,
  GHOST_MOTION_DURATION,
  type GhostMotionSample,
} from "./ListConfig.ghost-motion";
import {
  captureGhostTransitionFrames,
  recordGhostTransitionTrace,
} from "./ListConfig.ghost-trace";

type ListConfigGhostTransition = {
  layoutId: string;
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceAngle: number;
  sourceFrame: GhostFrame;
  sourceNode: HTMLDivElement;
};

type GhostAnimationController = {
  cancel: () => void;
  finished: Promise<void>;
  play: () => void;
  sample: () => Record<string, unknown>;
};

function createGhostAnimation(args: {
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceAngle: number;
  sourceFrame: GhostFrame;
  targetFrame: GhostFrame;
}): GhostAnimationController {
  const ownerWindow = args.cloneNode.ownerDocument.defaultView;
  const motion = createGhostMotionModel({
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
  let latestSample: GhostMotionSample = motion.sample(0);
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  applyGhostMotionState({
    cloneContentNode: args.cloneContentNode,
    cloneNode: args.cloneNode,
    sourceFrame: args.sourceFrame,
    state: latestSample.state,
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
      duration <= 1 ? 1 : Math.min(Math.max((frameTime - startTime) / duration, 0), 1);
    latestSample = motion.samplePlayback(rawProgress, prefersReducedMotion);
    applyGhostMotionState({
      cloneContentNode: args.cloneContentNode,
      cloneNode: args.cloneNode,
      sourceFrame: args.sourceFrame,
      state: latestSample.state,
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
        latestSample = motion.sample(1);
        applyGhostMotionState({
          cloneContentNode: args.cloneContentNode,
          cloneNode: args.cloneNode,
          sourceFrame: args.sourceFrame,
          state: latestSample.state,
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
        ghostMotion: latestSample,
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
