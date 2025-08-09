import { collect, sst, ValueOf, event, EventsFrom } from "../kit";
import { resultx } from "../state";

export const ss = {
  resultx,
  mainx: sst(["idle", "loading", "view"], ["run", "unmount", "back"]),
};

export type MainStateT = keyof typeof ss.mainx.State;
export type ResultStateT = keyof typeof resultx.State;
export const payloads = collect(event<string>("some"));
export type Signals =
  | {
      [K in keyof typeof ss]: ValueOf<(typeof ss)[K]["Signal"]>;
    }[keyof typeof ss]
  | EventsFrom<typeof payloads>;
