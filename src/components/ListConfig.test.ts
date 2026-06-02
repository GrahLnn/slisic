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
  consumeListConfigDuplicateShakeState,
  resolveListConfigDuplicateShakeDecision,
  resolveToolLabelShakeSignal,
  shouldHideListConfigToolLabelRowContent,
  type ListConfigDuplicateShakeState,
} from "./ListConfig";
import {
  createListConfigArcTrackItems,
  createListConfigCandidateToolLabelItems,
  createListConfigExcludeToolLabelItems,
  createListConfigExtraToolLabelItems,
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
  resolveListConfigPasteTarget,
  resolveListConfigPastedUrlCandidates,
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
  extra: [],
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
  extra: [],
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
  extra: [],
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
    status: "enqueueing",
    error: null,
    taskId: null,
  },
  {
    id: "candidate:1",
    rawText: "not a url",
    sourceUrl: null,
    displayText: "not a url",
    status: "invalid_url",
    error: "Clipboard does not contain a valid URL.",
    taskId: null,
  },
];

const excludedMusic: Music = {
  name: "Blocked Track",
  alias: "Blocked Alias",
  group: {
    name: "Blocked Collection",
    url: "https://example.com/blocked-collection",
    collection: {
      name: "Blocked Collection",
      url: "https://example.com/blocked-collection",
      folder: "youtube/blocked-collection",
      last_updated: "2026-04-13T00:00:00Z",
      enable_updates: null,
    },
    folder: "youtube/blocked-collection",
  },
  canonical_music_id: "source:https://example.com/watch?v=blocked:0:180000",
  url: "https://example.com/watch?v=blocked",
  path: "Blocked Track.m4a",
  start_ms: 0,
  end_ms: 180_000,
  liked: false,
  loudness: 0,
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
        status: "enqueueing",
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

  test("keeps playlist groups explicit when names overlap with collections", () => {
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
        extra: [],
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
        {
          kind: "group",
          name: "Quiet Morning",
          url: "https://example.com/group/quiet-morning",
          folder: "Quiet Morning",
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
          status: "enqueueing",
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

  test("resolves pasted current playlist urls into duplicate shake targets", () => {
    assert.deepEqual(
      resolveListConfigPasteTarget({
        text: " https://example.com/quiet-morning ",
        playlistItems: createListConfigPlaylistToolLabelItems(
          createListConfigPlaylistSidebarItems(draftWithGroup),
        ),
        candidateItems: [],
        arcTrackItems: [
          {
            kind: "collection",
            name: "Quiet Morning",
            url: "https://example.com/quiet-morning",
            folder: "youtube/quiet-morning",
          },
        ],
      }),
      {
        kind: "foreground-duplicate",
        layoutId: "playlist:collection:https://example.com/quiet-morning",
      },
    );
  });

  test("resolves pasted active candidate urls into duplicate shake targets", () => {
    assert.deepEqual(
      resolveListConfigPasteTarget({
        text: "https://www.youtube.com/playlist?list=PLPfHaI9XqTnEaHTKxU63ks1QFdCXw8Cbf",
        playlistItems: [],
        candidateItems: [
          {
            id: "candidate:checking",
            rawText: "https://www.youtube.com/playlist?list=PLPfHaI9XqTnEaHTKxU63ks1QFdCXw8Cbf",
            sourceUrl: null,
            displayText: "https://www.youtube.com/playlist?list=PLPfHaI9XqTnEaHTKxU63ks1QFdCXw8Cbf",
            status: "checking",
            error: null,
            taskId: null,
          },
        ],
        arcTrackItems: [],
      }),
      {
        kind: "foreground-duplicate",
        layoutId: "candidate:checking",
      },
    );
  });

  test("matches equivalent pasted urls against active candidate canonical urls", () => {
    assert.deepEqual(
      resolveListConfigPasteTarget({
        text: "https://www.youtube.com/watch?v=abc123&list=PLtenet",
        playlistItems: [],
        candidateItems: [
          {
            id: "candidate:playlist",
            rawText: "https://www.youtube.com/playlist?list=PLtenet",
            sourceUrl: "https://www.youtube.com/playlist?list=PLtenet",
            displayText: "https://www.youtube.com/playlist?list=PLtenet",
            status: "enqueueing",
            error: null,
            taskId: null,
          },
        ],
        arcTrackItems: [],
      }),
      {
        kind: "foreground-duplicate",
        layoutId: "playlist:collection:https://www.youtube.com/playlist?list=PLtenet",
      },
    );
  });

  test("keeps distinct pasted urls available for concurrent candidate parsing", () => {
    assert.equal(
      resolveListConfigPasteTarget({
        text: "https://www.youtube.com/playlist?list=PLsecond",
        playlistItems: [],
        candidateItems: [
          {
            id: "candidate:first",
            rawText: "https://www.youtube.com/playlist?list=PLfirst",
            sourceUrl: "https://www.youtube.com/playlist?list=PLfirst",
            displayText: "https://www.youtube.com/playlist?list=PLfirst",
            status: "enqueueing",
            error: null,
            taskId: null,
          },
        ],
        arcTrackItems: [],
      }),
      null,
    );
  });

  test("does not let failed candidate urls absorb a retry paste", () => {
    assert.equal(
      resolveListConfigPasteTarget({
        text: "https://www.youtube.com/playlist?list=PLretry",
        playlistItems: [],
        candidateItems: [
          {
            id: "candidate:failed",
            rawText: "https://www.youtube.com/playlist?list=PLretry",
            sourceUrl: "https://www.youtube.com/playlist?list=PLretry",
            displayText: "https://www.youtube.com/playlist?list=PLretry",
            status: "enqueue_failed",
            error: "Private video",
            taskId: null,
          },
          {
            id: "candidate:invalid",
            rawText: "https://www.youtube.com/playlist?list=PLretry",
            sourceUrl: null,
            displayText: "https://www.youtube.com/playlist?list=PLretry",
            status: "invalid_url",
            error: "Clipboard does not contain a valid URL.",
            taskId: null,
          },
        ],
        arcTrackItems: [],
      }),
      null,
    );
  });

  test("consumes duplicate shake requests before matching pushed rows mount later", () => {
    const duplicateShakeState: ListConfigDuplicateShakeState = {
      layoutId: "playlist:collection:https://example.com/quiet-morning",
      signal: 1,
    };
    const playlistItem = createListConfigPlaylistToolLabelItems(
      createListConfigPlaylistSidebarItems(draftWithGroup),
    )[0];

    assert.equal(resolveToolLabelShakeSignal(duplicateShakeState, playlistItem), 1);
    assert.equal(
      resolveToolLabelShakeSignal(
        consumeListConfigDuplicateShakeState(duplicateShakeState, 1),
        playlistItem,
      ),
      0,
    );
    assert.deepEqual(consumeListConfigDuplicateShakeState(duplicateShakeState, 2), {
      layoutId: "playlist:collection:https://example.com/quiet-morning",
      signal: 1,
    });
  });

  test("routes duplicate shake requests to active candidate rows", () => {
    const candidateItem = createListConfigCandidateToolLabelItems([
      {
        id: "candidate:checking",
        rawText: "https://example.com/pending",
        sourceUrl: null,
        displayText: "https://example.com/pending",
        status: "checking",
        error: null,
        taskId: null,
      },
    ])[0];

    assert.equal(
      resolveToolLabelShakeSignal(
        {
          layoutId: "candidate:checking",
          signal: 1,
        },
        candidateItem,
      ),
      1,
    );
  });

  test("discards stale duplicate shake requests seen by later-mounted rows", () => {
    assert.equal(
      resolveListConfigDuplicateShakeDecision({
        duplicateShakeSignal: 1,
        isRowReady: false,
      }),
      "discard",
    );
    assert.equal(
      resolveListConfigDuplicateShakeDecision({
        duplicateShakeSignal: 1,
        isRowReady: true,
      }),
      "shake",
    );
    assert.equal(
      resolveListConfigDuplicateShakeDecision({
        duplicateShakeSignal: 0,
        isRowReady: true,
      }),
      "ignore",
    );
  });

  test("resolves pasted library collection and group urls into arc-track push targets", () => {
    const playlistItems = createListConfigPlaylistToolLabelItems(
      createListConfigPlaylistSidebarItems(editDraft),
    );

    assert.deepEqual(
      resolveListConfigPasteTarget({
        text: "https://example.com/late-night-tape",
        playlistItems,
        candidateItems: [],
        arcTrackItems: [
          {
            kind: "collection",
            name: "Late Night Tape",
            url: "https://example.com/late-night-tape",
            folder: "youtube/late-night-tape",
          },
        ],
      }),
      {
        kind: "arc-track-push",
        layoutId: "playlist:collection:https://example.com/late-night-tape",
      },
    );
    assert.deepEqual(
      resolveListConfigPasteTarget({
        text: "https://example.com/late-night-tape#disc-1",
        playlistItems,
        candidateItems: [],
        arcTrackItems: [
          {
            kind: "group",
            name: "Disc 1",
            url: "https://example.com/late-night-tape#disc-1",
            folder: "Disc 1",
          },
        ],
      }),
      {
        kind: "arc-track-push",
        layoutId: "playlist:group:https://example.com/late-night-tape#disc-1",
      },
    );
  });

  test("keeps pasted unknown urls in the regular paste download flow", () => {
    assert.equal(
      resolveListConfigPasteTarget({
        text: "not a url",
        playlistItems: createListConfigPlaylistToolLabelItems(
          createListConfigPlaylistSidebarItems(draftWithGroup),
        ),
        candidateItems: [],
        arcTrackItems: [],
      }),
      null,
    );
  });

  test("rejects a single paste containing multiple urls before duplicate or arc-track matching", () => {
    const gluedUrls = "https://example.com/quiet-morning https://example.com/late-night-tape";

    assert.deepEqual(resolveListConfigPastedUrlCandidates(gluedUrls), []);
    assert.equal(
      resolveListConfigPasteTarget({
        text: gluedUrls,
        playlistItems: createListConfigPlaylistToolLabelItems(
          createListConfigPlaylistSidebarItems(draftWithGroup),
        ),
        candidateItems: [],
        arcTrackItems: [
          {
            kind: "collection",
            name: "Late Night Tape",
            url: "https://example.com/late-night-tape",
            folder: "youtube/late-night-tape",
          },
        ],
      }),
      null,
    );
  });

  test("matches pasted YouTube urls against frontend-safe canonical candidates", () => {
    assert.deepEqual(
      resolveListConfigPastedUrlCandidates(
        "https://www.youtube.com/watch?v=abc123&list=PLtenet&index=14",
      ),
      [
        "https://www.youtube.com/watch?v=abc123&list=PLtenet&index=14",
        "https://www.youtube.com/watch?v=abc123",
      ],
    );
    assert.deepEqual(
      resolveListConfigPastedUrlCandidates("https://www.youtube.com/watch?v=abc123&list=PLtenet"),
      [
        "https://www.youtube.com/watch?v=abc123&list=PLtenet",
        "https://www.youtube.com/playlist?list=PLtenet",
      ],
    );
    assert.deepEqual(
      resolveListConfigPastedUrlCandidates("https://www.youtube.com/watch?v=abc123&index=14"),
      ["https://www.youtube.com/watch?v=abc123&index=14", "https://www.youtube.com/watch?v=abc123"],
    );
    assert.deepEqual(
      resolveListConfigPastedUrlCandidates("https://www.youtube.com/watch?v=abc123&t=3238s"),
      ["https://www.youtube.com/watch?v=abc123&t=3238s", "https://www.youtube.com/watch?v=abc123"],
    );
    assert.deepEqual(
      resolveListConfigPastedUrlCandidates(
        "https://www.youtube.com/watch?v=abc123&list=RDMMIHIRrASFLcg",
      ),
      [
        "https://www.youtube.com/watch?v=abc123&list=RDMMIHIRrASFLcg",
        "https://www.youtube.com/watch?v=abc123",
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
        status: "enqueueing",
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
        collectionGroupMemberships: [],
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
            status: "enqueueing",
            error: null,
            taskId: null,
          },
        ],
        collectionGroupMemberships: [],
        excludeAvailability: emptyExcludeAvailability,
      }),
      [],
    );
  });

  test("removes collection-covered groups from the arc-track", () => {
    assert.deepEqual(
      createListConfigArcTrackItems({
        libraryItems: [
          {
            kind: "collection",
            name: "Collection A",
            url: "https://example.com/collection-a",
            folder: "youtube/collection-a",
          },
          {
            kind: "group",
            name: "A Disc",
            url: "https://example.com/collection-a#disc",
            folder: "A Disc",
          },
          {
            kind: "collection",
            name: "Collection B",
            url: "https://example.com/collection-b",
            folder: "youtube/collection-b",
          },
          {
            kind: "group",
            name: "B Disc",
            url: "https://example.com/collection-b#disc",
            folder: "B Disc",
          },
        ],
        playlistItems: [
          {
            kind: "collection",
            name: "Collection A",
            url: "https://example.com/collection-a",
            folder: "youtube/collection-a",
          },
        ],
        candidateItems: [],
        collectionGroupMemberships: [
          {
            collection_url: "https://example.com/collection-a",
            group_url: "https://example.com/collection-a#disc",
          },
          {
            collection_url: "https://example.com/collection-b",
            group_url: "https://example.com/collection-b#disc",
          },
        ],
        excludeAvailability: emptyExcludeAvailability,
      }),
      [
        {
          kind: "collection",
          name: "Collection B",
          url: "https://example.com/collection-b",
          folder: "youtube/collection-b",
        },
        {
          kind: "group",
          name: "B Disc",
          url: "https://example.com/collection-b#disc",
          folder: "B Disc",
        },
      ],
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
        collectionGroupMemberships: [],
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

  test("adds strike-through styling only to invalid url candidates", () => {
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
    assert.doesNotMatch(
      resolveListConfigToolLabelTextClassName({
        kind: "candidate",
        id: "candidate:2",
        candidateId: "candidate:2",
        text: "https://www.youtube.com/@C418/releases",
        status: "enqueue_failed",
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
        id: "candidate:2",
        candidateId: "candidate:2",
        text: "https://www.youtube.com/@C418/releases",
        status: "enqueue_failed",
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
        status: "enqueueing",
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

  test("derives extra tool labels from music identity", () => {
    assert.deepEqual(createListConfigExtraToolLabelItems([excludedMusic]), [
      {
        kind: "extra",
        id: `extra:${excludedMusic.canonical_music_id}`,
        music: excludedMusic,
        text: "Blocked Alias",
      },
    ]);
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

  test("hides the empty-state hint as soon as extra music exists", () => {
    assert.equal(
      resolveListConfigEmptyState(
        shouldShowListConfigEmptyState({
          draft: {
            ...createDraft,
            extra: [excludedMusic],
          },
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
            status: "enqueueing",
            error: null,
            taskId: null,
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

  test("hides the retained empty-state hint when candidates arrive before draft reloads", () => {
    assert.equal(
      resolveListConfigEmptyState(
        shouldShowListConfigEmptyState({
          draft: null,
          candidateItemCount: 1,
        }),
        me(true),
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
        {
          kind: "group",
          name: "Disc 1",
          url: "https://example.com/quiet-morning#disc-1",
          folder: "Disc 1",
        },
      ],
      excludeItems: [],
      excludeAvailability: emptyExcludeAvailability,
      collectionGroupMemberships: [
        {
          collection_url: "https://example.com/quiet-morning",
          group_url: "https://example.com/quiet-morning#disc-1",
        },
      ],
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
    assert.deepEqual(viewModel.extraToolLabelItems, []);
    assert.deepEqual(viewModel.arcTrackItems, [
      {
        kind: "collection",
        name: "Late Night Tape",
        url: "https://example.com/late-night-tape",
        folder: "youtube/late-night-tape",
      },
    ]);
  });

  test("treats accepted root-shell collection evidence as a committable draft change", () => {
    const rootShellDraft: ConfigDraft = {
      ...createDraft,
      collections: [
        {
          name: "[Official] TUNIC (Original Soundtrack) - Full Album / Lifeformed × Janice Kwan",
          url: "https://www.youtube.com/watch?v=nnvjKf_mRYM",
          folder: "youtube/tunic-soundtrack",
          last_updated: "2026-04-17T00:00:00Z",
          enable_updates: null,
        },
      ],
    };
    const viewModel = resolveListConfigViewModel({
      activeLayoutId: "collection-title:create",
      draft: rootShellDraft,
      draftBaseline: createDraft,
      pendingPlaylistName: null,
      titleToneHandoff: null,
      isPresent: true,
      libraryItems: [],
      excludeItems: [],
      excludeAvailability: emptyExcludeAvailability,
      collectionGroupMemberships: [],
      candidateItems: [
        {
          id: "candidate:0",
          rawText: "https://www.youtube.com/watch?v=nnvjKf_mRYM&t=3238s",
          sourceUrl: "https://www.youtube.com/watch?v=nnvjKf_mRYM&t=3238s",
          displayText:
            "[Official] TUNIC (Original Soundtrack) - Full Album / Lifeformed × Janice Kwan",
          status: "preparing",
          error: null,
          taskId: "task-1",
        },
      ],
      previousEmptyState: null,
    });

    assert.equal(viewModel.hasDraftChanges, true);
    assert.equal(viewModel.isBackActionParsing, true);
    assert.equal(viewModel.interactionFlags.isBackActionInteractionLocked, true);
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
      collectionGroupMemberships: [],
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
          taskId: null,
        },
        {
          id: "candidate:enqueueing",
          rawText: "https://example.com/live",
          sourceUrl: "https://example.com/live",
          displayText: "https://example.com/live",
          status: "enqueueing",
          error: null,
          taskId: null,
        },
        {
          id: "candidate:preparing",
          rawText: "https://example.com/preparing",
          sourceUrl: "https://example.com/preparing",
          displayText: "Preparing Collection",
          status: "preparing",
          error: null,
          taskId: "task-preparing",
        },
      ]),
      4,
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
      collectionGroupMemberships: [],
      candidateItems: [
        ...candidateItems,
        {
          id: "candidate:enqueueing",
          rawText: "https://example.com/live",
          sourceUrl: "https://example.com/live",
          displayText: "https://example.com/live",
          status: "enqueueing",
          error: null,
          taskId: null,
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
