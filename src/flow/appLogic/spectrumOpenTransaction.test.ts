import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PlaybackModeEffect } from "./playbackMode";
import {
  isSpectrumOpenSourceStillCurrent,
  runSpectrumOpenTransaction,
  type SpectrumOpenSourceIdentity,
} from "./spectrumOpenTransaction";

function createProjection(
  overrides: Partial<SpectrumOpenSourceIdentity> = {},
): SpectrumOpenSourceIdentity {
  return {
    state: "play",
    playingPlaylistName: "Focus",
    nowPlayingTrackUrl: "https://example.com/focus#a",
    nowPlayingTrackFilePath: "focus/a.m4a",
    nowPlayingTrackStartMs: 0,
    nowPlayingTrackEndMs: 120_000,
    ...overrides,
  };
}

describe("spectrum open transaction", () => {
  test("commits the spectrum open signal after entering a dedicated playback scope", async () => {
    const source = createProjection();
    const events: string[] = [];

    const result = await runSpectrumOpenTransaction({
      source,
      runtime: {
        applyPlaybackModeEffect: async (effect) => {
          events.push(`effect:${effect.kind}`);
        },
        enterSpectrumPlaybackScope: async () => {
          events.push("enterScope");
          return 42;
        },
        getCurrentProjection: () => source,
      },
      sink: {
        openSpectrum: () => events.push("openSpectrum"),
        scopeChanged: (scopeId) => events.push(`scopeChanged:${scopeId}`),
      },
      trace: {
        committed: ({ openedScopeId }) => events.push(`committed:${openedScopeId}`),
      },
    });

    assert.deepEqual(result, {
      kind: "Committed",
      openedScopeId: 42,
    });
    assert.deepEqual(events, ["enterScope", "scopeChanged:42", "openSpectrum", "committed:42"]);
  });

  test("rejects stale source evidence and cleans up the opened scope", async () => {
    const source = createProjection();
    const staleCurrent = createProjection({
      nowPlayingTrackUrl: "https://example.com/focus#b",
      nowPlayingTrackFilePath: "focus/b.m4a",
    });
    const cleanupEffects: PlaybackModeEffect[] = [];
    const events: string[] = [];
    let current = source;

    const result = await runSpectrumOpenTransaction({
      source,
      runtime: {
        applyPlaybackModeEffect: async (effect) => {
          cleanupEffects.push(effect);
          events.push(`effect:${effect.kind}`);
        },
        enterSpectrumPlaybackScope: async () => {
          events.push("enterScope");
          current = staleCurrent;
          return 42;
        },
        getCurrentProjection: () => current,
      },
      sink: {
        openSpectrum: () => events.push("openSpectrum"),
        scopeChanged: (scopeId) => events.push(`scopeChanged:${scopeId}`),
      },
      trace: {
        rejectedStaleSource: ({ openedScopeId }) => events.push(`rejected:${openedScopeId}`),
      },
    });

    assert.deepEqual(result, {
      kind: "Rejected",
      openedScopeId: 42,
      reason: "stale_source",
    });
    assert.deepEqual(events, [
      "enterScope",
      "scopeChanged:42",
      "rejected:42",
      "effect:exitSpectrumPlaybackScope",
    ]);
    assert.deepEqual(cleanupEffects, [
      {
        kind: "exitSpectrumPlaybackScope",
        scopeId: 42,
      },
    ]);
  });

  test("uses the full playback coordinate when accepting source identity", () => {
    const source = createProjection();

    assert.equal(isSpectrumOpenSourceStillCurrent(source, createProjection()), true);
    assert.equal(
      isSpectrumOpenSourceStillCurrent(
        source,
        createProjection({
          nowPlayingTrackStartMs: 1,
        }),
      ),
      false,
    );
    assert.equal(
      isSpectrumOpenSourceStillCurrent(source, createProjection({ state: "ready" })),
      false,
    );
  });
});
