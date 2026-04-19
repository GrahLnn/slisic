import { assign } from "xstate";
import { sileo } from "sileo";
import { recordTitleShareTrace } from "@/src/debug/titleShareTrace";
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

function resolveQueuedPreview(context: {
  queue: PlaylistCommitRequest[];
}) {
  const nextRequest = context.queue[0];

  return nextRequest
    ? {
        playlist: nextRequest.playlist,
        previousName: nextRequest.previousName,
      }
    : null;
}

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: createInitialContext(),
  on: {
    [commitRequested.evt]: {
      actions: [
        ({ context, event }) => {
          recordTitleShareTrace("playlist-commit:requested", {
            queuedBefore: context.queue.map((request) => ({
              name: request.playlist.name,
              previousName: request.previousName,
            })),
            request: {
              name: event.output.playlist.name,
              previousName: event.output.previousName,
            },
          });
        },
        assign(({ context, event }) => enqueueCommit(context, event.output)),
      ],
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
              recordTitleShareTrace("playlist-commit:submitting", {
                queue: context.queue.map((request) => ({
                  name: request.playlist.name,
                  previousName: request.previousName,
                })),
                preview: resolveQueuedPreview(context),
              });
              sendAppLogic(
                playlistPreviewChanged.load(resolveQueuedPreview(context)),
              );
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
              recordTitleShareTrace("playlist-commit:succeeded", {
                activeRequest: context.activeRequest
                  ? {
                      name: context.activeRequest.playlist.name,
                      previousName: context.activeRequest.previousName,
                    }
                  : null,
                queue: context.queue.map((request) => ({
                  name: request.playlist.name,
                  previousName: request.previousName,
                })),
                persisted: {
                  name: event.output.playlist.name,
                  previousName: event.output.previousName,
                },
              });
              sendAppLogic(playlistUpserted.load(event.output));
              sendAppLogic(
                playlistPreviewChanged.load(resolveQueuedPreview(context)),
              );
            },
            assign(({ context }) => clearActiveCommit(context)),
          ],
        },
        onError: {
          target: ss.mainx.State.idle,
          actions: [
            ({ context, event }) => {
              const title = context.activeRequest?.playlist.name || "PlayList";
              const description = toErrorMessage(event.error);

              recordTitleShareTrace("playlist-commit:failed", {
                activeRequest: context.activeRequest
                  ? {
                      name: context.activeRequest.playlist.name,
                      previousName: context.activeRequest.previousName,
                    }
                  : null,
                queue: context.queue.map((request) => ({
                  name: request.playlist.name,
                  previousName: request.previousName,
                })),
                description,
              });
              console.error("Failed to commit playlist draft", {
                title,
                description,
              });
              sileo.error({
                title: "Failed to save playlist",
                description: `${title}: ${description}`,
              });
              sendAppLogic(
                playlistPreviewChanged.load(resolveQueuedPreview(context)),
              );
            },
            assign(({ context, event }) =>
              clearActiveCommit(context, toErrorMessage(event.error)),
            ),
          ],
        },
      },
    },
  },
});
