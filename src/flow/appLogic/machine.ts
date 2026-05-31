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
  type NowPlayingTrackEvidence,
} from "./core";
import {
  createSpectrumCurrentMusicDraft,
  activateSpectrumNewMusicDraft,
  changeSpectrumMusicDraftName,
  changeSpectrumMusicDraftRange,
  createMusicDraftCreates,
  createMusicDraftDeletes,
  createMusicDraftEdits,
  createMusicInCollections,
  deleteMusicFromCollections,
  deleteSpectrumMusicDraft,
  hasSpectrumMusicDraftCommitOperations,
  mergeSpectrumMusicDrafts,
  mergeSpectrumMusicDraftsWithSourceContext,
  resetSpectrumMusicDraft,
  updateMusicInCollections,
  type MusicCreate,
  type MusicDelete,
  type MusicEdit,
} from "./musicTitle";
import { resolveConfigBackTitleSharePlan, resolveTitleShareToneFromDraft } from "./titleShare";
import {
  BootstrapLoadError,
  invoker,
  payloads,
  ss,
  type MusicDeletesResult,
  type MusicCreateResult,
  type MusicCreatesResult,
  type SpectrumMusicDraftBootstrapInput,
  type MusicUpdateResult,
  type MusicUpdatesResult,
  type MusicUpdatesCommitted,
  type MusicCreatesCommitted,
  type MusicDeletesCommitted,
} from "./events";
import { src } from "./src";

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function resolveSavePathFromLoadingError(error: unknown, fallback: string) {
  return error instanceof BootstrapLoadError ? error.savePath : fallback;
}

function hasSpectrumMusicUpdate(context: Context) {
  return hasSpectrumMusicDraftCommitOperations(context.spectrumMusicDrafts);
}

function createMusicEditFromUpdate(result: MusicUpdateResult): MusicEdit {
  return {
    alias: result.music.alias,
    endMs: result.music.end_ms,
    startMs: result.music.start_ms,
    targetEndMs: result.input.targetEndMs,
    targetStartMs: result.input.targetStartMs,
    url: result.input.url,
  };
}

function createMusicEditsFromUpdates(result: MusicUpdatesResult): MusicEdit[] {
  return result.results.map(createMusicEditFromUpdate);
}

function createMusicEditsFromCommittedUpdates(result: MusicUpdatesCommitted): MusicEdit[] {
  return createMusicEditsFromUpdates(result.result);
}

function createMusicDeletesFromResult(result: MusicDeletesResult): MusicDelete[] {
  return result.results.map((deletion) => ({
    endMs: deletion.endMs,
    startMs: deletion.startMs,
    url: deletion.url,
  }));
}

function createMusicDeletesFromCommittedResult(result: MusicDeletesCommitted): MusicDelete[] {
  return createMusicDeletesFromResult(result.result);
}

function createMusicCreateFromResult(result: MusicCreateResult): MusicCreate {
  return {
    sourceCollectionUrl: result.input.sourceCollectionUrl,
    music: result.music,
  };
}

function createMusicCreatesFromResult(result: MusicCreatesResult): MusicCreate[] {
  return result.results.map(createMusicCreateFromResult);
}

function createMusicCreatesFromCommittedResult(result: MusicCreatesCommitted): MusicCreate[] {
  return createMusicCreatesFromResult(result.result);
}

function updateCollectionsWithMusicEdits(collections: Context["collections"], edits: MusicEdit[]) {
  return edits.reduce(
    (currentCollections, edit) => updateMusicInCollections(currentCollections, edit),
    collections,
  );
}

function deleteMusicFromContextCollections(
  collections: Context["collections"],
  deletions: readonly MusicDelete[],
) {
  return deletions.reduce(
    (currentCollections, deletion) => deleteMusicFromCollections(currentCollections, deletion),
    collections,
  );
}

function createMusicInContextCollections(
  collections: Context["collections"],
  creates: readonly MusicCreate[],
) {
  return creates.reduce(
    (currentCollections, create) => createMusicInCollections(currentCollections, create),
    collections,
  );
}

function resolveCurrentMusicEdit(context: Context, edits: readonly MusicEdit[]) {
  return (
    edits.find(
      (edit) =>
        edit.url === context.nowPlayingTrackUrl &&
        edit.targetStartMs === context.nowPlayingTrackStartMs &&
        edit.targetEndMs === context.nowPlayingTrackEndMs,
    ) ?? null
  );
}

