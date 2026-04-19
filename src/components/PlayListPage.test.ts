import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolvePlayListPageCommittedLayoutId,
  resolvePlayListPageTransitionViewModel,
  shouldSuppressPlayListPageItemFade,
} from "./PlayListPage.view-model";
import { resolvePlayListPageItemFadeProps } from "./PlayListPage";

describe("PlayListPage transition view model", () => {
  test("treats config-entering states as an outgoing source transition only", () => {
    const transition = resolvePlayListPageTransitionViewModel({
      activeLayoutId: "playlist-title:PlayList 1",
      titleToneHandoff: {
        layoutId: "playlist-title:PlayList 1",
        tone: "solid",
      },
    });

    assert.deepEqual(transition, {
      outgoingSourceLayoutId: "playlist-title:PlayList 1",
      returnTargetLayoutId: null,
    });
    assert.equal(
      shouldSuppressPlayListPageItemFade(
        "playlist-title:PlayList 1",
        transition,
      ),
      true,
    );
    assert.equal(
      shouldSuppressPlayListPageItemFade("collection-title:create", transition),
      false,
    );
  });

  test("treats ready state handoff as a returning target only", () => {
    const transition = resolvePlayListPageTransitionViewModel({
      activeLayoutId: null,
      titleToneHandoff: {
        layoutId: "playlist-title:PlayList 1",
        tone: "solid",
      },
    });

    assert.deepEqual(transition, {
      outgoingSourceLayoutId: null,
      returnTargetLayoutId: "playlist-title:PlayList 1",
    });
    assert.equal(
      shouldSuppressPlayListPageItemFade(
        "playlist-title:PlayList 1",
        transition,
      ),
      true,
    );
    assert.equal(
      shouldSuppressPlayListPageItemFade("collection-title:create", transition),
      false,
    );
  });

  test("lets the fresh click source dominate over any prior return target memory", () => {
    const transition = resolvePlayListPageTransitionViewModel({
      activeLayoutId: null,
      titleToneHandoff: {
        layoutId: "playlist-title:PlayList 1",
        tone: "solid",
      },
    });

    assert.equal(
      resolvePlayListPageCommittedLayoutId({
        pressedLayoutId: "collection-title:create",
        transition,
      }),
      "collection-title:create",
    );
  });

  test("keeps a stable fade host while suppressing opacity changes for shared items", () => {
    assert.deepEqual(
      resolvePlayListPageItemFadeProps({
        isPresent: false,
        suppressFade: true,
      }),
      {
        initial: { opacity: 1 },
        animate: { opacity: 1 },
      },
    );
    assert.deepEqual(
      resolvePlayListPageItemFadeProps({
        isPresent: false,
        suppressFade: false,
      }),
      {
        initial: { opacity: 0 },
        animate: { opacity: 0 },
      },
    );
  });
});
