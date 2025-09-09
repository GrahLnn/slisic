import crab from "@/src/cmd";
import { collect, createActors, machine, sst, ValueOf, event } from "../kit";
import { resultx } from "../state";
import { createMachine } from "xstate";

export const ss = {
  resultx,
  mainx: sst(
    [
      "idle",
      "check_exist",
      "exist",
      "not_exist",
      "check_update",
      "downloading",
      "done",
    ],
    ["run", "unmount", "back"]
  ),
};
export const utils = {
  async check_exists() {
    const a = await crab.ffmpegCheckExists();
    return a.unwrap();
  },
  async download() {
    const a = await crab.ffmpegDownloadAndInstall();
    return a.unwrap();
  },
};
const sub_mc = createMachine({});

export const invoker = createActors(utils);
export const payloads = collect(event<string>()("new_version"));
export const machines = collect(machine<string>(sub_mc)("exampleb"));

export type MainStateT = keyof typeof ss.mainx.State;
export type ResultStateT = keyof typeof resultx.State;
