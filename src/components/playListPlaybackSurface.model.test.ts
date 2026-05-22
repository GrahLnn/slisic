import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  INACTIVE_PLAYBACK_SURFACE,
  resolveMachinePlaybackTarget,
  resolvePlaybackSurfaceAfterTorphStage,
  syncPlaybackSurfaceState,
  toPlayListPlaybackSurfaceSnapshot,
} from "./playListPlaybackSurface.model";

describe("playListPlaybackSurface model", () => {
  test("only exposes a machine playback target while play mode points at a visible playlist", () => {
    assert.equal(
      resolveMachinePlaybackTarget({
        pageState: "ready",
        playlists: [{ name: "Quiet Morning" }],
        playingPlaylistName: "Quiet Morning",
      }),
      null,
    );
    assert.equal(
      resolveMachinePlaybackTarget({
        pageState: "play",
        playlists: [{ name: "Quiet Morning" }],
        playingPlaylistName: "Missing",
      }),
      null,
    );
    assert.equal(
      resolveMachinePlaybackTarget({
        pageState: "play",
        playlists: [{ name: "Quiet Morning" }],
        playingPlaylistName: "Quiet Morning",
      }),
      "Quiet Morning",
    );
  });

  test("shows the playback surface immediately when play starts", () => {
    assert.deepEqual(
      syncPlaybackSurfaceState({
        current: INACTIVE_PLAYBACK_SURFACE,
        machinePlaybackTarget: "Quiet Morning",
        nowPlayingTrack: null,
      }),
      {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
    );
  });

  test("keeps the current target while only refreshing the displayed track name", () => {
    assert.deepEqual(
      syncPlaybackSurfaceState({
        current: {
          phase: "playing",
          playlistName: "Quiet Morning",
          displayedTrackName: "Track A",
          displayedTrackLiked: null,
          displayedTrackIsPlayable: true,
        },
        machinePlaybackTarget: "Quiet Morning",
        nowPlayingTrack: {
          name: "Track B",
          liked: false,
          url: "https://example.com/track-b",
        },
      }),
      {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track B",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: true,
      },
    );
  });

  test("starts with the current track when playback reports before the first render sync", () => {
    assert.deepEqual(
      syncPlaybackSurfaceState({
        current: INACTIVE_PLAYBACK_SURFACE,
        machinePlaybackTarget: "Quiet Morning",
        nowPlayingTrack: {
          name: "Track A",
          liked: false,
          url: "https://example.com/track-a",
        },
      }),
      {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track A",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: true,
      },
    );
  });

  test("marks non-playable playback status text separately from its label", () => {
    assert.deepEqual(
      syncPlaybackSurfaceState({
        current: INACTIVE_PLAYBACK_SURFACE,
        machinePlaybackTarget: "Quiet Morning",
        nowPlayingTrack: {
          name: "Preparing...",
          liked: false,
          url: "",
        },
      }),
      {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Preparing...",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
    );
  });

  test("moves into restoring when machine playback ends but the visual surface still owns a playlist", () => {
    assert.deepEqual(
      syncPlaybackSurfaceState({
        current: {
          phase: "playing",
          playlistName: "Quiet Morning",
          displayedTrackName: "Track B",
          displayedTrackLiked: null,
          displayedTrackIsPlayable: true,
        },
        machinePlaybackTarget: null,
        nowPlayingTrack: null,
      }),
      {
        phase: "restoring",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
        restoreTransitionStarted: false,
      },
    );
  });

  test("keeps restoring active until the restore text transition starts and then idles", () => {
    const restoring = syncPlaybackSurfaceState({
      current: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track B",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: true,
      },
      machinePlaybackTarget: null,
      nowPlayingTrack: null,
    });

    assert.deepEqual(
      resolvePlaybackSurfaceAfterTorphStage({
        current: restoring,
        playlistName: "Quiet Morning",
        stage: "idle",
      }),
      restoring,
    );

    const started = resolvePlaybackSurfaceAfterTorphStage({
      current: restoring,
      playlistName: "Quiet Morning",
      stage: "prepare",
    });

    assert.deepEqual(started, {
      phase: "restoring",
      playlistName: "Quiet Morning",
      displayedTrackName: null,
      displayedTrackLiked: null,
      displayedTrackIsPlayable: false,
      restoreTransitionStarted: true,
    });
    assert.deepEqual(
      resolvePlaybackSurfaceAfterTorphStage({
        current: started,
        playlistName: "Quiet Morning",
        stage: "idle",
      }),
      INACTIVE_PLAYBACK_SURFACE,
    );
  });

  test("does not create a restoring phase when the displayed text is already the playlist title", () => {
    assert.deepEqual(
      syncPlaybackSurfaceState({
        current: {
          phase: "playing",
          playlistName: "Quiet Morning",
          displayedTrackName: "Quiet Morning",
          displayedTrackLiked: null,
          displayedTrackIsPlayable: true,
        },
        machinePlaybackTarget: null,
        nowPlayingTrack: null,
      }),
      INACTIVE_PLAYBACK_SURFACE,
    );
  });

  test("only exposes render snapshots for active visual phases", () => {
    assert.equal(toPlayListPlaybackSurfaceSnapshot(INACTIVE_PLAYBACK_SURFACE), null);
    assert.deepEqual(
      toPlayListPlaybackSurfaceSnapshot({
        phase: "restoring",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
        restoreTransitionStarted: true,
      }),
      {
        phase: "restoring",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
    );
  });

  test("keeps the playlist title until the player reports a track", () => {
    assert.deepEqual(
      syncPlaybackSurfaceState({
        current: {
          phase: "playing",
          playlistName: "Quiet Morning",
          displayedTrackName: null,
          displayedTrackLiked: null,
          displayedTrackIsPlayable: false,
        },
        machinePlaybackTarget: "Quiet Morning",
        nowPlayingTrack: null,
      }),
      {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
    );
  });
});
