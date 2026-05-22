import type { Collection, Music, SpectrumMusicSourceContext } from "@/src/cmd";
import type { SpectrumMusicDraft } from "./core";

export interface MusicEdit {
  alias: string;
  endMs: number;
  startMs: number;
  targetEndMs: number;
  targetStartMs: number;
  url: string;
}

export interface MusicDraftEdit extends MusicEdit {
  id: string;
}

export interface MusicDraftDelete {
  endMs: number;
  id: string;
  startMs: number;
  url: string;
}

export type MusicDelete = Omit<MusicDraftDelete, "id">;

export interface MusicDraftCreate {
  id: string;
  music: Music;
  sourceCollectionUrl: string;
}

export interface MusicCreate {
  sourceCollectionUrl: string;
  music: Music;
}

export type SpectrumMusicCommitKind = "keep" | "restore";

export interface SpectrumMusicCommitResolution {
  kind: SpectrumMusicCommitKind;
  alias: string;
}

export function normalizeSpectrumMusicName(name: string) {
  return name.trim();
}

export function normalizeSpectrumMusicRangeBoundary(value: number | null) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : null;
}

export function normalizeSpectrumMusicDraftRangeBoundary(value: number | null) {
  return normalizeSpectrumMusicRangeBoundary(value);
}

function projectSpectrumMusicDraftRangeBoundary(args: {
  baseline: number | null;
  value: number | null;
}) {
  return (
    normalizeSpectrumMusicDraftRangeBoundary(args.value) ??
    normalizeSpectrumMusicDraftRangeBoundary(args.baseline)
  );
}

function areSpectrumMusicDraftRangeBoundariesEqual(args: {
  baseline: number | null;
  value: number | null;
}) {
  const normalizedBaseline = normalizeSpectrumMusicDraftRangeBoundary(args.baseline);

  if (normalizedBaseline === null) {
    return normalizeSpectrumMusicDraftRangeBoundary(args.value) === null;
  }

  return projectSpectrumMusicDraftRangeBoundary(args) === normalizedBaseline;
}

function createSpectrumMusicDraftValue(args: {
  name: string;
  url: string;
  startMs: number;
  endMs: number;
}): SpectrumMusicDraft {
  const startMs = normalizeSpectrumMusicRangeBoundary(args.startMs);
  const endMs = normalizeSpectrumMusicRangeBoundary(args.endMs);

  if (startMs === null || endMs === null || startMs >= endMs) {
    throw new Error("invalid persisted spectrum music draft range");
  }

  return {
    kind: "persisted",
    baselineName: args.name,
    baselineStartMs: startMs,
    baselineEndMs: endMs,
    name: args.name,
    url: args.url,
    startMs,
    endMs,
  };
}

export function createSpectrumNewMusicDraftIdentity(args: { sourceUrl: string | null }) {
  return `new|${args.sourceUrl ?? ""}`;
}

export function createSpectrumMusicDraftRuntimeIdentity(draft: SpectrumMusicDraft) {
  return draft.kind === "pending-create"
    ? createSpectrumNewMusicDraftIdentity({ sourceUrl: draft.sourceUrl })
    : createSpectrumMusicDraftIdentity({
        baselineEndMs: draft.baselineEndMs,
        baselineStartMs: draft.baselineStartMs,
        url: draft.url,
      });
}

export function createSpectrumCurrentMusicDraft(args: {
  name: string | null;
  url: string | null;
  startMs: number | null;
  endMs: number | null;
}): SpectrumMusicDraft | null {
  const startMs = normalizeSpectrumMusicRangeBoundary(args.startMs);
  const endMs = normalizeSpectrumMusicRangeBoundary(args.endMs);

  if (args.name === null || args.url === null || startMs === null || endMs === null) {
    return null;
  }

  return createSpectrumMusicDraftValue({
    name: args.name,
    url: args.url,
    startMs,
    endMs,
  });
}

