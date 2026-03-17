import { describe, expect, test } from "bun:test";
import {
  initialAppWindowMeta,
  shouldRequestWindowPrewarm,
  shouldRenderMainWindow,
  shouldRunUpdater,
  type AppWindowMeta,
} from "../src/flow/bootstrap/logic";
import { getPlatform } from "../lib/utils";

const startupReadyEvent = "factory://startup-ready";

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
          isUserWindow: false,
        }),
      ),
    ).toBe(false);
  });

  test("renders repeated visible main windows because they remain user windows", () => {
    expect(
      shouldRenderMainWindow(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryMain: false,
          isUserWindow: true,
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

    expect(
      shouldRunUpdater(
        createMeta({
          status: "pending",
          window: "Main",
          isPrimaryMain: true,
        }),
      ),
    ).toBe(false);

    expect(
      shouldRunUpdater(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryMain: true,
          isUserWindow: false,
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

describe("getPlatform", () => {
  test("falls back to user agent when Tauri OS internals are not ready yet", () => {
    const originalNavigator = globalThis.navigator;
    const originalWindow = globalThis.window;
    const windowStub = (originalWindow ?? {}) as typeof window & {
      __TAURI_OS_PLUGIN_INTERNALS__?: { platform?: string };
    };
    const originalInternals = windowStub.__TAURI_OS_PLUGIN_INTERNALS__;

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: windowStub,
    });

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    });

    delete windowStub.__TAURI_OS_PLUGIN_INTERNALS__;

    expect(getPlatform()).toBe("windows");

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });

    if (originalInternals) {
      windowStub.__TAURI_OS_PLUGIN_INTERNALS__ = originalInternals;
    }
  });

  test("returns unknown when neither Tauri internals nor navigator hints are available", () => {
    const originalNavigator = globalThis.navigator;
    const originalWindow = globalThis.window;
    const windowStub = (originalWindow ?? {}) as typeof window & {
      __TAURI_OS_PLUGIN_INTERNALS__?: { platform?: string };
    };
    const originalInternals = windowStub.__TAURI_OS_PLUGIN_INTERNALS__;

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: windowStub,
    });

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        userAgent: "",
      },
    });

    delete windowStub.__TAURI_OS_PLUGIN_INTERNALS__;

    expect(getPlatform()).toBe("unknown");

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });

    if (originalInternals) {
      windowStub.__TAURI_OS_PLUGIN_INTERNALS__ = originalInternals;
    }
  });

  test("startup ready event name stays stable for native and renderer startup tracing", () => {
    expect(startupReadyEvent).toBe("factory://startup-ready");
  });
});
