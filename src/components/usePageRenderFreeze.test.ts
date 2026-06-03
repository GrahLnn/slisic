import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolvePageRenderFreezeValue } from "./usePageRenderFreeze";

describe("page render freeze", () => {
  test("uses the explicit frozen value until the owner releases the page", () => {
    assert.deepEqual(
      resolvePageRenderFreezeValue({
        freezeOnExit: false,
        frozenValue: { page: "config", title: "Frozen" },
        isPresent: true,
        lastLiveValue: { page: "config", title: "Previous" },
        liveValue: { page: "ready", title: "Live" },
      }),
      {
        isFrozen: true,
        renderValue: { page: "config", title: "Frozen" },
      },
    );
  });

  test("uses the last live value while an exiting page has no explicit freeze", () => {
    assert.deepEqual(
      resolvePageRenderFreezeValue({
        freezeOnExit: true,
        frozenValue: null,
        isPresent: false,
        lastLiveValue: { page: "spectrum", title: "Stable" },
        liveValue: { page: "ready", title: "Next" },
      }),
      {
        isFrozen: false,
        renderValue: { page: "spectrum", title: "Stable" },
      },
    );
  });

  test("uses live value when exit freezing is not part of the contract", () => {
    assert.deepEqual(
      resolvePageRenderFreezeValue({
        freezeOnExit: false,
        frozenValue: null,
        isPresent: false,
        lastLiveValue: { page: "play", title: "Previous" },
        liveValue: { page: "ready", title: "Live" },
      }),
      {
        isFrozen: false,
        renderValue: { page: "ready", title: "Live" },
      },
    );
  });
});
