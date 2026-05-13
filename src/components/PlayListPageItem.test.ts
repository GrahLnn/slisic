import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { collectionTitleTextRetainHoverClassName } from "./collectionTitle";
import {
  resolvePlayListPageItemRequestedTitleHoverVisual,
  resolvePlayListPageItemTitleHoverLock,
  resolvePlayListPageItemTitleFrameClassName,
  resolvePlayListPageItemTitleRetainKey,
  resolvePlayListPageItemTitleRetainRequestKey,
} from "./PlayListPageItem";
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

  test("keeps title retain ownership stable when playback swaps playlist text to track text", () => {
    assert.equal(
      resolvePlayListPageItemTitleRetainKey({
        key: "Quiet Morning",
        layoutId: undefined,
        playlistName: "Quiet Morning",
        sourceLayoutId: "playlist-title:Quiet Morning",
      }),
      "playlist-title:Quiet Morning",
    );
  });

  test("separates the title retain owner from the text-specific lease request", () => {
    const playlistTitle = {
      key: "Quiet Morning",
      layoutId: undefined,
      playlistName: "Quiet Morning",
      sourceLayoutId: "playlist-title:Quiet Morning",
    };
    const ownerKey = resolvePlayListPageItemTitleRetainKey(playlistTitle);

    assert.equal(ownerKey, "playlist-title:Quiet Morning");
    assert.equal(
      resolvePlayListPageItemTitleRetainRequestKey({
        ...playlistTitle,
        text: "Quiet Morning",
      }),
      "playlist-title:Quiet Morning:Quiet Morning",
    );
    assert.equal(
      resolvePlayListPageItemTitleRetainRequestKey({
        ...playlistTitle,
        text: "Track A",
      }),
      "playlist-title:Quiet Morning:Track A",
    );
    assert.notEqual(
      resolvePlayListPageItemTitleRetainRequestKey({
        ...playlistTitle,
        text: "Quiet Morning",
      }),
      resolvePlayListPageItemTitleRetainRequestKey({
        ...playlistTitle,
        text: "Track A",
      }),
    );
  });

  test("keeps the title hover weight locked until Torph reaches idle", () => {
    assert.deepEqual(
      resolvePlayListPageItemTitleHoverLock({
        previousLocked: false,
        retainedVisual: "retain",
        requestedVisual: "retain",
        torphStage: "idle",
      }),
      {
        locked: true,
        visual: "retain",
      },
    );
    assert.deepEqual(
      resolvePlayListPageItemTitleHoverLock({
        previousLocked: true,
        retainedVisual: "none",
        requestedVisual: "none",
        torphStage: "animate",
      }),
      {
        locked: true,
        visual: "retain",
      },
    );
    assert.deepEqual(
      resolvePlayListPageItemTitleHoverLock({
        previousLocked: true,
        retainedVisual: "none",
        requestedVisual: "none",
        torphStage: "idle",
      }),
      {
        locked: false,
        visual: "none",
      },
    );
  });

  test("keeps stage-only title retain out of the timed retain lease", () => {
    assert.equal(
      resolvePlayListPageItemRequestedTitleHoverVisual({
        titleHoverVisual: "retain",
        titleHoverRetainLease: "stage-only",
      }),
      "none",
    );
    assert.deepEqual(
      resolvePlayListPageItemTitleHoverLock({
        previousLocked: false,
        retainedVisual: "none",
        requestedVisual: "retain",
        torphStage: "animate",
      }),
      {
        locked: true,
        visual: "retain",
      },
    );
    assert.deepEqual(
      resolvePlayListPageItemTitleHoverLock({
        previousLocked: true,
        retainedVisual: "none",
        requestedVisual: "none",
        torphStage: "idle",
      }),
      {
        locked: false,
        visual: "none",
      },
    );
  });
});
