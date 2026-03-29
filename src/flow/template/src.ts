import { setup, assign, enqueueActions } from "xstate";
import { Context } from "./core";
import { payloads, ss, machines, invoker, Events } from "./events";
import { I, K, udf, vec } from "@grahlnn/fn";
import { hideCenterTool, viewCenterTool } from "../centertool";
import { crab } from "@/src/cmd";
import { convertFileSrc } from "@tauri-apps/api/core";

export const src = setup({
  actors: { ...invoker.asActors(), ...machines.asActors() },
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actions: {},
  guards: {},
});
