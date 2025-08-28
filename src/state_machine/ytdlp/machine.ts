import { and, raise } from "xstate";
import { goto, godown, invokeState } from "../kit";
import { src } from "./src";
import { invoker, ss } from "./events";
import { resultx } from "../state";

export const machine = src.createMachine({
  initial: ss.mainx.State.check_exist,
  context: {},
  on: {
    [ss.mainx.Signal.unmount.into()]: {
      target: godown(ss.mainx.State.idle),
      actions: "clean_ctx",
      reenter: true,
    },
  },
  states: {
    [ss.mainx.State.check_exist]: {
      invoke: {
        id: invoker.check_exists.name,
        src: invoker.check_exists.name,
        onDone: {
          target: ss.mainx.State.idle,
          actions: "check_exists",
        },
      },
    },
    [ss.mainx.State.idle]: {
      entry: raise(ss.mainx.Signal.run),
      on: {
        run: [
          {
            target: ss.mainx.State.exist,
            guard: "hasData",
          },
          {
            target: ss.mainx.State.not_exist,
            guard: "noData",
          },
        ],
      },
    },

    [ss.mainx.State.exist]: {
      on: ss.mainx.transfer.pick("to_check_update"),
    },
    [ss.mainx.State.not_exist]: {
      on: ss.mainx.transfer.pick("to_downloading"),
    },
    [ss.mainx.State.check_update]: {
      on: ss.mainx.transfer.pick("to_downloading"),
    },
    [ss.mainx.State.downloading]: {
      invoke: {
        id: invoker.download.name,
        src: invoker.download.name,
        onDone: ss.mainx.State.check_exist,
      },
    },
  },
});
