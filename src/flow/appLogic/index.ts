import { useSelector } from "@xstate/react";
import { me } from "@grahlnn/fn";
import type { ConfigSidebarItemRef, PlaylistPreview, PlaylistUpsertResult } from "./core";
import {
  chooseSavePath,
  chooseCollectionFolder,
  createLocalCollectionShell,
  deletePlaylistRecord,
  enterSpectrumPlaybackScope,
  excludeCurrentMusicAndSkip,
  exitSpectrumPlaybackScope,
  importLocalCollection,
  invoker,
  listenPlaybackDiagnosticTrace,
  listenPlaybackExcludeCommitted,
  listenNowPlayingTrackChanged,
  MainStateT,
  persistSavePath,
  refreshPlayableIndex,
  removeExclude,
  setCurrentMusicLiked,
  setPlaybackContinuationMode,
  sig,
  stopPlayback,
} from "./events";
import {
  actor,
  collectionUpserted,
  collectionUpdatesRequested,
  draftCollectionUpserted,
  draftExtraRemoved,
  draftNameChanged,
  draftItemIncluded,
  draftItemRemoved,
  excludeAdded,
  excludeRemoved,
  nowPlayingTrackChanged,
  openPlaylist,
  playPlaylist,
  playlistPlaybackAccepted,
  playlistDeleted,
  playlistPreviewChanged,
  playlistUpserted,
  resetRuntimeActor,
  savePathChanged,
  send,
  spectrumMusicDraftReset,
  spectrumMusicDeleted,
  spectrumMusicCreateStarted,
  spectrumPlaybackScopeChanged,
  spectrumMusicCommitFailed,
  spectrumMusicCreatesCommitted,
  spectrumMusicDeletesCommitted,
  spectrumMusicUpdatesCommitted,
  spectrumMusicRangeChanged,
  spectrumMusicNameChanged,
} from "./runtime";
import type { Exclude, Music } from "@/src/cmd";
import { action as pasteDownloadAction } from "../pasteDownload";
import {
  createMusicDraftCreates,
  createMusicDraftDeletes,
  createMusicDraftEdits,
  hasSpectrumMusicDraftCommitOperations,
} from "./musicTitle";
import { createPlaybackContinuationModeEffectOwner } from "./playbackContinuationModeEffectOwner";
import {
  resolveSpectrumEnterPlaybackModeEffects,
  resolveSpectrumExitPlaybackModeEffects,
  shouldCommitSpectrumPlaybackScopeExit,
  type PlaybackModeEffect,
} from "./playbackMode";
import { recordRenderPerformanceTrace } from "@/src/debug/renderPerformanceTrace";

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
let unsubscribePlaybackDiagnosticTrace: (() => void) | null = null;
let unsubscribePlaybackExcludeCommitted: (() => void) | null = null;
const playbackContinuationModeEffectOwner = createPlaybackContinuationModeEffectOwner({
  setPlaybackContinuationMode,
});
let lastPlayableIndexReadyState = false;
let playlistPlaybackStartEpoch = 0;

function formatStateValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function currentPerformanceNow() {
  return globalThis.performance?.now() ?? Date.now();
}

function traceAppSnapshotPayload(snapshot: ActorSnapshot) {
  return {
    state: formatStateValue(snapshot.value),
    spectrumPlaybackScopeId: snapshot.context.spectrumPlaybackScopeId,
    playingPlaylistName: snapshot.context.playingPlaylistName,
    pendingPlaylistPlaybackName: snapshot.context.pendingPlaylistPlaybackName,
    nowPlayingTrackName: snapshot.context.nowPlayingTrackName,
    nowPlayingTrackUrl: snapshot.context.nowPlayingTrackUrl,
    nowPlayingTrackFilePath: snapshot.context.nowPlayingTrackFilePath,
    nowPlayingTrackStartMs: snapshot.context.nowPlayingTrackStartMs,
    nowPlayingTrackEndMs: snapshot.context.nowPlayingTrackEndMs,
  };
}

function refreshPlayableIndexForReadyProjection(snapshot: ActorSnapshot) {
  const isReady = snapshot.value === "ready";
  if (!isReady || lastPlayableIndexReadyState) {
    lastPlayableIndexReadyState = isReady;
    return;
  }

  lastPlayableIndexReadyState = true;
  refreshPlayableIndex();
}

