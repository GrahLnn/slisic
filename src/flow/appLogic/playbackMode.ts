import { normalizeMediaPathKey } from "@/src/mediaPath";

export type PlaybackModeEffect =
  | {
      kind: "setRandomContinuationMode";
    }
  | {
      kind: "resumePlayback";
    };

export function resolveSpectrumExitPlaybackModeEffects(): PlaybackModeEffect[] {
  return [
    {
      kind: "setRandomContinuationMode",
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
