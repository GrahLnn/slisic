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

export const ss = defineSS(ns("mainx", sst(["idle", "submitting"], ["reset"])));
export const state = allState(ss);
export const sig = allSignal(ss);
export const invoker = createActors({
  submitPlaylist: async (request: PlaylistCommitRequest): Promise<PlaylistUpsertResult> => {
    const result = await crab.upsertPlaylist(
      request.request.previousName,
      request.request.playlist,
    );

    return result.match({
      Ok: (playlist) => ({
        playlist,
        previousName: request.request.previousName,
      }),
      Err: (error) => {
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
