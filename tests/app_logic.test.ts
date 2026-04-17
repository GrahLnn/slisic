import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Err, Ok } from "@grahlnn/fn";
import type { Collection, PlayList } from "../src/cmd";
import { createActor, type AnyActorRef } from "xstate";
import { crab } from "../src/cmd";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  createConfigSidebarItems,
  playlistTitleLayoutId,
} from "../src/flow/appLogic/core";
import { payloads, ss, sig } from "../src/flow/appLogic/events";
import { machine } from "../src/flow/appLogic/machine";

const originalCheckList = crab.checkList;
const originalListCollections = crab.listCollections;
const originalGetPlaylist = crab.getPlaylist;
const originalGetMetaInfo = crab.getMetaInfo;
const openPlaylist = payloads["playlist.open"];
const draftNameChanged = payloads["draft.name.changed"];
const savePathChanged = payloads["save_path.changed"];
const sampleSavePath = "C:\\Users\\admin\\Documents\\ransic";

const sampleCollection: Collection = {
  name: "Quiet Morning",
  url: "https://example.com/quiet-morning",
  folder: "youtube/quiet-morning",
  musics: [
    {
      name: "Quiet Morning",
      group: {
        name: "Quiet Morning",
        url: "https://example.com/quiet-morning",
        folder: "youtube/quiet-morning",
      },
      url: "https://example.com/quiet-morning#title",
      path: "quiet-morning.m4a",
      start: 0,
      end: 120,
    },
    {
      name: "Disc 1 Opening",
      group: {
        name: "Disc 1",
        url: "https://example.com/quiet-morning#disc-1",
        folder: "Disc 1",
      },
      url: "https://example.com/quiet-morning#disc-1-opening",
      path: "Disc 1/opening.m4a",
      start: 0,
      end: 120,
    },
    {
      name: "Quiet Morning Live",
      group: {
        name: "Quiet Morning",
        url: "https://example.com/groups/quiet-morning-live",
        folder: "Live",
      },
      url: "https://example.com/quiet-morning#live",
      path: "Live/quiet-morning-live.m4a",
      start: 0,
      end: 120,
    },
  ],
  last_updated: "2026-04-13T00:00:00Z",
  enable_updates: null,
};

const expectedConfigSidebarItems = [
  {
    kind: "collection",
    name: sampleCollection.name,
    url: sampleCollection.url,
    folder: sampleCollection.folder,
  },
  {
    kind: "group",
    name: "Disc 1",
    url: "https://example.com/quiet-morning#disc-1",
    folder: "Disc 1",
  },
] as const;

const samplePlaylist: PlayList = {
  name: "Focus Session",
  collections: [sampleCollection],
  groups: [
    {
      name: "Disc 1",
      url: "https://example.com/quiet-morning#disc-1",
      folder: "Disc 1",
    },
  ],
};

function setCheckListMock(mock: typeof crab.checkList) {
  (crab as { checkList: typeof crab.checkList }).checkList = mock;
}

function setListCollectionsMock(mock: typeof crab.listCollections) {
  (crab as { listCollections: typeof crab.listCollections }).listCollections = mock;
}

function setGetPlaylistMock(mock: typeof crab.getPlaylist) {
  (crab as { getPlaylist: typeof crab.getPlaylist }).getPlaylist = mock;
}

function setGetMetaInfoMock(mock: typeof crab.getMetaInfo) {
  (crab as { getMetaInfo: typeof crab.getMetaInfo }).getMetaInfo = mock;
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
  setGetMetaInfoMock(async () => Ok({ save_path: sampleSavePath }));
});

afterEach(() => {
  setCheckListMock(originalCheckList);
  setListCollectionsMock(originalListCollections);
  setGetPlaylistMock(originalGetPlaylist);
  setGetMetaInfoMock(originalGetMetaInfo);
});

