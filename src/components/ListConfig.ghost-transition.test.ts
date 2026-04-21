import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveGhostContinuousPathAngle,
  resolveGhostAngleFromTransform,
  resolveGhostCloneFrame,
  resolveGhostMotionPath,
  resolveGhostMotionState,
} from "./ListConfig.ghost-transition";

describe("ListConfig ghost transition", () => {
  test("recovers the pre-transform frame from the transformed source rect", () => {
    const frame = resolveGhostCloneFrame({
      sourceRect: {
        left: 1201.7822265625,
        top: 211.1537322998047,
        width: 90.88460540771484,
        height: 34.08927536010742,
      },
      width: 89.0938,
      height: 18,
      transform: "matrix(0.982919, -0.184039, 0.184039, 0.982919, 0, 0)",
      transformOrigin: "89.0938px 9px",
    });

    assert.ok(Math.abs(frame.left - 1201.91677) < 0.01);
    assert.ok(Math.abs(frame.top - 211.00001) < 0.01);
    assert.equal(frame.width, 89.0938);
    assert.equal(frame.height, 18);
  });

  test("keeps the box unchanged when the source has no transform", () => {
    assert.deepEqual(
      resolveGhostCloneFrame({
        sourceRect: {
          left: 380,
          top: 371.3333435058594,
          width: 71.8125,
          height: 18,
        },
        width: 71.8125,
        height: 18,
        transform: "none",
        transformOrigin: "35.9062px 9px",
      }),
      {
        left: 380,
        top: 371.3333435058594,
        width: 71.8125,
        height: 18,
      },
    );
  });

  test("extracts the visual angle from the current transform matrix", () => {
    assert.ok(
      Math.abs(
        resolveGhostAngleFromTransform("matrix(0.982919, -0.184039, 0.184039, 0.982919, 0, 0)") +
          10.6,
      ) < 0.2,
    );
  });

  test("uses a curved motion path instead of a straight midpoint interpolation", () => {
    const sourceFrame = {
      left: 1201.91677,
      top: 211.00001,
      width: 89.0938,
      height: 18,
    };
    const targetFrame = {
      left: 380,
      top: 371.3333435058594,
      width: 71.8125,
      height: 18,
    };
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
    const sourceFrame = {
      left: 1201.91677,
      top: 211.00001,
      width: 89.0938,
      height: 18,
    };
    const targetFrame = {
      left: 380,
      top: 371.3333435058594,
      width: 71.8125,
      height: 18,
    };
    const path = resolveGhostMotionPath({
      sourceAngle: -10.6,
      sourceFrame,
      targetFrame,
    });
    const initialPathAngle = resolveGhostContinuousPathAngle({
      path,
      progress: 0,
      sourceAngle: -10.6,
    });

    assert.ok(Math.abs(initialPathAngle + 10.6) < 0.01);
  });

  test("keeps the early motion aligned with the source forward heading", () => {
    const sourceFrame = {
      left: 1201.91677,
      top: 211.00001,
      width: 89.0938,
      height: 18,
    };
    const targetFrame = {
      left: 380,
      top: 371.3333435058594,
      width: 71.8125,
      height: 18,
    };
    const sourceAngle = -10.6;
    const path = resolveGhostMotionPath({
      sourceAngle,
      sourceFrame,
      targetFrame,
    });
    const state = resolveGhostMotionState({
      path,
      progress: 0.08,
      sourceAngle,
      sourceFrame,
      targetFrame,
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
    const sourceFrame = {
      left: 1201.91677,
      top: 211.00001,
      width: 89.0938,
      height: 18,
    };
    const targetFrame = {
      left: 380,
      top: 371.3333435058594,
      width: 71.8125,
      height: 18,
    };
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
    const sourceFrame = {
      left: 1201.91677,
      top: 211.00001,
      width: 89.0938,
      height: 18,
    };
    const targetFrame = {
      left: 380,
      top: 371.3333435058594,
      width: 71.8125,
      height: 18,
    };
    const path = resolveGhostMotionPath({
      sourceAngle: -10.6,
      sourceFrame,
      targetFrame,
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

  test("lands on the target frame and settles back to the horizontal label pose", () => {
    const sourceFrame = {
      left: 1201.91677,
      top: 211.00001,
      width: 89.0938,
      height: 18,
    };
    const targetFrame = {
      left: 380,
      top: 371.3333435058594,
      width: 71.8125,
      height: 18,
    };
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
});
