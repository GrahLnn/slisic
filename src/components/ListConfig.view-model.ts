import { me, type ME } from "@grahlnn/fn";
import { cn } from "@/lib/utils";
import type { CollectionGroupMembershipView, Exclude, ExcludeAvailability, Music } from "@/src/cmd";
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
import {
  parseDownloadableClipboardUrl,
  type ConfigCandidateItem,
  type ConfigCandidateItemStatus,
} from "@/src/flow/pasteDownload/core";
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

export interface ListConfigExcludeToolLabelItem {
  kind: "exclude";
  id: string;
  music: Music;
  text: string;
}

export interface ListConfigExtraToolLabelItem {
  kind: "extra";
  id: string;
  music: Music;
  text: string;
}

export type ListConfigToolLabelItem =
  | ListConfigPlaylistToolLabelItem
  | ListConfigCandidateToolLabelItem;

export type ListConfigPasteTarget =
  | {
      kind: "foreground-duplicate";
      layoutId: string;
    }
  | {
      kind: "arc-track-push";
      layoutId: string;
    };

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

export function createListConfigToolLabelLayoutId(ref: ConfigSidebarItemRef) {
  return `playlist:${ref.kind}:${ref.url}`;
}

function parseListConfigPastedUrl(text: string): URL | null {
  const parsed = parseDownloadableClipboardUrl(text);
  return parsed.ok ? parsed.url : null;
}

function isYouTubeHost(hostname: string) {
  const host = hostname.toLocaleLowerCase();

  return host === "youtu.be" || host.endsWith("youtube.com");
}

function isYouTubeMixPlaylistId(playlistId: string) {
  return playlistId.toLocaleUpperCase().startsWith("RD");
}

function firstNonEmptyPathSegment(url: URL) {
  return url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .find((segment) => segment.length > 0);
}

function resolveYouTubeDirectVideoId(url: URL): string | null {
  const host = url.hostname.toLocaleLowerCase();

  if (host === "youtu.be") {
    return firstNonEmptyPathSegment(url) ?? null;
  }

  if (!host.endsWith("youtube.com")) {
    return null;
  }

  const videoId = url.searchParams.get("v")?.trim();
  if (videoId) {
    return videoId;
  }

  const segments = url.pathname.split("/").map((segment) => segment.trim());
  const scope = segments[1];
  const scopedVideoId = segments[2];

  return (scope === "shorts" || scope === "live") && scopedVideoId ? scopedVideoId : null;
}

function isYouTubeWatchPlaylistItemUrl(url: URL) {
  const host = url.hostname.toLocaleLowerCase();

  return (
    host.endsWith("youtube.com") &&
    url.pathname === "/watch" &&
    Boolean(url.searchParams.get("v")?.trim()) &&
    Boolean(url.searchParams.get("list")?.trim()) &&
    Boolean(url.searchParams.get("index")?.trim())
  );
}

export function resolveListConfigPastedUrlCandidates(text: string): string[] {
  const url = parseListConfigPastedUrl(text);

  if (!url) {
    return [];
  }

  const candidates = new Set([text.trim()]);
  candidates.add(url.href);

  if (isYouTubeHost(url.hostname)) {
    const directVideoId = resolveYouTubeDirectVideoId(url);
    if (directVideoId && isYouTubeWatchPlaylistItemUrl(url)) {
      candidates.add(`https://www.youtube.com/watch?v=${directVideoId}`);
      return [...candidates];
    }

    const playlistId = url.searchParams.get("list")?.trim();
    if (playlistId && !isYouTubeMixPlaylistId(playlistId)) {
      candidates.add(`https://www.youtube.com/playlist?list=${playlistId}`);
      return [...candidates];
    }

    if (directVideoId && (!playlistId || isYouTubeMixPlaylistId(playlistId))) {
      candidates.add(`https://www.youtube.com/watch?v=${directVideoId}`);
    }
  }

  return [...candidates];
}

