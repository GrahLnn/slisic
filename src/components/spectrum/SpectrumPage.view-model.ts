import {
  hasSpectrumMusicTitleChanges,
  resolveSpectrumMusicTitleCommit,
} from "@/src/flow/appLogic/musicTitle";
import type { SpectrumMusicTitleDraft } from "@/src/flow/appLogic/core";
import { normalizeMediaPathKey } from "../mediaPath";

export type SpectrumBackActionVisualKind = "back" | "check";
export type SpectrumPlaybackActionKind = "pause" | "play";

export interface SpectrumBackActionVisualState {
  kind: SpectrumBackActionVisualKind;
  key: string;
}

export interface SpectrumPlaybackActionVisualState {
  ariaLabel: string;
  disabled: boolean;
  dimmed: boolean;
  key: string;
  kind: SpectrumPlaybackActionKind;
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
      alias: args.renderedTitle,
    }
  );
}

export function resolveSpectrumPlaybackActionVisualState(args: {
  hasCurrentTrack: boolean;
  isPending: boolean;
  isPresent: boolean;
  paused: boolean;
}): SpectrumPlaybackActionVisualState {
  const kind = args.paused ? "play" : "pause";

  return {
    ariaLabel: kind === "play" ? "Resume playback" : "Pause playback",
    disabled: !args.isPresent || !args.hasCurrentTrack || args.isPending,
    dimmed: !args.hasCurrentTrack || args.isPending,
    key: kind,
    kind,
  };
}

export function shouldResumeSpectrumPlaybackBeforeBack(args: {
  currentPlaybackPath: string | null;
  filePath: string | null;
  paused: boolean;
}) {
  const filePath = args.filePath?.trim();

  return (
    args.paused &&
    !!filePath &&
    args.currentPlaybackPath !== null &&
    normalizeMediaPathKey(args.currentPlaybackPath) === normalizeMediaPathKey(filePath)
  );
}
