import { godown } from "@grahlnn/fn/flow";
import { src } from "./src";
import { invoker, ss } from "./events";

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: {},
  on: {
    run: godown(ss.mainx.State.loading),
  },
  states: {
    [ss.mainx.State.idle]: {},
    [ss.mainx.State.loading]: {
      invoke: {
        id: invoker.checkList.id,
        src: invoker.checkList.src,
        onDone: [
          {
            guard: ({ event }) => event.output,
            target: ss.mainx.State.view,
          },
          {
            target: ss.mainx.State.init,
          },
        ],
        onError: ss.resultx.State.err,
      },
    },
    [ss.mainx.State.init]: {},
    [ss.mainx.State.view]: {},
    [ss.resultx.State.err]: {},
  },
});
