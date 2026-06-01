import type { PlayListListView } from "@/src/cmd";
import type {
  CollectionTitleHandoff,
  CollectionTitleTone,
  PlaylistPlaybackRequestEvidence,
  PlaylistPreview,
} from "@/src/flow/appLogic/core";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  createCollectionTitleHandoff,
  playlistTitleLayoutId,
  resolvePlaylistsWithPreview,
} from "@/src/flow/appLogic/core";
import type { MainStateT } from "@/src/flow/appLogic/events";
import {
  createTitleShareArrow,
  createTitleShareEndpoint,
  resolveTitleShareEndpointInstruction,
  resolveTitleSharePageTransition,
  shouldSuppressTitleShareFade,
  type TitleSharePageTransition,
} from "@/src/flow/appLogic/titleShare";
import { collectionTitleLayoutTransition } from "./collectionTitle";
import {
  resolvePlayListTitleHandoffInstruction,
  resolvePlayListTitleHandoffEndpointKind,
  resolvePlayListTitleHandoffPlan,
  type PlayListTitleHandoffDisplayLock,
  type PlayListTitleHandoffInstruction,
  type PlayListTitleHandoffPlan,
  type PlayListTitleHandoffRetainLease,
} from "./playListTitleHandoff.model";
import type { PlayListPlaybackSurfaceSnapshot } from "./playListPlaybackSurface.model";
import type { PlayListTitleReturnSurfaceSnapshot } from "./playListTitleReturnSurface.model";

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

export type PlayListPageCommitGesture = "primary-and-secondary" | "secondary-only" | "disabled";
export type PlayListPageTitleHoverRetainLease = PlayListTitleHandoffRetainLease;

export interface PlayListPageRenderData {
  pageState: MainStateT;
  activeLayoutId: string | null;
  hasPlayList: boolean | null;
  playlists: PlayListListView[];
  pendingPlaylistPreview?: PlaylistPreview | null;
  pendingPlaylistPlaybackRequest?: PlaylistPlaybackRequestEvidence | null;
  playingPlaylistName: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  pressedLayoutId: string | null;
  playbackSurface: PlayListPlaybackSurfaceSnapshot | null;
  titleReturnSurface: PlayListTitleReturnSurfaceSnapshot | null;
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
  isCurrentMusicLiked: boolean;
  playbackIconWidthText?: string;
  isPlaybackPreparing: boolean;
  isHiddenInPlay: boolean;
  shouldStartHiddenInPlay: boolean;
  shouldAnimateSlotPosition: boolean;
  titleHoverVisual: PlayListTitleHandoffInstruction["titleHoverVisual"];
  titleHoverRetainLease: PlayListPageTitleHoverRetainLease;
  commitGesture: PlayListPageCommitGesture;
  playlistName: string;
}

type PlayListPageDisplayLock = PlayListTitleHandoffDisplayLock;

function resolvePendingPlaybackPlaylistName(args: {
  pageState: MainStateT;
  pendingPlaylistPlaybackRequest?: PlaylistPlaybackRequestEvidence | null;
  visiblePlaylists: readonly PlayListListView[];
}) {
  const request = args.pendingPlaylistPlaybackRequest ?? null;
  if (
    (args.pageState !== "ready" && args.pageState !== "play") ||
    request === null ||
    request.phase === "failed"
  ) {
    return null;
  }

  return args.visiblePlaylists.some((playlist) => playlist.name === request.playlistName)
    ? request.playlistName
    : null;
}

function shouldShowPendingPlaybackPreparation(
  request: PlaylistPlaybackRequestEvidence | null,
): boolean {
  return request?.phase === "preparing" && request.reason === "pending_first_track";
}

