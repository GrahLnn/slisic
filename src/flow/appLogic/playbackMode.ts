import { normalizeMediaPathKey } from "@/src/mediaPath";
import type { PlaybackContinuationMode } from "@/src/cmd";

export type PlaybackModeEffect =
  | {
      kind: "setPlaybackContinuationMode";
      mode: PlaybackContinuationMode;
    }
  | {
      kind: "resumePlayback";
    };

export function resolveSpectrumEnterPlaybackModeEffects(): PlaybackModeEffect[] {
  return [
    {
      kind: "setPlaybackContinuationMode",
      mode: "repeatCurrent",
    },
  ];
}

export function resolveSpectrumExitPlaybackModeEffects(): PlaybackModeEffect[] {
  return [
    {
      kind: "setPlaybackContinuationMode",
      mode: "random",
    },
  ];
}

export function shouldResumePlaybackPageTrackAfterSpectrumBack(args: {
  currentPlaybackPath: string | null;
  paused: boolean;
  spectrumTrackPath: string | null;
}) {
  const spectrumTrackPath = args.spectrumTrackPath?.trim();

  return (
    args.paused &&
    !!spectrumTrackPath &&
    args.currentPlaybackPath !== null &&
    normalizeMediaPathKey(args.currentPlaybackPath) === normalizeMediaPathKey(spectrumTrackPath)
  );
}

export function resolveSpectrumBackResumeEffects(args: {
  currentPlaybackPath: string | null;
  paused: boolean;
  spectrumTrackPath: string | null;
}): PlaybackModeEffect[] {
  return shouldResumePlaybackPageTrackAfterSpectrumBack(args)
    ? [
        {
          kind: "resumePlayback",
        },
      ]
    : [];
}