export function attachDebugLogger() {
  if (unsubscribeDebug !== null) {
    return;
  }

  const initialSnapshot = actor.getSnapshot();
  let prevState = formatStateValue(initialSnapshot.value);
  let prevError = initialSnapshot.context.error;
  lastPlayableIndexReadyState = initialSnapshot.value === "ready";
  recordRenderPerformanceTrace("app-state-initial", traceAppSnapshotPayload(initialSnapshot));

  if (prevError) {
    console.error(`[appLogic:error] ${prevState}`, prevError);
  }

  const subscription = actor.subscribe((snapshot) => {
    const nextState = formatStateValue(snapshot.value);
    const nextError = snapshot.context.error;
    if (nextState === prevState) {
      if (nextError && nextError !== prevError) {
        console.error(`[appLogic:error] ${nextState}`, nextError);
      }
      prevError = nextError;
      return;
    }

    if (nextError) {
      console.error(`[appLogic:error] ${nextState}`, nextError);
    }

    recordRenderPerformanceTrace("app-state-changed", {
      fromState: prevState,
      ...traceAppSnapshotPayload(snapshot),
    });
    refreshPlayableIndexForReadyProjection(snapshot);
    prevState = nextState;
    prevError = nextError;
  });

  unsubscribeDebug = () => subscription.unsubscribe();
}

function requestPlaybackStop() {
  playlistPlaybackStartEpoch += 1;
  void stopPlayback()
    .then(() => undefined)
    .catch((error) => {
      console.error("Failed to stop playlist playback", error);
    });
}

async function excludeCurrentMusicAndSkipFromPlayback(snapshot: ActorSnapshot) {
  const result = await excludeCurrentMusicAndSkip();
  if (result.status === "skipped" || result.status === "deleted_playlist") {
    send(
      excludeAdded.load({
        exclude: result.exclude,
        excludeAvailability: result.exclude_availability,
      }),
    );
  }

  if (result.status !== "deleted_playlist") {
    return;
  }

  send(playlistDeleted.load(result.playlist_name));
  const current = actor.getSnapshot();
  if (
    snapshot.value === "play" &&
    current.value === "play" &&
    snapshot.context.playingPlaylistName === result.playlist_name &&
    current.context.playingPlaylistName === result.playlist_name
  ) {
    actor.send(sig.mainx.back);
  }
}

function requestExcludeCurrentMusicAndSkip(snapshot: ActorSnapshot) {
  void excludeCurrentMusicAndSkipFromPlayback(snapshot).catch((error) => {
    console.error("Failed to exclude current music and skip playback", error);
  });
}

function createOptimisticExcludeAddedChange(exclude: Exclude) {
  return {
    exclude,
    excludeAvailability: actor.getSnapshot().context.configLibrary.exclude_availability,
  };
}

function requestSetCurrentPlaybackMusicLiked(liked: boolean) {
  void setCurrentMusicLiked(liked).catch((error) => {
    console.error("Failed to update current music like", error);
  });
}

async function startPlaylistPlaybackFromAction(playlistName: string) {
  const epoch = ++playlistPlaybackStartEpoch;
  const session = await invoker.playPlaylist.__src__({ playlistName });
  if (session === null) {
    return null;
  }

  if (epoch !== playlistPlaybackStartEpoch) {
    recordRenderPerformanceTrace("playlist-play-action-stale-result", {
      playlistName,
      epoch,
      currentEpoch: playlistPlaybackStartEpoch,
      status: session.status,
      trackCount: session.track_count,
    });
    return null;
  }

  send(playlistPlaybackAccepted.load({ playlistName, session }));
  return session;
}

