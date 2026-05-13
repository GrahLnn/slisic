import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  collectionTitleTextClassName,
  collectionTitleTextRetainHoverClassName,
  COLLECTION_TITLE_HOVER_RETAIN_MS,
  COLLECTION_TITLE_WEIGHT_TRANSITION_MS,
  resolveCollectionTitleRetainedHoverVisual,
} from "./collectionTitle";
import { resolveEditableTitleDisplayValue, resolveEditableTitleLayoutId } from "./EditableTitle";

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
        requestedVisual: "hold",
        retainWindowActive: true,
      }),
      "hold",
    );
  });
});
