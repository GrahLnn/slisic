import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AUDIO_VISUALIZATION_LIVE_SIGNAL_TTL_MS,
  normalizeAudioVisualizationFrame,
  resolveAudioVisualizationActivity,
  shouldResolveAudioVisualizationReactiveSignal,
  type PlaybackAudioVisualizationFrame,
} from "./model";

function createFrame(overrides: Partial<PlaybackAudioVisualizationFrame> = {}) {
  return {
    canonical_music_id: "track:1",
    current_position_ms: 1_500,
    dynamics: 0.5,
    file_path: "C:/music/demo.m4a",
    loudness_energy: 0.7,
    music_name: "Demo",
    music_url: "https://example.com/demo",
    paused: false,
    playing: true,
    playlist_name: "List",
    presence: 0.4,
    range_end_ms: 2_000,
    range_progress: null,
    range_start_ms: 1_000,
    session_generation: 1,
    ...overrides,
  } satisfies PlaybackAudioVisualizationFrame;
}

describe("audio visualization frame model", () => {
  test("normalizes progress and audio response values into bounded coordinates", () => {
    const snapshot = normalizeAudioVisualizationFrame(
      createFrame({
        current_position_ms: 3_000,
        dynamics: 8,
        loudness_energy: -1,
        presence: null,
      }),
      120,
    );

    assert.equal(snapshot.current_position_ms, 2_000);
    assert.equal(snapshot.range_progress, 1);
    assert.equal(snapshot.loudness_energy, 0);
    assert.equal(snapshot.presence, 0.35);
    assert.equal(snapshot.dynamics, 1);
    assert.equal(snapshot.received_at_ms, 120);
  });

  test("fades stale or paused frames without deleting their last visual identity", () => {
    const frame = normalizeAudioVisualizationFrame(createFrame({ paused: true }), 1_000);

    assert.equal(resolveAudioVisualizationActivity({ frame, nowMs: 1_000 }), 0);
    assert.equal(resolveAudioVisualizationActivity({ frame, nowMs: 5_000 }), 0);
    assert.equal(resolveAudioVisualizationActivity({ frame: null, nowMs: 1_000 }), 0);
  });

  test("projects stopped frames to idle coefficients immediately", () => {
    const frame = normalizeAudioVisualizationFrame(
      createFrame({
        dynamics: 0.9,
        loudness_energy: 0.8,
        playing: false,
        presence: 0.7,
      }),
      1_000,
    );

    assert.equal(frame.loudness_energy, 0.18);
    assert.equal(frame.presence, 0.18);
    assert.equal(frame.dynamics, 0.24);
    assert.equal(resolveAudioVisualizationActivity({ frame, nowMs: 1_000 }), 0);
  });

  test("keeps active playback anchors reactive only while frame evidence is fresh", () => {
    const fresh = normalizeAudioVisualizationFrame(createFrame(), 1_000);

    assert.equal(
      shouldResolveAudioVisualizationReactiveSignal({
        frame: fresh,
        nowMs: 1_000 + AUDIO_VISUALIZATION_LIVE_SIGNAL_TTL_MS,
      }),
      true,
    );
    assert.equal(
      shouldResolveAudioVisualizationReactiveSignal({
        frame: normalizeAudioVisualizationFrame(createFrame({ paused: true }), 1_000),
        nowMs: 1_000,
      }),
      false,
    );
    assert.equal(
      shouldResolveAudioVisualizationReactiveSignal({
        frame: normalizeAudioVisualizationFrame(createFrame({ playing: false }), 1_000),
        nowMs: 1_000,
      }),
      false,
    );
    assert.equal(
      shouldResolveAudioVisualizationReactiveSignal({
        frame: fresh,
        nowMs: 1_001 + AUDIO_VISUALIZATION_LIVE_SIGNAL_TTL_MS,
      }),
      false,
    );
  });
});
