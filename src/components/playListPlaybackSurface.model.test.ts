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
  test("exposes the accepted machine playback target without waiting for playlist projection", () => {
    assert.equal(
      resolveMachinePlaybackTarget({
        pageState: "ready",
        playingPlaylistName: "Quiet Morning",
      }),
      null,
    );
    assert.equal(
      resolveMachinePlaybackTarget({
        pageState: "play",
        playingPlaylistName: "Quiet Morning",
      }),
      "Quiet Morning",
    );
    assert.equal(
      resolveMachinePlaybackTarget({
        pageState: "play",
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
        playingSessionGeneration: 1,
        nowPlayingTrack: null,
        playbackSurfaceStatus: null,
      }),
      {
        phase: "playing",
        playlistName: "Quiet Morning",
        sessionGeneration: 1,
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
          sessionGeneration: 1,
          displayedTrackName: "Track A",
          displayedTrackLiked: null,
          displayedTrackIsPlayable: true,
        },
        machinePlaybackTarget: "Quiet Morning",
        playingSessionGeneration: 1,
        nowPlayingTrack: {
          name: "Track B",
          liked: false,
          url: "https://example.com/track-b",
        },
        playbackSurfaceStatus: null,
      }),
      {
        phase: "playing",
        playlistName: "Quiet Morning",
        sessionGeneration: 1,
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
        playingSessionGeneration: 1,
        nowPlayingTrack: {
          name: "Track A",
          liked: false,
          url: "https://example.com/track-a",
        },
        playbackSurfaceStatus: null,
      }),
      {
        phase: "playing",
        playlistName: "Quiet Morning",
        sessionGeneration: 1,
        displayedTrackName: "Track A",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: true,
      },
    );
  });

  test("shows preparing only from explicit playback surface status", () => {
    assert.deepEqual(
      syncPlaybackSurfaceState({
        current: INACTIVE_PLAYBACK_SURFACE,
        machinePlaybackTarget: "Quiet Morning",
        playingSessionGeneration: 1,
        nowPlayingTrack: null,
        playbackSurfaceStatus: "preparing",
      }),
      {
        phase: "playing",
        playlistName: "Quiet Morning",
        sessionGeneration: 1,
        displayedTrackName: "Preparing...",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
    );
  });

  test("projects preparing on the first play sync without waiting for playlist projection", () => {
    const machinePlaybackTarget = resolveMachinePlaybackTarget({
      pageState: "play",
      playingPlaylistName: "PlayList 1",
    });

    assert.deepEqual(
      syncPlaybackSurfaceState({
        current: INACTIVE_PLAYBACK_SURFACE,
        machinePlaybackTarget,
        playingSessionGeneration: 1,
        nowPlayingTrack: null,
        playbackSurfaceStatus: "preparing",
      }),
      {
        phase: "playing",
        playlistName: "PlayList 1",
        sessionGeneration: 1,
        displayedTrackName: "Preparing...",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
    );
  });

  test("replaces preparing with a real now playing track", () => {
    assert.deepEqual(
      syncPlaybackSurfaceState({
        current: {
          phase: "playing",
          playlistName: "Quiet Morning",
          sessionGeneration: 1,
          displayedTrackName: "Preparing...",
          displayedTrackLiked: null,
          displayedTrackIsPlayable: false,
        },
        machinePlaybackTarget: "Quiet Morning",
        playingSessionGeneration: 1,
        nowPlayingTrack: {
          name: "Track A",
          liked: true,
          url: "https://example.com/track-a",
        },
        playbackSurfaceStatus: null,
      }),
      {
        phase: "playing",
        playlistName: "Quiet Morning",
        sessionGeneration: 1,
        displayedTrackName: "Track A",
        displayedTrackLiked: true,
        displayedTrackIsPlayable: true,
      },
    );
  });

  test("moves into restoring when machine playback ends but the visual surface still owns a playlist", () => {
    assert.deepEqual(
      syncPlaybackSurfaceState({
        current: {
          phase: "playing",
          playlistName: "Quiet Morning",
          sessionGeneration: 1,
          displayedTrackName: "Track B",
          displayedTrackLiked: null,
          displayedTrackIsPlayable: true,
        },
        machinePlaybackTarget: null,
        playingSessionGeneration: null,
        nowPlayingTrack: null,
        playbackSurfaceStatus: null,
      }),
      {
        phase: "restoring",
        playlistName: "Quiet Morning",
        sessionGeneration: 1,
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
        sessionGeneration: 1,
        displayedTrackName: "Track B",
        displayedTrackLiked: null,
        displayedTrackIsPlayable: true,
      },
      machinePlaybackTarget: null,
      playingSessionGeneration: null,
      nowPlayingTrack: null,
      playbackSurfaceStatus: null,
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
      sessionGeneration: 1,
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
          sessionGeneration: 1,
          displayedTrackName: "Quiet Morning",
          displayedTrackLiked: null,
          displayedTrackIsPlayable: true,
        },
        machinePlaybackTarget: null,
        playingSessionGeneration: null,
        nowPlayingTrack: null,
        playbackSurfaceStatus: null,
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
        sessionGeneration: 1,
        displayedTrackName: null,
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
        restoreTransitionStarted: true,
      }),
      {
        phase: "restoring",
        playlistName: "Quiet Morning",
        sessionGeneration: 1,
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
          sessionGeneration: 1,
          displayedTrackName: null,
          displayedTrackLiked: null,
          displayedTrackIsPlayable: false,
        },
        machinePlaybackTarget: "Quiet Morning",
        playingSessionGeneration: 1,
        nowPlayingTrack: null,
        playbackSurfaceStatus: null,
      }),
      {
        phase: "playing",
        playlistName: "Quiet Morning",
        sessionGeneration: 1,
        displayedTrackName: null,
        displayedTrackLiked: null,
        displayedTrackIsPlayable: false,
      },
    );
  });
});
