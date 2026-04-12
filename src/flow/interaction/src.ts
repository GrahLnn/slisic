import { setup } from "xstate";
import { Context } from "./core";
import { machines, invoker, Events } from "./events";

export const src = setup({
  actors: { ...invoker.asActors(), ...machines.asActors() },
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actions: {},
  guards: {},
});
