import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { collectionTitleTextRetainHoverClassName } from "./collectionTitle";
import {
  resolvePlayItemColorHandoff,
  resolvePlayItemTextMetricClassName,
  resolvePlaybackIconLayerBox,
  shouldShowPlaybackIconLayer,
} from "./playItem";
import { resolvePlayItemFrameProjection } from "./playItem.motion";

describe("playItem", () => {
  test("keeps shared projection position-only so text changes do not scale glyphs", () => {
    assert.deepEqual(
      resolvePlayItemFrameProjection({
        layoutId: " playlist-title:Quiet Morning ",
      }),
      {
        layout: "position",
        layoutId: "playlist-title:Quiet Morning",
      },
    );
    assert.deepEqual(
      resolvePlayItemFrameProjection({
        layoutId: "   ",
      }),
      {
        layout: false,
        layoutId: undefined,
      },
    );
    assert.deepEqual(resolvePlayItemFrameProjection({}), {
      layout: false,
      layoutId: undefined,
    });
  });

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

  test("centers playback icons from the current title anchor", () => {
    assert.deepEqual(
      resolvePlaybackIconLayerBox({
        anchorBottom: 120,
        anchorCenterX: 250,
        textWidth: 180.2,
        viewportWidth: 500,
      }),
      {
        left: 159.5,
        top: 124,
        width: 181,
      },
    );
    assert.deepEqual(
      resolvePlaybackIconLayerBox({
        anchorBottom: 120,
        anchorCenterX: 250,
        textWidth: 24,
        viewportWidth: 500,
      }),
      {
        left: 194,
        top: 124,
        width: 112,
      },
    );
    assert.deepEqual(
      resolvePlaybackIconLayerBox({
        anchorBottom: 120,
        anchorCenterX: 250,
        textWidth: 720,
        viewportWidth: 500,
      }),
      {
        left: 0,
        top: 124,
        width: 500,
      },
    );
  });

  test("rejects playback icon boxes without usable text, viewport, or anchor coordinates", () => {
    assert.equal(
      resolvePlaybackIconLayerBox({
        anchorBottom: 120,
        anchorCenterX: 250,
        textWidth: 0,
        viewportWidth: 500,
      }),
      undefined,
    );
    assert.equal(
      resolvePlaybackIconLayerBox({
        anchorBottom: 120,
        anchorCenterX: 250,
        textWidth: 180,
        viewportWidth: 0,
      }),
      undefined,
    );
    assert.equal(
      resolvePlaybackIconLayerBox({
        anchorBottom: Number.NaN,
        anchorCenterX: 250,
        textWidth: 180,
        viewportWidth: 500,
      }),
      undefined,
    );
  });

  test("hides playback icons only while Torph is preparing the text transition", () => {
    assert.equal(
      shouldShowPlaybackIconLayer({
        hasLayerBox: true,
        isWindowPointerInside: true,
        showPlaybackIcons: true,
        torphStage: "prepare",
      }),
      false,
    );
    assert.equal(
      shouldShowPlaybackIconLayer({
        hasLayerBox: true,
        isWindowPointerInside: true,
        showPlaybackIcons: true,
        torphStage: "animate",
      }),
      true,
    );
    assert.equal(
      shouldShowPlaybackIconLayer({
        hasLayerBox: true,
        isWindowPointerInside: true,
        showPlaybackIcons: true,
        torphStage: "idle",
      }),
      true,
    );
  });

  test("keeps the hover window as the only playback icon visibility owner", () => {
    assert.equal(
      shouldShowPlaybackIconLayer({
        hasLayerBox: true,
        isWindowPointerInside: false,
        showPlaybackIcons: true,
        torphStage: "animate",
      }),
      false,
    );
    assert.equal(
      shouldShowPlaybackIconLayer({
        hasLayerBox: true,
        isWindowPointerInside: true,
        showPlaybackIcons: false,
        torphStage: "animate",
      }),
      false,
    );
    assert.equal(
      shouldShowPlaybackIconLayer({
        hasLayerBox: true,
        isWindowPointerInside: true,
        showPlaybackIcons: true,
        torphStage: "animate",
      }),
      true,
    );
  });

  test("keeps playback icons dismissed once spectrum opening starts", () => {
    assert.equal(
      shouldShowPlaybackIconLayer({
        hasLayerBox: true,
        isDismissed: true,
        isWindowPointerInside: true,
        showPlaybackIcons: true,
        torphStage: "idle",
      }),
      false,
    );
  });

  test("hides playback icons while playback is preparing", () => {
    assert.equal(
      shouldShowPlaybackIconLayer({
        hasLayerBox: true,
        isPlaybackPreparing: true,
        isWindowPointerInside: true,
        showPlaybackIcons: true,
        torphStage: "idle",
      }),
      false,
    );
  });

  test("uses one text metric class for both the wrapper and Torph root", () => {
    const className = resolvePlayItemTextMetricClassName(collectionTitleTextRetainHoverClassName);

    assert.match(className, /font-\[680\]/);
    assert.match(className, /\[font-variation-settings:'wght'_680\]/);
    assert.match(className, /tracking-\[-0\.03em\]/);
    assert.match(className, /transition-none/);
  });
});
