import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Collection, DownloadRootTitleEvidence } from "@/src/cmd";
import { createTitleProbeQueue, resolveDefaultTitleProbeConcurrency } from "./titleProbeQueue";

const shellCollection: Collection = {
  name: "Title",
  url: "https://example.com/title",
  folder: "youtube/title",
  musics: [],
  last_updated: "2026-06-03T00:00:00Z",
  enable_updates: false,
};

function createEvidence(url: string): DownloadRootTitleEvidence {
  return {
    collection: {
      ...shellCollection,
      name: `Title ${url}`,
      url,
    },
    enable_updates: false,
    folder: shellCollection.folder,
    source_kind: "list",
    title: `Title ${url}`,
    url,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("title probe queue", () => {
  test("uses a bounded positive default concurrency", () => {
    assert.equal(resolveDefaultTitleProbeConcurrency(), 4);
  });

  test("runs title probes concurrently without waiting for previous probes to finish", async () => {
    const first = createDeferred<DownloadRootTitleEvidence>();
    const second = createDeferred<DownloadRootTitleEvidence>();
    const third = createDeferred<DownloadRootTitleEvidence>();
    const started: string[] = [];
    const completed: string[] = [];
    const probes = new Map([
      ["https://example.com/1", first],
      ["https://example.com/2", second],
      ["https://example.com/3", third],
    ]);
    const queue = createTitleProbeQueue({
      concurrency: () => 2,
      probe: (url) => {
        started.push(url);
        const probe = probes.get(url);
        if (!probe) {
          throw new Error(`unexpected probe: ${url}`);
        }
        return probe.promise;
      },
      toErrorMessage: (error) => String(error),
    });

    const sink = {
      completed: ({ id }: { id: string }) => completed.push(id),
      failed: () => undefined,
    };
    queue.enqueue({ id: "candidate:1", sink, url: "https://example.com/1" });
    queue.enqueue({ id: "candidate:2", sink, url: "https://example.com/2" });
    queue.enqueue({ id: "candidate:3", sink, url: "https://example.com/3" });
    await flushMicrotasks();

    assert.deepEqual(started, ["https://example.com/1", "https://example.com/2"]);

    second.resolve(createEvidence("https://example.com/2"));
    await flushMicrotasks();

    assert.deepEqual(completed, ["candidate:2"]);
    assert.deepEqual(started, [
      "https://example.com/1",
      "https://example.com/2",
      "https://example.com/3",
    ]);

    first.resolve(createEvidence("https://example.com/1"));
    third.resolve(createEvidence("https://example.com/3"));
    await flushMicrotasks();

    assert.deepEqual(completed, ["candidate:2", "candidate:1", "candidate:3"]);
  });

  test("drops late title evidence for a cancelled candidate scope", async () => {
    const probe = createDeferred<DownloadRootTitleEvidence>();
    const completed: string[] = [];
    const failed: string[] = [];
    const queue = createTitleProbeQueue({
      concurrency: () => 1,
      probe: () => probe.promise,
      toErrorMessage: (error) => String(error),
    });

    queue.enqueue({
      id: "candidate:1",
      sink: {
        completed: ({ id }) => completed.push(id),
        failed: ({ id }) => failed.push(id),
      },
      url: "https://example.com/1",
    });
    queue.cancel("candidate:1");
    probe.resolve(createEvidence("https://example.com/1"));
    await flushMicrotasks();

    assert.deepEqual(completed, []);
    assert.deepEqual(failed, []);
  });

  test("releases logical queue capacity as soon as an active candidate is cancelled", async () => {
    const first = createDeferred<DownloadRootTitleEvidence>();
    const second = createDeferred<DownloadRootTitleEvidence>();
    const started: string[] = [];
    const completed: string[] = [];
    const queue = createTitleProbeQueue({
      concurrency: () => 1,
      probe: (url) => (url.endsWith("/1") ? first.promise : second.promise),
      started: ({ url }) => started.push(url),
      toErrorMessage: (error) => String(error),
    });
    const sink = {
      completed: ({ id }: { id: string }) => completed.push(id),
      failed: () => undefined,
    };

    queue.enqueue({ id: "candidate:1", sink, url: "https://example.com/1" });
    queue.enqueue({ id: "candidate:2", sink, url: "https://example.com/2" });
    await flushMicrotasks();

    assert.deepEqual(started, ["https://example.com/1"]);

    queue.cancel("candidate:1");
    await flushMicrotasks();

    assert.deepEqual(started, ["https://example.com/1", "https://example.com/2"]);

    first.resolve(createEvidence("https://example.com/1"));
    second.resolve(createEvidence("https://example.com/2"));
    await flushMicrotasks();

    assert.deepEqual(completed, ["candidate:2"]);
  });

  test("reset closes active probes without making a later batch wait for old promises", async () => {
    const first = createDeferred<DownloadRootTitleEvidence>();
    const second = createDeferred<DownloadRootTitleEvidence>();
    const started: string[] = [];
    const completed: string[] = [];
    const queue = createTitleProbeQueue({
      concurrency: () => 1,
      probe: (url) => (url.endsWith("/old") ? first.promise : second.promise),
      started: ({ url }) => started.push(url),
      toErrorMessage: (error) => String(error),
    });
    const sink = {
      completed: ({ id }: { id: string }) => completed.push(id),
      failed: () => undefined,
    };

    queue.enqueue({ id: "candidate:old", sink, url: "https://example.com/old" });
    await flushMicrotasks();
    queue.reset();
    queue.enqueue({ id: "candidate:new", sink, url: "https://example.com/new" });
    await flushMicrotasks();

    assert.deepEqual(started, ["https://example.com/old", "https://example.com/new"]);

    first.resolve(createEvidence("https://example.com/old"));
    second.resolve(createEvidence("https://example.com/new"));
    await flushMicrotasks();

    assert.deepEqual(completed, ["candidate:new"]);
  });

  test("closes older title evidence when a candidate scope is replaced", async () => {
    const first = createDeferred<DownloadRootTitleEvidence>();
    const second = createDeferred<DownloadRootTitleEvidence>();
    const completed: string[] = [];
    const queue = createTitleProbeQueue({
      concurrency: () => 2,
      probe: (url) => (url.endsWith("/old") ? first.promise : second.promise),
      toErrorMessage: (error) => String(error),
    });
    const sink = {
      completed: ({ evidence }: { evidence: DownloadRootTitleEvidence }) =>
        completed.push(evidence.title),
      failed: () => undefined,
    };

    queue.enqueue({ id: "candidate:1", sink, url: "https://example.com/old" });
    queue.enqueue({ id: "candidate:1", sink, url: "https://example.com/new" });
    await flushMicrotasks();

    first.resolve({
      ...createEvidence("https://example.com/old"),
      title: "Old Title",
    });
    second.resolve({
      ...createEvidence("https://example.com/new"),
      title: "New Title",
    });
    await flushMicrotasks();

    assert.deepEqual(completed, ["New Title"]);
  });
});
