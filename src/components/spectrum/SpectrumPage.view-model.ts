import {
  hasSpectrumMusicTitleChanges,
  resolveSpectrumMusicTitleCommit,
} from "@/src/flow/appLogic/musicTitle";
import type { SpectrumMusicTitleDraft } from "@/src/flow/appLogic/core";

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

export function shouldShowSpectrumDraftResetAction(args: {
  musicTitleDraft: SpectrumMusicTitleDraft | null;
}) {
  return hasSpectrumMusicTitleChanges(args.musicTitleDraft);
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

export function resolveSpectrumSelectionRange(args: {
  musicTitleDraft: SpectrumMusicTitleDraft | null;
  nowPlayingTrackEndMs: number | null;
  nowPlayingTrackStartMs: number | null;
}) {
  if (args.musicTitleDraft) {
    return {
      end: millisecondsToSeconds(args.musicTitleDraft.endMs),
      start: millisecondsToSeconds(args.musicTitleDraft.startMs),
    };
  }

  return {
    end: millisecondsToSeconds(args.nowPlayingTrackEndMs),
    start: millisecondsToSeconds(args.nowPlayingTrackStartMs),
  };
}

export function resolveSpectrumMusicRangeChange(args: {
  end: number | null;
  start: number | null;
}) {
  return {
    endMs: secondsToMilliseconds(args.end),
    startMs: secondsToMilliseconds(args.start),
  };
}

function millisecondsToSeconds(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value / 1_000 : null;
}

function secondsToMilliseconds(value: number | null) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value * 1_000))
    : null;
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
