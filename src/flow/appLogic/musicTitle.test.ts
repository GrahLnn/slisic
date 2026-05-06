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
      start: 0,
      end: 120,
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
        nowPlayingTrackStart: 0,
        nowPlayingTrackEnd: 120,
      }),
      {
        baselineName: "Track A",
        baselineStart: 0,
        baselineEnd: 120,
        name: "Track A",
        url: "https://example.com/quiet-morning#a",
        start: 0,
        end: 120,
      },
    );
    assert.equal(
      createSpectrumMusicTitleDraft({
        nowPlayingTrackName: null,
        nowPlayingTrackUrl: null,
        nowPlayingTrackStart: null,
        nowPlayingTrackEnd: null,
      }),
      null,
    );
  });

  test("compares edits with the current music data instead of edit count", () => {
    const draft = createSpectrumMusicTitleDraft({
      nowPlayingTrackName: "Track A",
      nowPlayingTrackUrl: "https://example.com/quiet-morning#a",
      nowPlayingTrackStart: 0,
      nowPlayingTrackEnd: 120,
    });

    assert.equal(hasSpectrumMusicTitleChanges(draft), false);
    assert.equal(hasSpectrumMusicTitleChanges(draft && { ...draft, name: "Track B" }), true);
    assert.equal(hasSpectrumMusicTitleChanges(draft && { ...draft, name: " Track A " }), false);
    assert.equal(hasSpectrumMusicTitleChanges(draft && { ...draft, start: 8 }), true);
    assert.equal(hasSpectrumMusicTitleChanges(draft && { ...draft, end: 112 }), true);
  });

  test("resets the spectrum music draft to the current music baseline", () => {
    const draft = createSpectrumMusicTitleDraft({
      nowPlayingTrackName: "Track A",
      nowPlayingTrackUrl: "https://example.com/quiet-morning#a",
      nowPlayingTrackStart: 0,
      nowPlayingTrackEnd: 120,
    });

    assert.deepEqual(
      resetSpectrumMusicTitleDraft(
        draft &&
          changeSpectrumMusicTitleDraftRange(
            {
              ...draft,
              name: "Track B",
            },
            { start: 8, end: 112 },
          ),
      ),
      draft,
    );
  });

  test("restores the baseline title when the edit is empty", () => {
    const draft = createSpectrumMusicTitleDraft({
      nowPlayingTrackName: "Track A",
      nowPlayingTrackUrl: "https://example.com/quiet-morning#a",
      nowPlayingTrackStart: 0,
      nowPlayingTrackEnd: 120,
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
      targetStart: 0,
      targetEnd: 120,
      start: 8,
      end: 112,
    };
    const updated = updateMusicInCollections([sampleCollection], edit)[0]?.musics[0];

    assert.equal(updated?.name, "Track A");
    assert.equal(updated?.alias, "Track B");
    assert.equal(updated?.start, 8);
    assert.equal(updated?.end, 112);
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
      )?.playlist.collections[0]?.musics[0]?.end,
      112,
    );
  });
});
