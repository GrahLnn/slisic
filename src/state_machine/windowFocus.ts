import { useSelector } from "@xstate/react";
import { createActor, createMachine, fromCallback } from "xstate";
import { ss } from "./kit";

const { State, Signal } = ss({
  states: ["focused", "blurred"],
  signals: ["FOCUS", "BLUR"],
});

export const windowFocusMachine = createMachine({
  id: "windowFocus",
  initial: State.focused,
  states: {
    [State.focused]: {
      on: {
        [Signal.blur.into()]: {
          target: State.blurred,
        },
      },
    },
    [State.blurred]: {
      on: {
        [Signal.focus.into()]: {
          target: State.focused,
        },
      },
    },
  },

  invoke: {
    src: fromCallback(({ sendBack }) => {
      function handleFocus() {
        sendBack(Signal.focus);
      }
      function handleBlur() {
        sendBack(Signal.blur);
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

const windowFocusActor = createActor(windowFocusMachine);
windowFocusActor.start();

export function useIsWindowFocus(): boolean {
  return useSelector(windowFocusActor, (machineState) =>
    machineState.matches(State.focused)
  );
}