describe("createConfigSidebarItems", () => {
  test("prefers collections over groups when display names overlap", () => {
    expect(createConfigSidebarItems([sampleCollection])).toEqual(expectedConfigSidebarItems);
  });
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
      savePath: "",
      configSidebarItems: [],
      activeLayoutId: null,
      titleToneHandoff: null,
      pendingPlaylistName: null,
      draft: null,
      error: null,
    });

    actor.send(sig.mainx.run);
    await waitForState(actor, ss.mainx.State.ready);

    expect(actor.getSnapshot().context).toEqual({
      hasPlayList: true,
      collections: [sampleCollection],
      savePath: sampleSavePath,
      configSidebarItems: [],
      activeLayoutId: null,
      titleToneHandoff: null,
      pendingPlaylistName: null,
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
      savePath: sampleSavePath,
      configSidebarItems: [],
      activeLayoutId: null,
      titleToneHandoff: null,
      pendingPlaylistName: null,
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
      savePath: sampleSavePath,
      configSidebarItems: [],
      activeLayoutId: null,
      titleToneHandoff: null,
      pendingPlaylistName: null,
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
    expect(actor.getSnapshot().context.configSidebarItems).toEqual(expectedConfigSidebarItems);
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: CREATE_COLLECTION_LAYOUT_ID,
      tone: "solid",
    });
    expect(actor.getSnapshot().context.savePath).toBe(sampleSavePath);
    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "create",
      name: "",
      collections: [],
      groups: [],
    });

    actor.send(draftNameChanged.load("New Draft"));
    expect(actor.getSnapshot().context.draft?.name).toBe("New Draft");

    actor.send(sig.mainx.back);
    expect(actor.getSnapshot().value).toBe(ss.mainx.State.ready);
    expect(actor.getSnapshot().context.savePath).toBe(sampleSavePath);
    expect(actor.getSnapshot().context.configSidebarItems).toEqual([]);
    expect(actor.getSnapshot().context.activeLayoutId).toBeNull();
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: CREATE_COLLECTION_LAYOUT_ID,
      tone: "solid",
    });
    expect(actor.getSnapshot().context.pendingPlaylistName).toBeNull();
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

  test("keeps savePath in context across config transitions and updates", async () => {
    setCheckListMock(async () => Ok(true));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(sig.mainx.opencreate);

    expect(actor.getSnapshot().context.savePath).toBe(sampleSavePath);

    actor.send(savePathChanged.load("D:\\MediaLibrary"));
    expect(actor.getSnapshot().context.savePath).toBe("D:\\MediaLibrary");

    actor.send(sig.mainx.back);
    expect(actor.getSnapshot().value).toBe(ss.mainx.State.ready);
    expect(actor.getSnapshot().context.savePath).toBe("D:\\MediaLibrary");
  });

  test("loads an existing playlist into config state by name", async () => {
    setCheckListMock(async () => Ok(true));
    setListCollectionsMock(async () => Ok([sampleCollection]));
    setGetPlaylistMock(async (name) => {
      expect(name).toBe(samplePlaylist.name);
      return Ok(samplePlaylist);
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(openPlaylist.load(samplePlaylist.name));
    await waitForState(actor, ss.mainx.State.config);
    await waitForContext(actor, (context: { draft: unknown }) => context.draft !== null);

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.config);
    expect(actor.getSnapshot().context.activeLayoutId).toBe(
      playlistTitleLayoutId(samplePlaylist.name),
    );
    expect(actor.getSnapshot().context.configSidebarItems).toEqual(expectedConfigSidebarItems);
    expect(actor.getSnapshot().context.titleToneHandoff).toBeNull();
    expect(actor.getSnapshot().context.pendingPlaylistName).toBeNull();
    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "edit",
      name: samplePlaylist.name,
      collections: samplePlaylist.collections,
      groups: samplePlaylist.groups,
    });
  });

  test("moves to error when the requested playlist does not exist", async () => {
    setCheckListMock(async () => Ok(true));
    setListCollectionsMock(async () => Ok([sampleCollection]));
    setGetPlaylistMock(async () => Ok(null));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(openPlaylist.load("Missing"));
    await waitForState(actor, ss.mainx.State.error);

    expect(actor.getSnapshot().context).toEqual({
      hasPlayList: true,
      collections: [sampleCollection],
      savePath: sampleSavePath,
      configSidebarItems: expectedConfigSidebarItems,
      activeLayoutId: playlistTitleLayoutId("Missing"),
      titleToneHandoff: null,
      pendingPlaylistName: null,
      draft: null,
      error: "playlist `Missing` not found",
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
        savePath: sampleSavePath,
        configSidebarItems: [],
        activeLayoutId: null,
        titleToneHandoff: null,
        pendingPlaylistName: null,
        draft: null,
        error: null,
      });
    } finally {
      mod.stop();
    }
  });

  test("prints appLogic state transitions", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    let checkCalls = 0;
    let listCalls = 0;

    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    setCheckListMock(async () => {
      checkCalls += 1;
      return Ok(true);
    });
    setListCollectionsMock(async () => {
      listCalls += 1;
      return Ok([sampleCollection]);
    });

    const mod = await import(`../src/flow/appLogic/index.ts?case=debug-logger`);

    try {
      mod.ensureAppLogicStarted();
      await waitForState(mod.actor, ss.mainx.State.ready);

      mod.action.openCreate();
      await waitForState(mod.actor, ss.mainx.State.config);

      expect(checkCalls).toBe(1);
      expect(listCalls).toBe(1);
      expect(logs).toEqual(
        expect.arrayContaining([
          "[appLogic] enter idle",
          "[appLogic] idle -> loading",
          "[appLogic] loading -> ready",
          "[appLogic] ready -> config",
        ]),
      );
    } finally {
      console.log = originalLog;
      mod.stop();
    }
  });
});
