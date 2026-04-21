import { useLayoutEffect, useRef } from "react";
import type { MainStateT } from "@/src/flow/appLogic/events";
import {
  captureTorphHostFrames,
  recordTorphHostTrace,
} from "@/src/debug/torphTrace";
import type {
  PlayListPlaybackSurfacePhase,
  PlayListPlaybackSurfaceTracePayload,
} from "./playListPlaybackSurface.model";

interface UsePlayListPageTraceArgs {
  pageState: MainStateT;
  activeLayoutId: string | null;
  pressedLayoutId: string | null;
  playbackTargetKey: string | null;
  playbackSurfacePhase: PlayListPlaybackSurfacePhase;
  shouldLockScroll: boolean;
  shouldShowCreateItem: boolean;
  nowPlayingTrackName: string | null;
  playingPlaylistName: string | null;
  visibleItemKeys: readonly string[];
}

export function createPlayListPageCenteringTraceHandlers(args: {
  pageState: MainStateT;
  nowPlayingTrackName: string | null;
}) {
  return {
    onCenteringSchedule(payload: PlayListPlaybackSurfaceTracePayload) {
      recordTorphHostTrace("playlist:scroll-into-view-schedule", { ...payload });
      captureTorphHostFrames("playlist:playback-target-change", {
        frames: 48,
        payload: {
          pageState: args.pageState,
          playbackTargetKey: payload.playbackTargetKey,
          playbackSurfacePhase: payload.phase,
          nowPlayingTrackName: args.nowPlayingTrackName,
        },
      });
    },
    onCenteringExecute(payload: PlayListPlaybackSurfaceTracePayload) {
      recordTorphHostTrace("playlist:scroll-into-view-execute", { ...payload });
    },
    onCentered(payload: PlayListPlaybackSurfaceTracePayload) {
      recordTorphHostTrace("playlist:scroll-into-view-settled", { ...payload });
    },
  };
}

export function usePlayListPageTrace(args: UsePlayListPageTraceArgs) {
  const previousPageStateValueRef = useRef(args.pageState);
  const previousNowPlayingTrackNameRef = useRef(args.nowPlayingTrackName);
  const previousPlayingPlaylistNameRef = useRef(args.playingPlaylistName);
  const itemKeysSignature = args.visibleItemKeys.join("|");

  useLayoutEffect(() => {
    const previousPageStateValue = previousPageStateValueRef.current;
    const previousNowPlayingTrackName = previousNowPlayingTrackNameRef.current;
    const previousPlayingPlaylistName = previousPlayingPlaylistNameRef.current;

    if (
      previousPageStateValue !== args.pageState ||
      previousNowPlayingTrackName !== args.nowPlayingTrackName ||
      previousPlayingPlaylistName !== args.playingPlaylistName
    ) {
      recordTorphHostTrace("playlist:state-transition", {
        previousPageState: previousPageStateValue,
        pageState: args.pageState,
        previousNowPlayingTrackName,
        nowPlayingTrackName: args.nowPlayingTrackName,
        previousPlayingPlaylistName,
        playingPlaylistName: args.playingPlaylistName,
        playbackTargetKey: args.playbackTargetKey,
      });

      if (
        previousPageStateValue === "play" ||
        args.pageState === "play" ||
        previousPageStateValue === "ready" ||
        args.pageState === "ready"
      ) {
        captureTorphHostFrames("playlist:state-transition", {
          frames: 48,
          payload: {
            previousPageState: previousPageStateValue,
            pageState: args.pageState,
            previousNowPlayingTrackName,
            nowPlayingTrackName: args.nowPlayingTrackName,
            previousPlayingPlaylistName,
            playingPlaylistName: args.playingPlaylistName,
            playbackTargetKey: args.playbackTargetKey,
          },
        });
      }
    }

    previousPageStateValueRef.current = args.pageState;
    previousNowPlayingTrackNameRef.current = args.nowPlayingTrackName;
    previousPlayingPlaylistNameRef.current = args.playingPlaylistName;
  }, [
    args.nowPlayingTrackName,
    args.pageState,
    args.playbackTargetKey,
    args.playingPlaylistName,
  ]);

  useLayoutEffect(() => {
    recordTorphHostTrace("playlist:render-commit", {
      pageState: args.pageState,
      activeLayoutId: args.activeLayoutId,
      pressedLayoutId: args.pressedLayoutId,
      playbackTargetKey: args.playbackTargetKey,
      playbackSurfacePhase: args.playbackSurfacePhase,
      shouldLockScroll: args.shouldLockScroll,
      shouldShowCreateItem: args.shouldShowCreateItem,
      nowPlayingTrackName: args.nowPlayingTrackName,
      visibleItemKeys:
        itemKeysSignature.length === 0 ? [] : itemKeysSignature.split("|"),
    });
  }, [
    args.activeLayoutId,
    args.nowPlayingTrackName,
    args.pageState,
    args.playbackSurfacePhase,
    args.playbackTargetKey,
    args.pressedLayoutId,
    args.shouldLockScroll,
    args.shouldShowCreateItem,
    itemKeysSignature,
  ]);

  useLayoutEffect(() => {
    recordTorphHostTrace("playlist:playback-target-sync", {
      pageState: args.pageState,
      playbackTargetKey: args.playbackTargetKey,
      playbackSurfacePhase: args.playbackSurfacePhase,
      nowPlayingTrackName: args.nowPlayingTrackName,
    });
  }, [
    args.nowPlayingTrackName,
    args.pageState,
    args.playbackSurfacePhase,
    args.playbackTargetKey,
  ]);

  return {
    recordItemPrimaryCommit(payload: { itemKey: string; playlistName: string }) {
      recordTorphHostTrace("playlist:item-primary-commit", payload);
      captureTorphHostFrames("playlist:item-primary-commit", {
        frames: 48,
        payload,
      });
    },
    recordItemPress(payload: { itemKey: string; layoutId: string }) {
      recordTorphHostTrace("playlist:item-press", payload);
    },
    recordItemConfigCommit(payload: { itemKey: string; playlistName: string }) {
      recordTorphHostTrace("playlist:item-config-commit", payload);
    },
    recordCreatePress(payload: { layoutId: string }) {
      recordTorphHostTrace("playlist:create-press", payload);
    },
  };
}
