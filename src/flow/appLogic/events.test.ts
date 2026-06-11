import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Err, Ok } from "@grahlnn/fn";
import { loadCollectionsFromBackend, resolvePlaylistPlaybackStartResult } from "./events";
import type { ConfigLibraryView, PlayPlaylistSession } from "@/src/cmd";

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
    const result = await loadCollectionsFromBackend({
      getMetaInfo: async () => Ok({ save_path: "C:/Users/admin/Documents/slisic" }),
      checkList: async () => Ok(false),
      listPlaylists: async () => Err("empty database should not query playlists"),
      listConfigLibrary: async () => Err("empty database should not query config library"),
    });

    assert.deepEqual(result, {
      hasPlayList: false,
      playlists: [],
      collections: [],
      configLibrary: emptyConfigLibrary(),
      savePath: "C:/Users/admin/Documents/slisic",
    });
  });

  test("loads playlists and config library from database when playlist data exists", async () => {
    const configLibrary = emptyConfigLibrary();
    const playlists = [{ name: "PlayList 1", created_at: "2026-05-31T00:00:00+08:00" }];
    const result = await loadCollectionsFromBackend({
      getMetaInfo: async () => Ok({ save_path: "C:/Users/admin/Documents/slisic" }),
      checkList: async () => Ok(true),
      listPlaylists: async () => Ok(playlists),
      listConfigLibrary: async () => Ok(configLibrary),
    });

    assert.deepEqual(result, {
      hasPlayList: true,
      playlists,
      collections: [],
      configLibrary,
      savePath: "C:/Users/admin/Documents/slisic",
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
