import { useCallback, type RefCallback } from "react";
import { useIsPresent } from "motion/react";
import { cn } from "@/lib/utils";
import { action as appLogicAction, hook as appLogicHook } from "@/src/flow/appLogic";
import { recordRenderPerformanceTrace } from "@/src/debug/renderPerformanceTrace";
import { usePageRenderFreeze } from "./usePageRenderFreeze";
import { PlayListPageItem, CreateNewPlayListItem } from "./PlayListPageItem";
import { usePlayListPlaybackSurface } from "./usePlayListPlaybackSurface";
import {
  resolvePlayListPageViewModel,
  type PlayListPageRenderData,
} from "./PlayListPage.view-model";
import {
  recordStoredScrollTop,
  restoreStoredScrollTop,
  type ScrollPositionRef,
} from "./scrollPosition";

export function PlayListPage({ scrollPositionRef }: { scrollPositionRef: ScrollPositionRef }) {
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
  const pageStateValue = pageState.match({
    idle: () => "idle" as const,
    loading: () => "loading" as const,
    ready: () => "ready" as const,
    play: () => "play" as const,
    spectrumLoadingMusics: () => "spectrumLoadingMusics" as const,
    spectrum: () => "spectrum" as const,
    spectrumUpdatingMusic: () => "spectrumUpdatingMusic" as const,
    spectrumDeletingMusic: () => "spectrumDeletingMusic" as const,
    configLoading: () => "configLoading" as const,
    config: () => "config" as const,
    configUpdatingCollectionUpdates: () => "configUpdatingCollectionUpdates" as const,
    error: () => "error" as const,
  });
  const playbackSurface = usePlayListPlaybackSurface({
    pageState: pageStateValue,
    playlists,
    playingPlaylistName,
    nowPlayingTrackName,
    nowPlayingTrackUrl,
  });
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
    pressedLayoutId: null,
    playbackSurface: playbackSurface.playbackSurfaceSnapshot,
  };
  const pageRenderFreeze = usePageRenderFreeze(liveRenderData, {
    isPresent,
    freezeOnExit: true,
  });
  const renderData = pageRenderFreeze.renderValue;
  const viewModel = resolvePlayListPageViewModel(renderData);
  recordRenderPerformanceTrace("playlist-title-handoff-render", {
    activeLayoutId: renderData.activeLayoutId,
    committedLayoutId: viewModel.committedLayoutId,
    isPresent,
    pageState: renderData.pageState,
    playbackSurface: renderData.playbackSurface
      ? {
          phase: renderData.playbackSurface.phase,
          playlistName: renderData.playbackSurface.playlistName,
          displayedTrackName: renderData.playbackSurface.displayedTrackName,
        }
      : null,
    playingPlaylistName: renderData.playingPlaylistName,
    titleToneHandoffLayoutId: renderData.titleToneHandoff?.layoutId ?? null,
    titleToneHandoffTone: renderData.titleToneHandoff?.tone ?? null,
    transitionReturnTargetLayoutId: viewModel.transition.returnTargetLayoutId,
    items: viewModel.itemViewModels.map((item) => ({
      key: item.key,
      layoutId: item.layoutId ?? null,
      sourceLayoutId: item.sourceLayoutId ?? null,
      text: item.text,
      titleHoverVisual: item.titleHoverVisual,
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
                onPrimaryCommit={() => {
                  if (!itemViewModel.playlistName) {
                    return;
                  }

                  appLogicAction.playPlaylist(itemViewModel.playlistName);
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
