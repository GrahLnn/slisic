import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  type GhostTraceRect,
  recordListConfigGhostTrace,
  snapshotListConfigGhostElement,
} from "@/src/debug/listConfigGhostTrace";
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
import {
  captureGhostTransitionFrames,
  recordGhostTransitionTrace,
} from "./ListConfig.ghost-trace";

type GhostNodeOwnerRegistry = Map<string, HTMLDivElement>;
type GhostNodeRegistry = Map<string, GhostNodeOwnerRegistry>;

type ListConfigGhostTransition = {
  layoutId: string;
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceAngle: number;
  sourceClipInsets: { bottom: number; left: number; right: number; top: number };
  sourceFrame: GhostFrame;
  sourceNode: HTMLDivElement;
  sourceTransformOrigin: { x: number; y: number };
  targetOwnerId: string;
};

type GhostAnimationController = {
  cancel: () => void;
  finished: Promise<void>;
  play: () => void;
  sample: () => Record<string, unknown>;
};

type GhostTraceCenter = {
  x: number;
  y: number;
  deviceX: number | null;
  deviceY: number | null;
};

type GhostTraceCenterDelta = {
  dx: number;
  dy: number;
  distance: number;
  deviceDx: number | null;
  deviceDy: number | null;
  deviceDistance: number | null;
};

type GhostRenderedTextProbe = {
  elementCenter: GhostTraceCenter | null;
  opacity: string | null;
  renderMode: string | null;
  selection: string | null;
  surfaceRole: string | null;
  textCenter: GhostTraceCenter | null;
  visibleCenter: GhostTraceCenter | null;
  visibleCenterSource: string | null;
};

const GHOST_SURFACE_LAYER_ATTRIBUTE = "data-list-config-ghost-surface-role";

function resolveGhostTraceCenterDeviceValue(value: number, devicePixelRatio: number | null) {
  if (!Number.isFinite(value) || !devicePixelRatio || !Number.isFinite(devicePixelRatio)) {
    return null;
  }

  return Math.round(value * devicePixelRatio);
}

function resolveGhostTraceCenter(args: {
  devicePixelRatio: number | null;
  x: number;
  y: number;
}): GhostTraceCenter {
  return {
    x: args.x,
    y: args.y,
    deviceX: resolveGhostTraceCenterDeviceValue(args.x, args.devicePixelRatio),
    deviceY: resolveGhostTraceCenterDeviceValue(args.y, args.devicePixelRatio),
  };
}

function resolveGhostTraceRectCenter(
  rect: Pick<GhostTraceRect, "height" | "left" | "top" | "width"> | null,
  devicePixelRatio: number | null,
) {
  if (!rect) {
    return null;
  }

  return resolveGhostTraceCenter({
    devicePixelRatio,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  });
}

function resolveGhostTraceCenterDelta(
  from: GhostTraceCenter | null,
  to: GhostTraceCenter | null,
): GhostTraceCenterDelta | null {
  if (!from || !to) {
    return null;
  }

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const hasDeviceDelta =
    from.deviceX !== null && from.deviceY !== null && to.deviceX !== null && to.deviceY !== null;
  const deviceDx = hasDeviceDelta ? to.deviceX! - from.deviceX! : null;
  const deviceDy = hasDeviceDelta ? to.deviceY! - from.deviceY! : null;

  return {
    dx,
    dy,
    distance: Math.hypot(dx, dy),
    deviceDx,
    deviceDy,
    deviceDistance:
      deviceDx !== null && deviceDy !== null ? Math.hypot(deviceDx, deviceDy) : null,
  };
}

function resolveGhostSurfaceLayerNode(node: ParentNode, role: "source" | "target") {
  if (
    node instanceof HTMLDivElement &&
    node.dataset.listConfigGhostSurfaceRole === role
  ) {
    return node;
  }

  return (
    node.querySelector(`[${GHOST_SURFACE_LAYER_ATTRIBUTE}='${role}']`) ?? null
  ) as HTMLDivElement | null;
}

