import {} from "@/src/cmd/commands";
import crab from "@/src/cmd";
import {
  collect,
  defineSS,
  ns,
  sst,
  event,
  machine,
  createActors,
  ActorInput,
} from "../kit";
import { resultx } from "../state";
import { Result } from "@/lib/result";
import { createMachine } from "xstate";

const sub_mc = createMachine({});

export const ss = defineSS(
  ns("resultx", resultx),
  ns("mainx", sst(["idle", "loading", "view"], ["run", "unmount", "back"]))
);
export const utils = {};
export const invoker = createActors(utils);
export const payloads = collect(event<string>()("examplea"));
export const machines = collect(machine<string>(sub_mc)("exampleb"));

export type MainStateT = keyof typeof ss.mainx.State;
export type ResultStateT = keyof typeof resultx.State;
