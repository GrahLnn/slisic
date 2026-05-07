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

export interface SpectrumPlaybackStatusIdentity {
  filePath: string | null;
  playlistName: string | null;
  startMs: number | null;
  endMs: number | null;
  url: string | null;
}

export interface SpectrumPlaybackActionIdentity {
  filePath: string | null;
  playlistName: string | null;
  startMs: number | null;
  endMs: number | null;
  url: string | null;
}

export interface CompleteSpectrumPlaybackActionIdentity {
  filePath: string;
  playlistName: string;
  startMs: number;
  endMs: number;
  url: string;
}

export interface SpectrumMusicEditorViewModel {
  handoffTone: "solid" | "muted" | null;
  id: string;
  interactionDisabled: boolean;
  isCurrent: boolean;
  playbackEndMs: number | null;
  playbackFilePath: string | null;
  playbackPlaylistName: string | null;
  playbackStartMs: number | null;
  playbackUrl: string | null;
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
  nowPlayingTrackFilePath: string | null;
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
      playbackEndMs: draft.baselineEndMs,
      playbackFilePath: args.nowPlayingTrackFilePath,
      playbackPlaylistName: args.playingPlaylistName,
      playbackStartMs: draft.baselineStartMs,
      playbackUrl: draft.url,
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
  canStartTrack: boolean;
  hasCurrentTrack: boolean;
  isPending: boolean;
  isPresent: boolean;
  paused: boolean;
}): SpectrumPlaybackActionVisualState {
  const kind = args.hasCurrentTrack && !args.paused ? "pause" : "play";

  return {
    ariaLabel:
      kind === "play" ? (args.hasCurrentTrack ? "Resume playback" : "Start playback") : "Pause playback",
    disabled: !args.isPresent || (!args.hasCurrentTrack && !args.canStartTrack) || args.isPending,
    dimmed: (!args.hasCurrentTrack && !args.canStartTrack) || args.isPending,
    key: kind,
    kind,
  };
}

export function areSpectrumPlaybackActionIdentitiesEqual(
  left: SpectrumPlaybackActionIdentity,
  right: SpectrumPlaybackActionIdentity,
) {
  return (
    left.filePath === right.filePath &&
    left.playlistName === right.playlistName &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.url === right.url
  );
}

export function isSpectrumPlaybackStatusIdentityForAction(
  status: SpectrumPlaybackStatusIdentity | null,
  identity: SpectrumPlaybackActionIdentity,
) {
  return status !== null && areSpectrumPlaybackActionIdentitiesEqual(status, identity);
}

export function isSpectrumPlaybackActionIdentityComplete(
  identity: SpectrumPlaybackActionIdentity,
): identity is CompleteSpectrumPlaybackActionIdentity {
  return (
    !!identity.filePath &&
    !!identity.playlistName &&
    !!identity.url &&
    identity.startMs !== null &&
    identity.endMs !== null
  );
}
