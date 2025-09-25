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
  async check_folder({ input }: ActorInput<{ entry: Entry }>) {
    const a = await crab.recheckFolder(input.entry);
    return a.unwrap();
  },
});

type Events = UniqueEvts<
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>
>;

export type CheckDone = { r: Result<Entry, string> };

type Context = {
  entry?: Entry;
  result?: Result<Entry, string>;
};
const h = eventHandler<Context, Events>();
const src = setup({
  actors: invoker.as_act(),
  types: {
    input: {} as { entry: Entry },
    context: {} as Context,
    events: {} as Events,
    output: {} as CheckDone,
  },
  actions: {
    ok: assign({
      result: h.whenDone(invoker.check_folder.evt)(Ok),
    }),
  },
  guards: {},
});

export const check_folder_machine = src.createMachine({
  initial: ss.mainx.State.probe_info,
  context: ({ input }) => ({
    entry: input.entry,
  }),
  on: {
    cancle: godown(ss.mainx.State.done),
  },
  states: {
    [ss.mainx.State.probe_info]: {
      invoke: {
        id: invoker.check_folder.name,
        src: invoker.check_folder.name,
        input: ({ context: { entry } }) => ({ entry }),
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
