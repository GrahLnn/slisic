import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PlaybackContinuationMode } from "@/src/cmd";
import { createPlaybackContinuationModeEffectOwner } from "./playbackContinuationModeEffectOwner";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<boolean>((done) => {
    resolve = () => done(true);
  });

  return {
    promise,
    resolve,
  };
}

describe("playback continuation mode effect owner", () => {
  test("serializes stale exit random before later spectrum repeat current", async () => {
    const writes: PlaybackContinuationMode[] = [];
    const randomCompletion = deferred();
    const repeatCompletion = deferred();
    const completions = [randomCompletion, repeatCompletion];
    const owner = createPlaybackContinuationModeEffectOwner({
      setPlaybackContinuationMode: (mode) => {
        writes.push(mode);
        const completion = completions.shift();
        assert.ok(completion);
        return completion.promise;
      },
    });

    const randomRequest = owner.request("random");
    const repeatRequest = owner.request("repeatCurrent");

    assert.deepEqual(writes, ["random"]);
    randomCompletion.resolve();
    await Promise.resolve();

    assert.deepEqual(writes, ["random", "repeatCurrent"]);
    repeatCompletion.resolve();
    await Promise.all([randomRequest, repeatRequest]);
  });

  test("keeps only the latest pending mode while a write is active", async () => {
    const writes: PlaybackContinuationMode[] = [];
    const randomCompletion = deferred();
    const repeatCompletion = deferred();
    const completions = [randomCompletion, repeatCompletion];
    const owner = createPlaybackContinuationModeEffectOwner({
      setPlaybackContinuationMode: (mode) => {
        writes.push(mode);
        const completion = completions.shift();
        assert.ok(completion);
        return completion.promise;
      },
    });

    const firstRequest = owner.request("random");
    const secondRequest = owner.request("repeatCurrent");
    const thirdRequest = owner.request("random");

    assert.deepEqual(writes, ["random"]);
    randomCompletion.resolve();
    await Promise.resolve();

    assert.deepEqual(writes, ["random"]);
    await Promise.all([firstRequest, secondRequest, thirdRequest]);
  });
});
