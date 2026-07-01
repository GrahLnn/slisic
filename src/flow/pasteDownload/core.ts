import { type as arkType } from "arktype";
import type {
  DownloadCredentialRequestSignal,
  DownloadRootTitleEvidence,
  DownloadTask,
  DownloadTaskChangeSignal,
  PastedDownloadUrlResolution,
} from "@/src/cmd";

const downloadUrlText = arkType("string.url");
const singleDownloadUrlText = arkType("string").narrow(
  (url, ctx) => !/[\s\x00-\x1f\x7f]/.test(url) || ctx.mustBe("one complete URL in clipboard text"),
);
const downloadableUrl = arkType("string.url.parse").narrow((url, ctx) =>
  url.protocol === "http:" || url.protocol === "https:" ? true : ctx.mustBe("an http or https URL"),
);
const EMPTY_CLIPBOARD_TEXT = "Empty clipboard";
const SINGLE_URL_TEXT_ERROR = "Clipboard must contain exactly one URL.";
const DOWNLOAD_TASK_FAILED_ERROR = "Download task failed before the collection was ready.";

export type ConfigCandidateItemStatus =
  | "checking"
  | "enqueueing"
  | "task_active"
  | "awaiting_credentials"
  | "invalid_url"
  | "enqueue_failed";

export interface ConfigCandidateItem {
  id: string;
  rawText: string;
  sourceUrl: string | null;
  displayText: string;
  status: ConfigCandidateItemStatus;
  error: string | null;
  credentialRequest?: DownloadTaskChangeSignal["credential_request"];
  taskId: string | null;
}

export interface Context {
  items: ConfigCandidateItem[];
  nextItemSequence: number;
}

export interface DownloadCredentialPromptRequest {
  taskId: string;
  taskUrl: string;
  collectionUrl: string | null;
  collectionName: string | null;
  request: DownloadCredentialRequestSignal;
}

export function credentialProviderKey(request: DownloadCredentialPromptRequest): string {
  return request.request.provider;
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

export type ParsedBatchClipboardDownloadUrls =
  | {
      ok: true;
      urls: string[];
    }
  | {
      ok: false;
      error: string;
    };

export type ParsedDownloadableClipboardUrl =
  | {
      ok: true;
      urlText: string;
      url: URL;
    }
  | {
      ok: false;
      error: string;
    };

export function createInitialContext(): Context {
  return {
    items: [],
    nextItemSequence: 0,
  };
}

export function parseDownloadableClipboardUrl(text: string): ParsedDownloadableClipboardUrl {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return {
      ok: false,
      error: "Clipboard does not contain a URL.",
    };
  }

  const validated = downloadUrlText(trimmed);
  if (typeof validated !== "string") {
    return {
      ok: false,
      error: "Clipboard does not contain a valid URL.",
    };
  }

  const singleUrl = singleDownloadUrlText(validated);
  if (typeof singleUrl !== "string") {
    return {
      ok: false,
      error: SINGLE_URL_TEXT_ERROR,
    };
  }

  const parsedUrl = downloadableUrl(singleUrl);
  if (!(parsedUrl instanceof URL)) {
    return {
      ok: false,
      error: "Only http and https URLs can be downloaded.",
    };
  }

  return {
    ok: true,
    urlText: singleUrl,
    url: parsedUrl,
  };
}

export function parseClipboardDownloadUrl(text: string): ParsedClipboardDownloadUrl {
  const parsed = parseDownloadableClipboardUrl(text);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    ok: true,
    url: parsed.urlText,
  };
}

export function parseBatchClipboardDownloadUrls(text: string): ParsedBatchClipboardDownloadUrls {
  const lines = text
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      ok: false,
      error: "Clipboard does not contain any URL lines.",
    };
  }

  const urls: string[] = [];
  for (const [index, line] of lines.entries()) {
    const parsed = parseClipboardDownloadUrl(line);
    if (!parsed.ok) {
      return {
        ok: false,
        error: `Line ${index + 1}: ${parsed.error}`,
      };
    }
    urls.push(parsed.url);
  }

  return {
    ok: true,
    urls,
  };
}

export function createInvalidPastedDownloadUrlResolution(
  error: string,
): PastedDownloadUrlResolution {
  return {
    status: "invalid_url",
    url: null,
    error,
    collection: null,
  };
}

export function createCandidateItemId(sequence: number) {
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
    credentialRequest: null,
    taskId: null,
  };

  return {
    ...context,
    items: [item, ...context.items],
    nextItemSequence: context.nextItemSequence + 1,
  };
}

export function resetCandidateItems(context: Context): Context {
  return {
    ...context,
    items: [],
  };
}

export function hasCandidateItem(context: Context, id: string) {
  return context.items.some((item) => item.id === id);
}

export function updateCandidateItem(
  context: Context,
  id: string,
  updater: (item: ConfigCandidateItem) => ConfigCandidateItem,
): Context {
  if (!hasCandidateItem(context, id)) {
    return context;
  }

  return {
    ...context,
    items: context.items.map((item) => (item.id === id ? updater(item) : item)),
  };
}

