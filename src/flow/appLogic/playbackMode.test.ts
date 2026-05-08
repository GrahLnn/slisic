import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveSpectrumBackResumeEffects,
  resolveSpectrumEnterPlaybackModeEffects,
  resolveSpectrumExitPlaybackModeEffects,
  shouldCommitSpectrumPlaybackScopeExit,
  shouldResumePlaybackPageTrackAfterSpectrumBack,
} from "./playbackMode";

describe("appLogic playback mode", () => {
  test("opens a dedicated backend spectrum scope when entering spectrum", () => {
    assert.deepEqual(resolveSpectrumEnterPlaybackModeEffects(), [
      {
        kind: "enterSpectrumPlaybackScope",
      },
    ]);
  });

  test("closes the dedicated backend spectrum scope on every spectrum exit", () => {
    assert.deepEqual(resolveSpectrumExitPlaybackModeEffects(42), [
      {
        kind: "exitSpectrumPlaybackScope",
        scopeId: 42,
      },
    ]);
  });

  test("keeps scope exit separate from back-only playback resume", () => {
    assert.deepEqual(
      [
        ...resolveSpectrumExitPlaybackModeEffects(42),
        ...resolveSpectrumBackResumeEffects({
          currentPlaybackPath: "C:/Music/Track.flac",
          spectrumTrackPath: "c:/music/track.flac",
          paused: true,
        }),
      ],
      [
        {
          kind: "exitSpectrumPlaybackScope",
          scopeId: 42,
        },
        {
          kind: "resumePlayback",
        },
      ],
    );
  });

  test("commits spectrum scope exit only for the same active scope", () => {
    assert.equal(
      shouldCommitSpectrumPlaybackScopeExit({
        currentScopeId: 42,
        requestedScopeId: 42,
      }),
      true,
    );
    assert.equal(
      shouldCommitSpectrumPlaybackScopeExit({
        currentScopeId: 43,
        requestedScopeId: 42,
      }),
      false,
    );
    assert.equal(
      shouldCommitSpectrumPlaybackScopeExit({
        currentScopeId: null,
        requestedScopeId: 42,
      }),
      false,
    );
  });

  test("resumes only the paused current playback page track after spectrum back", () => {
    assert.equal(
      shouldResumePlaybackPageTrackAfterSpectrumBack({
        currentPlaybackPath: "C:/Music/Track.flac",
        spectrumTrackPath: "c:/music/track.flac",
        paused: true,
      }),
      true,
    );
    assert.equal(
      shouldResumePlaybackPageTrackAfterSpectrumBack({
        currentPlaybackPath: "C:/Music/Other.flac",
        spectrumTrackPath: "C:/Music/Track.flac",
        paused: true,
      }),
      false,
    );
    assert.equal(
      shouldResumePlaybackPageTrackAfterSpectrumBack({
        currentPlaybackPath: "C:/Music/Track.flac",
        spectrumTrackPath: "C:/Music/Track.flac",
        paused: false,
      }),
      false,
    );
  });
});
