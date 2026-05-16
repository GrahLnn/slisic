import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  collectionTitleTextClassName,
  collectionTitleTextStaticClassName,
  collectionTitleTextRetainHoverClassName,
  COLLECTION_TITLE_HOVER_RETAIN_MS,
  COLLECTION_TITLE_WEIGHT_TRANSITION_MS,
  resolveCollectionTitleRetainedHoverVisual,
} from "./collectionTitle";
import {
  resolveEditableTitleDisplayText,
  resolveEditableTitleDisplayValue,
  resolveEditableTitleCursorIndex,
  resolveEditableTitleCursorOpacityAnimation,
  resolveEditableTitleCursorOpacityTransition,
  resolveEditableTitleCursorMoveTransition,
  resolveEditableTitleCursorShouldBlink,
  resolveEditableTitleCursorVisible,
  editableTitleNewSymbolOpacityClassName,
  resolveEditableTitleCustomCursorOpacityClassName,
  resolveEditableTitleCustomCursorInnerOpacityStyle,
  resolveEditableTitleCustomCursorTone,
  resolveEditableTitleCustomCursorUsesMotionOpacity,
  resolveEditableTitleInputReadOnly,
  resolveEditableTitleLayoutId,
  resolveEditableTitleSelectionBackground,
  resolveEditableTitleUsesMetricAnchor,
  resolveEditableTitleCursorPointFromPretextPrefixLayout,
  resolveEditableTitleCustomCursorBarStyle,
  resolveEditableTitleCustomCursorBoxStyle,
} from "./EditableTitle";

describe("resolveEditableTitleDisplayValue", () => {
  test("uses the current value when one exists", () => {
    assert.equal(
      resolveEditableTitleDisplayValue("Quiet Morning", "Create a List"),
      "Quiet Morning",
    );
  });

  test("keeps an explicit placeholder when the title is empty", () => {
    assert.equal(resolveEditableTitleDisplayValue("", "Create a List"), "Create a List");
  });

  test("stays empty when the caller does not provide a placeholder", () => {
    assert.equal(resolveEditableTitleDisplayValue("", undefined), "");
  });

  test("uses an invisible text metric anchor for new-title plus mode", () => {
    assert.equal(
      resolveEditableTitleDisplayText({
        isNewTitle: true,
        usesMetricAnchor: true,
        value: "Ignored",
      }),
      "A",
    );
    assert.equal(
      resolveEditableTitleDisplayText({
        isNewTitle: false,
        placeholder: "Create a List",
        value: "",
      }),
      "Create a List",
    );
  });

  test("uses the metric anchor for an empty custom-cursor title", () => {
    assert.equal(
      resolveEditableTitleUsesMetricAnchor({
        customCursorEnabled: true,
        isNewTitle: false,
        value: "",
      }),
      true,
    );
    assert.equal(
      resolveEditableTitleDisplayText({
        isNewTitle: false,
        placeholder: undefined,
        usesMetricAnchor: true,
        value: "",
      }),
      "A",
    );
  });
});

