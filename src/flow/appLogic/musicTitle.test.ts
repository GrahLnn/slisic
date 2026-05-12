import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Collection, PlayList } from "@/src/cmd";
import {
  changeSpectrumMusicDraftValueRange,
  createMusicDraftDeletes,
  createSpectrumCurrentMusicDraft,
  deleteMusicFromCollections,
  deleteMusicFromPlaylistPreview,
  deleteMusicFromPlaylists,
  deleteSpectrumMusicDraft,
  hasSpectrumMusicDraftChanges,
  mergeSpectrumMusicDrafts,
  resolveSpectrumMusicCommit,
  resetSpectrumMusicDraftValue,
  updateMusicInCollections,
  updateMusicInPlaylistPreview,
  updateMusicInPlaylists,
  createSpectrumMusicDrafts,
  changeSpectrumMusicDraftName,
  createMusicDraftEdits,
} from "./musicTitle";

const sampleCollection: Collection = {
  name: "Quiet Morning",
  url: "https://example.com/quiet-morning",
  folder: "youtube/quiet-morning",
  musics: [
    {
      name: "Track A",
      alias: "Track A",
      group: {
        name: "Quiet Morning",
        url: "https://example.com/quiet-morning",
        folder: "youtube/quiet-morning",
      },
      url: "https://example.com/quiet-morning#a",
      path: "a.m4a",
      start_ms: 0,
      end_ms: 120_000,
    },
  ],
  last_updated: "2026-04-13T00:00:00Z",
  enable_updates: null,
};

const samplePlaylist: PlayList = {
  name: "Focus Session",
  collections: [sampleCollection],
  groups: [],
  created_at: "2026-04-13T00:00:00Z",
};

function createSampleSpectrumMusicDraft() {
  return (
    createSpectrumMusicDrafts({
      currentMusicIdentity: {
        endMs: 120_000,
        startMs: 0,
        url: "https://example.com/quiet-morning#a",
      },
      fileMusics: [
        {
          alias: "Track A",
          url: "https://example.com/quiet-morning#a",
          start_ms: 0,
          end_ms: 120_000,
        },
      ],
    })[0] ?? null
  );
}

