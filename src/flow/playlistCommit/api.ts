import { createActor } from "xstate";
import { createSender } from "@grahlnn/fn/flow";
import { machine } from "./machine";
import { payloads, sig } from "./events";
import type { PlaylistCommitRequest } from "./core";

export const actor = createActor(machine);
const send = createSender(actor);
const commitRequested = payloads["playlist.commit.requested"];

let started = false;

export function ensureStarted() {
  if (started) {
    return;
  }

  actor.start();
  started = true;
}

export function stop() {
  if (!started) {
    return;
  }

  actor.stop();
  started = false;
}

export const action = {
  commit: (request: PlaylistCommitRequest) => {
    ensureStarted();
    send(commitRequested.load(request));
  },
  reset: () => {
    ensureStarted();
    actor.send(sig.mainx.reset);
  },
};
