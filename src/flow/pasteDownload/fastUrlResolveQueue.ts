import type { PastedDownloadUrlResolution } from "@/src/cmd";
import {
  createCandidateEffectQueue,
  type CandidateEffectQueue,
  type CandidateEffectQueueRuntime,
} from "./candidateEffectQueue";

export interface FastUrlResolveDemand {
  id: string;
  sink: FastUrlResolveQueueSink;
  url: string;
}

export interface FastUrlResolveEnqueueOptions {
  priority?: "front" | "normal";
}

export interface FastUrlResolveQueueSink {
  completed(input: { id: string; resolution: PastedDownloadUrlResolution }): void;
  failed(input: { error: string; id: string }): void;
}

export interface FastUrlResolveQueueRuntime {
  concurrency(): number;
  resolve(url: string, options?: { signal: AbortSignal }): Promise<PastedDownloadUrlResolution>;
  started?(input: { activeCount: number; id: string; queuedCount: number; url: string }): void;
  toErrorMessage(error: unknown): string;
}

export interface FastUrlResolveQueue {
  cancel(id: string): void;
  enqueue(demand: FastUrlResolveDemand, options?: FastUrlResolveEnqueueOptions): void;
  reset(): void;
}

export function resolveDefaultFastUrlResolveConcurrency() {
  return 8;
}

export function createFastUrlResolveQueue(
  runtime: FastUrlResolveQueueRuntime,
): FastUrlResolveQueue {
  const queue: CandidateEffectQueue<PastedDownloadUrlResolution> = createCandidateEffectQueue(
    toCandidateEffectRuntime(runtime),
  );

  return {
    cancel: (id) => queue.cancel(id),
    enqueue: (demand, options) =>
      queue.enqueue(
        {
          id: demand.id,
          input: demand.url,
          sink: {
            completed: ({ id, output }) =>
              demand.sink.completed({
                id,
                resolution: output,
              }),
            failed: demand.sink.failed,
          },
        },
        options,
      ),
    reset: () => queue.reset(),
  };
}

function toCandidateEffectRuntime(
  runtime: FastUrlResolveQueueRuntime,
): CandidateEffectQueueRuntime<PastedDownloadUrlResolution> {
  return {
    concurrency: runtime.concurrency,
    run: runtime.resolve,
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
