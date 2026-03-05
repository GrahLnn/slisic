import { Effect, Fiber } from "effect";

export type PlaybackMode = "play" | "create" | "edit" | "new_guide";

export interface PlaybackContextSnapshot {
  mode: PlaybackMode;
  selectedListName: string | null;
}

export class PlaybackCoordinator {
  private epoch = 0;
  private fiber: Fiber.Fiber<void, never> | null = null;
  private disposed = false;

  bumpEpoch(): number {
    this.epoch += 1;
    return this.epoch;
  }

  getEpoch(): number {
    return this.epoch;
  }

  markDisposed(): void {
    this.disposed = true;
    this.bumpEpoch();
  }

  markActive(): void {
    this.disposed = false;
  }

  isActive(
    epoch: number,
    snapshot: PlaybackContextSnapshot,
    expectedListName?: string,
  ): boolean {
    if (this.disposed) return false;
    if (epoch !== this.epoch) return false;
    if (snapshot.mode !== "play") return false;
    if (!snapshot.selectedListName) return false;
    if (expectedListName && snapshot.selectedListName !== expectedListName) {
      return false;
    }
    return true;
  }

  async interruptCurrent(): Promise<void> {
    const current = this.fiber;
    this.fiber = null;
    if (!current) return;
    await Effect.runPromise(Effect.ignore(Fiber.interrupt(current)));
  }

  replaceWith(task: Effect.Effect<void>, epoch: number): void {
    if (this.disposed || epoch !== this.epoch) return;

    const previous = this.fiber;
    if (previous) {
      void Effect.runPromise(Effect.ignore(Fiber.interrupt(previous)));
    }

    const fiber = Effect.runFork(Effect.ignore(task));
    this.fiber = fiber;
    fiber.addObserver(() => {
      if (this.fiber === fiber) {
        this.fiber = null;
      }
    });
  }
}
