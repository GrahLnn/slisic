import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PlayList, PlayListConfigView, PlayListListView } from "@/src/cmd";
import {
  createDraftFromPlayListConfig,
  createConfigSidebarItemsFromLibrary,
  createPlayListFromDraft,
  createContextResetter,
  createInitialContext,
  includeDraftSidebarItem,
  normalizeDraftName,
  removePlaylistFromPlaylists,
  removeDraftSidebarItem,
  resolveDraftCommitTitle,
  resolveNextGeneratedPlaylistName,
  resolvePlaylistDraftCommit,
  resolveSavedPath,
  resetContextWith,
  upsertPlaylistIntoPlaylists,
  upsertCollectionIntoDraft,
  upsertCollectionIntoCollections,
} from "./core";

function createPlayListFixture(args: {
  name: string;
  created_at?: PlayList["created_at"];
}): PlayListListView {
  return {
    name: args.name,
    created_at: args.created_at ?? "2026-04-13T00:00:00Z",
  };
}

describe("createInitialContext", () => {
  test("creates fresh collection-backed fields for each context instance", () => {
    const first = createInitialContext();
    const second = createInitialContext();

    assert.deepEqual(first, second);
    assert.notEqual(first.playlists, second.playlists);
    assert.notEqual(first.collections, second.collections);
  });
});

describe("createContextResetter", () => {
  test("rebuilds the full context from defaults and the kept fields", () => {
    const reset = createContextResetter(createInitialContext);
    const next = reset({
      collections: [
        {
          name: "Focus Session",
          url: "https://example.com/focus-session",
          folder: "youtube/focus-session",
          musics: [],
          last_updated: "2026-04-13T00:00:00Z",
          enable_updates: null,
        },
      ],
      savePath: "D:\\MediaLibrary",
    });

    assert.deepEqual(next, {
      ...createInitialContext(),
      collections: [
        {
          name: "Focus Session",
          url: "https://example.com/focus-session",
          folder: "youtube/focus-session",
          musics: [],
          last_updated: "2026-04-13T00:00:00Z",
          enable_updates: null,
        },
      ],
      savePath: "D:\\MediaLibrary",
    });
  });

  test("uses fresh default arrays when omitted fields are reset", () => {
    const next = resetContextWith({
      savePath: "D:\\MediaLibrary",
    });
    const defaults = createInitialContext();

    assert.deepEqual(next.playlists, []);
    assert.deepEqual(next.collections, []);
    assert.notEqual(next.playlists, defaults.playlists);
    assert.notEqual(next.collections, defaults.collections);
  });
});

describe("upsertCollectionIntoCollections", () => {
  test("prepends a new collection so freshly synced items surface immediately", () => {
    const existing = {
      name: "Older",
      url: "https://example.com/older",
      folder: "youtube/older",
      musics: [],
      last_updated: "2026-04-13T00:00:00Z",
      enable_updates: null,
    };
    const next = {
      name: "Fresh",
      url: "https://example.com/fresh",
      folder: "youtube/fresh",
      musics: [],
      last_updated: "2026-04-14T00:00:00Z",
      enable_updates: null,
    };

    assert.deepEqual(upsertCollectionIntoCollections([existing], next), [next, existing]);
  });

  test("replaces an existing collection in place when the url already exists", () => {
    const first = {
      name: "Quiet Morning",
      url: "https://example.com/quiet-morning",
      folder: "youtube/quiet-morning",
      musics: [],
      last_updated: "2026-04-13T00:00:00Z",
      enable_updates: null,
    };
    const second = {
      name: "Night Drive",
      url: "https://example.com/night-drive",
      folder: "youtube/night-drive",
      musics: [],
      last_updated: "2026-04-13T00:00:00Z",
      enable_updates: null,
    };
    const updated = {
      ...second,
      musics: [
        {
          name: "Opening",
          alias: "Opening",
          group: {
            name: "Night Drive",
            url: "https://example.com/night-drive",
            folder: "youtube/night-drive",
          },
          url: "https://example.com/night-drive#opening",
          path: "opening.m4a",
          start_ms: 0,
          end_ms: 120_000,
        },
      ],
    };

    assert.deepEqual(upsertCollectionIntoCollections([first, second], updated), [first, updated]);
  });
});

