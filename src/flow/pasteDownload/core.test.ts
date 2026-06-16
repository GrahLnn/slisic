import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyCandidateUrlResolution,
  applyCredentialTaskChange,
  applyDownloadTaskChangeSignal,
  appendCandidateItem,
  acceptCandidateRootTitleEvidence,
  candidateItemAllowsDelete,
  candidateItemIsErrored,
  acceptCandidateDownloadTask,
  createInitialContext,
  credentialPromptRequestFromDownloadTask,
  deleteCandidateItem,
  downloadTaskIsTerminal,
  parseBatchClipboardDownloadUrls,
  parseClipboardDownloadUrl,
} from "./core";

describe("createInitialContext", () => {
  test("creates an empty paste download context", () => {
    assert.deepEqual(createInitialContext(), {
      items: [],
      nextItemSequence: 0,
    });
  });
});

describe("parseClipboardDownloadUrl", () => {
  test("accepts a trimmed https url", () => {
    assert.deepEqual(parseClipboardDownloadUrl("  https://example.com/watch?v=abc  "), {
      ok: true,
      url: "https://example.com/watch?v=abc",
    });
  });

  test("accepts youtube handle tab urls as a single downloadable url", () => {
    assert.deepEqual(parseClipboardDownloadUrl("https://www.youtube.com/@C418/releases"), {
      ok: true,
      url: "https://www.youtube.com/@C418/releases",
    });
  });

  test("rejects invalid urls", () => {
    assert.deepEqual(parseClipboardDownloadUrl("not a url"), {
      ok: false,
      error: "Clipboard does not contain a valid URL.",
    });
  });

  test("rejects a single paste containing more than one url", () => {
    assert.deepEqual(parseClipboardDownloadUrl("https://example.com/a https://example.com/b"), {
      ok: false,
      error: "Clipboard must contain exactly one URL.",
    });
  });

  test("rejects non-http urls", () => {
    assert.deepEqual(parseClipboardDownloadUrl("mailto:test@example.com"), {
      ok: false,
      error: "Only http and https URLs can be downloaded.",
    });
  });
});

describe("parseBatchClipboardDownloadUrls", () => {
  test("accepts one downloadable url per non-empty clipboard line", () => {
    assert.deepEqual(
      parseBatchClipboardDownloadUrls(
        "https://example.com/a\n\n  https://www.youtube.com/@C418/releases  \r\nhttps://example.com/c",
      ),
      {
        ok: true,
        urls: [
          "https://example.com/a",
          "https://www.youtube.com/@C418/releases",
          "https://example.com/c",
        ],
      },
    );
  });

  test("rejects when any line is not a complete downloadable url", () => {
    assert.deepEqual(
      parseBatchClipboardDownloadUrls("https://example.com/a\nhttps://example.com/b nope"),
      {
        ok: false,
        error: "Line 2: Clipboard must contain exactly one URL.",
      },
    );
  });

  test("rejects empty clipboard text", () => {
    assert.deepEqual(parseBatchClipboardDownloadUrls(" \n\t\r\n "), {
      ok: false,
      error: "Clipboard does not contain any URL lines.",
    });
  });
});

