import {
  allSignal,
  allState,
  collect,
  createActors,
  defineSS,
  event,
  ns,
  sst,
  type InvokeEvt,
  type PayloadEvt,
  type SignalEvt,
} from "@grahlnn/fn/flow";
import { crab } from "@/src/cmd";
import type { PlaylistCommitRequest, PlaylistCommitSubmission, PlaylistUpsertResult } from "./core";
import { recordTrace } from "@/src/debug/trace";

export const ss = defineSS(ns("mainx", sst(["idle", "submitting"], ["reset"])));
export const state = allState(ss);
export const sig = allSignal(ss);
export const invoker = createActors({
  submitPlaylist: async (request: PlaylistCommitRequest): Promise<PlaylistUpsertResult> => {
    const startedAt = performance.now();
    recordTrace("config-title-playlist-commit-invoke-start", {
      previousName: request.request.previousName,
      requestPlaylistName: request.request.playlist.name,
      titleResolutionKind: request.titleResolution.kind,
      titleResolutionName: request.titleResolution.name,
    });
    const result = await crab.upsertPlaylist(
      request.request.previousName,
      request.request.playlist,
    );

    return result.match({
      Ok: (playlist) => {
        recordTrace("config-title-playlist-commit-invoke-return", {
          elapsedMs: performance.now() - startedAt,
          previousName: request.request.previousName,
          requestPlaylistName: request.request.playlist.name,
          resultPlaylistName: playlist.name,
          status: "ok",
        });
        return {
          playlist,
          previousName: request.request.previousName,
        };
      },
      Err: (error) => {
        recordTrace("config-title-playlist-commit-invoke-error", {
          elapsedMs: performance.now() - startedAt,
          error,
          previousName: request.request.previousName,
          requestPlaylistName: request.request.playlist.name,
          status: "error",
        });
        throw new Error(error);
      },
    });
  },
});
export const payloads = collect(...event<PlaylistCommitSubmission>()("playlist.commit.requested"));

export type MainStateT = Extract<keyof typeof ss.mainx.State, string>;
export type Events =
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>;
