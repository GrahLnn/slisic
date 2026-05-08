import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { type GhostFrame } from "./ListConfig.ghost-geometry";
import {
  applyGhostPaintBox,
  applyGhostMotionState,
  createGhostClone,
  createGhostSurfaceTransition,
  hideGhostTarget,
  mergeGhostClipInsets,
  resolveGhostNodeClipInsets,
  resolveGhostNodePose,
  showGhostTarget,
} from "./ListConfig.ghost-dom";
import {
  createGhostMotionModel,
  GHOST_MOTION_DURATION,
  type GhostMotionSample,
} from "./ListConfig.ghost-motion";

type GhostNodeOwnerRegistry = Map<string, HTMLDivElement>;
type GhostNodeRegistry = Map<string, GhostNodeOwnerRegistry>;

type ListConfigGhostTransition = {
  layoutId: string;
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceAngle: number;
  sourceClipInsets: { bottom: number; left: number; right: number; top: number };
  sourceFrame: GhostFrame;
  sourceTransformOrigin: { x: number; y: number };
  targetOwnerId: string;
};

type GhostAnimationController = {
  cancel: () => void;
  finished: Promise<void>;
  play: () => void;
};

export function registerGhostNodeOwner(args: {
  registry: GhostNodeRegistry;
  layoutId: string;
  ownerId: string;
  node: HTMLDivElement | null;
}) {
  const ownerRegistry = args.registry.get(args.layoutId);

  if (!args.node) {
    if (!ownerRegistry?.has(args.ownerId)) {
      return false;
    }

    ownerRegistry.delete(args.ownerId);

    if (ownerRegistry.size === 0) {
      args.registry.delete(args.layoutId);
    }

    return true;
  }

  if (ownerRegistry?.get(args.ownerId) === args.node) {
    return false;
  }

  const nextOwnerRegistry = ownerRegistry ?? new Map<string, HTMLDivElement>();
  nextOwnerRegistry.set(args.ownerId, args.node);
  args.registry.set(args.layoutId, nextOwnerRegistry);

  return true;
}

export function resolveRegisteredGhostNode(args: {
  registry: GhostNodeRegistry;
  layoutId: string;
  ownerId: string;
}) {
  return args.registry.get(args.layoutId)?.get(args.ownerId) ?? null;
}

function createGhostAnimation(args: {
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  onSample?: (sample: GhostMotionSample) => void;
  sourceAngle: number;
  sourceFrame: GhostFrame;
  sourceTransformOrigin: { x: number; y: number };
  targetAngle: number;
  targetFrame: GhostFrame;
  targetTransformOrigin: { x: number; y: number };
}): GhostAnimationController {
  const ownerWindow = args.cloneNode.ownerDocument.defaultView;
  const motion = createGhostMotionModel({
    sourceAngle: args.sourceAngle,
    sourceFrame: args.sourceFrame,
    sourceTransformOrigin: args.sourceTransformOrigin,
    targetAngle: args.targetAngle,
    targetFrame: args.targetFrame,
    targetTransformOrigin: args.targetTransformOrigin,
  });
  const prefersReducedMotion =
    ownerWindow?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
  const duration = prefersReducedMotion ? 1 : GHOST_MOTION_DURATION;
  let frameId: number | null = null;
  let isRunning = false;
  let resolveFinished: (() => void) | null = null;
  let startTime = 0;
  let latestSample: GhostMotionSample = motion.sample(0);
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  applyGhostMotionState({
    cloneContentNode: args.cloneContentNode,
    cloneNode: args.cloneNode,
    sourceFrame: args.sourceFrame,
    state: latestSample.state,
  });
  args.onSample?.(latestSample);

  const complete = () => {
    if (frameId !== null) {
      ownerWindow?.cancelAnimationFrame(frameId);
      frameId = null;
    }

    isRunning = false;
    resolveFinished?.();
    resolveFinished = null;
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
    args.onSample?.(latestSample);

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
      // Cancellation is a normal lifecycle exit during remount / cleanup,
      // not an exceptional runtime failure that should surface as an
      // unhandled promise rejection in the console.
      resolveFinished?.();
      resolveFinished = null;
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
        args.onSample?.(latestSample);
        complete();
        return;
      }

      isRunning = true;
      startTime = ownerWindow.performance.now();
      frameId = ownerWindow.requestAnimationFrame(tick);
    },
  };
}

