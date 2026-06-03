import type { PlaylistDraftCommit, PlaylistUpsertResult } from "../appLogic/core";

export type PlaylistCommitRequest = PlaylistDraftCommit;
export type { PlaylistUpsertResult };

export interface PlaylistCommitSubmission {
  completionId: string | null;
  request: PlaylistCommitRequest;
}

export interface PlaylistCommitFrame {
  baselinePreview: PlaylistCommitRequest["preview"];
  completionId: string | null;
  id: string;
  request: PlaylistCommitRequest;
}

export interface PlaylistCommitContext {
  queue: PlaylistCommitFrame[];
  activeFrame: PlaylistCommitFrame | null;
  error: string | null;
  nextFrameSequence: number;
}

export type PlaylistCommitReflection =
  | {
      evidence: PlaylistUpsertResult;
      frame: PlaylistCommitFrame;
      kind: "accepted";
    }
  | {
      evidence: PlaylistUpsertResult;
      frame: PlaylistCommitFrame;
      kind: "Reject";
      reason: "unexpected-evidence";
    }
  | {
      frameId: string | null;
      kind: "Stops";
      reason: "closed-frame";
    };

export function createInitialContext(): PlaylistCommitContext {
  return {
    queue: [],
    activeFrame: null,
    error: null,
    nextFrameSequence: 0,
  };
}

export function createPlaylistCommitFrame(
  submission: PlaylistCommitSubmission,
  sequence: number,
): PlaylistCommitFrame {
  return {
    baselinePreview: submission.request.preview,
    completionId: submission.completionId,
    id: `playlist-commit:${sequence}`,
    request: submission.request,
  };
}

export function createPlaylistCommitSubmission(
  request: PlaylistCommitRequest,
  completionId: string | null = null,
): PlaylistCommitSubmission {
  return {
    completionId,
    request,
  };
}

export function enqueueCommit(
  context: PlaylistCommitContext,
  submission: PlaylistCommitSubmission,
): PlaylistCommitContext {
  const frame = createPlaylistCommitFrame(submission, context.nextFrameSequence);

  return {
    ...context,
    queue: [...context.queue, frame],
    nextFrameSequence: context.nextFrameSequence + 1,
  };
}

export function hasPendingCommit(context: PlaylistCommitContext) {
  return context.queue.length > 0;
}

export function activateNextCommit(context: PlaylistCommitContext): PlaylistCommitContext {
  const [activeFrame, ...queue] = context.queue;

  return {
    ...context,
    activeFrame: activeFrame ?? null,
    queue,
  };
}

export function clearActiveCommit(
  context: PlaylistCommitContext,
  error: string | null = null,
): PlaylistCommitContext {
  return {
    ...context,
    activeFrame: null,
    error,
  };
}

export function reflectPlaylistCommitEvidence(
  frame: PlaylistCommitFrame | null,
  evidence: PlaylistUpsertResult,
): PlaylistCommitReflection {
  if (!frame) {
    return {
      frameId: null,
      kind: "Stops",
      reason: "closed-frame",
    };
  }

  if (
    evidence.previousName !== frame.request.request.previousName ||
    evidence.playlist.name !== frame.request.request.playlist.name
  ) {
    return {
      evidence,
      frame,
      kind: "Reject",
      reason: "unexpected-evidence",
    };
  }

  return {
    evidence,
    frame,
    kind: "accepted",
  };
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
