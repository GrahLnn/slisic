import { createSender } from "@grahlnn/fn/flow";
import { createActor } from "xstate";
import { payloads } from "./events";
import { machine } from "./machine";

export let actor = createActor(machine);
export let send = createSender(actor);

export const openPlaylist = payloads["playlist.open"];
export const draftNameChanged = payloads["draft.name.changed"];
export const savePathChanged = payloads["save_path.changed"];
export const collectionUpserted = payloads["collection.upserted"];
export const draftCollectionUpserted = payloads["draft.collection.upserted"];
export const draftSidebarItemPushed = payloads["draft.sidebar-item.pushed"];

export function resetRuntimeActor() {
  actor = createActor(machine);
  send = createSender(actor);
}