export function createSpectrumMusicDrafts(args: {
  currentMusicIdentity: {
    endMs: number | null;
    startMs: number | null;
    url: string | null;
  };
  fileMusics: readonly {
    alias: string;
    end_ms: number;
    start_ms: number;
    url: string;
  }[];
}): SpectrumMusicDraft[] {
  const seen = new Set<string>();
  const drafts: SpectrumMusicDraft[] = [];

  function append(music: { alias: string; end_ms: number; start_ms: number; url: string }) {
    const key = createSpectrumMusicDraftIdentity({
      baselineEndMs: music.end_ms,
      baselineStartMs: music.start_ms,
      url: music.url,
    });
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    drafts.push(
      createSpectrumMusicDraftValue({
        name: music.alias,
        url: music.url,
        startMs: music.start_ms,
        endMs: music.end_ms,
      }),
    );
  }

  const currentIdentity = createSpectrumMusicDraftIdentity({
    baselineEndMs: args.currentMusicIdentity.endMs,
    baselineStartMs: args.currentMusicIdentity.startMs,
    url: args.currentMusicIdentity.url,
  });
  const current = args.fileMusics.find(
    (music) =>
      createSpectrumMusicDraftIdentity({
        baselineEndMs: music.end_ms,
        baselineStartMs: music.start_ms,
        url: music.url,
      }) === currentIdentity,
  );
  const rest = args.fileMusics.filter((music) => music !== current);

  if (current) {
    append(current);
  }

  for (const music of rest) {
    append(music);
  }

  return drafts;
}

export function mergeSpectrumMusicDrafts(args: {
  baseDrafts: readonly SpectrumMusicDraft[];
  incomingDrafts: readonly SpectrumMusicDraft[];
}): SpectrumMusicDraft[] {
  const seen = new Set(args.baseDrafts.map(createSpectrumMusicDraftRuntimeIdentity));
  const merged = [...args.baseDrafts];

  for (const draft of args.incomingDrafts) {
    const key = createSpectrumMusicDraftRuntimeIdentity(draft);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(draft);
  }

  return merged;
}

function mergeSpectrumPendingCreateDraftEvidence(args: {
  draft: SpectrumMusicDraft;
  source: SpectrumMusicSourceContext;
}): SpectrumMusicDraft {
  if (args.draft.kind !== "pending-create" || args.draft.sourceUrl !== args.source.source_url) {
    return args.draft;
  }

  const sourceEndMs = normalizeSpectrumMusicRangeBoundary(args.source.source_end_ms);
  if (sourceEndMs === null || sourceEndMs <= 0) {
    return args.draft;
  }

  return {
    ...args.draft,
    endMs: args.draft.endMs ?? sourceEndMs,
    sourceCollectionUrl: args.source.source_collection_url,
    sourceEndMs,
    sourceGroup: args.source.source_group,
    sourcePath: args.source.source_path,
  };
}

export function mergeSpectrumMusicDraftsWithSourceContext(args: {
  drafts: readonly SpectrumMusicDraft[];
  source: SpectrumMusicSourceContext | null;
}): SpectrumMusicDraft[] {
  if (!args.source) {
    return [...args.drafts];
  }

  return args.drafts.map((draft) =>
    mergeSpectrumPendingCreateDraftEvidence({
      draft,
      source: args.source!,
    }),
  );
}

export function createSpectrumMusicDraftIdentity(args: {
  baselineEndMs: number | null;
  baselineStartMs: number | null;
  url: string | null;
}) {
  return [
    args.url ?? "",
    normalizeSpectrumMusicRangeBoundary(args.baselineStartMs) ?? "",
    normalizeSpectrumMusicRangeBoundary(args.baselineEndMs) ?? "",
  ].join("|");
}

export function hasSpectrumMusicDraftChanges(draft: SpectrumMusicDraft | null) {
  if (draft?.kind === "pending-create") {
    return draft.deleteRequested !== true;
  }

  return (
    draft !== null &&
    (draft.deleteRequested === true ||
      normalizeSpectrumMusicName(draft.name) !== normalizeSpectrumMusicName(draft.baselineName) ||
      !areSpectrumMusicDraftRangeBoundariesEqual({
        baseline: draft.baselineStartMs,
        value: draft.startMs,
      }) ||
      !areSpectrumMusicDraftRangeBoundariesEqual({
        baseline: draft.baselineEndMs,
        value: draft.endMs,
      }))
  );
}

export function resetSpectrumMusicDraftValue(
  draft: SpectrumMusicDraft | null,
): SpectrumMusicDraft | null {
  if (!draft) {
    return null;
  }

  if (draft.kind === "pending-create") {
    return draft;
  }

  const { deleteRequested: _deleteRequested, ...draftValue } = draft;

  return {
    ...draftValue,
    name: draft.baselineName,
    startMs: draft.baselineStartMs,
    endMs: draft.baselineEndMs,
  };
}

