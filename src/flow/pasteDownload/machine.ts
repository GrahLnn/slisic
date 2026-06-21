import { assign } from "xstate";
import {
  appendCandidateItem,
  acceptCandidateDownloadTask,
  acceptCandidateRootTitleEvidence,
  applyDownloadTaskChangeSignal,
  applyCandidateUrlResolution,
  createInitialContext,
  deleteCandidateItem,
  deleteCandidateItemByTaskId,
  failCandidateTask,
  failCandidateItem,
  resetCandidateItems,
} from "./core";
import {
  cancelCandidateEffects,
  enqueuedCollectionClosesCandidate,
  publishEnqueuedCollection,
  publishResolvedCollection,
  publishRootTitleCollection,
  publishTaskCollection,
  requestFinishedTaskCollection,
  requestNewDownloadCandidateEffects,
  requestPastedDownloadUrlResolution,
  resetCandidateEffects,
} from "./effects";
import { payloads, ss } from "./events";
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
          requestPastedDownloadUrlResolution({
            actor: self,
            context,
            rawText: event.output,
          });
        },
      ],
    },
    [candidateDelete.evt]: {
      actions: [
        ({ event, self }) => cancelCandidateEffects({ actor: self, id: event.output }),
        assign(({ context, event }) => deleteCandidateItem(context, event.output)),
      ],
    },
    [candidateResolveCompleted.evt]: {
      actions: [
        ({ context, event }) =>
          publishResolvedCollection({
            context,
            id: event.output.id,
            collection: event.output.resolution.collection,
          }),
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
          requestNewDownloadCandidateEffects({
            actor: self,
            context,
            id: event.output.id,
            isNewUrl: event.output.resolution.status === "new_url",
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
        ({ context, event }) =>
          publishRootTitleCollection({
            context,
            id: event.output.id,
            collection: event.output.evidence.collection,
          }),
        assign(({ context, event }) =>
          acceptCandidateRootTitleEvidence(context, event.output.id, event.output.evidence),
        ),
      ],
    },
    [candidateTitleFailed.evt]: {},
    [candidateEnqueueCompleted.evt]: {
      actions: [
        ({ context, event }) =>
          publishEnqueuedCollection({
            context,
            id: event.output.id,
            result: event.output.result,
          }),
        assign(({ context, event }) =>
          enqueuedCollectionClosesCandidate(event.output.result)
            ? deleteCandidateItem(context, event.output.id)
            : acceptCandidateDownloadTask(context, event.output.id, event.output.result.task),
        ),
      ],
    },
    [downloadTaskChanged.evt]: {
      actions: [
        ({ context, event, self }) =>
          requestFinishedTaskCollection({
            actor: self,
            context,
            signal: event.output,
          }),
        assign(({ context, event }) => applyDownloadTaskChangeSignal(context, event.output)),
      ],
    },
    [candidateTaskCollectionLoaded.evt]: {
      actions: [
        ({ context, event }) =>
          publishTaskCollection({
            context,
            taskId: event.output.taskId,
            collection: event.output.collection,
          }),
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
      actions: [
        ({ self }) => resetCandidateEffects(self),
        assign(({ context }) => resetCandidateItems(context)),
      ],
    },
  },
  states: {
    [ss.mainx.State.idle]: {},
  },
});
