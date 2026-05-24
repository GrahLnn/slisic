import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { me } from "@grahlnn/fn";
import {
  createConfigSidebarItemRef,
  resolveSavedPath,
  type ConfigDraft,
} from "@/src/flow/appLogic/core";
import { hasConfigDraftChanges } from "@/src/flow/appLogic/titleShare";
import type { Music } from "@/src/cmd";
import type { ConfigCandidateItem } from "@/src/flow/pasteDownload/core";
import {
  LIST_CONFIG_EMPTY_STATE_TEXT,
  shouldHideListConfigToolLabelRowContent,
} from "./ListConfig";
import {
  createListConfigArcTrackItems,
  createListConfigCandidateToolLabelItems,
  createListConfigExcludeToolLabelItems,
  createListConfigPlaylistSidebarItems,
  createListConfigPlaylistToolLabelItems,
  createListConfigToolLabelLayoutId,
  createListConfigTitleSnapshot,
  countListConfigParsingCandidateItems,
  hasListConfigParsingCandidateItems,
  resolveListConfigTitlePlaceholder,
  resolveListConfigEmptyState,
  resolveListConfigExcludeToolLabelText,
  resolveListConfigInteractionFlags,
  resolveListConfigCollectionUpdatesToolText,
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
  createdAt: null,
};

const editDraft: ConfigDraft = {
  mode: "edit",
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
  createdAt: "2026-04-13T00:00:00Z",
};

