import {} from "@/src/cmd/commands";
import { crab } from "@/src/cmd";
import {
  collect,
  defineSS,
  ns,
  sst,
  event,
  machine,
  createActors,
  ActorInput,
  InvokeEvt,
  UniqueEvts,
  PayloadEvt,
  SignalEvt,
  MachineEvt,
  allSignal,
  allState,
  allTransfer,
} from "../kit";
import { resultx } from "../state";
import { Err, Ok, Result } from "@grahlnn/fn";
import { createMachine } from "xstate";
import { check } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";
import { relaunch } from "@tauri-apps/plugin-process";

export const ss = defineSS(
  ns("resultx", resultx),
  ns("mainx", sst(["idle", "check"], ["run", "unmount"])),
);
export const state = allState(ss);
export const sig = allSignal(ss);
export const transfer = allTransfer(ss);
export const invoker = createActors({
  async checkUpdate() {
    console.log("check update");
    const update = await check();
    if (update) {
      console.log(
        `found update ${update.version} from ${update.date} with notes ${update.body}`,
      );
      let downloaded = 0;
      let contentLength = 0;

      await update.download((e) => {
        switch (e.event) {
          case "Started":
            contentLength = e.data.contentLength!;
            break;
          case "Progress":
            downloaded += e.data.chunkLength;
            break;
          case "Finished":
            console.log("download finished");
            break;
        }
      });

      console.log("update installed");
      toast.success("Already up to date", {
        description: `Version ${update.version} has been ready`,
        duration: Infinity,
        action: {
          label: "Restart",
          onClick: async () => {
            await update.install();
            await relaunch();
          },
        },
      });
      return;
    }
    console.log("no update found");
    throw new Error(`no update found`);
  },
});
export const payloads = collect();
export const machines = collect();

export type MainStateT = keyof typeof ss.mainx.State;
export type ResultStateT = keyof typeof resultx.State;
export type Events = UniqueEvts<
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>
  | MachineEvt<typeof machines.infer>
>;
