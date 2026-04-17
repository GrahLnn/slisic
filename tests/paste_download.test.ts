import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AnyActorRef } from "xstate";
import { createActor } from "xstate";
import type { DownloadResourceProbe, DownloadTask } from "../src/cmd";
import { deps, sig, ss } from "../src/flow/pasteDownload/events";
import { machine } from "../src/flow/pasteDownload/machine";

const originalReadClipboardText = deps.readClipboardText;
const originalProbeDownloadResource = deps.probeDownloadResource;
const originalEnqueueCollectionDownload = deps.enqueueCollectionDownload;

const sampleProbe: DownloadResourceProbe = {
  url: "https://www.youtube.com/watch?v=abc123",
  source_kind: "single",
  title: "Quiet Morning",
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

function setReadClipboardTextMock(mock: typeof deps.readClipboardText) {
  deps.readClipboardText = mock;
}

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

beforeEach(() => {
  setReadClipboardTextMock(async () => "");
  setProbeDownloadResourceMock(async () => sampleProbe);
  setEnqueueCollectionDownloadMock(async () => sampleTask);
});

afterEach(() => {
  setReadClipboardTextMock(originalReadClipboardText);
  setProbeDownloadResourceMock(originalProbeDownloadResource);
  setEnqueueCollectionDownloadMock(originalEnqueueCollectionDownload);
});

describe("pasteDownload machine", () => {
  test("starts idle with an empty context", () => {
    const actor = createActor(machine);
    actor.start();

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.idle);
    expect(actor.getSnapshot().context).toEqual({
      clipboardText: null,
      url: null,
      probe: null,
      task: null,
      error: null,
    });
  });

  test("reads the clipboard, probes the resource, and enqueues the download", async () => {
    let probeCalls = 0;
    let enqueueCalls = 0;

    setReadClipboardTextMock(async () => " https://www.youtube.com/watch?v=abc123 ");
    setProbeDownloadResourceMock(async (url) => {
      probeCalls += 1;
      expect(url).toBe("https://www.youtube.com/watch?v=abc123");
      return sampleProbe;
    });
    setEnqueueCollectionDownloadMock(async (url) => {
      enqueueCalls += 1;
      expect(url).toBe(sampleProbe.url);
      return sampleTask;
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.paste);

    await waitForState(actor, ss.mainx.State.done);

    expect(probeCalls).toBe(1);
    expect(enqueueCalls).toBe(1);
    expect(actor.getSnapshot().context).toEqual({
      clipboardText: " https://www.youtube.com/watch?v=abc123 ",
      url: sampleProbe.url,
      probe: sampleProbe,
      task: sampleTask,
      error: null,
    });
  });

  test("rejects invalid clipboard text before probing", async () => {
    let probeCalls = 0;
    let enqueueCalls = 0;

    setReadClipboardTextMock(async () => "not a url");
    setProbeDownloadResourceMock(async () => {
      probeCalls += 1;
      return sampleProbe;
    });
    setEnqueueCollectionDownloadMock(async () => {
      enqueueCalls += 1;
      return sampleTask;
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.paste);

    await waitForState(actor, ss.mainx.State.error);

    expect(probeCalls).toBe(0);
    expect(enqueueCalls).toBe(0);
    expect(actor.getSnapshot().context).toEqual({
      clipboardText: "not a url",
      url: null,
      probe: null,
      task: null,
      error: "Clipboard does not contain a valid URL.",
    });
  });

  test("surfaces probe failures without enqueueing", async () => {
    let enqueueCalls = 0;

    setReadClipboardTextMock(async () => "https://www.youtube.com/watch?v=abc123");
    setProbeDownloadResourceMock(async () => {
      throw new Error("resource is not downloadable");
    });
    setEnqueueCollectionDownloadMock(async () => {
      enqueueCalls += 1;
      return sampleTask;
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.paste);

    await waitForState(actor, ss.mainx.State.error);

    expect(enqueueCalls).toBe(0);
    expect(actor.getSnapshot().context).toEqual({
      clipboardText: "https://www.youtube.com/watch?v=abc123",
      url: "https://www.youtube.com/watch?v=abc123",
      probe: null,
      task: null,
      error: "resource is not downloadable",
    });
  });
});
