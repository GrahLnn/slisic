import { useCallback, useLayoutEffect, useRef, useState, type RefCallback } from "react";
import type { TorphStage } from "@grahlnn/comps";
import type { MainStateT } from "@/src/flow/appLogic/events";
import {
  INACTIVE_PLAYBACK_SURFACE,
  resolveMachinePlaybackTarget,
  syncPlaybackSurfaceState,
  toPlayListPlaybackSurfaceSnapshot,
  type PlayListPlaybackSurfaceState,
  type PlayListPlaybackSurfaceTracePayload,
} from "./playListPlaybackSurface.model";

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

export function usePlayListPlaybackSurface(args: {
  pageState: MainStateT;
  playlists: readonly { name: string }[];
  playingPlaylistName: string | null;
  nowPlayingTrackName: string | null;
  onCenteringSchedule?: (payload: PlayListPlaybackSurfaceTracePayload) => void;
  onCenteringExecute?: (payload: PlayListPlaybackSurfaceTracePayload) => void;
  onCentered?: (payload: PlayListPlaybackSurfaceTracePayload) => void;
}) {
  const [playbackSurface, setPlaybackSurface] = useState<PlayListPlaybackSurfaceState>(
    INACTIVE_PLAYBACK_SURFACE,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const torphStagesRef = useRef<Record<string, TorphStage>>({});
  const machinePlaybackTarget = resolveMachinePlaybackTarget({
    pageState: args.pageState,
    playlists: args.playlists,
    playingPlaylistName: args.playingPlaylistName,
  });

  const setItemRef = useCallback(
    (key: string): RefCallback<HTMLDivElement> =>
      (node) => {
        if (node) {
          itemRefs.current[key] = node;
          return;
        }

        delete itemRefs.current[key];
      },
    [],
  );

  const handleTorphStageChange = useCallback((key: string, stage: TorphStage) => {
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
  }, []);

  useLayoutEffect(() => {
    setPlaybackSurface((current) =>
      syncPlaybackSurfaceState({
        current,
        machinePlaybackTarget,
        nowPlayingTrackName: args.nowPlayingTrackName,
      }),
    );
  }, [args.nowPlayingTrackName, machinePlaybackTarget]);

  useLayoutEffect(() => {
    if (
      playbackSurface.phase !== "centering" ||
      playbackSurface.playlistName === null
    ) {
      return;
    }

    const key = playbackSurface.playlistName;
    const item = itemRefs.current[key];
    const container = containerRef.current;
    if (!item || !container) {
      return;
    }

    const payload = {
      playbackTargetKey: key,
      phase: playbackSurface.phase,
      containerScrollTop: container.scrollTop,
    } satisfies PlayListPlaybackSurfaceTracePayload;
    args.onCenteringSchedule?.(payload);

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
          displayedTrackName: args.nowPlayingTrackName,
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
        args.onCentered?.({
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
      const currentContainer = containerRef.current;
      args.onCenteringExecute?.({
        playbackTargetKey: key,
        phase: playbackSurface.phase,
        containerScrollTop: currentContainer?.scrollTop ?? 0,
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
    args.nowPlayingTrackName,
    args.onCentered,
    args.onCenteringExecute,
    args.onCenteringSchedule,
    playbackSurface.phase,
    playbackSurface.playlistName,
  ]);

  useLayoutEffect(() => {
    if (
      playbackSurface.phase !== "restoring" ||
      playbackSurface.playlistName === null
    ) {
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

  return {
    playbackSurface,
    playbackSurfaceSnapshot: toPlayListPlaybackSurfaceSnapshot(playbackSurface),
    containerRef,
    setItemRef,
    handleTorphStageChange,
  };
}
