import { assign } from "xstate";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  collectionTitleToneFromDraft,
  createCollectionTitleHandoff,
  createConfigSidebarItems,
  createDraft,
  initialContext,
  insertConfigSidebarItemIntoDraft,
  playlistTitleLayoutId,
  resetContextWith,
  upsertCollectionIntoDraft,
  upsertCollectionIntoCollections,
} from "./core";
import { BootstrapLoadError, invoker, payloads, ss } from "./events";
import { src } from "./src";

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function resolveSavePathFromLoadingError(error: unknown, fallback: string) {
  return error instanceof BootstrapLoadError ? error.savePath : fallback;
}

const openPlaylist = payloads["playlist.open"];
const draftNameChanged = payloads["draft.name.changed"];
const savePathChanged = payloads["save_path.changed"];
const collectionUpserted = payloads["collection.upserted"];
const draftCollectionUpserted = payloads["draft.collection.upserted"];
const draftSidebarItemPushed = payloads["draft.sidebar-item.pushed"];

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
        const collections = upsertCollectionIntoCollections(
          context.collections,
          event.output,
        );

        return {
          collections,
          configSidebarItems: context.activeLayoutId
            ? createConfigSidebarItems(collections)
            : context.configSidebarItems,
        };
      }),
    },
    [draftCollectionUpserted.evt]: {
      actions: assign(({ context, event }) => {
        const collections = upsertCollectionIntoCollections(
          context.collections,
          event.output,
        );

        return {
          collections,
          configSidebarItems: context.activeLayoutId
            ? createConfigSidebarItems(collections)
            : context.configSidebarItems,
          draft: upsertCollectionIntoDraft(context.draft, event.output),
        };
      }),
    },
    [draftSidebarItemPushed.evt]: {
      actions: assign(({ context, event }) => ({
        draft: insertConfigSidebarItemIntoDraft(
          context.draft,
          context.collections,
          event.output,
        ),
      })),
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
              collections: event.output.collections,
              savePath: event.output.savePath,
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
              configSidebarItems: createConfigSidebarItems(context.collections),
              activeLayoutId: CREATE_COLLECTION_LAYOUT_ID,
              titleToneHandoff: createCollectionTitleHandoff(
                CREATE_COLLECTION_LAYOUT_ID,
                "solid",
              ),
              draft: createDraft(),
            }),
          ),
        },
        [openPlaylist.evt]: {
          target: ss.mainx.State.configLoading,
          actions: assign(({ context, event }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              collections: context.collections,
              savePath: context.savePath,
              configSidebarItems: createConfigSidebarItems(context.collections),
              activeLayoutId: playlistTitleLayoutId(event.output),
              pendingPlaylistName: event.output,
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
              configSidebarItems: context.configSidebarItems,
              activeLayoutId: context.activeLayoutId,
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
              configSidebarItems: context.configSidebarItems,
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
          actions: assign(({ context }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              collections: context.collections,
              savePath: context.savePath,
              titleToneHandoff: context.activeLayoutId
                ? createCollectionTitleHandoff(
                    context.activeLayoutId,
                    collectionTitleToneFromDraft(context.draft),
                  )
                : null,
            }),
          ),
        },
        opencreate: {
          actions: assign(({ context }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              collections: context.collections,
              savePath: context.savePath,
              configSidebarItems: createConfigSidebarItems(context.collections),
              activeLayoutId: CREATE_COLLECTION_LAYOUT_ID,
              titleToneHandoff: createCollectionTitleHandoff(
                CREATE_COLLECTION_LAYOUT_ID,
                collectionTitleToneFromDraft(context.draft),
              ),
              draft: createDraft(),
            }),
          ),
        },
        [openPlaylist.evt]: {
          target: ss.mainx.State.configLoading,
          actions: assign(({ context, event }) =>
            resetContextWith({
              hasPlayList: context.hasPlayList,
              playlists: context.playlists,
              collections: context.collections,
              savePath: context.savePath,
              configSidebarItems: createConfigSidebarItems(context.collections),
              activeLayoutId: playlistTitleLayoutId(event.output),
              pendingPlaylistName: event.output,
            }),
          ),
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
      },
    },
    [ss.mainx.State.error]: {
      on: {
        run: ss.mainx.State.loading,
      },
    },
  },
});
