import { setup, assign, enqueueActions } from "xstate";
import {
  InvokeEvt,
  eventHandler,
  createActors,
  UniqueEvts,
  PayloadEvt,
  SignalEvt,
} from "../kit";
import { Context } from "./core";
import { payloads, ss } from "./state";
import { invoker } from "./utils";
import { I, K } from "@/lib/comb";

type Events = UniqueEvts<
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>
  | SignalEvt<typeof ss>
>;

export const EH = eventHandler<Events>();
export const src = setup({
  actors: invoker.send_all(),
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actions: {},
  guards: {},
});