function resolveGhostRenderedTextProbe(args: {
  devicePixelRatio: number | null;
  snapshot: ReturnType<typeof snapshotListConfigGhostElement>;
  surfaceRole: string | null;
}): GhostRenderedTextProbe {
  const { snapshot } = args;

  if (!snapshot) {
    return {
      elementCenter: null,
      opacity: null,
      renderMode: null,
      selection: null,
      surfaceRole: args.surfaceRole,
      textCenter: null,
      visibleCenter: null,
      visibleCenterSource: null,
    };
  }

  const renderMode =
    snapshot.toolLabelTextContainer?.dataAttributes["data-tool-label-debug-text-render-mode"] ?? null;

  if (snapshot.toolLabelTextSurface) {
    return {
      elementCenter: resolveGhostTraceRectCenter(
        snapshot.toolLabelTextSurface.rect,
        args.devicePixelRatio,
      ),
      opacity: snapshot.toolLabelTextSurface.opacity,
      renderMode,
      selection: "toolLabelTextSurface",
      surfaceRole: args.surfaceRole,
      textCenter: resolveGhostTraceRectCenter(
        snapshot.toolLabelTextSurface.textVisibleRect,
        args.devicePixelRatio,
      ),
      visibleCenter: resolveGhostTraceRectCenter(
        snapshot.toolLabelTextSurface.textVisibleRect ?? snapshot.toolLabelTextSurface.rect,
        args.devicePixelRatio,
      ),
      visibleCenterSource: snapshot.toolLabelTextSurface.textVisibleRect
        ? `toolLabelTextSurface:${snapshot.toolLabelTextSurface.textVisibleRectSource ?? "text-visible-rect"}`
        : "toolLabelTextSurface:rect",
    };
  }

  if (snapshot.torphVisibleLayerRole === "overlay") {
    return {
      elementCenter: resolveGhostTraceRectCenter(
        snapshot.torphOverlay?.rect ?? null,
        args.devicePixelRatio,
      ),
      opacity: snapshot.torphOverlay?.opacity ?? null,
      renderMode: renderMode ?? "torph",
      selection: "torphOverlay",
      surfaceRole: args.surfaceRole,
      textCenter: resolveGhostTraceRectCenter(
        snapshot.torphOverlay?.textVisibleRect ?? null,
        args.devicePixelRatio,
      ),
      visibleCenter: resolveGhostTraceRectCenter(
        snapshot.torphOverlayLiveGlyphRect ??
          snapshot.torphOverlay?.textVisibleRect ??
          snapshot.torphOverlay?.rect ??
          null,
        args.devicePixelRatio,
      ),
      visibleCenterSource: snapshot.torphOverlayLiveGlyphRect
        ? "torphOverlay:liveGlyphRect"
        : snapshot.torphOverlay?.textVisibleRect
          ? `torphOverlay:${snapshot.torphOverlay.textVisibleRectSource ?? "text-visible-rect"}`
          : snapshot.torphOverlay
            ? "torphOverlay:rect"
            : null,
    };
  }

  const torphTextNode =
    snapshot.torphVisibleLayerRole === "flow"
      ? snapshot.torphFlow
      : snapshot.torphVisibleLayerRole === "flow-shell"
        ? snapshot.torphFlowShell
        : null;

  if (torphTextNode) {
    return {
      elementCenter: resolveGhostTraceRectCenter(torphTextNode.rect, args.devicePixelRatio),
      opacity: torphTextNode.opacity,
      renderMode: renderMode ?? "torph",
      selection:
        snapshot.torphVisibleLayerRole === "flow" ? "torphFlow" : "torphFlowShell",
      surfaceRole: args.surfaceRole,
      textCenter: resolveGhostTraceRectCenter(torphTextNode.textVisibleRect, args.devicePixelRatio),
      visibleCenter: resolveGhostTraceRectCenter(
        torphTextNode.textVisibleRect ?? torphTextNode.rect,
        args.devicePixelRatio,
      ),
      visibleCenterSource: torphTextNode.textVisibleRect
        ? `${snapshot.torphVisibleLayerRole}:${torphTextNode.textVisibleRectSource ?? "text-visible-rect"}`
        : snapshot.torphVisibleLayerRole,
    };
  }

  if (snapshot.toolLabelTextContainer) {
    return {
      elementCenter: resolveGhostTraceRectCenter(
        snapshot.toolLabelTextContainer.rect,
        args.devicePixelRatio,
      ),
      opacity: snapshot.toolLabelTextContainer.opacity,
      renderMode,
      selection: "toolLabelTextContainer",
      surfaceRole: args.surfaceRole,
      textCenter: resolveGhostTraceRectCenter(
        snapshot.toolLabelTextContainer.textVisibleRect,
        args.devicePixelRatio,
      ),
      visibleCenter: resolveGhostTraceRectCenter(
        snapshot.toolLabelTextContainer.textVisibleRect ?? snapshot.toolLabelTextContainer.rect,
        args.devicePixelRatio,
      ),
      visibleCenterSource: snapshot.toolLabelTextContainer.textVisibleRect
        ? `toolLabelTextContainer:${snapshot.toolLabelTextContainer.textVisibleRectSource ?? "text-visible-rect"}`
        : "toolLabelTextContainer:rect",
    };
  }

  return {
    elementCenter: resolveGhostTraceRectCenter(snapshot.rect, args.devicePixelRatio),
    opacity: snapshot.opacity,
    renderMode,
    selection: "snapshotRoot",
    surfaceRole: args.surfaceRole,
    textCenter: resolveGhostTraceRectCenter(snapshot.textVisibleRect, args.devicePixelRatio),
    visibleCenter: resolveGhostTraceRectCenter(
      snapshot.textVisibleRect ?? snapshot.rect,
      args.devicePixelRatio,
    ),
    visibleCenterSource: snapshot.textVisibleRect
      ? `snapshotRoot:${snapshot.textVisibleRectSource ?? "text-visible-rect"}`
      : "snapshotRoot:rect",
  };
}

