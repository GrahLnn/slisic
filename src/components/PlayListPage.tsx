import { useCallback, useLayoutEffect, useRef, useState, type RefCallback } from "react";
import { flushSync } from "react-dom";
import { useIsPresent } from "motion/react";
import { cn } from "@/lib/utils";
import { action as appLogicAction, hook as appLogicHook } from "@/src/flow/appLogic";
import type { MainStateT } from "@/src/flow/appLogic/events";
import { usePageRenderFreeze } from "./usePageRenderFreeze";
import { PlayListPageItem, CreateNewPlayListItem } from "./PlayListPageItem";
import { usePlayListPlaybackSurface } from "./usePlayListPlaybackSurface";
import {
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
    playingPlaylistName,
    nowPlayingTrackName,
    nowPlayingTrackUrl,
    titleToneHandoff,
  } = appLogicHook.useContext();
  const pageState = appLogicHook.useState();
  const livePageStateValue = pageState.match({
    idle: () => "idle" as const,
    loading: () => "loading" as const,
    ready: () => "ready" as const,
    play: () => "play" as const,
    spectrum: () => "spectrum" as const,
    spectrumUpdatingMusic: () => "spectrumUpdatingMusic" as const,
    spectrumCreatingMusic: () => "spectrumCreatingMusic" as const,
    spectrumDeletingMusic: () => "spectrumDeletingMusic" as const,
    configLoading: () => "configLoading" as const,
    config: () => "config" as const,
    configUpdatingCollectionUpdates: () => "configUpdatingCollectionUpdates" as const,
    error: () => "error" as const,
  });
  const pageStateValue = surfacePageState ?? livePageStateValue;
  const playbackSurface = usePlayListPlaybackSurface({
    pageState: pageStateValue,
    playlists,
    playingPlaylistName,
    nowPlayingTrackName,
    nowPlayingTrackUrl,
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
  const releasePressedTitleLayoutId = useCallback(() => {
    if (typeof window === "undefined") {
      setPressedTitleLayoutId(null);
      return;
    }

    if (releasePressedTitleLayoutFrameRef.current !== null) {
      window.cancelAnimationFrame(releasePressedTitleLayoutFrameRef.current);
    }

    releasePressedTitleLayoutFrameRef.current = window.requestAnimationFrame(() => {
      releasePressedTitleLayoutFrameRef.current = null;
      setPressedTitleLayoutId(null);
    });
  }, []);
  const commitPressedTitleLayoutId = useCallback((layoutId?: string) => {
    if (!layoutId) {
      return;
    }

    // Motion samples the outgoing layout source before the play state commit,
    // so the pressed title must expose its handoff weight evidence in the same
    // semantic playback transaction.
    flushSync(() => {
      setPressedTitleLayoutId(layoutId);
    });
  }, []);
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
                  if (!itemViewModel.playlistName) {
                    return;
                  }

                  commitPressedTitleLayoutId(itemViewModel.layoutId);
                  appLogicAction.playPlaylist(itemViewModel.playlistName);
                  releasePressedTitleLayoutId();
                }}
                onCommit={() => {
                  if (!itemViewModel.playlistName) {
                    return;
                  }

                  appLogicAction.openPlaylist(itemViewModel.playlistName);
                }}
                onOpenSpectrum={() => {
                  const sourceLayoutId =
                    itemViewModel.layoutId ?? itemViewModel.sourceLayoutId ?? null;

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
              />
            ))}
            {viewModel.shouldRenderCreateItem ? (
              <CreateNewPlayListItem
                key={viewModel.createItemViewModel.key}
                viewModel={viewModel.createItemViewModel}
              />
            ) : null}
            <div aria-hidden className="h-[calc(50vh-1rem)] shrink-0 snap-none" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
