import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolvePlayListPageItemSlotPositionAnimationEnabled } from "./PlayListPageItem.motion";

describe("PlayListPageItem", () => {
  test("enables slot position animation only while Torph is idle and text is stable", () => {
    assert.equal(
      resolvePlayListPageItemSlotPositionAnimationEnabled({
        requested: true,
        torphStage: "idle",
        textChanged: false,
      }),
      true,
    );
    assert.equal(
      resolvePlayListPageItemSlotPositionAnimationEnabled({
        requested: true,
        torphStage: "prepare",
        textChanged: false,
      }),
      false,
    );
    assert.equal(
      resolvePlayListPageItemSlotPositionAnimationEnabled({
        requested: true,
        torphStage: "animate",
        textChanged: false,
      }),
      false,
    );
    assert.equal(
      resolvePlayListPageItemSlotPositionAnimationEnabled({
        requested: false,
        torphStage: "idle",
        textChanged: false,
      }),
      false,
    );
    assert.equal(
      resolvePlayListPageItemSlotPositionAnimationEnabled({
        requested: true,
        torphStage: "idle",
        textChanged: true,
      }),
      false,
    );
  });
});
