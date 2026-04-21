import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveGhostCloneContentDisplay } from "./ListConfig.ghost-dom";

describe("ListConfig ghost DOM", () => {
  test("blockifies inline displays once the clone leaves text flow", () => {
    assert.equal(resolveGhostCloneContentDisplay("inline"), "block");
    assert.equal(resolveGhostCloneContentDisplay("inline-block"), "block");
    assert.equal(resolveGhostCloneContentDisplay("inline-flex"), "flex");
    assert.equal(resolveGhostCloneContentDisplay("inline-grid"), "grid");
    assert.equal(resolveGhostCloneContentDisplay("inline-table"), "table");
  });

  test("keeps already block-level displays unchanged", () => {
    assert.equal(resolveGhostCloneContentDisplay("block"), "block");
    assert.equal(resolveGhostCloneContentDisplay("flex"), "flex");
    assert.equal(resolveGhostCloneContentDisplay("grid"), "grid");
  });
});
