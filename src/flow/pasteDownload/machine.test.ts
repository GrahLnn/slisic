import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createActor } from "xstate";
import type { Collection, DownloadRootTitleEvidence, EnqueuedCollectionDownload } from "@/src/cmd";
import { machine } from "./machine";
import { deps, payloads } from "./events";

const pasteRequested = payloads["paste.requested"];
const candidateEnqueueCompleted = payloads["candidate.enqueue.completed"];
const candidateTitleCompleted = payloads["candidate.title.completed"];
const candidateTitleFailed = payloads["candidate.title.failed"];
const downloadTaskChanged = payloads["download.task.changed"];

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

function rootTitleEvidence(): DownloadRootTitleEvidence {
  return {
    url: shellCollection.url,
    title: shellCollection.name,
    folder: shellCollection.folder,
    enable_updates: shellCollection.enable_updates,
    source_kind: "list",
    collection: shellCollection,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("pasteDownload machine", () => {
  test("starts title probing and task enqueue as sibling effects for a new pasted url", async () => {
    const originalResolve = deps.resolvePastedDownloadUrl;
    const originalTitle = deps.probeDownloadRootTitle;
    const originalEnqueue = deps.enqueueCollectionDownload;
    const title = createDeferred<Awaited<ReturnType<typeof deps.probeDownloadRootTitle>>>();
    const enqueue = createDeferred<EnqueuedCollectionDownload>();
    const calls: string[] = [];
    deps.resolvePastedDownloadUrl = async (url) => {
      calls.push(`resolve:${url}`);
      return {
        status: "new_url",
        url,
        error: null,
        collection: null,
      };
    };
    deps.probeDownloadRootTitle = (url) => {
      calls.push(`title:${url}`);
      return title.promise;
    };
    deps.enqueueCollectionDownload = (url) => {
      calls.push(`enqueue:${url}`);
      return enqueue.promise;
    };

    const actor = createActor(machine);
    actor.start();

    try {
      actor.send(pasteRequested.load("https://example.com/list"));
      await flushMicrotasks();

      assert.deepEqual(calls, [
        "resolve:https://example.com/list",
        "title:https://example.com/list",
        "enqueue:https://example.com/list",
      ]);

      title.resolve(rootTitleEvidence());
      await flushMicrotasks();
      assert.equal(actor.getSnapshot().context.items[0]?.displayText, shellCollection.name);

      enqueue.resolve({
        ...activeDownloadResult(),
        collection: null,
        task: {
          ...activeDownloadResult().task,
          collection_url: null,
          collection_name: null,
          collection_folder: null,
        },
      });
      await flushMicrotasks();

      const item = actor.getSnapshot().context.items[0];
      assert.equal(item?.displayText, shellCollection.name);
      assert.equal(item?.status, "preparing");
      assert.equal(item?.taskId, "task:list");
    } finally {
      actor.stop();
      deps.resolvePastedDownloadUrl = originalResolve;
      deps.probeDownloadRootTitle = originalTitle;
      deps.enqueueCollectionDownload = originalEnqueue;
    }
  });

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

  test("keeps an active candidate when non-terminal task signals carry collection shell evidence", () => {
    const actor = createActor(machine);
    actor.start();

    actor.send(pasteRequested.load("https://example.com/list"));
    actor.send(
      candidateEnqueueCompleted.load({
        id: "candidate:0",
        result: {
          ...activeDownloadResult(),
          collection: null,
          task: {
            ...activeDownloadResult().task,
            collection_url: null,
            collection_name: null,
            collection_folder: null,
          },
        },
      }),
    );
    actor.send(
      downloadTaskChanged.load({
        task_id: "task:list",
        task_url: "https://example.com/list",
        collection_url: shellCollection.url,
        collection_name: shellCollection.name,
        status: "resolving",
        last_error: null,
      }),
    );

    const item = actor.getSnapshot().context.items[0];
    assert.equal(item?.id, "candidate:0");
    assert.equal(item?.status, "preparing");
    assert.equal(item?.taskId, "task:list");
    assert.equal(item?.displayText, "Slow Playlist");
    assert.equal(item?.sourceUrl, shellCollection.url);

    actor.stop();
  });

  test("accepts root title evidence before enqueue evidence without reverting to url text", () => {
    const actor = createActor(machine);
    actor.start();

    actor.send(pasteRequested.load("https://example.com/list"));
    actor.send(
      candidateTitleCompleted.load({
        id: "candidate:0",
        evidence: rootTitleEvidence(),
      }),
    );
    actor.send(
      candidateEnqueueCompleted.load({
        id: "candidate:0",
        result: {
          ...activeDownloadResult(),
          collection: null,
          task: {
            ...activeDownloadResult().task,
            collection_url: null,
            collection_name: null,
            collection_folder: null,
          },
        },
      }),
    );

    const item = actor.getSnapshot().context.items[0];
    assert.equal(item?.sourceUrl, shellCollection.url);
    assert.equal(item?.displayText, shellCollection.name);
    assert.equal(item?.status, "preparing");
    assert.equal(item?.taskId, "task:list");

    actor.stop();
  });

  test("accepts enqueue evidence before root title evidence and then releases url display", () => {
    const actor = createActor(machine);
    actor.start();

    actor.send(pasteRequested.load("https://example.com/list"));
    actor.send(
      candidateEnqueueCompleted.load({
        id: "candidate:0",
        result: {
          ...activeDownloadResult(),
          collection: null,
          task: {
            ...activeDownloadResult().task,
            collection_url: null,
            collection_name: null,
            collection_folder: null,
          },
        },
      }),
    );
    actor.send(
      candidateTitleCompleted.load({
        id: "candidate:0",
        evidence: rootTitleEvidence(),
      }),
    );

    const item = actor.getSnapshot().context.items[0];
    assert.equal(item?.sourceUrl, shellCollection.url);
    assert.equal(item?.displayText, shellCollection.name);
    assert.equal(item?.status, "preparing");
    assert.equal(item?.taskId, "task:list");

    actor.stop();
  });

  test("keeps enqueue path alive when root title probing fails", () => {
    const actor = createActor(machine);
    actor.start();

    actor.send(pasteRequested.load("https://example.com/list"));
    actor.send(candidateTitleFailed.load({ id: "candidate:0", error: "provider timeout" }));
    actor.send(
      candidateEnqueueCompleted.load({
        id: "candidate:0",
        result: {
          ...activeDownloadResult(),
          collection: null,
          task: {
            ...activeDownloadResult().task,
            collection_url: null,
            collection_name: null,
            collection_folder: null,
          },
        },
      }),
    );

    const item = actor.getSnapshot().context.items[0];
    assert.equal(item?.displayText, "https://example.com/list");
    assert.equal(item?.status, "preparing");
    assert.equal(item?.taskId, "task:list");
    assert.equal(item?.error, null);

    actor.stop();
  });
});
