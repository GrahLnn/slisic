import type {
  MusicCreateInput,
  MusicCreatesResult,
  MusicDeletesResult,
  MusicUpdateInput,
  MusicUpdatesResult,
  SpectrumMusicCommitFailurePhase,
} from "./events";
import type { SpectrumMusicDraft } from "./core";
import {
  createMusicDraftCreates,
  createMusicDraftDeletes,
  createMusicDraftEdits,
  hasSpectrumMusicDraftCommitOperations,
  type MusicDraftDelete,
} from "./musicTitle";

export type SpectrumMusicCommitPhase = SpectrumMusicCommitFailurePhase;

export interface SpectrumMusicCommitPlan {
  creates: MusicCreateInput[];
  deletes: MusicDraftDelete[];
  epoch: number;
  updates: MusicUpdateInput[];
}

export interface SpectrumMusicCommitRuntime {
  createMusics(inputs: MusicCreateInput[]): Promise<MusicCreatesResult>;
  deleteMusics(inputs: MusicDraftDelete[]): Promise<MusicDeletesResult>;
  updateMusics(inputs: MusicUpdateInput[]): Promise<MusicUpdatesResult>;
}

export interface SpectrumMusicCommitSink {
  failed(input: { epoch: number; error: string; phase: SpectrumMusicCommitPhase }): void;
  created(input: { epoch: number; result: MusicCreatesResult }): void;
  deleted(input: { epoch: number; result: MusicDeletesResult }): void;
  updated(input: { epoch: number; result: MusicUpdatesResult }): void;
}

export interface SpectrumMusicCommitTrace {
  failed?(input: { epoch: number; error: string; phase: SpectrumMusicCommitPhase }): void;
  finished?(input: { epoch: number }): void;
  requested?(input: {
    creates: number;
    deletes: number;
    epoch: number;
    updates: number;
  }): void;
}

export function createSpectrumMusicCommitPlan(args: {
  drafts: readonly SpectrumMusicDraft[];
  epoch: number;
}): SpectrumMusicCommitPlan {
  return {
    creates: createMusicDraftCreates(args.drafts).map((create) => ({
      sourceCollectionUrl: create.sourceCollectionUrl,
      music: create.music,
    })),
    deletes: createMusicDraftDeletes(args.drafts),
    epoch: args.epoch,
    updates: createMusicDraftEdits(args.drafts).map((edit) => ({
      alias: edit.alias,
      endMs: edit.endMs,
      startMs: edit.startMs,
      targetEndMs: edit.targetEndMs,
      targetStartMs: edit.targetStartMs,
      url: edit.url,
    })),
  };
}

export function hasSpectrumMusicCommitOperations(drafts: readonly SpectrumMusicDraft[]) {
  return hasSpectrumMusicDraftCommitOperations(drafts);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function runCommitPhase<TResult>(args: {
  commit: () => Promise<TResult>;
  epoch: number;
  onSuccess: (input: { epoch: number; result: TResult }) => void;
  phase: SpectrumMusicCommitPhase;
  sink: SpectrumMusicCommitSink;
  trace: SpectrumMusicCommitTrace;
}) {
  try {
    const result = await args.commit();
    args.onSuccess({ epoch: args.epoch, result });
    return true;
  } catch (error) {
    const message = errorMessage(error);
    const failure = {
      epoch: args.epoch,
      error: message,
      phase: args.phase,
    };
    args.trace.failed?.(failure);
    args.sink.failed(failure);
    return false;
  }
}

export async function runSpectrumMusicCommitTransaction(args: {
  plan: SpectrumMusicCommitPlan;
  runtime: SpectrumMusicCommitRuntime;
  sink: SpectrumMusicCommitSink;
  trace?: SpectrumMusicCommitTrace;
}) {
  const trace = args.trace ?? {};
  trace.requested?.({
    epoch: args.plan.epoch,
    creates: args.plan.creates.length,
    deletes: args.plan.deletes.length,
    updates: args.plan.updates.length,
  });

  if (
    args.plan.updates.length > 0 &&
    !(await runCommitPhase({
      commit: () => args.runtime.updateMusics(args.plan.updates),
      epoch: args.plan.epoch,
      onSuccess: args.sink.updated,
      phase: "update",
      sink: args.sink,
      trace,
    }))
  ) {
    return;
  }

  if (
    args.plan.creates.length > 0 &&
    !(await runCommitPhase({
      commit: () => args.runtime.createMusics(args.plan.creates),
      epoch: args.plan.epoch,
      onSuccess: args.sink.created,
      phase: "create",
      sink: args.sink,
      trace,
    }))
  ) {
    return;
  }

  if (
    args.plan.deletes.length > 0 &&
    !(await runCommitPhase({
      commit: () => args.runtime.deleteMusics(args.plan.deletes),
      epoch: args.plan.epoch,
      onSuccess: args.sink.deleted,
      phase: "delete",
      sink: args.sink,
      trace,
    }))
  ) {
    return;
  }

  trace.finished?.({ epoch: args.plan.epoch });
}

export function createUnexpectedSpectrumMusicCommitFailure(args: {
  epoch: number;
  error: unknown;
}) {
  return {
    epoch: args.epoch,
    error: errorMessage(args.error),
    phase: "unexpected" as const,
  };
}
