import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { waitForListConfigTitleShareSourceReady } from "./ListConfig";
import { resolveBackActionVisualState } from "./ListConfig.back-action";

describe("ListConfig back action visuals", () => {
  test("keeps processing isolated from draft changes", () => {
    assert.deepEqual(
      resolveBackActionVisualState({
        hasDraftChanges: true,
        isImporting: false,
        isParsing: true,
      }),
      {
        kind: "processing",
        key: "processing",
      },
    );
  });

  test("replays the check symbol when dirty draft content changes", () => {
    const before = resolveBackActionVisualState({
      hasDraftChanges: true,
      isImporting: false,
      isParsing: false,
    });
    const after = resolveBackActionVisualState({
      hasDraftChanges: true,
      isImporting: false,
      isParsing: false,
    });

    assert.equal(before.kind, "check");
    assert.equal(after.kind, "check");
    assert.equal(before.key, after.key);
  });

  test("switches symbol kinds when draft cleanliness changes", () => {
    const clean = resolveBackActionVisualState({
      hasDraftChanges: false,
      isImporting: false,
      isParsing: false,
    });
    const dirty = resolveBackActionVisualState({
      hasDraftChanges: true,
      isImporting: false,
      isParsing: false,
    });

    assert.equal(clean.kind, "back");
    assert.equal(dirty.kind, "check");
    assert.notEqual(clean.key, dirty.key);
  });

  test("uses the processing grid while local import is pending", () => {
    assert.deepEqual(
      resolveBackActionVisualState({
        hasDraftChanges: false,
        isImporting: true,
        isParsing: false,
      }),
      {
        kind: "processing",
        key: "processing",
      },
    );
  });

  test("does not let admitted download candidates keep the processing visual alive", () => {
    assert.deepEqual(
      resolveBackActionVisualState({
        hasDraftChanges: true,
        isImporting: false,
        isParsing: false,
      }),
      {
        kind: "check",
        key: "check",
      },
    );
  });

  test("waits two frames before releasing the config title return source", async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const callbacks: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as typeof globalThis.requestAnimationFrame;

    try {
      let completed = false;
      const wait = waitForListConfigTitleShareSourceReady().then(() => {
        completed = true;
      });
      await Promise.resolve();

      assert.equal(callbacks.length, 1);
      callbacks.shift()?.(0);
      await Promise.resolve();

      assert.equal(completed, false);
      assert.equal(callbacks.length, 1);
      callbacks.shift()?.(16);
      await wait;

      assert.equal(completed, true);
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });
});
