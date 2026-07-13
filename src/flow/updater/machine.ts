import { src } from "./src";
import { invoker, ss } from "./events";

export const ONE_HOUR = 60 * 60 * 1000;

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,

  states: {
    [ss.mainx.State.idle]: {
      on: {
        run: ss.mainx.State.check,
      },
    },
    [ss.mainx.State.check]: {
      invoke: {
        id: invoker.checkUpdate.id,
        src: invoker.checkUpdate.src,
        onDone: [
          {
            guard: ({ event }) => event.output.kind === "available",
            target: ss.mainx.State.ready,
          },
          {
            target: ss.mainx.State.waiting,
          },
        ],
        onError: ss.mainx.State.waiting,
      },
    },
    [ss.mainx.State.waiting]: {
      after: {
        [ONE_HOUR]: ss.mainx.State.check,
      },
      on: {
        run: ss.mainx.State.check,
      },
    },
    [ss.mainx.State.ready]: {
      type: "final",
    },
  },
});
