import {
  createActors,
  defineSS,
  ns,
  sst,
  allSignal,
  allState,
  type InvokeEvt,
  type SignalEvt,
} from "@grahlnn/fn/flow";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { crab, type DownloadResourceProbe, type DownloadTask } from "@/src/cmd";

export const ss = defineSS(
  ns(
    "mainx",
    sst(
      ["idle", "readingClipboard", "validating", "probing", "enqueueing", "done", "error"],
      ["paste", "reset"],
    ),
  ),
);
export const state = allState(ss);
export const sig = allSignal(ss);

export const deps = {
  readClipboardText: () => readText(),
  probeDownloadResource: async (url: string): Promise<DownloadResourceProbe> => {
    const result = await crab.probeDownloadResource(url);

    return result.match({
      Ok: (probe) => probe,
      Err: (error) => {
        throw new Error(error);
      },
    });
  },
  enqueueCollectionDownload: async (url: string): Promise<DownloadTask> => {
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
  readClipboardText: async (): Promise<string> => deps.readClipboardText(),
  probeDownloadResource: async (url: string): Promise<DownloadResourceProbe> =>
    deps.probeDownloadResource(url),
  enqueueCollectionDownload: async (url: string): Promise<DownloadTask> =>
    deps.enqueueCollectionDownload(url),
});

export type MainStateT = Extract<keyof typeof ss.mainx.State, string>;
export type Events = SignalEvt<typeof ss> | InvokeEvt<typeof invoker>;
