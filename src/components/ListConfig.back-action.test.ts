import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveBackActionVisualState } from "./ListConfig.back-action";

describe("ListConfig back action visuals", () => {
  test("keeps processing isolated from draft changes", () => {
    assert.deepEqual(
      resolveBackActionVisualState({
        hasDraftChanges: true,
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
      isParsing: false,
    });
    const after = resolveBackActionVisualState({
      hasDraftChanges: true,
      isParsing: false,
    });

    assert.equal(before.kind, "check");
    assert.equal(after.kind, "check");
    assert.equal(before.key, after.key);
  });

  test("switches symbol kinds when draft cleanliness changes", () => {
    const clean = resolveBackActionVisualState({
      hasDraftChanges: false,
      isParsing: false,
    });
    const dirty = resolveBackActionVisualState({
      hasDraftChanges: true,
      isParsing: false,
    });

    assert.equal(clean.kind, "back");
    assert.equal(dirty.kind, "check");
    assert.notEqual(clean.key, dirty.key);
  });
});
