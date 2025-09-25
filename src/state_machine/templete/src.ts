import { setup, assign, enqueueActions } from "xstate";
import { eventHandler } from "../kit";
import { Context } from "./core";
import { payloads, ss, machines, invoker, Events } from "./events";
import { I, K } from "@/lib/comb";
import { udf, vec } from "@/lib/e";
import { hideCenterTool, viewCenterTool } from "../centertool";
import { station } from "@/src/subpub/buses";
import crab from "@/src/cmd";
import { convertFileSrc } from "@tauri-apps/api/core";

export const EH = eventHandler<Context, Events>();
export const src = setup({
  actors: invoker.as_act(),
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actions: {},
  guards: {},
});
