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
  listenDownloadTaskChanged,
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
  playlistPlaybackStopped,
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
  createSpectrumMusicCommitPlan,
  createUnexpectedSpectrumMusicCommitFailure,
  hasSpectrumMusicCommitOperations,
  runSpectrumMusicCommitTransaction,
} from "./spectrumMusicCommitTransaction";
import {
  runSpectrumOpenTransaction,
  type SpectrumOpenSourceIdentity,
} from "./spectrumOpenTransaction";
import { createPlaybackContinuationModeEffectOwner } from "./playbackContinuationModeEffectOwner";
import {
  runPlaybackExcludeTransaction,
  type PlaybackExcludeProjection,
} from "./playbackExcludeTransaction";
import {
  resolveSpectrumExitPlaybackModeEffects,
  shouldCommitSpectrumPlaybackScopeExit,
  type PlaybackModeEffect,
} from "./playbackMode";
import { recordTrace } from "@/src/debug/renderPerformanceTrace";
export { actor } from "./runtime";

type ActorSnapshot = ReturnType<(typeof actor)["getSnapshot"]>;
interface PlaylistPlayableIndexCommittedSignal {
  candidateCount: number;
  playlistName: string;
}
const selectMainState = me.select(
  (shot: { value: unknown }) => shot.value as MainStateT,
  me.eq.strict<MainStateT>(),
);
const selectContext = me.select((shot: { context: ActorSnapshot["context"] }) => shot.context);

let started = false;
let unsubscribeDebug: (() => void) | null = null;
let unsubscribeNowPlayingTrackChanged: (() => void) | null = null;
let unsubscribeDownloadTaskChanged: (() => void) | null = null;
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

interface SpectrumOpenProjection extends SpectrumOpenSourceIdentity {
  nowPlayingTrackName: string | null;
  pendingPlaylistPlaybackName: string | null;
  spectrumPlaybackScopeId: number | null;
}

