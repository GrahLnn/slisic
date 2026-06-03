import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { Err, Ok } from "@grahlnn/fn";
import { createActor } from "xstate";
import type { PlayListListView, PlayListWriteRequest } from "@/src/cmd";
import { crab } from "@/src/cmd";
import { actor as appLogicActor, playlistUpserted, resetRuntimeActor } from "../appLogic/runtime";
import { resolvePlaylistDraftCommit } from "../appLogic/core";
import {
  createPlaylistCommitFrame,
  createPlaylistCommitSubmission,
  reflectPlaylistCommitEvidence,
} from "./core";
import { createPlaylistCommitCompletion, resetPlaylistCommitCompletions } from "./completion";
import { machine } from "./machine";
import { payloads, ss } from "./events";

const originalUpsertPlaylist = crab.upsertPlaylist;

function setUpsertPlaylistMock(mock: typeof crab.upsertPlaylist) {
  (crab as { upsertPlaylist: typeof crab.upsertPlaylist }).upsertPlaylist = mock;
}

function createPlaylistSurface(name: string): PlayListListView {
  return {
    name,
    created_at: "2026-04-18T00:00:00Z",
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return {
    promise,
    resolve,
  };
}

async function nextMicrotask() {
  await Promise.resolve();
}

type ActorRef = ReturnType<typeof createActor>;

function waitForState(actor: ActorRef, expected: string, timeoutMs = 1000) {
  return new Promise<void>((resolve, reject) => {
    if (actor.getSnapshot().value === expected) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      subscription.unsubscribe();
      reject(new Error(`Timed out waiting for state ${expected}`));
    }, timeoutMs);

    const subscription = actor.subscribe((snapshot) => {
      if (snapshot.value !== expected) {
        return;
      }

      clearTimeout(timer);
      subscription.unsubscribe();
      resolve();
    });
  });
}

function waitForContext(
  actor: ActorRef,
  predicate: (context: unknown) => boolean,
  timeoutMs = 1000,
) {
  return new Promise<void>((resolve, reject) => {
    if (predicate(actor.getSnapshot().context)) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      subscription.unsubscribe();
      reject(new Error("Timed out waiting for context update"));
    }, timeoutMs);

    const subscription = actor.subscribe((snapshot) => {
      if (!predicate(snapshot.context)) {
        return;
      }

      clearTimeout(timer);
      subscription.unsubscribe();
      resolve();
    });
  });
}

afterEach(() => {
  setUpsertPlaylistMock(originalUpsertPlaylist);
  resetPlaylistCommitCompletions(new Error("test cleanup"));
  appLogicActor.stop();
  resetRuntimeActor();
});

