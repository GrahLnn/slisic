import { me, type ME } from "@grahlnn/fn";
import { cn } from "@/lib/utils";
import {
  createConfigSidebarItemRef,
  type CollectionTitleHandoff,
  type CollectionTitleTone,
  type ConfigDraft,
  type ConfigSidebarItem,
  type ConfigSidebarItemRef,
} from "@/src/flow/appLogic/core";
import {
  hasConfigDraftChanges,
  createTitleShareArrow,
  createTitleShareEndpoint,
  resolveTitleShareEndpointInstruction,
  type TitleShareHoverVisual,
} from "@/src/flow/appLogic/titleShare";
import type { ConfigCandidateItem, ConfigCandidateItemStatus } from "@/src/flow/pasteDownload/core";
import { CREATE_COLLECTION_TITLE } from "./collectionTitle";

export type ListConfigEmptyStateKind = "keep" | "show" | "hide";
export type ListConfigEmptyStateSignal = ME<ListConfigEmptyStateKind>;
export type ListConfigEmptyState = ME<boolean>;
export type ListConfigToolLabelAffordance = "playlist" | "candidate-delete" | "passive";

export interface ListConfigTitleSnapshot {
  layoutId: string;
  value: string;
  placeholder?: string;
}

export interface ListConfigTitleViewModel {
  snapshot: ListConfigTitleSnapshot | null;
  autoFocus: boolean;
  handoffTone: CollectionTitleTone | null;
  layoutId: string | undefined;
  titleHoverVisual: TitleShareHoverVisual;
  titleNativeHoverEnabled: boolean;
  placeholder?: string;
  value: string;
}

export interface ListConfigInteractionFlags {
  isBackActionInteractionLocked: boolean;
  isTitleInteractionDisabled: boolean;
  isToolListInteractionDisabled: boolean;
  shouldRenderArcTrack: boolean;
}

export interface ListConfigPlaylistSidebarItem extends ConfigSidebarItem {
  enableUpdates: boolean | null;
}

export interface ListConfigPlaylistToolLabelItem {
  kind: "playlist";
  id: string;
  ref: ConfigSidebarItemRef;
  text: string;
  sourceKind: ConfigSidebarItem["kind"];
  enableUpdates: boolean | null;
}

export interface ListConfigCandidateToolLabelItem {
  kind: "candidate";
  id: string;
  candidateId: string;
  text: string;
  status: ConfigCandidateItemStatus;
}

export type ListConfigToolLabelItem =
  | ListConfigPlaylistToolLabelItem
  | ListConfigCandidateToolLabelItem;

export function resolveListConfigTitlePlaceholder(args: {
  draft: ConfigDraft | null;
  draftBaseline: ConfigDraft | null;
}) {
  if (!args.draft) {
    return undefined;
  }

  if (args.draft.mode === "create") {
    return CREATE_COLLECTION_TITLE;
  }

  const baselineName = args.draftBaseline?.name.trim() ?? "";
  return baselineName.length > 0 ? baselineName : undefined;
}

export function createListConfigTitleSnapshot(args: {
  activeLayoutId: string | null;
  draft: ConfigDraft | null;
  draftBaseline: ConfigDraft | null;
  pendingPlaylistName?: string | null;
}): ListConfigTitleSnapshot | null {
  if (!args.activeLayoutId) {
    return null;
  }

  if (!args.draft) {
    if (!args.pendingPlaylistName) {
      return null;
    }

    return {
      layoutId: args.activeLayoutId,
      value: args.pendingPlaylistName,
      placeholder: undefined,
    };
  }

  return {
    layoutId: args.activeLayoutId,
    value: args.draft.name,
    placeholder: resolveListConfigTitlePlaceholder({
      draft: args.draft,
      draftBaseline: args.draftBaseline,
    }),
  };
}

export function resolveListConfigTitleViewModel(args: {
  activeLayoutId: string | null;
  draft: ConfigDraft | null;
  draftBaseline: ConfigDraft | null;
  pendingPlaylistName?: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
}): ListConfigTitleViewModel {
  const snapshot = createListConfigTitleSnapshot({
    activeLayoutId: args.activeLayoutId,
    draft: args.draft,
    draftBaseline: args.draftBaseline,
    pendingPlaylistName: args.pendingPlaylistName,
  });
  const layoutId = snapshot?.layoutId;

  return {
    snapshot,
    autoFocus: Boolean(snapshot?.layoutId && args.draft?.mode === "create"),
    handoffTone:
      layoutId && args.titleToneHandoff?.layoutId === layoutId ? args.titleToneHandoff.tone : null,
    layoutId,
    titleHoverVisual: resolveTitleShareEndpointInstruction({
      endpoint: createTitleShareEndpoint("config", layoutId),
      arrow: createTitleShareArrow({
        kind: "list-to-config",
        source: createTitleShareEndpoint("list", args.titleToneHandoff?.layoutId),
        target: createTitleShareEndpoint("config", args.titleToneHandoff?.layoutId),
        targetRetainLease: "timed",
      }),
    }).titleHoverVisual,
    titleNativeHoverEnabled: false,
    placeholder: snapshot?.placeholder,
    value: snapshot?.value ?? "",
  };
}