function createSpectrumOpenProjection(snapshot: ActorSnapshot): SpectrumOpenProjection {
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
  recordTrace("app-state-initial", traceAppSnapshotPayload(initialSnapshot));

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

    recordTrace("app-state-changed", {
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
  await runPlaybackExcludeTransaction({
    source: createPlaybackExcludeProjection(snapshot),
    runtime: {
      excludeCurrentMusicAndSkip,
      getCurrentProjection: () => createPlaybackExcludeProjection(actor.getSnapshot()),
    },
    sink: {
      backOutOfPlay: () => actor.send(sig.mainx.back),
      excludeAdded: (change) => send(excludeAdded.load(change)),
      playlistDeleted: (playlistName) => send(playlistDeleted.load(playlistName)),
    },
    trace: {
      started: (source) =>
        recordTrace("playback-exclude-skip-start", { ...source }),
      rejected: ({ reason, source }) =>
        recordTrace("playback-exclude-skip-rejected", {
          reason,
          source,
        }),
      committed: ({ current, result, source }) =>
        recordTrace("playback-exclude-skip-committed", {
          current,
          source,
          result,
        }),
    },
  });
}

function createPlaybackExcludeProjection(snapshot: ActorSnapshot): PlaybackExcludeProjection {
  return {
    state: formatStateValue(snapshot.value),
    playingPlaylistName: snapshot.context.playingPlaylistName,
  };
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

function toPlaylistPlaybackErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sendPlaylistPlaybackErrorStop(args: {
  error: unknown;
  playlistName: string;
  requestId: number;
}) {
  send(
    playlistPlaybackStopped.load({
      error: toPlaylistPlaybackErrorMessage(args.error),
      playlistName: args.playlistName,
      reason: "error",
      requestId: args.requestId,
      session: null,
    }),
  );
}

function isCurrentPlaylistPlaybackRequest(playlistName: string, requestId: number) {
  const snapshot = actor.getSnapshot();
  const request = snapshot.context.pendingPlaylistPlaybackRequest;
  return (
    request?.playlistName === playlistName &&
    request.requestId === requestId &&
    request.phase !== "failed"
  );
}

function playbackTraceDetailValue(
  details: readonly { key: string; value: string }[] | null,
  key: string,
) {
  return details?.find((detail) => detail.key === key)?.value ?? null;
}

function createPlayableIndexCommittedSignalFromTrace(args: {
  candidateCount: number | null;
  details: readonly { key: string; value: string }[] | null;
  event: string;
  playlistName: string | null;
}): PlaylistPlayableIndexCommittedSignal | null {
  const candidateCount = args.candidateCount ?? 0;
  if (
    args.event !== "playlist-playable-index-refresh-ok" ||
    playbackTraceDetailValue(args.details, "committed") !== "true" ||
    candidateCount <= 0 ||
    args.playlistName === null
  ) {
    return null;
  }

  return {
    candidateCount,
    playlistName: args.playlistName,
  };
}

async function startPlaylistPlaybackFromAction(args: {
  actionStartedAt: number;
  playlistName: string;
  requestId: number;
  trigger?: "user";
}) {
  const { playlistName, requestId } = args;

  if (!isCurrentPlaylistPlaybackRequest(playlistName, requestId)) {
    recordTrace("playlist-play-action-backend-skipped-stale-request", {
      playlistName,
      requestId,
      trigger: args.trigger ?? "user",
      elapsedMs: currentPerformanceNow() - args.actionStartedAt,
    });
    return null;
  }

  recordTrace("playlist-play-action-backend-start", {
    api: "crab.playPlaylist",
    frontendInvoker: "invoker.playPlaylist.__src__",
    playlistName,
    requestId,
    trigger: args.trigger ?? "user",
    elapsedMs: currentPerformanceNow() - args.actionStartedAt,
  });

  const result = await invoker.playPlaylist.__src__({ playlistName });

  if (requestId !== playlistPlaybackStartEpoch) {
    recordTrace("playlist-play-action-stale-result", {
      playlistName,
      requestId,
      currentEpoch: playlistPlaybackStartEpoch,
      trigger: args.trigger ?? "user",
      status: result.session.status,
      result: result.kind,
      trackCount: result.session.track_count,
    });
    send(
      playlistPlaybackStopped.load({
        error: "stale playlist playback result",
        playlistName,
        reason: "stale",
        requestId,
        session: null,
      }),
    );
    return result;
  }

  if (result.kind === "Stops") {
    send(
      playlistPlaybackStopped.load({
        error: null,
        playlistName,
        reason: result.reason,
        requestId,
        session: result.session,
      }),
    );
    recordTrace("playlist-play-action-stopped-result", {
      playlistName,
      requestId,
      trigger: args.trigger ?? "user",
      reason: result.reason,
      status: result.session.status,
      trackCount: result.session.track_count,
    });
    return result;
  }

  send(playlistPlaybackAccepted.load({ playlistName, requestId, session: result.session }));
  return result;
}

async function applyPlaybackModeEffect(effect: PlaybackModeEffect) {
  if (effect.kind === "enterSpectrumPlaybackScope") {
    recordTrace("app-playback-mode-effect-start", {
      effect: effect.kind,
      ...traceAppSnapshotPayload(actor.getSnapshot()),
    });
    const scopeId = await enterSpectrumPlaybackScope();
    send(spectrumPlaybackScopeChanged.load(scopeId));
    recordTrace("app-playback-mode-effect-finished", {
      effect: effect.kind,
      scopeId,
      ...traceAppSnapshotPayload(actor.getSnapshot()),
    });
    return;
  }

  if (effect.kind === "exitSpectrumPlaybackScope") {
    recordTrace("app-playback-mode-effect-start", {
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
    recordTrace("app-playback-mode-effect-finished", {
      effect: effect.kind,
      requestedScopeId: effect.scopeId,
      committed: shouldCommitExit,
      ...traceAppSnapshotPayload(actor.getSnapshot()),
    });
    return;
  }

  if (effect.kind === "setPlaybackContinuationMode") {
    recordTrace("app-playback-mode-effect-start", {
      effect: effect.kind,
      mode: effect.mode,
      ...traceAppSnapshotPayload(actor.getSnapshot()),
    });
    await playbackContinuationModeEffectOwner.request(effect.mode);
    recordTrace("app-playback-mode-effect-finished", {
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

async function openSpectrumAfterPlaybackMode(sourceSnapshot: ActorSnapshot) {
  await runSpectrumOpenTransaction({
    source: createSpectrumOpenProjection(sourceSnapshot),
    runtime: {
      applyPlaybackModeEffect,
      enterSpectrumPlaybackScope,
      getCurrentProjection: () => createSpectrumOpenProjection(actor.getSnapshot()),
    },
    sink: {
      openSpectrum: () => actor.send(sig.mainx.openspectrum),
      scopeChanged: (scopeId) => send(spectrumPlaybackScopeChanged.load(scopeId)),
    },
    trace: {
      started: (source) => recordTrace("spectrum-open-flow-start", { ...source }),
      scopeEnterStarted: (current) =>
        recordTrace("spectrum-open-scope-enter-start", { ...current }),
      scopeEntered: ({ openedScopeId, current }) =>
        recordTrace("spectrum-open-scope-entered", {
          openedScopeId,
          ...current,
        }),
      rejectedStaleSource: ({ openedScopeId, source, current }) =>
        recordTrace("spectrum-open-rejected-stale-source", {
          openedScopeId,
          source,
          current,
        }),
      committed: ({ openedScopeId, current }) =>
        recordTrace("spectrum-open-committed", {
          openedScopeId,
          ...current,
        }),
    },
  });
}

async function restorePlaybackPageModeBeforeBackFromSpectrum(snapshot: ActorSnapshot) {
  const effects = resolveSpectrumExitPlaybackModeEffects(snapshot.context.spectrumPlaybackScopeId);

  recordTrace(
    "spectrum-back-restore-mode-start",
    traceAppSnapshotPayload(snapshot),
  );
  await applyPlaybackModeEffects(effects);
  recordTrace("spectrum-back-restore-mode-finished", {
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
  const plan = createSpectrumMusicCommitPlan({
    drafts: snapshot.context.spectrumMusicDrafts,
    epoch: snapshot.context.spectrumMusicCommitEpoch + 1,
  });

  void runSpectrumMusicCommitTransaction({
    plan,
    runtime: {
      createMusics: (inputs) => invoker.createMusics.__src__(inputs),
      deleteMusics: (inputs) => invoker.deleteMusics.__src__(inputs),
      updateMusics: (inputs) => invoker.updateMusics.__src__(inputs),
    },
    sink: {
      failed: (failure) => send(spectrumMusicCommitFailed.load(failure)),
      created: (commit) => send(spectrumMusicCreatesCommitted.load(commit)),
      deleted: (commit) => send(spectrumMusicDeletesCommitted.load(commit)),
      updated: (commit) => send(spectrumMusicUpdatesCommitted.load(commit)),
    },
    trace: {
      requested: (input) => recordTrace("spectrum-music-commit-requested", input),
      failed: (failure) => recordTrace("spectrum-music-commit-error", failure),
      finished: (input) => {
        try {
          recordTrace("spectrum-music-commit-finished", input);
        } catch (error) {
          console.error("Failed to record spectrum music commit completion", error);
        }
      },
    },
  }).catch((error) => {
    const failure = createUnexpectedSpectrumMusicCommitFailure({
      epoch: plan.epoch,
      error,
    });
    recordTrace("spectrum-music-commit-error", failure);
    send(spectrumMusicCommitFailed.load(failure));
  });
}

function shouldCommitSpectrumMusicForSnapshot(snapshot: ActorSnapshot) {
  return (
    snapshot.value === "spectrum" &&
    hasSpectrumMusicCommitOperations(snapshot.context.spectrumMusicDrafts)
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
    recordTrace("player-now-playing-event-received", {
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

function attachDownloadTaskChangeListener() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return;
  }

  void listenDownloadTaskChanged((payload) => {
    recordTrace("download-task-change-event-received", {
      taskId: payload.task_id,
      taskUrl: payload.task_url,
      collectionUrl: payload.collection_url,
      collectionName: payload.collection_name,
      status: payload.status,
      ...traceAppSnapshotPayload(actor.getSnapshot()),
    });
  })
    .then((unlisten) => {
      unsubscribeDownloadTaskChanged = unlisten;
    })
    .catch((error) => {
      console.error("Failed to subscribe to download task changes", error);
    });
}

function attachPlaybackDiagnosticTraceListener() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return;
  }

  void listenPlaybackDiagnosticTrace((payload) => {
    recordTrace(payload.event, {
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
    const playableIndexCommittedSignal = createPlayableIndexCommittedSignalFromTrace({
      candidateCount: payload.candidate_count,
      details: payload.details,
      event: payload.event,
      playlistName: payload.playlist_name,
    });
    if (playableIndexCommittedSignal) {
      recordTrace("playlist-playable-index-first-slot-committed", {
        candidateCount: playableIndexCommittedSignal.candidateCount,
        playlistName: playableIndexCommittedSignal.playlistName,
      });
    }
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
    send(
      excludeAdded.load({
        exclude: payload.exclude,
        excludeAvailability: payload.exclude_availability,
      }),
    );
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
    recordTrace("playlist-play-action-start", {
      api: "appLogicAction.playPlaylist",
      playlistName,
      state: formatStateValue(snapshot.value),
      playingPlaylistName: snapshot.context.playingPlaylistName,
      pendingPlaylistPreviewName: snapshot.context.pendingPlaylistPreview?.playlist.name ?? null,
      pendingPlaylistPlaybackPhase:
        snapshot.context.pendingPlaylistPlaybackRequest?.phase ?? null,
      pendingPlaylistPlaybackName:
        snapshot.context.pendingPlaylistPlaybackRequest?.playlistName ?? null,
      shouldToggleStop:
        snapshot.value === "play" && snapshot.context.playingPlaylistName === playlistName,
    });
    if (snapshot.value === "play" && snapshot.context.playingPlaylistName === playlistName) {
      if (shouldExitSpectrumPlaybackScopeForSnapshot(snapshot)) {
        requestExitSpectrumPlaybackScope(snapshot.context.spectrumPlaybackScopeId);
      }
      requestPlaybackStop();
      actor.send(sig.mainx.back);
      recordTrace("playlist-play-action-stop-current", {
        playlistName,
        elapsedMs: currentPerformanceNow() - actionStartedAt,
      });
      return;
    }

    if (shouldExitSpectrumPlaybackScopeForSnapshot(snapshot)) {
      requestExitSpectrumPlaybackScope(snapshot.context.spectrumPlaybackScopeId);
    }
    if (snapshot.value !== "ready" && snapshot.value !== "play") {
      recordTrace("playlist-play-action-rejected-state", {
        playlistName,
        elapsedMs: currentPerformanceNow() - actionStartedAt,
        state: formatStateValue(snapshot.value),
      });
      return;
    }

    const requestId = ++playlistPlaybackStartEpoch;
    send(playPlaylist.load({ playlistName, requestId }));
    void startPlaylistPlaybackFromAction({
      actionStartedAt,
      playlistName,
      requestId,
    })
      .then((session) => {
        if (!session) {
          recordTrace("playlist-play-action-finished-stale", {
            playlistName,
            requestId,
            elapsedMs: currentPerformanceNow() - actionStartedAt,
          });
          return;
        }

        recordTrace("playlist-play-action-finished", {
          playlistName,
          requestId,
          elapsedMs: currentPerformanceNow() - actionStartedAt,
          result: session.kind,
          status: session.session.status,
          trackCount: session.session.track_count,
        });
      })
      .catch((error) => {
        const errorMessage = toPlaylistPlaybackErrorMessage(error);
        sendPlaylistPlaybackErrorStop({ error, playlistName, requestId });
        recordTrace("playlist-play-action-error", {
          playlistName,
          requestId,
          elapsedMs: currentPerformanceNow() - actionStartedAt,
          error: errorMessage,
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
    recordTrace("spectrum-open-action", traceAppSnapshotPayload(snapshot));

    if (snapshot.value !== "play") {
      recordTrace("spectrum-open-rejected-state", {
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
    recordTrace("app-back-action", traceAppSnapshotPayload(snapshot));
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
    recordTrace("app-back-sent", {
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
  attachDownloadTaskChangeListener();
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
  unsubscribeDownloadTaskChanged?.();
  unsubscribeDownloadTaskChanged = null;
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
