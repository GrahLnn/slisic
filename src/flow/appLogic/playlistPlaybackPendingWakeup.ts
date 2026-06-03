export type PlaylistPlaybackPendingWakeupTrigger =
  | "download_task_changed"
  | "playable_index_committed";

export interface PlaylistPlaybackPendingWakeupRequest {
  actionStartedAt: number;
  playlistName: string;
  requestId: number;
}

export interface PlaylistPlaybackPendingWakeupCandidate {
  error: string | null;
  phase: "failed" | "preparing" | "starting";
  playlistName: string;
  reason: string | null;
  requestId: number;
}

export interface PlaylistPlayableIndexCommittedSignal {
  candidateCount: number;
  playlistName: string;
}

export type PlaylistPlaybackPendingWakeupErrorDecision =
  | {
      kind: "keep_pending";
      reason: "no_playable_tracks_yet";
    }
  | {
      kind: "fail";
    };

export type PlaylistPlaybackPendingWakeupDecision =
  | {
      kind: "wake";
      request: PlaylistPlaybackPendingWakeupRequest;
    }
  | {
      kind: "stop";
      reason: "not-pending-first-track";
    };

interface PlaylistPlaybackPendingWakeupState extends PlaylistPlaybackPendingWakeupRequest {
  inFlight: boolean;
  requested: boolean;
  trigger: PlaylistPlaybackPendingWakeupTrigger;
}

export interface PlaylistPlaybackPendingWakeupTrace {
  cancelled?(input: PlaylistPlaybackPendingWakeupRequest & { elapsedMs: number }): void;
  coalesced?(input: PlaylistPlaybackPendingWakeupRequest & { elapsedMs: number }): void;
  deferred?(
    input: PlaylistPlaybackPendingWakeupRequest & {
      elapsedMs: number;
      error: string;
      trigger: PlaylistPlaybackPendingWakeupTrigger;
    },
  ): void;
  error?(input: PlaylistPlaybackPendingWakeupRequest & { elapsedMs: number; error: string }): void;
}

export interface PlaylistPlaybackPendingWakeupRuntime {
  currentTimeMs(): number;
  formatError(error: unknown): string;
  isCurrentRequest(playlistName: string, requestId: number): boolean;
  reportError(error: unknown): void;
  sendErrorStop(error: unknown, playlistName: string, requestId: number): void;
  shouldKeepPendingAfterError?(
    error: unknown,
    request: PlaylistPlaybackPendingWakeupRequest & {
      trigger: PlaylistPlaybackPendingWakeupTrigger;
    },
  ): PlaylistPlaybackPendingWakeupErrorDecision;
  startPlayback(
    request: PlaylistPlaybackPendingWakeupRequest & {
      trigger: PlaylistPlaybackPendingWakeupTrigger;
    },
  ): Promise<unknown>;
  trace?: PlaylistPlaybackPendingWakeupTrace;
}

export function resolvePlaylistPlaybackPendingWakeupFromRequest(args: {
  actionStartedAt: number;
  request: PlaylistPlaybackPendingWakeupCandidate | null;
}): PlaylistPlaybackPendingWakeupDecision {
  if (args.request?.phase !== "preparing" || args.request.reason !== "pending_first_track") {
    return {
      kind: "stop",
      reason: "not-pending-first-track",
    };
  }

  return {
    kind: "wake",
    request: {
      actionStartedAt: args.actionStartedAt,
      playlistName: args.request.playlistName,
      requestId: args.request.requestId,
    },
  };
}

export function shouldWakePendingPlaylistPlaybackFromPlayableIndexCommit(args: {
  pendingRequest: PlaylistPlaybackPendingWakeupCandidate | null;
  signal: PlaylistPlayableIndexCommittedSignal;
}): boolean {
  if (
    args.pendingRequest?.phase !== "preparing" ||
    args.pendingRequest.reason !== "pending_first_track"
  ) {
    return false;
  }

  return (
    args.signal.candidateCount > 0 && args.signal.playlistName === args.pendingRequest.playlistName
  );
}

