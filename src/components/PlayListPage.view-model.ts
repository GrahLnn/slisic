import type { PlayList } from "@/src/cmd";
import type {
  CollectionTitleHandoff,
  CollectionTitleTone,
  PlaylistUpsertResult,
} from "@/src/flow/appLogic/core";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  playlistTitleLayoutId,
  resolvePlaylistsWithPreview,
} from "@/src/flow/appLogic/core";
import type { MainStateT } from "@/src/flow/appLogic/events";
import {
  resolveTitleShareHoverVisual,
  resolveTitleSharePageTransition,
  shouldSuppressTitleShareFade,
  type TitleShareHoverVisual,
  type TitleSharePageTransition,
} from "@/src/flow/appLogic/titleShare";
import { collectionTitleLayoutTransition } from "./collectionTitle";
import type { PlayListPlaybackSurfaceSnapshot } from "./playListPlaybackSurface.model";

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

export type PlayListPageCommitGesture = "primary-and-secondary" | "secondary-only" | "disabled";

export interface PlayListPageRenderData {
  pageState: MainStateT;
  activeLayoutId: string | null;
  hasPlayList: boolean | null;
  playlists: PlayList[];
  pendingPlaylistPreview: PlaylistUpsertResult | null;
  playingPlaylistName: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  pressedLayoutId: string | null;
  playbackSurface: PlayListPlaybackSurfaceSnapshot | null;
}

export interface PlayListPageItemViewModel {
  key: string;
  text: string;
  layoutId?: string;
  sourceLayoutId?: string;
  handoffTone: CollectionTitleTone | null;
  suppressFade: boolean;
  isPlaybackTarget: boolean;
  shouldShowPlaybackIcons: boolean;
  playbackIconWidthText?: string;
  isPlaybackPreparing: boolean;
  isHiddenInPlay: boolean;
  shouldStartHiddenInPlay: boolean;
  shouldAnimateSlotPosition: boolean;
  titleHoverVisual: TitleShareHoverVisual;
  commitGesture: PlayListPageCommitGesture;
  playlistName?: string;
}

type PlayListPageDisplayLock =
  | {
      kind: "playback-surface";
      playlistName: string;
    }
  | {
      kind: "return-handoff";
      playlistName: string;
    };

export interface PlayListPageViewModel {
  visiblePlaylists: PlayList[];
  visibleLayoutIds: string[];
  transition: TitleSharePageTransition;
  committedLayoutId: string | null;
  shouldRenderContent: boolean;
  shouldLockScroll: boolean;
  playbackTargetKey: string | null;
  itemViewModels: PlayListPageItemViewModel[];
  shouldRenderCreateItem: boolean;
  shouldShowCreateItem: boolean;
  createItemViewModel: PlayListPageItemViewModel;
}

export function shouldCommitPlayListPageItem(args: {
  button: number;
  gesture: PlayListPageCommitGesture;
}) {
  switch (args.gesture) {
    case "primary-and-secondary":
      return args.button === 0 || args.button === 2;
    case "secondary-only":
      return args.button === 2;
    case "disabled":
      return false;
  }
}

export function shouldFallbackPrimaryCommitOnClick(args: { eventDetail: number }) {
  return args.eventDetail === 0;
}

export function shouldEnablePlayListPageTitleShare(pageState: MainStateT) {
  return pageState === "ready" || pageState === "play";
}

export function shouldRenderPlayListPageContent(args: {
  hasPlayList: boolean | null;
  visiblePlaylistCount: number;
  hasPendingPreview: boolean;
  hasActiveLayoutId: boolean;
  hasTitleToneHandoff: boolean;
}) {
  return (
    args.hasPlayList !== null ||
    args.visiblePlaylistCount > 0 ||
    args.hasPendingPreview ||
    args.hasActiveLayoutId ||
    args.hasTitleToneHandoff
  );
}

export function resolvePlayListPageItemFadeProps(args: {
  isPresent: boolean;
  suppressFade: boolean;
}) {
  if (args.suppressFade) {
    return {
      initial: contentFadeProps.animate,
      animate: contentFadeProps.animate,
    } as const;
  }

  return {
    initial: contentFadeProps.initial,
    animate: args.isPresent ? contentFadeProps.animate : contentFadeProps.exit,
  } as const;
}

export function resolvePlayListPageTexts(playlists: readonly PlayList[]) {
  return playlists.map((playlist) => playlist.name);
}