export interface PlayListPageViewModel {
  visiblePlaylists: PlayListListView[];
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
  hasPendingPreview?: boolean;
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

export function resolvePlayListPageTexts(playlists: readonly PlayListListView[]) {
  return playlists.map((playlist) => playlist.name);
}

function createPlayListPageItemViewModel(args: {
  playlist: PlayListListView;
  text: string;
  titleShareEnabled: boolean;
  transition: TitleSharePageTransition;
  titleToneHandoff: CollectionTitleHandoff | null;
  isPlaybackTarget: boolean;
  shouldShowPlaybackIcons: boolean;
  isCurrentMusicLiked: boolean;
  playbackIconWidthText?: string;
  isPlaybackPreparing: boolean;
  isHiddenInPlay: boolean;
  isPlaybackTitleHandoffTarget: boolean;
  titleHandoffInstruction: PlayListTitleHandoffInstruction;
  shouldStartHiddenInPlay: boolean;
  shouldAnimateSlotPosition: boolean;
  commitGesture: PlayListPageCommitGesture;
}) {
  const itemLayoutId = playlistTitleLayoutId(args.playlist.name);
  const shouldShareTitleLayout =
    args.titleShareEnabled &&
    (!args.isPlaybackTarget ||
      args.isPlaybackTitleHandoffTarget ||
      args.transition.committedLayoutId === itemLayoutId);

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
    isCurrentMusicLiked: args.isCurrentMusicLiked,
    ...(args.playbackIconWidthText && { playbackIconWidthText: args.playbackIconWidthText }),
    isPlaybackPreparing: args.isPlaybackPreparing,
    isHiddenInPlay: args.isHiddenInPlay,
    shouldStartHiddenInPlay: args.shouldStartHiddenInPlay,
    shouldAnimateSlotPosition: args.shouldAnimateSlotPosition,
    titleHoverVisual: args.titleHandoffInstruction.titleHoverVisual,
    titleHoverRetainLease: args.titleHandoffInstruction.titleHoverRetainLease,
    commitGesture: args.commitGesture,
    playlistName: args.playlist.name,
  } satisfies PlayListPageItemViewModel;
}

