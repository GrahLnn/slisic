import { describe, expect, test } from "bun:test";
import {
  applyOptimisticEditSave,
  buildOptimisticPlaylistFromSlot,
  buildPostSavePatch,
  deriveRefreshPatch,
  hasPlaybackContext,
  shouldAdvanceOnUnstar,
  shouldHandleAudioEnded,
  type MusicState,
} from "./store";
import type { Entry, Music, Playlist } from "@/src/cmd/commands";

const baseState: MusicState = {
  mode: "play",
  loading: false,
  playlists: [],
  selectedListName: "contemporary",
  nowPlaying: {
    path: "C:/audio/a.flac",
    title: "A",
    avg_db: -18,
    true_peak_dbtp: -2,
    base_bias: 0,
    user_boost: 0,
    fatigue: 0,
    diversity: 0,
  },
  nowJudge: null,
  slot: null,
  processMsg: null,
  ytdlp: null,
  ffmpeg: null,
  savePath: null,
  initialized: true,
  linkReviews: [],
  folderReviews: [],
  weblistReviews: [],
  playbackEpoch: 3,
};

function makePlaylist(name: string): Playlist {
  return {
    name,
    avg_db: null,
    entries: [],
    exclude: [],
  };
}

function makeMusic(path: string): Music {
  return {
    path,
    title: path.split("/").pop() ?? path,
    avg_db: null,
    true_peak_dbtp: null,
    base_bias: 0,
    user_boost: 0,
    fatigue: 0,
    diversity: 0,
  };
}

function makeEntry(name: string, path: string): Entry {
  return {
    path,
    name,
    musics: [makeMusic(`${path}/a.flac`)],
    avg_db: null,
    url: null,
    downloaded_ok: true,
    tracking: false,
    entry_type: "Local",
  };
}

describe("music interaction guards", () => {
  test("shouldAdvanceOnUnstar only true for current playing item in current play list", () => {
    expect(
      shouldAdvanceOnUnstar(baseState, "contemporary", "C:/audio/a.flac"),
    ).toBe(true);
    expect(
      shouldAdvanceOnUnstar(baseState, "contemporary", "C:/audio/b.flac"),
    ).toBe(false);
    expect(
      shouldAdvanceOnUnstar(
        { ...baseState, selectedListName: "other" },
        "contemporary",
        "C:/audio/a.flac",
      ),
    ).toBe(false);
    expect(
      shouldAdvanceOnUnstar(
        { ...baseState, mode: "edit" },
        "contemporary",
        "C:/audio/a.flac",
      ),
    ).toBe(false);
  });

  test("buildPostSavePatch should clear playback context and keep mode by data presence", () => {
    const withData = buildPostSavePatch(true, 9);
    expect(withData.mode).toBe("play");
    expect(withData.selectedListName).toBeNull();
    expect(withData.nowPlaying).toBeNull();
    expect(withData.playbackEpoch).toBe(9);

    const empty = buildPostSavePatch(false, 12);
    expect(empty.mode).toBe("new_guide");
    expect(empty.selectedListName).toBeNull();
    expect(empty.nowPlaying).toBeNull();
    expect(empty.playbackEpoch).toBe(12);
  });

  test("hasPlaybackContext should reject stale playback fields outside play mode", () => {
    expect(hasPlaybackContext(baseState)).toBe(true);
    expect(hasPlaybackContext({ ...baseState, mode: "edit" })).toBe(false);
    expect(hasPlaybackContext({ ...baseState, mode: "create" })).toBe(false);
    expect(
      hasPlaybackContext({
        ...baseState,
        selectedListName: null,
        nowPlaying: null,
      }),
    ).toBe(false);
  });

  test("shouldHandleAudioEnded should reject cross-mode or cross-track event bridging", () => {
    expect(shouldHandleAudioEnded(baseState, "C:/audio/a.flac")).toBe(true);
    expect(shouldHandleAudioEnded(baseState, "C:/audio/b.flac")).toBe(false);
    expect(
      shouldHandleAudioEnded(
        { ...baseState, selectedListName: null },
        "C:/audio/a.flac",
      ),
    ).toBe(false);
    expect(
      shouldHandleAudioEnded(
        { ...baseState, nowPlaying: null },
        "C:/audio/a.flac",
      ),
    ).toBe(false);
    expect(
      shouldHandleAudioEnded({ ...baseState, mode: "edit" }, "C:/audio/a.flac"),
    ).toBe(false);
  });

  test("deriveRefreshPatch should preserve edit/create mode and clear impossible playback context", () => {
    const playlists = [makePlaylist("contemporary"), makePlaylist("ambient")];

    const keepPlay = deriveRefreshPatch(baseState, playlists);
    expect(keepPlay.mode).toBe("play");
    expect(keepPlay.selectedListName).toBe("contemporary");
    expect(keepPlay.nowPlaying?.path).toBe("C:/audio/a.flac");

    const lostSelection = deriveRefreshPatch(
      { ...baseState, selectedListName: "missing" },
      playlists,
    );
    expect(lostSelection.mode).toBe("play");
    expect(lostSelection.selectedListName).toBeNull();
    expect(lostSelection.nowPlaying).toBeNull();

    const editMode = deriveRefreshPatch(
      { ...baseState, mode: "edit", selectedListName: "missing" },
      [],
    );
    expect(editMode.mode).toBe("edit");
    expect(editMode.selectedListName).toBeNull();
    expect(editMode.nowPlaying).toBeNull();

    const createMode = deriveRefreshPatch(
      { ...baseState, mode: "create", selectedListName: "missing" },
      [],
    );
    expect(createMode.mode).toBe("create");
    expect(createMode.selectedListName).toBeNull();
    expect(createMode.nowPlaying).toBeNull();

    const emptyPlay = deriveRefreshPatch(
      { ...baseState, mode: "play", selectedListName: "missing" },
      [],
    );
    expect(emptyPlay.mode).toBe("new_guide");
  });

  test("buildOptimisticPlaylistFromSlot should project slot to playlist shape", () => {
    const playlist = buildOptimisticPlaylistFromSlot(
      {
        name: "  modern  ",
        folders: [],
        links: [],
        entries: [makeEntry("alpha", "C:/music/alpha")],
        exclude: [],
      },
      makePlaylist("anchor"),
    );
    expect(playlist.name).toBe("modern");
    expect(playlist.avg_db).toBeNull();
    expect(Array.isArray(playlist.entries)).toBe(true);
    expect(Array.isArray(playlist.exclude)).toBe(true);
  });

  test("applyOptimisticEditSave should replace anchor playlist in place", () => {
    const first = makePlaylist("a");
    const second = makePlaylist("b");
    const next = applyOptimisticEditSave([first, second], first, {
      name: "renamed",
      folders: [],
      links: [],
      entries: [],
      exclude: [],
    });
    expect(next).toHaveLength(2);
    expect(next[0].name).toBe("renamed");
    expect(next[1].name).toBe("b");
  });
});
