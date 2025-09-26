import { useSelector } from "@xstate/react";
import { createActor, createMachine } from "xstate";
import { defineSS, ns, sst, allState, allSignal, allTransfer } from "./kit";

const ss = defineSS(ns("main", sst(["visible", "hidden"])));
export const state = allState(ss);
export const sig = allSignal(ss);
export const transfer = allTransfer(ss);

export const mac = createMachine({
  initial: state.main.visible,
  states: {
    [state.main.visible]: {
      on: transfer.main.to_hidden,
    },
    [state.main.hidden]: {
      on: transfer.main.to_visible,
    },
  },
});

const actor = createActor(mac);

actor.start();

export function toggleVisibility(shouldVisible: boolean) {
  switch (shouldVisible) {
    case true:
      actor.send(sig.main.to_visible);
      break;
    case false:
      actor.send(sig.main.to_hidden);
      break;
  }
}

export function useIsBarVisible() {
  return useSelector(actor, (shot) => shot.matches(state.main.visible));
}