function resolveCurrentMusicDelete(context: Context, deletions: readonly MusicDelete[]) {
  return (
    deletions.find(
      (deletion) =>
        deletion.url === context.nowPlayingTrackUrl &&
        deletion.startMs === context.nowPlayingTrackStartMs &&
        deletion.endMs === context.nowPlayingTrackEndMs,
    ) ?? null
  );
}

function resolvePendingCurrentMusicEdit(context: Context) {
  return resolveCurrentMusicEdit(context, createMusicDraftEdits(context.spectrumMusicDrafts));
}

function resolvePendingCurrentMusicDelete(context: Context) {
  return resolveCurrentMusicDelete(context, createMusicDraftDeletes(context.spectrumMusicDrafts));
}

function createSpectrumPlayReturnSurfaceContext(context: Context) {
  const currentMusicEdit = resolvePendingCurrentMusicEdit(context);
  const currentMusicDelete = resolvePendingCurrentMusicDelete(context);

  return {
    nowPlayingTrackName:
      currentMusicDelete !== null ? null : (currentMusicEdit?.alias ?? context.nowPlayingTrackName),
    nowPlayingTrackUrl: currentMusicDelete !== null ? null : context.nowPlayingTrackUrl,
    nowPlayingTrackFilePath: currentMusicDelete !== null ? null : context.nowPlayingTrackFilePath,
    nowPlayingTrackStartMs:
      currentMusicDelete !== null
        ? null
        : (currentMusicEdit?.startMs ?? context.nowPlayingTrackStartMs),
    nowPlayingTrackEndMs:
      currentMusicDelete !== null
        ? null
        : (currentMusicEdit?.endMs ?? context.nowPlayingTrackEndMs),
    nowPlayingTrackLiked: currentMusicDelete !== null ? null : context.nowPlayingTrackLiked,
    titleToneHandoff: context.activeLayoutId
      ? createCollectionTitleHandoff(context.activeLayoutId, "solid")
      : null,
  };
}

function createNextSpectrumMusicCommitEpoch(context: Context) {
  return context.spectrumMusicCommitEpoch + 1;
}

function createSpectrumPlayReturnContext(
  context: Context,
  args: {
    musicCreates?: readonly MusicCreate[];
    musicDeletes?: readonly MusicDelete[];
    musicEdits?: readonly MusicEdit[];
    spectrumMusicCommitEpoch?: number;
  } = {},
) {
  const musicCreates = args.musicCreates ?? [];
  const musicEdits = args.musicEdits ?? [];
  const musicDeletes = args.musicDeletes ?? [];
  const currentMusicEdit = resolveCurrentMusicEdit(context, musicEdits);
  const currentMusicDelete = resolveCurrentMusicDelete(context, musicDeletes);

  return resetContextWith({
    hasPlayList: context.hasPlayList,
    playlists: context.playlists,
    pendingPlaylistPreview: context.pendingPlaylistPreview,
    collections:
      musicDeletes.length > 0
        ? deleteMusicFromContextCollections(context.collections, musicDeletes)
        : musicCreates.length > 0
          ? createMusicInContextCollections(context.collections, musicCreates)
          : musicEdits.length > 0
            ? updateCollectionsWithMusicEdits(context.collections, [...musicEdits])
            : context.collections,
    configLibrary: context.configLibrary,
    savePath: context.savePath,
    playingPlaylistName: context.playingPlaylistName,
    nowPlayingTrackName:
      currentMusicDelete !== null ? null : (currentMusicEdit?.alias ?? context.nowPlayingTrackName),
    nowPlayingTrackUrl: currentMusicDelete !== null ? null : context.nowPlayingTrackUrl,
    nowPlayingTrackFilePath: currentMusicDelete !== null ? null : context.nowPlayingTrackFilePath,
    nowPlayingTrackStartMs:
      currentMusicDelete !== null
        ? null
        : (currentMusicEdit?.startMs ?? context.nowPlayingTrackStartMs),
    nowPlayingTrackEndMs:
      currentMusicDelete !== null
        ? null
        : (currentMusicEdit?.endMs ?? context.nowPlayingTrackEndMs),
    nowPlayingTrackLiked: currentMusicDelete !== null ? null : context.nowPlayingTrackLiked,
    spectrumPlaybackScopeId: context.spectrumPlaybackScopeId,
    spectrumMusicSourceContext: null,
    spectrumMusicCommitEpoch: args.spectrumMusicCommitEpoch ?? context.spectrumMusicCommitEpoch,
    titleToneHandoff: createSpectrumPlayReturnSurfaceContext(context).titleToneHandoff,
  });
}

