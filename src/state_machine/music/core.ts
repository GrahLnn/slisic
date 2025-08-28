import { Playlist, CollectMission } from "@/src/cmd/commands";

import { Actor, ActorRefFromLogic } from "xstate";
import { machine } from "../muinfo";
import { AudioAnalyzer } from "@/src/components/audio/Analyzer";

export interface Review {
  url: string;
  actor: ActorRefFromLogic<typeof machine>;
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
  slot?: CollectMission;
  reviews: Review[];
  ref?: any;
  audio: HTMLAudioElement;
  analyzer?: AudioAnalyzer;
  audioFrame: Frame;
}

export function new_slot(): CollectMission {
  return {
    name: "",
    folders: [],
    links: [],
  };
}
