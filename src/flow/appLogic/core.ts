import type { Collection } from "@/src/cmd";

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
  sourceUrl: string | null;
  name: string;
  folder: string;
  enableUpdates: boolean | null;
}

export interface Context {
  hasPlayList: boolean | null;
  collections: Collection[];
  activeLayoutId: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  draft: ConfigDraft | null;
  error: string | null;
}

export function collectionTitleLayoutId(url: string) {
  return `collection-title:${url}`;
}

export function createDraft(): ConfigDraft {
  return {
    mode: "create",
    sourceUrl: null,
    name: "",
    folder: "",
    enableUpdates: null,
  };
}

export function createDraftFromCollection(collection: Collection): ConfigDraft {
  return {
    mode: "edit",
    sourceUrl: collection.url,
    name: collection.name,
    folder: collection.folder,
    enableUpdates: collection.enable_updates,
  };
}

export function collectionTitleToneFromDraft(
  draft: ConfigDraft | null,
): CollectionTitleTone {
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

export const initialContext: Context = {
  hasPlayList: null,
  collections: [],
  activeLayoutId: null,
  titleToneHandoff: null,
  draft: null,
  error: null,
};
