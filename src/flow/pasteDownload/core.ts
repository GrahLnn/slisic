import { type as arkType } from "arktype";
import type { DownloadResourceProbe, DownloadTask } from "@/src/cmd";

const downloadUrl = arkType("string.url");

export interface Context {
  clipboardText: string | null;
  url: string | null;
  probe: DownloadResourceProbe | null;
  task: DownloadTask | null;
  error: string | null;
}

export type ParsedClipboardDownloadUrl =
  | {
      ok: true;
      url: string;
    }
  | {
      ok: false;
      error: string;
    };

export function createInitialContext(): Context {
  return {
    clipboardText: null,
    url: null,
    probe: null,
    task: null,
    error: null,
  };
}

export function parseClipboardDownloadUrl(text: string): ParsedClipboardDownloadUrl {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return {
      ok: false,
      error: "Clipboard does not contain a URL.",
    };
  }

  const validated = downloadUrl(trimmed);
  if (typeof validated !== "string") {
    return {
      ok: false,
      error: "Clipboard does not contain a valid URL.",
    };
  }

  const protocol = new URL(validated).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    return {
      ok: false,
      error: "Only http and https URLs can be downloaded.",
    };
  }

  return {
    ok: true,
    url: validated,
  };
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
