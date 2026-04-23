import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createGhostMotionModel,
  resolveGhostBezierDerivative,
  resolveGhostBezierPoint,
  resolveGhostContinuousPathAngle,
  resolveGhostMotionPath,
  resolveGhostMotionState,
} from "./ListConfig.ghost-motion";

function createSourceFrame() {
  return {
    left: 1201.91677,
    top: 211.00001,
    width: 89.0938,
    height: 18,
  };
}

function createTargetFrame() {
  return {
    left: 380,
    top: 371.3333435058594,
    width: 71.8125,
    height: 18,
  };
}

function createSourceTransformOrigin() {
  return {
    x: 89.0938,
    y: 9,
  };
}

function createTargetTransformOrigin() {
  return {
    x: 35.90625,
    y: 9,
  };
}

function createLowerArcPushSourceFrame() {
  return {
    left: 1170.1354494901875,
    top: 445.0000019921875,
    width: 87.6667,
    height: 18,
  };
}

function createLowerArcPushTargetFrame() {
  return {
    left: 380,
    top: 371.3333435058594,
    width: 87.6667,
    height: 18,
  };
}

function createLowerArcPushTransformOrigin() {
  return {
    x: 87.6667,
    y: 9,
  };
}

function lerpValue(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

function dotVector(
  left: {
    x: number;
    y: number;
  },
  right: {
    x: number;
    y: number;
  },
) {
  return left.x * right.x + left.y * right.y;
}

function normalizeVector(vector: {
  x: number;
  y: number;
}) {
  const magnitude = Math.hypot(vector.x, vector.y);

  return magnitude <= 1e-6
    ? {
        x: 1,
        y: 0,
      }
    : {
        x: vector.x / magnitude,
        y: vector.y / magnitude,
      };
}

describe("ListConfig ghost motion", () => {
  test("uses a curved motion path instead of a straight midpoint interpolation", () => {
    const sourceFrame = createSourceFrame();
    const targetFrame = createTargetFrame();
    const path = resolveGhostMotionPath({
      sourceAngle: -10.6,
      sourceFrame,
      targetFrame,
    });
    const state = resolveGhostMotionState({
      path,
      progress: 0.5,
      sourceAngle: -10.6,
      sourceFrame,
      sourceTransformOrigin: createSourceTransformOrigin(),
      targetAngle: 0,
      targetFrame,
      targetTransformOrigin: createTargetTransformOrigin(),
    });
    const linearMidpoint = {
      x:
        (sourceFrame.left +
          sourceFrame.width / 2 +
          targetFrame.left +
          targetFrame.width / 2) /
        2,
      y:
        (sourceFrame.top +
          sourceFrame.height / 2 +
          targetFrame.top +
          targetFrame.height / 2) /
        2,
    };

    assert.ok(
      Math.hypot(state.center.x - linearMidpoint.x, state.center.y - linearMidpoint.y) > 10,
    );
  });

  test("uses the source angle as the exact initial path tangent", () => {
    const path = resolveGhostMotionPath({
      sourceAngle: -10.6,
      sourceFrame: createSourceFrame(),
      targetFrame: createTargetFrame(),
    });
    const initialPathAngle = resolveGhostContinuousPathAngle({
      path,
      progress: 0,
      sourceAngle: -10.6,
    });

    assert.ok(Math.abs(initialPathAngle + 10.6) < 0.01);
  });

  test("keeps the early motion aligned with the source rail axis", () => {
    const sourceFrame = createSourceFrame();
    const sourceAngle = -10.6;
    const path = resolveGhostMotionPath({
      sourceAngle,
      sourceFrame,
      targetFrame: createTargetFrame(),
    });
    const state = resolveGhostMotionState({
      path,
      progress: 0.08,
      sourceAngle,
      sourceFrame,
      sourceTransformOrigin: createSourceTransformOrigin(),
      targetAngle: 0,
      targetFrame: createTargetFrame(),
      targetTransformOrigin: createTargetTransformOrigin(),
    });
    const sourceHeadingInRadians = (sourceAngle * Math.PI) / 180;
    const sourceHeading = {
      x: Math.cos(sourceHeadingInRadians),
      y: Math.sin(sourceHeadingInRadians),
    };
    const delta = {
      x: state.center.x - path.start.x,
      y: state.center.y - path.start.y,
    };
    const axialDistance = Math.abs(dotVector(delta, sourceHeading));
    const lateralDistance = Math.abs(
      delta.x * -sourceHeading.y + delta.y * sourceHeading.x,
    );

    assert.ok(axialDistance > 0);
    assert.ok(lateralDistance < axialDistance * 0.01);
  });

  test("chooses the target-facing branch of the source rail axis for lower pushes", () => {
    const sourceFrame = createLowerArcPushSourceFrame();
    const targetFrame = createLowerArcPushTargetFrame();
    const sourceAngle = -5.397855224449131;
    const path = resolveGhostMotionPath({
      sourceAngle,
      sourceFrame,
      targetFrame,
    });
    const startDerivative = normalizeVector(resolveGhostBezierDerivative(path, 0));
    const sourceAxis = normalizeVector({
      x: Math.cos((sourceAngle * Math.PI) / 180),
      y: Math.sin((sourceAngle * Math.PI) / 180),
    });
    const toTargetDirection = normalizeVector({
      x: targetFrame.left + targetFrame.width / 2 - (sourceFrame.left + sourceFrame.width / 2),
      y: targetFrame.top + targetFrame.height / 2 - (sourceFrame.top + sourceFrame.height / 2),
    });

    assert.ok(Math.abs(dotVector(startDerivative, sourceAxis)) > 0.99);
    assert.ok(dotVector(startDerivative, toTargetDirection) > 0.9);
    assert.ok(path.launch.control1.x < path.start.x);
  });

  test("keeps the initial source angle fixed before the path-follow phase", () => {
    const sourceFrame = createSourceFrame();
    const targetFrame = createTargetFrame();
    const path = resolveGhostMotionPath({
      sourceAngle: -10.6,
      sourceFrame,
      targetFrame,
    });
    const state = resolveGhostMotionState({
      path,
      progress: 0.05,
      sourceAngle: -10.6,
      sourceFrame,
      sourceTransformOrigin: createSourceTransformOrigin(),
      targetAngle: 0,
      targetFrame,
      targetTransformOrigin: createTargetTransformOrigin(),
    });

    assert.ok(Math.abs(state.angle + 10.6) < 0.01);
  });

  test("keeps the path angle continuous when it crosses the wrap boundary", () => {
    const path = resolveGhostMotionPath({
      sourceAngle: -10.6,
      sourceFrame: createSourceFrame(),
      targetFrame: createTargetFrame(),
    });
    const pathAngles = [0.2, 0.4, 0.6, 0.8].map((progress) =>
      resolveGhostContinuousPathAngle({
        path,
        progress,
        sourceAngle: -10.6,
      }),
    );

    for (let index = 1; index < pathAngles.length; index += 1) {
      assert.ok(Math.abs(pathAngles[index] - pathAngles[index - 1]) < 90);
    }
  });

  test("treats the opposite tangent direction as the same rail orientation", () => {
    const sourceFrame = createSourceFrame();
    const targetFrame = createTargetFrame();
    const sourceAngle = -10.6;
    const path = resolveGhostMotionPath({
      sourceAngle,
      sourceFrame,
      targetFrame,
    });
    const initialState = resolveGhostMotionState({
      path,
      progress: 0,
      sourceAngle,
      sourceFrame,
      sourceTransformOrigin: createSourceTransformOrigin(),
      targetAngle: 0,
      targetFrame,
      targetTransformOrigin: createTargetTransformOrigin(),
    });
    const earlyFollowState = resolveGhostMotionState({
      path,
      progress: 0.26698276343715577,
      sourceAngle,
      sourceFrame,
      sourceTransformOrigin: createSourceTransformOrigin(),
      targetAngle: 0,
      targetFrame,
      targetTransformOrigin: createTargetTransformOrigin(),
    });

    assert.ok(Math.abs(earlyFollowState.pathAngle - sourceAngle) < 5);
    assert.ok(Math.abs(earlyFollowState.rawPathAngle - earlyFollowState.pathAngle) > 150);
    assert.ok(Math.abs(earlyFollowState.angle - initialState.angle) < 5);
  });

  test("keeps lower push trajectories on the source-facing rail branch", () => {
    const sourceFrame = createLowerArcPushSourceFrame();
    const targetFrame = createLowerArcPushTargetFrame();
    const sourceAngle = -5.397855224449131;
    const path = resolveGhostMotionPath({
      sourceAngle,
      sourceFrame,
      targetFrame,
    });
    const sampledStates = [0.15, 0.2, 0.3, 0.5, 0.8].map((progress) =>
      resolveGhostMotionState({
        path,
        progress,
        sourceAngle,
        sourceFrame,
        sourceTransformOrigin: createLowerArcPushTransformOrigin(),
        targetAngle: 0,
        targetFrame,
        targetTransformOrigin: createLowerArcPushTransformOrigin(),
      }),
    );
    const earlyState = resolveGhostMotionState({
      path,
      progress: 0.08,
      sourceAngle,
      sourceFrame,
      sourceTransformOrigin: createLowerArcPushTransformOrigin(),
      targetAngle: 0,
      targetFrame,
      targetTransformOrigin: createLowerArcPushTransformOrigin(),
    });

    assert.ok(sampledStates.some((state) => Math.abs(state.rawPathAngle - state.pathAngle) > 120));
    assert.ok(earlyState.center.x < path.start.x);
    assert.ok(earlyState.center.y > path.start.y + 4);

    for (const state of sampledStates) {
      assert.ok(
        Math.abs(state.pathAngle - sourceAngle) < 90,
        `expected pathAngle ${state.pathAngle} to stay on the source-facing branch`,
      );
      assert.ok(
        Math.abs(state.trackedAngle - sourceAngle) < 20,
        `expected trackedAngle ${state.trackedAngle} to avoid the upside-down branch`,
      );
    }
  });

  test("does not drop sharply when the settle phase begins", () => {
    const sourceFrame = createSourceFrame();
    const targetFrame = createTargetFrame();
    const sourceAngle = -10.6;
    const path = resolveGhostMotionPath({
      sourceAngle,
      sourceFrame,
      targetFrame,
    });
    const preSettleState = resolveGhostMotionState({
      path,
      progress: 0.8160851117462358,
      sourceAngle,
      sourceFrame,
      sourceTransformOrigin: createSourceTransformOrigin(),
      targetAngle: 0,
      targetFrame,
      targetTransformOrigin: createTargetTransformOrigin(),
    });
    const settleEntryState = resolveGhostMotionState({
      path,
      progress: 0.8394319016413956,
      sourceAngle,
      sourceFrame,
      sourceTransformOrigin: createSourceTransformOrigin(),
      targetAngle: 0,
      targetFrame,
      targetTransformOrigin: createTargetTransformOrigin(),
    });

    assert.ok(Math.abs(settleEntryState.angle - preSettleState.angle) < 25);
    assert.ok(Math.abs(settleEntryState.trackedAngle - settleEntryState.angle) < 5);
  });

  test("docks the terminal frame before the final handoff", () => {
    const sourceFrame = createSourceFrame();
    const targetFrame = createTargetFrame();
    const progress = 0.95;
    const path = resolveGhostMotionPath({
      sourceAngle: -10.6,
      sourceFrame,
      targetFrame,
    });
    const state = resolveGhostMotionState({
      path,
      progress,
      sourceAngle: -10.6,
      sourceFrame,
      sourceTransformOrigin: createSourceTransformOrigin(),
      targetAngle: 0,
      targetFrame,
      targetTransformOrigin: createTargetTransformOrigin(),
    });
    const followCenter = resolveGhostBezierPoint(path, progress);
    const followWidth = lerpValue(sourceFrame.width, targetFrame.width, progress);
    const followHeight = lerpValue(sourceFrame.height, targetFrame.height, progress);
    const followLeft = followCenter.x - followWidth / 2;
    const followTop = followCenter.y - followHeight / 2;

    assert.ok(Math.abs(state.left - targetFrame.left) < Math.abs(followLeft - targetFrame.left));
    assert.ok(Math.abs(state.top - targetFrame.top) < Math.abs(followTop - targetFrame.top));
    assert.ok(Math.abs(state.width - targetFrame.width) < Math.abs(followWidth - targetFrame.width));
  });

  test("lands on the target frame and settles back to the horizontal label pose", () => {
    const sourceFrame = createSourceFrame();
    const targetFrame = createTargetFrame();
    const path = resolveGhostMotionPath({
      sourceAngle: -10.6,
      sourceFrame,
      targetFrame,
    });
    const state = resolveGhostMotionState({
      path,
      progress: 1,
      sourceAngle: -10.6,
      sourceFrame,
      sourceTransformOrigin: createSourceTransformOrigin(),
      targetAngle: 0,
      targetFrame,
      targetTransformOrigin: createTargetTransformOrigin(),
    });

    assert.ok(Math.abs(state.left - targetFrame.left) < 0.001);
    assert.ok(Math.abs(state.top - targetFrame.top) < 0.001);
    assert.ok(Math.abs(state.width - targetFrame.width) < 0.001);
    assert.ok(Math.abs(state.height - targetFrame.height) < 0.001);
    assert.ok(Math.abs(((state.angle % 360) + 360) % 360) < 0.001);
    assert.ok(Math.abs(state.transformOrigin.x - createTargetTransformOrigin().x) < 0.001);
    assert.ok(Math.abs(state.transformOrigin.y - createTargetTransformOrigin().y) < 0.001);
  });

  test("lands on the target frame and settles to the target rail angle", () => {
    const sourceFrame = createSourceFrame();
    const targetFrame = createTargetFrame();
    const targetAngle = -10.6;
    const path = resolveGhostMotionPath({
      sourceAngle: -10.6,
      sourceFrame,
      targetFrame,
    });
    const state = resolveGhostMotionState({
      path,
      progress: 1,
      sourceAngle: -10.6,
      sourceFrame,
      sourceTransformOrigin: createTargetTransformOrigin(),
      targetAngle,
      targetFrame,
      targetTransformOrigin: createSourceTransformOrigin(),
    });

    assert.ok(Math.abs(state.left - targetFrame.left) < 0.001);
    assert.ok(Math.abs(state.top - targetFrame.top) < 0.001);
    assert.ok(Math.abs(state.width - targetFrame.width) < 0.001);
    assert.ok(Math.abs(state.height - targetFrame.height) < 0.001);
    assert.ok(Math.abs(state.angle - targetAngle) < 0.001);
    assert.ok(Math.abs(state.settleTargetAngle - targetAngle) < 0.001);
    assert.ok(Math.abs(state.transformOrigin.x - createSourceTransformOrigin().x) < 0.001);
    assert.ok(Math.abs(state.transformOrigin.y - createSourceTransformOrigin().y) < 0.001);
  });

  test("moves the rotation origin toward the target pose before the final handoff", () => {
    const sourceFrame = createSourceFrame();
    const targetFrame = createTargetFrame();
    const state = resolveGhostMotionState({
      path: resolveGhostMotionPath({
        sourceAngle: -10.6,
        sourceFrame,
        targetFrame,
      }),
      progress: 0.65,
      sourceAngle: -10.6,
      sourceFrame,
      sourceTransformOrigin: createSourceTransformOrigin(),
      targetAngle: 0,
      targetFrame,
      targetTransformOrigin: createTargetTransformOrigin(),
    });

    assert.ok(state.transformOrigin.x < createSourceTransformOrigin().x);
    assert.ok(state.transformOrigin.x > createTargetTransformOrigin().x);
    assert.equal(state.transformOrigin.y, 9);
  });

  test("composes the planned path and sampled state through a single motion model", () => {
    const sourceFrame = createSourceFrame();
    const targetFrame = createTargetFrame();
    const sourceAngle = -10.6;
    const model = createGhostMotionModel({
      sourceAngle,
      sourceFrame,
      sourceTransformOrigin: createSourceTransformOrigin(),
      targetAngle: 0,
      targetFrame,
      targetTransformOrigin: createTargetTransformOrigin(),
    });
    const sample = model.sample(0.5);
    const path = resolveGhostMotionPath({
      sourceAngle,
      sourceFrame,
      targetFrame,
    });
    const state = resolveGhostMotionState({
      path,
      progress: 0.5,
      sourceAngle,
      sourceFrame,
      sourceTransformOrigin: createSourceTransformOrigin(),
      targetAngle: 0,
      targetFrame,
      targetTransformOrigin: createTargetTransformOrigin(),
    });

    assert.deepEqual(sample.path, path);
    assert.deepEqual(sample.state, state);
  });
});
