import { useCallback, useLayoutEffect, useRef, useState, type RefCallback } from "react";
import type { TorphStage } from "@grahlnn/comps";
import type { MainStateT } from "@/src/flow/appLogic/events";
import {
  INACTIVE_PLAYBACK_SURFACE,
  resolveMachinePlaybackTarget,
  syncPlaybackSurfaceState,
  toPlayListPlaybackSurfaceSnapshot,
  type PlayListPlaybackSurfaceState,
} from "./playListPlaybackSurface.model";

function isPlaybackItemCentered(container: HTMLElement, item: HTMLElement, tolerancePx = 1.5) {
  const containerRect = container.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const containerCenterY = containerRect.top + containerRect.height / 2;
  const itemCenterY = itemRect.top + itemRect.height / 2;

  return Math.abs(itemCenterY - containerCenterY) <= tolerancePx;
}

export function usePlayListPlaybackSurface({
  pageState,
  playlists,
  playingPlaylistName,
  nowPlayingTrackName,
  nowPlayingTrackUrl,
}: {
  pageState: MainStateT;
  playlists: readonly { name: string }[];
  playingPlaylistName: string | null;
  nowPlayingTrackName: string | null;
  nowPlayingTrackUrl: string | null;
}) {
  const [playbackSurface, setPlaybackSurface] =
    useState<PlayListPlaybackSurfaceState>(INACTIVE_PLAYBACK_SURFACE);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const torphStagesRef = useRef<Record<string, TorphStage>>({});
  const lastCenteredTargetRef = useRef<string | null>(null);
  const machinePlaybackTarget = resolveMachinePlaybackTarget({
    pageState,
    playlists,
    playingPlaylistName,
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
    setPlaybackSurface((current) => {
      const next = syncPlaybackSurfaceState({
        current,
        machinePlaybackTarget,
        nowPlayingTrack:
          nowPlayingTrackName === null
            ? null
            : {
                name: nowPlayingTrackName,
                url: nowPlayingTrackUrl ?? "",
              },
      });

      return next;
    });
  }, [machinePlaybackTarget, nowPlayingTrackName, nowPlayingTrackUrl]);

  useLayoutEffect(() => {
    if (playbackSurface.phase !== "playing" || playbackSurface.playlistName === null) {
      return;
    }

    const key = playbackSurface.playlistName;
    if (lastCenteredTargetRef.current === key) {
      return;
    }

    const item = itemRefs.current[key];
    const container = containerRef.current;
    if (!item || !container) {
      return;
    }

    lastCenteredTargetRef.current = key;

    let cancelled = false;
    let settleFrame: number | null = null;

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
        return;
      }

      settleFrame = requestAnimationFrame(waitForCenter);
    };

    const frame = requestAnimationFrame(() => {
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
  }, [playbackSurface.phase, playbackSurface.playlistName]);

  useLayoutEffect(() => {
    if (playbackSurface.phase === "inactive" || playbackSurface.phase === "restoring") {
      lastCenteredTargetRef.current = null;
    }
  }, [playbackSurface.phase]);

  useLayoutEffect(() => {
    if (playbackSurface.phase !== "restoring" || playbackSurface.playlistName === null) {
      return;
    }

    if (torphStagesRef.current[playbackSurface.playlistName] !== "idle") {
      return;
    }

    setPlaybackSurface((current) => {
      if (current.phase !== "restoring" || current.playlistName !== playbackSurface.playlistName) {
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
