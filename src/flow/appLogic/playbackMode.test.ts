import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveSpectrumEnterPlaybackModeEffects,
  resolveSpectrumExitPlaybackModeEffects,
  shouldCommitSpectrumPlaybackScopeExit,
} from "./playbackMode";

describe("appLogic playback mode", () => {
  test("opens a dedicated backend spectrum scope when entering spectrum", () => {
    assert.deepEqual(resolveSpectrumEnterPlaybackModeEffects(), [
      {
        kind: "enterSpectrumPlaybackScope",
      },
    ]);
  });

  test("closes the dedicated backend spectrum scope on every spectrum exit", () => {
    assert.deepEqual(resolveSpectrumExitPlaybackModeEffects(42), [
      {
        kind: "exitSpectrumPlaybackScope",
        scopeId: 42,
      },
    ]);
  });

  test("keeps spectrum back as scope exit only", () => {
    assert.deepEqual(resolveSpectrumExitPlaybackModeEffects(42), [
      {
        kind: "exitSpectrumPlaybackScope",
        scopeId: 42,
      },
    ]);
  });

  test("commits spectrum scope exit only for the same active scope", () => {
    assert.equal(
      shouldCommitSpectrumPlaybackScopeExit({
        currentScopeId: 42,
        requestedScopeId: 42,
      }),
      true,
    );
    assert.equal(
      shouldCommitSpectrumPlaybackScopeExit({
        currentScopeId: 43,
        requestedScopeId: 42,
      }),
      false,
    );
    assert.equal(
      shouldCommitSpectrumPlaybackScopeExit({
        currentScopeId: null,
        requestedScopeId: 42,
      }),
      false,
    );
  });
});
