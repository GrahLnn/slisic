import {
  Playlist,
  CollectMission,
  Music,
  ProcessMsg,
} from "@/src/cmd/commands";

import { Actor, ActorRefFromLogic } from "xstate";
import { machine } from "../muinfo";
import { check_folder_machine } from "../foldercheck";
import { AudioAnalyzer } from "@/src/components/audio/analyzer";
import { AudioEngine } from "@/src/components/audio/engine";
import { update_weblist_machine } from "../updateweblist";

export interface Review {
  url: string;
  actor: ActorRefFromLogic<typeof machine>;
}

export interface FolderReview {
  path: string;
  actor: ActorRefFromLogic<typeof check_folder_machine>;
}

export interface UpdateWeblistReview {
  url: string;
  actor: ActorRefFromLogic<typeof update_weblist_machine>;
}

export type Frame = {
  frequencyNorm: Float32Array;
  volume: number;
  bass: number;
  mid: number;
  treble: number;
  bassPeak: number;
  volumePeak: number;
  intensityBurst: number;
};

export function new_frame(): Frame {
  return {
    frequencyNorm: new Float32Array(1024),
    volume: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    bassPeak: 0,
    volumePeak: 0,
    intensityBurst: 0,
  };
}

export interface Context {
  collections: Playlist[];
  saving_record?: string[];
  selected?: Playlist;
  flatList: Array<Music>;
  slot?: CollectMission;
  reviews: Review[];
  folderReviews: FolderReview[];
  updateWeblistReviews: UpdateWeblistReview[];
  ref?: any;
  audio: HTMLAudioElement;
  analyzer?: AudioAnalyzer;
  engine?: AudioEngine;
  nowPlaying?: Music;
  nowJudge?: "Up" | "Down";
  lastPlay?: Music;
  playToken?: number;
  processMsg?: ProcessMsg;
  __stopOnFrame?: () => void;
  __stopSampling?: () => void;
  __offPlayEvents?: () => void;
}

export function new_slot(): CollectMission {
  return {
    name: "",
    folders: [],
    links: [],
    entries: [],
    exclude: [],
  };
}

export function into_slot(playlist: Playlist): CollectMission {
  return {
    name: playlist.name,
    entries: playlist.entries,
    folders: [],
    links: [],
    exclude: playlist.exclude,
  };
}
