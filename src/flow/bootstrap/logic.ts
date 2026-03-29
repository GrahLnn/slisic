import { me, type ME } from "@grahlnn/fn";
import type { WindowName as CmdWindowName } from "../../cmd";

export type AppBootstrapStatus = "pending" | "ready" | "error";
export type WindowName = Lowercase<CmdWindowName>;

export interface AppWindowMeta {
  window: WindowName | null;
  label: string;
  isPrimaryWindow: boolean;
  isUserWindow: boolean;
  isPreparedWindow: boolean;
  status: AppBootstrapStatus;
}

export interface AppBootstrap {
  window: ME<WindowName>;
  label: string;
  status: AppBootstrapStatus;
  showWindowControls: boolean;
}

const fallbackWindowName: WindowName = "main";

function readCurrentRendererWindowLabel(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const tauriWindow = window as typeof window & {
    __TAURI_INTERNALS__?: {
      metadata?: {
        currentWindow?: {
          label?: string;
        };
      };
    };
  };

  return (
    tauriWindow.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null
  );
}

export function inferWindowNameFromLabel(
  label: string | null | undefined,
): WindowName | null {
  if (!label) {
    return null;
  }

  if (
    label === "main" ||
    /^main-\d+$/.test(label) ||
    label === "main-prewarm" ||
    /^main-prewarm-\d+$/.test(label)
  ) {
    return "main";
  }

  if (
    label === "support" ||
    /^support-\d+$/.test(label) ||
    label === "support-prewarm" ||
    /^support-prewarm-\d+$/.test(label)
  ) {
    return "support";
  }

  return null;
}

export function createInitialAppWindowMeta(): AppWindowMeta {
  const label = readCurrentRendererWindowLabel();

  return {
    window: inferWindowNameFromLabel(label),
    label: label ?? "",
    isPrimaryWindow: false,
    isUserWindow: false,
    isPreparedWindow: false,
    status: "pending",
  };
}

export function normalizeWindowName(
  window: CmdWindowName | null | undefined,
): WindowName | null {
  if (!window) {
    return null;
  }

  return me(window).match({
    Main: () => "main",
    Support: () => "support",
  });
}

export function toCommandWindowName(window: WindowName): CmdWindowName {
  return me(window).match({
    main: () => "Main",
    support: () => "Support",
  });
}

function resolveWindowForMatch(meta: AppWindowMeta): WindowName {
  return (
    meta.window ?? inferWindowNameFromLabel(meta.label) ?? fallbackWindowName
  );
}

export function shouldShowWindowControls(meta: AppWindowMeta): boolean {
  return meta.status === "ready" && meta.isUserWindow && !meta.isPreparedWindow;
}

export function shouldRunUpdater(meta: AppWindowMeta): boolean {
  if (import.meta.env.DEV) {
    return false;
  }

  return (
    meta.status === "ready" &&
    meta.window === "main" &&
    meta.isUserWindow &&
    meta.isPrimaryWindow
  );
}

export function toAppBootstrap(meta: AppWindowMeta): AppBootstrap {
  return {
    window: me(resolveWindowForMatch(meta)),
    label: meta.label,
    status: meta.status,
    showWindowControls: shouldShowWindowControls(meta),
  };
}
