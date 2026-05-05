import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveSpectrumBackResumeEffects,
  resolveSpectrumExitPlaybackModeEffects,
  shouldResumePlaybackPageTrackAfterSpectrumBack,
} from "./playbackMode";

describe("appLogic playback mode", () => {
  test("restores random mode for every spectrum exit", () => {
    assert.deepEqual(resolveSpectrumExitPlaybackModeEffects(), [
      {
        kind: "setRandomContinuationMode",
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
          kind: "setRandomContinuationMode",
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
