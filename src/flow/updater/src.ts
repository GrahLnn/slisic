import { setup } from "xstate";
import { eventHandler } from "../kit";
import type { Context } from "./core";
import { invoker, type Events } from "./events";

export const EH = eventHandler<Context, Events>();
export const src = setup({
  actors: invoker.as_act(),
  types: {
    context: {} as Context,
    events: {} as Events,
  },
});
