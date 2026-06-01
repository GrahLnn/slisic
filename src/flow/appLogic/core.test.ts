import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  CollectionGroupOwner,
  Group,
  Music,
  PlayList,
  PlayListConfigView,
  PlayListListView,
} from "@/src/cmd";
import {
  createDraftFromPlayListConfig,
  createConfigLibraryFromCollections,
  createConfigSidebarItemsFromLibrary,
  createPlayListWriteRequestFromDraft,
  createContextResetter,
  createInitialContext,
  includeDraftSidebarItem,
  normalizeDraftName,
  removeExtraFromDraft,
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
  upsertCollectionIntoConfigLibrary,
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

const sampleCollectionOwner: CollectionGroupOwner = {
  name: "Quiet Morning",
  url: "https://example.com/quiet-morning",
  folder: "youtube/quiet-morning",
  last_updated: "2026-04-13T00:00:00Z",
  enable_updates: null,
};

function createGroupFixture(overrides: Partial<Group> = {}): Group {
  return {
    name: "Disc 1",
    url: "https://example.com/disc-1",
    collection: sampleCollectionOwner,
    folder: "Disc 1",
    ...overrides,
  };
}

function createMusicFixture(overrides: Partial<Music> = {}): Music {
  return {
    name: "Track A",
    alias: "Track A",
    group: createGroupFixture(),
    canonical_music_id: "source:https://example.com/track-a:0:120000",
    url: "https://example.com/track-a",
    path: "Disc 1/Track A.m4a",
    start_ms: 0,
    end_ms: 120_000,
    liked: false,
    ...overrides,
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
    const next = reset(
      {
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
      },
      {
        owner: "appLogic",
        reason: "test resetter lifecycle contract",
        chart: { kind: "closed", target: null },
        lease: { kind: "closed", target: null },
        transaction: { kind: "closed", target: null },
      },
    );

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
      lastContextResetLifecycle: {
        owner: "appLogic",
        reason: "test resetter lifecycle contract",
        chart: { kind: "closed", target: null },
        lease: { kind: "closed", target: null },
        transaction: { kind: "closed", target: null },
      },
    });
  });

  test("uses fresh default arrays when omitted fields are reset", () => {
    const next = resetContextWith(
      {
        savePath: "D:\\MediaLibrary",
      },
      {
        owner: "appLogic",
        reason: "test omitted reset fields",
        chart: { kind: "closed", target: null },
        lease: { kind: "closed", target: null },
        transaction: { kind: "closed", target: null },
      },
    );
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
          group: createGroupFixture({
            name: "Night Drive",
            url: "https://example.com/night-drive",
            folder: "youtube/night-drive",
          }),
          canonical_music_id: "source:https://example.com/night-drive#opening:0:120000",
          url: "https://example.com/night-drive#opening",
          path: "opening.m4a",
          start_ms: 0,
          end_ms: 120_000,
          liked: false,
        },
      ],
    };

    assert.deepEqual(upsertCollectionIntoCollections([first, second], updated), [first, updated]);
  });
});

