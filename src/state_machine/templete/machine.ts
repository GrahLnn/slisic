import { and, raise } from "xstate";
import { goto, godown, invokeState } from "../kit";
import { src } from "./src";
import { ss } from "./events";
import { resultx } from "../state";

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: {},
  on: {},
  states: {},
});
