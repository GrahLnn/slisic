import { createActor } from "xstate";
import { machine } from "./machine";
import { useSelector } from "@xstate/react";
import { me } from "@/lib/matchable";
import { MainStateT, payloads, sig } from "./events";
import { B } from "@/lib/comb";

export const actor = createActor(machine);
export const hook = {
  useState: () => useSelector(actor, (s) => me(s.value as MainStateT)),
  useSlot: () => useSelector(actor, (s) => s.context.slot),
  useContext: () => useSelector(actor, (s) => s.context),
  useList: () => useSelector(actor, (s) => s.context.collections),
  useCurPlay: () => useSelector(actor, (s) => s.context.nowPlaying),
  useCurList: () => useSelector(actor, (s) => s.context.selected),
  ussIsPlaying: () => useSelector(actor, (s) => s.matches({ play: "playing" })),
  useIsReview: () =>
    useSelector(
      actor,
      (s) =>
        s.context.reviews.length > 0 ||
        s.context.folderReviews.length > 0 ||
        s.context.updateWeblistReviews.length > 0
    ),
  useAllReview: () =>
    useSelector(actor, (s) => s.context.reviews.map((r) => r.url)),
  useAllFolderReview: () =>
    useSelector(actor, (s) => s.context.folderReviews.map((r) => r.path)),
  useAllWeblistReview: () =>
    useSelector(actor, (s) => s.context.updateWeblistReviews.map((r) => r.url)),
  useMsg: () => useSelector(actor, (s) => s.context.processMsg),
};

/**
 * Passive Operation State
 */
export const action = {
  run: () => actor.send(sig.mainx.run),
  back: () => actor.send(sig.mainx.back),
  set_slot: B(payloads.set_slot.load)(actor.send),
  add_new: () => actor.send(sig.mainx.to_create),
  add_review: B(payloads.add_review_actor.load)(actor.send),
  add_folder_check: B(payloads.add_folder_check.load)(actor.send),
  add_weblist_update: B(payloads.update_web_entry.load)(actor.send),
  save: () => actor.send(sig.resultx.done),
  play: B(payloads.toggle_audio.load)(actor.send),
  edit: B(payloads.edit_playlist.load)(actor.send),
  unstar: B(payloads.unstar.load)(actor.send),
  up: B(payloads.up.load)(actor.send),
  down: B(payloads.down.load)(actor.send),
  cancle_up: B(payloads.cancle_up.load)(actor.send),
  cancle_down: B(payloads.cancle_down.load)(actor.send),
  delete: B(payloads.delete.load)(actor.send),
  cancle_review: B(payloads.cancel_review.load)(actor.send),
  next: () => actor.send(sig.playx.next),
};
