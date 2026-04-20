import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createActor, fromPromise } from "xstate";
import { machine } from "./machine";
import { sig, type BootstrapResult } from "./events";

describe("appLogic machine", () => {
  test("automatically retries loading after entering the error state", async () => {
    let loadAttempt = 0;
    const states: string[] = [];

    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () => {
            loadAttempt += 1;

            if (loadAttempt === 1) {
              throw new Error("boom");
            }

            return {
              hasPlayList: false,
              playlists: [],
              collections: [],
              savePath: "C:\\Music",
            } satisfies BootstrapResult;
          }),
        },
      }),
    );

    const settled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`unexpected state sequence: ${states.join(" -> ")}`));
      }, 2000);

      actor.subscribe((snapshot) => {
        states.push(String(snapshot.value));

        if (snapshot.value === "ready") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    actor.start();
    actor.send(sig.mainx.run);

    await settled;

    assert.deepEqual(states, ["idle", "loading", "loading", "ready"]);
    assert.equal(loadAttempt, 2);
    assert.equal(actor.getSnapshot().context.error, null);
  });
});
