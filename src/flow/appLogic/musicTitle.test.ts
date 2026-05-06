import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Collection, PlayList } from "@/src/cmd";
import {
  createSpectrumMusicTitleDraft,
  changeSpectrumMusicTitleDraftRange,
  hasSpectrumMusicTitleChanges,
  resolveSpectrumMusicTitleCommit,
  resetSpectrumMusicTitleDraft,
  updateMusicInCollections,
  updateMusicInPlaylistPreview,
  updateMusicInPlaylists,
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

describe("musicTitle", () => {
  test("creates a spectrum music draft only when a track title exists", () => {
    assert.deepEqual(
      createSpectrumMusicTitleDraft({
        nowPlayingTrackName: "Track A",
        nowPlayingTrackUrl: "https://example.com/quiet-morning#a",
        nowPlayingTrackStartMs: 0,
        nowPlayingTrackEndMs: 120_000,
      }),
      {
        baselineName: "Track A",
        baselineStartMs: 0,
        baselineEndMs: 120_000,
        name: "Track A",
        url: "https://example.com/quiet-morning#a",
        startMs: 0,
        endMs: 120_000,
      },
    );
    assert.equal(
      createSpectrumMusicTitleDraft({
        nowPlayingTrackName: null,
        nowPlayingTrackUrl: null,
        nowPlayingTrackStartMs: null,
        nowPlayingTrackEndMs: null,
      }),
      null,
    );
  });

  test("compares edits with the current music data instead of edit count", () => {
    const draft = createSpectrumMusicTitleDraft({
      nowPlayingTrackName: "Track A",
      nowPlayingTrackUrl: "https://example.com/quiet-morning#a",
      nowPlayingTrackStartMs: 0,
      nowPlayingTrackEndMs: 120_000,
    });

    assert.equal(hasSpectrumMusicTitleChanges(draft), false);
    assert.equal(hasSpectrumMusicTitleChanges(draft && { ...draft, name: "Track B" }), true);
    assert.equal(hasSpectrumMusicTitleChanges(draft && { ...draft, name: " Track A " }), false);
    assert.equal(hasSpectrumMusicTitleChanges(draft && { ...draft, startMs: 8_000 }), true);
    assert.equal(hasSpectrumMusicTitleChanges(draft && { ...draft, endMs: 112_000 }), true);
  });

  test("keeps spectrum draft range edits at millisecond precision", () => {
    const draft = createSpectrumMusicTitleDraft({
      nowPlayingTrackName: "Track A",
      nowPlayingTrackUrl: "https://example.com/quiet-morning#a",
      nowPlayingTrackStartMs: 0,
      nowPlayingTrackEndMs: 120_000,
    });

    const edited = changeSpectrumMusicTitleDraftRange(draft, {
      endMs: 112_750,
      startMs: 8_250,
    });

    assert.equal(edited?.startMs, 8_250);
    assert.equal(edited?.endMs, 112_750);
    assert.equal(hasSpectrumMusicTitleChanges(edited), true);
    assert.equal(hasSpectrumMusicTitleChanges(draft && { ...draft, startMs: 0 }), false);
    assert.equal(hasSpectrumMusicTitleChanges(draft && { ...draft, startMs: 1 }), true);
  });

  test("resets the spectrum music draft to the current music baseline", () => {
    const draft = createSpectrumMusicTitleDraft({
      nowPlayingTrackName: "Track A",
      nowPlayingTrackUrl: "https://example.com/quiet-morning#a",
      nowPlayingTrackStartMs: 0,
      nowPlayingTrackEndMs: 120_000,
    });

    assert.deepEqual(
      resetSpectrumMusicTitleDraft(
        draft &&
          changeSpectrumMusicTitleDraftRange(
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

  test("restores the baseline title when the edit is empty", () => {
    const draft = createSpectrumMusicTitleDraft({
      nowPlayingTrackName: "Track A",
      nowPlayingTrackUrl: "https://example.com/quiet-morning#a",
      nowPlayingTrackStartMs: 0,
      nowPlayingTrackEndMs: 120_000,
    });

    assert.deepEqual(resolveSpectrumMusicTitleCommit(draft && { ...draft, name: "" }), {
      kind: "restore",
      alias: "Track A",
    });
    assert.deepEqual(resolveSpectrumMusicTitleCommit(draft && { ...draft, name: " Track B " }), {
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
});