function createPlayListPageItemViewModel(args: {
  playlist: PlayList;
  text: string;
  titleShareEnabled: boolean;
  transition: TitleSharePageTransition;
  titleToneHandoff: CollectionTitleHandoff | null;
  isPlaybackTarget: boolean;
  shouldShowPlaybackIcons: boolean;
  playbackIconWidthText?: string;
  isPlaybackPreparing: boolean;
  isHiddenInPlay: boolean;
  shouldStartHiddenInPlay: boolean;
  shouldAnimateSlotPosition: boolean;
  commitGesture: PlayListPageCommitGesture;
}) {
  const itemLayoutId = playlistTitleLayoutId(args.playlist.name);
  const shouldShareTitleLayout =
    args.titleShareEnabled &&
    (!args.isPlaybackTarget || args.transition.committedLayoutId === itemLayoutId);
  const titleHoverVisual = resolveTitleShareHoverVisual({
    layoutId: itemLayoutId,
    sourceLayoutId: args.transition.committedLayoutId,
    targetLayoutId: args.transition.returnTargetLayoutId,
  });

  return {
    key: args.playlist.name,
    text: args.text,
    layoutId: shouldShareTitleLayout ? itemLayoutId : undefined,
    sourceLayoutId: args.titleShareEnabled ? itemLayoutId : undefined,
    handoffTone:
      (shouldShareTitleLayout &&
        args.transition.returnTargetLayoutId === itemLayoutId &&
        args.titleToneHandoff?.tone) ||
      null,
    suppressFade:
      args.isPlaybackTarget || shouldSuppressTitleShareFade(itemLayoutId, args.transition),
    isPlaybackTarget: args.isPlaybackTarget,
    shouldShowPlaybackIcons: args.shouldShowPlaybackIcons,
    ...(args.playbackIconWidthText && { playbackIconWidthText: args.playbackIconWidthText }),
    isPlaybackPreparing: args.isPlaybackPreparing,
    isHiddenInPlay: args.isHiddenInPlay,
    shouldStartHiddenInPlay: args.shouldStartHiddenInPlay,
    shouldAnimateSlotPosition: args.shouldAnimateSlotPosition,
    titleHoverVisual:
      args.isPlaybackTarget && titleHoverVisual === "none" ? "none" : titleHoverVisual,
    commitGesture: args.commitGesture,
    playlistName: args.playlist.name,
  } satisfies PlayListPageItemViewModel;
}

function resolvePlayListPageVisibleItems(args: {
  visiblePlaylists: readonly PlayList[];
  playbackSurface: PlayListPlaybackSurfaceSnapshot | null;
  displayLock: PlayListPageDisplayLock | null;
  titleShareEnabled: boolean;
  transition: TitleSharePageTransition;
  titleToneHandoff: CollectionTitleHandoff | null;
  shouldAnimateSlotPosition: boolean;
  itemCommitGesture: PlayListPageCommitGesture;
}) {
  const playbackSurfacePlaylistName = args.playbackSurface?.playlistName;
  const playbackSurfaceTrackName = args.playbackSurface?.displayedTrackName || undefined;
  const playbackSurfaceTrackIsPlayable = args.playbackSurface?.displayedTrackIsPlayable ?? false;
  const isPlaybackSurfacePlaying = args.playbackSurface?.phase === "playing";
  const hasPlaybackTarget =
    !!playbackSurfacePlaylistName &&
    args.visiblePlaylists.some((playlist) => playlist.name === playbackSurfacePlaylistName);
  const displayLockPlaylistName = args.displayLock?.playlistName ?? null;
  const hasDisplayLockTarget =
    !!displayLockPlaylistName &&
    args.visiblePlaylists.some((playlist) => playlist.name === displayLockPlaylistName);
  const shouldStartHiddenItemsInPlay = args.displayLock?.kind === "return-handoff";

  return args.visiblePlaylists.map((playlist) =>
    createPlayListPageItemViewModel({
      playlist,
      text:
        hasPlaybackTarget && playlist.name === playbackSurfacePlaylistName
          ? playbackSurfaceTrackName || playlist.name
          : playlist.name,
      titleShareEnabled: args.titleShareEnabled,
      transition: args.transition,
      titleToneHandoff: args.titleToneHandoff,
      isPlaybackTarget: hasPlaybackTarget && playlist.name === playbackSurfacePlaylistName,
      shouldShowPlaybackIcons:
        isPlaybackSurfacePlaying &&
        hasPlaybackTarget &&
        playlist.name === playbackSurfacePlaylistName &&
        !!playbackSurfaceTrackName,
      isPlaybackPreparing:
        isPlaybackSurfacePlaying &&
        hasPlaybackTarget &&
        playlist.name === playbackSurfacePlaylistName &&
        !!playbackSurfaceTrackName &&
        !playbackSurfaceTrackIsPlayable,
      playbackIconWidthText:
        (isPlaybackSurfacePlaying &&
          playlist.name === playbackSurfacePlaylistName &&
          playbackSurfaceTrackName) ||
        undefined,
      isHiddenInPlay: hasDisplayLockTarget && playlist.name !== displayLockPlaylistName,
      shouldStartHiddenInPlay:
        shouldStartHiddenItemsInPlay && playlist.name !== displayLockPlaylistName,
      shouldAnimateSlotPosition: args.shouldAnimateSlotPosition,
      commitGesture: args.itemCommitGesture,
    }),
  );
}

function hasVisiblePlaylistName(args: {
  visiblePlaylists: readonly PlayList[];
  playlistName: string | null;
}) {
  if (!args.playlistName) {
    return false;
  }

  return args.visiblePlaylists.some((playlist) => playlist.name === args.playlistName);
}

