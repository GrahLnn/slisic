import { createSender } from "@grahlnn/fn/flow";
import { createActor } from "xstate";
import { app } from "../bootstrap";
import { payloads } from "./events";
import { machine } from "./machine";

const actor = createActor(machine);
const send = createSender(actor);
const bootstrapChanged = payloads["bootstrap.changed"];

let started = false;
let unsubscribeBootstrap: (() => void) | null = null;

function syncBootstrapSnapshot() {
  send(bootstrapChanged.load(app.getSnapshot()));
}

export const action = {
  ensureStarted() {
    if (started) {
      return;
    }

    started = true;
    actor.start();
    unsubscribeBootstrap = app.subscribe(syncBootstrapSnapshot);
    syncBootstrapSnapshot();
  },
  stop() {
    if (!started) {
      return;
    }

    started = false;
    unsubscribeBootstrap?.();
    unsubscribeBootstrap = null;
    actor.stop();
  },
};

export function ensureAppLogicStarted() {
  action.ensureStarted();
}