function resolveGhostTerminalAlignmentProbe(args: {
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  ghostMotion: GhostMotionSample;
  phase: string;
  resolvedTargetNode: HTMLDivElement | null;
  targetNode: HTMLDivElement;
  targetPose: ReturnType<typeof resolveGhostNodePose>;
}) {
  const cloneNodeSnapshot = snapshotListConfigGhostElement(args.cloneNode);
  const cloneContentSnapshot = snapshotListConfigGhostElement(args.cloneContentNode);
  const cloneSourceSurfaceSnapshot = snapshotListConfigGhostElement(
    resolveGhostSurfaceLayerNode(args.cloneContentNode, "source"),
  );
  const cloneTargetSurfaceSnapshot = snapshotListConfigGhostElement(
    resolveGhostSurfaceLayerNode(args.cloneContentNode, "target"),
  );
  const liveTargetNode = args.resolvedTargetNode ?? args.targetNode;
  const targetSnapshot = snapshotListConfigGhostElement(liveTargetNode);
  const liveTargetPose = liveTargetNode ? resolveGhostNodePose(liveTargetNode) : null;
  const devicePixelRatio =
    targetSnapshot?.devicePixelRatio ??
    cloneContentSnapshot?.devicePixelRatio ??
    cloneNodeSnapshot?.devicePixelRatio ??
    liveTargetNode.ownerDocument.defaultView?.devicePixelRatio ??
    null;
  const plannedTargetFrameCenter = resolveGhostTraceRectCenter(args.targetPose.frame, devicePixelRatio);
  const liveTargetPoseCenter = resolveGhostTraceRectCenter(
    liveTargetPose?.frame ?? null,
    devicePixelRatio,
  );
  const ghostMotionCenter = resolveGhostTraceCenter({
    devicePixelRatio,
    x: args.ghostMotion.state.center.x,
    y: args.ghostMotion.state.center.y,
  });
  const clonePaintCenter = resolveGhostTraceRectCenter(cloneNodeSnapshot?.rect ?? null, devicePixelRatio);
  const cloneContentRectCenter = resolveGhostTraceRectCenter(
    cloneContentSnapshot?.rect ?? null,
    devicePixelRatio,
  );
  const cloneContentTextCenter = resolveGhostTraceRectCenter(
    cloneContentSnapshot?.textVisibleRect ?? null,
    devicePixelRatio,
  );
  const targetVisualCenter = resolveGhostTraceRectCenter(targetSnapshot?.rect ?? null, devicePixelRatio);
  const targetTextCenter = resolveGhostTraceRectCenter(
    targetSnapshot?.textVisibleRect ?? null,
    devicePixelRatio,
  );
  const cloneSourceRenderedText = resolveGhostRenderedTextProbe({
    devicePixelRatio,
    snapshot: cloneSourceSurfaceSnapshot,
    surfaceRole: "source",
  });
  const cloneTargetRenderedText = resolveGhostRenderedTextProbe({
    devicePixelRatio,
    snapshot: cloneTargetSurfaceSnapshot,
    surfaceRole: "target",
  });
  const cloneActiveRenderedText =
    cloneTargetSurfaceSnapshot
      ? cloneTargetRenderedText
      : resolveGhostRenderedTextProbe({
          devicePixelRatio,
          snapshot: cloneContentSnapshot,
          surfaceRole: "clone-content",
        });
  const liveTargetRenderedText = resolveGhostRenderedTextProbe({
    devicePixelRatio,
    snapshot: targetSnapshot,
    surfaceRole: "live-target",
  });

  return {
    phase: args.phase,
    devicePixelRatio,
    targetNodeChanged: liveTargetNode !== args.targetNode,
    targetNodeConnected: liveTargetNode.isConnected,
    cloneNodeConnected: args.cloneNode.isConnected,
    cloneContentNodeConnected: args.cloneContentNode.isConnected,
    plannedTargetFrameCenter,
    liveTargetPoseCenter,
    ghostMotionCenter,
    clonePaintCenter,
    cloneContentRectCenter,
    cloneContentTextCenter,
    targetVisualCenter,
    targetTextCenter,
    cloneSourceRenderedText,
    cloneTargetRenderedText,
    cloneActiveRenderedText,
    liveTargetRenderedText,
    deltas: {
      motionToPlannedTarget: resolveGhostTraceCenterDelta(
        ghostMotionCenter,
        plannedTargetFrameCenter,
      ),
      motionToLiveTargetPose: resolveGhostTraceCenterDelta(ghostMotionCenter, liveTargetPoseCenter),
      clonePaintToLiveTargetPose: resolveGhostTraceCenterDelta(
        clonePaintCenter,
        liveTargetPoseCenter,
      ),
      cloneContentRectToTargetVisual: resolveGhostTraceCenterDelta(
        cloneContentRectCenter,
        targetVisualCenter,
      ),
      cloneContentTextToTargetText: resolveGhostTraceCenterDelta(
        cloneContentTextCenter,
        targetTextCenter,
      ),
      cloneRenderedElementToLiveTargetElement: resolveGhostTraceCenterDelta(
        cloneActiveRenderedText.elementCenter,
        liveTargetRenderedText.elementCenter,
      ),
      cloneRenderedTextToLiveTargetText: resolveGhostTraceCenterDelta(
        cloneActiveRenderedText.textCenter,
        liveTargetRenderedText.textCenter,
      ),
      cloneRenderedVisibleToLiveTargetVisible: resolveGhostTraceCenterDelta(
        cloneActiveRenderedText.visibleCenter,
        liveTargetRenderedText.visibleCenter,
      ),
    },
  };
}

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
  const resolveTraceBase = () =>
    ({
      layoutId: ghostTransition.layoutId,
      sourceNode: ghostTransition.sourceNode,
      cloneNode: ghostTransition.cloneNode,
      cloneContentNode: ghostTransition.cloneContentNode,
    }) as const;
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
  const samplePlaybackState = () => ({
    ...animation.sample(),
    ghostSurface:
      surfaceTransition?.sample() ?? {
        hasTargetSurface: false,
        liveTargetOpacity: null,
        progress: 0,
        sourceOpacity: null,
        targetOpacity: null,
      },
  });
  const resolveCurrentGhostMotion = () =>
    (animation.sample() as { ghostMotion: GhostMotionSample }).ghostMotion;
  const resolveTerminalAlignmentTrace = (phase: string) => ({
    terminalAlignment: resolveGhostTerminalAlignmentProbe({
      phase,
      cloneContentNode: ghostTransition.cloneContentNode,
      cloneNode: ghostTransition.cloneNode,
      ghostMotion: resolveCurrentGhostMotion(),
      resolvedTargetNode: resolveTraceTargetNode(),
      targetNode,
      targetPose,
    }),
  });

  recordGhostTransitionTrace(
    "list-config:ghost-animation-start",
    {
      ...resolveTraceBase(),
      targetNode,
    },
    {
      sourceAngle: ghostTransition.sourceAngle,
      sourceFrame: ghostTransition.sourceFrame,
      targetAngle: targetPose.angle,
      targetRect: targetPose.frame,
      ...samplePlaybackState(),
    },
  );
  if (surfaceTransition) {
    recordGhostTransitionTrace(
      "list-config:ghost-surface-transition-configured",
      {
        ...resolveTraceBase(),
        targetNode,
      },
      samplePlaybackState(),
    );
  }
  if (!surfaceTransition) {
    hideGhostTarget(targetNode);
  }

  let beforePaintFrame: number | null = null;
  let cleanupFrame: number | null = null;
  let startAnimationFrame: number | null = null;
  let isCancelled = false;
  let isCompleted = false;
  const ownerWindow = ghostTransition.cloneNode.ownerDocument.defaultView;
  const resolveTraceTargetNode = () =>
    args.resolveTargetNode() ?? (targetNode.isConnected ? targetNode : null);
  const recordPlaybackTrace = (event: string, payload: Record<string, unknown> = {}) => {
    recordGhostTransitionTrace(
      event,
      {
        ...resolveTraceBase(),
        targetNode: resolveTraceTargetNode(),
      },
      {
        ...samplePlaybackState(),
        ...payload,
      },
    );
  };
  const captureHandoffFrame = () => {
    if (!ownerWindow) {
      recordPlaybackTrace(
        "list-config:ghost-handoff-frame",
        resolveTerminalAlignmentTrace("handoff-frame"),
      );
      return;
    }

    ownerWindow.requestAnimationFrame(() => {
      if (isCancelled) {
        return;
      }

      recordPlaybackTrace(
        "list-config:ghost-handoff-frame",
        resolveTerminalAlignmentTrace("handoff-frame"),
      );
    });
  };
  const revealTarget = () => {
    // The ghost surface has already handed off to the target renderer during
    // flight, so the terminal swap is now only a visibility handoff.
    surfaceTransition?.releaseTarget();
    if (!surfaceTransition) {
      showGhostTarget(targetNode);
    }
    recordPlaybackTrace(
      "list-config:ghost-target-revealed",
      resolveTerminalAlignmentTrace("target-revealed"),
    );
    ghostTransition.cloneNode.remove();
    captureGhostTransitionFrames({
      label: "list-config:ghost-handoff",
      frames: 8,
      ...resolveTraceBase(),
      resolveTargetNode: args.resolveTargetNode,
      sampleMotion: samplePlaybackState,
    });
    isCompleted = true;
    args.onFinish();
    captureHandoffFrame();
  };

  beforePaintFrame =
    ownerWindow?.requestAnimationFrame(() => {
      recordPlaybackTrace("list-config:ghost-before-paint");
      recordPlaybackTrace("list-config:ghost-animation-bound");

      animation.finished
        .catch(() => {})
        .finally(() => {
          if (isCancelled) {
            return;
          }

          if (!ownerWindow) {
            recordPlaybackTrace(
              "list-config:ghost-animation-finished",
              resolveTerminalAlignmentTrace("animation-finished"),
            );
            revealTarget();
            return;
          }

          // Let the exact terminal pose paint once before swapping visibility;
          // the ghost already carries the target surface by this point.
          cleanupFrame = ownerWindow.requestAnimationFrame(() => {
            if (isCancelled) {
              return;
            }

            recordPlaybackTrace(
              "list-config:ghost-animation-finished",
              resolveTerminalAlignmentTrace("animation-finished"),
            );
            revealTarget();
          });
        });

      startAnimationFrame =
        ownerWindow?.requestAnimationFrame(() => {
          recordPlaybackTrace("list-config:ghost-before-play");
          captureGhostTransitionFrames({
            label: "list-config:ghost-animation",
            frames: 48,
            ...resolveTraceBase(),
            resolveTargetNode: args.resolveTargetNode,
            sampleMotion: samplePlaybackState,
          });
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
    recordGhostTransitionTrace(
      "list-config:ghost-animation-cancelled",
      {
        ...resolveTraceBase(),
        targetNode: args.resolveTargetNode() ?? targetNode,
      },
      samplePlaybackState(),
    );
    surfaceTransition?.releaseTarget();
    if (!surfaceTransition) {
      showGhostTarget(targetNode);
    }
    ghostTransition.cloneNode.remove();
  };
}

export function useListConfigGhostTransition() {
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null);
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
      recordGhostTransitionTrace("list-config:ghost-target-missing", {
        layoutId: ghostTransition.layoutId,
        sourceNode: ghostTransition.sourceNode,
        cloneNode: ghostTransition.cloneNode,
        cloneContentNode: ghostTransition.cloneContentNode,
        targetNode: null,
      });
      return;
    }

    const playbackCleanup = scheduleGhostAnimationPlayback({
      ghostTransition,
      targetNode,
      resolveTargetNode: () =>
        resolveRegisteredGhostNode({
          registry: ghostNodeRegistryRef.current,
          layoutId: ghostTransition.layoutId,
          ownerId: ghostTransition.targetOwnerId,
        }),
      onFinish: () => {
        if (ghostPlaybackCleanupRef.current === playbackCleanup) {
          ghostPlaybackCleanupRef.current = null;
        }

        if (ghostTransitionRef.current?.layoutId === ghostTransition.layoutId) {
          ghostTransitionRef.current = null;
        }

        setActiveLayoutId((current) => (current === ghostTransition.layoutId ? null : current));
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
    (args: {
      layoutId: string;
      sourceNode: HTMLDivElement | null;
      targetOwnerId: string;
    }) => {
      ghostPlaybackCleanupRef.current?.();
      ghostPlaybackCleanupRef.current = null;
      ghostTransitionRef.current?.cloneNode.remove();
      ghostTransitionRef.current = null;

      if (!args.sourceNode) {
        recordListConfigGhostTrace("list-config:ghost-start-missing-source", {
          layoutId: args.layoutId,
        });
        return;
      }

      const {
        cloneContentNode,
        cloneNode,
        sourceAngle,
        sourceClipInsets,
        sourceFrame,
        sourceTransformOrigin,
      } =
        createGhostClone(args.sourceNode);
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
        sourceClipInsets,
        sourceFrame,
        sourceNode: args.sourceNode,
        sourceTransformOrigin,
        targetOwnerId: args.targetOwnerId,
      };
      recordGhostTransitionTrace("list-config:ghost-start", {
        ...traceBase,
        targetNode: resolveRegisteredGhostNode({
          registry: ghostNodeRegistryRef.current,
          layoutId: args.layoutId,
          ownerId: args.targetOwnerId,
        }),
      });

      flushSync(() => {
        setDismissHoverSignal((current) => current + 1);
        setActiveLayoutId(args.layoutId);
      });
      recordGhostTransitionTrace("list-config:ghost-after-flush", {
        ...traceBase,
        targetNode: resolveRegisteredGhostNode({
          registry: ghostNodeRegistryRef.current,
          layoutId: args.layoutId,
          ownerId: args.targetOwnerId,
        }),
      });
      scheduleGhostPlaybackAttempt();
    },
    [scheduleGhostPlaybackAttempt],
  );

  return {
    activeLayoutId,
    dismissHoverSignal,
    isAnimating: activeLayoutId !== null,
    registerGhostNode,
    startGhostTransition,
  };
}
