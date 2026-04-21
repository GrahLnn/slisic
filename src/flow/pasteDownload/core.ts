import { type as arkType } from "arktype";
import type { Collection, DownloadResourceProbe, DownloadTask } from "@/src/cmd";

const downloadUrl = arkType("string.url");
const EMPTY_CLIPBOARD_TEXT = "Empty clipboard";

export type ConfigCandidateItemStatus =
  | "probing"
  | "resolved"
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
  task: DownloadTask | null;
}

export interface Context {
  items: ConfigCandidateItem[];
  pendingProbeItemIds: string[];
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
    pendingProbeItemIds: [],
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
  const parsed = parseClipboardDownloadUrl(rawText);
  const id = createCandidateItemId(context.nextItemSequence);
  const item: ConfigCandidateItem = parsed.ok
    ? {
        id,
        rawText,
        sourceUrl: parsed.url,
        displayText: parsed.url,
        status: "probing",
        error: null,
        probe: null,
        task: null,
      }
    : {
        id,
        rawText,
        sourceUrl: null,
        displayText: toDisplayText(rawText),
        status: "invalid_url",
        error: parsed.error,
        probe: null,
        task: null,
      };

  return {
    ...context,
    items: [item, ...context.items],
    pendingProbeItemIds: parsed.ok
      ? [...context.pendingProbeItemIds, item.id]
      : context.pendingProbeItemIds,
    nextItemSequence: context.nextItemSequence + 1,
  };
}

export function activateNextCandidate(context: Context): Context {
  const [activeItemId, ...pendingProbeItemIds] = context.pendingProbeItemIds;

  if (!activeItemId) {
    return context;
  }

  return {
    ...context,
    activeItemId,
    pendingProbeItemIds,
  };
}

export function hasPendingCandidateToProbe(context: Context) {
  return context.activeItemId === null && context.pendingProbeItemIds.length > 0;
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
    items: context.items.map((item) =>
      item.id === context.activeItemId ? updater(item) : item,
    ),
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
    status: "resolved",
    error: null,
    probe,
  }));
}

export function createDraftCollectionFromProbe(
  probe: DownloadResourceProbe,
): Collection {
  return {
    name: probe.title,
    url: probe.url,
    folder: probe.collection_folder,
    musics: [],
    last_updated: "",
    enable_updates: probe.enable_updates,
  };
}

export function failActiveCandidateProbe(context: Context, error: string): Context {
  return updateActiveCandidateItem(context, (item) => ({
    ...item,
    status: "probe_failed",
    error,
  }));
}

export function storeActiveCandidateTask(context: Context, task: DownloadTask): Context {
  return updateActiveCandidateItem(context, (item) => ({
    ...item,
    task,
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
  return context.activeItemId
    ? deleteCandidateItem(context, context.activeItemId)
    : context;
}

export function deleteCandidateItem(context: Context, id: string): Context {
  return {
    ...context,
    items: context.items.filter((item) => item.id !== id),
    pendingProbeItemIds: context.pendingProbeItemIds.filter((itemId) => itemId !== id),
    activeItemId: context.activeItemId === id ? null : context.activeItemId,
  };
}

export function candidateItemAllowsDelete(status: ConfigCandidateItemStatus) {
  return (
    status === "invalid_url" ||
    status === "probe_failed" ||
    status === "enqueue_failed"
  );
}

export function candidateItemIsErrored(status: ConfigCandidateItemStatus) {
  return candidateItemAllowsDelete(status);
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
