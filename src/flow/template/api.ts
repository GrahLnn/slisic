import { createActor } from "xstate";
import { machine } from "./machine";
import { useSelector } from "@xstate/react";
import { me, B } from "@grahlnn/fn";
import { MainStateT, payloads, sig } from "./events";
import { createSender } from "@grahlnn/fn/flow";

export const actor = createActor(machine);
const send = createSender(actor);
type ActorSnapshot = ReturnType<(typeof actor)["getSnapshot"]>;
const selectMainState = me.select(
  (shot: { value: unknown }) => shot.value as MainStateT,
  me.eq.strict<MainStateT>(),
);
const selectContext = me.select(
  (shot: { context: ActorSnapshot["context"] }) => shot.context,
);

export const hook = {
  useState: () =>
    me(useSelector(actor, selectMainState.project, selectMainState.compare)),
  useContext: () =>
    useSelector(actor, selectContext.project, selectContext.compare),
};

export const action = {};