describe("EditableTitle input state", () => {
  test("keeps new-title activation out of native text editing until the caller clears it", () => {
    assert.equal(
      resolveEditableTitleInputReadOnly({
        interactionDisabled: false,
        isAutoWriting: false,
        isNewTitle: true,
      }),
      true,
    );
    assert.equal(
      resolveEditableTitleInputReadOnly({
        interactionDisabled: false,
        isAutoWriting: false,
        isNewTitle: false,
      }),
      false,
    );
  });

  test("derives selection highlight as a background from the current title color", () => {
    assert.equal(
      resolveEditableTitleSelectionBackground("rgba(9, 9, 9, 1)"),
      "color-mix(in srgb, rgba(9, 9, 9, 1) 60%, transparent)",
    );
  });

  test("keeps the custom cursor index inside the current title value", () => {
    assert.equal(resolveEditableTitleCursorIndex({ cursorIndex: -1, value: "Track" }), 0);
    assert.equal(resolveEditableTitleCursorIndex({ cursorIndex: 2, value: "Track" }), 2);
    assert.equal(resolveEditableTitleCursorIndex({ cursorIndex: 8, value: "Track" }), 5);
  });

  test("keeps the custom cursor visible after an empty editable title blurs", () => {
    assert.equal(
      resolveEditableTitleCursorVisible({
        cursorPointReady: true,
        inputReadOnly: false,
        isFocused: false,
        isNewTitle: false,
        value: "",
      }),
      true,
    );
    assert.equal(
      resolveEditableTitleCursorVisible({
        cursorPointReady: true,
        inputReadOnly: false,
        isFocused: false,
        isNewTitle: false,
        value: "Track",
      }),
      false,
    );
    assert.equal(
      resolveEditableTitleCursorVisible({
        cursorPointReady: false,
        inputReadOnly: false,
        isFocused: true,
        isNewTitle: false,
        value: "Track",
      }),
      false,
    );
  });

  test("blinks the custom cursor only while the editable title is focused", () => {
    assert.equal(
      resolveEditableTitleCursorShouldBlink({
        cursorVisible: true,
        isFocused: true,
        isNewTitle: false,
      }),
      true,
    );
    assert.equal(
      resolveEditableTitleCursorShouldBlink({
        cursorVisible: true,
        isFocused: false,
        isNewTitle: false,
      }),
      false,
    );
    assert.equal(
      resolveEditableTitleCursorShouldBlink({
        cursorVisible: true,
        isFocused: true,
        isNewTitle: true,
      }),
      false,
    );
  });

  test("keeps blink reset as an opacity concern instead of cursor identity", () => {
    assert.equal(
      resolveEditableTitleCursorOpacityAnimation({
        cursorShouldBlink: true,
        cursorVisible: true,
        isNewTitle: false,
      }),
      1,
    );
    assert.equal(
      resolveEditableTitleCursorOpacityAnimation({
        cursorShouldBlink: false,
        cursorVisible: false,
        isNewTitle: false,
      }),
      0,
    );
    assert.equal(
      resolveEditableTitleCursorOpacityAnimation({
        cursorShouldBlink: false,
        cursorVisible: false,
        isNewTitle: true,
      }),
      1,
    );
    assert.deepEqual(
      resolveEditableTitleCursorOpacityTransition({
        cursorShouldBlink: true,
      }),
      { duration: 0 },
    );
  });

  test("projects title cursor coordinates without width-forced wrapping", () => {
    assert.deepEqual(
      resolveEditableTitleCursorPointFromPretextPrefixLayout({
        lastLineWidthPx: 42,
        lineCount: 1,
        lineHeightPx: 28,
        prefixEndsWithHardBreak: false,
      }),
      { leftPx: 42, lineHeightPx: 28, motion: "smooth", ready: true, topPx: 0 },
    );
    assert.deepEqual(
      resolveEditableTitleCursorPointFromPretextPrefixLayout({
        lastLineWidthPx: 318,
        lineCount: 1,
        lineHeightPx: 28,
        prefixEndsWithHardBreak: false,
      }),
      { leftPx: 318, lineHeightPx: 28, motion: "smooth", ready: true, topPx: 0 },
    );
    assert.deepEqual(
      resolveEditableTitleCursorPointFromPretextPrefixLayout({
        lastLineWidthPx: 18,
        lineCount: 3,
        lineHeightPx: 28,
        prefixEndsWithHardBreak: true,
      }),
      { leftPx: 0, lineHeightPx: 28, motion: "smooth", ready: true, topPx: 84 },
    );
  });

  test("moves the editable cursor smoothly only after a stable cursor point exists", () => {
    assert.deepEqual(
      resolveEditableTitleCursorMoveTransition({
        isNewTitle: false,
        point: { leftPx: 42, lineHeightPx: 28, motion: "smooth", ready: true, topPx: 0 },
      }),
      { duration: 0.12, ease: "easeOut" },
    );
    assert.deepEqual(
      resolveEditableTitleCursorMoveTransition({
        isNewTitle: false,
        point: { leftPx: 42, lineHeightPx: 28, motion: "instant", ready: true, topPx: 0 },
      }),
      { duration: 0 },
    );
    assert.deepEqual(
      resolveEditableTitleCursorMoveTransition({
        isNewTitle: false,
        point: { leftPx: 42, lineHeightPx: 28, motion: "smooth", ready: false, topPx: 0 },
      }),
      { duration: 0 },
    );
    assert.deepEqual(
      resolveEditableTitleCursorMoveTransition({
        isNewTitle: true,
        point: { leftPx: 0, lineHeightPx: 0, motion: "smooth", ready: true, topPx: 0 },
      }),
      { duration: 0 },
    );
  });

  test("keeps the plus symbol shorter than the editable cursor", () => {
    assert.deepEqual(
      resolveEditableTitleCustomCursorBarStyle({
        isNewTitle: true,
        lineHeightPx: 28,
      }),
      {
        height: "0.7em",
        width: "0.7em",
      },
    );
    assert.deepEqual(
      resolveEditableTitleCustomCursorBarStyle({
        isNewTitle: false,
        lineHeightPx: 28,
      }),
      {
        height: "28px",
        width: "28px",
      },
    );
  });

  test("draws the custom cursor with the solid title color instead of muted text alpha", () => {
    assert.equal(resolveEditableTitleCustomCursorTone(), "solid");
  });

  test("applies new-title transparency to the whole plus symbol instead of individual bars", () => {
    assert.match(editableTitleNewSymbolOpacityClassName, /opacity-60/);
    assert.match(editableTitleNewSymbolOpacityClassName, /group-hover\/editable-title:opacity-80/);
    assert.match(editableTitleNewSymbolOpacityClassName, /duration-\[160ms\]/);
    assert.equal(
      resolveEditableTitleCustomCursorOpacityClassName({ isNewTitle: true }),
      editableTitleNewSymbolOpacityClassName,
    );
    assert.equal(
      resolveEditableTitleCustomCursorOpacityClassName({ isNewTitle: false }),
      undefined,
    );
    assert.equal(resolveEditableTitleCustomCursorUsesMotionOpacity({ isNewTitle: true }), false);
    assert.equal(resolveEditableTitleCustomCursorUsesMotionOpacity({ isNewTitle: false }), true);
    assert.deepEqual(
      resolveEditableTitleCustomCursorInnerOpacityStyle({
        cursorOpacityAnimation: 0,
        isNewTitle: true,
      }),
      { opacity: 1 },
    );
    assert.deepEqual(
      resolveEditableTitleCustomCursorInnerOpacityStyle({
        cursorOpacityAnimation: 0,
        isNewTitle: false,
      }),
      { opacity: 0 },
    );
  });

  test("anchors the editable cursor box to the measured line height", () => {
    assert.deepEqual(
      resolveEditableTitleCustomCursorBoxStyle({
        isNewTitle: true,
        lineHeightPx: 28,
      }),
      {
        height: "0.9em",
      },
    );
    assert.deepEqual(
      resolveEditableTitleCustomCursorBoxStyle({
        isNewTitle: false,
        lineHeightPx: 28,
      }),
      {
        height: "28px",
      },
    );
  });
});

