import { createActor } from "xstate";
import { machine } from "./machine";
import { useSelector } from "@xstate/react";
import { me } from "@/lib/matchable";
import { MainStateT, payloads, sig } from "./events";
import { B } from "@/lib/comb";
import { createSender } from "../kit";

export const actor = createActor(machine);
const send = createSender(actor);

export const hook = {
  useState: () => useSelector(actor, (shot) => me(shot.value as MainStateT)),
  useContext: () => useSelector(actor, (shot) => shot.context),
};

export const action = {};
