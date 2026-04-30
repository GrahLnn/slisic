import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  recordSpectrumWaveformTrace,
  sanitizeSpectrumWaveformTracePayload,
} from "./spectrumWaveformTrace";

describe("spectrumWaveformTrace payload sanitization", () => {
  test("serializes circular payloads without throwing", () => {
    const payload: Record<string, unknown> = {
      label: "waveform",
    };
    payload.self = payload;

    const sanitized = sanitizeSpectrumWaveformTracePayload(payload);

    assert.equal(JSON.stringify(sanitized).includes("[Circular]"), true);
  });

  test("serializes React fiber shaped DOM payloads without following the cycle", () => {
    const nodeLike: Record<string, unknown> = {
      tagName: "DIV",
    };
    nodeLike.__reactFiber = {
      stateNode: nodeLike,
    };

    const sanitized = sanitizeSpectrumWaveformTracePayload({
      node: nodeLike,
    });

    assert.doesNotThrow(() => JSON.stringify(sanitized));
    assert.equal(JSON.stringify(sanitized).includes("[Circular]"), true);
  });

  test("serializes non-DOM event targets when Element is unavailable", () => {
    if (typeof Event === "undefined" || typeof EventTarget === "undefined") {
      return;
    }

    const target = new EventTarget();
    const event = new Event("wheel");
    target.dispatchEvent(event);

    const sanitized = sanitizeSpectrumWaveformTracePayload({
      event,
    });

    assert.doesNotThrow(() => JSON.stringify(sanitized));
  });

  test("does not compute lazy payloads when tracing is disabled", () => {
    assert.doesNotThrow(() => {
      recordSpectrumWaveformTrace("disabled", () => {
        throw new Error("payload should stay lazy");
      });
    });
  });
});
