import type { MainStateT } from "@/src/flow/appLogic/events";
import type { PlaybackSurfaceStatus } from "@/src/cmd";

export type PlayListPlaybackSurfacePhase = "inactive" | "playing" | "restoring";
const PREPARING_PLAYBACK_SURFACE_TEXT = "Preparing...";

export type PlayListPlaybackSurfaceState =
  | {
      phase: "inactive";
      playlistName: null;
      displayedTrackName: null;
      displayedTrackLiked: null;
      displayedTrackIsPlayable: false;
    }
  | {
      phase: "playing";
      playlistName: string;
      sessionGeneration: number;
      displayedTrackName: string | null;
      displayedTrackLiked: boolean | null;
      displayedTrackIsPlayable: boolean;
    }
  | {
      phase: "restoring";
      playlistName: string;
      sessionGeneration: number;
      displayedTrackName: null;
      displayedTrackLiked: null;
      displayedTrackIsPlayable: false;
      restoreTransitionStarted: boolean;
    };

export interface PlayListPlaybackSurfaceSnapshot {
  phase: Exclude<PlayListPlaybackSurfacePhase, "inactive">;
  playlistName: string;
  sessionGeneration: number;
  displayedTrackName: string | null;
  displayedTrackLiked: boolean | null;
  displayedTrackIsPlayable: boolean;
}

export const INACTIVE_PLAYBACK_SURFACE: PlayListPlaybackSurfaceState = {
  phase: "inactive",
  playlistName: null,
  displayedTrackName: null,
  displayedTrackLiked: null,
  displayedTrackIsPlayable: false,
};

export type PlaybackSurfaceCenterRequest =
  | {
      shouldRequest: true;
      target: string;
      nextRequestedTarget: string;
      reason: "new_playing_target";
    }
  | {
      shouldRequest: false;
      target: null;
      nextRequestedTarget: string | null;
      reason: "already_requested_target" | "not_playing_surface";
    };

export function resolvePlaybackSurfaceCenterRequest(args: {
  lastRequestedTarget: string | null;
  playbackSurface: PlayListPlaybackSurfaceState;
}): PlaybackSurfaceCenterRequest {
  if (args.playbackSurface.phase !== "playing" || args.playbackSurface.playlistName === null) {
    return {
      shouldRequest: false,
      target: null,
      nextRequestedTarget: null,
      reason: "not_playing_surface",
    };
  }

  if (args.lastRequestedTarget === args.playbackSurface.playlistName) {
    return {
      shouldRequest: false,
      target: null,
      nextRequestedTarget: args.lastRequestedTarget,
      reason: "already_requested_target",
    };
  }

  return {
    shouldRequest: true,
    target: args.playbackSurface.playlistName,
    nextRequestedTarget: args.playbackSurface.playlistName,
    reason: "new_playing_target",
  };
}

export function resolveMachinePlaybackTarget(args: {
  pageState: MainStateT;
  playingPlaylistName: string | null;
}) {
  if (args.pageState !== "play") {
    return null;
  }

  return args.playingPlaylistName;
}

export function syncPlaybackSurfaceState(args: {
  current: PlayListPlaybackSurfaceState;
  machinePlaybackTarget: string | null;
  playingSessionGeneration: number | null;
  nowPlayingTrack: { liked: boolean | null; name: string; url: string } | null;
  playbackSurfaceStatus: PlaybackSurfaceStatus | null;
}) {
  const displayedTrackName =
    args.nowPlayingTrack?.name ??
    (args.playbackSurfaceStatus === "preparing" ? PREPARING_PLAYBACK_SURFACE_TEXT : null);
  const displayedTrackLiked = args.nowPlayingTrack?.liked === true ? true : null;
  const displayedTrackIsPlayable = !!args.nowPlayingTrack?.url;

  if (args.machinePlaybackTarget !== null && args.playingSessionGeneration !== null) {
    if (
      args.current.playlistName !== args.machinePlaybackTarget ||
      args.current.phase !== "playing" ||
      args.current.sessionGeneration !== args.playingSessionGeneration
    ) {
      return {
        phase: "playing",
        playlistName: args.machinePlaybackTarget,
        sessionGeneration: args.playingSessionGeneration,
        displayedTrackName,
        displayedTrackLiked,
        displayedTrackIsPlayable,
      } satisfies PlayListPlaybackSurfaceState;
    }

    if (
      args.current.displayedTrackName !== displayedTrackName ||
      args.current.displayedTrackLiked !== displayedTrackLiked ||
      args.current.displayedTrackIsPlayable !== displayedTrackIsPlayable
    ) {
      return {
        ...args.current,
        displayedTrackName,
        displayedTrackLiked,
        displayedTrackIsPlayable,
      };
    }

    return args.current;
  }

  if (args.current.playlistName === null) {
    return args.current.phase === "inactive" ? args.current : INACTIVE_PLAYBACK_SURFACE;
  }

  if (args.current.phase === "restoring") {
    return args.current;
  }

  if (
    args.current.displayedTrackName === null ||
    args.current.displayedTrackName === args.current.playlistName
  ) {
    return INACTIVE_PLAYBACK_SURFACE;
  }

  return {
    phase: "restoring",
    playlistName: args.current.playlistName,
    sessionGeneration: args.current.sessionGeneration,
    displayedTrackName: null,
    displayedTrackLiked: null,
    displayedTrackIsPlayable: false,
    restoreTransitionStarted: false,
  } satisfies PlayListPlaybackSurfaceState;
}

export function resolvePlaybackSurfaceAfterTorphStage(args: {
  current: PlayListPlaybackSurfaceState;
  playlistName: string;
  stage: "idle" | "prepare" | "animate";
}) {
  if (args.current.phase !== "restoring" || args.current.playlistName !== args.playlistName) {
    return args.current;
  }

  if (args.stage !== "idle") {
    return args.current.restoreTransitionStarted
      ? args.current
      : ({
          ...args.current,
          restoreTransitionStarted: true,
        } satisfies PlayListPlaybackSurfaceState);
  }

  return args.current.restoreTransitionStarted ? INACTIVE_PLAYBACK_SURFACE : args.current;
}

export function toPlayListPlaybackSurfaceSnapshot(
  state: PlayListPlaybackSurfaceState,
): PlayListPlaybackSurfaceSnapshot | null {
  if (state.phase === "inactive" || state.playlistName === null) {
    return null;
  }

  return {
    phase: state.phase,
    playlistName: state.playlistName,
    sessionGeneration: state.sessionGeneration,
    displayedTrackName: state.displayedTrackName,
    displayedTrackLiked: state.displayedTrackLiked,
    displayedTrackIsPlayable: state.displayedTrackIsPlayable,
  };
}
