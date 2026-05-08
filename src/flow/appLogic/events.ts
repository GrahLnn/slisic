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
  type Music,
  type NowPlayingTrackChangedEvent,
  type PlayList,
  type PlaybackContinuationMode,
  type PlaybackStatusPayload,
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
  type SpectrumMusicDraft,
} from "./core";
import { createSpectrumMusicDrafts, type MusicDraftDelete } from "./musicTitle";

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

export interface MusicUpdateInput {
  alias: string;
  endMs: number;
  startMs: number;
  targetEndMs: number;
  targetStartMs: number;
  url: string;
}

export interface MusicUpdateResult {
  input: MusicUpdateInput;
  music: Music;
}

export interface MusicUpdatesResult {
  results: MusicUpdateResult[];
}

export interface MusicDeletesResult {
  results: MusicDraftDelete[];
}

export interface SpectrumMusicDraftBootstrapInput {
  filePath: string;
  nowPlayingTrackEndMs: number | null;
  nowPlayingTrackStartMs: number | null;
  nowPlayingTrackUrl: string | null;
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

export async function resumePlayback(): Promise<boolean> {
  const result = await crab.resumePlayback();

  return result.match({
    Ok: (resumed) => resumed,
    Err: (error) => {
      throw new Error(error);
    },
  });
}

export async function getPlaybackStatus(): Promise<PlaybackStatusPayload | null> {
  const result = await crab.getPlaybackStatus();

  return result.match({
    Ok: (status) => status,
    Err: (error) => {
      throw new Error(error);
    },
  });
}

export async function setPlaybackContinuationMode(
  mode: PlaybackContinuationMode,
): Promise<boolean> {
  const result = await crab.setPlaybackContinuationMode(mode);

  return result.match({
    Ok: () => true,
    Err: (error) => {
      throw new Error(error);
    },
  });
}

export async function enterSpectrumPlaybackScope(): Promise<number> {
  const result = await crab.enterSpectrumPlaybackScope();

  return result.match({
    Ok: (scopeId) => scopeId,
    Err: (error) => {
      throw new Error(error);
    },
  });
}

export async function exitSpectrumPlaybackScope(scopeId: number): Promise<boolean> {
  const result = await crab.exitSpectrumPlaybackScope(scopeId);

  return result.match({
    Ok: () => true,
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
        "spectrumLoadingMusics",
        "spectrum",
        "spectrumUpdatingMusic",
        "spectrumDeletingMusic",
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
  updateMusics: async (inputs: MusicUpdateInput[]): Promise<MusicUpdatesResult> => {
    const results: MusicUpdateResult[] = [];

    for (const input of inputs) {
      const result = await crab.updateMusic(
        input.url,
        input.targetStartMs,
        input.targetEndMs,
        input.alias,
        input.startMs,
        input.endMs,
      );

      const updateResult = result.match({
        Ok: (music) => {
          if (!music) {
            throw new Error(`music \`${input.url}\` not found`);
          }

          return {
            input,
            music,
          };
        },
        Err: (error) => {
          throw new Error(error);
        },
      });
      results.push(updateResult);
    }

    return { results };
  },
  deleteMusics: async (inputs: MusicDraftDelete[]): Promise<MusicDeletesResult> => {
    const results: MusicDraftDelete[] = [];

    for (const input of inputs) {
      const result = await crab.deleteMusic(input.url, input.startMs, input.endMs);

      result.match({
        Ok: () => undefined,
        Err: (error) => {
          throw new Error(error);
        },
      });
      results.push(input);
    }

    return { results };
  },
  loadSpectrumMusicDrafts: async (
    input: SpectrumMusicDraftBootstrapInput,
  ): Promise<SpectrumMusicDraft[]> => {
    const result = await crab.listMusicsByFilePath(input.filePath);

    return result.match({
      Ok: (fileMusics) =>
        createSpectrumMusicDrafts({
          currentMusicIdentity: {
            endMs: input.nowPlayingTrackEndMs,
            startMs: input.nowPlayingTrackStartMs,
            url: input.nowPlayingTrackUrl,
          },
          fileMusics,
        }),
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
  ...event<{ id: string; name: string }>()("spectrum.music_name.changed"),
  ...event<{ endMs: number | null; id: string; startMs: number | null }>()(
    "spectrum.music_range.changed",
  ),
  ...event<{ id: string }>()("spectrum.music_deleted"),
  ...event<{ id: string }>()("spectrum.music_draft.reset"),
  ...event<number | null>()("spectrum.playback_scope.changed"),
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
