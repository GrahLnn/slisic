import type { DownloadRootTitleEvidence } from "@/src/cmd";

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
  probe(url: string): Promise<DownloadRootTitleEvidence>;
  started?(input: { activeCount: number; id: string; queuedCount: number; url: string }): void;
  toErrorMessage(error: unknown): string;
}

export interface TitleProbeQueue {
  cancel(id: string): void;
  enqueue(demand: TitleProbeDemand): void;
  reset(): void;
}

type QueuedTitleProbe = TitleProbeDemand & {
  cancelled: boolean;
  token: number;
};

function normalizeConcurrency(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

export function resolveDefaultTitleProbeConcurrency() {
  return 4;
}

export function createTitleProbeQueue(runtime: TitleProbeQueueRuntime): TitleProbeQueue {
  const queued: QueuedTitleProbe[] = [];
  const active = new Map<number, QueuedTitleProbe>();
  const latestTokenById = new Map<string, number>();
  let nextToken = 0;

  function isOpen(item: QueuedTitleProbe) {
    return !item.cancelled && latestTokenById.get(item.id) === item.token;
  }

  function pump() {
    const concurrency = normalizeConcurrency(runtime.concurrency());

    while (active.size < concurrency && queued.length > 0) {
      const next = queued.shift();
      if (!next || !isOpen(next)) {
        continue;
      }

      active.set(next.token, next);
      runtime.started?.({
        activeCount: active.size,
        id: next.id,
        queuedCount: queued.filter(isOpen).length,
        url: next.url,
      });
      void runtime
        .probe(next.url)
        .then((evidence) => {
          if (isOpen(next)) {
            next.sink.completed({
              id: next.id,
              evidence,
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

  function enqueue(demand: TitleProbeDemand) {
    for (const item of queued) {
      if (item.id === demand.id) {
        item.cancelled = true;
      }
    }
    for (const [token, item] of active) {
      if (item.id === demand.id) {
        item.cancelled = true;
        active.delete(token);
      }
    }

    const token = nextToken++;
    latestTokenById.set(demand.id, token);
    queued.push({
      ...demand,
      cancelled: false,
      token,
    });
    pump();
  }

  function cancel(id: string) {
    latestTokenById.delete(id);
    for (const item of queued) {
      if (item.id === id) {
        item.cancelled = true;
      }
    }
    for (const [token, item] of active) {
      if (item.id === id) {
        item.cancelled = true;
        active.delete(token);
      }
    }
    pump();
  }

  function reset() {
    queued.length = 0;
    latestTokenById.clear();
    for (const item of active.values()) {
      item.cancelled = true;
    }
    active.clear();
  }

  return {
    cancel,
    enqueue,
    reset,
  };
}
