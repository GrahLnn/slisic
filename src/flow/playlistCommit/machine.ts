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
  reflectPlaylistCommitEvidence,
  toErrorMessage,
  type PlaylistCommitFrame,
} from "./core";
import { rejectPlaylistCommitCompletion, resolvePlaylistCommitCompletion } from "./completion";
import { invoker, payloads, ss } from "./events";
import { src } from "./src";

const commitRequested = payloads["playlist.commit.requested"];

function resolveQueuedPreview(context: { queue: PlaylistCommitFrame[] }) {
  const nextFrame = context.queue[0];

  return nextFrame?.request.preview ?? null;
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
        ({ context }) => {
          rejectPlaylistCommitCompletion(
            context.activeFrame?.completionId ?? null,
            new Error("playlist commit reset"),
          );
          for (const frame of context.queue) {
            rejectPlaylistCommitCompletion(frame.completionId, new Error("playlist commit reset"));
          }
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
          if (!context.activeFrame) {
            throw new Error("missing playlist commit request");
          }

          return context.activeFrame.request;
        },
        onDone: {
          target: ss.mainx.State.idle,
          actions: [
            ({ context, event }) => {
              const reflection = reflectPlaylistCommitEvidence(context.activeFrame, event.output);
              if (reflection.kind !== "accepted") {
                console.error("Rejected playlist commit evidence", reflection);
                rejectPlaylistCommitCompletion(
                  context.activeFrame?.completionId ?? null,
                  new Error("playlist commit returned unexpected evidence"),
                );
                sendAppLogic(playlistPreviewChanged.load(resolveQueuedPreview(context)));
                return;
              }

              sendAppLogic(playlistUpserted.load(reflection.evidence));
              resolvePlaylistCommitCompletion(reflection.frame.completionId, reflection.evidence);
              sendAppLogic(playlistPreviewChanged.load(resolveQueuedPreview(context)));
            },
            assign(({ context }) => clearActiveCommit(context)),
          ],
        },
        onError: {
          target: ss.mainx.State.idle,
          actions: [
            ({ context, event }) => {
              const title = context.activeFrame?.request.request.playlist.name || "PlayList";
              const description = toErrorMessage(event.error);

              console.error("Failed to commit playlist draft", {
                title,
                description,
              });
              sileo.error({
                title: "Failed to save playlist",
                description: `${title}: ${description}`,
              });
              rejectPlaylistCommitCompletion(
                context.activeFrame?.completionId ?? null,
                new Error(description),
              );
              sendAppLogic(playlistPreviewChanged.load(resolveQueuedPreview(context)));
            },
            assign(({ context, event }) => clearActiveCommit(context, toErrorMessage(event.error))),
          ],
        },
      },
    },
  },
});