export function changeSpectrumMusicDraftValueName(
  draft: SpectrumMusicDraft | null,
  name: string,
): SpectrumMusicDraft | null {
  return draft ? { ...draft, name } : null;
}

export function changeSpectrumMusicDraftValueRange(
  draft: SpectrumMusicDraft | null,
  range: { endMs: number | null; startMs: number | null },
): SpectrumMusicDraft | null {
  if (!draft) {
    return null;
  }

  const startMs = projectSpectrumMusicDraftRangeBoundary({
    baseline: draft.baselineStartMs,
    value: range.startMs,
  });
  const endMs = projectSpectrumMusicDraftRangeBoundary({
    baseline: draft.baselineEndMs,
    value: range.endMs,
  });

  if (draft.startMs === startMs && draft.endMs === endMs) {
    return draft;
  }

  return {
    ...draft,
    startMs,
    endMs,
  };
}

export function resolveSpectrumMusicCommit(
  draft: SpectrumMusicDraft | null,
): SpectrumMusicCommitResolution | null {
  if (!draft) {
    return null;
  }

  const currentName = normalizeSpectrumMusicName(draft.name);
  if (currentName.length > 0) {
    return {
      kind: "keep",
      alias: currentName,
    };
  }

  return {
    kind: "restore",
    alias: draft.baselineName,
  };
}

function normalizeMusicCreateTitle(value: string) {
  return normalizeSpectrumMusicName(value);
}

function resolveMusicCreateUrl(args: {
  sourceUrl: string;
  startMs: number;
  endMs: number;
  title: string;
}) {
  return [
    args.sourceUrl,
    "spectrum",
    args.startMs,
    args.endMs,
    encodeURIComponent(args.title),
  ].join("#");
}

function isMusicEditTarget(music: Collection["musics"][number], edit: MusicEdit) {
  return (
    music.url === edit.url &&
    music.start_ms === edit.targetStartMs &&
    music.end_ms === edit.targetEndMs
  );
}

function isMusicDeleteTarget(music: Collection["musics"][number], deletion: MusicDelete) {
  return (
    music.url === deletion.url &&
    music.start_ms === deletion.startMs &&
    music.end_ms === deletion.endMs
  );
}

function updateMusicInCollection(collection: Collection, edit: MusicEdit): Collection {
  let didUpdate = false;
  const musics = collection.musics.map((music) => {
    if (!isMusicEditTarget(music, edit)) {
      return music;
    }

    didUpdate = true;
    return {
      ...music,
      alias: edit.alias,
      start_ms: edit.startMs,
      end_ms: edit.endMs,
    };
  });

  return didUpdate
    ? {
        ...collection,
        musics,
      }
    : collection;
}

export function updateMusicInCollections(
  collections: readonly Collection[],
  edit: MusicEdit,
): Collection[] {
  return collections.map((collection) => updateMusicInCollection(collection, edit));
}

function deleteMusicFromCollection(collection: Collection, deletion: MusicDelete): Collection {
  const musics = collection.musics.filter((music) => !isMusicDeleteTarget(music, deletion));

  return musics.length === collection.musics.length
    ? collection
    : {
        ...collection,
        musics,
      };
}

function isMusicCreateSourceCollection(collection: Collection, create: MusicCreate) {
  return collection.url === create.sourceCollectionUrl;
}

function appendCreatedMusicToCollection(collection: Collection, create: MusicCreate): Collection {
  if (!isMusicCreateSourceCollection(collection, create)) {
    return collection;
  }

  const exists = collection.musics.some(
    (music) =>
      music.url === create.music.url &&
      music.start_ms === create.music.start_ms &&
      music.end_ms === create.music.end_ms,
  );

  return {
    ...collection,
    musics: exists ? collection.musics : [...collection.musics, create.music],
  };
}

export function createMusicInCollections(
  collections: readonly Collection[],
  create: MusicCreate,
): Collection[] {
  return collections.map((collection) => appendCreatedMusicToCollection(collection, create));
}

export function deleteMusicFromCollections(
  collections: readonly Collection[],
  deletion: MusicDelete,
): Collection[] {
  return collections.map((collection) => deleteMusicFromCollection(collection, deletion));
}

