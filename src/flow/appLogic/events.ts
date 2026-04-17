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
import { crab, type Collection, type PlayList } from "@/src/cmd";
import {
  createDraftFromPlayList,
  type ConfigDraft,
  type ConfigSidebarItem,
} from "./core";

export interface BootstrapResult {
  hasPlayList: boolean;
  playlists: PlayList[];
  collections: Collection[];
  savePath: string;
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

export const ss = defineSS(
  ns(
    "mainx",
    sst(
      ["idle", "loading", "ready", "configLoading", "config", "error"],
      ["run", "opencreate", "back"],
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
});
export const payloads = collect(
  ...event<string>()("playlist.open"),
  ...event<string>()("draft.name.changed"),
  ...event<string>()("save_path.changed"),
  ...event<Collection>()("collection.upserted"),
  ...event<Collection>()("draft.collection.upserted"),
  ...event<ConfigSidebarItem>()("draft.sidebar-item.pushed"),
);

export type MainStateT = Extract<keyof typeof ss.mainx.State, string>;
export type Events =
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>;
