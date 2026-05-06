import { assign } from "xstate";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  createCollectionTitleHandoff,
  createDraft,
  createDraftFromPlaylistName,
  cloneDraft,
  includeDraftSidebarItem,
  initialContext,
  playlistTitleLayoutId,
  removePlaylistFromPlaylists,
  resolvePlaylistsWithPreview,
  removeDraftSidebarItem,
  resetContextWith,
  upsertPlaylistIntoPlaylists,
  upsertCollectionIntoDraft,
  upsertCollectionIntoCollections,
  type Context,
} from "./core";
import {
  changeSpectrumMusicTitleDraftName,
  changeSpectrumMusicTitleDraftRange,
  createSpectrumMusicTitleDraft,
  hasSpectrumMusicTitleChanges,
  resolveSpectrumMusicTitleCommit,
  resetSpectrumMusicTitleDraft,
  updateMusicInCollections,
  updateMusicInPlaylistPreview,
  updateMusicInPlaylists,
  type MusicEdit,
} from "./musicTitle";
import { resolveConfigBackTitleSharePlan, resolveTitleShareToneFromDraft } from "./titleShare";
import {
  BootstrapLoadError,
  invoker,
  payloads,
  ss,
  type MusicUpdateInput,
  type MusicUpdateResult,
} from "./events";
import { src } from "./src";

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function resolveSavePathFromLoadingError(error: unknown, fallback: string) {
  return error instanceof BootstrapLoadError ? error.savePath : fallback;
}

function hasSpectrumMusicUpdate(context: Context) {
  return hasSpectrumMusicTitleChanges(context.spectrumMusicTitleDraft);
}

function resolveSpectrumMusicUpdateInput(context: Context): MusicUpdateInput {
  const titleCommit = resolveSpectrumMusicTitleCommit(context.spectrumMusicTitleDraft);
  const draft = context.spectrumMusicTitleDraft;

  if (!titleCommit || !draft || !hasSpectrumMusicTitleChanges(draft)) {
    throw new Error("missing spectrum music update");
  }

  if (
    draft.url === null ||
    draft.baselineStart === null ||
    draft.baselineEnd === null ||
    draft.start === null ||
    draft.end === null
  ) {
    throw new Error("missing spectrum music identity for update");
  }

  return {
    alias: titleCommit.alias,
    end: draft.end,
    start: draft.start,
    targetEnd: draft.baselineEnd,
    targetStart: draft.baselineStart,
    url: draft.url,
  };
}

function createMusicEditFromUpdate(result: MusicUpdateResult): MusicEdit {
  return {
    alias: result.music.alias,
    end: result.music.end,
    start: result.music.start,
    targetEnd: result.input.targetEnd,
    targetStart: result.input.targetStart,
    url: result.input.url,
  };
}

function createSpectrumPlayReturnContext(context: Context, musicEdit: MusicEdit | null) {
  return resetContextWith({
    hasPlayList: context.hasPlayList,
    playlists: musicEdit ? updateMusicInPlaylists(context.playlists, musicEdit) : context.playlists,
    pendingPlaylistPreview: musicEdit
      ? updateMusicInPlaylistPreview(context.pendingPlaylistPreview, musicEdit)
      : context.pendingPlaylistPreview,
    collections: musicEdit
      ? updateMusicInCollections(context.collections, musicEdit)
      : context.collections,
    savePath: context.savePath,
    playingPlaylistName: context.playingPlaylistName,
    nowPlayingTrackName: musicEdit?.alias ?? context.nowPlayingTrackName,
    nowPlayingTrackUrl: context.nowPlayingTrackUrl,
    nowPlayingTrackFilePath: context.nowPlayingTrackFilePath,
    nowPlayingTrackStart: musicEdit?.start ?? context.nowPlayingTrackStart,
    nowPlayingTrackEnd: musicEdit?.end ?? context.nowPlayingTrackEnd,
    shouldStartPlayback: false,
    titleToneHandoff: context.activeLayoutId
      ? createCollectionTitleHandoff(context.activeLayoutId, "solid")
      : null,
  });
}

