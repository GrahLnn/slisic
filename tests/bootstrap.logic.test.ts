import { describe, expect, test } from "bun:test";
import rsbuildConfig from "../rsbuild.config";
import { commands } from "../src/cmd/commands";
import {
  inferWindowNameFromLabel,
  normalizeWindowName,
  shouldRunUpdater,
  shouldShowWindowControls,
  toAppBootstrap,
  toCommandWindowName,
  type AppWindowMeta,
} from "../src/flow/bootstrap/logic";
import { getPlatform } from "../lib/utils";

function createMeta(overrides: Partial<AppWindowMeta> = {}): AppWindowMeta {
  return {
    window: null,
    label: "",
    isPrimaryWindow: false,
    isUserWindow: false,
    isPreparedWindow: false,
    status: "pending",
    ...overrides,
  };
}

function withDevValue<T>(value: boolean, run: () => T): T {
  const originalDev = import.meta.env.DEV;
  Object.defineProperty(import.meta.env, "DEV", {
    configurable: true,
    value,
  });

  try {
    return run();
  } finally {
    Object.defineProperty(import.meta.env, "DEV", {
      configurable: true,
      value: originalDev,
    });
  }
}

describe("inferWindowNameFromLabel", () => {
  test("recognizes visible and prepared main labels", () => {
    expect(inferWindowNameFromLabel("main")).toBe("main");
    expect(inferWindowNameFromLabel("main-2")).toBe("main");
    expect(inferWindowNameFromLabel("main-prewarm")).toBe("main");
    expect(inferWindowNameFromLabel("main-prewarm-2")).toBe("main");
  });

  test("recognizes visible and prepared support labels", () => {
    expect(inferWindowNameFromLabel("support")).toBe("support");
    expect(inferWindowNameFromLabel("support-2")).toBe("support");
    expect(inferWindowNameFromLabel("support-prewarm")).toBe("support");
    expect(inferWindowNameFromLabel("support-prewarm-2")).toBe("support");
  });

  test("rejects unknown labels", () => {
    expect(inferWindowNameFromLabel("unknown")).toBeNull();
    expect(inferWindowNameFromLabel("main-support")).toBeNull();
    expect(inferWindowNameFromLabel(null)).toBeNull();
  });
});

describe("window name adapters", () => {
  test("normalizes command window names for frontend matching", () => {
    expect(normalizeWindowName("Main")).toBe("main");
    expect(normalizeWindowName("Support")).toBe("support");
    expect(normalizeWindowName(null)).toBeNull();
  });

  test("converts frontend window names back to command names", () => {
    expect(toCommandWindowName("main")).toBe("Main");
    expect(toCommandWindowName("support")).toBe("Support");
  });
});

describe("shouldShowWindowControls", () => {
  test("shows controls only for ready visible user windows", () => {
    expect(
      shouldShowWindowControls(
        createMeta({
          status: "ready",
          window: "main",
          isUserWindow: true,
        }),
      ),
    ).toBe(true);

    expect(
      shouldShowWindowControls(
        createMeta({
          status: "ready",
          window: "main",
          isUserWindow: false,
        }),
      ),
    ).toBe(false);

    expect(
      shouldShowWindowControls(
        createMeta({
          status: "ready",
          window: "main",
          isUserWindow: true,
          isPreparedWindow: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("shouldRunUpdater", () => {
  test("runs only for the primary visible main window in production", () => {
    withDevValue(false, () => {
      expect(
        shouldRunUpdater(
          createMeta({
            status: "ready",
            window: "main",
            isPrimaryWindow: true,
            isUserWindow: true,
          }),
        ),
      ).toBe(true);

      expect(
        shouldRunUpdater(
          createMeta({
            status: "ready",
            window: "main",
            isPrimaryWindow: false,
            isUserWindow: true,
          }),
        ),
      ).toBe(false);

      expect(
        shouldRunUpdater(
          createMeta({
            status: "ready",
            window: "support",
            isPrimaryWindow: true,
            isUserWindow: true,
          }),
        ),
      ).toBe(false);

      expect(
        shouldRunUpdater(
          createMeta({
            status: "ready",
            window: "main",
            isPrimaryWindow: true,
            isUserWindow: false,
          }),
        ),
      ).toBe(false);
    });
  });

  test("never runs updater during development", () => {
    withDevValue(true, () => {
      expect(
        shouldRunUpdater(
          createMeta({
            status: "ready",
            window: "main",
            isPrimaryWindow: true,
            isUserWindow: true,
          }),
        ),
      ).toBe(false);
    });
  });
});

describe("toAppBootstrap", () => {
  test("exposes a matchable window with label-based fallback", () => {
    const app = toAppBootstrap(
      createMeta({
        label: "main-prewarm",
      }),
    );

    expect(app.label).toBe("main-prewarm");
    expect(app.status).toBe("pending");
    expect(
      app.window.match({
        main: () => "main",
        support: () => "support",
      }),
    ).toBe("main");
    expect(app.showWindowControls).toBe(false);
  });
});

describe("bootstrap commands", () => {
  test("renderer bootstrap ready command stays available for prepared-window handoff", () => {
    expect(typeof commands.recordRendererBootstrapReady).toBe("function");
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
});

describe("rsbuild react runtime defines", () => {
  test("defines process.env.NODE_ENV so browser React runtime does not read an undefined process global", () => {
    const definedNodeEnv =
      rsbuildConfig.source?.define?.["process.env.NODE_ENV"];

    expect(typeof definedNodeEnv).toBe("string");
    expect(JSON.parse(definedNodeEnv as string)).toBeString();
  });
});