function resolvePlayListPageReturnHandoffTargetName(args: {
  pageState: MainStateT;
  visiblePlaylists: readonly PlayList[];
  playingPlaylistName: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
}) {
  if (args.pageState !== "play" || !args.playingPlaylistName || !args.titleToneHandoff) {
    return null;
  }

  if (args.titleToneHandoff.layoutId !== playlistTitleLayoutId(args.playingPlaylistName)) {
    return null;
  }

  return hasVisiblePlaylistName({
    visiblePlaylists: args.visiblePlaylists,
    playlistName: args.playingPlaylistName,
  })
    ? args.playingPlaylistName
    : null;
}

function resolvePlayListPageDisplayLockTargetName(args: {
  pageState: MainStateT;
  visiblePlaylists: readonly PlayList[];
  playingPlaylistName: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  playbackSurface: PlayListPlaybackSurfaceSnapshot | null;
}): PlayListPageDisplayLock | null {
  const playbackSurfacePlaylistName = args.playbackSurface?.playlistName ?? null;
  if (
    playbackSurfacePlaylistName !== null &&
    hasVisiblePlaylistName({
      visiblePlaylists: args.visiblePlaylists,
      playlistName: playbackSurfacePlaylistName,
    })
  ) {
    return {
      kind: "playback-surface",
      playlistName: playbackSurfacePlaylistName,
    };
  }

  const returnHandoffPlaylistName = resolvePlayListPageReturnHandoffTargetName(args);
  return returnHandoffPlaylistName
    ? {
        kind: "return-handoff",
        playlistName: returnHandoffPlaylistName,
      }
    : null;
}

export function resolvePlayListPageViewModel(
  renderData: PlayListPageRenderData,
): PlayListPageViewModel {
  const visiblePlaylists = resolvePlaylistsWithPreview(
    renderData.playlists,
    renderData.pendingPlaylistPreview,
  );
  const titleShareEnabled = shouldEnablePlayListPageTitleShare(renderData.pageState);
  const transition = resolveTitleSharePageTransition({
    activeLayoutId: renderData.activeLayoutId,
    titleToneHandoff: renderData.titleToneHandoff,
    pressedLayoutId: renderData.pressedLayoutId,
  });
  const committedLayoutId = transition.committedLayoutId;
  const displayLock = resolvePlayListPageDisplayLockTargetName({
    pageState: renderData.pageState,
    visiblePlaylists,
    playingPlaylistName: renderData.playingPlaylistName,
    titleToneHandoff: renderData.titleToneHandoff,
    playbackSurface: renderData.playbackSurface,
  });
  const shouldLockScroll = displayLock !== null;
  const playbackTargetKey = displayLock?.playlistName ?? null;
  const shouldAnimateSlotPosition = !shouldLockScroll;
  const itemCommitGesture = renderData.pageState === "ready" ? "secondary-only" : "disabled";
  const itemViewModels = resolvePlayListPageVisibleItems({
    visiblePlaylists,
    playbackSurface: renderData.playbackSurface,
    displayLock,
    titleShareEnabled,
    transition,
    titleToneHandoff: renderData.titleToneHandoff,
    shouldAnimateSlotPosition,
    itemCommitGesture,
  });
  const shouldRenderContent = shouldRenderPlayListPageContent({
    hasPlayList: renderData.hasPlayList,
    visiblePlaylistCount: visiblePlaylists.length,
    hasPendingPreview: !!renderData.pendingPlaylistPreview,
    hasActiveLayoutId: !!renderData.activeLayoutId,
    hasTitleToneHandoff: !!renderData.titleToneHandoff,
  });

  return {
    visiblePlaylists,
    visibleLayoutIds: visiblePlaylists.map((playlist) => playlistTitleLayoutId(playlist.name)),
    transition,
    committedLayoutId,
    shouldRenderContent,
    shouldLockScroll,
    playbackTargetKey,
    itemViewModels,
    shouldRenderCreateItem: true,
    shouldShowCreateItem: !shouldLockScroll,
    createItemViewModel: {
      key: "create",
      text: "Create a List",
      layoutId: titleShareEnabled ? CREATE_COLLECTION_LAYOUT_ID : undefined,
      sourceLayoutId: titleShareEnabled ? CREATE_COLLECTION_LAYOUT_ID : undefined,
      handoffTone:
        (transition.returnTargetLayoutId === CREATE_COLLECTION_LAYOUT_ID &&
          renderData.titleToneHandoff?.tone) ||
        null,
      suppressFade: shouldSuppressTitleShareFade(CREATE_COLLECTION_LAYOUT_ID, transition),
      isPlaybackTarget: false,
      shouldShowPlaybackIcons: false,
      isPlaybackPreparing: false,
      isHiddenInPlay: shouldLockScroll,
      shouldStartHiddenInPlay: displayLock?.kind === "return-handoff",
      shouldAnimateSlotPosition,
      titleHoverVisual: resolveTitleShareHoverVisual({
        layoutId: CREATE_COLLECTION_LAYOUT_ID,
        sourceLayoutId: committedLayoutId,
        targetLayoutId: transition.returnTargetLayoutId,
      }),
      commitGesture: "primary-and-secondary",
    },
  };
}
