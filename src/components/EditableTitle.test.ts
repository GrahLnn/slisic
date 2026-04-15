import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveEditableTitleDisplayValue } from "./EditableTitle";

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
