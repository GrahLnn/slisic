import { useCallback, useLayoutEffect, useRef, useState, type Ref } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import type { TorphStage } from "@grahlnn/comps";
import { cn } from "@/lib/utils";
import { CREATE_COLLECTION_LAYOUT_ID } from "@/src/flow/appLogic/core";
import {
  action as appLogicAction,
  hook as appLogicHook,
} from "@/src/flow/appLogic";
import {
  collectionTitleClassName,
  collectionTitleLayoutTransition,
  collectionTitleTextHoverClassName,
} from "./collectionTitle";
import { PlayItem } from "./playItem";
import { usePageRenderFreeze } from "./usePageRenderFreeze";
import {
  captureTorphHostFrames,
  recordTorphHostTrace,
} from "@/src/debug/torphTrace";
import {
  resolvePlayListPageItemFadeProps,
  resolvePlayListPageViewModel,
  shouldCommitPlayListPageItem,
  type PlayListPageItemViewModel,
} from "./PlayListPage.view-model";

type PlaybackSurfacePhase = "inactive" | "centering" | "playing" | "restoring";

type PlaybackSurfaceState = {
  phase: PlaybackSurfacePhase;
  playlistName: string | null;
  displayedTrackName: string | null;
};

const INACTIVE_PLAYBACK_SURFACE: PlaybackSurfaceState = {
  phase: "inactive",
  playlistName: null,
  displayedTrackName: null,
};

function hasVisiblePlaylist(
  playlists: readonly { name: string }[],
  playlistName: string | null,
) {
  if (playlistName === null) {
    return false;
  }

  return playlists.some((playlist) => playlist.name === playlistName);
}

function isPlaybackItemCentered(
  container: HTMLElement,
  item: HTMLElement,
  tolerancePx = 1.5,
) {
  const containerRect = container.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const containerCenterY = containerRect.top + containerRect.height / 2;
  const itemCenterY = itemRect.top + itemRect.height / 2;

  return Math.abs(itemCenterY - containerCenterY) <= tolerancePx;
}

function PlayListPageItem({
  viewModel,
  containerRef,
  onPrimaryCommit,
  onPrimaryPointerDown,
  onPointerDown,
  onTorphStageChange,
  onCommit,
}: {
  viewModel: PlayListPageItemViewModel;
  containerRef?: Ref<HTMLDivElement>;
  onPrimaryCommit?: () => void;
  onPrimaryPointerDown?: () => void;
  onPointerDown?: () => void;
  onTorphStageChange?: (stage: TorphStage) => void;
  onCommit: () => void;
}) {
  const isPresent = useIsPresent();
  const fadeProps = resolvePlayListPageItemFadeProps({
    isPresent,
    suppressFade: viewModel.suppressFade,
  });

  const item = (
    <PlayItem
      className={collectionTitleClassName}
      handoffTone={viewModel.handoffTone}
      layoutId={viewModel.layoutId}
      traceKey={viewModel.key}
      traceRole={
        viewModel.layoutId === CREATE_COLLECTION_LAYOUT_ID
          ? "playlist-create"
          : "playlist-item"
      }
      tracePlaybackTarget={viewModel.isPlaybackTarget}
      traceHiddenInPlay={viewModel.isHiddenInPlay}
      shouldAnimateLayoutPosition={viewModel.shouldAnimateLayoutPosition}
      text={viewModel.text}
      textClassName={viewModel.isCommitted ? collectionTitleTextHoverClassName : undefined}
      onTorphStageChange={onTorphStageChange}
      onPointerDown={(event) => {
        if (event.button === 0) {
          onPrimaryPointerDown?.();
        }

        if (
          shouldCommitPlayListPageItem({
            button: event.button,
            gesture: viewModel.commitGesture,
          })
        ) {
          onPointerDown?.();
        }
      }}
      onClick={() => {
        onPrimaryCommit?.();

        if (
          shouldCommitPlayListPageItem({
            button: 0,
            gesture: viewModel.commitGesture,
          })
        ) {
          onCommit();
        }
      }}
      onContextMenu={() => {
        if (
          shouldCommitPlayListPageItem({
            button: 2,
            gesture: viewModel.commitGesture,
          })
        ) {
          onCommit();
        }
      }}
    />
  );

  return (
    <motion.div
      ref={containerRef}
      layout={viewModel.shouldAnimateLayoutPosition ? "position" : false}
      className="shrink-0 snap-center"
      exit={fadeProps.exit}
      initial={fadeProps.initial}
      animate={fadeProps.animate}
      transition={collectionTitleLayoutTransition}
    >
      <motion.div
        className={cn(
          viewModel.isHiddenInPlay && "pointer-events-none select-none",
        )}
        animate={
          viewModel.isHiddenInPlay
            ? { filter: "blur(6px)", opacity: 0 }
            : { filter: "blur(0px)", opacity: 1 }
        }
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        {item}
      </motion.div>
    </motion.div>
  );
}