describe("candidate item helpers", () => {
  test("prepends new pasted items as independent checking candidates", () => {
    const withFirst = appendCandidateItem(
      createInitialContext(),
      "https://example.com/watch?v=abc",
    );
    const withSecond = appendCandidateItem(withFirst, "not a url");

    assert.equal(withSecond.items[0]?.displayText, "not a url");
    assert.equal(withSecond.items[0]?.status, "checking");
    assert.equal(withSecond.items[1]?.displayText, "https://example.com/watch?v=abc");
    assert.equal(withSecond.items[1]?.status, "checking");
  });

  test("turns a checked new url into an enqueue candidate", () => {
    const context = appendCandidateItem(createInitialContext(), "https://example.com/watch?v=abc");

    const next = applyCandidateUrlResolution(context, "candidate:0", {
      status: "new_url",
      url: "https://example.com/watch?v=abc",
      error: null,
      collection: null,
    });

    assert.equal(next.items[0]?.sourceUrl, "https://example.com/watch?v=abc");
    assert.equal(next.items[0]?.displayText, "https://example.com/watch?v=abc");
    assert.equal(next.items[0]?.status, "enqueueing");
  });

  test("uses non-terminal task shell evidence to update candidate display", () => {
    const context = acceptCandidateDownloadTask(
      applyCandidateUrlResolution(
        appendCandidateItem(createInitialContext(), "https://example.com/list"),
        "candidate:0",
        {
          status: "new_url",
          url: "https://example.com/list",
          error: null,
          collection: null,
        },
      ),
      "candidate:0",
      {
        id: { String: "task:list" },
        url: "https://example.com/list",
        collection_url: null,
        collection_name: null,
        collection_folder: null,
        source_kind: null,
        trigger: "manual",
        status: "queued",
        leafs: [],
        total_leaves: 0,
        completed_leaves: 0,
        failed_leaves: 0,
        last_error: null,
        created_at: "2026-06-02T00:00:00Z",
        updated_at: "2026-06-02T00:00:00Z",
      },
    );

    const next = applyDownloadTaskChangeSignal(context, {
      task_id: "task:list",
      task_url: "https://example.com/list",
      collection_url: "https://example.com/root",
      collection_name: "Slow Playlist",
      status: "resolving",
      last_error: null,
      credential_request: null,
    });

    assert.equal(next.items[0]?.sourceUrl, "https://example.com/root");
    assert.equal(next.items[0]?.displayText, "Slow Playlist");
    assert.equal(next.items[0]?.status, "task_active");
  });

  test("projects credential requests onto the matching active candidate", () => {
    const context = acceptCandidateDownloadTask(
      appendCandidateItem(createInitialContext(), "https://example.com/list"),
      "candidate:0",
      {
        id: { String: "task:list" },
        url: "https://example.com/list",
        collection_url: null,
        collection_name: null,
        collection_folder: null,
        source_kind: null,
        trigger: "manual",
        status: "downloading",
        leafs: [],
        total_leaves: 1,
        completed_leaves: 0,
        failed_leaves: 0,
        last_error: null,
        created_at: "2026-06-02T00:00:00Z",
        updated_at: "2026-06-02T00:00:00Z",
      },
    );

    const waiting = applyDownloadTaskChangeSignal(context, {
      task_id: "task:list",
      task_url: "https://example.com/list",
      collection_url: "https://example.com/root",
      collection_name: "Slow Playlist",
      status: "awaiting_credentials",
      last_error: "Sign in to confirm you're not a bot.",
      credential_request: {
        provider: "youtube",
        reason: "Sign in to confirm you're not a bot.",
      },
    });

    assert.equal(waiting.items[0]?.status, "awaiting_credentials");
    assert.equal(waiting.items[0]?.credentialRequest?.provider, "youtube");
    assert.equal(waiting.items[0]?.displayText, "Slow Playlist");

    const resumed = applyDownloadTaskChangeSignal(waiting, {
      task_id: "task:list",
      task_url: "https://example.com/list",
      collection_url: "https://example.com/root",
      collection_name: "Slow Playlist",
      status: "downloading",
      last_error: null,
      credential_request: null,
    });

    assert.equal(resumed.items[0]?.status, "task_active");
    assert.equal(resumed.items[0]?.credentialRequest, null);
  });

  test("reflects root title evidence without needing task evidence", () => {
    const context = applyCandidateUrlResolution(
      appendCandidateItem(createInitialContext(), "https://example.com/list"),
      "candidate:0",
      {
        status: "new_url",
        url: "https://example.com/list",
        error: null,
        collection: null,
      },
    );

    const next = acceptCandidateRootTitleEvidence(context, "candidate:0", {
      url: "https://example.com/root",
      title: "Slow Playlist",
      folder: "youtube/slow-playlist",
      enable_updates: false,
      source_kind: "list",
      collection: {
        name: "Slow Playlist",
        url: "https://example.com/root",
        folder: "youtube/slow-playlist",
        musics: [],
        last_updated: "2026-06-02T00:00:00Z",
        enable_updates: false,
      },
    });

    assert.equal(next.items[0]?.sourceUrl, "https://example.com/root");
    assert.equal(next.items[0]?.displayText, "Slow Playlist");
    assert.equal(next.items[0]?.status, "enqueueing");
    assert.equal(next.items[0]?.taskId, null);
  });

  test("keeps active download tasks visible even when shell collection evidence exists", () => {
    const context = appendCandidateItem(createInitialContext(), "https://example.com/list");
    const next = acceptCandidateDownloadTask(context, "candidate:0", {
      id: { String: "task:list" },
      url: "https://example.com/list",
      collection_url: "https://example.com/root",
      collection_name: "Slow Playlist",
      collection_folder: "youtube/slow-playlist",
      source_kind: "list",
      trigger: "manual",
      status: "resolving",
      leafs: [],
      total_leaves: 0,
      completed_leaves: 0,
      failed_leaves: 0,
      last_error: null,
      created_at: "2026-06-02T00:00:00Z",
      updated_at: "2026-06-02T00:00:00Z",
    });

    assert.equal(downloadTaskIsTerminal("resolving"), false);
    assert.equal(next.items[0]?.taskId, "task:list");
    assert.equal(next.items[0]?.status, "task_active");
    assert.equal(next.items[0]?.displayText, "Slow Playlist");
  });

  test("deletes a candidate item and removes it from every tracking list", () => {
    const context = {
      ...appendCandidateItem(createInitialContext(), "https://example.com/watch?v=abc"),
      items: [
        {
          id: "candidate:1",
          rawText: "https://example.com/watch?v=def",
          sourceUrl: "https://example.com/watch?v=def",
          displayText: "https://example.com/watch?v=def",
          status: "enqueueing" as const,
          error: null,
          taskId: null,
        },
        {
          id: "candidate:0",
          rawText: "https://example.com/watch?v=abc",
          sourceUrl: "https://example.com/watch?v=abc",
          displayText: "https://example.com/watch?v=abc",
          status: "enqueueing" as const,
          error: null,
          taskId: null,
        },
      ],
    };

    assert.deepEqual(deleteCandidateItem(context, "candidate:0"), {
      ...context,
      items: [context.items[0]!],
    });
  });

  test("marks only invalid or failed candidates as delete-only", () => {
    assert.equal(candidateItemAllowsDelete("invalid_url"), true);
    assert.equal(candidateItemAllowsDelete("enqueue_failed"), true);
    assert.equal(candidateItemAllowsDelete("checking"), false);
    assert.equal(candidateItemAllowsDelete("enqueueing"), false);
    assert.equal(candidateItemAllowsDelete("task_active"), false);
    assert.equal(candidateItemIsErrored("enqueue_failed"), true);
    assert.equal(candidateItemIsErrored("enqueueing"), false);
    assert.equal(candidateItemIsErrored("task_active"), false);
  });
});

