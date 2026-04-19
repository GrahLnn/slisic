import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  hasConfigDraftChanges,
  resolveConfigBackTitleSharePlan,
  resolveTitleSharePageTransition,
  resolveTitleShareToneFromDraft,
  shouldSuppressTitleShareFade,
} from "./titleShare";

describe("titleShare", () => {
  test("treats config-entering states as an outgoing source transition only", () => {
    const transition = resolveTitleSharePageTransition({
      activeLayoutId: "playlist-title:PlayList 1",
      titleToneHandoff: {
        layoutId: "playlist-title:PlayList 1",
        tone: "solid",
      },
      pressedLayoutId: null,
    });

    assert.deepEqual(transition, {
      outgoingSourceLayoutId: "playlist-title:PlayList 1",
      returnTargetLayoutId: null,
      committedLayoutId: "playlist-title:PlayList 1",
    });
    assert.equal(
      shouldSuppressTitleShareFade("playlist-title:PlayList 1", transition),
      true,
    );
    assert.equal(
      shouldSuppressTitleShareFade("collection-title:create", transition),
      false,
    );
  });

  test("treats ready state handoff as a returning target only", () => {
    const transition = resolveTitleSharePageTransition({
      activeLayoutId: null,
      titleToneHandoff: {
        layoutId: "playlist-title:PlayList 1",
        tone: "solid",
      },
      pressedLayoutId: null,
    });

    assert.deepEqual(transition, {
      outgoingSourceLayoutId: null,
      returnTargetLayoutId: "playlist-title:PlayList 1",
      committedLayoutId: null,
    });
    assert.equal(
      shouldSuppressTitleShareFade("playlist-title:PlayList 1", transition),
      true,
    );
    assert.equal(
      shouldSuppressTitleShareFade("collection-title:create", transition),
      false,
    );
  });

  test("lets a fresh pressed source win before the state machine enters config", () => {
    const transition = resolveTitleSharePageTransition({
      activeLayoutId: null,
      titleToneHandoff: {
        layoutId: "playlist-title:PlayList 1",
        tone: "solid",
      },
      pressedLayoutId: "collection-title:create",
    });

    assert.equal(transition.committedLayoutId, "collection-title:create");
    assert.equal(transition.returnTargetLayoutId, null);
    assert.equal(
      shouldSuppressTitleShareFade("playlist-title:PlayList 1", transition),
      false,
    );
    assert.equal(
      shouldSuppressTitleShareFade("playlist-title:PlayList 2", transition),
      false,
    );
  });

  test("marks config drafts as changed only when their canonical content differs", () => {
    const createDraft = {
      mode: "create" as const,
      name: "",
      collections: [],
      groups: [],
    };

    assert.equal(hasConfigDraftChanges(createDraft, createDraft), false);
    assert.equal(
      hasConfigDraftChanges(
        {
          ...createDraft,
          name: "Changed",
        },
        createDraft,
      ),
      true,
    );
    assert.equal(hasConfigDraftChanges(null, createDraft), false);
  });

  test("resolves the committed playlist handoff when a create draft becomes saveable", () => {
    const plan = resolveConfigBackTitleSharePlan({
      activeLayoutId: "collection-title:create",
      draft: {
        mode: "create",
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
      },
      draftBaseline: {
        mode: "create",
        name: "",
        collections: [],
        groups: [],
      },
    });

    assert.equal(plan.hasDraftChanges, true);
    assert.equal(plan.returnLayoutId, "playlist-title:Quiet Morning");
    assert.deepEqual(plan.titleToneHandoff, {
      layoutId: "playlist-title:Quiet Morning",
      tone: "solid",
    });
  });

  test("keeps the original layout id when config draft did not change", () => {
    const plan = resolveConfigBackTitleSharePlan({
      activeLayoutId: "playlist-title:Quiet Morning",
      draft: {
        mode: "edit",
        name: "Quiet Morning",
        collections: [],
        groups: [],
      },
      draftBaseline: {
        mode: "edit",
        name: "Quiet Morning",
        collections: [],
        groups: [],
      },
    });

    assert.equal(plan.hasDraftChanges, false);
    assert.equal(plan.returnLayoutId, "playlist-title:Quiet Morning");
    assert.deepEqual(plan.titleToneHandoff, {
      layoutId: "playlist-title:Quiet Morning",
      tone: "solid",
    });
  });

  test("derives muted tones from empty draft titles", () => {
    assert.equal(
      resolveTitleShareToneFromDraft({
        mode: "create",
        name: "",
        collections: [],
        groups: [],
      }),
      "muted",
    );
  });
});
