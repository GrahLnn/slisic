import {
  collect,
  createActors,
  defineSS,
  event,
  ns,
  sst,
  allSignal,
  allState,
  type InvokeEvt,
  type PayloadEvt,
  type SignalEvt,
} from "@grahlnn/fn/flow";
import {
  crab,
  type Collection,
  type DownloadRootTitleEvidence,
  type DownloadTask,
  type DownloadTaskChangeSignal,
  type EnqueuedCollectionDownload,
  type PastedDownloadUrlResolution,
} from "@/src/cmd";

export const ss = defineSS(ns("mainx", sst(["idle"], ["reset"])));
export const state = allState(ss);
export const sig = allSignal(ss);

export type CandidateResolutionPayload = {
  id: string;
  resolution: PastedDownloadUrlResolution;
};

export type CandidateFailurePayload = {
  id: string;
  error: string;
};

export type CandidateEnqueuedPayload = {
  id: string;
  result: EnqueuedCollectionDownload;
};

export type CandidateTitlePayload = {
  id: string;
  evidence: DownloadRootTitleEvidence;
};

export type CandidateTaskCollectionPayload = {
  taskId: string;
  collection: Collection;
};

export type CandidateTaskFailurePayload = {
  taskId: string;
  error: string;
};

export async function listenDownloadTaskChanged(
  handler: (payload: DownloadTaskChangeSignal) => void,
): Promise<() => void> {
  return crab.evt("downloadTaskChangeSignal")(handler);
}

export const deps = {
  resolvePastedDownloadUrl: async (url: string): Promise<PastedDownloadUrlResolution> => {
    const result = await crab.resolvePastedDownloadUrl(url);

    return result.match({
      Ok: (resolution) => resolution,
      Err: (error) => {
        throw new Error(error);
      },
    });
  },
  enqueueCollectionDownload: async (url: string): Promise<EnqueuedCollectionDownload> => {
    const result = await crab.enqueueCollectionDownload(url);

    return result.match({
      Ok: (task) => task,
      Err: (error) => {
        throw new Error(error);
      },
    });
  },
  submitYoutubeCookiesAndResumeDownloadTask: async (
    taskId: string,
    cookies: string,
  ): Promise<DownloadTask> => {
    const result = await crab.submitYoutubeCookiesAndResumeDownloadTask(taskId, cookies);

    return result.match({
      Ok: (task) => task,
      Err: (error) => {
        throw new Error(error);
      },
    });
  },
  probeDownloadRootTitle: async (url: string): Promise<DownloadRootTitleEvidence> => {
    const result = await crab.probeDownloadRootTitle(url);

    return result.match({
      Ok: (evidence) => evidence,
      Err: (error) => {
        throw new Error(error);
      },
    });
  },
  getCollection: async (url: string): Promise<Collection | null> => {
    const result = await crab.getCollection(url);

    return result.match({
      Ok: (collection) => collection,
      Err: (error) => {
        throw new Error(error);
      },
    });
  },
};

export const invoker = createActors({
  resolvePastedDownloadUrl: async (url: string): Promise<PastedDownloadUrlResolution> =>
    deps.resolvePastedDownloadUrl(url),
  enqueueCollectionDownload: async (url: string): Promise<EnqueuedCollectionDownload> =>
    deps.enqueueCollectionDownload(url),
  probeDownloadRootTitle: async (url: string): Promise<DownloadRootTitleEvidence> =>
    deps.probeDownloadRootTitle(url),
});

export const payloads = collect(
  ...event<string>()("paste.requested"),
  ...event<string>()("candidate.delete"),
  ...event<CandidateResolutionPayload>()("candidate.resolve.completed"),
  ...event<CandidateFailurePayload>()("candidate.resolve.failed", "candidate.enqueue.failed"),
  ...event<CandidateEnqueuedPayload>()("candidate.enqueue.completed"),
  ...event<CandidateTitlePayload>()("candidate.title.completed"),
  ...event<CandidateFailurePayload>()("candidate.title.failed"),
  ...event<DownloadTaskChangeSignal>()("download.task.changed"),
  ...event<CandidateTaskCollectionPayload>()("candidate.task.collection.loaded"),
  ...event<CandidateTaskFailurePayload>()("candidate.task.collection.failed"),
);

export type MainStateT = Extract<keyof typeof ss.mainx.State, string>;
export type Events =
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>;
