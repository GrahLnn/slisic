import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Collection, CollectionGroupOwner, Group, Music } from "@/src/cmd";
import {
  createSpectrumEditCommitFrame,
  createSpectrumEditDraftEvidence,
  projectSpectrumEditTransaction,
  reflectSpectrumEditCommitEvidence,
} from "./spectrumEditTransaction";
import type { PersistedSpectrumMusicDraft } from "./core";

const sampleCollectionOwner: CollectionGroupOwner = {
  name: "Quiet Morning",
  url: "https://example.com/quiet-morning",
  folder: "youtube/quiet-morning",
  last_updated: "2026-04-13T00:00:00Z",
  enable_updates: null,
};

const sampleGroup: Group = {
  name: "Quiet Morning",
  url: "https://example.com/quiet-morning",
  collection: sampleCollectionOwner,
  folder: "youtube/quiet-morning",
};

function createMusic(overrides: Partial<Music> = {}): Music {
  return {
    name: "Track A",
    alias: "Track A",
    group: sampleGroup,
    canonical_music_id: "source:https://example.com/quiet-morning#a:0:120000",
    url: "https://example.com/quiet-morning#a",
    path: "a.m4a",
    start_ms: 0,
    end_ms: 120_000,
    liked: false,
    ...overrides,
  };
}

function createCollection(musics: readonly Music[]): Collection {
  return {
    name: "Quiet Morning",
    url: "https://example.com/quiet-morning",
    folder: "youtube/quiet-morning",
    musics: [...musics],
    last_updated: "2026-04-13T00:00:00Z",
    enable_updates: null,
  };
}

function createPersistedDraft(
  overrides: Partial<PersistedSpectrumMusicDraft> = {},
): PersistedSpectrumMusicDraft {
  return {
    kind: "persisted",
    baselineName: "Track A",
    baselineStartMs: 0,
    baselineEndMs: 120_000,
    name: "Track A",
    url: "https://example.com/quiet-morning#a",
    startMs: 0,
    endMs: 120_000,
    ...overrides,
  };
}

