import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { shouldApplyStoredScrollTop } from "./scrollPosition";

describe("scroll position", () => {
  test("skips restore when the stored offset already matches the current offset", () => {
    assert.equal(
      shouldApplyStoredScrollTop({
        currentScrollTop: 240,
        storedScrollTop: 240.5,
      }),
      false,
    );
  });

  test("restores when the stored offset differs from the current offset", () => {
    assert.equal(
      shouldApplyStoredScrollTop({
        currentScrollTop: 0,
        storedScrollTop: 240,
      }),
      true,
    );
  });
});
