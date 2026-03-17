import { describe, expect, test } from "bun:test";

function loadMaximizedModule(caseId: string) {
  return import(`../src/flow/windowMaximized.ts?case=${caseId}`);
}

function loadFocusModule(caseId: string) {
  return import(`../src/flow/windowFocus.ts?case=${caseId}`);
}

function createTauriInternals(label: string) {
  return {
    metadata: {
      currentWindow: {
        label,
      },
    },
    invoke: async () => false,
    transformCallback: () => 0,
  };
}

describe("window ownership state", () => {
  test("maximize state actor binds to the current renderer window handle", async () => {
    const originalWindow = globalThis.window;
    const originalInternals = (originalWindow as (Window & {
      __TAURI_INTERNALS__?: {
        metadata?: {
          currentWindow?: {
            label?: string;
          };
        };
      };
    }) | undefined)?.__TAURI_INTERNALS__;

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ...(originalWindow ?? {}),
        __TAURI_INTERNALS__: createTauriInternals("main"),
      },
    });

    const firstLoad = await loadMaximizedModule("main-window");
    const firstActor = firstLoad.getWindowMaximizedActor("main");

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ...(globalThis.window ?? {}),
        __TAURI_INTERNALS__: createTauriInternals("main-1"),
      },
    });

    const secondLoad = await loadMaximizedModule("secondary-window");
    const secondActor = secondLoad.getWindowMaximizedActor("main-1");

    expect(firstActor).not.toBe(secondActor);
    expect(firstLoad.getWindowMaximizedActor("main")).toBe(firstActor);
    expect(secondLoad.getWindowMaximizedActor("main-1")).toBe(secondActor);

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });

    if (originalWindow && originalInternals) {
      (globalThis.window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = originalInternals;
    }
  });

  test("focus actor subscribes to the owning renderer window only", async () => {
    const originalWindow = globalThis.window;
    const originalInternals = (originalWindow as (Window & {
      __TAURI_INTERNALS__?: {
        metadata?: {
          currentWindow?: {
            label?: string;
          };
        };
      };
    }) | undefined)?.__TAURI_INTERNALS__;

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ...(originalWindow ?? {}),
        __TAURI_INTERNALS__: createTauriInternals("main"),
      },
    });

    const firstLoad = await loadFocusModule("main-focus");
    const firstActor = firstLoad.getWindowFocusActor("main");

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ...(globalThis.window ?? {}),
        __TAURI_INTERNALS__: createTauriInternals("main-1"),
      },
    });

    const secondLoad = await loadFocusModule("secondary-focus");
    const secondActor = secondLoad.getWindowFocusActor("main-1");

    expect(firstActor).not.toBe(secondActor);
    expect(firstLoad.getWindowFocusActor("main")).toBe(firstActor);
    expect(secondLoad.getWindowFocusActor("main-1")).toBe(secondActor);

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });

    if (originalWindow && originalInternals) {
      (globalThis.window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = originalInternals;
    }
  });
});
