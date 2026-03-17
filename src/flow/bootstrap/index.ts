import { useEffect, useState } from "react";
import { crab } from "../../cmd";
import {
  action as templateAction,
  ensureStarted as ensureTemplateStarted,
} from "../template_board";
import { action as updaterAction, ensureStarted as ensureUpdaterStarted } from "../updater";
import {
  initialAppWindowMeta,
  shouldRunUpdater,
  type AppWindowMeta,
} from "./logic";

export function useAppBootstrap(): AppWindowMeta {
  const [appWindow, setAppWindow] = useState<AppWindowMeta>(initialAppWindowMeta);

  useEffect(() => {
    void crab.appReady();
    ensureTemplateStarted();
    templateAction.run();

    let disposed = false;
    void crab
      .getWindowKind()
      .then((windowKind) => {
        if (disposed) {
          return;
        }

        const nextWindow: AppWindowMeta = {
          window: windowKind.window,
          isPrewarm: windowKind.is_prewarm,
          label: windowKind.label,
          isPrimaryMain: windowKind.is_primary_main,
          status: "ready",
        };
        setAppWindow(nextWindow);

        if (shouldRunUpdater(nextWindow)) {
          ensureUpdaterStarted();
          updaterAction.run();
        }
      })
      .catch((error) => {
        if (disposed) {
          return;
        }
        console.error("Failed to resolve window kind", error);
        setAppWindow({
          ...initialAppWindowMeta,
          status: "error",
        });
      });

    return () => {
      disposed = true;
    };
  }, []);

  return appWindow;
}