export function classifyPendingPlaylistPlaybackWakeupError(
  error: unknown,
): PlaylistPlaybackPendingWakeupErrorDecision {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("has no playable tracks")
    ? { kind: "keep_pending", reason: "no_playable_tracks_yet" }
    : { kind: "fail" };
}

export function createPlaylistPlaybackPendingWakeupOwner(
  runtime: PlaylistPlaybackPendingWakeupRuntime,
) {
  let wakeup: PlaylistPlaybackPendingWakeupState | null = null;

  function elapsedMs(actionStartedAt: number) {
    return runtime.currentTimeMs() - actionStartedAt;
  }

  function close(playlistName: string, requestId: number) {
    if (wakeup?.playlistName === playlistName && wakeup.requestId === requestId) {
      wakeup = null;
    }
  }

  function getActionStartedAt() {
    return wakeup?.actionStartedAt ?? null;
  }

  function rememberPending(request: PlaylistPlaybackPendingWakeupRequest) {
    if (wakeup?.playlistName === request.playlistName && wakeup.requestId === request.requestId) {
      wakeup.actionStartedAt = request.actionStartedAt;
      return;
    }

    wakeup = {
      ...request,
      inFlight: false,
      requested: false,
      trigger: "download_task_changed",
    };
  }

  function reset() {
    wakeup = null;
  }

  function cancelStale(request: PlaylistPlaybackPendingWakeupRequest) {
    close(request.playlistName, request.requestId);
    runtime.trace?.cancelled?.({
      ...request,
      elapsedMs: elapsedMs(request.actionStartedAt),
    });
  }

  async function runScheduledWakeup(current: PlaylistPlaybackPendingWakeupState) {
    while (current.requested) {
      current.requested = false;
      if (!runtime.isCurrentRequest(current.playlistName, current.requestId)) {
        cancelStale(current);
        return;
      }

      await runtime.startPlayback({
        actionStartedAt: current.actionStartedAt,
        playlistName: current.playlistName,
        requestId: current.requestId,
        trigger: current.trigger,
      });
    }

    if (wakeup?.playlistName === current.playlistName && wakeup.requestId === current.requestId) {
      wakeup.inFlight = false;
    }
  }

  function schedule(
    request: PlaylistPlaybackPendingWakeupRequest & {
      trigger?: PlaylistPlaybackPendingWakeupTrigger;
    },
  ) {
    if (!runtime.isCurrentRequest(request.playlistName, request.requestId)) {
      cancelStale(request);
      return;
    }

    rememberPending(request);

    const current = wakeup;
    if (!current) {
      return;
    }

    current.requested = true;
    current.trigger = request.trigger ?? "download_task_changed";

    if (current.inFlight) {
      runtime.trace?.coalesced?.({
        actionStartedAt: current.actionStartedAt,
        playlistName: current.playlistName,
        requestId: current.requestId,
        elapsedMs: elapsedMs(current.actionStartedAt),
      });
      return;
    }

    current.inFlight = true;
    void runScheduledWakeup(current).catch((error) => {
      const errorRequest = {
        actionStartedAt: current.actionStartedAt,
        playlistName: current.playlistName,
        requestId: current.requestId,
        trigger: current.trigger,
      };
      if (runtime.shouldKeepPendingAfterError?.(error, errorRequest).kind === "keep_pending") {
        if (
          wakeup?.playlistName === current.playlistName &&
          wakeup.requestId === current.requestId
        ) {
          wakeup.inFlight = false;
        }
        runtime.trace?.deferred?.({
          ...errorRequest,
          elapsedMs: elapsedMs(current.actionStartedAt),
          error: runtime.formatError(error),
        });
        return;
      }

      if (runtime.isCurrentRequest(current.playlistName, current.requestId)) {
        runtime.sendErrorStop(error, current.playlistName, current.requestId);
      }
      close(current.playlistName, current.requestId);
      runtime.trace?.error?.({
        actionStartedAt: current.actionStartedAt,
        playlistName: current.playlistName,
        requestId: current.requestId,
        elapsedMs: elapsedMs(current.actionStartedAt),
        error: runtime.formatError(error),
      });
      runtime.reportError(error);
    });
  }

  return {
    close,
    getActionStartedAt,
    rememberPending,
    reset,
    schedule,
  };
}
