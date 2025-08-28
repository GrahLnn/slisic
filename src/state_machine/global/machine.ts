import { and, raise } from "xstate";
import { goto, godown, invokeState } from "../kit";
import { src } from "./src";
import { ss } from "./state";
import { resultx } from "../state";
import crab from "@/src/cmd";
import { invoker } from "./utils";

export const machine = src.createMachine({
  initial: ss.mainx.State.pre,
  context: {},
  on: {},
  states: {
    [ss.mainx.State.pre]: {
      on: {
        run: ss.mainx.State.init,
      },
    },
    [ss.mainx.State.init]: {
      invoke: {
        id: invoker.resolve_save_path.name,
        src: invoker.resolve_save_path.name,
        onDone: {
          target: ss.mainx.State.idle,
          actions: "init",
        },
      },
    },
    [ss.mainx.State.idle]: {
      on: {
        new_save_path: {
          target: ss.mainx.State.update_save_path,
          actions: "update_save_path",
        },
        reload: ss.mainx.State.init,
      },
    },
    [ss.mainx.State.update_save_path]: {
      invoke: {
        id: invoker.update_save_path.name,
        src: invoker.update_save_path.name,
        input: ({ context: { new_path } }) => ({ new_path }),
        onDone: {
          target: ss.mainx.State.init,
          actions: "reset_new_path",
        },
      },
    },
  },
});
