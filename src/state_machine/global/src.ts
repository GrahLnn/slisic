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
import { udf } from "@/lib/e";

type Events = UniqueEvts<
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>
>;
export const EH = eventHandler<Context, Events>();

export const src = setup({
  actors: invoker.send_all(),
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actions: {
    init: assign({
      default_save_path: EH.whenDone(invoker.resolve_save_path.evt())(I),
    }),
    update_save_path: assign({
      new_path: EH.whenDone(payloads.new_save_path.evt())(I),
    }),
    reset_new_path: assign({
      new_path: udf,
    }),
  },
  guards: {},
});
