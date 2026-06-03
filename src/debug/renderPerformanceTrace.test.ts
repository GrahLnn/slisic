import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveRenderPerformanceTraceProbe,
  shouldRecordRenderPerformanceTraceEvent,
  type RenderPerformanceTraceProbe,
} from "./renderPerformanceTrace";

describe("render performance trace registry", () => {
  test("resolves registered events to their probe owner", () => {
    assert.equal(
      resolveRenderPerformanceTraceProbe("playlist-page-projection"),
      "playlist-page",
    );
    assert.equal(
      resolveRenderPerformanceTraceProbe("playlist-play-action-start"),
      "playlist-playback",
    );
    assert.equal(
      resolveRenderPerformanceTraceProbe("list-config-check-clicked"),
      "list-config-check",
    );
    assert.equal(resolveRenderPerformanceTraceProbe("unknown-debug-event"), null);
  });

  test("records only events owned by enabled probes", () => {
    const enabled = new Set<RenderPerformanceTraceProbe>(["playlist-playback"]);

    assert.equal(
      shouldRecordRenderPerformanceTraceEvent({
        enabled,
        event: "playlist-play-action-start",
      }),
      true,
    );
    assert.equal(
      shouldRecordRenderPerformanceTraceEvent({
        enabled,
        event: "playlist-page-projection",
      }),
      false,
    );
    assert.equal(
      shouldRecordRenderPerformanceTraceEvent({
        enabled,
        event: "unknown-debug-event",
      }),
      false,
    );
  });
});
