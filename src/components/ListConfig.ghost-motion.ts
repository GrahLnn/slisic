import {
  normalizeGhostAngle,
  resolveGhostAngleFromPoint,
  resolveGhostFrameCenter,
  type GhostFrame,
  type GhostPoint,
} from "./ListConfig.ghost-geometry";

export type GhostPath = {
  start: GhostPoint;
  control1: GhostPoint;
  control2: GhostPoint;
  end: GhostPoint;
};

export type GhostMotionState = {
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
  transformOrigin: GhostPoint;
  width: number;
};

export type GhostMotionSample = {
  derivative: GhostPoint;
  path: GhostPath;
  state: GhostMotionState;
};

export const GHOST_MOTION_DURATION = 440;

const GHOST_ANGLE_HOLD_PROGRESS = 0.08;
const GHOST_ANGLE_SETTLE_PROGRESS = 0.82;

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

function easeInGhostProgress(progress: number) {
  const clampedProgress = clampGhostValue(progress, 0, 1);

  return clampedProgress * clampedProgress;
}

function smoothstepGhostProgress(progress: number) {
  const clampedProgress = clampGhostValue(progress, 0, 1);

  return clampedProgress * clampedProgress * (3 - 2 * clampedProgress);
}

function resolveGhostUnwrappedAngle(angle: number, referenceAngle: number) {
  return referenceAngle + normalizeGhostAngle(angle - referenceAngle);
}

function normalizeGhostOrientationDelta(angleDelta: number) {
  return ((((angleDelta + 90) % 180) + 180) % 180) - 90;
}

function resolveGhostOrientedAngle(angle: number, referenceAngle: number) {
  return referenceAngle + normalizeGhostOrientationDelta(angle - referenceAngle);
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

export function resolveGhostBezierPoint(path: GhostPath, progress: number): GhostPoint {
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

export function resolveGhostBezierDerivative(path: GhostPath, progress: number): GhostPoint {
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

export function resolveGhostPathTangentAngle(args: {
  path: GhostPath;
  progress: number;
}) {
  return resolveGhostAngleFromPoint(
    resolveGhostBezierDerivative(args.path, clampGhostValue(args.progress, 0, 1)),
  );
}

/**
 * Ghost labels track the rail orientation, not the signed travel direction.
 * Anchoring the half-turn choice to the source heading prevents low-to-high pushes
 * from drifting into the upside-down tangent branch while keeping the same curve.
 */
function resolveGhostRailOrientationAngle(args: {
  sourceAngle: number;
  tangentAngle: number;
}) {
  return resolveGhostOrientedAngle(args.tangentAngle, args.sourceAngle);
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

  return resolveGhostRailOrientationAngle({
    sourceAngle: args.sourceAngle,
    tangentAngle: resolveGhostPathTangentAngle({
      path: args.path,
      progress,
    }),
  });
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
  sourceTransformOrigin: GhostPoint;
  targetAngle: number;
  targetFrame: GhostFrame;
  targetTransformOrigin: GhostPoint;
}) {
  const progress = clampGhostValue(args.progress, 0, 1);
  const followWidth = lerpGhostValue(args.sourceFrame.width, args.targetFrame.width, progress);
  const followHeight = lerpGhostValue(args.sourceFrame.height, args.targetFrame.height, progress);
  const followCenter = resolveGhostBezierPoint(args.path, progress);
  const rawPathAngle = resolveGhostPathTangentAngle({
    path: args.path,
    progress,
  });
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
    smoothstepGhostProgress(followProgress),
  );
  const transformOriginProgress = smoothstepGhostProgress(followProgress);
  const settleProgress = clampGhostValue(
    (progress - GHOST_ANGLE_SETTLE_PROGRESS) / (1 - GHOST_ANGLE_SETTLE_PROGRESS),
    0,
    1,
  );
  const settleTargetAngle = resolveGhostUnwrappedAngle(args.targetAngle, trackedAngle);
  const angle = lerpGhostValue(
    trackedAngle,
    settleTargetAngle,
    easeInGhostProgress(settleProgress),
  );
  const dockingProgress = easeInGhostProgress(settleProgress);
  const targetCenter = resolveGhostFrameCenter(args.targetFrame);
  const center = {
    x: lerpGhostValue(followCenter.x, targetCenter.x, dockingProgress),
    y: lerpGhostValue(followCenter.y, targetCenter.y, dockingProgress),
  } satisfies GhostPoint;
  const width = lerpGhostValue(followWidth, args.targetFrame.width, dockingProgress);
  const height = lerpGhostValue(followHeight, args.targetFrame.height, dockingProgress);

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
    transformOrigin: {
      x: lerpGhostValue(
        args.sourceTransformOrigin.x,
        args.targetTransformOrigin.x,
        transformOriginProgress,
      ),
      y: lerpGhostValue(
        args.sourceTransformOrigin.y,
        args.targetTransformOrigin.y,
        transformOriginProgress,
      ),
    },
    width,
  } satisfies GhostMotionState;
}

export function resolveGhostMotionPlaybackProgress(args: {
  prefersReducedMotion: boolean;
  rawProgress: number;
}) {
  const rawProgress = clampGhostValue(args.rawProgress, 0, 1);

  return args.prefersReducedMotion ? rawProgress : easeOutGhostProgress(rawProgress);
}

export function createGhostMotionModel(args: {
  sourceAngle: number;
  sourceFrame: GhostFrame;
  sourceTransformOrigin: GhostPoint;
  targetAngle: number;
  targetFrame: GhostFrame;
  targetTransformOrigin: GhostPoint;
}) {
  const path = resolveGhostMotionPath(args);

  const sample = (progress: number): GhostMotionSample => {
    const state = resolveGhostMotionState({
      ...args,
      path,
      progress,
    });

    return {
      derivative: resolveGhostBezierDerivative(path, state.progress),
      path,
      state,
    };
  };

  return {
    path,
    sample,
    samplePlayback(rawProgress: number, prefersReducedMotion: boolean) {
      return sample(
        resolveGhostMotionPlaybackProgress({
          prefersReducedMotion,
          rawProgress,
        }),
      );
    },
  };
}