async function applyPlaybackModeEffect(effect: PlaybackModeEffect) {
  if (effect.kind === "enterSpectrumPlaybackScope") {
    recordRenderPerformanceTrace("app-playback-mode-effect-start", {
      effect: effect.kind,
      ...traceAppSnapshotPayload(actor.getSnapshot()),
    });
    const scopeId = await enterSpectrumPlaybackScope();
    send(spectrumPlaybackScopeChanged.load(scopeId));
    recordRenderPerformanceTrace("app-playback-mode-effect-finished", {
      effect: effect.kind,
      scopeId,
      ...traceAppSnapshotPayload(actor.getSnapshot()),
    });
    return;
  }

  if (effect.kind === "exitSpectrumPlaybackScope") {
    recordRenderPerformanceTrace("app-playback-mode-effect-start", {
      effect: effect.kind,
      requestedScopeId: effect.scopeId,
      ...traceAppSnapshotPayload(actor.getSnapshot()),
    });
    if (effect.scopeId !== null) {
      await exitSpectrumPlaybackScope(effect.scopeId);
    }
    const shouldCommitExit = shouldCommitSpectrumPlaybackScopeExit({
      currentScopeId: actor.getSnapshot().context.spectrumPlaybackScopeId,
      requestedScopeId: effect.scopeId,
    });
    if (shouldCommitExit) {
      send(spectrumPlaybackScopeChanged.load(null));
    }
    recordRenderPerformanceTrace("app-playback-mode-effect-finished", {
      effect: effect.kind,
      requestedScopeId: effect.scopeId,
      committed: shouldCommitExit,
      ...traceAppSnapshotPayload(actor.getSnapshot()),
    });
    return;
  }

  if (effect.kind === "setPlaybackContinuationMode") {
    recordRenderPerformanceTrace("app-playback-mode-effect-start", {
      effect: effect.kind,
      mode: effect.mode,
      ...traceAppSnapshotPayload(actor.getSnapshot()),
    });
    await playbackContinuationModeEffectOwner.request(effect.mode);
    recordRenderPerformanceTrace("app-playback-mode-effect-finished", {
      effect: effect.kind,
      mode: effect.mode,
      ...traceAppSnapshotPayload(actor.getSnapshot()),
    });
  }
}

async function applyPlaybackModeEffects(effects: PlaybackModeEffect[]) {
  for (const effect of effects) {
    await applyPlaybackModeEffect(effect);
  }
}

function requestPlaybackModeEffects(effects: PlaybackModeEffect[], errorMessage: string) {
  if (effects.length === 0) {
    return;
  }

  void applyPlaybackModeEffects(effects).catch((error) => {
    console.error(errorMessage, error);
  });
}

function isSpectrumOpenSourceStillCurrent(source: ActorSnapshot, current: ActorSnapshot): boolean {
  return (
    source.value === "play" &&
    current.value === "play" &&
    source.context.playingPlaylistName === current.context.playingPlaylistName &&
    source.context.nowPlayingTrackUrl === current.context.nowPlayingTrackUrl &&
    source.context.nowPlayingTrackFilePath === current.context.nowPlayingTrackFilePath &&
    source.context.nowPlayingTrackStartMs === current.context.nowPlayingTrackStartMs &&
    source.context.nowPlayingTrackEndMs === current.context.nowPlayingTrackEndMs
  );
}

async function openSpectrumAfterPlaybackMode(sourceSnapshot: ActorSnapshot) {
  let openedScopeId: number | null = null;
  recordRenderPerformanceTrace("spectrum-open-flow-start", traceAppSnapshotPayload(sourceSnapshot));
  for (const effect of resolveSpectrumEnterPlaybackModeEffects()) {
    if (effect.kind === "enterSpectrumPlaybackScope") {
      recordRenderPerformanceTrace("spectrum-open-scope-enter-start", {
        ...traceAppSnapshotPayload(actor.getSnapshot()),
      });
      openedScopeId = await enterSpectrumPlaybackScope();
      send(spectrumPlaybackScopeChanged.load(openedScopeId));
      recordRenderPerformanceTrace("spectrum-open-scope-entered", {
        openedScopeId,
        ...traceAppSnapshotPayload(actor.getSnapshot()),
      });
      continue;
    }

    await applyPlaybackModeEffect(effect);
  }

  const currentSnapshot = actor.getSnapshot();
  const shouldCommit = isSpectrumOpenSourceStillCurrent(sourceSnapshot, currentSnapshot);

  if (!shouldCommit) {
    recordRenderPerformanceTrace("spectrum-open-rejected-stale-source", {
      openedScopeId,
      source: traceAppSnapshotPayload(sourceSnapshot),
      current: traceAppSnapshotPayload(currentSnapshot),
    });
    if (openedScopeId !== null) {
      await applyPlaybackModeEffects(resolveSpectrumExitPlaybackModeEffects(openedScopeId));
    }
    return;
  }

  actor.send(sig.mainx.openspectrum);
  recordRenderPerformanceTrace("spectrum-open-committed", {
    openedScopeId,
    ...traceAppSnapshotPayload(actor.getSnapshot()),
  });
}