export function applyCandidateUrlResolution(
  context: Context,
  id: string,
  resolution: PastedDownloadUrlResolution,
): Context {
  return updateCandidateItem(context, id, (item) => {
    switch (resolution.status) {
      case "invalid_url":
        return {
          ...item,
          sourceUrl: null,
          displayText: toDisplayText(item.rawText),
          status: "invalid_url",
          error: resolution.error ?? "Clipboard does not contain a valid URL.",
          credentialRequest: null,
          taskId: null,
        };
      case "new_url": {
        const url = resolution.url ?? item.rawText.trim();
        return {
          ...item,
          sourceUrl: url,
          displayText: url,
          status: "enqueueing",
          error: null,
          credentialRequest: null,
          taskId: null,
        };
      }
      case "existing_collection":
        return item;
      default:
        return item;
    }
  });
}

export function failCandidateItem(context: Context, id: string, error: string): Context {
  return updateCandidateItem(context, id, (item) => ({
    ...item,
    status: "enqueue_failed",
    error,
    credentialRequest: null,
  }));
}

export function downloadTaskIdText(task: DownloadTask) {
  return task.id.String ?? String(task.id.Number);
}

export function credentialPromptRequestFromTaskChange(
  signal: DownloadTaskChangeSignal,
): DownloadCredentialPromptRequest | null {
  const request = signal.credential_request;
  if (signal.status !== "awaiting_credentials" || request?.provider !== "youtube") {
    return null;
  }

  return {
    taskId: signal.task_id,
    taskUrl: signal.task_url,
    collectionUrl: signal.collection_url,
    collectionName: signal.collection_name,
    request,
  };
}

export function applyCredentialTaskChange(
  requests: DownloadCredentialPromptRequest[],
  signal: DownloadTaskChangeSignal,
): DownloadCredentialPromptRequest[] {
  const nextRequest = credentialPromptRequestFromTaskChange(signal);
  const remaining = requests.filter((request) => request.taskId !== signal.task_id);

  if (!nextRequest) {
    return remaining;
  }

  if (
    remaining.some(
      (request) => credentialProviderKey(request) === credentialProviderKey(nextRequest),
    )
  ) {
    return remaining;
  }

  return [...remaining, nextRequest];
}

export function acceptCandidateDownloadTask(
  context: Context,
  id: string,
  task: DownloadTask,
): Context {
  return updateCandidateItem(context, id, (item) => ({
    ...item,
    sourceUrl: task.collection_url ?? item.sourceUrl ?? task.url,
    displayText: task.collection_name ?? item.displayText,
    status: task.status === "awaiting_credentials" ? "awaiting_credentials" : "task_active",
    error: null,
    credentialRequest: null,
    taskId: downloadTaskIdText(task),
  }));
}

export function acceptCandidateRootTitleEvidence(
  context: Context,
  id: string,
  evidence: DownloadRootTitleEvidence,
): Context {
  return updateCandidateItem(context, id, (item) => ({
    ...item,
    sourceUrl: evidence.url,
    displayText: evidence.title,
    error: null,
    credentialRequest: null,
  }));
}

export function downloadTaskIsTerminal(status: DownloadTask["status"]) {
  return (
    status === "completed" ||
    status === "completed_with_errors" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

export function applyDownloadTaskChangeSignal(
  context: Context,
  signal: DownloadTaskChangeSignal,
): Context {
  const status = signal.status;

  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    return {
      ...context,
      items: context.items.map((item) =>
        item.taskId === signal.task_id
          ? {
              ...item,
              status: "enqueue_failed",
              error: signal.last_error ?? DOWNLOAD_TASK_FAILED_ERROR,
              credentialRequest: null,
            }
          : item,
      ),
    };
  }

  if (status === "awaiting_credentials") {
    return {
      ...context,
      items: context.items.map((item) =>
        item.taskId === signal.task_id
          ? {
              ...item,
              sourceUrl: signal.collection_url ?? item.sourceUrl,
              displayText: signal.collection_name ?? item.displayText,
              status: "awaiting_credentials",
              error: null,
              credentialRequest: signal.credential_request,
            }
          : item,
      ),
    };
  }

  return {
    ...context,
    items: context.items.map((item) =>
      item.taskId === signal.task_id
        ? {
            ...item,
            sourceUrl: signal.collection_url ?? item.sourceUrl,
            displayText: signal.collection_name ?? item.displayText,
            status: item.status === "awaiting_credentials" ? "task_active" : item.status,
            credentialRequest: null,
          }
        : item,
    ),
  };
}

export function deleteCandidateItemByTaskId(context: Context, taskId: string): Context {
  return {
    ...context,
    items: context.items.filter((item) => item.taskId !== taskId),
  };
}

export function failCandidateTask(context: Context, taskId: string, error: string): Context {
  return {
    ...context,
    items: context.items.map((item) =>
      item.taskId === taskId
        ? {
            ...item,
            status: "enqueue_failed",
            error,
            credentialRequest: null,
          }
        : item,
    ),
  };
}

export function deleteCandidateItem(context: Context, id: string): Context {
  return {
    ...context,
    items: context.items.filter((item) => item.id !== id),
  };
}

export function candidateItemAllowsDelete(status: ConfigCandidateItemStatus) {
  return status === "invalid_url" || status === "enqueue_failed";
}

export function candidateItemIsErrored(status: ConfigCandidateItemStatus) {
  return candidateItemAllowsDelete(status);
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
