import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Err, Ok } from "@grahlnn/fn";
import {
  loadCollectionsFromBackend,
  loadConfigChartFromBackend,
  resolvePlaylistPlaybackStartResult,
} from "./events";
import type { ConfigLibraryView, PlayListConfigView, PlayPlaylistSession } from "@/src/cmd";

function emptyConfigLibrary(): ConfigLibraryView {
  return {
    collections: [],
    groups: [],
    collection_group_memberships: [],
    excludes: [],
    exclude_availability: {
      fully_excluded_collection_urls: [],
      fully_excluded_group_urls: [],
    },
  };
}

describe("appLogic bootstrap events", () => {
  test("loads an empty bootstrap result when the database has no playlists", async () => {
    const backend = {
      getMetaInfo: async () => Ok({ save_path: "C:/Users/admin/Documents/slisic" }),
      checkList: async () => Ok(false),
      listPlaylists: async () => Err("empty database should not query playlists"),
      listConfigLibrary: async () => Err("empty database should not query config library"),
    };
    const result = await loadCollectionsFromBackend(backend);

    assert.deepEqual(result, {
      hasPlayList: false,
      playlists: [],
      collections: [],
      configLibrary: emptyConfigLibrary(),
      savePath: "C:/Users/admin/Documents/slisic",
    });
  });

  test("loads playlist surfaces without waiting for config library when playlist data exists", async () => {
    const configLibrary = emptyConfigLibrary();
    const playlists = [{ name: "PlayList 1", created_at: "2026-05-31T00:00:00+08:00" }];
    let configLibraryQueried = false;
    let playlistBootstrapReadyRecorded = 0;
    const backend = {
      getMetaInfo: async () => Ok({ save_path: "C:/Users/admin/Documents/slisic" }),
      checkList: async () => Ok(true),
      listPlaylists: async () => Ok(playlists),
      recordPlaylistBootstrapReady: async () => {
        playlistBootstrapReadyRecorded += 1;
      },
      listConfigLibrary: async () => {
        configLibraryQueried = true;
        return Ok(configLibrary);
      },
    };
    const result = await loadCollectionsFromBackend(backend);

    assert.deepEqual(result, {
      hasPlayList: true,
      playlists,
      collections: [],
      configLibrary: emptyConfigLibrary(),
      savePath: "C:/Users/admin/Documents/slisic",
    });
    assert.equal(configLibraryQueried, false);
    assert.equal(playlistBootstrapReadyRecorded, 1);
  });

  test("does not start playlist bootstrap warmup before playlist data exists", async () => {
    let playlistBootstrapReadyRecorded = 0;
    const backend = {
      getMetaInfo: async () => Ok({ save_path: "C:/Users/admin/Documents/slisic" }),
      checkList: async () => Ok(false),
      listPlaylists: async () => Err("empty database should not query playlists"),
      recordPlaylistBootstrapReady: async () => {
        playlistBootstrapReadyRecorded += 1;
      },
    };

    await loadCollectionsFromBackend(backend);

    assert.equal(playlistBootstrapReadyRecorded, 0);
  });
});

describe("appLogic config chart events", () => {
  test("loads create config chart data from config library", async () => {
    const configLibrary = emptyConfigLibrary();
    const result = await loadConfigChartFromBackend(
      { kind: "create" },
      {
        getPlaylistConfig: async () => Err("create should not query playlist config"),
        listConfigLibrary: async () => Ok(configLibrary),
      },
    );

    assert.deepEqual(result, {
      configLibrary,
      draft: {
        mode: "create",
        name: "",
        collections: [],
        groups: [],
        extra: [],
        createdAt: null,
      },
      draftBaseline: {
        mode: "create",
        name: "",
        collections: [],
        groups: [],
        extra: [],
        createdAt: null,
      },
    });
  });

  test("loads edit config chart data from config library and playlist config", async () => {
    const configLibrary = emptyConfigLibrary();
    const playlist: PlayListConfigView = {
      name: "PlayList 1",
      collections: [],
      groups: [],
      extra: [],
      created_at: "2026-05-31T00:00:00+08:00",
    };
    const result = await loadConfigChartFromBackend(
      { kind: "edit", playlistName: playlist.name },
      {
        getPlaylistConfig: async () => Ok(playlist),
        listConfigLibrary: async () => Ok(configLibrary),
      },
    );

    assert.deepEqual(result, {
      configLibrary,
      draft: {
        mode: "edit",
        name: playlist.name,
        collections: [],
        groups: [],
        extra: [],
        createdAt: playlist.created_at,
      },
      draftBaseline: {
        mode: "edit",
        name: playlist.name,
        collections: [],
        groups: [],
        extra: [],
        createdAt: playlist.created_at,
      },
    });
  });
});

describe("playlist playback start result", () => {
  test("preserves started sessions as valid playback evidence", () => {
    const session: PlayPlaylistSession = {
      playlist_name: "Focus Session",
      status: "started",
      session_generation: 1,
      track_count: 1,
      initial_track: null,
    };

    assert.deepEqual(resolvePlaylistPlaybackStartResult(session), {
      kind: "Valid",
      session,
    });
  });

  test("preserves pending first-track sessions as rejected morphism evidence", () => {
    const session: PlayPlaylistSession = {
      playlist_name: "Focus Session",
      status: "pending_first_track",
      session_generation: null,
      track_count: 0,
      initial_track: null,
    };

    assert.deepEqual(resolvePlaylistPlaybackStartResult(session), {
      kind: "Stops",
      reason: "pending_first_track",
      session,
    });
  });

  test("preserves superseded sessions as rejected morphism evidence", () => {
    const session: PlayPlaylistSession = {
      playlist_name: "Focus Session",
      status: "superseded",
      session_generation: null,
      track_count: 0,
      initial_track: null,
    };

    assert.deepEqual(resolvePlaylistPlaybackStartResult(session), {
      kind: "Stops",
      reason: "superseded",
      session,
    });
  });
});
