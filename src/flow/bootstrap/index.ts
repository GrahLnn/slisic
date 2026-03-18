import { useEffect, useState } from "react";
import { crab } from "../../cmd";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  action as templateAction,
  ensureStarted as ensureTemplateStarted,
} from "../template_board";
import { action as updaterAction, ensureStarted as ensureUpdaterStarted } from "../updater";
import { initialAppWindowMeta, shouldRunUpdater, type AppWindowMeta } from "./logic";

const windowKindChangedEvent = "factory://window-kind-changed";

export function useAppBootstrap(): AppWindowMeta {
  const [appWindow, setAppWindow] = useState<AppWindowMeta>(initialAppWindowMeta);

  useEffect(() => {
    void crab.appReady();
    ensureTemplateStarted();
    templateAction.run();

    let disposed = false;
    let didRecordBootstrapReady = false;

    const resolveWindowKind = async (source: "initial" | "event") => {
      try {
        const windowKind = await crab.getWindowKind();
        if (disposed) {
          return;
        }

        const nextWindow: AppWindowMeta = {
          window: windowKind.window,
          label: windowKind.label,
          isPrimaryMain: windowKind.is_primary_main,
          isUserWindow: windowKind.is_user_window,
          isPreparedWindow: windowKind.is_prepared_window,
          status: "ready",
        };
        setAppWindow(nextWindow);

        if (!didRecordBootstrapReady) {
          didRecordBootstrapReady = true;
          void crab.recordRendererBootstrapReady().catch((error) => {
            console.error("Failed to record renderer bootstrap ready", error);
          });
        }

        if (source === "initial" && shouldRunUpdater(nextWindow)) {
          ensureUpdaterStarted();
          updaterAction.run();
        }
      } catch (error) {
        if (disposed) {
          return;
        }
        console.error("Failed to resolve window kind", error);
        setAppWindow({
          ...initialAppWindowMeta,
          status: "error",
        });
      }
    };

    void resolveWindowKind("initial");

    let unlistenWindowKindChanged: null | (() => void) = null;
    void getCurrentWindow()
      .listen(windowKindChangedEvent, () => {
        void resolveWindowKind("event");
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenWindowKindChanged = unlisten;
      })
      .catch((error) => {
        console.error("Failed to subscribe to window kind changes", error);
      });

    return () => {
      disposed = true;
      unlistenWindowKindChanged?.();
    };
  }, []);

  return appWindow;
}
