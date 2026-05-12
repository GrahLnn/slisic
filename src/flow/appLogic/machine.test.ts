import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createActor, fromPromise } from "xstate";
import type { Collection, Music, PlayList, PlayPlaylistSession } from "@/src/cmd";
import type { SpectrumMusicDraft } from "./core";
import { machine } from "./machine";
import {
  payloads,
  sig,
  type BootstrapResult,
  type MusicDeletesResult,
  type MusicUpdateInput,
  type MusicUpdatesResult,
  type PlayPlaylistInput,
  type SpectrumMusicDraftBootstrapInput,
} from "./events";
import type { MusicDraftDelete } from "./musicTitle";

const spectrumMusicDeleted = payloads["spectrum.music_deleted"];
const spectrumMusicRangeChanged = payloads["spectrum.music_range.changed"];
const spectrumPlaybackScopeChanged = payloads["spectrum.playback_scope.changed"];

function createMusic(overrides: Partial<Music> = {}): Music {
  return {
    name: "Track A",
    alias: "Track A",
    group: {
      name: "Quiet Morning",
      url: "https://example.com/quiet-morning#disc-1",
      folder: "Disc 1",
    },
    url: "https://example.com/quiet-morning#a",
    path: "Disc 1/Track A.m4a",
    start_ms: 0,
    end_ms: 120_000,
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
    created_at: "2026-04-13T00:00:00Z",
  };
}

