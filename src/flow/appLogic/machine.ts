import { assign } from "xstate";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  createCollectionTitleHandoff,
  createConfigSidebarItemsFromLibrary,
  createDraft,
  cloneDraft,
  includeDraftSidebarItem,
  initialContext,
  playlistTitleLayoutId,
  removePlaylistFromPlaylists,
  removeDraftSidebarItem,
  removeExtraFromDraft,
  removeExcludeFromConfigLibrary,
  resetContextWith,
  upsertExcludeIntoConfigLibrary,
  upsertPlaylistIntoPlaylists,
  upsertCollectionIntoConfigLibrary,
  upsertCollectionIntoDraft,
  upsertCollectionIntoCollections,
  type Context,
  type ContextResetLifecycle,
  type InitialPlaybackTrackEvidence,
  type NowPlayingTrackEvidence,
  type PlaybackSurfaceStatusEvidence,
  type PlaylistPlaybackRequestEvidence,
} from "./core";
import type { PlaybackTrackPayload } from "@/src/cmd";
import {
  createSpectrumCurrentMusicDraft,
  activateSpectrumNewMusicDraft,
  changeSpectrumMusicDraftName,
  changeSpectrumMusicDraftRange,
  deleteSpectrumMusicDraft,
  mergeSpectrumMusicDrafts,
  mergeSpectrumMusicDraftsWithSourceContext,
  resetSpectrumMusicDraft,
} from "./musicTitle";
import {
  createSpectrumEditCommitFrame,
  createSpectrumEditDraftEvidence,
  createSpectrumEditCreateEvidence,
  createSpectrumEditDeleteEvidence,
  createSpectrumEditUpdateEvidence,
  hasSpectrumEditDraftCommitOperations,
  projectSpectrumEditTransaction,
  reflectSpectrumEditCommitEvidence,
  type SpectrumEditCommitNegativeEvidence,
  type SpectrumEditProjectionEvidence,
  type SpectrumEditNowPlayingInput,
  type SpectrumEditCommitPhase,
  type SpectrumEditProjectionResult,
} from "./spectrumEditTransaction";
import { resolveConfigBackTitleSharePlan, resolveTitleShareToneFromDraft } from "./titleShare";
import {
  BootstrapLoadError,
  invoker,
  payloads,
  ss,
  type SpectrumMusicDraftBootstrapInput,
  type PlaylistPlaybackStopped,
} from "./events";
import { src } from "./src";
import { recordTrace } from "@/src/debug/trace";

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function resolveSavePathFromLoadingError(error: unknown, fallback: string) {
  return error instanceof BootstrapLoadError ? error.savePath : fallback;
}

function resetLifecycleAction(
  kind: ContextResetLifecycle["chart"]["kind"],
  target: string | null = null,
): ContextResetLifecycle["chart"] {
  return kind === "none" ? { kind } : { kind, target };
}

function resetLifecycle(args: {
  chart: ContextResetLifecycle["chart"];
  lease: ContextResetLifecycle["lease"];
  reason: string;
  transaction: ContextResetLifecycle["transaction"];
}): ContextResetLifecycle {
  return {
    owner: "appLogic",
    ...args,
  };
}

function hasSpectrumMusicUpdate(context: Context) {
  return hasSpectrumEditDraftCommitOperations(context.spectrumMusicDrafts);
}

function createSpectrumEditNowPlayingInput(context: Context): SpectrumEditNowPlayingInput {
  return {
    name: context.nowPlayingTrackName,
    url: context.nowPlayingTrackUrl,
    filePath: context.nowPlayingTrackFilePath,
    startMs: context.nowPlayingTrackStartMs,
    endMs: context.nowPlayingTrackEndMs,
    liked: context.nowPlayingTrackLiked,
  };
}

function createSpectrumPlayReturnSurfaceContext(
  context: Context,
  nowPlaying: SpectrumEditNowPlayingInput,
) {
  return {
    nowPlayingTrackName: nowPlaying.name,
    nowPlayingTrackUrl: nowPlaying.url,
    nowPlayingTrackFilePath: nowPlaying.filePath,
    nowPlayingTrackStartMs: nowPlaying.startMs,
    nowPlayingTrackEndMs: nowPlaying.endMs,
    nowPlayingTrackLiked: nowPlaying.liked,
    titleToneHandoff: context.activeLayoutId
      ? createCollectionTitleHandoff(context.activeLayoutId, "solid")
      : null,
  };
}

function createNextSpectrumMusicCommitEpoch(context: Context) {
  return context.spectrumMusicCommitEpoch + 1;
}

function createSpectrumEditProjectionInput(context: Context) {
  return {
    collections: context.collections,
    nowPlaying: createSpectrumEditNowPlayingInput(context),
  };
}

function createSpectrumPlayReturnContext(
  context: Context,
  args: SpectrumEditProjectionEvidence & {
    spectrumMusicCommitEpoch?: number;
    spectrumMusicCommitFrame?: Context["spectrumMusicCommitFrame"];
  } = {},
) {
  const projection = projectSpectrumEditTransaction(
    createSpectrumEditProjectionInput(context),
    args,
  );

  return resetContextWith(
    {
      shape: {
        hasPlayList: context.hasPlayList,
        playlists: context.playlists,
        pendingPlaylistPreview: context.pendingPlaylistPreview,
        collections: projection.collections,
        configLibrary: context.configLibrary,
        savePath: context.savePath,
      },
      runtime: {
        playingPlaylistName: context.playingPlaylistName,
        playingSessionGeneration: context.playingSessionGeneration,
        nowPlayingTrackName: projection.nowPlaying.name,
        nowPlayingTrackUrl: projection.nowPlaying.url,
        nowPlayingTrackFilePath: projection.nowPlaying.filePath,
        nowPlayingTrackStartMs: projection.nowPlaying.startMs,
        nowPlayingTrackEndMs: projection.nowPlaying.endMs,
        nowPlayingTrackLiked: projection.nowPlaying.liked,
        playbackSurfaceStatus: null,
        spectrumPlaybackScopeId: context.spectrumPlaybackScopeId,
      },
      chart: {
        spectrumMusicSourceContext: null,
      },
      lease: {
        titleToneHandoff: createSpectrumPlayReturnSurfaceContext(context, projection.nowPlaying)
          .titleToneHandoff,
      },
      transaction: {
        spectrumMusicCommitFrame: args.spectrumMusicCommitFrame ?? null,
        spectrumMusicCommitEpoch: args.spectrumMusicCommitEpoch ?? context.spectrumMusicCommitEpoch,
      },
    },
    resetLifecycle({
      reason: "close spectrum chart and return to playback shape",
      chart: resetLifecycleAction("closed", "spectrum"),
      lease: context.activeLayoutId
        ? resetLifecycleAction("opened", context.activeLayoutId)
        : resetLifecycleAction("closed", null),
      transaction: args.spectrumMusicCommitFrame
        ? resetLifecycleAction("preserved", "spectrum-music-commit")
        : resetLifecycleAction("closed", "spectrum-music-commit"),
    }),
  );
}

