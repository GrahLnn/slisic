import { useEffect, useState } from "react";
import { type WindowKindInfo, type WindowName, crab } from "../../cmd";
import { action as templateAction } from "../template_board";
import {
  action as updaterAction,
  ensureStarted as ensureUpdaterStarted,
} from "../updater";

export interface AppWindowMeta {
  window: WindowName | null;
  isPrewarm: boolean;
  label: string;
  isPrimaryMain: boolean;
}

export function useAppBootstrap(): AppWindowMeta {
  const [appWindow, setAppWindow] = useState<AppWindowMeta>({
    window: null,
    isPrewarm: false,
    label: "",
    isPrimaryMain: false,
  });

  useEffect(() => {
    void crab.appReady();
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
        };
        setAppWindow(nextWindow);

        if (nextWindow.window === "Main" && nextWindow.isPrimaryMain) {
          ensureUpdaterStarted();
          updaterAction.run();
        }
      })
      .catch(() => {
        if (disposed) {
          return;
        }
        setAppWindow({
          window: null,
          isPrewarm: false,
          label: "",
          isPrimaryMain: false,
        });
      });

    return () => {
      disposed = true;
    };
  }, []);

  return appWindow;
}
