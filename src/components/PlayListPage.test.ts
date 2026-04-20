import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolvePlayListPageItemFadeProps,
  resolvePlayListPageViewModel,
  shouldEnablePlayListPageTitleShare,
  shouldCommitPlayListPageItem,
  shouldRenderPlayListPageContent,
} from "./PlayListPage.view-model";

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
        exit: { opacity: 1 },
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
        exit: { opacity: 0 },
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

  test("projects play mode into a centered playback item and hides the list rail", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        {
          name: "Quiet Morning",
          collections: [],
          groups: [],
        },
      ],
      pendingPlaylistPreview: null,
      titleToneHandoff: null,
      pressedLayoutId: null,
      playingPlaylistName: "Quiet Morning",
      nowPlayingTrackName: "Track A",
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.deepEqual(viewModel.itemViewModels, []);
    assert.equal(viewModel.shouldShowCreateItem, false);
    assert.deepEqual(viewModel.playbackItemViewModel, {
      key: "Quiet Morning",
      text: "Track A",
      layoutId: "playlist-title:Quiet Morning",
      handoffTone: null,
      suppressFade: true,
      isCommitted: false,
      commitGesture: "secondary-only",
      playlistName: "Quiet Morning",
    });
  });

  test("falls back to the normal list when the playing playlist snapshot is missing", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        {
          name: "Quiet Morning",
          collections: [],
          groups: [],
        },
      ],
      pendingPlaylistPreview: null,
      titleToneHandoff: null,
      pressedLayoutId: null,
      playingPlaylistName: "Missing",
      nowPlayingTrackName: "Track A",
    });

    assert.equal(viewModel.shouldLockScroll, false);
    assert.equal(viewModel.itemViewModels.length, 1);
    assert.equal(viewModel.playbackItemViewModel, null);
    assert.equal(viewModel.shouldShowCreateItem, true);
  });
});