function createSpectrumOptimisticPlayReturnContext(context: Context) {
  return createSpectrumPlayReturnContext(context, {
    musicCreates: createMusicDraftCreates(context.spectrumMusicDrafts),
    musicDeletes: createMusicDraftDeletes(context.spectrumMusicDrafts),
    musicEdits: createMusicDraftEdits(context.spectrumMusicDrafts),
    spectrumMusicCommitEpoch: createNextSpectrumMusicCommitEpoch(context),
  });
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
  return resetContextWith({
    hasPlayList: context.hasPlayList,
    playlists: context.playlists,
    pendingPlaylistPreview: context.pendingPlaylistPreview,
    collections: context.collections,
    configLibrary: context.configLibrary,
    savePath: context.savePath,
    playingPlaylistName: context.playingPlaylistName,
    nowPlayingTrackName: context.nowPlayingTrackName,
    nowPlayingTrackUrl: context.nowPlayingTrackUrl,
    nowPlayingTrackFilePath: context.nowPlayingTrackFilePath,
    nowPlayingTrackStartMs: context.nowPlayingTrackStartMs,
    nowPlayingTrackEndMs: context.nowPlayingTrackEndMs,
    nowPlayingTrackLiked: context.nowPlayingTrackLiked,
    spectrumPlaybackScopeId: context.spectrumPlaybackScopeId,
    spectrumMusicDrafts: createCurrentSpectrumMusicDrafts(context),
    spectrumMusicSourceContext: null,
    activeLayoutId: context.playingPlaylistName
      ? playlistTitleLayoutId(context.playingPlaylistName)
      : null,
  });
}

function createOpenSpectrumErrorContext(context: Context) {
  return resetContextWith({
    hasPlayList: context.hasPlayList,
    playlists: context.playlists,
    pendingPlaylistPreview: context.pendingPlaylistPreview,
    collections: context.collections,
    configLibrary: context.configLibrary,
    savePath: context.savePath,
    playingPlaylistName: context.playingPlaylistName,
    nowPlayingTrackName: context.nowPlayingTrackName,
    nowPlayingTrackUrl: context.nowPlayingTrackUrl,
    nowPlayingTrackFilePath: context.nowPlayingTrackFilePath,
    nowPlayingTrackStartMs: context.nowPlayingTrackStartMs,
    nowPlayingTrackEndMs: context.nowPlayingTrackEndMs,
    spectrumPlaybackScopeId: context.spectrumPlaybackScopeId,
    spectrumMusicDrafts: [],
    spectrumMusicSourceContext: null,
    error: "missing spectrum music identity for music loading",
  });
}

