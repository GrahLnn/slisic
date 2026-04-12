import {
  collect,
  defineSS,
  event,
  ns,
  sst,
  allState,
  type PayloadEvt,
} from "@grahlnn/fn/flow";
import type { AppBootstrap } from "../bootstrap";

export const ss = defineSS(ns("mainx", sst(["running"])));
export const state = allState(ss);
export const payloads = collect(...event<AppBootstrap>()("bootstrap.changed"));

export type MainStateT = Extract<keyof typeof ss.mainx.State, string>;
export type Events = PayloadEvt<typeof payloads.infer>;
