import { useSelector } from "@xstate/react";
import { me } from "@grahlnn/fn";
import { MainStateT, sig } from "./events";
import {
  actor,
  collectionUpserted,
  draftNameChanged,
  draftSidebarItemPushed,
  openPlaylist,
  resetRuntimeActor,
  savePathChanged,
  send,
} from "./runtime";
import { action as pasteDownloadAction } from "../pasteDownload";

export { actor } from "./runtime";

type ActorSnapshot = ReturnType<(typeof actor)["getSnapshot"]>;
const selectMainState = me.select(
  (shot: { value: unknown }) => shot.value as MainStateT,
  me.eq.strict<MainStateT>(),
);
const selectContext = me.select((shot: { context: ActorSnapshot["context"] }) => shot.context);

let started = false;
let unsubscribeDebug: (() => void) | null = null;

function formatStateValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function attachDebugLogger() {
  let prevState = formatStateValue(actor.getSnapshot().value);

  console.log(`[appLogic] enter ${prevState}`);

  const subscription = actor.subscribe((snapshot) => {
    const nextState = formatStateValue(snapshot.value);
    if (nextState === prevState) {
      return;
    }

    console.log(`[appLogic] ${prevState} -> ${nextState}`);
    prevState = nextState;
  });

  unsubscribeDebug = () => subscription.unsubscribe();
}

export const action = {
  run: () => {
    ensureStarted();
    actor.send(sig.mainx.run);
  },
  openCreate: (playlistName?: string) => {
    ensureStarted();
    pasteDownloadAction.reset();
    if (playlistName) {
      send(openPlaylist.load(playlistName));
      return;
    }

    actor.send(sig.mainx.opencreate);
  },
  openPlaylist: (playlistName: string) => {
    ensureStarted();
    pasteDownloadAction.reset();
    send(openPlaylist.load(playlistName));
  },
  back: () => {
    ensureStarted();
    actor.send(sig.mainx.back);
  },
  changeDraftName: (name: string) => {
    ensureStarted();
    send(draftNameChanged.load(name));
  },
  changeSavePath: (savePath: string) => {
    ensureStarted();
    send(savePathChanged.load(savePath));
  },
  upsertCollection: (collection: ActorSnapshot["context"]["collections"][number]) => {
    ensureStarted();
    send(collectionUpserted.load(collection));
  },
  pushDraftSidebarItem: (
    item: ActorSnapshot["context"]["configSidebarItems"][number],
  ) => {
    ensureStarted();
    send(draftSidebarItemPushed.load(item));
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
  resetRuntimeActor();
}

export function ensureAppLogicStarted() {
  if (started) {
    return;
  }

  ensureStarted();
  actor.send(sig.mainx.run);
}
