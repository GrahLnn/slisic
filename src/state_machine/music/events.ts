import {
  CollectMission,
  Entry,
  Music,
  Playlist,
  ProcessMsg,
} from "@/src/cmd/commands";
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
  InvokeEvt,
  MachineEvt,
  PayloadEvt,
  SignalEvt,
  UniqueEvts,
} from "../kit";
import { resultx } from "../state";
import { ActorDone, machine as muinfoMachine } from "../muinfo";
import { Frame } from "./core";
import crab from "@/src/cmd";
import { check_folder_machine, CheckDone } from "../foldercheck";
import { update_weblist_machine, UpdateDone } from "../updateweblist";

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
  ns("playx", sst(["stop", "playing", "next"], ["next", "play"]))
);

export const payloads = collect(
  event<CollectMission>()("set_slot"),
  events<string>()("add_review_actor", "cancel_review"),
  event<Playlist[]>()("update_single"),
  event<Playlist | null>()("toggle_audio"),
  events<Playlist>()("edit_playlist", "delete"),
  event<Frame>()("update_audio_frame"),
  events<Entry>()("add_folder_check", "update_web_entry"),
  events<Music>()(
    "unstar",
    "up",
    "down",
    "cancle_up",
    "cancle_down",
    "not_exist"
  ),
  event<ProcessMsg>()("processMsg")
);

export const sub_machine = collect(
  machine<ActorDone>(muinfoMachine)("review"),
  machine<CheckDone>(check_folder_machine)("check_folder"),
  machine<UpdateDone>(update_weblist_machine)("update_weblist")
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
export type Events = UniqueEvts<
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>
  | MachineEvt<typeof sub_machine.infer>
>;
