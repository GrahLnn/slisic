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
  type ConfigLibraryView,
  type ExcludeCurrentMusicAndSkipResult,
  type Music,
  type NowPlayingTrackChangedEvent,
  type PlaybackExcludeCommittedEvent,
  type PlaybackDiagnosticTraceEvent,
  type PlaybackContinuationMode,
  type PlaybackStatusPayload,
  type PlayListListView,
  type PlayPlaylistSession,
  type SpectrumMusicContext,
  type SpectrumMusicSourceContext,
} from "@/src/cmd";
import { documentDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import {
  createDraftFromPlayListConfig,
  resolveSavedPath,
  type CollectionUpdatesChange,
  type ConfigSidebarItemRef,
  type ConfigDraft,
  type ExcludeAddedChange,
  type ExcludeRemovedChange,
  type PlaylistPreview,
  type PlaylistUpsertResult,
  type SpectrumMusicDraft,
} from "./core";
import { createSpectrumMusicDrafts, type MusicDraftDelete } from "./musicTitle";

const DEFAULT_SAVE_FOLDER_NAME = "slisic";

export interface BootstrapResult {
  hasPlayList: boolean;
  playlists: PlayListListView[];
  collections: Collection[];
  configLibrary: ConfigLibraryView;
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

export interface MusicCreateInput {
  sourceCollectionUrl: string;
  music: Music;
}

export interface MusicCreateResult {
  input: MusicCreateInput;
  music: Music;
}

export interface MusicCreatesResult {
  results: MusicCreateResult[];
}

export interface MusicDeletesResult {
  results: MusicDraftDelete[];
}

export interface SpectrumMusicDraftBootstrapInput {
  filePath: string;
  nowPlayingTrackEndMs: number;
  nowPlayingTrackStartMs: number;
  nowPlayingTrackUrl: string;
}

export interface SpectrumMusicDraftBootstrapResult {
  drafts: SpectrumMusicDraft[];
  source: SpectrumMusicSourceContext | null;
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
  return join(await documentDir(), DEFAULT_SAVE_FOLDER_NAME);
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

export async function chooseCollectionFolder(currentSavePath: string): Promise<string | null> {
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

export async function createLocalCollectionShell(collectionPath: string): Promise<Collection> {
  const result = await crab.createLocalCollectionShell(collectionPath);

  return result.match({
    Ok: (collection) => collection,
    Err: (error) => {
      throw new Error(error);
    },
  });
}

export async function importLocalCollection(collectionPath: string): Promise<Collection> {
  const result = await crab.importLocalCollection(collectionPath);

  return result.match({
    Ok: (collection) => collection,
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

export async function excludeCurrentMusicAndSkip(): Promise<ExcludeCurrentMusicAndSkipResult> {
  const result = await crab.excludeCurrentMusicAndSkip();

  return result.match({
    Ok: (excludeResult) => excludeResult,
    Err: (error) => {
      throw new Error(error);
    },
  });
}

export async function setCurrentMusicLiked(liked: boolean): Promise<Music | null> {
  const result = await crab.setCurrentMusicLiked(liked);

  return result.match({
    Ok: (music) => music,
    Err: (error) => {
      throw new Error(error);
    },
  });
}

export async function removeExclude(change: ExcludeRemovedChange): Promise<ExcludeRemovedChange> {
  const result = await crab.removeExclude(change.music);

  return result.match({
    Ok: (removeResult) => ({
      music: change.music,
      excludeAvailability: removeResult.exclude_availability,
    }),
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

export async function listenPlaybackDiagnosticTrace(
  handler: (payload: PlaybackDiagnosticTraceEvent) => void,
): Promise<() => void> {
  return crab.evt("playbackDiagnosticTraceEvent")(handler);
}

export async function listenPlaybackExcludeCommitted(
  handler: (payload: PlaybackExcludeCommittedEvent) => void,
): Promise<() => void> {
  return crab.evt("playbackExcludeCommittedEvent")(handler);
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
        "spectrumUpdatingMusic",
        "spectrumCreatingMusic",
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
        configLibrary: {
          collections: [],
          groups: [],
          excludes: [],
          exclude_availability: {
            fully_excluded_collection_urls: [],
            fully_excluded_group_urls: [],
          },
        },
        savePath,
      };
    }

    const [playlists, configLibrary] = await Promise.all([
      crab.listPlaylists(),
      crab.listConfigLibrary(),
    ]);

    return playlists.match({
      Ok: (playlistValues) =>
        configLibrary.match({
          Ok: (libraryValue) => ({
            hasPlayList: true,
            playlists: playlistValues,
            collections: [],
            configLibrary: libraryValue,
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
    const result = await crab.getPlaylistConfig(playlistName);

    return result.match({
      Ok: (playlist) => {
        if (!playlist) {
          throw new Error(`playlist \`${playlistName}\` not found`);
        }

        return createDraftFromPlayListConfig(playlist);
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
  removeExclude,
  playPlaylist: async (input: PlayPlaylistInput): Promise<PlayPlaylistSession | null> => {
    if (!input.shouldStartPlayback) {
      return null;
    }

    const result = await crab.playPlaylist(input.playlistName);

    return result.match({
      Ok: (session) => (session.status === "started" ? session : null),
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
  createMusics: async (inputs: MusicCreateInput[]): Promise<MusicCreatesResult> => {
    const results: MusicCreateResult[] = [];

    for (const input of inputs) {
      const result = await crab.createMusic(input.sourceCollectionUrl, input.music);

      const createResult = result.match({
        Ok: (music) => ({
          input,
          music,
        }),
        Err: (error) => {
          throw new Error(error);
        },
      });
      results.push(createResult);
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
  ): Promise<SpectrumMusicDraftBootstrapResult> => {
    const result = await crab.loadSpectrumMusicContext(
      input.filePath,
      input.nowPlayingTrackUrl,
      input.nowPlayingTrackStartMs,
      input.nowPlayingTrackEndMs,
    );

    return result.match({
      Ok: (context: SpectrumMusicContext) => {
        const drafts = createSpectrumMusicDrafts({
          currentMusicIdentity: {
            endMs: input.nowPlayingTrackEndMs,
            startMs: input.nowPlayingTrackStartMs,
            url: input.nowPlayingTrackUrl,
          },
          fileMusics: context.file_musics,
        });

        return {
          drafts,
          source: context.source,
        };
      },
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
  ...event<PlaylistPreview | null>()("playlist.preview.changed"),
  ...event<string>()("draft.name.changed"),
  ...event<{ id: string; name: string }>()("spectrum.music_name.changed"),
  ...event<{ endMs: number | null; id: string; startMs: number | null }>()(
    "spectrum.music_range.changed",
  ),
  ...event<{ id: string }>()("spectrum.music_deleted"),
  ...event<{ id: string }>()("spectrum.music_create_started"),
  ...event<{ id: string }>()("spectrum.music_draft.reset"),
  ...event<number | null>()("spectrum.playback_scope.changed"),
  ...event<string>()("save_path.changed"),
  ...event<Collection>()("collection.upserted"),
  ...event<Collection>()("draft.collection.upserted"),
  ...event<ConfigSidebarItemRef>()("draft.item.included"),
  ...event<ConfigSidebarItemRef>()("draft.item.removed"),
  ...event<CollectionUpdatesChange>()("collection.updates.requested"),
  ...event<ExcludeAddedChange>()("exclude.added"),
  ...event<ExcludeRemovedChange>()("exclude.removed"),
  ...event<NowPlayingTrackChangedEvent>()("player.now_playing_track.changed"),
);

export type MainStateT = Extract<keyof typeof ss.mainx.State, string>;
export type Events =
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>;
