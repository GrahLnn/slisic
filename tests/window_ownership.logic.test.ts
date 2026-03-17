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

function createWindowEventHarness(baseWindow: Window | undefined) {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const tauriUnlistenCalls: Array<{ event: string; eventId: number }> = [];

  const addEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
    const existing = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    existing.add(listener);
    listeners.set(type, existing);
  };

  const removeEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
    listeners.get(type)?.delete(listener);
  };

  const dispatch = (type: string) => {
    const event = { type } as Event;
    for (const listener of listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener(event);
        continue;
      }

      listener.handleEvent(event);
    }
  };

  return {
    value: {
      ...(baseWindow ?? {}),
      addEventListener,
      removeEventListener,
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (event: string, eventId: number) => {
          tauriUnlistenCalls.push({ event, eventId });
        },
      },
    },
    dispatch,
    tauriUnlistenCalls,
  };
}

function restoreWindow(originalWindow: Window | undefined, originalInternals: unknown) {
  const restoredWindow = originalWindow ?? createWindowEventHarness(undefined).value;
  if (!(restoredWindow as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    (restoredWindow as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = createTauriInternals("main");
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: restoredWindow,
  });

  if (restoredWindow && originalInternals) {
    (globalThis.window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = originalInternals;
  }
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

    restoreWindow(originalWindow, originalInternals);
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

    restoreWindow(originalWindow, originalInternals);
  });

  test("same-label reopen refreshes maximize and focus ownership instead of reusing a stale actor", async () => {
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

    const firstHarness = createWindowEventHarness(originalWindow);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ...firstHarness.value,
        __TAURI_INTERNALS__: createTauriInternals("main-1"),
      },
    });

    const firstMaximizedLoad = await loadMaximizedModule("reopen-maximize-first");
    const firstFocusLoad = await loadFocusModule("reopen-focus-first");
    const firstMaximizedActor = firstMaximizedLoad.getWindowMaximizedActor("main-1");
    const firstFocusActor = firstFocusLoad.getWindowFocusActor("main-1");

    firstMaximizedLoad.releaseWindowMaximizedActor("main-1");
    firstFocusLoad.releaseWindowFocusActor("main-1");

    const secondHarness = createWindowEventHarness(originalWindow);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ...secondHarness.value,
        __TAURI_INTERNALS__: createTauriInternals("main-1"),
      },
    });

    const reopenedMaximizedActor = firstMaximizedLoad.getWindowMaximizedActor("main-1");
    const reopenedFocusActor = firstFocusLoad.getWindowFocusActor("main-1");

    expect(reopenedMaximizedActor).not.toBe(firstMaximizedActor);
    expect(reopenedFocusActor).not.toBe(firstFocusActor);

    firstHarness.dispatch("blur");
    expect(reopenedFocusActor.getSnapshot().matches(firstFocusLoad.state.x.focused)).toBeTrue();

    secondHarness.dispatch("blur");
    expect(reopenedFocusActor.getSnapshot().matches(firstFocusLoad.state.x.blurred)).toBeTrue();

    firstMaximizedLoad.releaseWindowMaximizedActor("main-1");
    firstFocusLoad.releaseWindowFocusActor("main-1");

    restoreWindow(originalWindow, originalInternals);
  });
});
