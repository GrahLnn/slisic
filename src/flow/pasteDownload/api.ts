import { createActor } from "xstate";
import { useSelector } from "@xstate/react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { createSender } from "@grahlnn/fn/flow";
import { me } from "@grahlnn/fn";
import { machine } from "./machine";
import { listenDownloadTaskChanged, payloads, sig, type MainStateT } from "./events";

export const actor = createActor(machine);
const send = createSender(actor);
const pasteRequested = payloads["paste.requested"];
const candidateDelete = payloads["candidate.delete"];
const downloadTaskChanged = payloads["download.task.changed"];

type ActorSnapshot = ReturnType<(typeof actor)["getSnapshot"]>;

const selectMainState = me.select(
  (shot: { value: unknown }) => shot.value as MainStateT,
  me.eq.strict<MainStateT>(),
);
const selectContext = me.select((shot: { context: ActorSnapshot["context"] }) => shot.context);

let started = false;
let unsubscribeDownloadTaskChanged: (() => void) | null = null;

export function ensureStarted() {
  if (started) {
    return;
  }

  actor.start();
  attachDownloadTaskChangeListener();
  started = true;
}

export function stop() {
  if (!started) {
    return;
  }

  actor.stop();
  unsubscribeDownloadTaskChanged?.();
  unsubscribeDownloadTaskChanged = null;
  started = false;
}

function attachDownloadTaskChangeListener() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return;
  }

  void listenDownloadTaskChanged((payload) => {
    send(downloadTaskChanged.load(payload));
  })
    .then((unlisten) => {
      unsubscribeDownloadTaskChanged = unlisten;
    })
    .catch((error) => {
      console.error("Failed to subscribe to download task changes", error);
    });
}

function requestPasteDownload(text: string) {
  ensureStarted();
  send(pasteRequested.load(text));
}

export const hook = {
  useState: () => me(useSelector(actor, selectMainState.project, selectMainState.compare)),
  useContext: () => useSelector(actor, selectContext.project, selectContext.compare),
};

export const action = {
  paste: async () => {
    try {
      requestPasteDownload(await readText());
    } catch (error) {
      console.error("Failed to read clipboard for paste download", error);
    }
  },
  pasteText: (text: string) => {
    requestPasteDownload(text);
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
