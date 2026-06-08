import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  installTrace,
  resolveTraceProbe,
  resolveTraceProbes,
  shouldRecordTraceEvent,
  type TraceProbe,
} from "./trace";

describe("trace registry", () => {
  test("resolves registered events to their probe owner", () => {
    assert.equal(
      resolveTraceProbe("playlist-page-projection"),
      "playlist-page",
    );
    assert.equal(
      resolveTraceProbe("playlist-play-action-start"),
      "playlist-playback",
    );
    assert.equal(
      resolveTraceProbe("playlist-play-backend-start"),
      "playlist-playback",
    );
    assert.equal(
      resolveTraceProbe("player-playback-surface-status-event-received"),
      "playlist-playback",
    );
    assert.equal(
      resolveTraceProbe("playlist-playable-index-read-hit"),
      "playback-diagnostics",
    );
    assert.equal(
      resolveTraceProbe("player-range-completion"),
      "playback-diagnostics",
    );
    assert.equal(
      resolveTraceProbe("list-config-check-clicked"),
      "list-config-check",
    );
    assert.equal(
      resolveTraceProbe("config-title-check-clicked"),
      "config-title-check-flow",
    );
    assert.equal(
      resolveTraceProbe("editable-title-input-change"),
      "config-title-check-flow",
    );
    assert.equal(
      resolveTraceProbe("app-draft-name-change-requested"),
      "config-title-check-flow",
    );
    assert.equal(
      resolveTraceProbe("config-title-playlist-commit-submit-done"),
      "config-title-check-flow",
    );
    assert.equal(
      resolveTraceProbe("title-handoff-config-freeze"),
      "title-handoff-flow",
    );
    assert.equal(
      resolveTraceProbe("app-title-handoff-back-projected"),
      "title-handoff-flow",
    );
    assert.equal(resolveTraceProbe("unknown-debug-event"), null);
  });

  test("records only events owned by enabled probes", () => {
    const enabled = new Set<TraceProbe>(["playlist-playback"]);

    assert.equal(
      shouldRecordTraceEvent({
        enabled,
        event: "playlist-play-action-start",
      }),
      true,
    );
    assert.equal(
      shouldRecordTraceEvent({
        enabled,
        event: "playlist-page-projection",
      }),
      false,
    );
    assert.equal(
      shouldRecordTraceEvent({
        enabled,
        event: "unknown-debug-event",
      }),
      false,
    );
  });

  test("allows diagnostic probes to subscribe to existing event families", () => {
    assert.deepEqual(resolveTraceProbes("playlist-play-action-start"), [
      "playlist-playback",
      "playlist-item-play-flow",
    ]);
    assert.equal(
      shouldRecordTraceEvent({
        enabled: new Set<TraceProbe>(["playlist-item-play-flow"]),
        event: "playlist-play-action-start",
      }),
      true,
    );
    assert.equal(
      shouldRecordTraceEvent({
        enabled: new Set<TraceProbe>(["playlist-item-play-flow"]),
        event: "playlist-playable-index-read-hit",
      }),
      true,
    );
    assert.equal(
      shouldRecordTraceEvent({
        enabled: new Set<TraceProbe>(["playlist-item-play-flow"]),
        event: "player-range-watch-ended",
      }),
      true,
    );
  });

  test("keeps config title diagnosis separate from playback probes", () => {
    const enabled = new Set<TraceProbe>(["config-title-check-flow"]);

    assert.equal(
      shouldRecordTraceEvent({
        enabled,
        event: "config-title-check-clicked",
      }),
      true,
    );
    assert.equal(
      shouldRecordTraceEvent({
        enabled,
        event: "editable-title-input-change",
      }),
      true,
    );
    assert.equal(
      shouldRecordTraceEvent({
        enabled,
        event: "playlist-play-action-start",
      }),
      false,
    );
    assert.equal(
      shouldRecordTraceEvent({
        enabled,
        event: "playlist-item-click",
      }),
      false,
    );
  });

  test("keeps title handoff diagnosis separate from playback probes", () => {
    const enabled = new Set<TraceProbe>(["title-handoff-flow"]);

    assert.equal(
      shouldRecordTraceEvent({
        enabled,
        event: "title-handoff-ready-projection",
      }),
      true,
    );
    assert.equal(
      shouldRecordTraceEvent({
        enabled,
        event: "app-title-handoff-back-projected",
      }),
      true,
    );
    assert.equal(
      shouldRecordTraceEvent({
        enabled,
        event: "playlist-play-action-start",
      }),
      false,
    );
    assert.equal(
      shouldRecordTraceEvent({
        enabled,
        event: "config-title-check-clicked",
      }),
      false,
    );
  });

  test("exposes the generic saveTrace window API", () => {
    const previousWindow = globalThis.window;
    const legacyName = `${"render"}${"Performance"}${"Trace"}`;
    const legacyPublicName = `${"Render"}${"Performance"}${"Trace"}`;
    const legacyApiKey = `__${legacyName}Api`;
    const legacyInstalledKey = `__${legacyName}Installed`;
    const legacySaveKey = `save${legacyPublicName}`;
    const fakeWindow: {
      __traceInstalled: boolean;
      saveTrace?: () => Promise<string | null>;
      performance: { now: () => number };
      location: { href: string };
    } & Record<string, unknown> = {
      __traceInstalled: true,
      [legacyApiKey]: {},
      [legacyInstalledKey]: true,
      [legacySaveKey]: async () => "stale",
      performance: { now: () => 0 },
      location: { href: "test://trace" },
    };

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: fakeWindow,
    });

    installTrace({ enabledProbes: [] });

    assert.equal(typeof fakeWindow.saveTrace, "function");
    assert.equal(fakeWindow[legacySaveKey], undefined);
    assert.equal(fakeWindow[legacyApiKey], undefined);
    assert.equal(fakeWindow[legacyInstalledKey], undefined);

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  });
});
