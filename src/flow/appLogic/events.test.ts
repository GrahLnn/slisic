import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Err, Ok } from "@grahlnn/fn";
import { loadCollectionsFromBackend } from "./events";
import type { ConfigLibraryView, PlaylistStartupBootstrap } from "@/src/cmd";

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
  test("uses the startup bootstrap snapshot without cold playlist queries", async () => {
    let coldQueryCount = 0;
    const startup: PlaylistStartupBootstrap = {
      has_playlist: true,
      playlists: [{ name: "PlayList 1", created_at: "2026-05-31T00:00:00+08:00" }],
      collections: [],
      config_library: emptyConfigLibrary(),
      save_path: "C:/Users/admin/Documents/slisic",
    };

    const result = await loadCollectionsFromBackend({
      getStartupBootstrap: async () => ({ status: "Ready", value: startup }),
      getMetaInfo: async () => {
        coldQueryCount += 1;
        return Ok({ save_path: startup.save_path });
      },
      checkList: async () => {
        coldQueryCount += 1;
        return Ok(true);
      },
      listPlaylists: async () => {
        coldQueryCount += 1;
        return Ok([]);
      },
      listConfigLibrary: async () => {
        coldQueryCount += 1;
        return Ok(emptyConfigLibrary());
      },
    });

    assert.equal(coldQueryCount, 0);
    assert.deepEqual(result, {
      hasPlayList: true,
      playlists: startup.playlists,
      collections: [],
      configLibrary: startup.config_library,
      savePath: startup.save_path,
    });
  });

  test("falls back to cold playlist queries while startup bootstrap is pending", async () => {
    const result = await loadCollectionsFromBackend({
      getStartupBootstrap: async () => ({ status: "Pending" }),
      getMetaInfo: async () => Ok({ save_path: "C:/Music" }),
      checkList: async () => Ok(false),
      listPlaylists: async () => Err("should not list playlists without playlist data"),
      listConfigLibrary: async () => Err("should not load config library without playlist data"),
    });

    assert.deepEqual(result, {
      hasPlayList: false,
      playlists: [],
      collections: [],
      configLibrary: emptyConfigLibrary(),
      savePath: "C:/Music",
    });
  });
});
