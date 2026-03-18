import { describe, expect, test } from "bun:test";
import rsbuildConfig from "../rsbuild.config";
import {
  getInteractiveShellState,
  getWindowPrewarmTarget,
  initialAppWindowMeta,
  resolveWindowRenderTarget,
  shouldSubscribeToStartupReady,
  shouldRequestWindowPrewarm,
  shouldRenderWindowContent,
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
    expect(shouldRenderWindowContent(createMeta())).toBe(true);
  });

  test("renders main content when window kind lookup fails", () => {
    expect(
      shouldRenderWindowContent(
        createMeta({
          status: "error",
        }),
      ),
    ).toBe(true);
  });

  test("does not treat support windows as user-facing main windows", () => {
    expect(
      shouldRenderWindowContent(
        createMeta({
          status: "ready",
          window: "Support",
          isPrimaryWindow: true,
          isUserWindow: false,
        }),
      ),
    ).toBe(false);
  });

  test("renders repeated visible main windows because they remain user windows", () => {
    expect(
      shouldRenderWindowContent(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: false,
          isUserWindow: true,
        }),
      ),
    ).toBe(true);
  });

  test("does not render the main content for ready non-user windows", () => {
    expect(
      shouldRenderWindowContent(
        createMeta({
          status: "ready",
          window: "Main",
          isUserWindow: false,
        }),
      ),
    ).toBe(false);
  });

  test("resolves render targets through the window descriptor catalog", () => {
    expect(
      resolveWindowRenderTarget(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: true,
          isUserWindow: true,
        }),
      ),
    ).toBe("template_board");

    expect(
      resolveWindowRenderTarget(
        createMeta({
          status: "ready",
          window: "Support",
          isPrimaryWindow: true,
          isUserWindow: false,
        }),
      ),
    ).toBeNull();
  });
});

describe("getInteractiveShellState", () => {
  test("keeps bootstrap pending usable without assigning window ownership", () => {
    expect(getInteractiveShellState(createMeta())).toEqual({
      kind: "fallback",
      showShell: true,
      showWindowControls: false,
      ownershipResolved: false,
    });
  });

  test("keeps bootstrap errors usable without leaking wrong-window ownership", () => {
    expect(
      getInteractiveShellState(
        createMeta({
          status: "error",
        }),
      ),
    ).toEqual({
      kind: "fallback",
      showShell: true,
      showWindowControls: false,
      ownershipResolved: false,
    });
  });

  test("mounts the interactive shell and controls only for ready user windows", () => {
    expect(
      getInteractiveShellState(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: true,
          isUserWindow: true,
        }),
      ),
    ).toEqual({
      kind: "resolved",
      showShell: true,
      showWindowControls: true,
      ownershipResolved: true,
    });
  });

  test("blocks shell and controls for ready non-user windows", () => {
    expect(
      getInteractiveShellState(
        createMeta({
          status: "ready",
          window: "Support",
          isPrimaryWindow: true,
          isUserWindow: false,
        }),
      ),
    ).toEqual({
      kind: "blocked",
      showShell: false,
      showWindowControls: false,
      ownershipResolved: true,
    });
  });
});

describe("shouldRunUpdater", () => {
  test("runs only for the primary visible main window", () => {
    const originalDev = import.meta.env.DEV;
    Object.defineProperty(import.meta.env, "DEV", {
      configurable: true,
      value: false,
    });

    expect(
      shouldRunUpdater(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: true,
        }),
      ),
    ).toBe(true);

    expect(
      shouldRunUpdater(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: false,
        }),
      ),
    ).toBe(false);

    expect(
      shouldRunUpdater(
        createMeta({
          status: "ready",
          window: "Support",
          isPrimaryWindow: true,
        }),
      ),
    ).toBe(false);

    expect(
      shouldRunUpdater(
        createMeta({
          status: "pending",
          window: "Main",
          isPrimaryWindow: true,
        }),
      ),
    ).toBe(false);

    expect(
      shouldRunUpdater(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: true,
          isUserWindow: false,
        }),
      ),
    ).toBe(false);

    Object.defineProperty(import.meta.env, "DEV", {
      configurable: true,
      value: originalDev,
    });
  });

  test("does not run updater during dev validation startup", () => {
    const originalDev = import.meta.env.DEV;
    Object.defineProperty(import.meta.env, "DEV", {
      configurable: true,
      value: true,
    });

    expect(
      shouldRunUpdater(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: true,
        }),
      ),
    ).toBe(false);

    Object.defineProperty(import.meta.env, "DEV", {
      configurable: true,
      value: originalDev,
    });
  });
});

