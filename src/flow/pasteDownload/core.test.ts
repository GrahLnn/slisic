import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyCandidateUrlResolution,
  applyDownloadTaskChangeSignal,
  appendCandidateItem,
  acceptCandidateRootTitleEvidence,
  candidateItemAllowsDelete,
  candidateItemIsErrored,
  acceptCandidateDownloadTask,
  createInitialContext,
  deleteCandidateItem,
  downloadTaskIsTerminal,
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
    });

    assert.equal(next.items[0]?.sourceUrl, "https://example.com/root");
    assert.equal(next.items[0]?.displayText, "Slow Playlist");
    assert.equal(next.items[0]?.status, "task_active");
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
