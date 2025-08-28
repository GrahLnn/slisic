import { CollectMission, Playlist } from "@/src/cmd/commands";
import { collect, defineSS, ns, sst, event, machine } from "../kit";
import { resultx } from "../state";
import { Result } from "@/lib/result";
import { ActorDone, machine as muinfoMachine } from "../muinfo";
import { Frame } from "./core";

export const ss = defineSS(
  ns("resultx", resultx),
  ns(
    "mainx",
    sst(
      ["idle", "loading", "play", "fast_edit", "new_guide", "create", "save"],
      ["run", "unmount", "back"]
    )
  ),
  ns("playx", sst(["stop", "playing"]))
);

export const payloads = collect(
  event<CollectMission>()("set_slot"),
  event<string>()("add_review_actor"),
  event<Playlist[]>()("update_single"),
  event<Playlist>()("toggle_audio"),
  event<Frame>()("update_audio_frame")
);

export const sub_machine = collect(machine<ActorDone>(muinfoMachine)("review"));
export type MainStateT = keyof typeof ss.mainx.State;
export type ResultStateT = keyof typeof resultx.State;
