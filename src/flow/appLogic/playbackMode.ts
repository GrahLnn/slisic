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

export function shouldCommitSpectrumPlaybackScopeExit(args: {
  currentScopeId: number | null;
  requestedScopeId: number | null;
}) {
  return args.currentScopeId === args.requestedScopeId;
}
