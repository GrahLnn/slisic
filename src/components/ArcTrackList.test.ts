import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createArcTrackListIdentity,
  resolveArcTrackViewportScrollTop,
  resolveArcTrackVirtualPaddingEnd,
} from "./ArcTrackList";

describe("createArcTrackListIdentity", () => {
  test("stays stable for the same item sequence", () => {
    assert.equal(
      createArcTrackListIdentity(["alpha", "beta"]),
      createArcTrackListIdentity(["alpha", "beta"]),
    );
  });

  test("changes when the item sequence changes", () => {
    assert.notEqual(
      createArcTrackListIdentity(["alpha", "beta"]),
      createArcTrackListIdentity(["beta", "alpha"]),
    );
  });
});

describe("resolveArcTrackVirtualPaddingEnd", () => {
  test("keeps the trailing padding intact when there are no items", () => {
    assert.equal(resolveArcTrackVirtualPaddingEnd(0), 112);
  });

  test("subtracts one gap when virtual rows represent point spacing", () => {
    assert.equal(resolveArcTrackVirtualPaddingEnd(3), 34);
  });
});

describe("resolveArcTrackViewportScrollTop", () => {
  test("keeps the current scroll position when the next track still covers it", () => {
    assert.equal(
      resolveArcTrackViewportScrollTop({
        currentScrollTop: 420,
        trackHeight: 1600,
        viewportHeight: 640,
      }),
      420,
    );
  });

  test("clamps the scroll position when the track shrinks below it", () => {
    assert.equal(
      resolveArcTrackViewportScrollTop({
        currentScrollTop: 420,
        trackHeight: 900,
        viewportHeight: 640,
      }),
      260,
    );
  });

  test("resets to the top only when the track no longer scrolls", () => {
    assert.equal(
      resolveArcTrackViewportScrollTop({
        currentScrollTop: 420,
        trackHeight: 500,
        viewportHeight: 640,
      }),
      0,
    );
  });
});
