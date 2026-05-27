import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  activateNextCandidateCheck,
  applyActiveCandidateUrlResolution,
  appendCandidateItem,
  candidateItemAllowsDelete,
  candidateItemIsErrored,
  createInitialContext,
  deleteCandidateItem,
  hasPendingCandidateToCheck,
  parseClipboardDownloadUrl,
  removeActiveCandidate,
} from "./core";

describe("createInitialContext", () => {
  test("creates an empty paste download context", () => {
    assert.deepEqual(createInitialContext(), {
      items: [],
      pendingCheckItemIds: [],
      activeItemId: null,
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

  test("rejects invalid urls", () => {
    assert.deepEqual(parseClipboardDownloadUrl("not a url"), {
      ok: false,
      error: "Clipboard does not contain a valid URL.",
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
  test("prepends new pasted items and queues them for url checks", () => {
    const withFirst = appendCandidateItem(
      createInitialContext(),
      "https://example.com/watch?v=abc",
    );
    const withSecond = appendCandidateItem(withFirst, "not a url");

    assert.equal(withSecond.items[0]?.displayText, "not a url");
    assert.equal(withSecond.items[0]?.status, "checking");
    assert.equal(withSecond.items[1]?.displayText, "https://example.com/watch?v=abc");
    assert.equal(withSecond.items[1]?.status, "checking");
    assert.deepEqual(withSecond.pendingCheckItemIds, ["candidate:0", "candidate:1"]);
  });

  test("activates the next pending candidate check", () => {
    const context = appendCandidateItem(
      appendCandidateItem(createInitialContext(), "https://example.com/watch?v=abc"),
      "https://example.com/watch?v=def",
    );

    assert.equal(hasPendingCandidateToCheck(context), true);

    const next = activateNextCandidateCheck(context);

    assert.equal(next.activeItemId, "candidate:0");
    assert.deepEqual(next.pendingCheckItemIds, ["candidate:1"]);
  });

  test("turns a checked new url into an enqueue candidate", () => {
    const context = activateNextCandidateCheck(
      appendCandidateItem(createInitialContext(), "https://example.com/watch?v=abc"),
    );

    const next = applyActiveCandidateUrlResolution(context, {
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
      ...activateNextCandidateCheck(
        appendCandidateItem(createInitialContext(), "https://example.com/watch?v=abc"),
      ),
      pendingCheckItemIds: ["candidate:2"],
      items: [
        {
          id: "candidate:1",
          rawText: "https://example.com/watch?v=def",
          sourceUrl: "https://example.com/watch?v=def",
          displayText: "https://example.com/watch?v=def",
          status: "enqueueing" as const,
          error: null,
        },
        {
          id: "candidate:0",
          rawText: "https://example.com/watch?v=abc",
          sourceUrl: "https://example.com/watch?v=abc",
          displayText: "https://example.com/watch?v=abc",
          status: "enqueueing" as const,
          error: null,
        },
      ],
    };

    assert.deepEqual(deleteCandidateItem(context, "candidate:0"), {
      ...context,
      items: [context.items[0]!],
      pendingCheckItemIds: ["candidate:2"],
      activeItemId: null,
    });
  });

  test("removes the active candidate once ownership transfers away from paste state", () => {
    const context = {
      ...createInitialContext(),
      activeItemId: "candidate:0",
      items: [
        {
          id: "candidate:0",
          rawText: "https://example.com/watch?v=abc",
          sourceUrl: "https://example.com/watch?v=abc",
          displayText: "Example",
          status: "enqueueing" as const,
          error: null,
        },
      ],
    };

    assert.deepEqual(removeActiveCandidate(context), {
      ...context,
      items: [],
      activeItemId: null,
    });
  });

  test("marks only invalid or failed candidates as delete-only", () => {
    assert.equal(candidateItemAllowsDelete("invalid_url"), true);
    assert.equal(candidateItemAllowsDelete("enqueue_failed"), true);
    assert.equal(candidateItemAllowsDelete("checking"), false);
    assert.equal(candidateItemAllowsDelete("enqueueing"), false);
    assert.equal(candidateItemIsErrored("enqueue_failed"), true);
    assert.equal(candidateItemIsErrored("enqueueing"), false);
  });
});
