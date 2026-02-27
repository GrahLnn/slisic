import { useSelector } from "@xstate/react";
import { createActor, createMachine, fromCallback } from "xstate";
import { defineSS, ns, sst, allState, allSignal, allTransfer } from "./kit";
import { Window } from "@tauri-apps/api/window";

const ss = defineSS(ns("x", sst(["normal", "maximized"])));
export const state = allState(ss);
export const sig = allSignal(ss);
export const transfer = allTransfer(ss);

const appWindow = Window.getCurrent();

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

const actor = createActor(mac);
actor.start();

export function useIsWindowMaximized(): boolean {
  return useSelector(actor, (shot) => shot.matches(state.x.maximized));
}
