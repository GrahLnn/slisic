import type { PlaylistDraftCommit, PlaylistUpsertResult } from "../appLogic/core";

export type PlaylistCommitRequest = PlaylistDraftCommit;
export type { PlaylistUpsertResult };

export interface PlaylistCommitContext {
  queue: PlaylistCommitRequest[];
  activeRequest: PlaylistCommitRequest | null;
  error: string | null;
}

export function createInitialContext(): PlaylistCommitContext {
  return {
    queue: [],
    activeRequest: null,
    error: null,
  };
}

export function enqueueCommit(
  context: PlaylistCommitContext,
  request: PlaylistCommitRequest,
): PlaylistCommitContext {
  return {
    ...context,
    queue: [...context.queue, request],
  };
}

export function hasPendingCommit(context: PlaylistCommitContext) {
  return context.queue.length > 0;
}

export function activateNextCommit(context: PlaylistCommitContext): PlaylistCommitContext {
  const [activeRequest, ...queue] = context.queue;

  return {
    ...context,
    activeRequest: activeRequest ?? null,
    queue,
  };
}

export function clearActiveCommit(
  context: PlaylistCommitContext,
  error: string | null = null,
): PlaylistCommitContext {
  return {
    ...context,
    activeRequest: null,
    error,
  };
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
