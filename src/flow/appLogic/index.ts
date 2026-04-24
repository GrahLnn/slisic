import { useSelector } from "@xstate/react";
import { me } from "@grahlnn/fn";
import { crab } from "@/src/cmd";
import type { ConfigSidebarItemRef, PlaylistUpsertResult } from "./core";
import { MainStateT, sig } from "./events";
import {
  actor,
  collectionUpserted,
  collectionUpdatesRequested,
  draftNameChanged,
  draftItemIncluded,
  draftItemRemoved,
  nowPlayingTrackChanged,
  openPlaylist,
  playPlaylist,
  playlistDeleted,
  playlistPreviewChanged,
  playlistUpserted,
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
let unsubscribeNowPlayingTrackChanged: (() => void) | null = null;

function formatStateValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function summarizeContext(context: ActorSnapshot["context"]) {
  return {
    activeLayoutId: context.activeLayoutId,
    pendingPlaylistName: context.pendingPlaylistName,
    playingPlaylistName: context.playingPlaylistName,
    nowPlayingTrackName: context.nowPlayingTrackName,
    error: context.error,
    titleToneHandoffLayoutId: context.titleToneHandoff?.layoutId ?? null,
    titleToneHandoffTone: context.titleToneHandoff?.tone ?? null,
    pendingPlaylistPreview: context.pendingPlaylistPreview
      ? {
          name: context.pendingPlaylistPreview.playlist.name,
          previousName: context.pendingPlaylistPreview.previousName,
        }
      : null,
    playlists: context.playlists.map((playlist) => playlist.name),
    draft: context.draft
      ? {
          mode: context.draft.mode,
          name: context.draft.name,
          collectionCount: context.draft.collections.length,
          groupCount: context.draft.groups.length,
        }
      : null,
  };
}

function attachDebugLogger() {
  const initialSnapshot = actor.getSnapshot();
  let prevState = formatStateValue(initialSnapshot.value);
  let prevContextSummary = summarizeContext(initialSnapshot.context);
  let prevContextKey = JSON.stringify(prevContextSummary);

  console.log(`[appLogic] enter ${prevState}`);
  if (prevContextSummary.error) {
    console.error(`[appLogic:error] ${prevState}`, prevContextSummary.error);
  }

  const subscription = actor.subscribe((snapshot) => {
    const nextState = formatStateValue(snapshot.value);
    const contextSummary = summarizeContext(snapshot.context);
    const nextContextKey = JSON.stringify(contextSummary);
    if (nextState === prevState && nextContextKey === prevContextKey) {
      return;
    }

    console.log(`[appLogic] ${prevState} -> ${nextState}`);
    if (
      contextSummary.error &&
      (contextSummary.error !== prevContextSummary.error || nextState === "error")
    ) {
      console.error(`[appLogic:error] ${nextState}`, contextSummary.error);
    }

    prevState = nextState;
    prevContextSummary = contextSummary;
    prevContextKey = nextContextKey;
  });

  unsubscribeDebug = () => subscription.unsubscribe();
}

function requestPlaybackStop() {
  void crab
    .stopPlayback()
    .then((result) =>
      result.match({
        Ok: () => undefined,
        Err: (error) => {
          console.error("Failed to stop playlist playback", error);
        },
      }),
    )
    .catch((error) => {
      console.error("Failed to stop playlist playback", error);
    });
}

function shouldStopPlaybackForSnapshot(snapshot: ActorSnapshot) {
  return snapshot.value === "play" && snapshot.context.playingPlaylistName !== null;
}

function attachNowPlayingTrackListener() {
  if (
    typeof window === "undefined" ||
    !("__TAURI_INTERNALS__" in window)
  ) {
    return;
  }

  void crab
    .evt("nowPlayingTrackChangedEvent")((payload) => {
      send(nowPlayingTrackChanged.load(payload));
    })
    .then((unlisten) => {
      unsubscribeNowPlayingTrackChanged = unlisten;
    })
    .catch((error) => {
      console.error("Failed to subscribe to now playing track changes", error);
    });
}

export const action = {
  run: () => {
    ensureStarted();
    if (shouldStopPlaybackForSnapshot(actor.getSnapshot())) {
      requestPlaybackStop();
    }
    actor.send(sig.mainx.run);
  },
  openCreate: (playlistName?: string) => {
    ensureStarted();
    pasteDownloadAction.reset();
    if (shouldStopPlaybackForSnapshot(actor.getSnapshot())) {
      requestPlaybackStop();
    }
    if (playlistName) {
      send(openPlaylist.load(playlistName));
      return;
    }

    actor.send(sig.mainx.opencreate);
  },
  openPlaylist: (playlistName: string) => {
    ensureStarted();
    pasteDownloadAction.reset();
    if (shouldStopPlaybackForSnapshot(actor.getSnapshot())) {
      requestPlaybackStop();
    }
    send(openPlaylist.load(playlistName));
  },
  playPlaylist: (playlistName: string) => {
    ensureStarted();
    pasteDownloadAction.reset();
    const snapshot = actor.getSnapshot();
    if (
      snapshot.value === "play" &&
      snapshot.context.playingPlaylistName === playlistName
    ) {
      requestPlaybackStop();
      actor.send(sig.mainx.back);
      return;
    }

    send(playPlaylist.load(playlistName));
  },
  back: () => {
    ensureStarted();
    if (shouldStopPlaybackForSnapshot(actor.getSnapshot())) {
      requestPlaybackStop();
    }
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
  upsertPlaylist: (payload: PlaylistUpsertResult) => {
    ensureStarted();
    send(playlistUpserted.load(payload));
  },
  deletePlaylist: (playlistName: string) => {
    ensureStarted();
    send(playlistDeleted.load(playlistName));
  },
  previewPlaylist: (payload: PlaylistUpsertResult | null) => {
    ensureStarted();
    send(playlistPreviewChanged.load(payload));
  },
  includeDraftItem: (item: ConfigSidebarItemRef) => {
    ensureStarted();
    send(draftItemIncluded.load(item));
  },
  removeDraftItem: (item: ConfigSidebarItemRef) => {
    ensureStarted();
    send(draftItemRemoved.load(item));
  },
  setCollectionUpdates: (url: string, enabled: boolean) => {
    ensureStarted();
    send(
      collectionUpdatesRequested.load({
        url,
        enabled,
      }),
    );
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
  attachNowPlayingTrackListener();
  started = true;
}

export function stop() {
  if (!started) {
    return;
  }

  actor.stop();
  unsubscribeDebug?.();
  unsubscribeDebug = null;
  unsubscribeNowPlayingTrackChanged?.();
  unsubscribeNowPlayingTrackChanged = null;
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