describe("download credential prompt projection", () => {
  test("projects awaiting credential tasks from the authoritative task snapshot", () => {
    const request = credentialPromptRequestFromDownloadTask({
      id: { String: "task:youtube" },
      url: "https://www.youtube.com/playlist?list=abc",
      collection_url: "https://www.youtube.com/playlist?list=abc",
      collection_name: "Blocked Playlist",
      collection_folder: "youtube/blocked-playlist",
      source_kind: "list",
      trigger: "manual",
      status: "awaiting_credentials",
      leafs: [],
      total_leaves: 1,
      completed_leaves: 0,
      failed_leaves: 0,
      last_error: "Sign in to confirm you're not a bot.",
      created_at: "2026-06-16T00:00:00Z",
      updated_at: "2026-06-16T00:00:00Z",
    });

    assert.equal(request?.taskId, "task:youtube");
    assert.equal(request?.request.provider, "youtube");
    assert.equal(request?.request.reason, "Sign in to confirm you're not a bot.");
  });

  test("keeps credential prompt requests aligned with global task changes", () => {
    const waiting = applyCredentialTaskChange([], {
      task_id: "task:youtube",
      task_url: "https://www.youtube.com/playlist?list=abc",
      collection_url: "https://www.youtube.com/playlist?list=abc",
      collection_name: "Blocked Playlist",
      status: "awaiting_credentials",
      last_error: "Sign in to confirm you're not a bot.",
      credential_request: {
        provider: "youtube",
        reason: "YouTube wants a bot confirmation before continuing.",
      },
    });

    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]?.taskId, "task:youtube");

    const resumed = applyCredentialTaskChange(waiting, {
      task_id: "task:youtube",
      task_url: "https://www.youtube.com/playlist?list=abc",
      collection_url: "https://www.youtube.com/playlist?list=abc",
      collection_name: "Blocked Playlist",
      status: "downloading",
      last_error: null,
      credential_request: null,
    });

    assert.deepEqual(resumed, []);
  });
});