async function restorePlaybackPageModeBeforeBackFromSpectrum(snapshot: ActorSnapshot) {
  const effects = resolveSpectrumExitPlaybackModeEffects(snapshot.context.spectrumPlaybackScopeId);

  recordRenderPerformanceTrace("spectrum-back-restore-mode-start", traceAppSnapshotPayload(snapshot));
  await applyPlaybackModeEffects(effects);
  recordRenderPerformanceTrace("spectrum-back-restore-mode-finished", {
    source: traceAppSnapshotPayload(snapshot),
    current: traceAppSnapshotPayload(actor.getSnapshot()),
  });
}

function requestExitSpectrumPlaybackScope(scopeId: number | null) {
  requestPlaybackModeEffects(
    resolveSpectrumExitPlaybackModeEffects(scopeId),
    "Failed to exit spectrum playback scope",
  );
}

function requestRestorePlaybackPageModeBeforeBackFromSpectrum(snapshot: ActorSnapshot) {
  void restorePlaybackPageModeBeforeBackFromSpectrum(snapshot).catch((error) => {
    console.error("Failed to restore playback before returning from spectrum", error);
  });
}

function requestSpectrumMusicCommit(snapshot: ActorSnapshot) {
  const epoch = snapshot.context.spectrumMusicCommitEpoch + 1;
  const updates = createMusicDraftEdits(snapshot.context.spectrumMusicDrafts);
  const creates = createMusicDraftCreates(snapshot.context.spectrumMusicDrafts).map((create) => ({
    sourceCollectionUrl: create.sourceCollectionUrl,
    music: create.music,
  }));
  const deletes = createMusicDraftDeletes(snapshot.context.spectrumMusicDrafts);

  recordRenderPerformanceTrace("spectrum-music-commit-requested", {
    epoch,
    creates: creates.length,
    deletes: deletes.length,
    updates: updates.length,
  });

  void (async () => {
    const fail = (phase: "create" | "delete" | "update", error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      recordRenderPerformanceTrace("spectrum-music-commit-error", {
        epoch,
        error: message,
        phase,
      });
      send(spectrumMusicCommitFailed.load({ epoch, error: message, phase }));
      return null;
    };

    if (updates.length > 0) {
      const result = await invoker.updateMusics.__src__(updates).catch((error: unknown) =>
        fail("update", error),
      );
      if (result === null) {
        return;
      }
      send(spectrumMusicUpdatesCommitted.load({ epoch, result }));
    }
    if (creates.length > 0) {
      const result = await invoker.createMusics.__src__(creates).catch((error: unknown) =>
        fail("create", error),
      );
      if (result === null) {
        return;
      }
      send(spectrumMusicCreatesCommitted.load({ epoch, result }));
    }
    if (deletes.length > 0) {
      const result = await invoker.deleteMusics.__src__(deletes).catch((error: unknown) =>
        fail("delete", error),
      );
      if (result === null) {
        return;
      }
      send(spectrumMusicDeletesCommitted.load({ epoch, result }));
    }

    try {
      recordRenderPerformanceTrace("spectrum-music-commit-finished", { epoch });
    } catch (error) {
      console.error("Failed to record spectrum music commit completion", error);
    }
  })();
}

function shouldCommitSpectrumMusicForSnapshot(snapshot: ActorSnapshot) {
  return (
    snapshot.value === "spectrum" &&
    hasSpectrumMusicDraftCommitOperations(snapshot.context.spectrumMusicDrafts)
  );
}

function shouldStopPlaybackForSnapshot(snapshot: ActorSnapshot) {
  return snapshot.value === "play" && snapshot.context.playingPlaylistName !== null;
}

function shouldExitSpectrumPlaybackScopeForSnapshot(snapshot: ActorSnapshot) {
  return snapshot.context.spectrumPlaybackScopeId !== null;
}