describe("musicDraft", () => {
  test("creates the current spectrum music draft from the active playback track", () => {
    assert.deepEqual(
      createSpectrumCurrentMusicDraft({
        name: "Track B",
        url: "https://example.com/quiet-morning#b",
        startMs: 120_000,
        endMs: 240_000,
      }),
      {
        baselineName: "Track B",
        baselineStartMs: 120_000,
        baselineEndMs: 240_000,
        name: "Track B",
        url: "https://example.com/quiet-morning#b",
        startMs: 120_000,
        endMs: 240_000,
      },
    );

    assert.equal(
      createSpectrumCurrentMusicDraft({
        name: "Track B",
        url: null,
        startMs: 120_000,
        endMs: 240_000,
      }),
      null,
    );
  });

  test("creates spectrum music drafts only from database music records", () => {
    assert.deepEqual(
      createSpectrumMusicDrafts({
        currentMusicIdentity: {
          endMs: 120_000,
          startMs: 0,
          url: "https://example.com/quiet-morning#a",
        },
        fileMusics: [
          {
            alias: "Track A",
            url: "https://example.com/quiet-morning#a",
            start_ms: 0,
            end_ms: 120_000,
          },
        ],
      }),
      [
        {
          baselineName: "Track A",
          baselineStartMs: 0,
          baselineEndMs: 120_000,
          name: "Track A",
          url: "https://example.com/quiet-morning#a",
          startMs: 0,
          endMs: 120_000,
        },
      ],
    );
    assert.deepEqual(
      createSpectrumMusicDrafts({
        currentMusicIdentity: {
          endMs: null,
          startMs: null,
          url: null,
        },
        fileMusics: [],
      }),
      [],
    );
  });

  test("compares edits with the current music data instead of edit count", () => {
    const draft = createSampleSpectrumMusicDraft();

    assert.equal(hasSpectrumMusicDraftChanges(draft), false);
    assert.equal(hasSpectrumMusicDraftChanges(draft && { ...draft, name: "Track B" }), true);
    assert.equal(hasSpectrumMusicDraftChanges(draft && { ...draft, name: " Track A " }), false);
    assert.equal(hasSpectrumMusicDraftChanges(draft && { ...draft, startMs: 8_000 }), true);
    assert.equal(hasSpectrumMusicDraftChanges(draft && { ...draft, endMs: 112_000 }), true);
  });

  test("keeps spectrum draft range edits at millisecond precision", () => {
    const draft = createSampleSpectrumMusicDraft();

    const edited = changeSpectrumMusicDraftValueRange(draft, {
      endMs: 112_750,
      startMs: 8_250,
    });

    assert.equal(edited?.startMs, 8_250);
    assert.equal(edited?.endMs, 112_750);
    assert.equal(hasSpectrumMusicDraftChanges(edited), true);
    assert.equal(hasSpectrumMusicDraftChanges(draft && { ...draft, startMs: 0 }), false);
    assert.equal(hasSpectrumMusicDraftChanges(draft && { ...draft, startMs: 1 }), true);
  });

  test("does not mark edge-equivalent spectrum draft ranges as changed", () => {
    const draft = createSampleSpectrumMusicDraft();

    const edgeEquivalent = changeSpectrumMusicDraftValueRange(draft, {
      endMs: null,
      startMs: null,
    });

    assert.equal(edgeEquivalent, draft);
    assert.equal(hasSpectrumMusicDraftChanges(draft && { ...draft, startMs: null }), false);
    assert.equal(hasSpectrumMusicDraftChanges(draft && { ...draft, endMs: null }), false);
    assert.equal(
      hasSpectrumMusicDraftChanges(
        draft && {
          ...draft,
          endMs: null,
          startMs: null,
        },
      ),
      false,
    );
    assert.deepEqual(
      createMusicDraftEdits([edgeEquivalent].flatMap((value) => (value ? [value] : []))),
      [],
    );
  });

  test("uses the baseline edge when creating a partial spectrum draft range update", () => {
    const draft = createSampleSpectrumMusicDraft();

    assert.deepEqual(
      createMusicDraftEdits(draft ? [{ ...draft, startMs: null, endMs: 112_000 }] : []),
      [
        {
          id: "https://example.com/quiet-morning#a|0|120000",
          alias: "Track A",
          url: "https://example.com/quiet-morning#a",
          targetStartMs: 0,
          targetEndMs: 120_000,
          startMs: 0,
          endMs: 112_000,
        },
      ],
    );
  });

  test("resets the spectrum music draft to the current music baseline", () => {
    const draft = createSampleSpectrumMusicDraft();

    assert.deepEqual(
      resetSpectrumMusicDraftValue(
        draft &&
          changeSpectrumMusicDraftValueRange(
            {
              ...draft,
              name: "Track B",
            },
            { startMs: 8_000, endMs: 112_000 },
          ),
      ),
      draft,
    );
  });

  test("resets a pending spectrum music deletion back to the current baseline", () => {
    const draft = createSampleSpectrumMusicDraft();

    assert.deepEqual(resetSpectrumMusicDraftValue(draft && { ...draft, deleteRequested: true }), {
      ...draft,
    });
  });

  test("restores the baseline title when the edit is empty", () => {
    const draft = createSampleSpectrumMusicDraft();

    assert.deepEqual(resolveSpectrumMusicCommit(draft && { ...draft, name: "" }), {
      kind: "restore",
      alias: "Track A",
    });
    assert.deepEqual(resolveSpectrumMusicCommit(draft && { ...draft, name: " Track B " }), {
      kind: "keep",
      alias: "Track B",
    });
  });

  test("updates matching music aliases and ranges from the original identity", () => {
    const edit = {
      alias: "Track B",
      url: "https://example.com/quiet-morning#a",
      targetStartMs: 0,
      targetEndMs: 120_000,
      startMs: 8_000,
      endMs: 112_000,
    };
    const updated = updateMusicInCollections([sampleCollection], edit)[0]?.musics[0];

    assert.equal(updated?.name, "Track A");
    assert.equal(updated?.alias, "Track B");
    assert.equal(updated?.start_ms, 8_000);
    assert.equal(updated?.end_ms, 112_000);
    assert.equal(
      updateMusicInPlaylists([samplePlaylist], edit)[0]?.collections[0]?.musics[0]?.alias,
      "Track B",
    );
    assert.equal(
      updateMusicInPlaylistPreview(
        {
          playlist: samplePlaylist,
          previousName: null,
        },
        edit,
      )?.playlist.collections[0]?.musics[0]?.end_ms,
      112_000,
    );
  });

  test("creates spectrum drafts with the current music first", () => {
    const drafts = createSpectrumMusicDrafts({
      currentMusicIdentity: {
        endMs: 240_000,
        startMs: 120_000,
        url: "https://example.com/quiet-morning#b",
      },
      fileMusics: [
        {
          alias: "Track A",
          url: "https://example.com/quiet-morning#a",
          start_ms: 0,
          end_ms: 120_000,
        },
        {
          alias: "Track B",
          url: "https://example.com/quiet-morning#b",
          start_ms: 120_000,
          end_ms: 240_000,
        },
      ],
    });

    assert.equal(drafts.length, 2);
    assert.equal(drafts[0]?.name, "Track B");
    assert.equal(drafts[1]?.name, "Track A");
  });

  test("merges database spectrum drafts without replacing the active playback draft", () => {
    const currentDraft = createSpectrumCurrentMusicDraft({
      name: "Track B From Playback",
      url: "https://example.com/quiet-morning#b",
      startMs: 120_000,
      endMs: 240_000,
    });
    const databaseDrafts = createSpectrumMusicDrafts({
      currentMusicIdentity: {
        endMs: 240_000,
        startMs: 120_000,
        url: "https://example.com/quiet-morning#b",
      },
      fileMusics: [
        {
          alias: "Track A",
          url: "https://example.com/quiet-morning#a",
          start_ms: 0,
          end_ms: 120_000,
        },
        {
          alias: "Track B From Database",
          url: "https://example.com/quiet-morning#b",
          start_ms: 120_000,
          end_ms: 240_000,
        },
      ],
    });

    assert.deepEqual(
      mergeSpectrumMusicDrafts({
        baseDrafts: currentDraft ? [currentDraft] : [],
        incomingDrafts: databaseDrafts,
      }),
      [
        currentDraft,
        {
          baselineName: "Track A",
          baselineStartMs: 0,
          baselineEndMs: 120_000,
          name: "Track A",
          url: "https://example.com/quiet-morning#a",
          startMs: 0,
          endMs: 120_000,
        },
      ],
    );
  });

  test("keeps spectrum music draft edits isolated by identity", () => {
    const drafts = createSpectrumMusicDrafts({
      currentMusicIdentity: {
        endMs: null,
        startMs: null,
        url: null,
      },
      fileMusics: [
        {
          alias: "Track A",
          url: "https://example.com/quiet-morning#a",
          start_ms: 0,
          end_ms: 120_000,
        },
        {
          alias: "Track B",
          url: "https://example.com/quiet-morning#b",
          start_ms: 120_000,
          end_ms: 240_000,
        },
      ],
    });

    const edited = changeSpectrumMusicDraftName(
      drafts,
      "https://example.com/quiet-morning#b|120000|240000",
      "Track B Edit",
    );

    assert.equal(edited[0]?.name, "Track A");
    assert.equal(edited[1]?.name, "Track B Edit");
    assert.deepEqual(createMusicDraftEdits(edited), [
      {
        id: "https://example.com/quiet-morning#b|120000|240000",
        alias: "Track B Edit",
        url: "https://example.com/quiet-morning#b",
        targetStartMs: 120_000,
        targetEndMs: 240_000,
        startMs: 120_000,
        endMs: 240_000,
      },
    ]);
  });

  test("marks only the matching spectrum music draft for deletion", () => {
    const drafts = createSpectrumMusicDrafts({
      currentMusicIdentity: {
        endMs: null,
        startMs: null,
        url: null,
      },
      fileMusics: [
        {
          alias: "Track A",
          url: "https://example.com/quiet-morning#a",
          start_ms: 0,
          end_ms: 120_000,
        },
        {
          alias: "Track B",
          url: "https://example.com/quiet-morning#b",
          start_ms: 120_000,
          end_ms: 240_000,
        },
      ],
    });

    const deleted = deleteSpectrumMusicDraft(
      drafts,
      "https://example.com/quiet-morning#b|120000|240000",
    );

    assert.equal(deleted[0]?.deleteRequested, undefined);
    assert.equal(deleted[1]?.deleteRequested, true);
    assert.equal(hasSpectrumMusicDraftChanges(deleted[1] ?? null), true);
    assert.deepEqual(createMusicDraftEdits(deleted), []);
    assert.deepEqual(createMusicDraftDeletes(deleted), [
      {
        id: "https://example.com/quiet-morning#b|120000|240000",
        url: "https://example.com/quiet-morning#b",
        startMs: 120_000,
        endMs: 240_000,
      },
    ]);
  });

  test("deletes matching music from in-memory collection surfaces", () => {
    const siblingMusic = {
      ...sampleCollection.musics[0],
      alias: "Track B",
      name: "Track B",
      url: "https://example.com/quiet-morning#b",
      start_ms: 120_000,
      end_ms: 240_000,
    };
    const collection = {
      ...sampleCollection,
      musics: [...sampleCollection.musics, siblingMusic],
    };
    const deletion = {
      url: "https://example.com/quiet-morning#a",
      startMs: 0,
      endMs: 120_000,
    };

    assert.deepEqual(
      deleteMusicFromCollections([collection], deletion)[0]?.musics.map((music) => music.alias),
      ["Track B"],
    );
    assert.deepEqual(
      deleteMusicFromPlaylists(
        [{ ...samplePlaylist, collections: [collection] }],
        deletion,
      )[0]?.collections[0]?.musics.map((music) => music.alias),
      ["Track B"],
    );
    assert.deepEqual(
      deleteMusicFromPlaylistPreview(
        {
          playlist: { ...samplePlaylist, collections: [collection] },
          previousName: null,
        },
        deletion,
      )?.playlist.collections[0]?.musics.map((music) => music.alias),
      ["Track B"],
    );
  });

  test("creates one update for each changed spectrum music draft", () => {
    const drafts = createSpectrumMusicDrafts({
      currentMusicIdentity: {
        endMs: 240_000,
        startMs: 120_000,
        url: "https://example.com/quiet-morning#b",
      },
      fileMusics: [
        {
          alias: "Track A",
          url: "https://example.com/quiet-morning#a",
          start_ms: 0,
          end_ms: 120_000,
        },
        {
          alias: "Track B",
          url: "https://example.com/quiet-morning#b",
          start_ms: 120_000,
          end_ms: 240_000,
        },
      ],
    });

    const editedName = changeSpectrumMusicDraftName(
      drafts,
      "https://example.com/quiet-morning#a|0|120000",
      "Track A Edit",
    );
    const editedBoth = changeSpectrumMusicDraftValueRange(
      editedName.find((draft) => draft.url === "https://example.com/quiet-morning#b") ?? null,
      {
        startMs: 121_250,
        endMs: 238_750,
      },
    );
    const nextDrafts = editedName.map((draft) =>
      draft.url === "https://example.com/quiet-morning#b" && editedBoth ? editedBoth : draft,
    );

    assert.deepEqual(createMusicDraftEdits(nextDrafts), [
      {
        id: "https://example.com/quiet-morning#b|120000|240000",
        alias: "Track B",
        url: "https://example.com/quiet-morning#b",
        targetStartMs: 120_000,
        targetEndMs: 240_000,
        startMs: 121_250,
        endMs: 238_750,
      },
      {
        id: "https://example.com/quiet-morning#a|0|120000",
        alias: "Track A Edit",
        url: "https://example.com/quiet-morning#a",
        targetStartMs: 0,
        targetEndMs: 120_000,
        startMs: 0,
        endMs: 120_000,
      },
    ]);
  });
});