describe("appLogic machine", () => {
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

  test("commits spectrum music deletion to persistent and in-memory music surfaces", async () => {
    const deletedMusic = createMusic();
    const siblingMusic = createMusic({
      name: "Track B",
      alias: "Track B",
      url: "https://example.com/quiet-morning#b",
      start_ms: 120_000,
      end_ms: 240_000,
    });
    const collection = createCollection([deletedMusic, siblingMusic]);
    const deletedInputs: MusicDraftDelete[][] = [];

    const actor = createActor(
      machine.provide({
        actors: {
          loadCollections: fromPromise<BootstrapResult>(async () => ({
            hasPlayList: true,
            playlists: [createPlaylist(collection)],
            collections: [collection],
            savePath: "C:/Music",
          })),
          playPlaylist: fromPromise<PlayPlaylistSession | null, PlayPlaylistInput>(
            async () => null,
          ),
          loadSpectrumMusicDrafts: fromPromise<
            SpectrumMusicDraft[],
            SpectrumMusicDraftBootstrapInput
          >(async () => [
            {
              baselineName: deletedMusic.alias,
              baselineStartMs: deletedMusic.start_ms,
              baselineEndMs: deletedMusic.end_ms,
              name: deletedMusic.alias,
              url: deletedMusic.url,
              startMs: deletedMusic.start_ms,
              endMs: deletedMusic.end_ms,
            },
            {
              baselineName: siblingMusic.alias,
              baselineStartMs: siblingMusic.start_ms,
              baselineEndMs: siblingMusic.end_ms,
              name: siblingMusic.alias,
              url: siblingMusic.url,
              startMs: siblingMusic.start_ms,
              endMs: siblingMusic.end_ms,
            },
          ]),
          updateMusics: fromPromise<MusicUpdatesResult, MusicUpdateInput[]>(async () => ({
            results: [],
          })),
          deleteMusics: fromPromise<MusicDeletesResult, MusicDraftDelete[]>(async ({ input }) => {
            deletedInputs.push(input);
            return { results: input };
          }),
        },
      }),
    );

    actor.start();
    actor.send(sig.mainx.run);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`unexpected state: ${String(actor.getSnapshot().value)}`));
      }, 2000);
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "ready") {
          clearTimeout(timeout);
          subscription.unsubscribe();
          resolve();
        }
      });
    });
    actor.send(payloads["playlist.play"].load("Focus Session"));
    actor.send(
      payloads["playlist.preview.changed"].load({
        playlist: createPlaylist(collection),
        previousName: null,
      }),
    );
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: "Focus Session",
        music_name: "Track A",
        music_url: deletedMusic.url,
        file_path: "C:/Music/quiet-morning.m4a",
        start_ms: deletedMusic.start_ms,
        end_ms: deletedMusic.end_ms,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`unexpected state: ${String(actor.getSnapshot().value)}`));
      }, 2000);
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "spectrum") {
          clearTimeout(timeout);
          subscription.unsubscribe();
          resolve();
        }
      });
    });
    actor.send(spectrumMusicDeleted.load({ id: "https://example.com/quiet-morning#a|0|120000" }));
    actor.send(sig.mainx.back);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`unexpected state: ${String(actor.getSnapshot().value)}`));
      }, 2000);
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "play") {
          clearTimeout(timeout);
          subscription.unsubscribe();
          resolve();
        }
      });
    });

    const context = actor.getSnapshot().context;

    assert.deepEqual(deletedInputs, [
      [
        {
          id: "https://example.com/quiet-morning#a|0|120000",
          url: "https://example.com/quiet-morning#a",
          startMs: 0,
          endMs: 120_000,
        },
      ],
    ]);
    assert.deepEqual(
      context.collections[0]?.musics.map((music) => music.alias),
      ["Track B"],
    );
    assert.deepEqual(
      context.playlists[0]?.collections[0]?.musics.map((music) => music.alias),
      ["Track B"],
    );
    assert.deepEqual(
      context.pendingPlaylistPreview?.playlist.collections[0]?.musics.map((music) => music.alias),
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
          loadCollections: fromPromise<BootstrapResult>(async () => ({
            hasPlayList: true,
            playlists: [createPlaylist(collection)],
            collections: [collection],
            savePath: "C:/Music",
          })),
          playPlaylist: fromPromise<PlayPlaylistSession | null, PlayPlaylistInput>(
            async () => null,
          ),
          loadSpectrumMusicDrafts: fromPromise<
            SpectrumMusicDraft[],
            SpectrumMusicDraftBootstrapInput
          >(async () => [
            {
              baselineName: music.alias,
              baselineStartMs: music.start_ms,
              baselineEndMs: music.end_ms,
              name: music.alias,
              url: music.url,
              startMs: music.start_ms,
              endMs: music.end_ms,
            },
          ]),
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
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`unexpected state: ${String(actor.getSnapshot().value)}`));
      }, 2000);
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "ready") {
          clearTimeout(timeout);
          subscription.unsubscribe();
          resolve();
        }
      });
    });
    actor.send(payloads["playlist.play"].load("Focus Session"));
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: "Focus Session",
        music_name: music.alias,
        music_url: music.url,
        file_path: "C:/Music/quiet-morning.m4a",
        start_ms: music.start_ms,
        end_ms: music.end_ms,
      }),
    );
    actor.send(spectrumPlaybackScopeChanged.load(42));
    actor.send(sig.mainx.openspectrum);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`unexpected state: ${String(actor.getSnapshot().value)}`));
      }, 2000);
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "spectrum") {
          clearTimeout(timeout);
          subscription.unsubscribe();
          resolve();
        }
      });
    });

    assert.equal(actor.getSnapshot().context.spectrumPlaybackScopeId, 42);

    actor.send(
      spectrumMusicRangeChanged.load({
        id: "https://example.com/quiet-morning#a|0|120000",
        startMs: music.start_ms,
        endMs: 90_000,
      }),
    );
    actor.send(sig.mainx.back);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`unexpected state: ${String(actor.getSnapshot().value)}`));
      }, 2000);
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "play") {
          clearTimeout(timeout);
          subscription.unsubscribe();
          resolve();
        }
      });
    });
    assert.equal(actor.getSnapshot().context.spectrumPlaybackScopeId, 42);

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
          loadCollections: fromPromise<BootstrapResult>(async () => ({
            hasPlayList: true,
            playlists: [createPlaylist(collection)],
            collections: [collection],
            savePath: "C:/Music",
          })),
          playPlaylist: fromPromise<PlayPlaylistSession | null, PlayPlaylistInput>(
            async () => null,
          ),
          loadSpectrumMusicDrafts: fromPromise<
            SpectrumMusicDraft[],
            SpectrumMusicDraftBootstrapInput
          >(async () => [
            {
              baselineName: music.alias,
              baselineStartMs: music.start_ms,
              baselineEndMs: music.end_ms,
              name: music.alias,
              url: music.url,
              startMs: music.start_ms,
              endMs: music.end_ms,
            },
          ]),
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
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`unexpected state: ${String(actor.getSnapshot().value)}`));
      }, 2000);
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "ready") {
          clearTimeout(timeout);
          subscription.unsubscribe();
          resolve();
        }
      });
    });
    actor.send(payloads["playlist.play"].load("Focus Session"));
    actor.send(
      payloads["player.now_playing_track.changed"].load({
        playlist_name: "Focus Session",
        music_name: music.alias,
        music_url: music.url,
        file_path: "C:/Music/quiet-morning.m4a",
        start_ms: music.start_ms,
        end_ms: music.end_ms,
      }),
    );
    actor.send(sig.mainx.openspectrum);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`unexpected state: ${String(actor.getSnapshot().value)}`));
      }, 2000);
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "spectrum") {
          clearTimeout(timeout);
          subscription.unsubscribe();
          resolve();
        }
      });
    });

    actor.send(
      spectrumMusicRangeChanged.load({
        id: "https://example.com/quiet-morning#a|0|120000",
        startMs: null,
        endMs: null,
      }),
    );
    actor.send(sig.mainx.back);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`unexpected state: ${String(actor.getSnapshot().value)}`));
      }, 2000);
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "play") {
          clearTimeout(timeout);
          subscription.unsubscribe();
          resolve();
        }
      });
    });

    assert.equal(updateCallCount, 0);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackStartMs, music.start_ms);
    assert.equal(actor.getSnapshot().context.nowPlayingTrackEndMs, music.end_ms);
  });
});
