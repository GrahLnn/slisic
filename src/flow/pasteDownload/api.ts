import { createActor } from "xstate";
import { useSelector } from "@xstate/react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { createSender } from "@grahlnn/fn/flow";
import { me } from "@grahlnn/fn";
import { machine } from "./machine";
import { payloads, sig, type MainStateT } from "./events";

export const actor = createActor(machine);
const send = createSender(actor);
const pasteRequested = payloads["paste.requested"];
const candidateDelete = payloads["candidate.delete"];

type ActorSnapshot = ReturnType<(typeof actor)["getSnapshot"]>;

const selectMainState = me.select(
  (shot: { value: unknown }) => shot.value as MainStateT,
  me.eq.strict<MainStateT>(),
);
const selectContext = me.select((shot: { context: ActorSnapshot["context"] }) => shot.context);

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

export const hook = {
  useState: () => me(useSelector(actor, selectMainState.project, selectMainState.compare)),
  useContext: () => useSelector(actor, selectContext.project, selectContext.compare),
};

export const action = {
  paste: async () => {
    ensureStarted();

    try {
      send(pasteRequested.load(await readText()));
    } catch (error) {
      console.error("Failed to read clipboard for paste download", error);
    }
  },
  delete: (id: string) => {
    ensureStarted();
    send(candidateDelete.load(id));
  },
  reset: () => {
    ensureStarted();
    actor.send(sig.mainx.reset);
  },
};
