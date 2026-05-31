import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createActor, fromPromise } from "xstate";
import type {
  Collection,
  CollectionGroupOwner,
  ConfigLibraryView,
  Group,
  Music,
  PlayList,
  PlayListListView,
  SpectrumMusicSourceContext,
} from "@/src/cmd";
import type { ConfigDraft } from "./core";
import { machine } from "./machine";
import {
  payloads,
  sig,
  type BootstrapResult,
  type MusicCreateInput,
  type MusicCreatesResult,
  type MusicDeletesResult,
  type MusicUpdateInput,
  type MusicUpdatesResult,
  type SpectrumMusicDraftBootstrapInput,
  type SpectrumMusicDraftBootstrapResult,
} from "./events";
import type { MusicDraftDelete } from "./musicTitle";

const spectrumMusicDeleted = payloads["spectrum.music_deleted"];
const spectrumMusicCreateStarted = payloads["spectrum.music_create_started"];
const spectrumMusicNameChanged = payloads["spectrum.music_name.changed"];
const spectrumMusicRangeChanged = payloads["spectrum.music_range.changed"];
const spectrumPlaybackScopeChanged = payloads["spectrum.playback_scope.changed"];

const sampleCollectionOwner: CollectionGroupOwner = {
  name: "Quiet Morning",
  url: "https://example.com/quiet-morning",
  folder: "youtube/quiet-morning",
  last_updated: "2026-04-13T00:00:00Z",
  enable_updates: null,
};

function createGroup(overrides: Partial<Group> = {}): Group {
  return {
    name: "Quiet Morning",
    url: "https://example.com/quiet-morning#disc-1",
    collection: sampleCollectionOwner,
    folder: "Disc 1",
    ...overrides,
  };
}

function createMusic(overrides: Partial<Music> = {}): Music {
  return {
    name: "Track A",
    alias: "Track A",
    group: createGroup(),
    canonical_music_id: "source:https://example.com/quiet-morning#a:0:120000",
    url: "https://example.com/quiet-morning#a",
    path: "Disc 1/Track A.m4a",
    start_ms: 0,
    end_ms: 120_000,
    liked: false,
    ...overrides,
  };
}

function createCollection(musics: Music[]): Collection {
  return {
    name: "Quiet Morning",
    url: "https://example.com/quiet-morning",
    folder: "youtube/quiet-morning",
    musics,
    last_updated: "2026-04-13T00:00:00Z",
    enable_updates: null,
  };
}

function createPlaylist(collection: Collection): PlayList {
  return {
    name: "Focus Session",
    collections: [collection],
    groups: [],
    extra: [],
    created_at: "2026-04-13T00:00:00Z",
  };
}

function createPlaylistSurface(playlist: PlayList): PlayListListView {
  return {
    name: playlist.name,
    created_at: playlist.created_at,
  };
}

function createConfigLibrary(collections: readonly Collection[]): ConfigLibraryView {
  return {
    collections: collections.map((collection) => ({
      name: collection.name,
      url: collection.url,
      folder: collection.folder,
      last_updated: collection.last_updated,
      enable_updates: collection.enable_updates,
    })),
    groups: [],
    collection_group_memberships: [],
    excludes: [],
    exclude_availability: {
      fully_excluded_collection_urls: [],
      fully_excluded_group_urls: [],
    },
  };
}

function createBootstrapResult(collections: readonly Collection[]): BootstrapResult {
  const playlist = createPlaylist(collections[0] ?? createCollection([]));

  return {
    hasPlayList: collections.length > 0,
    playlists: collections.length > 0 ? [createPlaylistSurface(playlist)] : [],
    collections: [...collections],
    configLibrary: createConfigLibrary(collections),
    savePath: "C:/Music",
  };
}

function createShallowBootstrapResult(collections: readonly Collection[]): BootstrapResult {
  const playlist = createPlaylist(collections[0] ?? createCollection([]));

  return {
    hasPlayList: collections.length > 0,
    playlists: collections.length > 0 ? [createPlaylistSurface(playlist)] : [],
    collections: [],
    configLibrary: createConfigLibrary(collections),
    savePath: "C:/Music",
  };
}

function createSpectrumMusicSourceContext(
  collection: Collection,
  music: Music,
): SpectrumMusicSourceContext {
  return {
    source_collection_url: collection.url,
    source_end_ms: music.end_ms,
    source_group: music.group,
    source_path: music.path,
    source_start_ms: music.start_ms,
    source_url: music.url,
  };
}

