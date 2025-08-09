import { and, raise } from "xstate";
import { goto, godown, invokeState } from "../kit";
import { invoker, src } from "./src";
import { ss } from "./state";
import { resultx } from "../state";

export const machine = src.createMachine({
  id: "bankcard",
  initial: ss.mainx.State.idle,
  context: {},
  on: {
    [ss.mainx.Signal.unmount.into()]: {
      target: godown(ss.mainx.State.idle),
      actions: "clean_ctx",
      reenter: true,
    },
  },
  states: {},
});
