import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PlaybackStatusPayload } from "@/src/cmd";
import type { SpectrumPlaybackIdentity } from "./SpectrumPage.view-model";
import {
  createSpectrumPlaybackLoopSignalPayload,
  createSpectrumPlaybackSession,
  createSpectrumPlaybackTrackPayload,
  isPlaybackStatusForSpectrumIdentity,
  resolvePlaybackAbsolutePositionMs,
  resolveSpectrumPlaybackActionSnapshotFromStatus,
  resolveSpectrumPlaybackResumePointFromStatus,
  resolveSpectrumPlaybackStatusIdentity,
  type SpectrumPlaybackSessionPorts,
} from "./SpectrumPlaybackSession";

type SpectrumPlaybackPortCallName =
  | "getPlaybackStatus"
  | "playSpectrumMusic"
  | "pauseSpectrumMusic"
  | "updateSpectrumPlaybackLoopSignal";

function createIdentity(
  overrides: Partial<SpectrumPlaybackIdentity> = {},
): SpectrumPlaybackIdentity {
  return {
    endMs: 120_000,
    filePath: "C:/Music/quiet-morning.m4a",
    key: "c:/music/quiet-morning.m4a|Focus Session|https://example.com/quiet-morning#a|0|120000",
    normalizedFilePath: "c:/music/quiet-morning.m4a",
    playlistName: "Focus Session",
    startMs: 0,
    url: "https://example.com/quiet-morning#a",
    ...overrides,
  };
}

function createStatus(overrides: Partial<PlaybackStatusPayload> = {}): PlaybackStatusPayload {
  return {
    duration_ms: 180_000,
    music_url: "https://example.com/quiet-morning#a",
    path: "c:/music/quiet-morning.m4a",
    paused: false,
    playback_end_ms: 120_000,
    playback_start_ms: 0,
    playing: true,
    playlist_name: "Focus Session",
    position_ms: 24_000,
    track_end_ms: 120_000,
    track_start_ms: 0,
    ...overrides,
  };
}

function createPorts(statuses: Array<PlaybackStatusPayload | null> = []) {
  const calls: Array<{
    args: unknown[];
    name: SpectrumPlaybackPortCallName;
  }> = [];
  const statusQueue = [...statuses];
  const peekStatus = () => statusQueue.shift() ?? statuses.at(-1) ?? null;
  const ports: SpectrumPlaybackSessionPorts = {
    async getPlaybackStatus() {
      calls.push({ args: [], name: "getPlaybackStatus" });
      return peekStatus();
    },
    async playSpectrumMusic(...args) {
      calls.push({ args, name: "playSpectrumMusic" });
      return true;
    },
    async pauseSpectrumMusic(...args) {
      calls.push({ args, name: "pauseSpectrumMusic" });
      return true;
    },
    async updateSpectrumPlaybackLoopSignal(...args) {
      calls.push({ args, name: "updateSpectrumPlaybackLoopSignal" });
      return peekStatus();
    },
  };

  return { calls, ports };
}

