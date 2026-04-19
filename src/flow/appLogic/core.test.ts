import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDraftFromPlaylistName,
  createPlayListFromDraft,
  createContextResetter,
  createInitialContext,
  includeDraftSidebarItem,
  normalizeDraftName,
  removePlaylistFromPlaylists,
  removeDraftSidebarItem,
  resolveDraftCommitTitle,
  resolveNextGeneratedPlaylistName,
  resolvePlaylistsWithPreview,
  resetContextWith,
  upsertPlaylistIntoPlaylists,
  upsertCollectionIntoDraft,
  upsertCollectionIntoCollections,
} from "./core";

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
          group: {
            name: "Night Drive",
            url: "https://example.com/night-drive",
            folder: "youtube/night-drive",
          },
          url: "https://example.com/night-drive#opening",
          path: "opening.m4a",
          start: 0,
          end: 120,
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
          musics: [],
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
      collections: [next, ...draft.collections],
    });
  });
});

describe("draft commit naming", () => {
  test("hydrates an edit draft directly from an already loaded playlist snapshot", () => {
    assert.deepEqual(
      createDraftFromPlaylistName(
        [
          {
            name: "Quiet Morning",
            collections: [
              {
                name: "Quiet Morning",
                url: "https://example.com/quiet-morning",
                folder: "youtube/quiet-morning",
                musics: [],
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
          },
        ],
        "Quiet Morning",
      ),
      {
        mode: "edit",
        name: "Quiet Morning",
        collections: [
          {
            name: "Quiet Morning",
            url: "https://example.com/quiet-morning",
            folder: "youtube/quiet-morning",
            musics: [],
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
      },
    );
  });

  test("returns null when the requested playlist is not in the cached list", () => {
    assert.equal(createDraftFromPlaylistName([], "Missing"), null);
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
        },
        draftBaseline: {
          mode: "edit",
          name: "Original Name",
          collections: [],
          groups: [],
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
        },
        draftBaseline: {
          mode: "create",
          name: "",
          collections: [],
          groups: [],
        },
        playlists: [
          {
            name: "PlayList 1",
            collections: [],
            groups: [],
          },
          {
            name: "PlayList 2",
            collections: [],
            groups: [],
          },
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
        {
          name: "PlayList 1",
          collections: [],
          groups: [],
        },
        {
          name: "PlayList 3",
          collections: [],
          groups: [],
        },
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
          musics: [],
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
    };

    assert.deepEqual(createPlayListFromDraft(draft), {
      name: "Quiet Morning",
      collections: draft.collections,
      groups: draft.groups,
    });
  });

});

describe("upsertPlaylistIntoPlaylists", () => {
  test("appends a newly committed playlist when it did not exist before", () => {
    const next = {
      name: "Quiet Morning",
      collections: [],
      groups: [],
    };

    assert.deepEqual(upsertPlaylistIntoPlaylists([], next), [next]);
    assert.deepEqual(
      upsertPlaylistIntoPlaylists(
        [
          {
            name: "Existing",
            collections: [],
            groups: [],
          },
        ],
        next,
      ),
      [
        {
          name: "Existing",
          collections: [],
          groups: [],
        },
        next,
      ],
    );
  });

  test("replaces an existing playlist in place when the name matches", () => {
    const first = {
      name: "First",
      collections: [],
      groups: [],
    };
    const second = {
      name: "Second",
      collections: [],
      groups: [],
    };
    const updated = {
      name: "Second",
      collections: [
        {
          name: "Collection",
          url: "https://example.com/collection",
          folder: "youtube/collection",
          musics: [],
          last_updated: "2026-04-13T00:00:00Z",
          enable_updates: null,
        },
      ],
      groups: [],
    };

    assert.deepEqual(upsertPlaylistIntoPlaylists([first, second], updated), [
      first,
      updated,
    ]);
  });

  test("replaces a renamed playlist by its previous name", () => {
    const renamed = {
      name: "Renamed",
      collections: [],
      groups: [],
    };

    assert.deepEqual(
      upsertPlaylistIntoPlaylists(
        [
          {
            name: "Original",
            collections: [],
            groups: [],
          },
        ],
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
          {
            name: "First",
            collections: [],
            groups: [],
          },
          {
            name: "Second",
            collections: [],
            groups: [],
          },
          {
            name: "Third",
            collections: [],
            groups: [],
          },
        ],
        "Second",
      ),
      [
        {
          name: "First",
          collections: [],
          groups: [],
        },
        {
          name: "Third",
          collections: [],
          groups: [],
        },
      ],
    );
  });
});

describe("resolvePlaylistsWithPreview", () => {
  test("returns a detached copy when there is no pending preview", () => {
    const playlists = [
      {
        name: "Existing",
        collections: [],
        groups: [],
      },
    ];

    const resolved = resolvePlaylistsWithPreview(playlists, null);

    assert.deepEqual(resolved, playlists);
    assert.notEqual(resolved, playlists);
  });

  test("materializes the returning playlist immediately while the commit is still pending", () => {
    assert.deepEqual(
      resolvePlaylistsWithPreview(
        [
          {
            name: "Existing",
            collections: [],
            groups: [],
          },
        ],
        {
          playlist: {
            name: "PlayList 1",
            collections: [],
            groups: [],
          },
          previousName: null,
        },
      ),
      [
        {
          name: "Existing",
          collections: [],
          groups: [],
        },
        {
          name: "PlayList 1",
          collections: [],
          groups: [],
        },
      ],
    );
  });

  test("replaces the previous title immediately for rename previews", () => {
    assert.deepEqual(
      resolvePlaylistsWithPreview(
        [
          {
            name: "Original",
            collections: [],
            groups: [],
          },
        ],
        {
          playlist: {
            name: "Renamed",
            collections: [],
            groups: [],
          },
          previousName: "Original",
        },
      ),
      [
        {
          name: "Renamed",
          collections: [],
          groups: [],
        },
      ],
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
    };

    assert.deepEqual(
      includeDraftSidebarItem(draft, [], {
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
    };

    assert.deepEqual(
      includeDraftSidebarItem(draft, [collection], {
        kind: "collection",
        url: collection.url,
      }),
      {
        ...draft,
        collections: [collection],
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
          group: {
            name: "Disc 1",
            url: "https://example.com/disc-1",
            folder: "Disc 1",
          },
          url: "https://example.com/disc-1#opening",
          path: "Disc 1/opening.m4a",
          start: 0,
          end: 120,
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
    };

    assert.deepEqual(
      includeDraftSidebarItem(draft, [collection], {
        kind: "group",
        url: "https://example.com/disc-1",
      }),
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
      collections: [collection],
      groups: [],
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