const draftWithGroup: ConfigDraft = {
  mode: "edit",
  name: "Focus Session",
  collections: [
    {
      name: "Quiet Morning",
      url: "https://example.com/quiet-morning",
      folder: "youtube/quiet-morning",
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
  createdAt: "2026-04-13T00:00:00Z",
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
    status: "probing",
    error: null,
    probe: {
      url: "https://www.youtube.com/watch?v=abc123",
      source_kind: "single",
      title: "Quiet Morning",
      item_count: 1,
      collection_folder: "youtube/quiet-morning",
      enable_updates: null,
    },
  },
  {
    id: "candidate:1",
    rawText: "not a url",
    sourceUrl: null,
    displayText: "not a url",
    status: "invalid_url",
    error: "Clipboard does not contain a valid URL.",
    probe: null,
  },
];

const excludedMusic: Music = {
  name: "Blocked Track",
  alias: "Blocked Alias",
  group: {
    name: "Blocked Collection",
    url: "https://example.com/blocked-collection",
    folder: "youtube/blocked-collection",
  },
  canonical_music_id: "source:https://example.com/watch?v=blocked:0:180000",
  url: "https://example.com/watch?v=blocked",
  path: "Blocked Track.m4a",
  start_ms: 0,
  end_ms: 180_000,
  liked: false,
};

const emptyExcludeAvailability = {
  fully_excluded_collection_urls: [],
  fully_excluded_group_urls: [],
};

describe("ListConfig title view model", () => {
  test("hides the left row content only while a playlist item is leaving toward the arc track", () => {
    assert.equal(
      shouldHideListConfigToolLabelRowContent({
        item: {
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
        activeGhostLayoutId: "playlist:collection:https://example.com/quiet-morning",
        activeGhostTargetOwnerId: "arc-track",
      }),
      true,
    );
  });

  test("keeps the push target visible while the incoming ghost docks into the left list", () => {
    assert.equal(
      shouldHideListConfigToolLabelRowContent({
        item: {
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
        activeGhostLayoutId: "playlist:collection:https://example.com/quiet-morning",
        activeGhostTargetOwnerId: "tool-label",
      }),
      false,
    );
  });

  test("captures the live create draft title snapshot", () => {
    assert.deepEqual(
      createListConfigTitleSnapshot({
        activeLayoutId: "collection-title:create",
        draft: createDraft,
        draftBaseline: null,
      }),
      {
        layoutId: "collection-title:create",
        value: "",
        placeholder: "Create a List",
      },
    );
  });

  test("stays empty without an active title layout id", () => {
    assert.deepEqual(
      resolveListConfigTitleViewModel({
        activeLayoutId: null,
        draft: null,
        draftBaseline: null,
        titleToneHandoff: null,
      }),
      {
        snapshot: null,
        autoFocus: false,
        handoffTone: null,
        layoutId: undefined,
        titleHoverVisual: "none",
        titleNativeHoverEnabled: false,
        placeholder: undefined,
        value: "",
      },
    );
  });

  test("uses the baseline edit title as the placeholder", () => {
    assert.deepEqual(
      resolveListConfigTitleViewModel({
        activeLayoutId: "playlist-title:Quiet Morning",
        draft: editDraft,
        draftBaseline: editDraft,
        pendingPlaylistName: null,
        titleToneHandoff: null,
      }),
      {
        snapshot: {
          layoutId: "playlist-title:Quiet Morning",
          value: "Quiet Morning",
          placeholder: "Quiet Morning",
        },
        autoFocus: false,
        handoffTone: null,
        layoutId: "playlist-title:Quiet Morning",
        titleHoverVisual: "none",
        titleNativeHoverEnabled: false,
        placeholder: "Quiet Morning",
        value: "Quiet Morning",
      },
    );
  });

  test("retains the title hover visual while the config title receives an entering handoff", () => {
    assert.equal(
      resolveListConfigTitleViewModel({
        activeLayoutId: "playlist-title:Quiet Morning",
        draft: editDraft,
        draftBaseline: editDraft,
        pendingPlaylistName: null,
        titleToneHandoff: {
          layoutId: "playlist-title:Quiet Morning",
          tone: "solid",
        },
      }).titleHoverVisual,
      "retain",
    );
  });

  test("keeps the config title hover separate from the handoff retain visual", () => {
    assert.equal(
      resolveListConfigTitleViewModel({
        activeLayoutId: "playlist-title:Quiet Morning",
        draft: editDraft,
        draftBaseline: editDraft,
        pendingPlaylistName: null,
        titleToneHandoff: {
          layoutId: "playlist-title:Quiet Morning",
          tone: "solid",
        },
      }).titleNativeHoverEnabled,
      false,
    );
  });

  test("falls back to the baseline edit title after the user clears the current title", () => {
    assert.equal(
      resolveListConfigTitlePlaceholder({
        draft: {
          ...editDraft,
          name: "",
        },
        draftBaseline: editDraft,
      }),
      "Quiet Morning",
    );
  });

  test("creates a loading snapshot from the pending playlist name before the draft arrives", () => {
    assert.deepEqual(
      createListConfigTitleSnapshot({
        activeLayoutId: "playlist-title:Quiet Morning",
        draft: null,
        draftBaseline: null,
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
        isBackActionProcessing: false,
      }),
      {
        isBackActionInteractionLocked: false,
        isTitleInteractionDisabled: true,
        isToolListInteractionDisabled: true,
        shouldRenderArcTrack: false,
      },
    );
    assert.deepEqual(
      resolveListConfigInteractionFlags({
        isPresent: true,
        arcTrackItemCount: 2,
        isBackActionProcessing: false,
      }),
      {
        isBackActionInteractionLocked: false,
        isTitleInteractionDisabled: false,
        isToolListInteractionDisabled: false,
        shouldRenderArcTrack: true,
      },
    );
    assert.deepEqual(
      resolveListConfigInteractionFlags({
        isPresent: true,
        arcTrackItemCount: 2,
        isBackActionProcessing: true,
      }),
      {
        isBackActionInteractionLocked: true,
        isTitleInteractionDisabled: false,
        isToolListInteractionDisabled: false,
        shouldRenderArcTrack: true,
      },
    );
  });

  test("prefers meta.save_path over the generated default save path", () => {
    assert.equal(
      resolveSavedPath("D:\\MediaLibrary", "C:\\Users\\admin\\Documents\\slisic"),
      "D:\\MediaLibrary",
    );
  });

  test("falls back to the generated default save path when meta.save_path is empty", () => {
    assert.equal(
      resolveSavedPath(null, "C:\\Users\\admin\\Documents\\slisic"),
      "C:\\Users\\admin\\Documents\\slisic",
    );
    assert.equal(
      resolveSavedPath("", "C:\\Users\\admin\\Documents\\slisic"),
      "C:\\Users\\admin\\Documents\\slisic",
    );
  });

  test("marks the draft as changed only when it differs from the session baseline", () => {
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
        id: createListConfigToolLabelLayoutId({
          kind: "collection",
          url: "https://www.youtube.com/watch?v=abc123",
        }),
        candidateId: "candidate:0",
        text: "Quiet Morning",
        status: "probing",
      },
      {
        kind: "candidate",
        id: "candidate:1",
        candidateId: "candidate:1",
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
        createdAt: "2026-04-13T00:00:00Z",
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
          id: createListConfigToolLabelLayoutId({
            kind: "collection",
            url: "https://www.youtube.com/watch?v=abc123",
          }),
          candidateId: "candidate:0",
          text: "Quiet Morning",
          status: "probing",
        },
        {
          kind: "candidate",
          id: "candidate:1",
          candidateId: "candidate:1",
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
        id: createListConfigToolLabelLayoutId({
          kind: "collection",
          url: "https://www.youtube.com/watch?v=abc123",
        }),
        candidateId: "candidate:0",
        text: "Quiet Morning",
        status: "probing",
      }),
      "passive",
    );
    assert.equal(
      resolveListConfigToolLabelAffordance({
        kind: "candidate",
        id: "candidate:1",
        candidateId: "candidate:1",
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
        excludeAvailability: emptyExcludeAvailability,
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
            status: "probing",
            error: null,
            probe: null,
          },
        ],
        excludeAvailability: emptyExcludeAvailability,
      }),
      [],
    );
  });

  test("removes fully excluded collection and group owners from the arc-track", () => {
    const collectionUrl = "https://example.com/blocked-collection";
    const groupUrl = `${collectionUrl}#disc-1`;

    assert.deepEqual(
      createListConfigArcTrackItems({
        libraryItems: [
          {
            kind: "collection",
            name: "Blocked Collection",
            url: collectionUrl,
            folder: "youtube/blocked-collection",
          },
          {
            kind: "group",
            name: "Disc 1",
            url: groupUrl,
            folder: "Disc 1",
          },
          {
            kind: "collection",
            name: "Playable Collection",
            url: "https://example.com/playable-collection",
            folder: "youtube/playable-collection",
          },
        ],
        playlistItems: [],
        candidateItems: [],
        excludeAvailability: {
          fully_excluded_collection_urls: [collectionUrl],
          fully_excluded_group_urls: [groupUrl],
        },
      }),
      [
        {
          kind: "collection",
          name: "Playable Collection",
          url: "https://example.com/playable-collection",
          folder: "youtube/playable-collection",
        },
      ],
    );
  });

  test("adds strike-through styling and delete-only tools to failed candidates", () => {
    assert.match(
      resolveListConfigToolLabelTextClassName({
        kind: "candidate",
        id: "candidate:1",
        candidateId: "candidate:1",
        text: "not a url",
        status: "invalid_url",
      }),
      /line-through/,
    );
    assert.equal(
      resolveListConfigToolLabelAffordance({
        kind: "candidate",
        id: "candidate:1",
        candidateId: "candidate:1",
        text: "not a url",
        status: "invalid_url",
      }),
      "candidate-delete",
    );
    assert.equal(
      resolveListConfigToolLabelAffordance({
        kind: "candidate",
        id: createListConfigToolLabelLayoutId({
          kind: "collection",
          url: "https://www.youtube.com/watch?v=abc123",
        }),
        candidateId: "candidate:0",
        text: "Quiet Morning",
        status: "probing",
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

  test("derives exclude tool labels from excluded music identity", () => {
    assert.equal(resolveListConfigExcludeToolLabelText(excludedMusic), "Blocked Alias");
    assert.deepEqual(
      createListConfigExcludeToolLabelItems([
        {
          music: excludedMusic,
          created_at: "2026-05-20T00:00:00Z",
        },
      ]),
      [
        {
          kind: "exclude",
          id: "exclude:https://example.com/watch?v=blocked:0:180000",
          music: excludedMusic,
          text: "Blocked Alias",
        },
      ],
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

  test("switches to the draft playlist item as soon as a matching collection enters draft", () => {
    assert.deepEqual(
      resolveListConfigToolLabelItems({
        playlistItems: [
          {
            kind: "collection",
            name: "Quiet Morning",
            url: "https://www.youtube.com/watch?v=abc123",
            folder: "youtube/quiet-morning",
            enableUpdates: null,
          },
        ],
        candidateItems: [
          {
            id: "candidate:0",
            rawText: "https://www.youtube.com/watch?v=abc123",
            sourceUrl: "https://www.youtube.com/watch?v=abc123",
            displayText: "Quiet Morning",
            status: "probing",
            error: null,
            probe: null,
          },
        ],
      }),
      [
        {
          kind: "playlist",
          id: createListConfigToolLabelLayoutId({
            kind: "collection",
            url: "https://www.youtube.com/watch?v=abc123",
          }),
          ref: createConfigSidebarItemRef({
            kind: "collection",
            url: "https://www.youtube.com/watch?v=abc123",
          }),
          text: "Quiet Morning",
          sourceKind: "collection",
          enableUpdates: null,
        },
      ],
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
      excludeItems: [],
      excludeAvailability: emptyExcludeAvailability,
      candidateItems: [],
      previousEmptyState: null,
    });

    assert.equal(viewModel.title.value, "Focus Session");
    assert.equal(viewModel.title.layoutId, "playlist-title:Focus Session");
    assert.equal(viewModel.hasDraftChanges, true);
    assert.equal(viewModel.isBackActionParsing, false);
    assert.equal(viewModel.interactionFlags.isBackActionInteractionLocked, false);
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

  test("defers arc-track rendering while an existing playlist draft is still loading", () => {
    const viewModel = resolveListConfigViewModel({
      activeLayoutId: "playlist-title:Focus Session",
      draft: null,
      draftBaseline: null,
      pendingPlaylistName: "Focus Session",
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
      excludeItems: [],
      excludeAvailability: emptyExcludeAvailability,
      candidateItems: [],
      previousEmptyState: null,
    });

    assert.equal(viewModel.title.value, "Focus Session");
    assert.deepEqual(viewModel.arcTrackItems, []);
    assert.equal(viewModel.interactionFlags.shouldRenderArcTrack, false);
    assert.equal(viewModel.shouldShowEmptyState, false);
  });

  test("marks the back action as parsing while candidate checks or probes still exist", () => {
    assert.equal(
      countListConfigParsingCandidateItems([
        ...candidateItems,
        {
          id: "candidate:checking",
          rawText: "https://example.com/pending",
          sourceUrl: null,
          displayText: "https://example.com/pending",
          status: "checking",
          error: null,
          probe: null,
        },
        {
          id: "candidate:probing",
          rawText: "https://example.com/live",
          sourceUrl: "https://example.com/live",
          displayText: "https://example.com/live",
          status: "probing",
          error: null,
          probe: null,
        },
      ]),
      3,
    );
    assert.equal(hasListConfigParsingCandidateItems(candidateItems), true);

    const viewModel = resolveListConfigViewModel({
      activeLayoutId: "playlist-title:Focus Session",
      draft: draftWithGroup,
      draftBaseline: draftWithGroup,
      pendingPlaylistName: null,
      titleToneHandoff: null,
      isPresent: true,
      libraryItems: librarySidebarItems,
      excludeItems: [
        {
          music: excludedMusic,
          created_at: "2026-05-20T00:00:00Z",
        },
      ],
      excludeAvailability: emptyExcludeAvailability,
      candidateItems: [
        ...candidateItems,
        {
          id: "candidate:probing",
          rawText: "https://example.com/live",
          sourceUrl: "https://example.com/live",
          displayText: "https://example.com/live",
          status: "probing",
          error: null,
          probe: null,
        },
      ],
      previousEmptyState: null,
    });

    assert.equal(viewModel.isBackActionParsing, true);
    assert.equal(viewModel.interactionFlags.isBackActionInteractionLocked, true);
    assert.equal(viewModel.interactionFlags.isTitleInteractionDisabled, false);
    assert.equal(viewModel.interactionFlags.isToolListInteractionDisabled, false);
    assert.equal(viewModel.excludeToolLabelItems[0]?.text, "Blocked Alias");
  });
});