function createSpectrumOptimisticPlayReturnContext(context: Context) {
  const baseline = createSpectrumEditProjectionInput(context);
  const optimisticEvidence = createSpectrumEditDraftEvidence(context.spectrumMusicDrafts);
  const epoch = createNextSpectrumMusicCommitEpoch(context);

  return createSpectrumPlayReturnContext(context, {
    ...optimisticEvidence,
    spectrumMusicCommitEpoch: epoch,
    spectrumMusicCommitFrame: createSpectrumEditCommitFrame({
      baseline,
      epoch,
      optimisticEvidence,
    }),
  });
}

function createSpectrumReflectionContextPatch(
  context: Context,
  projection: SpectrumEditProjectionResult,
  frame: Context["spectrumMusicCommitFrame"],
): Partial<Context> {
  return {
    collections: projection.collections,
    nowPlayingTrackName: projection.nowPlaying.name,
    nowPlayingTrackUrl: projection.nowPlaying.url,
    nowPlayingTrackFilePath: projection.nowPlaying.filePath,
    nowPlayingTrackStartMs: projection.nowPlaying.startMs,
    nowPlayingTrackEndMs: projection.nowPlaying.endMs,
    nowPlayingTrackLiked: projection.nowPlaying.liked,
    spectrumMusicCommitFrame: frame,
    spectrumMusicCommitNegativeEvidence: null,
    titleToneHandoff: createSpectrumPlayReturnSurfaceContext(context, projection.nowPlaying)
      .titleToneHandoff,
  };
}

function createSpectrumAcceptedEvidenceContext(
  context: Context,
  accepted: {
    epoch: number;
    evidence: SpectrumEditProjectionEvidence;
    phase: SpectrumEditCommitPhase;
  },
): Partial<Context> {
  const reflection = reflectSpectrumEditCommitEvidence(context.spectrumMusicCommitFrame, accepted);

  if (reflection.kind !== "accepted") {
    const negativeEvidence: SpectrumEditCommitNegativeEvidence =
      reflection.kind === "Reject"
        ? {
            epoch: reflection.epoch,
            kind: reflection.kind,
            phase: reflection.phase,
            reason: reflection.reason,
          }
        : {
            epoch: reflection.epoch,
            kind: reflection.kind,
            phase: reflection.phase,
            reason: reflection.reason,
          };

    return {
      spectrumMusicCommitNegativeEvidence: negativeEvidence,
    };
  }

  return createSpectrumReflectionContextPatch(context, reflection.projection, reflection.frame);
}

function createCurrentSpectrumMusicDrafts(context: Context) {
  const currentDraft = createSpectrumCurrentMusicDraft({
    endMs: context.nowPlayingTrackEndMs,
    name: context.nowPlayingTrackName,
    startMs: context.nowPlayingTrackStartMs,
    url: context.nowPlayingTrackUrl,
  });

  return currentDraft ? [currentDraft] : [];
}

function resolveSpectrumMusicDraftsWithCreateIntent(args: {
  fallbackSource: {
    endMs: number | null;
    sourceUrl: string | null;
  };
  drafts: Context["spectrumMusicDrafts"];
  id: string | null;
  source: Context["spectrumMusicSourceContext"];
}) {
  if (args.id === null) {
    return args.drafts;
  }

  return activateSpectrumNewMusicDraft(args.drafts, args.id, {
    fallbackSource: args.fallbackSource,
    source: args.source,
  });
}

function createSpectrumMusicDraftLoadContext(
  context: Context,
  output: {
    drafts: Context["spectrumMusicDrafts"];
    source: Context["spectrumMusicSourceContext"];
  },
) {
  const mergedDrafts = mergeSpectrumMusicDrafts({
    baseDrafts: context.spectrumMusicDrafts,
    incomingDrafts: output.drafts,
  });
  const draftsWithSourceEvidence = mergeSpectrumMusicDraftsWithSourceContext({
    drafts: mergedDrafts,
    source: output.source,
  });

  return {
    pendingSpectrumMusicCreateId: null,
    spectrumMusicDrafts: resolveSpectrumMusicDraftsWithCreateIntent({
      drafts: draftsWithSourceEvidence,
      fallbackSource: {
        endMs: context.nowPlayingTrackEndMs,
        sourceUrl: context.nowPlayingTrackUrl,
      },
      id: context.pendingSpectrumMusicCreateId,
      source: output.source,
    }),
    spectrumMusicSourceContext: output.source,
  };
}

function createSpectrumMusicCreateStartedContext(context: Context, id: string) {
  return {
    pendingSpectrumMusicCreateId: null,
    spectrumMusicDrafts: activateSpectrumNewMusicDraft(context.spectrumMusicDrafts, id, {
      fallbackSource: {
        endMs: context.nowPlayingTrackEndMs,
        sourceUrl: context.nowPlayingTrackUrl,
      },
      source: context.spectrumMusicSourceContext,
    }),
  };
}

function createSpectrumMusicDraftBootstrapInput(
  context: Context,
): SpectrumMusicDraftBootstrapInput | null {
  if (
    !context.nowPlayingTrackFilePath ||
    !context.nowPlayingTrackUrl ||
    context.nowPlayingTrackStartMs === null ||
    context.nowPlayingTrackEndMs === null
  ) {
    return null;
  }

  return {
    filePath: context.nowPlayingTrackFilePath,
    nowPlayingTrackEndMs: context.nowPlayingTrackEndMs,
    nowPlayingTrackStartMs: context.nowPlayingTrackStartMs,
    nowPlayingTrackUrl: context.nowPlayingTrackUrl,
  };
}

function createOpenSpectrumContext(context: Context) {
  return resetContextWith(
    {
      shape: {
        hasPlayList: context.hasPlayList,
        playlists: context.playlists,
        pendingPlaylistPreview: context.pendingPlaylistPreview,
        collections: context.collections,
        configLibrary: context.configLibrary,
        savePath: context.savePath,
      },
      runtime: {
        playingPlaylistName: context.playingPlaylistName,
        playingSessionGeneration: context.playingSessionGeneration,
        nowPlayingTrackName: context.nowPlayingTrackName,
        nowPlayingTrackUrl: context.nowPlayingTrackUrl,
        nowPlayingTrackFilePath: context.nowPlayingTrackFilePath,
        nowPlayingTrackStartMs: context.nowPlayingTrackStartMs,
        nowPlayingTrackEndMs: context.nowPlayingTrackEndMs,
        nowPlayingTrackLiked: context.nowPlayingTrackLiked,
        playbackSurfaceStatus: context.playbackSurfaceStatus,
        spectrumPlaybackScopeId: context.spectrumPlaybackScopeId,
      },
      chart: {
        spectrumMusicDrafts: createCurrentSpectrumMusicDrafts(context),
        spectrumMusicSourceContext: null,
        activeLayoutId: context.playingPlaylistName
          ? playlistTitleLayoutId(context.playingPlaylistName)
          : null,
      },
    },
    resetLifecycle({
      reason: "open spectrum chart from playback shape",
      chart: resetLifecycleAction("opened", "spectrum"),
      lease: context.playingPlaylistName
        ? resetLifecycleAction("opened", playlistTitleLayoutId(context.playingPlaylistName))
        : resetLifecycleAction("none"),
      transaction: resetLifecycleAction("closed", "spectrum-music-commit"),
    }),
  );
}

