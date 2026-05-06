import type { Collection, PlayList } from "@/src/cmd";
import type { PlaylistUpsertResult, SpectrumMusicTitleDraft } from "./core";

export interface MusicEdit {
  alias: string;
  end: number;
  start: number;
  targetEnd: number;
  targetStart: number;
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
    ? Math.max(0, Math.trunc(value))
    : null;
}

export function createSpectrumMusicTitleDraft(args: {
  nowPlayingTrackName: string | null;
  nowPlayingTrackUrl: string | null;
  nowPlayingTrackStart: number | null;
  nowPlayingTrackEnd: number | null;
}): SpectrumMusicTitleDraft | null {
  if (args.nowPlayingTrackName === null) {
    return null;
  }

  return {
    baselineName: args.nowPlayingTrackName,
    baselineStart: normalizeSpectrumMusicRangeBoundary(args.nowPlayingTrackStart),
    baselineEnd: normalizeSpectrumMusicRangeBoundary(args.nowPlayingTrackEnd),
    name: args.nowPlayingTrackName,
    url: args.nowPlayingTrackUrl,
    start: normalizeSpectrumMusicRangeBoundary(args.nowPlayingTrackStart),
    end: normalizeSpectrumMusicRangeBoundary(args.nowPlayingTrackEnd),
  };
}

export function hasSpectrumMusicTitleChanges(draft: SpectrumMusicTitleDraft | null) {
  return (
    draft !== null &&
    (normalizeSpectrumMusicTitleName(draft.name) !==
      normalizeSpectrumMusicTitleName(draft.baselineName) ||
      normalizeSpectrumMusicRangeBoundary(draft.start) !==
        normalizeSpectrumMusicRangeBoundary(draft.baselineStart) ||
      normalizeSpectrumMusicRangeBoundary(draft.end) !==
        normalizeSpectrumMusicRangeBoundary(draft.baselineEnd))
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
    start: draft.baselineStart,
    end: draft.baselineEnd,
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
  range: { end: number; start: number },
): SpectrumMusicTitleDraft | null {
  if (!draft) {
    return null;
  }

  const start = normalizeSpectrumMusicRangeBoundary(range.start);
  const end = normalizeSpectrumMusicRangeBoundary(range.end);

  return {
    ...draft,
    start,
    end,
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
  return music.url === edit.url && music.start === edit.targetStart && music.end === edit.targetEnd;
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
      start: edit.start,
      end: edit.end,
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
