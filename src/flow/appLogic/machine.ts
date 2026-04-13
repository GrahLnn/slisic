import { assign } from "xstate";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  collectionTitleLayoutId,
  collectionTitleToneFromDraft,
  createCollectionTitleHandoff,
  createDraft,
  createDraftFromCollection,
  initialContext,
} from "./core";
import { invoker, payloads, ss } from "./events";
import { src } from "./src";

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const openCollection = payloads["collection.open"];
const draftNameChanged = payloads["draft.name.changed"];

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: initialContext,
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
            activeLayoutId: () => null,
            titleToneHandoff: () => null,
            draft: () => null,
            error: () => null,
          }),
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign({
            hasPlayList: () => null,
            collections: () => [],
            activeLayoutId: () => null,
            titleToneHandoff: () => null,
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
            activeLayoutId: () => CREATE_COLLECTION_LAYOUT_ID,
            titleToneHandoff: () =>
              createCollectionTitleHandoff(CREATE_COLLECTION_LAYOUT_ID, "solid"),
            draft: () => createDraft(),
          }),
        },
        [openCollection.evt]: {
          target: ss.mainx.State.config,
          actions: assign({
            activeLayoutId: ({ event }) =>
              collectionTitleLayoutId(event.output.url),
            titleToneHandoff: ({ event }) =>
              createCollectionTitleHandoff(
                collectionTitleLayoutId(event.output.url),
                "solid",
              ),
            draft: ({ event }) => createDraftFromCollection(event.output),
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
            activeLayoutId: () => null,
            titleToneHandoff: ({ context }) =>
              context.activeLayoutId
                ? createCollectionTitleHandoff(
                    context.activeLayoutId,
                    collectionTitleToneFromDraft(context.draft),
                  )
                : null,
            draft: () => null,
          }),
        },
        opencreate: {
          actions: assign({
            activeLayoutId: () => CREATE_COLLECTION_LAYOUT_ID,
            titleToneHandoff: ({ context }) =>
              createCollectionTitleHandoff(
                CREATE_COLLECTION_LAYOUT_ID,
                collectionTitleToneFromDraft(context.draft),
              ),
            draft: () => createDraft(),
          }),
        },
        [openCollection.evt]: {
          actions: assign({
            activeLayoutId: ({ event }) =>
              collectionTitleLayoutId(event.output.url),
            titleToneHandoff: ({ context, event }) =>
              createCollectionTitleHandoff(
                collectionTitleLayoutId(event.output.url),
                collectionTitleToneFromDraft(context.draft),
              ),
            draft: ({ event }) => createDraftFromCollection(event.output),
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
