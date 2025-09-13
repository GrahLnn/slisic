import { CollectMission, Entry, Music, Playlist } from "@/src/cmd/commands";
import {
  collect,
  defineSS,
  ns,
  sst,
  event,
  machine,
  ActorInput,
  createActors,
  events,
} from "../kit";
import { resultx } from "../state";
import { ActorDone, machine as muinfoMachine } from "../muinfo";
import { Frame } from "./core";
import crab from "@/src/cmd";
import { fromCallback } from "xstate";
import { AudioAnalyzer } from "@/src/components/audio/analyzer";
import { station } from "@/src/subpub/buses";
import { check_folder_machine, CheckDone } from "../foldercheck";
import { Result } from "@/lib/result";

export const analyzeAudio = fromCallback<any, { analyzer: AudioAnalyzer }>(
  ({ input, receive }) => {
    let stop: null | (() => void) = null;

    const start = () => {
      if (stop) stop();
      stop = input.analyzer.onFrame((f) => station.audioFrame.set(f));
    };

    receive((evt) => {
      if (evt?.type === "analyzerstart") start();
      if (evt?.type === "analyzerstop") {
        stop?.();
        stop = null;
      }
    });

    return () => {
      stop?.();
    };
  }
);

export const ss = defineSS(
  ns("resultx", resultx),
  ns(
    "mainx",
    sst(
      [
        "idle",
        "loading",
        "play",
        "edit",
        "new_guide",
        "create",
        "saving",
        "updating",
      ],
      ["run", "unmount", "back", "AFTER_DELETE", "review_check"]
    )
  ),
  ns(
    "playx",
    sst(
      ["stop", "playing", "next"],
      ["next", "play", "analyzerstart", "analyzerstop"]
    )
  )
);

export const payloads = collect(
  event<CollectMission>()("set_slot"),
  events<string>()("add_review_actor", "cancel_review"),
  event<Playlist[]>()("update_single"),
  event<Playlist | null>()("toggle_audio"),
  events<Playlist>()("edit_playlist", "delete"),
  event<Frame>()("update_audio_frame"),
  event<Entry>()("add_folder_check"),
  events<Music>()(
    "unstar",
    "up",
    "down",
    "cancle_up",
    "cancle_down",
    "not_exist"
  )
);

export const sub_machine = collect(
  machine<ActorDone>(muinfoMachine)("review"),
  machine(analyzeAudio)("analyzeAudio"),
  machine<CheckDone>(check_folder_machine)("check_folder")
);

export const invoker = createActors({
  async load_collections() {
    const a = await crab.readAll();
    return a.unwrap_or([]);
  },
  async save_collection({ input }: ActorInput<{ slot: CollectMission }>) {
    const a = await crab.create(input.slot);
    a.unwrap();
  },
  async update_collection({
    input,
  }: ActorInput<{ slot: CollectMission; selected: Playlist }>) {
    const a = await crab.update(input.slot, input.selected);
    a.unwrap();
  },
  async download_ytdlp() {
    const a = await crab.ytdlpDownloadAndInstall();
    return a.unwrap_or();
  },
});

export type MainStateT = keyof typeof ss.mainx.State;
export type ResultStateT = keyof typeof resultx.State;
