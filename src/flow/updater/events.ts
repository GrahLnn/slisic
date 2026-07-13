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
} from "@grahlnn/fn/flow";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { sileo } from "sileo";
import { relaunch } from "@tauri-apps/plugin-process";

const CHECK_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export const ss = defineSS(
  ns("mainx", sst(["idle", "check", "waiting", "ready"], ["run", "unmount"])),
);
export const state = allState(ss);
export const sig = allSignal(ss);
export const transfer = allTransfer(ss);

export type UpdateCheckResult = { kind: "available"; version: string } | { kind: "up_to_date" };

export type UpdateReadyBehavior = {
  version: string;
  runInstallation: () => Promise<void>;
  completedTitle?: string;
};

type UpdateReadyNotifier = Pick<typeof sileo, "success" | "promise">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function installAndRelaunch(update: Update): Promise<void> {
  await update.install();
  await relaunch();
}

export function showUpdateReady(
  behavior: UpdateReadyBehavior,
  notifier: UpdateReadyNotifier = sileo,
) {
  let installationStarted = false;

  notifier.success({
    title: "Update ready",
    description: `Version ${behavior.version} has been downloaded`,
    duration: null,
    button: {
      title: "Restart",
      onClick: () => {
        if (installationStarted) {
          return;
        }

        installationStarted = true;
        void notifier
          .promise(() => behavior.runInstallation(), {
            loading: {
              title: "Installing update",
              description: `Preparing Slisic ${behavior.version}`,
            },
            success: {
              title: behavior.completedTitle ?? "Restarting Slisic",
            },
            error: (error) => ({
              title: "Update installation failed",
              description: errorMessage(error),
              duration: null,
            }),
          })
          .catch(() => {
            installationStarted = false;
          });
      },
    },
  });
}

export function showSimulatedUpdateReady() {
  showUpdateReady({
    version: "dev-simulation",
    completedTitle: "Restart simulated",
    runInstallation: () => new Promise((resolve) => setTimeout(resolve, 800)),
  });
}

export const invoker = createActors({
  async checkUpdate(): Promise<UpdateCheckResult> {
    console.log("check update");
    try {
      const update = await check({ timeout: CHECK_TIMEOUT_MS });
      if (!update) {
        console.log("no update found");
        return { kind: "up_to_date" };
      }

      console.log(`found update ${update.version} from ${update.date} with notes ${update.body}`);
      try {
        await update.download(
          (event) => {
            if (event.event === "Finished") {
              console.log("download finished");
            }
          },
          { timeout: DOWNLOAD_TIMEOUT_MS },
        );
      } catch (error) {
        await update.close().catch((closeError) => {
          console.error("failed to release interrupted update", closeError);
        });
        throw error;
      }

      console.log("update downloaded");
      showUpdateReady({
        version: update.version,
        runInstallation: () => installAndRelaunch(update),
      });
      return { kind: "available", version: update.version };
    } catch (error) {
      console.error("update check failed", error);
      sileo.error({
        title: "Update check failed",
        description: `${errorMessage(error)}. Slisic will retry in one hour.`,
      });
      throw error;
    }
  },
});
export const payloads = collect();
export const machines = collect();

export type MainStateT = Extract<keyof typeof ss.mainx.State, string>;
export type Events = UniqueEvts<SignalEvt<typeof ss> | InvokeEvt<typeof invoker>>;
