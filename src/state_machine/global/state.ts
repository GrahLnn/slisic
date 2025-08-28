import {} from "@/src/cmd/commands";
import { collect, defineSS, ns, sst, event } from "../kit";
import { resultx } from "../state";

export const ss = defineSS(
  ns("resultx", resultx),
  ns(
    "mainx",
    sst(["pre", "init", "idle", "update_save_path"], ["run", "reload"])
  )
);
export const payloads = collect(event<string>()("new_save_path"));

export type MainStateT = keyof typeof ss.mainx.State;
export type ResultStateT = keyof typeof resultx.State;
