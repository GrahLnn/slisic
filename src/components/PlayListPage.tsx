import { useCallback, useLayoutEffect, useRef, useState, type RefCallback } from "react";
import { flushSync } from "react-dom";
import { useIsPresent } from "motion/react";
import { cn } from "@/lib/utils";
import { action as appLogicAction, hook as appLogicHook } from "@/src/flow/appLogic";
import { recordTrace } from "@/src/debug/trace";
import type { MainStateT } from "@/src/flow/appLogic/events";
import { usePageRenderFreeze } from "./usePageRenderFreeze";
import { PlayListPageItem, CreateNewPlayListItem } from "./PlayListPageItem";
import { usePlayListPlaybackSurface } from "./usePlayListPlaybackSurface";
import {
  createPlayListPageCreateConfigExitRenderData,
  createPlayListPageConfigExitRenderData,
  resolvePlayListPageViewModel,
  resolvePlayListPageTitleReturnSurfaceTargetLayoutId,
  type PlayListPageRenderData,
} from "./PlayListPage.view-model";
import {
  recordStoredScrollTop,
  restoreStoredScrollTop,
  type ScrollPositionRef,
} from "./scrollPosition";
import { usePlayListTitleReturnSurface } from "./usePlayListTitleReturnSurface";

export function PlayListPage({
  scrollPositionRef,
  surfacePageState,
}: {
  scrollPositionRef: ScrollPositionRef;
  surfacePageState?: MainStateT;
}) {
  const isPresent = useIsPresent();
  const {
    activeLayoutId,
    hasPlayList,
    playlists,
    pendingPlaylistPreview,
    pendingPlaylistPlaybackRequest,
    playingPlaylistName,
    playingSessionGeneration,
    nowPlayingTrackName,
    nowPlayingTrackUrl,
    nowPlayingTrackLiked,
    playbackSurfaceStatus,
    titleToneHandoff,
  } = appLogicHook.useContext();
  const pageState = appLogicHook.useState();
  const livePageStateValue = pageState.match({
    idle: () => "idle" as const,
    loading: () => "loading" as const,
    ready: () => "ready" as const,
    play: () => "play" as const,
    spectrum: () => "spectrum" as const,
    configLoading: () => "configLoading" as const,
    config: () => "config" as const,
    configUpdatingCollectionUpdates: () => "configUpdatingCollectionUpdates" as const,
    error: () => "error" as const,
  });
  const pageStateValue = surfacePageState ?? livePageStateValue;
  const playbackSurface = usePlayListPlaybackSurface({
    pageState: pageStateValue,
    playingPlaylistName,
    playingSessionGeneration,
    nowPlayingTrackName,
    nowPlayingTrackUrl,
    nowPlayingTrackLiked,
    playbackSurfaceStatus,
  });
  const titleReturnSurfaceTargetLayoutId = resolvePlayListPageTitleReturnSurfaceTargetLayoutId({
    pageState: pageStateValue,
    visiblePlaylists: pendingPlaylistPreview
      ? [pendingPlaylistPreview.playlist, ...playlists]
      : playlists,
    titleToneHandoff,
  });
  const titleReturnSurface = usePlayListTitleReturnSurface(titleReturnSurfaceTargetLayoutId);
  const [pressedTitleLayoutId, setPressedTitleLayoutId] = useState<string | null>(null);
  const releasePressedTitleLayoutFrameRef = useRef<number | null>(null);
  const releasePressedTitleLayoutId = useCallback((layoutId?: string) => {
    const traceLayoutId = layoutId ?? pressedTitleLayoutId;
    recordTrace("playlist-page-pressed-title-release-requested", {
      pressedTitleLayoutId: traceLayoutId,
      hasPendingFrame: releasePressedTitleLayoutFrameRef.current !== null,
    });

    if (typeof window === "undefined") {
      setPressedTitleLayoutId(null);
      recordTrace("playlist-page-pressed-title-release-immediate", {
        pressedTitleLayoutId: traceLayoutId,
      });
      return;
    }

    if (releasePressedTitleLayoutFrameRef.current !== null) {
      window.cancelAnimationFrame(releasePressedTitleLayoutFrameRef.current);
      recordTrace("playlist-page-pressed-title-release-frame-cancelled", {
        pressedTitleLayoutId: traceLayoutId,
      });
    }

    releasePressedTitleLayoutFrameRef.current = window.requestAnimationFrame(() => {
      releasePressedTitleLayoutFrameRef.current = null;
      setPressedTitleLayoutId(null);
      recordTrace("playlist-page-pressed-title-released", {
        pressedTitleLayoutId: traceLayoutId,
      });
    });
  }, [pressedTitleLayoutId]);
  const commitPressedTitleLayoutId = useCallback((layoutId?: string) => {
    recordTrace("playlist-page-pressed-title-commit-requested", {
      layoutId: layoutId ?? null,
      pressedTitleLayoutId,
    });

    if (!layoutId) {
      recordTrace("playlist-page-pressed-title-commit-skipped", {
        reason: "missing_layout_id",
        pressedTitleLayoutId,
      });
      return;
    }

    // Motion samples the outgoing layout source before the play state commit,
    // so the pressed title must expose its handoff weight evidence in the same
    // semantic playback transaction.
    flushSync(() => {
      setPressedTitleLayoutId(layoutId);
    });
    recordTrace("playlist-page-pressed-title-committed", {
      layoutId,
    });
  }, [pressedTitleLayoutId]);
  useLayoutEffect(
    () => () => {
      if (releasePressedTitleLayoutFrameRef.current !== null) {
        window.cancelAnimationFrame(releasePressedTitleLayoutFrameRef.current);
        releasePressedTitleLayoutFrameRef.current = null;
      }
    },
    [],
  );
  const handleScrollContainerRef = useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      playbackSurface.containerRef.current = node;
      restoreStoredScrollTop(node, scrollPositionRef);
    },
    [playbackSurface.containerRef, scrollPositionRef],
  );
  const liveRenderData: PlayListPageRenderData = {
    pageState: pageStateValue,
    activeLayoutId,
    hasPlayList,
    playlists,
    pendingPlaylistPreview,
    pendingPlaylistPlaybackRequest,
    playingPlaylistName,
    titleToneHandoff,
    pressedLayoutId: pressedTitleLayoutId,
    playbackSurface: playbackSurface.playbackSurfaceSnapshot,
    titleReturnSurface: titleReturnSurface.titleReturnSurfaceSnapshot,
  };
  const pageRenderFreeze = usePageRenderFreeze(liveRenderData, {
    isPresent,
    freezeOnExit: true,
  });
  const renderData = pageRenderFreeze.renderValue;
  const viewModel = resolvePlayListPageViewModel(renderData);
  const playbackTargetItem = viewModel.playbackTargetKey
    ? viewModel.itemViewModels.find((item) => item.playlistName === viewModel.playbackTargetKey)
    : null;
  const stablePlaylistNames = new Set(renderData.playlists.map((playlist) => playlist.name));
  recordTrace("playlist-page-projection", {
    pageState: renderData.pageState,
    isFrozen: pageRenderFreeze.isFrozen,
    livePageState: livePageStateValue,
    surfacePageState: surfacePageState ?? null,
    playingPlaylistName: renderData.playingPlaylistName,
    nowPlayingTrackName,
    nowPlayingTrackUrl,
    playbackSurfaceStatus,
    pendingPlaylistPlaybackPhase: renderData.pendingPlaylistPlaybackRequest?.phase ?? null,
    pendingPlaylistPlaybackReason: renderData.pendingPlaylistPlaybackRequest?.reason ?? null,
    pendingPlaylistPlaybackName: renderData.pendingPlaylistPlaybackRequest?.playlistName ?? null,
    pendingPlaylistPlaybackRequestId: renderData.pendingPlaylistPlaybackRequest?.requestId ?? null,
    playbackSurfacePhase: renderData.playbackSurface?.phase ?? null,
    playbackSurfacePlaylistName: renderData.playbackSurface?.playlistName ?? null,
    playbackSurfaceTrackName: renderData.playbackSurface?.displayedTrackName ?? null,
    playbackSurfaceTrackIsPlayable: renderData.playbackSurface?.displayedTrackIsPlayable ?? null,
    playbackTargetKey: viewModel.playbackTargetKey,
    playbackTargetText: playbackTargetItem?.text ?? null,
    playbackTargetIsPreparing: playbackTargetItem?.isPlaybackPreparing ?? null,
    playbackTargetIsPlaybackTarget: playbackTargetItem?.isPlaybackTarget ?? null,
    playbackTargetShowsIcons: playbackTargetItem?.shouldShowPlaybackIcons ?? null,
    playbackTargetTitleHoverVisual: playbackTargetItem?.titleHoverVisual ?? null,
    itemTexts: viewModel.itemViewModels.map((item) => ({
      isPlaybackPreparing: item.isPlaybackPreparing,
      isPlaybackTarget: item.isPlaybackTarget,
      playlistName: item.playlistName,
      text: item.text,
    })),
  });

  return (
    <div
      data-page-state="playlist"
      className="relative h-[calc(100vh-2rem)] w-full overflow-hidden px-6"
      style={{ fontFamily: "var(--font-noto-sans)" }}
    >
      {viewModel.shouldRenderContent ? (
        <div className="relative z-0 flex h-full w-full flex-col items-center">
          <div
            ref={handleScrollContainerRef}
            className={cn(
              "hide-scrollbar flex h-full w-full flex-col items-center gap-8 snap-y snap-mandatory overscroll-y-contain",
              viewModel.shouldLockScroll ? "overflow-hidden" : "overflow-y-auto",
            )}
            onScroll={(event) => {
              recordStoredScrollTop(event.currentTarget, scrollPositionRef);
            }}
          >
            <div aria-hidden className="h-[calc(50vh-1rem)] shrink-0 snap-none" />
            {viewModel.itemViewModels.map((itemViewModel) => (
              <PlayListPageItem
                key={itemViewModel.key}
                containerRef={playbackSurface.setItemRef(itemViewModel.key)}
                viewModel={itemViewModel}
                onTorphStageChange={(stage) => {
                  playbackSurface.handleTorphStageChange(itemViewModel.key, stage);
                }}
                onLayoutAnimationComplete={titleReturnSurface.handleLayoutAnimationComplete}
                onPrimaryCommit={() => {
                  recordTrace("playlist-page-primary-commit-enter", {
                    playlistName: itemViewModel.playlistName,
                    layoutId: itemViewModel.layoutId ?? null,
                    sourceLayoutId: itemViewModel.sourceLayoutId ?? null,
                    text: itemViewModel.text,
                    pageState: renderData.pageState,
                    livePageState: livePageStateValue,
                    isFrozen: pageRenderFreeze.isFrozen,
                    pressedTitleLayoutId,
                    isPlaybackPreparing: itemViewModel.isPlaybackPreparing,
                    isPlaybackTarget: itemViewModel.isPlaybackTarget,
                    shouldShowPlaybackIcons: itemViewModel.shouldShowPlaybackIcons,
                    titleHoverVisual: itemViewModel.titleHoverVisual,
                    playbackSurfacePhase: renderData.playbackSurface?.phase ?? null,
                    playbackSurfacePlaylistName: renderData.playbackSurface?.playlistName ?? null,
                    pendingPlaylistPlaybackPhase:
                      renderData.pendingPlaylistPlaybackRequest?.phase ?? null,
                    pendingPlaylistPlaybackName:
                      renderData.pendingPlaylistPlaybackRequest?.playlistName ?? null,
                    pendingPlaylistPlaybackRequestId:
                      renderData.pendingPlaylistPlaybackRequest?.requestId ?? null,
                  });
                  if (!itemViewModel.playlistName) {
                    recordTrace("playlist-page-primary-commit-rejected-no-playlist", {
                      text: itemViewModel.text,
                      layoutId: itemViewModel.layoutId ?? null,
                    });
                    return;
                  }

                  recordTrace("playlist-page-primary-commit-pressed-title-before", {
                    playlistName: itemViewModel.playlistName,
                    layoutId: itemViewModel.layoutId ?? null,
                  });
                  commitPressedTitleLayoutId(itemViewModel.layoutId);
                  recordTrace("playlist-page-primary-commit-action-before", {
                    playlistName: itemViewModel.playlistName,
                  });
                  appLogicAction.playPlaylist(itemViewModel.playlistName);
                  recordTrace("playlist-page-primary-commit-action-after", {
                    playlistName: itemViewModel.playlistName,
                  });
                  releasePressedTitleLayoutId(itemViewModel.layoutId);
                  recordTrace("playlist-page-primary-commit-exit", {
                    playlistName: itemViewModel.playlistName,
                  });
                }}
                onCommit={() => {
                  if (!itemViewModel.playlistName) {
                    return;
                  }

                  if (stablePlaylistNames.has(itemViewModel.playlistName)) {
                    flushSync(() => {
                      pageRenderFreeze.freeze(
                        createPlayListPageConfigExitRenderData(
                          renderData,
                          itemViewModel.playlistName,
                        ),
                      );
                    });
                  }

                  appLogicAction.openPlaylist(itemViewModel.playlistName);
                }}
                onOpenSpectrum={() => {
                  const sourceLayoutId =
                    itemViewModel.layoutId ?? itemViewModel.sourceLayoutId ?? null;

                  recordTrace("playlist-open-spectrum-click", {
                    playlistName: itemViewModel.playlistName,
                    isPlaybackTarget: itemViewModel.isPlaybackTarget,
                    shouldShowPlaybackIcons: itemViewModel.shouldShowPlaybackIcons,
                    isPlaybackPreparing: itemViewModel.isPlaybackPreparing,
                    sourceLayoutId,
                    surfacePageState,
                  });
                  if (sourceLayoutId) {
                    pageRenderFreeze.freeze({
                      ...renderData,
                      pressedLayoutId: sourceLayoutId,
                    });
                  }

                  appLogicAction.openSpectrum();
                }}
                onExcludeCurrentMusic={() => {
                  appLogicAction.excludeCurrentMusicAndSkip();
                }}
                onToggleCurrentMusicLike={(liked) => {
                  appLogicAction.setCurrentMusicLiked(liked);
                }}
              />
            ))}
            {viewModel.shouldRenderCreateItem ? (
              <CreateNewPlayListItem
                key={viewModel.createItemViewModel.key}
                viewModel={viewModel.createItemViewModel}
                onCommit={() => {
                  flushSync(() => {
                    pageRenderFreeze.freeze(
                      createPlayListPageCreateConfigExitRenderData(renderData),
                    );
                  });
                }}
              />
            ) : null}
            <div aria-hidden className="h-[calc(50vh-1rem)] shrink-0 snap-none" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
