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
  resolveTitleSharePageTransition,
  shouldSuppressTitleShareFade,
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

export type PlayListPageCommitGesture =
  | "primary-and-secondary"
  | "secondary-only"
  | "disabled";

export interface PlayListPageRenderData {
  pageState: MainStateT;
  activeLayoutId: string | null;
  hasPlayList: boolean | null;
  playlists: PlayList[];
  pendingPlaylistPreview: PlaylistUpsertResult | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  pressedLayoutId: string | null;
  playbackSurface: PlayListPlaybackSurfaceSnapshot | null;
}

export interface PlayListPageItemViewModel {
  key: string;
  text: string;
  layoutId?: string;
  handoffTone: CollectionTitleTone | null;
  suppressFade: boolean;
  isPlaybackTarget: boolean;
  isHiddenInPlay: boolean;
  shouldAnimateLayoutPosition: boolean;
  isCommitted: boolean;
  commitGesture: PlayListPageCommitGesture;
  playlistName?: string;
}

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

export function shouldEnablePlayListPageTitleShare(
  pageState: MainStateT,
) {
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
  isHiddenInPlay: boolean;
  shouldAnimateLayoutPosition: boolean;
  commitGesture: PlayListPageCommitGesture;
}) {
  const itemLayoutId = playlistTitleLayoutId(args.playlist.name);

  return {
    key: args.playlist.name,
    text: args.text,
    layoutId: args.titleShareEnabled ? itemLayoutId : undefined,
    handoffTone:
      args.transition.returnTargetLayoutId === itemLayoutId
        ? args.titleToneHandoff?.tone ?? null
        : null,
    suppressFade:
      args.isPlaybackTarget ||
      shouldSuppressTitleShareFade(itemLayoutId, args.transition),
    isPlaybackTarget: args.isPlaybackTarget,
    isHiddenInPlay: args.isHiddenInPlay,
    shouldAnimateLayoutPosition: args.shouldAnimateLayoutPosition,
    isCommitted: args.transition.committedLayoutId === itemLayoutId,
    commitGesture: args.commitGesture,
    playlistName: args.playlist.name,
  } satisfies PlayListPageItemViewModel;
}

function resolvePlayListPageVisibleItems(args: {
  visiblePlaylists: readonly PlayList[];
  playbackSurface: PlayListPlaybackSurfaceSnapshot | null;
  titleShareEnabled: boolean;
  transition: TitleSharePageTransition;
  titleToneHandoff: CollectionTitleHandoff | null;
  shouldAnimateLayoutPosition: boolean;
  itemCommitGesture: PlayListPageCommitGesture;
}) {
  const playbackSurfacePlaylistName = args.playbackSurface?.playlistName ?? null;
  const playbackSurfaceTrackName = args.playbackSurface?.displayedTrackName ?? null;
  const hasPlaybackTarget =
    playbackSurfacePlaylistName !== null &&
    args.visiblePlaylists.some(
      (playlist) => playlist.name === playbackSurfacePlaylistName,
    );

  return args.visiblePlaylists.map((playlist) =>
    createPlayListPageItemViewModel({
      playlist,
      text:
        hasPlaybackTarget && playlist.name === playbackSurfacePlaylistName
          ? playbackSurfaceTrackName ?? playlist.name
          : playlist.name,
      titleShareEnabled: args.titleShareEnabled,
      transition: args.transition,
      titleToneHandoff: args.titleToneHandoff,
      isPlaybackTarget:
        hasPlaybackTarget && playlist.name === playbackSurfacePlaylistName,
      isHiddenInPlay:
        hasPlaybackTarget && playlist.name !== playbackSurfacePlaylistName,
      shouldAnimateLayoutPosition: args.shouldAnimateLayoutPosition,
      commitGesture: args.itemCommitGesture,
    }),
  );
}

function resolvePlayListPageShouldLockScroll(args: {
  visiblePlaylists: readonly PlayList[];
  playbackSurface: PlayListPlaybackSurfaceSnapshot | null;
}) {
  const playbackSurfacePlaylistName = args.playbackSurface?.playlistName ?? null;
  if (playbackSurfacePlaylistName === null) {
    return false;
  }

  if (
    !args.visiblePlaylists.some(
      (playlist) => playlist.name === playbackSurfacePlaylistName,
    )
  ) {
    return false;
  }

  return true;
}

export function resolvePlayListPageViewModel(
  renderData: PlayListPageRenderData,
): PlayListPageViewModel {
  const visiblePlaylists = resolvePlaylistsWithPreview(
    renderData.playlists,
    renderData.pendingPlaylistPreview,
  );
  const titleShareEnabled = shouldEnablePlayListPageTitleShare(
    renderData.pageState,
  );
  const transition = resolveTitleSharePageTransition({
    activeLayoutId: renderData.activeLayoutId,
    titleToneHandoff: renderData.titleToneHandoff,
    pressedLayoutId: renderData.pressedLayoutId,
  });
  const committedLayoutId = transition.committedLayoutId;
  const shouldRenderContent = shouldRenderPlayListPageContent({
    hasPlayList: renderData.hasPlayList,
    visiblePlaylistCount: visiblePlaylists.length,
    hasPendingPreview: renderData.pendingPlaylistPreview !== null,
    hasActiveLayoutId: renderData.activeLayoutId !== null,
    hasTitleToneHandoff: renderData.titleToneHandoff !== null,
  });
  const hasPlaybackSurfaceTarget =
    renderData.playbackSurface?.playlistName !== undefined &&
    visiblePlaylists.some(
      (playlist) => playlist.name === renderData.playbackSurface?.playlistName,
    );
  const shouldAnimateLayoutPosition = !hasPlaybackSurfaceTarget;
  const itemCommitGesture =
    renderData.pageState === "ready" ? "secondary-only" : "disabled";
  const itemViewModels = resolvePlayListPageVisibleItems({
    visiblePlaylists,
    playbackSurface: renderData.playbackSurface,
    titleShareEnabled,
    transition,
    titleToneHandoff: renderData.titleToneHandoff,
    shouldAnimateLayoutPosition,
    itemCommitGesture,
  });
  const shouldLockScroll = resolvePlayListPageShouldLockScroll({
    visiblePlaylists,
    playbackSurface: renderData.playbackSurface,
  });
  const playbackTargetKey =
    shouldLockScroll && renderData.playbackSurface
      ? renderData.playbackSurface.playlistName
      : null;

  return {
    visiblePlaylists,
    visibleLayoutIds: visiblePlaylists.map((playlist) =>
      playlistTitleLayoutId(playlist.name),
    ),
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
      handoffTone:
        transition.returnTargetLayoutId === CREATE_COLLECTION_LAYOUT_ID
          ? renderData.titleToneHandoff?.tone ?? null
          : null,
      suppressFade: shouldSuppressTitleShareFade(
        CREATE_COLLECTION_LAYOUT_ID,
        transition,
      ),
      isPlaybackTarget: false,
      isHiddenInPlay: shouldLockScroll,
      shouldAnimateLayoutPosition,
      isCommitted: committedLayoutId === CREATE_COLLECTION_LAYOUT_ID,
      commitGesture: "primary-and-secondary",
    },
  };
}
