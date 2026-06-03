import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyPendingPlaylistPlaybackWakeupError,
  createPlaylistPlaybackPendingWakeupOwner,
  resolvePlaylistPlaybackPendingWakeupFromRequest,
  shouldWakePendingPlaylistPlaybackFromPlayableIndexCommit,
} from "./playlistPlaybackPendingWakeup";

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000) {
  if (predicate()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const startedAt = performance.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error("condition was not satisfied before timeout"));
        return;
      }
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  });
}

describe("playlist playback pending wakeup", () => {
  test("creates wakeup demand only for pending first-track preparation", () => {
    assert.deepEqual(
      resolvePlaylistPlaybackPendingWakeupFromRequest({
        actionStartedAt: 12,
        request: {
          error: null,
          phase: "preparing",
          playlistName: "Focus Session",
          reason: "pending_first_track",
          requestId: 3,
        },
      }),
      {
        kind: "wake",
        request: {
          actionStartedAt: 12,
          playlistName: "Focus Session",
          requestId: 3,
        },
      },
    );
  });

  test("rejects non-pending-first-track requests as Stops", () => {
    assert.deepEqual(
      resolvePlaylistPlaybackPendingWakeupFromRequest({
        actionStartedAt: 12,
        request: {
          error: null,
          phase: "starting",
          playlistName: "Focus Session",
          reason: null,
          requestId: 3,
        },
      }),
      {
        kind: "stop",
        reason: "not-pending-first-track",
      },
    );
    assert.deepEqual(
      resolvePlaylistPlaybackPendingWakeupFromRequest({
        actionStartedAt: 12,
        request: null,
      }),
      {
        kind: "stop",
        reason: "not-pending-first-track",
      },
    );
  });

  test("wakes pending first-track playback when its playable index source commits", () => {
    assert.equal(
      shouldWakePendingPlaylistPlaybackFromPlayableIndexCommit({
        pendingRequest: {
          error: null,
          phase: "preparing",
          playlistName: "Focus Session",
          reason: "pending_first_track",
          requestId: 3,
        },
        signal: {
          candidateCount: 2,
          playlistName: "Focus Session",
        },
      }),
      true,
    );
  });

  test("does not wake pending first-track playback from unrelated index signals", () => {
    const pendingRequest = {
      error: null,
      phase: "preparing" as const,
      playlistName: "Focus Session",
      reason: "pending_first_track",
      requestId: 3,
    };

    assert.equal(
      shouldWakePendingPlaylistPlaybackFromPlayableIndexCommit({
        pendingRequest,
        signal: {
          candidateCount: 2,
          playlistName: "Other Session",
        },
      }),
      false,
    );
    assert.equal(
      shouldWakePendingPlaylistPlaybackFromPlayableIndexCommit({
        pendingRequest,
        signal: {
          candidateCount: 0,
          playlistName: "Focus Session",
        },
      }),
      false,
    );
    assert.equal(
      shouldWakePendingPlaylistPlaybackFromPlayableIndexCommit({
        pendingRequest: {
          ...pendingRequest,
          phase: "starting",
        },
        signal: {
          candidateCount: 2,
          playlistName: "Focus Session",
        },
      }),
      false,
    );
  });

  test("classifies early no-playable wakeup errors as pending evidence", () => {
    assert.deepEqual(
      classifyPendingPlaylistPlaybackWakeupError(
        new Error("playlist `Focus Session` has no playable tracks"),
      ),
      {
        kind: "keep_pending",
        reason: "no_playable_tracks_yet",
      },
    );
    assert.deepEqual(classifyPendingPlaylistPlaybackWakeupError(new Error("transport down")), {
      kind: "fail",
    });
  });

  test("runs one wakeup for a current pending first-track request", async () => {
    const starts: string[] = [];
    const owner = createPlaylistPlaybackPendingWakeupOwner({
      currentTimeMs: () => 10,
      formatError: (error) => String(error),
      isCurrentRequest: () => true,
      reportError: () => undefined,
      sendErrorStop: () => undefined,
      startPlayback: async ({ playlistName, requestId, trigger }) => {
        starts.push(`${playlistName}:${requestId}:${trigger}`);
      },
    });

    owner.rememberPending({
      actionStartedAt: 0,
      playlistName: "Focus Session",
      requestId: 1,
    });
    owner.schedule({
      actionStartedAt: 0,
      playlistName: "Focus Session",
      requestId: 1,
    });

    await waitForCondition(() => starts.length === 1);

    assert.deepEqual(starts, ["Focus Session:1:download_task_changed"]);
  });

  test("passes the wakeup trigger through to playback", async () => {
    const starts: string[] = [];
    const owner = createPlaylistPlaybackPendingWakeupOwner({
      currentTimeMs: () => 10,
      formatError: (error) => String(error),
      isCurrentRequest: () => true,
      reportError: () => undefined,
      sendErrorStop: () => undefined,
      startPlayback: async ({ playlistName, requestId, trigger }) => {
        starts.push(`${playlistName}:${requestId}:${trigger}`);
      },
    });

    owner.rememberPending({
      actionStartedAt: 0,
      playlistName: "Focus Session",
      requestId: 1,
    });
    owner.schedule({
      actionStartedAt: 0,
      playlistName: "Focus Session",
      requestId: 1,
      trigger: "playable_index_committed",
    });

    await waitForCondition(() => starts.length === 1);

    assert.deepEqual(starts, ["Focus Session:1:playable_index_committed"]);
  });

  test("keeps pending first-track playback alive after an early no-playable retry", async () => {
    const starts: string[] = [];
    const deferred: string[] = [];
    const errors: string[] = [];
    let current = true;
    const owner = createPlaylistPlaybackPendingWakeupOwner({
      currentTimeMs: () => 10,
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
      isCurrentRequest: () => current,
      reportError: () => undefined,
      sendErrorStop: (_error, playlistName, requestId) => {
        errors.push(`${playlistName}:${requestId}`);
      },
      shouldKeepPendingAfterError: classifyPendingPlaylistPlaybackWakeupError,
      startPlayback: async ({ playlistName, requestId, trigger }) => {
        starts.push(`${playlistName}:${requestId}:${trigger}`);
        throw new Error("playlist `Focus Session` has no playable tracks");
      },
      trace: {
        deferred: ({ playlistName, requestId, trigger }) =>
          deferred.push(`${playlistName}:${requestId}:${trigger}`),
      },
    });

    owner.rememberPending({
      actionStartedAt: 0,
      playlistName: "Focus Session",
      requestId: 1,
    });
    owner.schedule({
      actionStartedAt: 0,
      playlistName: "Focus Session",
      requestId: 1,
      trigger: "playable_index_committed",
    });

    await waitForCondition(() => deferred.length === 1);

    owner.schedule({
      actionStartedAt: 0,
      playlistName: "Focus Session",
      requestId: 1,
      trigger: "download_task_changed",
    });
    await waitForCondition(() => starts.length === 2);
    current = false;

    assert.deepEqual(starts, [
      "Focus Session:1:playable_index_committed",
      "Focus Session:1:download_task_changed",
    ]);
    assert.deepEqual(deferred, ["Focus Session:1:playable_index_committed"]);
    assert.deepEqual(errors, []);
  });

  test("closes stale pending requests without starting playback", async () => {
    const starts: string[] = [];
    const cancelled: string[] = [];
    const owner = createPlaylistPlaybackPendingWakeupOwner({
      currentTimeMs: () => 10,
      formatError: (error) => String(error),
      isCurrentRequest: () => false,
      reportError: () => undefined,
      sendErrorStop: () => undefined,
      startPlayback: async ({ playlistName }) => {
        starts.push(playlistName);
      },
      trace: {
        cancelled: ({ playlistName, requestId }) => cancelled.push(`${playlistName}:${requestId}`),
      },
    });

    owner.schedule({
      actionStartedAt: 0,
      playlistName: "Focus Session",
      requestId: 1,
    });

    await waitForCondition(() => cancelled.length === 1);

    assert.deepEqual(starts, []);
    assert.deepEqual(cancelled, ["Focus Session:1"]);
  });
});
