import { CollectMission, Playlist } from "@/src/cmd/commands";
import {
  collect,
  defineSS,
  ns,
  sst,
  event,
  machine,
  ActorInput,
  createActors,
} from "../kit";
import { resultx } from "../state";
import { Result } from "@/lib/result";
import { ActorDone, machine as muinfoMachine } from "../muinfo";
import { Frame } from "./core";
import crab from "@/src/cmd";

export const ss = defineSS(
  ns("resultx", resultx),
  ns(
    "mainx",
    sst(
      ["idle", "loading", "play", "fast_edit", "new_guide", "create", "save"],
      ["run", "unmount", "back"]
    )
  ),
  ns("playx", sst(["stop", "playing", "next"], ["next", "play"]))
);

export const payloads = collect(
  event<CollectMission>()("set_slot"),
  event<string>()("add_review_actor"),
  event<Playlist[]>()("update_single"),
  event<Playlist | null>()("toggle_audio"),
  event<Frame>()("update_audio_frame")
);

export const sub_machine = collect(machine<ActorDone>(muinfoMachine)("review"));

export const invoker = createActors({
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
});

export type MainStateT = keyof typeof ss.mainx.State;
export type ResultStateT = keyof typeof resultx.State;
