import { assign } from "xstate";
import { sileo } from "sileo";
import {
  playlistPreviewChanged,
  playlistUpserted,
  send as sendAppLogic,
} from "../appLogic/runtime";
import {
  activateNextCommit,
  clearActiveCommit,
  createInitialContext,
  enqueueCommit,
  hasPendingCommit,
  toErrorMessage,
  type PlaylistCommitRequest,
} from "./core";
import { invoker, payloads, ss } from "./events";
import { src } from "./src";

const commitRequested = payloads["playlist.commit.requested"];

function resolveQueuedPreview(context: { queue: PlaylistCommitRequest[] }) {
  const nextRequest = context.queue[0];

  return nextRequest?.preview ?? null;
}

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: createInitialContext(),
  on: {
    [commitRequested.evt]: {
      actions: assign(({ context, event }) => enqueueCommit(context, event.output)),
    },
    reset: {
      target: `.${ss.mainx.State.idle}`,
      actions: [
        () => {
          sendAppLogic(playlistPreviewChanged.load(null));
        },
        assign(() => createInitialContext()),
      ],
    },
  },
  states: {
    [ss.mainx.State.idle]: {
      always: [
        {
          guard: ({ context }) => hasPendingCommit(context),
          target: ss.mainx.State.submitting,
          actions: [
            ({ context }) => {
              sendAppLogic(playlistPreviewChanged.load(resolveQueuedPreview(context)));
            },
            assign(({ context }) => activateNextCommit(context)),
          ],
        },
      ],
    },
    [ss.mainx.State.submitting]: {
      invoke: {
        id: invoker.submitPlaylist.id,
        src: invoker.submitPlaylist.src,
        input: ({ context }) => {
          if (!context.activeRequest) {
            throw new Error("missing playlist commit request");
          }

          return context.activeRequest;
        },
        onDone: {
          target: ss.mainx.State.idle,
          actions: [
            ({ context, event }) => {
              sendAppLogic(playlistUpserted.load(event.output));
              sendAppLogic(playlistPreviewChanged.load(resolveQueuedPreview(context)));
            },
            assign(({ context }) => clearActiveCommit(context)),
          ],
        },
        onError: {
          target: ss.mainx.State.idle,
          actions: [
            ({ context, event }) => {
              const title = context.activeRequest?.request.playlist.name || "PlayList";
              const description = toErrorMessage(event.error);

              console.error("Failed to commit playlist draft", {
                title,
                description,
              });
              sileo.error({
                title: "Failed to save playlist",
                description: `${title}: ${description}`,
              });
              sendAppLogic(playlistPreviewChanged.load(resolveQueuedPreview(context)));
            },
            assign(({ context, event }) => clearActiveCommit(context, toErrorMessage(event.error))),
          ],
        },
      },
    },
  },
});
