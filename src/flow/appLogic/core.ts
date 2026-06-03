import type {
  Collection,
  CollectionSurfaceView,
  ConfigLibraryView,
  Exclude as PlaylistExclude,
  ExcludeAvailability,
  Group,
  GroupSurfaceView,
  Music,
  PlayList,
  PlayListConfigView,
  PlayListListView,
  PlayPlaylistSession,
  PlaybackTrackPayload,
  PlayListWriteRequest,
  SpectrumMusicSourceContext,
  NowPlayingTrackChangedEvent,
} from "@/src/cmd";
import type {
  SpectrumEditCommitFrame,
  SpectrumEditCommitNegativeEvidence,
} from "./spectrumEditTransaction";

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
  groups: ConfigDraftGroupRef[];
  extra: Music[];
  createdAt: PlayList["created_at"];
}

export interface ConfigDraftCollectionRef {
  name: string;
  url: string;
  folder: string;
  last_updated: string;
  enable_updates: Collection["enable_updates"];
}

export interface ConfigDraftGroupRef {
  name: string;
  url: string;
  folder: string;
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

export type NowPlayingTrackEvidence = NowPlayingTrackChangedEvent;
export type InitialPlaybackTrackEvidence = PlaybackTrackPayload & {
  session_generation: number;
};
export type PlaylistPlaybackRequestPhase = "failed" | "preparing" | "starting";
export type PlaylistPlaybackStopReason =
  | Exclude<PlayPlaylistSession["status"], "started">
  | "error"
  | "stale";

export interface PlaylistPlaybackRequestEvidence {
  error: string | null;
  phase: PlaylistPlaybackRequestPhase;
  playlistName: string;
  reason: PlaylistPlaybackStopReason | null;
  requestId: number;
}

export interface ExcludeRemovedChange {
  music: Music;
  excludeAvailability: ExcludeAvailability;
}

export interface ExcludeAddedChange {
  exclude: PlaylistExclude;
  excludeAvailability: ExcludeAvailability;
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
  playlist: PlayListWriteRequest;
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

export type ContextResetLifecycleAction =
  | { kind: "closed"; target: string | null }
  | { kind: "none" }
  | { kind: "opened"; target: string | null }
  | { kind: "preserved"; target: string | null };

export interface ContextResetLifecycle {
  chart: ContextResetLifecycleAction;
  lease: ContextResetLifecycleAction;
  owner: "appLogic";
  reason: string;
  transaction: ContextResetLifecycleAction;
}

export interface ShapeProjectionContext {
  hasPlayList: boolean | null;
  playlists: PlayListListView[];
  pendingPlaylistPreview: PlaylistPreview | null;
  collections: Collection[];
  configLibrary: ConfigLibraryView;
  savePath: string;
  draftBaseline: ConfigDraft | null;
  draft: ConfigDraft | null;
}

export interface RuntimeCapabilityContext {
  playingPlaylistName: string | null;
  nowPlayingTrackName: string | null;
  nowPlayingTrackUrl: string | null;
  nowPlayingTrackFilePath: string | null;
  nowPlayingTrackStartMs: number | null;
  nowPlayingTrackEndMs: number | null;
  nowPlayingTrackLiked: boolean | null;
  playingSessionGeneration: number | null;
  pendingPlaylistPlaybackSessionGeneration: number | null;
  spectrumPlaybackScopeId: number | null;
}

export interface ExperienceChartContext {
  spectrumMusicDrafts: SpectrumMusicDraft[];
  spectrumMusicSourceContext: SpectrumMusicSourceContext | null;
  pendingSpectrumMusicCreateId: string | null;
  activeLayoutId: string | null;
}

export interface TransactionEpochContext {
  spectrumMusicCommitFrame: SpectrumEditCommitFrame | null;
  spectrumMusicCommitEpoch: number;
  spectrumMusicCommitNegativeEvidence: SpectrumEditCommitNegativeEvidence | null;
  pendingPlaylistName: string | null;
  pendingPlaylistPlaybackName: string | null;
  pendingPlaylistPlaybackRequest: PlaylistPlaybackRequestEvidence | null;
  pendingCollectionUpdatesChange: CollectionUpdatesChange | null;
}

export interface PresentationLeaseContext {
  titleToneHandoff: CollectionTitleHandoff | null;
}

export interface PendingEvidenceContext {
  pendingNowPlayingTrackEvidence: NowPlayingTrackEvidence | null;
  error: string | null;
}

export interface JournalContext {
  lastContextResetLifecycle: ContextResetLifecycle | null;
}

export interface Context
  extends
    ShapeProjectionContext,
    RuntimeCapabilityContext,
    ExperienceChartContext,
    TransactionEpochContext,
    PresentationLeaseContext,
    PendingEvidenceContext,
    JournalContext {}

export interface ContextResetPatch<TContext extends Context = Context> {
  chart?: Partial<ExperienceChartContext>;
  journal?: Partial<JournalContext>;
  lease?: Partial<PresentationLeaseContext>;
  pending?: Partial<PendingEvidenceContext>;
  runtime?: Partial<RuntimeCapabilityContext>;
  shape?: Partial<ShapeProjectionContext>;
  transaction?: Partial<TransactionEpochContext>;
  unsafe?: Partial<TContext>;
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
  groups: ConfigDraftGroupRef[];
  extra: Music[];
};

function createEmptyPlayListFields(): PlayListEditableFields {
  return {
    name: "",
    collections: [],
    groups: [],
    extra: [],
  };
}

function createEmptyConfigLibrary(): ConfigLibraryView {
  return {
    collections: [],
    groups: [],
    collection_group_memberships: [],
    excludes: [],
    exclude_availability: createEmptyExcludeAvailability(),
  };
}

function createEmptyExcludeAvailability(): ExcludeAvailability {
  return {
    fully_excluded_collection_urls: [],
    fully_excluded_group_urls: [],
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
    extra: [...draft.extra],
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
export function createPlayListWriteRequestFromDraft(
  draft: ConfigDraft,
  options?: {
    createdAt?: PlayList["created_at"];
  },
): PlayListWriteRequest {
  return {
    name: draft.name,
    collections: [...draft.collections],
    groups: [...draft.groups],
    extra: [...draft.extra],
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

function createGroupRefFromSurface(surface: GroupSurfaceView): ConfigDraftGroupRef {
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
    groups: playlist.groups.map(createGroupRefFromSurface),
    extra: playlist.extra,
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
  const playlist = createPlayListWriteRequestFromDraft(committedDraft, {
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

function createConfigSidebarGroupItem(group: ConfigDraftGroupRef): ConfigSidebarItem {
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

  for (const collection of collections) {
    appendConfigSidebarItem(items, seenUrls, {
      kind: "collection",
      name: collection.name,
      url: collection.url,
      folder: collection.folder,
      last_updated: collection.last_updated,
      enable_updates: collection.enable_updates,
    });
  }

  return items;
}

export function createConfigSidebarItemsFromLibrary(
  library: ConfigLibraryView,
): ConfigSidebarItem[] {
  const items: ConfigSidebarItem[] = [];
  const seenUrls = new Set<string>();

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

  return {
    collections: collectionSurfaces,
    groups: [],
    collection_group_memberships: [],
    excludes: [],
    exclude_availability: createEmptyExcludeAvailability(),
  };
}

export function removeExcludeFromConfigLibrary(
  library: ConfigLibraryView,
  removed: ExcludeRemovedChange,
): ConfigLibraryView {
  return {
    ...library,
    exclude_availability: removed.excludeAvailability,
    excludes: library.excludes.filter(
      (exclude) => !isSameExcludeMusic(exclude.music, removed.music),
    ),
  };
}

export function upsertExcludeIntoConfigLibrary(
  library: ConfigLibraryView,
  added: ExcludeAddedChange,
): ConfigLibraryView {
  return {
    ...library,
    exclude_availability: added.excludeAvailability,
    excludes: [
      added.exclude,
      ...library.excludes.filter(
        (exclude) => !isSameExcludeMusic(exclude.music, added.exclude.music),
      ),
    ],
  };
}

function isSameExcludeMusic(left: Music, right: Music) {
  return left.url === right.url && left.start_ms === right.start_ms && left.end_ms === right.end_ms;
}

function isSameMusicIdentity(left: Music, right: Music) {
  return left.canonical_music_id === right.canonical_music_id;
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
    collection_group_memberships: library.collection_group_memberships.filter(
      (membership) => membership.collection_url !== nextCollection.url,
    ),
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

export function removeExtraFromDraft(draft: ConfigDraft | null, music: Music): ConfigDraft | null {
  if (!draft) {
    return null;
  }

  return {
    ...draft,
    extra: draft.extra.filter((extra) => !isSameMusicIdentity(extra, music)),
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
    nowPlayingTrackLiked: null,
    pendingNowPlayingTrackEvidence: null,
    playingSessionGeneration: null,
    pendingPlaylistPlaybackSessionGeneration: null,
    spectrumPlaybackScopeId: null,
    spectrumMusicDrafts: [],
    spectrumMusicSourceContext: null,
    spectrumMusicCommitFrame: null,
    spectrumMusicCommitEpoch: 0,
    spectrumMusicCommitNegativeEvidence: null,
    pendingSpectrumMusicCreateId: null,
    activeLayoutId: null,
    titleToneHandoff: null,
    pendingPlaylistName: null,
    pendingPlaylistPlaybackName: null,
    pendingPlaylistPlaybackRequest: null,
    pendingCollectionUpdatesChange: null,
    draftBaseline: null,
    draft: null,
    error: null,
    lastContextResetLifecycle: null,
  };
}

function hasContextResetJournal(
  context: object,
): context is { lastContextResetLifecycle: ContextResetLifecycle | null } {
  return "lastContextResetLifecycle" in context;
}

export function createContextResetter<TContext extends object>(createInitial: () => TContext) {
  return function resetContextWith(
    patch: TContext extends Context ? ContextResetPatch<TContext & Context> : Partial<TContext>,
    lifecycle: ContextResetLifecycle,
  ): TContext {
    const initial = createInitial();
    const groupedPatch =
      "shape" in patch ||
      "runtime" in patch ||
      "chart" in patch ||
      "lease" in patch ||
      "transaction" in patch ||
      "pending" in patch ||
      "journal" in patch ||
      "unsafe" in patch
        ? {
            ...("shape" in patch ? patch.shape : {}),
            ...("runtime" in patch ? patch.runtime : {}),
            ...("chart" in patch ? patch.chart : {}),
            ...("lease" in patch ? patch.lease : {}),
            ...("transaction" in patch ? patch.transaction : {}),
            ...("pending" in patch ? patch.pending : {}),
            ...("journal" in patch ? patch.journal : {}),
            ...("unsafe" in patch ? patch.unsafe : {}),
          }
        : patch;

    return {
      ...initial,
      ...groupedPatch,
      ...(hasContextResetJournal(initial)
        ? {
            lastContextResetLifecycle: lifecycle,
          }
        : {}),
    };
  };
}

export const initialContext = createInitialContext();

export const resetContextWith = createContextResetter(createInitialContext);
