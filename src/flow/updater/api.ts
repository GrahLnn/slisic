import { createActor } from "xstate";
import { machine } from "./machine";
import { useSelector } from "@xstate/react";
import { me } from "@grahlnn/fn";
import { MainStateT, payloads, sig } from "./events";

export const actor = createActor(machine);
export const hook = {
  useState: () => useSelector(actor, (shot) => me(shot.value as MainStateT)),
  useContext: () => useSelector(actor, (shot) => shot.context),
};

export const action = {
  run: () => actor.send(sig.mainx.run),
};
