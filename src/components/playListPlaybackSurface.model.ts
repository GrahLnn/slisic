import type { MainStateT } from "@/src/flow/appLogic/events";

export type PlayListPlaybackSurfacePhase = "inactive" | "playing" | "restoring";

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
      displayedTrackName: string | null;
      displayedTrackLiked: boolean | null;
      displayedTrackIsPlayable: boolean;
    }
  | {
      phase: "restoring";
      playlistName: string;
      displayedTrackName: null;
      displayedTrackLiked: null;
      displayedTrackIsPlayable: false;
      restoreTransitionStarted: boolean;
    };

export interface PlayListPlaybackSurfaceSnapshot {
  phase: Exclude<PlayListPlaybackSurfacePhase, "inactive">;
  playlistName: string;
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

export function hasVisiblePlaylist(
  playlists: readonly { name: string }[],
  playlistName: string | null,
) {
  if (playlistName === null) {
    return false;
  }

  return playlists.some((playlist) => playlist.name === playlistName);
}

export function resolveMachinePlaybackTarget(args: {
  pageState: MainStateT;
  playlists: readonly { name: string }[];
  playingPlaylistName: string | null;
}) {
  if (args.pageState !== "play") {
    return null;
  }

  return hasVisiblePlaylist(args.playlists, args.playingPlaylistName)
    ? args.playingPlaylistName
    : null;
}

export function syncPlaybackSurfaceState(args: {
  current: PlayListPlaybackSurfaceState;
  machinePlaybackTarget: string | null;
  nowPlayingTrack: { liked: boolean | null; name: string; url: string } | null;
}) {
  const displayedTrackName = args.nowPlayingTrack?.name ?? null;
  const displayedTrackLiked = args.nowPlayingTrack?.liked ?? null;
  const displayedTrackIsPlayable = !!args.nowPlayingTrack?.url;

  if (args.machinePlaybackTarget !== null) {
    if (
      args.current.playlistName !== args.machinePlaybackTarget ||
      args.current.phase !== "playing"
    ) {
      return {
        phase: "playing",
        playlistName: args.machinePlaybackTarget,
        displayedTrackName,
        displayedTrackLiked,
        displayedTrackIsPlayable,
      } satisfies PlayListPlaybackSurfaceState;
    }

    if (
      displayedTrackName !== null &&
      (args.current.displayedTrackName !== displayedTrackName ||
        args.current.displayedTrackLiked !== displayedTrackLiked ||
        args.current.displayedTrackIsPlayable !== displayedTrackIsPlayable)
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
    displayedTrackName: state.displayedTrackName,
    displayedTrackLiked: state.displayedTrackLiked,
    displayedTrackIsPlayable: state.displayedTrackIsPlayable,
  };
}