export function resolveListConfigPasteTarget(args: {
  text: string;
  playlistItems: readonly ListConfigPlaylistToolLabelItem[];
  candidateItems: readonly ConfigCandidateItem[];
  arcTrackItems: readonly ConfigSidebarItem[];
}): ListConfigPasteTarget | null {
  const candidateUrls = resolveListConfigPastedUrlCandidates(args.text);

  if (candidateUrls.length === 0) {
    return null;
  }

  const candidateUrlSet = new Set(candidateUrls);
  const playlistItem = args.playlistItems.find((item) => candidateUrlSet.has(item.ref.url));

  if (playlistItem) {
    return {
      kind: "foreground-duplicate",
      layoutId: playlistItem.id,
    };
  }

  const candidateItem = args.candidateItems.find((item) => {
    if (item.status === "invalid_url" || item.status === "enqueue_failed") {
      return false;
    }

    const itemUrlCandidates = [item.sourceUrl, item.rawText, item.displayText].flatMap((text) =>
      text ? resolveListConfigPastedUrlCandidates(text) : [],
    );

    return itemUrlCandidates.some((url) => candidateUrlSet.has(url));
  });

  if (candidateItem) {
    return {
      kind: "foreground-duplicate",
      layoutId: createListConfigCandidateToolLabelLayoutId(candidateItem),
    };
  }

  const arcTrackItem = args.arcTrackItems.find((item) => candidateUrlSet.has(item.url));
  if (!arcTrackItem) {
    return null;
  }

  return {
    kind: "arc-track-push",
    layoutId: createListConfigToolLabelLayoutId(createConfigSidebarItemRef(arcTrackItem)),
  };
}

export function createListConfigPlaylistSidebarItems(
  draft: ConfigDraft | null,
): ListConfigPlaylistSidebarItem[] {
  if (!draft) {
    return [];
  }

  const items: ListConfigPlaylistSidebarItem[] = [];
  const seenUrls = new Set<string>();

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

function createListConfigCandidateToolLabelLayoutId(item: ConfigCandidateItem) {
  return item.sourceUrl
    ? createListConfigToolLabelLayoutId({
        kind: "collection",
        url: item.sourceUrl,
      })
    : item.id;
}

export function createListConfigCandidateToolLabelItems(
  items: readonly ConfigCandidateItem[],
): ListConfigCandidateToolLabelItem[] {
  return items.map((item) => ({
    kind: "candidate",
    id: createListConfigCandidateToolLabelLayoutId(item),
    candidateId: item.id,
    text: item.displayText,
    status: item.status,
  }));
}

export function createListConfigExcludeToolLabelItems(
  excludes: readonly Exclude[],
): ListConfigExcludeToolLabelItem[] {
  return excludes.map((exclude) => ({
    kind: "exclude",
    id: createListConfigExcludeToolLabelLayoutId(exclude.music),
    music: exclude.music,
    text: resolveListConfigExcludeToolLabelText(exclude.music),
  }));
}

export function createListConfigExtraToolLabelItems(
  extra: readonly Music[],
): ListConfigExtraToolLabelItem[] {
  return extra.map((music) => ({
    kind: "extra",
    id: createListConfigExtraToolLabelLayoutId(music),
    music,
    text: resolveListConfigExcludeToolLabelText(music),
  }));
}

export function createListConfigExcludeToolLabelLayoutId(music: Music) {
  return `exclude:${music.url}:${music.start_ms}:${music.end_ms}`;
}

export function createListConfigExtraToolLabelLayoutId(music: Music) {
  return `extra:${music.canonical_music_id}`;
}

export function resolveListConfigExcludeToolLabelText(music: Music) {
  const alias = music.alias.trim();
  const name = music.name.trim();
  return alias || name || music.url;
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
  collectionGroupMemberships: readonly CollectionGroupMembershipView[];
  excludeAvailability: ExcludeAvailability;
}) {
  const foregroundUrls = new Set(args.playlistItems.map((item) => item.url));
  const foregroundCollectionUrls = new Set(
    args.playlistItems.filter((item) => item.kind === "collection").map((item) => item.url),
  );
  const fullyExcludedCollectionUrls = new Set(
    args.excludeAvailability.fully_excluded_collection_urls,
  );
  const fullyExcludedGroupUrls = new Set(args.excludeAvailability.fully_excluded_group_urls);

  for (const item of args.candidateItems) {
    if (!item.sourceUrl) {
      continue;
    }

    if (item.status === "invalid_url" || item.status === "enqueue_failed") {
      continue;
    }

    foregroundUrls.add(item.sourceUrl);
    foregroundCollectionUrls.add(item.sourceUrl);
  }

  const coveredGroupUrls = new Set(
    args.collectionGroupMemberships
      .filter((membership) => foregroundCollectionUrls.has(membership.collection_url))
      .map((membership) => membership.group_url),
  );

  return args.libraryItems.filter((item) => {
    if (foregroundUrls.has(item.url)) {
      return false;
    }

    if (item.kind === "collection") {
      return !fullyExcludedCollectionUrls.has(item.url);
    }

    return !coveredGroupUrls.has(item.url) && !fullyExcludedGroupUrls.has(item.url);
  });
}

