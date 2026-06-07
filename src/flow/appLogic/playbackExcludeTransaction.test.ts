import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  CollectionGroupOwner,
  Exclude,
  ExcludeAvailability,
  ExcludeCurrentMusicAndSkipResult,
  Group,
} from "@/src/cmd";
import {
  projectPlaybackExcludeResult,
  runPlaybackExcludeTransaction,
  type PlaybackExcludeProjection,
} from "./playbackExcludeTransaction";

const excludeAvailability: ExcludeAvailability = {
  fully_excluded_collection_urls: [],
  fully_excluded_group_urls: [],
};

const sampleCollectionOwner: CollectionGroupOwner = {
  name: "Focus",
  url: "https://example.com/focus",
  folder: "focus",
  last_updated: "2026-06-01T00:00:00Z",
  enable_updates: null,
};

const sampleGroup: Group = {
  name: "Focus",
  url: "https://example.com/focus",
  collection: sampleCollectionOwner,
  folder: "focus",
};

const sampleExclude: Exclude = {
  created_at: null,
  music: {
    alias: "Track A",
    canonical_music_id: "source:https://example.com/focus#a:0:120000",
    end_ms: 120_000,
    group: sampleGroup,
    liked: false,
    name: "Track A",
    path: "focus/a.m4a",
    start_ms: 0,
    url: "https://example.com/focus#a",
  },
};

function createProjection(
  overrides: Partial<PlaybackExcludeProjection> = {},
): PlaybackExcludeProjection {
  return {
    state: "play",
    playingPlaylistName: "Focus",
    ...overrides,
  };
}

function createSkippedResult(): ExcludeCurrentMusicAndSkipResult {
  return {
    status: "skipped",
    exclude: sampleExclude,
    exclude_availability: excludeAvailability,
  };
}

function createDeletedPlaylistResult(playlistName = "Focus"): ExcludeCurrentMusicAndSkipResult {
  return {
    status: "deleted_playlist",
    playlist_name: playlistName,
    exclude: sampleExclude,
    exclude_availability: excludeAvailability,
  };
}

describe("playback exclude transaction", () => {
  test("projects skipped result into one exclude event without play back signal", () => {
    const result = projectPlaybackExcludeResult({
      source: createProjection(),
      current: createProjection(),
      result: createSkippedResult(),
    });

    assert.deepEqual(result, {
      kind: "Excluded",
      status: "skipped",
      exclude: {
        exclude: sampleExclude,
        excludeAvailability,
      },
      playlistDeleted: null,
      shouldBackOutOfPlay: false,
    });
  });

  test("keeps backend negative paths explicit", () => {
    assert.deepEqual(
      projectPlaybackExcludeResult({
        source: createProjection(),
        current: createProjection(),
        result: { status: "no_active_track" },
      }),
      {
        kind: "Rejected",
        reason: "no_active_track",
      },
    );
    assert.deepEqual(
      projectPlaybackExcludeResult({
        source: createProjection(),
        current: createProjection(),
        result: { status: "missing_music" },
      }),
      {
        kind: "Rejected",
        reason: "missing_music",
      },
    );
  });

  test("backs out only when the deleted playlist is still the current play projection", async () => {
    const events: string[] = [];
    const result = await runPlaybackExcludeTransaction({
      source: createProjection(),
      runtime: {
        excludeCurrentMusicAndSkip: async () => createDeletedPlaylistResult(),
        getCurrentProjection: () => createProjection(),
      },
      sink: {
        backOutOfPlay: () => events.push("back"),
        excludeAdded: (change) => events.push(`exclude:${change.exclude.music.url}`),
        playlistDeleted: (playlistName) => events.push(`delete:${playlistName}`),
      },
    });

    assert.equal(result.kind, "Excluded");
    assert.deepEqual(events, ["exclude:https://example.com/focus#a", "delete:Focus", "back"]);
  });

  test("does not back out when deletion belongs to a stale source playlist", async () => {
    const events: string[] = [];
    const result = await runPlaybackExcludeTransaction({
      source: createProjection(),
      runtime: {
        excludeCurrentMusicAndSkip: async () => createDeletedPlaylistResult(),
        getCurrentProjection: () => createProjection({ playingPlaylistName: "Other" }),
      },
      sink: {
        backOutOfPlay: () => events.push("back"),
        excludeAdded: (change) => events.push(`exclude:${change.exclude.music.url}`),
        playlistDeleted: (playlistName) => events.push(`delete:${playlistName}`),
      },
    });

    assert.deepEqual(result, {
      kind: "Excluded",
      status: "deleted_playlist",
      exclude: {
        exclude: sampleExclude,
        excludeAvailability,
      },
      playlistDeleted: "Focus",
      shouldBackOutOfPlay: false,
    });
    assert.deepEqual(events, ["exclude:https://example.com/focus#a", "delete:Focus"]);
  });
});
