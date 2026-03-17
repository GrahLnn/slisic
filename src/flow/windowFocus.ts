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

const windowActors = new Map<string, ReturnType<typeof createActor<typeof mac>>>();

function getCurrentWindowLabel() {
  return (window as unknown as {
    __TAURI_INTERNALS__?: {
      metadata?: {
        currentWindow?: {
          label?: string;
        };
      };
    };
  }).__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? "main";
}

function createWindowFocusActor() {
  const actor = createActor(mac);
  actor.start();
  return actor;
}

export function getWindowFocusActor(windowLabel = getCurrentWindowLabel()) {
  const existingActor = windowActors.get(windowLabel);
  if (existingActor) {
    return existingActor;
  }

  const actor = createWindowFocusActor();
  windowActors.set(windowLabel, actor);
  return actor;
}

export function useIsWindowFocus(): boolean {
  return useSelector(getWindowFocusActor(), (shot) => shot.matches(state.x.focused));
}
