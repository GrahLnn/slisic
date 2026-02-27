import { setup, assign, enqueueActions } from "xstate";
import { eventHandler } from "../kit";
import { Context } from "./core";
import { payloads, ss, invoker, machines, Events } from "./events";
import { I, K } from "@grahlnn/fn";

export const EH = eventHandler<Context, Events>();
export const src = setup({
  actors: invoker.as_act(),
});