describe("config library collection group memberships", () => {
  test("does not infer group memberships from collection music rows", () => {
    const collection = {
      name: "Quiet Morning",
      url: "https://example.com/quiet-morning",
      folder: "youtube/quiet-morning",
      musics: [
        createMusicFixture({
          group: createGroupFixture({
            name: "Disc 1",
            url: "https://example.com/quiet-morning#disc-1",
            folder: "Disc 1",
          }),
        }),
        createMusicFixture({
          url: "https://example.com/track-b",
          canonical_music_id: "source:https://example.com/track-b:0:120000",
          group: createGroupFixture({
            name: "Disc 1",
            url: "https://example.com/quiet-morning#disc-1",
            folder: "Disc 1",
          }),
        }),
      ],
      last_updated: "2026-04-13T00:00:00Z",
      enable_updates: null,
    };

    assert.deepEqual(createConfigLibraryFromCollections([collection]), {
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
      collection_group_memberships: [],
      excludes: [],
      exclude_availability: {
        fully_excluded_collection_urls: [],
        fully_excluded_group_urls: [],
      },
    });
  });

  test("drops memberships owned by a refreshed collection without minting replacements", () => {
    const collectionUrl = "https://example.com/quiet-morning";
    const library = {
      collections: [],
      groups: [],
      collection_group_memberships: [
        {
          collection_url: collectionUrl,
          group_url: "https://example.com/quiet-morning#old-disc",
        },
        {
          collection_url: "https://example.com/other",
          group_url: "https://example.com/other#disc",
        },
      ],
      excludes: [],
      exclude_availability: {
        fully_excluded_collection_urls: [],
        fully_excluded_group_urls: [],
      },
    };
    const nextCollection = {
      name: "Quiet Morning",
      url: collectionUrl,
      folder: "youtube/quiet-morning",
      musics: [
        createMusicFixture({
          group: createGroupFixture({
            name: "Disc 2",
            url: "https://example.com/quiet-morning#disc-2",
            folder: "Disc 2",
          }),
        }),
      ],
      last_updated: "2026-04-14T00:00:00Z",
      enable_updates: null,
    };

    assert.deepEqual(
      upsertCollectionIntoConfigLibrary(library, nextCollection).collection_group_memberships,
      [
        {
          collection_url: "https://example.com/other",
          group_url: "https://example.com/other#disc",
        },
      ],
    );
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
      extra: [],
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
      extra: [createMusicFixture()],
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
      extra: playlist.extra,
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
          extra: [],
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
          extra: [],
          createdAt: null,
        },
        draftBaseline: {
          mode: "edit",
          name: "Original Name",
          collections: [],
          groups: [],
          extra: [],
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

  test("materializes a playlist write request from the current draft", () => {
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
      extra: [createMusicFixture()],
      createdAt: null,
    };

    assert.deepEqual(createPlayListWriteRequestFromDraft(draft), {
      name: "Quiet Morning",
      collections: draft.collections,
      groups: draft.groups,
      extra: draft.extra,
      created_at: null,
    });
    assert.deepEqual(
      createPlayListWriteRequestFromDraft(draft, {
        createdAt: "2026-04-13T00:00:00Z",
      }),
      {
        name: "Quiet Morning",
        collections: draft.collections,
        groups: draft.groups,
        extra: draft.extra,
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
      extra: [],
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
      extra: [],
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
        extra: [],
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
      resolveSavedPath("D:\\MediaLibrary", "C:\\Users\\admin\\Documents\\slisic"),
      "D:\\MediaLibrary",
    );
  });

  test("falls back to the selected path when persistence returns an empty value", () => {
    assert.equal(
      resolveSavedPath(null, "C:\\Users\\admin\\Documents\\slisic"),
      "C:\\Users\\admin\\Documents\\slisic",
    );
  });

  test("falls back to the selected path when persistence returns a blank value", () => {
    assert.equal(
      resolveSavedPath("", "C:\\Users\\admin\\Documents\\slisic"),
      "C:\\Users\\admin\\Documents\\slisic",
    );
    assert.equal(
      resolveSavedPath("   ", "C:\\Users\\admin\\Documents\\slisic"),
      "C:\\Users\\admin\\Documents\\slisic",
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
      extra: [],
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
      extra: [],
      createdAt: null,
    };

    assert.deepEqual(
      includeDraftSidebarItem(
        draft,
        [collection],
        createConfigSidebarItemsFromLibrary({
          collections: [collection],
          groups: [],
          collection_group_memberships: [],
          excludes: [],
          exclude_availability: {
            fully_excluded_collection_urls: [],
            fully_excluded_group_urls: [],
          },
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
          group: createGroupFixture({
            name: "Disc 1",
            url: "https://example.com/disc-1",
            folder: "Disc 1",
          }),
          canonical_music_id: "source:https://example.com/disc-1#opening:0:120000",
          url: "https://example.com/disc-1#opening",
          path: "Disc 1/opening.m4a",
          start_ms: 0,
          end_ms: 120_000,
          liked: false,
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
      extra: [],
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
          collection_group_memberships: [],
          excludes: [],
          exclude_availability: {
            fully_excluded_collection_urls: [],
            fully_excluded_group_urls: [],
          },
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

  test("keeps same-name groups visible because membership is explicit", () => {
    const collection = {
      name: "Quiet Morning",
      url: "https://example.com/quiet-morning",
      folder: "youtube/quiet-morning",
      last_updated: "2026-04-13T00:00:00Z",
      enable_updates: null,
    };
    const sameNameGroup = {
      name: "Quiet Morning",
      url: "https://example.com/group/quiet-morning",
      folder: "Quiet Morning",
    };

    assert.deepEqual(
      createConfigSidebarItemsFromLibrary({
        collections: [collection],
        groups: [sameNameGroup],
        collection_group_memberships: [],
        excludes: [],
        exclude_availability: {
          fully_excluded_collection_urls: [],
          fully_excluded_group_urls: [],
        },
      }),
      [
        {
          kind: "collection",
          name: "Quiet Morning",
          url: "https://example.com/quiet-morning",
          folder: "youtube/quiet-morning",
          last_updated: "2026-04-13T00:00:00Z",
          enable_updates: null,
        },
        {
          kind: "group",
          name: "Quiet Morning",
          url: "https://example.com/group/quiet-morning",
          folder: "Quiet Morning",
        },
      ],
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
      extra: [],
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
      extra: [],
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

describe("removeExtraFromDraft", () => {
  test("removes music by canonical identity only", () => {
    const kept = createMusicFixture({
      canonical_music_id: "source:https://example.com/track-b:0:120000",
      url: "https://example.com/track-b",
    });
    const removed = createMusicFixture();
    const draft = {
      mode: "edit" as const,
      name: "Focus Session",
      collections: [],
      groups: [],
      extra: [removed, kept],
      createdAt: null,
    };

    assert.deepEqual(removeExtraFromDraft(draft, { ...removed, url: "changed" }), {
      ...draft,
      extra: [kept],
    });
    assert.equal(removeExtraFromDraft(null, removed), null);
  });
});
