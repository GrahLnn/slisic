import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { me } from "@grahlnn/fn";
import { createConfigSidebarItemRef, type ConfigDraft } from "@/src/flow/appLogic/core";
import type { ConfigCandidateItem } from "@/src/flow/pasteDownload/core";
import { LIST_CONFIG_EMPTY_STATE_TEXT } from "./ListConfig";
import {
  createListConfigArcTrackItems,
  createListConfigCandidateToolLabelItems,
  createListConfigPlaylistSidebarItems,
  createListConfigPlaylistToolLabelItems,
  createListConfigTitleSnapshot,
  resolveListConfigEmptyState,
  resolveListConfigInteractionFlags,
  resolveListConfigCollectionUpdatesToolText,
  resolveListConfigSavePath,
  resolveListConfigHasDraftChanges,
  resolveListConfigToolLabelAffordance,
  resolveListConfigToolLabelItems,
  resolveListConfigToolLabelTextClassName,
  resolveListConfigTitleViewModel,
  resolveListConfigViewModel,
  shouldShowListConfigAutoDownloadIcon,
  shouldShowListConfigEnableUpdateTool,
  shouldShowListConfigEmptyState,
} from "./ListConfig.view-model";

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

const draftWithGroup: ConfigDraft = {
  mode: "edit",
  name: "Focus Session",
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
  groups: [
    {
      name: "Disc 1",
      url: "https://example.com/quiet-morning#disc-1",
      folder: "Disc 1",
    },
  ],
};

const librarySidebarItems = [
  {
    kind: "collection",
    name: "Quiet Morning",
    url: "https://example.com/quiet-morning",
    folder: "youtube/quiet-morning",
    enableUpdates: null,
  },
  {
    kind: "group",
    name: "Disc 1",
    url: "https://example.com/quiet-morning#disc-1",
    folder: "Disc 1",
    enableUpdates: null,
  },
] as const;

const candidateItems: ConfigCandidateItem[] = [
  {
    id: "candidate:0",
    rawText: "https://www.youtube.com/watch?v=abc123",
    sourceUrl: "https://www.youtube.com/watch?v=abc123",
    displayText: "Quiet Morning",
    status: "resolved",
    error: null,
    probe: {
      url: "https://www.youtube.com/watch?v=abc123",
      source_kind: "single",
      title: "Quiet Morning",
      item_count: 1,
    },
    task: null,
  },
  {
    id: "candidate:1",
    rawText: "not a url",
    sourceUrl: null,
    displayText: "not a url",
    status: "invalid_url",
    error: "Clipboard does not contain a valid URL.",
    probe: null,
    task: null,
  },
];