export function resolveListConfigToolLabelTextClassName(item: ListConfigToolLabelItem): string {
  return me(item).match("kind", {
    playlist: (): string => "text-[12px] text-[#404040] dark:text-[#a3a3a3]",
    candidate: ({ status }): string =>
      cn(
        "text-[12px] text-[#404040] dark:text-[#a3a3a3]",
        status === "invalid_url" && "line-through opacity-70",
        status === "enqueue_failed" && "opacity-70",
      ),
  });
}

export function resolveListConfigExcludeToolLabelTextClassName(): string {
  return "text-[12px] text-[#404040] dark:text-[#a3a3a3]";
}

export function resolveListConfigToolLabelAffordance(
  item: ListConfigToolLabelItem,
): ListConfigToolLabelAffordance {
  return me(item).match("kind", {
    playlist: (): ListConfigToolLabelAffordance => "playlist",
    candidate: ({ status }): ListConfigToolLabelAffordance =>
      status === "invalid_url" || status === "enqueue_failed" ? "candidate-delete" : "passive",
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
  if (args.candidateItemCount > 0) {
    return me<ListConfigEmptyStateKind>("hide");
  }

  if (!args.draft) {
    return me<ListConfigEmptyStateKind>("keep");
  }

  return me<ListConfigEmptyStateKind>(
    args.draft.collections.length === 0 &&
      args.draft.groups.length === 0 &&
      args.draft.extra.length === 0
      ? "show"
      : "hide",
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
  return candidateItems.filter((item) => listConfigCandidateItemIsParsing(item.status)).length;
}

export function hasListConfigParsingCandidateItems(candidateItems: readonly ConfigCandidateItem[]) {
  return countListConfigParsingCandidateItems(candidateItems) > 0;
}

function listConfigCandidateItemIsParsing(status: ConfigCandidateItem["status"]) {
  return status === "checking" || status === "enqueueing" || status === "preparing";
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
  excludeItems: readonly Exclude[];
  excludeAvailability: ExcludeAvailability;
  collectionGroupMemberships: readonly CollectionGroupMembershipView[];
  candidateItems: readonly ConfigCandidateItem[];
  previousEmptyState: ListConfigEmptyState | null;
}) {
  const playlistItems = createListConfigPlaylistSidebarItems(args.draft);
  const isArcTrackDeferred = !args.draft && Boolean(args.pendingPlaylistName);
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
  const arcTrackItems = isArcTrackDeferred
    ? []
    : createListConfigArcTrackItems({
        libraryItems: args.libraryItems,
        playlistItems,
        candidateItems: args.candidateItems,
        collectionGroupMemberships: args.collectionGroupMemberships,
        excludeAvailability: args.excludeAvailability,
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
    extraToolLabelItems: createListConfigExtraToolLabelItems(args.draft?.extra ?? []),
    excludeToolLabelItems: createListConfigExcludeToolLabelItems(args.excludeItems),
    arcTrackItems,
    emptyState,
    interactionFlags,
    shouldShowEmptyState: emptyState.match({
      true: () => true,
      false: () => false,
    }),
  };
}
