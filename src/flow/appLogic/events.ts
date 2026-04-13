import {
  collect,
  defineSS,
  event,
  ns,
  sst,
  allState,
  allSignal,
  createActors,
  type InvokeEvt,
  type PayloadEvt,
  type SignalEvt,
} from "@grahlnn/fn/flow";
import { crab, type Collection } from "@/src/cmd";

export interface BootstrapResult {
  hasPlayList: boolean;
  collections: Collection[];
}

export const ss = defineSS(
  ns("mainx", sst(["idle", "loading", "ready", "config", "error"], ["run", "opencreate", "back"])),
);
export const state = allState(ss);
export const sig = allSignal(ss);
export const invoker = createActors({
  loadCollections: async (): Promise<BootstrapResult> => {
    const result = await crab.checkList();
    const hasPlayList = result.match({
      Ok: (value) => value,
      Err: (error) => {
        throw new Error(error);
      },
    });

    if (!hasPlayList) {
      return {
        hasPlayList: false,
        collections: [],
      };
    }

    const collections = await crab.listCollections();

    return collections.match({
      Ok: (value) => ({
        hasPlayList: true,
        collections: value,
      }),
      Err: (error) => {
        throw new Error(error);
      },
    });
  },
});
export const payloads = collect(
  ...event<Collection>()("collection.open"),
  ...event<string>()("draft.name.changed"),
);

export type MainStateT = Extract<keyof typeof ss.mainx.State, string>;
export type Events =
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>;
