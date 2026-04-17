import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Collection } from "@/src/cmd";
import {
  resolveNextPlayListTextOverrides,
  resolvePlayListPageTexts,
} from "./PlayListPage";

const sampleCollections: Collection[] = [
  {
    name: "Quiet Morning",
    url: "https://example.com/quiet-morning",
    folder: "youtube/quiet-morning",
    musics: [],
    last_updated: "2026-04-13T00:00:00Z",
    enable_updates: null,
  },
  {
    name: "Night Drive",
    url: "https://example.com/night-drive",
    folder: "youtube/night-drive",
    musics: [],
    last_updated: "2026-04-13T00:00:00Z",
    enable_updates: null,
  },
];

describe("PlayListPage text derivation", () => {
  test("uses collection names when there are no overrides", () => {
    assert.deepEqual(resolvePlayListPageTexts(sampleCollections, {}), [
      "Quiet Morning",
      "Night Drive",
    ]);
  });

  test("rotates the clicked collection text to the next visible title", () => {
    const overrides = resolveNextPlayListTextOverrides({
      collections: sampleCollections,
      textOverrides: {},
      clickedCollectionUrl: sampleCollections[0].url,
    });

    assert.deepEqual(overrides, {
      [sampleCollections[0].url]: "Night Drive",
    });
    assert.deepEqual(resolvePlayListPageTexts(sampleCollections, overrides), [
      "Night Drive",
      "Night Drive",
    ]);
  });

  test("drops stale overrides for collections that are no longer present", () => {
    assert.deepEqual(
      resolveNextPlayListTextOverrides({
        collections: [sampleCollections[0]],
        textOverrides: {
          [sampleCollections[0].url]: "Quiet Morning",
          "https://example.com/stale": "stale",
        },
        clickedCollectionUrl: sampleCollections[0].url,
      }),
      {},
    );
  });
});
