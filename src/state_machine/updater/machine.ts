import { and, raise } from "xstate";
import { goto, godown, invokeState } from "../kit";
import { src } from "./src";
import { invoker, ss } from "./events";
import { resultx } from "../state";

const ONE_HOUR = 60 * 60 * 1000;

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
        id: invoker.checkUpdate.name,
        src: invoker.checkUpdate.name,
        onDone: ss.resultx.State.ok,
        onError: ss.resultx.State.err,
      },
    },
    [ss.resultx.State.ok]: {
      type: "final",
    },
    [ss.resultx.State.err]: {
      after: {
        [ONE_HOUR]: ss.mainx.State.check,
      },
    },
  },
});
