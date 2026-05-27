import { assign } from "xstate";
import { draftCollectionUpserted, send as sendAppLogic } from "../appLogic/runtime";
import {
  appendCandidateItem,
  applyCandidateUrlResolution,
  createCandidateItemId,
  createInvalidPastedDownloadUrlResolution,
  createInitialContext,
  deleteCandidateItem,
  failCandidateItem,
  hasCandidateItem,
  parseClipboardDownloadUrl,
  resetCandidateItems,
  toErrorMessage,
} from "./core";
import { deps, payloads, ss } from "./events";
import { src } from "./src";

const pasteRequested = payloads["paste.requested"];
const candidateDelete = payloads["candidate.delete"];
const candidateResolveCompleted = payloads["candidate.resolve.completed"];
const candidateResolveFailed = payloads["candidate.resolve.failed"];
const candidateEnqueueCompleted = payloads["candidate.enqueue.completed"];
const candidateEnqueueFailed = payloads["candidate.enqueue.failed"];

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: createInitialContext(),
  on: {
    [pasteRequested.evt]: {
      actions: [
        assign(({ context, event }) => appendCandidateItem(context, event.output)),
        ({ context, event, self }) => {
          const id = createCandidateItemId(context.nextItemSequence - 1);
          const parsed = parseClipboardDownloadUrl(event.output);
          if (!parsed.ok) {
            self.send(
              candidateResolveCompleted.load({
                id,
                resolution: createInvalidPastedDownloadUrlResolution(parsed.error),
              }),
            );
            return;
          }

          void deps
            .resolvePastedDownloadUrl(parsed.url)
            .then((resolution) => {
              self.send(candidateResolveCompleted.load({ id, resolution }));
            })
            .catch((error) => {
              self.send(
                candidateResolveFailed.load({
                  id,
                  error: toErrorMessage(error),
                }),
              );
            });
        },
      ],
    },
    [candidateDelete.evt]: {
      actions: assign(({ context, event }) => deleteCandidateItem(context, event.output)),
    },
    [candidateResolveCompleted.evt]: {
      actions: [
        ({ context, event }) => {
          if (hasCandidateItem(context, event.output.id) && event.output.resolution.collection) {
            sendAppLogic(draftCollectionUpserted.load(event.output.resolution.collection));
          }
        },
        assign(({ context, event }) => {
          const next = applyCandidateUrlResolution(
            context,
            event.output.id,
            event.output.resolution,
          );
          return event.output.resolution.status === "existing_collection"
            ? deleteCandidateItem(next, event.output.id)
            : next;
        }),
        ({ context, event, self }) => {
          if (event.output.resolution.status !== "new_url") {
            return;
          }

          const item = context.items.find((candidate) => candidate.id === event.output.id);
          if (!item?.sourceUrl) {
            return;
          }

          void deps
            .enqueueCollectionDownload(item.sourceUrl)
            .then((result) => {
              self.send(candidateEnqueueCompleted.load({ id: event.output.id, result }));
            })
            .catch((error) => {
              self.send(
                candidateEnqueueFailed.load({
                  id: event.output.id,
                  error: toErrorMessage(error),
                }),
              );
            });
        },
      ],
    },
    [candidateResolveFailed.evt]: {
      actions: assign(({ context, event }) =>
        failCandidateItem(context, event.output.id, event.output.error),
      ),
    },
    [candidateEnqueueCompleted.evt]: {
      actions: [
        ({ context, event }) => {
          if (hasCandidateItem(context, event.output.id)) {
            sendAppLogic(draftCollectionUpserted.load(event.output.result.collection));
          }
        },
        assign(({ context, event }) => deleteCandidateItem(context, event.output.id)),
      ],
    },
    [candidateEnqueueFailed.evt]: {
      actions: assign(({ context, event }) =>
        failCandidateItem(context, event.output.id, event.output.error),
      ),
    },
    reset: {
      target: `.${ss.mainx.State.idle}`,
      actions: assign(({ context }) => resetCandidateItems(context)),
    },
  },
  states: {
    [ss.mainx.State.idle]: {},
  },
});
