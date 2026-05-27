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
import { crab, type EnqueuedCollectionDownload, type PastedDownloadUrlResolution } from "@/src/cmd";

export const ss = defineSS(ns("mainx", sst(["idle", "checking", "enqueueing"], ["reset"])));
export const state = allState(ss);
export const sig = allSignal(ss);

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
};

export const invoker = createActors({
  resolvePastedDownloadUrl: async (url: string): Promise<PastedDownloadUrlResolution> =>
    deps.resolvePastedDownloadUrl(url),
  enqueueCollectionDownload: async (url: string): Promise<EnqueuedCollectionDownload> =>
    deps.enqueueCollectionDownload(url),
});

export const payloads = collect(
  ...event<string>()("paste.requested"),
  ...event<string>()("candidate.delete"),
);

export type MainStateT = Extract<keyof typeof ss.mainx.State, string>;
export type Events =
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>;
