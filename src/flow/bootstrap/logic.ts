import type { WindowName } from "../../cmd";

export type AppBootstrapStatus = "pending" | "ready" | "error";

export interface AppWindowMeta {
  window: WindowName | null;
  label: string;
  isPrimaryMain: boolean;
  isUserWindow: boolean;
  status: AppBootstrapStatus;
}

export interface InteractiveShellState {
  kind: "fallback" | "resolved" | "blocked";
  showShell: boolean;
  showWindowControls: boolean;
  ownershipResolved: boolean;
}

export const initialAppWindowMeta: AppWindowMeta = {
  window: null,
  label: "",
  isPrimaryMain: false,
  isUserWindow: true,
  status: "pending",
};

export function getInteractiveShellState(meta: AppWindowMeta): InteractiveShellState {
  switch (meta.status) {
    case "pending":
    case "error":
      return {
        kind: "fallback",
        showShell: true,
        showWindowControls: false,
        ownershipResolved: false,
      };
    case "ready":
      if (!meta.isUserWindow) {
        return {
          kind: "blocked",
          showShell: false,
          showWindowControls: false,
          ownershipResolved: true,
        };
      }

      return {
        kind: "resolved",
        showShell: true,
        showWindowControls: true,
        ownershipResolved: true,
      };
  }
}

export function resolveMainRouteWindow(meta: AppWindowMeta): WindowName | null {
  if (meta.status !== "ready" || !meta.isUserWindow) {
    return null;
  }

  return meta.window === "Main" ? meta.window : null;
}

export function getHomepagePrewarmTarget(meta: AppWindowMeta): WindowName | null {
  if (!meta.isPrimaryMain) {
    return null;
  }

  return resolveMainRouteWindow(meta);
}

export function shouldRenderMainWindow(meta: AppWindowMeta): boolean {
  const shellState = getInteractiveShellState(meta);

  if (!shellState.showShell) {
    return false;
  }

  if (!shellState.ownershipResolved) {
    return true;
  }

  return resolveMainRouteWindow(meta) === "Main";
}

export function shouldRunUpdater(meta: AppWindowMeta): boolean {
  if (import.meta.env.DEV) {
    return false;
  }

  return meta.status === "ready" && meta.isUserWindow && meta.window === "Main" && meta.isPrimaryMain;
}

export function shouldRequestWindowPrewarm(meta: AppWindowMeta): boolean {
  return getHomepagePrewarmTarget(meta) !== null;
}
