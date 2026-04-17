import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createInitialContext,
  createContextResetter,
  insertConfigSidebarItemIntoDraft,
  resetContextWith,
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
    assert.notEqual(first.configSidebarItems, second.configSidebarItems);
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
    assert.deepEqual(next.configSidebarItems, []);
    assert.notEqual(next.playlists, defaults.playlists);
    assert.notEqual(next.collections, defaults.collections);
    assert.notEqual(next.configSidebarItems, defaults.configSidebarItems);
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

describe("insertConfigSidebarItemIntoDraft", () => {
  test("appends a missing group into the draft", () => {
    const draft = {
      mode: "create" as const,
      name: "Focus Session",
      collections: [],
      groups: [],
    };

    assert.deepEqual(
      insertConfigSidebarItemIntoDraft(draft, [], {
        kind: "group",
        name: "Disc 1",
        url: "https://example.com/disc-1",
        folder: "Disc 1",
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
      insertConfigSidebarItemIntoDraft(draft, [collection], {
        kind: "collection",
        name: collection.name,
        url: collection.url,
        folder: collection.folder,
      }),
      {
        ...draft,
        collections: [collection],
      },
    );
  });
});
