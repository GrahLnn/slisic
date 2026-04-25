import { assign } from "xstate";
import {
  draftCollectionUpserted,
  draftItemRemoved,
  send as sendAppLogic,
} from "../appLogic/runtime";
import {
  activateNextCandidateCheck,
  activateNextCandidate,
  appendCandidateItem,
  applyActiveCandidateUrlResolution,
  clearActiveCandidate,
  completeActiveCandidateProbe,
  createDraftCollectionFromProbe,
  createInitialContext,
  deleteCandidateItem,
  failActiveCandidateEnqueue,
  failActiveCandidateProbe,
  findActiveCandidateItem,
  hasPendingCandidateToCheck,
  hasPendingCandidateToProbe,
  removeActiveCandidate,
  toErrorMessage,
} from "./core";
import { invoker, payloads, ss } from "./events";
import { src } from "./src";

const pasteRequested = payloads["paste.requested"];
const candidateDelete = payloads["candidate.delete"];

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: createInitialContext(),
  on: {
    [pasteRequested.evt]: {
      actions: assign(({ context, event }) => appendCandidateItem(context, event.output)),
    },
    [candidateDelete.evt]: {
      actions: assign(({ context, event }) => deleteCandidateItem(context, event.output)),
    },
    reset: {
      target: `.${ss.mainx.State.idle}`,
      actions: assign(() => createInitialContext()),
    },
  },
  states: {
    [ss.mainx.State.idle]: {
      always: [
        {
          guard: ({ context }) => hasPendingCandidateToCheck(context),
          target: ss.mainx.State.checking,
          actions: assign(({ context }) => activateNextCandidateCheck(context)),
        },
        {
          guard: ({ context }) => hasPendingCandidateToProbe(context),
          target: ss.mainx.State.probing,
          actions: assign(({ context }) => activateNextCandidate(context)),
        },
      ],
    },
    [ss.mainx.State.checking]: {
      invoke: {
        id: invoker.resolvePastedDownloadUrl.id,
        src: invoker.resolvePastedDownloadUrl.src,
        input: ({ context }) => {
          const item = findActiveCandidateItem(context);

          if (!item) {
            throw new Error("missing candidate text for paste url check");
          }

          return item.rawText;
        },
        onDone: [
          {
            guard: ({ event }) => event.output.status === "new_url",
            target: ss.mainx.State.probing,
            actions: assign(({ context, event }) =>
              applyActiveCandidateUrlResolution(context, event.output),
            ),
          },
          {
            guard: ({ event }) => event.output.status === "existing_collection",
            target: ss.mainx.State.idle,
            actions: [
              assign(({ context }) => removeActiveCandidate(context)),
              ({ event }) => {
                if (event.output.collection) {
                  sendAppLogic(draftCollectionUpserted.load(event.output.collection));
                }
              },
            ],
          },
          {
            target: ss.mainx.State.idle,
            actions: assign(({ context, event }) =>
              clearActiveCandidate(
                applyActiveCandidateUrlResolution(context, event.output),
              ),
            ),
          },
        ],
        onError: {
          target: ss.mainx.State.idle,
          actions: assign(({ context, event }) =>
            clearActiveCandidate(
              failActiveCandidateProbe(context, toErrorMessage(event.error)),
            ),
          ),
        },
      },
    },
    [ss.mainx.State.probing]: {
      invoke: {
        id: invoker.probeDownloadResource.id,
        src: invoker.probeDownloadResource.src,
        input: ({ context }) => {
          const item = findActiveCandidateItem(context);

          if (!item?.sourceUrl) {
            throw new Error("missing candidate URL for probe");
          }

          return item.sourceUrl;
        },
        onDone: {
          target: ss.mainx.State.enqueueing,
          actions: [
            assign(({ context, event }) =>
              completeActiveCandidateProbe(context, event.output),
            ),
            ({ event }) => {
              sendAppLogic(
                draftCollectionUpserted.load(
                  createDraftCollectionFromProbe(event.output),
                ),
              );
            },
          ],
        },
        onError: {
          target: ss.mainx.State.idle,
          actions: assign(({ context, event }) =>
            clearActiveCandidate(
              failActiveCandidateProbe(context, toErrorMessage(event.error)),
            ),
          ),
        },
      },
    },
    [ss.mainx.State.enqueueing]: {
      invoke: {
        id: invoker.enqueueCollectionDownload.id,
        src: invoker.enqueueCollectionDownload.src,
        input: ({ context }) => {
          const item = findActiveCandidateItem(context);

          if (!item?.sourceUrl) {
            throw new Error("missing candidate URL for enqueue");
          }

          return item.sourceUrl;
        },
        onDone: {
          target: ss.mainx.State.idle,
          actions: [
            assign(({ context }) => removeActiveCandidate(context)),
            ({ event }) => {
              sendAppLogic(draftCollectionUpserted.load(event.output.collection));
            },
          ],
        },
        onError: {
          target: ss.mainx.State.idle,
          actions: [
            assign(({ context, event }) =>
              clearActiveCandidate(
                failActiveCandidateEnqueue(context, toErrorMessage(event.error)),
              ),
            ),
            ({ context }) => {
              const item = findActiveCandidateItem(context);
              if (!item?.sourceUrl) {
                return;
              }

              sendAppLogic(
                draftItemRemoved.load({
                  kind: "collection",
                  url: item.sourceUrl,
                }),
              );
            },
          ],
        },
      },
    },
  },
});
