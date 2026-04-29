import type { Collection, PlayList } from "@/src/cmd";
import type { PlaylistUpsertResult, SpectrumMusicTitleDraft } from "./core";

export interface MusicAliasEdit {
  alias: string;
  url: string;
  start: number;
  end: number;
}

export type SpectrumMusicTitleCommitKind = "keep" | "restore";

export interface SpectrumMusicTitleCommitResolution {
  kind: SpectrumMusicTitleCommitKind;
  alias: string;
}

export function normalizeSpectrumMusicTitleName(name: string) {
  return name.trim();
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
    name: args.nowPlayingTrackName,
    url: args.nowPlayingTrackUrl,
    start: args.nowPlayingTrackStart,
    end: args.nowPlayingTrackEnd,
  };
}

export function hasSpectrumMusicTitleChanges(draft: SpectrumMusicTitleDraft | null) {
  return draft !== null && draft.name !== draft.baselineName;
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

function isMusicAliasEditTarget(music: Collection["musics"][number], edit: MusicAliasEdit) {
  return music.url === edit.url && music.start === edit.start && music.end === edit.end;
}

function updateMusicAliasInCollection(collection: Collection, edit: MusicAliasEdit): Collection {
  let didRename = false;
  const musics = collection.musics.map((music) => {
    if (!isMusicAliasEditTarget(music, edit)) {
      return music;
    }

    didRename = true;
    return {
      ...music,
      alias: edit.alias,
    };
  });

  return didRename
    ? {
        ...collection,
        musics,
      }
    : collection;
}

export function updateMusicAliasInCollections(
  collections: readonly Collection[],
  edit: MusicAliasEdit,
): Collection[] {
  return collections.map((collection) => updateMusicAliasInCollection(collection, edit));
}

export function updateMusicAliasInPlaylists(
  playlists: readonly PlayList[],
  edit: MusicAliasEdit,
): PlayList[] {
  return playlists.map((playlist) => ({
    ...playlist,
    collections: updateMusicAliasInCollections(playlist.collections, edit),
  }));
}

export function updateMusicAliasInPlaylistPreview(
  preview: PlaylistUpsertResult | null,
  edit: MusicAliasEdit,
): PlaylistUpsertResult | null {
  if (!preview) {
    return null;
  }

  return {
    ...preview,
    playlist: {
      ...preview.playlist,
      collections: updateMusicAliasInCollections(preview.playlist.collections, edit),
    },
  };
}
