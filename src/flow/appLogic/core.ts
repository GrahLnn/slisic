import type {
  Collection,
  CollectionSurfaceView,
  ConfigLibraryView,
  Group,
  GroupSurfaceView,
  PlayList,
  PlayListConfigView,
  PlayListListView,
  SpectrumMusicSourceContext,
} from "@/src/cmd";

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
  collections: ConfigDraftCollectionRef[];
  groups: Group[];
  createdAt: PlayList["created_at"];
}

export interface ConfigDraftCollectionRef {
  name: string;
  url: string;
  folder: string;
  last_updated: string;
  enable_updates: Collection["enable_updates"];
}

export interface ConfigSidebarItem {
  kind: "collection" | "group";
  name: string;
  url: string;
  folder: string;
  last_updated?: string;
  enable_updates?: Collection["enable_updates"];
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
  playlist: PlayListListView;
  previousName: string | null;
}

export interface PlaylistPreview extends PlaylistUpsertResult {
  draft: ConfigDraft;
}

export interface PlaylistPersistenceRequest {
  playlist: PlayList;
  previousName: string | null;
}

export interface PlaylistDraftCommit {
  titleResolution: DraftCommitTitleResolution;
  draft: ConfigDraft;
  request: PlaylistPersistenceRequest;
  preview: PlaylistPreview;
  layoutId: string;
  titleToneHandoff: CollectionTitleHandoff;
}

export type SpectrumMusicDraftKind = "pending-create" | "persisted";

interface SpectrumMusicDraftBase {
  kind: SpectrumMusicDraftKind;
  baselineName: string;
  baselineStartMs: number | null;
  baselineEndMs: number | null;
  name: string;
  url: string;
  startMs: number | null;
  endMs: number | null;
  deleteRequested?: boolean;
}

export interface PersistedSpectrumMusicDraft extends SpectrumMusicDraftBase {
  kind: "persisted";
  baselineStartMs: number;
  baselineEndMs: number;
}

export interface PendingCreateSpectrumMusicDraft extends SpectrumMusicDraftBase {
  kind: "pending-create";
  baselineName: "";
  baselineStartMs: null;
  baselineEndMs: null;
  sourceCollectionUrl: string | null;
  /** Finite source-duration evidence for creating a full-source draft. */
  sourceEndMs: number;
  sourceGroup: Group | null;
  sourcePath: string | null;
  sourceUrl: string;
}

export type SpectrumMusicDraft = PersistedSpectrumMusicDraft | PendingCreateSpectrumMusicDraft;

export interface Context {
  hasPlayList: boolean | null;
  playlists: PlayListListView[];
  pendingPlaylistPreview: PlaylistPreview | null;
  collections: Collection[];
  configLibrary: ConfigLibraryView;
  savePath: string;
  playingPlaylistName: string | null;
  nowPlayingTrackName: string | null;
  nowPlayingTrackUrl: string | null;
  nowPlayingTrackFilePath: string | null;
  nowPlayingTrackStartMs: number | null;
  nowPlayingTrackEndMs: number | null;
  spectrumPlaybackScopeId: number | null;
  spectrumMusicDrafts: SpectrumMusicDraft[];
  spectrumMusicSourceContext: SpectrumMusicSourceContext | null;
  pendingSpectrumMusicCreateId: string | null;
  shouldStartPlayback: boolean;
  activeLayoutId: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  pendingPlaylistName: string | null;
  pendingPlaylistPlaybackName: string | null;
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

type PlayListEditableFields = {
  name: string;
  collections: ConfigDraftCollectionRef[];
  groups: Group[];
};

function createEmptyPlayListFields(): PlayListEditableFields {
  return {
    name: "",
    collections: [],
    groups: [],
  };
}

function createEmptyConfigLibrary(): ConfigLibraryView {
  return {
    collections: [],
    groups: [],
  };
}

export function createDraft(): ConfigDraft {
  return {
    mode: "create",
    ...createEmptyPlayListFields(),
    createdAt: null,
  };
}

export function cloneDraft(draft: ConfigDraft): ConfigDraft {
  return {
    mode: draft.mode,
    name: draft.name,
    collections: [...draft.collections],
    groups: [...draft.groups],
    createdAt: draft.createdAt,
  };
}

export function normalizeDraftName(name: string) {
  return name.trim();
}

/**
 * Draft state owns only user-editable playlist fields. Persistence metadata
 * like `created_at` must be injected at commit time so edit flows preserve the
 * existing record identity while new playlists still enter with a pending fill.
 */
export function createPlayListFromDraft(
  draft: ConfigDraft,
  options?: {
    createdAt?: PlayList["created_at"];
  },
): PlayList {
  return {
    name: draft.name,
    collections: draft.collections.map(createCollectionShellFromDraftRef),
    groups: [...draft.groups],
    created_at: options?.createdAt ?? draft.createdAt,
  };
}

export function resolveNextGeneratedPlaylistName(playlists: readonly PlayListListView[]) {
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
  playlists: readonly PlayListListView[];
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
    collections: playlist.collections.map(createConfigDraftCollectionRefFromCollection),
    groups: playlist.groups,
    createdAt: playlist.created_at,
  });
}

