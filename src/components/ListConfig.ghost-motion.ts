import {
  normalizeGhostAngle,
  resolveGhostAngleFromPoint,
  resolveGhostFrameCenter,
  type GhostFrame,
  type GhostPoint,
} from "./ListConfig.ghost-geometry";

export type GhostPathSegment = {
  start: GhostPoint;
  control1: GhostPoint;
  control2: GhostPoint;
  end: GhostPoint;
};

export type GhostPath = {
  end: GhostPoint;
  homing: GhostPathSegment;
  launch: GhostPathSegment;
  start: GhostPoint;
  splitProgress: number;
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

function resolveGhostPointDot(from: GhostPoint, to: GhostPoint) {
  return from.x * to.x + from.y * to.y;
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

/**
 * Tool labels expose an oriented rail axis, not a signed travel vector.
 * Path planning must choose whichever branch of that axis actually heads
 * toward the target, otherwise lower-right pushes start by drifting away.
 */
function resolveGhostTravelDirectionFromAxis(args: {
  angle: number;
  toTargetDirection: GhostPoint;
}) {
  const forwardDirection = resolveGhostDirectionFromAngle(args.angle);
  const reverseDirection = {
    x: -forwardDirection.x,
    y: -forwardDirection.y,
  } satisfies GhostPoint;

  return resolveGhostPointDot(forwardDirection, args.toTargetDirection) >=
    resolveGhostPointDot(reverseDirection, args.toTargetDirection)
    ? forwardDirection
    : reverseDirection;
}

function resolveGhostExitDistance(args: {
  distance: number;
  exitDirection: GhostPoint;
  toTargetDirection: GhostPoint;
}) {
  const headingAlignment = clampGhostValue(
    resolveGhostPointDot(args.exitDirection, args.toTargetDirection),
    0,
    1,
  );
  const rolloutFactor = lerpGhostValue(0.06, 0.18, headingAlignment);

  return clampGhostValue(args.distance * rolloutFactor, 28, 120);
}

function resolveGhostBezierSegmentPoint(segment: GhostPathSegment, progress: number): GhostPoint {
  const inverseProgress = 1 - progress;
  const a = inverseProgress * inverseProgress * inverseProgress;
  const b = 3 * inverseProgress * inverseProgress * progress;
  const c = 3 * inverseProgress * progress * progress;
  const d = progress * progress * progress;

  return {
    x:
      a * segment.start.x +
      b * segment.control1.x +
      c * segment.control2.x +
      d * segment.end.x,
    y:
      a * segment.start.y +
      b * segment.control1.y +
      c * segment.control2.y +
      d * segment.end.y,
  };
}

function resolveGhostBezierSegmentDerivative(
  segment: GhostPathSegment,
  progress: number,
): GhostPoint {
  const inverseProgress = 1 - progress;

  return {
    x:
      3 * inverseProgress * inverseProgress * (segment.control1.x - segment.start.x) +
      6 * inverseProgress * progress * (segment.control2.x - segment.control1.x) +
      3 * progress * progress * (segment.end.x - segment.control2.x),
    y:
      3 * inverseProgress * inverseProgress * (segment.control1.y - segment.start.y) +
      6 * inverseProgress * progress * (segment.control2.y - segment.control1.y) +
      3 * progress * progress * (segment.end.y - segment.control2.y),
  };
}

function resolveGhostPathSample(path: GhostPath, progress: number) {
  const clampedProgress = clampGhostValue(progress, 0, 1);
  const splitProgress = clampGhostValue(path.splitProgress, 0.05, 0.95);

  if (clampedProgress <= splitProgress) {
    return {
      localProgress:
        splitProgress <= 1e-6 ? 1 : clampGhostValue(clampedProgress / splitProgress, 0, 1),
      segment: path.launch,
      segmentSpan: splitProgress,
    };
  }

  const homingSpan = 1 - splitProgress;

  return {
    localProgress:
      homingSpan <= 1e-6
        ? 1
        : clampGhostValue((clampedProgress - splitProgress) / homingSpan, 0, 1),
    segment: path.homing,
    segmentSpan: homingSpan,
  };
}

export function resolveGhostBezierPoint(path: GhostPath, progress: number): GhostPoint {
  const sample = resolveGhostPathSample(path, progress);

  return resolveGhostBezierSegmentPoint(sample.segment, sample.localProgress);
}

export function resolveGhostBezierDerivative(path: GhostPath, progress: number): GhostPoint {
  const sample = resolveGhostPathSample(path, progress);
  const derivative = resolveGhostBezierSegmentDerivative(sample.segment, sample.localProgress);
  const progressScale = sample.segmentSpan <= 1e-6 ? 1 : sample.segmentSpan;

  return {
    x: derivative.x / progressScale,
    y: derivative.y / progressScale,
  };
}

function resolveGhostStraightPathSegment(args: {
  direction: GhostPoint;
  end: GhostPoint;
  start: GhostPoint;
}) {
  const delta = {
    x: args.end.x - args.start.x,
    y: args.end.y - args.start.y,
  };
  const handleDistance = Math.hypot(delta.x, delta.y) / 3;

  return {
    start: args.start,
    control1: {
      x: args.start.x + args.direction.x * handleDistance,
      y: args.start.y + args.direction.y * handleDistance,
    },
    control2: {
      x: args.end.x - args.direction.x * handleDistance,
      y: args.end.y - args.direction.y * handleDistance,
    },
    end: args.end,
  } satisfies GhostPathSegment;
}

function resolveGhostHomingSegment(args: {
  end: GhostPoint;
  exitDirection: GhostPoint;
  launchDistance: number;
  start: GhostPoint;
}) {
  const toTargetDirection = resolveGhostDirection({
    x: args.end.x - args.start.x,
    y: args.end.y - args.start.y,
  });
  const startHandleDistance = clampGhostValue(args.launchDistance * 0.8, 28, 96);
  const endHandleDistance = clampGhostValue(
    resolveGhostPointDistance(args.start, args.end) * 0.18,
    48,
    156,
  );

  return {
    start: args.start,
    control1: {
      x: args.start.x + args.exitDirection.x * startHandleDistance,
      y: args.start.y + args.exitDirection.y * startHandleDistance,
    },
    control2: {
      x: args.end.x - toTargetDirection.x * endHandleDistance,
      y: args.end.y - toTargetDirection.y * endHandleDistance,
    },
    end: args.end,
  } satisfies GhostPathSegment;
}

function resolveGhostLaunchProgress(args: {
  distance: number;
  launchDistance: number;
}) {
  return clampGhostValue(args.launchDistance / Math.max(args.distance * 0.9, 1), 0.12, 0.22);
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
  const exitDirection = resolveGhostTravelDirectionFromAxis({
    angle: args.sourceAngle,
    toTargetDirection,
  });
  const exitDistance = resolveGhostExitDistance({
    distance,
    exitDirection,
    toTargetDirection,
  });
  const launchEnd = {
    x: start.x + exitDirection.x * exitDistance,
    y: start.y + exitDirection.y * exitDistance,
  } satisfies GhostPoint;
  const launch = resolveGhostStraightPathSegment({
    direction: exitDirection,
    start,
    end: launchEnd,
  });
  const homing = resolveGhostHomingSegment({
    end,
    exitDirection,
    launchDistance: exitDistance,
    start: launchEnd,
  });
  const splitProgress = resolveGhostLaunchProgress({
    distance,
    launchDistance: exitDistance,
  });

  return {
    end,
    homing,
    launch,
    start,
    splitProgress,
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
