import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Collection, PlayList } from "@/src/cmd";
import {
  createSpectrumMusicTitleDraft,
  hasSpectrumMusicTitleChanges,
  resolveSpectrumMusicTitleCommit,
  updateMusicAliasInCollections,
  updateMusicAliasInPlaylistPreview,
  updateMusicAliasInPlaylists,
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
    assert.equal(hasSpectrumMusicTitleChanges(draft && { ...draft, name: "Track A" }), false);
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

  test("updates matching music aliases across collections, playlists, and previews", () => {
    const edit = {
      alias: "Track B",
      url: "https://example.com/quiet-morning#a",
      start: 0,
      end: 120,
    };

    assert.equal(
      updateMusicAliasInCollections([sampleCollection], edit)[0]?.musics[0]?.name,
      "Track A",
    );
    assert.equal(
      updateMusicAliasInCollections([sampleCollection], edit)[0]?.musics[0]?.alias,
      "Track B",
    );
    assert.equal(
      updateMusicAliasInPlaylists([samplePlaylist], edit)[0]?.collections[0]?.musics[0]?.alias,
      "Track B",
    );
    assert.equal(
      updateMusicAliasInPlaylistPreview(
        {
          playlist: samplePlaylist,
          previousName: null,
        },
        edit,
      )?.playlist.collections[0]?.musics[0]?.alias,
      "Track B",
    );
  });
});
