import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { PlaybackCoordinator } from "./playbackCoordinator";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe("PlaybackCoordinator", () => {
  test("replaceWith should keep only latest playback fiber active", async () => {
    const coordinator = new PlaybackCoordinator();
    coordinator.markActive();

    const calls: string[] = [];
    const oldEpoch = coordinator.bumpEpoch();
    coordinator.replaceWith(
      Effect.gen(function* () {
        yield* Effect.sleep("80 millis");
        yield* Effect.sync(() => {
          calls.push("old");
        });
      }),
      oldEpoch,
    );

    const newEpoch = coordinator.bumpEpoch();
    coordinator.replaceWith(
      Effect.sync(() => {
        calls.push("new");
      }),
      newEpoch,
    );

    await sleep(120);
    expect(calls).toEqual(["new"]);
    await coordinator.interruptCurrent();
  });

  test("interruptCurrent should cancel running task", async () => {
    const coordinator = new PlaybackCoordinator();
    coordinator.markActive();

    let completed = false;
    const epoch = coordinator.bumpEpoch();
    coordinator.replaceWith(
      Effect.gen(function* () {
        yield* Effect.sleep("120 millis");
        yield* Effect.sync(() => {
          completed = true;
        });
      }),
      epoch,
    );

    await sleep(20);
    await coordinator.interruptCurrent();
    await sleep(150);
    expect(completed).toBeFalse();
  });

  test("isActive should validate epoch, mode, and selected list", () => {
    const coordinator = new PlaybackCoordinator();
    coordinator.markActive();
    const epoch = coordinator.bumpEpoch();

    expect(
      coordinator.isActive(epoch, {
        mode: "play",
        selectedListName: "ambient",
      }),
    ).toBeTrue();
    expect(
      coordinator.isActive(epoch, {
        mode: "edit",
        selectedListName: "ambient",
      }),
    ).toBeFalse();
    expect(
      coordinator.isActive(epoch, {
        mode: "play",
        selectedListName: null,
      }),
    ).toBeFalse();
    expect(
      coordinator.isActive(
        epoch,
        {
          mode: "play",
          selectedListName: "ambient",
        },
        "contemporary",
      ),
    ).toBeFalse();
  });

  test("markDisposed should invalidate pending epochs", async () => {
    const coordinator = new PlaybackCoordinator();
    coordinator.markActive();
    const epoch = coordinator.bumpEpoch();
    coordinator.markDisposed();

    expect(
      coordinator.isActive(epoch, {
        mode: "play",
        selectedListName: "ambient",
      }),
    ).toBeFalse();

    let called = false;
    coordinator.replaceWith(
      Effect.sync(() => {
        called = true;
      }),
      epoch,
    );

    await sleep(20);
    expect(called).toBeFalse();
  });
});
