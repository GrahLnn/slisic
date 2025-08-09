import { setup, assign, enqueueActions } from "xstate";
import {
  type DoneEvents,
  eventHandler,
  createActors,
  EventsFrom,
} from "../kit";
import { Context } from "./core";
import { Signals, payloads } from "./state";
import { invoker } from "./utils";
import { I, K } from "@/lib/comb";
import { udf, vec } from "@/lib/e";

export type Events = DoneEvents<typeof invoker> | Signals;

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