function attachNowPlayingTrackListener() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return;
  }

  void listenNowPlayingTrackChanged((payload) => {
    recordRenderPerformanceTrace("player-now-playing-event-received", {
      playlistName: payload.playlist_name,
      musicName: payload.music_name,
      musicUrl: payload.music_url,
      startMs: payload.start_ms,
      endMs: payload.end_ms,
      ...traceAppSnapshotPayload(actor.getSnapshot()),
    });
    send(nowPlayingTrackChanged.load(payload));
  })
    .then((unlisten) => {
      unsubscribeNowPlayingTrackChanged = unlisten;
    })
    .catch((error) => {
      console.error("Failed to subscribe to now playing track changes", error);
    });
}

function attachPlaybackDiagnosticTraceListener() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return;
  }

  void listenPlaybackDiagnosticTrace((payload) => {
    recordRenderPerformanceTrace(payload.event, {
      playlistName: payload.playlist_name,
      musicName: payload.music_name,
      musicUrl: payload.music_url,
      startMs: payload.start_ms,
      endMs: payload.end_ms,
      elapsedMs: payload.elapsed_ms,
      candidateCount: payload.candidate_count,
      queueCount: payload.queue_count,
      status: payload.status,
      error: payload.error,
      details: payload.details,
    });
  })
    .then((unlisten) => {
      unsubscribePlaybackDiagnosticTrace = unlisten;
    })
    .catch((error) => {
      console.error("Failed to subscribe to playback diagnostic trace", error);
    });
}

function attachPlaybackExcludeCommittedListener() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return;
  }

  void listenPlaybackExcludeCommitted((payload) => {
    send(excludeAdded.load(createOptimisticExcludeAddedChange(payload.exclude)));
  })
    .then((unlisten) => {
      unsubscribePlaybackExcludeCommitted = unlisten;
    })
    .catch((error) => {
      console.error("Failed to subscribe to playback exclude commit events", error);
    });
}

