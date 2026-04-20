import type { Collection, Group, PlayList } from "@/src/cmd";

export const CREATE_COLLECTION_LAYOUT_ID = "collection-title:create";

export type CollectionTitleTone = "solid" | "muted";

/**
 * Shared layout color animation runs on the entering node, so the target
 * needs the source tone as handoff data before the source unmounts.
 */
export interface CollectionTitleHandoff {
  layoutId: string;
  tone: CollectionTitleTone;
}

export interface ConfigDraft {
  mode: "create" | "edit";
  name: string;
  collections: Collection[];
  groups: Group[];
}

export interface ConfigSidebarItem {
  kind: "collection" | "group";
  name: string;
  url: string;
  folder: string;
}

export interface ConfigSidebarItemRef {
  kind: ConfigSidebarItem["kind"];
  url: string;
}

export interface CollectionUpdatesChange {
  url: string;
  enabled: boolean;
}

export type DraftCommitTitleResolutionKind = "keep" | "restore" | "generate";

export interface DraftCommitTitleResolution {
  kind: DraftCommitTitleResolutionKind;
  name: string;
}

export interface PlaylistUpsertResult {
  playlist: PlayList;
  previousName: string | null;
}

export interface Context {
  hasPlayList: boolean | null;
  playlists: PlayList[];
  pendingPlaylistPreview: PlaylistUpsertResult | null;
  collections: Collection[];
  savePath: string;
  playingPlaylistName: string | null;
  nowPlayingTrackName: string | null;
  activeLayoutId: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  pendingPlaylistName: string | null;
  pendingCollectionUpdatesChange: CollectionUpdatesChange | null;
  draftBaseline: ConfigDraft | null;
  draft: ConfigDraft | null;
  error: string | null;
}

export function collectionTitleLayoutId(url: string) {
  return `collection-title:${url}`;
}

export function playlistTitleLayoutId(name: string) {
  return `playlist-title:${name}`;
}

export function createEmptyPlayList(): PlayList {
  return {
    name: "",
    collections: [],
    groups: [],
  };
}

export function createDraft(): ConfigDraft {
  return {
    mode: "create",
    ...createEmptyPlayList(),
  };
}

export function cloneDraft(draft: ConfigDraft): ConfigDraft {
  return {
    mode: draft.mode,
    name: draft.name,
    collections: [...draft.collections],
    groups: [...draft.groups],
  };
}

export function normalizeDraftName(name: string) {
  return name.trim();
}

export function createPlayListFromDraft(draft: ConfigDraft): PlayList {
  return {
    name: draft.name,
    collections: [...draft.collections],
    groups: [...draft.groups],
  };
}

export function resolveNextGeneratedPlaylistName(playlists: readonly PlayList[]) {
  const existingNames = new Set(playlists.map((playlist) => normalizeDraftName(playlist.name)));
  let index = 1;

  while (existingNames.has(`PlayList ${index}`)) {
    index += 1;
  }

  return `PlayList ${index}`;
}

export function resolveDraftCommitTitle(args: {
  draft: ConfigDraft;
  draftBaseline: ConfigDraft | null;
  playlists: readonly PlayList[];
}): DraftCommitTitleResolution {
  const currentName = normalizeDraftName(args.draft.name);

  if (currentName.length > 0) {
    return {
      kind: "keep",
      name: currentName,
    };
  }

  const baselineName = normalizeDraftName(args.draftBaseline?.name ?? "");

  if (baselineName.length > 0) {
    return {
      kind: "restore",
      name: baselineName,
    };
  }

  return {
    kind: "generate",
    name: resolveNextGeneratedPlaylistName(args.playlists),
  };
}

export function createDraftFromPlayList(playlist: PlayList): ConfigDraft {
  return cloneDraft({
    mode: "edit",
    name: playlist.name,
    collections: playlist.collections,
    groups: playlist.groups,
  });
}

export function createDraftFromPlaylistName(
  playlists: readonly PlayList[],
  name: string,
): ConfigDraft | null {
  const playlist = playlists.find((candidate) => candidate.name === name);

  if (!playlist) {
    return null;
  }

  return createDraftFromPlayList(playlist);
}

export function createCollectionTitleHandoff(
  layoutId: string,
  tone: CollectionTitleTone,
): CollectionTitleHandoff {
  return {
    layoutId,
    tone,
  };
}

export function createConfigSidebarItemRef(
  item: Pick<ConfigSidebarItem, "kind" | "url">,
): ConfigSidebarItemRef {
  return {
    kind: item.kind,
    url: item.url,
  };
}

function appendConfigSidebarItem(
  items: ConfigSidebarItem[],
  seenUrls: Set<string>,
  item: ConfigSidebarItem,
) {
  if (seenUrls.has(item.url)) {
    return;
  }

  seenUrls.add(item.url);
  items.push(item);
}

function normalizeConfigSidebarName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function createConfigSidebarGroupItem(group: Group): ConfigSidebarItem {
  return {
    kind: "group",
    name: group.name,
    url: group.url,
    folder: group.folder,
  };
}