describe("SpectrumPlaybackSession", () => {
  test("creates the backend track payload from the stable playback identity", () => {
    const identity = createIdentity();

    assert.deepEqual(createSpectrumPlaybackTrackPayload(identity, "Disc 1 Opening"), {
      end_ms: 120_000,
      file_path: "C:/Music/quiet-morning.m4a",
      music_name: "Disc 1 Opening",
      music_url: "https://example.com/quiet-morning#a",
      playlist_name: "Focus Session",
      start_ms: 0,
    });
  });

  test("keeps loop signal overrides separate from the track identity", () => {
    const identity = createIdentity();

    assert.deepEqual(
      createSpectrumPlaybackLoopSignalPayload({
        endMs: 90_000,
        identity,
        musicName: "Disc 1 Opening",
        startMs: 8_000,
      }),
      {
        end_ms: 90_000,
        start_ms: 8_000,
        track: createSpectrumPlaybackTrackPayload(identity, "Disc 1 Opening"),
      },
    );
  });

  test("projects status identity and action snapshot through one session boundary", () => {
    const status = createStatus({ playback_start_ms: 10_000, position_ms: 5_000 });
    const identity = createIdentity({ filePath: "c:/music/quiet-morning.m4a" });

    assert.equal(isPlaybackStatusForSpectrumIdentity(status, identity), true);
    assert.deepEqual(resolveSpectrumPlaybackStatusIdentity(status), identity);
    assert.equal(resolvePlaybackAbsolutePositionMs(status), 15_000);
    assert.deepEqual(resolveSpectrumPlaybackActionSnapshotFromStatus(status), {
      identity,
      paused: false,
    });
    assert.deepEqual(resolveSpectrumPlaybackResumePointFromStatus(status), {
      identity,
      positionMs: 15_000,
    });
  });

  test("stores the immediate pause point as stable backend milliseconds", () => {
    assert.equal(
      resolvePlaybackAbsolutePositionMs(
        createStatus({
          playback_start_ms: 5_000,
          position_ms: 533.599_999_904_633,
        }),
      ),
      5_534,
    );
    assert.equal(
      resolvePlaybackAbsolutePositionMs(
        createStatus({
          playback_start_ms: 5_000,
          position_ms: Number.NaN,
        }),
      ),
      0,
    );
  });

  test("keeps scoped actions inert before the backend scope is available", async () => {
    const { calls, ports } = createPorts([createStatus()]);
    const session = createSpectrumPlaybackSession({ ports, scopeId: null });
    const identity = createIdentity();

    assert.equal(await session.pause({ identity, musicName: "Disc 1 Opening" }), false);
    assert.equal(
      await session.updateLoopSignal({
        endMs: 90_000,
        identity,
        musicName: "Disc 1 Opening",
        startMs: 8_000,
      }),
      null,
    );
    assert.deepEqual(calls, []);
  });

  test("pauses explicitly without reading backend status or toggling resume", async () => {
    const identity = createIdentity();
    const { calls, ports } = createPorts([createStatus({ paused: false })]);

    assert.equal(
      await createSpectrumPlaybackSession({ ports, scopeId: 7 }).pause({
        identity,
        musicName: "Disc 1 Opening",
      }),
      true,
    );
    assert.deepEqual(
      calls.map((call) => call.name),
      ["pauseSpectrumMusic"],
    );
    assert.deepEqual(calls[0]?.args, [
      7,
      createSpectrumPlaybackTrackPayload(identity, "Disc 1 Opening"),
    ]);
  });

  test("starts any spectrum track through the scoped session owner", async () => {
    const identity = createIdentity({
      endMs: 180_000,
      key: "c:/music/quiet-morning.m4a|Focus Session|https://example.com/quiet-morning#b|120000|180000",
      startMs: 120_000,
      url: "https://example.com/quiet-morning#b",
    });
    const started = createStatus({
      music_url: "https://example.com/quiet-morning#b",
      playback_start_ms: 120_000,
      position_ms: 0,
      track_start_ms: 120_000,
      track_end_ms: 180_000,
    });
    const { calls, ports } = createPorts([started]);

    assert.equal(
      await createSpectrumPlaybackSession({ ports, scopeId: 7 }).play({
        identity,
        musicName: "Disc 1 Bridge",
        positionMs: 120_000,
      }),
      started,
    );
    assert.deepEqual(
      calls.map((call) => call.name),
      ["playSpectrumMusic", "getPlaybackStatus"],
    );
    assert.deepEqual(calls[0]?.args, [
      7,
      createSpectrumPlaybackTrackPayload(identity, "Disc 1 Bridge"),
      120_000,
    ]);
  });

  test("keeps scoped play inert before the backend scope is available", async () => {
    const identity = createIdentity();
    const { calls, ports } = createPorts([createStatus({ paused: true })]);

    assert.equal(
      await createSpectrumPlaybackSession({ ports, scopeId: null }).play({
        identity,
        musicName: "Disc 1 Opening",
        positionMs: 0,
      }),
      null,
    );
    assert.deepEqual(calls, []);
  });

  test("updates loop signal through the scoped session owner", async () => {
    const identity = createIdentity();
    const status = createStatus({ track_start_ms: 8_000, track_end_ms: 90_000 });
    const { calls, ports } = createPorts([status]);

    assert.equal(
      await createSpectrumPlaybackSession({ ports, scopeId: 7 }).updateLoopSignal({
        endMs: 90_000,
        identity,
        musicName: "Disc 1 Opening",
        startMs: 8_000,
      }),
      status,
    );
    assert.deepEqual(
      calls.map((call) => call.name),
      ["updateSpectrumPlaybackLoopSignal"],
    );
    assert.deepEqual(calls[0]?.args, [
      7,
      createSpectrumPlaybackLoopSignalPayload({
        endMs: 90_000,
        identity,
        musicName: "Disc 1 Opening",
        startMs: 8_000,
      }),
    ]);
  });
});
