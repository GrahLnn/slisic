import { useCallback, useState, type RefCallback } from "react";
import { useIsPresent } from "motion/react";
import { cn } from "@/lib/utils";
import { CREATE_COLLECTION_LAYOUT_ID } from "@/src/flow/appLogic/core";
import { action as appLogicAction, hook as appLogicHook } from "@/src/flow/appLogic";
import { usePageRenderFreeze } from "./usePageRenderFreeze";
import { PlayListPageItem, CreateNewPlayListItem } from "./PlayListPageItem";
import { usePlayListPlaybackSurface } from "./usePlayListPlaybackSurface";
import { resolvePlayListPageViewModel } from "./PlayListPage.view-model";
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
  const [pressedLayoutId, setPressedLayoutId] = useState<string | null>(null);
  const pageStateValue = pageState.match({
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
  const liveRenderData = {
    pageState: pageStateValue,
    activeLayoutId,
    hasPlayList,
    playlists,
    pendingPlaylistPreview,
    playingPlaylistName,
    titleToneHandoff,
    pressedLayoutId,
    playbackSurface: playbackSurface.playbackSurfaceSnapshot,
  } as const;
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
                onPrimaryCommit={() => {
                  if (!itemViewModel.playlistName) {
                    return;
                  }

                  appLogicAction.playPlaylist(itemViewModel.playlistName);
                }}
                onPointerDown={() => {
                  if (!itemViewModel.layoutId) {
                    return;
                  }

                  setPressedLayoutId(itemViewModel.layoutId);
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
                onPointerDown={() => {
                  setPressedLayoutId(CREATE_COLLECTION_LAYOUT_ID);
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