function createOpenSpectrumErrorContext(context: Context) {
  return resetContextWith(
    {
      shape: {
        hasPlayList: context.hasPlayList,
        playlists: context.playlists,
        pendingPlaylistPreview: context.pendingPlaylistPreview,
        collections: context.collections,
        configLibrary: context.configLibrary,
        savePath: context.savePath,
      },
      runtime: {
        playingPlaylistName: context.playingPlaylistName,
        playingSessionGeneration: context.playingSessionGeneration,
        nowPlayingTrackName: context.nowPlayingTrackName,
        nowPlayingTrackUrl: context.nowPlayingTrackUrl,
        nowPlayingTrackFilePath: context.nowPlayingTrackFilePath,
        nowPlayingTrackStartMs: context.nowPlayingTrackStartMs,
        nowPlayingTrackEndMs: context.nowPlayingTrackEndMs,
        nowPlayingTrackLiked: context.nowPlayingTrackLiked,
        playbackSurfaceStatus: context.playbackSurfaceStatus,
        spectrumPlaybackScopeId: context.spectrumPlaybackScopeId,
      },
      chart: {
        spectrumMusicDrafts: [],
        spectrumMusicSourceContext: null,
      },
      pending: {
        error: "missing spectrum music identity for music loading",
      },
    },
    resetLifecycle({
      reason: "reject opening spectrum without music identity",
      chart: resetLifecycleAction("closed", "spectrum"),
      lease: resetLifecycleAction("closed", null),
      transaction: resetLifecycleAction("closed", "spectrum-music-commit"),
    }),
  );
}

function createNowPlayingTrackPatch(
  context: Context,
  evidence: NowPlayingTrackEvidence,
): Pick<
  Context,
  | "nowPlayingTrackName"
  | "nowPlayingTrackUrl"
  | "nowPlayingTrackFilePath"
  | "nowPlayingTrackStartMs"
  | "nowPlayingTrackEndMs"
  | "nowPlayingTrackLiked"
  | "playbackSurfaceStatus"
  | "pendingSpectrumMusicCreateId"
  | "spectrumMusicSourceContext"
  | "spectrumMusicDrafts"
> {
  return {
    nowPlayingTrackName: evidence.music_name,
    nowPlayingTrackUrl: evidence.music_url,
    nowPlayingTrackFilePath: evidence.file_path,
    nowPlayingTrackStartMs: evidence.start_ms,
    nowPlayingTrackEndMs: evidence.end_ms,
    nowPlayingTrackLiked: evidence.liked,
    playbackSurfaceStatus: null,
    pendingSpectrumMusicCreateId:
      context.nowPlayingTrackFilePath === evidence.file_path
        ? context.pendingSpectrumMusicCreateId
        : null,
    spectrumMusicSourceContext:
      context.nowPlayingTrackFilePath === evidence.file_path
        ? context.spectrumMusicSourceContext
        : null,
    spectrumMusicDrafts:
      context.nowPlayingTrackFilePath === evidence.file_path ? context.spectrumMusicDrafts : [],
  };
}

function createInitialPlaybackTrackEvidence(
  context: Context,
  playlistName: string,
  event: { output: { session: { initial_track: PlaybackTrackPayload | null } } },
): InitialPlaybackTrackEvidence | null {
  const track = event.output.session.initial_track;
  if (
    !track ||
    track.playlist_name !== playlistName ||
    context.pendingPlaylistPlaybackSessionGeneration === null
  ) {
    return null;
  }

  return {
    ...track,
    session_generation: context.pendingPlaylistPlaybackSessionGeneration,
  };
}

function createPlayReadyContext(
  context: Context,
  playlistName: string,
  event?: { output: { session: { initial_track: PlaybackTrackPayload | null } } },
) {
  const pendingEvidence =
    context.pendingNowPlayingTrackEvidence?.playlist_name === playlistName &&
    context.pendingNowPlayingTrackEvidence.session_generation ===
      context.pendingPlaylistPlaybackSessionGeneration
      ? context.pendingNowPlayingTrackEvidence
      : null;
  const initialTrackEvidence = event
    ? createInitialPlaybackTrackEvidence(context, playlistName, event)
    : null;
  const pendingSurfaceStatus =
    context.pendingPlaybackSurfaceStatusEvidence?.playlist_name === playlistName &&
    context.pendingPlaybackSurfaceStatusEvidence.session_generation ===
      context.pendingPlaylistPlaybackSessionGeneration
      ? context.pendingPlaybackSurfaceStatusEvidence.status
      : null;
  const nowPlayingTrackPatch = pendingEvidence
    ? createNowPlayingTrackPatch(context, pendingEvidence)
    : initialTrackEvidence
      ? createNowPlayingTrackPatch(context, initialTrackEvidence)
      : {
          nowPlayingTrackName: null,
          nowPlayingTrackUrl: null,
          nowPlayingTrackFilePath: null,
          nowPlayingTrackStartMs: null,
          nowPlayingTrackEndMs: null,
          nowPlayingTrackLiked: null,
          playbackSurfaceStatus: pendingSurfaceStatus,
          pendingSpectrumMusicCreateId: null,
          spectrumMusicSourceContext: null,
          spectrumMusicDrafts: [],
        };

  return resetContextWith(
    {
      shape: {
        hasPlayList: context.hasPlayList,
        playlists: context.playlists,
        pendingPlaylistPreview: context.pendingPlaylistPreview,
        collections: context.collections,
        configLibrary: context.configLibrary,
        savePath: context.savePath,
      },
      runtime: {
        playingPlaylistName: playlistName,
        playingSessionGeneration: context.pendingPlaylistPlaybackSessionGeneration,
        ...nowPlayingTrackPatch,
        pendingPlaylistPlaybackSessionGeneration: null,
      },
      transaction: {
        pendingPlaylistPlaybackName: null,
        pendingPlaylistPlaybackRequest: null,
      },
      pending: {
        pendingNowPlayingTrackEvidence: null,
        pendingPlaybackSurfaceStatusEvidence: null,
      },
    },
    resetLifecycle({
      reason: "accept playlist playback and close pending playback evidence",
      chart: resetLifecycleAction("closed", "playlist-playback-pending"),
      lease: resetLifecycleAction("closed", null),
      transaction: resetLifecycleAction("closed", "playlist-playback-start"),
    }),
  );
}

function createPlaylistPlaybackRequestEvidence(input: {
  playlistName: string;
  requestId: number;
}): PlaylistPlaybackRequestEvidence {
  return {
    error: null,
    phase: "starting",
    playlistName: input.playlistName,
    reason: null,
    requestId: input.requestId,
  };
}

function createPendingPlaylistPlaybackPatch(input: {
  playlistName: string;
  requestId: number;
}): Pick<
  Context,
  | "pendingNowPlayingTrackEvidence"
  | "pendingPlaylistPlaybackName"
  | "pendingPlaylistPlaybackRequest"
  | "pendingPlaylistPlaybackSessionGeneration"
  | "pendingPlaybackSurfaceStatusEvidence"
> {
  return {
    pendingPlaylistPlaybackName: input.playlistName,
    pendingPlaylistPlaybackSessionGeneration: null,
    pendingPlaylistPlaybackRequest: createPlaylistPlaybackRequestEvidence(input),
    pendingNowPlayingTrackEvidence: null,
    pendingPlaybackSurfaceStatusEvidence: null,
  };
}

