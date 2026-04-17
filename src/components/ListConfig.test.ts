import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { me } from "@grahlnn/fn";
import type { ConfigDraft } from "@/src/flow/appLogic/core";
import {
  createListConfigTitleSnapshot,
  resolveListConfigSavePath,
  resolveListConfigEmptyState,
  resolveListConfigToolLabelItems,
  LIST_CONFIG_EMPTY_STATE_TEXT,
  resolveListConfigToolListInteractionDisabled,
  resolveListConfigTitleViewModel,
  shouldShowListConfigEmptyState,
} from "./ListConfig";

const createDraft: ConfigDraft = {
  mode: "create",
  name: "",
  collections: [],
  groups: [],
};

const editDraft: ConfigDraft = {
  mode: "edit",
  name: "Quiet Morning",
  collections: [
    {
      name: "Quiet Morning",
      url: "https://example.com/quiet-morning",
      folder: "youtube/quiet-morning",
      musics: [],
      last_updated: "2026-04-13T00:00:00Z",
      enable_updates: null,
    },
  ],
  groups: [],
};

const configSidebarItems = [
  {
    kind: "collection",
    name: "Quiet Morning",
    url: "https://example.com/quiet-morning",
    folder: "youtube/quiet-morning",
  },
  {
    kind: "group",
    name: "Disc 1",
    url: "https://example.com/quiet-morning#disc-1",
    folder: "Disc 1",
  },
] as const;

describe("ListConfig title view model", () => {
  test("captures the live create draft title snapshot", () => {
    assert.deepEqual(createListConfigTitleSnapshot("collection-title:create", createDraft), {
      layoutId: "collection-title:create",
      value: "",
      placeholder: "Create a List",
    });
  });

  test("keeps the previous snapshot while the exit animation is running", () => {
    const previousSnapshot = {
      layoutId: "collection-title:create",
      value: "",
      placeholder: "Create a List",
    };

    assert.deepEqual(
      resolveListConfigTitleViewModel({
        activeLayoutId: null,
        draft: null,
        titleToneHandoff: {
          layoutId: "collection-title:create",
          tone: "muted",
        },
        previousSnapshot,
      }),
      {
        snapshot: previousSnapshot,
        autoFocus: false,
        handoffTone: "muted",
        layoutId: "collection-title:create",
        placeholder: "Create a List",
        value: "",
      },
    );
  });

  test("uses the live edit draft without a placeholder", () => {
    assert.deepEqual(
      resolveListConfigTitleViewModel({
        activeLayoutId: "playlist-title:Quiet Morning",
        draft: editDraft,
        titleToneHandoff: null,
        previousSnapshot: null,
      }),
      {
        snapshot: {
          layoutId: "playlist-title:Quiet Morning",
          value: "Quiet Morning",
          placeholder: undefined,
        },
        autoFocus: false,
        handoffTone: null,
        layoutId: "playlist-title:Quiet Morning",
        placeholder: undefined,
        value: "Quiet Morning",
      },
    );
  });

  test("disables the tool list while the config page is exiting", () => {
    assert.equal(
      resolveListConfigToolListInteractionDisabled({
        isAnimating: false,
        isPresent: false,
      }),
      true,
    );
  });

  test("keeps the tool list interactive only after entry settles", () => {
    assert.equal(
      resolveListConfigToolListInteractionDisabled({
        isAnimating: false,
        isPresent: true,
      }),
      false,
    );
  });

  test("prefers meta.save_path over the generated default save path", () => {
    assert.equal(
      resolveListConfigSavePath("D:\\MediaLibrary", "C:\\Users\\admin\\Documents\\ransic"),
      "D:\\MediaLibrary",
    );
  });

  test("falls back to the generated default save path when meta.save_path is empty", () => {
    assert.equal(
      resolveListConfigSavePath(null, "C:\\Users\\admin\\Documents\\ransic"),
      "C:\\Users\\admin\\Documents\\ransic",
    );
  });

  test("derives tool label items from source items without an effect", () => {
    assert.deepEqual(resolveListConfigToolLabelItems(configSidebarItems, new Set()), [
      {
        id: "collection:https://example.com/quiet-morning",
        text: "Quiet Morning",
      },
      {
        id: "group:https://example.com/quiet-morning#disc-1",
        text: "Disc 1",
      },
    ]);
  });

  test("filters popped tool label items from the derived list", () => {
    assert.deepEqual(
      resolveListConfigToolLabelItems(
        configSidebarItems,
        new Set(["group:https://example.com/quiet-morning#disc-1"]),
      ),
      [
        {
          id: "collection:https://example.com/quiet-morning",
          text: "Quiet Morning",
        },
      ],
    );
  });

  test("shows the empty-state hint when the playlist has no collections or groups", () => {
    assert.equal(
      resolveListConfigEmptyState(
        shouldShowListConfigEmptyState(createDraft),
        null,
      ).match({
        true: () => true,
        false: () => false,
      }),
      true,
    );
    assert.match(LIST_CONFIG_EMPTY_STATE_TEXT, /\n/);
    assert.match(LIST_CONFIG_EMPTY_STATE_TEXT, /Paste a link/i);
    assert.match(LIST_CONFIG_EMPTY_STATE_TEXT, /import a local music folder/i);
  });

  test("keeps the empty-state hint hidden once the playlist has content", () => {
    assert.equal(
      resolveListConfigEmptyState(
        shouldShowListConfigEmptyState(editDraft),
        null,
      ).match({
        true: () => true,
        false: () => false,
      }),
      false,
    );
  });

  test("keeps the previous empty-state result when draft becomes null", () => {
    assert.equal(
      resolveListConfigEmptyState(shouldShowListConfigEmptyState(null), me(true)).match({
        true: () => true,
        false: () => false,
      }),
      true,
    );
    assert.equal(
      resolveListConfigEmptyState(shouldShowListConfigEmptyState(null), me(false)).match({
        true: () => true,
        false: () => false,
      }),
      false,
    );
  });
});
