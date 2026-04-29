import {
  hasSpectrumMusicTitleChanges,
  resolveSpectrumMusicTitleCommit,
} from "@/src/flow/appLogic/musicTitle";
import type { SpectrumMusicTitleDraft } from "@/src/flow/appLogic/core";

export type SpectrumBackActionVisualKind = "back" | "check";

export interface SpectrumBackActionVisualState {
  kind: SpectrumBackActionVisualKind;
  key: string;
}

export function resolveSpectrumTitle(args: {
  musicTitleDraft: SpectrumMusicTitleDraft | null;
  nowPlayingTrackName: string | null;
  playingPlaylistName: string | null;
}) {
  if (args.musicTitleDraft) {
    return args.musicTitleDraft.name;
  }

  const trackName = args.nowPlayingTrackName?.trim();
  if (trackName) {
    return trackName;
  }

  return args.playingPlaylistName ?? "Spectrum";
}

export function resolveSpectrumBackActionVisualState(args: {
  musicTitleDraft: SpectrumMusicTitleDraft | null;
}): SpectrumBackActionVisualState {
  const kind = hasSpectrumMusicTitleChanges(args.musicTitleDraft) ? "check" : "back";

  return {
    kind,
    key: kind,
  };
}

export function resolveSpectrumCommittedTitle(args: {
  musicTitleDraft: SpectrumMusicTitleDraft | null;
  renderedTitle: string;
}) {
  return (
    resolveSpectrumMusicTitleCommit(args.musicTitleDraft) ?? {
      kind: "keep" as const,
      name: args.renderedTitle,
    }
  );
}
