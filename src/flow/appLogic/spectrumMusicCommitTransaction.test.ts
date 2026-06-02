import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CollectionGroupOwner, Group, Music } from "@/src/cmd";
import {
  createSpectrumMusicCommitPlan,
  hasSpectrumMusicCommitOperations,
  runSpectrumMusicCommitTransaction,
  type SpectrumMusicCommitPhase,
} from "./spectrumMusicCommitTransaction";
import type {
  MusicCreateInput,
  MusicCreatesResult,
  MusicDeletesResult,
  MusicUpdateInput,
  MusicUpdatesResult,
} from "./events";
import type { PendingCreateSpectrumMusicDraft, PersistedSpectrumMusicDraft } from "./core";

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
    loudness: 0,
    ...overrides,
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

function createPendingDraft(
  overrides: Partial<PendingCreateSpectrumMusicDraft> = {},
): PendingCreateSpectrumMusicDraft {
  return {
    kind: "pending-create",
    baselineName: "",
    baselineStartMs: null,
    baselineEndMs: null,
    name: "Track B",
    url: "https://example.com/quiet-morning#a#spectrum#120000#240000#Track%20B",
    startMs: 120_000,
    endMs: 240_000,
    sourceCollectionUrl: sampleCollectionOwner.url,
    sourceEndMs: 240_000,
    sourceGroup: sampleGroup,
    sourcePath: "a.m4a",
    sourceUrl: "https://example.com/quiet-morning#a",
    ...overrides,
  };
}

describe("spectrum music commit transaction", () => {
  test("creates one explicit commit plan from spectrum drafts", () => {
    const drafts = [
      createPersistedDraft({ name: "Track A Revised", startMs: 8_000, endMs: 112_000 }),
      createPersistedDraft({
        baselineName: "Track C",
        baselineStartMs: 240_000,
        baselineEndMs: 300_000,
        deleteRequested: true,
        name: "Track C",
        url: "https://example.com/quiet-morning#c",
        startMs: 240_000,
        endMs: 300_000,
      }),
      createPendingDraft(),
    ];

    const plan = createSpectrumMusicCommitPlan({ drafts, epoch: 7 });

    assert.equal(hasSpectrumMusicCommitOperations(drafts), true);
    assert.equal(plan.epoch, 7);
    assert.deepEqual(plan.updates, [
      {
        alias: "Track A Revised",
        url: "https://example.com/quiet-morning#a",
        targetStartMs: 0,
        targetEndMs: 120_000,
        startMs: 8_000,
        endMs: 112_000,
      },
    ]);
    assert.deepEqual(plan.deletes, [
      {
        id: "https://example.com/quiet-morning#c|240000|300000",
        url: "https://example.com/quiet-morning#c",
        startMs: 240_000,
        endMs: 300_000,
      },
    ]);
    assert.equal(plan.creates.length, 1);
    assert.equal(plan.creates[0]?.sourceCollectionUrl, sampleCollectionOwner.url);
  });

  test("runs phases in update-create-delete order and emits accepted events", async () => {
    const calls: string[] = [];
    const events: string[] = [];
    const updates: MusicUpdatesResult = {
      results: [
        {
          input: {
            alias: "Track A Revised",
            endMs: 112_000,
            startMs: 8_000,
            targetEndMs: 120_000,
            targetStartMs: 0,
            url: "https://example.com/quiet-morning#a",
          },
          music: createMusic({
            alias: "Track A Revised",
            end_ms: 112_000,
            start_ms: 8_000,
          }),
        },
      ],
    };
    const creates: MusicCreatesResult = {
      results: [
        {
          input: {
            sourceCollectionUrl: sampleCollectionOwner.url,
            music: createMusic({
              alias: "Track B",
              name: "Track B",
              url: "https://example.com/quiet-morning#b",
            }),
          },
          music: createMusic({
            alias: "Track B",
            name: "Track B",
            url: "https://example.com/quiet-morning#b",
          }),
        },
      ],
    };
    const deletes: MusicDeletesResult = {
      results: [
        {
          id: "https://example.com/quiet-morning#c|240000|300000",
          url: "https://example.com/quiet-morning#c",
          startMs: 240_000,
          endMs: 300_000,
        },
      ],
    };

    await runSpectrumMusicCommitTransaction({
      plan: {
        creates: creates.results.map((create) => create.input),
        deletes: deletes.results,
        epoch: 7,
        updates: updates.results.map((update) => update.input),
      },
      runtime: {
        updateMusics: async (_inputs: MusicUpdateInput[]) => {
          calls.push("update");
          return updates;
        },
        createMusics: async (_inputs: MusicCreateInput[]) => {
          calls.push("create");
          return creates;
        },
        deleteMusics: async () => {
          calls.push("delete");
          return deletes;
        },
      },
      sink: {
        failed: (failure) => events.push(`failed:${failure.phase}`),
        updated: ({ epoch }) => events.push(`updated:${epoch}`),
        created: ({ epoch }) => events.push(`created:${epoch}`),
        deleted: ({ epoch }) => events.push(`deleted:${epoch}`),
      },
      trace: {
        finished: ({ epoch }) => events.push(`finished:${epoch}`),
      },
    });

    assert.deepEqual(calls, ["update", "create", "delete"]);
    assert.deepEqual(events, ["updated:7", "created:7", "deleted:7", "finished:7"]);
  });

  test("stops later phases after the first explicit failure", async () => {
    const calls: string[] = [];
    const failures: { epoch: number; error: string; phase: SpectrumMusicCommitPhase }[] = [];

    await runSpectrumMusicCommitTransaction({
      plan: {
        creates: [
          {
            sourceCollectionUrl: sampleCollectionOwner.url,
            music: createMusic({ alias: "Track B", name: "Track B" }),
          },
        ],
        deletes: [
          {
            id: "https://example.com/quiet-morning#c|240000|300000",
            url: "https://example.com/quiet-morning#c",
            startMs: 240_000,
            endMs: 300_000,
          },
        ],
        epoch: 8,
        updates: [
          {
            alias: "Track A Revised",
            endMs: 112_000,
            startMs: 8_000,
            targetEndMs: 120_000,
            targetStartMs: 0,
            url: "https://example.com/quiet-morning#a",
          },
        ],
      },
      runtime: {
        updateMusics: async () => {
          calls.push("update");
          throw new Error("update failed");
        },
        createMusics: async () => {
          calls.push("create");
          return { results: [] };
        },
        deleteMusics: async () => {
          calls.push("delete");
          return { results: [] };
        },
      },
      sink: {
        failed: (failure) => failures.push(failure),
        updated: () => undefined,
        created: () => undefined,
        deleted: () => undefined,
      },
    });

    assert.deepEqual(calls, ["update"]);
    assert.deepEqual(failures, [
      {
        epoch: 8,
        error: "update failed",
        phase: "update",
      },
    ]);
  });
});
