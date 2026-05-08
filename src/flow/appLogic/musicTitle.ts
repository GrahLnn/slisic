import type { Collection, PlayList } from "@/src/cmd";
import type { PlaylistUpsertResult, SpectrumMusicDraft } from "./core";

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

function areSpectrumMusicDraftRangeBoundariesEqual(left: number | null, right: number | null) {
  const normalizedLeft = normalizeSpectrumMusicDraftRangeBoundary(left);
  const normalizedRight = normalizeSpectrumMusicDraftRangeBoundary(right);

  if (normalizedLeft === null || normalizedRight === null) {
    return normalizedLeft === normalizedRight;
  }

  return normalizedLeft === normalizedRight;
}

function createSpectrumMusicDraftValue(args: {
  name: string;
  url: string;
  startMs: number;
  endMs: number;
}): SpectrumMusicDraft {
  const startMs = normalizeSpectrumMusicRangeBoundary(args.startMs);
  const endMs = normalizeSpectrumMusicRangeBoundary(args.endMs);

  return {
    baselineName: args.name,
    baselineStartMs: startMs,
    baselineEndMs: endMs,
    name: args.name,
    url: args.url,
    startMs,
    endMs,
  };
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
  const seen = new Set(
    args.baseDrafts.map((draft) =>
      createSpectrumMusicDraftIdentity({
        baselineEndMs: draft.baselineEndMs,
        baselineStartMs: draft.baselineStartMs,
        url: draft.url,
      }),
    ),
  );
  const merged = [...args.baseDrafts];

  for (const draft of args.incomingDrafts) {
    const key = createSpectrumMusicDraftIdentity({
      baselineEndMs: draft.baselineEndMs,
      baselineStartMs: draft.baselineStartMs,
      url: draft.url,
    });
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(draft);
  }

  return merged;
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
  return (
    draft !== null &&
    (draft.deleteRequested === true ||
      normalizeSpectrumMusicName(draft.name) !== normalizeSpectrumMusicName(draft.baselineName) ||
      !areSpectrumMusicDraftRangeBoundariesEqual(draft.startMs, draft.baselineStartMs) ||
      !areSpectrumMusicDraftRangeBoundariesEqual(draft.endMs, draft.baselineEndMs))
  );
}

export function resetSpectrumMusicDraftValue(
  draft: SpectrumMusicDraft | null,
): SpectrumMusicDraft | null {
  if (!draft) {
    return null;
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

  const startMs = normalizeSpectrumMusicDraftRangeBoundary(range.startMs);
  const endMs = normalizeSpectrumMusicDraftRangeBoundary(range.endMs);

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

export function updateMusicInPlaylists(
  playlists: readonly PlayList[],
  edit: MusicEdit,
): PlayList[] {
  return playlists.map((playlist) => ({
    ...playlist,
    collections: updateMusicInCollections(playlist.collections, edit),
  }));
}

export function updateMusicInPlaylistPreview(
  preview: PlaylistUpsertResult | null,
  edit: MusicEdit,
): PlaylistUpsertResult | null {
  if (!preview) {
    return null;
  }

  return {
    ...preview,
    playlist: {
      ...preview.playlist,
      collections: updateMusicInCollections(preview.playlist.collections, edit),
    },
  };
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

export function deleteMusicFromCollections(
  collections: readonly Collection[],
  deletion: MusicDelete,
): Collection[] {
  return collections.map((collection) => deleteMusicFromCollection(collection, deletion));
}

export function deleteMusicFromPlaylists(
  playlists: readonly PlayList[],
  deletion: MusicDelete,
): PlayList[] {
  return playlists.map((playlist) => ({
    ...playlist,
    collections: deleteMusicFromCollections(playlist.collections, deletion),
  }));
}

export function deleteMusicFromPlaylistPreview(
  preview: PlaylistUpsertResult | null,
  deletion: MusicDelete,
): PlaylistUpsertResult | null {
  if (!preview) {
    return null;
  }

  return {
    ...preview,
    playlist: {
      ...preview.playlist,
      collections: deleteMusicFromCollections(preview.playlist.collections, deletion),
    },
  };
}

export function hasSpectrumMusicDraftUpdates(drafts: readonly SpectrumMusicDraft[]) {
  return drafts.some((draft) => hasSpectrumMusicDraftChanges(draft));
}

export function findSpectrumMusicDraft(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
): SpectrumMusicDraft | null {
  return (
    drafts.find(
      (draft) =>
        createSpectrumMusicDraftIdentity({
          baselineEndMs: draft.baselineEndMs,
          baselineStartMs: draft.baselineStartMs,
          url: draft.url,
        }) === id,
    ) ?? null
  );
}

export function changeSpectrumMusicDraftName(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
  name: string,
): SpectrumMusicDraft[] {
  return drafts.map((draft) =>
    createSpectrumMusicDraftIdentity({
      baselineEndMs: draft.baselineEndMs,
      baselineStartMs: draft.baselineStartMs,
      url: draft.url,
    }) === id
      ? (changeSpectrumMusicDraftValueName(draft, name) ?? draft)
      : draft,
  );
}

export function changeSpectrumMusicDraftRange(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
  range: { endMs: number | null; startMs: number | null },
): SpectrumMusicDraft[] {
  return drafts.map((draft) =>
    createSpectrumMusicDraftIdentity({
      baselineEndMs: draft.baselineEndMs,
      baselineStartMs: draft.baselineStartMs,
      url: draft.url,
    }) === id
      ? (changeSpectrumMusicDraftValueRange(draft, range) ?? draft)
      : draft,
  );
}

export function resetSpectrumMusicDraft(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
): SpectrumMusicDraft[] {
  return drafts.map((draft) =>
    createSpectrumMusicDraftIdentity({
      baselineEndMs: draft.baselineEndMs,
      baselineStartMs: draft.baselineStartMs,
      url: draft.url,
    }) === id
      ? (resetSpectrumMusicDraftValue(draft) ?? draft)
      : draft,
  );
}

export function deleteSpectrumMusicDraft(
  drafts: readonly SpectrumMusicDraft[],
  id: string,
): SpectrumMusicDraft[] {
  return drafts.map((draft) =>
    createSpectrumMusicDraftIdentity({
      baselineEndMs: draft.baselineEndMs,
      baselineStartMs: draft.baselineStartMs,
      url: draft.url,
    }) === id
      ? {
          ...draft,
          deleteRequested: true,
        }
      : draft,
  );
}

export function createMusicDraftEditFromDraft(draft: SpectrumMusicDraft): MusicDraftEdit | null {
  if (draft.deleteRequested === true) {
    return null;
  }

  const musicCommit = resolveSpectrumMusicCommit(draft);

  if (!musicCommit || !hasSpectrumMusicDraftChanges(draft)) {
    return null;
  }

  if (
    draft.url === null ||
    draft.baselineStartMs === null ||
    draft.baselineEndMs === null ||
    draft.startMs === null ||
    draft.endMs === null
  ) {
    return null;
  }

  const startMs = normalizeSpectrumMusicRangeBoundary(draft.startMs);
  const endMs = normalizeSpectrumMusicRangeBoundary(draft.endMs);

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
  if (
    draft.deleteRequested !== true ||
    draft.url === null ||
    draft.baselineStartMs === null ||
    draft.baselineEndMs === null
  ) {
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
