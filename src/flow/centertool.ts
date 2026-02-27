import { createMachine, createActor } from "xstate";
import { sst } from "./kit";
import { ME, me } from "@grahlnn/fn";
import { useSelector } from "@xstate/react";

const { State, Signal, transfer } = sst(["view", "hide"]);
type StateType = keyof typeof State;

export const machine = createMachine({
  id: "centertool",
  initial: State.view,
  states: {
    [State.view]: {
      on: {
        toggle: State.hide,
        to_hide: State.hide,
      },
    },
    [State.hide]: {
      on: {
        toggle: State.view,
        to_view: State.view,
      },
    },
  },
});

const actor = createActor(machine);

actor.start();

export function toggleCenterTool() {
  actor.send({ type: "toggle" });
}

export function hideCenterTool() {
  actor.send({ type: "to_hide" });
}

export function viewCenterTool() {
  actor.send({ type: "to_view" });
}

export function useXState(): ME<StateType> {
  return useSelector(actor, (state) => me(state.value as StateType));
}
