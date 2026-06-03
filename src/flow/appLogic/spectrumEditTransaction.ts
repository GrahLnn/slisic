import type { Collection } from "@/src/cmd";
import type { SpectrumMusicDraft } from "./core";
import {
  createMusicDraftCreates,
  createMusicDraftDeletes,
  createMusicDraftEdits,
  createMusicInCollections,
  deleteMusicFromCollections,
  hasSpectrumMusicDraftCommitOperations,
  updateMusicInCollections,
  type MusicCreate,
  type MusicDelete,
  type MusicEdit,
} from "./musicTitle";

export interface SpectrumEditNowPlayingInput {
  name: string | null;
  url: string | null;
  filePath: string | null;
  startMs: number | null;
  endMs: number | null;
  liked: boolean | null;
}

export interface SpectrumEditNowPlayingProjection extends SpectrumEditNowPlayingInput {}

export interface SpectrumEditProjectionInput {
  collections: readonly Collection[];
  nowPlaying: SpectrumEditNowPlayingInput;
}

export interface SpectrumEditProjectionEvidence {
  musicCreates?: readonly MusicCreate[];
  musicDeletes?: readonly MusicDelete[];
  musicEdits?: readonly MusicEdit[];
}

export interface SpectrumEditProjectionResult {
  collections: Collection[];
  nowPlaying: SpectrumEditNowPlayingProjection;
}

export type SpectrumEditCommitPhase = "create" | "delete" | "update";

export interface SpectrumEditCommitFrame {
  acceptedEvidence: Partial<Record<SpectrumEditCommitPhase, SpectrumEditProjectionEvidence>>;
  baseline: SpectrumEditProjectionInput;
  epoch: number;
  optimisticEvidence: Required<SpectrumEditProjectionEvidence>;
  pendingPhases: SpectrumEditCommitPhase[];
}

export type SpectrumEditCommitStopsReason = "stale-epoch" | "closed-frame" | "unexpected-phase";

export type SpectrumEditCommitRejectReason = "unexpected-evidence";

export type SpectrumEditCommitNegativePhase = SpectrumEditCommitPhase | "unexpected";

export type SpectrumEditCommitNegativeEvidence =
  | {
      epoch: number;
      kind: "Reject";
      phase: SpectrumEditCommitNegativePhase;
      reason: SpectrumEditCommitRejectReason;
    }
  | {
      epoch: number;
      kind: "Stops";
      phase: SpectrumEditCommitNegativePhase;
      reason: SpectrumEditCommitStopsReason;
    };

export type SpectrumEditCommitReflection =
  | {
      frame: SpectrumEditCommitFrame | null;
      kind: "accepted";
      projection: SpectrumEditProjectionResult;
    }
  | {
      epoch: number;
      kind: "Stops";
      phase: SpectrumEditCommitPhase;
      reason: SpectrumEditCommitStopsReason;
    }
  | {
      epoch: number;
      frame: SpectrumEditCommitFrame;
      kind: "Reject";
      phase: SpectrumEditCommitPhase;
      reason: SpectrumEditCommitRejectReason;
    };

function findCurrentMusicEdit(
  nowPlaying: SpectrumEditNowPlayingInput,
  edits: readonly MusicEdit[],
) {
  return (
    edits.find(
      (edit) =>
        edit.url === nowPlaying.url &&
        edit.targetStartMs === nowPlaying.startMs &&
        edit.targetEndMs === nowPlaying.endMs,
    ) ?? null
  );
}

function findCurrentMusicDelete(
  nowPlaying: SpectrumEditNowPlayingInput,
  deletions: readonly MusicDelete[],
) {
  return (
    deletions.find(
      (deletion) =>
        deletion.url === nowPlaying.url &&
        deletion.startMs === nowPlaying.startMs &&
        deletion.endMs === nowPlaying.endMs,
    ) ?? null
  );
}

function applyMusicEdits(collections: readonly Collection[], edits: readonly MusicEdit[]) {
  return edits.reduce(
    (currentCollections, edit) => updateMusicInCollections(currentCollections, edit),
    [...collections],
  );
}

function applyMusicCreates(collections: readonly Collection[], creates: readonly MusicCreate[]) {
  return creates.reduce(
    (currentCollections, create) => createMusicInCollections(currentCollections, create),
    [...collections],
  );
}

function applyMusicDeletes(collections: readonly Collection[], deletions: readonly MusicDelete[]) {
  return deletions.reduce(
    (currentCollections, deletion) => deleteMusicFromCollections(currentCollections, deletion),
    [...collections],
  );
}

