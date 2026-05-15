import type { CollectionTitleHandoff } from "@/src/flow/appLogic/core";
import type { MainStateT } from "@/src/flow/appLogic/events";
import type {
  TitleShareHoverVisual,
  TitleSharePageTransition,
} from "@/src/flow/appLogic/titleShare";
import type { PlayListPlaybackSurfaceSnapshot } from "./playListPlaybackSurface.model";
import type { PlayListTitleReturnSurfaceSnapshot } from "./playListTitleReturnSurface.model";

export type PlayListTitleHandoffRetainLease = "timed" | "stage-only";

export type PlayListTitleHandoffDisplayLock =
  | {
      kind: "opening-playback";
      playlistName: string;
    }
  | {
      kind: "playback-surface";
      playlistName: string;
    }
  | {
      kind: "return-handoff";
      playlistName: string;
    };

export interface PlayListTitleEndpoint {
  layoutId: string;
  playlistName: string;
}

export interface PlayListTitleHandoffPlan {
  displayLock: PlayListTitleHandoffDisplayLock | null;
  sourceLayoutId: string | null;
  targetLayoutId: string | null;
  targetRetainLease: PlayListTitleHandoffRetainLease;
}

export interface PlayListTitleHandoffInstruction {
  titleHoverVisual: TitleShareHoverVisual;
  titleHoverRetainLease: PlayListTitleHandoffRetainLease;
}

const NO_TITLE_HANDOFF_INSTRUCTION: PlayListTitleHandoffInstruction = {
  titleHoverVisual: "none",
  titleHoverRetainLease: "timed",
};

function findEndpointByName(
  endpoints: readonly PlayListTitleEndpoint[],
  playlistName: string | null | undefined,
) {
  if (!playlistName) {
    return null;
  }

  return endpoints.find((endpoint) => endpoint.playlistName === playlistName) ?? null;
}

function findEndpointByLayoutId(
  endpoints: readonly PlayListTitleEndpoint[],
  layoutId: string | null | undefined,
) {
  if (!layoutId) {
    return null;
  }

  return endpoints.find((endpoint) => endpoint.layoutId === layoutId) ?? null;
}

/**
 * Behavior:
 *   Owns the playlist title shared-layout path. It only classifies source,
 *   target and retention lifetime; rendering, playback text and layout effects
 *   stay with their own owners.
 *
 * Core invariants:
 *   - Opening list-to-play source evidence is timed and cannot be changed by
 *     return-path consumption.
 *   - Return and restore targets use stage-only evidence so the path releases
 *     when the target text reaches idle.
 *   - Playback text never manufactures title hover evidence after the track
 *     title is restored.
 */
export function resolvePlayListTitleHandoffPlan(args: {
  pageState: MainStateT;
  endpoints: readonly PlayListTitleEndpoint[];
  playingPlaylistName: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  transition: TitleSharePageTransition;
  playbackSurface: PlayListPlaybackSurfaceSnapshot | null;
  titleReturnSurface: PlayListTitleReturnSurfaceSnapshot | null;
}): PlayListTitleHandoffPlan {
  const returnEndpoint = findEndpointByLayoutId(args.endpoints, args.titleToneHandoff?.layoutId);
  const playbackEndpoint = findEndpointByName(args.endpoints, args.playbackSurface?.playlistName);
  const openingEndpoint = findEndpointByName(args.endpoints, args.playingPlaylistName);
  const readyReturnEndpoint =
    args.pageState === "ready"
      ? findEndpointByLayoutId(args.endpoints, args.titleReturnSurface?.layoutId)
      : null;

  let displayLock: PlayListTitleHandoffDisplayLock | null = null;
  if (
    args.pageState === "play" &&
    returnEndpoint &&
    (args.playbackSurface?.playlistName !== returnEndpoint.playlistName ||
      args.playbackSurface.displayedTrackName === null)
  ) {
    displayLock = {
      kind: "return-handoff",
      playlistName: returnEndpoint.playlistName,
    };
  } else if (args.pageState === "play" && args.playbackSurface === null && openingEndpoint) {
    displayLock = {
      kind: "opening-playback",
      playlistName: openingEndpoint.playlistName,
    };
  } else if (playbackEndpoint) {
    displayLock = {
      kind: "playback-surface",
      playlistName: playbackEndpoint.playlistName,
    };
  }

  if (displayLock?.kind === "return-handoff" && returnEndpoint) {
    return {
      displayLock,
      sourceLayoutId: args.transition.committedLayoutId,
      targetLayoutId: returnEndpoint.layoutId,
      targetRetainLease: "stage-only",
    };
  }

  if (readyReturnEndpoint) {
    return {
      displayLock,
      sourceLayoutId: args.transition.committedLayoutId,
      targetLayoutId: readyReturnEndpoint.layoutId,
      targetRetainLease: "stage-only",
    };
  }

  if (displayLock?.kind === "opening-playback" && openingEndpoint) {
    return {
      displayLock,
      sourceLayoutId: args.transition.committedLayoutId,
      targetLayoutId: openingEndpoint.layoutId,
      targetRetainLease: "timed",
    };
  }

  if (
    displayLock?.kind === "playback-surface" &&
    playbackEndpoint &&
    args.playbackSurface?.displayedTrackName === null
  ) {
    return {
      displayLock,
      sourceLayoutId: args.transition.committedLayoutId,
      targetLayoutId: playbackEndpoint.layoutId,
      targetRetainLease: args.playbackSurface.phase === "restoring" ? "stage-only" : "timed",
    };
  }

  return {
    displayLock,
    sourceLayoutId: args.transition.committedLayoutId,
    targetLayoutId: null,
    targetRetainLease: "timed",
  };
}

export function resolvePlayListTitleHandoffInstruction(args: {
  plan: PlayListTitleHandoffPlan;
  layoutId?: string | null;
  sourceEnabled: boolean;
}): PlayListTitleHandoffInstruction {
  if (!args.layoutId) {
    return NO_TITLE_HANDOFF_INSTRUCTION;
  }

  if (args.sourceEnabled && args.layoutId === args.plan.sourceLayoutId) {
    return {
      titleHoverVisual: "hold",
      titleHoverRetainLease: "timed",
    };
  }

  if (args.layoutId === args.plan.targetLayoutId) {
    return {
      titleHoverVisual: "retain",
      titleHoverRetainLease: args.plan.targetRetainLease,
    };
  }

  return NO_TITLE_HANDOFF_INSTRUCTION;
}
