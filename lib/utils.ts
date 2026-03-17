import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { me } from "@grahlnn/fn";

export const app_state = me(!import.meta.env.DEV ? "pub" : "dev");

export type OsName = "windows" | "macos" | "linux" | "android" | "ios" | "unknown";

export function getPlatform(): OsName {
  if (typeof window !== "undefined") {
    const tauriWindow = window as typeof window & {
      __TAURI_OS_PLUGIN_INTERNALS__?: {
        platform?: string;
      };
    };
    const tauriOs = tauriWindow.__TAURI_OS_PLUGIN_INTERNALS__;

    if (typeof tauriOs?.platform === "string") {
      return tauriOs.platform as OsName;
    }
  }

  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent.toLowerCase();

  if (userAgent.includes("windows")) {
    return "windows";
  }

  if (userAgent.includes("mac os") || userAgent.includes("macintosh")) {
    return "macos";
  }

  if (userAgent.includes("android")) {
    return "android";
  }

  if (userAgent.includes("iphone") || userAgent.includes("ipad") || userAgent.includes("ios")) {
    return "ios";
  }

  if (userAgent.includes("linux")) {
    return "linux";
  }

  return "unknown";
}

export const os = me(getPlatform());

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function up1st(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
