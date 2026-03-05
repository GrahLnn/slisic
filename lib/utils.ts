import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { me } from "@grahlnn/fn";
import { platform } from "@tauri-apps/plugin-os";

export const app_state = me(!import.meta.env.DEV ? "pub" : "dev");
export const os = me(platform());

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function up1st(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function isUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function host(input: string): string {
  try {
    return new URL(input).host;
  } catch {
    return input;
  }
}

export function inside(input: string): string {
  try {
    return new URL(input).pathname || input;
  } catch {
    return input;
  }
}
