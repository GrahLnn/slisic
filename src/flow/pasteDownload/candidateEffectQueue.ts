export interface CandidateEffectQueueSink<TOutput> {
  completed(input: { id: string; output: TOutput }): void;
  failed(input: { error: string; id: string }): void;
}

export interface CandidateEffectDemand<TOutput> {
  id: string;
  input: string;
  sink: CandidateEffectQueueSink<TOutput>;
}

export interface CandidateEffectQueueRuntime<TOutput> {
  concurrency(): number;
  run(input: string, options?: { signal: AbortSignal }): Promise<TOutput>;
  started?(input: { activeCount: number; id: string; input: string; queuedCount: number }): void;
  toErrorMessage(error: unknown): string;
}

export interface CandidateEffectQueue<TOutput> {
  cancel(id: string): void;
  enqueue(demand: CandidateEffectDemand<TOutput>): void;
  reset(): void;
}

type QueuedCandidateEffect<TOutput> = CandidateEffectDemand<TOutput> & {
  cancelled: boolean;
  controller: AbortController | null;
  token: number;
};

function normalizeConcurrency(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

export function createCandidateEffectQueue<TOutput>(
  runtime: CandidateEffectQueueRuntime<TOutput>,
): CandidateEffectQueue<TOutput> {
  const queued: QueuedCandidateEffect<TOutput>[] = [];
  const active = new Map<number, QueuedCandidateEffect<TOutput>>();
  const latestTokenById = new Map<string, number>();
  let nextToken = 0;

  function isOpen(item: QueuedCandidateEffect<TOutput>) {
    return !item.cancelled && latestTokenById.get(item.id) === item.token;
  }

  function pump() {
    const concurrency = normalizeConcurrency(runtime.concurrency());

    while (active.size < concurrency && queued.length > 0) {
      const next = queued.shift();
      if (!next || !isOpen(next)) {
        continue;
      }

      next.controller = new AbortController();
      active.set(next.token, next);
      runtime.started?.({
        activeCount: active.size,
        id: next.id,
        input: next.input,
        queuedCount: queued.filter(isOpen).length,
      });
      void runtime
        .run(next.input, { signal: next.controller.signal })
        .then((output) => {
          if (isOpen(next)) {
            next.sink.completed({
              id: next.id,
              output,
            });
          }
        })
        .catch((error) => {
          if (isOpen(next)) {
            next.sink.failed({
              id: next.id,
              error: runtime.toErrorMessage(error),
            });
          }
        })
        .finally(() => {
          active.delete(next.token);
          pump();
        });
    }
  }

  function enqueue(demand: CandidateEffectDemand<TOutput>) {
    for (const item of queued) {
      if (item.id === demand.id) {
        item.cancelled = true;
        item.controller?.abort();
      }
    }
    for (const [token, item] of active) {
      if (item.id === demand.id) {
        item.cancelled = true;
        item.controller?.abort();
        active.delete(token);
      }
    }

    const token = nextToken++;
    latestTokenById.set(demand.id, token);
    queued.push({
      ...demand,
      cancelled: false,
      controller: null,
      token,
    });
    pump();
  }

  function cancel(id: string) {
    latestTokenById.delete(id);
    for (const item of queued) {
      if (item.id === id) {
        item.cancelled = true;
        item.controller?.abort();
      }
    }
    for (const [token, item] of active) {
      if (item.id === id) {
        item.cancelled = true;
        item.controller?.abort();
        active.delete(token);
      }
    }
    pump();
  }

  function reset() {
    latestTokenById.clear();
    for (const item of active.values()) {
      item.cancelled = true;
      item.controller?.abort();
    }
    for (const item of queued) {
      item.cancelled = true;
      item.controller?.abort();
    }
    queued.length = 0;
    active.clear();
  }

  return {
    cancel,
    enqueue,
    reset,
  };
}
