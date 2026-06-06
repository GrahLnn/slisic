import type { CollectionTitleHandoff } from "@/src/flow/appLogic/core";
import type { MainStateT } from "@/src/flow/appLogic/events";
import type {
  TitleShareArrow,
  TitleShareEndpoint,
  TitleShareEndpointKind,
  TitleShareInstruction,
  TitleSharePageTransition,
  TitleShareRetainLease,
} from "@/src/flow/appLogic/titleShare";
import {
  createTitleShareArrow,
  createTitleShareEndpoint,
  resolveTitleShareEndpointInstruction,
} from "@/src/flow/appLogic/titleShare";
import type { PlayListPlaybackSurfaceSnapshot } from "./playListPlaybackSurface.model";
import type { PlayListTitleReturnSurfaceSnapshot } from "./playListTitleReturnSurface.model";

export type PlayListTitleHandoffRetainLease = TitleShareRetainLease;
export type PlayListTitleHandoffEndpointKind = Extract<TitleShareEndpointKind, "list" | "play">;

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
  arrow: TitleShareArrow | null;
  sourceLayoutId: string | null;
  targetLayoutId: string | null;
  targetRetainLease: PlayListTitleHandoffRetainLease;
}

export type PlayListTitleHandoffInstruction = TitleShareInstruction;

const NO_TITLE_HANDOFF_INSTRUCTION: PlayListTitleHandoffInstruction = {
  titleHoverVisual: "none",
  titleHoverRetainLease: "timed",
};

export function resolvePlayListTitleHandoffEndpointKind(args: {
  plan: PlayListTitleHandoffPlan;
  layoutId?: string | null;
  sourceEnabled: boolean;
}): PlayListTitleHandoffEndpointKind {
  if (!args.layoutId || !args.plan.arrow) {
    return "list";
  }

  if (args.plan.arrow.target?.layoutId === args.layoutId) {
    return args.plan.arrow.target.kind === "play" ? "play" : "list";
  }

  if (args.sourceEnabled && args.plan.arrow.source?.layoutId === args.layoutId) {
    return args.plan.arrow.source.kind === "play" ? "play" : "list";
  }

  return "list";
}

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

function createPlaylistEndpoint(
  kind: PlayListTitleHandoffEndpointKind,
  endpoint: PlayListTitleEndpoint | null,
): TitleShareEndpoint | null {
  return createTitleShareEndpoint(kind, endpoint?.layoutId);
}

function createListEndpoint(endpoint: PlayListTitleEndpoint | null): TitleShareEndpoint | null {
  return createPlaylistEndpoint("list", endpoint);
}

