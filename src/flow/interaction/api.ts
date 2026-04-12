import { createActor } from "xstate";
import { machine } from "./machine";
import { useSelector } from "@xstate/react";
import { me } from "@grahlnn/fn";
import { InteractionStateT, sig } from "./events";

export const actor = createActor(machine);
let started = false;
let unsubscribeDebug: (() => void) | null = null;
type ActorSnapshot = ReturnType<(typeof actor)["getSnapshot"]>;
const selectMainState = me.select(
  (shot: { value: unknown }) => shot.value as InteractionStateT,
  me.eq.strict<InteractionStateT>(),
);
const selectContext = me.select(
  (shot: { context: ActorSnapshot["context"] }) => shot.context,
);

function formatStateValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function attachDebugLogger() {
  let prevState = formatStateValue(actor.getSnapshot().value);

  console.log(`[interaction] enter ${prevState}`);

  const subscription = actor.subscribe((snapshot) => {
    const nextState = formatStateValue(snapshot.value);
    if (nextState === prevState) {
      return;
    }

    console.log(`[interaction] ${prevState} -> ${nextState}`);
    prevState = nextState;
  });

  unsubscribeDebug = () => subscription.unsubscribe();
}

export function ensureStarted() {
  if (started) {
    return;
  }

  actor.start();
  attachDebugLogger();
  started = true;
}

export function stop() {
  if (!started) {
    return;
  }

  actor.stop();
  unsubscribeDebug?.();
  unsubscribeDebug = null;
  started = false;
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
