import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Err, Ok } from "@grahlnn/fn";
import type {
  Collection,
  ConfigLibraryView,
  Music,
  PlayList,
  PlayListListView,
  SpectrumMusicContext,
  SpectrumMusicSourceContext,
} from "../src/cmd";
import { createActor, type AnyActorRef } from "xstate";
import { crab } from "../src/cmd";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  createConfigSidebarItems,
  createConfigSidebarItemsFromLibrary,
  playlistTitleLayoutId,
} from "../src/flow/appLogic/core";
import { payloads, ss, sig } from "../src/flow/appLogic/events";
import { machine } from "../src/flow/appLogic/machine";

const originalCheckList = crab.checkList;
const originalListPlaylists = crab.listPlaylists;
const originalGetPlaylist = crab.getPlaylist;
const originalGetPlaylistConfig = crab.getPlaylistConfig;
const originalListConfigLibrary = crab.listConfigLibrary;
const originalUpsertPlaylist = crab.upsertPlaylist;
const originalGetMetaInfo = crab.getMetaInfo;
const originalSetCollectionUpdates = crab.setCollectionUpdates;
const originalRemoveExclude = crab.removeExclude;
const originalUpdateMusic = crab.updateMusic;
const originalLoadSpectrumMusicContext = crab.loadSpectrumMusicContext;
const originalPlayPlaylist = crab.playPlaylist;
const originalExcludeCurrentMusicAndSkip = crab.excludeCurrentMusicAndSkip;
const originalGetPlaybackStatus = crab.getPlaybackStatus;
const originalResumePlayback = crab.resumePlayback;
const originalEnterSpectrumPlaybackScope = crab.enterSpectrumPlaybackScope;
const originalExitSpectrumPlaybackScope = crab.exitSpectrumPlaybackScope;
const openPlaylist = payloads["playlist.open"];
const draftNameChanged = payloads["draft.name.changed"];
const spectrumMusicNameChanged = payloads["spectrum.music_name.changed"];
const savePathChanged = payloads["save_path.changed"];
const collectionUpserted = payloads["collection.upserted"];
const draftCollectionUpserted = payloads["draft.collection.upserted"];
const draftItemIncluded = payloads["draft.item.included"];
const draftItemRemoved = payloads["draft.item.removed"];
const collectionUpdatesRequested = payloads["collection.updates.requested"];
const spectrumMusicCreateStarted = payloads["spectrum.music_create_started"];
const sampleSavePath = "C:\\Users\\admin\\Documents\\slisic";

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
      start_ms: 0,
      end_ms: 120_000,
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
      start_ms: 0,
      end_ms: 120_000,
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
      start_ms: 0,
      end_ms: 120_000,
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
    last_updated: sampleCollection.last_updated,
    enable_updates: sampleCollection.enable_updates,
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

const sampleExcludedMusic = sampleCollection.musics[1]!;

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
    configLibrary: {
      collections: [],
      groups: [],
      excludes: [],
      exclude_availability: {
        fully_excluded_collection_urls: [],
        fully_excluded_group_urls: [],
      },
    },
    collections: [],
    savePath: "",
    playingPlaylistName: null,
    nowPlayingTrackName: null,
    nowPlayingTrackUrl: null,
    nowPlayingTrackFilePath: null,
    nowPlayingTrackStartMs: null,
    nowPlayingTrackEndMs: null,
    spectrumPlaybackScopeId: null,
    spectrumMusicDrafts: [],
    pendingSpectrumMusicCreateId: null,
    shouldStartPlayback: false,
    activeLayoutId: null,
    titleToneHandoff: null,
    pendingPlaylistName: null,
    pendingPlaylistPlaybackName: null,
    pendingCollectionUpdatesChange: null,
    spectrumMusicSourceContext: null,
    draftBaseline: null,
    draft: null,
    error: null,
    ...overrides,
  };
}

function currentConfigSidebarItems(actor: AnyActorRef) {
  const library = actor.getSnapshot().context.configLibrary;

  return createConfigSidebarItemsFromLibrary(library);
}

function createCollectionDraftRef(collection: Collection) {
  return {
    name: collection.name,
    url: collection.url,
    folder: collection.folder,
    last_updated: collection.last_updated,
    enable_updates: collection.enable_updates,
  };
}

function createConfigLibrary(collections: readonly Collection[]): ConfigLibraryView {
  const groups = new Map<string, Collection["musics"][number]["group"]>();

  for (const collection of collections) {
    for (const music of collection.musics) {
      groups.set(music.group.url, music.group);
    }
  }

  return {
    collections: collections.map((collection) => ({
      name: collection.name,
      url: collection.url,
      folder: collection.folder,
      last_updated: collection.last_updated,
      enable_updates: collection.enable_updates,
    })),
    groups: [...groups.values()],
    excludes: [],
    exclude_availability: {
      fully_excluded_collection_urls: [],
      fully_excluded_group_urls: [],
    },
  };
}

function createExclude(music: Music) {
  return {
    music,
    created_at: "2026-05-20T00:00:00Z",
  };
}

function createEmptyExcludeAvailability() {
  return {
    fully_excluded_collection_urls: [],
    fully_excluded_group_urls: [],
  };
}

function createPlaylistSurface(playlist: PlayList): PlayListListView {
  return {
    name: playlist.name,
    created_at: playlist.created_at,
  };
}

function createSpectrumMusicSourceContext(music: Music): SpectrumMusicSourceContext {
  return {
    source_collection_url: sampleCollection.url,
    source_end_ms: music.end_ms,
    source_group: music.group,
    source_path: music.path,
    source_start_ms: music.start_ms,
    source_url: music.url,
  };
}

function createSpectrumMusicContext(
  fileMusics: Music[],
  sourceMusic: Music | null = fileMusics[0] ?? null,
): SpectrumMusicContext {
  return {
    file_musics: fileMusics,
    source: sourceMusic ? createSpectrumMusicSourceContext(sourceMusic) : null,
  };
}

function setCheckListMock(mock: typeof crab.checkList) {
  (crab as { checkList: typeof crab.checkList }).checkList = mock;
}

function setListPlaylistsMock(mock: typeof crab.listPlaylists) {
  (crab as { listPlaylists: typeof crab.listPlaylists }).listPlaylists = mock;
}

function setGetPlaylistConfigMock(mock: typeof crab.getPlaylistConfig) {
  (crab as { getPlaylistConfig: typeof crab.getPlaylistConfig }).getPlaylistConfig = mock;
}

function setListConfigLibraryMock(mock: typeof crab.listConfigLibrary) {
  (crab as { listConfigLibrary: typeof crab.listConfigLibrary }).listConfigLibrary = mock;
}

