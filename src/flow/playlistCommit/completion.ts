import type { PlaylistUpsertResult } from "./core";

export interface PlaylistCommitCompletion {
  reject: (error: Error) => void;
  resolve: (result: PlaylistUpsertResult) => void;
}

let nextCompletionSequence = 0;
const completions = new Map<string, PlaylistCommitCompletion>();

export function createPlaylistCommitCompletion(completion: PlaylistCommitCompletion): string {
  const completionId = `playlist-commit-completion:${nextCompletionSequence}`;
  nextCompletionSequence += 1;
  completions.set(completionId, completion);

  return completionId;
}

export function resolvePlaylistCommitCompletion(
  completionId: string | null,
  result: PlaylistUpsertResult,
) {
  if (!completionId) {
    return;
  }

  const completion = completions.get(completionId);
  if (!completion) {
    return;
  }

  completions.delete(completionId);
  completion.resolve(result);
}

export function rejectPlaylistCommitCompletion(completionId: string | null, error: Error) {
  if (!completionId) {
    return;
  }

  const completion = completions.get(completionId);
  if (!completion) {
    return;
  }

  completions.delete(completionId);
  completion.reject(error);
}

export function rejectAllPlaylistCommitCompletions(error: Error) {
  for (const completion of completions.values()) {
    completion.reject(error);
  }
  completions.clear();
}

export function resetPlaylistCommitCompletions(error: Error) {
  rejectAllPlaylistCommitCompletions(error);
  nextCompletionSequence = 0;
}
