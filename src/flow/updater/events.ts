import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { sileo } from "sileo";

export const ONE_HOUR = 60 * 60 * 1000;

export type UpdateCheckResult =
  | { kind: "available"; version: string }
  | { kind: "up_to_date" };

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const update = await check();
  if (!update) {
    return { kind: "up_to_date" };
  }

  await update.download();

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
