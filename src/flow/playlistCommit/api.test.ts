import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { Err, Ok } from "@grahlnn/fn";
import type { PlayListListView } from "@/src/cmd";
import { crab } from "@/src/cmd";
import {
  actor as appLogicActor,
  resetRuntimeActor as resetAppLogicRuntimeActor,
} from "../appLogic/runtime";
import { resolvePlaylistDraftCommit } from "../appLogic/core";
import { action, resetRuntimeActor } from "./api";

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

afterEach(() => {
  setUpsertPlaylistMock(originalUpsertPlaylist);
  resetRuntimeActor();
  appLogicActor.stop();
  resetAppLogicRuntimeActor();
});

describe("playlistCommit api", () => {
  test("resolves commit only after the upsert command returns accepted persistence evidence", async () => {
    const gate = deferred();
    const committedPlaylist = createPlaylistSurface("API Draft");
    let didResolve = false;

    setUpsertPlaylistMock(async () => {
      await gate.promise;
      return Ok(committedPlaylist);
    });

    resetAppLogicRuntimeActor();
    appLogicActor.start();
    resetRuntimeActor();

    const completion = action
      .commit(
        resolvePlaylistDraftCommit({
          draft: {
            mode: "create",
            name: "API Draft",
            collections: [],
            groups: [],
            extra: [],
            createdAt: null,
          },
          draftBaseline: null,
          playlists: [],
        }),
      )
      .then((result) => {
        didResolve = true;
        return result;
      });

    await nextMicrotask();
    assert.equal(didResolve, false);
    assert.equal(
      appLogicActor.getSnapshot().context.pendingPlaylistPreview?.playlist.name,
      "API Draft",
    );

    gate.resolve();
    const result = await completion;

    assert.equal(didResolve, true);
    assert.deepEqual(result.playlist, committedPlaylist);
    assert.deepEqual(appLogicActor.getSnapshot().context.playlists, [committedPlaylist]);
  });

  test("rejects commit when the upsert command fails", async () => {
    setUpsertPlaylistMock(async () => Err("playlist commit failed"));

    resetAppLogicRuntimeActor();
    appLogicActor.start();
    resetRuntimeActor();

    const completion = action.commit(
      resolvePlaylistDraftCommit({
        draft: {
          mode: "create",
          name: "API Rejected Draft",
          collections: [],
          groups: [],
          extra: [],
          createdAt: null,
        },
        draftBaseline: null,
        playlists: [],
      }),
    );

    await assert.rejects(completion, /playlist commit failed/);
    assert.deepEqual(appLogicActor.getSnapshot().context.playlists, []);
    assert.equal(appLogicActor.getSnapshot().context.pendingPlaylistPreview, null);
  });
});
