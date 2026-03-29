import { setup } from "xstate";
import type { Context } from "./core";
import { type Events } from "./events";

export const src = setup({
  types: {
    context: {} as Context,
    events: {} as Events,
  },
});
