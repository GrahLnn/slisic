import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveArcTrackAnimatedStart,
  resolveArcTrackDisplayItems,
  resolveArcTrackItemFrame,
  resolveArcTrackItemMountState,
  resolveArcTrackPathClassName,
  resolveArcTrackPathStrokeWidth,
  resolveArcTrackVisibleInsertion,
  resolveArcTrackViewportScrollTop,
  resolveArcTrackVirtualPaddingEnd,
} from "./ArcTrackList";

function createItem(name: string, url: string) {
  return {
    kind: "collection" as const,
    name,
    url,
    folder: `/music/${name}`,
  };
}

describe("resolveArcTrackVirtualPaddingEnd", () => {
  test("uses half of the viewport as the visible bottom padding for populated tracks", () => {
    assert.equal(
      resolveArcTrackVirtualPaddingEnd({
        itemCount: 3,
        viewportHeight: 800,
      }),
      322,
    );
  });

  test("keeps empty tracks at the literal half-viewport padding", () => {
    assert.equal(
      resolveArcTrackVirtualPaddingEnd({
        itemCount: 0,
        viewportHeight: 800,
      }),
      400,
    );
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

describe("resolveArcTrackVisibleInsertion", () => {
  test("brackets the source y between the nearest visible neighbors", () => {
    assert.deepEqual(
      resolveArcTrackVisibleInsertion({
        itemFrames: [
          {
            layoutId: "playlist:collection:above",
            top: 40,
            bottom: 70,
            centerY: 55,
          },
          {
            layoutId: "playlist:collection:upper",
            top: 140,
            bottom: 170,
            centerY: 155,
          },
          {
            layoutId: "playlist:collection:lower",
            top: 240,
            bottom: 270,
            centerY: 255,
          },
          {
            layoutId: "playlist:collection:below",
            top: 560,
            bottom: 590,
            centerY: 575,
          },
        ],
        sourceCenterY: 210,
        viewportTop: 100,
        viewportBottom: 500,
      }),
      {
        previousLayoutId: "playlist:collection:upper",
        nextLayoutId: "playlist:collection:lower",
      },
    );
  });

  test("pins the insertion to the first visible item when the source is above the viewport band", () => {
    assert.deepEqual(
      resolveArcTrackVisibleInsertion({
        itemFrames: [
          {
            layoutId: "playlist:collection:upper",
            top: 140,
            bottom: 170,
            centerY: 155,
          },
          {
            layoutId: "playlist:collection:lower",
            top: 240,
            bottom: 270,
            centerY: 255,
          },
        ],
        sourceCenterY: 120,
        viewportTop: 100,
        viewportBottom: 500,
      }),
      {
        previousLayoutId: null,
        nextLayoutId: "playlist:collection:upper",
      },
    );
  });
});

describe("resolveArcTrackDisplayItems", () => {
  test("inserts the returning item between the planned visible neighbors", () => {
    const resolution = resolveArcTrackDisplayItems({
      items: [
        createItem("Alpha", "alpha"),
        createItem("Bravo", "bravo"),
        createItem("Charlie", "charlie"),
        createItem("Delta", "delta"),
      ],
      previousLayoutOrder: [
        "playlist:collection:alpha",
        "playlist:collection:bravo",
        "playlist:collection:delta",
      ],
      pendingInsertion: {
        targetLayoutId: "playlist:collection:charlie",
        previousLayoutId: "playlist:collection:alpha",
        nextLayoutId: "playlist:collection:bravo",
      },
    });

    assert.equal(resolution.didApplyPendingInsertion, true);
    assert.deepEqual(
      resolution.items.map((item) => item.url),
      ["alpha", "charlie", "bravo", "delta"],
    );
  });

  test("preserves the prior rendered order for existing items before appending new ones", () => {
    const resolution = resolveArcTrackDisplayItems({
      items: [
        createItem("Alpha", "alpha"),
        createItem("Bravo", "bravo"),
        createItem("Charlie", "charlie"),
      ],
      previousLayoutOrder: ["playlist:collection:bravo", "playlist:collection:alpha"],
      pendingInsertion: null,
    });

    assert.deepEqual(
      resolution.items.map((item) => item.url),
      ["bravo", "alpha", "charlie"],
    );
  });
});

describe("resolveArcTrackItemMountState", () => {
  test("snaps the returning target directly to the planned insertion start", () => {
    assert.deepEqual(
      resolveArcTrackItemMountState({
        detachedState: {
          start: 468,
          renderedStart: 468,
        },
        nextStart: 312,
        shouldIgnoreDetachedState: true,
      }),
      {
        start: 312,
        renderedStart: 312,
        shouldAnimateToStart: false,
      },
    );
  });

  test("preserves detached placement for regular arc items so they can animate to the new start", () => {
    assert.deepEqual(
      resolveArcTrackItemMountState({
        detachedState: {
          start: 468,
          renderedStart: 452,
        },
        nextStart: 312,
        shouldIgnoreDetachedState: false,
      }),
      {
        start: 468,
        renderedStart: 452,
        shouldAnimateToStart: true,
      },
    );
  });
});
