import { setup, assign, enqueueActions } from "xstate";
import {
  InvokeEvt,
  eventHandler,
  createActors,
  UniqueEvts,
  PayloadEvt,
  SignalEvt,
  MachineEvt,
} from "../kit";
import { Context } from "./core";
import { payloads, ss, invoker, machines } from "./events";
import { I, K } from "@/lib/comb";

type Events = UniqueEvts<
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>
  | MachineEvt<typeof machines.infer>
>;

export const EH = eventHandler<Context, Events>();
export const src = setup({
  actors: invoker.as_act(),
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actions: {},
  guards: {},
});
