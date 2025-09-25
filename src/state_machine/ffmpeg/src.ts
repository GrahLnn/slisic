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
import { udf } from "@/lib/e";

type Events = UniqueEvts<
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>
  | MachineEvt<typeof machines.infer>
>;

export const eh = eventHandler<Context, Events>();
export const src = setup({
  actors: invoker.as_act(),
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actions: {
    check_exists: assign({
      path: eh.whenDone(invoker.check_exists.evt)((r) => r?.installed_path),
      version: eh.whenDone(invoker.check_exists.evt)(
        (r) => r?.installed_version
      ),
    }),
    new_version: assign({
      version: eh.whenDone(payloads.new_version.evt)(I),
    }),
    clean_ctx: assign({
      path: udf,
      version: udf,
    }),
  },
  guards: {
    hasData: ({ context }) => !!context.path && !!context.version,
    noData: ({ context }) => !context.path && !context.version,
  },
});
