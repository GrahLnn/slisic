import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  activateNextCandidate,
  appendCandidateItem,
  candidateItemAllowsDelete,
  candidateItemIsErrored,
  createDraftCollectionFromProbe,
  createInitialContext,
  deleteCandidateItem,
  hasPendingCandidateToProbe,
  parseClipboardDownloadUrl,
  removeActiveCandidate,
} from "./core";

describe("createInitialContext", () => {
  test("creates an empty paste download context", () => {
    assert.deepEqual(createInitialContext(), {
      items: [],
      pendingProbeItemIds: [],
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
  test("creates a draft-ready collection shell from a resolved probe", () => {
    assert.deepEqual(
      createDraftCollectionFromProbe({
        url: "https://example.com/watch?v=abc",
        source_kind: "single",
        title: "Example",
        item_count: 1,
        collection_folder: "youtube/Example",
        enable_updates: null,
      }),
      {
        name: "Example",
        url: "https://example.com/watch?v=abc",
        folder: "youtube/Example",
        musics: [],
        last_updated: "",
        enable_updates: null,
      },
    );
  });

  test("prepends new pasted items and queues only valid urls for probing", () => {
    const withFirst = appendCandidateItem(
      createInitialContext(),
      "https://example.com/watch?v=abc",
    );
    const withSecond = appendCandidateItem(withFirst, "not a url");

    assert.equal(withSecond.items[0]?.displayText, "not a url");
    assert.equal(withSecond.items[0]?.status, "invalid_url");
    assert.equal(withSecond.items[1]?.displayText, "https://example.com/watch?v=abc");
    assert.equal(withSecond.items[1]?.status, "probing");
    assert.deepEqual(withSecond.pendingProbeItemIds, ["candidate:0"]);
  });

  test("activates the next pending candidate probe", () => {
    const context = appendCandidateItem(
      appendCandidateItem(createInitialContext(), "https://example.com/watch?v=abc"),
      "https://example.com/watch?v=def",
    );

    assert.equal(hasPendingCandidateToProbe(context), true);

    const next = activateNextCandidate(context);

    assert.equal(next.activeItemId, "candidate:0");
    assert.deepEqual(next.pendingProbeItemIds, ["candidate:1"]);
  });

  test("deletes a candidate item and removes it from every tracking list", () => {
    const context = {
      ...activateNextCandidate(
        appendCandidateItem(createInitialContext(), "https://example.com/watch?v=abc"),
      ),
      pendingProbeItemIds: ["candidate:1"],
      items: [
        {
          id: "candidate:1",
          rawText: "https://example.com/watch?v=def",
          sourceUrl: "https://example.com/watch?v=def",
          displayText: "https://example.com/watch?v=def",
          status: "probing" as const,
          error: null,
          probe: null,
          task: null,
        },
        {
          id: "candidate:0",
          rawText: "https://example.com/watch?v=abc",
          sourceUrl: "https://example.com/watch?v=abc",
          displayText: "https://example.com/watch?v=abc",
          status: "probing" as const,
          error: null,
          probe: null,
          task: null,
        },
      ],
    };

    assert.deepEqual(deleteCandidateItem(context, "candidate:0"), {
      ...context,
      items: [context.items[0]!],
      pendingProbeItemIds: ["candidate:1"],
      activeItemId: null,
    });
  });

  test("removes the active candidate once ownership transfers away from paste state", () => {
    const context = {
      ...activateNextCandidate(
        appendCandidateItem(createInitialContext(), "https://example.com/watch?v=abc"),
      ),
      items: [
        {
          id: "candidate:0",
          rawText: "https://example.com/watch?v=abc",
          sourceUrl: "https://example.com/watch?v=abc",
          displayText: "Example",
          status: "resolved" as const,
          error: null,
          probe: null,
          task: null,
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
    assert.equal(candidateItemAllowsDelete("probe_failed"), true);
    assert.equal(candidateItemAllowsDelete("enqueue_failed"), true);
    assert.equal(candidateItemAllowsDelete("probing"), false);
    assert.equal(candidateItemAllowsDelete("resolved"), false);
    assert.equal(candidateItemIsErrored("probe_failed"), true);
    assert.equal(candidateItemIsErrored("resolved"), false);
  });
});
