import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyCandidateUrlResolution,
  appendCandidateItem,
  candidateItemAllowsDelete,
  candidateItemIsErrored,
  createInitialContext,
  deleteCandidateItem,
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
    assert.equal(candidateItemAllowsDelete("preparing"), false);
    assert.equal(candidateItemIsErrored("enqueue_failed"), true);
    assert.equal(candidateItemIsErrored("enqueueing"), false);
    assert.equal(candidateItemIsErrored("preparing"), false);
  });
});
