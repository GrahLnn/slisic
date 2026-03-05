import { assign, fromPromise, setup } from "xstate";
import type { Context } from "./core";
import { checkForUpdate, ONE_HOUR } from "./events";

export const machine = setup({
  types: {
    context: {} as Context,
    events: {} as { type: "run" },
  },
  actors: {
    checkUpdate: fromPromise(async () => {
      await checkForUpdate();
    }),
  },
}).createMachine({
  id: "updater",
  initial: "idle",
  context: {
    lastCheckedAt: null,
    lastError: null,
  },
  states: {
    idle: {
      on: {
        run: "check",
      },
    },
    check: {
      invoke: {
        src: "checkUpdate",
        onDone: {
          target: "ok",
          actions: assign({
            lastCheckedAt: () => Date.now(),
            lastError: () => null,
          }),
        },
        onError: {
          target: "err",
          actions: assign({
            lastCheckedAt: () => Date.now(),
            lastError: ({ event }) => {
              const reason =
                event && typeof event === "object" && "error" in event
                  ? (event as { error: unknown }).error
                  : event;
              return reason instanceof Error ? reason.message : String(reason);
            },
          }),
        },
      },
    },
    ok: {
      type: "final",
    },
    err: {
      after: {
        [ONE_HOUR]: "check",
      },
      on: {
        run: "check",
      },
    },
  },
});
