import {
  collect,
  defineSS,
  event,
  ns,
  sst,
  allState,
  allSignal,
  createActors,
  type InvokeEvt,
  type PayloadEvt,
  type SignalEvt,
} from "@grahlnn/fn/flow";
import {
  crab,
  type Collection,
  type NowPlayingTrackChangedEvent,
  type PlayList,
  type PlayPlaylistSession,
} from "@/src/cmd";
import { getName } from "@tauri-apps/api/app";
import { documentDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import {
  createDraftFromPlayList,
  resolveSavedPath,
  type CollectionUpdatesChange,
  type ConfigSidebarItemRef,
  type ConfigDraft,
  type PlaylistUpsertResult,
} from "./core";

export interface BootstrapResult {
  hasPlayList: boolean;
  playlists: PlayList[];
  collections: Collection[];
  savePath: string;
}

export interface PlayPlaylistInput {
  playlistName: string;
  shouldStartPlayback: boolean;
}

export class BootstrapLoadError extends Error {
  constructor(
    message: string,
    public readonly savePath: string,
  ) {
    super(message);
    this.name = "BootstrapLoadError";
  }
}

async function resolveBootstrapSavePath() {
  const result = await crab.getMetaInfo();

  return result.match({
    Ok: (meta) => meta?.save_path ?? "",
    Err: () => "",
  });
}

export async function resolveDefaultSavePath() {
  return join(await documentDir(), await getName());
}

export async function chooseSavePath(currentSavePath: string): Promise<string | null> {
  const defaultPath = currentSavePath || (await resolveDefaultSavePath());
  const selectedPath = await open({
    directory: true,
    multiple: false,
    defaultPath,
  });

  return typeof selectedPath === "string" ? selectedPath : null;
}

export async function persistSavePath(selectedPath: string): Promise<string> {
  const result = await crab.saveMetaInfo({
    save_path: selectedPath,
  });

  return result.match({
    Ok: (meta) => resolveSavedPath(meta.save_path, selectedPath),
    Err: (error) => {
      throw new Error(error);
    },
  });
}

export async function deletePlaylistRecord(playlistName: string): Promise<boolean> {
  const result = await crab.deletePlaylist(playlistName);

  return result.match({
    Ok: () => true,
    Err: (error) => {
      throw new Error(error);
    },
  });
}

export async function stopPlayback(): Promise<boolean> {
  const result = await crab.stopPlayback();

  return result.match({
    Ok: (stopped) => stopped,
    Err: (error) => {
      throw new Error(error);
    },
  });
}

export async function listenNowPlayingTrackChanged(
  handler: (payload: NowPlayingTrackChangedEvent) => void,
): Promise<() => void> {
  return crab.evt("nowPlayingTrackChangedEvent")(handler);
}

export const ss = defineSS(
  ns(
    "mainx",
    sst(
      [
        "idle",
        "loading",
        "ready",
        "play",
        "spectrum",
        "configLoading",
        "config",
        "configUpdatingCollectionUpdates",
        "error",
      ],
      ["run", "opencreate", "openspectrum", "back"],
    ),
  ),
);
export const state = allState(ss);
export const sig = allSignal(ss);
export const invoker = createActors({
  loadCollections: async (): Promise<BootstrapResult> => {
    const savePath = await resolveBootstrapSavePath();
    const result = await crab.checkList();
    const hasPlayList = result.match({
      Ok: (value) => value,
      Err: (error) => {
        throw new BootstrapLoadError(error, savePath);
      },
    });

    if (!hasPlayList) {
      return {
        hasPlayList: false,
        playlists: [],
        collections: [],
        savePath,
      };
    }

    const [playlists, collections] = await Promise.all([
      crab.listPlaylists(),
      crab.listCollections(),
    ]);

    return playlists.match({
      Ok: (playlistValues) =>
        collections.match({
          Ok: (collectionValues) => ({
            hasPlayList: true,
            playlists: playlistValues,
            collections: collectionValues,
            savePath,
          }),
          Err: (error) => {
            throw new BootstrapLoadError(error, savePath);
          },
        }),
      Err: (error) => {
        throw new BootstrapLoadError(error, savePath);
      },
    });
  },
  loadPlaylistDraft: async (playlistName: string): Promise<ConfigDraft> => {
    const result = await crab.getPlaylist(playlistName);

    return result.match({
      Ok: (playlist) => {
        if (!playlist) {
          throw new Error(`playlist \`${playlistName}\` not found`);
        }

        return createDraftFromPlayList(playlist);
      },
      Err: (error) => {
        throw new Error(error);
      },
    });
  },
  setCollectionUpdates: async (input: CollectionUpdatesChange): Promise<Collection> => {
    const result = await crab.setCollectionUpdates(input.url, input.enabled);

    return result.match({
      Ok: (collection) => {
        if (!collection) {
          throw new Error(`collection \`${input.url}\` not found`);
        }

        return collection;
      },
      Err: (error) => {
        throw new Error(error);
      },
    });
  },
  playPlaylist: async (input: PlayPlaylistInput): Promise<PlayPlaylistSession | null> => {
    if (!input.shouldStartPlayback) {
      return null;
    }

    const result = await crab.playPlaylist(input.playlistName);

    return result.match({
      Ok: (session) => session,
      Err: (error) => {
        throw new Error(error);
      },
    });
  },
});
export const payloads = collect(
  ...event<string>()("playlist.open"),
  ...event<string>()("playlist.play"),
  ...event<PlaylistUpsertResult>()("playlist.upserted"),
  ...event<string>()("playlist.deleted"),
  ...event<PlaylistUpsertResult | null>()("playlist.preview.changed"),
  ...event<string>()("draft.name.changed"),
  ...event<string>()("save_path.changed"),
  ...event<Collection>()("collection.upserted"),
  ...event<Collection>()("draft.collection.upserted"),
  ...event<ConfigSidebarItemRef>()("draft.item.included"),
  ...event<ConfigSidebarItemRef>()("draft.item.removed"),
  ...event<CollectionUpdatesChange>()("collection.updates.requested"),
  ...event<NowPlayingTrackChangedEvent>()("player.now_playing_track.changed"),
);

export type MainStateT = Extract<keyof typeof ss.mainx.State, string>;
export type Events =
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>;
