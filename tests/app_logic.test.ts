import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Err, Ok } from "@grahlnn/fn";
import type { Collection, PlayList } from "../src/cmd";
import { createActor, type AnyActorRef } from "xstate";
import { crab } from "../src/cmd";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  createConfigSidebarItems,
  playlistTitleLayoutId,
  resolvePlaylistsWithPreview,
} from "../src/flow/appLogic/core";
import { payloads, ss, sig } from "../src/flow/appLogic/events";
import { machine } from "../src/flow/appLogic/machine";

const originalCheckList = crab.checkList;
const originalListCollections = crab.listCollections;
const originalListPlaylists = crab.listPlaylists;
const originalGetPlaylist = crab.getPlaylist;
const originalGetMetaInfo = crab.getMetaInfo;
const originalSetCollectionUpdates = crab.setCollectionUpdates;
const originalUpdateMusicAlias = crab.updateMusicAlias;
const originalPlayPlaylist = crab.playPlaylist;
const openPlaylist = payloads["playlist.open"];
const draftNameChanged = payloads["draft.name.changed"];
const spectrumMusicTitleChanged = payloads["spectrum.music_title.changed"];
const savePathChanged = payloads["save_path.changed"];
const collectionUpserted = payloads["collection.upserted"];
const draftCollectionUpserted = payloads["draft.collection.upserted"];
const draftItemIncluded = payloads["draft.item.included"];
const draftItemRemoved = payloads["draft.item.removed"];
const collectionUpdatesRequested = payloads["collection.updates.requested"];
const playlistPreviewChanged = payloads["playlist.preview.changed"];
const sampleSavePath = "C:\\Users\\admin\\Documents\\ransic";

