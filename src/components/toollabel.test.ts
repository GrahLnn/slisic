import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveToolLabelPlainTextClassName } from "./toollabel";

describe("ToolLabel text surface", () => {
  test("uses the same canonical line-height wrapper for plain text rendering", () => {
    assert.equal(resolveToolLabelPlainTextClassName(), "inline-block leading-[18px]");
  });
});