describe("upsertCollectionIntoDraft", () => {
  test("keeps null drafts untouched", () => {
    assert.equal(
      upsertCollectionIntoDraft(null, {
        name: "Fresh",
        url: "https://example.com/fresh",
        folder: "youtube/fresh",
        musics: [],
        last_updated: "2026-04-14T00:00:00Z",
        enable_updates: null,
      }),
      null,
    );
  });

  test("upserts collections into the draft while preserving other draft fields", () => {
    const draft = {
      mode: "create" as const,
      name: "Focus Session",
      collections: [
        {
          name: "Older",
          url: "https://example.com/older",
          folder: "youtube/older",
          last_updated: "2026-04-13T00:00:00Z",
          enable_updates: null,
        },
      ],
      groups: [
        {
          name: "Disc 1",
          url: "https://example.com/disc-1",
          folder: "Disc 1",
        },
      ],
      createdAt: null,
    };
    const next = {
      name: "Fresh",
      url: "https://example.com/fresh",
      folder: "youtube/fresh",
      musics: [],
      last_updated: "2026-04-14T00:00:00Z",
      enable_updates: null,
    };

    assert.deepEqual(upsertCollectionIntoDraft(draft, next), {
      ...draft,
      collections: [
        {
          name: next.name,
          url: next.url,
          folder: next.folder,
          last_updated: next.last_updated,
          enable_updates: next.enable_updates,
        },
        ...draft.collections,
      ],
    });
  });
});

describe("draft commit naming", () => {
  test("hydrates an edit draft from a playlist config view without full music data", () => {
    const playlist: PlayListConfigView = {
      name: "Quiet Morning",
      collections: [
        {
          name: "Quiet Morning",
          url: "https://example.com/quiet-morning",
          folder: "youtube/quiet-morning",
          last_updated: "2026-04-13T00:00:00Z",
          enable_updates: null,
        },
      ],
      groups: [
        {
          name: "Disc 1",
          url: "https://example.com/disc-1",
          folder: "Disc 1",
        },
      ],
      created_at: "2026-04-13T00:00:00Z",
    };

    assert.deepEqual(createDraftFromPlayListConfig(playlist), {
      mode: "edit",
      name: "Quiet Morning",
      collections: [
        {
          name: "Quiet Morning",
          url: "https://example.com/quiet-morning",
          folder: "youtube/quiet-morning",
          last_updated: "2026-04-13T00:00:00Z",
          enable_updates: null,
        },
      ],
      groups: [
        {
          name: "Disc 1",
          url: "https://example.com/disc-1",
          folder: "Disc 1",
        },
      ],
      createdAt: "2026-04-13T00:00:00Z",
    });
  });

  test("normalizes draft names before they are committed", () => {
    assert.equal(normalizeDraftName("  Quiet Morning  "), "Quiet Morning");
  });

  test("keeps a non-empty current draft title", () => {
    assert.deepEqual(
      resolveDraftCommitTitle({
        draft: {
          mode: "create",
          name: "  Quiet Morning  ",
          collections: [],
          groups: [],
          createdAt: null,
        },
        draftBaseline: null,
        playlists: [],
      }),
      {
        kind: "keep",
        name: "Quiet Morning",
      },
    );
  });

  test("restores the original title when the draft title is cleared", () => {
    assert.deepEqual(
      resolveDraftCommitTitle({
        draft: {
          mode: "edit",
          name: "",
          collections: [],
          groups: [],
          createdAt: null,
        },
        draftBaseline: {
          mode: "edit",
          name: "Original Name",
          collections: [],
          groups: [],
          createdAt: null,
        },
        playlists: [],
      }),
      {
        kind: "restore",
        name: "Original Name",
      },
    );
  });

  test("generates the next playlist title when both current and baseline names are empty", () => {
    assert.deepEqual(
      resolveDraftCommitTitle({
        draft: {
          mode: "create",
          name: "",
          collections: [],
          groups: [],
          createdAt: null,
        },
        draftBaseline: {
          mode: "create",
          name: "",
          collections: [],
          groups: [],
          createdAt: null,
        },
        playlists: [
          createPlayListFixture({ name: "PlayList 1" }),
          createPlayListFixture({ name: "PlayList 2" }),
        ],
      }),
      {
        kind: "generate",
        name: "PlayList 3",
      },
    );
  });

  test("finds the first available generated playlist name", () => {
    assert.equal(
      resolveNextGeneratedPlaylistName([
        createPlayListFixture({ name: "PlayList 1" }),
        createPlayListFixture({ name: "PlayList 3" }),
      ]),
      "PlayList 2",
    );
  });

  test("materializes a playlist payload from the current draft", () => {
    const draft = {
      mode: "edit" as const,
      name: "Quiet Morning",
      collections: [
        {
          name: "Collection",
          url: "https://example.com/collection",
          folder: "youtube/collection",
          last_updated: "2026-04-13T00:00:00Z",
          enable_updates: null,
        },
      ],
      groups: [
        {
          name: "Disc 1",
          url: "https://example.com/disc-1",
          folder: "Disc 1",
        },
      ],
      createdAt: null,
    };

    assert.deepEqual(createPlayListFromDraft(draft), {
      name: "Quiet Morning",
      collections: draft.collections.map((collection) => ({ ...collection, musics: [] })),
      groups: draft.groups,
      created_at: null,
    });
    assert.deepEqual(
      createPlayListFromDraft(draft, {
        createdAt: "2026-04-13T00:00:00Z",
      }),
      {
        name: "Quiet Morning",
        collections: draft.collections.map((collection) => ({ ...collection, musics: [] })),
        groups: draft.groups,
        created_at: "2026-04-13T00:00:00Z",
      },
    );
  });

  test("creates one explicit commit request from a changed draft", () => {
    const draft = {
      mode: "create" as const,
      name: "",
      collections: [],
      groups: [],
      createdAt: null,
    };
    const commit = resolvePlaylistDraftCommit({
      draft,
      draftBaseline: draft,
      playlists: [
        createPlayListFixture({ name: "PlayList 1" }),
        createPlayListFixture({ name: "PlayList 2" }),
      ],
    });

    assert.deepEqual(commit.titleResolution, {
      kind: "generate",
      name: "PlayList 3",
    });
    assert.equal(commit.request.previousName, null);
    assert.deepEqual(commit.request.playlist, {
      name: "PlayList 3",
      collections: [],
      groups: [],
      created_at: null,
    });
    assert.deepEqual(commit.preview, {
      playlist: {
        name: "PlayList 3",
        created_at: null,
      },
      previousName: null,
      draft: {
        mode: "create",
        name: "PlayList 3",
        collections: [],
        groups: [],
        createdAt: null,
      },
    });
    assert.equal(commit.layoutId, "playlist-title:PlayList 3");
    assert.deepEqual(commit.titleToneHandoff, {
      layoutId: "playlist-title:PlayList 3",
      tone: "solid",
    });
  });
});

