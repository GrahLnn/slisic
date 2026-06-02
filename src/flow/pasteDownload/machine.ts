import { assign } from "xstate";
import { draftCollectionUpserted, send as sendAppLogic } from "../appLogic/runtime";
import {
  appendCandidateItem,
  acceptCandidateDownloadTask,
  acceptCandidateRootTitleEvidence,
  applyDownloadTaskChangeSignal,
  applyCandidateUrlResolution,
  createCandidateItemId,
  createInvalidPastedDownloadUrlResolution,
  createInitialContext,
  deleteCandidateItem,
  deleteCandidateItemByTaskId,
  failCandidateTask,
  failCandidateItem,
  hasCandidateItem,
  downloadTaskIsTerminal,
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
const candidateTitleCompleted = payloads["candidate.title.completed"];
const candidateTitleFailed = payloads["candidate.title.failed"];
const downloadTaskChanged = payloads["download.task.changed"];
const candidateTaskCollectionLoaded = payloads["candidate.task.collection.loaded"];
const candidateTaskCollectionFailed = payloads["candidate.task.collection.failed"];

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
            .probeDownloadRootTitle(item.sourceUrl)
            .then((evidence) => {
              self.send(candidateTitleCompleted.load({ id: event.output.id, evidence }));
            })
            .catch((error) => {
              self.send(
                candidateTitleFailed.load({
                  id: event.output.id,
                  error: toErrorMessage(error),
                }),
              );
            });

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
    [candidateTitleCompleted.evt]: {
      actions: [
        ({ context, event }) => {
          if (!hasCandidateItem(context, event.output.id)) {
            return;
          }

          sendAppLogic(
            draftCollectionUpserted.load(event.output.evidence.collection),
          );
        },
        assign(({ context, event }) =>
          acceptCandidateRootTitleEvidence(context, event.output.id, event.output.evidence),
        ),
      ],
    },
    [candidateTitleFailed.evt]: {},
    [candidateEnqueueCompleted.evt]: {
      actions: [
        ({ context, event }) => {
          if (hasCandidateItem(context, event.output.id) && event.output.result.collection) {
            sendAppLogic(draftCollectionUpserted.load(event.output.result.collection));
          }
        },
        assign(({ context, event }) =>
          event.output.result.collection && downloadTaskIsTerminal(event.output.result.task.status)
            ? deleteCandidateItem(context, event.output.id)
            : acceptCandidateDownloadTask(context, event.output.id, event.output.result.task),
        ),
      ],
    },
    [downloadTaskChanged.evt]: {
      actions: [
        ({ context, event, self }) => {
          if (
            !event.output.collection_url ||
            (event.output.status !== "completed" &&
              event.output.status !== "completed_with_errors") ||
            !context.items.some((item) => item.taskId === event.output.task_id)
          ) {
            return;
          }

          void deps
            .getCollection(event.output.collection_url)
            .then((collection) => {
              if (collection) {
                self.send(
                  candidateTaskCollectionLoaded.load({
                    taskId: event.output.task_id,
                    collection,
                  }),
                );
                return;
              }

              self.send(
                candidateTaskCollectionFailed.load({
                  taskId: event.output.task_id,
                  error: "Download finished but the collection could not be loaded.",
                }),
              );
            })
            .catch((error) => {
              self.send(
                candidateTaskCollectionFailed.load({
                  taskId: event.output.task_id,
                  error: toErrorMessage(error),
                }),
              );
            });
        },
        assign(({ context, event }) => applyDownloadTaskChangeSignal(context, event.output)),
      ],
    },
    [candidateTaskCollectionLoaded.evt]: {
      actions: [
        ({ context, event }) => {
          if (context.items.some((item) => item.taskId === event.output.taskId)) {
            sendAppLogic(draftCollectionUpserted.load(event.output.collection));
          }
        },
        assign(({ context, event }) => deleteCandidateItemByTaskId(context, event.output.taskId)),
      ],
    },
    [candidateTaskCollectionFailed.evt]: {
      actions: assign(({ context, event }) =>
        failCandidateTask(context, event.output.taskId, event.output.error),
      ),
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
