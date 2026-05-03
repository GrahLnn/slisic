import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { installWaveformWheelTraceApi, recordWaveformWheelTrace } from "./waveformWheelTrace";

type TestWaveformWheelTraceWindow = {
  __waveformWheelTraceApi?: {
    clear: () => void;
    entries: () => Array<{ event: string; payload: Record<string, unknown> }>;
    mode: () => string;
    save: () => Promise<string | null>;
    setMode: (mode: "capture" | "observe-default" | "off") => void;
  };
  __waveformWheelTraceRuntime?: {
    api: {
      entries: () => Array<{ event: string; payload: Record<string, unknown> }>;
      save: () => Promise<string | null>;
    };
    cleanupGlobalProbe: () => void;
    ownerId: string;
    publicApi: {
      save: () => Promise<string | null>;
    };
  };
  addEventListener: (
    type: string,
    listener: (event: Event) => void,
    options?: AddEventListenerOptions | boolean,
  ) => void;
  document: {
    addEventListener: (
      type: string,
      listener: (event: Event) => void,
      options?: AddEventListenerOptions | boolean,
    ) => void;
    body: null;
    documentElement: null;
    removeEventListener: (
      type: string,
      listener: (event: Event) => void,
      options?: EventListenerOptions | boolean,
    ) => void;
  };
  location: {
    href: string;
  };
  performance: {
    now: () => number;
  };
  removeEventListener: (
    type: string,
    listener: (event: Event) => void,
    options?: EventListenerOptions | boolean,
  ) => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  queueMicrotask?: (callback: () => void) => void;
  saveWaveformWheelTrace?: () => Promise<string | null>;
  setWaveformWheelTraceMode?: (mode: "capture" | "observe-default" | "off") => void;
};

function readTraceRuntime(traceWindow: TestWaveformWheelTraceWindow) {
  return (traceWindow as TestWaveformWheelTraceWindow).__waveformWheelTraceRuntime;
}

function withTraceWindow<T>(run: (traceWindow: TestWaveformWheelTraceWindow) => T) {
  const globalWithWindow = globalThis as unknown as Record<string, unknown>;
  const hadWindow = Object.hasOwn(globalWithWindow, "window");
  const previousWindow = globalWithWindow.window;
  const traceWindow = {
    addEventListener: () => {},
    document: {
      addEventListener: () => {},
      body: null,
      documentElement: null,
      removeEventListener: () => {},
    },
    location: {
      href: "http://localhost/spectrum",
    },
    performance: {
      now: () => 12.5,
    },
    removeEventListener: () => {},
  } satisfies TestWaveformWheelTraceWindow;

  globalWithWindow.window = traceWindow;

  try {
    return run(traceWindow);
  } finally {
    if (!hadWindow) {
      Reflect.deleteProperty(globalWithWindow, "window");
    } else {
      globalWithWindow.window = previousWindow;
    }
  }
}

describe("waveformWheelTrace", () => {
  test("installs console commands as stable forwarders to the current runtime", () => {
    withTraceWindow((traceWindow) => {
      const cleanup = installWaveformWheelTraceApi("owner-a");
      const runtime = traceWindow.__waveformWheelTraceRuntime;
      const api = traceWindow.__waveformWheelTraceApi;

      assert.ok(runtime);
      assert.ok(api);
      assert.equal(traceWindow.saveWaveformWheelTrace, api.save);
      assert.notEqual(traceWindow.saveWaveformWheelTrace, runtime.api.save);

      api.clear();
      recordWaveformWheelTrace("probe", { ok: true });

      assert.deepEqual(
        api.entries().map((entry) => entry.event),
        ["probe"],
      );
      assert.deepEqual(
        runtime.api.entries().map((entry) => entry.event),
        ["probe"],
      );

      cleanup();
      assert.equal(traceWindow.__waveformWheelTraceRuntime, undefined);
      assert.equal(traceWindow.__waveformWheelTraceApi, undefined);
      assert.equal(traceWindow.saveWaveformWheelTrace, undefined);
    });
  });

  test("keeps newer trace runtime when an older owner cleanup runs", () => {
    withTraceWindow((traceWindow) => {
      const cleanupOldOwner = installWaveformWheelTraceApi("owner-a");
      const cleanupNewOwner = installWaveformWheelTraceApi("owner-b");

      cleanupOldOwner();

      assert.equal(traceWindow.__waveformWheelTraceRuntime?.ownerId, "owner-b");
      assert.equal(
        traceWindow.saveWaveformWheelTrace,
        traceWindow.__waveformWheelTraceRuntime?.publicApi.save,
      );

      cleanupNewOwner();
      assert.equal(traceWindow.__waveformWheelTraceRuntime, undefined);
      assert.equal(traceWindow.saveWaveformWheelTrace, undefined);
    });
  });

  test("keeps console commands installed when HMR disposes the current runtime", () => {
    withTraceWindow((traceWindow) => {
      installWaveformWheelTraceApi("owner-a");
      const runtime = traceWindow.__waveformWheelTraceRuntime;
      const api = traceWindow.__waveformWheelTraceApi;

      assert.ok(runtime);
      assert.ok(api);

      Reflect.deleteProperty(traceWindow, "__waveformWheelTraceRuntime");

      assert.equal(traceWindow.__waveformWheelTraceRuntime, undefined);
      assert.equal(traceWindow.__waveformWheelTraceApi, api);
      assert.equal(traceWindow.saveWaveformWheelTrace, api.save);
      assert.equal(api.mode(), "off");

      const cleanup = installWaveformWheelTraceApi("owner-b");

      const nextRuntime = readTraceRuntime(traceWindow);
      assert.ok(nextRuntime);
      assert.equal(nextRuntime.ownerId, "owner-b");
      assert.equal(traceWindow.__waveformWheelTraceApi, api);
      assert.equal(traceWindow.saveWaveformWheelTrace, api.save);

      cleanup();
    });
  });

  test("does not let old-runtime cleanup remove a newly installed runtime", () => {
    withTraceWindow((traceWindow) => {
      const cleanupOldRuntimeOwner = installWaveformWheelTraceApi("owner-a");
      const oldRuntime = traceWindow.__waveformWheelTraceRuntime;

      assert.ok(oldRuntime);
      Reflect.deleteProperty(oldRuntime, "moduleToken");

      cleanupOldRuntimeOwner();

      assert.equal(traceWindow.__waveformWheelTraceRuntime, oldRuntime);

      const cleanupNewRuntimeOwner = installWaveformWheelTraceApi("owner-b");
      cleanupOldRuntimeOwner();

      assert.equal(traceWindow.__waveformWheelTraceRuntime?.ownerId, "owner-b");

      cleanupNewRuntimeOwner();
    });
  });

  test("installs global wheel probe as observation-only listeners", () => {
    withTraceWindow((traceWindow) => {
      const listeners: Array<{
        options?: AddEventListenerOptions | boolean;
        type: string;
      }> = [];
      traceWindow.addEventListener = (type, _listener, options) => {
        listeners.push({ options, type });
      };
      traceWindow.document.addEventListener = (type, _listener, options) => {
        listeners.push({ options, type });
      };

      const cleanup = installWaveformWheelTraceApi("owner-a");

      assert.ok(
        listeners.some(
          (listener) =>
            listener.type === "wheel" &&
            typeof listener.options === "object" &&
            listener.options.passive === true,
        ),
      );
      assert.deepEqual(
        traceWindow.__waveformWheelTraceApi
          ?.entries()
          .some((entry) => entry.event === "global-wheel-probe-installed"),
        true,
      );

      cleanup();
    });
  });
});