function setUpsertPlaylistMock(mock: typeof crab.upsertPlaylist) {
  (crab as { upsertPlaylist: typeof crab.upsertPlaylist }).upsertPlaylist = mock;
}

function setGetMetaInfoMock(mock: typeof crab.getMetaInfo) {
  (crab as { getMetaInfo: typeof crab.getMetaInfo }).getMetaInfo = mock;
}

function setSetCollectionUpdatesMock(mock: typeof crab.setCollectionUpdates) {
  (crab as { setCollectionUpdates: typeof crab.setCollectionUpdates }).setCollectionUpdates = mock;
}

function setRemoveExcludeMock(mock: typeof crab.removeExclude) {
  (crab as { removeExclude: typeof crab.removeExclude }).removeExclude = mock;
}

function setUpdateMusicMock(mock: typeof crab.updateMusic) {
  (crab as { updateMusic: typeof crab.updateMusic }).updateMusic = mock;
}

function setLoadSpectrumMusicContextMock(mock: typeof crab.loadSpectrumMusicContext) {
  (
    crab as { loadSpectrumMusicContext: typeof crab.loadSpectrumMusicContext }
  ).loadSpectrumMusicContext = mock;
}

function setPlayPlaylistMock(mock: typeof crab.playPlaylist) {
  (crab as { playPlaylist: typeof crab.playPlaylist }).playPlaylist = mock;
}

function setExcludeCurrentMusicAndSkipMock(mock: typeof crab.excludeCurrentMusicAndSkip) {
  (
    crab as { excludeCurrentMusicAndSkip: typeof crab.excludeCurrentMusicAndSkip }
  ).excludeCurrentMusicAndSkip = mock;
}

function setGetPlaybackStatusMock(mock: typeof crab.getPlaybackStatus) {
  (crab as { getPlaybackStatus: typeof crab.getPlaybackStatus }).getPlaybackStatus = mock;
}

function setResumePlaybackMock(mock: typeof crab.resumePlayback) {
  (crab as { resumePlayback: typeof crab.resumePlayback }).resumePlayback = mock;
}

function setEnterSpectrumPlaybackScopeMock(mock: typeof crab.enterSpectrumPlaybackScope) {
  (
    crab as { enterSpectrumPlaybackScope: typeof crab.enterSpectrumPlaybackScope }
  ).enterSpectrumPlaybackScope = mock;
}

function setExitSpectrumPlaybackScopeMock(mock: typeof crab.exitSpectrumPlaybackScope) {
  (
    crab as { exitSpectrumPlaybackScope: typeof crab.exitSpectrumPlaybackScope }
  ).exitSpectrumPlaybackScope = mock;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return {
    promise,
    resolve,
  };
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

async function waitForPredicate(predicate: () => boolean, message: string, timeoutMs = 1000) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error(message);
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  setGetMetaInfoMock(async () => Ok({ save_path: sampleSavePath }));
  setListPlaylistsMock(async () => Ok([]));
  setListConfigLibraryMock(async () => Ok(createConfigLibrary([sampleCollection])));
});

afterEach(() => {
  setCheckListMock(originalCheckList);
  setListPlaylistsMock(originalListPlaylists);
  (crab as { getPlaylist: typeof crab.getPlaylist }).getPlaylist = originalGetPlaylist;
  setGetPlaylistConfigMock(originalGetPlaylistConfig);
  setListConfigLibraryMock(originalListConfigLibrary);
  setUpsertPlaylistMock(originalUpsertPlaylist);
  setGetMetaInfoMock(originalGetMetaInfo);
  setSetCollectionUpdatesMock(originalSetCollectionUpdates);
  setRemoveExcludeMock(originalRemoveExclude);
  setUpdateMusicMock(originalUpdateMusic);
  setLoadSpectrumMusicContextMock(originalLoadSpectrumMusicContext);
  setPlayPlaylistMock(originalPlayPlaylist);
  setExcludeCurrentMusicAndSkipMock(originalExcludeCurrentMusicAndSkip);
  setGetPlaybackStatusMock(originalGetPlaybackStatus);
  setResumePlaybackMock(originalResumePlayback);
  setEnterSpectrumPlaybackScopeMock(originalEnterSpectrumPlaybackScope);
  setExitSpectrumPlaybackScopeMock(originalExitSpectrumPlaybackScope);
});

describe("createConfigSidebarItems", () => {
  test("prefers collections over groups when display names overlap", () => {
    expect(createConfigSidebarItems([sampleCollection])).toEqual(expectedConfigSidebarItems);
  });
});

