import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  INACTIVE_PLAYBACK_SURFACE,
  resolveMachinePlaybackTarget,
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

  test("promotes the surface into centering when play starts for a different playlist", () => {
    assert.deepEqual(
      syncPlaybackSurfaceState({
        current: INACTIVE_PLAYBACK_SURFACE,
        machinePlaybackTarget: "Quiet Morning",
        nowPlayingTrackName: null,
      }),
      {
        phase: "centering",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
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
        },
        machinePlaybackTarget: "Quiet Morning",
        nowPlayingTrackName: "Track B",
      }),
      {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track B",
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
        },
        machinePlaybackTarget: null,
        nowPlayingTrackName: null,
      }),
      {
        phase: "restoring",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
      },
    );
  });

  test("only exposes render snapshots for active visual phases", () => {
    assert.equal(toPlayListPlaybackSurfaceSnapshot(INACTIVE_PLAYBACK_SURFACE), null);
    assert.deepEqual(
      toPlayListPlaybackSurfaceSnapshot({
        phase: "restoring",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
      }),
      {
        phase: "restoring",
        playlistName: "Quiet Morning",
        displayedTrackName: null,
      },
    );
  });
});
