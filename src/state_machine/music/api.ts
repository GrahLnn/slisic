import { Actor, createActor } from "xstate";
import { machine } from "./machine";
import { useSelector } from "@xstate/react";
import { me } from "@/lib/matchable";
import { MainStateT, payloads, ss } from "./events";
import { CollectMission, Entry, Music, Playlist } from "@/src/cmd/commands";

export const actor = createActor(machine);
export const hook = {
  useState: () => useSelector(actor, (state) => me(state.value as MainStateT)),
  useSlot: () => useSelector(actor, (state) => state.context.slot),
  useContext: () => useSelector(actor, (state) => state.context),
  useList: () => useSelector(actor, (state) => state.context.collections),
  //   useAudioFrame: () => useSelector(actor, (s) => s.context.audioFrame),
  useCurPlay: () => useSelector(actor, (s) => s.context.nowPlaying),
  useCurList: () => useSelector(actor, (s) => s.context.selected),
  ussIsPlaying: () => useSelector(actor, (s) => s.matches({ play: "playing" })),
  useIsReview: () => useSelector(actor, (s) => s.context.reviews.length > 0),
  useAllFolderReview: () =>
    useSelector(actor, (s) => s.context.folderReviews.map((r) => r.path)),
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
  back: () => actor.send(ss.mainx.Signal.back),
  set_slot: (slot: CollectMission) => actor.send(payloads.set_slot.load(slot)),
  add_new: () => actor.send(ss.mainx.Signal.to_create),
  add_review: (url: string) => actor.send(payloads.add_review_actor.load(url)),
  add_folder_check: (entry: Entry) =>
    actor.send(payloads.add_folder_check.load(entry)),
  save: () => actor.send(ss.resultx.Signal.done),
  play: (playlist: Playlist) =>
    actor.send(payloads.toggle_audio.load(playlist)),
  edit: (playlist: Playlist) =>
    actor.send(payloads.edit_playlist.load(playlist)),
  unstar: (music: Music) => actor.send(payloads.unstar.load(music)),
  up: (music: Music) => actor.send(payloads.up.load(music)),
  down: (music: Music) => actor.send(payloads.down.load(music)),
  cancle_up: (music: Music) => actor.send(payloads.cancle_up.load(music)),
  cancle_down: (music: Music) => actor.send(payloads.cancle_down.load(music)),
  delete: (playlist: Playlist) => actor.send(payloads.delete.load(playlist)),
  cancle_review: (url: string) => actor.send(payloads.cancel_review.load(url)),
  next: () => actor.send(ss.playx.Signal.next),
};
