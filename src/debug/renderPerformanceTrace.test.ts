import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createRenderFrameDropSampleState,
  flushRenderFrameDropSampleState,
  mergeRenderPerformanceTraceEntries,
  sampleRenderFrameDropState,
  summarizeRenderPerformanceTraceEntries,
  type RenderPerformanceTraceEntry,
} from "./renderPerformanceTrace";
import { readTorphLibraryTraceEntries } from "./torphTrace";

describe("renderPerformanceTrace", () => {
  test("aggregates frame drops into window summaries", () => {
    const state = createRenderFrameDropSampleState({
      dropThresholdMs: 24,
      label: "spectrum",
      sampleWindowMs: 100,
      startedAt: 0,
      targetFrameMs: 16,
    });

    assert.equal(sampleRenderFrameDropState(state, 0), null);
    assert.equal(sampleRenderFrameDropState(state, 16), null);
    assert.equal(sampleRenderFrameDropState(state, 50), null);
    const summary = sampleRenderFrameDropState(state, 116);

    assert.deepEqual(summary, {
      averageFrameDeltaMs: (16 + 34 + 66) / 3,
      droppedFrameCount: 4,
      dropThresholdMs: 24,
      durationMs: 116,
      endedAt: 116,
      frameCount: 3,
      label: "spectrum",
      longestFrameDeltaMs: 66,
      payload: {},
      startedAt: 0,
      targetFrameMs: 16,
    });
    assert.equal(state.frameCount, 0);
    assert.equal(state.droppedFrameCount, 0);
  });

  test("does not flush an empty sampler window", () => {
    const state = createRenderFrameDropSampleState({
      startedAt: 100,
    });

    assert.equal(flushRenderFrameDropSampleState(state, 120), null);
    assert.equal(state.windowStartedAt, 120);
  });

  test("counts trace entries by event", () => {
    const entries: RenderPerformanceTraceEntry[] = [
      {
        event: "waveform-canvas-job",
        isoTime: "2026-05-08T00:00:00.000Z",
        payload: {},
        performanceNow: 1,
        seq: 0,
      },
      {
        event: "waveform-canvas-job",
        isoTime: "2026-05-08T00:00:00.001Z",
        payload: {},
        performanceNow: 2,
        seq: 1,
      },
      {
        event: "spectrum-title-path",
        isoTime: "2026-05-08T00:00:00.002Z",
        payload: {},
        performanceNow: 3,
        seq: 2,
      },
    ];

    assert.deepEqual(summarizeRenderPerformanceTraceEntries(entries), {
      entryCount: 3,
      eventCounts: {
        "spectrum-title-path": 1,
        "waveform-canvas-job": 2,
      },
    });
  });

  test("merges render and Torph trace entries by performance time", () => {
    const renderEntry: RenderPerformanceTraceEntry = {
      event: "title-hover-frame",
      isoTime: "2026-05-08T00:00:00.010Z",
      payload: {},
      performanceNow: 10,
      seq: 0,
    };
    const torphEntry = {
      source: "torph",
      event: "effect:frame-snapshot",
      performanceNow: 8,
      seq: 1,
      payload: {},
    };

    assert.deepEqual(
      mergeRenderPerformanceTraceEntries({
        renderEntries: [renderEntry],
        torphEntries: [torphEntry],
      }),
      [torphEntry, renderEntry],
    );
  });

  test("keeps untimed Torph trace entries after timed render entries", () => {
    const renderEntry: RenderPerformanceTraceEntry = {
      event: "title-hover-frame",
      isoTime: "2026-05-08T00:00:00.010Z",
      payload: {},
      performanceNow: 10,
      seq: 0,
    };
    const torphEntry = {
      source: "torph",
      event: "effect:trace-meta",
      payload: {},
    };

    assert.deepEqual(
      mergeRenderPerformanceTraceEntries({
        renderEntries: [renderEntry],
        torphEntries: [torphEntry],
      }),
      [renderEntry, torphEntry],
    );
  });

  test("can read Torph library trace entries from the shared trace API", () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          __TORPH_TRACE__: {
            clear: () => undefined,
            count: () => 1,
            download: () => null,
            text: () =>
              [
                JSON.stringify({
                  source: "torph",
                  event: "effect:frame-snapshot",
                  payload: {
                    debugLabel: "playlist-title",
                  },
                }),
                "",
              ].join("\n"),
          },
        },
      });

      assert.deepEqual(readTorphLibraryTraceEntries(), [
        {
          source: "torph",
          event: "effect:frame-snapshot",
          payload: {
            debugLabel: "playlist-title",
          },
        },
      ]);
    } finally {
      if (previousWindowDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        Object.defineProperty(globalThis, "window", previousWindowDescriptor);
      }
    }
  });

  test("ignores malformed Torph library trace lines", () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          __TORPH_TRACE__: {
            clear: () => undefined,
            count: () => 1,
            download: () => null,
            text: () =>
              [
                "{",
                JSON.stringify({
                  source: "torph",
                  event: "effect:trace-meta",
                }),
                "",
              ].join("\n"),
          },
        },
      });

      assert.deepEqual(readTorphLibraryTraceEntries(), [
        {
          source: "torph",
          event: "effect:trace-meta",
        },
      ]);
    } finally {
      if (previousWindowDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        Object.defineProperty(globalThis, "window", previousWindowDescriptor);
      }
    }
  });
});