function createPendingPlaylistPlaybackContext(
  context: Context,
  input: { playlistName: string; requestId: number },
) {
  const activeLayoutId = playlistTitleLayoutId(input.playlistName);

  return resetContextWith(
    {
      shape: {
        hasPlayList: context.hasPlayList,
        playlists: context.playlists,
        pendingPlaylistPreview: context.pendingPlaylistPreview,
        collections: context.collections,
        configLibrary: context.configLibrary,
        savePath: context.savePath,
      },
      runtime: {
        playingPlaylistName: null,
        playingSessionGeneration: null,
        nowPlayingTrackName: null,
        nowPlayingTrackUrl: null,
        nowPlayingTrackFilePath: null,
        nowPlayingTrackStartMs: null,
        nowPlayingTrackEndMs: null,
        nowPlayingTrackLiked: null,
        pendingPlaylistPlaybackSessionGeneration: null,
      },
      transaction: {
        pendingPlaylistPlaybackName: input.playlistName,
        pendingPlaylistPlaybackRequest: createPlaylistPlaybackRequestEvidence(input),
      },
      pending: {
        pendingNowPlayingTrackEvidence: null,
        pendingPlaybackSurfaceStatusEvidence: null,
      },
      chart: {
        activeLayoutId,
      },
      lease: {
        titleToneHandoff: createCollectionTitleHandoff(activeLayoutId, "solid"),
      },
    },
    resetLifecycle({
      reason: "open playlist title lease while pending playback starts",
      chart: resetLifecycleAction("opened", "playlist-preview-playback"),
      lease: resetLifecycleAction("opened", activeLayoutId),
      transaction: resetLifecycleAction("opened", "playlist-playback-start"),
    }),
  );
}

function createPendingPlaylistPlaybackDuringPlayPatch(input: {
  playlistName: string;
  requestId: number;
}): Partial<Context> {
  return createPendingPlaylistPlaybackPatch(input);
}

function isCurrentPlaylistPlaybackRequest(
  context: Context,
  input: { playlistName: string; requestId: number },
) {
  return (
    context.pendingPlaylistPlaybackRequest?.playlistName === input.playlistName &&
    context.pendingPlaylistPlaybackRequest.requestId === input.requestId
  );
}

function createPlaylistPlaybackStoppedPatch(
  context: Context,
  event: { output: PlaylistPlaybackStopped },
): Partial<Context> {
  const current = context.pendingPlaylistPlaybackRequest;
  if (
    !current ||
    current.playlistName !== event.output.playlistName ||
    current.requestId !== event.output.requestId
  ) {
    return {};
  }

  if (
    event.output.reason === "pending_first_track" ||
    event.output.reason === "unstable_target"
  ) {
    return {
      pendingPlaylistPlaybackName: null,
      pendingPlaylistPlaybackSessionGeneration: null,
      pendingPlaylistPlaybackRequest: null,
      pendingNowPlayingTrackEvidence: null,
      pendingPlaybackSurfaceStatusEvidence: null,
    };
  }

  return {
    pendingPlaylistPlaybackName: null,
    pendingPlaylistPlaybackSessionGeneration: null,
    pendingPlaylistPlaybackRequest: {
      error: event.output.error,
      phase: "failed",
      playlistName: event.output.playlistName,
      reason: event.output.reason,
      requestId: event.output.requestId,
    },
    pendingNowPlayingTrackEvidence: null,
    pendingPlaybackSurfaceStatusEvidence: null,
  };
}

function matchesPendingPlaybackSurfaceStatusEvidence(
  context: Context,
  evidence: PlaybackSurfaceStatusEvidence,
) {
  return (
    context.pendingPlaylistPlaybackName === evidence.playlist_name &&
    (context.pendingPlaylistPlaybackSessionGeneration === null ||
      context.pendingPlaylistPlaybackSessionGeneration === evidence.session_generation)
  );
}

function createPlaylistUpsertedContext(
  context: Context,
  event: { output: { playlist: Context["playlists"][number]; previousName: string | null } },
) {
  const matchesPendingPreview =
    context.pendingPlaylistPreview &&
    (context.pendingPlaylistPreview.playlist.name === event.output.playlist.name ||
      context.pendingPlaylistPreview.previousName === event.output.previousName);

  return {
    hasPlayList: true,
    playlists: upsertPlaylistIntoPlaylists(
      context.playlists,
      event.output.playlist,
      event.output.previousName,
    ),
    pendingPlaylistPreview: matchesPendingPreview ? null : context.pendingPlaylistPreview,
    pendingPlaylistPlaybackName: context.pendingPlaylistPlaybackName,
    pendingPlaylistPlaybackRequest: context.pendingPlaylistPlaybackRequest,
  };
}

function createConfigLoadingContext(context: Context, playlistName: string) {
  const activeLayoutId = playlistTitleLayoutId(playlistName);

  return resetContextWith(
    {
      shape: {
        hasPlayList: context.hasPlayList,
        playlists: context.playlists,
        pendingPlaylistPreview: context.pendingPlaylistPreview,
        collections: context.collections,
        configLibrary: context.configLibrary,
        savePath: context.savePath,
      },
      runtime: {
        playingPlaylistName: null,
        nowPlayingTrackName: null,
        nowPlayingTrackLiked: null,
      },
      chart: {
        activeLayoutId,
      },
      lease: {
        titleToneHandoff: createCollectionTitleHandoff(activeLayoutId, "solid"),
      },
      transaction: {
        pendingPlaylistName: playlistName,
      },
    },
    resetLifecycle({
      reason: "open config loading chart for playlist draft",
      chart: resetLifecycleAction("opened", "playlist-config-loading"),
      lease: resetLifecycleAction("opened", activeLayoutId),
      transaction: resetLifecycleAction("opened", "playlist-draft-load"),
    }),
  );
}

