import { useSelector } from "@xstate/react";
import { createActor, createMachine, fromCallback } from "xstate";
import { defineSS, ns, sst, allState, allSignal, allTransfer } from "./kit";
import { Window } from "@tauri-apps/api/window";

const ss = defineSS(ns("x", sst(["normal", "maximized"])));
export const state = allState(ss);
export const sig = allSignal(ss);
export const transfer = allTransfer(ss);

export const mac = createMachine({
  initial: state.x.normal,
  states: {
    [state.x.normal]: {
      on: transfer.x.to_maximized,
    },
    [state.x.maximized]: {
      on: transfer.x.to_normal,
    },
  },
  invoke: {
    src: fromCallback(({ sendBack }) => {
      const appWindow = Window.getCurrent();
      let disposed = false;
      const sync = async () => {
        try {
          const isMaximized = await appWindow.isMaximized();
          if (disposed) return;
          sendBack(isMaximized ? sig.x.to_maximized : sig.x.to_normal);
        } catch (err) {
          console.error(err);
        }
      };

      sync().catch(console.error);
      const unlisten = appWindow.onResized(() => {
        sync().catch(console.error);
      });

      return () => {
        disposed = true;
        unlisten.then((fn) => fn()).catch(console.error);
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

function createWindowMaximizedActor() {
  const actor = createActor(mac);
  actor.start();
  return actor;
}

export function getWindowMaximizedActor(windowLabel = getCurrentWindowLabel()) {
  const existingActor = windowActors.get(windowLabel);
  if (existingActor) {
    return existingActor;
  }

  const actor = createWindowMaximizedActor();
  windowActors.set(windowLabel, actor);
  return actor;
}

export function useIsWindowMaximized(): boolean {
  return useSelector(getWindowMaximizedActor(), (shot) => shot.matches(state.x.maximized));
}
