import type { WindowName } from "../../cmd";

export type AppBootstrapStatus = "pending" | "ready" | "error";

export interface AppWindowMeta {
  window: WindowName | null;
  isPrewarm: boolean;
  label: string;
  isPrimaryMain: boolean;
  status: AppBootstrapStatus;
}

export const initialAppWindowMeta: AppWindowMeta = {
  window: null,
  isPrewarm: false,
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
  return !meta.isPrewarm && meta.window === "Main" && meta.isPrimaryMain;
}