describe("spectrum edit transaction", () => {
  test("composes edit, create, and delete projections in one transaction", () => {
    const currentMusic = createMusic();
    const siblingMusic = createMusic({
      name: "Track B",
      alias: "Track B",
      canonical_music_id: "source:https://example.com/quiet-morning#b:120000:240000",
      url: "https://example.com/quiet-morning#b",
      path: "b.m4a",
      start_ms: 120_000,
      end_ms: 240_000,
    });
    const deletedMusic = createMusic({
      name: "Track C",
      alias: "Track C",
      canonical_music_id: "source:https://example.com/quiet-morning#c:240000:300000",
      url: "https://example.com/quiet-morning#c",
      path: "c.m4a",
      start_ms: 240_000,
      end_ms: 300_000,
    });
    const createdMusic = createMusic({
      name: "Track D",
      alias: "Track D",
      canonical_music_id: "source:https://example.com/quiet-morning#d:300000:360000",
      url: "https://example.com/quiet-morning#d",
      path: "d.m4a",
      start_ms: 300_000,
      end_ms: 360_000,
    });

    const result = projectSpectrumEditTransaction(
      {
        collections: [createCollection([currentMusic, siblingMusic, deletedMusic])],
        nowPlaying: {
          name: currentMusic.alias,
          url: currentMusic.url,
          filePath: currentMusic.path,
          startMs: currentMusic.start_ms,
          endMs: currentMusic.end_ms,
          liked: currentMusic.liked,
        },
      },
      {
        musicCreates: [{ sourceCollectionUrl: sampleCollectionOwner.url, music: createdMusic }],
        musicDeletes: [
          {
            url: deletedMusic.url,
            startMs: deletedMusic.start_ms,
            endMs: deletedMusic.end_ms,
          },
        ],
        musicEdits: [
          {
            alias: "Track A Revised",
            url: currentMusic.url,
            targetStartMs: currentMusic.start_ms,
            targetEndMs: currentMusic.end_ms,
            startMs: 8_000,
            endMs: 112_000,
          },
        ],
      },
    );

    assert.deepEqual(
      result.collections[0]?.musics.map((music) => music.alias),
      ["Track A Revised", "Track B", "Track D"],
    );
    assert.deepEqual(result.nowPlaying, {
      name: "Track A Revised",
      url: currentMusic.url,
      filePath: currentMusic.path,
      startMs: 8_000,
      endMs: 112_000,
      liked: false,
    });
  });

  test("clears now playing projection when the current music is deleted", () => {
    const currentMusic = createMusic();
    const result = projectSpectrumEditTransaction(
      {
        collections: [createCollection([currentMusic])],
        nowPlaying: {
          name: currentMusic.alias,
          url: currentMusic.url,
          filePath: currentMusic.path,
          startMs: currentMusic.start_ms,
          endMs: currentMusic.end_ms,
          liked: currentMusic.liked,
        },
      },
      {
        musicDeletes: [
          {
            url: currentMusic.url,
            startMs: currentMusic.start_ms,
            endMs: currentMusic.end_ms,
          },
        ],
      },
    );

    assert.deepEqual(result.collections[0]?.musics, []);
    assert.deepEqual(result.nowPlaying, {
      name: null,
      url: null,
      filePath: null,
      startMs: null,
      endMs: null,
      liked: null,
    });
  });

  test("derives optimistic evidence from drafts", () => {
    const evidence = createSpectrumEditDraftEvidence([
      createPersistedDraft({
        name: "Track A Revised",
        startMs: 8_000,
        endMs: 112_000,
      }),
      createPersistedDraft({
        baselineName: "Track B",
        baselineStartMs: 120_000,
        baselineEndMs: 240_000,
        deleteRequested: true,
        name: "Track B",
        url: "https://example.com/quiet-morning#b",
        startMs: 120_000,
        endMs: 240_000,
      }),
    ]);

    assert.deepEqual(evidence.musicEdits, [
      {
        id: "https://example.com/quiet-morning#a|0|120000",
        alias: "Track A Revised",
        url: "https://example.com/quiet-morning#a",
        targetStartMs: 0,
        targetEndMs: 120_000,
        startMs: 8_000,
        endMs: 112_000,
      },
    ]);
    assert.deepEqual(evidence.musicDeletes, [
      {
        id: "https://example.com/quiet-morning#b|120000|240000",
        url: "https://example.com/quiet-morning#b",
        startMs: 120_000,
        endMs: 240_000,
      },
    ]);
  });

  test("reflects accepted update evidence against the commit baseline", () => {
    const currentMusic = createMusic();
    const baseline = {
      collections: [createCollection([currentMusic])],
      nowPlaying: {
        name: currentMusic.alias,
        url: currentMusic.url,
        filePath: currentMusic.path,
        startMs: currentMusic.start_ms,
        endMs: currentMusic.end_ms,
        liked: currentMusic.liked,
      },
    };
    const frame = createSpectrumEditCommitFrame({
      baseline,
      epoch: 3,
      optimisticEvidence: {
        musicEdits: [
          {
            alias: "Track A Draft",
            url: currentMusic.url,
            targetStartMs: currentMusic.start_ms,
            targetEndMs: currentMusic.end_ms,
            startMs: 8_000,
            endMs: 112_000,
          },
        ],
      },
    });

    const reflection = reflectSpectrumEditCommitEvidence(frame, {
      epoch: 3,
      phase: "update",
      evidence: {
        musicEdits: [
          {
            alias: "Track A Accepted",
            url: currentMusic.url,
            targetStartMs: currentMusic.start_ms,
            targetEndMs: currentMusic.end_ms,
            startMs: 10_000,
            endMs: 110_000,
          },
        ],
      },
    });

    assert.equal(reflection.kind, "accepted");
    if (reflection.kind !== "accepted") {
      throw new Error("expected accepted spectrum edit reflection");
    }
    assert.deepEqual(reflection.projection.collections[0]?.musics[0], {
      ...currentMusic,
      alias: "Track A Accepted",
      start_ms: 10_000,
      end_ms: 110_000,
    });
    assert.deepEqual(reflection.projection.nowPlaying, {
      name: "Track A Accepted",
      url: currentMusic.url,
      filePath: currentMusic.path,
      startMs: 10_000,
      endMs: 110_000,
      liked: false,
    });
    assert.equal(reflection.frame, null);
  });

  test("closes accepted evidence when the spectrum commit frame is gone", () => {
    const reflection = reflectSpectrumEditCommitEvidence(null, {
      epoch: 8,
      phase: "update",
      evidence: {
        musicEdits: [
          {
            alias: "Late Track",
            url: "https://example.com/quiet-morning#a",
            targetStartMs: 0,
            targetEndMs: 120_000,
            startMs: 10_000,
            endMs: 110_000,
          },
        ],
      },
    });

    assert.deepEqual(reflection, {
      epoch: 8,
      kind: "Stops",
      phase: "update",
      reason: "closed-frame",
    });
  });

  test("closes accepted evidence from a stale spectrum commit epoch", () => {
    const currentMusic = createMusic();
    const frame = createSpectrumEditCommitFrame({
      baseline: {
        collections: [createCollection([currentMusic])],
        nowPlaying: {
          name: currentMusic.alias,
          url: currentMusic.url,
          filePath: currentMusic.path,
          startMs: currentMusic.start_ms,
          endMs: currentMusic.end_ms,
          liked: currentMusic.liked,
        },
      },
      epoch: 7,
      optimisticEvidence: {
        musicEdits: [
          {
            alias: "Track A Draft",
            url: currentMusic.url,
            targetStartMs: currentMusic.start_ms,
            targetEndMs: currentMusic.end_ms,
            startMs: 8_000,
            endMs: 112_000,
          },
        ],
      },
    });

    const reflection = reflectSpectrumEditCommitEvidence(frame, {
      epoch: 6,
      phase: "update",
      evidence: {
        musicEdits: [
          {
            alias: "Track A Accepted",
            url: currentMusic.url,
            targetStartMs: currentMusic.start_ms,
            targetEndMs: currentMusic.end_ms,
            startMs: 10_000,
            endMs: 110_000,
          },
        ],
      },
    });

    assert.deepEqual(reflection, {
      epoch: 6,
      kind: "Stops",
      phase: "update",
      reason: "stale-epoch",
    });
  });

  test("rejects accepted update evidence whose target is missing from the commit baseline", () => {
    const currentMusic = createMusic();
    const frame = createSpectrumEditCommitFrame({
      baseline: {
        collections: [createCollection([currentMusic])],
        nowPlaying: {
          name: currentMusic.alias,
          url: currentMusic.url,
          filePath: currentMusic.path,
          startMs: currentMusic.start_ms,
          endMs: currentMusic.end_ms,
          liked: currentMusic.liked,
        },
      },
      epoch: 7,
      optimisticEvidence: {
        musicEdits: [
          {
            alias: "Track A Draft",
            url: currentMusic.url,
            targetStartMs: currentMusic.start_ms,
            targetEndMs: currentMusic.end_ms,
            startMs: 8_000,
            endMs: 112_000,
          },
        ],
      },
    });

    const reflection = reflectSpectrumEditCommitEvidence(frame, {
      epoch: 7,
      phase: "update",
      evidence: {
        musicEdits: [
          {
            alias: "Track A Accepted",
            url: currentMusic.url,
            targetStartMs: 60_000,
            targetEndMs: 90_000,
            startMs: 10_000,
            endMs: 110_000,
          },
        ],
      },
    });

    assert.equal(reflection.kind, "Reject");
    if (reflection.kind !== "Reject") {
      throw new Error("expected missing baseline target to reject");
    }
    assert.equal(reflection.reason, "unexpected-evidence");
  });
});
