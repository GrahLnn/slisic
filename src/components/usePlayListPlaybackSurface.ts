import { useCallback, useLayoutEffect, useRef, useState, type RefCallback } from "react";
import type { TorphStage } from "@grahlnn/comps";
import type { PlaybackSurfaceStatus } from "@/src/cmd";
import type { MainStateT } from "@/src/flow/appLogic/events";
import { recordTrace } from "@/src/debug/trace";
import {
  INACTIVE_PLAYBACK_SURFACE,
  resolveMachinePlaybackTarget,
  resolvePlaybackSurfaceAfterTorphStage,
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

function tracePlaybackSurfaceState(state: PlayListPlaybackSurfaceState) {
  return {
    phase: state.phase,
    playlistName: state.playlistName,
    sessionGeneration: "sessionGeneration" in state ? state.sessionGeneration : null,
    displayedTrackName: state.displayedTrackName,
    displayedTrackLiked: state.displayedTrackLiked,
    displayedTrackIsPlayable: state.displayedTrackIsPlayable,
    restoreTransitionStarted:
      "restoreTransitionStarted" in state ? state.restoreTransitionStarted : null,
  };
}

export function usePlayListPlaybackSurface({
  pageState,
  playingPlaylistName,
  nowPlayingTrackName,
  nowPlayingTrackUrl,
  nowPlayingTrackLiked,
  playbackSurfaceStatus,
  playingSessionGeneration,
}: {
  pageState: MainStateT;
  playingPlaylistName: string | null;
  playingSessionGeneration: number | null;
  nowPlayingTrackName: string | null;
  nowPlayingTrackUrl: string | null;
  nowPlayingTrackLiked: boolean | null;
  playbackSurfaceStatus: PlaybackSurfaceStatus | null;
}) {
  const [playbackSurface, setPlaybackSurface] =
    useState<PlayListPlaybackSurfaceState>(INACTIVE_PLAYBACK_SURFACE);
  const playbackSurfaceRef = useRef<PlayListPlaybackSurfaceState>(INACTIVE_PLAYBACK_SURFACE);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const torphStagesRef = useRef<Record<string, TorphStage>>({});
  const lastCenteredTargetRef = useRef<string | null>(null);
  const machinePlaybackTarget = resolveMachinePlaybackTarget({
    pageState,
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

  const commitPlaybackSurface = useCallback((next: PlayListPlaybackSurfaceState) => {
    playbackSurfaceRef.current = next;
    setPlaybackSurface(next);
  }, []);

  const handleTorphStageChange = useCallback((key: string, stage: TorphStage) => {
    torphStagesRef.current[key] = stage;
    const current = playbackSurfaceRef.current;
    const next = resolvePlaybackSurfaceAfterTorphStage({
      current,
      playlistName: key,
      stage,
    });

    recordTrace("playlist-surface-torph-stage-change", {
      key,
      stage,
      current: tracePlaybackSurfaceState(current),
      next: tracePlaybackSurfaceState(next),
      changed: current !== next,
    });

    if (next !== current) {
      commitPlaybackSurface(next);
    }
  }, [commitPlaybackSurface]);

  useLayoutEffect(() => {
    const nowPlayingTrack =
      nowPlayingTrackName === null
        ? null
        : {
            liked: nowPlayingTrackLiked,
            name: nowPlayingTrackName,
            url: nowPlayingTrackUrl ?? "",
          };
    const current = playbackSurfaceRef.current;
    const next = syncPlaybackSurfaceState({
      current,
      machinePlaybackTarget,
      playingSessionGeneration,
      nowPlayingTrack,
      playbackSurfaceStatus,
    });

    recordTrace("playlist-surface-sync", {
      pageState,
      machinePlaybackTarget,
      playingPlaylistName,
      playingSessionGeneration,
      nowPlayingTrackName,
      nowPlayingTrackUrl,
      nowPlayingTrackLiked,
      playbackSurfaceStatus,
      current: tracePlaybackSurfaceState(current),
      next: tracePlaybackSurfaceState(next),
      changed: current !== next,
    });

    if (next !== current) {
      commitPlaybackSurface(next);
    }
  }, [
    commitPlaybackSurface,
    machinePlaybackTarget,
    nowPlayingTrackLiked,
    nowPlayingTrackName,
    nowPlayingTrackUrl,
    pageState,
    playbackSurfaceStatus,
    playingPlaylistName,
    playingSessionGeneration,
  ]);

  useLayoutEffect(() => {
    if (playbackSurface.phase !== "playing" || playbackSurface.playlistName === null) {
      recordTrace("playlist-surface-center-skipped", {
        reason: "not_playing_surface",
        playbackSurface: tracePlaybackSurfaceState(playbackSurface),
      });
      return;
    }

    const key = playbackSurface.playlistName;
    if (lastCenteredTargetRef.current === key) {
      recordTrace("playlist-surface-center-skipped", {
        reason: "already_centered_target",
        key,
        playbackSurface: tracePlaybackSurfaceState(playbackSurface),
      });
      return;
    }

    const item = itemRefs.current[key];
    const container = containerRef.current;
    if (!item || !container) {
      recordTrace("playlist-surface-center-skipped", {
        reason: !item ? "missing_item_ref" : "missing_container_ref",
        key,
        playbackSurface: tracePlaybackSurfaceState(playbackSurface),
      });
      return;
    }

    lastCenteredTargetRef.current = key;
    recordTrace("playlist-surface-center-start", {
      key,
      playbackSurface: tracePlaybackSurfaceState(playbackSurface),
    });

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
        recordTrace("playlist-surface-center-settled", {
          key,
          playbackSurface: tracePlaybackSurfaceState(playbackSurface),
        });
        return;
      }

      settleFrame = requestAnimationFrame(waitForCenter);
    };

    const frame = requestAnimationFrame(() => {
      item.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      recordTrace("playlist-surface-center-scroll-requested", {
        key,
        playbackSurface: tracePlaybackSurfaceState(playbackSurface),
      });
      settleFrame = requestAnimationFrame(waitForCenter);
    });

    return () => {
      cancelled = true;
      recordTrace("playlist-surface-center-cancelled", {
        key,
        playbackSurface: tracePlaybackSurfaceState(playbackSurface),
      });
      cancelAnimationFrame(frame);
      if (settleFrame !== null) {
        cancelAnimationFrame(settleFrame);
      }
    };
  }, [playbackSurface.phase, playbackSurface.playlistName]);

  useLayoutEffect(() => {
    if (playbackSurface.phase === "inactive" || playbackSurface.phase === "restoring") {
      recordTrace("playlist-surface-center-target-reset", {
        playbackSurface: tracePlaybackSurfaceState(playbackSurface),
        previousTarget: lastCenteredTargetRef.current,
      });
      lastCenteredTargetRef.current = null;
    }
  }, [playbackSurface.phase]);

  useLayoutEffect(() => {
    if (playbackSurface.phase !== "restoring" || playbackSurface.playlistName === null) {
      recordTrace("playlist-surface-restore-stage-sync-skipped", {
        reason: "not_restoring_surface",
        playbackSurface: tracePlaybackSurfaceState(playbackSurface),
      });
      return;
    }

    if (playbackSurface.restoreTransitionStarted) {
      recordTrace("playlist-surface-restore-stage-sync-skipped", {
        reason: "restore_transition_already_started",
        playbackSurface: tracePlaybackSurfaceState(playbackSurface),
      });
      return;
    }

    const currentStage = torphStagesRef.current[playbackSurface.playlistName];
    if (currentStage !== undefined && currentStage !== "idle") {
      const current = playbackSurfaceRef.current;
      const next = resolvePlaybackSurfaceAfterTorphStage({
        current,
        playlistName: playbackSurface.playlistName,
        stage: currentStage,
      });
      recordTrace("playlist-surface-restore-stage-sync", {
        stage: currentStage,
        current: tracePlaybackSurfaceState(current),
        next: tracePlaybackSurfaceState(next),
        changed: current !== next,
      });
      if (next !== current) {
        commitPlaybackSurface(next);
      }
    }
  }, [commitPlaybackSurface, playbackSurface]);

  return {
    playbackSurface,
    playbackSurfaceSnapshot: toPlayListPlaybackSurfaceSnapshot(playbackSurface),
    containerRef,
    setItemRef,
    handleTorphStageChange,
  };
}