describe("playlistCommit machine", () => {
  test("rejects persistence evidence that does not match the commit frame baseline", () => {
    const request = resolvePlaylistDraftCommit({
      draft: {
        mode: "create",
        name: "Frame Draft",
        collections: [],
        groups: [],
        extra: [],
        createdAt: null,
      },
      draftBaseline: null,
      playlists: [],
    });
    const frame = createPlaylistCommitFrame(createPlaylistCommitSubmission(request), 0);

    const reflection = reflectPlaylistCommitEvidence(frame, {
      playlist: createPlaylistSurface("Other Draft"),
      previousName: null,
    });

    assert.equal(reflection.kind, "Reject");
  });

  test("closes persistence evidence when its commit frame is gone", () => {
    const reflection = reflectPlaylistCommitEvidence(null, {
      playlist: createPlaylistSurface("Late Draft"),
      previousName: null,
    });

    assert.deepEqual(reflection, {
      frameId: null,
      kind: "Stops",
      reason: "closed-frame",
    });
  });

  test("publishes preview before persistence and upserts the stable playlist after success", async () => {
    const gate = deferred();
    const committedPlaylist = createPlaylistSurface("New Draft");
    const persistRequests: PlayListWriteRequest[] = [];

    setUpsertPlaylistMock(async (previousName, playlist) => {
      assert.equal(previousName, null);
      persistRequests.push(playlist);
      await gate.promise;
      return Ok(committedPlaylist);
    });

    resetRuntimeActor();
    appLogicActor.start();
    const actor = createActor(machine);

    try {
      actor.start();
      actor.send(
        payloads["playlist.commit.requested"].load(
          createPlaylistCommitSubmission(
            resolvePlaylistDraftCommit({
              draft: {
                mode: "create",
                name: "New Draft",
                collections: [],
                groups: [],
                extra: [],
                createdAt: null,
              },
              draftBaseline: null,
              playlists: [],
            }),
          ),
        ),
      );

      await waitForState(actor, ss.mainx.State.submitting);
      assert.deepEqual(appLogicActor.getSnapshot().context.pendingPlaylistPreview, {
        playlist: {
          name: "New Draft",
          created_at: null,
        },
        previousName: null,
        draft: {
          mode: "create",
          name: "New Draft",
          collections: [],
          groups: [],
          extra: [],
          createdAt: null,
        },
      });
      assert.equal(persistRequests.length, 1);

      gate.resolve();
      await waitForState(actor, ss.mainx.State.idle);
      await waitForContext(
        appLogicActor,
        (context) =>
          !!context &&
          typeof context === "object" &&
          "pendingPlaylistPreview" in context &&
          context.pendingPlaylistPreview === null &&
          "playlists" in context &&
          Array.isArray(context.playlists) &&
          context.playlists.some((playlist) => playlist?.name === "New Draft"),
      );

      assert.deepEqual(appLogicActor.getSnapshot().context.playlists, [committedPlaylist]);
      assert.equal(appLogicActor.getSnapshot().context.pendingPlaylistPreview, null);
    } finally {
      actor.stop();
    }
  });

  test("resolves commit completion only after matching persistence evidence is accepted", async () => {
    const gate = deferred();
    const committedPlaylist = createPlaylistSurface("Completion Draft");
    let resolved: PlayListListView | null = null;

    setUpsertPlaylistMock(async () => {
      await gate.promise;
      return Ok(committedPlaylist);
    });

    resetRuntimeActor();
    appLogicActor.start();
    const actor = createActor(machine);

    try {
      actor.start();
      const request = resolvePlaylistDraftCommit({
        draft: {
          mode: "create",
          name: "Completion Draft",
          collections: [],
          groups: [],
          extra: [],
          createdAt: null,
        },
        draftBaseline: null,
        playlists: [],
      });
      const completion = new Promise<void>((resolve, reject) => {
        const completionId = createPlaylistCommitCompletion({
          reject,
          resolve: (result) => {
            resolved = result.playlist;
            resolve();
          },
        });
        actor.send(
          payloads["playlist.commit.requested"].load(
            createPlaylistCommitSubmission(request, completionId),
          ),
        );
      });

      await waitForState(actor, ss.mainx.State.submitting);
      await nextMicrotask();
      assert.equal(resolved, null);

      gate.resolve();
      await completion;

      assert.deepEqual(resolved, committedPlaylist);
      assert.deepEqual(appLogicActor.getSnapshot().context.playlists, [committedPlaylist]);
    } finally {
      actor.stop();
    }
  });

  test("does not resolve commit completion from an existing playlist with the same name", async () => {
    const gate = deferred();
    const existingPlaylist = createPlaylistSurface("Existing Draft");
    const committedPlaylist = {
      ...createPlaylistSurface("Existing Draft"),
      created_at: "2026-04-19T00:00:00Z",
    };
    let didResolve = false;

    setUpsertPlaylistMock(async () => {
      await gate.promise;
      return Ok(committedPlaylist);
    });

    resetRuntimeActor();
    appLogicActor.start();
    appLogicActor.send(
      playlistUpserted.load({
        playlist: existingPlaylist,
        previousName: null,
      }),
    );
    const actor = createActor(machine);

    try {
      actor.start();
      const request = resolvePlaylistDraftCommit({
        draft: {
          mode: "edit",
          name: "Existing Draft",
          collections: [],
          groups: [],
          extra: [],
          createdAt: existingPlaylist.created_at,
        },
        draftBaseline: {
          mode: "edit",
          name: "Existing Draft",
          collections: [],
          groups: [],
          extra: [],
          createdAt: existingPlaylist.created_at,
        },
        playlists: [existingPlaylist],
      });
      const completion = new Promise<void>((resolve, reject) => {
        const completionId = createPlaylistCommitCompletion({
          reject,
          resolve: () => {
            didResolve = true;
            resolve();
          },
        });
        actor.send(
          payloads["playlist.commit.requested"].load(
            createPlaylistCommitSubmission(request, completionId),
          ),
        );
      });

      await waitForState(actor, ss.mainx.State.submitting);
      await nextMicrotask();
      assert.equal(didResolve, false);

      gate.resolve();
      await completion;

      assert.equal(didResolve, true);
      assert.deepEqual(appLogicActor.getSnapshot().context.playlists, [committedPlaylist]);
    } finally {
      actor.stop();
    }
  });

  test("removes the preview after a failed background commit", async () => {
    setUpsertPlaylistMock(async () => Err("playlist commit failed"));

    resetRuntimeActor();
    appLogicActor.start();
    const actor = createActor(machine);

    try {
      actor.start();
      actor.send(
        payloads["playlist.commit.requested"].load(
          createPlaylistCommitSubmission(
            resolvePlaylistDraftCommit({
              draft: {
                mode: "create",
                name: "Failed Draft",
                collections: [],
                groups: [],
                extra: [],
                createdAt: null,
              },
              draftBaseline: null,
              playlists: [],
            }),
          ),
        ),
      );

      await waitForState(actor, ss.mainx.State.idle);
      assert.equal(appLogicActor.getSnapshot().context.pendingPlaylistPreview, null);
      assert.deepEqual(appLogicActor.getSnapshot().context.playlists, []);
    } finally {
      actor.stop();
    }
  });

  test("rejects commit completion after a failed persistence command", async () => {
    setUpsertPlaylistMock(async () => Err("playlist commit failed"));

    resetRuntimeActor();
    appLogicActor.start();
    const actor = createActor(machine);

    try {
      actor.start();
      const request = resolvePlaylistDraftCommit({
        draft: {
          mode: "create",
          name: "Rejected Draft",
          collections: [],
          groups: [],
          extra: [],
          createdAt: null,
        },
        draftBaseline: null,
        playlists: [],
      });
      const completion = new Promise<void>((resolve, reject) => {
        const completionId = createPlaylistCommitCompletion({
          reject,
          resolve: () => resolve(),
        });
        actor.send(
          payloads["playlist.commit.requested"].load(
            createPlaylistCommitSubmission(request, completionId),
          ),
        );
      });

      await assert.rejects(completion, /playlist commit failed/);
      assert.deepEqual(appLogicActor.getSnapshot().context.playlists, []);
      assert.equal(appLogicActor.getSnapshot().context.pendingPlaylistPreview, null);
    } finally {
      actor.stop();
    }
  });

  test("does not publish playlist evidence that does not match the active commit frame", async () => {
    setUpsertPlaylistMock(async () => Ok(createPlaylistSurface("Wrong Draft")));

    resetRuntimeActor();
    appLogicActor.start();
    const actor = createActor(machine);

    try {
      actor.start();
      actor.send(
        payloads["playlist.commit.requested"].load(
          createPlaylistCommitSubmission(
            resolvePlaylistDraftCommit({
              draft: {
                mode: "create",
                name: "Expected Draft",
                collections: [],
                groups: [],
                extra: [],
                createdAt: null,
              },
              draftBaseline: null,
              playlists: [],
            }),
          ),
        ),
      );

      await waitForState(actor, ss.mainx.State.idle);

      assert.deepEqual(appLogicActor.getSnapshot().context.playlists, []);
      assert.equal(appLogicActor.getSnapshot().context.pendingPlaylistPreview, null);
    } finally {
      actor.stop();
    }
  });
});
