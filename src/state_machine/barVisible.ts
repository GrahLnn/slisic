import { useSelector } from "@xstate/react";
import { createActor, createMachine } from "xstate";
import { createStateAndSignals } from "./core";

const { State, Signal } = createStateAndSignals({
  states: ["visible", "hidden"],
  signals: ["VISIBLE", "HIDE"],
});

export const visibilityMachine = createMachine({
  id: "visibility",
  initial: State.visible,
  states: {
    [State.visible]: {
      on: {
        [Signal.hide.into()]: {
          target: State.hidden,
        },
      },
    },
    [State.hidden]: {
      on: {
        [Signal.visible.into()]: {
          target: State.visible,
        },
      },
    },
  },
});

const visibilityActor = createActor(visibilityMachine);

visibilityActor.start();

export function toggleVisibility(shouldVisible: boolean) {
  switch (shouldVisible) {
    case true:
      visibilityActor.send(Signal.visible);
      break;
    case false:
      visibilityActor.send(Signal.hide);
      break;
  }
}

export function useIsBarVisible() {
  return useSelector(visibilityActor, (state) => state.matches(State.visible));
}

