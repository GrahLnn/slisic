import { type as arkType } from "arktype";
import type { DownloadResourceProbe, PastedDownloadUrlResolution } from "@/src/cmd";

const downloadUrl = arkType("string.url");
const EMPTY_CLIPBOARD_TEXT = "Empty clipboard";

export type ConfigCandidateItemStatus =
  | "checking"
  | "probing"
  | "enqueueing"
  | "invalid_url"
  | "probe_failed"
  | "enqueue_failed";

export interface ConfigCandidateItem {
  id: string;
  rawText: string;
  sourceUrl: string | null;
  displayText: string;
  status: ConfigCandidateItemStatus;
  error: string | null;
  probe: DownloadResourceProbe | null;
}

export interface Context {
  items: ConfigCandidateItem[];
  pendingCheckItemIds: string[];
  activeItemId: string | null;
  nextItemSequence: number;
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
    items: [],
    pendingCheckItemIds: [],
    activeItemId: null,
    nextItemSequence: 0,
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

function createCandidateItemId(sequence: number) {
  return `candidate:${sequence}`;
}

function toDisplayText(rawText: string) {
  const trimmed = rawText.trim();

  return trimmed.length > 0 ? trimmed : EMPTY_CLIPBOARD_TEXT;
}

export function appendCandidateItem(context: Context, rawText: string): Context {
  const id = createCandidateItemId(context.nextItemSequence);
  const item: ConfigCandidateItem = {
    id,
    rawText,
    sourceUrl: null,
    displayText: toDisplayText(rawText),
    status: "checking",
    error: null,
    probe: null,
  };

  return {
    ...context,
    items: [item, ...context.items],
    pendingCheckItemIds: [...context.pendingCheckItemIds, item.id],
    nextItemSequence: context.nextItemSequence + 1,
  };
}

export function activateNextCandidateCheck(context: Context): Context {
  const [activeItemId, ...pendingCheckItemIds] = context.pendingCheckItemIds;

  if (!activeItemId) {
    return context;
  }

  return {
    ...context,
    activeItemId,
    pendingCheckItemIds,
  };
}

export function hasPendingCandidateToCheck(context: Context) {
  return context.activeItemId === null && context.pendingCheckItemIds.length > 0;
}

export function findActiveCandidateItem(context: Context): ConfigCandidateItem | null {
  if (!context.activeItemId) {
    return null;
  }

  return context.items.find((item) => item.id === context.activeItemId) ?? null;
}

export function updateActiveCandidateItem(
  context: Context,
  updater: (item: ConfigCandidateItem) => ConfigCandidateItem,
): Context {
  if (!context.activeItemId) {
    return context;
  }

  return {
    ...context,
    items: context.items.map((item) => (item.id === context.activeItemId ? updater(item) : item)),
  };
}

export function completeActiveCandidateProbe(
  context: Context,
  probe: DownloadResourceProbe,
): Context {
  return updateActiveCandidateItem(context, (item) => ({
    ...item,
    sourceUrl: probe.url,
    displayText: probe.title,
    status: "enqueueing",
    error: null,
    probe,
  }));
}

export function applyActiveCandidateUrlResolution(
  context: Context,
  resolution: PastedDownloadUrlResolution,
): Context {
  return updateActiveCandidateItem(context, (item) => {
    switch (resolution.status) {
      case "invalid_url":
        return {
          ...item,
          sourceUrl: null,
          displayText: toDisplayText(item.rawText),
          status: "invalid_url",
          error: resolution.error ?? "Clipboard does not contain a valid URL.",
        };
      case "new_url": {
        const url = resolution.url ?? item.rawText.trim();
        return {
          ...item,
          sourceUrl: url,
          displayText: url,
          status: "probing",
          error: null,
        };
      }
      case "existing_collection":
        return item;
      default:
        return item;
    }
  });
}

export function failActiveCandidateProbe(context: Context, error: string): Context {
  return updateActiveCandidateItem(context, (item) => ({
    ...item,
    status: "probe_failed",
    error,
  }));
}

export function failActiveCandidateEnqueue(context: Context, error: string): Context {
  return updateActiveCandidateItem(context, (item) => ({
    ...item,
    status: "enqueue_failed",
    error,
  }));
}

export function clearActiveCandidate(context: Context): Context {
  return {
    ...context,
    activeItemId: null,
  };
}

export function removeActiveCandidate(context: Context): Context {
  return context.activeItemId ? deleteCandidateItem(context, context.activeItemId) : context;
}

export function deleteCandidateItem(context: Context, id: string): Context {
  return {
    ...context,
    items: context.items.filter((item) => item.id !== id),
    pendingCheckItemIds: context.pendingCheckItemIds.filter((itemId) => itemId !== id),
    activeItemId: context.activeItemId === id ? null : context.activeItemId,
  };
}

export function candidateItemAllowsDelete(status: ConfigCandidateItemStatus) {
  return status === "invalid_url" || status === "probe_failed" || status === "enqueue_failed";
}

export function candidateItemIsErrored(status: ConfigCandidateItemStatus) {
  return candidateItemAllowsDelete(status);
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
