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
  extra?: PlayList["extra"];
  created_at?: PlayList["created_at"];
}): PlayList {
  return {
    name: args.name,
    collections: args.collections ?? [],
    groups: args.groups ?? [],
    extra: args.extra ?? [],
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

  test("shows pending playlist previews with the same visible item behavior as stable playlists", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "ready",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],
      pendingPlaylistPreview: {
        playlist: createPlayListFixture({
          name: "PlayList 3",
          created_at: null,
        }),
        previousName: null,
        draft: {
          mode: "create",
          name: "PlayList 3",
          collections: [],
          groups: [],
          extra: [],
          createdAt: null,
        },
      },
      playingPlaylistName: null,
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: null,
      titleReturnSurface: null,
    });

    const pendingItem = viewModel.itemViewModels.find((item) => item.key === "PlayList 3");

    assert.deepEqual(pendingItem, {
      key: "PlayList 3",
      text: "PlayList 3",
      layoutId: "playlist-title:PlayList 3",
      sourceLayoutId: "playlist-title:PlayList 3",
      handoffTone: null,
      suppressFade: false,
      isPlaybackTarget: false,
      shouldShowPlaybackIcons: false,
      isCurrentMusicLiked: false,
      isPlaybackPreparing: false,
      isHiddenInPlay: false,
      shouldStartHiddenInPlay: false,
      shouldAnimateSlotPosition: true,
      titleHoverVisual: "none",
      titleHoverRetainLease: "timed",
      commitGesture: "secondary-only",
      playlistName: "PlayList 3",
    });
    assert.deepEqual(
      viewModel.itemViewModels.map((item) => item.playlistName),
      ["Quiet Morning", "PlayList 3"],
    );
  });

  test("enables title share only after the playlist page is ready to hand off titles", () => {
    assert.equal(shouldEnablePlayListPageTitleShare("idle"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("loading"), false);
    assert.equal(shouldEnablePlayListPageTitleShare("ready"), true);
    assert.equal(shouldEnablePlayListPageTitleShare("play"), true);
    assert.equal(shouldEnablePlayListPageTitleShare("spectrum"), false);
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
    assert.equal(
      shouldRenderPlayListPageContent({
        hasPlayList: null,
        visiblePlaylistCount: 0,
        hasPendingPreview: true,
        hasActiveLayoutId: false,
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

      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track A",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: true,
      },
      titleReturnSurface: null,
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
        isCurrentMusicLiked: false,
        isPlaybackPreparing: false,
        isHiddenInPlay: true,
        shouldStartHiddenInPlay: false,
        shouldAnimateSlotPosition: false,
        titleHoverVisual: "none",
        titleHoverRetainLease: "timed",
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
        isCurrentMusicLiked: false,
        playbackIconWidthText: "Track A",
        isPlaybackPreparing: false,
        isHiddenInPlay: false,
        shouldStartHiddenInPlay: false,
        shouldAnimateSlotPosition: false,
        titleHoverVisual: "none",
        titleHoverRetainLease: "timed",
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

      playingPlaylistName: null,
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Missing",
        displayedTrackName: "Track A",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: true,
      },
      titleReturnSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, false);
    assert.equal(viewModel.playbackTargetKey, null);
    assert.equal(viewModel.itemViewModels.length, 1);
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, true);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, false);
  });

  test("locks the opening playback target before the playback surface syncs", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Night Drive" }),
        createPlayListFixture({ name: "Quiet Morning" }),
      ],

      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: null,
      titleReturnSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, false);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, true);
    assert.deepEqual(
      viewModel.itemViewModels.map((item) => ({
        key: item.key,
        layoutId: item.layoutId,
        isPlaybackTarget: item.isPlaybackTarget,
        isHiddenInPlay: item.isHiddenInPlay,
        shouldStartHiddenInPlay: item.shouldStartHiddenInPlay,
        titleHoverVisual: item.titleHoverVisual,
      })),
      [
        {
          key: "Night Drive",
          layoutId: "playlist-title:Night Drive",
          isPlaybackTarget: false,
          isHiddenInPlay: true,
          shouldStartHiddenInPlay: false,
          titleHoverVisual: "none",
        },
        {
          key: "Quiet Morning",
          layoutId: "playlist-title:Quiet Morning",
          isPlaybackTarget: false,
          isHiddenInPlay: false,
          shouldStartHiddenInPlay: false,
          titleHoverVisual: "retain",
        },
      ],
    );
  });

  test("marks the pressed playlist title as the immediate source handoff before play starts", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "ready",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Night Drive" }),
        createPlayListFixture({ name: "Quiet Morning" }),
      ],

      playingPlaylistName: null,
      titleToneHandoff: null,
      pressedLayoutId: "playlist-title:Quiet Morning",
      playbackSurface: null,
      titleReturnSurface: null,
    });

    assert.equal(viewModel.committedLayoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[1]?.layoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[1]?.titleHoverVisual, "hold");
    assert.equal(viewModel.itemViewModels[0]?.titleHoverVisual, "none");
  });

  test("projects a ready starting playback request as immediate preparation", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "ready",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Night Drive" }),
        createPlayListFixture({ name: "Quiet Morning" }),
      ],
      pendingPlaylistPlaybackRequest: {
        error: null,
        phase: "starting",
        playlistName: "Quiet Morning",
        reason: null,
        requestId: 1,
      },
      playingPlaylistName: null,
      titleToneHandoff: null,
      pressedLayoutId: "playlist-title:Quiet Morning",
      playbackSurface: null,
      titleReturnSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[1]?.text, "Preparing...");
    assert.equal(viewModel.itemViewModels[1]?.isPlaybackTarget, true);
    assert.equal(viewModel.itemViewModels[1]?.isPlaybackPreparing, true);
    assert.equal(viewModel.itemViewModels[1]?.shouldShowPlaybackIcons, false);
    assert.equal(viewModel.itemViewModels[1]?.playbackIconWidthText, "Preparing...");
    assert.equal(viewModel.itemViewModels[1]?.commitGesture, "disabled");
    assert.equal(viewModel.itemViewModels[1]?.titleHoverVisual, "retain");
    assert.equal(viewModel.itemViewModels[0]?.isHiddenInPlay, true);
  });

  test("projects pending first-track playback as preparing instead of a stuck title press", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "ready",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Night Drive" }),
        createPlayListFixture({ name: "Quiet Morning" }),
      ],
      pendingPlaylistPlaybackRequest: {
        error: null,
        phase: "preparing",
        playlistName: "Quiet Morning",
        reason: "pending_first_track",
        requestId: 1,
      },
      playingPlaylistName: null,
      titleToneHandoff: null,
      pressedLayoutId: "playlist-title:Quiet Morning",
      playbackSurface: null,
      titleReturnSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.shouldShowCreateItem, false);
    assert.equal(viewModel.itemViewModels[1]?.text, "Preparing...");
    assert.equal(viewModel.itemViewModels[1]?.isPlaybackTarget, true);
    assert.equal(viewModel.itemViewModels[1]?.isPlaybackPreparing, true);
    assert.equal(viewModel.itemViewModels[1]?.shouldShowPlaybackIcons, false);
    assert.equal(viewModel.itemViewModels[1]?.commitGesture, "disabled");
    assert.equal(viewModel.itemViewModels[1]?.titleHoverVisual, "retain");
    assert.equal(viewModel.itemViewModels[0]?.isHiddenInPlay, true);
  });

  test("locks the playback target immediately before the first track is known", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],

      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
      titleReturnSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.text, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.layoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.sourceLayoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.titleHoverVisual, "retain");
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

      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Preparing...",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
      titleReturnSurface: null,
    });

    assert.equal(viewModel.itemViewModels[0]?.text, "Preparing...");
    assert.equal(viewModel.itemViewModels[0]?.layoutId, undefined);
    assert.equal(viewModel.itemViewModels[0]?.sourceLayoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.titleHoverVisual, "none");
    assert.equal(viewModel.itemViewModels[0]?.shouldShowPlaybackIcons, true);
    assert.equal(viewModel.itemViewModels[0]?.playbackIconWidthText, "Preparing...");
    assert.equal(viewModel.itemViewModels[0]?.isPlaybackPreparing, true);
    assert.equal(viewModel.shouldLockScroll, true);
  });

  test("keeps pending first-track text above an empty playback surface", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],
      pendingPlaylistPlaybackRequest: {
        error: null,
        phase: "preparing",
        playlistName: "Quiet Morning",
        reason: "pending_first_track",
        requestId: 1,
      },
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
      titleReturnSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.text, "Preparing...");
    assert.equal(viewModel.itemViewModels[0]?.isPlaybackTarget, true);
    assert.equal(viewModel.itemViewModels[0]?.isPlaybackPreparing, true);
    assert.equal(viewModel.itemViewModels[0]?.shouldShowPlaybackIcons, false);
    assert.equal(viewModel.itemViewModels[0]?.playbackIconWidthText, "Preparing...");
  });

  test("projects starting play-state playback as preparing until the first track arrives", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],
      pendingPlaylistPlaybackRequest: {
        error: null,
        phase: "starting",
        playlistName: "Quiet Morning",
        reason: null,
        requestId: 1,
      },
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
      titleReturnSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.text, "Preparing...");
    assert.equal(viewModel.itemViewModels[0]?.isPlaybackPreparing, true);
    assert.equal(viewModel.itemViewModels[0]?.shouldShowPlaybackIcons, false);
    assert.equal(viewModel.itemViewModels[0]?.playbackIconWidthText, "Preparing...");
  });

  test("keeps pending first-track text above a playlist-title playback placeholder", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],
      pendingPlaylistPlaybackRequest: {
        error: null,
        phase: "preparing",
        playlistName: "Quiet Morning",
        reason: "pending_first_track",
        requestId: 1,
      },
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Quiet Morning",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
      titleReturnSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.text, "Preparing...");
    assert.equal(viewModel.itemViewModels[0]?.isPlaybackPreparing, true);
    assert.equal(viewModel.itemViewModels[0]?.shouldShowPlaybackIcons, false);
    assert.equal(viewModel.itemViewModels[0]?.playbackIconWidthText, "Preparing...");
  });

  test("lets playback track evidence replace pending first-track preparation text", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],
      pendingPlaylistPlaybackRequest: {
        error: null,
        phase: "preparing",
        playlistName: "Quiet Morning",
        reason: "pending_first_track",
        requestId: 1,
      },
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track A",
        displayedTrackLiked: true,
        displayedTrackIsPlayable: true,
      },
      titleReturnSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.text, "Track A");
    assert.equal(viewModel.itemViewModels[0]?.isPlaybackTarget, true);
    assert.equal(viewModel.itemViewModels[0]?.isPlaybackPreparing, false);
    assert.equal(viewModel.itemViewModels[0]?.shouldShowPlaybackIcons, true);
    assert.equal(viewModel.itemViewModels[0]?.isCurrentMusicLiked, true);
    assert.equal(viewModel.itemViewModels[0]?.playbackIconWidthText, "Track A");
  });

  test("keeps the playback target title shareable when opening spectrum", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],

      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      pressedLayoutId: "playlist-title:Quiet Morning",
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track A",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: true,
      },
      titleReturnSurface: null,
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

      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: {
        layoutId: "playlist-title:Quiet Morning",
        tone: "solid",
      },
      pressedLayoutId: null,
      playbackSurface: null,
      titleReturnSurface: null,
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

  test("does not retain ready return hover after the title return surface is consumed", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "ready",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Night Drive" }),
        createPlayListFixture({ name: "Quiet Morning" }),
      ],

      playingPlaylistName: null,
      titleToneHandoff: {
        layoutId: "playlist-title:Quiet Morning",
        tone: "solid",
      },
      pressedLayoutId: null,
      playbackSurface: null,
      titleReturnSurface: null,
    });

    assert.equal(viewModel.transition.returnTargetLayoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[1]?.handoffTone, "solid");
    assert.equal(viewModel.itemViewModels[1]?.titleHoverVisual, "none");
  });

  test("uses the return handoff target before the playback surface restores", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Night Drive" }),
        createPlayListFixture({ name: "Quiet Morning" }),
      ],

      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: {
        layoutId: "playlist-title:Quiet Morning",
        tone: "solid",
      },
      pressedLayoutId: null,
      playbackSurface: null,
      titleReturnSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[1]?.text, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[1]?.layoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[1]?.sourceLayoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[1]?.isPlaybackTarget, false);
    assert.equal(viewModel.itemViewModels[1]?.shouldShowPlaybackIcons, false);
    assert.equal(viewModel.itemViewModels[1]?.titleHoverVisual, "retain");
    assert.equal(viewModel.itemViewModels[1]?.titleHoverRetainLease, "stage-only");
  });

  test("lets the playback surface own track text after a spectrum return track is restored", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Night Drive" }),
        createPlayListFixture({ name: "Quiet Morning" }),
      ],

      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: {
        layoutId: "playlist-title:Quiet Morning",
        tone: "solid",
      },
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track A",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: true,
      },
      titleReturnSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[1]?.text, "Track A");
    assert.equal(viewModel.itemViewModels[1]?.layoutId, undefined);
    assert.equal(viewModel.itemViewModels[1]?.isPlaybackTarget, true);
    assert.equal(viewModel.itemViewModels[1]?.shouldShowPlaybackIcons, true);
    assert.equal(viewModel.itemViewModels[1]?.playbackIconWidthText, "Track A");
    assert.equal(viewModel.itemViewModels[1]?.titleHoverVisual, "none");
  });

  test("uses ready return handoff only as shared path evidence", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "ready",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [
        createPlayListFixture({ name: "Night Drive" }),
        createPlayListFixture({ name: "Quiet Morning" }),
      ],

      playingPlaylistName: null,
      titleToneHandoff: {
        layoutId: "playlist-title:Quiet Morning",
        tone: "solid",
      },
      pressedLayoutId: null,
      playbackSurface: null,
      titleReturnSurface: {
        layoutId: "playlist-title:Quiet Morning",
      },
    });

    assert.equal(viewModel.transition.returnTargetLayoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.shouldLockScroll, false);
    assert.equal(viewModel.playbackTargetKey, null);
    assert.equal(viewModel.shouldShowCreateItem, true);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, false);
    assert.equal(viewModel.itemViewModels[1]?.layoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[1]?.handoffTone, "solid");
    assert.equal(viewModel.itemViewModels[1]?.titleHoverVisual, "retain");
    assert.equal(viewModel.itemViewModels[1]?.titleHoverRetainLease, "stage-only");
    assert.deepEqual(
      viewModel.itemViewModels.map((item) => ({
        key: item.key,
        isHiddenInPlay: item.isHiddenInPlay,
        shouldStartHiddenInPlay: item.shouldStartHiddenInPlay,
      })),
      [
        {
          key: "Night Drive",
          isHiddenInPlay: false,
          shouldStartHiddenInPlay: false,
        },
        {
          key: "Quiet Morning",
          isHiddenInPlay: false,
          shouldStartHiddenInPlay: false,
        },
      ],
    );
  });

  test("does not let return handoff retain hover after playback track text is restored", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "play",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],

      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: {
        layoutId: "playlist-title:Quiet Morning",
        tone: "solid",
      },
      pressedLayoutId: null,
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track A",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: true,
      },
      titleReturnSurface: null,
    });

    assert.equal(viewModel.itemViewModels[0]?.text, "Track A");
    assert.equal(viewModel.itemViewModels[0]?.isPlaybackTarget, true);
    assert.equal(viewModel.itemViewModels[0]?.titleHoverVisual, "none");
  });

  test("keeps the playback surface locked while restoring the original playlist title", () => {
    const viewModel = resolvePlayListPageViewModel({
      pageState: "ready",
      activeLayoutId: null,
      hasPlayList: true,
      playlists: [createPlayListFixture({ name: "Quiet Morning" })],

      playingPlaylistName: null,
      titleToneHandoff: null,
      pressedLayoutId: null,
      playbackSurface: {
        phase: "restoring",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
      titleReturnSurface: null,
    });

    assert.equal(viewModel.shouldLockScroll, true);
    assert.equal(viewModel.playbackTargetKey, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.text, "Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.layoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.sourceLayoutId, "playlist-title:Quiet Morning");
    assert.equal(viewModel.itemViewModels[0]?.isPlaybackTarget, false);
    assert.equal(viewModel.itemViewModels[0]?.titleHoverVisual, "retain");
    assert.equal(viewModel.itemViewModels[0]?.titleHoverRetainLease, "stage-only");
    assert.equal(viewModel.itemViewModels[0]?.shouldAnimateSlotPosition, false);
    assert.equal(viewModel.itemViewModels[0]?.shouldShowPlaybackIcons, false);
    assert.equal(viewModel.itemViewModels[0]?.playbackIconWidthText, undefined);
    assert.equal(viewModel.shouldRenderCreateItem, true);
    assert.equal(viewModel.shouldShowCreateItem, false);
    assert.equal(viewModel.createItemViewModel.isHiddenInPlay, true);
  });
});
