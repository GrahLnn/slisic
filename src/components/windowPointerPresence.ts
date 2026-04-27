import { useEffect, useState } from "react";
import type { MouseWindowInfo } from "@/src/cmd";

const WINDOW_POINTER_POLL_INTERVAL_MS = 120;

let commandAdapterPromise: Promise<typeof import("@/src/cmd")> | null = null;

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function loadCommandAdapter() {
  commandAdapterPromise ??= import("@/src/cmd");

  return commandAdapterPromise;
}

export function resolveWindowPointerPresence(info: MouseWindowInfo) {
  return (
    info.rel_x >= 0 &&
    info.rel_y >= 0 &&
    info.rel_x <= info.window_width &&
    info.rel_y <= info.window_height
  );
}

export function useWindowPointerPresence(enabled: boolean) {
  const [isPointerInsideWindow, setIsPointerInsideWindow] = useState(false);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setIsPointerInsideWindow(false);
      return;
    }

    let cancelled = false;
    let pollTimeout: number | null = null;

    const syncFromNativePointerPosition = async () => {
      if (!hasTauriRuntime()) {
        return;
      }

      try {
        const { crab } = await loadCommandAdapter();
        const result = await crab.getMouseAndWindowPosition();

        result.match({
          Ok: (info) => {
            if (!cancelled) {
              setIsPointerInsideWindow(resolveWindowPointerPresence(info));
            }
          },
          Err: () => undefined,
        });
      } catch {
        // Native pointer lookup is a supplement to DOM events; failures should
        // not make the visual state noisy in browser-like environments.
      }
    };

    const scheduleNativePointerPoll = () => {
      if (!hasTauriRuntime()) {
        return;
      }

      pollTimeout = window.setTimeout(() => {
        pollTimeout = null;
        void syncFromNativePointerPosition().finally(() => {
          if (!cancelled) {
            scheduleNativePointerPoll();
          }
        });
      }, WINDOW_POINTER_POLL_INTERVAL_MS);
    };

    const handlePointerInside = () => {
      setIsPointerInsideWindow(true);
    };
    const handlePointerOutside = () => {
      setIsPointerInsideWindow(false);
    };
    const handleWindowBlur = () => {
      void syncFromNativePointerPosition();
    };

    document.addEventListener("pointerover", handlePointerInside);
    document.addEventListener("pointerleave", handlePointerOutside);
    window.addEventListener("blur", handleWindowBlur);

    void syncFromNativePointerPosition();
    scheduleNativePointerPoll();

    return () => {
      cancelled = true;
      document.removeEventListener("pointerover", handlePointerInside);
      document.removeEventListener("pointerleave", handlePointerOutside);
      window.removeEventListener("blur", handleWindowBlur);
      if (pollTimeout !== null) {
        window.clearTimeout(pollTimeout);
      }
    };
  }, [enabled]);

  return isPointerInsideWindow;
}
