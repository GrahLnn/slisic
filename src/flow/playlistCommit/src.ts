import { setup } from "xstate";
import type { PlaylistCommitContext } from "./core";
import { invoker, type Events } from "./events";

export const src = setup({
  actors: invoker.asActors(),
  types: {
    context: {} as PlaylistCommitContext,
    events: {} as Events,
  },
});
