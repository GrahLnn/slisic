import { createSender } from "@grahlnn/fn/flow";
import { useSelector } from "@xstate/react";
import { me } from "@grahlnn/fn";
import type { Collection } from "@/src/cmd";
import { createActor } from "xstate";
import { MainStateT, payloads, sig } from "./events";
import { machine } from "./machine";

export const actor = createActor(machine);
const send = createSender(actor);
const openCollection = payloads["collection.open"];
const draftNameChanged = payloads["draft.name.changed"];
type ActorSnapshot = ReturnType<(typeof actor)["getSnapshot"]>;
const selectMainState = me.select(
  (shot: { value: unknown }) => shot.value as MainStateT,
  me.eq.strict<MainStateT>(),
);
const selectContext = me.select((shot: { context: ActorSnapshot["context"] }) => shot.context);

let started = false;

export const action = {
  run: () => {
    ensureStarted();
    actor.send(sig.mainx.run);
  },
  openCreate: () => {
    ensureStarted();
    actor.send(sig.mainx.opencreate);
  },
  openCollection: (collection: Collection) => {
    ensureStarted();
    send(openCollection.load(collection));
  },
  back: () => {
    ensureStarted();
    actor.send(sig.mainx.back);
  },
  changeDraftName: (name: string) => {
    ensureStarted();
    send(draftNameChanged.load(name));
  },
};

export const hook = {
  useState: () => me(useSelector(actor, selectMainState.project, selectMainState.compare)),
  useContext: () => useSelector(actor, selectContext.project, selectContext.compare),
};

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

export function ensureAppLogicStarted() {
  if (started) {
    return;
  }

  ensureStarted();
  actor.send(sig.mainx.run);
}
