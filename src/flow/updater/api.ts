import { createActor } from "xstate";
import { machine } from "./machine";
import { useSelector } from "@xstate/react";
import { me } from "@grahlnn/fn";
import { MainStateT, sig } from "./events";

export const actor = createActor(machine);
let started = false;
type ActorSnapshot = ReturnType<(typeof actor)["getSnapshot"]>;
const selectMainState = me.select(
  (shot: { value: unknown }) => shot.value as MainStateT,
  me.eq.strict<MainStateT>(),
);
const selectContext = me.select((shot: { context: ActorSnapshot["context"] }) => shot.context);

export function ensureStarted() {
  if (started) {
    return;
  }
  actor.start();
  started = true;
}

export const hook = {
  useState: () =>
    me(useSelector(actor, selectMainState.project, selectMainState.compare)),
  useContext: () =>
    useSelector(actor, selectContext.project, selectContext.compare),
};

export const action = {
  run: () => {
    ensureStarted();
    actor.send(sig.mainx.run);
  },
};
