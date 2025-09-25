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
  godown,
} from "./kit";
import { I } from "@/lib/comb";
import crab from "../cmd";
import { Err, Ok, Result } from "@/lib/result";
import { Entry, MediaInfo } from "../cmd/commands";

export const ss = defineSS(
  ns("mainx", sst(["idle", "probe_info", "done"], ["cancle"]))
);
export const payloads = collect(event<string>()("probe"));
const invoker = createActors({
  async update_weblist({
    input,
  }: ActorInput<{ entry: Entry; playlist: string }>) {
    const a = await crab.updateWeblist(input.entry, input.playlist);
    return a.unwrap();
  },
});

type Events = UniqueEvts<
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>
>;

export type UpdateDone = { r: Result<Entry, string> };

type Context = {
  entry?: Entry;
  playlist?: string;
  result?: Result<Entry, string>;
};
const h = eventHandler<Context, Events>();
const src = setup({
  actors: invoker.as_act(),
  types: {
    input: {} as { entry: Entry; playlist: string },
    context: {} as Context,
    events: {} as Events,
    output: {} as UpdateDone,
  },
  actions: {
    ok: assign({
      result: h.whenDone(invoker.update_weblist.evt)(Ok),
    }),
  },
  guards: {},
});

export const update_weblist_machine = src.createMachine({
  initial: ss.mainx.State.probe_info,
  context: ({ input }) => ({
    entry: input.entry,
    playlist: input.playlist,
  }),
  on: {
    cancle: godown(ss.mainx.State.done),
  },
  states: {
    [ss.mainx.State.probe_info]: {
      invoke: {
        id: invoker.update_weblist.name,
        src: invoker.update_weblist.name,
        input: ({ context: { entry, playlist } }) => ({
          entry,
          playlist,
        }),
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
  output: ({ context }) => ({ r: context.result! }),
});