function createConfigDraftCollectionRefFromCollection(
  collection: Collection,
): ConfigDraftCollectionRef {
  return {
    name: collection.name,
    url: collection.url,
    folder: collection.folder,
    last_updated: collection.last_updated,
    enable_updates: collection.enable_updates,
  };
}

function createConfigDraftCollectionRefFromSurface(
  surface: CollectionSurfaceView,
): ConfigDraftCollectionRef {
  return {
    name: surface.name,
    url: surface.url,
    folder: surface.folder,
    last_updated: surface.last_updated,
    enable_updates: surface.enable_updates,
  };
}

function createCollectionShellFromDraftRef(ref: ConfigDraftCollectionRef): Collection {
  return {
    name: ref.name,
    url: ref.url,
    folder: ref.folder,
    musics: [],
    last_updated: ref.last_updated,
    enable_updates: ref.enable_updates,
  };
}

function createGroupFromSurface(surface: GroupSurfaceView): Group {
  return {
    name: surface.name,
    url: surface.url,
    folder: surface.folder,
  };
}

export function createDraftFromPlayListConfig(playlist: PlayListConfigView): ConfigDraft {
  return cloneDraft({
    mode: "edit",
    name: playlist.name,
    collections: playlist.collections.map(createConfigDraftCollectionRefFromSurface),
    groups: playlist.groups.map(createGroupFromSurface),
    createdAt: playlist.created_at,
  });
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

/**
 * Behavior:
 *   Project an edited config draft into a single playlist commit transaction.
 *
 * Invariants:
 *   - The generated playlist title is derived from the caller-provided visible
 *     playlist surfaces, so pending previews reserve their displayed names.
 *   - The returned layout id, committed draft, and persistence request share
 *     the same normalized playlist identity.
 *   - New playlist records keep `created_at` pending so persistence remains the
 *     only owner of fill metadata.
 */
export function resolvePlaylistDraftCommit(args: {
  draft: ConfigDraft;
  draftBaseline: ConfigDraft | null;
  playlists: readonly PlayListListView[];
}): PlaylistDraftCommit {
  const titleResolution = resolveDraftCommitTitle(args);
  const committedDraft: ConfigDraft = {
    ...args.draft,
    name: titleResolution.name,
  };
  const playlist = createPlayListFromDraft(committedDraft, {
    createdAt: args.draft.mode === "edit" ? args.draft.createdAt : null,
  });
  const layoutId = playlistTitleLayoutId(playlist.name);

  return {
    titleResolution,
    draft: committedDraft,
    request: {
      playlist,
      previousName: args.draft.mode === "edit" ? (args.draftBaseline?.name ?? null) : null,
    },
    preview: {
      playlist: {
        name: playlist.name,
        created_at: playlist.created_at,
      },
      previousName: args.draft.mode === "edit" ? (args.draftBaseline?.name ?? null) : null,
      draft: cloneDraft(committedDraft),
    },
    layoutId,
    titleToneHandoff: createCollectionTitleHandoff(
      layoutId,
      committedDraft.name.length === 0 ? "muted" : "solid",
    ),
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
      last_updated: collection.last_updated,
      enable_updates: collection.enable_updates,
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

export function createConfigSidebarItemsFromLibrary(
  library: ConfigLibraryView,
): ConfigSidebarItem[] {
  const items: ConfigSidebarItem[] = [];
  const seenUrls = new Set<string>();
  const collectionNames = new Set(
    library.collections.map((collection) => normalizeConfigSidebarName(collection.name)),
  );

  for (const collection of library.collections) {
    appendConfigSidebarItem(items, seenUrls, {
      kind: "collection",
      name: collection.name,
      url: collection.url,
      folder: collection.folder,
      last_updated: collection.last_updated,
      enable_updates: collection.enable_updates,
    });
  }

  for (const group of library.groups) {
    if (collectionNames.has(normalizeConfigSidebarName(group.name))) {
      continue;
    }

    appendConfigSidebarItem(items, seenUrls, createConfigSidebarGroupItem(group));
  }

  return items;
}

export function createConfigLibraryFromCollections(
  collections: readonly Collection[],
): ConfigLibraryView {
  const collectionSurfaces = collections.map((collection) => ({
    name: collection.name,
    url: collection.url,
    folder: collection.folder,
    last_updated: collection.last_updated,
    enable_updates: collection.enable_updates,
  }));
  const items = createConfigSidebarItems(collections);

  return {
    collections: collectionSurfaces,
    groups: items
      .filter((item) => item.kind === "group")
      .map((group) => ({
        name: group.name,
        url: group.url,
        folder: group.folder,
      })),
  };
}

export function upsertCollectionIntoConfigLibrary(
  library: ConfigLibraryView,
  nextCollection: Collection,
): ConfigLibraryView {
  const nextSurface: CollectionSurfaceView = {
    name: nextCollection.name,
    url: nextCollection.url,
    folder: nextCollection.folder,
    last_updated: nextCollection.last_updated,
    enable_updates: nextCollection.enable_updates,
  };

  return {
    ...library,
    collections: [
      nextSurface,
      ...library.collections.filter((collection) => collection.url !== nextCollection.url),
    ],
  };
}

export function findConfigSidebarItem(
  libraryItems: readonly ConfigSidebarItem[],
  ref: ConfigSidebarItemRef,
): ConfigSidebarItem | null {
  return libraryItems.find((item) => item.kind === ref.kind && item.url === ref.url) ?? null;
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
    collections: upsertCollectionRefIntoDraftCollections(
      draft.collections,
      createConfigDraftCollectionRefFromCollection(nextCollection),
    ),
  };
}

function upsertCollectionRefIntoDraftCollections(
  collections: readonly ConfigDraftCollectionRef[],
  nextCollection: ConfigDraftCollectionRef,
): ConfigDraftCollectionRef[] {
  const currentIndex = collections.findIndex((collection) => collection.url === nextCollection.url);

  if (currentIndex < 0) {
    return [nextCollection, ...collections];
  }

  return collections.map((collection, index) =>
    index === currentIndex ? nextCollection : collection,
  );
}

export function upsertPlaylistIntoPlaylists(
  playlists: readonly PlayListListView[],
  nextPlaylist: PlayListListView,
  previousName: string | null = null,
): PlayListListView[] {
  const matchName = previousName ?? nextPlaylist.name;
  const currentIndex = playlists.findIndex((playlist) => playlist.name === matchName);

  if (currentIndex < 0) {
    return [...playlists, nextPlaylist];
  }

  return playlists.map((playlist, index) => (index === currentIndex ? nextPlaylist : playlist));
}

export function resolvePlaylistsWithPreview(
  playlists: readonly PlayListListView[],
  preview: PlaylistUpsertResult | null,
) {
  if (!preview) {
    return [...playlists];
  }

  return upsertPlaylistIntoPlaylists(playlists, preview.playlist, preview.previousName);
}

export function removePlaylistFromPlaylists(playlists: readonly PlayListListView[], name: string) {
  return playlists.filter((playlist) => playlist.name !== name);
}

export function resolveSavedPath(savePath: string | null | undefined, fallbackSavePath: string) {
  const resolvedPath = savePath?.trim();

  return resolvedPath || fallbackSavePath;
}

export function includeDraftSidebarItem(
  draft: ConfigDraft | null,
  collections: readonly Collection[],
  libraryItems: readonly ConfigSidebarItem[],
  ref: ConfigSidebarItemRef,
): ConfigDraft | null {
  if (!draft) {
    return null;
  }

  const item = findConfigSidebarItem(libraryItems, ref);
  if (!item) {
    return draft;
  }

  if (ref.kind === "collection") {
    const collection =
      collections.find((candidate) => candidate.url === ref.url) ??
      (item.kind === "collection"
        ? {
            name: item.name,
            url: item.url,
            folder: item.folder,
            last_updated: item.last_updated ?? "",
            enable_updates: item.enable_updates ?? null,
          }
        : null);

    if (!collection) {
      return draft;
    }

    return {
      ...draft,
      collections: upsertCollectionRefIntoDraftCollections(
        draft.collections,
        "musics" in collection
          ? createConfigDraftCollectionRefFromCollection(collection)
          : collection,
      ),
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
    configLibrary: createEmptyConfigLibrary(),
    savePath: "",
    playingPlaylistName: null,
    nowPlayingTrackName: null,
    nowPlayingTrackUrl: null,
    nowPlayingTrackFilePath: null,
    nowPlayingTrackStartMs: null,
    nowPlayingTrackEndMs: null,
    spectrumPlaybackScopeId: null,
    spectrumMusicDrafts: [],
    spectrumMusicSourceContext: null,
    pendingSpectrumMusicCreateId: null,
    shouldStartPlayback: false,
    activeLayoutId: null,
    titleToneHandoff: null,
    pendingPlaylistName: null,
    pendingPlaylistPlaybackName: null,
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
