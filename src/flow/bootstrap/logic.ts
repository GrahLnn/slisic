import type { WindowName } from "../../cmd";

export type AppBootstrapStatus = "pending" | "ready" | "error";

export interface AppWindowMeta {
  window: WindowName | null;
  label: string;
  isPrimaryMain: boolean;
  status: AppBootstrapStatus;
}

export const initialAppWindowMeta: AppWindowMeta = {
  window: null,
  label: "",
  isPrimaryMain: false,
  status: "pending",
};

export function shouldRenderMainWindow(meta: AppWindowMeta): boolean {
  switch (meta.status) {
    case "pending":
    case "error":
      return true;
    case "ready":
      return meta.window === null || meta.window === "Main";
  }
}

export function shouldRunUpdater(meta: AppWindowMeta): boolean {
  return meta.window === "Main" && meta.isPrimaryMain;
}

export function shouldRequestWindowPrewarm(meta: AppWindowMeta): boolean {
  return false;
}
