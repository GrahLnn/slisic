import { useSelector } from "@xstate/react";
import { createActor, createMachine, fromCallback } from "xstate";
import { defineSS, ns, sst, allState, allSignal, allTransfer } from "./kit";

const ss = defineSS(ns("x", sst(["focused", "blurred"])));
export const state = allState(ss);
export const sig = allSignal(ss);
export const transfer = allTransfer(ss);

export const mac = createMachine({
  initial: state.x.focused,
  states: {
    [state.x.focused]: {
      on: transfer.x.to_blurred,
    },
    [state.x.blurred]: {
      on: transfer.x.to_focused,
    },
  },

  invoke: {
    src: fromCallback(({ sendBack }) => {
      function handleFocus() {
        sendBack(sig.x.to_focused);
      }
      function handleBlur() {
        sendBack(sig.x.to_blurred);
      }

      window.addEventListener("focus", handleFocus);
      window.addEventListener("blur", handleBlur);

      return () => {
        window.removeEventListener("focus", handleFocus);
        window.removeEventListener("blur", handleBlur);
      };
    }),
  },
});

const actor = createActor(mac);
actor.start();

export function useIsWindowFocus(): boolean {
  return useSelector(actor, (shot) => shot.matches(state.x.focused));
}
