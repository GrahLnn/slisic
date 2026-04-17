import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { me } from "@grahlnn/fn";
import type { ConfigDraft } from "@/src/flow/appLogic/core";
import type { ConfigCandidateItem } from "@/src/flow/pasteDownload/core";
import {
  LIST_CONFIG_EMPTY_STATE_TEXT,
  createListConfigArcTrackItems,
  createListConfigCandidateToolLabelItems,
  createListConfigPlaylistSidebarItems,
  createListConfigPlaylistToolLabelItems,
  createListConfigTitleSnapshot,
  resolveListConfigEmptyState,
  resolveListConfigSavePath,
  resolveListConfigShouldShowDeleteOnlyTool,
  shouldShowListConfigAutoDownloadIcon,
  resolveListConfigToolLabelItems,
  resolveListConfigToolLabelTextClassName,
  resolveListConfigToolListInteractionDisabled,
  resolveListConfigTitleViewModel,
  shouldShowListConfigCandidateDeleteTool,
  shouldShowListConfigEnableUpdateTool,
  shouldShowListConfigEmptyState,
  shouldShowListConfigPlaylistHoverTool,
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
        text: "Quiet Morning",
        sourceKind: "collection",
        enableUpdates: null,
      },
      {
        kind: "playlist",
        id: "playlist:group:https://example.com/quiet-morning#disc-1",
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
      resolveListConfigToolLabelItems(
        {
          playlistItems: createListConfigPlaylistSidebarItems(draftWithGroup),
          candidateItems,
        },
        new Set(),
      ),
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
          text: "Quiet Morning",
          sourceKind: "collection",
          enableUpdates: null,
        },
        {
          kind: "playlist",
          id: "playlist:group:https://example.com/quiet-morning#disc-1",
          text: "Disc 1",
          sourceKind: "group",
          enableUpdates: null,
        },
      ],
    );
  });

  test("filters popped persisted items without affecting candidates", () => {
    assert.deepEqual(
      resolveListConfigToolLabelItems(
        {
          playlistItems: createListConfigPlaylistSidebarItems(draftWithGroup),
          candidateItems,
        },
        new Set(["playlist:group:https://example.com/quiet-morning#disc-1"]),
      ),
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
          text: "Quiet Morning",
          sourceKind: "collection",
          enableUpdates: null,
        },
      ],
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
    assert.equal(resolveListConfigShouldShowDeleteOnlyTool("invalid_url"), true);
    assert.equal(resolveListConfigShouldShowDeleteOnlyTool("resolved"), false);
    assert.equal(
      shouldShowListConfigPlaylistHoverTool({
        kind: "candidate",
        id: "candidate:0",
        text: "Quiet Morning",
        status: "resolved",
      }),
      true,
    );
    assert.equal(
      shouldShowListConfigPlaylistHoverTool({
        kind: "candidate",
        id: "candidate:1",
        text: "not a url",
        status: "invalid_url",
      }),
      false,
    );
    assert.equal(
      shouldShowListConfigPlaylistHoverTool({
        kind: "playlist",
        id: "playlist:collection:https://example.com/quiet-morning",
        text: "Quiet Morning",
        sourceKind: "collection",
        enableUpdates: null,
      }),
      true,
    );
    assert.equal(
      shouldShowListConfigCandidateDeleteTool({
        kind: "candidate",
        id: "candidate:1",
        text: "not a url",
        status: "invalid_url",
      }),
      true,
    );
    assert.equal(
      shouldShowListConfigCandidateDeleteTool({
        kind: "playlist",
        id: "playlist:collection:https://example.com/quiet-morning",
        text: "Quiet Morning",
        sourceKind: "collection",
        enableUpdates: null,
      }),
      false,
    );
    assert.equal(
      shouldShowListConfigEnableUpdateTool({
        kind: "playlist",
        id: "playlist:collection:https://example.com/quiet-morning",
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
});
