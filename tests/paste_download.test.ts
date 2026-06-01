import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AnyActorRef } from "xstate";
import { createActor } from "xstate";
import type { Collection, DownloadTask } from "../src/cmd";
import { deps, payloads, sig, ss } from "../src/flow/pasteDownload/events";
import { machine } from "../src/flow/pasteDownload/machine";

const originalEnqueueCollectionDownload = deps.enqueueCollectionDownload;
const originalResolvePastedDownloadUrl = deps.resolvePastedDownloadUrl;

const sampleResource = {
  url: "https://www.youtube.com/watch?v=abc123",
  source_kind: "single",
  title: "Quiet Morning",
} as const;

const secondResource = {
  url: "https://www.youtube.com/watch?v=def456",
  source_kind: "single",
  title: "Night Walk",
} as const;

const sampleTask: DownloadTask = {
  id: { String: "task-1" },
  url: sampleResource.url,
  collection_url: sampleResource.url,
  collection_name: sampleResource.title,
  collection_folder: "youtube/quiet-morning",
  source_kind: sampleResource.source_kind,
  trigger: "manual",
  status: "queued",
  leafs: [],
  total_leaves: 0,
  completed_leaves: 0,
  failed_leaves: 0,
  last_error: null,
  created_at: "2026-04-17T00:00:00Z",
  updated_at: "2026-04-17T00:00:00Z",
};

const sampleCollection: Collection = {
  name: sampleResource.title,
  url: sampleResource.url,
  folder: "youtube/quiet-morning",
  musics: [],
  last_updated: "2026-04-17T00:00:00Z",
  enable_updates: null,
};

const secondCollection: Collection = {
  name: secondResource.title,
  url: secondResource.url,
  folder: "youtube/night-walk",
  musics: [],
  last_updated: "2026-04-17T00:00:00Z",
  enable_updates: null,
};

const secondTask: DownloadTask = {
  ...sampleTask,
  id: { String: "task-2" },
  url: secondResource.url,
  collection_url: secondResource.url,
  collection_name: secondResource.title,
};

const pasteRequested = payloads["paste.requested"];
const candidateDelete = payloads["candidate.delete"];
const downloadTaskChanged = payloads["download.task.changed"];
const candidateTaskCollectionLoaded = payloads["candidate.task.collection.loaded"];

function setResolvePastedDownloadUrlMock(mock: typeof deps.resolvePastedDownloadUrl) {
  deps.resolvePastedDownloadUrl = mock;
}

function setEnqueueCollectionDownloadMock(mock: typeof deps.enqueueCollectionDownload) {
  deps.enqueueCollectionDownload = mock;
}

function waitForState(actor: AnyActorRef, expected: string, timeoutMs = 1000) {
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

function waitForContext<T>(
  actor: AnyActorRef,
  predicate: (context: T) => boolean,
  timeoutMs = 1000,
) {
  return new Promise<void>((resolve, reject) => {
    if (predicate(actor.getSnapshot().context as T)) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      subscription.unsubscribe();
      reject(new Error("Timed out waiting for context update"));
    }, timeoutMs);

    const subscription = actor.subscribe((snapshot) => {
      if (!predicate(snapshot.context as T)) {
        return;
      }

      clearTimeout(timer);
      subscription.unsubscribe();
      resolve();
    });
  });
}

beforeEach(() => {
  setResolvePastedDownloadUrlMock(async (url: string) => ({
    status: "new_url",
    url: url.trim(),
    error: null,
    taskId: null,
    collection: null,
  }));
  setEnqueueCollectionDownloadMock(async () => ({
    task: sampleTask,
    collection: sampleCollection,
  }));
});

afterEach(() => {
  setResolvePastedDownloadUrlMock(originalResolvePastedDownloadUrl);
  setEnqueueCollectionDownloadMock(originalEnqueueCollectionDownload);
});