export function hasSpectrumMusicDraftUpdates(drafts: readonly SpectrumMusicDraft[]) {
  return drafts.some((draft) => hasSpectrumMusicDraftChanges(draft));
}

export function hasSpectrumMusicDraftCreates(drafts: readonly SpectrumMusicDraft[]) {
  return createMusicDraftCreates(drafts).length > 0;
}

export function findSpectrumMusicDraft(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
): SpectrumMusicDraft | null {
  return drafts.find((draft) => createSpectrumMusicDraftRuntimeIdentity(draft) === id) ?? null;
}

export function changeSpectrumMusicDraftName(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
  name: string,
): SpectrumMusicDraft[] {
  return drafts.map((draft) =>
    createSpectrumMusicDraftRuntimeIdentity(draft) === id
      ? (changeSpectrumMusicDraftValueName(draft, name) ?? draft)
      : draft,
  );
}

function createPendingSpectrumMusicDraft(args: {
  sourceEndMs: number;
  sourceCollectionUrl: string | null;
  sourceGroup: SpectrumMusicSourceContext["source_group"] | null;
  sourcePath: SpectrumMusicSourceContext["source_path"];
  sourceUrl: string;
}): SpectrumMusicDraft | null {
  const sourceEndMs = normalizeSpectrumMusicRangeBoundary(args.sourceEndMs);

  if (sourceEndMs === null || sourceEndMs <= 0) {
    return null;
  }

  return {
    kind: "pending-create",
    baselineName: "",
    baselineStartMs: null,
    baselineEndMs: null,
    name: "",
    url: resolveMusicCreateUrl({
      sourceUrl: args.sourceUrl,
      startMs: 0,
      endMs: sourceEndMs,
      title: "",
    }),
    startMs: 0,
    endMs: sourceEndMs,
    sourceCollectionUrl: args.sourceCollectionUrl,
    sourceEndMs,
    sourceGroup: args.sourceGroup,
    sourcePath: args.sourcePath,
    sourceUrl: args.sourceUrl,
  };
}

export function activateSpectrumNewMusicDraft(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
  args: {
    fallbackSource?: {
      endMs: number | null;
      sourceUrl: string | null;
    };
    source: SpectrumMusicSourceContext | null;
  },
): SpectrumMusicDraft[] {
  const source = args.source;
  const sourceUrl = source?.source_url ?? args.fallbackSource?.sourceUrl ?? null;
  const sourceStartMs =
    source === null ? 0 : normalizeSpectrumMusicRangeBoundary(source.source_start_ms);
  const sourceEndMs = normalizeSpectrumMusicRangeBoundary(
    source?.source_end_ms ?? args.fallbackSource?.endMs ?? null,
  );
  if (
    !sourceUrl ||
    sourceStartMs === null ||
    sourceEndMs === null ||
    sourceStartMs >= sourceEndMs ||
    sourceEndMs <= 0 ||
    id !== createSpectrumNewMusicDraftIdentity({ sourceUrl })
  ) {
    return [...drafts];
  }

  const pendingDraft = createPendingSpectrumMusicDraft({
    sourceEndMs,
    sourceCollectionUrl: source?.source_collection_url ?? null,
    sourceGroup: source?.source_group ?? null,
    sourcePath: source?.source_path ?? null,
    sourceUrl,
  });
  if (!pendingDraft) {
    return [...drafts];
  }

  const hasPending = drafts.some(
    (draft) => draft.kind === "pending-create" && draft.sourceUrl === sourceUrl,
  );
  if (hasPending) {
    return [...drafts];
  }

  return [...drafts, pendingDraft];
}

export function changeSpectrumMusicDraftRange(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
  range: { endMs: number | null; startMs: number | null },
): SpectrumMusicDraft[] {
  return drafts.map((draft) =>
    createSpectrumMusicDraftRuntimeIdentity(draft) === id
      ? (changeSpectrumMusicDraftValueRange(draft, range) ?? draft)
      : draft,
  );
}

export function resetSpectrumMusicDraft(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
): SpectrumMusicDraft[] {
  return drafts.map((draft) =>
    createSpectrumMusicDraftRuntimeIdentity(draft) === id
      ? (resetSpectrumMusicDraftValue(draft) ?? draft)
      : draft,
  );
}

