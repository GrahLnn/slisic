import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveToolLabelHoverLeaseFromPointerProbe,
  resolveToolLabelOverlayVisibility,
  type ToolLabelHoverProbeElement,
} from "./toolLabelHoverLease";

function createProbeElement(args: {
  rect: DOMRectReadOnly;
  hitElements?: Element[];
  contains?: (target: Element) => boolean;
}): ToolLabelHoverProbeElement {
  return {
    ownerDocument: {
      elementsFromPoint: () => args.hitElements ?? [],
    },
    contains: args.contains ?? (() => false),
    getBoundingClientRect: () => args.rect,
  };
}

describe("ToolLabel hover lease", () => {
  test("shows the overlay only when the lease is open and interaction is enabled", () => {
    assert.equal(
      resolveToolLabelOverlayVisibility({
        lease: {
          kind: "open",
          source: "target",
        },
        hasTool: true,
        interactionDisabled: false,
      }),
      true,
    );
  });

  test("hides the overlay while interaction is disabled", () => {
    assert.equal(
      resolveToolLabelOverlayVisibility({
        lease: {
          kind: "open",
          source: "target",
        },
        hasTool: true,
        interactionDisabled: true,
      }),
      false,
    );
  });

  test("hides the overlay when no tool content exists", () => {
    assert.equal(
      resolveToolLabelOverlayVisibility({
        lease: {
          kind: "open",
          source: "target",
        },
        hasTool: false,
        interactionDisabled: false,
      }),
      false,
    );
  });

  test("actively probes the pointer against geometry when the label moved under a stationary cursor", () => {
    const hoverTarget = createProbeElement({
      rect: {
        left: 100,
        top: 50,
        right: 220,
        bottom: 74,
      } as DOMRectReadOnly,
    });

    assert.deepEqual(
      resolveToolLabelHoverLeaseFromPointerProbe({
        interactionDisabled: false,
        hasTool: true,
        pointerPosition: {
          clientX: 110,
          clientY: 60,
        },
        hoverTarget,
        overlay: null,
      }),
      {
        kind: "open",
        source: "geometry",
      },
    );
  });

  test("does not reopen the overlay when interaction stays disabled", () => {
    const hoverTarget = createProbeElement({
      rect: {
        left: 100,
        top: 50,
        right: 220,
        bottom: 74,
      } as DOMRectReadOnly,
    });

    assert.deepEqual(
      resolveToolLabelHoverLeaseFromPointerProbe({
        interactionDisabled: true,
        hasTool: true,
        pointerPosition: {
          clientX: 110,
          clientY: 60,
        },
        hoverTarget,
        overlay: null,
      }),
      {
        kind: "closed",
        reason: "disabled",
      },
    );
  });

  test("closes the overlay when scroll moves the label away from a stationary pointer", () => {
    const hoverTarget = createProbeElement({
      rect: {
        left: 100,
        top: -80,
        right: 220,
        bottom: -56,
      } as DOMRectReadOnly,
    });

    assert.deepEqual(
      resolveToolLabelHoverLeaseFromPointerProbe({
        interactionDisabled: false,
        hasTool: true,
        pointerPosition: {
          clientX: 110,
          clientY: 60,
        },
        hoverTarget,
        overlay: null,
      }),
      {
        kind: "closed",
        reason: "outside",
      },
    );
  });

  test("opens the new label when scrolling places it under existing pointer evidence", () => {
    const hoverTarget = createProbeElement({
      rect: {
        left: 100,
        top: 50,
        right: 220,
        bottom: 74,
      } as DOMRectReadOnly,
    });

    assert.deepEqual(
      resolveToolLabelHoverLeaseFromPointerProbe({
        interactionDisabled: false,
        hasTool: true,
        pointerPosition: {
          clientX: 110,
          clientY: 60,
        },
        hoverTarget,
        overlay: null,
      }),
      {
        kind: "open",
        source: "geometry",
      },
    );
  });
});