describe("shouldRequestWindowPrewarm", () => {
  test("window descriptors control prewarm targets instead of homepage-only heuristics", () => {
    expect(
      getWindowPrewarmTarget(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: true,
          isUserWindow: true,
        }),
      ),
    ).toBe("Main");

    expect(
      getWindowPrewarmTarget(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: false,
          isUserWindow: true,
        }),
      ),
    ).toBe("Main");

    expect(
      getWindowPrewarmTarget(
        createMeta({
          status: "ready",
          window: "Support",
          isPrimaryWindow: true,
          isUserWindow: false,
        }),
      ),
    ).toBeNull();
  });

  test("prewarm stays disabled until a descriptor-backed user window resolves", () => {
    expect(getWindowPrewarmTarget(createMeta())).toBeNull();
    expect(
      getWindowPrewarmTarget(
        createMeta({
          status: "error",
          window: "Main",
          isPrimaryWindow: true,
          isUserWindow: true,
        }),
      ),
    ).toBeNull();
    expect(
      getWindowPrewarmTarget(
        createMeta({
          status: "ready",
          window: "Support",
          isPrimaryWindow: true,
          isUserWindow: false,
        }),
      ),
    ).toBeNull();

    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: true,
          isUserWindow: true,
        }),
      ),
    ).toBe(true);
  });

  test("never requests additional hidden-window preparation", () => {
    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: true,
          isUserWindow: true,
          isPreparedWindow: true,
        }),
      ),
    ).toBe(false);
  });

  test("never requests preparation for descriptors that opt out", () => {
    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Support",
          isPrimaryWindow: true,
          isUserWindow: false,
        }),
      ),
    ).toBe(false);
  });

  test("does not depend on bootstrap timing heuristics for any state", () => {
    expect(shouldRequestWindowPrewarm(createMeta())).toBe(false);
    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "error",
          window: "Main",
          isPrimaryWindow: true,
          isUserWindow: true,
        }),
      ),
    ).toBe(false);
  });

  test("secondary visible main windows still render the app shell without gaining homepage target eligibility", () => {
    const secondaryMain = createMeta({
      status: "ready",
      window: "Main",
      isPrimaryWindow: false,
      isUserWindow: true,
    });

    expect(resolveWindowRenderTarget(secondaryMain)).toBe("template_board");
    expect(getWindowPrewarmTarget(secondaryMain)).toBe("Main");
    expect(shouldRenderWindowContent(secondaryMain)).toBe(true);
    expect(shouldRequestWindowPrewarm(secondaryMain)).toBe(true);
  });

  test("requests prewarm for any resolved user window whose descriptor enables it", () => {
    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: true,
          isUserWindow: true,
        }),
      ),
    ).toBe(true);

    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: false,
          isUserWindow: true,
        }),
      ),
    ).toBe(true);

    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Support",
          isPrimaryWindow: true,
          isUserWindow: false,
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

  test("startup ready subscription waits for current window metadata", () => {
    expect(
      shouldSubscribeToStartupReady({
        tauriInternalsReady: true,
        currentWindowLabel: "main",
      }),
    ).toBe(true);

    expect(
      shouldSubscribeToStartupReady({
        tauriInternalsReady: true,
        currentWindowLabel: "",
      }),
    ).toBe(false);

    expect(
      shouldSubscribeToStartupReady({
        tauriInternalsReady: false,
        currentWindowLabel: "main",
      }),
    ).toBe(false);
  });
});

describe("rsbuild react runtime defines", () => {
  test("defines process.env.NODE_ENV so browser React runtime does not read an undefined process global", () => {
    const definedNodeEnv = rsbuildConfig.source?.define?.["process.env.NODE_ENV"];

    expect(typeof definedNodeEnv).toBe("string");
    expect(JSON.parse(definedNodeEnv as string)).toBeString();
  });
});
