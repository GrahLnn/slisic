import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createGhostMotionModel,
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
      targetFrame,
    });
    const linearMidpointY =
      (sourceFrame.top + sourceFrame.height / 2 + targetFrame.top + targetFrame.height / 2) / 2;

    assert.ok(Math.abs(state.center.y - linearMidpointY) > 4);
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

  test("keeps the early motion aligned with the source forward heading", () => {
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
      targetFrame: createTargetFrame(),
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
    const forwardDistance = delta.x * sourceHeading.x + delta.y * sourceHeading.y;
    const lateralDistance = delta.x * -sourceHeading.y + delta.y * sourceHeading.x;

    assert.ok(forwardDistance > 0);
    assert.ok(Math.abs(lateralDistance) < forwardDistance * 0.01);
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
      targetFrame,
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
      targetFrame,
    });
    const earlyFollowState = resolveGhostMotionState({
      path,
      progress: 0.26698276343715577,
      sourceAngle,
      sourceFrame,
      targetFrame,
    });

    assert.ok(Math.abs(earlyFollowState.pathAngle - sourceAngle) < 5);
    assert.ok(Math.abs(earlyFollowState.rawPathAngle - earlyFollowState.pathAngle) > 150);
    assert.ok(Math.abs(earlyFollowState.angle - initialState.angle) < 5);
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
      targetFrame,
    });
    const settleEntryState = resolveGhostMotionState({
      path,
      progress: 0.8394319016413956,
      sourceAngle,
      sourceFrame,
      targetFrame,
    });

    assert.ok(Math.abs(settleEntryState.angle - preSettleState.angle) < 25);
    assert.ok(Math.abs(settleEntryState.trackedAngle - settleEntryState.angle) < 5);
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
      targetFrame,
    });

    assert.ok(Math.abs(state.left - targetFrame.left) < 0.001);
    assert.ok(Math.abs(state.top - targetFrame.top) < 0.001);
    assert.ok(Math.abs(state.width - targetFrame.width) < 0.001);
    assert.ok(Math.abs(state.height - targetFrame.height) < 0.001);
    assert.ok(Math.abs(((state.angle % 360) + 360) % 360) < 0.001);
  });

  test("composes the planned path and sampled state through a single motion model", () => {
    const sourceFrame = createSourceFrame();
    const targetFrame = createTargetFrame();
    const sourceAngle = -10.6;
    const model = createGhostMotionModel({
      sourceAngle,
      sourceFrame,
      targetFrame,
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
      targetFrame,
    });

    assert.deepEqual(sample.path, path);
    assert.deepEqual(sample.state, state);
  });
});