export function createSpectrumEditDraftEvidence(
  drafts: readonly SpectrumMusicDraft[],
): Required<SpectrumEditProjectionEvidence> {
  return {
    musicCreates: createMusicDraftCreates(drafts),
    musicDeletes: createMusicDraftDeletes(drafts),
    musicEdits: createMusicDraftEdits(drafts),
  };
}

function normalizeSpectrumEditProjectionEvidence(
  evidence: SpectrumEditProjectionEvidence,
): Required<SpectrumEditProjectionEvidence> {
  return {
    musicCreates: [...(evidence.musicCreates ?? [])],
    musicDeletes: [...(evidence.musicDeletes ?? [])],
    musicEdits: [...(evidence.musicEdits ?? [])],
  };
}

function createPendingSpectrumEditCommitPhases(
  evidence: Required<SpectrumEditProjectionEvidence>,
): SpectrumEditCommitPhase[] {
  return [
    ...(evidence.musicEdits.length > 0 ? (["update"] as const) : []),
    ...(evidence.musicCreates.length > 0 ? (["create"] as const) : []),
    ...(evidence.musicDeletes.length > 0 ? (["delete"] as const) : []),
  ];
}

export function createSpectrumEditCommitFrame(args: {
  baseline: SpectrumEditProjectionInput;
  epoch: number;
  optimisticEvidence: SpectrumEditProjectionEvidence;
}): SpectrumEditCommitFrame {
  const optimisticEvidence = normalizeSpectrumEditProjectionEvidence(args.optimisticEvidence);

  return {
    acceptedEvidence: {},
    baseline: {
      collections: [...args.baseline.collections],
      nowPlaying: { ...args.baseline.nowPlaying },
    },
    epoch: args.epoch,
    optimisticEvidence,
    pendingPhases: createPendingSpectrumEditCommitPhases(optimisticEvidence),
  };
}

export function createSpectrumEditUpdateEvidence(result: {
  results: readonly {
    input: MusicEdit;
    music: {
      alias: string;
      end_ms: number;
      start_ms: number;
    };
  }[];
}): SpectrumEditProjectionEvidence {
  return {
    musicEdits: result.results.map((update) => ({
      alias: update.music.alias,
      endMs: update.music.end_ms,
      startMs: update.music.start_ms,
      targetEndMs: update.input.targetEndMs,
      targetStartMs: update.input.targetStartMs,
      url: update.input.url,
    })),
  };
}

export function createSpectrumEditCreateEvidence(result: {
  results: readonly {
    input: {
      sourceCollectionUrl: string;
    };
    music: MusicCreate["music"];
  }[];
}): SpectrumEditProjectionEvidence {
  return {
    musicCreates: result.results.map((create) => ({
      sourceCollectionUrl: create.input.sourceCollectionUrl,
      music: create.music,
    })),
  };
}

export function createSpectrumEditDeleteEvidence(result: {
  results: readonly {
    endMs: number;
    startMs: number;
    url: string;
  }[];
}): SpectrumEditProjectionEvidence {
  return {
    musicDeletes: result.results.map((deletion) => ({
      endMs: deletion.endMs,
      startMs: deletion.startMs,
      url: deletion.url,
    })),
  };
}

export function hasSpectrumEditDraftCommitOperations(drafts: readonly SpectrumMusicDraft[]) {
  return hasSpectrumMusicDraftCommitOperations(drafts);
}

export function projectSpectrumEditTransaction(
  input: SpectrumEditProjectionInput,
  evidence: SpectrumEditProjectionEvidence = {},
): SpectrumEditProjectionResult {
  const musicCreates = evidence.musicCreates ?? [];
  const musicDeletes = evidence.musicDeletes ?? [];
  const musicEdits = evidence.musicEdits ?? [];
  const currentMusicEdit = findCurrentMusicEdit(input.nowPlaying, musicEdits);
  const currentMusicDelete = findCurrentMusicDelete(input.nowPlaying, musicDeletes);
  const collectionsAfterEdits = applyMusicEdits(input.collections, musicEdits);
  const collectionsAfterCreates = applyMusicCreates(collectionsAfterEdits, musicCreates);
  const collections = applyMusicDeletes(collectionsAfterCreates, musicDeletes);

  return {
    collections,
    nowPlaying: {
      name: currentMusicDelete !== null ? null : (currentMusicEdit?.alias ?? input.nowPlaying.name),
      url: currentMusicDelete !== null ? null : input.nowPlaying.url,
      filePath: currentMusicDelete !== null ? null : input.nowPlaying.filePath,
      startMs:
        currentMusicDelete !== null
          ? null
          : (currentMusicEdit?.startMs ?? input.nowPlaying.startMs),
      endMs:
        currentMusicDelete !== null ? null : (currentMusicEdit?.endMs ?? input.nowPlaying.endMs),
      liked: currentMusicDelete !== null ? null : input.nowPlaying.liked,
    },
  };
}

