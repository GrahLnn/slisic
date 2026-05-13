import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { collectionTitleTextRetainHoverClassName } from "./collectionTitle";
import { resolvePlayListPageItemTitleFrameClassName } from "./PlayListPageItem";
import {
  resolvePlayListPageItemSlotPositionAnimationEnabled,
  resolvePlayListPageItemTitleProjectionLayoutId,
} from "./PlayListPageItem.motion";

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

  test("uses title projection only while the PlayItem text is stable", () => {
    assert.equal(
      resolvePlayListPageItemTitleProjectionLayoutId({
        layoutId: "playlist-title:Quiet Morning",
        torphStage: "idle",
        textChanged: false,
      }),
      "playlist-title:Quiet Morning",
    );
    assert.equal(
      resolvePlayListPageItemTitleProjectionLayoutId({
        layoutId: "playlist-title:Quiet Morning",
        torphStage: "idle",
        textChanged: true,
      }),
      undefined,
    );
    assert.equal(
      resolvePlayListPageItemTitleProjectionLayoutId({
        layoutId: "playlist-title:Quiet Morning",
        torphStage: "animate",
        textChanged: false,
      }),
      undefined,
    );
  });

  test("uses an immediate title weight for shared layout handoff evidence", () => {
    assert.match(collectionTitleTextRetainHoverClassName, /font-\[680\]/);
    assert.match(collectionTitleTextRetainHoverClassName, /transition-none/);
  });

  test("puts retained title weight on the shared layout host", () => {
    const className = resolvePlayListPageItemTitleFrameClassName(
      collectionTitleTextRetainHoverClassName,
    );

    assert.match(className, /text-4xl/);
    assert.match(className, /font-\[680\]/);
    assert.match(className, /\[font-variation-settings:'wght'_680\]/);
    assert.match(className, /transition-none/);
  });
});