function normalizeListConfigSidebarName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function createListConfigToolLabelLayoutId(ref: ConfigSidebarItemRef) {
  return `playlist:${ref.kind}:${ref.url}`;
}

export function createListConfigPlaylistSidebarItems(
  draft: ConfigDraft | null,
): ListConfigPlaylistSidebarItem[] {
  if (!draft) {
    return [];
  }

  const items: ListConfigPlaylistSidebarItem[] = [];
  const seenUrls = new Set<string>();
  const collectionNames = new Set(
    draft.collections.map((collection) => normalizeListConfigSidebarName(collection.name)),
  );

  for (const collection of draft.collections) {
    if (seenUrls.has(collection.url)) {
      continue;
    }

    seenUrls.add(collection.url);
    items.push({
      kind: "collection",
      name: collection.name,
      url: collection.url,
      folder: collection.folder,
      enableUpdates: collection.enable_updates,
    });
  }

  for (const group of draft.groups) {
    if (collectionNames.has(normalizeListConfigSidebarName(group.name))) {
      continue;
    }

    if (seenUrls.has(group.url)) {
      continue;
    }

    seenUrls.add(group.url);
    items.push({
      kind: "group",
      name: group.name,
      url: group.url,
      folder: group.folder,
      enableUpdates: null,
    });
  }

  return items;
}

export function createListConfigPlaylistToolLabelItems(
  items: readonly ListConfigPlaylistSidebarItem[],
): ListConfigPlaylistToolLabelItem[] {
  return items.map((item) => {
    const ref = createConfigSidebarItemRef(item);

    return {
      kind: "playlist",
      id: createListConfigToolLabelLayoutId(ref),
      ref,
      text: item.name,
      sourceKind: item.kind,
      enableUpdates: item.enableUpdates,
    };
  });
}

export function createListConfigCandidateToolLabelItems(
  items: readonly ConfigCandidateItem[],
): ListConfigCandidateToolLabelItem[] {
  return items.map((item) => ({
    kind: "candidate",
    id: item.sourceUrl
      ? createListConfigToolLabelLayoutId({
          kind: "collection",
          url: item.sourceUrl,
        })
      : item.id,
    candidateId: item.id,
    text: item.displayText,
    status: item.status,
  }));
}

export function resolveListConfigToolLabelItems(args: {
  playlistItems: readonly ListConfigPlaylistSidebarItem[];
  candidateItems: readonly ConfigCandidateItem[];
}): ListConfigToolLabelItem[] {
  const playlistToolLabelItems = createListConfigPlaylistToolLabelItems(args.playlistItems);
  const playlistIds = new Set(playlistToolLabelItems.map((item) => item.id));
  const candidateToolLabelItems = createListConfigCandidateToolLabelItems(
    args.candidateItems,
  ).filter((item) => !playlistIds.has(item.id));

  return [...candidateToolLabelItems, ...playlistToolLabelItems];
}

export function createListConfigArcTrackItems(args: {
  libraryItems: readonly ConfigSidebarItem[];
  playlistItems: readonly ConfigSidebarItem[];
  candidateItems: readonly ConfigCandidateItem[];
}) {
  const foregroundUrls = new Set(args.playlistItems.map((item) => item.url));

  for (const item of args.candidateItems) {
    if (!item.sourceUrl) {
      continue;
    }

    if (
      item.status === "invalid_url" ||
      item.status === "probe_failed" ||
      item.status === "enqueue_failed"
    ) {
      continue;
    }

    foregroundUrls.add(item.sourceUrl);
  }

  return args.libraryItems.filter((item) => !foregroundUrls.has(item.url));
}

export function resolveListConfigToolLabelTextClassName(item: ListConfigToolLabelItem): string {
  return me(item).match("kind", {
    playlist: (): string => "text-[12px] text-[#404040] dark:text-[#a3a3a3]",
    candidate: ({ status }): string =>
      cn(
        "text-[12px] text-[#404040] dark:text-[#a3a3a3]",
        (status === "invalid_url" || status === "probe_failed" || status === "enqueue_failed") &&
          "line-through opacity-70",
      ),
  });
}

export function resolveListConfigToolLabelAffordance(
  item: ListConfigToolLabelItem,
): ListConfigToolLabelAffordance {
  return me(item).match("kind", {
    playlist: (): ListConfigToolLabelAffordance => "playlist",
    candidate: ({ status }): ListConfigToolLabelAffordance =>
      status === "invalid_url" || status === "probe_failed" || status === "enqueue_failed"
        ? "candidate-delete"
        : "passive",
  });
}