function scheduleGhostAnimationPlayback(args: {
  ghostTransition: ListConfigGhostTransition;
  targetNode: HTMLDivElement;
  onFinish: () => void;
}) {
  const { ghostTransition, targetNode } = args;
  const targetPose = resolveGhostNodePose(targetNode);
  applyGhostPaintBox({
    cloneContentNode: ghostTransition.cloneContentNode,
    cloneNode: ghostTransition.cloneNode,
    frame: ghostTransition.sourceFrame,
    insets: mergeGhostClipInsets(
      ghostTransition.sourceClipInsets,
      resolveGhostNodeClipInsets(targetNode, targetPose),
    ),
  });
  const surfaceTransition = createGhostSurfaceTransition({
    cloneContentNode: ghostTransition.cloneContentNode,
    targetNode,
  });
  const animation = createGhostAnimation({
    cloneContentNode: ghostTransition.cloneContentNode,
    cloneNode: ghostTransition.cloneNode,
    onSample(sample) {
      surfaceTransition?.setProgress(sample.state.progress);
    },
    sourceAngle: ghostTransition.sourceAngle,
    sourceFrame: ghostTransition.sourceFrame,
    sourceTransformOrigin: ghostTransition.sourceTransformOrigin,
    targetAngle: targetPose.angle,
    targetFrame: targetPose.frame,
    targetTransformOrigin: targetPose.transformOrigin,
  });
  if (!surfaceTransition) {
    hideGhostTarget(targetNode);
  }

  let beforePaintFrame: number | null = null;
  let cleanupFrame: number | null = null;
  let startAnimationFrame: number | null = null;
  let isCancelled = false;
  let isCompleted = false;
  const ownerWindow = ghostTransition.cloneNode.ownerDocument.defaultView;
  const revealTarget = () => {
    // The ghost surface has already handed off to the target renderer during
    // flight, so the terminal swap is now only a visibility handoff.
    surfaceTransition?.releaseTarget();
    if (!surfaceTransition) {
      showGhostTarget(targetNode);
    }
    ghostTransition.cloneNode.remove();
    isCompleted = true;
    args.onFinish();
  };

  beforePaintFrame =
    ownerWindow?.requestAnimationFrame(() => {
      animation.finished.finally(() => {
        if (isCancelled) {
          return;
        }

        if (!ownerWindow) {
          revealTarget();
          return;
        }

        // Let the exact terminal pose paint once before swapping visibility;
        // the ghost already carries the target surface by this point.
        cleanupFrame = ownerWindow.requestAnimationFrame(() => {
          if (isCancelled) {
            return;
          }

          revealTarget();
        });
      });

      startAnimationFrame =
        ownerWindow?.requestAnimationFrame(() => {
          animation.play();
        }) ?? null;
    }) ?? null;

  return () => {
    if (isCompleted) {
      return;
    }

    isCancelled = true;

    if (beforePaintFrame !== null) {
      ownerWindow?.cancelAnimationFrame(beforePaintFrame);
    }
    if (cleanupFrame !== null) {
      ownerWindow?.cancelAnimationFrame(cleanupFrame);
    }
    if (startAnimationFrame !== null) {
      ownerWindow?.cancelAnimationFrame(startAnimationFrame);
    }
    animation.cancel();
    surfaceTransition?.releaseTarget();
    if (!surfaceTransition) {
      showGhostTarget(targetNode);
    }
    ghostTransition.cloneNode.remove();
  };
}

