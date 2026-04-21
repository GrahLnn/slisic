import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolvePlayItemColorHandoff } from "./playItem";

describe("playItem", () => {
  test("uses the target color directly when there is no handoff tone", () => {
    assert.deepEqual(
      resolvePlayItemColorHandoff({
        targetColor: "rgba(9, 9, 9, 1)",
        handoffColor: "rgba(246, 246, 246, 1)",
        handoffTone: null,
      }),
      {
        initialColor: "rgba(9, 9, 9, 1)",
        shouldAnimate: false,
      },
    );
  });

  test("skips animation when handoff and target colors already match", () => {
    assert.deepEqual(
      resolvePlayItemColorHandoff({
        targetColor: "rgba(9, 9, 9, 1)",
        handoffColor: "rgba(9, 9, 9, 1)",
        handoffTone: "solid",
      }),
      {
        initialColor: "rgba(9, 9, 9, 1)",
        shouldAnimate: false,
      },
    );
  });

  test("starts from the handoff color when a distinct handoff tone is present", () => {
    assert.deepEqual(
      resolvePlayItemColorHandoff({
        targetColor: "rgba(9, 9, 9, 1)",
        handoffColor: "rgba(246, 246, 246, 1)",
        handoffTone: "muted",
      }),
      {
        initialColor: "rgba(246, 246, 246, 1)",
        shouldAnimate: true,
      },
    );
  });
});