export function shouldShowListConfigEnableUpdateTool(item: ListConfigToolLabelItem): boolean {
  return me(item).match("kind", {
    candidate: (): boolean => false,
    playlist: ({ sourceKind, enableUpdates }): boolean =>
      sourceKind === "collection" && enableUpdates !== null,
  });
}

export function shouldShowListConfigAutoDownloadIcon(item: ListConfigToolLabelItem): boolean {
  return me(item).match("kind", {
    candidate: (): boolean => false,
    playlist: ({ sourceKind, enableUpdates }): boolean =>
      sourceKind === "collection" && enableUpdates === true,
  });
}

export function resolveListConfigCollectionUpdatesToolText(
  item: ListConfigToolLabelItem,
): string | null {
  return me(item).match("kind", {
    candidate: (): string | null => null,
    playlist: ({ sourceKind, enableUpdates }): string | null => {
      if (sourceKind !== "collection" || enableUpdates === null) {
        return null;
      }

      return enableUpdates ? "Disable Update" : "Enable Update";
    },
  });
}

export function shouldShowListConfigEmptyState(args: {
  draft: ConfigDraft | null;
  candidateItemCount: number;
}): ListConfigEmptyStateSignal {
  if (!args.draft) {
    return me<ListConfigEmptyStateKind>("keep");
  }

  if (args.candidateItemCount > 0) {
    return me<ListConfigEmptyStateKind>("hide");
  }

  return me<ListConfigEmptyStateKind>(
    args.draft.collections.length === 0 && args.draft.groups.length === 0 ? "show" : "hide",
  );
}

export function resolveListConfigEmptyState(
  emptyStateSignal: ListConfigEmptyStateSignal,
  previousEmptyState: ListConfigEmptyState | null,
) {
  return emptyStateSignal.match({
    keep: () => previousEmptyState ?? me(false),
    show: () => me(true),
    hide: () => me(false),
  });
}

export function countListConfigParsingCandidateItems(
  candidateItems: readonly ConfigCandidateItem[],
) {
  return candidateItems.filter(
    (item) =>
      item.status === "checking" || item.status === "probing" || item.status === "enqueueing",
  ).length;
}

export function hasListConfigParsingCandidateItems(candidateItems: readonly ConfigCandidateItem[]) {
  return countListConfigParsingCandidateItems(candidateItems) > 0;
}

export function resolveListConfigInteractionFlags(args: {
  isPresent: boolean;
  arcTrackItemCount: number;
  isBackActionProcessing: boolean;
}): ListConfigInteractionFlags {
  return {
    isBackActionInteractionLocked: args.isPresent && args.isBackActionProcessing,
    isTitleInteractionDisabled: !args.isPresent,
    isToolListInteractionDisabled: !args.isPresent,
    shouldRenderArcTrack: args.arcTrackItemCount > 0,
  };
}

export function resolveListConfigViewModel(args: {
  activeLayoutId: string | null;
  draft: ConfigDraft | null;
  draftBaseline: ConfigDraft | null;
  pendingPlaylistName?: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  isPresent: boolean;
  libraryItems: readonly ConfigSidebarItem[];
  candidateItems: readonly ConfigCandidateItem[];
  previousEmptyState: ListConfigEmptyState | null;
}) {
  const playlistItems = createListConfigPlaylistSidebarItems(args.draft);
  const emptyState = resolveListConfigEmptyState(
    shouldShowListConfigEmptyState({
      draft: args.draft,
      candidateItemCount: args.candidateItems.length,
    }),
    args.previousEmptyState,
  );
  const title = resolveListConfigTitleViewModel({
    activeLayoutId: args.activeLayoutId,
    draft: args.draft,
    draftBaseline: args.draftBaseline,
    pendingPlaylistName: args.pendingPlaylistName,
    titleToneHandoff: args.titleToneHandoff,
  });
  const arcTrackItems = createListConfigArcTrackItems({
    libraryItems: args.libraryItems,
    playlistItems,
    candidateItems: args.candidateItems,
  });
  const isBackActionParsing = hasListConfigParsingCandidateItems(args.candidateItems);
  const interactionFlags = resolveListConfigInteractionFlags({
    isPresent: args.isPresent,
    arcTrackItemCount: arcTrackItems.length,
    isBackActionProcessing: isBackActionParsing,
  });

  return {
    title,
    hasDraftChanges: hasConfigDraftChanges(args.draft, args.draftBaseline),
    isBackActionParsing,
    playlistItems,
    toolLabelItems: resolveListConfigToolLabelItems({
      playlistItems,
      candidateItems: args.candidateItems,
    }),
    arcTrackItems,
    emptyState,
    interactionFlags,
    shouldShowEmptyState: emptyState.match({
      true: () => true,
      false: () => false,
    }),
  };
}
