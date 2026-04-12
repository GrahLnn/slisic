import {
  collect,
  defineSS,
  ns,
  sst,
  event,
  machine,
  createActors,
  InvokeEvt,
  SignalEvt,
  allSignal,
  allState,
  allTransfer,
} from "@grahlnn/fn/flow";
import { crab } from "@/src/cmd";
import { resultx } from "../state";
import { sub_mc } from "./submachine/example";

export const ss = defineSS(
  ns("resultx", resultx),
  ns(
    "mainx",
    sst(["idle", "loading", "init", "view"], ["run", "unmount", "back"]),
  ),
);
export const state = allState(ss);
export const sig = allSignal(ss);
export const transfer = allTransfer(ss);
export const invoker = createActors({
  checkList: async () => {
    const result = await crab.checkList();

    return result.match({
      Ok: (hasList) => hasList,
      Err: (error) => {
        throw new Error(error);
      },
    });
  },
});
export const payloads = collect(...event<string>()("examplea"));
export const machines = machine(sub_mc)("exampleb");

export type MainStateT = Extract<keyof typeof ss.mainx.State, string>;
export type ResultStateT = Extract<keyof typeof resultx.State, string>;
export type InteractionStateT = MainStateT | ResultStateT;
export type Events = SignalEvt<typeof ss> | InvokeEvt<typeof invoker>;
