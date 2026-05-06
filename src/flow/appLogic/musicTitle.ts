import type { Collection, PlayList } from "@/src/cmd";
import type { PlaylistUpsertResult, SpectrumMusicTitleDraft } from "./core";

export interface MusicEdit {
  alias: string;
  endMs: number;
  startMs: number;
  targetEndMs: number;
  targetStartMs: number;
  url: string;
}

export type SpectrumMusicTitleCommitKind = "keep" | "restore";

export interface SpectrumMusicTitleCommitResolution {
  kind: SpectrumMusicTitleCommitKind;
  alias: string;
}

export function normalizeSpectrumMusicTitleName(name: string) {
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

export function createSpectrumMusicTitleDraft(args: {
  nowPlayingTrackName: string | null;
  nowPlayingTrackUrl: string | null;
  nowPlayingTrackStartMs: number | null;
  nowPlayingTrackEndMs: number | null;
}): SpectrumMusicTitleDraft | null {
  if (args.nowPlayingTrackName === null) {
    return null;
  }

  return {
    baselineName: args.nowPlayingTrackName,
    baselineStartMs: normalizeSpectrumMusicRangeBoundary(args.nowPlayingTrackStartMs),
    baselineEndMs: normalizeSpectrumMusicRangeBoundary(args.nowPlayingTrackEndMs),
    name: args.nowPlayingTrackName,
    url: args.nowPlayingTrackUrl,
    startMs: normalizeSpectrumMusicRangeBoundary(args.nowPlayingTrackStartMs),
    endMs: normalizeSpectrumMusicRangeBoundary(args.nowPlayingTrackEndMs),
  };
}

export function hasSpectrumMusicTitleChanges(draft: SpectrumMusicTitleDraft | null) {
  return (
    draft !== null &&
    (normalizeSpectrumMusicTitleName(draft.name) !==
      normalizeSpectrumMusicTitleName(draft.baselineName) ||
      !areSpectrumMusicDraftRangeBoundariesEqual(draft.startMs, draft.baselineStartMs) ||
      !areSpectrumMusicDraftRangeBoundariesEqual(draft.endMs, draft.baselineEndMs))
  );
}

export function resetSpectrumMusicTitleDraft(
  draft: SpectrumMusicTitleDraft | null,
): SpectrumMusicTitleDraft | null {
  if (!draft) {
    return null;
  }

  return {
    ...draft,
    name: draft.baselineName,
    startMs: draft.baselineStartMs,
    endMs: draft.baselineEndMs,
  };
}

export function changeSpectrumMusicTitleDraftName(
  draft: SpectrumMusicTitleDraft | null,
  name: string,
): SpectrumMusicTitleDraft | null {
  return draft ? { ...draft, name } : null;
}

export function changeSpectrumMusicTitleDraftRange(
  draft: SpectrumMusicTitleDraft | null,
  range: { endMs: number | null; startMs: number | null },
): SpectrumMusicTitleDraft | null {
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

export function resolveSpectrumMusicTitleCommit(
  draft: SpectrumMusicTitleDraft | null,
): SpectrumMusicTitleCommitResolution | null {
  if (!draft) {
    return null;
  }

  const currentName = normalizeSpectrumMusicTitleName(draft.name);
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
