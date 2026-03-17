import { describe, expect, test } from "bun:test";
import {
  initialAppWindowMeta,
  shouldRequestWindowPrewarm,
  shouldRenderMainWindow,
  shouldRunUpdater,
  type AppWindowMeta,
} from "../src/flow/bootstrap/logic";

function createMeta(overrides: Partial<AppWindowMeta> = {}): AppWindowMeta {
  return {
    ...initialAppWindowMeta,
    ...overrides,
  };
}

describe("shouldRenderMainWindow", () => {
  test("renders main content while bootstrap is still pending", () => {
    expect(shouldRenderMainWindow(createMeta())).toBe(true);
  });

  test("renders main content when window kind lookup fails", () => {
    expect(
      shouldRenderMainWindow(
        createMeta({
          status: "error",
        }),
      ),
    ).toBe(true);
  });

  test("does not treat support windows as user-facing main windows", () => {
    expect(
      shouldRenderMainWindow(
        createMeta({
          status: "ready",
          window: null,
        }),
      ),
    ).toBe(true);
  });
});

describe("shouldRunUpdater", () => {
  test("runs only for the primary visible main window", () => {
    expect(
      shouldRunUpdater(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryMain: true,
        }),
      ),
    ).toBe(true);

    expect(
      shouldRunUpdater(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryMain: false,
        }),
      ),
    ).toBe(false);

    expect(
      shouldRunUpdater(
        createMeta({
          status: "ready",
          window: null,
          isPrimaryMain: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("shouldRequestWindowPrewarm", () => {
  test("never requests additional hidden-window preparation", () => {
    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Main",
        }),
      ),
    ).toBe(false);

    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: null,
        }),
      ),
    ).toBe(false);
  });
});
