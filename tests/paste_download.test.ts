import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AnyActorRef } from "xstate";
import { createActor } from "xstate";
import type { Collection, DownloadResourceProbe, DownloadTask } from "../src/cmd";
import { deps, payloads, sig, ss } from "../src/flow/pasteDownload/events";
import { machine } from "../src/flow/pasteDownload/machine";

const originalProbeDownloadResource = deps.probeDownloadResource;
const originalEnqueueCollectionDownload = deps.enqueueCollectionDownload;

const sampleProbe: DownloadResourceProbe = {
  url: "https://www.youtube.com/watch?v=abc123",
  source_kind: "single",
  title: "Quiet Morning",
  item_count: 1,
};

const secondProbe: DownloadResourceProbe = {
  url: "https://www.youtube.com/watch?v=def456",
  source_kind: "single",
  title: "Night Walk",
  item_count: 1,
};

const sampleTask: DownloadTask = {
  id: { String: "task-1" },
  url: sampleProbe.url,
  collection_url: sampleProbe.url,
  collection_name: sampleProbe.title,
  collection_folder: "youtube/quiet-morning",
  source_kind: sampleProbe.source_kind,
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
  name: sampleProbe.title,
  url: sampleProbe.url,
  folder: "youtube/quiet-morning",
  musics: [],
  last_updated: "2026-04-17T00:00:00Z",
  enable_updates: null,
};

const secondCollection: Collection = {
  name: secondProbe.title,
  url: secondProbe.url,
  folder: "youtube/night-walk",
  musics: [],
  last_updated: "2026-04-17T00:00:00Z",
  enable_updates: null,
};

const secondTask: DownloadTask = {
  ...sampleTask,
  id: { String: "task-2" },
  url: secondProbe.url,
  collection_url: secondProbe.url,
  collection_name: secondProbe.title,
};

const pasteRequested = payloads["paste.requested"];
const candidateDelete = payloads["candidate.delete"];

function setProbeDownloadResourceMock(mock: typeof deps.probeDownloadResource) {
  deps.probeDownloadResource = mock;
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
  setProbeDownloadResourceMock(async () => sampleProbe);
  setEnqueueCollectionDownloadMock(async () => ({
    task: sampleTask,
    collection: sampleCollection,
  }));
});

afterEach(() => {
  setProbeDownloadResourceMock(originalProbeDownloadResource);
  setEnqueueCollectionDownloadMock(originalEnqueueCollectionDownload);
});

describe("pasteDownload machine", () => {
  test("starts idle with an empty context", () => {
    const actor = createActor(machine);
    actor.start();

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.idle);
    expect(actor.getSnapshot().context).toEqual({
      items: [],
      pendingProbeItemIds: [],
      activeItemId: null,
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
      pendingProbeItemIds: [],
      activeItemId: null,
      nextItemSequence: 1,
    });
  });

  test("keeps invalid pasted text as a delete-only candidate without probing", async () => {
    let probeCalls = 0;
    setProbeDownloadResourceMock(async () => {
      probeCalls += 1;
      return sampleProbe;
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load("not a url"));

    await waitForState(actor, ss.mainx.State.idle);

    expect(probeCalls).toBe(0);
    expect(actor.getSnapshot().context).toEqual({
      items: [
        {
          id: "candidate:0",
          rawText: "not a url",
          sourceUrl: null,
          displayText: "not a url",
          status: "invalid_url",
          error: "Clipboard does not contain a valid URL.",
          probe: null,
          task: null,
        },
      ],
      pendingProbeItemIds: [],
      activeItemId: null,
      nextItemSequence: 1,
    });
  });

  test("keeps probe failures as delete-only candidates", async () => {
    setProbeDownloadResourceMock(async () => {
      throw new Error("resource is not downloadable");
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load("https://www.youtube.com/watch?v=abc123"));

    await waitForContext(actor, (context: { items: Array<{ status: string }> }) => {
      return context.items[0]?.status === "probe_failed";
    });

    expect(actor.getSnapshot().context).toEqual({
      items: [
        {
          id: "candidate:0",
          rawText: "https://www.youtube.com/watch?v=abc123",
          sourceUrl: "https://www.youtube.com/watch?v=abc123",
          displayText: "https://www.youtube.com/watch?v=abc123",
          status: "probe_failed",
          error: "resource is not downloadable",
          probe: null,
          task: null,
        },
      ],
      pendingProbeItemIds: [],
      activeItemId: null,
      nextItemSequence: 1,
    });
  });

  test("prepends later pasted candidates while earlier ones are still processing", async () => {
    let releaseFirstProbe: (() => void) | null = null;
    const firstProbe = new Promise<DownloadResourceProbe>((resolve) => {
      releaseFirstProbe = () => resolve(sampleProbe);
    });
    let probeCalls = 0;

    setProbeDownloadResourceMock(async (url: string) => {
      probeCalls += 1;
      if (url === sampleProbe.url) {
        return firstProbe;
      }

      return secondProbe;
    });
    setEnqueueCollectionDownloadMock(async (url: string) => {
      return url === sampleProbe.url
        ? {
            task: sampleTask,
            collection: sampleCollection,
          }
        : {
            task: secondTask,
            collection: secondCollection,
          };
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load(sampleProbe.url));
    await waitForState(actor, ss.mainx.State.probing);
    actor.send(pasteRequested.load(secondProbe.url));

    expect(probeCalls).toBe(1);
    expect(actor.getSnapshot().context.items).toEqual([
      {
        id: "candidate:1",
        rawText: secondProbe.url,
        sourceUrl: secondProbe.url,
        displayText: secondProbe.url,
        status: "probing",
        error: null,
        probe: null,
        task: null,
      },
      {
        id: "candidate:0",
        rawText: sampleProbe.url,
        sourceUrl: sampleProbe.url,
        displayText: sampleProbe.url,
        status: "probing",
        error: null,
        probe: null,
        task: null,
      },
    ]);

    releaseFirstProbe?.();
    await waitForContext(actor, (context: { items: Array<{ id: string }> }) => {
      return context.items.length === 0;
    });

    expect(actor.getSnapshot().context.items).toEqual([]);
  });

  test("deletes failed candidates by id", async () => {
    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load("not a url"));
    await waitForState(actor, ss.mainx.State.idle);

    actor.send(candidateDelete.load("candidate:0"));

    expect(actor.getSnapshot().context).toEqual({
      items: [],
      pendingProbeItemIds: [],
      activeItemId: null,
      nextItemSequence: 1,
    });
  });

  test("resets the entire candidate list", async () => {
    const actor = createActor(machine);
    actor.start();
    actor.send(pasteRequested.load("not a url"));
    await waitForState(actor, ss.mainx.State.idle);

    actor.send(sig.mainx.reset);

    expect(actor.getSnapshot().context).toEqual({
      items: [],
      pendingProbeItemIds: [],
      activeItemId: null,
      nextItemSequence: 0,
    });
  });
});
