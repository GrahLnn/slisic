import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  INACTIVE_TITLE_RETURN_SURFACE,
  resolvePlayListTitleReturnSurfaceAfterLayoutComplete,
  resolvePlayListTitleReturnSurfaceSnapshot,
  resolvePlayListTitleReturnSurfaceState,
} from "./playListTitleReturnSurface.model";

describe("playListTitleReturnSurface model", () => {
  test("keeps state idle for a new title handoff target until it is consumed", () => {
    assert.deepEqual(
      resolvePlayListTitleReturnSurfaceState({
        targetLayoutId: "playlist-title:Quiet Morning",
        consumedLayoutId: null,
      }),
      {
        consumedLayoutId: null,
      },
    );
  });

  test("does not restart a consumed handoff while the same target remains in context", () => {
    const consumed = resolvePlayListTitleReturnSurfaceAfterLayoutComplete({
      current: {
        consumedLayoutId: null,
      },
      targetLayoutId: "playlist-title:Quiet Morning",
      layoutId: "playlist-title:Quiet Morning",
    });

    assert.deepEqual(consumed, {
      consumedLayoutId: "playlist-title:Quiet Morning",
    });
    assert.deepEqual(
      resolvePlayListTitleReturnSurfaceState({
        targetLayoutId: "playlist-title:Quiet Morning",
        consumedLayoutId: consumed.consumedLayoutId,
      }),
      consumed,
    );
  });

  test("clears consumed memory when there is no handoff target", () => {
    assert.deepEqual(
      resolvePlayListTitleReturnSurfaceState({
        targetLayoutId: null,
        consumedLayoutId: "playlist-title:Quiet Morning",
      }),
      INACTIVE_TITLE_RETURN_SURFACE,
    );
  });

  test("scopes consumed evidence to the active target context", () => {
    const consumed = resolvePlayListTitleReturnSurfaceAfterLayoutComplete({
      current: INACTIVE_TITLE_RETURN_SURFACE,
      targetLayoutId: "playlist-title:Quiet Morning",
      layoutId: "playlist-title:Quiet Morning",
    });
    const inactive = resolvePlayListTitleReturnSurfaceState({
      targetLayoutId: null,
      consumedLayoutId: consumed.consumedLayoutId,
    });

    assert.deepEqual(inactive, INACTIVE_TITLE_RETURN_SURFACE);
    assert.deepEqual(
      resolvePlayListTitleReturnSurfaceSnapshot({
        targetLayoutId: "playlist-title:Quiet Morning",
        state: inactive,
      }),
      {
        layoutId: "playlist-title:Quiet Morning",
      },
    );
  });

  test("derives active snapshots from target and consumed evidence", () => {
    assert.deepEqual(
      resolvePlayListTitleReturnSurfaceSnapshot({
        targetLayoutId: "playlist-title:Quiet Morning",
        state: INACTIVE_TITLE_RETURN_SURFACE,
      }),
      {
        layoutId: "playlist-title:Quiet Morning",
      },
    );
    assert.equal(
      resolvePlayListTitleReturnSurfaceSnapshot({
        targetLayoutId: "playlist-title:Quiet Morning",
        state: {
          consumedLayoutId: "playlist-title:Quiet Morning",
        },
      }),
      null,
    );
  });
});
