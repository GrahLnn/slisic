import assert from "node:assert/strict";
import { describe, test } from "node:test";
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
});