describe("ListConfig title view model", () => {
  test("captures the live create draft title snapshot", () => {
    assert.deepEqual(
      createListConfigTitleSnapshot({
        activeLayoutId: "collection-title:create",
        draft: createDraft,
      }),
      {
        layoutId: "collection-title:create",
        value: "",
        placeholder: "Create a List",
      },
    );
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
        pendingPlaylistName: null,
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

  test("creates a loading snapshot from the pending playlist name before the draft arrives", () => {
    assert.deepEqual(
      createListConfigTitleSnapshot({
        activeLayoutId: "playlist-title:Quiet Morning",
        draft: null,
        pendingPlaylistName: "Quiet Morning",
      }),
      {
        layoutId: "playlist-title:Quiet Morning",
        value: "Quiet Morning",
        placeholder: undefined,
      },
    );
  });

  test("derives interaction flags from presence and visible arc-track items", () => {
    assert.deepEqual(
      resolveListConfigInteractionFlags({
        isPresent: false,
        arcTrackItemCount: 0,
      }),
      {
        isTitleInteractionDisabled: true,
        isToolListInteractionDisabled: true,
        shouldRenderArcTrack: false,
      },
    );
    assert.deepEqual(
      resolveListConfigInteractionFlags({
        isPresent: true,
        arcTrackItemCount: 2,
      }),
      {
        isTitleInteractionDisabled: false,
        isToolListInteractionDisabled: false,
        shouldRenderArcTrack: true,
      },
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

  test("marks the draft as changed only when it differs from the session baseline", () => {
    assert.equal(resolveListConfigHasDraftChanges(createDraft, createDraft), false);
    assert.equal(
      resolveListConfigHasDraftChanges(
        {
          ...createDraft,
          name: "Changed",
        },
        createDraft,
      ),
      true,
    );
    assert.equal(resolveListConfigHasDraftChanges(null, createDraft), false);
  });

  test("creates playlist and candidate tool items with distinct kinds", () => {
    assert.deepEqual(createListConfigPlaylistSidebarItems(draftWithGroup), [
      {
        kind: "collection",
        name: "Quiet Morning",
        url: "https://example.com/quiet-morning",
        folder: "youtube/quiet-morning",
        enableUpdates: null,
      },
      {
        kind: "group",
        name: "Disc 1",
        url: "https://example.com/quiet-morning#disc-1",
        folder: "Disc 1",
        enableUpdates: null,
      },
    ]);
    assert.deepEqual(createListConfigPlaylistToolLabelItems(librarySidebarItems), [
      {
        kind: "playlist",
        id: "playlist:collection:https://example.com/quiet-morning",
        ref: createConfigSidebarItemRef({
          kind: "collection",
          url: "https://example.com/quiet-morning",
        }),
        text: "Quiet Morning",
        sourceKind: "collection",
        enableUpdates: null,
      },
      {
        kind: "playlist",
        id: "playlist:group:https://example.com/quiet-morning#disc-1",
        ref: createConfigSidebarItemRef({
          kind: "group",
          url: "https://example.com/quiet-morning#disc-1",
        }),
        text: "Disc 1",
        sourceKind: "group",
        enableUpdates: null,
      },
    ]);
    assert.deepEqual(createListConfigCandidateToolLabelItems(candidateItems), [
      {
        kind: "candidate",
        id: "candidate:0",
        text: "Quiet Morning",
        status: "resolved",
      },
      {
        kind: "candidate",
        id: "candidate:1",
        text: "not a url",
        status: "invalid_url",
      },
    ]);
  });

  test("prefers playlist collections over groups when names overlap", () => {
    assert.deepEqual(
      createListConfigPlaylistSidebarItems({
        mode: "edit",
        name: "Focus Session",
        collections: draftWithGroup.collections,
        groups: [
          ...draftWithGroup.groups,
          {
            name: "Quiet Morning",
            url: "https://example.com/group/quiet-morning",
            folder: "Quiet Morning",
          },
        ],
      }),
      [
        {
          kind: "collection",
          name: "Quiet Morning",
          url: "https://example.com/quiet-morning",
          folder: "youtube/quiet-morning",
          enableUpdates: null,
        },
        {
          kind: "group",
          name: "Disc 1",
          url: "https://example.com/quiet-morning#disc-1",
          folder: "Disc 1",
          enableUpdates: null,
        },
      ],
    );
  });

  test("prepends candidate items ahead of persisted playlist items", () => {
    assert.deepEqual(
      resolveListConfigToolLabelItems({
        playlistItems: createListConfigPlaylistSidebarItems(draftWithGroup),
        candidateItems,
      }),
      [
        {
          kind: "candidate",
          id: "candidate:0",
          text: "Quiet Morning",
          status: "resolved",
        },
        {
          kind: "candidate",
          id: "candidate:1",
          text: "not a url",
          status: "invalid_url",
        },
        {
          kind: "playlist",
          id: "playlist:collection:https://example.com/quiet-morning",
          ref: createConfigSidebarItemRef({
            kind: "collection",
            url: "https://example.com/quiet-morning",
          }),
          text: "Quiet Morning",
          sourceKind: "collection",
          enableUpdates: null,
        },
        {
          kind: "playlist",
          id: "playlist:group:https://example.com/quiet-morning#disc-1",
          ref: createConfigSidebarItemRef({
            kind: "group",
            url: "https://example.com/quiet-morning#disc-1",
          }),
          text: "Disc 1",
          sourceKind: "group",
          enableUpdates: null,
        },
      ],
    );
  });

  test("derives tool affordances from canonical item kind and status", () => {
    assert.equal(
      resolveListConfigToolLabelAffordance({
        kind: "playlist",
        id: "playlist:collection:https://example.com/quiet-morning",
        ref: createConfigSidebarItemRef({
          kind: "collection",
          url: "https://example.com/quiet-morning",
        }),
        text: "Quiet Morning",
        sourceKind: "collection",
        enableUpdates: null,
      }),
      "playlist",
    );
    assert.equal(
      resolveListConfigToolLabelAffordance({
        kind: "candidate",
        id: "candidate:0",
        text: "Quiet Morning",
        status: "resolved",
      }),
      "passive",
    );
    assert.equal(
      resolveListConfigToolLabelAffordance({
        kind: "candidate",
        id: "candidate:1",
        text: "not a url",
        status: "invalid_url",
      }),
      "candidate-delete",
    );
    assert.equal(
      resolveListConfigCollectionUpdatesToolText({
        kind: "playlist",
        id: "playlist:collection:https://example.com/quiet-morning",
        ref: createConfigSidebarItemRef({
          kind: "collection",
          url: "https://example.com/quiet-morning",
        }),
        text: "Quiet Morning",
        sourceKind: "collection",
        enableUpdates: false,
      }),
      "Enable Update",
    );
    assert.equal(
      resolveListConfigCollectionUpdatesToolText({
        kind: "playlist",
        id: "playlist:collection:https://example.com/quiet-morning",
        ref: createConfigSidebarItemRef({
          kind: "collection",
          url: "https://example.com/quiet-morning",
        }),
        text: "Quiet Morning",
        sourceKind: "collection",
        enableUpdates: true,
      }),
      "Disable Update",
    );
  });

  test("derives arc-track items from global library while excluding current playlist items", () => {
    assert.deepEqual(
      createListConfigArcTrackItems({
        libraryItems: [
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
          {
            kind: "collection",
            name: "Late Night Tape",
            url: "https://example.com/late-night-tape",
            folder: "youtube/late-night-tape",
          },
        ],
        playlistItems: createListConfigPlaylistSidebarItems(draftWithGroup),
        candidateItems: [],
      }),
      [
        {
          kind: "collection",
          name: "Late Night Tape",
          url: "https://example.com/late-night-tape",
          folder: "youtube/late-night-tape",
        },
      ],
    );
  });

  test("excludes resolved candidate urls from the arc-track while they are already foregrounded", () => {
    assert.deepEqual(
      createListConfigArcTrackItems({
        libraryItems: [
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
          {
            kind: "collection",
            name: "Night Walk",
            url: "https://www.youtube.com/watch?v=abc123",
            folder: "youtube/night-walk",
          },
        ],
        playlistItems: createListConfigPlaylistSidebarItems(draftWithGroup),
        candidateItems: [
          {
            id: "candidate:resolved",
            rawText: "https://www.youtube.com/watch?v=abc123",
            sourceUrl: "https://www.youtube.com/watch?v=abc123",
            displayText: "Night Walk",
            status: "resolved",
            error: null,
            probe: null,
            task: null,
          },
        ],
      }),
      [],
    );
  });

  test("adds strike-through styling and delete-only tools to failed candidates", () => {
    assert.match(
      resolveListConfigToolLabelTextClassName({
        kind: "candidate",
        id: "candidate:1",
        text: "not a url",
        status: "invalid_url",
      }),
      /line-through/,
    );
    assert.equal(
      resolveListConfigToolLabelAffordance({
        kind: "candidate",
        id: "candidate:1",
        text: "not a url",
        status: "invalid_url",
      }),
      "candidate-delete",
    );
    assert.equal(
      resolveListConfigToolLabelAffordance({
        kind: "candidate",
        id: "candidate:0",
        text: "Quiet Morning",
        status: "resolved",
      }),
      "passive",
    );
    assert.equal(
      resolveListConfigToolLabelAffordance({
        kind: "playlist",
        id: "playlist:collection:https://example.com/quiet-morning",
        ref: createConfigSidebarItemRef({
          kind: "collection",
          url: "https://example.com/quiet-morning",
        }),
        text: "Quiet Morning",
        sourceKind: "collection",
        enableUpdates: null,
      }),
      "playlist",
    );
    assert.equal(
      shouldShowListConfigEnableUpdateTool({
        kind: "playlist",
        id: "playlist:collection:https://example.com/quiet-morning",
        ref: createConfigSidebarItemRef({
          kind: "collection",
          url: "https://example.com/quiet-morning",
        }),
        text: "Quiet Morning",
        sourceKind: "collection",
        enableUpdates: false,
      }),
      true,
    );
    assert.equal(
      shouldShowListConfigEnableUpdateTool({
        kind: "playlist",
        id: "playlist:collection:https://example.com/quiet-morning",
        ref: createConfigSidebarItemRef({
          kind: "collection",
          url: "https://example.com/quiet-morning",
        }),
        text: "Quiet Morning",
        sourceKind: "collection",
        enableUpdates: null,
      }),
      false,
    );
    assert.equal(
      shouldShowListConfigEnableUpdateTool({
        kind: "playlist",
        id: "playlist:group:https://example.com/quiet-morning#disc-1",
        ref: createConfigSidebarItemRef({
          kind: "group",
          url: "https://example.com/quiet-morning#disc-1",
        }),
        text: "Disc 1",
        sourceKind: "group",
        enableUpdates: null,
      }),
      false,
    );
    assert.equal(
      shouldShowListConfigAutoDownloadIcon({
        kind: "playlist",
        id: "playlist:collection:https://example.com/quiet-morning",
        ref: createConfigSidebarItemRef({
          kind: "collection",
          url: "https://example.com/quiet-morning",
        }),
        text: "Quiet Morning",
        sourceKind: "collection",
        enableUpdates: true,
      }),
      true,
    );
    assert.equal(
      shouldShowListConfigAutoDownloadIcon({
        kind: "playlist",
        id: "playlist:collection:https://example.com/quiet-morning",
        ref: createConfigSidebarItemRef({
          kind: "collection",
          url: "https://example.com/quiet-morning",
        }),
        text: "Quiet Morning",
        sourceKind: "collection",
        enableUpdates: false,
      }),
      false,
    );
  });

  test("shows the empty-state hint when the playlist is empty and there are no candidates", () => {
    assert.equal(
      resolveListConfigEmptyState(
        shouldShowListConfigEmptyState({
          draft: createDraft,
          candidateItemCount: 0,
        }),
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

  test("hides the empty-state hint as soon as candidates exist", () => {
    assert.equal(
      resolveListConfigEmptyState(
        shouldShowListConfigEmptyState({
          draft: createDraft,
          candidateItemCount: 1,
        }),
        null,
      ).match({
        true: () => true,
        false: () => false,
      }),
      false,
    );
  });

  test("keeps the empty-state hint hidden once the playlist has content", () => {
    assert.equal(
      resolveListConfigEmptyState(
        shouldShowListConfigEmptyState({
          draft: editDraft,
          candidateItemCount: 0,
        }),
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
      resolveListConfigEmptyState(
        shouldShowListConfigEmptyState({
          draft: null,
          candidateItemCount: 0,
        }),
        me(true),
      ).match({
        true: () => true,
        false: () => false,
      }),
      true,
    );
    assert.equal(
      resolveListConfigEmptyState(
        shouldShowListConfigEmptyState({
          draft: null,
          candidateItemCount: 0,
        }),
        me(false),
      ).match({
        true: () => true,
        false: () => false,
      }),
      false,
    );
  });

  test("resolves the full screen view model from canonical state and animation memory", () => {
    const viewModel = resolveListConfigViewModel({
      activeLayoutId: "playlist-title:Focus Session",
      draft: draftWithGroup,
      draftBaseline: {
        ...draftWithGroup,
        name: "Original Name",
      },
      pendingPlaylistName: null,
      titleToneHandoff: null,
      isPresent: true,
      libraryItems: [
        {
          kind: "collection",
          name: "Quiet Morning",
          url: "https://example.com/quiet-morning",
          folder: "youtube/quiet-morning",
        },
        {
          kind: "collection",
          name: "Late Night Tape",
          url: "https://example.com/late-night-tape",
          folder: "youtube/late-night-tape",
        },
      ],
      candidateItems: [],
      previousTitleSnapshot: null,
      previousEmptyState: null,
    });

    assert.equal(viewModel.title.value, "Focus Session");
    assert.equal(viewModel.title.layoutId, "playlist-title:Focus Session");
    assert.equal(viewModel.hasDraftChanges, true);
    assert.equal(viewModel.interactionFlags.isToolListInteractionDisabled, false);
    assert.equal(viewModel.interactionFlags.shouldRenderArcTrack, true);
    assert.equal(viewModel.shouldShowEmptyState, false);
    assert.deepEqual(viewModel.arcTrackItems, [
      {
        kind: "collection",
        name: "Late Night Tape",
        url: "https://example.com/late-night-tape",
        folder: "youtube/late-night-tape",
      },
    ]);
  });
});