export function deleteSpectrumMusicDraft(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
): SpectrumMusicDraft[] {
  return drafts.flatMap((draft) => {
    const draftId = createSpectrumMusicDraftRuntimeIdentity(draft);

    if (draftId !== id) {
      return [draft];
    }

    if (draft.kind === "pending-create") {
      return [];
    }

    return [
      {
        ...draft,
        deleteRequested: true,
      },
    ];
  });
}

export function createMusicDraftEditFromDraft(draft: SpectrumMusicDraft): MusicDraftEdit | null {
  if (draft.deleteRequested === true || draft.kind === "pending-create") {
    return null;
  }

  const musicCommit = resolveSpectrumMusicCommit(draft);

  if (!musicCommit || !hasSpectrumMusicDraftChanges(draft)) {
    return null;
  }

  const startMs = projectSpectrumMusicDraftRangeBoundary({
    baseline: draft.baselineStartMs,
    value: draft.startMs,
  });
  const endMs = projectSpectrumMusicDraftRangeBoundary({
    baseline: draft.baselineEndMs,
    value: draft.endMs,
  });

  if (startMs === null || endMs === null) {
    return null;
  }

  return {
    id: createSpectrumMusicDraftIdentity({
      baselineEndMs: draft.baselineEndMs,
      baselineStartMs: draft.baselineStartMs,
      url: draft.url,
    }),
    alias: musicCommit.alias,
    endMs,
    startMs,
    targetEndMs: draft.baselineEndMs,
    targetStartMs: draft.baselineStartMs,
    url: draft.url,
  };
}

export function createMusicDraftEdits(drafts: readonly SpectrumMusicDraft[]): MusicDraftEdit[] {
  return drafts.flatMap((draft) => {
    const edit = createMusicDraftEditFromDraft(draft);
    return edit ? [edit] : [];
  });
}

export function createMusicDraftDeleteFromDraft(
  draft: SpectrumMusicDraft,
): MusicDraftDelete | null {
  if (draft.kind === "pending-create" || draft.deleteRequested !== true) {
    return null;
  }

  return {
    id: createSpectrumMusicDraftIdentity({
      baselineEndMs: draft.baselineEndMs,
      baselineStartMs: draft.baselineStartMs,
      url: draft.url,
    }),
    endMs: draft.baselineEndMs,
    startMs: draft.baselineStartMs,
    url: draft.url,
  };
}

export function createMusicDraftDeletes(drafts: readonly SpectrumMusicDraft[]): MusicDraftDelete[] {
  return drafts.flatMap((draft) => {
    const deletion = createMusicDraftDeleteFromDraft(draft);
    return deletion ? [deletion] : [];
  });
}

export function createMusicDraftCreateFromDraft(
  draft: SpectrumMusicDraft,
): MusicDraftCreate | null {
  if (draft.kind !== "pending-create" || draft.deleteRequested === true) {
    return null;
  }

  const title = normalizeMusicCreateTitle(draft.name);
  const startMs = normalizeSpectrumMusicDraftRangeBoundary(draft.startMs);
  const endMs =
    normalizeSpectrumMusicDraftRangeBoundary(draft.endMs) ??
    normalizeSpectrumMusicRangeBoundary(draft.sourceEndMs);
  if (title.length === 0 || startMs === null || endMs === null || startMs >= endMs) {
    return null;
  }
  if (!draft.sourceCollectionUrl || !draft.sourceGroup) {
    return null;
  }

  return {
    id: createSpectrumNewMusicDraftIdentity({ sourceUrl: draft.sourceUrl }),
    sourceCollectionUrl: draft.sourceCollectionUrl,
    music: {
      name: title,
      alias: title,
      group: draft.sourceGroup,
      path: draft.sourcePath,
      start_ms: startMs,
      end_ms: endMs,
      liked: false,
      url: resolveMusicCreateUrl({
        sourceUrl: draft.sourceUrl,
        startMs,
        endMs,
        title,
      }),
    },
  };
}

export function createMusicDraftCreates(drafts: readonly SpectrumMusicDraft[]): MusicDraftCreate[] {
  return drafts.flatMap((draft) => {
    const create = createMusicDraftCreateFromDraft(draft);
    return create ? [create] : [];
  });
}

export function hasSpectrumMusicDraftCommitOperations(drafts: readonly SpectrumMusicDraft[]) {
  return (
    createMusicDraftEdits(drafts).length > 0 ||
    createMusicDraftCreates(drafts).length > 0 ||
    createMusicDraftDeletes(drafts).length > 0
  );
}
