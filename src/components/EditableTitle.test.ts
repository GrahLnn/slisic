import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveEditableTitleDisplayValue,
  resolveEditableTitleLayoutId,
} from "./EditableTitle";

describe("resolveEditableTitleDisplayValue", () => {
  test("uses the current value when one exists", () => {
    assert.equal(
      resolveEditableTitleDisplayValue("Quiet Morning", "Create a List"),
      "Quiet Morning",
    );
  });

  test("keeps an explicit placeholder when the title is empty", () => {
    assert.equal(
      resolveEditableTitleDisplayValue("", "Create a List"),
      "Create a List",
    );
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
