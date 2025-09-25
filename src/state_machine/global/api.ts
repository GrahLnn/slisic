import { createActor } from "xstate";
import { machine } from "./machine";
import { useSelector } from "@xstate/react";
import { me } from "@/lib/matchable";
import { MainStateT, payloads, ss } from "./state";
import { B } from "@/lib/comb";

export const actor = createActor(machine);
export const hook = {
  useState: () => useSelector(actor, (state) => me(state.value as MainStateT)),
  useContext: () => useSelector(actor, (state) => state.context),
};
/**
 * Active Operation State
 */
export const move = {};

/**
 * Passive Operation State
 */
export const action = {
  update_save_path: B(payloads.new_save_path.load)(actor.send),
  run: () => actor.send(ss.mainx.Signal.run),
};