export const action = {
  run: () => {
    ensureStarted();
    const snapshot = actor.getSnapshot();
    if (shouldExitSpectrumPlaybackScopeForSnapshot(snapshot)) {
      requestExitSpectrumPlaybackScope(snapshot.context.spectrumPlaybackScopeId);
    }
    if (shouldStopPlaybackForSnapshot(snapshot)) {
      requestPlaybackStop();
    }
    actor.send(sig.mainx.run);
  },
  openCreate: (playlistName?: string) => {
    ensureStarted();
    pasteDownloadAction.reset();
    const snapshot = actor.getSnapshot();
    if (shouldExitSpectrumPlaybackScopeForSnapshot(snapshot)) {
      requestExitSpectrumPlaybackScope(snapshot.context.spectrumPlaybackScopeId);
    }
    if (shouldStopPlaybackForSnapshot(snapshot)) {
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
    const snapshot = actor.getSnapshot();
    if (shouldExitSpectrumPlaybackScopeForSnapshot(snapshot)) {
      requestExitSpectrumPlaybackScope(snapshot.context.spectrumPlaybackScopeId);
    }
    if (shouldStopPlaybackForSnapshot(snapshot)) {
      requestPlaybackStop();
    }
    send(openPlaylist.load(playlistName));
  },
  playPlaylist: (playlistName: string) => {
    ensureStarted();
    const actionStartedAt = currentPerformanceNow();
    pasteDownloadAction.reset();
    const snapshot = actor.getSnapshot();
    recordRenderPerformanceTrace("playlist-play-action-start", {
      playlistName,
      state: formatStateValue(snapshot.value),
      playingPlaylistName: snapshot.context.playingPlaylistName,
      shouldToggleStop:
        snapshot.value === "play" && snapshot.context.playingPlaylistName === playlistName,
    });
    if (snapshot.value === "play" && snapshot.context.playingPlaylistName === playlistName) {
      if (shouldExitSpectrumPlaybackScopeForSnapshot(snapshot)) {
        requestExitSpectrumPlaybackScope(snapshot.context.spectrumPlaybackScopeId);
      }
      requestPlaybackStop();
      actor.send(sig.mainx.back);
      recordRenderPerformanceTrace("playlist-play-action-stop-current", {
        playlistName,
        elapsedMs: currentPerformanceNow() - actionStartedAt,
      });
      return;
    }

    if (shouldExitSpectrumPlaybackScopeForSnapshot(snapshot)) {
      requestExitSpectrumPlaybackScope(snapshot.context.spectrumPlaybackScopeId);
    }
    if (snapshot.value !== "ready" && snapshot.value !== "play") {
      recordRenderPerformanceTrace("playlist-play-action-rejected-state", {
        playlistName,
        elapsedMs: currentPerformanceNow() - actionStartedAt,
        state: formatStateValue(snapshot.value),
      });
      return;
    }

    if (snapshot.value === "ready") {
      const previewDraft = snapshot.context.pendingPlaylistPreview?.playlist.name === playlistName;
      if (previewDraft) {
        send(playPlaylist.load(playlistName));
        recordRenderPerformanceTrace("playlist-play-action-preview-sent", {
          playlistName,
          elapsedMs: currentPerformanceNow() - actionStartedAt,
        });
        return;
      }
    }

    send(playPlaylist.load(playlistName));
    void startPlaylistPlaybackFromAction(playlistName)
      .then((session) => {
        recordRenderPerformanceTrace("playlist-play-action-finished", {
          playlistName,
          elapsedMs: currentPerformanceNow() - actionStartedAt,
          status: session?.status ?? "not_started",
          trackCount: session?.track_count ?? 0,
        });
      })
      .catch((error) => {
        recordRenderPerformanceTrace("playlist-play-action-error", {
          playlistName,
          elapsedMs: currentPerformanceNow() - actionStartedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        console.error("Failed to start playlist playback", error);
      });
  },
  excludeCurrentMusicAndSkip: () => {
    ensureStarted();
    const snapshot = actor.getSnapshot();
    if (
      snapshot.value !== "play" ||
      snapshot.context.playingPlaylistName === null ||
      snapshot.context.nowPlayingTrackUrl === null ||
      snapshot.context.nowPlayingTrackStartMs === null ||
      snapshot.context.nowPlayingTrackEndMs === null
    ) {
      return;
    }

    requestExcludeCurrentMusicAndSkip(snapshot);
  },
  setCurrentMusicLiked: (liked: boolean) => {
    ensureStarted();
    const snapshot = actor.getSnapshot();
    if (
      snapshot.value !== "play" ||
      snapshot.context.playingPlaylistName === null ||
      snapshot.context.nowPlayingTrackUrl === null ||
      snapshot.context.nowPlayingTrackStartMs === null ||
      snapshot.context.nowPlayingTrackEndMs === null
    ) {
      return;
    }

    requestSetCurrentPlaybackMusicLiked(liked);
  },
  openSpectrum: () => {
    ensureStarted();
    const snapshot = actor.getSnapshot();
    recordRenderPerformanceTrace("spectrum-open-action", traceAppSnapshotPayload(snapshot));

    if (snapshot.value !== "play") {
      recordRenderPerformanceTrace("spectrum-open-rejected-state", {
        reason: "requires_play_state",
        ...traceAppSnapshotPayload(snapshot),
      });
      return;
    }

    return openSpectrumAfterPlaybackMode(snapshot).catch((error) => {
      console.error("Failed to enter spectrum playback mode", error);
    });
  },
  back: () => {
    ensureStarted();
    const snapshot = actor.getSnapshot();
    recordRenderPerformanceTrace("app-back-action", traceAppSnapshotPayload(snapshot));
    if (shouldCommitSpectrumMusicForSnapshot(snapshot)) {
      requestSpectrumMusicCommit(snapshot);
    }
    if (shouldExitSpectrumPlaybackScopeForSnapshot(snapshot)) {
      requestRestorePlaybackPageModeBeforeBackFromSpectrum(snapshot);
    }
    if (shouldStopPlaybackForSnapshot(snapshot)) {
      requestPlaybackStop();
    }
    actor.send(sig.mainx.back);
    recordRenderPerformanceTrace("app-back-sent", {
      source: traceAppSnapshotPayload(snapshot),
      current: traceAppSnapshotPayload(actor.getSnapshot()),
    });
  },
  changeDraftName: (name: string) => {
    ensureStarted();
    send(draftNameChanged.load(name));
  },
  changeSpectrumMusicName: (input: { id: string; name: string }) => {
    ensureStarted();
    send(spectrumMusicNameChanged.load(input));
  },
  changeSpectrumMusicRange: (range: {
    endMs: number | null;
    id: string;
    startMs: number | null;
  }) => {
    ensureStarted();
    send(spectrumMusicRangeChanged.load(range));
  },
  resetSpectrumMusicDraft: (id: string) => {
    ensureStarted();
    send(spectrumMusicDraftReset.load({ id }));
  },
  deleteSpectrumMusic: (id: string) => {
    ensureStarted();
    send(spectrumMusicDeleted.load({ id }));
  },
  startSpectrumMusicCreate: (id: string) => {
    ensureStarted();
    send(spectrumMusicCreateStarted.load({ id }));
  },
  changeSavePath: async (savePath: string) => {
    ensureStarted();
    try {
      send(savePathChanged.load(await persistSavePath(savePath)));
      return true;
    } catch (error) {
      console.error("Failed to persist the selected save path", error);
      return false;
    }
  },
  chooseSavePath: async (currentSavePath: string) => {
    ensureStarted();
    try {
      const selectedPath = await chooseSavePath(currentSavePath);
      if (!selectedPath) {
        return false;
      }

      return action.changeSavePath(selectedPath);
    } catch (error) {
      console.error("Failed to choose a save path", error);
      return false;
    }
  },
  importLocalCollection: async (currentSavePath: string) => {
    ensureStarted();
    try {
      const selectedPath = await chooseCollectionFolder(currentSavePath);
      if (!selectedPath) {
        return false;
      }

      const collectionShell = await createLocalCollectionShell(selectedPath);
      send(collectionUpserted.load(collectionShell));
      send(draftCollectionUpserted.load(collectionShell));

      void importLocalCollection(selectedPath).then(
        (collection) => {
          send(collectionUpserted.load(collection));
          send(draftCollectionUpserted.load(collection));
        },
        (error) => {
          console.error("Failed to import local collection", error);
          send(
            draftItemRemoved.load({
              kind: "collection",
              url: collectionShell.url,
            }),
          );
        },
      );
      return true;
    } catch (error) {
      console.error("Failed to import local collection", error);
      return false;
    }
  },
  upsertCollection: (collection: ActorSnapshot["context"]["collections"][number]) => {
    ensureStarted();
    send(collectionUpserted.load(collection));
  },
  upsertPlaylist: (payload: PlaylistUpsertResult) => {
    ensureStarted();
    send(playlistUpserted.load(payload));
  },
  deletePlaylist: async (playlistName: string) => {
    ensureStarted();
    try {
      await deletePlaylistRecord(playlistName);
      send(playlistDeleted.load(playlistName));
      return true;
    } catch (error) {
      console.error("Failed to delete playlist", {
        playlistName,
        error,
      });
      return false;
    }
  },
  previewPlaylist: (payload: PlaylistPreview | null) => {
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
  removeDraftExtra: (music: Music) => {
    ensureStarted();
    send(draftExtraRemoved.load(music));
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
  removeExclude: async (
    music: ActorSnapshot["context"]["configLibrary"]["excludes"][number]["music"],
  ) => {
    ensureStarted();
    try {
      send(
        excludeRemoved.load(
          await removeExclude({
            music,
            excludeAvailability: actor.getSnapshot().context.configLibrary.exclude_availability,
          }),
        ),
      );
      return true;
    } catch (error) {
      console.error("Failed to remove excluded music", error);
      return false;
    }
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
  attachPlaybackDiagnosticTraceListener();
  attachPlaybackExcludeCommittedListener();
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
  unsubscribePlaybackDiagnosticTrace?.();
  unsubscribePlaybackDiagnosticTrace = null;
  unsubscribePlaybackExcludeCommitted?.();
  unsubscribePlaybackExcludeCommitted = null;
  started = false;
  lastPlayableIndexReadyState = false;
  playlistPlaybackStartEpoch += 1;
  resetRuntimeActor();
}

export function ensureAppLogicStarted() {
  if (started) {
    return;
  }

  ensureStarted();
  actor.send(sig.mainx.run);
}
