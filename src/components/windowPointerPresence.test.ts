import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MouseWindowInfo } from "@/src/cmd";
import { resolveWindowPointerPresence } from "./windowPointerPresence";

function createMouseWindowInfo(overrides: Partial<MouseWindowInfo> = {}): MouseWindowInfo {
  return {
    mouse_x: 120,
    mouse_y: 120,
    window_x: 100,
    window_y: 100,
    window_width: 300,
    window_height: 200,
    rel_x: 20,
    rel_y: 20,
    pixel_ratio: 1,
    ...overrides,
  };
}

describe("window pointer presence", () => {
  test("treats coordinates inside the current window as present", () => {
    assert.equal(resolveWindowPointerPresence(createMouseWindowInfo()), true);
  });

  test("treats coordinates outside the current window as absent", () => {
    assert.equal(
      resolveWindowPointerPresence(
        createMouseWindowInfo({
          rel_x: 301,
        }),
      ),
      false,
    );
    assert.equal(
      resolveWindowPointerPresence(
        createMouseWindowInfo({
          rel_y: -1,
        }),
      ),
      false,
    );
  });
});
