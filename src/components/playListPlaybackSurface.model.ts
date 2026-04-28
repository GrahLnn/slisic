import type { MainStateT } from "@/src/flow/appLogic/events";

export type PlayListPlaybackSurfacePhase = "inactive" | "playing" | "restoring";

export interface PlayListPlaybackSurfaceState {
  phase: PlayListPlaybackSurfacePhase;
  playlistName: string | null;
  displayedTrackName: string | null;
  displayedTrackIsPlayable: boolean;
}

export interface PlayListPlaybackSurfaceSnapshot {
  phase: Exclude<PlayListPlaybackSurfacePhase, "inactive">;
  playlistName: string;
  displayedTrackName: string | null;
  displayedTrackIsPlayable: boolean;
}

export const INACTIVE_PLAYBACK_SURFACE: PlayListPlaybackSurfaceState = {
  phase: "inactive",
  playlistName: null,
  displayedTrackName: null,
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
  nowPlayingTrack: { name: string; url: string } | null;
}) {
  const displayedTrackName = args.nowPlayingTrack?.name ?? null;
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
        displayedTrackIsPlayable,
      } satisfies PlayListPlaybackSurfaceState;
    }

    if (
      displayedTrackName !== null &&
      (args.current.displayedTrackName !== displayedTrackName ||
        args.current.displayedTrackIsPlayable !== displayedTrackIsPlayable)
    ) {
      return {
        ...args.current,
        displayedTrackName,
        displayedTrackIsPlayable,
      };
    }

    return args.current;
  }

  if (args.current.playlistName === null) {
    return args.current.phase === "inactive" ? args.current : INACTIVE_PLAYBACK_SURFACE;
  }

  if (args.current.phase === "restoring" && args.current.displayedTrackName === null) {
    return args.current;
  }

  return {
    phase: "restoring",
    playlistName: args.current.playlistName,
    displayedTrackName: null,
    displayedTrackIsPlayable: false,
  } satisfies PlayListPlaybackSurfaceState;
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
    displayedTrackIsPlayable: state.displayedTrackIsPlayable,
  };
}
