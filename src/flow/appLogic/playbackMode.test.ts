import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveSpectrumBackResumeEffects,
  resolveSpectrumEnterPlaybackModeEffects,
  resolveSpectrumExitPlaybackModeEffects,
  shouldResumePlaybackPageTrackAfterSpectrumBack,
} from "./playbackMode";

describe("appLogic playback mode", () => {
  test("sets repeat current mode when entering spectrum", () => {
    assert.deepEqual(resolveSpectrumEnterPlaybackModeEffects(), [
      {
        kind: "setPlaybackContinuationMode",
        mode: "repeatCurrent",
      },
    ]);
  });

  test("restores random mode for every spectrum exit", () => {
    assert.deepEqual(resolveSpectrumExitPlaybackModeEffects(), [
      {
        kind: "setPlaybackContinuationMode",
        mode: "random",
      },
    ]);
  });

  test("keeps random restoration separate from back-only playback resume", () => {
    assert.deepEqual(
      [
        ...resolveSpectrumExitPlaybackModeEffects(),
        ...resolveSpectrumBackResumeEffects({
          currentPlaybackPath: "C:/Music/Track.flac",
          spectrumTrackPath: "c:/music/track.flac",
          paused: true,
        }),
      ],
      [
        {
          kind: "setPlaybackContinuationMode",
          mode: "random",
        },
        {
          kind: "resumePlayback",
        },
      ],
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