describe("pasteDownload machine", () => {
  test("starts idle with an empty context", () => {
    const actor = createActor(machine);
    actor.start();

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.idle);
    expect(actor.getSnapshot().context).toEqual({
      items: [],
      nextItemSequence: 0,
    });
  });

  test("adds a valid pasted url, resolves it, and stores the created task", async () => {
    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load(" https://www.youtube.com/watch?v=abc123 "));

    await waitForContext(actor, (context: { items: Array<unknown> }) => {
      return context.items.length === 0;
    });

    expect(actor.getSnapshot().context).toEqual({
      items: [],
      nextItemSequence: 1,
    });
  });

  test("keeps a new url as enqueueing until the persisted collection returns", async () => {
    let releaseEnqueue: (() => void) | null = null;
    const enqueueGate = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    setEnqueueCollectionDownloadMock(async () => {
      await enqueueGate;
      return {
        task: sampleTask,
        collection: sampleCollection,
      };
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load(sampleResource.url));

    await waitForContext(
      actor,
      (context: { items: Array<{ status: string; displayText: string }> }) =>
        context.items[0]?.status === "enqueueing",
    );

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.idle);
    expect(actor.getSnapshot().context.items).toEqual([
      {
        id: "candidate:0",
        rawText: sampleResource.url,
        sourceUrl: sampleResource.url,
        displayText: sampleResource.url,
        status: "enqueueing",
        error: null,
        taskId: null,
      },
    ]);

    releaseEnqueue?.();
    await waitForContext(actor, (context: { items: Array<unknown> }) => {
      return context.items.length === 0;
    });

    expect(actor.getSnapshot().context.items).toEqual([]);
  });

  test("keeps an accepted task visible as preparing until collection evidence arrives", async () => {
    setEnqueueCollectionDownloadMock(async () => ({
      task: {
        ...sampleTask,
      },
      collection: null,
    }));

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load(sampleResource.url));

    await waitForContext(
      actor,
      (context: { items: Array<{ status: string }> }) =>
        context.items[0]?.status === "preparing",
    );

    expect(actor.getSnapshot().context.items).toEqual([
      {
        id: "candidate:0",
        rawText: sampleResource.url,
        sourceUrl: sampleResource.url,
        displayText: sampleResource.title,
        status: "preparing",
        error: null,
        taskId: "task-1",
      },
    ]);
  });

  test("keeps accepted task visible by url when root title evidence is unavailable", async () => {
    setEnqueueCollectionDownloadMock(async () => ({
      task: {
        ...sampleTask,
        collection_url: null,
        collection_name: null,
        collection_folder: null,
        source_kind: null,
      },
      collection: null,
    }));

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load(sampleResource.url));

    await waitForContext(
      actor,
      (context: { items: Array<{ status: string }> }) =>
        context.items[0]?.status === "preparing",
    );

    expect(actor.getSnapshot().context.items[0]?.displayText).toBe(sampleResource.url);
  });

  test("removes a preparing task only after completed collection evidence is loaded", async () => {
    setEnqueueCollectionDownloadMock(async () => ({
      task: {
        ...sampleTask,
        collection_url: null,
        collection_name: null,
        collection_folder: null,
        source_kind: null,
      },
      collection: null,
    }));

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load(sampleResource.url));
    await waitForContext(
      actor,
      (context: { items: Array<{ status: string }> }) =>
        context.items[0]?.status === "preparing",
    );

    actor.send(
      downloadTaskChanged.load({
        task_id: "task-1",
        task_url: sampleResource.url,
        collection_url: sampleResource.url,
        status: "completed",
        last_error: null,
      }),
    );

    expect(actor.getSnapshot().context.items).toHaveLength(1);

    actor.send(
      candidateTaskCollectionLoaded.load({
        taskId: "task-1",
        collection: sampleCollection,
      }),
    );

    expect(actor.getSnapshot().context.items).toEqual([]);
  });

  test("keeps invalid pasted text as a delete-only candidate without enqueueing", async () => {
    let enqueueCalls = 0;
    setResolvePastedDownloadUrlMock(async () => ({
      status: "invalid_url",
      url: null,
      error: "Clipboard does not contain a valid URL.",
      taskId: null,
      collection: null,
    }));
    setEnqueueCollectionDownloadMock(async () => {
      enqueueCalls += 1;
      return {
        task: sampleTask,
        collection: sampleCollection,
      };
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load("not a url"));

    await waitForState(actor, ss.mainx.State.idle);

    expect(enqueueCalls).toBe(0);
    expect(actor.getSnapshot().context).toEqual({
      items: [
        {
          id: "candidate:0",
          rawText: "not a url",
          sourceUrl: null,
          displayText: "not a url",
          status: "invalid_url",
          error: "Clipboard does not contain a valid URL.",
          taskId: null,
        },
      ],
      nextItemSequence: 1,
    });
  });

  test("keeps enqueue failures as delete-only candidates", async () => {
    setEnqueueCollectionDownloadMock(async () => {
      throw new Error("resource is not downloadable");
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load("https://www.youtube.com/watch?v=abc123"));

    await waitForContext(actor, (context: { items: Array<{ status: string }> }) => {
      return context.items[0]?.status === "enqueue_failed";
    });

    expect(actor.getSnapshot().context).toEqual({
      items: [
        {
          id: "candidate:0",
          rawText: "https://www.youtube.com/watch?v=abc123",
          sourceUrl: "https://www.youtube.com/watch?v=abc123",
          displayText: "https://www.youtube.com/watch?v=abc123",
          status: "enqueue_failed",
          error: "resource is not downloadable",
          taskId: null,
        },
      ],
      nextItemSequence: 1,
    });
  });

  test("adds an existing collection directly to the draft without enqueueing", async () => {
    let enqueueCalls = 0;
    setResolvePastedDownloadUrlMock(async () => ({
      status: "existing_collection",
      url: sampleCollection.url,
      error: null,
      taskId: null,
      collection: sampleCollection,
    }));
    setEnqueueCollectionDownloadMock(async () => {
      enqueueCalls += 1;
      return {
        task: sampleTask,
        collection: sampleCollection,
      };
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load(sampleResource.url));

    await waitForContext(actor, (context: { items: Array<unknown> }) => {
      return context.items.length === 0;
    });

    expect(enqueueCalls).toBe(0);
    expect(actor.getSnapshot().context).toEqual({
      items: [],
      nextItemSequence: 1,
    });
  });

  test("starts each pasted candidate without waiting for earlier enqueue work", async () => {
    let releaseFirstEnqueue: (() => void) | null = null;
    const firstEnqueue = new Promise<void>((resolve) => {
      releaseFirstEnqueue = resolve;
    });
    let enqueueCalls = 0;
    setEnqueueCollectionDownloadMock(async (url: string) => {
      enqueueCalls += 1;
      if (url === sampleResource.url) {
        await firstEnqueue;
        return {
          task: sampleTask,
          collection: sampleCollection,
        };
      }

      return {
        task: secondTask,
        collection: secondCollection,
      };
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load(sampleResource.url));
    await waitForContext(actor, (context: { items: Array<{ id: string; status: string }> }) =>
      context.items.some((item) => item.id === "candidate:0" && item.status === "enqueueing"),
    );
    actor.send(pasteRequested.load(secondResource.url));

    await waitForContext(actor, (context: { items: Array<{ id: string }> }) => {
      return enqueueCalls === 2 && context.items.every((item) => item.id !== "candidate:1");
    });

    expect(actor.getSnapshot().context.items).toEqual([
      {
        id: "candidate:0",
        rawText: sampleResource.url,
        sourceUrl: sampleResource.url,
        displayText: sampleResource.url,
        status: "enqueueing",
        error: null,
        taskId: null,
      },
    ]);

    releaseFirstEnqueue?.();
    await waitForContext(actor, (context: { items: Array<{ id: string }> }) => {
      return context.items.length === 0;
    });

    expect(actor.getSnapshot().context.items).toEqual([]);
  });

  test("keeps a single paste containing two urls invalid without backend calls", async () => {
    let resolveCalls = 0;
    let enqueueCalls = 0;
    setResolvePastedDownloadUrlMock(async (url: string) => {
      resolveCalls += 1;
      return {
        status: "new_url",
        url,
        error: null,
        taskId: null,
        collection: null,
      };
    });
    setEnqueueCollectionDownloadMock(async () => {
      enqueueCalls += 1;
      return {
        task: sampleTask,
        collection: sampleCollection,
      };
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load("https://example.com/a https://www.youtube.com/watch?v=abc123"));

    await waitForContext(
      actor,
      (context: { items: Array<{ status: string }> }) => context.items[0]?.status === "invalid_url",
    );

    expect(resolveCalls).toBe(0);
    expect(enqueueCalls).toBe(0);
    expect(actor.getSnapshot().context.items).toEqual([
      {
        id: "candidate:0",
        rawText: "https://example.com/a https://www.youtube.com/watch?v=abc123",
        sourceUrl: null,
        displayText: "https://example.com/a https://www.youtube.com/watch?v=abc123",
        status: "invalid_url",
        error: "Clipboard must contain exactly one URL.",
        taskId: null,
      },
    ]);
  });

  test("deletes failed candidates by id", async () => {
    setResolvePastedDownloadUrlMock(async () => ({
      status: "invalid_url",
      url: null,
      error: "Clipboard does not contain a valid URL.",
      taskId: null,
      collection: null,
    }));

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load("not a url"));
    await waitForState(actor, ss.mainx.State.idle);

    actor.send(candidateDelete.load("candidate:0"));

    expect(actor.getSnapshot().context).toEqual({
      items: [],
      nextItemSequence: 1,
    });
  });

  test("resets the entire candidate list", async () => {
    setResolvePastedDownloadUrlMock(async () => ({
      status: "invalid_url",
      url: null,
      error: "Clipboard does not contain a valid URL.",
      taskId: null,
      collection: null,
    }));

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load("not a url"));
    await waitForState(actor, ss.mainx.State.idle);

    actor.send(sig.mainx.reset);

    expect(actor.getSnapshot().context).toEqual({
      items: [],
      nextItemSequence: 1,
    });
  });
});
