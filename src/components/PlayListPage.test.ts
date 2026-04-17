import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PlayList } from "@/src/cmd";
import { resolvePlayListPageTexts } from "./PlayListPage";

const samplePlaylists: PlayList[] = [
  {
    name: "Quiet Morning",
    collections: [],
    groups: [],
  },
  {
    name: "Night Drive",
    collections: [],
    groups: [],
  },
];

describe("PlayListPage text derivation", () => {
  test("uses playlist names in order", () => {
    assert.deepEqual(resolvePlayListPageTexts(samplePlaylists), [
      "Quiet Morning",
      "Night Drive",
    ]);
  });
});
