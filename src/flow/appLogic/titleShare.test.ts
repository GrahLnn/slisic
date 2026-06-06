import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  composeTitleShareArrows,
  createTitleShareArrow,
  createTitleShareEndpoint,
  hasConfigDraftChanges,
  resolveTitleShareEndpointInstruction,
  resolveConfigBackTitleSharePlan,
  resolveTitleShareHoverVisual,
  resolveTitleSharePageTransition,
  resolveTitleShareToneFromDraft,
  shouldSuppressTitleShareFade,
} from "./titleShare";

describe("titleShare", () => {
  const extraTrack = {
    name: "Extra Track",
    alias: "Extra Track",
    group: {
      name: "Disc 1",
      url: "https://example.com/extra#disc-1",
      collection: {
        name: "Extra",
        url: "https://example.com/extra",
        folder: "youtube/extra",
        last_updated: "2026-04-13T00:00:00Z",
        enable_updates: null,
      },
      folder: "Disc 1",
    },
    canonical_music_id: "source:https://example.com/extra:0:120000",
    url: "https://example.com/extra",
    path: "Disc 1/Extra Track.m4a",
    start_ms: 0,
    end_ms: 120_000,
    liked: false,
    loudness: 0,
  };

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
    assert.equal(shouldSuppressTitleShareFade("playlist-title:PlayList 1", transition), true);
    assert.equal(shouldSuppressTitleShareFade("collection-title:create", transition), false);
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
    assert.equal(shouldSuppressTitleShareFade("playlist-title:PlayList 1", transition), true);
    assert.equal(shouldSuppressTitleShareFade("collection-title:create", transition), false);
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
    assert.equal(shouldSuppressTitleShareFade("playlist-title:PlayList 1", transition), false);
    assert.equal(shouldSuppressTitleShareFade("playlist-title:PlayList 2", transition), false);
  });

  test("does not let an old pressed source suppress a returning target", () => {
    const transition = resolveTitleSharePageTransition({
      activeLayoutId: null,
      titleToneHandoff: {
        layoutId: "playlist-title:PlayList 1",
        tone: "solid",
      },
      pressedLayoutId: null,
    });

    assert.equal(transition.committedLayoutId, null);
    assert.equal(transition.returnTargetLayoutId, "playlist-title:PlayList 1");
  });

  test("derives the title hover visual from the active transition role", () => {
    assert.equal(
      resolveTitleShareHoverVisual({
        layoutId: "playlist-title:PlayList 1",
        sourceLayoutId: "playlist-title:PlayList 1",
        targetLayoutId: null,
      }),
      "hold",
    );
    assert.equal(
      resolveTitleShareHoverVisual({
        layoutId: "playlist-title:PlayList 1",
        sourceLayoutId: null,
        targetLayoutId: "playlist-title:PlayList 1",
      }),
      "retain",
    );
    assert.equal(
      resolveTitleShareHoverVisual({
        layoutId: "playlist-title:PlayList 2",
        sourceLayoutId: "playlist-title:PlayList 1",
        targetLayoutId: null,
      }),
      "none",
    );
  });

  test("keeps equal layout ids separate across endpoint kinds", () => {
    const arrow = createTitleShareArrow({
      kind: "list-to-play",
      source: createTitleShareEndpoint("list", "playlist-title:PlayList 1"),
      target: createTitleShareEndpoint("play", "playlist-title:PlayList 1"),
    });

    assert.deepEqual(
      resolveTitleShareEndpointInstruction({
        arrow,
        endpoint: createTitleShareEndpoint("list", "playlist-title:PlayList 1"),
      }),
      {
        titleHoverVisual: "hold",
        titleHoverRetainLease: "timed",
      },
    );
    assert.deepEqual(
      resolveTitleShareEndpointInstruction({
        arrow,
        endpoint: createTitleShareEndpoint("play", "playlist-title:PlayList 1"),
      }),
      {
        titleHoverVisual: "retain",
        titleHoverRetainLease: "timed",
      },
    );
  });

  test("rejects undeclared title handoff composition instead of assuming associativity", () => {
    const listEndpoint = createTitleShareEndpoint("list", "playlist-title:PlayList 1");
    const playEndpoint = createTitleShareEndpoint("play", "playlist-title:PlayList 1");
    const spectrumEndpoint = createTitleShareEndpoint("spectrum", "playlist-title:PlayList 1");

    assert.deepEqual(
      composeTitleShareArrows(
        createTitleShareArrow({
          kind: "list-to-play",
          source: listEndpoint,
          target: playEndpoint,
        }),
        createTitleShareArrow({
          kind: "play-to-spectrum",
          source: playEndpoint,
          target: spectrumEndpoint,
        }),
      ),
      {
        kind: "rejected",
        reason: "undeclared-composition",
      },
    );
  });

  test("does not collapse a non-identity round trip into identity", () => {
    const listEndpoint = createTitleShareEndpoint("list", "playlist-title:PlayList 1");
    const playEndpoint = createTitleShareEndpoint("play", "playlist-title:PlayList 1");

    assert.deepEqual(
      composeTitleShareArrows(
        createTitleShareArrow({
          kind: "list-to-play",
          source: listEndpoint,
          target: playEndpoint,
        }),
        createTitleShareArrow({
          kind: "play-to-list",
          source: playEndpoint,
          target: listEndpoint,
        }),
      ),
      {
        kind: "rejected",
        reason: "undeclared-composition",
      },
    );
  });

  test("allows explicit identity arrows to pass through composition", () => {
    const listEndpoint = createTitleShareEndpoint("list", "playlist-title:PlayList 1");
    const playEndpoint = createTitleShareEndpoint("play", "playlist-title:PlayList 1");
    const listToPlay = createTitleShareArrow({
      kind: "list-to-play",
      source: listEndpoint,
      target: playEndpoint,
    });

    assert.deepEqual(
      composeTitleShareArrows(
        createTitleShareArrow({
          kind: "identity",
          source: listEndpoint,
          target: listEndpoint,
        }),
        listToPlay,
      ),
      {
        kind: "composed",
        arrow: listToPlay,
      },
    );
  });

  test("marks config drafts as changed only when their canonical content differs", () => {
    const createDraft = {
      mode: "create" as const,
      name: "",
      collections: [],
      groups: [],
      extra: [],
      createdAt: null,
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

  test("keeps pop-then-push reordered draft refs equivalent to the baseline", () => {
    const baseline = {
      mode: "edit" as const,
      name: "Focus Session",
      collections: [
        {
          name: "Ambient One",
          url: "https://example.com/ambient-one",
          folder: "youtube/ambient-one",
          last_updated: "2026-04-13T00:00:00Z",
          enable_updates: null,
        },
        {
          name: "Ambient Two",
          url: "https://example.com/ambient-two",
          folder: "youtube/ambient-two",
          last_updated: "2026-04-14T00:00:00Z",
          enable_updates: true,
        },
      ],
      groups: [
        {
          name: "Disc A",
          url: "https://example.com/disc-a",
          folder: "Disc A",
        },
        {
          name: "Disc B",
          url: "https://example.com/disc-b",
          folder: "Disc B",
        },
      ],
      extra: [],
      createdAt: "2026-04-13T00:00:00Z",
    };

    assert.equal(
      hasConfigDraftChanges(
        {
          ...baseline,
          collections: [...baseline.collections].reverse(),
          groups: [...baseline.groups].reverse(),
          extra: [...baseline.extra].reverse(),
        },
        baseline,
      ),
      false,
    );
  });

  test("keeps reordered extra refs equivalent to the baseline", () => {
    const baseline = {
      mode: "edit" as const,
      name: "Focus Session",
      collections: [],
      groups: [],
      extra: [
        extraTrack,
        {
          ...extraTrack,
          canonical_music_id: "source:https://example.com/extra-b:0:120000",
          url: "https://example.com/extra-b",
        },
      ],
      createdAt: "2026-04-13T00:00:00Z",
    };

    assert.equal(
      hasConfigDraftChanges(
        {
          ...baseline,
          extra: [...baseline.extra].reverse(),
        },
        baseline,
      ),
      false,
    );
  });

  test("still marks draft refs as changed when canonical item content differs", () => {
    const baseline = {
      mode: "edit" as const,
      name: "Focus Session",
      collections: [
        {
          name: "Ambient One",
          url: "https://example.com/ambient-one",
          folder: "youtube/ambient-one",
          last_updated: "2026-04-13T00:00:00Z",
          enable_updates: null,
        },
      ],
      groups: [
        {
          name: "Disc A",
          url: "https://example.com/disc-a",
          folder: "Disc A",
        },
      ],
      extra: [],
      createdAt: "2026-04-13T00:00:00Z",
    };

    assert.equal(
      hasConfigDraftChanges(
        {
          ...baseline,
          collections: [
            {
              ...baseline.collections[0],
              enable_updates: true,
            },
          ],
        },
        baseline,
      ),
      true,
    );
    assert.equal(
      hasConfigDraftChanges(
        {
          ...baseline,
          groups: [
            {
              ...baseline.groups[0],
              folder: "Renamed Disc A",
            },
          ],
        },
        baseline,
      ),
      true,
    );
    assert.equal(
      hasConfigDraftChanges(
        {
          ...baseline,
          extra: [extraTrack],
        },
        baseline,
      ),
      true,
    );
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
            last_updated: "2026-04-13T00:00:00Z",
            enable_updates: null,
          },
        ],
        groups: [],
        extra: [],
        createdAt: null,
      },
      draftBaseline: {
        mode: "create",
        name: "",
        collections: [],
        groups: [],
        extra: [],
        createdAt: null,
      },
    });

    assert.equal(plan.hasDraftChanges, true);
    assert.equal(plan.sourceLayoutId, "playlist-title:Quiet Morning");
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
        extra: [],
        createdAt: null,
      },
      draftBaseline: {
        mode: "edit",
        name: "Quiet Morning",
        collections: [],
        groups: [],
        extra: [],
        createdAt: null,
      },
    });

    assert.equal(plan.hasDraftChanges, false);
    assert.equal(plan.sourceLayoutId, "playlist-title:Quiet Morning");
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
        extra: [],
        createdAt: null,
      }),
      "muted",
    );
  });
});
