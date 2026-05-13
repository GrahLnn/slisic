import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PlayList } from "@/src/cmd";
import {
  resolvePlayListPageItemFadeProps,
  resolvePlayListPageViewModel,
  shouldEnablePlayListPageTitleShare,
  shouldFallbackPrimaryCommitOnClick,
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

  test("uses click for primary playback only as a non-pointer activation fallback", () => {
    assert.equal(
      shouldFallbackPrimaryCommitOnClick({
        eventDetail: 1,
      }),
      false,
    );
    assert.equal(
      shouldFallbackPrimaryCommitOnClick({
        eventDetail: 0,
      }),
      true,
    );
  });

  test("enables title share only after the playlist page is ready to hand off titles", () => {
    assert.equal(shouldEnablePlayListPageTitleShare("idle"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("loading"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("ready"), true);
    assert.equal(shouldEnablePlayListPageTitleShare("play"), true);
    assert.equal(shouldEnablePlayListPageTitleShare("spectrumLoadingMusics"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("spectrum"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("spectrumUpdatingMusic"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("spectrumDeletingMusic"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("config"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("configLoading"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("configUpdatingCollectionUpdates"), false);
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
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track A",
        displayedTrackIsPlayable: true,
      },
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.deepEqual(viewModel.itemViewModels, [
      {
        key: "Night Drive",
        text: "Night Drive",
        layoutId: "playlist-title:Night Drive",
        sourceLayoutId: "playlist-title:Night Drive",
        handoffTone: null,
        suppressFade: false,
        isPlaybackTarget: false,
        shouldShowPlaybackIcons: false,
        isPlaybackPreparing: false,
        isHiddenInPlay: true,
        shouldStartHiddenInPlay: false,
        shouldAnimateSlotPosition: false,
        titleHoverVisual: "none",
        commitGesture: "disabled",
        playlistName: "Night Drive",
      },
      {
        key: "Quiet Morning",
        text: "Track A",
        layoutId: undefined,
        sourceLayoutId: "playlist-title:Quiet Morning",
        handoffTone: null,
        suppressFade: true,
        isPlaybackTarget: true,
        shouldShowPlaybackIcons: true,
        playbackIconWidthText: "Track A",
        isPlaybackPreparing: false,
        isHiddenInPlay: false,
        shouldStartHiddenInPlay: false,
        shouldAnimateSlotPosition: false,
        titleHoverVisual: "none",
        commitGesture: "disabled",
        playlistName: "Quiet Morning",
      },
    ]);
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, false);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, true);
    assert.equal(viewModel.createItemViewModel.shouldStartHiddenInPlay, false);
  });

  test("falls back to the normal list when the playing playlist snapshot is missing", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],
      pendingPlaylistPreview: null,
      playingPlaylistName: null,
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Missing",
        displayedTrackName: "Track A",
        displayedTrackIsPlayable: true,
      },
    });

    assert.equal(viewModel.shouldLockScroll, false);
    assert.equal(viewModel.playbackTargetKey, null);
    assert.equal(viewModel.itemViewModels.length, 1);
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, true);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, false);
  });

  test("keeps the normal ready to play container path before the playback surface syncs", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Night Drive" }),
        createPlayListFixture({ name: "Quiet Morning" }),
      ],
      pendingPlaylistPreview: null,
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, false);
    assert.equal(viewModel.playbackTargetKey, null);
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, true);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, false);
    assert.deepEqual(
      viewModel.itemViewModels.map((item) => ({
        key: item.key,
        layoutId: item.layoutId,
        isPlaybackTarget: item.isPlaybackTarget,
        isHiddenInPlay: item.isHiddenInPlay,
        shouldStartHiddenInPlay: item.shouldStartHiddenInPlay,
      })),
      [
        {
          key: "Night Drive",
          layoutId: "playlist-title:Night Drive",
          isPlaybackTarget: false,
          isHiddenInPlay: false,
          shouldStartHiddenInPlay: false,
        },
        {
          key: "Quiet Morning",
          layoutId: "playlist-title:Quiet Morning",
          isPlaybackTarget: false,
          isHiddenInPlay: false,
          shouldStartHiddenInPlay: false,
        },
      ],
    );
  });

  test("locks the playback target immediately before the first track is known", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],
      pendingPlaylistPreview: null,
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
        displayedTrackIsPlayable: false,
      },
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.text, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.layoutId, undefined);
    assert.equal(viewModel.itemViewModels[0]?.sourceLayoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.shouldAnimateSlotPosition, false);
    assert.equal(viewModel.itemViewModels[0]?.shouldShowPlaybackIcons, false);
    assert.equal(viewModel.itemViewModels[0]?.playbackIconWidthText, undefined);
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, false);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, true);
  });

  test("uses the playback status text while waiting for the first track", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],
      pendingPlaylistPreview: null,
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Preparing...",
        displayedTrackIsPlayable: false,
      },
    });

    assert.equal(viewModel.itemViewModels[0]?.text, "Preparing...");
    assert.equal(viewModel.itemViewModels[0]?.layoutId, undefined);
    assert.equal(viewModel.itemViewModels[0]?.sourceLayoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.shouldShowPlaybackIcons, true);
    assert.equal(viewModel.itemViewModels[0]?.playbackIconWidthText, "Preparing...");
    assert.equal(viewModel.itemViewModels[0]?.isPlaybackPreparing, true);
    assert.equal(viewModel.shouldLockScroll, true);
  });

  test("keeps the playback target title shareable when opening spectrum", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],
      pendingPlaylistPreview: null,
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: "playlist-title:Quiet Morning",
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track A",
        displayedTrackIsPlayable: true,
      },
    });

    assert.equal(viewModel.itemViewModels[0]?.layoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.sourceLayoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.text, "Track A");
    assert.equal(viewModel.itemViewModels[0]?.shouldShowPlaybackIcons, true);
    assert.equal(viewModel.itemViewModels[0]?.titleHoverVisual, "none");
  });

  test("locks the list while returning from spectrum before playback surface restores", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Night Drive" }),
        createPlayListFixture({ name: "Quiet Morning" }),
      ],
      pendingPlaylistPreview: null,
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: {
        layoutId: "playlist-title:Quiet Morning",
        tone: "solid",
      },
      pressedLayoutId: null,
      playbackSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, false);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, true);
    assert.equal(viewModel.createItemViewModel.shouldStartHiddenInPlay, true);
    assert.equal(viewModel.itemViewModels.length, 2);
    assert.deepEqual(
      viewModel.itemViewModels.map((item) => ({
        key: item.key,
        text: item.text,
        layoutId: item.layoutId,
        sourceLayoutId: item.sourceLayoutId,
        isPlaybackTarget: item.isPlaybackTarget,
        isHiddenInPlay: item.isHiddenInPlay,
        shouldStartHiddenInPlay: item.shouldStartHiddenInPlay,
        shouldShowPlaybackIcons: item.shouldShowPlaybackIcons,
        titleHoverVisual: item.titleHoverVisual,
      })),
      [
        {
          key: "Night Drive",
          text: "Night Drive",
          layoutId: "playlist-title:Night Drive",
          sourceLayoutId: "playlist-title:Night Drive",
          isPlaybackTarget: false,
          isHiddenInPlay: true,
          shouldStartHiddenInPlay: true,
          shouldShowPlaybackIcons: false,
          titleHoverVisual: "none",
        },
        {
          key: "Quiet Morning",
          text: "Quiet Morning",
          layoutId: "playlist-title:Quiet Morning",
          sourceLayoutId: "playlist-title:Quiet Morning",
          isPlaybackTarget: false,
          isHiddenInPlay: false,
          shouldStartHiddenInPlay: false,
          shouldShowPlaybackIcons: false,
          titleHoverVisual: "retain",
        },
      ],
    );
  });

  test("keeps the playback surface locked while restoring the original playlist title", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "ready",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],
      pendingPlaylistPreview: null,
      playingPlaylistName: null,
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "restoring",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
        displayedTrackIsPlayable: false,
      },
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.text, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.layoutId, undefined);
    assert.equal(viewModel.itemViewModels[0]?.sourceLayoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.shouldAnimateSlotPosition, false);
    assert.equal(viewModel.itemViewModels[0]?.shouldShowPlaybackIcons, false);
    assert.equal(viewModel.itemViewModels[0]?.playbackIconWidthText, undefined);
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, false);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, true);
  });
});