describe("upsertPlaylistIntoPlaylists", () => {
  test("appends a newly committed playlist when it did not exist before", () => {
    const next = createPlayListFixture({
      name: "Quiet Morning",
    });

    assert.deepEqual(upsertPlaylistIntoPlaylists([], next), [next]);
    assert.deepEqual(
      upsertPlaylistIntoPlaylists([createPlayListFixture({ name: "Existing" })], next),
      [createPlayListFixture({ name: "Existing" }), next],
    );
  });

  test("replaces an existing playlist in place when the name matches", () => {
    const first = createPlayListFixture({ name: "First" });
    const second = createPlayListFixture({ name: "Second" });
    const updated = createPlayListFixture({
      name: "Second",
    });

    assert.deepEqual(upsertPlaylistIntoPlaylists([first, second], updated), [first, updated]);
  });

  test("replaces a renamed playlist by its previous name", () => {
    const renamed = createPlayListFixture({ name: "Renamed" });

    assert.deepEqual(
      upsertPlaylistIntoPlaylists(
        [createPlayListFixture({ name: "Original" })],
        renamed,
        "Original",
      ),
      [renamed],
    );
  });
});

describe("removePlaylistFromPlaylists", () => {
  test("removes the matching playlist without disturbing the rest of the order", () => {
    assert.deepEqual(
      removePlaylistFromPlaylists(
        [
          createPlayListFixture({ name: "First" }),
          createPlayListFixture({ name: "Second" }),
          createPlayListFixture({ name: "Third" }),
        ],
        "Second",
      ),
      [createPlayListFixture({ name: "First" }), createPlayListFixture({ name: "Third" })],
    );
  });
});

describe("resolveSavedPath", () => {
  test("uses the saved path returned by persistence", () => {
    assert.equal(
      resolveSavedPath("D:\\MediaLibrary", "C:\\Users\\admin\\Documents\\ransic"),
      "D:\\MediaLibrary",
    );
  });

  test("falls back to the selected path when persistence returns an empty value", () => {
    assert.equal(
      resolveSavedPath(null, "C:\\Users\\admin\\Documents\\ransic"),
      "C:\\Users\\admin\\Documents\\ransic",
    );
  });

  test("falls back to the selected path when persistence returns a blank value", () => {
    assert.equal(
      resolveSavedPath("", "C:\\Users\\admin\\Documents\\ransic"),
      "C:\\Users\\admin\\Documents\\ransic",
    );
    assert.equal(
      resolveSavedPath("   ", "C:\\Users\\admin\\Documents\\ransic"),
      "C:\\Users\\admin\\Documents\\ransic",
    );
  });
});