function createPlayEndpoint(endpoint: PlayListTitleEndpoint | null): TitleShareEndpoint | null {
  return createPlaylistEndpoint("play", endpoint);
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
  pendingPlaybackPlaylistName?: string | null;
  playingPlaylistName: string | null;
  sourceEnabled?: boolean;
  titleToneHandoff: CollectionTitleHandoff | null;
  transition: TitleSharePageTransition;
  playbackSurface: PlayListPlaybackSurfaceSnapshot | null;
  titleReturnSurface: PlayListTitleReturnSurfaceSnapshot | null;
}): PlayListTitleHandoffPlan {
  const returnEndpoint = findEndpointByLayoutId(args.endpoints, args.titleToneHandoff?.layoutId);
  const playbackEndpoint = findEndpointByName(args.endpoints, args.playbackSurface?.playlistName);
  const pendingPlaybackEndpoint = findEndpointByName(
    args.endpoints,
    args.pendingPlaybackPlaylistName,
  );
  const openingEndpoint = findEndpointByName(args.endpoints, args.playingPlaylistName);
  const readyReturnEndpoint =
    args.pageState === "ready"
      ? findEndpointByLayoutId(args.endpoints, args.titleReturnSurface?.layoutId)
      : null;
  const fallbackSourceLayoutId =
    args.sourceEnabled === false ? null : args.transition.committedLayoutId;

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
  } else if (pendingPlaybackEndpoint) {
    displayLock = {
      kind: "opening-playback",
      playlistName: pendingPlaybackEndpoint.playlistName,
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
    const arrow = createTitleShareArrow({
      kind: "spectrum-to-play",
      source: createTitleShareEndpoint("spectrum", args.titleToneHandoff?.layoutId),
      target: createPlayEndpoint(returnEndpoint),
      targetRetainLease: "stage-only",
    });

    return {
      displayLock,
      arrow,
      sourceLayoutId: args.transition.committedLayoutId,
      targetLayoutId: returnEndpoint.layoutId,
      targetRetainLease: "stage-only",
    };
  }

  if (readyReturnEndpoint) {
    const arrow = createTitleShareArrow({
      kind: "config-to-list",
      source: createTitleShareEndpoint("config", args.transition.committedLayoutId),
      target: createListEndpoint(readyReturnEndpoint),
      targetRetainLease: "stage-only",
    });

    return {
      displayLock,
      arrow,
      sourceLayoutId: args.transition.committedLayoutId,
      targetLayoutId: readyReturnEndpoint.layoutId,
      targetRetainLease: "stage-only",
    };
  }

  if (displayLock?.kind === "opening-playback" && (pendingPlaybackEndpoint || openingEndpoint)) {
    const endpoint = pendingPlaybackEndpoint ?? openingEndpoint;
    if (!endpoint) {
      return {
        displayLock,
        arrow: null,
        sourceLayoutId: fallbackSourceLayoutId,
        targetLayoutId: null,
        targetRetainLease: "timed",
      };
    }
    const arrow = createTitleShareArrow({
      kind: "list-to-play",
      source: createListEndpoint(endpoint),
      target: createPlayEndpoint(endpoint),
      targetRetainLease: "timed",
    });

    return {
      displayLock,
      arrow,
      sourceLayoutId: args.transition.committedLayoutId,
      targetLayoutId: endpoint.layoutId,
      targetRetainLease: "timed",
    };
  }

  if (
    displayLock?.kind === "playback-surface" &&
    playbackEndpoint &&
    args.playbackSurface?.displayedTrackName === null
  ) {
    const targetRetainLease = args.playbackSurface.phase === "restoring" ? "stage-only" : "timed";
    const arrow = createTitleShareArrow({
      kind: args.playbackSurface.phase === "restoring" ? "play-to-list" : "list-to-play",
      source:
        args.playbackSurface.phase === "restoring"
          ? createPlayEndpoint(playbackEndpoint)
          : createListEndpoint(playbackEndpoint),
      target:
        args.playbackSurface.phase === "restoring"
          ? createListEndpoint(playbackEndpoint)
          : createPlayEndpoint(playbackEndpoint),
      targetRetainLease,
    });

    return {
      displayLock,
      arrow,
      sourceLayoutId: args.transition.committedLayoutId,
      targetLayoutId: playbackEndpoint.layoutId,
      targetRetainLease,
    };
  }

  return {
    displayLock,
    arrow: null,
    sourceLayoutId: fallbackSourceLayoutId,
    targetLayoutId: null,
    targetRetainLease: "timed",
  };
}

export function resolvePlayListTitleHandoffInstruction(args: {
  plan: PlayListTitleHandoffPlan;
  endpointKind?: PlayListTitleHandoffEndpointKind;
  layoutId?: string | null;
  sourceEnabled: boolean;
}): PlayListTitleHandoffInstruction {
  if (!args.layoutId) {
    return NO_TITLE_HANDOFF_INSTRUCTION;
  }

  const endpoint = createTitleShareEndpoint(args.endpointKind ?? "list", args.layoutId);
  const instruction = resolveTitleShareEndpointInstruction({
    endpoint,
    sourceEnabled: args.sourceEnabled,
    arrow: args.plan.arrow,
  });

  if (instruction.titleHoverVisual !== "none") {
    return instruction;
  }

  return resolveTitleShareEndpointInstruction({
    endpoint,
    sourceEnabled: args.sourceEnabled,
    arrow: createTitleShareArrow({
      kind: "identity",
      source: createTitleShareEndpoint("list", args.plan.sourceLayoutId),
      target: createTitleShareEndpoint("list", args.plan.targetLayoutId),
      targetRetainLease: args.plan.targetRetainLease,
    }),
  });
}
