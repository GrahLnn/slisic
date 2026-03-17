import { useEffect, useState } from "react";
import { crab } from "@/src/cmd";
import {
  canRenderApp,
  canStartApp,
  deriveBootstrapAppEntryState,
  type BootstrapAppEntryState,
  type BootstrapDecision,
  type BootstrapWindowState,
} from "./appEntryMachine";

export { canRenderApp, canStartApp } from "./appEntryMachine";

function stringifyReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useBootstrapDecision(): BootstrapDecision {
  const appEntryState = useBootstrapAppEntryState();
  return {
    shouldRenderApp: canRenderApp(appEntryState),
    shouldStartApp: canStartApp(appEntryState),
    isConfirmedPrewarm: appEntryState.status === "prewarm_blocked",
  };
}

export function useBootstrapAppEntryState(): BootstrapAppEntryState {
  const [windowState, setWindowState] = useState<BootstrapWindowState>({
    status: "pending",
  });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const info = await crab.getWindowKind();
        if (cancelled) {
          return;
        }
        setWindowState({ status: "resolved", info });
      } catch (error) {
        if (cancelled) {
          return;
        }

        const reason = stringifyReason(error);
        console.error("[bootstrap] getWindowKind failed:", reason);
        setWindowState({ status: "error", reason });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return deriveBootstrapAppEntryState(windowState);
}

