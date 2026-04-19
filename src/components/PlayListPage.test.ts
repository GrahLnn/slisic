import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolvePlayListPageCommittedLayoutId,
  resolvePlayListPageTransitionViewModel,
  shouldSuppressPlayListPageItemFade,
} from "./PlayListPage.view-model";
import {
  resolvePlayListPageItemFadeProps,
  shouldCommitPlayListPageItem,
} from "./PlayListPage";

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

  test("keeps all playlist rows share-ready during config entry", () => {
    const transition = resolvePlayListPageTransitionViewModel({
      activeLayoutId: "collection-title:create",
      titleToneHandoff: null,
    });

    assert.equal(
      shouldSuppressPlayListPageItemFade("collection-title:create", transition),
      true,
    );
    assert.equal(
      shouldSuppressPlayListPageItemFade("playlist-title:PlayList 1", transition),
      false,
    );
  });

  test("keeps every item share-ready when there is no page transition", () => {
    const transition = resolvePlayListPageTransitionViewModel({
      activeLayoutId: null,
      titleToneHandoff: null,
    });

    assert.equal(
      shouldSuppressPlayListPageItemFade("playlist-title:PlayList 1", transition),
      false,
    );
    assert.equal(
      shouldSuppressPlayListPageItemFade("collection-title:create", transition),
      false,
    );
  });

  test("keeps other playlist items share-ready while returning from config", () => {
    const transition = resolvePlayListPageTransitionViewModel({
      activeLayoutId: null,
      titleToneHandoff: {
        layoutId: "playlist-title:PlayList 1",
        tone: "solid",
      },
    });

    assert.equal(
      shouldSuppressPlayListPageItemFade("playlist-title:PlayList 2", transition),
      false,
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

  test("allows create to open config from both primary and secondary clicks", () => {
    assert.equal(
      shouldCommitPlayListPageItem({
        button: 0,
        gesture: "primary-and-secondary",
      }),
      true,
    );
    assert.equal(
      shouldCommitPlayListPageItem({
        button: 2,
        gesture: "primary-and-secondary",
      }),
      true,
    );
  });

  test("allows existing playlists to open config only from secondary click", () => {
    assert.equal(
      shouldCommitPlayListPageItem({
        button: 0,
        gesture: "secondary-only",
      }),
      false,
    );
    assert.equal(
      shouldCommitPlayListPageItem({
        button: 2,
        gesture: "secondary-only",
      }),
      true,
    );
  });
});
