import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCandidateEffectQueue } from "./candidateEffectQueue";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("candidate effect queue", () => {
  test("runs candidate effects with bounded concurrency", async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const third = createDeferred<string>();
    const started: string[] = [];
    const completed: string[] = [];
    const effects = new Map([
      ["first", first],
      ["second", second],
      ["third", third],
    ]);
    const queue = createCandidateEffectQueue({
      concurrency: () => 2,
      run: (input) => {
        started.push(input);
        const effect = effects.get(input);
        if (!effect) {
          throw new Error(`unexpected input: ${input}`);
        }
        return effect.promise;
      },
      toErrorMessage: (error) => String(error),
    });
    const sink = {
      completed: ({ id }: { id: string }) => completed.push(id),
      failed: () => undefined,
    };

    queue.enqueue({ id: "candidate:first", input: "first", sink });
    queue.enqueue({ id: "candidate:second", input: "second", sink });
    queue.enqueue({ id: "candidate:third", input: "third", sink });
    await flushMicrotasks();

    assert.deepEqual(started, ["first", "second"]);

    second.resolve("done");
    await flushMicrotasks();

    assert.deepEqual(completed, ["candidate:second"]);
    assert.deepEqual(started, ["first", "second", "third"]);

    first.resolve("done");
    third.resolve("done");
    await flushMicrotasks();

    assert.deepEqual(completed, ["candidate:second", "candidate:first", "candidate:third"]);
  });

  test("closes late results for cancelled candidate scopes", async () => {
    const effect = createDeferred<string>();
    const completed: string[] = [];
    const failed: string[] = [];
    const queue = createCandidateEffectQueue({
      concurrency: () => 1,
      run: () => effect.promise,
      toErrorMessage: (error) => String(error),
    });

    queue.enqueue({
      id: "candidate:1",
      input: "url",
      sink: {
        completed: ({ id }) => completed.push(id),
        failed: ({ id }) => failed.push(id),
      },
    });
    queue.cancel("candidate:1");
    effect.resolve("done");
    await flushMicrotasks();

    assert.deepEqual(completed, []);
    assert.deepEqual(failed, []);
  });

  test("reset releases capacity without waiting for old active promises", async () => {
    const oldEffect = createDeferred<string>();
    const newEffect = createDeferred<string>();
    const started: string[] = [];
    const completed: string[] = [];
    const queue = createCandidateEffectQueue({
      concurrency: () => 1,
      run: (input) => (input === "old" ? oldEffect.promise : newEffect.promise),
      started: ({ input }) => started.push(input),
      toErrorMessage: (error) => String(error),
    });
    const sink = {
      completed: ({ id }: { id: string }) => completed.push(id),
      failed: () => undefined,
    };

    queue.enqueue({ id: "candidate:old", input: "old", sink });
    await flushMicrotasks();
    queue.reset();
    queue.enqueue({ id: "candidate:new", input: "new", sink });
    await flushMicrotasks();

    assert.deepEqual(started, ["old", "new"]);

    oldEffect.resolve("old done");
    newEffect.resolve("new done");
    await flushMicrotasks();

    assert.deepEqual(completed, ["candidate:new"]);
  });
});