const sampleCollection: Collection = {
  name: "Quiet Morning",
  url: "https://example.com/quiet-morning",
  folder: "youtube/quiet-morning",
  musics: [
    {
      name: "Quiet Morning",
      alias: "Quiet Morning",
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
      alias: "Disc 1 Opening",
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
      alias: "Quiet Morning Live",
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
  created_at: "2026-04-13T00:00:00Z",
};

const syncedCollection: Collection = {
  name: "Fresh Import",
  url: "https://example.com/fresh-import",
  folder: "youtube/fresh-import",
  musics: [],
  last_updated: "2026-04-17T00:00:00Z",
  enable_updates: null,
};

const sampleGroupSidebarItemRef = {
  kind: "group" as const,
  url: "https://example.com/quiet-morning#disc-1",
};

function createExpectedAppLogicContext(overrides: Record<string, unknown> = {}) {
  return {
    hasPlayList: null,
    playlists: [],
    pendingPlaylistPreview: null,
    collections: [],
    savePath: "",
    playingPlaylistName: null,
    nowPlayingTrackName: null,
    nowPlayingTrackUrl: null,
    nowPlayingTrackStart: null,
    nowPlayingTrackEnd: null,
    spectrumMusicTitleDraft: null,
    shouldStartPlayback: false,
    activeLayoutId: null,
    titleToneHandoff: null,
    pendingPlaylistName: null,
    pendingCollectionUpdatesChange: null,
    draftBaseline: null,
    draft: null,
    error: null,
    ...overrides,
  };
}

function currentConfigSidebarItems(actor: AnyActorRef) {
  return createConfigSidebarItems(actor.getSnapshot().context.collections);
}

function setCheckListMock(mock: typeof crab.checkList) {
  (crab as { checkList: typeof crab.checkList }).checkList = mock;
}

function setListCollectionsMock(mock: typeof crab.listCollections) {
  (crab as { listCollections: typeof crab.listCollections }).listCollections = mock;
}

function setListPlaylistsMock(mock: typeof crab.listPlaylists) {
  (crab as { listPlaylists: typeof crab.listPlaylists }).listPlaylists = mock;
}

function setGetPlaylistMock(mock: typeof crab.getPlaylist) {
  (crab as { getPlaylist: typeof crab.getPlaylist }).getPlaylist = mock;
}

function setGetMetaInfoMock(mock: typeof crab.getMetaInfo) {
  (crab as { getMetaInfo: typeof crab.getMetaInfo }).getMetaInfo = mock;
}

function setSetCollectionUpdatesMock(mock: typeof crab.setCollectionUpdates) {
  (crab as { setCollectionUpdates: typeof crab.setCollectionUpdates }).setCollectionUpdates = mock;
}

function setUpdateMusicAliasMock(mock: typeof crab.updateMusicAlias) {
  (crab as { updateMusicAlias: typeof crab.updateMusicAlias }).updateMusicAlias = mock;
}

function setPlayPlaylistMock(mock: typeof crab.playPlaylist) {
  (crab as { playPlaylist: typeof crab.playPlaylist }).playPlaylist = mock;
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
  setListPlaylistsMock(async () => Ok([]));
});

afterEach(() => {
  setCheckListMock(originalCheckList);
  setListCollectionsMock(originalListCollections);
  setListPlaylistsMock(originalListPlaylists);
  setGetPlaylistMock(originalGetPlaylist);
  setGetMetaInfoMock(originalGetMetaInfo);
  setSetCollectionUpdatesMock(originalSetCollectionUpdates);
  setUpdateMusicAliasMock(originalUpdateMusicAlias);
  setPlayPlaylistMock(originalPlayPlaylist);
});

describe("createConfigSidebarItems", () => {
  test("prefers collections over groups when display names overlap", () => {
    expect(createConfigSidebarItems([sampleCollection])).toEqual(expectedConfigSidebarItems);
  });
});

describe("appLogic machine", () => {
  test("starts idle and resolves to ready with playlist presence", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.idle);
    expect(actor.getSnapshot().context).toEqual(createExpectedAppLogicContext());

    actor.send(sig.mainx.run);
    await waitForState(actor, ss.mainx.State.ready);

    expect(actor.getSnapshot().context).toEqual(
      createExpectedAppLogicContext({
        hasPlayList: true,
        playlists: [samplePlaylist],
        collections: [sampleCollection],
        savePath: sampleSavePath,
      }),
    );
  });

  test("keeps ready state even when playlist table is empty", async () => {
    setCheckListMock(async () => Ok(false));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);

    expect(actor.getSnapshot().context).toEqual(
      createExpectedAppLogicContext({
        hasPlayList: false,
        savePath: sampleSavePath,
      }),
    );
  });

  test("records errors when the startup check fails", async () => {
    setCheckListMock(async () => Err("db unavailable"));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.error);

    expect(actor.getSnapshot().context).toEqual(
      createExpectedAppLogicContext({
        savePath: sampleSavePath,
        error: "db unavailable",
      }),
    );
  });

  test("moves into config with a create draft and back to ready", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(sig.mainx.opencreate);

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.config);
    expect(actor.getSnapshot().context.activeLayoutId).toBe(CREATE_COLLECTION_LAYOUT_ID);
    expect(currentConfigSidebarItems(actor)).toEqual(expectedConfigSidebarItems);
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
    expect(actor.getSnapshot().context.draftBaseline).toEqual({
      mode: "create",
      name: "",
      collections: [],
      groups: [],
    });

    actor.send(draftNameChanged.load("New Draft"));
    expect(actor.getSnapshot().context.draft?.name).toBe("New Draft");

    actor.send(sig.mainx.back);
    expect(actor.getSnapshot().value).toBe(ss.mainx.State.ready);
    expect(actor.getSnapshot().context.playlists).toEqual([samplePlaylist]);
    expect(actor.getSnapshot().context.savePath).toBe(sampleSavePath);
    expect(currentConfigSidebarItems(actor)).toEqual(expectedConfigSidebarItems);
    expect(actor.getSnapshot().context.activeLayoutId).toBeNull();
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: playlistTitleLayoutId("New Draft"),
      tone: "solid",
    });
    expect(actor.getSnapshot().context.pendingPlaylistName).toBeNull();
    expect(actor.getSnapshot().context.draftBaseline).toBeNull();
    expect(actor.getSnapshot().context.draft).toBeNull();
  });

  test("returns placeholder handoff tone when backing out of an empty create draft", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
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

  test("keeps edited playlist title preview available when returning from config", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
    setListCollectionsMock(async () => Ok([sampleCollection]));
    setGetPlaylistMock(async () => Ok(samplePlaylist));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(openPlaylist.load(samplePlaylist.name));
    await waitForState(actor, ss.mainx.State.config);

    const renamedPlaylist = {
      ...samplePlaylist,
      name: "Renamed Session",
    };
    const titlePreview = {
      playlist: renamedPlaylist,
      previousName: samplePlaylist.name,
    };

    actor.send(draftNameChanged.load(renamedPlaylist.name));
    actor.send(playlistPreviewChanged.load(titlePreview));
    actor.send(sig.mainx.back);

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.ready);
    expect(actor.getSnapshot().context.pendingPlaylistPreview).toEqual(titlePreview);
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: playlistTitleLayoutId(renamedPlaylist.name),
      tone: "solid",
    });
    expect(
      resolvePlaylistsWithPreview(
        actor.getSnapshot().context.playlists,
        actor.getSnapshot().context.pendingPlaylistPreview,
      ),
    ).toEqual([renamedPlaylist]);
  });

  test("keeps savePath in context across config transitions and updates", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
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
    expect(actor.getSnapshot().context.playlists).toEqual([samplePlaylist]);
    expect(actor.getSnapshot().context.savePath).toBe("D:\\MediaLibrary");
  });

  test("loads an existing playlist into config state by name", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
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
    expect(currentConfigSidebarItems(actor)).toEqual(expectedConfigSidebarItems);
    expect(actor.getSnapshot().context.titleToneHandoff).toBeNull();
    expect(actor.getSnapshot().context.pendingPlaylistName).toBeNull();
    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "edit",
      name: samplePlaylist.name,
      collections: samplePlaylist.collections,
      groups: samplePlaylist.groups,
    });
    expect(actor.getSnapshot().context.draftBaseline).toEqual({
      mode: "edit",
      name: samplePlaylist.name,
      collections: samplePlaylist.collections,
      groups: samplePlaylist.groups,
    });
  });

  test("upserts synced collections into config context and refreshes sidebar items", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(sig.mainx.opencreate);
    actor.send(collectionUpserted.load(syncedCollection));

    expect(actor.getSnapshot().context.collections).toEqual([syncedCollection, sampleCollection]);
    expect(actor.getSnapshot().context.playlists).toEqual([samplePlaylist]);
    expect(currentConfigSidebarItems(actor)).toEqual([
      {
        kind: "collection",
        name: syncedCollection.name,
        url: syncedCollection.url,
        folder: syncedCollection.folder,
      },
      ...expectedConfigSidebarItems,
    ]);
  });

  test("upserts synced collections into the active draft so saving uses canonical data", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
    setListCollectionsMock(async () => Ok([sampleCollection]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(sig.mainx.opencreate);
    actor.send(draftCollectionUpserted.load(syncedCollection));

    expect(actor.getSnapshot().context.collections).toEqual([syncedCollection, sampleCollection]);
    expect(actor.getSnapshot().context.playlists).toEqual([samplePlaylist]);
    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "create",
      name: "",
      collections: [syncedCollection],
      groups: [],
    });
    expect(actor.getSnapshot().context.draftBaseline).toEqual({
      mode: "create",
      name: "",
      collections: [],
      groups: [],
    });
    expect(currentConfigSidebarItems(actor)).toEqual([
      {
        kind: "collection",
        name: syncedCollection.name,
        url: syncedCollection.url,
        folder: syncedCollection.folder,
      },
      ...expectedConfigSidebarItems,
    ]);
  });

  test("toggles collection updates through a domain event and keeps draft canonical", async () => {
    const updateEnabledCollection: Collection = {
      ...sampleCollection,
      enable_updates: true,
    };

    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
    setListCollectionsMock(async () => Ok([sampleCollection]));
    setSetCollectionUpdatesMock(async (url, enabled) => {
      expect(url).toBe(sampleCollection.url);
      expect(enabled).toBe(true);
      return Ok(updateEnabledCollection);
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    setGetPlaylistMock(async () => Ok(samplePlaylist));
    actor.send(openPlaylist.load(samplePlaylist.name));
    await waitForState(actor, ss.mainx.State.config);
    await waitForContext(actor, (context: { draft: unknown }) => context.draft !== null);

    actor.send(
      collectionUpdatesRequested.load({
        url: sampleCollection.url,
        enabled: true,
      }),
    );

    await waitForState(actor, ss.mainx.State.configUpdatingCollectionUpdates);
    await waitForContext(
      actor,
      (context: { collections: Collection[] }) => context.collections[0]?.enable_updates === true,
    );
    await waitForState(actor, ss.mainx.State.config);

    expect(actor.getSnapshot().context.pendingCollectionUpdatesChange).toBeNull();
    expect(actor.getSnapshot().context.collections).toEqual([updateEnabledCollection]);
    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "edit",
      name: samplePlaylist.name,
      collections: [updateEnabledCollection],
      groups: samplePlaylist.groups,
    });
    expect(actor.getSnapshot().context.draftBaseline).toEqual({
      mode: "edit",
      name: samplePlaylist.name,
      collections: samplePlaylist.collections,
      groups: samplePlaylist.groups,
    });
  });

  test("pushes a sidebar item into the draft through appLogic instead of local ui state", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
    setListCollectionsMock(async () => Ok([sampleCollection, syncedCollection]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(sig.mainx.opencreate);

    actor.send(
      draftItemIncluded.load({
        kind: "collection",
        url: syncedCollection.url,
      }),
    );

    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "create",
      name: "",
      collections: [syncedCollection],
      groups: [],
    });
    expect(actor.getSnapshot().context.draftBaseline).toEqual({
      mode: "create",
      name: "",
      collections: [],
      groups: [],
    });

    actor.send(draftItemIncluded.load(sampleGroupSidebarItemRef));

    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "create",
      name: "",
      collections: [syncedCollection],
      groups: [
        {
          name: "Disc 1",
          url: sampleGroupSidebarItemRef.url,
          folder: "Disc 1",
        },
      ],
    });

    actor.send(
      draftItemRemoved.load({
        kind: "collection",
        url: syncedCollection.url,
      }),
    );
    actor.send(draftItemRemoved.load(sampleGroupSidebarItemRef));

    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "create",
      name: "",
      collections: [],
      groups: [],
    });
    expect(actor.getSnapshot().context.draftBaseline).toEqual({
      mode: "create",
      name: "",
      collections: [],
      groups: [],
    });
  });

  test("opens spectrum from playback and returns without restarting playback", async () => {
    let playCalls = 0;

    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
    setListCollectionsMock(async () => Ok([sampleCollection]));
    setPlayPlaylistMock(async (name) => {
      playCalls += 1;
      expect(name).toBe(samplePlaylist.name);
      return Ok({
        playlist_name: samplePlaylist.name,
        track_count: 2,
      });
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(payloads["playlist.play"].load(samplePlaylist.name));
    await waitForState(actor, ss.mainx.State.play);
    await waitForContext(
      actor,
      (context: { shouldStartPlayback: boolean }) => context.shouldStartPlayback,
    );

    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: samplePlaylist.name,
        music_name: "Disc 1 Opening",
        music_url: "https://example.com/quiet-morning#disc-1-opening",
        start: 0,
        end: 120,
      }),
    );
    actor.send(sig.mainx.openspectrum);

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.spectrum);
    expect(actor.getSnapshot().context).toEqual(
      createExpectedAppLogicContext({
        hasPlayList: true,
        playlists: [samplePlaylist],
        pendingPlaylistPreview: null,
        collections: [sampleCollection],
        savePath: sampleSavePath,
        playingPlaylistName: samplePlaylist.name,
        nowPlayingTrackName: "Disc 1 Opening",
        nowPlayingTrackUrl: "https://example.com/quiet-morning#disc-1-opening",
        nowPlayingTrackStart: 0,
        nowPlayingTrackEnd: 120,
        spectrumMusicTitleDraft: {
          baselineName: "Disc 1 Opening",
          name: "Disc 1 Opening",
          url: "https://example.com/quiet-morning#disc-1-opening",
          start: 0,
          end: 120,
        },
        shouldStartPlayback: false,
        activeLayoutId: playlistTitleLayoutId(samplePlaylist.name),
      }),
    );

    actor.send(sig.mainx.back);
    await waitForState(actor, ss.mainx.State.play);

    expect(playCalls).toBe(1);
    expect(actor.getSnapshot().context.playingPlaylistName).toBe(samplePlaylist.name);
    expect(actor.getSnapshot().context.shouldStartPlayback).toBe(false);
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: playlistTitleLayoutId(samplePlaylist.name),
      tone: "solid",
    });
  });

  test("commits edited spectrum music title back to the current playback data", async () => {
    let aliasUpdateCalls = 0;

    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
    setListCollectionsMock(async () => Ok([sampleCollection]));
    setPlayPlaylistMock(async () =>
      Ok({
        playlist_name: samplePlaylist.name,
        track_count: 2,
      }),
    );
    setUpdateMusicAliasMock(async (url, start, end, alias) => {
      aliasUpdateCalls += 1;
      expect(url).toBe("https://example.com/quiet-morning#disc-1-opening");
      expect(start).toBe(0);
      expect(end).toBe(120);
      expect(alias).toBe("Disc 1 Prelude");
      return Ok({
        ...sampleCollection.musics[1]!,
        alias,
      });
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(payloads["playlist.play"].load(samplePlaylist.name));
    await waitForState(actor, ss.mainx.State.play);
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: samplePlaylist.name,
        music_name: "Disc 1 Opening",
        music_url: "https://example.com/quiet-morning#disc-1-opening",
        start: 0,
        end: 120,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    actor.send(spectrumMusicTitleChanged.load("Disc 1 Prelude"));
    actor.send(sig.mainx.back);

    await waitForState(actor, ss.mainx.State.play);

    expect(aliasUpdateCalls).toBe(1);
    expect(actor.getSnapshot().context.nowPlayingTrackName).toBe("Disc 1 Prelude");
    expect(actor.getSnapshot().context.spectrumMusicTitleDraft).toBeNull();
    expect(actor.getSnapshot().context.collections[0]?.musics[1]?.name).toBe("Disc 1 Opening");
    expect(actor.getSnapshot().context.collections[0]?.musics[1]?.alias).toBe("Disc 1 Prelude");
    expect(actor.getSnapshot().context.playlists[0]?.collections[0]?.musics[1]?.name).toBe(
      "Disc 1 Opening",
    );
    expect(actor.getSnapshot().context.playlists[0]?.collections[0]?.musics[1]?.alias).toBe(
      "Disc 1 Prelude",
    );
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: playlistTitleLayoutId(samplePlaylist.name),
      tone: "solid",
    });
  });

  test("moves to error when the requested playlist does not exist", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([samplePlaylist]));
    setListCollectionsMock(async () => Ok([sampleCollection]));
    setGetPlaylistMock(async () => Ok(null));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(openPlaylist.load("Missing"));
    await waitForState(actor, ss.mainx.State.error);

    expect(actor.getSnapshot().context).toEqual(
      createExpectedAppLogicContext({
        hasPlayList: true,
        playlists: [samplePlaylist],
        collections: [sampleCollection],
        savePath: sampleSavePath,
        activeLayoutId: playlistTitleLayoutId("Missing"),
        error: "playlist `Missing` not found",
      }),
    );
  });
});

describe("ensureAppLogicStarted", () => {
  test("runs the startup check only once for the same module instance", async () => {
    let checkCalls = 0;
    let listCalls = 0;
    let listPlaylistCalls = 0;
    setCheckListMock(async () => {
      checkCalls += 1;
      return Ok(true);
    });
    setListPlaylistsMock(async () => {
      listPlaylistCalls += 1;
      return Ok([samplePlaylist]);
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
      expect(listPlaylistCalls).toBe(1);
      expect(listCalls).toBe(1);
      expect(mod.actor.getSnapshot().context).toEqual(
        createExpectedAppLogicContext({
          hasPlayList: true,
          playlists: [samplePlaylist],
          collections: [sampleCollection],
          savePath: sampleSavePath,
        }),
      );
    } finally {
      mod.stop();
    }
  });
});