const openPlaylist = payloads["playlist.open"];
const playPlaylist = payloads["playlist.play"];
const playlistPlaybackAccepted = payloads["playlist.playback.accepted"];
const playlistPlaybackStopped = payloads["playlist.playback.stopped"];
const playlistUpserted = payloads["playlist.upserted"];
const playlistDeleted = payloads["playlist.deleted"];
const playlistPreviewChanged = payloads["playlist.preview.changed"];
const draftNameChanged = payloads["draft.name.changed"];
const spectrumMusicNameChanged = payloads["spectrum.music_name.changed"];
const spectrumMusicRangeChanged = payloads["spectrum.music_range.changed"];
const spectrumMusicDeleted = payloads["spectrum.music_deleted"];
const spectrumMusicCreateStarted = payloads["spectrum.music_create_started"];
const spectrumMusicDraftReset = payloads["spectrum.music_draft.reset"];
const spectrumPlaybackScopeChanged = payloads["spectrum.playback_scope.changed"];
const spectrumMusicUpdatesCommitted = payloads["spectrum.music_updates.committed"];
const spectrumMusicCreatesCommitted = payloads["spectrum.music_creates.committed"];
const spectrumMusicDeletesCommitted = payloads["spectrum.music_deletes.committed"];
const spectrumMusicCommitFailed = payloads["spectrum.music_commit.failed"];
const savePathChanged = payloads["save_path.changed"];
const collectionUpserted = payloads["collection.upserted"];
const draftCollectionUpserted = payloads["draft.collection.upserted"];
const draftItemIncluded = payloads["draft.item.included"];
const draftItemRemoved = payloads["draft.item.removed"];
const draftExtraRemoved = payloads["draft.extra.removed"];
const collectionUpdatesRequested = payloads["collection.updates.requested"];
const excludeAdded = payloads["exclude.added"];
const excludeRemoved = payloads["exclude.removed"];
const nowPlayingTrackChanged = payloads["player.now_playing_track.changed"];
const playbackSurfaceStatusChanged = payloads["player.playback_surface_status.changed"];

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: initialContext,
  on: {
    [savePathChanged.evt]: {
      actions: assign({
        savePath: ({ event }) => event.output,
      }),
    },
    [collectionUpserted.evt]: {
      actions: assign(({ context, event }) => {
        const collections = upsertCollectionIntoCollections(context.collections, event.output);

        return {
          collections,
          configLibrary: upsertCollectionIntoConfigLibrary(context.configLibrary, event.output),
        };
      }),
    },
    [playlistUpserted.evt]: {
      actions: [
        ({ context, event }) => {
          recordTrace("app-playlist-upsert-event-received", {
            currentDraftName: context.draft?.name ?? null,
            currentPendingPreviewName: context.pendingPlaylistPreview?.playlist.name ?? null,
            previousName: event.output.previousName,
            playlistName: event.output.playlist.name,
          });
        },
        assign(({ context, event }) => {
          const nextContext = createPlaylistUpsertedContext(context, event);
          recordTrace("app-playlist-upsert-context-projected", {
            hasPlayList: nextContext.hasPlayList,
            currentDraftName: context.draft?.name ?? null,
            nextPendingPreviewName: nextContext.pendingPlaylistPreview?.playlist.name ?? null,
            previousName: event.output.previousName,
            playlistName: event.output.playlist.name,
            playlistNames: nextContext.playlists.map((playlist) => playlist.name),
          });
          return nextContext;
        }),
      ],
    },
    [playlistDeleted.evt]: {
      actions: assign(({ context, event }) => {
        const playlists = removePlaylistFromPlaylists(context.playlists, event.output);

        return {
          hasPlayList: playlists.length > 0,
          playlists,
          pendingPlaylistPreview:
            context.pendingPlaylistPreview &&
            (context.pendingPlaylistPreview.playlist.name === event.output ||
              context.pendingPlaylistPreview.previousName === event.output)
              ? null
              : context.pendingPlaylistPreview,
          pendingPlaylistPlaybackName:
            context.pendingPlaylistPlaybackName === event.output
              ? null
              : context.pendingPlaylistPlaybackName,
          pendingPlaylistPlaybackSessionGeneration:
            context.pendingPlaylistPlaybackName === event.output
              ? null
              : context.pendingPlaylistPlaybackSessionGeneration,
          pendingPlaylistPlaybackRequest:
            context.pendingPlaylistPlaybackName === event.output
              ? null
              : context.pendingPlaylistPlaybackRequest,
          pendingPlaybackSurfaceStatusEvidence:
            context.pendingPlaylistPlaybackName === event.output
              ? null
              : context.pendingPlaybackSurfaceStatusEvidence,
        };
      }),
    },
    [playlistPreviewChanged.evt]: {
      actions: assign({
        pendingPlaylistPreview: ({ event }) => event.output,
      }),
    },
    [playlistPlaybackStopped.evt]: {
      actions: assign(({ context, event }) => createPlaylistPlaybackStoppedPatch(context, event)),
    },
    [draftCollectionUpserted.evt]: {
      actions: assign(({ context, event }) => {
        const collections = upsertCollectionIntoCollections(context.collections, event.output);

        return {
          collections,
          configLibrary: upsertCollectionIntoConfigLibrary(context.configLibrary, event.output),
          draft: upsertCollectionIntoDraft(context.draft, event.output),
        };
      }),
    },
    [draftItemIncluded.evt]: {
      actions: assign(({ context, event }) => {
        const libraryItems = createConfigSidebarItemsFromLibrary(context.configLibrary);

        return {
          draft: includeDraftSidebarItem(
            context.draft,
            context.collections,
            libraryItems,
            event.output,
          ),
        };
      }),
    },
    [draftItemRemoved.evt]: {
      actions: assign(({ context, event }) => ({
        draft: removeDraftSidebarItem(context.draft, event.output),
      })),
    },
    [draftExtraRemoved.evt]: {
      actions: assign(({ context, event }) => ({
        draft: removeExtraFromDraft(context.draft, event.output),
      })),
    },
    [excludeAdded.evt]: {
      actions: assign(({ context, event }) => ({
        configLibrary: upsertExcludeIntoConfigLibrary(context.configLibrary, event.output),
      })),
    },
    [excludeRemoved.evt]: {
      actions: assign(({ context, event }) => ({
        configLibrary: removeExcludeFromConfigLibrary(context.configLibrary, event.output),
      })),
    },
    [nowPlayingTrackChanged.evt]: {
      actions: assign(({ context, event }) => {
        const matchesAcceptedPlayback =
          context.playingPlaylistName === event.output.playlist_name &&
          context.playingSessionGeneration === event.output.session_generation;
        const matchesPendingPlayback =
          context.pendingPlaylistPlaybackName === event.output.playlist_name &&
          (context.pendingPlaylistPlaybackSessionGeneration === null ||
            context.pendingPlaylistPlaybackSessionGeneration === event.output.session_generation);

        if (!matchesAcceptedPlayback && !matchesPendingPlayback) {
          return {};
        }

        if (matchesAcceptedPlayback) {
          return {
            ...createNowPlayingTrackPatch(context, event.output),
            pendingNowPlayingTrackEvidence: event.output,
            pendingPlaybackSurfaceStatusEvidence: null,
          };
        }

        return {
          pendingNowPlayingTrackEvidence: event.output,
        };
      }),
    },
    [playbackSurfaceStatusChanged.evt]: {
      actions: assign(({ context, event }) => {
        const matchesAcceptedPlayback =
          context.playingPlaylistName === event.output.playlist_name &&
          context.playingSessionGeneration === event.output.session_generation;

        if (!matchesAcceptedPlayback) {
          if (matchesPendingPlaybackSurfaceStatusEvidence(context, event.output)) {
            return {
              pendingPlaybackSurfaceStatusEvidence: event.output,
            };
          }

          return {};
        }

        return {
          nowPlayingTrackName: null,
          nowPlayingTrackUrl: null,
          nowPlayingTrackFilePath: null,
          nowPlayingTrackStartMs: null,
          nowPlayingTrackEndMs: null,
          nowPlayingTrackLiked: null,
          playbackSurfaceStatus: event.output.status,
          pendingSpectrumMusicCreateId: null,
          spectrumMusicSourceContext: null,
          spectrumMusicDrafts: [],
          pendingPlaybackSurfaceStatusEvidence: null,
        };
      }),
    },
    [spectrumPlaybackScopeChanged.evt]: {
      actions: assign({
        spectrumPlaybackScopeId: ({ event }) => event.output,
      }),
    },
    [spectrumMusicUpdatesCommitted.evt]: {
      actions: assign(({ context, event }) => {
        return createSpectrumAcceptedEvidenceContext(context, {
          epoch: event.output.epoch,
          phase: "update",
          evidence: createSpectrumEditUpdateEvidence(event.output.result),
        });
      }),
    },
    [spectrumMusicCreatesCommitted.evt]: {
      actions: assign(({ context, event }) => {
        return createSpectrumAcceptedEvidenceContext(context, {
          epoch: event.output.epoch,
          phase: "create",
          evidence: createSpectrumEditCreateEvidence(event.output.result),
        });
      }),
    },
    [spectrumMusicDeletesCommitted.evt]: {
      actions: assign(({ context, event }) => {
        return createSpectrumAcceptedEvidenceContext(context, {
          epoch: event.output.epoch,
          phase: "delete",
          evidence: createSpectrumEditDeleteEvidence(event.output.result),
        });
      }),
    },
    [spectrumMusicCommitFailed.evt]: {
      actions: assign(({ context, event }) =>
        event.output.epoch === context.spectrumMusicCommitEpoch
          ? {
              error: event.output.error,
              spectrumMusicCommitFrame: null,
              spectrumMusicCommitNegativeEvidence: {
                epoch: event.output.epoch,
                kind: "Reject",
                phase: event.output.phase,
                reason: "unexpected-evidence",
              },
            }
          : {},
      ),
    },
  },
  states: {
    [ss.mainx.State.idle]: {
      on: {
        run: ss.mainx.State.loading,
      },
    },
    [ss.mainx.State.loading]: {
      invoke: {
        id: invoker.loadCollections.id,
        src: invoker.loadCollections.src,
        onDone: {
          target: ss.mainx.State.ready,
          actions: assign(({ event }) =>
            resetContextWith(
              {
                shape: {
                  hasPlayList: event.output.hasPlayList,
                  playlists: event.output.playlists,
                  pendingPlaylistPreview: null,
                  collections: event.output.collections,
                  configLibrary: event.output.configLibrary,
                  savePath: event.output.savePath,
                },
                runtime: {
                  playingPlaylistName: null,
                  nowPlayingTrackName: null,
                },
              },
              resetLifecycle({
                reason: "replace app shape from bootstrap evidence",
                chart: resetLifecycleAction("closed", null),
                lease: resetLifecycleAction("closed", null),
                transaction: resetLifecycleAction("closed", null),
              }),
            ),
          ),
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign(({ context, event }) =>
            resetContextWith(
              {
                shape: {
                  savePath: resolveSavePathFromLoadingError(event.error, context.savePath),
                },
                pending: {
                  error: toErrorMessage(event.error),
                },
              },
              resetLifecycle({
                reason: "enter bootstrap error state",
                chart: resetLifecycleAction("closed", null),
                lease: resetLifecycleAction("closed", null),
                transaction: resetLifecycleAction("closed", null),
              }),
            ),
          ),
        },
      },
    },
    [ss.mainx.State.ready]: {
      on: {
        run: ss.mainx.State.loading,
        [playlistUpserted.evt]: {
          actions: assign(({ context, event }) => {
            const nextContext = createPlaylistUpsertedContext(context, event);
            recordTrace("app-playlist-upsert-ready-projected", {
              currentDraftName: context.draft?.name ?? null,
              currentPendingPreviewName: context.pendingPlaylistPreview?.playlist.name ?? null,
              nextPendingPreviewName: nextContext.pendingPlaylistPreview?.playlist.name ?? null,
              previousName: event.output.previousName,
              playlistName: event.output.playlist.name,
              playlistNames: nextContext.playlists.map((playlist) => playlist.name),
            });
            return nextContext;
          }),
        },
        opencreate: {
          target: ss.mainx.State.config,
          actions: assign(({ context }) =>
            resetContextWith(
              {
                shape: {
                  hasPlayList: context.hasPlayList,
                  playlists: context.playlists,
                  pendingPlaylistPreview: context.pendingPlaylistPreview,
                  collections: context.collections,
                  configLibrary: context.configLibrary,
                  savePath: context.savePath,
                  draftBaseline: createDraft(),
                  draft: createDraft(),
                },
                runtime: {
                  playingPlaylistName: null,
                  nowPlayingTrackName: null,
                },
                chart: {
                  activeLayoutId: CREATE_COLLECTION_LAYOUT_ID,
                },
                lease: {
                  titleToneHandoff: createCollectionTitleHandoff(
                    CREATE_COLLECTION_LAYOUT_ID,
                    "solid",
                  ),
                },
              },
              resetLifecycle({
                reason: "open create playlist config chart",
                chart: resetLifecycleAction("opened", "playlist-config"),
                lease: resetLifecycleAction("opened", CREATE_COLLECTION_LAYOUT_ID),
                transaction: resetLifecycleAction("closed", "playlist-draft-load"),
              }),
            ),
          ),
        },
        [playPlaylist.evt]: {
          actions: assign(({ context, event }) =>
            createPendingPlaylistPlaybackContext(context, event.output),
          ),
        },
        [playlistPlaybackAccepted.evt]: {
          target: ss.mainx.State.play,
          guard: ({ context, event }) => isCurrentPlaylistPlaybackRequest(context, event.output),
          actions: assign(({ context, event }) =>
            createPlayReadyContext(
              {
                ...context,
                pendingPlaylistPlaybackSessionGeneration: event.output.session.session_generation,
              },
              event.output.playlistName,
              event,
            ),
          ),
        },
        [openPlaylist.evt]: [
          {
            target: ss.mainx.State.configLoading,
            actions: assign(({ context, event }) =>
              createConfigLoadingContext(context, event.output),
            ),
          },
        ],
      },
    },
    [ss.mainx.State.play]: {
      on: {
        run: ss.mainx.State.loading,
        back: {
          target: ss.mainx.State.ready,
          actions: assign(({ context }) =>
            resetContextWith(
              {
                shape: {
                  hasPlayList: context.hasPlayList,
                  playlists: context.playlists,
                  pendingPlaylistPreview: context.pendingPlaylistPreview,
                  collections: context.collections,
                  configLibrary: context.configLibrary,
                  savePath: context.savePath,
                },
                runtime: {
                  playingPlaylistName: null,
                  nowPlayingTrackName: null,
                },
              },
              resetLifecycle({
                reason: "leave playback and close runtime chart",
                chart: resetLifecycleAction("closed", "playback"),
                lease: resetLifecycleAction("closed", null),
                transaction: resetLifecycleAction("closed", null),
              }),
            ),
          ),
        },
        opencreate: {
          target: ss.mainx.State.config,
          actions: assign(({ context }) =>
            resetContextWith(
              {
                shape: {
                  hasPlayList: context.hasPlayList,
                  playlists: context.playlists,
                  pendingPlaylistPreview: context.pendingPlaylistPreview,
                  collections: context.collections,
                  configLibrary: context.configLibrary,
                  savePath: context.savePath,
                  draftBaseline: createDraft(),
                  draft: createDraft(),
                },
                runtime: {
                  playingPlaylistName: null,
                  nowPlayingTrackName: null,
                },
                chart: {
                  activeLayoutId: CREATE_COLLECTION_LAYOUT_ID,
                },
                lease: {
                  titleToneHandoff: createCollectionTitleHandoff(
                    CREATE_COLLECTION_LAYOUT_ID,
                    "solid",
                  ),
                },
              },
              resetLifecycle({
                reason: "open create playlist config chart from playback",
                chart: resetLifecycleAction("opened", "playlist-config"),
                lease: resetLifecycleAction("opened", CREATE_COLLECTION_LAYOUT_ID),
                transaction: resetLifecycleAction("closed", "playlist-draft-load"),
              }),
            ),
          ),
        },
        [playPlaylist.evt]: {
          actions: assign(({ event }) => createPendingPlaylistPlaybackDuringPlayPatch(event.output)),
        },
        [playlistPlaybackAccepted.evt]: {
          reenter: true,
          guard: ({ context, event }) => isCurrentPlaylistPlaybackRequest(context, event.output),
          actions: assign(({ context, event }) =>
            createPlayReadyContext(
              {
                ...context,
                pendingPlaylistPlaybackSessionGeneration: event.output.session.session_generation,
              },
              event.output.playlistName,
              event,
            ),
          ),
        },
        [openPlaylist.evt]: [
          {
            target: ss.mainx.State.configLoading,
            actions: assign(({ context, event }) =>
              createConfigLoadingContext(context, event.output),
            ),
          },
        ],
        openspectrum: [
          {
            guard: ({ context }) => createSpectrumMusicDraftBootstrapInput(context) !== null,
            target: ss.mainx.State.spectrum,
            actions: assign(({ context }) => createOpenSpectrumContext(context)),
          },
          {
            target: ss.mainx.State.error,
            actions: assign(({ context }) => createOpenSpectrumErrorContext(context)),
          },
        ],
      },
    },
    [ss.mainx.State.spectrum]: {
      invoke: {
        id: invoker.loadSpectrumMusicDrafts.id,
        src: invoker.loadSpectrumMusicDrafts.src,
        input: ({ context }) => {
          const input = createSpectrumMusicDraftBootstrapInput(context);
          if (input === null) {
            throw new Error("missing spectrum music identity for music loading");
          }

          return input;
        },
        onDone: {
          actions: assign(({ context, event }) =>
            createSpectrumMusicDraftLoadContext(context, event.output),
          ),
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign(({ context, event }) =>
            resetContextWith(
              {
                shape: {
                  hasPlayList: context.hasPlayList,
                  playlists: context.playlists,
                  pendingPlaylistPreview: context.pendingPlaylistPreview,
                  collections: context.collections,
                  configLibrary: context.configLibrary,
                  savePath: context.savePath,
                },
                runtime: {
                  playingPlaylistName: context.playingPlaylistName,
                  playingSessionGeneration: context.playingSessionGeneration,
                  nowPlayingTrackName: context.nowPlayingTrackName,
                  nowPlayingTrackUrl: context.nowPlayingTrackUrl,
                  nowPlayingTrackFilePath: context.nowPlayingTrackFilePath,
                  nowPlayingTrackStartMs: context.nowPlayingTrackStartMs,
                  nowPlayingTrackEndMs: context.nowPlayingTrackEndMs,
                  nowPlayingTrackLiked: context.nowPlayingTrackLiked,
                  playbackSurfaceStatus: context.playbackSurfaceStatus,
                  spectrumPlaybackScopeId: context.spectrumPlaybackScopeId,
                },
                chart: {
                  spectrumMusicDrafts: context.spectrumMusicDrafts,
                  spectrumMusicSourceContext: context.spectrumMusicSourceContext,
                },
                pending: {
                  error: toErrorMessage(event.error),
                },
              },
              resetLifecycle({
                reason: "stop spectrum chart on draft load failure",
                chart: resetLifecycleAction("closed", "spectrum"),
                lease: resetLifecycleAction("closed", context.activeLayoutId),
                transaction: resetLifecycleAction("closed", "spectrum-music-draft-load"),
              }),
            ),
          ),
        },
      },
      on: {
        run: ss.mainx.State.loading,
        [spectrumMusicNameChanged.evt]: {
          actions: assign(({ context, event }) => ({
            spectrumMusicDrafts: changeSpectrumMusicDraftName(
              context.spectrumMusicDrafts,
              event.output.id,
              event.output.name,
            ),
          })),
        },
        [spectrumMusicRangeChanged.evt]: {
          actions: assign(({ context, event }) => ({
            spectrumMusicDrafts: changeSpectrumMusicDraftRange(
              context.spectrumMusicDrafts,
              event.output.id,
              {
                endMs: event.output.endMs,
                startMs: event.output.startMs,
              },
            ),
          })),
        },
        [spectrumMusicDeleted.evt]: {
          actions: assign(({ context, event }) => ({
            spectrumMusicDrafts: deleteSpectrumMusicDraft(
              context.spectrumMusicDrafts,
              event.output.id,
            ),
          })),
        },
        [spectrumMusicCreateStarted.evt]: {
          actions: assign(({ context, event }) =>
            createSpectrumMusicCreateStartedContext(context, event.output.id),
          ),
        },
        [spectrumMusicDraftReset.evt]: {
          actions: assign(({ context, event }) => ({
            spectrumMusicDrafts: resetSpectrumMusicDraft(
              context.spectrumMusicDrafts,
              event.output.id,
            ),
          })),
        },
        back: [
          {
            guard: ({ context }) => hasSpectrumMusicUpdate(context),
            target: ss.mainx.State.play,
            actions: assign(({ context }) => createSpectrumOptimisticPlayReturnContext(context)),
          },
          {
            target: ss.mainx.State.play,
            actions: assign(({ context }) => createSpectrumPlayReturnContext(context)),
          },
        ],
      },
    },
    [ss.mainx.State.configLoading]: {
      invoke: {
        id: invoker.loadPlaylistDraft.id,
        src: invoker.loadPlaylistDraft.src,
        input: ({ context }) => {
          if (!context.pendingPlaylistName) {
            throw new Error("missing playlist name for config load");
          }

          return context.pendingPlaylistName;
        },
        onDone: {
          target: ss.mainx.State.config,
          actions: assign(({ context, event }) =>
            resetContextWith(
              {
                shape: {
                  hasPlayList: context.hasPlayList,
                  playlists: context.playlists,
                  pendingPlaylistPreview: context.pendingPlaylistPreview,
                  collections: context.collections,
                  configLibrary: context.configLibrary,
                  savePath: context.savePath,
                  draftBaseline: cloneDraft(event.output),
                  draft: event.output,
                },
                runtime: {
                  playingPlaylistName: null,
                  nowPlayingTrackName: null,
                },
                chart: {
                  activeLayoutId: context.activeLayoutId,
                },
                lease: {
                  titleToneHandoff: context.titleToneHandoff,
                },
              },
              resetLifecycle({
                reason: "accept playlist draft load into config chart",
                chart: resetLifecycleAction("opened", "playlist-config"),
                lease: context.activeLayoutId
                  ? resetLifecycleAction("preserved", context.activeLayoutId)
                  : resetLifecycleAction("closed", null),
                transaction: resetLifecycleAction("closed", "playlist-draft-load"),
              }),
            ),
          ),
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign(({ context, event }) =>
            resetContextWith(
              {
                shape: {
                  hasPlayList: context.hasPlayList,
                  playlists: context.playlists,
                  pendingPlaylistPreview: context.pendingPlaylistPreview,
                  collections: context.collections,
                  configLibrary: context.configLibrary,
                  savePath: context.savePath,
                },
                runtime: {
                  playingPlaylistName: null,
                  nowPlayingTrackName: null,
                },
                chart: {
                  activeLayoutId: context.activeLayoutId,
                },
                lease: {
                  titleToneHandoff: context.titleToneHandoff,
                },
                pending: {
                  error: toErrorMessage(event.error),
                },
              },
              resetLifecycle({
                reason: "close config loading transaction on playlist draft load failure",
                chart: resetLifecycleAction("closed", "playlist-config-loading"),
                lease: context.activeLayoutId
                  ? resetLifecycleAction("preserved", context.activeLayoutId)
                  : resetLifecycleAction("closed", null),
                transaction: resetLifecycleAction("closed", "playlist-draft-load"),
              }),
            ),
          ),
        },
      },
      on: {
        run: ss.mainx.State.loading,
        back: {
          target: ss.mainx.State.ready,
          actions: assign(({ context }) =>
            resetContextWith(
              {
                shape: {
                  hasPlayList: context.hasPlayList,
                  playlists: context.playlists,
                  pendingPlaylistPreview: context.pendingPlaylistPreview,
                  collections: context.collections,
                  configLibrary: context.configLibrary,
                  savePath: context.savePath,
                },
                runtime: {
                  playingPlaylistName: null,
                  nowPlayingTrackName: null,
                },
                lease: {
                  titleToneHandoff: context.activeLayoutId
                    ? createCollectionTitleHandoff(context.activeLayoutId, "solid")
                    : context.titleToneHandoff,
                },
              },
              resetLifecycle({
                reason: "leave config loading before draft load completes",
                chart: resetLifecycleAction("closed", "playlist-config-loading"),
                lease: context.activeLayoutId
                  ? resetLifecycleAction("opened", context.activeLayoutId)
                  : resetLifecycleAction("closed", null),
                transaction: resetLifecycleAction("closed", "playlist-draft-load"),
              }),
            ),
          ),
        },
      },
    },
    [ss.mainx.State.config]: {
      on: {
        run: ss.mainx.State.loading,
        back: {
          target: ss.mainx.State.ready,
          actions: assign(({ context }) => {
            const backPlan = resolveConfigBackTitleSharePlan({
              activeLayoutId: context.activeLayoutId,
              draft: context.draft,
              draftBaseline: context.draftBaseline,
            });
            recordTrace("app-title-handoff-back-projected", {
              activeLayoutId: context.activeLayoutId,
              backPlanHandoffLayoutId: backPlan.titleToneHandoff?.layoutId ?? null,
              backPlanHandoffTone: backPlan.titleToneHandoff?.tone ?? null,
              backPlanReturnLayoutId: backPlan.returnLayoutId,
              backPlanSourceLayoutId: backPlan.sourceLayoutId,
              draftBaselineName: context.draftBaseline?.name ?? null,
              draftName: context.draft?.name ?? null,
              hasDraftChanges: backPlan.hasDraftChanges,
              pendingPreviewName: context.pendingPlaylistPreview?.playlist.name ?? null,
            });

            return resetContextWith(
              {
                shape: {
                  hasPlayList: context.hasPlayList,
                  playlists: context.playlists,
                  pendingPlaylistPreview: context.pendingPlaylistPreview,
                  collections: context.collections,
                  configLibrary: context.configLibrary,
                  savePath: context.savePath,
                },
                runtime: {
                  playingPlaylistName: null,
                  nowPlayingTrackName: null,
                },
                chart: {
                  activeLayoutId: backPlan.sourceLayoutId,
                },
                lease: {
                  titleToneHandoff: backPlan.titleToneHandoff,
                },
              },
              resetLifecycle({
                reason: "close config chart and return to app shape",
                chart: resetLifecycleAction("closed", "playlist-config"),
                transaction: resetLifecycleAction("closed", "playlist-draft"),
                lease: backPlan.sourceLayoutId
                  ? resetLifecycleAction("opened", backPlan.sourceLayoutId)
                  : resetLifecycleAction("closed", null),
              }),
            );
          }),
        },
        opencreate: {
          actions: assign(({ context }) =>
            resetContextWith(
              {
                shape: {
                  hasPlayList: context.hasPlayList,
                  playlists: context.playlists,
                  pendingPlaylistPreview: context.pendingPlaylistPreview,
                  collections: context.collections,
                  configLibrary: context.configLibrary,
                  savePath: context.savePath,
                  draftBaseline: createDraft(),
                  draft: createDraft(),
                },
                runtime: {
                  playingPlaylistName: null,
                  nowPlayingTrackName: null,
                },
                chart: {
                  activeLayoutId: CREATE_COLLECTION_LAYOUT_ID,
                },
                lease: {
                  titleToneHandoff: createCollectionTitleHandoff(
                    CREATE_COLLECTION_LAYOUT_ID,
                    resolveTitleShareToneFromDraft(context.draft),
                  ),
                },
              },
              resetLifecycle({
                reason: "replace config chart with create playlist chart",
                chart: resetLifecycleAction("opened", "playlist-config"),
                lease: resetLifecycleAction("opened", CREATE_COLLECTION_LAYOUT_ID),
                transaction: resetLifecycleAction("closed", "playlist-draft"),
              }),
            ),
          ),
        },
        [openPlaylist.evt]: [
          {
            target: ss.mainx.State.configLoading,
            actions: assign(({ context, event }) => ({
              ...createConfigLoadingContext(context, event.output),
              titleToneHandoff: createCollectionTitleHandoff(
                playlistTitleLayoutId(event.output),
                resolveTitleShareToneFromDraft(context.draft),
              ),
            })),
          },
        ],
        [draftNameChanged.evt]: {
          actions: assign(({ context, event }) => {
            const nextDraft = context.draft
              ? {
                  ...context.draft,
                  name: event.output,
                }
              : null;
            recordTrace("app-draft-name-event-reduced", {
              draftBaselineName: context.draftBaseline?.name ?? null,
              nextDraftName: nextDraft?.name ?? null,
              previousDraftName: context.draft?.name ?? null,
              requestedName: event.output,
            });
            return {
              draft: nextDraft,
            };
          }),
        },
        [collectionUpdatesRequested.evt]: {
          target: ss.mainx.State.configUpdatingCollectionUpdates,
          actions: assign({
            pendingCollectionUpdatesChange: ({ event }) => event.output,
            error: () => null,
          }),
        },
      },
    },
    [ss.mainx.State.configUpdatingCollectionUpdates]: {
      invoke: {
        id: invoker.setCollectionUpdates.id,
        src: invoker.setCollectionUpdates.src,
        input: ({ context }) => {
          if (!context.pendingCollectionUpdatesChange) {
            throw new Error("missing collection updates request");
          }

          return context.pendingCollectionUpdatesChange;
        },
        onDone: {
          target: ss.mainx.State.config,
          actions: assign(({ context, event }) => ({
            collections: upsertCollectionIntoCollections(context.collections, event.output),
            draft: upsertCollectionIntoDraft(context.draft, event.output),
            pendingCollectionUpdatesChange: null,
          })),
        },
        onError: {
          target: ss.mainx.State.config,
          actions: assign({
            pendingCollectionUpdatesChange: () => null,
            error: ({ event }) => toErrorMessage(event.error),
          }),
        },
      },
    },
    [ss.mainx.State.error]: {
      on: {
        run: ss.mainx.State.loading,
      },
    },
  },
});
