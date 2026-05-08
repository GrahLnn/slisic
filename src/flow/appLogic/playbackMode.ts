import { normalizeMediaPathKey } from "@/src/mediaPath";
import type { PlaybackContinuationMode } from "@/src/cmd";

export type PlaybackModeEffect =
  | {
      kind: "enterSpectrumPlaybackScope";
    }
  | {
      kind: "exitSpectrumPlaybackScope";
      scopeId: number | null;
    }
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
      kind: "enterSpectrumPlaybackScope",
    },
  ];
}

export function resolveSpectrumExitPlaybackModeEffects(
  scopeId: number | null,
): PlaybackModeEffect[] {
  return [
    {
      kind: "exitSpectrumPlaybackScope",
      scopeId,
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

export function shouldCommitSpectrumPlaybackScopeExit(args: {
  currentScopeId: number | null;
  requestedScopeId: number | null;
}) {
  return args.currentScopeId === args.requestedScopeId;
}
