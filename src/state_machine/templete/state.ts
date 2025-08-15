import {} from "@/src/cmd/commands";
import { collect, defineSS, ns, sst, event } from "../kit";
import { resultx } from "../state";

export const ss = defineSS(
  ns("resultx", resultx),
  ns("mainx", sst(["idle", "loading", "view"], ["run", "unmount", "back"]))
);
export const payloads = collect(event<string>()("example"));

export type MainStateT = keyof typeof ss.mainx.State;
export type ResultStateT = keyof typeof resultx.State;
