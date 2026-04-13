import type { Collection } from "@/src/cmd";

export const CREATE_COLLECTION_LAYOUT_ID = "collection-title:create";

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

export const initialContext: Context = {
  hasPlayList: null,
  collections: [],
  activeLayoutId: null,
  draft: null,
  error: null,
};
