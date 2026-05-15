import {
  findSpectrumMusicDraft,
  createSpectrumNewMusicDraftIdentity,
  createSpectrumMusicDraftRuntimeIdentity,
  hasSpectrumMusicDraftChanges,
  hasSpectrumMusicDraftCommitOperations,
  resolveSpectrumMusicCommit,
  type SpectrumMusicCommitResolution,
} from "@/src/flow/appLogic/musicTitle";
import type { SpectrumMusicDraft } from "@/src/flow/appLogic/core";
import { normalizeMediaPathKey } from "@/src/mediaPath";

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

export interface RawSpectrumPlaybackIdentity {
  filePath: string | null;
  playlistName: string | null;
  startMs: number | null;
  endMs: number | null;
  url: string | null;
}

export interface SpectrumPlaybackIdentity {
  filePath: string;
  key: string;
  normalizedFilePath: string;
  playlistName: string;
  startMs: number;
  endMs: number;
  url: string;
}

export interface SpectrumPlaybackActionSnapshot {
  identity: SpectrumPlaybackIdentity;
  paused: boolean;
}

export interface SpectrumMusicEditorViewModel {
  handoffTone: "solid" | "muted" | null;
  id: string;
  interactionDisabled: boolean;
  isCurrent: boolean;
  isNewTitle: boolean;
  showWaveform: boolean;
  playbackIdentity: SpectrumPlaybackIdentity | null;
  selectionEnd: number | null;
  selectionStart: number | null;
  shouldShowResetAction: boolean;
  titleLayoutId?: string;
  titleValue: string;
}

export interface SpectrumBackTitleCommitTarget {
  editor: SpectrumMusicEditorViewModel;
  title: SpectrumMusicCommitResolution;
}

type SpectrumMusicEditorEntry =
  | {
      kind: "draft";
      draft: SpectrumMusicDraft;
    }
  | {
      kind: "new-title";
      id: string;
    };

export function findSpectrumMusicDraftById(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
): SpectrumMusicDraft | null {
  return findSpectrumMusicDraft(drafts, id);
}

