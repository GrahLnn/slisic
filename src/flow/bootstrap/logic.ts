import type { WindowName } from "../../cmd";

export type AppBootstrapStatus = "pending" | "ready" | "error";
export type WindowRenderTarget = "template_board";

export interface AppWindowMeta {
  window: WindowName | null;
  label: string;
  isPrimaryWindow: boolean;
  isUserWindow: boolean;
  isPreparedWindow: boolean;
  status: AppBootstrapStatus;
}

export interface InteractiveShellState {
  kind: "fallback" | "resolved" | "prepared" | "blocked";
  showShell: boolean;
  showWindowControls: boolean;
  ownershipResolved: boolean;
}

export interface StartupReadySubscriptionState {
  tauriInternalsReady: boolean;
  currentWindowLabel: string | null | undefined;
}

interface WindowUiDescriptor {
  renderTarget: WindowRenderTarget | null;
  prewarmTarget: WindowName | null;
  runUpdaterOnPrimaryUserWindow: boolean;
}

const windowUiDescriptors: Record<WindowName, WindowUiDescriptor> = {
  Main: {
    renderTarget: "template_board",
    prewarmTarget: "Main",
    runUpdaterOnPrimaryUserWindow: true,
  },
  Support: {
    renderTarget: null,
    prewarmTarget: null,
    runUpdaterOnPrimaryUserWindow: false,
  },
};

const fallbackRenderTarget: WindowRenderTarget = "template_board";

export const initialAppWindowMeta: AppWindowMeta = {
  window: null,
  label: "",
  isPrimaryWindow: false,
  isUserWindow: true,
  isPreparedWindow: false,
  status: "pending",
};

function getWindowUiDescriptor(window: WindowName | null): WindowUiDescriptor | null {
  if (!window) {
    return null;
  }

  return windowUiDescriptors[window] ?? null;
}

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
      if (meta.isPreparedWindow) {
        return {
          kind: "prepared",
          showShell: true,
          showWindowControls: false,
          ownershipResolved: true,
        };
      }

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

export function resolveWindowRenderTarget(meta: AppWindowMeta): WindowRenderTarget | null {
  if (meta.status !== "ready") {
    return fallbackRenderTarget;
  }

  if (!meta.isUserWindow && !meta.isPreparedWindow) {
    return null;
  }

  return getWindowUiDescriptor(meta.window)?.renderTarget ?? null;
}

export function shouldRenderWindowContent(meta: AppWindowMeta): boolean {
  const shellState = getInteractiveShellState(meta);

  if (!shellState.showShell) {
    return false;
  }

  if (!shellState.ownershipResolved) {
    return fallbackRenderTarget !== null;
  }

  return resolveWindowRenderTarget(meta) !== null;
}

export function shouldRunUpdater(meta: AppWindowMeta): boolean {
  if (import.meta.env.DEV) {
    return false;
  }

  const descriptor = getWindowUiDescriptor(meta.window);
  return Boolean(
    descriptor?.runUpdaterOnPrimaryUserWindow &&
      meta.status === "ready" &&
      meta.isUserWindow &&
      meta.isPrimaryWindow,
  );
}

export function getWindowPrewarmTarget(meta: AppWindowMeta): WindowName | null {
  if (meta.status !== "ready" || !meta.isUserWindow || meta.isPreparedWindow) {
    return null;
  }

  return getWindowUiDescriptor(meta.window)?.prewarmTarget ?? null;
}

export function shouldRequestWindowPrewarm(meta: AppWindowMeta): boolean {
  return getWindowPrewarmTarget(meta) !== null;
}

export function shouldSubscribeToStartupReady(state: StartupReadySubscriptionState): boolean {
  return (
    state.tauriInternalsReady &&
    typeof state.currentWindowLabel === "string" &&
    state.currentWindowLabel.length > 0
  );
}
