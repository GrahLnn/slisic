import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrackWaveformSummary, TrackWaveformTile } from "@/src/cmd";
import {
  resolveAudioVisualizationBrightTransientFromTile,
  resetAudioVisualizationReactivityCacheForTest,
  resolveAudioVisualizationInstantEnergyFromTile,
  resolveAudioVisualizationLiveFrame,
  resolveAudioVisualizationReactiveFrame,
} from "./reactivity";
import {
  AUDIO_VISUALIZATION_LIVE_SIGNAL_TTL_MS,
  normalizeAudioVisualizationFrame,
} from "./model";

const currentDir = dirname(fileURLToPath(import.meta.url));

function createSummary(): TrackWaveformSummary {
  return {
    base_points_per_second: 80,
    cache_key: "demo-waveform",
    chunk_duration_ms: 60_000,
    duration_ms: 10_000,
    levels: [80],
    sample_rate: 48_000,
    samples_per_point: 600,
    start_ms: 0,
  };
}

function createTile(maxValue: number): TrackWaveformTile {
  return {
    max: Array.from({ length: 800 }, () => maxValue),
    min: Array.from({ length: 800 }, () => -maxValue),
    points_per_second: 80,
    start_px: 0,
    width_px: 800,
  };
}

function createSteppedTile(): TrackWaveformTile {
  return {
    max: Array.from({ length: 800 }, (_, index) => (index < 120 ? 16 : 96)),
    min: Array.from({ length: 800 }, (_, index) => (index < 120 ? -16 : -96)),
    points_per_second: 80,
    start_px: 0,
    width_px: 800,
  };
}

function createBrightTextureTile(): TrackWaveformTile {
  return {
    max: Array.from({ length: 800 }, (_, index) => (index % 2 === 0 ? 96 : 18)),
    min: Array.from({ length: 800 }, (_, index) => (index % 2 === 0 ? -96 : -18)),
    points_per_second: 80,
    start_px: 0,
    width_px: 800,
  };
}

