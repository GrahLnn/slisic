import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveArcTrackAnimatedStart,
  resolveArcTrackItemFrame,
  resolveArcTrackPathClassName,
  resolveArcTrackPathStrokeWidth,
  resolveArcTrackViewportScrollTop,
  resolveArcTrackVirtualPaddingEnd,
} from "./ArcTrackList";

describe("resolveArcTrackVirtualPaddingEnd", () => {
  test("keeps the trailing padding intact when there are no items", () => {
    assert.equal(resolveArcTrackVirtualPaddingEnd(0), 112);
  });

  test("subtracts one gap when virtual rows represent point spacing", () => {
    assert.equal(resolveArcTrackVirtualPaddingEnd(3), 34);
  });
});

describe("resolveArcTrackPathClassName", () => {
  test("uses a stronger path style when the track has no items", () => {
    assert.equal(resolveArcTrackPathClassName(0), "stroke-[#b7b7b7]/52 dark:stroke-[#676767]/58");
  });

  test("keeps the lighter path style when the track has items", () => {
    assert.equal(resolveArcTrackPathClassName(3), "stroke-[#b7b7b7]/32 dark:stroke-[#676767]/38");
  });
});

describe("resolveArcTrackPathStrokeWidth", () => {
  test("uses a thicker path when the track has no items", () => {
    assert.equal(resolveArcTrackPathStrokeWidth(0), 1.7);
  });

  test("keeps the original path width when the track has items", () => {
    assert.equal(resolveArcTrackPathStrokeWidth(2), 1.25);
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

describe("resolveArcTrackItemFrame", () => {
  test("projects the item into a stable top/left frame", () => {
    assert.deepEqual(
      resolveArcTrackItemFrame({
        sample: {
          x: 244,
          y: 220,
        },
        itemWidth: 120,
        itemHeight: 28,
      }),
      {
        left: 126,
        top: 206,
      },
    );
  });

  test("returns null when the arc sample is outside the visible lookup", () => {
    assert.equal(
      resolveArcTrackItemFrame({
        sample: null,
        itemWidth: 120,
        itemHeight: 28,
      }),
      null,
    );
  });
});

describe("resolveArcTrackAnimatedStart", () => {
  test("keeps the original track offset at the beginning of the motion", () => {
    assert.equal(
      resolveArcTrackAnimatedStart({
        fromStart: 480,
        targetStart: 402,
        progress: 0,
      }),
      480,
    );
  });

  test("reaches the target track offset at the end of the motion", () => {
    assert.equal(
      resolveArcTrackAnimatedStart({
        fromStart: 480,
        targetStart: 402,
        progress: 1,
      }),
      402,
    );
  });

  test("interpolates on the track parameter instead of snapping to the final offset", () => {
    assert.equal(
      resolveArcTrackAnimatedStart({
        fromStart: 480,
        targetStart: 402,
        progress: 0.5,
      }),
      411.75,
    );
  });
});
