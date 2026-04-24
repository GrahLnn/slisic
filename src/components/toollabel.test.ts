import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveToolLabelOverlayVisibility,
  resolveToolLabelHoverFromPointerProbe,
  resolveToolLabelPlainTextClassName,
} from "./toollabel";

describe("ToolLabel overlay visibility", () => {
  test("shows the overlay only when hovered and enabled", () => {
    assert.equal(
      resolveToolLabelOverlayVisibility({
        isHovered: true,
        hasTool: true,
        interactionDisabled: false,
      }),
      true,
    );
  });

  test("hides the overlay while interaction is disabled", () => {
    assert.equal(
      resolveToolLabelOverlayVisibility({
        isHovered: true,
        hasTool: true,
        interactionDisabled: true,
      }),
      false,
    );
  });

  test("hides the overlay when no tool content exists", () => {
    assert.equal(
      resolveToolLabelOverlayVisibility({
        isHovered: true,
        hasTool: false,
        interactionDisabled: false,
      }),
      false,
    );
  });

  test("uses the same canonical line-height wrapper for plain text rendering", () => {
    assert.equal(resolveToolLabelPlainTextClassName(), "inline-block leading-[18px]");
  });

  test("actively probes the pointer against geometry when the label moved under a stationary cursor", () => {
    const hoverTarget = {
      ownerDocument: {
        elementsFromPoint: () => [],
      },
      contains: () => false,
      getBoundingClientRect: () => ({
        left: 100,
        top: 50,
        right: 220,
        bottom: 74,
      }),
    } as unknown as HTMLElement;

    assert.equal(
      resolveToolLabelHoverFromPointerProbe({
        interactionDisabled: false,
        hasTool: true,
        pointerPosition: {
          clientX: 110,
          clientY: 60,
        },
        hoverTarget,
        overlay: null,
      }),
      true,
    );
  });

  test("does not reopen the overlay when interaction stays disabled", () => {
    const hoverTarget = {
      ownerDocument: {
        elementsFromPoint: () => [],
      },
      contains: () => false,
      getBoundingClientRect: () => ({
        left: 100,
        top: 50,
        right: 220,
        bottom: 74,
      }),
    } as unknown as HTMLElement;

    assert.equal(
      resolveToolLabelHoverFromPointerProbe({
        interactionDisabled: true,
        hasTool: true,
        pointerPosition: {
          clientX: 110,
          clientY: 60,
        },
        hoverTarget,
        overlay: null,
      }),
      false,
    );
  });
});
