import crab from "@/src/cmd";
import { ActorInput, createActors } from "../kit";
import { CollectMission } from "@/src/cmd/commands";

export const utils = {
  async load_collections() {
    const a = await crab.readAll();
    return a.unwrap_or([]);
  },
  async save_collections({ input }: ActorInput<{ slot: CollectMission }>) {
    const a = await crab.create(input.slot);
    a.unwrap();
  },
  async download_ytdlp() {
    const a = await crab.ytdlpDownloadAndInstall();
    return a.unwrap_or();
  },
};

export const invoker = createActors(utils);