function resolvePendingPlaylistPreviewDraft(context: Context, playlistName: string) {
  if (context.pendingPlaylistPreview?.playlist.name !== playlistName) {
    return null;
  }

  return context.pendingPlaylistPreview.draft;
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

function createPlayReadyContext(context: Context, playlistName: string) {
  const pendingEvidence =
    context.pendingNowPlayingTrackEvidence?.playlist_name === playlistName
      ? context.pendingNowPlayingTrackEvidence
      : null;
  const nowPlayingTrackPatch = pendingEvidence
    ? createNowPlayingTrackPatch(context, pendingEvidence)
    : {
        nowPlayingTrackName: null,
        nowPlayingTrackUrl: null,
        nowPlayingTrackFilePath: null,
        nowPlayingTrackStartMs: null,
        nowPlayingTrackEndMs: null,
        nowPlayingTrackLiked: null,
        pendingSpectrumMusicCreateId: null,
        spectrumMusicSourceContext: null,
        spectrumMusicDrafts: [],
      };

  return resetContextWith({
    hasPlayList: context.hasPlayList,
    playlists: context.playlists,
    pendingPlaylistPreview: context.pendingPlaylistPreview,
    collections: context.collections,
    configLibrary: context.configLibrary,
    savePath: context.savePath,
    playingPlaylistName: playlistName,
    ...nowPlayingTrackPatch,
    pendingPlaylistPlaybackName: null,
    pendingNowPlayingTrackEvidence: null,
  });
}

function createPendingPreviewPlaybackContext(context: Context, playlistName: string) {
  return resetContextWith({
    hasPlayList: context.hasPlayList,
    playlists: context.playlists,
    pendingPlaylistPreview: context.pendingPlaylistPreview,
    collections: context.collections,
    configLibrary: context.configLibrary,
    savePath: context.savePath,
    pendingPlaylistPlaybackName: playlistName,
    playingPlaylistName: null,
    nowPlayingTrackName: null,
    nowPlayingTrackLiked: null,
    activeLayoutId: playlistTitleLayoutId(playlistName),
    titleToneHandoff: createCollectionTitleHandoff(playlistTitleLayoutId(playlistName), "solid"),
  });
}

function createPlaylistUpsertedContext(
  context: Context,
  event: { output: { playlist: Context["playlists"][number]; previousName: string | null } },
) {
  return {
    hasPlayList: true,
    playlists: upsertPlaylistIntoPlaylists(
      context.playlists,
      event.output.playlist,
      event.output.previousName,
    ),
    pendingPlaylistPreview: null,
    pendingPlaylistPlaybackName:
      context.pendingPlaylistPlaybackName === event.output.playlist.name
        ? null
        : context.pendingPlaylistPlaybackName,
  };
}

function createPendingPreviewConfigContext(context: Context, playlistName: string) {
  const draft = resolvePendingPlaylistPreviewDraft(context, playlistName);
  const activeLayoutId = playlistTitleLayoutId(playlistName);

  if (!draft) {
    return null;
  }

  return resetContextWith({
    hasPlayList: context.hasPlayList,
    playlists: context.playlists,
    pendingPlaylistPreview: context.pendingPlaylistPreview,
    collections: context.collections,
    configLibrary: context.configLibrary,
    savePath: context.savePath,
    playingPlaylistName: null,
    nowPlayingTrackName: null,
    nowPlayingTrackLiked: null,
    activeLayoutId,
    titleToneHandoff: createCollectionTitleHandoff(activeLayoutId, "solid"),
    draftBaseline: cloneDraft(draft),
    draft,
  });
}

function createConfigLoadingContext(context: Context, playlistName: string) {
  const activeLayoutId = playlistTitleLayoutId(playlistName);

  return resetContextWith({
    hasPlayList: context.hasPlayList,
    playlists: context.playlists,
    pendingPlaylistPreview: context.pendingPlaylistPreview,
    collections: context.collections,
    configLibrary: context.configLibrary,
    savePath: context.savePath,
    playingPlaylistName: null,
    nowPlayingTrackName: null,
    nowPlayingTrackLiked: null,
    activeLayoutId,
    titleToneHandoff: createCollectionTitleHandoff(activeLayoutId, "solid"),
    pendingPlaylistName: playlistName,
  });
}

const openPlaylist = payloads["playlist.open"];
const playPlaylist = payloads["playlist.play"];
const playlistPlaybackAccepted = payloads["playlist.playback.accepted"];
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
      actions: assign(({ context, event }) => createPlaylistUpsertedContext(context, event)),
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
        };
      }),
    },
    [playlistPreviewChanged.evt]: {
      actions: assign({
        pendingPlaylistPreview: ({ event }) => event.output,
      }),
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
        const matchesCurrentPlayback =
          context.playingPlaylistName === event.output.playlist_name ||
          context.pendingPlaylistPlaybackName === event.output.playlist_name;

        if (!matchesCurrentPlayback) {
          return {};
        }

        if (
          context.playingPlaylistName === event.output.playlist_name
        ) {
          return {
            ...createNowPlayingTrackPatch(context, event.output),
            pendingNowPlayingTrackEvidence: event.output,
          };
        }

        return {
          pendingNowPlayingTrackEvidence: event.output,
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
        if (event.output.epoch !== context.spectrumMusicCommitEpoch) {
          return {};
        }

        const musicEdits = createMusicEditsFromCommittedUpdates(event.output);
        return musicEdits.length > 0
          ? {
              collections: updateCollectionsWithMusicEdits(context.collections, musicEdits),
            }
          : {};
      }),
    },
    [spectrumMusicCreatesCommitted.evt]: {
      actions: assign(({ context, event }) => {
        if (event.output.epoch !== context.spectrumMusicCommitEpoch) {
          return {};
        }

        const musicCreates = createMusicCreatesFromCommittedResult(event.output);
        return musicCreates.length > 0
          ? {
              collections: createMusicInContextCollections(context.collections, musicCreates),
            }
          : {};
      }),
    },
    [spectrumMusicDeletesCommitted.evt]: {
      actions: assign(({ context, event }) => {
        if (event.output.epoch !== context.spectrumMusicCommitEpoch) {
          return {};
        }

        const musicDeletes = createMusicDeletesFromCommittedResult(event.output);
        return musicDeletes.length > 0
          ? {
              collections: deleteMusicFromContextCollections(context.collections, musicDeletes),
            }
          : {};
      }),
    },
    [spectrumMusicCommitFailed.evt]: {
      actions: assign(({ context, event }) =>
        event.output.epoch === context.spectrumMusicCommitEpoch
          ? { error: event.output.error }
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
            resetContextWith({
              hasPlayList: event.output.hasPlayList,
              playlists: event.output.playlists,
              pendingPlaylistPreview: null,
              collections: event.output.collections,
              configLibrary: event.output.configLibrary,
              savePath: event.output.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
            }),
          ),
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign(({ context, event }) =>
            resetContextWith({
              savePath: resolveSavePathFromLoadingError(event.error, context.savePath),
              error: toErrorMessage(event.error),
            }),
          ),
        },
      },
    },
    [ss.mainx.State.ready]: {
      on: {
        run: ss.mainx.State.loading,
        [playlistUpserted.evt]: {
          actions: assign(({ context, event }) => createPlaylistUpsertedContext(context, event)),
        },
        opencreate: {
          target: ss.mainx.State.config,
          actions: assign(({ context }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              pendingPlaylistPreview: context.pendingPlaylistPreview,
              collections: context.collections,
              configLibrary: context.configLibrary,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
              activeLayoutId: CREATE_COLLECTION_LAYOUT_ID,
              titleToneHandoff: createCollectionTitleHandoff(CREATE_COLLECTION_LAYOUT_ID, "solid"),
              draftBaseline: createDraft(),
              draft: createDraft(),
            }),
          ),
        },
        [playPlaylist.evt]: [
          {
            guard: ({ context, event }) =>
              resolvePendingPlaylistPreviewDraft(context, event.output) !== null,
            actions: assign(({ context, event }) =>
              createPendingPreviewPlaybackContext(context, event.output),
            ),
          },
          {
            actions: assign(({ event }) => ({
              pendingPlaylistPlaybackName: event.output,
            })),
          },
        ],
        [playlistPlaybackAccepted.evt]: {
          target: ss.mainx.State.play,
          actions: assign(({ context, event }) =>
            createPlayReadyContext(context, event.output.playlistName),
          ),
        },
        [openPlaylist.evt]: [
          {
            guard: ({ context, event }) =>
              resolvePendingPlaylistPreviewDraft(context, event.output) !== null,
            target: ss.mainx.State.config,
            actions: assign(
              ({ context, event }) =>
                createPendingPreviewConfigContext(context, event.output) ??
                createConfigLoadingContext(context, event.output),
            ),
          },
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
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              pendingPlaylistPreview: context.pendingPlaylistPreview,
              collections: context.collections,
              configLibrary: context.configLibrary,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
            }),
          ),
        },
        opencreate: {
          target: ss.mainx.State.config,
          actions: assign(({ context }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              pendingPlaylistPreview: context.pendingPlaylistPreview,
              collections: context.collections,
              configLibrary: context.configLibrary,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
              activeLayoutId: CREATE_COLLECTION_LAYOUT_ID,
              titleToneHandoff: createCollectionTitleHandoff(CREATE_COLLECTION_LAYOUT_ID, "solid"),
              draftBaseline: createDraft(),
              draft: createDraft(),
            }),
          ),
        },
        [playPlaylist.evt]: [
          {
            guard: ({ context, event }) =>
              resolvePendingPlaylistPreviewDraft(context, event.output) !== null,
            target: ss.mainx.State.ready,
            actions: assign(({ context, event }) =>
              createPendingPreviewPlaybackContext(context, event.output),
            ),
          },
          {
            actions: assign(({ event }) => ({
              pendingPlaylistPlaybackName: event.output,
            })),
          },
        ],
        [playlistPlaybackAccepted.evt]: {
          reenter: true,
          actions: assign(({ context, event }) =>
            createPlayReadyContext(context, event.output.playlistName),
          ),
        },
        [openPlaylist.evt]: [
          {
            guard: ({ context, event }) =>
              resolvePendingPlaylistPreviewDraft(context, event.output) !== null,
            target: ss.mainx.State.config,
            actions: assign(
              ({ context, event }) =>
                createPendingPreviewConfigContext(context, event.output) ??
                createConfigLoadingContext(context, event.output),
            ),
          },
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
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              pendingPlaylistPreview: context.pendingPlaylistPreview,
              collections: context.collections,
              configLibrary: context.configLibrary,
              savePath: context.savePath,
              playingPlaylistName: context.playingPlaylistName,
              nowPlayingTrackName: context.nowPlayingTrackName,
              nowPlayingTrackUrl: context.nowPlayingTrackUrl,
              nowPlayingTrackFilePath: context.nowPlayingTrackFilePath,
              nowPlayingTrackStartMs: context.nowPlayingTrackStartMs,
              nowPlayingTrackEndMs: context.nowPlayingTrackEndMs,
              spectrumPlaybackScopeId: context.spectrumPlaybackScopeId,
              spectrumMusicDrafts: context.spectrumMusicDrafts,
              spectrumMusicSourceContext: context.spectrumMusicSourceContext,
              error: toErrorMessage(event.error),
            }),
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
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              pendingPlaylistPreview: context.pendingPlaylistPreview,
              collections: context.collections,
              configLibrary: context.configLibrary,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
              activeLayoutId: context.activeLayoutId,
              titleToneHandoff: context.titleToneHandoff,
              draftBaseline: cloneDraft(event.output),
              draft: event.output,
            }),
          ),
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign(({ context, event }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              pendingPlaylistPreview: context.pendingPlaylistPreview,
              collections: context.collections,
              configLibrary: context.configLibrary,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
              activeLayoutId: context.activeLayoutId,
              titleToneHandoff: context.titleToneHandoff,
              error: toErrorMessage(event.error),
            }),
          ),
        },
      },
      on: {
        run: ss.mainx.State.loading,
        back: {
          target: ss.mainx.State.ready,
          actions: assign(({ context }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              pendingPlaylistPreview: context.pendingPlaylistPreview,
              collections: context.collections,
              configLibrary: context.configLibrary,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
              titleToneHandoff: context.activeLayoutId
                ? createCollectionTitleHandoff(context.activeLayoutId, "solid")
                : context.titleToneHandoff,
            }),
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

            return resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              pendingPlaylistPreview: context.pendingPlaylistPreview,
              collections: context.collections,
              configLibrary: context.configLibrary,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
              titleToneHandoff: backPlan.titleToneHandoff,
            });
          }),
        },
        opencreate: {
          actions: assign(({ context }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              pendingPlaylistPreview: context.pendingPlaylistPreview,
              collections: context.collections,
              configLibrary: context.configLibrary,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
              activeLayoutId: CREATE_COLLECTION_LAYOUT_ID,
              titleToneHandoff: createCollectionTitleHandoff(
                CREATE_COLLECTION_LAYOUT_ID,
                resolveTitleShareToneFromDraft(context.draft),
              ),
              draftBaseline: createDraft(),
              draft: createDraft(),
            }),
          ),
        },
        [openPlaylist.evt]: [
          {
            guard: ({ context, event }) =>
              resolvePendingPlaylistPreviewDraft(context, event.output) !== null,
            target: ss.mainx.State.config,
            actions: assign(({ context, event }) => {
              const nextContext = createPendingPreviewConfigContext(context, event.output);

              return nextContext
                ? {
                    ...nextContext,
                    titleToneHandoff: createCollectionTitleHandoff(
                      playlistTitleLayoutId(event.output),
                      resolveTitleShareToneFromDraft(context.draft),
                    ),
                  }
                : createConfigLoadingContext(context, event.output);
            }),
          },
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
          actions: assign({
            draft: ({ context, event }) =>
              context.draft
                ? {
                    ...context.draft,
                    name: event.output,
                  }
                : null,
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