function createConfigDraftFromPlaylist(playlist: PlayList): ConfigDraft {
  return {
    mode: "edit",
    name: playlist.name,
    collections: playlist.collections.map((collection) => ({
      name: collection.name,
      url: collection.url,
      folder: collection.folder,
      last_updated: collection.last_updated,
      enable_updates: collection.enable_updates,
    })),
    groups: playlist.groups,
    extra: playlist.extra,
    createdAt: playlist.created_at,
  };
}

function waitForState(
  actor: {
    getSnapshot: () => { value: unknown };
    subscribe: (
      listener: (snapshot: { value: unknown }) => void,
    ) => { unsubscribe: () => void };
  },
  expectedState: string,
  timeoutMs = 2000,
) {
  if (actor.getSnapshot().value === expectedState) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`unexpected state: ${String(actor.getSnapshot().value)}`));
    }, timeoutMs);
    const subscription = actor.subscribe((snapshot) => {
      if (snapshot.value === expectedState) {
        clearTimeout(timeout);
        subscription.unsubscribe();
        resolve();
      }
    });
  });
}

describe("appLogic machine", () => {
  test("preserves the title handoff while loading an opened playlist config", async () => {
    const collection = createCollection([createMusic()]);
    const playlist = createPlaylist(collection);

    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () =>
            createBootstrapResult([collection]),
          ),
          loadPlaylistDraft: fromPromise<ConfigDraft, string>(async () =>
            createConfigDraftFromPlaylist(playlist),
          ),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");

    actor.send(payloads["playlist.open"].load(playlist.name));
    assert.equal(actor.getSnapshot().value, "configLoading");
    assert.deepEqual(actor.getSnapshot().context.titleToneHandoff, {
      layoutId: "playlist-title:Focus Session",
      tone: "solid",
    });

    await waitForState(actor, "config");

    assert.deepEqual(actor.getSnapshot().context.titleToneHandoff, {
      layoutId: "playlist-title:Focus Session",
      tone: "solid",
    });
  });

  test("keeps the target title handoff when backing out before config load completes", async () => {
    const collection = createCollection([createMusic()]);
    const playlist = createPlaylist(collection);

    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () =>
            createBootstrapResult([collection]),
          ),
          loadPlaylistDraft: fromPromise<ConfigDraft, string>(
            () => new Promise<ConfigDraft>(() => undefined),
          ),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");

    actor.send(payloads["playlist.open"].load(playlist.name));
    assert.equal(actor.getSnapshot().value, "configLoading");

    actor.send(sig.mainx.back);

    assert.equal(actor.getSnapshot().value, "ready");
    assert.deepEqual(actor.getSnapshot().context.titleToneHandoff, {
      layoutId: "playlist-title:Focus Session",
      tone: "solid",
    });
  });

  test("automatically retries loading after entering the error state", async () => {
    let loadAttempt = 0;
    const states: string[] = [];

    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () => {
            loadAttempt += 1;

            if (loadAttempt === 1) {
              throw new Error("boom");
            }

            return {
              hasPlayList: false,
              playlists: [],
              collections: [],
              configLibrary: createConfigLibrary([]),
              savePath: "C:\\Music",
            } satisfies BootstrapResult;
          }),
        },
      }),
    );

    const settled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`unexpected state sequence: ${states.join(" -> ")}`));
      }, 2000);

      actor.subscribe((snapshot) => {
        states.push(String(snapshot.value));

        if (snapshot.value === "ready") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    actor.start();
    actor.send(sig.mainx.run);
    await new Promise<void>((resolve) => {
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "error") {
          subscription.unsubscribe();
          resolve();
        }
      });
    });
    actor.send(sig.mainx.run);

    await settled;

    assert.deepEqual(states, ["idle", "loading", "error", "loading", "ready"]);
    assert.equal(loadAttempt, 2);
    assert.equal(actor.getSnapshot().context.error, null);
  });

  test("keeps playback intent out of the accepted play state until backend acceptance", async () => {
    const collection = createCollection([createMusic()]);
    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () =>
            createBootstrapResult([collection]),
          ),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");

    actor.send(payloads["playlist.play"].load("Focus Session"));
    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.playingPlaylistName, null);
    actor.send(sig.mainx.openspectrum);
    assert.equal(actor.getSnapshot().value, "ready");

    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        session: { playlist_name: "Focus Session", status: "started", track_count: 1 },
      }),
    );
    assert.equal(actor.getSnapshot().value, "play");
    assert.equal(actor.getSnapshot().context.playingPlaylistName, "Focus Session");
  });

  test("projects now playing evidence that arrives before playback is accepted", async () => {
    const music = createMusic();
    const collection = createCollection([music]);
    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () =>
            createBootstrapResult([collection]),
          ),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");

    actor.send(payloads["playlist.play"].load("Focus Session"));
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: "Focus Session",
        music_name: music.alias,
        music_url: music.url,
        canonical_music_id: music.canonical_music_id,
        file_path: "C:/Music/quiet-morning.m4a",
        start_ms: music.start_ms,
        end_ms: music.end_ms,
        liked: false,
      }),
    );

    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, "Focus Session");
    assert.equal(
      actor.getSnapshot().context.pendingNowPlayingTrackEvidence?.music_url,
      music.url,
    );
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, null);

    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        session: { playlist_name: "Focus Session", status: "started", track_count: 1 },
      }),
    );

    assert.equal(actor.getSnapshot().value, "play");
    assert.equal(actor.getSnapshot().context.playingPlaylistName, "Focus Session");
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, music.alias);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackUrl, music.url);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackFilePath, "C:/Music/quiet-morning.m4a");
    assert.equal(actor.getSnapshot().context.nowPlayingTrackStartMs, music.start_ms);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackEndMs, music.end_ms);
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, null);
    assert.equal(actor.getSnapshot().context.pendingNowPlayingTrackEvidence, null);
  });

  test("ignores early now playing evidence for a different pending playlist", async () => {
    const music = createMusic();
    const collection = createCollection([music]);
    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () =>
            createBootstrapResult([collection]),
          ),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");

    actor.send(payloads["playlist.play"].load("Focus Session"));
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: "Other Session",
        music_name: music.alias,
        music_url: music.url,
        canonical_music_id: music.canonical_music_id,
        file_path: "C:/Music/quiet-morning.m4a",
        start_ms: music.start_ms,
        end_ms: music.end_ms,
        liked: false,
      }),
    );
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        session: { playlist_name: "Focus Session", status: "started", track_count: 1 },
      }),
    );

    assert.equal(actor.getSnapshot().value, "play");
    assert.equal(actor.getSnapshot().context.playingPlaylistName, "Focus Session");
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, null);
    assert.equal(actor.getSnapshot().context.pendingNowPlayingTrackEvidence, null);
  });

  test("applies spectrum music deletion optimistically to in-memory music surfaces", async () => {
    const deletedMusic = createMusic();
    const siblingMusic = createMusic({
      name: "Track B",
      alias: "Track B",
      url: "https://example.com/quiet-morning#b",
      start_ms: 120_000,
      end_ms: 240_000,
    });
    const collection = createCollection([deletedMusic, siblingMusic]);

    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () =>
            createBootstrapResult([collection]),
          ),
          loadSpectrumMusicDrafts: fromPromise<
            SpectrumMusicDraftBootstrapResult,
            SpectrumMusicDraftBootstrapInput
          >(async () => ({
            source: null,
            drafts: [
              {
                kind: "persisted" as const,
                baselineName: deletedMusic.alias,
                baselineStartMs: deletedMusic.start_ms,
                baselineEndMs: deletedMusic.end_ms,
                name: deletedMusic.alias,
                url: deletedMusic.url,
                startMs: deletedMusic.start_ms,
                endMs: deletedMusic.end_ms,
              },
              {
                kind: "persisted" as const,
                baselineName: siblingMusic.alias,
                baselineStartMs: siblingMusic.start_ms,
                baselineEndMs: siblingMusic.end_ms,
                name: siblingMusic.alias,
                url: siblingMusic.url,
                startMs: siblingMusic.start_ms,
                endMs: siblingMusic.end_ms,
              },
            ],
          })),
          updateMusics: fromPromise<MusicUpdatesResult, MusicUpdateInput[]>(async () => ({
            results: [],
          })),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        session: { playlist_name: "Focus Session", status: "started", track_count: 1 },
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: "Focus Session",
        music_name: "Track A",
        music_url: deletedMusic.url,
        canonical_music_id: deletedMusic.canonical_music_id,
        file_path: "C:/Music/quiet-morning.m4a",
        start_ms: deletedMusic.start_ms,
        end_ms: deletedMusic.end_ms,
        liked: false,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, "spectrum");
    actor.send(spectrumMusicDeleted.load({ id: "https://example.com/quiet-morning#a|0|120000" }));
    actor.send(sig.mainx.back);

    await waitForState(actor, "play");

    const context = actor.getSnapshot().context;

    assert.deepEqual(
      context.collections[0]?.musics.map((music) => music.alias),
      ["Track B"],
    );
    assert.equal(context.nowPlayingTrackName, null);
    assert.equal(context.nowPlayingTrackUrl, null);
    assert.equal(context.nowPlayingTrackFilePath, null);
    assert.equal(context.nowPlayingTrackStartMs, null);
    assert.equal(context.nowPlayingTrackEndMs, null);
    assert.equal(context.spectrumPlaybackScopeId, null);
  });

  test("keeps the spectrum playback scope reachable until backend exit is acknowledged", async () => {
    const music = createMusic();
    const collection = createCollection([music]);

    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () =>
            createBootstrapResult([collection]),
          ),
          loadSpectrumMusicDrafts: fromPromise<
            SpectrumMusicDraftBootstrapResult,
            SpectrumMusicDraftBootstrapInput
          >(async () => ({
            source: null,
            drafts: [
              {
                kind: "persisted" as const,
                baselineName: music.alias,
                baselineStartMs: music.start_ms,
                baselineEndMs: music.end_ms,
                name: music.alias,
                url: music.url,
                startMs: music.start_ms,
                endMs: music.end_ms,
              },
            ],
          })),
          updateMusics: fromPromise<MusicUpdatesResult, MusicUpdateInput[]>(async ({ input }) => ({
            results: input.map((request) => ({
              input: request,
              music: {
                ...music,
                alias: request.alias,
                start_ms: request.startMs,
                end_ms: request.endMs,
              },
            })),
          })),
          deleteMusics: fromPromise<MusicDeletesResult, MusicDraftDelete[]>(async () => ({
            results: [],
          })),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        session: { playlist_name: "Focus Session", status: "started", track_count: 1 },
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: "Focus Session",
        music_name: music.alias,
        music_url: music.url,
        canonical_music_id: music.canonical_music_id,
        file_path: "C:/Music/quiet-morning.m4a",
        start_ms: music.start_ms,
        end_ms: music.end_ms,
        liked: false,
      }),
    );
    actor.send(spectrumPlaybackScopeChanged.load(42));
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, "spectrum");

    assert.equal(actor.getSnapshot().context.spectrumPlaybackScopeId, 42);

    actor.send(
      spectrumMusicRangeChanged.load({
        id: "https://example.com/quiet-morning#a|0|120000",
        startMs: music.start_ms,
        endMs: 90_000,
      }),
    );
    actor.send(sig.mainx.back);
    assert.equal(actor.getSnapshot().value, "play");
    assert.deepEqual(actor.getSnapshot().context.titleToneHandoff, {
      layoutId: "playlist-title:Focus Session",
      tone: "solid",
    });
    assert.equal(actor.getSnapshot().context.playingPlaylistName, "Focus Session");
    assert.equal(actor.getSnapshot().context.spectrumPlaybackScopeId, 42);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackStartMs, music.start_ms);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackEndMs, 90_000);

    actor.send(spectrumPlaybackScopeChanged.load(null));
    assert.equal(actor.getSnapshot().context.spectrumPlaybackScopeId, null);
  });

  test("returns from spectrum without saving edge-equivalent music range drafts", async () => {
    const music = createMusic();
    const collection = createCollection([music]);
    let updateCallCount = 0;

    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () =>
            createBootstrapResult([collection]),
          ),
          loadSpectrumMusicDrafts: fromPromise<
            SpectrumMusicDraftBootstrapResult,
            SpectrumMusicDraftBootstrapInput
          >(async () => ({
            source: null,
            drafts: [
              {
                kind: "persisted" as const,
                baselineName: music.alias,
                baselineStartMs: music.start_ms,
                baselineEndMs: music.end_ms,
                name: music.alias,
                url: music.url,
                startMs: music.start_ms,
                endMs: music.end_ms,
              },
            ],
          })),
          updateMusics: fromPromise<MusicUpdatesResult, MusicUpdateInput[]>(async () => {
            updateCallCount += 1;
            return { results: [] };
          }),
          deleteMusics: fromPromise<MusicDeletesResult, MusicDraftDelete[]>(async () => ({
            results: [],
          })),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        session: { playlist_name: "Focus Session", status: "started", track_count: 1 },
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: "Focus Session",
        music_name: music.alias,
        music_url: music.url,
        canonical_music_id: music.canonical_music_id,
        file_path: "C:/Music/quiet-morning.m4a",
        start_ms: music.start_ms,
        end_ms: music.end_ms,
        liked: false,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, "spectrum");

    actor.send(
      spectrumMusicRangeChanged.load({
        id: "https://example.com/quiet-morning#a|0|120000",
        startMs: null,
        endMs: null,
      }),
    );
    actor.send(sig.mainx.back);
    await waitForState(actor, "play");

    assert.equal(updateCallCount, 0);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackStartMs, music.start_ms);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackEndMs, music.end_ms);
  });

  test("returns from spectrum with a target title handoff for the playlist page", async () => {
    const music = createMusic();
    const collection = createCollection([music]);

    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () =>
            createBootstrapResult([collection]),
          ),
          loadSpectrumMusicDrafts: fromPromise<
            SpectrumMusicDraftBootstrapResult,
            SpectrumMusicDraftBootstrapInput
          >(async () => ({
            source: null,
            drafts: [
              {
                kind: "persisted" as const,
                baselineName: music.alias,
                baselineStartMs: music.start_ms,
                baselineEndMs: music.end_ms,
                name: music.alias,
                url: music.url,
                startMs: music.start_ms,
                endMs: music.end_ms,
              },
            ],
          })),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        session: { playlist_name: "Focus Session", status: "started", track_count: 1 },
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: "Focus Session",
        music_name: music.alias,
        music_url: music.url,
        canonical_music_id: music.canonical_music_id,
        file_path: "C:/Music/quiet-morning.m4a",
        start_ms: music.start_ms,
        end_ms: music.end_ms,
        liked: false,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, "spectrum");

    assert.equal(actor.getSnapshot().context.activeLayoutId, "playlist-title:Focus Session");

    actor.send(sig.mainx.back);

    assert.equal(actor.getSnapshot().value, "play");
    assert.deepEqual(actor.getSnapshot().context.titleToneHandoff, {
      layoutId: "playlist-title:Focus Session",
      tone: "solid",
    });
  });

  test("uses the edited spectrum title immediately for the return-to-play handoff", async () => {
    const music = createMusic();
    const collection = createCollection([music]);

    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () =>
            createBootstrapResult([collection]),
          ),
          loadSpectrumMusicDrafts: fromPromise<
            SpectrumMusicDraftBootstrapResult,
            SpectrumMusicDraftBootstrapInput
          >(async () => ({
            source: null,
            drafts: [
              {
                kind: "persisted" as const,
                baselineName: music.alias,
                baselineStartMs: music.start_ms,
                baselineEndMs: music.end_ms,
                name: music.alias,
                url: music.url,
                startMs: music.start_ms,
                endMs: music.end_ms,
              },
            ],
          })),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        session: { playlist_name: "Focus Session", status: "started", track_count: 1 },
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: "Focus Session",
        music_name: music.alias,
        music_url: music.url,
        canonical_music_id: music.canonical_music_id,
        file_path: "C:/Music/quiet-morning.m4a",
        start_ms: music.start_ms,
        end_ms: music.end_ms,
        liked: false,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, "spectrum");

    actor.send(
      spectrumMusicNameChanged.load({
        id: "https://example.com/quiet-morning#a|0|120000",
        name: "Track A Revised",
      }),
    );
    actor.send(sig.mainx.back);

    assert.equal(actor.getSnapshot().value, "play");
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, "Track A Revised");
    assert.equal(actor.getSnapshot().context.nowPlayingTrackStartMs, music.start_ms);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackEndMs, music.end_ms);
    assert.deepEqual(actor.getSnapshot().context.titleToneHandoff, {
      layoutId: "playlist-title:Focus Session",
      tone: "solid",
    });
    assert.equal(actor.getSnapshot().context.spectrumMusicCommitEpoch, 1);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, "Track A Revised");
  });

  test("drops an empty pending spectrum music draft from shallow spectrum context", async () => {
    const music = createMusic();
    const collection = createCollection([music]);
    let createCallCount = 0;
    let updateCallCount = 0;
    let deleteCallCount = 0;

    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () =>
            createShallowBootstrapResult([collection]),
          ),
          loadSpectrumMusicDrafts: fromPromise<
            SpectrumMusicDraftBootstrapResult,
            SpectrumMusicDraftBootstrapInput
          >(async () => ({
            drafts: [],
            source: createSpectrumMusicSourceContext(collection, music),
          })),
          updateMusics: fromPromise<MusicUpdatesResult, MusicUpdateInput[]>(async () => {
            updateCallCount += 1;
            return { results: [] };
          }),
          createMusics: fromPromise<MusicCreatesResult, MusicCreateInput[]>(async ({ input }) => {
            createCallCount += 1;
            return { results: input.map((request) => ({ input: request, music: request.music })) };
          }),
          deleteMusics: fromPromise<MusicDeletesResult, MusicDraftDelete[]>(async () => {
            deleteCallCount += 1;
            return { results: [] };
          }),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        session: { playlist_name: "Focus Session", status: "started", track_count: 1 },
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: "Focus Session",
        music_name: music.alias,
        music_url: music.url,
        canonical_music_id: music.canonical_music_id,
        file_path: "C:/Music/quiet-morning.m4a",
        start_ms: music.start_ms,
        end_ms: music.end_ms,
        liked: false,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, "spectrum");

    actor.send(spectrumMusicCreateStarted.load({ id: `new|${music.url}` }));
    const pendingDraft = actor.getSnapshot().context.spectrumMusicDrafts.at(-1);
    assert.equal(pendingDraft?.kind, "pending-create");
    if (pendingDraft?.kind !== "pending-create") {
      throw new Error("expected pending spectrum music draft");
    }
    assert.equal(pendingDraft.startMs, 0);
    assert.equal(pendingDraft.endMs, music.end_ms);
    assert.equal(pendingDraft.sourceEndMs, music.end_ms);
    actor.send(sig.mainx.back);

    await waitForState(actor, "play");

    assert.equal(createCallCount, 0);
    assert.equal(updateCallCount, 0);
    assert.equal(deleteCallCount, 0);
    assert.deepEqual(actor.getSnapshot().context.collections, []);
    assert.deepEqual(actor.getSnapshot().context.spectrumMusicDrafts, []);
  });

  test("creates named pending spectrum music from shallow spectrum source context", async () => {
    const music = createMusic();
    const collection = createCollection([music]);
    const createInputs: MusicCreateInput[][] = [];

    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () =>
            createShallowBootstrapResult([collection]),
          ),
          loadSpectrumMusicDrafts: fromPromise<
            SpectrumMusicDraftBootstrapResult,
            SpectrumMusicDraftBootstrapInput
          >(async () => ({
            drafts: [],
            source: createSpectrumMusicSourceContext(collection, music),
          })),
          updateMusics: fromPromise<MusicUpdatesResult, MusicUpdateInput[]>(async () => ({
            results: [],
          })),
          createMusics: fromPromise<MusicCreatesResult, MusicCreateInput[]>(async ({ input }) => {
            createInputs.push(input);
            return { results: input.map((request) => ({ input: request, music: request.music })) };
          }),
          deleteMusics: fromPromise<MusicDeletesResult, MusicDraftDelete[]>(async () => ({
            results: [],
          })),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        session: { playlist_name: "Focus Session", status: "started", track_count: 1 },
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: "Focus Session",
        music_name: music.alias,
        music_url: music.url,
        canonical_music_id: music.canonical_music_id,
        file_path: "C:/Music/quiet-morning.m4a",
        start_ms: music.start_ms,
        end_ms: music.end_ms,
        liked: false,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, "spectrum");

    actor.send(spectrumMusicCreateStarted.load({ id: `new|${music.url}` }));
    actor.send(
      spectrumMusicNameChanged.load({
        id: `new|${music.url}`,
        name: "Track Draft",
      }),
    );
    actor.send(sig.mainx.back);

    await waitForState(actor, "play");

    assert.equal(createInputs.length, 0);
    assert.equal(actor.getSnapshot().context.spectrumMusicCommitEpoch, 1);
    assert.deepEqual(actor.getSnapshot().context.collections, []);
  });
});
