import { afterEach, describe, expect, test } from "bun:test";
import { Err, Ok } from "@grahlnn/fn";
import type { Collection } from "../src/cmd";
import { createActor, type AnyActorRef } from "xstate";
import { crab } from "../src/cmd";
import { CREATE_COLLECTION_LAYOUT_ID, collectionTitleLayoutId } from "../src/flow/appLogic/core";
import { payloads, ss, sig } from "../src/flow/appLogic/events";
import { machine } from "../src/flow/appLogic/machine";

const originalCheckList = crab.checkList;
const originalListCollections = crab.listCollections;
const openCollection = payloads["collection.open"];
const draftNameChanged = payloads["draft.name.changed"];

const sampleCollection: Collection = {
  name: "Quiet Morning",
  url: "https://example.com/quiet-morning",
  folder: "youtube/quiet-morning",
  musics: [],
  last_updated: "2026-04-13T00:00:00Z",
  enable_updates: null,
};

function setCheckListMock(mock: typeof crab.checkList) {
  (crab as { checkList: typeof crab.checkList }).checkList = mock;
}

function setListCollectionsMock(mock: typeof crab.listCollections) {
  (crab as { listCollections: typeof crab.listCollections }).listCollections = mock;
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

afterEach(() => {
  setCheckListMock(originalCheckList);
  setListCollectionsMock(originalListCollections);
});

describe("appLogic machine", () => {
  test("starts idle and resolves to ready with playlist presence", async () => {
    setCheckListMock(async () => Ok(true));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.idle);
    expect(actor.getSnapshot().context).toEqual({
      hasPlayList: null,
      collections: [],
      activeLayoutId: null,
      titleToneHandoff: null,
      draft: null,
      error: null,
    });

    actor.send(sig.mainx.run);
    await waitForState(actor, ss.mainx.State.ready);

    expect(actor.getSnapshot().context).toEqual({
      hasPlayList: true,
      collections: [sampleCollection],
      activeLayoutId: null,
      titleToneHandoff: null,
      draft: null,
      error: null,
    });
  });

  test("keeps ready state even when playlist table is empty", async () => {
    setCheckListMock(async () => Ok(false));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);

    expect(actor.getSnapshot().context).toEqual({
      hasPlayList: false,
      collections: [],
      activeLayoutId: null,
      titleToneHandoff: null,
      draft: null,
      error: null,
    });
  });

  test("records errors when the startup check fails", async () => {
    setCheckListMock(async () => Err("db unavailable"));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.error);

    expect(actor.getSnapshot().context).toEqual({
      hasPlayList: null,
      collections: [],
      activeLayoutId: null,
      titleToneHandoff: null,
      draft: null,
      error: "db unavailable",
    });
  });

  test("moves into config with a create draft and back to ready", async () => {
    setCheckListMock(async () => Ok(true));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(sig.mainx.opencreate);

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.config);
    expect(actor.getSnapshot().context.activeLayoutId).toBe(CREATE_COLLECTION_LAYOUT_ID);
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: CREATE_COLLECTION_LAYOUT_ID,
      tone: "solid",
    });
    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "create",
      sourceUrl: null,
      name: "",
      folder: "",
      enableUpdates: null,
    });

    actor.send(draftNameChanged.load("New Draft"));
    expect(actor.getSnapshot().context.draft?.name).toBe("New Draft");

    actor.send(sig.mainx.back);
    expect(actor.getSnapshot().value).toBe(ss.mainx.State.ready);
    expect(actor.getSnapshot().context.activeLayoutId).toBeNull();
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: CREATE_COLLECTION_LAYOUT_ID,
      tone: "solid",
    });
    expect(actor.getSnapshot().context.draft).toBeNull();
  });

  test("returns placeholder handoff tone when backing out of an empty create draft", async () => {
    setCheckListMock(async () => Ok(true));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(sig.mainx.opencreate);
    actor.send(sig.mainx.back);

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.ready);
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: CREATE_COLLECTION_LAYOUT_ID,
      tone: "muted",
    });
  });

  test("opens an existing collection in config draft state", async () => {
    setCheckListMock(async () => Ok(true));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(openCollection.load(sampleCollection));

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.config);
    expect(actor.getSnapshot().context.activeLayoutId).toBe(
      collectionTitleLayoutId(sampleCollection.url),
    );
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: collectionTitleLayoutId(sampleCollection.url),
      tone: "solid",
    });
    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "edit",
      sourceUrl: sampleCollection.url,
      name: sampleCollection.name,
      folder: sampleCollection.folder,
      enableUpdates: sampleCollection.enable_updates,
    });
  });
});

describe("ensureAppLogicStarted", () => {
  test("runs the startup check only once for the same module instance", async () => {
    let checkCalls = 0;
    let listCalls = 0;
    setCheckListMock(async () => {
      checkCalls += 1;
      return Ok(true);
    });
    setListCollectionsMock(async () => {
      listCalls += 1;
      return Ok([sampleCollection]);
    });

    const mod = await import(`../src/flow/appLogic/index.ts?case=bootstrap-once`);

    try {
      mod.ensureAppLogicStarted();
      mod.ensureAppLogicStarted();

      await waitForState(mod.actor, ss.mainx.State.ready);

      expect(checkCalls).toBe(1);
      expect(listCalls).toBe(1);
      expect(mod.actor.getSnapshot().context).toEqual({
        hasPlayList: true,
        collections: [sampleCollection],
        activeLayoutId: null,
        titleToneHandoff: null,
        draft: null,
        error: null,
      });
    } finally {
      mod.stop();
    }
  });
});
