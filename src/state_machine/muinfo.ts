import { createActor, setup, assign } from "xstate";
import {
  collect,
  defineSS,
  ns,
  sst,
  event,
  UniqueEvts,
  SignalEvt,
  InvokeEvt,
  PayloadEvt,
  createActors,
  eventHandler,
  ActorInput,
  to_string,
} from "./kit";
import { I } from "@/lib/comb";
import crab from "../cmd";
import { Err, Ok, Result } from "@/lib/result";
import { actor } from "../state_machine/home";

export const ss = defineSS(ns("mainx", sst(["idle", "probe_info", "done"])));
export const payloads = collect(event<string>()("probe"));
const invoker = createActors({
  async look_media({ input }: ActorInput<{ url: string }>) {
    const a = await crab.lookMedia(input.url);
    return a.unwrap();
  },
});

type Events = UniqueEvts<
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>
>;

export type ActorDone = { url: string; r: Result<string, string> };

type Context = {
  url?: string;
  result?: Result<string, string>;
};
const h = eventHandler<Context, Events>();
const src = setup({
  actors: invoker.send_all(),
  types: {
    input: {} as { url: string },
    context: {} as Context,
    events: {} as Events,
    output: {} as ActorDone,
  },
  actions: {
    add_url: assign({
      url: h.whenDone(payloads.probe.evt())(I),
    }),
    ok: assign({
      result: h.whenDone(invoker.look_media.evt())(Ok),
    }),
  },
  guards: {},
});

export const machine = src.createMachine({
  initial: ss.mainx.State.probe_info,
  context: ({ input }) => ({
    url: input.url,
  }),
  states: {
    [ss.mainx.State.probe_info]: {
      invoke: {
        id: invoker.look_media.name,
        src: invoker.look_media.name,
        input: ({ context: { url } }) => ({ url }),
        onDone: {
          target: ss.mainx.State.done,
          actions: "ok",
        },
        onError: {
          target: ss.mainx.State.done,
          actions: assign({
            result: ({ event }) => Err(to_string(event.error)),
          }),
        },
      },
    },
    [ss.mainx.State.done]: {
      type: "final",
    },
  },
  output: ({ context }) => ({ url: context.url!, r: context.result! }),
});
