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

export interface Context {
  hasPlayList: boolean | null;
  collections: Collection[];
  savePath: string;
  configSidebarItems: ConfigSidebarItem[];
  activeLayoutId: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  pendingPlaylistName: string | null;
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

export function createDraftFromPlayList(playlist: PlayList): ConfigDraft {
  return {
    mode: "edit",
    name: playlist.name,
    collections: [...playlist.collections],
    groups: [...playlist.groups],
  };
}

export function collectionTitleToneFromDraft(draft: ConfigDraft | null): CollectionTitleTone {
  if (!draft) {
    return "solid";
  }

  return draft.name.length === 0 ? "muted" : "solid";
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

export const initialContext: Context = {
  hasPlayList: null,
  collections: [],
  savePath: "",
  configSidebarItems: [],
  activeLayoutId: null,
  titleToneHandoff: null,
  pendingPlaylistName: null,
  draft: null,
  error: null,
};
