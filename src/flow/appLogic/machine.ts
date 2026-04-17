import { assign } from "xstate";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  collectionTitleToneFromDraft,
  createCollectionTitleHandoff,
  createConfigSidebarItems,
  createDraft,
  initialContext,
  playlistTitleLayoutId,
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

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: initialContext,
  on: {
    [savePathChanged.evt]: {
      actions: assign({
        savePath: ({ event }) => event.output,
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
          actions: assign({
            hasPlayList: ({ event }) => event.output.hasPlayList,
            collections: ({ event }) => event.output.collections,
            savePath: ({ event }) => event.output.savePath,
            configSidebarItems: () => [],
            activeLayoutId: () => null,
            titleToneHandoff: () => null,
            pendingPlaylistName: () => null,
            draft: () => null,
            error: () => null,
          }),
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign({
            hasPlayList: () => null,
            collections: () => [],
            savePath: ({ context, event }) =>
              resolveSavePathFromLoadingError(event.error, context.savePath),
            configSidebarItems: () => [],
            activeLayoutId: () => null,
            titleToneHandoff: () => null,
            pendingPlaylistName: () => null,
            draft: () => null,
            error: ({ event }) => toErrorMessage(event.error),
          }),
        },
      },
    },
    [ss.mainx.State.ready]: {
      on: {
        run: ss.mainx.State.loading,
        opencreate: {
          target: ss.mainx.State.config,
          actions: assign({
            configSidebarItems: ({ context }) => createConfigSidebarItems(context.collections),
            activeLayoutId: () => CREATE_COLLECTION_LAYOUT_ID,
            titleToneHandoff: () =>
              createCollectionTitleHandoff(CREATE_COLLECTION_LAYOUT_ID, "solid"),
            pendingPlaylistName: () => null,
            draft: () => createDraft(),
            error: () => null,
          }),
        },
        [openPlaylist.evt]: {
          target: ss.mainx.State.configLoading,
          actions: assign({
            configSidebarItems: ({ context }) => createConfigSidebarItems(context.collections),
            activeLayoutId: ({ event }) => playlistTitleLayoutId(event.output),
            titleToneHandoff: () => null,
            pendingPlaylistName: ({ event }) => event.output,
            draft: () => null,
            error: () => null,
          }),
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
          actions: assign({
            pendingPlaylistName: () => null,
            draft: ({ event }) => event.output,
            error: () => null,
          }),
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign({
            pendingPlaylistName: () => null,
            draft: () => null,
            error: ({ event }) => toErrorMessage(event.error),
          }),
        },
      },
      on: {
        run: ss.mainx.State.loading,
        back: {
          target: ss.mainx.State.ready,
          actions: assign({
            configSidebarItems: () => [],
            activeLayoutId: () => null,
            titleToneHandoff: () => null,
            pendingPlaylistName: () => null,
            draft: () => null,
            error: () => null,
          }),
        },
      },
    },
    [ss.mainx.State.config]: {
      on: {
        run: ss.mainx.State.loading,
        back: {
          target: ss.mainx.State.ready,
          actions: assign({
            configSidebarItems: () => [],
            activeLayoutId: () => null,
            titleToneHandoff: ({ context }) =>
              context.activeLayoutId
                ? createCollectionTitleHandoff(
                    context.activeLayoutId,
                    collectionTitleToneFromDraft(context.draft),
                  )
                : null,
            pendingPlaylistName: () => null,
            draft: () => null,
            error: () => null,
          }),
        },
        opencreate: {
          actions: assign({
            configSidebarItems: ({ context }) => createConfigSidebarItems(context.collections),
            activeLayoutId: () => CREATE_COLLECTION_LAYOUT_ID,
            titleToneHandoff: ({ context }) =>
              createCollectionTitleHandoff(
                CREATE_COLLECTION_LAYOUT_ID,
                collectionTitleToneFromDraft(context.draft),
              ),
            pendingPlaylistName: () => null,
            draft: () => createDraft(),
            error: () => null,
          }),
        },
        [openPlaylist.evt]: {
          target: ss.mainx.State.configLoading,
          actions: assign({
            configSidebarItems: ({ context }) => createConfigSidebarItems(context.collections),
            activeLayoutId: ({ event }) => playlistTitleLayoutId(event.output),
            titleToneHandoff: () => null,
            pendingPlaylistName: ({ event }) => event.output,
            draft: () => null,
            error: () => null,
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
      },
    },
    [ss.mainx.State.error]: {
      on: {
        run: ss.mainx.State.loading,
      },
    },
  },
});
