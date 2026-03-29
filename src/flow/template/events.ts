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
import { resultx } from "../state";
import { sub_mc } from "./submachine/example";

export const ss = defineSS(
  ns("resultx", resultx),
  ns("mainx", sst(["idle", "loading", "view"], ["run", "unmount", "back"])),
);
export const state = allState(ss);
export const sig = allSignal(ss);
export const transfer = allTransfer(ss);
export const invoker = createActors({});
export const payloads = collect(...event<string>()("examplea"));
export const machines = machine(sub_mc)("exampleb");

export type MainStateT = keyof typeof ss.mainx.State;
export type ResultStateT = keyof typeof resultx.State;
export type Events = SignalEvt<typeof ss> | InvokeEvt<typeof invoker>;