describe("includeDraftSidebarItem", () => {
  test("ignores unknown sidebar refs so draft mutations stay canonical", () => {
    const draft = {
      mode: "create" as const,
      name: "Focus Session",
      collections: [],
      groups: [],
      createdAt: null,
    };

    assert.deepEqual(
      includeDraftSidebarItem(draft, [], [], {
        kind: "group",
        url: "https://example.com/disc-1",
      }),
      draft,
    );
  });

  test("hydrates collections from the canonical collection list", () => {
    const collection = {
      name: "Quiet Morning",
      url: "https://example.com/quiet-morning",
      folder: "youtube/quiet-morning",
      musics: [],
      last_updated: "2026-04-13T00:00:00Z",
      enable_updates: null,
    };
    const draft = {
      mode: "create" as const,
      name: "Focus Session",
      collections: [],
      groups: [],
      createdAt: null,
    };

    assert.deepEqual(
      includeDraftSidebarItem(
        draft,
        [collection],
        createConfigSidebarItemsFromLibrary({
          collections: [collection],
          groups: [],
        }),
        {
          kind: "collection",
          url: collection.url,
        },
      ),
      {
        ...draft,
        collections: [
          {
            name: collection.name,
            url: collection.url,
            folder: collection.folder,
            last_updated: collection.last_updated,
            enable_updates: collection.enable_updates,
          },
        ],
      },
    );
  });

  test("hydrates groups from the canonical collection-derived sidebar", () => {
    const collection = {
      name: "Quiet Morning",
      url: "https://example.com/quiet-morning",
      folder: "youtube/quiet-morning",
      musics: [
        {
          name: "Disc 1 Opening",
          alias: "Disc 1 Opening",
          group: {
            name: "Disc 1",
            url: "https://example.com/disc-1",
            folder: "Disc 1",
          },
          url: "https://example.com/disc-1#opening",
          path: "Disc 1/opening.m4a",
          start_ms: 0,
          end_ms: 120_000,
        },
      ],
      last_updated: "2026-04-13T00:00:00Z",
      enable_updates: null,
    };
    const draft = {
      mode: "create" as const,
      name: "Focus Session",
      collections: [],
      groups: [],
      createdAt: null,
    };

    assert.deepEqual(
      includeDraftSidebarItem(
        draft,
        [collection],
        createConfigSidebarItemsFromLibrary({
          collections: [],
          groups: [
            {
              name: "Disc 1",
              url: "https://example.com/disc-1",
              folder: "Disc 1",
            },
          ],
        }),
        {
          kind: "group",
          url: "https://example.com/disc-1",
        },
      ),
      {
        ...draft,
        groups: [
          {
            name: "Disc 1",
            url: "https://example.com/disc-1",
            folder: "Disc 1",
          },
        ],
      },
    );
  });
});

describe("removeDraftSidebarItem", () => {
  test("removes collections by canonical ref", () => {
    const collection = {
      name: "Quiet Morning",
      url: "https://example.com/quiet-morning",
      folder: "youtube/quiet-morning",
      musics: [],
      last_updated: "2026-04-13T00:00:00Z",
      enable_updates: null,
    };
    const draft = {
      mode: "edit" as const,
      name: "Focus Session",
      collections: [
        {
          name: collection.name,
          url: collection.url,
          folder: collection.folder,
          last_updated: collection.last_updated,
          enable_updates: collection.enable_updates,
        },
      ],
      groups: [],
      createdAt: null,
    };

    assert.deepEqual(
      removeDraftSidebarItem(draft, {
        kind: "collection",
        url: collection.url,
      }),
      {
        ...draft,
        collections: [],
      },
    );
  });

  test("removes groups by canonical ref", () => {
    const draft = {
      mode: "edit" as const,
      name: "Focus Session",
      collections: [],
      groups: [
        {
          name: "Disc 1",
          url: "https://example.com/disc-1",
          folder: "Disc 1",
        },
      ],
      createdAt: null,
    };

    assert.deepEqual(
      removeDraftSidebarItem(draft, {
        kind: "group",
        url: "https://example.com/disc-1",
      }),
      {
        ...draft,
        groups: [],
      },
    );
  });
});
