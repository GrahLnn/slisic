import { draftCollectionUpserted, send as sendAppLogic } from "../appLogic/runtime";
import {
  createCandidateItemId,
  createInvalidPastedDownloadUrlResolution,
  downloadTaskIsTerminal,
  hasCandidateItem,
  parseClipboardDownloadUrl,
  toErrorMessage,
  type Context,
} from "./core";
import { deps, payloads } from "./events";
import {
  createFastUrlResolveQueue,
  resolveDefaultFastUrlResolveConcurrency,
  type FastUrlResolveQueue,
} from "./fastUrlResolveQueue";
import {
  createTitleProbeQueue,
  resolveDefaultTitleProbeConcurrency,
  type TitleProbeQueue,
} from "./titleProbeQueue";

const candidateResolveCompleted = payloads["candidate.resolve.completed"];
const candidateResolveFailed = payloads["candidate.resolve.failed"];
const candidateEnqueueCompleted = payloads["candidate.enqueue.completed"];
const candidateEnqueueFailed = payloads["candidate.enqueue.failed"];
const candidateTitleCompleted = payloads["candidate.title.completed"];
const candidateTitleFailed = payloads["candidate.title.failed"];
const candidateTaskCollectionLoaded = payloads["candidate.task.collection.loaded"];
const candidateTaskCollectionFailed = payloads["candidate.task.collection.failed"];

type PasteDownloadActor = {
  send(event: unknown): void;
};

const fastUrlResolveQueues = new WeakMap<object, FastUrlResolveQueue>();
const titleProbeQueues = new WeakMap<object, TitleProbeQueue>();

function fastUrlResolveQueueFor(actor: object) {
  let queue = fastUrlResolveQueues.get(actor);
  if (queue) {
    return queue;
  }

  queue = createFastUrlResolveQueue({
    concurrency: resolveDefaultFastUrlResolveConcurrency,
    resolve: (url) => deps.resolvePastedDownloadUrl(url),
    toErrorMessage,
  });
  fastUrlResolveQueues.set(actor, queue);
  return queue;
}

function titleProbeQueueFor(actor: object) {
  let queue = titleProbeQueues.get(actor);
  if (queue) {
    return queue;
  }

  queue = createTitleProbeQueue({
    concurrency: resolveDefaultTitleProbeConcurrency,
    probe: (url) => deps.probeDownloadRootTitle(url),
    toErrorMessage,
  });
  titleProbeQueues.set(actor, queue);
  return queue;
}

export function requestPastedDownloadUrlResolution(args: {
  actor: PasteDownloadActor & object;
  context: Context;
  rawText: string;
}) {
  const id = createCandidateItemId(args.context.nextItemSequence - 1);
  const parsed = parseClipboardDownloadUrl(args.rawText);
  if (!parsed.ok) {
    args.actor.send(
      candidateResolveCompleted.load({
        id,
        resolution: createInvalidPastedDownloadUrlResolution(parsed.error),
      }),
    );
    return;
  }

  fastUrlResolveQueueFor(args.actor).enqueue({
    id,
    url: parsed.url,
    sink: {
      completed: ({ id, resolution }) => {
        args.actor.send(candidateResolveCompleted.load({ id, resolution }));
      },
      failed: ({ id, error }) => {
        args.actor.send(candidateResolveFailed.load({ id, error }));
      },
    },
  }, { priority: "front" });
}

export function cancelCandidateEffects(args: { actor: object; id: string }) {
  fastUrlResolveQueueFor(args.actor).cancel(args.id);
  titleProbeQueueFor(args.actor).cancel(args.id);
}

export function publishResolvedCollection(args: {
  context: Context;
  id: string;
  collection: Parameters<typeof draftCollectionUpserted.load>[0] | null;
}) {
  if (hasCandidateItem(args.context, args.id) && args.collection) {
    sendAppLogic(draftCollectionUpserted.load(args.collection));
  }
}

export function requestNewDownloadCandidateEffects(args: {
  actor: PasteDownloadActor & object;
  context: Context;
  id: string;
  isNewUrl: boolean;
}) {
  if (!args.isNewUrl) {
    return;
  }

  const item = args.context.items.find((candidate) => candidate.id === args.id);
  if (!item?.sourceUrl) {
    return;
  }

  titleProbeQueueFor(args.actor).enqueue({
    id: args.id,
    url: item.sourceUrl,
    sink: {
      completed: ({ id, evidence }) => {
        args.actor.send(candidateTitleCompleted.load({ id, evidence }));
      },
      failed: ({ id, error }) => {
        args.actor.send(candidateTitleFailed.load({ id, error }));
      },
    },
  });

  void deps
    .enqueueCollectionDownload(item.sourceUrl)
    .then((result) => {
      args.actor.send(candidateEnqueueCompleted.load({ id: args.id, result }));
    })
    .catch((error) => {
      args.actor.send(
        candidateEnqueueFailed.load({
          id: args.id,
          error: toErrorMessage(error),
        }),
      );
    });
}

export function publishRootTitleCollection(args: {
  context: Context;
  id: string;
  collection: Parameters<typeof draftCollectionUpserted.load>[0];
}) {
  if (hasCandidateItem(args.context, args.id)) {
    sendAppLogic(draftCollectionUpserted.load(args.collection));
  }
}

export function publishEnqueuedCollection(args: {
  context: Context;
  id: string;
  result: Awaited<ReturnType<typeof deps.enqueueCollectionDownload>>;
}) {
  if (hasCandidateItem(args.context, args.id) && args.result.collection) {
    sendAppLogic(draftCollectionUpserted.load(args.result.collection));
  }
}

export function enqueuedCollectionClosesCandidate(
  result: Awaited<ReturnType<typeof deps.enqueueCollectionDownload>>,
) {
  return result.collection !== null && downloadTaskIsTerminal(result.task.status);
}

export function requestFinishedTaskCollection(args: {
  actor: PasteDownloadActor;
  context: Context;
  signal: Parameters<(typeof payloads)["download.task.changed"]["load"]>[0];
}) {
  if (
    !args.signal.collection_url ||
    (args.signal.status !== "completed" && args.signal.status !== "completed_with_errors") ||
    !args.context.items.some((item) => item.taskId === args.signal.task_id)
  ) {
    return;
  }

  void deps
    .getCollection(args.signal.collection_url)
    .then((collection) => {
      if (collection) {
        args.actor.send(
          candidateTaskCollectionLoaded.load({
            taskId: args.signal.task_id,
            collection,
          }),
        );
        return;
      }

      args.actor.send(
        candidateTaskCollectionFailed.load({
          taskId: args.signal.task_id,
          error: "Download finished but the collection could not be loaded.",
        }),
      );
    })
    .catch((error) => {
      args.actor.send(
        candidateTaskCollectionFailed.load({
          taskId: args.signal.task_id,
          error: toErrorMessage(error),
        }),
      );
    });
}

export function publishTaskCollection(args: {
  context: Context;
  taskId: string;
  collection: Parameters<typeof draftCollectionUpserted.load>[0];
}) {
  if (args.context.items.some((item) => item.taskId === args.taskId)) {
    sendAppLogic(draftCollectionUpserted.load(args.collection));
  }
}

export function resetCandidateEffects(actor: object) {
  fastUrlResolveQueueFor(actor).reset();
  titleProbeQueueFor(actor).reset();
}