describe("appLogic machine", () => {
  test("starts idle and resolves to ready with playlist presence", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));

    const actor = createActor(machine);
    actor.start();

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.idle);
    expect(actor.getSnapshot().context).toEqual(createExpectedAppLogicContext());

    actor.send(sig.mainx.run);
    await waitForState(actor, ss.mainx.State.ready);

    expect(actor.getSnapshot().context).toEqual(
      createExpectedAppLogicContext({
        hasPlayList: true,
        playlists: [createPlaylistSurface(samplePlaylist)],
        configLibrary: createConfigLibrary([sampleCollection]),
        savePath: sampleSavePath,
      }),
    );
  });

  test("keeps ready state even when playlist table is empty", async () => {
    setCheckListMock(async () => Ok(false));

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

  test("returns from a changed create draft without waiting for the playlist commit", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    const committedPlaylist: PlayListListView = {
      name: "New Draft",
      created_at: "2026-04-18T00:00:00Z",
    };
    const playCalls: string[] = [];
    setPlayPlaylistMock(async (name) => {
      playCalls.push(name);
      return Ok({
        status: "started",
        playlist_name: name,
        track_count: 1,
      });
    });

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
      createdAt: null,
    });
    expect(actor.getSnapshot().context.draftBaseline).toEqual({
      mode: "create",
      name: "",
      collections: [],
      groups: [],
      createdAt: null,
    });

    actor.send(draftNameChanged.load("New Draft"));
    expect(actor.getSnapshot().context.draft?.name).toBe("New Draft");

    actor.send(
      payloads["playlist.preview.changed"].load({
        playlist: {
          name: "New Draft",
          created_at: null,
        },
        previousName: null,
        draft: {
          mode: "create",
          name: "New Draft",
          collections: [],
          groups: [],
          createdAt: null,
        },
      }),
    );
    actor.send(sig.mainx.back);
    await waitForState(actor, ss.mainx.State.ready);

    expect(actor.getSnapshot().context.playlists).toEqual([createPlaylistSurface(samplePlaylist)]);
    expect(actor.getSnapshot().context.pendingPlaylistPreview).toEqual({
      playlist: {
        name: "New Draft",
        created_at: null,
      },
      previousName: null,
      draft: {
        mode: "create",
        name: "New Draft",
        collections: [],
        groups: [],
        createdAt: null,
      },
    });
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

    actor.send(
      payloads["playlist.upserted"].load({
        playlist: committedPlaylist,
        previousName: null,
      }),
    );

    expect(actor.getSnapshot().context.playlists).toEqual([
      createPlaylistSurface(samplePlaylist),
      committedPlaylist,
    ]);
    expect(actor.getSnapshot().context.pendingPlaylistPreview).toBeNull();

    actor.send(payloads["playlist.play"].load(committedPlaylist.name));
    await waitForState(actor, ss.mainx.State.play);
    expect(playCalls).toEqual([committedPlaylist.name]);
    expect(actor.getSnapshot().context.playingPlaylistName).toBe(committedPlaylist.name);
  });

  test("commits a created playlist with selected library refs before immediate playback", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    const committedPlaylist: PlayListListView = {
      name: "Playlist 3",
      created_at: "2026-04-18T00:00:00Z",
    };
    const playCalls: string[] = [];
    let listPlaylistCalls = 0;

    setListPlaylistsMock(async () => {
      listPlaylistCalls += 1;
      return Ok([createPlaylistSurface(samplePlaylist)]);
    });
    setPlayPlaylistMock(async (name) => {
      playCalls.push(name);
      return Ok({
        status: "started",
        playlist_name: name,
        track_count: 1,
      });
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    expect(listPlaylistCalls).toBe(1);

    actor.send(sig.mainx.opencreate);
    actor.send(
      draftItemIncluded.load({
        kind: "collection",
        url: sampleCollection.url,
      }),
    );
    actor.send(draftNameChanged.load("Playlist 3"));
    actor.send(
      payloads["playlist.preview.changed"].load({
        playlist: {
          name: "Playlist 3",
          created_at: null,
        },
        previousName: null,
        draft: {
          mode: "create",
          name: "Playlist 3",
          collections: [createCollectionDraftRef(sampleCollection)],
          groups: [],
          createdAt: null,
        },
      }),
    );
    actor.send(sig.mainx.back);

    await waitForState(actor, ss.mainx.State.ready);

    expect(actor.getSnapshot().context.pendingPlaylistPreview).toEqual({
      playlist: {
        name: "Playlist 3",
        created_at: null,
      },
      previousName: null,
      draft: {
        mode: "create",
        name: "Playlist 3",
        collections: [createCollectionDraftRef(sampleCollection)],
        groups: [],
        createdAt: null,
      },
    });
    expect(actor.getSnapshot().context.playlists).toEqual([createPlaylistSurface(samplePlaylist)]);
    expect(listPlaylistCalls).toBe(1);

    actor.send(payloads["playlist.play"].load("Playlist 3"));
    expect(actor.getSnapshot().value).toBe(ss.mainx.State.ready);
    expect(playCalls).toEqual([]);
    expect(actor.getSnapshot().context.pendingPlaylistPlaybackName).toBe("Playlist 3");
    expect(actor.getSnapshot().context.playingPlaylistName).toBeNull();

    actor.send(
      payloads["playlist.upserted"].load({
        playlist: committedPlaylist,
        previousName: null,
      }),
    );
    await waitForContext(
      actor,
      (context: { shouldStartPlayback: boolean }) => context.shouldStartPlayback,
    );
    expect(actor.getSnapshot().context.playlists).toEqual([
      createPlaylistSurface(samplePlaylist),
      committedPlaylist,
    ]);
    expect(actor.getSnapshot().context.pendingPlaylistPreview).toBeNull();
    expect(listPlaylistCalls).toBe(1);
    expect(actor.getSnapshot().context.pendingPlaylistPlaybackName).toBeNull();
    expect(actor.getSnapshot().context.playingPlaylistName).toBe(committedPlaylist.name);
    expect(playCalls).toEqual([committedPlaylist.name]);
    expect(actor.getSnapshot().context.playlists).toEqual([
      createPlaylistSurface(samplePlaylist),
      committedPlaylist,
    ]);

    actor.send(sig.mainx.back);
    await waitForState(actor, ss.mainx.State.ready);

    expect(actor.getSnapshot().context.playlists).toEqual([
      createPlaylistSurface(samplePlaylist),
      committedPlaylist,
    ]);
    expect(listPlaylistCalls).toBe(1);
  });

  test("returns placeholder handoff tone when backing out of an empty create draft", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));

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

  test("returns from an edited playlist with a preview until the background commit finishes", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setGetPlaylistConfigMock(async () =>
      Ok({
        name: samplePlaylist.name,
        collections: samplePlaylist.collections.map((collection) => ({
          name: collection.name,
          url: collection.url,
          folder: collection.folder,
          last_updated: collection.last_updated,
          enable_updates: collection.enable_updates,
        })),
        groups: samplePlaylist.groups,
        created_at: samplePlaylist.created_at,
      }),
    );
    const renamedPlaylist = {
      ...samplePlaylist,
      name: "Renamed Session",
    };
    const committedPlaylist = createPlaylistSurface(renamedPlaylist);

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(openPlaylist.load(samplePlaylist.name));
    await waitForState(actor, ss.mainx.State.config);

    actor.send(draftNameChanged.load(renamedPlaylist.name));
    actor.send(
      payloads["playlist.preview.changed"].load({
        playlist: {
          name: renamedPlaylist.name,
          created_at: samplePlaylist.created_at,
        },
        previousName: samplePlaylist.name,
        draft: {
          mode: "edit",
          name: renamedPlaylist.name,
          collections: samplePlaylist.collections.map(createCollectionDraftRef),
          groups: samplePlaylist.groups,
          createdAt: samplePlaylist.created_at,
        },
      }),
    );
    actor.send(sig.mainx.back);

    await waitForState(actor, ss.mainx.State.ready);
    expect(actor.getSnapshot().context.playlists).toEqual([createPlaylistSurface(samplePlaylist)]);
    expect(actor.getSnapshot().context.pendingPlaylistPreview).toEqual({
      playlist: {
        name: renamedPlaylist.name,
        created_at: samplePlaylist.created_at,
      },
      previousName: samplePlaylist.name,
      draft: {
        mode: "edit",
        name: renamedPlaylist.name,
        collections: samplePlaylist.collections.map(createCollectionDraftRef),
        groups: samplePlaylist.groups,
        createdAt: samplePlaylist.created_at,
      },
    });

    actor.send(
      payloads["playlist.upserted"].load({
        playlist: committedPlaylist,
        previousName: samplePlaylist.name,
      }),
    );

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.ready);
    expect(actor.getSnapshot().context.playlists).toEqual([committedPlaylist]);
    expect(actor.getSnapshot().context.pendingPlaylistPreview).toBeNull();
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: playlistTitleLayoutId(renamedPlaylist.name),
      tone: "solid",
    });
  });

  test("clears a failed playlist commit preview without publishing a stable list item", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(sig.mainx.opencreate);
    actor.send(draftNameChanged.load("Playlist 3"));
    actor.send(
      payloads["playlist.preview.changed"].load({
        playlist: {
          name: "Playlist 3",
          created_at: null,
        },
        previousName: null,
        draft: {
          mode: "create",
          name: "Playlist 3",
          collections: [],
          groups: [],
          createdAt: null,
        },
      }),
    );
    actor.send(sig.mainx.back);

    await waitForState(actor, ss.mainx.State.ready);
    expect(actor.getSnapshot().context.pendingPlaylistPreview?.playlist.name).toBe("Playlist 3");

    actor.send(payloads["playlist.preview.changed"].load(null));

    expect(actor.getSnapshot().context.playlists).toEqual([createPlaylistSurface(samplePlaylist)]);
    expect(actor.getSnapshot().context.pendingPlaylistPreview).toBeNull();
    expect(actor.getSnapshot().context.draft).toBeNull();
    expect(actor.getSnapshot().context.error).toBeNull();
  });

  test("keeps savePath in context across config transitions and updates", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));

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
    expect(actor.getSnapshot().context.playlists).toEqual([createPlaylistSurface(samplePlaylist)]);
    expect(actor.getSnapshot().context.savePath).toBe("D:\\MediaLibrary");
  });

  test("loads an existing playlist into config state by name", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setGetPlaylistConfigMock(async (name) => {
      expect(name).toBe(samplePlaylist.name);
      return Ok({
        name: samplePlaylist.name,
        collections: samplePlaylist.collections.map((collection) => ({
          name: collection.name,
          url: collection.url,
          folder: collection.folder,
          last_updated: collection.last_updated,
          enable_updates: collection.enable_updates,
        })),
        groups: samplePlaylist.groups,
        created_at: samplePlaylist.created_at,
      });
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
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: playlistTitleLayoutId(samplePlaylist.name),
      tone: "solid",
    });
    expect(actor.getSnapshot().context.pendingPlaylistName).toBeNull();
    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "edit",
      name: samplePlaylist.name,
      collections: samplePlaylist.collections.map((collection) => ({
        ...createCollectionDraftRef(collection),
      })),
      groups: samplePlaylist.groups,
      createdAt: samplePlaylist.created_at,
    });
    expect(actor.getSnapshot().context.draftBaseline).toEqual({
      mode: "edit",
      name: samplePlaylist.name,
      collections: samplePlaylist.collections.map((collection) => ({
        ...createCollectionDraftRef(collection),
      })),
      groups: samplePlaylist.groups,
      createdAt: samplePlaylist.created_at,
    });
  });

  test("upserts synced collections into config context and refreshes sidebar items", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(sig.mainx.opencreate);
    actor.send(collectionUpserted.load(syncedCollection));

    expect(actor.getSnapshot().context.collections).toEqual([syncedCollection]);
    expect(actor.getSnapshot().context.playlists).toEqual([createPlaylistSurface(samplePlaylist)]);
    expect(currentConfigSidebarItems(actor)).toEqual([
      {
        kind: "collection",
        name: syncedCollection.name,
        url: syncedCollection.url,
        folder: syncedCollection.folder,
        last_updated: syncedCollection.last_updated,
        enable_updates: syncedCollection.enable_updates,
      },
      ...expectedConfigSidebarItems,
    ]);
  });

  test("upserts synced collections into the active draft so saving uses canonical data", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(sig.mainx.opencreate);
    actor.send(draftCollectionUpserted.load(syncedCollection));

    expect(actor.getSnapshot().context.collections).toEqual([syncedCollection]);
    expect(actor.getSnapshot().context.playlists).toEqual([createPlaylistSurface(samplePlaylist)]);
    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "create",
      name: "",
      collections: [createCollectionDraftRef(syncedCollection)],
      groups: [],
      createdAt: null,
    });
    expect(actor.getSnapshot().context.draftBaseline).toEqual({
      mode: "create",
      name: "",
      collections: [],
      groups: [],
      createdAt: null,
    });
    expect(currentConfigSidebarItems(actor)).toEqual([
      {
        kind: "collection",
        name: syncedCollection.name,
        url: syncedCollection.url,
        folder: syncedCollection.folder,
        last_updated: syncedCollection.last_updated,
        enable_updates: syncedCollection.enable_updates,
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
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setSetCollectionUpdatesMock(async (url, enabled) => {
      expect(url).toBe(sampleCollection.url);
      expect(enabled).toBe(true);
      return Ok(updateEnabledCollection);
    });

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    setGetPlaylistConfigMock(async () =>
      Ok({
        name: samplePlaylist.name,
        collections: samplePlaylist.collections.map((collection) => ({
          name: collection.name,
          url: collection.url,
          folder: collection.folder,
          last_updated: collection.last_updated,
          enable_updates: collection.enable_updates,
        })),
        groups: samplePlaylist.groups,
        created_at: samplePlaylist.created_at,
      }),
    );
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
      collections: [createCollectionDraftRef(updateEnabledCollection)],
      groups: samplePlaylist.groups,
      createdAt: samplePlaylist.created_at,
    });
    expect(actor.getSnapshot().context.draftBaseline).toEqual({
      mode: "edit",
      name: samplePlaylist.name,
      collections: samplePlaylist.collections.map(createCollectionDraftRef),
      groups: samplePlaylist.groups,
      createdAt: samplePlaylist.created_at,
    });
  });

  test("removes exclude entries from config library after the domain command succeeds", async () => {
    let removeCalls = 0;
    const initialLibrary: ConfigLibraryView = {
      ...createConfigLibrary([sampleCollection]),
      excludes: [
        {
          music: sampleExcludedMusic,
          created_at: "2026-05-20T00:00:00Z",
        },
      ],
    };

    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setListConfigLibraryMock(async () => Ok(initialLibrary));
    setRemoveExcludeMock(async (music) => {
      removeCalls += 1;
      expect(music).toEqual(sampleExcludedMusic);
      return Ok({
        removed: true,
        exclude_availability: createEmptyExcludeAvailability(),
      });
    });

    const mod = await import(`../src/flow/appLogic/index.ts?case=remove-exclude-${Date.now()}`);

    try {
      mod.ensureAppLogicStarted();
      await waitForState(mod.actor, ss.mainx.State.ready);
      expect(mod.actor.getSnapshot().context.configLibrary.excludes).toHaveLength(1);

      const didRemove = await mod.action.removeExclude(sampleExcludedMusic);

      expect(didRemove).toBe(true);
      expect(removeCalls).toBe(1);
      expect(mod.actor.getSnapshot().context.configLibrary.excludes).toEqual([]);
    } finally {
      mod.stop();
    }
  });

  test("pushes a sidebar item into the draft through appLogic instead of local ui state", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(sig.mainx.opencreate);
    actor.send(collectionUpserted.load(syncedCollection));

    actor.send(
      draftItemIncluded.load({
        kind: "collection",
        url: syncedCollection.url,
      }),
    );

    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "create",
      name: "",
      collections: [createCollectionDraftRef(syncedCollection)],
      groups: [],
      createdAt: null,
    });
    expect(actor.getSnapshot().context.draftBaseline).toEqual({
      mode: "create",
      name: "",
      collections: [],
      groups: [],
      createdAt: null,
    });

    actor.send(draftItemIncluded.load(sampleGroupSidebarItemRef));

    expect(actor.getSnapshot().context.draft).toEqual({
      mode: "create",
      name: "",
      collections: [createCollectionDraftRef(syncedCollection)],
      groups: [
        {
          name: "Disc 1",
          url: sampleGroupSidebarItemRef.url,
          folder: "Disc 1",
        },
      ],
      createdAt: null,
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
      createdAt: null,
    });
    expect(actor.getSnapshot().context.draftBaseline).toEqual({
      mode: "create",
      name: "",
      collections: [],
      groups: [],
      createdAt: null,
    });
  });

  test("opens spectrum from playback and returns without restarting playback", async () => {
    let playCalls = 0;

    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setLoadSpectrumMusicContextMock(async () =>
      Ok(createSpectrumMusicContext([sampleCollection.musics[1]!])),
    );
    setPlayPlaylistMock(async (name) => {
      playCalls += 1;
      expect(name).toBe(samplePlaylist.name);
      return Ok({
        status: "started",
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
        file_path:
          "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
        start_ms: 0,
        end_ms: 120_000,
      }),
    );
    const listMusicsDeferred = deferred();
    setLoadSpectrumMusicContextMock(async () => {
      await listMusicsDeferred.promise;
      return Ok(createSpectrumMusicContext([sampleCollection.musics[1]!]));
    });
    actor.send(sig.mainx.openspectrum);

    await waitForState(actor, ss.mainx.State.spectrum);
    expect(actor.getSnapshot().context.spectrumMusicDrafts).toEqual([
      {
        kind: "persisted" as const,
        baselineName: "Disc 1 Opening",
        baselineStartMs: 0,
        baselineEndMs: 120_000,
        name: "Disc 1 Opening",
        url: "https://example.com/quiet-morning#disc-1-opening",
        startMs: 0,
        endMs: 120_000,
      },
    ]);
    listMusicsDeferred.resolve();
    await waitForContext(
      actor,
      (context: { spectrumMusicSourceContext: unknown }) =>
        context.spectrumMusicSourceContext !== null,
    );

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.spectrum);
    expect(actor.getSnapshot().context).toEqual(
      createExpectedAppLogicContext({
        hasPlayList: true,
        playlists: [createPlaylistSurface(samplePlaylist)],
        configLibrary: createConfigLibrary([sampleCollection]),
        savePath: sampleSavePath,
        playingPlaylistName: samplePlaylist.name,
        nowPlayingTrackName: "Disc 1 Opening",
        nowPlayingTrackUrl: "https://example.com/quiet-morning#disc-1-opening",
        nowPlayingTrackFilePath:
          "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
        nowPlayingTrackStartMs: 0,
        nowPlayingTrackEndMs: 120_000,
        spectrumMusicDrafts: [
          {
            kind: "persisted" as const,
            baselineName: "Disc 1 Opening",
            baselineStartMs: 0,
            baselineEndMs: 120_000,
            name: "Disc 1 Opening",
            url: "https://example.com/quiet-morning#disc-1-opening",
            startMs: 0,
            endMs: 120_000,
          },
        ],
        spectrumMusicSourceContext: createSpectrumMusicSourceContext(sampleCollection.musics[1]!),
        shouldStartPlayback: false,
        activeLayoutId: playlistTitleLayoutId(samplePlaylist.name),
      }),
    );

    actor.send(sig.mainx.back);
    await waitForState(actor, ss.mainx.State.play);

    expect(playCalls).toBe(1);
    expect(actor.getSnapshot().context.playingPlaylistName).toBe(samplePlaylist.name);
    expect(actor.getSnapshot().context.shouldStartPlayback).toBe(false);
    expect(actor.getSnapshot().context.spectrumMusicSourceContext).toBe(null);
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: playlistTitleLayoutId(samplePlaylist.name),
      tone: "solid",
    });
  });

  test("keeps early spectrum range edits when music context loading finishes later", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setPlayPlaylistMock(async () =>
      Ok({
        status: "started",
        playlist_name: samplePlaylist.name,
        track_count: 2,
      }),
    );

    const listMusicsDeferred = deferred();
    setLoadSpectrumMusicContextMock(async () => {
      await listMusicsDeferred.promise;
      return Ok(
        createSpectrumMusicContext([sampleCollection.musics[1]!, sampleCollection.musics[0]!]),
      );
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
        file_path:
          "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
        start_ms: 0,
        end_ms: 120_000,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, ss.mainx.State.spectrum);

    actor.send(
      payloads["spectrum.music_range.changed"].load({
        id: "https://example.com/quiet-morning#disc-1-opening|0|120000",
        startMs: 8_250,
        endMs: 112_750,
      }),
    );

    expect(actor.getSnapshot().context.spectrumMusicDrafts).toEqual([
      {
        kind: "persisted" as const,
        baselineName: "Disc 1 Opening",
        baselineStartMs: 0,
        baselineEndMs: 120_000,
        name: "Disc 1 Opening",
        url: "https://example.com/quiet-morning#disc-1-opening",
        startMs: 8_250,
        endMs: 112_750,
      },
    ]);

    listMusicsDeferred.resolve();
    await waitForContext(
      actor,
      (context: { spectrumMusicDrafts: unknown[]; spectrumMusicSourceContext: unknown }) =>
        context.spectrumMusicDrafts.length === 2 && context.spectrumMusicSourceContext !== null,
    );

    expect(actor.getSnapshot().context.spectrumMusicDrafts).toEqual([
      {
        kind: "persisted" as const,
        baselineName: "Disc 1 Opening",
        baselineStartMs: 0,
        baselineEndMs: 120_000,
        name: "Disc 1 Opening",
        url: "https://example.com/quiet-morning#disc-1-opening",
        startMs: 8_250,
        endMs: 112_750,
      },
      {
        kind: "persisted" as const,
        baselineName: "Quiet Morning",
        baselineStartMs: 0,
        baselineEndMs: 120_000,
        name: "Quiet Morning",
        url: "https://example.com/quiet-morning#title",
        startMs: 0,
        endMs: 120_000,
      },
    ]);
  });

  test("renders a new spectrum music draft immediately and fills source evidence after loading", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setPlayPlaylistMock(async () =>
      Ok({
        status: "started",
        playlist_name: samplePlaylist.name,
        track_count: 2,
      }),
    );

    const listMusicsDeferred = deferred();
    setLoadSpectrumMusicContextMock(async () => {
      await listMusicsDeferred.promise;
      return Ok(createSpectrumMusicContext([sampleCollection.musics[1]!]));
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
        file_path:
          "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
        start_ms: 0,
        end_ms: 120_000,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, ss.mainx.State.spectrum);

    actor.send(
      spectrumMusicCreateStarted.load({
        id: "new|https://example.com/quiet-morning#disc-1-opening",
      }),
    );
    expect(actor.getSnapshot().context.pendingSpectrumMusicCreateId).toBe(null);
    expect(actor.getSnapshot().context.spectrumMusicDrafts).toEqual([
      {
        kind: "persisted" as const,
        baselineName: "Disc 1 Opening",
        baselineStartMs: 0,
        baselineEndMs: 120_000,
        name: "Disc 1 Opening",
        url: "https://example.com/quiet-morning#disc-1-opening",
        startMs: 0,
        endMs: 120_000,
      },
      {
        kind: "pending-create" as const,
        baselineName: "",
        baselineStartMs: null,
        baselineEndMs: null,
        name: "",
        url: "https://example.com/quiet-morning#disc-1-opening#spectrum#0#120000#",
        startMs: 0,
        endMs: 120_000,
        sourceCollectionUrl: null,
        sourceEndMs: 120_000,
        sourceGroup: null,
        sourcePath: null,
        sourceUrl: "https://example.com/quiet-morning#disc-1-opening",
      },
    ]);
    actor.send(
      spectrumMusicNameChanged.load({
        id: "new|https://example.com/quiet-morning#disc-1-opening",
        name: "Draft Opening",
      }),
    );

    listMusicsDeferred.resolve();
    await waitForContext(
      actor,
      (context: { spectrumMusicSourceContext: unknown }) =>
        context.spectrumMusicSourceContext !== null,
    );

    const pendingDraft = actor.getSnapshot().context.spectrumMusicDrafts.at(-1);
    expect(pendingDraft).toEqual({
      kind: "pending-create" as const,
      baselineName: "",
      baselineStartMs: null,
      baselineEndMs: null,
      name: "Draft Opening",
      url: "https://example.com/quiet-morning#disc-1-opening#spectrum#0#120000#",
      startMs: 0,
      endMs: 120_000,
      sourceCollectionUrl: sampleCollection.url,
      sourceEndMs: 120_000,
      sourceGroup: sampleCollection.musics[1]!.group,
      sourcePath: sampleCollection.musics[1]!.path,
      sourceUrl: "https://example.com/quiet-morning#disc-1-opening",
    });
  });

  test("returns to playback when back is clicked before spectrum music context loading finishes", async () => {
    let playCalls = 0;

    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setPlayPlaylistMock(async (name) => {
      playCalls += 1;
      expect(name).toBe(samplePlaylist.name);
      return Ok({
        status: "started",
        playlist_name: samplePlaylist.name,
        track_count: 2,
      });
    });

    const listMusicsDeferred = deferred();
    setLoadSpectrumMusicContextMock(async () => {
      await listMusicsDeferred.promise;
      return Ok(createSpectrumMusicContext([sampleCollection.musics[1]!]));
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
        file_path:
          "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
        start_ms: 0,
        end_ms: 120_000,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, ss.mainx.State.spectrum);

    actor.send(sig.mainx.back);
    await waitForState(actor, ss.mainx.State.play);

    expect(actor.getSnapshot().context).toEqual(
      createExpectedAppLogicContext({
        hasPlayList: true,
        playlists: [createPlaylistSurface(samplePlaylist)],
        configLibrary: createConfigLibrary([sampleCollection]),
        savePath: sampleSavePath,
        playingPlaylistName: samplePlaylist.name,
        nowPlayingTrackName: "Disc 1 Opening",
        nowPlayingTrackUrl: "https://example.com/quiet-morning#disc-1-opening",
        nowPlayingTrackFilePath:
          "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
        nowPlayingTrackStartMs: 0,
        nowPlayingTrackEndMs: 120_000,
        spectrumPlaybackScopeId: null,
        shouldStartPlayback: false,
        activeLayoutId: null,
        titleToneHandoff: {
          layoutId: playlistTitleLayoutId(samplePlaylist.name),
          tone: "solid",
        },
      }),
    );

    listMusicsDeferred.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(actor.getSnapshot().value).toBe(ss.mainx.State.play);
    expect(actor.getSnapshot().context.spectrumMusicSourceContext).toBe(null);
    expect(playCalls).toBe(1);
  });

  test("adds sibling spectrum drafts after the active playback title can already share layout", async () => {
    const listMusicsDeferred = deferred();

    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setLoadSpectrumMusicContextMock(async () => {
      await listMusicsDeferred.promise;
      return Ok(
        createSpectrumMusicContext([sampleCollection.musics[1]!, sampleCollection.musics[0]!]),
      );
    });
    setPlayPlaylistMock(async () =>
      Ok({
        status: "started",
        playlist_name: samplePlaylist.name,
        track_count: 2,
      }),
    );

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
        file_path:
          "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
        start_ms: 0,
        end_ms: 120_000,
      }),
    );
    actor.send(sig.mainx.openspectrum);

    await waitForState(actor, ss.mainx.State.spectrum);
    expect(actor.getSnapshot().context.activeLayoutId).toBe(
      playlistTitleLayoutId(samplePlaylist.name),
    );
    expect(actor.getSnapshot().context.spectrumMusicDrafts).toHaveLength(1);
    expect(actor.getSnapshot().context.spectrumMusicDrafts[0]?.name).toBe("Disc 1 Opening");

    listMusicsDeferred.resolve();
    await waitForContext(
      actor,
      (context: { spectrumMusicDrafts: unknown[] }) => context.spectrumMusicDrafts.length === 2,
    );

    expect(actor.getSnapshot().context.spectrumMusicDrafts.map((draft) => draft.name)).toEqual([
      "Disc 1 Opening",
      "Quiet Morning",
    ]);
  });

  test("commits edited spectrum music title back to the current playback data", async () => {
    let musicUpdateCalls = 0;

    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setLoadSpectrumMusicContextMock(async () =>
      Ok(createSpectrumMusicContext([sampleCollection.musics[1]!])),
    );
    setPlayPlaylistMock(async () =>
      Ok({
        status: "started",
        playlist_name: samplePlaylist.name,
        track_count: 2,
      }),
    );
    setUpdateMusicMock(async (url, start, end, alias, nextStart, nextEnd) => {
      musicUpdateCalls += 1;
      expect(url).toBe("https://example.com/quiet-morning#disc-1-opening");
      expect(start).toBe(0);
      expect(end).toBe(120_000);
      expect(alias).toBe("Disc 1 Prelude");
      expect(nextStart).toBe(0);
      expect(nextEnd).toBe(120_000);
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
        file_path:
          "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
        start_ms: 0,
        end_ms: 120_000,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, ss.mainx.State.spectrum);
    actor.send(
      spectrumMusicNameChanged.load({
        id: "https://example.com/quiet-morning#disc-1-opening|0|120000",
        name: "Disc 1 Prelude",
      }),
    );
    actor.send(sig.mainx.back);

    await waitForState(actor, ss.mainx.State.play);

    expect(musicUpdateCalls).toBe(1);
    expect(actor.getSnapshot().context.nowPlayingTrackName).toBe("Disc 1 Prelude");
    expect(actor.getSnapshot().context.spectrumMusicDrafts).toEqual([]);
    expect(actor.getSnapshot().context.collections).toEqual([]);
    expect(actor.getSnapshot().context.playlists).toEqual([createPlaylistSurface(samplePlaylist)]);
    expect(actor.getSnapshot().context.titleToneHandoff).toEqual({
      layoutId: playlistTitleLayoutId(samplePlaylist.name),
      tone: "solid",
    });
  });

  test("commits edited spectrum music range from the original music identity", async () => {
    let musicUpdateCalls = 0;

    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setLoadSpectrumMusicContextMock(async () =>
      Ok(createSpectrumMusicContext([sampleCollection.musics[1]!])),
    );
    setPlayPlaylistMock(async () =>
      Ok({
        status: "started",
        playlist_name: samplePlaylist.name,
        track_count: 2,
      }),
    );
    setUpdateMusicMock(async (url, start, end, alias, nextStart, nextEnd) => {
      musicUpdateCalls += 1;
      expect(url).toBe("https://example.com/quiet-morning#disc-1-opening");
      expect(start).toBe(0);
      expect(end).toBe(120_000);
      expect(alias).toBe("Disc 1 Opening");
      expect(nextStart).toBe(8_250);
      expect(nextEnd).toBe(112_750);
      return Ok({
        ...sampleCollection.musics[1]!,
        start_ms: nextStart,
        end_ms: nextEnd,
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
        file_path:
          "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
        start_ms: 0,
        end_ms: 120_000,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, ss.mainx.State.spectrum);
    actor.send(
      payloads["spectrum.music_range.changed"].load({
        id: "https://example.com/quiet-morning#disc-1-opening|0|120000",
        startMs: 8_250,
        endMs: 112_750,
      }),
    );
    actor.send(sig.mainx.back);

    await waitForState(actor, ss.mainx.State.play);

    expect(musicUpdateCalls).toBe(1);
    expect(actor.getSnapshot().context.nowPlayingTrackStartMs).toBe(8_250);
    expect(actor.getSnapshot().context.nowPlayingTrackEndMs).toBe(112_750);
    expect(actor.getSnapshot().context.collections).toEqual([]);
    expect(actor.getSnapshot().context.playlists).toEqual([createPlaylistSurface(samplePlaylist)]);
  });

  test("moves to error when the requested playlist does not exist", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setGetPlaylistConfigMock(async () => Ok(null));

    const actor = createActor(machine);
    actor.start();
    actor.send(sig.mainx.run);

    await waitForState(actor, ss.mainx.State.ready);
    actor.send(openPlaylist.load("Missing"));
    await waitForState(actor, ss.mainx.State.error);

    expect(actor.getSnapshot().context).toEqual(
      createExpectedAppLogicContext({
        hasPlayList: true,
        playlists: [createPlaylistSurface(samplePlaylist)],
        configLibrary: createConfigLibrary([sampleCollection]),
        savePath: sampleSavePath,
        activeLayoutId: playlistTitleLayoutId("Missing"),
        titleToneHandoff: {
          layoutId: playlistTitleLayoutId("Missing"),
          tone: "solid",
        },
        error: "playlist `Missing` not found",
      }),
    );
  });
});

describe("ensureAppLogicStarted", () => {
  test("runs the startup check only once for the same module instance", async () => {
    let checkCalls = 0;
    let listPlaylistCalls = 0;
    let listConfigLibraryCalls = 0;
    setCheckListMock(async () => {
      checkCalls += 1;
      return Ok(true);
    });
    setListPlaylistsMock(async () => {
      listPlaylistCalls += 1;
      return Ok([createPlaylistSurface(samplePlaylist)]);
    });
    setListConfigLibraryMock(async () => {
      listConfigLibraryCalls += 1;
      return Ok(createConfigLibrary([sampleCollection]));
    });

    const mod = await import(`../src/flow/appLogic/index.ts?case=bootstrap-once`);

    try {
      mod.ensureAppLogicStarted();
      mod.ensureAppLogicStarted();

      await waitForState(mod.actor, ss.mainx.State.ready);

      expect(checkCalls).toBe(1);
      expect(listPlaylistCalls).toBe(1);
      expect(listConfigLibraryCalls).toBe(1);
      expect(mod.actor.getSnapshot().context).toEqual(
        createExpectedAppLogicContext({
          hasPlayList: true,
          playlists: [createPlaylistSurface(samplePlaylist)],
          configLibrary: createConfigLibrary([sampleCollection]),
          savePath: sampleSavePath,
        }),
      );
    } finally {
      mod.stop();
    }
  });
});

describe("appLogic action playback scope effects", () => {
  test("excludes current music and skips only when a concrete track is active", async () => {
    let excludeSkipCalls = 0;
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setPlayPlaylistMock(async () =>
      Ok({
        status: "started",
        playlist_name: samplePlaylist.name,
        track_count: 1,
      }),
    );
    setExcludeCurrentMusicAndSkipMock(async () => {
      excludeSkipCalls += 1;
      return Ok({
        status: "skipped",
        exclude: createExclude(sampleExcludedMusic),
        exclude_availability: createEmptyExcludeAvailability(),
      });
    });

    const mod = await import(`../src/flow/appLogic/index.ts?case=exclude-skip-${Date.now()}`);

    try {
      mod.ensureAppLogicStarted();
      await waitForState(mod.actor, ss.mainx.State.ready);

      mod.action.excludeCurrentMusicAndSkip();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(excludeSkipCalls).toBe(0);

      mod.action.playPlaylist(samplePlaylist.name);
      await waitForState(mod.actor, ss.mainx.State.play);

      mod.actor.send(
        payloads["player.now_playing_track.changed"].load({
          playlist_name: samplePlaylist.name,
          music_name: "Disc 1 Opening",
          music_url: "https://example.com/quiet-morning#disc-1-opening",
          file_path:
            "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
          start_ms: 0,
          end_ms: 120_000,
        }),
      );

      mod.action.excludeCurrentMusicAndSkip();
      await waitForPredicate(
        () => excludeSkipCalls === 1,
        "expected current track exclude skip request",
      );
      await waitForPredicate(
        () => mod.actor.getSnapshot().context.configLibrary.excludes.length === 1,
        "expected excluded music in config library",
      );
      expect(mod.actor.getSnapshot().context.configLibrary.excludes).toEqual([
        createExclude(sampleExcludedMusic),
      ]);
    } finally {
      mod.stop();
    }
  });

  test("removes the current playlist from play when excluding the final playable music", async () => {
    let excludeSkipCalls = 0;
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setPlayPlaylistMock(async () =>
      Ok({
        status: "started",
        playlist_name: samplePlaylist.name,
        track_count: 1,
      }),
    );
    setExcludeCurrentMusicAndSkipMock(async () => {
      excludeSkipCalls += 1;
      return Ok({
        status: "deleted_playlist",
        playlist_name: samplePlaylist.name,
        exclude: createExclude(sampleExcludedMusic),
        exclude_availability: createEmptyExcludeAvailability(),
      });
    });

    const mod = await import(
      `../src/flow/appLogic/index.ts?case=exclude-final-track-${Date.now()}`
    );

    try {
      mod.ensureAppLogicStarted();
      await waitForState(mod.actor, ss.mainx.State.ready);

      mod.action.playPlaylist(samplePlaylist.name);
      await waitForState(mod.actor, ss.mainx.State.play);
      mod.actor.send(
        payloads["player.now_playing_track.changed"].load({
          playlist_name: samplePlaylist.name,
          music_name: "Disc 1 Opening",
          music_url: "https://example.com/quiet-morning#disc-1-opening",
          file_path:
            "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
          start_ms: 0,
          end_ms: 120_000,
        }),
      );

      mod.action.excludeCurrentMusicAndSkip();
      await waitForState(mod.actor, ss.mainx.State.ready);

      expect(excludeSkipCalls).toBe(1);
      expect(mod.actor.getSnapshot().context).toEqual(
        createExpectedAppLogicContext({
          hasPlayList: false,
          playlists: [],
          configLibrary: {
            ...createConfigLibrary([sampleCollection]),
            excludes: [createExclude(sampleExcludedMusic)],
          },
          savePath: sampleSavePath,
        }),
      );
    } finally {
      mod.stop();
    }
  });

  test("keeps the newer spectrum scope after a delayed previous scope exit", async () => {
    setCheckListMock(async () => Ok(true));
    setListPlaylistsMock(async () => Ok([createPlaylistSurface(samplePlaylist)]));
    setLoadSpectrumMusicContextMock(async () =>
      Ok(createSpectrumMusicContext([sampleCollection.musics[1]!])),
    );
    setPlayPlaylistMock(async () =>
      Ok({
        status: "started",
        playlist_name: samplePlaylist.name,
        track_count: 1,
      }),
    );
    setGetPlaybackStatusMock(async () =>
      Ok({
        duration_ms: 120_000,
        music_url: "https://example.com/quiet-morning#disc-1-opening",
        path: "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
        paused: true,
        playback_end_ms: 120_000,
        playback_start_ms: 0,
        playing: true,
        playlist_name: samplePlaylist.name,
        position_ms: 0,
      }),
    );
    setResumePlaybackMock(async () => Ok(true));

    const exitRestore = deferred();
    const openedScopes = [42, 43];
    const enteredScopes: number[] = [];
    const exitedScopes: number[] = [];
    setEnterSpectrumPlaybackScopeMock(async () => {
      const scopeId = openedScopes.shift();
      if (scopeId === undefined) {
        throw new Error("unexpected extra spectrum scope entry");
      }
      enteredScopes.push(scopeId);
      return Ok(scopeId);
    });
    setExitSpectrumPlaybackScopeMock(async (scopeId) => {
      exitedScopes.push(scopeId);
      if (scopeId === 42) {
        await exitRestore.promise;
      }
      return Ok(null);
    });

    const mod = await import(`../src/flow/appLogic/index.ts?case=delayed-scope-${Date.now()}`);

    try {
      mod.ensureAppLogicStarted();
      await waitForState(mod.actor, ss.mainx.State.ready);

      mod.action.playPlaylist(samplePlaylist.name);
      await waitForState(mod.actor, ss.mainx.State.play);

      mod.actor.send(
        payloads["player.now_playing_track.changed"].load({
          playlist_name: samplePlaylist.name,
          music_name: "Disc 1 Opening",
          music_url: "https://example.com/quiet-morning#disc-1-opening",
          file_path:
            "C:\\Users\\admin\\Documents\\slisic\\youtube\\quiet-morning\\Disc 1\\opening.m4a",
          start_ms: 0,
          end_ms: 120_000,
        }),
      );

      mod.action.openSpectrum();
      await waitForPredicate(
        () => enteredScopes.length === 1 && enteredScopes[0] === 42,
        "expected spectrum entry to open scope 42",
      );
      await waitForState(mod.actor, ss.mainx.State.spectrum);
      expect(mod.actor.getSnapshot().context.spectrumPlaybackScopeId).toBe(42);

      mod.action.back();
      await waitForState(mod.actor, ss.mainx.State.play);
      await waitForPredicate(
        () => exitedScopes.length === 1 && exitedScopes[0] === 42,
        "expected spectrum exit to close scope 42",
      );

      mod.action.openSpectrum();
      expect(mod.actor.getSnapshot().value).toBe(ss.mainx.State.play);
      await waitForPredicate(
        () => enteredScopes.length === 2 && enteredScopes[1] === 43,
        "expected later spectrum entry to open scope 43",
      );
      await waitForState(mod.actor, ss.mainx.State.spectrum);
      expect(mod.actor.getSnapshot().context.spectrumPlaybackScopeId).toBe(43);

      exitRestore.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mod.actor.getSnapshot().context.spectrumPlaybackScopeId).toBe(43);
    } finally {
      exitRestore.resolve();
      mod.stop();
    }
  });
});
