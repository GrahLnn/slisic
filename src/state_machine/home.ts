import { setup, createActor } from "xstate";
import { useSelector } from "@xstate/react";

import { sst } from "./kit";
import { Matchable, me } from "@/lib/matchable";
import { action as musicAction } from "./music/api";

const { State, Signal } = sst(["home"]);
type StateType = keyof typeof State;

const src = setup({
  actions: {},
});

const machine = src.createMachine({
  id: "home",
  initial: State.home,

  states: {
    [State.home]: {
      entry: musicAction.run,
      // on: transfer.pick(""),
    },
  },
});

const actor = createActor(machine);

actor.start();

export function useHomeState(): Matchable<StateType> {
  return useSelector(actor, (state) => me(state.value as StateType));
}

export { actor, Signal, State };
