import { setup, assign, enqueueActions } from "xstate";
import { type DoneEvents, eventHandler, createActors } from "../core";
import { Context } from "./core";
import { Signals } from "./state";
import { utils } from "./utils";
import { I, K } from "@/lib/comb";
import { udf, vec } from "@/lib/e";

export type Events = DoneEvents<typeof invoker> | Signals;

export const EH = eventHandler<Events>();
export const invoker = createActors(utils);
export const src = setup({
  actors: invoker.send_all(),
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actions: {},
  guards: {},
});