function composeAcceptedSpectrumEditEvidence(
  evidenceByPhase: SpectrumEditCommitFrame["acceptedEvidence"],
): SpectrumEditProjectionEvidence {
  return {
    musicEdits: evidenceByPhase.update?.musicEdits ?? [],
    musicCreates: evidenceByPhase.create?.musicCreates ?? [],
    musicDeletes: evidenceByPhase.delete?.musicDeletes ?? [],
  };
}

function hasExpectedSpectrumEditEvidence(
  phase: SpectrumEditCommitPhase,
  evidence: Required<SpectrumEditProjectionEvidence>,
) {
  switch (phase) {
    case "update":
      return evidence.musicEdits.length > 0;
    case "create":
      return evidence.musicCreates.length > 0;
    case "delete":
      return evidence.musicDeletes.length > 0;
  }
}

function baselineContainsMusicEditTarget(
  baseline: SpectrumEditProjectionInput,
  edit: MusicEdit,
) {
  return baseline.collections.some((collection) =>
    collection.musics.some(
      (music) =>
        music.url === edit.url &&
        music.start_ms === edit.targetStartMs &&
        music.end_ms === edit.targetEndMs,
    ),
  );
}

function baselineContainsMusicDeleteTarget(
  baseline: SpectrumEditProjectionInput,
  deletion: MusicDelete,
) {
  return baseline.collections.some((collection) =>
    collection.musics.some(
      (music) =>
        music.url === deletion.url &&
        music.start_ms === deletion.startMs &&
        music.end_ms === deletion.endMs,
    ),
  );
}

function evidenceTargetsBaseline(
  baseline: SpectrumEditProjectionInput,
  evidence: Required<SpectrumEditProjectionEvidence>,
) {
  return (
    evidence.musicEdits.every((edit) => baselineContainsMusicEditTarget(baseline, edit)) &&
    evidence.musicDeletes.every((deletion) =>
      baselineContainsMusicDeleteTarget(baseline, deletion),
    )
  );
}

export function reflectSpectrumEditCommitEvidence(
  frame: SpectrumEditCommitFrame | null,
  accepted: {
    epoch: number;
    evidence: SpectrumEditProjectionEvidence;
    phase: SpectrumEditCommitPhase;
  },
): SpectrumEditCommitReflection {
  if (!frame) {
    return {
      epoch: accepted.epoch,
      kind: "Stops",
      phase: accepted.phase,
      reason: "closed-frame",
    };
  }

  if (accepted.epoch !== frame.epoch) {
    return {
      epoch: accepted.epoch,
      kind: "Stops",
      phase: accepted.phase,
      reason: "stale-epoch",
    };
  }

  if (!frame.pendingPhases.includes(accepted.phase)) {
    return {
      epoch: accepted.epoch,
      kind: "Stops",
      phase: accepted.phase,
      reason: "unexpected-phase",
    };
  }

  const acceptedEvidence = normalizeSpectrumEditProjectionEvidence(accepted.evidence);
  if (!hasExpectedSpectrumEditEvidence(accepted.phase, acceptedEvidence)) {
    return {
      epoch: accepted.epoch,
      frame,
      kind: "Reject",
      phase: accepted.phase,
      reason: "unexpected-evidence",
    };
  }

  if (!evidenceTargetsBaseline(frame.baseline, acceptedEvidence)) {
    return {
      epoch: accepted.epoch,
      frame,
      kind: "Reject",
      phase: accepted.phase,
      reason: "unexpected-evidence",
    };
  }

  const nextAcceptedEvidence = {
    ...frame.acceptedEvidence,
    [accepted.phase]: acceptedEvidence,
  };
  const pendingPhases = frame.pendingPhases.filter((phase) => phase !== accepted.phase);
  const nextFrame =
    pendingPhases.length > 0
      ? {
          ...frame,
          acceptedEvidence: nextAcceptedEvidence,
          pendingPhases,
        }
      : null;

  return {
    frame: nextFrame,
    kind: "accepted",
    projection: projectSpectrumEditTransaction(
      frame.baseline,
      composeAcceptedSpectrumEditEvidence(nextAcceptedEvidence),
    ),
  };
}