function resolvePlayListPageVisibleItems(args: {
  visiblePlaylists: readonly PlayListListView[];
  pageState: MainStateT;
  playingPlaylistName: string | null;
  pendingPlaylistPlaybackRequest: PlaylistPlaybackRequestEvidence | null;
  playbackSurface: PlayListPlaybackSurfaceSnapshot | null;
  displayLock: PlayListPageDisplayLock | null;
  titleShareEnabled: boolean;
  transition: TitleSharePageTransition;
  titleToneHandoff: CollectionTitleHandoff | null;
  titleHandoffPlan: PlayListTitleHandoffPlan;
  shouldAnimateSlotPosition: boolean;
  itemCommitGesture: PlayListPageCommitGesture;
}) {
  const playbackSurfacePlaylistName = args.playbackSurface?.playlistName;
  const playbackSurfaceTrackName = args.playbackSurface?.displayedTrackName || undefined;
  const playbackSurfaceTrackLiked = args.playbackSurface?.displayedTrackLiked ?? null;
  const playbackSurfaceTrackIsPlayable = args.playbackSurface?.displayedTrackIsPlayable ?? false;
  const isPlaybackSurfacePlaying = args.playbackSurface?.phase === "playing";
  const playbackActionsEnabled = args.pageState === "play";
  const shouldApplyPlaybackSurface =
    args.displayLock?.kind !== "return-handoff" && isPlaybackSurfacePlaying;
  const hasPlaybackTarget =
    shouldApplyPlaybackSurface &&
    !!playbackSurfacePlaylistName &&
    args.visiblePlaylists.some((playlist) => playlist.name === playbackSurfacePlaylistName);
  const displayLockPlaylistName = args.displayLock?.playlistName ?? null;
  const hasDisplayLockTarget =
    !!displayLockPlaylistName &&
    args.visiblePlaylists.some((playlist) => playlist.name === displayLockPlaylistName);
  const pendingPlaybackPlaylistName = resolvePendingPlaybackPlaylistName(args);
  const shouldStartHiddenItemsInPlay = args.displayLock?.kind === "return-handoff";
  const openingPlaybackTitleHandoffTargetName =
    args.pageState === "play" &&
    args.playbackSurface === null &&
    args.playingPlaylistName !== null &&
    args.visiblePlaylists.some((playlist) => playlist.name === args.playingPlaylistName)
      ? args.playingPlaylistName
      : null;
  const playbackTitleHandoffTargetName =
    args.displayLock?.kind === "playback-surface" && playbackSurfaceTrackName === undefined
      ? playbackSurfacePlaylistName
      : openingPlaybackTitleHandoffTargetName;

  return args.visiblePlaylists.map((playlist) =>
    (() => {
      const itemLayoutId = playlistTitleLayoutId(playlist.name);
      const isPlaybackTarget = hasPlaybackTarget && playlist.name === playbackSurfacePlaylistName;
      const isPendingPlaybackTarget =
        !isPlaybackTarget && playlist.name === pendingPlaybackPlaylistName;
      const isPendingPlaybackPreparing =
        isPendingPlaybackTarget &&
        shouldShowPendingPlaybackPreparation(args.pendingPlaylistPlaybackRequest);

      return createPlayListPageItemViewModel({
        playlist,
        text:
          hasPlaybackTarget && playlist.name === playbackSurfacePlaylistName
            ? playbackSurfaceTrackName || playlist.name
            : isPendingPlaybackPreparing
              ? "Preparing..."
              : playlist.name,
        titleShareEnabled: args.titleShareEnabled,
        transition: args.transition,
        titleToneHandoff: args.titleToneHandoff,
        isPlaybackTarget: isPlaybackTarget || isPendingPlaybackTarget,
        shouldShowPlaybackIcons:
          isPendingPlaybackTarget
            ? false
            : playbackActionsEnabled &&
              isPlaybackSurfacePlaying &&
              hasPlaybackTarget &&
              playlist.name === playbackSurfacePlaylistName &&
              !!playbackSurfaceTrackName,
        isCurrentMusicLiked:
          isPlaybackSurfacePlaying &&
          hasPlaybackTarget &&
          playlist.name === playbackSurfacePlaylistName &&
          playbackSurfaceTrackLiked === true,
        isPlaybackPreparing:
          isPendingPlaybackPreparing ||
          (isPlaybackSurfacePlaying &&
            hasPlaybackTarget &&
            playlist.name === playbackSurfacePlaylistName &&
            !!playbackSurfaceTrackName &&
            !playbackSurfaceTrackIsPlayable),
        isPlaybackTitleHandoffTarget: playlist.name === playbackTitleHandoffTargetName,
        titleHandoffInstruction: resolvePlayListTitleHandoffInstruction({
          plan: args.titleHandoffPlan,
          endpointKind: resolvePlayListTitleHandoffEndpointKind({
            plan: args.titleHandoffPlan,
            layoutId: itemLayoutId,
            sourceEnabled: !isPlaybackTarget && !isPendingPlaybackTarget,
          }),
          layoutId: itemLayoutId,
          sourceEnabled: !isPlaybackTarget && !isPendingPlaybackTarget,
        }),
        playbackIconWidthText:
          isPendingPlaybackPreparing
            ? "Preparing..."
            : (isPlaybackSurfacePlaying &&
                playlist.name === playbackSurfacePlaylistName &&
                playbackSurfaceTrackName) ||
              undefined,
        isHiddenInPlay: hasDisplayLockTarget && playlist.name !== displayLockPlaylistName,
        shouldStartHiddenInPlay:
          shouldStartHiddenItemsInPlay && playlist.name !== displayLockPlaylistName,
        shouldAnimateSlotPosition: args.shouldAnimateSlotPosition,
        commitGesture: args.itemCommitGesture,
      });
    })(),
  );
}

function resolvePlayListPageReturnHandoffTargetName(args: {
  visiblePlaylists: readonly PlayListListView[];
  titleToneHandoff: CollectionTitleHandoff | null;
}) {
  if (!args.titleToneHandoff) {
    return null;
  }

  return (
    args.visiblePlaylists.find(
      (playlist) => playlistTitleLayoutId(playlist.name) === args.titleToneHandoff?.layoutId,
    )?.name ?? null
  );
}

export function resolvePlayListPageTitleReturnSurfaceTargetLayoutId(args: {
  pageState: MainStateT;
  visiblePlaylists: readonly PlayListListView[];
  titleToneHandoff: CollectionTitleHandoff | null;
}) {
  if (args.pageState !== "ready") {
    return null;
  }

  const returnHandoffTargetName = resolvePlayListPageReturnHandoffTargetName(args);
  return returnHandoffTargetName ? playlistTitleLayoutId(returnHandoffTargetName) : null;
}

/**
 * Opening config replaces any previous config-to-list return surface. The
 * exiting playlist page needs that replacement before React switches page keys,
 * otherwise the old return target can keep suppressing its fade until unmount.
 */