export function useListConfigGhostTransition() {
  const [activeTransition, setActiveTransition] = useState<{
    layoutId: string;
    targetOwnerId: string;
  } | null>(null);
  const [dismissHoverSignal, setDismissHoverSignal] = useState(0);
  const ghostTransitionRef = useRef<ListConfigGhostTransition | null>(null);
  const ghostNodeRegistryRef = useRef<GhostNodeRegistry>(new Map());
  const ghostPlaybackCleanupRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef(true);
  const isGhostPlaybackAttemptQueuedRef = useRef(false);

  useLayoutEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      ghostPlaybackCleanupRef.current?.();
      ghostPlaybackCleanupRef.current = null;
      ghostTransitionRef.current?.cloneNode.remove();
      ghostTransitionRef.current = null;
    };
  }, []);

  const attemptGhostPlayback = useCallback(() => {
    if (ghostPlaybackCleanupRef.current) {
      return;
    }

    const ghostTransition = ghostTransitionRef.current;

    if (!ghostTransition) {
      return;
    }

    const targetNode = resolveRegisteredGhostNode({
      registry: ghostNodeRegistryRef.current,
      layoutId: ghostTransition.layoutId,
      ownerId: ghostTransition.targetOwnerId,
    });

    if (!targetNode) {
      return;
    }

    const playbackCleanup = scheduleGhostAnimationPlayback({
      ghostTransition,
      targetNode,
      onFinish: () => {
        if (ghostPlaybackCleanupRef.current === playbackCleanup) {
          ghostPlaybackCleanupRef.current = null;
        }

        if (ghostTransitionRef.current?.layoutId === ghostTransition.layoutId) {
          ghostTransitionRef.current = null;
        }

        setActiveTransition((current) =>
          current?.layoutId === ghostTransition.layoutId &&
          current.targetOwnerId === ghostTransition.targetOwnerId
            ? null
            : current,
        );
      },
    });
    ghostPlaybackCleanupRef.current = playbackCleanup;
  }, []);

  const scheduleGhostPlaybackAttempt = useCallback(() => {
    if (isGhostPlaybackAttemptQueuedRef.current) {
      return;
    }

    isGhostPlaybackAttemptQueuedRef.current = true;
    queueMicrotask(() => {
      isGhostPlaybackAttemptQueuedRef.current = false;

      if (!isMountedRef.current) {
        return;
      }

      attemptGhostPlayback();
    });
  }, [attemptGhostPlayback]);

  const registerGhostNode = useCallback(
    (layoutId: string, ownerId: string, node: HTMLDivElement | null) => {
      const didChange = registerGhostNodeOwner({
        registry: ghostNodeRegistryRef.current,
        layoutId,
        ownerId,
        node,
      });

      if (didChange) {
        scheduleGhostPlaybackAttempt();
      }
    },
    [scheduleGhostPlaybackAttempt],
  );

  const startGhostTransition = useCallback(
    (args: { layoutId: string; sourceNode: HTMLDivElement | null; targetOwnerId: string }) => {
      ghostPlaybackCleanupRef.current?.();
      ghostPlaybackCleanupRef.current = null;
      ghostTransitionRef.current?.cloneNode.remove();
      ghostTransitionRef.current = null;

      if (!args.sourceNode) {
        return;
      }

      const {
        cloneContentNode,
        cloneNode,
        sourceAngle,
        sourceClipInsets,
        sourceFrame,
        sourceTransformOrigin,
      } = createGhostClone(args.sourceNode);
      ghostTransitionRef.current = {
        layoutId: args.layoutId,
        cloneContentNode,
        cloneNode,
        sourceAngle,
        sourceClipInsets,
        sourceFrame,
        sourceTransformOrigin,
        targetOwnerId: args.targetOwnerId,
      };

      flushSync(() => {
        setDismissHoverSignal((current) => current + 1);
        setActiveTransition({
          layoutId: args.layoutId,
          targetOwnerId: args.targetOwnerId,
        });
      });
      scheduleGhostPlaybackAttempt();
    },
    [scheduleGhostPlaybackAttempt],
  );

  return {
    activeLayoutId: activeTransition?.layoutId ?? null,
    activeTargetOwnerId: activeTransition?.targetOwnerId ?? null,
    dismissHoverSignal,
    isAnimating: activeTransition !== null,
    registerGhostNode,
    startGhostTransition,
  };
}
