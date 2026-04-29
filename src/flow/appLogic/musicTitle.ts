import type { Collection, PlayList } from "@/src/cmd";
import type { PlaylistUpsertResult, SpectrumMusicTitleDraft } from "./core";

export interface MusicTitleEdit {
  name: string;
  url: string;
}

export type SpectrumMusicTitleCommitKind = "keep" | "restore";

export interface SpectrumMusicTitleCommitResolution {
  kind: SpectrumMusicTitleCommitKind;
  name: string;
}

export function normalizeSpectrumMusicTitleName(name: string) {
  return name.trim();
}

export function createSpectrumMusicTitleDraft(args: {
  nowPlayingTrackName: string | null;
  nowPlayingTrackUrl: string | null;
}): SpectrumMusicTitleDraft | null {
  if (args.nowPlayingTrackName === null) {
    return null;
  }

  return {
    baselineName: args.nowPlayingTrackName,
    name: args.nowPlayingTrackName,
    url: args.nowPlayingTrackUrl,
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
      name: currentName,
    };
  }

  return {
    kind: "restore",
    name: draft.baselineName,
  };
}

function renameMusicInCollection(collection: Collection, edit: MusicTitleEdit): Collection {
  let didRename = false;
  const musics = collection.musics.map((music) => {
    if (music.url !== edit.url) {
      return music;
    }

    didRename = true;
    return {
      ...music,
      name: edit.name,
    };
  });

  return didRename
    ? {
        ...collection,
        musics,
      }
    : collection;
}

export function renameMusicInCollections(
  collections: readonly Collection[],
  edit: MusicTitleEdit,
): Collection[] {
  return collections.map((collection) => renameMusicInCollection(collection, edit));
}

export function renameMusicInPlaylists(
  playlists: readonly PlayList[],
  edit: MusicTitleEdit,
): PlayList[] {
  return playlists.map((playlist) => ({
    ...playlist,
    collections: renameMusicInCollections(playlist.collections, edit),
  }));
}

export function renameMusicInPlaylistPreview(
  preview: PlaylistUpsertResult | null,
  edit: MusicTitleEdit,
): PlaylistUpsertResult | null {
  if (!preview) {
    return null;
  }

  return {
    ...preview,
    playlist: {
      ...preview.playlist,
      collections: renameMusicInCollections(preview.playlist.collections, edit),
    },
  };
}