const openPlaylist = payloads["playlist.open"];
const playPlaylist = payloads["playlist.play"];
const playlistUpserted = payloads["playlist.upserted"];
const playlistDeleted = payloads["playlist.deleted"];
const playlistPreviewChanged = payloads["playlist.preview.changed"];
const draftNameChanged = payloads["draft.name.changed"];
const spectrumMusicTitleChanged = payloads["spectrum.music_title.changed"];
const spectrumMusicRangeChanged = payloads["spectrum.music_range.changed"];
const spectrumMusicDraftReset = payloads["spectrum.music_draft.reset"];
const savePathChanged = payloads["save_path.changed"];
const collectionUpserted = payloads["collection.upserted"];
const draftCollectionUpserted = payloads["draft.collection.upserted"];
const draftItemIncluded = payloads["draft.item.included"];
const draftItemRemoved = payloads["draft.item.removed"];
const collectionUpdatesRequested = payloads["collection.updates.requested"];
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
        };
      }),
    },
    [playlistUpserted.evt]: {
      actions: assign(({ context, event }) => ({
        hasPlayList: true,
        playlists: upsertPlaylistIntoPlaylists(
          context.playlists,
          event.output.playlist,
          event.output.previousName,
        ),
      })),
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
          draft: upsertCollectionIntoDraft(context.draft, event.output),
        };
      }),
    },
    [draftItemIncluded.evt]: {
      actions: assign(({ context, event }) => ({
        draft: includeDraftSidebarItem(context.draft, context.collections, event.output),
      })),
    },
    [draftItemRemoved.evt]: {
      actions: assign(({ context, event }) => ({
        draft: removeDraftSidebarItem(context.draft, event.output),
      })),
    },
    [nowPlayingTrackChanged.evt]: {
      actions: assign(({ context, event }) => {
        if (
          !context.playingPlaylistName ||
          context.playingPlaylistName !== event.output.playlist_name
        ) {
          return {};
        }

        const nextSpectrumMusicTitleDraft =
          context.spectrumMusicTitleDraft &&
          !hasSpectrumMusicTitleChanges(context.spectrumMusicTitleDraft)
            ? createSpectrumMusicTitleDraft({
                nowPlayingTrackName: event.output.music_name,
                nowPlayingTrackUrl: event.output.music_url,
                nowPlayingTrackStart: event.output.start,
                nowPlayingTrackEnd: event.output.end,
              })
            : context.spectrumMusicTitleDraft;

        return {
          nowPlayingTrackName: event.output.music_name,
          nowPlayingTrackUrl: event.output.music_url,
          nowPlayingTrackFilePath: event.output.file_path,
          nowPlayingTrackStart: event.output.start,
          nowPlayingTrackEnd: event.output.end,
          spectrumMusicTitleDraft: nextSpectrumMusicTitleDraft,
        };
      }),
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
        opencreate: {
          target: ss.mainx.State.config,
          actions: assign(({ context }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              collections: context.collections,
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
        [playPlaylist.evt]: {
          target: ss.mainx.State.play,
          actions: assign(({ context, event }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              collections: context.collections,
              savePath: context.savePath,
              playingPlaylistName: event.output,
              nowPlayingTrackName: null,
              shouldStartPlayback: true,
            }),
          ),
        },
        [openPlaylist.evt]: {
          target: ss.mainx.State.configLoading,
          actions: assign(({ context, event }) => {
            const visiblePlaylists = resolvePlaylistsWithPreview(
              context.playlists,
              context.pendingPlaylistPreview,
            );
            const cachedDraft = createDraftFromPlaylistName(visiblePlaylists, event.output);

            return resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              pendingPlaylistPreview: context.pendingPlaylistPreview,
              collections: context.collections,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
              activeLayoutId: playlistTitleLayoutId(event.output),
              pendingPlaylistName: event.output,
              draftBaseline: cachedDraft ? cloneDraft(cachedDraft) : null,
              draft: cachedDraft,
            });
          }),
        },
      },
    },
    [ss.mainx.State.play]: {
      invoke: {
        id: invoker.playPlaylist.id,
        src: invoker.playPlaylist.src,
        input: ({ context }) => {
          if (!context.playingPlaylistName) {
            throw new Error("missing playlist name for playback");
          }

          return {
            playlistName: context.playingPlaylistName,
            shouldStartPlayback: context.shouldStartPlayback,
          };
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign(({ context, event }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              collections: context.collections,
              savePath: context.savePath,
              playingPlaylistName: context.playingPlaylistName,
              nowPlayingTrackName: context.nowPlayingTrackName,
              nowPlayingTrackUrl: context.nowPlayingTrackUrl,
              nowPlayingTrackFilePath: context.nowPlayingTrackFilePath,
              nowPlayingTrackStart: context.nowPlayingTrackStart,
              nowPlayingTrackEnd: context.nowPlayingTrackEnd,
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
              collections: context.collections,
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
              collections: context.collections,
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
        [playPlaylist.evt]: {
          target: ss.mainx.State.play,
          reenter: true,
          actions: assign(({ context, event }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              collections: context.collections,
              savePath: context.savePath,
              playingPlaylistName: event.output,
              nowPlayingTrackName: null,
              shouldStartPlayback: true,
            }),
          ),
        },
        [openPlaylist.evt]: {
          target: ss.mainx.State.configLoading,
          actions: assign(({ context, event }) => {
            const visiblePlaylists = resolvePlaylistsWithPreview(
              context.playlists,
              context.pendingPlaylistPreview,
            );
            const cachedDraft = createDraftFromPlaylistName(visiblePlaylists, event.output);

            return resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              collections: context.collections,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
              activeLayoutId: playlistTitleLayoutId(event.output),
              pendingPlaylistName: event.output,
              draftBaseline: cachedDraft ? cloneDraft(cachedDraft) : null,
              draft: cachedDraft,
            });
          }),
        },
        openspectrum: {
          target: ss.mainx.State.spectrum,
          actions: assign(({ context }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              pendingPlaylistPreview: context.pendingPlaylistPreview,
              collections: context.collections,
              savePath: context.savePath,
              playingPlaylistName: context.playingPlaylistName,
              nowPlayingTrackName: context.nowPlayingTrackName,
              nowPlayingTrackUrl: context.nowPlayingTrackUrl,
              nowPlayingTrackFilePath: context.nowPlayingTrackFilePath,
              nowPlayingTrackStart: context.nowPlayingTrackStart,
              nowPlayingTrackEnd: context.nowPlayingTrackEnd,
              spectrumMusicTitleDraft: createSpectrumMusicTitleDraft({
                nowPlayingTrackName: context.nowPlayingTrackName,
                nowPlayingTrackUrl: context.nowPlayingTrackUrl,
                nowPlayingTrackStart: context.nowPlayingTrackStart,
                nowPlayingTrackEnd: context.nowPlayingTrackEnd,
              }),
              shouldStartPlayback: false,
              activeLayoutId: context.playingPlaylistName
                ? playlistTitleLayoutId(context.playingPlaylistName)
                : null,
            }),
          ),
        },
      },
    },
    [ss.mainx.State.spectrum]: {
      on: {
        run: ss.mainx.State.loading,
        [spectrumMusicTitleChanged.evt]: {
          actions: assign(({ context, event }) => ({
            spectrumMusicTitleDraft: changeSpectrumMusicTitleDraftName(
              context.spectrumMusicTitleDraft,
              event.output,
            ),
          })),
        },
        [spectrumMusicRangeChanged.evt]: {
          actions: assign(({ context, event }) => ({
            spectrumMusicTitleDraft: changeSpectrumMusicTitleDraftRange(
              context.spectrumMusicTitleDraft,
              event.output,
            ),
          })),
        },
        [spectrumMusicDraftReset.evt]: {
          actions: assign(({ context }) => ({
            spectrumMusicTitleDraft: resetSpectrumMusicTitleDraft(context.spectrumMusicTitleDraft),
          })),
        },
        back: [
          {
            guard: ({ context }) => hasSpectrumMusicUpdate(context),
            target: ss.mainx.State.spectrumUpdatingMusic,
          },
          {
            target: ss.mainx.State.play,
            actions: assign(({ context }) => createSpectrumPlayReturnContext(context, null)),
          },
        ],
      },
    },
    [ss.mainx.State.spectrumUpdatingMusic]: {
      invoke: {
        id: invoker.updateMusic.id,
        src: invoker.updateMusic.src,
        input: ({ context }) => resolveSpectrumMusicUpdateInput(context),
        onDone: {
          target: ss.mainx.State.play,
          actions: assign(({ context, event }) =>
            createSpectrumPlayReturnContext(context, createMusicEditFromUpdate(event.output)),
          ),
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign(({ context, event }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              collections: context.collections,
              savePath: context.savePath,
              playingPlaylistName: context.playingPlaylistName,
              nowPlayingTrackName: context.nowPlayingTrackName,
              nowPlayingTrackUrl: context.nowPlayingTrackUrl,
              nowPlayingTrackFilePath: context.nowPlayingTrackFilePath,
              nowPlayingTrackStart: context.nowPlayingTrackStart,
              nowPlayingTrackEnd: context.nowPlayingTrackEnd,
              error: toErrorMessage(event.error),
            }),
          ),
        },
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
              collections: context.collections,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
              activeLayoutId: context.activeLayoutId,
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
              collections: context.collections,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
              activeLayoutId: context.activeLayoutId,
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
              collections: context.collections,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
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
              collections: context.collections,
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
        [openPlaylist.evt]: {
          target: ss.mainx.State.configLoading,
          actions: assign(({ context, event }) => {
            const visiblePlaylists = resolvePlaylistsWithPreview(
              context.playlists,
              context.pendingPlaylistPreview,
            );
            const cachedDraft = createDraftFromPlaylistName(visiblePlaylists, event.output);

            return resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              collections: context.collections,
              savePath: context.savePath,
              playingPlaylistName: null,
              nowPlayingTrackName: null,
              activeLayoutId: playlistTitleLayoutId(event.output),
              pendingPlaylistName: event.output,
              draftBaseline: cachedDraft ? cloneDraft(cachedDraft) : null,
              draft: cachedDraft,
            });
          }),
        },
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
