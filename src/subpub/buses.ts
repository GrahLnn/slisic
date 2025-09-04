import { createMatchAtom, createAtom, createDerivedAtom } from "./core";
import {
  platform as OSplatform,
  type Platform as OSPlatform,
} from "@tauri-apps/plugin-os";
import { CenterToolProp } from "./type";
import { Frame, new_frame } from "../state_machine/music/core";

export const station = {
  centerTool: createAtom<CenterToolProp | null>(null),
  allowBarInteraction: createAtom<boolean>(true),
  audioFrame: createAtom<Frame>(new_frame()),
  cursorinapp: createAtom<boolean>(false),

  os: createMatchAtom<OSPlatform>(OSplatform() as OSPlatform),
};

export const driveStation = {};

export const sizeMap: Map<string, [number, number]> = new Map();
