import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createTitleHoverTraceSignature,
  createTitleHoverTraceFramePayload,
  resolveTitleHoverTraceTorphContainerNode,
  resolveTitleHoverTraceVisibleTorphLayer,
  shouldRecordTitleHoverTraceCommit,
  shouldRecordTitleHoverTraceObservation,
  shouldSampleTitleHoverTrace,
} from "./titleHoverTrace";

describe("titleHoverTrace", () => {
  test("samples only active title hover handoff visuals", () => {
    assert.equal(shouldSampleTitleHoverTrace("hold"), true);
    assert.equal(shouldSampleTitleHoverTrace("retain"), true);
    assert.equal(shouldSampleTitleHoverTrace("none"), false);
  });

  test("records commits only around active handoff windows", () => {
    assert.equal(shouldRecordTitleHoverTraceCommit({ current: "none", previous: "none" }), false);
    assert.equal(shouldRecordTitleHoverTraceCommit({ current: "hold", previous: "none" }), true);
    assert.equal(shouldRecordTitleHoverTraceCommit({ current: "retain", previous: "none" }), true);
    assert.equal(shouldRecordTitleHoverTraceCommit({ current: "none", previous: "retain" }), true);
  });

  test("records title observations when the structural signature changes", () => {
    const signature = createTitleHoverTraceSignature({
      layoutId: "playlist-title:Quiet Morning",
      owner: "list-config",
      surface: "play-item",
      textLength: 13,
      visual: "none",
    });

    assert.equal(signature, "list-config|play-item|playlist-title:Quiet Morning|none|13");
    assert.equal(
      shouldRecordTitleHoverTraceObservation({
        currentSignature: signature,
        previousSignature: null,
      }),
      true,
    );
    assert.equal(
      shouldRecordTitleHoverTraceObservation({
        currentSignature: signature,
        previousSignature: signature,
      }),
      false,
    );
  });

  test("keeps trace context structural and does not store title text", () => {
    const payload = createTitleHoverTraceFramePayload({
      context: {
        layoutId: "playlist-title:Quiet Morning",
        owner: "list-config",
        surface: "play-item",
        textLength: 13,
        visual: "retain",
      },
      elapsedMs: 12.345,
      frame: 2,
      node: null,
    });

    assert.deepEqual(payload, {
      elapsedMs: 12.35,
      frame: 2,
      layoutId: "playlist-title:Quiet Morning",
      owner: "list-config",
      snapshot: null,
      surface: "play-item",
      textLength: 13,
      visual: "retain",
    });
    assert.equal("text" in payload, false);
  });

  test("classifies the visible Torph layer without driving behavior", () => {
    assert.equal(
      resolveTitleHoverTraceVisibleTorphLayer({
        hasFlowShell: true,
        hasOverlayGlyphs: true,
      }),
      "overlay",
    );
    assert.equal(
      resolveTitleHoverTraceVisibleTorphLayer({
        hasFlowShell: true,
        hasOverlayGlyphs: false,
      }),
      "flow",
    );
    assert.equal(
      resolveTitleHoverTraceVisibleTorphLayer({
        hasFlowShell: false,
        hasOverlayGlyphs: false,
      }),
      null,
    );
  });

  test("resolves the Torph measurement container from the Torph root", () => {
    const container = {
      parentElement: null,
    } as HTMLElement;
    const root = {
      parentElement: container,
    } as HTMLElement;

    assert.equal(resolveTitleHoverTraceTorphContainerNode(root), container);
    assert.equal(resolveTitleHoverTraceTorphContainerNode(null), null);
  });
});
