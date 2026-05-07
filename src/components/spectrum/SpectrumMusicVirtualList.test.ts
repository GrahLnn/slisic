import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveSpectrumMusicVirtualListHeight,
  resolveSpectrumMusicVirtualRangeIndexes,
  resolveSpectrumMusicVirtualRowTransform,
} from "./SpectrumMusicVirtualList";

describe("SpectrumMusicVirtualList", () => {
  test("keeps virtual list height owned by the virtualizer total size", () => {
    assert.equal(resolveSpectrumMusicVirtualListHeight({ totalSize: 960 }), 960);
  });

  test("positions rows from virtualizer coordinates without extra row math", () => {
    assert.equal(
      resolveSpectrumMusicVirtualRowTransform({ scrollMargin: 128, start: 384 }),
      "translateY(256px)",
    );
  });

  test("pins the current music row while preserving sorted virtual indexes", () => {
    assert.deepEqual(
      resolveSpectrumMusicVirtualRangeIndexes({
        indexes: [5, 6, 7],
        pinnedIndex: 0,
      }),
      [0, 5, 6, 7],
    );
  });

  test("does not duplicate the pinned row when it is already virtualized", () => {
    assert.deepEqual(
      resolveSpectrumMusicVirtualRangeIndexes({
        indexes: [0, 1, 2],
        pinnedIndex: 0,
      }),
      [0, 1, 2],
    );
  });

  test("keeps an empty virtual range empty", () => {
    assert.deepEqual(
      resolveSpectrumMusicVirtualRangeIndexes({
        indexes: [],
        pinnedIndex: null,
      }),
      [],
    );
  });
});
