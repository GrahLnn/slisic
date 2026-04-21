import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveGhostCloneFrame } from "./ListConfig.ghost-transition";

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
});