export function createConfigSidebarItems(collections: readonly Collection[]): ConfigSidebarItem[] {
  const items: ConfigSidebarItem[] = [];
  const seenUrls = new Set<string>();
  const collectionNames = new Set(
    collections.map((collection) => normalizeConfigSidebarName(collection.name)),
  );

  for (const collection of collections) {
    appendConfigSidebarItem(items, seenUrls, {
      kind: "collection",
      name: collection.name,
      url: collection.url,
      folder: collection.folder,
    });

    for (const music of collection.musics) {
      if (collectionNames.has(normalizeConfigSidebarName(music.group.name))) {
        continue;
      }

      appendConfigSidebarItem(items, seenUrls, createConfigSidebarGroupItem(music.group));
    }
  }

  return items;
}

export function findConfigSidebarItem(
  collections: readonly Collection[],
  ref: ConfigSidebarItemRef,
): ConfigSidebarItem | null {
  return (
    createConfigSidebarItems(collections).find(
      (item) => item.kind === ref.kind && item.url === ref.url,
    ) ?? null
  );
}

export function upsertCollectionIntoCollections(
  collections: readonly Collection[],
  nextCollection: Collection,
): Collection[] {
  const currentIndex = collections.findIndex((collection) => collection.url === nextCollection.url);

  if (currentIndex < 0) {
    return [nextCollection, ...collections];
  }

  return collections.map((collection, index) =>
    index === currentIndex ? nextCollection : collection,
  );
}

export function upsertCollectionIntoDraft(
  draft: ConfigDraft | null,
  nextCollection: Collection,
): ConfigDraft | null {
  if (!draft) {
    return null;
  }

  return {
    ...draft,
    collections: upsertCollectionIntoCollections(draft.collections, nextCollection),
  };
}

export function upsertPlaylistIntoPlaylists(
  playlists: readonly PlayList[],
  nextPlaylist: PlayList,
  previousName: string | null = null,
): PlayList[] {
  const matchName = previousName ?? nextPlaylist.name;
  const currentIndex = playlists.findIndex((playlist) => playlist.name === matchName);

  if (currentIndex < 0) {
    return [...playlists, nextPlaylist];
  }

  return playlists.map((playlist, index) =>
    index === currentIndex ? nextPlaylist : playlist,
  );
}

export function removePlaylistFromPlaylists(
  playlists: readonly PlayList[],
  name: string,
) {
  return playlists.filter((playlist) => playlist.name !== name);
}

export function resolvePlaylistsWithPreview(
  playlists: readonly PlayList[],
  preview: PlaylistUpsertResult | null,
) {
  if (!preview) {
    return [...playlists];
  }

  return upsertPlaylistIntoPlaylists(
    playlists,
    preview.playlist,
    preview.previousName,
  );
}

export function includeDraftSidebarItem(
  draft: ConfigDraft | null,
  collections: readonly Collection[],
  ref: ConfigSidebarItemRef,
): ConfigDraft | null {
  if (!draft) {
    return null;
  }

  const item = findConfigSidebarItem(collections, ref);
  if (!item) {
    return draft;
  }

  if (ref.kind === "collection") {
    const collection = collections.find((candidate) => candidate.url === ref.url);

    if (!collection) {
      return draft;
    }

    return {
      ...draft,
      collections: upsertCollectionIntoCollections(draft.collections, collection),
    };
  }

  if (draft.groups.some((group) => group.url === ref.url)) {
    return draft;
  }

  return {
    ...draft,
    groups: [
      ...draft.groups,
      {
        name: item.name,
        url: item.url,
        folder: item.folder,
      },
    ],
  };
}

export function removeDraftSidebarItem(
  draft: ConfigDraft | null,
  ref: ConfigSidebarItemRef,
): ConfigDraft | null {
  if (!draft) {
    return null;
  }

  if (ref.kind === "collection") {
    return {
      ...draft,
      collections: draft.collections.filter((collection) => collection.url !== ref.url),
    };
  }

  return {
    ...draft,
    groups: draft.groups.filter((group) => group.url !== ref.url),
  };
}

export function createInitialContext(): Context {
  return {
    hasPlayList: null,
    playlists: [],
    pendingPlaylistPreview: null,
    collections: [],
    savePath: "",
    playingPlaylistName: null,
    nowPlayingTrackName: null,
    activeLayoutId: null,
    titleToneHandoff: null,
    pendingPlaylistName: null,
    pendingCollectionUpdatesChange: null,
    draftBaseline: null,
    draft: null,
    error: null,
  };
}

export function createContextResetter<TContext>(createInitial: () => TContext) {
  return function resetContextWith<const K extends keyof TContext>(
    kept: Pick<TContext, K>,
  ): TContext {
    return {
      ...createInitial(),
      ...kept,
    };
  };
}

export const initialContext = createInitialContext();

export const resetContextWith = createContextResetter(createInitialContext);
