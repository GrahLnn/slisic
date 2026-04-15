import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ConfigDraft } from "@/src/flow/appLogic/core";
import {
  createListConfigTitleSnapshot,
  resolveListConfigToolListInteractionDisabled,
  resolveListConfigTitleViewModel,
} from "./ListConfig";

const createDraft: ConfigDraft = {
  mode: "create",
  sourceUrl: null,
  name: "",
  folder: "",
  enableUpdates: null,
};

const editDraft: ConfigDraft = {
  mode: "edit",
  sourceUrl: "https://example.com/quiet-morning",
  name: "Quiet Morning",
  folder: "youtube/quiet-morning",
  enableUpdates: false,
};

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
        activeLayoutId: "collection-title:https://example.com/quiet-morning",
        draft: editDraft,
        titleToneHandoff: null,
        previousSnapshot: null,
      }),
      {
        snapshot: {
          layoutId: "collection-title:https://example.com/quiet-morning",
          value: "Quiet Morning",
          placeholder: undefined,
        },
        autoFocus: false,
        handoffTone: null,
        layoutId: "collection-title:https://example.com/quiet-morning",
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
});
