import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  collectionTitleTextClassName,
  collectionTitleTextRetainHoverClassName,
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
    assert.match(collectionTitleTextClassName, /hover:font-\[680\]/);
    assert.match(collectionTitleTextClassName, /hover:tracking-\[-0\.03em\]/);
  });

  test("keeps retained hover weight for the whole shared-title transition", () => {
    const appCss = fs.readFileSync(path.join(import.meta.dirname, "../App.css"), "utf8");
    const retainKeyframes = appCss.match(
      /@keyframes collection-title-hover-retain\s*{[\s\S]*?^}/m,
    )?.[0];

    assert.ok(retainKeyframes);
    assert.match(collectionTitleTextRetainHoverClassName, /collection-title-hover-retain/);
    assert.match(retainKeyframes, /0%,\s*\n\s*100%\s*{/);
    assert.match(retainKeyframes, /font-weight:\s*680/);
    assert.match(retainKeyframes, /font-variation-settings:\s*"wght"\s*680/);
    assert.match(retainKeyframes, /letter-spacing:\s*-0\.03em/);
    assert.doesNotMatch(retainKeyframes, /font-weight:\s*520/);
    assert.doesNotMatch(collectionTitleTextRetainHoverClassName, /(?:forwards|both)/);
  });
});
