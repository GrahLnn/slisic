import { createSender } from "@grahlnn/fn/flow";
import { createActor } from "xstate";
import { machine } from "./machine";
import { payloads, sig } from "./events";
import {
  createPlaylistCommitSubmission,
  type PlaylistCommitRequest,
  type PlaylistUpsertResult,
} from "./core";
import {
  createPlaylistCommitCompletion,
  rejectAllPlaylistCommitCompletions,
  resetPlaylistCommitCompletions,
} from "./completion";

export let actor = createActor(machine);
let send = createSender(actor);
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
  rejectAllPlaylistCommitCompletions(new Error("playlist commit actor stopped"));
  started = false;
}

export function resetRuntimeActor() {
  resetPlaylistCommitCompletions(new Error("playlist commit runtime reset"));
  actor = createActor(machine);
  send = createSender(actor);
  started = false;
}

export const action = {
  commit: (request: PlaylistCommitRequest) => {
    ensureStarted();
    const completion = new Promise<PlaylistUpsertResult>((resolve, reject) => {
      const completionId = createPlaylistCommitCompletion({
        reject,
        resolve,
      });
      send(commitRequested.load(createPlaylistCommitSubmission(request, completionId)));
    });
    return completion;
  },
  reset: () => {
    ensureStarted();
    rejectAllPlaylistCommitCompletions(new Error("playlist commit reset"));
    actor.send(sig.mainx.reset);
  },
};
