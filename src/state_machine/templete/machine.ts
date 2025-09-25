import { and, fromCallback, raise } from "xstate";
import { goto, godown, invokeState } from "../kit";
import { src } from "./src";
import { payloads, ss, machines, invoker } from "./events";
import { resultx } from "../state";
import { B, call0 } from "@/lib/comb";
import crab from "@/src/cmd";
import { tap } from "@/lib/result";
import { lievt } from "@/src/cmd/commandAdapter";

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: {},
  on: {},
  states: {},
});
