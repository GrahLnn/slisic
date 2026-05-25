import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { Err, Ok } from "@grahlnn/fn";
import { createActor } from "xstate";
import type { PlayList, PlayListListView } from "@/src/cmd";
import { crab } from "@/src/cmd";
import { actor as appLogicActor, resetRuntimeActor } from "../appLogic/runtime";
import { resolvePlaylistDraftCommit } from "../appLogic/core";
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
  appLogicActor.stop();
  resetRuntimeActor();
});

describe("playlistCommit machine", () => {
  test("publishes preview before persistence and upserts the stable playlist after success", async () => {
    const gate = deferred();
    const committedPlaylist = createPlaylistSurface("New Draft");
    const persistRequests: PlayList[] = [];

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

  test("removes the preview after a failed background commit", async () => {
    setUpsertPlaylistMock(async () => Err("playlist commit failed"));

    resetRuntimeActor();
    appLogicActor.start();
    const actor = createActor(machine);

    try {
      actor.start();
      actor.send(
        payloads["playlist.commit.requested"].load(
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
      );

      await waitForState(actor, ss.mainx.State.idle);
      assert.equal(appLogicActor.getSnapshot().context.pendingPlaylistPreview, null);
      assert.deepEqual(appLogicActor.getSnapshot().context.playlists, []);
    } finally {
      actor.stop();
    }
  });
});
