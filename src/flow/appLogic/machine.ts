import { app, type AppBootstrap } from "../bootstrap";
import { payloads, ss } from "./events";
import { src } from "./src";

const bootstrapChanged = payloads["bootstrap.changed"];

function shouldWarmMain(snapshot: AppBootstrap) {
  return (
    snapshot.status === "ready" &&
    snapshot.showWindowControls &&
    snapshot.window.match({
      main: () => true,
      support: () => false,
    })
  );
}

export const machine = src.createMachine({
  initial: ss.mainx.State.running,
  context: {},
  states: {
    [ss.mainx.State.running]: {
      on: {
        [bootstrapChanged.evt]: {
          actions: ({ event }) => {
            const snapshot = event.output;
            if (shouldWarmMain(snapshot)) {
              app.warm("Main");
              return;
            }

            app.cold("Main");
          },
        },
      },
    },
  },
});