function CreateNewItem({
  viewModel,
  onPointerDown,
}: {
  viewModel: PlayListPageItemViewModel;
  onPointerDown?: () => void;
}) {
  return (
    <PlayListPageItem
      viewModel={viewModel}
      onPointerDown={onPointerDown}
      onCommit={() => {
        appLogicAction.openCreate();
      }}
    />
  );
}

export function PlayListPage() {
  const isPresent = useIsPresent();
  const {
    activeLayoutId,
    hasPlayList,
    playlists,
    pendingPlaylistPreview,
    playingPlaylistName,
    nowPlayingTrackName,
    titleToneHandoff,
  } = appLogicHook.useContext();
  const pageState = appLogicHook.useState();
  const [pressedLayoutId, setPressedLayoutId] = useState<string | null>(null);
  const pageStateValue = pageState.match({
    idle: () => "idle" as const,
    loading: () => "loading" as const,
    ready: () => "ready" as const,
    play: () => "play" as const,
    configLoading: () => "configLoading" as const,
    config: () => "config" as const,
    configUpdatingCollectionUpdates: () =>
      "configUpdatingCollectionUpdates" as const,
    error: () => "error" as const,
  });
  const [playbackSurface, setPlaybackSurface] = useState<PlaybackSurfaceState>(
    INACTIVE_PLAYBACK_SURFACE,
  );
  const visibleMachinePlaybackTarget =
    pageStateValue === "play" && hasVisiblePlaylist(playlists, playingPlaylistName)
      ? playingPlaylistName
      : null;
  const liveRenderData = {
    pageState: pageStateValue,
    activeLayoutId,
    hasPlayList,
    playlists,
    pendingPlaylistPreview,
    playingPlaylistName,
    nowPlayingTrackName,
    playbackSurfaceTargetName: playbackSurface.playlistName,
    playbackSurfaceTrackName: playbackSurface.displayedTrackName,
    titleToneHandoff,
    pressedLayoutId,
  } as const;
  const pageRenderFreeze = usePageRenderFreeze(liveRenderData, {
    isPresent,
    freezeOnExit: true,
  });
  const renderData = pageRenderFreeze.renderValue;
  const viewModel = resolvePlayListPageViewModel(renderData);
  const itemKeysSignature = viewModel.itemViewModels.map((item) => item.key).join("|");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const torphStagesRef = useRef<Record<string, TorphStage>>({});
  const lastScrolledPlaybackTargetKeyRef = useRef<string | null>(null);
  const previousPageStateValueRef = useRef(pageStateValue);
  const previousNowPlayingTrackNameRef = useRef(nowPlayingTrackName);
  const previousPlayingPlaylistNameRef = useRef(playingPlaylistName);
  const setItemRef = useCallback(
    (key: string): React.RefCallback<HTMLDivElement> =>
      (node) => {
        if (node) {
          itemRefs.current[key] = node;
          return;
        }

        delete itemRefs.current[key];
      },
    [],
  );
  const handleTorphStageChange = useCallback(
    (key: string, stage: TorphStage) => {
      torphStagesRef.current[key] = stage;
      if (stage !== "idle") {
        return;
      }

      setPlaybackSurface((current) => {
        if (current.phase !== "restoring" || current.playlistName !== key) {
          return current;
        }

        return INACTIVE_PLAYBACK_SURFACE;
      });
    },
    [],
  );

  useLayoutEffect(() => {
    setPlaybackSurface((current) => {
      if (visibleMachinePlaybackTarget !== null) {
        if (current.playlistName !== visibleMachinePlaybackTarget) {
          return {
            phase: "centering",
            playlistName: visibleMachinePlaybackTarget,
            displayedTrackName: null,
          };
        }

        if (current.phase === "inactive") {
          return {
            phase: "centering",
            playlistName: visibleMachinePlaybackTarget,
            displayedTrackName: null,
          };
        }

        if (current.phase === "playing" && nowPlayingTrackName !== null) {
          if (current.displayedTrackName === nowPlayingTrackName) {
            return current;
          }

          return {
            ...current,
            displayedTrackName: nowPlayingTrackName,
          };
        }

        return current;
      }

      if (current.playlistName === null) {
        return current.phase === "inactive" ? current : INACTIVE_PLAYBACK_SURFACE;
      }

      if (current.phase === "restoring" && current.displayedTrackName === null) {
        return current;
      }

      return {
        phase: "restoring",
        playlistName: current.playlistName,
        displayedTrackName: null,
      };
    });
  }, [nowPlayingTrackName, visibleMachinePlaybackTarget]);

  useLayoutEffect(() => {
    if (playbackSurface.phase !== "centering" || playbackSurface.playlistName === null) {
      return;
    }

    const key = playbackSurface.playlistName;
    const item = itemRefs.current[key];
    const container = containerRef.current;
    if (!item || !container) {
      return;
    }

    lastScrolledPlaybackTargetKeyRef.current = key;
    recordTorphHostTrace("playlist:scroll-into-view-schedule", {
      playbackTargetKey: key,
      phase: playbackSurface.phase,
      containerScrollTop: container.scrollTop,
    });
    captureTorphHostFrames("playlist:playback-target-change", {
      frames: 48,
      payload: {
        pageState: pageStateValue,
        playbackTargetKey: key,
        playbackSurfacePhase: playbackSurface.phase,
        nowPlayingTrackName,
      },
    });

    let cancelled = false;
    let settleFrame: number | null = null;
    const promoteToPlaying = () => {
      setPlaybackSurface((current) => {
        if (current.phase !== "centering" || current.playlistName !== key) {
          return current;
        }

        return {
          phase: "playing",
          playlistName: key,
          displayedTrackName: nowPlayingTrackName,
        };
      });
    };

    const waitForCenter = () => {
      if (cancelled) {
        return;
      }

      const currentItem = itemRefs.current[key];
      const currentContainer = containerRef.current;
      if (!currentItem || !currentContainer) {
        return;
      }

      if (isPlaybackItemCentered(currentContainer, currentItem)) {
        recordTorphHostTrace("playlist:scroll-into-view-settled", {
          playbackTargetKey: key,
          phase: playbackSurface.phase,
          containerScrollTop: currentContainer.scrollTop,
        });
        promoteToPlaying();
        return;
      }

      settleFrame = requestAnimationFrame(waitForCenter);
    };

    const frame = requestAnimationFrame(() => {
      recordTorphHostTrace("playlist:scroll-into-view-execute", {
        playbackTargetKey: key,
        phase: playbackSurface.phase,
        containerScrollTop: container.scrollTop,
      });
      item.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      settleFrame = requestAnimationFrame(waitForCenter);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (settleFrame !== null) {
        cancelAnimationFrame(settleFrame);
      }
    };
  }, [
    nowPlayingTrackName,
    pageStateValue,
    playbackSurface.phase,
    playbackSurface.playlistName,
  ]);

  useLayoutEffect(() => {
    if (playbackSurface.phase !== "restoring" || playbackSurface.playlistName === null) {
      return;
    }

    if (torphStagesRef.current[playbackSurface.playlistName] !== "idle") {
      return;
    }

    setPlaybackSurface((current) => {
      if (
        current.phase !== "restoring" ||
        current.playlistName !== playbackSurface.playlistName
      ) {
        return current;
      }

      return INACTIVE_PLAYBACK_SURFACE;
    });
  }, [playbackSurface.phase, playbackSurface.playlistName]);

  useLayoutEffect(() => {
    const previousPageStateValue = previousPageStateValueRef.current;
    const previousNowPlayingTrackName = previousNowPlayingTrackNameRef.current;
    const previousPlayingPlaylistName = previousPlayingPlaylistNameRef.current;

    if (
      previousPageStateValue !== pageStateValue ||
      previousNowPlayingTrackName !== nowPlayingTrackName ||
      previousPlayingPlaylistName !== playingPlaylistName
    ) {
      recordTorphHostTrace("playlist:state-transition", {
        previousPageState: previousPageStateValue,
        pageState: pageStateValue,
        previousNowPlayingTrackName,
        nowPlayingTrackName,
        previousPlayingPlaylistName,
        playingPlaylistName,
        playbackTargetKey: viewModel.playbackTargetKey,
      });

      if (
        previousPageStateValue === "play" ||
        pageStateValue === "play" ||
        previousPageStateValue === "ready" ||
        pageStateValue === "ready"
      ) {
        captureTorphHostFrames("playlist:state-transition", {
          frames: 48,
          payload: {
            previousPageState: previousPageStateValue,
            pageState: pageStateValue,
            previousNowPlayingTrackName,
            nowPlayingTrackName,
            previousPlayingPlaylistName,
            playingPlaylistName,
            playbackTargetKey: viewModel.playbackTargetKey,
          },
        });
      }
    }

    previousPageStateValueRef.current = pageStateValue;
    previousNowPlayingTrackNameRef.current = nowPlayingTrackName;
    previousPlayingPlaylistNameRef.current = playingPlaylistName;
  }, [
    nowPlayingTrackName,
    pageStateValue,
    playingPlaylistName,
    viewModel.playbackTargetKey,
  ]);

  useLayoutEffect(() => {
    recordTorphHostTrace("playlist:render-commit", {
      pageState: pageStateValue,
      activeLayoutId,
      pressedLayoutId,
      playbackTargetKey: viewModel.playbackTargetKey,
      playbackSurfacePhase: playbackSurface.phase,
      shouldLockScroll: viewModel.shouldLockScroll,
      shouldShowCreateItem: viewModel.shouldShowCreateItem,
      nowPlayingTrackName,
      visibleItemKeys:
        itemKeysSignature.length === 0 ? [] : itemKeysSignature.split("|"),
    });
  }, [
    activeLayoutId,
    itemKeysSignature,
    nowPlayingTrackName,
    pageStateValue,
    playbackSurface.phase,
    pressedLayoutId,
    viewModel.playbackTargetKey,
    viewModel.shouldLockScroll,
    viewModel.shouldShowCreateItem,
  ]);

  useLayoutEffect(() => {
    recordTorphHostTrace("playlist:playback-target-sync", {
      pageState: pageStateValue,
      playbackTargetKey: viewModel.playbackTargetKey,
      playbackSurfacePhase: playbackSurface.phase,
      nowPlayingTrackName,
    });

    if (!viewModel.playbackTargetKey) {
      lastScrolledPlaybackTargetKeyRef.current = null;
    }
  }, [
    nowPlayingTrackName,
    pageStateValue,
    playbackSurface.phase,
    viewModel.playbackTargetKey,
  ]);

  return (
    <div
      data-title-trace-root="playlist-page"
      data-torph-trace-root="playlist-page"
      data-torph-trace-page-state={pageStateValue}
      data-page-state="playlist"
      className="relative h-[calc(100vh-2rem)] w-full overflow-hidden px-6"
      style={{ fontFamily: "var(--font-noto-sans)" }}
    >
      {viewModel.shouldRenderContent ? (
        <div className="relative z-0 flex h-full w-full flex-col items-center">
          <div
            ref={containerRef}
            data-torph-trace-scroll-root="playlist-scroll"
            className={cn(
              "hide-scrollbar flex h-full w-full flex-col items-center gap-8 snap-y snap-mandatory overscroll-y-contain",
              viewModel.shouldLockScroll ? "overflow-hidden" : "overflow-y-auto",
            )}
          >
            <div
              aria-hidden
              className="h-[calc(50vh-1rem)] shrink-0 snap-none"
            />
            <AnimatePresence initial={false} mode="popLayout">
              {viewModel.itemViewModels.map((itemViewModel) => (
                <PlayListPageItem
                  key={itemViewModel.key}
                  containerRef={setItemRef(itemViewModel.key)}
                  viewModel={itemViewModel}
                  onTorphStageChange={(stage) => {
                    handleTorphStageChange(itemViewModel.key, stage);
                  }}
                  onPrimaryCommit={() => {
                    if (!itemViewModel.playlistName) {
                      return;
                    }

                    recordTorphHostTrace("playlist:item-primary-commit", {
                      itemKey: itemViewModel.key,
                      playlistName: itemViewModel.playlistName,
                    });
                    captureTorphHostFrames("playlist:item-primary-commit", {
                      frames: 48,
                      payload: {
                        itemKey: itemViewModel.key,
                        playlistName: itemViewModel.playlistName,
                      },
                    });
                    appLogicAction.playPlaylist(itemViewModel.playlistName);
                  }}
                  onPointerDown={() => {
                    if (!itemViewModel.layoutId) {
                      return;
                    }

                    recordTorphHostTrace("playlist:item-press", {
                      itemKey: itemViewModel.key,
                      layoutId: itemViewModel.layoutId,
                    });
                    setPressedLayoutId(itemViewModel.layoutId);
                  }}
                  onCommit={() => {
                    if (!itemViewModel.playlistName) {
                      return;
                    }

                    recordTorphHostTrace("playlist:item-config-commit", {
                      itemKey: itemViewModel.key,
                      playlistName: itemViewModel.playlistName,
                    });
                    appLogicAction.openPlaylist(itemViewModel.playlistName);
                  }}
                />
              ))}
              {viewModel.shouldShowCreateItem ? (
                <CreateNewItem
                  key={viewModel.createItemViewModel.key}
                  viewModel={viewModel.createItemViewModel}
                  onPointerDown={() => {
                    recordTorphHostTrace("playlist:create-press", {
                      layoutId: CREATE_COLLECTION_LAYOUT_ID,
                    });
                    setPressedLayoutId(CREATE_COLLECTION_LAYOUT_ID);
                  }}
                />
              ) : null}
            </AnimatePresence>
            <div
              aria-hidden
              className="h-[calc(50vh-1rem)] shrink-0 snap-none"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
