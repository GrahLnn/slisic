import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveToolLabelOverlayVisibility,
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
});