describe("resolveEditableTitleLayoutId", () => {
  test("keeps the shared layout id while idle", () => {
    assert.equal(
      resolveEditableTitleLayoutId({
        layoutId: "playlist-title:Quiet Morning",
        interactionDisabled: false,
        isFocused: false,
        isAutoWriting: false,
      }),
      "playlist-title:Quiet Morning",
    );
  });

  test("disables shared layout while the user is actively editing", () => {
    assert.equal(
      resolveEditableTitleLayoutId({
        layoutId: "playlist-title:Quiet Morning",
        interactionDisabled: false,
        isFocused: true,
        isAutoWriting: false,
      }),
      undefined,
    );
  });

  test("disables shared layout while auto-writing a fallback title", () => {
    assert.equal(
      resolveEditableTitleLayoutId({
        layoutId: "playlist-title:Quiet Morning",
        interactionDisabled: false,
        isFocused: false,
        isAutoWriting: true,
      }),
      undefined,
    );
  });
});

describe("EditableTitle text style boundary", () => {
  test("uses the shared collection title hover contract", () => {
    assert.equal(COLLECTION_TITLE_WEIGHT_TRANSITION_MS, 160);
    assert.match(collectionTitleTextClassName, /duration-\[160ms\]/);
    assert.doesNotMatch(collectionTitleTextClassName, /duration-300/);
    assert.match(collectionTitleTextClassName, /hover:font-\[680\]/);
    assert.match(collectionTitleTextClassName, /hover:tracking-\[-0\.03em\]/);
  });

  test("can use the shared title typography without native hover weight", () => {
    assert.match(collectionTitleTextStaticClassName, /duration-\[160ms\]/);
    assert.doesNotMatch(collectionTitleTextStaticClassName, /hover:font-\[680\]/);
    assert.doesNotMatch(collectionTitleTextStaticClassName, /hover:tracking-\[-0\.03em\]/);
  });

  test("keeps retained hover weight for the whole shared-title transition", () => {
    assert.equal(COLLECTION_TITLE_HOVER_RETAIN_MS, 360);
    assert.match(collectionTitleTextRetainHoverClassName, /font-\[680\]/);
    assert.match(collectionTitleTextRetainHoverClassName, /\[font-variation-settings:'wght'_680\]/);
    assert.match(collectionTitleTextRetainHoverClassName, /tracking-\[-0\.03em\]/);
    assert.match(collectionTitleTextRetainHoverClassName, /transition-none/);
    assert.doesNotMatch(collectionTitleTextRetainHoverClassName, /animate-/);
  });

  test("keeps retain active after the caller transient state clears", () => {
    assert.equal(
      resolveCollectionTitleRetainedHoverVisual({
        requestedVisual: "none",
        retainWindowActive: true,
      }),
      "retain",
    );
    assert.equal(
      resolveCollectionTitleRetainedHoverVisual({
        requestedVisual: "none",
        retainWindowActive: false,
      }),
      "none",
    );
    assert.equal(
      resolveCollectionTitleRetainedHoverVisual({
        requestedVisual: "retain",
        retainWindowActive: false,
      }),
      "retain",
    );
    assert.equal(
      resolveCollectionTitleRetainedHoverVisual({
        requestedVisual: "hold",
        retainWindowActive: true,
      }),
      "hold",
    );
  });
});
