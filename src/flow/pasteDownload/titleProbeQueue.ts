import type { DownloadRootTitleEvidence } from "@/src/cmd";
import {
  createCandidateEffectQueue,
  type CandidateEffectQueue,
  type CandidateEffectQueueRuntime,
} from "./candidateEffectQueue";

export interface TitleProbeDemand {
  id: string;
  url: string;
  sink: TitleProbeQueueSink;
}

export interface TitleProbeQueueSink {
  completed(input: { evidence: DownloadRootTitleEvidence; id: string }): void;
  failed(input: { error: string; id: string }): void;
}

export interface TitleProbeQueueRuntime {
  concurrency(): number;
  probe(url: string, options?: { signal: AbortSignal }): Promise<DownloadRootTitleEvidence>;
  started?(input: { activeCount: number; id: string; queuedCount: number; url: string }): void;
  toErrorMessage(error: unknown): string;
}

export interface TitleProbeQueue {
  cancel(id: string): void;
  enqueue(demand: TitleProbeDemand): void;
  reset(): void;
}

export function resolveDefaultTitleProbeConcurrency() {
  return 4;
}

export function createTitleProbeQueue(runtime: TitleProbeQueueRuntime): TitleProbeQueue {
  const queue: CandidateEffectQueue<DownloadRootTitleEvidence> = createCandidateEffectQueue(
    toCandidateEffectRuntime(runtime),
  );

  return {
    cancel: (id) => queue.cancel(id),
    enqueue: (demand) =>
      queue.enqueue({
        id: demand.id,
        input: demand.url,
        sink: {
          completed: ({ id, output }) =>
            demand.sink.completed({
              id,
              evidence: output,
            }),
          failed: demand.sink.failed,
        },
      }),
    reset: () => queue.reset(),
  };
}

function toCandidateEffectRuntime(
  runtime: TitleProbeQueueRuntime,
): CandidateEffectQueueRuntime<DownloadRootTitleEvidence> {
  return {
    concurrency: runtime.concurrency,
    run: runtime.probe,
    started: runtime.started
      ? ({ activeCount, id, input, queuedCount }) =>
          runtime.started?.({
            activeCount,
            id,
            queuedCount,
            url: input,
          })
      : undefined,
    toErrorMessage: runtime.toErrorMessage,
  };
}
