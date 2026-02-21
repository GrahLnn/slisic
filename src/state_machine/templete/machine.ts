import { and, fromCallback, raise } from "xstate";
import { goto, godown, invokeState } from "../kit";
import { src } from "./src";
import { payloads, ss, machines, invoker } from "./events";
import { resultx } from "../state";
import { B, call0, tap } from "@grahlnn/fn";
import { crab } from "@/src/cmd";

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: {},
  on: {},
  states: {},
});
