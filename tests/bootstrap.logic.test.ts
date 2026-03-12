import { describe, expect, test } from "bun:test";
import {
  initialAppWindowMeta,
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

  test("still renders prewarm windows that are shown as main windows", () => {
    expect(
      shouldRenderMainWindow(
        createMeta({
          status: "ready",
          window: "Main",
          isPrewarm: true,
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
  });
});
