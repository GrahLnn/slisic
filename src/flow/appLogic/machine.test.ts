import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createActor, fromPromise } from "xstate";
import type {
  Collection,
  CollectionGroupOwner,
  ConfigLibraryView,
  Group,
  Music,
  NowPlayingTrackChangedEvent,
  PlaybackSurfaceStatusChangedEvent,
  PlayList,
  PlayListListView,
  PlayPlaylistSession,
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
const playbackSurfaceStatusChanged = payloads["player.playback_surface_status.changed"];

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
    loudness: 0,
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

function createStartedPlaybackSession(
  sessionGeneration = 1,
  playlistName = "Focus Session",
): PlayPlaylistSession & { status: "started"; session_generation: number } {
  return {
    playlist_name: playlistName,
    status: "started",
    session_generation: sessionGeneration,
    track_count: 1,
    initial_track: null,
  };
}

function createStoppedPlaybackSession(
  status: Exclude<PlayPlaylistSession["status"], "started">,
  playlistName = "Focus Session",
): PlayPlaylistSession & { status: Exclude<PlayPlaylistSession["status"], "started"> } {
  return {
    playlist_name: playlistName,
    status,
    session_generation: null,
    track_count: 0,
    initial_track: null,
  };
}

function createNowPlayingTrackChangedEvent(
  music: Music,
  sessionGeneration = 1,
  playlistName = "Focus Session",
  overrides: Partial<NowPlayingTrackChangedEvent> = {},
): NowPlayingTrackChangedEvent {
  return {
    session_generation: sessionGeneration,
    playlist_name: playlistName,
    music_name: music.alias,
    music_url: music.url,
    canonical_music_id: music.canonical_music_id,
    file_path: "C:/Music/quiet-morning.m4a",
    start_ms: music.start_ms,
    end_ms: music.end_ms,
    liked: false,
    ...overrides,
  };
}

function createPlaybackSurfaceStatusChangedEvent(
  sessionGeneration = 1,
  playlistName = "Focus Session",
  overrides: Partial<PlaybackSurfaceStatusChangedEvent> = {},
): PlaybackSurfaceStatusChangedEvent {
  return {
    session_generation: sessionGeneration,
    playlist_name: playlistName,
    status: "preparing",
    ...overrides,
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
    subscribe: (listener: (snapshot: { value: unknown }) => void) => { unsubscribe: () => void };
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
  test("accepts root title collection shells as dirty draft evidence in create config", async () => {
    const shell = createCollection([]);
    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () => createBootstrapResult([])),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");

    actor.send(sig.mainx.opencreate);
    assert.equal(actor.getSnapshot().value, "config");

    actor.send(payloads["draft.collection.upserted"].load(shell));

    const { draft, draftBaseline } = actor.getSnapshot().context;
    assert.equal(draft?.collections[0]?.url, shell.url);
    assert.deepEqual(draftBaseline?.collections, []);
  });

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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.playingPlaylistName, null);
    actor.send(sig.mainx.openspectrum);
    assert.equal(actor.getSnapshot().value, "ready");

    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
      }),
    );
    assert.equal(actor.getSnapshot().value, "play");
    assert.equal(actor.getSnapshot().context.playingPlaylistName, "Focus Session");
  });

  test("rejects accepted playback evidence that does not own the pending request", async () => {
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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 2,
        session: createStartedPlaybackSession(),
      }),
    );

    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.playingPlaylistName, null);
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, "Focus Session");
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackRequest?.requestId, 1);
  });

  test("closes playback intent when the backend has no prepared first slot", async () => {
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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.stopped"].load({
        error: null,
        playlistName: "Focus Session",
        reason: "pending_first_track",
        requestId: 1,
        session: createStoppedPlaybackSession("pending_first_track"),
      }),
    );

    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, null);
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackRequest, null);
  });

  test("does not let playlist upsert revive a missing first-slot playback intent", async () => {
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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.stopped"].load({
        error: null,
        playlistName: "Focus Session",
        reason: "pending_first_track",
        requestId: 1,
        session: createStoppedPlaybackSession("pending_first_track"),
      }),
    );
    actor.send(
      payloads["playlist.upserted"].load({
        playlist: createPlaylistSurface(createPlaylist(collection)),
        previousName: null,
      }),
    );

    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, null);
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackRequest, null);
    assert.equal(actor.getSnapshot().context.playingPlaylistName, null);
  });

  test("keeps pending preview playback out of play until backend acceptance", async () => {
    const collection = createCollection([createMusic()]);
    const playlist = createPlaylist(collection);
    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () => createBootstrapResult([])),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");

    actor.send(
      payloads["playlist.preview.changed"].load({
        draft: createConfigDraftFromPlaylist(playlist),
        playlist: createPlaylistSurface(playlist),
        previousName: null,
      }),
    );
    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));

    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, "Focus Session");
    assert.deepEqual(actor.getSnapshot().context.pendingPlaylistPlaybackRequest, {
      error: null,
      phase: "starting",
      playlistName: "Focus Session",
      reason: null,
      requestId: 1,
    });

    actor.send(
      payloads["playlist.upserted"].load({
        playlist: createPlaylistSurface(playlist),
        previousName: null,
      }),
    );

    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.pendingPlaylistPreview, null);
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, "Focus Session");
    assert.equal(actor.getSnapshot().context.playingPlaylistName, null);
    assert.deepEqual(actor.getSnapshot().context.pendingPlaylistPlaybackRequest, {
      error: null,
      phase: "starting",
      playlistName: "Focus Session",
      reason: null,
      requestId: 1,
    });

    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
      }),
    );

    assert.equal(actor.getSnapshot().value, "play");
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, null);
    assert.equal(actor.getSnapshot().context.playingPlaylistName, "Focus Session");
  });

  test("does not promote pending preview into a stable edit draft baseline", async () => {
    const collection = createCollection([createMusic()]);
    const playlist = createPlaylist(collection);
    let loadDraftCallCount = 0;
    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () => createBootstrapResult([])),
          loadPlaylistDraft: fromPromise<ConfigDraft, string>(
            () =>
              new Promise<ConfigDraft>(() => {
                loadDraftCallCount += 1;
              }),
          ),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await waitForState(actor, "ready");

    actor.send(
      payloads["playlist.preview.changed"].load({
        draft: createConfigDraftFromPlaylist(playlist),
        playlist: createPlaylistSurface(playlist),
        previousName: null,
      }),
    );
    actor.send(payloads["playlist.open"].load("Focus Session"));

    assert.equal(actor.getSnapshot().value, "configLoading");
    assert.equal(loadDraftCallCount, 1);
    assert.equal(actor.getSnapshot().context.pendingPlaylistName, "Focus Session");
    assert.equal(actor.getSnapshot().context.draftBaseline, null);
    assert.equal(actor.getSnapshot().context.draft, null);
    assert.equal(actor.getSnapshot().context.pendingPlaylistPreview?.playlist.name, "Focus Session");
  });

  test("rejects accepted playback after a missing first-slot result closed its intent", async () => {
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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.stopped"].load({
        error: null,
        playlistName: "Focus Session",
        reason: "pending_first_track",
        requestId: 1,
        session: createStoppedPlaybackSession("pending_first_track"),
      }),
    );
    actor.send(
      payloads["player.now_playing_track.changed"].load(
        createNowPlayingTrackChangedEvent(music, 7),
      ),
    );
    actor.send(
      payloads["playlist.upserted"].load({
        playlist: createPlaylistSurface(createPlaylist(collection)),
        previousName: null,
      }),
    );
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(7),
      }),
    );

    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, null);
    assert.equal(actor.getSnapshot().context.playingPlaylistName, null);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, null);
  });

  test("rejects accepted initial track after a missing first-slot result closed its intent", async () => {
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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.stopped"].load({
        error: null,
        playlistName: "Focus Session",
        reason: "pending_first_track",
        requestId: 1,
        session: createStoppedPlaybackSession("pending_first_track"),
      }),
    );
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: {
          ...createStartedPlaybackSession(7),
          initial_track: {
            playlist_name: "Focus Session",
            music_name: music.alias,
            canonical_music_id: music.canonical_music_id,
            music_url: music.url,
            file_path: "C:/Music/quiet-morning.m4a",
            start_ms: music.start_ms,
            end_ms: music.end_ms,
            liked: music.liked,
            loudness: music.loudness,
          },
        },
      }),
    );

    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.playingPlaylistName, null);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, null);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackUrl, null);
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, null);
  });

  test("closes stopped playback intent when the backend supersedes it", async () => {
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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.stopped"].load({
        error: null,
        playlistName: "Focus Session",
        reason: "superseded",
        requestId: 1,
        session: createStoppedPlaybackSession("superseded"),
      }),
    );

    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, null);
    assert.deepEqual(actor.getSnapshot().context.pendingPlaylistPlaybackRequest, {
      error: null,
      phase: "failed",
      playlistName: "Focus Session",
      reason: "superseded",
      requestId: 1,
    });
  });

  test("closes preview playback intent without a failed surface when the target never stabilizes", async () => {
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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.stopped"].load({
        error: "playlist preview closed before stable playback target",
        playlistName: "Focus Session",
        reason: "unstable_target",
        requestId: 1,
        session: null,
      }),
    );

    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, null);
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackRequest, null);
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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["player.now_playing_track.changed"].load(createNowPlayingTrackChangedEvent(music)),
    );

    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, "Focus Session");
    assert.equal(actor.getSnapshot().context.pendingNowPlayingTrackEvidence?.music_url, music.url);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, null);

    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["player.now_playing_track.changed"].load(
        createNowPlayingTrackChangedEvent(music, 1, "Other Session"),
      ),
    );
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
      }),
    );

    assert.equal(actor.getSnapshot().value, "play");
    assert.equal(actor.getSnapshot().context.playingPlaylistName, "Focus Session");
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, null);
    assert.equal(actor.getSnapshot().context.pendingNowPlayingTrackEvidence, null);
  });

  test("projects preparing only from the accepted playback surface status", async () => {
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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(1),
      }),
    );
    assert.equal(actor.getSnapshot().value, "play");
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, null);
    assert.equal(actor.getSnapshot().context.playbackSurfaceStatus, null);

    actor.send(playbackSurfaceStatusChanged.load(createPlaybackSurfaceStatusChangedEvent(2)));
    assert.equal(actor.getSnapshot().context.playbackSurfaceStatus, null);

    actor.send(playbackSurfaceStatusChanged.load(createPlaybackSurfaceStatusChangedEvent(1)));
    assert.equal(actor.getSnapshot().context.playbackSurfaceStatus, "preparing");
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, null);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackUrl, null);

    actor.send(
      payloads["player.now_playing_track.changed"].load(
        createNowPlayingTrackChangedEvent(music, 1),
      ),
    );
    assert.equal(actor.getSnapshot().context.playbackSurfaceStatus, null);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, music.alias);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackUrl, music.url);
  });

  test("keeps early preparing evidence pending until backend playback acceptance", async () => {
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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(playbackSurfaceStatusChanged.load(createPlaybackSurfaceStatusChangedEvent(1)));

    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().context.pendingPlaylistPlaybackName, "Focus Session");
    assert.equal(actor.getSnapshot().context.playbackSurfaceStatus, null);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, null);
    assert.equal(
      actor.getSnapshot().context.pendingPlaybackSurfaceStatusEvidence?.status,
      "preparing",
    );

    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(1),
      }),
    );

    assert.equal(actor.getSnapshot().value, "play");
    assert.equal(actor.getSnapshot().context.playbackSurfaceStatus, "preparing");
    assert.equal(actor.getSnapshot().context.pendingPlaybackSurfaceStatusEvidence, null);
  });

  test("ignores stale now playing evidence from a superseded same-name playback session", async () => {
    const firstMusic = createMusic();
    const secondMusic = createMusic({
      name: "Track B",
      alias: "Track B",
      canonical_music_id: "source:https://example.com/quiet-morning#b:0:90000",
      url: "https://example.com/quiet-morning#b",
      path: "Disc 1/Track B.m4a",
      start_ms: 0,
      end_ms: 90_000,
    });
    const staleMusic = createMusic({
      name: "Track C",
      alias: "Track C",
      canonical_music_id: "source:https://example.com/quiet-morning#c:0:60000",
      url: "https://example.com/quiet-morning#c",
      path: "Disc 1/Track C.m4a",
      start_ms: 0,
      end_ms: 60_000,
    });
    const collection = createCollection([firstMusic, secondMusic, staleMusic]);
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

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(1),
      }),
    );
    actor.send(
      payloads["player.now_playing_track.changed"].load(
        createNowPlayingTrackChangedEvent(firstMusic, 1),
      ),
    );
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, firstMusic.alias);
    assert.equal(actor.getSnapshot().context.playingSessionGeneration, 1);

    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 2 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 2,
        session: createStartedPlaybackSession(2),
      }),
    );
    actor.send(
      payloads["player.now_playing_track.changed"].load(
        createNowPlayingTrackChangedEvent(staleMusic, 1),
      ),
    );

    assert.equal(actor.getSnapshot().context.playingSessionGeneration, 2);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, null);

    actor.send(
      payloads["player.now_playing_track.changed"].load(
        createNowPlayingTrackChangedEvent(secondMusic, 2),
      ),
    );

    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, secondMusic.alias);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackUrl, secondMusic.url);
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
    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load(
        createNowPlayingTrackChangedEvent(deletedMusic, 1, "Focus Session", {
          music_name: "Track A",
        }),
      ),
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
    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load(createNowPlayingTrackChangedEvent(music)),
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
    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load(createNowPlayingTrackChangedEvent(music)),
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
    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load(createNowPlayingTrackChangedEvent(music)),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, "spectrum");

    assert.equal(actor.getSnapshot().context.activeLayoutId, "playlist-title:Focus Session");

    actor.send(sig.mainx.back);

    assert.equal(actor.getSnapshot().value, "play");
    assert.deepEqual(actor.getSnapshot().context.lastContextResetLifecycle, {
      owner: "appLogic",
      reason: "close spectrum chart and return to playback shape",
      chart: { kind: "closed", target: "spectrum" },
      lease: { kind: "opened", target: "playlist-title:Focus Session" },
      transaction: { kind: "closed", target: "spectrum-music-commit" },
    });
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
    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load(createNowPlayingTrackChangedEvent(music)),
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

  test("does not apply accepted spectrum evidence after its commit frame closes", async () => {
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
    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load(createNowPlayingTrackChangedEvent(music)),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, "spectrum");

    actor.send(
      spectrumMusicNameChanged.load({
        id: "https://example.com/quiet-morning#a|0|120000",
        name: "Track A Draft",
      }),
    );
    actor.send(sig.mainx.back);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, "Track A Draft");
    assert.equal(actor.getSnapshot().context.spectrumMusicCommitEpoch, 1);
    assert.notEqual(actor.getSnapshot().context.spectrumMusicCommitFrame, null);

    actor.send(
      payloads["spectrum.music_updates.committed"].load({
        epoch: 1,
        result: {
          results: [
            {
              input: {
                alias: "Track A Accepted",
                url: music.url,
                targetStartMs: music.start_ms,
                targetEndMs: music.end_ms,
                startMs: 8_000,
                endMs: 112_000,
              },
              music: {
                ...music,
                alias: "Track A Accepted",
                start_ms: 8_000,
                end_ms: 112_000,
              },
            },
          ],
        },
      }),
    );
    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, "Track A Accepted");
    assert.equal(actor.getSnapshot().context.spectrumMusicCommitFrame, null);
    assert.equal(actor.getSnapshot().context.spectrumMusicCommitNegativeEvidence, null);

    actor.send(
      payloads["spectrum.music_updates.committed"].load({
        epoch: 1,
        result: {
          results: [
            {
              input: {
                alias: "Late Pollution",
                url: music.url,
                targetStartMs: music.start_ms,
                targetEndMs: music.end_ms,
                startMs: 16_000,
                endMs: 100_000,
              },
              music: {
                ...music,
                alias: "Late Pollution",
                start_ms: 16_000,
                end_ms: 100_000,
              },
            },
          ],
        },
      }),
    );

    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, "Track A Accepted");
    assert.deepEqual(actor.getSnapshot().context.spectrumMusicCommitNegativeEvidence, {
      epoch: 1,
      kind: "Stops",
      phase: "update",
      reason: "closed-frame",
    });
    assert.deepEqual(
      actor.getSnapshot().context.collections[0]?.musics.map((item) => item.alias),
      ["Track A Accepted"],
    );
  });

  test("closes the spectrum commit frame after same-epoch commit failure", async () => {
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
    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load(createNowPlayingTrackChangedEvent(music)),
    );
    actor.send(sig.mainx.openspectrum);
    await waitForState(actor, "spectrum");

    actor.send(
      spectrumMusicNameChanged.load({
        id: "https://example.com/quiet-morning#a|0|120000",
        name: "Track A Draft",
      }),
    );
    actor.send(sig.mainx.back);
    assert.notEqual(actor.getSnapshot().context.spectrumMusicCommitFrame, null);

    actor.send(
      payloads["spectrum.music_commit.failed"].load({
        epoch: 1,
        error: "update failed",
        phase: "update",
      }),
    );
    assert.equal(actor.getSnapshot().context.error, "update failed");
    assert.equal(actor.getSnapshot().context.spectrumMusicCommitFrame, null);
    assert.deepEqual(actor.getSnapshot().context.spectrumMusicCommitNegativeEvidence, {
      epoch: 1,
      kind: "Reject",
      phase: "update",
      reason: "unexpected-evidence",
    });

    actor.send(
      payloads["spectrum.music_updates.committed"].load({
        epoch: 1,
        result: {
          results: [
            {
              input: {
                alias: "Late Pollution",
                url: music.url,
                targetStartMs: music.start_ms,
                targetEndMs: music.end_ms,
                startMs: 8_000,
                endMs: 112_000,
              },
              music: {
                ...music,
                alias: "Late Pollution",
                start_ms: 8_000,
                end_ms: 112_000,
              },
            },
          ],
        },
      }),
    );

    assert.equal(actor.getSnapshot().context.nowPlayingTrackName, "Track A Draft");
    assert.deepEqual(actor.getSnapshot().context.spectrumMusicCommitNegativeEvidence, {
      epoch: 1,
      kind: "Stops",
      phase: "update",
      reason: "closed-frame",
    });
    assert.deepEqual(
      actor.getSnapshot().context.collections[0]?.musics.map((item) => item.alias),
      ["Track A Draft"],
    );
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
    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load(createNowPlayingTrackChangedEvent(music)),
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
    actor.send(payloads["playlist.play"].load({ playlistName: "Focus Session", requestId: 1 }));
    actor.send(
      payloads["playlist.playback.accepted"].load({
        playlistName: "Focus Session",
        requestId: 1,
        session: createStartedPlaybackSession(),
      }),
    );
    await waitForState(actor, "play");
    actor.send(
      payloads["player.now_playing_track.changed"].load(createNowPlayingTrackChangedEvent(music)),
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