function createConfigExitRenderDataByLayoutId(
  renderData: PlayListPageRenderData,
  layoutId: string,
): PlayListPageRenderData {
  return {
    ...renderData,
    activeLayoutId: layoutId,
    titleToneHandoff: createCollectionTitleHandoff(layoutId, "solid"),
    pressedLayoutId: null,
    titleReturnSurface: null,
  };
}

export function createPlayListPageConfigExitRenderData(
  renderData: PlayListPageRenderData,
  playlistName: string,
): PlayListPageRenderData {
  return createConfigExitRenderDataByLayoutId(renderData, playlistTitleLayoutId(playlistName));
}

export function createPlayListPageCreateConfigExitRenderData(
  renderData: PlayListPageRenderData,
): PlayListPageRenderData {
  return createConfigExitRenderDataByLayoutId(renderData, CREATE_COLLECTION_LAYOUT_ID);
}

export function resolvePlayListPageViewModel(
  renderData: PlayListPageRenderData,
): PlayListPageViewModel {
  const visiblePlaylists = resolvePlaylistsWithPreview(
    renderData.playlists,
    renderData.pendingPlaylistPreview ?? null,
  );
  const titleShareEnabled = shouldEnablePlayListPageTitleShare(renderData.pageState);
  const transition = resolveTitleSharePageTransition({
    activeLayoutId: renderData.activeLayoutId,
    titleToneHandoff: renderData.titleToneHandoff,
    pressedLayoutId: renderData.pressedLayoutId,
  });
  const committedLayoutId = transition.committedLayoutId;
  const pendingPlaybackPlaylistName = resolvePendingPlaybackPlaylistName({
    pageState: renderData.pageState,
    pendingPlaylistPlaybackRequest: renderData.pendingPlaylistPlaybackRequest,
    visiblePlaylists,
  });
  const titleHandoffPlan = resolvePlayListTitleHandoffPlan({
    pageState: renderData.pageState,
    endpoints: visiblePlaylists.map((playlist) => ({
      layoutId: playlistTitleLayoutId(playlist.name),
      playlistName: playlist.name,
    })),
    pendingPlaybackPlaylistName,
    playingPlaylistName: renderData.playingPlaylistName,
    titleToneHandoff: renderData.titleToneHandoff,
    transition,
    playbackSurface: renderData.playbackSurface,
    titleReturnSurface: renderData.titleReturnSurface,
  });
  const displayLock = titleHandoffPlan.displayLock;
  const shouldLockScroll = displayLock !== null;
  const playbackTargetKey = displayLock?.playlistName ?? null;
  const shouldAnimateSlotPosition = !shouldLockScroll;
  const itemCommitGesture =
    renderData.pageState === "ready" && pendingPlaybackPlaylistName === null
      ? "secondary-only"
      : "disabled";
  const itemViewModels = resolvePlayListPageVisibleItems({
    visiblePlaylists,
    pageState: renderData.pageState,
    playingPlaylistName: renderData.playingPlaylistName,
    pendingPlaylistPlaybackRequest: renderData.pendingPlaylistPlaybackRequest ?? null,
    playbackSurface: renderData.playbackSurface,
    displayLock,
    titleShareEnabled,
    transition,
    titleToneHandoff: renderData.titleToneHandoff,
    titleHandoffPlan,
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
      isCurrentMusicLiked: false,
      isPlaybackPreparing: false,
      isHiddenInPlay: shouldLockScroll,
      shouldStartHiddenInPlay: displayLock?.kind === "return-handoff",
      shouldAnimateSlotPosition,
      titleHoverVisual: resolveTitleShareEndpointInstruction({
        endpoint: createTitleShareEndpoint("list", CREATE_COLLECTION_LAYOUT_ID),
        arrow: createTitleShareArrow({
          kind: "identity",
          source: createTitleShareEndpoint(
            "list",
            titleHandoffPlan.sourceLayoutId === CREATE_COLLECTION_LAYOUT_ID
              ? committedLayoutId
              : null,
          ),
          target: createTitleShareEndpoint(
            "list",
            renderData.pageState === "play" &&
              titleHandoffPlan.targetLayoutId === CREATE_COLLECTION_LAYOUT_ID
              ? CREATE_COLLECTION_LAYOUT_ID
              : null,
          ),
        }),
      }).titleHoverVisual,
      titleHoverRetainLease: "timed",
      commitGesture: "primary-and-secondary",
      playlistName: "Create a List",
    },
  };
}
