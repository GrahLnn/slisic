import {
  collect,
  defineSS,
  ns,
  sst,
  createActors,
  InvokeEvt,
  UniqueEvts,
  SignalEvt,
  allSignal,
  allState,
  allTransfer,
} from "../kit";
import { resultx } from "../state";
import { check } from "@tauri-apps/plugin-updater";
import { sileo } from "sileo";
import { relaunch } from "@tauri-apps/plugin-process";

export const ss = defineSS(
  ns("resultx", resultx),
  ns("mainx", sst(["idle", "check"], ["run", "unmount"])),
);
export const state = allState(ss);
export const sig = allSignal(ss);
export const transfer = allTransfer(ss);

export type UpdateCheckResult =
  | { kind: "available"; version: string }
  | { kind: "up_to_date" };

export const invoker = createActors({
  async checkUpdate(): Promise<UpdateCheckResult> {
    console.log("check update");
    const update = await check();
    if (update) {
      console.log(
        `found update ${update.version} from ${update.date} with notes ${update.body}`,
      );

      await update.download((e) => {
        switch (e.event) {
          case "Started":
          case "Progress":
            break;
          case "Finished":
            console.log("download finished");
            break;
        }
      });

      console.log("update downloaded");
      sileo.success({
        title: "Update ready",
        description: `Version ${update.version} has been downloaded`,
        duration: null,
        button: {
          title: "Restart",
          onClick: async () => {
            await update.install();
            await relaunch();
          },
        },
      });
      return { kind: "available", version: update.version };
    }

    console.log("no update found");
    return { kind: "up_to_date" };
  },
});
export const payloads = collect();
export const machines = collect();

export type MainStateT = keyof typeof ss.mainx.State;
export type ResultStateT = keyof typeof resultx.State;
export type Events = UniqueEvts<
  SignalEvt<typeof ss> | InvokeEvt<typeof invoker>
>;
