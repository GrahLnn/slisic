import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createActor, fromPromise } from "xstate";
import type { UpdateCheckResult } from "./events";
import { sig, ss } from "./events";
import { machine, ONE_HOUR } from "./machine";

class TestClock {
  private now = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; run: () => void }>();

  setTimeout(run: () => void, delay: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delay, run });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  advanceBy(duration: number): void {
    const target = this.now + duration;

    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) {
        break;
      }

      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.at;
      timer.run();
    }

    this.now = target;
  }
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function updaterMachine(checkUpdate: () => Promise<UpdateCheckResult>) {
  return machine.provide({
    actors: {
      checkUpdate: fromPromise(checkUpdate),
    },
  });
}

describe("updater machine", () => {
  test("checks again one hour after an up-to-date result", async () => {
    const clock = new TestClock();
    let checks = 0;
    const actor = createActor(
      updaterMachine(async () => {
        checks += 1;
        return { kind: "up_to_date" };
      }),
      { clock },
    );

    actor.start();
    actor.send(sig.mainx.run);
    await flushMicrotasks();

    assert.equal(actor.getSnapshot().value, ss.mainx.State.waiting);
    assert.equal(checks, 1);

    clock.advanceBy(ONE_HOUR - 1);
    await flushMicrotasks();
    assert.equal(checks, 1);

    clock.advanceBy(1);
    await flushMicrotasks();
    assert.equal(checks, 2);
    assert.equal(actor.getSnapshot().value, ss.mainx.State.waiting);
    actor.stop();
  });

  test("checks again one hour after a recoverable failure", async () => {
    const clock = new TestClock();
    let checks = 0;
    const actor = createActor(
      updaterMachine(async () => {
        checks += 1;
        throw new Error("offline");
      }),
      { clock },
    );

    actor.start();
    actor.send(sig.mainx.run);
    await flushMicrotasks();

    assert.equal(actor.getSnapshot().value, ss.mainx.State.waiting);
    clock.advanceBy(ONE_HOUR);
    await flushMicrotasks();
    assert.equal(checks, 2);
    actor.stop();
  });

  test("stops checking after an update has been downloaded", async () => {
    const clock = new TestClock();
    let checks = 0;
    const actor = createActor(
      updaterMachine(async () => {
        checks += 1;
        return { kind: "available", version: "2.0.3" };
      }),
      { clock },
    );

    actor.start();
    actor.send(sig.mainx.run);
    await flushMicrotasks();

    assert.equal(actor.getSnapshot().value, ss.mainx.State.ready);
    clock.advanceBy(ONE_HOUR * 2);
    await flushMicrotasks();
    assert.equal(checks, 1);
    actor.stop();
  });
});
