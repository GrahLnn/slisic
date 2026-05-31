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
      name:
        currentMusicDelete !== null ? null : (currentMusicEdit?.alias ?? input.nowPlaying.name),
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