export function shouldShowSpectrumDraftResetAction(args: {
  musicDraft: SpectrumMusicDraft | null;
}) {
  return (
    args.musicDraft?.kind === "persisted" &&
    args.musicDraft.deleteRequested !== true &&
    hasSpectrumMusicDraftChanges(args.musicDraft)
  );
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

export function resolveSpectrumMusicDraftsForView(args: {
  spectrumMusicDrafts: readonly SpectrumMusicDraft[];
  sourceUrl: string | null;
}) {
  const entries: SpectrumMusicEditorEntry[] = args.spectrumMusicDrafts
    .filter((draft) => draft.deleteRequested !== true)
    .map((draft) => ({
      kind: "draft" as const,
      draft,
    }));

  const hasPendingCreate =
    args.sourceUrl !== null &&
    args.spectrumMusicDrafts.some(
      (draft) => draft.kind === "pending-create" && draft.sourceUrl === args.sourceUrl,
    );

  if (args.sourceUrl !== null && !hasPendingCreate) {
    entries.push({
      kind: "new-title",
      id: createSpectrumNewMusicDraftIdentity({ sourceUrl: args.sourceUrl }),
    });
  }

  return entries;
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
  const kind = hasSpectrumMusicDraftCommitOperations(args.musicDrafts) ? "check" : "back";

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

export function resolveSpectrumBackTitleCommitTargets(args: {
  editorViewModels: readonly SpectrumMusicEditorViewModel[];
  musicDrafts: readonly SpectrumMusicDraft[];
}): SpectrumBackTitleCommitTarget[] {
  return args.editorViewModels.flatMap((editor) => {
    const draft = findSpectrumMusicDraftById(args.musicDrafts, editor.id);
    if (!draft || draft.deleteRequested === true) {
      return [];
    }

    if (draft.kind === "pending-create" && draft.name.trim().length === 0) {
      return [];
    }

    const title = resolveSpectrumCommittedMusicName({
      musicDraft: draft,
      renderedName: editor.titleValue,
    });

    if (title.kind === "keep" && title.alias === editor.titleValue) {
      return [];
    }

    return [{ editor, title }];
  });
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
  return resolveSpectrumMusicDraftsForView({
    sourceUrl: args.nowPlayingTrackUrl,
    spectrumMusicDrafts: args.spectrumMusicDrafts,
  }).map((entry, index) => {
    if (entry.kind === "new-title") {
      return {
        handoffTone: null,
        id: entry.id,
        interactionDisabled: args.interactionDisabled,
        isCurrent: false,
        isNewTitle: true,
        showWaveform: false,
        playbackIdentity: null,
        selectionEnd: null,
        selectionStart: null,
        shouldShowResetAction: false,
        titleLayoutId: undefined,
        titleValue: "",
      } satisfies SpectrumMusicEditorViewModel;
    }

    const draft = entry.draft;
    const selection = resolveSpectrumSelectionRange({
      musicDraft: draft,
      nowPlayingTrackEndMs: args.nowPlayingTrackEndMs,
      nowPlayingTrackStartMs: args.nowPlayingTrackStartMs,
    });
    const id = createSpectrumMusicDraftRuntimeIdentity(draft);
    const isCurrent =
      draft.kind !== "pending-create" &&
      draft.url === args.nowPlayingTrackUrl &&
      draft.baselineStartMs === args.nowPlayingTrackStartMs &&
      draft.baselineEndMs === args.nowPlayingTrackEndMs;
    const playbackIdentity = projectSpectrumPlaybackIdentity({
      endMs: draft.kind === "pending-create" ? draft.endMs : draft.baselineEndMs,
      filePath: args.nowPlayingTrackFilePath,
      playlistName: args.playingPlaylistName,
      startMs: draft.kind === "pending-create" ? draft.startMs : draft.baselineStartMs,
      url: draft.url,
    });
    const isNewTitle = false;
    const showWaveform = true;

    return {
      handoffTone: index === 0 ? args.handoffTone : null,
      id,
      interactionDisabled: args.interactionDisabled,
      isCurrent,
      isNewTitle,
      showWaveform,
      playbackIdentity,
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
      kind === "play"
        ? args.hasCurrentTrack
          ? "Resume playback"
          : "Start playback"
        : "Pause playback",
    disabled: !args.isPresent || (!args.hasCurrentTrack && !args.canStartTrack) || args.isPending,
    dimmed: (!args.hasCurrentTrack && !args.canStartTrack) || args.isPending,
    key: kind,
    kind,
  };
}

export function projectSpectrumPlaybackIdentity(
  raw: RawSpectrumPlaybackIdentity,
): SpectrumPlaybackIdentity | null {
  if (
    !raw.filePath ||
    !raw.playlistName ||
    !raw.url ||
    raw.startMs === null ||
    raw.endMs === null ||
    !Number.isFinite(raw.startMs) ||
    !Number.isFinite(raw.endMs) ||
    raw.startMs >= raw.endMs
  ) {
    return null;
  }

  const normalizedFilePath = normalizeMediaPathKey(raw.filePath);
  const key = [normalizedFilePath, raw.playlistName, raw.url, raw.startMs, raw.endMs].join("|");

  return {
    endMs: raw.endMs,
    filePath: raw.filePath,
    key,
    normalizedFilePath,
    playlistName: raw.playlistName,
    startMs: raw.startMs,
    url: raw.url,
  };
}

export function areSpectrumPlaybackIdentitiesEqual(
  left: SpectrumPlaybackIdentity,
  right: SpectrumPlaybackIdentity,
) {
  return (
    left.normalizedFilePath === right.normalizedFilePath &&
    left.playlistName === right.playlistName &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.url === right.url
  );
}

export function isSpectrumPlaybackStatusIdentityForAction(
  status: SpectrumPlaybackIdentity | null,
  identity: SpectrumPlaybackIdentity,
) {
  return status !== null && areSpectrumPlaybackIdentitiesEqual(status, identity);
}

export function resolveSpectrumPlaybackActionSnapshot(
  raw: RawSpectrumPlaybackIdentity & {
    paused?: boolean | null;
  },
): SpectrumPlaybackActionSnapshot | null {
  const identity = projectSpectrumPlaybackIdentity(raw);

  return identity === null
    ? null
    : {
        identity,
        paused: raw.paused === true,
      };
}

export function areSpectrumPlaybackActionSnapshotsEqual(
  left: SpectrumPlaybackActionSnapshot | null,
  right: SpectrumPlaybackActionSnapshot | null,
) {
  if (left === null || right === null) {
    return left === right;
  }

  return (
    left.paused === right.paused &&
    areSpectrumPlaybackIdentitiesEqual(left.identity, right.identity)
  );
}

export function shouldCommitSpectrumPlaybackActionSnapshot(args: {
  isPresent: boolean;
  pageExitStarted: boolean;
  pageRenderFrozen: boolean;
}) {
  return args.isPresent && !args.pageRenderFrozen && !args.pageExitStarted;
}
