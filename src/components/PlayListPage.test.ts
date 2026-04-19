import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolvePlayListPageItemFadeProps,
  shouldEnablePlayListPageTitleShare,
  shouldCommitPlayListPageItem,
  shouldRenderPlayListPageContent,
} from "./PlayListPage";

describe("PlayListPage", () => {
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

  test("enables title share only after the playlist page is ready to hand off titles", () => {
    assert.equal(shouldEnablePlayListPageTitleShare("idle"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("loading"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("ready"), true);
    assert.equal(shouldEnablePlayListPageTitleShare("play"), true);
    assert.equal(shouldEnablePlayListPageTitleShare("config"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("configLoading"), false);
    assert.equal(
      shouldEnablePlayListPageTitleShare("configUpdatingCollectionUpdates"),
      false,
    );
    assert.equal(shouldEnablePlayListPageTitleShare("error"), false);
  });

  test("hides playlist content before bootstrap resolves but keeps real page snapshots renderable", () => {
    assert.equal(
      shouldRenderPlayListPageContent({
        hasPlayList: null,
        visiblePlaylistCount: 0,
        hasPendingPreview: false,
        hasActiveLayoutId: false,
        hasTitleToneHandoff: false,
      }),
      false,
    );
    assert.equal(
      shouldRenderPlayListPageContent({
        hasPlayList: false,
        visiblePlaylistCount: 0,
        hasPendingPreview: false,
        hasActiveLayoutId: false,
        hasTitleToneHandoff: false,
      }),
      true,
    );
    assert.equal(
      shouldRenderPlayListPageContent({
        hasPlayList: null,
        visiblePlaylistCount: 0,
        hasPendingPreview: false,
        hasActiveLayoutId: true,
        hasTitleToneHandoff: false,
      }),
      true,
    );
  });
});
