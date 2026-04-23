import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveGhostTraceElementTextVisibleRect,
  resolveGhostTraceVisibleLayer,
  type GhostTraceElementCoreSnapshot,
  type GhostTraceRect,
} from "./listConfigGhostTrace";

function createRect(partial: Partial<GhostTraceRect> = {}): GhostTraceRect {
  return {
    x: partial.left ?? partial.x ?? 0,
    y: partial.top ?? partial.y ?? 0,
    width: partial.width ?? 10,
    height: partial.height ?? 10,
    top: partial.top ?? partial.y ?? 0,
    right:
      partial.right ??
      ((partial.left ?? partial.x ?? 0) + (partial.width ?? 10)),
    bottom:
      partial.bottom ??
      ((partial.top ?? partial.y ?? 0) + (partial.height ?? 10)),
    left: partial.left ?? partial.x ?? 0,
  };
}

function createSnapshot(
  partial: Partial<GhostTraceElementCoreSnapshot> = {},
): GhostTraceElementCoreSnapshot {
  return {
    tagName: "div",
    id: null,
    className: "",
    text: "",
    dataAttributes: {},
    rect: partial.rect ?? createRect(),
    devicePixelRatio: 1,
    devicePixelRect: partial.rect ?? createRect(),
    textVisibleRectSource: null,
    textVisibleRect: null,
    devicePixelTextVisibleRect: null,
    scrollTop: null,
    scrollLeft: null,
    scrollWidth: null,
    scrollHeight: null,
    clientWidth: null,
    clientHeight: null,
    offsetWidth: null,
    offsetHeight: null,
    offsetLeft: null,
    offsetTop: null,
    position: "static",
    display: "block",
    visibility: "visible",
    boxSizing: "border-box",
    left: "0px",
    top: "0px",
    margin: "0px",
    overflow: "visible",
    overflowX: "visible",
    overflowY: "visible",
    whiteSpace: "normal",
    overflowWrap: "normal",
    wordBreak: "normal",
    width: "10px",
    height: "10px",
    lineHeight: "10px",
    transform: "none",
    transformMatrix: null,
    transformOrigin: "0px 0px",
    transformOriginPoint: { x: 0, y: 0 },
    opacity: "1",
    clipPath: "none",
    filter: "none",
    pointerEvents: "auto",
    willChange: "auto",
    transitionProperty: "all",
    transitionDuration: "0s",
    transitionTimingFunction: "ease",
    animationStates: [],
    inlineLeft: null,
    inlineTop: null,
    inlineWidth: null,
    inlineHeight: null,
    inlineTransform: null,
    inlineTransformOrigin: null,
    inlineOpacity: null,
    inlineTransition: null,
    ...partial,
  };
}

describe("listConfigGhostTrace visible layer", () => {
  test("prefers overlay live glyph bounds when the overlay is visible", () => {
    const overlayLiveGlyphRect = createRect({
      left: 12,
      top: 4,
      width: 20,
      height: 8,
    });

    assert.deepEqual(
      resolveGhostTraceVisibleLayer({
        root: createSnapshot({
          rect: createRect({
            left: 10,
            top: 2,
            width: 24,
            height: 12,
          }),
        }),
        flowShell: createSnapshot({
          visibility: "hidden",
        }),
        flow: createSnapshot({
          visibility: "hidden",
        }),
        overlay: createSnapshot(),
        overlayLiveGlyphRect,
      }),
      {
        role: "overlay",
        rect: overlayLiveGlyphRect,
        rectSource: "overlay-live-glyphs",
      },
    );
  });

  test("falls back to flow when the overlay has no visible live glyphs", () => {
    const flowRect = createRect({
      left: 5,
      top: 6,
      width: 18,
      height: 9,
    });

    assert.deepEqual(
      resolveGhostTraceVisibleLayer({
        root: createSnapshot(),
        flowShell: createSnapshot({
          visibility: "hidden",
        }),
        flow: createSnapshot({
          rect: flowRect,
        }),
        overlay: createSnapshot({
          opacity: "0",
        }),
        overlayLiveGlyphRect: null,
      }),
      {
        role: "flow",
        rect: flowRect,
        rectSource: "flow",
      },
    );
  });

  test("uses the flow text rect before the flow container rect when overlay is absent", () => {
    const flowTextRect = createRect({
      left: 7,
      top: 8,
      width: 15,
      height: 6,
    });

    assert.deepEqual(
      resolveGhostTraceVisibleLayer({
        root: createSnapshot(),
        flowShell: createSnapshot({
          visibility: "hidden",
        }),
        flow: createSnapshot({
          rect: createRect({
            left: 5,
            top: 6,
            width: 18,
            height: 9,
          }),
          textVisibleRectSource: "text-range-client-rects",
          textVisibleRect: flowTextRect,
        }),
        overlay: createSnapshot({
          opacity: "0",
        }),
        overlayLiveGlyphRect: null,
      }),
      {
        role: "flow",
        rect: flowTextRect,
        rectSource: "flow-text-range-client-rects",
      },
    );
  });

  test("falls back to root when every Torph sublayer is hidden", () => {
    const rootRect = createRect({
      left: 20,
      top: 10,
      width: 30,
      height: 12,
    });

    assert.deepEqual(
      resolveGhostTraceVisibleLayer({
        root: createSnapshot({
          rect: rootRect,
        }),
        flowShell: createSnapshot({
          display: "none",
        }),
        flow: createSnapshot({
          display: "none",
        }),
        overlay: createSnapshot({
          display: "none",
        }),
        overlayLiveGlyphRect: null,
      }),
      {
        role: "root",
        rect: rootRect,
        rectSource: "root",
      },
    );
  });
});

describe("listConfigGhostTrace text visible rect", () => {
  test("prefers the Torph visible layer over the generic text rect", () => {
    const genericRect = createRect({
      left: 10,
      top: 20,
      width: 15,
      height: 7,
    });
    const torphRect = createRect({
      left: 12,
      top: 18,
      width: 15,
      height: 7,
    });

    assert.deepEqual(
      resolveGhostTraceElementTextVisibleRect({
        textVisibleRect: genericRect,
        textVisibleRectSource: "text-range-client-rects",
        torphVisibleLayerRect: torphRect,
        torphVisibleLayerRectSource: "overlay-live-glyphs",
      }),
      {
        rect: torphRect,
        rectSource: "torph:overlay-live-glyphs",
      },
    );
  });

  test("falls back to the generic text rect for non-Torph nodes", () => {
    const genericRect = createRect({
      left: 4,
      top: 5,
      width: 9,
      height: 6,
    });

    assert.deepEqual(
      resolveGhostTraceElementTextVisibleRect({
        textVisibleRect: genericRect,
        textVisibleRectSource: "text-range-client-rects",
        torphVisibleLayerRect: null,
        torphVisibleLayerRectSource: null,
      }),
      {
        rect: genericRect,
        rectSource: "text-range-client-rects",
      },
    );
  });
});
