import { and, raise } from "xstate";
import { goto, godown, invokeState } from "../kit";
import { src } from "./src";
import { invoker } from "./utils";
import { ss } from "./state";
import { resultx } from "../state";

export const machine = src.createMachine({
  id: "bankcard",
  initial: ss.mainx.State.idle,
  context: {},
  on: {},
  states: {},
});
