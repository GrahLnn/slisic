import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createActor } from "xstate";
import type { Collection, EnqueuedCollectionDownload } from "@/src/cmd";
import { machine } from "./machine";
import { payloads } from "./events";

const pasteRequested = payloads["paste.requested"];
const candidateEnqueueCompleted = payloads["candidate.enqueue.completed"];

const shellCollection: Collection = {
  name: "Slow Playlist",
  url: "https://example.com/root",
  folder: "youtube/slow-playlist",
  musics: [],
  last_updated: "2026-06-02T00:00:00Z",
  enable_updates: false,
};

function activeDownloadResult(): EnqueuedCollectionDownload {
  return {
    collection: shellCollection,
    task: {
      id: { String: "task:list" },
      url: "https://example.com/list",
      collection_url: shellCollection.url,
      collection_name: shellCollection.name,
      collection_folder: shellCollection.folder,
      source_kind: "list",
      trigger: "manual",
      status: "resolving",
      leafs: [],
      total_leaves: 0,
      completed_leaves: 0,
      failed_leaves: 0,
      last_error: null,
      created_at: "2026-06-02T00:00:00Z",
      updated_at: "2026-06-02T00:00:00Z",
    },
  };
}

describe("pasteDownload machine", () => {
  test("keeps an active download candidate after shell collection evidence arrives", () => {
    const actor = createActor(machine);
    actor.start();

    actor.send(pasteRequested.load("https://example.com/list"));
    actor.send(
      candidateEnqueueCompleted.load({
        id: "candidate:0",
        result: activeDownloadResult(),
      }),
    );

    const item = actor.getSnapshot().context.items[0];
    assert.equal(item?.id, "candidate:0");
    assert.equal(item?.status, "preparing");
    assert.equal(item?.taskId, "task:list");

    actor.stop();
  });
});
