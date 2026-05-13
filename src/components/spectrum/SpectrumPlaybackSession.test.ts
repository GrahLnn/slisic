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
  resolveSpectrumResumePositionForIdentity,
  resolveSpectrumPlaybackActionSnapshotFromStatus,
  resolveSpectrumPlaybackStatusIdentity,
  type SpectrumPlaybackResumePoint,
  type SpectrumPlaybackSessionPorts,
} from "./SpectrumPlaybackSession";

type SpectrumPlaybackPortCallName =
  | "getPlaybackStatus"
  | "pauseSpectrumMusic"
  | "playSpectrumMusic"
  | "restoreSpectrumMusic"
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
    async pauseSpectrumMusic(...args) {
      calls.push({ args, name: "pauseSpectrumMusic" });
      return true;
    },
    async playSpectrumMusic(...args) {
      calls.push({ args, name: "playSpectrumMusic" });
      return true;
    },
    async restoreSpectrumMusic(...args) {
      calls.push({ args, name: "restoreSpectrumMusic" });
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
  });

  test("keeps scoped actions inert before the backend scope is available", async () => {
    const { calls, ports } = createPorts([createStatus()]);
    const session = createSpectrumPlaybackSession({ ports, scopeId: null });
    const identity = createIdentity();
    const resume = { identity, positionMs: 8_000 };

    assert.equal(await session.pause({ identity, musicName: "Disc 1 Opening" }), false);
    assert.equal(
      await session.playFromPosition({
        identity,
        musicName: "Disc 1 Opening",
        positionMs: 8_000,
      }),
      false,
    );
    assert.equal(
      await session.updateLoopSignal({
        endMs: 90_000,
        identity,
        musicName: "Disc 1 Opening",
        startMs: 8_000,
      }),
      null,
    );
    assert.equal(
      await session.restoreResumePoint({ identity, musicName: "Disc 1 Opening", resume }),
      null,
    );
    assert.deepEqual(calls, []);
  });

  test("plays from the explicit frontend resume point without reading backend status", async () => {
    const identity = createIdentity();
    const { calls, ports } = createPorts([createStatus()]);
    const session = createSpectrumPlaybackSession({ ports, scopeId: 7 });

    assert.equal(
      await session.playFromPosition({
        identity,
        musicName: "Disc 1 Opening",
        positionMs: 42_000,
      }),
      true,
    );
    assert.deepEqual(
      calls.map((call) => call.name),
      ["playSpectrumMusic"],
    );
    assert.deepEqual(calls[0]?.args, [
      7,
      createSpectrumPlaybackTrackPayload(identity, "Disc 1 Opening"),
      42_000,
    ]);
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

  test("uses only the matching frontend pause point as the resume position", () => {
    const identity = createIdentity();
    const otherIdentity = createIdentity({
      endMs: 180_000,
      key: "c:/music/quiet-morning.m4a|Focus Session|https://example.com/quiet-morning#b|120000|180000",
      startMs: 120_000,
      url: "https://example.com/quiet-morning#b",
    });
    const resume = {
      identity,
      positionMs: 42_000,
    } satisfies SpectrumPlaybackResumePoint;

    assert.equal(
      resolveSpectrumResumePositionForIdentity({
        identity,
        resume,
      }),
      42_000,
    );
    assert.equal(
      resolveSpectrumResumePositionForIdentity({
        identity: otherIdentity,
        resume,
      }),
      null,
    );
  });

  test("restores from the stored resume point only when the current status needs it", async () => {
    const identity = createIdentity();
    const resume = { identity, positionMs: 8_000 };
    const alreadyPlaying = createStatus({ paused: false, position_ms: 24_000 });
    const inactive = createStatus({
      music_url: "https://example.com/quiet-morning#b",
      track_start_ms: 120_000,
      track_end_ms: 180_000,
    });
    const alreadyPlayingPorts = createPorts([alreadyPlaying]);
    const inactivePorts = createPorts([inactive, createStatus({ position_ms: 8_000 })]);

    assert.equal(
      await createSpectrumPlaybackSession({
        ports: alreadyPlayingPorts.ports,
        scopeId: 7,
      }).restoreResumePoint({
        identity,
        musicName: "Disc 1 Opening",
        resume,
      }),
      alreadyPlaying,
    );
    assert.deepEqual(
      alreadyPlayingPorts.calls.map((call) => call.name),
      ["getPlaybackStatus"],
    );

    await createSpectrumPlaybackSession({
      ports: inactivePorts.ports,
      scopeId: 7,
    }).restoreResumePoint({
      identity,
      musicName: "Disc 1 Opening",
      resume,
    });
    assert.deepEqual(
      inactivePorts.calls.map((call) => call.name),
      ["getPlaybackStatus", "restoreSpectrumMusic", "getPlaybackStatus"],
    );
    assert.deepEqual(inactivePorts.calls[1]?.args, [
      7,
      createSpectrumPlaybackTrackPayload(identity, "Disc 1 Opening"),
      8_000,
    ]);
  });
});
