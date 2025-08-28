import { Actor, createActor } from "xstate";
import { machine } from "./machine";
import { useSelector } from "@xstate/react";
import { me } from "@/lib/matchable";
import { MainStateT, payloads, ss } from "./state";
import { CollectMission, Playlist } from "@/src/cmd/commands";

export const actor = createActor(machine);
export const hook = {
  useState: () => useSelector(actor, (state) => me(state.value as MainStateT)),
  useSlot: () => useSelector(actor, (state) => state.context.slot),
  useContext: () => useSelector(actor, (state) => state.context),
  useList: () => useSelector(actor, (state) => state.context.collections),
  useAudioFrame: () => useSelector(actor, (s) => s.context.audioFrame),
};
/**
 * Active Operation State
 */
export const move = {
  // create: () => actor.send(ss.mainx.Signal.to_create),
};

/**
 * Passive Operation State
 */
export const action = {
  run: () => actor.send(ss.mainx.Signal.run),
  set_slot: (slot: CollectMission) => actor.send(payloads.set_slot.load(slot)),
  add_new: () => actor.send(ss.mainx.Signal.to_create),
  add_review: (url: string) => actor.send(payloads.add_review_actor.load(url)),
  save: () => actor.send(ss.resultx.Signal.done),
  play: (playlist: Playlist) =>
    actor.send(payloads.toggle_audio.load(playlist)),
};
