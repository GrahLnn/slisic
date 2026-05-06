import {
  findSpectrumMusicDraft,
  createSpectrumMusicDraftIdentity,
  hasSpectrumMusicDraftChanges,
  resolveSpectrumMusicCommit,
} from "@/src/flow/appLogic/musicTitle";
import type { SpectrumMusicDraft } from "@/src/flow/appLogic/core";

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

export interface SpectrumMusicEditorViewModel {
  handoffTone: "solid" | "muted" | null;
  id: string;
  interactionDisabled: boolean;
  isCurrent: boolean;
  selectionEnd: number | null;
  selectionStart: number | null;
  shouldShowResetAction: boolean;
  titleLayoutId?: string;
  titleValue: string;
}

export function findSpectrumMusicDraftById(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
): SpectrumMusicDraft | null {
  return findSpectrumMusicDraft(drafts, id);
}

export function shouldShowSpectrumDraftResetAction(args: {
  musicDraft: SpectrumMusicDraft | null;
}) {
  return hasSpectrumMusicDraftChanges(args.musicDraft);
}

export function resolveSpectrumMusicDisplayName(args: {
  musicDraft: SpectrumMusicDraft | null;
  nowPlayingTrackName: string | null;
  playingPlaylistName: string | null;
}) {
  if (args.musicDraft) {
    return args.musicDraft.name;
  }

  const trackName = args.nowPlayingTrackName?.trim();
  if (trackName) {
    return trackName;
  }

  return args.playingPlaylistName ?? "Spectrum";
}

export function resolveSpectrumSelectionRange(args: {
  musicDraft: SpectrumMusicDraft | null;
  nowPlayingTrackEndMs: number | null;
  nowPlayingTrackStartMs: number | null;
}) {
  if (args.musicDraft) {
    return {
      end: millisecondsToSeconds(args.musicDraft.endMs),
      start: millisecondsToSeconds(args.musicDraft.startMs),
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
  musicDrafts: readonly SpectrumMusicDraft[];
}): SpectrumBackActionVisualState {
  const kind = args.musicDrafts.some((draft) => hasSpectrumMusicDraftChanges(draft))
    ? "check"
    : "back";

  return {
    kind,
    key: kind,
  };
}

export function resolveSpectrumCommittedMusicName(args: {
  musicDraft: SpectrumMusicDraft | null;
  renderedName: string;
}) {
  return (
    resolveSpectrumMusicCommit(args.musicDraft) ?? {
      kind: "keep" as const,
      alias: args.renderedName,
    }
  );
}

export function resolveSpectrumMusicEditorViewModels(args: {
  activeLayoutId: string | null;
  handoffTone: "solid" | "muted" | null;
  interactionDisabled: boolean;
  nowPlayingTrackEndMs: number | null;
  nowPlayingTrackStartMs: number | null;
  nowPlayingTrackUrl: string | null;
  playingPlaylistName: string | null;
  spectrumMusicDrafts: readonly SpectrumMusicDraft[];
}) {
  return args.spectrumMusicDrafts.map((draft, index) => {
    const selection = resolveSpectrumSelectionRange({
      musicDraft: draft,
      nowPlayingTrackEndMs: args.nowPlayingTrackEndMs,
      nowPlayingTrackStartMs: args.nowPlayingTrackStartMs,
    });
    const id = createSpectrumMusicDraftIdentity({
      baselineEndMs: draft.baselineEndMs,
      baselineStartMs: draft.baselineStartMs,
      url: draft.url,
    });
    const isCurrent =
      draft.url === args.nowPlayingTrackUrl &&
      draft.baselineStartMs === args.nowPlayingTrackStartMs &&
      draft.baselineEndMs === args.nowPlayingTrackEndMs;

    return {
      handoffTone: index === 0 ? args.handoffTone : null,
      id,
      interactionDisabled: args.interactionDisabled,
      isCurrent,
      selectionEnd: selection.end,
      selectionStart: selection.start,
      shouldShowResetAction: shouldShowSpectrumDraftResetAction({
        musicDraft: draft,
      }),
      titleLayoutId: index === 0 ? (args.activeLayoutId ?? undefined) : undefined,
      titleValue: resolveSpectrumMusicDisplayName({
        musicDraft: draft,
        nowPlayingTrackName: null,
        playingPlaylistName: args.playingPlaylistName,
      }),
    } satisfies SpectrumMusicEditorViewModel;
  });
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
