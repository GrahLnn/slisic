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

  test("admits later pasted urls while an earlier url is still resolving", async () => {
    const originalResolve = deps.resolvePastedDownloadUrl;
    const originalTitle = deps.probeDownloadRootTitle;
    const originalEnqueue = deps.enqueueCollectionDownload;
    const firstResolve =
      createDeferred<Awaited<ReturnType<typeof deps.resolvePastedDownloadUrl>>>();
    const secondResolve =
      createDeferred<Awaited<ReturnType<typeof deps.resolvePastedDownloadUrl>>>();
    const calls: string[] = [];

    deps.resolvePastedDownloadUrl = (url) => {
      calls.push(`resolve:${url}`);
      if (url.endsWith("/slow")) {
        return firstResolve.promise;
      }
      if (url.endsWith("/fast")) {
        return secondResolve.promise;
      }
      throw new Error(`unexpected url: ${url}`);
    };
    deps.probeDownloadRootTitle = (url) => {
      calls.push(`title:${url}`);
      return Promise.resolve({
        ...rootTitleEvidence(),
        url,
        title: url.endsWith("/fast") ? "Fast Playlist" : "Slow Playlist",
        collection: {
          ...shellCollection,
          name: url.endsWith("/fast") ? "Fast Playlist" : "Slow Playlist",
          url,
        },
      });
    };
    deps.enqueueCollectionDownload = (url) => {
      calls.push(`enqueue:${url}`);
      return Promise.resolve({
        ...activeDownloadResult(),
        collection: null,
        task: {
          ...activeDownloadResult().task,
          url,
          id: { String: url.endsWith("/fast") ? "task:fast" : "task:slow" },
          collection_url: null,
          collection_name: null,
          collection_folder: null,
        },
      });
    };

    const actor = createActor(machine);
    actor.start();

    try {
      actor.send(pasteRequested.load("https://example.com/slow"));
      actor.send(pasteRequested.load("https://example.com/fast"));
      await flushMicrotasks();

      assert.deepEqual(calls, [
        "resolve:https://example.com/slow",
        "resolve:https://example.com/fast",
      ]);
      assert.equal(actor.getSnapshot().context.items.length, 2);
      assert.equal(actor.getSnapshot().context.items[0]?.displayText, "https://example.com/fast");
      assert.equal(actor.getSnapshot().context.items[1]?.displayText, "https://example.com/slow");

      secondResolve.resolve({
        status: "new_url",
        url: "https://example.com/fast",
        error: null,
        collection: null,
      });
      await flushMicrotasks();

      assert.deepEqual(calls, [
        "resolve:https://example.com/slow",
        "resolve:https://example.com/fast",
        "title:https://example.com/fast",
        "enqueue:https://example.com/fast",
      ]);
      assert.equal(actor.getSnapshot().context.items[0]?.displayText, "Fast Playlist");
      assert.equal(actor.getSnapshot().context.items[0]?.status, "preparing");
      assert.equal(actor.getSnapshot().context.items[1]?.status, "checking");

      firstResolve.resolve({
        status: "new_url",
        url: "https://example.com/slow",
        error: null,
        collection: null,
      });
      await flushMicrotasks();

      assert.deepEqual(calls, [
        "resolve:https://example.com/slow",
        "resolve:https://example.com/fast",
        "title:https://example.com/fast",
        "enqueue:https://example.com/fast",
        "title:https://example.com/slow",
        "enqueue:https://example.com/slow",
      ]);
      assert.equal(actor.getSnapshot().context.items[0]?.displayText, "Fast Playlist");
      assert.equal(actor.getSnapshot().context.items[1]?.displayText, "Slow Playlist");
    } finally {
      actor.stop();
      deps.resolvePastedDownloadUrl = originalResolve;
      deps.probeDownloadRootTitle = originalTitle;
      deps.enqueueCollectionDownload = originalEnqueue;
    }
  });

  test("starts later title probes while an earlier title probe is still running", async () => {
    const originalResolve = deps.resolvePastedDownloadUrl;
    const originalTitle = deps.probeDownloadRootTitle;
    const originalEnqueue = deps.enqueueCollectionDownload;
    const firstTitle = createDeferred<DownloadRootTitleEvidence>();
    const secondTitle = createDeferred<DownloadRootTitleEvidence>();
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
      if (url.endsWith("/slow-title")) {
        return firstTitle.promise;
      }
      if (url.endsWith("/fast-title")) {
        return secondTitle.promise;
      }
      throw new Error(`unexpected title url: ${url}`);
    };
    deps.enqueueCollectionDownload = (url) => {
      calls.push(`enqueue:${url}`);
      return Promise.resolve({
        ...activeDownloadResult(),
        collection: null,
        task: {
          ...activeDownloadResult().task,
          id: { String: url.endsWith("/fast-title") ? "task:fast-title" : "task:slow-title" },
          url,
          collection_url: null,
          collection_name: null,
          collection_folder: null,
        },
      });
    };

    const actor = createActor(machine);
    actor.start();

    try {
      actor.send(pasteRequested.load("https://example.com/slow-title"));
      actor.send(pasteRequested.load("https://example.com/fast-title"));
      await flushMicrotasks();

      assert.deepEqual(calls, [
        "resolve:https://example.com/slow-title",
        "resolve:https://example.com/fast-title",
        "title:https://example.com/slow-title",
        "enqueue:https://example.com/slow-title",
        "title:https://example.com/fast-title",
        "enqueue:https://example.com/fast-title",
      ]);

      secondTitle.resolve({
        ...rootTitleEvidence(),
        url: "https://example.com/fast-title",
        title: "Fast Title",
        collection: {
          ...shellCollection,
          name: "Fast Title",
          url: "https://example.com/fast-title",
        },
      });
      await flushMicrotasks();

      assert.equal(actor.getSnapshot().context.items[0]?.displayText, "Fast Title");
      assert.equal(
        actor.getSnapshot().context.items[1]?.displayText,
        "https://example.com/slow-title",
      );

      firstTitle.resolve({
        ...rootTitleEvidence(),
        url: "https://example.com/slow-title",
        title: "Slow Title",
        collection: {
          ...shellCollection,
          name: "Slow Title",
          url: "https://example.com/slow-title",
        },
      });
      await flushMicrotasks();

      assert.equal(actor.getSnapshot().context.items[0]?.displayText, "Fast Title");
      assert.equal(actor.getSnapshot().context.items[1]?.displayText, "Slow Title");
    } finally {
      actor.stop();
      deps.resolvePastedDownloadUrl = originalResolve;
      deps.probeDownloadRootTitle = originalTitle;
      deps.enqueueCollectionDownload = originalEnqueue;
    }
  });

  test("does not let an old actor title probe hold queue capacity for a new actor", async () => {
    const originalResolve = deps.resolvePastedDownloadUrl;
    const originalTitle = deps.probeDownloadRootTitle;
    const originalEnqueue = deps.enqueueCollectionDownload;
    const oldTitle = createDeferred<DownloadRootTitleEvidence>();
    const newTitle = createDeferred<DownloadRootTitleEvidence>();
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
      if (url.endsWith("/old")) {
        return oldTitle.promise;
      }
      if (url.endsWith("/new")) {
        return newTitle.promise;
      }
      throw new Error(`unexpected title url: ${url}`);
    };
    deps.enqueueCollectionDownload = (url) => {
      calls.push(`enqueue:${url}`);
      return Promise.resolve({
        ...activeDownloadResult(),
        collection: null,
        task: {
          ...activeDownloadResult().task,
          id: { String: url.endsWith("/new") ? "task:new" : "task:old" },
          url,
          collection_url: null,
          collection_name: null,
          collection_folder: null,
        },
      });
    };

    const oldActor = createActor(machine);
    const newActor = createActor(machine);
    oldActor.start();
    newActor.start();

    try {
      oldActor.send(pasteRequested.load("https://example.com/old"));
      await flushMicrotasks();
      newActor.send(pasteRequested.load("https://example.com/new"));
      await flushMicrotasks();

      assert.deepEqual(calls, [
        "resolve:https://example.com/old",
        "title:https://example.com/old",
        "enqueue:https://example.com/old",
        "resolve:https://example.com/new",
        "title:https://example.com/new",
        "enqueue:https://example.com/new",
      ]);
    } finally {
      oldActor.stop();
      newActor.stop();
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
