import { me } from "@grahlnn/fn";
import { useSelector } from "@xstate/react";
import { createActor } from "xstate";
import { machine } from "./machine";

type UpdaterState = "idle" | "check" | "ok" | "err";

export const actor = createActor(machine);
let started = false;

export function ensureStarted() {
  if (started) {
    return;
  }
  actor.start();
  started = true;
}

export const hook = {
  useState: () => useSelector(actor, (shot) => me(shot.value as UpdaterState)),
  useContext: () => useSelector(actor, (shot) => shot.context),
};

export const action = {
  run: () => actor.send({ type: "run" }),
};
