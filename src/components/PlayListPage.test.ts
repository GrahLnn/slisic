import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PlayList } from "@/src/cmd";
import {
  resolvePlayListPageItemFadeProps,
  resolvePlayListPageViewModel,
  shouldEnablePlayListPageTitleShare,
  shouldCommitPlayListPageItem,
  shouldRenderPlayListPageContent,
} from "./PlayListPage.view-model";

function createPlayListFixture(args: {
  name: string;
  collections?: PlayList["collections"];
  groups?: PlayList["groups"];
  created_at?: PlayList["created_at"];
}): PlayList {
  return {
    name: args.name,
    collections: args.collections ?? [],
    groups: args.groups ?? [],
    created_at: args.created_at ?? "2026-04-13T00:00:00Z",
  };
}

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

  test("disables config commits when the item gesture is disabled", () => {
    assert.equal(
      shouldCommitPlayListPageItem({
        button: 0,
        gesture: "disabled",
      }),
      false,
    );
    assert.equal(
      shouldCommitPlayListPageItem({
        button: 2,
        gesture: "disabled",
      }),
      false,
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

  test("keeps the playing playlist in the same item slot, swaps only its text, and hides siblings", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Night Drive" }),
        createPlayListFixture({ name: "Quiet Morning" }),
      ],
      pendingPlaylistPreview: null,
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track A",
      },
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.deepEqual(viewModel.itemViewModels, [
      {
        key: "Night Drive",
        text: "Night Drive",
        layoutId: "playlist-title:Night Drive",
        handoffTone: null,
        suppressFade: false,
        isPlaybackTarget: false,
        isHiddenInPlay: true,
        shouldAnimateSlotPosition: false,
        isCommitted: false,
        commitGesture: "disabled",
        playlistName: "Night Drive",
      },
      {
        key: "Quiet Morning",
        text: "Track A",
        layoutId: "playlist-title:Quiet Morning",
        handoffTone: null,
        suppressFade: true,
        isPlaybackTarget: true,
        isHiddenInPlay: false,
        shouldAnimateSlotPosition: false,
        isCommitted: false,
        commitGesture: "disabled",
        playlistName: "Quiet Morning",
      },
    ]);
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, false);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, true);
  });

  test("falls back to the normal list when the playing playlist snapshot is missing", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Quiet Morning" }),
      ],
      pendingPlaylistPreview: null,
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Missing",
        displayedTrackName: "Track A",
      },
    });

    assert.equal(viewModel.shouldLockScroll, false);
    assert.equal(viewModel.playbackTargetKey, null);
    assert.equal(viewModel.itemViewModels.length, 1);
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, true);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, false);
  });

  test("keeps the playlist title until the playback surface finishes centering", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Quiet Morning" }),
      ],
      pendingPlaylistPreview: null,
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "centering",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
      },
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.text, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.shouldAnimateSlotPosition, false);
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, false);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, true);
  });

  test("keeps the playback surface locked while restoring the original playlist title", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "ready",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Quiet Morning" }),
      ],
      pendingPlaylistPreview: null,
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "restoring",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
      },
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.text, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.shouldAnimateSlotPosition, false);
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, false);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, true);
  });
});