describe("audio visualization reactivity", () => {
  test("keeps local waveform cache keys out of trace payloads", () => {
    const source = readFileSync(resolve(currentDir, "reactivity.ts"), "utf8");
    const traceSections = source
      .split("recordAudioVisualizationReactivityTrace(")
      .slice(1)
      .join("\n");

    assert.equal(traceSections.includes("cacheKey:"), false);
  });

  test("projects local waveform peak into instant energy", () => {
    const summary = createSummary();

    assert.equal(
      resolveAudioVisualizationInstantEnergyFromTile({
        filePath: "C:/music/demo.m4a",
        seconds: 1,
        summary,
        tile: createTile(96),
      }),
      96 / 127,
    );
    assert.equal(
      resolveAudioVisualizationInstantEnergyFromTile({
        filePath: "C:/music/demo.m4a",
        seconds: 1,
        summary,
        tile: createTile(12),
      }),
      12 / 127,
    );
  });

  test("projects local waveform texture into bright transients", () => {
    const summary = createSummary();

    assert.equal(
      (resolveAudioVisualizationBrightTransientFromTile({
        filePath: "C:/music/demo.m4a",
        seconds: 1,
        summary,
        tile: createBrightTextureTile(),
      }) ?? 0) >
        (resolveAudioVisualizationBrightTransientFromTile({
          filePath: "C:/music/demo.m4a",
          seconds: 1,
          summary,
          tile: createTile(64),
        }) ?? 0),
      true,
    );
  });

  test("resolves a reactive frame from the waveform port", async () => {
    resetAudioVisualizationReactivityCacheForTest();
    const frame = normalizeAudioVisualizationFrame(
      {
        canonical_music_id: "track:1",
        current_position_ms: 1_000,
        dynamics: 0.4,
        file_path: "C:/music/demo.m4a",
        loudness_energy: 0.6,
        music_name: "Demo",
        music_url: "https://example.com/demo",
        paused: false,
        playing: true,
        playlist_name: "List",
        presence: 0.5,
        range_end_ms: 2_000,
        range_progress: null,
        range_start_ms: 0,
        session_generation: 1,
      },
      100,
    );

    const reactiveFrame = await resolveAudioVisualizationReactiveFrame(frame, {
      getTrackWaveformTile: async () => createTile(64),
      prepareTrackWaveform: async () => createSummary(),
    });

    assert.equal(reactiveFrame.instant_energy, 64 / 127);
    assert.equal(reactiveFrame.bright_transient, 0);
  });

  test("advances live audio reactivity from a playback clock anchor", async () => {
    resetAudioVisualizationReactivityCacheForTest();
    const frame = normalizeAudioVisualizationFrame(
      {
        canonical_music_id: "track:1",
        current_position_ms: 1_000,
        dynamics: 0.4,
        file_path: "C:/music/demo.m4a",
        loudness_energy: 0.6,
        music_name: "Demo",
        music_url: "https://example.com/demo",
        paused: false,
        playing: true,
        playlist_name: "List",
        presence: 0.5,
        range_end_ms: 3_000,
        range_progress: null,
        range_start_ms: 0,
        session_generation: 1,
      },
      100,
    );
    const port = {
      getTrackWaveformTile: async () => createSteppedTile(),
      prepareTrackWaveform: async () => createSummary(),
    };

    await resolveAudioVisualizationReactiveFrame(frame, port);
    const liveFrame = resolveAudioVisualizationLiveFrame(frame, 700, port);

    assert.equal(liveFrame.current_position_ms, 1_600);
    assert.equal(liveFrame.range_progress, 1_600 / 3_000);
    assert.equal(liveFrame.instant_energy, 96 / 127);
    assert.equal(liveFrame.bright_transient, 0);
  });

  test("does not prepare waveform reactivity for stopped or paused frames", async () => {
    resetAudioVisualizationReactivityCacheForTest();
    let prepareCount = 0;
    const port = {
      getTrackWaveformTile: async () => createTile(64),
      prepareTrackWaveform: async () => {
        prepareCount += 1;
        return createSummary();
      },
    };
    const stoppedFrame = normalizeAudioVisualizationFrame(
      {
        canonical_music_id: "track:1",
        current_position_ms: 1_000,
        dynamics: 0.4,
        file_path: "C:/music/demo.m4a",
        loudness_energy: 0.6,
        music_name: "Demo",
        music_url: "https://example.com/demo",
        paused: false,
        playing: false,
        playlist_name: "List",
        presence: 0.5,
        range_end_ms: 3_000,
        range_progress: null,
        range_start_ms: 0,
        session_generation: 1,
      },
      100,
    );
    const pausedFrame = {
      ...stoppedFrame,
      paused: true,
      playing: true,
    };

    const stoppedReactiveFrame = await resolveAudioVisualizationReactiveFrame(stoppedFrame, port);
    const pausedReactiveFrame = await resolveAudioVisualizationReactiveFrame(pausedFrame, port);

    assert.equal(prepareCount, 0);
    assert.equal(stoppedReactiveFrame.instant_energy, null);
    assert.equal(stoppedReactiveFrame.bright_transient, null);
    assert.equal(pausedReactiveFrame.instant_energy, null);
    assert.equal(pausedReactiveFrame.bright_transient, null);
  });

  test("does not synthesize reactive values before waveform cache is ready", () => {
    resetAudioVisualizationReactivityCacheForTest();
    const frame = normalizeAudioVisualizationFrame(
      {
        canonical_music_id: "track:1",
        current_position_ms: 1_000,
        dynamics: 0.4,
        file_path: "C:/music/demo.m4a",
        loudness_energy: 0.6,
        music_name: "Demo",
        music_url: "https://example.com/demo",
        paused: false,
        playing: true,
        playlist_name: "List",
        presence: 0.5,
        range_end_ms: 3_000,
        range_progress: null,
        range_start_ms: 0,
        session_generation: 1,
      },
      100,
    );
    const port = {
      getTrackWaveformTile: async () => createSteppedTile(),
      prepareTrackWaveform: async () => createSummary(),
    };

    const liveFrame = resolveAudioVisualizationLiveFrame(frame, 700, port);

    assert.equal(liveFrame.instant_energy, null);
    assert.equal(liveFrame.bright_transient, null);
  });
});
