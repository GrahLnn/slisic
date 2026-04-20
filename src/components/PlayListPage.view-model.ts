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

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

export type PlayListPageCommitGesture = "primary-and-secondary" | "secondary-only";

export interface PlayListPageRenderData {
  pageState: MainStateT;
  activeLayoutId: string | null;
  hasPlayList: boolean | null;
  playlists: PlayList[];
  pendingPlaylistPreview: PlaylistUpsertResult | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  pressedLayoutId: string | null;
  playingPlaylistName: string | null;
  nowPlayingTrackName: string | null;
  playbackSurfaceTargetName: string | null;
  playbackSurfaceTrackName: string | null;
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
  shouldShowCreateItem: boolean;
  createItemViewModel: PlayListPageItemViewModel;
}

export function shouldCommitPlayListPageItem(args: {
  button: number;
  gesture: PlayListPageCommitGesture;
}) {
  return args.gesture === "primary-and-secondary"
    ? args.button === 0 || args.button === 2
    : args.button === 2;
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
      exit: contentFadeProps.animate,
    } as const;
  }

  return {
    initial: contentFadeProps.initial,
    animate: args.isPresent ? contentFadeProps.animate : contentFadeProps.exit,
    exit: contentFadeProps.exit,
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
    commitGesture: "secondary-only" as const,
    playlistName: args.playlist.name,
  } satisfies PlayListPageItemViewModel;
}

function resolvePlayListPageVisibleItems(args: {
  visiblePlaylists: readonly PlayList[];
  playbackSurfaceTargetName: string | null;
  playbackSurfaceTrackName: string | null;
  titleShareEnabled: boolean;
  transition: TitleSharePageTransition;
  titleToneHandoff: CollectionTitleHandoff | null;
  shouldAnimateLayoutPosition: boolean;
}) {
  const hasPlaybackTarget =
    args.playbackSurfaceTargetName !== null &&
    args.visiblePlaylists.some(
      (playlist) => playlist.name === args.playbackSurfaceTargetName,
    );

  return args.visiblePlaylists.map((playlist) =>
    createPlayListPageItemViewModel({
      playlist,
      text:
        hasPlaybackTarget && playlist.name === args.playbackSurfaceTargetName
          ? args.playbackSurfaceTrackName ?? playlist.name
          : playlist.name,
      titleShareEnabled: args.titleShareEnabled,
      transition: args.transition,
      titleToneHandoff: args.titleToneHandoff,
      isPlaybackTarget:
        hasPlaybackTarget && playlist.name === args.playbackSurfaceTargetName,
      isHiddenInPlay:
        hasPlaybackTarget && playlist.name !== args.playbackSurfaceTargetName,
      shouldAnimateLayoutPosition: args.shouldAnimateLayoutPosition,
    }),
  );
}

function resolvePlayListPageShouldLockScroll(args: {
  visiblePlaylists: readonly PlayList[];
  playbackSurfaceTargetName: string | null;
}) {
  if (!args.playbackSurfaceTargetName) {
    return false;
  }

  if (
    !args.visiblePlaylists.some(
      (playlist) => playlist.name === args.playbackSurfaceTargetName,
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
    renderData.playbackSurfaceTargetName !== null &&
    visiblePlaylists.some(
      (playlist) => playlist.name === renderData.playbackSurfaceTargetName,
    );
  const shouldAnimateLayoutPosition = !hasPlaybackSurfaceTarget;
  const itemViewModels = resolvePlayListPageVisibleItems({
    visiblePlaylists,
    playbackSurfaceTargetName: renderData.playbackSurfaceTargetName,
    playbackSurfaceTrackName: renderData.playbackSurfaceTrackName,
    titleShareEnabled,
    transition,
    titleToneHandoff: renderData.titleToneHandoff,
    shouldAnimateLayoutPosition,
  });
  const shouldLockScroll = resolvePlayListPageShouldLockScroll({
    visiblePlaylists,
    playbackSurfaceTargetName: renderData.playbackSurfaceTargetName,
  });
  const playbackTargetKey =
    shouldLockScroll && renderData.playbackSurfaceTargetName
      ? renderData.playbackSurfaceTargetName
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
      isHiddenInPlay: false,
      shouldAnimateLayoutPosition,
      isCommitted: committedLayoutId === CREATE_COLLECTION_LAYOUT_ID,
      commitGesture: "primary-and-secondary",
    },
  };
}
