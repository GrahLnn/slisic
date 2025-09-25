import {
  collect,
  defineSS,
  ns,
  sst,
  event,
  machine,
  ActorInput,
  createActors,
  events,
  InvokeEvt,
  MachineEvt,
  PayloadEvt,
  SignalEvt,
  UniqueEvts,
} from "../kit";
import { resultx } from "../state";
import { createMachine } from "xstate";

const sub_mc = createMachine({});

export const ss = defineSS(
  ns("resultx", resultx),
  ns("mainx", sst(["idle", "loading", "view"], ["run", "unmount", "back"]))
);
export const invoker = createActors({});
export const payloads = collect(event<string>()("examplea"));
export const machines = collect(machine<string>(sub_mc)("exampleb"));

export type MainStateT = keyof typeof ss.mainx.State;
export type ResultStateT = keyof typeof resultx.State;
export type Events = UniqueEvts<
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>
  | MachineEvt<typeof machines.infer>
>;
