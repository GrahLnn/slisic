import { createActor } from "xstate";
import { machine } from "./machine";
import { useSelector } from "@xstate/react";
import { me } from "@/lib/matchable";
import { MainStateT, payloads, ss } from "./events";
import { B } from "@/lib/comb";

export const actor = createActor(machine);
export const hook = {
  useState: () => useSelector(actor, (state) => me(state.value as MainStateT)),
  useContext: () => useSelector(actor, (state) => state.context),
};

/**
 * Passive Operation State
 */
export const action = {};
