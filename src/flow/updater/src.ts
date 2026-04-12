import { setup } from "xstate";
import type { Context } from "./core";
import { invoker, type Events } from "./events";

export const src = setup({
  actors: invoker.asActors(),
  types: {
    context: {} as Context,
    events: {} as Events,
  },
});
